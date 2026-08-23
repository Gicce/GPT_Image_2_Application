import { create } from 'zustand';
import type { ImageRecord } from '../types';
import { api } from '../services/api';

interface ImageState {
  images: ImageRecord[];
  loading: boolean;
  loadImages: () => Promise<void>;
  rescanImages: () => Promise<void>;
  /** 用 Rust 命令返回的全量记录直接刷新（导入等已拿到最新列表的场景，避免二次扫描） */
  applyImages: (images: ImageRecord[]) => void;
  deleteImage: (imageId: string) => Promise<void>;
}

export const useImageStore = create<ImageState>((set, get) => ({
  images: [],
  loading: false,

  applyImages: images => set({ images }),

  loadImages: async () => {
    set({ loading: true });
    try {
      const images = await api.getImages();
      set({ images, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  rescanImages: async () => {
    set({ loading: true });
    try {
      const images = await api.rescanImageLibrary();
      set({ images, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  deleteImage: async (imageId) => {
    const prev = get().images;
    set({ images: prev.filter(img => img.id !== imageId) });
    try {
      await api.deleteImage(imageId);
    } catch (err) {
      set({ images: prev });
      throw err;
    }
  },
}));
