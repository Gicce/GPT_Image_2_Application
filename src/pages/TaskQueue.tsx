import { useEffect, useState } from 'react';
import { useTaskStore } from '../store/useTaskStore';
import type { Task } from '../types';
import { api } from '../services/api';
import EditTaskModal from '../components/EditTaskModal';
import DeleteTaskDialog from '../components/DeleteTaskDialog';
import './TaskQueue.css';
import './ImageEdit.css';

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  pending: { label: '排队中', cls: 'status-pending' },
  running: { label: '执行中', cls: 'status-running' },
  completed: { label: '已完成', cls: 'status-completed' },
  failed: { label: '失败', cls: 'status-failed' },
  cancelled: { label: '已取消', cls: 'status-cancelled' },
};

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

function getExecutionLabel(task: Task): string {
  return task.execution_mode === 'batch' ? `批量 / ${task.batch_strategy || 'repeat_same'}` : '单任务';
}

function getSubTaskStatusLabel(status: string): string {
  const meta = STATUS_MAP[status];
  return meta?.label || status;
}

export default function TaskQueue() {
  const { tasks, loadTasks, cancelTask, deleteTask } = useTaskStore();
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [deletingTask, setDeletingTask] = useState<Task | null>(null);
  const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(new Set());

  useEffect(() => {
    void loadTasks();
    let unlistener: (() => void) | null = null;
    api.onTaskUpdated(async () => {
      await loadTasks();
    }).then(fn => {
      unlistener = fn;
    });
    return () => {
      if (unlistener) unlistener();
    };
  }, [loadTasks]);

  const togglePrompt = (id: string) => {
    setExpandedPrompts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRetry = async (taskId: string) => {
    try {
      await api.retryTask(taskId);
      await loadTasks();
      alert('任务已重新提交，请查看队列进度。');
    } catch (err: any) {
      alert(err?.toString() || '重新提交失败');
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
            const statusMeta = STATUS_MAP[task.status] || STATUS_MAP.pending;
            const done = task.success_count + task.failed_count;
            const pct = task.count > 0 ? Math.round((done / task.count) * 100) : 0;
            const isActive = task.status === 'pending' || task.status === 'running';
            const isFinished = task.status === 'completed' || task.status === 'failed';
            const imageCount = task.sub_tasks.filter(s => s.image_id).length;
            const hasPromptDiff = !!task.final_prompt && task.final_prompt !== task.user_prompt_raw;
            const labels = task.sub_tasks.map(item => item.label).filter(Boolean) as string[];
            const subTaskErrors = task.sub_tasks.filter(subTask => subTask.error);

            return (
              <div key={task.id} className="task-card">
                <div className="task-card-header">
                  <div>
                    <span className={`status-badge ${statusMeta.cls}`}>{statusMeta.label}</span>
                    <span className="type-badge edit-badge">{getTaskTypeLabel(task)}</span>
                    <span className="type-badge">{getSourceLabel(task)}</span>
                    <span className="type-badge">{getExecutionLabel(task)}</span>
                    <span className="task-id">#{task.id.slice(0, 8)}</span>
                  </div>
                  <span className="task-time">{new Date(task.created_at).toLocaleString('zh-CN')}</span>
                </div>

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
                    <span>{task.prompt_optimized ? '已优化提示词' : '原始提示词'}</span>
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
                      {subTaskErrors.map(subTask => (
                        <p key={`${task.id}-${subTask.index}`} className="task-error">
                          子任务 {subTask.index + 1}{subTask.label ? ` (${subTask.label})` : ''}: {subTask.error}
                        </p>
                      ))}
                    </div>
                  )}

                  {(task.status === 'failed' || task.status === 'cancelled') && task.sub_tasks.length > 0 && (
                    <div className="task-errors">
                      {task.sub_tasks.map(subTask => (
                        <p key={`${task.id}-status-${subTask.index}`} className="task-error">
                          子任务 {subTask.index + 1}{subTask.label ? ` (${subTask.label})` : ''}: {getSubTaskStatusLabel(subTask.status)}
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
                  {task.status === 'failed' && (
                    <button className="retry-btn" onClick={() => handleRetry(task.id)}>
                      重新提交
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
