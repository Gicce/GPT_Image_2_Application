/**
 * 视觉理解任务（V4.0.7）：把"分析参考图"纳入任务体系。
 *
 * 生命周期（前端驱动，task_runner 绝不认领 vision_understanding 类型）：
 *   创建(pending) → running（正在分析参考图片…）→ completed（已分析参考图：…）
 *                                                → failed（视觉理解失败，请重试或更换视觉模型。）
 *
 * 任务记录本身不阻塞分析流程：创建 / 更新失败只提示，不中断 BYOK 视觉分析。
 */

import { api } from '../../services/api';
import { useTaskStore } from '../../store/useTaskStore';
import type { Task } from '../../types';
import type { VisionMode } from './session';

const VISION_TASK_PROMPT = '视觉理解：分析参考图片的主体、构图、动作、背景、光线、风格，并生成可复刻的结构化方案。';

export interface VisionUnderstandingTaskInfo {
  task: Task | null;
}

/** 点击「提取复刻方案 / 开始分析」时创建视觉理解任务（失败不阻塞分析）。 */
export async function createVisionUnderstandingTask(params: {
  sourcePath: string;
  modelId: string;
  mode: VisionMode;
}): Promise<Task | null> {
  try {
    const task = await api.createTask({
      prompt: VISION_TASK_PROMPT,
      negative_prompt: '',
      user_prompt_raw: `分析参考图（${params.mode === 'quick' ? '快速理解' : params.mode === 'high_fidelity' ? '高复刻' : '专业反向 Prompt'}）：${params.sourcePath}`,
      task_type: 'vision_understanding',
      source_images: [params.sourcePath],
      size: '1024x1024',
      quality: 'auto',
      output_format: 'png',
      count: 1,
      output_dir: '',
      execution_mode: 'single',
      task_source: 'manual',
      task_plan_summary: `正在分析参考图片（视觉模型 ${params.modelId}）…`,
    });
    useTaskStore.getState().addTask(task);
    return task;
  } catch (err: any) {
    // 任务记录失败不阻塞分析本身，但要让用户知道任务中心少了这条链路
    console.warn('[VisionTask] create vision task failed:', err?.message || err);
    return null;
  }
}

/** 推进视觉理解任务状态并同步 store（失败静默，仅日志）。 */
async function pushVisionTaskUpdate(update: {
  taskId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  stageNote?: string;
  planSummary?: string;
  error?: string;
}): Promise<void> {
  try {
    const task = await api.updateVisionTask(update);
    useTaskStore.getState().updateTask(task);
  } catch (err: any) {
    console.warn('[VisionTask] update vision task failed:', err?.message || err);
  }
}

export async function markVisionTaskRunning(taskId: string, stageNote = '正在分析参考图片（主体、构图、光线、风格）…'): Promise<void> {
  await pushVisionTaskUpdate({ taskId, status: 'running', stageNote });
}

export async function markVisionTaskCompleted(taskId: string, summary: string, modelName: string): Promise<void> {
  const clipped = summary.length > 60 ? `${summary.slice(0, 60)}…` : summary;
  await pushVisionTaskUpdate({
    taskId,
    status: 'completed',
    stageNote: '视觉理解完成',
    planSummary: `已分析参考图：${clipped} · 视觉模型 ${modelName}`,
  });
}

export async function markVisionTaskFailed(taskId: string, errorMessage: string): Promise<void> {
  await pushVisionTaskUpdate({
    taskId,
    status: 'failed',
    stageNote: '视觉理解失败',
    error: errorMessage,
    planSummary: '视觉理解失败，请重试或更换视觉模型。',
  });
}
