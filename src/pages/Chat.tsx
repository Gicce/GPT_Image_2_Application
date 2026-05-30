import { useEffect, useRef, useState, useCallback } from 'react';
import { useChatStore } from '../store/useChatStore';
import { memo } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { useImageStore } from '../store/useImageStore';
import { useAuthStore, setGroupTypeMap, isGroupTypeMapReady } from '../store/useAuthStore';
import { api } from '../services/api';
import { serverApi, type ServerModel } from '../services/serverApi';
import type { ChatAttachment, ChatConversation, ChatMessage, GallerySearchCriteria, GallerySearchResult, GallerySearchState, ImageRecord } from '../types';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import { Command } from '@tauri-apps/plugin-shell';
import { invoke } from '@tauri-apps/api/core';
import DeleteConvDialog from '../components/DeleteConvDialog';
import ContextMeter from '../components/ContextMeter';
import { decideAgentAction } from '../utils/agentIntent';
import { resolveAgentConfig } from '../utils/agentConfig';
import {
  createGalleryCriteriaFromText as buildGalleryCriteriaFromText,
  DEFAULT_GALLERY_CRITERIA as DEFAULT_GALLERY_CRITERIA_RULES,
  galleryCriteriaToQuery as buildGalleryCriteriaQuery,
  getGalleryPresets as buildGalleryPresets,
  mergeGalleryCriteria as mergeGalleryCriteriaRules,
  type GalleryPreset,
  ORIENTATION_OPTIONS as ORIENTATION_OPTIONS_RULES,
  parseGalleryTimeRange as parseGalleryTimeRangeRule,
  queryTerms as buildGalleryQueryTerms,
  shouldUseSemanticSearch as shouldUseSemanticSearchRule,
  STYLE_OPTIONS as STYLE_OPTIONS_RULES,
  SUBJECT_OPTIONS as SUBJECT_OPTIONS_RULES,
  textMatchScore as getGalleryTextMatchScore,
  TIME_OPTIONS as TIME_OPTIONS_RULES,
  USAGE_OPTIONS as USAGE_OPTIONS_RULES,
} from '../utils/agent/galleryCriteria';
import 'highlight.js/styles/atom-one-dark.css';
import './Chat.css';
import './ImageEdit.css';

marked.setOptions({ breaks: true });
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('text', plaintext);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Custom code renderer: highlight.js + copy buttons
const renderer = new marked.Renderer();
const originalCode = renderer.code.bind(renderer);
renderer.code = function(code: any) {
  const raw = typeof code === 'string' ? code : (code.text ?? '');
  const lang = typeof code === 'object' ? (code.lang || '') : '';

  const isPromptBlock = lang === 'prompt' || lang === '提示词' || lang === 'template';
  const encoded = btoa(unescape(encodeURIComponent(raw)));

  if (isPromptBlock) {
    return `<div class="prompt-block"><div class="prompt-header"><span class="prompt-label">提示词</span><button class="prompt-copy-btn" data-code="${encoded}" type="button">复制提示词</button></div><pre class="prompt-body"><code>${escapeHtml(raw)}</code></pre></div>`;
  }

  let highlighted = '';
  try {
    highlighted = lang && hljs.getLanguage(lang)
      ? hljs.highlight(raw, { language: lang, ignoreIllegals: true }).value
      : hljs.highlightAuto(raw).value;
  } catch {
    return originalCode(code);
  }
  return `<pre class="code-block"><div class="code-header"><span class="code-lang">${lang || 'text'}</span><button class="code-copy-btn" data-code="${encoded}" type="button">复制</button></div><code class="hljs language-${lang || 'plaintext'}">${highlighted}</code></pre>`;
};

// Callout blockquote renderer
renderer.blockquote = function({ tokens, text }: any) {
  const rawText = (text || '').trim();
  const body = this.parser.parse(tokens);

  const calloutPatterns: Array<{ regex: RegExp; className: string; icon: string }> = [
    { regex: /^\[!WARNING\]/i,   className: 'callout-warning',  icon: '!' },
    { regex: /^\[!CAUTION\]/i,   className: 'callout-danger',   icon: '!' },
    { regex: /^\[!IMPORTANT\]/i, className: 'callout-important',icon: '!' },
    { regex: /^\[!NOTE\]/i,      className: 'callout-note',     icon: 'i' },
    { regex: /^\[!TIP\]/i,       className: 'callout-tip',      icon: '*' },
    { regex: /^[!]/,      className: 'callout-warning',  icon: '' },
    { regex: /^[*]/,      className: 'callout-tip',       icon: '' },
    { regex: /^[i]/,      className: 'callout-note',      icon: '' },
  ];

  for (const { regex, className, icon } of calloutPatterns) {
    if (regex.test(rawText)) {
      let cleanBody = body.replace(/<p>\[!\w+\]\s*/i, '<p>');
      const iconHtml = icon ? `<span class="callout-icon">${icon}</span>` : '';
      return `<div class="callout ${className}">${iconHtml}<div class="callout-content">${cleanBody}</div></div>`;
    }
  }

  return `<blockquote>${body}</blockquote>`;
};

marked.use({ renderer });

async function copyCodeBlock(encoded: string): Promise<boolean> {
  try {
    const text = decodeURIComponent(escape(atob(encoded)));
    return await copyTextToClipboard(text);
  } catch {
    return false;
  }
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    const cmd = Command.create('clip', [], { encoding: 'raw' });
    const child = await cmd.spawn();
    await child.write(new TextEncoder().encode(text));
    await child.kill();
    return true;
  } catch {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  }
}

function getInitials(name?: string | null, fallback = 'U'): string {
  const value = (name || '').trim();
  if (!value) return fallback;
  if (/[\u4e00-\u9fa5]/.test(value)) return value.match(/[\u4e00-\u9fa5]/)?.[0] || fallback;
  const parts = value.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return value.slice(0, 2).toUpperCase();
}

function getImageSourceLabel(sourceKind?: ImageRecord['source_kind']): string {
  if (sourceKind === 'library_input') return '本地目录';
  if (sourceKind === 'output') return '输出目录';
  if (sourceKind === 'postprocess') return '后处理';
  return '对话图片';
}

function buildAttachmentGuidance(attachments: ChatAttachment[], input: string): string | null {
  const galleryImages = attachments.filter(att => att.type === 'image' && att.source === 'gallery');
  if (galleryImages.length === 0) return null;

  if (input.trim()) {
    return `已选 ${galleryImages.length} 张图片。可以直接继续描述需求，Agent 会把这些图片作为参考图、编辑源图或图库分析对象。`;
  }

  if (galleryImages.length === 1) {
    return '已选 1 张图片。可继续让 Agent 图生图、分析题材、去背景或放大。';
  }

  return `已选 ${galleryImages.length} 张图片。可继续让 Agent 对比题材、挑选参考图或基于其中一张继续生成。`;
}

type PreviewImageState = {
  src: string;
  name?: string;
  width?: number | null;
  height?: number | null;
  createdAt?: string;
  localPath?: string;
};

function estimateConversationTokens(conv?: ChatConversation | null): number {
  if (!conv) return 0;
  if (typeof conv.last_prompt_tokens === 'number' && conv.last_prompt_tokens > 0) {
    return conv.last_prompt_tokens;
  }

  const liveMessages = conv.messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .slice(-10)
    .map(message => `${message.role === 'user' ? '用户' : '智能体'}：${message.content}`)
    .join('\n');
  const summary = conv.context_summary?.trim()
    ? `上下文摘要：\n${conv.context_summary.trim()}\n\n`
    : '';

  return Math.max(1, Math.ceil((summary + liveMessages).length / 3));
}

const CONVERSATION_ROW_HEIGHT = 46;
const CONVERSATION_OVERSCAN = 8;

const ConversationListItem = memo(function ConversationListItem({
  conversation,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  conversation: ChatConversation;
  active: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string, title: string) => void;
}) {
  return (
    <div className={`chat-conv-item ${active ? 'active' : ''}`} onClick={() => onSelect(conversation.id)}>
      <span
        className="chat-conv-title"
        onDoubleClick={(event) => {
          event.stopPropagation();
          onRename(conversation.id, conversation.title || '新对话');
        }}
      >
        {conversation.title || '新对话'}
      </span>
      <button
        className="chat-conv-del"
        onClick={(event) => {
          event.stopPropagation();
          onDelete(conversation.id, conversation.title || '新对话');
        }}
        title="删除"
      >
        ×
      </button>
    </div>
  );
});

function ConversationList({
  conversations,
  activeId,
  onSelect,
  onRename,
  onDelete,
}: {
  conversations: ChatConversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string, title: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const node = listRef.current;
    if (!node) return;

    const syncHeight = () => setViewportHeight(node.clientHeight);
    syncHeight();

    const observer = new ResizeObserver(syncHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const totalHeight = conversations.length * CONVERSATION_ROW_HEIGHT;
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / CONVERSATION_ROW_HEIGHT));
  const startIndex = Math.max(0, Math.floor(scrollTop / CONVERSATION_ROW_HEIGHT) - CONVERSATION_OVERSCAN);
  const endIndex = Math.min(
    conversations.length,
    startIndex + visibleCount + CONVERSATION_OVERSCAN * 2,
  );
  const visibleConversations = conversations.slice(startIndex, endIndex);
  const topSpacerHeight = startIndex * CONVERSATION_ROW_HEIGHT;
  const bottomSpacerHeight = Math.max(0, totalHeight - topSpacerHeight - visibleConversations.length * CONVERSATION_ROW_HEIGHT);

  return (
    <div
      ref={listRef}
      className="chat-conv-list"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      {conversations.length === 0 ? (
        <div className="chat-conv-empty">暂无对话</div>
      ) : (
        <div className="chat-conv-list-inner">
          {topSpacerHeight > 0 ? <div style={{ height: topSpacerHeight }} /> : null}
          {visibleConversations.map(conversation => (
            <ConversationListItem
              key={conversation.id}
              conversation={conversation}
              active={conversation.id === activeId}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
          {bottomSpacerHeight > 0 ? <div style={{ height: bottomSpacerHeight }} /> : null}
        </div>
      )}
    </div>
  );
}

export default function Chat() {
  const conversations = useChatStore(state => state.conversations);
  const activeId = useChatStore(state => state.activeId);
  const runtimeById = useChatStore(state => state.runtimeById);
  const error = useChatStore(state => state.error);
  const loadConversations = useChatStore(state => state.loadConversations);
  const newConversation = useChatStore(state => state.newConversation);
  const switchConversation = useChatStore(state => state.switchConversation);
  const deleteConversation = useChatStore(state => state.deleteConversation);
  const renameConversation = useChatStore(state => state.renameConversation);
  const sendMessage = useChatStore(state => state.sendMessage);
  const stopGeneration = useChatStore(state => state.stopGeneration);
  const confirmProposal = useChatStore(state => state.confirmProposal);
  const cancelProposal = useChatStore(state => state.cancelProposal);
  const updateProposalPrompt = useChatStore(state => state.updateProposalPrompt);
  const toggleProposalBatchItem = useChatStore(state => state.toggleProposalBatchItem);
  const { settings, saveSettings } = useSettingsStore();
  const { user, isLoggedIn } = useAuthStore();
  const [chatModels, setChatModels] = useState<ServerModel[]>([]);
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);
  const { images, loadImages } = useImageStore();
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const [deletingConv, setDeletingConv] = useState<{ id: string; title: string } | null>(null);
  const [deletingConvId, setDeletingConvId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showGalleryPicker, setShowGalleryPicker] = useState(false);
  const [gallerySourceFilter, setGallerySourceFilter] = useState<'all' | 'library_input' | 'output'>('all');
  const [galleryThumbs, setGalleryThumbs] = useState<Record<string, string>>({});
  const [gpLayoutMode, setGpLayoutMode] = useState<'3x3' | '4x4'>('4x4');
  const [gpSortOrder, setGpSortOrder] = useState<'desc' | 'asc'>('desc');
  const [gpPage, setGpPage] = useState(0);
  const [gpHoverPreview, setGpHoverPreview] = useState<{ id: string; url: string; x: number; y: number } | null>(null);
  const gpHoverCache = useRef<Record<string, string>>({});
  const gpHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [previewImage, setPreviewImage] = useState<PreviewImageState | null>(null);
  const [galleryFullImageCache, setGalleryFullImageCache] = useState<Record<string, string>>({});
  const [copySuccess, setCopySuccess] = useState(false);
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const chatInputAreaRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [composerHeight, setComposerHeight] = useState(96);
  const [galleryDrafts, setGalleryDrafts] = useState<Record<string, GallerySearchCriteria>>({});
  const resolvedAgentConfig = resolveAgentConfig(settings);

  const copyImageToClipboard = useCallback(async (imgSrc: string) => {
    try {
      const resp = await fetch(imgSrc);
      const blob = await resp.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d')!.drawImage(img, 0, 0);
        canvas.toBlob(async (blob) => {
          if (blob) {
            try {
              await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
              setCopySuccess(true);
              setTimeout(() => setCopySuccess(false), 2000);
            } catch { alert('复制失败'); }
          }
        });
      };
      img.src = imgSrc;
    }
  }, []);

  const openPreview = useCallback((src: string, meta?: Partial<PreviewImageState>) => {
    setPreviewImage({
      src,
      name: meta?.name,
      width: meta?.width,
      height: meta?.height,
      createdAt: meta?.createdAt,
      localPath: meta?.localPath,
    });
    setCopySuccess(false);
  }, []);

  const closePreview = useCallback(() => {
    setPreviewImage(null);
    setCopySuccess(false);
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ESC: close preview
      if (e.key === 'Escape' && previewImage) {
        e.preventDefault();
        closePreview();
        return;
      }
      // Ctrl+C: copy preview image
      if (e.ctrlKey && e.key === 'c' && previewImage && !window.getSelection()?.toString()) {
        e.preventDefault();
        copyImageToClipboard(previewImage.src);
        return;
      }
      // Ctrl+N: new conversation
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        newConversation();
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [previewImage, copyImageToClipboard, newConversation, closePreview]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { loadConversations(); }, []);

  // 拉取可用对话模型列表，并缓存 group 到 type 的映射
  useEffect(() => {
    if (!isLoggedIn) return;
    serverApi.getModels()
      .then(list => {
        setModelLoadError(null);
        if (list.length === 0) {
            console.warn('[Chat] /api/models 返回空数组，服务端可能未配置模型');
        }
        // 缓存 group -> model_type，供 token 同步和前端准入判断使用
        const map: Record<string, 'image' | 'agent' | 'postprocess' | 'chat'> = {};
        for (const m of list) {
          if (m.group) map[m.group] = m.model_type;
        }
        setGroupTypeMap(map);

        const chatList = list.filter(m => m.model_type === 'agent' || m.model_type === 'chat');
        const visionList = chatList.filter(m => m.supports_vision);
        setChatModels(chatList);
        if (chatList.length > 0 && !chatList.find(m => m.name === resolvedAgentConfig.model)) {
          const isTrial = user?.account_type === 'trial';
          const first = isTrial ? (chatList.find(m => m.trial_allowed) ?? chatList[0]) : chatList[0];
          if (first) {
            saveSettings({
              agent_model: first.name,
              chat_model: first.name,
              ...(settings.vision_model ? {} : { vision_model: (visionList[0] ?? first).name }),
            });
          }
        } else if (!settings.vision_model && visionList.length > 0) {
          saveSettings({ vision_model: visionList[0].name });
        }
      })
      .catch((err: any) => {
        if (err?.status === 401) {
          useAuthStore.getState().logout();
          useAuthStore.getState().showAuthPrompt();
        } else {
          console.error('[Chat] 加载模型列表失败:', err);
          setModelLoadError(err?.message || '加载模型列表失败');
        }
      });
  }, [user?.account_type, isLoggedIn, resolvedAgentConfig.model, saveSettings, settings.vision_model]);

  const activeConversationExists = !!activeId && conversations.some(conversation => conversation.id === activeId);
  const activeConv = activeConversationExists
    ? conversations.find(conversation => conversation.id === activeId) || null
    : null;
  const isSending = activeId ? !!runtimeById[activeId]?.isSending : false;
  const contextUsed = estimateConversationTokens(activeConv);
  const contextLimit = settings.agent_context_window || 32768;
  const showEmptyState = conversations.length === 0;
  const showWelcomeState = !showEmptyState && !!activeConv && activeConv.messages.length === 0;
  const showMessageState = !!activeConv && activeConv.messages.length > 0;

  // Scroll listener to track whether user is near bottom
  useEffect(() => {
    const el = chatAreaRef.current;
    if (!el) return;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      isNearBottomRef.current = near;
      setShowScrollBtn(!near);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-scroll only when near bottom
  useEffect(() => {
    if (chatAreaRef.current && isNearBottomRef.current) {
      chatAreaRef.current.scrollTop = chatAreaRef.current.scrollHeight;
    }
  }, [activeConv?.messages]);

  // Force scroll to bottom on conversation switch
  useEffect(() => {
    setGalleryDrafts({});
    if (chatAreaRef.current) {
      isNearBottomRef.current = true;
      chatAreaRef.current.scrollTop = chatAreaRef.current.scrollHeight;
      setShowScrollBtn(false);
    }
  }, [activeId]);

  // Load gallery thumbs when picker opens
  useEffect(() => {
    if (!showGalleryPicker) return;
    setGpPage(0);
    setGallerySourceFilter('all');
    setGalleryThumbs({});
    loadImages();
  }, [showGalleryPicker]);

  // Reset page when layout, sort or source filter changes
  useEffect(() => { setGpPage(0); }, [gpLayoutMode, gpSortOrder, gallerySourceFilter]);

  // Load thumbnails for current page
  useEffect(() => {
    if (!showGalleryPicker || images.length === 0) return;
    let cancelled = false;
    const gpPageSize = gpLayoutMode === '3x3' ? 9 : 16;
    const currentVisible = [...images]
      .filter(img => !img.missing)
      .filter(img => gallerySourceFilter === 'all' ? true : img.source_kind === gallerySourceFilter)
      .sort((a, b) => {
        const cmp = a.created_at.localeCompare(b.created_at);
        return gpSortOrder === 'desc' ? -cmp : cmp;
      })
      .slice(gpPage * gpPageSize, (gpPage + 1) * gpPageSize);
    const toLoad = currentVisible.filter(img => !galleryThumbs[img.id]);
    if (toLoad.length === 0) return;
    const load = async () => {
      for (const img of toLoad) {
        if (cancelled) return;
        try {
          const url = await api.readThumbnail(img.local_path);
          if (!cancelled) setGalleryThumbs(prev => ({ ...prev, [img.id]: url }));
        } catch {}
      }
    };
    load();
    return () => { cancelled = true; };
  }, [showGalleryPicker, images, gpPage, gpLayoutMode, gpSortOrder, gallerySourceFilter]);

  // Clear hover preview when picker closes
  useEffect(() => {
    if (!showGalleryPicker) {
      setGpHoverPreview(null);
      gpHoverCache.current = {};
    }
  }, [showGalleryPicker]);

  const getPlaceholder = () => '给 Agent 发送任务、问题或图片需求（Shift+Enter 换行）';

  const addAttachment = (attachment: Omit<ChatAttachment, 'id'>) => {
    setAttachments(prev => {
      if (attachment.filePath && prev.some(item => item.filePath === attachment.filePath)) {
        return prev;
      }
      return [...prev, {
        ...attachment,
        id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      }];
    });
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  const patchGalleryMessage = useCallback((messageId: string, patch: Partial<GallerySearchState>, content?: string) => {
    useChatStore.setState(s => ({
      conversations: s.conversations.map(c => ({
        ...c,
        messages: c.messages.map(m => {
          if (m.id !== messageId) return m;
          const current = m.gallery_search;
          return {
            ...m,
            content: content ?? m.content,
            gallery_search: current ? { ...current, ...patch } : undefined,
          };
        }),
      })),
    }));
  }, []);

  const appendGalleryClarification = useCallback((query: string) => {
    let currentId = useChatStore.getState().activeId;
    if (!currentId) currentId = newConversation();
    const now = Date.now();
    const criteria = buildGalleryCriteriaFromText(query);
    const userMsg: ChatMessage = {
      id: 'm' + now,
      role: 'user',
      content: query,
      created_at: new Date().toISOString(),
    };
    const assistantMsg: ChatMessage = {
      id: 'm' + (now + 1),
      role: 'assistant',
      content: '请补充检索条件，我会按你的选择筛选本地图库。',
      created_at: new Date().toISOString(),
      gallery_search: {
        status: 'clarify',
        query,
        criteria,
        results: [],
        shown: 4,
        semanticLimited: false,
        notice: '先选择推荐方案或手动补充条件，再开始检索。',
      },
    };
    useChatStore.setState(s => ({
      conversations: s.conversations.map(c =>
        c.id === currentId ? {
          ...c,
          title: c.title || query.slice(0, 30),
          messages: [...c.messages, userMsg, assistantMsg],
        } : c
      ),
      error: null,
    }));
    setGalleryDrafts(prev => ({ ...prev, [assistantMsg.id]: criteria }));
    useChatStore.getState().save();
    setTimeout(() => {
      if (chatAreaRef.current) chatAreaRef.current.scrollTop = chatAreaRef.current.scrollHeight;
    }, 0);
  }, [newConversation]);

  const buildLocalContextSummary = useCallback((conversation: ChatConversation) => {
    const liveMessages = conversation.messages
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .slice(-24);

    if (liveMessages.length === 0) {
      return '';
    }

    return liveMessages
      .map(message => {
        const speaker = message.role === 'user' ? '用户' : '智能体';
        const content = (message.content || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 220);
        return `${speaker}：${content}`;
      })
      .join('\n')
      .slice(0, 2500);
  }, []);

  const applyLocalContextCompression = useCallback((announce: boolean) => {
    const currentId = useChatStore.getState().activeId;
    if (!currentId) return false;

    const conversation = useChatStore.getState().conversations.find(item => item.id === currentId);
    if (!conversation) return false;

    const summary = buildLocalContextSummary(conversation);
    const nowIso = new Date().toISOString();

    useChatStore.setState(state => ({
      conversations: state.conversations.map(item => {
        if (item.id !== currentId) return item;

        const nextMessages = announce
          ? [
              ...item.messages,
              {
                id: 'm' + Date.now(),
                role: 'assistant' as const,
                content: summary ? '上下文已压缩' : '暂无可压缩内容',
                created_at: nowIso,
              },
            ]
          : item.messages;

        return {
          ...item,
          context_summary: summary,
          context_summary_updated_at: nowIso,
          last_prompt_tokens: Math.max(1, estimateConversationTokens({
            ...item,
            last_prompt_tokens: undefined,
            context_summary: summary,
            context_summary_updated_at: nowIso,
          })),
          messages: nextMessages,
        };
      }),
      error: null,
    }));
    void useChatStore.getState().save();

    if (announce) {
      setTimeout(() => {
        if (chatAreaRef.current) chatAreaRef.current.scrollTop = chatAreaRef.current.scrollHeight;
      }, 0);
    }

    return true;
  }, [buildLocalContextSummary]);

  const handleSend = useCallback(async (planOnly = false) => {
    const text = input.trim();
    if (!text && !attachments.length) return;
    if (isSending) return;
    const agentAccessBlocked = isLoggedIn && isGroupTypeMapReady() && (chatModels.length === 0 || !resolvedAgentConfig.token);
    if (agentAccessBlocked) {
      localStorage.setItem('cy_recharge_focus', 'agent');
      useAuthStore.getState().setRequestedPage('account');
      return;
    }
    if (text === '/压缩' && attachments.length === 0) {
      applyLocalContextCompression(true);
      setInput('');
      if (inputRef.current) inputRef.current.style.height = 'auto';
      return;
    }
    if (contextLimit > 0 && contextUsed / contextLimit >= 0.95 && activeConv?.messages.length) {
      applyLocalContextCompression(false);
    }

    if (!resolvedAgentConfig.token) {
      alert('当前账户暂无智能体额度，请前往“我的账户”充值或申请试用');
      return;
    }

    const actionDecision = decideAgentAction({
      text,
      hasImageAttachments: attachments.some(attachment => attachment.type === 'image'),
      hasEditableImage: attachments.some(attachment => attachment.type === 'image' && !!attachment.filePath),
      planOnly,
    });

    if (!planOnly && attachments.length === 0 && actionDecision.type === 'clarify_gallery') {
      setInput('');
      if (inputRef.current) inputRef.current.style.height = 'auto';
      appendGalleryClarification(text);
      return;
    }
    if (!planOnly && attachments.length === 0 && actionDecision.type === 'direct_gallery_search') {
      setInput('');
      if (inputRef.current) inputRef.current.style.height = 'auto';
      appendDirectGallerySearch(text, actionDecision.criteria);
      return;
    }

    setInput('');
    setAttachments([]);
    if (inputRef.current) inputRef.current.style.height = 'auto';

    await sendMessage(text || '(附件)', {
      chat_token: settings.chat_token,
      token: settings.token,
      chat_model: settings.chat_model,
      chat_base_url: settings.chat_base_url,
      chat_system_prompt: settings.chat_system_prompt,
      agent_token: settings.agent_token,
      agent_model: settings.agent_model,
      agent_base_url: settings.agent_base_url,
      agent_system_prompt: settings.agent_system_prompt,
      agent_context_window: settings.agent_context_window,
      vision_model: settings.vision_model,
    }, { planOnly, attachments });
  }, [input, attachments, isSending, isLoggedIn, chatModels.length, contextLimit, contextUsed, activeConv, resolvedAgentConfig.token, settings, sendMessage, applyLocalContextCompression, appendGalleryClarification, appendDirectGallerySearch]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(false); }
  };

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  const handlePickImage = async () => {
    const path = await api.selectImageFile();
    if (!path) return;
    const dataUrl = await api.readImageData(path);
    addAttachment({
      type: 'image',
      source: 'upload',
      name: path.split(/[\\/]/).pop() || 'image.png',
      dataUrl,
      filePath: path,
    });
  };

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = reader.result as string;
          if (dataUrl) {
            const store = useChatStore.getState();
            const conversationId = store.activeId || store.newConversation();
            try {
              const saved = await api.saveChatImage(dataUrl, conversationId);
              addAttachment({
                type: 'image',
                source: 'paste',
                name: saved.file_name || `粘贴图片_${Date.now()}.png`,
                dataUrl,
                filePath: saved.local_path,
              });
            } catch (error) {
              console.error('粘贴图片保存本地失败', error);
              addAttachment({
                type: 'image',
                source: 'paste',
                name: `粘贴图片_${Date.now()}.png`,
                dataUrl,
              });
              useChatStore.setState({
                error: '粘贴图片已添加，但保存到本地失败；当前图片不会作为可编辑参考图参与任务执行。',
              });
            }
          }
        };
        reader.readAsDataURL(file);
      }
    }
  }, []);

  const handleAddFile = async () => {
    try {
      const result = await invoke<{ name: string; content: string; size: number } | null>('select_text_file');
      if (result) {
        addAttachment({
          type: 'file',
          source: 'upload',
          name: result.name,
          content: result.content,
          size: result.size,
        });
      }
    } catch (e) {
      console.error('选择文件失败', e);
    }
  };

  const handleVoiceInput = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('当前环境不支持语音输入');
      return;
    }
    if (isListening) {
      recognitionRef.current?.stop?.();
      setIsListening(false);
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results || [])
        .map((r: any) => r?.[0]?.transcript || '')
        .join('');
      if (transcript) {
        setInput(prev => prev ? `${prev}${prev.endsWith(' ') ? '' : ' '}${transcript}` : transcript);
        setTimeout(() => {
          if (inputRef.current) autoResize(inputRef.current);
        }, 0);
      }
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;
    setIsListening(true);
    recognition.start();
  };

  const handleGpMouseEnter = (e: React.MouseEvent<HTMLDivElement>, imgId: string, localPath: string) => {
    if (gpHoverTimer.current) clearTimeout(gpHoverTimer.current);
    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.right + 8;
    const y = rect.top;
    gpHoverTimer.current = setTimeout(async () => {
      if (gpHoverCache.current[imgId]) {
        setGpHoverPreview({ id: imgId, url: gpHoverCache.current[imgId], x, y });
        return;
      }
      try {
        const url = await api.readImageData(localPath);
        gpHoverCache.current[imgId] = url;
        setGpHoverPreview({ id: imgId, url, x, y });
      } catch {}
    }, 1500);
  };

  const handleGpMouseLeave = () => {
    if (gpHoverTimer.current) clearTimeout(gpHoverTimer.current);
    gpHoverTimer.current = setTimeout(() => setGpHoverPreview(null), 100);
  };

  const handleSelectGalleryImage = async (image: ImageRecord) => {
    if (image.missing) {
      useChatStore.setState({ error: '该图片文件已移动或不存在，无法加入当前任务。' });
      return;
    }

    try {
      const dataUrl = await api.readImageData(image.local_path);
      addAttachment({
        type: 'image',
        source: 'gallery',
        name: image.file_name || image.local_path.split(/[\\/]/).pop() || 'gallery-image.png',
        dataUrl,
        filePath: image.local_path,
      });
    } catch {
      useChatStore.setState({ error: '读取原图失败，请检查文件是否仍然存在。' });
    }
  };

  const patchGalleryResult = useCallback((messageId: string, imageId: string, updater: (result: GallerySearchResult) => GallerySearchResult) => {
    useChatStore.setState(state => ({
      conversations: state.conversations.map(conversation => ({
        ...conversation,
        messages: conversation.messages.map(message => {
          if (message.id !== messageId || !message.gallery_search) return message;
          return {
            ...message,
            gallery_search: {
              ...message.gallery_search,
              results: message.gallery_search.results.map(result => result.image.id === imageId ? updater(result) : result),
            },
          };
        }),
      })),
    }));
  }, []);

  const handleConfirmDeleteConversation = useCallback(() => {
    if (!deletingConv || deletingConvId) return;
    setDeletingConvId(deletingConv.id);
    try {
      deleteConversation(deletingConv.id);
      setDeletingConv(null);
    } finally {
      setDeletingConvId(null);
    }
  }, [deleteConversation, deletingConv, deletingConvId]);

  const handlePreviewGalleryResult = useCallback(async (messageId: string, result: GallerySearchResult) => {
    if (result.image.missing) {
      useChatStore.setState({ error: '该图片文件已移动或不存在，无法预览。' });
      return;
    }
    if (result.fullImageUrl) {
      openPreview(result.fullImageUrl, {
        name: result.image.file_name,
        width: result.image.width,
        height: result.image.height,
        createdAt: result.image.created_at,
        localPath: result.image.local_path,
      });
      return;
    }

    patchGalleryResult(messageId, result.image.id, current => ({ ...current, selectionState: 'selecting' }));
    try {
      const cached = galleryFullImageCache[result.image.local_path];
      const fullImageUrl = cached || await api.readImageData(result.image.local_path);
      if (!cached) {
        setGalleryFullImageCache(prev => ({ ...prev, [result.image.local_path]: fullImageUrl }));
      }
      patchGalleryResult(messageId, result.image.id, current => ({
        ...current,
        fullImageUrl,
        selectionState: current.selectionState === 'selected' ? 'selected' : 'idle',
      }));
      openPreview(fullImageUrl, {
        name: result.image.file_name,
        width: result.image.width,
        height: result.image.height,
        createdAt: result.image.created_at,
        localPath: result.image.local_path,
      });
    } catch {
      patchGalleryResult(messageId, result.image.id, current => ({ ...current, selectionState: 'preview_error' }));
      useChatStore.setState({ error: '原图预览失败，请使用“系统打开”查看原图。' });
    } finally {
      void useChatStore.getState().save();
    }
  }, [galleryFullImageCache, openPreview, patchGalleryResult]);

  const handleSelectGalleryResult = useCallback(async (messageId: string, result: GallerySearchResult) => {
    if (result.image.missing) {
      patchGalleryResult(messageId, result.image.id, current => ({ ...current, selectionState: 'preview_error' }));
      useChatStore.setState({ error: '该图片文件已移动或不存在，无法加入当前任务。' });
      return;
    }
    patchGalleryResult(messageId, result.image.id, current => ({ ...current, selectionState: 'selecting' }));
    try {
      const dataUrl = galleryFullImageCache[result.image.local_path] || await api.readImageData(result.image.local_path);
      if (!galleryFullImageCache[result.image.local_path]) {
        setGalleryFullImageCache(prev => ({ ...prev, [result.image.local_path]: dataUrl }));
      }
      addAttachment({
        type: 'image',
        source: 'gallery',
        name: result.image.file_name,
        dataUrl,
        filePath: result.image.local_path,
      });
      patchGalleryResult(messageId, result.image.id, current => ({
        ...current,
        fullImageUrl: current.fullImageUrl || dataUrl,
        selectionState: 'selected',
      }));
    } catch {
      patchGalleryResult(messageId, result.image.id, current => ({ ...current, selectionState: 'preview_error' }));
      useChatStore.setState({ error: '加入任务失败，请重试。' });
    } finally {
      void useChatStore.getState().save();
    }
  }, [galleryFullImageCache, patchGalleryResult]);

  const handleOpenGalleryResult = useCallback(async (result: GallerySearchResult) => {
    if (result.image.missing) {
      useChatStore.setState({ error: '该图片文件已移动或不存在。' });
      return;
    }
    try {
      await api.openFile(result.image.local_path);
    } catch {
      useChatStore.setState({ error: '打开原图失败，请检查文件是否仍然存在。' });
    }
  }, []);

  const describeGalleryImage = useCallback(async (img: ImageRecord): Promise<{ description: string; tags: string[] } | null> => {
    const token = resolvedAgentConfig.token;
    const model = resolvedAgentConfig.model;
    const baseUrl = resolvedAgentConfig.baseUrl;
    if (!token || !model || !baseUrl) return null;
    try {
      const dataUrl = await api.readImageData(img.local_path);
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: '请用中文简短描述这张图片的主体、风格、背景、用途，并给出 5-8 个关键词。只输出一行。' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          }],
          temperature: 0.2,
          max_tokens: 180,
        }),
      });
      if (!resp.ok) return null;
      const json = await resp.json();
      const description = String(json?.choices?.[0]?.message?.content || '').trim();
      if (!description) return null;
      const tags = description
        .split(/[，,、\s]+/)
        .map((t: string) => t.trim())
        .filter((t: string) => t.length >= 2)
        .slice(0, 12);
      return { description, tags };
    } catch {
      return null;
    }
  }, [resolvedAgentConfig.baseUrl, resolvedAgentConfig.model, resolvedAgentConfig.token]);

  const ensureGalleryIndex = useCallback(async (img: ImageRecord, needDescription: boolean): Promise<{ image: ImageRecord; semanticLimited: boolean }> => {
    let next = img;
    let semanticLimited = false;
    let width = img.width ?? null;
    let height = img.height ?? null;
    try {
      if (!width || !height) {
        const meta = await api.getImageMeta(img.local_path);
        width = meta.width;
        height = meta.height;
        next = await api.updateImageIndex(img.id, width, height, img.description || null, img.tags || []);
      }
    } catch {
      semanticLimited = true;
    }

    if (needDescription && !next.description) {
      const described = await describeGalleryImage(next);
      if (described) {
        try {
          next = await api.updateImageIndex(next.id, width, height, described.description, described.tags);
        } catch {
          next = { ...next, description: described.description, tags: described.tags, width, height };
        }
      } else {
        semanticLimited = true;
      }
    }
    return { image: next, semanticLimited };
  }, [describeGalleryImage]);

  const runGallerySearch = useCallback(async (messageId: string, query: string, criteria: GallerySearchCriteria) => {
    const finalQuery = buildGalleryCriteriaQuery(query, criteria);
    const needsSemantic = shouldUseSemanticSearchRule(criteria, query);
    const emptyNotice = criteria.timeRange === '昨天'
      ? '昨天没有找到生成记录。'
      : criteria.timeRange === '今天'
        ? '今天没有找到生成记录。'
        : '没有找到匹配图片，可以放宽时间或描述条件。';
    const updateProgress = (percent: number, label: string) => {
      patchGalleryMessage(messageId, {
        status: 'searching',
        criteria,
        progress: { percent, label },
      }, label);
    };
    updateProgress(8, '正在读取本地图像记录');
    try {
      const allImages = await api.getImages();
      updateProgress(22, `读取到 ${allImages.length} 张图片，正在筛选候选`);
      const terms = needsSemantic ? buildGalleryQueryTerms(finalQuery) : [];
      const range = parseGalleryTimeRangeRule(finalQuery);
      const rough = allImages
        .filter(img => !img.missing)
        .filter(img => {
          if (!range) return true;
          const time = Date.parse(img.created_at);
          return Number.isFinite(time) && time >= range.start && time < range.end;
        })
        .map(img => {
          const haystack = [img.file_name, img.status, img.description || '', ...(img.tags || [])].join(' ');
          const time = Date.parse(img.created_at);
          const roughScore = getGalleryTextMatchScore(terms, haystack) + (Number.isFinite(time) ? time / 1e13 : 0);
          return { img, roughScore };
        })
        .sort((a, b) => b.roughScore - a.roughScore)
        .slice(0, needsSemantic ? 30 : 16);
      updateProgress(36, needsSemantic ? `候选 ${rough.length} 张，正在补充分辨率和语义索引` : `候选 ${rough.length} 张，正在补充分辨率`);

      let semanticLimited = false;
      const indexed: ImageRecord[] = [];
      for (let i = 0; i < rough.length; i++) {
        const needDescription = needsSemantic && i < 12 && terms.length > 0;
        const result = await ensureGalleryIndex(rough[i].img, needDescription);
        semanticLimited = semanticLimited || result.semanticLimited;
        indexed.push(result.image);
        const percent = 36 + Math.round(((i + 1) / Math.max(rough.length, 1)) * 42);
        updateProgress(percent, needsSemantic ? `正在索引候选图 ${i + 1}/${rough.length}` : `正在读取图片信息 ${i + 1}/${rough.length}`);
      }

      updateProgress(84, '正在计算匹配度、分辨率和时间排序');
      const now = Date.now();
      const scored = await Promise.all(indexed.map(async (img) => {
        const haystack = [img.file_name, img.status, img.description || '', ...(img.tags || [])].join(' ');
        const semanticScore = getGalleryTextMatchScore(terms, haystack);
        const time = Date.parse(img.created_at);
        const timeScore = range && Number.isFinite(time) && time >= range.start && time < range.end ? 22 : 0;
        const area = (img.width || 0) * (img.height || 0);
        const resolutionScore = Math.min(16, area / 180000);
        const recencyScore = Number.isFinite(time) ? Math.max(0, 10 - (now - time) / 86400000 / 30) : 0;
        const score = semanticScore + timeScore + resolutionScore + recencyScore;
        const matched = terms.filter(t => haystack.toLowerCase().includes(t)).slice(0, 4);
        const reasonParts = [
          matched.length ? `匹配 ${matched.join(' / ')}` : '按文件名、时间和分辨率排序',
          range ? `时间范围：${range.label}` : '',
          img.width && img.height ? `分辨率 ${img.width}x${img.height}` : '',
        ].filter(Boolean);
        let thumbUrl = '';
        try { thumbUrl = await api.readThumbnail(img.local_path); } catch {}
        return {
          image: img,
          thumbUrl,
          score,
          reason: reasonParts.join('，'),
          selectionState: 'idle' as const,
        };
      }));

      const results = scored.sort((a, b) => b.score - a.score);
      patchGalleryMessage(messageId, {
        status: results.length > 0 ? 'done' : 'empty',
        query,
        criteria,
        results,
        shown: 4,
        semanticLimited,
        progress: { percent: 100, label: '检索完成' },
        notice: results.length > 0 ? `已按条件筛选出 ${results.length} 张候选图片。` : emptyNotice,
      }, results.length > 0 ? '检索完成，下面是最匹配的图片。' : emptyNotice);
      setTimeout(() => {
        if (chatAreaRef.current) chatAreaRef.current.scrollTop = chatAreaRef.current.scrollHeight;
      }, 0);
    } catch {
      patchGalleryMessage(messageId, {
        status: 'failed',
        query,
        criteria,
        results: [],
        shown: 4,
        semanticLimited: true,
        progress: { percent: 100, label: '检索失败' },
        notice: '图库检索失败，请稍后重试',
      }, '图库检索失败，请稍后重试');
    }
    useChatStore.getState().save();
  }, [ensureGalleryIndex, patchGalleryMessage]);

  function appendDirectGallerySearch(query: string, criteria: GallerySearchCriteria) {
    let currentId = useChatStore.getState().activeId;
    if (!currentId) currentId = newConversation();
    const now = Date.now();
    const userMsg: ChatMessage = {
      id: 'm' + now,
      role: 'user',
      content: query,
      created_at: new Date().toISOString(),
    };
    const assistantMsg: ChatMessage = {
      id: 'm' + (now + 1),
      role: 'assistant',
      content: '正在检索图库…',
      created_at: new Date().toISOString(),
      gallery_search: {
        status: 'searching',
        query,
        criteria,
        results: [],
        shown: 4,
        semanticLimited: false,
        progress: { percent: 0, label: '正在准备检索条件' },
        notice: '正在准备检索本地图库。',
      },
    };
    useChatStore.setState(state => ({
      conversations: state.conversations.map(conversation =>
        conversation.id === currentId ? {
          ...conversation,
          title: conversation.title || query.slice(0, 30),
          messages: [...conversation.messages, userMsg, assistantMsg],
        } : conversation
      ),
      error: null,
    }));
    setGalleryDrafts(prev => ({ ...prev, [assistantMsg.id]: criteria }));
    void useChatStore.getState().save();
    setTimeout(() => {
      if (chatAreaRef.current) chatAreaRef.current.scrollTop = chatAreaRef.current.scrollHeight;
    }, 0);
    void runGallerySearch(assistantMsg.id, query, criteria);
  }

  const updateGalleryDraft = useCallback((messageId: string, updater: (draft: GallerySearchCriteria) => GallerySearchCriteria) => {
    setGalleryDrafts(prev => {
      const current = prev[messageId]
        || activeConv?.messages.find(m => m.id === messageId)?.gallery_search?.criteria
        || DEFAULT_GALLERY_CRITERIA_RULES;
      return { ...prev, [messageId]: updater(current) };
    });
  }, [activeConv?.messages]);

  const applyGalleryPreset = useCallback((messageId: string, preset: GalleryPreset) => {
    updateGalleryDraft(messageId, draft => mergeGalleryCriteriaRules(draft, preset.criteria));
  }, [updateGalleryDraft]);

  const startGallerySearch = useCallback((message: ChatMessage) => {
    if (!message.gallery_search || message.gallery_search.status !== 'clarify') return;
    const criteria = galleryDrafts[message.id] || message.gallery_search.criteria;
    patchGalleryMessage(message.id, {
      status: 'searching',
      criteria,
      progress: { percent: 0, label: '准备检索' },
      results: [],
      shown: 4,
      semanticLimited: false,
      notice: '正在按已选条件检索图库。',
    }, '正在检索图库...');
    runGallerySearch(message.id, message.gallery_search.query, criteria);
  }, [galleryDrafts, patchGalleryMessage, runGallerySearch]);

  const closeGalleryPanel = useCallback((messageId: string) => {
    useChatStore.setState(s => ({
      conversations: s.conversations.map(c => ({
        ...c,
        messages: c.messages.map(m => m.id === messageId ? { ...m, gallery_search: undefined } : m),
      })),
    }));
    setGalleryDrafts(prev => {
      const next = { ...prev };
      delete next[messageId];
      return next;
    });
    useChatStore.getState().save();
  }, []);

  const showMoreGalleryResults = useCallback((messageId: string) => {
    patchGalleryMessage(messageId, {
      shown: (activeConv?.messages.find(m => m.id === messageId)?.gallery_search?.shown || 4) + 4,
    });
  }, [activeConv?.messages, patchGalleryMessage]);

  const agentAccessBlocked = isLoggedIn && isGroupTypeMapReady() && (chatModels.length === 0 || !resolvedAgentConfig.token);
  const disabledInput = isSending || agentAccessBlocked;
  const attachmentGuidance = buildAttachmentGuidance(attachments, input);

  useEffect(() => {
    const node = chatInputAreaRef.current;
    if (!node) return;

    const syncHeight = () => {
      setComposerHeight(Math.ceil(node.getBoundingClientRect().height));
    };

    syncHeight();
    const observer = new ResizeObserver(syncHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, [agentAccessBlocked, attachments.length]);

  const goRechargeAgent = () => {
    localStorage.setItem('cy_recharge_focus', 'agent');
    useAuthStore.getState().setRequestedPage('account');
  };

  const handleConfirmProposal = useCallback(async (messageId: string) => {
    if (!activeId) return;
    await confirmProposal(activeId, messageId, {
      chat_token: settings.chat_token,
      token: settings.token,
      chat_model: settings.chat_model,
      chat_base_url: settings.chat_base_url,
      chat_system_prompt: settings.chat_system_prompt,
      agent_token: settings.agent_token,
      agent_model: settings.agent_model,
      agent_base_url: settings.agent_base_url,
      agent_system_prompt: settings.agent_system_prompt,
      agent_context_window: settings.agent_context_window,
    });
  }, [activeId, confirmProposal, settings]);

  const handleCancelProposal = useCallback(async (messageId: string) => {
    if (!activeId) return;
    await cancelProposal(activeId, messageId);
  }, [activeId, cancelProposal]);

  const handleUpdateProposal = useCallback(async (messageId: string, finalPrompt: string, finalNegativePrompt: string) => {
    if (!activeId) return;
    await updateProposalPrompt(activeId, messageId, finalPrompt, finalNegativePrompt);
  }, [activeId, updateProposalPrompt]);

  const handleToggleProposalBatchItem = useCallback(async (messageId: string, itemId: string) => {
    if (!activeId) return;
    await toggleProposalBatchItem(activeId, messageId, itemId);
  }, [activeId, toggleProposalBatchItem]);

  const handleRenameConversation = useCallback((id: string, currentTitle: string) => {
    const title = prompt('重命名对话', currentTitle || '新对话');
    if (title !== null && title.trim()) renameConversation(id, title.trim());
  }, [renameConversation]);

  const handleDeleteConversation = useCallback((id: string, title: string) => {
    setDeletingConv({ id, title: title || '新对话' });
  }, []);

  return (
    <div className="chat-page">
      <div className={`chat-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="chat-sidebar-header">
          <button className="chat-btn-new" onClick={() => newConversation()}>+ 新对话</button>
        </div>
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          onSelect={switchConversation}
          onRename={handleRenameConversation}
          onDelete={handleDeleteConversation}
        />
      </div>

      <div className="chat-main">
        <div className="chat-header">
          <button className="chat-toggle-sidebar-btn" onClick={() => setSidebarCollapsed(v => !v)} title="展开/收起侧边栏">
            <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <span className="chat-model-label">
            {resolvedAgentConfig.model || 'Agent'}
            {resolvedAgentConfig.hasOverrides ? ' · Agent配置' : ' · Chat兜底'}
          </span>
          <ContextMeter used={contextUsed} limit={contextLimit} />
          {agentAccessBlocked && <span className="chat-no-token">AI 智能体额度未开通</span>}
        </div>

        <div className="chat-area" ref={chatAreaRef}>
          <div className="chat-inner" key={activeId || 'empty'}>
            {showEmptyState ? (
              <div className="chat-welcome">
                <h2>{settings.agent_name || 'CyImage Agent'}</h2>
                <p>暂无对话，点击左侧“新对话”开始新的聊天。</p>
              </div>
            ) : showWelcomeState ? (
              <div className="chat-welcome">
                <h2>{settings.agent_name || 'CyImage Agent'}</h2>
                <p>描述你的图片需求，智能体会自动选择文生图、图生图、图库检索和后处理工具。</p>
              </div>
            ) : showMessageState && activeConv ? (
              activeConv.messages.map(m => (
                <MessageItem
                  key={m.id}
                  message={m}
                  isStreaming={isSending && m.id === activeConv.messages[activeConv.messages.length - 1]?.id && m.role === 'assistant'}
                  onImageClick={openPreview}
                  userName={user?.username}
                  agentName={settings.agent_name || 'AI'}
                  userAvatar={settings.user_avatar_data_url}
                  aiAvatar={settings.ai_avatar_data_url}
                  galleryDraft={galleryDrafts[m.id]}
                  onGalleryDraftChange={updateGalleryDraft}
                  onApplyGalleryPreset={applyGalleryPreset}
                  onStartGallerySearch={startGallerySearch}
                  onCloseGalleryPanel={closeGalleryPanel}
                  onShowMoreGalleryResults={showMoreGalleryResults}
                  onPreviewGalleryImage={handlePreviewGalleryResult}
                  onSelectGalleryImage={handleSelectGalleryResult}
                  onOpenGalleryImage={handleOpenGalleryResult}
                  onConfirmProposal={handleConfirmProposal}
                  onCancelProposal={handleCancelProposal}
                  onUpdateProposal={handleUpdateProposal}
                  onToggleProposalBatchItem={handleToggleProposalBatchItem}
                />
              ))
            ) : null}
            {isSending && (
              <div className="chat-stop-row">
                <button className="chat-btn-stop" onClick={() => stopGeneration(activeId || undefined)}>停止生成</button>
              </div>
            )}
          </div>
        </div>

        {false && null}








        {showScrollBtn && (
          <button
            className="scroll-to-bottom"
            style={{ bottom: `${composerHeight + 14}px` }}
            onClick={() => {
              if (chatAreaRef.current) {
                chatAreaRef.current.scrollTop = chatAreaRef.current.scrollHeight;
                isNearBottomRef.current = true;
                setShowScrollBtn(false);
              }
            }}
          >
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M12 5v14M5 12l7 7 7-7"/>
            </svg>
          </button>
        )}

        {error && (
          <div className="chat-error">
            <div className="chat-error-text">{error}</div>
            <button
              className="chat-error-copy"
              onClick={() => copyTextToClipboard(error)}
              title="复制错误信息以便反馈"
            >
              复制
            </button>
          </div>
        )}

        <div className="chat-input-area" ref={chatInputAreaRef}>
          <div className="chat-input-wrapper">
            {agentAccessBlocked && (
              <div className="agent-paywall-banner">
                <div>
                  <strong>开通 AI 智能体后即可使用</strong>
                  <span>支持 Agent 对话、文生图、图生图、图库理解和后处理工具调度。</span>
                </div>
                <button onClick={goRechargeAgent}>去充值开通</button>
              </div>
            )}
            <div className="chat-input-box">
              {attachments.length > 0 && (
                <div className="agent-attachments">
                  {attachments.map(att => (
                    <div key={att.id} className={`agent-attachment ${att.type}`}>
                      {att.type === 'image' && att.dataUrl ? (
                        <img src={att.dataUrl} alt={att.name} />
                      ) : (
                        <span className="agent-attachment-file">FILE</span>
                      )}
                      <div className="agent-attachment-meta">
                        <span className="agent-attachment-name">{att.name}</span>
                        <span className="agent-attachment-source">
                          {att.source === 'gallery' ? '图库' : att.source === 'paste' ? '粘贴' : '本地'}
                          {att.size ? ` 路 ${att.size < 1024 ? att.size + 'B' : (att.size / 1024).toFixed(1) + 'KB'}` : ''}
                        </span>
                      </div>
                      <button className="agent-attachment-remove" onClick={() => removeAttachment(att.id)} title="移除">×</button>
                    </div>
                  ))}
                </div>
              )}
              {attachmentGuidance && (
                <div className="agent-attachment-guidance">{attachmentGuidance}</div>
              )}
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => { setInput(e.target.value); autoResize(e.target); }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={agentAccessBlocked ? '请先开通 AI 智能体额度' : isSending ? '等待回复中...' : getPlaceholder()}
                disabled={disabledInput}
                rows={1}
              />
              <div className="chat-input-bottom">
                <div className="chat-input-left">
                    <button className="chat-input-btn" onClick={handleAddFile} disabled={disabledInput} title="添加文件">
                    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                  </button>
                  <button className="chat-input-btn" onClick={handlePickImage} disabled={disabledInput} title="添加照片">
                    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                  </button>
                  <button className="chat-input-btn" onClick={() => setShowGalleryPicker(true)} disabled={disabledInput} title="从图库选择">
                    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                  </button>
                  <button className={`chat-input-btn ${isListening ? 'active' : ''}`} onClick={handleVoiceInput} disabled={disabledInput} title={isListening ? '停止语音输入' : '语音输入'}>
                    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><path d="M12 19v3"/></svg>
                  </button>
                </div>
                <div className="chat-input-right">
                  <button
                    className="chat-plan-btn"
                    onClick={() => handleSend(true)}
                    disabled={(!input.trim() && !attachments.length) || disabledInput}
                    title="只生成计划，不执行工具"
                  >
                    计划
                  </button>
                  <button
                    className={`chat-btn-send ${(!input.trim() && !attachments.length) || disabledInput ? 'disabled' : ''}`}
                    onClick={() => handleSend(false)}
                    disabled={(!input.trim() && !attachments.length) || disabledInput}
                    title="发送"
                  >
                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                  </button>
                </div>
              </div>
            </div>
            <div className="chat-disclaimer-row">
              <ModelPicker
                models={chatModels}
                value={resolvedAgentConfig.model}
                isTrial={user?.account_type === 'trial'}
                onChange={(name) => saveSettings({ agent_model: name, chat_model: name })}
              />
              <span className="chat-disclaimer">AI 可能产生错误信息，请核实重要内容</span>
            </div>
            {modelLoadError && (
              <div className="chat-model-error">
                <span>模型列表加载失败：{modelLoadError}</span>
                <button onClick={() => {
                  setModelLoadError(null);
                  serverApi.getModels()
                    .then(list => {
                      const map: Record<string, 'image' | 'agent' | 'postprocess' | 'chat'> = {};
                      for (const m of list) if (m.group) map[m.group] = m.model_type;
                      setGroupTypeMap(map);
                      setChatModels(list.filter(m => m.model_type === 'agent' || m.model_type === 'chat'));
                    })
                    .catch(() => setModelLoadError('重试失败，请检查网络'));
                }}>重试</button>
                <button onClick={() => setModelLoadError(null)}>关闭</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Image preview modal */}
      {previewImage && (
        <div className="chat-modal-overlay" onClick={closePreview}>
          <div className="img-preview-modal" onClick={e => e.stopPropagation()}>
            <div className="img-preview-header">
              <div className="img-preview-meta">
                <strong>{previewImage.name || '图片预览'}</strong>
                <span>
                  {previewImage.width && previewImage.height ? `${previewImage.width}x${previewImage.height}` : '分辨率未知'}
                  {previewImage.createdAt ? ` · ${new Date(previewImage.createdAt).toLocaleString()}` : ''}
                </span>
              </div>
            </div>
            <div className="img-preview-toolbar">
              <button className="img-preview-btn" onClick={() => copyImageToClipboard(previewImage.src)}>
                {copySuccess ? '已复制' : '复制图片'}
              </button>
              <button className="img-preview-btn" onClick={async () => {
                await api.saveImageAs(previewImage.src, previewImage.name || `image_${Date.now()}.png`);
              }}>保存图片</button>
              {previewImage.localPath && (
                <button className="img-preview-btn" onClick={() => api.openFile(previewImage.localPath!)}>
                  系统打开原图
                </button>
              )}
              <button className="img-preview-close" onClick={closePreview}>×</button>
            </div>
            <img className="img-preview-full" src={previewImage.src} alt={previewImage.name || '图片预览'} />
          </div>
        </div>
      )}

      {/* Gallery picker modal */}
      {showGalleryPicker && (() => {
        const gpPageSize = gpLayoutMode === '3x3' ? 9 : 16;
        const gpCols = gpLayoutMode === '3x3' ? 3 : 4;
        const gpSorted = [...images]
          .filter(img => gallerySourceFilter === 'all' ? true : img.source_kind === gallerySourceFilter)
          .sort((a, b) => {
            const cmp = a.created_at.localeCompare(b.created_at);
            return gpSortOrder === 'desc' ? -cmp : cmp;
          });
        const gpVisible = gpSorted.slice(gpPage * gpPageSize, (gpPage + 1) * gpPageSize);
        const gpTotalPages = Math.ceil(gpSorted.length / gpPageSize);
        return (
          <div className="gp-overlay" onClick={() => setShowGalleryPicker(false)}>
            <div className="gp-modal" onClick={e => e.stopPropagation()}>
              <div className="gp-header">
                <h3 className="gp-title">从图库选择</h3>
                <div className="gp-header-right">
                  <button
                    className="gp-sort-btn"
                    onClick={() => setGpSortOrder(o => o === 'desc' ? 'asc' : 'desc')}
                    title={gpSortOrder === 'desc' ? '当前：最新优先' : '当前：最早优先'}
                  >{gpSortOrder === 'desc' ? '→ 最新' : '→ 最早'}</button>
                  <div className="gp-layout-switcher">
                    {(['3x3', '4x4'] as const).map(m => (
                      <button key={m} className={`gp-layout-btn${gpLayoutMode === m ? ' active' : ''}`} onClick={() => setGpLayoutMode(m)}>{m}</button>
                    ))}
                  </div>
                  <div className="gp-source-switcher">
                    {[
                      { key: 'all', label: '全部' },
                      { key: 'library_input', label: '本地目录' },
                      { key: 'output', label: '输出目录' },
                    ].map(option => (
                      <button
                        key={option.key}
                        className={`gp-source-btn${gallerySourceFilter === option.key ? ' active' : ''}`}
                        onClick={() => setGallerySourceFilter(option.key as 'all' | 'library_input' | 'output')}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <button className="gp-close" onClick={() => setShowGalleryPicker(false)}>×</button>
                </div>
              </div>

              {gpSorted.length === 0 ? (
                <div className="gp-empty">图库暂无图片</div>
              ) : (
                <div className="gp-grid" style={{ gridTemplateColumns: `repeat(${gpCols}, 1fr)` }}>
                  {gpVisible.map(img => {
                    const url = img.missing ? '' : galleryThumbs[img.id];
                    const alreadySelected = attachments.some(att => att.filePath === img.local_path);
                    return (
                      <div
                        key={img.id}
                        className={`gp-item${img.missing ? ' missing' : ''}${alreadySelected ? ' selected' : ''}`}
                        onClick={() => !img.missing && handleSelectGalleryImage(img)}
                        onMouseEnter={e => !img.missing && handleGpMouseEnter(e, img.id, img.local_path)}
                        onMouseLeave={handleGpMouseLeave}
                        title={img.missing ? `${img.file_name}（文件已移动或不存在）` : img.file_name}
                      >
                        {url ? <img src={url} alt={img.file_name} draggable={false} /> : <div className="gp-placeholder">{img.missing ? '文件缺失' : '...'}</div>}
                        <div className="gp-item-meta">
                          <span className="gp-item-name">{img.file_name}</span>
                          <span className="gp-item-source">
                            {getImageSourceLabel(img.source_kind)}
                            {alreadySelected ? ' · 已加入当前任务' : ''}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="gp-footer">
                <span className="gp-hint">点击有效图片加入当前任务，缺失文件不会进入附件区。</span>
                <div className="gp-pagination">
                  <button className="gp-page-btn" onClick={() => setGpPage(p => Math.max(0, p - 1))} disabled={gpPage === 0}>‹</button>
                  <span className="gp-page-info">{gpPage + 1} / {gpTotalPages || 1}</span>
                  <button className="gp-page-btn" onClick={() => setGpPage(p => Math.min(gpTotalPages - 1, p + 1))} disabled={gpPage >= gpTotalPages - 1}>›</button>
                </div>
                <div className="gp-footer-btns">
                  <button className="gp-btn-cancel" onClick={() => setShowGalleryPicker(false)}>关闭</button>
                </div>
              </div>

              {gpHoverPreview && gpHoverPreview.url && (
                <div
                  className="gp-hd-preview"
                  style={{ left: gpHoverPreview.x, top: gpHoverPreview.y }}
                  onMouseEnter={() => { if (gpHoverTimer.current) clearTimeout(gpHoverTimer.current); }}
                  onMouseLeave={handleGpMouseLeave}
                >
                  <img src={gpHoverPreview.url} alt="" draggable={false} />
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {deletingConv && (
        <DeleteConvDialog
          convTitle={deletingConv.title}
          busy={deletingConvId === deletingConv.id}
          onConfirm={handleConfirmDeleteConversation}
          onCancel={() => { if (!deletingConvId) setDeletingConv(null); }}
        />
      )}
    </div>
  );
}

const MessageItem = memo(function MessageItem({
  message, isStreaming, onImageClick, userName, agentName, userAvatar, aiAvatar,
  galleryDraft, onGalleryDraftChange, onApplyGalleryPreset, onStartGallerySearch,
  onCloseGalleryPanel, onShowMoreGalleryResults, onPreviewGalleryImage, onSelectGalleryImage, onOpenGalleryImage,
  onConfirmProposal, onCancelProposal, onUpdateProposal, onToggleProposalBatchItem,
}: {
  message: ChatMessage;
  isStreaming: boolean;
  onImageClick: (url: string) => void;
  userName?: string;
  agentName?: string;
  userAvatar?: string;
  aiAvatar?: string;
  galleryDraft?: GallerySearchCriteria;
  onGalleryDraftChange: (messageId: string, updater: (draft: GallerySearchCriteria) => GallerySearchCriteria) => void;
  onApplyGalleryPreset: (messageId: string, preset: GalleryPreset) => void;
  onStartGallerySearch: (message: ChatMessage) => void;
  onCloseGalleryPanel: (messageId: string) => void;
  onShowMoreGalleryResults: (messageId: string) => void;
  onPreviewGalleryImage: (messageId: string, result: GallerySearchResult) => void;
  onSelectGalleryImage: (messageId: string, result: GallerySearchResult) => void;
  onOpenGalleryImage: (result: GallerySearchResult) => void;
  onConfirmProposal: (messageId: string) => Promise<void>;
  onCancelProposal: (messageId: string) => Promise<void>;
  onUpdateProposal: (messageId: string, finalPrompt: string, finalNegativePrompt: string) => Promise<void>;
  onToggleProposalBatchItem: (messageId: string, itemId: string) => Promise<void>;
}) {
  const isUser = message.role === 'user';
  const contentRef = useRef<HTMLDivElement>(null);
  const [reasoningOpen, setReasoningOpen] = useState(true);
  const avatar = isUser ? userAvatar : aiAvatar;
  const initials = isUser ? getInitials(userName, 'U') : getInitials(agentName, 'AI');

  useEffect(() => {
    if (!contentRef.current) return;
    if (isUser && message.images?.length) {
      contentRef.current.innerHTML = '';
      const textEl = document.createElement('div');
      textEl.textContent = message.content;
      contentRef.current.appendChild(textEl);
      message.images.forEach(url => {
        const img = document.createElement('img');
        img.src = url; img.className = 'msg-thumb';
        img.onclick = () => onImageClick(url);
        contentRef.current!.appendChild(img);
      });
      return;
    }
    if (!isUser && message.content) {
      const html = marked.parse(message.content) as string;
      contentRef.current.innerHTML = html;
      // 内联 code 样式和复制按钮
      contentRef.current.querySelectorAll('code:not(pre code)').forEach((el) => {
        (el as HTMLElement).classList.add('inline-code');
        const wrap = document.createElement('span');
        wrap.className = 'inline-code-wrap';
        const btn = document.createElement('button');
        btn.className = 'inline-copy-btn';
        btn.type = 'button';
        btn.textContent = '复制';
        const codeText = (el as HTMLElement).textContent || '';
        btn.dataset.code = btoa(unescape(encodeURIComponent(codeText)));
        (el as HTMLElement).parentNode!.insertBefore(wrap, el);
        wrap.appendChild(el);
        wrap.appendChild(btn);
      });
    }
  }, [message.content, message.images, isUser, onImageClick]);

  useEffect(() => () => {
    if (contentRef.current) contentRef.current.innerHTML = '';
  }, []);

  // 事件代理处理代码复制按钮
  useEffect(() => {
    const container = contentRef.current;
    if (!container || isUser) return;
    const handler = async (e: Event) => {
      const target = e.target as HTMLElement;
      const btn = (target.closest('.code-copy-btn') || target.closest('.inline-copy-btn') || target.closest('.prompt-copy-btn')) as HTMLButtonElement | null;
      if (!btn) return;
      const encoded = btn.dataset.code || '';
      const ok = await copyCodeBlock(encoded);
      if (ok) {
        const original = btn.textContent;
        btn.textContent = '已复制';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = original;
          btn.classList.remove('copied');
        }, 1500);
      }
    };
    container.addEventListener('click', handler);
    return () => container.removeEventListener('click', handler);
  }, [isUser]);

  const generatedImgUrl = message.generated_image ? `data:image/png;base64,${message.generated_image}` : null;
  const isImageStage = !isUser && isStreaming && message.is_image && !generatedImgUrl;

  return (
    <div className={`chat-msg ${message.role} ${isStreaming ? 'streaming' : ''}`}>
      <div className={`chat-msg-avatar ${isUser ? 'user' : 'ai'}`}>
        {avatar ? <img src={avatar} alt={isUser ? '用户头像' : 'AI 头像'} /> : initials}
      </div>
      <div className="chat-msg-body">
        <div className="chat-msg-role">{isUser ? (userName || '用户') : (agentName || 'AI')}</div>
        {!isUser && message.reasoning && (
          <div className="reasoning-block">
            <div className={`reasoning-header ${reasoningOpen ? 'open' : ''}`} onClick={() => setReasoningOpen(v => !v)}>
              <svg width="14" height="14" fill="currentColor" viewBox="0 0 16 16"><path d="M6 12l4-4-4-4" fill="none" stroke="currentColor" strokeWidth="2"/></svg>
              <span className="thinking-label">思考过程</span>
              {message.reasoning_duration && <span className="reasoning-duration">{message.reasoning_duration}</span>}
            </div>
            <div className={`reasoning-body ${reasoningOpen ? 'open' : ''}`} dangerouslySetInnerHTML={{ __html: marked.parse(message.reasoning) as string }} />
          </div>
        )}
        {!isUser && generatedImgUrl && (
          <div className="generated-img-container" onClick={() => onImageClick(generatedImgUrl)}>
            <img src={generatedImgUrl} alt="生成的图片" />
            <div className="gen-img-overlay">
              <span>点击查看大图</span>
            </div>
          </div>
        )}
        {isImageStage ? (
          <div className="chat-image-stage">
            <div className="image-stage-loader" />
            <div className="image-stage-text">{message.content}</div>
          </div>
        ) : (
          <div className="chat-msg-content" ref={contentRef}>
            {isUser ? message.content : (message.content || (isStreaming ? <span className="chat-thinking">思考中<span className="dots">...</span></span> : null))}
          </div>
        )}
        {!isUser && message.gallery_search && (
          <GallerySearchPanel
            message={message}
            draft={galleryDraft || message.gallery_search.criteria}
            onDraftChange={onGalleryDraftChange}
            onApplyPreset={onApplyGalleryPreset}
            onStartSearch={onStartGallerySearch}
            onClose={onCloseGalleryPanel}
            onShowMore={onShowMoreGalleryResults}
            onPreviewImage={onPreviewGalleryImage}
            onSelectImage={onSelectGalleryImage}
            onOpenOriginal={onOpenGalleryImage}
          />
        )}
        {!isUser && message.agent_proposal && ['draft', 'submitting'].includes(message.agent_proposal.status) && (
          <AgentProposalCard
            messageId={message.id}
            proposal={message.agent_proposal}
            onConfirm={onConfirmProposal}
            onCancel={onCancelProposal}
            onUpdate={onUpdateProposal}
            onToggleBatchItem={onToggleProposalBatchItem}
          />
        )}
        {/* Token 鐠侊繝鍣哄鑺ョ垼 */}
        {isUser && message.input_tokens !== undefined && (
          <div className="msg-token-badge">{message.input_tokens} tokens</div>
        )}
        {!isUser && !isStreaming && message.output_tokens !== undefined && !message.is_image && (
          <div className="msg-token-badge">{message.output_tokens} tokens</div>
        )}
      </div>
    </div>
  );
});


const AgentProposalCard = memo(function AgentProposalCard({
  messageId,
  proposal,
  onConfirm,
  onCancel,
  onUpdate,
  onToggleBatchItem,
}: {
  messageId: string;
  proposal: NonNullable<ChatMessage['agent_proposal']>;
  onConfirm: (messageId: string) => Promise<void>;
  onCancel: (messageId: string) => Promise<void>;
  onUpdate: (messageId: string, finalPrompt: string, finalNegativePrompt: string) => Promise<void>;
  onToggleBatchItem: (messageId: string, itemId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(proposal.final_prompt);
  const [negativePrompt, setNegativePrompt] = useState(proposal.final_negative_prompt);

  useEffect(() => {
    setPrompt(proposal.final_prompt);
    setNegativePrompt(proposal.final_negative_prompt);
  }, [proposal.final_prompt, proposal.final_negative_prompt]);

  const intentLabel = proposal.intent === 'image_edit'
    ? '图生图'
    : proposal.intent === 'remove_background'
      ? '去背景'
      : proposal.intent === 'upscale'
        ? '高清放大'
        : '文生图';
  const enabledBatchCount = proposal.batch_items?.filter(item => item.enabled !== false).length || 0;

  return (
    <div className="agent-proposal-card">
      <div className="agent-proposal-head">
        <strong>任务提案</strong>
        <span>{intentLabel}</span>
      </div>
      <div className="agent-proposal-grid">
        <div><span>原始需求</span><p>{proposal.user_prompt_raw}</p></div>
        <div><span>推荐执行方式</span><p>{proposal.recommended_action}</p></div>
        <div><span>执行接口</span><p>{proposal.api_kind}</p></div>
        <div><span>源图数量</span><p>{proposal.source_images.length}</p></div>
        <div><span>主任务模板</span><p>{proposal.matched_task_template_name || '未命中模板'}</p></div>
        <div><span>风格模板</span><p>{proposal.matched_style_template_names?.join('、') || '无'}</p></div>
        <div><span>执行模式</span><p>{proposal.execution_mode === 'batch' ? `批量 / ${proposal.batch_strategy}` : '单任务'}</p></div>
        <div><span>批量数量</span><p>{proposal.execution_mode === 'batch' ? `${enabledBatchCount} / ${proposal.batch_items?.length || 0}` : '1'}</p></div>
        {proposal.task_plan_summary ? <div><span>任务计划</span><p>{proposal.task_plan_summary}</p></div> : null}
      </div>
      <div className="agent-proposal-field">
        <span>优化后的提示词</span>
        {editing ? (
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={4} />
        ) : (
          <p>{proposal.final_prompt}</p>
        )}
      </div>
      <div className="agent-proposal-field">
        <span>负面提示词</span>
        {editing ? (
          <textarea value={negativePrompt} onChange={e => setNegativePrompt(e.target.value)} rows={2} />
        ) : (
          <p>{proposal.final_negative_prompt || '无'}</p>
        )}
      </div>
      {proposal.execution_mode === 'batch' && proposal.batch_items?.length ? (
        <div className="agent-proposal-field">
          <span>子任务计划</span>
          <div className="agent-batch-items">
            {proposal.batch_items.map(item => (
              <label key={item.id} className={`agent-batch-item ${item.enabled === false ? 'disabled' : ''}`}>
                <input
                  type="checkbox"
                  checked={item.enabled !== false}
                  disabled={proposal.status !== 'draft'}
                  onChange={() => onToggleBatchItem(messageId, item.id)}
                />
                <div>
                  <strong>{item.label}</strong>
                  <p>{item.prompt_delta || '沿用主提示词执行。'}</p>
                </div>
              </label>
            ))}
          </div>
        </div>
      ) : null}
      <div className="agent-proposal-actions">
        {proposal.status === 'draft' && (
          <>
            <button type="button" className="primary" onClick={() => onConfirm(messageId)}>
              {proposal.execution_mode === 'batch' ? '确认执行选中项' : '确认执行'}
            </button>
            {editing ? (
              <button type="button" onClick={async () => {
                await onUpdate(messageId, prompt, negativePrompt);
                setEditing(false);
              }}>保存提示词</button>
            ) : (
              <button type="button" onClick={() => setEditing(true)}>修改提示词</button>
            )}
            <button type="button" onClick={() => onCancel(messageId)}>取消</button>
          </>
        )}
        {proposal.status === 'submitting' && <span className="agent-proposal-state">正在创建任务...</span>}
        {proposal.status === 'confirmed' && <span className="agent-proposal-state">已确认并创建任务</span>}
        {proposal.status === 'cancelled' && <span className="agent-proposal-state">已取消</span>}
      </div>
    </div>
  );
});

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter(v => v !== value) : [...values, value];
}

function GallerySearchPanel({
  message, draft, onDraftChange, onApplyPreset, onStartSearch, onClose,
  onShowMore, onPreviewImage, onSelectImage, onOpenOriginal,
}: {
  message: ChatMessage;
  draft: GallerySearchCriteria;
  onDraftChange: (messageId: string, updater: (draft: GallerySearchCriteria) => GallerySearchCriteria) => void;
  onApplyPreset: (messageId: string, preset: GalleryPreset) => void;
  onStartSearch: (message: ChatMessage) => void;
  onClose: (messageId: string) => void;
  onShowMore: (messageId: string) => void;
  onPreviewImage: (messageId: string, result: GallerySearchResult) => void;
  onSelectImage: (messageId: string, result: GallerySearchResult) => void;
  onOpenOriginal: (result: GallerySearchResult) => void;
}) {
  const search = message.gallery_search!;
  const presets = buildGalleryPresets(search.query);
  const locked = search.status === 'searching';

  return (
    <div className="gallery-search-panel">
      <div className="gallery-search-head">
        <div className="gallery-search-title-row">
          <strong>{search.status === 'clarify' ? '补充图库检索条件' : '图库筛选'}</strong>
          <button type="button" className="gallery-search-close" onClick={() => onClose(message.id)} title="关闭图库筛选">×</button>
        </div>
        <span>{search.notice || `需求：${search.query}`}</span>
        {search.semanticLimited && (
          <em>视觉模型不可用或部分索引失败，当前结果已降级为文件名、时间和分辨率匹配。</em>
        )}
      </div>

      {search.status === 'clarify' && (
        <div className="gallery-clarify">
          <div className="gallery-presets">
            {presets.map(preset => (
              <button key={preset.label} type="button" onClick={() => onApplyPreset(message.id, preset)}>
                {preset.label}
              </button>
            ))}
          </div>

          <OptionGroup
            title="时间范围"
            options={[...TIME_OPTIONS_RULES]}
            selected={[draft.timeRange || '']}
            mode="single"
            onToggle={(value) => onDraftChange(message.id, d => ({ ...d, timeRange: value }))}
          />
          <OptionGroup
            title="题材/主体"
            options={[...SUBJECT_OPTIONS_RULES]}
            selected={draft.subjects}
            mode="multi"
            onToggle={(value) => onDraftChange(message.id, d => ({ ...d, subjects: toggleValue(d.subjects, value) }))}
          />
          <OptionGroup
            title="风格/方向"
            options={[...STYLE_OPTIONS_RULES]}
            selected={draft.styles}
            mode="multi"
            onToggle={(value) => onDraftChange(message.id, d => ({ ...d, styles: toggleValue(d.styles, value) }))}
          />
          <OptionGroup
            title="图片方向"
            options={[...ORIENTATION_OPTIONS_RULES]}
            selected={[draft.orientation || '不限']}
            mode="single"
            onToggle={(value) => onDraftChange(message.id, d => ({ ...d, orientation: value }))}
          />
          <OptionGroup
            title="用途"
            options={[...USAGE_OPTIONS_RULES]}
            selected={[draft.usage || '仅查看']}
            mode="single"
            onToggle={(value) => onDraftChange(message.id, d => ({ ...d, usage: value }))}
          />

          <label className="gallery-extra">
            <span>附加条件</span>
            <textarea
              value={draft.extra}
              onChange={e => onDraftChange(message.id, d => ({ ...d, extra: e.target.value }))}
              placeholder="例如：只要竖图、不要黑白、偏真实人物、优先高分辨率"
              rows={2}
            />
          </label>

          <div className="gallery-clarify-actions">
            <button type="button" className="gallery-start-search" onClick={() => onStartSearch(message)}>
              开始检索
            </button>
          </div>
        </div>
      )}

      {locked && (
        <div className="gallery-search-progress" aria-label="图库检索进度">
          <div style={{ width: `${search.progress?.percent || 0}%` }} />
        </div>
      )}

      {(search.status === 'done' || search.status === 'empty' || search.status === 'failed') && (
        search.results.length > 0 ? (
          <>
            <div className="gallery-search-grid">
              {search.results.slice(0, search.shown).map(result => (
                <div className={`gallery-search-card ${result.selectionState === 'selected' ? 'selected' : ''}${result.image.missing ? ' missing' : ''}`} key={result.image.id}>
                  <button type="button" className="gallery-search-thumb" onClick={() => onPreviewImage(message.id, result)} disabled={!!result.image.missing}>
                    {result.thumbUrl ? <img src={result.thumbUrl} alt={result.image.file_name} /> : <span>无预览</span>}
                    <span className="gallery-search-thumb-overlay">预览原图</span>
                  </button>
                  <div className="gallery-search-meta">
                    <strong title={result.image.file_name}>{result.image.file_name}</strong>
                    <span>{new Date(result.image.created_at).toLocaleString()}</span>
                    <span>{result.image.width && result.image.height ? `${result.image.width}x${result.image.height}` : '分辨率未知'}</span>
                    <p>{result.reason}</p>
                  </div>
                  <div className="gallery-search-state">
                    {result.image.missing ? '文件已移动或不存在' :
                      result.selectionState === 'selected' ? '已加入当前任务' :
                      result.selectionState === 'selecting' ? '处理中…' :
                      result.selectionState === 'preview_error' ? '原图读取失败，可直接系统打开' :
                      '点击预览或加入任务'}
                  </div>
                  <div className="gallery-search-actions">
                    <button type="button" onClick={() => onPreviewImage(message.id, result)} disabled={!!result.image.missing}>预览</button>
                    <button type="button" className={result.selectionState === 'selected' ? 'is-selected' : ''} onClick={() => onSelectImage(message.id, result)} disabled={!!result.image.missing}>
                      {result.selectionState === 'selected' ? '已加入' : '加入任务'}
                    </button>
                    <button type="button" onClick={() => onOpenOriginal(result)} disabled={!!result.image.missing}>系统打开</button>
                  </div>
                </div>
              ))}
            </div>
            {search.shown < search.results.length && (
              <button className="gallery-search-more" onClick={() => onShowMore(message.id)}>
                加载更多
              </button>
            )}
          </>
        ) : (
          <div className="gallery-search-empty">{search.notice || '没有找到匹配图片，可以放宽时间或描述条件。'}</div>
        )
      )}
    </div>
  );
}

function OptionGroup({
  title, options, selected, mode, onToggle,
}: {
  title: string;
  options: string[];
  selected: string[];
  mode: 'single' | 'multi';
  onToggle: (value: string) => void;
}) {
  return (
    <div className="gallery-option-group">
      <div className="gallery-option-title">
        <span>{title}</span>
        <em>{mode === 'multi' ? '可多选' : '单选'}</em>
      </div>
      <div className="gallery-option-list">
        {options.map(option => {
          const active = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              className={active ? 'active' : ''}
              onClick={() => onToggle(option)}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ModelPicker({ models, value, isTrial, onChange }: { models: ServerModel[]; value: string; isTrial: boolean; onChange: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const current = models.find(m => m.name === value);
  const display = current?.display_name || current?.name || value || '选择模型';

  return (
    <div className="model-picker" ref={wrapRef}>
      <button
        type="button"
        className={`model-picker-btn ${open ? 'open' : ''}`}
        onClick={() => setOpen(v => !v)}
      >
        <span className="model-picker-name">{display}</span>
        <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className="model-picker-panel">
          {models.length === 0 ? (
            <div className="model-option empty">暂无可用模型</div>
          ) : (
            models.map(m => {
              const disabled = isTrial && !m.trial_allowed;
              const selected = m.name === value;
              return (
                <div
                  key={m.name}
                  className={`model-option ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}
                  title={disabled ? '试用账户暂不可用' : undefined}
                  onClick={() => {
                    if (disabled) return;
                    onChange(m.name);
                    setOpen(false);
                  }}
                >
                  <span className="model-option-name">{m.display_name || m.name}</span>
                  {m.group && <span className="model-option-group">{m.group}</span>}
                  {disabled && <span className="model-option-tag">付费</span>}
                  {selected && !disabled && (
                    <svg className="model-option-check" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M13.5 4.5L6 12 2.5 8.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

