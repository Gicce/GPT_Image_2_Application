import { describe, expect, it } from 'vitest';
import { fixtureAnalysis, fixtureProject } from './fixtures';
import {
  buildDimensionContracts,
  lockedDimensionKeys,
  lockBaselineValues,
  validateDimensionLockContract,
} from '../dimensionLock';
import { normalizeModificationContract } from '../project';
import { compileTemplatePreservationContract } from '../promptCompiler';
import {
  applyOptimizationResult,
  enforceOptimizerDimensionLocks,
  type RecreationFieldKey,
} from '../../recreationPlan';
import type { VisualProject } from '../types';

/**
 * Dimension Lock 回归（GUI 验收 Case C / §33）：
 * 用户只勾「修改人物 + 修改服装」时，动作 / 镜头 / 构图 / 背景 / 风格 等未选维度
 * 一律 LOCKED——优化器无权改写、编译器直接复制模板基线、生成前结构化校验兜底。
 */

function projectWithPersonAndClothing(): VisualProject {
  const project = fixtureProject();
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

const ALL_KEYS: RecreationFieldKey[] = [
  'subject', 'clothing', 'pose', 'composition', 'camera', 'scene', 'lighting', 'style', 'color',
];

describe('Dimension Lock（§11：未选维度 = locked）', () => {
  it('unselectedActionIsLocked：只改人物+服装时 pose ∈ lockedKeys', () => {
    const locked = new Set(lockedDimensionKeys(projectWithPersonAndClothing()));
    expect(locked.has('pose')).toBe(true);
  });

  it('unselectedCameraIsLocked：camera ∈ lockedKeys 且基线 = 模板镜头', () => {
    const project = projectWithPersonAndClothing();
    const locked = new Set(lockedDimensionKeys(project));
    expect(locked.has('camera')).toBe(true);
    expect(lockBaselineValues(project).camera).toBe(project.templateSnapshot!.camera.originalValue);
  });

  it('unselectedCompositionIsLocked：composition 恒 locked（无 Chip 入口）', () => {
    const project = fixtureProject();
    expect(lockedDimensionKeys(project)).toContain('composition');
  });

  it('personReplacementDoesNotUnlockAction：人物强替换不解锁动作', () => {
    const contracts = buildDimensionContracts(projectWithPersonAndClothing());
    expect(contracts.find(c => c.key === 'subject')?.mode).toBe('modified');
    expect(contracts.find(c => c.key === 'pose')?.mode).toBe('locked');
  });

  it('clothingReplacementDoesNotUnlockPose：使用人物参考服装不解锁动作', () => {
    const contracts = buildDimensionContracts(projectWithPersonAndClothing());
    expect(contracts.find(c => c.key === 'clothing')?.mode).toBe('modified');
    expect(contracts.find(c => c.key === 'pose')?.mode).toBe('locked');
  });

  it('启用「修改动作」后 pose 转 modified（§31 正向路径）', () => {
    const project = fixtureProject();
    const modified = normalizeModificationContract({
      ...project.modification,
      activeDimensions: ['pose'],
    });
    const contracts = buildDimensionContracts({ ...project, modification: modified });
    expect(contracts.find(c => c.key === 'pose')?.mode).toBe('modified');
    expect(contracts.find(c => c.key === 'camera')?.mode).toBe('locked');
  });

  it('用户手动开放（user_override 解锁）的维度视为 modified（尊重既有锁定三来源）', () => {
    const project = fixtureProject();
    const fields = project.workspace.recreation!.plan.fields
      .map(field => (field.key === 'style' ? { ...field, locked: false, lockSource: 'user_override' as const } : field));
    const unlocked = {
      ...project,
      workspace: { ...project.workspace, recreation: { ...project.workspace.recreation!, plan: { ...project.workspace.recreation!.plan, fields } } },
    };
    const contracts = buildDimensionContracts(unlocked);
    expect(contracts.find(c => c.key === 'style')?.mode).toBe('modified');
    expect(contracts.find(c => c.key === 'pose')?.mode).toBe('locked');
  });

  it('无模板快照时全部退化 modified（不阻断无模板流程）', () => {
    const project = fixtureProject();
    const withoutSnapshot: VisualProject = { ...project, templateSnapshot: undefined };
    expect(buildDimensionContracts(withoutSnapshot).every(c => c.mode === 'modified')).toBe(true);
    expect(validateDimensionLockContract(withoutSnapshot)).toEqual([]);
  });
});

describe('Optimizer 输出锁定清洗（§21/§22：不信模型自觉）', () => {
  const locks = {
    lockedKeys: ['pose', 'camera', 'composition'] as RecreationFieldKey[],
    baseline: { pose: '腾空上篮，单手扣篮', camera: '平视', composition: '主体居中偏左' },
  };

  it('optimizerCannotMutateLockedAction：changed 含 pose → 剔除并记违规', () => {
    const enforced = enforceOptimizerDimensionLocks(['subject', 'pose'], { subject: '黑发女性', pose: '站立比心' }, locks);
    expect(enforced.changedDimensions).toEqual(['subject']);
    expect(enforced.violations).toEqual(['pose']);
    expect(enforced.dimensionValues).toEqual({ subject: '黑发女性' });
  });

  it('optimizerCannotMutateLockedCamera（§24：eye-level + slightly top-down 被 reject）', () => {
    const enforced = enforceOptimizerDimensionLocks(['camera'], { camera: '平视，略带俯视' }, locks);
    expect(enforced.changedDimensions).toEqual([]);
    expect(enforced.violations).toEqual(['camera']);
    expect(enforced.dimensionValues.camera).toBeUndefined();
  });

  it('optimizerCannotMutateLockedComposition（§24：模板没有的 35% 数字绝不引入）', () => {
    const enforced = enforceOptimizerDimensionLocks(
      ['composition'],
      { composition: '左侧真人约35%，右侧动漫约46%' },
      locks,
    );
    expect(enforced.violations).toEqual(['composition']);
    expect(enforced.dimensionValues).toEqual({});
  });

  it('applyOptimizationResult：越权值被忽略、锁定维度回填模板基线、违规落 state', () => {
    const project = projectWithPersonAndClothing();
    const recreation = project.workspace.recreation!;
    const next = applyOptimizationResult(
      { ...recreation, editState: 'optimizing' },
      {
        optimizedPrompt: '将主体替换为人物参考中的女性……',
        optimizedNegativePrompt: '',
        summary: '替换人物与服装',
        changedDimensions: ['subject', 'clothing', 'pose', 'camera'],
        dimensionValues: {
          subject: '黑发女性',
          clothing: '人物参考服装',
          pose: '站立比心',
          camera: '平视，略带俯视',
        },
        dimensionLocks: {
          lockedKeys: lockedDimensionKeys(project),
          baseline: lockBaselineValues(project),
        },
      },
    );
    expect(next.optimizerViolations).toEqual(['pose', 'camera']);
    const fieldOf = (key: RecreationFieldKey) => next.plan.fields.find(f => f.key === key)!;
    // 锁定维度回到模板基线（历史漂移同时被修复）
    expect(fieldOf('pose').value).toBe(project.templateSnapshot!.action.originalValue);
    expect(fieldOf('camera').value).toBe(project.templateSnapshot!.camera.originalValue);
    expect(fieldOf('pose').locked).toBe(true);
    expect(fieldOf('camera').locked).toBe(true);
    // 修改维度保留优化器新值
    expect(fieldOf('subject').value).toBe('黑发女性');
  });
});

describe('生成前结构化校验（§20 Contract Validator）', () => {
  it('锁定维度与模板基线一致 → 无冲突', () => {
    expect(validateDimensionLockContract(projectWithPersonAndClothing())).toEqual([]);
  });

  it('锁定 pose 的方案值漂移 → 阻断并提示重新优化', () => {
    const project = projectWithPersonAndClothing();
    const fields = project.workspace.recreation!.plan.fields
      .map(field => (field.key === 'pose' ? { ...field, value: '站立比心' } : field));
    const drifted: VisualProject = {
      ...project,
      workspace: {
        ...project.workspace,
        recreation: { ...project.workspace.recreation!, plan: { ...project.workspace.recreation!.plan, fields } },
      },
    };
    const errors = validateDimensionLockContract(drifted);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('动作');
    expect(errors[0]).toContain('模板锁定规则冲突');
    expect(errors[0]).toContain('请重新优化 Prompt');
  });

  it('修改维度（pose ∈ activeDimensions）的值变化不触发阻断', () => {
    const project = fixtureProject();
    const modified = normalizeModificationContract({ ...project.modification, activeDimensions: ['pose'] });
    const fields = project.workspace.recreation!.plan.fields
      .map(field => (field.key === 'pose' ? { ...field, value: '站立比心' } : field));
    const drifted: VisualProject = {
      ...project,
      modification: modified,
      workspace: {
        ...project.workspace,
        recreation: { ...project.workspace.recreation!, plan: { ...project.workspace.recreation!.plan, fields } },
      },
    };
    expect(validateDimensionLockContract(drifted)).toEqual([]);
  });

  it('全部 9 维默认判定完整（subject+clothing 修改 ⇒ 其余 7 维锁定）', () => {
    const contracts = buildDimensionContracts(projectWithPersonAndClothing());
    const modified = contracts.filter(c => c.mode === 'modified').map(c => c.key);
    const locked = contracts.filter(c => c.mode === 'locked').map(c => c.key);
    expect(modified).toEqual(['subject', 'clothing']);
    expect(locked.sort()).toEqual(ALL_KEYS.filter(k => k !== 'subject' && k !== 'clothing').sort());
  });
});

describe('lockedDimensionsCompileFromTemplateSnapshot（§12/§17 编译层）', () => {
  it('锁定维度文本直接取模板基线 + 逐主体姿态块 + 唯一事实来源行', () => {
    const project = projectWithPersonAndClothing();
    const block = compileTemplatePreservationContract({
      project,
      activeDimensions: project.modification.activeDimensions,
    });
    expect(block).toContain('【模板保留合同】');
    expect(block).toContain('- 动作（分主体锁定');
    expect(block).toContain('成年男性篮球运动员（主体）：腾空上篮，单手扣篮');
    expect(block).toContain(`- 镜头：${project.templateSnapshot!.camera.originalValue}`);
    expect(block).toContain(`- 构图：${project.templateSnapshot!.composition.originalValue}`);
    expect(block).toContain('唯一事实来源');
    // 修改中的维度不得出现在保留合同里
    expect(block).not.toContain('- 服装');
  });

  it('启用「修改动作」时姿态块消失（动作进入修改通道）', () => {
    const project = fixtureProject();
    const modified = normalizeModificationContract({ ...project.modification, activeDimensions: ['pose'] });
    const block = compileTemplatePreservationContract({
      project: { ...project, modification: modified },
      activeDimensions: ['pose'],
    });
    expect(block).not.toContain('分主体锁定');
  });

  it('fixture 基线自检：模板快照动作 = 复刻方案 pose 初始值（同一分析冻结）', () => {
    const analysis = fixtureAnalysis();
    const project = fixtureProject({ analysis });
    const poseField = project.workspace.recreation!.plan.fields.find(f => f.key === 'pose')!;
    expect(project.templateSnapshot!.action.originalValue).toBe(poseField.originalValue);
  });
});
