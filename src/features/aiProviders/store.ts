import { create } from 'zustand';
import type { AIProviderProfile, AIProviderModel, AIModelSelection, BillingMode, ProviderValidationState, ModelUseScope, ProviderCategory, UseScopes } from './types';
import { defaultUseScopes, profileCategory } from './types';
import { allowCustomModels, resolveProviderBaseUrl, getBuiltInRegistry, mergeModelCatalogs, type RegistryModelEntry } from './registry/registry';
import {
  migrateLegacyAgentSettings,
  upgradePersistedProfile,
  applyBillingModeToProfile,
  syncActiveModeState,
  generateModelId,
  buildBuiltInModels,
  validateCustomModelId,
} from './migration';
import { useSettingsStore } from '../../store/useSettingsStore';
import { invalidateModelTestStatus, isModelAvailableForVision } from './modelUsability';

export interface ModelSyncSummary {
  added: string[];
  updated: string[];
  missing: string[];
  discoveredCount: number;
}

interface AIProviderState {
  profiles: AIProviderProfile[];
  /** 当前聊天会话级选择（conversationId -> selection）；'' 为全局兜底 */
  selections: Record<string, AIModelSelection>;
  defaultProfileId: string;
  /** V4.0.6 视觉模型默认档案（category='vision' 的档案独立默认，与 Agent 默认互不干扰） */
  defaultVisionProfileId: string;
  /** migration marker：旧 agent_* 配置只迁移一次 */
  migrated: boolean;
  hydrated: boolean;

  hydrate: () => void;
  /** 返回 false 表示 localStorage 写入失败（调用方应提示用户保存失败）。 */
  persist: () => boolean;

  addProfile: (profile: AIProviderProfile) => boolean;
  updateProfile: (id: string, patch: Partial<AIProviderProfile>) => boolean;
  removeProfile: (id: string) => void;
  setDefaultProfile: (id: string) => void;
  setEnabled: (id: string, enabled: boolean) => void;
  /**
   * 切换使用方式（如 智谱 API ↔ Coding Plan）：
   * 当前模式的 Key / 模型目录 / 默认模型先存回 mode_states，再加载目标模式已保存状态。
   * 绝不删除任何 credential；模型缓存按模式隔离（缓存 key = profile_id + billing_mode）。
   */
  setBillingMode: (id: string, mode: BillingMode) => void;

  /** API Key 显式保存（记录 saved_at，不触发验证） */
  saveApiKey: (id: string, apiKey: string) => void;
  clearApiKey: (id: string) => void;
  setValidationState: (id: string, state: ProviderValidationState) => void;
  /** 模型目录同步结果落库（合并后的 models + 摘要时间戳） */
  applyModelSync: (id: string, models: AIProviderModel[], syncedAt: string) => void;

  addCustomModel: (profileId: string, input: { model_id: string; display_name: string; capabilities?: string[] }) => AIProviderModel;
  updateCustomModel: (profileId: string, modelRowId: string, patch: { model_id?: string; display_name?: string; enabled?: boolean }) => void;
  removeCustomModel: (profileId: string, modelRowId: string) => void;
  setModelTesting: (profileId: string, modelRowId: string) => void;
  setModelTestResult: (profileId: string, modelRowId: string, result: {
    test_status: 'available' | 'failed';
    last_latency_ms?: number;
    last_error_code?: string;
    last_error_message?: string;
    last_error_status?: number;
  }) => void;

  setSelection: (conversationId: string, selection: AIModelSelection | null) => void;
  getSelection: (conversationId?: string) => { profile: AIProviderProfile; model: AIProviderModel } | null;

  resolveActiveProfile: (conversationId?: string) => { profile: AIProviderProfile; model: AIProviderModel } | null;

  /** 设置 Profile / 模型级使用范围（即时持久化） */
  setProfileUseScopes: (profileId: string, scopes: UseScopes) => void;
  setModelUseScopes: (profileId: string, modelRowId: string, scopes: UseScopes) => void;
  /** 按功能用途解析可用模型（chat / planner / prompt_optimizer） */
  resolveForUse: (use: ModelUseScope, conversationId?: string) => { profile: AIProviderProfile; model: AIProviderModel } | null;
}

const SETTINGS_KEY = 'agent_profiles_state_v1';

type PersistShape = {
  profiles: AIProviderProfile[];
  selections: Record<string, AIModelSelection>;
  defaultProfileId: string;
  defaultVisionProfileId?: string;
  migrated: boolean;
};

function readPersisted(): PersistShape | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistShape;
    if (!Array.isArray(parsed.profiles)) return null;
    return {
      profiles: parsed.profiles,
      selections: parsed.selections && typeof parsed.selections === 'object' ? parsed.selections : {},
      defaultProfileId: parsed.defaultProfileId || '',
      defaultVisionProfileId: parsed.defaultVisionProfileId || '',
      migrated: !!parsed.migrated,
    };
  } catch {
    return null;
  }
}

function writePersisted(state: PersistShape): boolean {
  try {
    // 单一收口：所有 profile 变更持久化前，把顶层（当前激活模式）状态回写
    // mode_states[billing_mode] —— 保证任何 mutation 路径都不漏同步镜像。
    const profiles = state.profiles.map(syncActiveModeState);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...state, profiles }));
    return true;
  } catch {
    // localStorage 满或被禁用时不阻塞运行，但必须让调用方知道写入失败
    return false;
  }
}

/**
 * 启动时把内置 Registry 幂等合并进已落库目录（官方 Provider）。
 * 解决「registry 升级新增模型后，老用户目录仍是旧列表，需手动刷新」的问题。
 * 规则与手动同步一致：新增 Registry 模型、刷新已知模型 metadata；
 * 绝不删除模型、绝不改默认模型、custom 模型不受影响。
 * 注意：此处没有 Discovery 结果，merge 误标的 missing（动态发现模型）一律恢复原状态。
 */
function mergeBuiltinRegistryIntoModels(models: AIProviderModel[], registry: RegistryModelEntry[]): AIProviderModel[] {
  if (models.length === 0) return models;
  const prevById = new Map(models.map(m => [m.model_id, m]));
  const { models: merged } = mergeModelCatalogs({ existing: models, registry });
  return merged.map(next => {
    const prev = prevById.get(next.model_id);
    if (prev && next.lifecycle === 'missing' && prev.lifecycle !== 'missing') {
      return { ...next, lifecycle: prev.lifecycle };
    }
    return next;
  });
}

function mergeBuiltinRegistryIntoProfile(profile: AIProviderProfile): AIProviderProfile {
  const registry = getBuiltInRegistry(profile.provider_type)?.models;
  if (!registry || registry.length === 0) return profile;
  const models = mergeBuiltinRegistryIntoModels(profile.models, registry);
  let changed = models !== profile.models;
  let modeStates = profile.mode_states;
  if (profile.mode_states) {
    const next: typeof profile.mode_states = {};
    for (const [mode, state] of Object.entries(profile.mode_states)) {
      if (!state?.models) continue;
      const stateModels = mergeBuiltinRegistryIntoModels(state.models, registry);
      if (stateModels !== state.models) {
        changed = true;
        next[mode as BillingMode] = { ...state, models: stateModels };
      } else {
        next[mode as BillingMode] = state;
      }
    }
    if (changed) modeStates = next;
  }
  if (!changed) return profile;
  return { ...profile, models, ...(modeStates !== profile.mode_states ? { mode_states: modeStates } : {}) };
}

export const useAIProviderStore = create<AIProviderState>((set, get) => ({
  profiles: [],
  selections: {},
  defaultProfileId: '',
  defaultVisionProfileId: '',
  migrated: false,
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return;
    const persisted = readPersisted();
    if (persisted && persisted.migrated) {
      const profiles = persisted.profiles
        .map(upgradePersistedProfile)
        .map(mergeBuiltinRegistryIntoProfile);
      set({
        ...persisted,
        defaultVisionProfileId: persisted.defaultVisionProfileId || '',
        profiles,
        hydrated: true,
      });
      // registry 合并结果回写 localStorage，避免每次启动重复计算
      writePersisted({
        profiles,
        selections: persisted.selections,
        defaultProfileId: persisted.defaultProfileId,
        defaultVisionProfileId: persisted.defaultVisionProfileId || '',
        migrated: persisted.migrated,
      });
      return;
    }

    // 首次启动：迁移旧单智能体配置（幂等由 migrated marker 保证）
    const legacy = useSettingsStore.getState().settings;
    const migratedProfile = migrateLegacyAgentSettings(legacy);
    const profiles = migratedProfile ? [migratedProfile] : [];
    const next: PersistShape = {
      profiles,
      selections: {},
      defaultProfileId: migratedProfile?.id || '',
      defaultVisionProfileId: '',
      migrated: true,
    };
    writePersisted(next);
    set({ ...next, hydrated: true });
  },

  persist: () => {
    const { profiles, selections, defaultProfileId, defaultVisionProfileId, migrated } = get();
    return writePersisted({ profiles, selections, defaultProfileId, defaultVisionProfileId, migrated });
  },

  addProfile: profile => {
    set(state => ({ profiles: [...state.profiles, profile] }));
    return get().persist();
  },

  updateProfile: (id, patch) => {
    // 连接相关配置变更（Base URL / Provider 类型）→ 全目录测试状态失效（V4.0.7）
    const connectionChanged = patch.base_url !== undefined || patch.provider_type !== undefined;
    set(state => ({
      profiles: state.profiles.map(profile => {
        if (profile.id !== id) return profile;
        const models = connectionChanged
          ? invalidateModelTestStatus(patch.models ?? profile.models)
          : patch.models ?? profile.models;
        return { ...profile, ...patch, models, updated_at: new Date().toISOString() };
      }),
    }));
    return get().persist();
  },

  removeProfile: id => {
    const { profiles, defaultProfileId, defaultVisionProfileId, selections } = get();
    const removed = profiles.find(profile => profile.id === id);
    const remaining = profiles.filter(profile => profile.id !== id);
    // 安全回退：只在同类别档案内挑选（视觉档案删除绝不影响 Agent 默认，反之亦然）
    const removedCategory = removed ? profileCategory(removed) : 'agent';
    const sameCategory = remaining.filter(profile => profileCategory(profile) === removedCategory);
    const fallback = sameCategory.find(profile => profile.enabled) || null;
    const nextSelections: Record<string, AIModelSelection> = {};
    for (const [conversationId, selection] of Object.entries(selections)) {
      if (selection.profileId === id && fallback && profileCategory(fallback) === 'agent') {
        nextSelections[conversationId] = { profileId: fallback.id, modelId: fallback.default_model_id };
      } else if (selection.profileId === id) {
        // 无 fallback：丢弃该会话选择，进入"未配置 AI 智能体"状态
      } else {
        nextSelections[conversationId] = selection;
      }
    }
    set({
      profiles: remaining,
      selections: nextSelections,
      defaultProfileId: defaultProfileId === id ? (removedCategory === 'agent' ? (fallback?.id || '') : defaultProfileId) : defaultProfileId,
      defaultVisionProfileId: defaultVisionProfileId === id ? (removedCategory === 'vision' ? (fallback?.id || '') : defaultVisionProfileId) : defaultVisionProfileId,
    });
    get().persist();
  },

  /** 类别感知的默认设置：按目标档案自身 category 写入对应默认位。 */
  setDefaultProfile: id => {
    const profile = get().profiles.find(item => item.id === id);
    if (!profile) return;
    if (profileCategory(profile) === 'vision') {
      set({ defaultVisionProfileId: id });
    } else {
      set({ defaultProfileId: id });
    }
    get().persist();
  },

  setEnabled: (id, enabled) => {
    get().updateProfile(id, { enabled });
  },

  setBillingMode: (id, mode) => {
    const profile = get().profiles.find(item => item.id === id);
    if (!profile || profile.billing_mode === mode) return;
    const next = applyBillingModeToProfile(profile, mode);
    // 引用该 Profile 的会话选择若指向新模式目录中不存在的模型，
    // 显式切到新模式默认模型 —— 禁止偷偷沿用旧模式的模型。
    const modelIds = new Set(next.models.map(model => model.model_id));
    const selections = { ...get().selections };
    for (const [conversationId, selection] of Object.entries(selections)) {
      if (selection.profileId === id && !modelIds.has(selection.modelId)) {
        if (next.default_model_id) {
          selections[conversationId] = { profileId: id, modelId: next.default_model_id };
        } else {
          delete selections[conversationId];
        }
      }
    }
    set(state => ({
      profiles: state.profiles.map(item => (item.id === id ? next : item)),
      selections,
    }));
    get().persist();
  },

  saveApiKey: (id, apiKey) => {
    const profile = get().profiles.find(item => item.id === id);
    get().updateProfile(id, {
      api_key: apiKey.trim(),
      api_key_saved_at: new Date().toISOString(),
      validation_state: 'unknown',
      // Key 变更后旧的「测试通过」不可信 → 全目录待测试（重新测试成功前不进业务页面）
      ...(profile ? { models: invalidateModelTestStatus(profile.models) } : {}),
    });
  },

  clearApiKey: id => {
    const profile = get().profiles.find(item => item.id === id);
    get().updateProfile(id, {
      api_key: '',
      api_key_saved_at: new Date().toISOString(),
      validation_state: 'unknown',
      ...(profile ? { models: invalidateModelTestStatus(profile.models) } : {}),
    });
  },

  setValidationState: (id, state) => {
    get().updateProfile(id, {
      validation_state: state,
      ...(state === 'valid' || state === 'invalid' ? { last_validated_at: new Date().toISOString() } : {}),
    });
  },

  applyModelSync: (id, models, syncedAt) => {
    set(state => ({
      profiles: state.profiles.map(profile => {
        if (profile.id !== id) return profile;
        // 消失的模型只标记 missing，不删除 —— default/vision 引用保持不变，禁止静默替换用户选择
        return {
          ...profile,
          models,
          last_model_sync_at: syncedAt,
          updated_at: new Date().toISOString(),
        };
      }),
    }));
    get().persist();
  },

  addCustomModel: (profileId, input) => {
    const profile = get().profiles.find(item => item.id === profileId);
    if (!profile) throw new Error('智能体不存在');
    if (!allowCustomModels(profile.provider_type)) {
      throw new Error('官方 Provider 模型来自官方目录与自动发现，不允许新增自定义模型');
    }
    const validated = validateCustomModelId(input.model_id);
    if (!validated.ok) throw new Error(validated.error!);
    if (profile.models.some(model => model.model_id === validated.value)) {
      throw new Error(`模型 ${validated.value} 已存在`);
    }
    const model: AIProviderModel = {
      id: generateModelId(),
      model_id: validated.value,
      display_name: input.display_name.trim() || validated.value,
      model_source: 'custom',
      enabled: true,
      supports_vision: (input.capabilities || []).includes('vision'),
      capabilities: (input.capabilities && input.capabilities.length > 0 ? input.capabilities : ['unknown']) as AIProviderModel['capabilities'],
      lifecycle: 'unknown',
      test_status: 'untested',
    };
    set(state => ({
      profiles: state.profiles.map(item =>
        item.id === profileId
          ? {
              ...item,
              models: [...item.models, model],
              default_model_id: item.default_model_id || model.model_id,
              updated_at: new Date().toISOString(),
            }
          : item,
      ),
    }));
    get().persist();
    return model;
  },

  updateCustomModel: (profileId, modelRowId, patch) => {
    const profile = get().profiles.find(item => item.id === profileId);
    if (!profile) throw new Error('智能体不存在');
    const target = profile.models.find(model => model.id === modelRowId);
    if (!target) throw new Error('模型不存在');
    if (target.model_source !== 'custom') {
      throw new Error('仅用户自定义模型允许修改');
    }
    if (patch.model_id !== undefined) {
      const validated = validateCustomModelId(patch.model_id);
      if (!validated.ok) throw new Error(validated.error!);
      if (profile.models.some(model => model.id !== modelRowId && model.model_id === validated.value)) {
        throw new Error(`模型 ${validated.value} 已存在`);
      }
    }
    set(state => ({
      profiles: state.profiles.map(item => {
        if (item.id !== profileId) return item;
        const models = item.models.map(model => {
          if (model.id !== modelRowId) return model;
          const next = {
            ...model,
            ...(patch.model_id !== undefined ? { model_id: patch.model_id.trim() } : {}),
            ...(patch.display_name !== undefined ? { display_name: patch.display_name.trim() || patch.model_id?.trim() || model.model_id } : {}),
            ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          };
          // Model ID 变更 = 连接目标变化 → 该模型测试状态失效
          return patch.model_id !== undefined ? invalidateModelTestStatus([next])[0] : next;
        });
        const renamedTarget = models.find(model => model.id === modelRowId);
        return {
          ...item,
          models,
          default_model_id: item.default_model_id === target.model_id && renamedTarget
            ? renamedTarget.model_id
            : item.default_model_id,
          vision_model_id: item.vision_model_id === target.model_id && renamedTarget
            ? renamedTarget.model_id
            : item.vision_model_id,
          updated_at: new Date().toISOString(),
        };
      }),
    }));
    get().persist();
  },

  removeCustomModel: (profileId, modelRowId) => {
    const profile = get().profiles.find(item => item.id === profileId);
    if (!profile) throw new Error('智能体不存在');
    const target = profile.models.find(model => model.id === modelRowId);
    if (!target) throw new Error('模型不存在');
    if (target.model_source !== 'custom') {
      throw new Error('仅用户自定义模型允许删除');
    }
    const remaining = profile.models.filter(model => model.id !== modelRowId);
    set(state => ({
      profiles: state.profiles.map(item => {
        if (item.id !== profileId) return item;
        const wasDefault = item.default_model_id === target.model_id;
        const wasVision = item.vision_model_id === target.model_id;
        return {
          ...item,
          models: remaining,
          default_model_id: wasDefault ? (remaining[0]?.model_id || '') : item.default_model_id,
          vision_model_id: wasVision ? '' : item.vision_model_id,
          updated_at: new Date().toISOString(),
        };
      }),
    }));
    // 同步修正引用了该模型的会话选择
    const { selections } = get();
    const nextSelections = { ...selections };
    for (const [conversationId, selection] of Object.entries(nextSelections)) {
      if (selection.profileId === profileId && selection.modelId === target.model_id) {
        const nextModel = remaining[0];
        if (nextModel) nextSelections[conversationId] = { profileId, modelId: nextModel.model_id };
        else delete nextSelections[conversationId];
      }
    }
    set({ selections: nextSelections });
    get().persist();
  },

  setModelTesting: (profileId, modelRowId) => {
    set(state => ({
      profiles: state.profiles.map(item =>
        item.id === profileId
          ? {
              ...item,
              models: item.models.map(model =>
                model.id === modelRowId ? { ...model, test_status: 'testing' } : model,
              ),
            }
          : item,
      ),
    }));
  },

  setModelTestResult: (profileId, modelRowId, result) => {
    set(state => ({
      profiles: state.profiles.map(item =>
        item.id === profileId
          ? {
              ...item,
              models: item.models.map(model =>
                model.id === modelRowId
                  ? {
                      ...model,
                      test_status: result.test_status,
                      last_tested_at: new Date().toISOString(),
                      last_latency_ms: result.last_latency_ms,
                      last_error_code: result.last_error_code,
                      last_error_message: result.last_error_message,
                      last_error_status: result.last_error_status,
                    }
                  : model,
              ),
            }
          : item,
      ),
    }));
    get().persist();
  },

  setSelection: (conversationId, selection) => {
    set(state => {
      const next = { ...state.selections };
      if (selection) next[conversationId] = selection;
      else delete next[conversationId];
      return { selections: next };
    });
    get().persist();
  },

  getSelection: (conversationId) => {
    const { selections, profiles, defaultProfileId } = get();
    // Agent 链路只认 agent 类别档案 —— 视觉档案（category='vision'）绝不混入对话解析
    const agentProfiles = profiles.filter(item => profileCategory(item) === 'agent');
    const resolve = (selection: AIModelSelection | undefined) => {
      if (!selection) return null;
      const profile = agentProfiles.find(item => item.id === selection.profileId && item.enabled);
      if (!profile) return null;
      const model = profile.models.find(item => item.model_id === selection.modelId && item.enabled);
      if (!model) return null;
      return { profile, model };
    };
    return resolve(selections[conversationId || ''])
      || resolve(selections[''])
      || (() => {
        const profile = agentProfiles.find(item => item.id === defaultProfileId && item.enabled)
          || agentProfiles.find(item => item.enabled);
        if (!profile) return null;
        const model = profile.models.find(item => item.model_id === profile.default_model_id && item.enabled)
          || profile.models.find(item => item.enabled);
        return model ? { profile, model } : null;
      })();
  },

  resolveActiveProfile: (conversationId) => get().getSelection(conversationId),

  setProfileUseScopes: (profileId, scopes) => {
    get().updateProfile(profileId, { use_scopes: scopes });
  },

  setModelUseScopes: (profileId, modelRowId, scopes) => {
    set(state => ({
      profiles: state.profiles.map(item =>
        item.id === profileId
          ? {
              ...item,
              models: item.models.map(model => (model.id === modelRowId ? { ...model, use_scopes: scopes } : model)),
              updated_at: new Date().toISOString(),
            }
          : item,
      ),
    }));
    get().persist();
  },

  /**
   * 按功能用途解析可用模型（全项目唯一入口）：
   *  1. chat：优先会话级选择（scope 允许时）
   *  2. 任何 profile 显式配置的该用途默认模型（默认 Profile 优先）
   *  3. chat 兜底全局选择；最后任意可用模型
   * 判定条件：profile.enabled + profile.use_scopes[use] + model.enabled + model.use_scopes[use]
   * + lifecycle 非 retired。任何一层不满足即跳过 —— 禁止绕过使用范围。
   * V4.0.5 能力守卫：三个 scope 全是文本会话用途，显式声明为纯图片/视频生成
   * （含 image_generation/image_edit/video_generation 且不含 text）的模型一律排除，
   * 防止 image-only 模型被拿去做 prompt 优化/规划而在上游吃 400。
   * capabilities=['unknown']（旧数据/未声明）不拦截。
   */
  resolveForUse: (use, conversationId) => {
    const state = get();
    const supportsTextUse = (model: AIProviderModel) => {
      const caps = model.capabilities ?? [];
      if (caps.length === 0 || caps.includes('unknown')) return true;
      const generationOnly =
        caps.includes('image_generation') || caps.includes('image_edit') || caps.includes('video_generation');
      return !(generationOnly && !caps.includes('text'));
    };
    const profileAllows = (profile: AIProviderProfile) =>
      profile.enabled && (profile.use_scopes ?? defaultUseScopes())[use];
    const modelAllows = (model: AIProviderModel) =>
      model.enabled && model.lifecycle !== 'retired' && (model.use_scopes ?? defaultUseScopes())[use] && supportsTextUse(model);

    // 1. 会话级选择（含 scope 校验；不满足则继续向下，不回退服务器模型）
    if (use === 'chat') {
      const conversation = conversationId ? { id: conversationId } : undefined;
      const selection = resolveConversationAgent(conversation);
      if (selection && profileAllows(selection.profile) && modelAllows(selection.model)) {
        return selection;
      }
    }

    // 2. 显式按用途配置的默认模型（默认 Profile 优先；引用的模型必须在当前目录中存在且允许）
    const perUseField: Record<ModelUseScope, (p: AIProviderProfile) => string> = {
      chat: p => p.default_model_id,
      planner: p => p.planner_model_id || p.default_model_id,
      prompt_optimizer: p => p.prompt_optimizer_model_id || p.default_model_id,
    };
    // 三个 scope 全是文本用途：视觉类别档案（category='vision'）不参与 agent 解析
    const candidateProfiles = state.profiles.filter(p => profileCategory(p) === 'agent');
    const ordered = [
      ...candidateProfiles.filter(p => p.id === state.defaultProfileId),
      ...candidateProfiles.filter(p => p.id !== state.defaultProfileId),
    ];
    for (const profile of ordered) {
      if (!profileAllows(profile)) continue;
      const targetId = perUseField[use](profile);
      const model = profile.models.find(item => item.model_id === targetId && modelAllows(item));
      if (model) return { profile, model };
    }

    // 3. 任意可用（scope 允许的）模型
    for (const profile of ordered) {
      if (!profileAllows(profile)) continue;
      const model = profile.models.find(item => modelAllows(item));
      if (model) return { profile, model };
    }
    return null;
  },
}));

/**
 * 统一会话级解析：conversation.selected_agent_* 字段优先（随会话持久化），
 * 其次 aiProviderStore.selections（localStorage），最后 default profile。
 */
export function resolveConversationAgent(
  conversation?: { id?: string; selected_agent_profile_id?: string; selected_agent_model_id?: string } | null,
): { profile: AIProviderProfile; model: AIProviderModel } | null {
  const state = useAIProviderStore.getState();
  if (conversation?.selected_agent_profile_id) {
    const profile = state.profiles.find(
      item => item.id === conversation.selected_agent_profile_id
        && item.enabled
        && profileCategory(item) === 'agent',
    );
    if (profile) {
      const model = profile.models.find(item => item.model_id === conversation.selected_agent_model_id && item.enabled)
        || profile.models.find(item => item.enabled);
      if (model) return { profile, model };
    }
    // Profile 已删除/停用 -> 落到默认逻辑，绝不恢复内置 GPT Agent
  }
  return state.getSelection(conversation?.id || '');
}

export const NO_AGENT_MODEL_ERROR = '尚未配置 AI 对话模型。请前往「设置与更新 → AI 智能体」添加并启用一个模型服务。';

export const NO_MODEL_FOR_USE_ERRORS: Record<ModelUseScope, string> = {
  chat: '尚未配置 AI 对话模型。请前往「设置与更新 → AI 智能体」添加并启用一个模型服务。',
  planner: '尚未配置可用于任务规划的 AI 模型。请前往「设置与更新 → AI 智能体」启用模型服务的「任务规划」使用范围。',
  prompt_optimizer: '尚未配置可用于提示词优化的 AI 模型。请前往「设置与更新 → AI 智能体」启用模型服务的「提示词优化」使用范围。',
};

export type ByokAgentConfig =
  | {
      ok: true;
      token: string;
      model: string;
      baseUrl: string;
      systemPrompt: string;
      profileId: string;
      profileName: string;
      providerType: AIProviderProfile['provider_type'];
      /** 当前连接的使用方式（官方多模式 Provider 才有）；随调用链透传到 Rust 与错误归因。 */
      billingMode?: BillingMode;
      modelEntity: AIProviderModel;
    }
  | {
      ok: false;
      reason: 'no_selection' | 'missing_key';
      error: string;
    };

function buildByokConfig(selection: { profile: AIProviderProfile; model: AIProviderModel }): ByokAgentConfig {
  const token = (selection.profile.api_key || '').trim() || (selection.profile.fallback_token || '').trim();
  if (!token) {
    return {
      ok: false,
      reason: 'missing_key',
      error: `模型服务「${selection.profile.name}」尚未配置 API Key，请前往「设置与更新 → AI 智能体」保存后再使用。`,
    };
  }
  const resolvedBase = resolveProviderBaseUrl(selection.profile.provider_type, selection.profile.billing_mode);
  return {
    ok: true,
    token,
    model: selection.model.model_id,
    baseUrl: resolvedBase || selection.profile.base_url,
    systemPrompt: selection.profile.system_prompt,
    profileId: selection.profile.id,
    profileName: selection.profile.name,
    providerType: selection.profile.provider_type,
    ...(selection.profile.billing_mode ? { billingMode: selection.profile.billing_mode } : {}),
    modelEntity: selection.model,
  };
}

/**
 * BYOK 唯一来源解析：Agent 对话只允许使用用户已保存并启用的 Provider 模型。
 * 没有可用选择时返回结构化错误 —— 禁止回退到任何服务器 Agent 模型。
 * Base URL 读取时经 resolver 按当前 billing_mode 解析 —— 即使某条路径漏更新
 * profile.base_url，请求也绝不会打错官方地址。
 */
export function resolveByokAgentConfig(
  conversation?: { id?: string; selected_agent_profile_id?: string; selected_agent_model_id?: string } | null,
): ByokAgentConfig {
  const selection = resolveConversationAgent(conversation);
  if (!selection) {
    return { ok: false, reason: 'no_selection', error: NO_AGENT_MODEL_ERROR };
  }
  return buildByokConfig(selection);
}

/**
 * 按功能用途解析 BYOK 配置（planner / prompt_optimizer 等入口统一使用）。
 * 与 chat 解析共享同一 token / Base URL / 错误体系 —— 不存在第二套聊天实现。
 */
export function resolveByokConfigForUse(
  use: ModelUseScope,
  conversation?: { id?: string; selected_agent_profile_id?: string; selected_agent_model_id?: string } | null,
): ByokAgentConfig {
  // chat（或未指定用途）走会话级选择优先；planner / prompt_optimizer 走按用途解析
  const selection = use === 'chat'
    ? resolveConversationAgent(conversation)
    : useAIProviderStore.getState().resolveForUse(use, conversation?.id);
  if (!selection) {
    return { ok: false, reason: 'no_selection', error: NO_MODEL_FOR_USE_ERRORS[use] };
  }
  return buildByokConfig(selection);
}

/** Profile 聊天配置 → 旧 SendSettings 形状（useChatStore 最小改动接入）。 */
export function profileToSendSettings(profile: AIProviderProfile, model: AIProviderModel, visionModelIdFallback = '') {
  return {
    chat_token: '',
    token: '',
    chat_model: model.model_id,
    chat_base_url: profile.base_url,
    chat_system_prompt: '',
    agent_token: profile.api_key || profile.fallback_token,
    agent_model: model.model_id,
    agent_base_url: profile.base_url,
    agent_system_prompt: profile.system_prompt,
    agent_context_window: profile.context_window,
    vision_model: profile.vision_model_id || visionModelIdFallback,
  };
}

// ======================= V4.0.6 视觉模型解析 =======================

/**
 * 视觉能力守卫：capabilities 已明确声明但不含 vision → 拦截（纯文本模型绝不当视觉模型用）；
 * unknown / 未声明（旧数据、Discovery 新 id）→ 放行（与 supportsTextUse 同一容错语义）。
 * 禁止按模型名字符串猜测能力。
 */
export function allowsVisionUse(model: AIProviderModel): boolean {
  const caps = model.capabilities ?? [];
  if (caps.length === 0 || caps.includes('unknown')) return true;
  return caps.includes('vision');
}

export const NO_VISION_MODEL_ERROR =
  '尚未配置视觉模型，请先前往「设置与更新 → 视觉模型」配置。';

export const VISION_CAPABILITY_MISMATCH_ERROR =
  '当前模型不支持图片输入（能力守卫拦截）。请在「设置与更新 → 视觉模型」启用带「视觉理解」能力的模型。';

export const VISION_MODEL_NOT_TESTED_ERROR =
  '所选视觉模型尚未通过测试或测试结果已失效，请前往「设置与更新 → 视觉模型」重新测试，通过后即可使用。';

export type ByokVisionConfig =
  | {
      ok: true;
      token: string;
      model: string;
      baseUrl: string;
      profileId: string;
      profileName: string;
      modelEntity: AIProviderModel;
    }
  | {
      ok: false;
      reason: 'no_selection' | 'missing_key' | 'capability_mismatch' | 'model_not_tested';
      error: string;
    };

/**
 * 默认视觉模型解析（视觉理解工作流唯一入口）：
 * 1. 页面临时切换（preferred.profileId/modelId，须为 vision 类别 + 能力允许）
 * 2. defaultVisionProfileId 指向的档案默认模型
 * 3. 任意启用的 vision 档案中首个能力允许的模型
 * 绝不复用 defaultAgentModel，也绝不静默换 provider。
 */
export function resolveByokVisionConfig(
  preferred?: { profileId?: string; modelId?: string },
): ByokVisionConfig {
  const state = useAIProviderStore.getState();
  const visionProfiles = state.profiles.filter(p => profileCategory(p) === 'vision' && p.enabled);

  const buildError = (reason: 'no_selection' | 'missing_key' | 'capability_mismatch' | 'model_not_tested', error: string) =>
    ({ ok: false as const, reason, error });

  if (preferred?.profileId) {
    const profile = visionProfiles.find(p => p.id === preferred.profileId);
    if (profile) {
      const model = preferred.modelId
        ? profile.models.find(m => m.model_id === preferred.modelId && m.enabled)
        : undefined;
      if (model) {
        if (!(model.capabilities ?? []).includes('vision')) {
          return buildError('capability_mismatch', VISION_CAPABILITY_MISMATCH_ERROR);
        }
        // 模型中心测试状态是唯一准入依据：未测试/测试失败（含限流暂时异常）不放行
        if (!isModelAvailableForVision(profile, model)) {
          return buildError('model_not_tested', VISION_MODEL_NOT_TESTED_ERROR);
        }
        const token = (profile.api_key || '').trim() || (profile.fallback_token || '').trim();
        if (!token) {
          return buildError('missing_key', `视觉模型服务「${profile.name}」尚未配置 API Key，请前往「设置与更新 → 视觉模型」保存后再使用。`);
        }
        return {
          ok: true,
          token,
          model: model.model_id,
          baseUrl: resolveProviderBaseUrl(profile.provider_type, profile.billing_mode) || profile.base_url,
          profileId: profile.id,
          profileName: profile.name,
          modelEntity: model,
        };
      }
    }
    // 首选失效（档案删除/停用/模型不存在）→ 继续默认解析，不静默换 provider 由默认链路兜底
  }

  const def = visionProfiles.find(p => p.id === state.defaultVisionProfileId) || visionProfiles[0];
  if (!def) {
    return buildError('no_selection', NO_VISION_MODEL_ERROR);
  }
  const usable = def.models.filter(m => isModelAvailableForVision(def, m));
  const model = usable.find(m => m.model_id === def.default_model_id) || usable[0];
  if (!model) {
    const visionCapable = def.models.filter(
      m => m.enabled && m.lifecycle !== 'retired' && m.lifecycle !== 'missing' && (m.capabilities ?? []).includes('vision'),
    );
    if (visionCapable.length > 0) {
      return buildError('model_not_tested', `视觉模型服务「${def.name}」中的视觉模型均未通过测试（或测试已失效），请前往「设置与更新 → 视觉模型」执行模型测试。`);
    }
    return buildError('capability_mismatch', `视觉模型服务「${def.name}」中没有带「视觉理解」能力的启用模型，请同步模型目录或更换模型。`);
  }
  const token = (def.api_key || '').trim() || (def.fallback_token || '').trim();
  if (!token) {
    return buildError('missing_key', `视觉模型服务「${def.name}」尚未配置 API Key，请前往「设置与更新 → 视觉模型」保存后再使用。`);
  }
  return {
    ok: true,
    token,
    model: model.model_id,
    baseUrl: resolveProviderBaseUrl(def.provider_type, def.billing_mode) || def.base_url,
    profileId: def.id,
    profileName: def.name,
    modelEntity: model,
  };
}

/** 默认视觉模型展示信息（页面顶部「视觉模型：xxx」）。 */
export function resolveDefaultVisionModel(): { profile: AIProviderProfile; model: AIProviderModel } | null {
  const config = resolveByokVisionConfig();
  if (!config.ok) return null;
  const profile = useAIProviderStore.getState().profiles.find(p => p.id === config.profileId);
  if (!profile) return null;
  return { profile, model: config.modelEntity };
}

export { buildBuiltInModels };
