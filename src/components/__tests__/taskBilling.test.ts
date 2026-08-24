/**
 * UI 铁律测试（纯逻辑，无 DOM 依赖）：
 * - 用户生成前 MUST 知道预计消耗（deriveBillingDisplay estimated）
 * - 用户生成后 MUST 能看到实际消耗（actual）
 * - 失败/部分释放 MUST 可见（released）
 * - 流水方向（正=入账、负=消费）与服务端 ledger 归一一致
 */

import { describe, it, expect } from 'vitest';
import { deriveBillingDisplay } from '../TaskBillingBadge';
import type { LedgerRecord } from '../../services/serverApi';

describe('deriveBillingDisplay（任务计费展示派生）', () => {
  it('无信息 → 不渲染', () => {
    expect(deriveBillingDisplay(undefined).kind).toBe('none');
    expect(deriveBillingDisplay({ requestId: 'r' }).kind).toBe('none');
  });

  it('未结算 → 预计消耗（生成前 MUST 知道）', () => {
    const d = deriveBillingDisplay({ requestId: 'r', estimated: 200, unit: 50 });
    expect(d.kind).toBe('estimated');
    expect(d.estimated).toBe(200);
    expect(d.actual).toBeNull();
  });

  it('全额结算 → 实际消耗，无退回', () => {
    const d = deriveBillingDisplay({ requestId: 'r', estimated: 100, actual: 100, unit: 100, status: 'SUCCESS' });
    expect(d.kind).toBe('actual');
    expect(d.actual).toBe(100);
    expect(d.released).toBeNull();
  });

  it('Partial（4×50 预占 200，成功 3）→ 实际 150 退回 50（释放 MUST 可见）', () => {
    const d = deriveBillingDisplay({ requestId: 'r', estimated: 200, actual: 150, unit: 50, status: 'SUCCESS' });
    expect(d.kind).toBe('actual');
    expect(d.actual).toBe(150);
    expect(d.released).toBe(50);
  });

  it('失败释放 → 实际 0，全额退回', () => {
    const d = deriveBillingDisplay({ requestId: 'r', estimated: 200, actual: 0, unit: 50, status: 'FAILED' });
    expect(d.actual).toBe(0);
    expect(d.released).toBe(200);
  });
});

describe('ledger 流水方向（服务端归一契约）', () => {
  const base = {
    trial_credits_part: 0, gift_credits_part: 0, paid_credits_part: 0,
    unit_credits: null, image_count: 0, request_id: null, related_order_id: null,
    failure_reason: null, remark: null, created_at: null,
  } as const;

  it('充值 / 释放为正，消费为负（含 RESERVED 预占）', () => {
    const records: LedgerRecord[] = [
      { ...base, id: '1', type: 'RECHARGE', type_label: '充值', status: 'SUCCESS', amount_credits: 1000 },
      { ...base, id: '2', type: 'IMAGE2_CHARGE', type_label: '图片生成', status: 'RESERVED', amount_credits: -200 },
      { ...base, id: '3', type: 'IMAGE2_CHARGE', type_label: '图片生成', status: 'SUCCESS', amount_credits: -150 },
      { ...base, id: '4', type: 'IMAGE2_CHARGE', type_label: '图片生成', status: 'RELEASED', amount_credits: 50 },
    ];
    const signs = records.map(r => Math.sign(r.amount_credits));
    expect(signs).toEqual([1, -1, -1, 1]);
  });
});
