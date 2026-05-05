import { create } from 'zustand';
import type { ImageRecord } from '../types';
import { api } from '../services/api';

interface ImageState {
  images: ImageRecord[];
  loading: boolean;
  loadImages: () => Promise<void>;
  deleteImage: (imageId: string) => Promise<void>;
}

export const useImageStore = create<ImageState>((set, get) => ({
  images: [],
  loading: false,

  loadImages: async () => {
    set({ loading: true });
    try {
      const images = await api.getImages();
      set({ images, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  deleteImage: async (imageId) => {
    await api.deleteImage(imageId);
    set({ images: get().images.filter(img => img.id !== imageId) });
  },
}));
