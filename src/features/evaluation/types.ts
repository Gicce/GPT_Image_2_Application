/**
 * 统一图片评价系统（ImageEvaluation V1）—— 类型定义。
 *
 * 核心约定：
 *  - 评价绑定图片资产（ImageRecord.id），不是仅任务：一个任务多张图，每张独立评分；
 *  - AI 评分 0~100 整数；null = 未评价 / 维度不适用（0 是合法低分，禁止用 0 冒充未评价）；
 *  - AI 评分与用户反馈（user_rating / user_issue_tags / user_comment）严格分离；
 *  - evaluation_version 标记评分口径（Prompt / 权重变化后旧分新分不混读）。
 */

export type EvaluationTaskKind = 'vision_recreation' | 'i2i' | 't2i';

export type UserRating = 'liked' | 'disliked';

/** Rust evaluation.rs ImageEvaluation 镜像（snake_case 直出）。 */
export interface ImageEvaluation {
  asset_id: string;
  asset_path: string;
  task_id: string;
  task_kind: EvaluationTaskKind | string;
  evaluation_version: string;
  overall_score: number | null;
  instruction_adherence: number | null;
  subject_consistency: number | null;
  reference_preservation: number | null;
  style_consistency: number | null;
  composition_quality: number | null;
  technical_quality: number | null;
  strengths: string[];
  issues: string[];
  suggestion: string;
  preserve: string[];
  change: string[];
  edit_instruction: string;
  evaluated_by: string;
  evaluated_at: string;
  user_rating: UserRating | null;
  user_issue_tags: string[];
  user_comment: string;
  user_feedback_at: string;
  /** 用户收藏 / 精选标记（♡；与满意 👍 分离，重新评价保留）。缺省 = 未收藏。 */
  favorite?: boolean;
  created_at: string;
  updated_at: string;
}

/** 生成后自动评价请求（evaluate_image 命令参数；评价上下文由前端组装）。 */
export interface EvaluateImageRequestPayload {
  asset_id: string;
  asset_path: string;
  task_id: string;
  task_kind: EvaluationTaskKind;
  reference_path?: string | null;
  edit_instruction: string;
  understanding_summary?: string;
  preserve: string[];
  change: string[];
  base_url: string;
  token: string;
  model: string;
}

export interface EvaluateImageOutcome {
  ok: boolean;
  evaluation: ImageEvaluation | null;
  error_kind: string | null;
  error_message: string | null;
  status: number | null;
}

/** dislike 问题标签（多选；文案唯一来源）。 */
export const ISSUE_TAG_OPTIONS = [
  '人物不像',
  '动作不对',
  '背景变化太大',
  '风格跑了',
  '构图不对',
  '画质问题',
  '文字错误',
  '其他',
] as const;

export type IssueTag = typeof ISSUE_TAG_OPTIONS[number];
