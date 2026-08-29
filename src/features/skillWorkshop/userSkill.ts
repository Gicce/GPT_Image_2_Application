import type { VisualProject } from '../vision/project/types';
import { buildEffectiveVisualPlan } from '../vision/project/effectivePlan';
import type { AssetRole, SkillDomain, SkillPackage, SkillProfile } from './types';
import {
  buildSkillRecipeFromProject,
  normalizeSkillRecipe,
  type SkillRecipe,
  type UserSkillKind,
} from './skillRecipe';
import {
  normalizeSkillExecutionMode,
  normalizeSkillOptimizationPolicy,
  type SkillExecutionMode,
  type SkillOptimizationPolicy,
} from './skillDirectExecution';

export type UserSkillStatus = 'local' | 'submitted' | 'under_review' | 'changes_requested' | 'rejected' | 'published';
export type SkillAuthoringState = 'project_template' | 'ai_candidate' | 'confirmed';

const USER_SKILL_STATUSES: readonly UserSkillStatus[] = [
  'local', 'submitted', 'under_review', 'changes_requested', 'rejected', 'published',
];

function normalizeUserSkillStatus(value: unknown): UserSkillStatus {
  return USER_SKILL_STATUSES.includes(value as UserSkillStatus) ? value as UserSkillStatus : 'local';
}

/** Skill 草稿 ID（Node 测试环境无 crypto.randomUUID 全局时回落，与 billingService 同式）。 */
function newUserSkillId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export interface SkillSourceFact {
  key: string;
  label: string;
  value: string;
  immutable: true;
}

export interface UserSkillSample {
  id: string;
  taskId: string;
  imagePath: string;
  selectedForSubmission: boolean;
  publicCover: boolean;
}

/**
 * V6.3 Skill 封面（Entity Cover §37-§48）——display-only 元数据：
 *  - 只影响「我的技能」卡片缩略图，绝不进入 Recipe / 模板资产 / 生成参数 / 投稿载荷；
 *  - library / custom 封面持有的是图库引用（删除 Skill 不删除图库文件）；
 *  - 本机改封面不会（也不会假装）同步已提交的服务器投稿记录。
 */
export type SkillCoverSource = 'template' | 'generated_result' | 'library' | 'custom';

export interface SkillCover {
  source: SkillCoverSource;
  /** library / custom 的封面资产路径（模板 / 生成样例来源在解析期动态取，不落路径）。 */
  path?: string;
  assetId?: string;
  updatedAt?: string;
}

/** 载入合法化：template / generated_result 不需要路径；library / custom 必须带非空 path。 */
export function normalizeSkillCover(raw: unknown): SkillCover | null {
  if (!raw || typeof raw !== 'object') return null;
  const cover = raw as Partial<SkillCover>;
  if (cover.source === 'template' || cover.source === 'generated_result') {
    return { source: cover.source };
  }
  if ((cover.source === 'library' || cover.source === 'custom') && typeof cover.path === 'string' && cover.path.trim()) {
    return {
      source: cover.source,
      path: cover.path.trim(),
      ...(typeof cover.assetId === 'string' && cover.assetId.trim() ? { assetId: cover.assetId.trim() } : {}),
      ...(typeof cover.updatedAt === 'string' && cover.updatedAt ? { updatedAt: cover.updatedAt } : {}),
    };
  }
  return null;
}

/** 公开样例路径：优先公开封面样例（publicCover），其次投稿选中样例，最后任一样例。 */
export function skillCoverSamplePath(draft: Pick<UserSkillDraft, 'samples'>): string | undefined {
  const chosen = draft.samples.find(sample => sample.publicCover)
    ?? draft.samples.find(sample => sample.selectedForSubmission)
    ?? draft.samples[0];
  return chosen?.imagePath?.trim() || undefined;
}

/**
 * 封面解析（纯函数，§44 优先级）：用户自定义（library / custom 带路径）＞
 * 公开生成样例（generated_result / 缺省兜底链）＞ 模板图（template）＞ null
 * （调用方回落类型 glyph）。只读引用，绝不复制 / 移动 / 删除任何文件。
 */
export function resolveSkillCoverPath(
  cover: SkillCover | null | undefined,
  context: { samplePath?: string; templatePath?: string },
): string | null {
  const sample = context.samplePath?.trim() || undefined;
  const template = context.templatePath?.trim() || undefined;
  if (cover && (cover.source === 'library' || cover.source === 'custom')) {
    return cover.path?.trim() || sample || template || null;
  }
  if (cover?.source === 'generated_result') return sample || template || null;
  if (cover?.source === 'template') return template || sample || null;
  // 旧数据（无封面字段）：同一优先级链兜底——公开样例 ＞ 模板图 ＞ 图标
  return sample || template || null;
}

export interface UserSkillDraft {
  schemaVersion: 2;
  id: string;
  name: string;
  domain: SkillDomain;
  version: string;
  /** V6：generic = 通用流程 Skill；template_reuse = 模板复用 Skill（走 Recipe 重建链路）。 */
  skillType: UserSkillKind;
  /** V6 模板复用方案快照（generic / 旧版本缺省 null，执行端回落通用编译）。 */
  recipe: SkillRecipe | null;
  /**
   * V6.2 默认执行方式：direct_generate = 快速生成（headless 直达报价确认）；
   * open_workbench = 高级调整（进视觉工作台）。旧 Skill 缺省 direct_generate。
   */
  executionMode: SkillExecutionMode;
  /**
   * V6.2 Prompt 策略：reuse_recipe = 复用保存基线（零优化调用）；
   * adaptive / always_reoptimize = 保存项目回到工作台后重优化。旧 Skill 缺省 reuse_recipe。
   */
  optimizationPolicy: SkillOptimizationPolicy;
  summary: string;
  applicableScenarios: string[];
  unsuitableScenarios: string[];
  authorNote: string;
  authoringState: SkillAuthoringState;
  sourceProjectId: string;
  sourceProjectName: string;
  sourceRevision: number;
  sourceFingerprint: string;
  sourceFacts: SkillSourceFact[];
  coreRules: string[];
  profiles: SkillProfile[];
  wizardSteps: Array<{ id: string; name: string; required: boolean; helper: string }>;
  assetRoles: AssetRole[];
  defaults: Record<string, string>;
  negativeRules: string[];
  blockers: string[];
  reviewRubric: string[];
  localAssetBindings: Array<{ role: AssetRole; path: string; fingerprint?: string }>;
  samples: UserSkillSample[];
  /** V6.3 封面（display-only；旧数据缺省 = 无字段，按样例＞模板＞图标链兜底）。 */
  cover?: SkillCover | null;
  ai?: { modelId: string; providerName: string; generalizedRevision: number; generatedAt: string };
  confirmedAt?: string;
  status: UserSkillStatus;
  submissionId?: string;
  reviewMessage?: string;
  createdAt: string;
  updatedAt: string;
}

const DIMENSIONS: Array<[keyof NonNullable<VisualProject['templateSnapshot']>, string]> = [
  ['subject', '主体结构'], ['action', '动作'], ['background', '场景'], ['composition', '构图'],
  ['camera', '镜头'], ['style', '风格'], ['lighting', '光线'], ['color', '色彩'], ['clothing', '服装'],
];

function cleanList(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map(value => (value ?? '').trim()).filter(Boolean))];
}

function domainFromProject(project: VisualProject): SkillDomain {
  const haystack = [project.name, project.templateSnapshot?.style.originalValue, project.modification.freeText].join(' ');
  if (/桌|显示器|键盘|电脑|工作台/i.test(haystack)) return 'desk_setup';
  if (/商品|电商|主图|详情页/i.test(haystack)) return 'ecommerce';
  if (/室内|建筑|房间|空间设计/i.test(haystack)) return 'interior';
  if (/界面|UI|网页|应用/i.test(haystack)) return 'ui';
  if (/运动|健身|跑步|球/i.test(haystack)) return 'sports';
  if (/品牌|广告|海报|Campaign/i.test(haystack)) return 'brand_ad';
  return 'product';
}

function assetRoleOf(kind: VisualProject['references'][number]['kind']): AssetRole {
  if (kind === 'person') return 'person';
  if (kind === 'background') return 'background_reference';
  if (kind === 'style') return 'style_reference';
  return 'product';
}

export function visualProjectFingerprint(project: VisualProject): string {
  return [project.id, project.revision, project.templateSnapshot?.analyzedAt ?? '', project.latestFinalPrompt?.length ?? 0].join(':');
}

export function extractVisualProjectFacts(project: VisualProject): SkillSourceFact[] {
  const facts: SkillSourceFact[] = [];
  const template = project.templateSnapshot;
  if (template) {
    for (const [key, label] of DIMENSIONS) {
      const field = template[key];
      if (field && typeof field === 'object' && 'originalValue' in field && field.originalValue.trim()) {
        facts.push({ key: String(key), label, value: field.originalValue.trim(), immutable: true });
      }
    }
  }
  const effective = buildEffectiveVisualPlan(project);
  for (const row of effective.rows) {
    if (!row.value.trim() || row.key === 'regions') continue;
    facts.push({ key: `contract:${row.key}`, label: row.label, value: row.value, immutable: true });
  }
  if (project.workspace.negativeDraft.trim()) {
    facts.push({ key: 'negative', label: '负面限制', value: project.workspace.negativeDraft.trim(), immutable: true });
  }
  return facts;
}

export function createUserSkillFromVisualProject(project: VisualProject): UserSkillDraft {
  const now = new Date().toISOString();
  const domain = domainFromProject(project);
  const facts = extractVisualProjectFacts(project);
  const recipe = buildSkillRecipeFromProject(project);
  const template = project.templateSnapshot;
  const coreRules = cleanList([
    template?.composition.originalValue && `保持专业、可执行的构图关系：${template.composition.originalValue}`,
    template?.camera.originalValue && `镜头与透视遵循：${template.camera.originalValue}`,
    project.renderingContract?.preserveTemplateMediaStructure ? '保持参考素材中的媒介分层，不得擅自统一为单一媒介。' : '',
    ...project.modification.activeDimensions.map(dimension => `将“${dimension}”作为用户可配置维度，不得写死原项目中的具体人物或文件。`),
  ]);
  const profiles: SkillProfile[] = [
    { id: 'project-base', name: '项目基线', kind: 'base', prompt: cleanList([
      template?.style.originalValue, template?.composition.originalValue, template?.camera.originalValue,
      template?.lighting.originalValue, template?.color.originalValue,
    ]).join('；') || '保持来源项目的专业结构与视觉关系。' },
    { id: 'source-style', name: '来源风格', kind: 'style', prompt: template?.style.originalValue || '沿用来源项目的视觉设计语言。' },
    { id: 'none', name: '无主题', kind: 'theme', prompt: '不附加额外主题或第三方 IP。' },
  ];
  const assetRoles = [...new Set<AssetRole>([
    'style_reference',
    ...project.references.map(reference => assetRoleOf(reference.kind)),
    ...(project.modification.person ? ['person' as AssetRole] : []),
  ])];
  const localAssetBindings = project.references.map(reference => ({ role: assetRoleOf(reference.kind), path: reference.path }));
  if (project.sourceAsset.path) localAssetBindings.unshift({ role: 'style_reference', path: project.sourceAsset.path });
  return {
    schemaVersion: 2,
    id: newUserSkillId(),
    name: `${project.name} Skill`,
    domain,
    version: '1.0.0',
    skillType: recipe.skillType,
    recipe,
    executionMode: 'direct_generate',
    optimizationPolicy: 'reuse_recipe',
    summary: '由视觉理解项目提取的可复用图片创作流程。',
    applicableScenarios: [],
    unsuitableScenarios: [],
    authorNote: '',
    authoringState: 'project_template',
    sourceProjectId: project.id,
    sourceProjectName: project.name,
    sourceRevision: project.revision,
    sourceFingerprint: visualProjectFingerprint(project),
    sourceFacts: facts,
    coreRules,
    profiles,
    wizardSteps: [
      { id: 'purpose', name: '填写用途', required: true, helper: '说明希望生成的图片和使用场景。' },
      { id: 'assets', name: '准备素材', required: assetRoles.length > 0, helper: '按素材角色上传真实参考图片。' },
      { id: 'profiles', name: '选择风格', required: true, helper: '选择基础风格与可选主题。' },
      { id: 'review', name: '确认方案', required: true, helper: '检查规则、引用关系与生成参数。' },
    ],
    assetRoles,
    defaults: {
      base: 'project-base', style: 'source-style', theme: 'none', platform: 'general',
      size: project.workspace.genParams.size, quality: project.workspace.genParams.quality,
      count: String(project.workspace.genParams.count),
    },
    negativeRules: cleanList(project.workspace.negativeDraft.split(/[；;\n]/)),
    blockers: ['公开投稿前必须完成 AI 通用化并确认当前项目修订。'],
    reviewRubric: ['任务完成度', '主体与引用一致性', '构图保持', '风格一致性', '技术质量'],
    localAssetBindings,
    samples: [],
    // V6.3 默认封面 = 模板图（模板复用 Skill 恒有模板资产；解析期动态取，不落死路径）
    cover: { source: 'template' },
    status: 'local',
    createdAt: now,
    updatedAt: now,
  };
}

export function userSkillToPackage(draft: UserSkillDraft): SkillPackage {
  return {
    schema_version: 1,
    skill_id: `community_${draft.id.replace(/-/g, '_')}`,
    version: draft.version,
    name: draft.name,
    domain: draft.domain,
    summary: draft.summary,
    readiness: 'ready',
    wizard_steps: draft.wizardSteps.map(step => step.name),
    profiles: draft.profiles,
    core_rules: draft.coreRules,
    defaults: draft.defaults,
    asset_roles: draft.assetRoles,
    review_rubric: draft.reviewRubric,
  };
}

/**
 * 载入时合法化：schemaVersion 1（V4.2.3 旧 Skill）→ generic（无 Recipe，
 * 走通用编译器，行为与旧版完全一致）；schemaVersion 2 → 校验 Recipe 完整性，
 * 损坏的 template_reuse Recipe 回落 generic（绝不按残缺快照执行）。
 */
export function normalizeUserSkillDraft(raw: unknown): UserSkillDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const draft = raw as Partial<UserSkillDraft>;
  if (!draft.id || typeof draft.id !== 'string') return null;
  const cover = normalizeSkillCover(draft.cover);
  const base: UserSkillDraft = {
    schemaVersion: 2,
    id: draft.id,
    name: typeof draft.name === 'string' ? draft.name : '未命名 Skill',
    domain: draft.domain ?? 'product',
    version: draft.version ?? '1.0.0',
    skillType: 'generic',
    recipe: null,
    // V6.2 旧 Recipe / 旧版本缺省：快速生成 + 复用保存基线（绝不偷偷重新优化）
    executionMode: normalizeSkillExecutionMode(draft.executionMode),
    optimizationPolicy: normalizeSkillOptimizationPolicy(draft.optimizationPolicy),
    summary: draft.summary ?? '',
    applicableScenarios: draft.applicableScenarios ?? [],
    unsuitableScenarios: draft.unsuitableScenarios ?? [],
    authorNote: draft.authorNote ?? '',
    authoringState: draft.authoringState ?? 'project_template',
    sourceProjectId: draft.sourceProjectId ?? '',
    sourceProjectName: draft.sourceProjectName ?? '',
    sourceRevision: draft.sourceRevision ?? 0,
    sourceFingerprint: draft.sourceFingerprint ?? '',
    sourceFacts: Array.isArray(draft.sourceFacts) ? draft.sourceFacts : [],
    coreRules: Array.isArray(draft.coreRules) ? draft.coreRules : [],
    profiles: Array.isArray(draft.profiles) ? draft.profiles : [],
    wizardSteps: Array.isArray(draft.wizardSteps) ? draft.wizardSteps : [],
    assetRoles: Array.isArray(draft.assetRoles) ? draft.assetRoles : [],
    defaults: draft.defaults ?? {},
    negativeRules: Array.isArray(draft.negativeRules) ? draft.negativeRules : [],
    blockers: Array.isArray(draft.blockers) ? draft.blockers : [],
    reviewRubric: Array.isArray(draft.reviewRubric) ? draft.reviewRubric : [],
    localAssetBindings: Array.isArray(draft.localAssetBindings) ? draft.localAssetBindings : [],
    samples: Array.isArray(draft.samples) ? draft.samples : [],
    ...(cover ? { cover } : {}),
    status: normalizeUserSkillStatus(draft.status),
    createdAt: draft.createdAt ?? new Date().toISOString(),
    updatedAt: draft.updatedAt ?? new Date().toISOString(),
    ...(draft.ai ? { ai: draft.ai } : {}),
    ...(draft.confirmedAt ? { confirmedAt: draft.confirmedAt } : {}),
    ...(draft.submissionId ? { submissionId: draft.submissionId } : {}),
    ...(draft.reviewMessage ? { reviewMessage: draft.reviewMessage } : {}),
  };
  if (draft.schemaVersion !== 2) return base;
  const recipe = normalizeSkillRecipe(draft.recipe);
  // Recipe 为空对象的 v2 草稿 = 通用 Skill；有 template_reuse Recipe 但校验失败 = 回落通用
  if (!recipe || recipe.skillType === 'generic') return base;
  return { ...base, skillType: 'template_reuse', recipe };
}

const LOCAL_PATH = /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|var|opt|tmp)\/)[^\s，。；]+/gi;
const SECRET = /(?:api[_ -]?key|bearer|token|secret|password)\s*[:=]\s*\S+/gi;
const PRIVATE_IDENTITY = /(?:身份证|手机号|邮箱)\s*[:：]?\s*\S+/gi;

export function sanitizeUserSkillForSubmission(draft: UserSkillDraft): { payload: Record<string, unknown>; risks: string[] } {
  // 隐私铁律：Recipe（含完整项目快照与本地路径）只在本地保存，绝不进入投稿载荷
  const risks: string[] = [];
  const scrub = (value: string): string => value
    .replace(LOCAL_PATH, () => { risks.push('已移除本地文件路径'); return '[素材槽位]'; })
    .replace(SECRET, () => { risks.push('已移除疑似访问凭据'); return '[已移除敏感信息]'; })
    .replace(PRIVATE_IDENTITY, () => { risks.push('已移除疑似个人身份信息'); return '[人物身份槽位]'; });
  const cleanArray = (items: string[]) => items.map(scrub).map(item => item.trim()).filter(Boolean);
  const payload = {
    schema_version: 1,
    availability: 'testing',
    wizard_steps: draft.wizardSteps,
    profiles: draft.profiles.map(profile => ({ ...profile, prompt: scrub(profile.prompt) })),
    asset_roles: draft.assetRoles.map(id => ({ id })),
    core_rules: cleanArray(draft.coreRules),
    review_rubric: cleanArray(draft.reviewRubric),
    defaults: draft.defaults,
    negative_rules: cleanArray(draft.negativeRules),
    blockers: cleanArray(draft.blockers),
    applicable_scenarios: cleanArray(draft.applicableScenarios),
    unsuitable_scenarios: cleanArray(draft.unsuitableScenarios),
    author_note: scrub(draft.authorNote),
    authoring: draft.ai ? { model_id: draft.ai.modelId, generalized_revision: draft.ai.generalizedRevision, generated_at: draft.ai.generatedAt } : null,
  };
  return { payload, risks: [...new Set(risks)] };
}

export function validateUserSkillDraft(draft: UserSkillDraft, forSubmission = false): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push('请填写 Skill 名称。');
  if (!draft.summary.trim()) errors.push('请填写 Skill 简介。');
  if (draft.coreRules.length === 0) errors.push('至少需要一条 Core Rule。');
  if (!draft.profiles.some(profile => profile.kind === 'base')) errors.push('至少需要一个 Base Profile。');
  if (forSubmission) {
    if (draft.authoringState !== 'confirmed' || draft.ai?.generalizedRevision !== draft.sourceRevision) {
      errors.push('公开投稿前必须完成并确认当前项目修订的 AI 通用化。');
    }
    if (!draft.samples.some(sample => sample.selectedForSubmission)) errors.push('公开投稿至少选择一张成功生成样例。');
  }
  return errors;
}

/** 已进入投稿/审核/公开流程的状态（删除本地副本不等于撤稿，文案必须区分）。 */
const SUBMISSION_LIKE_STATUSES: readonly string[] = ['submitted', 'under_review', 'changes_requested', 'published'];

/**
 * 删除「我的技能」确认文案（V6.1 纯函数——确认弹窗与测试共用，禁止两处漂移）：
 *  - 只删除本机 Skill 实体（SQLite user_skills 行）；
 *  - 服务器投稿记录 / 公共技能库不受影响（撤稿是独立产品能力，当前不支持）；
 *  - 已创建的历史项目 / 历史任务 / 图库原图一律保留。
 */
export function describeSkillDeleteNotice(input: {
  status: string;
  hasSubmissionRecord?: boolean;
}): { submissionLine: string | null; scopeLines: string[] } {
  const submitted = SUBMISSION_LIKE_STATUSES.includes(input.status) || Boolean(input.hasSubmissionRecord);
  return {
    submissionLine: submitted
      ? '该 Skill 已提交审核。删除本地 Skill 不会撤回已提交的审核记录。'
      : null,
    scopeLines: [
      '本机保存的 Skill 将移除。',
      '已由该 Skill 创建的历史项目和历史任务不会删除。',
    ],
  };
}
