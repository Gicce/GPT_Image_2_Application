import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ChatConversation, ChatMessage, ImageRecord, Task } from '../../types';

// mock Tauri/服务层：store 行为测试不触达真实 IPC / 服务器
vi.mock('../../services/api', () => ({
  api: {
    getConversations: async () => [],
    saveConversations: async () => {},
    saveConversation: async () => {},
    readImageData: async () => 'data:image/png;base64,TEST',
    getImages: async () => [],
    getAgentTaskTemplates: async () => [],
    getAgentStyleTemplates: async () => [],
    onTaskUpdated: () => Promise.resolve(() => {}),
    saveChatImage: async () => ({ file_name: 'paste.png', local_path: 'D:/chat/paste.png' }),
    createTask: async (params: unknown) => ({ id: 'created-task' }) as unknown as Task,
    retryTask: async (taskId: string) => ({ id: taskId }) as unknown as Task,
    appendAgentTemplateLog: async () => {},
  },
}));

vi.mock('../../services/serverApi', () => ({ serverApi: {} }));

vi.mock('../../services/billingService', () => ({
  authorizeImageTask: vi.fn(async () => ({})),
  settleImageTask: vi.fn(async () => null),
  registerTaskAuthorization: vi.fn(),
  takeTaskAuthorization: vi.fn(() => undefined),
  createRequestId: vi.fn(() => 'test-request-id'),
  billingService: {},
}));

import { useChatStore, restoreActiveImageIds } from '../useChatStore';
import { useConversationDraftStore, ANONYMOUS_DRAFT_KEY } from '../useConversationDraftStore';
import { useTaskStore } from '../useTaskStore';
import { useImageStore } from '../useImageStore';

/**
 * 任务图片绑定四态 × 会话隔离 行为测试（V4.0.8）：
 * Bug1 —— 用户解绑后切页面回来不允许自动复活（restoreActiveImageIds 只认 uninitialized）。
 * Bug2 —— 任务图片按 conversationId 隔离，删除会话清理草稿。
 */

function makeSuccessTaskMessage(taskId: string, imagePath: string, imageId = `img_${taskId}`): ChatMessage {
  return {
    id: `m_${taskId}`,
    role: 'assistant',
    content: '任务完成',
    created_at: '2026-08-01T00:00:00.000Z',
    task_message: {
      taskId,
      status: 'completed',
      stage: 'success',
      title: 't',
      prompt: 'p',
      finalPrompt: 'p',
      images: [{ id: imageId, imageId, url: 'data:image/png;base64,TEST', localPath: imagePath }],
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    } as unknown as ChatMessage['task_message'],
  };
}

function makeRunningTaskMessage(taskId: string): ChatMessage {
  return {
    id: `m_run_${taskId}`,
    role: 'assistant',
    content: '生成中',
    created_at: '2026-08-01T00:00:00.000Z',
    task_message: {
      taskId,
      status: 'running',
      stage: 'running',
      title: 't',
      prompt: 'p',
      finalPrompt: 'p',
      images: [],
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    } as unknown as ChatMessage['task_message'],
  };
}

function makeConversation(patch: Partial<ChatConversation> & { id: string }): ChatConversation {
  return {
    title: '',
    messages: [],
    created_at: new Date().toISOString(),
    ...patch,
  } as ChatConversation;
}

function makeCompletedTask(id: string): Task {
  return {
    id,
    status: 'completed',
    completed_at: '2026-08-02T00:00:00.000Z',
    created_at: '2026-08-01T00:00:00.000Z',
    prompt: 'p',
    negative_prompt: '',
    sub_tasks: [],
    count: 1,
    success_count: 1,
    failed_count: 0,
    source_images: [],
    task_type: 'generate',
    execution_mode: 'single',
    size: '1024x1024',
    quality: 'auto',
    output_format: 'png',
    output_dir: 'D:/out',
  } as Task;
}

function makeResultImage(id: string, taskId: string): ImageRecord {
  return {
    id,
    task_id: taskId,
    local_path: `D:/out/${id}.png`,
    file_name: `${id}.png`,
    width: 1024,
    height: 1024,
    created_at: '2026-08-02T00:00:00.000Z',
    missing: false,
  } as ImageRecord;
}

function seedConversations(conversations: ChatConversation[], activeId: string | null = null) {
  useChatStore.setState({
    conversations,
    activeId,
    runtimeById: {},
    abortCtrls: {},
    error: null,
    taskSubmitting: false,
  });
}

function conversation(id: string): ChatConversation | undefined {
  return useChatStore.getState().conversations.find(c => c.id === id);
}

beforeEach(() => {
  useConversationDraftStore.setState({ drafts: {} });
  useTaskStore.setState({ tasks: [] });
  useImageStore.setState({ images: [] });
});

describe('Bug1：用户解绑后图片不复活', () => {
  it('uninitialized 会话首次 restore 自动绑定（连续编辑上下文保留）', () => {
    seedConversations([
      makeConversation({ id: 'conv-a', messages: [makeSuccessTaskMessage('t1', 'D:/out/a.png')] }),
    ], 'conv-a');

    restoreActiveImageIds('conv-a');

    const conv = conversation('conv-a')!;
    expect(conv.active_image_id).toBe('img_t1');
    expect(conv.active_image_path).toBe('D:/out/a.png');
    expect(conv.active_image_binding).toBe('auto');
    expect(conv.active_image_source).toBe('auto');
  });

  it('用户点 X 解绑 → binding=none → 再次 restore（模拟切页面回来）不复活', () => {
    seedConversations([
      makeConversation({
        id: 'conv-a',
        messages: [makeSuccessTaskMessage('t1', 'D:/out/a.png')],
        active_image_id: 'img_t1',
        active_image_path: 'D:/out/a.png',
        active_image_source: 'auto',
        active_image_binding: 'auto',
      }),
    ], 'conv-a');

    // 用户点击 X（取消编辑目标绑定）
    useChatStore.getState().setActiveImageId('conv-a', null, null);
    expect(conversation('conv-a')!.active_image_id).toBeNull();
    expect(conversation('conv-a')!.active_image_binding).toBe('none');

    // 切页面 → 回来：loadConversations → restoreActiveImageIds 不得再自动补图
    restoreActiveImageIds('conv-a');
    restoreActiveImageIds();
    expect(conversation('conv-a')!.active_image_id).toBeNull();
    expect(conversation('conv-a')!.active_image_binding).toBe('none');
  });

  it('解绑时若仍有手动任务图片 → binding=manual 而非 none', () => {
    useConversationDraftStore.getState().addModeAttachment('conv-a', 'task', {
      type: 'image', source: 'upload', name: 'm.png', dataUrl: 'data:', filePath: 'D:/m.png',
    });
    seedConversations([
      makeConversation({
        id: 'conv-a',
        active_image_id: 'img_t1',
        active_image_path: 'D:/out/a.png',
        active_image_source: 'auto',
        active_image_binding: 'auto',
      }),
    ], 'conv-a');

    useChatStore.getState().setActiveImageId('conv-a', null, null);
    expect(conversation('conv-a')!.active_image_binding).toBe('manual');
  });

  it('旧数据（无 binding 字段）+ 有 active_image → 归一为 auto / manual，不触发自动重绑', () => {
    seedConversations([
      makeConversation({
        id: 'conv-legacy',
        messages: [makeSuccessTaskMessage('t1', 'D:/out/a.png')],
        active_image_id: 'img_t1',
        active_image_path: 'D:/out/a.png',
        active_image_source: 'explicit',
      }),
    ], 'conv-legacy');

    restoreActiveImageIds('conv-legacy');
    const conv = conversation('conv-legacy')!;
    expect(conv.active_image_id).toBe('img_t1');
    // 显式绑定不被 restore 改写
    expect(conv.active_image_source).toBe('explicit');
  });
});

describe('A / B 会话绑定状态互不污染（需求 §17 / §36）', () => {
  it('A=none、B=uninitialized：restore 只绑 B，A 保持空', () => {
    seedConversations([
      makeConversation({
        id: 'conv-a',
        messages: [makeSuccessTaskMessage('ta', 'D:/out/a.png')],
        active_image_binding: 'none',
      }),
      makeConversation({
        id: 'conv-b',
        messages: [makeSuccessTaskMessage('tb', 'D:/out/b.png')],
      }),
    ], 'conv-b');

    restoreActiveImageIds();

    expect(conversation('conv-a')!.active_image_id).toBeUndefined();
    expect(conversation('conv-a')!.active_image_binding).toBe('none');
    expect(conversation('conv-b')!.active_image_id).toBe('img_tb');
    expect(conversation('conv-b')!.active_image_binding).toBe('auto');
  });
});

describe('syncTaskMessage：任务成功推进 active_image 的 none 守卫（需求 §19）', () => {
  it('binding=none：新完成任务的图片不自动绑定', async () => {
    const task = makeCompletedTask('task-1');
    useTaskStore.setState({ tasks: [task] });
    useImageStore.setState({ images: [makeResultImage('gen_1', 'task-1')] });
    seedConversations([
      makeConversation({
        id: 'conv-none',
        messages: [makeRunningTaskMessage('task-1')],
        active_image_binding: 'none',
      }),
    ], 'conv-none');

    await useChatStore.getState().syncTaskMessage('task-1', 'conv-none');

    const conv = conversation('conv-none')!;
    expect(conv.active_image_id).toBeUndefined();
    expect(conv.active_image_binding).toBe('none');
  });

  it('binding=auto：任务成功推进到最新结果图并保持 auto', async () => {
    const task = makeCompletedTask('task-2');
    useTaskStore.setState({ tasks: [task] });
    useImageStore.setState({ images: [makeResultImage('gen_2', 'task-2')] });
    seedConversations([
      makeConversation({
        id: 'conv-auto',
        messages: [makeRunningTaskMessage('task-2')],
        active_image_id: 'img_old',
        active_image_path: 'D:/out/old.png',
        active_image_source: 'auto',
        active_image_binding: 'auto',
        active_image_set_at: '2026-07-01T00:00:00.000Z',
      }),
    ], 'conv-auto');

    await useChatStore.getState().syncTaskMessage('task-2', 'conv-auto');

    const conv = conversation('conv-auto')!;
    expect(conv.active_image_id).toBe('gen_2');
    expect(conv.active_image_path).toBe('D:/out/gen_2.png');
    expect(conv.active_image_binding).toBe('auto');
  });
});

describe('Composer 草稿与会话生命周期', () => {
  it('deleteConversation 清理对应会话草稿，其余会话不受影响（需求 §44）', () => {
    useConversationDraftStore.getState().addModeAttachment('conv-a', 'task', {
      type: 'image', source: 'upload', name: 'a.png', dataUrl: 'data:', filePath: 'D:/a.png',
    });
    useConversationDraftStore.getState().addModeAttachment('conv-b', 'task', {
      type: 'image', source: 'upload', name: 'b.png', dataUrl: 'data:', filePath: 'D:/b.png',
    });
    seedConversations([
      makeConversation({ id: 'conv-a' }),
      makeConversation({ id: 'conv-b' }),
    ], 'conv-b');

    useChatStore.getState().deleteConversation('conv-a');

    expect(useConversationDraftStore.getState().drafts['conv-a']).toBeUndefined();
    expect(useConversationDraftStore.getState().drafts['conv-b']?.task).toHaveLength(1);
    expect(useChatStore.getState().conversations.map(c => c.id)).toEqual(['conv-b']);
  });

  it('newConversation 迁移匿名草稿：输入与任务图片不丢失、不串会话（需求 §42）', () => {
    const drafts = useConversationDraftStore.getState();
    drafts.setInput(ANONYMOUS_DRAFT_KEY, '还没有会话时输入的');
    drafts.addModeAttachment(ANONYMOUS_DRAFT_KEY, 'chat', {
      type: 'image', source: 'upload', name: 'anon.png', dataUrl: 'data:', filePath: 'D:/anon.png',
    });
    seedConversations([makeConversation({ id: 'conv-existing' })], 'conv-existing');

    const newId = useChatStore.getState().newConversation();

    const draftsAfter = useConversationDraftStore.getState().drafts;
    expect(draftsAfter[ANONYMOUS_DRAFT_KEY]).toBeUndefined();
    expect(draftsAfter[newId]?.input).toBe('还没有会话时输入的');
    expect(draftsAfter[newId]?.chat.map(a => a.filePath)).toEqual(['D:/anon.png']);
    // 已有会话草稿不受迁移影响
    expect(draftsAfter['conv-existing']).toBeUndefined();
  });

  it('每个新会话草稿相互隔离（不共享任何临时键，需求 §41）', () => {
    seedConversations([makeConversation({ id: 'conv-0' })], 'conv-0');
    const id1 = useChatStore.getState().newConversation();
    const id2 = useChatStore.getState().newConversation();
    expect(id1).not.toBe(id2);

    useConversationDraftStore.getState().addModeAttachment(id1, 'task', {
      type: 'image', source: 'upload', name: 'x.png', dataUrl: 'data:', filePath: 'D:/x.png',
    });
    const drafts = useConversationDraftStore.getState().drafts;
    expect(drafts[id1]?.task).toHaveLength(1);
    expect(drafts[id2]?.task ?? []).toHaveLength(0);
  });
});
