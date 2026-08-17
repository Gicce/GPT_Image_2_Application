import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { serverApi, type ServerModel, type PayLimits, type UserOrder, type UsageRecord, type PackagesResponse, type RuntimeTokenStatus } from '../services/serverApi';
import { api } from '../services/api';
import { setAsAvatarFromPath, clearAvatar } from '../services/avatarService';
import { clearRuntimeConfig } from '../services/runtimeTokenService';
import { toastError, toastSuccess } from '../components/Toast';
import AccountUsagePanel from '../components/AccountUsagePanel';
import { explainError } from '../utils/errors';
import './Account.css';

interface PendingOrder {
  out_trade_no: string;
  amount_usd: number;
  amount_cny: number;
}

type AllocStatus = 'pending' | 'paid' | 'allocated' | 'closed' | 'unknown';

let qrCodeModulePromise: Promise<typeof import('qrcode')> | null = null;

async function generatePaymentQrCode(codeUrl: string) {
  if (!qrCodeModulePromise) {
    qrCodeModulePromise = import('qrcode');
  }
  const QRCode = await qrCodeModulePromise;
  return QRCode.toDataURL(codeUrl, { width: 200, margin: 2 });
}

function getInitials(name?: string | null): string {
  const value = (name || '').trim();
  if (!value) return 'U';
  if (/[一-龥]/.test(value)) return value.match(/[一-龥]/)?.[0] || 'U';
  const parts = value.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return value.slice(0, 2).toUpperCase();
}

export default function Account() {
  const { user, isLoggedIn, refreshFailed, refreshUser, logout, upgradeTrial, showAuthPrompt } = useAuthStore();
  const { settings } = useSettingsStore();
  const [trialLoading, setTrialLoading] = useState(false);
  const [models, setModels] = useState<ServerModel[]>([]);
  const [pkg, setPkg] = useState<PackagesResponse | null>(null);
  const [runtimeToken, setRuntimeToken] = useState<RuntimeTokenStatus | null>(null);
  const [replacingToken, setReplacingToken] = useState(false);
  const [amount, setAmount] = useState('');
  const [ordering, setOrdering] = useState(false);
  const [rechargeConfirmOpen, setRechargeConfirmOpen] = useState(false);
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([]);
  const [allocMap, setAllocMap] = useState<Record<string, AllocStatus>>({});
  const [polling, setPolling] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('');
  const [qrCodeLink, setQrCodeLink] = useState<string>('');
  const [showPricingDialog, setShowPricingDialog] = useState(false);
  const [usageRecords, setUsageRecords] = useState<UsageRecord[]>([]);
  const [orders, setOrders] = useState<UserOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [orderActionLoading, setOrderActionLoading] = useState<string | null>(null);
  const [refundConfirmId, setRefundConfirmId] = useState<string | null>(null);
  const [refundPollingId, setRefundPollingId] = useState<string | null>(null);
  const [refundStatusMsg, setRefundStatusMsg] = useState('');
  const allocTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refundTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshAccountData = useCallback(() => {
    void refreshUser();
    loadRuntimeToken();
  }, [refreshUser]);

  useEffect(() => {
    if (!isLoggedIn) return;
    refreshUser();
    loadModels();
    loadPackages();
    loadOrders();
    loadRuntimeToken();
  }, [isLoggedIn]);

  // 窗口重新获得焦点时拉取最新账户数据（服务端是唯一事实来源，缓存不得长期覆盖）
  useEffect(() => {
    if (!isLoggedIn) return;
    const onFocus = () => refreshAccountData();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [isLoggedIn, refreshAccountData]);

  async function loadRuntimeToken() {
    try {
      setRuntimeToken(await serverApi.getRuntimeToken());
    } catch {
      setRuntimeToken(null);
    }
  }

  useEffect(() => () => {
    if (allocTimerRef.current) clearInterval(allocTimerRef.current);
    if (refundTimerRef.current) clearInterval(refundTimerRef.current);
  }, []);

  async function loadOrders() {
    setOrdersLoading(true);
    try {
      const raw = await serverApi.getOrders();
      const data: UserOrder[] = raw.map((o: any) => ({
        out_trade_no: o.out_trade_no,
        group: o.group ?? '',
        amount_usd: Number(o.amount_usd ?? o.total_usd ?? 0),
        amount_cny: Number(o.amount_cny ?? o.total_cny ?? 0),
        total_usd: Number(o.total_usd ?? o.amount_usd ?? 0),
        total_cny: Number(o.total_cny ?? o.amount_cny ?? 0),
        exchange_rate: o.exchange_rate ?? null,
        status: o.status === 'assigned' ? 'allocated' : o.status,
        pay_type: o.pay_type ?? '',
        items: Array.isArray(o.items) ? o.items : [],
        created_at: o.created_at ?? '',
        paid_at: o.paid_at ?? null,
      }));
      setOrders(data);
    } catch {} finally {
      setOrdersLoading(false);
    }
  }

  async function handleCancelOrder(id: string) {
    setOrderActionLoading(id);
    try {
      await serverApi.closeOrder(id);
      await loadOrders();
    } catch (e: any) {
      toastError(e.message || '取消失败');
    } finally {
      setOrderActionLoading(null);
    }
  }

  async function handleRefundOrder(id: string) {
    setOrderActionLoading(id);
    try {
      const res = await serverApi.refundOrder(id);
      await loadOrders();
      setRefundStatusMsg(res.message || '退款申请已提交，等待确认');
      startRefundPolling(id);
    } catch (e: any) {
      toastError(e.message || '退款申请失败');
    } finally {
      setOrderActionLoading(null);
      setRefundConfirmId(null);
    }
  }

  const startRefundPolling = useCallback((out_trade_no: string) => {
    if (refundTimerRef.current) clearInterval(refundTimerRef.current);
    setRefundPollingId(out_trade_no);
    let count = 0;
    const MAX_POLL_COUNT = 310;
    refundTimerRef.current = setInterval(async () => {
      count++;
      if (count > MAX_POLL_COUNT) {
        if (refundTimerRef.current) clearInterval(refundTimerRef.current);
        setRefundPollingId(null);
        setRefundStatusMsg('退款确认超时，请刷新页面查看最新状态');
        return;
      }
      try {
        const res = await serverApi.refundStatus(out_trade_no);
        if (res.status === 'refunded') {
          if (refundTimerRef.current) clearInterval(refundTimerRef.current);
          setRefundPollingId(null);
          setRefundStatusMsg('退款已完成，余额已返还');
          await loadOrders();
          await refreshUser();
          setTimeout(() => setRefundStatusMsg(''), 5000);
        } else if (res.status === 'paid' || res.status === 'assigned' || res.status === 'allocated') {
          if (refundTimerRef.current) clearInterval(refundTimerRef.current);
          setRefundPollingId(null);
          setRefundStatusMsg('退款申请被拒绝，订单状态已恢复');
          await loadOrders();
          setTimeout(() => setRefundStatusMsg(''), 5000);
        } else if (res.status === 'refund_change') {
          if (refundTimerRef.current) clearInterval(refundTimerRef.current);
          setRefundPollingId(null);
          setRefundStatusMsg('退款异常，请联系客服');
          await loadOrders();
          setTimeout(() => setRefundStatusMsg(''), 8000);
        }
      } catch {
        // transient error, continue polling
      }
    }, 3000);
  }, [loadOrders, refreshUser]);

  useEffect(() => {
    const refundingOrder = orders.find(o => o.status === 'refunding');
    if (refundingOrder && !refundPollingId) {
      startRefundPolling(refundingOrder.out_trade_no);
    }
  }, [orders, refundPollingId, startRefundPolling]);

  async function loadModels() {
    try {
      const list = await serverApi.getModels();
      setModels(list);
    } catch (e) {
      console.error('[loadModels] 获取模型列表失败:', e);
    }
  }

  async function loadPackages() {
    try {
      const data = await serverApi.getPackages();
      setPkg(data);
    } catch {
      setPkg(null);
    }
  }

  const exchangeRate = pkg?.exchange_rate || 0;
  const payLimits: PayLimits | null = pkg?.limits ?? null;
  const minUsdTotal = payLimits?.min_total_usd ?? 1;
  const maxUsdTotal = payLimits?.max_total_usd ?? 1000;
  const modelPrice = pkg?.model?.price_per_call_usd
    ? `$${Number(pkg.model.price_per_call_usd).toFixed(4)}/次`
    : '';

  const amountValue = parseFloat(amount) || 0;
  const totalCny = exchangeRate ? amountValue * exchangeRate : 0;

  function setAmountInput(value: string) {
    if (!/^\d{0,4}(\.\d{0,2})?$/.test(value) && value !== '') return;
    setAmount(value);
  }

  function setPresetAmount(v: number) {
    setAmount(v.toFixed(2));
  }

  function openRechargeConfirm() {
    if (amountValue < minUsdTotal) {
      toastError(`充值金额需至少 $${minUsdTotal.toFixed(2)}，当前 $${amountValue.toFixed(2)}`);
      return;
    }
    if (amountValue > maxUsdTotal) {
      toastError(`充值金额不能超过 $${maxUsdTotal.toFixed(2)}`);
      return;
    }
    setRechargeConfirmOpen(true);
  }

  async function handleBuy() {
    setRechargeConfirmOpen(false);
    setOrdering(true);
    setStatusMsg('正在创建订单...');
    try {
      const r = await serverApi.createOrder(amountValue);
      const newOrders: PendingOrder[] = [{
        out_trade_no: r.out_trade_no,
        amount_usd: r.amount_usd,
        amount_cny: r.amount_cny,
      }];
      setPendingOrders(newOrders);
      setAllocMap({ [r.out_trade_no]: 'pending' });

      if (r.code_url) {
        const qrDataUrl = await generatePaymentQrCode(r.code_url);
        setQrCodeUrl(qrDataUrl);
        setQrCodeLink(r.code_url);
        setStatusMsg('请使用微信扫描二维码支付');
      } else {
        setStatusMsg('订单已创建，等待支付...');
      }

      startPaymentPolling(newOrders);
    } catch (e: any) {
      toastError(explainError(e));
      setStatusMsg('');
    } finally {
      setOrdering(false);
    }
  }

  async function handleReplaceToken() {
    if (replacingToken) return;
    setReplacingToken(true);
    try {
      const res = await serverApi.replaceRuntimeToken();
      setRuntimeToken(res);
      // 立刻失效本地 runtime 缓存，下次生图即使用新 Token
      clearRuntimeConfig();
      toastSuccess(res.replaced
        ? `Runtime Token 已更换为 ${res.masked_token}`
        : `已分配 Runtime Token ${res.masked_token}`);
    } catch (e: any) {
      if (e?.code === 'NO_AVAILABLE_RUNTIME_TOKEN' || e?.detail?.code === 'NO_AVAILABLE_RUNTIME_TOKEN') {
        toastError('当前没有可更换的 Image2 Runtime Token，请联系管理员');
      } else {
        toastError(explainError(e));
      }
    } finally {
      setReplacingToken(false);
    }
  }

  const startPaymentPolling = useCallback((polledOrders: PendingOrder[]) => {
    if (allocTimerRef.current) clearInterval(allocTimerRef.current);
    setPolling(true);
    let count = 0;
    allocTimerRef.current = setInterval(async () => {
      count++;
      if (count > 100) {
        if (allocTimerRef.current) clearInterval(allocTimerRef.current);
        setPolling(false);
        for (const o of polledOrders) {
          try { await serverApi.closeOrder(o.out_trade_no); } catch {}
        }
        setAllocMap(prev => {
          const next = { ...prev };
          for (const o of polledOrders) {
            if (next[o.out_trade_no] === 'pending') next[o.out_trade_no] = 'closed';
          }
          return next;
        });
        setQrCodeUrl('');
        setQrCodeLink('');
        setStatusMsg('支付超时，订单已关闭。如需充值请重新下单。');
        return;
      }
      let allDone = true;
      let anyPaid = false;
      const next: Record<string, AllocStatus> = {};
      for (const o of polledOrders) {
        try {
          const s = await serverApi.queryOrder(o.out_trade_no);
          if (s.status === 'closed') {
            next[o.out_trade_no] = 'closed';
          } else if (s.status === 'assigned' || s.status === 'allocated') {
            // status 到 assigned 即充值到账（不再依赖 api_token）
            next[o.out_trade_no] = 'allocated';
          } else if (s.status === 'paid') {
            next[o.out_trade_no] = 'paid';
            anyPaid = true;
            allDone = false;
          } else {
            next[o.out_trade_no] = 'pending';
            allDone = false;
          }
        } catch {
          next[o.out_trade_no] = 'unknown';
          allDone = false;
        }
      }
      setAllocMap(next);
      if (anyPaid && qrCodeUrl) {
        setQrCodeUrl('');
        setQrCodeLink('');
        setStatusMsg('支付成功，等待充值到账...');
      }
      if (allDone) {
        if (allocTimerRef.current) clearInterval(allocTimerRef.current);
        setPolling(false);
        setStatusMsg('充值到账完成！');
        await refreshUser();
        setTimeout(() => {
          setPendingOrders([]);
          setAllocMap({});
          setAmount('');
          setQrCodeUrl('');
          setQrCodeLink('');
          setStatusMsg('');
        }, 3000);
      }
    }, 3000);
  }, [refreshUser, qrCodeUrl]);

  async function handleCancelPayment() {
    if (allocTimerRef.current) clearInterval(allocTimerRef.current);
    setPolling(false);
    for (const o of pendingOrders) {
      const st = allocMap[o.out_trade_no];
      if (st === 'pending' || st === 'paid') {
        try { await serverApi.closeOrder(o.out_trade_no); } catch {}
      }
    }
    setAllocMap(prev => {
      const next = { ...prev };
      for (const o of pendingOrders) {
        if (next[o.out_trade_no] !== 'allocated') next[o.out_trade_no] = 'closed';
      }
      return next;
    });
    setQrCodeUrl('');
    setQrCodeLink('');
    setStatusMsg('订单已取消');
  }

  const typeLabel =
    user?.account_type === 'trial' ? '试用账户' :
    user?.account_type === 'paid' ? '付费账户' : '普通账户';

  async function handleApplyTrial() {
    setTrialLoading(true);
    try {
      await upgradeTrial();
      await refreshUser();
      toastSuccess('试用额度已开通');
    } catch (e: any) {
      toastError(explainError(e));
    } finally {
      setTrialLoading(false);
    }
  }

  async function handleSelectUserAvatar() {
    const path = await api.selectImageFile();
    if (!path) return;
    try {
      await setAsAvatarFromPath(path);
    } catch (e: any) {
      toastError(e?.message || '头像设置失败，请重试');
    }
  }

  const trialExpired = user?.trial_expired;
  const balanceUsd = parseFloat(user?.balance_usd ?? '0') || 0;
  const trialCreditUsd = parseFloat(user?.trial_credit_usd ?? '0') || 0;

  // 未登录：显示登录入口
  if (!isLoggedIn || !user) {
    return (
      <div className="page account-page">
        <div className="page-header">
          <h2>我的账户</h2>
        </div>
        <div className="account-empty">
          <p className="account-empty-hint">请登录后查看账户信息、余额和充值</p>
          <button className="account-login-btn" onClick={showAuthPrompt}>
            立即登录 / 注册
          </button>
        </div>
      </div>
    );
  }

  const statusMap: Record<string, { label: string; cls: string }> = {
    pending:       { label: '待支付',   cls: 'pending' },
    paid:          { label: '已支付',   cls: 'paid' },
    allocated:     { label: '已到账',   cls: 'allocated' },
    closed:        { label: '已关闭',   cls: 'closed' },
    refunding:     { label: '退款中',   cls: 'refunding' },
    refunded:      { label: '已退款',   cls: 'refunded' },
    refund_change: { label: '退款异常', cls: 'refund_change' },
  };

  const presets = [5, 10, 20, 50];

  return (
    <div className="page account-page">
      <div className="page-header">
        <h2>我的账户</h2>
      </div>

      {/* 账户数据获取失败横幅：与"余额为 0"严格区分，绝不静默显示 $0 */}
      {refreshFailed && (
        <div className="account-error-banner">
          <div className="account-error-text">
            <strong>账户信息暂时无法获取</strong>
            <span>当前展示的可能是缓存的旧数据，请检查网络后重试。</span>
          </div>
          <button className="account-error-retry" onClick={refreshAccountData}>重新加载</button>
        </div>
      )}

      {/* 用户信息卡：头像 + 身份 + 统一余额 */}
      <div className="account-card">
        <div className="account-avatar-panel">
          <div className="account-avatar">
            {settings.user_avatar_data_url ? <img src={settings.user_avatar_data_url} alt="我的头像" /> : getInitials(user.username)}
          </div>
          <div className="account-avatar-actions">
            <button className="account-avatar-btn" onClick={handleSelectUserAvatar}>更换头像</button>
            <button className="account-avatar-btn secondary" onClick={() => { void clearAvatar(); }} disabled={!settings.user_avatar_data_url}>清除</button>
            <span className="account-avatar-hint">头像仅保存在本机</span>
          </div>
        </div>
        <div className="account-identity">
          <div className="account-identity-row">
            <span className="account-username">{user.username}</span>
            <span className={`info-badge ${user.account_type}`}>{typeLabel}</span>
          </div>
          {user.account_type === 'trial' && user.trial_expires_at && (
            <span className={`account-trial-expire ${trialExpired ? 'expired' : ''}`}>
              试用到期：{trialExpired ? '已过期' : user.trial_expires_at.replace('T', ' ').slice(0, 16)}
            </span>
          )}
          <div className="account-balances">
            <div className="account-balance-item">
              <span className="account-balance-label">💰 现金余额</span>
              <span className="account-balance-value">${balanceUsd.toFixed(2)}</span>
            </div>
            <div className="account-balance-item">
              <span className="account-balance-label">🎁 试用额度</span>
              <span className="account-balance-value">${trialCreditUsd.toFixed(2)}</span>
            </div>
          </div>
        </div>
        <div className="account-actions">
          {user.account_type === 'normal' && (
            <button className="upgrade-trial-btn" onClick={handleApplyTrial} disabled={trialLoading}>
              {trialLoading ? '申请中...' : '申请试用'}
            </button>
          )}
          <button className="logout-btn" onClick={logout}>退出登录</button>
        </div>
      </div>

      {/* Image2 服务：Runtime Token 状态（仅脱敏信息） */}
      <div className="account-section">
        <h3>Image2 服务</h3>
        <div className="runtime-card">
          <div className="runtime-card-icon">🎨</div>
          <div className="runtime-card-body">
            {runtimeToken ? (
              <>
                <div className="runtime-card-title">
                  GPT Image 2
                  {runtimeToken.source === 'assigned' && (
                    <span className={`runtime-badge ${runtimeToken.is_trial ? 'trial' : 'formal'}`}>
                      {runtimeToken.is_trial ? '试用' : '正式'}
                    </span>
                  )}
                  <span className={`runtime-badge ${runtimeToken.is_disabled ? 'disabled' : 'ok'}`}>
                    {runtimeToken.is_disabled ? '已禁用' : '正常'}
                  </span>
                </div>
                <div className="runtime-card-token-row">
                  <span className="runtime-card-label">Runtime Token</span>
                  <span className="runtime-card-token">{runtimeToken.masked_token || '-'}</span>
                  {runtimeToken.source === 'server_master' && (
                    <span className="runtime-card-hint">系统默认 Token（未单独分配）</span>
                  )}
                </div>
              </>
            ) : (
              <div className="runtime-card-title">
                GPT Image 2
                <span className="runtime-card-hint">Runtime Token 状态获取失败，生成不受影响</span>
              </div>
            )}
          </div>
          <button className="runtime-replace-btn" onClick={handleReplaceToken} disabled={replacingToken}>
            {replacingToken ? '更换中...' : runtimeToken?.source === 'assigned' ? '更换 Token' : '领取可用 Token'}
          </button>
        </div>
      </div>

      {/* 充值面板：单一余额充值（Image2 按次计费） */}
      <div className="account-section">
        <h3>余额充值</h3>
        <div className="recharge-grid">
          <div className="recharge-card highlight">
            <div className="recharge-card-header">
              <span className="recharge-card-icon">🎨</span>
              <span className="recharge-card-title">Image2 生成额度</span>
              <button className="recharge-card-info-btn" title="查看扣费标准" onClick={() => setShowPricingDialog(true)}>
                !
              </button>
            </div>
            <p className="recharge-card-desc">
              用于文生图、图生图等全部图片生成任务。
              {modelPrice && <>当前单价 <strong>{modelPrice}</strong>（消费时试用额度优先扣除）。</>}
            </p>
            <div className="recharge-card-body">
              <div className="recharge-card-row">
                <div className="recharge-presets">
                  {presets.map(v => (
                    <button
                      key={v}
                      className={`recharge-preset-btn ${amountValue === v ? 'active' : ''}`}
                      onClick={() => setPresetAmount(v)}
                    >
                      ${v}
                    </button>
                  ))}
                </div>
                <div className="recharge-card-input">
                  <span className="recharge-card-input-label">自定义</span>
                  <div className="recharge-input-wrap">
                    <span className="recharge-currency">$</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={amount}
                      onChange={e => setAmountInput(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </div>
            <div className="recharge-summary">
              <div className="recharge-summary-row">
                <span className="recharge-summary-total">
                  合计 <strong>${amountValue.toFixed(2)}</strong>{exchangeRate > 0 && <> ≈ ¥{totalCny.toFixed(2)}</>}
                </span>
                {exchangeRate > 0 && <span className="recharge-summary-rate">汇率 {exchangeRate.toFixed(2)}</span>}
              </div>
              <div className="recharge-summary-hint">
                {amountValue > 0 && amountValue < minUsdTotal
                  ? `还差 $${(minUsdTotal - amountValue).toFixed(2)} 可发起支付`
                  : `最低充值 ${minUsdTotal.toFixed(2)} · 单笔上限 ${maxUsdTotal.toFixed(0)}`}
              </div>
              <div className="recharge-summary-actions">
                <span className="recharge-pay-label">仅支持微信支付</span>
                <button
                  className="buy-btn"
                  disabled={ordering || polling || amountValue < minUsdTotal || amountValue > maxUsdTotal}
                  onClick={openRechargeConfirm}
                >
                  {ordering ? '下单中...' : polling ? '等待支付...' : '立即充值'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* 订单状态卡片 */}
        {pendingOrders.length > 0 && (
          <div className="alloc-box">
            <div className="alloc-status-row">
              {polling && <span className="alloc-spinner" />}
              <span className="alloc-status-text">{statusMsg}</span>
            </div>

            {qrCodeUrl && polling && (
              <div className="qr-pay-box">
                <img className="qr-pay-img" src={qrCodeUrl} alt="微信支付二维码" />
                <p className="qr-pay-hint">请使用微信扫描上方二维码完成支付</p>
                {qrCodeLink && (
                  <a className="qr-pay-link" href={qrCodeLink} target="_blank" rel="noopener noreferrer">
                    无法扫码？点击链接支付
                  </a>
                )}
                <button className="qr-pay-cancel" onClick={handleCancelPayment}>
                  取消支付
                </button>
              </div>
            )}

            <div className="alloc-orders">
              {pendingOrders.map(o => {
                const st = allocMap[o.out_trade_no] ?? 'pending';
                const tagText =
                  st === 'allocated' ? '✓ 已到账' :
                  st === 'paid' ? '⏳ 等待到账' :
                  st === 'closed' ? '已关闭' :
                  st === 'unknown' ? '查询中' : '待支付';
                return (
                  <div key={o.out_trade_no} className="alloc-order-row">
                    <span className="alloc-order-info">
                      余额充值 · ${o.amount_usd.toFixed(2)}（¥{o.amount_cny.toFixed(2)}）
                    </span>
                    <span className={`alloc-tag alloc-tag-${st}`}>{tagText}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* 用量统计：趋势 / 模型 / 明细（数据全部来自服务器 usage 聚合接口） */}
      <div className="account-section">
        <h3>最近用量</h3>
        <AccountUsagePanel />
      </div>

      {/* 扣费标准弹窗 */}
      {showPricingDialog && (
        <PricingDialog
          models={models}
          usageRecords={usageRecords}
          onLoadRecords={async () => {
            try {
              const data = await serverApi.getUsageRecords();
              setUsageRecords(data.records);
              return data.records;
            } catch { return []; }
          }}
          onClose={() => setShowPricingDialog(false)}
        />
      )}

      {/* 订单查询 */}
      <div className="account-section order-history-section">
        <h3>订单查询</h3>
        {refundStatusMsg && <div className="refund-status-bar">{refundStatusMsg}</div>}
        {ordersLoading ? (
          <p className="balance-empty">加载中...</p>
        ) : orders.length === 0 ? (
          <p className="balance-empty">暂无订单记录</p>
        ) : (
          <table className="order-table">
            <thead>
              <tr>
                <th>订单号</th>
                <th>创建时间</th>
                <th>支付时间</th>
                <th>付款金额</th>
                <th>到账金额</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(o => {
                const sm = statusMap[o.status] ?? { label: o.status, cls: 'pending' };
                const payCny = o.amount_cny ?? o.total_cny ?? 0;
                const gotUsd = o.amount_usd ?? o.total_usd ?? 0;
                return (
                  <tr key={o.out_trade_no}>
                    <td className="order-cell-id">{o.out_trade_no.slice(-8)}</td>
                    <td>{o.created_at?.replace('T', ' ').slice(0, 16) || '-'}</td>
                    <td>{o.paid_at?.replace('T', ' ').slice(0, 16) || '-'}</td>
                    <td>¥{Number(payCny).toFixed(2)}</td>
                    <td>${Number(gotUsd).toFixed(2)}</td>
                    <td><span className={`order-item-tag ${sm.cls}`}>{sm.label}</span>{refundPollingId === o.out_trade_no && <span className="refund-polling-spinner" />}</td>
                    <td className="order-cell-actions">
                      {o.status === 'pending' && (
                        <button className="order-action-btn cancel" disabled={orderActionLoading === o.out_trade_no} onClick={() => handleCancelOrder(o.out_trade_no)}>
                          {orderActionLoading === o.out_trade_no ? '...' : '取消'}
                        </button>
                      )}
                      {(o.status === 'paid' || o.status === 'allocated') && (
                        <button className="order-action-btn refund" disabled={orderActionLoading === o.out_trade_no} onClick={() => setRefundConfirmId(o.out_trade_no)}>
                          {orderActionLoading === o.out_trade_no ? '...' : '退款'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 充值确认弹窗（应用内 UI，禁止系统弹窗） */}
      {rechargeConfirmOpen && (
        <div className="refund-confirm-overlay" onClick={() => setRechargeConfirmOpen(false)}>
          <div className="refund-confirm-dialog" onClick={e => e.stopPropagation()}>
            <h3>充值确认</h3>
            <div className="recharge-confirm-rows">
              <div className="recharge-confirm-row">
                <span>充值金额</span>
                <strong>${amountValue.toFixed(2)}</strong>
              </div>
              <div className="recharge-confirm-row">
                <span>支付方式</span>
                <strong>微信支付</strong>
              </div>
              <div className="recharge-confirm-row">
                <span>预计支付</span>
                <strong>{exchangeRate > 0 ? `¥${totalCny.toFixed(2)}` : '以下单汇率为准'}</strong>
              </div>
              {exchangeRate > 0 && (
                <div className="recharge-confirm-row muted">
                  <span>汇率</span>
                  <span>1 USD ≈ {exchangeRate.toFixed(2)} CNY（以下单时服务端快照为准）</span>
                </div>
              )}
            </div>
            <div className="refund-confirm-actions">
              <button className="refund-confirm-cancel" onClick={() => setRechargeConfirmOpen(false)}>取消</button>
              <button
                className="refund-confirm-ok"
                disabled={ordering}
                onClick={handleBuy}
              >
                {ordering ? '创建订单中...' : '确认充值'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 退款确认弹窗 */}
      {refundConfirmId && (() => {
        const ro = orders.find(o => o.out_trade_no === refundConfirmId);
        return (
          <div className="refund-confirm-overlay" onClick={() => setRefundConfirmId(null)}>
            <div className="refund-confirm-dialog" onClick={e => e.stopPropagation()}>
              <h3>申请退款</h3>
              <p className="refund-confirm-hint">
                {ro
                  ? <>订单 <strong>{ro.out_trade_no}</strong>，金额 <strong>${Number(ro.total_usd ?? ro.amount_usd).toFixed(2)}</strong>{(ro.total_cny ?? ro.amount_cny ?? 0) > 0 && <>（¥{Number(ro.total_cny ?? ro.amount_cny).toFixed(2)}）</>}<br />提交退款申请后需等待管理员确认，确认后余额将返还。是否提交退款申请？</>
                  : '提交退款申请后需等待管理员确认，确认后余额将返还。是否提交退款申请？'}
              </p>
              <div className="refund-confirm-actions">
                <button className="refund-confirm-cancel" onClick={() => setRefundConfirmId(null)}>取消</button>
                <button
                  className="refund-confirm-ok"
                  disabled={orderActionLoading === refundConfirmId}
                  onClick={() => handleRefundOrder(refundConfirmId)}
                >
                  {orderActionLoading === refundConfirmId ? '提交中...' : '提交申请'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/* ─── 扣费标准弹窗 ─── */
interface PricingDialogProps {
  models: ServerModel[];
  usageRecords: UsageRecord[];
  onLoadRecords: () => Promise<UsageRecord[]>;
  onClose: () => void;
}

function PricingDialog({ models, usageRecords, onLoadRecords, onClose }: PricingDialogProps) {
  const [showRecords, setShowRecords] = useState(false);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [records, setRecords] = useState(usageRecords);

  async function handleLoadRecords() {
    if (showRecords) {
      setShowRecords(false);
      return;
    }
    setRecordsLoading(true);
    try {
      const data = await onLoadRecords();
      setRecords(data);
      setShowRecords(true);
    } catch {} finally {
      setRecordsLoading(false);
    }
  }

  return (
    <div className="pricing-dialog-overlay" onClick={onClose}>
      <div className="pricing-dialog" onClick={e => e.stopPropagation()}>
        <div className="pricing-dialog-header">
          <h3>扣费标准</h3>
          <button className="pricing-dialog-close" onClick={onClose}>✕</button>
        </div>

        <table className="pricing-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>提供商</th>
              <th>类型</th>
              <th>计费方式</th>
              <th>单价</th>
            </tr>
          </thead>
          <tbody>
            {models.map(m => (
              <tr key={m.name}>
                <td>{m.display_name || m.name}</td>
                <td>{m.provider}</td>
                <td>图片</td>
                <td>按次计费</td>
                <td>
                  {m.billing_type === 'per_call'
                    ? (m.price_per_call ? `$${m.price_per_call}/次` : '-')
                    : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="pricing-dialog-footer">
          <button className="pricing-records-btn" onClick={handleLoadRecords} disabled={recordsLoading}>
            {recordsLoading ? '加载中...' : showRecords ? '收起费目详情' : '查看费目详情'}
          </button>
        </div>

        {showRecords && records.length > 0 && (
          <table className="pricing-records-table">
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
              {records.slice(0, 50).map((r, i) => {
                const qty = r.image_count ?? 0;
                const isImage = r.usage_type === 'image';
                return (
                <tr key={i}>
                  <td>{r.model}</td>
                  <td>{isImage ? '图片' : '其他'}</td>
                  <td>{isImage ? `${qty} 张` : '-'}</td>
                  <td>${Number(r.cost_usd).toFixed(4)}</td>
                  <td>{r.created_at?.replace('T', ' ').slice(0, 16)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
