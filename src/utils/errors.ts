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
    return '请到「设置与更新 → AI 智能体」测试模型连接；也可在「诊断与工具」一键检查运行环境。';
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

  // 优先处理后端业务错误响应（有 status 且 detail 存在）
  const status = err?.status;
  const detail = normalizedDetail(err);
  const withTail = (msg: string) => `${msg}${formatHttpTail(status)}`;

  // 如果后端返回了 detail/message，直接显示，不要误判为网络错误
  if (detail && status) {
    switch (status) {
      case 400:
        return `${withTail(detail)} 请检查输入参数。`;
      case 401:
        return withTail(detail);
      case 402:
        return withTail(detail);
      case 403:
        return withTail(detail);
      case 404:
        return withTail(detail);
      case 409:
        return withTail(detail);
      case 422:
        return `${withTail(detail)} 请检查输入格式。`;
      case 429:
        return withTail(detail);
      case 500:
        return withTail(detail);
      case 502:
      case 503:
      case 504:
        return withTail(detail);
      default:
        return detail;
    }
  }

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

  // 只有在没有 status 的情况下才判断为网络错误
  if (!status && (err?.name === 'TypeError' || /Failed to fetch|NetworkError|Load failed|network/i.test(err?.message || ''))) {
    // 如果有 serverUrl 信息，显示当前服务器地址
    if (err?.serverUrl) {
      return `无法连接服务器 (${err.serverUrl})，请检查网络或确认后端地址是否正确`;
    }
    return '无法连接服务器，请检查网络或确认后端地址是否正确';
  }
  if (err?.name === 'AbortError') return '请求已取消';

  // 兜底：如果有 detail/message 直接返回
  if (detail) return detail;

  return typeof err === 'string' ? err : '操作失败，请重试';
}

export function isAuthError(err: any): boolean {
  return err?.status === 401 || err?.kind === 'auth';
}
