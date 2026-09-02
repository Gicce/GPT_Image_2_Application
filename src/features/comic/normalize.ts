/**
 * AI 漫画领域归一化（Phase 1）——手写 normalize（仓库无 zod，全库约定）：
 * LLM 输出 / 持久化旧形状 → 合法领域对象。enum 归一、默认值、未知字段剔除、
 * 字符串漂移清洗（string/array/object 容错），单字段异常只丢字段不毁整卡。
 */
import type { ComicFinalPageAsset,
  ComicCharacter,
  ComicCharacterOrigin,
  ComicCharacterSlot,
  ComicCharacterStatus,
  ComicConcept,
  ComicDialogue,
  ComicDialogueAlignment,
  ComicDialogueBubble,
  ComicDialogueTail,
  ComicDialogueType,
  ComicEndingType,
  ComicGenerationRules,
  ComicIntent,
  ComicLayout,
  ComicLayoutArrangement,
  ComicPanel,
  ComicPanelGenerationStatus,
  ComicPresentationSource,
  ComicProject,
  ComicProjectStage,
  ComicSkill,
  ComicSkillSource,
  ComicStory,
  ComicStoryboardBeat,
  ComicTextStyle,
  ComicUiDraft,
} from './types';
import { dedupeComicProjectCast } from './characterIdentity';

/** 领域 ID（Node 测试环境无 crypto.randomUUID 全局时回落，与 billingService 同式）。 */
export function newComicId(prefix: string): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `comic-${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// ---------------------------------------------------------------------------
// 基础清洗原语
// ---------------------------------------------------------------------------

/** String-Like 字段容错：string 直取；array「；」/「;」合并；object 只读描述键；null→默认。 */
export function normalizeText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeText(item, ''))
      .filter(Boolean)
      .join('；');
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['description', 'text', 'value', 'name', 'summary', 'content', 'label']) {
      if (typeof record[key] === 'string') return (record[key] as string).trim();
    }
    return '';
  }
  return fallback;
}

/** 字符串数组语义字段：保持数组（单字符串包装、object 采集字符串叶子、去空）。 */
export function normalizeTextArray(value: unknown): string[] {
  if (typeof value === 'string') {
    const parts = value.split(/[；;\n]/).map((part) => part.trim()).filter(Boolean);
    return parts.length ? parts : [];
  }
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed) out.push(trimmed);
    } else if (item && typeof item === 'object') {
      const leaf = normalizeText(item, '');
      if (leaf) out.push(leaf);
    }
  }
  return out;
}

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as T
    : fallback;
}

/** 可选枚举（V4.2.14 新字段：缺省 = undefined，不落具体值）。 */
function normalizeOptionalEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as T
    : undefined;
}

/** 对白文字描边归一化（V4.2.14 §29）：color 非空 + width 夹 0.02..0.3（字号比例）。 */
function normalizeDialogueStroke(value: unknown): ComicDialogue['strokeStyle'] {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const color = normalizeText(record.color);
  if (!color) return undefined;
  const width = Number(record.width);
  return {
    color,
    width: Number.isFinite(width) ? Math.min(0.3, Math.max(0.02, width)) : 0.16,
  };
}

export function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

/**
 * 归一化 0..1 浮点（对白 position 等）：只夹取值域，绝不取整——
 * normalizeNumber 会 Math.round，把 0.42 这类小数抹成 0/1（气泡重开项目后跳角）。
 */
function normalizeUnitFloat(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0, num));
}

/**
 * 对白气泡尺寸安全域（归一化，相对本格）：normalize（持久化契约）与
 * textLayer（画布 resize / 渲染 sanitize）共用同一常量，杜绝两处漂移
 * （V4.2.13 §6 Geometry Contract 单一事实）。
 */
export const COMIC_DIALOGUE_SIZE_RANGE = { min: 0.14, max: 0.92 } as const;

function normalizeTimestamp(value: unknown): string {
  return typeof value === 'string' && value ? value : new Date().toISOString();
}

// ---------------------------------------------------------------------------
// ComicSkill
// ---------------------------------------------------------------------------

const COMIC_SKILL_SOURCES: readonly ComicSkillSource[] = ['ai_draft', 'user_saved', 'preset'];
const COMIC_PRESENTATION_SOURCES: readonly ComicPresentationSource[] = ['user_fixed', 'ai_recommended'];
export const COMIC_LAYOUT_ARRANGEMENTS: readonly ComicLayoutArrangement[] = [
  'vertical_2', 'horizontal_2', 'vertical_3', 'grid_4', 'grid_9', 'multi_page', 'single', 'custom',
];
export const COMIC_PANEL_COUNT_RANGE = { min: 1, max: 12 } as const;

/**
 * 旧项目 / 缺失 arrangement 时的确定性推导（Phase 1.2 规格 §70）：
 * 只在格数形状足够确定时给标准模板（1/2/4/9），否则保守回 custom，
 * 由用户在「画面与形式」步骤显式确认展示形式。
 */
function deriveArrangementFallback(panelCount: number): ComicLayoutArrangement {
  if (panelCount === 1) return 'single';
  if (panelCount === 2) return 'vertical_2';
  if (panelCount === 4) return 'grid_4';
  if (panelCount === 9) return 'grid_9';
  return 'custom';
}

export function normalizeComicLayout(value: unknown): ComicLayout {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const panelCount = normalizeNumber(
    record.panelCount, 2, COMIC_PANEL_COUNT_RANGE.min, COMIC_PANEL_COUNT_RANGE.max,
  );
  const arrangement = typeof record.arrangement === 'string'
    && (COMIC_LAYOUT_ARRANGEMENTS as readonly string[]).includes(record.arrangement)
    ? record.arrangement as ComicLayoutArrangement
    : deriveArrangementFallback(panelCount);
  return {
    panelCount,
    arrangement,
    description: normalizeText(record.description) || undefined,
    pageCount: normalizeNumber(record.pageCount, 0, COMIC_PANEL_COUNT_RANGE.min, COMIC_PANEL_COUNT_RANGE.max) || undefined,
  };
}

function normalizeComicIntent(value: unknown): ComicIntent {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    purpose: normalizeText(record.purpose) || undefined,
    tone: normalizeText(record.tone) || undefined,
    platform: normalizeText(record.platform) || undefined,
  };
}

const COMIC_DIALOGUE_MODES: readonly NonNullable<ComicTextStyle['dialogueMode']>[] = [
  'bubble', 'subtitle', 'narration', 'none',
];

function normalizeComicTextStyle(value: unknown): ComicTextStyle {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    bubbleStyle: normalizeText(record.bubbleStyle, 'rounded'),
    fontHint: normalizeText(record.fontHint, '黑体，圆润清晰'),
    dialogueMode: normalizeEnum(record.dialogueMode, COMIC_DIALOGUE_MODES, 'bubble'),
  };
}

function normalizeComicGenerationRules(value: unknown): ComicGenerationRules {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const constraints = normalizeTextArray(record.negativeConstraints);
  const sceneRichness = record.sceneRichness === 'minimal' || record.sceneRichness === 'rich'
    ? record.sceneRichness
    : 'standard';
  return {
    // noText 是产品铁律（规格 §15），任何输入都不允许关掉
    noText: true,
    negativeConstraints: constraints.length
      ? constraints
      : ['乱码文字', '水印', '签名', '随机 Logo', '画面内对白气泡'],
    environmentTextAllowed: record.environmentTextAllowed === true,
    // V4.2.12 §63：缺省 standard（简化但明确的故事场景背景）
    sceneRichness,
  };
}

export function normalizeComicCharacterSlot(value: unknown): ComicCharacterSlot | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const slotId = normalizeText(record.slotId ?? record.id);
  const name = normalizeText(record.name);
  if (!slotId || !name) return null;
  return {
    slotId,
    name,
    characterKey: normalizeText(record.characterKey) || undefined,
    required: record.required !== false,
    displayRule: normalizeText(record.displayRule) || undefined,
    defaultCharacterId: normalizeText(record.defaultCharacterId) || undefined,
  };
}

/** LLM / 旧数据 → 合法 ComicSkill。字段级恢复：单字段异常丢字段不毁整卡。 */
export function normalizeComicSkill(value: unknown): ComicSkill {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const slots = Array.isArray(record.characterSlots)
    ? record.characterSlots
      .map(normalizeComicCharacterSlot)
      .filter((slot): slot is ComicCharacterSlot => slot !== null)
    : [];
  const reference = (record.referenceStrategy && typeof record.referenceStrategy === 'object'
    ? record.referenceStrategy : {}) as Record<string, unknown>;
  const exportDefaults = (record.exportDefaults && typeof record.exportDefaults === 'object'
    ? record.exportDefaults : {}) as Record<string, unknown>;
  return {
    id: normalizeText(record.id) || newComicId('skill'),
    name: normalizeText(record.name, '未命名漫画'),
    description: normalizeText(record.description),
    version: normalizeNumber(record.version, 1, 1, 9999),
    source: normalizeEnum(record.source, COMIC_SKILL_SOURCES, 'ai_draft'),
    createdAt: normalizeTimestamp(record.createdAt),
    updatedAt: normalizeTimestamp(record.updatedAt),
    intent: normalizeComicIntent(record.intent),
    comicForm: normalizeText(record.comicForm, '四格漫画'),
    visualStyle: normalizeText(record.visualStyle, '简笔粗线，低细节，干净留白'),
    layout: normalizeComicLayout(record.layout),
    storyPattern: normalizeText(record.storyPattern, '铺垫 → 发展 → 反转'),
    dialogueStyle: normalizeText(record.dialogueStyle, '短句对白，口语化'),
    humorStyle: normalizeText(record.humorStyle, '搞笑'),
    textStyle: normalizeComicTextStyle(record.textStyle),
    generationRules: normalizeComicGenerationRules(record.generationRules),
    characterSlots: slots,
    consistencyRules: normalizeTextArray(record.consistencyRules),
    promptTemplate: normalizeText(record.promptTemplate),
    referenceStrategy: {
      useAnchorAsStyle: reference.useAnchorAsStyle !== false,
      characterRefs: reference.characterRefs === 'optional' ? 'optional' : 'required',
      // V4.2.11 §F：高级开关默认关闭，关闭时不落键（保持既有快照形状稳定）
      ...(reference.pauseAfterFirstPanel === true ? { pauseAfterFirstPanel: true } : {}),
    },
    exportDefaults: {
      canvasRatio: normalizeEnum(exportDefaults.canvasRatio, ['1:1', '3:4', '9:16'] as const, '3:4'),
      background: normalizeText(exportDefaults.background, '#ffffff'),
    },
  };
}

/** 必填校验：名字 + 漫画形式 + 至少一个必选槽位（供 draft 完成判定）。 */
export function validateComicSkill(skill: ComicSkill): string[] {
  const errors: string[] = [];
  if (!skill.name || skill.name === '未命名漫画') errors.push('缺少漫画名称');
  if (!skill.comicForm) errors.push('缺少漫画形式');
  if (!skill.characterSlots.length) errors.push('缺少角色槽位');
  if (!skill.characterSlots.some((slot) => slot.required)) errors.push('缺少必选主角槽位');
  return errors;
}

// ---------------------------------------------------------------------------
// ComicConcept（V4.2.7 Story-first 推荐）
// ---------------------------------------------------------------------------

/**
 * 分镜节拍容错：坏项跳过（title/summary 全空），order 清洗后按升序重排连续化
 * （1..n），保证「第 i 格 ↔ 第 i 拍」的预览映射不因 LLM 序号漂移错位。
 * string 项容错（V4.2.7 实测 GLM 输出过 `["小鸭站在冰面", …]`）：
 * 字符串本身就是这一拍的 summary → 降级为 {order 自动, summary 原文}。
 */
export function normalizeStoryboardBeats(value: unknown): ComicStoryboardBeat[] {
  if (!Array.isArray(value)) return [];
  const beats: ComicStoryboardBeat[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const summary = item.trim();
      if (summary) {
        beats.push({
          order: beats.length + 1,
          title: '',
          summary,
          characters: [],
        });
      }
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const title = normalizeText(record.title);
    const summary = normalizeText(record.summary);
    if (!title && !summary) continue;
    beats.push({
      order: normalizeNumber(record.order, beats.length + 1, 1, COMIC_PANEL_COUNT_RANGE.max),
      title,
      summary,
      characters: normalizeTextArray(record.characters),
    });
  }
  return beats
    .sort((a, b) => a.order - b.order)
    .map((beat, index) => ({ ...beat, order: index + 1 }));
}

/**
 * LLM / 旧推荐响应 → 合法 ComicConcept。Story-first 字段缺失时回落：
 * storyTitle→name、oneLineStory→examplePremise（旧「示例笑点」是最接近的一句话故事），
 * storyboardBeats 缺省为空数组（布局预览退化为纯格序号）。旧响应（6 字段形状）
 * 必须继续归一化成功——只丢故事增强，不毁整卡。
 */
export function normalizeComicConcept(value: unknown): ComicConcept | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const name = normalizeText(record.name);
  const comicForm = normalizeText(record.comicForm);
  if (!name || !comicForm) return null;
  const layoutRaw = (record.layout && typeof record.layout === 'object' ? record.layout : {}) as Record<string, unknown>;
  // 概念缺省格数取 4（四格是最常见形式；normalizeComicLayout 自身缺省 2 面向其他调用方）
  const layout = normalizeComicLayout({ ...layoutRaw, panelCount: layoutRaw.panelCount ?? 4 });
  const characters: Array<{ name: string; role: string; displayRule?: string; characterKey?: string }> = [];
  if (Array.isArray(record.characters)) {
    for (const item of record.characters) {
      // string[] 容错（V4.2.7 实测 GLM 输出过 `["小鸭","小熊"]`）：字符串即角色名
      if (typeof item === 'string') {
        const name = item.trim();
        if (name) characters.push({ name, role: '辅助角色' });
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const character = item as Record<string, unknown>;
      const name = normalizeText(character.name);
      if (!name) continue;
      characters.push({
        name,
        role: normalizeText(character.role) || '辅助角色',
        displayRule: normalizeText(character.displayRule) || undefined,
        characterKey: normalizeText(character.characterKey) || undefined,
      });
    }
  }
  const examplePremise = normalizeText(record.examplePremise);
  return {
    id: normalizeText(record.id) || newComicId('concept'),
    name,
    storyTitle: normalizeText(record.storyTitle) || name,
    oneLineStory: normalizeText(record.oneLineStory) || examplePremise,
    fullStory: normalizeText(record.fullStory),
    punchline: normalizeText(record.punchline),
    reason: normalizeText(record.reason),
    comicForm,
    visualStyle: normalizeText(record.visualStyle) || '简笔粗线，低细节，干净留白',
    storyPattern: normalizeText(record.storyPattern) || '铺垫 → 发展 → 反转',
    dialogueStyle: normalizeText(record.dialogueStyle),
    layout,
    characters,
    storyboardBeats: normalizeStoryboardBeats(record.storyboardBeats),
    tone: normalizeText(record.tone),
    examplePremise: examplePremise || undefined,
  };
}

// ---------------------------------------------------------------------------
// ComicCharacter
// ---------------------------------------------------------------------------

const COMIC_CHARACTER_ORIGINS: readonly ComicCharacterOrigin[] = [
  'ai', 'upload', 'gallery', 'library', 'temporary',
];
const COMIC_CHARACTER_STATUSES: readonly ComicCharacterStatus[] = [
  'draft', 'confirmed', 'locked',
];

export function normalizeComicCharacter(value: unknown): ComicCharacter | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const name = normalizeText(record.name);
  if (!name) return null;
  const reference = (record.referenceImage && typeof record.referenceImage === 'object'
    ? record.referenceImage : null) as Record<string, unknown> | null;
  const referencePath = reference ? normalizeText(reference.path) : '';
  return {
    id: normalizeText(record.id) || newComicId('char'),
    name,
    description: normalizeText(record.description),
    role: normalizeText(record.role, '辅助角色'),
    source: normalizeEnum(record.source, COMIC_CHARACTER_ORIGINS, 'temporary'),
    referenceImage: reference && referencePath
      ? {
        path: referencePath,
        assetId: normalizeText(reference.assetId) || undefined,
        label: normalizeText(reference.label, name),
        imageId: normalizeText(reference.imageId) || undefined,
        taskId: normalizeText(reference.taskId) || undefined,
        generatedAt: normalizeText(reference.generatedAt) || undefined,
      }
      : undefined,
    appearance: normalizeText(record.appearance),
    immutableTraits: normalizeTextArray(record.immutableTraits),
    mutableTraits: normalizeTextArray(record.mutableTraits),
    defaultClothing: normalizeText(record.defaultClothing) || undefined,
    colorPalette: normalizeTextArray(record.colorPalette),
    negativeConstraints: normalizeTextArray(record.negativeConstraints),
    status: normalizeEnum(record.status, COMIC_CHARACTER_STATUSES, 'draft'),
    referenceStale: record.referenceStale === true ? true : undefined,
    usageCount: Number.isFinite(record.usageCount) && Number(record.usageCount) > 0
      ? Math.min(Math.floor(Number(record.usageCount)), 99999)
      : undefined,
    lastUsedAt: normalizeText(record.lastUsedAt) || undefined,
    createdAt: normalizeTimestamp(record.createdAt),
    updatedAt: normalizeTimestamp(record.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Story / Panel / Dialogue
// ---------------------------------------------------------------------------

const COMIC_ENDING_TYPES: readonly ComicEndingType[] = ['twist', 'punchline', 'warm', 'flat', 'custom'];

export function normalizeComicStory(value: unknown): ComicStory | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const title = normalizeText(record.title);
  const beats = normalizeTextArray(record.beats);
  if (!title && !beats.length) return null;
  return {
    title: title || '本期漫画',
    topic: normalizeText(record.topic),
    summary: normalizeText(record.summary),
    characterIds: normalizeTextArray(record.characterIds),
    beats,
    endingType: normalizeEnum(record.endingType, COMIC_ENDING_TYPES, 'twist'),
    panelCount: normalizeNumber(
      record.panelCount, 2, COMIC_PANEL_COUNT_RANGE.min, COMIC_PANEL_COUNT_RANGE.max,
    ),
  };
}

const COMIC_PANEL_STATUSES: readonly ComicPanelGenerationStatus[] = [
  'pending', 'queued', 'running', 'completed', 'failed',
];

export function normalizeComicPanel(value: unknown): ComicPanel | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const scene = normalizeText(record.scene);
  if (!scene) return null;
  const imageAsset = (record.imageAsset && typeof record.imageAsset === 'object'
    ? record.imageAsset : null) as Record<string, unknown> | null;
  const imagePath = imageAsset ? normalizeText(imageAsset.path) : '';
  return {
    id: normalizeText(record.id) || newComicId('panel'),
    order: normalizeNumber(record.order, 0, 0, COMIC_PANEL_COUNT_RANGE.max),
    scene,
    characterIds: normalizeTextArray(record.characterIds),
    shotType: normalizeText(record.shotType, '中景'),
    camera: normalizeText(record.camera, '平视'),
    composition: normalizeText(record.composition, '居中构图'),
    characterActions: normalizeTextArray(record.characterActions),
    characterExpressions: normalizeTextArray(record.characterExpressions),
    props: normalizeTextArray(record.props),
    background: normalizeText(record.background),
    environmentText: normalizeText(record.environmentText) || undefined,
    time: normalizeText(record.time) || undefined,
    generationStatus: normalizeEnum(record.generationStatus, COMIC_PANEL_STATUSES, 'pending'),
    imageAsset: imageAsset && imagePath
      ? {
        path: imagePath,
        imageId: normalizeText(imageAsset.imageId),
        taskId: normalizeText(imageAsset.taskId),
      }
      : undefined,
    compiledPrompt: normalizeText(record.compiledPrompt) || undefined,
    stale: record.stale === true,
    regeneratedCount: normalizeNumber(record.regeneratedCount, 0, 0, 99) || undefined,
    lastError: normalizeText(record.lastError) || undefined,
  };
}

const COMIC_DIALOGUE_TYPES: readonly ComicDialogueType[] = [
  'speech', 'thought', 'caption', 'title', 'subtitle',
];
const COMIC_DIALOGUE_ALIGNMENTS: readonly ComicDialogueAlignment[] = ['left', 'center', 'right'];
const COMIC_DIALOGUE_BUBBLES: readonly ComicDialogueBubble[] = [
  // V4.2.11~13 七类（none = legacy，渲染等价 stroke-black）
  'rounded', 'soft', 'cloud', 'box', 'spiky', 'whisper', 'none',
  // Bubble Library V2 新增九类（7 旧 + 9 新 = 十六类，docs/ai-comic/28 §6）
  'cloud-talk', 'rect', 'sharp', 'box-light', 'title-bar', 'subtitle-bar',
  'hand', 'stroke-black', 'stroke-white', 'plain',
];
const COMIC_DIALOGUE_SHADOWS: readonly NonNullable<ComicDialogue['shadow']>[] = ['none', 'soft'];
const COMIC_PLACEMENT_SOURCES: readonly NonNullable<ComicDialogue['placementSource']>[] = [
  'story_seed', 'manual', 'planner', 'vision',
];
const COMIC_DIALOGUE_TAILS: readonly ComicDialogueTail[] = [
  'auto', 'bottom-left', 'bottom-right', 'top-left', 'top-right',
];
const COMIC_DIALOGUE_WEIGHTS: readonly (400 | 500 | 600 | 700)[] = [400, 500, 600, 700];

/**
 * 旧对白几何迁移（V4.2.13 §7-§10）——x/y/width/height 恒 0..1 归一化相对本格：
 *  - 位置 0..1 直留；> 1 = 百分比刻度证据（归一化域不可能超 1）→ /100 再夹 0..1；
 *  - 宽高 0 < v ≤ 1 合法，钳入安全域；任一 > 1（px / 异刻度）且无换算依据
 *    （旧 schema 未存 panel 像素尺寸）→ 整体丢弃 size 回内容自适应，
 *    绝不钳成 1.0 变成覆盖整格的气泡；
 *  - NaN / Infinity / 非数值 → 位置回 0.5，size 回 undefined（渲染层另有 sanitize 兜底）。
 */
export function normalizeLegacyComicDialogueGeometry(
  position: unknown,
  size: unknown,
): { position: { x: number; y: number }; size?: { width: number; height: number } } {
  const pos = (position && typeof position === 'object' ? position : {}) as Record<string, unknown>;
  const migrateAxis = (value: unknown, fallback: number): number => {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return fallback;
    return normalizeUnitFloat(num > 1 ? num / 100 : num, fallback);
  };
  const sizeRecord = (size && typeof size === 'object' ? size : null) as Record<string, unknown> | null;
  let normalizedSize: ComicDialogue['size'] | undefined;
  if (sizeRecord) {
    const width = Number(sizeRecord.width);
    const height = Number(sizeRecord.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width <= 1 && height <= 1) {
      normalizedSize = {
        width: Math.min(COMIC_DIALOGUE_SIZE_RANGE.max, Math.max(COMIC_DIALOGUE_SIZE_RANGE.min, width)),
        height: Math.min(COMIC_DIALOGUE_SIZE_RANGE.max, Math.max(COMIC_DIALOGUE_SIZE_RANGE.min, height)),
      };
    }
  }
  return {
    position: { x: migrateAxis(pos.x, 0.5), y: migrateAxis(pos.y, 0.5) },
    size: normalizedSize,
  };
}

function normalizeDialogueWeight(value: unknown): 400 | 500 | 600 | 700 {
  const num = typeof value === 'number' ? value : Number(value);
  return COMIC_DIALOGUE_WEIGHTS.includes(num as 400 | 500 | 600 | 700)
    ? num as 400 | 500 | 600 | 700
    : 500;
}

export function normalizeComicDialogue(value: unknown): ComicDialogue | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const text = normalizeText(record.text);
  const panelId = normalizeText(record.panelId);
  if (!text || !panelId) return null;
  const position = (record.position && typeof record.position === 'object'
    ? record.position : {}) as Record<string, unknown>;
  const fontStyle = (record.fontStyle && typeof record.fontStyle === 'object'
    ? record.fontStyle : {}) as Record<string, unknown>;
  const geometry = normalizeLegacyComicDialogueGeometry(position, record.size);
  return {
    id: normalizeText(record.id) || newComicId('dlg'),
    panelId,
    speakerId: normalizeText(record.speakerId, 'narrator') || 'narrator',
    type: normalizeEnum(record.type, COMIC_DIALOGUE_TYPES, 'speech'),
    text,
    position: geometry.position,
    alignment: normalizeEnum(record.alignment, COMIC_DIALOGUE_ALIGNMENTS, 'center'),
    fontStyle: {
      size: normalizeNumber(fontStyle.size, 16, 10, 72),
      weight: normalizeDialogueWeight(fontStyle.weight),
      color: normalizeText(fontStyle.color) || undefined,
      family: normalizeText(fontStyle.family) || undefined,
    },
    bubbleStyle: normalizeEnum(record.bubbleStyle, COMIC_DIALOGUE_BUBBLES, 'rounded'),
    size: geometry.size,
    tail: normalizeEnum(record.tail, COMIC_DIALOGUE_TAILS, 'auto'),
    // V4.2.14 新字段全部可选、缺省安全（旧项目零迁移）
    strokeStyle: normalizeDialogueStroke(record.strokeStyle),
    shadow: normalizeOptionalEnum(record.shadow, COMIC_DIALOGUE_SHADOWS),
    placementSource: normalizeOptionalEnum(record.placementSource, COMIC_PLACEMENT_SOURCES),
  };
}

// ---------------------------------------------------------------------------
// Consistency（Anchor 锁定档案）
// ---------------------------------------------------------------------------

export function normalizeComicConsistency(value: unknown): ComicProject['consistency'] {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const anchor = (record.anchor && typeof record.anchor === 'object'
    ? record.anchor : null) as Record<string, unknown> | null;
  const anchorPath = anchor ? normalizeText(anchor.path) : '';
  const references = Array.isArray(record.characterReferences)
    ? record.characterReferences
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const ref = item as Record<string, unknown>;
        const path = normalizeText(ref.path);
        return path
          ? {
            characterId: normalizeText(ref.characterId),
            path,
            label: normalizeText(ref.label, path),
          }
          : null;
      })
      .filter((item): item is NonNullable<ComicProject['consistency']>['characterReferences'][number] => item !== null)
    : [];
  const params = (record.generationParams && typeof record.generationParams === 'object'
    ? record.generationParams : {}) as Record<string, unknown>;
  return {
    anchor: anchor && anchorPath
      ? {
        panelId: normalizeText(anchor.panelId),
        path: anchorPath,
        imageId: normalizeText(anchor.imageId),
        taskId: normalizeText(anchor.taskId),
        lockedAt: normalizeTimestamp(anchor.lockedAt),
      }
      : undefined,
    characterReferences: references,
    colorRules: normalizeText(record.colorRules) || undefined,
    lineRules: normalizeText(record.lineRules) || undefined,
    lightingRules: normalizeText(record.lightingRules) || undefined,
    generationParams: {
      size: normalizeText(params.size, '1024x1024'),
      quality: normalizeText(params.quality, 'auto'),
      format: normalizeText(params.format, 'png'),
    },
  };
}

// ---------------------------------------------------------------------------
// ComicUiDraft（Phase 1.2 §30：切步骤 / 刷新不丢输入）
// ---------------------------------------------------------------------------

const COMIC_STORY_DRAFT_PHASES = ['hero', 'requirement', 'review'] as const;

/**
 * uiDraft 归一化：刷新 / 跨会话恢复前的字段级清洗。
 * 各分支复用 story / panel / dialogue 归一化（坏一半只丢那一半）；
 * 全空 → undefined（不给老项目写空对象）。
 */
export function normalizeComicUiDraft(value: unknown): ComicUiDraft | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const draft: ComicUiDraft = {};

  if (record.story && typeof record.story === 'object') {
    const story = record.story as Record<string, unknown>;
    const phase = COMIC_STORY_DRAFT_PHASES.find((item) => item === story.phase);
    const storyDraft = normalizeComicStory(story.storyDraft) ?? undefined;
    const requirement = normalizeText(story.requirement);
    if (requirement || storyDraft || phase) {
      draft.story = {
        requirement: requirement || undefined,
        storyDraft,
        // review 阶段只在有审定草稿时才有意义
        phase: storyDraft ? phase : undefined,
      };
    }
  }

  if (record.storyboard && typeof record.storyboard === 'object') {
    const storyboard = record.storyboard as Record<string, unknown>;
    const panels = Array.isArray(storyboard.panels)
      ? storyboard.panels
        .map(normalizeComicPanel)
        .filter((panel): panel is ComicPanel => panel !== null)
      : [];
    const dialogues = Array.isArray(storyboard.dialogues)
      ? storyboard.dialogues
        .map(normalizeComicDialogue)
        .filter((dialogue): dialogue is ComicDialogue => dialogue !== null)
      : [];
    const repairs = normalizeTextArray(storyboard.repairs);
    const storyDraft = normalizeComicStory(storyboard.storyDraft) ?? undefined;
    // §38.2 单格微调输入：panelId → 文本（已应用分镜也可单独微调，无草稿也保留）
    const patchRaw = (storyboard.patchTexts && typeof storyboard.patchTexts === 'object'
      ? storyboard.patchTexts : {}) as Record<string, unknown>;
    const patchTexts: Record<string, string> = {};
    for (const [panelId, text] of Object.entries(patchRaw)) {
      const normalized = normalizeText(text);
      if (normalized) patchTexts[panelId] = normalized;
    }
    if (storyDraft || panels.length || dialogues.length || repairs.length || Object.keys(patchTexts).length) {
      draft.storyboard = {
        storyDraft,
        panels: panels.length ? panels : undefined,
        dialogues: dialogues.length ? dialogues : undefined,
        repairs: repairs.length ? repairs : undefined,
        patchTexts: Object.keys(patchTexts).length ? patchTexts : undefined,
      };
    }
  }

  if (record.character && typeof record.character === 'object') {
    const character = record.character as Record<string, unknown>;
    const patchRaw = (character.patchTexts && typeof character.patchTexts === 'object'
      ? character.patchTexts : {}) as Record<string, unknown>;
    const patchTexts: Record<string, string> = {};
    for (const [slotId, text] of Object.entries(patchRaw)) {
      const normalized = normalizeText(text);
      if (normalized) patchTexts[slotId] = normalized;
    }
    if (Object.keys(patchTexts).length) draft.character = { patchTexts };
  }

  if (record.skill && typeof record.skill === 'object') {
    const skill = record.skill as Record<string, unknown>;
    const instruction = normalizeText(skill.instruction);
    if (instruction) draft.skill = { instruction };
  }

  return Object.keys(draft).length ? draft : undefined;
}

// ---------------------------------------------------------------------------
// ComicProject
// ---------------------------------------------------------------------------

const COMIC_PROJECT_STAGES: readonly ComicProjectStage[] = [
  'draft', 'skill_draft', 'character_confirmation', 'story_ready',
  'generating_anchor', 'anchor_review', 'generating_panels', 'editing', 'completed', 'failed',
];

/** §F 整页资产归一：字段缺失 / 非法的条目剔除（不毁整卡）。 */
function normalizeComicFinalPages(value: unknown): ComicFinalPageAsset[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const pages = value
    .map((item): ComicFinalPageAsset | null => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const page = typeof record.page === 'number' && Number.isFinite(record.page) ? record.page : null;
      const path = normalizeText(record.path);
      const imageId = normalizeText(record.imageId);
      const panelIds = Array.isArray(record.panelIds)
        ? record.panelIds.map(id => normalizeText(id)).filter(Boolean)
        : [];
      if (page === null || !path || !imageId || panelIds.length === 0) return null;
      return {
        page,
        path,
        imageId,
        panelIds,
        composedAt: normalizeTimestamp(record.composedAt),
      };
    })
    .filter((item): item is ComicFinalPageAsset => item !== null);
  return pages.length > 0 ? pages : undefined;
}

export function normalizeComicProject(value: unknown): ComicProject | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  // 项目必须带 Skill 快照（缺失 = 不是漫画项目文档，整卡不可恢复）
  if (!record.skillSnapshot || typeof record.skillSnapshot !== 'object') return null;
  const skillSnapshot = normalizeComicSkill(record.skillSnapshot);
  const characters = Array.isArray(record.characterSnapshots)
    ? record.characterSnapshots
      .map(normalizeComicCharacter)
      .filter((char): char is ComicCharacter => char !== null)
    : [];
  const panels = Array.isArray(record.panels)
    ? record.panels
      .map(normalizeComicPanel)
      .filter((panel): panel is ComicPanel => panel !== null)
    : [];
  const dialogues = Array.isArray(record.dialogues)
    ? record.dialogues
      .map(normalizeComicDialogue)
      .filter((dialogue): dialogue is ComicDialogue => dialogue !== null)
      : [];
  const bindingsRaw = (record.characterBindings && typeof record.characterBindings === 'object'
    ? record.characterBindings : {}) as Record<string, unknown>;
  const characterBindings: Record<string, string> = {};
  for (const [slotId, charId] of Object.entries(bindingsRaw)) {
    const normalized = normalizeText(charId);
    if (normalized) characterBindings[slotId] = normalized;
  }
  return dedupeComicProjectCast({
    id: normalizeText(record.id) || newComicId('project'),
    name: normalizeText(record.name, '未命名漫画项目'),
    stage: normalizeEnum(record.stage, COMIC_PROJECT_STAGES, 'skill_draft'),
    skillSnapshot,
    characterSnapshots: characters,
    characterBindings,
    story: normalizeComicStory(record.story) ?? undefined,
    panels,
    dialogues,
    finalPages: normalizeComicFinalPages(record.finalPages),
    consistency: normalizeComicConsistency(record.consistency),
    uiDraft: normalizeComicUiDraft(record.uiDraft),
    skillId: normalizeText(record.skillId) || undefined,
    presentationSource: typeof record.presentationSource === 'string'
      && (COMIC_PRESENTATION_SOURCES as readonly string[]).includes(record.presentationSource)
      ? record.presentationSource as ComicPresentationSource
      : undefined,
    createdAt: normalizeTimestamp(record.createdAt),
    updatedAt: normalizeTimestamp(record.updatedAt),
  });
}
