import type { Settings, Task, ImageRecord, CreateTaskParams } from './index';

export interface TauriAPI {
  getSettings: () => Promise<Settings>;
  saveSettings: (settings: Settings) => Promise<void>;
  getTasks: () => Promise<Task[]>;
  createTask: (params: CreateTaskParams) => Promise<Task>;
  cancelTask: (taskId: string) => Promise<void>;
  getImages: () => Promise<ImageRecord[]>;
  deleteImage: (imageId: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  openFolder: (path: string) => Promise<void>;
  selectDirectory: () => Promise<string | null>;
  listen: (event: string, handler: (event: any) => void) => Promise<() => void>;
}
