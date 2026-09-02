/**
 * 漫画气泡共享几何层（V4.2.12 §22 建立 / V4.2.14 Bubble Library V2 扩展）——
 * 「Picker 预览 / 画布编辑 / PNG 导出」三处同一形状与文字呈现的唯一事实源：
 *  - 本模块只产出 SVG path 字符串（局部坐标 0..W × 0..H）、结构标记（虚线 / 拖尾圆 /
 *    底色语义）与文字呈现预设（描边 / 阴影 / 加粗），不触碰 DOM / canvas；
 *  - DOM 侧：SVG `<path d>` 直接消费；导出侧：`new Path2D(d)` + ctx 变换消费；
 *  - 纯函数 + 零副作用：vitest 可直接断言 path 差异与样式分组。
 *
 * V4.2.14（docs/ai-comic/28 §6）：16 样式四分组（对白 / 情绪 / 旁白 / 无框漫画字）；
 * 无框组不是"关闭气泡背景"，而是正式 Comic Typography Style（fill/stroke/shadow 预设）。
 * 作品层固定配色不随明暗主题切换（docs/ai-comic/08 既有豁免先例）。
 */

import type { ComicDialogue, ComicDialogueBubble, ComicDialogueTail } from './types';

/** 归一化几何坐标系（viewBox 与导出变换共用基准）。 */
export const BUBBLE_CANVAS = 100;

export interface BubbleCircle {
  cx: number;
  cy: number;
  r: number;
}

export interface BubbleGeometry {
  /** 气泡主体 path（局部坐标）；无框文字 = null */
  body: string | null;
  /** 思考气泡拖尾小圆（随尾巴方向排布） */
  extras: BubbleCircle[];
  /** 低声/悄悄话：虚线描边 */
  dashed: boolean;
  /** 解析后的尾巴方向；旁白框 / 无框文字 / 爆芒类无尾 */
  tail: ResolvedTail | null;
  /** 底色语义：bubble = 白底黑字；narration = 深底白字 */
  fill: 'bubble' | 'narration';
}

export type ResolvedTail = Exclude<ComicDialogueTail, 'auto'>;

/** Bubble Library V2 四分组（Picker 分区标题 = 分组文案）。 */
export type ComicBubbleStyleGroup = 'dialogue' | 'emotion' | 'narration' | 'frameless';

export const COMIC_BUBBLE_GROUP_LABELS: Record<ComicBubbleStyleGroup, string> = {
  dialogue: '对白',
  emotion: '情绪',
  narration: '旁白',
  frameless: '无框文字',
};

/** 气泡样式用户文案与能力位（Picker 卡顺序 = 数组顺序，V4.2.14 十六类）。 */
export interface ComicBubbleStyleMeta {
  id: ComicDialogueBubble;
  label: string;
  group: ComicBubbleStyleGroup;
  /** 一句适用说明（Picker 卡副标题） */
  hint: string;
  /** Picker 预览用的示例文字 */
  sample: string;
  hasShape: boolean;
}

export const COMIC_BUBBLE_STYLES: readonly ComicBubbleStyleMeta[] = [
  // —— 对话 ——
  { id: 'rounded', label: '经典对白', group: 'dialogue', hint: '椭圆气泡 + 尾巴，最常见的对白', sample: '你好！', hasShape: true },
  { id: 'soft', label: '圆润对白', group: 'dialogue', hint: '更软的圆角，萌系漫画常用', sample: '嘿嘿~', hasShape: true },
  { id: 'cloud-talk', label: '云朵对白', group: 'dialogue', hint: '云朵轮廓 + 尾巴，轻松日常对话', sample: '今天天气真好', hasShape: true },
  { id: 'rect', label: '矩形对白', group: 'dialogue', hint: '方正干净的对白框，信息量大时用', sample: '说重点！', hasShape: true },
  // —— 情绪 ——
  { id: 'cloud', label: '思考气泡', group: 'emotion', hint: '云朵气泡 + 小圆拖尾，表示内心话', sample: '唔……', hasShape: true },
  { id: 'spiky', label: '喊话爆炸', group: 'emotion', hint: '锯齿爆芒，大声 / 情绪爆发时用', sample: '快迟到了！', hasShape: true },
  { id: 'sharp', label: '惊讶尖刺', group: 'emotion', hint: '长尖刺星形，极度惊讶 / 震惊', sample: '什么？！', hasShape: true },
  { id: 'whisper', label: '低声虚线', group: 'emotion', hint: '虚线边缘，悄悄话 / 小声嘀咕', sample: '嘘……小声点', hasShape: true },
  // —— 旁白 ——
  { id: 'box-light', label: '白底旁白框', group: 'narration', hint: '白底黑字方框，交代时间与剧情', sample: '第二天早晨……', hasShape: true },
  { id: 'box', label: '黑底白字旁白', group: 'narration', hint: '深色底白字，电影字幕感', sample: '与此同时——', hasShape: true },
  { id: 'title-bar', label: '顶部标题框', group: 'narration', hint: '通栏标题条，放画面顶部', sample: '第 1 话', hasShape: true },
  { id: 'subtitle-bar', label: '底部字幕框', group: 'narration', hint: '通栏字幕条，放画面底部', sample: '—— 未完待续 ——', hasShape: true },
  // —— 无框漫画字 ——
  { id: 'hand', label: '黑色手绘字', group: 'frameless', hint: '无框粗体字 + 细白描边，手绘漫画感', sample: '啊——！', hasShape: false },
  { id: 'stroke-black', label: '黑字白描边', group: 'frameless', hint: '黑字粗白描边，复杂背景也清晰', sample: '看这里！', hasShape: false },
  { id: 'stroke-white', label: '白字黑描边', group: 'frameless', hint: '白字黑描边，适合深色画面', sample: '好亮……', hasShape: false },
  { id: 'plain', label: '纯净无框文字', group: 'frameless', hint: '不加任何底、边、描边的纯文字', sample: '只是文字', hasShape: false },
];

/** legacy `none`（V4.2.11~13 持久化值）渲染语义 = 黑字白描边；Picker 不再单列。 */
export const LEGACY_BUBBLE_ALIAS: Record<string, ComicDialogueBubble> = { none: 'stroke-black' };

/** 按分组取样式卡（Picker 分区渲染）。 */
export function comicBubbleStylesByGroup(group: ComicBubbleStyleGroup): readonly ComicBubbleStyleMeta[] {
  return COMIC_BUBBLE_STYLES.filter(meta => meta.group === group);
}

export function comicBubbleStyleMeta(id: ComicDialogueBubble): ComicBubbleStyleMeta {
  const resolved = LEGACY_BUBBLE_ALIAS[id] ?? id;
  return COMIC_BUBBLE_STYLES.find(meta => meta.id === resolved) ?? COMIC_BUBBLE_STYLES[0]!;
}

/** 无框漫画字组（正式 Comic Typography；无形状、只有文字呈现预设）。 */
export function isFramelessStyle(style: ComicDialogueBubble): boolean {
  return comicBubbleStyleMeta(style).group === 'frameless';
}

/** 有尾巴的样式（尾巴方向 Select 是否可用；其余恒无尾）。 */
export function styleHasTail(style: ComicDialogueBubble): boolean {
  return ['rounded', 'soft', 'cloud-talk', 'rect', 'cloud', 'whisper'].includes(style);
}

/**
 * auto 尾巴解析（确定性，可测）：气泡在上半格 → 尾巴朝下；下半格 → 朝上；
 * 水平方向指向画布中心一侧。
 */
export function resolveBubbleTail(dialogue: Pick<ComicDialogue, 'bubbleStyle' | 'tail' | 'position'>): ResolvedTail | null {
  const style = comicBubbleStyleMeta(dialogue.bubbleStyle).id;
  if (!styleHasTail(style)) return null;
  if (dialogue.tail && dialogue.tail !== 'auto') return dialogue.tail;
  const vertical = dialogue.position.y < 0.5 ? 'bottom' : 'top';
  const horizontal = dialogue.position.x < 0.5 ? 'left' : 'right';
  return `${vertical}-${horizontal}` as ResolvedTail;
}

/** 椭圆 path（中心 cx,cy；半径 rx,ry）。 */
function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  return [
    `M ${cx - rx} ${cy}`,
    `A ${rx} ${ry} 0 0 1 ${cx + rx} ${cy}`,
    `A ${rx} ${ry} 0 0 1 ${cx - rx} ${cy}`,
    'Z',
  ].join(' ');
}

/** 圆角矩形 path。 */
function roundRectPath(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.min(radius, width / 2, height / 2);
  return [
    `M ${x + r} ${y}`,
    `H ${x + width - r}`,
    `A ${r} ${r} 0 0 1 ${x + width} ${y + r}`,
    `V ${y + height - r}`,
    `A ${r} ${r} 0 0 1 ${x + width - r} ${y + height}`,
    `H ${x + r}`,
    `A ${r} ${r} 0 0 1 ${x} ${y + height - r}`,
    `V ${y + r}`,
    `A ${r} ${r} 0 0 1 ${x + r} ${y}`,
    'Z',
  ].join(' ');
}

/**
 * 爆芒多边形 path：内外双半径交替，围出一圈锯齿。
 * inner 越小刺越长越尖（spiky=密集短爆芒；sharp=稀疏长尖刺）。
 */
function burstPath(cx: number, cy: number, rx: number, ry: number, spikes = 14, inner = 0.78): string {
  const points: string[] = [];
  for (let index = 0; index < spikes * 2; index += 1) {
    const angle = (Math.PI * 2 * index) / (spikes * 2) - Math.PI / 2;
    const factor = index % 2 === 0 ? 1 : inner;
    points.push(`${(cx + Math.cos(angle) * rx * factor).toFixed(2)} ${(cy + Math.sin(angle) * ry * factor).toFixed(2)}`);
  }
  return `M ${points[0]} L ${points.slice(1).join(' L ')} Z`;
}

/**
 * 云朵轮廓 path：椭圆周上内外半径交替的顶点，用小弧段连接出连续鼓包
 * （SVG `A` 弧与 Path2D 同构，DOM / 导出双端一致）。
 */
function cloudTalkPath(cx: number, cy: number, rx: number, ry: number, bumps = 9): string {
  const points: Array<{ x: number; y: number }> = [];
  const count = bumps * 2;
  for (let index = 0; index < count; index += 1) {
    const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
    const factor = index % 2 === 0 ? 1 : 0.84;
    points.push({ x: cx + Math.cos(angle) * rx * factor, y: cy + Math.sin(angle) * ry * factor });
  }
  const chord = Math.min(rx, ry) * 0.42;
  const segments = points.slice(1).map(point => `A ${chord.toFixed(2)} ${chord.toFixed(2)} 0 0 1 ${point.x.toFixed(2)} ${point.y.toFixed(2)}`);
  return `M ${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)} ${segments.join(' ')} Z`;
}

/** 尾巴三角 path：主体边缘锚点向 tail 方向伸出。 */
function tailPath(cx: number, cy: number, rx: number, ry: number, tail: ResolvedTail): string {
  const vertical = tail.startsWith('bottom') ? 1 : -1;
  const horizontal = tail.endsWith('right') ? 1 : -1;
  // 锚点在椭圆边界（垂直方向为主）
  const anchorX = cx + horizontal * rx * 0.42;
  const anchorY = cy + vertical * ry * 0.92;
  const length = Math.min(rx, ry) * 0.55;
  const base = Math.min(rx, ry) * 0.42;
  return [
    `M ${anchorX - base * 0.5} ${anchorY - vertical * base * 0.18}`,
    `L ${anchorX + horizontal * length} ${anchorY + vertical * length}`,
    `L ${anchorX + base * 0.5} ${anchorY - vertical * base * 0.18}`,
    'Z',
  ].join(' ');
}

/** 圆角矩形主体的尾巴三角（soft / whisper / rect / cloud-talk 用）。 */
function rectTailPath(width: number, height: number, tail: ResolvedTail): string {
  const vertical = tail.startsWith('bottom') ? 1 : -1;
  const horizontal = tail.endsWith('right') ? 1 : -1;
  const anchorX = width * (horizontal > 0 ? 0.66 : 0.34);
  const anchorY = vertical > 0 ? height - 3 : 3;
  const length = Math.min(width, height) * 0.5;
  const base = Math.min(width, height) * 0.34;
  return [
    `M ${anchorX - base * 0.5} ${anchorY - vertical * 3}`,
    `L ${anchorX + horizontal * length} ${anchorY + vertical * length}`,
    `L ${anchorX + base * 0.5} ${anchorY - vertical * 3}`,
    'Z',
  ].join(' ');
}

/**
 * 文字在气泡框内的安全内衬（比例，相对框宽/高）——由 dialogueLayout 引擎
 * 像素化（inset.x×boxW / inset.y×boxH）后双端共用，保证换行一致
 * （V4.2.14 废除 CSS 百分比 padding 双语义，docs/ai-comic/28 §4）。
 */
export function bubbleTextInset(style: ComicDialogueBubble): { x: number; y: number } {
  switch (comicBubbleStyleMeta(style).id) {
    case 'rounded': return { x: 0.17, y: 0.15 };
    case 'cloud': return { x: 0.15, y: 0.13 };
    case 'cloud-talk': return { x: 0.15, y: 0.13 };
    case 'spiky': return { x: 0.13, y: 0.12 };
    case 'sharp': return { x: 0.16, y: 0.15 };
    case 'box-light': return { x: 0.07, y: 0.09 };
    case 'box': return { x: 0.07, y: 0.09 };
    case 'title-bar': return { x: 0.06, y: 0.18 };
    case 'subtitle-bar': return { x: 0.06, y: 0.18 };
    case 'soft':
    case 'whisper': return { x: 0.09, y: 0.11 };
    case 'rect': return { x: 0.08, y: 0.1 };
    case 'hand':
    case 'stroke-black':
    case 'stroke-white':
    case 'plain':
    default: return { x: 0.02, y: 0.04 };
  }
}

/**
 * 生成气泡几何（局部坐标 0..W × 0..H）。宽高只决定纵横比——DOM/导出侧各自缩放，
 * 形状族三处完全一致。无框组 body=null（文字呈现走 dialogueTextPaint）。
 */
export function bubbleGeometry(
  style: ComicDialogueBubble,
  width: number,
  height: number,
  tail: ResolvedTail | null,
): BubbleGeometry {
  const w = Math.max(8, width);
  const h = Math.max(8, height);
  const cx = w / 2;
  const cy = h / 2;
  switch (comicBubbleStyleMeta(style).id) {
    case 'box':
      // 黑底白字旁白：矩形 + 小圆角，无尾巴，深底白字
      return {
        body: roundRectPath(2, 2, w - 4, h - 4, 7),
        extras: [],
        dashed: false,
        tail: null,
        fill: 'narration',
      };
    case 'box-light':
      // 白底旁白框：白底黑字，无尾巴
      return {
        body: roundRectPath(2, 2, w - 4, h - 4, 7),
        extras: [],
        dashed: false,
        tail: null,
        fill: 'bubble',
      };
    case 'title-bar':
    case 'subtitle-bar':
      // 顶部标题 / 底部字幕：通栏扁条（摆放建议由 Inspector 预设 y），深底白字
      return {
        body: roundRectPath(2, 2, w - 4, h - 4, 5),
        extras: [],
        dashed: false,
        tail: null,
        fill: 'narration',
      };
    case 'spiky':
      // 喊话爆炸：密集短爆芒（方向中性，不需要尾巴）
      return {
        body: burstPath(cx, cy, w / 2 - 2, h / 2 - 2, 14, 0.78),
        extras: [],
        dashed: false,
        tail: null,
        fill: 'bubble',
      };
    case 'sharp':
      // 惊讶尖刺：稀疏长尖刺
      return {
        body: burstPath(cx, cy, w / 2 - 2, h / 2 - 2, 8, 0.52),
        extras: [],
        dashed: false,
        tail: null,
        fill: 'bubble',
      };
    case 'whisper': {
      // 低声：大圆角 + 虚线描边 + 尾巴
      const body = roundRectPath(3, 3, w - 6, h - 6, Math.min(w, h) * 0.3);
      return {
        body: tail ? `${body} ${rectTailPath(w, h, tail)}` : body,
        extras: [],
        dashed: true,
        tail,
        fill: 'bubble',
      };
    }
    case 'cloud': {
      // 思考：主椭圆 + 尾巴方向 2~3 个渐小拖尾圆
      const geometry: BubbleGeometry = {
        body: ellipsePath(cx, cy, w / 2 - 3, h / 2 - 3),
        extras: [],
        dashed: false,
        tail,
        fill: 'bubble',
      };
      if (tail) {
        const vertical = tail.startsWith('bottom') ? 1 : -1;
        const horizontal = tail.endsWith('right') ? 1 : -1;
        const base = Math.min(w, h) * 0.09;
        let edgeX = cx + horizontal * (w / 2) * 0.45;
        let edgeY = cy + vertical * (h / 2) * 0.9;
        for (let index = 0; index < 3; index += 1) {
          geometry.extras.push({ cx: edgeX, cy: edgeY, r: base * (1 - index * 0.26) });
          edgeX += horizontal * base * 1.7;
          edgeY += vertical * base * 1.7;
        }
      }
      return geometry;
    }
    case 'cloud-talk': {
      // 云朵对白：连续鼓包的云朵轮廓 + 尾巴
      const body = cloudTalkPath(cx, cy, w / 2 - 3, h / 2 - 3);
      return {
        body: tail ? `${body} ${rectTailPath(w, h, tail)}` : body,
        extras: [],
        dashed: false,
        tail,
        fill: 'bubble',
      };
    }
    case 'soft': {
      // 圆润对白：超圆角矩形 + 尾巴
      const body = roundRectPath(2, 2, w - 4, h - 4, Math.min(w, h) * 0.42);
      return {
        body: tail ? `${body} ${rectTailPath(w, h, tail)}` : body,
        extras: [],
        dashed: false,
        tail,
        fill: 'bubble',
      };
    }
    case 'rect': {
      // 矩形对白：方正对白框 + 尾巴
      const body = roundRectPath(2, 2, w - 4, h - 4, 3);
      return {
        body: tail ? `${body} ${rectTailPath(w, h, tail)}` : body,
        extras: [],
        dashed: false,
        tail,
        fill: 'bubble',
      };
    }
    case 'rounded':
    default: {
      // 经典对白：椭圆 + 尾巴（无框组落 default：无形状）
      if (comicBubbleStyleMeta(style).group === 'frameless') {
        return { body: null, extras: [], dashed: false, tail: null, fill: 'bubble' };
      }
      const rx = w / 2 - 2;
      const ry = h / 2 - 2;
      const body = ellipsePath(cx, cy, rx, ry);
      return {
        body: tail ? `${body} ${tailPath(cx, cy, rx, ry, tail)}` : body,
        extras: [],
        dashed: false,
        tail,
        fill: 'bubble',
      };
    }
  }
}

// ---------------------------------------------------------------------------
// V4.2.14 文字呈现预设（无框漫画字 = 正式 Comic Typography，docs/ai-comic/28 §6）
// ---------------------------------------------------------------------------

/** 文字绘制预设：DOM（-webkit-text-stroke / text-shadow / font-weight）与导出
 * （strokeText / fillText）共用同一份数值，双端观感一致。 */
export interface DialogueTextPaint {
  /** 文字颜色（缺省跟 fontStyle.color；narration 底默认白） */
  fill: string;
  /** 描边：width = 描边宽度 / 字号 比例（渲染时 × fontPx） */
  stroke?: { color: string; width: number };
  shadow?: 'none' | 'soft';
  /** 预设加粗（hand=700；不覆盖用户显式 weight ≥600） */
  weightBoost?: number;
}

/**
 * 气泡描边宽（panel 宽比例；2.4px @ 504 基准槽）——DOM SVG stroke-width 与导出
 * canvas lineWidth 同源（B2 修复：描边随面板宽等比，双端比例恒等）。
 */
export const BUBBLE_STROKE_WIDTH_RATIO = 2.4 / 504;

/** whisper 虚线段长（panel 宽比例；6/4 px @ 504 基准槽）——DOM dasharray 与
 * canvas setLineDash 同源（B3 修复）。 */
export const BUBBLE_DASH_PATTERN = { on: 6 / 504, off: 4 / 504 };

/**
 * soft 阴影（fontPx 比例；1/3/2 px @ fontPx=31.5 基准观感）——DOM text-shadow
 * 双层与导出 canvas shadowBlur/OffsetY 同源（B5 修复：阴影随字号等比）。
 */
export const DIALOGUE_SOFT_SHADOW = {
  offsetY: 1 / 31.5,
  blur: 3 / 31.5,
  halo: 2 / 31.5,
  dropColor: 'rgba(0,0,0,0.32)',
  haloColor: 'rgba(0,0,0,0.22)',
};

/**
 * 有形气泡底色/描边色（fill 语义 bubble/narration 两档）——导出 canvas 与编辑器
 * CSS（ComicStudio.css `.comic-bubble-svg`）同源（V4.2.13 残留：canvas 此前内联
 * 硬编码，值与 CSS 相等但无守卫；现收口为常量 + conformance 测试锁 CSS 值防漂移）。
 */
export const BUBBLE_SURFACE_COLORS = {
  bubble: { fill: 'rgba(255,255,255,0.96)', stroke: 'rgba(17,17,17,0.42)' },
  narration: { fill: 'rgba(20,20,26,0.82)', stroke: 'rgba(255,255,255,0.28)' },
} as const;

const PAINT_PRESETS: Partial<Record<ComicDialogueBubble, DialogueTextPaint>> = {
  hand: { fill: '#141414', stroke: { color: 'rgba(255,255,255,0.92)', width: 0.14 }, shadow: 'soft', weightBoost: 700 },
  'stroke-black': { fill: '#141419', stroke: { color: '#ffffff', width: 0.16 }, shadow: 'soft' },
  'stroke-white': { fill: '#ffffff', stroke: { color: '#141419', width: 0.16 } },
  plain: { fill: '#141419' },
};

/**
 * 一条对白的文字呈现（唯一事实源）：样式预设 + 对白级 strokeStyle / shadow 覆盖。
 * 气泡组文字颜色由消费侧按 fill 语义决定（bubble=黑 / narration=白），
 * 无框组颜色在此决定。
 */
export function dialogueTextPaint(
  dialogue: Pick<ComicDialogue, 'bubbleStyle' | 'fontStyle' | 'strokeStyle' | 'shadow'>,
  containerFill: 'bubble' | 'narration',
): DialogueTextPaint {
  const styleId = comicBubbleStyleMeta(dialogue.bubbleStyle).id;
  const preset = PAINT_PRESETS[styleId];
  const baseFill = dialogue.fontStyle.color
    || (preset?.fill ?? (containerFill === 'narration' ? '#ffffff' : '#141419'));
  if (!preset) {
    return {
      fill: baseFill,
      stroke: dialogue.strokeStyle ? { ...dialogue.strokeStyle } : undefined,
      shadow: dialogue.shadow,
    };
  }
  return {
    fill: baseFill,
    stroke: dialogue.strokeStyle
      ? { ...dialogue.strokeStyle }
      : preset.stroke
        ? { ...preset.stroke }
        : undefined,
    shadow: dialogue.shadow ?? preset.shadow,
    weightBoost: preset.weightBoost,
  };
}

/** 字体栈（预览 / 导出共用同一 fallback 链，§78）。 */
export function dialogueFontStack(family?: string): string {
  const quoted = family?.trim() ? `'${family.trim().replace(/'/g, '')}'` : '';
  return quoted
    ? `${quoted}, 'Microsoft YaHei', 'SimHei', sans-serif`
    : `'Microsoft YaHei', 'SimHei', sans-serif`;
}

/** 有效字重（预设加粗不覆盖用户显式 ≥600 的选择）：测量 / DOM / 导出三处唯一算法，
 * 保证 wrap 宽度与绘制字重永远一致（V4.2.14 契约）。 */
export function dialogueEffectiveWeight(
  dialogue: Pick<ComicDialogue, 'bubbleStyle' | 'fontStyle'>,
): ComicDialogue['fontStyle']['weight'] {
  const boost = PAINT_PRESETS[comicBubbleStyleMeta(dialogue.bubbleStyle).id]?.weightBoost;
  if (boost && dialogue.fontStyle.weight < boost) return boost as ComicDialogue['fontStyle']['weight'];
  return dialogue.fontStyle.weight;
}
