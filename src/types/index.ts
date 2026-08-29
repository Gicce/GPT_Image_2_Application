export interface Settings {
  token: string;
  default_size: string;
  default_quality: string;
  default_format: string;
  default_output_dir: string;
  library_input_dir: string;
  agent_name: string;
  agent_token: string;
  agent_model: string;
  agent_base_url: string;
  agent_system_prompt: string;
  agent_context_window: number;
  ai_avatar_data_url: string;
  user_avatar_data_url: string;
  removebg_api_key: string;
  upscale_provider: 'topaz' | 'custom' | 'disabled';
  topaz_api_key: string;
  vision_model: string;
  chat_token: string;
  chat_model: string;
  chat_base_url: string;
  chat_system_prompt: string;
  server_url: string;
  notice_enabled: boolean;
  theme: 'light' | 'dark' | 'system';
  device_id: string;
  /** 用户手动选择并保存的 CY Video Studio 可执行文件路径（同步素材用；空 = 未配置） */
  video_studio_executable: string;
}

/**
 * 子任务失败结构化快照（V4.1 canonical failure model；Rust task_failure.rs 写入）。
 * 旧 tasks.json 无此字段 —— TS 侧 classifyGenerationFailure 回落解析 error 字符串。
 */
export interface SubTaskErrorDetail {
  /** 失败发生时间（本地 rfc3339）。 */
  timestamp: string;
  /** 失败类别（与 FailureCategory 一致）。 */
  category: string;
  /** 该类失败是否建议重试。 */
  retryable: boolean;
  http_status?: number | null;
  provider_code?: string | null;
  /** 上游 error.type（如 packy_invalid_request_error），纯诊断字段。 */
  provider_type?: string | null;
  request_id?: string | null;
  endpoint?: string | null;
  /** 上游 body 原始 primary 文案（rawMessage）。 */
  message?: string | null;
}

export interface SubTask {
  index: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  image_id?: string;
  error?: string | null;
  label?: string;
  /** 手动「重新生成」累计次数（旧数据缺省 0） */
  retry_count?: number;
  /** 历史 attempt 失败原因（最近在后，最多 5 条；成功后 error 清空但历史保留） */
  attempt_errors?: string[];
  /** 最近一次失败的结构化快照（新数据；旧任务缺失 = 仅 string error） */
  error_detail?: SubTaskErrorDetail | null;
  /** 历史 attempt 的结构化快照（与 attempt_errors 尾部对齐；旧任务缺失） */
  attempt_details?: SubTaskErrorDetail[];
}

export type TaskExecutionMode = 'single' | 'batch';
export type TaskBatchStrategy = 'repeat_same' | 'variant_set' | 'multi_input';

/**
 * 生成参考图业务角色（V4.0.9.1 人物强替换）：单值事实源，
 * 优化器 payload、生成 carry、溯源快照、History 展示共用。
 */
export type GenerationImageRole =
  | 'template'
  | 'person_reference'
  | 'anime_character_reference'
  | 'background_reference'
  | 'style_reference'
  | 'generic_reference';

/** 一张带角色的生成参考图（顺序 = 最终提交 gpt-image-2 的图片顺序）。 */
export interface GenerationImageReference {
  assetId?: string;
  path: string;
  label: string;
  role: GenerationImageRole;
}

/**
 * 生成溯源快照（Generation Provenance Snapshot，V4.0.9）——
 * 「确认生成图片」时冻结的真实执行上下文：用户原话、结构化修改方案、
 * 参考图角色、服装策略、各环节模型。任务创建时随 Task 持久化（Rust 侧 JSON 透传），
 * 历史详情只读这份快照；旧任务缺失时按「未保存」如实展示，禁止用 final_prompt /
 * optimizedPrompt 伪造用户要求。schema 由前端 TS 单一维护（自包含、无反向依赖）。
 */
export interface GenerationProvenanceSnapshot {
  schemaVersion: 1;
  /** 发起功能（目前唯一来源：视觉理解复刻工作流）。 */
  feature: 'vision_recreation';
  /** 用户真实输入的自然语言要求（@token 已解析为 @label 的人类可读版）。 */
  userInstruction?: string;
  /** 底层原文（含 @token；与 mentionBindings 配合可回溯内部 id）。 */
  userInstructionRaw?: string;
  /** @图片引用绑定（token → 真实图片；追踪用，展示层用 label）。 */
  mentionBindings?: Array<{ token: string; label: string; path: string; assetId?: string }>;
  modificationIntent?: {
    /** 用户显式启用的修改维度（subject / pose / scene / camera / style / clothing）。 */
    activeDimensions: string[];
    /** AI 优化判定实际修改的维度（最近一次成功优化落位；未优化时缺省）。 */
    changedDimensions?: string[];
    personReplacement?: {
      enabled: boolean;
      /** gallery | local | description */
      source?: string;
      label?: string;
      hasReferenceImage: boolean;
      /**
       * 替换强度（V4.0.9.1）：strict_identity_replace = 携带参考图的强制身份替换
       * （人物参考 = 主体身份唯一主来源，模板人物身份不保留）；
       * description_replace = 文字描述人物（无参考图，按描述重建人物）。
       */
      replacementMode?: 'strict_identity_replace' | 'description_replace';
      /** 人物参考图路径 / 素材 id（hasReferenceImage 时必有 path）。 */
      personReferencePath?: string;
      personReferenceAssetId?: string;
    };
    /** preserve_original | use_subject_reference | custom */
    clothingPolicy?: string;
    customClothing?: string;
    replicationBoost?: boolean;
  };
  /** 参考图片与各自业务角色（顺序 = 生成时提交顺序）。 */
  imageRoles?: Array<{
    assetId?: string;
    path: string;
    label: string;
    role: GenerationImageRole;
  }>;
  models?: {
    visionAnalysis?: { modelId?: string; displayName?: string; providerName?: string };
    promptOptimizer?: { modelId?: string; displayName?: string; providerName?: string; source?: string };
    imageGeneration?: { modelId?: string; displayName?: string };
    imageEvaluation?: { modelId?: string; displayName?: string; providerName?: string };
  };
  // ===== V4.1 Visual Project Workbench V2（可选；旧任务缺省 = 无项目，禁止伪造）=====
  /** 来源视觉项目 id（项目化链路冻结；旧任务无此字段 = 非项目生成）。 */
  projectId?: string;
  projectName?: string;
  /** 生成时刻的项目语义修订（§20：之后项目改版不影响本快照）。 */
  projectRevision?: number;
  /** 人物替换合同 V2（strength / replaceScope / applyIdentityTo；旧快照缺省）。 */
  personContract?: {
    strength: 'natural' | 'balanced' | 'strict';
    replaceScope: 'whole_person' | 'face' | 'upper_body' | 'custom_region';
    targetRegionId?: string;
    applyIdentityTo: 'primary_subject_only' | 'all_corresponding_subjects';
    preserveTemplateIdentity: false;
  };
  /** 区域替换合同快照（V1：用途 / 范围 / 约束 / 归一化几何 / mask 路径）。 */
  regions?: Array<{
    id: string;
    name: string;
    replaceType: 'person' | 'background' | 'object' | 'custom';
    constraintStrength: 'natural' | 'balanced' | 'strict';
    replaceScope?: 'face' | 'upper_body' | 'whole_person';
    personReferenceLabel?: string;
    prompt?: string;
    rect?: { x: number; y: number; w: number; h: number };
    brush?: { strokes: number; naturalWidth: number; naturalHeight: number };
    maskPath?: string;
  }>;
  /** 媒介结构合同快照（混合媒介模板的层清单；单一媒介只存模式）。 */
  renderingContract?: {
    overallMode: 'single_media' | 'mixed_media';
    singleMode?: string;
    preserveTemplateMediaStructure: boolean;
    regions?: Array<{
      id: string;
      label: string;
      semanticRole: string;
      renderingMode: string;
      identityRelation: string;
    }>;
  };
  // ===== V4.2 Runtime Skill Trace（可选；旧任务缺省 = 无技能记录，禁止伪造）=====
  /** 生成时刻冻结的技能执行快照（History「AI 技能与规则」唯一数据源）。 */
  skillExecutionSnapshot?: SkillExecutionSnapshot;
  // ===== V6.2 Skill Direct Execution（可选；非 Skill 发起缺省 = 禁止伪造）=====
  /**
   * Skill 直接生成溯源：任务由哪个模板复用 Skill、以哪种执行方式发起
   * （direct_generate 直接生成 / open_workbench 高级调整）、哪种 Prompt 策略
   * （reuse_recipe 冻结复用 / adaptive / always_reoptimize）、人物槽位换绑情况。
   */
  skillOrigin?: {
    skillId: string;
    skillName: string;
    skillVersion?: string;
    /** direct_generate = 未进入视觉工作台直接生成（ephemeral 项目）。 */
    executionMode: 'direct_generate' | 'open_workbench';
    /** reuse_recipe = 零 optimizer 调用，基线确定性重编译。 */
    optimizationPolicy: 'reuse_recipe' | 'adaptive' | 'always_reoptimize';
    /** 人物槽位是否换绑了新素材（reuse_recipe 下唯一允许的变量）。 */
    personRebound: boolean;
    /** ephemeral = 直接生成未创建持久视觉项目。 */
    projectKind?: 'ephemeral' | 'persistent';
  };
  // ===== V5 动漫角色参考图任务标记（可选；仅角色一致性准备任务携带）=====
  /**
   * 角色参考图回绑线索（Strict Visual Reference）：任务完成 watcher 据此把
   * 产物图片绑回项目的 animeConsistency.characterAsset（指纹复核后落位）。
   */
  animeCharacterAssetRequest?: {
    projectId: string;
    fingerprint: string;
  };
  // ===== V4.2 Canonical Anime Character（可选；旧任务缺省 = 功能上线前生成，禁止伪造）=====
  /** 生成时刻冻结的动漫角色卡（混合媒介动漫主体的唯一角色设计实例）。 */
  animeCharacterSnapshot?: {
    id: string;
    sourceSubjectLabel: string;
    identitySource: { kind: string; label?: string };
    designSource: string;
    hair: string;
    face: string;
    eyes: string;
    clothing: string;
    expression?: string;
    /** V5：已解析的发型设计事实（缺省 = 功能前生成，禁止伪造）。 */
    hairFacts?: Record<string, string>;
    /** V5：动漫一致性模式（standard / strict_visual_reference；缺省 = standard）。 */
    consistencyMode?: string;
  };
  /**
   * 生成时刻冻结的插图实例绑定（V5：一个画框 = 一个 instance = 一条记录；
   * characterRef 仅动漫实例携带；History 解释「这个相框跟谁」）。
   */
  detailInsertBindings?: Array<{
    instanceId: string;
    insertLabel: string;
    /** 实例媒介（anime_illustration = 同步角色卡；photorealistic = 镜像真人主体）。 */
    mediaType?: string;
    cropType?: string;
    /** 空间位置（「左上 / 右下中部」；分析未产出 = 缺省）。 */
    positionLabel?: string;
    characterRef?: string;
    lockedAspects: string[];
    allowedVariation: string[];
  }>;
}

// ===== Runtime Skill Trace（V4.2）—— Contract 的可解释执行层 =====
//
// 铁律：Contract / Validator 仍是唯一业务真相；Skill 是执行与解释层，
// 绝不另造一份平行业务状态（person_replacement 技能读 PersonReplacementContract，
// pose_preservation 技能读 DimensionLock 合同，禁止 skillXxxState）。

export type RuntimeSkillCategory = 'analysis' | 'constraint' | 'optimization' | 'compiler';

/** 技能发现（「Skill 发现了什么」）。 */
export interface SkillFinding {
  id: string;
  title: string;
  description: string;
  severity?: 'info' | 'important' | 'critical';
  sourceDimension?: string;
  sourceAssetId?: string;
}

/** 技能建议（「Skill 建议了什么」；硬合同类建议 = required，无需用户逐条确认）。 */
export interface SkillSuggestion {
  id: string;
  title: string;
  description: string;
  type: 'recommendation' | 'required';
  status: 'pending' | 'accepted' | 'rejected' | 'auto_applied';
  relatedDimensions?: string[];
}

/** 用户对建议的裁决记录（从合同 / 草稿的用户选择确定性回填，不新增确认弹层）。 */
export interface SkillUserDecision {
  suggestionId: string;
  decision: 'accepted' | 'rejected' | 'modified';
  decidedAt: string;
  modifiedValue?: unknown;
}

/** 系统硬约束（「系统强制了什么」；来自 DimensionLock / 合同，优化器无权推翻）。 */
export interface SkillConstraint {
  dimension: string;
  mode: 'locked' | 'forced' | 'preserved';
  source?: string;
  value?: string;
  reason: string;
}

/** 技能造成的确定性变更（状态 / 合同字段层面）。 */
export interface SkillAppliedChange {
  target: string;
  description: string;
}

/** Prompt 块来源（「最终写进 Prompt 什么」；finalText 只在详情层展示）。 */
export interface SkillPromptContribution {
  block:
    | 'image_roles'
    | 'person_contract'
    | 'clothing_contract'
    | 'locked_template'
    | 'expression_contract'
    | 'media_contract'
    | 'anime_character_contract'
    | 'detail_insert_contract'
    | 'region_contract'
    | 'dimension_contract'
    | 'negative_constraints'
    | 'final_description';
  summary: string;
  finalText?: string;
}

export interface SkillExecutionRecord {
  executionId: string;
  skillId: string;
  skillName: string;
  skillVersion: string;
  category: RuntimeSkillCategory;
  status: 'applied' | 'skipped' | 'overridden' | 'failed';
  triggeredBy: 'auto' | 'user' | 'system';
  findings: SkillFinding[];
  suggestions: SkillSuggestion[];
  userDecisions: SkillUserDecision[];
  hardConstraints: SkillConstraint[];
  appliedChanges: SkillAppliedChange[];
  promptContributions: SkillPromptContribution[];
  skippedReason?: string;
  startedAt: string;
  completedAt?: string;
}

/** 编译产物分段（Prompt 来源反查：每段 ← 哪些技能）。 */
export interface SkillCompiledSection {
  block: SkillPromptContribution['block'];
  skillIds: string[];
  text: string;
}

/** 技能执行快照（优化 / 生成时冻结；项目演进不影响历史）。 */
export interface SkillExecutionSnapshot {
  schemaVersion: 1;
  projectId: string;
  projectRevision: number;
  /** 冻结时对齐的 recreation.optimizedRevision（未优化 = 缺省）。 */
  optimizationRevision?: number;
  skills: SkillExecutionRecord[];
  /** 生成链路冻结的编译分段（含 skill 归属；Prompt 来源反查用）。 */
  compiledSections?: SkillCompiledSection[];
  createdAt: string;
}

/**
 * 提示词优化结构化快照 —— 任务创建时冻结，历史记录只读这里，
 * 禁止用 originalPrompt !== finalPrompt 之类的字符串比较推断。
 * applied 一旦为 true 不因用户后续手动微调提示词而重置。
 */
export interface PromptOptimizationSnapshot {
  applied: boolean;
  /** 优化服务显示名（例如 智谱）。 */
  provider_name?: string;
  /** 优化模型显示名（例如 GLM-5.2）。 */
  model_name?: string;
  /** 用户第一次点击优化时的原始需求（跨多次重优化保留）。 */
  original_prompt?: string;
  /** 本次采用优化的时间（ISO）。 */
  optimized_at?: string;
  /** 采用后用户又手动编辑过最终提示词。 */
  manually_edited_after?: boolean;
  /** 优化来源标记：vision_recreation = 视觉理解复刻链路（已优化，禁止重复优化）。 */
  source?: string;
}

export interface TaskBatchItem {
  id: string;
  label: string;
  prompt_delta: string;
  prompt_override?: string;
  /** 该子任务独立的负面提示词（需求任务模型）；为空回落任务级 negative_prompt。 */
  negative_override?: string;
  negative_delta?: string;
  source_images?: string[];
  enabled?: boolean;
  /** 方案元数据快照（新版批量方案任务创建时冻结，历史详情只读；旧任务缺失走 fallback）。 */
  plan_title?: string;
  plan_summary?: string;
  plan_tags?: string[];
  plan_description?: string;
}

export interface Task {
  id: string;
  prompt: string;
  negative_prompt: string;
  user_prompt_raw?: string;
  final_prompt?: string;
  final_negative_prompt?: string;
  prompt_optimized?: boolean;
  /** 结构化优化快照；旧任务可能缺失（由 UI 兼容映射）。 */
  prompt_optimization?: PromptOptimizationSnapshot | null;
  agent_intent?: string;
  task_source?: 'manual' | 'agent' | 'cy-video-studio' | 'vision_recreation';
  size: string;
  quality: string;
  output_format: string;
  count: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  created_at: string;
  /** 正式开始执行时间（首次进入 running）。 */
  started_at?: string | null;
  /** 所有子任务进入最终状态的时间。 */
  completed_at?: string | null;
  output_dir: string;
  success_count: number;
  failed_count: number;
  sub_tasks: SubTask[];
  task_type: 'generate' | 'edit' | 'remove_background' | 'vision_understanding' | '';
  source_images: string[];
  mask_image?: string;
  execution_mode?: TaskExecutionMode;
  batch_strategy?: TaskBatchStrategy;
  task_plan_summary?: string;
  batch_items?: TaskBatchItem[];
  /** 来源任务 id（视觉理解 → 图片生成 的链路关联）。 */
  source_task_id?: string;
  /** 来源任务类型快照（如 vision_understanding），任务列表免查源即可显示来源。 */
  source_task_kind?: string;

  /** 来源应用（cy-video-studio = CY Video Studio 反向 Bridge 任务） */
  source_app?: string;
  /** 来源请求号（幂等键，仅服务端使用） */
  source_request_id?: string;
  /** 来源上下文（视频复刻项目 / 轨道 / 用途） */
  source_context?: {
    feature?: string;
    projectName?: string;
    trackType?: string;
    trackId?: string;
    purpose?: string;
  };  /** 执行中的阶段性中文提示（前端驱动的视觉理解任务用）。 */
  stage_note?: string;
  /** 动作白膜批元数据（cy-video-studio Pose Batch；普通任务 / 旧数据缺失）。 */
  pose_batch?: PoseBatchMeta;
  /** 生成溯源快照（视觉复刻等链路创建时冻结；旧任务缺失）。 */
  provenance?: GenerationProvenanceSnapshot | null;
}

/** 动作白膜批槽位语义（与 sub_tasks / batch_items 按 sub_index 对齐）。 */
export interface PoseSlotMeta {
  slot_id: string;
  /** front_3q | front | side | back */
  view: string;
  /** none | start | middle | end */
  keyframe: string;
  pose_description?: string;
  key_pose_points?: string[];
  sub_index: number;
}

/** 动作白膜批共享上下文（Pose Batch Contract V1，一个批 = 一个 Task）。 */
export interface PoseBatchMeta {
  batch_id: string;
  contract_version: number;
  /** Prompt Preset 版本快照（ACTION_MANNEQUIN_V1）。 */
  preset_version: string;
  action_id: string;
  action_name: string;
  normalized_pose?: string;
  /** prompt_only | master_reference */
  consistency_strategy: string;
  aspect_ratio: string;
  master_image_id?: string | null;
  master_slot_index?: number | null;
  slots: PoseSlotMeta[];
}

export interface ImageRecord {
  id: string;
  task_id: string;
  local_path: string;
  file_name: string;
  created_at: string;
  status: string;
  source_kind?: 'library_input' | 'output' | 'chat' | 'postprocess';
  missing?: boolean;
  last_seen_at?: string | null;
  width?: number | null;
  height?: number | null;
  file_size?: number | null;
  description?: string | null;
  tags?: string[];
  indexed_at?: string | null;
}

export interface ImageFolder {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface ImageMeta {
  width: number;
  height: number;
  file_size: number;
}

/** 图片库拖拽导入（V4.1）：成功复制进管理目录的文件 */
export interface LibraryImportedItem {
  file_name: string;
  local_path: string;
}

/** 图片库拖拽导入：跳过（已在管理目录 / 同内容已存在）或失败（含原因） */
export interface LibraryImportIssue {
  path: string;
  reason: string;
}

/** import_images_to_library 返回结构；images = 触发重扫时的全量图库记录 */
export interface ImportImagesToLibraryResult {
  imported: LibraryImportedItem[];
  skipped: LibraryImportIssue[];
  failed: LibraryImportIssue[];
  images: ImageRecord[];
}

/** 图库图片同步到 CY Video Studio（CY_VIDEO_BRIDGE_V1）的结果 */
export interface VideoSyncResult {
  assetId: string;
  message: string;
  alreadySynced: boolean;
}

export interface CreateTaskParams {
  prompt: string;
  negative_prompt: string;
  user_prompt_raw?: string;
  final_prompt?: string;
  final_negative_prompt?: string;
  prompt_optimized?: boolean;
  prompt_optimization?: PromptOptimizationSnapshot | null;
  agent_intent?: string;
  task_source?: 'manual' | 'agent' | 'cy-video-studio' | 'vision_recreation';
  size: string;
  quality: string;
  output_format: string;
  count: number;
  output_dir: string;
  task_type: 'generate' | 'edit' | 'remove_background' | 'vision_understanding' | '';
  source_images: string[];
  mask_image?: string;
  execution_mode?: TaskExecutionMode;
  batch_strategy?: TaskBatchStrategy;
  task_plan_summary?: string;
  batch_items?: TaskBatchItem[];
  /** 单张复合构图的结构化表达（三分镜 / 宫格 / 分屏），与 batch 互斥。 */
  composite_layout?: TaskCompositeLayout;
  /** 复合构图的每格主体（例如 ["泰山","黄山","华山"]）。 */
  subject_entities?: string[];
  /** 来源任务 id（视觉理解 → 图片生成 链路；写入后任务列表显示来源关系）。 */
  source_task_id?: string;
  /** 来源任务类型快照（vision_understanding）。 */
  source_task_kind?: string;
  /** 生成溯源快照（视觉复刻链路冻结；Rust 侧 JSON 透传）。 */
  provenance?: GenerationProvenanceSnapshot | null;
}

/** 单张复合构图布局（一张图内部的分格结构）。 */
export interface TaskCompositeLayout {
  type: 'triptych' | 'grid' | 'split_screen';
  panelCount: number;
}

export type PageType = 'agent' | 'imagestudio' | 'skillworkshop' | 'vision' | 'queue' | 'gallery' | 'history' | 'settings' | 'about' | 'account';

// ===== V4.0.6 批量任务重做 =====

export interface BatchRedoGlobalOverrides {
  size?: string | null;
  quality?: string | null;
  output_format?: string | null;
  output_dir?: string | null;
  prompt_prefix?: string | null;
  prompt_suffix?: string | null;
}

export interface BatchRedoItemOverride {
  index: number;
  label?: string | null;
  prompt?: string | null;
  /** 空串 = 显式清空该项负面词 */
  negative_prompt?: string | null;
}

export interface CreateBatchRedoRequest {
  source_task_id: string;
  selected_indexes: number[];
  global_overrides: BatchRedoGlobalOverrides;
  item_overrides: BatchRedoItemOverride[];
}

export interface ChatAttachment {
  id: string;
  type: 'image' | 'file';
  source: 'upload' | 'gallery' | 'paste';
  name: string;
  dataUrl?: string;
  filePath?: string;
  content?: string;
  size?: number;
}

export interface GallerySearchCriteria {
  timeRange: string;
  subjects: string[];
  styles: string[];
  orientation: string;
  usage: string;
  extra: string;
}

export interface GallerySearchProgress {
  percent: number;
  label: string;
}

export interface GallerySearchResult {
  image: ImageRecord;
  thumbUrl: string;
  score: number;
  reason: string;
  fullImageUrl?: string;
  selectionState?: 'idle' | 'selecting' | 'selected' | 'preview_error';
}

export interface GallerySearchState {
  status: 'clarify' | 'searching' | 'done' | 'empty' | 'failed';
  query: string;
  criteria: GallerySearchCriteria;
  progress?: GallerySearchProgress;
  results: GallerySearchResult[];
  shown: number;
  semanticLimited: boolean;
  notice?: string;
}

export interface AgentProposal {
  id: string;
  intent: 'image_generate' | 'image_edit' | 'remove_background' | 'upscale';
  confidence: number;
  needs_clarification: boolean;
  clarification_question?: string;
  recommended_action: string;
  final_prompt: string;
  final_negative_prompt: string;
  user_prompt_raw: string;
  source_images: string[];
  status: 'draft' | 'submitting' | 'confirmed' | 'cancelled';
  api_kind: 'generation' | 'edit' | 'remove_background' | 'upscale';
  matched_task_template_id?: string;
  matched_task_template_name?: string;
  matched_style_template_ids?: string[];
  matched_style_template_names?: string[];
  execution_mode?: TaskExecutionMode;
  batch_strategy?: TaskBatchStrategy;
  task_plan_summary?: string;
  batch_items?: TaskBatchItem[];
  composite_layout?: TaskCompositeLayout;
  subject_entities?: string[];
  used_local_fallback?: boolean;
  linked_task_id?: string;
  /** 生成该提案时 Planner 所用的 AI 智能体 / 模型快照 */
  planner_provider_profile_id?: string;
  planner_provider_name_snapshot?: string;
  planner_model_id?: string;
  planner_model_display_name_snapshot?: string;
}

export type AgentTaskKind =
  | 'gallery_search'
  | 'image_understanding'
  | 'image_generate'
  | 'image_edit'
  | 'remove_background'
  | 'upscale';

export type AgentTaskStage =
  | 'collecting'
  | 'clarifying'
  | 'variant_planning'
  | 'ready_for_proposal'
  | 'proposed'
  | 'confirmed'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentTaskDraft {
  id: string;
  conversation_id: string;
  task_kind: AgentTaskKind;
  stage: AgentTaskStage;
  execution_mode: TaskExecutionMode;
  batch_strategy?: TaskBatchStrategy;
  task_plan_summary?: string;
  user_prompt_raw: string;
  latest_user_message: string;
  source_images: string[];
  reference_images: string[];
  subject?: string;
  scene?: string;
  style?: string;
  selling_point?: string;
  background_target?: string;
  edit_target?: string;
  keep_constraints: string[];
  change_constraints: string[];
  negative_constraints: string[];
  unresolved_fields: string[];
  clarification_questions: string[];
  matched_task_template_id?: string;
  matched_task_template_name?: string;
  matched_style_template_ids: string[];
  matched_style_template_names?: string[];
  final_prompt: string;
  final_negative_prompt: string;
  recommended_action: string;
  api_kind?: 'generation' | 'edit' | 'remove_background' | 'upscale';
  composite_layout?: TaskCompositeLayout;
  subject_entities?: string[];
  variant_plan?: {
    target_count: number;
    variation_axis?: string;
    items: TaskBatchItem[];
  };
  confidence: number;
  used_local_fallback: boolean;
  linked_task_id?: string;
  planner_provider_profile_id?: string;
  planner_provider_name_snapshot?: string;
  planner_model_id?: string;
  planner_model_display_name_snapshot?: string;
  created_at: string;
  updated_at: string;
}

export type ChatMode = 'chat' | 'task';

export type TaskStage =
  | 'planning'
  | 'planning_failed'
  | 'needs_clarification'
  | 'waiting_confirm'
  | 'queued'
  | 'analyzing'
  | 'running'
  | 'saving'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/**
 * Planner 明确返回 needs_clarification 时挂载的补充信息上下文。
 *
 * 关键约束（spec）：
 *   - stage='needs_clarification' 和 stage='waiting_confirm' 必须互斥。
 *   - needs_clarification 是合法的中间业务态，不是 Planner failure，
 *     也不是可执行态。UI 必须禁止"确认执行"，只能"补充信息 / 修改任务 / 取消"。
 *   - 用户下一条消息（在澄清场景里）会被路由为对同一任务的补充回答，
 *     而不是创建一条全新的任务卡。
 */
export interface TaskClarificationContext {
  /** Planner 给出的补充问题，例如"请指定《死神》中的具体角色"。 */
  question: string;
  /** 触发本次澄清的原始用户需求（Planner 当时看到的文本）。 */
  originalRequest?: string;
  /** Planner / 上层标记的可能缺失字段（仅用于诊断 / UI）。 */
  missingFields?: string[];
  /**
   * 第几轮澄清。第一次澄清 = 1；用户补充后再调用 Planner 又得到澄清 = 2。
   * 用于 maxClarificationRounds 保护，避免 Planner 反复追问同一字段。
   */
  attempt?: number;
}

/**
 * 终态集合：一旦真实 Task 进入这些状态，必须立即覆盖 TaskMessage 的执行阶段，
 * 终态永远优先于 running / queued / saving 等中间态。
 */
export const TERMINAL_TASK_STATUSES: ReadonlySet<Task['status']> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/**
 * 终态对应的 TaskMessage.stage。
 * interrupted 没有真实 Task 侧状态，由前端在 Task 不存在时推断，因此单独处理。
 */
export const TERMINAL_MESSAGE_STAGES: ReadonlySet<TaskStage> = new Set([
  'success',
  'failed',
  'cancelled',
  'interrupted',
]);

/**
 * 规划失败阶段标签 —— 与后端 error_kind 一一对应。
 * 用于 TaskMessageState.plannerDiagnostic.errorKind 以及 UI 失败卡显示。
 */
export type PlannerErrorKind =
  | 'transport'
  | 'connect'
  | 'timeout'
  | 'auth'
  | 'rate_limit'
  | 'server'
  | 'invalid_request'
  | 'model_error'
  | 'model_incompatible'
  | 'response_text_missing'
  | 'response_incomplete'
  | 'upstream_error'
  | 'planner_output_truncated'
  | 'planner_json_parse_failed'
  | 'planner_schema_invalid'
  | 'provider_response_payload_missing';

/**
 * Responses API body 的结构化诊断摘要。
 * 由 Rust 端 build_responses_diagnostic 透传，无论成功 / 失败都会回填。
 * 用于 "查看规划详情" 展示 HTTP Status / Responses Status / Output Types /
 * Content Types / Extracted Text Length 等关键 shape 信息。
 */
export interface ResponsesShapeDiagnostic {
  httpStatus?: number | null;
  responseStatus?: string;
  topLevelKeys?: string[];
  outputCount?: number;
  outputTypes?: string[];
  contentTypes?: string[];
  hasTopLevelOutputText?: boolean;
  hasChoices?: boolean;
  hasError?: boolean;
  extractedTextLength?: number;
  incompleteReason?: string;
  /**
   * 上游 body.error.message / last_error.message 的真实文本。
   * 关键字段：HTTP 200 + body.error 时，这才是 gpt-5.6-luna 真正的失败原因。
   * 由 Rust build_responses_diagnostic 提取。
   */
  upstreamErrorMessage?: string;
  /** 上游 body.error.type，例如 invalid_request_error / rate_limit_error / server_error。 */
  upstreamErrorType?: string;
  /** 上游 body.error.code，例如 unsupported_parameter / model_not_found / server_error。 */
  upstreamErrorCode?: string;
  /** 上游 body.error.param，unsupported_parameter 时通常带具体参数名（text.format / reasoning.effort ...）。 */
  upstreamErrorParam?: string;
  /** Responses 顶层 `id` 字段（resp_xxx）。Payload Recovery Retrieve 阶段需要它。 */
  responseId?: string;
  /** Responses body.usage.output_tokens。**null/undefined** 表示上游没填该字段；
   * 注意这与 `0`（明确告知本轮没产生 output token）语义不同。
   * `provider_response_payload_missing` 判定要求 output_tokens > 0。 */
  outputTokens?: number | null;
  /** chat_completions 通道：choices[0].finish_reason。`length` = 输出被 max_tokens 截断。 */
  finishReason?: string | null;
  /** usage.prompt_tokens（chat）/ usage.input_tokens（Responses）。 */
  inputTokens?: number | null;
  /** usage.reasoning_tokens —— 推理 token 与最终 JSON 共享输出预算的模型上，
   * 这是 JSON 被截断的主要根因指标。 */
  reasoningTokens?: number | null;
  /** Planner 针对性自动重试轨迹（截断 / 空文本，最多一次）。 */
  autoRetry?: { trigger?: string; result?: string };
}

/**
 * Responses Payload Recovery 执行轨迹。
 *
 * 当 Primary 命中 `provider_response_payload_missing`（HTTP 2xx + completed
 * + output_tokens>0 + extract 返回 None）时启动两阶段恢复：
 *   1. Retrieve：GET /v1/responses/{id}（不消耗模型 token）
 *   2. SSE Streaming：POST /v1/responses + stream=true
 *
 * 前端"查看规划详情"据此展示 Primary / Retrieve / Streaming 各自结果。
 */
export interface ResponsesRecoveryTrace {
  attempted: boolean;
  /** Retrieve 阶段结果：recovered / empty / unsupported / failed / skipped。 */
  retrieveResult?: 'recovered' | 'empty' | 'unsupported' | 'failed' | 'skipped' | string;
  retrieveHttpStatus?: number | null;
  /** SSE Streaming 阶段结果。 */
  streamResult?: 'recovered' | 'empty' | 'unsupported' | 'failed' | 'skipped' | string;
  streamHttpStatus?: number | null;
  streamEventCount?: number;
  streamTextDeltaCount?: number;
  /** 最终恢复文本来源：retrieve / StreamingDelta / StreamingOutputTextDone / StreamingCompletedResponse。 */
  textSource?: string;
  /** Primary 响应 usage.output_tokens 的回显。 */
  providerOutputTokens?: number | null;
  /** Primary 响应的 response_id 回显。 */
  providerResponseId?: string;
}

export interface PlannerDiagnostic {
  /** 规划使用的模型，例如 gpt-5.6-luna */
  model?: string;
  /** 调用通道：responses / chat_completions。前端目前不可知，仅作展示用，可缺省。 */
  transport?: 'responses' | 'chat_completions';
  /** 后端 error_kind（response_text_missing / planner_json_parse_failed / ...） */
  errorKind?: PlannerErrorKind | string;
  /** 失败阶段的人类可读中文标签，例如 "规划结果解析" */
  errorStage?: string;
  /** 失败原因的简短中文文案，UI 主卡展示用 */
  reason?: string;
  /** HTTP 状态码（如果失败发生在 HTTP 层） */
  httpStatus?: number | null;
  /** Planner 真正返回的原始文本（已截断、已脱敏）。仅在解析失败时填入。 */
  rawOutput?: string;
  /** 后端 JSON parser 抛出的错误描述（例如 "expected value at line ..."） */
  parserError?: string;
  /** Responses body 结构化诊断 —— UI 展开时显示具体 shape 信息。 */
  responsesShape?: ResponsesShapeDiagnostic;
  /**
   * 上游真实错误文本（body.error.message）。当 errorKind=upstream_error 时必须显示，
   * 让用户看到 "gpt-5.6-luna 不支持 text.format" 这种具体原因，而不是 "上游返回错误"。
   * 从 responsesShape.upstreamErrorMessage 镜像过来，方便 UI 直接读 diagnostic 根字段。
   */
  upstreamErrorMessage?: string;
  upstreamErrorType?: string;
  upstreamErrorCode?: string;
  upstreamErrorParam?: string;
  /** Responses Payload Recovery 轨迹。仅在 Primary 命中 payload_missing 时填入。 */
  recovery?: ResponsesRecoveryTrace;
}

export interface TaskMessageImage {
  id: string;
  url: string;
  thumbnailUrl?: string;
  localPath?: string;
  width?: number | null;
  height?: number | null;
  file_name?: string;
  imageId?: string;
}

export interface TaskMessageState {
  taskId: string;
  status: Task['status'];
  stage: TaskStage;
  title: string;
  prompt?: string;
  finalPrompt?: string;
  finalNegativePrompt?: string;
  /** @deprecated use agentModel + executionModel */
  model?: string;
  agentModel?: string;
  executionModel?: string;
  /** 规划该任务时使用的 AI 智能体快照（多智能体体系） */
  plannerProviderProfileId?: string;
  plannerProviderNameSnapshot?: string;
  size?: string;
  count?: number;
  error?: string;
  images?: TaskMessageImage[];
  resultImageIds?: string[];
  createdAt: string;
  updatedAt: string;
  taskType?: 'generate' | 'edit' | 'remove_background' | '';
  apiKind?: 'generation' | 'edit' | 'remove_background' | 'upscale';
  sourceImageCount?: number;
  sourceImageId?: string;
  /** 本地路径形式的源图（编辑任务的 active image path）。重新规划时用它来还原编辑上下文。 */
  sourceImagePath?: string;
  /**
   * 源图绑定方式（任务创建时快照）：
   *   - 'attachment'：本轮用户上传附件（第一张为编辑目标）
   *   - 'explicit'  ：用户手动绑定 / 手动切换的图片
   *   - 'latest'    ：默认规则 —— 当前对话最新一张图片
   *   - 'none'      ：文生图，未引用图片
   * 一旦写入不再随会话 active image 变化（Task Source Image Snapshot ≠ Conversation Active Image）。
   */
  sourceImageSelection?: 'latest' | 'explicit' | 'attachment' | 'none';
  sourceImagePreviewUrl?: string;
  sourceImageFileName?: string;
  pendingParams?: CreateTaskParams;
  confirming?: boolean;
  cancelling?: boolean;
  /**
   * 重新规划专用：指向当前任务卡对应的用户原始消息 id。
   * 重新规划时复用此 id 对应的消息，绝不再次 append 一条用户消息。
   */
  sourceUserMessageId?: string;
  /** 重新规划次数（仅用于日志/诊断），UI 始终只有一张任务卡。 */
  planningAttempt?: number;
  /**
   * 每次发起 Planner 调用时生成的唯一 requestId。
   * 异步返回后只有 requestId 仍然等于当前卡片上的值才允许写入，
   * 用来防止快速连点"重新规划"导致旧响应覆盖新请求。
   */
  planningRequestId?: string;
  /**
   * 应用级 PlannerJob Registry 的 job id（PJ_xxx）。
   * 页面切换 / 会话切换时，loadConversations 会读这个字段去 Registry 查 job 是否还活着，
   * 不再无脑把 stage=planning 降级成 planning_failed。
   * 只有 planningSessionId 与当前 app session 不一致（说明进程重启过）才判中断。
   */
  plannerJobId?: string;
  /**
   * 发起本次规划时所属的 App Session ID（sess_xxx）。
   * App 进程重启后会换一个新的 session id；用它区分"页面切换"和"应用重启"。
   */
  planningSessionId?: string;
  /**
   * 规划失败诊断信息。仅在 stage='planning_failed' 时有意义；
   * 成功进入 waiting_confirm / 执行阶段时应被清空，避免旧错误残留。
   */
  plannerDiagnostic?: PlannerDiagnostic;
  /**
   * 执行阶段失败诊断信息（来自真实 Task.error / sub_tasks 错误聚合）。
   * 仅在 stage='failed' / 'interrupted' 时有意义。
   */
  executionDiagnostic?: {
    httpStatus?: number | null;
    errorKind?: string;
    summary?: string;
    requestId?: string;
    subTaskErrors?: string[];
  };

  // ====== 任务语义层（多轮上下文继承 + 附件识别）======
  /**
   * 本地推断的细粒度任务类型。
   * 用于 UI 展示（"图片编辑 / 参考图生成 / 文生图 / 图片分析"），
   * 避免把"用户已上传图片"的任务错误显示成"文生图"。
   * 与 taskType 字段互补：taskType 由 Planner 决定，resolvedTaskKind 来自本地健康度检查。
   */
  resolvedTaskKind?: 'text_to_image' | 'image_edit' | 'image_reference_generation' | 'image_analysis' | 'unknown';
  /**
   * 用户当轮上传的附件文件名（或本地路径）。
   * 持久化后用于在历史记录 / 任务详情中显示"用户当时传了哪些图"。
   *
   * 注意：此字段只是"真实文件名"的快照，用于调试 / 持久化。
   * UI 展示与 Planner 引用必须改用 attachmentDescriptors 中的 label（图一 / 图二 / 图三）。
   */
  attachmentNames?: string[];
  /**
   * 任务提交时冻结的"有序附件"快照 —— 按用户选择顺序排列。
   * 一旦写入即不可变；后续 Composer 增删图不能影响历史任务的展示。
   * UI 在任务卡 / 历史详情中渲染"图一 / 图二"时必须读这个字段。
   */
  orderedAttachments?: Array<{
    id: string;
    source: string;
    internalName?: string;
    preview?: string;
  }>;
  /**
   * Planner 端的附件描述符快照（label + id + source）。
   * 任务提交时根据 orderedAttachments 生成。
   * 用于 Planner Prompt 中的 "[图片附件语义映射]" 段落，让模型真正理解 "图一 / 图二"。
   */
  attachmentDescriptors?: Array<{
    id: string;
    label: string;
    originalName?: string;
    source: string;
  }>;
  /**
   * 附件角色拆分：编辑目标图数量（待修改的原图）。
   * 当只有 1 张图 + 编辑意图 → editTargetImageCount=1。
   * 当有多张图 → 默认第一张为 edit target，其余为 reference。
   */
  editTargetImageCount?: number;
  /** 附件角色拆分：参考图数量。 */
  referenceImageCount?: number;
  /**
   * 任务级上下文继承摘要（仅用于 UI 展示和调试日志）。
   * 让历史记录 / 任务详情能告诉用户"本任务继承了上一轮的 XXX"。
   */
  resolvedContext?: {
    workTitle?: string;
    primarySubject?: string;
    inheritedFromPreviousTurn?: boolean;
    augmentationDetected?: boolean;
    pronounBindings?: Record<string, string>;
  };

  // ====== Clarification（Planner 明确要求补充信息）======
  /**
   * 仅在 stage='needs_clarification' 时填充。
   * 业务态语义：当前任务尚未达到可执行条件，必须等用户补充信息后重新规划。
   * UI 必须基于本字段隐藏"确认执行"，显示"补充信息 / 修改任务 / 取消"。
   */
  clarification?: TaskClarificationContext;
  /**
   * 当前会话中此任务链路累计发生的澄清轮数（持久化）。
   * 每次用户补充后又得到 clarification 时 +1；用于 maxClarificationRounds 保护。
   * 注意：与 clarification.attempt 含义一致，前者跨 stage 持续存在，
   * 后者仅在 needs_clarification 阶段有意义。
   */
  clarificationRound?: number;

  // ====== Chat Handoff 语义上下文（实体列表 / 布局）======
  /**
   * 九宫格等布局信息（Chat Handoff 解析出 "9宫格 / 3x3" 时写入）。
   * cells 是 Planner 选定的每格主体（非持久化必需，可选）。
   */
  gridLayout?: {
    rows: number;
    columns: number;
    cellCount: number;
    cells?: Array<{ index: number; label: string }>;
  };
  /**
   * 单张复合构图的结构化表达（三分镜 / 宫格 / 分屏）。
   * 与批量结构互斥：compositeLayout 存在时 execution_mode 必须是 single、count 必须是 1。
   */
  compositeLayout?: TaskCompositeLayout;
  /** 复合构图的每格主体（"前3个山"解析出的 [泰山, 黄山, 华山]）。 */
  subjectEntities?: string[];
  /** 上下文来源的人类可读标签，例如 "上一轮建筑列表"。仅 UI / 导出展示用。 */
  contextSourceLabel?: string;

  // ====== 执行耗时（区别于 Planning 耗时）======
  /**
   * 用户点击"确认执行"、任务真正进入执行阶段的时间点（ISO）。
   * Planning / 等待确认的耗时绝不计入。
   */
  executionStartedAt?: string;
  /** 执行终态（成功 / 失败 / 取消 / 中断）时间点（ISO）。 */
  executionFinishedAt?: string;
  /** 最终执行耗时（ms）。持久化字段 —— UI / 历史记录都从这里读取。 */
  executionDurationMs?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
  attachments?: ChatAttachment[];
  reasoning?: string;
  reasoning_duration?: string;
  generated_image?: string;
  created_at: string;
  input_tokens?: number;
  output_tokens?: number;
  is_image?: boolean;
  gallery_search?: GallerySearchState;
  agent_proposal?: AgentProposal;
  task_message?: TaskMessageState;
  chat_mode?: ChatMode;
  /** 该消息生成时实际使用的 AI 智能体 / 模型快照（Profile 删除后历史仍可读） */
  provider_profile_id?: string;
  provider_name_snapshot?: string;
  model_id?: string;
  model_display_name_snapshot?: string;
}

export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  created_at: string;
  last_prompt_tokens?: number;
  last_completion_tokens?: number;
  context_summary?: string;
  context_summary_updated_at?: string;
  conversation_mode?: 'free_chat' | 'task_flow';
  active_task_draft?: AgentTaskDraft | null;
  active_task_id?: string | null;
  active_image_id?: string | null;
  active_image_path?: string | null;
  /**
   * active image 的绑定来源：'explicit' = 用户点「编辑此图」显式绑定；
   * 'auto' = 任务成功后自动推进到最新结果图。任务卡展示"引用方式"用。
   */
  active_image_source?: 'explicit' | 'auto';
  /**
   * active image 的设定时间（取任务 completed_at）。防回退守卫用：
   * 旧任务的 retry / reconcile 事件不允许把 active image 拉回旧图
   * （图生图源图漂移的根因修复）。
   */
  active_image_set_at?: string;
  /**
   * 任务图片绑定四态（V4.0.8）：区分「尚未初始化」与「用户明确解绑」。
   * uninitialized = 从未做过任务图片决策（允许一次自动绑定）；
   * auto = 系统自动绑定（恢复 / 任务成功推进）；
   * manual = 用户主动提供图片（选择 / 拖入 / 图库 / 显式绑定）；
   * none = 用户明确解绑全部任务图片，持久化拒绝任何自动补图。
   * 缺省（旧数据）时由 resolveStoredTaskImageBinding 按 active_image_* 归一。
   */
  active_image_binding?: 'uninitialized' | 'auto' | 'manual' | 'none';
  chat_mode?: ChatMode;
  /** 会话级 AI 智能体选择（profile_id + model_id，双 key 区分同 model_id 的不同 Provider） */
  selected_agent_profile_id?: string;
  selected_agent_model_id?: string;
}

export interface AgentTemplateClarificationRules {
  enabled: boolean;
  required_fields: string[];
  fallback_question: string;
}

export interface AgentTemplateOutputSchema {
  final_prompt: boolean;
  final_negative_prompt: boolean;
  recommended_action: boolean;
  clarification_question: boolean;
}

export interface AgentTaskTemplate {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  category: 'generate' | 'edit' | 'remove_background' | 'upscale' | 'gallery';
  scene:
    | 'general'
    | 'ecommerce_main'
    | 'amazon_a_plus'
    | 'brand_scene'
    | 'poster'
    | 'social_ad'
    | 'img2img_merge'
    | 'background_replace';
  intent: 'image_generate' | 'image_edit' | 'remove_background' | 'upscale' | 'gallery_search';
  match_mode: 'keyword' | 'llm_only' | 'hybrid';
  trigger_keywords: string[];
  exclude_keywords: string[];
  requires_source_images: boolean;
  min_source_images: number;
  max_source_images: number | null;
  requires_confirmation: boolean;
  allow_auto_execute: boolean;
  clarification_rules: AgentTemplateClarificationRules;
  system_prompt: string;
  prompt_template: string;
  negative_prompt_template: string;
  recommended_action_template: string;
  output_schema: AgentTemplateOutputSchema;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface AgentStyleTemplate {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  style_group: 'visual_style' | 'lighting' | 'camera' | 'mood' | 'platform';
  trigger_keywords: string[];
  exclude_keywords: string[];
  style_prompt_fragment: string;
  negative_prompt_fragment: string;
  compatible_intents: Array<'image_generate' | 'image_edit' | 'remove_background' | 'upscale' | 'gallery_search'>;
  compatible_scenes: string[];
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface AgentTemplateLog {
  id: string;
  conversation_id: string;
  message_id: string;
  task_id: string;
  matched_task_template_id: string;
  matched_style_template_ids: string[];
  user_prompt_raw: string;
  final_prompt: string;
  final_negative_prompt: string;
  recommended_action: string;
  intent: string;
  api_kind: string;
  confidence: number;
  created_at: string;
}

export interface AgentTemplateExportPayload {
  version: number;
  task_templates: AgentTaskTemplate[];
  style_templates: AgentStyleTemplate[];
}

export interface AgentTemplateDraftCurrentTemplate {
  id: string;
  name: string;
  category: string;
  scene: string;
  intent: string;
  trigger_keywords: string[];
  requires_source_images: boolean;
  requires_confirmation: boolean;
  system_prompt: string;
  prompt_template: string;
  negative_prompt_template: string;
  recommended_action_template: string;
}

export interface AgentTemplateDraftRequirements {
  target_use_cases: string[];
  must_keep: string[];
  should_improve: string[];
}

export interface AgentTemplateDraftExpectedOutput {
  system_prompt: string;
  prompt_template: string;
  negative_prompt_template: string;
  recommended_action_template: string;
  extra_trigger_keywords: string[];
}

export interface AgentTemplateDraftPayload {
  template_type: 'task' | 'style';
  draft_mode: 'agent_editable';
  goal: string;
  current_template: AgentTemplateDraftCurrentTemplate;
  requirements: AgentTemplateDraftRequirements;
  expected_output: AgentTemplateDraftExpectedOutput;
}

export interface AgentTemplateImportPayload {
  version: number;
  task_templates: AgentTaskTemplate[];
  style_templates: AgentStyleTemplate[];
}

export interface AgentEndpointStatus {
  ok: boolean;
  kind?: 'connect' | 'timeout' | 'auth' | 'rate_limit' | 'server' | 'invalid_response' | 'not_configured' | 'upstream_api' | 'invalid_request' | 'model_error' | 'multimodal_unsupported' | 'json_output_unsupported';
  message: string;
  status?: number | null;
}

export interface AgentEndpointCheckResult {
  chat: AgentEndpointStatus;
  chat_with_system: AgentEndpointStatus;
  chat_multimodal: AgentEndpointStatus;
  official_vision: AgentEndpointStatus;
  interpret: AgentEndpointStatus;
  generation: AgentEndpointStatus;
  edit: AgentEndpointStatus;
}

export interface EnvCheckItem {
  key: string;
  title: string;
  status: 'ok' | 'warn' | 'error' | 'pending';
  summary: string;
  detail: string;
  latency_ms?: number | null;
}

export interface EnvCheckResult {
  items: EnvCheckItem[];
  diagnostic_text: string;
}

export interface GenerateTestImageResult {
  ok: boolean;
  endpoint: string;
  http_status?: number | null;
  latency_ms: number;
  saved_path?: string | null;
  output_format: string;
  error_kind?: string | null;
  error_message?: string | null;
}

export interface VisionUnderstandPayload {
  prompt: string;
  images: string[];
  model: string;
}

export interface VisionUnderstandResult {
  ok: boolean;
  summary?: string;
  raw_text?: string;
  error_kind?: 'connect' | 'timeout' | 'auth' | 'rate_limit' | 'server' | 'invalid_response' | 'invalid_request' | 'model_error' | 'vision_error';
  error_message?: string;
  status?: number | null;
}

// ===== V4.0.6 视觉理解（结构化分析 / 双图评审 / 本地色彩）=====

export interface NormalizedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisionSubject {
  label: string;
  count?: number | null;
  appearance: string[];
  pose?: string | null;
  action?: string | null;
  /** 手势（与姿态分离捕获；动作锁定链路的独立锁定维度）。 */
  gesture?: string | null;
  /** 面部表情（具体到睁闭眼状态，如 wink；动作锁定时独立锁定）。 */
  facial_expression?: string | null;
  /** 视线方向。 */
  gaze?: string | null;
  position?: NormalizedRegion | null;
  orientation?: string | null;
  clothing: string[];
  relations: string[];
}

export interface VisionObject {
  label: string;
  count?: number | null;
  position?: NormalizedRegion | null;
  attributes: string[];
}

export interface SceneAnalysis {
  environment: string;
  location: string;
  time_of_day: string;
  weather: string;
  background: string;
  foreground: string;
}

export interface CompositionAnalysis {
  subject_placement: string;
  symmetry: string;
  rule_of_thirds?: boolean | null;
  horizon?: string | null;
  negative_space: string;
  crop: string;
  depth_layers: string;
}

export interface CameraAnalysis {
  shot_type: string;
  focal_length_estimate?: string | null;
  perspective: string;
  angle: string;
  depth_of_field: string;
  lens_characteristics: string;
}

export interface LightingAnalysis {
  source: string;
  direction: string;
  softness: string;
  key_fill_rim: string;
  contrast: string;
  time_of_day: string;
  exposure: string;
}

export interface ColorAnalysis {
  dominant_palette: string[];
  temperature: string;
  saturation: string;
  contrast: string;
}

export interface StyleAnalysis {
  category: string;
  medium: string;
  texture: string;
  rendering: string;
  photographic_characteristics: string;
}

export interface TextElement {
  content: string;
  position?: NormalizedRegion | null;
  style: string;
}

export interface VisionAnalysis {
  summary: string;
  subjects: VisionSubject[];
  objects: VisionObject[];
  scene: SceneAnalysis;
  composition: CompositionAnalysis;
  camera: CameraAnalysis;
  lighting: LightingAnalysis;
  colors: ColorAnalysis;
  style: StyleAnalysis;
  /** V4.1 媒介结构（可选；旧模型 / 单一媒介缺省，前端按 style 兜底推断，绝不强行判混合）。 */
  media_structure?: {
    overall_mode?: string;
    preserve_template_media_structure?: boolean;
    regions?: Array<{
      label?: string;
      semantic_role?: string;
      rendering_mode?: string;
      identity_relation?: string;
      description?: string;
      /** V5 实例分离：detail_insert 层的实例清单（一个画框 = 一个 instance）。 */
      instances?: Array<{
        label?: string;
        crop_type?: string;
        media_type?: string;
        position?: { x?: number; y?: number; width?: number; height?: number };
        target_subject_role?: string;
        description?: string;
      }>;
    }>;
  };
  text_elements: TextElement[];
  fine_details: string[];
  generation_risks: string[];
}

export interface VisionComparison {
  subject: number;
  composition: number;
  style: number;
  lighting: number;
  color: number;
  objects?: number | null;
  text?: number | null;
  missing_elements: string[];
  extra_elements: string[];
  layout_differences: string[];
  style_differences: string[];
  lighting_differences: string[];
  color_differences: string[];
  prompt_corrections: string[];
}

export interface VisionAnalyzeResult {
  ok: boolean;
  analysis?: VisionAnalysis | null;
  error_kind?: string | null;
  error_message?: string | null;
  status?: number | null;
}

export interface VisionCompareResult {
  ok: boolean;
  comparison?: VisionComparison | null;
  error_kind?: string | null;
  error_message?: string | null;
  status?: number | null;
}

export interface ColorProfile {
  dominant_colors: string[];
  brightness: number;
  saturation: number;
  contrast: number;
  hue_histogram: number[];
}

export interface ColorSimilarityResult {
  ok: boolean;
  score: number;
  source?: ColorProfile | null;
  candidate?: ColorProfile | null;
  error_message?: string | null;
}

export interface AgentRunRequestResult {
  ok: boolean;
  intent?: string;
  confidence?: number;
  needs_clarification?: boolean;
  clarification_question?: string;
  recommended_action?: string;
  should_propose_execution?: boolean;
  final_prompt?: string;
  final_negative_prompt?: string;
  api_kind?: 'generation' | 'edit' | 'remove_background' | 'upscale';
  reply?: string;
  reasoning?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  error_kind?: 'connect' | 'timeout' | 'auth' | 'rate_limit' | 'server' | 'invalid_response' | 'upstream_api' | 'invalid_request' | 'model_error' | 'multimodal_unsupported' | 'json_output_unsupported' | 'response_text_missing' | 'response_incomplete' | 'upstream_error' | 'planner_json_parse_failed' | 'planner_schema_invalid' | 'provider_response_payload_missing';
  error_message?: string;
  status?: number | null;
  used_local_fallback?: boolean;
  /**
   * Planner 专用诊断：原始返回文本（已截断脱敏）。
   * 仅在 plan_task 模式且发生 response_text_missing / planner_json_parse_failed /
   * planner_schema_invalid 时返回。
   */
  planner_raw_output?: string;
  /** Planner 专用诊断：后端 JSON parser 的报错描述。 */
  planner_parser_error?: string;
  /** Planner 专用诊断：使用的是 responses / chat_completions 通道。 */
  planner_transport?: 'responses' | 'chat_completions';
  /** Planner 专用诊断：Responses body 结构化 shape 摘要。 */
  planner_diagnostic?: ResponsesShapeDiagnostic;
  /** Planner 专用诊断：Responses Payload Recovery 轨迹（snake_case，对应 Rust 字段）。 */
  planner_recovery?: ResponsesRecoveryTrace;
}

export const SIZES = ['1024x1024', '1792x1024', '1024x1792'] as const;
export const QUALITIES = ['auto', 'high', 'medium', 'low'] as const;

export const QUALITY_LABELS: Record<string, string> = {
  auto: '自动（默认）',
  high: '高质量',
  medium: '中等质量',
  low: '低质量',
};

export const FORMATS = ['png', 'jpeg', 'webp'] as const;

export const TASK_TEMPLATE_CATEGORIES = ['generate', 'edit', 'remove_background', 'upscale', 'gallery'] as const;
export const TASK_TEMPLATE_SCENES = [
  'general',
  'ecommerce_main',
  'amazon_a_plus',
  'brand_scene',
  'poster',
  'social_ad',
  'img2img_merge',
  'background_replace',
] as const;
export const TASK_TEMPLATE_INTENTS = ['image_generate', 'image_edit', 'remove_background', 'upscale', 'gallery_search'] as const;
export const TASK_TEMPLATE_MATCH_MODES = ['keyword', 'llm_only', 'hybrid'] as const;
export const STYLE_TEMPLATE_GROUPS = ['visual_style', 'lighting', 'camera', 'mood', 'platform'] as const;
