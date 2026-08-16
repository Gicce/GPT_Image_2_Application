/** 账户用量统计的时间范围解析（纯函数，便于测试） */

export type UsageRangeKey = '7d' | '30d' | 'month' | 'custom';

export function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 把范围选择解析为 { start, end }（YYYY-MM-DD，闭区间，本地日期）。
 * custom 未填完整或非法时回落到近 7 天，保证请求始终合法。
 */
export function resolveUsageRange(
  key: UsageRangeKey,
  customStart: string,
  customEnd: string,
  today: Date = new Date(),
): { start: string; end: string } {
  if (key === 'custom' && customStart && customEnd && customEnd >= customStart) {
    return { start: customStart, end: customEnd };
  }
  if (key === '30d') {
    const from = new Date(today);
    from.setDate(from.getDate() - 29);
    return { start: toDateKey(from), end: toDateKey(today) };
  }
  if (key === 'month') {
    const from = new Date(today.getFullYear(), today.getMonth(), 1);
    return { start: toDateKey(from), end: toDateKey(today) };
  }
  const from = new Date(today);
  from.setDate(from.getDate() - 6);
  return { start: toDateKey(from), end: toDateKey(today) };
}
