/**
 * Region Replacement V1（§9）—— 区域替换的创建 / 归一化 / 校验。
 *
 *  - 所有坐标归一化 0..1（左上原点；换分辨率 / 换画布尺寸不失效）；
 *  - 画笔 mask 不把 bitmap 塞进状态：笔触（归一化点列 + 半径）随 region 持久化，
 *    栅格 PNG 由画布导出后经 Rust 命令落盘，region 只引用 maskPath；
 *  - 区域与 Person Contract 联动：replaceScope='custom_region' 必须指向存在的区域。
 */

import type {
  BrushMaskRegion,
  BrushStroke,
  PersonConstraintStrength,
  RectangleRegion,
  RegionReplacement,
  RegionReplaceType,
  RegionShape,
  VisualReferenceAsset,
} from './types';

export const REGION_TYPE_LABELS: Record<RegionReplaceType, string> = {
  person: '人物替换',
  background: '背景替换',
  object: '物体替换',
  custom: '自定义',
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 矩形归一化（x/y/w/h 钳制 0..1；w/h 下限 0，越界裁剪）。 */
export function normalizeRectangle(rect: RectangleRegion): RectangleRegion {
  const x = clamp01(rect.x);
  const y = clamp01(rect.y);
  const w = Math.min(1 - x, clamp01(rect.w));
  const h = Math.min(1 - y, clamp01(rect.h));
  return { kind: 'rect', x, y, w, h };
}

/** 笔触归一化（点钳制 0..1；半径钳制 (0,0.5]）。 */
export function normalizeStroke(stroke: BrushStroke): BrushStroke {
  return {
    points: (stroke.points ?? [])
      .map(point => ({ x: clamp01(point.x), y: clamp01(point.y) }))
      .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y)),
    radius: Math.min(0.5, Math.max(0.001, stroke.radius)),
  };
}

export function normalizeShape(shape: RegionShape): RegionShape {
  if (shape.kind === 'rect') return normalizeRectangle(shape);
  return {
    kind: 'brush',
    strokes: (shape.strokes ?? []).map(normalizeStroke).filter(stroke => stroke.points.length > 0),
    naturalWidth: Math.max(1, Math.round(shape.naturalWidth || 1)),
    naturalHeight: Math.max(1, Math.round(shape.naturalHeight || 1)),
  };
}

let regionSeq = 0;
export function newRegionId(): string {
  regionSeq += 1;
  return `region-${Date.now().toString(36)}-${regionSeq}-${Math.random().toString(36).slice(2, 6)}`;
}

export function createRegion(input: {
  shape: RegionShape;
  replaceType?: RegionReplaceType;
  name?: string;
  prompt?: string;
}): RegionReplacement {
  const shape = normalizeShape(input.shape);
  const type: RegionReplaceType = input.replaceType ?? 'custom';
  return {
    id: newRegionId(),
    name: input.name?.trim() || `区域 ${regionSeq}`,
    shape,
    replaceType: type,
    constraintStrength: type === 'person' ? 'strict' : 'balanced',
    ...(type === 'person' ? { replaceScope: 'whole_person' as const } : {}),
    ...(input.prompt?.trim() ? { prompt: input.prompt.trim() } : {}),
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}

/** 归一化（持久化恢复 / 输入合法化；引用校验依赖 references 列表）。 */
export function normalizeRegion(
  region: RegionReplacement,
  references?: ReadonlyArray<VisualReferenceAsset>,
): RegionReplacement {
  const strength: PersonConstraintStrength = ['natural', 'balanced', 'strict'].includes(region.constraintStrength)
    ? region.constraintStrength
    : 'balanced';
  const type: RegionReplaceType = REGION_TYPE_LABELS[region.replaceType] ? region.replaceType : 'custom';
  const refExists = !!region.personReferenceId
    && (references ?? []).some(ref => ref.id === region.personReferenceId);
  return {
    ...region,
    name: region.name?.trim() || '未命名区域',
    shape: normalizeShape(region.shape),
    replaceType: type,
    constraintStrength: strength,
    personReferenceId: type === 'person' && refExists ? region.personReferenceId : undefined,
    replaceScope: type === 'person' && region.replaceScope && ['face', 'upper_body', 'whole_person'].includes(region.replaceScope)
      ? region.replaceScope
      : type === 'person' ? 'whole_person' : undefined,
    enabled: region.enabled !== false,
    createdAt: region.createdAt || new Date().toISOString(),
  };
}

/** 区域语义校验（§37 / §9.5）：类型 = 人物但没绑参考 / mask 引用缺失等。 */
export function validateRegionContract(
  regions: ReadonlyArray<RegionReplacement>,
  references?: ReadonlyArray<VisualReferenceAsset>,
): string[] {
  const errors: string[] = [];
  const seenIds = new Set<string>();
  regions.forEach((region, index) => {
    if (!region.id) errors.push(`第 ${index + 1} 个区域缺少 id。`);
    if (seenIds.has(region.id)) errors.push(`区域 id 重复：${region.id}。`);
    seenIds.add(region.id);
    if (!region.enabled) return;
    if (region.replaceType === 'person' && !region.personReferenceId) {
      errors.push(`区域「${region.name}」设置为人物替换，但未绑定人物参考。`);
    }
    if (region.replaceType === 'person' && region.personReferenceId && references
      && !references.some(ref => ref.id === region.personReferenceId)) {
      errors.push(`区域「${region.name}」绑定的人物参考不存在。`);
    }
    if (region.shape.kind === 'rect') {
      const { x, y, w, h } = region.shape;
      if (![x, y, w, h].every(v => Number.isFinite(v) && v >= 0 && v <= 1) || w <= 0 || h <= 0) {
        errors.push(`区域「${region.name}」的矩形坐标未归一化（必须 0..1）。`);
      }
    } else if (region.shape.kind === 'brush') {
      const { strokes } = region.shape;
      if (!Array.isArray(strokes) || strokes.length === 0) {
        errors.push(`区域「${region.name}」的画笔区域缺少笔触。`);
      } else if (!strokes.every(stroke => stroke.points.every(p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1))) {
        errors.push(`区域「${region.name}」的笔触坐标未归一化（必须 0..1）。`);
      }
    }
  });
  return errors;
}

/** 区域数量上限（V1 防误操作；超出建议合并 / 删除）。 */
export const REGION_LIMIT = 8;

/** 归一化矩形 → 画面位置语言（供 Prompt Compiler / Rail 展示，非像素值）。 */
export function describeRectPosition(rect: RectangleRegion): string {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const horizontal = cx < 1 / 3 ? '左侧' : cx > 2 / 3 ? '右侧' : '中部';
  const vertical = cy < 1 / 3 ? '上部' : cy > 2 / 3 ? '下部' : '中部';
  const size = rect.w * rect.h > 0.5 ? '占据画面大部分' : rect.w * rect.h > 0.12 ? '局部' : '小块';
  if (horizontal === '中部' && vertical === '中部') return `画面中央（${size}）`;
  return `画面${vertical === '中部' ? '' : vertical}${horizontal}（${size}）`;
}

/** 启用中的栅格 mask 区域（生成时合成 combined mask 的输入）。 */
export function enabledRasterRegions(regions: ReadonlyArray<RegionReplacement>): RegionReplacement[] {
  return regions.filter(region => region.enabled && !!region.maskPath?.trim());
}
