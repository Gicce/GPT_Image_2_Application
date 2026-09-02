/**
 * 漫画整页合成（Phase 11；Phase 1.2 §47/§48 升级为 Presentation 驱动多页）——
 * 无字底图 + 文字层在合成时刻绘制：
 *  - computePageLayouts：布局纯函数（resolveComicPresentation.pages × canvasRatio
 *    → 每页槽位矩形；四格 2×2 / 九格 3×3 / 竖排单列 / 多页每页一张，与选择卡 /
 *    Rail / 分镜预览同源 §89，不再自带一套 arrangementGrid）；
 *  - renderComicSheets：DOM canvas 逐页绘制（底图 fit-safe 入槽 + 气泡文字；
 *    缺图画占位框）；renderComicSheet = 首页（兼容旧调用）；
 *  - exportComicSheetPng：读全图 → 逐页合成 → save_image_as（多页逐张保存）。
 *
 * 文字层坐标与 UI overlay 同源（归一化 0..1），导出与预览同构；
 * 对白修改只影响本模块重绘，结构上与生成链路零交集；
 * 全程客户端 canvas（§48：不重新调用 Image2）。
 */

import { api } from '../../services/api';
import type { ComicDialogue, ComicFinalPageAsset, ComicPanel, ComicProject } from './types';
import { resolveComicPresentation } from './presentation';
import { visibleDialoguesOfPanel } from './textLayer';
import { comicPanelsByOrder } from './domain';
import {
  BUBBLE_CANVAS,
  BUBBLE_DASH_PATTERN,
  BUBBLE_STROKE_WIDTH_RATIO,
  BUBBLE_SURFACE_COLORS,
  DIALOGUE_SOFT_SHADOW,
  bubbleGeometry,
  dialogueEffectiveWeight,
  dialogueFontStack,
  dialogueTextPaint,
} from './bubbleShape';
import {
  DEFAULT_FONT_METRICS,
  calculateDialogueLayout,
  dialogueBaseline,
  dialogueLineAnchorX,
  type MeasureFontMetrics,
  type MeasureText,
} from './dialogueLayout';

export interface ComicSheetSlot {
  panelId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComicSheetLayout {
  width: number;
  height: number;
  gap: number;
  background: string;
  slots: ComicSheetSlot[];
}

const SHEET_BASE_WIDTH = 1080;
const SHEET_GAP = 24;

function ratioValue(ratio: string): number {
  if (ratio === '1:1') return 1;
  if (ratio === '9:16') return 9 / 16;
  return 3 / 4;
}

/**
 * 布局纯函数（§47/§89）：活动分镜（order 序）按 Presentation 分页 → 每页画布 + 槽位矩形。
 * 四格 2×2 一页；九格 3×3 一页；上下/三格单列；多页连载每页一张整图。
 * 像素只存在于导出 / 合成边界。
 */
export function computePageLayouts(project: ComicProject): ComicSheetLayout[] {
  const skill = project.skillSnapshot;
  const panels = comicPanelsByOrder(project);
  if (panels.length === 0) return [];
  const presentation = resolveComicPresentation(skill, { totalPanels: panels.length });
  const ratio = ratioValue(skill.exportDefaults.canvasRatio);
  const width = SHEET_BASE_WIDTH;
  const height = Math.round(width / ratio);
  const byOrder = new Map(panels.map(panel => [panel.order, panel]));
  return presentation.pages.map(page => {
    const pagePanels = page.panelOrders
      .map(order => byOrder.get(order))
      .filter((panel): panel is ComicPanel => panel !== undefined);
    const columns = Math.max(1, page.columns);
    const rows = Math.max(1, Math.ceil(pagePanels.length / columns));
    const slotWidth = (width - SHEET_GAP * (columns + 1)) / columns;
    const slotHeight = (height - SHEET_GAP * (rows + 1)) / rows;
    const slots: ComicSheetSlot[] = pagePanels.map((panel, index) => ({
      panelId: panel.id,
      x: SHEET_GAP + (index % columns) * (slotWidth + SHEET_GAP),
      y: SHEET_GAP + Math.floor(index / columns) * (slotHeight + SHEET_GAP),
      width: slotWidth,
      height: slotHeight,
    }));
    return {
      width,
      height,
      gap: SHEET_GAP,
      background: skill.exportDefaults.background || '#ffffff',
      slots,
    };
  });
}

/** 单页布局（兼容旧调用 = 首页；多页项目请用 computePageLayouts）。 */
export function computeSheetLayout(project: ComicProject): ComicSheetLayout | null {
  return computePageLayouts(project)[0] ?? null;
}

type ImageLoader = (path: string) => Promise<HTMLImageElement | null>;

/**
 * Panel 底图入槽几何（V4.2.13 双问题修复 · fit-safe 单一事实源）：
 *  - 资产与槽位比例一致（如 1:1 四格）时 min==max，结果与旧 center-cover 完全等价；
 *  - 比例错配（如竖排双格 3:4 页 1032×684 槽位内的 1024×1024 方形资产）时完整
 *    保留画面，槽内留白由页面背景（exportDefaults.background）填充——不再用不可
 *    解释的居中裁切切掉主体（实测该场景上下各裁 174px ≈ 33.7% 竖向构图）。
 * 编辑器 .comic-editor-figure 的 object-fit:contain 与此同策略（WYSIWYG）。
 */
export function computePanelImageRect(
  image: { width: number; height: number },
  slot: ComicSheetSlot,
): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(slot.width / image.width, slot.height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  return {
    x: slot.x + (slot.width - drawWidth) / 2,
    y: slot.y + (slot.height - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight,
  };
}

function drawPanelImage(ctx: CanvasRenderingContext2D, image: HTMLImageElement, slot: ComicSheetSlot): void {
  const rect = computePanelImageRect(image, slot);
  ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
}

/**
 * 绘制一条对白（V4.2.14 WYSIWYG 契约，docs/ai-comic/28）：布局 = 共享引擎
 * calculateDialogueLayout（与编辑器 ComicBubbleBox 同一函数、同一公式），本函数
 * 只做 canvas 绘制 backend：气泡 = bubbleShape 共享几何（Path2D 同一条 path），
 * 文字 = 逐行 fillText（描边 / 阴影 = dialogueTextPaint 预设）。Export 只 render，
 * 不做任何 layout decision。
 */
function drawDialogue(
  ctx: CanvasRenderingContext2D,
  dialogue: ComicDialogue,
  slot: ComicSheetSlot,
): void {
  // measure 用本画布 ctx（与编辑器 offscreen canvas 同一浏览器字体引擎）
  const measure: MeasureText = (text, font) => {
    ctx.font = `${font.weight} ${font.px}px ${dialogueFontStack(font.family)}`;
    return ctx.measureText(text).width;
  };
  // 基线度量（B1 修复）：fontBoundingBox 与浏览器行盒同一字体度量 → 导出基线
  // 与编辑器逐像素一致；度量不可用（老引擎）回落近似常量
  const measureMetrics: MeasureFontMetrics = (font) => {
    ctx.font = `${font.weight} ${font.px}px ${dialogueFontStack(font.family)}`;
    const m = ctx.measureText('国');
    const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent;
    const descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
    if (Number.isFinite(ascent) && Number.isFinite(descent) && ascent + descent > 0) {
      return { ascent: ascent / font.px, descent: descent / font.px };
    }
    return DEFAULT_FONT_METRICS;
  };
  const layout = calculateDialogueLayout(
    dialogue,
    { width: slot.width, height: slot.height },
    measure,
    measureMetrics,
  );
  if (layout.lines.length === 0) return;

  const geometry = bubbleGeometry(dialogue.bubbleStyle, BUBBLE_CANVAS, BUBBLE_CANVAS, layout.tail);
  const boxX = slot.x + layout.box.x;
  const boxY = slot.y + layout.box.y;

  if (geometry.body && typeof Path2D !== 'undefined') {
    ctx.save();
    ctx.translate(boxX, boxY);
    ctx.scale(layout.box.width / BUBBLE_CANVAS, layout.box.height / BUBBLE_CANVAS);
    const scaleCompensation = BUBBLE_CANVAS / ((layout.box.width + layout.box.height) / 2);
    // B2/B3 修复：描边 / 虚线 = panel 宽比例（bubbleShape 共享常量，DOM SVG 同源）
    const strokeRatio = BUBBLE_STROKE_WIDTH_RATIO * slot.width;
    const isNarration = geometry.fill === 'narration';
    ctx.fillStyle = isNarration ? BUBBLE_SURFACE_COLORS.narration.fill : BUBBLE_SURFACE_COLORS.bubble.fill;
    ctx.strokeStyle = isNarration ? BUBBLE_SURFACE_COLORS.narration.stroke : BUBBLE_SURFACE_COLORS.bubble.stroke;
    ctx.lineWidth = strokeRatio * scaleCompensation;
    if (geometry.dashed) {
      ctx.setLineDash([
        BUBBLE_DASH_PATTERN.on * slot.width * scaleCompensation,
        BUBBLE_DASH_PATTERN.off * slot.width * scaleCompensation,
      ]);
    }
    const path = new Path2D(geometry.body);
    ctx.fill(path);
    ctx.stroke(path);
    for (const circle of geometry.extras) {
      ctx.beginPath();
      ctx.arc(circle.cx, circle.cy, circle.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  // 文字：逐行绘制（基线 = dialogueBaseline，与 DOM 逐行 span 同一算法）
  const paint = dialogueTextPaint(dialogue, geometry.fill);
  const weight = dialogueEffectiveWeight(dialogue);
  ctx.font = `${weight} ${layout.fontPx}px ${dialogueFontStack(dialogue.fontStyle.family)}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = dialogue.alignment === 'left' ? 'left' : dialogue.alignment === 'right' ? 'right' : 'center';
  if (paint.stroke) {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, paint.stroke.width * layout.fontPx);
    ctx.strokeStyle = paint.stroke.color;
    layout.lines.forEach((line, index) => {
      ctx.strokeText(line, slot.x + dialogueLineAnchorX(layout, index, dialogue.alignment), slot.y + dialogueBaseline(layout, index));
    });
    ctx.restore();
  }
  if (paint.shadow === 'soft') {
    // B5 修复：阴影 = 字号比例（bubbleShape 共享常量，DOM text-shadow 同源）
    ctx.shadowColor = DIALOGUE_SOFT_SHADOW.dropColor;
    ctx.shadowBlur = layout.fontPx * DIALOGUE_SOFT_SHADOW.blur;
    ctx.shadowOffsetY = layout.fontPx * DIALOGUE_SOFT_SHADOW.offsetY;
  } else {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }
  ctx.fillStyle = paint.fill;
  layout.lines.forEach((line, index) => {
    ctx.fillText(line, slot.x + dialogueLineAnchorX(layout, index, dialogue.alignment), slot.y + dialogueBaseline(layout, index));
  });
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

/** 绘制一页（底图 + 文字层）。缺图槽位画占位框，缺对白照常叠加。 */
async function drawSheet(
  project: ComicProject,
  layout: ComicSheetLayout,
  loadImage: ImageLoader,
): Promise<HTMLCanvasElement | null> {
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = layout.background;
  ctx.fillRect(0, 0, layout.width, layout.height);

  for (const slot of layout.slots) {
    const panel = project.panels.find((item): item is ComicPanel => item.id === slot.panelId);
    if (!panel) continue;
    const image = panel.imageAsset ? await loadImage(panel.imageAsset.path) : null;
    if (image) {
      drawPanelImage(ctx, image, slot);
    } else {
      ctx.save();
      ctx.fillStyle = 'rgba(120,120,130,0.16)';
      ctx.fillRect(slot.x, slot.y, slot.width, slot.height);
      ctx.strokeStyle = 'rgba(120,120,130,0.5)';
      ctx.setLineDash([10, 8]);
      ctx.strokeRect(slot.x, slot.y, slot.width, slot.height);
      ctx.restore();
    }
    for (const dialogue of visibleDialoguesOfPanel(project, slot.panelId)) {
      drawDialogue(ctx, dialogue, slot);
    }
  }
  return canvas;
}

/** 逐页合成（§47）：多页连载返回 N 张整图，单页形式返回 1 张。无 DOM / 无分镜 → 空数组。 */
export async function renderComicSheets(
  project: ComicProject,
  loadImage: ImageLoader,
): Promise<HTMLCanvasElement[]> {
  if (typeof document === 'undefined') return [];
  const layouts = computePageLayouts(project);
  const canvases: HTMLCanvasElement[] = [];
  for (const layout of layouts) {
    const canvas = await drawSheet(project, layout, loadImage);
    if (canvas) canvases.push(canvas);
  }
  return canvases;
}

/** 首页合成（兼容旧调用）；无页可画返回 null。 */
export async function renderComicSheet(
  project: ComicProject,
  loadImage: ImageLoader,
): Promise<HTMLCanvasElement | null> {
  return (await renderComicSheets(project, loadImage))[0] ?? null;
}

/** 导出 PNG：全图读取 → 逐页合成 → 用户选择保存位置（多页逐张）。返回成功保存张数。 */
export async function exportComicSheetPng(project: ComicProject): Promise<number> {
  const loadImage = makeLibraryImageLoader();
  const canvases = await renderComicSheets(project, loadImage);
  if (canvases.length === 0) return 0;
  const base = `${project.name || 'AI漫画'} · ${new Date().toISOString().slice(0, 10)}`;
  let saved = 0;
  for (let index = 0; index < canvases.length; index += 1) {
    const dataUrl = canvases[index]!.toDataURL('image/png');
    const name = canvases.length > 1 ? `${base} · 第 ${index + 1} 页` : base;
    if (await api.saveImageAs(dataUrl.slice(dataUrl.indexOf(',') + 1), name)) saved += 1;
  }
  return saved;
}

// ---------------------------------------------------------------------------
// V4.2.11 §F 组合漫画页面（显式导出触发 → 落图库 → 画廊一级资产）
// ---------------------------------------------------------------------------

function makeLibraryImageLoader(): ImageLoader {
  return async path => {
    try {
      const dataUrl = await api.readImageData(path);
      return await new Promise<HTMLImageElement | null>(resolve => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = dataUrl;
      });
    } catch {
      return null;
    }
  };
}

/**
 * §F 组合漫画页面并持久化：全部活动格成图后，本地合成整页（底图 + 文字层）→
 * save_comic_page_to_library 写入图片库 → import_images_to_library 建索引 →
 * 图库描述/标签归因（最终页为一级资产，格图为子资产）。
 * 纯本地 canvas（§48：零 Image2 调用）；V4.2.13 残留修复后只由「导出整页 PNG」
 * 显式调用（编辑对白零自动导出 / 零入图库；再次导出即按当前画面重组合）。
 * 未全部成图 / DOM 不可用 → 空数组（调用方保持现状）。
 */
export async function persistComicFinalPages(project: ComicProject): Promise<ComicFinalPageAsset[]> {
  if (typeof document === 'undefined') return [];
  const panels = comicPanelsByOrder(project);
  if (panels.length === 0 || !panels.every(panel => panel.imageAsset)) return [];
  const layouts = computePageLayouts(project);
  if (layouts.length === 0) return [];
  const loadImage = makeLibraryImageLoader();
  const storyTitle = project.story?.title ? `《${project.story.title}》` : '';
  const base = `AI漫画${storyTitle ? ` · ${storyTitle}` : ''} · ${project.name || '最终页'}`;
  const assets: ComicFinalPageAsset[] = [];
  for (let pageIndex = 0; pageIndex < layouts.length; pageIndex += 1) {
    const layout = layouts[pageIndex]!;
    const canvas = await drawSheet(project, layout, loadImage);
    if (!canvas) continue;
    const dataUrl = canvas.toDataURL('image/png');
    const fileName = layouts.length > 1 ? `${base} · 第 ${pageIndex + 1} 页` : base;
    let path: string;
    try {
      path = await api.saveComicPageToLibrary(dataUrl, fileName);
    } catch {
      continue; // 库目录未配置等：本页跳过，不阻断其余页
    }
    let imageId = '';
    try {
      const imported = await api.importImagesToLibrary([path]);
      const record = imported.images.find(image => image.local_path === path);
      imageId = record?.id ?? '';
    } catch {
      // 索引建立失败：资产仍记录 path，gallery 重扫后可补
    }
    if (!imageId) continue;
    try {
      await api.updateImageIndex(imageId, null, null, fileName, [
        'ai-comic', 'comic-final-page', project.id,
      ]);
    } catch {
      // 归因失败不阻断组合
    }
    assets.push({
      page: pageIndex,
      path,
      imageId,
      panelIds: layout.slots.map(slot => slot.panelId),
      composedAt: new Date().toISOString(),
    });
  }
  return assets;
}

/**
 * §F 格图子资产归因：每格成图打上「第 N 格」描述 + 项目标签（画廊可见血缘）。
 * 纯索引更新，零生成调用；已归因（描述相同）时幂等跳过由调用方保证。
 */
export async function attributeComicPanelImages(
  project: ComicProject,
  attributed: (panelId: string) => boolean,
): Promise<void> {
  const panels = project.panels.filter(panel => !panel.stale);
  for (const panel of panels) {
    if (!panel.imageAsset || attributed(panel.id)) continue;
    try {
      await api.updateImageIndex(
        panel.imageAsset.imageId,
        null,
        null,
        `AI漫画 · ${project.name || '未命名'} · 第 ${panel.order + 1} 格`,
        ['ai-comic', `panel:${panel.id}`, project.id],
      );
    } catch {
      // 单格归因失败：下次组合重试
    }
  }
}
