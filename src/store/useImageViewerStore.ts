/**
 * 全局内置图片查看器状态（CyImagePro Built-in Image Viewer）：
 * 任意页面把可预览图片组装成 ImageViewerItem[] 交给 openViewer，
 * App 级单例 <ImageViewer /> 负责渲染（缩放 / 平移 / 多图切换 / 复制 / 另存为）。
 * 不承载业务：评价、收藏等业务信息只作为展示 metadata 传入。
 */

import { create } from 'zustand';

export interface ImageViewerMetadataEntry {
  label: string;
  value: string;
}

export interface ImageViewerItem {
  /** 稳定 id（多图切换时 React key；缺省用 index）。 */
  id?: string;
  /** 完整图 URL（data URL）；与 path 二选一，都给时优先 src。 */
  src?: string;
  /** 本地路径（组件内 readImageData 加载完整图；另存为默认文件名来源）。 */
  path?: string;
  title?: string;
  width?: number;
  height?: number;
  /** 另存为默认文件名。 */
  fileName?: string;
  /** 生成 Prompt（结果图「这张图当时用了什么 Prompt」）。 */
  prompt?: string;
  /** 业务元信息（模型 / 任务 / 评分等，右侧信息面板展示）。 */
  metadata?: ImageViewerMetadataEntry[];
}

interface ImageViewerState {
  open: boolean;
  items: ImageViewerItem[];
  index: number;
  /** 打开查看器（index 缺省 0；越界钳位）。 */
  openViewer: (items: ImageViewerItem[], index?: number) => void;
  close: () => void;
  next: () => void;
  prev: () => void;
  setIndex: (index: number) => void;
}

export const useImageViewerStore = create<ImageViewerState>((set, get) => ({
  open: false,
  items: [],
  index: 0,

  openViewer: (items, index = 0) => {
    if (items.length === 0) return;
    set({
      open: true,
      items,
      index: Math.min(Math.max(index, 0), items.length - 1),
    });
  },

  close: () => set({ open: false, items: [], index: 0 }),

  next: () => {
    const { items, index } = get();
    if (items.length < 2) return;
    set({ index: (index + 1) % items.length });
  },

  prev: () => {
    const { items, index } = get();
    if (items.length < 2) return;
    set({ index: (index - 1 + items.length) % items.length });
  },

  setIndex: index => {
    const { items } = get();
    if (index < 0 || index >= items.length) return;
    set({ index });
  },
}));
