/**
 * AI 漫画任务构建（Phase 8/9，纯函数层）——项目状态 → CreateTaskParams。
 *
 * 铁律（docs/ai-comic/02-COMIC-DESIGN.md D-006）：
 *  - 复用现有批量引擎（execution_mode='batch' + batch_items 逐槽执行/失败隔离/按槽重试），
 *    绝不改 task_runner，绝不另起第二套生成队列；
 *  - Anchor = 单张任务（batch-of-1）→ 终态后用户审定 → lockAnchor 冻结一致性档案；
 *  - 剩余 Panel = 一个批量任务，每槽 source_images 首位恒为 Anchor 图（风格锚）；
 *  - 单格重绘 = batch-of-1，继承 Anchor 档案（panel_regen）。
 *
 * 每格 Prompt 由 compilePanelPrompt 确定性编译后冻结两处：
 *  panel.compiledPrompt（项目内溯源） + execution_snapshot.items[]（任务侧真相）。
 */

import type { CreateTaskParams, TaskBatchItem } from '../../types';
import { buildBatchExecutionSnapshot, composeEffectivePrompt } from '../promptExecution/executionSnapshot';
import type { ComicCharacter, ComicExecutionMarker, ComicPanel, ComicProject, CompiledPanelPrompt } from './types';
import { compileBakeTextPrompt, compileCharacterReferencePrompt, compilePanelPrompt } from './promptCompiler';
import type { ComicCompileMode } from './promptCompiler';
import { comicPanelSeriesReadiness } from './domain';

/** 漫画任务统一来源标记（Task/History 侧按此识别漫画链路）。 */
export const COMIC_TASK_SOURCE = 'comic' as const;

export interface ComicTaskBuildContext {
  outputDir: string;
  /** 覆盖生成参数（缺省回落 consistency.generationParams → 引擎默认）。 */
  size?: string;
  quality?: string;
  outputFormat?: string;
}

interface ResolvedGenerationParams {
  size: string;
  quality: string;
  format: string;
}

function resolveGenerationParams(project: ComicProject, ctx: ComicTaskBuildContext): ResolvedGenerationParams {
  const frozen = project.consistency?.generationParams;
  return {
    size: ctx.size || frozen?.size || '1024x1024',
    quality: ctx.quality || frozen?.quality || 'auto',
    format: ctx.outputFormat || frozen?.format || 'png',
  };
}

function comicMarker(
  project: ComicProject,
  kind: ComicExecutionMarker['kind'],
  panelId?: string,
  extra: { characterId?: string; characterName?: string } = {},
): ComicExecutionMarker {
  return {
    projectId: project.id,
    projectName: project.name,
    kind,
    ...(panelId ? { panelId } : {}),
    ...(extra.characterId ? { characterId: extra.characterId } : {}),
    ...(extra.characterName ? { characterName: extra.characterName } : {}),
    ...(project.skillSnapshot.name ? { skillName: project.skillSnapshot.name } : {}),
    ...(project.story?.title ? { storyTitle: project.story.title } : {}),
  };
}

function storyRequirement(project: ComicProject): string {
  const story = project.story;
  const skill = project.skillSnapshot;
  if (!story) return `AI 漫画 · ${skill.name}`;
  return `AI 漫画 · ${skill.name} ·《${story.title}》${story.summary ? `：${story.summary}` : ''}`;
}

function panelLabel(panel: ComicPanel): string {
  return `第 ${panel.order + 1} 格`;
}

/** 参考图并集（任务级快照展示用；每槽真实以 items[i].source_images 为准），按 path 去重保序。 */
function unionReferences(compiledList: CompiledPanelPrompt[]): { path: string; label?: string; role?: string }[] {
  const seen = new Set<string>();
  const result: { path: string; label?: string; role?: string }[] = [];
  for (const compiled of compiledList) {
    for (const reference of compiled.references) {
      if (seen.has(reference.path)) continue;
      seen.add(reference.path);
      result.push({
        path: reference.path,
        ...(reference.label ? { label: reference.label } : {}),
        ...(reference.role ? { role: reference.role } : {}),
      });
    }
  }
  return result;
}

/** 通用任务槽（panel / character_ref 共用；id = 溯源键）。 */
interface ComicSlotDraft {
  id: string;
  label: string;
  compiled: CompiledPanelPrompt;
  batchItem: TaskBatchItem;
}

interface PanelSlotDraft extends ComicSlotDraft {
  panel: ComicPanel;
}

function compilePanelSlot(project: ComicProject, panel: ComicPanel, mode: ComicCompileMode): PanelSlotDraft {
  const compiled = compilePanelPrompt({ project, panel, mode });
  const sourcePaths = compiled.references.map(reference => reference.path);
  return {
    id: panel.id,
    label: panelLabel(panel),
    panel,
    compiled,
    batchItem: {
      id: panel.id,
      label: panelLabel(panel),
      prompt_delta: '',
      prompt_override: compiled.positive,
      negative_override: compiled.negative,
      ...(sourcePaths.length > 0 ? { source_images: sourcePaths } : {}),
      enabled: true,
      variables: { panelId: panel.id },
    },
  };
}

function buildComicTaskParams(
  project: ComicProject,
  slots: ComicSlotDraft[],
  marker: ComicExecutionMarker,
  ctx: ComicTaskBuildContext,
): CreateTaskParams {
  if (slots.length === 0) throw new Error('漫画任务至少需要一个生成槽');
  const generation = resolveGenerationParams(project, ctx);
  // 图生图路由硬边界：task_type='edit' 要求每一槽都有源图（Rust edit 空源图本地快速失败）
  const allSlotsHaveSources = slots.every(slot => (slot.batchItem.source_images?.length ?? 0) > 0);
  const taskType: CreateTaskParams['task_type'] = allSlotsHaveSources ? 'edit' : 'generate';
  const first = slots[0]!;

  const executionSnapshot = buildBatchExecutionSnapshot({
    userRequirement: storyRequirement(project),
    positivePrompt: first.compiled.positive,
    negativePrompt: first.compiled.negative,
    promptSource: 'comic-compiled',
    items: slots.map(slot => ({
      label: slot.batchItem.label ?? slot.id,
      positivePrompt: slot.compiled.positive,
      negativePrompt: slot.compiled.negative,
      variables: slot.batchItem.variables ?? {},
    })),
    referenceImages: unionReferences(slots.map(slot => slot.compiled)),
    generationParams: {
      size: generation.size,
      quality: generation.quality,
      format: generation.format,
    },
    comic: marker,
  });

  const kindLabel = marker.kind === 'anchor'
    ? '首格锚点'
    : marker.kind === 'panels'
      ? `系列分镜（${slots.length} 格）`
      : marker.kind === 'character_ref'
        ? `角色「${marker.characterName ?? '未命名'}」参考图`
        : marker.kind === 'bake_text'
          ? `第 ${(project.panels.find(panel => panel.id === marker.panelId)?.order ?? 0) + 1} 格烘焙文字`
          : `第 ${(project.panels.find(panel => panel.id === marker.panelId)?.order ?? 0) + 1} 格重绘`;

  return {
    prompt: first.compiled.positive,
    negative_prompt: first.compiled.negative,
    user_prompt_raw: storyRequirement(project),
    final_prompt: first.compiled.positive,
    final_negative_prompt: first.compiled.negative,
    prompt_optimized: false,
    prompt_optimization: { applied: false },
    execution_snapshot: executionSnapshot,
    size: generation.size,
    quality: generation.quality,
    output_format: generation.format,
    count: slots.length,
    output_dir: ctx.outputDir,
    task_type: taskType,
    source_images: taskType === 'edit' ? first.batchItem.source_images ?? [] : [],
    execution_mode: 'batch',
    batch_strategy: 'variant_set',
    batch_items: slots.map(slot => slot.batchItem),
    task_source: COMIC_TASK_SOURCE,
    task_plan_summary: `AI 漫画 · ${project.skillSnapshot.name}${project.story?.title ? ` ·《${project.story.title}》` : ''} · ${kindLabel}`,
  };
}

/** 编译产物 → panel.compiledPrompt 冻结值（正负组合 = 实际执行预览）。 */
export function freezeCompiledPrompt(compiled: CompiledPanelPrompt): string {
  return composeEffectivePrompt(compiled.positive, compiled.negative);
}

// ---------------------------------------------------------------------------
// Anchor 任务（Phase 8）
// ---------------------------------------------------------------------------

export interface AnchorTaskBuildResult {
  params: CreateTaskParams;
  /** 锚点格 id（= params.batch_items[0].id）。 */
  panelId: string;
  /** 编译产物（调用方冻结进 panel.compiledPrompt）。 */
  compiled: CompiledPanelPrompt;
}

/** 活动分镜（排除 stale 副本，按 order 排序）。 */
export function activePanels(project: ComicProject): ComicPanel[] {
  return project.panels
    .filter(panel => !panel.stale)
    .sort((a, b) => a.order - b.order);
}

/** 首格锚点任务：batch-of-1，mode='anchor'（不带 anchor 参考——它自己就是锚）。 */
export function buildAnchorTask(project: ComicProject, ctx: ComicTaskBuildContext): AnchorTaskBuildResult {
  const panels = activePanels(project);
  if (panels.length === 0) throw new Error('缺少分镜：先完成故事与分镜再生成锚点');
  const target = panels[0]!;
  const slot = compilePanelSlot(project, target, 'anchor');
  const params = buildComicTaskParams(project, [slot], comicMarker(project, 'anchor', target.id), ctx);
  return { params, panelId: target.id, compiled: slot.compiled };
}

// ---------------------------------------------------------------------------
// 系列 Panel 任务（Phase 9）
// ---------------------------------------------------------------------------

export interface PanelsTaskBuildResult {
  params: CreateTaskParams;
  /** 与 params.batch_items 逐槽对齐的 panelId 顺序。 */
  panelIds: string[];
  /** panelId → 编译产物（调用方冻结进对应 panel.compiledPrompt）。 */
  compiledByPanelId: Record<string, CompiledPanelPrompt>;
}

/**
 * 剩余 Panel 批量任务：一个批量 Task 覆盖全部活动分镜（含锚点格重出——
 * 已锁定的锚点图不重生成：锚点格从 slots 中剔除，其余格 source_images 首位 = 锚点图）。
 * 门禁（验收 J）：角色确认 + 分镜存在 + Anchor 已锁定（skipAnchor 仅显式 fallback 放行）。
 */
export function buildPanelSeriesTask(
  project: ComicProject,
  ctx: ComicTaskBuildContext,
  options: { skipAnchor?: boolean } = {},
): PanelsTaskBuildResult {
  const readiness = comicPanelSeriesReadiness(project, options);
  if (!readiness.ready) {
    throw new Error(`系列分镜未就绪：${readiness.blockers.join('；')}`);
  }
  const panels = activePanels(project);
  const anchorPanelId = project.consistency?.anchor?.panelId;
  // 锚点格已定稿（imageAsset + 未 stale）→ 跳过重出，剩余格进批量
  const targets = panels.filter(panel => !(anchorPanelId && panel.id === anchorPanelId && panel.imageAsset));
  if (targets.length === 0) throw new Error('全部分镜已定稿，无需系列生成');

  const slots = targets.map(panel => compilePanelSlot(project, panel, 'series'));
  const params = buildComicTaskParams(project, slots, comicMarker(project, 'panels'), ctx);
  return {
    params,
    panelIds: slots.map(slot => slot.panel.id),
    compiledByPanelId: Object.fromEntries(slots.map(slot => [slot.panel.id, slot.compiled])),
  };
}

// ---------------------------------------------------------------------------
// 单格重绘（Phase 9）
// ---------------------------------------------------------------------------

export interface PanelRegenTaskBuildResult {
  params: CreateTaskParams;
  panelId: string;
  compiled: CompiledPanelPrompt;
}

/**
 * 单格重绘：batch-of-1，mode='panel_regen'。
 * V4.2.11 §F：默认流程（未开启「生成第一格后暂停确认」）没有锚点档案——
 * 一致性由角色参考图 + 风格约束承担；高级暂停模式锁定的锚点仍优先继承
 * （compilePanelPrompt mode='panel_regen' 自动把锚点图放参考首位）。
 */
export function buildPanelRegenTask(
  project: ComicProject,
  panelId: string,
  ctx: ComicTaskBuildContext,
): PanelRegenTaskBuildResult {
  const panel = project.panels.find(item => item.id === panelId && !item.stale);
  if (!panel) throw new Error(`分镜不存在或已过期：${panelId}`);
  const slot = compilePanelSlot(project, panel, 'panel_regen');
  const params = buildComicTaskParams(project, [slot], comicMarker(project, 'panel_regen', panel.id), ctx);
  return { params, panelId: panel.id, compiled: slot.compiled };
}

// ---------------------------------------------------------------------------
// 角色参考图任务（Phase 1.1 §六/§七）：batch-of-1 文生图，走既有 createSeriesTask 链路
// ---------------------------------------------------------------------------

export interface CharacterReferenceTaskBuildResult {
  params: CreateTaskParams;
  characterId: string;
  /** 编译产物（冻结进任务 execution_snapshot，Prompt 溯源）。 */
  compiled: CompiledPanelPrompt;
}

/**
 * 角色定妆参考图任务：compileCharacterReferencePrompt 编译（SkillSnapshot + Brief +
 * immutableTraits + negativeConstraints + noText 铁律 + 单角色视觉建议），batch-of-1、
 * 无源图 → task_type='generate'；提交入口与其他漫画任务一致 = useTaskStore.createSeriesTask
 * （报价确认 / 两段授权 / TaskQueue / settle / Gallery / History 全继承，零平行系统）。
 */
export function buildCharacterReferenceTask(
  project: ComicProject,
  character: ComicCharacter,
  ctx: ComicTaskBuildContext,
): CharacterReferenceTaskBuildResult {
  if (!project.characterSnapshots.some(item => item.id === character.id)) {
    throw new Error('角色不在本项目内，请先在角色步骤绑定槽位');
  }
  const compiled = compileCharacterReferencePrompt({ project, character });
  const id = `charref-${character.id}`;
  const slot: ComicSlotDraft = {
    id,
    label: `角色「${character.name}」参考图`,
    compiled,
    batchItem: {
      id,
      label: `角色「${character.name}」`,
      prompt_delta: '',
      prompt_override: compiled.positive,
      negative_override: compiled.negative,
      enabled: true,
      variables: { characterId: character.id },
    },
  };
  const marker = comicMarker(project, 'character_ref', undefined, {
    characterId: character.id,
    characterName: character.name,
  });
  const params = buildComicTaskParams(project, [slot], marker, ctx);
  return { params, characterId: character.id, compiled };
}

// ---------------------------------------------------------------------------
// 文字烘焙任务（V4.2.14 §63~§66，实验 · 默认关闭）：成图 + 文字层 → 派生整格
// ---------------------------------------------------------------------------

export interface BakeTextTaskBuildResult {
  params: CreateTaskParams;
  panelId: string;
  /** 报价事实（调用方在确认弹窗展示；提交前用户必须显式确认计费）。 */
  quote: {
    taskType: 'edit';
    slots: number;
    imageCount: number;
    dialogueCount: number;
  };
  compiled: CompiledPanelPrompt;
}

/**
 * 烘焙文字进图片：batch-of-1 图生图（源图 = 本格成图），Prompt 由
 * compileBakeTextPrompt 确定性编译（文字逐字传入、位置与 WYSIWYG 同源）。
 * 门禁：本格必须已成图且至少有一条可见对白——不满足直接 throw（UI 先行禁用）。
 * 结果只写 panel.bakedTextAsset（派生资产），永不覆盖 imageAsset（generation.ts）。
 */
export function buildBakeTextTask(
  project: ComicProject,
  panelId: string,
  ctx: ComicTaskBuildContext,
): BakeTextTaskBuildResult {
  const panel = project.panels.find(item => item.id === panelId && !item.stale);
  if (!panel) throw new Error(`分镜不存在或已过期：${panelId}`);
  if (!panel.imageAsset) throw new Error('本格还没有成图，无法烘焙文字');
  const dialogues = project.dialogues.filter(
    item => item.panelId === panel.id && item.text.trim().length > 0,
  );
  if (dialogues.length === 0) throw new Error('本格没有可烘焙的文字（对白为空）');

  const compiled = compileBakeTextPrompt({ project, panel, dialogues });
  const id = `bake-${panel.id}`;
  const label = `第 ${panel.order + 1} 格 · 烘焙文字（${dialogues.length} 条）`;
  const slot: ComicSlotDraft = {
    id,
    label,
    compiled,
    batchItem: {
      id,
      label,
      prompt_delta: '',
      prompt_override: compiled.positive,
      negative_override: compiled.negative,
      source_images: [panel.imageAsset.path],
      enabled: true,
      variables: { panelId: panel.id },
    },
  };
  const params = buildComicTaskParams(project, [slot], comicMarker(project, 'bake_text', panel.id), ctx);
  return {
    params,
    panelId: panel.id,
    quote: { taskType: 'edit', slots: 1, imageCount: 1, dialogueCount: dialogues.length },
    compiled,
  };
}
