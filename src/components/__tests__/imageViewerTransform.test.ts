import { describe, it, expect } from 'vitest';
import { applyZoom, clampScale, MIN_SCALE, MAX_SCALE } from '../imageViewerTransform';

/**
 * ImageViewer 缩放数学契约：
 * - 倍率钳制 [10%, 800%]，命中上下限时视图不变；
 * - 中心缩放：偏移按比例缩放（视口中心内容点不动）；
 * - 鼠标锚点缩放：锚点处的图片内容点缩放后保持在锚点位置。
 */

describe('clampScale', () => {
  it('钳制到 [0.1, 8]', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(1)).toBe(1);
  });
});

describe('applyZoom 中心缩放', () => {
  it('偏移按比例缩放：居中（offset 0）缩放后仍居中', () => {
    const next = applyZoom({ scale: 1, x: 0, y: 0 }, 1.2);
    expect(next.scale).toBeCloseTo(1.2);
    expect(next.x).toBe(0);
    expect(next.y).toBe(0);
  });

  it('已平移视图中心缩放：偏移同比缩放（视觉中心点不动）', () => {
    const next = applyZoom({ scale: 2, x: 100, y: -50 }, 1.5);
    expect(next.scale).toBe(3);
    expect(next.x).toBe(150);
    expect(next.y).toBe(-75);
  });
});

describe('applyZoom 鼠标锚点缩放', () => {
  it('锚点内容点缩放后保持在锚点位置', () => {
    const anchor = { x: 120, y: 60 };
    const before = { scale: 1, x: 0, y: 0 };
    const after = applyZoom(before, 2, anchor);
    expect(after.scale).toBe(2);
    // offset 0 / scale 1 → 2：x = anchor - anchor*2 = -anchor（图片向锚点反方向平移）
    expect(after.x).toBe(-anchor.x);
    expect(after.y).toBe(-anchor.y);
    // 反向验证：锚点处内容点 p = (anchor - offset)/scale 在缩放前后一致
    const pBefore = { x: (anchor.x - before.x) / before.scale, y: (anchor.y - before.y) / before.scale };
    const pAfter = { x: (anchor.x - after.x) / after.scale, y: (anchor.y - after.y) / after.scale };
    expect(pAfter.x).toBeCloseTo(pBefore.x);
    expect(pAfter.y).toBeCloseTo(pBefore.y);
  });

  it('已平移视图同样满足锚点不变式', () => {
    const before = { scale: 2, x: 40, y: -20 };
    const anchor = { x: -60, y: 30 };
    const after = applyZoom(before, 1.25, anchor);
    const pBefore = { x: (anchor.x - before.x) / before.scale, y: (anchor.y - before.y) / before.scale };
    const pAfter = { x: (anchor.x - after.x) / after.scale, y: (anchor.y - after.y) / after.scale };
    expect(after.scale).toBe(2.5);
    expect(pAfter.x).toBeCloseTo(pBefore.x);
    expect(pAfter.y).toBeCloseTo(pBefore.y);
  });

  it('命中上下限时视图整体不变（offset 也不动）', () => {
    const min = applyZoom({ scale: MIN_SCALE, x: 33, y: -7 }, 0.5, { x: 10, y: 10 });
    expect(min).toEqual({ scale: MIN_SCALE, x: 33, y: -7 });
    const max = applyZoom({ scale: MAX_SCALE, x: 5, y: 6 }, 2, { x: -3, y: 4 });
    expect(max).toEqual({ scale: MAX_SCALE, x: 5, y: 6 });
  });
});
