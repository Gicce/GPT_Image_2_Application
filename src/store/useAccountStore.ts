import { create } from 'zustand';
import { serverApi, type AccountEntitlements } from '../services/serverApi';
import { useAuthStore } from './useAuthStore';

export interface AccountEntitlementState {
  /** 统一余额（字符串透传，展示时 parseFloat） */
  balanceUsd: string;
  trialCreditUsd: string;
  totalCreditUsd: string;
  enabledFeatures: Record<string, boolean>;  // { "image": true }
  enabledModels: string[];  // ["gpt-image-2"]

  loading: boolean;
  error: string | null;
  lastFetched: number | null;

  fetchEntitlements: () => Promise<void>;
  clearEntitlements: () => void;
}

export const useAccountStore = create<AccountEntitlementState>((set) => ({
  balanceUsd: '0',
  trialCreditUsd: '0',
  totalCreditUsd: '0',
  enabledFeatures: {},
  enabledModels: [],
  loading: false,
  error: null,
  lastFetched: null,

  fetchEntitlements: async () => {
    const { isLoggedIn } = useAuthStore.getState();
    if (!isLoggedIn) {
      set({
        balanceUsd: '0',
        trialCreditUsd: '0',
        totalCreditUsd: '0',
        enabledFeatures: {},
        enabledModels: [],
        loading: false,
        error: null,
        lastFetched: null,
      });
      return;
    }

    set({ loading: true, error: null });
    try {
      const data: AccountEntitlements = await serverApi.getAccountEntitlements();
      set({
        balanceUsd: data.balance_usd ?? '0',
        trialCreditUsd: data.trial_credit_usd ?? '0',
        totalCreditUsd: data.total_credit_usd ?? '0',
        enabledFeatures: data.enabled_features || {},
        enabledModels: Array.isArray(data.enabled_models) ? data.enabled_models : [],
        loading: false,
        error: null,
        lastFetched: Date.now(),
      });
    } catch (err: any) {
      console.error('[account] 获取权益失败:', err);
      set({
        loading: false,
        error: err?.message || '获取账户权益失败',
      });
    }
  },

  clearEntitlements: () => {
    set({
      balanceUsd: '0',
      trialCreditUsd: '0',
      totalCreditUsd: '0',
      enabledFeatures: {},
      enabledModels: [],
      loading: false,
      error: null,
      lastFetched: null,
    });
  },
}));
