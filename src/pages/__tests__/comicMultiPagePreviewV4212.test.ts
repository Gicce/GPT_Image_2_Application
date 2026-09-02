/**
 * 多页 Preview 统一测试（V4.2.12 §64~§68）——所有形式统一 ComicFormPreviewMini：
 *  - 多页 = 堆叠页 +「+N 页」角标（一眼可读这是多页，不是九宫格）；
 *  - preview 内不渲染「第 N 页」文字标签（页数细节由卡正文承载，杜绝重叠错位）；
 *  - 多页卡 meta =「N 页 · 每页 1 张 · 共 N 张成品图」；单页卡 =「格」；
 *  - Rail / 选择卡 / 推荐卡全部消费同一 Mini 画布（无第二套预览实现）；
 *  - computePageLayouts 多页项目逐页一槽，槽序 = 分镜 order。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ComicFormPreviewMini from '../../features/comic/components/ComicFormPreviewMini';
import { comicPresentationTemplateOf, comicPresentationTemplateShortLabel, resolveComicPresentation } from '../../features/comic/presentation';
import { computePageLayouts } from '../../features/comic/comicExport';
import { normalizeComicPanel, normalizeComicProject, normalizeComicSkill } from '../../features/comic/normalize';

const read = (path: string): string =>
  readFileSync(resolve(__dirname, path), 'utf-8').replace(/\r\n/g, '\n');

const skillStage = read('../../features/comic/components/ComicSkillStage.tsx');
const comicStudio = read('../ComicStudio.tsx');

function skillWithLayout(arrangement: 'multi_page' | 'grid_4', panelCount: number, pageCount?: number) {
  return normalizeComicSkill({
    name: '形式技能',
    visualStyle: '萌系简笔',
    layout: { panelCount, arrangement, ...(pageCount ? { pageCount } : {}) },
    exportDefaults: { canvasRatio: '1:1', background: '#ffffff' },
    characterSlots: [{ slotId: 'hero', name: '主角', required: true }],
  });
}

describe('Presentation 几何（多页 vs 单页）', () => {
  it('multi_page：4 页每页 1 张，页格序 = 分镜 order', () => {
    const presentation = resolveComicPresentation(skillWithLayout('multi_page', 4, 4), { totalPanels: 4 });
    expect(presentation.outputMode).toBe('multi_page');
    expect(presentation.pageCount).toBe(4);
    expect(presentation.panelsPerPage).toBe(1);
    expect(presentation.pages.map(page => page.panelOrders)).toEqual([[0], [1], [2], [3]]);
  });

  it('模板短说明：多页 =「4 页 · 每页 1 张」；四宫格 =「1 页 · 4 格」', () => {
    const multiPage = comicPresentationTemplateOf('multi_page')!;
    const grid4 = comicPresentationTemplateOf('grid_4')!;
    expect(comicPresentationTemplateShortLabel(multiPage)).toBe('4 页 · 每页 1 张');
    expect(comicPresentationTemplateShortLabel(grid4)).toBe('1 页 · 4 格');
  });
});

describe('§65 ComicFormPreviewMini 渲染（唯一 Mini 画布）', () => {
  function renderPreview(arrangement: 'multi_page' | 'grid_4', totalPanels: number, pageCount?: number): string {
    const presentation = resolveComicPresentation(skillWithLayout(arrangement, totalPanels, pageCount), { totalPanels });
    return renderToStaticMarkup(createElement(ComicFormPreviewMini, { presentation }));
  }

  it('多页：堆叠两页 +「+3 页」角标；不渲染「第 N 页」文字标签', () => {
    const markup = renderPreview('multi_page', 4, 4);
    expect(markup).toContain('comic-form-preview-mini is-multi');
    expect(markup).toContain('comic-form-preview-page is-back');
    expect(markup).toContain('+3 页');
    expect(markup).toContain('aria-label="多页连载示意：4 页 · 每页 1 张"');
    // §66：页码标签是重叠错位的根因，preview 内一律没有
    expect(markup.includes('第 1 页')).toBe(false);
    expect(markup.includes('第 2 页')).toBe(false);
  });

  it('单页四宫格：一页框 + 4 格（1..4），格列 = columns', () => {
    const markup = renderPreview('grid_4', 4);
    expect(markup).toContain('comic-form-preview-mini');
    expect(markup).toContain('grid-template-columns:repeat(2, 1fr)');
    expect(markup).toContain('aria-label="四宫格示意：1 页 · 4 格"');
    for (const index of [1, 2, 3, 4]) {
      expect(markup).toContain(`<span class="comic-form-preview-cell">${index}</span>`);
    }
    expect(markup.includes('+')).toBe(false); // 单页没有「+N 页」角标
  });

  it('多页 1 页（pageCount=1）回落单页形态（无堆叠角标）', () => {
    const markup = renderPreview('multi_page', 1, 1);
    expect(markup.includes('is-multi')).toBe(false);
    expect(markup.includes('+')).toBe(false);
  });
});

describe('§67 卡面 meta 与接线（统一 Mini，无第二套预览）', () => {
  it('技能阶段卡：多页 = 张成品图；单页 = 格；正文不走页码标签', () => {
    expect(skillStage).toContain('<ComicFormPreviewMini presentation={preview} />');
    expect(skillStage).toContain('${preview.pageCount} 页 · 每页 ${preview.panelsPerPage} 张 · 共 ${preview.totalPanels} 张成品图');
    expect(skillStage).toContain('${preview.pageCount} 页 · 每页 ${preview.panelsPerPage} 格 · 共 ${preview.totalPanels} 格');
    expect(skillStage.includes('<ComicLayoutPreview')).toBe(false);
  });

  it('Rail 缩略图 = 同一 Mini 画布（resolveComicPresentation 单点派生）', () => {
    expect(comicStudio).toContain("<ComicFormPreviewMini presentation={resolveComicPresentation(active.skillSnapshot)} />");
    expect(comicStudio.includes('<ComicLayoutPreview')).toBe(false);
  });
});

describe('§68 Composer 多页布局（页序 = 格序）', () => {
  it('computePageLayouts：多页项目 4 页各 1 槽，槽 panelId 按 order 逐页', () => {
    const skill = skillWithLayout('multi_page', 4, 4);
    const panels = [0, 1, 2, 3].map(order => normalizeComicPanel({
      id: `panel-${order}`, order, scene: `场景 ${order + 1}`,
      generationStatus: 'completed',
      imageAsset: { path: `D:/lib/p${order}.png`, imageId: `img-${order}`, taskId: 't' },
    })!);
    const project = normalizeComicProject({
      id: 'p-multi', name: '多页第一期', stage: 'editing',
      skillSnapshot: skill, characterSnapshots: [], characterBindings: {},
      panels, dialogues: [],
    })!;
    const layouts = computePageLayouts(project);
    expect(layouts).toHaveLength(4);
    expect(layouts.every(layout => layout.slots.length === 1)).toBe(true);
    expect(layouts.map(layout => layout.slots[0]!.panelId)).toEqual(['panel-0', 'panel-1', 'panel-2', 'panel-3']);
  });
});
