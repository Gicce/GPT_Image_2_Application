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
  it('图生图：原图成为参考图（复用路径不复制），Prompt 进编辑需求且前置图片使用说明，尺寸质量带过', () => {
    const patch = resolveVisionCarryPatch(
      makeCarry({ sourceImagePath: 'D:\\vision\\source.png', sourceAssetId: 'asset-1' }),
    );
    expect(patch.generationType).toBe('i2i');
    expect(patch.generationMode).toBe('single');
    expect(patch.i2iSources).toEqual([{ path: 'D:\\vision\\source.png', name: 'source.png' }]);
    // V4.0.9.1：最终 Prompt 前置确定性「图片使用说明」——gpt-image-2 收到的 prompt 必声明每张附图职责
    expect(patch.i2iPrompt).toContain('【图片使用说明（强制执行）】');
    expect(patch.i2iPrompt).toContain('图片1（@原图，画面模板）');
    expect(patch.i2iPrompt.endsWith('一名战国女将，身着甲胄…')).toBe(true);
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

// ===== V4.0.9.1 人物强替换：参考图角色清单 → 生成 payload（spec §10–§13） =====

describe('personReferenceSurvivesGenerationCarry（人物图全程存活）', () => {
  const refs = [
    { path: 'D:/vision/template.png', label: '原图', role: 'template' as const },
    { path: 'D:/vision/person.png', label: '人物参考', role: 'person_reference' as const },
  ];

  it('imageReferences 双图全部进入 i2iSources，顺序 = 模板 → 人物（= 提交顺序）', () => {
    const patch = resolveVisionCarryPatch(makeCarry({
      sourceImagePath: 'D:/vision/template.png',
      personReferencePath: 'D:/vision/person.png',
      imageReferences: refs,
      personReplacement: { enabled: true, clothingPolicy: 'preserve_original' },
    }));
    expect(patch.i2iSources.map(item => item.path)).toEqual([
      'D:/vision/template.png',
      'D:/vision/person.png',
    ]);
  });

  it('模板与人物路径不同（含大小写 / 分隔符差异）→ 两张都存活，绝不误删人物图', () => {
    const patch = resolveVisionCarryPatch(makeCarry({
      generationMode: 'i2i',
      imageReferences: [
        { path: 'D:\\vision\\Template.PNG', label: '原图', role: 'template' },
        { path: 'D:/vision/person.png', label: '人物参考', role: 'person_reference' },
      ],
      personReplacement: { enabled: true, clothingPolicy: 'preserve_original' },
    }));
    expect(patch.i2iSources).toHaveLength(2);
    expect(patch.i2iSources[0].path).toBe('D:\\vision\\Template.PNG');
    expect(patch.i2iSources[1].path).toBe('D:/vision/person.png');
  });

  it('同路径（模板 = 人物同一张图）→ 去重为一张（语义上无人物替换可言）', () => {
    const patch = resolveVisionCarryPatch(makeCarry({
      generationMode: 'i2i',
      imageReferences: [
        { path: 'D:/same/image.png', label: '原图', role: 'template' },
        { path: 'D:/same/image.png', label: '人物参考', role: 'person_reference' },
      ],
      personReplacement: { enabled: true, clothingPolicy: 'preserve_original' },
    }));
    expect(patch.i2iSources).toHaveLength(1);
  });

  it('旧 carry（仅 sourceImagePath + personReferencePath，无清单）→ 兼容回落双图', () => {
    const patch = resolveVisionCarryPatch(makeCarry({
      sourceImagePath: 'D:/old/ref.png',
      personReferencePath: 'D:/old/person.png',
    }));
    expect(patch.i2iSources.map(item => item.path)).toEqual(['D:/old/ref.png', 'D:/old/person.png']);
  });

  it('旧 carry 同一路径两种写法 → 不重复（归一化去重）', () => {
    const patch = resolveVisionCarryPatch(makeCarry({
      sourceImagePath: 'D:/old/Ref.PNG',
      personReferencePath: 'd:\\old\\ref.png',
    }));
    expect(patch.i2iSources).toHaveLength(1);
  });

  it('额外参考图（背景 / 泛化）随清单进入 payload 尾部（image[2...]）', () => {
    const patch = resolveVisionCarryPatch(makeCarry({
      generationMode: 'i2i',
      imageReferences: [
        { path: 'D:/t.png', label: '原图', role: 'template' },
        { path: 'D:/p.png', label: '人物参考', role: 'person_reference' },
        { path: 'D:/bg.png', label: '街景', role: 'background_reference' },
      ],
      personReplacement: { enabled: true, clothingPolicy: 'preserve_original' },
    }));
    expect(patch.i2iSources.map(item => item.path)).toEqual(['D:/t.png', 'D:/p.png', 'D:/bg.png']);
    expect(patch.i2iPrompt).toContain('图片3（@街景，背景参考）');
  });
});

describe('templateAndPersonReferenceBothReachImageGenerationPayload（确定性指令编译）', () => {
  it('人物替换开启 → i2iPrompt 前置图片使用说明：身份锚定图片2 + 排除图片1身份 + 服装来源分离', () => {
    const patch = resolveVisionCarryPatch(makeCarry({
      generationMode: 'i2i',
      imageReferences: [
        { path: 'D:/t.png', label: '原图', role: 'template' },
        { path: 'D:/p.png', label: '人物参考', role: 'person_reference' },
      ],
      personReplacement: { enabled: true, clothingPolicy: 'preserve_original' },
    }));
    expect(patch.i2iPrompt).toContain('【图片使用说明（强制执行）】');
    expect(patch.i2iPrompt).toContain('图片2（@人物参考，人物身份参考）');
    expect(patch.i2iPrompt).toContain('主体人物必须整体替换为该图中的人物');
    expect(patch.i2iPrompt).toContain('不得保留画面模板图原人物的脸部身份或面部特征');
    expect(patch.i2iPrompt).toContain('绝不代表保留图片1的人物');
    // 优化后 Prompt 原文保留在指令块之后
    expect(patch.i2iPrompt.endsWith('一名战国女将，身着甲胄…')).toBe(true);
  });

  it('负面提示词追加「模板图原人物脸部身份」排斥项（i2i 专用通道）', () => {
    const patch = resolveVisionCarryPatch(makeCarry({
      generationMode: 'i2i',
      imageReferences: [
        { path: 'D:/t.png', label: '原图', role: 'template' },
        { path: 'D:/p.png', label: '人物参考', role: 'person_reference' },
      ],
      personReplacement: { enabled: true, clothingPolicy: 'use_subject_reference' },
    }));
    expect(patch.i2iNegative).toContain('画面模板图原人物的脸部身份、五官与面部特征');
    expect(patch.i2iNegative).toContain('低画质，模糊'); // 原负面词保留
    // use_subject_reference 服装行：身份与服装都来自人物参考
    expect(patch.i2iPrompt).toContain('身份与服装都来自人物参考图');
  });

  it('无人物替换 → 指令块只声明模板职责，不含强替换语义；负面词不追加', () => {
    const patch = resolveVisionCarryPatch(makeCarry({
      sourceImagePath: 'D:/t.png',
    }));
    expect(patch.i2iPrompt).toContain('图片1（@原图，画面模板）');
    expect(patch.i2iPrompt).not.toContain('强制条件');
    expect(patch.i2iNegative).toBe('低画质，模糊');
  });

  it('文生图（用户显式选择）→ 不带参考图、不附加指令块', () => {
    const patch = resolveVisionCarryPatch(makeCarry({
      generationMode: 't2i',
      sourceImagePath: 'D:/t.png',
      personReferencePath: 'D:/p.png',
      imageReferences: [
        { path: 'D:/t.png', label: '原图', role: 'template' },
        { path: 'D:/p.png', label: '人物参考', role: 'person_reference' },
      ],
      personReplacement: { enabled: true, clothingPolicy: 'preserve_original' },
    }));
    expect(patch.i2iSources).toEqual([]);
    expect(patch.t2iPrompt).toBe('一名战国女将，身着甲胄…');
    expect(patch.t2iPrompt).not.toContain('图片使用说明');
  });
});
