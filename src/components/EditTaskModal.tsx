import { useState, useEffect } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { useImageStore } from '../store/useImageStore';
import { useTaskStore } from '../store/useTaskStore';
import { api } from '../services/api';
import { SIZES, QUALITIES, QUALITY_LABELS, FORMATS } from '../types';
import type { Task } from '../types';
import './EditTaskModal.css';
import '../pages/ImageEdit.css';

interface Props {
  task: Task;
  onClose: () => void;
}

export default function EditTaskModal({ task, onClose }: Props) {
  const { settings } = useSettingsStore();
  const { addTask } = useTaskStore();
  const { images, loadImages } = useImageStore();

  const isEdit = task.task_type === 'edit';

  const [prompt, setPrompt] = useState(task.prompt);
  const [size, setSize] = useState(task.size);
  const [quality, setQuality] = useState(task.quality);
  const [format, setFormat] = useState(task.output_format);
  const [count, setCount] = useState(task.count);
  const [outputDir, setOutputDir] = useState(task.output_dir);
  const [sourceImages, setSourceImages] = useState<string[]>(task.source_images || []);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [showGalleryPicker, setShowGalleryPicker] = useState(false);
  const [galleryUrls, setGalleryUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    const load = async () => {
      const urls: Record<string, string> = {};
      for (const path of sourceImages) {
        try { urls[path] = await api.readThumbnail(path); } catch {}
      }
      setPreviewUrls(urls);
    };
    if (sourceImages.length > 0) load();
  }, [sourceImages]);

  useEffect(() => { loadImages(); }, []);

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
  };

  const handleSubmit = async () => {
    if (isEdit && sourceImages.length === 0) { alert('请至少选择一张源图片'); return; }
    if (!prompt.trim()) { alert('请输入提示词'); return; }

    setSubmitting(true);
    try {
      const newTask = await api.createTask({
        prompt: prompt.trim(),
        negative_prompt: '',
        size,
        quality,
        output_format: format,
        count,
        output_dir: outputDir,
        task_type: isEdit ? 'edit' : 'generate',
        source_images: isEdit ? sourceImages : [],
      });
      addTask(newTask);
      alert(isEdit ? '编辑已下发，请在任务队列中查看任务进度。' : '提交成功，请在任务队列中查看任务进度。');
      onClose();
    } catch (err: any) {
      alert(err?.toString() || '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="edit-modal-overlay" onClick={onClose}>
      <div className="edit-modal" onClick={e => e.stopPropagation()}>
        <div className="edit-modal-header">
          <h3>{isEdit ? '编辑图生图任务' : '编辑生成任务'}</h3>
          <button onClick={onClose}>✕</button>
        </div>

        <div className="edit-modal-body">
          {isEdit && (
            <div className="form-group" style={{ marginBottom: 16 }}>
              <label>源图片</label>
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
                    <span className="icon">+</span><span>本地上传</span>
                  </button>
                  <button className="add-image-btn" onClick={() => setShowGalleryPicker(true)}>
                    <span className="icon">▦</span><span>图片库</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="form-group" style={{ marginBottom: 16 }}>
            <label>提示词</label>
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} />
          </div>

          <div className="form-row" style={{ marginBottom: 16 }}>
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

          <div className="form-row" style={{ marginBottom: 16 }}>
            <div className="form-group">
              <label>输出格式</label>
              <select value={format} onChange={e => setFormat(e.target.value)}>
                {FORMATS.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>数量</label>
              <input type="number" min={1} max={50} value={count} onChange={e => setCount(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))} />
            </div>
          </div>

          <div className="form-group">
            <label>输出目录</label>
            <div className="dir-input">
              <input type="text" value={outputDir} onChange={e => setOutputDir(e.target.value)} placeholder="选择保存位置" readOnly />
              <button className="browse-btn" onClick={async () => { const dir = await api.selectDirectory(); if (dir) setOutputDir(dir); }}>浏览</button>
            </div>
          </div>
        </div>

        <div className="edit-modal-footer">
          <button className="btn-secondary" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? '提交中...' : '提交任务'}
          </button>
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
                    <div key={img.id} className="gallery-picker-item" onClick={() => handleAddFromGallery(img.local_path)}>
                      {galleryUrls[img.id] ? <img src={galleryUrls[img.id]} alt={img.file_name} /> : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af', fontSize: 11 }}>加载中</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
