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
  ColorSimilarityResult,
  CreateBatchRedoRequest,
  CreateTaskParams,
  EnvCheckResult,
  GenerateTestImageResult,
  ImageMeta,
  ImageRecord,
  Settings,
  Task,
  VideoSyncResult,
  VisionAnalyzeResult,
  VisionCompareResult,
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
  /** V4.0.7 视觉理解任务状态推进（前端驱动；pending → running → completed/failed/cancelled） */
  updateVisionTask: (params: {
    taskId: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    stageNote?: string;
    planSummary?: string;
    error?: string;
  }): Promise<Task> =>
    invoke('update_vision_task', {
      params: {
        task_id: params.taskId,
        status: params.status,
        stage_note: params.stageNote ?? '',
        plan_summary: params.planSummary ?? '',
        error: params.error ?? '',
      },
    }),
  retryTask: (taskId: string): Promise<Task> => invoke('retry_task', { taskId }),
  retryTaskSubtasks: (taskId: string, subTaskIndexes?: number[] | null): Promise<{ resetIndexes: number[]; resetCount: number }> =>
    invoke('retry_task_subtasks', { taskId, subTaskIndexes: subTaskIndexes ?? null }),
  /** V4.0.6 批量重做：基于源任务选中子项创建全新任务（源任务不可变；计费在 store 层授权） */
  createBatchRedoTask: (request: CreateBatchRedoRequest): Promise<Task> =>
    invoke('create_batch_redo_task', { request }),
  /** V4.0.6 视觉理解：单图结构化分析（BYOK 视觉模型，OpenAI 兼容 chat completions） */
  visionAnalyzeImage: (request: {
    imagePath: string;
    baseUrl: string;
    token: string;
    model: string;
    mode?: string;
    extraInstructions?: string;
  }): Promise<VisionAnalyzeResult> =>
    invoke('vision_analyze_image', {
      request: {
        image_path: request.imagePath,
        base_url: request.baseUrl,
        token: request.token,
        model: request.model,
        mode: request.mode ?? 'reverse_prompt',
        extra_instructions: request.extraInstructions ?? '',
      },
    }),
  /** V4.0.6 双图交叉评审（源图 + 候选图 → 分维度相似度 JSON） */
  visionCompareImages: (request: {
    sourcePath: string;
    candidatePath: string;
    baseUrl: string;
    token: string;
    model: string;
  }): Promise<VisionCompareResult> =>
    invoke('vision_compare_images', {
      request: {
        source_path: request.sourcePath,
        candidate_path: request.candidatePath,
        base_url: request.baseUrl,
        token: request.token,
        model: request.model,
      },
    }),
  /** V4.0.6 本地色彩相似度（无 AI 调用） */
  computeColorSimilarity: (sourcePath: string, candidatePath: string): Promise<ColorSimilarityResult> =>
    invoke('compute_color_similarity', { sourcePath, candidatePath }),
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
  syncImageToVideo: (params: {
    imageId: string;
    taskId?: string | null;
    filePath: string;
    fileName: string;
    prompt?: string | null;
    width?: number | null;
    height?: number | null;
    createdAt?: string | null;
    model?: string | null;
    userPromptRaw?: string | null;
    finalPrompt?: string | null;
    finalNegativePrompt?: string | null;
    promptOptimized?: boolean | null;
    displayTitle?: string | null;
  }): Promise<VideoSyncResult> => invoke('sync_image_to_video', {
    params: {
      imageId: params.imageId,
      taskId: params.taskId ?? null,
      filePath: params.filePath,
      fileName: params.fileName,
      prompt: params.prompt ?? null,
      width: params.width ?? null,
      height: params.height ?? null,
      createdAt: params.createdAt ?? null,
      model: params.model ?? null,
      userPromptRaw: params.userPromptRaw ?? null,
      finalPrompt: params.finalPrompt ?? null,
      finalNegativePrompt: params.finalNegativePrompt ?? null,
      promptOptimized: params.promptOptimized ?? null,
      displayTitle: params.displayTitle ?? null,
    },
  }),
  openExternalUrl: (url: string): Promise<void> => invoke('open_external_url', { url }),
  /** CY Video Studio Bridge 健康检查（启动后轮询用） */
  videoBridgeOnline: (): Promise<boolean> => invoke('video_bridge_online'),
  /** 自动启动 CY Video Studio（进程已在时不重复拉起；找不到安装位置抛 CY_VIDEO_NOT_FOUND: 前缀错误） */
  launchVideoStudio: (): Promise<{ launched: boolean; reason: string; executable: string }> =>
    invoke('launch_video_studio'),
  /** 手动选择 CY Video Studio.exe 并保存到应用设置 */
  pickVideoStudioExecutable: (): Promise<string> => invoke('pick_video_studio_executable'),
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
  listProviderModels: (payload: { base_url: string; token: string }): Promise<{
    ok: boolean;
    status?: number;
    models: string[];
    error_kind?: string;
    error_message?: string;
  }> => invoke('list_provider_models', { payload }),
  understandChatImages: (payload: VisionUnderstandPayload): Promise<VisionUnderstandResult> => invoke('understand_chat_images', { payload }),
  checkAgentEndpoints: (agentBaseUrl: string, agentModel: string, agentToken: string, officialToken: string, visionModel: string): Promise<AgentEndpointCheckResult> =>
    invoke('check_agent_endpoints', { agentBaseUrl, agentModel, agentToken, officialToken, visionModel }),
  setRuntimeAuthConfig: (config: {
    imageToken?: string;
    imageBaseUrl?: string;
    agentToken?: string;
    agentBaseUrl?: string;
    postprocessToken?: string;
    postprocessBaseUrl?: string;
  }): Promise<void> => invoke('set_runtime_auth_config', {
    config: {
      image_token: config.imageToken ?? '',
      image_base_url: config.imageBaseUrl ?? '',
      agent_token: config.agentToken ?? '',
      agent_base_url: config.agentBaseUrl ?? '',
      postprocess_token: config.postprocessToken ?? '',
      postprocess_base_url: config.postprocessBaseUrl ?? '',
    }
  }),
  clearRuntimeAuthConfig: (): Promise<void> => invoke('clear_runtime_auth_config'),
  getRuntimeAuthStatus: (): Promise<{ has_image_token: boolean; has_agent_token: boolean; has_postprocess_token: boolean; image_base_url: string; agent_base_url: string; postprocess_base_url: string }> =>
    invoke('get_runtime_auth_status'),
  checkEnvironment: (): Promise<EnvCheckResult> => invoke('check_environment'),
  generateTestImage: (): Promise<GenerateTestImageResult> => invoke('generate_test_image'),
};
