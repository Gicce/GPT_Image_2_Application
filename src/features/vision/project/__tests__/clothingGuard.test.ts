/**
 * Clothing Source Guard 回归（本轮验收 E1-E5）：
 * 「服装来自人物参考图」时，模板服装元素不得经任何通道回灌最终 Prompt。
 *
 * 用户案例（模板=黑暗系动漫混合图，人物参考=白裙女生，只改人物+服装来源）：
 * 最终 Prompt 不得再出现 黑色露肩上衣 / 链条 / 腿环 / 高筒靴 / S形徽章 /
 * 黑暗系 等模板服装元素；动漫层服装只做媒介转换。
 */

import { describe, expect, it } from 'vitest';
import type { GenerationImageReference } from '../../../../types';
import type { VisualProject } from '../types';
import { createVisualProjectFromAnalysis, normalizeModificationContract } from '../project';
import { emptyWorkspace, fixtureAnalysis } from './fixtures';
import { mergeFinalGenerationPrompt } from '../promptCompiler';
import { buildOptimizerHardContractLines } from '../optimizerContract';
import { buildGenerationNegativeAddendum } from '../../generationDirective';
import {
  CLOTHING_CONFLICT_ERROR,
  clothingSourceIsPersonReference,
  extractTemplateClothingTokens,
  guardClothingInDescription,
  sanitizeClothingFromBaseline,
  validateFinalPromptClothingConflict,
} from '../clothingGuard';

function darkTemplateAnalysis() {
  return {
    ...fixtureAnalysis(),
    summary: '真人女性与动漫女孩的混合媒介作品',
    subjects: [
      {
        label: '真人女性',
        count: 1,
        appearance: ['长发'],
        pose: '蹲姿',
        action: null,
        position: { x: 0.05, y: 0.35, width: 0.45, height: 0.6 },
        clothing: ['黑色露肩上衣', '高腰短裙', '项圈', '金属链条', '腿环', '马丁靴'],
        relations: [],
      },
      {
        label: '动漫女孩',
        count: 1,
        appearance: ['紫发双马尾'],
        pose: '站立姿势',
        action: null,
        position: { x: 0.55, y: 0.1, width: 0.4, height: 0.85 },
        clothing: ['黑暗系水手服', 'S形徽章'],
        relations: [],
      },
    ],
    style: {
      category: '动漫插画',
      medium: '混合媒介',
      rendering: '黑暗系朋克风，金属链条与高筒靴装饰',
    },
    media_structure: {
      overall_mode: 'mixed_media',
      preserve_template_media_structure: true,
      regions: [
        { label: '真人层（真人女性）', semantic_role: 'primary_subject', rendering_mode: 'photorealistic', identity_relation: 'template_identity' },
        { label: '动漫女孩', semantic_role: 'anime_counterpart', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary' },
      ],
    },
  } as never;
}

function personClothingProject(policy: 'use_subject_reference' | 'preserve_original' | 'custom' = 'use_subject_reference'): VisualProject {
  const analysis = darkTemplateAnalysis();
  const workspace = emptyWorkspace(analysis);
  const project = createVisualProjectFromAnalysis({
    name: '黑暗系模板',
    analysis,
    plan: workspace.recreation!.plan,
    recreation: workspace.recreation!,
    sourceAsset: { path: 'D:/imgs/dark.png', assetId: 'asset-dark', source: 'gallery' },
    workspace,
  });
  const modification = normalizeModificationContract({
    freeText: '',
    activeDimensions: policy === 'preserve_original' ? ['subject'] : ['subject', 'clothing'],
    person: {
      enabled: true,
      source: 'local',
      path: 'D:/imgs/white-dress.png',
      label: '人物参考',
      strength: 'strict',
      replaceScope: 'whole_person',
      preserveTemplateIdentity: false,
      applyIdentityTo: 'all_corresponding_subjects',
    },
    clothingPolicy: policy,
    customClothing: '',
    replicationBoost: false,
    mentions: [],
    extraImageRefs: [],
  });
  return { ...project, modification };
}

const IMAGE_REFS: GenerationImageReference[] = [
  { path: 'D:/imgs/dark.png', label: '原图', role: 'template' },
  { path: 'D:/imgs/white-dress.png', label: '人物参考', role: 'person_reference' },
];

const DARK_WORDS = ['黑色露肩上衣', '金属链条', '腿环', '马丁靴', 'S形徽章', '黑暗系'];

function compileWith(project: VisualProject, finalDescription: string) {
  return mergeFinalGenerationPrompt({
    project,
    finalDescription,
    imageReferences: IMAGE_REFS,
    personReplacementEnabled: true,
  });
}

describe('E1 服装来源唯一事实源判定', () => {
  it('use_subject_reference + clothing 维度启用 ⇒ 守卫生效', () => {
    expect(clothingSourceIsPersonReference(personClothingProject())).toBe(true);
  });
  it('preserve_original / custom ⇒ 守卫不生效（用户显式选择）', () => {
    expect(clothingSourceIsPersonReference(personClothingProject('preserve_original'))).toBe(false);
    expect(clothingSourceIsPersonReference(personClothingProject('custom'))).toBe(false);
  });
});

describe('令牌提取（有界词表 + 服装维度动态令牌）', () => {
  it('服装基线动态令牌 + 风格行命中词表（黑暗系 / 高筒靴）都被提取', () => {
    const tokens = extractTemplateClothingTokens(personClothingProject());
    for (const word of ['黑色露肩上衣', '金属链条', '腿环', '马丁靴', 'S形徽章', '黑暗系', '高筒靴']) {
      expect(tokens).toContain(word);
    }
  });
  it('subject 维度身份词不进令牌（真人女性 / 动漫女孩 不被误伤）', () => {
    const tokens = extractTemplateClothingProjects();
    expect(tokens).not.toContain('真人女性');
    expect(tokens).not.toContain('动漫女孩');
  });
});

function extractTemplateClothingProjects(): string[] {
  return extractTemplateClothingTokens(personClothingProject());
}

describe('基线净化（模板保留合同 / 媒介层行）', () => {
  it('剥离服装令牌且保留非服装内容', () => {
    const line = '- 风格：动漫插画，黑暗系朋克风，金属链条与高筒靴装饰，写实渲染';
    const { text, removed } = sanitizeClothingFromBaseline(line, ['黑暗系', '金属链条', '高筒靴']);
    expect(removed).toEqual(['黑暗系', '金属链条', '高筒靴']);
    expect(text).toContain('动漫插画');
    expect(text).toContain('写实渲染');
    expect(text).not.toContain('黑暗系');
  });
});

describe('E5 最终画面描述守卫（逐句剥离）', () => {
  it('携带模板服装元素的句子被删除，其余句子保留', () => {
    const description = '人物替换为白裙女生，气质温柔。她佩戴金属链条和腿环。背景保持室内场景。';
    const { text, removedSentences } = guardClothingInDescription(description, ['金属链条', '腿环']);
    expect(removedSentences.length).toBe(1);
    expect(removedSentences[0]).toContain('金属链条');
    expect(text).toContain('白裙女生');
    expect(text).toContain('背景保持室内场景');
    expect(text).not.toContain('腿环');
  });
});

describe('编译器集成（用户案例：只改人物 + 服装来自人物参考）', () => {
  it('最终 Prompt 不含任何模板服装元素（六词全零命中）+ conflicts 恒空', () => {
    const compiled = compileWith(
      personClothingProject(),
      '人物替换为白裙女生，穿着人物参考图中的白色连衣裙，气质温柔。',
    );
    for (const word of DARK_WORDS) {
      expect(compiled.prompt).not.toContain(word);
    }
    expect(compiled.clothingConflicts).toEqual([]);
  });

  it('优化器把模板服装写回最终画面描述 ⇒ 守卫逐句剥离 + clothingGuard 记录', () => {
    const compiled = compileWith(
      personClothingProject(),
      '人物替换完成。动漫女孩保留黑色露肩上衣与金属链条的黑暗系穿搭以维持观感。白裙温柔。',
    );
    expect(compiled.prompt).not.toContain('黑色露肩上衣');
    expect(compiled.prompt).not.toContain('金属链条');
    expect(compiled.clothingGuard?.removedSentences.length).toBeGreaterThanOrEqual(1);
    expect(compiled.prompt).toContain('白裙温柔');
  });

  it('E3 媒介转换：same_as_primary 动漫层只做媒介转换，不保留模板服装配饰', () => {
    const compiled = compileWith(personClothingProject(), '人物替换完成。');
    const renderingBlock = compiled.sectionBlocks.find(block => block.name === 'rendering');
    expect(renderingBlock?.text).toContain('转换为本媒介的呈现方式');
    expect(renderingBlock?.text).toContain('禁止恢复模板原服装');
  });

  it('preserve_original ⇒ 守卫不生效：风格基线原样保留 + 服装沿用合同存在', () => {
    const compiled = compileWith(personClothingProject('preserve_original'), '人物替换完成。');
    expect(compiled.prompt).toContain('服装沿用');
    expect(compiled.prompt).not.toContain('服装与配饰一律以人物参考图为准');
    expect(compiled.clothingConflicts).toEqual([]);
    expect(compiled.clothingGuard).toBeUndefined();
  });

  it('E4 兜底校验器：手工构造含模板服装的文本会被点名', () => {
    const offenders = validateFinalPromptClothingConflict(
      '【最终画面描述】她穿着黑色露肩上衣微笑。',
      ['黑色露肩上衣'],
    );
    expect(offenders.length).toBe(1);
    expect(offenders[0]).toContain('黑色露肩上衣');
  });
});

describe('E2/E3 上下游配套', () => {
  it('优化器硬合同含「服装反回灌」行（含具体令牌）', () => {
    const lines = buildOptimizerHardContractLines(personClothingProject());
    const line = lines.find(item => item.includes('服装反回灌'));
    expect(line).toBeTruthy();
    expect(line!).toContain('媒介转换');
  });
  it('负面追加词含模板服装令牌（双通道排斥）', () => {
    const addendum = buildGenerationNegativeAddendum({
      imageReferences: IMAGE_REFS,
      personReplacementEnabled: true,
      clothingPolicy: 'use_subject_reference',
      templateClothingTokens: ['黑色露肩上衣', '金属链条'],
    });
    expect(addendum).toContain('模板服装与配饰');
    expect(addendum).toContain('黑色露肩上衣');
  });
});

describe('报错文案（E4 指定）', () => {
  it('阻断文案与验收口径一致', () => {
    expect(CLOTHING_CONFLICT_ERROR).toContain('检测到服装来源冲突');
    expect(CLOTHING_CONFLICT_ERROR).toContain('服装来自人物参考图');
  });
});
