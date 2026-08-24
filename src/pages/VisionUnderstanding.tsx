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
  type RecreationFieldKey,
  type RecreationState,
} from '../features/vision/recreationPlan';
import {
  buildModificationInstruction,
  clearPersonReplacement,
  clothingReadinessError,
  EMPTY_MODIFICATION_DRAFT,
  isModificationDraftEmpty,
  personHasImage,
  setClothingPolicy,
  setPersonReplacement,
  toggleModificationDimension,
  toggleReplicationBoost,
  type ModificationDraft,
  type ModificationDimension,
  type PersonReplacement,
} from '../features/vision/modificationIntent';
import { buildGenerationProvenance, resolveGenerationImageReferences } from '../features/vision/generationProvenance';
import {
  buildVisionContextImages,
  mentionSuggestionSignature,
  pruneMentions,
  resolveImageMentionRoles,
  type ImageMention,
} from '../features/vision/imageMention';
import IntentMentionInput from '../features/vision/IntentMentionInput';
import { MENTION_SUGGESTION } from '../features/vision/recreationCopy';
import { useTaskStore } from '../store/useTaskStore';
import type { OptimizerImageReference } from '../services/promptOptimizer';
import { computePromptDiff, dimensionDiff } from '../features/vision/promptDiff';
import { buildPromptChangeSummary } from '../features/vision/promptChangeSummary';
import { mapVisionErrorToUserMessage } from '../features/vision/visionErrors';
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
import { resolveModelForRole } from '../features/aiRouting/resolveModelForRole';
import { describeFallback } from '../features/aiRouting/aiRoutingLog';
import { useAiModelRoutingStore } from '../features/aiRouting/modelRoutingPolicy';
import { useImageViewerStore } from '../store/useImageViewerStore';
import { useVisionViewStore } from '../store/useVisionViewStore';
import type { ImageMeta, ImageRecord } from '../types';
import { SIZES, QUALITIES, QUALITY_LABELS } from '../types';
import './VisionUnderstanding.css';
import { useVisualProjectStore } from '../store/useVisualProjectStore';
import {
  EMPTY_MODIFICATION_CONTRACT,
  normalizeModificationContract,
  reapplyTemplateFromAnalysis,
  setProjectPersonContract,
  toModificationContract,
} from '../features/vision/project/project';
import { mergePersonContract } from '../features/vision/project/personContract';
import { enabledRasterRegions } from '../features/vision/project/region';
import { isLegacyWorkspaceMigratable, migrateLegacyWorkspace } from '../features/vision/project/migrate';
import { validateGenerationContract } from '../features/vision/project/validators';
import { buildOptimizerHardContractLines } from '../features/vision/project/optimizerContract';
import { mergeFinalGenerationPrompt } from '../features/vision/project/promptCompiler';
import { describeTemplateSnapshot } from '../features/vision/project/template';
import { exportMaskPngBase64 } from '../features/vision/region/regionMask';
import RegionEditorPanel from '../features/vision/region/RegionEditorPanel';
import ContextRail from '../features/vision/project/ContextRail';
import ProjectHeaderBar from '../features/vision/project/ProjectHeaderBar';
import { buildGenerationNegativeAddendum } from '../features/vision/generationDirective';
import type { PersonReplacementContract, VisualProject } from '../features/vision/project/types';

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

  // ===== Visual Project（V4.1 Workbench V2：项目化状态唯一载体；恢复绝不重调分析 API） =====
  const projectStore = useVisualProjectStore();
  const activeProject = projectStore.active;
  const hydratingProjectRef = useRef(false);
  /** 更换识别图后的模板重建模式（保留意图 / 重新开始；重新分析完成时消费）。 */
  const pendingTemplateModeRef = useRef<'keep' | 'restart'>('keep');
  /** 区域人物参考绑定中的区域 id（图库选择完成时消费）。 */
  const pendingRegionRefIdRef = useRef<string | null>(null);
  const [sourceChangeConfirm, setSourceChangeConfirm] = useState<{ path: string; assetId?: string } | null>(null);
  /** 区域编辑器外部打开信号（递增计数；PersonPanel「打开区域编辑器」入口触发）。 */
  const [regionEditorOpenRequest, setRegionEditorOpenRequest] = useState(0);

  // ===== 仅进程内 UI 状态（预览图 / 弹层 / 轮询细节，不持久化） =====
  const [previewUrl, setPreviewUrl] = useState('');
  const [meta, setMeta] = useState<ImageMeta | null>(null);
  /** 图库弹层用途：source = 更换参考图；person = 人物替换参考；mention = @引用加入当前任务。 */
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryPurpose, setGalleryPurpose] = useState<'source' | 'person' | 'mention' | 'region-person'>('source');
  /** @弹层「从图片库选择」回填（一次消费，IntentMentionInput 在记忆光标处插入）。 */
  const [pendingGalleryImage, setPendingGalleryImage] = useState<{ assetId?: string; path: string; label?: string } | null>(null);
  /** 「已识别图片角色」建议条忽略态（视图；签名变化后可再次出现）。 */
  const [dismissedSuggestion, setDismissedSuggestion] = useState('');
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

  // ===== 复刻 Prompt 优化模型解析（V4.1 role 路由：默认跟随视觉理解；显示值 === 执行值） =====
  const routingConfig = useAiModelRoutingStore(s => s.config);
  const optimizerResolution = useMemo(
    () => resolveModelForRole('vision_prompt_optimizer', {
      visionPreferred: { profileId: selectedProfileId || undefined, modelId: selectedModelId || undefined },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedProfileId, selectedModelId, routingConfig, profiles],
  );
  const evaluationResolution = useMemo(
    () => resolveModelForRole('image_evaluation'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routingConfig, profiles],
  );

  const optimizerModelLabel = optimizerResolution.ok ? optimizerResolution.resolved.displayName : null;
  const optimizerSourceSuffix = optimizerResolution.ok
    ? optimizerResolution.resolved.source === 'follow'
      ? ' · 跟随视觉理解'
      : optimizerResolution.resolved.source === 'manual'
        ? ' · 单独指定'
        : optimizerResolution.resolved.source === 'fallback'
          ? ' · 当前回退'
          : ''
    : '';

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

  // 项目生命周期：挂载刷新列表；legacy workspace（有分析结果）→ 未命名视觉项目（§36，绝不重新分析）
  useEffect(() => {
    void useVisualProjectStore.getState().refreshList();
    const wstate = useVisionWorkspaceStore.getState();
    if (!useVisualProjectStore.getState().active && isLegacyWorkspaceMigratable(wstate) && wstate.analysis) {
      const migrated = migrateLegacyWorkspace({
        sourcePath: wstate.sourcePath,
        sourceAssetId: wstate.sourceAssetId,
        profileId: wstate.profileId,
        modelId: wstate.modelId,
        analysis: wstate.analysis,
        originalPromptDraft: wstate.originalPromptDraft,
        promptDraft: wstate.promptDraft,
        negativeDraft: wstate.negativeDraft,
        modificationDraft: wstate.modificationDraft,
        recreation: wstate.recreation,
        visionTaskId: wstate.visionTaskId,
        sessionId: wstate.sessionId,
      });
      if (migrated) void useVisualProjectStore.getState().createFromAnalysis(migrated as never);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // workspace → 项目镜像（项目打开期间，工作区语义字段变化同步进项目文档并防抖落库；
  // hydrate 期间跳过，避免 project → workspace → project 回写循环）
  useEffect(() => {
    if (!activeProject || hydratingProjectRef.current) return;
    useVisualProjectStore.getState().syncFromWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeProject?.id,
    modificationDraft,
    recreation,
    promptDraft,
    negativeDraft,
    originalPromptDraft,
    genParams,
    generationMode,
    selectedProfileId,
    selectedModelId,
    report,
    iterations,
  ]);

  // 卸载时冲刷：文本防抖 + 项目防抖语义修订 + 项目落库
  useEffect(() => () => {
    useVisionWorkspaceStore.getState().flushPendingPersist();
    const pstore = useVisualProjectStore.getState();
    pstore.flushPendingSemantic();
    void pstore.flushPersist();
  }, []);

  // 拖拽（Tauri webview 原生事件，直接给本地路径；解析统一走 imageDropFiles）
  useEffect(() => {
    const unlisten = getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return;
        const paths = (event.payload as { paths?: string[] }).paths || [];
        const { images, invalid } = splitDroppedPaths(paths);
        if (images.length > 0) {
          applySourceSelection(images[0].path);
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

  // ===== 当前任务图片池（唯一来源：主参考图 + 人物替换参考 + 图库附加参考 + 本任务生成结果） =====
  const tasks = useTaskStore(s => s.tasks);
  /** 本视觉任务的最新生成任务产物（assetId → 图库路径；路径未知的跳过）。 */
  const generatedResults = useMemo(() => {
    if (!visionTaskId) return [];
    const resultTask = tasks
      .filter(t => t.source_task_id === visionTaskId && (t.task_type === 'generate' || t.task_type === 'edit'))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    if (!resultTask) return [];
    const byId = new Map(images.map(img => [img.id, img]));
    return resultTask.sub_tasks
      .filter(sub => sub.status === 'completed' && sub.image_id)
      .map(sub => ({ assetId: sub.image_id!, path: byId.get(sub.image_id!)?.local_path ?? '' }))
      .filter(item => !!item.path);
  }, [tasks, visionTaskId, images]);

  const contextPool = useMemo(() => buildVisionContextImages({
    sourcePath: sourcePath || undefined,
    sourceAssetId: sourceAssetId || undefined,
    person: modificationDraft.person,
    // V4.1 §30 候选池顺序：@原图 → @人物参考 → 区域参考 → 生成结果 → 其它
    // （项目 references 中的区域人物参考并入 extras，路径去重由池内归一处理）
    extraReferences: [
      ...modificationDraft.extraImageRefs,
      ...(activeProject?.references ?? []).map(ref => ({ assetId: ref.assetId, path: ref.path, label: ref.label })),
    ],
    generatedResults,
  }), [sourcePath, sourceAssetId, modificationDraft.person, modificationDraft.extraImageRefs, generatedResults, activeProject?.references]);

  /**
   * 双图角色解析（面板显式选择 > 明确 Mention > 自然语言推断）：
   * 驱动「已识别」建议条与优化器 imageReferences（模板图 + 人物图真实附图）。
   */
  const mentionResolution = useMemo(() => resolveImageMentionRoles({
    freeText: modificationDraft.freeText,
    mentions: modificationDraft.mentions,
    pool: contextPool,
  }), [modificationDraft.freeText, modificationDraft.mentions, contextPool]);

  /** 建议条可见性：面板人物为空 + 解析出人物来源（mention/pool）+ 未忽略当前签名。 */
  const suggestionSignature = mentionSuggestionSignature(mentionResolution);
  const showMentionSuggestion = !!mentionResolution.person
    && !modificationDraft.person
    && (mentionResolution.person.origin === 'mention' || mentionResolution.person.origin === 'pool')
    && suggestionSignature !== dismissedSuggestion;

  /** 应用建议：把解析出的替换人物写入面板（走正常语义通道；不覆盖任何已有值）。 */
  const applyMentionSuggestion = () => {
    const person = mentionResolution.person;
    if (!person) return;
    onPersonChange({
      source: person.assetId ? 'gallery' : 'local',
      assetId: person.assetId,
      path: person.path,
      label: person.label,
    });
    setDismissedSuggestion(suggestionSignature);
  };

  /** 优化器图片引用：模板图（双图工作流时）+ 人物图 + 其余 @引用（按池内角色）。 */
  const buildOptimizerImageReferences = (): OptimizerImageReference[] => {
    const personPath = personHasImage(useVisionWorkspaceStore.getState().modificationDraft.person)
      ? useVisionWorkspaceStore.getState().modificationDraft.person!.path
      : mentionResolution.person?.path;
    const templateRef = mentionResolution.template;
    const personPanelActive = !!useVisionWorkspaceStore.getState().modificationDraft.person;
    const dualImageWorkflow = !!personPath || !!templateRef || personPanelActive;
    const refs: OptimizerImageReference[] = [];
    if (dualImageWorkflow && sourcePath) {
      refs.push({ path: sourcePath, label: templateRef?.label && templateRef.origin === 'mention' ? templateRef.label : '原图', role: 'template_reference' });
    }
    if (personPath) {
      const poolPerson = contextPool.find(image => image.role === 'person_replacement_reference');
      refs.push({ path: personPath, label: mentionResolution.person?.label ?? poolPerson?.label ?? '人物参考图', role: 'person_replacement_reference' });
    }
    for (const mention of pruneMentions(modificationDraft.freeText, modificationDraft.mentions)) {
      if (mention.path === sourcePath || mention.path === personPath) continue;
      refs.push({ path: mention.path, label: mention.label, role: mention.role });
    }
    return refs;
  };

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

  /**
   * 更换识别图（§5）：已有分析结果时先确认（保留当前修改意图 / 重新开始），
   * 确认后才落新源图；模板基线将在下一次分析完成时按所选模式重建。
   */
  const applySourceSelection = (path: string, assetId?: string) => {
    const wstate = useVisionWorkspaceStore.getState();
    if (wstate.analysis && path !== wstate.sourcePath) {
      setSourceChangeConfirm({ path, assetId });
      return;
    }
    wstate.setSource(path, assetId);
  };

  const confirmSourceChange = (keepModification: boolean) => {
    const change = sourceChangeConfirm;
    if (!change) return;
    pendingTemplateModeRef.current = keepModification ? 'keep' : 'restart';
    useVisionWorkspaceStore.getState().setSource(change.path, change.assetId);
    if (!keepModification) {
      useVisionWorkspaceStore.getState().setModificationDraft({ ...EMPTY_MODIFICATION_DRAFT });
      const pstate = useVisualProjectStore.getState();
      if (pstate.active) {
        pstate.updateActive('template', draft => ({
          ...draft,
          modification: { ...EMPTY_MODIFICATION_CONTRACT },
          regions: [],
          references: [],
        }));
      }
    }
    setSourceChangeConfirm(null);
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
        // 失败绝不清理旧分析结果：重新理解失败时上一次成功分析原样保留
        const hadPreviousAnalysis = !!useVisionWorkspaceStore.getState().analysis;
        const message = mapVisionErrorToUserMessage(result.error_kind, result.error_message);
        const display = hadPreviousAnalysis
          ? `本次重新理解没有完成，仍保留上一次分析结果。${message}`
          : `视觉理解失败：${message}`;
        useVisionWorkspaceStore.getState().markStage('failed', display);
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
      // V4.1 项目化落位：已有项目 → 按源图变化重建模板（§5：保留意图 / 重新开始）；
      // 无项目 → 分析成功即建项目（模板基线冻结；后续修改全部是 overlay）
      const pstate = useVisualProjectStore.getState();
      const sourceAsset = {
        path: wstore.sourcePath,
        ...(wstore.sourceAssetId ? { assetId: wstore.sourceAssetId } : {}),
        source: wstore.sourceAssetId ? ('gallery' as const) : ('local_import' as const),
      };
      const analysisModel = {
        modelId: config.model,
        providerName: config.profileId,
      };
      // 闭包内使用前提升快照（result.analysis 的非空收窄不进入回调）
      const analysisSnapshot = result.analysis;
      if (pstate.active) {
        const keepModification = pstate.active.sourceAsset.path === wstore.sourcePath
          ? true
          : pendingTemplateModeRef.current === 'keep';
        pstate.updateActive('template', draft => reapplyTemplateFromAnalysis(draft, {
          analysis: analysisSnapshot,
          plan: nextRecreation.plan,
          recreation: nextRecreation,
          sourceAsset,
          keepModification,
          analysisModel,
        }));
      } else {
        const wstateAfter = useVisionWorkspaceStore.getState();
        await useVisualProjectStore.getState().createFromAnalysis({
          name: '未命名视觉项目',
          analysis: analysisSnapshot,
          plan: nextRecreation.plan,
          recreation: nextRecreation,
          sourceAsset,
          analysisModel,
          workspace: {
            profileId: wstateAfter.profileId,
            modelId: wstateAfter.modelId,
            mode: wstateAfter.mode,
            analysis: result.analysis,
            reverseResult: compiled,
            originalPromptDraft: wstateAfter.originalPromptDraft,
            promptDraft: wstateAfter.promptDraft,
            negativeDraft: wstateAfter.negativeDraft,
            recreation: nextRecreation,
            genParams: nextGenParams,
            generationMode: wstateAfter.generationMode,
            hfTarget: wstateAfter.hfTarget,
            hfMaxIterations: wstateAfter.hfMaxIterations,
            report: null,
            iterations: [],
            visionTaskId: taskId,
            sessionId: newSessionId,
          },
        });
      }
      if (taskId) {
        void markVisionTaskCompleted(taskId, analysisSnapshot.summary, config.model);
      }
      if (compiled.warnings.length > 0 && wstore.mode !== 'quick') {
        toastSuccess(`分析完成（${compiled.warnings.length} 条风险提示）`);
      } else {
        toastSuccess('分析完成');
      }
    } catch (err: any) {
      const hadPreviousAnalysis = !!useVisionWorkspaceStore.getState().analysis;
      const message = mapVisionErrorToUserMessage(null, err?.message || err?.toString() || '视觉模型请求失败');
      const display = hadPreviousAnalysis
        ? `本次重新理解没有完成，仍保留上一次分析结果。${message}`
        : `视觉理解失败：${message}`;
      useVisionWorkspaceStore.getState().markStage('failed', display);
      if (taskId) void markVisionTaskFailed(taskId, message);
    }
  };

  /**
   * 「确认生成图片」：先过 canGenerateFromRecreation 守卫（dirty 拦截并提示先优化），
   * 通过后弹确认层（来源 / 操作摘要 / 不会重复优化），再携带现成最终 Prompt 进入
   * 图片工作室 —— 绝不在生成前再执行一次 Prompt 优化。
   * 自定义服装未填写描述时在此拦截（禁止把空描述交给 AI 自由发挥）。
   */
  const openGenerateConfirm = () => {
    const readiness = canGenerateFromRecreation(recreation);
    if (!readiness.allowed) {
      toastWarning(readiness.reason, '暂时不能生成');
      return;
    }
    const clothingError = clothingReadinessError(modificationDraft);
    if (clothingError) {
      toastWarning(clothingError, '服装描述未填写');
      return;
    }
    setGenerateConfirmOpen(true);
  };

  const intentSummary = useMemo(() => {
    const instruction = recreation?.adjustInstruction?.trim();
    return instruction ? `修改意图 → ${instruction.slice(0, 80)}${instruction.length > 80 ? '…' : ''}` : '未修改，直接复刻参考图方案';
  }, [recreation]);

  const generateFromPlan = async () => {
    const readiness = canGenerateFromRecreation(recreation);
    if (!readiness.allowed) {
      toastError(readiness.reason, '暂时不能生成');
      return;
    }
    if (!promptDraft.trim()) {
      toastError('当前缺少可用于生图的最终 Prompt，请先执行提示词优化。', '暂时不能生成');
      return;
    }
    const wstore = useVisionWorkspaceStore.getState();
    const currentDraft = wstore.modificationDraft;
    const clothingError = clothingReadinessError(currentDraft);
    if (clothingError) {
      toastError(clothingError, '服装描述未填写');
      return;
    }
    // V4.1 项目合同硬校验（§38：只有语义错误阻断——strict 无参考 / 空 custom 服装 /
    // custom_region 区域缺失 / 模板缺失；视图状态绝不参与）
    const pstate = useVisualProjectStore.getState();
    pstate.flushPendingSemantic();
    const project = pstate.active;
    if (project) {
      const contractErrors = validateGenerationContract(pstate.active);
      if (contractErrors.length > 0) {
        toastError(contractErrors[0], '生成前需处理');
        return;
      }
    }
    const personPath = personHasImage(currentDraft.person)
      ? currentDraft.person!.path
      : (mentionResolution.person?.origin === 'mention' ? mentionResolution.person.path : undefined);
    // V4.0.9.1 生成参考图唯一解析：顺序 = 最终提交顺序（模板 → 人物 → 其余 @引用），
    // 同一份清单同时喂给溯源快照与生成 carry —— 快照与 payload 永不失配。
    const imageReferences = resolveGenerationImageReferences({
      draft: currentDraft,
      sourcePath: sourcePath || undefined,
      sourceAssetId: sourceAssetId || undefined,
      templateLabel: mentionResolution.template?.label,
      personMention: !currentDraft.person && mentionResolution.person?.origin === 'mention'
        ? {
          path: mentionResolution.person.path,
          assetId: mentionResolution.person.assetId,
          label: mentionResolution.person.label,
        }
        : undefined,
    });
    if (import.meta.env.DEV) {
      // 开发态安全诊断（不含 base64 / token）：确认人物参考真实进入生成链
      console.info('[VisionGeneration]', {
        template: sourcePath || undefined,
        personReference: personPath,
        imageCount: imageReferences.length,
        imageRoles: imageReferences.map(ref => `${ref.label}:${ref.role}`),
        activeDimensions: currentDraft.activeDimensions,
        clothingPolicy: currentDraft.clothingPolicy,
        personReplacement: personPath ? 'strict' : currentDraft.person ? 'description' : 'off',
      });
    }
    // V4.0.9 生成溯源快照：生成时刻冻结用户原话 / 修改方案 / 参考图角色 / 服装策略 / 模型记录
    const provenance = buildGenerationProvenance({
      draft: currentDraft,
      recreation: wstore.recreation ?? recreation!,
      sourcePath: sourcePath || undefined,
      sourceAssetId: sourceAssetId || undefined,
      templateLabel: mentionResolution.template?.label,
      imageReferences,
      personMention: !currentDraft.person && mentionResolution.person?.origin === 'mention'
        ? {
          path: mentionResolution.person.path,
          assetId: mentionResolution.person.assetId,
          label: mentionResolution.person.label,
        }
        : undefined,
      visionModel: {
        modelId: selectedModelId || undefined,
        displayName: selectedOption?.displayName ?? selectedModelId ?? undefined,
        providerName: selectedOption?.profileName,
      },
      optimizerModel: {
        modelId: recreation?.optimizerModelId,
        displayName: recreation?.modelName,
        providerName: recreation?.providerName,
        source: recreation?.optimizerSource,
      },
      evaluationModel: evaluationResolution.ok
        ? {
            modelId: evaluationResolution.resolved.resolvedModelId,
            displayName: evaluationResolution.resolved.displayName,
            providerName: evaluationResolution.resolved.providerName,
          }
        : undefined,
      ...(project ? {
        project: {
          id: project.id,
          name: project.name,
          revision: project.revision,
          ...(project.modification.person?.enabled
            ? {
              personContract: {
                strength: project.modification.person.strength,
                replaceScope: project.modification.person.replaceScope,
                ...(project.modification.person.targetRegionId
                  ? { targetRegionId: project.modification.person.targetRegionId }
                  : {}),
                applyIdentityTo: project.modification.person.applyIdentityTo,
                preserveTemplateIdentity: false,
              } as const,
            }
            : {}),
          regions: project.regions
            .filter(region => region.enabled)
            .map(region => ({
              id: region.id,
              name: region.name,
              replaceType: region.replaceType,
              constraintStrength: region.constraintStrength,
              ...(region.replaceScope ? { replaceScope: region.replaceScope } : {}),
              ...(region.personReferenceId
                ? {
                  personReferenceLabel: project.references
                    .find(ref => ref.id === region.personReferenceId)?.label,
                }
                : {}),
              ...(region.prompt?.trim() ? { prompt: region.prompt.trim() } : {}),
              enabled: region.enabled,
              ...(region.maskPath ? { maskPath: region.maskPath } : {}),
              shape: region.shape,
            })),
          renderingContract: project.renderingContract ?? undefined,
        },
      } : {}),
    });
    // V4.1 Prompt Compiler：项目合同全量编译（图片角色 / 人物 / 区域 / 媒介 / 服装 /
    // 维度 / 模板保留 + 最终画面描述）；优化器产物只作为「最终画面描述」层进入。
    let finalPromptText = promptDraft.trim();
    let finalNegativeText = negativeDraft.trim();
    let promptCompiled = false;
    let maskImagePath: string | undefined;
    if (project) {
      const personEnabled = !!imageReferences.some(ref => ref.role === 'person_reference')
        && (!!currentDraft.person || !!personPath);
      const compiled = mergeFinalGenerationPrompt({
        project,
        finalDescription: promptDraft.trim(),
        negativePrompt: negativeDraft.trim(),
        negativeAddendum: buildGenerationNegativeAddendum({
          imageReferences,
          personReplacementEnabled: personEnabled,
          clothingPolicy: currentDraft.clothingPolicy,
          customClothing: currentDraft.customClothing,
        }),
        imageReferences,
        personReplacementEnabled: personEnabled,
        styleDirection: currentDraft.activeDimensions.includes('style') ? currentDraft.freeText.trim().slice(0, 40) : undefined,
      });
      finalPromptText = compiled.prompt;
      finalNegativeText = compiled.negativePrompt;
      promptCompiled = true;
      // Region V1 真实 mask：启用中的栅格区域合成 combined mask（透明 = 可编辑）
      if (generationMode === 'i2i' && meta?.width && meta?.height) {
        const rasterRegions = enabledRasterRegions(project.regions);
        if (rasterRegions.length > 0) {
          const base64 = exportMaskPngBase64({ naturalWidth: meta.width, naturalHeight: meta.height, regions: rasterRegions });
          if (base64) {
            maskImagePath = (await pstate.saveRegionMask('combined', base64)) ?? undefined;
          }
        }
      }
      if (import.meta.env.DEV) {
        console.info('[VisionGeneration][compiled]', {
          projectId: project.id,
          projectRevision: project.revision,
          sections: compiled.sections,
          mask: maskImagePath ?? null,
          imageCount: imageReferences.length,
        });
      }
    }
    const carry = buildGenerationCarry(
      {
        ...recreation!,
        optimizedPrompt: finalPromptText,
        optimizedNegativePrompt: finalNegativeText,
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
        imageReferences,
        personReplacement: {
          enabled: !!personPath || !!currentDraft.person,
          clothingPolicy: currentDraft.clothingPolicy,
          customClothing: currentDraft.customClothing,
        },
        provenance,
        promptCompiled,
        maskImagePath,
        ...(project ? {
          projectId: project.id,
          projectName: project.name,
          projectRevision: project.revision,
        } : {}),
      },
    );
    useDraftStore.getState().setVisionCarry(carry);
    setGenerateConfirmOpen(false);
    // 项目状态推进（生成中 + 冻结最终 Prompt；generationIds 由生成结果到达后以 meta 同步）
    if (project) {
      useVisualProjectStore.getState().updateActiveMeta(draft => ({
        ...draft,
        status: 'generating',
        latestFinalPrompt: finalPromptText.slice(0, 500),
      }));
    }
    window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'imagestudio' } }));
  };

  // ===== 修改意图（核心操作区：自由文本 + 快捷维度 + 人物替换 + 服装策略）=====

  /**
   * 结构化修改意图变更唯一入口：
   *  - draft 落 workspace（文本输入走防抖持久化）；
   *  - 合成指令落 recreation（真实语义修改 → semanticRevision +1；纯 UI 不经过这里）；
   *  - 合成指令为空时按修订模型归一（绝不空指令卡死在 dirty）；
   *  - @mention 双图角色（模板图 / 人物来源）随合成指令显式进入优化语义。
   */
  const commitModificationDraft = (nextDraft: ModificationDraft, opts?: { debounce?: boolean }) => {
    const wstore = useVisionWorkspaceStore.getState();
    wstore.setModificationDraft(nextDraft, opts);
    if (!wstore.recreation || wstore.recreation.editState === 'optimizing') return;
    const resolution = resolveImageMentionRoles({
      freeText: nextDraft.freeText,
      mentions: nextDraft.mentions,
      pool: buildVisionContextImages({
        sourcePath: wstore.sourcePath || undefined,
        sourceAssetId: wstore.sourceAssetId || undefined,
        person: nextDraft.person,
        extraReferences: nextDraft.extraImageRefs,
        generatedResults,
      }),
    });
    const instruction = buildModificationInstruction(nextDraft, {
      template: resolution.template ? { label: resolution.template.label } : undefined,
      personMention: !nextDraft.person && resolution.person?.origin === 'mention'
        ? { label: resolution.person.label }
        : undefined,
    });
    const nextRecreation = applyModificationInstruction(wstore.recreation, instruction);
    wstore.setRecreation(nextRecreation, { debounce: opts?.debounce === true });
    persistRecreation(nextRecreation);
    // V4.1 项目镜像：draft → ModificationContract（同一人物绑定保留 V2 合同字段）；
    // 文本连击走防抖语义（一段编辑 = 一次项目修订）
    const pstate = useVisualProjectStore.getState();
    if (pstate.active) {
      const mirror = (project: VisualProject) => normalizeModificationContract({
        ...project.modification,
        freeText: nextDraft.freeText,
        activeDimensions: nextDraft.activeDimensions,
        clothingPolicy: nextDraft.clothingPolicy,
        customClothing: nextDraft.customClothing,
        replicationBoost: nextDraft.replicationBoost,
        mentions: nextDraft.mentions,
        extraImageRefs: nextDraft.extraImageRefs,
        person: mergePersonContract(project.modification.person, nextDraft.person, project.regions),
      }, project.regions);
      const apply = opts?.debounce === true ? 'updateActiveDebounced' : 'updateActive';
      pstate[apply]('modification', project => ({ ...project, status: 'modified', modification: mirror(project) }));
    }
  };

  /** 自由文本输入（textarea）：只改 freeText，不动结构化意图。 */
  const onFreeTextChange = (value: string) => {
    commitModificationDraft(
      { ...useVisionWorkspaceStore.getState().modificationDraft, freeText: value },
      { debounce: true },
    );
  };

  /** @图片引用绑定变更（插入 / 删除 mention；随 freeText 一起语义提交）。 */
  const onMentionsChange = (mentions: ImageMention[]) => {
    commitModificationDraft(
      { ...useVisionWorkspaceStore.getState().modificationDraft, mentions },
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

  /**
   * 服装策略变更（radiogroup 唯一语义入口）：
   * 「原图服装」→ 自动取消「修改服装」维度；「人物服装 / 自定义」→ 自动启用。
   * 状态不变量见 modificationIntent.normalizeModificationState（禁止页面自行展开赋值）。
   */
  const onClothingPolicyChange = (policy: ModificationDraft['clothingPolicy']) => {
    const current = useVisionWorkspaceStore.getState().modificationDraft;
    commitModificationDraft(setClothingPolicy(current, policy));
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

  /** 人物替换合同 V2 变更（强度 / 范围 / 身份应用；唯一写入口 = 项目合同）。 */
  const onPersonContractChange = (partial: Partial<PersonReplacementContract>) => {
    const pstate = useVisualProjectStore.getState();
    const current = pstate.active?.modification.person;
    if (!pstate.active || !current) return;
    pstate.updateActive('person', project => setProjectPersonContract(project, { ...current, ...partial }));
  };

  /** 区域替换变更（语义事件；打开/折叠区域卡 = 视图操作不经过这里）。 */
  const onRegionsChange = (updater: (regions: VisualProject['regions']) => VisualProject['regions']) => {
    const pstate = useVisualProjectStore.getState();
    if (!pstate.active) return;
    pstate.updateActive('regions', project => ({ ...project, status: 'modified', regions: updater(project.regions) }));
  };

  /** 区域自身 mask 栅格化落盘（PNG → Rust → region.maskPath）。 */
  const onPersistRegionMask = async (regionId: string) => {
    const pstate = useVisualProjectStore.getState();
    const region = pstate.active?.regions.find(item => item.id === regionId);
    if (!pstate.active || !region) return;
    if (!meta?.width || !meta?.height) {
      toastError('缺少图片尺寸，无法生成区域 mask');
      return;
    }
    const base64 = exportMaskPngBase64({ naturalWidth: meta.width, naturalHeight: meta.height, regions: [region] });
    if (!base64) {
      toastError('区域 mask 生成失败');
      return;
    }
    const path = await pstate.saveRegionMask(regionId, base64);
    if (path) toastSuccess('区域 mask 已保存');
  };

  /** 区域人物参考绑定（图库选择；写入项目 references + region.personReferenceId）。 */
  const onPickRegionPersonReference = (regionId: string) => {
    pendingRegionRefIdRef.current = regionId;
    setGalleryPurpose('region-person');
    setGalleryOpen(true);
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
    // 自定义服装空描述：先补描述再优化（禁止 AI 按空指令自由发挥服装）
    const clothingError = clothingReadinessError(wstore.modificationDraft);
    if (clothingError) {
      toastWarning(clothingError, '服装描述未填写');
      return;
    }
    const instruction = buildModificationInstruction(wstore.modificationDraft, {
      template: mentionResolution.template ? { label: mentionResolution.template.label } : undefined,
      personMention: !wstore.modificationDraft.person && mentionResolution.person?.origin === 'mention'
        ? { label: mentionResolution.person.label }
        : undefined,
    });
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
    // 双图角色语义（V4.0.9）：人物替换参考图 + 画面模板图 + @引用图，
    // 优化器模型具备视觉能力时全部以真实 image parts 附上（顺序 = 清单顺序）
    const personPath = personHasImage(wstore.modificationDraft.person) ? wstore.modificationDraft.person!.path : undefined;
    const imageReferences = buildOptimizerImageReferences();
    // 快捷 Chip 启用的维度 = 用户显式要求修改（方案行 must-change 标记，优化器必须执行）
    const forcedDimensions = wstore.modificationDraft.activeDimensions as RecreationFieldKey[];
    let outcome: Awaited<ReturnType<typeof optimizeVisionRecreation>>;
    try {
      // V4.1 §14：项目硬合同行（人物决策 / 服装来源 / 维度 / 区域 / 媒介结构）
      // 随请求进入【硬性合同】块——优化器只能表达，不能重新决定
      const activeProjectNow = useVisualProjectStore.getState().active;
      const hardContractLines = activeProjectNow
        ? buildOptimizerHardContractLines(activeProjectNow)
        : undefined;
      outcome = await optimizeVisionRecreation({
        originalRecreationPrompt: wstore.originalPromptDraft,
        structuredRecreationPlan: optimizingState.plan,
        userAdjustmentInstruction: optimizingState.adjustInstruction,
        targetImageModelInfo: 'gpt-image-2（GPT Image 系，自然语言长句偏好）',
        originalNegativePrompt: current.originalNegativePrompt,
        visionPreferred: { profileId: wstore.profileId || undefined, modelId: wstore.modelId || undefined },
        personReferencePath: personPath,
        imageReferences,
        forcedDimensions,
        hardContractLines,
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
    // 显式回退必须让用户看见（不得只留在开发日志）
    if (outcome.result.optimizerSource === 'fallback') {
      const requested = outcome.result.optimizerRequestedModelId || '原模型';
      toastWarning(
        `Prompt 优化已从 ${requested} 回退至 ${outcome.result.modelName}：${outcome.result.optimizerFallbackReason ?? '原因未知'}`,
        '已回退优化模型',
      );
    }
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
    useVisualProjectStore.getState().closeProject();
    setRestartConfirmOpen(false);
    setGenerateConfirmOpen(false);
    setConfirmOpen(false);
    setGalleryOpen(false);
    setPendingGalleryImage(null);
    setDismissedSuggestion('');
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
            const message = mapVisionErrorToUserMessage(result.errorKind, result.error ?? '迭代失败');
            useVisionWorkspaceStore.getState().markStage('failed', `${message}（已生成 ${collected.length} 张候选图保留在任务队列与图库）`);
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

  /** 结构化修改摘要（先摘要后全文：人物 / 服装 / 动作 / 背景…逐项说明改什么）。 */
  const changeSummary = useMemo(
    () => buildPromptChangeSummary(recreation, changedFieldKeys),
    [recreation, changedFieldKeys],
  );
  const showUseLastPrompt = !!recreation
    && recreation.editState === 'dirty'
    && hasSuccessfulPrompt(recreation);

  // 维度计数单一事实源：快捷 Chip 已启用的维度（activeDimensions）即使尚未优化也计入「可修改」，
  // 绝不出现「Chip 选中 4 项、计数显示可修改 3」的口径分叉
  const activeDimensionKeys = modificationDraft.activeDimensions as string[];
  const lockedCount = recreation
    ? recreation.plan.fields.filter(field => field.locked && !activeDimensionKeys.includes(field.key)).length
    : 0;
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

      {/* ===== Visual Project Header（§26：项目卡头 + 项目库入口） ===== */}
      <ProjectHeaderBar
        project={activeProject}
        projects={projectStore.projects}
        thumbUrl={previewUrl}
        visionModelLabel={selectedOption ? `${selectedOption.profileName} / ${selectedOption.displayName}` : (selectedModelId || '')}
        saving={projectStore.listLoading}
        onRename={name => { void useVisualProjectStore.getState().renameActive(name); }}
        onSave={() => {
          const pstate = useVisualProjectStore.getState();
          pstate.flushPendingSemantic();
          void pstate.flushPersist().then(() => toastSuccess('项目已保存'));
        }}
        onDerive={() => {
          void useVisualProjectStore.getState().deriveActive().then(project => {
            if (project) {
              hydratingProjectRef.current = true;
              useVisualProjectStore.getState().hydrateWorkspaceFromActive();
              hydratingProjectRef.current = false;
              toastSuccess(`已基于「${activeProject?.name ?? ''}」新建项目`);
            }
          });
        }}
        onReanalyze={() => { void runAnalysis(); }}
        onOpenProject={id => {
          void useVisualProjectStore.getState().openProject(id).then(project => {
            if (project) {
              hydratingProjectRef.current = true;
              useVisualProjectStore.getState().hydrateWorkspaceFromActive();
              hydratingProjectRef.current = false;
            }
          });
        }}
        onNewProject={() => { restartWorkspace(); }}
        onDeleteProject={id => { void useVisualProjectStore.getState().deleteProject(id).then(() => restartWorkspace()); }}
      />

      <div className="vision-workbench">
      <div className="vision-main">

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
                if (file) applySourceSelection(file);
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
              {activeProject?.templateSnapshot && (
                <p className="vision-understanding-media" title="模板基线媒介结构（修改风格不会改变各层媒介）">
                  {describeTemplateSnapshot(activeProject.templateSnapshot)}
                </p>
              )}
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
                <IntentMentionInput
                  id="vision-adjust-input"
                  value={modificationDraft.freeText}
                  mentions={modificationDraft.mentions}
                  pool={contextPool}
                  rows={4}
                  disabled={busy || running || optimizing}
                  placeholder={ADJUST_INPUT.placeholder}
                  ariaLabel={ADJUST_INPUT.label}
                  inputRef={intentInputRef}
                  onChange={onFreeTextChange}
                  onMentionsChange={onMentionsChange}
                  onPickFromGallery={() => { setGalleryPurpose('mention'); setGalleryOpen(true); }}
                  pendingGalleryImage={pendingGalleryImage}
                  onPendingGalleryImageConsumed={() => setPendingGalleryImage(null)}
                />
                {showMentionSuggestion && (
                  <div className="vision-mention-suggestion" role="status">
                    <span className="vision-mention-suggestion-title">{MENTION_SUGGESTION.title}</span>
                    <span className="vision-mention-suggestion-body">
                      {MENTION_SUGGESTION.templateLabel}：{mentionResolution.template?.label ?? '—'}
                      {' · '}
                      {MENTION_SUGGESTION.personLabel}：{mentionResolution.person?.label ?? '—'}
                    </span>
                    <span className="vision-mention-suggestion-note">{MENTION_SUGGESTION.note}</span>
                    <button
                      type="button"
                      className="vision-btn vision-btn-sm"
                      disabled={busy || running || optimizing}
                      onClick={applyMentionSuggestion}
                    >
                      {MENTION_SUGGESTION.apply}
                    </button>
                    <button
                      type="button"
                      className="vision-btn vision-btn-sm"
                      onClick={() => setDismissedSuggestion(suggestionSignature)}
                    >
                      {MENTION_SUGGESTION.dismiss}
                    </button>
                  </div>
                )}
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
                    template={sourcePath ? { path: sourcePath, label: '原图', assetId: sourceAssetId } : null}
                    clothingDimensionActive={modificationDraft.activeDimensions.includes('clothing')}
                    activeDimensions={modificationDraft.activeDimensions}
                    personContract={activeProject?.modification.person ?? null}
                    onPersonContractChange={onPersonContractChange}
                    regionOptions={activeProject?.regions.map(region => ({ id: region.id, name: region.name, enabled: region.enabled })) ?? []}
                    disabled={busy || running || optimizing}
                    onPersonChange={onPersonChange}
                    onClothingPolicyChange={onClothingPolicyChange}
                    onCustomClothingChange={onCustomClothingChange}
                    onRemove={onRemovePersonReplacement}
                    onGalleryPick={pickPersonFromGallery}
                    onLocalPick={() => void pickPersonFromLocal()}
                    onOpenRegionEditor={() => { setRegionEditorOpenRequest(value => value + 1); }}
                    onTemplateChange={() => { setGalleryPurpose('source'); setGalleryOpen(true); }}
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

              {/* ===== 区域替换（§28：项目化链路；区域编辑 = 语义事件，展开卡 = 视图） ===== */}
              {activeProject && (
                <RegionEditorPanel
                  imagePath={sourcePath}
                  regions={activeProject.regions}
                  references={activeProject.references}
                  openRequest={regionEditorOpenRequest}
                  disabled={busy || running || optimizing}
                  onRegionsChange={onRegionsChange}
                  onPersistRegionMask={regionId => { void onPersistRegionMask(regionId); }}
                  onPickRegionPersonReference={onPickRegionPersonReference}
                />
              )}

              {/* 主操作：项目化后 CTA 在 Context Rail（§25 唯一渲染处）；此处仅保留模型标识 */}
              {activeProject ? (
                <div className="vision-plan-actions">
                  {optimizerResolution.ok ? (
                    <span
                      className="vision-optimizer-model"
                      title={`Prompt 优化实际执行模型：${optimizerResolution.resolved.providerName} / ${optimizerResolution.resolved.resolvedModelId}`}
                    >
                      Prompt 优化 · {optimizerModelLabel}{optimizerSourceSuffix}
                      {needsOptimization(recreation) ? ' · 待优化' : ''}
                    </span>
                  ) : (
                    <span className="vision-optimizer-model is-error" title={optimizerResolution.error}>
                      Prompt 优化 · 未配置
                    </span>
                  )}
                </div>
              ) : (
              <div className="vision-plan-actions">
                {optimizerResolution.ok ? (
                  <span
                    className="vision-optimizer-model"
                    title={`Prompt 优化实际执行模型：${optimizerResolution.resolved.providerName} / ${optimizerResolution.resolved.resolvedModelId}`}
                  >
                    Prompt 优化 · {optimizerModelLabel}{optimizerSourceSuffix}
                  </span>
                ) : (
                  <span className="vision-optimizer-model is-error" title={optimizerResolution.error}>
                    Prompt 优化 · 未配置
                  </span>
                )}
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
                  {optimizing ? `正在优化… · ${optimizerModelLabel ?? ''}` : '优化复刻 Prompt'}
                </button>
                <button
                  className="vision-btn vision-btn-primary"
                  disabled={busy || running || optimizing}
                  onClick={openGenerateConfirm}
                >
                  确认生成图片
                </button>
                {optimizerResolution.ok && optimizerResolution.resolved.source === 'fallback' && (
                  <p className="vision-hint vision-optimizer-fallback">{describeFallback(optimizerResolution.resolved)}</p>
                )}
              </div>
              )}
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
                  {recreation.optimizedBy === 'optimizer' && recreation.modelName && (
                    <span
                      className="vision-final-provenance"
                      title={`优化执行时模型：${recreation.providerName ?? ''} / ${recreation.optimizerModelId ?? recreation.modelName}${recreation.optimizerSource ? `（${recreation.optimizerSource === 'follow' ? '跟随视觉理解' : recreation.optimizerSource === 'manual' ? '单独指定' : recreation.optimizerSource === 'fallback' ? '当前回退' : '系统默认'}）` : ''}`}
                    >
                      由 {recreation.modelName} 优化{recreation.optimizedAt ? ` · ${new Date(recreation.optimizedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
                    </span>
                  )}
                </div>
                <p className="vision-final-desc">{FINAL_PROMPT.desc}</p>
                {changeSummary && (changeSummary.items.length > 0 || changeSummary.contextLines.length > 0) && (
                  <div className="vision-change-summary" aria-label={FINAL_PROMPT.summaryTitle}>
                    <span className="vision-change-summary-title">{FINAL_PROMPT.summaryTitle}</span>
                    {changeSummary.items.length > 0 && (
                      <ul className="vision-change-summary-list">
                        {changeSummary.items.map(item => (
                          <li key={item.key} className="vision-change-summary-item">
                            <span className={`vision-change-summary-label tone-${item.status === 'applied' ? 'ok' : 'pending'}`}>
                              {item.label}
                            </span>
                            <span className="vision-change-summary-text">{item.text}</span>
                            <span className={`vision-change-summary-status is-${item.status}`}>
                              {item.status === 'applied' ? FINAL_PROMPT.summaryStatusApplied : FINAL_PROMPT.summaryStatusPlanned}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {changeSummary.contextLines.length > 0 && (
                      <p className="vision-change-summary-context">{changeSummary.contextLines.join('；')}</p>
                    )}
                  </div>
                )}
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
                    {changeSummary && changeSummary.items.length > 0 && (
                      <div className="vision-change-summary is-keychanges">
                        <span className="vision-change-summary-title">{FINAL_PROMPT.keyChangesTitle}</span>
                        <ul className="vision-change-summary-list">
                          {changeSummary.items.map(item => (
                            <li key={item.key} className="vision-change-summary-item">
                              <span className="vision-change-summary-key">{item.label}</span>
                              <span className="vision-change-summary-text">
                                {item.status === 'applied' ? item.text : `新增${item.label}修改约束：${item.text}`}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <p className="vision-change-summary-context">{FINAL_PROMPT.keyChangesHint}</p>
                      </div>
                    )}
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
                <li>视觉分析：{selectedOption?.displayName ?? selectedModelId ?? '—'}</li>
                <li>Prompt 优化：{optimizerResolution.ok
                  ? `${optimizerResolution.resolved.displayName}${optimizerSourceSuffix || ' · 系统默认'}`
                  : (recreation.optimizedBy === 'optimizer' && recreation.modelName ? `${recreation.modelName}（历史优化）` : '未优化（原始复刻 Prompt）')}</li>
                <li>图片生成：gpt-image-2（服务端计费）</li>
                <li>AI 评价：{evaluationResolution.ok ? evaluationResolution.resolved.displayName : '未配置视觉模型（生成后不评价）'}</li>
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

      </div>{/* .vision-main 结束 */}

      {/* ===== Context Rail（§25：当前执行合同 + CTA 唯一渲染处；桌面 sticky） ===== */}
      <ContextRail
        project={activeProject}
        recreationNeedsOptimization={!!recreation && needsOptimization(recreation)}
        optimizerModelLabel={optimizerModelLabel}
        optimizerSourceSuffix={optimizerSourceSuffix}
        visionModelLabel={selectedOption?.displayName ?? selectedModelId ?? ''}
        disabled={busy || running || optimizing}
        showUseLastPrompt={showUseLastPrompt}
        onUseLastPrompt={useLastSuccessfulPrompt}
        onReoptimize={() => void optimizeRecreationPrompt(true)}
        onOptimize={() => void optimizeRecreationPrompt(false)}
        onGenerate={openGenerateConfirm}
      />
      </div>{/* .vision-workbench 结束 */}

      {/* ===== 更换识别图确认（§5：保留修改意图 / 重新开始） ===== */}
      {sourceChangeConfirm && (
        <div className="vision-modal-overlay" onClick={() => setSourceChangeConfirm(null)}>
          <div className="vision-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="更换识别图">
            <div className="vision-modal-header">
              <h3>更换识别图</h3>
            </div>
            <p className="vision-modal-desc">更换识别图后，将以新图片重新建立模板（需要重新执行识别）。</p>
            <div className="vision-modal-footer">
              <button className="vision-btn" onClick={() => setSourceChangeConfirm(null)}>取消</button>
              <button className="vision-btn" onClick={() => confirmSourceChange(false)}>重新开始</button>
              <button className="vision-btn vision-btn-primary" onClick={() => confirmSourceChange(true)}>保留当前修改意图</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 图库选择（source = 更换参考图；person = 人物替换参考；mention = @引用加入当前任务） ===== */}
      {galleryOpen && (
        <div className="vision-modal-overlay" onClick={() => setGalleryOpen(false)}>
          <div className="vision-modal vision-gallery-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={galleryPurpose === 'person' || galleryPurpose === 'region-person' ? '从图片库选择人物' : '从图片库选择'}>
            <div className="vision-modal-header">
              <h3>{galleryPurpose === 'person' || galleryPurpose === 'region-person' ? '从图片库选择人物' : galleryPurpose === 'mention' ? '选择要引用的图片' : '从图片库选择'}</h3>
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
                      } else if (galleryPurpose === 'region-person') {
                        const regionId = pendingRegionRefIdRef.current;
                        const pstate = useVisualProjectStore.getState();
                        if (pstate.active && regionId) {
                          pstate.updateActive('references', project => {
                            const existing = project.references.find(ref => ref.path === img.local_path);
                            const refId = existing?.id ?? `ref-${crypto.randomUUID().slice(0, 8)}`;
                            const references = existing
                              ? project.references
                              : [...project.references, { id: refId, assetId: img.id, path: img.local_path, label: img.file_name, kind: 'person' as const, source: 'gallery' as const }];
                            return {
                              ...project,
                              status: 'modified',
                              references,
                              regions: project.regions.map(item => item.id === regionId ? { ...item, personReferenceId: refId } : item),
                            };
                          });
                        }
                        pendingRegionRefIdRef.current = null;
                      } else if (galleryPurpose === 'mention') {
                        // 加入当前任务附加参考图（池内可 @ 引用；一次消费回填到输入框）
                        const current = useVisionWorkspaceStore.getState().modificationDraft;
                        const exists = current.extraImageRefs.some(ref => ref.path === img.local_path)
                          || useVisionWorkspaceStore.getState().sourcePath === img.local_path
                          || (personHasImage(current.person) && current.person!.path === img.local_path);
                        if (!exists) {
                          useVisionWorkspaceStore.getState().setModificationDraft({
                            ...current,
                            extraImageRefs: [...current.extraImageRefs, { assetId: img.id, path: img.local_path, label: img.file_name }],
                          });
                        }
                        setPendingGalleryImage({ assetId: img.id, path: img.local_path, label: img.file_name });
                      } else {
                        applySourceSelection(img.local_path, img.id);
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
