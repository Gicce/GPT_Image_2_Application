import { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTaskStore } from '../store/useTaskStore';
import { useImageStore } from '../store/useImageStore';
import { api } from '../services/api';
import { SIZES, QUALITIES, QUALITY_LABELS, FORMATS } from '../types';
import SuccessDialog from '../components/SuccessDialog';
import './ImageEdit.css';
import './CreateTask.css';

type LayoutMode = '3x3' | '4x4';
type SortOrder = 'desc' | 'asc';

export default function ImageEdit() {
  const { settings } = useSettingsStore();
  const { addTask } = useTaskStore();
  const { images, loadImages } = useImageStore();

  const [sourceImages, setSourceImages] = useState<string[]>([]);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState(settings.default_size);
  const [quality, setQuality] = useState(settings.default_quality);
  const [format, setFormat] = useState(settings.default_format);
  const [count, setCount] = useState(1);
  const [outputDir, setOutputDir] = useState(settings.default_output_dir);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showGalleryPicker, setShowGalleryPicker] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [galleryUrls, setGalleryUrls] = useState<Record<string, string>>({});
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('4x4');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [page, setPage] = useState(0);
  const [hoverPreview, setHoverPreview] = useState<{ id: string; url: string; x: number; y: number } | null>(null);
  const hoverCache = useRef<Record<string, string>>({});
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // page size matches layout: 3x3=9, 4x4=16
  const pageSize = layoutMode === '3x3' ? 9 : 16;
  const cols = layoutMode === '3x3' ? 3 : 4;
  const sortedImages = [...images].sort((a, b) => {
    const cmp = a.created_at.localeCompare(b.created_at);
    return sortOrder === 'desc' ? -cmp : cmp;
  });
  const visibleImages = sortedImages.slice(page * pageSize, (page + 1) * pageSize);
  const totalPages = Math.ceil(images.length / pageSize);

  useEffect(() => {
    setSize(settings.default_size);
    setQuality(settings.default_quality);
    setFormat(settings.default_format);
    if (settings.default_output_dir) setOutputDir(settings.default_output_dir);
  }, [settings]);

  useEffect(() => {
    const load = async () => {
      const urls: Record<string, string> = {};
      for (const path of sourceImages) {
        try { urls[path] = await api.readImageData(path); } catch {}
      }
      setPreviewUrls(urls);
    };
    if (sourceImages.length > 0) load();
  }, [sourceImages]);

  useEffect(() => { loadImages(); }, []);

  // When picker opens: reset page and reload images list
  useEffect(() => {
    if (!showGalleryPicker) return;
    setPage(0);
    setGalleryUrls({});
    loadImages();
  }, [showGalleryPicker]);

  // Reset to page 0 when layout or sort changes
  useEffect(() => {
    setPage(0);
  }, [layoutMode, sortOrder]);

  // Load thumbnails whenever visible images change (page/sort/layout/images list)
  useEffect(() => {
    if (!showGalleryPicker || images.length === 0) return;
    let cancelled = false;
    // visibleImages is derived from sortedImages which depends on images+sortOrder
    const currentVisible = [...images]
      .sort((a, b) => {
        const cmp = a.created_at.localeCompare(b.created_at);
        return sortOrder === 'desc' ? -cmp : cmp;
      })
      .slice(page * (layoutMode === '3x3' ? 9 : 16), (page + 1) * (layoutMode === '3x3' ? 9 : 16));
    const toLoad = currentVisible.filter(img => !galleryUrls[img.id]);
    if (toLoad.length === 0) return;
    const load = async () => {
      for (const img of toLoad) {
        if (cancelled) return;
        try {
          const url = await api.readThumbnail(img.local_path);
          if (!cancelled) setGalleryUrls(prev => ({ ...prev, [img.id]: url }));
        } catch {}
      }
    };
    load();
    return () => { cancelled = true; };
  }, [showGalleryPicker, images, page, layoutMode, sortOrder]);

  // Clear hover preview when picker closes
  useEffect(() => {
    if (!showGalleryPicker) {
      setHoverPreview(null);
      hoverCache.current = {};
    }
  }, [showGalleryPicker]);

  const handleItemMouseEnter = (
    e: React.MouseEvent<HTMLDivElement>,
    imgId: string,
    localPath: string
  ) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.right + 8;
    const y = rect.top;
    // Wait 300ms before loading/showing preview
    hoverTimer.current = setTimeout(async () => {
      if (hoverCache.current[imgId]) {
        setHoverPreview({ id: imgId, url: hoverCache.current[imgId], x, y });
        return;
      }
      try {
        const url = await api.readImageData(localPath);
        hoverCache.current[imgId] = url;
        setHoverPreview({ id: imgId, url, x, y });
      } catch {}
    }, 1500);
  };

  const handleItemMouseLeave = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHoverPreview(null), 100);
  };

  const handleSelectDir = async () => {
    const dir = await api.selectDirectory();
    if (dir) setOutputDir(dir);
  };

  const handleAddLocal = async () => {
    const file = await api.selectImageFile();
    if (file && !sourceImages.includes(file)) {
      setSourceImages(prev => [...prev, file]);
    }
  };

  const handleToggleGalleryImage = (imgPath: string) => {
    setSourceImages(prev =>
      prev.includes(imgPath) ? prev.filter(p => p !== imgPath) : [...prev, imgPath]
    );
  };

  const handleRemoveSource = (path: string) => {
    setSourceImages(prev => prev.filter(p => p !== path));
    setPreviewUrls(prev => { const n = { ...prev }; delete n[path]; return n; });
  };

  const handleSubmit = async () => {
    setError('');
    if (!settings.token.trim()) { setError('请先在「设置」中填写 API Token'); return; }
    if (sourceImages.length === 0) { setError('请至少选择一张源图片'); return; }
    if (!prompt.trim()) { setError('请输入提示词'); return; }
    if (!outputDir.trim()) { setError('请选择输出目录'); return; }

    setSubmitting(true);
    try {
      const task = await api.createTask({
        prompt: prompt.trim(),
        negative_prompt: '',
        size, quality,
        output_format: format,
        count,
        output_dir: outputDir,
        task_type: 'edit',
        source_images: sourceImages,
      });
      addTask(task);
      setPrompt('');
      setSourceImages([]);
      setPreviewUrls({});
      setCount(1);
      setShowSuccess(true);
    } catch (err: any) {
      setError(err?.toString() || '创建任务失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>图生图</h2>
        <p>上传图片或从图片库选择，使用 AI 进行编辑和变换</p>
      </div>

      <div className="create-layout">
        <div className="create-form">
          {error && <div className="error-banner">{error}</div>}

          <div className="form-group">
            <label>源图片 <span className="required">*</span></label>
            <div className="source-images-area">
              {sourceImages.map(path => (
                <div key={path} className="source-image-thumb">
                  {previewUrls[path]
                    ? <img src={previewUrls[path]} alt="" />
                    : <div className="thumb-loading">加载中</div>}
                  <button className="remove-btn" onClick={() => handleRemoveSource(path)}>✕</button>
                </div>
              ))}
              <div className="add-image-area">
                <button className="add-image-btn" onClick={handleAddLocal}>
                  <span className="icon">+</span><span>本地上传</span>
                </button>
                <button className="add-image-btn" onClick={() => setShowGalleryPicker(true)}>
                  <span className="icon">▦</span><span>图片库</span>
                </button>
              </div>
            </div>
          </div>

          <div className="form-group">
            <label>提示词 <span className="required">*</span></label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="描述你想要对图片进行的编辑，例如：根据这个图片生成大电影海报..."
              rows={4}
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>图片尺寸</label>
              <select value={size} onChange={e => setSize(e.target.value)}>
                {SIZES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>质量</label>
              <select value={quality} onChange={e => setQuality(e.target.value)}>
                {QUALITIES.map(q => <option key={q} value={q}>{QUALITY_LABELS[q] || q}</option>)}
              </select>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>输出格式</label>
              <select value={format} onChange={e => setFormat(e.target.value)}>
                {FORMATS.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>生成数量</label>
              <input
                type="number" min={1} max={10} value={count}
                onChange={e => setCount(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
              />
            </div>
          </div>

          <div className="form-group">
            <label>输出目录</label>
            <div className="dir-input">
              <input type="text" value={outputDir} onChange={e => setOutputDir(e.target.value)}
                placeholder="选择图片保存位置" readOnly />
              <button className="browse-btn" onClick={handleSelectDir}>浏览</button>
            </div>
          </div>
        </div>

        <div className="task-summary-card">
          <h3>任务摘要</h3>
          <div className="summary-item"><span className="summary-label">源图片</span><span className="summary-value">{sourceImages.length} 张</span></div>
          <div className="summary-item"><span className="summary-label">提示词</span><span className="summary-value">{prompt || '未填写'}</span></div>
          <div className="summary-item"><span className="summary-label">图片尺寸</span><span className="summary-value">{size}</span></div>
          <div className="summary-item"><span className="summary-label">质量</span><span className="summary-value">{quality}</span></div>
          <div className="summary-item"><span className="summary-label">输出格式</span><span className="summary-value">{format.toUpperCase()}</span></div>
          <div className="summary-divider" />
          <div className="summary-item highlight"><span className="summary-label">生成数量</span><span className="summary-value">{count} 张</span></div>
          <div className="summary-item"><span className="summary-label">输出目录</span><span className="summary-value path">{outputDir || '未选择'}</span></div>
          <button className="start-btn" onClick={handleSubmit} disabled={submitting}>
            {submitting ? '创建中...' : '开始编辑'}
          </button>
          <p className="summary-note">图生图任务将使用所选源图片进行 AI 编辑。可在「任务队列」中查看实时进度。</p>
        </div>
      </div>

      {showGalleryPicker && (
        <div className="gp-overlay" onClick={() => setShowGalleryPicker(false)}>
          <div className="gp-modal" onClick={e => e.stopPropagation()}>

            <div className="gp-header">
              <h3 className="gp-title">从图片库选择</h3>
              <div className="gp-header-right">
                <button
                  className="gp-sort-btn"
                  onClick={() => setSortOrder(o => o === 'desc' ? 'asc' : 'desc')}
                  title={sortOrder === 'desc' ? '当前：最新优先，点击切换为最早优先' : '当前：最早优先，点击切换为最新优先'}
                >
                  {sortOrder === 'desc' ? '↓ 最新' : '↑ 最早'}
                </button>
                <div className="gp-layout-switcher">
                  {(['3x3', '4x4'] as LayoutMode[]).map(m => (
                    <button
                      key={m}
                      className={`gp-layout-btn${layoutMode === m ? ' active' : ''}`}
                      onClick={() => setLayoutMode(m)}
                    >{m}</button>
                  ))}
                </div>
                <button className="gp-close" onClick={() => setShowGalleryPicker(false)}>✕</button>
              </div>
            </div>

            {images.length === 0 ? (
              <div className="gp-empty">图片库暂无图片</div>
            ) : (
              <div
                className="gp-grid"
                ref={gridRef}
                style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
              >
                {visibleImages.map(img => {
                  const selected = sourceImages.includes(img.local_path);
                  const url = galleryUrls[img.id];
                  return (
                    <div
                      key={img.id}
                      className={`gp-item${selected ? ' selected' : ''}`}
                      onClick={() => handleToggleGalleryImage(img.local_path)}
                      onMouseEnter={e => handleItemMouseEnter(e, img.id, img.local_path)}
                      onMouseLeave={handleItemMouseLeave}
                      title={img.file_name}
                    >
                      {url
                        ? <img src={url} alt={img.file_name} draggable={false} />
                        : <div className="gp-placeholder">...</div>}
                      {selected && <div className="gp-check">✓</div>}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="gp-footer">
              <span className="gp-hint">
                {sourceImages.length > 0 ? `已选 ${sourceImages.length} 张` : '点击图片选择，再次点击取消'}
              </span>
              <div className="gp-pagination">
                <button
                  className="gp-page-btn"
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                >‹</button>
                <span className="gp-page-info">{page + 1} / {totalPages || 1}</span>
                <button
                  className="gp-page-btn"
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                >›</button>
              </div>
              <div className="gp-footer-btns">
                <button className="gp-btn-cancel" onClick={() => {
                  setSourceImages([]);
                  setShowGalleryPicker(false);
                }}>取消</button>
                <button
                  className="gp-btn-confirm"
                  onClick={() => setShowGalleryPicker(false)}
                  disabled={sourceImages.length === 0}
                >确认选择</button>
              </div>
            </div>

            {/* Hover HD preview — fixed to viewport, outside scroll area */}
            {hoverPreview && hoverPreview.url && (
              <div
                className="gp-hd-preview"
                style={{ left: hoverPreview.x, top: hoverPreview.y }}
                onMouseEnter={() => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }}
                onMouseLeave={handleItemMouseLeave}
              >
                <img src={hoverPreview.url} alt="" draggable={false} />
              </div>
            )}

          </div>
        </div>
      )}

      {showSuccess && (
        <SuccessDialog
          title="编辑任务已提交"
          message="已成功创建图生图任务，请前往「任务队列」查看实时进度。"
          onClose={() => setShowSuccess(false)}
        />
      )}
    </div>
  );
}
