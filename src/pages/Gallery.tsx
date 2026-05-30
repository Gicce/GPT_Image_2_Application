import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useImageStore } from '../store/useImageStore';
import { api } from '../services/api';
import type { ImageRecord } from '../types';
import './Gallery.css';

const PAGE_SIZE = 24;

export default function Gallery() {
  const { images, loadImages, deleteImage } = useImageStore();
  const [preview, setPreview] = useState<ImageRecord | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const loadingRef = useRef<Set<string>>(new Set());

  useEffect(() => { void loadImages(); }, [loadImages]);

  const sorted = useMemo(
    () => [...images].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [images]
  );
  const visibleImages = sorted.slice(0, visibleCount);
  const hasMore = visibleCount < sorted.length;

  const grouped = useMemo(() => {
    const visibleIds = new Set(visibleImages.map(image => image.id));
    const local = visibleImages.filter(image => visibleIds.has(image.id) && image.source_kind === 'library_input');
    const output = visibleImages.filter(image => visibleIds.has(image.id) && image.source_kind !== 'library_input');
    return [
      { key: 'library_input', title: '本地目录', items: local },
      { key: 'output', title: '输出目录', items: output },
    ].filter(group => group.items.length > 0);
  }, [visibleImages]);

  const loadThumb = useCallback(async (img: ImageRecord) => {
    if (img.missing) return;
    if (thumbUrls[img.id] || loadingRef.current.has(img.id)) return;
    loadingRef.current.add(img.id);
    try {
      const url = await api.readThumbnail(img.local_path);
      setThumbUrls(prev => ({ ...prev, [img.id]: url }));
    } catch {
      setThumbUrls(prev => {
        const next = { ...prev };
        delete next[img.id];
        return next;
      });
    }
    loadingRef.current.delete(img.id);
  }, [thumbUrls]);

  useEffect(() => {
    visibleImages.forEach(img => { void loadThumb(img); });
  }, [visibleImages, loadThumb]);

  const handleScroll = useCallback(() => {
    if (!hasMore) return;
    const el = document.querySelector('.main-content');
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) {
      setVisibleCount(prev => prev + PAGE_SIZE);
    }
  }, [hasMore]);

  useEffect(() => {
    const el = document.querySelector('.main-content');
    if (!el) return;
    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  const removeMissingRecord = async (img: ImageRecord) => {
    await deleteImage(img.id);
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>图片库</h2>
        <p>查看和管理本地目录与输出目录中的图片（共 {sorted.length} 张）。</p>
      </div>

      {sorted.length === 0 ? (
        <div className="empty-state">
          <p>暂无图片</p>
          <p className="empty-hint">请先在设置中配置文件目录或输出目录。</p>
        </div>
      ) : (
        <>
          {grouped.map(group => (
            <section key={group.key} className="gallery-section">
              <div className="gallery-section-header">
                <h3>{group.title}</h3>
                <span>{group.items.length} 张</span>
              </div>
              <div className="gallery-grid">
                {group.items.map(img => (
                  <div key={img.id} className={`gallery-item ${img.missing ? 'missing' : ''}`}>
                    <div className="gallery-thumb" onClick={() => !img.missing && setPreview(img)}>
                      {img.missing ? (
                        <div className="gallery-loading">文件已移动或不存在</div>
                      ) : thumbUrls[img.id] ? (
                        <img src={thumbUrls[img.id]} alt={img.file_name} />
                      ) : (
                        <div className="gallery-loading">加载中...</div>
                      )}
                    </div>
                    <div className="gallery-info">
                      <p className="gallery-name" title={img.file_name}>{img.file_name}</p>
                      <p className="gallery-time">{new Date(img.created_at).toLocaleString('zh-CN')}</p>
                      <p className="gallery-time">{img.missing ? '文件缺失' : (img.source_kind === 'library_input' ? '本地目录' : '输出目录')}</p>
                    </div>
                    <div className="gallery-actions">
                      {!img.missing ? (
                        <>
                          <button onClick={() => api.openFile(img.local_path)}>打开</button>
                          <button onClick={() => api.openFolder(img.local_path)}>目录</button>
                        </>
                      ) : (
                        <button onClick={() => removeMissingRecord(img)}>移除记录</button>
                      )}
                      <button className="del-btn" onClick={() => deleteImage(img.id)}>删除</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {hasMore && (
            <div className="load-more">
              <button onClick={() => setVisibleCount(prev => prev + PAGE_SIZE)}>
                加载更多（还剩 {sorted.length - visibleCount} 张）
              </button>
            </div>
          )}
        </>
      )}

      {preview && <PreviewModal preview={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function PreviewModal({ preview, onClose }: { preview: ImageRecord; onClose: () => void }) {
  const [url, setUrl] = useState<string>('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.readImageData(preview.local_path)
      .then(value => { if (!cancelled) setUrl(value); })
      .catch(err => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [preview.local_path]);

  return (
    <div className="preview-overlay" onClick={onClose}>
      <div className="preview-modal" onClick={e => e.stopPropagation()}>
        <div className="preview-header">
          <span>{preview.file_name}</span>
          <button onClick={onClose}>×</button>
        </div>
        <div className="preview-body">
          {error ? (
            <div className="gallery-loading">{error}</div>
          ) : url ? (
            <img src={url} alt={preview.file_name} />
          ) : (
            <div className="gallery-loading">加载原图中...</div>
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
