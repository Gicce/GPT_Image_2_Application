/**
 * CyImagePro Agent Skill System - Skill Router
 *
 * 纯本地计算，无网络请求，无 AI 调用
 * 使用关键词评分 + 当前上下文判断
 */

import type { SkillRouteInput, SkillRouteResult, SkillId } from './types';
import { SKILL_REGISTRY } from './registry';

// 低于此分数使用 general_chat 作为兜底
const MIN_CONFIDENCE_THRESHOLD = 15;

// ============================================
// Helper Functions
// ============================================

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function parseRequestedCount(text: string): number {
  const match = text.match(/(\d+)\s*(张|份|个|套|版|版本)/);
  return match ? Math.max(1, Number(match[1])) : 1;
}

// ============================================
// Main Router Function
// ============================================

export function detectSkill(input: SkillRouteInput): SkillRouteResult {
  const normalizedText = normalizeText(input.text);
  const hasImages = !!input.hasImageAttachments;
  const hasEditable = !!input.hasEditableImage;
  const requestedCount = parseRequestedCount(input.text);

  if (!normalizedText) {
    return {
      skillId: 'general_chat',
      confidence: 0.5,
      matchedKeywords: [],
      isFallback: true,
      reason: '输入为空，使用默认对话模式',
    };
  }

  const candidates: Array<{
    skill: typeof SKILL_REGISTRY[number];
    score: number;
    matched: string[];
  }> = [];

  for (const skill of SKILL_REGISTRY) {
    // 检查前置条件
    if (skill.requiresEditableImage && !hasEditable) continue;
    if (skill.requiresImage && !hasImages) continue;

    // 关键词评分
    let score = 0;
    const matched: string[] = [];

    for (const kw of skill.keywords) {
      const normalizedKw = normalizeText(kw);
      if (normalizedKw && normalizedText.includes(normalizedKw)) {
        score += 10;
        matched.push(kw);
      }
    }

    // 排除词扣分
    for (const ex of skill.excludeKeywords ?? []) {
      const normalizedEx = normalizeText(ex);
      if (normalizedEx && normalizedText.includes(normalizedEx)) {
        score -= 50;
      }
    }

    // 特殊规则增强
    // 批量任务
    if (skill.id === 'batch_task') {
      if (requestedCount > 1) score += 20;
      if (/批量|这些|全部|每张|多张|多组/.test(normalizedText)) score += 20;
    }

    // 去背景（高优先）
    if (skill.id === 'background_remove') {
      if (/去背景|抠图|透明底|remove\s*bg|removebackground/i.test(normalizedText)) {
        score += 30;
      }
    }

    // 视觉理解（高优先）
    if (skill.id === 'vision_analyze') {
      if (/看看这张图|分析图片|这张图是什么|识别图片|图片里有什么/i.test(normalizedText)) {
        score += 25;
      }
    }

    // 提示词优化
    if (skill.id === 'prompt_optimize') {
      if (/优化提示词|优化prompt|改写提示词|翻译提示词|帮我写提示词/i.test(normalizedText)) {
        score += 25;
      }
    }

    // 商品主图
    if (skill.id === 'product_main_image') {
      if (/主图|商品主图|产品主图|电商主图|淘宝主图|白底图/i.test(normalizedText)) {
        score += 15;
      }
    }

    // 有图片时，图生图优先级提升
    if (skill.id === 'image_to_image' && hasEditable) {
      if (/换背景|改背景|改成|换成|修改这张|编辑这张|参考这张/i.test(normalizedText)) {
        score += 20;
      }
    }

    if (score > 0) {
      candidates.push({
        skill,
        score: score + skill.priority,
        matched,
      });
    }
  }

  // 无有效匹配或最高分低于阈值，使用 general_chat
  if (candidates.length === 0) {
    return {
      skillId: 'general_chat',
      confidence: 0.5,
      matchedKeywords: [],
      isFallback: true,
      reason: '未匹配到特定 Skill，使用默认对话模式',
    };
  }

  // 按分数排序，取最高
  const sorted = candidates.sort((a, b) => b.score - a.score);
  const best = sorted[0];

  // 检查是否低于置信度阈值
  if (best.score < MIN_CONFIDENCE_THRESHOLD) {
    return {
      skillId: 'general_chat',
      confidence: 0.5,
      matchedKeywords: best.matched,
      isFallback: true,
      reason: `匹配分数 ${best.score} 过低，使用默认对话模式`,
    };
  }

  // 构建结果
  const result: SkillRouteResult = {
    skillId: best.skill.id,
    confidence: Math.min(1, best.score / 100),
    matchedKeywords: best.matched,
    isFallback: false,
  };

  // 冲突处理：批量 + 商品主图
  if (best.skill.id === 'batch_task' && /主图|电商|产品图|商品图/.test(normalizedText)) {
    result.targetSkillId = 'product_main_image';
    result.reason = '批量任务包含商品主图意图';
  }

  // 冲突处理：图生图 + 商品主图（有商品词且有图片）
  if (best.skill.id === 'image_to_image' && /主图|电商|产品图|商品图/.test(normalizedText)) {
    // 如果明确是"生成商品主图"而不是"编辑"，可能应该用 product_main_image
    if (/生成|做一张|设计/.test(normalizedText) && !/换背景|改成|修改/.test(normalizedText)) {
      result.targetSkillId = 'product_main_image';
      result.reason = '有商品主图意图且有图片，建议使用商品主图 Skill';
    }
  }

  return result;
}

// ============================================
// Export for external use
// ============================================

export { SKILL_REGISTRY };