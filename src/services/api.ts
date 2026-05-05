import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Settings, Task, ImageRecord, CreateTaskParams } from '../types';

export const api = {
  getSettings: (): Promise<Settings> => invoke('get_settings'),
  saveSettings: (settings: Settings): Promise<void> => invoke('save_settings', { settings }),
  getTasks: (): Promise<Task[]> => invoke('get_tasks'),
  createTask: (params: CreateTaskParams): Promise<Task> => invoke('create_task', { params }),
  cancelTask: (taskId: string): Promise<void> => invoke('cancel_task', { taskId }),
  getImages: (): Promise<ImageRecord[]> => invoke('get_images'),
  deleteImage: (imageId: string): Promise<void> => invoke('delete_image', { imageId }),
  readImageData: (path: string): Promise<string> => invoke('read_image_data', { path }),
  openFile: (path: string): Promise<void> => invoke('open_file', { path }),
  openFolder: (path: string): Promise<void> => invoke('open_folder', { path }),
  selectDirectory: (): Promise<string | null> => invoke('select_directory'),
  onTaskUpdated: (handler: (taskId: string) => void) =>
    listen<string>('task-updated', (event) => handler(event.payload)),
};
