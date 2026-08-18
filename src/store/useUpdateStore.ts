import { create } from 'zustand';
import {
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  restartApp,
  fetchRecentReleases,
  describeUpdateError,
  type Update,
} from '../services/updateService';

export interface ReleaseNote {
  version: string;
  date: string;
  notes: string;
}

/**
 * 更新状态机（互斥 phase）：
 *   idle               尚未执行过检查
 *   checking           检查中
 *   update_available   updater 确认存在更高版本
 *   latest             updater 正常响应且确认已是最新
 *   check_failed       updater 请求/解析失败（绝不视为 latest）
 *   downloading        正在下载更新包
 *   download_failed    下载失败（版本发现已成功，保留 updateInfo/changelog 可重试）
 *   restart_required   下载完成，等待用户确认重启安装
 *   installing         正在安装（随后自动重启）
 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'update_available'
  | 'latest'
  | 'check_failed'
  | 'downloading'
  | 'download_failed'
  | 'restart_required'
  | 'installing';

export interface UpdateStatus {
  phase: UpdatePhase;
  /** updater 明确返回的最新版本号（update_available 时必有）；latest/failed 时可能为 null */
  latestVersion: string | null;
  /** phase 为 check_failed / 下载安装失败时的用户可读错误信息 */
  error: string | null;
  lastCheckedAt: number | null;
  downloaded: number;
  contentLength: number;
  updateInfo: Update | null;
  showChangelog: boolean;
  recentReleases: ReleaseNote[];
}

interface UpdateState {
  status: UpdateStatus;
  /** 检查更新。force=false 且已检查过时跳过；checking/downloading/installing 期间不重入。 */
  checkUpdate: (force?: boolean) => Promise<void>;
  /** 下载更新包（不安装），完成后进入 restart_required；update_available/download_failed 状态可调用（失败重试）。 */
  applyUpdate: () => Promise<void>;
  /** 安装已下载的更新并重启应用。 */
  installAndRestart: () => Promise<void>;
  openChangelog: () => void;
  closeChangelog: () => void;
  reset: () => void;
}

const initialStatus: UpdateStatus = {
  phase: 'idle',
  latestVersion: null,
  error: null,
  lastCheckedAt: null,
  downloaded: 0,
  contentLength: 0,
  updateInfo: null,
  showChangelog: false,
  recentReleases: [],
};

function isBusy(status: UpdateStatus): boolean {
  return status.phase === 'checking' || status.phase === 'downloading' || status.phase === 'installing';
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: { ...initialStatus },

  checkUpdate: async (force = false) => {
    const { status } = get();
    // 检查/下载/安装期间禁止重入（按钮防连点、自动+手动并发均由此拦截）
    if (isBusy(status)) return;
    // 已完成过检查且非强制刷新则跳过（自动检查 + 手动检查共用一份结果）
    if (status.lastCheckedAt !== null && !force) return;

    set({ status: { ...status, phase: 'checking', error: null } });

    // changelog 与 updater 是两条独立链路：changelog 失败绝不影响 updater 判定，反之亦然。
    const releasesPromise: Promise<ReleaseNote[] | null> = fetchRecentReleases().catch(() => null);

    let update: Update | null = null;
    let checkError: string | null = null;
    try {
      update = await checkForUpdate();
    } catch (e) {
      // updater 异常必须显式进入 check_failed，禁止当作“已是最新”
      checkError = describeUpdateError(e);
    }

    const releases = await releasesPromise;
    const recentReleases = releases ?? get().status.recentReleases;
    const lastCheckedAt = Date.now();

    if (checkError !== null) {
      set({
        status: {
          ...get().status,
          phase: 'check_failed',
          error: checkError,
          lastCheckedAt,
          latestVersion: null,
          updateInfo: null,
          recentReleases,
        },
      });
    } else if (update) {
      set({
        status: {
          ...get().status,
          phase: 'update_available',
          error: null,
          lastCheckedAt,
          latestVersion: update.version,
          updateInfo: update,
          downloaded: 0,
          contentLength: 0,
          recentReleases,
        },
      });
    } else {
      set({
        status: {
          ...get().status,
          phase: 'latest',
          error: null,
          lastCheckedAt,
          latestVersion: null,
          updateInfo: null,
          recentReleases,
        },
      });
    }
  },

  applyUpdate: async () => {
    const { status } = get();
    if (!status.updateInfo || (status.phase !== 'update_available' && status.phase !== 'download_failed')) return;

    set({ status: { ...status, phase: 'downloading', error: null, downloaded: 0, contentLength: 0 } });
    try {
      await downloadUpdate(status.updateInfo, (downloaded, contentLength) => {
        set(s => ({ status: { ...s.status, downloaded, contentLength } }));
      });
      set(s => ({ status: { ...s.status, phase: 'restart_required' } }));
    } catch (e) {
      // 下载失败：版本发现已成功，进入 download_failed（区别于 check_failed），
      // 保留 updateInfo 与 changelog，允许用户重试
      set(s => ({ status: { ...s.status, phase: 'download_failed', error: describeUpdateError(e, 'download') } }));
    }
  },

  installAndRestart: async () => {
    const { status } = get();
    if (!status.updateInfo || status.phase !== 'restart_required') return;

    set(s => ({ status: { ...s.status, phase: 'installing', error: null } }));
    try {
      await installUpdate(status.updateInfo);
    } catch (e) {
      // 安装失败：回到 update_available 重新下载重试
      set(s => ({ status: { ...s.status, phase: 'update_available', error: describeUpdateError(e, 'install') } }));
      return;
    }
    try {
      await restartApp();
    } catch {
      // 安装器可能已接管进程导致 relaunch 失败，忽略即可
    }
  },

  openChangelog: () => set(s => ({ status: { ...s.status, showChangelog: true } })),
  closeChangelog: () => set(s => ({ status: { ...s.status, showChangelog: false } })),
  reset: () => set(s => ({ status: { ...s.status, phase: 'idle', latestVersion: null, error: null, updateInfo: null, showChangelog: false } })),
}));
