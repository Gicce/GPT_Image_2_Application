import { create } from 'zustand';
import type { UserInfo } from '../services/serverApi';
import { serverApi } from '../services/serverApi';

interface AuthState {
  jwt: string | null;
  user: UserInfo | null;
  isLoggedIn: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string, account_type?: 'trial' | 'paid') => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
  updateBalance: (balance_usd: number) => void;
  updateApiToken: (api_token: string) => void;
  loadFromStorage: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  jwt: null,
  user: null,
  isLoggedIn: false,

  loadFromStorage: () => {
    try {
      const jwt = localStorage.getItem('cy_jwt');
      const raw = localStorage.getItem('cy_user');
      if (jwt && raw) {
        set({ jwt, user: JSON.parse(raw), isLoggedIn: true });
      }
    } catch {}
  },

  login: async (username, password) => {
    const res = await serverApi.login(username, password);
    localStorage.setItem('cy_jwt', res.access_token);
    localStorage.setItem('cy_user', JSON.stringify(res.user));
    set({ jwt: res.access_token, user: res.user, isLoggedIn: true });
  },

  register: async (username, email, password, account_type = 'trial') => {
    const res = await serverApi.register(username, email, password, account_type);
    localStorage.setItem('cy_jwt', res.access_token);
    localStorage.setItem('cy_user', JSON.stringify(res.user));
    set({ jwt: res.access_token, user: res.user, isLoggedIn: true });
  },

  logout: () => {
    localStorage.removeItem('cy_jwt');
    localStorage.removeItem('cy_user');
    set({ jwt: null, user: null, isLoggedIn: false });
  },

  refreshUser: async () => {
    try {
      const user = await serverApi.getMe();
      localStorage.setItem('cy_user', JSON.stringify(user));
      set({ user });
    } catch (e: any) {
      if (e.status === 401) get().logout();
    }
  },

  updateBalance: (balance_usd) => {
    const user = get().user;
    if (!user) return;
    const updated = { ...user, balance_usd };
    localStorage.setItem('cy_user', JSON.stringify(updated));
    set({ user: updated });
  },

  updateApiToken: (api_token) => {
    const user = get().user;
    if (!user) return;
    const updated = { ...user, api_token };
    localStorage.setItem('cy_user', JSON.stringify(updated));
    set({ user: updated });
  },
}));
