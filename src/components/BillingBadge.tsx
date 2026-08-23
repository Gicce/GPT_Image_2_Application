import type { BillingMode } from '../features/aiProviders/types';
import { getBillingLabel } from '../features/aiProviders/billing';
import './BillingBadge.css';

/**
 * 计费方式 Badge —— 「API 按量计费 / Coding Plan 套餐」在 UI 中的唯一展示形态。
 * 文案来自 getBillingLabel（整词），布局约：flex 容器内 flex-shrink:0 + nowrap，
 * 空间不足时只允许相邻的模型名截断，计费词永不换行 / 永不缩写。
 */
export default function BillingBadge({ mode }: { mode?: BillingMode }) {
  const label = getBillingLabel(mode);
  if (!label) return null;
  return <span className="billing-badge">{label}</span>;
}
