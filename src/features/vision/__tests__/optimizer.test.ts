import { describe, it, expect } from 'vitest';
import { applyRecreationCorrection, evaluateStopCondition } from '../optimizer';
import type { ReversePromptResult } from '../reversePrompt';
import type { SimilarityReport } from '../similarity';

function makeReverseResult(prompt = '红底保温杯产品图，中景，柔光箱布光'): ReversePromptResult {
  return {
    prompt,
    negativePrompt: '模糊，低清',
    sections: { subject: '保温杯', action: '', scene: '摄影棚', composition: '', camera: '中景', lighting: '柔光箱', color: '', material: '', style: '', detail: '' },
    recommended: { aspectRatio: '1:1', size: '1024x1024', quality: 'auto' },
    risks: [],
    warnings: [],
  };
}

function makeReport(patch: Partial<SimilarityReport> = {}): SimilarityReport {
  return {
    final_score: 0.72,
    scores: { subject: 0.8, composition: 0.7, style: 0.75, lighting: 0.65, color: 0.7, objects: 0.7, ocr: null },
    local_color: 0.7,
    local_composition: 0.68,
    differences: [
      { kind: 'missing', text: '招牌上的品牌字' },
      { kind: 'extra', text: '多余的第三只手' },
      { kind: 'layout', text: '主体占比过小（约 40%，参考图约 65%）' },
    ],
    recommendations: ['主体放大至画面 65%'],
    effective_weights: { subject: 0.3, composition: 0.2, style: 0.15, lighting: 0.1, color: 0.1, objects: 0.15, ocr: 0 },
    ...patch,
  };
}

describe('evaluateStopCondition 停止条件', () => {
  const base = { targetScore: 0.9, maxIterations: 2, minImprovement: 0.015 };

  it('达到目标 → 停止（target_reached）', () => {
    const result = evaluateStopCondition({ ...base, latestScore: 0.91, previousScore: null, iteration: 1 });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe('target_reached');
  });

  it('达到最大轮数 → 停止（max_iterations）', () => {
    const result = evaluateStopCondition({ ...base, latestScore: 0.8, previousScore: 0.7, iteration: 2 });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe('max_iterations');
  });

  it('改善不足 → 提前停止（no_improvement）', () => {
    const result = evaluateStopCondition({ ...base, latestScore: 0.721, previousScore: 0.72, iteration: 1 });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe('no_improvement');
  });

  it('首轮无前值不判 no_improvement → 继续', () => {
    const result = evaluateStopCondition({ ...base, latestScore: 0.5, previousScore: null, iteration: 1 });
    expect(result.shouldStop).toBe(false);
    expect(result.reason).toBe('continue');
  });

  it('改善充分且未达目标 → 继续', () => {
    const result = evaluateStopCondition({ ...base, latestScore: 0.85, previousScore: 0.7, iteration: 1 });
    expect(result.shouldStop).toBe(false);
  });

  it('恰好等于 minImprovement 边界：0.015 改善不算不足（< 才停）', () => {
    const result = evaluateStopCondition({ ...base, latestScore: 0.735, previousScore: 0.72, iteration: 1 });
    expect(result.shouldStop).toBe(false);
  });
});

describe('applyRecreationCorrection 差异修正', () => {
  it('只追加差异修正块，不重写原 Prompt（防 drift）', () => {
    const current = makeReverseResult();
    const result = applyRecreationCorrection(current, makeReport());
    expect(result.prompt.startsWith(current.prompt)).toBe(true);
    expect(result.prompt).toContain('复刻修正要求');
    expect(result.prompt).toContain('必须包含：招牌上的品牌字');
    expect(result.prompt).toContain('移除画面中的：多余的第三只手');
    expect(result.prompt).toContain('主体放大至画面 65%');
  });

  it('extra 元素同时进入负面词', () => {
    const current = makeReverseResult();
    const result = applyRecreationCorrection(current, makeReport());
    expect(result.negativePrompt).toContain('多余的第三只手');
    expect(result.negativePrompt.startsWith(current.negativePrompt)).toBe(true);
  });

  it('无差异时 Prompt 完全不变', () => {
    const current = makeReverseResult();
    const report = makeReport({ differences: [], recommendations: [] });
    const result = applyRecreationCorrection(current, report);
    expect(result.prompt).toBe(current.prompt);
    expect(result.negativePrompt).toBe(current.negativePrompt);
    expect(result.appliedCorrections).toHaveLength(0);
  });

  it('修正指令去重（本地差异与模型建议重复时只保留一份）', () => {
    const current = makeReverseResult();
    const report = makeReport({
      differences: [{ kind: 'layout', text: '主体放大' }],
      recommendations: ['主体放大'],
    });
    const result = applyRecreationCorrection(current, report);
    const count = result.appliedCorrections.filter(c => c.includes('主体放大')).length;
    expect(count).toBe(1);
  });

  it('连续两轮修正叠加且不丢失第一轮内容', () => {
    const round1 = makeReverseResult();
    const first = applyRecreationCorrection(round1, makeReport());
    const secondReport = makeReport({
      differences: [{ kind: 'color', text: '整体偏冷，需加暖' }],
      recommendations: [],
    });
    const second = applyRecreationCorrection(
      { ...round1, prompt: first.prompt, negativePrompt: first.negativePrompt },
      secondReport,
    );
    expect(second.prompt).toContain('必须包含：招牌上的品牌字'); // 第一轮内容保留
    expect(second.prompt).toContain('色彩修正：整体偏冷，需加暖'); // 第二轮新增
  });
});
