import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * 更新状态机回归测试。
 * 核心锁死项：updater check() 抛错必须进入 check_failed，
 * 严禁当作 latest（旧版 BUG：Promise.allSettled 把 rejected 吞成“已是最新”）。
 */

const checkForUpdateMock = vi.fn();
const fetchRecentReleasesMock = vi.fn();
const downloadUpdateMock = vi.fn();
const installUpdateMock = vi.fn();
const restartAppMock = vi.fn();
const describeUpdateErrorMock = vi.fn((e: unknown) => `err:${String(e)}`);

vi.mock('../../services/updateService', () => ({
  checkForUpdate: (...args: unknown[]) => checkForUpdateMock(...args),
  fetchRecentReleases: (...args: unknown[]) => fetchRecentReleasesMock(...args),
  downloadUpdate: (...args: unknown[]) => downloadUpdateMock(...args),
  installUpdate: (...args: unknown[]) => installUpdateMock(...args),
  restartApp: (...args: unknown[]) => restartAppMock(...args),
  describeUpdateError: (e: unknown) => describeUpdateErrorMock(e),
}));

import { useUpdateStore, type UpdateStatus } from '../useUpdateStore';

function makeUpdate(version: string) {
  return { version } as any;
}

function resetStore(overrides: Partial<UpdateStatus> = {}) {
  useUpdateStore.setState({
    status: {
      phase: 'idle',
      latestVersion: null,
      error: null,
      lastCheckedAt: null,
      downloaded: 0,
      contentLength: 0,
      updateInfo: null,
      showChangelog: false,
      recentReleases: [],
      ...overrides,
    },
  });
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise(r => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe('checkUpdate 状态判定', () => {
  it('installed 4.0.0 / latest 4.0.2 => update_available', async () => {
    checkForUpdateMock.mockResolvedValue(makeUpdate('4.0.2'));
    fetchRecentReleasesMock.mockResolvedValue([]);
    await useUpdateStore.getState().checkUpdate(true);
    await flush();
    const s = useUpdateStore.getState().status;
    expect(s.phase).toBe('update_available');
    expect(s.latestVersion).toBe('4.0.2');
    expect(s.updateInfo?.version).toBe('4.0.2');
    expect(s.error).toBeNull();
  });

  it('installed 4.0.2 / latest 4.0.2（updater 返回 null）=> latest', async () => {
    checkForUpdateMock.mockResolvedValue(null);
    fetchRecentReleasesMock.mockResolvedValue([]);
    await useUpdateStore.getState().checkUpdate(true);
    await flush();
    const s = useUpdateStore.getState().status;
    expect(s.phase).toBe('latest');
    expect(s.updateInfo).toBeNull();
    expect(s.error).toBeNull();
  });

  it('updater 网络错误 => check_failed（锁死：禁止 latest）', async () => {
    checkForUpdateMock.mockRejectedValue(new Error('network error'));
    fetchRecentReleasesMock.mockResolvedValue([]);
    await useUpdateStore.getState().checkUpdate(true);
    await flush();
    const s = useUpdateStore.getState().status;
    expect(s.phase).toBe('check_failed');
    expect(s.phase).not.toBe('latest');
    expect(s.error).toBeTruthy();
  });

  it('updater 404（latest.json 缺失，v4.0.1 实际场景）=> check_failed', async () => {
    checkForUpdateMock.mockRejectedValue(new Error('Failed to fetch latest.json (404)'));
    fetchRecentReleasesMock.mockResolvedValue([{ version: '4.0.1', date: '2026-08-17', notes: 'x' }]);
    await useUpdateStore.getState().checkUpdate(true);
    await flush();
    const s = useUpdateStore.getState().status;
    expect(s.phase).toBe('check_failed');
    expect(s.error).toBeTruthy();
    // changelog 独立链路：updater 失败但 changelog 数据照常展示
    expect(s.recentReleases).toHaveLength(1);
    expect(s.recentReleases[0].version).toBe('4.0.1');
  });

  it('updater 500 => check_failed', async () => {
    checkForUpdateMock.mockRejectedValue(new Error('HTTP 500'));
    await useUpdateStore.getState().checkUpdate(true);
    await flush();
    expect(useUpdateStore.getState().status.phase).toBe('check_failed');
  });

  it('updater 响应体非法 => check_failed', async () => {
    checkForUpdateMock.mockRejectedValue(new Error('invalid response'));
    await useUpdateStore.getState().checkUpdate(true);
    await flush();
    expect(useUpdateStore.getState().status.phase).toBe('check_failed');
  });

  it('updater 正常无更新（返回 null）且 changelog 拉取失败 => 仍为 latest，changelog 保持旧值', async () => {
    checkForUpdateMock.mockResolvedValue(null);
    fetchRecentReleasesMock.mockRejectedValue(new Error('github api down'));
    resetStore({ recentReleases: [{ version: '4.0.1', date: '2026-08-17', notes: 'old' }] });
    await useUpdateStore.getState().checkUpdate(true);
    await flush();
    const s = useUpdateStore.getState().status;
    expect(s.phase).toBe('latest');
    expect(s.recentReleases[0].version).toBe('4.0.1');
  });

  it('checking 期间重入调用直接返回（防并发重复请求）', async () => {
    let releaseCheck!: (v: unknown) => void;
    checkForUpdateMock.mockReturnValue(new Promise(r => { releaseCheck = r; }));
    const first = useUpdateStore.getState().checkUpdate(true);
    expect(useUpdateStore.getState().status.phase).toBe('checking');
    const second = useUpdateStore.getState().checkUpdate(true);
    await second;
    expect(checkForUpdateMock).toHaveBeenCalledTimes(1);
    releaseCheck(null);
    await first;
    await flush();
    expect(useUpdateStore.getState().status.phase).toBe('latest');
  });

  it('非 force 且已检查过 => 跳过（自动检查与手动检查共用结果）', async () => {
    checkForUpdateMock.mockResolvedValue(null);
    await useUpdateStore.getState().checkUpdate(true);
    await flush();
    expect(useUpdateStore.getState().status.lastCheckedAt).not.toBeNull();
    await useUpdateStore.getState().checkUpdate(false);
    expect(checkForUpdateMock).toHaveBeenCalledTimes(1);
  });
});

describe('applyUpdate / installAndRestart 下载安装流', () => {
  it('下载成功 => restart_required，进度透传', async () => {
    checkForUpdateMock.mockResolvedValue(makeUpdate('4.0.2'));
    await useUpdateStore.getState().checkUpdate(true);
    await flush();

    downloadUpdateMock.mockImplementation(async (_u: unknown, onProgress: (d: number, c: number) => void) => {
      onProgress(50, 200);
      onProgress(200, 200);
    });
    await useUpdateStore.getState().applyUpdate();
    await flush();
    const s = useUpdateStore.getState().status;
    expect(s.phase).toBe('restart_required');
    expect(s.downloaded).toBe(200);
    expect(s.contentLength).toBe(200);
  });

  it('下载失败 => 回到 update_available 且带 error（可重试）', async () => {
    checkForUpdateMock.mockResolvedValue(makeUpdate('4.0.2'));
    await useUpdateStore.getState().checkUpdate(true);
    await flush();

    downloadUpdateMock.mockRejectedValue(new Error('network reset'));
    await useUpdateStore.getState().applyUpdate();
    await flush();
    const s = useUpdateStore.getState().status;
    expect(s.phase).toBe('update_available');
    expect(s.updateInfo).not.toBeNull();
    expect(s.error).toBeTruthy();
  });

  it('installAndRestart 成功 => installing 并触发 relaunch', async () => {
    checkForUpdateMock.mockResolvedValue(makeUpdate('4.0.2'));
    downloadUpdateMock.mockResolvedValue(undefined);
    installUpdateMock.mockResolvedValue(undefined);
    restartAppMock.mockResolvedValue(undefined);
    await useUpdateStore.getState().checkUpdate(true);
    await flush();
    await useUpdateStore.getState().applyUpdate();
    await flush();

    await useUpdateStore.getState().installAndRestart();
    await flush();
    expect(useUpdateStore.getState().status.phase).toBe('installing');
    expect(installUpdateMock).toHaveBeenCalledTimes(1);
    expect(restartAppMock).toHaveBeenCalledTimes(1);
  });

  it('安装失败 => 回到 update_available 允许重新下载', async () => {
    checkForUpdateMock.mockResolvedValue(makeUpdate('4.0.2'));
    downloadUpdateMock.mockResolvedValue(undefined);
    installUpdateMock.mockRejectedValue(new Error('installer exit 1'));
    await useUpdateStore.getState().checkUpdate(true);
    await flush();
    await useUpdateStore.getState().applyUpdate();
    await flush();

    await useUpdateStore.getState().installAndRestart();
    await flush();
    const s = useUpdateStore.getState().status;
    expect(s.phase).toBe('update_available');
    expect(s.error).toBeTruthy();
    expect(restartAppMock).not.toHaveBeenCalled();
  });

  it('restart_required 之外的状态调用 installAndRestart 无效果', async () => {
    await useUpdateStore.getState().installAndRestart();
    expect(installUpdateMock).not.toHaveBeenCalled();
  });
});
