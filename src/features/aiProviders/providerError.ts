import type { AIProviderType, BillingMode } from './types';
import { BILLING_MODE_LABELS } from './types';
import { classifyModelErrorCode, MODEL_ERROR_HINTS, type ModelErrorCode } from './modelErrors';

/**
 * 统一 Provider 错误：所有 Provider（智谱 / DeepSeek / 第三方）的请求失败
 * 都转换成该形状后再进入 UI —— Provider 差异（错误码、HTTP status、原始消息）
 * 全部保留在此，上层禁止再显示「上游模型接口失败」这类与 Provider 无关的文案。
 * 绝不包含 API Key / Authorization 等凭据信息。
 */
export interface ProviderError {
  providerId: string;
  providerType: AIProviderType;
  /** 面向用户的 Provider 名称，如「智谱 GLM」「DeepSeek」「我的 API」 */
  providerLabel: string;
  modelId?: string;
  /** 当前连接的使用方式（官方多模式 Provider 才有）——错误解释按它区分 */
  billingMode?: BillingMode;

  code: ModelErrorCode;
  /** 面向用户的错误标题（如「普通 API 余额或资源包不可用」） */
  title: string;
  /** 处理建议（如何修复 / 是否需要切换使用方式） */
  guidance: string;
  userMessage: string;

  httpStatus?: number;
  providerCode?: string;
  providerMessage?: string;
  retryable: boolean;
}

/** 错误前缀使用的短标签（区别于设置页的长标签）。 */
const PROVIDER_FAILURE_LABELS: Record<AIProviderType, string> = {
  glm_official: '智谱 GLM',
  deepseek_official: 'DeepSeek',
  openai_official: 'OpenAI',
  gemini_official: 'Google Gemini',
  qwen_official: '阿里云百炼 / Qwen',
  openai_compatible: '第三方 API',
};

export function providerFailureLabel(providerType: AIProviderType, profileName = ''): string {
  if (providerType === 'openai_compatible' && profileName.trim()) {
    return profileName.trim();
  }
  return PROVIDER_FAILURE_LABELS[providerType];
}

/** 从 Rust 拼接的 `... [code: 1113] (HTTP 429)` 消息里提取 Provider 原始错误码。 */
export function extractProviderCode(message?: string): string | undefined {
  if (!message) return undefined;
  const match = message.match(/\[code:\s*([^\]]+)\]/i);
  return match?.[1]?.trim() || undefined;
}

export interface ProviderRunFailure {
  ok: false;
  error_kind?: string | null;
  error_message?: string | null;
  status?: number | null;
}

interface ErrorCopy {
  title: string;
  guidance: string;
  retryable: boolean;
}

const RETRYABLE_CODES = new Set<ModelErrorCode>(['rate_limited', 'plan_quota_exceeded', 'timeout', 'network_error', 'provider_error']);

/**
 * 按错误码 + Provider + 使用方式给出面向用户的标题与建议。
 * 关键规则：
 *  - 1113（HTTP 429）在「API 按量计费」下 = 普通 API 余额/资源包不可用，
 *    提示可检查使用方式是否选错；在「Coding Plan」下 = Key 不匹配或套餐额度问题。
 *  - 认证错误才提示修改 Key；quota / 限流 / 网络绝不提示 Key 错误。
 */
function errorCopy(code: ModelErrorCode, ctx: {
  providerType: AIProviderType;
  billingMode?: BillingMode;
  providerCode?: string;
}): ErrorCopy {
  const { providerType, billingMode } = ctx;
  const isGlm = providerType === 'glm_official';
  const modeLabel = billingMode ? BILLING_MODE_LABELS[billingMode] : '';

  if (code === 'insufficient_balance') {
    if (isGlm && billingMode === 'coding_plan') {
      return {
        title: 'Coding Plan 额度不可用或 Key 不匹配',
        guidance: '当前连接使用的是「Coding Plan 套餐」模式。请确认已配置 Coding Plan 对应的 API Key，且套餐额度未用尽、未过期。Coding Plan 套餐额度与普通 API 余额相互独立，无需为普通余额充值。',
        retryable: false,
      };
    }
    if (isGlm) {
      return {
        title: '普通 API 余额或资源包不可用',
        guidance: '当前连接使用的是「API 按量计费」模式，请检查智谱开放平台账户余额或资源包。如果你购买的是 GLM Coding Plan，请在「设置与更新 → AI 智能体」中将使用方式切换为 Coding Plan 套餐，并配置对应 Key（不会自动切换，需你手动确认）。',
        retryable: false,
      };
    }
    return { title: MODEL_ERROR_HINTS.insufficient_balance, guidance: '余额或资源包问题与 API Key 是否有效无关，请勿重置 Key。', retryable: false };
  }
  if (code === 'plan_quota_exceeded') {
    return {
      title: 'Coding Plan 当前额度已达到限制',
      guidance: '套餐可能存在 5 小时额度、周额度或公平使用限制，请稍后重试或前往智谱查看套餐使用情况。套餐限额与普通 API 账户余额是两回事，充值普通余额无法解除此限制。',
      retryable: true,
    };
  }
  if (code === 'authentication_failed') {
    return {
      title: 'API Key 无效或已失效',
      guidance: `请前往「设置与更新 → AI 智能体」修改当前连接的 API Key${modeLabel ? `（${modeLabel}）` : ''}后重试。`,
      retryable: false,
    };
  }
  if (code === 'model_not_found') {
    return {
      title: '当前模式下模型不可用',
      guidance: `该模型在当前 Provider${modeLabel ? ` / ${modeLabel}` : ''}中不可用，可能已下线或未对此账号开放。请刷新模型列表后重新选择。`,
      retryable: false,
    };
  }
  if (code === 'rate_limited') {
    return { title: '请求过于频繁', guidance: '当前 API 限流，请稍后重试。这与 Key 有效性和账户余额无关。', retryable: true };
  }
  if (code === 'network_error' || code === 'timeout') {
    return { title: code === 'timeout' ? '连接超时' : '网络连接失败', guidance: '无法连接 Provider API，请检查网络或系统代理。已保存的 API Key 不受影响。', retryable: true };
  }
  if (code === 'provider_error') {
    return { title: '模型服务繁忙', guidance: 'Provider 服务端异常（HTTP 5xx），请稍后重试。', retryable: true };
  }
  if (code === 'missing_api_key') {
    return { title: '尚未配置 API Key', guidance: '请先在设置中保存 API Key。', retryable: false };
  }
  return { title: MODEL_ERROR_HINTS[code] || '请求失败', guidance: '可展开查看 Provider 原始错误详情。', retryable: RETRYABLE_CODES.has(code) };
}

export function buildProviderError(input: {
  providerId: string;
  providerType: AIProviderType;
  providerName?: string;
  billingMode?: BillingMode;
  modelId?: string;
  failure: ProviderRunFailure;
}): ProviderError {
  const providerLabel = providerFailureLabel(input.providerType, input.providerName);
  const providerMessage = (input.failure.error_message || '').trim() || 'Provider 未返回具体原因';
  const httpStatus = input.failure.status ?? undefined;
  const providerCode = extractProviderCode(input.failure.error_message || undefined);
  const code = classifyModelErrorCode({
    errorKind: input.failure.error_kind || undefined,
    httpStatus,
    message: input.failure.error_message || undefined,
    billingMode: input.billingMode,
  });
  const copy = errorCopy(code, { providerType: input.providerType, billingMode: input.billingMode, providerCode });

  const contextParts = [
    input.modelId ? `模型：${input.modelId}` : '',
    input.billingMode ? `使用方式：${BILLING_MODE_LABELS[input.billingMode]}` : '',
    providerCode ? `错误码：${providerCode}${httpStatus ? ` · HTTP ${httpStatus}` : ''}` : httpStatus ? `HTTP ${httpStatus}` : '',
  ].filter(Boolean);
  const userMessage = [
    `${providerLabel} 请求失败`,
    copy.title,
    copy.guidance,
    contextParts.length > 0
      ? `当前：${providerLabel} · ${input.modelId || '未知模型'}${input.billingMode ? ` · ${BILLING_MODE_LABELS[input.billingMode]}` : ''}`
      : '',
    `Provider 原始消息：${providerMessage}`,
  ].join('\n');

  return {
    providerId: input.providerId,
    providerType: input.providerType,
    providerLabel,
    modelId: input.modelId,
    ...(input.billingMode ? { billingMode: input.billingMode } : {}),
    code,
    title: copy.title,
    guidance: copy.guidance,
    userMessage,
    httpStatus,
    providerCode,
    providerMessage,
    retryable: copy.retryable,
  };
}

/** 兼容现有 message 卡片单行渲染的紧凑版本（保留 Provider 前缀与关键提示）。 */
export function providerErrorCompact(error: ProviderError): string {
  const modelSuffix = error.modelId ? `（模型：${error.modelId}）` : '';
  const modeSuffix = error.billingMode ? ` · ${BILLING_MODE_LABELS[error.billingMode]}` : '';
  return `${error.providerLabel} 请求失败${modelSuffix}${modeSuffix}：${error.title}。${error.guidance}`;
}
