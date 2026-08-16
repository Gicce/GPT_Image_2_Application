/**
 * CyImagePro Agent Skill System - Public API
 *
 * 统一导出所有 Skill 模块
 */

// Types
export type {
  SkillId,
  SkillCategory,
  SkillOutputMode,
  SkillDefinition,
  SkillRouteInput,
  SkillRouteResult,
  SkillExecutionPlan,
  SkillTaskDraft,
  SkillInputRequirement,
} from './types';

// Registry
export { SKILL_REGISTRY, getSkillById, getSkillNameById, getSkillShortNameById } from './registry';

// Router
export { detectSkill } from './router';

// Prompt Builder
export {
  buildSkillSystemPrompt,
  buildSkillUserPrompt,
  isTaskOrientedSkill,
  requiresUserConfirmation,
  type BuildPromptContext,
} from './promptBuilder';

// Base Prompt
export { BASE_AGENT_PROMPT } from './basePrompt';
