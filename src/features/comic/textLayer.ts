/**
 * 漫画文字层（Phase 10/11，纯函数）——对白与图片层彻底分离的铁律落点：
 *  - 对白 CRUD 走 domain 的 upsertDialogue / removeDialogue（结构上不可能触发生图）；
 *  - 本模块只做 UI 侧派生：说话人候选、新建对白默认值（来自 Skill textStyle 快照）、
 *    归一化坐标 → overlay 样式；
 *  - 坐标铁律：position 恒 0..1，任何像素换算只发生在渲染边界（DOM / canvas）。
 */

import type { ComicDialogue, ComicDialogueMode, ComicDialogueTail, ComicPanel, ComicProject } from './types';
import { COMIC_DIALOGUE_SIZE_RANGE, newComicId } from './normalize';
import { COMIC_BUBBLE_STYLES, comicBubbleStyleMeta } from './bubbleShape';

export const DIALOGUE_TYPE_LABELS: Record<ComicDialogue['type'], string> = {
  speech: '对白',
  thought: '内心',
  caption: '旁白',
  title: '标题',
  subtitle: '小字',
};

/** 气泡样式用户文案（单一事实源 = bubbleShape.COMIC_BUBBLE_STYLES 十六类注册表）。 */
export const DIALOGUE_BUBBLE_LABELS: Record<ComicDialogue['bubbleStyle'], string> = {
  ...Object.fromEntries(COMIC_BUBBLE_STYLES.map(meta => [meta.id, meta.label])),
  // legacy 'none' 别名回落 stroke-black 的标签（类型要求全覆盖，旧数据不落空）
  none: comicBubbleStyleMeta('none').label,
} as Record<ComicDialogue['bubbleStyle'], string>;

export const DIALOGUE_TAIL_LABELS: Record<ComicDialogueTail, string> = {
  auto: '自动',
  'bottom-left': '尾巴朝左下',
  'bottom-right': '尾巴朝右下',
  'top-left': '尾巴朝左上',
  'top-right': '尾巴朝右上',
};

export interface DialogueSpeakerOption {
  id: string;
  label: string;
}

/** 说话人候选 = 本格出场角色 + 旁白（narrator 恒在最后）。 */
export function dialogueSpeakerOptions(project: ComicProject, panel: ComicPanel): DialogueSpeakerOption[] {
  const options: DialogueSpeakerOption[] = [];
  for (const characterId of panel.characterIds) {
    const character = project.characterSnapshots.find(item => item.id === characterId);
    if (character) options.push({ id: character.id, label: character.name });
  }
  options.push({ id: 'narrator', label: '旁白' });
  return options;
}

/**
 * 项目级对白默认气泡（V4.2.12 §69/§71）：Skill textStyle.dialogueMode 是每条新对白的
 * 默认呈现方式（可逐条覆盖）。bubble = 按画风提示选形状；narration = 旁白框；
 * subtitle = 底部字幕条；none = 无气泡文字。
 */
export function defaultBubbleForMode(project: ComicProject): ComicDialogue['bubbleStyle'] {
  const mode: ComicDialogueMode = project.skillSnapshot.textStyle.dialogueMode ?? 'bubble';
  if (mode === 'narration') return 'box-light';
  if (mode === 'subtitle') return 'subtitle-bar';
  if (mode === 'none') return 'plain';
  const hint = project.skillSnapshot.textStyle.bubbleStyle;
  if (hint.includes('尖') || hint.includes('爆')) return 'spiky';
  if (hint.includes('云') || hint.includes('思')) return 'cloud';
  if (hint.includes('方') || hint.includes('框')) return 'rect';
  if (hint.includes('软') || hint.includes('圆')) return 'soft';
  return 'rounded';
}

/**
 * 新建对白默认值（V4.2.12）：气泡跟随项目 dialogueMode；坐标落安全泳道
 * （顶部一排，§71），画布上可再拖；尾巴默认 auto；尺寸缺省 = 内容自适应。
 */
export function newDialogueDraft(
  project: ComicProject,
  panelId: string,
  seedIndex: number,
): ComicDialogue {
  const bubble = defaultBubbleForMode(project);
  const mode: ComicDialogueMode = project.skillSnapshot.textStyle.dialogueMode ?? 'bubble';
  const lanes = [0.32, 0.5, 0.68];
  const isSubtitle = mode === 'subtitle';
  return {
    id: newComicId('dlg'),
    panelId,
    speakerId: 'narrator',
    type: mode === 'narration' ? 'caption' : isSubtitle ? 'subtitle' : 'speech',
    text: '',
    position: {
      x: lanes[seedIndex % lanes.length]!,
      y: isSubtitle ? 0.88 : 0.22 + Math.floor(seedIndex / lanes.length) * 0.5,
    },
    alignment: 'center',
    fontStyle: { size: 16, weight: 500, color: undefined },
    bubbleStyle: bubble,
    tail: 'auto',
    placementSource: 'manual',
  };
}

/** 气泡中心点的安全范围（边界内收，避免气泡贴死画布边或跨出本格，§14）。 */
const POSITION_MIN = 0.06;
const POSITION_MAX = 0.94;

/** 画布放置 / 拖动落点：钳制到安全范围（写库前统一走这里）。 */
export function clampDialoguePosition(position: { x: number; y: number }): { x: number; y: number } {
  const clamp = (value: number) => Math.min(POSITION_MAX, Math.max(POSITION_MIN, value));
  return { x: clamp(position.x), y: clamp(position.y) };
}

/** 气泡尺寸的安全范围（归一化，相对本格；单一事实 = normalize.COMIC_DIALOGUE_SIZE_RANGE）。 */
const SIZE_MIN = COMIC_DIALOGUE_SIZE_RANGE.min;
const SIZE_MAX = COMIC_DIALOGUE_SIZE_RANGE.max;

/** Resize handles 落点：钳制宽高到安全范围。 */
export function clampDialogueSize(size: { width: number; height: number }): { width: number; height: number } {
  const clamp = (value: number) => Math.min(SIZE_MAX, Math.max(SIZE_MIN, value));
  return { width: clamp(size.width), height: clamp(size.height) };
}

/** 渲染边界 sanitize 结果：只含定位所需的最小几何面。 */
export interface SanitizedBubbleGeometry {
  position: { x: number; y: number };
  size?: { width: number; height: number };
}

/**
 * 气泡渲染前最后一道安全保护（V4.2.13 §12/§13）：坏数据（NaN / Infinity /
 * 超界宽高）也不允许让一个 Bubble 覆盖整格或整页——finite 校验 + 0..1 夹取 +
 * 宽高夹入尺寸安全域；非 finite 的 size 整体丢弃（回内容自适应）。
 * 纯 runtime 防线：只影响本次渲染，绝不写回 DB（§14）。
 */
export function sanitizeBubbleGeometry(
  dialogue: Pick<ComicDialogue, 'position' | 'size'>,
): SanitizedBubbleGeometry {
  const clampUnit = (value: number, fallback: number) =>
    Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
  const position = {
    x: clampUnit(Number(dialogue.position?.x), 0.5),
    y: clampUnit(Number(dialogue.position?.y), 0.5),
  };
  const size = dialogue.size;
  if (!size) return { position };
  const width = Number(size.width);
  const height = Number(size.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return { position };
  const clampSize = (value: number) => Math.min(SIZE_MAX, Math.max(SIZE_MIN, value));
  return { position, size: { width: clampSize(width), height: clampSize(height) } };
}

/**
 * 画布 Pointer 坐标 → 归一化坐标（放置 / 拖动的渲染边界换算，纯函数可测；
 * 测试环境（jsdom）getBoundingClientRect 为 0 → 回落画布中点，不产生 NaN）。
 */
export function pointerToNormalized(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0.5, y: 0.5 };
  return {
    x: (clientX - rect.left) / rect.width,
    y: (clientY - rect.top) / rect.height,
  };
}

/**
 * 归一化坐标 → overlay 定位样式：V4.2.12 起由 ComicBubbleBox 的 floatFrameStyle
 * 内联承担（中心锚点，与导出同构），textLayer 不再保留平行实现（§22 单源原则）。
 */

/** 对白文本是否为空（空对白不渲染、不导出）。 */
export function dialogueHasText(dialogue: ComicDialogue): boolean {
  return dialogue.text.trim().length > 0;
}

/** 某格的可见对白（有文本才算数）。 */
export function visibleDialoguesOfPanel(project: ComicProject, panelId: string): ComicDialogue[] {
  return project.dialogues.filter(dialogue => dialogue.panelId === panelId && dialogueHasText(dialogue));
}
