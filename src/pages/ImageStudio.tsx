import { useEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTaskStore } from '../store/useTaskStore';
import { useImageStore } from '../store/useImageStore';
import { useAuthStore } from '../store/useAuthStore';
import { useImageEditStore } from '../store/useImageEditStore';
import { useDraftStore } from '../store/useDraftStore';
import type { VisionCarryDraft } from '../store/useDraftStore';
import { api } from '../services/api';
import { authorizeImageTask, settleImageTask, createRequestId, registerTaskAuthorization } from '../services/billingService';
import { optimizePrompt, resolvePromptOptimizerModelLabel } from '../services/promptOptimizer';
import { appendAiPlan, optimizeSinglePlan, planBatchFromRequirement } from '../services/batchPlanner';
import type { ParsedAiPlan } from '../services/batchPlanner';
import { SIZES, QUALITIES, QUALITY_LABELS, FORMATS } from '../types';
import type { ImageRecord, Task } from '../types';
import {
  buildBatchPlanTaskParams,
  clampPlanCount,
  createPlan,
  DEFAULT_TARGET_COUNT,
  isPlanReady,
  MAX_PLAN_COUNT,
  pendingPlanCount,
  readyPlanCount,
  type GenerationPlan,
} from '../utils/batchPlans';
import { toastError, toastSuccess, toastInfo } from '../components/Toast';
import { resolveSubmitOptimizationSnapshot } from '../features/vision/generationCarry';
import { resolveVisionCarryPatch } from '../features/vision/carryApply';
import { gateImageModelForKind } from '../features/imageModel/imageModelCapability';
import {
  INVALID_IMAGE_DROP_TOAST,
  fileNameOfPath,
  mergeSourceImages,
  type DroppedImageFile,
} from '../utils/imageDropFiles';
import { useImageDrop } from '../hooks/useImageDrop';
import { copyText } from '../utils/clipboard';
import BatchPlanCard from '../components/BatchPlanCard';
import BatchPlanDetailDrawer, { BpConfirmDialog } from '../components/BatchPlanDetailDrawer';
import { selectRecentImageTasks, recentTaskDisplayTitle, RECENT_TASKS_LIMIT } from '../utils/recentTasks';
import { formatTaskTime } from '../utils/taskDisplay';
import { useAIProviderStore } from '../features/aiProviders/store';
import './ImageStudio.css';
import './CreateTask.css';
import '../components/BatchPlans.css';

/**
 * 图片生成工作台 —— 手动生图唯一入口。
 *
 * 两个独立维度：
 *  - 生成方式 generationType：文生图 t2i / 图生图 i2i
 *  - 生成模式 generationMode：单张生成 single / 批量生成 batch
 *
 * 单张生成 = 原单页表单（一条提示词 + 可选 AI 优化 + 生成参数）。
 * 批量生成 = 一个总需求 → AI 规划 N 个不同方案 → 1 个方案 = 1 张图片。
 * GenerationPlan[] 只属于批量工作区，绝不进入单张表单；
 * 文生图 / 图生图批量状态相互独立，切换生成方式互不影响。
 *
 * 所有提交统一走 Rust TaskQueue（createAndExecuteTask），
 * 页面不直接调用图片 Provider，负面词组合在 Rust 适配层完成。
 */

type GenerationType = 't2i' | 'i2i';
type GenerationMode = 'single' | 'batch';

/** 批量工作区状态：一个总需求 → N 个方案（1 方案 = 1 张图）。文生图 / 图生图各自独立。 */
interface BatchWorkspace {
  /** 总需求（用户唯一的顶层输入，AI 规划的输入） */
  requirement: string;
  /** 目标数量：仅第一次 AI 规划前生效（控制方案数 = 最终图片数） */
  targetCount: number;
  plans: GenerationPlan[];
  planningStatus: 'idle' | 'planning' | 'error';
  planningError: string;
  /** 上次成功规划 / 导入时的总需求（用于检测「规划后修改了总需求」） */
  plannedRequirement: string;
}

function emptyBatchWorkspace(): BatchWorkspace {
  return {
    requirement: '',
    targetCount: DEFAULT_TARGET_COUNT,
    plans: [],
    planningStatus: 'idle',
    planningError: '',
    plannedRequirement: '',
  };
}

interface SourceImage {
  path: string;
  name: string;
}

/** 单张模式的 AI 优化候选（正向/负面独立可编辑 + 采用/恢复） */
type SingleOptStatus = 'idle' | 'loading' | 'success' | 'error';

interface SingleOptimization {
  status: SingleOptStatus;
  error: string;
  positivePrompt: string;
  negativePrompt: string;
  useOptimized: boolean;
  manuallyEdited: boolean;
  providerName: string;
  modelName: string;
  originalPrompt: string;
}

function emptyOptimization(): SingleOptimization {
  return {
    status: 'idle',
    error: '',
    positivePrompt: '',
    negativePrompt: '',
    useOptimized: false,
    manuallyEdited: false,
    providerName: '',
    modelName: '',
    originalPrompt: '',
  };
}

/** 优化模型说明：未配置时提供设置入口；有配置时展示模型名 */
function OptimizerModelNote({ label }: { label: string | null }) {
  if (label) return <span className="studio-optimizer-meta">✨ AI 提示词优化 · 使用：{label}</span>;
  return (
    <span className="studio-optimizer-meta none">
      尚未配置 AI 提示词优化模型
      <button className="settings-btn settings-btn-link settings-btn-sm" onClick={() => {
        window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'settings', section: 'agents' } }));
      }}>
        前往设置
      </button>
    </span>
  );
}

function StudioThumb({ path }: { path: string }) {
  const [thumb, setThumb] = useState<string>('');
  useEffect(() => {
    let alive = true;
    api.readThumbnail(path).then(data => { if (alive) setThumb(data); }).catch(() => {});
    return () => { alive = false; };
  }, [path]);
  if (!thumb) return <span className="studio-source-placeholder">…</span>;
  return <img src={thumb} alt="" />;
}

function SourceImagePicker(props: {
  images: SourceImage[];
  onChange: (images: SourceImage[]) => void;
  /** V4.0.8 拖拽高亮（Tauri 窗口级事件由页面统一分发到此区域）。 */
  dragActive?: boolean;
}) {
  const [galleryOpen, setGalleryOpen] = useState(false);
  const { images: galleryImages, loadImages } = useImageStore();
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  useEffect(() => {
    if (props.images.some(item => !thumbs[item.path])) {
      void Promise.all(props.images.filter(item => !thumbs[item.path]).map(async item => {
        try {
          const thumb = await api.readThumbnail(item.path);
          return [item.path, thumb] as const;
        } catch {
          return null;
        }
      })).then(entries => {
        const map: Record<string, string> = {};
        for (const entry of entries) if (entry) map[entry[0]] = entry[1];
        setThumbs(prev => ({ ...prev, ...map }));
      });
    }
  }, [props.images, thumbs]);

  /** 三个入口（本地 / 图库 / 拖拽）统一走 mergeSourceImages：canonical path 去重，只有一套身份判定。 */
  function appendImages(incoming: DroppedImageFile[]) {
    const merged = mergeSourceImages(props.images, incoming);
    if (merged.added.length > 0) props.onChange(merged.images);
    return merged;
  }

  async function pickLocal() {
    const path = await api.selectImageFile();
    if (!path) return;
    appendImages([{ path, name: fileNameOfPath(path) }]);
  }

  function pickFromGallery(image: ImageRecord) {
    if (image.missing) return;
    appendImages([{ path: image.local_path, name: image.file_name }]);
    setGalleryOpen(false);
  }

  return (
    <div className="studio-source-picker">
      <div className={`studio-dropzone${props.dragActive ? ' drag-active' : ''}`}>
        <p className="studio-dropzone-title">🖼 {props.dragActive ? '松开即可添加参考图片' : '将图片拖到这里'}</p>
        <div className="settings-actions-row studio-dropzone-actions">
          <button type="button" className="settings-btn settings-btn-secondary settings-btn-sm" onClick={() => void pickLocal()}>从本地选择</button>
          <button type="button" className="settings-btn settings-btn-secondary settings-btn-sm" onClick={() => { void loadImages(); setGalleryOpen(true); }}>从图片库选择</button>
        </div>
        <p className="studio-dropzone-hint">PNG / JPG / JPEG / WebP</p>
      </div>
      {props.images.length > 0 && (
        <div className="studio-source-grid">
          {props.images.map((item, index) => (
            <div className="studio-source-thumb" key={item.path}>
              {thumbs[item.path]
                ? <img src={thumbs[item.path]} alt={item.name} title="点击查看大图" style={{ cursor: 'pointer' }} onClick={() => void api.openFile(item.path)} />
                : <span className="studio-source-placeholder">…</span>}
              <button
                type="button"
                className="studio-source-remove"
                title="移除"
                onClick={() => props.onChange(props.images.filter((_, i) => i !== index))}
              >
                ×
              </button>
              <span className="studio-source-name" title={item.name}>{item.name}</span>
            </div>
          ))}
        </div>
      )}
      {galleryOpen && (
        <div className="template-modal-overlay" onClick={() => setGalleryOpen(false)}>
          <div className="template-modal studio-gallery-modal" onClick={e => e.stopPropagation()}>
            <div className="template-modal-header">
              <h3>从图片库选择</h3>
              <button className="template-modal-close" onClick={() => setGalleryOpen(false)} aria-label="关闭">×</button>
            </div>
            <div className="template-modal-body">
              <div className="studio-gallery-grid">
                {galleryImages.filter(image => !image.missing).slice(0, 120).map(image => (
                  <button className="studio-gallery-cell" key={image.id} onClick={() => pickFromGallery(image)}>
                    <StudioThumb path={image.local_path} />
                    <span title={image.file_name}>{image.file_name}</span>
                  </button>
                ))}
                {galleryImages.length === 0 && <p className="form-hint">图片库为空。</p>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 批量模式公共参数（尺寸 / 质量 / 格式 / 输出目录）—— 所有需求共享 */
function OutputSettings(props: {
  size: string; onSize: (v: string) => void;
  quality: string; onQuality: (v: string) => void;
  format: string; onFormat: (v: string) => void;
  outputDir: string; onOutputDir: (v: string) => void;
}) {
  async function browse() {
    const dir = await api.selectDirectory();
    if (dir) props.onOutputDir(dir);
  }
  return (
    <>
      <div className="form-row form-row-wrap">
        <div className="form-group">
          <label>图片尺寸</label>
          <select value={props.size} onChange={e => props.onSize(e.target.value)}>
            {SIZES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>质量</label>
          <select value={props.quality} onChange={e => props.onQuality(e.target.value)}>
            {QUALITIES.map(q => <option key={q} value={q}>{QUALITY_LABELS[q] || q}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>输出格式</label>
          <select value={props.format} onChange={e => props.onFormat(e.target.value)}>
            {FORMATS.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
          </select>
        </div>
      </div>
      <div className="form-group">
        <label>输出目录</label>
        <div className="dir-input">
          <input value={props.outputDir} onChange={e => props.onOutputDir(e.target.value)} placeholder="选择图片保存位置" readOnly />
          <button className="browse-btn" onClick={() => void browse()}>浏览</button>
        </div>
      </div>
    </>
  );
}

/** 目标数量步进器（仅第一次 AI 规划前显示：控制方案数量 = 最终图片数量） */
function TargetCountStepper(props: { value: number; onChange: (v: number) => void }) {
  return (
    <span className="studio-count-stepper">
      <button
        type="button"
        className="studio-count-btn"
        aria-label="减少目标数量"
        disabled={props.value <= 1}
        onClick={() => props.onChange(clampPlanCount(props.value - 1))}
      >−</button>
      <input
        className="studio-count-input"
        type="number"
        min={1}
        max={MAX_PLAN_COUNT}
        value={props.value}
        onChange={e => props.onChange(clampPlanCount(parseInt(e.target.value || '1', 10) || 1))}
      />
      <button
        type="button"
        className="studio-count-btn"
        aria-label="增加目标数量"
        disabled={props.value >= MAX_PLAN_COUNT}
        onClick={() => props.onChange(clampPlanCount(props.value + 1))}
      >＋</button>
      <span className="studio-count-unit">张</span>
    </span>
  );
}

/** 单张模式 AI 优化结果区：正向 / 负面独立可编辑，采用后参与本次生成 */
function SingleOptResult(props: {
  opt: SingleOptimization;
  optimizing: boolean;
  onPatch: (patch: Partial<SingleOptimization>) => void;
  onReoptimize: () => void;
}) {
  const { opt } = props;

  async function copy(text: string, label: string) {
    if (await copyText(text)) toastSuccess(label);
  }

  return (
    <div className="studio-req-result">
      <div className="studio-req-result-head">
        <span className="studio-req-result-title">
          AI 优化结果
          {opt.modelName ? ` · ${opt.providerName ? `${opt.providerName} / ` : ''}${opt.modelName}` : ''}
        </span>
        {opt.useOptimized && (
          <span className="studio-req-adopted">
            ✨ 已采用 AI 优化{opt.manuallyEdited ? ' · 已手动调整' : ''}
          </span>
        )}
      </div>
      <div className="form-group studio-req-field">
        <div className="studio-field-head">
          <label>正向提示词</label>
          {opt.positivePrompt.trim() && (
            <button className="studio-field-copy" onClick={() => void copy(opt.positivePrompt, '正向提示词已复制')}>⧉ 复制</button>
          )}
        </div>
        <textarea
          className="studio-req-prompt-textarea"
          rows={4}
          value={opt.positivePrompt}
          onChange={e => props.onPatch({ positivePrompt: e.target.value, manuallyEdited: true })}
          placeholder="优化后的正向提示词（可编辑）"
        />
      </div>
      <div className="form-group studio-req-field">
        <div className="studio-field-head">
          <label>负面提示词</label>
          {opt.negativePrompt.trim() && (
            <button className="studio-field-copy" onClick={() => void copy(opt.negativePrompt, '负面提示词已复制')}>⧉ 复制</button>
          )}
        </div>
        <textarea
          className="studio-req-negative-textarea"
          rows={3}
          value={opt.negativePrompt}
          onChange={e => props.onPatch({ negativePrompt: e.target.value, manuallyEdited: true })}
          placeholder="不希望出现在图片中的内容（可编辑，可为空）"
        />
      </div>
      <div className="studio-req-result-actions">
        {opt.useOptimized ? (
          <button className="settings-btn settings-btn-outline settings-btn-sm" onClick={() => props.onPatch({ useOptimized: false })}>恢复原提示词</button>
        ) : (
          <button
            className="settings-btn settings-btn-primary settings-btn-sm"
            disabled={!opt.positivePrompt.trim()}
            onClick={() => props.onPatch({ useOptimized: true })}
          >
            采用优化
          </button>
        )}
        <button
          className="settings-btn settings-btn-secondary settings-btn-sm"
          disabled={props.optimizing}
          onClick={props.onReoptimize}
        >
          {props.optimizing ? '优化中…' : '重新优化'}
        </button>
      </div>
    </div>
  );
}

/** AI 产出 → 可合并进已有方案的 patch（description 由调用方决定是否保留原文） */
function aiPlanPatch(parsed: ParsedAiPlan, optimizer: { providerName: string; modelName: string }): Partial<GenerationPlan> {
  return {
    title: parsed.title,
    summary: parsed.summary,
    tags: parsed.tags,
    description: parsed.description,
    positivePrompt: parsed.positivePrompt,
    negativePrompt: parsed.negativePrompt,
    optimizerProviderName: optimizer.providerName,
    optimizerModelName: optimizer.modelName,
  };
}

/** AI 产出的结构化方案 → GenerationPlan */
function planFromAi(parsed: ParsedAiPlan, source: GenerationPlan['source'], optimizer: { providerName: string; modelName: string }): GenerationPlan {
  return {
    ...createPlan({ title: parsed.title, summary: parsed.summary, tags: parsed.tags, description: parsed.description, source }),
    positivePrompt: parsed.positivePrompt,
    negativePrompt: parsed.negativePrompt,
    optimizationStatus: 'success',
    optimizationError: '',
    isManuallyEdited: false,
    optimizerProviderName: optimizer.providerName,
    optimizerModelName: optimizer.modelName,
  };
}

// ============================================================
// 最近任务（统一 TaskStore 数据源：createdAt DESC / 实时事件刷新见 ensureTaskEventBridge）
// ============================================================

function RecentTasksPanel({ tasks }: { tasks: Task[] }) {
  const recent = useMemo(() => selectRecentImageTasks(tasks, RECENT_TASKS_LIMIT), [tasks]);
  return (
    <aside className="studio-recent">
      <div className="studio-recent-head">
        <h3>最近任务</h3>
        <button className="settings-btn settings-btn-link settings-btn-sm" onClick={() => {
          window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'queue' } }));
        }}>
          查看全部
        </button>
      </div>
      {recent.length === 0 && <p className="form-hint">暂无任务。提交后任务会立即出现在这里并进入统一任务队列。</p>}
      {recent.map(task => {
        const total = task.count || 1;
        const done = task.success_count + task.failed_count;
        const dotCls = task.status === 'completed' ? 'ok' : task.status === 'failed' ? 'fail' : task.status === 'running' ? 'pending' : 'muted';
        const dot = task.status === 'completed' ? '✓' : task.status === 'failed' ? '✕' : task.status === 'running' ? '●' : '○';
        const fullTitle = recentTaskDisplayTitle(task);
        return (
          <button
            key={task.id}
            className="studio-recent-item"
            title={fullTitle}
            onClick={() => window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'queue', focusTaskId: task.id } }))}
          >
            <span className={`agent-dot ${dotCls}`}>{dot}</span>
            <span className="studio-recent-main">
              <span className="studio-recent-name">{fullTitle}</span>
              <span className="studio-recent-meta">
                <span className="studio-recent-time">{formatTaskTime(task.created_at)}</span>
                <span className="studio-recent-progress">
                  {task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'
                    ? `${task.success_count}/${total}`
                    : `${done}/${total}`}
                </span>
              </span>
            </span>
          </button>
        );
      })}
    </aside>
  );
}

export default function ImageStudio() {
  const [generationType, setGenerationType] = useState<GenerationType>('t2i');
  const [generationMode, setGenerationMode] = useState<GenerationMode>('single');
  const { settings } = useSettingsStore();
  const { createAndExecuteTask, tasks, loadTasks } = useTaskStore();

  const [size, setSize] = useState(settings.default_size);
  const [quality, setQuality] = useState(settings.default_quality);
  const [format, setFormat] = useState(settings.default_format);
  const [outputDir, setOutputDir] = useState(settings.default_output_dir);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // ===== 单张模式状态（与批量完全隔离；草稿走 useDraftStore，跨页面保留） =====
  const {
    textToImagePrompt: t2iPrompt,
    textToImageNegative: t2iNegative,
    setTextToImagePrompt: setT2iPrompt,
    setTextToImageNegative: setT2iNegative,
    imageEditPrompt: i2iPrompt,
    setImageEditPrompt: setI2iPrompt,
  } = useDraftStore();
  /** 单张图生图参考图（原 imageEditSourceImages 草稿字段持久化路径） */
  const [i2iSources, setI2iSources] = useState<SourceImage[]>(() =>
    useDraftStore.getState().imageEditSourceImages.map(p => ({ path: p, name: p.split(/[\\/]/).pop() || p })));
  const [t2iOpt, setT2iOpt] = useState<SingleOptimization>(emptyOptimization);
  const [i2iOpt, setI2iOpt] = useState<SingleOptimization>(emptyOptimization);
  const singleOptimizingRef = useRef(false);

  // ===== 批量模式状态（与单张完全隔离；文生图 / 图生图批量相互独立） =====
  /** 批量图生图参考图（所有方案共用；图库「编辑此图」不进这里，进单张模式） */
  const [batchSources, setBatchSources] = useState<SourceImage[]>([]);
  const [batchT2i, setBatchT2i] = useState<BatchWorkspace>(() => emptyBatchWorkspace());
  const [batchI2i, setBatchI2i] = useState<BatchWorkspace>(() => emptyBatchWorkspace());
  /** 详情抽屉当前方案 id（定位用 planId，不随数组顺序变化错位） */
  const [drawerPlanId, setDrawerPlanId] = useState<string | null>(null);
  /** 新增方案选择弹层 / 批量导入（高级入口） */
  const [appendChoiceOpen, setAppendChoiceOpen] = useState(false);
  const [appendBusy, setAppendBusy] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [bulkImportText, setBulkImportText] = useState('');
  const [moreWaysOpen, setMoreWaysOpen] = useState(false);
  const [plansMenuOpen, setPlansMenuOpen] = useState(false);
  /** 二次确认：replan_all=重新规划全部；reoptimize_plan=覆盖手动修改的重新优化 */
  const [confirmKind, setConfirmKind] = useState<null | 'replan_all' | 'reoptimize_plan'>(null);
  const [reoptimizeTargetId, setReoptimizeTargetId] = useState<string | null>(null);
  const [reoptAllBusy, setReoptAllBusy] = useState(false);
  /** 并发防护：规划 / 单方案优化同时只允许一个请求（按钮 disabled 之外的兜底） */
  const planningRef = useRef(false);
  const optimizingIdsRef = useRef<Set<string>>(new Set());
  const plansSectionRef = useRef<HTMLDivElement | null>(null);

  function updateI2iSources(next: SourceImage[]) {
    setI2iSources(next);
    useDraftStore.getState().setImageEditSourceImages(next.map(item => item.path));
  }

  // 图库「编辑此图 / 编辑」入口：强制 图生图 + 单张生成，参考图与原需求带入单张表单
  useEffect(() => {
    const entry = useImageEditStore.getState().consume();
    if (!entry) return;
    setGenerationType('i2i');
    setGenerationMode('single');
    updateI2iSources([{ path: entry.sourcePath, name: entry.fileName }]);
    if (entry.prefillRequirement?.trim() && !useDraftStore.getState().imageEditPrompt.trim()) {
      useDraftStore.getState().setImageEditPrompt(entry.prefillRequirement.trim());
    }
  }, []);

  useEffect(() => {
    setSize(settings.default_size);
    setQuality(settings.default_quality);
    setFormat(settings.default_format);
    if (settings.default_output_dir) setOutputDir(settings.default_output_dir);
  }, [settings]);

  // 视觉理解页「用此方案生成图片」（V4.0.6/4.0.7）：一次性草稿消费，绝不自动提交生成；
  // 放在 settings 同步 effect 之后，避免默认值覆盖带入参数。
  // V4.0.7：携带来源视觉理解任务 id 与已优化标记 —— 提交时冻结快照，绝不再执行一次 AI 优化。
  // V4.0.8：生成方式不再强制文生图 —— 有原图默认图生图，原图直接作为参考图（复用素材不重复导入）。
  const [visionCarryMeta, setVisionCarryMeta] = useState<VisionCarryDraft | null>(null);
  useEffect(() => {
    const carry = useDraftStore.getState().consumeVisionCarry();
    if (!carry?.prompt?.trim()) return;
    const patch = resolveVisionCarryPatch(carry);
    setGenerationType(patch.generationType);
    setGenerationMode(patch.generationMode);
    if (patch.generationType === 'i2i') {
      setI2iPrompt(patch.i2iPrompt);
      if (patch.i2iSources.length > 0) updateI2iSources(patch.i2iSources);
    } else {
      setT2iPrompt(patch.t2iPrompt);
      if (patch.t2iNegative) setT2iNegative(patch.t2iNegative);
    }
    if (patch.size) setSize(patch.size);
    if (patch.quality) setQuality(patch.quality);
    if (carry.sourceVisionTaskId || carry.optimization) setVisionCarryMeta(carry);
  }, []);

  useEffect(() => { void loadTasks(); }, [loadTasks]);

  // 优化模型标签：Provider 配置变化时重新解析（hydrateProfiles 幂等，只读 localStorage）
  const providerProfiles = useAIProviderStore(state => state.profiles);
  useEffect(() => { useAIProviderStore.getState().hydrate(); }, []);
  const optimizerModelLabel = useMemo(() => resolvePromptOptimizerModelLabel(), [providerProfiles]);

  const isSingle = generationMode === 'single';
  const isEdit = generationType === 'i2i';

  const batch = isEdit ? batchI2i : batchT2i;
  const setBatch = isEdit ? setBatchI2i : setBatchT2i;
  const plans = batch.plans;
  const readyCount = useMemo(() => readyPlanCount(plans), [plans]);
  const pendingCount = useMemo(() => pendingPlanCount(plans), [plans]);
  const anyOptimizing = plans.some(plan => plan.optimizationStatus === 'loading');
  const allPlansReady = plans.length > 0 && pendingCount === 0;
  /** 规划后修改了总需求：提示用户现有方案不会自动变化（spec：不自动毁掉方案） */
  const requirementModified = plans.length > 0 && batch.requirement.trim() !== batch.plannedRequirement;
  const drawerPlan = drawerPlanId ? plans.find(plan => plan.id === drawerPlanId) ?? null : null;

  const singleOpt = isEdit ? i2iOpt : t2iOpt;
  const setSingleOpt = isEdit ? setI2iOpt : setT2iOpt;
  const singlePrompt = isEdit ? i2iPrompt : t2iPrompt;

  // ===== V4.0.8 参考图拖拽（Tauri 窗口级事件）：单张 / 批量共用同一导入链，绝不触发任何 API =====
  const isEditRef = useRef(isEdit);
  isEditRef.current = isEdit;
  const isSingleRef = useRef(isSingle);
  isSingleRef.current = isSingle;

  async function acceptDroppedSources(files: DroppedImageFile[]) {
    if (!isEditRef.current) {
      toastInfo('当前为文生图模式，添加参考图片请先切换到「图生图」。');
      return;
    }
    // 真实图片校验：读缩略图即解码，损坏 / 占位文件剔除并提示，不影响其余合法图片
    const readable: DroppedImageFile[] = [];
    const broken: string[] = [];
    for (const file of files) {
      try {
        await api.readThumbnail(file.path);
        readable.push(file);
      } catch {
        broken.push(file.name);
      }
    }
    const current = isSingleRef.current ? i2iSources : batchSources;
    const merged = mergeSourceImages(current, readable);
    if (merged.added.length === 0 && broken.length === 0) return;
    if (isSingleRef.current) updateI2iSources(merged.images);
    else setBatchSources(merged.images);
    if (broken.length > 0) toastError(`无法读取图片文件：${broken.join('、')}`);
  }

  const { dragActive: sourceDragActive } = useImageDrop({
    onDropImages: files => void acceptDroppedSources(files),
    onDropInvalid: () => toastError(INVALID_IMAGE_DROP_TOAST),
  });

  // ============================================================
  // 单张模式：AI 优化 + 提交
  // ============================================================

  /** 单张 AI 优化：结果进入候选区（正向/负面独立字段），不自动采用、不覆盖原文 */
  async function optimizeSingle() {
    if (singleOptimizingRef.current) return;
    const promptText = singlePrompt.trim();
    if (!promptText) return;
    singleOptimizingRef.current = true;
    const current = singleOpt;
    setSingleOpt(opt => ({ ...opt, status: 'loading', error: '' }));
    try {
      const outcome = await optimizePrompt({
        prompt: promptText,
        taskType: isEdit ? 'edit' : 'generate',
      });
      if (!outcome.ok) {
        // 重新优化失败：保留上次优化结果；首次失败：原提示词不丢失，标记错误
        if (current.status === 'success') {
          setSingleOpt(opt => ({ ...opt, status: 'success', error: outcome.error }));
          toastError(`重新优化失败：${outcome.error}（已保留上次优化结果）`);
        } else {
          setSingleOpt(opt => ({ ...opt, status: 'error', error: outcome.error }));
        }
        return;
      }
      if (outcome.result.items?.length) {
        toastInfo('AI 按多对象返回了拆分结果；单张模式请描述单张画面，多对象拆分请使用「批量生成」。');
        return;
      }
      setSingleOpt({
        status: 'success',
        error: '',
        positivePrompt: outcome.result.optimizedPrompt,
        negativePrompt: outcome.result.negativePrompt ?? '',
        useOptimized: current.useOptimized,
        manuallyEdited: false,
        providerName: outcome.result.plannerProviderName,
        modelName: outcome.result.plannerModelName,
        originalPrompt: current.originalPrompt || promptText,
      });
    } finally {
      singleOptimizingRef.current = false;
    }
  }

  /** 单张提交：一条提示词（或已采用的正/负面优化结果）→ Rust TaskQueue */
  async function submitSingle() {
    setError('');
    const promptText = singlePrompt.trim();
    // 图生图：负面词来自视觉理解携带草稿（复刻链路冻结值）；文生图：表单负面词
    const manualNegative = isEdit ? (visionCarryMeta?.negativePrompt?.trim() || '') : t2iNegative;
    const opt = singleOpt;
    // 单张生成数量默认 1；视觉理解复刻链路带入「生成参数」中选择的数量（1/2/4）
    const count = visionCarryMeta?.count && visionCarryMeta.count > 0 ? visionCarryMeta.count : 1;

    if (!promptText) {
      setError(isEdit ? '请输入图片编辑需求。' : '请输入提示词。');
      return;
    }
    if (isEdit && i2iSources.length === 0) {
      setError('图生图任务请先添加参考图片。');
      return;
    }
    if (!outputDir.trim()) {
      setError('请选择输出目录。');
      return;
    }
    if (opt.status === 'loading') {
      setError('AI 优化进行中，请等待完成或先使用原提示词生成。');
      return;
    }
    // V4.0.8 capability 门禁：图片模型不支持当前生成方式时客户端阻断，不等上游报错
    const capabilityGate = gateImageModelForKind(isEdit ? 'i2i' : 't2i');
    if (!capabilityGate.allowed) {
      setError(capabilityGate.message || '当前图片模型不支持该生成方式。');
      return;
    }

    const adopted = opt.status === 'success' && opt.useOptimized && opt.positivePrompt.trim().length > 0;
    const finalPrompt = adopted ? opt.positivePrompt.trim() : promptText;
    const finalNegative = (adopted ? opt.negativePrompt : manualNegative).trim();
    // 优化快照决策（纯函数，底层硬保证）：视觉理解链路带入的 Prompt 已在视觉理解页
    // 优化完成 → 冻结快照（source=vision_recreation）+ prompt_optimized=true，
    // 提交生成绝不再次触发 AI 优化（重复优化防护）
    const { visionOptimized, snapshot } = resolveSubmitOptimizationSnapshot({
      adopted,
      adoptedMeta: {
        providerName: opt.providerName,
        modelName: opt.modelName,
        originalPrompt: opt.originalPrompt,
        manuallyEdited: opt.manuallyEdited,
      },
      promptText,
      visionCarry: visionCarryMeta,
    });

    // 生成前预占额度：余额不足在此阻断，不会调用上游（与 BYOK 对话计费完全分离）
    const { isLoggedIn } = useAuthStore.getState();
    let billingRequestId: string | undefined;
    if (isLoggedIn) {
      try {
        billingRequestId = createRequestId('studio');
        await authorizeImageTask(billingRequestId, count);
      } catch (err: any) {
        setError(err?.message || '余额不足，请充值后继续使用');
        return;
      }
    }

    setSubmitting(true);
    try {
      const created = await createAndExecuteTask({
        prompt: finalPrompt,
        negative_prompt: finalNegative,
        user_prompt_raw: promptText,
        final_prompt: finalPrompt,
        final_negative_prompt: finalNegative,
        prompt_optimized: adopted || visionOptimized,
        prompt_optimization: snapshot,
        size,
        quality,
        output_format: format,
        count,
        output_dir: outputDir,
        task_type: isEdit ? 'edit' : 'generate',
        source_images: isEdit ? i2iSources.map(item => item.path) : [],
        execution_mode: 'single',
        task_source: 'manual',
        ...(visionCarryMeta?.sourceVisionTaskId ? {
          source_task_id: visionCarryMeta.sourceVisionTaskId,
          source_task_kind: 'vision_understanding',
        } : {}),
        ...(visionCarryMeta?.taskPlanSummary ? { task_plan_summary: visionCarryMeta.taskPlanSummary } : {}),
      });
      if (billingRequestId) registerTaskAuthorization(created.id, billingRequestId);
      toastSuccess(`已提交生成任务（${count} 张），可在任务队列查看进度`);
      // 保持原单张页面行为：提交成功后清空本次输入（视觉理解草稿一次性消费，同步清除）
      setVisionCarryMeta(null);
      if (isEdit) {
        setI2iPrompt('');
        updateI2iSources([]);
        setI2iOpt(emptyOptimization());
      } else {
        setT2iPrompt('');
        setT2iNegative('');
        setT2iOpt(emptyOptimization());
      }
    } catch (err: any) {
      if (billingRequestId) void settleImageTask(billingRequestId, false, 0, 'create task failed');
      setError(err?.toString() || '创建任务失败');
      toastError(err?.message || '创建任务失败');
    } finally {
      setSubmitting(false);
    }
  }

  // ============================================================
  // 批量模式：AI 规划 / 方案管理 / 单项优化 / 提交
  // ============================================================

  function patchBatch(patch: Partial<BatchWorkspace>) {
    setBatch(prev => ({ ...prev, ...patch }));
  }

  function updatePlan(id: string, patch: Partial<GenerationPlan>) {
    setBatch(prev => ({ ...prev, plans: prev.plans.map(plan => (plan.id === id ? { ...plan, ...patch } : plan)) }));
  }

  /**
   * 第一次 AI 规划 / 重新规划全部（确认后）：总需求 → 严格 N 个方案。
   * 失败时不清空总需求、不清空已有方案（spec：不能静默丢内容）。
   */
  async function runPlanning() {
    if (planningRef.current) return;
    const requirement = batch.requirement.trim();
    if (!requirement) {
      setError('请先填写需求内容。');
      return;
    }
    // 规划后方案数以当前列表为准（stepper 已隐藏，避免「减号模糊删除」）
    const requestedCount = plans.length > 0 ? plans.length : batch.targetCount;
    planningRef.current = true;
    patchBatch({ planningStatus: 'planning', planningError: '' });
    try {
      const outcome = await planBatchFromRequirement({
        requirement,
        requestedCount,
        taskType: isEdit ? 'edit' : 'generate',
      });
      if (!outcome.ok) {
        patchBatch({ planningStatus: 'error', planningError: outcome.error });
        toastError(`AI 方案规划失败：${outcome.error}`);
        return;
      }
      patchBatch({
        plans: outcome.plans.map(parsed => planFromAi(parsed, 'ai_planned', { providerName: outcome.providerName, modelName: outcome.modelName })),
        planningStatus: 'idle',
        planningError: '',
        plannedRequirement: requirement,
      });
      setDrawerPlanId(null);
      toastSuccess(`已生成 ${outcome.plans.length} 个方案`);
      setTimeout(() => plansSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    } finally {
      planningRef.current = false;
    }
  }

  /** 新增方案（手动）：空方案待完善，已有方案完全不动 */
  function appendManualPlan() {
    setAppendChoiceOpen(false);
    if (plans.length >= MAX_PLAN_COUNT) {
      toastError(`最多 ${MAX_PLAN_COUNT} 个方案`);
      return;
    }
    const plan = createPlan({ source: 'manual' });
    setBatch(prev => ({ ...prev, plans: [...prev.plans, plan] }));
    setDrawerPlanId(plan.id);
    toastSuccess('已新增方案，请填写方案描述');
  }

  /** 新增方案（AI）：参考已有方案补充 1 个明显不同的新方案，只调用 1 次 AI */
  async function appendAiPlanOne() {
    if (appendBusy || planningRef.current) return;
    const requirement = batch.requirement.trim();
    if (!requirement) {
      setError('请先填写需求内容，AI 才能补充方案。');
      return;
    }
    if (plans.length >= MAX_PLAN_COUNT) {
      toastError(`最多 ${MAX_PLAN_COUNT} 个方案`);
      return;
    }
    setAppendChoiceOpen(false);
    setAppendBusy(true);
    try {
      const outcome = await appendAiPlan({
        requirement,
        existingPlans: plans.map(plan => ({ title: plan.title, summary: plan.summary, description: plan.description })),
        taskType: isEdit ? 'edit' : 'generate',
      });
      if (!outcome.ok || outcome.plans.length === 0) {
        toastError(`AI 补充方案失败：${outcome.ok ? '未返回有效方案' : outcome.error}`);
        return;
      }
      const plan = planFromAi(outcome.plans[0], 'ai_appended', { providerName: outcome.providerName, modelName: outcome.modelName });
      setBatch(prev => ({ ...prev, plans: [...prev.plans, plan] }));
      toastSuccess('已新增 AI 方案');
    } finally {
      setAppendBusy(false);
    }
  }

  /**
   * 单个方案 AI 处理：description 为空 → AI 补充该方案；有 description → AI 优化该方案。
   * 只影响当前方案；失败保留旧内容（禁止发起时清空 Prompt）。
   */
  async function aiFillPlan(id: string) {
    if (optimizingIdsRef.current.has(id)) return;
    const plan = plans.find(p => p.id === id);
    if (!plan) return;
    const requirement = batch.requirement.trim();
    if (!requirement) {
      setError('请先填写需求内容。');
      return;
    }
    optimizingIdsRef.current.add(id);
    updatePlan(id, { optimizationStatus: 'loading', optimizationError: '' });
    try {
      const hasDescription = plan.description.trim().length > 0 || plan.title.trim().length > 0;
      const outcome = hasDescription
        ? await optimizeSinglePlan({
            originalRequirement: requirement,
            planTitle: plan.title,
            planDescription: plan.description,
            taskType: isEdit ? 'edit' : 'generate',
          })
        : await appendAiPlan({
            requirement,
            existingPlans: plans.filter(p => p.id !== id).map(p => ({ title: p.title, summary: p.summary, description: p.description })),
            taskType: isEdit ? 'edit' : 'generate',
          });
      if (!outcome.ok || outcome.plans.length === 0) {
        const message = outcome.ok ? 'AI 未返回有效结果' : outcome.error;
        if (isPlanReady(plan)) {
          updatePlan(id, { optimizationStatus: 'success', optimizationError: message });
          toastError(`重新优化失败：${message}（已保留原方案）`);
        } else {
          updatePlan(id, { optimizationStatus: 'error', optimizationError: message });
        }
        return;
      }
      const parsed = outcome.plans[0];
      // 重新生成 title/summary/tags/prompts；description 是优化输入，保留用户原文
      updatePlan(id, {
        ...aiPlanPatch(parsed, { providerName: outcome.providerName, modelName: outcome.modelName }),
        description: plan.description.trim() || parsed.description,
        isManuallyEdited: false,
        optimizationStatus: 'success',
        optimizationError: '',
      });
    } finally {
      optimizingIdsRef.current.delete(id);
    }
  }

  /** 重新优化前保护：已手动修改的方案需要显式确认覆盖 */
  function requestReoptimize(id: string) {
    const plan = plans.find(p => p.id === id);
    if (!plan) return;
    if (plan.isManuallyEdited) {
      setReoptimizeTargetId(id);
      setConfirmKind('reoptimize_plan');
      return;
    }
    void aiFillPlan(id);
  }

  /** 重新优化全部提示词：保留每个方案 description，串行重新生成 title/summary/tags/prompts */
  async function reoptimizeAllPrompts() {
    setPlansMenuOpen(false);
    if (reoptAllBusy || plans.length === 0) return;
    const requirement = batch.requirement.trim();
    if (!requirement) {
      setError('请先填写需求内容。');
      return;
    }
    setReoptAllBusy(true);
    try {
      for (const plan of plans) {
        if (optimizingIdsRef.current.has(plan.id)) continue;
        optimizingIdsRef.current.add(plan.id);
        updatePlan(plan.id, { optimizationStatus: 'loading', optimizationError: '' });
        try {
          const outcome = await optimizeSinglePlan({
            originalRequirement: requirement,
            planTitle: plan.title,
            planDescription: plan.description,
            taskType: isEdit ? 'edit' : 'generate',
          });
          if (outcome.ok && outcome.plans.length > 0) {
            const parsed = outcome.plans[0];
            updatePlan(plan.id, {
              ...aiPlanPatch(parsed, { providerName: outcome.providerName, modelName: outcome.modelName }),
              description: plan.description.trim() || parsed.description,
              isManuallyEdited: false,
              optimizationStatus: 'success',
              optimizationError: '',
            });
          } else {
            const message = outcome.ok ? 'AI 未返回有效结果' : outcome.error;
            updatePlan(plan.id, isPlanReady(plan)
              ? { optimizationStatus: 'success', optimizationError: message }
              : { optimizationStatus: 'error', optimizationError: message });
          }
        } finally {
          optimizingIdsRef.current.delete(plan.id);
        }
      }
      toastSuccess('已重新优化全部方案提示词');
    } finally {
      setReoptAllBusy(false);
    }
  }

  function deletePlan(id: string) {
    setBatch(prev => ({ ...prev, plans: prev.plans.filter(plan => plan.id !== id) }));
    if (drawerPlanId === id) setDrawerPlanId(null);
    toastSuccess('方案已删除');
  }

  function navigateDrawer(delta: number) {
    const index = plans.findIndex(plan => plan.id === drawerPlanId);
    if (index === -1) return;
    const next = plans[index + delta];
    if (next) setDrawerPlanId(next.id);
  }

  /** 批量导入方案（高级入口）：每行一个方案描述，导入后逐项 AI 优化 */
  function applyBulkImport() {
    const lines = bulkImportText.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length === 0) return;
    const imported = lines
      .slice(0, MAX_PLAN_COUNT - plans.length)
      .map(line => createPlan({ description: line, source: 'manual' }));
    if (imported.length === 0) {
      toastError(`最多 ${MAX_PLAN_COUNT} 个方案`);
      return;
    }
    setBatch(prev => ({
      ...prev,
      plans: [...prev.plans, ...imported],
      plannedRequirement: prev.requirement.trim(),
      planningStatus: 'idle',
      planningError: '',
    }));
    setBulkImportText('');
    setBulkImportOpen(false);
    setMoreWaysOpen(false);
    toastSuccess(`已导入 ${imported.length} 个方案，可逐项 AI 优化`);
  }

  /** 批量提交：方案列表 → buildBatchPlanTaskParams → Rust TaskQueue（1 plan = 1 image） */
  async function submitBatch() {
    setError('');
    const requirement = batch.requirement.trim();
    if (!requirement) {
      setError('请先填写需求内容。');
      return;
    }
    if (plans.length === 0) {
      setError('请先通过 AI 规划生成方案。');
      return;
    }
    if (pendingCount > 0) {
      setError(`还有 ${pendingCount} 个方案尚未完善。`);
      return;
    }
    if (anyOptimizing) {
      setError('部分方案正在进行 AI 优化，请等待完成后再生成。');
      return;
    }
    if (isEdit && batchSources.length === 0) {
      setError('图生图任务请先添加参考图片。');
      return;
    }
    if (!outputDir.trim()) {
      setError('请选择输出目录。');
      return;
    }
    // V4.0.8 capability 门禁：与单张提交同一判定（image_generation / image_edit）
    const capabilityGate = gateImageModelForKind(isEdit ? 'i2i' : 't2i');
    if (!capabilityGate.allowed) {
      setError(capabilityGate.message || '当前图片模型不支持该生成方式。');
      return;
    }

    let built;
    try {
      built = buildBatchPlanTaskParams(plans, {
        taskType: isEdit ? 'edit' : 'generate',
        originalRequirement: requirement,
        sourceImages: batchSources.map(item => item.path),
        size,
        quality,
        outputFormat: format,
        outputDir,
      });
    } catch (err: any) {
      setError(err?.message || '构建任务失败');
      return;
    }

    // 生成前预占额度：余额不足在此阻断，不会调用上游
    const { isLoggedIn } = useAuthStore.getState();
    let billingRequestId: string | undefined;
    if (isLoggedIn) {
      try {
        billingRequestId = createRequestId('batch');
        await authorizeImageTask(billingRequestId, built.total);
      } catch (err: any) {
        setError(err?.message || '余额不足，请充值后继续使用');
        return;
      }
    }

    setSubmitting(true);
    try {
      const created = await createAndExecuteTask({ ...built.params, task_source: 'manual' });
      if (billingRequestId) registerTaskAuthorization(created.id, billingRequestId);
      toastSuccess(`已提交批量任务（${plans.length} 个方案 / 共 ${built.total} 张），可在任务队列查看进度`);
      // 提交后保留总需求与方案：任务创建时已快照 Prompt，用户可继续查看 / 修改 / 再次生成
    } catch (err: any) {
      if (billingRequestId) void settleImageTask(billingRequestId, false, 0, 'create task failed');
      setError(err?.toString() || '创建任务失败');
      toastError(err?.message || '创建任务失败');
    } finally {
      setSubmitting(false);
    }
  }

  // ============================================================
  // 渲染
  // ============================================================

  function renderSingle() {
    const promptText = isEdit ? i2iPrompt : t2iPrompt;
    const opt = singleOpt;
    const optimizing = opt.status === 'loading';
    const hasResult = opt.status === 'success';

    return (
      <section className="settings-card studio-card">
        <div className="create-layout studio-single-layout">
          <div className="create-form">
            {isEdit && (
              <div className="form-group">
                <label>参考图片 <span className="required">*</span></label>
                <SourceImagePicker images={i2iSources} onChange={updateI2iSources} dragActive={sourceDragActive} />
              </div>
            )}

            <div className="form-group">
              <label>{isEdit ? '图片编辑需求' : '提示词'} <span className="required">*</span></label>
              {visionCarryMeta?.optimization && (
                <p className="form-hint studio-vision-carry">
                  来自视觉理解复刻方案{visionCarryMeta.sourceVisionTaskId ? `（视觉理解任务 #${visionCarryMeta.sourceVisionTaskId.slice(0, 8)}）` : ''}：
                  当前 Prompt 已优化，提交生成时不会再次执行 AI 优化。
                  {isEdit && visionCarryMeta.negativePrompt?.trim() ? '负面提示词将随方案一并提交。' : ''}
                </p>
              )}
              <textarea
                rows={4}
                value={promptText}
                onChange={e => (isEdit ? setI2iPrompt : setT2iPrompt)(e.target.value)}
                placeholder={isEdit
                  ? '描述你想要对图片进行的编辑，例如：把背景换成夜晚的城市街道，保留人物姿态……'
                  : '描述你想要生成的图片，越详细效果越好……'}
              />
            </div>

            <div className="settings-actions-row studio-optimizer-row">
              <button
                className="settings-btn settings-btn-secondary settings-btn-sm"
                disabled={optimizing || !promptText.trim() || !optimizerModelLabel}
                onClick={() => void optimizeSingle()}
              >
                {optimizing ? 'AI 优化中…' : hasResult ? '重新优化' : '✨ AI 优化提示词'}
              </button>
              <span className="studio-optimizer-meta">把提示词优化为专业的正向 / 负面提示词（可选）</span>
            </div>

            {opt.status === 'error' && (
              <p className="form-hint form-hint-error studio-req-error">
                AI 优化失败：{opt.error || '请重试'}
                <button className="settings-btn settings-btn-link settings-btn-sm" disabled={optimizing || !optimizerModelLabel} onClick={() => void optimizeSingle()}>重新优化</button>
              </p>
            )}

            {hasResult && (
              <SingleOptResult
                opt={opt}
                optimizing={optimizing}
                onPatch={patch => setSingleOpt(prev => ({ ...prev, ...patch }))}
                onReoptimize={() => void optimizeSingle()}
              />
            )}

            {!isEdit && (
              <div className="form-group">
                <label>负面提示词</label>
                <textarea
                  rows={2}
                  value={t2iNegative}
                  onChange={e => setT2iNegative(e.target.value)}
                  placeholder="描述你不希望出现在图片中的内容（采用 AI 优化结果时，以优化得到的负面提示词为准）"
                />
              </div>
            )}

            <div className="form-row">
              <div className="form-group">
                <label>图片尺寸</label>
                <select value={size} onChange={e => setSize(e.target.value)}>
                  {SIZES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>质量</label>
                <select value={quality} onChange={e => setQuality(e.target.value)}>
                  {QUALITIES.map(q => <option key={q} value={q}>{QUALITY_LABELS[q] || q}</option>)}
                </select>
              </div>
            </div>

            <div className="form-group">
              <label>输出格式</label>
              <select value={format} onChange={e => setFormat(e.target.value)}>
                {FORMATS.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
              </select>
            </div>

            <div className="form-group">
              <label>输出目录</label>
              <div className="dir-input">
                <input value={outputDir} onChange={e => setOutputDir(e.target.value)} placeholder="选择图片保存位置" readOnly />
                <button className="browse-btn" onClick={() => void api.selectDirectory().then(dir => { if (dir) setOutputDir(dir); })}>浏览</button>
              </div>
            </div>
          </div>

          <div className="task-summary-card">
            <h3>任务摘要</h3>
            {isEdit && (
              <div className="summary-item">
                <span className="summary-label">参考图片</span>
                <span className="summary-value">{i2iSources.length} 张</span>
              </div>
            )}
            <div className="summary-item">
              <span className="summary-label">{isEdit ? '编辑需求' : '提示词'}</span>
              <span className="summary-value">{promptText || '未填写'}</span>
            </div>
            {hasResult && opt.useOptimized && (
              <div className="summary-item">
                <span className="summary-label">AI 优化</span>
                <span className="summary-value">已采用</span>
              </div>
            )}
            <div className="summary-item">
              <span className="summary-label">图片尺寸</span>
              <span className="summary-value">{size}</span>
            </div>
            <div className="summary-item">
              <span className="summary-label">质量</span>
              <span className="summary-value">{quality}</span>
            </div>
            <div className="summary-item">
              <span className="summary-label">输出格式</span>
              <span className="summary-value">{format.toUpperCase()}</span>
            </div>
            <div className="summary-divider" />
            <div className="summary-item highlight">
              <span className="summary-label">生成数量</span>
              <span className="summary-value">{visionCarryMeta?.count && visionCarryMeta.count > 0 ? visionCarryMeta.count : 1} 张</span>
            </div>
            <div className="summary-item">
              <span className="summary-label">输出目录</span>
              <span className="summary-value path">{outputDir || '未选择'}</span>
            </div>
            <button
              className="start-btn"
              onClick={() => void submitSingle()}
              disabled={submitting}
            >
              {submitting ? '创建中...' : isEdit ? '开始编辑' : '开始生成图片'}
            </button>
            <p className="summary-note">
              {isEdit ? '图生图任务将使用所选参考图片进行 AI 编辑。' : '系统将为每张图片单独调用 API，确保稳定性。'}
              可在「任务队列」中查看实时进度。
            </p>
          </div>
        </div>
      </section>
    );
  }

  function renderBatch() {
    const planning = batch.planningStatus === 'planning';
    const planError = batch.planningStatus === 'error';
    const showPlansSection = plans.length > 0 || planning;
    const skeletonCount = plans.length > 0 ? plans.length : batch.targetCount;
    const canSubmit = allPlansReady && batch.requirement.trim().length > 0 && !anyOptimizing && !submitting;

    return (
      <section className="settings-card studio-card">
        {isEdit && (
          <div className="form-group">
            <label>参考图片 <span className="required">*</span></label>
            <span className="form-hint studio-source-hint">所有方案共用当前参考图，可添加多张。</span>
            <SourceImagePicker images={batchSources} onChange={setBatchSources} dragActive={sourceDragActive} />
          </div>
        )}

        {/* ① 批量生成需求：总需求 + 目标数量 + AI 智能规划 */}
        <div className="bp-stage-head">
          <span className="bp-stage-title"><span className="bp-stage-no">1</span>批量生成需求</span>
          <span className="bp-stage-hint">描述你想批量生成的内容，AI 会根据目标数量规划不同方案</span>
        </div>
        <div className="form-group">
          <label>需求内容 <span className="required">*</span></label>
          <textarea
            rows={4}
            value={batch.requirement}
            onChange={e => patchBatch({ requirement: e.target.value })}
            placeholder={isEdit
              ? '例如：基于这个人物生成3种不同的战国女将造型，甲胄、武器、姿态要明显不同……'
              : '例如：我需要生成3张不同的战国时期女战将，人物的服装、武器、姿势、背景需要明显不同，整体保持真实战国历史电影质感。'}
          />
        </div>
        {batch.requirement.length > 0 && (
          <p className="form-hint" style={{ marginTop: -6 }}>{batch.requirement.length} 字</p>
        )}

        {/* 规划前：目标数量 + AI 主按钮；规划后：stepper 退出，数量只随增删方案变化 */}
        {plans.length === 0 && !planning && (
          <div className="bp-require-actions">
            <span className="studio-count-row" style={{ margin: 0 }}>
              <span className="studio-count-label">目标数量</span>
              <TargetCountStepper value={batch.targetCount} onChange={v => patchBatch({ targetCount: v })} />
            </span>
            <button
              className="settings-btn settings-btn-primary"
              disabled={!batch.requirement.trim() || !optimizerModelLabel}
              onClick={() => void runPlanning()}
            >
              ✨ AI 智能规划并优化 {batch.targetCount} 个方案
            </button>
            <div className="bp-more-wrap">
              <button className="settings-btn settings-btn-secondary settings-btn-sm" onClick={() => setMoreWaysOpen(v => !v)}>更多方式 ▾</button>
              {moreWaysOpen && (
                <div className="bp-more-menu">
                  <button type="button" onClick={() => { setMoreWaysOpen(false); setBulkImportOpen(true); }}>批量导入方案</button>
                </div>
              )}
            </div>
          </div>
        )}

        {bulkImportOpen && (
          <div className="studio-bulk-paste">
            <textarea
              rows={4}
              value={bulkImportText}
              onChange={e => setBulkImportText(e.target.value)}
              placeholder="每行一个方案描述，粘贴后点击「应用」导入为待完善方案，可逐项 AI 优化（高级入口，主流程仍是 AI 规划）"
            />
            <div className="settings-actions-row">
              <button className="settings-btn settings-btn-primary settings-btn-sm" onClick={applyBulkImport}>应用</button>
              <button className="settings-btn settings-btn-secondary settings-btn-sm" onClick={() => setBulkImportOpen(false)}>取消</button>
            </div>
          </div>
        )}

        {planError && !planning && (
          <p className="form-hint form-hint-error studio-req-error">
            AI 方案规划失败：{batch.planningError || '请重试'}
            <button
              className="settings-btn settings-btn-link settings-btn-sm"
              disabled={!batch.requirement.trim() || !optimizerModelLabel}
              onClick={() => void runPlanning()}
            >
              重新尝试
            </button>
          </p>
        )}

        {requirementModified && !planning && (
          <p className="bp-requirement-hint">
            总需求已修改，现有方案不会自动变化。如需按新需求重新生成，可使用方案区「更多 ▾ → 重新规划全部」。
          </p>
        )}

        {/* ② 生成方案：规划成功后才显示（规划前不显示空方案卡片） */}
        {showPlansSection && (
          <div ref={plansSectionRef}>
            <div className="bp-stage-head bp-stage-head-plans">
              <span className="bp-stage-title"><span className="bp-stage-no">2</span>生成方案（{plans.length}）</span>
              <span className="bp-stage-hint">1 个方案 = 1 张图片</span>
            </div>

            <div className="bp-plans-toolbar">
              <span className="bp-plans-count">当前方案：{plans.length} 个</span>
              <button
                className="settings-btn settings-btn-secondary settings-btn-sm"
                disabled={appendBusy || planning || plans.length >= MAX_PLAN_COUNT}
                onClick={() => setAppendChoiceOpen(true)}
              >
                {appendBusy ? 'AI 补充中…' : '+ 增加一个方案'}
              </button>
              <div className="bp-more-wrap">
                <button className="settings-btn settings-btn-secondary settings-btn-sm" onClick={() => setPlansMenuOpen(v => !v)}>更多 ▾</button>
                {plansMenuOpen && (
                  <div className="bp-more-menu">
                    <button
                      type="button"
                      disabled={planning || !batch.requirement.trim() || !optimizerModelLabel}
                      onClick={() => { setPlansMenuOpen(false); setConfirmKind('replan_all'); }}
                    >
                      重新规划全部
                    </button>
                    <button
                      type="button"
                      disabled={reoptAllBusy || planning || !optimizerModelLabel}
                      onClick={() => void reoptimizeAllPrompts()}
                    >
                      {reoptAllBusy ? '正在优化全部…' : '重新优化全部提示词'}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {planning && (
              <div className="bp-planning">
                <span className="bp-planning-status">AI 正在规划并优化 {skeletonCount} 个方案…</span>
                {Array.from({ length: skeletonCount }).map((_, i) => (
                  <div className="bp-skeleton-card" key={i}>
                    <span className="bp-skeleton-line w35" />
                    <span className="bp-skeleton-line w90" />
                    <span className="bp-skeleton-line w60" />
                  </div>
                ))}
              </div>
            )}

            {!planning && plans.map((plan, index) => (
              <BatchPlanCard
                key={plan.id}
                plan={plan}
                index={index}
                selected={drawerPlanId === plan.id}
                optimizerConfigured={!!optimizerModelLabel}
                onOpenDetail={() => setDrawerPlanId(plan.id)}
                onReoptimize={() => requestReoptimize(plan.id)}
                onAiFill={() => void aiFillPlan(plan.id)}
                onDelete={() => deletePlan(plan.id)}
              />
            ))}
          </div>
        )}

        {/* ③ 生成设置：所有方案共享 */}
        <div className="bp-stage-head bp-stage-head-settings">
          <span className="bp-stage-title"><span className="bp-stage-no">3</span>生成设置</span>
          <span className="bp-stage-hint">所有方案共享</span>
        </div>
        <OutputSettings
          size={size} onSize={setSize}
          quality={quality} onQuality={setQuality}
          format={format} onFormat={setFormat}
          outputDir={outputDir} onOutputDir={setOutputDir}
        />

        {/* ④ 生成摘要 + 提交 */}
        <div className="bp-stage-head bp-stage-head-summary">
          <span className="bp-stage-title"><span className="bp-stage-no">4</span>生成摘要</span>
        </div>
        <div className="bp-summary-grid">
          <div className="bp-summary-item">
            <div className="bp-summary-num">{plans.length}</div>
            <div className="bp-summary-label">生成方案（个）</div>
          </div>
          <div className="bp-summary-item">
            <div className="bp-summary-num">{readyCount}</div>
            <div className="bp-summary-label">已准备（个）</div>
          </div>
          <div className="bp-summary-item">
            <div className="bp-summary-num">{pendingCount}</div>
            <div className="bp-summary-label">待完善（个）</div>
          </div>
          <div className="bp-summary-item">
            <div className="bp-summary-num">{plans.length}</div>
            <div className="bp-summary-label">最终图片（张）</div>
          </div>
        </div>

        <div className="studio-submit-row">
          <button
            className="settings-btn settings-btn-primary studio-submit-btn"
            disabled={!canSubmit}
            onClick={() => void submitBatch()}
          >
            {submitting ? '提交中…' : `开始批量生成（${plans.length} 张）`}
          </button>
          <span className={`bp-submit-hint${pendingCount > 0 ? ' warn' : ''}`}>
            {plans.length === 0
              ? 'AI 规划生成方案后可开始批量生成'
              : pendingCount > 0
                ? `还有 ${pendingCount} 个方案尚未完善`
                : `${readyCount} 个方案已准备 · 共 ${plans.length} 张${anyOptimizing ? ' · 有方案正在 AI 优化' : ''}`}
          </span>
        </div>
      </section>
    );
  }

  return (
    <div className="page image-studio-page">
      <div className="page-header">
        <h2>图片生成</h2>
        <p>文生图 / 图生图 · 单张生成，或一个总需求由 AI 规划多方案批量生成（1 个方案 = 1 张图片）。</p>
      </div>

      <div className="studio-mode-bar">
        <div className="studio-mode-group">
          <span className="studio-mode-label">生成方式</span>
          <div className="studio-tabs">
            {([['t2i', '文生图'], ['i2i', '图生图']] as const).map(([key, label]) => (
              <button key={key} className={`studio-tab ${generationType === key ? 'active' : ''}`} onClick={() => setGenerationType(key)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="studio-mode-group">
          <span className="studio-mode-label">生成模式</span>
          <div className="studio-tabs">
            {([['single', '单张生成'], ['batch', '批量生成']] as const).map(([key, label]) => (
              <button key={key} className={`studio-tab ${generationMode === key ? 'active' : ''}`} onClick={() => setGenerationMode(key)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="studio-mode-group studio-mode-group-meta">
          <OptimizerModelNote label={optimizerModelLabel} />
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="studio-layout">
        <div className="studio-main">
          {isSingle ? renderSingle() : renderBatch()}
        </div>
        <RecentTasksPanel tasks={tasks} />
      </div>

      {/* ===== 方案详情抽屉（页面最外层 Overlay，不挤压最近任务布局） ===== */}
      {!isSingle && drawerPlan && (
        <BatchPlanDetailDrawer
          plan={drawerPlan}
          index={plans.findIndex(plan => plan.id === drawerPlan.id)}
          total={plans.length}
          optimizerConfigured={!!optimizerModelLabel}
          optimizerModelLabel={optimizerModelLabel}
          onClose={() => setDrawerPlanId(null)}
          onSave={patch => updatePlan(drawerPlan.id, patch)}
          onReoptimize={() => requestReoptimize(drawerPlan.id)}
          onDelete={() => deletePlan(drawerPlan.id)}
          onNavigate={navigateDrawer}
        />
      )}

      {/* ===== 新增方案选择（AI 补充 / 自己填写） ===== */}
      {!isSingle && appendChoiceOpen && (
        <div className="bp-confirm-overlay" onClick={() => setAppendChoiceOpen(false)}>
          <div className="bp-confirm" onClick={e => e.stopPropagation()}>
            <div className="bp-confirm-title">增加方案（当前 {plans.length} 个，已有方案不会变化）</div>
            <div className="bp-confirm-text">选择新增方式：</div>
            <div className="settings-actions-row" style={{ justifyContent: 'stretch', flexDirection: 'column', gap: 8 }}>
              <button
                className="settings-btn settings-btn-primary settings-btn-sm"
                disabled={appendBusy || !batch.requirement.trim() || !optimizerModelLabel}
                onClick={() => void appendAiPlanOne()}
              >
                {appendBusy ? 'AI 补充中…' : '✨ 根据总需求 AI 补充一个不同方案'}
              </button>
              <button className="settings-btn settings-btn-secondary settings-btn-sm" onClick={appendManualPlan}>
                ✏ 自己填写方案
              </button>
              <button className="settings-btn settings-btn-link settings-btn-sm" onClick={() => setAppendChoiceOpen(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 二次确认：重新规划全部 / 覆盖手动修改的重新优化 ===== */}
      {!isSingle && confirmKind === 'replan_all' && (
        <BpConfirmDialog
          title="重新规划全部方案"
          text={'重新规划全部方案会替换当前所有方案。\n\n已手动修改的方案内容也会被覆盖。\n\n是否继续？'}
          confirmLabel="重新规划"
          danger
          onCancel={() => setConfirmKind(null)}
          onConfirm={() => { setConfirmKind(null); void runPlanning(); }}
        />
      )}
      {!isSingle && confirmKind === 'reoptimize_plan' && reoptimizeTargetId && (
        <BpConfirmDialog
          title="重新优化会替换当前方案的 AI 提示词"
          text={'该方案已被手动修改，重新优化将覆盖：\n标题 / 摘要 / 标签 / 正向提示词 / 负面提示词。\n\n方案描述会保留。'}
          confirmLabel="继续"
          danger
          onCancel={() => { setConfirmKind(null); setReoptimizeTargetId(null); }}
          onConfirm={() => {
            const id = reoptimizeTargetId;
            setConfirmKind(null);
            setReoptimizeTargetId(null);
            if (id) void aiFillPlan(id);
          }}
        />
      )}
    </div>
  );
}
