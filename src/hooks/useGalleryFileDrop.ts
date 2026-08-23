/**
 * 图片库 OS 文件拖入 Hook（V4.1 Gallery Drag Import）。
 *
 * 只在 Gallery 页面挂载（路由级作用域：其它页面拖图片绝不触发图库导入）；
 * enabled=false（详情 Modal / 全局 ImageViewer 打开）时不监听并复位拖拽态，
 * 保证 Active Modal > Gallery File Drop 的优先级。
 * 状态机 / 文案 / 防重入在 features/gallery/galleryFileDrop.ts（纯逻辑，可测）；
 * 本 Hook 只负责：Tauri onDragDropEvent → controller、api / Toast 注入、store 刷新。
 * 非桌面环境（浏览器 dev）下静默不生效。
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { useImageStore } from '../store/useImageStore';
import { toastError, toastLoading, toastUpdate } from '../components/Toast';
import {
  createGalleryFileDropController,
  GALLERY_FILE_DROP_INITIAL_STATE,
  type GalleryFileDropController,
  type GalleryFileDropState,
} from '../features/gallery/galleryFileDrop';

export interface UseGalleryFileDropResult {
  state: GalleryFileDropState;
  controller: GalleryFileDropController;
}

export function useGalleryFileDrop(options: { enabled?: boolean } = {}): UseGalleryFileDropResult {
  const [state, setState] = useState<GalleryFileDropState>(GALLERY_FILE_DROP_INITIAL_STATE);
  const controllerRef = useRef<GalleryFileDropController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createGalleryFileDropController({
      importImages: paths => api.importImagesToLibrary(paths),
      onImportStart: count => toastLoading(`正在导入 ${count} 张图片…`),
      onImportFinish: ({ toastHandle, summary, images }) => {
        if (images.length > 0) {
          // 索引刷新来自 Rust sync_images 的返回值（不二次扫描、不 push 到数组头）
          useImageStore.getState().applyImages(images);
        }
        if (!summary) {
          if (typeof toastHandle === 'number') toastUpdate(toastHandle, '没有可导入的图片', 'info');
          return;
        }
        if (typeof toastHandle === 'number') {
          toastUpdate(toastHandle, summary.main.text, summary.main.kind);
        }
        // 失败原因详情：紧跟一条独立错误 Toast（不另造通知系统）
        if (summary.failureDetail) toastError(summary.failureDetail);
      },
      onImportError: ({ toastHandle, message }) => {
        if (typeof toastHandle === 'number') {
          toastUpdate(toastHandle, message || '导入失败，请重试', 'error');
        }
      },
      onEmptyDrop: () => {
        toastError('没有可导入的图片', '仅支持 PNG、JPG、JPEG、WebP 图片。');
      },
    });
  }
  const controller = controllerRef.current;
  const enabled = options.enabled !== false;

  useEffect(() => controller.subscribe(() => setState(controller.getState())), [controller]);

  useEffect(() => {
    if (!enabled) {
      controller.reset();
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;
    // 动态 import：浏览器 dev 环境无 @tauri-apps/api webview 时保持可用
    import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent(event => {
          const payload = event.payload as { type: string; paths?: string[] };
          const paths = payload.paths || [];
          if (payload.type === 'enter' || payload.type === 'over') {
            void controller.handleEvent(payload.type === 'enter' ? { type: 'enter', paths } : { type: 'over' });
            return;
          }
          if (payload.type === 'leave') {
            void controller.handleEvent({ type: 'leave' });
            return;
          }
          if (payload.type === 'drop') {
            void controller.handleEvent({ type: 'drop', paths });
          }
        }),
      )
      .then(fn => {
        if (disposed) {
          fn?.();
          return;
        }
        unlisten = fn ?? null;
      })
      .catch(() => {
        // 浏览器环境 / Tauri API 不可用：拖拽导入静默关闭
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, controller]);

  return { state, controller };
}
