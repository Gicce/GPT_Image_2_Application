/**
 * 评价服务层（V4.0.9）：
 *  - resolveEvaluationContext：任务 → 评价上下文（参考图 / 修改要求 / preserve-change 语义）。
 *    视觉复刻链路优先读持久化 VisionSession（source_task_id 关联），普通图生图读
 *    任务自身 source_images + 用户原话；
 *  - evaluateTaskImages：对任务每张成功图片**逐张独立评价**（Phase 13 硬约束），
 *    串行执行避免同时打满 BYOK 视觉模型；任一张失败只记录失败态，绝不影响任务；
 *  - ensureEvaluationWatcher：挂在任务事件桥（registerTaskRefreshHook）之后，
 *    生成完成 → 保存资产 → 异步评价 → 分数附到资产（不阻塞图片先展示）。
 */

import { api } from '../../services/api';
import { registerTaskRefreshHook } from '../../store/useTaskStore';
import { useEvaluationStore } from '../../store/useEvaluationStore';
import { useVisionWorkspaceStore } from '../../store/useVisionWorkspaceStore';
import { resolveModelForRole, recordAiRoleUsage } from '../aiRouting/resolveModelForRole';
import { logAiTransport } from '../aiRouting/aiRoutingLog';
import { listVisionSessions } from '../vision/session';
import { buildPreserveChange, evaluationTaskKind } from './evaluationModel';
import { readEvaluationSettings } from './evaluationSettings';
import type { EvaluateImageRequestPayload, ImageEvaluation } from './types';
import type { ImageRecord, Task } from '../../types';

export interface EvaluationContext {
  referencePath: string | null;
  editInstruction: string;
  understandingSummary: string;
  preserve: string[];
  change: string[];
}

function visionRecreationContext(task: Task): EvaluationContext {
  const sourceTaskId = task.source_task_id || '';
  const session = listVisionSessions().find(s => s.visionTaskId === sourceTaskId);
  // 工作区兜底：评价发生时工作区仍停留在该视觉任务（同会话连续生成场景）
  const workspace = useVisionWorkspaceStore.getState();
  const fromWorkspace = !session && workspace.visionTaskId === sourceTaskId;
  const summary = session?.analysis?.summary ?? (fromWorkspace ? workspace.analysis?.summary ?? '' : '');
  const planFields = session?.recreation?.plan.fields
    ?? (fromWorkspace ? workspace.recreation?.plan.fields : undefined);
  const adjustInstruction = session?.recreation?.adjustInstruction
    ?? (fromWorkspace ? workspace.recreation?.adjustInstruction ?? '' : '');
  const semantics = buildPreserveChange({ planFields, adjustInstruction });
  const referencePath = task.source_images[0]
    ?? session?.sourcePath
    ?? (fromWorkspace ? workspace.sourcePath : '')
    ?? '';
  return {
    referencePath: referencePath || null,
    editInstruction: adjustInstruction || task.user_prompt_raw || '',
    understandingSummary: summary || '',
    preserve: semantics.preserve,
    change: semantics.change,
  };
}

function genericImageContext(task: Task): EvaluationContext {
  const instruction = task.user_prompt_raw || task.final_prompt || task.prompt || '';
  const semantics = buildPreserveChange({ adjustInstruction: instruction });
  return {
    referencePath: task.source_images[0] ?? null,
    editInstruction: instruction,
    understandingSummary: '',
    preserve: semantics.preserve,
    change: semantics.change,
  };
}

/** 任务 → 评价上下文（视觉复刻走 session 结构化语义；其余按参考图 + 用户原话）。 */
export function resolveEvaluationContext(task: Task): EvaluationContext {
  if (evaluationTaskKind(task) === 'vision_recreation') {
    return visionRecreationContext(task);
  }
  return genericImageContext(task);
}

/** 可评价的图片任务类型（视觉理解 / 抠图不评价：前者无图，后者确定性操作）。 */
function isEvaluatableTask(task: Task): boolean {
  return task.task_type === 'generate' || task.task_type === 'edit';
}

export interface EvaluateTaskOutcome {
  evaluated: number;
  skipped: number;
  failed: number;
}

/**
 * 对一个已完成任务的全部成功图片逐张评价。
 *  - force=false（自动）：跳过已有评价或已有同版本评价的资产；
 *  - force=true（手动重新评价）：强制覆盖 AI 字段（用户反馈保留，见 Rust upsert）；
 *  - 串行执行；单张失败计入 failed，不影响其余。
 */
export async function evaluateTaskImages(
  task: Task,
  imageById: Map<string, ImageRecord>,
  options?: { force?: boolean },
): Promise<EvaluateTaskOutcome> {
  const store = useEvaluationStore.getState();
  const force = options?.force === true;
  // role=image_evaluation（V4.1）：默认跟随视觉理解模型；单独指定 / 回退经统一 resolver
  const resolution = resolveModelForRole('image_evaluation');
  let config: { ok: true; baseUrl: string; token: string; model: string } | { ok: false; error: string };
  if (resolution.ok && resolution.connection) {
    config = {
      ok: true,
      baseUrl: resolution.connection.baseUrl,
      token: resolution.connection.token,
      model: resolution.connection.model,
    };
    recordAiRoleUsage(resolution.resolved);
    logAiTransport(resolution.resolved, 'image-evaluation');
  } else {
    config = { ok: false, error: resolution.ok ? '该功能没有可用的模型连接。' : resolution.error };
  }
  const kind = evaluationTaskKind(task);
  const context = resolveEvaluationContext(task);

  const targets = task.sub_tasks
    .filter(sub => sub.status === 'completed' && sub.image_id)
    .map(sub => ({ assetId: sub.image_id!, record: imageById.get(sub.image_id!) }))
    .filter(item => item.record && !item.record.missing && item.record.local_path);

  const outcome: EvaluateTaskOutcome = { evaluated: 0, skipped: 0, failed: 0 };
  for (const { assetId, record } of targets) {
    const existing = useEvaluationStore.getState().evaluations[assetId];
    if (!force && existing) {
      outcome.skipped += 1;
      continue;
    }
    if (!config.ok) {
      // 视觉模型不可用：全部标记失败（UI 显示「暂无评价」，可配置后手动重评）
      useEvaluationStore.getState().markFailed(assetId, config.error);
      outcome.failed += 1;
      continue;
    }
    const payload: EvaluateImageRequestPayload = {
      asset_id: assetId,
      asset_path: record!.local_path,
      task_id: task.id,
      task_kind: kind,
      reference_path: context.referencePath,
      edit_instruction: context.editInstruction,
      understanding_summary: context.understandingSummary,
      preserve: context.preserve,
      change: context.change,
      base_url: config.baseUrl,
      token: config.token,
      model: config.model,
    };
    useEvaluationStore.getState().markPending(assetId);
    try {
      const result = await api.evaluateImage(payload);
      const storeNow = useEvaluationStore.getState();
      storeNow.clearPending(assetId);
      if (result.ok && result.evaluation) {
        storeNow.upsert(result.evaluation);
        storeNow.clearFailure(assetId);
        outcome.evaluated += 1;
      } else {
        storeNow.markFailed(assetId, result.error_message || '评价失败');
        outcome.failed += 1;
      }
    } catch (err: any) {
      const storeNow = useEvaluationStore.getState();
      storeNow.clearPending(assetId);
      storeNow.markFailed(assetId, String(err?.message || err || '评价请求失败'));
      outcome.failed += 1;
    }
  }
  return outcome;
}

let watcherBound = false;

/**
 * 全局评价 watcher（App 启动后调用一次）：
 * 任务事件桥刷新 → 任务完成且有新成功图片 → 异步逐张评价（先展示图片，评分后置）。
 */
export function ensureEvaluationWatcher(): void {
  if (watcherBound) return;
  watcherBound = true;
  registerTaskRefreshHook(taskId => {
    void (async () => {
      try {
        if (!readEvaluationSettings().autoEvaluate) return;
        const { useTaskStore } = await import('../../store/useTaskStore');
        const task = useTaskStore.getState().tasks.find(t => t.id === taskId);
        if (!task || !isEvaluatableTask(task)) return;
        // 只在终态且至少一张成功时触发；评价失败绝不影响任务状态
        if (task.status !== 'completed' && task.status !== 'failed') return;
        const pendingImages = task.sub_tasks.filter(
          sub => sub.status === 'completed' && sub.image_id
            && !useEvaluationStore.getState().evaluations[sub.image_id]
            && !useEvaluationStore.getState().pending[sub.image_id],
        );
        if (pendingImages.length === 0) return;
        const images = await api.getImages();
        const imageById = new Map(images.map(img => [img.id, img]));
        await evaluateTaskImages(task, imageById, { force: false });
      } catch {
        // watcher 内部异常静默：评价永远不阻塞任务链路
      }
    })();
  });
}

/** 手动重新评价单张资产（EvaluationPanel「重新评价」入口）。 */
export async function reEvaluateAsset(
  task: Task,
  imageById: Map<string, ImageRecord>,
  assetId: string,
): Promise<ImageEvaluation | null> {
  const result = await evaluateTaskImages(
    { ...task, sub_tasks: task.sub_tasks.map(sub => (sub.image_id === assetId ? { ...sub } : sub)) },
    imageById,
    { force: true },
  );
  void result;
  return useEvaluationStore.getState().evaluations[assetId] ?? null;
}
