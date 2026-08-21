import { useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { api } from '../services/api';
import { toastError, toastInfo, toastSuccess, toastWarning } from '../components/Toast';
import { useAIProviderStore, resolveByokVisionConfig } from '../features/aiProviders/store';
import { getAvailableVisionModels, resolveModelSelectionOrFirst } from '../features/aiProviders/modelUsability';
import ModelCapabilityBadges, { capabilityOptionSuffix } from '../components/ModelCapabilityBadges';
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
  applyAdjustmentInput,
  applyOptimizationResult,
  buildGenerationCarry,
  buildRecreationPlan,
  canGenerateFromRecreation,
  describeRecreationStatus,
  initialRecreationState,
  markOptimizationFailed,
  markOptimizing,
  markRecreationDirty,
  needsReoptimization,
  togglePlanFieldLock,
  type RecreationState,
} from '../features/vision/recreationPlan';
import {
  ADJUST_INPUT,
  GENERATE_DIALOG,
  GENERATION_MODE,
  GENERATION_PARAMS,
  NO_USABLE_VISION_MODEL,
  OPTIMIZE_TOAST,
  REOPTIMIZE_ACTION,
  RESTART_ACTION,
  optimizeFailureMessage,
} from '../features/vision/recreationCopy';
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
    adjustmentInput,
    genParams,
    generationMode,
  } = ws;

  // ===== 仅进程内 UI 状态（预览图 / 弹层 / 轮询细节，不持久化） =====
  const [previewUrl, setPreviewUrl] = useState('');
  const [meta, setMeta] = useState<ImageMeta | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [galleryUrls, setGalleryUrls] = useState<Record<string, string>>({});
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [generateConfirmOpen, setGenerateConfirmOpen] = useState(false);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cancelRef = useRef(false);
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
    return instruction ? `调整要求 → ${instruction}` : '未修改，直接复刻参考图方案';
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
      },
    );
    useDraftStore.getState().setVisionCarry(carry);
    setGenerateConfirmOpen(false);
    window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'imagestudio' } }));
  };

  // ===== 复刻方案编辑：统一「调整要求」输入 + 锁定 =====

  /** 统一输入框变更：内容变化 → dirty（清空且从未优化过则回 ready），绝不直接生图。 */
  const onAdjustmentChange = (value: string) => {
    const wstore = useVisionWorkspaceStore.getState();
    wstore.setAdjustmentInput(value);
    if (!wstore.recreation || wstore.recreation.editState === 'optimizing') return;
    const next = applyAdjustmentInput(wstore.recreation, value);
    wstore.setRecreation(next, { debounce: true });
    persistRecreation(next);
  };

  const toggleFieldLock = (key: Parameters<typeof togglePlanFieldLock>[1]) => {
    if (!recreation) return;
    const next = togglePlanFieldLock(recreation, key);
    ws.setRecreation(next);
    persistRecreation(next);
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
   * 「重新优化」（force=true）：基于当前图片 + 分析结果 + 调整要求强制再执行一次
   * （会再次调用 AI 消耗 Token）；失败时旧结果原样保留，成功后才替换。
   */
  const optimizeRecreationPrompt = async (force = false) => {
    const wstore = useVisionWorkspaceStore.getState();
    const current = wstore.recreation;
    if (!current) return;
    if (current.editState === 'optimizing') return;
    if (!force && !needsReoptimization(current)) {
      toastInfo(OPTIMIZE_TOAST.idleGuard, '无需重复优化');
      return;
    }
    if (!wstore.adjustmentInput.trim()) {
      toastInfo(force ? REOPTIMIZE_ACTION.emptyInstruction : OPTIMIZE_TOAST.emptyInstruction, '请先输入调整要求');
      return;
    }
    const optimizingState = markOptimizing({
      ...current,
      originalPrompt: wstore.originalPromptDraft,
      adjustInstruction: wstore.adjustmentInput.trim(),
    });
    wstore.setRecreation(optimizingState);
    const outcome = await optimizeVisionRecreation({
      originalRecreationPrompt: wstore.originalPromptDraft,
      structuredRecreationPlan: optimizingState.plan,
      lockedFields: optimizingState.plan.fields.filter(f => f.locked).map(f => f.key),
      userAdjustmentInstruction: optimizingState.adjustInstruction,
      targetImageModelInfo: 'gpt-image-2（GPT Image 系，自然语言长句偏好）',
      originalNegativePrompt: current.originalNegativePrompt,
    });
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
    setRestartConfirmOpen(false);
    setGenerateConfirmOpen(false);
    setConfirmOpen(false);
    setAnalysisOpen(false);
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

  const finalPromptNote = useMemo(() => {
    if (!recreation) return '';
    if (recreation.editState === 'optimizing') return '正在结合复刻方案、锁定项与你的调整要求优化提示词…';
    if (recreation.editState === 'dirty') return '方案已修改但尚未优化：此 Prompt 还未按你的最新要求重建，请先执行「优化复刻 Prompt」。';
    if (recreation.editState === 'optimized') return '此 Prompt 已根据你的调整要求重新优化，可直接用于图片生成。';
    return '未经修改时，原始复刻 Prompt 即最终生图 Prompt，可直接生成（提交时不会重复优化）。';
  }, [recreation]);

  return (
    <div className="page vision-page">
      <div className="page-header vision-page-header">
        <div>
          <h2>视觉理解</h2>
          <p>从参考图反向提取结构化复刻方案：输入大白话调整要求，AI 重新优化最终 Prompt，选择生成参数后生成图片。</p>
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

      {/* ===== 参考图 ===== */}
      <section className="vision-card vision-source">
        {previewUrl ? (
          <div className="vision-source-loaded">
            <img className="vision-source-img" src={previewUrl} alt="参考图" />
            <div className="vision-source-meta">
              {meta ? (
                <p>{meta.width} × {meta.height} · {aspectRatio(meta.width, meta.height)} · {formatBytes(meta.file_size)}</p>
              ) : <p>读取元信息中…</p>}
              <p className="vision-source-path" title={sourcePath}>{sourcePath}</p>
              <div className="vision-source-actions">
                <button className="vision-btn" onClick={() => void api.openFolder(sourcePath.replace(/[\\/][^\\/]+$/, ''))}>打开所在目录</button>
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
              <button className="vision-btn" onClick={() => setGalleryOpen(true)}>从图片库选择</button>
            </div>
            <p className="vision-hint">支持 PNG / JPEG / WebP；图片将直接发送给你配置的视觉模型服务（不会上传任何图床）。</p>
          </div>
        )}
      </section>

      {/* ===== 模型与模式 ===== */}
      <section className="vision-card vision-config">
        <div className="vision-config-row">
          <div className="vision-config-item vision-config-grow">
            <label>视觉模型</label>
            {modelOptions.length > 0 ? (
              <div className="vision-model-field">
                <select
                  value={`${selectedProfileId}|${selectedModelId}`}
                  onChange={e => {
                    const [profileId, modelId] = e.target.value.split('|');
                    setVisionConfig(profileId, modelId);
                  }}
                >
                  {modelOptions.map(option => (
                    <option key={`${option.profileId}|${option.modelId}`} value={`${option.profileId}|${option.modelId}`}>
                      {option.profileName} / {option.displayName}{capabilityOptionSuffix(option.model.capabilities)}
                    </option>
                  ))}
                </select>
                {selectedOption && (
                  <ModelCapabilityBadges capabilities={selectedOption.model.capabilities} />
                )}
              </div>
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
          <button
            className="vision-btn vision-btn-primary"
            onClick={runAnalysis}
            disabled={busy || !sourcePath || modelOptions.length === 0}
          >
            {stage === 'analyzing' ? '分析中…' : mode === 'quick' ? '开始理解' : '提取复刻方案'}
          </button>
        </div>
        {mode === 'high_fidelity' && (
          <p className="vision-hint">
            高复刻 = 先提取 Prompt（不生成图片），由你确认后才开始「生成 → 双图评审 → 差异修正」循环（费用见确认弹窗）。
          </p>
        )}
      </section>

      {errorText && (
        <section className="vision-card vision-error">
          <p>{errorText}</p>
        </section>
      )}

      {(stageDetail || STAGE_LABELS[stage]) && busy && (
        <section className="vision-card vision-stage">
          <span className="vision-spinner" />
          <p>{stageDetail || STAGE_LABELS[stage]}</p>
        </section>
      )}

      {/* ===== 结构化分析 ===== */}
      {analysis && (
        <section className="vision-card">
          <button className="vision-section-toggle" onClick={() => setAnalysisOpen(v => !v)}>
            {analysisOpen ? '▾' : '▸'} 图片理解（结构化分析）
          </button>
          {analysisOpen && (
            <div className="vision-analysis">
              <p><strong>概述：</strong>{analysis.summary}</p>
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

      {/* ===== 复刻工作台（视觉理解任务 → 统一调整要求 → Prompt 优化 → 生图）===== */}
      {reverseResult && (
        <>
          {visionTaskId && (
            <section className="vision-card vision-task-banner">
              <span className="vision-task-type">视觉理解任务</span>
              <span className="vision-task-id">#{visionTaskId.slice(0, 8)}</span>
              <span className="vision-task-desc">正在分析参考图片的主体、构图、动作、背景、光线、风格，并生成可复刻的结构化方案（可在任务队列查看链路）。</span>
            </section>
          )}

          {recreation && (
            <section className="vision-card">
              <div className="vision-prompt-head">
                <h3>复刻方案</h3>
              </div>

              {/* 主状态栏：当前处于流程哪一步、下一步做什么 */}
              <div className={`vision-status-bar tone-${planStatus.tone}`} role="status">
                <span className="vision-status-label">{planStatus.label}</span>
                <span className="vision-status-note">{planStatus.note}</span>
              </div>

              {/* 方案摘要卡片：哪些维度会跟着变、哪些尽量保留不变 */}
              <div className="vision-plan-grid">
                {recreation.plan.fields.map(field => (
                  <div key={field.key} className="vision-plan-field">
                    <div className="vision-plan-field-head">
                      <span className="vision-plan-field-label">{field.label}</span>
                      <button
                        type="button"
                        className={`vision-lock-badge ${field.locked ? 'is-locked' : 'is-unlocked'}`}
                        disabled={busy || running || optimizing}
                        onClick={() => toggleFieldLock(field.key)}
                        title={field.locked ? '锁定：优化时尽量保持不变，点击改为可修改' : '可修改：优化时允许跟随要求调整，点击锁定'}
                      >
                        {field.locked ? '锁定' : '可修改'}
                      </button>
                    </div>
                    <p title={field.value}>{field.value || '（未识别）'}</p>
                  </div>
                ))}
              </div>
              <p className="vision-hint">摘要仅供参考，无需逐项编辑：标注「锁定」的维度在优化时必须保持不变，「可修改」的维度会跟随你的调整要求变化（点击角标可切换）。</p>

              {/* 统一「调整要求」输入框：大白话 → 优化器（旧分叉入口已移除） */}
              <div className="vision-adjust-box">
                <label className="vision-adjust-label" htmlFor="vision-adjust-input">{ADJUST_INPUT.title}</label>
                <p className="vision-adjust-desc">{ADJUST_INPUT.desc}</p>
                <textarea
                  id="vision-adjust-input"
                  className="vision-adjust-textarea"
                  rows={4}
                  value={adjustmentInput}
                  disabled={busy || running || optimizing}
                  onChange={e => onAdjustmentChange(e.target.value)}
                  placeholder={ADJUST_INPUT.placeholder}
                />
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
              {recreation.summary && (
                <p className="vision-plan-summary">{recreation.summary}</p>
              )}
            </section>
          )}

          <section className="vision-card">
            <div className="vision-prompt-head">
              <h3>原始复刻 Prompt</h3>
              <div className="vision-prompt-head-actions">
                <button className="vision-btn" onClick={() => void copyText(originalPromptDraft, '原始 Prompt')}>复制</button>
                <button className="vision-btn" onClick={() => editOriginalPrompt(reverseResult.prompt)}>重置</button>
              </div>
            </div>
            <p className="vision-hint">来源于视觉模型分析，偏「描述事实」。手动编辑等同于修改复刻方案，需要重新优化。</p>
            <textarea className="vision-prompt-textarea" value={originalPromptDraft} disabled={busy || running || optimizing} onChange={e => editOriginalPrompt(e.target.value)} rows={5} />
          </section>

          <section className="vision-card">
            <div className="vision-prompt-head">
              <h3>最终生图 Prompt</h3>
              <div className="vision-prompt-head-actions">
                <button className="vision-btn" onClick={() => void copyText(promptDraft, '生图 Prompt')}>复制</button>
              </div>
            </div>
            <p className="vision-hint">{finalPromptNote}</p>
            <textarea className="vision-prompt-textarea" value={promptDraft} onChange={e => ws.setPromptDraft(e.target.value)} rows={8} />
          </section>

          <section className="vision-card">
            <div className="vision-prompt-head">
              <h3>Negative Prompt</h3>
              <div className="vision-prompt-head-actions">
                <button className="vision-btn" onClick={() => void copyText(negativeDraft, '负面词')}>复制</button>
                <button className="vision-btn" onClick={() => ws.setNegativeDraft(reverseResult.negativePrompt)}>重置</button>
              </div>
            </div>
            <textarea className="vision-prompt-textarea" value={negativeDraft} onChange={e => ws.setNegativeDraft(e.target.value)} rows={3} />
          </section>

          {/* ===== 生成方式（V4.0.8）：视觉理解只负责出 Prompt，文生图 / 图生图由用户选择 ===== */}
          <section className="vision-card vision-genmode">
            <h3>{GENERATION_MODE.title}</h3>
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
            </p>
          </section>

          {/* ===== 生成参数（用户可选，与图生图参数体系一致；默认值来自视觉模型推荐）===== */}
          <section className="vision-card vision-genparams">
            <h3>{GENERATION_PARAMS.title}</h3>
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
          </section>

          <section className="vision-card vision-actions-card">
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
                <li>当前最终 Prompt {recreation.editState === 'optimized' ? '已按你的调整要求优化完成' : '为提取的原始复刻 Prompt（未修改）'}</li>
                <li>生成参数：比例 {ratioOfSize(genParams.size) || '—'} · 尺寸 {genParams.size} · 质量 {QUALITY_LABELS[genParams.quality] || genParams.quality} · 数量 {genParams.count} 张</li>
                <li>进入图片工作室后提交生成，不会再次执行 AI 优化。</li>
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

      {/* ===== 高复刻结果 ===== */}
      {report && (
        <section className="vision-card vision-similarity">
          <h3>复刻相似度</h3>
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
        </section>
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

      {/* ===== 图库选择 ===== */}
      {galleryOpen && (
        <div className="vision-modal-overlay" onClick={() => setGalleryOpen(false)}>
          <div className="vision-modal vision-gallery-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="从图片库选择">
            <div className="vision-modal-header">
              <h3>从图片库选择</h3>
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
                      useVisionWorkspaceStore.getState().setSource(img.local_path, img.id);
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
