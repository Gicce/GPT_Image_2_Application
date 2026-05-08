import { useEffect, useState } from 'react';
import { useTaskStore } from '../store/useTaskStore';
import { api } from '../services/api';
import type { Task } from '../types';
import EditTaskModal from '../components/EditTaskModal';
import DeleteTaskDialog from '../components/DeleteTaskDialog';
import './TaskQueue.css';
import './ImageEdit.css';

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  pending: { label: '排队中', cls: 'status-pending' },
  running: { label: '生成中', cls: 'status-running' },
  completed: { label: '已完成', cls: 'status-completed' },
  failed: { label: '失败', cls: 'status-failed' },
  cancelled: { label: '已取消', cls: 'status-cancelled' },
};

export default function TaskQueue() {
  const { tasks, loadTasks, cancelTask, deleteTask } = useTaskStore();
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [deletingTask, setDeletingTask] = useState<Task | null>(null);

  useEffect(() => {
    loadTasks();
    let unlistener: (() => void) | null = null;
    api.onTaskUpdated(async () => {
      await loadTasks();
    }).then(fn => { unlistener = fn; });
    return () => { if (unlistener) unlistener(); };
  }, []);

  const handleRetry = async (taskId: string) => {
    try {
      await api.retryTask(taskId);
      alert('任务已重新提交，请查看队列进度。');
      await loadTasks();
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
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return (
    <div className="page">
      <div className="page-header">
        <h2>任务队列</h2>
        <p>查看和管理所有批量生成任务</p>
      </div>

      {sorted.length === 0 ? (
        <div className="empty-state">
          <p>暂无任务</p>
          <p className="empty-hint">前往「文生图」开始生成图片</p>
        </div>
      ) : (
        <div className="task-list">
          {sorted.map(task => {
            const st = STATUS_MAP[task.status] || STATUS_MAP.pending;
            const done = task.success_count + task.failed_count;
            const pct = task.count > 0 ? Math.round((done / task.count) * 100) : 0;
            const isActive = task.status === 'pending' || task.status === 'running';
            const isFinished = task.status === 'completed' || task.status === 'failed';
            const imageCount = task.sub_tasks.filter(s => s.image_id).length;

            return (
              <div key={task.id} className="task-card">
                <div className="task-card-header">
                  <div>
                    <span className={`status-badge ${st.cls}`}>{st.label}</span>
                    {task.task_type === 'edit' && <span className="type-badge edit-badge">图生图</span>}
                    <span className="task-id">#{task.id.slice(0, 8)}</span>
                  </div>
                  <span className="task-time">
                    {new Date(task.created_at).toLocaleString('zh-CN')}
                  </span>
                </div>
                <div className="task-card-body">
                  <p className="task-prompt">{task.prompt}</p>
                  <div className="task-meta">
                    <span>{task.size}</span>
                    <span>{task.quality}</span>
                    <span>{task.output_format.toUpperCase()}</span>
                    <span>{task.count} 张</span>
                  </div>

                  {task.status === 'running' && (
                    <div className="progress-bar-wrap">
                      <div className="progress-bar" style={{ width: `${pct}%` }} />
                      <span className="progress-text">{done} / {task.count} ({pct}%)</span>
                    </div>
                  )}

                  <div className="task-stats">
                    <span className="stat-ok">成功: {task.success_count}</span>
                    <span className="stat-fail">失败: {task.failed_count}</span>
                  </div>

                  {task.output_dir && (
                    <p className="task-dir">输出: {task.output_dir}</p>
                  )}

                  {task.sub_tasks.some(s => s.error) && (
                    <div className="task-errors">
                      {task.sub_tasks
                        .filter(s => s.error)
                        .map((s, i) => (
                          <p key={i} className="task-error">
                            子任务 {s.index + 1}: {s.error}
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
          taskPrompt={deletingTask.prompt}
          imageCount={deletingTask.sub_tasks.filter(s => s.image_id).length}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeletingTask(null)}
        />
      )}
    </div>
  );
}
