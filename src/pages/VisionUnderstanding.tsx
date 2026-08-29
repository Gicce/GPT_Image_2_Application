import { useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { api } from '../services/api';
import { serverApi, type BillingQuote } from '../services/serverApi';
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
  PLAN_FIELD_LABELS,
  revertToLastSuccessfulPrompt,
  togglePlanFieldLock,
  type RecreationFieldKey,
  type RecreationState,
} from '../features/vision/recreationPlan';
import { buildRecreationOptimizationInstruction } from '../features/vision/recreationOptimizationInput';
import {
  lockBaselineValues,
  lockedDimensionKeys,
  validateDimensionLockContract,
} from '../features/vision/project/dimensionLock';
import {
  clearPersonReplacement,
  clothingReadinessError,
  detectExplicitModificationDimensions,
  EMPTY_MODIFICATION_DRAFT,
  isModificationDraftEmpty,
  personHasImage,
  setClothingPolicy,
  setPersonReplacement,
  toggleModificationDimension,
  toggleReplicationBoost,
  modificationDimensionLabel,
  readDimensionRequirement,
  writeDimensionRequirement,
  type DimensionReferenceImage,
  type ModificationDraft,
  type ModificationDimension,
  type PersonReplacement,
} from '../features/vision/modificationIntent';
import { buildGenerationProvenance, resolveGenerationImageReferences } from '../features/vision/generationProvenance';
import {
  contractCorrectionSeverity,
  lockCorrectionSeverity,
  newHandoffOperationId,
  shouldShowCorrectionToast,
} from '../features/vision/handoffOperation';
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
  SAVE_AS_SKILL_ACTION,
  UNDERSTANDING,
  optimizeFailureMessage,
} from '../features/vision/recreationCopy';
import VisualAnalysisProgress from '../features/vision/VisualAnalysisProgress';
import ModificationChips from '../features/vision/ModificationChips';
import { VISION_WIZARD_STEPS, visionStepReachable, getVisualWorkflowState, type VisionWizardContext, type VisionWizardStep } from '../features/vision/visionWizard';
import OptimizeProgressCard from '../features/vision/OptimizeProgressCard';
import { isOptimizationRunning, type PromptOptimizationStatus } from '../features/vision/optimizeProgress';
import PersonReplacementPanel from '../features/vision/PersonReplacementPanel';
import ClothingChangePanel from '../features/vision/ClothingChangePanel';
import DimensionEditPanel from '../features/vision/DimensionEditPanel';
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
import type { GenerationImageReference, ImageMeta, ImageRecord } from '../types';
import { SIZES, QUALITIES, QUALITY_LABELS } from '../types';
import './VisionUnderstanding.css';
import { useVisualProjectStore } from '../store/useVisualProjectStore';
import {
  EMPTY_MODIFICATION_CONTRACT,
  describeProjectStatus,
  normalizeModificationContract,
  reapplyTemplateFromAnalysis,
  setProjectPersonContract,
  toModificationContract,
} from '../features/vision/project/project';
import { mergePersonContract } from '../features/vision/project/personContract';
import { enabledRasterRegions } from '../features/vision/project/region';
import { isLegacyWorkspaceMigratable, isLegacyWorkspaceAlreadyMigrated, migrateLegacyWorkspace } from '../features/vision/project/migrate';
import VisualProjectLibrary from '../features/vision/project/VisualProjectLibrary';
import SkillTraceDrawer from '../features/vision/skills/SkillTraceDrawer';
import { buildSkillExecutionSnapshot, compiledSectionsOf } from '../features/vision/skills/engine';
import { useRuntimeSkillStore } from '../store/useRuntimeSkillStore';
import { validateGenerationContract } from '../features/vision/project/validators';
import { buildOptimizerHardContractLines } from '../features/vision/project/optimizerContract';
import { mergeFinalGenerationPrompt } from '../features/vision/project/promptCompiler';
import { requiredContractBlocks, validateSkillOriginContractCoverage } from '../features/vision/project/skillOriginGuard';
import {
  bindDetailInsertsToCharacter,
  characterAssetFingerprint,
  isCharacterAssetReusable,
  referenceAppearanceMatches,
  validateAnimeCharacterConsistency,
} from '../features/vision/project/animeCharacter';
import {
  countInsertInstances, mergeDetailInsertRepairResults,
} from '../features/vision/project/detailInsert';
import {
  runDetailInsertRepair,
  type DetailRepairProgress,
} from '../features/vision/project/detailInsertRepairRunner';
import { ensureReferenceAppearance } from '../features/vision/project/referenceAppearanceService';
import {
  animeCharacterReferenceImage,
  requestCharacterAssetGeneration,
  withAnimeCharacterReference,
} from '../features/vision/project/animeCharacterAssetService';
import {
  CLOTHING_CONFLICT_ERROR,
  extractTemplateClothingTokens,
  clothingSourceIsPersonReference,
} from '../features/vision/project/clothingGuard';
import { describeTemplateProvenance, describeTemplateSnapshot } from '../features/vision/project/template';
import { exportMaskPngBase64 } from '../features/vision/region/regionMask';
import RegionEditorPanel from '../features/vision/region/RegionEditorPanel';
import ContextRail from '../features/vision/project/ContextRail';
import ProjectHeaderBar from '../features/vision/project/ProjectHeaderBar';
import ProjectPreviewPanel from '../features/vision/project/ProjectPreviewPanel';
import { buildGenerationNegativeAddendum } from '../features/vision/generationDirective';
import type { PersonReplacementContract, VisualProject } from '../features/vision/project/types';
import SkillCreatorDialog from '../features/skillWorkshop/SkillCreatorDialog';

/** 启用中的多人区域按画面顺序解析各自人物图；同一路径仅提交一次。 */
function regionPersonReferencesOf(project: VisualProject | null | undefined) {
  if (!project) return [];
  const seen = new Set<string>();
  return project.regions.flatMap(region => {
    if (!region.enabled || region.replaceType !== 'person' || !region.personReferenceId) return [];
    const ref = project.references.find(item => item.id === region.personReferenceId);
    const key = ref?.path?.replace(/\\/g, '/').toLowerCase();
    if (!ref || !key || seen.has(key)) return [];
    seen.add(key);
    return [{ path: ref.path, assetId: ref.assetId, label: ref.label }];
  });
}

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
  const {
    projectPreviewCollapsed,
    customContentCollapsed,
    personReplacementCollapsed,
    clothingChangeCollapsed,
    dimensionEditorCollapsed,
    dimensionsCollapsed,
    advancedCollapsed,
    analysisDetailCollapsed,
    promptView,
    wizardStep,
  } = view;

  // ===== Visual Project（V4.1 Workbench V2：项目化状态唯一载体；恢复绝不重调分析 API） =====
  const projectStore = useVisualProjectStore();
  const activeProject = projectStore.active;
  const hydratingProjectRef = useRef(false);
  /** 更换识别图后的模板重建模式（保留意图 / 重新开始；重新分析完成时消费）。 */
  const pendingTemplateModeRef = useRef<'keep' | 'restart'>('keep');
  /** 区域人物参考绑定中的区域 id（图库选择完成时消费）。 */
  const pendingRegionRefIdRef = useRef<string | null>(null);
  /** 动作 / 背景 / 镜头 / 风格 / 服装参考图选择完成时消费。 */
  const pendingDimensionPurposeRef = useRef<DimensionReferenceImage['purpose']>(undefined);
  const [sourceChangeConfirm, setSourceChangeConfirm] = useState<{ path: string; assetId?: string } | null>(null);
  /** 区域编辑器外部打开信号（递增计数；PersonPanel「打开区域编辑器」入口触发）。 */
  const [regionEditorOpenRequest, setRegionEditorOpenRequest] = useState(0);
  const [regionEditorPurpose, setRegionEditorPurpose] = useState<'custom' | 'person'>('custom');
  /**
   * V6.8 Prompt 优化真实进度（阶段型；idle = 不显示进度卡）。
   * 只存真实事实（阶段 / 开始时间 / 错误文本），百分比由 UI 从阶段锚点派生。
   */
  const [optimizeProgress, setOptimizeProgress] = useState<{ status: PromptOptimizationStatus; startedAt: number; errorText?: string }>({ status: 'idle', startedAt: 0 });
  /** completed 进度卡短暂展示后自动复位（新运行 / 卸载时清理）。 */
  const optimizeProgressTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (optimizeProgressTimerRef.current) window.clearTimeout(optimizeProgressTimerRef.current);
  }, []);
  const scheduleOptimizeProgressReset = () => {
    if (optimizeProgressTimerRef.current) window.clearTimeout(optimizeProgressTimerRef.current);
    optimizeProgressTimerRef.current = window.setTimeout(() => {
      optimizeProgressTimerRef.current = null;
      setOptimizeProgress({ status: 'idle', startedAt: 0 });
    }, 2500);
  };

  // ===== 仅进程内 UI 状态（预览图 / 弹层 / 轮询细节，不持久化） =====
  const [previewUrl, setPreviewUrl] = useState('');
  const [meta, setMeta] = useState<ImageMeta | null>(null);
  /** 图库弹层用途：source = 更换参考图；person = 人物替换参考；mention = @引用加入当前任务。 */
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [skillCreatorOpen, setSkillCreatorOpen] = useState(false);
  /** Skill Trace Drawer（skills = 技能执行过程；prompt = Prompt 来源反查）。 */
  const [skillTraceMode, setSkillTraceMode] = useState<'skills' | 'prompt' | null>(null);
  /** Prompt 来源实况预览（打开时按当前方案确定性编译一次；不落库、不加修订）。 */
  const [livePromptSections, setLivePromptSections] = useState<ReturnType<typeof compiledSectionsOf> | null>(null);
  /** V6 实况编译全文 + 合同层名（模板复用 Skill 与保存基线的对比视图用）。 */
  const [livePromptText, setLivePromptText] = useState('');
  const [liveCompilerSections, setLiveCompilerSections] = useState<string[]>([]);

  /** 打开 Prompt 来源反查（§39/§40：默认纯文本 Prompt，来源在侧栏按段标识）。 */
  const openPromptSource = () => {
    if (!activeProject) return;
    const currentDraft = useVisionWorkspaceStore.getState().modificationDraft;
    const wstore = useVisionWorkspaceStore.getState();
    const personRefPath = personHasImage(currentDraft.person)
      ? currentDraft.person!.path
      : (mentionResolution.person?.origin === 'mention' ? mentionResolution.person.path : undefined);
    const refs = resolveGenerationImageReferences({
      draft: currentDraft,
      sourcePath: wstore.sourcePath || undefined,
      sourceAssetId: wstore.sourceAssetId || undefined,
      templateLabel: mentionResolution.template?.label,
      personMention: !currentDraft.person && mentionResolution.person?.origin === 'mention'
        ? {
          path: mentionResolution.person.path,
          assetId: mentionResolution.person.assetId,
          label: mentionResolution.person.label,
        }
        : undefined,
      regionPersonReferences: regionPersonReferencesOf(activeProject),
    });
    const personEnabled = !!refs.some(ref => ref.role === 'person_reference')
      && (!!currentDraft.person || !!personRefPath);
    const compiled = mergeFinalGenerationPrompt({
      project: activeProject,
      finalDescription: wstore.promptDraft.trim(),
      negativePrompt: wstore.negativeDraft.trim(),
      imageReferences: refs,
      personReplacementEnabled: personEnabled,
      styleDirection: currentDraft.activeDimensions.includes('style') ? currentDraft.freeText.trim().slice(0, 40) : undefined,
      includeRegions: useRuntimeSkillStore.getState().isSkillDisabled('region_replacement') ? false : undefined,
      ...(activeProject.workspace.fullPromptOverride?.trim()
        ? { fullPromptOverride: activeProject.workspace.fullPromptOverride }
        : {}),
    });
    setLivePromptSections(compiledSectionsOf(compiled));
    setLivePromptText(compiled.prompt);
    setLiveCompilerSections(compiled.sections);
    setSkillTraceMode('prompt');
  };
  const [galleryPurpose, setGalleryPurpose] = useState<'source' | 'person' | 'mention' | 'region-person' | 'dimension-reference'>('source');
  /** @弹层「从图片库选择」回填（一次消费，IntentMentionInput 在记忆光标处插入）。 */
  const [pendingGalleryImage, setPendingGalleryImage] = useState<{ assetId?: string; path: string; label?: string } | null>(null);
  /** 「已识别图片角色」建议条忽略态（视图；签名变化后可再次出现）。 */
  const [dismissedSuggestion, setDismissedSuggestion] = useState('');
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [galleryUrls, setGalleryUrls] = useState<Record<string, string>>({});
  const [autoEvaluate, setAutoEvaluate] = useState(() => readEvaluationSettings().autoEvaluate);
  const [generateConfirmOpen, setGenerateConfirmOpen] = useState(false);
  const [generateQuote, setGenerateQuote] = useState<BillingQuote | null>(null);
  const [generateQuoteLoading, setGenerateQuoteLoading] = useState(false);
  /**
   * V6.2 Handoff Responsiveness：确认点击 → 弹窗 100ms 级关闭 + 过渡态
   * 「正在进入图片工作室…」；重活（人物外貌事实解析 / 合同编译 / mask 导出）
   * 在过渡态下完成，绝不把耗时工作藏在确认弹窗里伪装成卡死。
   */
  const [handoffPreparing, setHandoffPreparing] = useState(false);
  /** 防重入：一次确认生成只允许一个交接在途（双击 / 事件重放直接忽略）。 */
  const handoffInFlightRef = useRef(false);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  /** 删除当前项目确认（应用内弹窗，替代原生 confirm——Tauri 下不可靠且违反应用弹窗规范）。 */
  const [pickerDeleting, setPickerDeleting] = useState<{ id: string; name: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cancelRef = useRef(false);
  const intentInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [running, setRunning] = useState(false);
  const [stageDetail, setStageDetail] = useState('');
  /** 输入辅助：自动识别只补充结构化 Chip，用户手动选择拥有最高优先级。 */
  const [autoDetectedDimensions, setAutoDetectedDimensions] = useState<ModificationDimension[]>([]);
  const autoIntentTimerRef = useRef<number>(0);
  const autoIntentInitializedRef = useRef(false);
  const manualDimensionOverridesRef = useRef<Map<ModificationDimension, boolean>>(new Map());

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

  // 项目生命周期：挂载恢复索引（空列表 → 扫描修复摘要列漂移 → 一次性 Toast）；
  // legacy workspace（有分析结果且未迁移过）→ 未命名视觉项目（§36，绝不重新分析）。
  // 迁移幂等：marker 指纹命中即跳过（同一次识别会话绝不复制第二个项目）。
  useEffect(() => {
    void (async () => {
      const recovered = await useVisualProjectStore.getState().ensureProjectIndex();
      if (recovered > 0) toastSuccess(`已恢复 ${recovered} 个视觉项目`, '项目索引已修复');
    })();
    const wstate = useVisionWorkspaceStore.getState();
    const legacyInput = {
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
    };
    if (!useVisualProjectStore.getState().active
      && isLegacyWorkspaceMigratable(wstate) && wstate.analysis
      && !isLegacyWorkspaceAlreadyMigrated(legacyInput)) {
      const migrated = migrateLegacyWorkspace(legacyInput);
      if (migrated) void useVisualProjectStore.getState().adoptProject(migrated);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // workspace → 项目镜像（项目打开期间，工作区语义字段变化同步进项目文档并防抖落库；
  // hydrate 期间跳过，避免 project → workspace → project 回写循环）
  // analysis / reverseResult / 任务关联必须入依赖：分析完成若不触发镜像，
  // 持久化文档会永远保留旧 analysis（重新打开 = 又要求重新理解）
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
    analysis,
    reverseResult,
    visionTaskId,
    sessionId,
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
    for (const ref of regionPersonReferencesOf(activeProject)) {
      if (refs.some(item => item.path.replace(/\\/g, '/').toLowerCase() === ref.path.replace(/\\/g, '/').toLowerCase())) continue;
      refs.push({ path: ref.path, label: ref.label ?? '区域人物参考', role: 'generic_reference' });
    }
    for (const ref of modificationDraft.extraImageRefs) {
      if (ref.purpose && !modificationDraft.activeDimensions.includes(ref.purpose)) continue;
      if (ref.path === sourcePath || ref.path === personPath) continue;
      refs.push({
        path: ref.path,
        label: ref.label ?? '维度参考图',
        role: ref.purpose === 'scene' ? 'background_reference'
          : ref.purpose === 'style' ? 'style_reference' : 'generic_reference',
      });
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
        // Canonical Restore 修复：重新分析后 workspace（analysis / 编译产物 / 复刻方案）
        // 必须随模板重建一起落进项目文档——否则保存的文档永远带着旧 analysis
        const wstateReapply = useVisionWorkspaceStore.getState();
        pstate.updateActive('template', draft => reapplyTemplateFromAnalysis(draft, {
          analysis: analysisSnapshot,
          plan: nextRecreation.plan,
          recreation: nextRecreation,
          sourceAsset,
          keepModification,
          analysisModel,
          workspace: {
            profileId: wstateReapply.profileId,
            modelId: wstateReapply.modelId,
            mode: wstateReapply.mode,
            analysis: analysisSnapshot,
            reverseResult: compiled,
            originalPromptDraft: wstateReapply.originalPromptDraft,
            promptDraft: wstateReapply.promptDraft,
            negativeDraft: wstateReapply.negativeDraft,
            recreation: nextRecreation,
            genParams: nextGenParams,
            generationMode: wstateReapply.generationMode,
            hfTarget: wstateReapply.hfTarget,
            hfMaxIterations: wstateReapply.hfMaxIterations,
            report: null,
            iterations: [],
            visionTaskId: taskId,
            sessionId: newSessionId,
          },
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
    setGenerateQuote(null);
    setGenerateQuoteLoading(true);
    void serverApi.createQuote('image', genParams.count)
      .then(quote => setGenerateQuote(quote))
      .catch(() => setGenerateQuote(null))
      .finally(() => setGenerateQuoteLoading(false));
  };

  const intentSummary = useMemo(() => {
    const instruction = recreation?.adjustInstruction?.trim();
    return instruction ? `修改意图 → ${instruction.slice(0, 80)}${instruction.length > 80 ? '…' : ''}` : '未修改，直接复刻参考图方案';
  }, [recreation]);

  // ===== V5 动漫角色一致性（模式切换 / 角色参考图 / 局部插图补充识别）=====

  const [assetRequesting, setAssetRequesting] = useState(false);
  /**
   * V6.2 Repair 进度态（替代 V6.1 的三个布尔/字符串 useState）：
   *  - 进度按 projectId + revision + operationId 隔离，切项目后 Rail 不再渲染
   *     旧项目的进度（V6.1 串台竞态：A 的识别结果会写进 B 并落库）；
   *  - 只有真实事实（阶段 / 已完成层数 / 起始时间），无百分比字段。
   */
  const [insertRepairProgress, setInsertRepairProgress] = useState<DetailRepairProgress | null>(null);
  /** 层间诚实取消（isCancelled 轮询；已完成层照常合并）。 */
  const insertRepairCancelRef = useRef(false);
  const insertRepairing = insertRepairProgress?.status === 'running';
  const insertRepairError = insertRepairProgress?.status === 'error' ? (insertRepairProgress.error ?? '') : '';
  const insertRepairSummary = insertRepairProgress && insertRepairProgress.status !== 'error' && insertRepairProgress.status !== 'running'
    ? (insertRepairProgress.summary ?? '')
    : '';

  /** 动漫一致性模式切换（standard / strict_visual_reference；语义修改 → 项目修订）。 */
  const setAnimeConsistencyMode = (mode: 'standard' | 'strict_visual_reference') => {
    const pstate = useVisualProjectStore.getState();
    const current = pstate.active;
    if (!current) return;
    if (mode === 'strict_visual_reference') {
      pstate.updateActive('rendering_contract', draft => ({
        ...draft,
        animeConsistency: {
          mode,
          ...(draft.animeConsistency?.characterAsset
            && draft.animeConsistency.characterAsset.fingerprint === characterAssetFingerprint(draft)
            ? { characterAsset: draft.animeConsistency.characterAsset }
            : {}),
        },
      }));
      if (!isCharacterAssetReusable(current)) {
        toastInfo('强一致性会先创建一张「动漫角色参考图」（按 1 张图片生成计费，创建前会再次确认）；同条件再次生成将复用，不重复计费。', '动漫角色强一致性');
      }
    } else {
      pstate.updateActive('rendering_contract', draft => ({
        ...draft,
        animeConsistency: { mode, ...(draft.animeConsistency?.characterAsset ? { characterAsset: draft.animeConsistency.characterAsset } : {}) },
      }));
    }
  };

  /** 生成 / 重新生成动漫角色参考图（报价确认 → 任务创建 → 完成后自动回绑）。 */
  const generateCharacterAsset = async (force = false) => {
    const project = useVisualProjectStore.getState().active;
    if (!project || assetRequesting) return;
    setAssetRequesting(true);
    try {
      const outcome = await requestCharacterAssetGeneration(project, { force });
      if (outcome.ok) {
        toastSuccess(
          outcome.reused
            ? '已复用现有动漫角色参考图，本次不会新增费用。'
            : '已提交动漫角色参考图生成任务，完成后将自动绑定到当前项目。',
          '动漫角色参考',
        );
      } else if (!outcome.cancelled) {
        toastError(outcome.errorMessage ?? '角色参考图任务创建失败。', '动漫角色参考');
      }
    } finally {
      setAssetRequesting(false);
    }
  };

  /**
   * 受限局部插图补充识别（V5 §8 / V6.1 Recoverable Blocker 唯一 Repair 入口）：
   * 只补实例，不重写模板快照。V6.2 起执行体移入 detailInsertRepairRunner
   * （逐层串行 vision 提取复用既有 visionExtractDetailInserts，绝不建第二套
   * 识别），页面只负责：配置解析 / 进度渲染 / 对**最新**快照做纯函数合并
   * （mergeDetailInsertRepairResults）+ projectId 守卫 + updateActive 语义修订。
   * 失败保留旧分析并在 Rail 阻断卡内显示重试。
   */
  const repairDetailInsertInstances = async () => {
    const pstate = useVisualProjectStore.getState();
    const project = pstate.active;
    if (!project || insertRepairing) return;
    const counts = countInsertInstances(project.renderingContract);
    if (counts.incompleteRegions.length === 0) return;
    insertRepairCancelRef.current = false;
    setInsertRepairProgress(null);
    // 合并结果容器（闭包内赋值 + 外层读取；对象属性避免 TS 控制流窄化成 never）
    const applyOutcome: { outcome: ReturnType<typeof mergeDetailInsertRepairResults> | null } = { outcome: null };
    const final = await runDetailInsertRepair({
      project,
      resolveConfig: () => {
        const resolved = resolveByokVisionConfig({
          profileId: project.workspace.profileId || undefined,
          modelId: project.workspace.modelId || undefined,
        });
        return resolved.ok
          ? { ok: true as const, config: { baseUrl: resolved.baseUrl, token: resolved.token, model: resolved.model } }
          : { ok: false as const, error: resolved.error };
      },
      onProgress: setInsertRepairProgress,
      isCancelled: () => insertRepairCancelRef.current,
      applyResults: results => {
        // 合并必须对最新快照执行 + projectId 守卫：识别在途时用户可能切了项目
        const latest = useVisualProjectStore.getState().active;
        if (!latest || latest.id !== project.id) {
          return { applied: false, error: '项目已切换，本次识别结果已丢弃（未写入其它项目）。' };
        }
        if (!latest.templateSnapshot) {
          return { applied: false, error: '当前模板信息不完整，请重新分析模板后再补充识别。' };
        }
        const outcome = mergeDetailInsertRepairResults(latest.templateSnapshot, results);
        if (outcome.repaired <= 0) {
          return { applied: false, error: '本次没有识别到新的插图实例，可以稍后重试或重新分析模板。' };
        }
        applyOutcome.outcome = outcome;
        const merged = outcome.snapshot;
        // 语义修订（revision +1）：只覆盖实例相关字段，其余（originSkill / 人物替换 /
        // 锁定维度 / 用户修改）一律保留在最新 draft 上。
        useVisualProjectStore.getState().updateActive('detail_insert_repair', draft => ({
          ...draft,
          templateSnapshot: merged,
          renderingContract: merged.mediaStructure ?? draft.renderingContract,
        }));
        return {
          applied: true,
          summary: `已识别 ${outcome.after.total} 个局部插图，其中 ${outcome.after.anime} 个动漫插图已同步动漫主角色`
            + (outcome.after.incompleteRegions.length > 0 ? `；仍有 ${outcome.after.incompleteRegions.length} 层未识别，可再次补充` : '') + '。',
        };
      },
    });
    if (final.status === 'success' && applyOutcome.outcome) {
      const outcome = applyOutcome.outcome;
      toastSuccess(
        `已补充识别 ${outcome.repaired} 个插图层（现在共 ${outcome.after.total} 个局部插图实例${outcome.after.incompleteRegions.length > 0 ? `；仍有 ${outcome.after.incompleteRegions.length} 层未识别` : ''}）。`,
        '局部插图识别',
      );
    } else if (final.status === 'error') {
      toastError(final.error ?? '局部插图识别失败。', '局部插图识别');
    } else if (final.status === 'cancelled') {
      toastWarning('已停止补充识别，已识别的层已保留。', '局部插图识别');
    }
  };

  const generateFromPlan = async () => {
    // V6.2 防重入：一次确认只允许一个交接在途（双击 / 事件重放直接忽略）
    if (handoffInFlightRef.current) return;
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
      // Dimension Lock §20：锁定维度与模板基线冲突 ⇒ 阻断生成，绝不偷偷继续
      const lockErrors = validateDimensionLockContract(project);
      if (lockErrors.length > 0) {
        toastError(lockErrors[0], '生成前需处理');
        return;
      }
    }
    // ===== V6.2 Handoff Responsiveness =====
    // 同步守卫全部通过 → 立即关闭确认弹窗（100ms 级体感），切换到「正在进入
    // 图片工作室…」过渡态。重活（人物外貌事实解析 / Prompt 合同编译 / mask
    // 导出）在过渡态下完成；失败走 toast 回到工作台（弹窗不复活，可再次确认）。
    setGenerateConfirmOpen(false);
    setHandoffPreparing(true);
    handoffInFlightRef.current = true;
    const operationId = newHandoffOperationId();
    const handoffStartedAt = Date.now();
    const finishHandoff = () => {
      handoffInFlightRef.current = false;
      setHandoffPreparing(false);
      if (import.meta.env.DEV) {
        console.info('[VisionHandoff]', { operationId, totalMs: Date.now() - handoffStartedAt });
      }
    };
    const personPath = personHasImage(currentDraft.person)
      ? currentDraft.person!.path
      : (mentionResolution.person?.origin === 'mention' ? mentionResolution.person.path : undefined);
    // V4.0.9.1 生成参考图唯一解析：顺序 = 最终提交顺序（模板 → 人物 → 其余 @引用），
    // 同一份清单同时喂给溯源快照与生成 carry —— 快照与 payload 永不失配。
    let imageReferences = resolveGenerationImageReferences({
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
      regionPersonReferences: regionPersonReferencesOf(project),
    });
    // V5 Strict Visual Reference：可复用角色参考图作为第三参考图
    // （模板 -> 人物 -> 动漫角色参考 -> 其余 @引用；序号与合同中的图片N一致）
    if (project) {
      const animeReference = animeCharacterReferenceImage(project);
      if (animeReference) {
        const personIndex = imageReferences.findIndex(ref => ref.role === 'person_reference');
        const animeRef: GenerationImageReference = {
          path: animeReference.path,
          label: animeReference.label,
          role: 'anime_character_reference',
          ...(project.animeConsistency?.characterAsset?.libraryAssetId
            ? { assetId: project.animeConsistency.characterAsset.libraryAssetId }
            : {}),
        };
        imageReferences = withAnimeCharacterReference(imageReferences, animeRef);
      }
    }
    // V5 人物参考外貌事实：绑定人物参考但快照缺失/过期 -> 生成前解析一次并缓存
    // （失败不阻断：角色卡回落来源指示语义；下一次生成会再尝试）。
    // V6.2 预热：解析与后续同步装配（溯源快照构建）并行发起，等待点后移——
    // 这是确认后最重的一步（视觉模型调用），绝不让它在弹窗里同步阻塞。
    const appearanceStartedAt = Date.now();
    const appearancePromise = project && personPath && !referenceAppearanceMatches(project)
      ? ensureReferenceAppearance(project, {
        modelId: selectedModelId || undefined,
        displayName: selectedOption?.displayName ?? selectedModelId ?? undefined,
        providerName: selectedOption?.profileName,
      })
      : null;
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
    // V6.2 等待预热的外貌解析（此时同步装配已完成，等待点只剩纯 IO 时延）
    if (appearancePromise) {
      const appearance = await appearancePromise;
      if (appearance.ok && appearance.snapshot) {
        useVisualProjectStore.getState().updateActiveMeta(draft => ({
          ...draft,
          referenceAppearance: appearance.snapshot,
        }));
        project!.referenceAppearance = appearance.snapshot;
      }
      if (import.meta.env.DEV) {
        console.info('[VisionHandoff] appearanceMs', Date.now() - appearanceStartedAt);
      }
    }
    // V4.1 Prompt Compiler：项目合同全量编译（图片角色 / 人物 / 区域 / 媒介 / 服装 /
    // 维度 / 模板保留 + 最终画面描述）；优化器产物只作为「最终画面描述」层进入。
    let finalPromptText = promptDraft.trim();
    let finalNegativeText = negativeDraft.trim();
    let promptCompiled = false;
    let maskImagePath: string | undefined;
    if (project) {
      const personEnabled = !!imageReferences.some(ref => ref.role === 'person_reference')
        && (!!currentDraft.person || !!personPath);
      // V5 动漫一致性硬门禁（实例完整性 / strict 资产）：阻断文案 = 用户语言
      const animeErrors = validateAnimeCharacterConsistency(project);
      if (animeErrors.length > 0) {
        toastError(animeErrors[0], '生成前需处理');
        finishHandoff();
        return;
      }
      const compiled = mergeFinalGenerationPrompt({
        project,
        finalDescription: promptDraft.trim(),
        negativePrompt: negativeDraft.trim(),
        // V5 完整 Prompt 手动覆盖（Prompt Editor「完整 Prompt」模式冻结产物）
        ...(project.workspace.fullPromptOverride?.trim()
          ? { fullPromptOverride: project.workspace.fullPromptOverride }
          : {}),
        negativeAddendum: buildGenerationNegativeAddendum({
          imageReferences,
          personReplacementEnabled: personEnabled,
          clothingPolicy: currentDraft.clothingPolicy,
          customClothing: currentDraft.customClothing,
          ...(clothingSourceIsPersonReference(project) && extractTemplateClothingTokens(project).length > 0
            ? { templateClothingTokens: extractTemplateClothingTokens(project) }
            : {}),
        }),
        imageReferences,
        personReplacementEnabled: personEnabled,
        styleDirection: currentDraft.activeDimensions.includes('style') ? currentDraft.freeText.trim().slice(0, 40) : undefined,
        // 区域替换技能停用 = 真实效果：区域合同不编译进最终 Prompt
        includeRegions: useRuntimeSkillStore.getState().isSkillDisabled('region_replacement') ? false : undefined,
      });
      finalPromptText = compiled.prompt;
      finalNegativeText = compiled.negativePrompt;
      promptCompiled = true;
      // V6 Skill Origin Guard：模板复用 Skill 派生项目的最终 Prompt 缺任一关键
      // 合同块（或被手动覆盖降级）⇒ 阻断生成，绝不静默退化成摘要 Prompt
      const originErrors = validateSkillOriginContractCoverage(project, compiled, {
        regionContractDisabled: useRuntimeSkillStore.getState().isSkillDisabled('region_replacement'),
      });
      if (originErrors.length > 0) {
        toastError(originErrors[0], '生成前需处理');
        finishHandoff();
        return;
      }
      // Clothing Source Guard（E4 兜底）：服装来源 = 人物参考图时，最终 Prompt
      // 仍含模板服装元素 ⇒ 阻断生成（编译层已净化，这里是不可绕过的最后闸门）
      if (compiled.clothingConflicts.length > 0) {
        toastError(CLOTHING_CONFLICT_ERROR, '服装来源冲突');
        finishHandoff();
        return;
      }
      // Anime Character Consistency Guard（§22 兜底）：修正剥离后最终 Prompt
      // 仍许可「第二套动漫设计」⇒ 阻断生成（不得静默放行）
      if (compiled.animeConflicts.length > 0) {
        toastError(compiled.animeConflicts[0], '动漫角色一致性冲突');
        finishHandoff();
        return;
      }
      // V6.3 Notification Severity：系统已完成的修正 = success（绿）；
      // 唯一例外 = 被剥离内容来自用户当前文字要求（结果与用户要求不同 → warning）
      if (compiled.animeGuard && compiled.animeGuard.removedSentences.length > 0
        && shouldShowCorrectionToast(operationId, 'anime_guard')) {
        contractCorrectionSeverity() === 'success'
          ? toastSuccess(
            `已移除 ${compiled.animeGuard.removedSentences.length} 处会导致发型、脸型或服装变化的描述。`,
            '已保持动漫角色一致',
            { label: '查看执行过程', onClick: () => setSkillTraceMode('skills') },
          )
          : toastWarning(
            `已移除 ${compiled.animeGuard.removedSentences.length} 处会导致发型、脸型或服装变化的描述。`,
            '已保持动漫角色一致',
            { label: '查看执行过程', onClick: () => setSkillTraceMode('skills') },
          );
      }
      if (compiled.clothingGuard && compiled.clothingGuard.removedSentences.length > 0
        && shouldShowCorrectionToast(operationId, 'clothing_guard')) {
        contractCorrectionSeverity() === 'success'
          ? toastSuccess(
            `已移除 ${compiled.clothingGuard.removedSentences.length} 处模板服装描述。`,
            '已保持人物参考服装',
            { label: '查看执行过程', onClick: () => setSkillTraceMode('skills') },
          )
          : toastWarning(
            `已移除 ${compiled.clothingGuard.removedSentences.length} 处模板服装描述。`,
            '已保持人物参考服装',
            { label: '查看执行过程', onClick: () => setSkillTraceMode('skills') },
          );
      }
      // Dimension Lock §20 正文层守卫：锁定维度的漂移句已被拦截并回退模板基线——
      // 必须显式告知（不静默改写用户可见的最终 Prompt）
      if (compiled.lockGuard && compiled.lockGuard.removedSentences.length > 0
        && shouldShowCorrectionToast(operationId, 'lock_guard')) {
        const dimText = compiled.lockGuard.guardedDimensions
          .map(key => (key === 'pose' ? '动作' : key === 'camera' ? '镜头' : key))
          .join('、');
        const message = `已移除 ${compiled.lockGuard.removedSentences.length} 处冲突描述，并保持模板中的${dimText}不变。`;
        if (lockCorrectionSeverity(compiled.lockGuard.removedSentences, currentDraft.freeText) === 'success') {
          toastSuccess(message, '已保持锁定内容', { label: '查看执行过程', onClick: () => setSkillTraceMode('skills') });
        } else {
          toastWarning(message, '已保持锁定内容', { label: '查看执行过程', onClick: () => setSkillTraceMode('skills') });
        }
      }
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
        // §46 Character Diff 调试：canonical 角色卡 + 插图绑定（仅开发日志，不进正式 UI）
        const animeBinding = bindDetailInsertsToCharacter(project);
        if (animeBinding) {
          console.info('[AnimeCharacter]', {
            canonical: animeBinding.character,
            detailInsertBindings: animeBinding.bindings,
          });
        }
      }
      // Runtime Skill Trace（§34）：生成时刻冻结技能快照 + 编译分段进任务溯源
      // —— History「AI 技能与规则」读这里（当时版本，绝不读项目当前态重推断）
      const skillSnapshot = buildSkillExecutionSnapshot({
        project,
        imageReferences,
        disabledSkillIds: useRuntimeSkillStore.getState().disabledSkillIds,
        compiled,
      });
      provenance.skillExecutionSnapshot = skillSnapshot;
      // Canonical Anime Character（§43 Provenance）：角色卡 + 插图绑定随任务冻结
      // —— History 由此解释「这个相框为什么跟动漫主角色」；旧任务无此字段 = 功能前生成
      const animeBinding = bindDetailInsertsToCharacter(project);
      if (animeBinding) {
        const { character, bindings } = animeBinding;
        provenance.animeCharacterSnapshot = {
          id: character.id,
          sourceSubjectLabel: character.sourceSubjectLabel,
          identitySource: { kind: character.identitySource.kind, ...(character.identitySource.label ? { label: character.identitySource.label } : {}) },
          designSource: character.designSource,
          hair: character.hair.description,
          face: character.face.description,
          eyes: character.eyes.description,
          clothing: character.clothing.canonicalDescription,
          ...(character.expression.description ? { expression: character.expression.description } : {}),
          ...(character.hair.facts ? { hairFacts: character.hair.facts as unknown as Record<string, string> } : {}),
          consistencyMode: project.animeConsistency?.mode ?? 'standard',
        };
        provenance.detailInsertBindings = bindings.map(binding => ({
          instanceId: binding.instanceId,
          insertLabel: binding.insertLabel,
          mediaType: binding.mediaType,
          ...(binding.cropType ? { cropType: binding.cropType } : {}),
          ...(binding.positionLabel ? { positionLabel: binding.positionLabel } : {}),
          ...(binding.characterRef ? { characterRef: binding.characterRef } : {}),
          lockedAspects: binding.lockedAspects,
          allowedVariation: binding.allowedVariation,
        }));
      }
      useVisualProjectStore.getState().updateActiveMeta(draft => ({
        ...draft,
        skillExecution: skillSnapshot,
        enabledSkillIds: skillSnapshot.skills
          .filter(record => record.status === 'applied')
          .map(record => record.skillId),
        ...(animeBinding ? { animeCharacter: animeBinding.character } : {}),
      }));
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
    // 项目状态推进（生成中 + 冻结最终 Prompt；generationIds 由生成结果到达后以 meta 同步）
    if (project) {
      useVisualProjectStore.getState().updateActiveMeta(draft => ({
        ...draft,
        status: 'generating',
        latestFinalPrompt: finalPromptText.slice(0, 500),
      }));
    }
    finishHandoff();
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
    // V6.8：修改意图提交 = 回到编辑 ⇒ 素材替换确认位复位（无项目链路的持久化位；
    // 项目链路由 updateActive('modification') 内的 unconfirmMaterialReplacement 复位）
    if (useVisionWorkspaceStore.getState().materialReplacementDone) {
      useVisionWorkspaceStore.getState().setMaterialReplacementDone(false);
    }
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
    // V6.8.1 统一有效意图 → 优化输入：需求描述 + 维度/人物/服装 + 区域替换 +
    // 人物替换合同 V2 全部经 buildRecreationOptimizationInstruction 重组（禁止页面自拼）
    const pstate = useVisualProjectStore.getState();
    const instruction = buildRecreationOptimizationInstruction(nextDraft, pstate.active, {
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

  /**
   * 素材域项目合同变化（区域替换增删改 / 人物替换合同 V2 / 区域人物参考绑定）→
   * 重建统一优化输入指令落 recreation（V6.8.1）。
   * 这些变化以前只 bump project.revision：needsOptimization 恒为 false，用户改完
   * 区域 / 强度后旧最终 Prompt 仍被视为有效（可直接生成 / 保存技能）——核心链路缺口。
   * 统一走 applyModificationInstruction：指令变化 → semanticRevision +1 → 待优化；
   * 指令与历史快照完全一致时按快照模型自动复原，不强迫重复优化。
   */
  const syncRecreationInstructionFromProject = () => {
    const wstore = useVisionWorkspaceStore.getState();
    if (!wstore.recreation || wstore.recreation.editState === 'optimizing') return;
    const draft = wstore.modificationDraft;
    const resolution = resolveImageMentionRoles({
      freeText: draft.freeText,
      mentions: draft.mentions,
      pool: buildVisionContextImages({
        sourcePath: wstore.sourcePath || undefined,
        sourceAssetId: wstore.sourceAssetId || undefined,
        person: draft.person,
        extraReferences: draft.extraImageRefs,
        generatedResults,
      }),
    });
    const instruction = buildRecreationOptimizationInstruction(
      draft,
      useVisualProjectStore.getState().active,
      {
        template: resolution.template ? { label: resolution.template.label } : undefined,
        personMention: !draft.person && resolution.person?.origin === 'mention'
          ? { label: resolution.person.label }
          : undefined,
      },
    );
    const nextRecreation = applyModificationInstruction(wstore.recreation, instruction);
    wstore.setRecreation(nextRecreation);
    persistRecreation(nextRecreation);
  };

  /** 切换项目时重建自动识别会话；旧项目已有选择按用户确认项保护。 */
  useEffect(() => {
    autoIntentInitializedRef.current = false;
    manualDimensionOverridesRef.current = new Map();
    setAutoDetectedDimensions([]);
  }, [activeProject?.id]);

  /**
   * 输入停顿后自动勾选显式修改维度（不新增 AI 调用）：
   * - 仅使用保守短语规则；Prompt 优化器原有意图识别仍完整保留；
   * - 用户手动开/关的维度写入 override，自动识别永不反向覆盖；
   * - 所有语义变更仍走 commitModificationDraft 与既有归一化入口。
   */
  useEffect(() => {
    window.clearTimeout(autoIntentTimerRef.current);
    if (stage === 'analyzing' || running || recreation?.editState === 'optimizing') return;
    autoIntentTimerRef.current = window.setTimeout(() => {
      const current = useVisionWorkspaceStore.getState().modificationDraft;
      if (!autoIntentInitializedRef.current) {
        for (const key of current.activeDimensions) manualDimensionOverridesRef.current.set(key, true);
        autoIntentInitializedRef.current = true;
      }
      const detected = detectExplicitModificationDimensions(current.freeText);
      setAutoDetectedDimensions(detected);
      let next = current;
      const keys: ModificationDimension[] = ['subject', 'clothing', 'pose', 'scene', 'camera', 'style'];
      for (const key of keys) {
        const override = manualDimensionOverridesRef.current.get(key);
        const desired = override ?? detected.includes(key);
        if (next.activeDimensions.includes(key) !== desired) {
          next = toggleModificationDimension(next, key);
        }
      }
      if (next !== current) commitModificationDraft(next);
    }, 700);
    return () => window.clearTimeout(autoIntentTimerRef.current);
    // commitModificationDraft 只读取当前 store；依赖自由文本 / 项目 / busy 状态即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modificationDraft.freeText, activeProject?.id, stage, running, recreation?.editState]);

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
    manualDimensionOverridesRef.current.set(key, !current.activeDimensions.includes(key));
    commitModificationDraft(toggleModificationDimension(current, key));
  };

  /** 「提高复刻度」toggle：独立复刻强度偏好，不占维度槽位。 */
  const onToggleBoostChip = () => {
    const current = useVisionWorkspaceStore.getState().modificationDraft;
    commitModificationDraft(toggleReplicationBoost(current));
  };

  // ===== V6.7 四步向导（纯视图；门禁/自动前进不触碰语义链路） =====

  /** 向导上下文快照：从 workspace / 项目文档派生，供统一步骤状态 selector 与门禁判定。 */
  const wizardCtx: VisionWizardContext = {
    hasRecreation: Boolean(recreation),
    described: Boolean(modificationDraft.freeText.trim()) || modificationDraft.activeDimensions.length > 0,
    // V6.8 显式确认位：项目链路读 project.workspace（normalize 旧项目 = false 保守恢复）；
    // 无项目链路读 workspace 快照（旧快照缺省同为 false）。绝不从 editState 反推。
    materialConfirmed: activeProject
      ? activeProject.workspace.materialReplacementDone === true
      : ws.materialReplacementDone === true,
    promptReady: recreation ? !needsOptimization(recreation) : false,
  };
  /** 统一工作流步骤状态（唯一完成态来源；步骤栏 / Rail 进度卡共用）。 */
  const workflowState = getVisualWorkflowState(wizardCtx);

  /**
   * 素材替换完成唯一入口（V6.8 §七）：用户点击「继续 · 生成最终提示词」显式确认。
   * 工作流检查点不是方案内容 → 走 updateActiveMeta / 快照字段，不加修订、不触发待优化；
   * 确认后进入第 4 步。素材域修改会把确认位复位（updateActive / commitModificationDraft）。
   */
  const confirmMaterialReplacement = () => {
    const pstate = useVisualProjectStore.getState();
    if (pstate.active) {
      pstate.updateActiveMeta(draft => ({
        ...draft,
        workspace: { ...draft.workspace, materialReplacementDone: true },
      }));
    }
    useVisionWorkspaceStore.getState().setMaterialReplacementDone(true);
    useVisionViewStore.getState().setVisionStep(4);
  };

  /** 步骤栏点击：可随时回退；不可达时 toast 说明原因，绝不静默吞掉。 */
  const goWizardStep = (step: VisionWizardStep) => {
    const gate = visionStepReachable(step, wizardCtx);
    if (!gate.ok) {
      toastInfo(gate.reason ?? '请先完成前置步骤。');
      return;
    }
    view.setVisionStep(step);
  };

  /** 理解结果首次就绪（分析成功 / 载入项目）→ 自动从第 1 步进入第 2 步「需求描述」。 */
  const hadRecreationRef = useRef(Boolean(recreation));
  useEffect(() => {
    const has = Boolean(recreation);
    if (has && !hadRecreationRef.current && useVisionViewStore.getState().wizardStep === 1) {
      useVisionViewStore.getState().setVisionStep(2);
    }
    hadRecreationRef.current = has;
  }, [recreation]);

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
    // V6.8.1：替换范围 / 强度 / 身份应用 = 素材替换语义变化 → 最终 Prompt 过期
    syncRecreationInstructionFromProject();
  };

  /** 区域替换变更（语义事件；打开/折叠区域卡 = 视图操作不经过这里）。 */
  const onRegionsChange = (updater: (regions: VisualProject['regions']) => VisualProject['regions']) => {
    const pstate = useVisualProjectStore.getState();
    if (!pstate.active) return;
    pstate.updateActive('regions', project => ({ ...project, status: 'modified', regions: updater(project.regions) }));
    // V6.8.1：区域新增 / 编辑 / 删除 / 启停 / 换参考 = 素材替换语义变化 → 最终 Prompt 过期
    syncRecreationInstructionFromProject();
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

  const openMultiPersonMapping = () => {
    setRegionEditorPurpose('person');
    setRegionEditorOpenRequest(value => value + 1);
    window.setTimeout(() => {
      document.querySelector('[data-testid="region-canvas-editor"], [data-testid="region-panel"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };

  /** 维度参考图写入现有 extraImageRefs，并给服装参考补齐既有 custom 合同。 */
  const setDimensionReference = (
    purpose: NonNullable<DimensionReferenceImage['purpose']>,
    reference: Omit<DimensionReferenceImage, 'purpose'> | null,
  ) => {
    const current = useVisionWorkspaceStore.getState().modificationDraft;
    let next: ModificationDraft = {
      ...current,
      extraImageRefs: [
        ...current.extraImageRefs.filter(ref => ref.purpose !== purpose),
        ...(reference ? [{ ...reference, purpose }] : []),
      ],
    };
    if (purpose === 'clothing' && reference) {
      next = setClothingPolicy(next, 'custom');
      if (!next.customClothing.trim()) {
        next = { ...next, customClothing: '按照服装参考图更换服装、配饰与整体造型' };
      }
    }
    commitModificationDraft(next);
  };

  const pickDimensionReferenceFromGallery = (purpose: NonNullable<DimensionReferenceImage['purpose']>) => {
    pendingDimensionPurposeRef.current = purpose;
    setGalleryPurpose('dimension-reference');
    setGalleryOpen(true);
  };

  const pickDimensionReferenceFromLocal = async (purpose: NonNullable<DimensionReferenceImage['purpose']>) => {
    const file = await api.selectImageFile();
    if (!file) return;
    setDimensionReference(purpose, { path: file, label: file.split(/[\\/]/).pop() });
  };

  const updateDimensionRequirement = (
    dimension: Exclude<ModificationDimension, 'subject' | 'clothing'>,
    value: string,
  ) => {
    const current = useVisionWorkspaceStore.getState().modificationDraft;
    commitModificationDraft({
      ...current,
      freeText: writeDimensionRequirement(current.freeText, dimension, value),
    }, { debounce: true });
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
    useVisualProjectStore.getState().updateActiveMeta(draft => ({
      ...draft,
      workspace: { ...draft.workspace, fullPromptOverride: undefined },
    }));
    persistRecreation(next);
    toastSuccess(FINAL_PROMPT.useLastToast);
  };

  /** FinalPromptEditor 手动编辑 = 完整 Prompt 冻结；确认、提交与历史都读取同一文本。 */
  const editFinalPrompt = (value: string) => {
    ws.setPromptDraft(value);
    useVisualProjectStore.getState().updateActiveMeta(draft => ({
      ...draft,
      workspace: { ...draft.workspace, fullPromptOverride: value },
    }));
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
    // V6.8.1：优化输入 = 统一有效意图（需求描述 + 素材替换 + 区域替换 + 人物合同 V2）
    // 的完整重组，不是只发原始复刻 Prompt 或只发自由文本；历史残留（如切换服装来源后
    // 遗留的旧自定义服装描述）由 buildRecreationOptimizationInstruction 清洗为当前生效语义
    const instruction = buildRecreationOptimizationInstruction(
      // 复刻度增强技能停用 = 真实效果：优化指令不含复刻增强条款（工作台开关不受影响）
      useRuntimeSkillStore.getState().isSkillDisabled('replication_boost')
        ? { ...wstore.modificationDraft, replicationBoost: false }
        : wstore.modificationDraft,
      useVisualProjectStore.getState().active,
      {
        template: mentionResolution.template ? { label: mentionResolution.template.label } : undefined,
        personMention: !wstore.modificationDraft.person && mentionResolution.person?.origin === 'mention'
          ? { label: mentionResolution.person.label }
          : undefined,
      },
    );
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
    // V6.8 真实进度：进入「收集修改意图与参考图」阶段（输入组装 + 服务层读图）
    if (optimizeProgressTimerRef.current) window.clearTimeout(optimizeProgressTimerRef.current);
    setOptimizeProgress({ status: 'collecting', startedAt: Date.now() });
    // 双图角色语义（V4.0.9）：人物替换参考图 + 画面模板图 + @引用图，
    // 优化器模型具备视觉能力时全部以真实 image parts 附上（顺序 = 清单顺序）
    const personPath = personHasImage(wstore.modificationDraft.person) ? wstore.modificationDraft.person!.path : undefined;
    const imageReferences = buildOptimizerImageReferences();
    // 快捷 Chip 启用的维度 = 用户显式要求修改（方案行 must-change 标记，优化器必须执行）
    const forcedDimensions = wstore.modificationDraft.activeDimensions as RecreationFieldKey[];
    let outcome: Awaited<ReturnType<typeof optimizeVisionRecreation>>;
    // V4.1 §14：项目硬合同行（人物决策 / 服装来源 / 维度 / 区域 / 媒介结构）
    // 随请求进入【硬性合同】块——优化器只能表达，不能重新决定
    const activeProjectNow = useVisualProjectStore.getState().active;
    const hardContractLines = activeProjectNow
      ? buildOptimizerHardContractLines(activeProjectNow)
      : undefined;
    // Skill Trace 快照用生成链路同源的角色清单（模板 → 人物 → 其余引用）
    const traceImageReferences = resolveGenerationImageReferences({
      draft: wstore.modificationDraft,
      sourcePath: wstore.sourcePath || undefined,
      sourceAssetId: wstore.sourceAssetId || undefined,
      templateLabel: mentionResolution.template?.label,
      personMention: !wstore.modificationDraft.person && mentionResolution.person?.origin === 'mention'
        ? {
          path: mentionResolution.person.path,
          assetId: mentionResolution.person.assetId,
          label: mentionResolution.person.label,
        }
        : undefined,
      regionPersonReferences: regionPersonReferencesOf(activeProjectNow),
    });
    try {
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
        // V6.8 真实阶段回调（collecting → optimizing → validating）；只在真实边界触发
        onStage: stage => setOptimizeProgress(prev => (
          prev.status === 'idle' ? prev : { ...prev, status: stage }
        )),
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
      // V6.8 进度卡失败态：显示真实错误 + 重新优化入口，绝不停留在「正在优化」
      setOptimizeProgress(prev => ({ status: 'failed', startedAt: prev.startedAt, errorText: optimizeFailureMessage(outcome.error) }));
      toastError(optimizeFailureMessage(outcome.error), force ? '重新优化失败' : '优化失败');
      return;
    }
    const projectAtApply = useVisualProjectStore.getState().active;
    const next = applyOptimizationResult(optimizingState, {
      ...outcome.result,
      // Dimension Lock §21：优化器输出先过锁定清洗——锁定维度的越权改写被忽略
      dimensionLocks: projectAtApply
        ? {
          lockedKeys: lockedDimensionKeys(projectAtApply),
          baseline: lockBaselineValues(projectAtApply),
        }
        : undefined,
    });
    const latest = useVisionWorkspaceStore.getState();
    latest.setRecreation(next);
    latest.setPromptDraft(next.optimizedPrompt ?? '');
    latest.setNegativeDraft(next.optimizedNegativePrompt ?? '');
    useVisualProjectStore.getState().updateActiveMeta(draft => ({
      ...draft,
      workspace: { ...draft.workspace, fullPromptOverride: undefined },
    }));
    persistRecreation(next);
    // Runtime Skill Trace（§33）：优化完成 → 冻结技能执行快照进项目当前态
    // （History 的「当时态」在生成时刻另经 provenance.skillExecutionSnapshot 冻结）
    const projectForTrace = useVisualProjectStore.getState().active;
    if (projectForTrace) {
      const snapshot = buildSkillExecutionSnapshot({
        project: { ...projectForTrace, optimizedRevision: next.optimizedRevision },
        imageReferences: traceImageReferences,
        disabledSkillIds: useRuntimeSkillStore.getState().disabledSkillIds,
        optimizer: {
          applied: true,
          triggeredBy: force ? 'user' : 'auto',
          model: {
            displayName: outcome.result.modelName,
            modelId: outcome.result.optimizerModelId,
            providerName: outcome.result.providerName,
            source: outcome.result.optimizerSource,
          },
          hardContractLineCount: hardContractLines?.length ?? 0,
          ignoredViolations: next.optimizerViolations,
          fallback: outcome.result.optimizerSource === 'fallback'
            ? {
              requestedModel: outcome.result.optimizerRequestedModelId || '原模型',
              actualModel: outcome.result.modelName,
              reason: outcome.result.optimizerFallbackReason,
            }
            : null,
        },
      });
      const optimizerAnimeCharacter = bindDetailInsertsToCharacter(projectForTrace)?.character;
      useVisualProjectStore.getState().updateActiveMeta(draft => ({
        ...draft,
        skillExecution: snapshot,
        enabledSkillIds: snapshot.skills
          .filter(record => record.status === 'applied')
          .map(record => record.skillId),
        ...(optimizerAnimeCharacter ? { animeCharacter: optimizerAnimeCharacter } : {}),
      }));
    }
    if (next.optimizerViolations && next.optimizerViolations.length > 0) {
      // 越权必须显式告知：优化器试图改写锁定维度，已强制以模板基线为准
      const labels = next.optimizerViolations.map(key => PLAN_FIELD_LABELS[key] ?? key).join('、');
      toastWarning(`已忽略优化器对锁定维度的改动（${labels}）——以画面模板基线为准`, '模板锁定生效');
    }
    toastSuccess(OPTIMIZE_TOAST.success, force ? '重新优化完成' : '优化完成');
    // V6.8 进度卡完成态：✓ 优化完成 100%（当前方案 / 最终 Prompt 修订状态已随
    // applyOptimizationResult 更新）；短暂展示后复位，按钮区恢复
    setOptimizeProgress(prev => ({ status: 'completed', startedAt: prev.startedAt }));
    scheduleOptimizeProgressReset();
    // V6.7 四步向导：优化完成自动前进（第 2 步描述优化 → 进素材替换；第 3 步素材整理后优化 → 进最终提示词）。
    const currentWizardStep = useVisionViewStore.getState().wizardStep;
    if (currentWizardStep >= 2 && currentWizardStep < 4) {
      useVisionViewStore.getState().setVisionStep((currentWizardStep + 1) as VisionWizardStep);
    }
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

  /**
   * 删除项目统一入口（项目库 / 项目头部共用）：
   *  - 失败 → lastError 已由 store 写入，这里补 Toast（Library 弹层不显示 lastError）；
   *  - 删除当前打开项目 → 原子清理：关 Library / 关技能抽屉 / 重置工作区回空态
   *    （绝不留下「无项目但工作区仍满载」的僵尸态——重进页面会被 legacy 迁移复活）；
   *  - 删除非当前项目 → 列表即时刷新，不打断当前工作。
   */
  const handleDeleteProject = (id: string) => {
    const wasActive = useVisualProjectStore.getState().active?.id === id;
    void useVisualProjectStore.getState().deleteProject(id).then(() => {
      const failure = useVisualProjectStore.getState().lastError;
      if (failure) {
        toastError(failure, '项目删除失败');
        return;
      }
      if (wasActive) {
        setLibraryOpen(false);
        setSkillTraceMode(null);
        restartWorkspace();
      }
      toastSuccess('项目已删除');
    });
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

  /**
   * 「复刻成我的技能」可用判定（V6.8.1 恢复；沿用技能创建链路旧业务条件）：
   * 有项目（SkillCreatorDialog 以项目为同源重建的事实源）+ 最终 Prompt 存在且有效
   * （非待重新优化、非优化中）。最终 Prompt 已过期时禁止用旧 Prompt 直接保存技能。
   */
  const canSaveAsSkill = Boolean(
    activeProject
    && recreation
    && !needsOptimization(recreation)
    && !optimizing
    && (recreation.optimizedPrompt ?? recreation.originalPrompt).trim(),
  );

  /**
   * 「复刻成我的技能」唯一 handler（V6.8.1 恢复；复用 V6.x 技能创建原链路，
   * 绝不另写一套保存逻辑）：冲刷项目在途语义与持久化 → 保存失败先重试 →
   * 打开 SkillCreatorDialog（同源重建可重放 Recipe → 技能工坊 · 我的技能）。
   * 项目头部「创建可复用技能」与本按钮共用同一入口。
   */
  const saveRecreationAsSkill = () => {
    const pstate = useVisualProjectStore.getState();
    pstate.flushPendingSemantic();
    void pstate.flushPersist().then(() => {
      if (useVisualProjectStore.getState().saveState.status === 'error') {
        toastError(SAVE_AS_SKILL_ACTION.savePendingToast);
        return;
      }
      setSkillCreatorOpen(true);
    });
  };

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

  /** V6 Skill Origin：模板复用项目当前态必需的合同块（Prompt 对比视图区分「降级缺失」与「按需未编译」）。 */
  const originRequiredBlocks = useMemo(
    () => (activeProject?.originSkill
      ? requiredContractBlocks(
        activeProject,
        useRuntimeSkillStore.getState().isSkillDisabled('region_replacement'),
      ).map(requirement => requirement.block)
      : undefined),
    [activeProject],
  );

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
        listError={projectStore.lastError}
        thumbUrl={previewUrl}
        visionModelLabel={selectedOption ? `${selectedOption.profileName} / ${selectedOption.displayName}` : (selectedModelId || '')}
        saving={projectStore.saveState.status === 'pending' || projectStore.saveState.status === 'saving'}
        saveState={projectStore.saveState}
        onRetrySave={() => { void useVisualProjectStore.getState().retrySave(); }}
        onRename={name => { void useVisualProjectStore.getState().renameActive(name); }}
        onSave={() => {
          const pstate = useVisualProjectStore.getState();
          pstate.flushPendingSemantic();
          void pstate.flushPersist().then(() => toastSuccess('项目已保存'));
        }}
        onSaveAsSkill={saveRecreationAsSkill}
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
        onOpenLibrary={() => setLibraryOpen(true)}
        onRetryList={() => { void useVisualProjectStore.getState().refreshList(); }}
        onNewProject={() => { restartWorkspace(); }}
        onDeleteProject={id => {
          setPickerDeleting({ id, name: activeProject?.name ?? '未命名视觉项目' });
        }}
      />

      {skillCreatorOpen && activeProject && (
        <SkillCreatorDialog
          project={activeProject}
          onClose={() => setSkillCreatorOpen(false)}
          onSaved={() => toastSuccess(SAVE_AS_SKILL_ACTION.savedToast)}
        />
      )}

      {/* ===== 全部项目（§8：筛选 / 项目卡 / 打开 / 重命名 / 复制 / 派生 / 删除确认） ===== */}
      {libraryOpen && (
        <VisualProjectLibrary
          projects={projectStore.projects}
          activeProjectId={activeProject?.id}
          onClose={() => setLibraryOpen(false)}
          onOpenProject={id => {
            void useVisualProjectStore.getState().openProject(id).then(project => {
              if (project) {
                hydratingProjectRef.current = true;
                useVisualProjectStore.getState().hydrateWorkspaceFromActive();
                hydratingProjectRef.current = false;
              }
            });
          }}
          onRenameProject={(id, name) => { void useVisualProjectStore.getState().renameProjectById(id, name); }}
          onDuplicateProject={id => {
            void useVisualProjectStore.getState().duplicateProjectById(id).then(copy => {
              if (copy) toastSuccess(`已复制为「${copy.name}」`);
              else toastError('项目复制失败');
            });
          }}
          onDeriveProject={id => {
            void useVisualProjectStore.getState().deriveProjectById(id).then(derived => {
              if (derived) toastSuccess(`已创建「${derived.name}」，在项目列表中打开它`);
            });
          }}
          onDeleteProject={handleDeleteProject}
          onNewProject={() => { restartWorkspace(); }}
        />
      )}

      <div className="vision-workbench">
      <div className="vision-main">

      {/* ===== V6.7 四步向导：左侧步骤栏 + 当前步骤内容（能力零删减，纯视图重排） ===== */}
      <div className="vision-wizard">
        <aside className="vision-step-rail" aria-label="制作步骤">
          {VISION_WIZARD_STEPS.map(stepDef => {
            const reachable = visionStepReachable(stepDef.id, wizardCtx).ok;
            // V6.8 统一 selector：完成态只来自 getVisualWorkflowState，禁止分散猜测
            const stepStatus = workflowState.steps.find(step => step.id === stepDef.id)?.status ?? 'pending';
            const done = stepStatus === 'completed';
            const isCurrent = wizardStep === stepDef.id;
            return (
              <button
                key={stepDef.id}
                type="button"
                className={`vision-step-btn${isCurrent ? ' is-active' : ''}${done ? ' is-done' : ''}`}
                disabled={!reachable}
                aria-current={isCurrent ? 'step' : undefined}
                title={`${stepDef.id}. ${stepDef.title}——${stepDef.hint}${reachable ? '（点击回退调整）' : '（先完成前置步骤）'}`}
                onClick={() => goWizardStep(stepDef.id)}
              >
                <span className="vision-step-index" aria-hidden="true">{done && !isCurrent ? '✓' : stepDef.id}</span>
                <span className="vision-step-title">{stepDef.title}</span>
                <span className={`vision-step-state${done ? ' is-done' : ''}`}>{isCurrent ? '当前' : done ? '已完成' : stepStatus === 'current' ? '进行中' : reachable ? '待开始' : '未解锁'}</span>
              </button>
            );
          })}
          <p className="vision-step-rail-note">可随时点击已解锁步骤回退调整</p>
        </aside>
        <div className="vision-step-content">

      {/* ===== 1. 项目预览：原图 + 理解摘要 + 重新视觉理解（纯 UI 重排，原能力全部保留） ===== */}
      {wizardStep === 1 && (
      <ProjectPreviewPanel
        sourcePath={sourcePath}
        previewUrl={previewUrl}
        sourceLabel={describeSource(sourceAssetId)}
        imageMeta={meta ? `${meta.width} × ${meta.height} · ${aspectRatio(meta.width, meta.height)} · ${formatBytes(meta.file_size)}` : ''}
        projectName={activeProject?.name ?? '未命名视觉项目'}
        projectStatus={activeProject ? `${describeProjectStatus(activeProject.status)} · Revision ${activeProject.revision}` : '尚未建立项目'}
        analysisSummary={analysis?.summary}
        analysisMeta={activeProject?.templateSnapshot
          ? `${describeTemplateProvenance(activeProject.templateSnapshot)} · ${describeTemplateSnapshot(activeProject.templateSnapshot)}`
          : undefined}
        visionModelLabel={selectedOption ? `${selectedOption.profileName} / ${selectedOption.displayName}` : (selectedModelId || '—')}
        collapsed={projectPreviewCollapsed}
        analyzing={stage === 'analyzing'}
        canAnalyze={!busy && Boolean(sourcePath) && modelOptions.length > 0}
        onToggleCollapsed={() => view.toggleProjectPreview()}
        onOpenViewer={() => useImageViewerStore.getState().openViewer([{
          id: sourcePath,
          path: sourcePath,
          title: '画面模板',
          width: meta?.width,
          height: meta?.height,
          fileName: sourcePath.split(/[\\/]/).pop(),
          metadata: [{ label: '来源', value: describeSource(sourceAssetId) }],
        }])}
        onPickLocal={() => { void api.selectImageFile().then(file => { if (file) applySourceSelection(file); }); }}
        onPickGallery={() => { setGalleryPurpose('source'); setGalleryOpen(true); }}
        onOpenFolder={() => { if (sourcePath) void api.openFolder(sourcePath.replace(/[\\/][^\\/]+$/, '')); }}
        onRemove={() => useVisionWorkspaceStore.getState().removeSource()}
        onReanalyze={() => { void runAnalysis(); }}
        onToggleAnalysisDetail={() => view.toggleAnalysisDetail()}
      />
      )}
      {wizardStep === 1 && !analysis && modelOptions.length === 0 && (
        <section className="vision-card vision-no-model">
          <span>{NO_USABLE_VISION_MODEL}</span>
          <button className="app-btn app-btn-secondary app-btn-sm" onClick={goConfigure}>前往模型管理</button>
        </section>
      )}

      {errorText && (
        <section className="vision-card vision-error">
          <p>{errorText}</p>
        </section>
      )}

      {/* 视觉理解分析阶段：参考图缩略图 + 创意文案轮播 + 轻量扫描反馈（失败态由 errorText 卡片呈现，轮播随卸载停止） */}
      {wizardStep === 1 && stage === 'analyzing' && (
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
      {wizardStep === 1 && analysis && (
        <section className="vision-card vision-understanding">
          <div className="vision-understanding-head">
            <div>
              <h3>{UNDERSTANDING.title}</h3>
              <p className="vision-understanding-summary">{analysis.summary}</p>
              {activeProject?.templateSnapshot && (
                <p
                  className="vision-understanding-media"
                  title="模板基线媒介结构与视觉分析溯源（修改风格不会改变各层媒介）"
                >
                  {describeTemplateProvenance(activeProject.templateSnapshot)}
                  {' · '}
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

      {/* ===== V6.7 第 2 步 · 需求描述（描述你想怎么改；AI 优化完成自动进入第 3 步素材替换） ===== */}
      {reverseResult && wizardStep === 2 && (
        <>
          {visionTaskId && (
            <section className="vision-card vision-task-banner">
              <span className="vision-task-type">视觉理解任务</span>
              <span className="vision-task-id">#{visionTaskId.slice(0, 8)}</span>
              <span className="vision-task-desc">已理解参考图并生成可复刻方案；输入修改意图后由 AI 重新优化生成方案。</span>
            </section>
          )}
          <section className="vision-card vision-intent">
            <div className="vision-subpanel-head vision-custom-content-head">
              <div>
                <label className="vision-adjust-label" htmlFor="vision-adjust-input">自定义修改内容</label>
                <p className="vision-adjust-desc">{ADJUST_INPUT.desc}</p>
              </div>
              <button
                type="button"
                className="app-btn app-btn-secondary app-btn-sm"
                aria-expanded={!customContentCollapsed}
                onClick={() => view.toggleCustomContent()}
              >
                {customContentCollapsed ? '展开' : '收起'}
              </button>
            </div>
            {!customContentCollapsed && (
              <div className="vision-custom-content-body">
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
                      className="app-btn app-btn-secondary app-btn-sm"
                      disabled={busy || running || optimizing}
                      onClick={applyMentionSuggestion}
                    >
                      {MENTION_SUGGESTION.apply}
                    </button>
                    <button
                      type="button"
                      className="app-btn app-btn-secondary app-btn-sm"
                      onClick={() => setDismissedSuggestion(suggestionSignature)}
                    >
                      {MENTION_SUGGESTION.dismiss}
                    </button>
                  </div>
                )}
              </div>
            )}
            <ModificationChips
              draft={modificationDraft}
              autoDetectedDimensions={autoDetectedDimensions}
              disabled={busy || running || optimizing}
              onToggleDimension={onToggleDimensionChip}
              onToggleBoost={onToggleBoostChip}
            />
            <p className="vision-step-guide">描述或勾选要修改的内容后，点击右侧「优化复刻 Prompt」；AI 优化完成会自动进入第 3 步「素材替换」。</p>
          </section>
        </>
      )}

      {/* ===== V6.7 第 3 步 · 素材替换（人物 / 服装 / 维度参考素材与区域编辑） ===== */}
      {reverseResult && wizardStep === 3 && (
        <section className="vision-card vision-intent">
          <div className="vision-subpanel-head">
            <div>
              <span className="vision-adjust-label">素材替换</span>
              <p className="vision-adjust-desc">为启用的修改维度绑定参考素材；整理好之后再优化整体 Prompt，即可进入第 4 步「最终提示词」。</p>
            </div>
          </div>
          <div className="vision-adjust-box">
            {modificationDraft.activeDimensions.includes('subject') && (
              <PersonReplacementPanel
                person={modificationDraft.person}
                clothingPolicy={modificationDraft.clothingPolicy}
                customClothing={modificationDraft.customClothing}
                template={sourcePath ? { path: sourcePath, label: '原图', assetId: sourceAssetId } : null}
                activeDimensions={modificationDraft.activeDimensions}
                personContract={activeProject?.modification.person ?? null}
                onPersonContractChange={onPersonContractChange}
                regionOptions={activeProject?.regions.map(region => ({ id: region.id, name: region.name, enabled: region.enabled })) ?? []}
                disabled={busy || running || optimizing}
                collapsed={personReplacementCollapsed}
                onToggleCollapsed={() => view.togglePersonReplacement()}
                onPersonChange={onPersonChange}
                onRemove={onRemovePersonReplacement}
                onGalleryPick={pickPersonFromGallery}
                onLocalPick={() => void pickPersonFromLocal()}
                onOpenRegionEditor={openMultiPersonMapping}
                onTemplateChange={() => { setGalleryPurpose('source'); setGalleryOpen(true); }}
              />
            )}
            {(['pose', 'scene', 'camera', 'style'] as const).map(dimension => (
              modificationDraft.activeDimensions.includes(dimension) && (
                <DimensionEditPanel
                  key={dimension}
                  dimension={dimension}
                  value={readDimensionRequirement(modificationDraft.freeText, dimension)}
                  reference={modificationDraft.extraImageRefs.find(ref => ref.purpose === dimension)}
                  collapsed={dimensionEditorCollapsed[dimension] === true}
                  disabled={busy || running || optimizing}
                  onToggleCollapsed={() => view.toggleDimensionEditor(dimension)}
                  onValueChange={value => updateDimensionRequirement(dimension, value)}
                  onPickGallery={() => pickDimensionReferenceFromGallery(dimension)}
                  onPickLocal={() => { void pickDimensionReferenceFromLocal(dimension); }}
                  onRemoveReference={() => setDimensionReference(dimension, null)}
                />
              )
            ))}
            {modificationDraft.activeDimensions.includes('clothing') && (
              <ClothingChangePanel
                person={modificationDraft.person}
                clothingPolicy={modificationDraft.clothingPolicy}
                customClothing={modificationDraft.customClothing}
                clothingReference={modificationDraft.extraImageRefs.find(ref => ref.purpose === 'clothing')}
                collapsed={clothingChangeCollapsed}
                disabled={busy || running || optimizing}
                onToggleCollapsed={() => view.toggleClothingChange()}
                onClothingPolicyChange={onClothingPolicyChange}
                onCustomClothingChange={onCustomClothingChange}
                onPickReferenceGallery={() => pickDimensionReferenceFromGallery('clothing')}
                onPickReferenceLocal={() => { void pickDimensionReferenceFromLocal('clothing'); }}
                onRemoveReference={() => setDimensionReference('clothing', null)}
                onOpenMultiPersonMapping={openMultiPersonMapping}
              />
            )}
            {/* ===== 区域替换（§28 + V6.8 §四：素材替换的第三个子面板；区域编辑 = 语义事件，展开卡 = 视图） ===== */}
            {activeProject && (
              <RegionEditorPanel
                imagePath={sourcePath}
                regions={activeProject.regions}
                references={activeProject.references}
                openRequest={regionEditorOpenRequest}
                openPurpose={regionEditorPurpose}
                disabled={busy || running || optimizing}
                onRegionsChange={onRegionsChange}
                onPersistRegionMask={regionId => { void onPersistRegionMask(regionId); }}
                onPickRegionPersonReference={onPickRegionPersonReference}
              />
            )}
            {modificationDraft.activeDimensions.length === 0 && (!activeProject || activeProject.regions.length === 0) && (
              <p className="vision-step-empty">还没有启用任何修改。回到第 2 步「需求描述」勾选快捷胶囊或直接描述，这里会出现对应的素材替换面板。</p>
            )}
          </div>

          {/* ===== V6.8 §七：素材替换完成唯一入口——用户显式确认（「没改素材」≠「已完成」） ===== */}
          <div className="vision-step-confirm">
            <p className="vision-step-confirm-hint">
              {(modificationDraft.activeDimensions.length > 0 || (activeProject?.regions.length ?? 0) > 0)
                ? '素材整理好后继续；后续修改会自动回到这一步重新确认。'
                : '不需要替换素材可直接继续；后续随时可回到这一步添加。'}
            </p>
            <button
              type="button"
              className="vision-btn vision-btn-primary"
              data-testid="material-confirm-button"
              disabled={busy || running || optimizing}
              onClick={confirmMaterialReplacement}
            >
              继续下一步 · 生成最终提示词
            </button>
          </div>
        </section>
      )}

          {/* ===== V6.7 第 4 步 · 最终提示词（自然语言方案 + 最终生图 Prompt + 维度锁定 / 修改对比） ===== */}
          {recreation && wizardStep === 4 && (
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
                  {activeProject && (
                    <button
                      type="button"
                      className="vision-btn vision-btn-sm vision-final-source-btn"
                      title="按段查看最终 Prompt 的合同来源与归属技能"
                      onClick={openPromptSource}
                    >查看 Prompt 来源</button>
                  )}
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
                      onChange={e => editFinalPrompt(e.target.value)}
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

          {/* ===== V6.7 步骤脚注：第 2-4 步共用的方案状态栏与 Prompt 操作行（CTA 仍以 Context Rail 为唯一渲染处） ===== */}
          {reverseResult && wizardStep >= 2 && (
            <div className="vision-step-footer">
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
              {activeProject ? (
                <div className="vision-plan-actions">
                  {optimizerResolution.ok ? (
                    <span
                      className="vision-optimizer-model"
                      title={`Prompt 优化实际执行模型：${optimizerResolution.resolved.providerName} / ${optimizerResolution.resolved.resolvedModelId}`}
                    >
                      Prompt 优化 · {optimizerModelLabel}{optimizerSourceSuffix}
                      {recreation && needsOptimization(recreation) ? ' · 待优化' : ''}
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
                  {optimizeProgress.status !== 'idle' && (
                    <OptimizeProgressCard
                      status={optimizeProgress.status}
                      startedAt={optimizeProgress.startedAt}
                      modelLabel={optimizerModelLabel}
                      errorText={optimizeProgress.errorText}
                      onRetry={() => { void optimizeRecreationPrompt(true); }}
                    />
                  )}
                  {(isOptimizationRunning(optimizeProgress.status) || optimizeProgress.status === 'completed') ? null : (
                    <>
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
                        优化复刻 Prompt
                      </button>
                      <button
                        className="vision-btn vision-btn-primary"
                        disabled={busy || running || optimizing}
                        onClick={openGenerateConfirm}
                      >
                        确认生成图片
                      </button>
                    </>
                  )}
                  {optimizerResolution.ok && optimizerResolution.resolved.source === 'fallback' && (
                    <p className="vision-hint vision-optimizer-fallback">{describeFallback(optimizerResolution.resolved)}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>{/* .vision-step-content 结束 */}
      </div>{/* .vision-wizard 结束 */}

      {/* 理解完成后才可见的收尾区：生成结果 / 高级设置 / 高复刻验证（沿用原 reverseResult gating） */}
      {reverseResult && (
        <>

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

      {/* ===== V6.2 Handoff 过渡态（确认后 100ms 级关弹窗；重活在过渡态下完成） ===== */}
      {handoffPreparing && (
        <div className="vision-handoff-overlay" data-testid="vision-handoff-overlay" role="status" aria-live="polite">
          <div className="vision-handoff-card">
            <span className="vision-rail-repair-bar" aria-hidden="true" />
            <p>正在进入图片工作室…</p>
            <p className="vision-hint">正在冻结最终方案与参考图（不会再次执行 Prompt 优化）。</p>
          </div>
        </div>
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
              <ul className="vision-confirm-facts vision-confirm-summary">
                <li>来源：视觉理解方案</li>
                <li>编辑：{(() => {
                  const labels = (modificationDraft.activeDimensions ?? [])
                    .map(key => modificationDimensionLabel(key)).filter(Boolean);
                  return labels.length > 0 ? labels.join('、') : '未修改（直接复刻）';
                })()}</li>
                <li>参考图：{(() => {
                  const personBound = personHasImage(modificationDraft.person)
                    || mentionResolution.person?.origin === 'mention';
                  const strict = activeProject?.animeConsistency?.mode === 'strict_visual_reference';
                  const assetReady = !!activeProject?.animeConsistency?.characterAsset?.localPath;
                  const count = (sourcePath ? 1 : 0) + (personBound ? 1 : 0) + (strict && assetReady ? 1 : 0);
                  const base = `${sourcePath ? '模板' : ''}${sourcePath && personBound ? ' + ' : ''}${personBound ? '人物参考' : ''}`;
                  return strict
                    ? assetReady ? `${base} + 动漫角色参考（共 ${count} 张）` : `${base}（强一致性：角色参考图待生成）`
                    : `${base}（共 ${count} 张）`;
                })()}</li>
                <li>角色一致性：{activeProject?.animeConsistency?.mode === 'strict_visual_reference'
                  ? `强一致性${activeProject.animeConsistency?.characterAsset?.localPath ? '（角色参考图已就绪，将随图提交）' : '（需先生成动漫角色参考图）'}`
                  : '标准'}</li>
                <li>生成模型：gpt-image-2</li>
                <li>尺寸与数量：{genParams.size} · {genParams.count} 张</li>
                <li>预计点数：{generateQuoteLoading
                  ? '正在获取服务端报价…'
                  : generateQuote ? `${generateQuote.estimated_credits} 点` : '将在提交前按服务端报价确认'}</li>
              </ul>
              <details className="vision-confirm-advanced">
                <summary>高级详情</summary>
                <ul className="vision-confirm-facts">
                  <li>来源任务：{visionTaskId ? `#${visionTaskId.slice(0, 8)}` : '—'}</li>
                  <li>操作摘要：{intentSummary}</li>
                  <li>生成方式：{generationMode === 'i2i' ? '图生图' : '文生图'} · 比例 {ratioOfSize(genParams.size) || '—'} · 质量 {QUALITY_LABELS[genParams.quality] || genParams.quality}</li>
                  <li>视觉理解：{selectedOption?.displayName ?? selectedModelId ?? '—'}</li>
                  <li>Prompt 优化：{optimizerResolution.ok
                    ? `${optimizerResolution.resolved.displayName}${optimizerSourceSuffix || ' · 系统默认'}`
                    : (recreation.optimizedBy === 'optimizer' && recreation.modelName ? `${recreation.modelName}（历史优化）` : '未优化（原始复刻 Prompt）')}</li>
                  <li>AI 评价：{evaluationResolution.ok ? evaluationResolution.resolved.displayName : '未配置视觉模型（生成后不评价）'}</li>
                  <li title={sourcePath || undefined}>模板路径：{sourcePath || '—'}</li>
                </ul>
                <div className="vision-confirm-prompt">
                  <span>最终生图 Prompt</span>
                  <pre>{activeProject?.workspace.fullPromptOverride?.trim() || finalPrompt}</pre>
                </div>
              </details>
            </div>
            <div className="vision-modal-footer">
              <button className="vision-btn" onClick={() => setGenerateConfirmOpen(false)}>取消</button>
              <button className="vision-btn vision-btn-primary" onClick={generateFromPlan}>{GENERATE_DIALOG.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 删除当前项目确认（区域 mask 一并清理；已生成图片不受影响） ===== */}
      {pickerDeleting && (
        <div className="vision-modal-overlay" onClick={() => setPickerDeleting(null)}>
          <div className="vision-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="删除项目">
            <div className="vision-modal-header">
              <h3>删除项目</h3>
            </div>
            <p className="vision-modal-desc">
              确认删除项目「{pickerDeleting.name}」？该项目的区域 mask 将一并清理，已生成的图片不受影响。此操作不可撤销。
            </p>
            <div className="vision-modal-footer">
              <button className="vision-btn" onClick={() => setPickerDeleting(null)}>取消</button>
              <button
                className="vision-btn vision-btn-danger"
                onClick={() => {
                  const id = pickerDeleting.id;
                  setPickerDeleting(null);
                  handleDeleteProject(id);
                }}
              >确认删除</button>
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
        wizardProgress={VISION_WIZARD_STEPS.map(stepDef => ({
          id: stepDef.id,
          label: stepDef.title,
          done: (workflowState.steps.find(step => step.id === stepDef.id)?.status ?? 'pending') === 'completed',
          active: wizardStep === stepDef.id,
          status: workflowState.steps.find(step => step.id === stepDef.id)?.status ?? 'pending',
        }))}
        recreationNeedsOptimization={!!recreation && needsOptimization(recreation)}
        optimizerModelLabel={optimizerModelLabel}
        optimizerSourceSuffix={optimizerSourceSuffix}
        visionModelLabel={selectedOption?.displayName ?? selectedModelId ?? ''}
        disabled={busy || running || optimizing}
        showUseLastPrompt={showUseLastPrompt}
        onUseLastPrompt={useLastSuccessfulPrompt}
        onReoptimize={() => void optimizeRecreationPrompt(true)}
        onOptimize={() => void optimizeRecreationPrompt(false)}
        onSaveAsSkill={saveRecreationAsSkill}
        canSaveAsSkill={canSaveAsSkill}
        optimizeProgress={optimizeProgress.status === 'idle' ? null : optimizeProgress}
        onRetryOptimize={() => { void optimizeRecreationPrompt(true); }}
        onLocateRow={rowKey => {
          if (rowKey !== 'regions') return;
          // 定位到第 3 步素材替换的区域面板（可直达则切步，随后滚动定位）
          goWizardStep(3);
          window.setTimeout(() => {
            document.querySelector('[data-testid="region-panel"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 120);
        }}
        onGenerate={openGenerateConfirm}
        onGenerateCharacterAsset={force => void generateCharacterAsset(force)}
        characterAssetRequesting={assetRequesting}
        onOpenSkillTrace={() => setSkillTraceMode('skills')}
        onRepairDetailInserts={() => void repairDetailInsertInstances()}
        detailInsertRepairing={insertRepairing}
        detailInsertRepairError={insertRepairError}
        detailInsertRepairSummary={insertRepairSummary}
        detailRepairProgress={
          insertRepairProgress && insertRepairProgress.projectId === activeProject?.id
            ? insertRepairProgress
            : null
        }
        onCancelDetailRepair={() => { insertRepairCancelRef.current = true; }}
      />
      </div>{/* .vision-workbench 结束 */}

      {/* ===== Skill Trace Drawer（§24：五阶段——发现/建议/用户选择/系统强制/Prompt 写入） ===== */}
      <SkillTraceDrawer
        open={skillTraceMode !== null}
        mode={skillTraceMode ?? 'skills'}
        snapshot={activeProject?.skillExecution ?? null}
        liveSections={livePromptSections}
        livePromptText={livePromptText}
        liveCompilerSections={liveCompilerSections}
        projectName={activeProject?.name}
        originSkill={activeProject?.originSkill ?? null}
        originRequiredBlocks={originRequiredBlocks}
        onClose={() => setSkillTraceMode(null)}
      />

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
          <div className="vision-modal vision-gallery-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={galleryPurpose === 'person' || galleryPurpose === 'region-person' ? '从图片库选择人物' : galleryPurpose === 'dimension-reference' ? '选择维度参考图' : '从图片库选择'}>
            <div className="vision-modal-header">
              <h3>{galleryPurpose === 'person' || galleryPurpose === 'region-person' ? '从图片库选择人物' : galleryPurpose === 'mention' ? '选择要引用的图片' : galleryPurpose === 'dimension-reference' ? '选择维度参考图' : '从图片库选择'}</h3>
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
                      // 展示名优先用方案标题 / 描述（生成图 file_name 是哈希名，
                      // 直接显示会变成 @5d41e489bf…jpg 这类不可读 chip）
                      const pickLabel = img.description?.trim() || img.file_name;
                      if (galleryPurpose === 'person') {
                        onPersonChange({
                          source: 'gallery',
                          assetId: img.id,
                          path: img.local_path,
                          label: pickLabel,
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
                              : [...project.references, { id: refId, assetId: img.id, path: img.local_path, label: pickLabel, kind: 'person' as const, source: 'gallery' as const }];
                            return {
                              ...project,
                              status: 'modified',
                              references,
                              regions: project.regions.map(item => item.id === regionId ? { ...item, personReferenceId: refId } : item),
                            };
                          });
                          // V6.8.1：区域人物参考绑定变化 = 素材替换语义变化 → 最终 Prompt 过期
                          syncRecreationInstructionFromProject();
                        }
                        pendingRegionRefIdRef.current = null;
                      } else if (galleryPurpose === 'dimension-reference') {
                        const purpose = pendingDimensionPurposeRef.current;
                        if (purpose) setDimensionReference(purpose, { assetId: img.id, path: img.local_path, label: pickLabel });
                        pendingDimensionPurposeRef.current = undefined;
                      } else if (galleryPurpose === 'mention') {
                        // 加入当前任务附加参考图（池内可 @ 引用；一次消费回填到输入框）
                        const current = useVisionWorkspaceStore.getState().modificationDraft;
                        const exists = current.extraImageRefs.some(ref => ref.path === img.local_path)
                          || useVisionWorkspaceStore.getState().sourcePath === img.local_path
                          || (personHasImage(current.person) && current.person!.path === img.local_path);
                        if (!exists) {
                          useVisionWorkspaceStore.getState().setModificationDraft({
                            ...current,
                            extraImageRefs: [...current.extraImageRefs, { assetId: img.id, path: img.local_path, label: pickLabel }],
                          });
                        }
                        setPendingGalleryImage({ assetId: img.id, path: img.local_path, label: pickLabel });
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
