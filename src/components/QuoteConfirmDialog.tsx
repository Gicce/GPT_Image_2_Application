/**
 * QuoteConfirmDialog — 生成前报价确认弹层（全局唯一，挂在 App Shell）
 *
 * 展示：模式 / 数量 / 单张点数 / 预计消耗 / 当前余额 /（不足时）还差多少。
 * 数据全部来自服务端报价（billing/quote），本组件不做任何金额计算。
 *
 * CTA 层级（Billing Dialog CTA Pattern）：余额不足时补救动作（去充值）属于
 * footer action hierarchy——[取消 secondary] [去充值 primary] [确认生成 disabled]，
 * 绝不在明细区孤零零放按钮；余额充足时不渲染补救按钮。
 */

import { useQuoteStore } from '../store/useQuoteStore';

const FEATURE_LABELS: Record<string, string> = {
  image: '图片生成',
};

/** 「去充值」返回上下文（§32：充值完成可回视觉项目继续生成；一次性消费）。 */
export const RECHARGE_RETURN_KEY = 'cy_recharge_return';

export function readRechargeReturnContext(): { page: string } | null {
  try {
    const raw = sessionStorage.getItem(RECHARGE_RETURN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.page === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearRechargeReturnContext(): void {
  try {
    sessionStorage.removeItem(RECHARGE_RETURN_KEY);
  } catch {
    // sessionStorage 不可用（隐私模式等）时静默降级：返回链接不出现，不影响充值
  }
}

export default function QuoteConfirmDialog() {
  const pending = useQuoteStore(s => s.pending);
  const settle = useQuoteStore(s => s.settle);

  if (!pending) return null;
  const { quote } = pending;
  const snap = quote.balance_snapshot;
  const featureLabel = FEATURE_LABELS[quote.feature] || quote.feature;
  const insufficient = snap ? !snap.sufficient : false;
  const shortfall = snap && insufficient
    ? Math.max(0, quote.estimated_credits - snap.total_credits)
    : 0;

  const goRecharge = () => {
    try {
      sessionStorage.setItem(RECHARGE_RETURN_KEY, JSON.stringify({ page: 'vision' }));
    } catch {
      // 写不进返回上下文不影响主链路（去充值本身仍直达账户页）
    }
    settle(false);
    window.dispatchEvent(new CustomEvent('cyimage-navigate', {
      detail: { page: 'account', section: 'recharge' },
    }));
  };

  return (
    <div className="quote-confirm-overlay" onClick={() => settle(false)}>
      <div className="quote-confirm-dialog" onClick={e => e.stopPropagation()}>
        <h3>本次生成</h3>
        <div className="quote-confirm-rows">
          <div className="quote-confirm-row">
            <span>模式</span>
            <strong>{featureLabel}</strong>
          </div>
          <div className="quote-confirm-row">
            <span>数量</span>
            <strong>{quote.quantity} 张</strong>
          </div>
          <div className="quote-confirm-row">
            <span>单张</span>
            <strong>{quote.unit_credits} 点</strong>
          </div>
          <div className="quote-confirm-row emphasize">
            <span>预计消耗</span>
            <strong>{quote.estimated_credits} 点</strong>
          </div>
          {snap && (
            <>
              <div className="quote-confirm-row">
                <span>当前余额</span>
                <strong>{snap.total_credits.toLocaleString()} 点</strong>
              </div>
              {insufficient && shortfall > 0 && (
                <div className="quote-confirm-row danger">
                  <span>还差</span>
                  <strong>{shortfall.toLocaleString()} 点</strong>
                </div>
              )}
              <div className={`quote-confirm-row ${snap.sufficient ? '' : 'muted'}`}>
                <span>生成后预计剩余</span>
                <strong>{snap.remaining_after.toLocaleString()} 点</strong>
              </div>
            </>
          )}
          <div className="quote-confirm-row muted">
            <span>说明</span>
            <span>按实际成功张数结算，失败张数自动退回点数</span>
          </div>
        </div>
        {insufficient && (
          <div className="quote-confirm-warn">点数不足，需要充值后生成。</div>
        )}
        <div className="quote-confirm-actions">
          <button className="quote-confirm-cancel" onClick={() => settle(false)}>取消</button>
          {insufficient && (
            <button type="button" className="quote-confirm-recharge" onClick={goRecharge}>
              去充值
            </button>
          )}
          <button
            className="quote-confirm-ok"
            disabled={insufficient}
            title={insufficient ? '点数不足，需先充值后再生成' : undefined}
            onClick={() => settle(true)}
          >
            确认生成 · {quote.estimated_credits} 点
          </button>
        </div>
      </div>
    </div>
  );
}
