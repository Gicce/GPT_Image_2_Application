/**
 * Reverse Prompt Compiler（V4.0.6）
 *
 * 确定性编译：VisionAnalysis（结构化视觉分析）→ 分节 Prompt → 目标方言。
 * 绝不把视觉模型的一段 prose 直接当最终 Prompt —— 模型只负责"看"，
 * 编译规则本地维护（稳定、可测试、可按目标生成模型方言调整）。
 */

import type { VisionAnalysis } from '../../types';

export type PromptDialect = 'generic' | 'gpt_image';

export interface PromptSections {
  subject: string;
  action: string;
  scene: string;
  composition: string;
  camera: string;
  lighting: string;
  color: string;
  material: string;
  style: string;
  detail: string;
}

export interface ReversePromptResult {
  prompt: string;
  negativePrompt: string;
  sections: PromptSections;
  recommended: {
    aspectRatio?: string;
    size?: string;
    quality?: string;
  };
  risks: string[];
  warnings: string[];
}

function joinParts(parts: (string | null | undefined)[], separator = '，'): string {
  const cleaned = parts.map(p => (p ?? '').trim()).filter(Boolean);
  return cleaned.join(separator);
}

function subjectCountText(count?: number | null): string {
  if (!count || count <= 1) return '';
  return `${count} 个`;
}

function regionToPlacement(region?: { x: number; y: number; width: number; height: number } | null): string {
  if (!region) return '';
  const cx = Math.min(Math.max(region.x + region.width / 2, 0), 1);
  const cy = Math.min(Math.max(region.y + region.height / 2, 0), 1);
  const horizontal = cx < 0.37 ? '画面左' : cx > 0.63 ? '画面右' : '画面中部';
  const vertical = cy < 0.37 ? '上部' : cy > 0.63 ? '下部' : '中部';
  const areaPct = Math.round(Math.min(Math.max(region.width * region.height, 0), 1) * 100);
  const areaText = areaPct >= 55 ? `占画面约 ${areaPct}%（特写占比）` : areaPct >= 25 ? `占画面约 ${areaPct}%` : areaPct >= 8 ? `占画面约 ${areaPct}%（中小主体）` : `占画面约 ${areaPct}%（远景小主体）`;
  return `位于${horizontal}${vertical === '中部' ? '' : vertical}，${areaText}`;
}

function buildSubjectSection(analysis: VisionAnalysis): string {
  const subjects = analysis.subjects ?? [];
  if (subjects.length === 0) return '';
  return subjects
    .map(subject => {
      const parts: string[] = [];
      const count = subjectCountText(subject.count);
      const core = joinParts([count, subject.label], '');
      parts.push(core || subject.label);
      if (subject.appearance?.length) parts.push(subject.appearance.join('，'));
      if (subject.clothing?.length) parts.push(`服装：${subject.clothing.join('、')}`);
      if (subject.pose) parts.push(`姿势：${subject.pose}`);
      if (subject.action) parts.push(`动作：${subject.action}`);
      if (subject.orientation) parts.push(`朝向：${subject.orientation}`);
      const placement = regionToPlacement(subject.position);
      if (placement) parts.push(placement);
      if (subject.relations?.length) parts.push(subject.relations.join('；'));
      return parts.join('，');
    })
    .join('；');
}

function buildActionSection(analysis: VisionAnalysis): string {
  const actions = (analysis.subjects ?? [])
    .map(s => [s.action, s.pose].filter(Boolean).join('，'))
    .filter(Boolean);
  if (actions.length === 0) return '';
  return actions.join('；');
}

function buildSceneSection(analysis: VisionAnalysis): string {
  const scene = analysis.scene ?? {};
  return joinParts([
    scene.environment,
    scene.location,
    scene.time_of_day,
    scene.weather,
    scene.foreground ? `前景：${scene.foreground}` : '',
    scene.background ? `背景：${scene.background}` : '',
  ]);
}

function buildCompositionSection(analysis: VisionAnalysis): string {
  const c = analysis.composition ?? {};
  const parts: string[] = [];
  if (c.subject_placement) parts.push(c.subject_placement);
  if (c.symmetry) parts.push(`构图对称性：${c.symmetry}`);
  if (c.rule_of_thirds === true) parts.push('三分法构图');
  if (c.horizon) parts.push(`地平线：${c.horizon}`);
  if (c.negative_space) parts.push(`留白：${c.negative_space}`);
  if (c.crop) parts.push(`裁切：${c.crop}`);
  if (c.depth_layers) parts.push(`层次：${c.depth_layers}`);
  // 对象位置（客体相对主体）
  const objectPlacements = (analysis.objects ?? [])
    .slice(0, 6)
    .map(obj => {
      const placement = regionToPlacement(obj.position);
      const count = subjectCountText(obj.count);
      return joinParts([count, obj.label, placement]);
    })
    .filter(Boolean);
  if (objectPlacements.length > 0) parts.push(`画面元素：${objectPlacements.join('；')}`);
  return parts.join('，');
}

function buildCameraSection(analysis: VisionAnalysis): string {
  const cam = analysis.camera ?? {};
  const parts = [
    cam.shot_type,
    cam.angle ? `机位：${cam.angle}` : '',
    cam.perspective ? `透视：${cam.perspective}` : '',
    cam.depth_of_field ? `景深：${cam.depth_of_field}` : '',
    cam.focal_length_estimate ? `焦段（推测）：${cam.focal_length_estimate}` : '',
    cam.lens_characteristics,
  ];
  return joinParts(parts);
}

function buildLightingSection(analysis: VisionAnalysis): string {
  const l = analysis.lighting ?? {};
  return joinParts([
    l.source,
    l.direction ? `方向：${l.direction}` : '',
    l.softness,
    l.key_fill_rim,
    l.contrast ? `光比：${l.contrast}` : '',
    l.time_of_day,
    l.exposure ? `曝光：${l.exposure}` : '',
  ]);
}

function buildColorSection(analysis: VisionAnalysis): string {
  const c = analysis.colors ?? {};
  const parts: string[] = [];
  if (c.dominant_palette?.length) parts.push(`主色调 ${c.dominant_palette.slice(0, 4).join(' ')}`);
  if (c.temperature) parts.push(c.temperature);
  if (c.saturation) parts.push(`饱和度${c.saturation}`);
  if (c.contrast) parts.push(`色彩对比${c.contrast}`);
  return parts.join('，');
}

function buildMaterialSection(analysis: VisionAnalysis): string {
  const materials = new Set<string>();
  for (const subject of analysis.subjects ?? []) {
    for (const item of subject.appearance ?? []) {
      if (/材质|质感|金属|玻璃|木|布|皮革|丝绸|拉丝/.test(item)) materials.add(item);
    }
  }
  if (analysis.style?.texture) materials.add(analysis.style.texture);
  return [...materials].slice(0, 6).join('，');
}

function buildStyleSection(analysis: VisionAnalysis): string {
  const s = analysis.style ?? {};
  const parts = [s.category, s.medium, s.rendering, s.photographic_characteristics];
  return joinParts(parts);
}

function buildDetailSection(analysis: VisionAnalysis): string {
  const details = [...(analysis.fine_details ?? [])];
  const texts = analysis.text_elements ?? [];
  if (texts.length > 0) {
    const textDesc = texts
      .slice(0, 4)
      .map(t => `「${t.content}」${t.style ? `（${t.style}）` : ''}${regionToPlacement(t.position)}`)
      .join('；');
    details.push(`画面文字：${textDesc}`);
  }
  return details.slice(0, 10).join('；');
}

/** 从分析推测比例/尺寸（结构信号缺失时给安全默认值） */
function recommendSize(analysis: VisionAnalysis): { aspectRatio: string; size: string } {
  const c = analysis.composition ?? {};
  const cam = analysis.camera ?? {};
  const wide = /横|宽|全景|风景|landscape|wide/i.test(
    `${c.subject_placement} ${c.crop} ${cam.shot_type}`,
  );
  const tall = /竖|全身|portrait|tower|高楼/i.test(`${c.subject_placement} ${c.crop} ${cam.shot_type}`);
  if (wide) return { aspectRatio: '16:9', size: '1792x1024' };
  if (tall) return { aspectRatio: '9:16', size: '1024x1792' };
  return { aspectRatio: '1:1', size: '1024x1024' };
}

const DEFAULT_NEGATIVE = '模糊，低清，畸变，多余肢体，错误文字，水印，噪点，过度锐化';

function buildNegative(analysis: VisionAnalysis): string {
  const extra: string[] = [];
  const texts = analysis.text_elements ?? [];
  if (texts.length === 0) extra.push('画面文字');
  const risks = analysis.generation_risks ?? [];
  if (risks.some(r => /人脸|肖像|identity/i.test(r))) extra.push('面部变形');
  return [DEFAULT_NEGATIVE, ...extra].join('，');
}

const SECTION_ORDER: (keyof PromptSections)[] = [
  'subject', 'action', 'scene', 'composition', 'camera', 'lighting', 'color', 'material', 'style', 'detail',
];

function assemblePrompt(sections: PromptSections, dialect: PromptDialect): string {
  const ordered: string[] = [];
  for (const key of SECTION_ORDER) {
    const value = sections[key]?.trim();
    if (value) ordered.push(value);
  }
  if (dialect === 'gpt_image') {
    // GPT Image 系：自然语言长句表现最好，分节以句号衔接
    return ordered.map(part => (/[。；]$/.test(part) ? part : `${part}。`)).join('');
  }
  // generic：逗号衔接（兼容多数扩散模型/中转）
  return ordered.join('，');
}

/**
 * 反向 Prompt 编译（唯一入口）。
 * sections 顺序固定：主体 → 动作 → 场景 → 构图 → 镜头 → 光线 → 色彩 → 材质 → 风格 → 细节。
 */
export function compileReversePrompt(
  analysis: VisionAnalysis,
  dialect: PromptDialect = 'generic',
): ReversePromptResult {
  const warnings: string[] = [];
  const sections: PromptSections = {
    subject: buildSubjectSection(analysis),
    action: buildActionSection(analysis),
    scene: buildSceneSection(analysis),
    composition: buildCompositionSection(analysis),
    camera: buildCameraSection(analysis),
    lighting: buildLightingSection(analysis),
    color: buildColorSection(analysis),
    material: buildMaterialSection(analysis),
    style: buildStyleSection(analysis),
    detail: buildDetailSection(analysis),
  };

  if (!sections.subject) warnings.push('分析未识别出明确主体，Prompt 以场景与风格为主 —— 建议换用视觉能力更强的模型重新分析。');
  if ((analysis.text_elements ?? []).length > 0) warnings.push('原图包含文字：纯 Prompt 复刻小字/logo 误差较大，属已知不可逆损失。');
  for (const risk of analysis.generation_risks ?? []) {
    if (risk.trim()) warnings.push(risk.trim());
  }

  const { aspectRatio, size } = recommendSize(analysis);

  return {
    prompt: assemblePrompt(sections, dialect),
    negativePrompt: buildNegative(analysis),
    sections,
    recommended: { aspectRatio, size, quality: 'auto' },
    risks: (analysis.generation_risks ?? []).filter(Boolean),
    warnings,
  };
}
