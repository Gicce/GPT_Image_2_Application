/**
 * 图片生成失败 canonical failure classifier（V4.1 Task Failure UX）。
 *
 * 输入两态、输出一份 TaskFailureInfo：
 *  - 新数据：SubTask.error_detail（Rust task_failure.rs 已正规化的结构化快照，
 *    category 是权威分类，禁止再 substring 二次分类）；
 *  - 旧数据：仅 string error（Rust 稳定文案前缀回落解析，规则与 Rust 分类一致）。
 *
 * 铁律（cyimagepro-ui patterns §20）：
 *  - Friendly error summary MUST be separated from technical diagnostics；
 *  - 不吞原始错误：technical.rawMessage 永远保留，供「查看技术详情」展开。
 */

import type { SubTask, SubTaskErrorDetail } from '../types';

export type FailureCategory =
  | 'timeout'
  | 'upstream_5xx'
  | 'rate_limit'
  | 'auth'
  | 'insufficient_balance'
  | 'invalid_request'
  | 'content_rejected'
  | 'network'
  | 'local_file'
  | 'cancelled'
  | 'unknown';

export interface TaskFailureTechnical {
  httpStatus?: number;
  providerCode?: string;
  requestId?: string;
  endpoint?: string;
  rawMessage?: string;
}

export interface TaskFailureInfo {
  category: FailureCategory;
  title: string;
  userMessage: string;
  suggestion?: string;
  retryable: boolean;
  technical?: TaskFailureTechnical;
}

export interface TaskFailureSource {
  detail?: SubTaskErrorDetail | null;
  message?: string | null;
}

const KNOWN_CATEGORIES: ReadonlySet<string> = new Set<FailureCategory>([
  'timeout', 'upstream_5xx', 'rate_limit', 'auth', 'insufficient_balance',
  'invalid_request', 'content_rejected', 'network', 'local_file', 'cancelled', 'unknown',
]);

const UPSTREAM_PREFIX = '上游图片接口失败';
const NETWORK_PREFIX = '图片服务连接失败';

const TIMEOUT_TEXT_RE = /timed\s*-?\s*out|deadline exceeded|connect timeout|read timeout|request timed out/i;
const REQUEST_ID_RE = /request[ _]?id[:=]\s*([A-Za-z0-9_\-.]{6,})/i;

const LOCAL_FILE_PREFIXES = [
  '源图片不存在', '图生图任务缺少源图片', '无法读取源图片', '保存图片失败',
  '读取图片失败', '图片文件不存在', '区域 mask 文件不存在', '无法读取区域 mask',
  '去背景任务缺少源图', '源图不存在', '读取源图失败', '保存透明图失败', '创建透明图目录失败',
];

const BALANCE_MARKERS = ['1113', 'insufficient_balance', 'insufficient quota', '余额不足', '欠费'];
const CONTENT_MARKERS = [
  'content_policy', 'content_filter', 'content_violation', 'moderation',
  'prohibited_content', 'sensitive_content',
];

function includesAny(text: string, markers: string[]): boolean {
  return markers.some(m => text.includes(m));
}

/** 上游 HTTP 失败分类（与 Rust classify_upstream_failure 同一规则表）。 */
function classifyUpstreamStatus(
  httpStatus: number | undefined,
  providerCode: string | undefined,
  rawText: string,
): FailureCategory {
  const code = (providerCode ?? '').toLowerCase();
  const combined = `${code} ${rawText.toLowerCase()}`;
  if (includesAny(combined, BALANCE_MARKERS)) return 'insufficient_balance';
  if (includesAny(combined, CONTENT_MARKERS)) return 'content_rejected';
  if (httpStatus === 401 || httpStatus === 403) return 'auth';
  if (httpStatus === 402) return 'insufficient_balance';
  if (httpStatus === 429) return 'rate_limit';
  if (httpStatus !== undefined && httpStatus >= 500) return 'upstream_5xx';
  if (httpStatus !== undefined && httpStatus >= 400) return 'invalid_request';
  return 'unknown';
}

const RETRYABLE_CATEGORY: ReadonlySet<FailureCategory> = new Set([
  'timeout', 'upstream_5xx', 'rate_limit', 'network', 'local_file', 'unknown',
]);

function isRetryable(category: FailureCategory): boolean {
  return RETRYABLE_CATEGORY.has(category);
}

/** 每类失败的固定文案（copy.md §13；标题 / 说明 / 建议三层分离）。 */
function buildCopy(
  category: FailureCategory,
  opts: { httpStatus?: number; rawText?: string; providerCode?: string; endpoint?: string },
): Pick<TaskFailureInfo, 'title' | 'userMessage' | 'suggestion'> {
  const statusNote = opts.httpStatus ? `（HTTP ${opts.httpStatus}）` : '';
  switch (category) {
    case 'upstream_5xx':
      return {
        title: '上游图片服务异常',
        userMessage: `图片服务返回了服务器错误${statusNote}，本次生成未完成。`,
        suggestion: '通常属于临时服务异常，建议稍后重试。',
      };
    case 'timeout':
      return {
        title: '生成请求超时',
        userMessage: '图片服务在规定时间内没有完成响应，本次生成已停止。',
        suggestion: '网络波动或服务繁忙时可能出现，建议重新生成。',
      };
    case 'rate_limit':
      return {
        title: '请求过于频繁',
        userMessage: '当前图片服务请求较多，请稍后再试。',
        suggestion: '稍等片刻后重新生成即可，无需修改任何参数。',
      };
    case 'auth':
      return {
        title: '模型服务授权失败',
        userMessage: `图片服务拒绝了当前的身份验证${statusNote}。`,
        suggestion: '请检查当前模型服务配置或 API 凭据。',
      };
    case 'insufficient_balance':
      return {
        title: '模型服务余额不足',
        userMessage: '当前模型服务账户余额不足，本次生成未完成。',
        suggestion: '请前往「我的账户」充值后再重试。',
      };
    case 'invalid_request':
      if (opts.providerCode === 'text_conversation_not_supported') {
        // V4.0.5 取证：packyapi 网关把图片请求误路由到文本会话通道（保留专项文案）
        if (opts.endpoint?.includes('/v1/images/edits')) {
          return {
            title: '模型调用方式与当前模型能力不匹配',
            userMessage: '当前服务商的图生图接口被上游网关误路由到文本会话通道。',
            suggestion: '可直接重新生成；若持续出现请检查服务商模型配置。',
          };
        }
        return {
          title: '模型调用方式与当前模型能力不匹配',
          userMessage: '上游把该请求路由到了文本会话通道。',
          suggestion: '可直接重新生成；若持续出现请检查服务商模型配置。',
        };
      }
      return {
        title: '生成参数不符合当前模型要求',
        userMessage: `图片服务拒绝了本次请求的参数${statusNote}。`,
        suggestion: '请检查参考图、尺寸或生成参数后重试。',
      };
    case 'content_rejected':
      return {
        title: '内容未通过安全审核',
        userMessage: '本次生成的内容未通过图片服务的安全检查。',
        suggestion: '请调整提示词或参考图内容后重试。',
      };
    case 'network':
      return {
        title: '网络连接异常',
        userMessage: '无法连接图片服务或网络中断，本次生成未完成。',
        suggestion: '请检查网络或代理设置后重试（「设置与更新 → 一键检查运行环境」可一键诊断）。',
      };
    case 'local_file':
      return {
        title: '本地文件错误',
        userMessage: '任务引用的源图或本地文件无法访问，本次生成未完成。',
        suggestion: '源图可能已被移动或删除，请重新绑定后再生成。',
      };
    case 'cancelled':
      return {
        title: '任务已取消',
        userMessage: '本次生成已被取消。',
        suggestion: undefined,
      };
    default: {
      const raw = (opts.rawText ?? '').trim();
      return {
        title: '生成失败',
        userMessage: raw ? `本次生成未完成：${raw.slice(0, 80)}` : '本次生成未完成，原因未归类。',
        suggestion: '请查看技术详情，或稍后重试。',
      };
    }
  }
}

/** 旧数据（仅 string error）的稳定前缀回落解析。 */
function classifyLegacyMessage(text: string): {
  category: FailureCategory;
  technical: TaskFailureTechnical;
} {
  const technical: TaskFailureTechnical = {};
  technical.providerCode = /\[code:\s*([^\]]+)\]/.exec(text)?.[1];
  const httpStatusText = /\(HTTP\s+(\d+)\)/.exec(text)?.[1];
  technical.httpStatus = httpStatusText ? Number(httpStatusText) : undefined;
  technical.endpoint = /\[endpoint:\s*([^\]]+)\]/.exec(text)?.[1];
  technical.requestId = REQUEST_ID_RE.exec(text)?.[1];
  technical.rawMessage = text;

  // 应用重启中断（reconcile 落盘的固定文案）
  if (text.includes('客户端重启导致任务中断')) {
    return { category: 'cancelled', technical };
  }
  if (text.startsWith(NETWORK_PREFIX)) {
    const kind = /（(timeout|connect|request|network)）/.exec(text)?.[1];
    const category: FailureCategory = kind === 'timeout' ? 'timeout' : 'network';
    return { category, technical };
  }
  if (text === 'API Token 未设置') {
    return { category: 'auth', technical };
  }
  if (LOCAL_FILE_PREFIXES.some(prefix => text.startsWith(prefix))) {
    return { category: 'local_file', technical };
  }
  if (text.startsWith(UPSTREAM_PREFIX)) {
    const category = classifyUpstreamStatus(
      technical.httpStatus,
      technical.providerCode,
      text.replace(/\[endpoint:[^\]]*\]/, ''),
    );
    return { category, technical };
  }
  // 兜底英文/未知文本：显式超时标记单独识别（禁止把 500 误报为超时）
  if (TIMEOUT_TEXT_RE.test(text)) {
    return { category: 'timeout', technical };
  }
  return { category: 'unknown', technical };
}

/**
 * 唯一分类入口：结构化 detail 优先（category 权威），旧 string 回落解析。
 * 应用重启中断标记在任何输入下都优先生效。
 */
export function classifyGenerationFailure(source: TaskFailureSource): TaskFailureInfo {
  const message = (source.message ?? '').trim();
  const detail = source.detail ?? null;

  // 旧文案标记优先（即使 detail 存在，重启中断语义以文案为准）
  if (!detail && message.includes('客户端重启导致任务中断')) {
    return {
      category: 'cancelled',
      title: '任务因应用中断未完成',
      userMessage: '应用重启导致本次生成中断。',
      suggestion: '重新生成即可恢复，之前的参数与参考图已保留。',
      retryable: true,
      technical: { rawMessage: message },
    };
  }

  let category: FailureCategory;
  let technical: TaskFailureTechnical;

  if (detail && KNOWN_CATEGORIES.has(detail.category as FailureCategory)) {
    category = detail.category as FailureCategory;
    technical = {
      httpStatus: detail.http_status ?? undefined,
      providerCode: detail.provider_code ?? undefined,
      requestId: detail.request_id ?? undefined,
      endpoint: detail.endpoint ?? undefined,
      rawMessage: detail.message || message,
    };
  } else if (message) {
    const legacy = classifyLegacyMessage(message);
    category = legacy.category;
    technical = legacy.technical;
  } else {
    category = 'unknown';
    technical = {};
  }

  const copy = buildCopy(category, {
    httpStatus: technical.httpStatus,
    rawText: technical.rawMessage ?? message,
    providerCode: technical.providerCode,
    endpoint: technical.endpoint,
  });

  // 运行 Token 未配置：auth 类下的专项文案（保持 V4.0.5 语义）
  if (category === 'auth' && (message === 'API Token 未设置' || technical.rawMessage === 'API Token 未设置')) {
    return {
      category,
      title: '当前没有可用的运行 Token',
      userMessage: '应用尚未获得可用的运行 Token，本次生成未开始。',
      suggestion: '请重新登录或等待运行配置下发后再重试。',
      retryable: false,
      technical,
    };
  }

  const retryable = detail ? detail.retryable !== false : isRetryable(category);

  return {
    category,
    ...copy,
    retryable,
    technical: Object.keys(technical).length > 0 ? technical : undefined,
  };
}

/** 子任务失败分类的便捷入口。 */
export function classifySubTaskFailure(subTask: Pick<SubTask, 'error' | 'error_detail'>): TaskFailureInfo {
  return classifyGenerationFailure({ detail: subTask.error_detail ?? null, message: subTask.error ?? null });
}

/**
 * Endpoint 脱敏展示：摘要只显示「接口名 · 路径」，完整 URL 仅进技术详情。
 * 绝不展示 Authorization / API Key（本项目凭据在请求头，从不出现在 endpoint）。
 */
export function describeEndpoint(endpoint?: string | null): string {
  const raw = (endpoint ?? '').trim();
  if (!raw) return '';
  if (raw.includes('remove.bg')) return '去背景接口 · /v1.0/removebg';
  const path = raw.includes('://') ? `/${raw.split('://')[1].split('/').slice(1).join('/')}` : raw;
  if (path.includes('/v1/images/edits')) return '图片生成接口 · /v1/images/edits';
  if (path.includes('/v1/images/generations')) return '图片生成接口 · /v1/images/generations';
  return `图片生成接口 · ${path}`;
}

export interface TaskFailureAttempt {
  /** 该次尝试的失败时间（旧数据只有 string，无时间）。 */
  timestamp?: string;
  info: TaskFailureInfo;
}

/**
 * 重试历史：attempt_details 与 attempt_errors **尾部对齐**
 * （旧数据只有 errors；新失败同时追加两边，details 是最近 N 条）。
 */
export function attemptFailureHistory(
  subTask: Pick<SubTask, 'attempt_errors' | 'attempt_details'>,
): TaskFailureAttempt[] {
  const errors = subTask.attempt_errors ?? [];
  const details = subTask.attempt_details ?? [];
  const offset = Math.max(0, errors.length - details.length);
  return errors.map((message, i) => {
    const detail = i >= offset ? details[i - offset] : undefined;
    return {
      timestamp: detail?.timestamp,
      info: classifyGenerationFailure({ detail, message }),
    };
  });
}
