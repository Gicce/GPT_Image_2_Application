import { useEffect, useState } from 'react';
import { useTaskStore } from '../store/useTaskStore';
import { useImageStore } from '../store/useImageStore';
import { api } from '../services/api';
import './History.css';
import './ImageEdit.css';

export default function History() {
  const { tasks, loadTasks } = useTaskStore();
  const { images, loadImages } = useImageStore();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [sourceUrls, setSourceUrls] = useState<Record<string, string>>({});
  const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(new Set());

  const togglePrompt = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setExpandedPrompts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  useEffect(() => {
    loadTasks();
    loadImages();
  }, []);

  const selectedTask = tasks.find(t => t.id === selectedTaskId);
  const taskImages = selectedTaskId
    ? images.filter(img => img.task_id === selectedTaskId)
    : [];

  useEffect(() => {
    if (!selectedTaskId || taskImages.length === 0) return;
    let cancelled = false;
    const load = async () => {
      const urls: Record<string, string> = {};
      const BATCH = 6;
      for (let i = 0; i < taskImages.length; i += BATCH) {
        if (cancelled) return;
        const batch = taskImages.slice(i, i + BATCH);
        const results = await Promise.all(
          batch.map(img => api.readThumbnail(img.local_path).catch(() => ''))
        );
        batch.forEach((img, j) => {
          if (results[j]) urls[img.id] = results[j];
        });
      }
      if (!cancelled) setImageUrls(prev => ({ ...prev, ...urls }));
    };
    load();
    return () => { cancelled = true; };
  }, [selectedTaskId]);

  useEffect(() => {
    const loadSourceUrls = async () => {
      if (!selectedTask || selectedTask.task_type !== 'edit' || selectedTask.source_images.length === 0) {
        setSourceUrls({});
        return;
      }
      const urls: Record<string, string> = {};
      for (const path of selectedTask.source_images) {
        try {
          urls[path] = await api.readThumbnail(path);
        } catch {}
      }
      setSourceUrls(urls);
    };
    loadSourceUrls();
  }, [selectedTaskId]);

  const historyTasks = tasks
    .filter(t => t.status === 'completed' || t.status === 'failed')
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return (
    <div className="page">
      <div className="page-header">
        <h2>历史记录</h2>
        <p>查看所有已完成的批量生成任务</p>
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
                  title={task.prompt}
                  onClick={(e) => togglePrompt(e, task.id)}
                >{task.prompt}</p>
                <div className="history-meta">
                  {task.task_type === 'edit' && <span className="type-badge edit-badge">图生图</span>}
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
              <div className="detail-row"><span>类型</span><span>{selectedTask.task_type === 'edit' ? '图生图' : '文生图'}</span></div>
              <div className="detail-row"><span>提示词</span><span className="detail-prompt">{selectedTask.prompt}</span></div>
              {selectedTask.negative_prompt && (
                <div className="detail-row"><span>负面提示词</span><span className="detail-prompt">{selectedTask.negative_prompt}</span></div>
              )}
              <div className="detail-row"><span>尺寸</span><span>{selectedTask.size}</span></div>
              <div className="detail-row"><span>质量</span><span>{selectedTask.quality}</span></div>
              <div className="detail-row"><span>格式</span><span>{selectedTask.output_format.toUpperCase()}</span></div>
              <div className="detail-row"><span>数量</span><span>{selectedTask.count}</span></div>
              <div className="detail-row"><span>成功</span><span className="ok">{selectedTask.success_count}</span></div>
              <div className="detail-row"><span>失败</span><span className="fail">{selectedTask.failed_count}</span></div>
              <div className="detail-row"><span>输出目录</span><span className="path">{selectedTask.output_dir}</span></div>
            </div>

            {selectedTask.task_type === 'edit' && selectedTask.source_images.length > 0 && (
              <>
                <h4>原图 ({selectedTask.source_images.length})</h4>
                <div className="history-images">
                  {selectedTask.source_images.map((path, i) => (
                    <div
                      key={path}
                      className="history-img-item"
                      onClick={() => api.openFile(path)}
                    >
                      {sourceUrls[path] ? (
                        <img src={sourceUrls[path]} alt={`原图 ${i + 1}`} />
                      ) : (
                        <div className="gallery-loading">加载中...</div>
                      )}
                      <span>原图 {i + 1}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <h4>生成图片 ({taskImages.length})</h4>
            {taskImages.length === 0 ? (
              <p className="no-images">暂无图片</p>
            ) : (
              <div className="history-images">
                {taskImages.map(img => (
                  <div
                    key={img.id}
                    className="history-img-item"
                    onClick={() => api.openFile(img.local_path)}
                  >
                    {imageUrls[img.id] ? (
                      <img src={imageUrls[img.id]} alt={img.file_name} />
                    ) : (
                      <div className="gallery-loading">加载中...</div>
                    )}
                    <span>{img.file_name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
