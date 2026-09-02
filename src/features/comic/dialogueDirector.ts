/**
 * AI 漫画对白导演编排层（V4.2.14 docs/ai-comic/27 §H/§I）。
 *
 * 两种能力，一律「建议 → 用户确认 → apply」两段式（建议永不静默改项目）：
 *  - Planner（§31~§37）：directComicDialogues 的 proposals → 对白草稿 → apply。
 *    只写文字 / 说话人 / 类型 / 样式建议；fill 模式只补「没有可见对白」的格，
 *    已有内容永不覆写（覆盖必须整页重排 + UI 二次确认，overwrite 显式传入）。
 *  - Vision（§45~§52）：视觉理解建议摆放位置。视觉模型只做「看图」——识别主体
 *    归一化区域（VisionSubject.position），摆放由本地确定性求解器计算：
 *    候选锚点 × 主体区域重叠代价 + 阅读顺序。绝不让视觉模型直接输出坐标
 *    （Rust vision_analyze_image 是固定 schema，也正因如此不依赖模型输出几何）。
 *    Vision 只建议几何（x/y/宽/尾巴），绝不改文字与样式；没有成图的格回落
 *    安全默认布局（basis='default'）。
 *
 * 视觉模型不可用 → makeVisionDirector 返回错误（UI 标注 REAL_VISION_BLOCKED），
 * 绝不 Mock 冒充真实分析。
 */

import { api } from '../../services/api';
import type { VisionAnalysis, VisionAnalyzeResult } from '../../types';
import { recordAiRoleUsage, resolveModelForRole } from '../aiRouting/resolveModelForRole';
import type { ComicDialogueProposal } from '../../services/comicPlanner';
import { comicBubbleStyleMeta, isFramelessStyle, styleHasTail } from './bubbleShape';
import { activePanels } from './comicTask';
import type { ComicDialogue, ComicPanel, ComicProject } from './types';
import {
  clampDialoguePosition,
  clampDialogueSize,
  newDialogueDraft,
  visibleDialoguesOfPanel,
} from './textLayer';

// ---------------------------------------------------------------------------
// Planner：proposal → 草稿 → apply
// ---------------------------------------------------------------------------

/** Planner proposal → 可应用对白草稿（坐标落安全泳道，placementSource='planner'）。 */
export function dialogueDraftFromProposal(
  project: ComicProject,
  panel: ComicPanel,
  proposal: ComicDialogueProposal,
  seedIndex: number,
): ComicDialogue {
  const draft = newDialogueDraft(project, panel.id, seedIndex);
  return {
    ...draft,
    speakerId: proposal.speakerId,
    type: proposal.type,
    text: proposal.text,
    bubbleStyle: proposal.suggestedStyle,
    placementSource: 'planner',
  };
}

export interface DialogueApplySummary {
  added: number;
  /** 因已有可见对白而被跳过的格（fill 模式保护）。 */
  skippedPanels: string[];
  /** overwrite=true 时被整体替换的格。 */
  replacedPanels: string[];
}

/**
 * 应用 Planner 草稿（纯函数）。默认 fill 语义：已有可见对白的格整格跳过
 * （「AI 生成对白不能覆写用户内容」铁律）；overwrite=true 才整格替换
 * （UI 必须先二次确认才允许传 true）。
 */
export function applyDialogueDrafts(
  project: ComicProject,
  drafts: ComicDialogue[],
  options: { overwrite?: boolean } = {},
): { project: ComicProject; summary: DialogueApplySummary } {
  const byPanel = new Map<string, ComicDialogue[]>();
  for (const draft of drafts) {
    const list = byPanel.get(draft.panelId) ?? [];
    list.push(draft);
    byPanel.set(draft.panelId, list);
  }
  const summary: DialogueApplySummary = { added: 0, skippedPanels: [], replacedPanels: [] };
  if (byPanel.size === 0) return { project, summary };

  let dialogues = project.dialogues;
  for (const [panelId, panelDrafts] of byPanel) {
    const existing = visibleDialoguesOfPanel(project, panelId);
    if (existing.length > 0 && !options.overwrite) {
      summary.skippedPanels.push(panelId);
      continue;
    }
    if (existing.length > 0) {
      summary.replacedPanels.push(panelId);
      dialogues = dialogues.filter(item => item.panelId !== panelId);
    }
    dialogues = [...dialogues, ...panelDrafts];
    summary.added += panelDrafts.length;
  }
  if (summary.added === 0) return { project, summary };
  return { project: { ...project, dialogues, updatedAt: new Date().toISOString() }, summary };
}

// ---------------------------------------------------------------------------
// Vision：视觉分析适配器（真实调用 vision_analysis 角色，无 Mock）
// ---------------------------------------------------------------------------

export type VisionAnalyzeFn = (imagePath: string) => Promise<VisionAnalyzeResult>;

export interface VisionDirectorModel {
  providerName: string;
  modelName: string;
}

/**
 * 解析视觉理解模型并返回分析函数（每格一图，mode='quick'）。
 * extra_instructions 只强调主体位置——摆放计算在本地求解器，不依赖模型输出几何。
 */
export function makeVisionDirector():
  | { ok: true; analyze: VisionAnalyzeFn; model: VisionDirectorModel }
  | { ok: false; error: string } {
  const resolution = resolveModelForRole('vision_analysis');
  if (!resolution.ok || !resolution.connection) {
    return { ok: false, error: resolution.ok ? '视觉理解模型没有可用连接。' : resolution.error };
  }
  const connection = resolution.connection;
  recordAiRoleUsage(resolution.resolved);
  return {
    ok: true,
    analyze: (imagePath: string) => api.visionAnalyzeImage({
      imagePath,
      baseUrl: connection.baseUrl,
      token: connection.token,
      model: connection.model,
      mode: 'quick',
      extraInstructions:
        '重点输出画面主体（人物/动物）及其 position（x/y/width/height 为 0~1 归一化画面区域），'
        + '用于漫画对白气泡的避让排版；主体不明确时 position 留空，不要臆测。',
    }),
    model: { providerName: resolution.resolved.providerName, modelName: resolution.resolved.displayName },
  };
}

// ---------------------------------------------------------------------------
// Vision：本地确定性摆放求解器（纯函数，测试主力）
// ---------------------------------------------------------------------------

export interface VisionPlacementSuggestion {
  dialogueId: string;
  panelId: string;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  /** 尾巴朝向建议（仅带尾巴样式有意义）。 */
  tail?: ComicDialogue['tail'];
  /** vision = 基于真实成图主体避让；default = 安全默认泳道（无成图 / 分析失败）。 */
  basis: 'vision' | 'default';
}

export interface VisionPlacementPanelOutcome {
  panelId: string;
  order: number;
  /** 是否真实做了视觉分析（false = 回落安全默认布局）。 */
  analyzed: boolean;
  analysisError?: string;
  suggestions: VisionPlacementSuggestion[];
}

interface UnitRect { x: number; y: number; width: number; height: number }

/** 候选锚点（阅读顺序：上→下、左→右；上排优先 = 漫画对白惯例）。 */
const CANDIDATE_ANCHORS: Array<{ x: number; y: number }> = [
  { x: 0.26, y: 0.18 }, { x: 0.5, y: 0.18 }, { x: 0.74, y: 0.18 },
  { x: 0.26, y: 0.52 }, { x: 0.5, y: 0.52 }, { x: 0.74, y: 0.52 },
  { x: 0.26, y: 0.84 }, { x: 0.5, y: 0.84 }, { x: 0.74, y: 0.84 },
];

/** 条形样式（标题条/字幕条）固定泳道，不参与候选搜索。 */
function fixedBarAnchor(style: ComicDialogue['bubbleStyle']): { x: number; y: number } | null {
  if (style === 'title-bar') return { x: 0.5, y: 0.12 };
  if (style === 'subtitle-bar') return { x: 0.5, y: 0.88 };
  return null;
}

/** 求解期估算盒（与渲染无关，只用于重叠代价；实际盒由共享布局引擎算）。 */
function estimateBox(dialogue: ComicDialogue): UnitRect {
  const width = dialogue.size?.width ?? (isFramelessStyle(dialogue.bubbleStyle) ? 0.32 : 0.44);
  const height = dialogue.size?.height
    ?? (dialogue.bubbleStyle === 'subtitle-bar' ? 0.12 : dialogue.bubbleStyle === 'title-bar' ? 0.14 : 0.24);
  return { x: dialogue.position.x, y: dialogue.position.y, width, height };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** 视觉分析里的主体区域（归一化夹取，剔除无效面）。 */
function subjectRegionsOf(analysis: VisionAnalysis | null): UnitRect[] {
  if (!analysis) return [];
  const regions: UnitRect[] = [];
  for (const subject of analysis.subjects ?? []) {
    const position = subject.position;
    if (!position) continue;
    const width = Number(position.width);
    const height = Number(position.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue;
    regions.push({ x: clamp01(Number(position.x)), y: clamp01(Number(position.y)), width: clamp01(width), height: clamp01(height) });
  }
  return regions;
}

/** 两个中心锚点盒的交集面积（归一化单位；不重叠 = 0）。 */
function intersectionArea(a: UnitRect, b: UnitRect): number {
  const overlapWidth = Math.min(a.x + a.width / 2, b.x + b.width / 2) - Math.max(a.x - a.width / 2, b.x - b.width / 2);
  const overlapHeight = Math.min(a.y + a.height / 2, b.y + b.height / 2) - Math.max(a.y - a.height / 2, b.y - b.height / 2);
  return overlapWidth > 0 && overlapHeight > 0 ? overlapWidth * overlapHeight : 0;
}

/** 尾巴朝向建议：指向最近主体（主体在下方 → bottom 尾，左侧 → left）。 */
function tailHintFor(box: UnitRect, subjects: UnitRect[]): ComicDialogue['tail'] | undefined {
  if (subjects.length === 0) return undefined;
  let nearest = subjects[0]!;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const subject of subjects) {
    const dx = (subject.x - box.x) as number;
    const dy = (subject.y - box.y) as number;
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) { nearestDistance = distance; nearest = subject; }
  }
  const vertical = nearest.y > box.y + 0.08 ? 'bottom' : nearest.y < box.y - 0.08 ? 'top' : null;
  const horizontal = nearest.x < box.x - 0.05 ? 'left' : 'right';
  if (!vertical) return horizontal === 'left' ? 'top-left' : 'top-right'; // 同高：指向上侧（头顶方向）
  return vertical === 'bottom' ? (horizontal === 'left' ? 'bottom-left' : 'bottom-right') : (horizontal === 'left' ? 'top-left' : 'top-right');
}

/**
 * 本地确定性摆放求解：analysis 为主体区域事实来源（null = 安全默认布局）。
 * 逐条对白（阅读顺序）在候选锚点里选「与主体重叠代价最小 + 未被占用」的落点；
 * 条形样式走固定泳道；位置/尺寸出求解器前统一钳制（与手工拖拽同一道闸）。
 */
export function solveVisionPlacement(
  analysis: VisionAnalysis | null,
  dialogues: ComicDialogue[],
): VisionPlacementSuggestion[] {
  const subjects = subjectRegionsOf(analysis);
  const basis: VisionPlacementSuggestion['basis'] = subjects.length > 0 ? 'vision' : 'default';
  const usedAnchors: Array<{ x: number; y: number }> = [];
  const suggestions: VisionPlacementSuggestion[] = [];

  for (const dialogue of dialogues) {
    const meta = comicBubbleStyleMeta(dialogue.bubbleStyle);
    const bar = fixedBarAnchor(dialogue.bubbleStyle);
    if (bar) {
      // 条形样式：固定泳道 + 建议宽度（条形应通栏），无尾巴
      suggestions.push({
        dialogueId: dialogue.id,
        panelId: dialogue.panelId,
        position: clampDialoguePosition(bar),
        size: clampDialogueSize({ width: 0.9, height: meta.id === 'subtitle-bar' ? 0.12 : 0.14 }),
        basis: 'default',
      });
      continue;
    }

    const estimate = estimateBox(dialogue);
    let best: { anchor: { x: number; y: number }; cost: number } | null = null;
    for (const anchor of CANDIDATE_ANCHORS) {
      const candidateBox: UnitRect = { x: anchor.x, y: anchor.y, width: estimate.width, height: estimate.height };
      let cost = 0;
      for (const subject of subjects) cost += intersectionArea(candidateBox, subject);
      if (usedAnchors.some(used => used.x === anchor.x && used.y === anchor.y)) cost += 1; // 同格多气泡不叠放
      cost += CANDIDATE_ANCHORS.indexOf(anchor) * 0.001; // 稳定平手裁决（阅读顺序优先）
      if (!best || cost < best.cost) best = { anchor, cost };
    }
    const anchor = best!.anchor;
    usedAnchors.push(anchor);

    const finalBox: UnitRect = { x: anchor.x, y: anchor.y, width: estimate.width, height: estimate.height };
    const tail = styleHasTail(dialogue.bubbleStyle) ? tailHintFor(finalBox, subjects) : undefined;
    suggestions.push({
      dialogueId: dialogue.id,
      panelId: dialogue.panelId,
      position: clampDialoguePosition(anchor),
      ...(dialogue.size ? {} : { size: clampDialogueSize({ width: estimate.width, height: estimate.height }) }),
      ...(tail ? { tail } : {}),
      basis,
    });
  }
  return suggestions;
}

/**
 * 逐格视觉摆放建议（只建议，绝不 apply）：成图格做真实视觉分析；无成图 / 单格
 * 分析失败回落安全默认布局（analysisError 记录原因，不中断整批）。
 */
export async function proposeComicDialoguePlacement(input: {
  project: ComicProject;
  analyze: VisionAnalyzeFn;
}): Promise<{ ok: true; panels: VisionPlacementPanelOutcome[] }> {
  const panels = activePanels(input.project);
  const outcomes: VisionPlacementPanelOutcome[] = [];
  for (const panel of panels) {
    const dialogues = visibleDialoguesOfPanel(input.project, panel.id);
    if (dialogues.length === 0) continue;
    let analyzed = false;
    let analysisError: string | undefined;
    let analysis: VisionAnalysis | null = null;
    if (panel.imageAsset) {
      try {
        const result = await input.analyze(panel.imageAsset.path);
        if (result.ok && result.analysis) {
          analysis = result.analysis;
          analyzed = true;
        } else {
          analysisError = result.error_message?.trim() || '视觉分析未返回有效结果';
        }
      } catch (error) {
        analysisError = error instanceof Error ? error.message : '视觉分析调用失败';
      }
    }
    outcomes.push({
      panelId: panel.id,
      order: panel.order,
      analyzed,
      ...(analysisError ? { analysisError } : {}),
      suggestions: solveVisionPlacement(analysis, dialogues),
    });
  }
  return { ok: true, panels: outcomes };
}

/** 应用视觉摆放建议（用户确认后调用；只改几何 / placementSource，绝不改文字与样式）。 */
export function applyVisionPlacement(
  project: ComicProject,
  suggestions: VisionPlacementSuggestion[],
  options: { applySize?: boolean; applyTail?: boolean } = {},
): ComicProject {
  const byId = new Map(suggestions.map(suggestion => [suggestion.dialogueId, suggestion]));
  let mutated = false;
  const dialogues = project.dialogues.map((dialogue): ComicDialogue => {
    const suggestion = byId.get(dialogue.id);
    if (!suggestion) return dialogue;
    mutated = true;
    const next: ComicDialogue = {
      ...dialogue,
      position: clampDialoguePosition(suggestion.position),
      // Story Lock：manual 来源不降级——视觉摆放只挪位置，人工放置/编辑的
      // 出身标记保留（manual 优先级最高，重出分镜按格序保留依赖此标记）。
      placementSource: dialogue.placementSource === 'manual' ? 'manual' : 'vision',
    };
    if (options.applySize !== false && suggestion.size) next.size = clampDialogueSize(suggestion.size);
    if (options.applyTail !== false && suggestion.tail && styleHasTail(dialogue.bubbleStyle)) {
      next.tail = suggestion.tail;
    }
    return next;
  });
  if (!mutated) return project;
  return { ...project, dialogues, updatedAt: new Date().toISOString() };
}
