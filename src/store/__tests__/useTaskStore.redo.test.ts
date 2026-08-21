import { describe, it, expect, beforeEach, vi } from 'vitest';

// mock Tauri API 层：redo 测试不触达真实 IPC / 服务器
const mockGetTasks = vi.fn();
const mockCreateBatchRedoTask = vi.fn();

vi.mock('../../services/api', () => ({
  api: {
    getTasks: () => mockGetTasks(),
    createBatchRedoTask: (request: any) => mockCreateBatchRedoTask(request),
    onTaskUpdated: () => Promise.resolve(() => {}),
  },
}));

vi.mock('../../services/billingService', () => ({
  authorizeImageTask: vi.fn(async () => ({})),
  settleImageTask: vi.fn(async () => null),
  registerTaskAuthorization: vi.fn(),
  takeTaskAuthorization: vi.fn(() => undefined),
  createRequestId: vi.fn(() => 'redo-request-id-1234'),
  billingService: {},
}));

import { useTaskStore } from '../useTaskStore';
import { authorizeImageTask, settleImageTask, registerTaskAuthorization } from '../../services/billingService';
import { useAuthStore } from '../useAuthStore';
import type { Task } from '../../types';

function makeBatchTask(id: string): Task {
  return {
    id,
    prompt: '基础',
    negative_prompt: '',
    status: 'failed',
    created_at: new Date().toISOString(),
    size: '1024x1024',
    quality: 'auto',
    output_format: 'png',
    output_dir: 'D:/out',
    count: 3,
    success_count: 1,
    failed_count: 2,
    source_images: [],
    task_type: 'generate',
    execution_mode: 'batch',
    batch_items: [
      { id: 'b1', label: '方案一', prompt_delta: '', prompt_override: '' } as any,
      { id: 'b2', label: '方案二', prompt_delta: '', prompt_override: '' } as any,
      { id: 'b3', label: '方案三', prompt_delta: '', prompt_override: '' } as any,
    ],
    sub_tasks: [
      { index: 0, status: 'completed' } as any,
      { index: 1, status: 'failed' } as any,
      { index: 2, status: 'failed' } as any,
    ],
  } as Task;
}

describe('useTaskStore.redoBatchTask（V4.0.6 批量重做）', () => {
  beforeEach(() => {
    mockGetTasks.mockReset();
    mockCreateBatchRedoTask.mockReset();
    vi.mocked(authorizeImageTask).mockClear();
    vi.mocked(settleImageTask).mockClear();
    vi.mocked(registerTaskAuthorization).mockClear();
    useTaskStore.setState({ tasks: [], loading: false });
    useAuthStore.setState({ isLoggedIn: false } as any);
  });

  it('未登录：不触发计费授权，直接创建新任务', async () => {
    const source = makeBatchTask('src-1');
    useTaskStore.setState({ tasks: [source] });
    const created = { ...makeBatchTask('new-1'), status: 'pending' };
    mockCreateBatchRedoTask.mockResolvedValue(created);
    mockGetTasks.mockResolvedValue([source, created]);

    const result = await useTaskStore.getState().redoBatchTask('src-1', {
      source_task_id: 'src-1',
      selected_indexes: [1, 2],
      global_overrides: {},
      item_overrides: [],
    });

    expect(mockCreateBatchRedoTask).toHaveBeenCalledTimes(1);
    expect(authorizeImageTask).not.toHaveBeenCalled();
    expect(result.id).toBe('new-1');
  });

  it('登录态：按选中数正常授权（redo 不走 retry 计费路径），新任务登记结算', async () => {
    useAuthStore.setState({ isLoggedIn: true } as any);
    const source = makeBatchTask('src-1');
    useTaskStore.setState({ tasks: [source] });
    const created = { ...makeBatchTask('new-1'), status: 'pending' };
    mockCreateBatchRedoTask.mockResolvedValue(created);
    mockGetTasks.mockResolvedValue([source, created]);

    await useTaskStore.getState().redoBatchTask('src-1', {
      source_task_id: 'src-1',
      selected_indexes: [1, 2],
      global_overrides: {},
      item_overrides: [],
    });

    // 关键语义：authorize 数 = 选中子项数（新任务的新生成单元），request_id 用 redo scope
    expect(authorizeImageTask).toHaveBeenCalledWith('redo-request-id-1234', 2);
    // 登记到新任务 id（终态由 reportNewlyCompleted 全量结算，无 retriedIndexes 语义）
    expect(registerTaskAuthorization).toHaveBeenCalledWith('new-1', 'redo-request-id-1234');
    useAuthStore.setState({ isLoggedIn: false } as any);
  });

  it('创建失败：预占回滚（settle false），不登记授权', async () => {
    useAuthStore.setState({ isLoggedIn: true } as any);
    const source = makeBatchTask('src-1');
    useTaskStore.setState({ tasks: [source] });
    mockCreateBatchRedoTask.mockRejectedValue(new Error('子任务下标越界'));

    await expect(useTaskStore.getState().redoBatchTask('src-1', {
      source_task_id: 'src-1',
      selected_indexes: [9],
      global_overrides: {},
      item_overrides: [],
    })).rejects.toThrow('子任务下标越界');

    expect(settleImageTask).toHaveBeenCalledWith('redo-request-id-1234', false, 0, 'batch redo create failed');
    expect(registerTaskAuthorization).not.toHaveBeenCalled();
    useAuthStore.setState({ isLoggedIn: false } as any);
  });

  it('空选择直接拒绝，不发请求不计费', async () => {
    const source = makeBatchTask('src-1');
    useTaskStore.setState({ tasks: [source] });
    await expect(useTaskStore.getState().redoBatchTask('src-1', {
      source_task_id: 'src-1',
      selected_indexes: [],
      global_overrides: {},
      item_overrides: [],
    })).rejects.toThrow('请至少选择一个子任务');
    expect(mockCreateBatchRedoTask).not.toHaveBeenCalled();
    expect(authorizeImageTask).not.toHaveBeenCalled();
  });

  it('源任务不存在直接拒绝', async () => {
    await expect(useTaskStore.getState().redoBatchTask('ghost', {
      source_task_id: 'ghost',
      selected_indexes: [0],
      global_overrides: {},
      item_overrides: [],
    })).rejects.toThrow('任务不存在');
  });

  it('请求体原样透传（Rust 侧负责校验与快照拷贝）', async () => {
    const source = makeBatchTask('src-1');
    useTaskStore.setState({ tasks: [source] });
    mockCreateBatchRedoTask.mockResolvedValue({ ...source, id: 'new-1' });
    mockGetTasks.mockResolvedValue([source]);

    const request = {
      source_task_id: 'src-1',
      selected_indexes: [2, 0],
      global_overrides: { size: '1792x1024', prompt_prefix: '前缀' },
      item_overrides: [{ index: 2, label: '改名' }],
    } as any;
    await useTaskStore.getState().redoBatchTask('src-1', request);
    expect(mockCreateBatchRedoTask).toHaveBeenCalledWith(request);
  });
});
