/**
 * 高复刻执行核心（V4.0.6）
 *
 * 每一轮迭代 = 1 次图片生成（正常任务管线 + 正常计费）
 *            + 1 次候选图视觉分析 + 1 次双图评审 + 1 次本地色彩比较。
 * 成本严格可预估；生成必须由用户显式确认启动（「提取提示词」绝不生成图片）。
 */

import { api } from '../../services/api';
import {
  authorizeImageTask,
  createRequestId,
  registerTaskAuthorization,
  settleImageTask,
} from '../../services/billingService';
import { useAuthStore } from '../../store/useAuthStore';
import { useTaskStore } from '../../store/useTaskStore';
import { TERMINAL_TASK_STATUSES } from '../../types';
import type { ColorSimilarityResult, Task, VisionAnalysis } from '../../types';
import type { BuildReportInput, SimilarityReport } from './similarity';
import { buildSimilarityReport } from './similarity';

export type RecreationStage =
  | 'idle'
  | 'generating_candidate'
  | 'analyzing_candidate'
  | 'comparing'
  | 'scoring'
  | 'complete'
  | 'failed';

export interface RecreationIterationInput {
  /** 视觉模型连接（BYOK） */
  vision: {
    baseUrl: string;
    token: string;
    model: string;
  };
  /** 参考原图本地路径 */
  sourcePath: string;
  /** 参考图结构化分析（第一轮编译 Prompt 时已生成，直接复用） */
  sourceAnalysis: VisionAnalysis;
  /** 本轮使用的正向 Prompt */
  prompt: string;
  /** 本轮负面词 */
  negativePrompt: string;
  size: string;
  quality: string;
  outputFormat: string;
  outputDir: string;
  /** 轮次（1 起） */
  attempt: number;
  onStage: (stage: RecreationStage, detail?: string) => void;
  /** 用户取消标记（外部置 true 后各阶段检查退出） */
  isCancelled: () => boolean;
}

export interface RecreationIterationResult {
  ok: boolean;
  error?: string;
  errorKind?: string;
  taskId?: string;
  candidatePath?: string;
  candidateAnalysis?: VisionAnalysis;
  report?: SimilarityReport;
  colorResult?: ColorSimilarityResult | null;
}

const TASK_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const TASK_POLL_INTERVAL_MS = 900;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 轮询等待任务到达终态（store 由全局事件桥自动刷新） */
async function waitTaskTerminal(taskId: string, isCancelled: () => boolean): Promise<Task> {
  const started = Date.now();
  while (Date.now() - started < TASK_WAIT_TIMEOUT_MS) {
    if (isCancelled()) throw new Error('用户已停止高复刻验证');
    const task = useTaskStore.getState().getTask(taskId)
      ?? (await api.getTasks().then(list => list.find(t => t.id === taskId)).catch(() => undefined));
    if (task && TERMINAL_TASK_STATUSES.has(task.status)) return task;
    await sleep(TASK_POLL_INTERVAL_MS);
  }
  throw new Error('生成任务超时未完成（15 分钟），已停止高复刻验证');
}

async function resolveImagePath(imageId: string): Promise<string> {
  const images = await api.getImages();
  const record = images.find(img => img.id === imageId);
  if (!record?.local_path) throw new Error('生成结果图不在图库索引中，无法继续比较');
  return record.local_path;
}

/**
 * 执行单轮：生成候选图 → 分析候选 → 双图评审 + 本地色彩 → 相似度报告。
 * 生成走正常任务管线（authorize → create → register；终态由任务结算器收口）。
 */
export async function runRecreationIteration(input: RecreationIterationInput): Promise<RecreationIterationResult> {
  // ===== 1. 生成候选图（正常计费：authorize 1 张）=====
  input.onStage('generating_candidate', `正在生成第 ${input.attempt} 次复刻`);
  const { isLoggedIn } = useAuthStore.getState();
  let billingRequestId: string | undefined;
  if (isLoggedIn) {
    try {
      billingRequestId = createRequestId('vision-recreate');
      await authorizeImageTask(billingRequestId, 1);
    } catch (err: any) {
      return { ok: false, errorKind: 'billing', error: err?.message || '余额不足，请充值后继续使用' };
    }
  }

  let task: Task;
  try {
    task = await useTaskStore.getState().createAndExecuteTask({
      prompt: input.prompt,
      negative_prompt: input.negativePrompt,
      user_prompt_raw: input.prompt,
      final_prompt: input.prompt,
      final_negative_prompt: input.negativePrompt,
      size: input.size,
      quality: input.quality,
      output_format: input.outputFormat,
      count: 1,
      output_dir: input.outputDir,
      task_type: 'generate',
      source_images: [],
      execution_mode: 'single',
      task_source: 'manual',
    });
    if (billingRequestId) registerTaskAuthorization(task.id, billingRequestId);
  } catch (err: any) {
    if (billingRequestId) void settleImageTask(billingRequestId, false, 0, 'vision recreate create failed');
    return { ok: false, errorKind: 'create_task', error: err?.message || err?.toString() || '创建生成任务失败' };
  }

  // ===== 2. 等待任务终态 =====
  let finished: Task;
  try {
    finished = await waitTaskTerminal(task.id, input.isCancelled);
  } catch (err: any) {
    return { ok: false, errorKind: 'task_timeout', error: err?.message || String(err), taskId: task.id };
  }
  if (finished.status !== 'completed' || finished.sub_tasks[0]?.image_id == null) {
    const subError = finished.sub_tasks[0]?.error || `任务状态 ${finished.status}`;
    return { ok: false, errorKind: 'generation_failed', error: `候选图片生成失败：${subError}`, taskId: task.id };
  }

  // ===== 3. 拿到候选图路径 =====
  let candidatePath: string;
  try {
    candidatePath = await resolveImagePath(finished.sub_tasks[0].image_id!);
  } catch (err: any) {
    return { ok: false, errorKind: 'image_missing', error: err?.message || String(err), taskId: task.id };
  }

  // ===== 4. 分析候选图 =====
  if (input.isCancelled()) return { ok: false, errorKind: 'cancelled', error: '用户已停止高复刻验证' };
  input.onStage('analyzing_candidate', '正在分析候选图');
  const analyzeResult = await api.visionAnalyzeImage({
    imagePath: candidatePath,
    baseUrl: input.vision.baseUrl,
    token: input.vision.token,
    model: input.vision.model,
    mode: 'reverse_prompt',
  });
  if (!analyzeResult.ok || !analyzeResult.analysis) {
    return {
      ok: false,
      errorKind: analyzeResult.error_kind ?? 'invalid_response',
      error: analyzeResult.error_message || '候选图结构化分析失败',
      taskId: task.id,
      candidatePath,
    };
  }

  // ===== 5. 双图评审 + 本地色彩 =====
  if (input.isCancelled()) return { ok: false, errorKind: 'cancelled', error: '用户已停止高复刻验证' };
  input.onStage('comparing', '正在比较参考图与候选图');
  const [compareResult, colorResult] = await Promise.all([
    api.visionCompareImages({
      sourcePath: input.sourcePath,
      candidatePath,
      baseUrl: input.vision.baseUrl,
      token: input.vision.token,
      model: input.vision.model,
    }),
    api.computeColorSimilarity(input.sourcePath, candidatePath).catch(() => null),
  ]);
  if (!compareResult.ok || !compareResult.comparison) {
    return {
      ok: false,
      errorKind: compareResult.error_kind ?? 'invalid_response',
      error: compareResult.error_message || '双图评审失败',
      taskId: task.id,
      candidatePath,
      candidateAnalysis: analyzeResult.analysis,
    };
  }

  // ===== 6. 汇总评分 =====
  input.onStage('scoring', '正在汇总相似度评分');
  const report = buildSimilarityReport({
    comparison: compareResult.comparison,
    colorResult,
    sourceAnalysis: input.sourceAnalysis,
    candidateAnalysis: analyzeResult.analysis,
  } satisfies BuildReportInput);

  input.onStage('complete');
  return {
    ok: true,
    taskId: task.id,
    candidatePath,
    candidateAnalysis: analyzeResult.analysis,
    colorResult,
    report,
  };
}

export interface RecreationConfig {
  targetScore: number;
  maxIterations: number;
  minImprovement: number;
}

export const DEFAULT_RECREATION_CONFIG: RecreationConfig = {
  targetScore: 0.9,
  maxIterations: 2,
  minImprovement: 0.015,
};

export function clampRecreationConfig(config: Partial<RecreationConfig>): RecreationConfig {
  return {
    targetScore: Math.min(Math.max(config.targetScore ?? DEFAULT_RECREATION_CONFIG.targetScore, 0.5), 0.98),
    maxIterations: Math.min(Math.max(Math.round(config.maxIterations ?? DEFAULT_RECREATION_CONFIG.maxIterations), 1), 3),
    minImprovement: Math.min(Math.max(config.minImprovement ?? DEFAULT_RECREATION_CONFIG.minImprovement, 0), 0.2),
  };
}
