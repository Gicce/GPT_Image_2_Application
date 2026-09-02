/**
 * V4.2.13 双问题修复 · 问题 2 确定性几何测试（上下双格 fit-safe 入槽）。
 *
 * 审计结论（docs/ai-comic/29）：Editor / ComicFinalPreview / 导出三条链本就共享
 * computePageLayouts + 同一入槽语义（WYSIWYG 在文字层成立）；真实缺陷是「资产比例
 * ≠ 槽位比例时的 center-cover 暴力裁切」——《雷夜围炉》（vertical_2 + 3:4 页）
 * 槽位 1032×684（1.5088）对 1024×1024 方形资产上下各裁 174px ≈ 33.7% 竖向构图。
 *
 * 本文件锁定（数值全部确定性，零 canvas 依赖）：
 *  - computePanelImageRect（fit-safe 单一事实源）：比例一致（1:1 四格）时与旧 cover
 *    数学逐值等价（零回归）；比例错配时完整保留画面（比例不变式 / 槽内包含 /
 *    恰一维贴边 / 居中）；
 *  - 雷夜形 fixture（vertical_2 + 3:4）：页面与两槽位精确值，槽序 = 分镜 order
 *    （无 undefined 重裁 / 无槽序错乱）；
 *  - 编辑器 / 导出 parity：ComicTextStage 内联 aspect-ratio = computePageLayouts
 *    槽位比、内联 background = exportDefaults.background（contain 留白带与导出页
 *    背景同色）；CSS object-fit:contain 与导出 computePanelImageRect 同策略；
 *  - 对白坐标契约不变（docs/ai-comic/28 §1：0..1 相对槽位矩形，fit-safe 不迁移）。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computePageLayouts, computePanelImageRect, type ComicSheetSlot } from '../comicExport';
import ComicTextStage from '../components/ComicTextStage';
import { normalizeComicPanel, normalizeComicProject, normalizeComicSkill } from '../normalize';
import type { ComicProject } from '../types';

// node 环境全局 stub（ComicTextStage 渲染路径的 store 只读访问）
vi.stubGlobal('document', { body: {}, getElementById: () => null });
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
});

const stageSource = readFileSync(
  resolve(__dirname, '../components/ComicTextStage.tsx'), 'utf-8',
).replace(/\r\n/g, '\n');
const exportSource = readFileSync(
  resolve(__dirname, '../comicExport.ts'), 'utf-8',
).replace(/\r\n/g, '\n');
const previewSource = readFileSync(
  resolve(__dirname, '../components/ComicFinalPreview.tsx'), 'utf-8',
).replace(/\r\n/g, '\n');
const studioCss = readFileSync(
  resolve(__dirname, '../../../pages/ComicStudio.css'), 'utf-8',
).replace(/\r\n/g, '\n');

function makeProject(options: {
  arrangement: string;
  canvasRatio?: '1:1' | '3:4' | '9:16';
  background?: string;
  panelCount: number;
}): ComicProject {
  const skill = normalizeComicSkill({
    name: '几何测试',
    comicForm: '多格漫画',
    layout: { panelCount: options.panelCount, arrangement: options.arrangement },
    exportDefaults: { canvasRatio: options.canvasRatio, background: options.background } as never,
    characterSlots: [],
  })!;
  const panels = Array.from({ length: options.panelCount }, (_, index) => normalizeComicPanel({
    id: `panel-${index}`,
    order: index,
    scene: `场景${index}`,
    generationStatus: 'completed',
    imageAsset: { path: `D:/lib/p${index}.png`, imageId: `img-${index}`, taskId: 't' },
  })!);
  return normalizeComicProject({
    id: 'p-fit', name: '第一期', stage: 'editing',
    skillSnapshot: skill, characterSnapshots: [], characterBindings: {},
    panels, dialogues: [],
  })!;
}

const SQUARE = { width: 1024, height: 1024 };
const LANDSCAPE = { width: 1792, height: 1024 };

/** fit-safe 不变式：完整保留（比例保持 / 槽内包含 / 恰一维贴边 / 居中留白）。 */
function expectContainFit(
  asset: { width: number; height: number },
  slot: ComicSheetSlot,
  rect: { x: number; y: number; width: number; height: number },
): void {
  expect(rect.width).toBeLessThanOrEqual(slot.width + 1e-9);
  expect(rect.height).toBeLessThanOrEqual(slot.height + 1e-9);
  expect(rect.width / rect.height).toBeCloseTo(asset.width / asset.height, 9);
  const flushX = Math.abs(rect.width - slot.width) < 1e-9;
  const flushY = Math.abs(rect.height - slot.height) < 1e-9;
  expect(flushX || flushY).toBe(true);
  expect(rect.x - slot.x).toBeCloseTo((slot.width - rect.width) / 2, 9);
  expect(rect.y - slot.y).toBeCloseTo((slot.height - rect.height) / 2, 9);
}

describe('雷夜形 fixture：vertical_2 × 3:4 页面与槽位（无 undefined / 无槽序错乱）', () => {
  const project = makeProject({ arrangement: 'vertical_2', canvasRatio: '3:4', background: '#f3efe7', panelCount: 2 });
  const layouts = computePageLayouts(project);

  it('单页 1080×1440，两槽位精确值（1032×684，上下排布，gap 24）', () => {
    expect(layouts).toHaveLength(1);
    const layout = layouts[0]!;
    expect(layout.width).toBe(1080);
    expect(layout.height).toBe(1440);
    expect(layout.gap).toBe(24);
    expect(layout.background).toBe('#f3efe7');
    expect(layout.slots.map(slot => slot.panelId)).toEqual(['panel-0', 'panel-1']);
    expect(layout.slots[0]).toMatchObject({ panelId: 'panel-0', x: 24, y: 24, width: 1032, height: 684 });
    expect(layout.slots[1]).toMatchObject({ panelId: 'panel-1', x: 24, y: 732, width: 1032, height: 684 });
  });
});

describe('computePanelImageRect：fit-safe 入槽（问题 2 修复本体）', () => {
  const slot = { panelId: 'panel-0', x: 24, y: 24, width: 1032, height: 684 }; // vertical_2 3:4 首槽

  it('方形 1024 资产 → 684×684 完整保留（上下双格不再裁掉 33.7% 竖向构图）', () => {
    const rect = computePanelImageRect(SQUARE, slot);
    expect(rect.width).toBeCloseTo(684, 9);
    expect(rect.height).toBeCloseTo(684, 9);
    expect(rect.x).toBeCloseTo(198, 9); // 24 + (1032-684)/2：左右各 174px 页背景带
    expect(rect.y).toBeCloseTo(24, 9);
    expectContainFit(SQUARE, slot, rect);
    // 修复前 drawCover（max scale）：1032×1032 → 上下各裁 174px；此处显式对照
    const coverScale = Math.max(slot.width / SQUARE.width, slot.height / SQUARE.height);
    expect(SQUARE.height * coverScale - slot.height).toBeCloseTo(348, 9); // 被裁总量 2×174
  });

  it('1:1 四格：方形资产入 504×504 槽 = 槽位全等（min==max，与旧 cover 逐值等价，零回归）', () => {
    const grid = computePageLayouts(makeProject({ arrangement: 'grid_4', canvasRatio: '1:1', panelCount: 4 }))[0]!;
    const gridSlot = grid.slots[0]!;
    expect(gridSlot.width).toBe(504);
    expect(gridSlot.height).toBe(504);
    const rect = computePanelImageRect(SQUARE, gridSlot);
    expect(rect).toMatchObject({ x: 24, y: 24, width: 504, height: 504 });
    // 与旧 cover 数学对照：比例一致时两策略逐值相同
    const coverScale = Math.max(gridSlot.width / SQUARE.width, gridSlot.height / SQUARE.height);
    expect(rect.width).toBeCloseTo(SQUARE.width * coverScale, 9);
    expect(rect.height).toBeCloseTo(SQUARE.height * coverScale, 9);
  });

  it('9:16 四格：方形资产 → 504×504 居中（竖向页背景带，不再横向裁切）', () => {
    const grid = computePageLayouts(makeProject({ arrangement: 'grid_4', canvasRatio: '9:16', panelCount: 4 }))[0]!;
    const gridSlot = grid.slots[0]!;
    expect(gridSlot.width).toBe(504);
    expect(gridSlot.height).toBe(924);
    const rect = computePanelImageRect(SQUARE, gridSlot);
    expect(rect.width).toBeCloseTo(504, 9);
    expect(rect.height).toBeCloseTo(504, 9);
    expect(rect.y).toBeCloseTo(234, 9);
    expectContainFit(SQUARE, gridSlot, rect);
  });

  it('multi_page 3:4：方形资产入整页槽 1032×1392 → 1032×1032 居中', () => {
    const page = computePageLayouts(makeProject({ arrangement: 'multi_page', canvasRatio: '3:4', panelCount: 1 }))[0]!;
    const pageSlot = page.slots[0]!;
    expect(pageSlot.width).toBe(1032);
    expect(pageSlot.height).toBe(1392);
    const rect = computePanelImageRect(SQUARE, pageSlot);
    expect(rect.width).toBeCloseTo(1032, 9);
    expect(rect.height).toBeCloseTo(1032, 9);
    expect(rect.y).toBeCloseTo(204, 9); // 24 + (1392-1032)/2
    expectContainFit(SQUARE, pageSlot, rect);
  });

  it('横版资产 1792×1024 入 vertical_2 槽 → 1032 宽完整保留（竖向带）', () => {
    const rect = computePanelImageRect(LANDSCAPE, slot);
    expect(rect.width).toBeCloseTo(1032, 9);
    expect(rect.height).toBeCloseTo((1024 * 1032) / 1792, 9);
    expect(rect.y).toBeCloseTo(24 + (684 - (1024 * 1032) / 1792) / 2, 9);
    expectContainFit(LANDSCAPE, slot, rect);
  });

  it('任意比例资产 × 任意槽位组合都满足 fit-safe 不变式（含极端 21:9 与 9:21）', () => {
    const assets = [
      { width: 1024, height: 1024 },
      { width: 1792, height: 1024 },
      { width: 1024, height: 1792 },
      { width: 2100, height: 900 },
      { width: 900, height: 2100 },
      { width: 300, height: 300 },
    ];
    const slots: ComicSheetSlot[] = [slot,
      { panelId: 'x', x: 0, y: 0, width: 504, height: 924 },
      { panelId: 'x', x: 100, y: 100, width: 1032, height: 1368 },
      { panelId: 'x', x: 0, y: 0, width: 800, height: 200 }];
    for (const asset of assets) {
      for (const target of slots) {
        expectContainFit(asset, target, computePanelImageRect(asset, target));
      }
    }
  });
});

describe('Editor / Preview / Export 同源 parity（WYSIWYG）', () => {
  const project = makeProject({ arrangement: 'vertical_2', canvasRatio: '3:4', background: '#f3efe7', panelCount: 2 });

  it('编辑器 figure：内联 aspect-ratio = computePageLayouts 槽位比 + background = 页背景', () => {
    const markup = renderToStaticMarkup(createElement(ComicTextStage, {
      project,
      onDialogueChange: () => {},
      onDialogueRemove: () => {},
      onDialogueMoveZ: () => {},
      onOpenAiDirector: () => {},
      onExport: () => {},
      exporting: false,
    }));
    const slot = computePageLayouts(project)[0]!.slots[0]!;
    expect(markup).toContain(`aspect-ratio:${slot.width / slot.height}`);
    expect(markup).toContain('background:#f3efe7');
    expect(markup).toContain('comic-editor-figure');
  });

  it('CSS 与导出同策略：编辑器底图 object-fit:contain ↔ computePanelImageRect（min-scale 居中）', () => {
    expect(studioCss).toMatch(/\.comic-editor-figure > img\s*\{[^}]*object-fit: contain/s);
    expect(studioCss).not.toMatch(/\.comic-editor-figure > img\s*\{[^}]*object-fit: cover/s);
    expect(exportSource).toContain('const scale = Math.min(slot.width / image.width, slot.height / image.height)');
    expect(exportSource).toContain('const rect = computePanelImageRect(image, slot);');
    expect(stageSource).toContain('figureBackground = project.skillSnapshot.exportDefaults.background');
  });

  it('渲染链单一：预览与导出共用 renderComicSheets（无第二套几何实现）', () => {
    expect(previewSource).toContain('renderComicSheets');
    expect(previewSource).not.toContain('drawCover');
    expect(exportSource).not.toContain('function drawCover');
  });
});

describe('对白坐标契约不变（docs/ai-comic/28 §1：0..1 相对槽位矩形）', () => {
  it('导出 drawDialogue 仍以 slot 为 Panel Content Rect（fit-safe 只改底图入槽，不迁移文字层）', () => {
    expect(exportSource).toContain('calculateDialogueLayout(');
    expect(exportSource).toContain('{ width: slot.width, height: slot.height }');
    expect(exportSource).toContain('slot.x + layout.box.x');
    expect(exportSource).toContain('slot.y + layout.box.y');
  });
});
