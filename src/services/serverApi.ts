const SERVER_BASE = 'https://www.zjcypc.com';

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

export interface OrderResult {
  out_trade_no: string;
  code_url: string;
  amount_cny: number;
  exchange_rate: number;
  amount_usd: number;
  group: string;
  status?: 'pending' | 'paid' | 'closed';
}

export interface OrderStatus {
  out_trade_no: string;
  status: 'pending' | 'paid' | 'closed';
  amount_usd: number;
  amount_cny: number;
  group: string;
  paid_at: string | null;
  api_token?: string | null;
}

export interface PackageGroup {
  name: string;
  description?: string;
}

export interface PackagesResponse {
  exchange_rate: number;
  groups: PackageGroup[];
}

export interface ServerModel {
  name: string;
  display_name: string;
  model_type: 'image' | 'chat';
  trial_allowed: boolean;
  group?: string | null;
  price_per_image?: string;
  price_input_per_m?: string;
  price_output_per_m?: string;
  price_cached_per_m?: string;
}

export interface ServerPrompt {
  id: string;
  category: string;
  title: string;
  content: string;
}

function getBase(): string {
  return SERVER_BASE;
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
  const base = getBase();
  if (!base) throw new Error('未配置服务器地址');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  if (auth) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${base}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err: any = new Error(body.detail || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// 把后端返回的 user 原始结构标准化为客户端 UserInfo
// 兼容两种字段命名：balance_usd / image_balance_usd
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

  getPackages: () => request<PackagesResponse>('/api/pay/packages'),

  createOrder: (group: string, amount_usd: number, pay_type: string = 'wxpay') =>
    request<OrderResult>(
      '/api/pay/create_order',
      { method: 'POST', body: JSON.stringify({ group, amount_usd, pay_type }) },
      true
    ),

  closeOrder: (out_trade_no: string) =>
    request<{ status: string; out_trade_no: string }>(
      `/api/pay/close/${out_trade_no}`,
      { method: 'POST' },
      true
    ),

  queryOrder: (out_trade_no: string) =>
    request<OrderStatus>(`/api/pay/query/${out_trade_no}`, {}, true),

  getNotice: () => request<{ content: string; is_active: boolean }>('/api/notice'),

  getModels: () => request<ServerModel[]>('/api/models', {}, true),

  getTrialStock: () =>
    request<{ remaining: number; available: boolean }>('/api/tokens/trial-stock'),

  getPrompts: () => request<ServerPrompt[]>('/api/prompts'),
};
