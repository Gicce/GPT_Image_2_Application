import { useEffect, useRef, useState, useCallback } from 'react';
import { useChatStore } from '../store/useChatStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useImageStore } from '../store/useImageStore';
import { api } from '../services/api';
import type { ChatMessage } from '../types';
import { marked } from 'marked';
import './Chat.css';
import './ImageEdit.css';

marked.setOptions({ breaks: true });

export default function Chat() {
  const {
    conversations, activeId, isSending, error,
    loadConversations, newConversation, switchConversation,
    deleteConversation, renameConversation, sendMessage, stopGeneration,
  } = useChatStore();
  const { settings } = useSettingsStore();
  const { images, loadImages } = useImageStore();
  const [input, setInput] = useState('');
  const [deepThinking, setDeepThinking] = useState(false);
  const [imageGenMode, setImageGenMode] = useState(false);
  const [pendingImages, setPendingImages] = useState<{ dataUrl: string; name: string }[]>([]);
  const [editImage, setEditImage] = useState<{ dataUrl: string; filePath: string } | null>(null);
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

  const activeConv = conversations.find(c => c.id === activeId);

  useEffect(() => {
    if (chatAreaRef.current) chatAreaRef.current.scrollTop = chatAreaRef.current.scrollHeight;
  }, [activeConv?.messages]);

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
    if (!text && !pendingImages.length && !editImage) return;
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

    setInput('');
    setPendingImages([]);
    setEditImage(null);
    if (inputRef.current) inputRef.current.style.height = 'auto';

    await sendMessage(text || '(图片)', {
      chat_token: settings.chat_token,
      token: settings.token,
      chat_model: settings.chat_model,
      chat_base_url: settings.chat_base_url,
      chat_system_prompt: settings.chat_system_prompt,
    }, { imageGenMode, editImage, deepThinking, pendingImages });
  }, [input, isSending, settings, sendMessage, pendingImages, editImage, imageGenMode, deepThinking]);

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
                <button className="chat-conv-del" onClick={(e) => { e.stopPropagation(); deleteConversation(c.id); }} title="删除">×</button>
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

        {error && <div className="chat-error">{error}</div>}

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
                </div>
              )}
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => { setInput(e.target.value); autoResize(e.target); }}
                onKeyDown={handleKeyDown}
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
                  <button className={`chat-btn-send ${(!input.trim() && !pendingImages.length && !editImage) || isSending ? 'disabled' : ''}`} onClick={handleSend} disabled={(!input.trim() && !pendingImages.length && !editImage) || isSending} title="发送">
                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                  </button>
                </div>
              </div>
            </div>
            <div className="chat-disclaimer">AI 可能产生错误信息，请核实重要内容</div>
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
      contentRef.current.querySelectorAll('pre code').forEach((el) => {
        Object.assign((el as HTMLElement).style, { background: '#1e1e1e', padding: '14px 16px', borderRadius: '8px', display: 'block', overflowX: 'auto', fontSize: '13px', lineHeight: '1.5', fontFamily: '"Cascadia Code","Fira Code",Consolas,monospace' });
      });
      contentRef.current.querySelectorAll('pre').forEach((el) => {
        Object.assign((el as HTMLElement).style, { background: '#1e1e1e', borderRadius: '8px', padding: '0', margin: '10px 0', overflow: 'hidden', position: 'relative' });
      });
      contentRef.current.querySelectorAll('code:not(pre code)').forEach((el) => {
        Object.assign((el as HTMLElement).style, { background: '#2a2a3a', padding: '2px 6px', borderRadius: '4px', fontSize: '13px' });
      });
    }
  }, [message.content, message.images, isUser, onImageClick]);

  const generatedImgUrl = message.generated_image ? `data:image/png;base64,${message.generated_image}` : null;

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
        <div className="chat-msg-content" ref={contentRef}>
          {isUser ? message.content : (message.content || (isStreaming ? <span className="chat-thinking">思考中<span className="dots">...</span></span> : null))}
        </div>
      </div>
    </div>
  );
}
