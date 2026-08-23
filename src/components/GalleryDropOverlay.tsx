/**
 * 图片库拖拽导入 Overlay（V4.1）—— 纯 UI 组件。
 * 只负责渲染 galleryDropOverlayCopy 产出的文案；导入逻辑一律在
 * features/gallery/galleryFileDrop.ts（controller）与 Rust import_images_to_library。
 * 渲染在 .gallery-page（position: relative）内部，只覆盖图库主内容区，
 * 不遮左侧主导航；pointer-events: none，不拦截任何点击 / 键盘导航。
 */

import { galleryDropOverlayCopy, type GalleryFileDropState } from '../features/gallery/galleryFileDrop';
import './GalleryDropOverlay.css';

export default function GalleryDropOverlay(props: { state: GalleryFileDropState }) {
  if (!props.state.active) return null;
  const copy = galleryDropOverlayCopy(props.state);
  const allInvalid = props.state.acceptedCount === 0;
  return (
    <div className={`gallery-drop-overlay${allInvalid ? ' all-invalid' : ''}`} role="status" aria-live="polite">
      <div className="gallery-drop-frame">
        {allInvalid ? (
          <svg className="gallery-drop-icon" viewBox="0 0 24 24" width="36" height="36" aria-hidden="true">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M12 7.5v5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="12" cy="16.4" r="0.9" fill="currentColor" />
          </svg>
        ) : (
          <svg className="gallery-drop-icon" viewBox="0 0 24 24" width="36" height="36" aria-hidden="true">
            <path d="M12 4v11" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <path d="M7.5 11 12 15.5 16.5 11" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M5 18.5h14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        )}
        <p className="gallery-drop-title">{copy.title}</p>
        {copy.warning && <p className="gallery-drop-warning">{copy.warning}</p>}
        <p className="gallery-drop-hint">{copy.hint}</p>
        <p className="gallery-drop-formats">{copy.formats}</p>
      </div>
    </div>
  );
}
