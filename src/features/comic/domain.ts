/**
 * AI 漫画领域动作（Phase 1）：Skill Patch 白名单应用、快照冻结、
 * 生成门禁（角色确认 / Anchor 锁定）、Story 应用与 stale 标记、对白纯本地操作。
 * 全部纯函数——UI 只调 domain action，禁止组件自行展开赋值（对齐视觉域铁律）。
 */
import { normalizeNumber, normalizeText, normalizeTextArray } from './normalize';
import { presentationPatchFor, type ComicPresentationTemplate } from './presentation';
import type {
  ComicCharacter,
  ComicConcept,
  ComicDialogue,
  ComicProject,
  ComicPresentationSource,
  ComicSkill,
  ComicSkillPatch,
  ComicStory,
  ComicPanel,
  ComicConsistencyProfile,
  ComicFinalPageAsset,
} from './types';

// ---------------------------------------------------------------------------
// Skill Patch（验收 C：只动相关字段，其余引用相等）
// ---------------------------------------------------------------------------

/** 补丁字段白名单：LLM 只能改这些路径，其余一律忽略。 */
export const COMIC_SKILL_PATCH_FIELDS = [
  'name',
  'description',
  'comicForm',
  'visualStyle',
  'storyPattern',
  'dialogueStyle',
  'humorStyle',
  'promptTemplate',
  'intent.purpose',
  'intent.tone',
  'intent.platform',
  'layout.panelCount',
  'layout.arrangement',
  'layout.description',
  'textStyle.bubbleStyle',
  'textStyle.fontHint',
  'generationRules.negativeConstraints',
  'generationRules.environmentTextAllowed',
  'consistencyRules',
  'referenceStrategy.useAnchorAsStyle',
  'referenceStrategy.characterRefs',
  'exportDefaults.canvasRatio',
  'characterSlot.displayRule',
  'characterSlot.name',
  'characterSlot.required',
  'characterSlot.defaultCharacterId',
] as const;

export type ComicSkillPatchField = (typeof COMIC_SKILL_PATCH_FIELDS)[number];

const CHARACTER_SLOT_FIELDS = new Set<string>([
  'characterSlot.displayRule',
  'characterSlot.name',
  'characterSlot.required',
  'characterSlot.defaultCharacterId',
]);

const TEXT_ARRAY_FIELDS = new Set<string>([
  'generationRules.negativeConstraints',
  'consistencyRules',
]);

/** 归一一条 LLM 补丁：白名单外丢弃；characterSlot.* 必须带 slotId。 */
export function normalizeComicSkillPatch(value: unknown): ComicSkillPatch | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const field = normalizeText(record.field ?? record.path);
  if (!(COMIC_SKILL_PATCH_FIELDS as readonly string[]).includes(field)) return null;
  const slotId = normalizeText(record.slotId) || undefined;
  if (CHARACTER_SLOT_FIELDS.has(field) && !slotId) return null;
  return { field: field as ComicSkillPatchField, value: record.value, slotId, reason: normalizeText(record.reason) || undefined };
}

/** 不可变路径写入：只浅拷贝路径上的分支，未触及分支保持原引用（验收 C）。 */
function withPath<T extends object>(source: T, segments: string[], value: unknown): T {
  const [head, ...rest] = segments;
  const record = source as Record<string, unknown>;
  let nextValue: unknown;
  if (!rest.length) {
    nextValue = value;
  } else {
    const current = record[head];
    const base = current && typeof current === 'object'
      ? current as Record<string, unknown>
      : {};
    nextValue = withPath(base, rest, value);
  }
  return { ...record, [head]: nextValue } as T;
}

function coercePatchValue(field: string, value: unknown): unknown {
  if (TEXT_ARRAY_FIELDS.has(field)) return normalizeTextArray(value);
  if (field === 'layout.panelCount') return normalizeNumber(value, 2, 1, 12);
  if (field === 'generationRules.environmentTextAllowed') return value === true;
  if (field === 'referenceStrategy.useAnchorAsStyle') return value !== false;
  if (field === 'characterSlot.required') return value !== false;
  if (field === 'layout.arrangement') {
    const text = normalizeText(value);
    return ['vertical_2', 'grid_4', 'single', 'custom'].includes(text) ? text : undefined;
  }
  if (field === 'referenceStrategy.characterRefs') {
    return normalizeText(value) === 'optional' ? 'optional' : 'required';
  }
  if (field === 'exportDefaults.canvasRatio') {
    const text = normalizeText(value);
    return ['1:1', '3:4', '9:16'].includes(text) ? text : undefined;
  }
  return normalizeText(value);
}

export interface ComicSkillPatchResult {
  skill: ComicSkill;
  applied: string[];
  ignored: string[];
}

/**
 * 应用结构化补丁：parse request → structured patch → validate → apply。
 * 结构共享：未列出的字段（含子对象）保持引用相等，仅重写受影响分支。
 * 补丁值经 coercePatchValue 单点归一（enum / 数字钳制 / 数组清洗），不做整卡重归一。
 */
export function applyComicSkillPatches(skill: ComicSkill, patches: unknown): ComicSkillPatchResult {
  const list = Array.isArray(patches)
    ? patches.map(normalizeComicSkillPatch).filter((patch): patch is ComicSkillPatch => patch !== null)
    : [];
  const applied: string[] = [];
  const ignored: string[] = [];
  let next: ComicSkill = skill;
  for (const patch of list) {
    const value = coercePatchValue(patch.field, patch.value);
    if (value === undefined || value === '') {
      ignored.push(patch.field);
      continue;
    }
    if (patch.field.startsWith('characterSlot.')) {
      const key = patch.field.slice('characterSlot.'.length) as keyof ComicSkill['characterSlots'][number];
      const target = next.characterSlots.find((slot) => slot.slotId === patch.slotId);
      if (!target) {
        ignored.push(patch.field);
        continue;
      }
      const patched = { ...target, [key]: value } as ComicSkill['characterSlots'][number];
      next = {
        ...next,
        characterSlots: next.characterSlots.map((slot) => (slot.slotId === patch.slotId ? patched : slot)),
      };
    } else {
      next = withPath(next, patch.field.split('.'), value);
    }
    applied.push(patch.slotId ? `${patch.field}(${patch.slotId})` : patch.field);
  }
  if (next !== skill) next = { ...next, updatedAt: new Date().toISOString() };
  return { skill: next, applied, ignored };
}

// ---------------------------------------------------------------------------
// Character Patch（对话式改角色：只动指令涉及的字段）
// ---------------------------------------------------------------------------

/** 角色补丁字段白名单：LLM 只能改这些路径（不可碰 id/status/source/参考图）。 */
export const COMIC_CHARACTER_PATCH_FIELDS = [
  'name',
  'description',
  'role',
  'appearance',
  'immutableTraits',
  'mutableTraits',
  'defaultClothing',
  'colorPalette',
  'negativeConstraints',
] as const;

export type ComicCharacterPatchField = (typeof COMIC_CHARACTER_PATCH_FIELDS)[number];

const CHARACTER_TEXT_ARRAY_FIELDS = new Set<string>([
  'immutableTraits',
  'mutableTraits',
  'colorPalette',
  'negativeConstraints',
]);

export function normalizeComicCharacterPatch(value: unknown): ComicSkillPatch | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const field = normalizeText(record.field ?? record.path);
  if (!(COMIC_CHARACTER_PATCH_FIELDS as readonly string[]).includes(field)) return null;
  return { field: field as ComicCharacterPatchField, value: record.value, reason: normalizeText(record.reason) || undefined };
}

export interface ComicCharacterPatchResult {
  character: ComicCharacter;
  applied: string[];
  ignored: string[];
}

export function applyComicCharacterPatches(
  character: ComicCharacter,
  patches: unknown,
): ComicCharacterPatchResult {
  const list = Array.isArray(patches)
    ? patches.map(normalizeComicCharacterPatch).filter((patch): patch is ComicSkillPatch => patch !== null)
    : [];
  const applied: string[] = [];
  const ignored: string[] = [];
  let next: ComicCharacter = character;
  for (const patch of list) {
    const value = CHARACTER_TEXT_ARRAY_FIELDS.has(patch.field)
      ? normalizeTextArray(patch.value)
      : normalizeText(patch.value);
    if (!value || (Array.isArray(value) && value.length === 0)) {
      ignored.push(patch.field);
      continue;
    }
    next = { ...next, [patch.field]: value } as ComicCharacter;
    applied.push(patch.field);
  }
  if (next !== character) {
    // 验收 §九：Brief 变更后旧参考图不再代表最新角色设定 → 标记过期（换新图时清除）。
    next = {
      ...next,
      referenceStale: character.referenceImage ? true : undefined,
      updatedAt: new Date().toISOString(),
    };
  }
  return { character: next, applied, ignored };
}

// ---------------------------------------------------------------------------
// 快照（规格 §8.3 / §41：项目冻结，改库不回写）
// ---------------------------------------------------------------------------

export function createSkillSnapshot(skill: ComicSkill): ComicSkill {
  return JSON.parse(JSON.stringify(skill)) as ComicSkill;
}

export function createCharacterSnapshot(character: ComicCharacter): ComicCharacter {
  return JSON.parse(JSON.stringify(character)) as ComicCharacter;
}

// ---------------------------------------------------------------------------
// 生成门禁（验收 D / E / J）
// ---------------------------------------------------------------------------

export interface ComicGenerationReadiness {
  ready: boolean;
  blockers: string[];
}

/**
 * 必选槽位门禁（验收 D）：全部锁定才放行（Phase 1.1 起 draft/confirmed 都不放行——
 * 锁定 = Brief 确认 + 参考图就绪 + 用户显式锁定）。选配槽位不参与。
 */
export function comicCharacterConfirmationState(project: ComicProject): ComicGenerationReadiness {
  const blockers: string[] = [];
  const refsRequired = project.skillSnapshot.referenceStrategy.characterRefs === 'required';
  for (const slot of project.skillSnapshot.characterSlots) {
    if (!slot.required) continue;
    const characterId = project.characterBindings[slot.slotId];
    if (!characterId) {
      blockers.push(`角色「${slot.name}」未绑定`);
      continue;
    }
    const character = project.characterSnapshots.find((item) => item.id === characterId);
    if (!character) {
      blockers.push(`角色「${slot.name}」绑定失效`);
      continue;
    }
    if (character.status === 'draft') {
      blockers.push(`角色「${character.name}」尚未确认锁定`);
    } else if (character.status === 'confirmed') {
      blockers.push(`角色「${character.name}」已确认未锁定`);
    } else if (refsRequired && !character.referenceImage) {
      // 兜底：旧版本项目可能存在「锁定但缺参考图」的历史数据，给出修复指引。
      blockers.push(`角色「${character.name}」已锁定但缺少参考图，请生成或从图库选择`);
    }
  }
  return { ready: blockers.length === 0, blockers };
}

/** Anchor 门禁（验收 J）：批量生成剩余 Panel 需要 Anchor 锁定，或显式 fallback。 */
export function comicPanelSeriesReadiness(
  project: ComicProject,
  options: { skipAnchor?: boolean } = {},
): ComicGenerationReadiness {
  const confirmation = comicCharacterConfirmationState(project);
  const blockers = [...confirmation.blockers, ...comicStoryboardReadiness(project).blockers];
  if (!options.skipAnchor && !project.consistency?.anchor) {
    blockers.push('第一格尚未确认（已开启「生成第一格后暂停确认」）');
  }
  return { ready: blockers.length === 0, blockers };
}

export interface ComicStoryboardReadiness {
  ready: boolean;
  blockers: string[];
}

/**
 * 分镜门禁（V4.2.11 §E）：进入生成前分镜必须铺满本期版式——
 * 有分镜，且格数不少于本期计划格数（四宫格 = 4 格全 valid）。
 * 单格内容有效性由 normalizeComicPanel 保证（scene 为空直接判无效不入库）。
 */
export function comicStoryboardReadiness(project: ComicProject): ComicStoryboardReadiness {
  const panels = project.panels.filter(panel => !panel.stale);
  const blockers: string[] = [];
  if (panels.length === 0) {
    blockers.push('缺少分镜');
    return { ready: false, blockers };
  }
  const planned = project.story?.panelCount ?? project.skillSnapshot.layout.panelCount;
  if (panels.length < planned) {
    blockers.push(`分镜还缺 ${planned - panels.length} 格（本期共 ${planned} 格）`);
  }
  return { ready: blockers.length === 0, blockers };
}

// ---------------------------------------------------------------------------
// Story 应用（验收 G / 规格 §42 stale）
// ---------------------------------------------------------------------------

export interface StoryApplyResult {
  project: ComicProject;
  staleMarked: number;
  /** Story Lock 防线：story 与已确认故事指纹不一致时拒绝（project 原样返回）。 */
  rejected?: string;
  /** Story Lock：分镜重出时按格序保留下来的人工 / AI 直排对白数。 */
  preservedDialogues?: number;
  /** Story Lock 可见性：故事重新确认后随旧代分镜归档的人工 / AI 直排对白数。 */
  archivedDialogues?: number;
}

/**
 * Story 指纹（内容级，V4.2.13 Story Lock）：同一故事的多次派生（分镜草稿 / 重出）
 * 指纹不变；任一叙事字段变化 = 不同故事。分镜草稿恢复与应用都用它校验
 * 「草稿是否还属于当前已确认的故事」（过期草稿不复活旧 story）。
 * 注意 panelCount 不入指纹：repairStoryboard 会按现实格数回写 panelCount
 * （同故事草稿的合法性调解），不算故事内容变化。
 */
export function comicStoryFingerprint(story: ComicStory): string {
  return [
    story.title,
    story.topic,
    story.summary,
    story.endingType,
    story.beats.join('\n'),
    story.characterIds.join('\n'),
  ].join('§');
}

/**
 * 应用新 Story（V4.2.13 Story Lock 语义）：
 *  - 新 panels 整体接管；上一代已生成图的 Panel 转为 stale 副本追加在末尾（保留一代
 *    供回看，不再进入任何生成输入）。Anchor 已锁定则 consistency 档案原样保留；
 *  - 分镜种子对白标 placementSource='story_seed'；已确认故事同指纹才允许应用
 *    （过期分镜草稿不复活旧 story，R1 防线）；
 *  - 人工 / AI 直排对白（manual / planner / vision / 旧数据无标记）按格序迁移到
 *    新分镜同序格并优先保留；种子对白只补没有保留对白的空白格（AI 只补空白 +
 *    人工修改优先级最高，R2/R7 修复）。
 */
export function applyStoryToProject(
  project: ComicProject,
  story: ComicStory,
  panels: ComicPanel[],
  dialogues: ComicDialogue[],
): StoryApplyResult {
  if (project.story && comicStoryFingerprint(project.story) !== comicStoryFingerprint(story)) {
    return {
      project,
      staleMarked: 0,
      rejected: '分镜草稿属于旧故事（故事已重新确认），请重新生成分镜',
    };
  }
  const staleCopies = project.panels
    .filter((panel) => panel.imageAsset && !panel.stale)
    .map((panel) => ({ ...panel, stale: true }));
  const incoming = dialogues.map((item) =>
    (item.placementSource ? item : { ...item, placementSource: 'story_seed' as const }));
  // 旧活跃格 order → 新分镜同序格 id（重出分镜格数可能变少）
  const newPanelIdByOrder = new Map(panels.map((panel) => [panel.order, panel.id]));
  const oldOrderByPanelId = new Map(
    project.panels.filter((panel) => !panel.stale).map((panel) => [panel.id, panel.order]),
  );
  const preserved: ComicDialogue[] = [];
  for (const dialogue of project.dialogues) {
    if (dialogue.placementSource === 'story_seed') continue; // 未动过的种子：由新种子接管
    const order = oldOrderByPanelId.get(dialogue.panelId);
    if (order === undefined) continue; // 挂在已 stale 的旧代格上 → 随旧代淘汰
    const remapPanelId = newPanelIdByOrder.get(order);
    if (!remapPanelId) continue; // 新分镜没有这一序位
    preserved.push({ ...dialogue, panelId: remapPanelId });
  }
  // 种子只补空白：已保留人工对白的格序不再灌入种子草稿（preserved 已重映射到新格 id）
  const orderNewByPanelId = new Map(panels.map((panel) => [panel.id, panel.order]));
  const preservedOrders = new Set(
    preserved
      .map((dialogue) => orderNewByPanelId.get(dialogue.panelId))
      .filter((order): order is number => order !== undefined),
  );
  const seeded = incoming.filter((dialogue) => {
    const order = panels.find((panel) => panel.id === dialogue.panelId)?.order;
    return order === undefined || !preservedOrders.has(order);
  });
  const next: ComicProject = {
    ...project,
    story,
    panels: [...panels, ...staleCopies],
    dialogues: [...preserved, ...seeded],
    consistency: project.consistency?.anchor ? project.consistency : undefined,
    updatedAt: new Date().toISOString(),
  };
  return { project: next, staleMarked: staleCopies.length, preservedDialogues: preserved.length };
}

/**
 * Phase 1.2 Step 1（本期故事）：只确认故事，不带分镜。分镜草稿在 Step 4 生成；
 * 旧故事配套的活跃分镜整体转 stale（§74：Story 变化 → Storyboard/Anchor/Series 过期；
 * 保留一代供回看，不再进入任何生成输入）。Anchor 档案保留（风格锚不随故事重排丢失）。
 * 故事内容与已确认故事一致时为幂等 no-op（不重复 stale 化）。
 */
export function applyStoryOnlyToProject(project: ComicProject, story: ComicStory): StoryApplyResult {
  const storyChanged = !project.story
    || comicStoryFingerprint(project.story) !== comicStoryFingerprint(story);
  if (!storyChanged) {
    return { project, staleMarked: 0 };
  }
  const staleCopies = project.panels
    .filter((panel) => !panel.stale)
    .map((panel) => ({ ...panel, stale: true }));
  // 随旧故事归档的对白（挂在被 stale 化的旧代格上；数据保留、不再渲染）——
  // 返回计数供 UI 提示，避免"旧代对白去哪了"的静默淘汰（Story Lock 可见性）。
  const archivedPanelIds = new Set(staleCopies.map((panel) => panel.id));
  const archivedDialogues = project.dialogues.filter(
    (dialogue) => archivedPanelIds.has(dialogue.panelId) && dialogue.placementSource !== 'story_seed',
  ).length;
  const next: ComicProject = {
    ...project,
    story,
    panels: staleCopies,
    consistency: project.consistency?.anchor ? project.consistency : undefined,
    updatedAt: new Date().toISOString(),
  };
  return {
    project: next,
    staleMarked: staleCopies.filter((panel) => panel.imageAsset).length,
    archivedDialogues,
  };
}

/**
 * V4.2.7 §十五：选中推荐方案 → 本期故事草稿。写入 uiDraft.story.storyDraft
 * （phase=review），用户进入 Step 1「本期故事」即看到完整故事并审定——
 * 推荐 storyboardBeats 是预演，这里只转成 ComicStory.beats 叙事节拍，
 * 不创建正式 ComicPanel（正式分镜在 Step 4 由 Storyboard Planner 展开）。
 */
export function buildStoryDraftFromConcept(concept: ComicConcept): ComicStory {
  return {
    title: concept.storyTitle || concept.name,
    topic: concept.oneLineStory,
    summary: concept.fullStory,
    characterIds: [],
    beats: concept.storyboardBeats.map(beat =>
      beat.title && beat.summary ? `${beat.title}：${beat.summary}` : (beat.title || beat.summary)),
    endingType: concept.punchline.trim() ? 'punchline' : 'twist',
    panelCount: concept.layout.panelCount,
  };
}

// ---------------------------------------------------------------------------
// Presentation 应用（Phase 1.2 Step 2「画面与形式」）
// ---------------------------------------------------------------------------

export interface PresentationApplyResult {
  project: ComicProject;
  /** 展示形式是否真的变化（同模板重选 = no-op） */
  changed: boolean;
  /** 格数变化：既有活跃分镜需重新规划（§73 UI 提示用） */
  panelCountChanged: boolean;
}

/**
 * 选择展示形式模板：skill.layout 写入模板几何；story.panelCount 同步计划格数。
 * §74 按真实依赖标 stale：
 *  - 格数变化（四宫格→九宫格）→ 活跃分镜整体 stale（保留一代回看，Step 4 重出分镜）；
 *  - 仅排版变化（上下双格→左右双格，格数不变）→ 面板图不受影响，不 stale。
 * Anchor 档案保留（风格锚不随排版丢失）。同模板同几何重选 = 幂等 no-op。
 */
export function applyPresentationToProject(
  project: ComicProject,
  template: ComicPresentationTemplate,
): PresentationApplyResult {
  const patch = presentationPatchFor(template);
  const layout = project.skillSnapshot.layout;
  // pageCount 双侧缺省视为相等（非多页模板不带页数，不因 undefined 判变）
  const effectivePageCount = patch.pageCount ?? layout.pageCount;
  const unchanged = layout.arrangement === patch.arrangement
    && layout.panelCount === patch.panelCount
    && (layout.pageCount ?? effectivePageCount) === effectivePageCount;
  if (unchanged) {
    return { project, changed: false, panelCountChanged: false };
  }
  const currentPlan = project.story?.panelCount ?? layout.panelCount;
  const panelCountChanged = currentPlan !== patch.panelCount;
  const staleCopies = panelCountChanged
    ? project.panels
      .filter((panel) => !panel.stale)
      .map((panel) => ({ ...panel, stale: true }))
    : project.panels;
  const next: ComicProject = {
    ...project,
    skillSnapshot: {
      ...project.skillSnapshot,
      layout: { ...layout, ...patch },
    },
    story: project.story ? { ...project.story, panelCount: patch.panelCount } : project.story,
    panels: staleCopies,
    consistency: project.consistency?.anchor ? project.consistency : undefined,
    // V4.2.8 §54/§56：用户在「画面与形式」显式选择 = 新的 user_fixed 基线
    //（此前即使是 ai_recommended，显式改选后也是用户意志）。
    presentationSource: 'user_fixed',
    updatedAt: new Date().toISOString(),
  };
  return { project: next, changed: true, panelCountChanged };
}

// ---------------------------------------------------------------------------
// Presentation Lock（V4.2.8 §54）：user_fixed 的排版是对话式补丁禁区
// ---------------------------------------------------------------------------

/** layout 白名单字段（对话式微调不可触碰的路径）。 */
const PRESENTATION_LOCK_PATCH_FIELDS = new Set(['layout.panelCount', 'layout.arrangement']);

/**
 * 守护 user_fixed 排版：presentationSource='user_fixed' 时过滤掉改 layout 的补丁，
 * 其余补丁原样通过。显式选择卡（applyPresentationToProject）不受此限——那是用户
 * 自己在改，不是 planner 偷改。
 */
export function guardComicPatchesAgainstPresentationLock(
  patches: readonly ComicSkillPatch[],
  presentationSource: ComicPresentationSource | undefined,
): { patches: ComicSkillPatch[]; ignored: string[] } {
  if (presentationSource !== 'user_fixed') {
    return { patches: [...patches], ignored: [] };
  }
  const kept: ComicSkillPatch[] = [];
  const ignored: string[] = [];
  for (const patch of patches) {
    if (PRESENTATION_LOCK_PATCH_FIELDS.has(patch.field)) {
      ignored.push(patch.field);
      continue;
    }
    kept.push(patch);
  }
  return { patches: kept, ignored };
}

/**
 * 选择对白呈现方式（§12.2）：只写 skill.textStyle.dialogueMode。
 * 文字层独立于图片（§12.3）——不触碰任何面板 / 生成状态。同值重选 = no-op。
 */
export function applyDialogueModeToProject(
  project: ComicProject,
  mode: NonNullable<ComicSkill['textStyle']['dialogueMode']>,
): ComicProject {
  const textStyle = project.skillSnapshot.textStyle;
  if ((textStyle.dialogueMode ?? 'bubble') === mode) return project;
  return {
    ...project,
    skillSnapshot: {
      ...project.skillSnapshot,
      textStyle: { ...textStyle, dialogueMode: mode },
    },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 选择视觉风格预设（§12.1）：写入 skill.visualStyle（提示词级值）。
 * 只影响后续生图输入，不回改已生成图片；同值重选 = no-op。
 */
export function applyVisualStyleToProject(project: ComicProject, promptText: string): ComicProject {
  const trimmed = promptText.trim();
  if (!trimmed || project.skillSnapshot.visualStyle === trimmed) return project;
  return {
    ...project,
    skillSnapshot: { ...project.skillSnapshot, visualStyle: trimmed },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 对白纯本地操作：增删改只动 dialogues，结构上不触发生图（验收 I 的数据层保证）。
 * Story Lock：story_seed 种子一经人工改动即升级 manual（人工修改优先级最高，
 * 重出分镜时 manual 对白按格序保留，种子只补空白）。
 */
export function upsertDialogue(project: ComicProject, dialogue: ComicDialogue): ComicProject {
  const exists = project.dialogues.some((item) => item.id === dialogue.id);
  const nextDialogue = exists && dialogue.placementSource === 'story_seed'
    ? { ...dialogue, placementSource: 'manual' as const }
    : dialogue;
  return {
    ...project,
    dialogues: exists
      ? project.dialogues.map((item) => (item.id === dialogue.id ? nextDialogue : item))
      : [...project.dialogues, nextDialogue],
    updatedAt: new Date().toISOString(),
  };
}

export function removeDialogue(project: ComicProject, dialogueId: string): ComicProject {
  return {
    ...project,
    dialogues: project.dialogues.filter((item) => item.id !== dialogueId),
    updatedAt: new Date().toISOString(),
  };
}

export function dialoguesOfPanel(project: ComicProject, panelId: string): ComicDialogue[] {
  return project.dialogues.filter((item) => item.panelId === panelId);
}

/**
 * V4.2.14 §79：对白 z 序 = dialogues 数组顺序（渲染序）。front = 移到本格最后
 * （最上层），back = 移到本格最前（最底层）；同格内重排，其他格顺序不动。
 */
export function moveDialogueZ(project: ComicProject, dialogueId: string, direction: 'front' | 'back'): ComicProject {
  const dialogue = project.dialogues.find((item) => item.id === dialogueId);
  if (!dialogue) return project;
  const panelPeers = project.dialogues.filter(item => item.panelId === dialogue.panelId);
  if (panelPeers.length < 2) return project;
  const reordered = direction === 'front'
    ? [...panelPeers.filter(item => item.id !== dialogueId), dialogue]
    : [dialogue, ...panelPeers.filter(item => item.id !== dialogueId)];
  let cursor = 0;
  const dialogues = project.dialogues.map(item => (
    item.panelId === dialogue.panelId ? reordered[cursor++]! : item
  ));
  return { ...project, dialogues, updatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Consistency（Anchor 锁定，规格 §16 / §39）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 最终页资产（V4.2.11 §F 组合漫画页面）
// ---------------------------------------------------------------------------

/** 写入本地组合的整页资产（显式导出组合链路唯一入口；空数组 = 清除记录）。 */
export function applyComicFinalPages(
  project: ComicProject,
  pages: ComicFinalPageAsset[],
): ComicProject {
  return {
    ...project,
    finalPages: pages.length > 0 ? pages : undefined,
    updatedAt: new Date().toISOString(),
  };
}

export function lockAnchor(
  project: ComicProject,
  anchor: NonNullable<ComicConsistencyProfile['anchor']>,
): ComicProject {
  const previous = project.consistency;
  const consistency: ComicConsistencyProfile = {
    ...previous,
    anchor,
    characterReferences: previous?.characterReferences ?? [],
    generationParams: previous?.generationParams ?? { size: '1024x1024', quality: 'auto', format: 'png' },
  };
  return { ...project, consistency, updatedAt: new Date().toISOString() };
}

/** 项目内按 slot 解析角色快照（含未绑定返回 null）。 */
export function resolveSlotCharacter(
  project: ComicProject,
  slotId: string,
): ComicCharacter | null {
  const characterId = project.characterBindings[slotId];
  if (!characterId) return null;
  return project.characterSnapshots.find((item) => item.id === characterId) ?? null;
}

// ---------------------------------------------------------------------------
// 角色状态机（draft → confirmed → locked；locked 可解锁回 confirmed）
// ---------------------------------------------------------------------------

function withCharacterStatus(character: ComicCharacter, status: ComicCharacter['status']): ComicCharacter {
  return { ...character, status, updatedAt: new Date().toISOString() };
}

export function confirmComicCharacter(character: ComicCharacter): ComicCharacter {
  return withCharacterStatus(character, 'confirmed');
}

/** 锁定缺参考图时的统一提示（验收 §5.3 / §10.4 原文）。 */
export const COMIC_CHARACTER_LOCK_MISSING_REFERENCE = '请先生成或选择一张角色参考图';

/**
 * 锁定 = 进入 Anchor / 系列生成的一致性档案；特征此后视为冻结基线。
 * Phase 1.1 起：技能要求角色参考图时（characterRefs='required'），无参考图不得锁定——
 * 调用方传 `requireReference: true`（UI 先用 comicCharactersSummaryState 展示原因，正常流不会触发抛错）。
 */
export function lockComicCharacter(
  character: ComicCharacter,
  options: { requireReference?: boolean } = {},
): ComicCharacter {
  if (options.requireReference && !character.referenceImage) {
    throw new Error(COMIC_CHARACTER_LOCK_MISSING_REFERENCE);
  }
  return withCharacterStatus(character, 'locked');
}

/** 解锁回 confirmed（保留参考图；重生成一致性档案需重新锁 Anchor）。 */
export function unlockComicCharacter(character: ComicCharacter): ComicCharacter {
  return withCharacterStatus(character, 'confirmed');
}

/** 绑定参考图（生成回写 / 上传 / 素材库引用；新图即最新设定，清除过期标记）。 */
export function attachCharacterReference(
  character: ComicCharacter,
  reference: {
    path: string;
    assetId?: string;
    label: string;
    imageId?: string;
    taskId?: string;
    generatedAt?: string;
  },
): ComicCharacter {
  return {
    ...character,
    referenceImage: reference,
    referenceStale: undefined,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Panel Patch（Phase 1.2-G §38.2：大白话改单格，只 patch 指令涉及的那一格）
// ---------------------------------------------------------------------------

/** 分镜补丁字段白名单：LLM 只能改这些路径（不可碰 id/order/角色绑定/图片资产）。 */
export const COMIC_PANEL_PATCH_FIELDS = [
  'scene',
  'shotType',
  'camera',
  'composition',
  'characterActions',
  'characterExpressions',
  'background',
  'environmentText',
  // V4.2.12 §49/§50：这一格发生在什么时候（清晨/白天/傍晚/夜晚…）
  'time',
] as const;

export type ComicPanelPatchField = (typeof COMIC_PANEL_PATCH_FIELDS)[number];

const PANEL_TEXT_ARRAY_FIELDS = new Set<string>(['characterActions', 'characterExpressions']);

export function normalizeComicPanelPatch(value: unknown): ComicSkillPatch | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const field = normalizeText(record.field ?? record.path);
  if (!(COMIC_PANEL_PATCH_FIELDS as readonly string[]).includes(field)) return null;
  return { field: field as ComicPanelPatchField, value: record.value, reason: normalizeText(record.reason) || undefined };
}

export interface ComicPanelPatchResult {
  panel: ComicPanel;
  applied: string[];
  ignored: string[];
}

export function applyComicPanelPatches(panel: ComicPanel, patches: unknown): ComicPanelPatchResult {
  const list = Array.isArray(patches)
    ? patches.map(normalizeComicPanelPatch).filter((patch): patch is ComicSkillPatch => patch !== null)
    : [];
  const applied: string[] = [];
  const ignored: string[] = [];
  let next: ComicPanel = panel;
  for (const patch of list) {
    // environmentText 允许显式清空（「这格不要画面内文字」）；其余空值忽略
    const isClear = patch.field === 'environmentText' && (patch.value === null || patch.value === '');
    const value = PANEL_TEXT_ARRAY_FIELDS.has(patch.field)
      ? normalizeTextArray(patch.value)
      : normalizeText(patch.value);
    if (!isClear && (!value || (Array.isArray(value) && value.length === 0))) {
      ignored.push(patch.field);
      continue;
    }
    // 同值补丁是 no-op：冻结的 compiledPrompt 不因「改了个寂寞」被剥离
    const current = (next as unknown as Record<string, unknown>)[patch.field];
    const unchanged = isClear
      ? current === undefined
      : Array.isArray(value)
        ? Array.isArray(current) && current.length === value.length
          && current.every((item, index) => item === value[index])
        : current === value;
    if (unchanged) {
      ignored.push(patch.field);
      continue;
    }
    next = { ...next, [patch.field]: isClear ? undefined : value } as ComicPanel;
    applied.push(patch.field);
  }
  if (next !== panel) {
    // 内容变化后：冻结的编译 Prompt 不再代表这一格（下次生成重新编译）；
    // 已有成图保留回看但标 stale（同 Story 再生成语义，不静默复用）。
    next = {
      ...next,
      compiledPrompt: undefined,
      stale: panel.imageAsset ? true : panel.stale,
    };
  }
  return { panel: next, applied, ignored };
}

/** 替换项目内的一格分镜（按 id；不存在原样返回）。 */
export function replaceProjectPanel(project: ComicProject, panel: ComicPanel): ComicProject {
  if (!project.panels.some(item => item.id === panel.id)) return project;
  return {
    ...project,
    panels: project.panels.map(item => (item.id === panel.id ? panel : item)),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 有效分镜（非 stale）按 order 排序——「分镜顺序是排版唯一事实」的全渲染点统一入口
 * （V4.2.12 §38/§40：Text Stage 缩略图 / Composer / 任务结果回写 / 缩略 Rail 全部走这里）。
 */
export function comicPanelsByOrder(project: Pick<ComicProject, 'panels'>): ComicPanel[] {
  return project.panels
    .filter(panel => !panel.stale)
    .slice()
    .sort((a, b) => a.order - b.order);
}

/**
 * 手动调整分镜顺序（V4.2.12 §41~§44）：在有效分镜序列内与相邻一格交换 order。
 * - 只改两格的 order 值：id / 对白 panelId 绑定 / imageAsset / compiledPrompt /
 *   stale 全部不动（调整顺序 ≠ 重新生成，UI 需提示「只改排版，不会重新生成图片」）；
 * - 已是首格上移 / 末格下移 = no-op 返回原项目。
 */
export function moveProjectPanel(
  project: ComicProject,
  panelId: string,
  direction: 'up' | 'down',
): ComicProject {
  const active = comicPanelsByOrder(project);
  const index = active.findIndex(panel => panel.id === panelId);
  if (index < 0) return project;
  const neighborIndex = direction === 'up' ? index - 1 : index + 1;
  if (neighborIndex < 0 || neighborIndex >= active.length) return project;
  const target = active[index]!;
  const neighbor = active[neighborIndex]!;
  return {
    ...project,
    panels: project.panels.map(panel => {
      if (panel.id === target.id) return { ...panel, order: neighbor.order };
      if (panel.id === neighbor.id) return { ...panel, order: target.order };
      return panel;
    }),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Actor Library 闭环（Phase 1.2-E，规格 §17~§27）：保存 / 添加 / 选择 / 复用
// ---------------------------------------------------------------------------

/** 项目角色 → 演员库条目（§19 快照隔离：入库只写库，不回写项目；过期标记是项目会话语义，不入库）。 */
export function comicCharacterToLibraryEntry(character: ComicCharacter): ComicCharacter {
  return {
    ...character,
    referenceStale: undefined,
    updatedAt: new Date().toISOString(),
  };
}

/** 库条目 → 项目快照（§21：复用是深拷贝；库使用计数不随快照进项目）。 */
export function comicCharacterFromLibrary(entry: ComicCharacter): ComicCharacter {
  const snapshot = createCharacterSnapshot(entry);
  return { ...snapshot, usageCount: undefined, lastUsedAt: undefined };
}

/** 引用即计数（§18）：库侧 usageCount +1 / lastUsedAt = now（可注入，测试确定性）。 */
export function bumpComicCharacterUsage(entry: ComicCharacter, now: string = new Date().toISOString()): ComicCharacter {
  return {
    ...entry,
    usageCount: Math.min((entry.usageCount ?? 0) + 1, 99999),
    lastUsedAt: now,
    updatedAt: now,
  };
}

/** 替换项目内的角色快照（按 id；不存在则追加）。 */
export function upsertCharacterSnapshot(project: ComicProject, character: ComicCharacter): ComicProject {
  const exists = project.characterSnapshots.some((item) => item.id === character.id);
  return {
    ...project,
    characterSnapshots: exists
      ? project.characterSnapshots.map((item) => (item.id === character.id ? character : item))
      : [...project.characterSnapshots, character],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 把角色绑进槽位：快照随绑定入项目（冻结语义），已有绑定原位换演员。
 * 同一角色可绑多个槽位（快照只存一份）。
 */
export function bindSlotCharacter(
  project: ComicProject,
  slotId: string,
  character: ComicCharacter,
): ComicProject {
  const withSnapshot = upsertCharacterSnapshot(project, character);
  return {
    ...withSnapshot,
    characterBindings: { ...withSnapshot.characterBindings, [slotId]: character.id },
    updatedAt: new Date().toISOString(),
  };
}

/** 解绑槽位（快照保留：历史面板 prompt 溯源仍可能引用其外观描述）。 */
export function unbindSlot(project: ComicProject, slotId: string): ComicProject {
  const next: Record<string, string> = { ...project.characterBindings };
  delete next[slotId];
  return { ...project, characterBindings: next, updatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// 角色步骤单一事实源（§十一/§十：Rail 汇总行 / Footer 继续按钮门禁 / Debug 面板共用，
// 禁止组件自拼角色状态文字）
// ---------------------------------------------------------------------------

/**
 * 参考图任务在途事实：页面层从 comicTasks(kind='character_ref') 派生「每个角色最新一条」
 * 后传入（key = characterId）。状态语义与任务终态一致，不在角色持久状态里冗余。
 */
export interface ComicReferenceTaskState {
  taskId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
}

export type ComicSlotCharacterState =
  | 'empty' // 槽位未绑定角色
  | 'draft' // 已有 Brief，还没有参考图
  | 'ref_queued' // 参考图任务排队中（任务事实派生）
  | 'ref_running' // 参考图生成中（任务事实派生）
  | 'ref_failed' // 参考图任务失败且没有可用旧图
  | 'ref_stale' // Brief 改过，参考图过期
  | 'ready' // 参考图就绪，待确认锁定
  | 'confirmed' // 已确认未锁定（兼容旧数据）
  | 'locked'; // 已锁定（冻结基线）

export interface ComicSlotCharacterView {
  slotId: string;
  slotName: string;
  required: boolean;
  characterId?: string;
  characterName?: string;
  state: ComicSlotCharacterState;
  /** 状态标签（卡片徽标 / Rail 共用，唯一文案来源）。 */
  label: string;
  /** 必选槽位未达 locked 的原因；选配槽位恒 null（选配不阻塞）。 */
  blocker: string | null;
}

export interface ComicCharactersSummaryState {
  slots: ComicSlotCharacterView[];
  requiredTotal: number;
  requiredLocked: number;
  /** 有可用参考图（存在且未过期）的角色槽位数。 */
  referenceReady: number;
  /** 角色步骤完成 = 必选槽位全部 locked（选配不参与，验收 §10.3）。 */
  charactersDone: boolean;
  /** 每个未完成必选槽位的原因（Footer disabled 列表逐项来源）。 */
  blockers: string[];
  /** Rail 一行汇总文案。 */
  summaryLabel: string;
}

export function comicCharactersSummaryState(
  project: ComicProject,
  referenceTasks: Record<string, ComicReferenceTaskState> = {},
): ComicCharactersSummaryState {
  const refsRequired = project.skillSnapshot.referenceStrategy.characterRefs === 'required';
  const slots: ComicSlotCharacterView[] = project.skillSnapshot.characterSlots.map((slot) => {
    const view: ComicSlotCharacterView = {
      slotId: slot.slotId,
      slotName: slot.name,
      required: slot.required,
      state: 'empty',
      label: '未绑定',
      blocker: null,
    };
    const character = resolveSlotCharacter(project, slot.slotId);
    if (!character) {
      view.blocker = slot.required ? `角色「${slot.name}」未绑定` : null;
      if (!project.characterBindings[slot.slotId]) return view;
      view.label = '绑定失效';
      view.blocker = slot.required ? `角色「${slot.name}」绑定失效` : null;
      return view;
    }
    view.characterId = character.id;
    view.characterName = character.name;
    const task = referenceTasks[character.id];
    const displayName = `${slot.name}${character.name}`;
    // V4.2.10 §七：状态词汇统一（草稿/待生成参考图/参考图生成中/待确认/已锁定/
    // 需要重新生成/失败）——排队并入「参考图生成中」徽标，blocker 保留排队事实。
    if (task && task.status === 'queued') {
      view.state = 'ref_queued';
      view.label = '参考图生成中';
      view.blocker = slot.required ? `${displayName}：参考图排队中` : null;
      return view;
    }
    if (task && task.status === 'running') {
      view.state = 'ref_running';
      view.label = '参考图生成中';
      view.blocker = slot.required ? `${displayName}：参考图生成中` : null;
      return view;
    }
    if (task && task.status === 'failed' && !character.referenceImage) {
      view.state = 'ref_failed';
      view.label = '参考图生成失败';
      view.blocker = slot.required ? `${displayName}：参考图生成失败，请重试` : null;
      return view;
    }
    if (character.status === 'locked') {
      view.state = 'locked';
      view.label = '已锁定';
      if (slot.required && refsRequired && !character.referenceImage) {
        view.blocker = `${displayName}：已锁定但缺少参考图，请生成或从图库选择`;
      }
      return view;
    }
    if (character.referenceStale) {
      view.state = 'ref_stale';
      view.label = '需要重新生成';
      view.blocker = slot.required ? `${displayName}：角色设定已修改，请重新生成参考图` : null;
      return view;
    }
    if (!character.referenceImage) {
      view.state = 'draft';
      view.label = '待生成参考图';
      view.blocker = slot.required ? `${displayName}：未生成参考图` : null;
      return view;
    }
    if (character.status === 'confirmed') {
      view.state = 'confirmed';
      view.label = '待确认';
      view.blocker = slot.required ? `${displayName}：待锁定` : null;
      return view;
    }
    view.state = 'ready';
    view.label = '待确认';
    view.blocker = slot.required ? `${displayName}：待确认锁定` : null;
    return view;
  });
  const requiredSlots = slots.filter((slot) => slot.required);
  const blockers = requiredSlots
    .map((slot) => slot.blocker)
    .filter((blocker): blocker is string => blocker !== null);
  const requiredLocked = requiredSlots.filter((slot) => slot.state === 'locked' && !slot.blocker).length;
  const referenceReady = slots.filter((slot) => {
    if (!slot.characterId) return false;
    const character = project.characterSnapshots.find((item) => item.id === slot.characterId);
    return Boolean(character?.referenceImage && !character.referenceStale);
  }).length;
  const charactersDone = requiredSlots.length > 0
    ? requiredSlots.every((slot) => slot.state === 'locked' && !slot.blocker)
    : true;
  const optionalCount = slots.length - requiredSlots.length;
  const summaryLabel = blockers.length > 0
    ? `必选 ${requiredLocked}/${requiredSlots.length} 已锁定 · 待办 ${blockers.length} 项`
    : `必选 ${requiredLocked}/${requiredSlots.length} 已锁定${optionalCount > 0 ? ` · 选配 ${optionalCount} 槽` : ''}`;
  return {
    slots,
    requiredTotal: requiredSlots.length,
    requiredLocked,
    referenceReady,
    charactersDone,
    blockers,
    summaryLabel,
  };
}
