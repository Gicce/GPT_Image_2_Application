import { describe, it, expect } from 'vitest';
import {
  buildBatchPlanTaskParams,
  clampPlanCount,
  createPlan,
  isPlanReady,
  MAX_PLAN_COUNT,
  pendingPlanCount,
  readyPlanCount,
} from '../batchPlans';

function readyPlan(overrides?: Partial<ReturnType<typeof createPlan>>) {
  return {
    ...createPlan({ title: '红黑重甲 · 长枪 · 古城墙', source: 'ai_planned' as const }),
    positivePrompt: '战国女将，红黑札甲，手持长枪，立于烽火古城墙，电影级写实光影',
    negativePrompt: '模糊，水印，多余手指',
    optimizationStatus: 'success' as const,
    ...overrides,
  };
}

const OPTIONS = {
  taskType: 'generate' as const,
  originalRequirement: '生成3张不同的战国时期女战将',
  sourceImages: [],
  size: '1024x1024',
  quality: 'auto',
  outputFormat: 'png',
  outputDir: 'D:/out',
};

describe('createPlan / clampPlanCount', () => {
  it('createPlan 默认为待完善的手动方案（无 prompt、idle）', () => {
    const plan = createPlan();
    expect(plan.positivePrompt).toBe('');
    expect(plan.negativePrompt).toBe('');
    expect(plan.optimizationStatus).toBe('idle');
    expect(plan.source).toBe('manual');
    expect(plan.isManuallyEdited).toBe(false);
    expect(plan.id).toMatch(/^plan_/);
  });

  it('每个 createPlan 生成稳定且互不相同的 id', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createPlan().id));
    expect(ids.size).toBe(50);
  });

  it('clampPlanCount 限制在 1～20（非法值回落默认 3）', () => {
    expect(clampPlanCount(0)).toBe(3); // 空/0 输入回落默认目标数量
    expect(clampPlanCount(-5)).toBe(1);
    expect(clampPlanCount(1)).toBe(1);
    expect(clampPlanCount(3)).toBe(3);
    expect(clampPlanCount(99)).toBe(MAX_PLAN_COUNT);
    expect(clampPlanCount(NaN)).toBe(3);
  });
});

describe('isPlanReady / 数量统计', () => {
  it('ready 判定只看 positivePrompt（负面词可为空）', () => {
    const noNegative = readyPlan({ negativePrompt: '' });
    expect(isPlanReady(noNegative)).toBe(true);
    expect(isPlanReady(readyPlan({ positivePrompt: '   ' }))).toBe(false);
  });

  it('readyPlanCount / pendingPlanCount 正确统计', () => {
    const plans = [readyPlan(), readyPlan(), createPlan()];
    expect(readyPlanCount(plans)).toBe(2);
    expect(pendingPlanCount(plans)).toBe(1);
  });
});

describe('buildBatchPlanTaskParams（1 plan = 1 image）', () => {
  it('存在待完善方案时抛错', () => {
    const plans = [readyPlan(), createPlan()];
    expect(() => buildBatchPlanTaskParams(plans, OPTIONS)).toThrow('尚未完善');
  });

  it('空方案列表抛错', () => {
    expect(() => buildBatchPlanTaskParams([], OPTIONS)).toThrow('至少需要一个生成方案');
  });

  it('图生图无参考图抛错', () => {
    expect(() => buildBatchPlanTaskParams([readyPlan()], { ...OPTIONS, taskType: 'edit' })).toThrow('参考图片');
  });

  it('1 个方案：single，count=1，不携带 batch_items', () => {
    const { params, total } = buildBatchPlanTaskParams([readyPlan()], OPTIONS);
    expect(total).toBe(1);
    expect(params.count).toBe(1);
    expect(params.execution_mode).toBe('single');
    expect(params.batch_items).toBeUndefined();
    expect(params.prompt).toContain('红黑札甲');
    expect(params.negative_prompt).toBe('模糊，水印，多余手指');
    expect(params.user_prompt_raw).toBe(OPTIONS.originalRequirement);
  });

  it('3 个方案：variant_set，count 严格等于 3，每方案一个 batch_item 各 1 张', () => {
    const plans = [
      readyPlan(),
      readyPlan({ title: '青铜甲胄 · 长剑 · 军营', positivePrompt: 'P2' }),
      readyPlan({ title: '骑马女将 · 长弓 · 荒原', positivePrompt: 'P3', negativePrompt: '' }),
    ];
    const { params, total } = buildBatchPlanTaskParams(plans, OPTIONS);
    expect(total).toBe(3);
    expect(params.count).toBe(3);
    expect(params.execution_mode).toBe('batch');
    expect(params.batch_strategy).toBe('variant_set');
    expect(params.batch_items).toHaveLength(3);
    expect(params.batch_items!.map(item => item.prompt_override)).toEqual([
      '战国女将，红黑札甲，手持长枪，立于烽火古城墙，电影级写实光影',
      'P2',
      'P3',
    ]);
    expect(params.batch_items![2].negative_override).toBe('');
    expect(params.batch_items![0].label).toBe('方案 1 · 红黑重甲 · 长枪 · 古城墙');
    expect(params.batch_items!.map(item => item.id)).toEqual(plans.map(plan => plan.id));
    expect(params.task_plan_summary).toBe('3 个方案 / 共 3 张');
  });

  it('删除中间方案后：数量与 batch_item 严格一致（3 plans = 3 images）', () => {
    const plans = [readyPlan(), readyPlan(), readyPlan(), readyPlan()];
    const remaining = [plans[0], plans[2], plans[3]];
    const { params, total } = buildBatchPlanTaskParams(remaining, OPTIONS);
    expect(total).toBe(3);
    expect(params.batch_items).toHaveLength(3);
    // 底层 id 保持稳定，不按数组 index 重新生成
    expect(params.batch_items!.map(item => item.id)).toEqual(remaining.map(plan => plan.id));
  });

  it('图生图批量：每个 batch_item 携带 source_images', () => {
    const plans = [readyPlan(), readyPlan()];
    const { params } = buildBatchPlanTaskParams(plans, { ...OPTIONS, taskType: 'edit', sourceImages: ['D:/a.png'] });
    expect(params.batch_items!.every(item => item.source_images?.includes('D:/a.png'))).toBe(true);
  });
});
