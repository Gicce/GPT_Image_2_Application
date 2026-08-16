import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  serverApi,
  type UsageModelStat,
  type UsageRecordsResponse,
  type UsageSummary,
  type UsageTrendMetric,
  type UsageTrendResponse,
} from '../services/serverApi';
import { resolveUsageRange, type UsageRangeKey } from '../utils/usageRange';

const AccountUsageCharts = lazy(() => import('./AccountUsageCharts'));

type UsageTab = 'trend' | 'models' | 'records';
type RangeKey = UsageRangeKey;

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: 'month', label: '本月' },
  { key: 'custom', label: '自定义' },
];

const TAB_OPTIONS: { key: UsageTab; label: string }[] = [
  { key: 'trend', label: '趋势' },
  { key: 'models', label: '模型' },
  { key: 'records', label: '明细' },
];

const METRIC_OPTIONS: { key: UsageTrendMetric; label: string }[] = [
  { key: 'image_count', label: '图片数量' },
  { key: 'request_count', label: '生成次数' },
  { key: 'cost', label: '消费金额' },
];

const TYPE_OPTIONS = [
  { key: '', label: '全部类型' },
  { key: 'image', label: '图片生成' },
  { key: 'postprocess', label: '图片后处理' },
  { key: 'agent', label: 'AI 智能体' },
];

const PAGE_SIZE_OPTIONS = [20, 50, 100];

/**
 * 统一错误文案：后端原始错误（Not Found / HTTP 500 / fetch failed 等）只进 console，
 * 主 UI 仅展示可理解的原因提示。
 */
function friendlyUsageError(err: unknown, fallback: string): string {
  const e = err as { status?: number; isNetworkError?: boolean; message?: string } | null;
  console.error('[AccountUsagePanel] 用量数据请求失败:', err);
  if (e?.status === 404) return '当前服务器版本暂不支持用量统计，请更新后端服务后重试';
  if (e?.status === 401) return '登录状态已过期，请重新登录后再试';
  if (e?.isNetworkError) return '无法连接服务器，请检查网络与服务器地址';
  return fallback;
}

function usageTypeLabel(t: string): string {
  if (t === 'image') return '图片生成';
  if (t === 'postprocess') return '图片后处理';
  if (t === 'agent') return 'AI 智能体';
  if (t === 'chat') return 'AI 智能体（旧）';
  return t;
}

/**
 * 最近用量面板：趋势 / 模型 / 明细 三个视图共用一套时间范围。
 * 全部数据来自服务器 usage 聚合接口（同一张 usage_logs 账单底表），前端不做伪统计。
 */
export default function AccountUsagePanel() {
  const [tab, setTab] = useState<UsageTab>('trend');
  const [rangeKey, setRangeKey] = useState<RangeKey>('7d');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [metric, setMetric] = useState<UsageTrendMetric>('image_count');

  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [trend, setTrend] = useState<UsageTrendResponse | null>(null);
  const [modelStats, setModelStats] = useState<UsageModelStat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // 明细筛选与分页
  const [filterModel, setFilterModel] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterKeyword, setFilterKeyword] = useState('');
  const [records, setRecords] = useState<UsageRecordsResponse | null>(null);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // 快速切换时间范围/指标时丢弃过期响应，避免旧结果覆盖新结果
  const statsSeqRef = useRef(0);
  const recordsSeqRef = useRef(0);

  const range = useMemo(() => resolveUsageRange(rangeKey, customStart, customEnd), [rangeKey, customStart, customEnd]);

  const reloadStats = useCallback((start: string, end: string, m: UsageTrendMetric) => {
    const seq = ++statsSeqRef.current;
    setLoading(true);
    setError('');
    Promise.all([
      serverApi.getUsageSummary(start, end),
      serverApi.getUsageTrend(start, end, m),
      serverApi.getUsageModels(start, end).catch(() => [] as UsageModelStat[]),
    ])
      .then(([s, t, ms]) => {
        if (seq !== statsSeqRef.current) return;
        setSummary(s);
        setTrend(t);
        setModelStats(ms);
      })
      .catch(err => {
        if (seq !== statsSeqRef.current) return;
        setError(friendlyUsageError(err, '请稍后重试，或检查服务器设置'));
      })
      .finally(() => {
        if (seq === statsSeqRef.current) setLoading(false);
      });
  }, []);

  const reloadRecords = useCallback((p: number, size: number, model: string, type: string, keyword: string, start: string, end: string) => {
    const seq = ++recordsSeqRef.current;
    setRecordsLoading(true);
    setRecordsError('');
    serverApi.getUsageRecords(p, size, model || undefined, type || undefined, start, end, keyword.trim() || undefined)
      .then(data => {
        if (seq !== recordsSeqRef.current) return;
        setRecords(data);
      })
      .catch(err => {
        if (seq !== recordsSeqRef.current) return;
        setRecordsError(friendlyUsageError(err, '请稍后重试，或检查服务器设置'));
      })
      .finally(() => {
        if (seq === recordsSeqRef.current) setRecordsLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!range.start || !range.end) return;
    reloadStats(range.start, range.end, metric);
  }, [range.start, range.end, metric, reloadStats]);

  useEffect(() => {
    if (tab !== 'records') return;
    reloadRecords(page, pageSize, filterModel, filterType, filterKeyword, range.start, range.end);
  }, [tab, page, pageSize, filterModel, filterType, filterKeyword, range.start, range.end, reloadRecords]);

  // 筛选变化时回到第 1 页
  useEffect(() => { setPage(1); }, [filterModel, filterType, filterKeyword, pageSize, rangeKey, customStart, customEnd]);

  const statCards = [
    { label: '图片数量', value: summary ? `${summary.image_count} 张` : '—' },
    { label: '生成次数', value: summary ? `${summary.request_count} 次` : '—' },
    { label: '区间消费', value: summary ? `$${Number(summary.period_spent).toFixed(2)}` : '—' },
    { label: '累计消费', value: summary ? `$${Number(summary.total_spent).toFixed(2)}` : '—' },
  ];

  const modelOptions = useMemo(() => {
    const names = new Set<string>();
    for (const m of modelStats) names.add(m.model);
    return ['', ...Array.from(names).sort()];
  }, [modelStats]);

  const totalPages = records ? Math.max(1, Math.ceil(records.total / records.page_size)) : 1;

  return (
    <div className="usage-panel">
      <div className="usage-panel-toolbar">
        <div className="usage-segmented" role="tablist">
          {TAB_OPTIONS.map(t => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`usage-segmented-item ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="usage-range-row">
          {RANGE_OPTIONS.map(r => (
            <button
              key={r.key}
              className={`usage-range-chip ${rangeKey === r.key ? 'active' : ''}`}
              onClick={() => setRangeKey(r.key)}
            >
              {r.label}
            </button>
          ))}
          {rangeKey === 'custom' && (
            <span className="usage-custom-range">
              <input
                type="date"
                value={customStart}
                max={customEnd || undefined}
                onChange={e => setCustomStart(e.target.value)}
                aria-label="开始日期"
              />
              <span>至</span>
              <input
                type="date"
                value={customEnd}
                min={customStart || undefined}
                onChange={e => setCustomEnd(e.target.value)}
                aria-label="结束日期"
              />
            </span>
          )}
        </div>
      </div>

      {error ? (
        <div className="usage-state-error">
          <p>用量数据加载失败：{error}</p>
          <button
            className="settings-btn settings-btn-secondary settings-btn-sm"
            onClick={() => reloadStats(range.start, range.end, metric)}
          >
            重新加载
          </button>
        </div>
      ) : loading ? (
        <div className="usage-skeleton" aria-busy="true">
          <div className="usage-skeleton-row" />
          <div className="usage-skeleton-block" />
        </div>
      ) : (
        <>
          <div className="usage-stat-cards">
            {statCards.map(c => (
              <div className="usage-stat-card" key={c.label}>
                <span className="usage-stat-label">{c.label}</span>
                <span className="usage-stat-value">{c.value}</span>
              </div>
            ))}
          </div>

          {tab === 'trend' && (
            <>
              <div className="usage-metric-row">
                <label>指标</label>
                <select value={metric} onChange={e => setMetric(e.target.value as UsageTrendMetric)}>
                  {METRIC_OPTIONS.map(m => (
                    <option key={m.key} value={m.key}>{m.label}</option>
                  ))}
                </select>
              </div>
              <Suspense fallback={<p className="usage-loading">加载图表中...</p>}>
                <AccountUsageCharts points={trend?.points ?? []} metric={metric} />
              </Suspense>
            </>
          )}

          {tab === 'models' && (
            modelStats.length === 0 ? (
              <div className="usage-chart-empty"><p>当前时间范围暂无用量记录</p></div>
            ) : (
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>类型</th>
                    <th>请求次数</th>
                    <th>数量</th>
                    <th>消费</th>
                  </tr>
                </thead>
                <tbody>
                  {modelStats.map(m => (
                    <tr key={`${m.model}-${m.usage_type}`}>
                      <td>{m.model}</td>
                      <td>{usageTypeLabel(m.usage_type)}</td>
                      <td>{m.request_count}</td>
                      <td>
                        {m.usage_type === 'image' || m.usage_type === 'postprocess'
                          ? `${m.image_count} 张`
                          : `${(m.input_tokens + m.output_tokens).toLocaleString()} tokens`}
                      </td>
                      <td>${Number(m.cost_usd).toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {tab === 'records' && (
            <>
              <div className="usage-filter-row">
                <select value={filterModel} onChange={e => setFilterModel(e.target.value)}>
                  {modelOptions.map(m => (
                    <option key={m} value={m}>{m === '' ? '全部模型' : m}</option>
                  ))}
                </select>
                <select value={filterType} onChange={e => setFilterType(e.target.value)}>
                  {TYPE_OPTIONS.map(t => (
                    <option key={t.key} value={t.key}>{t.label}</option>
                  ))}
                </select>
                <input
                  className="usage-filter-keyword"
                  value={filterKeyword}
                  onChange={e => setFilterKeyword(e.target.value)}
                  placeholder="搜索模型名…"
                />
              </div>
              {recordsError ? (
                <div className="usage-state-error">
                  <p>用量明细加载失败：{recordsError}</p>
                  <button
                    className="settings-btn settings-btn-secondary settings-btn-sm"
                    onClick={() => reloadRecords(page, pageSize, filterModel, filterType, filterKeyword, range.start, range.end)}
                  >
                    重新加载
                  </button>
                </div>
              ) : recordsLoading ? (
                <div className="usage-skeleton" aria-busy="true"><div className="usage-skeleton-block" /></div>
              ) : !records || records.records.length === 0 ? (
                <div className="usage-chart-empty"><p>当前时间范围暂无用量记录</p></div>
              ) : (
                <>
                  <table className="usage-table">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>模型</th>
                        <th>类型</th>
                        <th>数量</th>
                        <th>单价</th>
                        <th>金额</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.records.map(u => {
                        const isImageType = u.usage_type === 'image' || u.usage_type === 'postprocess';
                        const qty = isImageType ? (u.image_count ?? 0) : ((u.input_tokens ?? 0) + (u.output_tokens ?? 0));
                        const unitPrice = u.unit_price != null ? Number(u.unit_price) : null;
                        return (
                          <tr key={u.id}>
                            <td>{u.created_at?.replace('T', ' ').slice(0, 16)}</td>
                            <td>{u.model}</td>
                            <td>{usageTypeLabel(u.usage_type)}</td>
                            <td>{isImageType ? `${qty} 张` : `${qty.toLocaleString()} tokens`}</td>
                            <td>{unitPrice != null ? `$${unitPrice.toFixed(4)}` : '—'}</td>
                            <td>${Number(u.cost_usd).toFixed(4)}</td>
                            <td>
                              <button
                                className="settings-btn settings-btn-link settings-btn-sm"
                                onClick={() => window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'queue' } }))}
                              >
                                查看任务
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div className="usage-pagination">
                    <span className="usage-pagination-total">共 {records.total} 条</span>
                    <div className="usage-pagination-controls">
                      <button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>上一页</button>
                      <span className="usage-pagination-page">{records.page} / {totalPages}</span>
                      <button disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>下一页</button>
                    </div>
                    <label className="usage-pagination-size">
                      每页
                      <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))}>
                        {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
                      </select>
                      条
                    </label>
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
