import { create } from 'zustand';
import type { Settings } from '../types';
import { api } from '../services/api';

interface SettingsState {
  settings: Settings;
  loading: boolean;
  saving: boolean;
  saveError: string | null;
  loadSettings: () => Promise<void>;
  saveSettings: (partial: Partial<Settings>) => Promise<void>;
}

const defaultSettings: Settings = {
  token: '',
  default_size: '1024x1024',
  default_quality: 'auto',
  default_format: 'png',
  default_output_dir: '',
  library_input_dir: '',
  agent_name: 'CyImage Agent',
  agent_token: '',
  agent_model: 'gpt-4o',
  agent_base_url: 'https://www.packyapi.com/v1',
  agent_system_prompt: '',
  agent_context_window: 32768,
  ai_avatar_data_url: '',
  user_avatar_data_url: '',
  removebg_api_key: '',
  upscale_provider: 'disabled',
  topaz_api_key: '',
  vision_model: 'gpt-4o',
  chat_token: '',
  chat_model: 'gpt-4o',
  chat_base_url: 'https://www.packyapi.com/v1',
  chat_system_prompt: '',
  server_url: 'https://www.zjcypc.com',
  notice_enabled: true,
  theme: 'system',
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: defaultSettings,
  loading: false,
  saving: false,
  saveError: null,

  loadSettings: async () => {
    set({ loading: true, saveError: null });
    try {
      const settings = await api.getSettings();
      const merged = normalizeSettings({ ...defaultSettings, ...settings });
      if (merged.default_quality === 'standard') merged.default_quality = 'auto';
      set({ settings: merged, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  saveSettings: async (partial) => {
    pendingSettingsSnapshot = normalizeSettings({ ...get().settings, ...partial });
    set({
      settings: pendingSettingsSnapshot,
      saving: true,
      saveError: null,
    });

    const saveVersion = ++issuedSettingsVersion;
    const result = await queueSettingsSave();

    if (!result.ok) {
      if (saveVersion >= persistedSettingsVersion) {
        set({ saving: false, saveError: result.error });
      }
      throw new Error(result.error);
    }
  },
}));

let pendingSettingsSnapshot: Settings | null = null;
let settingsSaveInFlight: Promise<void> | null = null;
let issuedSettingsVersion = 0;
let persistedSettingsVersion = 0;

function normalizeSettings(settings: Settings): Settings {
  const next = { ...settings };
  if (!next.agent_token && next.chat_token) next.agent_token = next.chat_token;
  if (!next.agent_model && next.chat_model) next.agent_model = next.chat_model;
  if (!next.chat_model && next.agent_model) next.chat_model = next.agent_model;
  if (!next.vision_model) next.vision_model = next.agent_model || next.chat_model || 'gpt-4o';
  if (!next.agent_base_url && next.chat_base_url) next.agent_base_url = next.chat_base_url;
  if (!next.chat_base_url && next.agent_base_url) next.chat_base_url = next.agent_base_url;
  if (!next.agent_system_prompt && next.chat_system_prompt) next.agent_system_prompt = next.chat_system_prompt;
  if (!next.chat_system_prompt && next.agent_system_prompt) next.chat_system_prompt = next.agent_system_prompt;
  return next;
}

async function queueSettingsSave(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!settingsSaveInFlight) {
    settingsSaveInFlight = (async () => {
      try {
        while (pendingSettingsSnapshot) {
          const snapshot = pendingSettingsSnapshot;
          pendingSettingsSnapshot = null;
          await api.saveSettings(snapshot);
          persistedSettingsVersion = issuedSettingsVersion;
          useSettingsStore.setState(state => ({
            settings: snapshot,
            saving: !!pendingSettingsSnapshot,
            saveError: null,
          }));
        }
      } finally {
        settingsSaveInFlight = null;
      }
    })();
  }

  try {
    await settingsSaveInFlight;
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : '设置保存失败';
    return { ok: false, error: message };
  }
}
