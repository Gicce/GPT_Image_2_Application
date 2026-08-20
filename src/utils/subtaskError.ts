/**
 * 子任务错误分类（V4.0.5）—— 展示层唯一入口。
 *
 * 后端错误文案是稳定的格式常量（task_runner.rs format_send_error /
 * format_upstream_image_error），这里按前缀解析出结构化分类，
 * 供主 UI 简洁展示 + [查看详情] 展开技术信息。分类同时决定语义：
 * 网络瞬时类可自动/手动重试恢复；能力/路由类重试前应先修配置。
 */

export type SubTaskErrorKind =
  | 'network_connect'
  | 'network_timeout'
  | 'network_other'
  | 'upstream_capability'
  | 'upstream_4xx'
  | 'upstream_5xx'
  | 'runtime_token_missing'
  | 'local_file'
  | 'unknown';

export interface ClassifiedSubTaskError {
  kind: SubTaskErrorKind;
  /** 主 UI 简洁标题 */
  title: string;
  /** 一行行动建议 */
  hint: string;
}

const NETWORK_CONNECT_PREFIX = '图片服务连接失败（connect）';
const NETWORK_TIMEOUT_PREFIX = '图片服务连接失败（timeout）';
const NETWORK_PREFIX = '图片服务连接失败';
const UPSTREAM_PREFIX = '上游图片接口失败';

export function classifySubTaskError(message?: string | null): ClassifiedSubTaskError {
  const text = (message ?? '').trim();
  if (!text) {
    return { kind: 'unknown', title: '生成失败', hint: '未知错误，请查看技术详情。' };
  }

  if (text.startsWith(NETWORK_CONNECT_PREFIX)) {
    return {
      kind: 'network_connect',
      title: '连接图片服务失败',
      hint: '请检查网络或代理设置（设置 → 一键检查运行环境可诊断），然后重新生成。',
    };
  }
  if (text.startsWith(NETWORK_TIMEOUT_PREFIX)) {
    return {
      kind: 'network_timeout',
      title: '图片服务请求超时',
      hint: '请稍后重新生成；频繁超时可适当调低尺寸或质量。',
    };
  }
  if (text.startsWith(NETWORK_PREFIX)) {
    return {
      kind: 'network_other',
      title: '图片服务网络异常',
      hint: '请检查代理与本地网络后重新生成。',
    };
  }

  if (text.startsWith(UPSTREAM_PREFIX)) {
    const code = /\[code:\s*([^\]]+)\]/.exec(text)?.[1];
    const httpStatus = /\(HTTP\s+(\d+)\)/.exec(text)?.[1];
    if (code === 'text_conversation_not_supported') {
      return {
        kind: 'upstream_capability',
        title: '模型调用方式与当前模型能力不匹配',
        hint: '上游把该请求路由到了文本会话通道。可直接重新生成；若持续出现请检查服务商模型配置。',
      };
    }
    if (httpStatus && Number(httpStatus) >= 500) {
      return {
        kind: 'upstream_5xx',
        title: '上游图片服务暂时不可用',
        hint: '服务端瞬时异常，请稍后重新生成。',
      };
    }
    return {
      kind: 'upstream_4xx',
      title: '图片生成请求被上游拒绝',
      hint: '请查看技术详情；确认提示词与参数合规后重新生成。',
    };
  }

  if (text === 'API Token 未设置') {
    return {
      kind: 'runtime_token_missing',
      title: '当前没有可用的运行 Token',
      hint: '请重新登录或等待运行配置下发后再重试。',
    };
  }

  if (
    text.startsWith('源图片不存在') ||
    text.startsWith('图生图任务缺少源图片') ||
    text.startsWith('无法读取源图片') ||
    text.startsWith('保存图片失败') ||
    text.startsWith('读取图片失败') ||
    text.startsWith('图片文件不存在')
  ) {
    return {
      kind: 'local_file',
      title: '本地文件错误',
      hint: '任务引用的源图可能已被移动或删除，请重新绑定后再生成。',
    };
  }

  return { kind: 'unknown', title: text.slice(0, 60), hint: '请查看技术详情。' };
}
