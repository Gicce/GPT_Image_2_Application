import { create } from 'zustand';
import type { AIProviderProfile, AIProviderModel, AIModelSelection, BillingMode, ProviderValidationState, ModelUseScope, UseScopes } from './types';
import { defaultUseScopes } from './types';
import { allowCustomModels, resolveProviderBaseUrl } from './registry/registry';
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

export const useAIProviderStore = create<AIProviderState>((set, get) => ({
  profiles: [],
  selections: {},
  defaultProfileId: '',
  migrated: false,
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return;
    const persisted = readPersisted();
    if (persisted && persisted.migrated) {
      set({ ...persisted, profiles: persisted.profiles.map(upgradePersistedProfile), hydrated: true });
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
      migrated: true,
    };
    writePersisted(next);
    set({ ...next, hydrated: true });
  },

  persist: () => {
    const { profiles, selections, defaultProfileId, migrated } = get();
    return writePersisted({ profiles, selections, defaultProfileId, migrated });
  },

  addProfile: profile => {
    set(state => ({ profiles: [...state.profiles, profile] }));
    return get().persist();
  },

  updateProfile: (id, patch) => {
    set(state => ({
      profiles: state.profiles.map(profile =>
        profile.id === id
          ? { ...profile, ...patch, updated_at: new Date().toISOString() }
          : profile,
      ),
    }));
    return get().persist();
  },

  removeProfile: id => {
    const { profiles, defaultProfileId, selections } = get();
    const remaining = profiles.filter(profile => profile.id !== id);
    // 安全回退：优先下一个 enabled profile；没有则清空选择（绝不恢复内置 GPT Agent）
    const fallback = remaining.find(profile => profile.enabled) || null;
    const nextSelections: Record<string, AIModelSelection> = {};
    for (const [conversationId, selection] of Object.entries(selections)) {
      if (selection.profileId === id && fallback) {
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
      defaultProfileId: defaultProfileId === id ? (fallback?.id || '') : defaultProfileId,
    });
    get().persist();
  },

  setDefaultProfile: id => {
    set({ defaultProfileId: id });
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
    get().updateProfile(id, {
      api_key: apiKey.trim(),
      api_key_saved_at: new Date().toISOString(),
      validation_state: 'unknown',
    });
  },

  clearApiKey: id => {
    get().updateProfile(id, {
      api_key: '',
      api_key_saved_at: new Date().toISOString(),
      validation_state: 'unknown',
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
        const models = item.models.map(model =>
          model.id === modelRowId
            ? {
                ...model,
                ...(patch.model_id !== undefined ? { model_id: patch.model_id.trim() } : {}),
                ...(patch.display_name !== undefined ? { display_name: patch.display_name.trim() || patch.model_id?.trim() || model.model_id } : {}),
                ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
              }
            : model,
        );
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
    const resolve = (selection: AIModelSelection | undefined) => {
      if (!selection) return null;
      const profile = profiles.find(item => item.id === selection.profileId && item.enabled);
      if (!profile) return null;
      const model = profile.models.find(item => item.model_id === selection.modelId && item.enabled);
      if (!model) return null;
      return { profile, model };
    };
    return resolve(selections[conversationId || ''])
      || resolve(selections[''])
      || (() => {
        const profile = profiles.find(item => item.id === defaultProfileId && item.enabled)
          || profiles.find(item => item.enabled);
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
    const ordered = [
      ...state.profiles.filter(p => p.id === state.defaultProfileId),
      ...state.profiles.filter(p => p.id !== state.defaultProfileId),
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
    const profile = state.profiles.find(item => item.id === conversation.selected_agent_profile_id && item.enabled);
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

export { buildBuiltInModels };
