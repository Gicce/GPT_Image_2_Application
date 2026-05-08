import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Settings, Task, ImageRecord, CreateTaskParams, ChatConversation } from '../types';

export const api = {
  getSettings: (): Promise<Settings> => invoke('get_settings'),
  saveSettings: (settings: Settings): Promise<void> => invoke('save_settings', { settings }),
  getTasks: (): Promise<Task[]> => invoke('get_tasks'),
  createTask: (params: CreateTaskParams): Promise<Task> => invoke('create_task', { params }),
  cancelTask: (taskId: string): Promise<void> => invoke('cancel_task', { taskId }),
  retryTask: (taskId: string): Promise<Task> => invoke('retry_task', { taskId }),
  getImages: (): Promise<ImageRecord[]> => invoke('get_images'),
  deleteImage: (imageId: string): Promise<void> => invoke('delete_image', { imageId }),
  deleteTask: (taskId: string, deleteImages: boolean): Promise<void> => invoke('delete_task', { taskId, deleteImages }),
  readImageData: (path: string): Promise<string> => invoke('read_image_data', { path }),
  readThumbnail: (path: string): Promise<string> => invoke('read_thumbnail', { path }),
  openFile: (path: string): Promise<void> => invoke('open_file', { path }),
  openFolder: (path: string): Promise<void> => invoke('open_folder', { path }),
  selectDirectory: (): Promise<string | null> => invoke('select_directory'),
  selectImageFile: (): Promise<string | null> => invoke('select_image_file'),
  onTaskUpdated: (handler: (taskId: string) => void) =>
    listen<string>('task-updated', (event) => handler(event.payload)),
  getConversations: (): Promise<ChatConversation[]> => invoke('get_conversations'),
  saveConversations: (conversations: ChatConversation[]): Promise<void> => invoke('save_conversations', { conversations }),
  saveChatImage: (b64Data: string, conversationId: string): Promise<ImageRecord> => invoke('save_chat_image', { b64Data, conversationId }),
  saveImageAs: (b64Data: string, defaultName: string): Promise<boolean> => invoke('save_image_as', { b64Data, defaultName }),
  chatGenerateImage: (prompt: string, model: string): Promise<string> => invoke('chat_generate_image', { prompt, model }),
  chatEditImage: (prompt: string, model: string, imagePath: string): Promise<string> => invoke('chat_edit_image', { prompt, model, imagePath }),
};
