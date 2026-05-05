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
  },
  loading: false,

  loadSettings: async () => {
    set({ loading: true });
    try {
      const settings = await api.getSettings();
      set({ settings, loading: false });
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
