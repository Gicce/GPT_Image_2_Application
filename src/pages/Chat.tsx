import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useChatStore } from '../store/useChatStore';
import { useAIProviderStore, resolveConversationAgent } from '../features/aiProviders/store';
import { isNewlyDiscovered } from '../features/aiProviders/registry/registry';
import { resolveProfileBaseUrl } from '../features/aiProviders/adapters';
import { ProviderLogo } from '../features/aiProviders/ProviderLogo';
import { isSyntheticAssistantMessage } from '../utils/agent/historySanitizer';
import type { AIProviderModel } from '../features/aiProviders/types';
import { defaultUseScopes } from '../features/aiProviders/types';
import { BILLING_MODE_LABELS } from '../features/aiProviders/types';
import { memo } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { useImageStore } from '../store/useImageStore';
import { useTaskStore } from '../store/useTaskStore';
import { useAuthStore, isGroupTypeMapReady } from '../store/useAuthStore';
import { useServerModelStore } from '../store/useServerModelStore';
import { api } from '../services/api';
import type { ChatAttachment, ChatConversation, ChatMessage, ChatMode, GallerySearchCriteria, GallerySearchResult, GallerySearchState, ImageRecord } from '../types';
import TaskMessageCard from '../components/TaskMessageCard';
import { collectConversationImages, type ConversationImageOption } from '../utils/agent/taskSourceImage';
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
import { toastSuccess, toastError } from '../components/Toast';
import { setAsAvatarFromDataUrl } from '../services/avatarService';
import ContextMeter from '../components/ContextMeter';
import { dedupeGalleryItems, normalizeGalleryPath } from '../utils/galleryIdentity';
import { decideAgentAction } from '../utils/agentIntent';
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
import { SKILL_REGISTRY, getSkillById, detectSkill } from '../agent/skills';
import { getAttachmentDisplayLabel } from '../utils/agent/attachmentLabels';
import { formatConversationForClipboard } from '../utils/conversationExport';
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

// Inline code renderer: emits the wrap+button as part of the HTML string so we
// never have to touch the DOM after React mounts it. Click handling is done
// via event delegation in MessageItem.
renderer.codespan = function(token: any) {
  const rawHtml = typeof token === 'string' ? token : (token?.text ?? '');
  const decoded = rawHtml
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const encoded = btoa(unescape(encodeURIComponent(decoded)));
  return `<span class="inline-code-wrap"><code class="inline-code">${rawHtml}</code><button class="inline-copy-btn" data-code="${encoded}" type="button">复制</button></span>`;
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

function imageIdFromPath(path: string): string | null {
  if (!path) return null;
  const fileName = path.split(/[\\/]/).pop() || path;
  const match = fileName.match(/^([0-9a-fA-F]{8,}-[0-9a-fA-F]{4,}-[0-9a-fA-F]{4,}-[0-9a-fA-F]{4,}-[0-9a-fA-F]{12,})/);
  return match ? match[1] : null;
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

// 消息窗口化：默认只渲染最近 N 条，向上翻页加载更早消息（长会话首屏/打字性能）
const MESSAGE_WINDOW_SIZE = 80;

export default function Chat() {
  const conversations = useChatStore(state => state.conversations);
  const activeId = useChatStore(state => state.activeId);
  const runtimeById = useChatStore(state => state.runtimeById);
  const error = useChatStore(state => state.error);
  const taskSubmitting = useChatStore(state => state.taskSubmitting);
  const loadConversations = useChatStore(state => state.loadConversations);
  const newConversation = useChatStore(state => state.newConversation);
  const switchConversation = useChatStore(state => state.switchConversation);
  const deleteConversation = useChatStore(state => state.deleteConversation);
  const renameConversation = useChatStore(state => state.renameConversation);
  const sendMessage = useChatStore(state => state.sendMessage);
  const sendTaskMessage = useChatStore(state => state.sendTaskMessage);
  const confirmTaskMessage = useChatStore(state => state.confirmTaskMessage);
  const cancelTaskMessage = useChatStore(state => state.cancelTaskMessage);
  const editTaskMessage = useChatStore(state => state.editTaskMessage);
  const retryTaskMessage = useChatStore(state => state.retryTaskMessage);
  const replanTaskMessage = useChatStore(state => state.replanTaskMessage);
  const switchTaskSourceImage = useChatStore(state => state.switchTaskSourceImage);
  const syncTaskMessage = useChatStore(state => state.syncTaskMessage);
  const setConversationChatMode = useChatStore(state => state.setConversationChatMode);
  const setConversationAgentSelection = useChatStore(state => state.setConversationAgentSelection);
  const stopGeneration = useChatStore(state => state.stopGeneration);
  const confirmProposal = useChatStore(state => state.confirmProposal);
  const cancelProposal = useChatStore(state => state.cancelProposal);
  const updateProposalPrompt = useChatStore(state => state.updateProposalPrompt);
  const toggleProposalBatchItem = useChatStore(state => state.toggleProposalBatchItem);
  // Skill 相关状态
  const skillMode = useChatStore(state => state.skillMode);
  const selectedSkillId = useChatStore(state => state.selectedSkillId);
  const detectedSkillId = useChatStore(state => state.detectedSkillId);
  const setSkillMode = useChatStore(state => state.setSkillMode);
  const setSelectedSkillId = useChatStore(state => state.setSelectedSkillId);
  const { settings } = useSettingsStore();
  const { user, isLoggedIn } = useAuthStore();
  const { images, loadImages } = useImageStore();
  const [input, setInput] = useState('');
  // Composer 图片附件按对话/任务模式严格隔离。
  // 切到 chat → 永远从 chat[] 起手（即使 task[] 还有图）。
  // 切回 task → 恢复 task[]，不会因去 chat 问一句话就丢任务素材。
  // active_image_id 不再隐式进入普通 chat —— chat[] 仅由用户在对话模式下主动选图填充。
  const [attachmentsByMode, setAttachmentsByMode] = useState<{
    chat: ChatAttachment[];
    task: ChatAttachment[];
  }>({ chat: [], task: [] });
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
  const [settingAvatar, setSettingAvatar] = useState(false);
  const [galleryFullImageCache, setGalleryFullImageCache] = useState<Record<string, string>>({});
  const [copySuccess, setCopySuccess] = useState(false);
  // 一键复制全部对话的反馈状态（成功"已复制当前对话"，失败"复制失败，请重试"）
  const [convCopyState, setConvCopyState] = useState<'idle' | 'success' | 'error'>('idle');
  useEffect(() => {
    if (convCopyState === 'idle') return;
    const timer = setTimeout(() => setConvCopyState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [convCopyState]);
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const chatInputAreaRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [composerHeight, setComposerHeight] = useState(96);
  const [galleryDrafts, setGalleryDrafts] = useState<Record<string, GallerySearchCriteria>>({});
  // Skill UI 状态
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  // 任务队列跳转 highlightId（来自 TaskMessageCard 的 "查看任务"）
  const [pendingFocusTaskId, setPendingFocusTaskId] = useState<string | null>(null);

  // ====== 多 AI 智能体：用户 Profile 选择（会话级） ======
  const aiProfiles = useAIProviderStore(state => state.profiles);
  const hydrateProfiles = useAIProviderStore(state => state.hydrate);
  useEffect(() => {
    hydrateProfiles();
  }, [hydrateProfiles]);
  const activeConvAgentSelection = useMemo(() => {
    if (!activeId) return null;
    const conv = conversations.find(c => c.id === activeId);
    if (!conv?.selected_agent_profile_id) return null;
    return {
      profileId: conv.selected_agent_profile_id,
      modelId: conv.selected_agent_model_id || '',
    };
  }, [activeId, conversations]);
  const enabledProfileGroups = useMemo(() => {
    // 使用范围双层判定：Provider 级与模型级 use_scopes 都允许「AI 对话」才进入选择器
    return aiProfiles
      .filter(profile => profile.enabled && (profile.use_scopes ?? defaultUseScopes()).chat)
      .map(profile => ({
        profile,
        models: profile.models
          .filter(model => model.enabled && (model.use_scopes ?? defaultUseScopes()).chat)
          .sort((a, b) => (a.model_id === profile.default_model_id ? -1 : b.model_id === profile.default_model_id ? 1 : 0)),
      }))
      .filter(group => group.models.length > 0);
  }, [aiProfiles]);

  // 当前会话的聊天模式：来自 store 持久化字段 chat_mode，默认 chat
  const activeChatMode: ChatMode = useMemo(() => {
    if (!activeId) return 'chat';
    const conv = conversations.find(c => c.id === activeId);
    return conv?.chat_mode === 'task' ? 'task' : 'chat';
  }, [activeId, conversations]);
  const setActiveChatMode = useCallback((mode: ChatMode) => {
    if (!activeId) {
      const id = newConversation();
      setConversationChatMode(id, mode);
      return;
    }
    setConversationChatMode(activeId, mode);
  }, [activeId, newConversation, setConversationChatMode]);

  // 当前模式对应的附件数组 +  setter。所有读 attachments / 调 setAttachments
  // 的代码都不需要知道自己处于哪个模式 —— 这层 indirection 帮我们隔离 chat/task。
  const attachments = attachmentsByMode[activeChatMode];
  const setAttachments = useCallback(
    (next: ChatAttachment[] | ((prev: ChatAttachment[]) => ChatAttachment[])) => {
      setAttachmentsByMode(prev => {
        const current = prev[activeChatMode];
        const resolved =
          typeof next === 'function'
            ? (next as (p: ChatAttachment[]) => ChatAttachment[])(current)
            : next;
        if (resolved === current) return prev;
        return { ...prev, [activeChatMode]: resolved };
      });
    },
    [activeChatMode],
  );

  // 模式切换诊断：让 Runtime 一眼确认 chat[] / task[] 没有互相串线。
  useEffect(() => {
    if (!activeId) return;
    const chatCount = attachmentsByMode.chat.length;
    const taskCount = attachmentsByMode.task.length;
    const chatLabels = attachmentsByMode.chat.map((_, idx) =>
      getAttachmentDisplayLabel(idx),
    );
    console.log('[ComposerMode]', {
      to: activeChatMode,
      conversationId: activeId,
      chat_images: chatCount,
      task_images: taskCount,
      chat_labels: chatLabels,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatMode, activeId]);

  // 输入草稿预览识别：实时计算当前输入对应的 Skill（只用于 UI 显示，无网络请求）
  const draftDetectedSkill = useMemo(() => {
    if (skillMode === 'manual' && selectedSkillId) {
      return selectedSkillId;
    }
    if (!input.trim() && attachments.length === 0) {
      return detectedSkillId;
    }
    const result = detectSkill({
      text: input,
      hasImageAttachments: attachments.some(a => a.type === 'image'),
      hasEditableImage: attachments.some(a => a.type === 'image' && !!a.filePath),
      attachmentCount: attachments.length,
    });
    return result.skillId;
  }, [input, attachments, skillMode, selectedSkillId, detectedSkillId]);

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

  /** 图片预览 → 设为当前头像：经 Avatar Service 裁剪保存独立副本 */
  const handleSetAvatar = useCallback(async () => {
    const img = previewImage;
    if (!img || settingAvatar) return;
    setSettingAvatar(true);
    try {
      await setAsAvatarFromDataUrl(img.src);
      toastSuccess('头像设置成功');
    } catch (err) {
      toastError(err instanceof Error ? err.message : '头像设置失败，请重试');
    } finally {
      setSettingAvatar(false);
    }
  }, [previewImage, settingAvatar]);

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

  // 实时任务状态同步已上收到全局事件桥（useTaskStore.ensureTaskEventBridge）：
  // 事件 → 去抖 loadTasks（刷新 store）→ post-refresh 钩子按 taskId 同步聊天任务卡。
  // 此处不再单独订阅 —— 旧实现立即读取 TaskStore 快照，最终终态事件到达时读到的是
  // 上一次刷新的旧状态（running），任务卡因此永远停在“正在生成图片”。

  // 离线 reconcile：当用户从图库 / 任务队列切回 AI 智能体页面、
  // 或者整个窗口重新可见时，强制用 TaskStore 当前态同步一次任务卡。
  // task-updated 事件可能在用户离开页面时丢失，持久化快照也可能陈旧，
  // 这一层 reconcile 是"任务卡显示 RUNNING 但 Task 已经 FAILED"问题的最终防线。
  // 注意：只 reconcile 当前激活会话（其余会话在 switchConversation 时懒恢复），
  // 且只在页面 mount 时挂监听 —— 依赖 [activeId] 会在每次切换会话时全量重跑，是打开卡顿的根因之一。
  useEffect(() => {
    const triggerReconcile = () => {
      const active = useChatStore.getState().activeId;
      useTaskStore.getState().loadTasks().then(() =>
        useChatStore.getState().reconcileTaskMessages(active || undefined)
      ).catch(err => console.warn('[TaskReconcile] failed', err));
    };
    triggerReconcile();
    document.addEventListener('visibilitychange', triggerReconcile);
    window.addEventListener('focus', triggerReconcile);
    const onCustomReconcile = () => triggerReconcile();
    window.addEventListener('cy-chat-reconcile-tasks', onCustomReconcile as EventListener);
    return () => {
      document.removeEventListener('visibilitychange', triggerReconcile);
      window.removeEventListener('focus', triggerReconcile);
      window.removeEventListener('cy-chat-reconcile-tasks', onCustomReconcile as EventListener);
    };
  }, []);

  // 切换到任务队列 Tab 时的高亮 hook（用 storage 事件 + 自定义事件实现跨组件传递）
  useEffect(() => {
    if (!pendingFocusTaskId) return;
    const handler = () => setPendingFocusTaskId(null);
    window.addEventListener('cy-taskqueue-focus-done', handler);
    return () => window.removeEventListener('cy-taskqueue-focus-done', handler);
  }, [pendingFocusTaskId]);

  // 服务器模型 group -> model_type 映射由 useServerModelStore 统一同步
  // （runtimeReady 后首发、登录后补发、断网恢复自动重试、按 Server 隔离缓存）。
  // Chat 页面只消费结果，不再自己发请求。AI 智能体对话模型一律来自用户本地配置的
  // Provider（BYOK），不把服务器 Agent 模型合入聊天模型选择器。
  const serverModelStatus = useServerModelStore(s => s.status);
  const serverModelError = useServerModelStore(s => s.error);
  const syncServerModels = useServerModelStore(s => s.sync);
  const [modelBannerDismissed, setModelBannerDismissed] = useState(false);
  useEffect(() => {
    // 自动恢复成功后错误横幅自动消失（dismiss 只隐藏当前这次错误）
    if (serverModelStatus === 'ready' && modelBannerDismissed) setModelBannerDismissed(false);
  }, [serverModelStatus, modelBannerDismissed]);

  const activeConversationExists = !!activeId && conversations.some(conversation => conversation.id === activeId);
  const activeConv = activeConversationExists
    ? conversations.find(conversation => conversation.id === activeId) || null
    : null;

  // ====== BYOK 模型解析：聊天 / Planner 唯一来源 = 已启用 Provider 的模型 ======
  // resolveConversationAgent 内部顺序：会话级选择 → 全局选择 → 默认 Profile，无服务器回退。
  const resolvedAgentSelection = useMemo(
    () => resolveConversationAgent(activeConv),
    [activeConv, aiProfiles],
  );
  // V3.0.6：「对话助手 / 创作智能体」类型已删除 —— 创作能力属于 CyImagePro，
  // 所有模型服务共用完整工作流；是否参与任务规划由使用范围（use_scopes）决定。
  const isTaskMode = activeChatMode === 'task';
  // 会话显式绑定的 Provider 已被停用 / 删除：不静默换模型，仅提示重新选择
  const staleConvAgentProfile = useMemo(() => {
    const boundId = activeConv?.selected_agent_profile_id;
    if (!boundId) return null;
    const profile = aiProfiles.find(p => p.id === boundId);
    return profile && profile.enabled ? null : (profile?.name || boundId);
  }, [activeConv, aiProfiles]);
  const isSending = activeId ? !!runtimeById[activeId]?.isSending : false;
  // token 估算按会话 memo：此前每次 render（包括输入框每个按键）都会重新遍历整个消息列表
  const contextUsed = useMemo(() => estimateConversationTokens(activeConv), [activeConv]);
  const contextLimit = settings.agent_context_window || 32768;
  const showEmptyState = conversations.length === 0;
  const showWelcomeState = !showEmptyState && !!activeConv && activeConv.messages.length === 0;
  const showMessageState = !!activeConv && activeConv.messages.length > 0;

  // ====== 消息窗口化（分页渲染，避免长会话一次性挂载全部 MessageItem） ======
  const [visibleMessageCount, setVisibleMessageCount] = useState(MESSAGE_WINDOW_SIZE);
  useEffect(() => { setVisibleMessageCount(MESSAGE_WINDOW_SIZE); }, [activeId]);
  const visibleMessages = useMemo(() => {
    if (!activeConv) return [];
    return activeConv.messages.slice(-visibleMessageCount);
  }, [activeConv, visibleMessageCount]);
  const hiddenMessageCount = activeConv ? Math.max(0, activeConv.messages.length - visibleMessageCount) : 0;

  // 当前对话的可用图片（生成图 + 用户上传），供任务卡"切换图片"Picker 使用。
  // 按 memo 缓存：仅随消息列表变化重算。
  const sourceImageOptions = useMemo(
    () => collectConversationImages(activeConv?.messages || []),
    [activeConv?.messages],
  );
  const handleSwitchSourceImage = useCallback((taskId: string, image: ConversationImageOption) => {
    if (!activeId) return;
    switchTaskSourceImage(activeId, taskId, {
      imageId: image.imageId,
      localPath: image.localPath,
      url: image.url,
      fileName: image.fileName,
    });
  }, [activeId, switchTaskSourceImage]);

  // 一键复制全部对话：从 message 数据生成干净 Markdown（禁止 DOM 复制）。
  const handleCopyConversation = useCallback(async () => {
    if (!activeConv || activeConv.messages.length === 0) return;
    const text = formatConversationForClipboard(activeConv, {
      userName: user?.username,
      agentName: settings.agent_name || 'CyImage Agent',
    });
    const ok = await copyTextToClipboard(text);
    setConvCopyState(ok ? 'success' : 'error');
  }, [activeConv, user?.username, settings.agent_name]);

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

  const getPlaceholder = () => {
    if (!resolvedAgentSelection) return '尚未配置 AI 对话模型，请前往「设置与更新 → AI 智能体」…';
    if (isSending || taskSubmitting) return '等待回复中...';
    return isTaskMode
      ? '描述希望 Agent 执行的任务，例如：生成一张日本街道风景图'
      : '给 Agent 发送消息或问题…（Shift+Enter 换行）';
  };

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

  // 一键清空当前 Composer 的全部图片附件。模式切换不清图，
  // 但用户点击 Context Bar 的"清除全部"会主动清空当前模式对应的 attachments，
  // 并（仅在 task 模式下）撤销会话级 active_image 绑定。
  // chat 模式下 active_image 本就不展示，因此只清空 chat[]。
  const clearAllAttachments = () => {
    setAttachments([]);
    if (isTaskMode && activeId && activeConv?.active_image_id) {
      useChatStore.getState().setActiveImageId(activeId, null, null);
    }
  };

  // 给每张附件按当前数组下标生成 "图一 / 图二 / 图三" 语义标签。
  // 删除中间项后，剩余项的标签会随下标自动重排 —— 无需维护额外状态。
  // 该 helper 同时用于 Context Bar 附件卡片与 Gallery Picker 选中态展示。
  const attachmentLabel = (index: number) => getAttachmentDisplayLabel(index);

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
    // 摘要只包含真实对话轮次；任务卡 / 提案 / 错误等合成消息混入摘要
    // 会随 system 上下文再次进入模型，造成上下文污染。
    const liveMessages = conversation.messages
      .filter(message => (message.role === 'user' || message.role === 'assistant')
        && !isSyntheticAssistantMessage(message))
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
    if (isSending || taskSubmitting) return;
    // BYOK：Agent 对话 / Planner 只能使用用户已配置的 Provider 模型。
    // 没有可用模型（或 Provider 缺 Key）时提示配置，禁止回退服务器 Agent 模型。
    if (!resolvedAgentSelection) {
      alert('尚未配置 AI 对话模型。请前往「设置与更新 → AI 智能体」添加并启用一个模型服务。');
      useAuthStore.getState().setRequestedPage('settings');
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

    // ====== 任务模式：只创建 WAITING_CONFIRM 任务卡，不调用图片模型 ======
    if (!planOnly && isTaskMode) {
      setInput('');
      setAttachments([]);
      if (inputRef.current) inputRef.current.style.height = 'auto';

      await sendTaskMessage({
        text,
        attachments,
        settings: {
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
        },
        mode: 'task',
      });
      return;
    }

    const actionDecision = decideAgentAction({
      text,
      hasImageAttachments: attachments.some(attachment => attachment.type === 'image'),
      hasEditableImage: attachments.some(attachment => attachment.type === 'image' && !!attachment.filePath),
      planOnly,
    });

    // 图库动作路由（V3.0.6：所有模型服务共用完整工作流，无对话助手分支）
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
  }, [input, attachments, isSending, taskSubmitting, resolvedAgentSelection, contextLimit, contextUsed, activeConv, settings, sendMessage, sendTaskMessage, isTaskMode, applyLocalContextCompression, appendGalleryClarification, appendDirectGallerySearch]);

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

    // Toggle 行为：如果图片已经被选中，立即移除；否则加入。
    // 修复"图库多选无法再次点击取消"的核心问题 —— 旧版本只能通过附件区 × 删除。
    // 比较用 normalized path，与选择器选中态保持同一身份判定。
    const imageKey = normalizeGalleryPath(image.local_path);
    const existing = attachments.find(att => normalizeGalleryPath(att.filePath) === imageKey);
    if (existing) {
      removeAttachment(existing.id);
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
    // BYOK：图库语义描述使用当前用户 Provider 的视觉模型（无服务器回退）
    if (!resolvedAgentSelection) return null;
    const { profile } = resolvedAgentSelection;
    const token = (profile.api_key || profile.fallback_token || '').trim();
    const visionModel = profile.models.find(m => m.model_id === profile.vision_model_id && m.enabled)
      ?? (resolvedAgentSelection.model.supports_vision ? resolvedAgentSelection.model : undefined)
      ?? profile.models.find(m => m.supports_vision && m.enabled);
    if (!token || !visionModel) return null;
    const model = visionModel.model_id;
    const baseUrl = resolveProfileBaseUrl(profile);
    if (!baseUrl) return null;
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
  }, [resolvedAgentSelection]);

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

  // BYOK：Agent 对话不依赖服务器权益 / 余额（图片、后处理等服务器业务各自保留检查）
  const disabledInput = isSending || taskSubmitting;
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
  }, [attachments.length]);

  const goConfigureAgentModel = () => {
    useAuthStore.getState().setRequestedPage('settings');
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

  const handleRetryTaskMessage = useCallback(async (messageId: string, taskId: string) => {
    if (!activeId) return;
    if (!taskId || taskId.startsWith('failed_') || taskId === 'no_task') {
      // 任务从未创建成功，仅本地占位。提示用户重新发起。
      useChatStore.setState({ error: '该任务尚未提交成功，请修改提示词后重新执行。' });
      return;
    }
    await retryTaskMessage(activeId, taskId);
  }, [activeId, retryTaskMessage]);

  const handleViewTask = useCallback((taskId: string) => {
    if (!taskId) return;
    try {
      localStorage.setItem('cy_taskqueue_focus_id', taskId);
    } catch {}
    setPendingFocusTaskId(taskId);
    useAuthStore.getState().setRequestedPage('queue');
  }, []);

  const handleEditTaskImage = useCallback((imagePath: string, imageId?: string) => {
    if (!imagePath) return;
    if (!activeId) return;
    // 进入"基于此图编辑"上下文：保留在当前聊天，切换到任务模式，
    // 后续用户输入修改要求时，Agent 会创建 EDIT Task 而不是 GENERATION。
    // source='explicit'：用户手动绑定，任务卡会显示"已手动选择"而非"上一张图片"。
    useChatStore.getState().setActiveImageId(activeId, imageId || imageIdFromPath(imagePath) || imagePath, imagePath, 'explicit');
    useChatStore.getState().setConversationChatMode(activeId, 'task');
    // 提示用户当前已绑定源图
    useChatStore.setState({ error: null });
    try {
      localStorage.setItem('cy_imageedit_source_path', imagePath);
    } catch {}
  }, [activeId]);

  const handleRegenerateTask = useCallback(async (messageId: string, taskId: string) => {
    if (!activeId) return;
    if (!taskId || taskId.startsWith('failed_') || taskId === 'no_task') {
      useChatStore.setState({ error: '该任务尚未提交成功，无法再来一张，请重新发起。' });
      return;
    }
    // "再来一张" 语义：克隆原任务的最终提示词，强制走一次全新的 GENERATION 规划。
    // 即使当前会话 active_image_id 还指着上一张图，也必须忽略它 —— ignoreActiveImage=true
    // 保证 Planner 拿到的是干净的"无源图"上下文，对应任务卡里 sourceImageId=null。
    const conv = useChatStore.getState().conversations.find(c => c.id === activeId);
    const msg = conv?.messages.find(m => m.id === messageId);
    const tm = msg?.task_message;
    const promptForRegenerate = (tm?.finalPrompt || tm?.prompt || '').trim();
    if (!promptForRegenerate) {
      useChatStore.setState({ error: '原任务没有可复用的提示词，请重新发起。' });
      return;
    }
    await sendTaskMessage({
      text: promptForRegenerate,
      attachments: [],
      settings: {
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
      },
      mode: 'task',
      ignoreActiveImage: true,
    });
  }, [activeId, sendTaskMessage, settings]);

  const handleConfirmTaskMessage = useCallback(async (_messageId: string, taskId: string) => {
    if (!activeId) return;
    await confirmTaskMessage(activeId, taskId);
  }, [activeId, confirmTaskMessage]);

  const handleCancelTaskMessage = useCallback(async (_messageId: string, taskId: string) => {
    if (!activeId) return;
    await cancelTaskMessage(activeId, taskId);
  }, [activeId, cancelTaskMessage]);

  const handleModifyTaskMessage = useCallback((_messageId: string, taskId: string, finalPrompt: string, finalNegativePrompt: string) => {
    if (!activeId) return;
    editTaskMessage(activeId, taskId, finalPrompt, finalNegativePrompt);
  }, [activeId, editTaskMessage]);

  // 重新规划：原地更新同一张 PLANNING_FAILED / WAITING_CONFIRM 任务卡，
  // 不再删除卡片、不再二次调用 sendTaskMessage（避免追加第二条相同的用户消息）。
  const handleReplanTaskMessage = useCallback(async (messageId: string, taskId: string, newText?: string) => {
    if (!activeId) return;
    await replanTaskMessage(activeId, taskId, {
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
    }, newText);
  }, [activeId, replanTaskMessage, settings]);

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
            {resolvedAgentSelection && (
              <ProviderLogo
                providerType={resolvedAgentSelection.profile.provider_type}
                name={resolvedAgentSelection.profile.name}
                size={18}
              />
            )}
            <span className="chat-model-name">
              {resolvedAgentSelection
                ? `${resolvedAgentSelection.profile.name} · ${resolvedAgentSelection.model.display_name || resolvedAgentSelection.model.model_id}`
                : '未配置 AI 模型'}
            </span>
            {resolvedAgentSelection?.profile.billing_mode && (
              <span className="model-mode-tag">
                {BILLING_MODE_LABELS[resolvedAgentSelection.profile.billing_mode]}
              </span>
            )}
          </span>
          {activeConv && activeConv.messages.length > 0 && (
            <button
              type="button"
              className={`chat-copy-conv-btn ${convCopyState !== 'idle' ? convCopyState : ''}`}
              onClick={handleCopyConversation}
              title="复制当前对话的全部内容（干净 Markdown，不含技术信息）"
              disabled={convCopyState !== 'idle'}
            >
              <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              {convCopyState === 'success' ? '已复制当前对话' : convCopyState === 'error' ? '复制失败，请重试' : '复制全部对话'}
            </button>
          )}
          <ContextMeter used={contextUsed} limit={contextLimit} />
          {!resolvedAgentSelection && (
            <span className="chat-no-token">
              尚未配置 AI 对话模型
              <button
                type="button"
                className="settings-btn settings-btn-link settings-btn-sm"
                onClick={() => window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'settings', section: 'agents' } }))}
              >
                前往设置
              </button>
            </span>
          )}
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
              <>
              {hiddenMessageCount > 0 && (
                <div className="chat-load-earlier">
                  <button onClick={() => setVisibleMessageCount(c => c + MESSAGE_WINDOW_SIZE)}>
                    加载更早的消息（还有 {hiddenMessageCount} 条）
                  </button>
                </div>
              )}
              {visibleMessages.map(m => (
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
                  onRetryTaskMessage={handleRetryTaskMessage}
                  onViewTask={handleViewTask}
                  onEditTaskImage={handleEditTaskImage}
                  onRegenerateTask={handleRegenerateTask}
                  onConfirmTaskMessage={handleConfirmTaskMessage}
                  onCancelTaskMessage={handleCancelTaskMessage}
                  onModifyTaskMessage={handleModifyTaskMessage}
                  onReplanTaskMessage={handleReplanTaskMessage}
                  sourceImageOptions={sourceImageOptions}
                  onSwitchSourceImageTask={handleSwitchSourceImage}
                />
              ))}
              </>
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
            <button
              className="chat-error-copy"
              onClick={() => useChatStore.getState().dismissError()}
              title="关闭错误提示"
            >
              关闭
            </button>
          </div>
        )}

        <div className="chat-input-area" ref={chatInputAreaRef}>
          <div className="chat-input-wrapper">
            {!resolvedAgentSelection && (
              <div className="agent-paywall-banner">
                <div>
                  <strong>尚未配置 AI 对话模型</strong>
                  <span>AI 智能体使用你自己的模型服务（如智谱 GLM、DeepSeek 或第三方 API）。请先在设置中配置并启用一个智能体。</span>
                </div>
                <button onClick={goConfigureAgentModel}>前往设置</button>
              </div>
            )}
            {staleConvAgentProfile && (
              <div className="agent-paywall-banner">
                <div>
                  <strong>当前会话绑定的智能体「{staleConvAgentProfile}」已停用或删除</strong>
                  <span>不会自动切换模型，请在下方重新选择对话模型。</span>
                </div>
              </div>
            )}
            {/* 模式切换器 —— 必须在输入框外围，与工具按钮分离。
                修复"切换器塞进输入框 + 与附件按钮长得一样"两个 UI 问题。 */}
            <div className="chat-composer-topbar">
              <div className="chat-mode-switcher" role="group" aria-label="对话/任务模式">
                <button
                  type="button"
                  className={`chat-mode-btn ${!isTaskMode ? 'active' : ''}`}
                  onClick={() => setActiveChatMode('chat')}
                  title="普通对话、讨论需求"
                >
                  💬 对话
                </button>
                <button
                  type="button"
                  className={`chat-mode-btn task ${isTaskMode ? 'active' : ''}`}
                  onClick={() => setActiveChatMode('task')}
                  title="将本条输入作为任务需求发送给 Agent，确认后再执行"
                >
                  ⚡ 任务
                </button>
              </div>
              <div className="chat-composer-topbar-hint">
                {isTaskMode
                  ? '提交后进入任务规划 / 确认流程，确认才执行'
                  : '普通对话，可附带图片上下文讨论需求'}
              </div>
            </div>
            {/* 图片上下文栏 —— 取代旧 "编辑模式：已绑定源图" 横幅 + 附件列表。
                关键：图片存在 ≠ 编辑模式；这里只是中性的"图片上下文"，是否真编辑由任务规划判定。
                多图时按选择顺序显示 图一 / 图二 / 图三，删除中间项后自动重编号。
                普通对话模式严格只展示 chat[]；active_image 仅在 task 模式下作为编辑目标展示。 */}
            {(isTaskMode && activeConv?.active_image_id && activeConv?.active_image_path) || attachments.length > 0 ? (
              <div className="chat-context-bar">
                <div className="chat-context-header">
                  <span className="chat-context-title">{isTaskMode ? '任务图片' : '图片上下文'}</span>
                  <span className="chat-context-count">
                    {attachments.length > 0
                      ? `${attachments.length} 张`
                      : '已绑定源图'}
                  </span>
                  {attachments.length > 0 && (
                    <button
                      type="button"
                      className="chat-context-clear-all"
                      onClick={clearAllAttachments}
                      title="清空全部图片附件，并解除编辑目标绑定"
                    >清除全部</button>
                  )}
                </div>
                <div className="chat-context-items">
                  {isTaskMode && activeConv?.active_image_id && activeConv?.active_image_path && (
                    <div className="chat-context-item active-bound" title={activeConv.active_image_path}>
                      <div className="chat-context-thumb">
                        {(() => {
                          const found = activeConv.messages
                            .flatMap(m => m.task_message?.images || [])
                            .find(img => img.localPath === activeConv.active_image_path || img.imageId === activeConv.active_image_id);
                          return found?.url
                            ? <img src={found.url} alt="源图" />
                            : <span className="chat-context-thumb-placeholder">源图</span>;
                        })()}
                        <span className="chat-context-label">{attachmentLabel(0)}</span>
                      </div>
                      <div className="chat-context-meta">
                        <span className="chat-context-name">
                          {activeConv.active_image_path.split(/[\\/]/).pop() || activeConv.active_image_path}
                        </span>
                        <span className="chat-context-source">已绑定 · 编辑目标</span>
                      </div>
                      <button
                        type="button"
                        className="chat-context-remove"
                        onClick={() => useChatStore.getState().setActiveImageId(activeConv.id, null, null)}
                        title="取消编辑目标绑定"
                      >×</button>
                    </div>
                  )}
                  {attachments.map((att, index) => {
                    // active_image 仅在 task 模式下展示；存在时 attachments 从 图二 起编号。
                    // chat 模式下即便会话仍残留 active_image_id，也不会影响编号 —— 这里永远是 图一 起。
                    const labelIndex = isTaskMode && activeConv?.active_image_id ? index + 1 : index;
                    return (
                      <div key={att.id} className={`chat-context-item attachment-${att.type}`}>
                        <div className="chat-context-thumb">
                          {att.type === 'image' && att.dataUrl ? (
                            <img src={att.dataUrl} alt={att.name} />
                          ) : (
                            <span className="chat-context-thumb-placeholder">FILE</span>
                          )}
                          <span className="chat-context-label">{attachmentLabel(labelIndex)}</span>
                        </div>
                        <div className="chat-context-meta">
                          <span className="chat-context-name" title={att.name}>{att.name}</span>
                          <span className="chat-context-source">
                            {att.source === 'gallery' ? '图库' : att.source === 'paste' ? '粘贴' : '本地'}
                            {att.size ? ` · ${att.size < 1024 ? att.size + 'B' : (att.size / 1024).toFixed(1) + 'KB'}` : ''}
                          </span>
                        </div>
                        <button
                          className="chat-context-remove"
                          onClick={() => removeAttachment(att.id)}
                          title="移除该图片"
                        >×</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {attachmentGuidance && (
              <div className="agent-attachment-guidance">{attachmentGuidance}</div>
            )}
            <div className="chat-input-box">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => { setInput(e.target.value); autoResize(e.target); }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={getPlaceholder()}
                disabled={disabledInput}
                rows={1}
                className={isTaskMode ? 'task-mode-active' : ''}
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
                    className={`chat-btn-send ${(!input.trim() && !attachments.length) || disabledInput ? 'disabled' : ''} ${isTaskMode ? 'task-mode' : ''}`}
                    onClick={() => handleSend(false)}
                    disabled={(!input.trim() && !attachments.length) || disabledInput}
                    title={isTaskMode ? '提交任务' : '发送'}
                  >
                    {isTaskMode ? (
                      <span className="chat-btn-send-task">提交任务</span>
                    ) : (
                      <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                    )}
                  </button>
                </div>
              </div>
            </div>
            <div className="chat-disclaimer-row">
              <ModelPicker
                profileGroups={enabledProfileGroups}
                resolvedSelection={resolvedAgentSelection}
                conversationSelection={activeConvAgentSelection}
                onProfileSelect={(profileId, modelId) => {
                  if (activeId) setConversationAgentSelection(activeId, profileId, modelId);
                }}
                onGoToSettings={goConfigureAgentModel}
              />
              <span className="chat-disclaimer">AI 可能产生错误信息，请核实重要内容</span>
            </div>
            {isLoggedIn && serverModelStatus === 'error' && serverModelError && !modelBannerDismissed && (
              <div className={serverModelError.kind === 'runtime_not_ready' || serverModelError.kind === 'configuration_error'
                ? 'chat-model-error chat-model-error-neutral' : 'chat-model-error'}>
                <span>
                  {serverModelError.kind === 'runtime_not_ready'
                    ? '正在加载服务器配置...'
                    : serverModelError.kind === 'configuration_error'
                      ? `服务器配置异常：${serverModelError.message}`
                      : `服务器模型同步失败：${serverModelError.message}${serverModelError.retryable ? '，正在尝试自动恢复…' : ''}`}
                </span>
                <button onClick={() => {
                  setModelBannerDismissed(false);
                  void syncServerModels({ force: true });
                }}>重试</button>
                <button onClick={() => setModelBannerDismissed(true)}>关闭</button>
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
              <button className="img-preview-btn" disabled={settingAvatar} onClick={() => { void handleSetAvatar(); }}>
                {settingAvatar ? '设置中…' : '设为头像'}
              </button>
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
        const gpSorted = dedupeGalleryItems(
          [...images]
            .filter(img => gallerySourceFilter === 'all' ? true : img.source_kind === gallerySourceFilter)
            .sort((a, b) => {
              const cmp = a.created_at.localeCompare(b.created_at);
              return gpSortOrder === 'desc' ? -cmp : cmp;
            }),
        );
        const gpVisible = gpSorted.slice(gpPage * gpPageSize, (gpPage + 1) * gpPageSize);
        const gpTotalPages = Math.ceil(gpSorted.length / gpPageSize);
        return (
          <div className="gp-overlay" onClick={() => setShowGalleryPicker(false)}>
            <div className="gp-modal" onClick={e => e.stopPropagation()}>
              <div className="gp-header">
                <h3 className="gp-title">
                  从图库选择
                  {attachments.length > 0 && (
                    <span className="gp-selected-count">已选择 {attachments.length} 张</span>
                  )}
                </h3>
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
                    // 关键：选中态以 attachments 顺序为准，编号由当前下标实时生成。
                    // 选中态穿过翻页 / 排序 / 来源过滤 —— 因为 source of truth 在 Composer 侧。
                    // 比较用 normalized path，防止分隔符 / 大小写差异导致选中态错位。
                    const imgPathKey = normalizeGalleryPath(img.local_path);
                    const selectedIndex = attachments.findIndex(att => normalizeGalleryPath(att.filePath) === imgPathKey);
                    const alreadySelected = selectedIndex >= 0;
                    // active_image 只在 task 模式展示；存在时 attachments 从 图二 起编号。
                    // chat 模式严格从 图一 起 —— 即使会话残留 active_image_id 也不影响 chat 编号。
                    const labelIndex = isTaskMode && activeConv?.active_image_id ? selectedIndex + 1 : selectedIndex;
                    const selectionLabel = alreadySelected ? getAttachmentDisplayLabel(labelIndex) : '';
                    return (
                      <div
                        key={img.id}
                        className={`gp-item${img.missing ? ' missing' : ''}${alreadySelected ? ' selected' : ''}`}
                        onClick={() => !img.missing && handleSelectGalleryImage(img)}
                        onMouseEnter={e => !img.missing && handleGpMouseEnter(e, img.id, img.local_path)}
                        onMouseLeave={handleGpMouseLeave}
                        title={img.missing ? `${img.file_name}（文件已移动或不存在）` : alreadySelected ? `${img.file_name}（已选 · ${selectionLabel}，再次点击取消）` : `${img.file_name}（点击选择）`}
                      >
                        {url ? <img src={url} alt={img.file_name} draggable={false} /> : <div className="gp-placeholder">{img.missing ? '文件缺失' : '...'}</div>}
                        {/* 选中态：左上角顺序标签 + 右上角 check badge。
                            旧版本只靠 1px 绿色描边，几乎看不出区别 —— 现在改成"描边 + overlay + badge + 顺序标签"四重视觉。 */}
                        {alreadySelected && (
                          <>
                            <div className="gp-item-overlay" />
                            <span className="gp-item-order-label">{selectionLabel}</span>
                            <span className="gp-item-check" aria-hidden="true">✓</span>
                          </>
                        )}
                        <div className="gp-item-meta">
                          <span className="gp-item-name">{img.file_name}</span>
                          <span className="gp-item-source">
                            {getImageSourceLabel(img.source_kind)}
                            {alreadySelected ? ` · ${selectionLabel}` : ''}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="gp-footer">
                <span className="gp-hint">
                  单击选择 / 再次单击取消；编号按选择顺序生成（图一 / 图二 / 图三），缺失文件不会进入附件区。
                </span>
                <div className="gp-pagination">
                  <button className="gp-page-btn" onClick={() => setGpPage(p => Math.max(0, p - 1))} disabled={gpPage === 0}>‹</button>
                  <span className="gp-page-info">{gpPage + 1} / {gpTotalPages || 1}</span>
                  <button className="gp-page-btn" onClick={() => setGpPage(p => Math.min(gpTotalPages - 1, p + 1))} disabled={gpPage >= gpTotalPages - 1}>›</button>
                </div>
                <div className="gp-footer-btns">
                  {attachments.length > 0 && (
                    <button className="gp-btn-clear" onClick={clearAllAttachments} title="清空当前全部选中">
                      清空选中（{attachments.length}）
                    </button>
                  )}
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
  onRetryTaskMessage, onViewTask, onEditTaskImage, onRegenerateTask,
  onConfirmTaskMessage, onCancelTaskMessage, onModifyTaskMessage, onReplanTaskMessage,
  sourceImageOptions, onSwitchSourceImageTask,
}: {
  message: ChatMessage;
  isStreaming: boolean;
  onImageClick: (url: string, meta?: { name?: string; width?: number | null; height?: number | null; localPath?: string; createdAt?: string }) => void;
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
  onRetryTaskMessage: (messageId: string, taskId: string) => void;
  onViewTask: (taskId: string) => void;
  onEditTaskImage: (imagePath: string, imageId?: string) => void;
  onRegenerateTask: (messageId: string, taskId: string) => void;
  onConfirmTaskMessage: (messageId: string, taskId: string) => void;
  onCancelTaskMessage: (messageId: string, taskId: string) => void;
  onModifyTaskMessage: (messageId: string, taskId: string, finalPrompt: string, finalNegativePrompt: string) => void;
  onReplanTaskMessage: (messageId: string, taskId: string, newText?: string) => void;
  /** 当前对话的可用图片（生成 + 上传），供任务卡"切换图片"Picker 使用。 */
  sourceImageOptions: ConversationImageOption[];
  onSwitchSourceImageTask: (taskId: string, image: ConversationImageOption) => void;
}) {
  const isUser = message.role === 'user';
  const [reasoningOpen, setReasoningOpen] = useState(true);
  const avatar = isUser ? userAvatar : aiAvatar;
  const initials = isUser ? getInitials(userName, 'U') : getInitials(agentName, 'AI');

  const assistantHtml = useMemo(() => {
    if (isUser || !message.content) return '';
    try {
      return marked.parse(message.content) as string;
    } catch {
      return escapeHtml(message.content);
    }
  }, [isUser, message.content]);

  const reasoningHtml = useMemo(() => {
    if (isUser || !message.reasoning) return '';
    try {
      return marked.parse(message.reasoning) as string;
    } catch {
      return escapeHtml(message.reasoning);
    }
  }, [isUser, message.reasoning]);

  const handleContentClick = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
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
  }, []);

  const generatedImgUrl = message.generated_image ? `data:image/png;base64,${message.generated_image}` : null;
  const isImageStage = !isUser && isStreaming && message.is_image && !generatedImgUrl && !message.task_message;
  const userImages = isUser && message.images?.length ? message.images : null;

  let contentNode: React.ReactNode = null;
  if (isImageStage) {
    contentNode = (
      <div className="chat-image-stage">
        <div className="image-stage-loader" />
        <div className="image-stage-text">{message.content}</div>
      </div>
    );
  } else if (isUser) {
    contentNode = (
      <div className="chat-msg-content user-message">
        <div className="user-message-text">{message.content}</div>
        {userImages && userImages.length > 0 ? (
          <div className="user-message-images">
            {userImages.map((url, idx) => (
              <img
                key={`${url}-${idx}`}
                src={url}
                className="msg-thumb"
                alt=""
                loading="lazy"
                decoding="async"
                onClick={() => onImageClick(url)}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  } else if (message.content && !message.task_message) {
    contentNode = (
      <div
        className="chat-msg-content assistant-message"
        onClick={handleContentClick}
        dangerouslySetInnerHTML={{ __html: assistantHtml }}
      />
    );
  } else if (isStreaming && !message.task_message) {
    contentNode = (
      <div className="chat-msg-content assistant-message">
        <span className="chat-thinking">思考中<span className="dots">...</span></span>
      </div>
    );
  }

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
            <div className={`reasoning-body ${reasoningOpen ? 'open' : ''}`} dangerouslySetInnerHTML={{ __html: reasoningHtml }} />
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
        {contentNode}
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
        {!isUser && message.task_message && (
          <TaskMessageCard
            state={message.task_message}
            isStreaming={isStreaming}
            onPreviewImage={(url, meta) => onImageClick(url, meta)}
            onRetry={() => onRetryTaskMessage(message.id, message.task_message!.taskId)}
            onViewTask={() => onViewTask(message.task_message!.taskId)}
            onEditTask={message.task_message.images && message.task_message.images[0]?.localPath
              ? () => onEditTaskImage(
                  message.task_message!.images![0].localPath!,
                  message.task_message!.images![0].imageId || message.task_message!.images![0].id,
                )
              : undefined}
            onRegenerate={() => onRegenerateTask(message.id, message.task_message!.taskId)}
            onConfirm={() => onConfirmTaskMessage(message.id, message.task_message!.taskId)}
            onCancel={() => onCancelTaskMessage(message.id, message.task_message!.taskId)}
            onModify={(finalPrompt, finalNegativePrompt) => onModifyTaskMessage(message.id, message.task_message!.taskId, finalPrompt, finalNegativePrompt)}
            onReplan={(newText) => onReplanTaskMessage(message.id, message.task_message!.taskId, newText)}
            sourceImageOptions={sourceImageOptions}
            onSwitchSourceImage={(image) => onSwitchSourceImageTask(message.task_message!.taskId, image)}
          />
        )}
        {/* Token badge */}
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

type ProfilePickerGroup = {
  profile: { id: string; name: string; provider_type: import('../features/aiProviders/types').AIProviderType; billing_mode?: import('../features/aiProviders/types').BillingMode };
  models: AIProviderModel[];
};

function ModelPicker({ profileGroups = [], resolvedSelection, conversationSelection, onProfileSelect, onGoToSettings }: {
  profileGroups?: ProfilePickerGroup[];
  /** 会话级解析结果（含全局默认兜底），仅用于按钮文案与选中态展示 */
  resolvedSelection?: { profile: { id: string; name: string; provider_type: import('../features/aiProviders/types').AIProviderType; billing_mode?: import('../features/aiProviders/types').BillingMode }; model: AIProviderModel } | null;
  conversationSelection?: { profileId: string; modelId: string } | null;
  onProfileSelect?: (profileId: string, modelId: string) => void;
  onGoToSettings?: () => void;
}) {
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

  // 唯一来源：用户已启用 Provider 的模型。没有 Provider 时显示配置引导。
  const display = resolvedSelection
    ? `${resolvedSelection.profile.name} · ${resolvedSelection.model.display_name || resolvedSelection.model.model_id}`
    : '尚未配置模型';

  const activeProfileId = conversationSelection?.profileId || resolvedSelection?.profile.id || '';
  const activeModelId = conversationSelection?.modelId || resolvedSelection?.model.model_id || '';

  return (
    <div className="model-picker" ref={wrapRef}>
      <button
        type="button"
        className={`model-picker-btn ${open ? 'open' : ''}`}
        onClick={() => setOpen(v => !v)}
      >
        <span className="model-picker-name">
          {resolvedSelection && (
            <ProviderLogo
              providerType={resolvedSelection.profile.provider_type}
              name={resolvedSelection.profile.name}
              size={16}
            />
          )}
          <span className="model-picker-name-text">{display}</span>
          {resolvedSelection?.profile.billing_mode && (
            <span className="model-mode-tag">{BILLING_MODE_LABELS[resolvedSelection.profile.billing_mode]}</span>
          )}
        </span>
        <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className="model-picker-panel">
          {profileGroups.length === 0 && (
            <div className="model-option empty">
              <div>尚未配置 AI 对话模型</div>
              <div className="model-option-empty-hint">请在「设置与更新 → AI 智能体」中添加</div>
              {onGoToSettings && (
                <button
                  className="model-option-goto"
                  onClick={() => {
                    onGoToSettings();
                    setOpen(false);
                  }}
                >
                  前往设置
                </button>
              )}
            </div>
          )}
          {profileGroups.map(group => (
            <div key={group.profile.id} className="model-picker-group">
              <div className="model-option-group-title">
                <ProviderLogo providerType={group.profile.provider_type} name={group.profile.name} size={14} />
                <span className="model-option-group-name">{group.profile.name}</span>
                {group.profile.billing_mode && (
                  <span className="model-mode-tag">{BILLING_MODE_LABELS[group.profile.billing_mode]}</span>
                )}
              </div>
              {group.models.map(m => {
                const selected = group.profile.id === activeProfileId && m.model_id === activeModelId;
                return (
                  <div
                    key={`${group.profile.id}:${m.model_id}`}
                    className={`model-option ${selected ? 'selected' : ''}`}
                    onClick={() => {
                      onProfileSelect?.(group.profile.id, m.model_id);
                      setOpen(false);
                    }}
                  >
                    <span className="model-option-name">{m.display_name || m.model_id}</span>
                    {isNewlyDiscovered(m) && <span className="model-option-tag new">✨新</span>}
                    {m.supports_vision && <span className="model-option-tag vision">视觉</span>}
                    {m.test_status === 'failed' && <span className="model-option-tag warn">⚠</span>}
                    {selected && (
                      <svg className="model-option-check" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M13.5 4.5L6 12 2.5 8.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

