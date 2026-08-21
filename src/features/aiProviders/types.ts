export type AIProviderType =
  | 'deepseek_official'
  | 'glm_official'
  | 'openai_official'
  | 'gemini_official'
  | 'qwen_official'
  | 'openai_compatible';

/**
 * V4.0.6 模型服务类别（档案级）：
 * - agent: AI 对话 / 任务规划 / 提示词优化（文本模型）
 * - vision: 视觉理解 / 反向 Prompt / 高复刻评审（图片输入模型）
 * 三类模型能力互不混用：视觉模型不进 agent 解析链路，Agent 模型不当视觉模型用。
 * 旧档案无此字段 → 读取侧按 'agent' 处理（向后兼容）。
 */
export type ProviderCategory = 'agent' | 'vision';

/**
 * AI 功能使用范围。Provider 与模型两层各自声明，功能入口按两层交集判定：
 * - chat:            AI 对话
 * - planner:         任务规划（图片任务 Planner）
 * - prompt_optimizer: 提示词优化
 * 视觉理解不是开关 —— 由模型能力（supports_vision）决定。
 */
export type ModelUseScope = 'chat' | 'planner' | 'prompt_optimizer';

export interface UseScopes {
  chat: boolean;
  planner: boolean;
  prompt_optimizer: boolean;
}

export const ALL_USE_SCOPES: ModelUseScope[] = ['chat', 'planner', 'prompt_optimizer'];

export const USE_SCOPE_LABELS: Record<ModelUseScope, string> = {
  chat: 'AI 对话',
  planner: '任务规划',
  prompt_optimizer: '提示词优化',
};

/** 默认全量使用范围（新数据 / 旧数据缺省补齐） */
export function defaultUseScopes(): UseScopes {
  return { chat: true, planner: true, prompt_optimizer: true };
}

/** @deprecated V3.0.6 起 Provider 不再是角色智能体，此字段仅作旧数据读取兼容：
 *  旧 'conversation' 配置在 migration 中映射为 planner scope 关闭，之后不再参与任何判定。 */
export type LegacyAgentType = 'conversation' | 'creative';

/**
 * 模型来源：
 * - provider_discovery: Provider /models 接口动态发现
 * - official_registry:  内置 / 远程官方 Registry
 * - custom:             用户手工新增（仅第三方 Provider）
 * - legacy:             旧版本数据迁移而来，Registry 中不存在
 * - built_in:           旧版本持久化数据中的来源标记（读取时升级为 official_registry）
 */
export type AIModelSource =
  | 'provider_discovery'
  | 'official_registry'
  | 'custom'
  | 'legacy'
  | 'built_in';

export type ModelCapability =
  | 'text'
  | 'reasoning'
  | 'vision'
  /** 视频输入理解（图片视觉 = vision；两者独立声明，仅官方文档确认支持的模型标记） */
  | 'video_vision'
  | 'image_generation'
  | 'image_edit'
  | 'video_generation'
  | 'audio'
  | 'tools'
  | 'structured_output'
  | 'unknown';

export type ModelLifecycle =
  | 'unknown'
  | 'active'
  | 'deprecated'
  | 'retired'
  /** 远程 Discovery 已不再返回该模型（不删除，仅提示） */
  | 'missing';

export type AIModelTestStatus =
  | 'untested'
  | 'testing'
  | 'available'
  | 'failed';

export interface AIProviderModel {
  id: string;
  model_id: string;
  display_name: string;
  model_source: AIModelSource;
  enabled: boolean;
  /** 由 capabilities 派生并同步（兼容旧数据 / 旧消费方） */
  supports_vision: boolean;
  capabilities: ModelCapability[];
  lifecycle: ModelLifecycle;
  test_status: AIModelTestStatus;
  /** 模型级使用范围（缺省 = 继承全开）。与 Provider 级 use_scopes 取交集。 */
  use_scopes?: UseScopes;
  discovered_at?: string;
  last_seen_at?: string;
  last_tested_at?: string;
  last_latency_ms?: number;
  last_error_code?: string;
  last_error_message?: string;
  /** 最近一次快速检测的 HTTP 状态 / Provider 原始信息（诊断展示用） */
  last_error_status?: number;
  /** 最近一次检测级别：quick=目录/鉴权校验（无生成请求），deep=真实最小调用 */
  last_check_level?: 'quick' | 'deep';
}

export type ProviderValidationState =
  | 'unknown'
  | 'validating'
  | 'valid'
  | 'invalid';

export interface AIProviderProfile {
  id: string;
  name: string;
  provider_type: AIProviderType;
  /** 服务类别（缺省 = 'agent'，旧数据兼容）。决定档案归属 AI 智能体还是视觉模型设置页。 */
  category?: ProviderCategory;
  /** @deprecated V3.0.6 起不再参与任何运行时判定（仅旧数据读取兼容）。 */
  agent_type?: LegacyAgentType;
  base_url: string;
  api_key: string;
  enabled: boolean;
  default_model_id: string;
  vision_model_id: string;
  /** 任务规划默认模型（缺省回落 default_model_id） */
  planner_model_id?: string;
  /** 提示词优化默认模型（缺省回落 default_model_id） */
  prompt_optimizer_model_id?: string;
  /** Provider 级使用范围（缺省 = 全开）。与模型级 use_scopes 取交集后生效。 */
  use_scopes?: UseScopes;
  /** @deprecated Provider 不再绑定角色 System Prompt；仅旧数据读取兼容。 */
  system_prompt: string;
  context_window: number;
  fallback_token: string;
  /** @deprecated Provider 不再绑定 Agent 头像。 */
  avatar_data_url: string;
  models: AIProviderModel[];
  created_at: string;
  updated_at: string;
  /** API Key 最近一次显式保存时间 */
  api_key_saved_at?: string;
  validation_state?: ProviderValidationState;
  last_validated_at?: string;
  /** 最近一次模型目录同步（Discovery + Registry Merge）时间 */
  last_model_sync_at?: string;
  /**
   * 当前激活的连接使用方式。仅对 registry 声明了多个 billing_modes 的官方
   * Provider 有意义；单模式 Provider 与第三方为 undefined（不参与任何判定）。
   * 旧数据（无此字段）在 hydrate 时按默认模式（第一个 billing_mode，即 api）补齐。
   */
  billing_mode?: BillingMode;
  /**
   * 按 billing_mode 隔离的连接状态（Key / 验证状态 / 模型目录 / 默认模型）。
   * 顶层同名字段始终等于 mode_states[billing_mode] 的镜像 —— persist() 统一回写。
   */
  mode_states?: Partial<Record<BillingMode, ProviderModeState>>;
}

export interface AIModelSelection {
  profileId: string;
  modelId: string;
}

/**
 * Provider 连接的计费 / 使用方式。同一 Provider 身份（如 glm_official）可提供
 * 多种接入方式，每种方式独立 Base URL + 独立 Credential + 独立模型目录。
 * 未来新 Provider（如 DeepSeek 套餐）在 registry 定义自己的 billing_modes 即可，
 * 禁止把计费模式编码进 Provider ID（禁止 glm_coding_plan 之类的分裂类型）。
 */
export type BillingMode = 'api' | 'coding_plan';

/** registry 中 billing_mode 的元信息定义 */
export interface BillingModeDefinition {
  mode: BillingMode;
  label: string;
  /** 一行说明（设置页「使用方式」下方小字） */
  description: string;
  base_url: string;
  /** 该模式固定官方地址的补充提示（合规 / Key 来源说明） */
  notes?: string[];
}

/**
 * Profile 内按 billing_mode 隔离的连接状态。
 * 顶层 profile.api_key / base_url / models 等始终是「当前激活模式」的镜像，
 * 供既有消费方（Chat / promptBuilder / adapters）无改动复用；
 * 切换模式时从此结构恢复，实现 API / Coding Plan Key 互不覆盖。
 */
export interface ProviderModeState {
  api_key: string;
  api_key_saved_at?: string;
  validation_state?: ProviderValidationState;
  last_validated_at?: string;
  models: AIProviderModel[];
  last_model_sync_at?: string;
  default_model_id: string;
  vision_model_id: string;
}

export const BILLING_MODE_LABELS: Record<BillingMode, string> = {
  api: 'API 按量计费',
  coding_plan: 'Coding Plan 套餐',
};

export const PROVIDER_TYPE_LABELS: Record<AIProviderType, string> = {
  deepseek_official: 'DeepSeek 官方',
  glm_official: '智谱 GLM 官方',
  openai_official: 'OpenAI 官方',
  gemini_official: 'Google Gemini 官方',
  qwen_official: '阿里云百炼 / Qwen 官方',
  openai_compatible: '第三方 API（OpenAI Compatible）',
};

/** 读取档案类别（旧数据无字段 → agent）。全项目判定统一走这里，禁止散落 ?? 判断。 */
export function profileCategory(profile: Pick<AIProviderProfile, 'category'>): ProviderCategory {
  return profile.category ?? 'agent';
}

export const PROVIDER_PROTOCOL = 'openai-compatible' as const;

export const CAPABILITY_LABELS: Record<ModelCapability, string> = {
  text: '聊天',
  reasoning: '推理',
  vision: '视觉理解',
  video_vision: '视频理解',
  image_generation: '图片生成',
  image_edit: '图片编辑',
  video_generation: '视频生成',
  audio: '音频',
  tools: 'Tools',
  structured_output: '结构化输出',
  unknown: '能力未知',
};

export const LIFECYCLE_LABELS: Record<ModelLifecycle, string> = {
  unknown: '',
  active: '',
  deprecated: '即将弃用',
  retired: '已下线',
  missing: '已停止发现',
};
