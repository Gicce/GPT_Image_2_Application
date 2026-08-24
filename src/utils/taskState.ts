/**
 * 任务状态聚合唯一纯函数（V4.1 Task Queue Reliability）。
 *
 * 铁律：页面禁止自己从 task.status / success_count 猜状态；
 * 一律 deriveTaskState(task) 从 sub_tasks 事实派生。后端 finalize 事件
 * 丢失 / loadTasks 瞬时失败时，前端仍能展示正确终态（1/1 失败 ≠ 执行中）。
 *
 * 状态规则：
 *  - queued    存在未终态子任务且任务未被认领（parent pending）
 *  - running   任一子任务 running，或已被认领仍有可执行子任务
 *  - completed 全部子任务 completed
 *  - partial   全部终态且 成功>0 且 失败>0
 *  - failed    全部终态且 成功=0 且 失败>0
 *  - cancelled 任务被明确取消且没有 running 子任务（或全部子任务 cancelled）
 */

import type { SubTask, Task } from '../types';

export type TaskDerivedState = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';

export interface TaskStateInput {
  status: Task['status'];
  sub_tasks: SubTask[];
}

const SUB_TERMINAL: ReadonlySet<SubTask['status']> = new Set(['completed', 'failed', 'cancelled']);

function countBy(subTasks: SubTask[], status: SubTask['status']): number {
  return subTasks.reduce((n, st) => (st.status === status ? n + 1 : n), 0);
}

export function deriveTaskState(task: TaskStateInput): TaskDerivedState {
  const subs = task.sub_tasks ?? [];
  if (subs.length === 0) {
    // 无子任务事实可依（历史异常数据）：退回 parent status
    if (task.status === 'completed') return 'completed';
    if (task.status === 'cancelled') return 'cancelled';
    if (task.status === 'failed') return 'failed';
    return task.status === 'running' ? 'running' : 'queued';
  }

  const running = countBy(subs, 'running');
  const pending = countBy(subs, 'pending');
  const completed = countBy(subs, 'completed');
  const failed = countBy(subs, 'failed');
  const cancelled = countBy(subs, 'cancelled');

  if (task.status === 'cancelled' && running === 0) return 'cancelled';
  if (running > 0) return 'running';
  if (pending > 0) {
    // 可执行子任务仍在队列：parent 已被认领 = running，否则 queued
    return task.status === 'running' ? 'running' : 'queued';
  }

  // 全部子任务终态
  if (failed > 0) return completed > 0 ? 'partial' : 'failed';
  if (completed > 0) return 'completed';
  return 'cancelled';
}

/** 派生态是否终态（终态任务不再显示「取消任务」）。 */
export function isDerivedTerminal(state: TaskDerivedState): boolean {
  return state === 'completed' || state === 'partial' || state === 'failed' || state === 'cancelled';
}

/** 派生态是否有可重试的失败子任务（failed / partial）。 */
export function derivedStateHasFailedSlots(state: TaskDerivedState): boolean {
  return state === 'failed' || state === 'partial';
}

/**
 * 结束时间唯一读取入口：
 * completed / failed / partial / cancelled 共用 completed_at（Rust finalize /
 * cancel / reconcile 落盘的真实时间）。旧任务没有 → null，UI 显示「—」，
 * 绝不用 Date.now() 伪造（耗时同样据此派生，缺失即不显示）。
 */
export function resolveTaskFinishedAt(task: Pick<Task, 'completed_at'>): string | null {
  const iso = task.completed_at;
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > 0 ? iso : null;
}

/** 开始时间（首次进入 running；旧任务可能没有 → null）。 */
export function resolveTaskStartedAt(task: Pick<Task, 'started_at'>): string | null {
  const iso = task.started_at;
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > 0 ? iso : null;
}

/** 终态任务总耗时（ms）；开始或结束缺失 → null（禁止用 created_at 凑数）。 */
export function taskDurationMs(
  task: Pick<Task, 'started_at' | 'completed_at'>,
): number | null {
  const started = resolveTaskStartedAt(task);
  const finished = resolveTaskFinishedAt(task);
  if (!started || !finished) return null;
  const duration = Date.parse(finished) - Date.parse(started);
  return duration >= 0 ? duration : null;
}

/** 派生态 → 展示词 / 徽章样式（状态词遵循 copy.md §3：生成中 / 已完成 / 失败 / 已取消）。 */
export const DERIVED_STATUS_META: Record<TaskDerivedState, { label: string; cls: string }> = {
  queued: { label: '等待中', cls: 'status-pending' },
  running: { label: '生成中', cls: 'status-running' },
  completed: { label: '已完成', cls: 'status-completed' },
  partial: { label: '部分完成', cls: 'status-failed' },
  failed: { label: '失败', cls: 'status-failed' },
  cancelled: { label: '已取消', cls: 'status-cancelled' },
};
