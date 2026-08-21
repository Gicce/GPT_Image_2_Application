import {
  TASK_CATEGORY_FILTERS,
  TASK_STATUS_FILTERS,
  type TaskCategoryCounts,
  type TaskCategoryFilter,
  type TaskStatusFilter,
} from '../utils/taskCategory';
import './TaskFilterBar.css';

interface TaskFilterBarProps {
  /** 类型筛选各分类数量（含 all，基于当前页面全部任务计算，不随状态筛选变化）。 */
  typeCounts: TaskCategoryCounts;
  activeType: TaskCategoryFilter;
  onTypeChange: (key: TaskCategoryFilter) => void;
  /** 传入即渲染第二行状态筛选（任务队列用；历史记录只有类型筛选）。 */
  activeStatus?: TaskStatusFilter;
  onStatusChange?: (key: TaskStatusFilter) => void;
}

export default function TaskFilterBar(props: TaskFilterBarProps) {
  const { typeCounts, activeType, onTypeChange, activeStatus, onStatusChange } = props;
  const hasStatusRow = activeStatus !== undefined && onStatusChange !== undefined;
  return (
    <div className={`task-filter-bar${hasStatusRow ? ' has-status' : ''}`}>
      <div className="task-filter-row" role="group" aria-label="任务类型筛选">
        <span className="task-filter-row-label">任务类型</span>
        {TASK_CATEGORY_FILTERS.map(item => (
          <button
            key={item.key}
            type="button"
            className={`task-filter-chip${activeType === item.key ? ' active' : ''}`}
            aria-pressed={activeType === item.key}
            onClick={() => onTypeChange(item.key)}
          >
            {item.label} {typeCounts[item.key] ?? 0}
          </button>
        ))}
      </div>
      {hasStatusRow && (
        <div className="task-filter-row" role="group" aria-label="任务状态筛选">
          <span className="task-filter-row-label">任务状态</span>
          {TASK_STATUS_FILTERS.map(item => (
            <button
              key={item.key}
              type="button"
              className={`task-filter-chip${activeStatus === item.key ? ' active' : ''}`}
              aria-pressed={activeStatus === item.key}
              onClick={() => onStatusChange?.(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
