import { useSettingsStore } from '../store/useSettingsStore';

const DEFAULT_SERVER_BASE = 'https://www.zjcypc.com';
const DIRECT_SERVER_BASE = 'http://124.221.205.221';

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
  total_usd: number;
  total_cny: number;
  status: 'pending' | 'paid' | 'assigned' | 'allocated' | 'refunding' | 'refunded' | 'refund_change' | 'closed';
  items: { group: string; amount_usd: number }[];
  created_at: string;
  paid_at?: string;
  allocated_at?: string;
  amount_cny?: number;
  amount_usd?: number;
}

export interface UsageRecord {
  model: string;
  type: string;
  quantity: number;
  cost_usd: number;
  created_at: string;
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
}

export interface ServerPrompt {
  id: string;
  category: string;
  title: string;
  content: string;
}

export interface UsageEstimateItem {
  type: 'agent' | 'image' | 'postprocess' | 'chat';
  model?: string;
  tool?: string;
  quantity?: number;
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

function normalizeBaseUrl(value?: string | null): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return DEFAULT_SERVER_BASE;
  return trimmed.replace(/\/+$/, '');
}

function getBaseCandidates(): string[] {
  const configured = normalizeBaseUrl(useSettingsStore.getState().settings.server_url);
  const candidates = [configured];

  try {
    const parsed = new URL(configured);
    if (parsed.hostname === 'www.zjcypc.com') {
      candidates.push(`${parsed.protocol}//zjcypc.com`);
      candidates.push(DIRECT_SERVER_BASE);
    } else if (parsed.hostname === 'zjcypc.com') {
      candidates.push(`${parsed.protocol}//www.zjcypc.com`);
      candidates.push(DIRECT_SERVER_BASE);
    } else if (parsed.hostname === '124.221.205.221') {
      candidates.push(DEFAULT_SERVER_BASE);
      candidates.push('https://zjcypc.com');
    }
  } catch {
    candidates.push(DEFAULT_SERVER_BASE);
    candidates.push('https://zjcypc.com');
    candidates.push(DIRECT_SERVER_BASE);
  }

  return [...new Set(candidates.map(normalizeBaseUrl).filter(Boolean))];
}

function getToken(): string | null {
  try {
    return localStorage.getItem('cy_jwt');
  } catch {
    return null;
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  auth = false
): Promise<T> {
  const bases = getBaseCandidates();
  if (bases.length === 0) throw new Error('Server base URL is not configured');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  if (auth) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  let lastError: any = null;

  for (const base of bases) {
    try {
      const res = await fetch(`${base}${path}`, { ...options, headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err: any = new Error(body.detail || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    } catch (err: any) {
      lastError = err;
      const isNetworkError =
        err?.name === 'TypeError' ||
        /Failed to fetch|NetworkError|Load failed|network|fetch/i.test(err?.message || '');
      if (!isNetworkError || base === bases[bases.length - 1]) {
        throw err;
      }
    }
  }

  throw lastError || new Error('Request failed');
}

// ?????? user ??????????? UserInfo
// ?????????balance_usd / image_balance_usd
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

  getUsage: () =>
    request<any[]>('/api/users/me/usage', {}, true),

  reportImage: (model: string, image_count: number) =>
    request<{ cost_usd: number; balance_usd: number; group?: string; account_type?: 'trial' | 'normal' | 'paid' }>(
      '/api/usage/report/image',
      { method: 'POST', body: JSON.stringify({ model, image_count }) },
      true
    ),

  reportChat: (model: string, input_tokens: number, output_tokens: number, cached_tokens: number) =>
    request<{ cost_usd: number; balance_usd: number; group?: string; account_type?: 'trial' | 'normal' | 'paid' }>(
      '/api/usage/report/chat',
      { method: 'POST', body: JSON.stringify({ model, input_tokens, output_tokens, cached_tokens }) },
      true
    ),

  estimateUsage: (items: UsageEstimateItem[]) =>
    request<UsageEstimate>(
      '/api/usage/estimate',
      { method: 'POST', body: JSON.stringify({ items }) },
      true
    ),

  reportAgent: (model: string, input_tokens: number, output_tokens: number, cached_tokens: number, request_id?: string) =>
    request<{ cost_usd: number; balance_usd: number; group?: string; account_type?: 'trial' | 'normal' | 'paid' }>(
      '/api/usage/report/agent',
      { method: 'POST', body: JSON.stringify({ model, input_tokens, output_tokens, cached_tokens, request_id }) },
      true
    ),

  reportTool: (tool: string, quantity: number, tool_call_id: string) =>
    request<{ cost_usd: number; balance_usd: number; group?: string; account_type?: 'trial' | 'normal' | 'paid' }>(
      '/api/usage/report/tool',
      { method: 'POST', body: JSON.stringify({ tool, quantity, tool_call_id }) },
      true
    ),

  getPackages: () => request<PackagesResponse>('/api/pay/packages'),

  createOrder: (items: OrderItem[], pay_type: string = 'wxpay') =>
    request<OrderResult>(
      '/api/pay/create_order',
      { method: 'POST', body: JSON.stringify({ items, pay_type }) },
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

  getUsageRecords: () =>
    request<UsageRecord[]>('/api/usage/records', {}, true),

  getNotice: () => request<{ content: string; is_active: boolean }>('/api/notice'),

  getModels: () => request<ServerModel[]>('/api/models', {}, true),

  getTrialStock: () =>
    request<{ remaining: number; available: boolean }>('/api/tokens/trial-stock'),

  getPrompts: () => request<ServerPrompt[]>('/api/prompts'),

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
