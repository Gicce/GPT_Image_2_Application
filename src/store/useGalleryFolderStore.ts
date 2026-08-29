import { create } from 'zustand';
import type { ImageFolder } from '../types';
import { api } from '../services/api';

/**
 * 图库自定义文件夹（V6.6，ADR-029）：
 * folders 是「图片库新建文件夹」的唯一数据源——Gallery 筛选下拉与
 * OutputPathPicker 输出位置下拉共用；创建走 Rust（真实建目录 + 注册表插行）。
 */
interface GalleryFolderState {
  folders: ImageFolder[];
  loaded: boolean;
  loading: boolean;
  loadFolders: () => Promise<void>;
  createFolder: (name: string) => Promise<ImageFolder>;
  removeFolder: (id: string) => Promise<void>;
}

export const useGalleryFolderStore = create<GalleryFolderState>((set, get) => ({
  folders: [],
  loaded: false,
  loading: false,

  loadFolders: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const folders = await api.listImageFolders();
      set({ folders, loaded: true, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  createFolder: async (name) => {
    const folder = await api.createImageFolder(name);
    set({ folders: [...get().folders, folder], loaded: true });
    return folder;
  },

  removeFolder: async (id) => {
    const prev = get().folders;
    set({ folders: prev.filter(folder => folder.id !== id) });
    try {
      await api.deleteImageFolder(id);
    } catch (err) {
      set({ folders: prev });
      throw err;
    }
  },
}));
