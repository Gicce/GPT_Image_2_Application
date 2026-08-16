import { useSettingsStore } from '../store/useSettingsStore';

const DEFAULT_SERVER_BASE = 'http://localhost:4001';

export interface UserToken {
  group: string;
  balance_usd: number;
  api_token: string;
  is_trial: boolean;
}

// 客户端统一使用的用户结构（v3 tokens[] 重构）
export interface UserInfo {
  id: string;
  username: string;
  email: string;
  account_type: 'trial' | 'normal' | 'paid';
  trial_expires_at: string | null;
  trial_expired: boolean;
  tokens: UserToken[];
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

export interface OrderItem {
  group: string;
  amount_usd: number;
}

export interface OrderResult {
  out_trade_no: string;
  code_url: string;
  amount_cny: number;
  exchange_rate: number;
  amount_usd: number;
  group: string;
  items: OrderItem[];
  status?: 'pending' | 'paid' | 'closed';
}

export interface OrderStatus {
  out_trade_no: string;
  status: 'pending' | 'paid' | 'closed';
  amount_usd: number;
  amount_cny: number;
  group: string;
  items?: OrderItem[];
  paid_at: string | null;
  api_token?: string | null;
}

export interface PackageGroup {
  name: string;
  description?: string;
}

export interface PayLimits {
  min_total_usd: number;
  max_total_usd: number;
  min_per_item_usd: number;
}

export interface UserOrder {
  out_trade_no: string;
  group: string;
  amount_usd: number;
  amount_cny: number;
  total_usd?: number;
  total_cny?: number;
  exchange_rate: number | null;
  status: 'pending' | 'paid' | 'assigned' | 'allocated' | 'refunding' | 'refunded' | 'refund_change' | 'closed';
  pay_type: string;
  items: { group: string; amount_usd: number }[];
  created_at: string;
  paid_at: string | null;
  allocated_at?: string | null;
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

export interface PackagesResponse {
  exchange_rate: number;
  groups: PackageGroup[];
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

export interface ServerPrompt {
  id: string;
  title: string;
  content: string;
}

export interface PromptsResponse {
  categories: string[];
  prompts: Record<string, ServerPrompt[]>;
}

export interface UsageEstimateItem {
  type: 'agent' | 'image' | 'postprocess' | 'chat';
  model?: string;
  tool?: string;
  quantity?: number;
  image_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
}

export interface UsageEstimateGroup {
  group: string;
  required_usd: number;
  balance_usd: number;
  enough: boolean;
}

export interface UsageEstimate {
  can_run: boolean;
  total_cost_usd: number;
  groups: UsageEstimateGroup[];
  message?: string;
}

// Server returns cost_usd/balance_usd as strings — normalize to numbers
export interface UsageReportResult {
  cost_usd: number;
  balance_usd: number;
  group: string;
  account_type: 'trial' | 'normal' | 'paid';
}

/**
 * 获取用户配置的服务器地址，如果为空则返回默认地址
 */
export function getConfiguredServerUrl(): string {
  const configured = useSettingsStore.getState().settings.server_url;
  const trimmed = (configured || '').trim();
  const result = trimmed ? trimmed.replace(/\/+$/, '') : DEFAULT_SERVER_BASE;
  // 调试日志：打印实际使用的服务器地址
  console.log(`[serverApi] getConfiguredServerUrl: settings.server_url="${configured}", result="${result}"`);
  return result;
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

      console.log(`[testServerConnection] 正在测试: ${fullUrl}`);

      const response = await fetch(fullUrl, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.log(`[testServerConnection] HTTP ${response.status} - ${fullUrl}`);
        continue; // 尝试下一个路径
      }

      const data = await response.json();

      // 验证返回内容是否是 CyImagePro 后端
      if (!isCyImageProHealthResponse(data)) {
        console.log(`[testServerConnection] 响应不是 CyImagePro 服务:`, data);
        continue; // 尝试下一个路径
      }

      console.log(`[testServerConnection] 连接成功:`, data);

      return {
        ok: true,
        message: '连接成功',
        host,
        service: (data as Record<string, unknown>).service as string | undefined,
        version: (data as Record<string, unknown>).version as string | undefined,
      };

    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.log(`[testServerConnection] 请求失败 ${fullUrl}:`, errorMessage);
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
  const baseUrl = getConfiguredServerUrl();

  // [临时诊断] 打印请求详情
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
    const settingsUrl = useSettingsStore.getState().settings.server_url;
    const bodyStr = options.body as string | undefined;
    let bodyInfo = 'no body';
    if (bodyStr) {
      try {
        const parsed = JSON.parse(bodyStr);
        bodyInfo = JSON.stringify({
          ...parsed,
          password: parsed.password ? `[length:${parsed.password.length}]` : undefined,
        });
      } catch {
        bodyInfo = bodyStr.substring(0, 100);
      }
    }
    console.log('[serverApi] ===== REQUEST START =====');
    console.log('[serverApi] baseUrl from settings:', settingsUrl);
    console.log('[serverApi] resolved baseUrl:', baseUrl);
    console.log('[serverApi] path:', path);
    console.log('[serverApi] final url:', `${baseUrl}${path}`);
    console.log('[serverApi] method:', options.method || 'GET');
    console.log('[serverApi] body:', bodyInfo);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  if (auth) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const fullUrl = `${baseUrl}${path}`;

  // 开发环境输出请求 URL
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
    console.log(`[serverApi] 请求: ${options.method || 'GET'} ${fullUrl}`);
  }

  try {
    const res = await fetch(fullUrl, { ...options, headers });

    // [临时诊断] 打印响应状态
    if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
      console.log('[serverApi] response status:', res.status);
      console.log('[serverApi] response ok:', res.ok);
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err: any = new Error(body.detail || `HTTP ${res.status}`);
      err.status = res.status;
      err.url = fullUrl;
      console.error(`[serverApi] 业务错误 ${fullUrl}:`, body.detail || `HTTP ${res.status}`);
      console.log('[serverApi] ===== REQUEST END (ERROR) =====');
      throw err;
    }

    const data = await res.json();

    // [临时诊断] 打印响应内容
    if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
      console.log('[serverApi] response body:', JSON.stringify(data));
      console.log('[serverApi] ===== REQUEST END (SUCCESS) =====');
    }

    return data;
  } catch (err: any) {
    // 如果是我们构造的业务错误，直接抛出
    if (err.status) {
      throw err;
    }

    // 网络错误，附加当前服务器地址信息
    const isNetworkError =
      err?.name === 'TypeError' ||
      /Failed to fetch|NetworkError|Load failed|abort/i.test(err?.message || '');

    if (isNetworkError) {
      console.error(`[serverApi] 网络错误 ${fullUrl}:`, err.message);
      console.error('[serverApi] error name:', err?.name);
      console.error('[serverApi] error type:', typeof err);
      console.log('[serverApi] ===== REQUEST END (NETWORK ERROR) =====');
      const networkErr: any = new Error(`无法连接服务器（${baseUrl}）`);
      networkErr.isNetworkError = true;
      networkErr.serverUrl = baseUrl;
      throw networkErr;
    }

    console.error('[serverApi] unknown error:', err);
    console.log('[serverApi] ===== REQUEST END (UNKNOWN ERROR) =====');
    throw err;
  }
}

// Normalize raw user response into consistent UserInfo shape
function normalizeUser(raw: any): UserInfo {
  const tokens: UserToken[] = Array.isArray(raw.tokens)
    ? raw.tokens.map((t: any) => ({
        group: t.group,
        balance_usd: Number(t.balance_usd ?? 0),
        api_token: t.api_token ?? '',
        is_trial: !!t.is_trial,
      }))
    : [];
  return {
    id: raw.id,
    username: raw.username,
    email: raw.email,
    account_type: raw.account_type,
    trial_expires_at: raw.trial_expires_at ?? null,
    trial_expired: raw.trial_expired ?? false,
    tokens,
  };
}

function normalizeAuthResponse(raw: any): AuthResponse {
  return {
    access_token: raw.access_token,
    token_type: raw.token_type,
    user: normalizeUser(raw.user),
  };
}

function normalizeUsageReport(raw: any): UsageReportResult {
  return {
    cost_usd: Number(raw.cost_usd ?? 0),
    balance_usd: Number(raw.balance_usd ?? 0),
    group: raw.group ?? '',
    account_type: raw.account_type ?? 'normal',
  };
}

function normalizeEstimate(raw: any): UsageEstimate {
  return {
    can_run: raw.can_run ?? false,
    total_cost_usd: Number(raw.total_cost_usd ?? 0),
    groups: (raw.groups ?? []).map((g: any) => ({
      group: g.group,
      required_usd: Number(g.required_usd ?? 0),
      balance_usd: Number(g.balance_usd ?? 0),
      enough: g.enough ?? false,
    })),
    message: raw.message,
  };
}

export interface AccountEntitlements {
  balances: Record<string, number>;  // { "image": 3.0, "agent": 3.0, "postprocess": 0.0 }
  enabled_features: Record<string, boolean>;  // { "image": true, "agent": true, "postprocess": false }
  enabled_models: Record<string, string[]>;  // { "image": ["gpt-image-2"], "agent": ["gpt-4o"] }
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

  getUsage: () =>
    request<any[]>('/api/users/me/usage', {}, true),

  reportImage: (model: string, image_count: number) =>
    request<any>(
      '/api/usage/report/image',
      { method: 'POST', body: JSON.stringify({ model, image_count }) },
      true
    ).then(normalizeUsageReport),

  // V3.0.6：Agent 对话全面 BYOK，服务器 Agent/Chat/Tool 用量上报端点已移除；
  // 仅图片生成（CyImagePro 图片服务）保留 estimate + report 闭环。

  estimateUsage: (items: UsageEstimateItem[]) =>
    request<any>(
      '/api/usage/estimate',
      { method: 'POST', body: JSON.stringify({ items }) },
      true
    ).then(normalizeEstimate),

  getPackages: () => request<PackagesResponse>('/api/pay/packages'),

  createOrder: (items: OrderItem[]) =>
    request<OrderResult>(
      '/api/pay/create_order',
      { method: 'POST', body: JSON.stringify({ items }) },
      true
    ),

  closeOrder: (out_trade_no: string) =>
    request<{ status: string; out_trade_no: string }>(
      `/api/pay/close/${out_trade_no}`,
      { method: 'POST' },
      true
    ),

  refundOrder: (out_trade_no: string) =>
    request<{ status: string; out_trade_no: string; message: string }>(
      `/api/pay/refund_order/${out_trade_no}`,
      { method: 'POST' },
      true
    ),

  refundStatus: (out_trade_no: string) =>
    request<{ status: string; out_refund_no: string | null; amount_cny: number }>(
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

  getPrompts: () => request<PromptsResponse>('/api/prompts'),

  getStock: () =>
    request<Record<string, number>>('/api/tokens/stock'),

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
