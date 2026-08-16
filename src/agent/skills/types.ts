/**
 * CyImagePro Agent Skill System - Type Definitions
 *
 * Skill ID 命名规则：统一使用 snake_case，不带 "_skill" 后缀
 * UI 显示中文名通过 SkillDefinition.name / shortName 处理
 */

export type SkillId =
  | 'general_chat'
  | 'prompt_optimize'
  | 'text_to_image'
  | 'image_to_image'
  | 'product_main_image'
  | 'background_remove'
  | 'batch_task'
  | 'vision_analyze'
  | 'account_help';

export type SkillCategory = 'chat' | 'generate' | 'edit' | 'analyze' | 'utility';

export type SkillOutputMode = 'text' | 'task_draft' | 'structured';

export interface SkillDefinition {
  id: SkillId;
  name: string;
  shortName: string;
  category: SkillCategory;
  description: string;
  keywords: string[];
  excludeKeywords?: string[];
  examples?: string[];
  requiresImage?: boolean;
  requiresEditableImage?: boolean;
  priority: number;
  outputMode: SkillOutputMode;
  buildSystemPrompt(): string;
  buildUserPrompt?(userText: string): string;
}

export interface SkillRouteInput {
  text: string;
  hasImageAttachments?: boolean;
  hasEditableImage?: boolean;
  attachmentCount?: number;
}

export interface SkillRouteResult {
  skillId: SkillId;
  confidence: number;
  matchedKeywords: string[];
  isFallback: boolean;
  reason?: string;
  targetSkillId?: SkillId;
}

export interface SkillExecutionPlan {
  skillId: SkillId;
  suggestedAction: 'reply' | 'ask_clarification' | 'create_task_draft' | 'show_account_info';
  requiresConfirmation: boolean;
  taskDraft?: SkillTaskDraft;
}

export interface SkillTaskDraft {
  prompt: string;
  negativePrompt?: string;
  size?: string;
  count?: number;
  sourceImages?: string[];
  model?: string;
}

export interface SkillInputRequirement {
  requiresUserText: boolean;
  requiresSourceImage: boolean;
  minSourceImages: number;
  maxSourceImages: number;
  suggestedSize?: string;
  suggestedCount?: number;
}