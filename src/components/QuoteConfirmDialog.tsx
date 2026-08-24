/**
 * QuoteConfirmDialog — 生成前报价确认弹层（全局唯一，挂在 App Shell）
 *
 * 展示：模式 / 数量 / 单张点数 / 预计消耗 / 当前余额 / 生成后预计剩余。
 * 数据全部来自服务端报价（billing/quote），本组件不做任何金额计算。
 */

import { useQuoteStore } from '../store/useQuoteStore';

const FEATURE_LABELS: Record<string, string> = {
  image: '图片生成',
};

export default function QuoteConfirmDialog() {
  const pending = useQuoteStore(s => s.pending);
  const settle = useQuoteStore(s => s.settle);

  if (!pending) return null;
  const { quote } = pending;
  const snap = quote.balance_snapshot;
  const featureLabel = FEATURE_LABELS[quote.feature] || quote.feature;

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
              <div className={`quote-confirm-row ${snap.sufficient ? '' : 'danger'}`}>
                <span>生成后预计剩余</span>
                <strong>{snap.remaining_after.toLocaleString()} 点</strong>
              </div>
              {!snap.sufficient && (
                <div className="quote-confirm-warn">点数不足，请先前往「我的账户」充值</div>
              )}
            </>
          )}
          <div className="quote-confirm-row muted">
            <span>说明</span>
            <span>按实际成功张数结算，失败张数自动退回点数</span>
          </div>
        </div>
        <div className="quote-confirm-actions">
          <button className="quote-confirm-cancel" onClick={() => settle(false)}>取消</button>
          <button
            className="quote-confirm-ok"
            disabled={snap ? !snap.sufficient : false}
            onClick={() => settle(true)}
          >
            确认生成 · {quote.estimated_credits} 点
          </button>
        </div>
      </div>
    </div>
  );
}
