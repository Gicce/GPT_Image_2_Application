/**
 * ImageViewer 视图变换纯函数（缩放 / 平移数学唯一来源，供组件与测试共用）：
 *  - 视图模型 view = { scale, x, y }：图片以视口中心为原点居中，
 *    (x, y) 是图片中心相对视口中心的平移（屏幕像素），scale 为缩放倍率；
 *  - applyZoom 支持锚点缩放：anchor 为鼠标位置相对视口中心的屏幕坐标，
 *    缩放后保持 anchor 处的图片内容点不动（不传 anchor = 以视口中心缩放）；
 *  - clampScale 把倍率限制在 [MIN_SCALE, MAX_SCALE]。
 */

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;

export interface ImageViewerView {
  scale: number;
  x: number;
  y: number;
}

export interface ZoomAnchor {
  x: number;
  y: number;
}

export function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

/**
 * 以 factor 缩放：命中上下限时倍率不再变化（offset 同步保持不动）。
 * 锚点数学：图片内容点 p 在屏幕上的位置 = center + offset + p * scale，
 * 要求缩放后同一内容点仍落在 anchor 处：
 *   anchor = center + offset' + p * scale'
 *   p = (anchor - center - offset) / scale
 *   offset' = anchor - center - p * scale'
 * （以下坐标均已减去 center，故 anchor 直接用相对视口中心的值。）
 */
export function applyZoom(
  view: ImageViewerView,
  factor: number,
  anchor?: ZoomAnchor | null,
): ImageViewerView {
  const scale = clampScale(Math.round(view.scale * factor * 100) / 100);
  if (scale === view.scale) return view;
  const ratio = scale / view.scale;
  if (!anchor) {
    return { scale, x: view.x * ratio, y: view.y * ratio };
  }
  return {
    scale,
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
  };
}
