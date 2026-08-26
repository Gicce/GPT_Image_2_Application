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

import type { NormalizedRegion, VisionAnalysis } from '../../../types';
import type {
  DetailInsertCropType,
  DetailInsertInstance,
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
  /** V5 实例分离：detail_insert 层的实例清单（一个画框 = 一个 instance）。 */
  instances?: Array<{
    label?: string;
    crop_type?: string;
    media_type?: string;
    position?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    target_subject_role?: string;
    description?: string;
  }>;
}

/** 眼部 / 面部特写判别（detail_insert 表情镜像的条件；确定性关键词，非模型裁量）。 */
const FACE_INSERT_PATTERN = /眼|目|面|脸|表情|wink/i;

const CROP_TYPE_PATTERNS: Array<{ type: DetailInsertCropType; pattern: RegExp }> = [
  { type: 'eyes', pattern: /眼|目|wink/i },
  { type: 'expression', pattern: /表情/ },
  { type: 'hair', pattern: /发|刘海|卷发/i },
  { type: 'face', pattern: /面|脸|头/i },
  { type: 'feet', pattern: /脚|腿|鞋/i },
  { type: 'clothing', pattern: /服|衣|裙|装/i },
];

/** detail_insert 裁切类型（从标签确定性派生；判定不出 = other）。 */
export function deriveDetailInsertCropType(region: Pick<RenderingRegion, 'label' | 'description'>): DetailInsertCropType {
  const text = `${region.label} ${region.description ?? ''}`;
  for (const { type, pattern } of CROP_TYPE_PATTERNS) {
    if (pattern.test(text)) return type;
  }
  return 'other';
}

/**
 * 混合媒介中的动漫主体层（Canonical Anime Character 的来源层）：
 * anime_counterpart 优先；模型把动漫角色标为 secondary_subject 时按
 * renderingMode=anime_illustration 兜底识别——否则动漫插图会错误镜像真人主体
 * （GUI 验收缺陷：相框头像跟随了真人而非动漫主角色）。
 */
export function findAnimeSubjectRegion(
  regions: ReadonlyArray<RenderingRegion>,
): RenderingRegion | undefined {
  return regions.find(region => region.semanticRole === 'anime_counterpart')
    ?? regions.find(region =>
      region.semanticRole === 'secondary_subject' && region.renderingMode === 'anime_illustration');
}

/**
 * detail_insert 绑定派生：局部插图与所属主体共享基线——
 * 动漫插图引用 Canonical Anime Character（identity / hair / face / eyes /
 * accessories / clothing 全锁定，眼部面部插图额外镜像表情与视线）；
 * 非动漫插图（真人特写 / 图形元素）镜像所属主体 identity + hair + clothing。
 * 目标主体：动漫对应角色优先（含 secondary_subject 动漫层），否则主体人物。
 */
function deriveInsertMirrors(
  regions: ReadonlyArray<RenderingRegion>,
): void {
  const animeTarget = findAnimeSubjectRegion(regions);
  const primaryTarget = regions.find(region => region.semanticRole === 'primary_subject');
  for (const region of regions) {
    if (region.semanticRole !== 'detail_insert') continue;
    const cropType = deriveDetailInsertCropType(region);
    const isFaceInsert = FACE_INSERT_PATTERN.test(region.label) || FACE_INSERT_PATTERN.test(region.description ?? '');
    const isAnimeInsert = region.renderingMode === 'anime_illustration';
    if (isAnimeInsert) {
      region.mirrors = isFaceInsert
        ? ['identity', 'facial_expression', 'gaze', 'hair', 'face', 'eyes', 'accessories', 'clothing']
        : ['identity', 'hair', 'face', 'eyes', 'accessories', 'clothing'];
      region.expressionPolicy = isFaceInsert ? 'preserve_template_insert' : 'mirror_secondary';
    } else {
      region.mirrors = isFaceInsert
        ? ['identity', 'facial_expression', 'gaze', 'hair']
        : ['identity', 'hair', 'clothing'];
    }
    region.cropType = cropType;
    // 动漫插图跟随动漫主角色；非动漫插图跟随真人主体（按插图媒介分流）
    const insertTarget = isAnimeInsert && animeTarget ? animeTarget : (primaryTarget ?? animeTarget);
    if (insertTarget) {
      region.mirrorTargetRole = insertTarget === animeTarget ? 'secondary_subject' : 'primary_subject';
    }
  }
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

/** 实例裁切类型归一（face/eyes/hair/expression/clothing/feet/body；判定不出 = other）。 */
function normalizeInstanceCropType(raw: string | undefined, label: string, description: string): DetailInsertCropType | 'body' {
  const value = (raw || '').trim().toLowerCase();
  if (['face', 'eyes', 'hair', 'expression', 'clothing', 'feet', 'body'].includes(value)) {
    return value as DetailInsertCropType | 'body';
  }
  const text = `${label} ${description}`;
  if (/身体|全身|半身/.test(text)) return 'body';
  return deriveDetailInsertCropType({ label, description });
}

/** bounds 归一（0..1 clamp；缺字段 = undefined，绝不发明坐标）。 */
type AnalysisInstancePosition = NonNullable<AnalysisMediaStructureRegion['instances']>[number]['position'];
function normalizeInstanceBounds(raw: AnalysisInstancePosition): NormalizedRegion | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const clamp01 = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;
  const x = clamp01(raw.x);
  const y = clamp01(raw.y);
  const width = clamp01(raw.width);
  const height = clamp01(raw.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  return { x, y, width, height };
}

/**
 * 模型直出实例归一（V5 §5：实例数量与位置一律来自结构化响应）。
 * 无效条目（无 label 且无 bounds 且无 crop 信号）丢弃，绝不补造。
 */
function normalizeRegionInstances(
  regionId: string,
  rawInstances: AnalysisMediaStructureRegion['instances'],
  region: AnalysisMediaStructureRegion,
): DetailInsertInstance[] {
  if (!Array.isArray(rawInstances)) return [];
  const instances: DetailInsertInstance[] = [];
  rawInstances.forEach((raw, index) => {
    const label = (raw.label ?? '').trim() || `插图实例 ${index + 1}`;
    const description = (raw.description ?? '').trim();
    const bounds = normalizeInstanceBounds(raw.position);
    const mediaType = normalizeRenderingMode(raw.media_type) ?? normalizeRenderingMode(region.rendering_mode) ?? 'unknown';
    const cropType = normalizeInstanceCropType(raw.crop_type, label, description);
    const targetRaw = (raw.target_subject_role ?? '').trim().toLowerCase();
    const targetSubjectRole: DetailInsertInstance['targetSubjectRole'] | undefined =
      targetRaw === 'primary_subject' || targetRaw === 'secondary_subject' ? targetRaw : undefined;
    // 有效实例判定：至少有 label 语义（描述/裁切信号）或空间锚点之一
    if (!description && !bounds && cropType === 'other' && label === `插图实例 ${index + 1}`) return;
    instances.push({
      id: `${regionId}-ins-${index + 1}`,
      groupId: regionId,
      mediaType,
      cropType,
      ...(bounds ? { bounds } : {}),
      ...(targetSubjectRole ? { targetSubjectRole } : {}),
      label,
      ...(description ? { description } : {}),
    });
  });
  return instances;
}

/** objects 里像「独立插图框」的条目（label 命中插图/相框/头像/特写词且带位置）。 */
const OBJECT_INSERT_PATTERN = /插图|相框|头像|特写|画框|拼贴|插画风|局部/;

/**
 * objects 本地展开兜底（V5 §8：响应已含空间信息时不追加 AI 调用）：
 * 模型没给 instances、但 objects 清单里存在带位置的插图类客体 ⇒ 展开为实例。
 */
function expandInstancesFromObjects(
  regionId: string,
  region: AnalysisMediaStructureRegion,
  analysis: VisionAnalysis,
): DetailInsertInstance[] {
  const candidates = (analysis.objects ?? []).filter(object =>
    object.position && OBJECT_INSERT_PATTERN.test(object.label ?? ''));
  if (candidates.length === 0) return [];
  return candidates.map((object, index) => {
    const label = (object.label ?? '').trim() || `插图实例 ${index + 1}`;
    const attributes = (object.attributes ?? []).join('；');
    const bounds = object.position ?? undefined;
    return {
      id: `${regionId}-ins-${index + 1}`,
      groupId: regionId,
      // objects 通道无法区分实例媒介 ⇒ 沿用层媒介（宁可保守，不由编译器猜）
      mediaType: normalizeRenderingMode(region.rendering_mode) ?? 'unknown',
      cropType: normalizeInstanceCropType(undefined, label, attributes),
      ...(bounds ? { bounds } : {}),
      label,
      ...(attributes ? { description: attributes } : {}),
    };
  });
}

/**
 * 从视觉分析派生媒介契约（模板快照冻结时调用一次）。
 * 优先使用模型返回的 media_structure（新协议）；缺失时按 style 推断（§12 兜底）：
 * mixed_media → regions 按模型清单（缺清单时保留混合事实、不伪造层细节）；
 * 其余 → single_media + singleMode + 空 regions。
 * V5：detail_insert 层附带实例清单（模型直出 instances 优先；缺省时 objects
 * 空间信息本地展开；两者皆无 = 空清单，由 detailInsert 校验层标记不完整）。
 */
export function deriveRenderingContract(analysis: VisionAnalysis): RenderingContract {
  const media = (analysis as VisionAnalysis & { media_structure?: AnalysisMediaStructure }).media_structure;
  const modelRegions = Array.isArray(media?.regions) ? media!.regions! : [];
  const normalizedModelRegions: RenderingRegion[] = modelRegions
    .map((region, index): RenderingRegion | null => {
      const mode = normalizeRenderingMode(region.rendering_mode);
      if (!mode || mode === 'mixed_media') return null;
      const id = `render-${index + 1}`;
      const semanticRole = normalizeSemanticRole(region.semantic_role);
      let instances: DetailInsertInstance[] | undefined;
      if (semanticRole === 'detail_insert') {
        const direct = normalizeRegionInstances(id, region.instances, region);
        instances = direct.length > 0 ? direct
          : expandInstancesFromObjects(id, region, analysis);
      }
      return {
        id,
        label: region.label?.trim() || `媒介层 ${index + 1}`,
        semanticRole,
        renderingMode: mode,
        identityRelation: normalizeIdentityRelation(region.identity_relation),
        ...(region.description?.trim() ? { description: region.description.trim() } : {}),
        ...(instances && instances.length > 0 ? { instances } : {}),
      };
    })
    .filter((region): region is RenderingRegion => region !== null);

  const distinctModes = [...new Set(normalizedModelRegions.map(region => region.renderingMode))];
  const isMixed = media?.overall_mode === 'mixed_media' || distinctModes.length >= 2;

  if (isMixed) {
    deriveInsertMirrors(normalizedModelRegions);
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
