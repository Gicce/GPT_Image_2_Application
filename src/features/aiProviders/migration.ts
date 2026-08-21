import type { AIProviderProfile, AIProviderModel, AIProviderType, BillingMode, ProviderCategory, ProviderModeState, UseScopes } from './types';
import { defaultUseScopes } from './types';
import { resolveProviderBaseUrl, defaultBillingMode, getBillingModes, getBuiltInRegistry } from './registry/registry';
import { generateProfileId, generateModelId, officialModelRowId } from './registry/id';

export { generateProfileId, generateModelId };

export function resolveProviderTypeByBaseUrl(baseUrl: string): AIProviderType {
  const normalized = (baseUrl || '').trim().toLowerCase().replace(/\/+$/, '');
  if (normalized === 'https://api.deepseek.com/v1') return 'deepseek_official';
  if (normalized === 'https://open.bigmodel.cn/api/paas/v4'
    || normalized === 'https://open.bigmodel.cn/api/coding/paas/v4') return 'glm_official';
  if (normalized === 'https://api.openai.com/v1') return 'openai_official';
  if (normalized === 'https://generativelanguage.googleapis.com/v1beta/openai') return 'gemini_official';
  if (normalized === 'https://dashscope.aliyuncs.com/compatible-mode/v1') return 'qwen_official';
  return 'openai_compatible';
}

export function buildBuiltInModels(providerType: AIProviderType): AIProviderModel[] {
  const registry = getBuiltInRegistry(providerType);
  if (!registry) return [];
  return registry.models
    .filter(entry => entry.lifecycle !== 'retired')
    .map(entry => ({
      id: officialModelRowId(entry.model_id),
      model_id: entry.model_id,
      display_name: entry.display_name,
      model_source: 'official_registry' as const,
      enabled: true,
      supports_vision: entry.capabilities.includes('vision'),
      capabilities: entry.capabilities,
      lifecycle: entry.lifecycle,
      test_status: 'untested' as const,
    }));
}

/** 某模式从未配置过时生成的空白连接状态（Key 空、模型来自内置 Registry）。
 *  category='vision'（视觉模型服务档案）时默认模型取 Registry 首个视觉模型，
 *  避免「新增视觉模型服务 → 默认模型却是纯文本模型」。 */
export function buildEmptyModeState(providerType: AIProviderType, category: ProviderCategory = 'agent'): ProviderModeState {
  const models = buildBuiltInModels(providerType);
  const registryModels = getBuiltInRegistry(providerType)?.models || [];
  const recommended = registryModels.find(entry => entry.recommended && entry.lifecycle === 'active');
  const firstVision = models.find(m => m.capabilities.includes('vision'));
  const defaultModelId = category === 'vision'
    ? (firstVision?.model_id || recommended?.model_id || models[0]?.model_id || '')
    : (recommended?.model_id || models[0]?.model_id || '');
  return {
    api_key: '',
    models,
    default_model_id: defaultModelId,
    vision_model_id: '',
    validation_state: 'unknown',
  };
}

/** 把 profile 顶层（当前激活模式）的连接状态写回 mode_states[billing_mode] 镜像源。 */
export function syncActiveModeState(profile: AIProviderProfile): AIProviderProfile {
  const mode = profile.billing_mode;
  if (!mode || getBillingModes(profile.provider_type).length === 0) return profile;
  const state: ProviderModeState = {
    api_key: profile.api_key,
    api_key_saved_at: profile.api_key_saved_at,
    validation_state: profile.validation_state,
    last_validated_at: profile.last_validated_at,
    models: profile.models,
    last_model_sync_at: profile.last_model_sync_at,
    default_model_id: profile.default_model_id,
    vision_model_id: profile.vision_model_id,
  };
  const existing = profile.mode_states?.[mode];
  if (existing === state) return profile;
  return { ...profile, mode_states: { ...profile.mode_states, [mode]: state } };
}

/**
 * 切换使用方式（唯一实现，store action 与设置页共用）：
 *  1. 当前模式的 Key / 模型目录 / 默认模型先存回 mode_states（绝不丢弃）
 *  2. 加载目标模式已保存的状态；从未配置过则生成空白状态（内置模型）
 *  3. 顶层镜像切换 + Base URL 由 resolver 按新模式固定
 * 幂等：切换到当前模式返回原 profile。
 */
export function applyBillingModeToProfile(profile: AIProviderProfile, mode: BillingMode): AIProviderProfile {
  const modes = getBillingModes(profile.provider_type);
  if (modes.length === 0 || !modes.some(item => item.mode === mode)) return profile;
  if (profile.billing_mode === mode) return profile;

  const stashed = syncActiveModeState(profile);
  const profileCategoryValue = profile.category;
  const target: ProviderModeState = stashed.mode_states?.[mode]
    || buildEmptyModeState(profile.provider_type, profileCategoryValue ?? 'agent');

  return {
    ...stashed,
    billing_mode: mode,
    base_url: resolveProviderBaseUrl(profile.provider_type, mode),
    api_key: target.api_key,
    api_key_saved_at: target.api_key_saved_at,
    validation_state: target.validation_state || 'unknown',
    last_validated_at: target.last_validated_at,
    models: target.models,
    last_model_sync_at: target.last_model_sync_at,
    default_model_id: target.default_model_id,
    vision_model_id: target.vision_model_id,
    mode_states: { ...stashed.mode_states, [mode]: target },
    updated_at: new Date().toISOString(),
  };
}

export function createEmptyProfile(providerType: AIProviderType, name = '', category: ProviderCategory = 'agent'): AIProviderProfile {
  const now = new Date().toISOString();
  const mode = defaultBillingMode(providerType);
  const state = buildEmptyModeState(providerType, category);
  const profile: AIProviderProfile = {
    id: generateProfileId(),
    name,
    provider_type: providerType,
    category,
    base_url: resolveProviderBaseUrl(providerType, mode),
    api_key: '',
    enabled: true,
    default_model_id: state.default_model_id,
    vision_model_id: '',
    use_scopes: defaultUseScopes(),
    system_prompt: '',
    context_window: 32768,
    fallback_token: '',
    avatar_data_url: '',
    models: state.models,
    created_at: now,
    updated_at: now,
    validation_state: 'unknown',
    ...(mode ? { billing_mode: mode } : {}),
  };
  // 多模式 Provider：初始模式即默认模式；其余模式在首次切换时按需生成
  return mode ? syncActiveModeState(profile) : profile;
}

/**
 * 旧持久化数据（agent_profiles_state_v1）升级到新模型结构。
 * 兼容规则：
 *  - model_source 'built_in' → 'official_registry'
 *  - 旧 model 若不在 Registry → source 'legacy' / lifecycle 'unknown'，继续显示，禁止丢弃
 *  - 无 capabilities 的补 ['unknown']；Registry 认识的补齐 metadata
 *  - test_status / last_tested_at / default_model_id 等用户数据全部保留，默认模型绝不静默切换
 *  - billing_mode 迁移：无 billing_mode 的官方多模式 Provider 按默认模式（api）补齐；
 *    若旧 base_url 已指向其它模式的官方地址（如 Coding Plan），按地址推断模式。
 *    API Key / 模型目录 / 默认模型全部原样进入该模式的 mode_states，绝不丢失。
 */
export function upgradePersistedProfile(rawProfile: AIProviderProfile): AIProviderProfile {
  const registry = getBuiltInRegistry(rawProfile.provider_type);
  const registryById = new Map((registry?.models || []).map(entry => [entry.model_id, entry]));
  let changed = false;
  const profile = rawProfile;

  // use_scopes 迁移（幂等）：旧数据没有使用范围概念。
  // 旧 agent_type='conversation'（对话助手，不进任务链路）→ 保留用户意图，映射为 planner 关闭；
  // 其余（含旧 creative）→ 全量默认开启。此后 agent_type 不再参与任何判定。
  if (!profile.use_scopes) {
    const legacyConversation = profile.agent_type === 'conversation';
    profile.use_scopes = legacyConversation
      ? { chat: true, planner: false, prompt_optimizer: true }
      : defaultUseScopes();
    changed = true;
  }

  const models = (profile.models || []).map(raw => {
    const model = raw as AIProviderModel;
    const entry = registryById.get(model.model_id);
    const rawSource = model.model_source;
    const source: AIProviderModel['model_source'] =
      rawSource === 'custom' || rawSource === 'provider_discovery' || rawSource === 'legacy'
        ? rawSource
        : entry ? 'official_registry' : 'legacy';

    let capabilities = Array.isArray(model.capabilities) && model.capabilities.length > 0
      ? [...model.capabilities]
      : null;
    let display_name = model.display_name || model.model_id;
    let lifecycle = model.lifecycle || 'unknown';

    if (entry) {
      if (!capabilities || capabilities.includes('unknown')) capabilities = [...entry.capabilities];
      if (!model.display_name || model.display_name === model.model_id) display_name = entry.display_name;
      lifecycle = entry.lifecycle;
    } else if (source !== 'custom') {
      if (!capabilities || capabilities.includes('unknown')) {
        capabilities = model.supports_vision ? ['text', 'vision'] : ['unknown'];
      }
      lifecycle = 'unknown';
    }
    if (!capabilities || capabilities.length === 0) capabilities = ['unknown'];

    const next: AIProviderModel = {
      ...model,
      display_name,
      model_source: source,
      capabilities,
      lifecycle,
      supports_vision: capabilities.includes('vision'),
    };
    if (next.model_source !== model.model_source
      || next.capabilities !== model.capabilities
      || next.display_name !== model.display_name
      || next.lifecycle !== model.lifecycle
      || next.supports_vision !== model.supports_vision) {
      changed = true;
    }
    return next;
  });

  let upgraded: AIProviderProfile = changed || !profile.validation_state
    ? { ...profile, models, validation_state: profile.validation_state || 'unknown' }
    : { ...profile, models };

  // billing_mode 迁移（幂等）：只在缺失时推断，已有值绝不覆盖
  if (getBillingModes(upgraded.provider_type).length > 0) {
    if (!upgraded.billing_mode) {
      const inferred = getBillingModes(upgraded.provider_type).find(
        item => item.base_url === normalizeBaseUrl(upgraded.base_url),
      );
      const mode = inferred?.mode || defaultBillingMode(upgraded.provider_type)!;
      upgraded = {
        ...upgraded,
        billing_mode: mode,
        base_url: resolveProviderBaseUrl(upgraded.provider_type, mode),
      };
    }
    // 官方 Provider 的 base_url 一律以 resolver 为准（防止历史手改漂移），并回填 mode_states
    const resolvedBase = resolveProviderBaseUrl(upgraded.provider_type, upgraded.billing_mode);
    if (resolvedBase && upgraded.base_url !== resolvedBase) {
      upgraded = { ...upgraded, base_url: resolvedBase };
    }
    upgraded = syncActiveModeState(upgraded);
  }

  return upgraded;
}

/**
 * 旧单智能体配置（settings.agent_* / chat_*）迁移为一个 Profile。
 * 幂等：调用方通过 migration marker 保证只跑一次；本函数本身不做去重判断。
 */
export function migrateLegacyAgentSettings(legacy: {
  agent_name?: string;
  agent_token?: string;
  chat_token?: string;
  agent_model?: string;
  agent_base_url?: string;
  chat_base_url?: string;
  agent_system_prompt?: string;
  chat_system_prompt?: string;
  agent_context_window?: number;
  vision_model?: string;
  ai_avatar_data_url?: string;
}): AIProviderProfile | null {
  const baseUrl = (legacy.agent_base_url || legacy.chat_base_url || '').trim();
  const token = (legacy.agent_token || legacy.chat_token || '').trim();
  const model = (legacy.agent_model || '').trim();
  const systemPrompt = (legacy.agent_system_prompt || legacy.chat_system_prompt || '').trim();
  const visionModel = (legacy.vision_model || '').trim();
  const name = (legacy.agent_name || '').trim();

  // 全空配置不迁移 —— 不制造空 Profile，更不允许恢复内置 GPT Agent。
  const DEFAULT_BASE_URL = 'https://www.packyapi.com/v1';
  // 旧服务器 Agent 链路（CyImagePro 服务器下发的 token + 服务器默认地址，
  // 例如 gpt-5.6-luna 账户计费模型）不属于用户自有 Provider，禁止迁移成
  // Profile —— 否则服务器 Agent 模型会经迁移混入 BYOK 模型选择器。
  // 只有用户明确配置过自定义 Base URL（自己的 Provider）才迁移。
  if (!baseUrl || baseUrl === DEFAULT_BASE_URL) return null;
  const hasRealConfig = Boolean(token)
    || Boolean(systemPrompt)
    || (Boolean(baseUrl) && baseUrl !== DEFAULT_BASE_URL)
    || (Boolean(name) && name !== 'CyImage Agent');
  if (!hasRealConfig) return null;

  const providerType = resolveProviderTypeByBaseUrl(baseUrl);
  let profile = createEmptyProfile(providerType, name || '我的智能体');

  // 旧配置的 base_url 若指向其它使用方式（如 Coding Plan 地址），先切到对应模式
  const inferredMode = getBillingModes(providerType).find(item => item.base_url === baseUrl)?.mode;
  if (inferredMode && inferredMode !== profile.billing_mode) {
    profile = applyBillingModeToProfile(profile, inferredMode);
  }

  if (providerType === 'openai_compatible') {
    profile.base_url = baseUrl;
    if (model) {
      profile.models = [{
        id: generateModelId(),
        model_id: model,
        display_name: model,
        model_source: 'custom',
        enabled: true,
        supports_vision: false,
        capabilities: ['unknown'],
        lifecycle: 'unknown',
        test_status: 'untested',
      }];
      profile.default_model_id = model;
    }
    profile.fallback_token = (legacy.chat_token || '').trim();
    profile.context_window = legacy.agent_context_window || 32768;
  } else {
    // 官方 Provider：模型来自 Registry；旧 model 不在 Registry 时以 legacy 身份保留（不静默切换默认模型）
    if (model && !profile.models.some(m => m.model_id === model)) {
      profile.models.push({
        id: officialModelRowId(model),
        model_id: model,
        display_name: model,
        model_source: 'legacy',
        enabled: true,
        supports_vision: false,
        capabilities: ['unknown'],
        lifecycle: 'unknown',
        test_status: 'untested',
      });
      profile.default_model_id = model;
    }
    profile.api_key = token;
  }

  profile.api_key = token;
  if (token) profile.api_key_saved_at = new Date().toISOString();
  profile.system_prompt = systemPrompt;
  profile.avatar_data_url = (legacy.ai_avatar_data_url || '').trim();

  if (visionModel) {
    const visionCandidate = profile.models.find(m => m.model_id === visionModel);
    if (visionCandidate && visionCandidate.supports_vision) {
      profile.vision_model_id = visionModel;
    }
  }

  return profile;
}

/** 校验自定义 model_id：trim 后非空、长度合理、无纯空格。不过度限制字符集。 */
export function validateCustomModelId(raw: string): { ok: boolean; error?: string; value: string } {
  const value = (raw || '').trim();
  if (!value) return { ok: false, error: '模型 ID 不能为空', value };
  if (/\s/.test(value)) return { ok: false, error: '模型 ID 不能包含空格', value };
  if (value.length > 120) return { ok: false, error: '模型 ID 过长（超过 120 字符）', value };
  return { ok: true, value };
}

/** 规范化 Base URL：trim + 去尾部斜杠；不改动路径（保留 /v1）。 */
export function normalizeBaseUrl(raw: string): string {
  return (raw || '').trim().replace(/\/+$/, '');
}
