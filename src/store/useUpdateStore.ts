import { create } from 'zustand';
import { checkForUpdate, downloadAndInstallUpdate, fetchRecentReleases } from '../services/updateService';
import type { Update } from '@tauri-apps/plugin-updater';

export interface ReleaseNote {
  version: string;
  date: string;
  notes: string;
}

export interface UpdateStatus {
  checking: boolean;
  updateAvailable: boolean;
  downloading: boolean;
  downloaded: number;
  contentLength: number;
  installing: boolean;
  error: string | null;
  updateInfo: Update | null;
  showChangelog: boolean;
  recentReleases: ReleaseNote[];
}

interface UpdateState {
  status: UpdateStatus;
  checkUpdate: () => Promise<void>;
  applyUpdate: () => Promise<void>;
  openChangelog: () => void;
  closeChangelog: () => void;
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
  showChangelog: false,
  recentReleases: [],
};

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: { ...initialStatus },

  checkUpdate: async () => {
    set({ status: { ...initialStatus, checking: true } });

    // 两个请求独立执行，互不影响
    const [updateResult, releases] = await Promise.allSettled([
      checkForUpdate(),
      fetchRecentReleases(),
    ]);

    const update = updateResult.status === 'fulfilled' ? updateResult.value : null;
    const releaseList = releases.status === 'fulfilled' ? releases.value : [];

    if (update) {
      set({ status: { ...initialStatus, updateAvailable: true, updateInfo: update, recentReleases: releaseList } });
    } else {
      set({ status: { ...initialStatus, recentReleases: releaseList } });
    }
  },

  applyUpdate: async () => {
    const { status } = get();
    if (!status.updateInfo) return;
    set({ status: { ...status, downloading: true, showChangelog: false } });
    try {
      await downloadAndInstallUpdate(status.updateInfo, (downloaded, contentLength) => {
        set(s => ({ status: { ...s.status, downloaded, contentLength } }));
      });
      set({ status: { ...get().status, downloading: false, installing: true } });
    } catch (e: any) {
      set({ status: { ...get().status, downloading: false, error: e?.toString() || '更新失败' } });
    }
  },

  openChangelog: () => set(s => ({ status: { ...s.status, showChangelog: true } })),
  closeChangelog: () => set(s => ({ status: { ...s.status, showChangelog: false } })),
  reset: () => set({ status: { ...get().status, updateAvailable: false, updateInfo: null, showChangelog: false } }),
}));
