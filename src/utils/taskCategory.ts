/**
 * 任务分类唯一事实源 —— 任务队列 / 历史记录共用，禁止两页各写一套判断规则。
 *
 * 分类只读结构化字段 task_type：
 *   - vision_understanding → 视觉理解（前端驱动的理解任务，不产出图片）
 *   - edit / remove_background → 图生图（消费源图的生成任务）
 *   - generate / 旧数据空串 → 文生图
 *
 * 来源链路（source_task_id / source_task_kind）是「这个任务从哪来」的信息，
 * 不参与分类：视觉理解复刻方案产生的生成任务按自身 task_type 归类为文生图/图生图，
 * 绝不能因为来源是视觉理解就被算进视觉理解。
 * 禁止根据 title / prompt 文本猜测类型。
 */

import type { Task } from '../types';

export type TaskCategory = 'text_to_image' | 'image_to_image' | 'vision_understanding';
export type TaskCategoryFilter = 'all' | TaskCategory;
export type TaskStatusFilter = 'all' | 'pending' | 'running' | 'completed' | 'failed';

export const TASK_CATEGORY_FILTERS: ReadonlyArray<{ key: TaskCategoryFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'text_to_image', label: '文生图' },
  { key: 'image_to_image', label: '图生图' },
  { key: 'vision_understanding', label: '视觉理解' },
];

const CATEGORY_LABELS: Record<TaskCategory, string> = {
  text_to_image: '文生图',
  image_to_image: '图生图',
  vision_understanding: '视觉理解',
};

export const TASK_STATUS_FILTERS: ReadonlyArray<{ key: TaskStatusFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '等待中' },
  { key: 'running', label: '执行中' },
  { key: 'completed', label: '已完成' },
  { key: 'failed', label: '失败' },
];

export function getTaskCategory(task: Pick<Task, 'task_type'>): TaskCategory {
  if (task.task_type === 'vision_understanding') return 'vision_understanding';
  if (task.task_type === 'edit' || task.task_type === 'remove_background') return 'image_to_image';
  return 'text_to_image';
}

export function getTaskCategoryLabel(task: Pick<Task, 'task_type'>): string {
  return CATEGORY_LABELS[getTaskCategory(task)];
}

/** 分类之外的补充标签：透明背景在图生图大类下保留自身标识，避免信息丢失。 */
export function getTaskTypeExtraLabel(task: Pick<Task, 'task_type'>): string {
  return task.task_type === 'remove_background' ? '透明背景' : '';
}

export type TaskCategoryCounts = Record<TaskCategoryFilter, number>;

/** 各分类真实数量（all = 任务总数），从传入任务数组动态计算。 */
export function getTaskCategoryCounts(tasks: ReadonlyArray<Pick<Task, 'task_type'>>): TaskCategoryCounts {
  const counts: TaskCategoryCounts = {
    all: tasks.length,
    text_to_image: 0,
    image_to_image: 0,
    vision_understanding: 0,
  };
  for (const task of tasks) counts[getTaskCategory(task)] += 1;
  return counts;
}

export function filterTasksByCategory<T extends Pick<Task, 'task_type'>>(
  tasks: ReadonlyArray<T>,
  filter: TaskCategoryFilter,
): T[] {
  if (filter === 'all') return [...tasks];
  return tasks.filter(task => getTaskCategory(task) === filter);
}

/** 已取消任务只出现在「全部」，与筛选条只提供四种状态一致。 */
export function filterTasksByStatus<T extends Pick<Task, 'status'>>(
  tasks: ReadonlyArray<T>,
  filter: TaskStatusFilter,
): T[] {
  if (filter === 'all') return [...tasks];
  return tasks.filter(task => task.status === filter);
}
