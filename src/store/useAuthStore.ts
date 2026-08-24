import { create } from 'zustand';
import type { UserInfo } from '../services/serverApi';
import { serverApi } from '../services/serverApi';
import { clearRuntimeConfig } from '../services/runtimeTokenService';

// 全局缓存：group → model_type 的映射，由首次成功的 getModels 调用填充
let groupTypeMap: Record<string, 'image' | 'agent' | 'postprocess' | 'chat'> = {};
export function setGroupTypeMap(map: Record<string, 'image' | 'agent' | 'postprocess' | 'chat'>) {
  groupTypeMap = { ...groupTypeMap, ...map };
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
  // groupTypeMap 为空（loadModels 未完成）：用正则兜底（仅用于显示）
  return /sora|gpt-?image/i.test(group);
}

export function displayGroupType(group: string): 'image' | 'agent' | 'postprocess' {
  const mapped = groupTypeMap[group];
  if (mapped === 'image') return 'image';
  if (mapped === 'postprocess') return 'postprocess';
  return 'agent';
}

// V4 统一余额重构：user.tokens / api_token 已随服务端下线，旧 syncTokensToSettings
// 同步逻辑删除（登录态下的生图鉴权由 runtime-config 下发的 runtime token 负责）。

// 重新规范化（V4：统一余额字段；老 v3 存量用户缺 balance 字段时回落 '0'，
// 登录后 refreshUser 会立即以服务端数据覆盖）
function normalizeStored(raw: any): UserInfo | null {
  if (!raw || !raw.id || !raw.username) return null;
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

interface AuthState {
  jwt: string | null;
  user: UserInfo | null;
  isLoggedIn: boolean;
  /** 最近一次 refreshUser 是否失败（非 401）。账户页据此显示“加载失败”，绝不把失败静默显示为 $0 */
  refreshFailed: boolean;
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
  /** 以后端 authorize/settle/refresh 响应回写统一余额（字符串透传，客户端不累计） */
  updateBalances: (balanceUsd: string | number, trialCreditUsd: string | number | undefined | null, credits?: { paid?: number; trial?: number; gift?: number; total?: number }) => void;
  loadFromStorage: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  jwt: null,
  user: null,
  isLoggedIn: false,
  refreshFailed: false,
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
      }
    } catch {}
  },

  login: async (username, password) => {
    const res = await serverApi.login(username, password);
    localStorage.setItem('cy_jwt', res.access_token);
    localStorage.setItem('cy_user', JSON.stringify(res.user));
    set({ jwt: res.access_token, user: res.user, isLoggedIn: true, refreshFailed: false });
  },

  register: async (username, email, password, account_type = 'trial') => {
    const res = await serverApi.register(username, email, password, account_type);
    localStorage.setItem('cy_jwt', res.access_token);
    localStorage.setItem('cy_user', JSON.stringify(res.user));
    set({ jwt: res.access_token, user: res.user, isLoggedIn: true, refreshFailed: false });
  },

  registerSendCode: async (username, email, password, account_type = 'normal') => {
    await serverApi.registerSendCode(username, email, password, account_type);
  },

  registerVerify: async (email, code, username, password, account_type = 'normal') => {
    const res = await serverApi.registerVerify(email, code, username, password, account_type);
    localStorage.setItem('cy_jwt', res.access_token);
    localStorage.setItem('cy_user', JSON.stringify(res.user));
    set({ jwt: res.access_token, user: res.user, isLoggedIn: true, refreshFailed: false });
  },

  upgradeTrial: async () => {
    const updated = await serverApi.upgradeTrial();
    localStorage.setItem('cy_user', JSON.stringify(updated));
    set({ user: updated });
  },

  logout: () => {
    clearRuntimeConfig();
    localStorage.removeItem('cy_jwt');
    localStorage.removeItem('cy_user');
    set({ jwt: null, user: null, isLoggedIn: false, refreshFailed: false });
  },

  showAuthPrompt: () => set({ authPromptVisible: true }),
  hideAuthPrompt: () => set({ authPromptVisible: false }),

  setRequestedPage: (page) => set({ requestedPage: page }),
  clearRequestedPage: () => set({ requestedPage: null }),

  refreshUser: async () => {
    try {
      const user = await serverApi.getMe();
      localStorage.setItem('cy_user', JSON.stringify(user));
      set({ user, refreshFailed: false });
    } catch (e: any) {
      if (e.status === 401) {
        get().logout();
        return;
      }
      // 保留上一次的 user 数据（若有），但标记失败——UI 必须把“获取失败”与“余额为 0”区分开
      set({ refreshFailed: true });
    }
  },

  updateAccountType: (account_type) => {
    const user = get().user;
    if (!user || user.account_type === account_type) return;
    const updated = { ...user, account_type };
    localStorage.setItem('cy_user', JSON.stringify(updated));
    set({ user: updated });
  },

  updateBalances: (balanceUsd, trialCreditUsd, credits?: { paid?: number; trial?: number; gift?: number; total?: number }) => {
    const user = get().user;
    if (!user) return;
    const nextBalance = balanceUsd != null ? String(balanceUsd) : user.balance_usd;
    const nextTrial = trialCreditUsd != null ? String(trialCreditUsd) : user.trial_credit_usd;
    const paid = credits?.paid ?? user.paid_credits ?? 0;
    const trial = credits?.trial ?? user.trial_credits ?? 0;
    const gift = credits?.gift ?? user.gift_credits ?? 0;
    const total = credits?.total ?? (paid + trial + gift);
    if (
      user.balance_usd === nextBalance && user.trial_credit_usd === nextTrial
      && user.paid_credits === paid && user.trial_credits === trial
      && user.gift_credits === gift && user.total_credits === total
    ) return;
    const updated = { ...user, balance_usd: nextBalance, trial_credit_usd: nextTrial, paid_credits: paid, trial_credits: trial, gift_credits: gift, total_credits: total };
    localStorage.setItem('cy_user', JSON.stringify(updated));
    set({ user: updated });
  },
}));
