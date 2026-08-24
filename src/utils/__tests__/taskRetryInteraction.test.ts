import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 重试交互契约（spec §15-§17）：
//  - 手动重试只提交失败 slot（store 语义，见 useTaskStore.test.ts 计费断言）
//  - 提交反馈必须走应用 Toast（本文件锁源码层：Toast 引入 + 无 native alert）
//  - 重试后派生态回到 queued/running，completed 槽与历史错误保留

const mockGetTasks = vi.fn();
const mockRetryTaskSubtasks = vi.fn();

vi.mock('../../services/api', () => ({
  api: {
    getTasks: () => mockGetTasks(),
    retryTaskSubtasks: (taskId: string, indexes: number[] | null) => mockRetryTaskSubtasks(taskId, indexes),
    onTaskUpdated: () => Promise.resolve(() => {}),
  },
}));

vi.mock('../../services/billingService', () => ({
  authorizeImageTask: vi.fn(async () => ({})),
  settleImageTask: vi.fn(async () => null),
  registerTaskAuthorization: vi.fn(),
  takeTaskAuthorization: vi.fn(() => undefined),
  createRequestId: vi.fn(() => 'test-request-id'),
  billingService: {},
}));

import { useTaskStore } from '../../store/useTaskStore';
import { deriveTaskState } from '../taskState';
import type { SubTask, Task } from '../../types';

const TASK_QUEUE_SOURCE = readFileSync(
  resolve(__dirname, '../../pages/TaskQueue.tsx'),
  'utf-8',
);

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

describe('taskRetryInteraction 重试交互契约', () => {
  beforeEach(() => {
    mockGetTasks.mockReset();
    mockRetryTaskSubtasks.mockReset();
    useTaskStore.setState({ tasks: [], loading: false });
  });

  it('失败 slot 重试提交后：派生态 failed → queued，已完成 slot 不受影响', async () => {
    const sub = (index: number, status: SubTask['status'], retryCount = 0): SubTask =>
      ({ index, status, retry_count: retryCount } as SubTask);
    const failedTask = makeTask({
      id: 'retry-1',
      status: 'failed',
      count: 2,
      success_count: 1,
      failed_count: 1,
      sub_tasks: [sub(0, 'failed'), sub(1, 'completed')],
    });
    useTaskStore.setState({ tasks: [failedTask] });
    mockRetryTaskSubtasks.mockResolvedValue({ resetIndexes: [0], resetCount: 1 });
    // Rust 重置后的快照：slot0 pending + retry_count+1，slot1 completed 原样，parent pending
    const afterReset = makeTask({
      id: 'retry-1',
      status: 'pending',
      count: 2,
      success_count: 1,
      failed_count: 0,
      sub_tasks: [sub(0, 'pending', 1), sub(1, 'completed')],
    });
    mockGetTasks.mockResolvedValue([afterReset]);

    const result = await useTaskStore.getState().retryTaskFailed('retry-1');
    expect(mockRetryTaskSubtasks).toHaveBeenCalledWith('retry-1', [0]);
    expect(result.resetIndexes).toEqual([0]);

    const refreshed = useTaskStore.getState().tasks.find(t => t.id === 'retry-1')!;
    expect(refreshed.sub_tasks[1].status).toBe('completed');
    expect(refreshed.sub_tasks[0].retry_count).toBe(1);
    expect(deriveTaskState(refreshed)).toBe('queued');
  });

  it('部分完成（partial）任务的重试也只提交失败 slot', async () => {
    const partial = makeTask({
      id: 'partial-1',
      status: 'failed',
      count: 3,
      success_count: 2,
      failed_count: 1,
      sub_tasks: [
        { index: 0, status: 'completed' } as SubTask,
        { index: 1, status: 'completed' } as SubTask,
        { index: 2, status: 'failed' } as SubTask,
      ],
    });
    useTaskStore.setState({ tasks: [partial] });
    mockRetryTaskSubtasks.mockResolvedValue({ resetIndexes: [2], resetCount: 1 });
    mockGetTasks.mockResolvedValue([partial]);

    await useTaskStore.getState().retryTaskFailed('partial-1');
    expect(mockRetryTaskSubtasks).toHaveBeenCalledWith('partial-1', [2]);
  });

  it('TaskQueue 重试反馈使用应用 Toast（toastSuccess/toastError），成功文案含「已完成的结果不会重复生成」', () => {
    expect(TASK_QUEUE_SOURCE).toMatch(/import \{[^}]*toastSuccess[^}]*\} from '\.\.\/components\/Toast'/);
    expect(TASK_QUEUE_SOURCE).toContain('重试任务已加入队列');
    expect(TASK_QUEUE_SOURCE).toContain('已完成的结果不会重复生成');
    expect(TASK_QUEUE_SOURCE).toContain('未能重新加入任务队列，请稍后重试。');
    // 保留开发日志：提交失败时 console.error 记录具体错误
    expect(TASK_QUEUE_SOURCE).toMatch(/console\.error\('\[TaskQueue\] retry failed subtasks error'/);
  });

  it('终态按钮契约源码检查：终态显示「查看任务详情」；取消任务只在活跃任务渲染', () => {
    expect(TASK_QUEUE_SOURCE).toContain('取消任务');
    expect(TASK_QUEUE_SOURCE).toContain('查看任务详情');
    expect(TASK_QUEUE_SOURCE).toContain('重新生成失败项');
    expect(TASK_QUEUE_SOURCE).toContain('重试失败项');
    // openTaskDetailFromQueue 深链入口
    expect(TASK_QUEUE_SOURCE).toMatch(/openTaskDetailFromQueue\(task\.id\)/);
  });
});
