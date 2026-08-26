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

import type { NormalizedRegion, VisionAnalysis, VisionSubject } from '../../../types';
import type { VisualRecreationPlan } from '../recreationPlan';
import { deriveRenderingContract } from './rendering';
import type {
  ModelExecutionSnapshot,
  RegionPoseSnapshot,
  TemplateDimension,
  VisualTemplateSnapshot,
} from './types';

function dimension(value: string | undefined, structured?: unknown): TemplateDimension {
  return { originalValue: (value || '').trim(), ...(structured !== undefined ? { structured } : {}) };
}

function fieldOf(plan: VisualRecreationPlan, key: string): string {
  return plan.fields.find(field => field.key === key)?.originalValue
    ?? plan.fields.find(field => field.key === key)?.value
    ?? '';
}

function joinDefined(parts: Array<string | null | undefined>): string {
  return parts.map(p => (p || '').trim()).filter(Boolean).join('，');
}

function normalizedLabel(label: string): string {
  return label.replace(/[（）()\s]/g, '');
}

function labelMatches(a: string, b: string): boolean {
  const x = normalizedLabel(a);
  const y = normalizedLabel(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
}

function isValidAnchor(value: unknown): value is NormalizedRegion {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every(key => typeof record[key] === 'number' && Number.isFinite(record[key]));
}

/**
 * 分析主体 → 逐主体姿态快照（§13/§14）：主体 0 = primary_subject；
 * 其余主体若与混合媒介层的 anime_counterpart 角色标签吻合则归为动漫对应角色。
 */
function buildSubjectPoses(analysis: VisionAnalysis): RegionPoseSnapshot[] {
  return analysis.subjects.map((subject, index) => {
    const animeRegion = analysis.media_structure?.regions?.find(region =>
      region.semantic_role === 'anime_counterpart' && labelMatches(region.label ?? '', subject.label));
    const role: RegionPoseSnapshot['subjectRole'] = index === 0
      ? 'primary_subject'
      : animeRegion ? 'anime_counterpart' : 'secondary_subject';
    const pose: RegionPoseSnapshot = {
      id: `pose-${index + 1}`,
      label: subject.label,
      subjectRole: role,
      poseDescription: joinDefined([subject.pose, subject.action]) || '（模板原始姿态）',
      source: 'template_analysis',
    };
    // 表情分离：gesture / facial_expression / gaze 独立冻结（动作锁定 ⇒ 整套锁定）
    if (subject.gesture?.trim()) pose.gesture = subject.gesture.trim();
    if (subject.facial_expression?.trim()) pose.facialExpression = subject.facial_expression.trim();
    if (subject.gaze?.trim()) pose.gaze = subject.gaze.trim();
    if (subject.orientation?.trim()) pose.bodyOrientation = subject.orientation.trim();
    if (isValidAnchor(subject.position)) pose.spatialAnchor = subject.position;
    return pose;
  });
}

/** 持久化恢复合法化：逐字段形状校验，无效条目丢弃（不 crash、不发明数据）。 */
export function normalizeSubjectPoses(raw: unknown): RegionPoseSnapshot[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const poses: RegionPoseSnapshot[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    const poseDescription = typeof record.poseDescription === 'string' ? record.poseDescription.trim() : '';
    if (!label || !poseDescription) return;
    const role = ['primary_subject', 'anime_counterpart', 'secondary_subject', 'detail_insert'].includes(
      String(record.subjectRole))
      ? record.subjectRole as RegionPoseSnapshot['subjectRole']
      : index === 0 ? 'primary_subject' : 'secondary_subject';
    const pose: RegionPoseSnapshot = {
      id: typeof record.id === 'string' && record.id ? record.id : `pose-${index + 1}`,
      label,
      subjectRole: role,
      poseDescription,
      source: 'template_analysis',
    };
    if (typeof record.bodyOrientation === 'string' && record.bodyOrientation.trim()) {
      pose.bodyOrientation = record.bodyOrientation.trim();
    }
    for (const [raw, key] of [
      [record.gesture, 'gesture'],
      [record.facialExpression, 'facialExpression'],
      [record.gaze, 'gaze'],
    ] as const) {
      if (typeof raw === 'string' && raw.trim()) pose[key] = raw.trim();
    }
    if (isValidAnchor(record.spatialAnchor)) pose.spatialAnchor = record.spatialAnchor;
    poses.push(pose);
  });
  return poses.length > 0 ? poses : undefined;
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
    subjectPoses: buildSubjectPoses(analysis),
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
  const subjectPoses = normalizeSubjectPoses(snapshot.subjectPoses);
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
    ...(subjectPoses ? { subjectPoses } : {}),
    ...(snapshot.mediaStructure ? { mediaStructure: snapshot.mediaStructure } : {}),
    ...(snapshot.analysisModel ? { analysisModel: snapshot.analysisModel } : {}),
    analyzedAt: snapshot.analyzedAt || new Date().toISOString(),
    schemaVersion: 1,
  };
  return base;
}

/**
 * 模板快照 → 可展示的 VisionAnalysis（Canonical Restore §5/§6）：
 * workspace.analysis 丢失（旧持久化缺陷）但 templateSnapshot 完好时，
 * 从快照维度与逐主体姿态重建只读分析视图——恢复「AI 已理解」展示，
 * 绝不因此重新调用视觉分析 API。objects / fine_details 等未冻结字段
 * 以空集降级（宁可少展示，不伪造数据）。
 */
export function restoreAnalysisFromSnapshot(snapshot: VisualTemplateSnapshot): VisionAnalysis {
  const structuredOf = (dimension: TemplateDimension): unknown =>
    dimension.structured && typeof dimension.structured === 'object' ? dimension.structured : undefined;
  const subjects: VisionSubject[] = (snapshot.subjectPoses ?? []).map(pose => ({
    label: pose.label,
    appearance: [],
    pose: pose.poseDescription,
    action: null,
    ...(pose.gesture ? { gesture: pose.gesture } : {}),
    ...(pose.facialExpression ? { facial_expression: pose.facialExpression } : {}),
    ...(pose.gaze ? { gaze: pose.gaze } : {}),
    ...(pose.bodyOrientation ? { orientation: pose.bodyOrientation } : {}),
    ...(pose.spatialAnchor ? { position: pose.spatialAnchor } : {}),
    clothing: [],
    relations: [],
  }));
  if (subjects.length === 0 && structuredOf(snapshot.subject)) {
    subjects.push(structuredOf(snapshot.subject) as VisionSubject);
  }
  const scene = (structuredOf(snapshot.background) ?? {}) as Record<string, string>;
  const composition = (structuredOf(snapshot.composition) ?? {}) as Record<string, string>;
  const camera = (structuredOf(snapshot.camera) ?? {}) as Record<string, string>;
  const lighting = (structuredOf(snapshot.lighting) ?? {}) as Record<string, string>;
  const colors = (structuredOf(snapshot.color) ?? {}) as Record<string, string>;
  const style = (structuredOf(snapshot.style) ?? {}) as Record<string, string>;
  return {
    summary: describeTemplateSnapshot(snapshot),
    subjects,
    objects: [],
    scene: {
      environment: scene.environment ?? snapshot.background.originalValue,
      location: scene.location ?? '',
      background: scene.background ?? snapshot.background.originalValue,
      time_of_day: scene.time_of_day ?? '',
      weather: scene.weather ?? '',
      foreground: scene.foreground ?? '',
    } as VisionAnalysis['scene'],
    composition: {
      subject_placement: composition.subject_placement ?? snapshot.composition.originalValue,
      symmetry: composition.symmetry ?? '',
      crop: composition.crop ?? '',
      negative_space: composition.negative_space ?? '',
      depth_layers: composition.depth_layers ?? '',
    } as VisionAnalysis['composition'],
    camera: {
      shot_type: camera.shot_type ?? snapshot.camera.originalValue,
      angle: camera.angle ?? '',
      depth_of_field: camera.depth_of_field ?? '',
      perspective: camera.perspective ?? '',
      lens_characteristics: camera.lens_characteristics ?? '',
    } as VisionAnalysis['camera'],
    lighting: {
      source: lighting.source ?? snapshot.lighting.originalValue,
      direction: lighting.direction ?? '',
      softness: lighting.softness ?? '',
      contrast: lighting.contrast ?? '',
      key_fill_rim: lighting.key_fill_rim ?? '',
      time_of_day: lighting.time_of_day ?? '',
      exposure: lighting.exposure ?? '',
    } as VisionAnalysis['lighting'],
    colors: {
      dominant_palette: Array.isArray(colors.dominant_palette)
        ? colors.dominant_palette
        : (snapshot.color.originalValue ? snapshot.color.originalValue.split(/[，,、\s]+/) : []),
      temperature: colors.temperature ?? '',
      saturation: colors.saturation ?? '',
      contrast: colors.contrast ?? '',
    } as VisionAnalysis['colors'],
    style: {
      category: style.category ?? snapshot.style.originalValue,
      medium: style.medium ?? '',
      rendering: style.rendering ?? '',
      texture: style.texture ?? '',
      photographic_characteristics: style.photographic_characteristics ?? '',
    } as VisionAnalysis['style'],
    text_elements: [],
    fine_details: [],
    generation_risks: [],
  };
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

/** 模板分析溯源一行文案（§9：已理解项目重开时的展示口径，禁止回落「开始理解」）。 */
export function describeTemplateProvenance(snapshot: VisualTemplateSnapshot): string {
  const model = snapshot.analysisModel?.displayName?.trim() || snapshot.analysisModel?.modelId?.trim();
  const time = snapshot.analyzedAt ? new Date(snapshot.analyzedAt).toLocaleString() : '';
  return ['AI 已理解这张图片', model ? `视觉分析：${model}` : '', time ? `分析时间：${time}` : '']
    .filter(Boolean)
    .join(' · ');
}
