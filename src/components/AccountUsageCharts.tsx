import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export type UsageChartTab = 'line' | 'pie' | 'bar';

interface UsageCostPoint {
  date: string;
  cost: number;
}

interface UsageTypeCostPoint {
  name: string;
  value: number;
  fill: string;
}

interface UsageModelCountPoint {
  model: string;
  count: number;
}

interface Props {
  dailyCost: UsageCostPoint[];
  modelCount: UsageModelCountPoint[];
  typeCost: UsageTypeCostPoint[];
  usageChartTab: UsageChartTab;
  onTabChange: (tab: UsageChartTab) => void;
}

export default function AccountUsageCharts({
  dailyCost,
  modelCount,
  typeCost,
  usageChartTab,
  onTabChange,
}: Props) {
  return (
    <div className="usage-charts">
      <div className="usage-chart-tabs">
        <button className={`usage-tab ${usageChartTab === 'line' ? 'active' : ''}`} onClick={() => onTabChange('line')} title="每日费用趋势">
          趋势
        </button>
        <button className={`usage-tab ${usageChartTab === 'pie' ? 'active' : ''}`} onClick={() => onTabChange('pie')} title="图片与对话占比">
          占比
        </button>
        <button className={`usage-tab ${usageChartTab === 'bar' ? 'active' : ''}`} onClick={() => onTabChange('bar')} title="模型调用次数">
          模型
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
                <Tooltip formatter={(value) => [`$${value}`, '费用']} />
                <Line type="monotone" dataKey="cost" stroke="var(--accent-primary)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </>
        )}
        {usageChartTab === 'pie' && typeCost.length > 0 && (
          <>
            <div className="usage-chart-title">图片与对话占比</div>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={typeCost}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={70}
                  label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                  labelLine={false}
                >
                  {typeCost.map((entry, index) => (
                    <Cell key={index} fill={entry.fill} />
                  ))}
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
  );
}
