/**
 * 统一图片评价 —— 纯函数模型层（无 IO，全量单测锚点）。
 *
 * 职责：
 *  - 任务 → 评价类型（vision_recreation / i2i / t2i）；
 *  - preserve / change 语义组装（复用复刻方案锁定结构，不建第二套约束体系）：
 *    locked = 要求保持，unlocked 或被调整要求覆盖 = 允许修改；
 *  - overall 聚合（与 Rust compute_overall 同一权重表，null 维度退出归一）；
 *  - 图库筛选谓词（评分桶 / 用户反馈）与任务聚合（best / average）；
 *  - 用户反馈 → 下一轮优化指令的组装（反馈闭环唯一入口）。
 *
 * 最高原则（Similarity ≠ Completion）：用户要求修改的维度进入 change，
 * 评价器不得因该维度与原图不同而扣 reference_preservation。
 */

import type { Task } from '../../types';
import type { ImageEvaluation, EvaluationTaskKind, UserRating } from './types';

export const EVALUATION_VERSION = 'image-eval-v1';

/** 评分维度展示名（UI 文案唯一来源；「综合完成度」避免被读成美学质量分）。 */
export const DIMENSION_LABELS = {
  instruction_adherence: '指令完成度',
  subject_consistency: '人物一致性',
  reference_preservation: '参考保持',
  style_consistency: '风格一致性',
  composition_quality: '构图质量',
  technical_quality: '技术质量',
} as const;

export type ScoreDimension = keyof typeof DIMENSION_LABELS;

export const DIMENSION_ORDER: ScoreDimension[] = [
  'instruction_adherence',
  'subject_consistency',
  'reference_preservation',
  'style_consistency',
  'composition_quality',
  'technical_quality',
];

/** 任务 → 评价类型：视觉复刻链路（source_task_kind）→ i2i（有参考图）→ t2i。 */
export function evaluationTaskKind(task: Task): EvaluationTaskKind {
  if (task.source_task_kind === 'vision_understanding') return 'vision_recreation';
  if (task.task_type === 'edit' || (task.source_images?.length ?? 0) > 0) return 'i2i';
  return 't2i';
}

/** overall 权重预设（与 Rust evaluation.rs compute_overall 保持一致）。 */
const OVERALL_WEIGHTS: Record<EvaluationTaskKind, Partial<Record<ScoreDimension, number>>> = {
  vision_recreation: {
    instruction_adherence: 0.25,
    subject_consistency: 0.25,
    reference_preservation: 0.20,
    style_consistency: 0.15,
    composition_quality: 0.10,
    technical_quality: 0.05,
  },
  i2i: {
    instruction_adherence: 0.35,
    subject_consistency: 0.15,
    reference_preservation: 0.20,
    style_consistency: 0.05,
    composition_quality: 0.10,
    technical_quality: 0.15,
  },
  t2i: {
    instruction_adherence: 0.45,
    style_consistency: 0.15,
    composition_quality: 0.20,
    technical_quality: 0.20,
  },
};

/** 前端聚合（展示兜底 / 测试锚点）：持久化 overall 优先，缺失时按权重重算。 */
export function computeOverall(
  evaluation: Pick<ImageEvaluation, 'task_kind'> & Partial<Record<ScoreDimension, number | null>>,
): number | null {
  const weights = OVERALL_WEIGHTS[(evaluation.task_kind as EvaluationTaskKind) ?? 't2i'] ?? OVERALL_WEIGHTS.t2i;
  let weighted = 0;
  let total = 0;
  for (const key of Object.keys(weights) as ScoreDimension[]) {
    const score = evaluation[key];
    if (typeof score === 'number' && Number.isFinite(score)) {
      weighted += score * (weights[key] ?? 0);
      total += weights[key] ?? 0;
    }
  }
  if (total <= 0) return null;
  return Math.round(weighted / total);
}

// ======================= preserve / change 语义 =======================

export interface RecreationSemanticsInput {
  /** 复刻方案锁定结构（RecreationPlanField[]；locked = 保持，unlocked = 允许修改）。 */
  planFields?: { key: string; label: string; locked: boolean }[];
  /** 用户自然语言调整要求（大白话）。 */
  adjustInstruction?: string;
}

export interface PreserveChangeSemantics {
  preserve: string[];
  change: string[];
}

/**
 * 从复刻方案锁定结构推导 preserve / change：
 *  - locked 字段 → preserve（评价器必须按「要求保持」评分）；
 *  - unlocked 字段 → change 允许范围（用户明确写了调整要求时至少有它）；
 *  - 无结构（普通 i2i / t2i）→ preserve = 参考图整体保持语义，change = 用户需求。
 */
export function buildPreserveChange(input: RecreationSemanticsInput): PreserveChangeSemantics {
  const fields = input.planFields ?? [];
  if (fields.length === 0) {
    return {
      preserve: [],
      change: input.adjustInstruction?.trim() ? [input.adjustInstruction.trim()] : [],
    };
  }
  const preserve = fields.filter(f => f.locked).map(f => f.label);
  const change = fields.filter(f => !f.locked).map(f => f.label);
  return {
    preserve,
    change: input.adjustInstruction?.trim() ? [...change, input.adjustInstruction.trim()] : change,
  };
}

// ======================= 图库筛选 / 排序 =======================

export type ScoreBucket = 'all' | 'gte90' | '80_89' | '70_79' | 'lt70' | 'unscored';
export type FeedbackFilter = 'all' | 'liked' | 'disliked' | 'unrated';
export type EvaluationSort = 'newest' | 'oldest' | 'name' | 'score_desc' | 'score_asc';

export function matchesScoreBucket(
  evaluation: ImageEvaluation | null | undefined,
  bucket: ScoreBucket,
): boolean {
  if (bucket === 'all') return true;
  const score = evaluation?.overall_score ?? null;
  if (bucket === 'unscored') return score == null;
  if (score == null) return false;
  switch (bucket) {
    case 'gte90': return score >= 90;
    case '80_89': return score >= 80 && score <= 89;
    case '70_79': return score >= 70 && score <= 79;
    case 'lt70': return score < 70;
    default: return true;
  }
}

export function matchesFeedbackFilter(
  evaluation: ImageEvaluation | null | undefined,
  filter: FeedbackFilter,
): boolean {
  if (filter === 'all') return true;
  const rating = evaluation?.user_rating ?? null;
  switch (filter) {
    case 'liked': return rating === 'liked';
    case 'disliked': return rating === 'disliked';
    case 'unrated': return rating == null;
    default: return true;
  }
}

// ======================= 任务聚合（Phase 13/22） =======================

export interface TaskEvaluationAggregate {
  /** 已评价张数。 */
  count: number;
  bestScore: number | null;
  averageScore: number | null;
}

/** 任务层聚合只从 per-asset 持久化分数计算，绝不给整批任务只存一个总分。 */
export function aggregateTaskEvaluations(evaluations: ImageEvaluation[]): TaskEvaluationAggregate {
  const scores = evaluations
    .map(e => e.overall_score)
    .filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
  if (scores.length === 0) return { count: 0, bestScore: null, averageScore: null };
  const sum = scores.reduce((acc, s) => acc + s, 0);
  return {
    count: scores.length,
    bestScore: Math.max(...scores),
    averageScore: Math.round(sum / scores.length),
  };
}

/** 任务行轻量文案：4 张 · 最高 93 / Best 93 / null。 */
export function taskEvaluationSummary(aggregate: TaskEvaluationAggregate, imageCount: number): string {
  if (aggregate.bestScore == null) return '';
  if (imageCount > 1) return `${imageCount} 张 · 最高 ${aggregate.bestScore}`;
  return `综合 ${aggregate.bestScore}`;
}

// ======================= 反馈 → 下一轮指令（Phase 16 闭环） =======================

const ISSUE_TAG_INSTRUCTIONS: Record<string, string> = {
  '人物不像': '人物身份 / 五官要更接近原图',
  '动作不对': '动作没有按要求完成，请重新执行',
  '背景变化太大': '背景要保持与原图一致，不要漂移',
  '风格跑了': '整体风格要保持与原图一致',
  '构图不对': '构图回到原方案，不要偏移',
  '画质问题': '修复技术质量问题（畸形 / 模糊 / 伪影等）',
  '文字错误': '画面文字要正确清晰',
  '其他': '',
};

/**
 * 用户反馈 + AI 评价 → 下一轮优化指令。
 * 上一轮做得好的部分（strengths）要求保持，问题部分针对性修正；
 * 结果只填充「调整要求」输入框，由用户确认后再优化（不自动触发）。
 */
export function composeFeedbackInstruction(evaluation: ImageEvaluation): string {
  const parts: string[] = [];
  const tags = evaluation.user_issue_tags
    .map(tag => ISSUE_TAG_INSTRUCTIONS[tag])
    .filter(Boolean);
  if (tags.length > 0) parts.push(`修正：${tags.join('；')}`);
  if (evaluation.user_comment.trim()) parts.push(`补充：${evaluation.user_comment.trim()}`);
  if (evaluation.suggestion.trim()) parts.push(`AI 建议：${evaluation.suggestion.trim()}`);
  if (evaluation.strengths.length > 0) {
    parts.push(`保持已经正确的部分：${evaluation.strengths.join('；')}`);
  }
  if (parts.length === 0) return '';
  return `基于上一轮生成结果继续调整。${parts.join('。')}。`;
}

/** 用户反馈是否足以构成下一轮指令（至少一个标签或一句补充说明）。 */
export function feedbackUsableForNextRound(
  rating: UserRating | null,
  issueTags: string[],
  comment: string,
): boolean {
  if (rating === 'liked') return true;
  return issueTags.length > 0 || comment.trim().length > 0;
}
