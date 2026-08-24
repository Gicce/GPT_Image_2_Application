/**
 * TaskBillingBadge — 任务计费展示（计费列：预计 / 实际 / 释放）
 *
 * 读 useTaskBillingStore（authorize/settle 响应侧车）；
 * 服务端 billing_transactions 是授权真相，本组件仅展示。
 */

import { useTaskBillingStore, type TaskBillingInfo } from '../store/useTaskBillingStore';

/** 展示派生（纯函数，供 UI 与测试共用）：未结算=预计；结算后=实际，partial 显示退回 */
export function deriveBillingDisplay(info: TaskBillingInfo | undefined): {
  kind: 'none' | 'estimated' | 'actual';
  estimated: number;
  actual: number | null;
  released: number | null;
} {
  if (!info || (info.estimated == null && info.actual == null)) {
    return { kind: 'none', estimated: 0, actual: null, released: null };
  }
  const estimated = info.estimated ?? 0;
  if (info.actual == null) {
    return { kind: 'estimated', estimated, actual: null, released: null };
  }
  const released = info.actual < estimated ? estimated - info.actual : null;
  return { kind: 'actual', estimated, actual: info.actual, released };
}

export default function TaskBillingBadge({ taskId }: { taskId: string }) {
  const info = useTaskBillingStore(s => s.billing[taskId]);
  const display = deriveBillingDisplay(info);
  if (display.kind === 'none') return null;

  return (
    <span className="task-billing-badge">
      {display.kind === 'estimated' ? (
        <>预计 {display.estimated.toLocaleString()} 点</>
      ) : (
        <>
          实际 {display.actual?.toLocaleString()} 点
          {display.released ? <span className="task-billing-released">（退回 {display.released.toLocaleString()}）</span> : null}
        </>
      )}
    </span>
  );
}
