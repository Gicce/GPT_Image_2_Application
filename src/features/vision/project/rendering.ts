/**
 * Hybrid Media Rendering Contract（§10 / §11 / §12）—— 媒介结构契约。
 *
 * Identity != RenderingMode：人物参考决定「是谁」，本契约决定「怎么画」。
 * 「真人 + 动漫」混合媒介模板被整图动漫化的历史缺陷，正是在这里修复：
 *  - overall style 修改（如"赛博朋克"）只改各层的风格化方向，
 *    绝不覆写任何 RenderingRegion.renderingMode（Style != Rendering Mode）；
 *  - 动漫对应角色的 identityRelation = same_as_primary：
 *    使用主人物（= person reference）的动漫化版本，而不是另一个人；
 *  - 只有用户显式「全部变成动漫」才允许统一媒介（applyUniformRenderingMode）。
 *
 * 派生兜底（§12）：分析结果缺 media_structure 时从 style 维度确定性推断，
 * 绝不强行把所有图都判成 mixed media（纯照片 → single photorealistic；
 * 纯动漫 → single anime）。
 */

import type { VisionAnalysis } from '../../../types';
import type {
  IdentityRelation,
  RenderingContract,
  RenderingMode,
  RenderingRegion,
  RenderingSemanticRole,
} from './types';

export const RENDERING_MODE_LABELS: Record<RenderingMode, string> = {
  photorealistic: '真人摄影',
  anime_illustration: '动漫插画',
  illustration: '插画',
  '3d_render': '3D 渲染',
  graphic_design: '平面设计',
  mixed_media: '混合媒介',
  unknown: '未识别媒介',
};

export const IDENTITY_RELATION_LABELS: Record<IdentityRelation, string> = {
  template_identity: '沿用模板身份',
  person_reference: '人物参考身份',
  same_as_primary: '与主体同一人物',
  none: '无身份约束',
};

/** 分析 schema 的可选 media_structure 字段（新协议；旧模型缺失 = undefined）。 */
export interface AnalysisMediaStructureRegion {
  label?: string;
  semantic_role?: string;
  rendering_mode?: string;
  identity_relation?: string;
  description?: string;
}

export interface AnalysisMediaStructure {
  overall_mode?: string;
  preserve_template_media_structure?: boolean;
  regions?: AnalysisMediaStructureRegion[];
}

function normalizeRenderingMode(raw: string | undefined): RenderingMode | undefined {
  const value = (raw || '').trim().toLowerCase();
  if (!value) return undefined;
  if (['photorealistic', 'photo', 'photograph', 'photography', 'realistic'].includes(value)) return 'photorealistic';
  if (['anime_illustration', 'anime', 'manga', 'animation'].includes(value)) return 'anime_illustration';
  if (['illustration', 'drawing'].includes(value)) return 'illustration';
  if (['3d_render', '3d', 'render', 'cgi'].includes(value)) return '3d_render';
  if (['graphic_design', 'graphic', 'poster', 'typography'].includes(value)) return 'graphic_design';
  if (['mixed_media', 'mixed', 'collage', 'hybrid'].includes(value)) return 'mixed_media';
  return undefined;
}

function normalizeSemanticRole(raw: string | undefined): RenderingSemanticRole {
  const value = (raw || '').trim().toLowerCase();
  if (['primary_subject', 'main_subject', 'subject'].includes(value)) return 'primary_subject';
  if (['secondary_subject', 'supporting_subject'].includes(value)) return 'secondary_subject';
  if (['anime_counterpart', 'anime_character', 'cartoon_counterpart'].includes(value)) return 'anime_counterpart';
  if (['detail_insert', 'insert'].includes(value)) return 'detail_insert';
  if (['background', 'environment'].includes(value)) return 'background';
  if (['graphic_decoration', 'decoration', 'graphic_element'].includes(value)) return 'graphic_decoration';
  return 'detail_insert';
}

function normalizeIdentityRelation(raw: string | undefined): IdentityRelation {
  const value = (raw || '').trim().toLowerCase();
  if (['person_reference', 'reference_person'].includes(value)) return 'person_reference';
  if (['same_as_primary', 'same_person', 'counterpart_of_primary'].includes(value)) return 'same_as_primary';
  if (['template_identity', 'template', 'original'].includes(value)) return 'template_identity';
  return 'none';
}

/**
 * 从分析 style 维度文本确定性推断媒介（关键词命中；不命中 = unknown）。
 * 「动漫插画」「动漫手绘」是同一媒介（anime 的常见 medium 表述），
 * 插画 / 手绘关键词在动漫已命中时不再重复计数。
 */
export function inferRenderingModeFromStyle(style: VisionAnalysis['style']): RenderingMode {
  const text = [style.category, style.medium, style.rendering]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!text) return 'unknown';
  const isPhoto = /照片|摄影|写实|真人|photograph|photoreal|realistic/.test(text);
  const isAnime = /动漫|二次元|漫画|anime|manga|cartoon/.test(text);
  const is3d = /3d|三维|渲染引擎/.test(text);
  const isIllustration = !isAnime && /插画|手绘|illustration|drawing/.test(text);
  const isGraphic = /拼贴|collage|平面设计|版式|typograph|graphic[_ ]?design/.test(text);
  const hits = [isPhoto, isAnime, is3d, isIllustration, isGraphic].filter(Boolean).length;
  if (hits >= 2) return 'mixed_media';
  if (isPhoto) return 'photorealistic';
  if (isAnime) return 'anime_illustration';
  if (is3d) return '3d_render';
  if (isIllustration) return 'illustration';
  if (isGraphic) return 'graphic_design';
  return 'unknown';
}

/**
 * 从视觉分析派生媒介契约（模板快照冻结时调用一次）。
 * 优先使用模型返回的 media_structure（新协议）；缺失时按 style 推断（§12 兜底）：
 * mixed_media → regions 按模型清单（缺清单时保留混合事实、不伪造层细节）；
 * 其余 → single_media + singleMode + 空 regions。
 */
export function deriveRenderingContract(analysis: VisionAnalysis): RenderingContract {
  const media = (analysis as VisionAnalysis & { media_structure?: AnalysisMediaStructure }).media_structure;
  const modelRegions = Array.isArray(media?.regions) ? media!.regions! : [];
  const normalizedModelRegions: RenderingRegion[] = modelRegions
    .map((region, index): RenderingRegion | null => {
      const mode = normalizeRenderingMode(region.rendering_mode);
      if (!mode || mode === 'mixed_media') return null;
      return {
        id: `render-${index + 1}`,
        label: region.label?.trim() || `媒介层 ${index + 1}`,
        semanticRole: normalizeSemanticRole(region.semantic_role),
        renderingMode: mode,
        identityRelation: normalizeIdentityRelation(region.identity_relation),
        ...(region.description?.trim() ? { description: region.description.trim() } : {}),
      };
    })
    .filter((region): region is RenderingRegion => region !== null);

  const distinctModes = [...new Set(normalizedModelRegions.map(region => region.renderingMode))];
  const isMixed = media?.overall_mode === 'mixed_media' || distinctModes.length >= 2;

  if (isMixed) {
    return {
      overallMode: 'mixed_media',
      preserveTemplateMediaStructure: media?.preserve_template_media_structure !== false,
      // 模型未给出可用分层清单时 regions 为空：保留「混合媒介」事实，不伪造层细节
      regions: normalizedModelRegions,
    };
  }

  const singleMode = normalizedModelRegions[0]?.renderingMode ?? inferRenderingModeFromStyle(analysis.style);
  return {
    overallMode: 'single_media',
    singleMode,
    preserveTemplateMediaStructure: true,
    regions: [],
  };
}

/** 单一媒介渲染模式（single_media 时的事实源；mixed_media / 缺省 → unknown）。 */
export function singleMediaModeOf(contract: RenderingContract | null | undefined): RenderingMode {
  if (!contract) return 'unknown';
  if (contract.overallMode !== 'single_media') return 'unknown';
  return contract.singleMode ?? 'unknown';
}

/** 持久化 / 输入合法化：字段形状与枚举校验（缺省 → undefined 由调用方重建）。 */
export function validateRenderingContract(contract: RenderingContract | null | undefined): string[] {
  if (!contract) return [];
  const errors: string[] = [];
  if (contract.overallMode !== 'single_media' && contract.overallMode !== 'mixed_media') {
    errors.push('媒介结构 overallMode 非法。');
  }
  if (contract.overallMode === 'single_media' && contract.regions.length > 0) {
    errors.push('单一媒介契约不允许携带媒介层清单。');
  }
  if (contract.overallMode === 'mixed_media' && contract.regions.length > 0) {
    const modes = new Set(contract.regions.map(region => region.renderingMode));
    if (modes.size < 2) errors.push('混合媒介契约的层清单必须包含至少两种渲染模式。');
  }
  const seenIds = new Set<string>();
  for (const region of contract.regions) {
    if (!region.id) errors.push('媒介层缺少 id。');
    if (seenIds.has(region.id)) errors.push(`媒介层 id 重复：${region.id}。`);
    seenIds.add(region.id);
    if (!RENDERING_MODE_LABELS[region.renderingMode]) errors.push(`媒介层 ${region.label} 的渲染模式非法。`);
  }
  return errors;
}

/**
 * 用户显式「全部变成动漫」等统一媒介操作（唯一允许改写渲染模式的入口）。
 * mode='mixed_media' 非法（统一 = 单一媒介）；调用后 preserveTemplateMediaStructure=false
 * （用户已显式放弃模板媒介结构）。
 */
export function applyUniformRenderingMode(_contract: RenderingContract, mode: RenderingMode): RenderingContract {
  if (mode === 'mixed_media' || mode === 'unknown') {
    return { overallMode: 'single_media', singleMode: 'unknown', preserveTemplateMediaStructure: true, regions: [] };
  }
  return { overallMode: 'single_media', singleMode: mode, preserveTemplateMediaStructure: false, regions: [] };
}

/**
 * 风格修改（如"赛博朋克"）应用到媒介契约：风格只表达「各层如何风格化」，
 * 绝不改写 renderingMode / identityRelation / overallMode（§11 铁律）。
 * 契约本身不变，返回原引用（Prompt Compiler 在各层描述上叠加风格方向）。
 */
export function applyStyleDirection(contract: RenderingContract, _styleDirection: string): RenderingContract {
  return contract;
}
