/**
 * V6.2 Skill Direct Execution（P0）回归：
 *  - SkillExecutionMode / SkillOptimizationPolicy 落库 + 旧 Recipe 默认
 *    direct_generate / reuse_recipe（不重新优化，绝不偷偷调优化器）；
 *  - ephemeral 项目构建（不写 store）+ 人物槽位换绑（strict 合同套用）；
 *  - Preflight：detail_insert 缺实例 = 弹窗内可原位 Repair；strict 动漫一致性
 *    = 只能进工作台（直接生成绝不后台生成角色参考图）；
 *  - 内嵌 Repair 合并：对 ephemeral 项目文档纯函数合并（零 store 写入）；
 *  - 直接执行：同步零 AI 调用 → carry（autoStartGeneration + skillSession +
 *    provenance.skillOrigin）；Preflight 阻断 ⇒ 不产出 carry；
 *  - UI 接线：使用弹窗双按钮（快速生成 / 高级调整）+ 同一 Repair Runner；
 *    创作器 Step3 文案 = 「AI 提炼复用规则」（不得宣称生成"通用 Skill"）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { VisionAnalysis } from '../../../types';
import { emptyWorkspace, fixtureAnalysis } from '../../vision/project/__tests__/fixtures';
import { createVisualProjectFromAnalysis, normalizeModificationContract } from '../../vision/project/project';
import { templateBaselineOf } from '../../vision/project/dimensionLock';
import { needsOptimization } from '../../vision/recreationPlan';
import type { VisualProject } from '../../vision/project/types';
import { buildProjectFromSkillRecipe, buildSkillRecipeFromProject, skillPersonSlotRequired } from '../skillRecipe';
import { createUserSkillFromVisualProject, normalizeUserSkillDraft, type UserSkillDraft } from '../userSkill';
import {
  applyDetailInsertRepairToEphemeral,
  buildEphemeralSkillProject,
  canDirectExecuteSkill,
  classifySkillDirectPreflight,
  executeTemplateSkillDirect,
  preflightSkillDirectExecution,
  type SkillDirectBlocker,
} from '../skillDirectExecution';

const DIALOG_SRC = readFileSync(new URL('../TemplateSkillUseDialog.tsx', import.meta.url), 'utf-8');
const CREATOR_SRC = readFileSync(new URL('../SkillCreatorDialog.tsx', import.meta.url), 'utf-8');
const PIPELINE_SRC = readFileSync(new URL('../skillDirectExecution.ts', import.meta.url), 'utf-8');

function mixedCaseAnalysis(detailDescription: string): VisionAnalysis {
  const base = fixtureAnalysis();
  return {
    ...base,
    summary: '真人与动漫主体的混合媒介拼贴',
    subjects: [
      {
        label: '真人女性', count: 1, appearance: ['黑长直发'], pose: '蹲姿', action: null, gesture: null,
        facial_expression: '平静', gaze: '看向镜头', position: { x: 0.05, y: 0.3, width: 0.45, height: 0.65 },
        orientation: '身体朝向右侧', clothing: ['黑色卫衣'], relations: [],
      },
      {
        label: '动漫女性', count: 1, appearance: ['银色双马尾'], pose: '站姿', action: null, gesture: '右手比V字手势',
        facial_expression: 'wink眨眼', gaze: '看向镜头', position: { x: 0.55, y: 0.1, width: 0.4, height: 0.85 },
        orientation: '身体朝向左侧', clothing: ['水手服'], relations: [],
      },
    ],
    media_structure: {
      overall_mode: 'mixed_media',
      preserve_template_media_structure: true,
      regions: [
        { label: '真人层', semantic_role: 'primary_subject', rendering_mode: 'photorealistic', identity_relation: 'template_identity' },
        { label: '动漫女性', semantic_role: 'secondary_subject', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary' },
        { label: '动漫面部特写相框', semantic_role: 'detail_insert', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary', description: detailDescription },
      ],
    },
  } as unknown as VisionAnalysis;
}

function mixedCaseProject(detailDescription = '面部特写相框插图'): VisualProject {
  const analysis = mixedCaseAnalysis(detailDescription);
  const workspace = emptyWorkspace(analysis);
  const project = createVisualProjectFromAnalysis({
    name: '混合媒介案例',
    analysis,
    plan: workspace.recreation!.plan,
    recreation: workspace.recreation!,
    sourceAsset: { path: 'D:/imgs/mixed.png', assetId: 'asset-mixed', source: 'gallery' },
    workspace,
  });
  const modification = normalizeModificationContract({
    freeText: '',
    activeDimensions: ['subject'],
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

function draftOf(project: VisualProject): UserSkillDraft {
  return createUserSkillFromVisualProject(project);
}

const PERSON_BINDING = {
  path: 'D:/imgs/new-person.png',
  label: '新人物',
  source: 'gallery' as const,
  assetId: 'asset-person-2',
};

describe('V6.2 P0：执行方式 / Prompt 策略字段（旧数据兼容）', () => {
  it('legacyDraftDefaultsToDirectAndReuse：v1 / 旧 v2 Skill 默认快速生成 + 复用保存基线', () => {
    const legacy = { id: 'skill-legacy', name: '旧技能', coreRules: ['规则一'], profiles: [{ id: 'p', name: '基线', kind: 'base', prompt: 'x' }] };
    const v1 = normalizeUserSkillDraft(legacy);
    expect(v1!.executionMode).toBe('direct_generate');
    expect(v1!.optimizationPolicy).toBe('reuse_recipe');

    const v2WithoutFields = JSON.parse(JSON.stringify(draftOf(mixedCaseProject()))) as UserSkillDraft;
    delete (v2WithoutFields as Partial<UserSkillDraft>).executionMode;
    delete (v2WithoutFields as Partial<UserSkillDraft>).optimizationPolicy;
    const restored = normalizeUserSkillDraft(v2WithoutFields);
    expect(restored!.executionMode).toBe('direct_generate');
    expect(restored!.optimizationPolicy).toBe('reuse_recipe');
  });

  it('creatorPersistsNewFields：新建草稿携带 direct_generate / reuse_recipe 并可在 Step0 修改', () => {
    const draft = draftOf(mixedCaseProject());
    expect(draft.executionMode).toBe('direct_generate');
    expect(draft.optimizationPolicy).toBe('reuse_recipe');
    expect(CREATOR_SRC).toContain('skill-execution-mode-field');
    expect(CREATOR_SRC).toContain('skill-optimization-policy-field');
  });
});

describe('V6.2 P0：ephemeral 项目 + Preflight', () => {
  it('buildEphemeralSkillProjectRebindsPerson：换人 → strict 合同套用，项目不进 store', () => {
    const draft = draftOf(mixedCaseProject());
    const built = buildEphemeralSkillProject({ draft, person: PERSON_BINDING });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.personRebound).toBe(true);
    expect(built.project.modification.person?.enabled).toBe(true);
    expect(built.project.modification.person?.strength).toBe('strict');
    expect(built.project.references.some(ref => ref.kind === 'person' && ref.path === PERSON_BINDING.path)).toBe(true);
    expect(built.project.originSkill?.skillId).toBe(draft.id);
  });

  it('preflightDetectsRepairableDetailInsertBlocker：多插图声明 + 无实例 = 可原位 Repair', () => {
    const draft = draftOf(mixedCaseProject('左上多个不同的动漫特写插图画框'));
    const built = buildEphemeralSkillProject({ draft, person: PERSON_BINDING });
    if (!built.ok) throw new Error(built.error);
    const preflight = preflightSkillDirectExecution({ project: built.project });
    expect(preflight.ok).toBe(false);
    const blocker = preflight.blockers.find(item => item.repairable === 'detail_insert');
    expect(blocker).not.toBeNull();
    expect(blocker!.message).toContain('局部插图');
  });

  it('preflightDetectsStrictAnimeBlockerWorkbenchOnly：strict 模式无角色资产 = 不可弹窗内修复', () => {
    const draft = draftOf(mixedCaseProject());
    const recipe = draft.recipe!;
    draft.recipe = {
      ...recipe,
      projectSnapshot: { ...recipe.projectSnapshot!, animeConsistency: { mode: 'strict_visual_reference' } },
    };
    const built = buildEphemeralSkillProject({ draft, person: PERSON_BINDING });
    if (!built.ok) throw new Error(built.error);
    const preflight = preflightSkillDirectExecution({ project: built.project });
    expect(preflight.ok).toBe(false);
    const blocker = preflight.blockers.find(item => item.code === 'anime_character_required');
    expect(blocker).not.toBeNull();
    expect(blocker!.repairable).toBeNull();
    expect(blocker!.message).toContain('动漫角色参考图');
  });

  it('embeddedRepairMergesIntoEphemeralDoc：合并实例后 Preflight 通过（零 store 写入）', () => {
    const draft = draftOf(mixedCaseProject('左上多个不同的动漫特写插图画框'));
    const built = buildEphemeralSkillProject({ draft, person: PERSON_BINDING });
    if (!built.ok) throw new Error(built.error);
    const regionId = built.project.renderingContract!.regions
      .find(region => region.semanticRole === 'detail_insert')!.id;
    const applied = applyDetailInsertRepairToEphemeral(built.project, [{
      regionId,
      instances: [{
        label: '面部特写',
        cropType: 'face',
        mediaType: 'anime_illustration',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        description: '面部特写',
      }],
    }]);
    expect(applied.applied).toBe(true);
    if (!applied.applied) return;
    expect(applied.project.templateSnapshot).not.toBe(built.project.templateSnapshot); // 不可变合并
    const preflight = preflightSkillDirectExecution({ project: applied.project });
    expect(preflight.ok).toBe(true);
  });
});

describe('V6.2 P0：headless 直接执行（零 AI 调用）', () => {
  it('directExecuteHappyPath：同步执行 → carry 自动生成 + skillSession + 溯源 skillOrigin', () => {
    const draft = draftOf(mixedCaseProject());
    const result = executeTemplateSkillDirect({
      draft,
      person: PERSON_BINDING,
      optimizationPolicy: draft.optimizationPolicy,
      regionContractDisabled: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 同步零 IO：直接生成绝不等待模型（源码层不含优化器 / 视觉调用）
    expect(PIPELINE_SRC).not.toContain('runRecreationIteration');
    expect(PIPELINE_SRC).not.toContain('runVisionAnalysis');
    expect(PIPELINE_SRC).not.toContain('optimizePrompt');
    // carry：自动发起（报价确认照常）+ ephemeral 会话
    expect(result.carry.autoStartGeneration).toBe(true);
    expect(result.carry.skillSession.skillId).toBe(draft.id);
    expect(result.carry.skillSession.executionMode).toBe('direct_generate');
    expect(result.carry.skillSession.optimizationPolicy).toBe('reuse_recipe');
    expect(result.carry.skillSession.personRebound).toBe(true);
    expect(result.carry.skillSession.project.id).toBe(result.project.id);
    // 参考图语义：模板 → 人物（顺序 = 提交顺序）
    expect(result.carry.imageReferences!.map(ref => ref.role)).toEqual(['template', 'person_reference']);
    // 溯源：skillOrigin 冻结直接生成事实
    expect(result.carry.provenance?.skillOrigin).toMatchObject({
      skillId: draft.id,
      executionMode: 'direct_generate',
      optimizationPolicy: 'reuse_recipe',
      personRebound: true,
      projectKind: 'ephemeral',
    });
    // 复用冻结基线重编译：合同层全部进入最终 Prompt（非摘要 Prompt）
    expect(result.carry.prompt).toContain('动漫角色一致性合同');
    expect(result.carry.promptCompiled).toBe(true);
    expect(result.carry.taskPlanSummary).toContain(draft.name);
    // 优化标记：ImageStudio 提交时禁止再次自动优化
    expect(result.carry.optimization?.originalPrompt).toBeTruthy();
  });

  it('directExecuteBlockedByPreflight：strict 动漫一致性 ⇒ 不产出 carry（提示进工作台）', () => {
    const draft = draftOf(mixedCaseProject());
    const recipe = draft.recipe!;
    draft.recipe = {
      ...recipe,
      projectSnapshot: { ...recipe.projectSnapshot!, animeConsistency: { mode: 'strict_visual_reference' } },
    };
    const result = executeTemplateSkillDirect({
      draft,
      // V6.3：绑定人物（本 Skill 人物槽位必选）以越过 needs_input，验证动漫硬阻断本身
      person: PERSON_BINDING,
      optimizationPolicy: 'reuse_recipe',
      regionContractDisabled: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('动漫角色参考图');
  });

  it('canDirectExecuteSkill：generic / 残缺 Recipe 不具备直接生成前提', () => {
    expect(canDirectExecuteSkill(draftOf(mixedCaseProject()))).toBe(true);
    const generic = draftOf(mixedCaseProject());
    expect(canDirectExecuteSkill({ ...generic, recipe: null })).toBe(false);
  });
});

describe('V6.2 P0：UI 接线（使用弹窗 / 创作器）', () => {
  it('useDialogOffersDualModesAndEmbeddedRepair：快速生成 + 高级调整 + 同一 Repair Runner', () => {
    expect(DIALOG_SRC).toContain('快速生成');
    expect(DIALOG_SRC).toContain('高级调整');
    // 内嵌 Repair 复用同一执行体（零平行系统）
    expect(DIALOG_SRC).toContain('runDetailInsertRepair');
    expect(DIALOG_SRC).toContain('applyDetailInsertRepairToEphemeral');
    // 快速生成 → carry + 图片工作室（不 adopt 项目）；高级调整 → adopt + 视觉工作台
    expect(DIALOG_SRC).toContain('setVisionCarry');
    expect(DIALOG_SRC).toContain('adoptProject');
    // 进度诚实：阶段 / 已用时 / 停止（无百分比）
    expect(DIALOG_SRC).toContain('detailRepairStageLabel');
    expect(DIALOG_SRC).toContain('detailRepairElapsedSeconds');
    expect(DIALOG_SRC).toContain('停止识别');
    expect(DIALOG_SRC).not.toContain('percent');
  });

  it('creatorStep3ClaimsRuleExtractionNotGenericSkill：不得宣称"AI 整理为通用 Skill"', () => {
    expect(CREATOR_SRC).not.toContain('AI 整理为通用 Skill');
    expect(CREATOR_SRC).toContain('AI 提炼复用规则');
    expect(CREATOR_SRC).toContain('开始 AI 提炼复用规则');
  });
});

/**
 * V6.3 Direct Preflight 四态（§15-§20）：
 * ready（绿 ✓ 可以快速生成）/ repairable（橙 还差 1 步）/ needs_input（业务输入，
 * 不是错误）/ blocked（红 进工作台）。快速生成绝不能建议「重新优化 Prompt」（§21-§24）。
 */
function blockersOf(...blockers: SkillDirectBlocker[]) {
  return { blockers };
}

describe('V6.3：Preflight Status 四态分类（classifySkillDirectPreflight）', () => {
  it('statusReady：零阻断 ⇒ ready', () => {
    expect(classifySkillDirectPreflight(blockersOf())).toBe('ready');
  });

  it('statusRepairable：软阻断（detail_insert 可原位修复）⇒ repairable', () => {
    const blocker: SkillDirectBlocker = {
      code: 'detail_insert_incomplete', message: '局部插图缺实例', repairable: 'detail_insert',
    };
    expect(classifySkillDirectPreflight(blockersOf(blocker))).toBe('repairable');
  });

  it('statusNeedsInput：业务输入缺失（人物参考 / 服装要求）⇒ needs_input，不是错误', () => {
    const needsPerson: SkillDirectBlocker = {
      code: 'needs_input', message: '请先绑定人物参考', repairable: null,
    };
    const needsClothing: SkillDirectBlocker = {
      code: 'clothing', message: '自定义服装描述为空', repairable: null,
    };
    expect(classifySkillDirectPreflight(blockersOf(needsPerson))).toBe('needs_input');
    expect(classifySkillDirectPreflight(blockersOf(needsClothing))).toBe('needs_input');
    // 业务输入优先于可修复展示（用户先选图，修复才有意义）
    expect(classifySkillDirectPreflight(blockersOf(needsPerson, {
      code: 'detail_insert_incomplete', message: 'x', repairable: 'detail_insert',
    }))).toBe('needs_input');
  });

  it('statusBlocked：方案级硬阻断（动漫 strict）⇒ blocked，唯一出口 = 工作台', () => {
    const blocker: SkillDirectBlocker = {
      code: 'anime_character_required', message: '需要动漫角色参考图', repairable: null,
    };
    expect(classifySkillDirectPreflight(blockersOf(blocker))).toBe('blocked');
  });

  it('preflightFlagsPersonRequired：服装来自人物参考的 Skill 未绑人物 ⇒ needs_input 阻断 + 用户语言文案', () => {
    const draft = draftOf(mixedCaseProject()); // clothingPolicy = use_subject_reference
    expect(skillPersonSlotRequired(draft.recipe!)).toBe(true);
    const built = buildEphemeralSkillProject({ draft }); // 不绑人物
    if (!built.ok) throw new Error(built.error);
    const preflight = preflightSkillDirectExecution({ project: built.project, personRequired: true });
    expect(preflight.ok).toBe(false);
    const blocker = preflight.blockers.find(item => item.code === 'needs_input')!;
    expect(blocker).toBeDefined();
    expect(blocker.message).toContain('人物参考');
    expect(classifySkillDirectPreflight(preflight)).toBe('needs_input');
    // 直接执行同参 ⇒ 阻断（不产出 carry，绝不静默沿用模板人物）
    const result = executeTemplateSkillDirect({ draft, optimizationPolicy: 'reuse_recipe', regionContractDisabled: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('人物参考');
  });
});

describe('V6.3：Direct Compile 铁律（换素材 ≠ 重新优化）', () => {
  /** 保存时刻「脏」的项目：旧人物优化产物留在 plan.fields + 优化执行状态未归零。 */
  function dirtySavedProject(): VisualProject {
    const project = mixedCaseProject();
    const recreation = project.workspace.recreation!;
    const drifted = recreation.plan.fields.map(field => {
      const baseline = templateBaselineOf(project.templateSnapshot!, field.key).trim();
      return baseline && field.value.trim()
        ? { ...field, value: `旧人物优化后的${field.key}——实例特定描述` }
        : field;
    });
    return {
      ...project,
      workspace: {
        ...project.workspace,
        recreation: {
          ...recreation,
          plan: { ...recreation.plan, fields: drifted },
          editState: 'dirty',
          semanticRevision: 3,
          optimizedRevision: 1,
          adjustInstruction: '把人物换成金发，服装改为白色连衣裙',
          optimizedPrompt: '旧人物的优化 Prompt',
        },
      },
    };
  }

  it('slotRebindDropsStaleOptimizationDelta：重建把漂移的 plan 字段回落模板基线（锁定维度零冲突）', () => {
    const saved = dirtySavedProject();
    const recipe = buildSkillRecipeFromProject(saved);
    const rebuilt = buildProjectFromSkillRecipe(recipe, {
      skill: { id: 's', name: 'n', sourceProjectId: saved.id, sourceRevision: saved.revision },
      person: PERSON_BINDING,
    })!;
    // 所有存在模板基线且原本非空的字段：值 = 基线（实例特定文本被丢弃）
    for (const field of rebuilt.workspace.recreation!.plan.fields) {
      const baseline = templateBaselineOf(rebuilt.templateSnapshot!, field.key).trim();
      if (baseline) expect(field.value.trim()).toBe(baseline);
    }
    expect(rebuilt.workspace.recreation!.plan.fields.some(
      field => field.value.includes('旧人物优化后的'),
    )).toBe(false);
  });

  it('slotRebindDoesNotSetNeedsPromptOptimization：重建后 needsOptimization = false（零「重新优化 Prompt」建议）', () => {
    const saved = dirtySavedProject();
    expect(needsOptimization(saved.workspace.recreation!)).toBe(true); // 保存时刻确实脏
    const recipe = buildSkillRecipeFromProject(saved);
    const rebuilt = buildProjectFromSkillRecipe(recipe, {
      skill: { id: 's', name: 'n', sourceProjectId: saved.id, sourceRevision: saved.revision },
      person: PERSON_BINDING,
    })!;
    const recreation = rebuilt.workspace.recreation!;
    expect(needsOptimization(recreation)).toBe(false);
    expect(recreation.semanticRevision).toBe(0);
    expect(recreation.optimizedRevision).toBe(0);
    expect(recreation.adjustInstruction).toBe('');
    expect(recreation.optimizedPrompt).toBe(recreation.originalPrompt); // 旧实例优化产物不复活
    // 直接执行链路（ephemeral）同样不带 dirty 状态
    const built = buildEphemeralSkillProject({ draft: createUserSkillFromVisualProject(saved), person: PERSON_BINDING });
    if (!built.ok) throw new Error(built.error);
    expect(needsOptimization(built.project.workspace.recreation!)).toBe(false);
  });

  it('directExecuteDoesNotNavigateVisionUnderstanding：快速生成直达图片工作室（carry），绝不绕道视觉理解页', () => {
    // 直接生成按钮的唯一导航目标 = imagestudio（报价确认）；vision 只属于「高级调整」
    const directBlock = DIALOG_SRC.slice(
      DIALOG_SRC.indexOf('runDirectGenerate'),
      DIALOG_SRC.indexOf('openReuseProject'),
    );
    expect(directBlock).toContain('setVisionCarry');
    expect(directBlock).toContain("page: 'imagestudio'");
    expect(directBlock).not.toContain("page: 'vision'");
    // 四态状态卡（高可见，不再是弱小字）：ready / repairable / needs_input / blocked
    expect(DIALOG_SRC).toContain('skill-use-status is-${preflightStatus}');
    expect(DIALOG_SRC).toContain('✓ 可以快速生成');
    expect(DIALOG_SRC).toContain('快速生成还差 1 步');
    expect(DIALOG_SRC).toContain('快速生成前需要你选择');
    expect(DIALOG_SRC).toContain('快速生成暂不可用');
  });
});
