/**
 * AI 漫画工作台流程状态（Phase 10/11 + Phase 1.2 重排 + V4.2.11 动态工作流）——
 * 镜像 visionWizard.ts 思想：步骤完成态只有一个 selector，步骤栏 / 进度卡 / CTA 一律查表，
 * 禁止 UI 从散落字段各自反推完成。
 *
 * V4.2.11 §D：步骤按展示形式动态（P0-5/P0-6 收口，docs/ai-comic/19 审计 Q5）：
 *   Step 1 story      本期故事     —— 这期讲什么（Story Hero Card）
 *   Step 2 skill      画面与形式   —— 漫画形式 / 画风 / 对白方式（Presentation 确认 = Skill 确认）
 *   Step 3 characters 角色演员     —— 演员定妆 + 参考图 + 锁定
 *   Step 4 storyboard 分镜草稿     —— AI 把故事拆成每一格画什么
 *   Step 5 generate   生成漫画画面（single_page/strip）/ 生成漫画页面（multi_page）
 *                      —— 内部提交全部 Panel 任务；锚点（anchor）与系列（series）是内部
 *                         一致性机制，不再是用户步骤；旧 step id anchor/panels 读入即映射；
 *                         高级项「生成第一格后暂停确认」（默认关）才恢复两段式节奏
 *   Step 6 text       对白与字幕   —— 纯文字层，零生图
 *
 * 步骤完成 = 领域事实（Story 存在 / Skill 校验通过 / 角色就绪 / 分镜存在 /
 * 分镜全部成图），不是用户「看过」。currentStep = 第一个未完成步骤；
 * 已完成步骤随时可回看（步骤切换是视图操作，绝不触碰语义状态）。
 *
 * Phase 1.2 §81：进入「对白与字幕」只需至少一格可编辑成图（允许 partial）。
 */

import type { ComicProject, ComicProjectStage } from './types';
import {
  comicCharacterConfirmationState,
  comicCharactersSummaryState,
  comicPanelSeriesReadiness,
  comicStoryboardReadiness,
} from './domain';
import { validateComicSkill } from './normalize';
import { comicPresentationLabel, resolveComicPresentation } from './presentation';

export type ComicStudioStepId =
  | 'story'
  | 'skill'
  | 'characters'
  | 'storyboard'
  | 'generate'
  | 'text';

/** 旧步骤 id（V4.2.10 anchor/panels）→ V4.2.11 generate（会话恢复 / 深链兼容）。 */
export function normalizeComicStepId(id: string): ComicStudioStepId | null {
  if (id === 'anchor' || id === 'panels') return 'generate';
  return (['story', 'skill', 'characters', 'storyboard', 'generate', 'text'] as const).includes(
    id as ComicStudioStepId,
  ) ? id as ComicStudioStepId : null;
}

export interface ComicStudioStep {
  id: ComicStudioStepId;
  title: string;
  hint: string;
  status: 'pending' | 'current' | 'completed';
  /** 进入下一步前必须解决的阻塞项（空 = 可继续）。 */
  blockers: string[];
  /** 是否允许进入（前置步骤全部完成即放行；当前步与已完成步恒可进）。 */
  enterable: boolean;
  /** 禁止进入的原因（取第一个未完成前置步骤的阻塞清单，点击不无反应——给原因）。 */
  blockedReasons: string[];
}

export interface ComicStudioFlow {
  steps: ComicStudioStep[];
  currentStep: ComicStudioStepId;
  /** 全部图片层完成（整页导出 / 标记完成的门槛；对白编辑只要求 partial）。 */
  imagesReady: boolean;
}

/** 步骤栏 / Footer / Summary 共用的步骤标题（用户语言，规格 §34 + V4.2.11 §D）。 */
export const COMIC_STEP_TITLES: Record<ComicStudioStepId, string> = {
  story: '本期故事',
  skill: '画面与形式',
  characters: '角色演员',
  storyboard: '分镜草稿',
  generate: '生成漫画画面',
  text: '对白与字幕',
};

/** §D 动态标题：multi_page → 生成漫画页面；其余（单页合成 / 条漫）→ 生成漫画画面。 */
export function comicGenerateStepTitle(project: ComicProject): string {
  const presentation = resolveComicPresentation(project.skillSnapshot);
  return presentation.outputMode === 'multi_page' ? '生成漫画页面' : '生成漫画画面';
}

/** 项目相关的步骤标题（含 generate 动态档）。 */
export function comicStepTitle(project: ComicProject, step: ComicStudioStepId): string {
  return step === 'generate' ? comicGenerateStepTitle(project) : COMIC_STEP_TITLES[step];
}

export const COMIC_STAGE_LABELS: Record<ComicProjectStage, string> = {
  draft: '草稿',
  skill_draft: '画面与形式',
  character_confirmation: '角色演员',
  story_ready: '故事与分镜',
  generating_anchor: '生成漫画画面',
  anchor_review: '生成漫画画面',
  generating_panels: '生成漫画画面',
  editing: '对白与字幕',
  completed: '已完成',
  failed: '失败',
};

/** 结尾类型用户文案（Story Hero / Facts 卡 / Rail 同源）。 */
export const COMIC_ENDING_TYPE_LABELS: Record<string, string> = {
  twist: '反转',
  punchline: '抖包袱',
  warm: '温情',
  flat: '平收',
  custom: '自定义',
};

function activePanelsOf(project: ComicProject) {
  return project.panels.filter(panel => !panel.stale);
}

/** 事实派生流程状态（步骤栏 / Rail 进度 / CTA 门禁唯一入口）。 */
export function getComicStudioFlow(project: ComicProject): ComicStudioFlow {
  const skill = project.skillSnapshot;
  const skillErrors = validateComicSkill(skill);
  const confirmation = comicCharacterConfirmationState(project);
  const panels = activePanelsOf(project);
  const imagesReady = panels.length > 0 && panels.every(panel => panel.generationStatus === 'completed' && panel.imageAsset);
  // §D/F：默认一步生成（skipAnchor）；高级「生成第一格后暂停确认」开启时保留内部锚点门禁
  const pauseAfterFirst = skill.referenceStrategy.pauseAfterFirstPanel === true;
  const seriesReadiness = comicPanelSeriesReadiness(project, { skipAnchor: !pauseAfterFirst });

  const storyDone = Boolean(project.story);
  const skillDone = skillErrors.length === 0 && project.stage !== 'skill_draft';
  const charactersDone = confirmation.ready;
  // V4.2.11 §E：分镜完成 = 铺满本期版式（四宫格 4 格全 valid），不是「有格就行」
  const storyboardReadiness = comicStoryboardReadiness(project);
  const storyboardDone = storyboardReadiness.ready;
  const generateDone = imagesReady;
  // §81：对白与字幕允许 partial——至少一格可编辑成图即可进入
  const textEditable = panels.some(panel => panel.generationStatus === 'completed' && panel.imageAsset);

  const steps: ComicStudioStep[] = [
    {
      id: 'story',
      title: COMIC_STEP_TITLES.story,
      hint: '这期讲什么：一句话主题 → AI 出故事 → 确认',
      status: storyDone ? 'completed' : 'pending',
      blockers: storyDone ? [] : ['本期故事尚未确认'],
      enterable: true,
      blockedReasons: [],
    },
    {
      id: 'skill',
      title: COMIC_STEP_TITLES.skill,
      hint: '漫画形式 / 画风 / 对白方式（确认 = 方案定稿）',
      status: skillDone ? 'completed' : 'pending',
      blockers: skillErrors,
      enterable: storyDone,
      blockedReasons: storyDone ? [] : ['本期故事尚未确认'],
    },
    {
      id: 'characters',
      title: COMIC_STEP_TITLES.characters,
      hint: '演员定妆：外观特征 + 参考图 + 锁定',
      status: charactersDone ? 'completed' : 'pending',
      blockers: confirmation.blockers,
      enterable: storyDone && skillDone,
      blockedReasons: !storyDone
        ? ['本期故事尚未确认']
        : skillDone
          ? []
          : ['画面与形式未确认'],
    },
    {
      id: 'storyboard',
      title: COMIC_STEP_TITLES.storyboard,
      hint: 'AI 把故事拆成每一格画什么',
      status: storyboardDone ? 'completed' : 'pending',
      blockers: storyboardDone ? [] : storyboardReadiness.blockers,
      enterable: storyDone && skillDone && charactersDone,
      blockedReasons: !storyDone
        ? ['本期故事尚未确认']
        : !skillDone
          ? ['画面与形式未确认']
          : charactersDone
            ? []
            : confirmation.blockers,
    },
    {
      id: 'generate',
      title: comicGenerateStepTitle(project),
      hint: '按分镜逐格生成全部画面，完成后本地组合成整页',
      status: generateDone ? 'completed' : 'pending',
      blockers: generateDone ? [] : seriesReadiness.blockers,
      enterable: storyDone && skillDone && charactersDone && storyboardDone,
      blockedReasons: !storyDone
        ? ['本期故事尚未确认']
        : !skillDone
          ? ['画面与形式未确认']
          : !charactersDone
            ? confirmation.blockers
            : !storyboardDone
              ? storyboardReadiness.blockers
              : [],
    },
    {
      id: 'text',
      title: COMIC_STEP_TITLES.text,
      hint: '对白 / 气泡 / 位置（纯文字层，零生图）',
      status: project.stage === 'completed' ? 'completed' : 'pending',
      blockers: [],
      enterable: storyDone && skillDone && charactersDone && storyboardDone && textEditable,
      blockedReasons: !storyDone
        ? ['本期故事尚未确认']
        : !skillDone
          ? ['画面与形式未确认']
          : !charactersDone
            ? confirmation.blockers
            : !storyboardDone
              ? storyboardReadiness.blockers
              : !textEditable
                ? ['至少一格成图后才能编辑对白']
                : [],
    },
  ];

  const currentStep = steps.find(step => step.status !== 'completed')?.id ?? 'text';
  return {
    steps: steps.map(step => (step.id === currentStep ? { ...step, status: 'current' as const } : step)),
    currentStep,
    imagesReady,
  };
}

/**
 * 事实 → 项目阶段标签（持久化 stage 与事实对齐的唯一入口；
 * completed / failed 为终态标记，不由事实自动回退）。
 * Phase 1.2 起顺序对齐用户步骤序：故事 → 画面与形式 → 角色演员 → 分镜。
 */
export function deriveComicStage(project: ComicProject): ComicProjectStage {
  if (project.stage === 'completed' || project.stage === 'failed') return project.stage;
  const skill = validateComicSkill(project.skillSnapshot);
  if (skill.length > 0 || project.stage === 'skill_draft') return 'skill_draft';
  if (!project.story) return 'story_ready';
  if (!comicCharacterConfirmationState(project).ready) return 'character_confirmation';
  if (activePanelsOf(project).length === 0) return 'story_ready';
  // V4.2.11 §F：默认一步生成——锚点门禁只在高级「生成第一格后暂停确认」开启时生效
  // （内部 anchor* 阶段 enum 保留向后兼容，标签已归用户语言）
  const pauseAfterFirst = project.skillSnapshot.referenceStrategy.pauseAfterFirstPanel === true;
  if (!pauseAfterFirst) {
    const panelsNow = activePanelsOf(project);
    const allDone = panelsNow.length > 0 && panelsNow.every(panel => panel.generationStatus === 'completed' && panel.imageAsset);
    return allDone ? 'editing' : 'generating_panels';
  }
  if (!project.consistency?.anchor) {
    const anchorPanel = activePanelsOf(project).find(panel => panel.generationStatus === 'completed' && panel.imageAsset);
    return anchorPanel ? 'anchor_review' : 'generating_anchor';
  }
  const panels = activePanelsOf(project);
  const allDone = panels.length > 0 && panels.every(panel => panel.generationStatus === 'completed' && panel.imageAsset);
  return allDone ? 'editing' : 'generating_panels';
}

/** 项目卡 / 头部的阶段徽标文案。 */
export function comicStageLabel(stage: string): string {
  return COMIC_STAGE_LABELS[stage as ComicProjectStage] ?? stage;
}

// ---------------------------------------------------------------------------
// Phase 1.2 聚焦 selector（§86/§87/§88）：Header / Rail / Hero Card 同源，
// 禁止组件从散落字段自行拼接摘要状态。
// ---------------------------------------------------------------------------

/** 项目总览（Right Rail「本期方案」/ 项目头的单一事实源）。 */
export interface ComicProjectSummary {
  storyStatus: 'unplanned' | 'ready';
  /** 画面与形式（Presentation）确认 = Skill 确认（stage≠skill_draft 且校验通过）。 */
  presentationStatus: 'unconfirmed' | 'confirmed';
  requiredCharacters: number;
  lockedCharacters: number;
  anchorStatus: 'unlocked' | 'locked';
  generatedPanels: number;
  totalPanels: number;
  currentStage: ComicProjectStage;
  currentStep: ComicStudioStepId;
  nextStep: ComicStudioStepId | null;
  nextStepTitle: string | null;
}

export function getComicProjectSummary(project: ComicProject): ComicProjectSummary {
  const flow = getComicStudioFlow(project);
  const characters = comicCharactersSummaryState(project);
  const panels = activePanelsOf(project);
  const nextStep = flow.steps.find(step => step.status !== 'completed' && step.id !== flow.currentStep) ?? null;
  return {
    storyStatus: project.story ? 'ready' : 'unplanned',
    presentationStatus: flow.steps.find(step => step.id === 'skill')!.status === 'completed'
      ? 'confirmed'
      : 'unconfirmed',
    requiredCharacters: characters.requiredTotal,
    lockedCharacters: characters.requiredLocked,
    anchorStatus: project.consistency?.anchor ? 'locked' : 'unlocked',
    generatedPanels: panels.filter(panel => panel.generationStatus === 'completed' && panel.imageAsset).length,
    totalPanels: panels.length,
    currentStage: project.stage,
    currentStep: flow.currentStep,
    nextStep: nextStep?.id ?? null,
    nextStepTitle: nextStep ? comicStepTitle(project, nextStep.id) : null,
  };
}

/** 本期故事总览（Step 1 Hero Card / 项目头 / Right Rail 同源，§88）。 */
export interface ComicStoryOverview {
  comicName: string;
  storyTitle: string | null;
  /** 一句话故事（3~5 秒读懂，§5.1）：summary 优先，缺省时节拍拼接。 */
  oneLiner: string;
  summary: string;
  beats: string[];
  endingTypeLabel: string | null;
  characterNames: string[];
  /** 展示形式一行文案（四宫格 · 1 页 4 格）。 */
  presentationLabel: string;
  totalPanels: number;
  pageCount: number;
}

export function getStoryOverview(project: ComicProject): ComicStoryOverview {
  const story = project.story ?? null;
  const presentation = resolveComicPresentation(
    project.skillSnapshot,
    story ? { totalPanels: story.panelCount } : {},
  );
  return {
    comicName: project.name,
    storyTitle: story?.title ?? null,
    oneLiner: story ? (story.summary || story.beats.join(' → ')) : '',
    summary: story?.summary ?? '',
    beats: story?.beats ?? [],
    endingTypeLabel: story ? (COMIC_ENDING_TYPE_LABELS[story.endingType] ?? story.endingType) : null,
    characterNames: story
      ? story.characterIds.map(id => project.characterSnapshots.find(c => c.id === id)?.name ?? id)
      : [],
    presentationLabel: comicPresentationLabel(presentation),
    totalPanels: presentation.totalPanels,
    pageCount: presentation.pageCount,
  };
}
