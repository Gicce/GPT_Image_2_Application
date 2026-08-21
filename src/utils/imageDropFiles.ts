/**
 * 拖拽图片路径统一处理（V4.0.8）—— 图片生成参考图 / AI 对话附件 / 视觉理解共用。
 *
 * Tauri 桌面端 OS 文件拖放只产生本地路径（onDragDropEvent），本模块是
 * 「路径 → 可导入图片」的唯一判定入口：扩展名校验、规范化去重、合并进已有列表。
 * 三个业务入口（本地按钮 / 图库选择 / 拖拽）共用 mergeSourceImages，保证
 * path 身份判定只有一套逻辑，不出现按钮与拖拽两套去重规则。
 */

export interface DroppedImageFile {
  path: string;
  name: string;
}

/** 支持拖拽 / 参考图导入的图片扩展名（与视觉理解页、图库体系一致）。 */
export const IMAGE_EXTENSION_RE = /\.(png|jpe?g|webp)$/i;

export const INVALID_IMAGE_DROP_TOAST = '仅支持 PNG、JPG、JPEG、WebP 图片。';

export function isDroppableImagePath(path: string): boolean {
  return IMAGE_EXTENSION_RE.test(path.trim());
}

export function fileNameOfPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * 路径身份键：统一分隔符 + 小写（Windows 大小写不敏感）。
 * 本地选择返回反斜杠路径、图库记录是正斜杠路径 —— 同一文件两条来源必须判定为同一张图。
 */
export function canonicalImagePath(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase();
}

export interface SplitDroppedPathsResult {
  images: DroppedImageFile[];
  invalid: string[];
}

/** 一次拖入的路径集合 → 合法图片 + 非法文件（目录 / txt / exe 等按扩展名判定）。 */
export function splitDroppedPaths(paths: readonly string[]): SplitDroppedPathsResult {
  const images: DroppedImageFile[] = [];
  const invalid: string[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (!path) continue;
    if (isDroppableImagePath(path)) {
      images.push({ path, name: fileNameOfPath(path) });
    } else {
      invalid.push(path);
    }
  }
  return { images, invalid };
}

export interface MergeSourceImagesResult {
  images: DroppedImageFile[];
  added: DroppedImageFile[];
  duplicates: string[];
}

/**
 * 合并进已有参考图列表：按 canonicalImagePath 去重，保持已有顺序在前、
 * 新图按拖入顺序追加。重复图（连续拖两次 / 本地与图库同文件）静默跳过并记录。
 */
export function mergeSourceImages(
  existing: readonly DroppedImageFile[],
  incoming: readonly DroppedImageFile[],
): MergeSourceImagesResult {
  const seen = new Set(existing.map(item => canonicalImagePath(item.path)));
  const added: DroppedImageFile[] = [];
  const duplicates: string[] = [];
  for (const item of incoming) {
    const key = canonicalImagePath(item.path);
    if (seen.has(key)) {
      duplicates.push(item.path);
      continue;
    }
    seen.add(key);
    added.push(item);
  }
  return { images: [...existing, ...added], added, duplicates };
}
