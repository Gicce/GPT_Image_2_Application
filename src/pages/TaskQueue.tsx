import { useEffect, useState } from 'react';
import { useTaskStore } from '../store/useTaskStore';
import { evaluationsOfTask, useEvaluationStore } from '../store/useEvaluationStore';
import { aggregateTaskEvaluations, taskEvaluationSummary } from '../features/evaluation/evaluationModel';
import type { Task } from '../types';
import EditTaskModal from '../components/EditTaskModal';
import BatchRedoModal from '../components/BatchRedoModal';
import DeleteTaskDialog from '../components/DeleteTaskDialog';
import TaskFilterBar from '../components/TaskFilterBar';
import { toastError, toastSuccess } from '../components/Toast';
import { copyText } from '../utils/clipboard';
import { formatDuration } from '../utils/taskDuration';
import { executionModeLabel, formatTaskDateTime, promptOptimizationState } from '../utils/taskDisplay';
import {
  deriveTaskState,
  DERIVED_STATUS_META,
  resolveTaskFinishedAt,
  resolveTaskStartedAt,
  taskDurationMs,
} from '../utils/taskState';
import { attemptFailureHistory, classifySubTaskFailure, describeEndpoint } from '../utils/taskFailure';
import { openTaskDetailFromQueue } from '../utils/taskNavigation';
import {
  filterTasksByCategory,
  filterTasksByStatus,
  getTaskCategoryCounts,
  getTaskCategoryLabel,
  getTaskTypeExtraLabel,
  type TaskCategoryFilter,
  type TaskStatusFilter,
} from '../utils/taskCategory';
import { poseBatchTaskSourceLabel } from '../utils/poseBatch';
import TaskBillingBadge from '../components/TaskBillingBadge';
import './TaskQueue.css';
import './ImageEdit.css';

const SUB_STATUS_LABEL: Record<string, string> = {
  pending: '等待中',
  running: '生成中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const FOCUS_KEY = 'cy_taskqueue_focus_id';

/** 尝试历史的时钟展示（HH:mm:ss）。 */
function formatClock(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 前端驱动型任务（视觉理解）：不产出图片、不走生成接口 */
function isVisionTask(task: Task): boolean {
  return task.task_type === 'vision_understanding';
}

function getSourceLabel(task: Task): string {
  // cy-video-studio 细分：动作白膜批（pose_batch）与视频复刻单任务
  if (task.task_source === 'cy-video-studio') return poseBatchTaskSourceLabel(task);
  return task.task_source === 'agent' ? 'Agent' : '手动';
}

/** 执行接口脱敏摘要（完整 URL 只进失败卡「技术详情」；凭据从不出现在 endpoint） */
function getApiEndpointSummary(task: Task): string {
  if (isVisionTask(task)) return 'BYOK 视觉模型（用户自配，非服务端计费）';
  if (task.task_type === 'remove_background') return describeEndpoint('https://api.remove.bg/v1.0/removebg');
  // 摘要统一显示 path（历史任务的 runtime base_url 可能不同，不在此硬编码 host）
  return task.task_type === 'edit'
    ? describeEndpoint('/v1/images/edits')
    : describeEndpoint('/v1/images/generations');
}

function getSubTaskStatusLabel(status: string): string {
  return SUB_STATUS_LABEL[status] || status;
}

/** 批量任务判定：batch 执行模式或携带 batch_items（重做走 BatchRedoModal，不再用单任务编辑弹窗） */
function isBatchTask(task: Task): boolean {
  return task.execution_mode === 'batch' || (task.batch_items?.length ?? 0) > 0;
}

export default function TaskQueue() {
  const { tasks, loadTasks, cancelTask, deleteTask, retryTaskFailed } = useTaskStore();
  const evaluations = useEvaluationStore(s => s.evaluations);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [redoingTask, setRedoingTask] = useState<Task | null>(null);
  const [deletingTask, setDeletingTask] = useState<Task | null>(null);
  const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(new Set());
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const [expandedDetails, setExpandedDetails] = useState<Set<string>>(new Set());
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<TaskCategoryFilter>('all');
  const [activeStatus, setActiveStatus] = useState<TaskStatusFilter>('all');
  // 活跃任务实时耗时刷新：终态任务读持久化 finished/started，只有活跃任务需要 tick
  const [, setDurationTick] = useState(0);
  useEffect(() => {
    const hasActive = useTaskStore.getState().tasks.some(t => t.status === 'pending' || t.status === 'running');
    if (!hasActive) return;
    const timer = setInterval(() => setDurationTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, [tasks]);

  // 任务刷新：task-updated 事件由 useTaskStore 全局单点桥接（ensureTaskEventBridge）
  useEffect(() => { void loadTasks(); }, [loadTasks]);

  // 来自 Chat TaskMessageCard 的 "查看任务" 焦点定位
  useEffect(() => {
    try {
      const stored = localStorage.getItem(FOCUS_KEY);
      if (stored) {
        setFocusTaskId(stored);
        localStorage.removeItem(FOCUS_KEY);
        // 通知 chat 侧清理
        window.dispatchEvent(new CustomEvent('cy-taskqueue-focus-done'));
        // 自动滚动到目标卡片
        setTimeout(() => {
          const el = document.querySelector(`.task-card[data-task-id="${CSS.escape(stored)}"]`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 200);
      }
    } catch {}
  }, [tasks]);

  const togglePrompt = (id: string) => {
    setExpandedPrompts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleDetail = (key: string) => {
    setExpandedDetails(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** V4.0.5 只重试失败子任务：indexes 缺省 = 全部失败项；单下标 = 单个子任务。
   * 反馈一律走应用内 Toast（禁止 native alert 阻塞弹窗）。 */
  const handleRetryFailed = async (task: Task, indexes?: number[]) => {
    const key = indexes ? `${task.id}:${indexes.join(',')}` : `${task.id}:all`;
    if (retryingKey) return;
    setRetryingKey(key);
    try {
      const result = await retryTaskFailed(task.id, indexes);
      const count = indexes && indexes.length === 1 ? 1 : result.resetCount;
      toastSuccess(
        `已将 ${count} 个失败项加入队列，已完成的结果不会重复生成。`,
        '重试任务已加入队列',
      );
    } catch (err) {
      console.error('[TaskQueue] retry failed subtasks error', task.id, err);
      toastError('未能重新加入任务队列，请稍后重试。', '重试失败');
    } finally {
      setRetryingKey(null);
    }
  };

  const handleDeleteConfirm = async (deleteImages: boolean) => {
    if (!deletingTask) return;
    await deleteTask(deletingTask.id, deleteImages);
    setDeletingTask(null);
  };

  const sorted = [...tasks].sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  // 类型数量基于全部任务计算（不随状态筛选变化）；类型 + 状态组合过滤任务列表
  const categoryCounts = getTaskCategoryCounts(sorted);
  const visibleTasks = filterTasksByStatus(
    filterTasksByCategory(sorted, activeCategory),
    activeStatus,
  );

  return (
    <div className="page">
      <div className="page-header">
        <h2>任务队列</h2>
        <p>统一查看 Agent 和手动创建的图片任务的执行状态、失败原因与重试；完整审计请进历史记录详情。</p>
      </div>

      {sorted.length > 0 && (
        <TaskFilterBar
          typeCounts={categoryCounts}
          activeType={activeCategory}
          onTypeChange={setActiveCategory}
          activeStatus={activeStatus}
          onStatusChange={setActiveStatus}
        />
      )}

      {sorted.length === 0 ? (
        <div className="empty-state">
          <p>暂无任务</p>
          <p className="empty-hint">创建文生图、图生图、透明背景或批量任务后会显示在这里。</p>
        </div>
      ) : visibleTasks.length === 0 ? (
        <div className="empty-state">
          <p>没有符合筛选条件的任务</p>
          <p className="empty-hint">调整上方的任务类型或任务状态筛选。</p>
        </div>
      ) : (
        <div className="task-list">
          {visibleTasks.map(task => {
            // 状态一律从 sub_tasks 事实派生（后端事件丢失也不再卡在「生成中」）
            const derived = deriveTaskState(task);
            const statusMeta = DERIVED_STATUS_META[derived];
            const isActive = derived === 'queued' || derived === 'running';
            const terminal = !isActive;
            const hasFailedSlots = (derived === 'failed' || derived === 'partial') && task.failed_count > 0;
            const done = task.success_count + task.failed_count;
            const pct = task.count > 0 ? Math.round((done / task.count) * 100) : 0;
            const imageCount = task.sub_tasks.filter(s => s.image_id).length;
            const hasPromptDiff = !!task.final_prompt && task.final_prompt !== task.user_prompt_raw;
            const labels = task.sub_tasks.map(item => item.label).filter(Boolean) as string[];
            const subTaskErrors = task.sub_tasks.filter(subTask => subTask.error);
            const optimized = promptOptimizationState(task).applied;
            const startedAt = resolveTaskStartedAt(task);
            const finishedAt = resolveTaskFinishedAt(task);
            const durationText = terminal ? formatDuration(taskDurationMs(task)) : '';
            // 任务行轻量评分（Phase 22）：只显示 best 摘要，每张图明细进任务详情 / 图库
            const evaluationSummary = taskEvaluationSummary(
              aggregateTaskEvaluations(evaluationsOfTask({ evaluations }, task.id)),
              imageCount,
            );

            return (
              <div
                key={task.id}
                className={`task-card${focusTaskId === task.id ? ' focused' : ''}`}
                data-task-id={task.id}
              >
                <div className="task-card-header">
                  <div>
                    <span className={`status-badge ${statusMeta.cls}`}>{statusMeta.label}</span>
                    <span className="type-badge edit-badge">{getTaskCategoryLabel(task)}</span>
                    {getTaskTypeExtraLabel(task) && (
                      <span className="type-badge">{getTaskTypeExtraLabel(task)}</span>
                    )}
                    <span className="type-badge">{getSourceLabel(task)}</span>
                    <span className="type-badge">{executionModeLabel(task)}</span>
                    {task.source_task_kind === 'vision_understanding' && (
                      <span className="type-badge">来源：视觉理解任务{task.source_task_id ? ` #${task.source_task_id.slice(0, 8)}` : ''}</span>
                    )}
                    <span className="task-id">#{task.id.slice(0, 8)}</span>
                  </div>
                  <div className="task-time-block">
                    {isActive ? (
                      startedAt && (
                        <span className="task-time">开始 {formatTaskDateTime(startedAt)}</span>
                      )
                    ) : (
                      <>
                        <span className="task-time">开始 {formatTaskDateTime(startedAt ?? '') || '—'}</span>
                        <span className="task-time">结束 {formatTaskDateTime(finishedAt ?? '') || '—'}</span>
                        <span className="task-time">耗时 {durationText || '—'}</span>
                      </>
                    )}
                  </div>
                </div>

                {isVisionTask(task) && isActive && task.stage_note && (
                  <p className="task-dir">阶段：{task.stage_note}</p>
                )}

                {(() => {
                  // 活跃任务实时耗时：优先 started_at，旧任务回落 created_at（仅执行中展示）
                  if (!isActive) return null;
                  const startIso = startedAt || task.created_at;
                  const elapsed = Date.now() - new Date(startIso).getTime();
                  if (!Number.isFinite(elapsed) || elapsed <= 0) return null;
                  const text = formatDuration(elapsed);
                  if (!text) return null;
                  return (
                    <p className="task-dir task-queue-elapsed">
                      {derived === 'running' ? '生成中' : '等待中'} · {text}
                    </p>
                  );
                })()}

                <div className="task-card-body">
                  <p
                    className={`task-prompt ${expandedPrompts.has(task.id) ? 'expanded' : ''}`}
                    title={task.user_prompt_raw || task.prompt}
                    onClick={() => togglePrompt(task.id)}
                  >
                    {task.user_prompt_raw || task.prompt}
                  </p>

                  <div className="task-meta">
                    <span>{task.size}</span>
                    <span>{task.quality}</span>
                    <span>{task.output_format.toUpperCase()}</span>
                    {!isVisionTask(task) && <span>{task.count} 张</span>}
                    <span>{optimized ? '已优化提示词' : '原始提示词'}</span>
                    <TaskBillingBadge taskId={task.id} />
                    {evaluationSummary && <span className="task-eval-summary">{evaluationSummary}</span>}
                  </div>

                  {task.task_plan_summary && (
                    <p className="task-dir">任务计划：{task.task_plan_summary}</p>
                  )}

                  {labels.length > 0 && (
                    <p className="task-dir">子任务标签：{labels.join('、')}</p>
                  )}

                  {hasPromptDiff && (
                    <div className="task-errors">
                      <p className="task-dir">最终提示词：{task.final_prompt}</p>
                      {task.final_negative_prompt && (
                        <p className="task-dir">负面提示词：{task.final_negative_prompt}</p>
                      )}
                    </div>
                  )}

                  {derived === 'running' && !isVisionTask(task) && (
                    <div className="progress-bar-wrap">
                      <div className="progress-bar" style={{ width: `${pct}%` }} />
                      <span className="progress-text">{done} / {task.count} ({pct}%)</span>
                    </div>
                  )}

                  {!isVisionTask(task) && (
                    <div className="task-stats">
                      <span className="stat-ok">成功: {task.success_count}</span>
                      <span className="stat-fail">失败: {task.failed_count}</span>
                      <span>结果图: {imageCount}</span>
                    </div>
                  )}

                  {task.source_images.length > 0 && (
                    <p className="task-dir">源图数量: {task.source_images.length}</p>
                  )}
                  {task.output_dir && (
                    <p className="task-dir">输出目录: {task.output_dir}</p>
                  )}
                  <p className="task-dir">执行接口: {getApiEndpointSummary(task)}</p>

                  {subTaskErrors.length > 0 && (
                    <div className="task-errors">
                      {subTaskErrors.map(subTask => {
                        // canonical failure model：结构化 detail 优先，旧 string 回落解析
                        const failure = classifySubTaskFailure(subTask);
                        const attempts = attemptFailureHistory(subTask);
                        const detailKey = `${task.id}-${subTask.index}`;
                        const detailOpen = expandedDetails.has(detailKey);
                        const tech = failure.technical;
                        return (
                          <div key={detailKey} className="task-subtask-error">
                            <p className="task-error-title">
                              <span className="task-error-icon" aria-hidden="true">⚠</span>
                              子任务 {subTask.index + 1}{subTask.label ? ` (${subTask.label})` : ''} · {failure.title}
                            </p>
                            <p className="task-error-message">{failure.userMessage}</p>
                            {failure.suggestion && (
                              <p className="task-error-hint">{failure.suggestion}</p>
                            )}
                            {attempts.length > 1 && (
                              <p className="task-error-attempt-count">历史尝试：{attempts.length} 次</p>
                            )}
                            <div className="task-subtask-error-actions">
                              {hasFailedSlots && !isVisionTask(task) && (
                                <button
                                  className="subtask-retry-btn"
                                  disabled={retryingKey !== null}
                                  onClick={() => void handleRetryFailed(task, [subTask.index])}
                                >
                                  {retryingKey === `${task.id}:${subTask.index}` ? '提交中…' : '重新生成'}
                                </button>
                              )}
                              <button className="subtask-detail-btn" onClick={() => toggleDetail(detailKey)}>
                                {detailOpen ? '收起技术详情' : '查看技术详情 ▾'}
                              </button>
                            </div>
                            {detailOpen && (
                              <div className="task-error-detail">
                                <div className="task-error-tech">
                                  <div className="task-error-tech-row">
                                    <span>错误类型</span><code>{failure.category}</code>
                                  </div>
                                  {tech?.httpStatus !== undefined && (
                                    <div className="task-error-tech-row">
                                      <span>HTTP 状态</span><code>{tech.httpStatus}</code>
                                    </div>
                                  )}
                                  {tech?.providerCode && (
                                    <div className="task-error-tech-row">
                                      <span>Provider Code</span><code>{tech.providerCode}</code>
                                    </div>
                                  )}
                                  {tech?.endpoint && (
                                    <div className="task-error-tech-row">
                                      <span>Endpoint</span><code>{tech.endpoint}</code>
                                    </div>
                                  )}
                                  {tech?.requestId && (
                                    <div className="task-error-tech-row">
                                      <span>Request ID</span><code>{tech.requestId}</code>
                                    </div>
                                  )}
                                </div>
                                {(tech?.rawMessage || subTask.error) && (
                                  <div className="task-error-raw">
                                    <p>{tech?.rawMessage || subTask.error}</p>
                                    <button
                                      type="button"
                                      className="subtask-detail-btn"
                                      onClick={() => {
                                        void copyText(tech?.rawMessage || subTask.error || '').then(ok => {
                                          if (ok) toastSuccess('原始错误已复制');
                                        });
                                      }}
                                    >
                                      复制
                                    </button>
                                  </div>
                                )}
                                {attempts.length > 1 && (
                                  <div className="task-error-attempts">
                                    {attempts.map((attempt, i) => (
                                      <p key={i} className="task-attempt-item">
                                        尝试 {i + 1}{attempt.timestamp ? ` ${formatClock(attempt.timestamp)}` : ''}
                                        {' '}{attempt.info.title}
                                        {attempt.info.technical?.httpStatus !== undefined
                                          ? ` · HTTP ${attempt.info.technical.httpStatus}` : ''}
                                      </p>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {(derived === 'failed' || derived === 'partial' || derived === 'cancelled') && task.sub_tasks.length > 0 && (
                    <div className="task-errors">
                      {task.sub_tasks.map(subTask => {
                        const retried = subTask.retry_count ?? 0;
                        return (
                          <p key={`${task.id}-status-${subTask.index}`} className="task-error">
                            子任务 {subTask.index + 1}{subTask.label ? ` (${subTask.label})` : ''}: {getSubTaskStatusLabel(subTask.status)}
                            {subTask.status === 'completed' && retried > 0 ? `（重新生成 ${retried} 次后成功）` : ''}
                          </p>
                        );
                      })}
                    </div>
                  )}

                  {derived === 'completed' && task.sub_tasks.some(st => (st.retry_count ?? 0) > 0) && (
                    <div className="task-errors">
                      {task.sub_tasks
                        .filter(st => (st.retry_count ?? 0) > 0)
                        .map(subTask => (
                          <p key={`${task.id}-retried-${subTask.index}`} className="task-error">
                            子任务 {subTask.index + 1}{subTask.label ? ` (${subTask.label})` : ''}: 重新生成 {subTask.retry_count} 次后成功
                          </p>
                        ))}
                    </div>
                  )}
                </div>

                <div className="task-card-actions">
                  {isActive && (
                    <button className="cancel-btn" onClick={() => cancelTask(task.id)}>
                      取消任务
                    </button>
                  )}
                  {terminal && hasFailedSlots && !isVisionTask(task) && (
                    <button
                      className="retry-btn"
                      disabled={retryingKey !== null}
                      onClick={() => void handleRetryFailed(task)}
                    >
                      {retryingKey === `${task.id}:all`
                        ? '提交中…'
                        : derived === 'partial'
                          ? `重试失败项（${task.failed_count}）`
                          : `重新生成失败项（${task.failed_count}）`}
                    </button>
                  )}
                  {terminal && (
                    <button
                      className="task-detail-nav-btn"
                      onClick={() => openTaskDetailFromQueue(task.id)}
                    >
                      查看任务详情
                    </button>
                  )}
                  {terminal && isBatchTask(task) && (
                    <button className="edit-resend-btn" onClick={() => setRedoingTask(task)}>
                      重做
                    </button>
                  )}
                  {terminal && !isBatchTask(task) && !isVisionTask(task) && (
                    <button className="edit-resend-btn" onClick={() => setEditingTask(task)}>
                      编辑重发
                    </button>
                  )}
                  {terminal && (
                    <button className="delete-task-btn" onClick={() => setDeletingTask(task)}>
                      删除
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editingTask && (
        <EditTaskModal task={editingTask} onClose={() => setEditingTask(null)} />
      )}

      {redoingTask && (
        <BatchRedoModal task={redoingTask} onClose={() => setRedoingTask(null)} />
      )}

      {deletingTask && (
        <DeleteTaskDialog
          taskPrompt={deletingTask.user_prompt_raw || deletingTask.prompt}
          imageCount={deletingTask.sub_tasks.filter(s => s.image_id).length}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeletingTask(null)}
        />
      )}
    </div>
  );
}
