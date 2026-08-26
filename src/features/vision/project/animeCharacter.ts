/**
 * Canonical Anime Character（动漫角色一致性合同）—— 唯一动漫角色卡。
 *
 * 三层概念铁律（Person Identity ≠ Anime Character Design ≠ Detail Insert Crop）：
 *  - 人物参考图只供应 Person Identity（是谁）；
 *  - 本模块把 Person Identity + 模板动漫媒介结构确定性地派生成唯一
 *    AnimeCharacterSnapshot（这个动漫角色长什么样），冻结为一个设计实例；
 *  - 所有动漫层（次要动漫主体 + 全部动漫 detail inserts）经 characterRef
 *    引用同一张卡；插图只做裁切（Crop），绝不各自重新执行 person → anime。
 *
 * 派生是纯函数（同一项目状态 → 同一张卡；幂等可重放），不调用任何模型。
 */

import { clothingSourceIsPersonReference } from './clothingGuard';
import { personContractHasImage } from './personContract';
import { deriveDetailInsertCropType, findAnimeSubjectRegion } from './rendering';
import { countInsertInstances, instancesOfRegion } from './detailInsert';
import type {
  AnimeCharacterSnapshot,
  CharacterFaceFacts,
  CharacterHairFacts,
  RegionPoseSnapshot,
  RenderingContract,
  RenderingRegion,
  VisualProject,
} from './types';

/** canonical 引用 id（常量；detail insert characterRef 一律指向它）。 */
export const CANONICAL_ANIME_CHARACTER_ID = 'canonical-anime-character';

/** 模板动漫主体的姿态基线（表情快照来源；anime_counterpart 优先）。 */
export function animeSubjectPose(project: VisualProject): RegionPoseSnapshot | undefined {
  const poses = project.templateSnapshot?.subjectPoses ?? [];
  const byLabel = (label: string) => poses.find(pose =>
    pose.label.replace(/[（）()\s]/g, '') && label.replace(/[（）()\s]/g, '')
    && (pose.label.replace(/[（）()\s]/g, '').includes(label.replace(/[（）()\s]/g, ''))
      || label.replace(/[（）()\s]/g, '').includes(pose.label.replace(/[（）()\s]/g, ''))));
  const animeRegion = findAnimeSubjectRegion(project.renderingContract?.regions ?? []);
  return (animeRegion ? byLabel(animeRegion.label) : undefined)
    ?? poses.find(pose => pose.subjectRole === 'anime_counterpart')
    ?? poses.find(pose => pose.subjectRole === 'secondary_subject');
}

/**
 * 派生 Canonical Anime Character（混合媒介且存在动漫主体层时才有卡）。
 * 人物替换绑定参考图 ⇒ 身份/发型/脸型/眼型/配饰全部绑定人物参考图
 * （动漫化只改变媒介呈现，绝不改变角色设计事实）；未替换 ⇒ 沿用模板动漫设计。
 */
export function deriveAnimeCharacterSnapshot(project: VisualProject): AnimeCharacterSnapshot | null {
  const rendering = project.renderingContract;
  if (rendering?.overallMode !== 'mixed_media') return null;
  const animeRegion = findAnimeSubjectRegion(rendering.regions);
  if (!animeRegion) return null;

  const person = project.modification.person;
  const hasPersonImage = !!person?.enabled && personContractHasImage(person);
  const personLabel = person?.source === 'description'
    ? (person.description?.trim() || '文字描述人物')
    : (person?.label?.trim() || '人物参考图');
  const identityFromPerson = hasPersonImage;
  const identityFromDescription = !!person?.enabled && !hasPersonImage;

  const templateDesignText = animeRegion.description?.trim()
    || `模板动漫主体「${animeRegion.label}」的原设计`;

  // V5 Resolved Facts：人物参考外貌快照有效（指纹匹配）⇒ 角色卡携带具体设计事实，
  // 不再只有「看参考图」的来源指示（Source Instruction ≠ Design Fact）。
  const appearance = referenceAppearanceMatches(project) ? project.referenceAppearance! : null;

  const attribute = (aspectLabel: string) => identityFromPerson
    ? {
      binding: 'person_reference' as const,
      description: `人物参考图 @${personLabel} 中的${aspectLabel}——长度 / 结构 / 颜色一律与参考图一致，仅做动漫媒介呈现，禁止重新设计`,
    }
    : {
      binding: 'template_subject' as const,
      description: identityFromDescription
        ? `按文字描述（${personLabel}）派生的${aspectLabel}，在动漫媒介下保持自洽`
        : `沿用${templateDesignText}的${aspectLabel}`,
    };

  const hairFacts: CharacterHairFacts | undefined = appearance?.hair;
  const faceFacts: CharacterFaceFacts | undefined = appearance?.face;
  const hair = hairFacts
    ? {
      ...attribute('发型（长度 / 卷度 / 刘海结构 / 发色）'),
      description: `${describeHairFacts(hairFacts)}（事实来源：人物参考图 @${personLabel}；动漫化只改媒介呈现，禁止改变上述任何一项）`,
      facts: hairFacts,
    }
    : attribute('发型（长度 / 卷度 / 刘海结构 / 发色）');
  const face = faceFacts
    ? {
      ...attribute('脸型与五官结构'),
      description: `${describeFaceFacts(faceFacts)}（事实来源：人物参考图 @${personLabel}；禁止任何动漫层重新设计）`,
      facts: faceFacts,
    }
    : attribute('脸型与五官结构');
  const eyes = faceFacts
    ? {
      ...attribute('眼睛设计（眼型 / 瞳色 / 睫毛）'),
      description: `${[
        faceFacts.eyeShape ? `眼型：${faceFacts.eyeShape}` : '',
        faceFacts.irisColor ? `瞳色：${faceFacts.irisColor}` : '',
        faceFacts.eyelashStyle ? `睫毛：${faceFacts.eyelashStyle}` : '',
      ].filter(Boolean).join(' · ')}（事实来源：人物参考图 @${personLabel}）`,
      facts: faceFacts,
    }
    : attribute('眼睛设计（眼型 / 瞳色 / 睫毛）');

  const clothingPolicy = project.modification.clothingPolicy;
  const templateClothingBaseline = project.templateSnapshot?.clothing.originalValue.trim();
  const clothing = identityFromPerson && clothingSourceIsPersonReference(project)
    ? {
      source: 'person_reference' as const,
      canonicalDescription: `人物参考图 @${personLabel} 服装的动漫媒介呈现（服装基底 = 参考图服装；禁止恢复模板原服装、配饰与装饰件）`,
    }
    : clothingPolicy === 'custom'
      ? {
        source: 'custom' as const,
        canonicalDescription: project.modification.customClothing.trim() || '（自定义服装描述待填写）',
      }
      : {
        source: 'template' as const,
        canonicalDescription: templateClothingBaseline || templateDesignText,
      };

  const pose = animeSubjectPose(project);
  const styleText = project.templateSnapshot?.style.originalValue.trim() || '动漫插画';

  return {
    id: CANONICAL_ANIME_CHARACTER_ID,
    sourceSubjectLabel: animeRegion.label,
    identitySource: identityFromPerson
      ? {
        kind: 'person_reference',
        label: personLabel,
        ...(person!.assetId ? { assetId: person!.assetId } : {}),
        ...(person!.path ? { path: person!.path } : {}),
      }
      : identityFromDescription
        ? { kind: 'manual', label: personLabel }
        : { kind: 'template', label: animeRegion.label },
    designSource: identityFromPerson ? 'derived_from_person_reference' : 'template_anime_design',
    hair,
    face,
    eyes,
    accessories: appearance?.accessories?.length
      ? {
        ...attribute('配饰'),
        description: `${appearance.accessories.join('、')}（事实来源：人物参考图 @${personLabel}）`,
      }
      : attribute('配饰'),
    clothing,
    expression: {
      policy: 'mirror_secondary',
      ...(pose?.facialExpression?.trim() ? { description: pose.facialExpression.trim() } : {}),
    },
    rendering: {
      mediaType: 'anime_illustration',
      styleDescription: styleText,
    },
    revision: project.revision,
  };
}

/** 发型事实 → 确定性中文短语（Resolved Facts 的展示与 Prompt 编译口径）。 */
export function describeHairFacts(facts: CharacterHairFacts): string {
  const lengthLabels: Record<CharacterHairFacts['length'], string> = {
    short: '短发', shoulder: '及肩', chest: '及胸', waist: '及腰', other: '',
  };
  const textureLabels: Record<CharacterHairFacts['texture'], string> = {
    straight: '直发', soft_wave: '微卷波浪', large_wave: '大波浪卷', curly: '卷曲', other: '',
  };
  const partingLabels: Record<CharacterHairFacts['parting'], string> = {
    center: '中分', left: '左分', right: '右分', none: '无分缝', other: '',
  };
  const bangsLabels: Record<CharacterHairFacts['bangs'], string> = {
    none: '无刘海', curtain: '八字/帘式刘海', side: '侧分刘海', full: '齐刘海', wispy: '空气/碎刘海', other: '',
  };
  return [
    facts.baseColor,
    lengthLabels[facts.length],
    textureLabels[facts.texture],
    partingLabels[facts.parting],
    bangsLabels[facts.bangs],
    facts.silhouetteDescription?.trim(),
  ].filter(Boolean).join(' · ');
}

/** 脸部事实 → 确定性中文短语。 */
export function describeFaceFacts(facts: CharacterFaceFacts): string {
  return [
    facts.shape ? `脸型：${facts.shape}` : '',
    facts.eyeShape ? `眼型：${facts.eyeShape}` : '',
    facts.irisColor ? `瞳色：${facts.irisColor}` : '',
    facts.eyelashStyle ? `睫毛：${facts.eyelashStyle}` : '',
  ].filter(Boolean).join(' · ');
}

/** 人物参考外貌快照是否对当前人物参考有效（指纹匹配 = 可复用）。 */
export function referenceAppearanceMatches(project: VisualProject): boolean {
  const snapshot = project.referenceAppearance;
  const person = project.modification.person;
  if (!snapshot || !person?.enabled || !personContractHasImage(person)) return false;
  return snapshot.fingerprint === referenceAppearanceFingerprint(person.assetId, person.path);
}

/** 人物参考指纹（assetId 优先；换图 = 指纹变化 = 快照过期重析）。 */
export function referenceAppearanceFingerprint(assetId?: string, path?: string): string {
  return JSON.stringify([assetId?.trim() ?? '', path?.trim() ?? '']);
}
/** 读取项目的 canonical 角色卡：持久化卡过期（revision 落后）或缺失时重新派生。 */
export function resolveAnimeCharacter(project: VisualProject): AnimeCharacterSnapshot | null {
  const persisted = project.animeCharacter;
  if (persisted && persisted.revision === project.revision && persisted.id === CANONICAL_ANIME_CHARACTER_ID) {
    return persisted;
  }
  return deriveAnimeCharacterSnapshot(project);
}

/** 实例级绑定（V5：一个画框 = 一个 instance = 一条绑定；Group 不再冒充 Instance）。 */
export interface DetailInsertBinding {
  /** 实例 id（region.id-ins-N；Prompt 合同 / Trace / 校验的稳定锚点）。 */
  instanceId: string;
  /** 组（媒介层）id。 */
  groupId: string;
  insertLabel: string;
  /** 实例自身媒介（anime_illustration / photorealistic / ...）。 */
  mediaType: RenderingRegion['renderingMode'];
  cropType: DetailInsertBindingCropType;
  /** 仅动漫实例：指向 canonical id；非动漫实例 = undefined（镜像所属主体）。 */
  characterRef?: string;
  mirrorTargetRole: RenderingRegion['mirrorTargetRole'];
  lockedAspects: string[];
  expressionPolicy: RenderingRegion['expressionPolicy'];
  /** 允许的变化（裁切 / 放大 / 构图框取）。 */
  allowedVariation: string[];
  /** 空间位置描述（bounds 存在时；Trace / 确认摘要展示用）。 */
  positionLabel?: string;
}

export type DetailInsertBindingCropType = NonNullable<RenderingRegion['cropType']> | 'body';

export interface AnimeCharacterBindingResult {
  /** 绑定后的媒介契约（动漫实例均带 characterRef；原契约不被就地修改）。 */
  rendering: RenderingContract;
  character: AnimeCharacterSnapshot;
  /** 全部实例绑定（动漫 + 非动漫；Prompt 合同逐实例输出）。 */
  bindings: DetailInsertBinding[];
}

const ASPECT_LABELS: Record<string, string> = {
  identity: '人物身份',
  hair: '发型（含刘海 / 卷度 / 发色）',
  face: '脸型',
  eyes: '眼型与瞳色',
  accessories: '配饰',
  clothing: '服装基底',
  facial_expression: '表情基线',
  gaze: '视线',
};

/** 同步维度 → 中文标签（Skill Trace / 溯源展示共用）。 */
export function detailInsertAspectLabel(aspect: string): string {
  return ASPECT_LABELS[aspect] ?? aspect;
}

const CROP_TYPE_LABELS: Record<DetailInsertBindingCropType, string> = {
  face: '面部特写',
  eyes: '眼部特写',
  hair: '发型特写',
  feet: '腿部 / 足部特写',
  clothing: '服装特写',
  expression: '表情特写',
  body: '身体 / 全身特写',
  other: '局部特写',
};

export function detailInsertCropLabel(cropType: DetailInsertBindingCropType | undefined): string {
  return cropType ? (CROP_TYPE_LABELS[cropType] ?? '局部特写') : '局部特写';
}

/** bounds → 空间位置描述（「左上 / 右下中部」；无 bounds = 层描述兜底）。 */
function describeInstancePosition(bounds: DetailInsertInstanceBounds | undefined): string | undefined {
  if (!bounds) return undefined;
  const horizontal = bounds.x + bounds.width / 2 < 0.37 ? '左'
    : bounds.x + bounds.width / 2 > 0.63 ? '右' : '中部';
  const vertical = bounds.y + bounds.height / 2 < 0.37 ? '上'
    : bounds.y + bounds.height / 2 > 0.63 ? '下' : '中';
  if (horizontal === '中部' && vertical === '中') return '画面中部';
  return `${horizontal}${vertical === '中' ? '' : vertical}部`.replace('部部', '部');
}

type DetailInsertInstanceBounds = { x: number; y: number; width: number; height: number };

const FACE_INSTANCE_PATTERN = /眼|目|面|脸|表情|wink/i;

/**
 * 把全部 detail insert 实例绑定到 canonical 角色卡（编译 / 校验 / 溯源共用）。
 * V5 实例级绑定：一个画框 = 一个 instance = 一条绑定（Group 不再冒充 Instance）——
 *  - 动漫实例（instance.mediaType = anime_illustration）⇒ characterRef = canonical id，
 *    锁定 identity / hair / face / eyes / accessories / clothing（面部眼部实例额外镜像表情视线）；
 *  - 非动漫实例（真人特写 / 图形贴纸）⇒ 不绑角色卡，镜像真人主体（按实例媒介分流，
 *    绝不为凑数把真人插图锁给动漫角色）。
 * 不完整层（多插图声明 + 实例缺失）不参与绑定，由 validateAnimeCharacterConsistency 阻断。
 */
export function bindDetailInsertsToCharacter(project: VisualProject): AnimeCharacterBindingResult | null {
  const character = resolveAnimeCharacter(project);
  const rendering = project.renderingContract;
  if (!character || rendering?.overallMode !== 'mixed_media') return null;

  const bindings: DetailInsertBinding[] = [];
  const regions: RenderingRegion[] = rendering.regions.map(region => {
    if (region.semanticRole !== 'detail_insert') return region;
    const resolution = instancesOfRegion(region);
    // 不完整层：实例缺失（多插图声明）——绑定层跳过，校验层阻断/提示 repair
    if (resolution.incomplete) {
      return { ...region, cropType: region.cropType ?? deriveDetailInsertCropType(region) };
    }
    const boundInstances: DetailInsertInstanceData[] = resolution.instances.map(instance => {
      const isAnimeInstance = instance.mediaType === 'anime_illustration';
      const isFaceInstance = FACE_INSTANCE_PATTERN.test(instance.label)
        || FACE_INSTANCE_PATTERN.test(instance.description ?? '');
      const mirrors = isAnimeInstance
        ? (isFaceInstance
          ? ['identity', 'facial_expression', 'gaze', 'hair', 'face', 'eyes', 'accessories', 'clothing']
          : ['identity', 'hair', 'face', 'eyes', 'accessories', 'clothing'])
        : isFaceInstance
          ? ['identity', 'facial_expression', 'gaze', 'hair']
          : ['identity', 'hair', 'clothing'];
      const expressionPolicy = isFaceInstance ? 'preserve_template_insert' : 'mirror_secondary';
      return {
        ...instance,
        mirrors,
        expressionPolicy,
        characterRef: isAnimeInstance ? character.id : undefined,
      };
    });
    // 组级字段同步（旧展示路径兼容）：任一动漫实例 ⇒ 组 characterRef 指向 canonical
    const hasAnimeInstance = boundInstances.some(instance => instance.characterRef === character.id);
    const boundRegion: RenderingRegion = {
      ...region,
      cropType: region.cropType ?? deriveDetailInsertCropType(region),
      instances: boundInstances.map(({ mirrors, expressionPolicy, characterRef, ...instance }) => ({
        ...instance,
        ...(characterRef ? { characterRef } : {}),
        ...(expressionPolicy ? { expressionPolicy } : {}),
      })),
      ...(hasAnimeInstance
        ? {
          characterRef: character.id,
          mirrors: ['identity', 'hair', 'face', 'eyes', 'accessories', 'clothing'],
          expressionPolicy: 'mirror_secondary' as const,
          mirrorTargetRole: 'secondary_subject' as const,
        }
        : {}),
    };
    for (const instance of boundInstances) {
      bindings.push({
        instanceId: instance.id,
        groupId: region.id,
        insertLabel: instance.label,
        mediaType: instance.mediaType,
        cropType: instance.cropType,
        ...(instance.characterRef ? { characterRef: instance.characterRef } : {}),
        mirrorTargetRole: instance.characterRef ? 'secondary_subject'
          : (instance.targetSubjectRole ?? 'primary_subject'),
        lockedAspects: instance.mirrors.map(aspect => detailInsertAspectLabel(aspect)),
        expressionPolicy: instance.expressionPolicy,
        allowedVariation: ['裁切范围', '放大倍率', '局部构图', '框体角度'],
        ...(describeInstancePosition(instance.bounds) ? { positionLabel: describeInstancePosition(instance.bounds)! } : {}),
      });
    }
    return boundRegion;
  });

  return { rendering: { ...rendering, regions }, character, bindings };
}

/** 绑定过程中的实例内部形态（mirrors / expressionPolicy 派生产物，不落库）。 */
type DetailInsertInstanceData = {
  id: string;
  groupId: string;
  mediaType: RenderingRegion['renderingMode'];
  cropType: DetailInsertBindingCropType;
  bounds?: DetailInsertInstanceBounds;
  targetSubjectRole?: 'primary_subject' | 'secondary_subject';
  label: string;
  description?: string;
  mirrors: string[];
  expressionPolicy: NonNullable<RenderingRegion['expressionPolicy']>;
  characterRef?: string;
};

/**
 * 动漫角色一致性校验（生成前硬门禁；错误文案一律用户语言，绝不暴露工程字段名）：
 *  - 有动漫主体层 ⇒ 必须能派生角色卡；
 *  - Analysis Validator（§7）：层声明多个插图但实例缺失 ⇒ 阻断（提示补充识别）；
 *  - 检测到的动漫插图实例数 vs 已同步数必须一致（§41：detectedAnimeInsertCount
 *    > boundAnimeInsertCount 不得放行）；
 *  - 每个动漫实例的绑定必须指向唯一角色卡；
 *  - Strict Visual Reference（§42）：模式开启 ⇒ 必须存在可复用角色参考图资产。
 * 返回空数组 = 通过；非空 = 阻断生成。
 */
export function validateAnimeCharacterConsistency(project: VisualProject): string[] {
  const rendering = project.renderingContract;
  if (rendering?.overallMode !== 'mixed_media') return [];
  if (!findAnimeSubjectRegion(rendering.regions)) return [];

  const bound = bindDetailInsertsToCharacter(project);
  if (!bound) {
    return ['模板包含动漫主体层，但无法构建动漫角色统一设定（媒介结构不完整）。'];
  }
  const errors: string[] = [];

  // §7/§40：实例不完整（多插图声明 + 实例缺失）——绝不静默放行
  const counts = countInsertInstances(rendering);
  for (const region of counts.incompleteRegions) {
    errors.push(`模板中的「${region.label}」包含多个局部插图，但尚未逐个识别（缺少每个画框的独立信息）。请在视觉方案中补充识别局部插图，再生成。`);
  }

  // §41：检测到的动漫插图数 vs 已同步绑定数
  const detectedAnime = counts.anime;
  const boundAnime = bound.bindings.filter(binding => binding.characterRef === bound.character.id).length;
  if (detectedAnime > 0 && boundAnime < detectedAnime) {
    errors.push(`还有 ${detectedAnime - boundAnime} 个动漫特写未建立与主动漫角色的同步关系，无法保证角色一致。请补充识别局部插图或重新分析模板。`);
  }

  // §42：实例绑定完整性 + 锁定维度
  for (const binding of bound.bindings) {
    if (binding.mediaType === 'anime_illustration') {
      if (binding.characterRef !== bound.character.id) {
        errors.push(`动漫特写「${binding.insertLabel}」尚未同步主动漫角色。`);
        continue;
      }
      const requiredLabels = ['identity', 'hair', 'face', 'eyes'].map(detailInsertAspectLabel);
      const missing = requiredLabels.filter(label => !binding.lockedAspects.includes(label));
      if (missing.length > 0) {
        errors.push(`动漫特写「${binding.insertLabel}」缺少锁定项：${missing.join('、')}。`);
      }
    }
  }

  if (project.animeCharacter && project.animeCharacter.id !== CANONICAL_ANIME_CHARACTER_ID) {
    errors.push('项目存在非规范动漫角色卡（一个修订只允许一个动漫角色统一设定）。');
  }

  // §42 Strict Visual Reference：模式开启 ⇒ 角色参考图资产必须存在且可复用
  const consistency = project.animeConsistency;
  if (consistency?.mode === 'strict_visual_reference') {
    const asset = consistency.characterAsset;
    if (!asset || !isCharacterAssetReusable(project)) {
      errors.push('已开启「动漫角色强一致性」，但动漫角色参考图尚未生成（或已过期）。请先生成角色参考图，再进行最终生成。');
    }
  }
  return errors;
}

// ===== Strict Visual Reference（角色参考图资产缓存与失效） =====

/**
 * 角色参考图缓存指纹：只包含「动漫角色视觉身份」输入（V5 §26/§27）——
 * 人物参考 + 已解析外貌事实 + 服装来源 + 自定义服装 + 动漫风格基线 + 统一媒介操作。
 * 动作 / 构图 / 背景 / 镜头绝不入指纹（改这些不重建角色参考图）。
 */
export function characterAssetFingerprint(project: VisualProject): string {
  const person = project.modification.person;
  const template = project.templateSnapshot;
  return JSON.stringify([
    person?.enabled ? (person.assetId?.trim() ?? person.path?.trim() ?? person.label?.trim() ?? '') : '',
    project.modification.clothingPolicy,
    project.modification.clothingPolicy === 'custom' ? project.modification.customClothing.trim() : '',
    template?.style.originalValue.trim() ?? '',
    template?.mediaStructure?.overallMode === 'single_media' ? (template.mediaStructure.singleMode ?? '') : '',
    project.renderingContract?.overallMode === 'single_media' ? (project.renderingContract.singleMode ?? '') : '',
    project.referenceAppearance ? JSON.stringify({
      hair: project.referenceAppearance.hair,
      face: project.referenceAppearance.face,
      accessories: project.referenceAppearance.accessories,
      clothing: project.referenceAppearance.clothing,
    }) : '',
    project.animeCharacter?.hair.facts ? JSON.stringify(project.animeCharacter.hair.facts) : '',
  ]);
}

/** 角色参考图资产是否可复用（指纹匹配 + 图片路径仍在）。 */
export function isCharacterAssetReusable(project: VisualProject): boolean {
  const asset = project.animeConsistency?.characterAsset;
  if (!asset?.localPath?.trim()) return false;
  return asset.fingerprint === characterAssetFingerprint(project);
}

/**
 * 表情策略描述（细节插图同步合同行）：preserve_template_insert 沿用插图自身
 * 表情基线；mirror_secondary 镜像动漫主角色表情；缺省按模板插入类型。
 */
export function detailInsertExpressionClause(
  insert: Pick<RenderingRegion, 'label' | 'expressionPolicy' | 'cropType'>,
  character: AnimeCharacterSnapshot,
): string {
  const policy = insert.expressionPolicy ?? 'mirror_secondary';
  if (policy === 'preserve_template_insert') {
    return '表情沿用模板中该插图自身的表情基线（如 wink 面部特写保持同一 wink）';
  }
  return character.expression.description
    ? `表情镜像动漫主角色（${character.expression.description}）`
    : '表情镜像动漫主角色';
}

/**
 * Prompt 级动漫一致性冲突检测（§22 / V5 §32-34）：
 * 捕捉**许可句**——「允许/可以 + 不同/重新设计」「举例性许可（如发色变紫、
 * 服饰细节增加）」「动漫化后可重新设计」等（实测来自优化器模型自由输出；
 * 合同自身使用禁止性表述，不会命中）。
 */
const ANIME_REDESIGN_PERMISSION_PATTERNS: RegExp[] = [
  /(?:可以|允许|可自由|自由)[^。；\n]{0,16}(?:不同|另行|重新设计|自定)[^。；\n]{0,10}(?:发型|刘海|脸型|眼型|瞳色|动漫|角色设计)/,
  /(?:不同|多个|各自)[^。；\n]{0,8}(?:动漫化版本|角色版本|发型版本)/,
  /可变化[^。；\n]{0,6}(?:刘海|发型|瞳色|角色细节|人物细节)/,
  // 举例性许可：如 发色变紫 / 服饰细节增加（括号举例 = 明示允许的第二套设计）
  /(?:如|例如|比如)[^。；\n]{0,20}(?:变紫|变金|变蓝|变红|变白|变浅|变深|染成|发色变|发型变)/,
  /(?:如|例如|比如)[^。；\n]{0,20}(?:服饰|服装|配饰|装饰|发色|发型|刘海|瞳色|脸型|眼型)[^。；\n]{0,8}(?:增加|增添|变化|调整|改变|更换)/,
  /(?:可以|可|允许|自由)[^。；\n]{0,8}(?:增加|增添|丰富)[^。；\n]{0,8}(?:服饰|服装|配饰|装饰)/,
  /(?:动漫化|二次元化)[^。；\n]{0,14}(?:重新设计|重新绘制|自由调整|自由发挥|可变化|可以变化|允许变化)/,
  /(?:可|可以|允许)[^。；\n]{0,10}(?:不同|另|另一|新)[^。；\n]{0,6}(?:刘海|发型|发色|脸型|眼型|瞳色|配饰)/,
];

/** 单句检测（命中 = 该句许可了第二套动漫设计，必须从最终 Prompt 剥离）。 */
export function sentenceAllowsAnimeRedesign(sentence: string): boolean {
  return ANIME_REDESIGN_PERMISSION_PATTERNS.some(pattern => pattern.test(sentence));
}

/** 整段检测（最终 Prompt 兜底校验；非空 = 阻断生成）。 */
export function validateFinalPromptAnimeConflict(prompt: string): string[] {
  const violations = prompt
    .split(/(?<=[。；!?！？])|\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(sentenceAllowsAnimeRedesign);
  return violations.map(line => `最终 Prompt 存在与动漫角色一致性合同冲突的描述：「${line.slice(0, 60)}」`);
}
