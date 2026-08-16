/**
 * 任务展示层统一工具 —— 队列 / 历史 / 最近任务共用，
 * 禁止各页面重复实现相同格式化逻辑。
 */

import type { PromptOptimizationSnapshot, Task, TaskBatchStrategy } from '../types';

/** 批量策略中文标签（内部字段保留英文，UI 一律走这里）。 */
export function batchStrategyLabel(strategy?: string): string {
  switch (strategy) {
    case 'repeat_same': return '同 Prompt 多变体';
    case 'variant_set': return '多 Prompt 批量';
    case 'multi_input': return '多图批处理';
    default: return strategy || '';
  }
}

export function executionModeLabel(task: Pick<Task, 'execution_mode' | 'batch_strategy'>): string {
  if (task.execution_mode !== 'batch') return '单任务';
  const label = batchStrategyLabel(task.batch_strategy);
  return label ? `批量 / ${label}` : '批量';
}

/** 兼容 unknown / 旧数据的兜底（与 batchStrategyLabel 对齐）。 */
export function batchStrategyOrDefault(strategy?: string): TaskBatchStrategy {
  if (strategy === 'repeat_same' || strategy === 'variant_set' || strategy === 'multi_input') return strategy;
  return 'repeat_same';
}

/**
 * 最近任务 / 列表用紧凑时间：今天 HH:mm，非今天 MM-DD HH:mm。
 */
export function formatTaskTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (sameDay) return hhmm;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hhmm}`;
}

/** 完整时间（历史详情用）：YYYY/M/D HH:mm:ss。 */
export function formatTaskDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export interface PromptOptimizationDisplay {
  /** 是否已应用 AI 优化。 */
  applied: boolean;
  /** 结构化快照（有 provider/model/时间）。 */
  snapshot: PromptOptimizationSnapshot | null;
  /** 旧任务只有布尔记录、没有详情。 */
  legacy: boolean;
}

/**
 * 优化状态唯一读取入口：
 *   - 新任务读 prompt_optimization 结构化快照；
 *   - 旧任务缺快照时回落 prompt_optimized 布尔（legacy，无详情可显示）。
 * 禁止用 originalPrompt !== finalPrompt 之类的字符串比较推断。
 */
export function promptOptimizationState(task: Pick<Task, 'prompt_optimization' | 'prompt_optimized'>): PromptOptimizationDisplay {
  const snapshot = task.prompt_optimization;
  if (snapshot) return { applied: !!snapshot.applied, snapshot, legacy: false };
  if (task.prompt_optimized === true) {
    return { applied: true, snapshot: { applied: true }, legacy: true };
  }
  return { applied: false, snapshot: null, legacy: false };
}
