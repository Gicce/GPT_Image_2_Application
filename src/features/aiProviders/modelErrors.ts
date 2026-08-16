export type ModelErrorCode =
  | 'missing_api_key'
  | 'authentication_failed'
  | 'permission_denied'
  | 'model_not_found'
  | 'network_error'
  | 'timeout'
  | 'rate_limited'
  | 'insufficient_balance'
  | 'plan_quota_exceeded'
  | 'provider_error'
  | 'invalid_response'
  | 'quick_check_unsupported'
  | 'not_in_catalog'
  | 'unknown';

export const MODEL_ERROR_LABELS: Record<ModelErrorCode, string> = {
  missing_api_key: '尚未配置 API Key',
  authentication_failed: 'API Key 无效或已失效',
  permission_denied: '无权限',
  model_not_found: '当前模型不可用',
  network_error: '网络连接失败',
  timeout: '连接超时',
  rate_limited: '请求过于频繁',
  insufficient_balance: '余额或资源包不可用',
  plan_quota_exceeded: 'Coding Plan 额度受限',
  provider_error: '模型服务繁忙',
  invalid_response: '响应格式不兼容',
  quick_check_unsupported: '该接口不支持快速检测',
  not_in_catalog: '尚未验证调用权限',
  unknown: '未知错误',
};

export const MODEL_ERROR_HINTS: Record<ModelErrorCode, string> = {
  missing_api_key: '请先保存 API Key 后再进行模型可用性检测。',
  authentication_failed: 'API Key 无效、过期或当前账号没有访问权限，请在设置中修改 API Key。',
  permission_denied: '当前 API Key 没有访问该模型的权限（可能需要升级套餐或开通对应分组）。',
  model_not_found: '该模型在当前 Provider / 使用方式中不可用，可能已下线或尚未对当前账号开放。请刷新模型列表后重新选择。',
  network_error: '无法连接 Provider API，请检查网络、系统代理或 Base URL。',
  timeout: '连接超时，请稍后重试。',
  rate_limited: '当前 API 限流，请稍后重试。',
  insufficient_balance: '当前 Provider 账户余额不足或无可用资源包，请前往该 Provider 的控制台充值后重试（与 CyImagePro 账户余额无关）。',
  plan_quota_exceeded: 'Coding Plan 套餐额度已达到限制（可能为 5 小时额度 / 周额度 / 公平使用限制），请稍后重试或查看套餐使用情况。套餐额度与普通 API 余额相互独立。',
  provider_error: 'Provider 服务端异常，请稍后重试。',
  invalid_response: '接口响应格式不兼容，可能不是标准 OpenAI Compatible 服务。',
  quick_check_unsupported: '该 Provider 未提供模型目录接口，可尝试深度测试。',
  not_in_catalog: '模型目录未返回该模型，但目录不一定完整；模型是否存在需通过深度测试（真实调用）确认。',
  unknown: '检测失败，可查看详情了解原始错误。',
};

/**
 * 从 error_kind / http status / error message 推断统一错误码。
 * billingMode 仅影响套餐类错误的细分：Coding Plan 连接下，Provider 返回的
 * quota / 公平使用 / 套餐额度类 429 归为 plan_quota_exceeded（与普通限流、
 * 普通余额不足区分开）；其它模式不受影响。
 */
export function classifyModelErrorCode(input: {
  errorKind?: string;
  httpStatus?: number;
  message?: string;
  billingMode?: string;
}): ModelErrorCode {
  const { errorKind, httpStatus, message } = input;
  const lower = (message || '').toLowerCase();

  if (httpStatus === 401
    || errorKind === 'auth' || errorKind === 'authentication_failed'
    || /invalid api key|unauthorized|invalid_api_key|authentication|api key/i.test(lower)) {
    return 'authentication_failed';
  }
  if (httpStatus === 403 || errorKind === 'permission_denied' || /forbidden|permission/.test(lower)) {
    return 'permission_denied';
  }
  // 「模型不存在」只能由 Provider 在真实调用中明确指出（错误码或消息）；
  // 裸 HTTP 404 也可能是 endpoint 路径错误，不能直接等同 model_not_found。
  if (errorKind === 'model_not_found'
    || /model_not_found|model not found|does not exist|no such model|unsupported model|invalid model|模型不存在|不支持的模型|无效的模型/.test(lower)) {
    return 'model_not_found';
  }
  if (httpStatus === 404) {
    // 裸 404：更可能是 endpoint 路径错误，而非模型不存在。
    return 'provider_error';
  }
  // 余额类错误必须在 429/rate_limited 之前判定：智谱把「余额不足或无可用资源包」
  // （code 1113）包在 HTTP 429 里返回，DeepSeek 用 HTTP 402 —— 只看 status 会误判为限流。
  if (httpStatus === 402
    || errorKind === 'insufficient_balance'
    || /code[:\s]*1113|余额不足|资源包|欠费|insufficient[_\s]?balance|arrears/i.test(lower)) {
    return 'insufficient_balance';
  }
  if (httpStatus === 429 || errorKind === 'rate_limit' || /rate limit|too many requests|quota/.test(lower)) {
    // Coding Plan 连接：quota / 公平使用 / 套餐额度类受限 ≠ 普通限流 ≠ 余额不足
    if (input.billingMode === 'coding_plan'
      && /quota|fair|usage|套餐|额度|公平/.test(lower)) {
      return 'plan_quota_exceeded';
    }
    return 'rate_limited';
  }
  if (errorKind === 'timeout' || /timeout|timed out/.test(lower)) return 'timeout';
  if (errorKind === 'connect' || errorKind === 'network' || /connection refused|dns|fetch failed|network/.test(lower)) {
    return 'network_error';
  }
  if (errorKind === 'invalid_response' || /invalid response|unexpected response|parse|decode/.test(lower)) {
    return 'invalid_response';
  }
  if ((httpStatus !== undefined && httpStatus >= 500) || errorKind === 'server' || errorKind === 'model_error') {
    return 'provider_error';
  }
  return 'unknown';
}

/** 兼容旧持久化数据中的错误码（modelTest.ts v1）。 */
export function normalizeLegacyErrorCode(code?: string): ModelErrorCode | undefined {
  if (!code) return undefined;
  if (code in MODEL_ERROR_LABELS) return code as ModelErrorCode;
  const legacyMap: Record<string, ModelErrorCode> = {
    invalid_api_key: 'authentication_failed',
    not_configured: 'missing_api_key',
    server_error: 'provider_error',
  };
  return legacyMap[code] || 'unknown';
}
