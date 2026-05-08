import { create } from 'zustand';
import { checkForUpdate, downloadAndInstallUpdate, fetchRecentReleases } from '../services/updateService';
import type { Update } from '@tauri-apps/plugin-updater';

export interface ReleaseNote {
  version: string;
  date: string;
  notes: string;
}

export interface UpdateStatus {
  initialized: boolean;  // 是否已完成过一次检查
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
  checkUpdate: (force?: boolean) => Promise<void>;
  applyUpdate: () => Promise<void>;
  openChangelog: () => void;
  closeChangelog: () => void;
  reset: () => void;
}

const initialStatus: UpdateStatus = {
  initialized: false,
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

  checkUpdate: async (force = false) => {
    const { status } = get();

    // 已初始化且不是强制刷新则跳过
    if (status.initialized && !force) return;

    // 下载/安装中不打断
    if (status.downloading || status.installing) return;

    set({ status: { ...status, checking: true } });

    const [updateResult, releases] = await Promise.allSettled([
      checkForUpdate(),
      fetchRecentReleases(),
    ]);

    const update = updateResult.status === 'fulfilled' ? updateResult.value : null;
    const releaseList = releases.status === 'fulfilled' ? releases.value : get().status.recentReleases;

    if (update) {
      set({ status: { ...get().status, initialized: true, checking: false, updateAvailable: true, updateInfo: update, recentReleases: releaseList } });
    } else {
      set({ status: { ...get().status, initialized: true, checking: false, updateAvailable: false, updateInfo: null, recentReleases: releaseList } });
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
