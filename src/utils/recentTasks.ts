import type { Task } from '../types';

/** 最近任务面板显示条数 */
export const RECENT_TASKS_LIMIT = 8;

/** 图片生成页只展示图片类 ExecutionTask，不混入其他任务类型 */
const IMAGE_TASK_TYPES = new Set(['generate', 'edit', 'remove_background']);

function recentTaskPrefix(task: Task): string {
  if (task.task_type === 'edit') return '[图生图] ';
  if (task.task_type === 'remove_background') return '[抠图] ';
  return '[文生图] ';
}

/** 标题优先级：task_plan_summary → 原始 Prompt 首行摘要（≤24 字） → 类型 + 时间 */
export function recentTaskTitle(task: Task): string {
  const base = (task.task_plan_summary || task.user_prompt_raw || task.prompt || '').trim();
  const line = base.split('\n')[0].trim();
  if (line) return line.length > 24 ? `${line.slice(0, 24)}…` : line;
  return new Date(task.created_at).toLocaleString('zh-CN');
}

export function recentTaskDisplayTitle(task: Task): string {
  return `${recentTaskPrefix(task)}${recentTaskTitle(task)}`;
}

/** 最近任务 selector：过滤图片任务 + 按 id 去重（保留最新快照）+ createdAt 倒序 + LIMIT */
export function selectRecentImageTasks(tasks: Task[], limit: number = RECENT_TASKS_LIMIT): Task[] {
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    if (!IMAGE_TASK_TYPES.has(task.task_type)) continue;
    byId.set(task.id, task);
  }
  return [...byId.values()]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit);
}
