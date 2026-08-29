import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const pageDir = resolve(__dirname, '..');
const tsx = readFileSync(resolve(pageDir, 'SkillWorkshop.tsx'), 'utf8');
const css = readFileSync(resolve(pageDir, 'SkillWorkshop.css'), 'utf8');

describe('技能工坊 UI 契约', () => {
  test('向导/专业模式复用公共分段选择器', () => {
    expect(tsx).toContain('className="app-segmented"');
    expect(tsx).toContain('app-segmented-btn');
    expect(tsx).not.toContain('skill-mode-switch');
  });

  test('所有语义操作按钮同时包含公共按钮尺寸基类', () => {
    expect(tsx).not.toMatch(/className="app-btn-(?:primary|secondary|danger)(?:\s|\")/);
    expect(tsx).toContain('app-btn app-btn-primary');
    expect(tsx).toContain('app-btn app-btn-secondary');
  });

  test('页面 CSS 只使用语义颜色 Token，不新增随机颜色', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
  });

  test('目录、步骤和本地项目有稳定高度及键盘焦点', () => {
    expect(css).toContain('min-height: 52px');
    expect(css).toContain('min-height: 40px');
    expect(css).toContain('min-height: 32px');
    expect(css).toContain(':focus-visible');
  });

  test('目录多方向点选（ADR-028）：ready 条目可点选切换技能包，非 ready 保持禁用', () => {
    expect(tsx).toContain("disabled={item.readiness !== 'ready'}");
    expect(tsx).toContain('void selectCatalogSkill(item)');
    // 项目与文案由包驱动，不再写死桌搭
    expect(tsx).toContain('createProject(settings, nextPackage)');
    expect(tsx).not.toContain('<span>专业桌搭</span>');
    expect(tsx).not.toContain('<h3>Business Walnut</h3>');
  });
});
