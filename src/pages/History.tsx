import { useEffect, useRef, useState } from 'react';
import { useTaskStore } from '../store/useTaskStore';
import { useImageStore } from '../store/useImageStore';
import { api } from '../services/api';
import type { ImageRecord, SubTask, Task } from '../types';
import type { GenerationPlan } from '../utils/batchPlans';
import { batchStrategyLabel, executionModeLabel, formatTaskDateTime, promptOptimizationState } from '../utils/taskDisplay';
import {
  filterTasksByCategory,
  getTaskCategoryCounts,
  getTaskCategoryLabel,
  type TaskCategoryFilter,
} from '../utils/taskCategory';
import { copyText } from '../utils/clipboard';
import { toastError, toastSuccess } from '../components/Toast';
import PromptTextBlock from '../components/PromptTextBlock';
import BatchPlanDetailDrawer from '../components/BatchPlanDetailDrawer';
import TaskFilterBar from '../components/TaskFilterBar';
import './History.css';
import './ImageEdit.css';
import '../components/BatchPlans.css';

const STATUS_LABELS: Record<string, string> = {
  pending: '等待中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const STATUS_BADGE_CLS: Record<string, string> = {
  pending: 'pending',
  running: 'loading',
  completed: 'success',
  failed: 'error',
  cancelled: 'pending',
};

const SUB_STATUS_META: Record<SubTask['status'], { label: string; cls: string }> = {
  pending: { label: '等待中', cls: 'pending' },
  running: { label: '● 执行中', cls: 'loading' },
  completed: { label: '✓ 已完成', cls: 'success' },
  failed: { label: '✕ 失败', cls: 'error' },
  cancelled: { label: '已取消', cls: 'pending' },
};

const IMAGE_EXECUTION_MODEL = 'GPT Image 2';

function getSourceLabel(task: Task): string {
  if (task.task_source === 'cy-video-studio') return 'CY Video Studio · 视频复刻';
  return task.task_source === 'agent' ? 'AI Agent' : '手动';
}

function getApiEndpoint(task: Task): string {
  if (task.task_type === 'vision_understanding') return 'BYOK 视觉模型（用户自配，非服务端计费）';
  if (task.task_type === 'edit') return 'POST https://www.packyapi.com/v1/images/edits';
  if (task.task_type === 'remove_background') return 'POST https://api.remove.bg/v1.0/removebg';
  return 'POST https://www.packyapi.com/v1/images/generations';
}

/** 与 Rust compose_model_instruction 一致：gpt-image-2 无独立负面参数，适配层拼接后发送 */
function composeExecutedPrompt(positive: string, negative: string): string {
  const neg = negative.trim();
  if (!neg) return positive.trim();
  return `${positive.trim()}\n\n画面中严格避免出现以下内容：${neg}`;
}

/** label「方案 3 · 寒霜水刃 · 战场冲锋」→「寒霜水刃 · 战场冲锋」（仅旧任务 fallback） */
function planTitleFromLabel(label: string | undefined, index: number): string {
  const raw = (label || '').trim();
  if (!raw) return `方案 ${index + 1}`;
  const match = raw.match(/^方案\s*\d+\s*[·・:：]\s*(.+)$/);
  return match ? match[1].trim() : raw;
}

/** 旧任务没有 plan_summary 时的有限长度展示（仅历史旧数据 fallback，禁止用于新任务） */
function legacySummary(prompt: string): string {
  const text = prompt.trim().replace(/\s+/g, ' ');
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

interface HistoryPlanItem {
  index: number;
  title: string;
  summary: string;
  tags: string[];
  description: string;
  positivePrompt: string;
  negativePrompt: string;
  status: SubTask['status'];
  error?: string | null;
  imageId?: string;
  /** 新版方案任务（有正式 AI plan metadata） */
  hasPlanMeta: boolean;
}

function buildPlanItems(task: Task): HistoryPlanItem[] {
  return task.sub_tasks.map((sub, index) => {
    const item = task.batch_items?.[index];
    const positive = item?.prompt_override?.trim()
      || (task.final_prompt || task.prompt).trim();
    const negative = item?.negative_override?.trim()
      || task.final_negative_prompt?.trim()
      || task.negative_prompt.trim();
    return {
      index,
      title: item?.plan_title?.trim() || planTitleFromLabel(item?.label ?? sub.label, index),
      summary: item?.plan_summary?.trim() || legacySummary(positive),
      tags: item?.plan_tags || [],
      description: item?.plan_description?.trim() || '',
      positivePrompt: positive,
      negativePrompt: negative,
      status: sub.status,
      error: sub.error,
      imageId: sub.image_id,
      hasPlanMeta: !!(item?.plan_title?.trim() || item?.plan_summary?.trim()),
    };
  });
}

function planToGenerationPlan(item: HistoryPlanItem, task: Task): GenerationPlan {
  const optState = promptOptimizationState(task);
  return {
    id: task.batch_items?.[item.index]?.id || `sub_${item.index}`,
    title: item.title,
    summary: item.summary,
    tags: item.tags,
    description: item.description,
    positivePrompt: item.positivePrompt,
    negativePrompt: item.negativePrompt,
    optimizationStatus: 'success',
    optimizationError: '',
    isManuallyEdited: false,
    source: 'ai_planned',
    optimizerProviderName: optState.snapshot?.provider_name || '',
    optimizerModelName: optState.snapshot?.model_name || '',
  };
}

async function copyField(text: string, label: string) {
  if (!text.trim()) return;
  if (await copyText(text)) toastSuccess(`${label}已复制`);
  else toastError('复制失败，请重试');
}

export default function History() {
  const { tasks, loadTasks } = useTaskStore();
  const { images, loadImages } = useImageStore();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [sourceUrls, setSourceUrls] = useState<Record<string, string>>({});
  const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(new Set());
  const [planDrawerIndex, setPlanDrawerIndex] = useState<number | null>(null);
  const [activeCategory, setActiveCategory] = useState<TaskCategoryFilter>('all');
  // 右侧详情独立滚动容器：切任务时回到顶部
  const detailScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void loadTasks();
    void loadImages();
  }, [loadTasks, loadImages]);

  const selectedTask = tasks.find(task => task.id === selectedTaskId);
  const taskImages = selectedTaskId ? images.filter(img => img.task_id === selectedTaskId) : [];

  const historyTasks = tasks
    .filter(task => ['completed', 'failed', 'running', 'pending', 'cancelled'].includes(task.status))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const categoryCounts = getTaskCategoryCounts(historyTasks);
  const visibleHistoryTasks = filterTasksByCategory(historyTasks, activeCategory);

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

  // 切换任务：关闭旧任务的方案抽屉 + 详情滚动回顶部（不继承上一个任务的滚动位置）
  useEffect(() => {
    setPlanDrawerIndex(null);
    if (detailScrollRef.current) detailScrollRef.current.scrollTop = 0;
  }, [selectedTaskId]);

  const togglePrompt = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setExpandedPrompts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const isPlanBatch = !!selectedTask
    && selectedTask.execution_mode === 'batch'
    && (selectedTask.batch_items?.length ?? 0) > 0;
  const planItems = isPlanBatch && selectedTask ? buildPlanItems(selectedTask) : [];
  const drawerPlan = planDrawerIndex !== null ? planItems[planDrawerIndex] : undefined;

  return (
    <div className="page history-page">
      <div className="page-header">
        <h2>历史记录</h2>
        <p>查看任务概览、批量方案、执行提示词快照和结果图片。</p>
      </div>

      {historyTasks.length > 0 && (
        <TaskFilterBar
          typeCounts={categoryCounts}
          activeType={activeCategory}
          onTypeChange={setActiveCategory}
        />
      )}

      <div className="history-layout">
        <div className="history-list">
          {historyTasks.length === 0 ? (
            <div className="empty-state">
              <p>暂无历史记录</p>
            </div>
          ) : visibleHistoryTasks.length === 0 ? (
            <div className="history-filter-empty">当前筛选条件下没有任务</div>
          ) : (
            visibleHistoryTasks.map(task => (
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
                  <span>{getTaskCategoryLabel(task)}</span>
                  <span>{getSourceLabel(task)}</span>
                  <span>{executionModeLabel(task)}</span>
                  {task.source_task_kind === 'vision_understanding' && (
                    <span>来源：视觉理解任务{task.source_task_id ? ` #${task.source_task_id.slice(0, 8)}` : ''}</span>
                  )}
                  <span>{STATUS_LABELS[task.status] || task.status}</span>
                  <span>{task.size}</span>
                  {task.task_type !== 'vision_understanding' && <span>{task.count} 张</span>}
                  <span className="success">成功 {task.success_count}</span>
                  {task.failed_count > 0 && <span className="fail">失败 {task.failed_count}</span>}
                </div>
                <p className="history-time">{new Date(task.created_at).toLocaleString('zh-CN')}</p>
              </div>
            ))
          )}
        </div>

        {selectedTask ? (
          <div className="history-detail" ref={detailScrollRef}>
            <HistoryTaskDetail
              task={selectedTask}
              taskImages={taskImages}
              imageUrls={imageUrls}
              sourceUrls={sourceUrls}
              planItems={planItems}
              isPlanBatch={isPlanBatch}
              onOpenPlanDrawer={setPlanDrawerIndex}
            />
          </div>
        ) : (
          <div className="history-detail history-detail-empty">
            <div className="empty-state"><p>选择左侧任务查看详情</p></div>
          </div>
        )}
      </div>

      {drawerPlan && selectedTask && (
        <BatchPlanDetailDrawer
          readOnly
          plan={planToGenerationPlan(drawerPlan, selectedTask)}
          index={drawerPlan.index}
          total={planItems.length}
          optimizerConfigured={false}
          optimizerModelLabel={null}
          statusOverride={SUB_STATUS_META[drawerPlan.status]}
          onClose={() => setPlanDrawerIndex(null)}
          onSave={() => undefined}
          onReoptimize={() => undefined}
          onDelete={() => undefined}
          onNavigate={(delta) => {
            setPlanDrawerIndex(current => {
              if (current === null) return current;
              const next = current + delta;
              if (next < 0 || next >= planItems.length) return current;
              return next;
            });
          }}
          readOnlyExtras={
            <HistoryPlanDrawerExtras
              item={drawerPlan}
              task={selectedTask}
              image={drawerPlan.imageId ? images.find(img => img.id === drawerPlan.imageId) : undefined}
              thumbUrl={drawerPlan.imageId ? imageUrls[drawerPlan.imageId] : undefined}
            />
          }
        />
      )}
    </div>
  );
}

/** 历史方案抽屉附加区：实际执行指令（快照）+ 时间 + 结果图 */
function HistoryPlanDrawerExtras(props: {
  item: HistoryPlanItem;
  task: Task;
  image?: ImageRecord;
  thumbUrl?: string;
}) {
  const { item, task, image } = props;
  return (
    <>
      <div className="bp-drawer-divider" />
      <div className="form-group">
        <div className="bp-drawer-field-head">
          <label>实际执行提示词 <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>（发送给模型的真实快照，含负面拼接）</span></label>
        </div>
        <p className="bp-readonly-text bp-readonly-prompt bp-readonly-negative">
          {composeExecutedPrompt(item.positivePrompt, item.negativePrompt)}
        </p>
      </div>
      {item.error && (
        <div className="form-group">
          <div className="bp-drawer-field-head"><label>失败原因</label></div>
          <p className="bp-readonly-text history-plan-error">{item.error}</p>
        </div>
      )}
      <div className="form-group">
        <div className="bp-drawer-field-head"><label>时间</label></div>
        <div className="history-plan-times">
          <span>任务创建：{formatTaskDateTime(task.created_at)}</span>
          {task.started_at && <span>开始执行：{formatTaskDateTime(task.started_at)}</span>}
          {task.completed_at && <span>任务完成：{formatTaskDateTime(task.completed_at)}</span>}
        </div>
      </div>
      {image && (
        <div className="form-group">
          <div className="bp-drawer-field-head"><label>生成结果</label></div>
          <div className="history-plan-result" onClick={() => !image.missing && api.openFile(image.local_path)}>
            {props.thumbUrl ? (
              <img src={props.thumbUrl} alt={image.file_name} />
            ) : (
              <div className="gallery-loading">{image.missing ? '文件缺失' : '加载中...'}</div>
            )}
            <span>{image.file_name}</span>
          </div>
        </div>
      )}
    </>
  );
}

/** 历史任务详情主体：① 任务概览 ② 生成方案（方案卡片）③ 生成结果 ④ 高级信息 */
function HistoryTaskDetail(props: {
  task: Task;
  taskImages: ImageRecord[];
  imageUrls: Record<string, string>;
  sourceUrls: Record<string, string>;
  planItems: HistoryPlanItem[];
  isPlanBatch: boolean;
  onOpenPlanDrawer: (index: number) => void;
}) {
  const { task, taskImages, imageUrls, sourceUrls, planItems, isPlanBatch } = props;
  const optState = promptOptimizationState(task);
  const total = task.count || task.sub_tasks.length || 1;
  const done = task.success_count + task.failed_count;
  const progressPercent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  const imageByPlanId = new Map<string, ImageRecord>();
  for (const item of planItems) {
    if (item.imageId) {
      const img = taskImages.find(i => i.id === item.imageId);
      if (img) imageByPlanId.set(item.imageId, img);
    }
  }
  const linkedIds = new Set(imageByPlanId.keys());
  const otherImages = taskImages.filter(img => !linkedIds.has(img.id));

  const singlePositive = (task.final_prompt || task.prompt).trim();
  const singleNegative = (task.final_negative_prompt || task.negative_prompt).trim();
  const positiveLabel = optState.applied ? 'AI 优化提示词（正向）' : '最终提示词（正向）';

  return (
    <>
      <div className="history-detail-head">
        <h3>{getTaskCategoryLabel(task)}任务详情</h3>
        <span className={`bp-status-badge ${STATUS_BADGE_CLS[task.status] || 'pending'}`}>
          {STATUS_LABELS[task.status] || task.status}
        </span>
      </div>

      {/* ① 任务概览 */}
      <section className="history-section">
        <h4 className="history-section-title">
          <span className="history-section-no">①</span>任务概览
        </h4>
        <div className="history-overview">
          <div className="history-overview-grid">
            <div className="detail-row"><span>生成方式</span><span>{getTaskCategoryLabel(task)}</span></div>
            <div className="detail-row"><span>生成模式</span><span>{executionModeLabel(task)}</span></div>
            <div className="detail-row"><span>任务来源</span><span>{getSourceLabel(task)}</span></div>
            {task.source_task_kind === 'vision_understanding' && (
              <div className="detail-row">
                <span>来源链路</span>
                <span>视觉理解任务{task.source_task_id ? ` #${task.source_task_id.slice(0, 8)}` : ''} → 图片生成任务</span>
              </div>
            )}
            {task.source_app === 'cy-video-studio' && (
              <>
                <div className="detail-row">
                  <span>来源项目</span>
                  <span>
                    CY Video Studio · 视频复刻
                    {task.source_context?.projectName ? ` · ${task.source_context.projectName}` : ''}
                  </span>
                </div>
                {task.source_context?.trackType && (
                  <div className="detail-row">
                    <span>用途</span>
                    <span>
                      {{ character: '人物参考图', scene: '场景参考图', style: '风格参考图', transition_reference: '转场参考图', first_frame: '首帧参考图' }[task.source_context.trackType] || task.source_context.trackType}
                      {task.source_context?.purpose ? ` · ${task.source_context.purpose}` : ''}
                    </span>
                  </div>
                )}
              </>
            )}
            {task.task_plan_summary && (
              <div className="detail-row"><span>任务摘要</span><span>{task.task_plan_summary}</span></div>
            )}
            {isPlanBatch && (
              <div className="detail-row"><span>方案数量</span><span>{planItems.length}</span></div>
            )}
            {!isPlanBatch && (
              <div className="detail-row"><span>图片数量</span><span>{task.count}</span></div>
            )}
            <div className="detail-row"><span>完成进度</span>
              <span className="history-progress-cell">
                <span className="history-progress-text">{done} / {total}</span>
                <span className="history-progress-bar">
                  <span className="history-progress-fill" style={{ width: `${progressPercent}%` }} />
                </span>
              </span>
            </div>
            <div className="detail-row"><span>创建时间</span><span>{formatTaskDateTime(task.created_at)}</span></div>
            {task.started_at && (
              <div className="detail-row"><span>开始时间</span><span>{formatTaskDateTime(task.started_at)}</span></div>
            )}
            {task.completed_at && (
              <div className="detail-row"><span>完成时间</span><span>{formatTaskDateTime(task.completed_at)}</span></div>
            )}
          </div>
          {(task.success_count > 0 || task.failed_count > 0) && (
            <div className="history-overview-counts">
              <span className="ok">成功 {task.success_count}</span>
              {task.failed_count > 0 && <span className="fail">失败 {task.failed_count}</span>}
            </div>
          )}
          <PromptTextBlock
            title="原始需求"
            content={task.user_prompt_raw || task.prompt}
            copyToastLabel="原始需求已复制"
            emptyHint="（未记录原始需求）"
          />
        </div>
      </section>

      {/* ② 生成方案（批量方案任务） */}
      {isPlanBatch && (
        <section className="history-section">
          <h4 className="history-section-title">
            <span className="history-section-no">②</span>生成方案
            <span className="history-section-hint">{planItems.length} 个方案 · 点击「查看详情」查看完整提示词快照</span>
          </h4>
          <div className="history-plans">
            {planItems.map(item => {
              const statusMeta = SUB_STATUS_META[item.status] || SUB_STATUS_META.pending;
              const resultImage = item.imageId ? imageByPlanId.get(item.imageId) : undefined;
              return (
                <div key={item.index} className="bp-card history-plan-card">
                  <span className="bp-card-index">{item.index + 1}</span>
                  <div className="bp-card-main">
                    <div className="bp-card-head">
                      <span className="bp-card-title" title={item.title}>{item.title}</span>
                      <span className={`bp-status-badge ${statusMeta.cls}`}>{statusMeta.label}</span>
                    </div>
                    {item.summary && (
                      <p className="bp-card-summary" title={item.summary}>{item.summary}</p>
                    )}
                    {item.error && (
                      <p className="bp-card-error" title={item.error}>{item.error}</p>
                    )}
                    {item.tags.length > 0 && (
                      <div className="bp-card-tags">
                        {item.tags.map(tag => <span className="bp-tag" key={tag}>{tag}</span>)}
                      </div>
                    )}
                    <div className="bp-card-actions">
                      {resultImage ? (
                        <span className="history-plan-result-count">结果：1 张</span>
                      ) : item.status === 'completed' ? (
                        <span className="history-plan-result-count muted">结果：0 张</span>
                      ) : (
                        <span className="history-plan-result-count muted">未生成</span>
                      )}
                      <span className="bp-more-wrap">
                        <button
                          type="button"
                          className="settings-btn settings-btn-outline settings-btn-sm"
                          onClick={() => props.onOpenPlanDrawer(item.index)}
                        >
                          查看详情
                        </button>
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 单张 / 非方案任务：提示词快照 */}
      {!isPlanBatch && (
        <section className="history-section">
          <h4 className="history-section-title">
            <span className="history-section-no">②</span>提示词快照
          </h4>
          <div className="history-prompts">
            <PromptTextBlock
              title={positiveLabel}
              content={singlePositive}
              copyToastLabel="正向提示词已复制"
              emptyHint="（无正向提示词）"
            />
            <PromptTextBlock
              title="负面提示词"
              content={singleNegative}
              copyToastLabel="负面提示词已复制"
              emptyHint="（无负面提示词）"
            />
            <PromptTextBlock
              title="实际执行提示词"
              content={composeExecutedPrompt(singlePositive, singleNegative)}
              copyToastLabel="实际执行提示词已复制"
              emptyHint="（无执行内容）"
            />
          </div>
        </section>
      )}

      {/* 旧版批量任务（repeat_same / 无 batch_items）：保留子任务执行明细 */}
      {!isPlanBatch && task.execution_mode === 'batch' && task.sub_tasks.length > 0 && (
        <section className="history-section">
          <h4 className="history-section-title">子任务执行明细（{task.sub_tasks.length}）</h4>
          <div className="history-legacy-subtasks">
            {task.sub_tasks.map(sub => {
              const meta = SUB_STATUS_META[sub.status] || SUB_STATUS_META.pending;
              return (
                <div key={sub.index} className="history-legacy-subtask">
                  <span className={`bp-status-badge ${meta.cls}`}>{meta.label}</span>
                  <span className="history-legacy-subtask-label">
                    #{sub.index + 1}{sub.label ? ` · ${sub.label}` : ''}
                  </span>
                  {sub.error && <span className="history-legacy-subtask-error" title={sub.error}>{sub.error}</span>}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 源图 */}
      {task.source_images.length > 0 && (
        <section className="history-section">
          <h4 className="history-section-title">源图 ({task.source_images.length})</h4>
          <div className="history-images">
            {task.source_images.map((path, index) => (
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
        </section>
      )}

      {/* ③ 生成结果 */}
      <section className="history-section">
        <h4 className="history-section-title">
          <span className="history-section-no">③</span>生成结果（{taskImages.length} / {total}）
        </h4>
        {taskImages.length === 0 ? (
          <p className="no-images">暂无结果图片</p>
        ) : isPlanBatch ? (
          <div className="history-results">
            {planItems.map(item => {
              const img = item.imageId ? imageByPlanId.get(item.imageId) : undefined;
              if (!img) return null;
              return (
                <div key={img.id} className="history-result-card" onClick={() => !img.missing && api.openFile(img.local_path)}>
                  <div className="history-result-thumb">
                    {imageUrls[img.id] ? (
                      <img src={imageUrls[img.id]} alt={img.file_name} />
                    ) : (
                      <div className="gallery-loading">{img.missing ? '文件缺失' : '加载中...'}</div>
                    )}
                  </div>
                  <div className="history-result-info">
                    <span className="history-result-plan">方案 {item.index + 1} · {item.title}</span>
                    <span className="history-result-time">{formatTaskDateTime(img.created_at)}</span>
                    <button
                      type="button"
                      className="settings-btn settings-btn-outline settings-btn-sm"
                      disabled={img.missing}
                      onClick={(e) => { e.stopPropagation(); api.openFile(img.local_path); }}
                    >
                      查看图片
                    </button>
                  </div>
                </div>
              );
            })}
            {otherImages.map(img => (
              <div key={img.id} className="history-result-card" onClick={() => !img.missing && api.openFile(img.local_path)}>
                <div className="history-result-thumb">
                  {imageUrls[img.id] ? (
                    <img src={imageUrls[img.id]} alt={img.file_name} />
                  ) : (
                    <div className="gallery-loading">{img.missing ? '文件缺失' : '加载中...'}</div>
                  )}
                </div>
                <div className="history-result-info">
                  <span className="history-result-plan">{img.file_name}</span>
                  <span className="history-result-time">{formatTaskDateTime(img.created_at)}</span>
                  <button
                    type="button"
                    className="settings-btn settings-btn-outline settings-btn-sm"
                    disabled={img.missing}
                    onClick={(e) => { e.stopPropagation(); api.openFile(img.local_path); }}
                  >
                    查看图片
                  </button>
                </div>
              </div>
            ))}
          </div>
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
      </section>

      {/* 高级 / 技术信息（默认折叠） */}
      <details className="history-advanced">
        <summary>高级信息（任务 ID / 接口 / 模型 / 输出目录）</summary>
        <div className="detail-params history-advanced-body">
          <div className="detail-row">
            <span>任务 ID</span>
            <span className="history-adv-value">
              {task.id}
              <button type="button" className="settings-btn settings-btn-link settings-btn-sm" onClick={() => void copyField(task.id, '任务 ID')}>复制</button>
            </span>
          </div>
          <div className="detail-row"><span>提示词优化</span>
            <span>{optState.applied ? `已优化${optState.legacy ? '（详情未记录）' : ''}` : '未优化'}</span>
          </div>
          {optState.snapshot?.provider_name && (
            <div className="detail-row"><span>优化服务</span><span>{optState.snapshot.provider_name}</span></div>
          )}
          {optState.snapshot?.model_name && (
            <div className="detail-row"><span>优化模型</span><span>{optState.snapshot.model_name}</span></div>
          )}
          {optState.snapshot?.optimized_at && (
            <div className="detail-row"><span>优化时间</span><span>{formatTaskDateTime(optState.snapshot.optimized_at)}</span></div>
          )}
          <div className="detail-row"><span>图片模型</span><span>{IMAGE_EXECUTION_MODEL}</span></div>
          <div className="detail-row">
            <span>生成接口</span>
            <span className="history-adv-value">
              <span className="path">{getApiEndpoint(task)}</span>
              <button type="button" className="settings-btn settings-btn-link settings-btn-sm" onClick={() => void copyField(getApiEndpoint(task), '接口地址')}>复制</button>
            </span>
          </div>
          {task.batch_strategy && (
            <div className="detail-row"><span>内部执行方式</span><span>{batchStrategyLabel(task.batch_strategy)}</span></div>
          )}
          <div className="detail-row"><span>尺寸</span><span>{task.size}</span></div>
          <div className="detail-row"><span>质量</span><span>{task.quality}</span></div>
          <div className="detail-row"><span>格式</span><span>{task.output_format.toUpperCase()}</span></div>
          <div className="detail-row"><span>请求数量</span><span>{task.count}</span></div>
          <div className="detail-row"><span>成功 / 失败</span><span>{task.success_count} / {task.failed_count}</span></div>
          <div className="detail-row">
            <span>输出目录</span>
            <span className="history-adv-value">
              <span className="path">{task.output_dir}</span>
              <button type="button" className="settings-btn settings-btn-link settings-btn-sm" onClick={() => void copyField(task.output_dir, '输出目录')}>复制</button>
            </span>
          </div>
        </div>
      </details>
    </>
  );
}
