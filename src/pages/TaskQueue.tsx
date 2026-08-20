import { useEffect, useState } from 'react';
import { useTaskStore } from '../store/useTaskStore';
import type { Task } from '../types';
import EditTaskModal from '../components/EditTaskModal';
import DeleteTaskDialog from '../components/DeleteTaskDialog';
import { formatDuration } from '../utils/taskDuration';
import { executionModeLabel, promptOptimizationState } from '../utils/taskDisplay';
import { classifySubTaskError } from '../utils/subtaskError';
import './TaskQueue.css';
import './ImageEdit.css';

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  pending: { label: '排队中', cls: 'status-pending' },
  running: { label: '执行中', cls: 'status-running' },
  completed: { label: '已完成', cls: 'status-completed' },
  failed: { label: '失败', cls: 'status-failed' },
  cancelled: { label: '已取消', cls: 'status-cancelled' },
};

/** 失败但有成功子任务 → 「部分完成」（底层状态保持 failed，兼容历史语义与消费者） */
function isPartialSuccess(task: Task): boolean {
  return task.status === 'failed' && task.success_count > 0;
}

const FOCUS_KEY = 'cy_taskqueue_focus_id';

function getTaskTypeLabel(task: Task): string {
  if (task.task_type === 'edit') return '图生图';
  if (task.task_type === 'remove_background') return '透明背景';
  return '文生图';
}

function getSourceLabel(task: Task): string {
  return task.task_source === 'agent' ? 'Agent' : '手动';
}

function getApiEndpoint(task: Task): string {
  if (task.task_type === 'edit') return 'POST https://www.packyapi.com/v1/images/edits';
  if (task.task_type === 'remove_background') return 'POST https://api.remove.bg/v1.0/removebg';
  return 'POST https://www.packyapi.com/v1/images/generations';
}

function getSubTaskStatusLabel(status: string): string {
  const meta = STATUS_MAP[status];
  return meta?.label || status;
}

export default function TaskQueue() {
  const { tasks, loadTasks, cancelTask, deleteTask, retryTask, retryTaskFailed } = useTaskStore();
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [deletingTask, setDeletingTask] = useState<Task | null>(null);
  const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(new Set());
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const [expandedDetails, setExpandedDetails] = useState<Set<string>>(new Set());
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  // 执行中任务的实时耗时刷新（250ms，低频）。TaskQueue 没有单任务的
  // executionStartedAt（那在 Chat 任务卡上），这里只显示已完成的固定 duration
  // 和进行中的粗略状态 —— 所以用一个轻量 tick 驱动重渲染即可。
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

  /** 整批重新提交（克隆新任务，全部子任务重跑）—— 走 store 计费链路 */
  const handleRetry = async (taskId: string) => {
    try {
      await retryTask(taskId);
      await loadTasks();
      alert('任务已重新提交，请查看队列进度。');
    } catch (err: any) {
      alert(err?.message || err?.toString() || '重新提交失败');
    }
  };

  /** V4.0.5 只重试失败子任务：indexes 缺省 = 全部失败项；单下标 = 单个子任务 */
  const handleRetryFailed = async (task: Task, indexes?: number[]) => {
    const key = indexes ? `${task.id}:${indexes.join(',')}` : `${task.id}:all`;
    if (retryingKey) return;
    setRetryingKey(key);
    try {
      const result = await retryTaskFailed(task.id, indexes);
      const target = indexes && indexes.length === 1
        ? `子任务 ${indexes[0] + 1}`
        : `${result.resetCount} 个失败子任务`;
      alert(`${target}已加入重试队列，已完成的结果保持不变。`);
    } catch (err: any) {
      alert(err?.message || err?.toString() || '重试失败');
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

  return (
    <div className="page">
      <div className="page-header">
        <h2>任务队列</h2>
        <p>统一查看 Agent 和手动创建的图片任务、执行状态、批量子任务和最终提示词。</p>
      </div>

      {sorted.length === 0 ? (
        <div className="empty-state">
          <p>暂无任务</p>
          <p className="empty-hint">创建文生图、图生图、透明背景或批量任务后会显示在这里。</p>
        </div>
      ) : (
        <div className="task-list">
          {sorted.map(task => {
            const partial = isPartialSuccess(task);
            const statusMeta = partial
              ? { label: '部分完成', cls: 'status-failed' }
              : (STATUS_MAP[task.status] || STATUS_MAP.pending);
            const done = task.success_count + task.failed_count;
            const pct = task.count > 0 ? Math.round((done / task.count) * 100) : 0;
            const isActive = task.status === 'pending' || task.status === 'running';
            const isFinished = task.status === 'completed' || task.status === 'failed';
            const imageCount = task.sub_tasks.filter(s => s.image_id).length;
            const hasPromptDiff = !!task.final_prompt && task.final_prompt !== task.user_prompt_raw;
            const labels = task.sub_tasks.map(item => item.label).filter(Boolean) as string[];
            const subTaskErrors = task.sub_tasks.filter(subTask => subTask.error);
            const optimized = promptOptimizationState(task).applied;

            return (
              <div
                key={task.id}
                className={`task-card${focusTaskId === task.id ? ' focused' : ''}`}
                data-task-id={task.id}
              >
                <div className="task-card-header">
                  <div>
                    <span className={`status-badge ${statusMeta.cls}`}>{statusMeta.label}</span>
                    <span className="type-badge edit-badge">{getTaskTypeLabel(task)}</span>
                    <span className="type-badge">{getSourceLabel(task)}</span>
                    <span className="type-badge">{executionModeLabel(task)}</span>
                    <span className="task-id">#{task.id.slice(0, 8)}</span>
                  </div>
                  <span className="task-time">{new Date(task.created_at).toLocaleString('zh-CN')}</span>
                </div>

                {(() => {
                  // 执行耗时：优先用 started_at（正式执行起点），旧任务回落 created_at
                  if (!isActive) return null;
                  const startIso = task.started_at || task.created_at;
                  const elapsed = Date.now() - new Date(startIso).getTime();
                  if (!Number.isFinite(elapsed) || elapsed <= 0) return null;
                  const text = formatDuration(elapsed);
                  if (!text) return null;
                  return (
                    <p className="task-dir task-queue-elapsed">
                      {task.status === 'running' ? '生成中' : '排队中'} · {text}
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
                    <span>{task.count} 张</span>
                    <span>{optimized ? '已优化提示词' : '原始提示词'}</span>
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

                  {task.status === 'running' && (
                    <div className="progress-bar-wrap">
                      <div className="progress-bar" style={{ width: `${pct}%` }} />
                      <span className="progress-text">{done} / {task.count} ({pct}%)</span>
                    </div>
                  )}

                  <div className="task-stats">
                    <span className="stat-ok">成功: {task.success_count}</span>
                    <span className="stat-fail">失败: {task.failed_count}</span>
                    <span>结果图: {imageCount}</span>
                  </div>

                  {task.source_images.length > 0 && (
                    <p className="task-dir">源图数量: {task.source_images.length}</p>
                  )}
                  {task.output_dir && (
                    <p className="task-dir">输出目录: {task.output_dir}</p>
                  )}
                  <p className="task-dir">执行接口: {getApiEndpoint(task)}</p>

                  {subTaskErrors.length > 0 && (
                    <div className="task-errors">
                      {subTaskErrors.map(subTask => {
                        const classified = classifySubTaskError(subTask.error);
                        const detailKey = `${task.id}-${subTask.index}`;
                        const detailOpen = expandedDetails.has(detailKey);
                        const attempts = subTask.attempt_errors ?? [];
                        return (
                          <div key={detailKey} className="task-subtask-error">
                            <p className="task-error">
                              子任务 {subTask.index + 1}{subTask.label ? ` (${subTask.label})` : ''} · {classified.title}
                            </p>
                            <p className="task-error-hint">{classified.hint}</p>
                            <div className="task-subtask-error-actions">
                              {task.status === 'failed' && (
                                <button
                                  className="subtask-retry-btn"
                                  disabled={retryingKey !== null}
                                  onClick={() => void handleRetryFailed(task, [subTask.index])}
                                >
                                  {retryingKey === `${task.id}:${subTask.index}` ? '提交中…' : '重新生成'}
                                </button>
                              )}
                              <button className="subtask-detail-btn" onClick={() => toggleDetail(detailKey)}>
                                {detailOpen ? '收起详情' : '查看详情'}
                              </button>
                            </div>
                            {detailOpen && (
                              <div className="task-error-detail">
                                <p>{subTask.error}</p>
                                {attempts.length > 1 && (
                                  <p className="task-error-attempts">
                                    历史尝试（{attempts.length} 次）：
                                    {attempts.map((err, i) => `第${i + 1}次 ${classifySubTaskError(err).title}`).join('；')}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {(task.status === 'failed' || task.status === 'cancelled') && task.sub_tasks.length > 0 && (
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

                  {task.status === 'completed' && task.sub_tasks.some(st => (st.retry_count ?? 0) > 0) && (
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
                  {task.status === 'failed' && task.failed_count > 0 && (
                    <button
                      className="retry-btn"
                      disabled={retryingKey !== null}
                      onClick={() => void handleRetryFailed(task)}
                    >
                      {retryingKey === `${task.id}:all` ? '提交中…' : `重试全部失败项（${task.failed_count}）`}
                    </button>
                  )}
                  {task.status === 'failed' && (
                    <button className="edit-resend-btn" onClick={() => handleRetry(task.id)}>
                      整批重新提交
                    </button>
                  )}
                  {isFinished && (
                    <button className="edit-resend-btn" onClick={() => setEditingTask(task)}>
                      编辑重发
                    </button>
                  )}
                  {!isActive && (
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
