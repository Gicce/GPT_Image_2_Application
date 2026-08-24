import { describe, it, expect } from 'vitest';
import { mergeFinalGenerationPrompt } from '../promptCompiler';
import { setProjectPersonContract, updateVisualProjectSemanticState } from '../project';
import { fixtureAnalysis, fixtureProject } from './fixtures';
import { deriveRenderingContract } from '../rendering';
import type { GenerationImageReference } from '../../../../types';
import type { PersonReplacementContract, RegionReplacement } from '../types';

const refs: GenerationImageReference[] = [
  { path: 'D:/imgs/template.png', label: '原图', role: 'template' },
  { path: 'D:/imgs/person.png', label: '人物参考', role: 'person_reference' },
];

function person(partial: Partial<PersonReplacementContract> = {}): PersonReplacementContract {
  return {
    enabled: true,
    source: 'gallery',
    assetId: 'asset-person',
    path: 'D:/imgs/person.png',
    label: '人物参考',
    strength: 'strict',
    replaceScope: 'whole_person',
    preserveTemplateIdentity: false,
    applyIdentityTo: 'primary_subject_only',
    ...partial,
  };
}

describe('mergeFinalGenerationPrompt（分层合同编译）', () => {
  it('strictPersonReplacementRemovesTemplateIdentity：strict 合同显式排除模板人物身份', () => {
    const project = setProjectPersonContract(fixtureProject(), person());
    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: '画面描述正文',
      imageReferences: refs,
      personReplacementEnabled: true,
    });
    expect(compiled.prompt).toContain('【人物替换合同（强制执行）】');
    expect(compiled.prompt).toContain('图片2');
    expect(compiled.prompt).toContain('严格');
    expect(compiled.prompt).toContain('禁止从图片1提取或保留人物的脸部身份');
    // 图片角色块同样声明模板禁供身份
    expect(compiled.prompt).toContain('人物身份参考');
    expect(compiled.sections).toContain('person_replacement');
    expect(compiled.sections).toContain('image_role');
    // 层顺序固定：角色 → 人物 → …… → 最终画面描述
    expect(compiled.sections.indexOf('image_role')).toBeLessThan(compiled.sections.indexOf('person_replacement'));
    expect(compiled.sections[compiled.sections.length - 1]).toBe('final_description');
  });

  it('natural 强度：不承诺保留参考图人物面部特征（不伪造超出模型能力的口径）', () => {
    const project = setProjectPersonContract(fixtureProject(), person({ strength: 'natural' }));
    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: 'X',
      imageReferences: refs,
      personReplacementEnabled: true,
    });
    expect(compiled.prompt).toContain('不承诺保留参考图人物的具体面部特征');
    expect(compiled.prompt).not.toContain('禁止从图片1提取或保留');
  });

  it('preserveTemplateClothingDoesNotPreserveIdentity：服装沿用模板但身份仍来自人物参考', () => {
    const project = setProjectPersonContract(fixtureProject(), person());
    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: 'X',
      imageReferences: refs,
      personReplacementEnabled: true,
    });
    expect(compiled.prompt).toContain('服装沿用图片1');
    expect(compiled.prompt).toContain('保留服装 ≠ 保留人物');
    expect(compiled.prompt).toContain('人物身份、面部、发型仍必须来自图片2');
  });

  it('hybridMediaKeepsPhotoSubjectPhotorealistic：混合媒介合同禁止整图统一媒介', () => {
    let project = fixtureProject();
    const mixed = deriveRenderingContract(fixtureAnalysis({
      mediaStructure: {
        overall_mode: 'mixed_media',
        regions: [
          { label: '真人主体', semantic_role: 'primary_subject', rendering_mode: 'photorealistic', identity_relation: 'person_reference' },
          { label: '动漫对应角色', semantic_role: 'anime_counterpart', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary' },
        ],
      },
    }));
    project = updateVisualProjectSemanticState(project, 'rendering_contract', draft => ({
      ...draft,
      renderingContract: mixed,
    }));
    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: 'X',
      imageReferences: refs,
      personReplacementEnabled: true,
    });
    expect(compiled.prompt).toContain('【媒介结构合同（混合媒介，强制执行）】');
    expect(compiled.prompt).toContain('禁止整图统一成单一媒介');
    expect(compiled.prompt).toContain('真人主体');
    expect(compiled.prompt).toContain('真人摄影');
    expect(compiled.prompt).toContain('动漫插画');
    expect(compiled.prompt).toContain('与主体人物为同一人物');
  });

  it('styleChangeDoesNotChangeRenderingMode：风格方向只改表达，媒介层模式不变', () => {
    let project = fixtureProject();
    const mixed = deriveRenderingContract(fixtureAnalysis({
      mediaStructure: {
        overall_mode: 'mixed_media',
        regions: [
          { label: '真人主体', semantic_role: 'primary_subject', rendering_mode: 'photorealistic', identity_relation: 'person_reference' },
          { label: '动漫对应角色', semantic_role: 'anime_counterpart', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary' },
        ],
      },
    }));
    project = { ...project, renderingContract: mixed };
    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: 'X',
      imageReferences: refs,
      personReplacementEnabled: false,
      styleDirection: '赛博朋克',
    });
    expect(compiled.prompt).toContain('赛博朋克');
    expect(compiled.prompt).toContain('绝不改变各层的媒介类型');
    expect(compiled.prompt).toContain('真人主体');
    expect(compiled.prompt).toContain('动漫插画');
  });

  it('区域合同：位置语言 + 人物参考绑定 + 区域外保持模板', () => {
    let project = fixtureProject();
    const region: RegionReplacement = {
      id: 'region-1',
      name: '区域 1',
      shape: { kind: 'rect', x: 0.02, y: 0.1, w: 0.3, h: 0.6 },
      replaceType: 'person',
      personReferenceId: 'ref-1',
      constraintStrength: 'strict',
      replaceScope: 'face',
      enabled: true,
      createdAt: new Date().toISOString(),
      maskPath: 'D:/masks/region-1.png',
    };
    project = updateVisualProjectSemanticState(project, 'regions', draft => ({
      ...draft,
      regions: [region],
      references: [{ id: 'ref-1', path: 'D:/imgs/person.png', label: '人物参考', kind: 'person', source: 'local_import' }],
    }));
    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: 'X',
      imageReferences: refs,
      personReplacementEnabled: false,
    });
    expect(compiled.prompt).toContain('【区域编辑合同（共 1 个区域）】');
    expect(compiled.prompt).toContain('区域1（区域 1）');
    expect(compiled.prompt).toContain('左侧');
    expect(compiled.prompt).toContain('替换对象=@人物参考');
    expect(compiled.prompt).toContain('范围=脸部');
    expect(compiled.prompt).toContain('区域外画面严格保持画面模板不变');
  });

  it('templateAndPersonReferenceSurviveCarry（编译输入的角色清单稳定：模板 0 → 人物 1）', () => {
    const project = setProjectPersonContract(fixtureProject(), person());
    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: 'X',
      imageReferences: refs,
      personReplacementEnabled: true,
    });
    // 图片使用说明按提交顺序声明两张图（模板=图片1、人物=图片2）
    const roleBlock = compiled.prompt.split('\n').filter(line => line.startsWith('- 图片'));
    expect(roleBlock).toHaveLength(2);
    expect(roleBlock[0]).toContain('画面模板');
    expect(roleBlock[1]).toContain('人物身份参考');
  });

  it('无参考图（纯文生图）不产出角色 / 人物层', () => {
    const project = fixtureProject();
    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: '纯文生图描述',
      imageReferences: [],
      personReplacementEnabled: false,
    });
    expect(compiled.sections).not.toContain('image_role');
    expect(compiled.sections).not.toContain('person_replacement');
    expect(compiled.prompt).toContain('纯文生图描述');
  });

  it('负面词单独返回（模板人物身份排斥进 negativePrompt，不进 prompt 正文）', () => {
    const project = setProjectPersonContract(fixtureProject(), person());
    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: 'X',
      imageReferences: refs,
      personReplacementEnabled: true,
      negativePrompt: '低画质',
      negativeAddendum: '画面模板图原人物的脸部身份、五官与面部特征',
    });
    expect(compiled.negativePrompt).toContain('低画质');
    expect(compiled.negativePrompt).toContain('画面模板图原人物的脸部身份');
    expect(compiled.prompt).not.toContain('低画质');
  });
});
