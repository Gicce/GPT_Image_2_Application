/**
 * CyImagePro 内置图片查看器（全局单例，App 挂载一次）：
 *  - 缩放（10%~800%）：工具栏 + / -、键盘、滚轮（仅图片视口内，鼠标位置为锚点）；
 *    0 = 适应窗口；1 = 100%；双击 = 适应窗口；
 *  - 平移：放大后拖拽（grab / grabbing cursor）；
 *  - 多图切换：← → / 按钮 / 位置指示；
 *  - 复制图片（真实二进制，Ctrl/Cmd+C）、另存为（Ctrl/Cmd+S，Tauri 保存对话框）；
 *  - 关闭：Esc / 右上角 × / 点击遮罩空白区域（顶栏 / 工具栏 / 详情面板 / 图片本体不关闭）；
 *  - 右侧可选信息面板（Prompt 复制 + 业务 metadata）。
 * 打开入口统一走 useImageViewerStore.openViewer(items, index)。
 * 缩放 / 平移数学唯一来源：imageViewerTransform.ts。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../services/api';
import { toastError, toastSuccess } from './Toast';
import { useImageViewerStore, type ImageViewerItem } from '../store/useImageViewerStore';
import { copyImageBinaryToClipboard } from '../utils/imageClipboard';
import { applyZoom, type ImageViewerView, type ZoomAnchor } from './imageViewerTransform';
import './ImageViewer.css';

const ZOOM_STEP = 1.2;
/** 拖拽超过该像素距离视为平移，松开后的 click 不再触发遮罩关闭。 */
const DRAG_CLICK_TOLERANCE = 3;

const COPY = {
  close: '关闭',
  prev: '上一张',
  next: '下一张',
  zoomIn: '放大',
  zoomOut: '缩小',
  fit: '适应窗口',
  actual: '原始大小',
  copyImage: '复制图片',
  saveAs: '另存为',
  detail: '详情',
  copyPrompt: '复制 Prompt',
  promptLabel: '生成 Prompt',
  copiedToast: '图片已复制到剪贴板',
  copyFailed: '复制图片失败，请重试',
  saveFailed: '另存为失败，请重试',
} as const;

const stopClick = (e: React.MouseEvent) => { e.stopPropagation(); };

export default function ImageViewer() {
  const open = useImageViewerStore(s => s.open);
  const items = useImageViewerStore(s => s.items);
  const index = useImageViewerStore(s => s.index);
  const close = useImageViewerStore(s => s.close);
  const next = useImageViewerStore(s => s.next);
  const prev = useImageViewerStore(s => s.prev);

  const [src, setSrc] = useState('');
  const [loadError, setLoadError] = useState(false);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [view, setView] = useState<ImageViewerView>({ scale: 1, x: 0, y: 0 });
  const [detailOpen, setDetailOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragStateRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const dragMovedRef = useRef(false);
  /** path → data URL 缓存（同一会话内多图来回切换不重复 IPC）。 */
  const srcCacheRef = useRef(new Map<string, string>());

  const item: ImageViewerItem | null = items[index] ?? null;
  const multi = items.length > 1;

  const resetView = useCallback(() => {
    setView({ scale: 1, x: 0, y: 0 });
  }, []);

  // 切图 / 打开：重置视图 + 加载完整图（src 直用；path 走 readImageData 缓存）
  useEffect(() => {
    if (!open || !item) return;
    resetView();
    setDetailOpen(false);
    let cancelled = false;
    const cacheKey = item.path || item.src || '';
    const cached = item.src || srcCacheRef.current.get(cacheKey);
    if (cached) {
      setSrc(cached);
      setLoadError(false);
      return;
    }
    if (!item.path) {
      setSrc('');
      setLoadError(true);
      return;
    }
    void api.readImageData(item.path)
      .then(url => {
        if (cancelled) return;
        srcCacheRef.current.set(cacheKey, url);
        setSrc(url);
        setLoadError(false);
      })
      .catch(() => {
        if (!cancelled) {
          setSrc('');
          setLoadError(true);
        }
      });
    return () => { cancelled = true; };
  }, [open, item, resetView]);

  const zoomBy = useCallback((factor: number, anchor?: ZoomAnchor | null) => {
    setView(prev => applyZoom(prev, factor, anchor));
  }, []);

  /** 图片自然尺寸（img onLoad 读取，供适应窗口计算）。 */
  const fitScale = useMemo(() => {
    if (!natural || !viewportRef.current) return 1;
    const rect = viewportRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || natural.width <= 0 || natural.height <= 0) return 1;
    return Math.min(rect.width / natural.width, rect.height / natural.height, 1);
  }, [natural, view, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const fitToWindow = useCallback(() => {
    setView({ scale: fitScale, x: 0, y: 0 });
  }, [fitScale]);

  const actualSize = useCallback(() => {
    setView({ scale: 1, x: 0, y: 0 });
  }, []);

  const copyImage = useCallback(async () => {
    if (!src) return;
    const ok = await copyImageBinaryToClipboard(src);
    if (ok) toastSuccess(COPY.copiedToast);
    else toastError(COPY.copyFailed);
  }, [src]);

  const saveAs = useCallback(async () => {
    if (!src || !item) return;
    const fallbackName = item.fileName || item.title || `image_${Date.now()}.png`;
    try {
      const saved = await api.saveImageAs(src, fallbackName);
      if (saved) toastSuccess('已保存');
    } catch (err: any) {
      toastError(err?.message || COPY.saveFailed);
    }
  }, [src, item]);

  const copyPrompt = useCallback(async () => {
    if (!item?.prompt) return;
    try {
      await navigator.clipboard.writeText(item.prompt);
      toastSuccess('生成 Prompt 已复制');
    } catch {
      toastError('复制失败');
    }
  }, [item]);

  // 键盘：Esc / +- / 0 / 1 / ←→ / Ctrl+C / Ctrl+S（仅 Viewer 打开期间挂载，关闭即解绑）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        if (window.getSelection()?.toString()) return; // 有文本选区时让位系统复制
        e.preventDefault();
        void copyImage();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault(); // 阻止 WebView 保存页面
        void saveAs();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case '+':
        case '=':
          e.preventDefault();
          zoomBy(ZOOM_STEP);
          break;
        case '-':
        case '_':
          e.preventDefault();
          zoomBy(1 / ZOOM_STEP);
          break;
        case '0':
          e.preventDefault();
          fitToWindow();
          break;
        case '1':
          e.preventDefault();
          actualSize();
          break;
        case 'ArrowLeft':
          if (multi) { e.preventDefault(); prev(); }
          break;
        case 'ArrowRight':
          if (multi) { e.preventDefault(); next(); }
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close, copyImage, saveAs, zoomBy, fitToWindow, actualSize, multi, prev, next]);

  // 滚轮缩放：只绑定图片视口（ImageViewport），顶栏 / 工具栏 / 详情面板滚轮不缩放；
  // 以鼠标在视口内的当前位置为缩放锚点；preventDefault 仅作用于视口内。
  useEffect(() => {
    if (!open) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      zoomBy(
        e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP,
        { x: e.clientX - (rect.left + rect.width / 2), y: e.clientY - (rect.top + rect.height / 2) },
      );
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [open, zoomBy]);

  const onViewportMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragMovedRef.current = false;
    if (!panEnabled) return;
    dragStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: view.x,
      baseY: view.y,
    };
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > DRAG_CLICK_TOLERANCE) dragMovedRef.current = true;
      setView(prev => ({ ...prev, x: drag.baseX + dx, y: drag.baseY + dy }));
    };
    const onUp = () => { dragStateRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  /** 视口内点击：图片本体 / 拖拽后不冒泡；点在图片以外的暗区 → 冒泡到遮罩关闭。 */
  const onViewportClick = (e: React.MouseEvent) => {
    if (dragMovedRef.current) {
      dragMovedRef.current = false;
      e.stopPropagation();
      return;
    }
    const rect = imgRef.current?.getBoundingClientRect();
    if (rect && rect.width > 0) {
      const inside =
        e.clientX >= rect.left - DRAG_CLICK_TOLERANCE && e.clientX <= rect.right + DRAG_CLICK_TOLERANCE &&
        e.clientY >= rect.top - DRAG_CLICK_TOLERANCE && e.clientY <= rect.bottom + DRAG_CLICK_TOLERANCE;
      if (inside) e.stopPropagation();
    }
  };

  if (!open || !item) return null;

  const panEnabled = view.scale > fitScale + 0.001;
  const showDetail = detailOpen && (item.prompt || (item.metadata?.length ?? 0) > 0);

  return (
    <div
      className="image-viewer-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="图片查看器"
      onClick={close}
    >
      <div
        ref={viewportRef}
        className={`image-viewer-viewport ${panEnabled ? 'is-pannable' : ''} ${showDetail ? 'has-detail' : ''}`}
        onMouseDown={onViewportMouseDown}
        onClick={onViewportClick}
        onDoubleClick={fitToWindow}
      >
        {loadError ? (
          <p className="image-viewer-error">图片读取失败，可尝试从所在目录打开原图。</p>
        ) : src ? (
          <img
            ref={imgRef}
            className="image-viewer-img"
            src={src}
            alt={item.title || '图片预览'}
            draggable={false}
            style={{ transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            onLoad={e => {
              const img = e.currentTarget;
              setNatural({ width: img.naturalWidth, height: img.naturalHeight });
            }}
          />
        ) : (
          <p className="image-viewer-loading">加载原图中…</p>
        )}
      </div>

      <div className="image-viewer-topbar" onClick={stopClick}>
        <div className="image-viewer-title" title={item.title || item.fileName || ''}>
          <strong>{item.title || item.fileName || '图片预览'}</strong>
          {(item.width && item.height) || natural ? (
            <span>{item.width && item.height ? `${item.width} × ${item.height}` : `${natural!.width} × ${natural!.height}`}</span>
          ) : null}
          {multi && <span>{index + 1} / {items.length}</span>}
        </div>
        {(item.prompt || (item.metadata?.length ?? 0) > 0) && (
          <button className="image-viewer-btn" onClick={() => setDetailOpen(v => !v)}>
            {COPY.detail}
          </button>
        )}
        <button className="image-viewer-btn image-viewer-close" title={COPY.close} onClick={close}>×</button>
      </div>

      {showDetail && (
        <aside className="image-viewer-detail" onClick={stopClick}>
          {item.prompt && (
            <div className="image-viewer-prompt">
              <div className="image-viewer-detail-head">
                <span>{COPY.promptLabel}</span>
                <button className="image-viewer-link" onClick={() => void copyPrompt()}>{COPY.copyPrompt}</button>
              </div>
              <p>{item.prompt}</p>
            </div>
          )}
          {item.metadata && item.metadata.length > 0 && (
            <div className="image-viewer-meta-rows">
              {item.metadata.map(entry => (
                <div className="image-viewer-meta-row" key={entry.label}>
                  <span className="image-viewer-meta-label">{entry.label}</span>
                  <span className="image-viewer-meta-value" title={entry.value}>{entry.value}</span>
                </div>
              ))}
            </div>
          )}
        </aside>
      )}

      <div className="image-viewer-toolbar" onClick={stopClick}>
        {multi && (
          <button className="image-viewer-btn" title={COPY.prev} onClick={prev} aria-label={COPY.prev}>←</button>
        )}
        <button className="image-viewer-btn" title={COPY.zoomOut} onClick={() => zoomBy(1 / ZOOM_STEP)} aria-label={COPY.zoomOut}>−</button>
        <span className="image-viewer-zoom">{Math.round(view.scale * 100)}%</span>
        <button className="image-viewer-btn" title={COPY.zoomIn} onClick={() => zoomBy(ZOOM_STEP)} aria-label={COPY.zoomIn}>＋</button>
        <button className="image-viewer-btn image-viewer-btn-text" title={COPY.fit} onClick={fitToWindow}>{COPY.fit}</button>
        <button className="image-viewer-btn image-viewer-btn-text" title={COPY.actual} onClick={actualSize}>100%</button>
        <span className="image-viewer-toolbar-divider" />
        <button className="image-viewer-btn image-viewer-btn-text" onClick={() => void copyImage()}>{COPY.copyImage}</button>
        <button className="image-viewer-btn image-viewer-btn-text" onClick={() => void saveAs()}>{COPY.saveAs}</button>
        {multi && (
          <button className="image-viewer-btn" title={COPY.next} onClick={next} aria-label={COPY.next}>→</button>
        )}
      </div>
    </div>
  );
}
