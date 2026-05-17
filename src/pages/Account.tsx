import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuthStore, setGroupTypeMap, isImageGroup, getGroupTypeMap } from '../store/useAuthStore';
import { serverApi, type ServerModel, type UserToken, type PackageGroup } from '../services/serverApi';
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
}

type AllocStatus = 'pending' | 'paid' | 'allocated' | 'closed' | 'unknown';

export default function Account() {
  const { user, isLoggedIn, refreshUser, logout, upgradeTrial, showAuthPrompt } = useAuthStore();
  const [trialLoading, setTrialLoading] = useState(false);
  const [usage, setUsage] = useState<any[]>([]);
  const [models, setModels] = useState<ServerModel[]>([]);
  const [exchangeRate, setExchangeRate] = useState<number>(0);
  const [groupDescs, setGroupDescs] = useState<Record<string, string>>({});
  const [groupAmounts, setGroupAmounts] = useState<Record<string, string>>({});
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
  const allocTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isLoggedIn) return;
    refreshUser();
    loadModels();
    loadPackages();
    loadUsage();
  }, [isLoggedIn]);

  useEffect(() => () => {
    if (allocTimerRef.current) clearInterval(allocTimerRef.current);
  }, []);

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
      const data = await serverApi.getUsage();
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
  const minUsd = exchangeRate > 0 ? 1 / exchangeRate : 1;

  function setAmount(group: string, value: string) {
    if (!/^\d{0,4}(\.\d{0,2})?$/.test(value) && value !== '') return;
    setGroupAmounts(prev => ({ ...prev, [group]: value }));
  }

  async function handleBuy() {
    const items = Object.entries(groupAmounts)
      .map(([group, v]) => ({ group, amount_usd: parseFloat(v) || 0 }))
      .filter(i => i.amount_usd >= minUsd && i.amount_usd <= 1000);
    if (items.length === 0) {
      alert(`请至少为一个分组输入有效金额（${minUsd.toFixed(2)}-1000 美元）`);
      return;
    }
    setOrdering(true);
    setStatusMsg('正在创建订单...');
    try {
      const orders: PendingOrder[] = [];
      const initAlloc: Record<string, AllocStatus> = {};
      let firstCodeUrl = '';
      for (const it of items) {
        const r = await serverApi.createOrder(it.group, it.amount_usd, 'wxpay');
        orders.push({
          out_trade_no: r.out_trade_no,
          group: it.group,
          amount_usd: it.amount_usd,
          amount_cny: r.amount_cny,
        });
        initAlloc[r.out_trade_no] = 'pending';
        if (r.code_url && !firstCodeUrl) firstCodeUrl = r.code_url;
      }
      setPendingOrders(orders);
      setAllocMap(initAlloc);

      if (firstCodeUrl) {
        const qrDataUrl = await QRCode.toDataURL(firstCodeUrl, { width: 200, margin: 2 });
        setQrCodeUrl(qrDataUrl);
        setQrCodeLink(firstCodeUrl);
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
        setStatusMsg('支付超时，订单已关闭。如需充值请重新下单。');
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
        setStatusMsg('支付成功，等待管理员分配 Token...');
      }
      if (allDone) {
        if (allocTimerRef.current) clearInterval(allocTimerRef.current);
        setPolling(false);
        setStatusMsg('Token 已全部分配完成！');
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
    const img = usage.filter(u => u.usage_type === 'image').reduce((s: number, u: any) => s + Number(u.cost_usd), 0);
    const chat = usage.filter(u => u.usage_type === 'chat').reduce((s: number, u: any) => s + Number(u.cost_usd), 0);
    return [
      { name: '图片生成', value: parseFloat(img.toFixed(4)), fill: 'var(--accent-primary)' },
      { name: '智能对话', value: parseFloat(chat.toFixed(4)), fill: 'var(--accent-success)' },
    ].filter(d => d.value > 0);
  }, [usage]);

  const modelCount = useMemo(() => {
    const map: Record<string, number> = {};
    for (const u of usage) {
      map[u.model] = (map[u.model] ?? 0) + 1;
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
          <p className="account-empty-hint">请登录后查看账户信息、余额和充值</p>
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
          ⚠ 余额已耗尽，账户当前为普通账户。Token 已保留，充值后可继续使用。
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

      {/* 分组余额展示 */}
      <div className="account-section">
        <h3>我的余额</h3>
        {userTokens.length === 0 ? (
          <p className="balance-empty">暂无可用分组，请下方充值后开始使用</p>
        ) : (
          <div className="balance-list">
            {userTokens.map(t => (
              <div key={t.group} className="balance-row">
                <span className="balance-group-name">
                  {t.group}
                  {t.is_trial && <span className="balance-trial-tag">试用</span>}
                </span>
                <span className="balance-amount">${t.balance_usd.toFixed(4)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Token 信息按钮 */}
      {userTokens.length > 0 && (
        <div className="account-section" style={{ display: 'flex', justifyContent: 'center' }}>
          <button className="token-info-btn" onClick={() => setShowTokenDialog(true)}>
            Token 信息
          </button>
        </div>
      )}

      {/* 充值面板 */}
      <div className="account-section">
        <h3>充值</h3>
        {!hasGroups ? (
          <p className="balance-empty">暂无可用分组（请确认服务器地址正确）</p>
        ) : (
          <>
            <p className="recharge-hint">为不同模型分别输入充值金额（USD），可同时充多个，金额范围 {minUsd.toFixed(2)} ~ 1000。</p>

            {/* 图文模型 */}
            {groupsByType.image.length > 0 && (
              <RechargeSection
                title="🖼 图文模型"
                modelChips={imageModels.map(m => m.display_name || m.name)}
                groups={groupsByType.image}
                groupDescs={groupDescs}
                tokenByGroup={tokenByGroup}
                groupAmounts={groupAmounts}
                onAmountChange={setAmount}
              />
            )}

            {/* 对话模型 */}
            {groupsByType.chat.length > 0 && (
              <RechargeSection
                title="💬 对话模型"
                modelChips={chatModels.map(m => m.display_name || m.name)}
                groups={groupsByType.chat}
                groupDescs={groupDescs}
                tokenByGroup={tokenByGroup}
                groupAmounts={groupAmounts}
                onAmountChange={setAmount}
              />
            )}

            <div className="recharge-summary">
              <div className="recharge-total">
                <span>合计：</span>
                <span className="recharge-total-usd">${totalUsd.toFixed(2)}</span>
                {exchangeRate > 0 && (
                  <span className="recharge-total-cny">≈ ¥{totalCny.toFixed(2)}</span>
                )}
                {exchangeRate > 0 && (
                  <span className="recharge-rate">汇率 {exchangeRate.toFixed(4)}</span>
                )}
              </div>
              <span className="recharge-pay-method">微信支付</span>
              <button
                className="buy-btn"
                onClick={handleBuy}
                disabled={ordering || polling || totalUsd < minUsd}
              >
                {ordering ? '创建中...' : polling ? '处理中...' : '立即支付'}
              </button>
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
                  st === 'allocated' ? '✓ 已完成' :
                  st === 'paid' ? '⏳ 等待分配' :
                  st === 'closed' ? '已关闭' :
                  st === 'unknown' ? '查询中' : '待支付';
                return (
                  <div key={o.out_trade_no} className="alloc-order-row">
                    <span className="alloc-order-info">
                      {o.group} · ${o.amount_usd.toFixed(2)}（¥{o.amount_cny.toFixed(2)}）
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
                    <td>{u.usage_type === 'image' ? '图片' : '对话'}</td>
                    <td>{u.usage_type === 'image' ? `${u.image_count} 张` : `${u.input_tokens + u.output_tokens} tokens`}</td>
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
    </div>
  );
}

interface RechargeSectionProps {
  title: string;
  modelChips: string[];
  groups: { name: string }[];
  groupDescs: Record<string, string>;
  tokenByGroup: (g: string) => UserToken | undefined;
  groupAmounts: Record<string, string>;
  onAmountChange: (group: string, value: string) => void;
}

function RechargeSection({ title, modelChips, groups, groupDescs, tokenByGroup, groupAmounts, onAmountChange }: RechargeSectionProps) {
  return (
    <div className="recharge-section">
      <div className="recharge-section-title">{title}</div>
      {modelChips.length > 0 && (
        <div className="recharge-section-models">
          {modelChips.map(name => (
            <span key={name} className="model-chip">{name}</span>
          ))}
        </div>
      )}
      <div className="recharge-list">
        {groups.map(g => {
          const cur = tokenByGroup(g.name);
          const desc = groupDescs[g.name];
          return (
            <div key={g.name} className="recharge-row">
              <div className="recharge-info">
                <span className="recharge-group-name">{g.name}</span>
                {desc && <span className="recharge-group-desc">{desc}</span>}
                <span className="recharge-current">
                  当前 ${cur ? cur.balance_usd.toFixed(2) : '0.00'}
                </span>
              </div>
              <div className="recharge-input-wrap">
                <span className="recharge-currency">$</span>
                <input
                  className="recharge-input"
                  type="text"
                  inputMode="decimal"
                  value={groupAmounts[g.name] ?? ''}
                  onChange={e => onAmountChange(g.name, e.target.value)}
                  placeholder="0"
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

