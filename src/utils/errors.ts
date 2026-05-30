function formatHttpTail(status?: number | null) {
  return status ? ` (HTTP ${status})` : '';
}

function normalizedDetail(err: any) {
  if (typeof err?.detail === 'string' && err.detail.trim()) return err.detail.trim();
  if (typeof err?.message === 'string' && err.message.trim()) return err.message.trim();
  return '';
}

function buildActionHint(status?: number | null, kind?: string) {
  if (kind === 'multimodal_unsupported') {
    return '请到“设置 > AI 智能体”运行“连接自检”，重点查看“聊天链路兼容性检测”结果。';
  }
  if (kind === 'model_error') {
    return '请检查 Agent 模型名、当前账号权限，以及代理是否支持该模型。';
  }
  if (kind === 'json_output_unsupported') {
    return '当前模型可以对话，但不稳定支持 JSON 约束输出；请更换更兼容的聊天模型。';
  }
  if (kind === 'vision_error') {
    return '请检查官方图片 Token 与图片理解模型配置。';
  }
  if (status === 400) {
    return '请检查模型名、Base URL，以及代理是否兼容 OpenAI `chat/completions`。';
  }
  if (status === 422) {
    return '请检查消息格式、图片附件格式，或代理是否支持多模态消息。';
  }
  return '';
}

function formatUpstreamMessage(err: any, fallback: string) {
  const detail = normalizedDetail(err);
  const base = detail || `${fallback}${formatHttpTail(err?.status)}`;
  const hint = buildActionHint(err?.status, err?.kind);
  if (!hint) return base;
  return `${base} ${hint}`;
}

export function explainError(err: any): string {
  if (!err) return '操作失败，请重试';

  if (err?.kind === 'connect') return err?.message || '无法连接服务，请检查网络或后端地址';
  if (err?.kind === 'timeout') return err?.message || '请求超时，请稍后重试';
  if (err?.kind === 'auth') return err?.message || '鉴权失败，请检查 Token 或权限配置';
  if (err?.kind === 'rate_limit') return err?.message || '请求过于频繁，请稍后重试';
  if (err?.kind === 'server') return err?.message || '上游服务暂时不可用，请稍后重试';
  if (err?.kind === 'vision_error') return err?.message || '官方图片理解失败，请检查图片理解模型或官方 Token 配置';
  if (err?.kind === 'upstream_api' || err?.kind === 'invalid_request' || err?.kind === 'model_error' || err?.kind === 'multimodal_unsupported' || err?.kind === 'json_output_unsupported') {
    return formatUpstreamMessage(err, '上游接口返回异常');
  }
  if (err?.kind === 'invalid_response') {
    if (typeof err?.message === 'string' && /openai_error|上游.*失败|HTTP \d+/i.test(err.message)) {
      return formatUpstreamMessage(err, '上游接口返回异常');
    }
    return err?.message || '接口返回内容无法解析，请检查模型兼容性';
  }

  if (err?.name === 'TypeError' || /Failed to fetch|NetworkError|Load failed|network/i.test(err?.message || '')) {
    return '无法连接服务，请检查网络或确认后端地址是否正确';
  }
  if (err?.name === 'AbortError') return '请求已取消';

  const status = err?.status;
  const detail = normalizedDetail(err);
  const withTail = (msg: string) => `${msg}${formatHttpTail(status)}`;

  switch (status) {
    case 400:
      return `${withTail(detail || '请求参数有误')} 请检查模型名、Base URL，以及代理是否兼容 OpenAI \`chat/completions\`。`;
    case 401:
      return withTail(detail || '登录已过期，请重新登录');
    case 402:
      return withTail(detail || '余额不足，请前往“我的账户”充值');
    case 403:
      return withTail(detail || '当前账户暂无此权限');
    case 404:
      return withTail(detail || '请求的资源不存在');
    case 422:
      return `${withTail(detail || '上游接口拒绝了当前请求')} 请检查消息格式、图片附件内容或模型兼容性。`;
    case 429:
      return withTail('请求过于频繁，请稍后再试');
    case 500:
      return withTail(detail || '服务内部错误，请稍后再试');
    case 502:
    case 503:
    case 504:
      return withTail(detail || '上游服务暂时不可用，请稍后再试');
    default:
      return detail || (typeof err === 'string' ? err : '操作失败，请重试');
  }
}

export function isAuthError(err: any): boolean {
  return err?.status === 401 || err?.kind === 'auth';
}
