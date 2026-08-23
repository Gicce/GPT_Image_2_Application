import { useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { api } from '../services/api';
import { toastError, toastInfo, toastSuccess, toastWarning } from '../components/Toast';
import { useAIProviderStore, resolveByokVisionConfig } from '../features/aiProviders/store';
import { getAvailableVisionModels, resolveModelSelectionOrFirst } from '../features/aiProviders/modelUsability';
import { useDraftStore } from '../store/useDraftStore';
import { useVisionWorkspaceStore } from '../store/useVisionWorkspaceStore';
import { compileReversePrompt, type PromptDialect } from '../features/vision/reversePrompt';
import {
  DEFAULT_SIMILARITY_WEIGHTS,
  SIMILARITY_DISCLAIMER,
  scoreToPercent,
} from '../features/vision/similarity';
import { applyRecreationCorrection, evaluateStopCondition } from '../features/vision/optimizer';
import { INVALID_IMAGE_DROP_TOAST, splitDroppedPaths } from '../utils/imageDropFiles';
import {
  clampRecreationConfig,
  runRecreationIteration,
  type RecreationStage,
} from '../features/vision/recreation';
import {
  applyModificationInstruction,
  applyOptimizationResult,
  buildGenerationCarry,
  buildRecreationPlan,
  canGenerateFromRecreation,
  describeRecreationStatus,
  hasSuccessfulPrompt,
  initialRecreationState,
  markOptimizationFailed,
  markOptimizing,
  markRecreationDirty,
  needsOptimization,
  revertToLastSuccessfulPrompt,
  togglePlanFieldLock,
  type RecreationState,
} from '../features/vision/recreationPlan';
import {
  buildModificationInstruction,
  clearPersonReplacement,
  EMPTY_MODIFICATION_DRAFT,
  isModificationDraftEmpty,
  personHasImage,
  setPersonReplacement,
  toggleModificationDimension,
  toggleReplicationBoost,
  type ModificationDraft,
  type ModificationDimension,
  type PersonReplacement,
} from '../features/vision/modificationIntent';
import { computePromptDiff, dimensionDiff } from '../features/vision/promptDiff';
import {
  ADJUST_INPUT,
  ADVANCED_SETTINGS,
  AI_PLAN,
  DIMENSION_LOCK,
  FINAL_PROMPT,
  EVALUATION_COPY,
  GENERATE_DIALOG,
  GENERATION_MODE,
  GENERATION_PARAMS,
  NO_USABLE_VISION_MODEL,
  OPTIMIZE_TOAST,
  REOPTIMIZE_ACTION,
  RESTART_ACTION,
  UNDERSTANDING,
  optimizeFailureMessage,
} from '../features/vision/recreationCopy';
import VisualAnalysisProgress from '../features/vision/VisualAnalysisProgress';
import ModificationChips from '../features/vision/ModificationChips';
import PersonReplacementPanel from '../features/vision/PersonReplacementPanel';
import {
  createVisionUnderstandingTask,
  markVisionTaskCompleted,
  markVisionTaskFailed,
  markVisionTaskRunning,
} from '../features/vision/visionTask';
import { optimizeVisionRecreation } from '../services/promptOptimizer';
import {
  listVisionSessions,
  saveVisionSession,
  similarityToSnapshot,
  type RecreationIterationRecord,
  type VisionMode,
  type VisionSession,
} from '../features/vision/session';
import { readEvaluationSettings, writeEvaluationSettings } from '../features/evaluation/evaluationSettings';
import VisionResultSection from '../features/evaluation/VisionResultSection';
import { useImageViewerStore } from '../store/useImageViewerStore';
import { useVisionViewStore } from '../store/useVisionViewStore';
import type { ImageMeta, ImageRecord } from '../types';
import { SIZES, QUALITIES, QUALITY_LABELS } from '../types';
import './VisionUnderstanding.css';

/** Gallery / 生成结果入口经 localStorage 带入原图路径（一次消费） */
const VISION_SOURCE_KEY = 'cy_vision_source_path';

/** 比例选项（与服务端 gpt-image-2 支持的尺寸一一对应，选比例即定尺寸） */
const RATIO_OPTIONS = [
  { value: '1:1', label: '1:1（方形）', size: '1024x1024' },
  { value: '16:9', label: '16:9（横向）', size: '1792x1024' },
  { value: '9:16', label: '9:16（纵向）', size: '1024x1792' },
] as const;

const COUNT_OPTIONS = [1, 2, 4] as const;

function ratioOfSize(size: string): string {
  return RATIO_OPTIONS.find(option => option.size === size)?.value ?? '';
}

type PageStage =
  | 'idle'
  | 'analyzing'
  | 'ready'
  | 'generating_candidate'
  | 'analyzing_candidate'
  | 'comparing'
  | 'scoring'
  | 'failed';

const STAGE_LABELS: Record<PageStage, string> = {
  idle: '',
  analyzing: '正在分析参考图…',
  ready: '',
  generating_candidate: '正在生成复刻候选图…',
  analyzing_candidate: '正在分析候选图…',
  comparing: '正在比较两张图片…',
  scoring: '正在汇总相似度评分…',
  failed: '',
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function aspectRatio(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(width, height) || 1;
  return `${Math.round(width / g)}:${Math.round(height / g)}`;
}

function dialectForGenerationModel(): PromptDialect {
  // V4 服务端唯一生成模型为 gpt-image-2（GPT Image 系自然语言长句偏好）
  return 'gpt_image';
}

/** 参考图来源标签（本地导入 / 图库 / 拖入），不常驻完整路径（路径进 tooltip）。 */
function describeSource(assetId?: string): string {
  return assetId ? '图片库' : '本地图片';
}

export default function VisionUnderstanding() {
  // ===== 工作区持久化状态（页面切换 / 卸载 / 重启均恢复；恢复绝不重调视觉 API） =====
  const ws = useVisionWorkspaceStore();
  const {
    sourcePath,
    sourceAssetId,
    profileId: selectedProfileId,
    modelId: selectedModelId,
    mode,
    stage,
    errorText,
    analysis,
    reverseResult,
    promptDraft,
    negativeDraft,
    report,
    iterations,
    sessionId,
    visionTaskId,
    recreation,
    originalPromptDraft,
    modificationDraft,
    genParams,
    generationMode,
  } = ws;

  // ===== View State（折叠 / Tab 等纯 UI 状态；与语义状态物理隔离，绝不触发 dirty） =====
  const view = useVisionViewStore();
  const { dimensionsCollapsed, advancedCollapsed, analysisDetailCollapsed, promptView } = view;

  // ===== 仅进程内 UI 状态（预览图 / 弹层 / 轮询细节，不持久化） =====
  const [previewUrl, setPreviewUrl] = useState('');
  const [meta, setMeta] = useState<ImageMeta | null>(null);
  /** 图库弹层用途：source = 更换参考图；person = 选择人物替换参考图。 */
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryPurpose, setGalleryPurpose] = useState<'source' | 'person'>('source');
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [galleryUrls, setGalleryUrls] = useState<Record<string, string>>({});
  const [autoEvaluate, setAutoEvaluate] = useState(() => readEvaluationSettings().autoEvaluate);
  const [generateConfirmOpen, setGenerateConfirmOpen] = useState(false);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cancelRef = useRef(false);
  const intentInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [running, setRunning] = useState(false);
  const [stageDetail, setStageDetail] = useState('');

  // ===== 模型与模式（模型中心是唯一事实源：可用性 + 视觉能力均从模型数据判定） =====
  const profiles = useAIProviderStore(s => s.profiles);
  const modelOptions = useMemo(() => getAvailableVisionModels(profiles), [profiles]);
  const selectedOption = useMemo(
    () => modelOptions.find(option => option.profileId === selectedProfileId && option.modelId === selectedModelId) ?? null,
    [modelOptions, selectedProfileId, selectedModelId],
  );

  /**
   * 模型选择守卫：恢复的选择已失效（模型删除/禁用/测试失败/Provider 停用/无视觉能力）
   * → 回落到可用列表第一个；无任何可用模型 → 置空（禁止恢复失效模型 ID，禁止硬编码兜底）。
   * 模型中心任何增删/启停/测试/能力变化经 Zustand 响应式即时反映。
   */
  useEffect(() => {
    const next = resolveModelSelectionOrFirst(
      { profileId: selectedProfileId, modelId: selectedModelId },
      modelOptions,
    );
    if (next.profileId !== selectedProfileId || next.modelId !== selectedModelId) {
      ws.setModelSelection(next.profileId, next.modelId);
    }
  }, [modelOptions, selectedProfileId, selectedModelId, ws]);

  const setVisionConfig = (profileId: string, modelId: string) => {
    ws.setModelSelection(profileId, modelId);
  };

  const goConfigure = () => {
    localStorage.setItem('cy_settings_section', 'vision');
    window.dispatchEvent(new CustomEvent('cy-settings-section'));
    window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'settings' } }));
  };

  // ===== 参考图预览（仅本地缩略图 / 元信息读取，绝不触发视觉理解 API） =====
  useEffect(() => {
    let cancelled = false;
    if (!sourcePath) {
      setPreviewUrl('');
      setMeta(null);
      return;
    }
    void (async () => {
      try {
        const [thumb, metaInfo] = await Promise.all([
          api.readThumbnail(sourcePath),
          api.getImageMeta(sourcePath),
        ]);
        if (cancelled) return;
        setPreviewUrl(thumb);
        setMeta(metaInfo);
      } catch {
        if (!cancelled) {
          setPreviewUrl('');
          setMeta(null);
          toastError('参考图读取失败，请重新选择图片');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [sourcePath]);

  // Gallery 入口（localStorage 一次消费）
  useEffect(() => {
    try {
      const stored = localStorage.getItem(VISION_SOURCE_KEY);
      if (stored) {
        localStorage.removeItem(VISION_SOURCE_KEY);
        useVisionWorkspaceStore.getState().setSource(stored);
      }
    } catch { /* 忽略 */ }
    void (async () => { try { setImages(await api.getImages()); } catch { /* 图库不可用不阻塞 */ } })();
  }, []);

  // 卸载时冲刷防抖中的文本持久化
  useEffect(() => () => { useVisionWorkspaceStore.getState().flushPendingPersist(); }, []);

  // 拖拽（Tauri webview 原生事件，直接给本地路径；解析统一走 imageDropFiles）
  useEffect(() => {
    const unlisten = getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return;
        const paths = (event.payload as { paths?: string[] }).paths || [];
        const { images, invalid } = splitDroppedPaths(paths);
        if (images.length > 0) {
          useVisionWorkspaceStore.getState().setSource(images[0].path);
        }
        if (invalid.length > 0) toastError(INVALID_IMAGE_DROP_TOAST);
      })
      .catch(() => undefined);
    return () => { void unlisten.then(fn => fn?.()).catch(() => {}); };
  }, []);

  // 弹层打开时加载缩略图
  useEffect(() => {
    if (!galleryOpen || images.length === 0) return;
    let cancelled = false;
    const load = async () => {
      const urls: Record<string, string> = {};
      for (const img of images.slice(0, 60)) {
        try { urls[img.id] = await api.readThumbnail(img.local_path); } catch { /* 单图失败跳过 */ }
      }
      if (!cancelled) setGalleryUrls(urls);
    };
    void load();
    return () => { cancelled = true; };
  }, [galleryOpen, images]);

  /** 复刻工作台状态变化 → 同步落库会话（分析结果、优化结果、修改意图）。 */
  const persistRecreation = (next: RecreationState | null) => {
    const wstore = useVisionWorkspaceStore.getState();
    if (!wstore.sessionId) return;
    const sessions = listVisionSessions();
    const existing = sessions.find(s => s.id === wstore.sessionId);
    if (!existing) return;
    saveVisionSession({
      ...existing,
      recreation: next ?? undefined,
      visionTaskId: wstore.visionTaskId || undefined,
      updatedAt: new Date().toISOString(),
    });
  };

  // ===== 分析 / 反向 Prompt（所有状态经 workspace store 落位：切页/卸载不丢） =====
  const runAnalysis = async () => {
    const wstore = useVisionWorkspaceStore.getState();
    if (!wstore.sourcePath) {
      toastError('请先添加参考图片');
      return;
    }
    const config = resolveByokVisionConfig({
      profileId: wstore.profileId || undefined,
      modelId: wstore.modelId || undefined,
    });
    if (!config.ok) {
      wstore.markStage(wstore.stage === 'ready' ? 'ready' : 'idle', config.error);
      return;
    }
    wstore.markStage('analyzing', '');

    // 视觉理解任务进入任务体系：创建（pending）→ running；失败不阻塞分析
    const visionTask = await createVisionUnderstandingTask({
      sourcePath: wstore.sourcePath,
      modelId: config.model,
      mode: wstore.mode,
    });
    const taskId = visionTask?.id ?? '';
    wstore.setVisionTaskId(taskId);
    if (taskId) void markVisionTaskRunning(taskId);

    try {
      const result = await api.visionAnalyzeImage({
        imagePath: wstore.sourcePath,
        baseUrl: config.baseUrl,
        token: config.token,
        model: config.model,
        mode: wstore.mode === 'quick' ? 'quick' : 'reverse_prompt',
      });
      if (!result.ok || !result.analysis) {
        const message = result.error_message || '结构化分析返回格式无效';
        useVisionWorkspaceStore.getState().markStage('failed', `视觉理解失败：${message}`);
        if (taskId) void markVisionTaskFailed(taskId, message);
        return;
      }
      const compiled = compileReversePrompt(result.analysis, dialectForGenerationModel());
      // 结构化复刻方案 + 初始状态（未修改 = ready，不空跑优化）
      const nextRecreation = initialRecreationState(
        buildRecreationPlan(result.analysis),
        compiled.prompt,
        compiled.negativePrompt,
      );
      // 生成参数默认值 = 视觉模型推荐值（用户可改；非法/缺失回落默认档）
      const nextGenParams = {
        size: (SIZES as readonly string[]).includes(compiled.recommended.size ?? '')
          ? compiled.recommended.size!
          : '1024x1024',
        quality: (QUALITIES as readonly string[]).includes(compiled.recommended.quality ?? '')
          ? compiled.recommended.quality!
          : 'auto',
        count: 1,
      };
      const now = new Date().toISOString();
      const newSessionId = wstore.sessionId || crypto.randomUUID();
      useVisionWorkspaceStore.getState().applyAnalysis({
        analysis: result.analysis,
        reverseResult: compiled,
        recreation: nextRecreation,
        genParams: nextGenParams,
        visionProfileId: config.profileId,
        visionModelId: config.model,
        visionTaskId: taskId,
        sessionId: newSessionId,
      });
      const session: VisionSession = {
        id: newSessionId,
        sourceAssetId: wstore.sourceAssetId,
        sourcePath: wstore.sourcePath,
        visionProfileId: config.profileId,
        visionModelId: config.model,
        mode: wstore.mode,
        analysis: result.analysis,
        reversePrompt: {
          prompt: compiled.prompt,
          negativePrompt: compiled.negativePrompt,
          recommended: compiled.recommended,
        },
        recreation: nextRecreation,
        visionTaskId: taskId || undefined,
        iterations: [],
        createdAt: now,
        updatedAt: now,
      };
      saveVisionSession(session);
      if (taskId) {
        void markVisionTaskCompleted(taskId, result.analysis.summary, config.model);
      }
      if (compiled.warnings.length > 0 && wstore.mode !== 'quick') {
        toastSuccess(`分析完成（${compiled.warnings.length} 条风险提示）`);
      } else {
        toastSuccess('分析完成');
      }
    } catch (err: any) {
      const message = err?.message || err?.toString() || '视觉模型请求失败';
      useVisionWorkspaceStore.getState().markStage('failed', `视觉理解失败：${message}`);
      if (taskId) void markVisionTaskFailed(taskId, message);
    }
  };

  /**
   * 「确认生成图片」：先过 canGenerateFromRecreation 守卫（dirty 拦截并提示先优化），
   * 通过后弹确认层（来源 / 操作摘要 / 不会重复优化），再携带现成最终 Prompt 进入
   * 图片工作室 —— 绝不在生成前再执行一次 Prompt 优化。
   */
  const openGenerateConfirm = () => {
    const readiness = canGenerateFromRecreation(recreation);
    if (!readiness.allowed) {
      toastWarning(readiness.reason, '暂时不能生成');
      return;
    }
    setGenerateConfirmOpen(true);
  };

  const intentSummary = useMemo(() => {
    const instruction = recreation?.adjustInstruction?.trim();
    return instruction ? `修改意图 → ${instruction.slice(0, 80)}${instruction.length > 80 ? '…' : ''}` : '未修改，直接复刻参考图方案';
  }, [recreation]);

  const generateFromPlan = () => {
    const readiness = canGenerateFromRecreation(recreation);
    if (!readiness.allowed) {
      toastError(readiness.reason, '暂时不能生成');
      return;
    }
    if (!promptDraft.trim()) {
      toastError('当前缺少可用于生图的最终 Prompt，请先执行提示词优化。', '暂时不能生成');
      return;
    }
    const personPath = personHasImage(modificationDraft.person) ? modificationDraft.person!.path : undefined;
    const carry = buildGenerationCarry(
      {
        ...recreation!,
        optimizedPrompt: promptDraft.trim(),
        optimizedNegativePrompt: negativeDraft.trim(),
      },
      {
        sourceVisionSessionId: sessionId || undefined,
        sourceVisionTaskId: visionTaskId || undefined,
        size: genParams.size,
        quality: genParams.quality,
        count: genParams.count,
        generationMode,
        sourceImagePath: sourcePath || undefined,
        sourceAssetId: sourceAssetId || undefined,
        personReferencePath: personPath || undefined,
      },
    );
    useDraftStore.getState().setVisionCarry(carry);
    setGenerateConfirmOpen(false);
    window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'imagestudio' } }));
  };

  // ===== 修改意图（核心操作区：自由文本 + 快捷维度 + 人物替换 + 服装策略）=====

  /**
   * 结构化修改意图变更唯一入口：
   *  - draft 落 workspace（文本输入走防抖持久化）；
   *  - 合成指令落 recreation（真实语义修改 → semanticRevision +1；纯 UI 不经过这里）；
   *  - 合成指令为空时按修订模型归一（绝不空指令卡死在 dirty）。
   */
  const commitModificationDraft = (nextDraft: ModificationDraft, opts?: { debounce?: boolean }) => {
    const wstore = useVisionWorkspaceStore.getState();
    wstore.setModificationDraft(nextDraft, opts);
    if (!wstore.recreation || wstore.recreation.editState === 'optimizing') return;
    const instruction = buildModificationInstruction(nextDraft);
    const nextRecreation = applyModificationInstruction(wstore.recreation, instruction);
    wstore.setRecreation(nextRecreation, { debounce: opts?.debounce === true });
    persistRecreation(nextRecreation);
  };

  /** 自由文本输入（textarea）：只改 freeText，不动结构化意图。 */
  const onFreeTextChange = (value: string) => {
    commitModificationDraft(
      { ...useVisionWorkspaceStore.getState().modificationDraft, freeText: value },
      { debounce: true },
    );
  };

  /** 快捷维度 Chip toggle：唯一槽位（重复点击 = 取消），绝不向 textarea 追加文本。 */
  const onToggleDimensionChip = (key: ModificationDimension) => {
    const current = useVisionWorkspaceStore.getState().modificationDraft;
    commitModificationDraft(toggleModificationDimension(current, key));
  };

  /** 「提高复刻度」toggle：独立复刻强度偏好，不占维度槽位。 */
  const onToggleBoostChip = () => {
    const current = useVisionWorkspaceStore.getState().modificationDraft;
    commitModificationDraft(toggleReplicationBoost(current));
  };

  /** 人物替换数据变更（参考图 / 文字描述）。 */
  const onPersonChange = (person: PersonReplacement | null) => {
    const current = useVisionWorkspaceStore.getState().modificationDraft;
    commitModificationDraft(setPersonReplacement(current, person));
  };

  /** 服装策略 / 自定义服装变更。 */
  const onClothingPolicyChange = (policy: ModificationDraft['clothingPolicy']) => {
    const current = useVisionWorkspaceStore.getState().modificationDraft;
    commitModificationDraft({ ...current, clothingPolicy: policy });
  };

  const onCustomClothingChange = (text: string) => {
    const current = useVisionWorkspaceStore.getState().modificationDraft;
    commitModificationDraft({ ...current, customClothing: text }, { debounce: true });
  };

  /** 「移除人物替换」：删除人物参考与 subject 结构化意图，不影响其它维度与自由文本。 */
  const onRemovePersonReplacement = () => {
    const current = useVisionWorkspaceStore.getState().modificationDraft;
    commitModificationDraft(clearPersonReplacement(current));
  };

  /** 人物参考图选择入口。 */
  const pickPersonFromGallery = () => {
    setGalleryPurpose('person');
    setGalleryOpen(true);
  };

  const pickPersonFromLocal = async () => {
    const file = await api.selectImageFile();
    if (!file) return;
    onPersonChange({
      source: 'local',
      path: file,
      label: file.split(/[\\/]/).pop(),
    });
  };

  /** 反馈闭环回填：把上一轮评价 + 用户反馈组装进自由文本（只填充，不自动优化）。 */
  const continueAdjustFromResult = (instruction: string) => {
    const current = useVisionWorkspaceStore.getState().modificationDraft;
    const merged = current.freeText.trim()
      ? `${current.freeText.replace(/\s+$/, '')}\n${instruction}`
      : instruction;
    commitModificationDraft({ ...current, freeText: merged }, { debounce: true });
    requestAnimationFrame(() => {
      const el = intentInputRef.current;
      if (el) el.focus();
    });
  };

  const toggleFieldLock = (key: Parameters<typeof togglePlanFieldLock>[1]) => {
    if (!recreation) return;
    const next = togglePlanFieldLock(recreation, key);
    ws.setRecreation(next);
    persistRecreation(next);
  };

  /**
   * 「使用上一次 Prompt」：放弃当前待优化 / 失败的修改，整体回退到最近一次成功的
   * 最终 Prompt（工作区 promptDraft / negativeDraft / 修改意图草稿同步复位）。
   */
  const useLastSuccessfulPrompt = () => {
    const wstore = useVisionWorkspaceStore.getState();
    if (!wstore.recreation) return;
    const next = revertToLastSuccessfulPrompt(wstore.recreation);
    wstore.setRecreation(next);
    wstore.setPromptDraft(next.optimizedPrompt ?? '');
    wstore.setNegativeDraft(next.optimizedNegativePrompt ?? '');
    wstore.setModificationDraft({ ...EMPTY_MODIFICATION_DRAFT });
    persistRecreation(next);
    toastSuccess(FINAL_PROMPT.useLastToast);
  };

  /** 手动编辑原始复刻 Prompt = 结构化修改 → 需要重新优化。 */
  const editOriginalPrompt = (value: string) => {
    const wstore = useVisionWorkspaceStore.getState();
    wstore.setOriginalPromptDraft(value);
    if (!wstore.recreation || wstore.recreation.editState === 'optimizing') return;
    if (value.trim() === wstore.recreation.originalPrompt.trim()) return;
    wstore.setRecreation({ ...markRecreationDirty(wstore.recreation), originalPrompt: value }, { debounce: true });
  };

  /**
   * 「优化复刻 Prompt」：dirty → optimizing → optimized（失败回 dirty 并标记失败原因）；
   * 「重新优化」（force=true）：基于当前图片 + 分析结果 + 修改意图强制再执行一次
   * （会再次调用 AI 消耗 Token）；失败时旧结果原样保留，成功后才替换。
   * 优化输入 = 自由文本 + 快捷维度 + 人物替换 + 服装策略的合成指令（结构化意图可不依赖自由文本）。
   */
  const optimizeRecreationPrompt = async (force = false) => {
    const wstore = useVisionWorkspaceStore.getState();
    const current = wstore.recreation;
    if (!current) return;
    if (current.editState === 'optimizing') return;
    if (!force && !needsOptimization(current)) {
      toastInfo(OPTIMIZE_TOAST.idleGuard, '无需重复优化');
      return;
    }
    const instruction = buildModificationInstruction(wstore.modificationDraft);
    if (!instruction.trim()) {
      toastInfo(force ? REOPTIMIZE_ACTION.emptyInstruction : OPTIMIZE_TOAST.emptyInstruction, '请先输入修改要求');
      return;
    }
    const optimizingState = markOptimizing({
      ...current,
      originalPrompt: wstore.originalPromptDraft,
      adjustInstruction: instruction.trim(),
    });
    wstore.setRecreation(optimizingState);
    let outcome: Awaited<ReturnType<typeof optimizeVisionRecreation>>;
    try {
      outcome = await optimizeVisionRecreation({
        originalRecreationPrompt: wstore.originalPromptDraft,
        structuredRecreationPlan: optimizingState.plan,
        userAdjustmentInstruction: optimizingState.adjustInstruction,
        targetImageModelInfo: 'gpt-image-2（GPT Image 系，自然语言长句偏好）',
        originalNegativePrompt: current.originalNegativePrompt,
      });
    } catch (error: any) {
      // 服务层异常兜底：绝不把状态永远留在 optimizing
      outcome = { ok: false, kind: 'request_failed', error: error?.message || '提示词优化请求失败，请重试。' };
    }
    if (!outcome.ok) {
      // 失败：optimizedPrompt / promptDraft 均不改动（旧结果保留），状态回 dirty 并记录原因
      const reverted = markOptimizationFailed(optimizingState, outcome.error);
      useVisionWorkspaceStore.getState().setRecreation(reverted);
      persistRecreation(reverted);
      toastError(optimizeFailureMessage(outcome.error), force ? '重新优化失败' : '优化失败');
      return;
    }
    const next = applyOptimizationResult(optimizingState, outcome.result);
    const latest = useVisionWorkspaceStore.getState();
    latest.setRecreation(next);
    latest.setPromptDraft(next.optimizedPrompt ?? '');
    latest.setNegativeDraft(next.optimizedNegativePrompt ?? '');
    persistRecreation(next);
    toastSuccess(OPTIMIZE_TOAST.success, force ? '重新优化完成' : '优化完成');
  };

  const toggleAutoEvaluate = (enabled: boolean) => {
    setAutoEvaluate(enabled);
    writeEvaluationSettings({ autoEvaluate: enabled });
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toastSuccess(`${label}已复制`);
    } catch {
      toastError('复制失败');
    }
  };

  /** 「重新开始」：确认后清空当前工作区（不动历史任务 / 会话记录 / 已生成图片 / 素材库）。 */
  const restartWorkspace = () => {
    useVisionWorkspaceStore.getState().reset();
    useVisionViewStore.getState().reset();
    setRestartConfirmOpen(false);
    setGenerateConfirmOpen(false);
    setConfirmOpen(false);
    setGalleryOpen(false);
    cancelRef.current = true;
    setRunning(false);
    setStageDetail('');
  };

  // ===== 高复刻循环 =====
  const startHighFidelity = async () => {
    const wstore = useVisionWorkspaceStore.getState();
    if (!wstore.sourcePath || !wstore.analysis) {
      toastError('请先完成参考图分析');
      return;
    }
    const config = resolveByokVisionConfig({
      profileId: wstore.profileId || undefined,
      modelId: wstore.modelId || undefined,
    });
    if (!config.ok) {
      toastError(config.error);
      return;
    }
    setConfirmOpen(false);
    cancelRef.current = false;
    setRunning(true);
    useVisionWorkspaceStore.getState().markStage('ready', '');

    const settings = await api.getSettings().catch(() => null);
    const outputDir = settings?.default_output_dir?.trim() || wstore.sourcePath.replace(/[\\/][^\\/]+$/, '');
    const configClamped = clampRecreationConfig({
      targetScore: wstore.hfTarget,
      maxIterations: wstore.hfMaxIterations,
    });

    let currentPrompt = wstore.promptDraft.trim();
    let currentNegative = wstore.negativeDraft.trim();
    let previousScore: number | null = null;
    const collected: RecreationIterationRecord[] = [];

    const onStage = (recreationStage: RecreationStage, detail?: string) => {
      const map: Record<RecreationStage, PageStage | null> = {
        idle: null,
        generating_candidate: 'generating_candidate',
        analyzing_candidate: 'analyzing_candidate',
        comparing: 'comparing',
        scoring: 'scoring',
        complete: 'ready',
        failed: 'failed',
      };
      const next = map[recreationStage];
      if (next) useVisionWorkspaceStore.getState().markStage(next);
      if (detail) setStageDetail(detail);
    };

    try {
      for (let attempt = 1; attempt <= configClamped.maxIterations; attempt++) {
        if (cancelRef.current) break;
        const result = await runRecreationIteration({
          vision: { baseUrl: config.baseUrl, token: config.token, model: config.model },
          sourcePath: wstore.sourcePath,
          sourceAnalysis: wstore.analysis,
          prompt: currentPrompt,
          negativePrompt: currentNegative,
          size: wstore.reverseResult?.recommended.size || settings?.default_size || '1024x1024',
          quality: wstore.reverseResult?.recommended.quality || settings?.default_quality || 'auto',
          outputFormat: settings?.default_format || 'png',
          outputDir,
          attempt,
          onStage,
          isCancelled: () => cancelRef.current,
        });

        if (!result.ok) {
          if (result.errorKind !== 'cancelled') {
            useVisionWorkspaceStore.getState().markStage('failed', `${result.error ?? '迭代失败'}（已生成 ${collected.length} 张候选图保留在任务队列与图库）`);
          }
          break;
        }

        const latestScore = result.report!.final_score;
        collected.push({
          attempt,
          candidatePath: result.candidatePath,
          prompt: currentPrompt,
          negativePrompt: currentNegative,
          similarity: similarityToSnapshot(result.report!),
        });
        useVisionWorkspaceStore.getState().setReportAndIterations(result.report!, [...collected]);

        const stop = evaluateStopCondition({
          latestScore,
          previousScore,
          targetScore: configClamped.targetScore,
          iteration: attempt,
          maxIterations: configClamped.maxIterations,
          minImprovement: configClamped.minImprovement,
        });
        if (stop.shouldStop) {
          toastSuccess(stop.message);
          break;
        }

        // Prompt 增量修正（只改差异，不整段重写）
        const optimization = applyRecreationCorrection(
          {
            prompt: currentPrompt,
            negativePrompt: currentNegative,
            sections: wstore.reverseResult?.sections ?? {
              subject: '', action: '', scene: '', composition: '', camera: '', lighting: '', color: '', material: '', style: '', detail: '',
            },
            recommended: wstore.reverseResult?.recommended ?? {},
            risks: wstore.reverseResult?.risks ?? [],
            warnings: [],
          },
          result.report!,
        );
        if (optimization.appliedCorrections.length > 0) {
          currentPrompt = optimization.prompt;
          currentNegative = optimization.negativePrompt;
          useVisionWorkspaceStore.getState().setPromptDraft(currentPrompt);
          useVisionWorkspaceStore.getState().setNegativeDraft(currentNegative);
          setStageDetail(`正在修正 Prompt（${optimization.appliedCorrections.length} 条差异）…`);
        }
        previousScore = latestScore;
      }
      const finalStage = useVisionWorkspaceStore.getState().stage;
      useVisionWorkspaceStore.getState().markStage(finalStage === 'failed' ? 'failed' : 'ready');
    } finally {
      setRunning(false);
      setStageDetail('');
      // 会话落库（含全部迭代）
      const latestSid = useVisionWorkspaceStore.getState().sessionId;
      if (latestSid && collected.length > 0) {
        const sessions = listVisionSessions();
        const existing = sessions.find(s => s.id === latestSid);
        if (existing) {
          saveVisionSession({
            ...existing,
            iterations: collected,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
  };

  const busy = stage === 'analyzing' || running;

  // ===== 复刻工作台派生展示（状态文案唯一来源：describeRecreationStatus） =====
  const planStatus = useMemo(() => describeRecreationStatus(recreation), [recreation]);
  const optimizing = recreation?.editState === 'optimizing';

  /** AI 生成方案的自然语言摘要：优化过 → 优化器 summary；未修改 → 原图方案直复刻。 */
  const planNarrative = useMemo(() => {
    if (!recreation) return '';
    if (recreation.summary?.trim()) return recreation.summary.trim();
    return `${AI_PLAN.readySummaryPrefix}：${recreation.plan.summary}`;
  }, [recreation]);

  // ===== 最终生图 Prompt（Prompt Provenance：显示值 === generateFromPlan 提交值） =====
  const finalPrompt = promptDraft.trim();

  /** 最终 Prompt 状态：failed（失败可回退）/ pending（待重新生成）/ manual（手动修改）/ generated（已生成）。 */
  const finalPromptStatus = useMemo<'generated' | 'pending' | 'failed' | 'manual'>(() => {
    if (!recreation) return 'generated';
    if (recreation.editState === 'dirty' && recreation.optimizeError) return 'failed';
    if (recreation.editState === 'dirty') return 'pending';
    // AI 产物与当前编辑值不一致 = 用户手动改过 FinalPromptEditor（不阻断生成）
    const aiPrompt = (recreation.optimizedPrompt ?? recreation.originalPrompt).trim();
    if (finalPrompt !== aiPrompt) return 'manual';
    return 'generated';
  }, [recreation, finalPrompt]);

  const finalPromptStatusText = finalPromptStatus === 'failed'
    ? (hasSuccessfulPrompt(recreation) ? `${FINAL_PROMPT.statusFailed} · ${FINAL_PROMPT.statusFailedFallback}` : FINAL_PROMPT.statusFailed)
    : finalPromptStatus === 'pending'
      ? FINAL_PROMPT.statusDirty
      : finalPromptStatus === 'manual'
        ? FINAL_PROMPT.statusManual
        : FINAL_PROMPT.statusReady;

  /** 全文 Diff：原始复刻 Prompt → 最终生图 Prompt（「查看修改对比」）。 */
  const fullPromptDiff = useMemo(
    () => computePromptDiff(recreation?.originalPrompt ?? '', finalPrompt),
    [recreation?.originalPrompt, finalPrompt],
  );
  const promptChanged = fullPromptDiff.addedCount > 0 || fullPromptDiff.removedCount > 0;

  /** 维度 Diff（维度卡原 / 新对比；只统计有原始值且发生变化的维度）。 */
  const changedFieldKeys = useMemo(() => {
    if (!recreation) return [];
    return recreation.plan.fields
      .filter(field => dimensionDiff(field.originalValue, field.value).changed)
      .map(field => field.key);
  }, [recreation]);
  const showUseLastPrompt = !!recreation
    && recreation.editState === 'dirty'
    && hasSuccessfulPrompt(recreation);

  const lockedCount = recreation?.plan.fields.filter(f => f.locked).length ?? 0;
  const unlockedCount = recreation ? recreation.plan.fields.length - lockedCount : 0;

  return (
    <div className="page vision-page">
      <div className="page-header vision-page-header">
        <div>
          <h2>视觉理解</h2>
          <p>理解原图 → 告诉 AI 怎么改 → 生成新图：AI 自动评价每一张结果，不满意就继续调整。</p>
        </div>
        {(sourcePath || analysis) && (
          <button
            className="vision-btn vision-btn-danger"
            title="清空当前工作区（图片、分析结果与全部 Prompt），开始新的视觉理解任务"
            onClick={() => setRestartConfirmOpen(true)}
          >
            {RESTART_ACTION.label}
          </button>
        )}
      </div>

      {/* ===== 1. 原图（Preview + 尺寸 + 来源 + 更换；路径只进 tooltip） ===== */}
      <section className="vision-card vision-source">
        {previewUrl ? (
          <div className="vision-source-loaded">
            <img
              className="vision-source-img"
              src={previewUrl}
              alt="参考图"
              title="点击在内置图片查看器中查看"
              onClick={() => useImageViewerStore.getState().openViewer([{
                id: sourcePath,
                path: sourcePath,
                title: '参考图',
                width: meta?.width,
                height: meta?.height,
                fileName: sourcePath.split(/[\\/]/).pop(),
                metadata: [{ label: '来源', value: describeSource(sourceAssetId) }],
              }])}
            />
            <div className="vision-source-meta">
              <p>
                {meta ? `${meta.width} × ${meta.height} · ${aspectRatio(meta.width, meta.height)} · ${formatBytes(meta.file_size)}` : '读取元信息中…'}
                <span className="vision-source-kind">{describeSource(sourceAssetId)}</span>
              </p>
              <div className="vision-source-actions">
                <button className="vision-btn" onClick={() => { setGalleryPurpose('source'); setGalleryOpen(true); }}>更换图片</button>
                <button className="vision-btn" onClick={() => void api.openFolder(sourcePath.replace(/[\\/][^\\/]+$/, ''))} title={sourcePath}>打开所在目录</button>
                <button className="vision-btn" onClick={() => useVisionWorkspaceStore.getState().removeSource()}>移除图片</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="vision-dropzone">
            <p className="vision-dropzone-title">拖入图片，或选择来源</p>
            <div className="vision-dropzone-actions">
              <button className="vision-btn vision-btn-primary" onClick={async () => {
                const file = await api.selectImageFile();
                if (file) useVisionWorkspaceStore.getState().setSource(file);
              }}>本地选择</button>
              <button className="vision-btn" onClick={() => { setGalleryPurpose('source'); setGalleryOpen(true); }}>从图片库选择</button>
            </div>
            <p className="vision-hint">支持 PNG / JPEG / WebP；图片将直接发送给你配置的视觉模型服务（不会上传任何图床）。</p>
          </div>
        )}
      </section>

      {/* ===== 分析前：主入口（模型 / 模式细节在高级设置） ===== */}
      {!analysis && (
        <section className="vision-card vision-start">
          {modelOptions.length > 0 ? (
            <>
              <p className="vision-start-model">视觉模型：{selectedOption?.profileName ?? '—'} / {selectedOption?.displayName ?? selectedModelId ?? '—'}</p>
              <button
                className="vision-btn vision-btn-primary vision-btn-lg"
                onClick={runAnalysis}
                disabled={busy || !sourcePath}
              >
                {stage === 'analyzing' ? '正在理解…' : '开始理解这张图片'}
              </button>
            </>
          ) : (
            <div className="vision-no-model">
              <span>{NO_USABLE_VISION_MODEL}</span>
              <button className="vision-btn" onClick={goConfigure}>前往模型管理</button>
            </div>
          )}
        </section>
      )}

      {errorText && (
        <section className="vision-card vision-error">
          <p>{errorText}</p>
        </section>
      )}

      {/* 视觉理解分析阶段：参考图缩略图 + 创意文案轮播 + 轻量扫描反馈（失败态由 errorText 卡片呈现，轮播随卸载停止） */}
      {stage === 'analyzing' && (
        <VisualAnalysisProgress
          thumbUrl={previewUrl}
          modelLabel={selectedOption ? `${selectedOption.profileName} / ${selectedOption.displayName}` : (selectedModelId || '—')}
        />
      )}

      {(stageDetail || STAGE_LABELS[stage]) && busy && stage !== 'analyzing' && (
        <section className="vision-card vision-stage">
          <span className="vision-spinner" />
          <p>{stageDetail || STAGE_LABELS[stage]}</p>
        </section>
      )}

      {/* ===== 2. AI 理解（summary 常驻；详细分析默认折叠） ===== */}
      {analysis && (
        <section className="vision-card vision-understanding">
          <div className="vision-understanding-head">
            <div>
              <h3>{UNDERSTANDING.title}</h3>
              <p className="vision-understanding-summary">{analysis.summary}</p>
            </div>
            <button className="vision-section-toggle" onClick={() => view.toggleAnalysisDetail()}>
              {analysisDetailCollapsed ? `▸ ${UNDERSTANDING.detailToggle}` : `▾ ${UNDERSTANDING.detailToggle}`}
            </button>
          </div>
          {!analysisDetailCollapsed && (
            <div className="vision-analysis">
              {analysis.subjects.length > 0 && (
                <div>
                  <strong>主体</strong>
                  <ul>
                    {analysis.subjects.map((s, i) => (
                      <li key={i}>
                        {s.count && s.count > 1 ? `${s.count} × ` : ''}{s.label}
                        {s.appearance?.length ? `（${s.appearance.join('、')}）` : ''}
                        {s.pose ? ` · 姿势：${s.pose}` : ''}
                        {s.position ? ` · 位置：x=${s.position.x.toFixed(2)} y=${s.position.y.toFixed(2)} w=${s.position.width.toFixed(2)} h=${s.position.height.toFixed(2)}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="vision-analysis-grid">
                {analysis.scene.environment && <p><strong>场景：</strong>{[analysis.scene.environment, analysis.scene.location, analysis.scene.time_of_day].filter(Boolean).join('，')}</p>}
                {analysis.composition.subject_placement && <p><strong>构图：</strong>{analysis.composition.subject_placement}{analysis.composition.symmetry ? `（${analysis.composition.symmetry}）` : ''}</p>}
                {analysis.camera.shot_type && <p><strong>镜头：</strong>{[analysis.camera.shot_type, analysis.camera.angle, analysis.camera.depth_of_field].filter(Boolean).join('，')}</p>}
                {analysis.lighting.source && <p><strong>光线：</strong>{[analysis.lighting.source, analysis.lighting.direction, analysis.lighting.softness].filter(Boolean).join('，')}</p>}
                {analysis.colors.dominant_palette?.length > 0 && <p><strong>色彩：</strong>{analysis.colors.dominant_palette.join(' ')}（{analysis.colors.temperature}）</p>}
                {analysis.style.category && <p><strong>风格：</strong>{[analysis.style.category, analysis.style.medium, analysis.style.rendering].filter(Boolean).join('，')}</p>}
                {analysis.text_elements.length > 0 && (
                  <p><strong>文字：</strong>{analysis.text_elements.map(t => `「${t.content}」`).join(' ')}</p>
                )}
              </div>
              {reverseResult && reverseResult.warnings.length > 0 && (
                <div className="vision-warnings">
                  <strong>风险提示</strong>
                  <ul>{reverseResult.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* ===== 复刻工作台：理解任务 → 修改意图 → Prompt 优化 → 生图 ===== */}
      {reverseResult && (
        <>
          {visionTaskId && (
            <section className="vision-card vision-task-banner">
              <span className="vision-task-type">视觉理解任务</span>
              <span className="vision-task-id">#{visionTaskId.slice(0, 8)}</span>
              <span className="vision-task-desc">已理解参考图并生成可复刻方案；输入修改意图后由 AI 重新优化生成方案。</span>
            </section>
          )}

          {/* ===== 3. 修改意图（核心操作区：自由文本 + 结构化维度选择器） ===== */}
          {recreation && (
            <section className="vision-card vision-intent">
              <div className="vision-adjust-box">
                <label className="vision-adjust-label" htmlFor="vision-adjust-input">{ADJUST_INPUT.title}</label>
                <p className="vision-adjust-desc">{ADJUST_INPUT.desc}</p>
                <textarea
                  id="vision-adjust-input"
                  ref={intentInputRef}
                  className="vision-adjust-textarea"
                  rows={4}
                  value={modificationDraft.freeText}
                  disabled={busy || running || optimizing}
                  onChange={e => onFreeTextChange(e.target.value)}
                  placeholder={ADJUST_INPUT.placeholder}
                />
                <ModificationChips
                  draft={modificationDraft}
                  disabled={busy || running || optimizing}
                  onToggleDimension={onToggleDimensionChip}
                  onToggleBoost={onToggleBoostChip}
                />
                {modificationDraft.activeDimensions.includes('subject') && (
                  <PersonReplacementPanel
                    person={modificationDraft.person}
                    clothingPolicy={modificationDraft.clothingPolicy}
                    customClothing={modificationDraft.customClothing}
                    clothingDimensionActive={modificationDraft.activeDimensions.includes('clothing')}
                    disabled={busy || running || optimizing}
                    onPersonChange={onPersonChange}
                    onClothingPolicyChange={onClothingPolicyChange}
                    onCustomClothingChange={onCustomClothingChange}
                    onRemove={onRemovePersonReplacement}
                    onGalleryPick={pickPersonFromGallery}
                    onLocalPick={() => void pickPersonFromLocal()}
                  />
                )}
              </div>

              {/* 主状态栏（WorkflowStatusBanner）：状态点 + 标签 + 引导语；CTA 独立在 Banner 外 */}
              <div className="vision-status-row">
                <div className={`vision-status-bar tone-${planStatus.tone}`} role="status">
                  <span className="vision-status-dot" aria-hidden="true" />
                  <span className="vision-status-label">{planStatus.label}</span>
                  <span className="vision-status-note">{planStatus.note}</span>
                </div>
                {showUseLastPrompt && (
                  <button
                    className="vision-btn vision-btn-sm"
                    disabled={busy || running || optimizing}
                    onClick={useLastSuccessfulPrompt}
                    title="放弃当前待优化的修改，回退到最近一次成功的最终 Prompt"
                  >
                    {FINAL_PROMPT.useLastButton}
                  </button>
                )}
              </div>

              {/* 主操作：优化提示词 → 确认生成 */}
              <div className="vision-plan-actions">
                <span className="vision-plan-actions-spacer" />
                <button
                  className="vision-btn"
                  disabled={busy || running || optimizing}
                  title={REOPTIMIZE_ACTION.hint}
                  onClick={() => void optimizeRecreationPrompt(true)}
                >
                  {REOPTIMIZE_ACTION.label}
                </button>
                <button
                  className="vision-btn vision-btn-caution"
                  disabled={busy || running || optimizing}
                  onClick={() => void optimizeRecreationPrompt(false)}
                >
                  {optimizing ? '正在优化…' : '优化复刻 Prompt'}
                </button>
                <button
                  className="vision-btn vision-btn-primary"
                  disabled={busy || running || optimizing}
                  onClick={openGenerateConfirm}
                >
                  确认生成图片
                </button>
              </div>
            </section>
          )}

          {/* ===== 4. AI 生成方案（自然语言方案 + 最终生图 Prompt + 维度锁定 / 修改对比） ===== */}
          {recreation && (
            <section className="vision-card vision-plan">
              <div className="vision-prompt-head">
                <h3>{AI_PLAN.title}</h3>
                <div className="vision-prompt-head-actions">
                  <button
                    className="vision-btn"
                    disabled={busy || running || optimizing}
                    onClick={() => view.toggleDimensions()}
                  >
                    {dimensionsCollapsed ? `维度锁定（${AI_PLAN.lockedSummary} ${lockedCount} · ${AI_PLAN.unlockedSummary} ${unlockedCount}）` : '收起维度锁定'}
                  </button>
                </div>
              </div>
              <p className="vision-plan-narrative">{planNarrative}</p>

              {/* FinalPromptEditor：最终生图 Prompt 唯一查看 / 编辑 / Diff / 复制入口（禁止第二套 Prompt 编辑区） */}
              <div className={`vision-final-prompt status-${finalPromptStatus}`}>
                <div className="vision-final-head">
                  <span className="vision-final-title">{FINAL_PROMPT.title}</span>
                  <span className="vision-final-status">{finalPromptStatusText}</span>
                </div>
                <p className="vision-final-desc">{FINAL_PROMPT.desc}</p>
                <div className="vision-final-tabs" role="tablist" aria-label={FINAL_PROMPT.title}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={promptView === 'final'}
                    className={`vision-final-tab ${promptView === 'final' ? 'active' : ''}`}
                    onClick={() => view.setPromptView('final')}
                  >
                    {FINAL_PROMPT.tabFinal}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={promptView === 'diff'}
                    className={`vision-final-tab ${promptView === 'diff' ? 'active' : ''}`}
                    disabled={!promptChanged}
                    title={promptChanged ? FINAL_PROMPT.diffSubtitle : FINAL_PROMPT.diffEmpty}
                    onClick={() => view.setPromptView('diff')}
                  >
                    {FINAL_PROMPT.tabDiff}
                  </button>
                </div>

                {promptView === 'final' ? (
                  <>
                    <textarea
                      className="vision-final-editor"
                      aria-label={FINAL_PROMPT.title}
                      value={promptDraft}
                      disabled={busy || running || optimizing}
                      onChange={e => ws.setPromptDraft(e.target.value)}
                      rows={8}
                    />
                    <p className="vision-hint vision-final-editor-hint">{FINAL_PROMPT.editorHint}</p>
                  </>
                ) : (
                  <>
                    <p className="vision-diff-body">
                      {fullPromptDiff.segments.map((seg, i) =>
                        seg.type === 'equal' ? (
                          <span key={i} className="diff-seg">{seg.text}</span>
                        ) : seg.type === 'added' ? (
                          <span key={i} className="diff-seg diff-added" title={FINAL_PROMPT.diffAddedLabel}>+{seg.text}</span>
                        ) : (
                          <span key={i} className="diff-seg diff-removed" title={FINAL_PROMPT.diffRemovedLabel}>-{seg.text}</span>
                        ),
                      )}
                    </p>
                    <p className="vision-diff-legend">
                      <span className="diff-seg diff-added">+ {FINAL_PROMPT.diffAddedLabel}</span>
                      <span className="diff-seg diff-removed">- {FINAL_PROMPT.diffRemovedLabel}</span>
                      <span className="vision-hint">{FINAL_PROMPT.diffSubtitle} · ＋{fullPromptDiff.addedCount} · －{fullPromptDiff.removedCount}</span>
                    </p>
                  </>
                )}

                <div className="vision-final-actions">
                  <button
                    className="vision-btn vision-btn-sm"
                    disabled={!finalPrompt}
                    onClick={() => void copyText(finalPrompt, FINAL_PROMPT.copyLabel)}
                  >
                    {FINAL_PROMPT.copyLabel}
                  </button>
                </div>
              </div>

              {!dimensionsCollapsed && (
                <>
                  <div className="vision-plan-grid">
                    {recreation.plan.fields.map(field => {
                      const dimDiff = dimensionDiff(field.originalValue, field.value);
                      const isChanged = dimDiff.changed && !field.locked;
                      const manual = field.lockSource === 'user_override';
                      const badgeTitle = manual
                        ? `${DIMENSION_LOCK.userLabel}（重新优化不会覆盖）`
                        : DIMENSION_LOCK.aiLabel;
                      return (
                        <div key={field.key} className={`vision-plan-field ${isChanged ? 'is-changed' : ''}`}>
                          <div className="vision-plan-field-head">
                            <span className="vision-plan-field-label">{field.label}</span>
                            <button
                              type="button"
                              className={`vision-lock-badge ${isChanged ? 'is-changed' : field.locked ? 'is-locked' : 'is-unlocked'}`}
                              disabled={busy || running || optimizing}
                              onClick={() => toggleFieldLock(field.key)}
                              title={badgeTitle}
                            >
                              {isChanged ? DIMENSION_LOCK.changed : field.locked ? DIMENSION_LOCK.locked : DIMENSION_LOCK.unlocked}
                              {manual ? `·${DIMENSION_LOCK.manualSuffix}` : ''}
                            </button>
                          </div>
                          {isChanged ? (
                            <div className="vision-field-diff" title={`${DIMENSION_LOCK.oldValuePrefix}：${dimDiff.oldValue}\n${DIMENSION_LOCK.newValuePrefix}：${dimDiff.newValue}`}>
                              <p className="diff-seg diff-removed">-{DIMENSION_LOCK.oldValuePrefix}：{dimDiff.oldValue || '（未识别）'}</p>
                              <p className="diff-seg diff-added">+{DIMENSION_LOCK.newValuePrefix}：{dimDiff.newValue || '（未识别）'}</p>
                            </div>
                          ) : (
                            <p title={field.value}>{field.value || '（未识别）'}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <p className="vision-hint">
                    {changedFieldKeys.length > 0
                      ? DIMENSION_LOCK.intentHint
                      : DIMENSION_LOCK.pendingHint}
                  </p>
                </>
              )}

            </section>
          )}

          {/* ===== 5. 生成结果（Before / After + per-image AI 评价 + 继续调整） ===== */}
          {visionTaskId && sourcePath && (
            <VisionResultSection
              visionTaskId={visionTaskId}
              sourcePath={sourcePath}
              onContinueAdjust={continueAdjustFromResult}
            />
          )}

          {/* ===== 6. 高级设置（默认折叠：模型 / Prompt 细节 / 生成方式 / 参数 / 高复刻 / 自动评价） ===== */}
          <section className="vision-card vision-advanced">
            <button className="vision-section-toggle vision-advanced-toggle" onClick={() => view.toggleAdvanced()}>
              {advancedCollapsed ? `▸ ${ADVANCED_SETTINGS.title}` : `▾ ${ADVANCED_SETTINGS.title}`}
            </button>
            {!advancedCollapsed && (
              <div className="vision-advanced-body">
                {/* 模型与模式 */}
                <div className="vision-config-row">
                  <div className="vision-config-item vision-config-grow">
                    <label>视觉模型</label>
                    {modelOptions.length > 0 ? (
                      <select
                        value={`${selectedProfileId}|${selectedModelId}`}
                        onChange={e => {
                          const [profileId, modelId] = e.target.value.split('|');
                          setVisionConfig(profileId, modelId);
                        }}
                      >
                        {modelOptions.map(option => (
                          <option key={`${option.profileId}|${option.modelId}`} value={`${option.profileId}|${option.modelId}`}>
                            {option.profileName} / {option.displayName}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="vision-no-model">
                        <span>{NO_USABLE_VISION_MODEL}</span>
                        <button className="vision-btn" onClick={goConfigure}>前往模型管理</button>
                      </div>
                    )}
                  </div>
                  <div className="vision-config-item">
                    <label>模式</label>
                    <select value={mode} onChange={e => ws.setMode(e.target.value as VisionMode)} disabled={busy}>
                      <option value="quick">快速理解</option>
                      <option value="reverse_prompt">专业反向 Prompt</option>
                      <option value="high_fidelity">高复刻</option>
                    </select>
                  </div>
                  <button className="vision-btn" onClick={runAnalysis} disabled={busy || !sourcePath || modelOptions.length === 0}>
                    {stage === 'analyzing' ? '分析中…' : '重新分析'}
                  </button>
                </div>

                {/* 原始复刻 Prompt */}
                <div className="vision-advanced-block">
                  <div className="vision-prompt-head">
                    <h4>原始复刻 Prompt</h4>
                    <div className="vision-prompt-head-actions">
                      <button className="vision-btn" onClick={() => void copyText(originalPromptDraft, '原始 Prompt')}>复制</button>
                      <button className="vision-btn" onClick={() => editOriginalPrompt(reverseResult.prompt)}>重置</button>
                    </div>
                  </div>
                  <p className="vision-hint">来源于视觉模型分析，偏「描述事实」。手动编辑等同于修改复刻方案，需要重新优化。</p>
                  <textarea className="vision-prompt-textarea" value={originalPromptDraft} disabled={busy || running || optimizing} onChange={e => editOriginalPrompt(e.target.value)} rows={5} />
                </div>

                {/* Negative Prompt */}
                <div className="vision-advanced-block">
                  <div className="vision-prompt-head">
                    <h4>Negative Prompt</h4>
                    <div className="vision-prompt-head-actions">
                      <button className="vision-btn" onClick={() => void copyText(negativeDraft, '负面词')}>复制</button>
                      <button className="vision-btn" onClick={() => ws.setNegativeDraft(reverseResult.negativePrompt)}>重置</button>
                    </div>
                  </div>
                  <textarea className="vision-prompt-textarea" value={negativeDraft} onChange={e => ws.setNegativeDraft(e.target.value)} rows={3} />
                </div>

                {/* 生成方式（视觉复刻默认图生图） */}
                <div className="vision-advanced-block vision-genmode">
                  <h4>{GENERATION_MODE.title}</h4>
                  <div className="vision-genmode-row" role="radiogroup" aria-label={GENERATION_MODE.title}>
                    <button
                      type="button"
                      className={`vision-genmode-btn ${generationMode === 't2i' ? 'active' : ''}`}
                      role="radio"
                      aria-checked={generationMode === 't2i'}
                      disabled={busy || running || optimizing}
                      onClick={() => ws.setGenerationMode('t2i')}
                    >
                      <span className="vision-genmode-label">{GENERATION_MODE.t2iLabel}</span>
                      <span className="vision-genmode-hint">{GENERATION_MODE.t2iHint}</span>
                    </button>
                    <button
                      type="button"
                      className={`vision-genmode-btn ${generationMode === 'i2i' ? 'active' : ''}`}
                      role="radio"
                      aria-checked={generationMode === 'i2i'}
                      disabled={busy || running || optimizing}
                      onClick={() => ws.setGenerationMode('i2i')}
                    >
                      <span className="vision-genmode-label">{GENERATION_MODE.i2iLabel}</span>
                      <span className="vision-genmode-hint">{GENERATION_MODE.i2iHint}</span>
                    </button>
                  </div>
                  <p className="vision-hint">
                    {generationMode === 'i2i' ? GENERATION_MODE.i2iFact : GENERATION_MODE.t2iFact}
                    {generationMode === 'i2i' ? ` ${GENERATION_MODE.referenceStrengthHint}` : ''}
                  </p>
                </div>

                {/* 生成参数 */}
                <div className="vision-advanced-block vision-genparams">
                  <h4>{GENERATION_PARAMS.title}</h4>
                  <div className="vision-config-row">
                    <div className="vision-config-item">
                      <label>{GENERATION_PARAMS.ratioLabel}</label>
                      <select
                        value={ratioOfSize(genParams.size)}
                        disabled={busy || running || optimizing}
                        onChange={e => {
                          const option = RATIO_OPTIONS.find(o => o.value === e.target.value);
                          if (option) ws.setGenParams({ size: option.size });
                        }}
                      >
                        {RATIO_OPTIONS.map(option => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="vision-config-item">
                      <label>{GENERATION_PARAMS.sizeLabel}</label>
                      <select
                        value={genParams.size}
                        disabled={busy || running || optimizing}
                        onChange={e => ws.setGenParams({ size: e.target.value })}
                      >
                        {SIZES.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div className="vision-config-item">
                      <label>{GENERATION_PARAMS.qualityLabel}</label>
                      <select
                        value={genParams.quality}
                        disabled={busy || running || optimizing}
                        onChange={e => ws.setGenParams({ quality: e.target.value })}
                      >
                        {QUALITIES.map(q => <option key={q} value={q}>{QUALITY_LABELS[q] || q}</option>)}
                      </select>
                    </div>
                    <div className="vision-config-item">
                      <label>{GENERATION_PARAMS.countLabel}</label>
                      <select
                        value={genParams.count}
                        disabled={busy || running || optimizing}
                        onChange={e => ws.setGenParams({ count: Number(e.target.value) })}
                      >
                        {COUNT_OPTIONS.map(n => (
                          <option key={n} value={n}>{n} {GENERATION_PARAMS.countUnit}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <p className="vision-hint">{GENERATION_PARAMS.hint}</p>
                </div>

                {/* 自动评价开关 */}
                <div className="vision-advanced-block">
                  <label className="vision-auto-eval">
                    <input
                      type="checkbox"
                      checked={autoEvaluate}
                      onChange={e => toggleAutoEvaluate(e.target.checked)}
                    />
                    <span>{EVALUATION_COPY.autoEvaluateLabel}</span>
                  </label>
                  <p className="vision-hint">{EVALUATION_COPY.autoEvaluateHint}</p>
                </div>

                {/* 高复刻 */}
                <div className="vision-advanced-block vision-actions-card">
                  <button
                    className="vision-btn vision-btn-caution"
                    disabled={busy}
                    onClick={() => setConfirmOpen(true)}
                  >
                    {running ? '高复刻进行中…' : '高复刻验证'}
                  </button>
                  {running && (
                    <button className="vision-btn vision-btn-danger" onClick={() => { cancelRef.current = true; }}>停止</button>
                  )}
                </div>

                {/* 高复刻结果（复刻相似度报告） */}
                {report && (
                  <div className="vision-similarity">
                    <h4>复刻相似度</h4>
                    <p className="vision-score">
                      综合估算：<strong>{scoreToPercent(report.final_score)} / 100</strong>
                    </p>
                    <div className="vision-score-grid">
                      <span>主体 {scoreToPercent(report.scores.subject)}</span>
                      <span>构图 {scoreToPercent(report.scores.composition)}</span>
                      <span>风格 {scoreToPercent(report.scores.style)}</span>
                      <span>光线 {scoreToPercent(report.scores.lighting)}</span>
                      <span>色彩 {scoreToPercent(report.scores.color)}</span>
                      <span>对象 {report.scores.objects != null ? scoreToPercent(report.scores.objects) : 'N/A'}</span>
                      <span>文字 {report.scores.ocr != null ? scoreToPercent(report.scores.ocr) : 'N/A'}</span>
                      {report.local_color != null && <span>本地色彩 {scoreToPercent(report.local_color)}</span>}
                      {report.local_composition != null && <span>本地构图 {scoreToPercent(report.local_composition)}</span>}
                    </div>
                    <p className="vision-hint">{SIMILARITY_DISCLAIMER}</p>

                    {iterations.length > 0 && (
                      <div className="vision-iterations">
                        <strong>迭代记录</strong>
                        {iterations.map(it => (
                          <div key={it.attempt} className="vision-iteration">
                            <span>第 {it.attempt} 轮 · 综合 {it.similarity ? scoreToPercent(it.similarity.final_score) : '—'}</span>
                            {it.candidatePath && (
                              <button className="vision-btn vision-btn-sm" onClick={() => void api.openFile(it.candidatePath!)}>查看候选图</button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {report.differences.length > 0 && (
                      <div className="vision-differences">
                        <strong>差异明细</strong>
                        <ul>
                          {report.differences.slice(0, 12).map((d, i) => (
                            <li key={i} className={`diff-${d.kind}`}>{d.text}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        </>
      )}

      {/* ===== 确认生成图片弹层（优化 → 生图之间的明确确认阶段） ===== */}
      {generateConfirmOpen && recreation && (
        <div className="vision-modal-overlay" onClick={() => setGenerateConfirmOpen(false)}>
          <div className="vision-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={GENERATE_DIALOG.title}>
            <div className="vision-modal-header">
              <h3>{GENERATE_DIALOG.title}</h3>
            </div>
            <p className="vision-modal-desc">{GENERATE_DIALOG.desc}</p>
            <div className="vision-modal-body">
              <ul className="vision-confirm-facts">
                <li>来源：视觉理解复刻方案{visionTaskId ? `（视觉理解任务 #${visionTaskId.slice(0, 8)}）` : ''}</li>
                <li>生成方式：{generationMode === 'i2i' ? `图生图 · ${GENERATION_MODE.i2iFact}` : `文生图 · ${GENERATION_MODE.t2iFact}`}</li>
                <li>操作摘要：{intentSummary}</li>
                <li>当前最终 Prompt {recreation.editState === 'optimized' ? '已按你的修改意图优化完成' : '为提取的原始复刻 Prompt（未修改）'}</li>
                <li>生成参数：比例 {ratioOfSize(genParams.size) || '—'} · 尺寸 {genParams.size} · 质量 {QUALITY_LABELS[genParams.quality] || genParams.quality} · 数量 {genParams.count} 张</li>
                <li>进入图片工作室后提交生成，不会再次执行 AI 优化；完成后自动进行 AI 评价（可在高级设置关闭）。</li>
              </ul>
            </div>
            <div className="vision-modal-footer">
              <button className="vision-btn" onClick={() => setGenerateConfirmOpen(false)}>取消</button>
              <button className="vision-btn vision-btn-primary" onClick={generateFromPlan}>{GENERATE_DIALOG.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 重新开始确认（只清空当前工作区，不动历史任务与已生成图片） ===== */}
      {restartConfirmOpen && (
        <div className="vision-modal-overlay" onClick={() => setRestartConfirmOpen(false)}>
          <div className="vision-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={RESTART_ACTION.dialogTitle}>
            <div className="vision-modal-header">
              <h3>{RESTART_ACTION.dialogTitle}</h3>
            </div>
            <p className="vision-modal-desc">{RESTART_ACTION.dialogDesc}</p>
            <div className="vision-modal-footer">
              <button className="vision-btn" onClick={() => setRestartConfirmOpen(false)}>取消</button>
              <button className="vision-btn vision-btn-danger" onClick={restartWorkspace}>{RESTART_ACTION.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 高复刻确认弹窗（成本保护） ===== */}
      {confirmOpen && (
        <div className="vision-modal-overlay" onClick={() => setConfirmOpen(false)}>
          <div className="vision-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="开始高复刻验证">
            <div className="vision-modal-header">
              <h3>开始高复刻验证</h3>
            </div>
            <p className="vision-modal-desc">将以当前 Prompt 生成候选图，并与参考图双图评审，按差异修正 Prompt 后可再生成。仅点击「开始」才会产生图片生成费用。</p>
            <div className="vision-modal-body">
              <div className="vision-confirm-grid">
                <div>
                  <label>目标相似度</label>
                  <select value={ws.hfTarget} onChange={e => ws.setHfConfig({ target: Number(e.target.value) })}>
                    <option value={0.85}>85 分</option>
                    <option value={0.9}>90 分（默认）</option>
                    <option value={0.95}>95 分</option>
                  </select>
                </div>
                <div>
                  <label>最大轮数</label>
                  <select value={ws.hfMaxIterations} onChange={e => ws.setHfConfig({ maxIterations: Number(e.target.value) })}>
                    <option value={1}>1 轮</option>
                    <option value={2}>2 轮（默认）</option>
                    <option value={3}>3 轮</option>
                  </select>
                </div>
              </div>
              <ul className="vision-confirm-facts">
                <li>图片生成模型：gpt-image-2（服务端计费，最多 {ws.hfMaxIterations} 张候选图）</li>
                <li>视觉模型：{selectedOption?.profileName ?? '—'} / {selectedOption?.displayName ?? selectedModelId ?? '—'}（你的 Key，每轮 2 次调用：候选图分析 + 双图评审）</li>
                <li>停止条件：达到目标分 / 改善不足 1.5 分 / 达到最大轮数 / 手动停止</li>
              </ul>
              <p className="vision-hint">相似度为综合估算值，不保证像素级一致；人脸身份、小字、Logo 属于已知难复刻项。</p>
            </div>
            <div className="vision-modal-footer">
              <button className="vision-btn" onClick={() => setConfirmOpen(false)}>取消</button>
              <button className="vision-btn vision-btn-caution" onClick={() => void startHighFidelity()}>开始（可能产生费用）</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 图库选择（source = 更换参考图；person = 选择人物替换参考图） ===== */}
      {galleryOpen && (
        <div className="vision-modal-overlay" onClick={() => setGalleryOpen(false)}>
          <div className="vision-modal vision-gallery-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={galleryPurpose === 'person' ? '从图片库选择人物' : '从图片库选择'}>
            <div className="vision-modal-header">
              <h3>{galleryPurpose === 'person' ? '从图片库选择人物' : '从图片库选择'}</h3>
            </div>
            <div className="vision-modal-body">
              <div className="vision-gallery-grid">
                {images.length === 0 && <p className="vision-hint">图片库暂无图片</p>}
                {images.map(img => (
                  <div
                    key={img.id}
                    className="vision-gallery-item"
                    title={img.file_name}
                    onClick={() => {
                      setGalleryOpen(false);
                      if (galleryPurpose === 'person') {
                        onPersonChange({
                          source: 'gallery',
                          assetId: img.id,
                          path: img.local_path,
                          label: img.file_name,
                        });
                      } else {
                        useVisionWorkspaceStore.getState().setSource(img.local_path, img.id);
                      }
                    }}
                  >
                    {galleryUrls[img.id]
                      ? <img src={galleryUrls[img.id]} alt="" />
                      : <span className="vision-hint">加载中</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 引用未直接使用的默认权重导出（保持模块单一来源，避免魔法数字散落）
void DEFAULT_SIMILARITY_WEIGHTS;
