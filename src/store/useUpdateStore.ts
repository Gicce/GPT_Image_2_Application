import { create } from 'zustand';
import { checkForUpdate, downloadAndInstallUpdate, restartApp } from '../services/updateService';
import type { Update } from '@tauri-apps/plugin-updater';

export interface UpdateStatus {
  checking: boolean;
  updateAvailable: boolean;
  downloading: boolean;
  downloaded: number;
  contentLength: number;
  installing: boolean;
  error: string | null;
  updateInfo: Update | null;
}

interface UpdateState {
  status: UpdateStatus;
  checkUpdate: () => Promise<void>;
  applyUpdate: () => Promise<void>;
  reset: () => void;
}

const initialStatus: UpdateStatus = {
  checking: false,
  updateAvailable: false,
  downloading: false,
  downloaded: 0,
  contentLength: 0,
  installing: false,
  error: null,
  updateInfo: null,
};

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: { ...initialStatus },

  checkUpdate: async () => {
    set({ status: { ...initialStatus, checking: true } });
    try {
      const update = await checkForUpdate();
      if (update) {
        set({ status: { ...initialStatus, updateAvailable: true, updateInfo: update } });
      } else {
        set({ status: { ...initialStatus } });
      }
    } catch (e: any) {
      set({ status: { ...initialStatus, error: e?.toString() || '检查更新失败' } });
    }
  },

  applyUpdate: async () => {
    const { status } = get();
    if (!status.updateInfo) return;

    set({ status: { ...status, downloading: true } });
    try {
      await downloadAndInstallUpdate(status.updateInfo, (downloaded, contentLength) => {
        set(s => ({ status: { ...s.status, downloaded, contentLength } }));
      });
      set({ status: { ...get().status, downloading: false, installing: true } });
    } catch (e: any) {
      set({ status: { ...get().status, downloading: false, error: e?.toString() || '更新失败' } });
    }
  },

  reset: () => set({ status: { ...initialStatus } }),
}));
