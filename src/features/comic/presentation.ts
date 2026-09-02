/**
 * 漫画展示形式（Presentation）领域模型（Phase 1.2）——把 skill 里散落的
 * layout / textStyle / exportDefaults 解析成用户可理解的一个整体概念：
 * 「四宫格 · 1 页 4 格」「多页连载 · 4 页 · 每页 1 张」。
 *
 * 设计决策（docs/ai-comic/06-DECISIONS.md D-101）：
 *  - Presentation 不另建持久化结构——单一事实源仍是 skill.layout + skill.textStyle +
 *    skill.exportDefaults；本模块只做解析与页面排版计算（纯函数）；
 *  - 页面排版（每页几格 / 几列）只在此处计算一次，选择卡 / Rail / 分镜草稿 /
 *    最终组页预览 / 导出合成全部复用（规格 §89：不要每个地方自己画一套）；
 *  - Presentation 确认 = Skill 确认（stage≠skill_draft），不引入第二套确认状态。
 */
import type { ComicConcept, ComicLayoutArrangement, ComicPresentationConstraint, ComicSkill } from './types';

export type ComicOutputMode = 'single_page_composite' | 'multi_page' | 'strip';

export interface ComicPresentationTemplate {
  id: ComicLayoutArrangement;
  /** 用户名称（§34 步骤术语：四宫格 / 九宫格 / 上下双格 …） */
  name: string;
  /** 一句推荐用途（选择卡说明，§8：不能只有形式名词） */
  description: string;
  /** 组页网格列数（竖排 / 多页 = 1 列） */
  columns: number;
  /** 每页格数（多页 = 1） */
  panelsPerPage: number;
  /** 选择该模板时的默认总格数 */
  defaultPanelCount: number;
  outputMode: ComicOutputMode;
  /** 对白适配方式（§8：每个模板必须说明） */
  dialogueHint: string;
}

/** 可视化选择卡的全部模板（顺序 = 选择卡展示顺序）。 */
export const COMIC_PRESENTATION_TEMPLATES: readonly ComicPresentationTemplate[] = [
  {
    id: 'grid_4',
    name: '四宫格',
    description: '2×2 一页四格，起承转合最紧凑，适合日常段子',
    columns: 2,
    panelsPerPage: 4,
    defaultPanelCount: 4,
    outputMode: 'single_page_composite',
    dialogueHint: '每格 1~2 句短气泡',
  },
  {
    id: 'grid_9',
    name: '九宫格',
    description: '3×3 一页九格，剧情更饱满，适合完整小故事',
    columns: 3,
    panelsPerPage: 9,
    defaultPanelCount: 9,
    outputMode: 'single_page_composite',
    dialogueHint: '气泡为主 + 少量旁白',
  },
  {
    id: 'vertical_2',
    name: '上下双格',
    description: '一页上下两格，铺垫与反转对比直观',
    columns: 1,
    panelsPerPage: 2,
    defaultPanelCount: 2,
    outputMode: 'single_page_composite',
    dialogueHint: '上下各一句对白',
  },
  {
    id: 'horizontal_2',
    name: '左右双格',
    description: '一页左右两格，适合前后对照',
    columns: 2,
    panelsPerPage: 2,
    defaultPanelCount: 2,
    outputMode: 'single_page_composite',
    dialogueHint: '左右各一句对白',
  },
  {
    id: 'vertical_3',
    name: '三格竖版',
    description: '竖排三格，节奏介于双格与长条之间',
    columns: 1,
    panelsPerPage: 3,
    defaultPanelCount: 3,
    outputMode: 'single_page_composite',
    dialogueHint: '旁白 + 对白交替',
  },
  {
    id: 'single',
    name: '单幅',
    description: '一张画完一个梗，配底部字幕',
    columns: 1,
    panelsPerPage: 1,
    defaultPanelCount: 1,
    outputMode: 'single_page_composite',
    dialogueHint: '底部字幕 / 旁白框',
  },
  {
    id: 'multi_page',
    name: '多页连载',
    description: '每页一张独立成图，适合聊天记录 / 连续剧情',
    columns: 1,
    panelsPerPage: 1,
    defaultPanelCount: 4,
    outputMode: 'multi_page',
    dialogueHint: '每页独立排版对白',
  },
];

export function comicPresentationTemplateOf(
  arrangement: ComicLayoutArrangement,
): ComicPresentationTemplate | undefined {
  return COMIC_PRESENTATION_TEMPLATES.find(template => template.id === arrangement);
}

// ---------------------------------------------------------------------------
// Presentation Constraint（V4.2.8 §4~§17）：新建弹窗「漫画形式」小卡选择器域。
// 只暴露底层真实支持的标准模板（custom 不是可推荐的形式）；auto = AI 自由。
// ---------------------------------------------------------------------------

/** 可作为 fixed 约束的真实模板（全部标准模板；custom 不可推荐）。 */
export const COMIC_PRESENTATION_CONSTRAINT_TEMPLATES: readonly ComicPresentationTemplate[] =
  COMIC_PRESENTATION_TEMPLATES;

/** 归一约束：mode 缺省 auto；fixed 缺模板 / 模板不存在 → 回落 auto（AI 自由）。 */
export function normalizeComicPresentationConstraint(
  value: Partial<ComicPresentationConstraint> | undefined,
): ComicPresentationConstraint {
  const mode = value?.mode === 'fixed' ? 'fixed' : 'auto';
  if (mode === 'auto') return { mode };
  const templateId = value?.templateId;
  if (!templateId || !COMIC_PRESENTATION_CONSTRAINT_TEMPLATES.some(template => template.id === templateId)) {
    return { mode: 'auto' };
  }
  return { mode: 'fixed', templateId };
}

/** fixed 约束的期望几何（Validator 与 Prompt 共用的单一事实源）。 */
export interface ComicPresentationConstraintSpec {
  template: ComicPresentationTemplate;
  /** 期望页数（multi_page = 默认 4；其余 = 1） */
  pageCount: number;
  /** 期望总格数（= 模板 defaultPanelCount） */
  totalPanels: number;
}

export function comicPresentationConstraintSpec(
  constraint: ComicPresentationConstraint,
): ComicPresentationConstraintSpec | null {
  const normalized = normalizeComicPresentationConstraint(constraint);
  if (normalized.mode !== 'fixed') return null;
  const template = comicPresentationTemplateOf(normalized.templateId!)!;
  return {
    template,
    pageCount: template.id === 'multi_page' ? template.defaultPanelCount : 1,
    totalPanels: template.defaultPanelCount,
  };
}

/** 选择器小卡的几何短说明（§5：「1 页 · 4 格」）。 */
export function comicPresentationTemplateShortLabel(template: ComicPresentationTemplate): string {
  return template.id === 'multi_page'
    ? `${template.defaultPanelCount} 页 · 每页 1 张`
    : `1 页 · ${template.panelsPerPage} 格`;
}

/** 当前选择一行文案（§9：「四宫格 · 1 页 · 4 格」/「AI 自动推荐」）。 */
export function comicPresentationConstraintLabel(constraint: ComicPresentationConstraint): string {
  const spec = comicPresentationConstraintSpec(constraint);
  if (!spec) return 'AI 自动推荐';
  const { template } = spec;
  return template.id === 'multi_page'
    ? `${template.name} · ${spec.pageCount} 页 · 每页 1 张`
    : `${template.name} · 1 页 · ${spec.totalPanels} 格`;
}

/** 当前选择动态说明（§10/§11：fixed = 三方案都保持该形式；auto = AI 分别选形式）。 */
export function comicPresentationConstraintHint(constraint: ComicPresentationConstraint): string {
  const spec = comicPresentationConstraintSpec(constraint);
  if (!spec) return 'AI 会为 3 个不同故事分别选择最适合的漫画形式。';
  const { template } = spec;
  if (template.id === 'multi_page') {
    return `AI 会推荐 3 个不同故事，三个方案都会保持${template.name}（${spec.pageCount} 页 · 每页 1 张）。`;
  }
  return `AI 会推荐 3 个不同故事，三个方案都会保持${template.name}（1 页 ${spec.totalPanels} 格）。`;
}

/** custom 排版几何：接近正方的网格（ceil(√n) 列），与导出合成 fallback 同式。 */
function customColumns(totalPanels: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, totalPanels))));
}

/** 一页的排版（panel.order 升序映射到页格位；多页模式每页 1 格）。 */
export interface ComicPagePlacement {
  /** 0 起 */
  pageIndex: number;
  columns: number;
  /** 该页包含的 panel.order 值（升序） */
  panelOrders: number[];
}

export interface ComicPresentation {
  arrangement: ComicLayoutArrangement;
  /** 命中的标准模板；custom 时为 null */
  template: ComicPresentationTemplate | null;
  /** 用户名称（custom → 自定义排版） */
  name: string;
  outputMode: ComicOutputMode;
  /** 总格数（计划值或调用方传入的实际分镜数） */
  totalPanels: number;
  panelsPerPage: number;
  pageCount: number;
  /** 组页网格列数（预览 / 合成共用） */
  columns: number;
  aspectRatio: ComicSkill['exportDefaults']['canvasRatio'];
  dialogueMode: ComicSkill['textStyle']['dialogueMode'];
  pages: ComicPagePlacement[];
}

export interface ResolveComicPresentationOptions {
  /** 覆盖总格数（默认 skill.layout.panelCount；分镜已生成时传实际格数） */
  totalPanels?: number;
}

/**
 * 从 Skill 快照解析当前 Presentation。格数与模板不一致时按模板每页容量分页
 * （如 grid_4 配 6 格 → 2 页：4 + 2），不丢格、不伪造。
 */
export function resolveComicPresentation(
  skill: ComicSkill,
  options: ResolveComicPresentationOptions = {},
): ComicPresentation {
  return buildPresentation(
    skill.layout,
    skill.exportDefaults.canvasRatio,
    skill.textStyle.dialogueMode ?? 'bubble',
    options.totalPanels,
  );
}

/**
 * 推荐方案的展示形式解析（V4.2.7）：Concept 只带 layout，画幅 / 对白方式取
 * 产品缺省（3:4 + 气泡，与用户确认 Presentation 前的默认一致）。推荐卡 /
 * 技能预览的布局示意与 Step 2 选择卡同一套几何单点计算。
 */
export function resolveConceptPresentation(
  concept: Pick<ComicConcept, 'layout'>,
): ComicPresentation {
  return buildPresentation(concept.layout, '3:4', 'bubble');
}

function buildPresentation(
  layout: ComicSkill['layout'],
  canvasRatio: ComicSkill['exportDefaults']['canvasRatio'],
  dialogueMode: ComicSkill['textStyle']['dialogueMode'],
  totalPanelsOverride?: number,
): ComicPresentation {
  const arrangement = layout.arrangement;
  const totalPanels = Math.max(1, totalPanelsOverride ?? layout.panelCount);
  const template = comicPresentationTemplateOf(arrangement) ?? null;
  const isMultiPage = arrangement === 'multi_page';
  const panelsPerPage = isMultiPage ? 1 : template?.panelsPerPage ?? totalPanels;
  const pageCount = isMultiPage
    ? Math.max(1, layout.pageCount ?? totalPanels)
    : Math.max(1, Math.ceil(totalPanels / panelsPerPage));
  const columns = template ? template.columns : customColumns(totalPanels);
  const pages: ComicPagePlacement[] = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const start = pageIndex * panelsPerPage;
    const capacity = Math.max(0, Math.min(panelsPerPage, totalPanels - start));
    pages.push({
      pageIndex,
      columns,
      panelOrders: Array.from({ length: capacity }, (_, offset) => start + offset),
    });
  }
  return {
    arrangement,
    template,
    name: template?.name ?? '自定义排版',
    outputMode: isMultiPage ? 'multi_page' : 'single_page_composite',
    totalPanels,
    panelsPerPage,
    pageCount,
    columns,
    aspectRatio: canvasRatio,
    dialogueMode,
    pages,
  };
}

/** Header / Rail / Hero Card 一行展示文案（单一来源，§13）。 */
export function comicPresentationLabel(presentation: ComicPresentation): string {
  if (presentation.outputMode === 'multi_page') {
    return `${presentation.name} · ${presentation.pageCount} 页 · 每页 ${presentation.panelsPerPage} 张 · 共 ${presentation.totalPanels} 张图`;
  }
  return `${presentation.name} · ${presentation.pageCount} 页 ${presentation.totalPanels} 格`;
}

/** 选择模板 → 需要写入 skill.layout 的补丁值（panelCount 对齐模板默认；多页带页数）。 */
export function presentationPatchFor(template: ComicPresentationTemplate): {
  panelCount: number;
  arrangement: ComicLayoutArrangement;
  pageCount?: number;
} {
  return template.id === 'multi_page'
    ? { panelCount: template.defaultPanelCount, arrangement: 'multi_page', pageCount: template.defaultPanelCount }
    : { panelCount: template.defaultPanelCount, arrangement: template.id };
}

/** 对白呈现方式用户文案（选择卡 / Facts 卡共用）。 */
export const COMIC_DIALOGUE_MODE_LABELS: Record<NonNullable<ComicSkill['textStyle']['dialogueMode']>, string> = {
  bubble: '对话气泡',
  subtitle: '底部字幕',
  narration: '旁白框',
  none: '无气泡文字',
};

/** 对白方式选择卡的一句适配说明（§12.2：不只艺术名词）。 */
export const COMIC_DIALOGUE_MODE_HINTS: Record<NonNullable<ComicSkill['textStyle']['dialogueMode']>, string> = {
  bubble: '对白装进气泡，贴近说话角色',
  subtitle: '对白排在每格底部，像字幕一样整齐',
  narration: '旁白框交代剧情，对白留给角色',
  none: '画面自带留白，文字后期自由排版',
};

/**
 * 视觉风格预设（§12.1 可选卡）：label 给用户，promptText 写入 skill.visualStyle
 * （提示词级描述，保证编译进 Prompt 的信息量不因选卡而缩水）。
 */
export interface ComicVisualStylePreset {
  id: string;
  label: string;
  /** 一句说明（选择卡） */
  description: string;
  /** 写入 visualStyle 的提示词级值 */
  promptText: string;
}

export const COMIC_VISUAL_STYLE_PRESETS: readonly ComicVisualStylePreset[] = [
  {
    id: 'cute-sketch',
    label: '萌系简笔',
    description: '圆润粗线，大眼睛，干净留白',
    promptText: '萌系简笔：圆润粗线条，角色大眼睛低细节，干净留白，低饱和暖色',
  },
  {
    id: 'hand-drawn',
    label: '手绘线稿',
    description: '铅笔手感，线条有轻重',
    promptText: '手绘线稿：铅笔质感线条，笔触有轻重变化，少量排线阴影，纸面留白',
  },
  {
    id: 'japanese-fresh',
    label: '日系清新',
    description: '细线淡彩，柔和干净',
    promptText: '日系清新：细线勾边，柔和淡彩，浅色渐变背景，画面通透干净',
  },
  {
    id: 'muted-illustration',
    label: '低饱和插画',
    description: '莫兰迪配色，安静耐看',
    promptText: '低饱和插画：莫兰迪灰调配色，扁平色块为主，安静耐看的杂志插画感',
  },
  {
    id: 'retro-print',
    label: '复古印刷',
    description: '网点颗粒，旧海报味',
    promptText: '复古印刷：半调网点肌理，有限套色，老海报式构图与描边',
  },
];
