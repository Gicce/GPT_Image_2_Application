/**
 * Billing Dialog CTA Pattern 守卫（§29-§32 / §54）：
 * 历史缺陷锚点——「去充值」孤零零放在明细行区域内。
 * 修复 = footer 三按钮层级 [取消][去充值 primary][确认生成 disabled] + 「还差」行。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const quote = readFileSync(resolve(__dirname, '../QuoteConfirmDialog.tsx'), 'utf-8');
const appCss = readFileSync(resolve(__dirname, '../../App.css'), 'utf-8');
const account = readFileSync(resolve(__dirname, '../../pages/Account.tsx'), 'utf-8');

describe('§29/§30 CTA 层级与明细', () => {
  test('insufficientCreditsShowsRechargeCTA：不足时渲染去充值（且明细区补「还差 N 点」）', () => {
    expect(quote).toContain('{insufficient && (');
    expect(quote).toContain('去充值');
    expect(quote).toContain('还差');
    expect(quote).toContain('Math.max(0, quote.estimated_credits - snap.total_credits)');
  });

  test('rechargeCTAIsInFooter：去充值按钮位于 .quote-confirm-actions footer 操作区（取消与确认之间）', () => {
    const footerStart = quote.indexOf('className="quote-confirm-actions"');
    const rechargeAt = quote.indexOf('className="quote-confirm-recharge"', footerStart);
    const okAt = quote.indexOf('className="quote-confirm-ok"', footerStart);
    const cancelAt = quote.indexOf('className="quote-confirm-cancel"', footerStart);
    expect(footerStart).toBeGreaterThan(-1);
    expect(cancelAt).toBeGreaterThan(footerStart);
    expect(rechargeAt).toBeGreaterThan(cancelAt);
    expect(okAt).toBeGreaterThan(rechargeAt);
    // 明细区不再渲染充值按钮（历史缺陷锚点）
    const rowsEnd = quote.indexOf('quote-confirm-warn');
    expect(quote.slice(0, rowsEnd)).not.toContain('quote-confirm-recharge');
  });

  test('confirmButtonDisabledWhenInsufficient：不足时确认生成 disabled（唯一 primary = 去充值）', () => {
    expect(quote).toMatch(/disabled=\{insufficient\}/);
    // 去充值按钮无 disabled（补救动作恒可用）
    const start = quote.indexOf('className="quote-confirm-recharge"');
    const rechargeBlock = quote.slice(start, quote.indexOf('</button>', start));
    expect(rechargeBlock).not.toContain('disabled');
  });
});

describe('§31/§32 导航与返回上下文', () => {
  test('rechargeNavigatesToRechargeSection：cyimage-navigate(account/recharge) + 写入 returnContext', () => {
    expect(quote).toContain("detail: { page: 'account', section: 'recharge' }");
    expect(quote).toContain('cy_recharge_return');
    expect(quote).toContain("JSON.stringify({ page: 'vision' })");
  });

  test('Account：returnContext 存在时显示「返回继续生成」（一次性消费后清除）', () => {
    expect(account).toContain('返回继续生成');
    expect(account).toContain('readRechargeReturnContext');
    expect(account).toContain('clearRechargeReturnContext');
  });

  test('CTA 样式：去充值为 primary（品牌主色），确认生成 disabled 半透明', () => {
    expect(appCss).toMatch(/\.quote-confirm-recharge \{[\s\S]*?background: var\(--accent-primary\);/);
    expect(appCss).toMatch(/\.quote-confirm-ok:disabled \{[\s\S]*?opacity: 0\.45;/);
  });
});
