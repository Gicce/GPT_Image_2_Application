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
  ImageFolder,
  ImageMeta,
  ImageRecord,
  ImportImagesToLibraryResult,
  Settings,
  Task,
  VideoSyncResult,
  VisionAnalyzeResult,
  VisionCompareResult,
  VisionUnderstandPayload,
  VisionUnderstandResult,
} from '../types';
import { invalidateAgentTemplateCache } from '../utils/agent/templateCache';
import type { EvaluateImageOutcome, EvaluateImageRequestPayload, ImageEvaluation } from '../features/evaluation/types';
import type { VisualProjectSummary } from '../features/vision/project/types';
import type {
  AnimeConsistencyEvaluateOutcome,
  AnimeConsistencyEvaluatePayload,
  AnimeConsistencyEvaluationRecord,
} from '../features/evaluation/types';

/** V5 插图实例提取结果（vision_extract_detail_inserts；snake_case Rust 直出）。 */
export interface VisionExtractInsertsResult {
  ok: boolean;
  instances: Array<{
    label: string;
    crop_type: string;
    media_type: string;
    position?: { x: number; y: number; width: number; height: number } | null;
    target_subject_role: string;
    description: string;
  }> | null;
  error_kind: string | null;
  error_message: string | null;
  status: number | null;
}

/** V5 人物参考外貌事实结果（vision_analyze_reference_appearance）。 */
export interface VisionReferenceAppearanceResult {
  ok: boolean;
  facts: {
    hair_color: string;
    hair_length: string;
    hair_texture: string;
    hair_parting: string;
    hair_bangs: string;
    hair_silhouette: string;
    face_shape: string;
    eye_shape: string;
    iris_color: string;
    eyelash_style: string;
    accessories: string[];
    clothing: string[];
  } | null;
  error_kind: string | null;
  error_message: string | null;
  status: number | null;
}

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
  /** V4.1 Visual Project：项目文档 CRUD（schema 由前端维护，Rust JSON 透传） */
  listVisualProjects: (): Promise<VisualProjectSummary[]> => invoke('list_visual_projects'),
  loadVisualProject: (id: string): Promise<string | null> => invoke('load_visual_project', { id }),
  saveVisualProject: (input: {
    id: string;
    name: string;
    status: string;
    revision: number;
    coverPath?: string | null;
    dataJson: string;
    lastOpenedAt?: string | null;
  }): Promise<void> =>
    invoke('save_visual_project', {
      id: input.id,
      name: input.name,
      status: input.status,
      revision: input.revision,
      coverPath: input.coverPath ?? null,
      dataJson: input.dataJson,
      lastOpenedAt: input.lastOpenedAt ?? null,
    }),
  renameVisualProject: (id: string, name: string): Promise<void> =>
    invoke('rename_visual_project', { id, name }),
  deleteVisualProject: (id: string): Promise<void> => invoke('delete_visual_project', { id }),
  /** 区域 mask PNG 落盘（返回绝对路径写入 region.maskPath） */
  saveVisualProjectMask: (projectId: string, regionId: string, pngBase64: string): Promise<string> =>
    invoke('save_visual_project_mask', { projectId, regionId, pngBase64 }),
  /** Project Index Recovery：扫描 data_json 修复摘要列漂移（只读→比对→修复，不删行） */
  rebuildVisualProjectIndex: (): Promise<{ rowsScanned: number; repaired: number }> =>
    invoke('rebuild_visual_project_index'),
  /** V4.2.2 Skill Workshop：本地版本化项目 JSON 透传。 */
  listSkillProjects: (): Promise<Array<{ id: string; name: string; skillId: string; skillVersion: string; status: string; revision: number; updatedAt: string; lastOpenedAt: string }>> =>
    invoke('list_skill_projects'),
  loadSkillProject: (id: string): Promise<string | null> => invoke('load_skill_project', { id }),
  saveSkillProject: (input: { id: string; name: string; skillId: string; skillVersion: string; status: string; revision: number; dataJson: string; lastOpenedAt?: string | null }): Promise<void> =>
    invoke('save_skill_project', {
      id: input.id, name: input.name, skillId: input.skillId, skillVersion: input.skillVersion,
      status: input.status, revision: input.revision, dataJson: input.dataJson, lastOpenedAt: input.lastOpenedAt ?? null,
    }),
  deleteSkillProject: (id: string): Promise<void> => invoke('delete_skill_project', { id }),
  /** V4.2.3 用户自建 Skill：定义与具体 SkillProject 分离，本地 JSON 透传。 */
  listUserSkills: (): Promise<Array<{ id: string; name: string; domain: string; version: string; status: string; sourceProjectId?: string | null; sourceRevision: number; authoringState: string; updatedAt: string }>> =>
    invoke('list_user_skills'),
  loadUserSkill: (id: string): Promise<string | null> => invoke('load_user_skill', { id }),
  saveUserSkill: (input: { id: string; name: string; domain: string; version: string; status: string; sourceProjectId?: string | null; sourceRevision: number; authoringState: string; dataJson: string }): Promise<void> =>
    invoke('save_user_skill', {
      id: input.id, name: input.name, domain: input.domain, version: input.version,
      status: input.status, sourceProjectId: input.sourceProjectId ?? null,
      sourceRevision: input.sourceRevision, authoringState: input.authoringState, dataJson: input.dataJson,
    }),
  deleteUserSkill: (id: string): Promise<void> => invoke('delete_user_skill', { id }),
  /** AI 漫画 Phase 1：本地三表（projects/skills/characters），schema 前端所有，Rust JSON 透传。 */
  listComicProjects: (): Promise<Array<{ id: string; name: string; stage: string; skillId?: string | null; updatedAt: string; lastOpenedAt?: string | null }>> =>
    invoke('list_comic_projects'),
  loadComicProject: (id: string): Promise<string | null> => invoke('load_comic_project', { id }),
  saveComicProject: (input: { id: string; name: string; stage: string; skillId?: string | null; dataJson: string; lastOpenedAt?: string | null }): Promise<void> =>
    invoke('save_comic_project', {
      id: input.id, name: input.name, stage: input.stage, skillId: input.skillId ?? null,
      dataJson: input.dataJson, lastOpenedAt: input.lastOpenedAt ?? null,
    }),
  renameComicProject: (id: string, name: string): Promise<void> => invoke('rename_comic_project', { id, name }),
  deleteComicProject: (id: string): Promise<void> => invoke('delete_comic_project', { id }),
  listComicSkills: (): Promise<Array<{ id: string; name: string; comicForm: string; version: number; source: string; updatedAt: string }>> =>
    invoke('list_comic_skills'),
  loadComicSkill: (id: string): Promise<string | null> => invoke('load_comic_skill', { id }),
  saveComicSkill: (input: { id: string; name: string; comicForm: string; version: number; source: string; dataJson: string }): Promise<void> =>
    invoke('save_comic_skill', {
      id: input.id, name: input.name, comicForm: input.comicForm,
      version: input.version, source: input.source, dataJson: input.dataJson,
    }),
  deleteComicSkill: (id: string): Promise<void> => invoke('delete_comic_skill', { id }),
  listComicCharacters: (): Promise<Array<{ id: string; name: string; role: string; status: string; source: string; updatedAt: string; usageCount: number; lastUsedAt: string; thumbnailPath: string }>> =>
    invoke('list_comic_characters'),
  loadComicCharacter: (id: string): Promise<string | null> => invoke('load_comic_character', { id }),
  saveComicCharacter: (input: { id: string; name: string; role: string; status: string; source: string; dataJson: string }): Promise<void> =>
    invoke('save_comic_character', {
      id: input.id, name: input.name, role: input.role,
      status: input.status, source: input.source, dataJson: input.dataJson,
    }),
  deleteComicCharacter: (id: string): Promise<void> => invoke('delete_comic_character', { id }),
  /** 用户主动触发的 Logo 规范分析；原图仅以内联数据传给已配置视觉模型。 */
  analyzeBrandLogo: (request: { imagePath: string; baseUrl: string; token: string; model: string }): Promise<{ analysis: Record<string, unknown>; model: string }> =>
    invoke('analyze_brand_logo', { request }),
  fingerprintSkillAsset: (path: string): Promise<string> => invoke('fingerprint_skill_asset', { path }),
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
  /** V5 受限插图实例提取（只补 instances，不重写模板快照；用户在提示时手动触发） */
  visionExtractDetailInserts: (request: {
    imagePath: string;
    baseUrl: string;
    token: string;
    model: string;
    layerLabel: string;
    layerDescription: string;
  }): Promise<VisionExtractInsertsResult> =>
    invoke('vision_extract_detail_inserts', {
      request: {
        image_path: request.imagePath,
        base_url: request.baseUrl,
        token: request.token,
        model: request.model,
        layer_label: request.layerLabel,
        layer_description: request.layerDescription,
      },
    }),
  /** V5 人物参考外貌事实解析（ReferenceAppearanceSnapshot 事实体；失败不阻断） */
  visionAnalyzeReferenceAppearance: (request: {
    imagePath: string;
    baseUrl: string;
    token: string;
    model: string;
  }): Promise<VisionReferenceAppearanceResult> =>
    invoke('vision_analyze_reference_appearance', {
      request: {
        image_path: request.imagePath,
        base_url: request.baseUrl,
        token: request.token,
        model: request.model,
      },
    }),
  /** V4.0.6 本地色彩相似度（无 AI 调用） */
  computeColorSimilarity: (sourcePath: string, candidatePath: string): Promise<ColorSimilarityResult> =>
    invoke('compute_color_similarity', { sourcePath, candidatePath }),
  /** V4.0.9 统一图片评价：任务感知 AI 评价（BYOK 视觉模型，失败不影响生成任务） */
  evaluateImage: (request: EvaluateImageRequestPayload): Promise<EvaluateImageOutcome> =>
    invoke('evaluate_image', { request }),
  /** V4.0.9 查询持久化评价（缺省全量；图库筛选只读这里，绝不现场重算） */
  getImageEvaluations: (assetIds?: string[] | null): Promise<ImageEvaluation[]> =>
    invoke('get_image_evaluations', { assetIds: assetIds ?? null }),
  /** V5 动漫角色一致性评价（手动触发 / 重试；失败不阻塞生成任务） */
  evaluateAnimeCharacterConsistency: (request: AnimeConsistencyEvaluatePayload): Promise<AnimeConsistencyEvaluateOutcome> =>
    invoke('evaluate_anime_character_consistency', { request }),
  /** V5 查询动漫角色一致性评价（旧任务无记录 = UI 不显示，绝不发明分数） */
  getAnimeConsistencyEvaluations: (assetIds?: string[] | null): Promise<AnimeConsistencyEvaluationRecord[]> =>
    invoke('get_anime_consistency_evaluations', { assetIds: assetIds ?? null }),
  /** V4.0.9 用户反馈独立落库（liked / disliked / null + 问题标签 + 补充说明） */
  updateImageEvaluationFeedback: (assetId: string, rating: 'liked' | 'disliked' | null, issueTags: string[], comment: string): Promise<ImageEvaluation | null> =>
    invoke('update_image_evaluation_feedback', { assetId, rating, issueTags, comment }),
  deleteImageEvaluation: (assetId: string): Promise<void> =>
    invoke('delete_image_evaluation', { assetId }),
  /** V4.1 收藏 / 取消收藏（♡ 精选标记；未评价资产也允许收藏，Rust 补插最小行） */
  setImageFavorite: (assetId: string, assetPath: string, favorite: boolean): Promise<ImageEvaluation> =>
    invoke('set_image_favorite', { assetId, assetPath, favorite }),
  getImages: (): Promise<ImageRecord[]> => invoke('get_images'),
  /** V6.6 图库自定义文件夹（ADR-029）：物理目录 + 注册表；删除只删注册行不动磁盘文件 */
  listImageFolders: (): Promise<ImageFolder[]> => invoke('list_image_folders'),
  createImageFolder: (name: string): Promise<ImageFolder> => invoke('create_image_folder', { name }),
  deleteImageFolder: (id: string): Promise<void> => invoke('delete_image_folder', { id }),
  rescanImageLibrary: (): Promise<ImageRecord[]> => invoke('rescan_image_library'),
  /** V4.1 图片库拖拽导入：外部文件复制进 library_input_dir，复用 sync_images 建索引 */
  importImagesToLibrary: (paths: string[]): Promise<ImportImagesToLibraryResult> =>
    invoke('import_images_to_library', { paths }),
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
  saveComicPageToLibrary: (b64Data: string, fileName: string): Promise<string> =>
    invoke('save_comic_page_to_library', { b64Data, fileName }),
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
