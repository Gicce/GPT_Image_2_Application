import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatAttachment } from '../../types';
import {
  useConversationDraftStore,
  ANONYMOUS_DRAFT_KEY,
  createEmptyConversationDraft,
} from '../useConversationDraftStore';

/**
 * Conversation Composer 草稿（V4.0.8）：
 * 输入文本 + chat/task 两套图片附件全部按 conversationId 隔离。
 * 修复目标 —— 对话 A 的任务图片绝不出现在对话 B；
 * 页面卸载 / 会话切换不清空草稿；删除会话才清理。
 */

function imageAttachment(filePath: string): Omit<ChatAttachment, 'id'> {
  return {
    type: 'image',
    source: 'upload',
    name: filePath.split(/[\\/]/).pop() || filePath,
    dataUrl: 'data:image/png;base64,xxx',
    filePath,
  };
}

function resetDrafts() {
  useConversationDraftStore.setState({ drafts: {} });
}

function draftOf(key: string) {
  return useConversationDraftStore.getState().drafts[key] || createEmptyConversationDraft();
}

describe('跨对话隔离：task 图片', () => {
  beforeEach(() => resetDrafts());

  it('本地图片只进入目标会话（需求 §34-A）', () => {
    const store = useConversationDraftStore.getState();
    store.addModeAttachment('conv-a', 'task', imageAttachment('D:/imgs/a.png'));
    expect(draftOf('conv-a').task.map(a => a.filePath)).toEqual(['D:/imgs/a.png']);
    expect(draftOf('conv-b').task).toEqual([]);
  });

  it('拖入图片只进入目标会话（需求 §34-B）', () => {
    const store = useConversationDraftStore.getState();
    store.addModeAttachment('conv-a', 'task', imageAttachment('D:/imgs/drop.png'));
    expect(draftOf('conv-b').task).toEqual([]);
    expect(draftOf('conv-b').task).not.toContain('D:/imgs/drop.png');
  });

  it('图库图片只进入目标会话（需求 §34-C）', () => {
    const store = useConversationDraftStore.getState();
    store.addModeAttachment('conv-a', 'task', { ...imageAttachment('D:/imgs/g1.png'), source: 'gallery' });
    expect(draftOf('conv-b').task).toEqual([]);
  });

  it('A/B 交替切换各自恢复，互不污染（需求 §34-D / §15）', () => {
    const store = useConversationDraftStore.getState();
    store.addModeAttachment('conv-a', 'task', imageAttachment('D:/imgs/person.png'));
    store.addModeAttachment('conv-b', 'task', imageAttachment('D:/imgs/landscape.png'));

    const expectA = () => expect(draftOf('conv-a').task.map(a => a.filePath)).toEqual(['D:/imgs/person.png']);
    const expectB = () => expect(draftOf('conv-b').task.map(a => a.filePath)).toEqual(['D:/imgs/landscape.png']);
    // A → B → A → B
    expectA(); expectB(); expectA(); expectB();
  });

  it('多图删除中间项后保持 [1,3]（需求 §39，无任何回补合并）', () => {
    const store = useConversationDraftStore.getState();
    store.addModeAttachment('conv-a', 'task', imageAttachment('D:/imgs/1.png'));
    store.addModeAttachment('conv-a', 'task', imageAttachment('D:/imgs/2.png'));
    store.addModeAttachment('conv-a', 'task', imageAttachment('D:/imgs/3.png'));
    const ids = draftOf('conv-a').task.map(a => a.id);
    store.removeModeAttachment('conv-a', 'task', ids[1]);
    expect(draftOf('conv-a').task.map(a => a.filePath)).toEqual(['D:/imgs/1.png', 'D:/imgs/3.png']);
  });
});

describe('Task / Chat 图片语义隔离', () => {
  beforeEach(() => resetDrafts());

  it('task 图片不进入 chat 附件，反之亦然（需求 §26 / §43）', () => {
    const store = useConversationDraftStore.getState();
    store.addModeAttachment('conv-a', 'task', imageAttachment('D:/imgs/task.png'));
    store.addModeAttachment('conv-a', 'chat', imageAttachment('D:/imgs/chat.png'));
    const draft = draftOf('conv-a');
    expect(draft.task.map(a => a.filePath)).toEqual(['D:/imgs/task.png']);
    expect(draft.chat.map(a => a.filePath)).toEqual(['D:/imgs/chat.png']);
  });

  it('清除只影响指定会话的指定模式', () => {
    const store = useConversationDraftStore.getState();
    store.addModeAttachment('conv-a', 'task', imageAttachment('D:/imgs/a.png'));
    store.addModeAttachment('conv-a', 'chat', imageAttachment('D:/imgs/a-chat.png'));
    store.addModeAttachment('conv-b', 'task', imageAttachment('D:/imgs/b.png'));
    store.clearModeAttachments('conv-a', 'task');
    expect(draftOf('conv-a').task).toEqual([]);
    expect(draftOf('conv-a').chat.map(a => a.filePath)).toEqual(['D:/imgs/a-chat.png']);
    expect(draftOf('conv-b').task.map(a => a.filePath)).toEqual(['D:/imgs/b.png']);
  });
});

describe('输入草稿按会话隔离', () => {
  beforeEach(() => resetDrafts());

  it('A/B 输入互不可见；函数式更新读到各自前值', () => {
    const store = useConversationDraftStore.getState();
    store.setInput('conv-a', '给人物换背景');
    store.setInput('conv-b', '画一张风景');
    store.setInput('conv-a', prev => `${prev}，保持脸部不变`);
    expect(draftOf('conv-a').input).toBe('给人物换背景，保持脸部不变');
    expect(draftOf('conv-b').input).toBe('画一张风景');
  });
});

describe('去重与删除', () => {
  beforeEach(() => resetDrafts());

  it('同 filePath 图片不重复加入（与旧页面态行为一致）', () => {
    const store = useConversationDraftStore.getState();
    store.addModeAttachment('conv-a', 'task', imageAttachment('D:/imgs/same.png'));
    store.addModeAttachment('conv-a', 'task', imageAttachment('D:/imgs/same.png'));
    expect(draftOf('conv-a').task).toHaveLength(1);
  });

  it('删除会话草稿不影响其它会话（需求 §44）', () => {
    const store = useConversationDraftStore.getState();
    store.addModeAttachment('conv-a', 'task', imageAttachment('D:/imgs/a.png'));
    store.addModeAttachment('conv-b', 'task', imageAttachment('D:/imgs/b.png'));
    store.deleteDraft('conv-a');
    expect(useConversationDraftStore.getState().drafts['conv-a']).toBeUndefined();
    expect(draftOf('conv-b').task.map(a => a.filePath)).toEqual(['D:/imgs/b.png']);
  });
});

describe('新对话草稿键（需求 §24 / §25 / §40 / §41）', () => {
  beforeEach(() => resetDrafts());

  it('每个新会话使用独立 key —— 不存在共享 undefined/new 键', () => {
    const store = useConversationDraftStore.getState();
    const convX = 'c1780000000001x';
    const convY = 'c1780000000002y';
    store.addModeAttachment(convX, 'task', imageAttachment('D:/imgs/x.png'));
    expect(draftOf(convY).task).toEqual([]);
    expect(useConversationDraftStore.getState().drafts[ANONYMOUS_DRAFT_KEY]).toBeUndefined();
  });

  it('新对话不继承已有会话的任务图片（需求 §40）', () => {
    const store = useConversationDraftStore.getState();
    store.addModeAttachment('conv-a', 'task', imageAttachment('D:/imgs/a.png'));
    // 新对话 = 新 key，从空草稿起手
    const newConv = 'c1780000000003z';
    expect(draftOf(newConv).task).toEqual([]);
  });

  it('匿名草稿迁移：newConversation 时输入与图片不丢失（需求 §42 类比）', () => {
    const store = useConversationDraftStore.getState();
    store.setInput(ANONYMOUS_DRAFT_KEY, '无会话时输入的文字');
    store.addModeAttachment(ANONYMOUS_DRAFT_KEY, 'chat', imageAttachment('D:/imgs/anon.png'));
    const realConvId = 'c1780000000004w';
    store.adoptDraft(ANONYMOUS_DRAFT_KEY, realConvId);
    const migrated = draftOf(realConvId);
    expect(migrated.input).toBe('无会话时输入的文字');
    expect(migrated.chat.map(a => a.filePath)).toEqual(['D:/imgs/anon.png']);
    expect(useConversationDraftStore.getState().drafts[ANONYMOUS_DRAFT_KEY]).toBeUndefined();
  });
});
