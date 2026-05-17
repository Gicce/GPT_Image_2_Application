import type { UserToken } from '../services/serverApi';
import TokenField from './TokenField';
import './TokenInfoDialog.css';

interface Props {
  tokens: UserToken[];
  onClose: () => void;
}

export default function TokenInfoDialog({ tokens, onClose }: Props) {
  return (
    <div className="ti-overlay" onClick={onClose}>
      <div className="ti-dialog" onClick={e => e.stopPropagation()}>
        <div className="ti-header">
          <h3 className="ti-title">Token 信息</h3>
          <button className="ti-close" onClick={onClose}>✕</button>
        </div>
        <div className="ti-body">
          {tokens.length === 0 ? (
            <p className="ti-empty">暂无 Token 信息</p>
          ) : (
            tokens.map(t => (
              <div key={t.group} className="ti-group-card">
                <div className="ti-group-header">
                  <span className="ti-group-name">{t.group}</span>
                  <span className={`ti-badge ${t.is_trial ? 'trial' : 'paid'}`}>
                    {t.is_trial ? '试用' : '付费'}
                  </span>
                  <span className="ti-balance">${t.balance_usd.toFixed(4)}</span>
                </div>
                <TokenField
                  label={`${t.group} API Token`}
                  value={t.api_token}
                  emptyHint="未分配"
                />
              </div>
            ))
          )}
        </div>
        <div className="ti-footer">
          <button className="ti-btn ti-btn-ok" onClick={onClose}>确定</button>
        </div>
      </div>
    </div>
  );
}