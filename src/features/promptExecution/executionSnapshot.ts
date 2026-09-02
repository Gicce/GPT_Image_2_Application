/**
 * Prompt Execution Snapshot —— V4.2.4 统一执行链路（纯函数层）。
 *
 * 铁律：Execute what you save, display what you executed.
 * 点击「开始生成」前，Prompt Draft 在这里冻结成唯一执行真相，同时作为：
 *   1. 任务创建依据（CreateTaskParams.execution_snapshot）
 *   2. Provider Request 的意图依据（实际发送内容由 Rust task_runner 回写
 *      sub_tasks[i].executed_prompt，二者规则镜像、以回写为最终真相）
 *   3. 持久化依据（Rust JSON 透传落库，旧任务 serde default 兼容）
 *   4. History Detail 展示依据（Prompt 来源 / 正向 / 负面 / 实际执行）
 *   5. 「批量同效果生成」来源依据（series template 从来源任务快照构建）
 */

import type {
  BatchItemExecutionSnapshot,
  PromptExecutionSnapshot,
  PromptSnapshotReferenceImage,
  PromptSource,
} from '../../types';

/** 图片生成 Provider（客户端唯一执行通道；与 History IMAGE_EXECUTION_MODEL 同口径）。 */
export const IMAGE_EXECUTION_PROVIDER = 'packyapi';
export const IMAGE_EXECUTION_MODEL_NAME = 'gpt-image-2';

/** 与 Rust task_runner.rs compose_model_instruction 完全一致的镜像：
 * gpt-image-2 无独立 negative_prompt 参数，负面词由适配层拼进执行指令。
 * Provider 若原生支持独立负面参数，则由适配层切换构造方式，本函数仅做预览。 */
export function composeEffectivePrompt(positive: string, negative: string): string {
  const neg = negative.trim();
  if (!neg) return positive.trim();
  return `${positive.trim()}\n\n画面中严格避免出现以下内容：${neg}`;
}

/** Prompt 来源唯一文案表（History / 确认层共用，禁止各页面自写同义词）。 */
export const PROMPT_SOURCE_LABELS: Record<PromptSource, string> = {
  raw: '原始输入',
  'ai-planning': 'AI 智能规划',
  'visual-understanding': '视觉理解优化',
  'manual-edited': '手工修改',
  'vision-recreation': '视觉复刻',
  'task-derived': '任务派生',
  'batch-derived': '批量派生',
  'comic-compiled': '漫画编译',
};

export function promptSourceLabel(source: PromptSource | string | undefined | null): string {
  if (!source) return '原始输入';
  return PROMPT_SOURCE_LABELS[source as PromptSource] || source;
}

export interface SingleExecutionSnapshotInput {
  /** 用户原始需求（表单原文；≠ 最终执行 Prompt）。 */
  userRequirement: string;
  /** 最终正向 Prompt（含 mention 合同等确定性编译后的提交值）。 */
  positivePrompt: string;
  negativePrompt: string;
  promptSource: PromptSource;
  referenceImages?: PromptSnapshotReferenceImage[];
  generationParams?: {
    size?: string;
    quality?: string;
    format?: string;
  };
  createdAt?: string;
}

export function buildSingleExecutionSnapshot(input: SingleExecutionSnapshotInput): PromptExecutionSnapshot {
  return {
    schemaVersion: 1,
    userRequirement: input.userRequirement.trim(),
    positivePrompt: input.positivePrompt.trim(),
    negativePrompt: input.negativePrompt.trim(),
    effectivePrompt: composeEffectivePrompt(input.positivePrompt, input.negativePrompt),
    promptSource: input.promptSource,
    referenceImages: (input.referenceImages ?? []).map(image => ({
      ...(image.id ? { id: image.id } : {}),
      path: image.path,
      ...(image.label ? { label: image.label } : {}),
      ...(image.role ? { role: image.role } : {}),
    })),
    generationParams: input.generationParams ?? {},
    provider: IMAGE_EXECUTION_PROVIDER,
    model: IMAGE_EXECUTION_MODEL_NAME,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export interface BatchExecutionSnapshotInput {
  userRequirement: string;
  /** 任务级正向 / 负面（批量 = 首项提交值，批内真实值以 items 为准）。 */
  positivePrompt: string;
  negativePrompt: string;
  promptSource: PromptSource;
  items: Array<Omit<BatchItemExecutionSnapshot, 'effectivePrompt'>>;
  referenceImages?: PromptSnapshotReferenceImage[];
  generationParams?: {
    size?: string;
    quality?: string;
    format?: string;
  };
  series?: PromptExecutionSnapshot['series'];
  comic?: PromptExecutionSnapshot['comic'];
  createdAt?: string;
}

export function buildBatchExecutionSnapshot(input: BatchExecutionSnapshotInput): PromptExecutionSnapshot {
  return {
    ...buildSingleExecutionSnapshot({
      userRequirement: input.userRequirement,
      positivePrompt: input.positivePrompt,
      negativePrompt: input.negativePrompt,
      promptSource: input.promptSource,
      referenceImages: input.referenceImages,
      generationParams: input.generationParams,
      createdAt: input.createdAt,
    }),
    items: input.items.map(item => ({
      label: item.label,
      positivePrompt: item.positivePrompt.trim(),
      negativePrompt: item.negativePrompt.trim(),
      effectivePrompt: composeEffectivePrompt(item.positivePrompt, item.negativePrompt),
      ...(item.variables && Object.keys(item.variables).length > 0 ? { variables: item.variables } : {}),
    })),
    ...(input.series ? { series: input.series } : {}),
    ...(input.comic ? { comic: input.comic } : {}),
  };
}

/** 采用优化后的来源判定（单张链路唯一入口；手工修改 = 在优化结果上继续编辑）。 */
export function resolveAdoptedPromptSource(kind: 'text' | 'visual', manuallyEdited: boolean): PromptSource {
  if (manuallyEdited) return 'manual-edited';
  return kind === 'visual' ? 'visual-understanding' : 'ai-planning';
}

/** 轻量开发日志（不输出完整 Prompt，绝不输出 Key / Token / 敏感路径）。 */
export function logPromptExecution(snapshot: PromptExecutionSnapshot, referenceImageCount: number): void {
  if (import.meta.env.MODE !== 'development') return;
  console.log('[PromptExecution]', {
    source: snapshot.promptSource,
    referenceImageCount,
    positivePromptLength: snapshot.positivePrompt.length,
    negativePromptLength: snapshot.negativePrompt.length,
    effectivePromptLength: snapshot.effectivePrompt.length,
    provider: snapshot.provider,
    model: snapshot.model,
  });
}
