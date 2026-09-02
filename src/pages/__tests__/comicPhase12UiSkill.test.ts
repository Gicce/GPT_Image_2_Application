import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * AI 漫画 Phase 1.2-I UI Skill 收口守卫（审计 2.8 / 2.9 / R11）。
 *
 * 锁定的规范：
 * - 弹窗家族（overlay / dialog / header / body / footer）抽离到
 *   features/comic/components/ComicDialog.css，四个弹窗组件各自 import；
 *   ComicStudio.css 不再承载 modal 皮肤（禁止回流）；
 *   tab / 分类过滤一律 app-segmented（App.css 共享组件），不自建 pill 皮肤；
 * - 三族状态徽标（.comic-status-* / .comic-badge-* / .comic-slot-badge.is-*）
 *   统一为单一徽标族：共享 base + 语义分组，每对 badge-* 令牌全文只定义一次；
 * - 颜色纪律：comic CSS 零 hex（唯一例外 = .comic-overlay-bubble 作品层导出外观）；
 *   零 .app-btn-* 覆写（按钮皮肤一律来自全局原语）；
 * - 工作台宽度对齐 vision workbench：min(100%, 1520px)。
 */

const read = (path: string): string =>
  readFileSync(resolve(__dirname, path), 'utf-8').replace(/\r\n/g, '\n');

const studioCss = read('../../pages/ComicStudio.css');
const dialogCss = read('../../features/comic/components/ComicDialog.css');
const componentsDir = '../../features/comic/components';
const dialogs = [
  'ComicNewProjectDialog.tsx',
  'ComicActorLibraryDialog.tsx',
  'ComicActorDraftDialog.tsx',
  'ComicDeleteProjectDialog.tsx',
] as const;

describe('弹窗家族抽离（审计 2.8 Modal 行 / 2.9）', () => {
  test('ComicDialog.css 承载完整 modal 皮肤（overlay → actions；close 带 focus-visible）', () => {
    for (const rule of [
      '.comic-dialog-overlay {',
      '.comic-dialog {',
      '.comic-dialog-sm {',
      '.comic-dialog-header {',
      '.comic-dialog-close:hover {',
      '.comic-dialog-close:focus-visible {',
      '.comic-dialog-body {',
      '.comic-dialog-footer {',
      '.comic-dialog-actions {',
    ]) {
      expect(dialogCss).toContain(rule);
    }
    // V4.2.7：tab 已迁 app-segmented，自建 pill tab 皮肤必须清零
    expect(dialogCss).not.toContain('.comic-tab');
    expect(dialogCss).not.toContain('.comic-dialog-tabs');
  });

  test('四个弹窗组件全部 import ./ComicDialog.css', () => {
    for (const file of dialogs) {
      expect(read(`${componentsDir}/${file}`)).toContain("import './ComicDialog.css';");
    }
  });

  test('弹窗内 tab / 分类过滤 = app-segmented + aria-pressed（共享组件，无 comic-tab/comic-chip）', () => {
    const newProject = read(`${componentsDir}/ComicNewProjectDialog.tsx`);
    const actorLibrary = read(`${componentsDir}/ComicActorLibraryDialog.tsx`);
    expect(newProject).toContain('className="app-segmented"');
    // 两个 tab（AI 起草 / 从技能库）各自一个字面量
    expect(newProject.match(/app-segmented-btn/g)?.length).toBeGreaterThanOrEqual(2);
    expect(newProject).toContain('aria-pressed={mode === ');
    // 分类过滤由 LIBRARY_CATEGORY_LABELS.map 渲染（一个字面量出四个按钮）
    expect(actorLibrary).toContain('className="app-segmented"');
    expect(actorLibrary).toContain('LIBRARY_CATEGORY_LABELS.map');
    expect(actorLibrary).toContain('aria-pressed={category === chip.id}');
    expect(newProject).not.toContain('comic-tab');
    expect(actorLibrary).not.toContain('comic-chip');
  });

  test('ComicStudio.css 不再定义 modal 皮肤规则（指针注释除外）', () => {
    // 只匹配「规则块」形态（选择器 + {），注释里的 .comic-dialog-* / .comic-tab 不受影响
    for (const pattern of [
      /\.comic-dialog-overlay\s*\{/,
      /\.comic-dialog\s*\{/,
      /\.comic-dialog-sm\s*\{/,
      /\.comic-dialog-header\s*\{/,
      /\.comic-dialog-body\s*\{/,
      /\.comic-dialog-footer\s*\{/,
      /\.comic-dialog-actions\s*\{/,
      /\.comic-dialog-tabs\s*\{/,
      /\.comic-tab\s*\{/,
      /\.comic-tab\.is-active\s*\{/,
    ]) {
      expect(studioCss.match(pattern)).toBeNull();
    }
  });
});

describe('徽标族统一（审计 2.8 Badge 行：单一语义徽标族，token 驱动）', () => {
  test('共享 base：三族选择器同组声明一次', () => {
    expect(studioCss).toContain(
      ['.comic-status,', '.comic-badge,', '.comic-slot-badge {'].join('\n'),
    );
  });

  test('语义分组：同一语义共用同一对 badge 令牌', () => {
    expect(studioCss).toContain('.comic-status-completed,');
    expect(studioCss).toContain('.comic-badge-locked,');
    expect(studioCss).toContain('.comic-slot-badge.is-locked {');
    expect(studioCss).toContain('.comic-status-failed,');
    expect(studioCss).toContain('.comic-slot-badge.is-problem {');
    expect(studioCss).toContain('.comic-status-running,');
    expect(studioCss).toContain('.comic-badge-confirmed,');
    expect(studioCss).toContain('.comic-slot-badge.is-ready,');
    expect(studioCss).toContain('.comic-slot-badge.is-confirmed {');
    expect(studioCss).toContain('.comic-slot-badge.is-active {');
    expect(studioCss).toContain('.comic-badge-draft,');
    expect(studioCss).toContain('.comic-slot-badge.is-empty {');
  });

  test('旧三族独立规则块已删除（统一族是唯一 base，无冲突副本）', () => {
    // 统一族的组内选择器行（如 ".comic-status-completed,"）带逗号结尾；
    // 旧规则的行首独立声明形态（".comic-status-completed {"）必须全部消失
    for (const gone of [
      /^\.comic-status \{/gm,
      /^\.comic-badge \{/gm,
      /^\.comic-status-completed \{/gm,
      /^\.comic-status-failed \{/gm,
      /^\.comic-status-running \{/gm,
      /^\.comic-badge-locked \{/gm,
      /^\.comic-badge-confirmed \{/gm,
      /^\.comic-badge-draft \{/gm,
    ]) {
      expect(studioCss.match(gone)).toBeNull();
    }
    // 统一 base 组全文恰好出现一次
    const group = studioCss.match(/\.comic-status,\n\.comic-badge,\n\.comic-slot-badge \{/g);
    expect(group).toHaveLength(1);
  });

  test('族内每对语义令牌只写一次（muted = base 默认 + 草稿/空态组共两次）', () => {
    const start = studioCss.indexOf('状态徽标统一族');
    const end = studioCss.indexOf('阶段通用', start);
    const family = studioCss.slice(start, end);
    const count = (token: string): number =>
      family.match(new RegExp(`var\\(${token}\\)`, 'g'))?.length ?? 0;
    expect(count('--badge-success-bg')).toBe(1);
    expect(count('--badge-danger-bg')).toBe(1);
    expect(count('--badge-info-bg')).toBe(1);
    expect(count('--badge-warn-bg')).toBe(1);
    expect(count('--badge-muted-bg')).toBe(2);
  });

  test('徽标零 hex：统一族块内颜色只来自 var(--badge-*)', () => {
    const familyStart = studioCss.indexOf('状态徽标统一族');
    const familyEnd = studioCss.indexOf('阶段通用', familyStart);
    const family = studioCss.slice(familyStart, familyEnd);
    expect(family).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(family).toContain('var(--badge-muted-bg)');
  });
});

describe('颜色纪律（审计 2.9：零 .app-btn 覆写 / 零 hex 按钮色）', () => {
  test('comic CSS 零 .app-btn-* 皮肤覆写（布局微调允许，颜色/边框/字体禁止）', () => {
    for (const css of [studioCss, dialogCss]) {
      const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const block of noComments.split('}')) {
        if (!/app-btn/.test(block) || !block.includes('{')) continue;
        const decls = block.slice(block.indexOf('{'));
        for (const skin of ['background', 'color', 'border', 'box-shadow', 'font', 'padding', 'border-radius']) {
          expect(decls.includes(`${skin}:`), `${block.trim()} → ${skin}`).toBe(false);
        }
      }
    }
  });

  test('ComicStudio.css 零 hex（V4.2.12：气泡作品层固定配色统一 rgba，不随主题切换）', () => {
    expect(studioCss.match(/#[0-9a-fA-F]{3,8}\b/)).toBeNull();
  });

  test('ComicDialog.css 全令牌（零 hex）', () => {
    expect(dialogCss.match(/#[0-9a-fA-F]{3,8}\b/)).toBeNull();
  });
});

describe('工作台宽度对齐（审计 2.8 宽度行）', () => {
  test('.comic-workbench 主区上限 1520px，与 vision workbench 同构', () => {
    expect(studioCss).toContain('width: min(100%, 1520px)');
  });
});
