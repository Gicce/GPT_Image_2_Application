/**
 * Detail Insert Repair Runner（V6.2）—— 局部插图补充识别的可复用执行体。
 *
 * V6.1 的识别逻辑内联在视觉页组件里，只有一条静态文字，没有进度 / 计时 /
 * 取消，且状态不按项目隔离（运行期间切换项目会把 A 的识别结果写进 B）。
 * 本模块把「逐层串行提取 → 纯函数合并」抽成与 UI 无关的 runner：
 *
 *  - 进度模型只有真实事实：阶段（准备 / AI 识别 / 合并 / 校验）+ 已完成层数 /
 *    起始时间戳。模型调用没有 token 级进度，因此**不存在百分比字段**——
 *    UI 层用 indeterminate 动画 + 已用时，禁止伪造 70%；
 *  - 合并在 applyResults 回调内完成（调用方负责对**最新** templateSnapshot 合并
 *    并做 projectId 守卫），runner 绝不直接触碰项目 store；
 *  - 取消 = 层与层之间的诚实停止（已完成层照常合并，剩余层不再发起）。
 *
 * 两个消费方共用同一 runner：视觉工作台 Rail（V6.2）与 Skill 直接生成弹窗的
 * 原位 Repair（V6.2 Direct Execution）。
 */

import { api } from '../../../services/api';
import { countInsertInstances, type DetailInsertRepairInput } from './detailInsert';
import type { VisualProject } from './types';

export type DetailRepairStage = 'preparing' | 'recognizing' | 'merging' | 'validating';

export interface DetailRepairProgress {
  operationId: string;
  projectId: string;
  /** 发起时刻的项目修订（UI 按 projectId 隔离展示；跨项目绝不串台）。 */
  projectRevision: number;
  status: 'running' | 'success' | 'error' | 'cancelled';
  stage: DetailRepairStage;
  /** 不完整层总数（真实计数；识别中的「N/M」是层数进度，不是模型百分比）。 */
  totalRegions: number;
  completedRegions: number;
  startedAt: number;
  error?: string;
  summary?: string;
}

export interface DetailRepairVisionConfig {
  baseUrl: string;
  token: string;
  model: string;
}

export interface RunDetailInsertRepairOptions {
  project: VisualProject;
  resolveConfig: () => { ok: true; config: DetailRepairVisionConfig } | { ok: false; error: string };
  onProgress: (progress: DetailRepairProgress) => void;
  /** 每层识别开始前轮询；true = 停止剩余层（已完成层照常合并——诚实取消，不是假取消）。 */
  isCancelled?: () => boolean;
  /**
   * 应用合并结果（调用方职责：对当前最新 templateSnapshot 执行
   * mergeDetailInsertRepairResults、做 projectId 守卫、选择落库方式）。
   * applied=false = 项目已切换或无可合并结果，runner 按 error 处理。
   */
  applyResults: (results: DetailInsertRepairInput[]) => { applied: boolean; summary?: string; error?: string };
}

const STAGE_LABELS: Record<DetailRepairStage, string> = {
  preparing: '准备模板',
  recognizing: 'AI 识别局部画框',
  merging: '合并识别结果',
  validating: '重新校验方案',
};

/** 阶段文案（UI 展示唯一来源；「N/4 阶段」是真实阶段数，非模型进度百分比）。 */
export function detailRepairStageLabel(stage: DetailRepairStage): string {
  return STAGE_LABELS[stage];
}

/** 已用时秒数（UI 每秒重算；runner 内不持有定时器）。 */
export function detailRepairElapsedSeconds(progress: Pick<DetailRepairProgress, 'startedAt'>, now = Date.now()): number {
  return Math.max(0, Math.floor((now - progress.startedAt) / 1000));
}

function newOperationId(): string {
  return `detail-repair-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 执行一次受限补充识别。返回终态 progress（success / error / cancelled）。
 * 任何情况下都不会修改 project 入参（合并由 applyResults 在调用方完成）。
 */
export async function runDetailInsertRepair(
  options: RunDetailInsertRepairOptions,
): Promise<DetailRepairProgress> {
  const { project } = options;
  const counts = countInsertInstances(project.renderingContract);
  let progress: DetailRepairProgress = {
    operationId: newOperationId(),
    projectId: project.id,
    projectRevision: project.revision,
    status: 'running',
    stage: 'preparing',
    totalRegions: counts.incompleteRegions.length,
    completedRegions: 0,
    startedAt: Date.now(),
  };
  const emit = (patch: Partial<DetailRepairProgress>): DetailRepairProgress => {
    progress = { ...progress, ...patch };
    options.onProgress(progress);
    return progress;
  };
  emit({});

  if (counts.incompleteRegions.length === 0) {
    return emit({ status: 'error', error: '当前没有待识别的局部插图层。' });
  }
  const resolved = options.resolveConfig();
  if (!resolved.ok) {
    return emit({ status: 'error', stage: 'preparing', error: resolved.error });
  }
  if (!project.templateSnapshot) {
    return emit({
      status: 'error', stage: 'preparing',
      error: '当前模板信息不完整，请重新分析模板后再补充识别。',
    });
  }

  emit({ stage: 'recognizing' });
  const results: DetailInsertRepairInput[] = [];
  let cancelled = false;
  for (const region of counts.incompleteRegions) {
    if (options.isCancelled?.()) {
      cancelled = true;
      break;
    }
    try {
      const result = await api.visionExtractDetailInserts({
        imagePath: project.sourceAsset.path,
        baseUrl: resolved.config.baseUrl,
        token: resolved.config.token,
        model: resolved.config.model,
        layerLabel: region.label,
        layerDescription: region.description ?? '',
      });
      results.push({
        regionId: region.id,
        instances: result.ok && result.instances?.length
          ? result.instances.map(instance => ({
            label: instance.label?.trim() || '局部插图',
            cropType: (instance.crop_type?.trim() || 'other') as 'face' | 'eyes' | 'hair' | 'expression' | 'clothing' | 'feet' | 'body' | 'other',
            mediaType: (instance.media_type?.trim() || region.renderingMode) as never,
            ...(instance.position && typeof instance.position.x === 'number'
              ? {
                bounds: {
                  x: instance.position.x,
                  y: instance.position.y ?? 0,
                  width: instance.position.width ?? 0.2,
                  height: instance.position.height ?? 0.2,
                },
              }
              : {}),
            ...(instance.description?.trim() ? { description: instance.description.trim() } : {}),
          }))
          : null,
      });
    } catch {
      // 单层失败不清空旧分析：null 占位，合并层按「该层未识别」处理
      results.push({ regionId: region.id, instances: null });
    }
    emit({ completedRegions: results.length });
  }

  if (cancelled && results.length === 0) {
    return emit({ status: 'cancelled', stage: 'recognizing', summary: '已停止识别，未产生结果。' });
  }

  emit({ stage: 'merging' });
  const outcome = options.applyResults(results);
  emit({ stage: 'validating' });
  if (!outcome.applied) {
    return emit({
      status: 'error',
      error: outcome.error ?? '本次识别结果未能合并（项目可能已切换），旧分析已保留。',
    });
  }
  const summary = cancelled
    ? `已停止剩余识别；${outcome.summary ?? ''}`.trim()
    : outcome.summary ?? '';
  return emit({ status: cancelled ? 'cancelled' : 'success', summary });
}
