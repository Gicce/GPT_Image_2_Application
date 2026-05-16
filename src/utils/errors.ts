// 把任意错误（fetch 抛的 TypeError / Error / 字符串 / 自定义 detail）翻译成中文
export function explainError(err: any): string {
  if (!err) return '操作失败，请重试';

  // 网络层失败：webview fetch / 浏览器 fetch 在网络不通、CORS、后端未启动时抛 TypeError
  if (err?.name === 'TypeError' || /Failed to fetch|NetworkError|Load failed|network/i.test(err?.message || '')) {
    return '无法连接服务器，请检查网络或确认后端地址是否正确';
  }
  if (err?.name === 'AbortError') return '请求已取消';

  const status = err?.status;
  const detail = err?.detail || err?.message;
  const tail = status ? `（HTTP ${status}）` : '';
  const withTail = (msg: string) => `${msg}${tail}`;

  switch (status) {
    case 400: return withTail(detail || '请求参数有误');
    case 401: return withTail(detail || '登录已过期，请重新登录');
    case 402: return withTail(detail || '余额不足，请前往账户充值');
    case 403: return withTail(detail || '当前账户暂无此权限');
    case 404: return withTail(detail || '请求的资源不存在');
    case 422: return withTail(detail || '提交的数据格式有误');
    case 429: return withTail('请求过于频繁，请稍后再试');
    case 500: return withTail(detail || '服务器内部错误，请稍后再试');
    case 502:
    case 503:
    case 504: {
      const base = detail || '上游服务暂时不可用，请稍后再试';
      return `${withTail(base)}\n💡 建议：在发送框下方切换其他模型，或联系客服反馈此问题。`;
    }
  }

  return detail || (typeof err === 'string' ? err : '操作失败，请重试');
}

export function isAuthError(err: any): boolean {
  return err?.status === 401;
}
