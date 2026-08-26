import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * QuoteConfirmDialog 主题源码契约（V4.2 GUI 验收 Case A 回归）：
 *
 * Light Theme 下报价弹窗曾因「幽灵 token」渲染成深色面板——CSS 引用了
 * 不存在的 `--bg-surface` / `--border-color` / `--danger` 并配深色 fallback，
 * 任何主题都解析失败。本守卫保证：
 *  1. quote-confirm 区块内禁止任何硬编码主题色（hex / rgb / rgba）；
 *  2. 区块内引用的每个 var(--*) 都在 light 与 dark 两套 token 块中真实定义
 *     （新增引用未定义 token 时测试立即失败，杜绝幽灵 token 回归）。
 */

const css = readFileSync(resolve(__dirname, '../../App.css'), 'utf-8');

function quoteConfirmSection(): string {
  const start = css.indexOf('/* ─── QuoteConfirmDialog');
  expect(start).toBeGreaterThanOrEqual(0);
  // 区块以下一个顶级分段注释或文件尾结束
  const nextSection = css.indexOf('\n/* ───', start + 1);
  return css.slice(start, nextSection >= 0 ? nextSection : undefined);
}

function themeBlock(theme: 'light' | 'dark'): string {
  const start = css.indexOf(`[data-theme="${theme}"]`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

function definedTokens(block: string): Set<string> {
  return new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(match => match[1]));
}

describe('QuoteConfirmDialog 主题 Token 契约', () => {
  const section = quoteConfirmSection();

  test('区块内禁止硬编码主题色（hex / rgb / rgba）', () => {
    expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(section).not.toMatch(/rgba?\(/i);
  });

  test('区块内禁止幽灵 token 回归（曾经踩坑的三个名字）', () => {
    expect(section).not.toContain('--bg-surface');
    expect(section).not.toContain('--border-color');
    expect(section).not.toContain('--danger');
    expect(section).not.toContain('--radius-lg');
  });

  test('区块内引用的每个 token 在 light 与 dark 双主题都有定义', () => {
    const used = [...section.matchAll(/var\((--[a-z0-9-]+)\)/g)].map(match => match[1]);
    expect(used.length).toBeGreaterThan(0);
    const light = definedTokens(themeBlock('light'));
    const dark = definedTokens(themeBlock('dark'));
    const missing = used.filter(token => !light.has(token) || !dark.has(token));
    expect(missing).toEqual([]);
  });

  test('弹窗面板使用 elevated surface（--bg-dialog）+ 默认边框，遮罩使用 overlay token', () => {
    const dialog = section.slice(
      section.indexOf('.quote-confirm-dialog {'),
      section.indexOf('.quote-confirm-dialog h3'),
    );
    expect(dialog).toContain('background: var(--bg-dialog)');
    expect(dialog).toContain('border: 1px solid var(--border-default)');
    const overlay = section.slice(
      section.indexOf('.quote-confirm-overlay {'),
      section.indexOf('.quote-confirm-dialog {'),
    );
    expect(overlay).toContain('background: var(--bg-overlay)');
  });
});
