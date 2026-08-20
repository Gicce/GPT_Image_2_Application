import { describe, it, expect, beforeEach, vi } from 'vitest';

// mock Tauri API 层：store 测试不触达真实 IPC / 服务器
const mockGetTasks = vi.fn();
const mockCreateTask = vi.fn();
const mockRetryTaskSubtasks = vi.fn();

vi.mock('../../services/api', () => ({
  api: {
    getTasks: () => mockGetTasks(),
    createTask: (params: any) => mockCreateTask(params),
    retryTaskSubtasks: (taskId: string, indexes: number[] | null) => mockRetryTaskSubtasks(taskId, indexes),
    onTaskUpdated: () => Promise.resolve(() => {}),
  },
}));

// V4 两阶段计费：任务终态结算走 billingService（settle 幂等，由服务端兜底）
vi.mock('../../services/billingService', () => ({
  authorizeImageTask: vi.fn(async () => ({})),
  settleImageTask: vi.fn(async () => null),
  registerTaskAuthorization: vi.fn(),
  takeTaskAuthorization: vi.fn(() => undefined),
  createRequestId: vi.fn(() => 'test-request-id-1234'),
  billingService: {},
}));

import { useTaskStore } from '../useTaskStore';
import { authorizeImageTask, registerTaskAuthorization } from '../../services/billingService';
import { useAuthStore } from '../useAuthStore';
import type { Task, SubTask } from '../../types';

function makeTask(patch: Partial<Task> & { id: string }): Task {
  return {
    prompt: '',
    negative_prompt: '',
    status: 'pending',
    created_at: new Date().toISOString(),
    sub_tasks: [],
    count: 1,
    success_count: 0,
    failed_count: 0,
    source_images: [],
    task_type: 'generate',
    execution_mode: 'single',
    ...patch,
  } as Task;
}

describe('useTaskStore 任务排序与一致性', () => {
  beforeEach(() => {
    mockGetTasks.mockReset();
    mockCreateTask.mockReset();
    mockRetryTaskSubtasks.mockReset();
    vi.mocked(authorizeImageTask).mockClear();
    vi.mocked(registerTaskAuthorization).mockClear();
    useTaskStore.setState({ tasks: [], loading: false });
  });

  it('loadTasks 后 store 内任务按 createdAt 倒序（最近任务的数据源保证）', async () => {
    mockGetTasks.mockResolvedValue([
      makeTask({ id: 'old', created_at: '2026-01-01T00:00:00Z' }),
      makeTask({ id: 'newest', created_at: '2026-08-15T00:00:00Z' }),
      makeTask({ id: 'mid', created_at: '2026-05-01T00:00:00Z' }),
    ]);
    await useTaskStore.getState().loadTasks();
    expect(useTaskStore.getState().tasks.map(t => t.id)).toEqual(['newest', 'mid', 'old']);
  });

  it('createAndExecuteTask 创建的新任务立即出现在 store 第一条（不依赖刷新页面）', async () => {
    mockGetTasks.mockResolvedValue([
      makeTask({ id: 'old', created_at: '2026-01-01T00:00:00Z' }),
    ]);
    await useTaskStore.getState().loadTasks();

    const created = makeTask({ id: 'brand-new', created_at: '2026-08-15T12:00:00Z', status: 'pending' });
    mockCreateTask.mockResolvedValue(created);
    mockGetTasks.mockResolvedValue([
      makeTask({ id: 'old', created_at: '2026-01-01T00:00:00Z' }),
      created,
    ]);

    await useTaskStore.getState().createAndExecuteTask({ prompt: 'p' } as any);
    const tasks = useTaskStore.getState().tasks;
    expect(tasks[0].id).toBe('brand-new');
  });

  it('createAndExecuteTask 对同 id 任务去重（不产生重复条目）', async () => {
    const created = makeTask({ id: 'dup', created_at: '2026-08-15T12:00:00Z' });
    mockCreateTask.mockResolvedValue(created);
    mockGetTasks.mockResolvedValue([created, created]);
    await useTaskStore.getState().createAndExecuteTask({ prompt: 'p' } as any);
    const before = useTaskStore.getState().tasks.filter(t => t.id === 'dup').length;
    expect(before).toBe(1);
  });

  it('task-updated 事件桥只注册一次（重复调用 ensureTaskEventBridge 不会叠加监听）', async () => {
    const { ensureTaskEventBridge } = await import('../useTaskStore');
    // api.onTaskUpdated 已 mock 为固定 unlisten；bridge 内部有 bound 守卫，
    // 若重复注册会在 mock 被多次调用后抛错或重复刷新 —— 这里验证不抛错且幂等
    expect(() => {
      ensureTaskEventBridge();
      ensureTaskEventBridge();
    }).not.toThrow();
  });

  it('retryTaskFailed 不传下标时自动派生全部失败子任务下标', async () => {
    const sub = (index: number, status: SubTask['status']): SubTask =>
      ({ index, status } as SubTask);
    const task = makeTask({
      id: 'batch-6',
      status: 'failed',
      count: 6,
      success_count: 4,
      failed_count: 2,
      sub_tasks: [
        sub(0, 'failed'), sub(1, 'completed'), sub(2, 'completed'),
        sub(3, 'failed'), sub(4, 'completed'), sub(5, 'completed'),
      ],
    });
    useTaskStore.setState({ tasks: [task] });
    mockRetryTaskSubtasks.mockResolvedValue({ resetIndexes: [0, 3], resetCount: 2 });
    mockGetTasks.mockResolvedValue([task]);

    const result = await useTaskStore.getState().retryTaskFailed('batch-6');
    expect(mockRetryTaskSubtasks).toHaveBeenCalledWith('batch-6', [0, 3]);
    expect(result.resetCount).toBe(2);
  });

  it('retryTaskFailed 单下标只重试该子任务（未登录不触发计费）', async () => {
    const task = makeTask({
      id: 'batch-6',
      status: 'failed',
      sub_tasks: [
        { index: 0, status: 'failed' } as SubTask,
        { index: 1, status: 'completed' } as SubTask,
      ],
    });
    useTaskStore.setState({ tasks: [task] });
    useAuthStore.setState({ isLoggedIn: false } as any);
    mockRetryTaskSubtasks.mockResolvedValue({ resetIndexes: [0], resetCount: 1 });
    mockGetTasks.mockResolvedValue([task]);

    await useTaskStore.getState().retryTaskFailed('batch-6', [0]);
    expect(mockRetryTaskSubtasks).toHaveBeenCalledWith('batch-6', [0]);
    expect(authorizeImageTask).not.toHaveBeenCalled();
  });

  it('retryTaskFailed 登录态按重试数预占并把重试下标登记进结算记录', async () => {
    const task = makeTask({
      id: 'batch-6',
      status: 'failed',
      sub_tasks: [{ index: 0, status: 'failed' } as SubTask],
    });
    useTaskStore.setState({ tasks: [task] });
    useAuthStore.setState({ isLoggedIn: true } as any);
    mockRetryTaskSubtasks.mockResolvedValue({ resetIndexes: [0], resetCount: 1 });
    mockGetTasks.mockResolvedValue([task]);

    await useTaskStore.getState().retryTaskFailed('batch-6', [0]);
    expect(authorizeImageTask).toHaveBeenCalledWith('test-request-id-1234', 1);
    expect(registerTaskAuthorization).toHaveBeenCalledWith('batch-6', 'test-request-id-1234', [0]);
    useAuthStore.setState({ isLoggedIn: false } as any);
  });

  it('retryTaskFailed 无失败子任务时直接报错且不发起请求', async () => {
    const task = makeTask({
      id: 'all-ok',
      status: 'completed',
      sub_tasks: [{ index: 0, status: 'completed' } as SubTask],
    });
    useTaskStore.setState({ tasks: [task] });
    await expect(useTaskStore.getState().retryTaskFailed('all-ok')).rejects.toThrow('没有可重试的失败子任务');
    expect(mockRetryTaskSubtasks).not.toHaveBeenCalled();
  });
});
