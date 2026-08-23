import { create } from 'zustand';
import type { ChatAttachment, ChatMode } from '../types';

/**
 * 按 conversation 隔离的 Composer 草稿（V4.0.8 修复）。
 *
 * 历史问题：task/chat 两套图片附件原是 Chat.tsx 的页面级 useState，
 * 既不随会话切换保存/恢复（对话 A 的任务图跑到对话 B），也在页面卸载时丢失。
 * 现在所有写入都必须携带 conversationId（或唯一的匿名键），
 * 切会话 = 读另一个 key，天然隔离；页面卸载不丢（store 常驻内存）。
 *
 * 与 useDraftStore 同策略：内存级草稿，重启应用清空；
 * 需要跨重启持久化的状态（如绑定四态）由 ChatConversation 字段承担。
 */

/** 应用内没有任何会话时（activeId=null）Composer 仍可输入/拖图的唯一保留键。
 * 同一时刻至多存在一个"无会话"状态，不存在多个临时新对话共享 key 的问题；
 * newConversation() 会把匿名草稿迁移（adopt）到真实会话 id。 */
export const ANONYMOUS_DRAFT_KEY = '__no_active_conversation__';

export interface ConversationComposerDraft {
  /** 输入框文本草稿 */
  input: string;
  /** 💬 对话模式图片附件 */
  chat: ChatAttachment[];
  /** ⚡ 任务模式图片附件（任务图片） */
  task: ChatAttachment[];
}

export function createEmptyConversationDraft(): ConversationComposerDraft {
  return { input: '', chat: [], task: [] };
}

export type ComposerMode = ChatMode;

function generateAttachmentId(): string {
  return 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

interface ConversationDraftState {
  drafts: Record<string, ConversationComposerDraft>;
  /** 写入输入草稿（支持函数式更新，避免异步回调闭包读到旧值） */
  setInput: (key: string, value: string | ((prev: string) => string)) => void;
  /** 添加附件：按 filePath 去重（与旧页面态行为一致），id 由 store 生成 */
  addModeAttachment: (key: string, mode: ComposerMode, attachment: Omit<ChatAttachment, 'id'>) => void;
  removeModeAttachment: (key: string, mode: ComposerMode, attachmentId: string) => void;
  clearModeAttachments: (key: string, mode: ComposerMode) => void;
  /** 匿名草稿 → 真实会话的迁移（newConversation 时调用，不丢输入与图片） */
  adoptDraft: (fromKey: string, toKey: string) => void;
  /** 删除会话时清理对应草稿，防止 store 无限增长 */
  deleteDraft: (key: string) => void;
}

export const useConversationDraftStore = create<ConversationDraftState>((set, get) => ({
  drafts: {},

  setInput: (key, value) => {
    set(state => {
      const current = state.drafts[key] || createEmptyConversationDraft();
      const nextValue = typeof value === 'function' ? value(current.input) : value;
      if (nextValue === current.input && state.drafts[key]) return state;
      return { drafts: { ...state.drafts, [key]: { ...current, input: nextValue } } };
    });
  },

  addModeAttachment: (key, mode, attachment) => {
    set(state => {
      const current = state.drafts[key] || createEmptyConversationDraft();
      const list = current[mode];
      if (attachment.filePath && list.some(item => item.filePath === attachment.filePath)) {
        return state;
      }
      const withId: ChatAttachment = { ...attachment, id: generateAttachmentId() };
      return {
        drafts: {
          ...state.drafts,
          [key]: { ...current, [mode]: [...list, withId] },
        },
      };
    });
  },

  removeModeAttachment: (key, mode, attachmentId) => {
    set(state => {
      const current = state.drafts[key];
      if (!current) return state;
      const list = current[mode];
      if (!list.some(item => item.id === attachmentId)) return state;
      return {
        drafts: {
          ...state.drafts,
          [key]: { ...current, [mode]: list.filter(item => item.id !== attachmentId) },
        },
      };
    });
  },

  clearModeAttachments: (key, mode) => {
    set(state => {
      const current = state.drafts[key];
      if (!current || current[mode].length === 0) return state;
      return {
        drafts: {
          ...state.drafts,
          [key]: { ...current, [mode]: [] },
        },
      };
    });
  },

  adoptDraft: (fromKey, toKey) => {
    const source = get().drafts[fromKey];
    if (!source) return;
    if (fromKey === toKey) return;
    set(state => {
      const drafts = { ...state.drafts };
      const target = drafts[toKey] || createEmptyConversationDraft();
      drafts[toKey] = {
        input: target.input || source.input,
        chat: source.chat.length > 0 ? source.chat : target.chat,
        task: source.task.length > 0 ? source.task : target.task,
      };
      delete drafts[fromKey];
      return { drafts };
    });
  },

  deleteDraft: (key) => {
    set(state => {
      if (!state.drafts[key]) return state;
      const drafts = { ...state.drafts };
      delete drafts[key];
      return { drafts };
    });
  },
}));
