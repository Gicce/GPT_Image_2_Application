import { create } from 'zustand';
import type { ChatConversation, ChatMessage } from '../types';
import { api } from '../services/api';

interface SendSettings {
  chat_token: string;
  token: string;
  chat_model: string;
  chat_base_url: string;
  chat_system_prompt: string;
}

interface SendOptions {
  imageGenMode: boolean;
  editImage: { dataUrl: string; filePath: string } | null;
  deepThinking: boolean;
  pendingImages: { dataUrl: string }[];
}

interface ChatState {
  conversations: ChatConversation[];
  activeId: string | null;
  isSending: boolean;
  error: string | null;
  abortCtrl: AbortController | null;

  loadConversations: () => Promise<void>;
  save: () => Promise<void>;
  newConversation: () => string;
  switchConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  sendMessage: (text: string, settings: SendSettings, options: SendOptions) => Promise<void>;
  stopGeneration: () => void;
}

function resolveBaseURL(url: string): string {
  let base = url.replace(/\/+$/, '');
  if (!base.endsWith('/v1')) base += '/v1';
  return base;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeId: null,
  isSending: false,
  error: null,
  abortCtrl: null,

  loadConversations: async () => {
    try {
      const conversations = await api.getConversations();
      set({ conversations, activeId: conversations.length > 0 ? conversations[0].id : null });
    } catch (err) {
      console.error('加载对话历史失败:', err);
      set({ error: '无法加载对话历史，数据可能已损坏' });
    }
  },

  save: async () => {
    const { conversations } = get();
    await api.saveConversations(conversations);
  },

  newConversation: () => {
    const id = 'c' + Date.now() + Math.random().toString(36).slice(2, 6);
    const conv: ChatConversation = { id, title: '', messages: [], created_at: new Date().toISOString() };
    set(s => ({ conversations: [conv, ...s.conversations], activeId: id, error: null }));
    get().save();
    return id;
  },

  switchConversation: (id) => set({ activeId: id, error: null }),

  deleteConversation: (id) => {
    set(s => {
      const conversations = s.conversations.filter(c => c.id !== id);
      const activeId = s.activeId === id ? (conversations.length > 0 ? conversations[0].id : null) : s.activeId;
      return { conversations, activeId };
    });
    get().save();
  },

  renameConversation: (id, title) => {
    set(s => ({ conversations: s.conversations.map(c => c.id === id ? { ...c, title } : c) }));
    get().save();
  },

  sendMessage: async (text, settings, options) => {
    let { activeId } = get();
    if (!activeId) activeId = get().newConversation();

    const now = Date.now();
    const userMsg: ChatMessage = {
      id: 'm' + now,
      role: 'user',
      content: text,
      images: [
        ...options.pendingImages.map(p => p.dataUrl),
        ...(options.editImage ? [options.editImage.dataUrl] : []),
      ],
      created_at: new Date().toISOString(),
    };
    const assistantMsg: ChatMessage = {
      id: 'm' + (now + 1),
      role: 'assistant',
      content: '',
      created_at: new Date().toISOString(),
    };

    set(s => ({
      conversations: s.conversations.map(c =>
        c.id === activeId ? { ...c, title: c.title || text.slice(0, 30), messages: [...c.messages, userMsg, assistantMsg] } : c
      ),
      isSending: true,
      error: null,
    }));
    get().save();

    const abortCtrl = new AbortController();
    set({ abortCtrl });

    const isImageMode = options.imageGenMode || !!options.editImage;
    const baseURL = resolveBaseURL(settings.chat_base_url);

    try {
      if (isImageMode) {
        // 文生图 or 图生图 — route through Rust backend to avoid CORS
        const token = settings.token;
        if (!token) throw new Error('请先在设置页面配置图片生成 API Token');
        const model = 'gpt-image-2';

        let b64: string;
        if (options.editImage) {
          // 图生图: pass file path, Rust reads from disk
          b64 = await api.chatEditImage(text || '编辑这张图片', model, options.editImage.filePath);
        } else {
          // 文生图
          b64 = await api.chatGenerateImage(text, model);
        }

        if (b64) {
          finishWithImage(activeId!, assistantMsg.id, '图片已生成', b64);
        } else {
          finishWithText(activeId!, assistantMsg.id, '图片生成失败：API 未返回图片数据');
        }
      } else {
        // 普通对话 — use chat API with chat token
        const token = settings.chat_token;
        if (!token) throw new Error('请先在设置页面配置对话 API Token');

        const conv = get().conversations.find(c => c.id === activeId)!;

        type ContentPart = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string };
        const apiMessages: { role: string; content: string | ContentPart[] }[] = [];

        let systemPrompt = settings.chat_system_prompt || '';
        if (options.deepThinking) {
          systemPrompt = (systemPrompt ? systemPrompt + '\n\n' : '') +
            '请在回答前进行深入的逐步推理分析。先用 <thinking>...</thinking> 标签展示你的思考过程，然后再给出最终回答。';
        }
        if (systemPrompt) apiMessages.push({ role: 'system', content: systemPrompt });

        for (const m of conv.messages.filter(m => m.role === 'user' || m.role === 'assistant')) {
          if (m.images && m.images.length > 0 && m.role === 'user') {
            const parts: ContentPart[] = [];
            if (m.content) parts.push({ type: 'input_text', text: m.content });
            for (const imgUrl of m.images) {
              parts.push({ type: 'input_image', image_url: imgUrl });
            }
            apiMessages.push({ role: m.role, content: parts });
          } else if (m.content) {
            apiMessages.push({ role: m.role, content: m.content });
          }
        }

        const timeoutId = setTimeout(() => abortCtrl.abort(), 120000);
        const resp = await fetch(baseURL + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ model: settings.chat_model, messages: apiMessages, max_tokens: 4096 }),
          signal: abortCtrl.signal,
        });
        clearTimeout(timeoutId);

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error('HTTP ' + resp.status + ': ' + (err.error?.message || resp.statusText));
        }

        const data = await resp.json();
        let reply = data.choices?.[0]?.message?.content || '(空回复)';

        // Extract reasoning from <thinking> tags
        let reasoning = '';
        let reasoningDuration = '';
        const thinkingMatch = reply.match(/<thinking>([\s\S]*?)<\/thinking>/);
        if (thinkingMatch) {
          reasoning = thinkingMatch[1].trim();
          reply = reply.replace(/<thinking>[\s\S]*?<\/thinking>/, '').trim();
          reasoningDuration = '思考完成';
        }

        set(s => ({
          conversations: s.conversations.map(c =>
            c.id === activeId ? {
              ...c,
              messages: c.messages.map(m => m.id === assistantMsg.id ? {
                ...m, content: reply, reasoning, reasoning_duration: reasoningDuration,
              } : m),
            } : c
          ),
          isSending: false,
          abortCtrl: null,
        }));
        get().save();
      }
    } catch (err: any) {
      const errMsg = typeof err === 'string' ? err : (err?.message || String(err));
      if (err?.name === 'AbortError') {
        const { abortCtrl: currentCtrl } = get();
        // If abortCtrl is already null, it was a timeout (we cleared it), not user stop
        if (currentCtrl === null) {
          finishWithText(activeId!, assistantMsg.id, '请求超时（超过2分钟），请重试');
        } else {
          finishWithText(activeId!, assistantMsg.id, '*[已停止]*');
        }
      } else {
        set(s => ({
          conversations: s.conversations.map(c =>
            c.id === activeId ? {
              ...c,
              messages: c.messages.map(m => m.id === assistantMsg.id ? { ...m, content: '请求失败: ' + errMsg } : m),
            } : c
          ),
          isSending: false,
          error: errMsg,
          abortCtrl: null,
        }));
        get().save();
      }
    }
  },

  stopGeneration: () => {
    const { abortCtrl } = get();
    if (abortCtrl) abortCtrl.abort();
  },
}));

// Helper: finish with text content
function finishWithText(activeId: string, msgId: string, content: string) {
  useChatStore.setState(s => ({
    conversations: s.conversations.map(c =>
      c.id === activeId ? {
        ...c,
        messages: c.messages.map(m => m.id === msgId ? { ...m, content } : m),
      } : c
    ),
    isSending: false,
    abortCtrl: null,
  }));
  useChatStore.getState().save();
}

// Helper: finish with generated image — save to gallery
async function finishWithImage(activeId: string, msgId: string, content: string, b64: string) {
  // Save to disk & register in gallery
  try {
    await api.saveChatImage(b64, activeId);
  } catch (e) {
    console.warn('保存图片到图库失败:', e);
  }

  useChatStore.setState(s => ({
    conversations: s.conversations.map(c =>
      c.id === activeId ? {
        ...c,
        messages: c.messages.map(m => m.id === msgId ? { ...m, content, generated_image: b64 } : m),
      } : c
    ),
    isSending: false,
    abortCtrl: null,
  }));
  useChatStore.getState().save();
}
