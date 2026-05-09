import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { serverApi, type Package, type OrderResult } from '../services/serverApi';
import './Account.css';

export default function Account() {
  const { user, refreshUser, logout, updateBalance, updateApiToken } = useAuthStore();
  const [packages, setPackages] = useState<Package[]>([]);
  const [usage, setUsage] = useState<any[]>([]);
  const [selectedPkg, setSelectedPkg] = useState<number | null>(null);
  const [payType, setPayType] = useState<'alipay' | 'wxpay'>('alipay');
  const [ordering, setOrdering] = useState(false);
  const [order, setOrder] = useState<OrderResult | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollMsg, setPollMsg] = useState('');
  const [loadingUsage, setLoadingUsage] = useState(false);

  useEffect(() => {
    refreshUser();
    loadPackages();
    loadUsage();
  }, []);

  async function loadPackages() {
    try {
      const pkgs = await serverApi.getPackages();
      setPackages(pkgs);
      if (pkgs.length > 0) setSelectedPkg(pkgs[0].package_usd);
    } catch {}
  }

  async function loadUsage() {
    setLoadingUsage(true);
    try {
      const data = await serverApi.getUsage();
      setUsage(data.slice(0, 30));
    } catch {} finally {
      setLoadingUsage(false);
    }
  }

  async function handleBuy() {
    if (!selectedPkg) return;
    setOrdering(true);
    try {
      const result = await serverApi.createOrder(selectedPkg, payType, '127.0.0.1');
      setOrder(result);
      startPolling(result.out_trade_no);
    } catch (e: any) {
      alert(e.message || '创建订单失败');
    } finally {
      setOrdering(false);
    }
  }

  const startPolling = useCallback((tradeNo: string) => {
    setPolling(true);
    setPollMsg('等待支付...');
    let count = 0;
    const timer = setInterval(async () => {
      count++;
      if (count > 100) {
        clearInterval(timer);
        setPolling(false);
        setPollMsg('支付超时，请重新下单');
        return;
      }
      try {
        const status = await serverApi.queryOrder(tradeNo);
        if (status.status === 'paid') {
          clearInterval(timer);
          setPolling(false);
          setPollMsg('支付成功！');
          setOrder(null);
          if (status.api_token) updateApiToken(status.api_token);
          await refreshUser();
        }
      } catch {}
    }, 3000);
  }, [refreshUser, updateApiToken]);

  const typeLabel = user?.account_type === 'trial' ? '试用账户' : '付费账户';
  const trialExpired = user?.trial_expired;

  return (
    <div className="page">
      <div className="page-header">
        <h2>我的账户</h2>
      </div>

      {/* 用户信息卡 */}
      <div className="account-card">
        <div className="account-info-row">
          <div className="account-info-item">
            <span className="info-label">用户名</span>
            <span className="info-value">{user?.username}</span>
          </div>
          <div className="account-info-item">
            <span className="info-label">账户类型</span>
            <span className={`info-badge ${user?.account_type}`}>{typeLabel}</span>
          </div>
          <div className="account-info-item">
            <span className="info-label">余额</span>
            <span className="info-value balance">${user?.balance_usd?.toFixed(4)}</span>
          </div>
          {user?.account_type === 'trial' && user.trial_expires_at && (
            <div className="account-info-item">
              <span className="info-label">试用到期</span>
              <span className={`info-value ${trialExpired ? 'expired' : ''}`}>
                {trialExpired ? '已过期' : user.trial_expires_at.replace('T', ' ').slice(0, 16)}
              </span>
            </div>
          )}
        </div>
        <button className="logout-btn" onClick={logout}>退出登录</button>
      </div>

      {/* 购买套餐 */}
      <div className="account-section">
        <h3>充值套餐</h3>
        <div className="pkg-grid">
          {packages.map(pkg => (
            <div
              key={pkg.package_usd}
              className={`pkg-card ${selectedPkg === pkg.package_usd ? 'selected' : ''}`}
              onClick={() => setSelectedPkg(pkg.package_usd)}
            >
              <div className="pkg-name">{pkg.name}</div>
              <div className="pkg-price">¥{pkg.price_cny.toFixed(2)}</div>
              <div className="pkg-rate">汇率 {pkg.exchange_rate.toFixed(4)}</div>
            </div>
          ))}
        </div>

        <div className="pay-row">
          <label>支付方式</label>
          <div className="pay-type-btns">
            <button
              className={`pay-type-btn ${payType === 'alipay' ? 'active' : ''}`}
              onClick={() => setPayType('alipay')}
            >支付宝</button>
            <button
              className={`pay-type-btn ${payType === 'wxpay' ? 'active' : ''}`}
              onClick={() => setPayType('wxpay')}
            >微信支付</button>
          </div>
          <button className="buy-btn" onClick={handleBuy} disabled={ordering || !selectedPkg}>
            {ordering ? '创建中...' : '立即购买'}
          </button>
        </div>

        {/* 支付二维码 */}
        {order && (
          <div className="qr-box">
            <p className="qr-amount">¥{order.amount_cny.toFixed(2)} · {order.pay_type === 'alipay' ? '支付宝' : '微信支付'}</p>
            <p className="qr-hint">请用手机扫码完成支付</p>
            <a className="qr-link" href={order.pay_info} target="_blank" rel="noreferrer">
              点击打开支付页面
            </a>
            {polling && <p className="qr-polling">⏳ {pollMsg}</p>}
            {!polling && pollMsg && <p className="qr-done">{pollMsg}</p>}
          </div>
        )}
      </div>

      {/* 用量记录 */}
      <div className="account-section">
        <h3>最近用量</h3>
        {loadingUsage ? (
          <p className="usage-loading">加载中...</p>
        ) : usage.length === 0 ? (
          <p className="usage-empty">暂无用量记录</p>
        ) : (
          <table className="usage-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>类型</th>
                <th>数量</th>
                <th>费用</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((u, i) => (
                <tr key={i}>
                  <td>{u.model}</td>
                  <td>{u.usage_type === 'image' ? '图片' : '对话'}</td>
                  <td>{u.usage_type === 'image' ? `${u.image_count} 张` : `${u.input_tokens + u.output_tokens} tokens`}</td>
                  <td>${Number(u.cost_usd).toFixed(4)}</td>
                  <td>{u.created_at?.replace('T', ' ').slice(0, 16)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
