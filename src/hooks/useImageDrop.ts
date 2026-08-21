/**
 * Tauri 图片拖放 Hook（V4.0.8）—— 全项目 OS 文件拖入的唯一监听封装。
 *
 * Tauri 2 默认拦截 OS 文件拖放（dragDropEnabled），HTML5 drop 事件在
 * WebView2 下拿不到 dataTransfer.files，必须走 webview.onDragDropEvent
 * （与视觉理解页既有实现同一路径，统一复用，不造第二套）。
 *
 * 事件是窗口级的：本 Hook 只负责 dragActive 状态与路径分流，
 * 单图 / 多图、附件 / 参考图等业务语义由调用方决定。
 * 非桌面环境（浏览器 dev）下静默不生效。
 */

import { useEffect, useRef, useState } from 'react';
import { splitDroppedPaths, type DroppedImageFile } from '../utils/imageDropFiles';

export interface UseImageDropOptions {
  /** false 时不监听（如文生图模式下参考图区域不存在）。 */
  enabled?: boolean;
  /** 拖入松开：已按扩展名筛出的合法图片（真实可读性由调用方在校验阶段确认）。 */
  onDropImages: (files: DroppedImageFile[]) => void;
  /** 拖入松开：非法路径（目录 / 非图片扩展名）。混拖时合法图片仍会走 onDropImages。 */
  onDropInvalid?: (paths: string[]) => void;
}

export interface UseImageDropResult {
  /** true = 文件正悬停在窗口上（enter/over 且含至少一个合法图片路径）。 */
  dragActive: boolean;
}

export function useImageDrop(options: UseImageDropOptions): UseImageDropResult {
  const [dragActive, setDragActive] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const enabled = options.enabled !== false;

  useEffect(() => {
    if (!enabled) {
      setDragActive(false);
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;
    // 动态 import：浏览器 dev 环境无 @tauri-apps/api webview 时保持可用
    import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent(event => {
        const payload = event.payload as { type: string; paths?: string[] };
        if (payload.type === 'enter' || payload.type === 'over') {
          const paths = payload.paths || [];
          // enter 带 paths；over 只带位置 —— enter 已判定则保持高亮
          if (paths.length === 0 || paths.some(p => /\.(png|jpe?g|webp)$/i.test(p))) {
            setDragActive(true);
          }
          return;
        }
        if (payload.type === 'leave') {
          setDragActive(false);
          return;
        }
        if (payload.type === 'drop') {
          setDragActive(false);
          const { images, invalid } = splitDroppedPaths(payload.paths || []);
          if (images.length > 0) optionsRef.current.onDropImages(images);
          if (invalid.length > 0) optionsRef.current.onDropInvalid?.(invalid);
        }
      }))
      .then(fn => {
        if (disposed) {
          fn?.();
          return;
        }
        unlisten = fn ?? null;
      })
      .catch(() => {
        // 浏览器环境 / Tauri API 不可用：拖拽功能静默关闭
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);

  return { dragActive };
}
