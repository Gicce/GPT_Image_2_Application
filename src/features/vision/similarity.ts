/**
 * 相似度引擎（V4.0.6）—— 本地确定性计算，无 AI 参与：
 * - 权重归一（OCR 不适用时重新归一，绝不当 0 分）
 * - 构图相似度（两次 VisionAnalysis 的 subjects/objects 归一化区域匹配）
 * - OCR 相似度（text_elements 内容编辑距离 + 位置粗比较）
 * - 最终加权（Vision Judge 分数 + 本地色彩 + 本地构图/OCR 综合）
 *
 * "0.90" 语义：CyImagePro 综合视觉相似度估算目标，不是像素级一致率。
 */

import type { ColorSimilarityResult, NormalizedRegion, VisionAnalysis, VisionComparison } from '../../types';

export interface SimilarityWeights {
  subject: number;
  composition: number;
  style: number;
  lighting: number;
  color: number;
  objects: number;
  ocr: number;
}

export const DEFAULT_SIMILARITY_WEIGHTS: SimilarityWeights = {
  subject: 0.30,
  composition: 0.20,
  style: 0.15,
  lighting: 0.10,
  color: 0.10,
  objects: 0.10,
  ocr: 0.05,
};

export interface VisualDifference {
  kind: 'missing' | 'extra' | 'layout' | 'style' | 'lighting' | 'color' | 'text';
  text: string;
}

export interface SimilarityReport {
  /** 0~1 综合估算分（加权归一后） */
  final_score: number;
  /** 各维度得分（OCR 不适用为 null） */
  scores: {
    subject: number;
    composition: number;
    style: number;
    lighting: number;
    color: number;
    objects: number | null;
    ocr: number | null;
  };
  /** 本地色彩（Rust HSV 直方图）得分；未执行为 null */
  local_color: number | null;
  /** 本地构图得分（结构化分析区域匹配）；输入不足为 null */
  local_composition: number | null;
  differences: VisualDifference[];
  recommendations: string[];
  /** 实际参与加权的权重（缺失维度已归一） */
  effective_weights: SimilarityWeights;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

/**
 * 权重归一：metric 为 null 的维度退出加权，剩余权重按比例放大（总和恒为 1）。
 * 例：OCR=null（5%）时，其余维度各除以 0.95 —— OCR 缺席绝不拉低总分。
 */
export function normalizeWeights(
  weights: SimilarityWeights,
  available: { objects: boolean; ocr: boolean },
): SimilarityWeights {
  const active: { key: keyof SimilarityWeights; on: boolean }[] = [
    { key: 'subject', on: true },
    { key: 'composition', on: true },
    { key: 'style', on: true },
    { key: 'lighting', on: true },
    { key: 'color', on: true },
    { key: 'objects', on: available.objects },
    { key: 'ocr', on: available.ocr },
  ];
  const total = active.reduce((sum, item) => sum + (item.on ? weights[item.key] : 0), 0);
  if (total <= 0) return { ...weights };
  const result = { ...weights };
  for (const item of active) {
    result[item.key] = item.on ? weights[item.key] / total : 0;
  }
  return result;
}

// ======================= 构图相似度（本地，来自两次结构化分析） =======================

interface PositionedItem {
  label: string;
  region: NormalizedRegion | null;
}

function collectPositionedItems(analysis: VisionAnalysis): PositionedItem[] {
  const items: PositionedItem[] = [];
  for (const subject of analysis.subjects ?? []) {
    items.push({ label: subject.label, region: subject.position ?? null });
  }
  for (const obj of analysis.objects ?? []) {
    items.push({ label: obj.label, region: obj.position ?? null });
  }
  return items;
}

function clampRegion(region: NormalizedRegion): NormalizedRegion {
  return {
    x: clamp01(region.x),
    y: clamp01(region.y),
    width: clamp01(region.width),
    height: clamp01(region.height),
  };
}

function regionCenter(region: NormalizedRegion): { cx: number; cy: number } {
  const r = clampRegion(region);
  return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
}

/** 标签粗匹配：完全相等或一方包含另一方（模型表述差异容错） */
function labelsMatch(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function regionSimilarity(a: NormalizedRegion, b: NormalizedRegion): number {
  const ca = regionCenter(a);
  const cb = regionCenter(b);
  // 中心距离（对角线归一）→ 相似度
  const distance = Math.sqrt((ca.cx - cb.cx) ** 2 + (ca.cy - cb.cy) ** 2) / Math.SQRT2;
  const centerSim = 1 - clamp01(distance);
  // 面积比相似度
  const areaA = clamp01(a.width) * clamp01(a.height);
  const areaB = clamp01(b.width) * clamp01(b.height);
  const areaSim = areaA + areaB <= 0 ? 1 : 1 - Math.abs(areaA - areaB) / Math.max(areaA, areaB);
  return 0.65 * centerSim + 0.35 * clamp01(areaSim);
}

export interface CompositionComparison {
  score: number;
  matched: number;
  missingLabels: string[];
  extraLabels: string[];
  unmatched: boolean;
}

/**
 * 构图相似度：源/候选结构化分析之间的主体与客体位置匹配。
 * 输入不足（任一侧无定位信息）→ unmatched=true（该维度退出本地计算，由 Vision Judge 兜底）。
 */
export function compareComposition(source: VisionAnalysis, candidate: VisionAnalysis): CompositionComparison {
  const sourceItems = collectPositionedItems(source).filter(item => item.label);
  const candidateItems = collectPositionedItems(candidate).filter(item => item.label);
  const sourcePositioned = sourceItems.filter(item => item.region);
  const candidatePositioned = candidateItems.filter(item => item.region);
  if (sourcePositioned.length === 0 || candidatePositioned.length === 0) {
    return { score: 0, matched: 0, missingLabels: [], extraLabels: [], unmatched: true };
  }

  // 贪心匹配：标签匹配的候选优先（同标签中取区域相似度最高），无标签匹配时取区域最近邻；
  // 得分只由区域相似度构成（标签仅决定匹配优先级与不匹配惩罚），不叠加越界加分。
  const used = new Set<number>();
  let similaritySum = 0;
  let matched = 0;
  const missing: string[] = [];
  for (const s of sourcePositioned) {
    let bestIndex = -1;
    let bestRegionSim = -1;
    let bestLabelOk = false;
    for (let i = 0; i < candidatePositioned.length; i++) {
      if (used.has(i)) continue;
      const c = candidatePositioned[i];
      const labelOk = labelsMatch(s.label, c.label);
      const sim = regionSimilarity(s.region!, c.region!);
      const better = bestIndex < 0
        || (labelOk && !bestLabelOk)
        || (labelOk === bestLabelOk && sim > bestRegionSim);
      if (better) {
        bestIndex = i;
        bestRegionSim = sim;
        bestLabelOk = labelOk;
      }
    }
    // 标签对不上按轻微惩罚（同一位置放了不同东西仍是构图一致的一部分）
    const score = clamp01(bestRegionSim * (bestLabelOk ? 1 : 0.75));
    if (bestIndex >= 0 && score >= 0.35) {
      used.add(bestIndex);
      similaritySum += score;
      matched++;
    } else {
      missing.push(s.label);
    }
  }
  const extra = candidatePositioned.filter((_, i) => !used.has(i)).map(item => item.label);
  // 匹配质量 × 覆盖率（缺失与多余都惩罚）
  const quality = matched > 0 ? similaritySum / matched : 0;
  const coverage = matched / Math.max(sourcePositioned.length, 1);
  const extraPenalty = Math.min(extra.length * 0.08, 0.3);
  const score = clamp01(quality * (0.6 + 0.4 * coverage) - extraPenalty);
  return { score, matched, missingLabels: missing, extraLabels: extra, unmatched: false };
}

// ======================= OCR 相似度（text_elements 编辑距离） =======================

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

export function normalizedTextSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  return clamp01(1 - levenshtein(x, y) / Math.max(x.length, y.length));
}

/**
 * OCR 相似度：源图与候选图 text_elements 的内容编辑距离 + 位置粗校验。
 * 源图无文字 → null（不参与最终加权，绝不为 0 分）。
 */
export function compareTextElements(source: VisionAnalysis, candidate: VisionAnalysis): number | null {
  const sourceTexts = (source.text_elements ?? []).map(t => t.content).filter(Boolean);
  if (sourceTexts.length === 0) return null;
  const candidateTexts = (candidate.text_elements ?? []).map(t => t.content).filter(Boolean);
  if (candidateTexts.length === 0) return 0;
  let total = 0;
  for (const s of sourceTexts) {
    const best = Math.max(...candidateTexts.map(c => normalizedTextSimilarity(s, c)));
    total += best;
  }
  return clamp01(total / sourceTexts.length);
}

// ======================= 最终报告 =======================

export interface BuildReportInput {
  comparison: VisionComparison;
  colorResult: ColorSimilarityResult | null;
  sourceAnalysis: VisionAnalysis;
  candidateAnalysis: VisionAnalysis;
  weights?: SimilarityWeights;
}

export const SIMILARITY_DISCLAIMER = '复刻相似度为系统估算值，不代表像素级一致率。';

export function buildSimilarityReport(input: BuildReportInput): SimilarityReport {
  const weights = input.weights ?? DEFAULT_SIMILARITY_WEIGHTS;
  const { comparison, colorResult, sourceAnalysis, candidateAnalysis } = input;

  const compositionLocal = compareComposition(sourceAnalysis, candidateAnalysis);
  const ocrLocal = compareTextElements(sourceAnalysis, candidateAnalysis);

  // 维度分数来源：
  // - subject/style/lighting/objects/text：Vision Judge 双图评审
  // - composition：Judge 分数与本地结构匹配取均值（本地未匹配时退化为 Judge 分数）
  // - color：Judge 色彩分与本地 HSV 直方图取均值（无本地结果时退化为 Judge 分数）
  // - ocr：优先本地 text_elements 编辑距离（更客观），Judge text 分数为备份
  const objectsScore = comparison.objects ?? null;
  const ocrScore = ocrLocal ?? comparison.text ?? null;

  const compositionScore = compositionLocal.unmatched
    ? clamp01(comparison.composition)
    : clamp01((comparison.composition + compositionLocal.score) / 2);
  const colorScore = colorResult?.ok && colorResult.score != null
    ? clamp01((clamp01(comparison.color) + clamp01(colorResult.score)) / 2)
    : clamp01(comparison.color);

  const effectiveWeights = normalizeWeights(weights, {
    objects: objectsScore !== null,
    ocr: ocrScore !== null,
  });

  const final =
    clamp01(comparison.subject) * effectiveWeights.subject
    + compositionScore * effectiveWeights.composition
    + clamp01(comparison.style) * effectiveWeights.style
    + clamp01(comparison.lighting) * effectiveWeights.lighting
    + colorScore * effectiveWeights.color
    + (objectsScore ?? 0) * effectiveWeights.objects
    + (ocrScore ?? 0) * effectiveWeights.ocr;

  const differences: VisualDifference[] = [
    ...(comparison.missing_elements ?? []).map(text => ({ kind: 'missing' as const, text })),
    ...(comparison.extra_elements ?? []).map(text => ({ kind: 'extra' as const, text })),
    ...(comparison.layout_differences ?? []).map(text => ({ kind: 'layout' as const, text })),
    ...(comparison.style_differences ?? []).map(text => ({ kind: 'style' as const, text })),
    ...(comparison.lighting_differences ?? []).map(text => ({ kind: 'lighting' as const, text })),
    ...(comparison.color_differences ?? []).map(text => ({ kind: 'color' as const, text })),
    ...(!compositionLocal.unmatched ? compositionLocal.missingLabels.map(text => ({ kind: 'missing' as const, text: `候选图疑似缺失元素：${text}` })) : []),
    ...(!compositionLocal.unmatched ? compositionLocal.extraLabels.map(text => ({ kind: 'extra' as const, text: `候选图疑似多出元素：${text}` })) : []),
  ];

  return {
    final_score: clamp01(final),
    scores: {
      subject: clamp01(comparison.subject),
      composition: compositionScore,
      style: clamp01(comparison.style),
      lighting: clamp01(comparison.lighting),
      color: colorScore,
      objects: objectsScore !== null ? clamp01(objectsScore) : null,
      ocr: ocrScore !== null ? clamp01(ocrScore) : null,
    },
    local_color: colorResult?.ok ? clamp01(colorResult.score) : null,
    local_composition: compositionLocal.unmatched ? null : compositionLocal.score,
    differences,
    recommendations: (comparison.prompt_corrections ?? []).filter(Boolean),
    effective_weights: effectiveWeights,
  };
}

/** 展示用：0~1 → 百分制（一位小数） */
export function scoreToPercent(score: number): number {
  return Math.round(clamp01(score) * 1000) / 10;
}
