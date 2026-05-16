import { useEffect, useRef, useState, useCallback } from 'react';
import { useChatStore } from '../store/useChatStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useImageStore } from '../store/useImageStore';
import { useAuthStore, setGroupTypeMap } from '../store/useAuthStore';
import { api } from '../services/api';
import { serverApi, type ServerModel } from '../services/serverApi';
import type { ChatMessage } from '../types';
import { marked } from 'marked';
import hljs from 'highlight.js';
import { Command } from '@tauri-apps/plugin-shell';
import { invoke } from '@tauri-apps/api/core';
import DeleteConvDialog from '../components/DeleteConvDialog';
import 'highlight.js/styles/atom-one-dark.css';
import './Chat.css';
import './ImageEdit.css';

marked.setOptions({ breaks: true });

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 自定义 code renderer：接入 highlight.js + 注入复制按钮 + 提示词框
const renderer = new marked.Renderer();
const originalCode = renderer.code.bind(renderer);
renderer.code = function(code: any) {
  const raw = typeof code === 'string' ? code : (code.text ?? '');
  const lang = typeof code === 'object' ? (code.lang || '') : '';

  const isPromptBlock = lang === 'prompt' || lang === '提示词' || lang === 'template';
  const encoded = btoa(unescape(encodeURIComponent(raw)));

  if (isPromptBlock) {
    return `<div class="prompt-block"><div class="prompt-header"><span class="prompt-label">📝 提示词</span><button class="prompt-copy-btn" data-code="${encoded}" type="button">复制提示词</button></div><pre class="prompt-body"><code>${escapeHtml(raw)}</code></pre></div>`;
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
    { regex: /^\[!WARNING\]/i,   className: 'callout-warning',  icon: '⚠️' },
    { regex: /^\[!CAUTION\]/i,   className: 'callout-danger',   icon: '🔴' },
    { regex: /^\[!IMPORTANT\]/i, className: 'callout-important',icon: '❗' },
    { regex: /^\[!NOTE\]/i,      className: 'callout-note',     icon: 'ℹ️' },
    { regex: /^\[!TIP\]/i,       className: 'callout-tip',      icon: '💡' },
    { regex: /^[⚠️⚡🔴❗]/,      className: 'callout-warning',  icon: '' },
    { regex: /^[💡✨]/,          className: 'callout-tip',       icon: '' },
    { regex: /^[ℹ️📝]/,         className: 'callout-note',     icon: '' },
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

export default function Chat() {
  const {
    conversations, activeId, isSending, error,
    loadConversations, newConversation, switchConversation,
    deleteConversation, renameConversation, sendMessage, stopGeneration,
  } = useChatStore();
  const { settings, saveSettings } = useSettingsStore();
  const { user, isLoggedIn } = useAuthStore();
  const [chatModels, setChatModels] = useState<ServerModel[]>([]);
  const { images, loadImages } = useImageStore();
  const [input, setInput] = useState('');
  const [deepThinking, setDeepThinking] = useState(false);
  const [imageGenMode, setImageGenMode] = useState(false);
  const [pendingImages, setPendingImages] = useState<{ dataUrl: string; name: string }[]>([]);
  const [editImage, setEditImage] = useState<{ dataUrl: string; filePath: string } | null>(null);
  const [pendingFiles, setPendingFiles] = useState<{ name: string; content: string; size: number }[]>([]);
  const [deletingConv, setDeletingConv] = useState<{ id: string; title: string } | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showGalleryPicker, setShowGalleryPicker] = useState(false);
  const [galleryAsEditSource, setGalleryAsEditSource] = useState(false);
  const [galleryThumbs, setGalleryThumbs] = useState<Record<string, string>>({});
  const [gpLayoutMode, setGpLayoutMode] = useState<'3x3' | '4x4'>('4x4');
  const [gpSortOrder, setGpSortOrder] = useState<'desc' | 'asc'>('desc');
  const [gpPage, setGpPage] = useState(0);
  const [gpHoverPreview, setGpHoverPreview] = useState<{ id: string; url: string; x: number; y: number } | null>(null);
  const gpHoverCache = useRef<Record<string, string>>({});
  const gpHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

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

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ESC: close preview
      if (e.key === 'Escape' && previewImg) {
        e.preventDefault();
        setPreviewImg(null);
        setCopySuccess(false);
        return;
      }
      // Ctrl+C: copy preview image
      if (e.ctrlKey && e.key === 'c' && previewImg && !window.getSelection()?.toString()) {
        e.preventDefault();
        copyImageToClipboard(previewImg);
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
  }, [previewImg, copyImageToClipboard, newConversation]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { loadConversations(); }, []);

  // 拉取可用对话模型列表 + 默认值自愈 + group→type 映射缓存
  useEffect(() => {
    if (!isLoggedIn) return;
    serverApi.getModels()
      .then(list => {
        // 缓存 group→model_type 映射，让 syncTokensToSettings 能正确分配
        const map: Record<string, 'image' | 'chat'> = {};
        for (const m of list) {
          if (m.group) map[m.group] = m.model_type;
        }
        setGroupTypeMap(map);

        const chatList = list.filter(m => m.model_type === 'chat');
        setChatModels(chatList);
        if (chatList.length > 0 && !chatList.find(m => m.name === settings.chat_model)) {
          const isTrial = user?.account_type === 'trial';
          const first = isTrial ? (chatList.find(m => m.trial_allowed) ?? chatList[0]) : chatList[0];
          if (first) saveSettings({ chat_model: first.name });
        }
      })
      .catch((err: any) => {
        if (err?.status === 401) {
          useAuthStore.getState().logout();
          useAuthStore.getState().showAuthPrompt();
        }
      });
  }, [user?.account_type, isLoggedIn]);

  const activeConv = conversations.find(c => c.id === activeId);

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
    setGalleryThumbs({});
    loadImages();
  }, [showGalleryPicker]);

  // Reset page when layout or sort changes
  useEffect(() => { setGpPage(0); }, [gpLayoutMode, gpSortOrder]);

  // Load thumbnails for current page
  useEffect(() => {
    if (!showGalleryPicker || images.length === 0) return;
    let cancelled = false;
    const gpPageSize = gpLayoutMode === '3x3' ? 9 : 16;
    const currentVisible = [...images]
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
  }, [showGalleryPicker, images, gpPage, gpLayoutMode, gpSortOrder]);

  // Clear hover preview when picker closes
  useEffect(() => {
    if (!showGalleryPicker) {
      setGpHoverPreview(null);
      gpHoverCache.current = {};
    }
  }, [showGalleryPicker]);

  const getPlaceholder = () => {
    if (editImage) return '输入修改指令，如「把背景换成海滩」「去掉水印」...';
    if (imageGenMode) return '描述你想生成的图片...';
    return '给 AI 发送消息（Shift+Enter 换行）';
  };

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text && !pendingImages.length && !editImage && !pendingFiles.length) return;
    if (isSending) return;

    const isImageMode = imageGenMode || !!editImage;
    if (isImageMode && !settings.token) {
      alert('文生图/图生图需要图片生成 API Token，请在「设置」页面配置');
      return;
    }
    if (!isImageMode && !settings.chat_token) {
      alert('请先在「设置」页面配置对话 API Token');
      return;
    }

    let finalText = text;
    if (pendingFiles.length > 0) {
      const fileParts = pendingFiles.map(f =>
        `--- 文件: ${f.name} ---\n${f.content}\n--- 结束 ---`
      );
      finalText = fileParts.join('\n\n') + (text ? '\n\n' + text : '');
    }

    setInput('');
    setPendingImages([]);
    setPendingFiles([]);
    setEditImage(null);
    if (inputRef.current) inputRef.current.style.height = 'auto';

    await sendMessage(finalText || '(附件)', {
      chat_token: settings.chat_token,
      token: settings.token,
      chat_model: settings.chat_model,
      chat_base_url: settings.chat_base_url,
      chat_system_prompt: settings.chat_system_prompt,
    }, { imageGenMode, editImage, deepThinking, pendingImages });
  }, [input, isSending, settings, sendMessage, pendingImages, pendingFiles, editImage, imageGenMode, deepThinking]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  const handlePickImage = async () => {
    const path = await api.selectImageFile();
    if (!path) return;
    const dataUrl = await api.readImageData(path);
    setPendingImages(prev => [...prev, { dataUrl, name: path.split(/[\\/]/).pop() || 'image.png' }]);
  };

  const handlePickEditImage = async () => {
    const path = await api.selectImageFile();
    if (!path) return;
    const dataUrl = await api.readImageData(path);
    setEditImage({ dataUrl, filePath: path });
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
        reader.onload = () => {
          const dataUrl = reader.result as string;
          if (dataUrl) {
            setPendingImages(prev => [...prev, { dataUrl, name: `粘贴图片_${Date.now()}.png` }]);
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
        setPendingFiles(prev => [...prev, result]);
      }
    } catch (e) {
      console.error('选择文件失败', e);
    }
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

  const handleSelectGalleryImage = async (imgPath: string) => {
    const dataUrl = await api.readImageData(imgPath);
    if (galleryAsEditSource) {
      setEditImage({ dataUrl, filePath: imgPath });
    } else {
      setPendingImages(prev => [...prev, { dataUrl, name: imgPath.split(/[\\/]/).pop() || 'image.png' }]);
    }
    setShowGalleryPicker(false);
  };

  // 已登录但没有任何 chat 组 token：显示占位
  // 简单判定：settings.chat_token 由 syncTokensToSettings 自动写入"非 image 组"的第一个 token
  // 如果它为空，说明用户没有任何对话组的 token
  const chatBlocked = isLoggedIn && !settings.chat_token;
  if (chatBlocked) {
    return (
      <div className="chat-blocked-wrap">
        <div className="chat-blocked">
          <div className="chat-blocked-icon">💬</div>
          <h3>对话功能未开通</h3>
          <p>当前账户尚未购买对话分组的 Token。<br/>请前往「我的账户」充值，或申请试用。</p>
          <div className="chat-blocked-actions">
            <button
              className="chat-blocked-btn primary"
              onClick={() => useAuthStore.getState().setRequestedPage('account')}
            >前往我的账户</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-page">
      <div className={`chat-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="chat-sidebar-header">
          <button className="chat-btn-new" onClick={() => newConversation()}>+ 新对话</button>
        </div>
        <div className="chat-conv-list">
          {conversations.length === 0 ? (
            <div className="chat-conv-empty">暂无对话</div>
          ) : (
            conversations.map(c => (
              <div key={c.id} className={`chat-conv-item ${c.id === activeId ? 'active' : ''}`} onClick={() => switchConversation(c.id)}>
                <span className="chat-conv-title" onDoubleClick={(e) => {
                  e.stopPropagation();
                  const title = prompt('重命名对话', c.title || '新对话');
                  if (title !== null && title.trim()) renameConversation(c.id, title.trim());
                }}>
                  {c.title || '新对话'}
                </span>
                <button className="chat-conv-del" onClick={(e) => { e.stopPropagation(); setDeletingConv({ id: c.id, title: c.title || '新对话' }); }} title="删除">×</button>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="chat-main">
        <div className="chat-header">
          <button className="chat-toggle-sidebar-btn" onClick={() => setSidebarCollapsed(v => !v)} title="收起/展开会话列表">
            <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <span className="chat-model-label">{settings.chat_model || 'GPT-4o'}</span>
          {!settings.chat_token && !settings.token && <span className="chat-no-token">未配置 Token，请前往「设置」页面填写</span>}
        </div>

        <div className="chat-area" ref={chatAreaRef}>
          <div className="chat-inner">
            {!activeConv || activeConv.messages.length === 0 ? (
              <div className="chat-welcome">
                <h2>CyImagePro Chat</h2>
                <p>开始一段新对话</p>
              </div>
            ) : (
              activeConv.messages.map(m => (
                <MessageItem key={m.id} message={m} isStreaming={isSending && m.id === activeConv.messages[activeConv.messages.length - 1]?.id && m.role === 'assistant'} onImageClick={setPreviewImg} />
              ))
            )}
            {isSending && (
              <div className="chat-stop-row">
                <button className="chat-btn-stop" onClick={stopGeneration}>■ 停止生成</button>
              </div>
            )}
          </div>
        </div>

        {showScrollBtn && (
          <button
            className="scroll-to-bottom"
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

        <div className="chat-input-area">
          <div className="chat-input-wrapper">
            <div className="chat-input-box">
              {editImage && (
                <div className="edit-img-bar">
                  <img src={editImage.dataUrl} alt="编辑图片" />
                  <div className="edit-info">
                    <div className="edit-label">图片编辑模式</div>
                    <div className="edit-hint">输入修改指令，如「把背景换成海滩」「去掉水印」</div>
                  </div>
                  <button className="edit-remove" onClick={() => setEditImage(null)} title="移除">×</button>
                </div>
              )}
              {pendingImages.length > 0 && (
                <div className="img-preview-bar">
                  {pendingImages.map((img, i) => (
                    <div key={i} className="img-thumb-wrap">
                      <img src={img.dataUrl} alt={img.name} />
                      <button className="remove-img" onClick={() => setPendingImages(prev => prev.filter((_, j) => j !== i))}>×</button>
                    </div>
                  ))}
                  <span className="paste-hint">支持 Ctrl+V 粘贴图片</span>
                </div>
              )}
              {pendingFiles.length > 0 && (
                <div className="pending-files">
                  {pendingFiles.map((f, i) => (
                    <div key={i} className="pending-file-chip">
                      <span className="pending-file-icon">📄</span>
                      <span className="pending-file-name">{f.name}</span>
                      <span className="pending-file-size">{f.size < 1024 ? f.size + 'B' : (f.size / 1024).toFixed(1) + 'KB'}</span>
                      <button className="pending-file-remove" onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => { setInput(e.target.value); autoResize(e.target); }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={isSending ? '等待回复中...' : getPlaceholder()}
                disabled={isSending}
                rows={1}
              />
              <div className="chat-input-bottom">
                <div className="chat-input-left">
                  <button className="chat-input-btn" onClick={handlePickImage} title="上传图片">
                    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                  </button>
                  <button className="chat-input-btn" onClick={() => setShowGalleryPicker(true)} title="从图片库选择">
                    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                  </button>
                  <button className="chat-input-btn" onClick={handlePickEditImage} title="图生图 / 编辑图片">
                    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="10 14 15 3"/><polyline points="17 3 15 3 17 5"/></svg>
                  </button>
                  <button className="chat-input-btn" onClick={handleAddFile} title="附加文件">
                    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                  </button>
                </div>
                <div className="chat-input-right">
                  <div className={`chat-toggle thinking-toggle ${deepThinking ? 'active' : ''}`} onClick={() => setDeepThinking(v => !v)} title="深度思考">
                    <span>深度思考</span>
                    <div className="toggle-track"><div className="toggle-thumb" /></div>
                  </div>
                  <div className={`chat-toggle imggen-toggle ${imageGenMode ? 'active' : ''}`} onClick={() => setImageGenMode(v => !v)} title="文生图模式">
                    <span>文生图</span>
                    <div className="toggle-track"><div className="toggle-thumb" /></div>
                  </div>
                  <button className={`chat-btn-send ${(!input.trim() && !pendingImages.length && !editImage && !pendingFiles.length) || isSending ? 'disabled' : ''}`} onClick={handleSend} disabled={(!input.trim() && !pendingImages.length && !editImage && !pendingFiles.length) || isSending} title="发送">
                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                  </button>
                </div>
              </div>
            </div>
            <div className="chat-disclaimer-row">
              <ModelPicker
                models={chatModels}
                value={settings.chat_model}
                isTrial={user?.account_type === 'trial'}
                onChange={(name) => saveSettings({ chat_model: name })}
              />
              <span className="chat-disclaimer">AI 可能产生错误信息，请核实重要内容</span>
            </div>
          </div>
        </div>
      </div>

      {/* Image preview modal */}
      {previewImg && (
        <div className="chat-modal-overlay" onClick={() => { setPreviewImg(null); setCopySuccess(false); }}>
          <div className="img-preview-modal" onClick={e => e.stopPropagation()}>
            <div className="img-preview-toolbar">
              <button className="img-preview-btn" onClick={() => copyImageToClipboard(previewImg)}>
                {copySuccess ? '已复制' : '复制图片'}
              </button>
              <button className="img-preview-btn" onClick={async () => {
                await api.saveImageAs(previewImg, `image_${Date.now()}.png`);
              }}>保存图片</button>
              <button className="img-preview-close" onClick={() => { setPreviewImg(null); setCopySuccess(false); }}>×</button>
            </div>
            <img className="img-preview-full" src={previewImg} alt="预览" />
          </div>
        </div>
      )}

      {/* Gallery picker modal */}
      {showGalleryPicker && (() => {
        const gpPageSize = gpLayoutMode === '3x3' ? 9 : 16;
        const gpCols = gpLayoutMode === '3x3' ? 3 : 4;
        const gpSorted = [...images].sort((a, b) => {
          const cmp = a.created_at.localeCompare(b.created_at);
          return gpSortOrder === 'desc' ? -cmp : cmp;
        });
        const gpVisible = gpSorted.slice(gpPage * gpPageSize, (gpPage + 1) * gpPageSize);
        const gpTotalPages = Math.ceil(images.length / gpPageSize);
        return (
          <div className="gp-overlay" onClick={() => setShowGalleryPicker(false)}>
            <div className="gp-modal" onClick={e => e.stopPropagation()}>
              <div className="gp-header">
                <h3 className="gp-title">从图片库选择</h3>
                <div className="gp-header-right">
                  <button
                    className="gp-sort-btn"
                    onClick={() => setGpSortOrder(o => o === 'desc' ? 'asc' : 'desc')}
                    title={gpSortOrder === 'desc' ? '当前：最新优先' : '当前：最早优先'}
                  >{gpSortOrder === 'desc' ? '↓ 最新' : '↑ 最早'}</button>
                  <div className="gp-layout-switcher">
                    {(['3x3', '4x4'] as const).map(m => (
                      <button key={m} className={`gp-layout-btn${gpLayoutMode === m ? ' active' : ''}`} onClick={() => setGpLayoutMode(m)}>{m}</button>
                    ))}
                  </div>
                  <button className="gp-close" onClick={() => setShowGalleryPicker(false)}>✕</button>
                </div>
              </div>

              <div className="gp-edit-toggle-row">
                <label className={`chat-toggle imggen-toggle ${galleryAsEditSource ? 'active' : ''}`} onClick={() => setGalleryAsEditSource(v => !v)}>
                  <span>选为图生图源图片</span>
                  <div className="toggle-track"><div className="toggle-thumb" /></div>
                </label>
              </div>

              {images.length === 0 ? (
                <div className="gp-empty">图片库暂无图片</div>
              ) : (
                <div className="gp-grid" style={{ gridTemplateColumns: `repeat(${gpCols}, 1fr)` }}>
                  {gpVisible.map(img => {
                    const url = galleryThumbs[img.id];
                    return (
                      <div
                        key={img.id}
                        className="gp-item"
                        onClick={() => handleSelectGalleryImage(img.local_path)}
                        onMouseEnter={e => handleGpMouseEnter(e, img.id, img.local_path)}
                        onMouseLeave={handleGpMouseLeave}
                        title={img.file_name}
                      >
                        {url ? <img src={url} alt={img.file_name} draggable={false} /> : <div className="gp-placeholder">...</div>}
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="gp-footer">
                <span className="gp-hint">点击图片选择</span>
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
          onConfirm={() => { deleteConversation(deletingConv.id); setDeletingConv(null); }}
          onCancel={() => setDeletingConv(null)}
        />
      )}
    </div>
  );
}

function MessageItem({ message, isStreaming, onImageClick }: { message: ChatMessage; isStreaming: boolean; onImageClick: (url: string) => void }) {
  const isUser = message.role === 'user';
  const contentRef = useRef<HTMLDivElement>(null);
  const [reasoningOpen, setReasoningOpen] = useState(true);

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
      // 内联 code 样式 + 包裹复制按钮
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

  // 事件委托：复制代码块（放到顶层 div，支持流式更新过程中动态出现的按钮）
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
        {isUser ? 'U' : 'AI'}
      </div>
      <div className="chat-msg-body">
        <div className="chat-msg-role">{isUser ? '你' : 'AI'}</div>
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
        {/* Token 计量徽标 */}
        {isUser && message.input_tokens !== undefined && (
          <div className="msg-token-badge">{message.input_tokens} tokens</div>
        )}
        {!isUser && !isStreaming && message.output_tokens !== undefined && !message.is_image && (
          <div className="msg-token-badge">{message.output_tokens} tokens</div>
        )}
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
                  title={disabled ? '付费套餐可用' : undefined}
                  onClick={() => {
                    if (disabled) return;
                    onChange(m.name);
                    setOpen(false);
                  }}
                >
                  <span className="model-option-name">{m.display_name || m.name}</span>
                  {m.group && <span className="model-option-group">{m.group}</span>}
                  {disabled && <span className="model-option-tag">🔒 付费</span>}
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
