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
}

export interface SubTask {
  index: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  image_id?: string;
  error?: string | null;
  label?: string;
}

export type TaskExecutionMode = 'single' | 'batch';
export type TaskBatchStrategy = 'repeat_same' | 'variant_set' | 'multi_input';

export interface TaskBatchItem {
  id: string;
  label: string;
  prompt_delta: string;
  prompt_override?: string;
  negative_delta?: string;
  source_images?: string[];
  enabled?: boolean;
}

export interface Task {
  id: string;
  prompt: string;
  negative_prompt: string;
  user_prompt_raw?: string;
  final_prompt?: string;
  final_negative_prompt?: string;
  prompt_optimized?: boolean;
  agent_intent?: string;
  task_source?: 'manual' | 'agent';
  size: string;
  quality: string;
  output_format: string;
  count: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  created_at: string;
  output_dir: string;
  success_count: number;
  failed_count: number;
  sub_tasks: SubTask[];
  task_type: 'generate' | 'edit' | 'remove_background' | '';
  source_images: string[];
  execution_mode?: TaskExecutionMode;
  batch_strategy?: TaskBatchStrategy;
  task_plan_summary?: string;
  batch_items?: TaskBatchItem[];
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
  description?: string | null;
  tags?: string[];
  indexed_at?: string | null;
}

export interface ImageMeta {
  width: number;
  height: number;
  file_size: number;
}

export interface CreateTaskParams {
  prompt: string;
  negative_prompt: string;
  user_prompt_raw?: string;
  final_prompt?: string;
  final_negative_prompt?: string;
  prompt_optimized?: boolean;
  agent_intent?: string;
  task_source?: 'manual' | 'agent';
  size: string;
  quality: string;
  output_format: string;
  count: number;
  output_dir: string;
  task_type: 'generate' | 'edit' | 'remove_background' | '';
  source_images: string[];
  execution_mode?: TaskExecutionMode;
  batch_strategy?: TaskBatchStrategy;
  task_plan_summary?: string;
  batch_items?: TaskBatchItem[];
}

export type PageType = 'agent' | 'queue' | 'gallery' | 'history' | 'settings' | 'about' | 'account';

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
  used_local_fallback?: boolean;
  linked_task_id?: string;
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
  variant_plan?: {
    target_count: number;
    variation_axis?: string;
    items: TaskBatchItem[];
  };
  confidence: number;
  used_local_fallback: boolean;
  linked_task_id?: string;
  created_at: string;
  updated_at: string;
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
  error_kind?: 'connect' | 'timeout' | 'auth' | 'rate_limit' | 'server' | 'invalid_response' | 'upstream_api' | 'invalid_request' | 'model_error' | 'multimodal_unsupported' | 'json_output_unsupported';
  error_message?: string;
  status?: number | null;
  used_local_fallback?: boolean;
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
