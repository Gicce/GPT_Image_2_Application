/**
 * 计费方式 UI 文案唯一来源（V4.0.9）。
 *
 * 「API 按量计费」「Coding Plan 套餐」是整词文案：BillingBadge 保证单行不换行，
 * 任何组件禁止现场拼接缩写变体（「按量」「API计费」「按量收费」等）。
 * 需要展示计费方式的地方一律：<BillingBadge mode={profile.billing_mode} />
 */
import type { BillingMode } from './types';
import { BILLING_MODE_LABELS } from './types';

export function getBillingLabel(mode?: BillingMode): string {
  return mode ? BILLING_MODE_LABELS[mode] : '';
}
