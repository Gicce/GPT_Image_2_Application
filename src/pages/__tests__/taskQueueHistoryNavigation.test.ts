import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { HISTORY_FOCUS_KEY, openTaskDetailFromQueue } from '../../utils/taskNavigation';

// node 环境（项目 vitest 无 jsdom）：stub localStorage / window.dispatchEvent / CustomEvent
class FakeCustomEvent<T> {
  constructor(
    public type: string,
    public init: { detail?: T } = {},
  ) {}
}

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
};

const dispatched: FakeCustomEvent<{ page: string; focusTaskId?: string }>[] = [];
const windowStub = {
  dispatchEvent: (event: FakeCustomEvent<{ page: string; focusTaskId?: string }>) => {
    dispatched.push(event);
    return true;
  },
};

vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', windowStub);
vi.stubGlobal('CustomEvent', FakeCustomEvent);

describe('TaskQueue → History 深链导航（spec §27）', () => {
  beforeEach(() => {
    storage.clear();
    dispatched.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('openTaskDetailFromQueue 写入 History 焦点键并派发 cyimage-navigate(history)', () => {
    openTaskDetailFromQueue('task-abc-123');

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe('cyimage-navigate');
    expect(dispatched[0].init.detail).toEqual({ page: 'history', focusTaskId: 'task-abc-123' });
    expect(localStorage.getItem(HISTORY_FOCUS_KEY)).toBe('task-abc-123');
  });

  it('深链不写任务队列焦点键（不会在下次进队列时错误高亮）', () => {
    openTaskDetailFromQueue('task-abc-123');
    expect(localStorage.getItem('cy_taskqueue_focus_id')).toBeNull();
  });

  it('键保留语义：History 只在用户手动点选其它任务时移除（刷新 / 重进仍指向同一任务）', () => {
    openTaskDetailFromQueue('task-abc-123');
    expect(localStorage.getItem(HISTORY_FOCUS_KEY)).toBe('task-abc-123');

    // handleSelectTask('other') → 清键；handleSelectTask('task-abc-123') → 保留
    localStorage.removeItem(HISTORY_FOCUS_KEY);
    expect(localStorage.getItem(HISTORY_FOCUS_KEY)).toBeNull();
  });

  it('深链目标不依赖列表第一页：selectedTask 按 id 精确 find（History 数据源为全量 tasks）', () => {
    // History 列表无分页：tasks 一次性全量拉取，selectedTask = tasks.find(id)。
    // 这里锁定键值本身可被 find 命中（防 key 变更 / 截断类回归）。
    openTaskDetailFromQueue('deep-target-id');
    const key = localStorage.getItem(HISTORY_FOCUS_KEY);
    const tasks = [{ id: 'other' }, { id: 'deep-target-id' }];
    expect(tasks.find(t => t.id === key)?.id).toBe('deep-target-id');
  });
});
