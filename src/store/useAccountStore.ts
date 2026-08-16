import { create } from 'zustand';
import { serverApi, type AccountEntitlements } from '../services/serverApi';
import { useAuthStore } from './useAuthStore';

export interface AccountEntitlementState {
  // 权益数据
  balances: Record<string, number>;  // { "image": 3.0, "agent": 3.0, "postprocess": 0.0 }
  enabledFeatures: Record<string, boolean>;  // { "image": true, "agent": true, "postprocess": false }
  enabledModels: Record<string, string[]>;  // { "image": ["gpt-image-2"], "agent": ["gpt-4o"] }

  // 加载状态
  loading: boolean;
  error: string | null;
  lastFetched: number | null;

  // 方法
  fetchEntitlements: () => Promise<void>;
  clearEntitlements: () => void;

  // 便捷方法
  getFeatureStatus: (feature: 'image' | 'agent' | 'postprocess') => {
    enabled: boolean;
    balance: number;
    hasBalance: boolean;
    statusText: string;
  };
}

export const useAccountStore = create<AccountEntitlementState>((set, get) => ({
  balances: {},
  enabledFeatures: {},
  enabledModels: {},
  loading: false,
  error: null,
  lastFetched: null,

  fetchEntitlements: async () => {
    const { isLoggedIn } = useAuthStore.getState();
    if (!isLoggedIn) {
      set({
        balances: {},
        enabledFeatures: {},
        enabledModels: {},
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
        balances: data.balances || {},
        enabledFeatures: data.enabled_features || {},
        enabledModels: data.enabled_models || {},
        loading: false,
        error: null,
        lastFetched: Date.now(),
      });

      // 调试日志
      console.log('[account] 权益数据已更新:', {
        balances: data.balances,
        enabledFeatures: data.enabled_features,
        enabledModels: data.enabled_models,
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
      balances: {},
      enabledFeatures: {},
      enabledModels: {},
      loading: false,
      error: null,
      lastFetched: null,
    });
  },

  getFeatureStatus: (feature: 'image' | 'agent' | 'postprocess') => {
    const state = get();
    const enabled = state.enabledFeatures[feature] ?? false;
    const balance = state.balances[feature] ?? 0;
    const hasBalance = balance > 0;

    let statusText = '';
    if (!enabled) {
      statusText = '未开通';
    } else if (!hasBalance) {
      statusText = '已开通，余额不足';
    } else {
      statusText = '已开通';
    }

    return { enabled, balance, hasBalance, statusText };
  },
}));
