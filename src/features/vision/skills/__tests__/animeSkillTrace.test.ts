/**
 * 动漫角色一致性 / 细节插图同步 —— Runtime Skill 执行与依赖测试（§51）。
 *
 * 依赖链（§39）：
 *   PersonReplacement / ClothingSource / HybridMedia
 *        ↓
 *   AnimeCharacterConsistency ↓ DetailInsertSync ↓ PromptCompilation
 */

import { describe, expect, it } from 'vitest';
import { executeRuntimeSkills, buildSkillExecutionSnapshot } from '../engine';
import { BUILT_IN_RUNTIME_SKILLS, runtimeSkillExecutionOrder } from '../registry';
import { buildSkillTraceMarkdown } from '../exportTrace';
import { emptyWorkspace, fixtureAnalysis, fixtureProject } from '../../project/__tests__/fixtures';
import { createVisualProjectFromAnalysis, normalizeModificationContract } from '../../project/project';
import type { GenerationImageReference, VisionAnalysis } from '../../../../types';
import type { VisualProject } from '../../project/types';

function mixedAnimeProject(): VisualProject {
  const analysis = fixtureAnalysis({
    mediaStructure: {
      overall_mode: 'mixed_media',
      preserve_template_media_structure: true,
      regions: [
        { label: '真人层（真人女性）', semantic_role: 'primary_subject', rendering_mode: 'photorealistic', identity_relation: 'template_identity' },
        { label: '动漫女性', semantic_role: 'secondary_subject', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary' },
        { label: '动漫面部特写相框', semantic_role: 'detail_insert', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary' },
        { label: '动漫眼部特写', semantic_role: 'detail_insert', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary' },
      ],
    },
  }) as never as ReturnType<typeof fixtureAnalysis>;
  const subjects = [
    {
      label: '真人女性', count: 1, appearance: ['黑长直发'], pose: '蹲姿', action: null,
      facial_expression: '平静自然表情', gaze: '看向镜头', clothing: ['黑色卫衣'], relations: [],
    },
    {
      label: '动漫女性', count: 1, appearance: ['银发'], pose: '站姿', action: null,
      gesture: '右手比V字手势', facial_expression: '右眼闭合的wink眨眼', gaze: '看向镜头',
      clothing: ['水手服'], relations: [],
    },
  ];
  const withSubjects = { ...analysis, subjects } as VisionAnalysis;
  const workspace = emptyWorkspace(withSubjects);
  const project = createVisualProjectFromAnalysis({
    name: '技能依赖案例',
    analysis: withSubjects,
    plan: workspace.recreation!.plan,
    recreation: workspace.recreation!,
    sourceAsset: { path: 'D:/imgs/mixed.png', assetId: 'asset-mixed', source: 'gallery' },
    workspace,
  });
  const modification = normalizeModificationContract({
    freeText: '',
    activeDimensions: ['subject', 'clothing'],
    person: {
      enabled: true, source: 'local', path: 'D:/imgs/person.png', label: '人物参考',
      strength: 'strict', replaceScope: 'whole_person', preserveTemplateIdentity: false,
      applyIdentityTo: 'all_corresponding_subjects',
    },
    clothingPolicy: 'use_subject_reference', customClothing: '', replicationBoost: false,
    mentions: [], extraImageRefs: [],
  });
  return { ...project, modification };
}

const IMAGE_REFS: GenerationImageReference[] = [
  { path: 'D:/imgs/mixed.png', label: '原图', role: 'template' },
  { path: 'D:/imgs/person.png', label: '人物参考', role: 'person_reference' },
];

describe('§40 注册表：priority / dependsOn 拓扑', () => {
  it('runtimeSkillExecutionOrder 满足全部 dependsOn（依赖者必在被依赖者之后）', () => {
    const order = runtimeSkillExecutionOrder();
    const indexOf = new Map(order.map((skill, index) => [skill.id, index]));
    for (const skill of BUILT_IN_RUNTIME_SKILLS) {
      for (const dependency of skill.dependsOn ?? []) {
        expect(indexOf.get(skill.id)!).toBeGreaterThan(indexOf.get(dependency)!);
      }
    }
  });

  it('animeCharacterConsistencySkillRunsAfterPersonReplacement / ClothingSource / HybridMedia', () => {
    const order = runtimeSkillExecutionOrder().map(skill => skill.id);
    const idx = (id: string) => order.indexOf(id);
    expect(idx('anime_character_consistency')).toBeGreaterThan(idx('person_replacement'));
    expect(idx('anime_character_consistency')).toBeGreaterThan(idx('clothing_source'));
    expect(idx('anime_character_consistency')).toBeGreaterThan(idx('hybrid_media_preservation'));
  });

  it('detailInsertSyncDependsOnAnimeCharacterConsistency（且先于 Prompt 编译）', () => {
    const order = runtimeSkillExecutionOrder().map(skill => skill.id);
    const idx = (id: string) => order.indexOf(id);
    expect(idx('detail_insert_sync')).toBeGreaterThan(idx('anime_character_consistency'));
    expect(idx('prompt_compilation')).toBeGreaterThan(idx('detail_insert_sync'));
  });

  it('执行顺序与注册表派生顺序一致（引擎不依赖对象遍历顺序）', () => {
    const records = executeRuntimeSkills({ project: mixedAnimeProject(), imageReferences: IMAGE_REFS });
    const expected = runtimeSkillExecutionOrder().map(skill => skill.id);
    expect(records.map(record => record.skillId)).toEqual(expected);
  });
});

describe('§11-§13 技能执行记录（混合媒介案例）', () => {
  const records = executeRuntimeSkills({ project: mixedAnimeProject(), imageReferences: IMAGE_REFS });
  const byId = new Map(records.map(record => [record.skillId, record]));

  it('skillTraceContainsCanonicalCharacterConstraints：动漫角色一致性已执行 + 🔒 硬约束', () => {
    const record = byId.get('anime_character_consistency')!;
    expect(record.status).toBe('applied');
    const dimensions = record.hardConstraints.map(constraint => constraint.dimension);
    expect(dimensions).toContain('anime_character.id');
    expect(dimensions).toContain('anime_character.hair');
    expect(dimensions).toContain('anime_character.face');
    expect(dimensions).toContain('anime_character.eyes');
    expect(dimensions).toContain('anime_character.clothing');
    expect(record.promptContributions[0].finalText).toContain('【动漫角色一致性合同（强制执行）】');
    expect(record.findings.some(finding => finding.title.includes('人物身份绑定'))).toBe(true);
  });

  it('skillTraceContainsDetailInsertBindings：细节插图同步展示同步目标 @动漫主角色', () => {
    const record = byId.get('detail_insert_sync')!;
    expect(record.status).toBe('applied');
    const targetFinding = record.findings.find(finding => finding.id === 'insert-sync-target')!;
    expect(targetFinding.title).toContain('@动漫主角色');
    for (const constraint of record.hardConstraints) {
      expect(constraint.value).toContain(`characterRef=canonical-anime-character`);
    }
    expect(record.promptContributions[0].finalText).toContain('【细节插图同步合同（强制执行）】');
  });

  it('单一媒介模板 ⇒ 两个新技能 skipped 且给出人话原因', () => {
    const plain = executeRuntimeSkills({ project: fixtureProject(), imageReferences: IMAGE_REFS });
    const anime = plain.find(record => record.skillId === 'anime_character_consistency')!;
    const insert = plain.find(record => record.skillId === 'detail_insert_sync')!;
    expect(anime.status).toBe('skipped');
    expect(anime.skippedReason).toContain('不是混合媒介');
    expect(insert.status).toBe('skipped');
  });

  it('§14 Markdown 导出包含「动漫角色一致性 / 细节插图同步」两节（五阶段结构）', () => {
    const snapshot = buildSkillExecutionSnapshot({
      project: mixedAnimeProject(),
      imageReferences: IMAGE_REFS,
    });
    const markdown = buildSkillTraceMarkdown(snapshot, { projectName: '技能依赖案例' });
    expect(markdown).toContain('动漫角色一致性');
    expect(markdown).toContain('细节插图同步');
    expect(markdown).toMatch(/## \d+\. 动漫角色一致性[\s\S]*?### 发现[\s\S]*?### 建议[\s\S]*?### 系统强制[\s\S]*?### Prompt 写入/);
    expect(markdown).toMatch(/## \d+\. 细节插图同步[\s\S]*?### 发现/);
  });
});
