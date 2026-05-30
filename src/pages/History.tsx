import { useEffect, useState } from 'react';
import { useTaskStore } from '../store/useTaskStore';
import { useImageStore } from '../store/useImageStore';
import { api } from '../services/api';
import type { Task } from '../types';
import './History.css';
import './ImageEdit.css';

const STATUS_LABELS: Record<string, string> = {
  pending: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
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

export default function History() {
  const { tasks, loadTasks } = useTaskStore();
  const { images, loadImages } = useImageStore();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [sourceUrls, setSourceUrls] = useState<Record<string, string>>({});
  const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(new Set());

  useEffect(() => {
    void loadTasks();
    void loadImages();
  }, [loadTasks, loadImages]);

  const selectedTask = tasks.find(task => task.id === selectedTaskId);
  const taskImages = selectedTaskId ? images.filter(img => img.task_id === selectedTaskId) : [];

  const historyTasks = tasks
    .filter(task => ['completed', 'failed', 'running', 'pending', 'cancelled'].includes(task.status))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const taskIds = new Set(tasks.map(task => task.id));
  const chatImages = images
    .filter(img => !taskIds.has(img.task_id))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  useEffect(() => {
    if (!selectedTaskId || taskImages.length === 0) return;
    let cancelled = false;
    const load = async () => {
      const urls: Record<string, string> = {};
      const batchSize = 6;
      for (let i = 0; i < taskImages.length; i += batchSize) {
        if (cancelled) return;
        const batch = taskImages.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(img => img.missing ? Promise.resolve('') : api.readThumbnail(img.local_path).catch(() => '')));
        batch.forEach((img, index) => {
          if (results[index]) urls[img.id] = results[index];
        });
      }
      if (!cancelled) setImageUrls(prev => ({ ...prev, ...urls }));
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [selectedTaskId, taskImages]);

  useEffect(() => {
    if (chatImages.length === 0) return;
    let cancelled = false;
    const load = async () => {
      const urls: Record<string, string> = {};
      const batchSize = 6;
      for (let i = 0; i < chatImages.length; i += batchSize) {
        if (cancelled) return;
        const batch = chatImages.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(img => img.missing ? Promise.resolve('') : api.readThumbnail(img.local_path).catch(() => '')));
        batch.forEach((img, index) => {
          if (results[index]) urls[img.id] = results[index];
        });
      }
      if (!cancelled) setImageUrls(prev => ({ ...prev, ...urls }));
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [chatImages]);

  useEffect(() => {
    const loadSourceUrls = async () => {
      if (!selectedTask || selectedTask.source_images.length === 0) {
        setSourceUrls({});
        return;
      }
      const urls: Record<string, string> = {};
      for (const path of selectedTask.source_images) {
        try {
          urls[path] = await api.readThumbnail(path);
        } catch {
          urls[path] = '';
        }
      }
      setSourceUrls(urls);
    };
    void loadSourceUrls();
  }, [selectedTask]);

  const togglePrompt = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setExpandedPrompts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>历史记录</h2>
        <p>查看任务来源、源图、批量子任务标签、最终执行提示词和结果图片。</p>
      </div>

      <div className="history-layout">
        <div className="history-list">
          {historyTasks.length === 0 ? (
            <div className="empty-state">
              <p>暂无历史记录</p>
            </div>
          ) : (
            historyTasks.map(task => (
              <div
                key={task.id}
                className={`history-item ${selectedTaskId === task.id ? 'active' : ''}`}
                onClick={() => setSelectedTaskId(task.id)}
              >
                <p
                  className={`history-prompt ${expandedPrompts.has(task.id) ? 'expanded' : ''}`}
                  title={task.user_prompt_raw || task.prompt}
                  onClick={(e) => togglePrompt(e, task.id)}
                >
                  {task.user_prompt_raw || task.prompt}
                </p>
                <div className="history-meta">
                  <span>{getTaskTypeLabel(task)}</span>
                  <span>{getSourceLabel(task)}</span>
                  <span>{getExecutionLabel(task)}</span>
                  <span>{STATUS_LABELS[task.status] || task.status}</span>
                  <span>{task.size}</span>
                  <span>{task.count} 张</span>
                  <span className="success">成功 {task.success_count}</span>
                  {task.failed_count > 0 && <span className="fail">失败 {task.failed_count}</span>}
                </div>
                <p className="history-time">{new Date(task.created_at).toLocaleString('zh-CN')}</p>
              </div>
            ))
          )}
        </div>

        {selectedTask && (
          <div className="history-detail">
            <h3>任务详情</h3>
            <div className="detail-params">
              <div className="detail-row"><span>类型</span><span>{getTaskTypeLabel(selectedTask)}</span></div>
              <div className="detail-row"><span>来源</span><span>{getSourceLabel(selectedTask)}</span></div>
              <div className="detail-row"><span>状态</span><span>{STATUS_LABELS[selectedTask.status] || selectedTask.status}</span></div>
              <div className="detail-row"><span>执行模式</span><span>{getExecutionLabel(selectedTask)}</span></div>
              <div className="detail-row"><span>原始需求</span><span className="detail-prompt">{selectedTask.user_prompt_raw || selectedTask.prompt}</span></div>
              <div className="detail-row"><span>最终提示词</span><span className="detail-prompt">{selectedTask.final_prompt || selectedTask.prompt}</span></div>
              {selectedTask.final_negative_prompt && (
                <div className="detail-row"><span>负面提示词</span><span className="detail-prompt">{selectedTask.final_negative_prompt}</span></div>
              )}
              {selectedTask.task_plan_summary && (
                <div className="detail-row"><span>任务计划</span><span className="detail-prompt">{selectedTask.task_plan_summary}</span></div>
              )}
              {selectedTask.sub_tasks.some(item => item.label) && (
                <div className="detail-row">
                  <span>子任务标签</span>
                  <span className="detail-prompt">{selectedTask.sub_tasks.map(item => item.label).filter(Boolean).join('、')}</span>
                </div>
              )}
              <div className="detail-row"><span>提示词优化</span><span>{selectedTask.prompt_optimized ? '已优化' : '未优化'}</span></div>
              <div className="detail-row"><span>执行接口</span><span className="path">{getApiEndpoint(selectedTask)}</span></div>
              <div className="detail-row"><span>尺寸</span><span>{selectedTask.size}</span></div>
              <div className="detail-row"><span>质量</span><span>{selectedTask.quality}</span></div>
              <div className="detail-row"><span>格式</span><span>{selectedTask.output_format.toUpperCase()}</span></div>
              <div className="detail-row"><span>数量</span><span>{selectedTask.count}</span></div>
              <div className="detail-row"><span>成功</span><span className="ok">{selectedTask.success_count}</span></div>
              <div className="detail-row"><span>失败</span><span className="fail">{selectedTask.failed_count}</span></div>
              <div className="detail-row"><span>输出目录</span><span className="path">{selectedTask.output_dir}</span></div>
            </div>

            {selectedTask.sub_tasks.length > 0 && (
              <>
                <h4>子任务状态</h4>
                <div className="task-errors">
                  {selectedTask.sub_tasks.map(subTask => (
                    <p key={`${selectedTask.id}-sub-${subTask.index}`} className="task-error">
                      子任务 {subTask.index + 1}{subTask.label ? ` (${subTask.label})` : ''}: {STATUS_LABELS[subTask.status] || subTask.status}
                      {subTask.error ? ` - ${subTask.error}` : ''}
                    </p>
                  ))}
                </div>
              </>
            )}

            {selectedTask.source_images.length > 0 && (
              <>
                <h4>源图 ({selectedTask.source_images.length})</h4>
                <div className="history-images">
                  {selectedTask.source_images.map((path, index) => (
                    <div key={path} className="history-img-item" onClick={() => api.openFile(path)}>
                      {sourceUrls[path] ? (
                        <img src={sourceUrls[path]} alt={`源图 ${index + 1}`} />
                      ) : (
                        <div className="gallery-loading">文件缺失</div>
                      )}
                      <span>源图 {index + 1}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <h4>结果图片 ({taskImages.length})</h4>
            {taskImages.length === 0 ? (
              <p className="no-images">暂无结果图片</p>
            ) : (
              <div className="history-images">
                {taskImages.map(img => (
                  <div key={img.id} className="history-img-item" onClick={() => !img.missing && api.openFile(img.local_path)}>
                    {imageUrls[img.id] ? (
                      <img src={imageUrls[img.id]} alt={img.file_name} />
                    ) : (
                      <div className="gallery-loading">{img.missing ? '文件缺失' : '加载中...'}</div>
                    )}
                    <span>{img.file_name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {chatImages.length > 0 && (
        <div className="history-chat-section">
          <h3 className="history-chat-title">对话历史图片 ({chatImages.length})</h3>
          <div className="history-images">
            {chatImages.map(img => (
              <div key={img.id} className="history-img-item" onClick={() => !img.missing && api.openFile(img.local_path)}>
                {imageUrls[img.id] ? (
                  <img src={imageUrls[img.id]} alt={img.file_name} />
                ) : (
                  <div className="gallery-loading">{img.missing ? '文件缺失' : '加载中...'}</div>
                )}
                <span>{img.file_name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
