/**
 * V6.1 Skill Creator Wizard Geometry 守卫（源码文本断言）：
 * 五步共用同一固定几何，宽高只随视口；步骤差异由正文内部滚动消化。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const src = readFileSync(resolve(__dirname, '../SkillCreatorDialog.tsx'), 'utf-8');
const css = readFileSync(resolve(__dirname, '../SkillCreatorDialog.css'), 'utf-8');

describe('Skill Creator 布局几何（V6.1）', () => {
  test('skillCreatorUsesStableHeaderBodyFooter：Header/Body/Footer 三段结构固定', () => {
    expect(src).toContain('className="skill-creator-header"');
    expect(src).toContain('className="skill-creator-body"');
    expect(src).toContain('className="skill-creator-footer"');
    // 三段都由弹窗/主区 grid 行承担，不随内容伸缩
    expect(css).toMatch(/\.skill-creator-dialog\s*{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/s);
    expect(css).toMatch(/\.skill-creator-main\s*{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/s);
    expect(css).toMatch(/\.skill-creator-footer\s*{[^}]*border-top/s);
  });

  test('skillCreatorBodyIsScrollable：正文 overflow-y:auto + min-height:0 + overscroll contain', () => {
    expect(css).toMatch(/\.skill-creator-body\s*{[^}]*overflow-y:\s*auto[^}]*min-height:\s*0/s);
    expect(css).toMatch(/\.skill-creator-body\s*{[^}]*overscroll-behavior:\s*contain/s);
    // 弹窗自身不滚动（overflow:hidden），滚动收在正文
    expect(css).toMatch(/\.skill-creator-dialog\s*{[^}]*overflow:\s*hidden/s);
  });

  test('stepContentDoesNotResizeModalGeometry：步骤切换不改弹窗几何类，尺寸只由 CSS 常量决定', () => {
    // 步骤内容不往弹窗根上挂条件宽度/高度类（唯一条件类是 picker-open 滚动锁）
    expect(src.match(/skill-creator-dialog\$\{[^}]*\}/g)).toEqual([`skill-creator-dialog\${galleryOpen ? ' is-picker-open' : ''}`]);
    expect(css).toMatch(/\.skill-creator-dialog\s*{[^}]*width:\s*min\(960px,\s*calc\(100vw - 48px\)\)/s);
    expect(css).toMatch(/\.skill-creator-dialog\s*{[^}]*height:\s*min\(720px,\s*calc\(100vh - 48px\)\)/s);
    // picker 打开只锁滚动，不改几何
    expect(css).toMatch(/\.skill-creator-dialog\.is-picker-open \.skill-creator-body \{ overflow: hidden; \}/);
    // 窄宽度退化：≤860px 步骤栏转水平 stepper，弹窗几何仍固定占满
    expect(css).toMatch(/@media \(max-width: 860px\)/);
    expect(css).toMatch(/\.skill-creator-steps\s*\{\s*flex-direction:\s*row/);
  });

  test('recipeSummaryCollapsesLongDetails：Recipe 卡默认摘要，完整合同折叠在展开区', () => {
    expect(src).toContain('模板复用方案');
    expect(src).toContain('Recipe 已冻结');
    expect(src).toContain("useState(false)");
    expect(src).toMatch(/aria-expanded=\{recipeExpanded\}/);
    expect(src).toContain("recipeExpanded ? '收起完整 Recipe' : '查看完整 Recipe'");
    expect(src).toMatch(/\{recipeExpanded && \(\s*<div className="skill-recipe-detail"/);
    // 保存发布页 content stack：卡片化，不拉大控件填满
    expect(src).toContain('skill-publish-card');
    expect(src).toContain('skill-publish-status');
  });
});
