/**
 * VisualTemplateSnapshot（§3.3 / §5）—— 模板基线的冻结与重建。
 *
 * Template = baseline，Modification = overlay：
 *  - buildTemplateSnapshot 只在「分析源图」成功时刻调用；
 *  - 模板各维度取 recreation.plan.fields 的 originalValue（分析初始值），
 *    绝不取被修改后的 value —— 用户改人物 / 改背景永远不会污染这里；
 *  - 更换识别图（重新分析）= 重建整个快照；「保留修改意图」只保留 modification，
 *    模板一律以新图为准（§5）。
 */

import type { VisionAnalysis } from '../../../types';
import type { VisualRecreationPlan } from '../recreationPlan';
import { deriveRenderingContract } from './rendering';
import type { ModelExecutionSnapshot, TemplateDimension, VisualTemplateSnapshot } from './types';

function dimension(value: string | undefined, structured?: unknown): TemplateDimension {
  return { originalValue: (value || '').trim(), ...(structured !== undefined ? { structured } : {}) };
}

function fieldOf(plan: VisualRecreationPlan, key: string): string {
  return plan.fields.find(field => field.key === key)?.originalValue
    ?? plan.fields.find(field => field.key === key)?.value
    ?? '';
}

/** 分析成功 → 冻结模板基线（media_structure 缺失时由 style 确定性推断媒介契约）。 */
export function buildTemplateSnapshot(input: {
  analysis: VisionAnalysis;
  plan: VisualRecreationPlan;
  sourcePath: string;
  sourceAssetId?: string;
  analysisModel?: ModelExecutionSnapshot;
  analyzedAt?: string;
}): VisualTemplateSnapshot {
  const { analysis, plan } = input;
  const primary = analysis.subjects[0];
  return {
    sourceAssetId: input.sourceAssetId,
    sourcePath: input.sourcePath,
    subject: dimension(fieldOf(plan, 'subject'), primary),
    action: dimension(fieldOf(plan, 'pose')),
    background: dimension(fieldOf(plan, 'scene'), analysis.scene),
    composition: dimension(fieldOf(plan, 'composition'), analysis.composition),
    camera: dimension(fieldOf(plan, 'camera'), analysis.camera),
    style: dimension(fieldOf(plan, 'style'), analysis.style),
    lighting: dimension(fieldOf(plan, 'lighting'), analysis.lighting),
    color: dimension(fieldOf(plan, 'color'), analysis.colors),
    clothing: dimension(fieldOf(plan, 'clothing')),
    mediaStructure: deriveRenderingContract(analysis),
    ...(input.analysisModel ? { analysisModel: input.analysisModel } : {}),
    analyzedAt: input.analyzedAt || new Date().toISOString(),
    schemaVersion: 1,
  };
}

/** 模板快照持久化恢复合法化（旧数据缺字段 → 空维度，不 crash）。 */
export function normalizeTemplateSnapshot(
  snapshot: VisualTemplateSnapshot | null | undefined,
): VisualTemplateSnapshot | null {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.sourcePath?.trim()) return null;
  const dims: TemplateDimension = { originalValue: '' };
  const base: VisualTemplateSnapshot = {
    sourceAssetId: snapshot.sourceAssetId,
    sourcePath: snapshot.sourcePath,
    subject: snapshot.subject ?? { ...dims },
    action: snapshot.action ?? { ...dims },
    background: snapshot.background ?? { ...dims },
    composition: snapshot.composition ?? { ...dims },
    camera: snapshot.camera ?? { ...dims },
    style: snapshot.style ?? { ...dims },
    lighting: snapshot.lighting ?? { ...dims },
    color: snapshot.color ?? { ...dims },
    clothing: snapshot.clothing ?? { ...dims },
    ...(snapshot.mediaStructure ? { mediaStructure: snapshot.mediaStructure } : {}),
    ...(snapshot.analysisModel ? { analysisModel: snapshot.analysisModel } : {}),
    analyzedAt: snapshot.analyzedAt || new Date().toISOString(),
    schemaVersion: 1,
  };
  return base;
}

/**
 * 模板摘要（§27 AI 理解摘要一行文案）：媒介 × 主体 × 场景，
 * 只读模板基线（modification 摘要由 Effective Plan 提供，两者绝不混写）。
 */
export function describeTemplateSnapshot(snapshot: VisualTemplateSnapshot): string {
  const parts: string[] = [];
  const media = snapshot.mediaStructure;
  if (media?.overallMode === 'mixed_media') {
    const layerText = media.regions.length
      ? media.regions.map(region => region.label).join(' × ')
      : '混合媒介';
    parts.push(layerText);
  } else if (media?.singleMode && media.singleMode !== 'unknown') {
    parts.push(singleModeText(media.singleMode));
  }
  if (snapshot.subject.originalValue) parts.push(snapshot.subject.originalValue);
  if (snapshot.background.originalValue) parts.push(snapshot.background.originalValue);
  return parts.filter(Boolean).join('，') || '（未识别）';
}

function singleModeText(mode: string): string {
  const labels: Record<string, string> = {
    photorealistic: '真人摄影',
    anime_illustration: '动漫插画',
    illustration: '插画',
    '3d_render': '3D 渲染',
    graphic_design: '平面设计',
  };
  return labels[mode] ?? '图片模板';
}
