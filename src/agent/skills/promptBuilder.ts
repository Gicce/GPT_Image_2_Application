/**
 * CyImagePro Agent Skill System - Prompt Builder
 *
 * 根据 Skill 构建最终发送给 Agent API 的系统提示词
 * Prompt 组装顺序：basePrompt + skillPrompt + userCustomPrompt + historySummary + imageContext
 */

import type { SkillId, SkillRouteResult } from './types';
import { getSkillById } from './registry';
import { BASE_AGENT_PROMPT } from './basePrompt';

export interface BuildPromptContext {
  skillId: SkillId;
  routeResult?: SkillRouteResult;
  userText: string;
  visionSummary?: string;
  planOnly?: boolean;
  userCustomPrompt?: string;  // 设置中的 agent_system_prompt，只作补充
  /**
   * 会话压缩产生的历史摘要。以 system 上下文段落注入，
   * 绝不伪装成 assistant 历史消息（避免模型把摘要当成自己的发言）。
   */
  contextSummary?: string;
}

// ============================================
// Main Builder Function
// ============================================

export function buildSkillSystemPrompt(context: BuildPromptContext): string {
  // 1. 基础 Prompt（必须包含）。创作能力（文生图 / 图生图 / 批量 / 任务规划）
  //    属于 CyImagePro 本身 —— 所有模型服务共用同一基础规则，无“对话助手”分支。
  let prompt = BASE_AGENT_PROMPT;

  // 2. Skill 专业规则叠加（主控）
  const skill = getSkillById(context.skillId);
  const skillPrompt = skill?.buildSystemPrompt?.();
  if (skillPrompt?.trim()) {
    prompt += '\n\n--- 当前技能规则 ---\n' + skillPrompt.trim();
  }

  // 3. 用户自定义偏好追加（补充，不覆盖核心规则）
  if (context.userCustomPrompt?.trim()) {
    prompt += '\n\n--- 用户偏好补充 ---\n' + context.userCustomPrompt.trim();
  }

  // 4. 计划模式叠加
  if (context.planOnly) {
    prompt += '\n\n当前为计划模式，只输出任务理解、推荐动作、费用预估和待确认事项，不执行图片任务。';
  }

  // 5. 历史摘要叠加（system 上下文，不是 assistant 发言）
  if (context.contextSummary?.trim()) {
    prompt += '\n\n--- 对话历史摘要（系统为压缩上下文自动生成，仅供你参考，不是你的发言记录） ---\n' + context.contextSummary.trim();
  }

  // 6. 视觉理解结果叠加（图片上下文）
  if (context.visionSummary?.trim()) {
    prompt += '\n\n以下是图片理解模块对当前附件的观察结果，请基于这些结果回答：\n' + context.visionSummary.trim();
  }

  return prompt;
}

// ============================================
// Helper Functions
// ============================================

/**
 * 构建用户消息提示词（可选）
 * 某些 Skill 可能需要对用户输入做预处理
 */
export function buildSkillUserPrompt(skillId: SkillId, userText: string): string {
  const skill = getSkillById(skillId);
  return skill?.buildUserPrompt?.(userText) ?? userText;
}

/**
 * 判断是否为任务类 Skill（需要用户确认后才执行）
 */
export function isTaskOrientedSkill(skillId: SkillId): boolean {
  const taskSkills: SkillId[] = [
    'text_to_image',
    'image_to_image',
    'product_main_image',
    'background_remove',
    'batch_task',
  ];
  return taskSkills.includes(skillId);
}

/**
 * 是否需要用户确认
 */
export function requiresUserConfirmation(skillId: SkillId): boolean {
  // 所有任务类 Skill 都需要用户确认
  return isTaskOrientedSkill(skillId);
}
