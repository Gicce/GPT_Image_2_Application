/**
 * ImageLibraryPicker —— 共享图片库选择弹窗（V4.2.3 抽取 / V6.1 Portal 化）。
 *
 * 数据：useImageStore（打开时刷新）；缩略图：Rust read_thumbnail。
 * 此前 ImageStudio（参考图 + @mention）、Skill 创作器与模板复用弹窗各自复制弹窗，
 * 现统一为本组件唯一实现；禁止在页面内再造图库选择弹窗。
 *
 * V6.1 Nested Modal 铁律：本弹窗必须 Portal 到 document.body 呈现——
 * 自带 overlay / 独立 stacking context / 自包含样式（不再依赖 Settings.css 的
 * .template-modal*，懒加载 chunk 缺失曾把弹窗压成窄长条）。Escape 只关闭本层，
 * 底层弹窗由各自 galleryOpenRef 守卫保持。
 */

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ImageRecord } from '../types';
import { api } from '../services/api';
import { useImageStore } from '../store/useImageStore';
import { useImageViewerStore } from '../store/useImageViewerStore';
import './ImageLibraryPicker.css';

function PickerThumb({ path }: { path: string }) {
  const [thumb, setThumb] = useState('');
  useEffect(() => {
    let alive = true;
    api.readThumbnail(path).then(data => { if (alive) setThumb(data); }).catch(() => {});
    return () => { alive = false; };
  }, [path]);
  if (!thumb) return <span className="image-picker-thumb is-placeholder">…</span>;
  return <img className="image-picker-thumb" src={thumb} alt="" loading="lazy" />;
}

export default function ImageLibraryPicker(props: {
  open: boolean;
  title?: string;
  onClose: () => void;
  onPick: (image: ImageRecord) => void;
}) {
  const { images, loadImages } = useImageStore();

  useEffect(() => {
    if (props.open) void loadImages();
  }, [props.open, loadImages]);

  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.open, props.onClose]);

  // 可选图片 = 未缺失的图库记录（预览浏览同一份清单，与选择口径一致）
  const available = useMemo(() => images.filter(image => !image.missing).slice(0, 120), [images]);

  if (!props.open) return null;
  const title = props.title || '从图片库选择';

  const previewImage = (image: ImageRecord) => {
    useImageViewerStore.getState().openViewer(
      available.map(item => ({ id: item.id, path: item.local_path, title: item.file_name, fileName: item.file_name })),
      available.findIndex(item => item.id === image.id),
    );
  };

  return createPortal(
    <div
      className="image-picker-overlay"
      data-testid="image-picker-overlay"
      role="presentation"
      onMouseDown={e => { if (e.target === e.currentTarget) props.onClose(); }}
    >
      <section
        className="image-picker-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={e => e.stopPropagation()}
      >
        <header className="image-picker-header">
          <div className="image-picker-heading">
            <h3>{title}</h3>
            <p>{available.length > 0 ? `图片库共 ${available.length} 张可选 · 单击选择，双击预览大图` : '图片库为空'}</p>
          </div>
          <button type="button" className="image-picker-close" aria-label="关闭" onClick={props.onClose}>×</button>
        </header>
        <div className="image-picker-body">
          <div className="image-picker-grid">
            {available.map(image => (
              <div className="image-picker-cell" key={image.id}>
                <button
                  type="button"
                  className="image-picker-pick"
                  onClick={() => props.onPick(image)}
                  onDoubleClick={() => previewImage(image)}
                  title={`${image.file_name}——单击选择，双击预览大图`}
                >
                  <PickerThumb path={image.local_path} />
                  <span className="image-picker-name" title={image.file_name}>{image.file_name}</span>
                </button>
                <button
                  type="button"
                  className="image-picker-preview-btn"
                  aria-label={`预览 ${image.file_name}`}
                  title="预览大图"
                  onClick={() => previewImage(image)}
                >预览</button>
              </div>
            ))}
            {available.length === 0 && <p className="image-picker-empty form-hint">图片库为空。可先在图片库页导入图片。</p>}
          </div>
        </div>
        <footer className="image-picker-footer">
          <span className="image-picker-note">选择后立即填入；不会移动或修改图片库文件。</span>
          <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={props.onClose}>取消</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
