import { useSettingsStore } from '../store/useSettingsStore';

export interface UserInfo {
  id: string;
  username: string;
  email: string;
  account_type: 'trial' | 'paid';
  balance_usd: number;
  api_token: string;
  trial_expires_at: string | null;
  trial_expired: boolean;
}

export interface AuthResponse {
  access_token: string;
  token_type: string;
  user: UserInfo;
}

export interface Package {
  package_usd: number;
  name: string;
  price_cny: number;
  exchange_rate: number;
}

export interface OrderResult {
  out_trade_no: string;
  amount_cny: number;
  exchange_rate: number;
  pay_type: string;
  pay_info: string;
  package_usd: number;
}

export interface OrderStatus {
  out_trade_no: string;
  status: 'pending' | 'paid';
  package_usd: number;
  amount_cny: number;
  paid_at: string | null;
  api_token?: string;
}

export interface ServerModel {
  name: string;
  display_name: string;
  model_type: 'image' | 'chat';
  trial_allowed: boolean;
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
  const url = useSettingsStore.getState().settings.server_url;
  return url.replace(/\/$/, '');
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

export const serverApi = {
  register: (username: string, email: string, password: string) =>
    request<AuthResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password }),
    }),

  login: (username: string, password: string) =>
    request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  getMe: () => request<UserInfo>('/api/users/me', {}, true),

  getUsage: () =>
    request<any[]>('/api/users/me/usage', {}, true),

  reportImage: (model: string, image_count: number) =>
    request<{ cost_usd: number; balance_usd: number }>(
      '/api/usage/report/image',
      { method: 'POST', body: JSON.stringify({ model, image_count }) },
      true
    ),

  reportChat: (model: string, input_tokens: number, output_tokens: number, cached_tokens: number) =>
    request<{ cost_usd: number; balance_usd: number }>(
      '/api/usage/report/chat',
      { method: 'POST', body: JSON.stringify({ model, input_tokens, output_tokens, cached_tokens }) },
      true
    ),

  getPackages: () => request<Package[]>('/api/pay/packages'),

  createOrder: (package_usd: number, pay_type: string, client_ip: string) =>
    request<OrderResult>(
      '/api/pay/create_order',
      { method: 'POST', body: JSON.stringify({ package_usd, pay_type, client_ip }) },
      true
    ),

  queryOrder: (out_trade_no: string) =>
    request<OrderStatus>(`/api/pay/query/${out_trade_no}`, {}, true),

  getNotice: () => request<{ content: string; is_active: boolean }>('/api/notice'),

  getModels: () => request<ServerModel[]>('/api/models'),

  getPrompts: () => request<ServerPrompt[]>('/api/prompts'),
};
