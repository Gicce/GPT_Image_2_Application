import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { UsageTrendMetric } from '../services/serverApi';

interface Props {
  points: { date: string; value: number }[];
  metric: UsageTrendMetric;
}

const METRIC_LABEL: Record<UsageTrendMetric, string> = {
  image_count: '图片数量',
  request_count: '生成次数',
  cost: '消费金额',
};

function formatMetricValue(metric: UsageTrendMetric, value: number): string {
  if (metric === 'cost') return `$${value.toFixed(2)}`;
  return String(value);
}

/** 趋势图：数据完全来自后端 /api/usage/trend（已按天补零）。 */
export default function AccountUsageCharts({ points, metric }: Props) {
  const isCost = metric === 'cost';
  const hasData = points.some(p => p.value > 0);

  const yTickFormatter = (v: number) => (isCost ? `$${v.toFixed(2)}` : String(Math.round(v)));

  return (
    <div className="usage-chart-card">
      <div className="usage-chart-title">{METRIC_LABEL[metric]} · 每日趋势</div>
      {hasData ? (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={points} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(d: string) => d.slice(5)} minTickGap={24} />
            <YAxis
              tick={{ fontSize: 10 }}
              tickFormatter={yTickFormatter}
              width={56}
              domain={isCost ? ['auto', 'auto'] : [0, (max: number) => Math.max(1, Math.ceil(max))]}
              allowDecimals={isCost}
            />
            <Tooltip
              formatter={(value) => [formatMetricValue(metric, Number(value)), METRIC_LABEL[metric]]}
              labelStyle={{ fontSize: 12 }}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
            <Line type="monotone" dataKey="value" stroke="var(--accent-primary)" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="usage-chart-empty">
          <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
            <path d="M3 20h18M6 16l4-6 3 3 5-8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p>当前时间范围暂无用量数据</p>
        </div>
      )}
    </div>
  );
}
