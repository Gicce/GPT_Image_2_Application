import { describe, it, expect } from 'vitest';
import { resolveUsageRange, toDateKey } from '../usageRange';

const TODAY = new Date(2026, 7, 16); // 2026-08-16

describe('resolveUsageRange', () => {
  it('7d：今天往前共 7 天（含今天）', () => {
    expect(resolveUsageRange('7d', '', '', TODAY)).toEqual({
      start: '2026-08-10',
      end: '2026-08-16',
    });
  });

  it('30d：今天往前共 30 天（含今天）', () => {
    expect(resolveUsageRange('30d', '', '', TODAY)).toEqual({
      start: '2026-07-18',
      end: '2026-08-16',
    });
  });

  it('month：本月 1 号到今天', () => {
    expect(resolveUsageRange('month', '', '', TODAY)).toEqual({
      start: '2026-08-01',
      end: '2026-08-16',
    });
  });

  it('custom：使用用户填写的日期', () => {
    expect(resolveUsageRange('custom', '2026-08-01', '2026-08-15', TODAY)).toEqual({
      start: '2026-08-01',
      end: '2026-08-15',
    });
  });

  it('custom 未填完整：回落到近 7 天而不是发出非法请求', () => {
    expect(resolveUsageRange('custom', '', '2026-08-15', TODAY)).toEqual({
      start: '2026-08-10',
      end: '2026-08-16',
    });
  });

  it('custom 结束早于开始：回落到近 7 天', () => {
    expect(resolveUsageRange('custom', '2026-08-15', '2026-08-01', TODAY)).toEqual({
      start: '2026-08-10',
      end: '2026-08-16',
    });
  });

  it('跨年/跨月边界：30d 正确回退月份', () => {
    expect(resolveUsageRange('7d', '', '', new Date(2026, 0, 3))).toEqual({
      start: '2025-12-28',
      end: '2026-01-03',
    });
  });
});

describe('toDateKey', () => {
  it('补零到两位', () => {
    expect(toDateKey(new Date(2026, 7, 5))).toBe('2026-08-05');
  });
});
