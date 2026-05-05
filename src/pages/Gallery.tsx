import { useEffect, useState } from 'react';
import { useImageStore } from '../store/useImageStore';
import { api } from '../services/api';
import type { ImageRecord } from '../types';
import './Gallery.css';

export default function Gallery() {
  const { images, loadImages, deleteImage } = useImageStore();
  const [preview, setPreview] = useState<ImageRecord | null>(null);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    loadImages();
  }, []);

  useEffect(() => {
    const loadUrls = async () => {
      const urls: Record<string, string> = {};
      for (const img of images) {
        try {
          urls[img.id] = await api.readImageData(img.local_path);
        } catch {}
      }
      setImageUrls(urls);
    };
    if (images.length > 0) loadUrls();
  }, [images]);

  const handleDelete = async (img: ImageRecord) => {
    if (confirm(`确定删除图片 ${img.file_name}？文件将从磁盘移除。`)) {
      await deleteImage(img.id);
    }
  };

  const sorted = [...images].sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return (
    <div className="page">
      <div className="page-header">
        <h2>图片库</h2>
        <p>查看所有已生成的图片（共 {sorted.length} 张）</p>
      </div>

      {sorted.length === 0 ? (
        <div className="empty-state">
          <p>暂无图片</p>
          <p className="empty-hint">创建批量任务来生成图片</p>
        </div>
      ) : (
        <div className="gallery-grid">
          {sorted.map(img => (
            <div key={img.id} className="gallery-item">
              <div className="gallery-thumb" onClick={() => setPreview(img)}>
                {imageUrls[img.id] ? (
                  <img src={imageUrls[img.id]} alt={img.file_name} />
                ) : (
                  <div className="gallery-loading">加载中...</div>
                )}
              </div>
              <div className="gallery-info">
                <p className="gallery-name" title={img.file_name}>{img.file_name}</p>
                <p className="gallery-time">{new Date(img.created_at).toLocaleString('zh-CN')}</p>
              </div>
              <div className="gallery-actions">
                <button onClick={() => api.openFile(img.local_path)}>打开</button>
                <button onClick={() => api.openFolder(img.local_path)}>目录</button>
                <button className="del-btn" onClick={() => handleDelete(img)}>删除</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {preview && (
        <PreviewModal preview={preview} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

function PreviewModal({ preview, onClose }: { preview: ImageRecord; onClose: () => void }) {
  const [url, setUrl] = useState<string>('');

  useEffect(() => {
    api.readImageData(preview.local_path).then(setUrl);
  }, [preview.local_path]);

  return (
    <div className="preview-overlay" onClick={onClose}>
      <div className="preview-modal" onClick={e => e.stopPropagation()}>
        <div className="preview-header">
          <span>{preview.file_name}</span>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="preview-body">
          {url ? (
            <img src={url} alt={preview.file_name} />
          ) : (
            <div className="gallery-loading">加载中...</div>
          )}
        </div>
        <div className="preview-footer">
          <button onClick={() => api.openFile(preview.local_path)}>打开文件</button>
          <button onClick={() => api.openFolder(preview.local_path)}>打开目录</button>
        </div>
      </div>
    </div>
  );
}
