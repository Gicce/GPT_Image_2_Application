import { api } from '../../services/api';
import type { AIProviderProfile, AIProviderModel, AIProviderType, BillingMode } from './types';
import { classifyModelErrorCode, type ModelErrorCode } from './modelErrors';
import { normalizeBaseUrl } from './migration';
import { resolveProviderBaseUrl } from './registry/registry';

export interface DiscoveryResult {
  ok: boolean;
  /** /models 成功返回的原始 model id 列表 */
  modelIds: string[];
  httpStatus?: number;
  errorCode?: ModelErrorCode;
  errorMessage?: string;
  /** true = Provider 未提供 /models（404/405/501），非错误，回退 Registry */
  unsupported?: boolean;
}

export interface QuickTestResult {
  ok: boolean;
  /** inconclusive = 快速检测无法判定（接口不支持 / 目录为空），建议深度测试 */
  inconclusive: boolean;
  latencyMs: number;
  httpStatus?: number;
  errorCode?: ModelErrorCode;
  errorMessage?: string;
}

export interface DeepTestResult {
  ok: boolean;
  latencyMs: number;
  httpStatus?: number;
  errorCode?: ModelErrorCode;
  errorMessage?: string;
  rawMessage?: string;
}

export interface ProviderAdapter {
  readonly providerType: AIProviderType;
  /** 官方 Provider 返回（按使用方式解析的）固定 Base URL；第三方返回 null（用户可编辑） */
  fixedBaseUrl(billingMode?: BillingMode): string | null;
  /** 发现模型：GET {base}/models，失败/不支持时给出结构化结果 */
  discoverModels(baseUrl: string, token: string): Promise<DiscoveryResult>;
  /** 快速检测（不产生生成请求）：目录存在性 + 鉴权 */
  quickTestModel(baseUrl: string, token: string, modelId: string): Promise<QuickTestResult>;
  /** 深度检测（发送最小生成请求，可能产生 Token 消耗） */
  deepTestModel(baseUrl: string, token: string, modelId: string): Promise<DeepTestResult>;
}

abstract class OpenAICompatibleAdapterBase implements ProviderAdapter {
  abstract readonly providerType: AIProviderType;

  fixedBaseUrl(_billingMode?: BillingMode): string | null {
    return null;
  }

  async discoverModels(baseUrl: string, token: string): Promise<DiscoveryResult> {
    const base = normalizeBaseUrl(baseUrl);
    if (!base || !token.trim()) {
      return { ok: false, modelIds: [], errorCode: 'missing_api_key' };
    }
    try {
      const result = await api.listProviderModels({ base_url: base, token });
      if (result.ok) {
        return { ok: true, modelIds: result.models || [], httpStatus: result.status };
      }
      const code = classifyModelErrorCode({
        errorKind: result.error_kind,
        httpStatus: result.status,
        message: result.error_message,
      });
      const unsupported = result.status === 404 || result.status === 405 || result.status === 501;
      return {
        ok: false,
        modelIds: [],
        httpStatus: result.status,
        errorCode: code,
        errorMessage: result.error_message,
        unsupported,
      };
    } catch (error) {
      return {
        ok: false,
        modelIds: [],
        errorCode: 'network_error',
        errorMessage: (error as Error)?.message,
      };
    }
  }

  async quickTestModel(baseUrl: string, token: string, modelId: string): Promise<QuickTestResult> {
    const started = Date.now();
    const discovery = await this.discoverModels(baseUrl, token);
    const latencyMs = Date.now() - started;
    if (!discovery.ok) {
      if (discovery.unsupported) {
        return { ok: false, inconclusive: true, latencyMs, httpStatus: discovery.httpStatus, errorCode: 'quick_check_unsupported' };
      }
      return {
        ok: false,
        inconclusive: false,
        latencyMs,
        httpStatus: discovery.httpStatus,
        errorCode: discovery.errorCode,
        errorMessage: discovery.errorMessage,
      };
    }
    // 2xx 但目录为空：无法判定 id 存在性 → inconclusive
    if (discovery.modelIds.length === 0) {
      return { ok: false, inconclusive: true, latencyMs, httpStatus: discovery.httpStatus, errorCode: 'quick_check_unsupported' };
    }
    const found = discovery.modelIds.some(id => id === modelId || id.toLowerCase() === modelId.toLowerCase());
    if (found) {
      return { ok: true, inconclusive: false, latencyMs, httpStatus: discovery.httpStatus };
    }
    // 「目录未返回该模型」≠「模型不存在」：/models 列表不保证全量（部分 Provider
    // 只返回子集、或根本不提供该接口）。快速检测无生成请求，无法证明模型不可调用，
    // 只能标记为"未验证调用权限"；是否存在必须由深度测试（真实调用）判定。
    return {
      ok: false,
      inconclusive: true,
      latencyMs,
      httpStatus: discovery.httpStatus,
      errorCode: 'not_in_catalog',
      errorMessage: 'Provider 模型目录未返回该模型（目录可能不完整），快速检测无法验证调用权限，可尝试深度测试',
    };
  }

  async deepTestModel(baseUrl: string, token: string, modelId: string): Promise<DeepTestResult> {
    const base = normalizeBaseUrl(baseUrl);
    const started = Date.now();
    if (!base || !token.trim() || !modelId) {
      return { ok: false, latencyMs: 0, errorCode: 'missing_api_key' };
    }
    try {
      const result = await api.runAgentRequest({
        mode: 'chat',
        role: 'model_test',
        feature: 'model-center-deep-test',
        base_url: base,
        token,
        model: modelId,
        system_prompt: '',
        messages: [{ role: 'user', content: 'Respond with exactly: OK' }],
      }) as { ok?: boolean; error_kind?: string; error_message?: string; status?: number };
      const latencyMs = Date.now() - started;
      if (result?.ok) return { ok: true, latencyMs, httpStatus: result.status };
      const code = classifyModelErrorCode({
        errorKind: result?.error_kind,
        httpStatus: typeof result?.status === 'number' ? result.status : undefined,
        message: result?.error_message,
      });
      return {
        ok: false,
        latencyMs,
        httpStatus: result?.status,
        errorCode: code,
        errorMessage: result?.error_message,
        rawMessage: result?.error_message,
      };
    } catch (error) {
      const err = error as { kind?: string; status?: number; message?: string };
      const latencyMs = Date.now() - started;
      const code = classifyModelErrorCode({
        errorKind: err?.kind,
        httpStatus: err?.status,
        message: err?.message,
      });
      return { ok: false, latencyMs, httpStatus: err?.status, errorCode: code, errorMessage: err?.message, rawMessage: err?.message };
    }
  }
}

class ZhipuProviderAdapter extends OpenAICompatibleAdapterBase {
  readonly providerType = 'glm_official' as const;
  fixedBaseUrl(billingMode?: BillingMode): string | null {
    return resolveProviderBaseUrl('glm_official', billingMode);
  }
}

class DeepSeekProviderAdapter extends OpenAICompatibleAdapterBase {
  readonly providerType = 'deepseek_official' as const;
  fixedBaseUrl(billingMode?: BillingMode): string | null {
    return resolveProviderBaseUrl('deepseek_official', billingMode);
  }
}

/** V4.0.6 视觉 Provider（全部 OpenAI 兼容协议：OpenAI 官方 / Gemini 官方兼容端点 / 百炼兼容模式） */
class OpenAIOfficialAdapter extends OpenAICompatibleAdapterBase {
  readonly providerType = 'openai_official' as const;
  fixedBaseUrl(): string | null {
    return resolveProviderBaseUrl('openai_official');
  }
}

class GeminiOfficialAdapter extends OpenAICompatibleAdapterBase {
  readonly providerType = 'gemini_official' as const;
  fixedBaseUrl(): string | null {
    return resolveProviderBaseUrl('gemini_official');
  }
}

class QwenOfficialAdapter extends OpenAICompatibleAdapterBase {
  readonly providerType = 'qwen_official' as const;
  fixedBaseUrl(): string | null {
    return resolveProviderBaseUrl('qwen_official');
  }
}

class OpenAICompatibleProviderAdapter extends OpenAICompatibleAdapterBase {
  readonly providerType = 'openai_compatible' as const;
}

const ADAPTERS: Record<AIProviderType, ProviderAdapter> = {
  glm_official: new ZhipuProviderAdapter(),
  deepseek_official: new DeepSeekProviderAdapter(),
  openai_official: new OpenAIOfficialAdapter(),
  gemini_official: new GeminiOfficialAdapter(),
  qwen_official: new QwenOfficialAdapter(),
  openai_compatible: new OpenAICompatibleProviderAdapter(),
};

export function getProviderAdapter(type: AIProviderType): ProviderAdapter {
  return ADAPTERS[type];
}

/**
 * Profile 实际请求地址：官方 Provider 一律按 (provider_type, billing_mode) 经
 * resolver 解析（即使 base_url 镜像漂移也不会打错官方地址）；第三方用用户自填地址。
 */
export function resolveProfileBaseUrl(
  profile: Pick<AIProviderProfile, 'provider_type' | 'base_url' | 'billing_mode'>,
): string {
  return resolveProviderBaseUrl(profile.provider_type, profile.billing_mode) || profile.base_url;
}

/** Provider 级验证：连接 + 鉴权（走 /models，不产生生成请求）。 */
export async function validateProviderConnection(
  profile: Pick<AIProviderProfile, 'provider_type' | 'base_url' | 'billing_mode' | 'api_key' | 'fallback_token'>,
): Promise<{ ok: boolean; httpStatus?: number; errorCode?: ModelErrorCode; errorMessage?: string }> {
  const adapter = getProviderAdapter(profile.provider_type);
  const token = (profile.api_key || '').trim() || (profile.fallback_token || '').trim();
  const discovery = await adapter.discoverModels(resolveProfileBaseUrl(profile), token);
  if (discovery.ok) return { ok: true, httpStatus: discovery.httpStatus };
  return {
    ok: false,
    httpStatus: discovery.httpStatus,
    errorCode: discovery.errorCode,
    errorMessage: discovery.errorMessage,
  };
}

export function profileToken(profile: Pick<AIProviderProfile, 'api_key' | 'fallback_token'>): string {
  return (profile.api_key || '').trim() || (profile.fallback_token || '').trim();
}

export type { AIProviderModel };
