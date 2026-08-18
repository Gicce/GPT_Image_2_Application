import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * 资金确认按钮样式回归守卫。
 *
 * 历史事故：确认充值 / 提交退款申请按钮使用未定义的 var(--error) 背景
 * → 透明底 + 白字，浅色主题下完全不可见。本测试锁定：
 * - 主确认按钮（确认充值）= 主题主色 --accent-primary + --text-on-accent
 * - 危险确认按钮（提交退款申请）= --accent-danger
 * - 取消按钮背景只允许引用已定义的 CSS 变量（--bg-subtle / --bg-card）
 */
describe('确认充值 / 提交退款申请按钮样式', () => {
  const css = readFileSync(resolve(__dirname, '../Account.css'), 'utf-8');

  function rule(selector: string): string {
    const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`);
    const m = css.match(re);
    return m ? m[1] : '';
  }

  test('主确认按钮（确认充值）使用主题主色背景 + 白字', () => {
    const body = rule('.refund-confirm-ok');
    expect(body).toContain('background: var(--accent-primary)');
    expect(body).toContain('color: var(--text-on-accent)');
  });

  test('危险确认按钮（提交退款申请）使用明确的 danger 色', () => {
    const body = rule('.refund-confirm-ok.danger');
    expect(body).toContain('background: var(--accent-danger)');
    expect(body).toContain('color: #fff');
  });

  test('不再引用未定义的 --error / --bg-primary / --bg-tertiary 变量', () => {
    expect(css).not.toMatch(/var\(--error\)/);
    expect(css).not.toMatch(/var\(--bg-primary\)/);
    expect(css).not.toMatch(/var\(--bg-tertiary\)/);
  });

  test('取消按钮引用的变量真实存在于 App.css 主题定义', () => {
    const appCss = readFileSync(resolve(__dirname, '../../App.css'), 'utf-8');
    const cancel = rule('.refund-confirm-cancel');
    expect(cancel).toContain('background: var(--bg-subtle)');
    expect(appCss).toMatch(/--bg-subtle\s*:/);
  });
});
