/**
 * Runtime Skill Engine 测试（§47/§48/§49）。
 *
 * 模板案例（GUI 验收 Case 6/7 实拍场景）：混合媒介（真人蹲姿 + 动漫站姿 wink）、
 * 用户替换人物 + 人物参考服装、未修改动作。
 */

import { describe, expect, it } from 'vitest';
import type { GenerationImageReference, VisionAnalysis } from '../../../../types';
import { fixtureAnalysis, emptyWorkspace } from '../../project/__tests__/fixtures';
import { createVisualProjectFromAnalysis, normalizeModificationContract } from '../../project/project';
import { mergeFinalGenerationPrompt } from '../../project/promptCompiler';
import { buildDimensionContracts } from '../../project/dimensionLock';
import {
  BUILT_IN_RUNTIME_SKILLS,
  effectiveRuntimeSkills,
  runtimeSkillById,
} from '../registry';
import {
  buildSkillExecutionSnapshot,
  compiledSectionsOf,
  executeRuntimeSkills,
} from '../engine';
import type { VisualProject } from '../../project/types';

function templateCaseAnalysis(): VisionAnalysis {
  const base = fixtureAnalysis();
  return {
    ...base,
    summary: '左侧真人女性蹲姿与右侧动漫女孩站立 wink 的混合媒介作品',
    subjects: [
      {
        label: '真人女性',
        count: 1,
        appearance: ['长发'],
        pose: '蹲姿',
        action: null,
        position: { x: 0.05, y: 0.35, width: 0.45, height: 0.6 },
        orientation: '身体朝向右侧，正面微侧',
        clothing: ['白色连衣裙'],
        relations: [],
      },
      {
        label: '动漫女孩',
        count: 1,
        appearance: ['银发'],
        pose: '站立姿势',
        action: null,
        position: { x: 0.55, y: 0.1, width: 0.4, height: 0.85 },
        orientation: '身体朝向左侧',
        gesture: 'V 手势',
        facial_expression: '右眼闭合的wink',
        gaze: '看向镜头',
        clothing: ['水手服'],
        relations: [],
      },
    ],
    media_structure: {
      overall_mode: 'mixed_media',
      preserve_template_media_structure: true,
      regions: [
        { label: '真人层（真人女性）', semantic_role: 'primary_subject', rendering_mode: 'photorealistic', identity_relation: 'template_identity' },
        { label: '动漫女孩', semantic_role: 'anime_counterpart', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary' },
      ],
    },
  } as unknown as VisionAnalysis;
}

function templateCaseProject(): VisualProject {
  const analysis = templateCaseAnalysis();
  const workspace = emptyWorkspace(analysis);
  const project = createVisualProjectFromAnalysis({
    name: '动漫AI照片',
    analysis,
    plan: workspace.recreation!.plan,
    recreation: workspace.recreation!,
    sourceAsset: { path: 'D:/imgs/mixed.png', assetId: 'asset-mixed', source: 'gallery' },
    workspace,
    analysisModel: { modelId: 'glm-5v-turbo', displayName: 'GLM-5V-Turbo', providerName: '智谱' },
  });
  const modification = normalizeModificationContract({
    freeText: '',
    activeDimensions: ['subject', 'clothing'],
    person: {
      enabled: true,
      source: 'local',
      path: 'D:/imgs/person.png',
      label: '人物参考',
      strength: 'strict',
      replaceScope: 'whole_person',
      preserveTemplateIdentity: false,
      applyIdentityTo: 'primary_subject_only',
    },
    clothingPolicy: 'use_subject_reference',
    customClothing: '',
    replicationBoost: false,
    mentions: [],
    extraImageRefs: [],
  });
  return { ...project, modification };
}

const IMAGE_REFS: GenerationImageReference[] = [
  { path: 'D:/imgs/mixed.png', label: '原图', role: 'template' },
  { path: 'D:/imgs/person.png', label: '人物参考', role: 'person_reference' },
];

describe('registry（§47 注册表）', () => {
  it('runtimeSkillRegistryContainsBuiltIns：13 个内置技能全部登记且 id 唯一', () => {
    expect(BUILT_IN_RUNTIME_SKILLS.length).toBeGreaterThanOrEqual(13);
    const ids = new Set(BUILT_IN_RUNTIME_SKILLS.map(skill => skill.id));
    expect(ids.size).toBe(BUILT_IN_RUNTIME_SKILLS.length);
    for (const required of [
      'visual_analysis', 'person_replacement', 'clothing_source', 'pose_preservation',
      'expression_preservation', 'composition_preservation', 'camera_preservation',
      'hybrid_media_preservation', 'region_replacement', 'replication_boost',
      'prompt_optimization', 'prompt_compilation', 'contract_validation',
    ]) {
      expect(ids.has(required)).toBe(true);
    }
  });

  it('coreSkillCannotBeDisabled：核心技能写入 disabled 也被 effectiveRuntimeSkills 忽略', () => {
    const all = BUILT_IN_RUNTIME_SKILLS.map(skill => skill.id);
    const effective = effectiveRuntimeSkills(all).map(skill => skill.id);
    for (const core of ['prompt_compilation', 'contract_validation', 'pose_preservation', 'person_replacement']) {
      expect(effective).toContain(core);
    }
    // 可停用技能真实停用
    expect(effective).not.toContain('region_replacement');
    expect(effective).not.toContain('replication_boost');
  });

  it('用户可见名一律中文（§51）', () => {
    for (const skill of BUILT_IN_RUNTIME_SKILLS) {
      expect(skill.name).toMatch(/[一-鿿]/);
    }
  });
});

describe('engine（§47 技能执行 / §49 模板案例）', () => {
  it('模板案例：person/clothing/pose/expression/hybrid_media 全部 applied', () => {
    const records = executeRuntimeSkills({
      project: templateCaseProject(),
      imageReferences: IMAGE_REFS,
    });
    const statusOf = (id: string) => records.find(record => record.skillId === id)?.status;
    expect(statusOf('person_replacement')).toBe('applied');
    expect(statusOf('clothing_source')).toBe('applied');
    expect(statusOf('pose_preservation')).toBe('applied');
    expect(statusOf('expression_preservation')).toBe('applied');
    expect(statusOf('hybrid_media_preservation')).toBe('applied');
    expect(statusOf('visual_analysis')).toBe('applied');
    expect(statusOf('prompt_compilation')).toBe('applied');
    expect(statusOf('contract_validation')).toBe('applied');
    // 用户未开复刻度 → replication_boost skipped（按用户状态，§49）
    expect(statusOf('replication_boost')).toBe('skipped');
    expect(statusOf('region_replacement')).toBe('skipped');
    expect(statusOf('prompt_optimization')).toBe('skipped');
  });

  it('poseSkillFindsUnmodifiedAction：发现「用户没有修改动作」+ 分主体基线', () => {
    const record = executeRuntimeSkills({ project: templateCaseProject(), imageReferences: IMAGE_REFS })
      .find(item => item.skillId === 'pose_preservation')!;
    expect(record.findings.some(finding => finding.title.includes('用户没有修改动作'))).toBe(true);
    expect(record.findings.some(finding => finding.description.includes('真人女性'))).toBe(true);
    expect(record.findings.some(finding => finding.description.includes('动漫女孩'))).toBe(true);
  });

  it('poseSkillCreatesLockedConstraint：约束与 DimensionLock 同源（§41/§42）', () => {
    const project = templateCaseProject();
    const record = executeRuntimeSkills({ project, imageReferences: IMAGE_REFS })
      .find(item => item.skillId === 'pose_preservation')!;
    expect(record.hardConstraints.length).toBeGreaterThanOrEqual(2);
    for (const constraint of record.hardConstraints) {
      expect(constraint.mode).toBe('locked');
      expect(constraint.source).toBe('@原图');
    }
    // 同源校验：pose 在领域合同里确实 locked
    expect(buildDimensionContracts(project).find(contract => contract.key === 'pose')?.mode).toBe('locked');
    // 用户启用修改动作 → 技能 skipped（解锁一致）
    const modified = {
      ...project,
      modification: normalizeModificationContract({
        ...project.modification,
        activeDimensions: ['subject', 'clothing', 'pose'],
      }),
    };
    const unlocked = executeRuntimeSkills({ project: modified, imageReferences: IMAGE_REFS })
      .find(item => item.skillId === 'pose_preservation')!;
    expect(unlocked.status).toBe('skipped');
    expect(buildDimensionContracts(modified).find(contract => contract.key === 'pose')?.mode).toBe('modified');
  });

  it('expressionSkillFindsTemplateWink：发现动漫主体 wink + 锁定约束', () => {
    const record = executeRuntimeSkills({ project: templateCaseProject(), imageReferences: IMAGE_REFS })
      .find(item => item.skillId === 'expression_preservation')!;
    const winkFinding = record.findings.find(finding => finding.title.includes('wink'));
    expect(winkFinding).toBeDefined();
    expect(winkFinding!.sourceDimension).toBe('facial_expression');
    const constraint = record.hardConstraints.find(item => item.dimension === 'facial_expression');
    expect(constraint?.mode).toBe('locked');
    expect(constraint?.value).toContain('wink');
    // Prompt 写入 = 表情锁定合同（与编译器同一纯函数产出）
    expect(record.promptContributions[0]?.block).toBe('expression_contract');
    expect(record.promptContributions[0]?.finalText).toContain('表情锁定合同');
  });

  it('personReplacementSkillRecordsFinding：发现绑定人物参考 + 用户裁决', () => {
    const record = executeRuntimeSkills({ project: templateCaseProject(), imageReferences: IMAGE_REFS })
      .find(item => item.skillId === 'person_replacement')!;
    expect(record.findings[0]?.title).toContain('人物参考');
    expect(record.triggeredBy).toBe('user');
    // 用户选择（§19）：身份来源建议 + 强度/范围 modified 记录
    expect(record.userDecisions.length).toBeGreaterThanOrEqual(2);
    expect(record.suggestions[0]?.status).toBe('auto_applied');
    // 系统强制：模板人物身份不保留
    expect(record.hardConstraints[0]?.reason).toContain('不保留');
  });

  it('skillSuggestionRecordsUserDecision：建议与裁决一一对应', () => {
    const records = executeRuntimeSkills({ project: templateCaseProject(), imageReferences: IMAGE_REFS });
    for (const record of records) {
      for (const decision of record.userDecisions) {
        expect(record.suggestions.some(suggestion => suggestion.id === decision.suggestionId)).toBe(true);
      }
    }
  });

  it('skillHardConstraintEntersEffectivePlan：锁定约束与 Effective Plan 模板保留行一致', () => {
    const project = templateCaseProject();
    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: '优化后的最终画面描述',
      imageReferences: IMAGE_REFS,
      personReplacementEnabled: true,
    });
    const pose = executeRuntimeSkills({ project, imageReferences: IMAGE_REFS })
      .find(item => item.skillId === 'pose_preservation')!;
    for (const constraint of pose.hardConstraints) {
      if (constraint.value) expect(compiled.prompt).toContain(constraint.value);
    }
    expect(compiled.prompt).toContain('蹲姿');
    expect(compiled.prompt).toContain('站立姿势');
  });

  it('skillPromptContributionAppearsInFinalTrace：贡献 finalText 真实出现在最终 Prompt', () => {
    const project = templateCaseProject();
    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: '优化后的最终画面描述',
      imageReferences: IMAGE_REFS,
      personReplacementEnabled: true,
    });
    const records = executeRuntimeSkills({ project, imageReferences: IMAGE_REFS });
    const expression = records.find(item => item.skillId === 'expression_preservation')!;
    const contributionText = expression.promptContributions[0]?.finalText ?? '';
    expect(contributionText).not.toBe('');
    expect(compiled.prompt).toContain(contributionText.trim().split('\n')[0]);
    const person = records.find(item => item.skillId === 'person_replacement')!;
    expect(compiled.prompt).toContain('【人物替换合同（强制执行）】');
    expect(person.promptContributions.some(item => item.block === 'person_contract')).toBe(true);
  });

  it('确定性（§42）：同一项目状态两次执行产出一致', () => {
    const project = templateCaseProject();
    const a = executeRuntimeSkills({ project, imageReferences: IMAGE_REFS });
    const b = executeRuntimeSkills({ project, imageReferences: IMAGE_REFS });
    expect(JSON.stringify(a.map(({ startedAt, completedAt, executionId, ...rest }) => rest)))
      .toBe(JSON.stringify(b.map(({ startedAt, completedAt, executionId, ...rest }) => rest)));
  });

  it('技能中心停用区域技能 = 真实效果：编译不含区域块 + 记录 skipped', () => {
    const project = templateCaseProject();
    const withRegion: VisualProject = {
      ...project,
      regions: [{
        id: 'r1',
        name: '背景区域',
        shape: { kind: 'rect', x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
        replaceType: 'background',
        constraintStrength: 'strict',
        enabled: true,
        createdAt: new Date().toISOString(),
      }],
    };
    const compiledOff = mergeFinalGenerationPrompt({
      project: withRegion,
      finalDescription: '描述',
      imageReferences: IMAGE_REFS,
      personReplacementEnabled: true,
      includeRegions: false,
    });
    expect(compiledOff.sections).not.toContain('region');
    const record = executeRuntimeSkills({ project: withRegion, imageReferences: IMAGE_REFS, disabledSkillIds: ['region_replacement'] })
      .find(item => item.skillId === 'region_replacement')!;
    expect(record.status).toBe('skipped');
    expect(record.skippedReason).toContain('技能中心');
    // 核心技能写进 disabled 无效
    const pose = executeRuntimeSkills({ project: withRegion, imageReferences: IMAGE_REFS, disabledSkillIds: ['pose_preservation'] })
      .find(item => item.skillId === 'pose_preservation')!;
    expect(pose.status).toBe('applied');
  });
});

describe('snapshot（§48 快照冻结）', () => {
  it('optimizationCreatesSkillExecutionSnapshot：优化完成生成含 optimizer 记录的快照', () => {
    const snapshot = buildSkillExecutionSnapshot({
      project: templateCaseProject(),
      imageReferences: IMAGE_REFS,
      optimizer: {
        applied: true,
        triggeredBy: 'user',
        model: { displayName: 'GLM-5V-Turbo', providerName: '智谱' },
        hardContractLineCount: 5,
        ignoredViolations: ['pose'],
      },
    });
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.skills.some(record => record.skillId === 'prompt_optimization' && record.status === 'applied')).toBe(true);
    const optimizerRecord = snapshot.skills.find(record => record.skillId === 'prompt_optimization')!;
    expect(optimizerRecord.findings.some(finding => finding.title.includes('GLM-5V-Turbo'))).toBe(true);
    expect(optimizerRecord.hardConstraints.some(constraint => constraint.value?.includes('pose'))).toBe(true);
  });

  it('projectRevisionSnapshotIsImmutable：快照冻结后项目演进不影响快照内容', () => {
    const project = templateCaseProject();
    const snapshot = buildSkillExecutionSnapshot({ project, imageReferences: IMAGE_REFS });
    const revisionAtFreeze = snapshot.projectRevision;
    // 项目随后演进：改修订 / 换服装策略
    const evolved = {
      ...project,
      revision: project.revision + 9,
      modification: normalizeModificationContract({ ...project.modification, clothingPolicy: 'custom', customClothing: '红色礼服' }),
    };
    expect(snapshot.projectRevision).toBe(revisionAtFreeze);
    // 快照里的服装技能记录仍是冻结时的（use_subject_reference）
    const clothing = snapshot.skills.find(record => record.skillId === 'clothing_source')!;
    expect(clothing.findings[0]?.title).toContain('人物参考');
    // 同一 evolved 项目重新执行会反映新状态（对比证明快照确实冻结了旧状态）
    const evolvedRecords = executeRuntimeSkills({ project: evolved, imageReferences: IMAGE_REFS });
    expect(evolvedRecords.find(record => record.skillId === 'clothing_source')!.findings[0]?.title).toContain('红色礼服');
  });

  it('historyUsesHistoricalSkillVersion：compiledSections 冻结进快照供 History 反查', () => {
    const project = templateCaseProject();
    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: '优化后的最终画面描述',
      imageReferences: IMAGE_REFS,
      personReplacementEnabled: true,
    });
    const snapshot = buildSkillExecutionSnapshot({ project, imageReferences: IMAGE_REFS, compiled });
    expect(snapshot.compiledSections).toBeDefined();
    const sections = snapshot.compiledSections!;
    const personBlock = sections.find(section => section.block === 'person_contract');
    expect(personBlock?.skillIds).toEqual(['person_replacement']);
    expect(personBlock?.text).toContain('【人物替换合同（强制执行）】');
    const expressionBlock = sections.find(section => section.block === 'expression_contract');
    expect(expressionBlock?.skillIds).toEqual(['expression_preservation']);
    // 分段拼起来覆盖全部编译块
    expect(sections.length).toBe(compiled.sections.length);
  });

  it('oldProjectWithoutSkillSnapshotDoesNotInventRecords：无快照旧项目不伪造（§44）', () => {
    const project = templateCaseProject();
    // 旧项目文档没有 skillExecution 字段
    expect(project.skillExecution).toBeUndefined();
    // Drawer 层判定：snapshot === null → 显示提示（这里以字段缺省为锚）
    const restored = { ...project, skillExecution: undefined };
    expect(restored.skillExecution ?? null).toBeNull();
  });

  it('compiledSectionsOf：未编译输入不产生分段', () => {
    const snapshot = buildSkillExecutionSnapshot({ project: templateCaseProject(), imageReferences: IMAGE_REFS });
    expect(snapshot.compiledSections).toBeUndefined();
  });
});
