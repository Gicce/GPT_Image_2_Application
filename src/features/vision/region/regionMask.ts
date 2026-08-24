/**
 * Region mask 栅格化（§9.3）—— Canvas 绘制与 PNG 导出的纯操作层。
 *
 * edits API mask 语义（OpenAI 兼容 images/edits）：mask 的**透明区域 = 允许编辑**，
 * 不透明区域 = 保持原样。因此：
 *  - 单区域 mask：全图不透明，区域形状以 destination-out 挖空；
 *  - 合成 mask（多区域并集）：逐个挖空全部启用区域。
 * 坐标全部归一化（0..1）× natural 尺寸 → 像素，画布 = 原图 natural 尺寸
 * （与 edits 首图同尺寸，符合 API 要求）。
 */

import type { RegionReplacement } from '../project/types';

/** 在 ctx 上以 destination-out 挖空一个区域（透明 = 可编辑）。 */
export function carveRegion(
  ctx: CanvasRenderingContext2D,
  region: RegionReplacement,
  naturalWidth: number,
  naturalHeight: number,
): void {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  if (region.shape.kind === 'rect') {
    const { x, y, w, h } = region.shape;
    ctx.fillRect(x * naturalWidth, y * naturalHeight, w * naturalWidth, h * naturalHeight);
  } else {
    const scale = Math.min(naturalWidth, naturalHeight);
    ctx.strokeStyle = '#000';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of region.shape.strokes) {
      ctx.lineWidth = Math.max(1, stroke.radius * scale * 2);
      ctx.beginPath();
      stroke.points.forEach((point, index) => {
        const px = point.x * naturalWidth;
        const py = point.y * naturalHeight;
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      if (stroke.points.length === 1) {
        // 单点笔触：画圆点
        const p = stroke.points[0];
        ctx.arc(p.x * naturalWidth, p.y * naturalHeight, Math.max(1, stroke.radius * scale), 0, Math.PI * 2);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

export interface RenderMaskInput {
  naturalWidth: number;
  naturalHeight: number;
  regions: ReadonlyArray<RegionReplacement>;
}

/** 离屏渲染完整 mask（全图不透明 + 全部启用区域挖空；canvas 由调用方传入）。 */
export function renderCombinedMaskCanvas(canvas: HTMLCanvasElement, input: RenderMaskInput): void {
  canvas.width = input.naturalWidth;
  canvas.height = input.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const region of input.regions) {
    if (!region.enabled) continue;
    carveRegion(ctx, region, input.naturalWidth, input.naturalHeight);
  }
}

/** 渲染并导出 PNG dataURL（base64 部分；失败返回 null）。 */
export function exportMaskPngBase64(input: RenderMaskInput): string | null {
  try {
    const canvas = document.createElement('canvas');
    renderCombinedMaskCanvas(canvas, input);
    const dataUrl = canvas.toDataURL('image/png');
    const comma = dataUrl.indexOf(',');
    return comma >= 0 ? dataUrl.slice(comma + 1) : null;
  } catch {
    return null;
  }
}

/** 区域覆盖层绘制（编辑器画布上的紫色半透明 overlay；非 mask，仅展示）。 */
export function paintRegionOverlay(
  ctx: CanvasRenderingContext2D,
  region: RegionReplacement,
  displayWidth: number,
  displayHeight: number,
  color = 'rgba(139, 92, 246, 0.38)',
  borderColor = 'rgba(139, 92, 246, 0.9)',
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1.5;
  if (region.shape.kind === 'rect') {
    const { x, y, w, h } = region.shape;
    ctx.fillRect(x * displayWidth, y * displayHeight, w * displayWidth, h * displayHeight);
    ctx.strokeRect(x * displayWidth, y * displayHeight, w * displayWidth, h * displayHeight);
  } else {
    const scale = Math.min(displayWidth, displayHeight);
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of region.shape.strokes) {
      ctx.lineWidth = Math.max(2, stroke.radius * scale * 2);
      ctx.beginPath();
      stroke.points.forEach((point, index) => {
        const px = point.x * displayWidth;
        const py = point.y * displayHeight;
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
  }
  ctx.restore();
}
