/**
 * 批量生成方案模型 —— 纯函数层。
 *
 * 产品逻辑：一个总需求 → AI 规划 N 个不同方案 → 1 个方案 = 1 张图片。
 * 方案数量就是最终图片数量，不存在「方案 × 每方案数量」的二次乘法。
 *
 * 与单张生成（原表单 + 单条 AI 优化）完全隔离；
 * GenerationPlan[] 只存在于批量工作区。
 */

import type { CreateTaskParams, PromptOptimizationSnapshot, TaskBatchItem } from '../types';

export type PlanOptimizationStatus = 'idle' | 'loading' | 'success' | 'error';

/** 方案来源：AI 首次规划 / 手动新增 / AI 补充 */
export type PlanSource = 'ai_planned' | 'manual' | 'ai_appended';

export interface GenerationPlan {
  /** 稳定 ID（UUID 风格），删除中间方案后绝不重新生成 */
  id: string;
  /** 抓重点标题，例如「红黑重甲 · 长枪 · 古城墙」；空时 UI 回落「方案 N」 */
  title: string;
  /** AI 专门生成的简洁摘要（40～80 字），绝不来自 positivePrompt 截断 */
  summary: string;
  /** 4～6 个重点标签（语义互补，去重） */
  tags: string[];
  /** 方案完整描述（用户可编辑，重新优化的核心输入） */
  description: string;
  positivePrompt: string;
  negativePrompt: string;
  optimizationStatus: PlanOptimizationStatus;
  optimizationError: string;
  /** 用户手动改过 title/summary/description/prompts 后为 true */
  isManuallyEdited: boolean;
  source: PlanSource;
  /** 优化模型快照（结果展示用） */
  optimizerProviderName: string;
  optimizerModelName: string;
}

/** 批量任务最大方案数（= 最大图片数）。项目无既有配置时采用的安全范围。 */
export const MAX_PLAN_COUNT = 20;
export const DEFAULT_TARGET_COUNT = 3;
export const MAX_PLAN_TAGS = 6;

export function createPlan(partial?: Partial<Pick<GenerationPlan, 'id' | 'title' | 'summary' | 'tags' | 'description' | 'source'>>): GenerationPlan {
  return {
    id: partial?.id || `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title: partial?.title ?? '',
    summary: partial?.summary ?? '',
    tags: partial?.tags ?? [],
    description: partial?.description ?? '',
    positivePrompt: '',
    negativePrompt: '',
    optimizationStatus: 'idle',
    optimizationError: '',
    isManuallyEdited: false,
    source: partial?.source ?? 'manual',
    optimizerProviderName: '',
    optimizerModelName: '',
  };
}

export function clampPlanCount(value: number): number {
  const n = Math.round(Number(value) || DEFAULT_TARGET_COUNT);
  return Math.min(MAX_PLAN_COUNT, Math.max(1, n));
}

/**
 * 方案就绪 = positivePrompt 非空。
 * negativePrompt 允许为空（gpt-image-2 无独立负面参数，由 Rust 适配层拼接）。
 */
export function isPlanReady(plan: GenerationPlan): boolean {
  return plan.positivePrompt.trim().length > 0;
}

export function readyPlanCount(plans: GenerationPlan[]): number {
  return plans.filter(isPlanReady).length;
}

export function pendingPlanCount(plans: GenerationPlan[]): number {
  return plans.length - readyPlanCount(plans);
}

export function planOptimizationSnapshot(plan: GenerationPlan, originalRequirement: string): PromptOptimizationSnapshot {
  return {
    applied: true,
    provider_name: plan.optimizerProviderName || undefined,
    model_name: plan.optimizerModelName || undefined,
    original_prompt: originalRequirement.trim() || undefined,
    optimized_at: new Date().toISOString(),
    manually_edited_after: plan.isManuallyEdited,
  };
}

export interface BatchPlanTaskOptions {
  taskType: 'generate' | 'edit';
  /** 用户总需求原文（进入 user_prompt_raw，任务快照） */
  originalRequirement: string;
  sourceImages: string[];
  size: string;
  quality: string;
  outputFormat: string;
  outputDir: string;
}

export interface BatchPlanTaskResult {
  params: CreateTaskParams;
  /** 最终图片张数 === 方案数 */
  total: number;
}

/**
 * 方案列表 → 统一 CreateTaskParams（1 plan = 1 image generation job）。
 *
 * - 所有方案必须就绪（positivePrompt 非空），存在待完善方案时抛错。
 * - 1 个方案：不携带 batch_items（count = 1，single）。
 * - N 个方案：每方案一个 batch_item（prompt_override / negative_override /
 *   label = 「方案 i · 标题」），variant_set，count 严格等于 N；
 *   Rust resolve_task_count 会再校验 count 与子项数一致。
 */
export function buildBatchPlanTaskParams(
  plans: GenerationPlan[],
  options: BatchPlanTaskOptions,
): BatchPlanTaskResult {
  if (plans.length === 0) throw new Error('至少需要一个生成方案');
  const pending = pendingPlanCount(plans);
  if (pending > 0) throw new Error(`还有 ${pending} 个方案尚未完善`);
  if (options.taskType === 'edit' && options.sourceImages.length === 0) {
    throw new Error('图生图任务必须至少提供一张参考图片');
  }

  const ordered = plans.map(plan => ({
    prompt: plan.positivePrompt.trim(),
    negative: plan.negativePrompt.trim(),
  }));
  const firstPrompt = ordered[0].prompt;
  const firstNegative = ordered[0].negative;
  const adopted = plans.find(plan => plan.optimizerModelName || plan.source !== 'manual') ?? null;
  const snapshot = adopted ? planOptimizationSnapshot(adopted, options.originalRequirement) : null;

  if (plans.length === 1) {
    return {
      total: 1,
      params: {
        prompt: firstPrompt,
        negative_prompt: firstNegative,
        user_prompt_raw: options.originalRequirement.trim(),
        final_prompt: firstPrompt,
        final_negative_prompt: firstNegative,
        prompt_optimized: !!snapshot?.applied,
        prompt_optimization: snapshot ?? { applied: false },
        size: options.size,
        quality: options.quality,
        output_format: options.outputFormat,
        count: 1,
        output_dir: options.outputDir,
        task_type: options.taskType,
        source_images: options.sourceImages,
        execution_mode: 'single',
        task_plan_summary: plans[0].title ? `方案：${plans[0].title}` : undefined,
      },
    };
  }

  const batchItems: TaskBatchItem[] = plans.map((plan, index) => ({
    id: plan.id,
    label: plan.title.trim() ? `方案 ${index + 1} · ${plan.title.trim()}` : `方案 ${index + 1}`,
    prompt_delta: '',
    prompt_override: ordered[index].prompt,
    negative_override: ordered[index].negative,
    ...(options.taskType === 'edit' ? { source_images: options.sourceImages } : {}),
    enabled: true,
    // 方案元数据快照：历史详情直接读正式 AI 产出，绝不回退到 prompt 截断
    plan_title: plan.title.trim(),
    plan_summary: plan.summary.trim(),
    plan_tags: plan.tags,
    plan_description: plan.description.trim(),
  }));

  return {
    total: batchItems.length,
    params: {
      prompt: firstPrompt,
      negative_prompt: firstNegative,
      user_prompt_raw: options.originalRequirement.trim(),
      final_prompt: firstPrompt,
      final_negative_prompt: firstNegative,
      prompt_optimized: !!snapshot?.applied,
      prompt_optimization: snapshot ?? { applied: false },
      size: options.size,
      quality: options.quality,
      output_format: options.outputFormat,
      count: batchItems.length,
      output_dir: options.outputDir,
      task_type: options.taskType,
      source_images: options.sourceImages,
      execution_mode: 'batch',
      batch_strategy: 'variant_set',
      task_plan_summary: `${plans.length} 个方案 / 共 ${plans.length} 张`,
      batch_items: batchItems,
    },
  };
}
