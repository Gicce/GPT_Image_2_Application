/**
 * 漫画文字共享布局引擎（V4.2.14 唯一 wrap / 盒尺寸 / 字号 / 基线事实源，
 * docs/ai-comic/28 TEXT-RENDER-CONTRACT）：
 *  - Editor Preview（ComicBubbleBox）与 Final Composer / Export（comicExport）
 *    共同调用 calculateDialogueLayout()，各自只做绘制 backend（DOM 逐行 / canvas fillText）；
 *  - 字号契约：fontPx = fontStyle.size × panelWidth / FONT_SCALE_BASE（相对面板宽，
 *    双端同式 → 视觉一致；四格 1:1 槽宽 504 下 size=16 ≈ 31.5px，延续旧观感）；
 *  - 换行 / 自适应盒宽 / inset / 行数上限 / 基线 全部在本引擎决定，双端禁止自算
 *    （DOM 逐行渲染、white-space:pre，禁止浏览器自动换行）；
 *  - 纯函数 + measure 注入：jsdom / vitest 用确定性 measure，真实端用 canvas measureText。
 */

import type { ComicDialogue } from './types';
import {
  bubbleTextInset,
  comicBubbleStyleMeta,
  dialogueEffectiveWeight,
  dialogueFontStack,
  isFramelessStyle,
  resolveBubbleTail,
  type ResolvedTail,
} from './bubbleShape';
import { sanitizeBubbleGeometry } from './textLayer';

/** 字号换算基准（docs/ai-comic/28 §2）：fontPx = size × panelWidth / 256。 */
export const FONT_SCALE_BASE = 256;
/** 行高因子（双端同值）。 */
export const DIALOGUE_LINE_HEIGHT = 1.35;
/** 行数上限（双端同值；超出 = overflow，Inspector 提示"文字过多"）。 */
export const MAX_DIALOGUE_LINES = 6;
/** 自适应模式最大 wrap 宽（panel 比例）。 */
const AUTO_WRAP_RATIO = 0.72;
/** 盒宽/高占本格的上限。 */
const BOX_MAX_W = 0.94;
const BOX_MAX_H = 0.96;
/** 盒不越出本格的安全边距（气泡组 / 无框组，docs/ai-comic/28 §4 clamp）。 */
const PANEL_MARGIN_BUBBLE = 0.03;
const PANEL_MARGIN_FRAMELESS = 0.015;

export interface DialoguePanelRect {
  width: number;
  height: number;
}

export interface DialogueMeasureFont {
  px: number;
  weight: number;
  family?: string;
}

/** 文本测量回调（真实端 = canvas measureText；测试端 = 确定性函数）。 */
export type MeasureText = (text: string, font: DialogueMeasureFont) => number;

/**
 * 字体基线度量（比例，× fontPx）：ascent/descent 决定基线在行盒内的位置。
 * DOM 侧由浏览器行盒原生使用；canvas 侧（fillText alphabetic 基线）必须读取
 * 同一度量（fontBoundingBoxAscent/Descent）才能与编辑器逐像素一致（B1 修复）。
 */
export interface DialogueFontMetrics {
  ascent: number;
  descent: number;
}

/** 度量回调（真实端 = canvas measureText fontBoundingBox；测试端 = 确定性常量）。 */
export type MeasureFontMetrics = (font: DialogueMeasureFont) => DialogueFontMetrics;

/** 近似缺省（jsdom / 度量不可用时的确定性回退）：ascent≈0.8 / descent≈0.2。 */
export const DEFAULT_FONT_METRICS: DialogueFontMetrics = { ascent: 0.8, descent: 0.2 };

export interface DialogueLayout {
  /** wrap 结果（≤ MAX_DIALOGUE_LINES；overflow=true 表示有内容被截断） */
  lines: string[];
  fontPx: number;
  lineHeight: number;
  /** 气泡/文字盒（panel 像素坐标系；已 clamp 在本格安全边距内，中心锚点语义） */
  box: { x: number; y: number; width: number; height: number };
  /** 文字安全区（box 内 inset 之后；对齐/换行的基准盒） */
  textRect: { x: number; y: number; width: number; height: number };
  tail: ResolvedTail | null;
  overflow: boolean;
  /** 固定尺寸（Resize handles 写入的 size）或内容自适应 */
  fixed: boolean;
  /** 基线度量（canvas fillText 用；DOM 行盒原生同源） */
  metrics: DialogueFontMetrics;
}

/**
 * 逐字符累加换行（与旧 wrapText 同族；本引擎为唯一实现）。
 * 手工换行（textarea 敲入的 \n）= 硬换行：先按 \n 分段再逐段 wrap，
 * DOM（white-space:pre）与 canvas（fillText）同一语义（B6 修复）。
 */
export function wrapDialogueText(
  text: string,
  maxWidth: number,
  measure: MeasureText,
  font: DialogueMeasureFont,
): { lines: string[]; truncated: boolean } {
  if (text.length === 0) return { lines: [], truncated: false };
  const lines: string[] = [];
  for (const segment of text.split('\n')) {
    let current = '';
    for (const char of segment) {
      const candidate = current + char;
      if (measure(candidate, font) > maxWidth && current) {
        lines.push(current);
        current = char;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  if (lines.length <= MAX_DIALOGUE_LINES) return { lines, truncated: false };
  return { lines: lines.slice(0, MAX_DIALOGUE_LINES), truncated: true };
}

/**
 * 计算一条对白的完整布局（Editor / Composer / Export 三端唯一入口）。
 * panel = Panel Content Rect 像素（编辑器 figure 内容盒 / 导出 slot）。
 */
export function calculateDialogueLayout(
  dialogue: ComicDialogue,
  panel: DialoguePanelRect,
  measure: MeasureText,
  measureMetrics: MeasureFontMetrics = () => DEFAULT_FONT_METRICS,
): DialogueLayout {
  const safe = sanitizeBubbleGeometry(dialogue);
  const styleId = comicBubbleStyleMeta(dialogue.bubbleStyle).id;
  const frameless = isFramelessStyle(styleId);
  const inset = bubbleTextInset(styleId);
  // 测量字重 = 绘制字重（dialogueEffectiveWeight 唯一算法）：wrap 宽度与渲染永不背离
  const weight = dialogueEffectiveWeight(dialogue);
  const fontPx = Math.max(8, dialogue.fontStyle.size * panel.width / FONT_SCALE_BASE);
  const font: DialogueMeasureFont = { px: fontPx, weight, family: dialogue.fontStyle.family };
  const metrics = measureMetrics(font);
  const lineHeight = fontPx * DIALOGUE_LINE_HEIGHT;
  const text = dialogue.text.trim();
  const tail = resolveBubbleTail(dialogue);

  let boxWidth: number;
  let boxHeight: number;
  let lines: string[];
  let truncated = false;
  const fixed = Boolean(safe.size);
  if (fixed) {
    boxWidth = safe.size!.width * panel.width;
    boxHeight = safe.size!.height * panel.height;
    const wrapped = wrapDialogueText(text, boxWidth * (1 - inset.x * 2), measure, font);
    lines = wrapped.lines;
    truncated = wrapped.truncated;
  } else {
    const wrapped = wrapDialogueText(text, panel.width * AUTO_WRAP_RATIO, measure, font);
    lines = wrapped.lines;
    truncated = wrapped.truncated;
    if (lines.length === 0) {
      // 空文本（放置后未输入）：给一个可拖拽的最小占位盒
      boxWidth = panel.width * 0.32;
      boxHeight = lineHeight / (1 - inset.y * 2);
    } else {
      const widest = lines.reduce((acc, line) => Math.max(acc, measure(line, font)), 0);
      const textHeight = lines.length * lineHeight;
      // inset 反解：insetPx = inset × box → box = content / (1 − inset×2)
      boxWidth = Math.min(widest / (1 - inset.x * 2), panel.width * BOX_MAX_W);
      boxHeight = Math.min(textHeight / (1 - inset.y * 2), panel.height * BOX_MAX_H);
    }
  }

  // 中心锚点 → 盒左上；clamp 在本格安全边距内（移盒不缩盒）
  const centerX = safe.position.x * panel.width;
  const centerY = safe.position.y * panel.height;
  const margin = frameless ? PANEL_MARGIN_FRAMELESS : PANEL_MARGIN_BUBBLE;
  const minX = panel.width * margin;
  const maxX = panel.width * (1 - margin) - boxWidth;
  const minY = panel.height * margin;
  const maxY = panel.height * (1 - margin) - boxHeight;
  const box = {
    x: Math.min(Math.max(centerX - boxWidth / 2, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(centerY - boxHeight / 2, minY), Math.max(minY, maxY)),
    width: boxWidth,
    height: boxHeight,
  };

  // 文字安全区 + 垂直居中（固定盒内文字块居中；溢出时不裁文字但标记 overflow）
  const insetPx = { x: inset.x * box.width, y: inset.y * box.height };
  const textRect = {
    x: box.x + insetPx.x,
    y: box.y + insetPx.y,
    width: Math.max(4, box.width - insetPx.x * 2),
    height: Math.max(4, box.height - insetPx.y * 2),
  };
  const textBlockHeight = lines.length * lineHeight;
  if (textBlockHeight > textRect.height) truncated = true;

  return {
    lines,
    fontPx,
    lineHeight,
    box,
    textRect,
    tail,
    overflow: truncated,
    fixed,
    metrics,
  };
}

/**
 * 第 i 行基线（panel 像素坐标系；canvas fillText 专用）。
 * 基线 = 行盒顶 + i×lineHeight + (lineHeight + (A−D)×fontPx)/2 —— 与浏览器
 * line box（half-leading + 真实 ascent）同式（B1 修复：A/D 来自 measureMetrics，
 * 真实端读 canvas fontBoundingBox，与 DOM 渲染同一字体引擎）。
 */
export function dialogueBaseline(layout: DialogueLayout, lineIndex: number): number {
  const textBlockTop = layout.textRect.y
    + Math.max(0, (layout.textRect.height - layout.lines.length * layout.lineHeight) / 2);
  const baselineShift = (layout.metrics.ascent - layout.metrics.descent) / 2 * layout.fontPx;
  return textBlockTop + lineIndex * layout.lineHeight + layout.lineHeight / 2 + baselineShift;
}

/** 第 i 行文字块左上（DOM 逐行 span 定位用；按对齐方式取 x）。 */
export function dialogueLineAnchorX(layout: DialogueLayout, lineIndex: number, alignment: ComicDialogue['alignment']): number {
  const rect = layout.textRect;
  if (alignment === 'left') return rect.x;
  if (alignment === 'right') return rect.x + rect.width;
  return rect.x + rect.width / 2;
}

// ---------------------------------------------------------------------------
// measure 工厂：真实端 canvas measureText（DOM 与导出同一实现）；估算回退
// （jsdom 无 canvas 2D；CJK≈1em / 其他≈0.55em，测试与降级渲染一致可用）
// ---------------------------------------------------------------------------

let measureCanvas: HTMLCanvasElement | null = null;

export function createCanvasMeasure(): MeasureText | null {
  if (typeof document === 'undefined') return null;
  if (!measureCanvas) {
    try {
      measureCanvas = document.createElement('canvas');
    } catch {
      return null;
    }
  }
  const ctx = measureCanvas.getContext('2d');
  if (!ctx || typeof ctx.measureText !== 'function') return null;
  return (text, font) => {
    ctx.font = `${font.weight} ${font.px}px ${dialogueFontStack(font.family)}`;
    return ctx.measureText(text).width;
  };
}

/** 确定性估算 measure（jsdom / 单测注入；CJK 与全角≈1em，其余≈0.55em）。 */
export function estimateMeasure(text: string, font: DialogueMeasureFont): number {
  let units = 0;
  for (const char of text) {
    units += /[⺀-鿿豈-﫿＀-￯　-〿]/.test(char) ? 1 : 0.55;
  }
  return units * font.px;
}

/** 运行时最优 measure：canvas 优先，估算回退（编辑器在无 canvas 环境仍可渲染）。 */
export function runtimeMeasure(): MeasureText {
  return createCanvasMeasure() ?? estimateMeasure;
}
