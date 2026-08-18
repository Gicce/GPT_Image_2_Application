import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * 任务事件桥（ensureTaskEventBridge）测试：
 *  - 事件 → 200ms 去抖 loadTasks（store 刷新）→ 刷新完成后才回调 post-refresh 钩子
 *  - 这是“聊天任务卡永远停在 running”的根因修复：钩子必须看到刷新后的快照
 *  - 同一窗口内多个任务事件合并刷新，但每个 taskId 都要通知到
 */

let eventHandler: ((taskId: string) => void) | null = null;
const getTasksMock = vi.fn();
const callOrder: string[] = [];

vi.mock('../../services/api', () => ({
  api: {
    onTaskUpdated: (handler: (taskId: string) => void) => {
      eventHandler = handler;
      return Promise.resolve(() => { eventHandler = null; });
    },
    getTasks: (...args: unknown[]) => {
      callOrder.push('loadTasks');
      return getTasksMock(...args);
    },
  },
}));

vi.mock('../../services/billingService', () => ({
  authorizeImageTask: vi.fn(),
  settleImageTask: vi.fn(),
  registerTaskAuthorization: vi.fn(),
  takeTaskAuthorization: vi.fn(() => undefined),
  createRequestId: vi.fn(() => 'rid'),
}));

import { ensureTaskEventBridge, registerTaskRefreshHook } from '../useTaskStore';

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
});

describe('task-updated 事件桥', () => {
  it('事件先刷新 store，刷新完成后才通知钩子（顺序保证）', async () => {
    vi.useFakeTimers();
    ensureTaskEventBridge();
    const hook = vi.fn(() => callOrder.push('hook:t1'));
    const unregister = registerTaskRefreshHook(hook);

    getTasksMock.mockResolvedValue([]);
    eventHandler!('t1');
    await vi.advanceTimersByTimeAsync(250);

    expect(callOrder).toEqual(['loadTasks', 'hook:t1']);
    unregister();
    vi.useRealTimers();
  });

  it('200ms 窗口内多个事件只做一次全量刷新，但每个 taskId 都回调', async () => {
    vi.useFakeTimers();
    ensureTaskEventBridge();
    const hook = vi.fn();
    const unregister = registerTaskRefreshHook(hook);

    getTasksMock.mockResolvedValue([]);
    eventHandler!('t1');
    eventHandler!('t2');
    eventHandler!('t1');
    await vi.advanceTimersByTimeAsync(250);

    expect(getTasksMock).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook).toHaveBeenCalledWith('t1');
    expect(hook).toHaveBeenCalledWith('t2');
    unregister();
    vi.useRealTimers();
  });

  it('loadTasks 失败不吞掉后续事件窗口（桥保持可用）', async () => {
    vi.useFakeTimers();
    ensureTaskEventBridge();
    const hook = vi.fn();
    const unregister = registerTaskRefreshHook(hook);

    getTasksMock.mockRejectedValueOnce(new Error('db locked')).mockResolvedValue([]);
    eventHandler!('t1');
    await vi.advanceTimersByTimeAsync(250);
    // 失败窗口：不回调（没有新鲜数据可同步）
    expect(hook).not.toHaveBeenCalled();

    eventHandler!('t1');
    await vi.advanceTimersByTimeAsync(250);
    expect(hook).toHaveBeenCalledWith('t1');
    unregister();
    vi.useRealTimers();
  });
});
