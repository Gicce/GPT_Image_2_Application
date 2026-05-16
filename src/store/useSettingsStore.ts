import { create } from 'zustand';
import type { Settings } from '../types';
import { api } from '../services/api';

interface SettingsState {
  settings: Settings;
  loading: boolean;
  loadSettings: () => Promise<void>;
  saveSettings: (partial: Partial<Settings>) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: {
    token: '',
    default_size: '1024x1024',
    default_quality: 'standard',
    default_format: 'png',
    default_output_dir: '',
    chat_token: '',
    chat_model: 'gpt-4o',
    chat_base_url: 'https://www.packyapi.com/v1',
    chat_system_prompt: '',
    server_url: 'https://www.zjcypc.com',
    notice_enabled: true,
    theme: 'system',
  },
  loading: false,

  loadSettings: async () => {
    set({ loading: true });
    try {
      const settings = await api.getSettings();
      // 兼容旧配置：缺失字段用默认值兜底
      const merged = { ...get().settings, ...settings };
      if (merged.notice_enabled === undefined) merged.notice_enabled = true;
      if (!merged.theme) merged.theme = 'system';
      set({ settings: merged, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  saveSettings: async (partial) => {
    const current = get().settings;
    const updated = { ...current, ...partial };
    await api.saveSettings(updated);
    set({ settings: updated });
  },
}));
