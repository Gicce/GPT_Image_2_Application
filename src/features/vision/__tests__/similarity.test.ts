import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SIMILARITY_WEIGHTS,
  buildSimilarityReport,
  compareComposition,
  compareTextElements,
  normalizeWeights,
  normalizedTextSimilarity,
} from '../similarity';
import type { VisionAnalysis, VisionComparison } from '../../../types';

function emptyAnalysis(): VisionAnalysis {
  return {
    summary: '', subjects: [], objects: [],
    scene: { environment: '', location: '', time_of_day: '', weather: '', background: '', foreground: '' },
    composition: { subject_placement: '', symmetry: '', rule_of_thirds: null, horizon: null, negative_space: '', crop: '', depth_layers: '' },
    camera: { shot_type: '', focal_length_estimate: null, perspective: '', angle: '', depth_of_field: '', lens_characteristics: '' },
    lighting: { source: '', direction: '', softness: '', key_fill_rim: '', contrast: '', time_of_day: '', exposure: '' },
    colors: { dominant_palette: [], temperature: '', saturation: '', contrast: '' },
    style: { category: '', medium: '', texture: '', rendering: '', photographic_characteristics: '' },
    text_elements: [], fine_details: [], generation_risks: [],
  };
}

function fullComparison(patch: Partial<VisionComparison> = {}): VisionComparison {
  return {
    subject: 0.9, composition: 0.85, style: 0.9, lighting: 0.8, color: 0.88,
    objects: 0.85, text: null,
    missing_elements: [], extra_elements: [], layout_differences: [], style_differences: [],
    lighting_differences: [], color_differences: [], prompt_corrections: [],
    ...patch,
  };
}

describe('normalizeWeights 权重归一', () => {
  it('全维度可用时权重和为 1 且保持默认比例', () => {
    const result = normalizeWeights(DEFAULT_SIMILARITY_WEIGHTS, { objects: true, ocr: true });
    const total = Object.values(result).reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
    expect(result.subject).toBeCloseTo(0.30);
  });

  it('OCR 不适用时重新归一：其余维度按比例放大，总和仍为 1', () => {
    const result = normalizeWeights(DEFAULT_SIMILARITY_WEIGHTS, { objects: true, ocr: false });
    expect(result.ocr).toBe(0);
    const total = Object.values(result).reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
    // subject 0.30 / 0.95 ≈ 0.3158
    expect(result.subject).toBeCloseTo(0.30 / 0.95, 4);
  });

  it('OCR 与 objects 均不适用时同样归一', () => {
    const result = normalizeWeights(DEFAULT_SIMILARITY_WEIGHTS, { objects: false, ocr: false });
    expect(result.objects).toBe(0);
    expect(result.ocr).toBe(0);
    const total = Object.values(result).reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
  });
});

describe('compareComposition 构图相似度', () => {
  it('同位置同主体 → 高分', () => {
    const source = emptyAnalysis();
    const candidate = emptyAnalysis();
    source.subjects = [{ label: '保温杯', count: 1, appearance: [], pose: null, action: null, position: { x: 0.35, y: 0.3, width: 0.3, height: 0.5 }, orientation: null, clothing: [], relations: [] }];
    candidate.subjects = [{ label: '保温杯', count: 1, appearance: [], pose: null, action: null, position: { x: 0.36, y: 0.31, width: 0.29, height: 0.5 }, orientation: null, clothing: [], relations: [] }];
    const result = compareComposition(source, candidate);
    expect(result.unmatched).toBe(false);
    expect(result.score).toBeGreaterThan(0.8);
    expect(result.matched).toBe(1);
  });

  it('主体位置漂移大 → 低分并报告 missing', () => {
    const source = emptyAnalysis();
    const candidate = emptyAnalysis();
    source.subjects = [{ label: '保温杯', count: 1, appearance: [], pose: null, action: null, position: { x: 0.05, y: 0.05, width: 0.2, height: 0.2 }, orientation: null, clothing: [], relations: [] }];
    candidate.subjects = [{ label: '保温杯', count: 1, appearance: [], pose: null, action: null, position: { x: 0.7, y: 0.7, width: 0.2, height: 0.2 }, orientation: null, clothing: [], relations: [] }];
    const result = compareComposition(source, candidate);
    expect(result.score).toBeLessThan(0.6);
  });

  it('任一侧无定位信息 → unmatched（退出本地计算，不当 0 分）', () => {
    const source = emptyAnalysis();
    const candidate = emptyAnalysis();
    source.subjects = [{ label: '主体', count: 1, appearance: [], pose: null, action: null, position: null, orientation: null, clothing: [], relations: [] }];
    const result = compareComposition(source, candidate);
    expect(result.unmatched).toBe(true);
    expect(result.score).toBe(0);
  });

  it('标签表述差异（包含关系）仍可匹配', () => {
    const source = emptyAnalysis();
    const candidate = emptyAnalysis();
    source.objects = [{ label: '手提包', count: 1, position: { x: 0.6, y: 0.5, width: 0.15, height: 0.2 }, attributes: [] }];
    candidate.objects = [{ label: '黑色手提包', count: 1, position: { x: 0.61, y: 0.51, width: 0.15, height: 0.2 }, attributes: [] }];
    const result = compareComposition(source, candidate);
    expect(result.matched).toBe(1);
  });
});

describe('compareTextElements / 编辑距离', () => {
  it('完全一致 → 1', () => {
    expect(normalizedTextSimilarity('SUMMER SALE', 'summer  sale')).toBe(1);
  });

  it('完全不同 → 0', () => {
    expect(normalizedTextSimilarity('ABC', 'XYZ')).toBe(0);
  });

  it('部分一致给中间分', () => {
    const score = normalizedTextSimilarity('ABCDEFG', 'ABCDXYZ');
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(0.9);
  });

  it('源图无文字 → null（OCR 退出加权，不当 0 分）', () => {
    const source = emptyAnalysis();
    const candidate = emptyAnalysis();
    candidate.text_elements = [{ content: '多余文字', position: null, style: '' }];
    expect(compareTextElements(source, candidate)).toBeNull();
  });

  it('源图有文字、候选图无 → 0 分', () => {
    const source = emptyAnalysis();
    source.text_elements = [{ content: 'SALE', position: null, style: '' }];
    const candidate = emptyAnalysis();
    expect(compareTextElements(source, candidate)).toBe(0);
  });
});

describe('buildSimilarityReport 最终评分', () => {
  const baseAnalysis = emptyAnalysis();

  it('各维度分数与本地色彩均值进入总分', () => {
    const report = buildSimilarityReport({
      comparison: fullComparison({ color: 0.8, objects: 0.9, text: null }),
      colorResult: { ok: true, score: 1.0 } as any,
      sourceAnalysis: baseAnalysis,
      candidateAnalysis: baseAnalysis,
    });
    // color = (0.8 + 1.0) / 2 = 0.9
    expect(report.scores.color).toBeCloseTo(0.9, 5);
    expect(report.final_score).toBeGreaterThan(0.8);
    expect(report.final_score).toBeLessThanOrEqual(1);
    expect(report.effective_weights.ocr).toBe(0); // 源图无文字 → OCR 退出
  });

  it('无文字时 OCR 缺席不拉低总分（与手动按剩余权重计算一致）', () => {
    const comparison = fullComparison({ text: null });
    const report = buildSimilarityReport({
      comparison,
      colorResult: null,
      sourceAnalysis: baseAnalysis,
      candidateAnalysis: baseAnalysis,
    });
    const w = normalizeWeights(DEFAULT_SIMILARITY_WEIGHTS, { objects: true, ocr: false });
    const expected =
      comparison.subject * w.subject
      + comparison.composition * w.composition
      + comparison.style * w.style
      + comparison.lighting * w.lighting
      + comparison.color * w.color
      + (comparison.objects ?? 0) * w.objects;
    expect(report.final_score).toBeCloseTo(expected, 5);
  });

  it('差异列表合并 missing/extra/layout 且去重自本地构图差异', () => {
    const source = emptyAnalysis();
    const candidate = emptyAnalysis();
    source.subjects = [{ label: '招牌', count: 1, appearance: [], pose: null, action: null, position: { x: 0.05, y: 0.9, width: 0.2, height: 0.08 }, orientation: null, clothing: [], relations: [] }];
    candidate.subjects = [{ label: '招牌', count: 1, appearance: [], pose: null, action: null, position: { x: 0.05, y: 0.9, width: 0.2, height: 0.08 }, orientation: null, clothing: [], relations: [] }];
    const report = buildSimilarityReport({
      comparison: fullComparison({ missing_elements: ['缺失的招牌'], layout_differences: ['主体偏左'] }),
      colorResult: null,
      sourceAnalysis: source,
      candidateAnalysis: candidate,
    });
    const kinds = report.differences.map(d => d.kind);
    expect(kinds).toContain('missing');
    expect(kinds).toContain('layout');
  });

  it('本地构图未匹配时 composition 退化为 Judge 分数', () => {
    const report = buildSimilarityReport({
      comparison: fullComparison({ composition: 0.7 }),
      colorResult: null,
      sourceAnalysis: emptyAnalysis(), // 双方无定位 → unmatched
      candidateAnalysis: emptyAnalysis(),
    });
    expect(report.scores.composition).toBeCloseTo(0.7, 5);
    expect(report.local_composition).toBeNull();
  });
});
