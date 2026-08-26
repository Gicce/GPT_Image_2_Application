import { describe, expect, it } from 'vitest';
import { fixtureAnalysis, emptyWorkspace } from './fixtures';
import { createVisualProjectFromAnalysis, normalizeModificationContract } from '../project';
import { buildEffectiveVisualPlan, buildPlanSourceRef } from '../effectivePlan';
import { splitValueByRefs } from '../ContextRail';
import type { VisualProject } from '../types';

/**
 * 当前方案 @来源显示回归（不变量 4：可预览 / 可点击来源的 UI label 永不为空）：
 * 兜底链 = 显式名 > 文件 basename > 角色兜底名；超长名保留可见前缀；
 * label 含中文标点 / 空白时 chip 匹配不丢（不再空白点击区）。
 */

const LONG_HASH_NAME = '5d41e489bf96ce8b7d4f2a3c4d5e6f7a8b9c0d1e.jpg';

function projectWithPerson(person: {
  label?: string;
  path?: string;
  assetId?: string;
} | null): VisualProject {
  const analysis = fixtureAnalysis();
  const workspace = emptyWorkspace(analysis);
  const project = createVisualProjectFromAnalysis({
    name: '来源显示项目',
    analysis,
    plan: workspace.recreation!.plan,
    recreation: workspace.recreation!,
    sourceAsset: { path: 'D:/imgs/template.png', assetId: 'asset-1', source: 'gallery' },
    workspace,
  });
  const modification = normalizeModificationContract({
    freeText: '',
    activeDimensions: ['subject', 'clothing'],
    person: person && person.path
      ? {
        enabled: true,
        source: 'local',
        assetId: person.assetId,
        path: person.path,
        ...(person.label !== undefined ? { label: person.label } : {}),
        strength: 'strict',
        replaceScope: 'whole_person',
        preserveTemplateIdentity: false,
        applyIdentityTo: 'primary_subject_only',
      }
      : null,
    clothingPolicy: 'use_subject_reference',
    customClothing: '',
    replicationBoost: false,
    mentions: [],
    extraImageRefs: [],
  });
  return { ...project, modification };
}

describe('buildPlanSourceRef（不变量 4：label 永不为空）', () => {
  it('B1 显式 label 存在：label / fullLabel / roleNote 齐备', () => {
    const ref = buildPlanSourceRef({ key: 'person', label: '人物参考', path: 'D:/imgs/p.png', role: 'person' });
    expect(ref.label).toBe('人物参考');
    expect(ref.fullLabel).toBe('人物参考');
    expect(ref.roleNote).toContain('人物参考');
    expect(ref.path).toBe('D:/imgs/p.png');
  });

  it('B2 label 缺失但 basename 存在：fallback 到 basename（不空）', () => {
    const ref = buildPlanSourceRef({ key: 'person', path: `D:/imgs/${LONG_HASH_NAME}`, role: 'person' });
    expect(ref.label).toBeTruthy();
    expect(ref.fullLabel).toBe(LONG_HASH_NAME);
  });

  it('B3 label 与 basename 均缺失：fallback 到角色兜底名', () => {
    expect(buildPlanSourceRef({ key: 'tpl', role: 'template' }).label).toBe('模板图');
    expect(buildPlanSourceRef({ key: 'person', role: 'person' }).label).toBe('人物参考图');
    expect(buildPlanSourceRef({ key: 'm', role: 'mention' }).label).toBe('图片引用');
  });

  it('B4 超长名缩短：保留可见前缀与扩展名；fullLabel 完整', () => {
    const ref = buildPlanSourceRef({ key: 'person', label: LONG_HASH_NAME, path: 'D:/imgs/x.jpg', role: 'person' });
    expect(ref.label.length).toBeLessThanOrEqual(19);
    expect(ref.label.startsWith('5d41e489bf')).toBe(true);
    expect(ref.label.endsWith('.jpg')).toBe(true);
    expect(ref.label).toContain('…');
    expect(ref.fullLabel).toBe(LONG_HASH_NAME);
  });
});

describe('buildEffectiveVisualPlan（方案行来源显示）', () => {
  it('B2 人物 label 为空串 + 长哈希路径：行值与 chip 均显示缩短 basename，不出现空白', () => {
    const plan = buildEffectiveVisualPlan(projectWithPerson({ label: '', path: `D:/imgs/${LONG_HASH_NAME}` }));
    const identity = plan.rows.find(row => row.key === 'person_identity')!;
    expect(identity.value).toMatch(/^替换为 @5d41e489bf/);
    expect(identity.value).toContain('….jpg');
    const ref = identity.refs![0];
    expect(ref.label.startsWith('5d41e489bf')).toBe(true);
    expect(ref.fullLabel).toBe(LONG_HASH_NAME);
    // value 内嵌的 @label 与 ref.label 一致 ⇒ chip 可渲染（hover / click 可用）
    expect(identity.value).toContain(`@${ref.label}`);
    expect(ref.roleNote).toContain('人物参考');
  });

  it('模板行：无 displayName 时显示 @原图（产品口径兜底）且 refs 齐备', () => {
    const plan = buildEffectiveVisualPlan(fixtureProjectLike());
    const identity = plan.rows.find(row => row.key === 'person_identity')!;
    expect(identity.value).toBe('沿用 @原图');
    expect(identity.refs![0].label).toBe('原图');
    expect(identity.refs![0].path).toBe('D:/imgs/template.png');
    expect(identity.refs![0].fullLabel).toBe('原图');
  });

  it('服装行：使用人物参考的服装 → 绿色徽标 + 人物 ref 可溯源', () => {
    const plan = buildEffectiveVisualPlan(projectWithPerson({ label: '模特A', path: 'D:/imgs/model-a.png' }));
    const clothing = plan.rows.find(row => row.key === 'clothing')!;
    expect(clothing.value).toBe('使用 @模特A 的服装');
    expect(clothing.badge).toEqual({ text: '已替换', tone: 'success' });
    expect(clothing.refs![0].fullLabel).toBe('模特A');
  });
});

describe('splitValueByRefs（chip 匹配鲁棒性）', () => {
  it('label 含中文标点 / 括号：@token 仍切出 chip（旧正则会丢）', () => {
    const ref = buildPlanSourceRef({ key: 'p', label: '人物参考（新版）', path: 'D:/imgs/p.png', role: 'person' });
    const segments = splitValueByRefs(`替换为 @${ref.label}`, [ref]);
    expect(segments).toEqual([{ text: '替换为 ' }, { ref }]);
  });

  it('B4 窄宽度渲染：缩短 label 的 chip 段保留可见前缀（不出现空白点击区）', () => {
    const ref = buildPlanSourceRef({ key: 'p', label: LONG_HASH_NAME, path: 'D:/imgs/p.png', role: 'person' });
    const segments = splitValueByRefs(`替换为 @${ref.label}`, [ref]);
    expect(segments.length).toBe(2);
    expect('ref' in segments[1] ? segments[1].ref.label : '').toMatch(/^5d41e489bf.+\.jpg$/);
  });

  it('多 ref 混排 + 无 ref：全部正确切分', () => {
    const tpl = buildPlanSourceRef({ key: 't', label: '原图', path: 'D:/imgs/t.png', role: 'template' });
    const person = buildPlanSourceRef({ key: 'p', label: '模特A', path: 'D:/imgs/p.png', role: 'person' });
    const segments = splitValueByRefs('不保留（模板图 @原图 中的原人物身份；新身份来自 @模特A）', [tpl, person]);
    expect(segments.filter(segment => 'ref' in segment).length).toBe(2);
    expect(segments[0]).toEqual({ text: '不保留（模板图 ' });
  });
});

function fixtureProjectLike(): VisualProject {
  return projectWithPerson(null);
}
