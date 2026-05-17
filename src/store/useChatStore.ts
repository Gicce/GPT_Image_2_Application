import { create } from 'zustand';
import type { ChatConversation, ChatMessage } from '../types';
import { api } from '../services/api';
import { serverApi } from '../services/serverApi';
import { useAuthStore } from './useAuthStore';
import { useSettingsStore } from './useSettingsStore';
import { explainError, isAuthError } from '../utils/errors';

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

        // 阶段动画：轮换提示词，让用户感知进度
        const stages = [
          '🎨 正在生成图片...',
          '🖼 正在渲染细节...',
          '✨ 正在优化画面...',
          '📦 正在打包结果...',
        ];
        let stageIdx = 0;
        const updateStage = () => {
          const stage = stages[stageIdx % stages.length];
          set(s => ({
            conversations: s.conversations.map(c =>
              c.id === activeId ? {
                ...c,
                messages: c.messages.map(m => m.id === assistantMsg.id ? {
                  ...m, content: stage, is_image: true,
                } : m),
              } : c
            ),
          }));
          stageIdx++;
        };
        updateStage();
        const stageTimer = setInterval(updateStage, 1800);

        let b64: string;
        try {
          if (options.editImage) {
            b64 = await api.chatEditImage(text || '编辑这张图片', model, options.editImage.filePath);
          } else {
            b64 = await api.chatGenerateImage(text, model);
          }
        } finally {
          clearInterval(stageTimer);
        }

        if (b64) {
          finishWithImage(activeId!, assistantMsg.id, '图片已生成', b64);
          // Report image usage
          const { isLoggedIn } = useAuthStore.getState();
          const s2 = useSettingsStore.getState().settings;
          if (isLoggedIn) {
            console.log('[reportImage] 上报图片用量: model=gpt-image-2, count=1');
            serverApi.reportImage('gpt-image-2', 1).then(res => {
              console.log('[reportImage] 上报成功:', res);
              const auth = useAuthStore.getState();
              const prev = auth.user?.account_type;
              if (res.group) auth.updateTokenBalance(res.group, res.balance_usd);
              if (res.account_type) {
                auth.updateAccountType(res.account_type);
                if (prev && prev !== 'normal' && res.account_type === 'normal') {
                  set({ error: '余额已耗尽，账户已自动降为普通账户。请前往「我的账户」充值后继续使用。' });
                }
              }
              // 没有 group 字段时刷一下 user
              if (!res.group) auth.refreshUser();
            }).catch((err: any) => {
              if (isAuthError(err)) {
                useAuthStore.getState().logout();
                useAuthStore.getState().showAuthPrompt();
              }
              set({ error: explainError(err) });
            });
          }
        } else {
          finishWithText(activeId!, assistantMsg.id, '图片生成失败：API 未返回图片数据');
        }
      } else {
        // 普通对话 — use chat API with chat token
        // 选中模型对应的 group 必须有 token
        const auth = useAuthStore.getState();
        if (!auth.isLoggedIn) {
          throw new Error('请先登录后再使用对话功能');
        }
        // settings.chat_token 已由 syncTokensToSettings 自动写入第一个 chat group token
        const token = settings.chat_token;
        if (!token) {
          throw new Error('当前账户暂无对话分组的 Token，请前往「我的账户」充值或申请试用');
        }

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
          body: JSON.stringify({
            model: settings.chat_model,
            messages: apiMessages,
            max_tokens: 4096,
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: abortCtrl.signal,
        });
        clearTimeout(timeoutId);

        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          const e: any = new Error(body.detail || body.error?.message || `HTTP ${resp.status}`);
          e.status = resp.status;
          e.detail = body.detail;
          throw e;
        }

        const contentType = resp.headers.get('content-type') || '';
        const isStream = contentType.includes('text/event-stream') && resp.body;

        let reply = '';
        let usageData: any = null;

        if (isStream) {
          const reader = resp.body!.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // SSE 以 \n\n 分割事件
            let idx;
            while ((idx = buffer.indexOf('\n\n')) !== -1) {
              const event = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              for (const line of event.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') continue;
                try {
                  const parsed = JSON.parse(data);
                  const delta = parsed.choices?.[0]?.delta?.content;
                  if (delta) {
                    reply += delta;
                    // 实时更新 assistant 消息内容
                    const currentReply = reply;
                    set(s => ({
                      conversations: s.conversations.map(c =>
                        c.id === activeId ? {
                          ...c,
                          messages: c.messages.map(m => m.id === assistantMsg.id ? {
                            ...m, content: currentReply,
                          } : m),
                        } : c
                      ),
                    }));
                  }
                  if (parsed.usage) usageData = parsed.usage;
                } catch {}
              }
            }
          }
          if (!reply) reply = '(空回复)';
        } else {
          // 后端不支持 stream，回退到一次性读取
          const data = await resp.json();
          reply = data.choices?.[0]?.message?.content || '(空回复)';
          usageData = data.usage;
        }

        // Report usage to backend (fire-and-forget)
        if (usageData) {
          const { isLoggedIn } = useAuthStore.getState();
          const s2 = useSettingsStore.getState().settings;
          if (isLoggedIn) {
            console.log('[reportChat] 上报对话用量:', settings.chat_model, usageData);
            serverApi.reportChat(
              settings.chat_model,
              usageData.prompt_tokens || usageData.input_tokens || 0,
              usageData.completion_tokens || usageData.output_tokens || 0,
              usageData.prompt_tokens_details?.cached_tokens || 0,
            ).then(res => {
              console.log('[reportChat] 上报成功:', res);
              const auth = useAuthStore.getState();
              const prev = auth.user?.account_type;
              if (res.group) auth.updateTokenBalance(res.group, res.balance_usd);
              if (res.account_type) {
                auth.updateAccountType(res.account_type);
                if (prev && prev !== 'normal' && res.account_type === 'normal') {
                  set({ error: '余额已耗尽，账户已自动降为普通账户。请前往「我的账户」充值后继续使用。' });
                }
              }
              if (!res.group) auth.refreshUser();
            }).catch((err: any) => {
              if (isAuthError(err)) {
                useAuthStore.getState().logout();
                useAuthStore.getState().showAuthPrompt();
              }
              set({ error: explainError(err) });
            });
          }
        }

        // Extract reasoning from <thinking> tags
        let reasoning = '';
        let reasoningDuration = '';
        const thinkingMatch = reply.match(/<thinking>([\s\S]*?)<\/thinking>/);
        if (thinkingMatch) {
          reasoning = thinkingMatch[1].trim();
          reply = reply.replace(/<thinking>[\s\S]*?<\/thinking>/, '').trim();
          reasoningDuration = '思考完成';
        }

        // Token 分发：本次新增的 user 消息 token = 当前 prompt_tokens - 上轮 prompt_tokens - 上轮 completion_tokens
        const promptTokens = usageData?.prompt_tokens ?? usageData?.input_tokens ?? 0;
        const completionTokens = usageData?.completion_tokens ?? usageData?.output_tokens ?? 0;
        let userInputTokens: number | undefined;
        if (usageData) {
          const conv = get().conversations.find(c => c.id === activeId);
          const lastPrompt = conv?.last_prompt_tokens ?? 0;
          const lastCompletion = conv?.last_completion_tokens ?? 0;
          // 首次：直接用 prompt_tokens；后续：扣掉上一轮已计入的 prompt + completion
          userInputTokens = Math.max(0, promptTokens - lastPrompt - lastCompletion);
        }

        set(s => ({
          conversations: s.conversations.map(c =>
            c.id === activeId ? {
              ...c,
              last_prompt_tokens: usageData ? promptTokens : c.last_prompt_tokens,
              last_completion_tokens: usageData ? completionTokens : c.last_completion_tokens,
              messages: c.messages.map(m => {
                if (m.id === assistantMsg.id) {
                  return {
                    ...m,
                    content: reply,
                    reasoning,
                    reasoning_duration: reasoningDuration,
                    output_tokens: usageData ? completionTokens : m.output_tokens,
                  };
                }
                if (m.id === userMsg.id && userInputTokens !== undefined) {
                  return { ...m, input_tokens: userInputTokens };
                }
                return m;
              }),
            } : c
          ),
          isSending: false,
          abortCtrl: null,
        }));
        get().save();
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        const { abortCtrl: currentCtrl } = get();
        if (currentCtrl === null) {
          finishWithText(activeId!, assistantMsg.id, '请求超时（超过2分钟），请重试');
        } else {
          finishWithText(activeId!, assistantMsg.id, '*[已停止]*');
        }
      } else {
        const friendly = explainError(err);
        // 401：自动登出并弹登录框
        if (isAuthError(err)) {
          useAuthStore.getState().logout();
          useAuthStore.getState().showAuthPrompt();
        }
        set(s => ({
          conversations: s.conversations.map(c =>
            c.id === activeId ? {
              ...c,
              messages: c.messages.map(m => m.id === assistantMsg.id ? { ...m, content: '❌ ' + friendly } : m),
            } : c
          ),
          isSending: false,
          error: friendly,
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
