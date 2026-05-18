import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuthStore, setGroupTypeMap, isImageGroup, getGroupTypeMap } from '../store/useAuthStore';
import { serverApi, type ServerModel, type UserToken, type PayLimits, type UserOrder, type UsageRecord } from '../services/serverApi';
import TokenField from '../components/TokenField';
import TokenInfoDialog from '../components/TokenInfoDialog';
import { explainError } from '../utils/errors';
import QRCode from 'qrcode';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
  BarChart, Bar,
} from 'recharts';
import './Account.css';

interface PendingOrder {
  out_trade_no: string;
  group: string;
  amount_usd: number;
  amount_cny: number;
  items: { group: string; amount_usd: number }[];
}

type AllocStatus = 'pending' | 'paid' | 'allocated' | 'closed' | 'unknown';

export default function Account() {
  const { user, isLoggedIn, refreshUser, logout, upgradeTrial, showAuthPrompt } = useAuthStore();
  const [trialLoading, setTrialLoading] = useState(false);
  const [usage, setUsage] = useState<UsageRecord[]>([]);
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
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [usageChartTab, setUsageChartTab] = useState<'line' | 'pie' | 'bar'>('line');
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('');
  const [qrCodeLink, setQrCodeLink] = useState<string>('');
  const [showTokenDialog, setShowTokenDialog] = useState(false);
  const [showPricingDialog, setShowPricingDialog] = useState(false);
  const [usageRecords, setUsageRecords] = useState<UsageRecord[]>([]);
  const [orders, setOrders] = useState<UserOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [orderActionLoading, setOrderActionLoading] = useState<string | null>(null);
  const [refundConfirmId, setRefundConfirmId] = useState<string | null>(null);
  const allocTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isLoggedIn) return;
    refreshUser();
    loadModels();
    loadPackages();
    loadUsage();
    loadOrders();
  }, [isLoggedIn]);

  useEffect(() => () => {
    if (allocTimerRef.current) clearInterval(allocTimerRef.current);
  }, []);

  async function loadOrders() {
    setOrdersLoading(true);
    try {
      const raw = await serverApi.getOrders();
      // 兼容服务端字段名：total_usd / amount_usd
      const data: UserOrder[] = raw.map((o: any) => ({
        out_trade_no: o.out_trade_no,
        total_usd: Number(o.total_usd ?? o.amount_usd ?? 0),
        total_cny: Number(o.total_cny ?? o.amount_cny ?? 0),
        status: o.status,
        items: Array.isArray(o.items) ? o.items : [],
        created_at: o.created_at ?? '',
        paid_at: o.paid_at,
        allocated_at: o.allocated_at,
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
      await serverApi.refundOrder(id);
      await loadOrders();
      refreshUser();
    } catch (e: any) {
      alert(e.message || '退款失败');
    } finally {
      setOrderActionLoading(null);
      setRefundConfirmId(null);
    }
  }

  async function loadModels() {
    try {
      const list = await serverApi.getModels();
      console.log('[loadModels] 获取到模型列表:', list.length, list.map(m => `${m.name}(${m.model_type},group=${m.group})`));
      setModels(list);
      const map: Record<string, 'image' | 'chat'> = {};
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

  async function loadUsage() {
    setLoadingUsage(true);
    try {
      const data = await serverApi.getUsageRecords();
      setUsage(data.slice(0, 15));
    } catch {} finally {
      setLoadingUsage(false);
    }
  }

  // 按 model_type 分类的模型清单（去重 group）
  const groupsByType: { image: { name: string }[]; chat: { name: string }[] } = (() => {
    const seenImg = new Set<string>();
    const seenChat = new Set<string>();
    const img: { name: string }[] = [];
    const chat: { name: string }[] = [];
    for (const m of models) {
      if (!m.group) continue;
      if (m.model_type === 'image' && !seenImg.has(m.group)) {
        seenImg.add(m.group);
        img.push({ name: m.group });
      } else if (m.model_type === 'chat' && !seenChat.has(m.group)) {
        seenChat.add(m.group);
        chat.push({ name: m.group });
      }
    }
    // 防御：models API 未返回 chat 分组，但用户已有 chat token
    const gMap = getGroupTypeMap();
    if (chat.length === 0) {
      for (const t of (user?.tokens ?? [])) {
        if (seenChat.has(t.group)) continue;
        if (gMap[t.group]) {
          if (gMap[t.group] === 'chat') {
            seenChat.add(t.group);
            chat.push({ name: t.group });
          }
        } else if (!isImageGroup(t.group)) {
          seenChat.add(t.group);
          chat.push({ name: t.group });
        }
      }
    }
    if (img.length === 0) {
      for (const t of (user?.tokens ?? [])) {
        if (seenImg.has(t.group)) continue;
        if (gMap[t.group]) {
          if (gMap[t.group] === 'image') {
            seenImg.add(t.group);
            img.push({ name: t.group });
          }
        } else if (isImageGroup(t.group)) {
          seenImg.add(t.group);
          img.push({ name: t.group });
        }
      }
    }
    return { image: img, chat };
  })();

  const imageModels = models.filter(m => m.model_type === 'image');
  const chatModels = models.filter(m => m.model_type === 'chat');

  const totalUsd = Object.values(groupAmounts).reduce((s, v) => s + (parseFloat(v) || 0), 0);
  const totalCny = exchangeRate ? totalUsd * exchangeRate : 0;
  const minUsdPerGroup = payLimits?.min_per_item_usd ?? (exchangeRate > 0 ? 0.01 / exchangeRate : 0.01);
  const minUsdTotal = payLimits?.min_total_usd ?? 1;
  const maxUsdTotal = payLimits?.max_total_usd ?? 1000;

  function setAmount(group: string, value: string) {
    if (!/^\d{0,4}(\.\d{0,2})?$/.test(value) && value !== '') return;
    setGroupAmounts(prev => ({ ...prev, [group]: value }));
  }

  async function handleBuy() {
    const items = Object.entries(groupAmounts)
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
      const r = await serverApi.createOrder(items, 'wxpay');
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
        const qrDataUrl = await QRCode.toDataURL(r.code_url, { width: 200, margin: 2 });
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
  const trialExpired = user?.trial_expired;
  const userTokens: UserToken[] = user?.tokens ?? [];
  const tokenByGroup = (g: string) => userTokens.find(t => t.group === g);

  const dailyCost = useMemo(() => {
    const map: Record<string, number> = {};
    for (const u of usage) {
      const day = u.created_at?.slice(0, 10) ?? 'unknown';
      map[day] = (map[day] ?? 0) + Number(u.cost_usd);
    }
    return Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, cost]) => ({ date, cost: parseFloat(cost.toFixed(4)) }));
  }, [usage]);

  const typeCost = useMemo(() => {
    const img = usage.filter(u => u.type === 'image').reduce((s: number, u) => s + Number(u.cost_usd), 0);
    const chat = usage.filter(u => u.type === 'chat').reduce((s: number, u) => s + Number(u.cost_usd), 0);
    return [
      { name: '图片生成', value: parseFloat(img.toFixed(4)), fill: 'var(--accent-primary)' },
      { name: '智能对话', value: parseFloat(chat.toFixed(4)), fill: 'var(--accent-success)' },
    ].filter(d => d.value > 0);
  }, [usage]);

  const modelCount = useMemo(() => {
    const map: Record<string, number> = {};
    for (const u of usage) {
      map[u.model] = (map[u.model] ?? 0) + (u.quantity || 1);
    }
    return Object.entries(map)
      .sort(([, a], [, b]) => b - a)
      .map(([model, count]) => ({ model, count }));
  }, [usage]);

  // 未登录：显示登录入口
  if (!isLoggedIn || !user) {
    return (
      <div className="page">
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

  const hasGroups = groupsByType.image.length + groupsByType.chat.length > 0;

  return (
    <div className="page">
      <div className="page-header">
        <h2>我的账户</h2>
      </div>

      {/* 降级横幅：normal 但有任一 token，说明是从 paid/trial 降级而来 */}
      {user.account_type === 'normal' && userTokens.length > 0 && (
        <div className="downgrade-banner">
          ⚠ 余额已耗尽，账户当前为普通账户。Token 已保留，{rechargeLabel}后可继续使用。
        </div>
      )}

      {/* 用户信息卡 */}
      <div className="account-card">
        <div className="account-info-row">
          <div className="account-info-item">
            <span className="info-label">用户名</span>
            <span className="info-value">{user.username}</span>
          </div>
          <div className="account-info-item">
            <span className="info-label">账户类型</span>
            <span className={`info-badge ${user.account_type}`}>{typeLabel}</span>
          </div>
          {user.account_type === 'trial' && user.trial_expires_at && (
            <div className="account-info-item">
              <span className="info-label">试用到期</span>
              <span className={`info-value ${trialExpired ? 'expired' : ''}`}>
                {trialExpired ? '已过期' : user.trial_expires_at.replace('T', ' ').slice(0, 16)}
              </span>
            </div>
          )}
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
            {/* 图文模型 */}
            {groupsByType.image.length > 0 && (
              <RechargeSection
                icon="🎨"
                title="图片生成"
                description="输入文字，AI帮你画图"
                modelChips={imageModels.map(m => m.display_name || m.name)}
                groups={groupsByType.image}
                groupDescs={groupDescs}
                tokenByGroup={tokenByGroup}
                groupAmounts={groupAmounts}
                onAmountChange={setAmount}
                onInfoClick={() => setShowPricingDialog(true)}
              />
            )}

            {/* 对话模型 */}
            {groupsByType.chat.length > 0 && (
              <RechargeSection
                icon="💬"
                title="AI 对话"
                description="和AI聊天、问问题、写文章"
                modelChips={chatModels.map(m => m.display_name || m.name)}
                groups={groupsByType.chat}
                groupDescs={groupDescs}
                tokenByGroup={tokenByGroup}
                groupAmounts={groupAmounts}
                onAmountChange={setAmount}
                onInfoClick={() => setShowPricingDialog(true)}
              />
            )}

            <div className="recharge-summary">
              <div className="recharge-summary-row">
                <span className="recharge-summary-total">合计 <strong>${totalUsd.toFixed(2)}</strong>{exchangeRate > 0 && <> ≈ ¥{totalCny.toFixed(2)}</>}</span>
                {exchangeRate > 0 && <span className="recharge-summary-rate">汇率 {exchangeRate.toFixed(2)}</span>}
              </div>
              <div className="recharge-summary-hint">
                最低充值 ${minUsdTotal.toFixed(2)} · 每组 ${minUsdPerGroup.toFixed(2)}~${maxUsdTotal.toFixed(0)}
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

      {/* 用量记录 */}
      <div className="account-section">
        <h3>最近用量</h3>
        {loadingUsage ? (
          <p className="usage-loading">加载中...</p>
        ) : usage.length === 0 ? (
          <p className="usage-empty">暂无用量记录</p>
        ) : (
          <>
            <div className="usage-charts">
              <div className="usage-chart-tabs">
                <button className={`usage-tab ${usageChartTab === 'line' ? 'active' : ''}`} onClick={() => setUsageChartTab('line')} title="每日费用趋势">
                  📈
                </button>
                <button className={`usage-tab ${usageChartTab === 'pie' ? 'active' : ''}`} onClick={() => setUsageChartTab('pie')} title="图片 vs 对话占比">
                  🥧
                </button>
                <button className={`usage-tab ${usageChartTab === 'bar' ? 'active' : ''}`} onClick={() => setUsageChartTab('bar')} title="模型调用次数">
                  📊
                </button>
              </div>
              <div className="usage-chart-card">
                {usageChartTab === 'line' && (
                  <>
                    <div className="usage-chart-title">每日费用趋势</div>
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={dailyCost} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                        <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} />
                        <Tooltip formatter={(v) => [`$${v}`, '费用']} />
                        <Line type="monotone" dataKey="cost" stroke="var(--accent-primary)" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </>
                )}
                {usageChartTab === 'pie' && typeCost.length > 0 && (
                  <>
                    <div className="usage-chart-title">图片 vs 对话占比</div>
                    <ResponsiveContainer width="100%" height={200}>
                      <PieChart>
                        <Pie data={typeCost} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`} labelLine={false}>
                          {typeCost.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                        </Pie>
                        <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </>
                )}
                {usageChartTab === 'bar' && modelCount.length > 0 && (
                  <>
                    <div className="usage-chart-title">模型调用次数</div>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={modelCount} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                        <XAxis dataKey="model" tick={{ fontSize: 9 }} />
                        <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                        <Tooltip />
                        <Bar dataKey="count" fill="var(--accent-orange)" radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </>
                )}
              </div>
            </div>
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
                {[...usage].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).map((u, i) => (
                  <tr key={i}>
                    <td>{u.model}</td>
                    <td>{u.type === 'image' ? '图片' : '对话'}</td>
                    <td>{u.type === 'image' ? `${u.quantity} 张` : `${u.quantity} tokens`}</td>
                    <td>${Number(u.cost_usd).toFixed(4)}</td>
                    <td>{u.created_at?.replace('T', ' ').slice(0, 16)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
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
              setUsageRecords(data);
              return data;
            } catch { return []; }
          }}
          onClose={() => setShowPricingDialog(false)}
        />
      )}

      {/* 订单查询 */}
      <div className="account-section order-history-section">
        <h3>订单查询</h3>
        {ordersLoading ? (
          <p className="balance-empty">加载中...</p>
        ) : orders.length === 0 ? (
          <p className="balance-empty">暂无订单记录</p>
        ) : (
          <div className="order-list">
            {orders.map(o => (
              <div key={o.out_trade_no} className="order-item">
                <div className="order-item-left">
                  <span className="order-item-amount">${Number(o.total_usd).toFixed(2)}</span>
                  <span className="order-item-groups">
                    {o.items?.map(i => i.group).join(' + ') || '-'}
                  </span>
                  <span className="order-item-date">{o.created_at?.replace('T', ' ').slice(0, 16)}</span>
                </div>
                <span className={`order-item-tag ${o.status}`}>
                  {o.status === 'allocated' ? '已到账' : o.status === 'paid' ? '已支付' : o.status === 'refunding' ? '退款中' : o.status === 'refunded' ? '已退款' : o.status === 'closed' ? '已关闭' : '待支付'}
                </span>
                <div className="order-item-actions">
                  {o.status === 'pending' && (
                    <button
                      className="order-action-btn cancel"
                      disabled={orderActionLoading === o.out_trade_no}
                      onClick={() => handleCancelOrder(o.out_trade_no)}
                    >
                      {orderActionLoading === o.out_trade_no ? '...' : '取消'}
                    </button>
                  )}
                  {(o.status === 'paid' || o.status === 'allocated') && (
                    <button
                      className="order-action-btn refund"
                      disabled={orderActionLoading === o.out_trade_no}
                      onClick={() => setRefundConfirmId(o.out_trade_no)}
                    >
                      {orderActionLoading === o.out_trade_no ? '...' : '退款'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 退款确认弹窗 */}
      {refundConfirmId && (() => {
        const ro = orders.find(o => o.out_trade_no === refundConfirmId);
        return (
          <div className="refund-confirm-overlay" onClick={() => setRefundConfirmId(null)}>
            <div className="refund-confirm-dialog" onClick={e => e.stopPropagation()}>
              <h3>确认退款</h3>
              <p className="refund-confirm-hint">
                {ro
                  ? <>订单 <strong>{ro.out_trade_no}</strong>，金额 <strong>${Number(ro.total_usd).toFixed(2)}</strong>{ro.total_cny > 0 && <>（¥{Number(ro.total_cny).toFixed(2)}）</>}<br />退款后余额将被扣除，确认退款？</>
                  : '确认退款？'}
              </p>
              <div className="refund-confirm-actions">
                <button className="refund-confirm-cancel" onClick={() => setRefundConfirmId(null)}>取消</button>
                <button
                  className="refund-confirm-ok"
                  disabled={orderActionLoading === refundConfirmId}
                  onClick={() => handleRefundOrder(refundConfirmId)}
                >
                  {orderActionLoading === refundConfirmId ? '处理中...' : '确认退款'}
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
  onInfoClick?: () => void;
}

function RechargeSection({
  icon, title, description, modelChips, groups, groupDescs,
  tokenByGroup, groupAmounts, onAmountChange, onInfoClick,
}: RechargeSectionProps) {
  return (
    <div className="recharge-card">
      <div className="recharge-card-header">
        <span className="recharge-card-icon">{icon}</span>
        <span className="recharge-card-title">{title}</span>
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
      <div className="recharge-card-body">
        {groups.map(g => {
          const cur = tokenByGroup(g.name);
          const desc = groupDescs[g.name];
          return (
            <div key={g.name} className="recharge-card-row">
              <div className="recharge-card-balance">
                <span className="recharge-card-balance-icon">💰</span>
                <span className="recharge-card-balance-label">余额</span>
                <span className="recharge-card-balance-amount">
                  ${cur ? Number(cur.balance_usd).toFixed(2) : '0.00'}
                </span>
                {cur?.is_trial && <span className="balance-trial-tag">试用</span>}
              </div>
              {desc && <span className="recharge-card-group-hint">{desc}</span>}
              <div className="recharge-card-input">
                <span className="recharge-card-input-label">充值</span>
                <div className="recharge-input-wrap">
                  <span className="recharge-currency">$</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={groupAmounts[g.name] || ''}
                    onChange={e => onAmountChange(g.name, e.target.value)}
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
              <th>类型</th>
              <th>单价</th>
            </tr>
          </thead>
          <tbody>
            {models.map(m => (
              <tr key={m.name}>
                <td>{m.display_name || m.name}</td>
                <td>{m.model_type === 'image' ? '图片' : '对话'}</td>
                <td>
                  {m.model_type === 'image'
                    ? (m.price_per_image ? `$${m.price_per_image}/张` : '-')
                    : (m.price_input_per_m
                      ? `输入 $${m.price_input_per_m}/1M tokens`
                      : '-')
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
              {records.slice(0, 50).map((r, i) => (
                <tr key={i}>
                  <td>{r.model}</td>
                  <td>{r.type === 'image' ? '图片' : '对话'}</td>
                  <td>{r.type === 'image' ? `${r.quantity} 张` : `${r.quantity} tokens`}</td>
                  <td>${Number(r.cost_usd).toFixed(4)}</td>
                  <td>{r.created_at?.replace('T', ' ').slice(0, 16)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

