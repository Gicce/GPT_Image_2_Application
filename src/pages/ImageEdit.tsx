import { useState, useEffect } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTaskStore } from '../store/useTaskStore';
import { useImageStore } from '../store/useImageStore';
import { api } from '../services/api';
import { SIZES, QUALITIES, QUALITY_LABELS, FORMATS } from '../types';
import './ImageEdit.css';
import './CreateTask.css';

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

  const [galleryUrls, setGalleryUrls] = useState<Record<string, string>>({});

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

  useEffect(() => {
    loadImages();
  }, []);

  useEffect(() => {
    const load = async () => {
      const urls: Record<string, string> = {};
      for (const img of images) {
        try { urls[img.id] = await api.readThumbnail(img.local_path); } catch {}
      }
      setGalleryUrls(urls);
    };
    if (showGalleryPicker && images.length > 0) load();
  }, [showGalleryPicker, images]);

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

  const handleAddFromGallery = (imgPath: string) => {
    if (!sourceImages.includes(imgPath)) {
      setSourceImages(prev => [...prev, imgPath]);
    }
    setShowGalleryPicker(false);
  };

  const handleRemoveSource = (path: string) => {
    setSourceImages(prev => prev.filter(p => p !== path));
    setPreviewUrls(prev => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
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
        size,
        quality,
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
      alert('编辑已下发，请在任务队列中查看任务进度。');
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
                  {previewUrls[path] ? (
                    <img src={previewUrls[path]} alt="" />
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af', fontSize: 12 }}>加载中</div>
                  )}
                  <button className="remove-btn" onClick={() => handleRemoveSource(path)}>✕</button>
                </div>
              ))}
              <div className="add-image-area">
                <button className="add-image-btn" onClick={handleAddLocal}>
                  <span className="icon">+</span>
                  <span>本地上传</span>
                </button>
                <button className="add-image-btn" onClick={() => setShowGalleryPicker(true)}>
                  <span className="icon">▦</span>
                  <span>图片库</span>
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
                type="number"
                min={1}
                max={10}
                value={count}
                onChange={e => setCount(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
              />
            </div>
          </div>

          <div className="form-group">
            <label>输出目录</label>
            <div className="dir-input">
              <input
                type="text"
                value={outputDir}
                onChange={e => setOutputDir(e.target.value)}
                placeholder="选择图片保存位置"
                readOnly
              />
              <button className="browse-btn" onClick={handleSelectDir}>浏览</button>
            </div>
          </div>
        </div>

        <div className="task-summary-card">
          <h3>任务摘要</h3>
          <div className="summary-item">
            <span className="summary-label">源图片</span>
            <span className="summary-value">{sourceImages.length} 张</span>
          </div>
          <div className="summary-item">
            <span className="summary-label">提示词</span>
            <span className="summary-value">{prompt || '未填写'}</span>
          </div>
          <div className="summary-item">
            <span className="summary-label">图片尺寸</span>
            <span className="summary-value">{size}</span>
          </div>
          <div className="summary-item">
            <span className="summary-label">质量</span>
            <span className="summary-value">{quality}</span>
          </div>
          <div className="summary-item">
            <span className="summary-label">输出格式</span>
            <span className="summary-value">{format.toUpperCase()}</span>
          </div>
          <div className="summary-divider" />
          <div className="summary-item highlight">
            <span className="summary-label">生成数量</span>
            <span className="summary-value">{count} 张</span>
          </div>
          <div className="summary-item">
            <span className="summary-label">输出目录</span>
            <span className="summary-value path">{outputDir || '未选择'}</span>
          </div>
          <button
            className="start-btn"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? '创建中...' : `开始编辑`}
          </button>
          <p className="summary-note">
            图生图任务将使用所选源图片进行 AI 编辑。可在「任务队列」中查看实时进度。
          </p>
        </div>
      </div>

      {showGalleryPicker && (
        <div className="gallery-picker-overlay" onClick={() => setShowGalleryPicker(false)}>
          <div className="gallery-picker-modal" onClick={e => e.stopPropagation()}>
            <div className="gallery-picker-header">
              <h3>从图片库选择</h3>
              <button onClick={() => setShowGalleryPicker(false)}>✕</button>
            </div>
            {images.length === 0 ? (
              <div className="gallery-picker-empty">图片库暂无图片</div>
            ) : (
              <div className="gallery-picker-grid">
                {images.map(img => (
                  <div
                    key={img.id}
                    className="gallery-picker-item"
                    onClick={() => handleAddFromGallery(img.local_path)}
                  >
                    {galleryUrls[img.id] ? (
                      <img src={galleryUrls[img.id]} alt={img.file_name} />
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af', fontSize: 11 }}>加载中</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
