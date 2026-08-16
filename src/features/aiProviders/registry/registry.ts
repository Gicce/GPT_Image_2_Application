import glmJson from './glm.json';
import deepseekJson from './deepseek.json';
import glmLogo from '../../../assets/providers/glm.png';
import deepseekLogo from '../../../assets/providers/deepseek.svg';
import genericApiLogo from '../../../assets/providers/generic-api.svg';
import type { AIProviderType, AIProviderModel, BillingMode, BillingModeDefinition, ModelCapability, ModelLifecycle } from '../types';
import { officialModelRowId } from './id';

export interface RegistryModelEntry {
  model_id: string;
  display_name: string;
  capabilities: ModelCapability[];
  lifecycle: ModelLifecycle;
  recommended?: boolean;
}

export interface ProviderRegistry {
  schema_version: number;
  provider_type: string;
  display_name: string;
  base_url: string;
  updated_at: string;
  billing_modes?: BillingModeDefinition[];
  models: RegistryModelEntry[];
}

export const REGISTRY_SCHEMA_VERSION = 1;

/** 远程 Registry 目录地址。空字符串 = 未启用（使用内置 + 缓存 + Provider Discovery）。
 *  启用方式：指向一个返回 `{provider_type}.json` 的目录服务，例如
 *  https://registry.example.com/cyimage → 拉取 .../glm_official.json
 *  由 App Config 统一管理，禁止散落到组件。 */
export const REMOTE_MODEL_REGISTRY_BASE = '';

const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY_PREFIX = 'model_registry_cache_v1:';

const BUILT_IN: Record<'deepseek_official' | 'glm_official', ProviderRegistry> = {
  deepseek_official: deepseekJson as ProviderRegistry,
  glm_official: glmJson as ProviderRegistry,
};

export function isOfficialProvider(type: AIProviderType): boolean {
  return type === 'deepseek_official' || type === 'glm_official';
}

/**
 * Provider 品牌 Logo（本地打包资源，禁止运行时外链）。
 * 官方 Provider 使用官方公开品牌资产；第三方（openai_compatible）使用通用 API 标识。
 * 资产来源与许可记录见项目根目录 THIRD_PARTY_ASSETS.md。
 */
export const PROVIDER_LOGOS: Record<AIProviderType, string> = {
  glm_official: glmLogo,
  deepseek_official: deepseekLogo,
  openai_compatible: genericApiLogo,
};

/** 获取 Provider 官方品牌 Logo；未收录类型返回 null（调用方做首字母 fallback）。 */
export function getProviderLogo(type: AIProviderType): string | null {
  return PROVIDER_LOGOS[type] || null;
}

/**
 * Provider 官方链接（API Key 管理 / 文档）。全项目唯一来源，禁止散落到组件。
 * 仅收录官方真实地址；第三方（openai_compatible）无法得知服务商，不提供链接。
 * 打开必须经 api.openExternalUrl（https-only 校验）。
 */
export const PROVIDER_OFFICIAL_LINKS: Record<AIProviderType, { apiKey?: string; docs?: string }> = {
  // 智谱开放平台 API Key 管理页
  glm_official: {
    apiKey: 'https://open.bigmodel.cn/usercenter/apikeys',
    docs: 'https://docs.bigmodel.cn/',
  },
  // DeepSeek 开放平台 API Key 管理页
  deepseek_official: {
    apiKey: 'https://platform.deepseek.com/api_keys',
    docs: 'https://api-docs.deepseek.com/',
  },
  openai_compatible: {},
};

export function getOfficialApiKeyLink(type: AIProviderType): string | null {
  return PROVIDER_OFFICIAL_LINKS[type]?.apiKey || null;
}

export function getBuiltInRegistry(type: AIProviderType): ProviderRegistry | null {
  if (type === 'deepseek_official' || type === 'glm_official') return BUILT_IN[type];
  return null;
}

/** Provider 支持的连接使用方式（来自 registry 定义）。单模式 Provider 返回 1 项；第三方返回空。 */
export function getBillingModes(type: AIProviderType): BillingModeDefinition[] {
  return getBuiltInRegistry(type)?.billing_modes || [];
}

export function getBillingModeDefinition(type: AIProviderType, mode?: BillingMode): BillingModeDefinition | null {
  const modes = getBillingModes(type);
  if (modes.length === 0) return null;
  return modes.find(item => item.mode === mode) || modes[0];
}

/**
 * 统一 Base URL resolver —— 全项目唯一入口（设置页 / 聊天 / 模型刷新 / 检测全部经此）。
 * 官方 Provider 按 (provider_type, billing_mode) 返回固定官方地址，禁止组件内散落 URL。
 */
export function resolveProviderBaseUrl(type: AIProviderType, mode?: BillingMode): string {
  return getBillingModeDefinition(type, mode)?.base_url || getBuiltInRegistry(type)?.base_url || '';
}

/** Provider 的默认使用方式 = registry 声明的第一个 billing_mode（历史数据迁移也用它）。 */
export function defaultBillingMode(type: AIProviderType): BillingMode | undefined {
  return getBillingModes(type)[0]?.mode;
}

/** 兼容旧签名：不带 mode 时返回 registry 默认（第一个 billing_mode）的官方地址。 */
export function officialBaseUrl(type: AIProviderType): string {
  return resolveProviderBaseUrl(type);
}

export function allowCustomModels(type: AIProviderType): boolean {
  return !isOfficialProvider(type);
}

function validateRegistry(raw: unknown): ProviderRegistry | null {
  if (!raw || typeof raw !== 'object') return null;
  const reg = raw as Partial<ProviderRegistry>;
  if (reg.schema_version !== REGISTRY_SCHEMA_VERSION) return null;
  if (typeof reg.provider_type !== 'string' || !Array.isArray(reg.models)) return null;
  for (const model of reg.models) {
    if (!model || typeof model.model_id !== 'string' || !model.model_id.trim()) return null;
    if (!Array.isArray(model.capabilities)) return null;
  }
  return {
    schema_version: reg.schema_version,
    provider_type: reg.provider_type,
    display_name: typeof reg.display_name === 'string' ? reg.display_name : '',
    base_url: typeof reg.base_url === 'string' ? reg.base_url : '',
    updated_at: typeof reg.updated_at === 'string' ? reg.updated_at : '',
    // 远程 registry 不携带 billing_modes 时保持 undefined —— 使用方式元信息以内置定义为准，
    // 不允许远程数据改变官方 Provider 的固定 Base URL（连接安全属性）。
    billing_modes: Array.isArray(reg.billing_modes) && reg.billing_modes.length > 0
      ? reg.billing_modes
      : undefined,
    models: reg.models.map(model => ({
      model_id: model.model_id.trim(),
      display_name: model.display_name || model.model_id.trim(),
      capabilities: model.capabilities as ModelCapability[],
      lifecycle: (model.lifecycle || 'unknown') as ModelLifecycle,
      recommended: !!model.recommended,
    })),
  };
}

interface RegistryCache {
  fetched_at: number;
  registry: ProviderRegistry;
}

function readCache(providerType: AIProviderType): RegistryCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY_PREFIX + providerType);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RegistryCache;
    if (!parsed?.registry || typeof parsed.fetched_at !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(providerType: AIProviderType, cache: RegistryCache) {
  try {
    localStorage.setItem(CACHE_KEY_PREFIX + providerType, JSON.stringify(cache));
  } catch {
    // 存储满 / 被禁用时不阻塞
  }
}

export type RegistryOrigin = 'remote' | 'cache' | 'builtin';

export interface RegistryLoadResult {
  registry: ProviderRegistry | null;
  origin: RegistryOrigin;
}

/**
 * 远程 Registry 加载：remote（成功）→ cache（TTL 内或网络失败回退）→ builtin。
 * 网络失败绝不导致模型目录为空。
 */
export async function loadRegistry(
  providerType: AIProviderType,
  options?: { force?: boolean; fetchJson?: (url: string) => Promise<unknown> },
): Promise<RegistryLoadResult> {
  const builtIn = getBuiltInRegistry(providerType);
  if (!builtIn) return { registry: null, origin: 'builtin' };

  if (!REMOTE_MODEL_REGISTRY_BASE && !options?.fetchJson) {
    return { registry: builtIn, origin: 'builtin' };
  }

  const cache = readCache(providerType);
  const fresh = cache && Date.now() - cache.fetched_at < REGISTRY_TTL_MS;
  if (fresh && !options?.force) {
    return { registry: cache.registry, origin: 'cache' };
  }

  const fetchJson = options?.fetchJson;
  if (fetchJson) {
    try {
      const raw = await fetchJson(`${REMOTE_MODEL_REGISTRY_BASE}/${providerType}.json`);
      const validated = validateRegistry(raw);
      if (validated && validated.provider_type === providerType) {
        writeCache(providerType, { fetched_at: Date.now(), registry: validated });
        return { registry: validated, origin: 'remote' };
      }
      // schema 非法：丢弃远程结果，回退
    } catch {
      // 网络失败：回退
    }
  }

  if (cache && !options?.force) return { registry: cache.registry, origin: 'cache' };
  return { registry: builtIn, origin: 'builtin' };
}

export interface MergeCatalogInput {
  existing: AIProviderModel[];
  /** Provider /models 返回的原始 model id 列表 */
  discovered?: string[];
  registry: RegistryModelEntry[];
  now?: string;
}

export interface MergeCatalogResult {
  models: AIProviderModel[];
  added: string[];
  /** metadata（capabilities / lifecycle / display_name）被更新的 model id */
  updated: string[];
  /** Discovery 与 Registry 均不再出现的模型（未删除，仅标记） */
  missing: string[];
}

/**
 * 统一目录合并。规则：
 *  - model_id 为唯一业务键（providerId + model_id 维度由调用方保证 —— 每个 profile 独立调用）
 *  - 永不删除已有模型；消失 → lifecycle 'missing'
 *  - custom 模型的 display_name 用户优先，不被 Registry 覆盖
 *  - Registry 优先补齐 capabilities / lifecycle / display_name
 *  - Discovery 出现的未知 id → capabilities ['unknown']，标记 discovered_at
 *  - 已有 test_status / last_tested_at 等检测数据全部保留
 */
export function mergeModelCatalogs(input: MergeCatalogInput): MergeCatalogResult {
  const { existing, registry, now = new Date().toISOString() } = input;
  const discovered = new Set((input.discovered || []).map(id => id.trim()).filter(Boolean));
  const registryById = new Map(registry.map(entry => [entry.model_id, entry]));

  const result: AIProviderModel[] = [];
  const added: string[] = [];
  const updated: string[] = [];
  const missing: string[] = [];

  const byId = new Map(existing.map(model => [model.model_id, model]));

  // 1) 已有模型：合并 metadata，不删除
  for (const model of existing) {
    const entry = registryById.get(model.model_id);
    const seen = discovered.has(model.model_id);

    if (model.model_source === 'custom' || model.model_source === 'legacy') {
      // 用户数据优先：只补 lifecycle（Registry 判定更权威），不动名称与能力
      const next: AIProviderModel = { ...model };
      if (entry && model.lifecycle !== 'deprecated' && model.lifecycle !== 'retired') {
        next.lifecycle = entry.lifecycle;
      }
      if (!seen && entry && entry.lifecycle !== 'active' && entry.lifecycle !== 'unknown') {
        // custom 模型被 Registry 标记弃用：保留，仅提示
      }
      result.push(next);
      continue;
    }

    // built_in（旧数据标记）→ official_registry
    const source: AIProviderModel['model_source'] =
      model.model_source === 'provider_discovery' ? 'provider_discovery' : 'official_registry';

    let capabilities = model.capabilities?.length ? model.capabilities : null;
    let displayName = model.display_name;
    let lifecycle = model.lifecycle || 'unknown';
    let changed = false;

    if (entry) {
      if (!capabilities || capabilities.includes('unknown')) {
        capabilities = entry.capabilities;
      }
      if (!displayName || displayName === model.model_id) {
        displayName = entry.display_name;
      }
      lifecycle = entry.lifecycle;
    }
    if (!capabilities || capabilities.length === 0) {
      capabilities = ['unknown'];
    }

    const isMissing = !seen && !entry;
    if (isMissing) {
      lifecycle = 'missing';
      missing.push(model.model_id);
    }

    const supportsVision = capabilities.includes('vision');
    if (
      capabilities.join(',') !== (model.capabilities || []).join(',')
      || displayName !== model.display_name
      || lifecycle !== model.lifecycle
      || supportsVision !== model.supports_vision
      || source !== model.model_source
    ) {
      changed = true;
    }

    const next: AIProviderModel = {
      ...model,
      model_source: source,
      display_name: displayName,
      capabilities,
      lifecycle,
      supports_vision: supportsVision,
      ...(seen ? { last_seen_at: now } : {}),
    };
    if (changed) updated.push(model.model_id);
    result.push(next);
  }

  // 2) Registry 中新增（未存在于已有列表）的模型
  for (const entry of registry) {
    if (byId.has(entry.model_id)) continue;
    if (entry.lifecycle === 'retired') continue; // 已下线模型不再新加入目录
    result.push({
      id: officialModelRowId(entry.model_id),
      model_id: entry.model_id,
      display_name: entry.display_name,
      model_source: 'official_registry',
      enabled: true,
      supports_vision: entry.capabilities.includes('vision'),
      capabilities: entry.capabilities,
      lifecycle: entry.lifecycle,
      test_status: 'untested',
    });
    added.push(entry.model_id);
  }

  // 3) Discovery 发现的未知模型（Registry 不认识）：接纳，不丢弃
  for (const id of discovered) {
    if (byId.has(id) || registryById.has(id)) continue;
    result.push({
      id: officialModelRowId(id),
      model_id: id,
      display_name: id,
      model_source: 'provider_discovery',
      enabled: true,
      supports_vision: false,
      capabilities: ['unknown'],
      lifecycle: 'unknown',
      test_status: 'untested',
      discovered_at: now,
      last_seen_at: now,
    });
    added.push(id);
  }

  return { models: result, added, updated, missing };
}

/** 模型是否算「新发现」：14 天内首次进入目录 */
export function isNewlyDiscovered(model: AIProviderModel, now = Date.now()): boolean {
  if (!model.discovered_at) return false;
  const ts = Date.parse(model.discovered_at);
  if (Number.isNaN(ts)) return false;
  return now - ts < 14 * 24 * 60 * 60 * 1000;
}

export function recommendedModelId(registry: RegistryModelEntry[]): string {
  return registry.find(entry => entry.recommended && entry.lifecycle === 'active')?.model_id || '';
}

/** 能力启发式：仅用于 custom 模型的默认建议，不用于强行归类 */
export function guessCapabilities(modelId: string): ModelCapability[] {
  const id = modelId.toLowerCase();
  const caps: ModelCapability[] = ['text'];
  if (/vision|(^|[-_.])4v|(^|[-_.])vl($|[-_.])|(^|[-_.])v($|[-_.])/.test(id)) caps.push('vision');
  if (/reason(er|ing)?|r1|thinking/.test(id)) caps.push('reasoning');
  if (/image|dall|flux|sd|draw/.test(id)) caps.push('image_generation');
  if (/video|sora/.test(id)) caps.push('video_generation');
  return caps;
}
