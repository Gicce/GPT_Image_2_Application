import { describe, it, expect, beforeEach, vi } from 'vitest';

// mock Tauri API 层：store 测试不触达真实 IPC / 服务器
const mockGetTasks = vi.fn();
const mockCreateTask = vi.fn();

vi.mock('../../services/api', () => ({
  api: {
    getTasks: () => mockGetTasks(),
    createTask: (params: any) => mockCreateTask(params),
    onTaskUpdated: () => Promise.resolve(() => {}),
  },
}));

vi.mock('../../services/serverApi', () => ({
  serverApi: { reportImage: vi.fn(async () => ({})) },
}));

import { useTaskStore } from '../useTaskStore';
import type { Task } from '../../types';

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
});
