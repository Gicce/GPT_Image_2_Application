import { getHistoryApiEndpoint as getApiEndpoint } from '../utils/taskEndpoint';
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
import { SkillTraceContent } from '../features/vision/skills/SkillTraceDrawer';
import { buildSkillTraceMarkdown } from '../features/vision/skills/exportTrace';
import { formatDuration } from '../utils/taskDuration';
import { deriveTaskState, DERIVED_STATUS_META, taskDurationMs } from '../utils/taskState';
import { classifyGenerationFailure } from '../utils/taskFailure';
import { HISTORY_FOCUS_KEY } from '../utils/taskNavigation';
import PromptTextBlock from '../components/PromptTextBlock';
import BatchPlanDetailDrawer from '../components/BatchPlanDetailDrawer';
import TaskFilterBar from '../components/TaskFilterBar';
import { useImageViewerStore } from '../store/useImageViewerStore';
import type { ImageViewerItem } from '../store/useImageViewerStore';
import {
  describeExecutionRules,
  describeProvenanceModificationPlan,
  PROVENANCE_ROLE_LABELS,
} from '../features/vision/generationProvenance';
import { promptSourceLabel } from '../features/promptExecution/executionSnapshot';
import BatchSeriesDialog from '../components/BatchSeriesDialog';
import './History.css';
import './ImageEdit.css';
import '../components/BatchPlans.css';

/** 任务状态展示：sub_tasks 事实派生（后端事件丢失也不再卡「生成中」）。 */
function taskStatusMeta(task: Task): { label: string; cls: string } {
  return DERIVED_STATUS_META[deriveTaskState(task)];
}

const STATUS_BADGE_CLS: Record<string, string> = {
  pending: 'pending',
  running: 'loading',
  completed: 'success',
  failed: 'error',
  cancelled: 'pending',
};

const SUB_STATUS_META: Record<SubTask['status'], { label: string; cls: string }> = {
  pending: { label: '等待中', cls: 'pending' },
  running: { label: '● 生成中', cls: 'loading' },
  completed: { label: '✓ 已完成', cls: 'success' },
  failed: { label: '✕ 失败', cls: 'error' },
  cancelled: { label: '已取消', cls: 'pending' },
};

const IMAGE_EXECUTION_MODEL = 'GPT Image 2';

/** 漫画任务种类（execution_snapshot.comic.kind → 展示词；copy.md 2a 术语表）。 */
const COMIC_KIND_LABELS: Record<string, string> = {
  anchor: '首格锚点',
  panels: '系列分镜',
  panel_regen: '单格重绘',
  character_ref: '角色参考图',
  bake_text: '烘焙文字',
};

function getSourceLabel(task: Task): string {
  if (task.task_source === 'cy-video-studio') return 'CY Video Studio · 视频复刻';
  if (task.task_source === 'vision_recreation') return '视觉复刻';
  if (task.task_source === 'comic') return 'AI 漫画';
  if (task.task_source === 'batch_series') return '系列批量';
  return task.task_source === 'agent' ? 'AI Agent' : '手动';
}

/** 视觉复刻链路任务（新任务有 task_source 标记；旧任务按来源任务类型识别）。 */
function isVisionRecreationTask(task: Task): boolean {
  return task.task_source === 'vision_recreation' || task.source_task_kind === 'vision_understanding';
}


/** 与 Rust compose_model_instruction 一致：gpt-image-2 无独立负面参数，适配层拼接后发送 */
function composeExecutedPrompt(positive: string, negative: string): string {
  const neg = negative.trim();
  if (!neg) return positive.trim();
  return `${positive.trim()}\n\n画面中严格避免出现以下内容：${neg}`;
}

/** 任务详情小节序号（① 起；条件区块按渲染顺序取号，绝不跳号） */
const SECTION_GLYPHS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'] as const;

/** V4.1 Provenance V2 展示标签（只读快照；与项目域 label 单一语义对齐） */
const REGION_TYPE_LABELS_HISTORY: Record<string, string> = {
  person: '人物替换', background: '背景替换', object: '物体替换', custom: '自定义',
};
const PERSON_SCOPE_LABELS_HISTORY: Record<string, string> = {
  whole_person: '整个人物', face: '脸部', upper_body: '上半身', custom_region: '指定区域',
};
const PERSON_STRENGTH_LABELS_HISTORY: Record<string, string> = {
  natural: '自然', balanced: '平衡', strict: '严格',
};

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
  errorDetail?: SubTask['error_detail'];
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
      errorDetail: sub.error_detail,
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
  // V4.2.4 批量同效果生成入口（详情头按钮 → 系列批量向导，预选当前任务）
  const [seriesDialogTaskId, setSeriesDialogTaskId] = useState<string | null>(null);
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
      if (!selectedTask || (selectedTask.source_images.length === 0 && !selectedTask.mask_image)) {
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
      // V4.1 Region V1：区域 mask 缩略图（区域段预览用；读取失败不阻塞）
      if (selectedTask.mask_image) {
        try {
          urls[selectedTask.mask_image] = await api.readThumbnail(selectedTask.mask_image);
        } catch {
          urls[selectedTask.mask_image] = '';
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

  // TaskQueue「查看任务详情」深链：按 task id 精确选中（不依赖列表第一页 / 当前筛选）。
  // 键保留到用户手动点选其它任务为止 —— 刷新 / 重进 History 仍能重新打开同一详情。
  useEffect(() => {
    let focusId: string | null = null;
    try {
      focusId = localStorage.getItem(HISTORY_FOCUS_KEY);
    } catch {}
    if (!focusId || selectedTaskId === focusId) return;
    // 任务尚未加载完成（loadTasks 未返回）时等待下一轮 tasks 更新
    if (!tasks.some(task => task.id === focusId)) return;
    setSelectedTaskId(focusId);
    setActiveCategory('all');
    const targetId = focusId;
    setTimeout(() => {
      const el = document.querySelector(`.history-item[data-task-id="${CSS.escape(targetId)}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  const handleSelectTask = (taskId: string) => {
    try {
      if (localStorage.getItem(HISTORY_FOCUS_KEY) !== taskId) {
        localStorage.removeItem(HISTORY_FOCUS_KEY);
      }
    } catch {}
    setSelectedTaskId(taskId);
  };

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
            visibleHistoryTasks.map(task => {
              const derived = deriveTaskState(task);
              const derivedMeta = DERIVED_STATUS_META[derived];
              return (
              <div
                key={task.id}
                data-task-id={task.id}
                className={`history-item ${selectedTaskId === task.id ? 'active' : ''}`}
                onClick={() => handleSelectTask(task.id)}
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
                  <span>{derivedMeta.label}</span>
                  <span>{task.size}</span>
                  {task.task_type !== 'vision_understanding' && <span>{task.count} 张</span>}
                  <span className="success">成功 {task.success_count}</span>
                  {task.failed_count > 0 && <span className="fail">失败 {task.failed_count}</span>}
                </div>
                <p className="history-time">{new Date(task.created_at).toLocaleString('zh-CN')}</p>
              </div>
              );
            })
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
              onStartSeries={setSeriesDialogTaskId}
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

      {seriesDialogTaskId && (
        <BatchSeriesDialog
          preselectedTaskId={seriesDialogTaskId}
          onClose={() => setSeriesDialogTaskId(null)}
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
  const openViewer = useImageViewerStore(state => state.openViewer);
  return (
    <>
      <div className="bp-drawer-divider" />
      <div className="form-group">
        <div className="bp-drawer-field-head">
          <label>实际执行提示词 <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>（发送给模型的真实快照，含负面拼接）</span></label>
        </div>
        <p className="bp-readonly-text bp-readonly-prompt bp-readonly-negative">
          {/* V4.2.4：优先读执行时回写的真实快照；旧任务缺失才按同一拼接规则展示 */}
          {task.sub_tasks[item.index]?.executed_prompt?.trim()
            || composeExecutedPrompt(item.positivePrompt, item.negativePrompt)}
        </p>
        {!task.sub_tasks[item.index]?.executed_prompt?.trim() && (
          <p className="history-empty-hint">旧版本任务：未记录完整执行快照（上方为按当前拼接规则推算）。</p>
        )}
      </div>
      {item.error && (() => {
        const failure = classifyGenerationFailure({ detail: item.errorDetail ?? null, message: item.error });
        return (
          <div className="form-group">
            <div className="bp-drawer-field-head"><label>失败原因</label></div>
            <p className="bp-readonly-text history-plan-error">{failure.title}——{failure.userMessage}</p>
            {failure.suggestion && (
              <p className="bp-readonly-text history-plan-suggestion">{failure.suggestion}</p>
            )}
            <details className="history-advanced">
              <summary>技术详情</summary>
              <div className="history-advanced-body">
                {failure.technical?.httpStatus !== undefined && (
                  <p className="bp-readonly-text">HTTP 状态：{failure.technical.httpStatus}</p>
                )}
                {failure.technical?.providerCode && (
                  <p className="bp-readonly-text">Provider Code：{failure.technical.providerCode}</p>
                )}
                {failure.technical?.endpoint && (
                  <p className="bp-readonly-text">Endpoint：{failure.technical.endpoint}</p>
                )}
                {failure.technical?.requestId && (
                  <p className="bp-readonly-text">Request ID：{failure.technical.requestId}</p>
                )}
                <p className="bp-readonly-text">{item.error}</p>
              </div>
            </details>
          </div>
        );
      })()}
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
          <div
            className="history-plan-result"
            onClick={() => !image.missing && openViewer(
              [{
                id: image.id,
                path: image.local_path,
                title: image.file_name,
                fileName: image.file_name,
                prompt: item.positivePrompt?.trim() || undefined,
              }],
              0,
            )}
          >
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

/** 历史任务详情主体：① 任务概览 ② 用户要求 ③ 本次修改方案 ④ 参考图片 ⑤ 最终执行 Prompt ⑥ 模型执行记录 ⑦ 生成结果 */
function HistoryTaskDetail(props: {
  task: Task;
  taskImages: ImageRecord[];
  imageUrls: Record<string, string>;
  sourceUrls: Record<string, string>;
  planItems: HistoryPlanItem[];
  isPlanBatch: boolean;
  onOpenPlanDrawer: (index: number) => void;
  onStartSeries: (taskId: string) => void;
}) {
  const { task, taskImages, imageUrls, sourceUrls, planItems, isPlanBatch } = props;
  const optState = promptOptimizationState(task);
  const total = task.count || task.sub_tasks.length || 1;
  const done = task.success_count + task.failed_count;
  const progressPercent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const openViewer = useImageViewerStore(state => state.openViewer);

  // 生成溯源快照（新任务创建时冻结；旧任务缺失 → 如实「未保存」，禁止伪造）
  const provenance = task.provenance ?? null;
  const visionLinked = isVisionRecreationTask(task);
  // 动漫角色一致性兼容口径：模板含动漫媒介层但无角色卡快照 = 功能上线前生成
  // （如实提示，禁止按当前项目补写一张卡）
  const hasAnimeLayersButNoCharacterCard = !!provenance?.renderingContract
    && provenance.renderingContract.overallMode === 'mixed_media'
    && (provenance.renderingContract.regions ?? []).some(region => region.renderingMode === 'anime_illustration')
    && !provenance.animeCharacterSnapshot;

  // 用户要求唯一读取入口：新任务读快照 userInstruction（用户原话）；
  // 旧视觉任务没有快照 → 明示「未保存」；普通任务 user_prompt_raw 本身就是用户输入。
  // 绝不允许用 final_prompt / optimizedPrompt 充当用户要求。
  const userInstruction = provenance?.userInstruction?.trim()
    || (!visionLinked ? (task.user_prompt_raw || task.prompt).trim() : '');
  const userInstructionEmptyHint = visionLinked && !userInstruction
    ? '（该历史任务未保存原始用户要求）'
    : '（未记录原始需求）';

  // 本次修改方案（结构化；只有快照任务才有，旧任务不凭 Prompt 反推）
  const modificationPlanRows = provenance ? describeProvenanceModificationPlan(provenance) : [];
  // 执行规则摘要（最终 Prompt 前的确定性规则速览；同样只读快照）
  // V4.1 追加项目合同 V2 行（人物强度 / 范围 / 身份应用 / 媒介结构；只读快照，绝不读当前项目状态）
  const executionRules = provenance ? (() => {
    const base = describeExecutionRules(provenance);
    const contract = provenance.personContract;
    if (contract) {
      base.splice(1, 0,
        `人物约束：${PERSON_STRENGTH_LABELS_HISTORY[contract.strength] ?? contract.strength}`,
        `替换范围：${PERSON_SCOPE_LABELS_HISTORY[contract.replaceScope] ?? contract.replaceScope}`,
        `身份应用：${contract.applyIdentityTo === 'all_corresponding_subjects' ? '所有对应主体' : '仅主体人物'}`,
      );
    }
    const rendering = provenance.renderingContract;
    if (rendering?.overallMode === 'mixed_media') {
      const layers = (rendering.regions ?? [])
        .map(layer => `${layer.label}=${layer.renderingMode}${layer.identityRelation === 'same_as_primary' ? '（同一人物）' : ''}`)
        .join('；');
      base.push(`媒介结构：混合媒介${rendering.preserveTemplateMediaStructure ? '（保持模板分层）' : ''}${layers ? `——${layers}` : ''}`);
    } else if (rendering?.overallMode === 'single_media' && rendering.singleMode && rendering.singleMode !== 'unknown') {
      base.push(`媒介结构：单一媒介（${rendering.singleMode}）`);
    }
    return base;
  })() : [];

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

  // V4.2.4 执行快照：Prompt 三元组（正向/负向/实际执行）优先读创建时冻结的快照，
  // 其次读执行时回写的 sub_tasks[].executed_prompt；旧任务缺失 → legacy 字段 + 如实标注。
  const executionSnapshot = task.execution_snapshot ?? null;
  const snapshotPositive = executionSnapshot?.positivePrompt?.trim() || '';
  const snapshotNegative = executionSnapshot?.negativePrompt?.trim() || '';
  const displayPositive = snapshotPositive || singlePositive;
  const displayNegative = snapshotNegative || singleNegative;
  const executedPromptReal = executionSnapshot?.effectivePrompt?.trim()
    || task.sub_tasks.map(sub => sub.executed_prompt?.trim() ?? '').find(text => text.length > 0)
    || '';
  const promptSourceText = executionSnapshot?.promptSource
    ? promptSourceLabel(executionSnapshot.promptSource)
    : '旧版本任务（未记录 Prompt 来源）';

  // 批量同效果入口：成功产图的生成/编辑任务（终态）才可发起系列批量
  const canStartSeries = (task.task_type === 'generate' || task.task_type === 'edit')
    && task.success_count > 0
    && (['completed', 'failed', 'cancelled'].includes(task.status) || !!task.completed_at);

  // 参考图片（点击进全局 ImageViewer）：新任务带角色（画面模板 / 人物参考…），旧任务只编号
  const referenceCards: Array<{ path: string; roleLabel: string; label: string }> = provenance?.imageRoles
    ? provenance.imageRoles.map(role => ({
        path: role.path,
        roleLabel: PROVENANCE_ROLE_LABELS[role.role] || '参考图',
        label: `@${role.label}`,
      }))
    : task.source_images.map((path, index) => ({
        path,
        roleLabel: '',
        label: `参考图 ${index + 1}`,
      }));
  const openReferenceViewer = (index: number) => {
    const items: ImageViewerItem[] = referenceCards
      .filter(card => !!card.path)
      .map(card => ({ path: card.path, title: card.label, fileName: card.path.split(/[\\/]/).pop() }));
    if (items.length === 0) return;
    openViewer(items, index);
  };

  /** 生成结果点击进全局 Viewer（携带该张实际提交的 Prompt：批量走方案 override，单张走 final_prompt）。 */
  const openResultViewer = (indexInTaskImages: number) => {
    if (indexInTaskImages < 0 || indexInTaskImages >= taskImages.length) return;
    if (taskImages[indexInTaskImages].missing) return;
    const visible = taskImages.filter(img => !img.missing);
    const items: ImageViewerItem[] = visible.map(img => {
      const planItem = isPlanBatch ? planItems.find(item => item.imageId === img.id) : undefined;
      const prompt = (planItem?.positivePrompt || singlePositive).trim();
      return {
        id: img.id,
        path: img.local_path,
        title: img.file_name,
        fileName: img.file_name,
        prompt: prompt || undefined,
      };
    });
    const index = visible.findIndex(img => img.id === taskImages[indexInTaskImages].id);
    if (items.length === 0 || index < 0) return;
    openViewer(items, index);
  };

  // 模型执行记录（生成时快照，非当前 Settings；Prompt 优化回落优化快照字段）
  const modelRows: Array<{ label: string; value: string }> = [];
  if (provenance) {
    const visionModel = provenance.models?.visionAnalysis;
    const optimizerModel = provenance.models?.promptOptimizer;
    const evaluationModel = provenance.models?.imageEvaluation;
    modelRows.push({
      label: '视觉理解',
      value: visionModel?.displayName
        ? `${visionModel.displayName}${visionModel.providerName ? ` · ${visionModel.providerName}` : ''}`
        : '—',
    });
    const optimizerName = optimizerModel?.displayName || optState.snapshot?.model_name || '';
    const optimizerProvider = optimizerModel?.providerName || optState.snapshot?.provider_name || '';
    modelRows.push({
      label: 'Prompt 优化',
      value: optimizerName
        ? `${optimizerName}${optimizerProvider ? ` · ${optimizerProvider}` : ''}`
        : '未优化（原始复刻 Prompt）',
    });
    modelRows.push({
      label: '图片生成',
      value: provenance.models?.imageGeneration?.displayName || 'gpt-image-2',
    });
    modelRows.push({
      label: 'AI 评价',
      value: evaluationModel?.displayName
        ? `${evaluationModel.displayName}${evaluationModel.providerName ? ` · ${evaluationModel.providerName}` : ''}`
        : '未配置视觉模型（生成后不评价）',
    });
  }

  // 小节序号（V4.1：①概览固定，②起动态取号——项目来源段存在时用户要求顺延为 ③）
  const hasProjectSource = !!(provenance?.projectId && provenance?.projectName);
  const hasRegions = (provenance?.regions?.length ?? 0) > 0;
  const personContract = provenance?.personContract;
  const renderingContract = provenance?.renderingContract;
  let sectionIndex = 2;
  const takeSectionGlyph = (show: boolean): string => (show ? SECTION_GLYPHS[sectionIndex++] : '');
  const projectSourceGlyph = takeSectionGlyph(hasProjectSource);
  const userInstructionGlyph = takeSectionGlyph(true);
  const modificationPlanGlyph = takeSectionGlyph(modificationPlanRows.length > 0);
  const regionGlyph = takeSectionGlyph(hasRegions);
  const referenceGlyph = takeSectionGlyph(referenceCards.length > 0);
  const plansGlyph = takeSectionGlyph(isPlanBatch);
  const promptGlyph = takeSectionGlyph(!isPlanBatch);
  const modelsGlyph = takeSectionGlyph(modelRows.length > 0);
  const resultsGlyph = SECTION_GLYPHS[sectionIndex];

  return (
    <>
      <div className="history-detail-head">
        <h3>{getTaskCategoryLabel(task)}任务详情</h3>
        <span className={`bp-status-badge ${STATUS_BADGE_CLS[task.status] || 'pending'}`}>
          {taskStatusMeta(task).label}
        </span>
        {canStartSeries && (
          <button
            type="button"
            className="settings-btn settings-btn-outline settings-btn-sm history-series-btn"
            onClick={() => props.onStartSeries(task.id)}
          >
            批量同效果生成
          </button>
        )}
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
            {task.execution_snapshot?.comic && (
              <div className="detail-row">
                <span>漫画溯源</span>
                <span>
                  {COMIC_KIND_LABELS[task.execution_snapshot.comic.kind] ?? '漫画生成'}
                  {task.execution_snapshot.comic.projectName ? ` · ${task.execution_snapshot.comic.projectName}` : ''}
                  {task.execution_snapshot.comic.skillName ? ` · 技能「${task.execution_snapshot.comic.skillName}」` : ''}
                  {task.execution_snapshot.comic.storyTitle ? ` · 故事「${task.execution_snapshot.comic.storyTitle}」` : ''}
                  {task.execution_snapshot.comic.characterName ? ` · 角色「${task.execution_snapshot.comic.characterName}」` : ''}
                </span>
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
            {task.mask_image && (
              <div className="detail-row"><span>区域 mask</span><span>已随请求提交（透明 = 可编辑区域）</span></div>
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
            <div className="detail-row"><span>开始时间</span><span>{formatTaskDateTime(task.started_at ?? '') || '—'}</span></div>
            {(() => {
              // 结束时间 = completed/failed/partial/cancelled 共用的终态时间（旧数据缺失如实「—」）
              const terminal = ['completed', 'failed', 'cancelled'].includes(task.status)
                || !!task.completed_at;
              if (!terminal) return null;
              const duration = formatDuration(taskDurationMs(task));
              return (
                <>
                  <div className="detail-row"><span>结束时间</span><span>{formatTaskDateTime(task.completed_at ?? '') || '—'}</span></div>
                  <div className="detail-row"><span>耗时</span><span>{duration || '—'}</span></div>
                </>
              );
            })()}
          </div>
          {(task.success_count > 0 || task.failed_count > 0) && (
            <div className="history-overview-counts">
              <span className="ok">成功 {task.success_count}</span>
              {task.failed_count > 0 && <span className="fail">失败 {task.failed_count}</span>}
            </div>
          )}
        </div>
      </section>

      {/* ② 项目来源（§34：项目化链路冻结 projectId / 修订；旧任务无此段 = 非项目生成，绝不伪造） */}
      {hasProjectSource && (
        <section className="history-section">
          <h4 className="history-section-title">
            <span className="history-section-no">{projectSourceGlyph}</span>项目来源
          </h4>
          <div className="history-overview">
            <div className="history-overview-grid">
              <div className="detail-row"><span>视觉项目</span><span>{provenance!.projectName}</span></div>
              <div className="detail-row"><span>Project Revision</span><span>{provenance!.projectRevision ?? '—'}</span></div>
            </div>
          </div>
        </section>
      )}

      {/* 用户要求（用户真正输入的原话；快照任务读 userInstruction，绝不读 final_prompt） */}
      <section className="history-section">
        <h4 className="history-section-title">
          <span className="history-section-no">{userInstructionGlyph}</span>用户要求
        </h4>
        <PromptTextBlock
          title="用户要求"
          content={userInstruction}
          copyToastLabel="用户要求已复制"
          emptyHint={userInstructionEmptyHint}
        />
      </section>

      {/* 本次修改方案（结构化展示；只有快照任务才有，旧任务不凭 Prompt 反推） */}
      {modificationPlanRows.length > 0 && (
        <section className="history-section">
          <h4 className="history-section-title">
            <span className="history-section-no">{modificationPlanGlyph}</span>本次修改方案
          </h4>
          <div className="history-plan-rows">
            {modificationPlanRows.map(row => (
              <div key={row.label} className={`history-plan-row is-${row.kind}`}>
                <span className="history-plan-row-label">{row.label}</span>
                <span className="history-plan-row-value">{row.value}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 区域（§34 ⑤：只读快照 regions；mask 缩略图来自 sourceUrls，无 mask 如实标注） */}
      {hasRegions && (
        <section className="history-section">
          <h4 className="history-section-title">
            <span className="history-section-no">{regionGlyph}</span>区域替换（{provenance!.regions!.length}）
          </h4>
          <div className="history-plan-rows">
            {provenance!.regions!.map(region => (
              <div key={region.id} className={`history-plan-row is-modified`}>
                <span className="history-plan-row-label">
                  {region.name}
                  {region.personReferenceLabel ? `（@${region.personReferenceLabel}）` : ''}
                </span>
                <span className="history-plan-row-value">
                  {REGION_TYPE_LABELS_HISTORY[region.replaceType] ?? region.replaceType}
                  {region.replaceScope ? ` · ${PERSON_SCOPE_LABELS_HISTORY[region.replaceScope] ?? region.replaceScope}` : ''}
                  {` · ${PERSON_STRENGTH_LABELS_HISTORY[region.constraintStrength] ?? region.constraintStrength}`}
                  {region.rect ? ` · 矩形 (${region.rect.x.toFixed(2)}, ${region.rect.y.toFixed(2)}, ${region.rect.w.toFixed(2)}×${region.rect.h.toFixed(2)})` : ''}
                  {region.brush ? ` · 画笔 ${region.brush.strokes} 笔` : ''}
                  {region.prompt ? ` · ${region.prompt}` : ''}
                  {region.maskPath
                    ? (sourceUrls[region.maskPath]
                      ? ' · mask 已提交'
                      : ' · mask 已提交（预览不可用）')
                      : ' · 无栅格 mask'}
                </span>
              </div>
            ))}
          </div>
          {task.mask_image && sourceUrls[task.mask_image] && (
            <div className="history-images history-region-mask-preview">
              <div className="history-img-item" title="区域合成 mask（透明 = 可编辑区域）">
                <img src={sourceUrls[task.mask_image]} alt="区域 mask" />
                <span><em className="history-img-role">区域 mask</em>透明 = 可编辑</span>
              </div>
            </div>
          )}
        </section>
      )}

      {/* 参考图片（新任务带业务角色：画面模板 / 人物参考…；旧任务仅编号，不瞎猜角色） */}
      {referenceCards.length > 0 && (
        <section className="history-section">
          <h4 className="history-section-title">
            <span className="history-section-no">{referenceGlyph}</span>参考图片（{referenceCards.length}）
          </h4>
          <div className="history-images">
            {referenceCards.map((card, index) => (
              <div key={`${card.path}-${index}`} className="history-img-item" onClick={() => openReferenceViewer(index)}>
                {sourceUrls[card.path] ? (
                  <img src={sourceUrls[card.path]} alt={card.label} />
                ) : (
                  <div className="gallery-loading">文件缺失</div>
                )}
                <span>
                  {card.roleLabel && <em className="history-img-role">{card.roleLabel}</em>}
                  {card.label}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 生成方案（批量方案任务） */}
      {isPlanBatch && (
        <section className="history-section">
          <h4 className="history-section-title">
            <span className="history-section-no">{plansGlyph}</span>生成方案
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
                      <p
                        className="bp-card-error"
                        title={item.error}
                      >
                        {classifyGenerationFailure({ detail: item.errorDetail ?? null, message: item.error }).title}
                      </p>
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

      {/* 单张 / 非方案任务：执行规则摘要 + 最终执行 Prompt（真正提交给生成 API 的快照；非当前表单值） */}
      {!isPlanBatch && (
        <section className="history-section">
          <h4 className="history-section-title">
            <span className="history-section-no">{promptGlyph}</span>最终执行 Prompt
          </h4>
          {/* 执行规则摘要（快照结构化字段派生，供用户直接审计；绝不解析 Prompt 反推） */}
          {executionRules.length > 0 && (
            <ul className="history-exec-rules">
              {executionRules.map(rule => <li key={rule}>{rule}</li>)}
            </ul>
          )}
          <div className="history-prompts">
            <p className="history-empty-hint">Prompt 来源：{promptSourceText}</p>
            <PromptTextBlock
              title="最终执行 Prompt（正向）"
              content={displayPositive}
              copyToastLabel="最终执行 Prompt 已复制"
              emptyHint="（无正向提示词）"
            />
            {displayNegative && (
              <PromptTextBlock
                title="负面提示词"
                content={displayNegative}
                copyToastLabel="负面提示词已复制"
              />
            )}
            {executedPromptReal ? (
              <PromptTextBlock
                title="实际执行提示词（真实快照）"
                content={executedPromptReal}
                copyToastLabel="实际执行提示词已复制"
              />
            ) : displayNegative ? (
              <>
                <PromptTextBlock
                  title="实际执行提示词（按拼接规则推算）"
                  content={composeExecutedPrompt(displayPositive, displayNegative)}
                  copyToastLabel="实际执行提示词已复制"
                />
                <p className="history-empty-hint">旧版本任务：未记录完整执行快照。</p>
              </>
            ) : null}
            {/* 视觉复刻链路：AI 优化前的复刻原始 Prompt（默认折叠，不与最终版抢视觉） */}
            {visionLinked && optState.snapshot?.original_prompt?.trim() && (
              <details className="history-advanced">
                <summary>查看 AI 优化前的复刻原始 Prompt</summary>
                <div className="history-advanced-body">
                  <PromptTextBlock
                    title="复刻原始 Prompt（优化前）"
                    content={optState.snapshot.original_prompt}
                    copyToastLabel="复刻原始 Prompt 已复制"
                  />
                </div>
              </details>
            )}
          </div>
        </section>
      )}

      {/* 模型执行记录（生成时快照；Prompt 优化回落优化快照字段，绝不读当前 Settings） */}
      {modelRows.length > 0 && (
        <section className="history-section">
          <h4 className="history-section-title">
            <span className="history-section-no">{modelsGlyph}</span>模型执行记录
          </h4>
          <div className="history-model-rows">
            {modelRows.map(row => (
              <div key={row.label} className="history-model-row">
                <span className="history-model-row-label">{row.label}</span>
                <span className="history-model-row-value">{row.value}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* AI 技能与规则（V4.2 §35/§36）：只读生成时冻结的 provenance.skillExecutionSnapshot
          —— 用当时的技能版本与执行详情复盘，绝不读项目当前态重新推断；
          旧任务无快照 = 如实「无历史技能记录」，禁止伪造 */}
      {(provenance?.skillExecutionSnapshot || visionLinked) && (
        <section className="history-section">
          <h4 className="history-section-title">
            <span className="history-section-no">✦</span>AI 技能与规则
          </h4>
          {provenance?.skillExecutionSnapshot ? (
            <>
              <ul className="history-skill-summary" data-testid="history-skill-summary">
                {provenance.skillExecutionSnapshot.skills.map(record => (
                  <li key={record.skillId} className={`is-${record.status}`}>
                    {record.skillName} v{record.skillVersion}
                    {' '}{record.status === 'applied' ? '✓ 已执行'
                      : record.status === 'failed' ? '✗ 失败'
                        : record.status === 'overridden' ? '△ 已覆写'
                          : '○ 未启用'}
                  </li>
                ))}
              </ul>
              <details className="history-advanced">
                <summary>查看执行详情</summary>
                <div className="history-advanced-body">
                  {provenance.animeCharacterSnapshot && (
                    <div className="history-anime-character" data-testid="history-anime-character">
                      <strong>动漫角色一致性 · 角色卡摘要</strong>
                      <p>
                        动漫主角色「{provenance.animeCharacterSnapshot.sourceSubjectLabel}」
                        （身份来源：{provenance.animeCharacterSnapshot.identitySource.kind === 'person_reference'
                          ? `@${provenance.animeCharacterSnapshot.identitySource.label ?? '人物参考图'}`
                          : provenance.animeCharacterSnapshot.identitySource.kind === 'manual' ? '文字描述' : '模板原身份'}）
                      </p>
                      <ul>
                        <li>发型：{provenance.animeCharacterSnapshot.hair}</li>
                        <li>脸型：{provenance.animeCharacterSnapshot.face}</li>
                        <li>眼睛：{provenance.animeCharacterSnapshot.eyes}</li>
                        <li>服装基底：{provenance.animeCharacterSnapshot.clothing}</li>
                        {provenance.animeCharacterSnapshot.expression && (
                          <li>表情基线：{provenance.animeCharacterSnapshot.expression}</li>
                        )}
                      </ul>
                      {provenance.detailInsertBindings && provenance.detailInsertBindings.length > 0 && (
                        <p>
                          细节插图同步：{provenance.detailInsertBindings.length} 个插图引用同一角色卡
                          （{provenance.detailInsertBindings.map(binding => binding.insertLabel).join('、')}）；
                          锁定 {provenance.detailInsertBindings[0].lockedAspects.slice(0, 4).join(' / ')}，
                          允许变化 {provenance.detailInsertBindings[0].allowedVariation.slice(0, 2).join(' / ')}。
                        </p>
                      )}
                    </div>
                  )}
                  {hasAnimeLayersButNoCharacterCard && (
                    <p className="history-empty-hint">
                      此任务生成于动漫角色一致性追踪功能之前。（模板含动漫媒介层但无冻结角色卡，禁止按当前项目补写。）
                    </p>
                  )}
                  <button
                    type="button"
                    className="vision-btn vision-btn-sm"
                    style={{ marginBottom: 10 }}
                    onClick={() => {
                      const markdown = buildSkillTraceMarkdown(provenance.skillExecutionSnapshot!, {
                        projectName: provenance.projectName,
                      });
                      void copyText(markdown, '复制失败，请重试').then(ok => {
                        if (ok) toastSuccess('已复制技能执行过程（Markdown）');
                      });
                    }}
                  >复制全部执行过程</button>
                  <SkillTraceContent snapshot={provenance.skillExecutionSnapshot} />
                </div>
              </details>
            </>
          ) : (
            <p className="history-empty-hint">该任务生成于技能追踪功能之前，无历史技能记录。</p>
          )}
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
                  {sub.error && (
                    <span
                      className="history-legacy-subtask-error"
                      title={sub.error}
                    >
                      {classifyGenerationFailure({ detail: sub.error_detail ?? null, message: sub.error }).title}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 生成结果（点击进全局 ImageViewer；携带该张实际提交的 Prompt 快照） */}
      <section className="history-section">
        <h4 className="history-section-title">
          <span className="history-section-no">{resultsGlyph}</span>生成结果（{taskImages.length} / {total}）
        </h4>
        {taskImages.length === 0 ? (
          <p className="no-images">暂无结果图片</p>
        ) : isPlanBatch ? (
          <div className="history-results">
            {planItems.map(item => {
              const img = item.imageId ? imageByPlanId.get(item.imageId) : undefined;
              if (!img) return null;
              const viewerIndex = taskImages.findIndex(record => record.id === img.id);
              return (
                <div key={img.id} className="history-result-card" onClick={() => openResultViewer(viewerIndex)}>
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
                      onClick={(e) => { e.stopPropagation(); openResultViewer(viewerIndex); }}
                    >
                      查看图片
                    </button>
                  </div>
                </div>
              );
            })}
            {otherImages.map(img => (
              <div key={img.id} className="history-result-card" onClick={() => openResultViewer(taskImages.findIndex(record => record.id === img.id))}>
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
                    onClick={(e) => { e.stopPropagation(); openResultViewer(taskImages.findIndex(record => record.id === img.id)); }}
                  >
                    查看图片
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="history-images">
            {taskImages.map((img, index) => (
              <div key={img.id} className="history-img-item" onClick={() => openResultViewer(index)}>
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
