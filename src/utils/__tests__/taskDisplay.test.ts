import { describe, it, expect } from 'vitest';
import {
  batchStrategyLabel,
  executionModeLabel,
  formatTaskTime,
  formatTaskDateTime,
  promptOptimizationState,
} from '../taskDisplay';
import type { Task } from '../../types';

describe('batchStrategyLabel / executionModeLabel', () => {
  it('批量策略显示中文标签', () => {
    expect(batchStrategyLabel('repeat_same')).toBe('同 Prompt 多变体');
    expect(batchStrategyLabel('variant_set')).toBe('多 Prompt 批量');
    expect(batchStrategyLabel('multi_input')).toBe('多图批处理');
  });

  it('执行模式：批量带中文策略，单任务原样', () => {
    expect(executionModeLabel({ execution_mode: 'batch', batch_strategy: 'variant_set' })).toBe('批量 / 多 Prompt 批量');
    expect(executionModeLabel({ execution_mode: 'single' })).toBe('单任务');
  });
});

describe('formatTaskTime（最近任务时间）', () => {
  it('今天显示 HH:mm', () => {
    const now = new Date(2026, 7, 15, 23, 0);
    expect(formatTaskTime('2026-08-15T22:34:00', now)).toBe('22:34');
  });

  it('非今天显示 MM-DD HH:mm', () => {
    const now = new Date(2026, 7, 15, 23, 0);
    expect(formatTaskTime('2026-08-14T21:47:00', now)).toBe('08-14 21:47');
    expect(formatTaskTime('2025-12-31T09:05:00', now)).toBe('12-31 09:05');
  });

  it('非法时间返回空串', () => {
    expect(formatTaskTime('not-a-date')).toBe('');
  });
});

describe('formatTaskDateTime（历史详情完整时间）', () => {
  it('输出 YYYY/M/D HH:mm:ss', () => {
    expect(formatTaskDateTime('2026-08-15T22:34:22')).toMatch(/^2026\/8\/15 22:34:22$/);
  });
});

describe('promptOptimizationState（优化状态唯一读取入口）', () => {
  function makeTask(patch: Partial<Task>): Pick<Task, 'prompt_optimization' | 'prompt_optimized'> {
    return { prompt_optimization: undefined, prompt_optimized: false, ...patch } as Task;
  }

  it('新任务：结构化快照 applied=true → 已优化（含详情）', () => {
    const state = promptOptimizationState(makeTask({
      prompt_optimization: {
        applied: true,
        provider_name: '智谱',
        model_name: 'GLM-5.2',
        original_prompt: '我需要3张不同中国城市的夜景图',
        optimized_at: '2026-08-15T22:10:00',
      },
    }));
    expect(state.applied).toBe(true);
    expect(state.snapshot?.provider_name).toBe('智谱');
    expect(state.snapshot?.model_name).toBe('GLM-5.2');
    expect(state.legacy).toBe(false);
  });

  it('新任务未优化：快照 applied=false → 未优化', () => {
    const state = promptOptimizationState(makeTask({ prompt_optimization: { applied: false } }));
    expect(state.applied).toBe(false);
  });

  it('旧任务无快照但布尔为 true → 已优化（legacy，无详情）', () => {
    const state = promptOptimizationState(makeTask({ prompt_optimization: null, prompt_optimized: true }));
    expect(state.applied).toBe(true);
    expect(state.legacy).toBe(true);
    expect(state.snapshot?.provider_name).toBeUndefined();
  });

  it('旧任务无快照且布尔为 false → 未优化', () => {
    const state = promptOptimizationState(makeTask({ prompt_optimization: null, prompt_optimized: false }));
    expect(state.applied).toBe(false);
  });
});
