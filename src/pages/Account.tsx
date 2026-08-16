import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuthStore, setGroupTypeMap, isImageGroup, getGroupTypeMap } from '../store/useAuthStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useAccountStore } from '../store/useAccountStore';
import { serverApi, type ServerModel, type UserToken, type PayLimits, type UserOrder, type UsageRecord } from '../services/serverApi';
import { api } from '../services/api';
import { SERVICE_FEATURES, isServiceFeatureEnabled } from '../config/serviceFeatures';
import { setAsAvatarFromPath, clearAvatar } from '../services/avatarService';
import TokenField from '../components/TokenField';
import TokenInfoDialog from '../components/TokenInfoDialog';
import AccountUsagePanel from '../components/AccountUsagePanel';
import { explainError } from '../utils/errors';
import './Account.css';

interface PendingOrder {
  out_trade_no: string;
  group: string;
  amount_usd: number;
  amount_cny: number;
  items: { group: string; amount_usd: number }[];
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
  if (/[\u4e00-\u9fa5]/.test(value)) return value.match(/[\u4e00-\u9fa5]/)?.[0] || 'U';
  const parts = value.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return value.slice(0, 2).toUpperCase();
}

export default function Account() {
  const { user, isLoggedIn, refreshUser, logout, upgradeTrial, showAuthPrompt } = useAuthStore();
  const { settings } = useSettingsStore();
  // 账户权益
  const {
    balances,
    enabledModels,
    fetchEntitlements,
    getFeatureStatus,
  } = useAccountStore();
  const [trialLoading, setTrialLoading] = useState(false);
  const [models, setModels] = useState<ServerModel[]>([]);
  const [exchangeRate, setExchangeRate] = useState<number>(0);
  const [groupDescs, setGroupDescs] = useState<Record<string, string>>({});
  const [groupAmounts, setGroupAmounts] = useState<Record<string, string>>({});
  const [payLimits, setPayLimits] = useState<PayLimits | null>(null);
  const [ordering, setOrdering] = useState(false);
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([]);
  const [allocMap, setAllocMap] = useState<Record<string, AllocStatus>>({});
  const [polling, setPolling] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('');
  const [qrCodeLink, setQrCodeLink] = useState<string>('');
  const [showTokenDialog, setShowTokenDialog] = useState(false);
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

  useEffect(() => {
    if (!isLoggedIn) return;
    refreshUser();
    fetchEntitlements(); // 获取账户权益
    loadModels();
    loadPackages();
    loadOrders();
  }, [isLoggedIn]);

  useEffect(() => () => {
    if (allocTimerRef.current) clearInterval(allocTimerRef.current);
    if (refundTimerRef.current) clearInterval(refundTimerRef.current);
  }, []);

  async function loadOrders() {
    setOrdersLoading(true);
    try {
      const raw = await serverApi.getOrders();
      // 兼容服务端字段名：total_usd / amount_usd
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
        allocated_at: o.allocated_at ?? null,
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
      alert(e.message || '取消失败');
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
      alert(e.message || '退款申请失败');
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
      const map: Record<string, 'image' | 'agent' | 'postprocess' | 'chat'> = {};
      for (const m of list) if (m.group) map[m.group] = m.model_type;
      setGroupTypeMap(map);
    } catch (e) {
      console.error('[loadModels] 获取模型列表失败:', e);
    }
  }

  async function loadPackages() {
    try {
      const pkg = await serverApi.getPackages();
      setExchangeRate(pkg.exchange_rate || 0);
      if (pkg.limits) setPayLimits(pkg.limits);
      const descs: Record<string, string> = {};
      for (const g of pkg.groups || []) {
        if (g.name && g.description) descs[g.name] = g.description;
      }
      setGroupDescs(descs);
    } catch {
      setExchangeRate(0);
    }
  }

  // 按 model_type 分类的可充值服务清单（去重 group）。
  // V3.0.6：AI 智能体已全面 BYOK，不再作为充值业务 —— agent/chat 分组
  // 不进入充值区（历史余额与订单记录仍可在订单/用量中查询）。
  const groupsByType: { image: { name: string }[]; postprocess: { name: string }[] } = (() => {
    const seen = new Set<string>();
    const img: { name: string }[] = [];
    const postprocess: { name: string }[] = [];
    for (const m of models) {
      if (!m.group || seen.has(m.group)) continue;
      if (m.model_type === 'agent' || m.model_type === 'chat') continue;
      if (m.rechargeable === false) continue;
      seen.add(m.group);
      if (m.model_type === 'image') img.push({ name: m.group });
      else if (m.model_type === 'postprocess') postprocess.push({ name: m.group });
    }
    // 防御：models API 失败时从用户已有 token 回落 image 分组
    if (img.length === 0) {
      const gMap = getGroupTypeMap();
      for (const t of (user?.tokens ?? [])) {
        if (seen.has(t.group)) continue;
        if (gMap[t.group] === 'image' || (!gMap[t.group] && isImageGroup(t.group))) {
          seen.add(t.group);
          img.push({ name: t.group });
        }
      }
    }
    return { image: img, postprocess };
  })();

  const imageModels = models.filter(m => m.model_type === 'image');
  const postprocessModels = models.filter(m => m.model_type === 'postprocess');

  const minUsdPerGroup = payLimits?.min_per_item_usd ?? (exchangeRate > 0 ? 0.01 / exchangeRate : 0.01);
  const minUsdTotal = payLimits?.min_total_usd ?? 1;
  const maxUsdTotal = payLimits?.max_total_usd ?? 1000;

  // 禁用业务（如图片后处理开发中）的分组集合：不可输入金额、不计入合计、不可下单
  const disabledGroups = new Set(
    !isServiceFeatureEnabled('postprocess') ? groupsByType.postprocess.map(g => g.name) : []
  );

  function setAmount(group: string, value: string) {
    if (disabledGroups.has(group)) return;
    if (!/^\d{0,4}(\.\d{0,2})?$/.test(value) && value !== '') return;
    setGroupAmounts(prev => ({ ...prev, [group]: value }));
  }

  function setPresetAmount(group: string, amount: number) {
    if (disabledGroups.has(group)) return;
    setGroupAmounts(prev => ({ ...prev, [group]: amount.toFixed(2) }));
  }

  // 仅统计可用业务的金额（防御：HMR/状态残留也不会把禁用分组算进合计/下单）
  const selectedItems = Object.entries(groupAmounts)
    .filter(([group]) => !disabledGroups.has(group))
    .map(([group, v]) => ({ group, amount_usd: parseFloat(v) || 0 }))
    .filter(i => i.amount_usd > 0);

  const totalUsd = selectedItems.reduce((s, i) => s + i.amount_usd, 0);
  const totalCny = exchangeRate ? totalUsd * exchangeRate : 0;

  async function handleBuy() {
    const items = Object.entries(groupAmounts)
      .filter(([group]) => !disabledGroups.has(group))
      .map(([group, v]) => ({ group, amount_usd: parseFloat(v) || 0 }))
      .filter(i => i.amount_usd >= minUsdPerGroup && i.amount_usd <= maxUsdTotal);
    if (items.length === 0) {
      alert(`请至少为一个分组输入有效金额（${minUsdPerGroup.toFixed(2)}-${maxUsdTotal.toFixed(0)} 美元）`);
      return;
    }
    const totalAmount = items.reduce((s, i) => s + i.amount_usd, 0);
    if (totalAmount < minUsdTotal) {
      alert(`订单总额需至少 $${minUsdTotal.toFixed(2)}，当前 $${totalAmount.toFixed(2)}`);
      return;
    }
    if (totalAmount > maxUsdTotal) {
      alert(`订单总额不能超过 $${maxUsdTotal.toFixed(2)}，当前 $${totalAmount.toFixed(2)}`);
      return;
    }
    setOrdering(true);
    setStatusMsg('正在创建订单...');
    try {
      const r = await serverApi.createOrder(items);
      const orders: PendingOrder[] = [{
        out_trade_no: r.out_trade_no,
        group: r.group,
        amount_usd: r.amount_usd,
        amount_cny: r.amount_cny,
        items: r.items || [],
      }];
      setPendingOrders(orders);
      setAllocMap({ [r.out_trade_no]: 'pending' });

      if (r.code_url) {
        const qrDataUrl = await generatePaymentQrCode(r.code_url);
        setQrCodeUrl(qrDataUrl);
        setQrCodeLink(r.code_url);
        setStatusMsg('请使用微信扫描二维码支付');
      } else {
        setStatusMsg('订单已创建，等待支付...');
      }

      startPaymentPolling(orders);
    } catch (e: any) {
      alert(explainError(e));
      setStatusMsg('');
    } finally {
      setOrdering(false);
    }
  }

  const startPaymentPolling = useCallback((orders: PendingOrder[]) => {
    if (allocTimerRef.current) clearInterval(allocTimerRef.current);
    setPolling(true);
    let count = 0;
    allocTimerRef.current = setInterval(async () => {
      count++;
      if (count > 100) {
        if (allocTimerRef.current) clearInterval(allocTimerRef.current);
        setPolling(false);
        for (const o of orders) {
          try { await serverApi.closeOrder(o.out_trade_no); } catch {}
        }
        setAllocMap(prev => {
          const next = { ...prev };
          for (const o of orders) {
            if (next[o.out_trade_no] === 'pending') next[o.out_trade_no] = 'closed';
          }
          return next;
        });
        setQrCodeUrl('');
        setQrCodeLink('');
        setStatusMsg(`支付超时，订单已关闭。如需${rechargeLabel}请重新下单。`);
        return;
      }
      let allDone = true;
      let anyPaid = false;
      const next: Record<string, AllocStatus> = {};
      for (const o of orders) {
        try {
          const s = await serverApi.queryOrder(o.out_trade_no);
          if (s.status === 'closed') {
            next[o.out_trade_no] = 'closed';
          } else if (s.api_token) {
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
        setStatusMsg(isPaid ? '支付成功，等待充值到账...' : '支付成功，等待管理员分配 Token...');
      }
      if (allDone) {
        if (allocTimerRef.current) clearInterval(allocTimerRef.current);
        setPolling(false);
        setStatusMsg(isPaid ? '充值到账完成！' : 'Token 已全部分配完成！');
        await refreshUser();
        setTimeout(() => {
          setPendingOrders([]);
          setAllocMap({});
          setGroupAmounts({});
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
  const isPaid = user?.account_type === 'paid';
  const rechargeLabel = isPaid ? '充值 / 续费' : '充值';

  async function handleApplyTrial() {
    setTrialLoading(true);
    try {
      await upgradeTrial();
      alert('试用已开通，享有 3 天图片生成额度。');
    } catch (e: any) {
      alert(explainError(e));
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
      alert(e?.message || '头像设置失败，请重试');
    }
  }
  const trialExpired = user?.trial_expired;
  const userTokens: UserToken[] = user?.tokens ?? [];
  const tokenByGroup = (g: string) => userTokens.find(t => t.group === g);

  // 顶部余额卡：优先权益接口，回落到 token 求和（历史 agent 余额不展示）
  const sumGroupBalance = (groups: { name: string }[]) =>
    groups.reduce((s, g) => s + (Number(tokenByGroup(g.name)?.balance_usd) || 0), 0);
  const imageBalance = balances.image ?? sumGroupBalance(groupsByType.image);
  const postprocessBalance = balances.postprocess ?? sumGroupBalance(groupsByType.postprocess);

  // 未登录：显示登录入口
  if (!isLoggedIn || !user) {
    return (
      <div className="page account-page">
        <div className="page-header">
          <h2>我的账户</h2>
        </div>
        <div className="account-empty">
          <p className="account-empty-hint">请登录后查看账户信息、余额和{rechargeLabel}</p>
          <button className="account-login-btn" onClick={showAuthPrompt}>
            立即登录 / 注册
          </button>
        </div>
      </div>
    );
  }

  const hasGroups = groupsByType.image.length + groupsByType.postprocess.length > 0;

  const statusMap: Record<string, { label: string; cls: string }> = {
    pending:       { label: '待支付',   cls: 'pending' },
    paid:          { label: '已支付',   cls: 'paid' },
    allocated:     { label: '已到账',   cls: 'allocated' },
    assigned:      { label: '已到账',   cls: 'allocated' },
    closed:        { label: '已关闭',   cls: 'closed' },
    refunding:     { label: '退款中',   cls: 'refunding' },
    refunded:      { label: '已退款',   cls: 'refunded' },
    refund_change: { label: '退款异常', cls: 'refund_change' },
  };

  return (
    <div className="page account-page">
      <div className="page-header">
        <h2>我的账户</h2>
      </div>

      {/* 降级横幅：normal 但有任一 token，说明是从 paid/trial 降级而来 */}
      {user.account_type === 'normal' && userTokens.length > 0 && (
        <div className="downgrade-banner">
          ⚠ 余额已耗尽，账户当前为普通账户。Token 已保留，{rechargeLabel}后可继续使用。
        </div>
      )}

      {/* 用户信息卡：头像 + 身份 + 双业务余额 */}
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
              <span className="account-balance-label">🎨 图片余额</span>
              <span className="account-balance-value">${imageBalance.toFixed(2)}</span>
            </div>
            <div className="account-balance-item">
              <span className="account-balance-label">✂ 图片后处理余额</span>
              <span className="account-balance-value">${postprocessBalance.toFixed(2)}</span>
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

      {/* 充值面板 */}
      <div className="account-section">
        <h3>{rechargeLabel}</h3>
        {!hasGroups ? (
          <p className="balance-empty">暂无可用分组（请确认服务器地址正确）</p>
        ) : (
          <>
            {/* 充值业务：图片生成 + 图片后处理（AI 智能体已 BYOK，不再提供充值） */}
            <div className="recharge-grid">
              {groupsByType.image.length > 0 && (
                <RechargeSection
                  icon="🎨"
                  title="图片生成"
                  description="用于文生图、图生图等图片生成任务。"
                  modelChips={imageModels.map(m => m.display_name || m.name)}
                  groups={groupsByType.image}
                  groupDescs={groupDescs}
                  tokenByGroup={tokenByGroup}
                  groupAmounts={groupAmounts}
                  onAmountChange={setAmount}
                  onPresetClick={setPresetAmount}
                  onInfoClick={() => setShowPricingDialog(true)}
                  featureStatus={getFeatureStatus('image')}
                  enabledModels={enabledModels['image'] || []}
                />
              )}

              {groupsByType.postprocess.length > 0 && (
                <RechargeSection
                  icon="✂"
                  title="图片后处理"
                  description="用于透明背景、高清放大等第三方处理工具。"
                  modelChips={postprocessModels.map(m => m.display_name || m.name)}
                  groups={groupsByType.postprocess}
                  groupDescs={groupDescs}
                  tokenByGroup={tokenByGroup}
                  groupAmounts={groupAmounts}
                  onAmountChange={setAmount}
                  onPresetClick={setPresetAmount}
                  onInfoClick={() => setShowPricingDialog(true)}
                  featureStatus={getFeatureStatus('postprocess')}
                  enabledModels={enabledModels['postprocess'] || []}
                  disabled={!isServiceFeatureEnabled('postprocess')
                    ? { statusText: SERVICE_FEATURES.postprocess.statusText, hint: SERVICE_FEATURES.postprocess.hint }
                    : undefined}
                />
              )}
            </div>

            <div className="recharge-summary">
              {selectedItems.length > 0 && (
                <div className="recharge-summary-items">
                  {selectedItems.map(item => (
                    <div className="recharge-summary-item" key={item.group}>
                      <span>{item.group}</span>
                      <strong>${item.amount_usd.toFixed(2)}</strong>
                    </div>
                  ))}
                </div>
              )}
              <div className="recharge-summary-row">
                <span className="recharge-summary-total">合计 <strong>${totalUsd.toFixed(2)}</strong>{exchangeRate > 0 && <> ≈ ¥{totalCny.toFixed(2)}</>}</span>
                {exchangeRate > 0 && <span className="recharge-summary-rate">汇率 {exchangeRate.toFixed(2)}</span>}
              </div>
              <div className="recharge-summary-hint">
                {totalUsd > 0 && totalUsd < minUsdTotal
                  ? `还差 $${(minUsdTotal - totalUsd).toFixed(2)} 可发起支付`
                  : `最低充值 ${minUsdTotal.toFixed(2)} · 单项 ${minUsdPerGroup.toFixed(2)}~${maxUsdTotal.toFixed(0)}`}
              </div>
              <div className="recharge-summary-actions">
                <span className="recharge-pay-label">仅支持微信支付</span>
                <button
                  className="buy-btn"
                  disabled={ordering || polling || totalUsd < minUsdTotal || totalUsd > maxUsdTotal}
                  onClick={handleBuy}
                >
                  {ordering ? '下单中...' : polling ? '等待支付...' : isPaid ? '立即充值' : '立即支付'}
                </button>
              </div>
            </div>
          </>
        )}

        {/* 订单分配状态卡片 */}
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
                  st === 'allocated' ? (isPaid ? '✓ 已到账' : '✓ 已完成') :
                  st === 'paid' ? (isPaid ? '⏳ 等待到账' : '⏳ 等待分配') :
                  st === 'closed' ? '已关闭' :
                  st === 'unknown' ? '查询中' : '待支付';
                return (
                  <div key={o.out_trade_no} className="alloc-order-row">
                    <span className="alloc-order-info">
                      {(o.items?.map(i => i.group).join(' + ') || o.group.replace(/,/g, ' + '))} · ${o.amount_usd.toFixed(2)}（¥{o.amount_cny.toFixed(2)}）
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

      {showTokenDialog && (
        <TokenInfoDialog tokens={userTokens} onClose={() => setShowTokenDialog(false)} />
      )}

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
                <th>购买分组</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(o => {
                const sm = statusMap[o.status] ?? { label: o.status, cls: 'pending' };
                const payCny = o.amount_cny ?? o.total_cny ?? 0;
                return (
                  <tr key={o.out_trade_no}>
                    <td className="order-cell-id">{o.out_trade_no.slice(-8)}</td>
                    <td>{o.created_at?.replace('T', ' ').slice(0, 16) || '-'}</td>
                    <td>{o.paid_at?.replace('T', ' ').slice(0, 16) || '-'}</td>
                    <td>¥{Number(payCny).toFixed(2)}</td>
                    <td>{o.items?.map(i => i.group).join(' + ') || '-'}</td>
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

interface RechargeSectionProps {
  icon: string;
  title: string;
  description: string;
  modelChips: string[];
  groups: { name: string }[];
  groupDescs: Record<string, string>;
  tokenByGroup: (name: string) => UserToken | undefined;
  groupAmounts: Record<string, string>;
  onAmountChange: (group: string, val: string) => void;
  onPresetClick: (group: string, amount: number) => void;
  highlight?: boolean;
  onInfoClick?: () => void;
  // 新增：账户权益相关
  featureStatus?: {
    enabled: boolean;
    balance: number;
    hasBalance: boolean;
    statusText: string;
  };
  enabledModels?: string[];
  /** 业务能力开关：传入即禁用（功能开发中，Card 保留展示但不可选/不可输/不可充值） */
  disabled?: { statusText: string; hint: string };
}

function RechargeSection({
  icon, title, description, modelChips, groups, groupDescs,
  tokenByGroup, groupAmounts, onAmountChange, onPresetClick, highlight, onInfoClick,
  featureStatus, enabledModels, disabled,
}: RechargeSectionProps) {
  const presets = [5, 10, 20, 50];
  const isDisabled = !!disabled;
  return (
    <div
      className={`recharge-card ${highlight ? 'highlight' : ''} ${isDisabled ? 'disabled' : ''}`}
      title={isDisabled ? (disabled!.hint || '该功能暂不可用') : undefined}
      aria-disabled={isDisabled}
    >
      <div className="recharge-card-header">
        <span className="recharge-card-icon">{icon}</span>
        <span className="recharge-card-title">{title}</span>
        {isDisabled ? (
          <span className="recharge-status-badge dev">{disabled!.statusText}</span>
        ) : featureStatus && (
          <span className={`recharge-status-badge ${featureStatus.enabled ? (featureStatus.hasBalance ? 'active' : 'no-balance') : 'inactive'}`}>
            {featureStatus.statusText}
          </span>
        )}
        {onInfoClick && (
          <button className="recharge-card-info-btn" title="查看扣费标准" onClick={onInfoClick}>
            !
          </button>
        )}
      </div>
      <p className="recharge-card-desc">{description}</p>
      {modelChips.length > 0 && (
        <div className="recharge-card-models">
          <span className="recharge-card-models-label">支持</span>
          {modelChips.map(n => (
            <span key={n} className="recharge-card-model-chip">{n}</span>
          ))}
        </div>
      )}
      {enabledModels && enabledModels.length > 0 && (
        <div className="recharge-card-models">
          <span className="recharge-card-models-label">已开通</span>
          {enabledModels.map(n => (
            <span key={n} className="recharge-card-model-chip active">{n}</span>
          ))}
        </div>
      )}
      <div className="recharge-card-body">
        {groups.map(g => {
          const cur = tokenByGroup(g.name);
          const desc = groupDescs[g.name];
          const selected = parseFloat(groupAmounts[g.name] || '0') || 0;
          // 使用权益数据中的余额（如果有）
          const displayBalance = featureStatus ? featureStatus.balance : (cur ? Number(cur.balance_usd) : 0);
          return (
            <div key={g.name} className="recharge-card-row">
              <div className="recharge-card-balance">
                <span className="recharge-card-balance-icon">💰</span>
                <span className="recharge-card-balance-label">当前额度</span>
                <span className="recharge-card-balance-amount">
                  ${displayBalance.toFixed(2)}
                </span>
                {cur?.is_trial && <span className="balance-trial-tag">试用</span>}
              </div>
              {desc && <span className="recharge-card-group-hint">{desc}</span>}
              <div className="recharge-presets">
                {presets.map(amount => (
                  <button
                    key={amount}
                    className={`recharge-preset-btn ${selected === amount ? 'active' : ''}`}
                    disabled={isDisabled}
                    aria-disabled={isDisabled}
                    onClick={() => { if (isDisabled) return; onPresetClick(g.name, amount); }}
                  >
                    ${amount}
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
                    value={groupAmounts[g.name] || ''}
                    disabled={isDisabled}
                    readOnly={isDisabled}
                    tabIndex={isDisabled ? -1 : 0}
                    onChange={e => { if (isDisabled) return; onAmountChange(g.name, e.target.value); }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
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
                <td>{m.model_type === 'image' ? '图片' : '对话'}</td>
                <td>{m.billing_type === 'per_call' ? '按次计费' : '按量计费'}</td>
                <td>
                  {m.billing_type === 'per_call'
                    ? (m.price_per_call ? `$${m.price_per_call}/次` : '-')
                    : <>
                      {m.price_input && <div>输入 $${m.price_input}/1K tokens</div>}
                      {m.price_output && <div>输出 $${m.price_output}/1K tokens</div>}
                      {m.price_cached && <div>缓存 $${m.price_cached}/1K tokens</div>}
                      {!m.price_input && !m.price_output && '-'}
                    </>
                  }
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
                const qty = r.image_count ?? r.input_tokens ?? 0;
                const isImage = r.usage_type === 'image';
                return (
                <tr key={i}>
                  <td>{r.model}</td>
                  <td>{isImage ? '图片' : '对话'}</td>
                  <td>{isImage ? `${qty} 张` : `${qty} tokens`}</td>
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

