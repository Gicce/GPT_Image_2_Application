import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * ImageViewer 交互守卫（源码文本断言，项目内无 DOM 测试环境）：
 * - 遮罩（overlay）点击关闭；顶栏 / 工具栏 / 详情面板 stopPropagation 不触发关闭；
 * - 滚轮缩放只绑定图片视口（viewport），非 passive + preventDefault；
 * - 禁止 window / document 级 wheel 缩放监听；
 * - 键盘监听仅在 Viewer 打开期间存在，关闭即解绑（removeEventListener cleanup）；
 * - 缩放以鼠标位置为锚点（applyZoom anchor）；放大后拖拽平移（grab / grabbing）。
 */

const src = readFileSync(resolve(__dirname, '../ImageViewer.tsx'), 'utf-8');
const css = readFileSync(resolve(__dirname, '../ImageViewer.css'), 'utf-8');

describe('Backdrop 关闭（标准 Lightbox 交互）', () => {
  test('overlay onClick 直接 close：点击灰色背景可关闭', () => {
    expect(src).toMatch(/aria-label="图片查看器"[\s\S]{0,120}onClick=\{close\}/);
  });

  test('顶栏 / 工具栏 / 详情面板 stopPropagation：点击控件不误关', () => {
    expect(src).toContain('const stopClick = (e: React.MouseEvent) => { e.stopPropagation(); };');
    expect(src.match(/onClick=\{stopClick\}/g)?.length).toBeGreaterThanOrEqual(3);
  });

  test('视口内点击图片本体不关闭；点图片外暗区冒泡到遮罩关闭', () => {
    expect(src).toContain('onViewportClick');
    expect(src).toMatch(/const onViewportClick[\s\S]*?stopPropagation[\s\S]*?stopPropagation/s);
  });

  test('视口不吞掉整屏点击：CSS 有界（非 inset:0 全屏层）', () => {
    const viewportCss = css.slice(css.indexOf('.image-viewer-viewport {'), css.indexOf('.image-viewer-viewport.has-detail'));
    expect(viewportCss).not.toContain('inset: 0');
    expect(viewportCss).toMatch(/top:\s*52px/);
    expect(viewportCss).toMatch(/left:\s*20px/);
    // 遮罩本体存在且铺满（真正可点击的 backdrop）
    expect(css).toMatch(/\.image-viewer-overlay\s*{[^}]*position:\s*fixed[^}]*inset:\s*0/s);
  });

  test('Esc / × 关闭（键盘 handler 含 Escape → close）', () => {
    expect(src).toMatch(/e\.key === 'Escape'[\s\S]{0,80}close\(\)/);
    expect(src).toContain('image-viewer-close');
  });
});

describe('Wheel Zoom 作用域（只在图片视口内缩放）', () => {
  test('wheel listener 绑定 viewport 元素，非 passive + preventDefault', () => {
    expect(src).toMatch(/viewport\.addEventListener\('wheel', onWheel, \{ passive: false \}\)/);
    const handler = src.slice(src.indexOf('const onWheel'), src.indexOf('viewport.addEventListener'));
    expect(handler).toContain('e.preventDefault()');
  });

  test('禁止 window / document 级 wheel 缩放（其它区域滚轮正常滚动）', () => {
    expect(src).not.toMatch(/window\.addEventListener\('wheel'/);
    expect(src).not.toMatch(/document\.addEventListener\('wheel'/);
  });

  test('滚轮缩放以鼠标位置为锚点（clientX/Y → 视口中心相对坐标）', () => {
    const handler = src.slice(src.indexOf('const onWheel'), src.indexOf("viewport.addEventListener('wheel'"));
    expect(handler).toMatch(/e\.clientX - \(rect\.left \+ rect\.width \/ 2\)/);
    expect(handler).toMatch(/e\.clientY - \(rect\.top \+ rect\.height \/ 2\)/);
  });

  test('wheel / keyboard listener 均有 cleanup（Viewer 关闭即解绑）', () => {
    expect(src).toMatch(/viewport\.removeEventListener\('wheel', onWheel\)/);
    expect(src).toMatch(/window\.removeEventListener\('keydown', onKey, true\)/);
    expect(src).toMatch(/window\.removeEventListener\('mousemove', onMove\)/);
    expect(src).toMatch(/window\.removeEventListener\('mouseup', onUp\)/);
  });
});

describe('Pan（放大后拖拽平移）', () => {
  test('grab / grabbing cursor 由 is-pannable 控制', () => {
    expect(src).toContain('is-pannable');
    expect(css).toMatch(/\.image-viewer-viewport\.is-pannable\s*{[^}]*cursor:\s*grab/s);
    expect(css).toMatch(/\.image-viewer-viewport\.is-pannable:active\s*{[^}]*cursor:\s*grabbing/s);
  });

  test('拖拽后松开的 click 不触发遮罩关闭（DRAG_CLICK_TOLERANCE）', () => {
    expect(src).toContain('dragMovedRef');
    expect(src).toContain('DRAG_CLICK_TOLERANCE');
  });
});

describe('缩放数学与倍率钳制', () => {
  test('缩放走统一纯函数 applyZoom（含锚点重载）', () => {
    expect(src).toContain("from './imageViewerTransform'");
    expect(src).toMatch(/applyZoom\(prev, factor, anchor\)/);
  });
});
