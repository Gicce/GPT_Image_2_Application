/**
 * V6 Skill Recipe 回归（保存 → 载入 → 重建 → 同源编译）：
 *
 * 验收案例 = 混合媒介 GUI 真实案例（与 animeCharacter.test.ts 同源 fixture）：
 * 左真人 + 右动漫（wink）+ 三个动漫细节插图 + 霓虹贴纸 + 人物替换 strict。
 *
 * 铁律回归点：
 *  - 保存冻结「可重放 Recipe」而非摘要 Prompt（合同块 / 模板快照 / 媒介结构全保留）；
 *  - 快照 = 派生语义（人物 / 参考图 / 生成历史重置，旧描述不进入复用）；
 *  - 重建项目走同一条编译链 —— 最终 Prompt 结构与保存基线同级（含全部合同层）；
 *  - 隐私铁律：Recipe（含项目快照与本地路径）绝不进入投稿载荷。
 */

import { describe, expect, it } from 'vitest';
import type { VisionAnalysis } from '../../../types';
import { emptyWorkspace, fixtureAnalysis } from '../../vision/project/__tests__/fixtures';
import { createVisualProjectFromAnalysis, normalizeModificationContract } from '../../vision/project/project';
import { toModificationDraft } from '../../vision/project/project';
import { resolveGenerationImageReferences } from '../../vision/generationProvenance';
import { mergeFinalGenerationPrompt } from '../../vision/project/promptCompiler';
import { validateSkillOriginContractCoverage } from '../../vision/project/skillOriginGuard';
import type { VisualProject } from '../../vision/project/types';
import {
  buildProjectFromSkillRecipe,
  buildSkillRecipeFromProject,
  deriveSkillInputSlots,
  isTemplateReuseProject,
  normalizeSkillRecipe,
  skillPersonSlotRequired,
} from '../skillRecipe';
import {
  createUserSkillFromVisualProject,
  normalizeUserSkillDraft,
  sanitizeUserSkillForSubmission,
} from '../userSkill';

function mixedCaseAnalysis(): VisionAnalysis {
  const base = fixtureAnalysis();
  return {
    ...base,
    summary: '真人蹲姿女性与wink动漫女性的混合媒介拼贴',
    subjects: [
      {
        label: '真人女性', count: 1, appearance: ['黑长直发'], pose: '蹲姿，双手抱膝',
        action: null, gesture: null, facial_expression: '平静自然表情', gaze: '看向镜头',
        position: { x: 0.05, y: 0.3, width: 0.45, height: 0.65 }, orientation: '身体朝向右侧',
        clothing: ['黑色卫衣'], relations: [],
      },
      {
        label: '动漫女性', count: 1, appearance: ['银色双马尾'], pose: '站姿，重心在左腿',
        action: null, gesture: '右手比V字手势', facial_expression: '右眼闭合的wink眨眼', gaze: '看向镜头',
        position: { x: 0.55, y: 0.1, width: 0.4, height: 0.85 }, orientation: '身体朝向左侧',
        clothing: ['水手服'], relations: [],
      },
    ],
    media_structure: {
      overall_mode: 'mixed_media',
      preserve_template_media_structure: true,
      regions: [
        { label: '真人层（真人女性）', semantic_role: 'primary_subject', rendering_mode: 'photorealistic', identity_relation: 'template_identity' },
        { label: '动漫女性', semantic_role: 'secondary_subject', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary' },
        { label: '动漫面部特写相框', semantic_role: 'detail_insert', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary', description: '面部特写相框插图' },
        { label: '动漫眼部特写', semantic_role: 'detail_insert', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary', description: '眼部特写插图' },
        { label: '动漫发型特写', semantic_role: 'detail_insert', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary', description: '发型特写插图' },
        { label: '霓虹边框贴纸', semantic_role: 'graphic_decoration', rendering_mode: 'graphic_design', identity_relation: 'none' },
      ],
    },
  } as unknown as VisionAnalysis;
}

function mixedCaseProject(): VisualProject {
  const analysis = mixedCaseAnalysis();
  const workspace = emptyWorkspace(analysis);
  const project = createVisualProjectFromAnalysis({
    name: '混合媒介wink案例',
    analysis,
    plan: workspace.recreation!.plan,
    recreation: workspace.recreation!,
    sourceAsset: { path: 'D:/imgs/mixed.png', assetId: 'asset-mixed', source: 'gallery' },
    workspace,
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
      applyIdentityTo: 'all_corresponding_subjects',
    },
    clothingPolicy: 'use_subject_reference',
    customClothing: '',
    replicationBoost: false,
    mentions: [],
    extraImageRefs: [],
  });
  return { ...project, modification };
}

/** 重建项目 → 与视觉页 generateFromPlan 同源的编译（resolve refs → mergeFinalGenerationPrompt）。 */
function compileProject(project: VisualProject) {
  const draft = toModificationDraft(project.modification);
  const refs = resolveGenerationImageReferences({
    draft,
    sourcePath: project.sourceAsset.path || undefined,
    sourceAssetId: project.sourceAsset.assetId || undefined,
  });
  const personEnabled = refs.some(ref => ref.role === 'person_reference') && !!draft.person;
  return mergeFinalGenerationPrompt({
    project,
    finalDescription: project.workspace.promptDraft.trim(),
    negativePrompt: project.workspace.negativeDraft.trim(),
    imageReferences: refs,
    personReplacementEnabled: personEnabled,
  });
}

describe('V6 保存：项目 → Recipe（可重放方案，非摘要）', () => {
  it('混合媒介案例冻结完整结构：合同块 / 模板快照 / 媒介分层 / 姿态基线 / 编译基线', () => {
    const project = mixedCaseProject();
    const recipe = buildSkillRecipeFromProject(project);
    expect(isTemplateReuseProject(project)).toBe(true);
    expect(recipe.skillType).toBe('template_reuse');
    expect(recipe.template?.path).toBe('D:/imgs/mixed.png');
    // 快照核心结构完整
    expect(recipe.projectSnapshot).not.toBeNull();
    expect(recipe.projectSnapshot!.templateSnapshot).not.toBeNull();
    expect(recipe.projectSnapshot!.renderingContract?.overallMode).toBe('mixed_media');
    expect(recipe.projectSnapshot!.renderingContract!.regions.filter(r => r.semanticRole === 'detail_insert')).toHaveLength(3);
    expect((recipe.projectSnapshot!.templateSnapshot!.subjectPoses ?? []).length).toBeGreaterThanOrEqual(2);
    // 保存基线 Prompt 含全部合同层（结构级，不只是文本）
    for (const block of [
      'image_role', 'person_replacement', 'rendering', 'anime_character',
      'detail_insert_sync', 'expression_lock', 'clothing', 'template_preservation',
    ]) {
      expect(recipe.compilerSections).toContain(block);
    }
    expect(recipe.baselineFinalPrompt).toContain('动漫角色一致性合同');
    expect(recipe.baselineFinalPrompt).toContain('细节插图同步合同');
    // 人物合同配置冻结（强度 / 范围 / 应用主体）
    expect(recipe.personContractTemplate).toEqual({
      strength: 'strict',
      replaceScope: 'whole_person',
      applyIdentityTo: 'all_corresponding_subjects',
    });
  });

  it('快照 = 派生语义：人物 / 参考图 / 区域 / 生成历史全部重置（旧优化产物不进入复用）', () => {
    const project = mixedCaseProject();
    const recipe = buildSkillRecipeFromProject(project);
    const snapshot = recipe.projectSnapshot!;
    expect(snapshot.modification.person).toBeNull();
    expect(snapshot.references).toEqual([]);
    expect(snapshot.regions).toEqual([]);
    expect(snapshot.workspace.fullPromptOverride).toBeUndefined();
    expect(snapshot.workspace.iterations).toEqual([]);
    expect(snapshot.originSkill).toBeUndefined();
    expect(snapshot.animeCharacter).toBeUndefined();
    expect(snapshot.referenceAppearance).toBeUndefined();
    expect(snapshot.skillExecution).toBeUndefined();
    expect(snapshot.latestFinalPrompt).toBeUndefined();
  });

  it('无模板快照的项目 → generic Recipe（不伪造模板复用）', () => {
    const project = mixedCaseProject();
    const generic: VisualProject = { ...project, templateSnapshot: undefined, sourceAsset: { ...project.sourceAsset, path: '' } };
    const recipe = buildSkillRecipeFromProject(generic);
    expect(recipe.skillType).toBe('generic');
    expect(recipe.projectSnapshot).toBeNull();
    expect(recipe.template).toBeNull();
  });
});

describe('V6 载入：Recipe / 草稿合法化（旧数据兼容）', () => {
  it('JSON 往返（Rust save_user_skill 透传语义）保持 template_reuse 完整可执行', () => {
    const recipe = buildSkillRecipeFromProject(mixedCaseProject());
    const restored = normalizeSkillRecipe(JSON.parse(JSON.stringify(recipe)));
    expect(restored).not.toBeNull();
    expect(restored!.skillType).toBe('template_reuse');
    expect(restored!.template?.path).toBe('D:/imgs/mixed.png');
    expect(restored!.projectSnapshot?.templateSnapshot).not.toBeNull();
    expect(restored!.baselineFinalPrompt).toBe(recipe.baselineFinalPrompt);
  });

  it('残缺 Recipe 拒绝按模板复用执行：模板缺失 / 快照缺失 / 旧 schema 一律 null', () => {
    const recipe = buildSkillRecipeFromProject(mixedCaseProject());
    expect(normalizeSkillRecipe({ ...JSON.parse(JSON.stringify(recipe)), template: null })).toBeNull();
    expect(normalizeSkillRecipe({ ...JSON.parse(JSON.stringify(recipe)), projectSnapshot: null })).toBeNull();
    expect(normalizeSkillRecipe({ ...JSON.parse(JSON.stringify(recipe)), schemaVersion: 1 })).toBeNull();
    expect(normalizeSkillRecipe({ schemaVersion: 2, skillType: 'unknown' })).toBeNull();
    expect(normalizeSkillRecipe(null)).toBeNull();
  });

  it('v1 旧 Skill → generic（行为与旧链路完全一致）；损坏的 template_reuse 回落 generic', () => {
    const legacy = { id: 'skill-1', name: '旧技能', coreRules: ['规则一'], profiles: [{ id: 'p', name: '基线', kind: 'base', prompt: 'x' }] };
    const draft = normalizeUserSkillDraft(legacy);
    expect(draft).not.toBeNull();
    expect(draft!.skillType).toBe('generic');
    expect(draft!.recipe).toBeNull();

    const broken = {
      ...createUserSkillFromVisualProject(mixedCaseProject()),
      recipe: { schemaVersion: 2, skillType: 'template_reuse', template: null, projectSnapshot: null },
    };
    const fallen = normalizeUserSkillDraft(JSON.parse(JSON.stringify(broken)));
    expect(fallen!.skillType).toBe('generic');
    expect(fallen!.recipe).toBeNull();
  });
});

describe('V6 执行：Recipe 重建 → 同源编译（验收 Case 3/5：结构同级、插图同一角色）', () => {
  it('换人复用：重建项目 + 人物槽位绑定 → 编译产物含全部合同层且 Guard 通过', () => {
    const source = mixedCaseProject();
    const recipe = buildSkillRecipeFromProject(source);
    const rebuilt = buildProjectFromSkillRecipe(recipe, {
      skill: { id: 'skill-reuse', name: '混合媒介复用', sourceProjectId: source.id, sourceRevision: source.revision },
      person: { path: 'D:/imgs/new-person.png', label: '新人物', source: 'gallery', assetId: 'asset-person-2' },
    });
    expect(rebuilt).not.toBeNull();
    // 全新项目身份 + 来源标记（人物槽位绑定 = 语义事件，revision 0 → 1）
    expect(rebuilt!.id).not.toBe(source.id);
    expect(rebuilt!.revision).toBe(1);
    expect(rebuilt!.originSkill?.skillId).toBe('skill-reuse');
    expect(rebuilt!.originSkill?.baselineFinalPrompt).toBe(recipe.baselineFinalPrompt);
    // 人物槽位：换人合同（strict 默认绝不静默降级）
    expect(rebuilt!.references.some(ref => ref.kind === 'person')).toBe(true);
    expect(rebuilt!.modification.person?.enabled).toBe(true);
    expect(rebuilt!.modification.person?.strength).toBe('strict');
    expect(rebuilt!.modification.person?.preserveTemplateIdentity).toBe(false);

    const compiled = compileProject(rebuilt!);
    for (const block of [
      'image_role', 'person_replacement', 'rendering', 'anime_character',
      'detail_insert_sync', 'expression_lock', 'clothing', 'template_preservation',
    ]) {
      expect(compiled.sections).toContain(block);
    }
    // 插图跟随同一动漫角色（验收 Case 5）
    expect(compiled.prompt).toContain('动漫角色一致性合同');
    expect(compiled.prompt).toContain('细节插图同步合同');
    expect(compiled.prompt).toContain('同一发型与刘海');
    // 媒介分层不被降解为「普通并排图」（验收 Case 4）
    expect(compiled.prompt).toContain('混合媒介');
    // Skill Origin Guard：健康链路零阻断
    expect(validateSkillOriginContractCoverage(rebuilt!, compiled)).toEqual([]);
  });

  it('不绑人物：person 合同不编译，Guard 同样通过（按需未编译 ≠ 降级）', () => {
    const source = mixedCaseProject();
    const recipe = buildSkillRecipeFromProject(source);
    const rebuilt = buildProjectFromSkillRecipe(recipe, {
      skill: { id: 'skill-reuse-2', name: '混合媒介复用', sourceProjectId: source.id, sourceRevision: source.revision },
    });
    expect(rebuilt!.modification.person).toBeNull();
    const compiled = compileProject(rebuilt!);
    expect(compiled.sections).not.toContain('person_replacement');
    for (const block of ['image_role', 'rendering', 'anime_character', 'detail_insert_sync', 'expression_lock', 'template_preservation']) {
      expect(compiled.sections).toContain(block);
    }
    expect(validateSkillOriginContractCoverage(rebuilt!, compiled)).toEqual([]);
  });
});

describe('V6 隐私铁律：Recipe 绝不进入投稿载荷', () => {
  it('sanitizeUserSkillForSubmission 载荷不含 projectSnapshot / 本地路径 / 基线 Prompt', () => {
    const draft = createUserSkillFromVisualProject(mixedCaseProject());
    const { payload } = sanitizeUserSkillForSubmission(draft);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('projectSnapshot');
    expect(serialized).not.toContain('recipe');
    expect(serialized).not.toContain('D:/imgs');
    expect(serialized).not.toContain(draft.recipe!.baselineFinalPrompt.slice(0, 40));
  });
});

/** 修改合同变体工厂：同一模板，不同 人物启用 × 服装策略 组合。 */
function projectWithModification(option: {
  person: boolean;
  clothingPolicy: 'preserve_original' | 'use_subject_reference' | 'custom';
  customClothing?: string;
}): VisualProject {
  const base = mixedCaseProject();
  const person = option.person
    ? base.modification.person
    : null;
  const activeDimensions = option.clothingPolicy === 'preserve_original'
    ? ['subject' as const]
    : ['subject' as const, 'clothing' as const];
  const modification = normalizeModificationContract({
    freeText: '',
    activeDimensions,
    person,
    clothingPolicy: option.clothingPolicy,
    customClothing: option.clothingPolicy === 'custom' ? (option.customClothing ?? '白色高定西装，缎面领结') : '',
    replicationBoost: false,
    mentions: [],
    extraImageRefs: [],
  });
  return { ...base, modification };
}

describe('V6.3 Slot Contract V2：输入槽位由修改合同派生（禁止 UI 写死 person-only）', () => {
  it('combinedSlotForPersonClothing：人物 + 服装来自人物参考 ⇒ 一个必选 combined 槽（身份 + 服装徽标）', () => {
    const recipe = buildSkillRecipeFromProject(projectWithModification({ person: true, clothingPolicy: 'use_subject_reference' }));
    expect(recipe.modificationTemplate).toEqual({
      personEnabled: true,
      clothingPolicy: 'use_subject_reference',
      customClothing: '',
    });
    const person = deriveSkillInputSlots(recipe).find(slot => slot.id === 'person')!;
    expect(person.required).toBe(true);
    expect(person.usage).toBe('identity_clothing');
    expect(person.description).toContain('同时提供人物身份与服装');
    expect(person.description).toContain('姿势、构图、背景不会从该图继承');
    expect(skillPersonSlotRequired(recipe)).toBe(true);
    // 服装语义槽（clothing_text）不存在——服装由人物图提供，不是文本输入
    expect(deriveSkillInputSlots(recipe).some(slot => slot.id === 'clothing_text')).toBe(false);
  });

  it('identityOnlySlotWhenPreserveOriginal：人物 + 保留模板服装 ⇒ 仅身份槽（可选），无服装槽', () => {
    const recipe = buildSkillRecipeFromProject(projectWithModification({ person: true, clothingPolicy: 'preserve_original' }));
    const slots = deriveSkillInputSlots(recipe);
    const person = slots.find(slot => slot.id === 'person')!;
    expect(person.usage).toBe('identity');
    expect(person.required).toBe(false);
    expect(person.label).toBe('人物身份参考');
    expect(person.description).toContain('服装沿用模板');
    expect(slots.some(slot => slot.id === 'clothing_text')).toBe(false);
    expect(skillPersonSlotRequired(recipe)).toBe(false);
  });

  it('customClothingTextSlot：自定义服装 ⇒ 服装要求文本槽（默认文本 = 保存值）；无人物时也可独立成立', () => {
    const withPerson = buildSkillRecipeFromProject(projectWithModification({ person: true, clothingPolicy: 'custom', customClothing: '藏蓝旗袍，金色盘扣' }));
    const textSlot = deriveSkillInputSlots(withPerson).find(slot => slot.id === 'clothing_text')!;
    expect(textSlot.required).toBe(true);
    expect(textSlot.defaultText).toBe('藏蓝旗袍，金色盘扣');
    // 人物槽降为纯身份（服装按文本执行）
    expect(deriveSkillInputSlots(withPerson).find(slot => slot.id === 'person')!.usage).toBe('identity');

    const noPerson = buildSkillRecipeFromProject(projectWithModification({ person: false, clothingPolicy: 'custom', customClothing: '米白风衣' }));
    const slots = deriveSkillInputSlots(noPerson);
    expect(slots.map(slot => slot.id)).toEqual(['template', 'clothing_text']);
    expect(slots.find(slot => slot.id === 'clothing_text')!.defaultText).toBe('米白风衣');
  });

  it('preserveTemplateMeansNoExtraSlots：无人物 + 保留模板服装 ⇒ 只有模板槽；重建不产生人物合同', () => {
    const recipe = buildSkillRecipeFromProject(projectWithModification({ person: false, clothingPolicy: 'preserve_original' }));
    expect(deriveSkillInputSlots(recipe).map(slot => slot.id)).toEqual(['template']);
    const rebuilt = buildProjectFromSkillRecipe(recipe, {
      skill: { id: 's', name: 'n', sourceProjectId: 'p', sourceRevision: 1 },
    });
    expect(rebuilt!.modification.person).toBeNull();
    expect(rebuilt!.modification.clothingPolicy).toBe('preserve_original');
  });

  it('legacyRecipeFallsBack：旧 Recipe（无 modificationTemplate）⇒ 人物可换绑 + 保留模板服装（零迁移）', () => {
    const legacy = buildSkillRecipeFromProject(projectWithModification({ person: true, clothingPolicy: 'use_subject_reference' }));
    const raw = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>;
    delete raw.modificationTemplate;
    delete raw.slots;
    const restored = normalizeSkillRecipe(raw)!;
    expect(restored.modificationTemplate).toEqual({
      personEnabled: true, // personContractTemplate 存在 ⇒ 人物仍可换绑
      clothingPolicy: 'preserve_original', // 旧数据不知道服装策略 ⇒ 按旧行为保留模板
      customClothing: '',
    });
    expect(deriveSkillInputSlots(restored).find(slot => slot.id === 'person')!.required).toBe(false);
    // 存储的 slots 不再被信任：载入一律按 modificationTemplate 重派生
    const tampered = normalizeSkillRecipe({ ...raw, slots: [{ id: 'person', label: '伪造', fixed: false, required: false, description: '' }] })!;
    expect(deriveSkillInputSlots(tampered).find(slot => slot.id === 'person')!.label).not.toBe('伪造');
  });

  it('rebuildAppliesSavedClothingPolicy：保存「服装来自人物参考」⇒ 换人重建后合同仍为 use_subject_reference（不再退回保留模板）', () => {
    const recipe = buildSkillRecipeFromProject(projectWithModification({ person: true, clothingPolicy: 'use_subject_reference' }));
    const rebuilt = buildProjectFromSkillRecipe(recipe, {
      skill: { id: 's2', name: 'n2', sourceProjectId: 'p2', sourceRevision: 1 },
      person: { path: 'D:/imgs/next-person.png', label: '新人物', source: 'gallery' },
    })!;
    expect(rebuilt.modification.person?.enabled).toBe(true);
    expect(rebuilt.modification.clothingPolicy).toBe('use_subject_reference');
    expect(rebuilt.modification.activeDimensions).toContain('clothing');
  });
});
