import { describe, it, expect } from 'vitest';
import { resolveVisionCarryPatch } from '../../carryApply';
import { buildGenerationCarry, initialRecreationState, buildRecreationPlan } from '../../recreationPlan';
import { buildGenerationProvenance, resolveGenerationImageReferences } from '../../generationProvenance';
import { buildVisionRecreationUserContent } from '../../../../services/promptOptimizer';
import { EMPTY_MODIFICATION_DRAFT } from '../../modificationIntent';
import { setProjectPersonContract, updateVisualProjectSemanticState } from '../project';
import { fixtureAnalysis, fixtureProject } from './fixtures';
import type { VisualProject } from '../types';
import type { GenerationProvenanceSnapshot } from '../../../../types';

const refs = [
  { path: 'D:/imgs/template.png', label: '原图', role: 'template' as const },
  { path: 'D:/imgs/person.png', label: '人物参考', role: 'person_reference' as const },
];

describe('resolveVisionCarryPatch × promptCompiled（V4.1 编译器接管，禁止双份指令）', () => {
  const baseCarry = {
    prompt: '已编译 Prompt 正文',
    negativePrompt: '低画质',
    generationMode: 'i2i' as const,
    imageReferences: refs,
    personReplacement: { enabled: true, clothingPolicy: 'preserve_original' },
  };

  it('promptCompiled=true：不再前置图片使用说明（正文原样），mask 路径透传', () => {
    const patch = resolveVisionCarryPatch({
      ...baseCarry,
      promptCompiled: true,
      maskImagePath: 'D:/masks/combined.png',
    });
    expect(patch.i2iPrompt).toBe('已编译 Prompt 正文');
    expect(patch.i2iPrompt).not.toContain('【图片使用说明（强制执行）】');
    expect(patch.i2iSources.map(item => item.path)).toEqual(['D:/imgs/template.png', 'D:/imgs/person.png']);
    expect(patch.maskImagePath).toBe('D:/masks/combined.png');
    // 已编译：负面词不重复追加（编译器负责）
    expect(patch.i2iNegative).toBe('低画质');
  });

  it('promptCompiled 缺省（旧 carry）：维持既有前置指令行为（兼容）', () => {
    const patch = resolveVisionCarryPatch(baseCarry);
    expect(patch.i2iPrompt).toContain('【图片使用说明（强制执行）】');
    expect(patch.i2iPrompt.endsWith('已编译 Prompt 正文')).toBe(true);
    expect(patch.i2iNegative).toContain('画面模板图原人物的脸部身份');
  });

  it('generationPayloadKeepsStableReferenceOrder：角色清单顺序 = 提交顺序（模板 → 人物）', () => {
    const patch = resolveVisionCarryPatch({ ...baseCarry, promptCompiled: true });
    expect(patch.i2iSources[0].path).toBe('D:/imgs/template.png');
    expect(patch.i2iSources[1].path).toBe('D:/imgs/person.png');
  });
});

describe('buildGenerationCarry V2（项目字段 + 编译标记 + mask）', () => {
  it('projectId / projectRevision / promptCompiled / maskImagePath 全部落入 carry', () => {
    const analysis = fixtureAnalysis();
    const plan = buildRecreationPlan(analysis);
    const state = initialRecreationState(plan, '原始 Prompt', '负面');
    const carry = buildGenerationCarry(state, {
      projectId: 'vp-1',
      projectName: '动漫照片风',
      projectRevision: 8,
      promptCompiled: true,
      maskImagePath: 'D:/masks/combined.png',
      imageReferences: refs,
      personReplacement: { enabled: true, clothingPolicy: 'preserve_original' },
    });
    expect(carry.projectId).toBe('vp-1');
    expect(carry.projectName).toBe('动漫照片风');
    expect(carry.projectRevision).toBe(8);
    expect(carry.promptCompiled).toBe(true);
    expect(carry.maskImagePath).toBe('D:/masks/combined.png');
    expect(carry.imageReferences).toEqual(refs);
  });
});

describe('buildGenerationProvenance V2（项目冻结）', () => {
  function projectContext(project: VisualProject): Parameters<typeof buildGenerationProvenance>[0]['project'] {
    const person = project.modification.person;
    return {
      id: project.id,
      name: project.name,
      revision: project.revision,
      ...(person?.enabled
        ? {
          personContract: {
            strength: person.strength,
            replaceScope: person.replaceScope,
            ...(person.targetRegionId ? { targetRegionId: person.targetRegionId } : {}),
            applyIdentityTo: person.applyIdentityTo,
            preserveTemplateIdentity: false,
          },
        }
        : {}),
      regions: project.regions
        .filter(region => region.enabled)
        .map(region => ({
          id: region.id,
          name: region.name,
          replaceType: region.replaceType,
          constraintStrength: region.constraintStrength,
          ...(region.replaceScope ? { replaceScope: region.replaceScope } : {}),
          ...(region.personReferenceId
            ? {
              personReferenceLabel: project.references
                .find(ref => ref.id === region.personReferenceId)?.label,
            }
            : {}),
          enabled: region.enabled,
          ...(region.maskPath ? { maskPath: region.maskPath } : {}),
          shape: region.shape as never,
        })),
      renderingContract: project.renderingContract ?? undefined,
    };
  }

  function snapshotOf(project: VisualProject): GenerationProvenanceSnapshot {
    const analysis = fixtureAnalysis();
    const plan = buildRecreationPlan(analysis);
    const state = initialRecreationState(plan, 'p', 'n');
    return buildGenerationProvenance({
      draft: EMPTY_MODIFICATION_DRAFT,
      recreation: state,
      imageReferences: refs,
      project: projectContext(project),
    });
  }

  it('projectRevisionFrozenInGenerationSnapshot：修订推进后旧快照仍保持当时修订', () => {
    const project = setProjectPersonContract(fixtureProject(), {
      enabled: true,
      source: 'gallery',
      assetId: 'asset-person',
      path: 'D:/imgs/person.png',
      label: '人物参考',
      strength: 'strict',
      replaceScope: 'whole_person',
      preserveTemplateIdentity: false,
      applyIdentityTo: 'primary_subject_only',
    });
    const snapshotAtRevision1 = snapshotOf(project); // revision = 1（人物合同语义事件）
    const evolved = updateVisualProjectSemanticState(project, 'free_text', draft => ({
      ...draft,
      modification: { ...draft.modification, freeText: '再改一版' },
    }));
    const snapshotAtRevision2 = snapshotOf(evolved);
    expect(snapshotAtRevision1.projectRevision).toBe(1);
    expect(snapshotAtRevision2.projectRevision).toBe(2);
    expect(snapshotAtRevision1.personContract?.strength).toBe('strict');
    expect(snapshotAtRevision1.personContract?.preserveTemplateIdentity).toBe(false);
  });

  it('区域 + 媒介结构进入快照；禁用区域被排除', () => {
    let project = fixtureProject();
    project = updateVisualProjectSemanticState(project, 'regions', draft => ({
      ...draft,
      regions: [
        {
          id: 'r1',
          name: '区域 1',
          shape: { kind: 'rect', x: 0.05, y: 0.1, w: 0.3, h: 0.6 },
          replaceType: 'person',
          personReferenceId: 'ref-1',
          constraintStrength: 'strict',
          replaceScope: 'face',
          enabled: true,
          createdAt: new Date().toISOString(),
          maskPath: 'D:/masks/r1.png',
        },
        {
          id: 'r2',
          name: '停用区域',
          shape: { kind: 'rect', x: 0.6, y: 0.6, w: 0.2, h: 0.2 },
          replaceType: 'custom',
          constraintStrength: 'balanced',
          enabled: false,
          createdAt: new Date().toISOString(),
        },
      ],
      references: [{ id: 'ref-1', path: 'D:/imgs/person.png', label: '人物参考', kind: 'person', source: 'local_import' }],
      renderingContract: { overallMode: 'mixed_media', preserveTemplateMediaStructure: true, regions: [] },
    }));
    const snapshot = snapshotOf(project);
    expect(snapshot.regions).toHaveLength(1);
    expect(snapshot.regions![0].personReferenceLabel).toBe('人物参考');
    expect(snapshot.regions![0].rect).toEqual({ x: 0.05, y: 0.1, w: 0.3, h: 0.6 });
    expect(snapshot.regions![0].maskPath).toBe('D:/masks/r1.png');
    expect(snapshot.renderingContract?.overallMode).toBe('mixed_media');
  });

  it('legacyVisionTaskDoesNotInventProjectFields：非项目链路无 projectId / regions / 媒介字段', () => {
    const analysis = fixtureAnalysis();
    const snapshot = buildGenerationProvenance({
      draft: EMPTY_MODIFICATION_DRAFT,
      recreation: initialRecreationState(buildRecreationPlan(analysis), 'p', 'n'),
      imageReferences: refs,
    });
    expect(snapshot.projectId).toBeUndefined();
    expect(snapshot.projectName).toBeUndefined();
    expect(snapshot.projectRevision).toBeUndefined();
    expect(snapshot.personContract).toBeUndefined();
    expect(snapshot.regions).toBeUndefined();
    expect(snapshot.renderingContract).toBeUndefined();
  });

  it('mentionedProjectAssetKeepsRole：@引用角色进入快照清单（generated_result 排除）', () => {
    const refsResolved = resolveGenerationImageReferences({
      draft: {
        ...EMPTY_MODIFICATION_DRAFT,
        freeText: '参考 @海边背景',
        mentions: [
          {
            id: 'm1',
            path: 'D:/imgs/beach.png',
            label: '海边背景',
            token: '海边背景',
            role: 'background_reference',
          },
        ],
      },
      sourcePath: 'D:/imgs/template.png',
      templateLabel: '原图',
    });
    expect(refsResolved.map(ref => ref.role)).toEqual(['template', 'background_reference']);
  });
});

describe('buildVisionRecreationUserContent × hardContractLines（优化器收权 §14）', () => {
  it('硬性合同块置于用户内容顶部；无合同时不出现空块', () => {
    const analysis = fixtureAnalysis();
    const content = buildVisionRecreationUserContent({
      originalRecreationPrompt: 'p',
      structuredRecreationPlan: buildRecreationPlan(analysis),
      userAdjustmentInstruction: '换成夜景',
      hardContractLines: [
        '人物替换：启用（strict，身份主来源=@人物参考）',
        '服装来源：沿用画面模板服装（仅服装，不保留模板人物）',
        '媒介结构：混合媒介保持分层（真人层=真人摄影；动漫层=动漫插画，same_as_primary）',
      ],
    });
    const contractIndex = content.indexOf('【硬性合同（不可变更');
    expect(contractIndex).toBeGreaterThanOrEqual(0);
    expect(content.indexOf('【结构化复刻方案】')).toBeGreaterThan(contractIndex);
    expect(content).toContain('人物替换：启用（strict');
    const noContract = buildVisionRecreationUserContent({
      originalRecreationPrompt: 'p',
      structuredRecreationPlan: buildRecreationPlan(analysis),
      userAdjustmentInstruction: '换成夜景',
    });
    expect(noContract).not.toContain('【硬性合同（不可变更');
  });
});
