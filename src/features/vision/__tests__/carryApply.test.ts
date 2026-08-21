import { describe, it, expect } from 'vitest';
import { buildGenerationCarry, initialRecreationState } from '../recreationPlan';
import { resolveCarryGenerationMode, resolveVisionCarryPatch } from '../carryApply';
import type { VisionCarryDraft } from '../../../store/useDraftStore';

/**
 * 视觉理解 → 图片工作室（V4.0.8）：
 * 视觉理解不再强制文生图 —— 有原图默认图生图，原图直接作为参考图。
 */

function makeCarry(overrides: Partial<VisionCarryDraft> = {}): VisionCarryDraft {
  return {
    prompt: '一名战国女将，身着甲胄…',
    negativePrompt: '低画质，模糊',
    size: '1024x1024',
    quality: 'high',
    count: 2,
    generationMode: undefined,
    ...overrides,
  };
}

describe('resolveCarryGenerationMode（默认策略，不写死关键词）', () => {
  it('存在视觉理解原图 → 默认图生图', () => {
    expect(resolveCarryGenerationMode(makeCarry({ sourceImagePath: 'D:/ref.png' }))).toBe('i2i');
  });

  it('无原图 → 文生图', () => {
    expect(resolveCarryGenerationMode(makeCarry())).toBe('t2i');
    expect(resolveCarryGenerationMode(makeCarry({ sourceImagePath: '  ' }))).toBe('t2i');
  });

  it('用户显式选择优先于默认规则（可手动切换回文生图）', () => {
    expect(
      resolveCarryGenerationMode(makeCarry({ generationMode: 't2i', sourceImagePath: 'D:/ref.png' })),
    ).toBe('t2i');
    expect(resolveCarryGenerationMode(makeCarry({ generationMode: 'i2i' }))).toBe('i2i');
  });
});

describe('resolveVisionCarryPatch（图生图携带完整状态，不要求用户重选）', () => {
  it('图生图：原图成为参考图（复用路径不复制），Prompt 进编辑需求，尺寸质量带过', () => {
    const patch = resolveVisionCarryPatch(
      makeCarry({ sourceImagePath: 'D:\\vision\\source.png', sourceAssetId: 'asset-1' }),
    );
    expect(patch.generationType).toBe('i2i');
    expect(patch.generationMode).toBe('single');
    expect(patch.i2iSources).toEqual([{ path: 'D:\\vision\\source.png', name: 'source.png' }]);
    expect(patch.i2iPrompt).toBe('一名战国女将，身着甲胄…');
    expect(patch.t2iPrompt).toBe('');
    expect(patch.size).toBe('1024x1024');
    expect(patch.quality).toBe('high');
  });

  it('文生图：不带参考图，Prompt / 负面词进文生图表单', () => {
    const patch = resolveVisionCarryPatch(
      makeCarry({ generationMode: 't2i', sourceImagePath: 'D:/ref.png' }),
    );
    expect(patch.generationType).toBe('t2i');
    expect(patch.i2iSources).toEqual([]);
    expect(patch.t2iPrompt).toBe('一名战国女将，身着甲胄…');
    expect(patch.t2iNegative).toBe('低画质，模糊');
    expect(patch.i2iPrompt).toBe('');
  });

  it('图生图但缺失原图路径（防御）→ 回落文生图，不产生空参考图', () => {
    const patch = resolveVisionCarryPatch(makeCarry({ generationMode: 'i2i' }));
    expect(patch.generationType).toBe('i2i');
    expect(patch.i2iSources).toEqual([]);
  });
});

describe('buildGenerationCarry（V4.0.8 携带生成方式与原图）', () => {
  it('generationMode / sourceImagePath / sourceAssetId 进入携带草稿', () => {
    const state = initialRecreationState(
      { summary: '', fields: [] },
      '原始 Prompt',
      '原始负面',
    );
    const carry = buildGenerationCarry(state, {
      generationMode: 'i2i',
      sourceImagePath: 'D:/vision/ref.png',
      sourceAssetId: 'asset-9',
      sourceVisionTaskId: 'task-1',
      size: '1024x1024',
      quality: 'auto',
      count: 1,
    });
    expect(carry.generationMode).toBe('i2i');
    expect(carry.sourceImagePath).toBe('D:/vision/ref.png');
    expect(carry.sourceAssetId).toBe('asset-9');
    expect(carry.prompt).toBe('原始 Prompt');
    expect(carry.negativePrompt).toBe('原始负面');
    expect(carry.sourceVisionTaskId).toBe('task-1');
  });
});
