import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * 视觉工作台 Adaptive Workbench Layout 源码契约（V4.1 §39）：
 *  - ≥1600：双栏 grid（主工作区 + Context Rail 340–390px），宽 min(100%,1520px)
 *  - 1440–1599：双栏收窄（rail 320px / gap 20 / 宽 calc(100% - 40px)）
 *  - 1280–1439：<1440 断点切单列（rail 转摘要卡，无 sticky 双滚动）
 *  - <1280：全部单列（继承 <1439 规则）
 *  - 禁止旧窄容器（max-width: 960px）回归
 * 1280 / 1440 / 1920 / 2560 四档被 1439 / 1599 两条媒体查询完整覆盖。
 */

const pageSrc = readFileSync(resolve(__dirname, '../VisionUnderstanding.tsx'), 'utf-8');
const css = readFileSync(resolve(__dirname, '../VisionUnderstanding.css'), 'utf-8');

function blockOf(marker: string, endMarker: string): string {
  const start = css.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf(endMarker, start);
  return css.slice(start, end);
}

describe('workbenchDesktopUsesContextRail（≥1600 双栏）', () => {
  test('.vision-workbench 双栏 grid：主列 1fr + rail 340–390px，宽 min(100%,1520px)', () => {
    const block = blockOf('.vision-workbench {', '\n}');
    expect(block).toContain('grid-template-columns: minmax(0, 1fr) minmax(340px, 390px)');
    expect(block).toContain('width: min(100%, 1520px)');
    expect(block).toContain('margin-inline: auto');
  });

  test('Context Rail sticky + 内部滚动（页面不出现双滚动）', () => {
    const rail = blockOf('.vision-rail {', '\n}');
    expect(rail).toContain('position: sticky');
    expect(rail).toContain('top: 20px');
    expect(rail).toContain('max-height: calc(100vh - 40px)');
    expect(rail).toContain('overflow-y: auto');
  });

  test('页面渲染 vision-main + vision-rail（ContextRail 组件接入）', () => {
    expect(pageSrc).toContain('className="vision-main"');
    expect(pageSrc).toContain('<ContextRail');
    expect(pageSrc).toMatch(/className="vision-workbench"/);
  });
});

describe('1440–1599 收窄档', () => {
  test('媒体查询存在：rail 320px / gap 20 / 宽 calc(100% - 40px)', () => {
    const block = blockOf('@media (max-width: 1599px) and (min-width: 1440px)', '\n}\n\n@media (max-width: 1439px)');
    expect(block).toContain('grid-template-columns: minmax(0, 1fr) 320px');
    expect(block).toContain('width: calc(100% - 40px)');
    expect(block).toContain('gap: 20px');
  });
});

describe('workbenchNarrowUsesSingleColumn（<1440 单列；1280 档不横向溢出）', () => {
  test('@media max-width 1439：单列 + rail 转 static 摘要卡', () => {
    const block = blockOf('@media (max-width: 1439px)', '\n}\n\n/* ===== Visual Project Header');
    expect(block).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(block).toContain('position: static');
    expect(block).toContain('max-height: none');
  });

  test('主列 minmax(0, 1fr)（可压缩；1280 不挤爆、不横向溢出）', () => {
    expect(css).toContain('minmax(0, 1fr)');
    expect(css).toMatch(/\.vision-main\s*{[^}]*min-width:\s*0/);
  });
});

describe('禁止窄容器回归（Creative Workflow ≠ Narrow Layout）', () => {
  test('旧 max-width: 960px 已删除；.vision-page 不限宽', () => {
    expect(css).not.toContain('max-width: 960px');
    const page = blockOf('.vision-page {', '\n}');
    expect(page).toContain('max-width: none');
  });
});

describe('CTA 唯一渲染处（项目化 = Context Rail；非项目 = 主卡兜底）', () => {
  test('主操作行仅在无项目时渲染完整 CTA（ternary 守卫）；Rail 持有 onGenerate', () => {
    expect(pageSrc).toContain('{activeProject ? (');
    expect(pageSrc).toContain('onGenerate={openGenerateConfirm}');
    // 页面 JSX 中「确认生成图片」按钮文本只出现在主卡 legacy 分支（Rail 内的是组件内部）
    const buttonOccurrences = (pageSrc.match(/>\s*确认生成图片\s*</g) || []).length;
    expect(buttonOccurrences).toBe(1);
  });
});

describe('区域编辑器全宽工作模式（§28：不塞 600px Modal）', () => {
  test('.vision-region-editor 全屏 fixed；区域面板接入页面（画布由面板内部承载）', () => {
    const editor = blockOf('.vision-region-editor {', '\n}');
    expect(editor).toContain('position: fixed');
    expect(pageSrc).toContain('RegionEditorPanel');
    expect(pageSrc).toContain('onRegionsChange={onRegionsChange}');
  });
});
