/**
 * AccountLedgerPanel — 点数流水（Wallet / Ledger Pattern）
 *
 * 展示：充值 / 生成消费 / 失败释放 / 退款 / 试用赠送 / 活动赠送。
 * 数据全部来自 GET /api/billing/ledger；金额方向由服务端归一
 * （消费为负、入账为正），本组件不做任何计算。
 */

import { useCallback, useEffect, useState } from 'react';
import { serverApi, type LedgerRecord } from '../services/serverApi';

const STATUS_LABELS: Record<string, string> = {
  RESERVED: '已预占',
  SUCCESS: '已完成',
  FAILED: '已失败（退回）',
  RELEASED: '已释放',
  REFUNDED: '已退款',
};

const PAGE_SIZE = 15;

export default function AccountLedgerPanel() {
  const [records, setRecords] = useState<LedgerRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const data = await serverApi.getLedger(p, PAGE_SIZE);
      setRecords(data.records);
      setTotal(data.total);
    } catch (e: any) {
      setError(e?.message || '流水加载失败');
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(1); }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="ledger-panel">
      {error && <p className="ledger-empty">{error}</p>}
      {!error && loading && records.length === 0 && <p className="ledger-empty">加载中...</p>}
      {!error && !loading && records.length === 0 && <p className="ledger-empty">暂无点数流水</p>}
      {records.length > 0 && (
        <>
          <table className="ledger-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>变动</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {records.map(r => {
                const amount = r.amount_credits ?? 0;
                const positive = amount >= 0;
                const note = r.type === 'IMAGE2_CHARGE'
                  ? (r.status === 'RESERVED' ? `预占 ${r.image_count} 张` : `共 ${r.image_count} 张`)
                  : r.type === 'IMAGE2_REFUND' ? '生成退款'
                  : r.type === 'RECHARGE' ? '充值到账'
                  : r.type === 'RECHARGE_REFUND' ? '充值退款冲正'
                  : r.type === 'MIGRATION' ? '旧余额迁移'
                  : r.remark || '-';
                return (
                  <tr key={r.id}>
                    <td className="ledger-cell-time">{r.created_at?.replace('T', ' ').slice(0, 16) || '-'}</td>
                    <td>
                      {r.type_label}
                      {r.status !== 'SUCCESS' && r.type === 'IMAGE2_CHARGE' && (
                        <span className="ledger-status-note">（{STATUS_LABELS[r.status] || r.status}）</span>
                      )}
                    </td>
                    <td className={`ledger-cell-amount ${positive ? 'positive' : 'negative'}`}>
                      {positive ? '+' : ''}{amount.toLocaleString()} 点
                    </td>
                    <td className="ledger-cell-note">{note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {totalPages > 1 && (
            <div className="ledger-pagination">
              <button disabled={page <= 1 || loading} onClick={() => { const p = page - 1; setPage(p); void load(p); }}>上一页</button>
              <span>{page} / {totalPages}</span>
              <button disabled={page >= totalPages || loading} onClick={() => { const p = page + 1; setPage(p); void load(p); }}>下一页</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
