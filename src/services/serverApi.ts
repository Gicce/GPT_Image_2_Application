import { useSettingsStore } from '../store/useSettingsStore';

const DEFAULT_SERVER_BASE = 'http://localhost:4001';

// ── 统一错误语义：配置未就绪 / 配置错误不是网络错误 ──
export type ServerApiErrorKind =
  | 'runtime_not_ready'
  | 'configuration_error'
  | 'network_error'
  | 'http_error';

export interface ServerApiError extends Error {
  kind: ServerApiErrorKind;
  retryable: boolean;
  status?: number;
  url?: string;
  code?: string;
  detail?: unknown;
  isNetworkError?: boolean;
  serverUrl?: string;
}

export function makeServerApiError(
  kind: ServerApiErrorKind,
  message: string,
  extra: Partial<ServerApiError> = {},
): ServerApiError {
  const err = new Error(message) as ServerApiError;
  err.kind = kind;
  err.retryable = kind === 'network_error';
  Object.assign(err, extra);
  return err;
}

/** 判断地址是否指向本机回环（生产环境禁止作为 Cloud Server） */
export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * 生产环境防线：正式 build 解析到 localhost / 127.0.0.1 / ::1 作为
 * CyImagePro Cloud Server 时禁止发请求，返回明确的 configuration_error，
 * 而不是让普通客户看到开发地址的“无法连接服务器”。
 */
export function assertServerUrlUsable(baseUrl: string, prod: boolean): void {
  if (prod && isLoopbackUrl(baseUrl)) {
    throw makeServerApiError(
      'configuration_error',
      '服务器配置无效（指向本机开发地址），请在「设置 → 服务器地址」配置正确的服务器。',
      { serverUrl: baseUrl },
    );
  }
}

// 客户端统一使用的用户结构（V4 统一余额重构：不再有 tokens[] 分组余额）
export interface UserInfo {
  id: string;
  username: string;
  email: string;
  account_type: 'trial' | 'normal' | 'paid';
  trial_expires_at: string | null;
  trial_expired: boolean;
  /** 现金余额（后端返回字符串；展示 parseFloat(...).toFixed(2)，余额以服务端响应为准，不做本地累计） */
  balance_usd: string;
  /** 试用额度（字符串，同上） */
  trial_credit_usd: string;
}

export interface RuntimeGroupConfig {
  enabled: boolean;
  base_url: string;
  token: string;
  expires_in: number;
  model?: string;
  provider?: string | null;
}

export interface RuntimeConfig {
  image: RuntimeGroupConfig;
  agent: RuntimeGroupConfig;
  postprocess: RuntimeGroupConfig;
}

export interface AuthResponse {
  access_token: string;
  token_type: string;
  user: UserInfo;
}

// V4：充值订单为单一金额（Image2 统一余额），不再有 items/group
export interface OrderResult {
  out_trade_no: string;
  code_url: string;
  amount_usd: number;
  amount_cny: number;
  exchange_rate: number;
  status: string;
  dev_mode?: boolean;
  message?: string;
}

export interface OrderStatus {
  out_trade_no: string;
  /** status 到 'assigned' 即到账（不再下发 api_token） */
  status: 'pending' | 'paid' | 'assigned' | 'closed' | string;
  amount_usd: number;
  amount_cny: number;
  paid_at: string | null;
  balance_usd?: string;
  trial_credit_usd?: string;
}

export interface PayLimits {
  min_total_usd: number;
  max_total_usd: number;
  min_per_item_usd?: number;
}

export interface RefundRequestInfo {
  id: string;
  source: string;
  status: 'requested' | 'approved' | 'processing' | 'success' | 'rejected' | 'failed';
  requested_amount_cny: number;
  requested_amount_usd: number;
  reason: string | null;
  review_note: string | null;
  out_refund_no: string | null;
  failure_reason: string | null;
  requested_at: string | null;
  reviewed_at: string | null;
  completed_at: string | null;
}

export interface UserOrder {
  out_trade_no: string;
  /** V4 订单不再绑定分组；历史订单可能仍有值 */
  group?: string;
  amount_usd: number;
  amount_cny: number;
  total_usd?: number;
  total_cny?: number;
  exchange_rate: number | null;
  refunded_cny?: number;
  status: 'pending' | 'paid' | 'assigned' | 'allocated' | 'refund_requested' | 'refunding' | 'partially_refunded' | 'refunded' | 'refund_change' | 'closed';
  pay_type: string;
  items?: { group: string; amount_usd: number }[];
  created_at: string;
  paid_at: string | null;
  allocated_at?: string | null;
  refund_request?: RefundRequestInfo | null;
}

export interface UsageRecord {
  id: string;
  model: string;
  usage_type: string;
  type?: string;
  image_count: number | null;
  quantity?: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  /** 报告时点的每次单价（后端写入；历史记录可能为 null） */
  unit_price?: string | null;
  cost_usd: string;
  created_at: string | null;
  /** V4 两阶段计费：该笔用量对应的客户端 request_id */
  request_id?: string | null;
}

export interface UsageRecordsResponse {
  total: number;
  page: number;
  page_size: number;
  records: UsageRecord[];
}

export type UsageTrendMetric = 'image_count' | 'request_count' | 'cost';

export interface UsageSummary {
  period_spent: string;
  total_spent: string;
  request_count: number;
  image_count: number;
  start_time: string;
  end_time: string;
}

export interface UsageTrendResponse {
  metric: UsageTrendMetric;
  points: { date: string; value: number }[];
}

export interface UsageModelStat {
  model: string;
  usage_type: string;
  request_count: number;
  image_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string;
}

// ── Image2 Runtime Token（服务端 Token 池分配状态，仅脱敏信息） ──

export interface RuntimeTokenStatus {
  assigned: boolean;
  /** assigned = 用户绑定 Token；server_master = 未绑定，回落服务端 Master Token；none = 无可用上游凭证 */
  source: 'assigned' | 'server_master' | 'none';
  token_id: string | null;
  masked_token: string | null;
  is_trial: boolean;
  is_disabled: boolean;
  assigned_at: string | null;
}

export interface PackagesResponse {
  exchange_rate: number;
  currency?: string;
  /** V4：单模型（Image2）按次计费，不再有 groups 数组 */
  model: {
    name: string;
    display_name: string;
    price_per_call_usd: number | string;
  };
  limits?: PayLimits;
}

export interface ServerModel {
  id: string;
  name: string;
  display_name: string;
  provider: string;
  billing_type: 'per_call' | 'per_token';
  model_type: 'image' | 'agent' | 'postprocess' | 'chat';
  trial_allowed: boolean;
  group?: string | null;
  user_has_access: boolean;
  price_input: string | null;
  price_output: string | null;
  price_cached: string | null;
  price_per_call: string | null;
  context_window?: number | null;
  supports_tools?: boolean | null;
  supports_vision?: boolean | null;
  /** 该分组是否仍可充值（false = 已停止新购，如 AI 智能体） */
  rechargeable?: boolean;
}

// ── V4 两阶段计费：authorize（生成前预占）/ settle（生成后结算） ──

/** POST /api/usage/authorize 200 响应（金额字段后端返回字符串，统一归一为 string） */
export interface UsageAuthorizeResult {
  request_id: string;
  status: string;
  unit_price_usd: string;
  amount_usd: string;
  trial_amount: string;
  balance_amount: string;
  billing_source: string;
  balance_usd: string;
  trial_credit_usd: string;
}

/** POST /api/usage/settle 200 响应 */
export interface UsageSettleResult {
  request_id: string;
  status: string;
  amount_usd: string;
  balance_usd: string;
  trial_credit_usd: string;
}

/**
 * 获取用户配置的服务器地址，如果为空则返回默认地址。
 * 注意：settings 尚未恢复时返回的是开发默认值（localhost:4001）——
 * 运行期自动请求必须先通过 requestServerUrl()（含 settingsLoaded gate）。
 */
export function getConfiguredServerUrl(): string {
  const configured = useSettingsStore.getState().settings.server_url;
  const trimmed = (configured || '').trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : DEFAULT_SERVER_BASE;
}

/**
 * 请求前统一解析服务器地址：
 *  1. settings 未恢复 → runtime_not_ready（等待，不是网络错误）
 *  2. 生产环境解析到回环地址 → configuration_error（禁止发送）
 */
export function requestServerUrl(): string {
  if (!useSettingsStore.getState().settingsLoaded) {
    throw makeServerApiError('runtime_not_ready', '服务器配置尚未就绪，请稍候重试');
  }
  const baseUrl = getConfiguredServerUrl();
  assertServerUrlUsable(baseUrl, import.meta.env.PROD);
  return baseUrl;
}

/**
 * 检查返回的 health 数据是否是 CyImagePro 后端
 */
function isCyImageProHealthResponse(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  // 检查是否包含关键标识字段
  const hasOk = 'ok' in obj && obj.ok === true;
  const hasService = 'service' in obj && typeof obj.service === 'string' && obj.service.includes('cyimagepro');
  const hasStatus = 'status' in obj && obj.status === 'ok';
  return hasOk || hasService || hasStatus;
}

/**
 * 测试连接 - 严格检测指定的服务器地址
 * 不使用 fallback，只检测传入的 url
 * 返回连接状态和详细信息
 */
export async function testServerConnection(url: string): Promise<{
  ok: boolean;
  message: string;
  host: string;
  service?: string;
  version?: string;
}> {
  const baseUrl = url.trim().replace(/\/+$/, '');

  if (!baseUrl) {
    return { ok: false, message: '请输入服务器地址', host: '' };
  }

  // 提取主机名用于显示
  let host = baseUrl;
  try {
    const parsed = new URL(baseUrl);
    host = parsed.host;
  } catch {
    host = baseUrl.replace(/^https?:\/\//, '').split('/')[0];
  }

  // 尝试两个 health 接口路径
  const healthPaths = ['/api/health', '/health'];

  for (const path of healthPaths) {
    const fullUrl = `${baseUrl}${path}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(fullUrl, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        continue; // 尝试下一个路径
      }

      const data = await response.json();

      // 验证返回内容是否是 CyImagePro 后端
      if (!isCyImageProHealthResponse(data)) {
        continue; // 尝试下一个路径
      }

      return {
        ok: true,
        message: '连接成功',
        host,
        service: (data as Record<string, unknown>).service as string | undefined,
        version: (data as Record<string, unknown>).version as string | undefined,
      };

    } catch {
      // 继续尝试下一个路径
    }
  }

  return {
    ok: false,
    message: '无法连接服务器，请检查地址是否正确',
    host,
  };
}

function getToken(): string | null {
  try {
    return localStorage.getItem('cy_jwt');
  } catch {
    return null;
  }
}

/**
 * 核心请求函数 - 只使用用户配置的服务器地址
 * 不再 fallback 到其他地址
 */
async function request<T>(
  path: string,
  options: RequestInit = {},
  auth = false
): Promise<T> {
  const baseUrl = requestServerUrl();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  if (auth) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const fullUrl = `${baseUrl}${path}`;

  try {
    const res = await fetch(fullUrl, { ...options, headers });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // detail 可能是字符串、{code, message} 对象（如 402 QUOTA_EXHAUSTED），
      // 或 FastAPI 校验错误数组 [{loc, msg, type}, ...]（HTTP 422）
      const rawDetail: unknown = body.detail;
      let message = `HTTP ${res.status}`;
      let detailCode: string | undefined;
      if (typeof rawDetail === 'string' && rawDetail.trim()) {
        message = rawDetail.trim();
      } else if (Array.isArray(rawDetail) && rawDetail.length) {
        const msgs = rawDetail
          .map((item: any) => (typeof item?.msg === 'string' ? item.msg : ''))
          .filter(Boolean);
        message = msgs.length ? msgs.join('；') : `HTTP ${res.status}`;
        detailCode = 'VALIDATION_ERROR';
      } else if (rawDetail && typeof rawDetail === 'object') {
        const d = rawDetail as { code?: unknown; message?: unknown };
        if (typeof d.message === 'string' && d.message.trim()) message = d.message.trim();
        if (typeof d.code === 'string') detailCode = d.code;
      }
      throw makeServerApiError('http_error', message, {
        status: res.status,
        url: fullUrl,
        code: detailCode,
        detail: rawDetail && typeof rawDetail === 'object' ? rawDetail : undefined,
      });
    }

    return await res.json();
  } catch (err: any) {
    // 已分类的业务/配置错误直接抛出
    if (err.kind) {
      throw err;
    }

    // 网络错误，附加当前服务器地址信息
    const isNetworkError =
      err?.name === 'TypeError' ||
      /Failed to fetch|NetworkError|Load failed|abort/i.test(err?.message || '');

    if (isNetworkError) {
      console.error(`[serverApi] 网络错误 ${fullUrl}:`, err.message);
      throw makeServerApiError('network_error', `无法连接服务器（${baseUrl}）`, {
        isNetworkError: true,
        serverUrl: baseUrl,
      });
    }

    console.error('[serverApi] request failed:', err);
    throw err;
  }
}

// Normalize raw user response into consistent UserInfo shape
function normalizeUser(raw: any): UserInfo {
  return {
    id: raw.id,
    username: raw.username,
    email: raw.email,
    account_type: raw.account_type,
    trial_expires_at: raw.trial_expires_at ?? null,
    trial_expired: raw.trial_expired ?? false,
    balance_usd: raw.balance_usd != null ? String(raw.balance_usd) : '0',
    trial_credit_usd: raw.trial_credit_usd != null ? String(raw.trial_credit_usd) : '0',
  };
}

function normalizeAuthResponse(raw: any): AuthResponse {
  return {
    access_token: raw.access_token,
    token_type: raw.token_type,
    user: normalizeUser(raw.user),
  };
}

function normalizeAuthorize(raw: any): UsageAuthorizeResult {
  return {
    request_id: raw.request_id,
    status: raw.status,
    unit_price_usd: String(raw.unit_price_usd ?? '0'),
    amount_usd: String(raw.amount_usd ?? '0'),
    trial_amount: String(raw.trial_amount ?? '0'),
    balance_amount: String(raw.balance_amount ?? '0'),
    billing_source: raw.billing_source ?? '',
    balance_usd: raw.balance_usd != null ? String(raw.balance_usd) : '0',
    trial_credit_usd: raw.trial_credit_usd != null ? String(raw.trial_credit_usd) : '0',
  };
}

function normalizeSettle(raw: any): UsageSettleResult {
  return {
    request_id: raw.request_id,
    status: raw.status,
    amount_usd: String(raw.amount_usd ?? '0'),
    balance_usd: raw.balance_usd != null ? String(raw.balance_usd) : '0',
    trial_credit_usd: raw.trial_credit_usd != null ? String(raw.trial_credit_usd) : '0',
  };
}

// V4 统一余额权益（不再按 group 拆分）
export interface AccountEntitlements {
  balance_usd: string;
  trial_credit_usd: string;
  total_credit_usd: string;
  enabled_features: Record<string, boolean>;  // { "image": true }
  enabled_models: string[];  // ["gpt-image-2"]
  image2?: {
    enabled: boolean;
    trial_allowed: boolean;
    price_per_call_usd: number | string;
    currency: string;
  };
}

export const serverApi = {
  register: (username: string, email: string, password: string, account_type: 'trial' | 'normal' = 'trial') =>
    request<any>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password, account_type }),
    }).then(normalizeAuthResponse),

  registerSendCode: (username: string, email: string, password: string, account_type: 'trial' | 'normal' = 'normal') =>
    request<{ message: string }>('/api/auth/register/send-code', {
      method: 'POST',
      body: JSON.stringify({ username, email, password, account_type }),
    }),

  registerVerify: (email: string, code: string, username: string, password: string, account_type: 'trial' | 'normal' = 'normal') =>
    request<any>('/api/auth/register/verify', {
      method: 'POST',
      body: JSON.stringify({ email, code, username, password, account_type }),
    }).then(normalizeAuthResponse),

  login: (username: string, password: string) =>
    request<any>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }).then(normalizeAuthResponse),

  upgradeTrial: () =>
    request<any>('/api/auth/upgrade-trial', { method: 'POST' }, true)
      .then(raw => normalizeUser(raw.user ?? raw)),

  getMe: () =>
    request<any>('/api/users/me', {}, true).then(normalizeUser),

  getAccountEntitlements: () =>
    request<AccountEntitlements>('/api/users/me/entitlements', {}, true),

  getRuntimeConfig: () =>
    request<RuntimeConfig>('/api/users/me/runtime-config', {}, true),

  getRuntimeToken: () =>
    request<RuntimeTokenStatus>('/api/users/me/runtime-token', {}, true),

  getUsage: () =>
    request<any[]>('/api/users/me/usage', {}, true),

  // ── V4 两阶段计费（Image2 单模型 + 统一余额）──
  // 生成前预占额度：402 = QUOTA_EXHAUSTED（余额不足，请充值后继续使用）；403 = IMAGE2_DISABLED
  authorizeImage2: (requestId: string, imageCount: number) =>
    request<any>(
      '/api/usage/authorize',
      { method: 'POST', body: JSON.stringify({ request_id: requestId, image_count: imageCount }) },
      true
    ).then(normalizeAuthorize),

  // 生成后结算（幂等；服务端对超时未 settle 的预占有 2 小时自动释放兜底）
  settleImage2: (requestId: string, success: boolean, imageCount?: number, failureReason?: string) => {
    const body: Record<string, unknown> = { request_id: requestId, success };
    if (imageCount != null) body.image_count = imageCount;
    if (failureReason) body.failure_reason = failureReason;
    return request<any>(
      '/api/usage/settle',
      { method: 'POST', body: JSON.stringify(body) },
      true
    ).then(normalizeSettle);
  },

  // V3.0.6：Agent 对话全面 BYOK；V4：图片生成改为 authorize + settle 闭环
  // （旧 estimate / report/image 端点已随服务器重构删除）。

  getPackages: () => request<PackagesResponse>('/api/pay/packages'),

  createOrder: (amountUsd: number) =>
    request<OrderResult>(
      '/api/pay/create_order',
      { method: 'POST', body: JSON.stringify({ amount_usd: amountUsd }) },
      true
    ),

  closeOrder: (out_trade_no: string) =>
    request<{ status: string; out_trade_no: string }>(
      `/api/pay/close/${out_trade_no}`,
      { method: 'POST' },
      true
    ),

  refundOrder: (out_trade_no: string) =>
    request<{ status: string; out_trade_no: string; message: string; refund_request?: RefundRequestInfo | null }>(
      `/api/pay/refund_order/${out_trade_no}`,
      { method: 'POST' },
      true
    ),

  refundStatus: (out_trade_no: string) =>
    request<{ status: string; out_refund_no: string | null; amount_cny: number; refunded_cny?: number; refund_request?: RefundRequestInfo | null }>(
      `/api/pay/refund_status/${out_trade_no}`,
      {},
      true
    ),

  queryOrder: (out_trade_no: string) =>
    request<OrderStatus>(`/api/pay/query/${out_trade_no}`, {}, true),

  getOrders: () =>
    request<UserOrder[]>('/api/pay/orders', {}, true),

  getUsageRecords: (
    page: number = 1,
    page_size: number = 20,
    model?: string,
    usage_type?: string,
    start_time?: string,
    end_time?: string,
    keyword?: string,
  ) => {
    const params = new URLSearchParams({ page: String(page), page_size: String(page_size) });
    if (model) params.set('model', model);
    if (usage_type) params.set('usage_type', usage_type);
    if (start_time) params.set('start_time', start_time);
    if (end_time) params.set('end_time', end_time);
    if (keyword) params.set('keyword', keyword);
    return request<UsageRecordsResponse>(`/api/usage/records?${params.toString()}`, {}, true);
  },

  getUsageSummary: (start_time: string, end_time: string) => {
    const params = new URLSearchParams({ start_time, end_time });
    return request<UsageSummary>(`/api/usage/summary?${params.toString()}`, {}, true);
  },

  getUsageTrend: (start_time: string, end_time: string, metric: UsageTrendMetric) => {
    const params = new URLSearchParams({ start_time, end_time, metric });
    return request<UsageTrendResponse>(`/api/usage/trend?${params.toString()}`, {}, true);
  },

  getUsageModels: (start_time: string, end_time: string) => {
    const params = new URLSearchParams({ start_time, end_time });
    return request<UsageModelStat[]>(`/api/usage/models?${params.toString()}`, {}, true);
  },

  getNotice: () => request<{ content: string; is_active: boolean }>('/api/notice'),

  getModels: () => request<ServerModel[]>('/api/models', {}, true),

  getTrialStock: () =>
    request<{ remaining: number; available: boolean }>('/api/tokens/trial-stock'),

  forgotPassword: (email: string) =>
    request<{ message: string }>('/api/auth/forgot-password/send-code', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  resetPassword: (email: string, code: string, new_password: string) =>
    request<{ message: string }>('/api/auth/forgot-password/reset', {
      method: 'POST',
      body: JSON.stringify({ email, code, new_password }),
    }),
};
