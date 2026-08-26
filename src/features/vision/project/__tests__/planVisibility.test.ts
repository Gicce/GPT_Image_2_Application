import { describe, expect, it } from 'vitest';
import { fixtureProject } from './fixtures';
import { createVisualProjectFromAnalysis, normalizeModificationContract } from '../project';
import { buildEffectiveVisualPlan } from '../effectivePlan';
import { activeVisionPlanRules, ALWAYS_ON_RULES } from '../ruleRegistry';
import { emptyWorkspace } from './fixtures';
import { fixtureAnalysis } from './fixtures';
import type { VisualProject } from '../types';

/**
 * §A 来源可视 + §C 规则中心回归：
 * 当前方案卡必须让用户一眼看懂「哪些维度已替换、来源是哪张图、哪些锁定沿用模板」，
 * 且本方案启用的规则可见（不再黑盒）。
 */

function projectWithPerson(): VisualProject {
  const analysis = fixtureAnalysis();
  const workspace = emptyWorkspace(analysis);
  const project = createVisualProjectFromAnalysis({
    name: '人物替换项目',
    analysis,
    plan: workspace.recreation!.plan,
    recreation: workspace.recreation!,
    sourceAsset: { path: 'D:/imgs/template.png', assetId: 'asset-1', source: 'gallery' },
    workspace,
  });
  const modification = normalizeModificationContract({
    freeText: '',
    activeDimensions: ['subject', 'clothing'],
    person: {
      enabled: true,
      source: 'gallery',
      assetId: 'asset-person',
      path: 'D:/imgs/person.png',
      label: '人物参考',
      strength: 'strict',
      replaceScope: 'whole_person',
      preserveTemplateIdentity: false,
      applyIdentityTo: 'primary_subject_only',
    },
    clothingPolicy: 'use_subject_reference',
    customClothing: '',
    replicationBoost: true,
    mentions: [],
    extraImageRefs: [],
  });
  return { ...project, modification };
}

describe('buildEffectiveVisualPlan（§A 来源 refs + 状态徽标）', () => {
  it('人物替换：身份 / 服装行携带人物参考图 ref + 绿色「已替换」徽标', () => {
    const plan = buildEffectiveVisualPlan(projectWithPerson());
    const identity = plan.rows.find(row => row.key === 'person_identity')!;
    expect(identity.value).toBe('替换为 @人物参考');
    expect(identity.refs).toEqual([
      {
        key: 'person',
        label: '人物参考',
        fullLabel: '人物参考',
        roleNote: '类型：人物参考 · 作用：提供人物身份（与按合同的服装）',
        path: 'D:/imgs/person.png',
        assetId: 'asset-person',
        role: 'person',
      },
    ]);
    expect(identity.badge).toEqual({ text: '已替换', tone: 'success' });

    const clothing = plan.rows.find(row => row.key === 'clothing')!;
    expect(clothing.value).toBe('使用 @人物参考 的服装');
    expect(clothing.badge).toEqual({ text: '已替换', tone: 'success' });
    expect(clothing.refs?.[0]?.role).toBe('person');
  });

  it('模板人物行：明确「模板图 @原图 中的原人物身份」+ 双图 refs + 「不保留」警示徽标', () => {
    const plan = buildEffectiveVisualPlan(projectWithPerson());
    const row = plan.rows.find(item => item.key === 'template_identity')!;
    expect(row.value).toBe('不保留（模板图 @原图 中的原人物身份；新身份来自 @人物参考）');
    expect(row.refs?.map(ref => ref.role)).toEqual(['template', 'person']);
    expect(row.badge).toEqual({ text: '不保留', tone: 'warn' });
  });

  it('锁定维度行：来源 = 模板图 ref（动作 / 背景 / 镜头 / 风格 / 构图全部可溯源）', () => {
    const plan = buildEffectiveVisualPlan(projectWithPerson());
    for (const key of ['pose', 'scene', 'camera', 'style', 'composition']) {
      const row = plan.rows.find(item => item.key === key)!;
      expect(row.value).toBe('沿用 @原图');
      expect(row.kind).toBe('keep');
      expect(row.refs?.[0]).toMatchObject({ label: '原图', path: 'D:/imgs/template.png', role: 'template' });
    }
  });

  it('未替换人物：身份行沿用模板（keep、无徽标）；服装 keep 行双来源可溯源', () => {
    const plan = buildEffectiveVisualPlan(fixtureProject());
    const identity = plan.rows.find(row => row.key === 'person_identity')!;
    expect(identity.kind).toBe('keep');
    expect(identity.value).toBe('沿用 @原图');
    expect(identity.badge).toBeUndefined();
    expect(identity.refs?.[0]?.role).toBe('template');
  });
});

describe('activeVisionPlanRules（§C 规则中心）', () => {
  it('常驻规则恒生效（编译器 / 模板锁定 / 正文守卫 / 服装不变量 / 硬性合同）', () => {
    const rules = activeVisionPlanRules(fixtureProject());
    const ids = rules.map(rule => rule.id);
    for (const rule of ALWAYS_ON_RULES) {
      expect(ids).toContain(rule.id);
    }
    expect(ids).not.toContain('person_contract');
    expect(ids).not.toContain('replication_boost');
    expect(ids).not.toContain('mixed_media_structure');
  });

  it('按项目状态启用：人物合同 / 边界隔离 / 复刻度增强随条件出现', () => {
    const rules = activeVisionPlanRules(projectWithPerson());
    const ids = rules.map(rule => rule.id);
    expect(ids).toContain('person_contract');
    expect(ids).toContain('person_reference_isolation');
    expect(ids).toContain('replication_boost');
    expect(ids).toContain('per_subject_pose_lock'); // 动作未勾选 + 有逐主体姿态快照
  });

  it('动作勾选修改后：分主体动作锁定规则不再启用', () => {
    const project = projectWithPerson();
    const modified = normalizeModificationContract({
      ...project.modification,
      activeDimensions: ['subject', 'clothing', 'pose'],
    });
    const ids = activeVisionPlanRules({ ...project, modification: modified }).map(rule => rule.id);
    expect(ids).not.toContain('per_subject_pose_lock');
  });

  it('混合媒介项目启用媒介结构规则', () => {
    const analysis = fixtureAnalysis({
      mediaStructure: {
        overall_mode: 'mixed_media',
        preserve_template_media_structure: true,
        regions: [
          { label: '真人层', semantic_role: 'primary_subject', rendering_mode: 'photorealistic', identity_relation: 'template_identity' },
        ],
      },
    });
    const workspace = emptyWorkspace(analysis);
    const project = createVisualProjectFromAnalysis({
      name: '混合媒介',
      analysis,
      plan: workspace.recreation!.plan,
      recreation: workspace.recreation!,
      sourceAsset: { path: 'D:/imgs/mixed.png', source: 'local_import' },
      workspace,
    });
    const ids = activeVisionPlanRules(project).map(rule => rule.id);
    expect(ids).toContain('mixed_media_structure');
  });
});
