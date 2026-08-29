/**
 * Skill Recipe（V6）—— 模板复用型 Skill 的「可重放生成方案」。
 *
 * 根因背景：旧保存链路只存「文本事实摘要」（sourceFacts / coreRules / profiles），
 * 执行端又用 compileSkillPrompt 平级编译器直接拼 Prompt——视觉理解链的
 * 结构化合同（图片角色 / 人物替换 / 媒介分层 / 动漫角色卡 / 细节插图同步 /
 * 表情锁定 / 模板保留）全部丢失，Skill 生成必然降级。
 *
 * 本模块的修复思路（增量、零平行系统）：
 *  - 保存时冻结一份「已派生归一化的 VisualProject 快照」+ 输入槽位 + 运行技能
 *    配置 + 保存时刻的编译基线（最终 Prompt 与合同块清单）；
 *  - 执行时从快照重建全新 VisualProject（人物槽位可换绑）写入项目 store，
 *    后续编译 / 校验 / 生成全部字面复用视觉工作台同一套
 *    Runtime Skill Registry / Prompt Compiler / Contract Validator。
 *
 * 铁律：
 *  - Recipe 只在本地保存（save_user_skill JSON 透传）；公开投稿净化载荷
 *    （sanitizeUserSkillForSubmission）绝不含 projectSnapshot / 本地路径；
 *  - 快照 = deriveVisualProject 语义（人物 / 生成历史重置），旧人物描述不进入复用；
 *  - 重建项目 revision 从 0 起、animeCharacter / referenceAppearance / skillExecution
 *    一律不带旧值（一修订一卡、按指纹失效、新项目重新执行）。
 */

import type { SkillCompiledSection } from '../../types';
import { resolveGenerationImageReferences } from '../vision/generationProvenance';
import type { ClothingPolicy } from '../vision/modificationIntent';
import {
  deriveVisualProject,
  newProjectId,
  newReferenceId,
  normalizeModificationContract,
  normalizeVisualProject,
  toModificationDraft,
  updateVisualProjectSemanticState,
} from '../vision/project/project';
import { templateBaselineOf } from '../vision/project/dimensionLock';
import { normalizePersonReplacementContract } from '../vision/project/personContract';
import { mergeFinalGenerationPrompt } from '../vision/project/promptCompiler';
import { compiledSectionsOf } from '../vision/skills/engine';
import type {
  IdentityApplyScope,
  PersonConstraintStrength,
  PersonReplaceScope,
  VisualProject,
  VisualReferenceAsset,
} from '../vision/project/types';

export type UserSkillKind = 'generic' | 'template_reuse';

/**
 * 输入槽位（V6.3 Slot Contract V2）——由 ModificationContract 派生，不写死 person：
 *  - person 槽位按服装策略升级为「身份」或「身份 + 服装」combined slot；
 *  - clothingPolicy = custom 出现服装要求文本槽（预填保存描述）；
 *  - preserve_original 不出现服装输入槽。
 */
export type SkillInputSlotId = 'template' | 'person' | 'clothing_text';

/** person 槽位用途（combined slot 语义：一张图同时提供身份与服装）。 */
export type SkillPersonSlotUsage = 'identity' | 'identity_clothing';

export interface SkillInputSlot {
  id: SkillInputSlotId;
  label: string;
  /** true = Skill 自带资产（模板图）；false = 使用时由用户绑定。 */
  fixed: boolean;
  required: boolean;
  description: string;
  /** person 槽位用途徽标（身份 / 身份+服装）；其余槽位缺省。 */
  usage?: SkillPersonSlotUsage;
  /** clothing_text 槽位的默认文本（保存时刻的自定义服装描述）。 */
  defaultText?: string;
}

/** 保存时刻的修改合同语义（槽位派生与重建合同的唯一来源；旧 Recipe 缺省回落）。 */
export interface SkillModificationTemplate {
  personEnabled: boolean;
  clothingPolicy: ClothingPolicy;
  customClothing: string;
}

/** 旧 Recipe（无 modificationTemplate）回落：只知人物合同模板，服装按保留模板。 */
function fallbackModificationTemplate(recipe: Partial<SkillRecipe>): SkillModificationTemplate {
  return {
    personEnabled: !!recipe.personContractTemplate,
    clothingPolicy: 'preserve_original',
    customClothing: '',
  };
}

function normalizeModificationTemplate(raw: unknown, recipe: Partial<SkillRecipe>): SkillModificationTemplate {
  if (!raw || typeof raw !== 'object') return fallbackModificationTemplate(recipe);
  const record = raw as Partial<SkillModificationTemplate>;
  const policy: ClothingPolicy = record.clothingPolicy === 'use_subject_reference' || record.clothingPolicy === 'custom'
    ? record.clothingPolicy
    : 'preserve_original';
  const personEnabled = record.personEnabled === true || (!!recipe.personContractTemplate && record.personEnabled !== false);
  // use_subject_reference 只在人物启用时可达（与 normalizeModificationState 不变量一致）；
  // custom 可独立成立（纯服装修改，无需人物参考图）
  const safePolicy: ClothingPolicy = policy === 'custom'
    ? 'custom'
    : personEnabled ? policy : 'preserve_original';
  return {
    personEnabled,
    clothingPolicy: safePolicy,
    customClothing: safePolicy === 'custom' && typeof record.customClothing === 'string' ? record.customClothing : '',
  };
}

/**
 * 由修改合同派生使用时输入槽位（V6.3 唯一派生入口；禁止在 UI 写死 person-only）：
 *  - 人物 + 服装跟随人物参考 ⇒ 一个 combined slot（一张图同时提供身份与服装）；
 *  - 人物 + 服装自定义 ⇒ 人物 slot + 服装要求文本 slot；
 *  - 人物 + 保留模板服装 ⇒ 仅人物 slot；纯自定义服装（无人物）⇒ 仅文本 slot。
 */
export function deriveSkillInputSlots(recipe: Pick<SkillRecipe, 'modificationTemplate'>): SkillInputSlot[] {
  const mod = recipe.modificationTemplate;
  const slots: SkillInputSlot[] = [
    { id: 'template', label: '画面模板图', fixed: true, required: true, description: 'Skill 自带固定模板；构图 / 镜头 / 背景 / 光线 / 风格与媒介分层以其为基线。' },
  ];
  if (mod.personEnabled) {
    if (mod.clothingPolicy === 'use_subject_reference') {
      slots.push({
        id: 'person',
        label: '人物参考',
        fixed: false,
        required: true,
        usage: 'identity_clothing',
        description: '这张图片将同时提供人物身份与服装；姿势、构图、背景不会从该图继承。',
      });
    } else {
      slots.push({
        id: 'person',
        label: '人物身份参考',
        fixed: false,
        required: false,
        usage: 'identity',
        description: mod.clothingPolicy === 'custom'
          ? '仅提供人物身份；服装按下方自定义要求执行。姿势 / 构图 / 背景不得从本图带入。'
          : '仅提供人物身份；服装沿用模板。姿势 / 构图 / 背景不得从本图带入。',
      });
    }
  }
  if (mod.clothingPolicy === 'custom') {
    slots.push({
      id: 'clothing_text',
      label: '服装要求',
      fixed: false,
      required: true,
      description: '本 Skill 保存了自定义服装描述；可在此按次调整（留空将无法快速生成）。',
      defaultText: mod.customClothing,
    });
  }
  return slots;
}

/** 人物槽位是否必须绑定（服装来自人物参考时：不绑定 = 方案不完整，NEEDS_INPUT）。 */
export function skillPersonSlotRequired(recipe: Pick<SkillRecipe, 'modificationTemplate'>): boolean {
  return deriveSkillInputSlots(recipe).some(slot => slot.id === 'person' && slot.required);
}

/** 保存时刻的人物合同配置（具体人物图不进 Recipe，槽位换绑时套用同一强度/范围）。 */
export interface SkillPersonContractTemplate {
  strength: PersonConstraintStrength;
  replaceScope: Exclude<PersonReplaceScope, 'custom_region'>;
  applyIdentityTo: IdentityApplyScope;
}

/**
 * Skill Recipe（schemaVersion 2）。projectSnapshot 为核心——其余字段是
 * 槽位 / 技能 / 编译 / 校验的可解释层，供 UI 展示与执行前检查。
 */
export interface SkillRecipe {
  schemaVersion: 2;
  skillType: UserSkillKind;
  slots: SkillInputSlot[];
  /** 固定模板资产（本地路径；执行前校验可读）。 */
  template: { path: string; assetId?: string; displayName?: string } | null;
  personContractTemplate: SkillPersonContractTemplate | null;
  /**
   * V6.3 Slot Contract V2：保存时刻的修改合同语义（人物启用 / 服装策略 / 自定义
   * 服装描述）。输入槽位由它派生；重建项目时套用同一策略。旧 Recipe 缺省 =
   * 旧行为（人物可换绑、服装保留模板），零迁移成本。
   */
  modificationTemplate: SkillModificationTemplate;
  /** 保存时刻生效的 Runtime Skill 清单（信息性冻结；核心技能恒执行）。 */
  runtimeSkillIds: string[];
  /** 保存时刻编译产出的合同层名（Compiler sections 口径；结构级对比基线）。 */
  compilerSections: string[];
  /** 校验器清单（生成门禁实际执行 validateGenerationContract + Skill Origin Guard）。 */
  validatorProfile: string[];
  /** 保存时刻视觉理解链编译的最终 Prompt（复用对比基线）。 */
  baselineFinalPrompt: string;
  /** 保存时刻合同块（Prompt 来源反查口径；含每块归属技能）。 */
  baselineSections: SkillCompiledSection[];
  /** 已派生归一化的项目快照（执行时重建 VisualProject 的唯一来源）。 */
  projectSnapshot: VisualProject | null;
  savedAt: string;
}

/** 是否为模板复用场景（有冻结模板快照 + 模板源图）。 */
export function isTemplateReuseProject(project: VisualProject): boolean {
  return !!project.templateSnapshot && !!project.sourceAsset.path?.trim();
}

/**
 * 保存时刻的编译基线：与视觉页生成链同源（resolveGenerationImageReferences →
 * mergeFinalGenerationPrompt），确定性、零模型调用。
 */
function compileBaseline(project: VisualProject): {
  finalPrompt: string;
  sections: string[];
  sectionBlocks: SkillCompiledSection[];
} {
  const draft = toModificationDraft(project.modification);
  const refs = resolveGenerationImageReferences({
    draft,
    sourcePath: project.sourceAsset.path || undefined,
    sourceAssetId: project.sourceAsset.assetId || undefined,
  });
  const personEnabled = refs.some(ref => ref.role === 'person_reference') && !!draft.person;
  const compiled = mergeFinalGenerationPrompt({
    project,
    finalDescription: project.workspace.promptDraft.trim(),
    negativePrompt: project.workspace.negativeDraft.trim(),
    imageReferences: refs,
    personReplacementEnabled: personEnabled,
    ...(project.workspace.fullPromptOverride?.trim()
      ? { fullPromptOverride: project.workspace.fullPromptOverride }
      : {}),
  });
  return {
    finalPrompt: compiled.prompt,
    sections: compiled.sections,
    sectionBlocks: compiledSectionsOf(compiled),
  };
}

/** 项目 → Recipe（保存为 Skill 时调用；模板复用场景）。 */
export function buildSkillRecipeFromProject(project: VisualProject): SkillRecipe {
  const now = new Date().toISOString();
  const templateReuse = isTemplateReuseProject(project);
  if (!templateReuse) {
    return {
      schemaVersion: 2,
      skillType: 'generic',
      slots: [],
      template: null,
      personContractTemplate: null,
      modificationTemplate: { personEnabled: false, clothingPolicy: 'preserve_original', customClothing: '' },
      runtimeSkillIds: [],
      compilerSections: [],
      validatorProfile: [],
      baselineFinalPrompt: '',
      baselineSections: [],
      projectSnapshot: null,
      savedAt: now,
    };
  }
  const baseline = compileBaseline(project);
  // 快照 = 派生语义：人物 / 修改意图 / 生成历史重置；模板 / 媒介结构 / 姿态基线全保留
  const derived = deriveVisualProject(project, '');
  const snapshot: VisualProject = {
    ...derived,
    // 旧人物的优化产物不得进入复用（promptDraft 回落原始复刻 Prompt）
    workspace: {
      ...derived.workspace,
      promptDraft: derived.workspace.originalPromptDraft.trim() || derived.workspace.promptDraft,
      fullPromptOverride: undefined,
      report: null,
      iterations: [],
      visionTaskId: '',
      sessionId: '',
    },
    // 派生链上的旧派生标记 / 过期角色卡 / 旧执行记录一律不带
    originSkill: undefined,
    animeCharacter: undefined,
    referenceAppearance: undefined,
    skillExecution: undefined,
    latestFinalPrompt: undefined,
  };
  const person = project.modification.person;
  const personContractTemplate = person?.enabled
    ? {
      strength: person.strength,
      // custom_region 依赖源项目区域（快照已重置区域）→ 回落整人替换
      replaceScope: person.replaceScope === 'custom_region' ? 'whole_person' as const : person.replaceScope,
      applyIdentityTo: person.applyIdentityTo,
    }
    : null;
  // Slot Contract V2：保存时刻的修改合同语义（derive 已重置快照内合同，先于快照读取）
  const modificationTemplate: SkillModificationTemplate = {
    personEnabled: !!person?.enabled,
    clothingPolicy: project.modification.clothingPolicy,
    customClothing: project.modification.clothingPolicy === 'custom' ? project.modification.customClothing : '',
  };
  const recipe: SkillRecipe = {
    schemaVersion: 2,
    skillType: 'template_reuse',
    slots: [],
    template: {
      path: project.sourceAsset.path,
      ...(project.sourceAsset.assetId ? { assetId: project.sourceAsset.assetId } : {}),
      ...(project.sourceAsset.displayName ? { displayName: project.sourceAsset.displayName } : {}),
    },
    personContractTemplate,
    modificationTemplate,
    runtimeSkillIds: Array.isArray(project.enabledSkillIds) ? [...project.enabledSkillIds] : [],
    compilerSections: baseline.sections,
    validatorProfile: ['validateGenerationContract', 'validateDimensionLockContract', 'skillOriginContractCoverageGuard'],
    baselineFinalPrompt: baseline.finalPrompt,
    baselineSections: baseline.sectionBlocks,
    projectSnapshot: snapshot,
    savedAt: now,
  };
  return { ...recipe, slots: deriveSkillInputSlots(recipe) };
}

/** 载入时合法化（旧 / 损坏 Recipe → null，调用方回落通用 Skill 行为）。 */
export function normalizeSkillRecipe(raw: unknown): SkillRecipe | null {
  if (!raw || typeof raw !== 'object') return null;
  const recipe = raw as Partial<SkillRecipe>;
  if (recipe.schemaVersion !== 2) return null;
  if (recipe.skillType === 'generic') {
    return {
      schemaVersion: 2, skillType: 'generic', slots: [], template: null, personContractTemplate: null,
      modificationTemplate: { personEnabled: false, clothingPolicy: 'preserve_original', customClothing: '' },
      runtimeSkillIds: [], compilerSections: [], validatorProfile: [],
      baselineFinalPrompt: '', baselineSections: [], projectSnapshot: null,
      savedAt: typeof recipe.savedAt === 'string' ? recipe.savedAt : '',
    };
  }
  if (recipe.skillType !== 'template_reuse') return null;
  const snapshot = normalizeVisualProject(recipe.projectSnapshot ?? null);
  const template = recipe.template && typeof recipe.template.path === 'string' && recipe.template.path.trim()
    ? recipe.template
    : null;
  // 模板资产或快照缺失 = Recipe 不完整，拒绝按模板复用执行（不伪造）
  if (!snapshot || !snapshot.templateSnapshot || !template) return null;
  const modificationTemplate = normalizeModificationTemplate(recipe.modificationTemplate, recipe);
  return {
    schemaVersion: 2,
    skillType: 'template_reuse',
    // V6.3：槽位一律由修改合同派生（存储的 slots 仅历史信息，不再信任）
    slots: deriveSkillInputSlots({ modificationTemplate }),
    template,
    personContractTemplate: recipe.personContractTemplate ?? null,
    modificationTemplate,
    runtimeSkillIds: Array.isArray(recipe.runtimeSkillIds) ? recipe.runtimeSkillIds.map(String) : [],
    compilerSections: Array.isArray(recipe.compilerSections) ? recipe.compilerSections.map(String) : [],
    validatorProfile: Array.isArray(recipe.validatorProfile) ? recipe.validatorProfile.map(String) : [],
    baselineFinalPrompt: typeof recipe.baselineFinalPrompt === 'string' ? recipe.baselineFinalPrompt : '',
    baselineSections: Array.isArray(recipe.baselineSections) ? recipe.baselineSections : [],
    projectSnapshot: snapshot,
    savedAt: typeof recipe.savedAt === 'string' ? recipe.savedAt : '',
  };
}

/** 人物槽位绑定载荷（使用时由用户提供）。 */
export interface SkillPersonBinding {
  path: string;
  assetId?: string;
  label?: string;
  source: 'gallery' | 'local';
}

/**
 * Direct Compile 铁律（V6.3 §23/§24）：换素材 = 重绑定 + 确定性重编译，
 * 绝不携带旧实例的优化增量。快照里 workspace.recreation.plan.fields 仍是
 * 保存项目的优化产物（旧人物 / 旧服装描述）——修改意图已重置 ⇒ 全维度锁定
 * ⇒ 漂移值会触发「请重新优化 Prompt」阻断。重建时把漂移字段回落模板基线
 * （structure 层保留，instance-specific 文本丢弃），旧 / 新 Recipe 同治。
 */
export function resetDriftedPlanFieldsToTemplateBaseline(project: VisualProject): VisualProject {
  const snapshot = project.templateSnapshot;
  const recreation = project.workspace.recreation;
  if (!snapshot || !recreation?.plan?.fields) return project;
  let changed = false;
  const fields = recreation.plan.fields.map(field => {
    const baseline = templateBaselineOf(snapshot, field.key).trim();
    if (baseline && field.value.trim() && field.value.trim() !== baseline) {
      changed = true;
      return { ...field, value: baseline };
    }
    return field;
  });
  if (!changed) return project;
  return {
    ...project,
    workspace: {
      ...project.workspace,
      recreation: { ...recreation, plan: { ...recreation.plan, fields } },
    },
  };
}

/** Recipe → 全新 VisualProject（模板复用执行入口；写入项目 store 后进入视觉工作台）。 */
export function buildProjectFromSkillRecipe(
  recipe: SkillRecipe,
  input: {
    skill: { id: string; name: string; sourceProjectId: string; sourceRevision: number };
    person?: SkillPersonBinding;
    /** 使用时按次覆盖的自定义服装描述（clothing_text 槽位输入；缺省用保存值）。 */
    customClothing?: string;
    name?: string;
  },
): VisualProject | null {
  if (recipe.skillType !== 'template_reuse' || !recipe.projectSnapshot) return null;
  const base = normalizeVisualProject(recipe.projectSnapshot);
  if (!base || !base.templateSnapshot) return null;
  const now = new Date().toISOString();
  let project: VisualProject = JSON.parse(JSON.stringify(base)) as VisualProject;
  project = resetDriftedPlanFieldsToTemplateBaseline(project);
  // V6.3 §23 后半：丢弃旧实例的优化执行状态（dirty 标记 / 旧优化产物 / 调整指令 /
  // 优化快照史）。换素材 = 重绑定 + 确定性重编译——重建项目绝不能带着保存时刻的
  // 「待优化」状态建议「重新优化 Prompt」。
  if (project.workspace.recreation) {
    const recreation = project.workspace.recreation;
    project = {
      ...project,
      workspace: {
        ...project.workspace,
        recreation: {
          ...recreation,
          editState: 'ready',
          semanticRevision: 0,
          optimizedRevision: 0,
          adjustInstruction: '',
          optimizeError: undefined,
          optimizedPrompt: recreation.originalPrompt,
          optimizedNegativePrompt: recreation.originalNegativePrompt,
          summary: undefined,
          optimizedBy: 'analysis',
          optimizerViolations: undefined,
          optimizationHistory: undefined,
        },
      },
    };
  }
  project = {
    ...project,
    id: newProjectId(),
    name: input.name?.trim() || input.skill.name || '模板复用项目',
    status: 'ready',
    revision: 0,
    optimizedRevision: undefined,
    latestFinalPrompt: undefined,
    generationIds: [],
    derivedFromProjectId: input.skill.sourceProjectId || undefined,
    enabledSkillIds: recipe.runtimeSkillIds.length > 0 ? [...recipe.runtimeSkillIds] : undefined,
    // 动漫一致性保留模式、丢弃旧角色参考图资产（按新人物指纹重建）
    animeConsistency: project.animeConsistency ? { mode: project.animeConsistency.mode } : undefined,
    originSkill: {
      skillId: input.skill.id,
      skillName: input.skill.name,
      sourceProjectId: input.skill.sourceProjectId,
      sourceRevision: input.skill.sourceRevision,
      baselineFinalPrompt: recipe.baselineFinalPrompt,
      baselineSections: recipe.compilerSections,
      savedAt: recipe.savedAt,
    },
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };
  const mod = recipe.modificationTemplate;
  // 纯自定义服装（无人物绑定）也参与：服装维度独立成立，无需人物参考图
  if (!input.person) {
    if (mod.clothingPolicy !== 'custom') return project;
    const customClothing = (input.customClothing ?? mod.customClothing).trim();
    if (!customClothing) return project;
    return updateVisualProjectSemanticState(project, 'clothing', draft => ({
      ...draft,
      modification: normalizeModificationContract(
        { ...draft.modification, clothingPolicy: 'custom', customClothing },
        draft.regions,
      ),
      status: 'modified',
    }));
  }
  // 人物槽位绑定：套用保存时刻的强度 / 范围（strict 默认，绝不静默降级）
  const reference: VisualReferenceAsset = {
    id: newReferenceId(),
    ...(input.person.assetId ? { assetId: input.person.assetId } : {}),
    path: input.person.path,
    label: input.person.label?.trim() || '人物身份参考',
    kind: 'person',
    source: input.person.source === 'gallery' ? 'gallery' : 'local_import',
  };
  const person = normalizePersonReplacementContract({
    enabled: true,
    source: input.person.source,
    ...(input.person.assetId ? { assetId: input.person.assetId } : {}),
    path: input.person.path,
    label: reference.label,
    strength: recipe.personContractTemplate?.strength ?? 'strict',
    replaceScope: recipe.personContractTemplate?.replaceScope ?? 'whole_person',
    preserveTemplateIdentity: false,
    applyIdentityTo: recipe.personContractTemplate?.applyIdentityTo ?? 'primary_subject_only',
  });
  // Slot Contract V2：服装策略随人物一起落合同（保存了「服装来自人物参考 /
  // 自定义服装」的 Skill，复用时不再退回「保留模板服装」）
  const customClothing = mod.clothingPolicy === 'custom'
    ? (input.customClothing ?? mod.customClothing).trim()
    : '';
  return updateVisualProjectSemanticState(project, 'person', draft => ({
    ...draft,
    references: [...draft.references.filter(ref => ref.kind !== 'person'), reference],
    modification: normalizeModificationContract({
      ...draft.modification,
      person,
      clothingPolicy: mod.clothingPolicy,
      customClothing,
    }, draft.regions),
    status: 'modified',
  }));
}

/** Recipe 概要（UI 展示：槽位 / 模板 / 技能 / 合同块 / 基线 Prompt 长度）。 */
export function describeSkillRecipe(recipe: SkillRecipe): {
  slots: Array<{ label: string; status: string }>;
  runtimeSkillCount: number;
  contractBlocks: string[];
  hasBaseline: boolean;
} {
  return {
    slots: deriveSkillInputSlots(recipe).map(slot => ({
      label: slot.label,
      status: slot.fixed
        ? (recipe.template ? '固定自带' : '缺失')
        : slot.required ? '使用时必选' : '可选',
    })),
    runtimeSkillCount: recipe.runtimeSkillIds.length,
    contractBlocks: recipe.compilerSections,
    hasBaseline: recipe.baselineFinalPrompt.trim().length > 0,
  };
}
