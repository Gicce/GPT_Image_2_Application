import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  AgentEndpointCheckResult,
  AgentStyleTemplate,
  AgentTaskTemplate,
  AgentTemplateDraftPayload,
  AgentTemplateExportPayload,
  AgentTemplateImportPayload,
  AgentTemplateLog,
  ChatConversation,
  CreateTaskParams,
  ImageMeta,
  ImageRecord,
  Settings,
  Task,
  VisionUnderstandPayload,
  VisionUnderstandResult,
} from '../types';
import { invalidateAgentTemplateCache } from '../utils/agent/templateCache';

export const api = {
  getSettings: (): Promise<Settings> => invoke('get_settings'),
  saveSettings: (settings: Settings): Promise<void> => invoke('save_settings', { settings }),
  getAgentTaskTemplates: (): Promise<AgentTaskTemplate[]> => invoke('get_agent_task_templates'),
  saveAgentTaskTemplate: async (template: AgentTaskTemplate): Promise<AgentTaskTemplate> => {
    const saved = await invoke<AgentTaskTemplate>('save_agent_task_template', { template });
    invalidateAgentTemplateCache();
    return saved;
  },
  deleteAgentTaskTemplate: async (id: string): Promise<void> => {
    await invoke('delete_agent_task_template', { id });
    invalidateAgentTemplateCache();
  },
  toggleAgentTaskTemplate: async (id: string, enabled: boolean): Promise<void> => {
    await invoke('toggle_agent_task_template', { id, enabled });
    invalidateAgentTemplateCache();
  },
  getAgentStyleTemplates: (): Promise<AgentStyleTemplate[]> => invoke('get_agent_style_templates'),
  saveAgentStyleTemplate: async (template: AgentStyleTemplate): Promise<AgentStyleTemplate> => {
    const saved = await invoke<AgentStyleTemplate>('save_agent_style_template', { template });
    invalidateAgentTemplateCache();
    return saved;
  },
  deleteAgentStyleTemplate: async (id: string): Promise<void> => {
    await invoke('delete_agent_style_template', { id });
    invalidateAgentTemplateCache();
  },
  toggleAgentStyleTemplate: async (id: string, enabled: boolean): Promise<void> => {
    await invoke('toggle_agent_style_template', { id, enabled });
    invalidateAgentTemplateCache();
  },
  getAgentTemplateLogs: (limit?: number): Promise<AgentTemplateLog[]> => invoke('get_agent_template_logs', { limit }),
  appendAgentTemplateLog: (log: AgentTemplateLog): Promise<AgentTemplateLog> => invoke('append_agent_template_log', { log }),
  exportAgentTemplates: (): Promise<AgentTemplateExportPayload> => invoke('export_agent_templates'),
  exportAgentTemplateDraft: (templateType: 'task' | 'style', templateId: string): Promise<AgentTemplateDraftPayload> =>
    invoke('export_agent_template_draft', { templateType, templateId }),
  importAgentTemplates: async (payload: AgentTemplateImportPayload, conflictMode: 'overwrite' | 'skip'): Promise<AgentTemplateExportPayload> => {
    const imported = await invoke<AgentTemplateExportPayload>('import_agent_templates', { payload, conflictMode });
    invalidateAgentTemplateCache();
    return imported;
  },
  getTasks: (): Promise<Task[]> => invoke('get_tasks'),
  createTask: (params: CreateTaskParams): Promise<Task> => invoke('create_task', { params }),
  cancelTask: (taskId: string): Promise<void> => invoke('cancel_task', { taskId }),
  retryTask: (taskId: string): Promise<Task> => invoke('retry_task', { taskId }),
  getImages: (): Promise<ImageRecord[]> => invoke('get_images'),
  rescanImageLibrary: (): Promise<ImageRecord[]> => invoke('rescan_image_library'),
  getImageMeta: (path: string): Promise<ImageMeta> => invoke('get_image_meta', { path }),
  updateImageIndex: (imageId: string, width: number | null, height: number | null, description: string | null, tags: string[]): Promise<ImageRecord> =>
    invoke('update_image_index', { imageId, width, height, description, tags }),
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
  saveConversation: (conversation: ChatConversation): Promise<void> => invoke('save_conversation', { conversation }),
  saveChatImage: (b64Data: string, conversationId: string): Promise<ImageRecord> => invoke('save_chat_image', { b64Data, conversationId }),
  saveImageAs: (b64Data: string, defaultName: string): Promise<boolean> => invoke('save_image_as', { b64Data, defaultName }),
  removeBackground: (imagePath: string): Promise<ImageRecord> => invoke('remove_background', { imagePath }),
  chatGenerateImage: (prompt: string, model: string): Promise<string> => invoke('chat_generate_image', { prompt, model }),
  chatEditImage: (prompt: string, model: string, imagePath: string): Promise<string> => invoke('chat_edit_image', { prompt, model, imagePath }),
  runAgentRequest: (payload: any): Promise<any> => invoke('run_agent_request', { payload }),
  understandChatImages: (payload: VisionUnderstandPayload): Promise<VisionUnderstandResult> => invoke('understand_chat_images', { payload }),
  checkAgentEndpoints: (agentBaseUrl: string, agentModel: string, agentToken: string, officialToken: string, visionModel: string): Promise<AgentEndpointCheckResult> =>
    invoke('check_agent_endpoints', { agentBaseUrl, agentModel, agentToken, officialToken, visionModel }),
};
