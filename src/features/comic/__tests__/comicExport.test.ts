/**
 * 整页合成布局测试（Phase 11；Phase 1.2 §47 升级 Presentation 驱动多页）：
 *  - computePageLayouts：resolveComicPresentation.pages × canvasRatio → 每页槽位矩形
 *    （四格 2×2 / 九格 3×3 / 竖排单列 / 多页每页一张；像素只存在于合成边界）；
 *  - 与选择卡 / Rail / 分镜预览几何同源（§89 单点计算）；
 *  - stale 分镜排除在整页之外；
 *  - computeSheetLayout（兼容）= 首页；renderComicSheet 无 DOM 守卫返回 null。
 */

import { describe, it, expect } from 'vitest';
import { computePageLayouts, computeSheetLayout, renderComicSheet } from '../comicExport';
import { normalizeComicPanel, normalizeComicProject, normalizeComicSkill } from '../normalize';
import type { ComicProject } from '../types';

function makeProject(options: {
  arrangement?: string;
  canvasRatio?: '1:1' | '3:4' | '9:16';
  background?: string;
  panelCount?: number;
  staleIndexes?: number[];
} = {}): ComicProject {
  const skill = normalizeComicSkill({
    name: '布局测试',
    comicForm: '多格漫画',
    visualStyle: '简笔',
    layout: options.arrangement ? { panelCount: options.panelCount ?? 4, arrangement: options.arrangement } : undefined,
    exportDefaults: {
      canvasRatio: options.canvasRatio,
      background: options.background,
    } as never,
    characterSlots: [],
  });
  const panelCount = options.panelCount ?? 4;
  const panels = Array.from({ length: panelCount }, (_, index) => normalizeComicPanel({
    id: `panel-${index}`,
    order: index,
    scene: `场景${index}`,
    characterIds: [],
    shotType: '全景',
    camera: '平视',
    composition: '居中',
    characterActions: ['a'],
    background: '白墙',
    stale: options.staleIndexes?.includes(index) ?? undefined,
    imageAsset: { path: `/comic/p${index}.png`, imageId: `img-${index}`, taskId: `task-${index}` },
  })!);
  return normalizeComicProject({
    id: 'p1',
    name: '第一期',
    stage: 'editing',
    skillSnapshot: skill,
    characterSnapshots: [],
    characterBindings: {},
    story: {
      title: 't', topic: 't', summary: 's', characterIds: [],
      beats: ['a'], endingType: 'twist', panelCount,
    },
    panels,
    dialogues: [],
  })!;
}

describe('computePageLayouts：画布尺寸', () => {
  it('1:1 → 1080×1080；9:16 → 1080×1920；缺省 3:4 → 1080×1440', () => {
    expect(computePageLayouts(makeProject({ canvasRatio: '1:1', arrangement: 'grid_4' }))[0]!.height).toBe(1080);
    expect(computePageLayouts(makeProject({ canvasRatio: '9:16', arrangement: 'grid_4' }))[0]!.height).toBe(1920);
    expect(computePageLayouts(makeProject({ arrangement: 'grid_4' }))[0]!.height).toBe(1440);
    expect(computePageLayouts(makeProject({ arrangement: 'grid_4' }))[0]!.width).toBe(1080);
  });

  it('背景来自 Skill exportDefaults，空值回落白底', () => {
    expect(computePageLayouts(makeProject({ background: '#f3efe7', arrangement: 'grid_4' }))[0]!.background).toBe('#f3efe7');
    expect(computePageLayouts(makeProject({ background: '   ', arrangement: 'grid_4' }))[0]!.background).toBe('#ffffff');
  });
});

describe('computePageLayouts：Presentation 分页（§47 与预览同源）', () => {
  it('single / 单面板 → 1 页 1×1 满幅', () => {
    const pages = computePageLayouts(makeProject({ arrangement: 'single', panelCount: 1 }));
    expect(pages).toHaveLength(1);
    const layout = pages[0]!;
    expect(layout.slots).toHaveLength(1);
    const slot = layout.slots[0]!;
    expect(slot.width).toBe(layout.width - layout.gap * 2);
    expect(slot.height).toBe(layout.height - layout.gap * 2);
  });

  it('vertical_2 → 单页单列两行', () => {
    const layout = computePageLayouts(makeProject({ arrangement: 'vertical_2', panelCount: 2 }))[0]!;
    expect(layout.slots).toHaveLength(2);
    const [first, second] = layout.slots;
    expect(first!.x).toBe(second!.x);
    expect(second!.y).toBeGreaterThan(first!.y);
    expect(first!.width).toBeCloseTo(layout.width - layout.gap * 2);
  });

  it('vertical_3 → 单页单列三行（不再走 sqrt 网格）', () => {
    const pages = computePageLayouts(makeProject({ arrangement: 'vertical_3', panelCount: 3 }));
    expect(pages).toHaveLength(1);
    const layout = pages[0]!;
    expect(layout.slots).toHaveLength(3);
    expect(layout.slots[1]!.x).toBe(layout.slots[0]!.x);
    expect(layout.slots[2]!.y).toBeGreaterThan(layout.slots[1]!.y);
  });

  it('grid_4：4 格一页 2×2；6 格按模板容量分两页 4+2（不硬塞三列）', () => {
    const four = computePageLayouts(makeProject({ arrangement: 'grid_4', panelCount: 4 }));
    expect(four).toHaveLength(1);
    expect(four[0]!.slots[0]!.y).toBe(four[0]!.slots[1]!.y);
    expect(four[0]!.slots[2]!.y).toBeGreaterThan(four[0]!.slots[0]!.y);

    const six = computePageLayouts(makeProject({ arrangement: 'grid_4', panelCount: 6 }));
    expect(six).toHaveLength(2);
    expect(six[0]!.slots).toHaveLength(4);
    expect(six[1]!.slots.map(slot => slot.panelId)).toEqual(['panel-4', 'panel-5']);
  });

  it('grid_9：9 格一页 3×3', () => {
    const pages = computePageLayouts(makeProject({ arrangement: 'grid_9', panelCount: 9 }));
    expect(pages).toHaveLength(1);
    const layout = pages[0]!;
    expect(layout.slots).toHaveLength(9);
    // 3 列：slot 0/1/2 同排，slot 3 换行
    expect(layout.slots[2]!.y).toBe(layout.slots[0]!.y);
    expect(layout.slots[3]!.y).toBeGreaterThan(layout.slots[0]!.y);
    expect(layout.slots[1]!.x).toBeGreaterThan(layout.slots[0]!.x);
  });

  it('multi_page：每页一张整图（page carousel 的数据面）', () => {
    const pages = computePageLayouts(makeProject({ arrangement: 'multi_page', panelCount: 3 }));
    expect(pages).toHaveLength(3);
    pages.forEach((layout, index) => {
      expect(layout.slots).toHaveLength(1);
      expect(layout.slots[0]!.panelId).toBe(`panel-${index}`);
      expect(layout.slots[0]!.width).toBe(layout.width - layout.gap * 2);
    });
  });

  it('custom → 近似方形网格（5 格 → 3 列 2 行，单页）', () => {
    const pages = computePageLayouts(makeProject({ arrangement: 'custom', panelCount: 5 }));
    expect(pages).toHaveLength(1);
    const layout = pages[0]!;
    expect(layout.slots).toHaveLength(5);
    expect(layout.slots[2]!.y).toBe(layout.slots[0]!.y);
    expect(layout.slots[3]!.y).toBeGreaterThan(layout.slots[0]!.y);
  });

  it('槽位按分镜顺序落位，且全部落在画布内', () => {
    const layout = computePageLayouts(makeProject({ arrangement: 'grid_4', panelCount: 4 }))[0]!;
    layout.slots.forEach((slot, index) => {
      expect(slot.panelId).toBe(`panel-${index}`);
      expect(slot.x).toBeGreaterThanOrEqual(layout.gap);
      expect(slot.y).toBeGreaterThanOrEqual(layout.gap);
      expect(slot.x + slot.width).toBeLessThanOrEqual(layout.width);
      expect(slot.y + slot.height).toBeLessThanOrEqual(layout.height);
    });
  });

  it('stale 分镜不进整页（旧图保留在项目里但不导出）', () => {
    const layout = computePageLayouts(makeProject({ arrangement: 'grid_4', panelCount: 4, staleIndexes: [3] }))[0]!;
    expect(layout.slots.map(slot => slot.panelId)).toEqual(['panel-0', 'panel-1', 'panel-2']);
  });
});

describe('computeSheetLayout 兼容（= 首页）', () => {
  it('返回第一页；无分镜返回 null', () => {
    const project = makeProject({ arrangement: 'grid_4', panelCount: 4 });
    expect(computeSheetLayout(project)).toEqual(computePageLayouts(project)[0]!);
    expect(computeSheetLayout({ ...project, panels: [] })).toBeNull();
  });
});

describe('renderComicSheet 守卫', () => {
  it('无 DOM 环境（node）返回 null 而不是抛异常', async () => {
    const canvas = await renderComicSheet(makeProject({ arrangement: 'grid_4' }), async () => null);
    expect(canvas).toBeNull();
  });
});
