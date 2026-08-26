import { describe, expect, it } from 'vitest';
import type { GenerationImageReference, VisionAnalysis } from '../../../../types';
import { fixtureAnalysis } from './fixtures';
import { createVisualProjectFromAnalysis, normalizeModificationContract } from '../project';
import { emptyWorkspace } from './fixtures';
import { buildOptimizerHardContractLines } from '../optimizerContract';
import {
  compileClothingContract,
  compilePersonReplacementContract,
  compileTemplatePreservationContract,
  mergeFinalGenerationPrompt,
} from '../promptCompiler';
import { enforceOptimizerDimensionLocks, type RecreationFieldKey } from '../../recreationPlan';
import { lockBaselineValues, lockedDimensionKeys } from '../dimensionLock';
import type { VisualProject } from '../types';

/**
 * 混合媒介回归 fixture（GUI 验收 Case C 实拍案例 / §23）：
 * 模板 = 左下蹲姿真人女性 + 右侧站立动漫女孩（动漫AI照片风）；
 * 用户仅修改「人物 + 服装」，未启用「修改动作」。
 * 期望：两个主体各自姿态、镜头、构图、空间关系全部保持模板。
 */

function mixedMediaAnalysis(): VisionAnalysis {
  const base = fixtureAnalysis();
  return {
    ...base,
    summary: '左侧真人女性蹲姿与右侧动漫女孩站立的动漫AI照片风混合媒介作品',
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
        clothing: ['水手服'],
        relations: [],
      },
    ],
    composition: { ...base.composition, subject_placement: '左侧真人位于左下，右侧动漫角色占主导，全身' },
    camera: { ...base.camera, shot_type: '平视中景', angle: '平视' },
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

function mixedMediaProject(): VisualProject {
  const analysis = mixedMediaAnalysis();
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

describe('Region Pose Snapshot（§13/§14：逐主体姿态冻结）', () => {
  it('primaryPosePreservedDuringIdentityReplacement：真人蹲姿 + 朝向 + 锚点完整冻结', () => {
    const snapshot = mixedMediaProject().templateSnapshot!;
    const primary = snapshot.subjectPoses!.find(pose => pose.subjectRole === 'primary_subject')!;
    expect(primary.label).toBe('真人女性');
    expect(primary.poseDescription).toBe('蹲姿');
    expect(primary.bodyOrientation).toBe('身体朝向右侧，正面微侧');
    expect(primary.spatialAnchor).toEqual({ x: 0.05, y: 0.35, width: 0.45, height: 0.6 });
  });

  it('animeCounterpartPosePreservedDuringIdentityReplacement：动漫站立姿态独立冻结', () => {
    const snapshot = mixedMediaProject().templateSnapshot!;
    const anime = snapshot.subjectPoses!.find(pose => pose.subjectRole === 'anime_counterpart')!;
    expect(anime.label).toBe('动漫女孩');
    expect(anime.poseDescription).toBe('站立姿势');
    expect(anime.bodyOrientation).toBe('身体朝向左侧');
  });

  it('保留合同逐主体输出：真人蹲姿与动漫站姿分别锁定（不再只有一个全局动作字符串）', () => {
    const project = mixedMediaProject();
    const block = compileTemplatePreservationContract({
      project,
      activeDimensions: project.modification.activeDimensions,
    });
    expect(block).toContain('真人女性（主体）：蹲姿；朝向：身体朝向右侧，正面微侧');
    expect(block).toContain('动漫女孩（动漫对应角色）：站立姿势；朝向：身体朝向左侧');
  });
});

describe('Reference Role Isolation（§25-§27：人物参考只供应身份与服装）', () => {
  it('personReferencePoseDoesNotLeakIntoTemplate：硬合同含人物参考边界行', () => {
    const lines = buildOptimizerHardContractLines(mixedMediaProject());
    const boundary = lines.find(line => line.startsWith('人物参考边界'));
    expect(boundary).toBeDefined();
    expect(boundary!).toContain('姿势、动作、身体朝向、观看角度、镜头、构图与背景一律不得采用');
    expect(boundary!).toContain('以画面模板为准');
  });

  it('人物替换合同（Compiler 层）同样携带边界行', () => {
    const project = mixedMediaProject();
    const block = compilePersonReplacementContract({
      person: project.modification.person!,
      imageReferences: [],
    });
    expect(block).toContain('人物参考边界');
    expect(block).toContain('一律不得采用');
  });

  it('服装合同：使用人物参考服装 ≠ 带入参考图姿势 / 镜头 / 构图', () => {
    const block = compileClothingContract({
      clothingPolicy: 'use_subject_reference',
      imageReferences: [],
    });
    expect(block).toContain('仅采用服装本身');
    expect(block).toContain('姿势、姿态、镜头与构图不得因此带入');
  });
});

describe('mixedMediaSpatialRelationshipPreserved（§15/§16：构图与镜头锁定）', () => {
  it('最终 Prompt 保留合同携带模板构图 / 镜头 canonical 基线', () => {
    const project = mixedMediaProject();
    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: '将画面主体替换为人物参考中的女性，服装改为人物参考服装',
      imageReferences: [
        { path: 'D:/imgs/mixed.png', label: '画面模板', role: 'template' },
        { path: 'D:/imgs/person.png', label: '人物参考', role: 'person_reference' },
      ] as GenerationImageReference[],
      personReplacementEnabled: true,
    });
    const preservation = compiled.prompt.slice(
      compiled.prompt.indexOf('【模板保留合同】'),
      compiled.prompt.indexOf('【最终画面描述】'),
    );
    expect(preservation).toContain('- 构图：左侧真人位于左下，右侧动漫角色占主导，全身');
    expect(preservation).toContain('- 镜头：平视中景，平视，浅景深');
    expect(preservation).toContain('唯一事实来源');
    expect(preservation).not.toContain('%');
  });

  it('最终画面描述段头声明「仅描述修改项」（§18：锁定维度不得在此重写）', () => {
    const project = mixedMediaProject();
    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: '将画面主体替换为人物参考中的女性，服装改为人物参考服装',
      imageReferences: [],
      personReplacementEnabled: true,
    });
    expect(compiled.prompt).toContain('【最终画面描述】（本段仅描述修改项：人物、服装；');
    expect(compiled.prompt).toContain('不得重新描述这些维度');
  });

  it('§24 场景复刻：优化器给出 35%/46% 占比候选 → 结构化清洗拒绝引入', () => {
    const project = mixedMediaProject();
    const locks = {
      lockedKeys: lockedDimensionKeys(project),
      baseline: lockBaselineValues(project),
    };
    const enforced = enforceOptimizerDimensionLocks(
      ['subject', 'clothing', 'composition', 'camera'] as RecreationFieldKey[],
      {
        subject: '人物参考女性',
        clothing: '人物参考服装',
        composition: '左侧真人约35%，右侧动漫约46%',
        camera: '平视，略带俯视',
      },
      locks,
    );
    expect(enforced.violations.sort()).toEqual(['camera', 'composition']);
    expect(enforced.changedDimensions).toEqual(['subject', 'clothing']);
    expect(enforced.dimensionValues).toEqual({ subject: '人物参考女性', clothing: '人物参考服装' });
    // 清洗后再编译：保留合同仍是 canonical 构图 / 镜头
    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: '将画面主体替换为人物参考中的女性，服装改为人物参考服装',
      imageReferences: [],
      personReplacementEnabled: true,
    });
    expect(compiled.prompt).toContain('左侧真人位于左下');
    expect(compiled.prompt).not.toContain('35%');
    expect(compiled.prompt).not.toContain('略带俯视');
  });
});
