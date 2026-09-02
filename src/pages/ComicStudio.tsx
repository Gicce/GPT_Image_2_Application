/**
 * AI 漫画工作台（Phase 10/11）——CyImagePro 第六个工作流页面。
 *
 * 结构（Workbench + 步骤栏，镜像视觉理解工作台模式）：
 *  .page.comic-page
 *    .page-header
 *    [无项目] 项目库（卡片 + 新建弹窗 + 空态）
 *    [有项目] .comic-project-header（名称 / 阶段徽标 / 保存指示 / 项目操作）
 *             .comic-workbench（步骤栏 + 当前步骤内容 + Context Rail）
 *
 * 编排职责（页面层唯一）：
 *  - 生成提交：buildAnchorTask / buildPanelSeriesTask / buildPanelRegenTask →
 *    useTaskStore.createSeriesTask（报价确认 + 计费两段授权全复用既有链路）；
 *  - 终态回写：registerTaskRefreshHook → applyComicTaskResults（幂等）；
 *  - 阶段推进：deriveComicStage 事实派生（skill_draft / completed 为显式转换）；
 *  - 文字层：对白编辑只经 upsertDialogue / removeDialogue（验收 I：零生图）。
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './ComicStudio.css';
import { api } from '../services/api';
import { isQuoteCancelled } from '../services/billingService';
import { toastError, toastSuccess } from '../components/Toast';
import OutputPathPicker from '../components/OutputPathPicker';
import { useComicStore } from '../store/useComicStore';
import { useTaskStore, ensureTaskEventBridge, registerTaskRefreshHook } from '../store/useTaskStore';
import { useImageStore } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import type { CreateTaskParams, Task } from '../types';
import {
  applyComicFinalPages,
  applyStoryOnlyToProject,
  applyStoryToProject,
  comicCharactersSummaryState,
  comicCharacterToLibraryEntry,
  lockAnchor,
  moveDialogueZ,
  removeDialogue,
  upsertDialogue,
  type ComicReferenceTaskState,
} from '../features/comic/domain';
import { normalizeComicSkill } from '../features/comic/normalize';
import { clearComicSession, readComicSession, writeComicSession } from '../features/comic/comicSession';
import { comicPresentationLabel, resolveComicPresentation } from '../features/comic/presentation';
import type {
  ComicCharacter,
  ComicDialogue,
  ComicPanel,
  ComicPresentationSource,
  ComicProject,
  ComicSkill,
  ComicStory,
  ComicUiDraft,
  CompiledPanelPrompt,
} from '../features/comic/types';
import {
  activePanels,
  buildAnchorTask,
  buildBakeTextTask,
  buildCharacterReferenceTask,
  buildPanelRegenTask,
  buildPanelSeriesTask,
  freezeCompiledPrompt,
} from '../features/comic/comicTask';
import { applyDialogueDrafts, applyVisionPlacement } from '../features/comic/dialogueDirector';
import { applyComicTaskResults, buildAnchorConfirmation, comicTaskMarker } from '../features/comic/generation';
import { attributeComicPanelImages, exportComicSheetPng, persistComicFinalPages } from '../features/comic/comicExport';
import {
  comicStageLabel,
  comicStepTitle,
  deriveComicStage,
  getComicProjectSummary,
  getComicStudioFlow,
  type ComicStudioStepId,
} from '../features/comic/comicStudioFlow';
import { resolveModelForRole } from '../features/aiRouting/resolveModelForRole';
import ComicNewProjectDialog from '../features/comic/components/ComicNewProjectDialog';
import ComicDeleteProjectDialog from '../features/comic/components/ComicDeleteProjectDialog';
import ComicFormPreviewMini from '../features/comic/components/ComicFormPreviewMini';
import { moveProjectPanel } from '../features/comic/domain';
import ComicSkillStage from '../features/comic/components/ComicSkillStage';
import ComicCharacterStage from '../features/comic/components/ComicCharacterStage';
import ComicStoryStage from '../features/comic/components/ComicStoryStage';
import ComicStoryboardStage from '../features/comic/components/ComicStoryboardStage';
import ComicGenerateStage from '../features/comic/components/ComicGenerateStage';
import ComicTextStage from '../features/comic/components/ComicTextStage';
import AIDialogueDirectorDialog from '../features/comic/components/AIDialogueDirectorDialog';

const SAVE_STATE_LABELS: Record<string, string> = {
  idle: '',
  pending: '待保存…',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败',
};

/** 任务状态 → 参考图任务状态（cancelled 归入 failed：对角色而言都是「没拿到图」）。 */
function referenceTaskStatusOf(task: Task): ComicReferenceTaskState['status'] {
  switch (task.status) {
    case 'completed': return 'completed';
    case 'running': return 'running';
    case 'failed':
    case 'cancelled': return 'failed';
    default: return 'queued'; // pending / queued
  }
}

/** 步骤 Footer CTA（§10.2/§10.4）：[← 上一步] + 下一未决原因清单 + [继续：下一步 →]。 */
function ComicStepFooter(props: {
  flow: NonNullable<ReturnType<typeof getComicStudioFlow>>;
  step: ComicStudioStepId;
  onGoto: (step: ComicStudioStepId) => void;
}) {
  const { flow, step, onGoto } = props;
  const index = flow.steps.findIndex(item => item.id === step);
  if (index < 0) return null;
  const prev = index > 0 ? flow.steps[index - 1]! : null;
  const next = index < flow.steps.length - 1 ? flow.steps[index + 1]! : null;
  if (!prev && !next) return null;
  return (
    <footer className="comic-step-footer">
      {next && !next.enterable && next.blockedReasons.length > 0 && (
        <div className="comic-step-footer-blockers" data-testid="comic-step-footer-blockers">
          <span className="comic-step-footer-blockers-title">继续之前需完成：</span>
          <ul>
            {next.blockedReasons.map(reason => <li key={reason}>{reason}</li>)}
          </ul>
        </div>
      )}
      <div className="comic-step-footer-main">
        {prev && (
          <button type="button" className="app-btn app-btn-secondary" onClick={() => onGoto(prev.id)}>
            ← 上一步
          </button>
        )}
        {next && (
          <button
            type="button"
            className="app-btn app-btn-primary"
            disabled={!next.enterable}
            data-testid={`comic-footer-next-${next.id}`}
            title={!next.enterable && next.blockedReasons[0] ? next.blockedReasons[0] : undefined}
            onClick={() => {
              if (next.enterable) onGoto(next.id);
            }}
          >
            继续：{next.title} →
          </button>
        )}
      </div>
    </footer>
  );
}

export default function ComicStudio() {
  const {
    projects, skills, characters, active, listLoading, saveState, lastError,
    refreshLists, openProject, closeProject, createProject, updateActive, deleteProject, retrySave,
  } = useComicStore();
  const { tasks } = useTaskStore();
  const { images, loadImages } = useImageStore();
  const settings = useSettingsStore(s => s.settings);

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [viewStep, setViewStep] = useState<ComicStudioStepId | null>(null);
  const [outputDir, setOutputDir] = useState('');
  const [exporting, setExporting] = useState(false);
  const [directorOpen, setDirectorOpen] = useState(false);

  const activeProjectId = active?.id ?? null;

  // §85 会话恢复：刷新 / 重开后回到「上次打开的项目 + 上次所在步骤」（sessionStorage 会话级）
  const sessionRestoreRef = useRef<{ projectId: string; viewStep: ComicStudioStepId } | null>(null);

  useEffect(() => {
    void refreshLists();
    ensureTaskEventBridge();
    void useTaskStore.getState().loadTasks();
    void loadImages();
    const restore = readComicSession();
    if (restore) {
      sessionRestoreRef.current = { projectId: restore.projectId, viewStep: restore.viewStep };
      void useComicStore.getState().openProject(restore.projectId).then(opened => {
        if (!opened) {
          sessionRestoreRef.current = null;
          toastError('上次打开的漫画项目已不可用');
        }
      });
    }
  }, [refreshLists, loadImages]);

  useEffect(() => {
    setOutputDir(settings.default_output_dir || '');
  }, [settings.default_output_dir]);

  // 打开项目 → 视图步骤落到当前事实步骤（视图状态，可自由切换）；
  // 会话恢复优先用上次步骤（项目事实可能已推进：不可进入的步骤回落 currentStep）
  useEffect(() => {
    if (active) {
      const restore = sessionRestoreRef.current;
      if (restore && restore.projectId === active.id) {
        sessionRestoreRef.current = null;
        const restoredEnterable = getComicStudioFlow(active).steps
          .some(step => step.id === restore.viewStep && step.enterable);
        setViewStep(restoredEnterable ? restore.viewStep : getComicStudioFlow(active).currentStep);
      } else {
        setViewStep(getComicStudioFlow(active).currentStep);
      }
    } else {
      setViewStep(null);
    }
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 会话写入：打开项目 + 切步骤即记录；回到项目库 / 关闭项目即清除（恢复中不覆盖）
  useEffect(() => {
    if (sessionRestoreRef.current) return;
    if (!activeProjectId || !viewStep) {
      clearComicSession();
      return;
    }
    writeComicSession({ projectId: activeProjectId, viewStep });
  }, [activeProjectId, viewStep]);

  // 刷新前冲刷防抖落库（best-effort：600ms 防抖内的最后修改）
  useEffect(() => {
    const flush = () => { void useComicStore.getState().flushPersist(); };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  const flow = useMemo(() => (active ? getComicStudioFlow(active) : null), [active]);
  const comicTasks = useMemo(
    () => (activeProjectId ? tasks.filter(task => comicTaskMarker(task)?.projectId === activeProjectId) : []),
    [tasks, activeProjectId],
  );
  /**
   * V4.2.11 §B（P0-3）：提交互斥按「内容域」拆分——角色参考图任务与分镜成图任务互不阻塞；
   * 队列本身支持多任务排队（单 worker 顺序执行），同一角色 / 同一批分镜在途时仅去重防重复计费。
   * 全量 taskRunning 互斥（19 审计 Q2 的串行根因）已废除。
   */
  const panelsTaskRunning = comicTasks.some(task => {
    const marker = comicTaskMarker(task);
    return marker !== null && marker.kind !== 'character_ref'
      && !['completed', 'failed', 'cancelled'].includes(task.status);
  });

  // Phase 1.1 §六/§十一：每角色最新参考图任务（character_ref）状态 + 槽位汇总单一事实源
  const referenceTasks = useMemo(() => {
    const latest: Record<string, ComicReferenceTaskState> = {};
    if (!activeProjectId) return latest;
    const ordered = tasks
      .filter(task => {
        const marker = comicTaskMarker(task);
        return marker?.projectId === activeProjectId && marker.kind === 'character_ref';
      })
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    for (const task of ordered) {
      const marker = comicTaskMarker(task)!;
      const characterId = marker.characterId ?? task.batch_items?.[0]?.variables?.characterId;
      if (!characterId) continue;
      latest[characterId] = { taskId: task.id, status: referenceTaskStatusOf(task) };
    }
    return latest;
  }, [tasks, activeProjectId]);

  const charactersSummary = useMemo(
    () => (active ? comicCharactersSummaryState(active, referenceTasks) : null),
    [active, referenceTasks],
  );
  // Phase 1.2 §86/§87：Rail「本期方案」的单一事实源（组件不自拼摘要状态）
  const projectSummary = useMemo(
    () => (active ? getComicProjectSummary(active) : null),
    [active],
  );

  // Phase 1.2 §13.2：Rail 视觉信息（主角参考图缩略），文字行之外一眼可认
  const railHeroRef = useMemo(() => {
    if (!active) return null;
    for (const slot of active.skillSnapshot.characterSlots) {
      const boundId = active.characterBindings[slot.slotId];
      const character = boundId ? active.characterSnapshots.find(item => item.id === boundId) : null;
      if (character?.referenceImage) return character.referenceImage;
    }
    return null;
  }, [active]);
  // V4.2.11 §D（P0-6）：内部锚点概念不再出现在 Rail 用户语言区
  // V4.2.10 §Rail：阵容小头像（每已绑定角色的参考图缩略；无图回落首字占位）
  const railCast = useMemo(() => {
    if (!active) return [] as { characterId: string; refPath: string | null }[];
    return active.skillSnapshot.characterSlots
      .map(slot => {
        const boundId = active.characterBindings[slot.slotId];
        const character = boundId ? active.characterSnapshots.find(item => item.id === boundId) : null;
        return character ? { characterId: character.id, refPath: character.referenceImage?.path ?? null } : null;
      })
      .filter((item): item is { characterId: string; refPath: string | null } => item !== null);
  }, [active]);
  const [railThumbs, setRailThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    const paths = new Map<string, string>();
    if (railHeroRef) paths.set('hero', railHeroRef.path);
    for (const item of railCast) {
      if (item.refPath) paths.set(`cast:${item.characterId}`, item.refPath);
    }
    if (paths.size === 0) {
      setRailThumbs({});
      return;
    }
    void Promise.all([...paths.entries()].map(async ([key, path]) => {
      try {
        return [key, await api.readThumbnail(path)] as const;
      } catch {
        return [key, ''] as const;
      }
    })).then(entries => {
      if (!alive) return;
      setRailThumbs(Object.fromEntries(entries.filter(([, data]) => data)));
    });
    return () => { alive = false; };
  }, [railHeroRef, railCast]);

  /** 语义更新统一入口：事实变化后阶段标签自动对齐（completed/failed 终态不回退）。 */
  const applyProject = useCallback((mutate: (draft: ComicProject) => ComicProject) => {
    updateActive(draft => {
      const next = mutate(draft);
      return { ...next, stage: deriveComicStage(next) };
    });
  }, [updateActive]);

  /**
   * 步骤草稿写穿（Phase 1.2 §30/§85）：只写 uiDraft，不走 deriveComicStage——
   * 草稿不是事实，不参与阶段派生；经 updateActive 复用 600ms 防抖落库。
   */
  const handleDraft = useCallback((mutate: (uiDraft: ComicUiDraft) => ComicUiDraft) => {
    updateActive(draft => ({ ...draft, uiDraft: mutate(draft.uiDraft ?? {}) }));
  }, [updateActive]);

  /** 终态回写（幂等；图库记录就绪后落图，未扫到留待下次刷新）。 */
  const syncComicTasks = useCallback(async (projectId: string) => {
    const store = useComicStore.getState();
    if (store.active?.id !== projectId) return;
    const comicTasksNow = useTaskStore.getState().tasks.filter(task => comicTaskMarker(task)?.projectId === projectId);
    if (comicTasksNow.length === 0) return;
    const hasCompleted = comicTasksNow.some(task => task.status === 'completed');
    if (hasCompleted) {
      await useImageStore.getState().loadImages();
    }
    const fresh = useComicStore.getState().active;
    if (!fresh || fresh.id !== projectId) return;
    const imagesNow = useImageStore.getState().images;
    let next = fresh;
    let changed = false;
    for (const task of comicTasksNow) {
      const result = applyComicTaskResults(next, task, imagesNow);
      if (result.changed) {
        next = result.project;
        changed = true;
      }
    }
    if (changed) {
      // updateActive 自带 updatedAt 刷新；此处只回写事实（幂等：changed 才写）
      useComicStore.getState().updateActive(() => ({ ...next, stage: deriveComicStage(next) }));
    }
  }, []);

  useEffect(() => {
    const unregister = registerTaskRefreshHook(() => {
      const id = useComicStore.getState().active?.id;
      if (id) void syncComicTasks(id);
    });
    return unregister;
  }, [syncComicTasks]);

  useEffect(() => {
    if (active?.id) void syncComicTasks(active.id);
  }, [active?.id, tasks, syncComicTasks]); // eslint-disable-line react-hooks/exhaustive-deps

  // ===== 生成提交（报价确认 + 计费授权复用 createSeriesTask 既有链路）=====

  const generationContext = useMemo(() => ({
    outputDir: outputDir || settings.default_output_dir || '',
    size: settings.default_size || '1024x1024',
    quality: settings.default_quality || 'auto',
    outputFormat: settings.default_format || 'png',
  }), [outputDir, settings.default_output_dir, settings.default_size, settings.default_quality, settings.default_format]);

  const submitComicBuild = useCallback(async (input: {
    params: CreateTaskParams;
    freeze: Array<{ panelId: string; compiled: CompiledPanelPrompt }>;
  }) => {
    applyProject(draft => ({
      ...draft,
      panels: draft.panels.map(panel => {
        const entry = input.freeze.find(item => item.panelId === panel.id);
        if (!entry || panel.stale) return panel;
        return {
          ...panel,
          compiledPrompt: freezeCompiledPrompt(entry.compiled),
          generationStatus: 'queued' as const,
        };
      }),
    }));
    try {
      await useTaskStore.getState().createSeriesTask(input.params, input.params.count);
      toastSuccess('生成任务已提交，进度见任务队列');
    } catch (err) {
      if (!isQuoteCancelled(err)) {
        toastError(err instanceof Error ? err.message : '任务提交失败，请重试');
      }
      // 提交失败回滚排队标记（下次可重试）
      applyProject(draft => ({
        ...draft,
        panels: draft.panels.map(panel => {
          const entry = input.freeze.find(item => item.panelId === panel.id);
          return entry && panel.generationStatus === 'queued'
            ? { ...panel, generationStatus: 'pending' as const }
            : panel;
        }),
      }));
    }
  }, [applyProject]);

  const guardActive = (): ComicProject | null => {
    if (!active) {
      toastError('请先打开一个漫画项目');
      return null;
    }
    // §B：只拦「同一批分镜成图在途」（防重复计费）；角色参考图任务并行不在此列
    if (panelsTaskRunning) {
      toastError('本批分镜成图任务进行中，请等完成后再发起下一批');
      return null;
    }
    return active;
  };

  const handleGenerateAnchor = () => {
    const project = guardActive();
    if (!project) return;
    try {
      const build = buildAnchorTask(project, generationContext);
      void submitComicBuild({ params: build.params, freeze: [{ panelId: build.panelId, compiled: build.compiled }] });
    } catch (err) {
      toastError(err instanceof Error ? err.message : '生成任务构建失败');
    }
  };

  const handleLockAnchor = () => {
    const project = guardActive();
    if (!project) return;
    const anchorTask = comicTasks
      .filter(task => comicTaskMarker(task)?.kind === 'anchor' && task.status === 'completed')
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    let confirmation = anchorTask ? buildAnchorConfirmation(project, anchorTask, images) : null;
    if (!confirmation) {
      // 任务记录不可达（应用重启 / 旧任务）→ 用面板已落图事实构建（同源数据）
      const panel = activePanels(project).find(item => item.generationStatus === 'completed' && item.imageAsset);
      if (panel?.imageAsset) {
        confirmation = {
          panelId: panel.id,
          path: panel.imageAsset.path,
          imageId: panel.imageAsset.imageId,
          taskId: panel.imageAsset.taskId,
          lockedAt: new Date().toISOString(),
        };
      }
    }
    if (!confirmation) {
      toastError('第一格还没有成图，无法确认');
      return;
    }
    applyProject(draft => lockAnchor(draft, confirmation!));
    toastSuccess('第一格已确认：剩余画面将继承此画风');
  };

  const handleGenerateSeries = () => {
    const project = guardActive();
    if (!project) return;
    try {
      // V4.2.11 §F：默认一次性提交全部格（无锚点门禁）；高级暂停确认模式保留内部锚点链路
      const skipAnchor = project.skillSnapshot.referenceStrategy.pauseAfterFirstPanel !== true;
      const build = buildPanelSeriesTask(project, generationContext, { skipAnchor });
      void submitComicBuild({
        params: build.params,
        freeze: build.panelIds.map(panelId => ({ panelId, compiled: build.compiledByPanelId[panelId]! })),
      });
    } catch (err) {
      toastError(err instanceof Error ? err.message : '系列任务构建失败');
    }
  };

  const handleRegeneratePanel = (panelId: string) => {
    const project = guardActive();
    if (!project) return;
    try {
      const build = buildPanelRegenTask(project, panelId, generationContext);
      void submitComicBuild({ params: build.params, freeze: [{ panelId: build.panelId, compiled: build.compiled }] });
    } catch (err) {
      toastError(err instanceof Error ? err.message : '单格重绘构建失败');
    }
  };

  /** §F 高级开关：生成第一格后暂停确认（写 skillSnapshot.referenceStrategy，默认关）。 */
  const handleTogglePauseAfterFirstPanel = (enabled: boolean) => {
    applyProject(draft => ({
      ...draft,
      skillSnapshot: {
        ...draft.skillSnapshot,
        referenceStrategy: {
          ...draft.skillSnapshot.referenceStrategy,
          ...(enabled ? { pauseAfterFirstPanel: true } : {}),
        },
      },
    }));
    toastSuccess(enabled ? '已开启：生成第一格后暂停确认' : '已关闭：一次性生成全部画面');
  };

  /**
   * Phase 1.1 §六/§七 + V4.2.11 §B：生成角色参考图——与其他漫画任务同一条链路：
   * buildCharacterReferenceTask → createSeriesTask（报价确认 + 两段授权 + TaskQueue +
   * settle + Gallery/History 全继承，零平行系统）；不触碰 panels。
   * §B 异步：A 角色在途不影响 B 角色提交；仅同角色在途 / 提交确认中去重。
   */
  const [refSubmitting, setRefSubmitting] = useState<Record<string, boolean>>({});
  const handleGenerateCharacterRef = (character: ComicCharacter) => {
    if (!active) {
      toastError('请先打开一个漫画项目');
      return;
    }
    const state = referenceTasks[character.id]?.status;
    if (state === 'queued' || state === 'running' || refSubmitting[character.id]) {
      toastError(`角色「${character.name}」的参考图任务已在进行中`);
      return;
    }
    try {
      const build = buildCharacterReferenceTask(active, character, generationContext);
      setRefSubmitting(prev => ({ ...prev, [character.id]: true }));
      void useTaskStore.getState()
        .createSeriesTask(build.params, 1)
        .then(() => {
          toastSuccess(`角色「${character.name}」参考图任务已提交，进度见任务队列`);
        })
        .catch((err: unknown) => {
          if (!isQuoteCancelled(err)) {
            toastError(err instanceof Error ? err.message : '任务提交失败，请重试');
          }
        })
        .finally(() => {
          setRefSubmitting(prev => {
            const next = { ...prev };
            delete next[character.id];
            return next;
          });
        });
    } catch (err) {
      toastError(err instanceof Error ? err.message : '参考图任务构建失败');
    }
  };

  /**
   * V4.2.11 §B：一键补齐缺失参考图——所有已绑定但还没有参考图、且没有在途任务的角色，
   * 逐个提交（每个任务独立报价确认 / 独立 queued→completed 状态，互不阻塞）。
   */
  const handleGenerateMissingRefs = async () => {
    if (!active) return;
    const bound = active.skillSnapshot.characterSlots
      .map(slot => active.characterBindings[slot.slotId])
      .filter((id): id is string => Boolean(id))
      .map(id => active.characterSnapshots.find(character => character.id === id))
      .filter((character): character is ComicCharacter => character !== null);
    const missing = bound.filter(character =>
      !character.referenceImage
      && referenceTasks[character.id]?.status !== 'queued'
      && referenceTasks[character.id]?.status !== 'running'
      && !refSubmitting[character.id]);
    if (missing.length === 0) {
      toastError('已绑定的角色都有参考图或任务在途，无需补齐');
      return;
    }
    let submitted = 0;
    for (const character of missing) {
      try {
        const build = buildCharacterReferenceTask(active, character, generationContext);
        setRefSubmitting(prev => ({ ...prev, [character.id]: true }));
        await useTaskStore.getState().createSeriesTask(build.params, 1);
        submitted += 1;
      } catch (err) {
        if (!isQuoteCancelled(err)) {
          toastError(err instanceof Error ? err.message : '任务提交失败，请重试');
        }
        break; // 取消报价或失败即停（已提交的继续跑）
      } finally {
        setRefSubmitting(prev => {
          const next = { ...prev };
          delete next[character.id];
          return next;
        });
      }
    }
    if (submitted > 0) toastSuccess(`已提交 ${submitted} 个角色参考图任务，进度见任务队列`);
  };

  // ===== 项目库 / 创建 =====

  const handleOpenProject = async (id: string) => {
    const opened = await openProject(id);
    if (!opened) toastError('项目打开失败，请重试');
  };

  const handleCreate = async (input: {
    name: string;
    skill: ComicSkill;
    skillId?: string;
    storyDraft?: ComicStory;
    requirement?: string;
    /** V4.2.8 §49~§57：形式来源随项目持久化（user_fixed 后续规划不得改排版）。 */
    presentationSource?: ComicPresentationSource;
  }) => {
    await createProject({
      name: input.name,
      skill: input.skill,
      skillId: input.skillId,
      storyDraft: input.storyDraft,
      requirement: input.requirement,
      presentationSource: input.presentationSource,
    });
    setCreateOpen(false);
    toastSuccess('漫画项目已创建');
  };

  const handleCreateFromLibrary = async (input: { name: string; skillId: string }) => {
    const raw = await api.loadComicSkill(input.skillId);
    if (!raw) {
      toastError('技能文档读取失败');
      return;
    }
    const skill = normalizeComicSkill(JSON.parse(raw) as ComicSkill);
    await createProject({ name: input.name, skill, skillId: input.skillId });
    setCreateOpen(false);
    toastSuccess('漫画项目已创建');
  };

  const confirmDelete = async () => {
    if (!deleteTargetId) return;
    const target = projects.find(item => item.id === deleteTargetId);
    await deleteProject(deleteTargetId);
    setDeleteTargetId(null);
    if (target) toastSuccess(`已删除「${target.name}」`);
  };

  // ===== 文字层（验收 I：对白编辑零生图——只走 upsert/remove/moveZ）=====

  const handleDialogueChange = useCallback((dialogue: ComicDialogue) => {
    applyProject(draft => upsertDialogue(draft, dialogue));
  }, [applyProject]);

  const handleDialogueRemove = useCallback((dialogueId: string) => {
    applyProject(draft => removeDialogue(draft, dialogueId));
  }, [applyProject]);

  /** V4.2.14 §79：同格 z 序调整（数组顺序 = z-order，纯 dialogues 操作）。 */
  const handleDialogueMoveZ = useCallback((dialogueId: string, direction: 'front' | 'back') => {
    applyProject(draft => moveDialogueZ(draft, dialogueId, direction));
  }, [applyProject]);

  // ===== AI 对白导演（V4.2.14：建议 → 确认 → 应用；弹窗零 store 写入）=====

  const handleApplyDirectorProposals = useCallback((drafts: ComicDialogue[], options: { overwrite: boolean }) => {
    // 消费 applyDialogueDrafts 的 summary（V4.2.13 残留：此前丢弃 summary——
    // 建议被 fill 铁律整格跳过时用户得不到任何反馈，静默失败）。
    const appliedBox: { summary: ReturnType<typeof applyDialogueDrafts>['summary'] | null } = { summary: null };
    applyProject(draft => {
      const result = applyDialogueDrafts(draft, drafts, options);
      appliedBox.summary = result.summary;
      return result.project;
    });
    const summary = appliedBox.summary;
    if (!summary || summary.added === 0) {
      toastError('没有可应用的 AI 对白：目标格已有内容（AI 不覆写人工内容）');
      return;
    }
    const parts = [`已应用 ${summary.added} 条 AI 对白`];
    if (summary.replacedPanels.length > 0) parts.push(`替换 ${summary.replacedPanels.length} 格旧对白`);
    if (summary.skippedPanels.length > 0) parts.push(`跳过 ${summary.skippedPanels.length} 格（已有对白）`);
    toastSuccess(parts.join('，'));
  }, [applyProject]);

  const handleApplyDirectorPlacement = useCallback((panelOutcomes: Array<{ suggestions: Array<{ dialogueId: string }> }>) => {
    const suggestions = panelOutcomes.flatMap(outcome => outcome.suggestions);
    if (suggestions.length === 0) return;
    applyProject(draft => applyVisionPlacement(draft, suggestions as Parameters<typeof applyVisionPlacement>[1]));
    toastSuccess(`已应用 ${suggestions.length} 条视觉摆放建议（只改位置，不改文字）`);
  }, [applyProject]);

  /** §63~§66 烘焙文字（实验）：独立 createSeriesTask 提交（报价确认复用既有链路），不改 panel 状态。 */
  const [bakeSubmitting, setBakeSubmitting] = useState(false);
  const handleSubmitBakeText = (panelId: string) => {
    if (!active) return;
    try {
      const build = buildBakeTextTask(active, panelId, generationContext);
      setBakeSubmitting(true);
      void useTaskStore.getState()
        .createSeriesTask(build.params, 1)
        .then(() => {
          toastSuccess(`烘焙任务已提交（${build.quote.dialogueCount} 条文字 · 图生图 1 张），结果将保存为派生资产，原图不动`);
        })
        .catch((err: unknown) => {
          if (!isQuoteCancelled(err)) {
            toastError(err instanceof Error ? err.message : '烘焙任务提交失败，请重试');
          }
        })
        .finally(() => setBakeSubmitting(false));
    } catch (err) {
      toastError(err instanceof Error ? err.message : '烘焙任务构建失败');
    }
  };

  /**
   * V4.2.12 §41~§44：手动调整分镜顺序——只交换两格 order（排版事实），id / 对白
   * panelId / imageAsset / compiledPrompt 全部不动；不标记 stale、不触发重新生成。
   */
  const handlePanelMove = useCallback((panelId: string, direction: 'up' | 'down') => {
    applyProject(draft => moveProjectPanel(draft, panelId, direction));
  }, [applyProject]);

  /**
   * §B/§F 显式导出（V4.2.13 残留修复）：整页合成与图库落库严格收敛到本入口——
   * 「对白与字幕 → 导出整页 PNG」。此前存在一个 composeKey 自动 effect（对白/成图
   * 指纹变化 2.5s 后自动合成整页 + 入图库 + toast），编辑对白即触发导出，违反
   * 「编辑态零自动导出」铁律，已删除。纯本地合成，零 Image2。
   */
  const handleExport = useCallback(async () => {
    if (!active) return;
    setExporting(true);
    try {
      // §B Current-state Export：导出前冲刷 600ms 防抖持久化，画布所见 = 导出所得
      await useComicStore.getState().flushPersist();
      const saved = await exportComicSheetPng(active);
      if (saved === 0) {
        toastError('导出失败：请确认分镜图片都在本地');
        return;
      }
      // 用户显式导出 = 唯一的整页合成时机：最终页写入图库 + finalPages 索引回写
      const assets = await persistComicFinalPages(active);
      if (assets.length > 0) {
        useComicStore.getState().updateActive(draft => applyComicFinalPages(draft, assets));
        void attributeComicPanelImages(active, () => false);
        toastSuccess(saved > 1 ? `已导出 ${saved} 张整页 PNG，最终页已存入图库` : '整页 PNG 已导出，最终页已存入图库');
        return;
      }
      if (saved > 1) toastSuccess(`已导出 ${saved} 张整页 PNG`);
      else toastSuccess('整页 PNG 已导出');
    } finally {
      setExporting(false);
    }
  }, [active]);

  const handleApplyStory = (story: ComicStory, panels: ComicPanel[], dialogues: ComicDialogue[]) => {
    if (!active) return;
    // Story Lock（V4.2.13）：过期分镜草稿（故事已重新确认）不应用，提示重出
    const result = applyStoryToProject(active, story, panels, dialogues);
    if (result.rejected) {
      toastError(result.rejected);
      return;
    }
    applyProject(draft => applyStoryToProject(draft, story, panels, dialogues).project);
    if (result.preservedDialogues && result.preservedDialogues > 0) {
      toastSuccess(`分镜已应用（保留 ${result.preservedDialogues} 条人工 / AI 对白）`);
    }
  };

  /** Phase 1.2 Step 1：确认故事（只写 story；旧分镜 stale 化，分镜草稿在 Step 4 重出）。 */
  const handleConfirmStory = (story: ComicStory) => {
    // Story Lock 可见性：故事指纹变化时旧代分镜/对白整体归档——toast 明示去向，
    // 不再静默淘汰（V4.2.13 残留修复）。
    let archived = { panels: 0, dialogues: 0 };
    applyProject(draft => {
      const result = applyStoryOnlyToProject(draft, story);
      archived = {
        panels: result.staleMarked,
        dialogues: result.archivedDialogues ?? 0,
      };
      return result.project;
    });
    if (archived.panels > 0 || archived.dialogues > 0) {
      const parts = [`旧故事 ${archived.panels} 格分镜已归档`];
      if (archived.dialogues > 0) parts.push(`${archived.dialogues} 条人工/AI 对白一并归档`);
      parts.push('请到「分镜」步骤重新生成分镜');
      toastSuccess(parts.join('，'));
    }
  };

  /** §7 资产能力：当前方案快照保存为可复用漫画技能（库 version+1；项目快照不回写）。 */
  const handleSaveAsSkill = async () => {
    if (!active) return;
    await useComicStore.getState().saveSkill(active.skillSnapshot);
    if (!active.skillId) {
      updateActive(draft => ({ ...draft, skillId: draft.skillSnapshot.id }));
    }
    toastSuccess('已保存为漫画技能，新建项目时可直接复用');
  };

  /** §19/§22A：项目角色 → 演员库条目（快照语义：入库不回写项目）。 */
  const handleSaveCharacterToLibrary = useCallback(
    async (character: ComicCharacter) => useComicStore.getState().saveCharacter(comicCharacterToLibraryEntry(character)),
    [],
  );

  /** §18 引用即计数：从库选角成功后 +1 usageCount / 刷新 lastUsedAt（异步，不阻断选角）。 */
  const handleRecordCharacterUsage = useCallback((id: string) => {
    void useComicStore.getState().recordCharacterUsage(id);
  }, []);

  // ===== 渆染 =====

  const deleteTarget = projects.find(item => item.id === deleteTargetId) ?? null;
  const step = viewStep ?? flow?.currentStep ?? 'skill';

  return (
    <div className="page comic-page">
      <header className="page-header">
        <h2>AI 漫画</h2>
        <p>本期故事 → 画面与形式 → 角色演员 → 分镜草稿 → {active ? comicStepTitle(active, 'generate') : '生成漫画画面'} → 对白与字幕；改对白不重新生成图片</p>
      </header>

      {!active && (
        <div className="comic-home">
          <div className="comic-home-bar">
            <span className="comic-muted">{listLoading ? '读取中…' : `共 ${projects.length} 个项目`}</span>
            <button type="button" className="app-btn app-btn-primary" onClick={() => setCreateOpen(true)}>新建漫画项目</button>
          </div>
          {projects.length === 0 && !listLoading && (
            <div className="comic-empty-state">
              <p>还没有漫画项目</p>
              <p className="comic-muted">从一句需求开始：AI 推荐完整漫画方案（画风 / 形式 / 角色槽位），再逐期复用</p>
              <button type="button" className="app-btn app-btn-primary" onClick={() => setCreateOpen(true)}>创建第一个漫画项目</button>
            </div>
          )}
          <div className="comic-project-grid">
            {projects.map(project => (
              <div className="comic-project-card" key={project.id}>
                <button type="button" className="comic-project-open" onClick={() => void handleOpenProject(project.id)}>
                  <strong>{project.name}</strong>
                  <span className="comic-stage-badge">{comicStageLabel(project.stage)}</span>
                  <span className="comic-muted">更新于 {new Date(project.updatedAt).toLocaleString()}</span>
                </button>
                <div className="comic-project-actions">
                  <button type="button" className="app-btn app-btn-danger app-btn-sm" onClick={() => setDeleteTargetId(project.id)}>删除</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {active && flow && (
        <>
          <div className="comic-project-header">
            <div className="comic-project-title">
              <strong>{active.name}</strong>
              <span className="comic-stage-badge">{comicStageLabel(active.stage)}</span>
              <span className={`comic-save-state comic-save-${saveState.status}`}>
                {SAVE_STATE_LABELS[saveState.status] ?? ''}
                {saveState.status === 'error' && (
                  <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={() => void retrySave()}>重试保存</button>
                )}
              </span>
            </div>
            <div className="comic-project-ops">
              <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={() => void refreshLists()}>刷新列表</button>
              <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={() => { void useComicStore.getState().flushPersist(); closeProject(); }}>回到项目库</button>
            </div>
          </div>
          {lastError && <div className="comic-error-bar">{lastError}</div>}

          <div className="comic-workbench">
            <nav className="comic-steps" aria-label="漫画创作步骤">
              {flow.steps.map(flowStep => {
                // §10.3 步骤门禁：未放行步骤可点但给出原因（点击不无反应）
                const locked = !flowStep.enterable && flowStep.status !== 'completed' && flowStep.id !== step;
                const lockReason = flowStep.blockedReasons[0];
                return (
                  <button
                    type="button"
                    key={flowStep.id}
                    className={`comic-step${flowStep.id === step ? ' is-current' : ''}${flowStep.status === 'completed' ? ' is-done' : ''}${locked ? ' is-locked' : ''}`}
                    title={locked && lockReason ? `暂不可进入：${lockReason}` : undefined}
                    onClick={() => {
                      if (locked) {
                        toastError(lockReason ? `暂不可进入「${flowStep.title}」：${lockReason}` : `请先完成前面的步骤`);
                        return;
                      }
                      setViewStep(flowStep.id);
                    }}
                  >
                    <span className="comic-step-dot" aria-hidden />
                    <span className="comic-step-text">
                      <strong>{flowStep.title}</strong>
                      <em>{flowStep.hint}</em>
                    </span>
                  </button>
                );
              })}
            </nav>

            <main className="comic-main">
              {step === 'skill' && (
                <ComicSkillStage
                  project={active}
                  onPatch={applyProject}
                  onDraft={handleDraft}
                  confirmed={active.stage !== 'skill_draft'}
                  onConfirm={() => {
                    updateActive(draft => ({ ...draft, stage: 'character_confirmation' }));
                    setViewStep('characters');
                  }}
                  onSaveAsSkill={() => void handleSaveAsSkill()}
                />
              )}
              {step === 'characters' && (
                <ComicCharacterStage
                  project={active}
                  onPatch={applyProject}
                  onDraft={handleDraft}
                  blockers={flow.steps.find(item => item.id === 'characters')?.blockers ?? []}
                  libraryCharacters={characters}
                  referenceTasks={referenceTasks}
                  onGenerateReference={handleGenerateCharacterRef}
                  onGenerateMissingRefs={() => void handleGenerateMissingRefs()}
                  onSaveToLibrary={handleSaveCharacterToLibrary}
                  onRecordUsage={handleRecordCharacterUsage}
                />
              )}
              {step === 'story' && (
                <ComicStoryStage project={active} onConfirmStory={handleConfirmStory} onDraft={handleDraft} />
              )}
              {step === 'storyboard' && (
                <ComicStoryboardStage project={active} onApply={handleApplyStory} onPatch={applyProject} onPanelMove={handlePanelMove} onDraft={handleDraft} />
              )}
              {step === 'generate' && (
                <ComicGenerateStage
                  project={active}
                  seriesBlockers={flow.steps.find(item => item.id === 'generate')?.blockers ?? []}
                  taskRunning={panelsTaskRunning}
                  pauseAfterFirstPanel={active.skillSnapshot.referenceStrategy.pauseAfterFirstPanel === true}
                  onTogglePauseAfterFirstPanel={handleTogglePauseAfterFirstPanel}
                  onGenerateAnchor={handleGenerateAnchor}
                  onRegenerateAnchor={handleGenerateAnchor}
                  onLockAnchor={handleLockAnchor}
                  onGenerateSeries={handleGenerateSeries}
                  onRegeneratePanel={handleRegeneratePanel}
                />
              )}
              {step === 'text' && (
                <ComicTextStage
                  project={active}
                  onDialogueChange={handleDialogueChange}
                  onDialogueRemove={handleDialogueRemove}
                  onDialogueMoveZ={handleDialogueMoveZ}
                  onOpenAiDirector={() => setDirectorOpen(true)}
                  onExport={() => handleExport()}
                  exporting={exporting}
                />
              )}

              {/* Phase 1.1 §10.2：步骤 Footer CTA（← 上一步 / 阻塞原因清单 / 继续 → ） */}
              <ComicStepFooter flow={flow} step={step} onGoto={setViewStep} />
            </main>

            <aside className="comic-rail">
              <section className="comic-rail-card">
                <h4>本期方案</h4>
                {/* Phase 1.2 §13.2：视觉信息（形式缩略 / 主角参考图），有才显示 */}
                <div className="comic-rail-visuals" data-testid="comic-rail-visuals">
                  <div className="comic-rail-visual-item" title="本期展示形式">
                    {/* V4.2.12 §64-68：Rail 统一 Mini Canvas（多页 = 堆叠页 +「+N 页」，无「第N页」文字重叠） */}
                    <ComicFormPreviewMini presentation={resolveComicPresentation(active.skillSnapshot)} />
                    <span>形式</span>
                  </div>
                  {railHeroRef && railThumbs.hero && (
                    <div className="comic-rail-visual-item" title={`${railHeroRef.label}（主角参考图）`}>
                      <img className="comic-rail-thumb" src={railThumbs.hero} alt="主角参考图" />
                      <span>主角</span>
                    </div>
                  )}
                </div>
                <div className="comic-rail-rows">
                  <div><span>故事</span><strong>{active.story?.title ?? '未规划'}</strong></div>
                  <div><span>形式</span><strong>{comicPresentationLabel(resolveComicPresentation(active.skillSnapshot))}</strong></div>
                  <div>
                    <span>角色</span>
                    <strong data-testid="comic-rail-characters">{charactersSummary?.summaryLabel ?? '—'}</strong>
                  </div>
                  {charactersSummary && charactersSummary.requiredTotal > 0 && (
                    <div className="comic-rail-cast" data-testid="comic-rail-cast">
                      <span className="comic-rail-cast-count">
                        已锁定 {charactersSummary.requiredLocked}/{charactersSummary.requiredTotal}
                      </span>
                      <div className="comic-rail-cast-chips">
                        {charactersSummary.slots.filter(slot => slot.characterId).map(slot => (
                          <span
                            key={slot.slotId}
                            className={`comic-rail-cast-chip${slot.state === 'locked' ? ' is-locked' : ''}`}
                            title={`${slot.characterName} · ${slot.label}`}
                          >
                            {railThumbs[`cast:${slot.characterId}`]
                              ? <img src={railThumbs[`cast:${slot.characterId}`]} alt={slot.characterName ?? ''} />
                              : <span className="comic-rail-cast-initial" aria-hidden>
                                  {(slot.characterName ?? '角').slice(0, 1)}
                                </span>}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  <div><span>图片</span><strong data-testid="comic-rail-panels">{projectSummary ? `${projectSummary.generatedPanels}/${projectSummary.totalPanels} 成图` : '—'}</strong></div>
                  <div><span>下一步</span><strong>{projectSummary?.nextStepTitle ?? '本期已完成'}</strong></div>
                </div>
              </section>
              {import.meta.env.DEV && charactersSummary && (
                <section className="comic-rail-card">
                  <details className="comic-debug-card" data-testid="comic-debug-card">
                    <summary>DEV · 漫画状态</summary>
                    <dl>
                      <dt>stage</dt><dd>{active.stage}</dd>
                      <dt>必选/锁定</dt><dd>{charactersSummary.requiredLocked}/{charactersSummary.requiredTotal}</dd>
                      <dt>参考图就绪</dt><dd>{charactersSummary.referenceReady}</dd>
                      <dt>comic_planner</dt>
                      <dd>{(() => {
                        const resolution = resolveModelForRole('comic_planner');
                        return resolution.ok ? resolution.resolved.displayName : resolution.error;
                      })()}</dd>
                      {charactersSummary.slots.filter(slot => slot.characterId).map(slot => (
                        <Fragment key={slot.slotId}>
                          <dt>{slot.characterName}</dt>
                          <dd>
                            {slot.state}
                            {referenceTasks[slot.characterId!] ? ` · 任务 ${referenceTasks[slot.characterId!]!.taskId.slice(0, 8)}（${referenceTasks[slot.characterId!]!.status}）` : ''}
                          </dd>
                        </Fragment>
                      ))}
                    </dl>
                  </details>
                </section>
              )}
              <section className="comic-rail-card">
                <h4>生成设置</h4>
                <div className="form-group">
                  <OutputPathPicker value={outputDir} onChange={setOutputDir} label="输出位置" />
                </div>
                <p className="comic-muted">尺寸 / 质量沿用默认生成参数；画面按分镜逐格生成；整页在「对白与字幕 → 导出整页 PNG」时合成</p>
              </section>
              <section className="comic-rail-card">
                <h4>漫画任务</h4>
                {comicTasks.length === 0 && <p className="comic-muted">还没有提交过生成任务</p>}
                {comicTasks.slice(0, 5).map(task => (
                  <div className="comic-rail-task" key={task.id}>
                    <span>{task.task_plan_summary ?? task.prompt.slice(0, 24)}</span>
                    <span className={`comic-status comic-status-${task.status === 'completed' ? 'completed' : task.status === 'failed' || task.status === 'cancelled' ? 'failed' : 'running'}`}>
                      {task.status === 'completed' ? '已完成' : task.status === 'failed' ? '失败' : task.status === 'cancelled' ? '已取消' : '进行中'}
                    </span>
                  </div>
                ))}
              </section>
              {flow.imagesReady && active.stage !== 'completed' && (
                <section className="comic-rail-card">
                  <h4>完成本期</h4>
                  <p className="comic-muted">整页导出 PNG 后可标记本期完成（随时可继续编辑对白再导出）</p>
                  <button
                    type="button"
                    className="app-btn app-btn-primary"
                    onClick={() => { updateActive(draft => ({ ...draft, stage: 'completed' })); toastSuccess('本期已标记完成'); }}
                  >
                    标记本期完成
                  </button>
                </section>
              )}
            </aside>
          </div>
        </>
      )}

      <ComicNewProjectDialog
        open={createOpen}
        skills={skills}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreate}
        onCreateFromLibrary={handleCreateFromLibrary}
      />
      {deleteTarget && (
        <ComicDeleteProjectDialog
          projectName={deleteTarget.name}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTargetId(null)}
        />
      )}
      {active && (
        <AIDialogueDirectorDialog
          open={directorOpen}
          project={active}
          onClose={() => setDirectorOpen(false)}
          onApplyProposals={handleApplyDirectorProposals}
          onApplyPlacement={handleApplyDirectorPlacement}
          onSubmitBakeText={handleSubmitBakeText}
          bakeSubmitting={bakeSubmitting}
        />
      )}
      {exporting && <div className="comic-exporting-note">正在合成整页…</div>}
    </div>
  );
}
