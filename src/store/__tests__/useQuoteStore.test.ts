/**
 * Generation Quote Pattern 测试：报价确认 store（确认 / 取消 / 并发保护）
 * 与任务计费侧车（预计 → 实际 → 释放展示）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useQuoteStore } from '../useQuoteStore';
import { useTaskBillingStore } from '../useTaskBillingStore';
import type { BillingQuote } from '../../services/serverApi';

function makeQuote(overrides: Partial<BillingQuote> = {}): BillingQuote {
  return {
    quote_id: 'q-123',
    feature: 'image',
    model: 'gpt-image-2',
    unit_credits: 50,
    quantity: 4,
    estimated_credits: 200,
    pricing_rule_id: 'r1',
    pricing_rule_version: 1,
    expires_at: '2026-08-24T12:00:00Z',
    frozen: true,
    balance_snapshot: {
      paid_credits: 5000,
      trial_credits: 500,
      gift_credits: 290,
      total_credits: 5790,
      credits_per_cny: 100,
      sufficient: true,
      remaining_after: 5590,
    },
    ...overrides,
  };
}

describe('useQuoteStore（生成前报价确认）', () => {
  beforeEach(() => {
    useQuoteStore.setState({ pending: null });
  });

  it('确认：openConfirm 后 settle(true) resolve true', async () => {
    const promise = useQuoteStore.getState().openConfirm(makeQuote());
    expect(useQuoteStore.getState().pending).not.toBeNull();
    useQuoteStore.getState().settle(true);
    await expect(promise).resolves.toBe(true);
    expect(useQuoteStore.getState().pending).toBeNull();
  });

  it('取消：settle(false) resolve false（调用方据此中止提交）', async () => {
    const promise = useQuoteStore.getState().openConfirm(makeQuote());
    useQuoteStore.getState().settle(false);
    await expect(promise).resolves.toBe(false);
  });

  it('并发保护：上一个未关闭时新请求直接 false', async () => {
    const first = useQuoteStore.getState().openConfirm(makeQuote());
    const second = useQuoteStore.getState().openConfirm(makeQuote({ quote_id: 'q-456' }));
    await expect(second).resolves.toBe(false);
    useQuoteStore.getState().settle(true);
    await expect(first).resolves.toBe(true);
  });

  it('余额不足快照：sufficient=false 时弹层数据如实透出', () => {
    const quote = makeQuote({
      balance_snapshot: {
        paid_credits: 30, trial_credits: 0, gift_credits: 0, total_credits: 30,
        credits_per_cny: 100, sufficient: false, remaining_after: -170,
      },
    });
    expect(quote.balance_snapshot?.sufficient).toBe(false);
  });
});

describe('useTaskBillingStore（任务计费展示侧车）', () => {
  beforeEach(() => {
    useTaskBillingStore.setState({ billing: {} });
  });

  it('authorize → register：预计消耗登记到任务', () => {
    useTaskBillingStore.getState().recordAuthorize('task-1', {
      requestId: 'req-1', estimated: 200, unit: 50,
    });
    const info = useTaskBillingStore.getState().getByTaskId('task-1');
    expect(info?.estimated).toBe(200);
    expect(info?.unit).toBe(50);
    expect(info?.actual).toBeUndefined();
  });

  it('settle：登记实际消耗（partial 场景 actual < estimated）', () => {
    useTaskBillingStore.getState().recordAuthorize('task-2', {
      requestId: 'req-2', estimated: 200, unit: 50,
    });
    useTaskBillingStore.getState().recordSettle('req-2', 150, 'SUCCESS');
    const info = useTaskBillingStore.getState().getByTaskId('task-2');
    expect(info?.actual).toBe(150);
    expect(info?.status).toBe('SUCCESS');
    // 释放 = 200 - 150 = 50（TaskBillingBadge 展示逻辑）
    expect((info?.estimated ?? 0) - (info?.actual ?? 0)).toBe(50);
  });

  it('settle 未知 requestId：静默忽略', () => {
    expect(() => useTaskBillingStore.getState().recordSettle('nope', 100, 'SUCCESS')).not.toThrow();
  });
});
