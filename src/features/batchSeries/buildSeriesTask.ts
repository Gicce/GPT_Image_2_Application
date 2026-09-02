/**
 * V4.2.4 批量同效果生成 —— 模板 + 成员 → CreateTaskParams（纯函数层）。
 *
 * 产物是一个普通批量 Task（复用现有批量引擎：逐项执行 / 失败隔离 / 按槽位重试 /
 * 部分完成结算），外加 series 溯源（execution_snapshot.series）与
 * 每个成员的独立执行快照（items[]）——每个成员「Execute what you save」。
 */

import type { CreateTaskParams, Task } from '../../types';
import { buildBatchExecutionSnapshot } from '../promptExecution/executionSnapshot';
import type { BatchPromptTemplate, SeriesItemDraft } from './seriesTemplate';

export interface SeriesTaskBuildInput {
  template: BatchPromptTemplate;
  items: SeriesItemDraft[];
  presetId: string;
  /** 用户总需求（默认 = 模板描述；弹窗可改） */
  userRequirement: string;
  outputDir: string;
  size: string;
  quality: string;
  outputFormat: string;
}

/** 来源任务实际执行值解析：快照优先，回落 final/prompt（旧任务兼容，绝不虚构）。 */
export function resolveSourceExecutedPrompts(task: Task): {
  positivePrompt: string;
  negativePrompt: string;
  userRequirement: string;
  fromSnapshot: boolean;
} {
  const snapshot = task.execution_snapshot;
  if (snapshot) {
    return {
      positivePrompt: snapshot.positivePrompt || task.final_prompt || task.prompt,
      negativePrompt: snapshot.negativePrompt || task.final_negative_prompt || task.negative_prompt,
      userRequirement: snapshot.userRequirement || task.user_prompt_raw || '',
      fromSnapshot: true,
    };
  }
  return {
    positivePrompt: task.final_prompt || task.prompt,
    negativePrompt: task.final_negative_prompt || task.negative_prompt,
    userRequirement: task.user_prompt_raw || '',
    fromSnapshot: false,
  };
}

export interface SeriesTaskBuildResult {
  params: CreateTaskParams;
  /** 参与执行的成员数（enabled 项） */
  total: number;
}

/** 系列模板 → 统一 CreateTaskParams（batch_items + series 溯源 + 每项快照）。 */
export function buildSeriesTask(input: SeriesTaskBuildInput): SeriesTaskBuildResult {
  const enabledItems = input.items.filter(item => item.enabled);
  if (enabledItems.length === 0) throw new Error('至少启用一个系列成员');

  const slotKey = input.template.variableSlots[0]?.key ?? 'variable';
  // 系列视觉参考：成功结果图优先（勾选时），否则回落原参考图（勾选时）
  const seriesSources: string[] = [];
  if (input.template.useSuccessImageAsReference && input.template.successImagePath) {
    seriesSources.push(input.template.successImagePath);
  }
  if (input.template.lockedConstraints.includes('reference-images')) {
    for (const path of input.template.referenceImages) {
      if (!seriesSources.includes(path)) seriesSources.push(path);
    }
  }

  const batchItems = enabledItems.map(item => ({
    id: item.presetItemId,
    label: `${input.template.presetName ? `${input.template.presetName} · ` : ''}${item.label}`,
    prompt_delta: '',
    prompt_override: item.prompt.trim(),
    negative_override: item.negativePrompt.trim(),
    ...(seriesSources.length > 0 && input.template.sourceTaskType === 'edit' ? { source_images: seriesSources } : {}),
    enabled: true,
    variables: { [slotKey]: item.value },
  }));

  const first = enabledItems[0];
  const promptSource = 'task-derived';
  const executionSnapshot = buildBatchExecutionSnapshot({
    userRequirement: input.userRequirement.trim() || input.template.sharedPositiveTemplate,
    positivePrompt: first.prompt.trim(),
    negativePrompt: first.negativePrompt.trim(),
    promptSource,
    items: enabledItems.map(item => ({
      label: item.label,
      positivePrompt: item.prompt.trim(),
      negativePrompt: item.negativePrompt.trim(),
      variables: { [slotKey]: item.value },
    })),
    referenceImages: seriesSources.map(path => ({ path })),
    generationParams: {
      size: input.size,
      quality: input.quality,
      format: input.outputFormat,
    },
    series: {
      sourceTaskId: input.template.sourceTaskId,
      presetId: input.presetId,
      variableSlots: input.template.variableSlots,
      lockedConstraints: input.template.lockedConstraints,
    },
  });

  const params: CreateTaskParams = {
    prompt: first.prompt.trim(),
    negative_prompt: first.negativePrompt.trim(),
    user_prompt_raw: input.userRequirement.trim() || input.template.sourceUserRequirement,
    final_prompt: first.prompt.trim(),
    final_negative_prompt: first.negativePrompt.trim(),
    prompt_optimized: false,
    prompt_optimization: { applied: false },
    execution_snapshot: executionSnapshot,
    size: input.size,
    quality: input.quality,
    output_format: input.outputFormat,
    count: batchItems.length,
    output_dir: input.outputDir,
    task_type: input.template.sourceTaskType,
    source_images: input.template.sourceTaskType === 'edit' ? seriesSources : [],
    execution_mode: 'batch',
    batch_strategy: 'variant_set',
    batch_items: batchItems,
    task_source: 'batch_series',
    source_task_id: input.template.sourceTaskId,
    source_task_kind: 'image_task',
    task_plan_summary: `系列批量 · ${input.template.presetName ?? ''}（来源任务 ${input.template.sourceTaskId.slice(0, 8)}）`,
  };
  return { params, total: batchItems.length };
}
