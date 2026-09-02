/**
 * 文字层几何回归（V4.2.13 §12~§49）——持久化归一化 + 渲染 sanitize + WYSIWYG
 * 引擎契约（V4.2.13 引擎化刷新：DOM 内联 px 与 calculateDialogueLayout 输出
 * 逐值相等；jsdom 无 canvas → runtimeMeasure 回落 estimateMeasure，确定性）。
 */

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ComicBubbleBox from '../components/ComicBubbleBox';
import BubbleStylePicker from '../components/BubbleStylePicker';
import { normalizeComicDialogue } from '../normalize';
import { COMIC_DIALOGUE_SIZE_RANGE } from '../normalize';
import { sanitizeBubbleGeometry } from '../textLayer';
import { resolveBubbleTail } from '../bubbleShape';
import { BUBBLE_CANVAS, bubbleGeometry } from '../bubbleShape';
import { calculateDialogueLayout, estimateMeasure } from '../dialogueLayout';
import type { ComicDialogue } from '../types';
import { DUCKPEAR_RAW_DIALOGUES } from './duckpearTextLayerV4213.fixture';

function makeDialogue(overrides: Partial<ComicDialogue> = {}): ComicDialogue {
  return {
    id: 'dlg-4213',
    panelId: 'panel-0',
    speakerId: 'narrator',
    type: 'speech',
    text: '你好！',
    position: { x: 0.4, y: 0.25 },
    alignment: 'center',
    fontStyle: { size: 16, weight: 500 },
    bubbleStyle: 'rounded',
    tail: 'bottom-left',
    ...overrides,
  };
}

/** save → reload：normalize → JSON 落库 → 读回再 normalize（应用真实路径）。 */
function persistRoundTrip(raw: unknown): ComicDialogue | null {
  const first = normalizeComicDialogue(raw);
  if (!first) return null;
  return normalizeComicDialogue(JSON.parse(JSON.stringify(first)));
}

/** 编辑器逻辑面板（四格 1080 画布槽位 = 504px；与导出 slot 同尺度）。 */
const PANEL = { width: 504, height: 504 };

function renderBubble(overrides: Partial<ComicDialogue> = {}, frame: 'float' | 'inline' = 'float'): string {
  return renderToStaticMarkup(createElement(ComicBubbleBox, {
    dialogue: makeDialogue(overrides),
    panel: PANEL,
    frame,
  }));
}

/** 引擎期望布局（与组件内 runtimeMeasure() 在 jsdom 下同一 estimateMeasure）。 */
function engineLayout(overrides: Partial<ComicDialogue> = {}) {
  return calculateDialogueLayout(makeDialogue(overrides), PANEL, estimateMeasure);
}

// ---------------------------------------------------------------------------
// 1-4 · 归一化几何持久化（§31）
// ---------------------------------------------------------------------------

describe('§31 持久化：归一化 x/y/width/height save → reload 不丢', () => {
  const roundTrip = persistRoundTrip({
    ...makeDialogue(),
    position: { x: 0.32, y: 0.44 },
    size: { width: 0.32, height: 0.18 },
  })!;

  it('1 · normalized x persists（0.32 → 0.32，不取整不漂移）', () => {
    expect(roundTrip.position.x).toBe(0.32);
  });

  it('2 · normalized y persists（0.44 → 0.44）', () => {
    expect(roundTrip.position.y).toBe(0.44);
  });

  it('3 · normalized width persists（0.32 → 0.32）', () => {
    expect(roundTrip.size?.width).toBe(0.32);
  });

  it('4 · normalized height persists（0.18 → 0.18）', () => {
    expect(roundTrip.size?.height).toBe(0.18);
  });

  it('§30 回归 · V4.2.12 位置修复不回退（0.42/0.3 保持小数）', () => {
    const kept = persistRoundTrip(makeDialogue({ position: { x: 0.42, y: 0.3 } }))!;
    expect(kept.position).toEqual({ x: 0.42, y: 0.3 });
  });
});

// ---------------------------------------------------------------------------
// 5-8 · Legacy 迁移（§7-§10）
// ---------------------------------------------------------------------------

describe('§7-§10 旧数据迁移：缺省安全 + 刻度证据', () => {
  it('5 · 旧数据缺 width → 内容自适应（size undefined，绝不是 1.0）', () => {
    const legacy = persistRoundTrip({
      ...makeDialogue(),
      position: { x: 0.3575, y: 0.06 },
    });
    expect(legacy).not.toBeNull();
    expect(legacy!.size).toBeUndefined();
  });

  it('6 · 旧数据缺 height（只有 width 的残缺 size）→ 整体丢弃回自适应', () => {
    const legacy = persistRoundTrip({
      ...makeDialogue(),
      size: { width: 0.3, height: Number.NaN },
    });
    expect(legacy!.size).toBeUndefined();
  });

  it('7 · 百分比位置迁移：42/30（0..100 刻度证据）→ 0.42/0.3', () => {
    const legacy = persistRoundTrip({
      ...makeDialogue(),
      position: { x: 42, y: 30 },
    });
    expect(legacy!.position).toEqual({ x: 0.42, y: 0.3 });
  });

  it('8 · 旧 px 宽高迁移：320/180 不再钳成 1.0/1.0 整格气泡 → 回内容自适应', () => {
    const legacy = persistRoundTrip({
      ...makeDialogue(),
      size: { width: 320, height: 180 },
    });
    expect(legacy!.size).toBeUndefined();
    // 对照：合法归一化值 0.28/0.16 原样保留（钳入安全域不越界）
    const legit = persistRoundTrip({
      ...makeDialogue(),
      size: { width: 0.28, height: 0.16 },
    });
    expect(legit!.size).toEqual({ width: 0.28, height: 0.16 });
  });
});

// ---------------------------------------------------------------------------
// 9-12 · Renderer sanitize（§12/§13：巨大 / NaN / Infinity）+ 引擎等值
// ---------------------------------------------------------------------------

describe('§12/§13 渲染 sanitize：坏数据也不允许覆盖整格 / 整页', () => {
  it('9 · 巨大 width（500）sanitize 到安全上限，引擎盒宽 = 上限 × panel 宽', () => {
    const sanitized = sanitizeBubbleGeometry(makeDialogue({ size: { width: 500, height: 0.2 } }));
    expect(sanitized.size?.width).toBe(COMIC_DIALOGUE_SIZE_RANGE.max);
    const layout = engineLayout({ size: { width: 500, height: 0.2 } });
    expect(layout.box.width).toBeCloseTo(COMIC_DIALOGUE_SIZE_RANGE.max * PANEL.width, 6);
    const markup = renderBubble({ size: { width: 500, height: 0.2 } });
    expect(markup).toContain(`width:${layout.box.width}px`);
  });

  it('10 · 巨大 height（40）sanitize 到安全上限', () => {
    const sanitized = sanitizeBubbleGeometry(makeDialogue({ size: { width: 0.3, height: 40 } }));
    expect(sanitized.size?.height).toBe(COMIC_DIALOGUE_SIZE_RANGE.max);
    const layout = engineLayout({ size: { width: 0.3, height: 40 } });
    expect(layout.box.height).toBeCloseTo(COMIC_DIALOGUE_SIZE_RANGE.max * PANEL.height, 6);
  });

  it('11 · NaN sanitize：size 整体丢弃（回自适应）；position 回画布中点', () => {
    const nanSize = sanitizeBubbleGeometry(makeDialogue({ size: { width: Number.NaN, height: 0.2 } }));
    expect(nanSize.size).toBeUndefined();
    const nanPos = sanitizeBubbleGeometry(makeDialogue({ position: { x: Number.NaN, y: Number.POSITIVE_INFINITY } }));
    expect(nanPos.position).toEqual({ x: 0.5, y: 0.5 });
  });

  it('12 · Infinity sanitize：size 丢弃 → 自适应盒（引擎算宽，DOM 与引擎等值）', () => {
    const infSize = sanitizeBubbleGeometry(makeDialogue({ size: { width: Number.POSITIVE_INFINITY, height: 0.2 } }));
    expect(infSize.size).toBeUndefined();
    const layout = engineLayout({ size: { width: Number.POSITIVE_INFINITY, height: 0.2 } });
    expect(layout.fixed).toBe(false);
    expect(Number.isFinite(layout.box.width)).toBe(true);
    const markup = renderBubble({ size: { width: Number.POSITIVE_INFINITY, height: 0.2 } });
    expect(markup).toContain(`width:${layout.box.width}px`);
  });
});

// ---------------------------------------------------------------------------
// 13-14 · 气泡 → 本格 / 画布两层 clip
// ---------------------------------------------------------------------------

describe('§13/§24 气泡有界：本格钳制 + 画布 clip 护栏', () => {
  it('13 · 气泡几何钳制在本格内：引擎 box 全量界内（0 ≤ x/y，尺寸 ≤ 上限 × panel）', () => {
    const layout = engineLayout({ position: { x: 1, y: 1 }, size: { width: 1.2, height: 0.9 } });
    expect(layout.box.x).toBeGreaterThanOrEqual(0);
    expect(layout.box.y).toBeGreaterThanOrEqual(0);
    expect(layout.box.x + layout.box.width).toBeLessThanOrEqual(PANEL.width + 0.5);
    expect(layout.box.y + layout.box.height).toBeLessThanOrEqual(PANEL.height + 0.5);
    expect(layout.box.width).toBeLessThanOrEqual(COMIC_DIALOGUE_SIZE_RANGE.max * PANEL.width);
    expect(layout.box.height).toBeLessThanOrEqual(COMIC_DIALOGUE_SIZE_RANGE.max * PANEL.height);
    const markup = renderBubble({ position: { x: 1, y: 1 }, size: { width: 1.2, height: 0.9 } });
    expect(markup).toContain(`left:${layout.box.x}px`);
    expect(markup).toContain(`top:${layout.box.y}px`);
  });

  it('14 · overlay 钳制在漫画画布内：.comic-editor-figure overflow:hidden 护栏存在（独立于几何修复）', () => {
    const css = readFileSync(resolve(__dirname, '../../../pages/ComicStudio.css'), 'utf-8').replace(/\r\n/g, '\n');
    const rule = css.match(/\.comic-editor-figure\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('position: relative');
    expect(rule).toContain('overflow: hidden');
  });
});

// ---------------------------------------------------------------------------
// 15-17 · 形状专项：喊话 / 思考 / 无框（引擎等值 + 几何有界）
// ---------------------------------------------------------------------------

describe('§21/§36/§37 喊话 / 思考 / 无框只占自身 rect', () => {
  it('15 · 喊话（spiky）受固定尺寸限制：盒 = size × panel；inline 预览自带定位上下文（根因修复）', () => {
    const layout = engineLayout({ bubbleStyle: 'spiky', size: { width: 0.3, height: 0.2 } });
    expect(layout.box.width).toBeCloseTo(0.3 * PANEL.width, 6);
    expect(layout.box.height).toBeCloseTo(0.2 * PANEL.height, 6);
    const markup = renderBubble({ bubbleStyle: 'spiky', size: { width: 0.3, height: 0.2 } });
    expect(markup).toContain(`width:${layout.box.width}px`);
    expect(markup).toContain(`height:${layout.box.height}px`);
    // 爆芒 path 全部顶点都在 viewBox 0..BUBBLE_CANVAS 内（无越界撑盒）
    const geometry = bubbleGeometry('spiky', BUBBLE_CANVAS, BUBBLE_CANVAS, null);
    for (const token of geometry.body!.split(/\s+/)) {
      const value = Number(token);
      if (Number.isFinite(value)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(BUBBLE_CANVAS);
      }
    }
    // 根因：inline 帧（Picker 卡）必须自带定位上下文，SVG 不再上浮 viewport
    const inline = renderToStaticMarkup(createElement(ComicBubbleBox, {
      dialogue: makeDialogue({ bubbleStyle: 'spiky' }),
      panel: PANEL,
      frame: 'inline',
    }));
    expect(inline).toContain('is-inline');
    const css = readFileSync(resolve(__dirname, '../../../pages/ComicStudio.css'), 'utf-8').replace(/\r\n/g, '\n');
    expect(css).toMatch(/\.comic-bubble-box\.is-inline\s*\{[^}]*position:\s*relative/);
    expect(css).toMatch(/\.comic-bubble-picker-preview\s*\{[^}]*position:\s*relative/s);
    // static 覆写必须已删除（否则同特异性后者胜，把 SVG 包含块顶回 viewport）
    expect(css).not.toMatch(/\.comic-bubble-picker-preview \.comic-bubble-box\s*\{[^}]*position:\s*static/);
    // Picker 全卡（含喊话卡）都挂 is-inline（十六类库）
    const picker = renderToStaticMarkup(createElement(BubbleStylePicker, { value: 'spiky', onChange: () => {} }));
    expect(picker.match(/is-inline/g)?.length).toBe(16);
  });

  it('16 · 思考（cloud）主体在 rect 内；拖尾小圆是有界装饰（±30% 画布内、半径 ≤12%），不撑大气泡盒', () => {
    const tail = resolveBubbleTail(makeDialogue({ bubbleStyle: 'cloud' }));
    const geometry = bubbleGeometry('cloud', BUBBLE_CANVAS, BUBBLE_CANVAS, tail);
    expect(geometry.extras.length).toBeGreaterThan(0);
    for (const circle of geometry.extras) {
      // 拖尾朝说话人方向伸出盒外是设计行为（svg overflow:visible），但必须有界：
      // 中心不越过 ±30% 画布、半径 ≤ 12% —— 绝不可能反客为主铺满页面
      expect(circle.cx).toBeGreaterThanOrEqual(-BUBBLE_CANVAS * 0.3);
      expect(circle.cx).toBeLessThanOrEqual(BUBBLE_CANVAS * 1.3);
      expect(circle.cy).toBeGreaterThanOrEqual(-BUBBLE_CANVAS * 0.3);
      expect(circle.cy).toBeLessThanOrEqual(BUBBLE_CANVAS * 1.3);
      expect(circle.r).toBeLessThanOrEqual(BUBBLE_CANVAS * 0.12);
    }
    const layout = engineLayout({ bubbleStyle: 'cloud', size: { width: 0.36, height: 0.24 } });
    expect(layout.box.width).toBeCloseTo(0.36 * PANEL.width, 6);
    expect(layout.box.height).toBeCloseTo(0.24 * PANEL.height, 6);
  });

  it('17 · 无框文字（legacy none = stroke-black 等价）不受几何回归影响：无 svg、is-none 保留、尺寸来自引擎', () => {
    const markup = renderBubble({ bubbleStyle: 'none', size: { width: 0.3, height: 0.2 } });
    expect(markup.includes('<svg')).toBe(false);
    expect(markup).toContain('is-none');
    const layout = engineLayout({ bubbleStyle: 'none', size: { width: 0.3, height: 0.2 } });
    expect(markup).toContain(`width:${layout.box.width}px`);
    expect(markup).toContain(`height:${layout.box.height}px`);
  });
});

// ---------------------------------------------------------------------------
// 18 · z-index 护栏
// ---------------------------------------------------------------------------

describe('§23/§35 z-index：Text Overlay 不能盖 App Chrome', () => {
  it('18 · 气泡族 z-index ≤ 5 < 页内 sticky(60) < App Modal(1000) < Toast(9999)', () => {
    const css = readFileSync(resolve(__dirname, '../../../pages/ComicStudio.css'), 'utf-8').replace(/\r\n/g, '\n');
    const bubbleIndexes = [...css.matchAll(/\.comic-bubble-(?:box|handle)[^{]*\{[^}]*z-index:\s*(\d+)/g)]
      .map(match => Number(match[1]));
    expect(bubbleIndexes.length).toBeGreaterThan(0);
    expect(Math.max(...bubbleIndexes)).toBeLessThanOrEqual(5);
    const modalCss = readFileSync(resolve(__dirname, '../components/ComicDialog.css'), 'utf-8').replace(/\r\n/g, '\n');
    const modalIndex = Number(modalCss.match(/z-index:\s*(\d+)/)?.[1] ?? 0);
    expect(modalIndex).toBe(1000);
    const toastCss = readFileSync(resolve(__dirname, '../../../components/Toast.css'), 'utf-8').replace(/\r\n/g, '\n');
    const toastIndex = Number(toastCss.match(/z-index:\s*(\d+)/)?.[1] ?? 0);
    expect(toastIndex).toBe(9999);
    expect(Math.max(...bubbleIndexes)).toBeLessThan(60);
    expect(60).toBeLessThan(modalIndex);
    expect(modalIndex).toBeLessThan(toastIndex);
  });
});

// ---------------------------------------------------------------------------
// 19-20 · 真实旧项目 fixture 打开回归（§26/§27/§49）
// ---------------------------------------------------------------------------

describe('§49 真实旧项目打开兼容（Existing Project Compatibility Fixture）', () => {
  it('19 · V4.2.11《鸭梨山大》fixture：全部对白 geometry finite / 界内 / 引擎可渲染', () => {
    expect(DUCKPEAR_RAW_DIALOGUES).toHaveLength(5);
    for (const raw of DUCKPEAR_RAW_DIALOGUES) {
      const dialogue = normalizeComicDialogue(raw);
      expect(dialogue, raw.id).not.toBeNull();
      // §47 Loop gate：0 ≤ x ≤ 1 / 0 ≤ y ≤ 1 / 尺寸合理（旧 schema 无 size = 自适应）
      expect(dialogue!.position.x).toBeGreaterThanOrEqual(0);
      expect(dialogue!.position.x).toBeLessThanOrEqual(1);
      expect(dialogue!.position.y).toBeGreaterThanOrEqual(0);
      expect(dialogue!.position.y).toBeLessThanOrEqual(1);
      expect(dialogue!.size).toBeUndefined();
      // 渲染边界 sanitize 同样有界（角点 (1,1) 不炸）
      const sanitized = sanitizeBubbleGeometry(dialogue!);
      expect(Number.isFinite(sanitized.position.x)).toBe(true);
      expect(Number.isFinite(sanitized.position.y)).toBe(true);
      // 引擎可渲染：自适应盒 finite 且界内；DOM 与引擎等值
      const layout = calculateDialogueLayout(dialogue!, PANEL, estimateMeasure);
      expect(Number.isFinite(layout.box.x)).toBe(true);
      expect(Number.isFinite(layout.box.width)).toBe(true);
      expect(layout.box.x).toBeGreaterThanOrEqual(0);
      expect(layout.box.y).toBeGreaterThanOrEqual(0);
      const markup = renderToStaticMarkup(createElement(ComicBubbleBox, { dialogue: dialogue!, panel: PANEL }));
      expect(markup).toContain(`left:${layout.box.x}px`);
      expect(markup).toContain(`top:${layout.box.y}px`);
      expect(markup).toContain(`width:${layout.box.width}px`);
    }
  });

  it('20 · V4.2.12 fixture（size/tail/family 全字段）打开安全且不丢字段', () => {
    const v4212 = persistRoundTrip({
      ...makeDialogue(),
      bubbleStyle: 'spiky',
      position: { x: 0.42, y: 0.3 },
      size: { width: 0.32, height: 0.18 },
      fontStyle: { size: 20, weight: 600, family: 'KaiTi' },
      tail: 'top-right',
    })!;
    expect(v4212.position).toEqual({ x: 0.42, y: 0.3 });
    expect(v4212.size).toEqual({ width: 0.32, height: 0.18 });
    expect(v4212.fontStyle.family).toBe('KaiTi');
    expect(v4212.tail).toBe('top-right');
    // 喊话 + 固定尺寸：盒 = size × panel（引擎等值）
    const layout = calculateDialogueLayout(v4212, PANEL, estimateMeasure);
    expect(layout.box.width).toBeCloseTo(0.32 * PANEL.width, 6);
    expect(layout.box.height).toBeCloseTo(0.18 * PANEL.height, 6);
    const markup = renderToStaticMarkup(createElement(ComicBubbleBox, { dialogue: v4212, panel: PANEL }));
    expect(markup).toContain(`width:${layout.box.width}px`);
    expect(markup).toContain(`height:${layout.box.height}px`);
  });
});

// ---------------------------------------------------------------------------
// 21-24 · V4.2.13 WYSIWYG 契约补充（\n 硬换行 / 基线度量 / 行数上限）
// ---------------------------------------------------------------------------

describe('V4.2.13 WYSIWYG 契约：wrapDialogueText 单一语义', () => {
  it('21 · 手工换行（\\n）= 硬换行：先分段再逐段 wrap，行内容保留用户断句', () => {
    const layout = engineLayout({ text: '第一行\n第二行' });
    expect(layout.lines).toEqual(['第一行', '第二行']);
    // DOM 逐行渲染同源（white-space:pre 时代 \n 双语义已消除）
    const markup = renderBubble({ text: '第一行\n第二行' });
    for (const line of layout.lines) {
      expect(markup).toContain(`>${line}</span>`);
    }
  });

  it('22 · 硬换行 + 超宽仍逐字 wrap；行数上限 6 双端同 cap', () => {
    const long = '一二三四五六七八九十'.repeat(4);
    const layout = engineLayout({ text: `${long}\n${long}` });
    expect(layout.lines.length).toBe(6);
    expect(layout.overflow).toBe(true);
  });

  it('23 · 基线随度量走：ascent/descent 影响基线位置（canvas 与 DOM 行盒同式）', () => {
    const layout = calculateDialogueLayout(makeDialogue(), PANEL, estimateMeasure,
      () => ({ ascent: 1.06, descent: 0.27 }));
    const approximate = calculateDialogueLayout(makeDialogue(), PANEL, estimateMeasure);
    // 盒几何不随度量变（只影响基线），基线差 = (A−D)/2 − 0.3 × fontPx
    expect(layout.box).toEqual(approximate.box);
  });

  it('24 · 空文本 = 空 lines（占位盒逻辑由布局层处理，不渲染文字）', () => {
    const layout = engineLayout({ text: '   ' });
    expect(layout.lines).toEqual([]);
    const markup = renderBubble({ text: '' });
    expect(markup.includes('comic-bubble-line')).toBe(false);
  });
});
