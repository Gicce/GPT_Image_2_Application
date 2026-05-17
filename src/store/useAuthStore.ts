import { create } from 'zustand';
import type { UserInfo, UserToken } from '../services/serverApi';
import { serverApi } from '../services/serverApi';
import { useSettingsStore } from './useSettingsStore';

// 全局缓存：group → model_type 的映射，由首次成功的 getModels 调用填充
let groupTypeMap: Record<string, 'image' | 'chat'> = {};
export function setGroupTypeMap(map: Record<string, 'image' | 'chat'>) {
  groupTypeMap = { ...groupTypeMap, ...map };
  // 立刻同步一次
  const u = useAuthStore.getState().user;
  if (u) syncTokensToSettings(u);
}

export function getGroupTypeMap() {
  return groupTypeMap;
}

export function isGroupTypeMapReady(): boolean {
  return Object.keys(groupTypeMap).length > 0;
}

export function isImageGroup(group: string): boolean {
  if (group in groupTypeMap) return groupTypeMap[group] === 'image';
  // groupTypeMap 非空但该 group 不在其中：保守归为 chat
  if (Object.keys(groupTypeMap).length > 0) return false;
  // groupTypeMap 为空（loadModels 未完成）：用正则兜底（仅用于显示，syncTokensToSettings 不依赖此路径）
  return /sora|gpt-?image/i.test(group);
}

// 把后端下发的 token 自动同步到本地 settings，让 Rust 端能读
function syncTokensToSettings(user: UserInfo | null) {
  if (!user) return;
  // groupTypeMap 未填充时不做同步，避免用正则猜测导致 token 分配错误
  // setGroupTypeMap() 填充后会再次调用此函数
  if (Object.keys(groupTypeMap).length === 0) return;

  const settings = useSettingsStore.getState().settings;
  const partial: any = {};
  // 直接用 groupTypeMap 做精确匹配，不再依赖 isImageGroup()
  const imageToken = user.tokens.find(t => groupTypeMap[t.group] === 'image')?.api_token ?? '';
  const chatToken = user.tokens.find(t => groupTypeMap[t.group] === 'chat')?.api_token ?? '';
  if (settings.token !== imageToken) partial.token = imageToken;
  if (settings.chat_token !== chatToken) partial.chat_token = chatToken;
  if (Object.keys(partial).length > 0) {
    useSettingsStore.getState().saveSettings(partial);
  }
}

// 重新规范化（兼容老 localStorage 格式：检测到无 tokens 字段直接清空，强制重新登录）
function normalizeStored(raw: any): UserInfo | null {
  if (!raw || !Array.isArray(raw.tokens)) return null;
  const tokens: UserToken[] = raw.tokens.map((t: any) => ({
    group: t.group,
    balance_usd: Number(t.balance_usd ?? 0),
    api_token: t.api_token ?? '',
    is_trial: !!t.is_trial,
  }));
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

interface AuthState {
  jwt: string | null;
  user: UserInfo | null;
  isLoggedIn: boolean;
  authPromptVisible: boolean;
  requestedPage: string | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string, account_type?: 'trial' | 'normal') => Promise<void>;
  registerSendCode: (username: string, email: string, password: string, account_type?: 'trial' | 'normal') => Promise<void>;
  registerVerify: (email: string, code: string, username: string, password: string, account_type?: 'trial' | 'normal') => Promise<void>;
  upgradeTrial: () => Promise<void>;
  logout: () => void;
  showAuthPrompt: () => void;
  hideAuthPrompt: () => void;
  setRequestedPage: (page: string) => void;
  clearRequestedPage: () => void;
  refreshUser: () => Promise<void>;
  updateAccountType: (account_type: 'trial' | 'normal' | 'paid') => void;
  updateTokenBalance: (group: string, balance_usd: number) => void;
  setUserTokens: (tokens: UserToken[]) => void;
  loadFromStorage: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  jwt: null,
  user: null,
  isLoggedIn: false,
  authPromptVisible: false,
  requestedPage: null,

  loadFromStorage: () => {
    try {
      const jwt = localStorage.getItem('cy_jwt');
      const raw = localStorage.getItem('cy_user');
      if (jwt && raw) {
        const user = normalizeStored(JSON.parse(raw));
        if (!user) {
          // 老格式不兼容，清掉强制重新登录
          localStorage.removeItem('cy_jwt');
          localStorage.removeItem('cy_user');
          return;
        }
        set({ jwt, user, isLoggedIn: true });
        syncTokensToSettings(user);
      }
    } catch {}
  },

  login: async (username, password) => {
    const res = await serverApi.login(username, password);
    localStorage.setItem('cy_jwt', res.access_token);
    localStorage.setItem('cy_user', JSON.stringify(res.user));
    set({ jwt: res.access_token, user: res.user, isLoggedIn: true });
    syncTokensToSettings(res.user);
  },

  register: async (username, email, password, account_type = 'trial') => {
    const res = await serverApi.register(username, email, password, account_type);
    localStorage.setItem('cy_jwt', res.access_token);
    localStorage.setItem('cy_user', JSON.stringify(res.user));
    set({ jwt: res.access_token, user: res.user, isLoggedIn: true });
    syncTokensToSettings(res.user);
  },

  registerSendCode: async (username, email, password, account_type = 'normal') => {
    await serverApi.registerSendCode(username, email, password, account_type);
  },

  registerVerify: async (email, code, username, password, account_type = 'normal') => {
    const res = await serverApi.registerVerify(email, code, username, password, account_type);
    localStorage.setItem('cy_jwt', res.access_token);
    localStorage.setItem('cy_user', JSON.stringify(res.user));
    set({ jwt: res.access_token, user: res.user, isLoggedIn: true });
    syncTokensToSettings(res.user);
  },

  upgradeTrial: async () => {
    const updated = await serverApi.upgradeTrial();
    localStorage.setItem('cy_user', JSON.stringify(updated));
    set({ user: updated });
    syncTokensToSettings(updated);
  },

  logout: () => {
    localStorage.removeItem('cy_jwt');
    localStorage.removeItem('cy_user');
    set({ jwt: null, user: null, isLoggedIn: false });
  },

  showAuthPrompt: () => set({ authPromptVisible: true }),
  hideAuthPrompt: () => set({ authPromptVisible: false }),

  setRequestedPage: (page) => set({ requestedPage: page }),
  clearRequestedPage: () => set({ requestedPage: null }),

  refreshUser: async () => {
    try {
      const user = await serverApi.getMe();
      localStorage.setItem('cy_user', JSON.stringify(user));
      set({ user });
      syncTokensToSettings(user);
    } catch (e: any) {
      if (e.status === 401) get().logout();
    }
  },

  updateAccountType: (account_type) => {
    const user = get().user;
    if (!user || user.account_type === account_type) return;
    const updated = { ...user, account_type };
    localStorage.setItem('cy_user', JSON.stringify(updated));
    set({ user: updated });
  },

  updateTokenBalance: (group, balance_usd) => {
    const user = get().user;
    if (!user) return;
    const tokens = user.tokens.map(t => t.group === group ? { ...t, balance_usd } : t);
    const updated = { ...user, tokens };
    localStorage.setItem('cy_user', JSON.stringify(updated));
    set({ user: updated });
  },

  setUserTokens: (tokens) => {
    const user = get().user;
    if (!user) return;
    const updated = { ...user, tokens };
    localStorage.setItem('cy_user', JSON.stringify(updated));
    set({ user: updated });
    syncTokensToSettings(updated);
  },
}));
