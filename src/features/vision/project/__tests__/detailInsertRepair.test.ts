/**
 * V6.1 Detail Insert Repair（可修复阻断闭环）领域测试：
 *  - 阻断文案与 Repair 判定同源（detailInsertIncompleteErrors）；
 *  - 受限修复只补 instances（模板九维度 / subjectPoses / 人物替换 / originSkill 全部保留）；
 *  - 失败绝不清空旧分析；成功后 §7 阻断自动消失；
 *  - UI 链路 wiring：Rail 显示「识别局部插图」CTA，识别调用复用既有
 *    visionExtractDetailInserts（V6.2 起位于 detailInsertRepairRunner，无第二套识别）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixtureProject } from './fixtures';
import {
  detailInsertIncompleteErrors,
  validateAnimeCharacterConsistency,
} from '../animeCharacter';
import {
  countInsertInstances,
  mergeDetailInsertRepairResults,
  type DetailInsertRepairInput,
} from '../detailInsert';
import type { DetailInsertInstance, RenderingContract, VisualProject, VisualTemplateSnapshot } from '../types';

const pageDir = resolve(__dirname, '../../../../pages');
const railSrc = readFileSync(resolve(__dirname, '../ContextRail.tsx'), 'utf8');
const runnerSrc = readFileSync(resolve(__dirname, '../detailInsertRepairRunner.ts'), 'utf8');
const visionSrc = readFileSync(resolve(pageDir, 'VisionUnderstanding.tsx'), 'utf8');
const cssSrc = readFileSync(resolve(pageDir, 'VisionUnderstanding.css'), 'utf8');

const INSTANCES: DetailInsertInstance[] = [
  { id: 'details-ins-1', groupId: 'details', mediaType: 'anime_illustration', cropType: 'face', label: '左上动漫面部特写' },
  { id: 'details-ins-2', groupId: 'details', mediaType: 'anime_illustration', cropType: 'eyes', label: '右上动漫眼部特写' },
  { id: 'details-ins-3', groupId: 'details', mediaType: 'anime_illustration', cropType: 'expression', label: '右下动漫表情特写' },
  { id: 'details-ins-4', groupId: 'details', mediaType: 'photorealistic', cropType: 'face', label: '左下真人面部特写' },
];

function projectWithDetailGroup(instances: DetailInsertInstance[] | null = INSTANCES): VisualProject {
  const project = fixtureProject();
  const rendering: RenderingContract = {
    overallMode: 'mixed_media',
    preserveTemplateMediaStructure: true,
    regions: [
      { id: 'photo', label: '真人主体', semanticRole: 'primary_subject', renderingMode: 'photorealistic', identityRelation: 'template_identity' },
      { id: 'anime', label: '动漫主角色', semanticRole: 'secondary_subject', renderingMode: 'anime_illustration', identityRelation: 'same_as_primary' },
      {
        id: 'details',
        label: '四角局部插图',
        semanticRole: 'detail_insert',
        renderingMode: 'anime_illustration',
        identityRelation: 'same_as_primary',
        description: '四角多个不同的局部插图画框',
        ...(instances ? { instances } : {}),
      },
    ],
  };
  return {
    ...project,
    renderingContract: rendering,
    templateSnapshot: project.templateSnapshot
      ? { ...project.templateSnapshot, mediaStructure: rendering }
      : project.templateSnapshot,
  };
}

/** 提取结果（IO 层输出形态；与页面 visionExtractDetailInserts 映射一致）。 */
const repairInputs: DetailInsertRepairInput[] = [
  { regionId: 'details', instances: INSTANCES.map(({ id: _id, groupId: _groupId, ...rest }) => rest) },
];

describe('Detail Insert Repair（纯函数）', () => {
  it('阻断存在时 detailInsertIncompleteErrors 给出可修复文案（Validator 同源）', () => {
    const project = projectWithDetailGroup(null);
    const errors = detailInsertIncompleteErrors(project);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('尚未逐个识别');
    // 同源校验：这些文案全部包含在 Validator 输出里（不出现第二套文案）
    const validated = validateAnimeCharacterConsistency(project);
    for (const error of errors) expect(validated).toContain(error);
  });

  it('failedRepairPreservesOldAnalysis：全部提取失败时快照原样（同一引用）', () => {
    const project = projectWithDetailGroup(null);
    const snapshot = project.templateSnapshot!;
    const outcome = mergeDetailInsertRepairResults(snapshot, [{ regionId: 'details', instances: null }]);
    expect(outcome.repaired).toBe(0);
    expect(outcome.failed).toBe(1);
    expect(outcome.snapshot).toBe(snapshot);
    expect(countInsertInstances(outcome.snapshot.mediaStructure).total).toBe(0);
  });

  it('repairDoesNotReplaceTemplateSnapshot：只补目标层 instances，九维度原样', () => {
    const project = projectWithDetailGroup(null);
    const snapshot = project.templateSnapshot!;
    const outcome = mergeDetailInsertRepairResults(snapshot, repairInputs);
    expect(outcome.repaired).toBe(1);
    expect(outcome.after.total).toBe(4);
    expect(outcome.after.anime).toBe(3);
    expect(outcome.snapshot.subject).toBe(snapshot.subject);
    expect(outcome.snapshot.action).toBe(snapshot.action);
    expect(outcome.snapshot.camera).toBe(snapshot.camera);
    expect(outcome.snapshot.style).toBe(snapshot.style);
    expect(outcome.snapshot.composition).toBe(snapshot.composition);
    expect(outcome.snapshot.lighting).toBe(snapshot.lighting);
    expect(outcome.snapshot.color).toBe(snapshot.color);
  });

  it('repairPreservesLockedPoseCamera：subjectPoses 与动作/镜头基线不被改写', () => {
    const project = projectWithDetailGroup(null);
    const snapshot: VisualTemplateSnapshot = {
      ...project.templateSnapshot!,
      subjectPoses: [
        { id: 'pose-anime-1', label: '动漫主角色', subjectRole: 'anime_counterpart', poseDescription: '侧身回望', source: 'template_analysis', facialExpression: 'wink', gaze: '看向镜头' },
      ],
    };
    const outcome = mergeDetailInsertRepairResults(snapshot, repairInputs);
    expect(outcome.snapshot.subjectPoses).toBe(snapshot.subjectPoses);
    expect(outcome.snapshot.action).toBe(snapshot.action);
    expect(outcome.snapshot.camera).toBe(snapshot.camera);
  });

  it('repairPreservesPersonReplacement：页面应用形态只覆盖快照/媒介合同，人物替换与用户修改保留', () => {
    const project = projectWithDetailGroup(null);
    const person = {
      enabled: true,
      source: 'gallery' as const,
      label: '人物参考图',
      path: 'D:/imgs/person.png',
      assetId: 'asset-person',
      strength: 'balanced' as const,
      replaceScope: 'whole_person' as const,
      preserveTemplateIdentity: false as const,
      applyIdentityTo: 'all_corresponding_subjects' as const,
    };
    const withPerson: VisualProject = {
      ...project,
      modification: { ...project.modification, person },
    };
    const outcome = mergeDetailInsertRepairResults(withPerson.templateSnapshot!, repairInputs);
    // 页面 updateActive('detail_insert_repair', draft => ...) 的应用形态
    const next: VisualProject = {
      ...withPerson,
      templateSnapshot: outcome.snapshot,
      renderingContract: outcome.snapshot.mediaStructure ?? withPerson.renderingContract,
    };
    expect(next.modification.person).toBe(person);
    expect(next.modification).toBe(withPerson.modification);
    expect(next.revision).toBe(withPerson.revision);
  });

  it('successfulRepairClearsBlockingError：修复后 §7/§41 阻断自动消失', () => {
    const project = projectWithDetailGroup(null);
    expect(validateAnimeCharacterConsistency(project).some(error => error.includes('尚未逐个识别'))).toBe(true);
    const outcome = mergeDetailInsertRepairResults(project.templateSnapshot!, repairInputs);
    const repaired: VisualProject = {
      ...project,
      templateSnapshot: outcome.snapshot,
      renderingContract: outcome.snapshot.mediaStructure ?? project.renderingContract,
    };
    expect(countInsertInstances(repaired.renderingContract).incompleteRegions).toHaveLength(0);
    expect(detailInsertIncompleteErrors(repaired)).toHaveLength(0);
    expect(validateAnimeCharacterConsistency(repaired).some(error => error.includes('尚未逐个识别'))).toBe(false);
  });

  it('originSkillSurvivesDetailRepair：Recipe 来源标记与 baselineSections 不因修复丢失', () => {
    const project = projectWithDetailGroup(null);
    const originSkill = {
      skillId: 'skill-origin-1',
      skillName: '动漫AI照片01 Skill',
      sourceProjectId: 'proj-1',
      sourceRevision: 3,
      baselineFinalPrompt: '基线 Prompt',
      baselineSections: ['image_role', 'rendering', 'anime_character', 'detail_insert_sync', 'template_preservation'],
      savedAt: '2026-08-01T00:00:00.000Z',
    };
    const recipeProject: VisualProject = { ...project, originSkill };
    const outcome = mergeDetailInsertRepairResults(recipeProject.templateSnapshot!, repairInputs);
    const next: VisualProject = {
      ...recipeProject,
      templateSnapshot: outcome.snapshot,
      renderingContract: outcome.snapshot.mediaStructure ?? recipeProject.renderingContract,
    };
    expect(next.originSkill).toBe(originSkill);
    expect(next.originSkill?.baselineSections).toEqual(originSkill.baselineSections);
  });
});

describe('Detail Insert Repair（UI 链路 wiring）', () => {
  it('detailInsertBlockerShowsRepairAction：Rail 阻断卡渲染「识别局部插图」Repair CTA', () => {
    expect(railSrc).toContain('局部插图尚未识别完整');
    expect(railSrc).toContain('识别局部插图');
    expect(railSrc).toContain('data-testid="detail-insert-repair"');
    // 失败态：重试 + 技术详情默认折叠
    expect(railSrc).toContain('局部插图识别失败');
    expect(railSrc).toMatch(/<details className="vision-rail-repair-tech">/);
    expect(railSrc).toContain('查看错误详情');
    // 成功态：绿色状态 + 查看识别结果
    expect(railSrc).toContain('data-testid="detail-insert-repair-success"');
    expect(railSrc).toContain('查看识别结果');
    // 可修复错误与普通阻断拆分渲染
    expect(railSrc).toContain('otherBlockingErrors');
    expect(railSrc).toContain('detailInsertIncompleteErrors');
  });

  it('repairActionUsesExistingInstanceExtraction：复用既有 visionExtractDetailInserts，无第二套识别', () => {
    // V6.2：执行体移入 detailInsertRepairRunner（识别调用唯一事实源），
    // 页面只保留配置解析 / 合并 / 语义修订
    expect(runnerSrc).toContain('api.visionExtractDetailInserts');
    expect(visionSrc).toContain('runDetailInsertRepair');
    expect(visionSrc).toContain('mergeDetailInsertRepairResults');
    expect(visionSrc).toContain("updateActive('detail_insert_repair'");
    // 只合并实例相关字段，不整写模板分析
    expect(visionSrc).toMatch(/templateSnapshot: merged/);
    expect(visionSrc).toMatch(/renderingContract: merged\.mediaStructure \?\? draft\.renderingContract/);
    expect(visionSrc).not.toContain('updateActiveMeta(draft => ({\n      ...draft,\n      templateSnapshot');
    // 局部插图实例清单展示（§9）
    expect(railSrc).toContain('局部插图');
    expect(railSrc).toContain('同步动漫主角色');
  });

  it('repairProgressHonesty：indeterminate + 真实阶段/层数/计时，无假百分比，可取消', () => {
    // Runner 进度模型只有真实事实：阶段 + 层数 + startedAt，没有 percent 字段
    expect(runnerSrc).not.toContain('percent');
    expect(runnerSrc).toContain("'preparing' | 'recognizing' | 'merging' | 'validating'");
    expect(runnerSrc).toContain('completedRegions');
    expect(runnerSrc).toContain('startedAt');
    expect(runnerSrc).toContain('detailRepairElapsedSeconds');
    // 取消 = 层间诚实停止（已完成层照常合并）
    expect(runnerSrc).toContain('isCancelled');
    expect(runnerSrc).toContain('cancelled && results.length === 0');
    // Rail：阶段 N/4 + 层数 + 已用时 + 停止按钮；动画条不带宽度百分比
    expect(railSrc).toContain('DETAIL_REPAIR_STAGES');
    expect(railSrc).toContain('已用时');
    expect(railSrc).toContain('停止识别');
    expect(railSrc).toContain('vision-rail-repair-bar');
    expect(railSrc).not.toContain('width: ');
    // 页面：进度按 projectId 隔离（切项目不渲染旧进度）
    expect(visionSrc).toContain('insertRepairProgress.projectId === activeProject?.id');
    expect(visionSrc).toContain('insertRepairCancelRef');
    // CSS：indeterminate 动画（animation，非静态填充百分比）
    expect(cssSrc).toContain('vision-repair-indeterminate');
  });

  it('repairMergeGuardsProjectSwitch：合并前 projectId 守卫，识别结果绝不写入其它项目', () => {
    expect(visionSrc).toContain("latest.id !== project.id");
    expect(visionSrc).toContain('项目已切换，本次识别结果已丢弃');
    // runner 对 applyResults=applied:false 按 error 处理（不静默丢弃）
    expect(runnerSrc).toContain('!outcome.applied');
  });
});
