import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { serverApi, type ServerModel, type UserOrder, type UsageRecord, type PackagesResponse, type RuntimeTokenStatus } from '../services/serverApi';
import { useServerModelStore } from '../store/useServerModelStore';
import { api } from '../services/api';
import { setAsAvatarFromPath, clearAvatar } from '../services/avatarService';
import { clearRuntimeConfig, loadRuntimeConfig } from '../services/runtimeTokenService';
import { toastError, toastSuccess } from '../components/Toast';
import {
  clearRechargeReturnContext,
  readRechargeReturnContext,
} from '../components/QuoteConfirmDialog';
import AccountUsagePanel from '../components/AccountUsagePanel';
import AccountLedgerPanel from '../components/AccountLedgerPanel';
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
  // 服务器模型统一来自 useServerModelStore（runtimeReady 后同步、断网自动恢复、按 Server 隔离缓存）
  const serverModels = useServerModelStore(s => s.models);
  const syncServerModels = useServerModelStore(s => s.sync);
  const [pkg, setPkg] = useState<PackagesResponse | null>(null);
  const [runtimeToken, setRuntimeToken] = useState<RuntimeTokenStatus | null>(null);
  const [amount, setAmount] = useState('');
  const [ordering, setOrdering] = useState(false);
  const [rechargeConfirmOpen, setRechargeConfirmOpen] = useState(false);
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([]);
  const [allocMap, setAllocMap] = useState<Record<string, AllocStatus>>({});
  const [polling, setPolling] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('');
  const [qrCodeLink, setQrCodeLink] = useState<string>('');
  const [qrRemainSec, setQrRemainSec] = useState(0);
  const [showPricingDialog, setShowPricingDialog] = useState(false);
  const [usageRecords, setUsageRecords] = useState<UsageRecord[]>([]);
  const [orders, setOrders] = useState<UserOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [orderActionLoading, setOrderActionLoading] = useState<string | null>(null);
  const [refundConfirmId, setRefundConfirmId] = useState<string | null>(null);
  const [refundPollingId, setRefundPollingId] = useState<string | null>(null);
  const [refundStatusMsg, setRefundStatusMsg] = useState('');
  /** 「去充值」带回的返回上下文（充值完成可一键回到生成页；一次性消费）。 */
  const [rechargeReturnTarget, setRechargeReturnTarget] = useState<{ page: string } | null>(
    () => readRechargeReturnContext());
  const allocTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refundTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshAccountData = useCallback(() => {
    void refreshUser();
    loadRuntimeToken();
  }, [refreshUser]);

  useEffect(() => {
    if (!isLoggedIn) return;
    refreshUser();
    void syncServerModels();
    loadPackages();
    loadOrders();
    loadRuntimeToken();
  }, [isLoggedIn, syncServerModels]);

  // 模型列表跟随统一 store（替代页面私有 getModels 请求）
  useEffect(() => { setModels(serverModels); }, [serverModels]);

  // 深链聚焦充值区（QuoteConfirmDialog「去充值」→ cyimage-navigate section=recharge）：
  // 挂载时 + 事件到达时滚动到充值面板并短暂高亮，一次性消费后清除标记
  useEffect(() => {
    const focusRecharge = () => {
      if (localStorage.getItem('cy_account_section') !== 'recharge') return;
      localStorage.removeItem('cy_account_section');
      const el = document.getElementById('account-recharge');
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.add('is-focus-flash');
      window.setTimeout(() => el.classList.remove('is-focus-flash'), 2400);
    };
    focusRecharge();
    window.addEventListener('cy-account-section', focusRecharge);
    return () => window.removeEventListener('cy-account-section', focusRecharge);
  }, []);

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

  // 二维码剩余支付时间倒计时（与轮询窗口 5 分钟对齐）
  useEffect(() => {
    if (qrRemainSec <= 0) return;
    const t = setTimeout(() => setQrRemainSec(s => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearTimeout(t);
  }, [qrRemainSec]);

  async function loadOrders() {
    setOrdersLoading(true);
    try {
      const raw = await serverApi.getOrders();
      const data: UserOrder[] = raw.map((o: any) => ({
        out_trade_no: o.out_trade_no,
        group: o.group ?? '',
        amount_usd: Number(o.amount_usd ?? o.total_usd ?? 0),
        amount_cny: Number(o.amount_cny ?? o.total_cny ?? 0),
        credits_granted: o.credits_granted ?? null,
        total_usd: Number(o.total_usd ?? o.amount_usd ?? 0),
        total_cny: Number(o.total_cny ?? o.amount_cny ?? 0),
        exchange_rate: o.exchange_rate ?? null,
        refunded_cny: Number(o.refunded_cny ?? 0),
        status: o.status === 'assigned' ? 'allocated' : o.status,
        pay_type: o.pay_type ?? '',
        items: Array.isArray(o.items) ? o.items : [],
        created_at: o.created_at ?? '',
        paid_at: o.paid_at ?? null,
        refund_request: o.refund_request ?? null,
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
      // 服务端已持久化退款申请并更新订单状态，立即重拉列表反映"退款申请中"
      await loadOrders();
      setRefundStatusMsg(res.message || '退款申请已提交，等待审核');
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
        if (res.status === 'refunded' || res.status === 'partially_refunded') {
          if (res.status === 'refunded') {
            if (refundTimerRef.current) clearInterval(refundTimerRef.current);
            setRefundPollingId(null);
          }
          setRefundStatusMsg(res.status === 'refunded' ? '退款已完成，余额已冲正' : '部分退款已完成');
          await loadOrders();
          await refreshUser();
          if (res.status === 'refunded') setTimeout(() => setRefundStatusMsg(''), 5000);
        } else if (res.status === 'paid' || res.status === 'assigned' || res.status === 'allocated') {
          // 订单回到可用状态：退款申请被拒绝（或处理失败回退）
          if (refundTimerRef.current) clearInterval(refundTimerRef.current);
          setRefundPollingId(null);
          const note = res.refund_request?.review_note;
          const failure = res.refund_request?.failure_reason;
          setRefundStatusMsg(
            res.refund_request?.status === 'rejected'
              ? `退款申请被拒绝${note ? `：${note}` : ''}`
              : failure ? `退款失败：${failure}` : '退款申请被拒绝，订单状态已恢复',
          );
          await loadOrders();
          setTimeout(() => setRefundStatusMsg(''), 8000);
        } else if (res.status === 'refund_change') {
          if (refundTimerRef.current) clearInterval(refundTimerRef.current);
          setRefundPollingId(null);
          setRefundStatusMsg('退款异常，请联系客服');
          await loadOrders();
          setTimeout(() => setRefundStatusMsg(''), 8000);
        }
        // refund_requested / refunding：继续轮询等待后台审核与微信确认
      } catch {
        // transient error, continue polling
      }
    }, 3000);
  }, [loadOrders, refreshUser]);

  useEffect(() => {
    const refundingOrder = orders.find(o => o.status === 'refunding' || o.status === 'refund_requested');
    if (refundingOrder && !refundPollingId) {
      startRefundPolling(refundingOrder.out_trade_no);
    }
  }, [orders, refundPollingId, startRefundPolling]);

  async function loadPackages() {
    try {
      const data = await serverApi.getPackages();
      setPkg(data);
    } catch {
      setPkg(null);
    }
  }

  // CY Credits：兑换率与充值档位全部来自服务端（¥1 = credits_per_cny 点）
  const creditsPerCny = pkg?.credits_per_cny ?? 100;
  const exchangeRate = pkg?.exchange_rate || 0;
  const exchangeRateSource = pkg?.exchange_rate_source ?? '';
  const minCnyTotal = pkg?.limits?.min_cny ?? 1;
  const maxCnyTotal = pkg?.limits?.max_cny ?? 5000;
  const unitCredits = pkg?.unit_credits ?? null;
  const modelPrice = unitCredits != null ? `${unitCredits} 点/次` : '';

  const amountValue = parseFloat(amount) || 0;
  const estimatedCredits = Math.floor(amountValue * creditsPerCny);

  function setAmountInput(value: string) {
    if (!/^\d{0,4}(\.\d{0,2})?$/.test(value) && value !== '') return;
    setAmount(value);
  }

  function setPresetAmount(v: number) {
    setAmount(v.toFixed(2));
  }

  function openRechargeConfirm() {
    if (amountValue < minCnyTotal) {
      toastError(`充值金额需至少 ¥${minCnyTotal}，当前 ¥${amountValue.toFixed(2)}`);
      return;
    }
    if (amountValue > maxCnyTotal) {
      toastError(`充值金额不能超过 ¥${maxCnyTotal}`);
      return;
    }
    setRechargeConfirmOpen(true);
  }

  async function handleBuy() {
    setRechargeConfirmOpen(false);
    setOrdering(true);
    setStatusMsg('正在创建订单...');
    try {
      const r = await serverApi.createOrderCny(amountValue);
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
        setQrRemainSec(300);
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
        setQrRemainSec(0);
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
        setQrRemainSec(0);
        setQrCodeLink('');
        setStatusMsg('支付成功，等待充值到账...');
      }
      if (allDone) {
        if (allocTimerRef.current) clearInterval(allocTimerRef.current);
        setPolling(false);
        setStatusMsg('充值到账完成！');
        await refreshUser();
        // 到账后刷新 Runtime 配置（服务端已自动绑定默认正式 Token）
        clearRuntimeConfig();
        loadRuntimeToken();
        try { await loadRuntimeConfig(); } catch {}
        const creditedCny = polledOrders
          .map(o => o.amount_cny)
          .filter((v, i, a) => a.indexOf(v) === i)
          .reduce((s, v) => s + v, 0);
        const creditedCredits = Math.floor(creditedCny * creditsPerCny);
        toastSuccess(`充值成功，+${creditedCredits.toLocaleString()} 点已到账`);
        setTimeout(() => {
          setPendingOrders([]);
          setAllocMap({});
          setAmount('');
          setQrCodeUrl('');
          setQrCodeLink('');
          setQrRemainSec(0);
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
    setQrRemainSec(0);
    setStatusMsg('订单已取消');
  }

  const typeLabel =
    user?.account_type === 'trial' ? '试用账户' :
    user?.account_type === 'paid' ? '付费账户' : '普通账户';

  async function handleApplyTrial() {
    setTrialLoading(true);
    try {
      // Trial Entitlement V1：一次性领取（同邮箱一生一次，服务端 claim ledger 判定）
      const res = await serverApi.claimTrial();
      await refreshUser();
      toastSuccess(`试用点数已开通：+${res.grant_credits} 点`);
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
  const paidCredits = user?.paid_credits ?? 0;
  const trialCredits = user?.trial_credits ?? 0;
  const giftCredits = user?.gift_credits ?? 0;
  const totalCredits = user?.total_credits ?? (paidCredits + trialCredits + giftCredits);
  const trialAvailable = user?.trial_available ?? false;

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
    pending:            { label: '待支付',     cls: 'pending' },
    paid:               { label: '已支付',     cls: 'paid' },
    allocated:          { label: '已到账',     cls: 'allocated' },
    closed:             { label: '已关闭',     cls: 'closed' },
    refund_requested:   { label: '退款申请中', cls: 'refunding' },
    refunding:          { label: '退款处理中', cls: 'refunding' },
    partially_refunded: { label: '已部分退款', cls: 'refunding' },
    refunded:           { label: '已退款',     cls: 'refunded' },
    refund_change:      { label: '退款异常',   cls: 'refund_change' },
  };

  const refundRequestStatusMap: Record<string, { label: string; cls: string }> = {
    requested:  { label: '退款待审核', cls: 'refunding' },
    approved:   { label: '退款已批准', cls: 'refunding' },
    processing: { label: '微信退款中', cls: 'refunding' },
    success:    { label: '退款成功',   cls: 'refunded' },
    rejected:   { label: '退款被拒绝', cls: 'refund_change' },
    failed:     { label: '退款失败',   cls: 'refund_change' },
  };

  const presets = [10, 20, 50, 100];

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
            <div className="account-balance-item primary">
              <span className="account-balance-label">可用点数</span>
              <span className="account-balance-value">{totalCredits.toLocaleString()} 点</span>
            </div>
            <div className="account-balance-item">
              <span className="account-balance-label">正式点数</span>
              <span className="account-balance-value">{paidCredits.toLocaleString()}</span>
            </div>
            <div className="account-balance-item">
              <span className="account-balance-label">试用点数</span>
              <span className="account-balance-value">{trialCredits.toLocaleString()}</span>
            </div>
            <div className="account-balance-item">
              <span className="account-balance-label">赠送点数</span>
              <span className="account-balance-value">{giftCredits.toLocaleString()}</span>
            </div>
          </div>
        </div>
        <div className="account-actions">
          {user.account_type === 'normal' && trialAvailable && (
            <button className="upgrade-trial-btn" onClick={handleApplyTrial} disabled={trialLoading}>
              {trialLoading ? '申请中...' : '申请免费试用'}
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
          {runtimeToken?.source === 'assigned' && (
            <span className="runtime-card-hint">由系统自动分配（注册 / 充值时绑定），如需调整请联系管理员</span>
          )}
        </div>
      </div>

      {/* 充值面板：CY 点数直购（¥1 = credits_per_cny 点，兑换率由服务端统一下发） */}
      <div className="account-section" id="account-recharge">
        <h3>点数充值</h3>
        {rechargeReturnTarget && (
          <button
            type="button"
            className="account-return-link"
            data-testid="recharge-return-link"
            onClick={() => {
              const target = rechargeReturnTarget;
              clearRechargeReturnContext();
              setRechargeReturnTarget(null);
              window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: target.page } }));
            }}
          >← 充值完成后返回继续生成</button>
        )}
        <div className="recharge-grid">
          <div className="recharge-card highlight">
            <div className="recharge-card-header">
              <span className="recharge-card-icon">🎨</span>
              <span className="recharge-card-title">Image2 生成点数</span>
              <button className="recharge-card-info-btn" title="查看扣费标准" onClick={() => setShowPricingDialog(true)}>
                !
              </button>
            </div>
            <p className="recharge-card-desc">
              用于文生图、图生图等全部图片生成任务。
              {modelPrice && <>当前单张 <strong>{modelPrice}</strong>（消费时试用点数优先扣除）。</>}
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
                      ¥{v}
                    </button>
                  ))}
                </div>
                <div className="recharge-card-input">
                  <span className="recharge-card-input-label">自定义</span>
                  <div className="recharge-input-wrap">
                    <span className="recharge-currency">¥</span>
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
                  支付 <strong>¥{amountValue.toFixed(2)}</strong>
                  {amountValue > 0 && <> → 预计获得 <strong>{estimatedCredits.toLocaleString()} 点</strong></>}
                </span>
                <span className="recharge-summary-rate">¥1 = {creditsPerCny} 点</span>
              </div>
              <div className="recharge-summary-hint">
                {amountValue > 0 && amountValue < minCnyTotal
                  ? `还差 ¥${(minCnyTotal - amountValue).toFixed(2)} 可发起支付`
                  : `最低充值 ¥${minCnyTotal} · 单笔上限 ¥${maxCnyTotal}`}
              </div>
              <div className="recharge-summary-actions">
                <span className="recharge-pay-label">仅支持微信支付</span>
                <button
                  className="buy-btn"
                  disabled={ordering || polling || amountValue < minCnyTotal || amountValue > maxCnyTotal}
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
                {qrRemainSec > 0 && (
                  <p className="qr-pay-timer">
                    订单号 {pendingOrders[0]?.out_trade_no ?? ''} · 剩余时间{" "}
                    {String(Math.floor(qrRemainSec / 60)).padStart(2, '0')}:
                    {String(qrRemainSec % 60).padStart(2, '0')}
                  </p>
                )}
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
                      点数充值 · ¥{o.amount_cny.toFixed(2)}（+{Math.floor(o.amount_cny * creditsPerCny).toLocaleString()} 点）
                    </span>
                    <span className={`alloc-tag alloc-tag-${st}`}>{tagText}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* 点数流水：充值 / 消费 / 释放 / 退款 / 试用 / 赠送（Wallet / Ledger Pattern） */}
      <div className="account-section">
        <h3>点数流水</h3>
        <AccountLedgerPanel />
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
          unitCredits={unitCredits}
          creditsPerCny={creditsPerCny}
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
                const rsm = o.refund_request && o.refund_request.status !== 'success'
                  ? refundRequestStatusMap[o.refund_request.status]
                  : null;
                const payCny = o.amount_cny ?? o.total_cny ?? 0;
                const gotUsd = o.amount_usd ?? o.total_usd ?? 0;
                const refundedCny = o.refunded_cny ?? 0;
                const remainingCny = Math.max(0, Number(payCny) - refundedCny);
                const hasOpenRefund = o.refund_request
                  && ['requested', 'approved', 'processing'].includes(o.refund_request.status);
                return (
                  <tr key={o.out_trade_no}>
                    <td className="order-cell-id">{o.out_trade_no.slice(-8)}</td>
                    <td>{o.created_at?.replace('T', ' ').slice(0, 16) || '-'}</td>
                    <td>{o.paid_at?.replace('T', ' ').slice(0, 16) || '-'}</td>
                    <td>¥{Number(payCny).toFixed(2)}</td>
                    <td>{o.credits_granted != null ? `${o.credits_granted.toLocaleString()} 点` : `$${Number(gotUsd).toFixed(2)}`}</td>
                    <td>
                      <span className={`order-item-tag ${sm.cls}`}>{sm.label}</span>
                      {rsm && <span className={`order-item-tag ${rsm.cls}`} style={{ marginLeft: 4 }}>{rsm.label}</span>}
                      {o.refund_request?.status === 'rejected' && o.refund_request.review_note && (
                        <div className="order-refund-note">拒绝原因：{o.refund_request.review_note}</div>
                      )}
                      {refundPollingId === o.out_trade_no && <span className="refund-polling-spinner" />}
                    </td>
                    <td className="order-cell-actions">
                      {o.status === 'pending' && (
                        <button className="order-action-btn cancel" disabled={orderActionLoading === o.out_trade_no} onClick={() => handleCancelOrder(o.out_trade_no)}>
                          {orderActionLoading === o.out_trade_no ? '...' : '取消'}
                        </button>
                      )}
                      {(o.status === 'paid' || o.status === 'allocated' || o.status === 'partially_refunded') && !hasOpenRefund && remainingCny > 0 && (
                        <button className="order-action-btn refund" disabled={orderActionLoading === o.out_trade_no} onClick={() => setRefundConfirmId(o.out_trade_no)}>
                          {orderActionLoading === o.out_trade_no ? '...' : o.status === 'partially_refunded' ? '退剩余款' : '退款'}
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
                <span>支付金额</span>
                <strong>¥{amountValue.toFixed(2)}</strong>
              </div>
              <div className="recharge-confirm-row">
                <span>预计获得</span>
                <strong>{estimatedCredits.toLocaleString()} CY 点</strong>
              </div>
              <div className="recharge-confirm-row">
                <span>支付方式</span>
                <strong>微信支付</strong>
              </div>
              <div className="recharge-confirm-row muted">
                <span>兑换率</span>
                <span>¥1 = {creditsPerCny} 点（到账点数以下单快照为准）</span>
              </div>
            </div>
            <div className="refund-confirm-actions">
              <button className="refund-confirm-cancel" onClick={() => setRechargeConfirmOpen(false)}>取消</button>
              <button
                className="refund-confirm-ok"
                disabled={ordering}
                onClick={handleBuy}
              >
                {ordering ? '创建订单中...' : `确认充值 · ${estimatedCredits.toLocaleString()} 点`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 退款申请弹窗 */}
      {refundConfirmId && (() => {
        const ro = orders.find(o => o.out_trade_no === refundConfirmId);
        const payCny = Number(ro?.total_cny ?? ro?.amount_cny ?? 0);
        const gotUsd = Number(ro?.total_usd ?? ro?.amount_usd ?? 0);
        const remainingCny = Math.max(0, payCny - (ro?.refunded_cny ?? 0));
        return (
          <div className="refund-confirm-overlay" onClick={() => setRefundConfirmId(null)}>
            <div className="refund-confirm-dialog" onClick={e => e.stopPropagation()}>
              <h3>申请退款</h3>
              <div className="recharge-confirm-rows">
                <div className="recharge-confirm-row">
                  <span>订单号</span>
                  <strong className="order-refund-no">{refundConfirmId}</strong>
                </div>
                <div className="recharge-confirm-row">
                  <span>充值金额</span>
                  <strong>${gotUsd.toFixed(2)}</strong>
                </div>
                <div className="recharge-confirm-row">
                  <span>微信付款</span>
                  <strong>¥{payCny.toFixed(2)}</strong>
                </div>
                <div className="recharge-confirm-row">
                  <span>可申请退款</span>
                  <strong>${gotUsd.toFixed(2)} / ¥{remainingCny.toFixed(2)}</strong>
                </div>
                <div className="recharge-confirm-row muted">
                  <span>退款说明</span>
                  <span>退款申请需后台审核，批准后原路退回微信支付账户。</span>
                </div>
              </div>
              <div className="refund-confirm-actions">
                <button className="refund-confirm-cancel" onClick={() => setRefundConfirmId(null)}>取消</button>
                <button
                  className="refund-confirm-ok danger"
                  disabled={orderActionLoading === refundConfirmId}
                  onClick={() => handleRefundOrder(refundConfirmId)}
                >
                  {orderActionLoading === refundConfirmId ? '提交中...' : '提交退款申请'}
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
  unitCredits: number | null;
  creditsPerCny: number;
  usageRecords: UsageRecord[];
  onLoadRecords: () => Promise<UsageRecord[]>;
  onClose: () => void;
}

function PricingDialog({ models, unitCredits, creditsPerCny, usageRecords, onLoadRecords, onClose }: PricingDialogProps) {
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
                <td>按张计费</td>
                <td>
                  {unitCredits != null
                    ? `${unitCredits} 点/张（约 ¥${(unitCredits / creditsPerCny).toFixed(2)}）`
                    : (m.price_per_call ? `$${m.price_per_call}/次` : '-')}
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
                  <td>{r.cost_credits != null ? `${r.cost_credits} 点` : `$${Number(r.cost_usd).toFixed(4)}`}</td>
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
