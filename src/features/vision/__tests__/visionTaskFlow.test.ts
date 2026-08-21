import { describe, it, expect, beforeEach, vi } from 'vitest';

// mock Tauri API 层与任务 store：不触达真实 IPC
const mockCreateTask = vi.fn();
const mockUpdateVisionTask = vi.fn();

vi.mock('../../../services/api', () => ({
  api: {
    createTask: (params: any) => mockCreateTask(params),
    updateVisionTask: (params: any) => mockUpdateVisionTask(params),
  },
}));

const mockAddTask = vi.fn();
const mockUpdateTask = vi.fn();

vi.mock('../../../store/useTaskStore', () => ({
  useTaskStore: {
    getState: () => ({ addTask: mockAddTask, updateTask: mockUpdateTask }),
  },
}));

import {
  createVisionUnderstandingTask,
  markVisionTaskCompleted,
  markVisionTaskFailed,
  markVisionTaskRunning,
} from '../visionTask';
import type { Task } from '../../../types';

function visionTaskFixture(id: string): Task {
  return {
    id,
    prompt: '视觉理解：分析参考图片…',
    negative_prompt: '',
    status: 'pending',
    created_at: new Date().toISOString(),
    size: '1024x1024',
    quality: 'auto',
    output_format: 'png',
    output_dir: '',
    count: 1,
    success_count: 0,
    failed_count: 0,
    source_images: ['D:/ref.jpg'],
    task_type: 'vision_understanding',
    execution_mode: 'single',
    sub_tasks: [{ index: 0, status: 'pending' }],
  } as unknown as Task;
}

describe('createVisionUnderstandingTask（视觉理解任务创建）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('创建 task_type=vision_understanding 的任务并登记到任务 store', async () => {
    mockCreateTask.mockImplementation(async (params: any) => {
      // 断言发生在 mock 内，保证 create_task 收到的就是视觉理解任务参数
      expect(params.task_type).toBe('vision_understanding');
      expect(params.source_images).toEqual(['D:/ref.jpg']);
      expect(params.prompt).toContain('视觉理解');
      expect(params.task_plan_summary).toContain('正在分析参考图片');
      expect(params.output_dir).toBe('');
      return visionTaskFixture('vt-1');
    });
    const task = await createVisionUnderstandingTask({
      sourcePath: 'D:/ref.jpg',
      modelId: 'glm-4.6v',
      mode: 'reverse_prompt',
    });
    expect(task?.id).toBe('vt-1');
    expect(mockAddTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'vt-1' }));
  });

  it('任务创建失败不抛出：返回 null，分析流程不被阻塞', async () => {
    mockCreateTask.mockRejectedValue(new Error('存储不可用'));
    const task = await createVisionUnderstandingTask({
      sourcePath: 'D:/ref.jpg',
      modelId: 'glm-4.6v',
      mode: 'quick',
    });
    expect(task).toBeNull();
    expect(mockAddTask).not.toHaveBeenCalled();
  });
});

describe('视觉理解任务状态推进', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateVisionTask.mockImplementation(async (params: any) => ({
      ...visionTaskFixture(params.taskId),
      status: params.status,
    }));
  });

  it('running：携带阶段性中文提示', async () => {
    await markVisionTaskRunning('vt-1');
    expect(mockUpdateVisionTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'vt-1', status: 'running', stageNote: expect.stringContaining('正在分析参考图片') }),
    );
  });

  it('completed：摘要写入"已分析参考图 + 视觉模型"', async () => {
    await markVisionTaskCompleted('vt-1', '一名男性篮球运动员在室内球馆上篮', 'glm-4.6v');
    expect(mockUpdateVisionTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'vt-1',
        status: 'completed',
        stageNote: '视觉理解完成',
        planSummary: expect.stringContaining('已分析参考图：一名男性篮球运动员在室内球馆上篮'),
      }),
    );
    const call = mockUpdateVisionTask.mock.calls[0][0];
    expect(call.planSummary).toContain('glm-4.6v');
  });

  it('failed：错误信息写入子任务，摘要使用统一中文文案', async () => {
    await markVisionTaskFailed('vt-1', '上游 401');
    expect(mockUpdateVisionTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'vt-1',
        status: 'failed',
        stageNote: '视觉理解失败',
        error: '上游 401',
        planSummary: '视觉理解失败，请重试或更换视觉模型。',
      }),
    );
  });

  it('更新失败静默（仅日志），不中断页面流程', async () => {
    mockUpdateVisionTask.mockRejectedValue(new Error('任务已结束'));
    await expect(markVisionTaskRunning('vt-1')).resolves.toBeUndefined();
  });
});
