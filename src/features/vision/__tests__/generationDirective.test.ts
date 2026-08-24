/**
 * Generation Directive（V4.0.9.1 人物强替换）专项测试：
 * 提交 gpt-image-2 的最终 Prompt 必须确定性声明——
 *  - 人物身份唯一主来源 = 人物参考图（强制替换，无模型裁量）；
 *  - 模板图原人物身份被显式排除（模板只负责构图 / 风格 / 背景 / 氛围）；
 *  - 服装三态分别编译身份 / 服装来源（保留服装 ≠ 保留人物）；
 *  - 负面提示词追加模板人物身份排斥项。
 */

import { describe, expect, it } from 'vitest';
import {
  appendNegativeAddendum,
  buildGenerationImageDirective,
  buildGenerationNegativeAddendum,
  type GenerationDirectiveInput,
} from '../generationDirective';
import type { GenerationImageReference } from '../../../types';

const TEMPLATE: GenerationImageReference = { path: 'D:/imgs/template.png', label: '原图', role: 'template' };
const PERSON: GenerationImageReference = { path: 'D:/imgs/person.png', label: '人物参考', role: 'person_reference' };

function dualInput(overrides: Partial<GenerationDirectiveInput> = {}): GenerationDirectiveInput {
  return {
    imageReferences: [TEMPLATE, PERSON],
    personReplacementEnabled: true,
    clothingPolicy: 'preserve_original',
    ...overrides,
  };
}

describe('strictPersonReplacementUsesPersonReferenceIdentity（人物参考 = 身份唯一主来源）', () => {
  it('指令块声明图片序号、角色与身份归属；模板图行被禁止提供人物身份', () => {
    const directive = buildGenerationImageDirective(dualInput());
    expect(directive).toContain('【图片使用说明（强制执行）】');
    expect(directive).toContain('随请求附上 2 张图片');
    expect(directive).toContain('图片1（@原图，画面模板）');
    expect(directive).toContain('图片2（@人物参考，人物身份参考）');
    expect(directive).toContain('主体人物身份的唯一主来源');
    expect(directive).toContain('必须以该图为准');
    // 强制替换语义（spec §7 三句等价语义齐备）
    expect(directive).toContain('主体人物必须整体替换为该图中的人物');
    expect(directive).toContain('不得保留画面模板图原人物的脸部身份或面部特征');
    expect(directive).toContain('画面模板图仅用于画面布局、风格、背景与整体视觉参考');
  });

  it('身份字段覆盖：脸部身份 / 五官 / 脸型 / 发型 / 外貌全部锚定到人物参考图', () => {
    const directive = buildGenerationImageDirective(dualInput());
    for (const term of ['脸部身份', '五官', '脸型', '发型', '人物外貌']) {
      expect(directive).toContain(term);
    }
  });
});

describe('templateDoesNotPreserveSubjectIdentityWhenReplacingPerson（模板身份排除）', () => {
  it('模板图行显式禁止提供人物身份；无人物替换时模板行不携带禁令（语义不越界）', () => {
    const replacing = buildGenerationImageDirective(dualInput());
    const templateLine = replacing.split('\n').find(line => line.startsWith('- 图片1'))!;
    expect(templateLine).toContain('禁止从该图提取或保留人物的脸部身份');

    const noPerson = buildGenerationImageDirective({
      imageReferences: [TEMPLATE],
      personReplacementEnabled: false,
      clothingPolicy: 'preserve_original',
    });
    expect(noPerson).toContain('画面模板');
    expect(noPerson).not.toContain('禁止从该图提取或保留');
    expect(noPerson).not.toContain('人物替换（强制条件');
  });

  it('人物参考图缺失时（仅模板）不产出强替换语义（禁止伪造身份来源）', () => {
    const directive = buildGenerationImageDirective({
      imageReferences: [TEMPLATE],
      personReplacementEnabled: true,
      clothingPolicy: 'preserve_original',
    });
    expect(directive).not.toContain('人物身份参考');
    expect(directive).not.toContain('强制条件');
  });
});

describe('preserveOriginalClothingDoesNotPreserveOriginalIdentity（服装 / 身份分离）', () => {
  it('preserve_original：服装沿用模板图，但显式声明「绝不代表保留模板图人物」', () => {
    const directive = buildGenerationImageDirective(dualInput({ clothingPolicy: 'preserve_original' }));
    expect(directive).toContain('服装规则：服装 / 服装设计沿用图片1（画面模板）的服装');
    expect(directive).toContain('仅限于服装本身');
    expect(directive).toContain('绝不代表保留图片1的人物');
    expect(directive).toContain('人物身份、面部、发型仍必须来自图片2（人物身份参考）');
  });

  it('use_subject_reference：身份与服装都来自人物参考图', () => {
    const directive = buildGenerationImageDirective(dualInput({ clothingPolicy: 'use_subject_reference' }));
    expect(directive).toContain('服装 / 造型同样以图片2（人物身份参考）为准');
    expect(directive).toContain('身份与服装都来自人物参考图');
  });

  it('custom：服装按自定义描述，身份仍锚定人物参考图', () => {
    const directive = buildGenerationImageDirective(dualInput({
      clothingPolicy: 'custom',
      customClothing: '红色晚礼服',
    }));
    expect(directive).toContain('服装 / 造型按自定义描述执行——红色晚礼服');
    expect(directive).toContain('人物身份仍必须来自图片2（人物身份参考）');
  });

  it('三态编译产物互不相同（不同策略必须产生不同指令）', () => {
    const preserve = buildGenerationImageDirective(dualInput({ clothingPolicy: 'preserve_original' }));
    const subject = buildGenerationImageDirective(dualInput({ clothingPolicy: 'use_subject_reference' }));
    const custom = buildGenerationImageDirective(dualInput({ clothingPolicy: 'custom', customClothing: '校服' }));
    expect(new Set([preserve, subject, custom]).size).toBe(3);
  });
});

describe('负面提示词追加项（双通道排斥模板人物身份）', () => {
  it('人物替换开启 → 追加模板人物脸部身份排斥项；关闭 / 无人物图 → 空', () => {
    expect(buildGenerationNegativeAddendum(dualInput()))
      .toBe('画面模板图原人物的脸部身份、五官与面部特征');
    expect(buildGenerationNegativeAddendum(dualInput({ personReplacementEnabled: false }))).toBe('');
    expect(buildGenerationNegativeAddendum({
      imageReferences: [TEMPLATE],
      personReplacementEnabled: true,
      clothingPolicy: 'preserve_original',
    })).toBe('');
  });

  it('appendNegativeAddendum：拼接去重（不重复追加）', () => {
    expect(appendNegativeAddendum('', '项A')).toBe('项A');
    expect(appendNegativeAddendum('低画质', '项A')).toBe('低画质，项A');
    expect(appendNegativeAddendum('低画质，项A', '项A')).toBe('低画质，项A');
    expect(appendNegativeAddendum('低画质', '')).toBe('低画质');
  });
});

describe('额外参考图角色（image[2...]）', () => {
  it('背景 / 风格 / 泛化参考各自编译职责行，且不作为人物身份来源', () => {
    const directive = buildGenerationImageDirective({
      imageReferences: [
        TEMPLATE,
        PERSON,
        { path: 'D:/imgs/bg.png', label: '街景', role: 'background_reference' },
        { path: 'D:/imgs/style.png', label: '水彩', role: 'style_reference' },
        { path: 'D:/imgs/any.png', label: '杂物图', role: 'generic_reference' },
      ],
      personReplacementEnabled: true,
      clothingPolicy: 'preserve_original',
    });
    expect(directive).toContain('随请求附上 5 张图片');
    expect(directive).toContain('图片3（@街景，背景参考）：仅提供背景 / 环境参照，不提供人物身份');
    expect(directive).toContain('图片4（@水彩，风格参考）：仅提供画风 / 视觉风格参照，不提供人物身份');
    expect(directive).toContain('图片5（@杂物图，参考图）：按正文的引用语境使用，不作为人物身份来源');
  });

  it('空参考图清单 → 空指令（纯文生图不污染）', () => {
    expect(buildGenerationImageDirective({
      imageReferences: [],
      personReplacementEnabled: true,
      clothingPolicy: 'preserve_original',
    })).toBe('');
  });
});
