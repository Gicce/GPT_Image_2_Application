/**
 * Skill Direct Execution（V6.2 P0）—— 模板复用 Skill 的 headless 直接生成管线。
 *
 * 根因背景：V6/V6.1 的「使用 Skill」只有一条路——重建 VisualProject 写入项目
 * store → 进视觉工作台 → 人工确认生成。对「换个人直接出图」这类高频复用，
 * 工作台反而成了障碍：用户要理解九维度 / 技能面板 / 优化按钮才能出一张图。
 *
 * 本模块的修复思路（增量、零平行系统）：
 *  - 直接生成 = 同一条编译 / 校验链的 headless 形态：buildProjectFromSkillRecipe
 *    重建 ephemeral 项目（不写入项目 store、不落库）→ resolveGenerationImageReferences
 *    → mergeFinalGenerationPrompt 重编译绑定 → 全量合同校验（含 Skill Origin
 *    Guard）→ buildGenerationProvenance + skillOrigin → buildGenerationCarry
 *    （autoStartGeneration + skillSession）→ setVisionCarry → 图片工作室报价确认
 *    （QuoteConfirmDialog 单一计费授权入口，绝不绕过）。
 *  - 零 AI 调用铁律：换素材只重编译绑定（人物参考图换路径即换身份），绝不执行
 *    Prompt Optimizer / 视觉外貌解析；最终画面描述 = Recipe 冻结的 promptDraft
 *    （保存时刻已沉淀的复刻 Prompt，旧人物优化产物在快照期已剥离）。
 *  - ephemeral 会话：项目文档随 carry 进入 ImageStudio（skillSession.project），
 *    「保存为视觉项目」时才 adopt 落库；不保存则不产生任何持久化痕迹。
 *  - optimizationPolicy 只声明意图（provenance 如实记录）：direct 模式恒零优化
 *    ——没有让用户审阅优化产物的 UI，就不允许后台偷偷调优化器；adaptive /
 *    always_reoptimize 的重优化发生在「保存项目后回到工作台」的路径上。
 *
 * 本模块保持 store-free（regionContractDisabled 由调用方传入），可独立测试。
 */

import type { GenerationImageReference } from '../../types';
import type { VisionCarryDraft } from '../../store/useDraftStore';
import {
  buildProjectFromSkillRecipe,
  skillPersonSlotRequired,
  type SkillPersonBinding,
  type SkillRecipe,
} from './skillRecipe';
import type { UserSkillDraft } from './userSkill';
import type { VisualProject } from '../vision/project/types';
import { toModificationDraft } from '../vision/project/project';
import { clothingReadinessError } from '../vision/modificationIntent';
import { validateGenerationContract } from '../vision/project/validators';
import { validateDimensionLockContract } from '../vision/project/dimensionLock';
import { validateAnimeCharacterConsistency, detailInsertIncompleteErrors } from '../vision/project/animeCharacter';
import { withAnimeCharacterReference } from '../vision/project/animeCharacterAssetService';
import {
  countInsertInstances,
  mergeDetailInsertRepairResults,
  type DetailInsertRepairInput,
} from '../vision/project/detailInsert';
import {
  CLOTHING_CONFLICT_ERROR,
  clothingSourceIsPersonReference,
  extractTemplateClothingTokens,
} from '../vision/project/clothingGuard';
import { validateSkillOriginContractCoverage } from '../vision/project/skillOriginGuard';
import { mergeFinalGenerationPrompt } from '../vision/project/promptCompiler';
import {
  buildGenerationProvenance,
  resolveGenerationImageReferences,
} from '../vision/generationProvenance';
import { buildGenerationNegativeAddendum } from '../vision/generationDirective';
import { buildSkillExecutionSnapshot } from '../vision/skills/engine';
import { buildGenerationCarry, type RecreationState } from '../vision/recreationPlan';

// ===== 执行方式 / Prompt 策略（UserSkillDraft 持久化字段）=====

/** Skill 默认执行方式：直接生成（快速生成）或进入视觉工作台（高级调整）。 */
export type SkillExecutionMode = 'direct_generate' | 'open_workbench';

/** Prompt 策略：复用保存基线 / 换素材后自适应 / 每次重新优化。 */
export type SkillOptimizationPolicy = 'reuse_recipe' | 'adaptive' | 'always_reoptimize';

export const SKILL_EXECUTION_MODE_LABELS: Record<SkillExecutionMode, string> = {
  direct_generate: '快速生成',
  open_workbench: '高级调整',
};

export const SKILL_OPTIMIZATION_POLICY_LABELS: Record<SkillOptimizationPolicy, string> = {
  reuse_recipe: '复用保存方案（不重新优化）',
  adaptive: '换素材后自适应优化',
  always_reoptimize: '每次使用都重新优化',
};

export function normalizeSkillExecutionMode(value: unknown): SkillExecutionMode {
  return value === 'open_workbench' ? 'open_workbench' : 'direct_generate';
}

export function normalizeSkillOptimizationPolicy(value: unknown): SkillOptimizationPolicy {
  return value === 'adaptive' || value === 'always_reoptimize' ? value : 'reuse_recipe';
}

// ===== ephemeral 项目构建 =====

export interface EphemeralSkillProjectInput {
  draft: UserSkillDraft;
  person?: SkillPersonBinding;
  /** clothing_text 槽位的按次输入（自定义服装描述；缺省用 Recipe 保存值）。 */
  customClothing?: string;
}

export type EphemeralSkillProjectResult =
  | { ok: true; project: VisualProject; personRebound: boolean }
  | { ok: false; error: string };

/** Recipe → ephemeral 项目（不写 store、不落库；直接生成与弹窗内嵌 Repair 共用）。 */
export function buildEphemeralSkillProject(input: EphemeralSkillProjectInput): EphemeralSkillProjectResult {
  const recipe = input.draft.recipe;
  if (!recipe || recipe.skillType !== 'template_reuse') {
    return { ok: false, error: '该 Skill 没有可复用的方案快照（通用 Skill 请在工作台使用）。' };
  }
  const project = buildProjectFromSkillRecipe(recipe, {
    skill: {
      id: input.draft.id,
      name: input.draft.name,
      sourceProjectId: input.draft.sourceProjectId,
      sourceRevision: input.draft.sourceRevision,
    },
    person: input.person,
    ...(input.customClothing !== undefined ? { customClothing: input.customClothing } : {}),
  });
  if (!project) {
    return { ok: false, error: 'Skill 方案快照不完整，无法直接生成。请回到来源项目重新保存 Skill。' };
  }
  return { ok: true, project, personRebound: !!input.person };
}

// ===== Preflight（弹窗打开 / 换素材后即时校验；纯函数）=====

export interface SkillDirectBlocker {
  code:
    | 'recipe_incomplete'
    | 'generation_contract'
    | 'dimension_lock'
    | 'clothing'
    | 'anime_character_required'
    | 'detail_insert_incomplete'
    | 'needs_input';
  message: string;
  /** detail_insert_incomplete 可在弹窗内原位 Repair（同一 Runner）。 */
  repairable: 'detail_insert' | null;
}

/**
 * Preflight 状态（V6.3 Direct Preflight Contract）——快速执行入口旁必须
 * 显式可见，关键信息绝不藏在说明小字里：
 *  - ready：可直接快速生成（绿色）；
 *  - repairable：只差原位 Repair（橙色高可见 + 修复动作）；
 *  - needs_input：需要用户做一个业务输入（绑定人物参考 / 填服装要求）；
 *  - blocked：Recipe / 合同级损坏——只能进工作台处理。
 * 硬规则：任何状态都不默认建议「重新优化 Prompt」——换素材 = 重绑定 + 重编译。
 */
export type SkillDirectPreflightStatus = 'ready' | 'repairable' | 'needs_input' | 'blocked';

/** 状态分类（纯函数）：硬阻断优先；可修复 / 需输入次之；全清 = ready。 */
export function classifySkillDirectPreflight(preflight: { blockers: SkillDirectBlocker[] }): SkillDirectPreflightStatus {
  if (preflight.blockers.length === 0) return 'ready';
  const soft = new Set<SkillDirectBlocker['code']>(['detail_insert_incomplete', 'needs_input', 'clothing']);
  if (preflight.blockers.some(blocker => !soft.has(blocker.code))) return 'blocked';
  if (preflight.blockers.some(blocker => blocker.code === 'needs_input' || blocker.code === 'clothing')) return 'needs_input';
  return 'repairable';
}

export interface PreflightSkillDirectInput {
  project: VisualProject;
  /** 人物槽位必选（服装来自人物参考的 Skill）：未绑定 = needs_input 而非静默沿用模板。 */
  personRequired?: boolean;
}

/** 直接生成前校验：与工作台「确认生成」同一组合法性（无百分比、无 IO）。 */
export function preflightSkillDirectExecution(input: PreflightSkillDirectInput): {
  ok: boolean;
  blockers: SkillDirectBlocker[];
} {
  const { project } = input;
  const blockers: SkillDirectBlocker[] = [];
  if (input.personRequired && !project.modification.person) {
    blockers.push({
      code: 'needs_input',
      message: '本 Skill 的人物替换与服装都来自人物参考——请先绑定一张人物参考图。',
      repairable: null,
    });
  }
  const draft = toModificationDraft(project.modification);
  for (const error of validateGenerationContract(project)) {
    blockers.push({ code: 'generation_contract', message: error, repairable: null });
  }
  for (const error of validateDimensionLockContract(project)) {
    blockers.push({ code: 'dimension_lock', message: error, repairable: null });
  }
  const clothingError = clothingReadinessError(draft);
  if (clothingError) blockers.push({ code: 'clothing', message: clothingError, repairable: null });
  // 局部插图实例缺失：唯一可在弹窗内原位 Repair 的阻断（同一 Runner）
  const counts = countInsertInstances(project.renderingContract);
  if (counts.incompleteRegions.length > 0) {
    blockers.push({
      code: 'detail_insert_incomplete',
      message: `模板中有 ${counts.incompleteRegions.length} 个局部插图层还没有识别实例，需要先补充识别才能保证插图与主体同源。`,
      repairable: 'detail_insert',
    });
  }
  // 动漫一致性（含插图绑定）：剔除与插图缺失重复的文案，其余需工作台处理
  const insertErrorMessages = detailInsertIncompleteErrors(project);
  for (const error of validateAnimeCharacterConsistency(project)) {
    if (insertErrorMessages.includes(error)) continue;
    blockers.push({ code: 'anime_character_required', message: error, repairable: null });
  }
  return { ok: blockers.length === 0, blockers };
}

// ===== 内嵌 Repair 合并（对 ephemeral 项目文档做纯函数合并）=====

export type EphemeralRepairApplyResult =
  | { applied: true; project: VisualProject; summary: string }
  | { applied: false; error: string };

/**
 * 弹窗内嵌 Repair 的 applyResults 实现：不经过项目 store，直接产出新的
 * ephemeral 项目文档（只覆盖实例相关字段，其余合同原样保留）。
 */
export function applyDetailInsertRepairToEphemeral(
  project: VisualProject,
  results: DetailInsertRepairInput[],
): EphemeralRepairApplyResult {
  if (!project.templateSnapshot) {
    return { applied: false, error: '当前模板信息不完整，无法合并识别结果。' };
  }
  const outcome = mergeDetailInsertRepairResults(project.templateSnapshot, results);
  if (outcome.repaired <= 0) {
    return { applied: false, error: '本次没有识别到新的插图实例，可以稍后重试。' };
  }
  return {
    applied: true,
    project: {
      ...project,
      templateSnapshot: outcome.snapshot,
      renderingContract: outcome.snapshot.mediaStructure ?? project.renderingContract,
      updatedAt: new Date().toISOString(),
    },
    summary: `已识别 ${outcome.after.total} 个局部插图（动漫插图 ${outcome.after.anime} 个）`
      + (outcome.after.incompleteRegions.length > 0 ? `；仍有 ${outcome.after.incompleteRegions.length} 层未识别` : '')
      + '。',
  };
}

// ===== Headless 直接执行（零 AI 调用）=====

export interface ExecuteSkillDirectInput {
  draft: UserSkillDraft;
  person?: SkillPersonBinding;
  optimizationPolicy: SkillOptimizationPolicy;
  /** 区域替换技能停用 = 真实效果（与工作台同源传入）。 */
  regionContractDisabled: boolean;
  /** 弹窗已持有的 ephemeral 项目（内嵌 Repair 后的最新版）；缺省现场重建。 */
  project?: VisualProject;
  /** clothing_text 槽位的按次输入（自定义服装描述；缺省用 Recipe 保存值）。 */
  customClothing?: string;
}

export type SkillDirectCarry = VisionCarryDraft & {
  autoStartGeneration: true;
  skillSession: NonNullable<VisionCarryDraft['skillSession']>;
};

export type ExecuteSkillDirectResult =
  | { ok: true; project: VisualProject; carry: SkillDirectCarry; finalPromptLength: number }
  | { ok: false; error: string };

/** Recipe 快照缺省 recreation 时的最小回退（仅供 changedDimensionsOf / carry 组装）。 */
function fallbackRecreation(project: VisualProject): RecreationState {
  return {
    plan: { summary: '', fields: [] },
    originalPrompt: project.workspace.originalPromptDraft.trim() || project.workspace.promptDraft.trim(),
    originalNegativePrompt: project.workspace.negativeDraft.trim(),
    editState: 'ready',
    semanticRevision: 0,
    optimizedRevision: 0,
    adjustInstruction: '',
  };
}

/**
 * 直接生成管线：重建（或采用弹窗持有的）ephemeral 项目 → 全量校验 →
 * 合同编译（Origin Guard / 服装 / 动漫守卫）→ 溯源 + skillSession carry。
 * 任何一步失败立即返回错误（弹窗如实展示，绝不静默降级）。
 */
export function executeTemplateSkillDirect(input: ExecuteSkillDirectInput): ExecuteSkillDirectResult {
  const personRequired = !!input.draft.recipe && skillPersonSlotRequired(input.draft.recipe);
  const built = input.project
    ? { ok: true as const, project: input.project, personRebound: !!input.person }
    : buildEphemeralSkillProject({
      draft: input.draft,
      person: input.person,
      ...(input.customClothing !== undefined ? { customClothing: input.customClothing } : {}),
    });
  if (!built.ok) return { ok: false, error: built.error };
  const project = built.project;
  const preflight = preflightSkillDirectExecution({ project, personRequired });
  if (!preflight.ok) {
    return { ok: false, error: preflight.blockers[0].message };
  }
  const draft = toModificationDraft(project.modification);
  const finalDescription = project.workspace.promptDraft.trim();
  if (!finalDescription) {
    return { ok: false, error: 'Skill 方案缺少可用的最终画面描述，请回到来源项目重新保存 Skill。' };
  }
  // 参考图唯一解析（模板 → 人物 → 动漫角色参考 → 其余引用；与工作台同源同序）
  let imageReferences: GenerationImageReference[] = resolveGenerationImageReferences({
    draft,
    sourcePath: project.sourceAsset.path || undefined,
    sourceAssetId: project.sourceAsset.assetId || undefined,
  });
  const animeAsset = project.animeConsistency?.characterAsset;
  if (animeAsset?.localPath) {
    // ephemeral 项目按规范不带旧角色卡（preflight 已保证 strict 模式走工作台）；
    // 此分支仅覆盖 standard 模式下快照携带角色的历史 Recipe，保持与工作台同序。
    imageReferences = withAnimeCharacterReference(imageReferences, {
      path: animeAsset.localPath,
      label: '动漫角色参考',
      role: 'anime_character_reference',
      ...(animeAsset.libraryAssetId ? { assetId: animeAsset.libraryAssetId } : {}),
    });
  }
  const personEnabled = imageReferences.some(ref => ref.role === 'person_reference') && !!draft.person;
  // 合同编译（确定性、零模型调用）：换人物素材 = 绑定重编译，最终描述复用冻结基线
  const compiled = mergeFinalGenerationPrompt({
    project,
    finalDescription,
    negativePrompt: project.workspace.negativeDraft.trim(),
    ...(project.workspace.fullPromptOverride?.trim()
      ? { fullPromptOverride: project.workspace.fullPromptOverride }
      : {}),
    negativeAddendum: buildGenerationNegativeAddendum({
      imageReferences,
      personReplacementEnabled: personEnabled,
      clothingPolicy: draft.clothingPolicy,
      customClothing: draft.customClothing,
      ...(clothingSourceIsPersonReference(project) && extractTemplateClothingTokens(project).length > 0
        ? { templateClothingTokens: extractTemplateClothingTokens(project) }
        : {}),
    }),
    imageReferences,
    personReplacementEnabled: personEnabled,
    includeRegions: input.regionContractDisabled ? false : undefined,
  });
  // Skill Origin Guard：关键合同块缺失 / 手动覆盖降级 ⇒ 阻断（零平行系统，同一闸门）
  const originErrors = validateSkillOriginContractCoverage(project, compiled, {
    regionContractDisabled: input.regionContractDisabled,
  });
  if (originErrors.length > 0) return { ok: false, error: originErrors[0] };
  if (compiled.clothingConflicts.length > 0) return { ok: false, error: CLOTHING_CONFLICT_ERROR };
  if (compiled.animeConflicts.length > 0) return { ok: false, error: compiled.animeConflicts[0] };
  // 溯源快照（生成时刻冻结；ephemeral 项目 id / 修订随任务记录）
  const recreation = project.workspace.recreation ?? fallbackRecreation(project);
  const provenance = buildGenerationProvenance({
    draft,
    recreation,
    sourcePath: project.sourceAsset.path || undefined,
    sourceAssetId: project.sourceAsset.assetId || undefined,
    imageReferences,
    ...(project.modification.person?.enabled
      ? {
        project: {
          id: project.id,
          name: project.name,
          revision: project.revision,
          personContract: {
            strength: project.modification.person.strength,
            replaceScope: project.modification.person.replaceScope,
            ...(project.modification.person.targetRegionId
              ? { targetRegionId: project.modification.person.targetRegionId }
              : {}),
            applyIdentityTo: project.modification.person.applyIdentityTo,
            preserveTemplateIdentity: false,
          },
          renderingContract: project.renderingContract ?? undefined,
        },
      }
      : {
        project: {
          id: project.id,
          name: project.name,
          revision: project.revision,
          renderingContract: project.renderingContract ?? undefined,
        },
      }),
  });
  provenance.skillOrigin = {
    skillId: input.draft.id,
    skillName: input.draft.name,
    ...(input.draft.version ? { skillVersion: input.draft.version } : {}),
    executionMode: 'direct_generate',
    optimizationPolicy: input.optimizationPolicy,
    personRebound: built.personRebound,
    projectKind: 'ephemeral',
  };
  provenance.skillExecutionSnapshot = buildSkillExecutionSnapshot({
    project,
    imageReferences,
    disabledSkillIds: input.regionContractDisabled ? ['region_replacement'] : [],
    compiled,
  });
  // carry：autoStartGeneration 让图片工作室自动走 submitSingle（报价确认层照常弹出）
  const carry: SkillDirectCarry = {
    ...buildGenerationCarry(
      {
        ...recreation,
        optimizedPrompt: compiled.prompt,
        optimizedNegativePrompt: compiled.negativePrompt,
      },
      {
        size: project.workspace.genParams.size,
        quality: project.workspace.genParams.quality,
        count: project.workspace.genParams.count,
        generationMode: project.workspace.generationMode === 't2i' ? 't2i' : 'i2i',
        sourceImagePath: project.sourceAsset.path || undefined,
        sourceAssetId: project.sourceAsset.assetId || undefined,
        personReferencePath: draft.person?.path || undefined,
        imageReferences,
        personReplacement: {
          enabled: !!draft.person,
          clothingPolicy: draft.clothingPolicy,
          customClothing: draft.customClothing,
        },
        provenance,
        promptCompiled: true,
        projectId: project.id,
        projectName: project.name,
        projectRevision: project.revision,
      },
    ),
    taskPlanSummary: `基于模板复用 Skill「${input.draft.name}」直接生成`,
    autoStartGeneration: true,
    skillSession: {
      skillId: input.draft.id,
      skillName: input.draft.name,
      ...(input.draft.version ? { skillVersion: input.draft.version } : {}),
      executionMode: 'direct_generate',
      optimizationPolicy: input.optimizationPolicy,
      personRebound: built.personRebound,
      project,
    },
  };
  return { ok: true, project, carry, finalPromptLength: compiled.prompt.length };
}

/** Skill 的 Recipe 是否具备直接生成前提（模板复用型 + 快照完整）。 */
export function canDirectExecuteSkill(draft: Pick<UserSkillDraft, 'recipe'>): boolean {
  const recipe: SkillRecipe | null = draft.recipe;
  return !!recipe && recipe.skillType === 'template_reuse' && !!recipe.projectSnapshot && !!recipe.template;
}
