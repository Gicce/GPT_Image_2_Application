import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildImageReferencesBlock,
  collectOptimizerImageReferences,
  describeOptimizerImageReference,
} from '../promptOptimizer';

/**
 * V4.0.9 双图角色语义：优化器必须真实收到「图二模板 + 图三人物」两张图
 * （multimodal image parts），且清单 ↔ parts 顺序稳定映射；绝不只当文字。
 */
const OPTIMIZER_SRC = readFileSync(fileURLToPath(new URL('../promptOptimizer.ts', import.meta.url)), 'utf8');

describe('优化器图片引用汇总（模板图 + 人物图去重、顺序稳定）', () => {
  it('图二模板 + 图三人物：模板在前、人物在后（顺序 = image parts 顺序）', () => {
    const refs = collectOptimizerImageReferences({
      personReferencePath: 'D:/imgs/图三.png',
      imageReferences: [
        { path: 'D:/imgs/图二.png', label: '原图', role: 'template_reference' },
        { path: 'D:/imgs/图三.png', label: '图三.png', role: 'person_replacement_reference' },
      ],
    });
    expect(refs.map(ref => ref.role)).toEqual(['template_reference', 'person_replacement_reference']);
  });

  it('同路径去重（路径归一：反斜杠 / 大小写不敏感）', () => {
    const refs = collectOptimizerImageReferences({
      personReferencePath: 'd:/imgs/图三.png',
      imageReferences: [
        { path: 'D:\\Imgs\\图三.PNG', label: '图三', role: 'person_replacement_reference' },
      ],
    });
    expect(refs.length).toBe(1);
  });

  it('personReferencePath 旧参数单独可用（兼容：仅人物图）', () => {
    const refs = collectOptimizerImageReferences({ personReferencePath: 'D:/p.png' });
    expect(refs).toEqual([{ path: 'D:/p.png', label: '人物参考图', role: 'person_replacement_reference' }]);
  });

  it('空输入 → 空清单（纯文本优化不受影响）', () => {
    expect(collectOptimizerImageReferences({})).toEqual([]);
  });
});

describe('图片引用清单文本块（模型按角色使用图片）', () => {
  it('图二 / 图三标注各自角色与用途（清单顺序 = 图片序号）', () => {
    const block = buildImageReferencesBlock([
      { path: 'D:/imgs/图二.png', label: '原图', role: 'template_reference' },
      { path: 'D:/imgs/图三.png', label: '图三.png', role: 'person_replacement_reference' },
    ]);
    expect(block).toContain('共 2 张');
    expect(block).toContain('图片1（@原图）：画面模板');
    expect(block).toContain('延续其画风、视觉氛围、构图与背景关系');
    expect(block).toContain('图片2（@图三.png）：人物身份参考（主体人物身份唯一主来源）');
    expect(block).toContain('身份、脸部五官、脸型、发型、体型');
    expect(block).toContain('画面模板图原人物的脸部身份不得保留');
  });

  it('角色标注文案覆盖全部角色（无 undefined 泄漏）', () => {
    const roles = [
      'template_reference',
      'source_reference',
      'person_replacement_reference',
      'generated_result_reference',
      'background_reference',
      'generic_reference',
    ] as const;
    for (const role of roles) {
      expect(describeOptimizerImageReference(role)).toBeTruthy();
      expect(describeOptimizerImageReference(role)).not.toContain('undefined');
    }
  });

  it('空清单 → 空字符串（不附加无用段落）', () => {
    expect(buildImageReferencesBlock([])).toBe('');
  });
});

describe('多模态 parts 装配契约（源码断言：图二图三真实进入 payload）', () => {
  it('优化器具备视觉能力时：每张引用各附一个 image_url part，与清单一一对应', () => {
    // kept 序列映射为 parts：[text, image, image, ...]
    expect(OPTIMIZER_SRC).toContain("parts: [");
    expect(OPTIMIZER_SRC).toMatch(/part_type: 'image_url', image_url: entry\.url/);
    expect(OPTIMIZER_SRC).toMatch(/\{ part_type: 'text', text: userContent \}/);
    // 读取失败的图不进清单（清单 ↔ parts 永不失配）
    expect(OPTIMIZER_SRC).toContain('readResults');
    expect(OPTIMIZER_SRC).toMatch(/filter\(\(entry\): entry is .* => !!entry\.url\)/);
  });

  it('系统提示词含双图角色规则（模板图风格延续 + 人物图仅身份特征）', () => {
    expect(OPTIMIZER_SRC).toContain('画面模板图（延续其画风、视觉氛围、构图与背景关系');
    expect(OPTIMIZER_SRC).toContain('不得把模板图风格替换成人物参考图的写实风格');
  });

  it('规则 6b：人物替换为强制条件（无模型裁量）+ 最终 Prompt 必含图片使用说明', () => {
    expect(OPTIMIZER_SRC).toContain('6b. 人物替换是用户的显式业务动作，属于强制条件而非建议');
    expect(OPTIMIZER_SRC).toContain('你无权裁决「是否替换人物」');
    expect(OPTIMIZER_SRC).toContain('不得保留画面模板图原人物的脸部身份或面部特征');
    expect(OPTIMIZER_SRC).toContain('positive_prompt 开头必须包含「图片使用说明」段');
    expect(OPTIMIZER_SRC).toContain('保留服装 ≠ 保留人物');
    expect(OPTIMIZER_SRC).toContain('绝不作用于人物身份');
  });

  it('多模态判定只看 capabilities（禁止按模型名称猜）', () => {
    expect(OPTIMIZER_SRC).toContain("capabilities ?? []).includes('vision')");
  });
});
