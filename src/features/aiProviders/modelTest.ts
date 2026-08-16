/**
 * 模型检测（兼容入口）。
 * - 快速检测（默认，不产生生成请求）：ProviderAdapter.quickTestModel → GET /models
 * - 深度检测（发送最小生成请求，可能产生少量 Token 消耗）：ProviderAdapter.deepTestModel
 * 错误分类统一走 modelErrors.classifyModelErrorCode。
 */
import type { AIProviderProfile, AIProviderModel } from './types';
import { getProviderAdapter, profileToken, resolveProfileBaseUrl } from './adapters';
import { normalizeBaseUrl } from './migration';
import { classifyModelErrorCode, MODEL_ERROR_LABELS } from './modelErrors';
import type { ModelErrorCode } from './modelErrors';

export type { ModelErrorCode };
export { classifyModelErrorCode as classifyModelError, MODEL_ERROR_LABELS };

export interface ModelTestOutcome {
  ok: boolean;
  latencyMs: number;
  errorCode?: ModelErrorCode;
  errorMessage?: string;
  httpStatus?: number;
  /** 快速检测无法判定（接口不支持 / 目录为空） */
  inconclusive?: boolean;
}

/** 快速检测：连接 + 鉴权 + 目录 + 模型 id 存在性，不发送生成请求。 */
export async function quickTestModelAvailability(
  profile: Pick<AIProviderProfile, 'provider_type' | 'base_url' | 'billing_mode' | 'api_key' | 'fallback_token'>,
  model: Pick<AIProviderModel, 'model_id'>,
): Promise<ModelTestOutcome> {
  const token = profileToken(profile);
  const baseUrl = resolveProfileBaseUrl(profile);
  if (!normalizeBaseUrl(baseUrl) || !token || !model.model_id) {
    return { ok: false, latencyMs: 0, errorCode: 'missing_api_key' };
  }
  const adapter = getProviderAdapter(profile.provider_type);
  const result = await adapter.quickTestModel(baseUrl, token, model.model_id);
  return {
    ok: result.ok,
    latencyMs: result.latencyMs,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    httpStatus: result.httpStatus,
    inconclusive: result.inconclusive,
  };
}

/** 深度检测：真实最小生成请求，可能产生 Token 消耗（须用户确认后调用）。 */
export async function deepTestModelAvailability(
  profile: Pick<AIProviderProfile, 'provider_type' | 'base_url' | 'billing_mode' | 'api_key' | 'fallback_token'>,
  model: Pick<AIProviderModel, 'model_id'>,
): Promise<ModelTestOutcome> {
  const token = profileToken(profile);
  const baseUrl = resolveProfileBaseUrl(profile);
  if (!normalizeBaseUrl(baseUrl) || !token || !model.model_id) {
    return { ok: false, latencyMs: 0, errorCode: 'missing_api_key' };
  }
  const adapter = getProviderAdapter(profile.provider_type);
  const result = await adapter.deepTestModel(baseUrl, token, model.model_id);
  return {
    ok: result.ok,
    latencyMs: result.latencyMs,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage
      ? `${MODEL_ERROR_LABELS[result.errorCode || 'unknown']}（${result.errorMessage}）`
      : undefined,
    httpStatus: result.httpStatus,
  };
}

/** 兼容旧入口：等价于深度检测（历史上模型测试即最小生成请求）。 */
export const testModelAvailability = deepTestModelAvailability;
