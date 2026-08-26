/**
 * Prompt Compiler（§15 / §16）—— 分层合同编译器（纯函数，零模型裁量）。
 *
 * 与优化器的分工（§14）：
 *  - Optimizer 只负责「把已确定的 Contract 表达成更好的生成语言」；
 *  - 本编译器负责把硬性合同（图片角色 / 人物替换 / 区域 / 媒介 / 服装 / 维度 /
 *    模板保留）确定性编译为文本块，置于优化产物**之前**——优化器输出无权
 *    覆盖这些块，gpt-image-2 收到的 prompt 一定携带全部合同语义。
 *
 * 分层（mergeFinalGenerationPrompt 按固定顺序装配）：
 *   【图片角色】→【人物替换】→【区域编辑】→【媒介结构】→【动漫角色一致性】→
 *   【细节插图同步】→【表情锁定】→【服装】→【修改动作】→【模板保留】→
 *   【最终画面描述】→【负面约束】
 */

import type { GenerationImageReference } from '../../../types';
import {
  buildGenerationImageDirective,
  type GenerationDirectiveInput,
} from '../generationDirective';
import { MODIFICATION_DIMENSION_LABELS as MODIFIED_DIMENSION_LABELS } from '../modificationIntent';
import {
  bindDetailInsertsToCharacter,
  detailInsertCropLabel,
  detailInsertExpressionClause,
  sentenceAllowsAnimeRedesign,
  validateFinalPromptAnimeConflict,
  type DetailInsertBinding,
} from './animeCharacter';
import { PERSON_REPLACE_SCOPE_LABELS, PERSON_STRENGTH_LABELS, personContractHasImage } from './personContract';
import { REGION_TYPE_LABELS, describeRectPosition } from './region';
import { IDENTITY_RELATION_LABELS, RENDERING_MODE_LABELS, singleMediaModeOf } from './rendering';
import { guardLockedDimensionsInDescription } from './lockedDimensionGuard';
import {
  clothingSourceIsPersonReference,
  extractTemplateClothingTokens,
  guardClothingInDescription,
  sanitizeClothingFromBaseline,
  validateFinalPromptClothingConflict,
} from './clothingGuard';
import {
  isPoseDimensionLocked,
  lockedExpressionDirective,
  subjectsWithExpression,
} from './subjectExpression';
import type {
  AnimeCharacterSnapshot,
  PersonReplacementContract,
  RegionPoseSnapshot,
  RegionReplacement,
  RenderingContract,
  VisualProject,
  VisualReferenceAsset,
} from './types';

/** 图片角色合同（复用既有确定性指令块：图片1/2… 职责 + 强制执行头）。 */
export function compileImageRoleContract(input: GenerationDirectiveInput): string {
  return buildGenerationImageDirective(input);
}

function ordinalOf(refs: ReadonlyArray<GenerationImageReference>, role: GenerationImageReference['role']): string {
  const index = refs.findIndex(ref => ref.role === role);
  return index >= 0 ? `图片${index + 1}` : '';
}

/**
 * 人物替换合同 V2（§7）：strength = Prompt 层约束等级（非模型百分比）。
 *  - strict：身份唯一主来源 = 人物参考；模板人物身份 / 五官 / 脸型 / 发型显式排除；
 *  - balanced：身份以人物参考为主，允许与模板人物自然融合（同一人的近似还原）；
 *  - natural：参考图只提供人物方向，允许生成模型自洽调整。
 */
export function compilePersonReplacementContract(input: {
  person: PersonReplacementContract;
  imageReferences: ReadonlyArray<GenerationImageReference>;
}): string {
  const { person } = input;
  const personOrdinal = ordinalOf(input.imageReferences, 'person_reference') || '人物身份参考图';
  const templateOrdinal = ordinalOf(input.imageReferences, 'template') || '画面模板图';
  const hasImage = personContractHasImage(person);
  const lines: string[] = ['【人物替换合同（强制执行）】'];

  const identitySource = hasImage
    ? `主体人物身份的唯一主来源是${personOrdinal}（人物身份参考）`
    : `主体人物按文字描述重建：${person.description?.trim() || '（未填写描述）'}`;
  lines.push(`身份来源：${identitySource}。`);

  const strengthLine = (() => {
    switch (person.strength) {
      case 'strict':
        return `${personOrdinal}中人物的脸部身份、五官比例、脸型、发型发色、眼神气质与整体外貌必须严格采用；`
          + `禁止从${templateOrdinal}提取或保留人物的脸部身份、五官、脸型、发型与人物外貌特征；`
          + `${templateOrdinal}仅负责画面布局、风格、背景与整体视觉参考。`;
      case 'balanced':
        return `人物身份以${personOrdinal}为主要参考，允许在保持可识别同一身份的前提下与画面整体风格自然衔接；`
          + `${templateOrdinal}原人物身份不作为身份来源。`;
      case 'natural':
      default:
        return `人物参考仅提供人物方向（外观类型 / 气质），生成模型可按整体画面自洽调整人物细节；不承诺保留参考图人物的具体面部特征。`;
    }
  })();
  lines.push(`约束等级：${PERSON_STRENGTH_LABELS[person.strength]}——${strengthLine}`);

  if (person.replaceScope === 'custom_region') {
    lines.push(`替换范围：仅在指定区域内执行人物替换（区域合同见区域编辑段）；区域外画面保持模板不变。`);
  } else {
    lines.push(`替换范围：${PERSON_REPLACE_SCOPE_LABELS[person.replaceScope]}（范围之外的身体与画面沿用模板 / 场景设定）。`);
  }

  if (person.applyIdentityTo === 'all_corresponding_subjects') {
    lines.push('身份应用：画面中所有与主体对应的人物（如镜面 / 分身 / 多姿态副本）均使用同一人物身份。');
  }

  // Reference Role Isolation（§25-§27）：人物参考只供应身份（与按服装合同的服装）
  if (hasImage) {
    lines.push(`人物参考边界：${personOrdinal}仅提供人物身份特征（及服装合同约定采用时的服装）；`
      + `其姿势、动作、身体朝向、观看角度、镜头、构图与背景一律不得采用——这些维度严格沿用${templateOrdinal}。`);
  }

  return lines.join('\n');
}

/** 区域合同（§9）：结构化空间指令；每区域一条职责行（mask 数据另经 API mask 部件传输）。 */
export function compileRegionContract(input: {
  regions: ReadonlyArray<RegionReplacement>;
  references: ReadonlyArray<VisualReferenceAsset>;
}): string {
  const regions = input.regions.filter(region => region.enabled);
  if (regions.length === 0) return '';
  const lines: string[] = [`【区域编辑合同（共 ${regions.length} 个区域）】`];
  regions.forEach((region, index) => {
    const position = region.shape.kind === 'rect'
      ? describeRectPosition(region.shape)
      : '画笔涂抹区域（透明 mask 之外的画面对应区域）';
    const typeText = REGION_TYPE_LABELS[region.replaceType];
    const ref = input.references.find(item => item.id === region.personReferenceId);
    const parts = [`区域${index + 1}（${region.name}）：位于${position}；用途=${typeText}；`];
    if (region.replaceType === 'person' && ref) {
      parts.push(`替换对象=@${ref.label}（人物身份以该参考为准）；`);
      if (region.replaceScope) parts.push(`范围=${PERSON_REPLACE_SCOPE_LABELS[region.replaceScope]}；`);
    }
    parts.push(`约束=${PERSON_STRENGTH_LABELS[region.constraintStrength]}；`);
    if (region.prompt?.trim()) parts.push(`附加要求：${region.prompt.trim()}；`);
    parts.push('区域外画面严格保持画面模板不变。');
    lines.push(`- ${parts.join('')}`);
  });
  return lines.join('\n');
}

/**
 * 媒介结构合同（§10 / §11）：混合媒介模板的核心修复块。
 * Identity != RenderingMode：每层声明「是谁 × 怎么画」；
 * overall style 修改只叠加油画方向（RENDERING_DIRECTION 注入），绝不改写各层模式。
 * 动漫主体的身份行在存在 Canonical Anime Character 时升级为「引用唯一角色卡」
 * （Person Identity ≠ Anime Character Design：关系描述不再交给模型自行动漫化）。
 * detail_insert 的同步指令由独立的【细节插图同步合同】承载（本层不再内联）。
 */
export function compileRenderingContract(input: {
  rendering: RenderingContract | null | undefined;
  styleDirection?: string;
  /** 服装来源 = 人物参考图 ⇒ 各媒介层服装只做媒介转换，不保留模板服装配饰。 */
  clothingFromPersonReference?: boolean;
  /** Canonical Anime Character（存在时动漫层身份行引用角色卡）。 */
  animeCharacter?: AnimeCharacterSnapshot | null;
  /** 非动漫插图（真人特写 / 图形贴纸）的表情基线来源。 */
  subjectPoses?: ReadonlyArray<RegionPoseSnapshot>;
  /** true = 逐实例同步已由【细节插图同步合同】承载（本层不再内联非动漫插图行；去重）。 */
  plainInsertsHandled?: boolean;
}): string {
  const { rendering } = input;
  if (!rendering) return '';
  const styleNote = input.styleDirection?.trim()
    ? `整体风格方向「${input.styleDirection.trim()}」只改变各层的风格化表达，绝不改变各层的媒介类型。`
    : '';
  const clothingConvertNote = input.clothingFromPersonReference
    ? '；服装基底同样来自人物参考图——本层只把该服装转换为本媒介的呈现方式（如真人服装 → 动漫化渲染），禁止恢复模板原服装、配饰与装饰件'
    : '';
  if (rendering.overallMode === 'mixed_media') {
    const lines: string[] = ['【媒介结构合同（混合媒介，强制执行）】'];
    if (rendering.regions.length > 0) {
      lines.push('本图由多种媒介层构成，各层必须保持自己的媒介类型，禁止整图统一成单一媒介：');
      rendering.regions.forEach((region, index) => {
        const isAnimeCharacterLayer = !!input.animeCharacter
          && region.renderingMode === 'anime_illustration'
          && (region.semanticRole === 'anime_counterpart'
            || region.semanticRole === 'secondary_subject');
        const identity = isAnimeCharacterLayer
          ? `动漫角色主体：引用唯一 Canonical Anime Character「${input.animeCharacter!.sourceSubjectLabel}」（该角色由人物身份参考${input.animeCharacter!.identitySource.kind === 'person_reference' ? ` @${input.animeCharacter!.identitySource.label}` : ''} + 本项目动漫媒介规则派生，并冻结为唯一角色设计实例；详见动漫角色一致性合同）`
          : region.identityRelation === 'same_as_primary'
            ? `与主体人物为同一人物（该层人物 = 主体人物以「${RENDERING_MODE_LABELS[region.renderingMode]}」媒介呈现的版本，不是另一个人）`
            : region.identityRelation === 'person_reference'
              ? '人物身份来自人物参考图'
              : region.identityRelation === 'template_identity'
                ? '沿用模板原身份设定'
                : '无特定身份约束';
        const layerClothingNote = (isAnimeCharacterLayer || region.identityRelation === 'same_as_primary')
          && input.clothingFromPersonReference
          ? clothingConvertNote
          : '';
        lines.push(`- 媒介层${index + 1}（${region.label}，${region.semanticRole}）：以${RENDERING_MODE_LABELS[region.renderingMode]}方式呈现；身份：${identity}${layerClothingNote}${region.description ? `；${region.description}` : ''}。`);
      });
    } else {
      lines.push('本图属于混合媒介作品（多种媒介并存），必须保持模板原有的媒介分层结构，禁止把整图统一成单一媒介。');
    }
    if (rendering.preserveTemplateMediaStructure) {
      lines.push('媒介结构沿用画面模板：模板中的真人层保持真人媒介、动漫层保持动漫媒介、平面元素保持平面设计媒介。');
    }
    if (!input.plainInsertsHandled) {
      lines.push(...compilePlainInsertBindings(rendering, input.subjectPoses ?? [], input.clothingFromPersonReference === true));
    }
    if (styleNote) lines.push(styleNote);
    return lines.join('\n');
  }
  const mode = singleMediaModeOf(rendering);
  if (mode === 'unknown') return '';
  return [
    '【媒介结构合同】',
    `本图为单一媒介作品：${RENDERING_MODE_LABELS[mode]}。全图保持该媒介的一致性。`,
    ...(input.plainInsertsHandled
      ? []
      : compilePlainInsertBindings(rendering, input.subjectPoses ?? [], input.clothingFromPersonReference === true)),
    ...(styleNote ? [styleNote] : []),
  ].join('\n');
}

/**
 * 非动漫 detail_insert（真人特写 / 图形贴纸）的基础镜像行：
 * 与所属主体同步身份 / 发型 / 色调（面部特写继承表情基线）。
 * 动漫插图不走这里——由【细节插图同步合同】以角色卡语义承载。
 */
function compilePlainInsertBindings(
  rendering: RenderingContract,
  subjectPoses: ReadonlyArray<RegionPoseSnapshot>,
  clothingFromPersonReference: boolean,
): string[] {
  const inserts = rendering.regions.filter(region =>
    region.semanticRole === 'detail_insert'
    && region.renderingMode !== 'anime_illustration'
    && region.mirrors && region.mirrors.length > 0);
  if (inserts.length === 0) return [];
  const targetOf = (role: string | undefined): RegionPoseSnapshot | undefined => {
    if (role === 'secondary_subject') {
      return subjectPoses.find(pose => pose.subjectRole === 'anime_counterpart')
        ?? subjectPoses.find(pose => pose.subjectRole === 'secondary_subject');
    }
    return subjectPoses.find(pose => pose.subjectRole === 'primary_subject');
  };
  const lines = ['局部插图同步（强制执行）：'];
  for (const insert of inserts) {
    const target = targetOf(insert.mirrorTargetRole);
    const aspects: string[] = [];
    const wants = (aspect: string) => insert.mirrors?.includes(aspect as never) ?? false;
    if (target) {
      const clothingText = wants('clothing')
        ? clothingFromPersonReference
          ? '、服装与主体一致（= 人物参考图服装在本插图媒介下的转换呈现，不采用模板服装）'
          : '、同一服装设定'
        : '';
      aspects.push(`与${target.label}为同一角色（同一身份、同一发型与色调${clothingText}）`);
      if (wants('facial_expression') && target.facialExpression?.trim()) {
        aspects.push(`表情必须延续${target.label}的同一表情基线：${lockedExpressionDirective(target)}`);
      }
    } else {
      aspects.push('与画面主体保持同一角色设定（同一身份、发型与色调）');
    }
    lines.push(`- ${insert.label}：${aspects.join('；')}；禁止绘制成另一个角色或另一种表情。`);
  }
  return lines;
}

/**
 * 【动漫角色一致性合同】—— Canonical Anime Character 的确定性编译。
 * 唯一角色卡：身份来源 / 发型 / 脸型 / 眼型 / 配饰 / 服装 / 表情逐项锁定；
 * V5：resolved facts 直接进入设计行（不再只有「看参考图」来源指示）；
 * Strict Visual Reference 模式：声明角色参考图（图片N）为全部动漫区域唯一
 * 视觉角色设计来源；动漫化边界 = 只改渲染媒介，绝不改身份/发型/刘海/发色/
 * 脸型/眼型/瞳色/服装设计/配饰（V5 §34）。
 */
export function compileAnimeCharacterContract(
  character: AnimeCharacterSnapshot | null | undefined,
  strictMode?: { animeReferenceOrdinal: string },
): string {
  if (!character) return '';
  const identityLabel = character.identitySource.kind === 'person_reference'
    ? `人物身份参考 @${character.identitySource.label ?? '人物参考图'}`
    : character.identitySource.kind === 'manual'
      ? `文字描述（${character.identitySource.label ?? '—'}）`
      : '模板原身份（未启用人物替换）';
  const designLines = [
    `- 发型：${character.hair.description}`,
    `- 脸型：${character.face.description}`,
    `- 眼睛：${character.eyes.description}`,
    `- 配饰：${character.accessories.description}`,
    `- 服装基底：${character.clothing.canonicalDescription}`,
  ];
  if (character.expression.description) {
    designLines.push(`- 表情基线：${character.expression.description}`);
  }
  return [
    '【动漫角色一致性合同（强制执行）】',
    `本图的动漫主角色「${character.sourceSubjectLabel}」是唯一 Canonical Anime Character（唯一动漫角色设计实例）：`,
    `- 身份来源：${identityLabel}${character.identitySource.kind === 'person_reference' ? '（动漫主角色与真人主体属于同一人物身份；这是身份关系，不是两套角色设计）' : ''}`,
    '- 角色设计（全部动漫层共用，任何一层不得单独改写）：',
    ...designLines,
    ...(strictMode
      ? [`- 视觉角色设计来源（强制）：${strictMode.animeReferenceOrdinal}（动漫角色参考图）是本图全部动漫区域唯一视觉角色设计来源——主动漫角色、次要动漫主体与全部动漫局部插图的外观一律以该图为准${character.identitySource.kind === 'person_reference' ? '（该参考图由人物身份参考派生生成）' : ''}；任何动漫层不得另行解释人物设计。`]
      : []),
    '- 同步规则：次要动漫主体与全部动漫局部插图（相框头像 / 眼部特写 / 发型特写等）必须复用上述同一角色设计——同一发型与刘海结构、同一卷度与发色、同一脸型、同一眼型与瞳色、同一服装基底与配饰。',
    '- 禁止事项：不得为任何动漫层重新设计新的刘海、发型、卷度、发色、脸型、眼型、瞳色、服装或配饰；禁止把人物身份参考图分别独立动漫化成多个不同版本；禁止恢复画面模板原动漫人物的身份特征（发型 / 脸型 / 眼型 / 原服装）。',
    '- 动漫化的边界：「动漫化」只改变渲染媒介、线条、阴影、材质与赛璐璐表现（真人 → 动漫插画），绝不改变身份、发型、刘海、发色、脸型、眼型、瞳色、服装设计或配饰。',
    '- 媒介呈现：动漫插画（' + character.rendering.styleDescription + '）。',
  ].join('\n');
}

/**
 * 【细节插图同步合同 V2】—— 逐实例（instance）确定性指令。
 * 一个画框 = 一个实例 = 一条指令行（Group 不再冒充 Instance，V5 §36）：
 *  - 动漫实例：instanceId / 位置 / 裁切类型 / characterRef / 锁定项 / 允许变化逐项输出；
 *  - 非动漫实例（真人特写 / 图形贴纸）：镜像所属主体（身份 / 发型 / 色调），
 *    绝不锁给动漫角色卡（V5 §37）。
 */
export function compileDetailInsertSyncContract(input: {
  bindings: ReadonlyArray<DetailInsertBinding>;
  character: AnimeCharacterSnapshot;
  subjectPoses?: ReadonlyArray<RegionPoseSnapshot>;
}): string {
  const { bindings, character } = input;
  if (bindings.length === 0) return '';
  const insertPoseOf = (label: string) => (input.subjectPoses ?? []).find(pose =>
    pose.subjectRole === 'detail_insert' && pose.label.includes(label));
  const animeBindings = bindings.filter(binding => binding.characterRef === character.id);
  const plainBindings = bindings.filter(binding => binding.characterRef !== character.id);
  const lines: string[] = [];
  if (animeBindings.length > 0) {
    lines.push('【细节插图同步合同（强制执行）】');
    lines.push(`画面中共 ${animeBindings.length} 个动漫局部插图（每个画框独立编号），全部引用动漫主角色「${character.sourceSubjectLabel}」的同一角色设计（Canonical Anime Character，instanceId 逐个对应）：`);
    animeBindings.forEach((binding, index) => {
      const expressionClause = binding.expressionPolicy === 'preserve_template_insert'
        ? (() => {
          const insertPose = insertPoseOf(binding.insertLabel);
          const baseline = insertPose?.facialExpression?.trim() || character.expression.description;
          return baseline
            ? `表情沿用该插图自身的模板表情基线（${baseline}），人物设计仍来自动漫主角色`
            : detailInsertExpressionClause({ label: binding.insertLabel, expressionPolicy: binding.expressionPolicy }, character);
        })()
        : detailInsertExpressionClause({ label: binding.insertLabel, expressionPolicy: binding.expressionPolicy }, character);
      const positionPart = binding.positionLabel ? `位于${binding.positionLabel}，` : '';
      lines.push(
        `- 插图 #${index + 1}（${positionPart}${binding.insertLabel}，${detailInsertCropLabel(binding.cropType)}，instanceId=${binding.instanceId}）：`
        + `与动漫主角色为同一角色设计实例——same character design、同一发型与刘海、同一发色与卷度、同一脸型、同一眼型与瞳色、同一服装基底与配饰；`
        + `${expressionClause}；`
        + `允许变化：${binding.allowedVariation.join('、')}（本插图只是对同一角色的局部展示）；`
        + `禁止：另画发型、重新设计刘海、改变发色、重塑脸型或眼型、更换服装基底或配饰。`,
      );
    });
    lines.push('禁止把任一局部插图绘制成另一个角色、另一套动漫人物设计或独立动漫化的新版本。');
  }
  if (plainBindings.length > 0) {
    lines.push(`非动漫局部插图（${plainBindings.length} 个，与动漫角色卡无关）：`);
    plainBindings.forEach((binding, index) => {
      const expressionClause = binding.expressionPolicy === 'preserve_template_insert'
        ? (() => {
          const insertPose = insertPoseOf(binding.insertLabel);
          return insertPose?.facialExpression?.trim()
            ? `表情沿用该插图自身的模板表情基线（${insertPose.facialExpression.trim()}）`
            : '';
        })()
        : '';
      const positionPart = binding.positionLabel ? `位于${binding.positionLabel}，` : '';
      lines.push(
        `- 插图 #${index + 1}（${positionPart}${binding.insertLabel}，${detailInsertCropLabel(binding.cropType)}）：`
        + '与画面主体人物为同一角色（同一身份、同一发型与色调、同一服装设定）'
        + `${expressionClause ? `；${expressionClause}` : ''}；禁止绘制成另一个人物或动漫角色。`,
      );
    });
  }
  return lines.join('\n');
}

/**
 * 表情锁定合同（表情分离不变量的高优先级编译层）：
 * 动作未修改 ⇒ 每个有表情基线的主体表情独立锁定；wink 类表情显式强化
 * （一只眼完全闭合 / 另一只眼睁开有神 / 禁止半眯弱化），置于风格描述之前，
 * 绝不被泛化描述冲淡。用户启用修改动作 = 显式解锁（本层缺省，不隐式漂移）。
 */
export function compileFacialExpressionContract(project: VisualProject): string {
  if (!isPoseDimensionLocked(project)) return '';
  const subjects = subjectsWithExpression(project);
  if (subjects.length === 0) return '';
  const lines = ['【表情锁定合同（强制执行）】以下主体的面部表情严格沿用画面模板基线，任何其它段落（含最终画面描述）都不得改写：'];
  for (const pose of subjects) {
    const role = POSE_ROLE_LABELS[pose.subjectRole] ?? pose.subjectRole;
    lines.push(`- ${pose.label}（${role}）：${lockedExpressionDirective(pose)}。`);
  }
  lines.push('表情锁定优先级高于风格与氛围描述：风格化处理（笔触 / 色调 / 材质）不得改变上述睁闭眼状态与表情结构。');
  return lines.join('\n');
}

/** 服装合同（复用 generationDirective 语义；单独成层供 Compiler 装配）。 */
export function compileClothingContract(input: {
  clothingPolicy: string;
  customClothing?: string;
  imageReferences: ReadonlyArray<GenerationImageReference>;
}): string {
  const personOrdinal = ordinalOf(input.imageReferences, 'person_reference') || '人物身份参考图';
  const templateOrdinal = ordinalOf(input.imageReferences, 'template') || '画面模板图';
  switch (input.clothingPolicy) {
    case 'use_subject_reference':
      return `【服装合同】服装 / 造型以${personOrdinal}（人物身份参考）为准（身份与服装都来自人物参考图；`
        + `仅采用服装本身——参考图人物的姿势、姿态、镜头与构图不得因此带入，这些仍以${templateOrdinal}为准）。`;
    case 'custom': {
      const custom = input.customClothing?.trim();
      return `【服装合同】服装 / 造型按自定义描述执行${custom ? `——${custom}` : ''}；人物身份仍必须来自${personOrdinal}。`;
    }
    case 'preserve_original':
    default:
      return `【服装合同】服装沿用${templateOrdinal}（画面模板）的服装；「沿用服装」仅限于服装本身，`
        + `绝不代表保留${templateOrdinal}的人物——人物身份、面部、发型仍必须来自${personOrdinal}（保留服装 ≠ 保留人物）。`;
  }
}

/** 修改动作合同（维度 must-change；沿用既有 dimensionDirectiveInstruction 语义的合同层重述）。 */
export function compileDimensionContract(activeDimensions: ReadonlyArray<string>): string {
  const labels: Record<string, string> = {
    pose: '动作', scene: '背景', camera: '镜头', style: '风格', clothing: '服装', subject: '人物',
  };
  const modified = activeDimensions.filter(key => key !== 'subject' && labels[key]);
  if (modified.length === 0) return '';
  return [
    '【修改动作合同】',
    `以下维度必须真实修改（不是可选项）：${modified.map(key => labels[key]).join('、')}；未列出的维度沿用画面模板。`,
  ].join('\n');
}

/** 主体角色中文标签（Region Pose 行展示）。 */
const POSE_ROLE_LABELS: Record<string, string> = {
  primary_subject: '主体',
  anime_counterpart: '动漫对应角色',
  secondary_subject: '次要主体',
  detail_insert: '细节特写',
};

/**
 * 模板保留合同（§16 + Dimension Lock §12/§13/§15）：
 *  - locked 维度文本直接取 templateSnapshot 冻结基线（Compiler 复制 canonical
 *    constraints，Optimizer / Final Description 无权另写一份）；
 *  - 动作锁定时升级为逐主体姿态锁定（混合媒介：真人层与动漫层各自姿态
 *    分别冻结，绝不只锁一个全局「动作」字符串）；
 *  - 末行声明唯一事实来源地位：占比 / 百分比 / 朝向 / 角度冲突描述一律无效。
 */
export function compileTemplatePreservationContract(input: {
  project: VisualProject;
  activeDimensions: ReadonlyArray<string>;
}): string {
  const templateLabel = input.project.sourceAsset.displayName?.trim() || '画面模板图';
  const snapshot = input.project.templateSnapshot;
  const modified = new Set(input.activeDimensions);
  const dims: Array<[string, string]> = [
    ['动作', snapshot?.action.originalValue ?? ''],
    ['背景', snapshot?.background.originalValue ?? ''],
    ['构图', snapshot?.composition.originalValue ?? ''],
    ['镜头', snapshot?.camera.originalValue ?? ''],
    ['风格', snapshot?.style.originalValue ?? ''],
    ['光线', snapshot?.lighting.originalValue ?? ''],
    ['色彩', snapshot?.color.originalValue ?? ''],
  ];
  const dimKeyToDimension: Record<string, string> = {
    动作: 'pose', 背景: 'scene', 构图: 'composition', 镜头: 'camera', 风格: 'style', 光线: 'lighting', 色彩: 'color',
  };
  const keep = dims.filter(([label]) => !modified.has(dimKeyToDimension[label] ?? ''));
  const lines: string[] = [`【模板保留合同】以下维度严格沿用${templateLabel}的分析基线：`];
  const poseLocked = isPoseDimensionLocked(input.project);
  const poseSnapshots = poseLocked ? (snapshot?.subjectPoses ?? []) : [];
  for (const [label, value] of keep) {
    if (label === '动作' && poseSnapshots.length > 0) continue; // 动作由逐主体姿态块表达
    lines.push(`- ${label}：${value || '（保持模板原样）'}`);
  }
  if (poseSnapshots.length > 0) {
    lines.push('- 动作（分主体锁定——每个主体保持各自的模板姿态、手势、表情、视线与朝向，禁止统一改动）：');
    for (const pose of poseSnapshots) {
      const role = POSE_ROLE_LABELS[pose.subjectRole] ?? pose.subjectRole;
      const details = [
        pose.poseDescription,
        pose.gesture ? `手势：${pose.gesture}` : '',
        pose.facialExpression ? `表情：${pose.facialExpression}` : '',
        pose.gaze ? `视线：${pose.gaze}` : '',
        pose.bodyOrientation ? `朝向：${pose.bodyOrientation}` : '',
      ].filter(Boolean).join('；');
      lines.push(`  - ${pose.label}（${role}）：${details}`);
    }
  }
  if (keep.length > 0) {
    lines.push('上列锁定维度是唯一事实来源：最终画面描述与生成结果不得引入与上述基线冲突的新描述（含新的占比、百分比、朝向、观看角度）。');
  }
  return lines.join('\n');
}

export interface CompileFinalPromptInput {
  project: VisualProject;
  /** 最终画面描述（优化器产物 / 原始复刻 Prompt）。 */
  finalDescription: string;
  negativePrompt?: string;
  /** 负面追加（人物替换模板身份排斥等，由 generationDirective 提供）。 */
  negativeAddendum?: string;
  imageReferences: ReadonlyArray<GenerationImageReference>;
  personReplacementEnabled: boolean;
  /** 风格方向（用户 style 修改文本；只影响媒介层的风格化表达）。 */
  styleDirection?: string;
  /** false = 区域合同不编译（Runtime Skill Center 停用「区域替换」技能的真实效果）。 */
  includeRegions?: boolean;
  /**
   * 完整 Prompt 手动覆盖（Prompt Editor「完整 Prompt」模式）：存在时直接提交、
   * 不再装配合同层（Submission Snapshot 冻结语义——用户编辑的就是最终产物）。
   */
  fullPromptOverride?: string;
}

export interface CompiledFinalPrompt {
  prompt: string;
  negativePrompt: string;
  /** 实际装配的合同层名（测试与调试锚点）。 */
  sections: string[];
  /** 各合同层完整文本（Runtime Skill Trace：Prompt 来源反查按段归属技能）。 */
  sectionBlocks: Array<{ name: string; text: string }>;
  /**
   * Dimension Lock §20 正文层守卫结果（发生拦截时存在）：
   * locked 维度的漂移句已被删除。锁定基线由【模板保留合同】承载——
   * 最终画面描述只描述 Delta（V5 §57：不再向手动描述段末追加动作基线）。
   */
  lockGuard?: {
    removedSentences: string[];
    guardedDimensions: string[];
  };
  /**
   * Clothing Source Guard 结果（服装来源 = 人物参考图时存在）：
   * 基线净化发生的合同层 + 最终画面描述被剥离的模板服装句。
   */
  clothingGuard?: {
    sanitizedSections: string[];
    removedSentences: string[];
  };
  /** Anime Character Guard 结果（存在动漫角色卡且发生拦截时）：最终画面描述被剥离的「许可第二套动漫设计」句。 */
  animeGuard?: {
    removedSentences: string[];
  };
  /** Prompt Deduplication V2：跨层重复被收敛的行（Trace 可见）。 */
  deduplication?: {
    removedLines: string[];
  };
  /** 装配后兜底校验（应恒为空；非空 = 生成门禁阻断）。 */
  clothingConflicts: string[];
  /** 动漫角色一致性兜底校验（应恒为空；非空 = 生成门禁阻断）。 */
  animeConflicts: string[];
}

/**
 * Prompt Deduplication V2（§53-§56）：跨合同层逐行去重——
 * 同一事实（如「人物参考是唯一来源」）在多个层完全重复出现时只保留首次；
 * 结构行（【…】标题、短列表标记）不参与，避免破坏层骨架。确定性、零模型裁量。
 */
function dedupePromptSections(sections: string[]): { sections: string[]; removedLines: string[] } {
  const seen = new Set<string>();
  const removedLines: string[] = [];
  const deduped = sections.map(block => {
    const lines = block.split('\n');
    const keptLines = lines.filter(line => {
      const trimmed = line.trim();
      // 结构行不去重：标题 / 短行 / 列表序号骨架
      if (trimmed.length < 12 || trimmed.startsWith('【') || /^[-•]\s*$/.test(trimmed)) return true;
      if (seen.has(trimmed)) {
        removedLines.push(trimmed);
        return false;
      }
      seen.add(trimmed);
      return true;
    });
    return keptLines.length === lines.length ? block : keptLines.join('\n');
  });
  return { sections: deduped, removedLines };
}

/**
 * 最终 Prompt 装配（§16 推荐结构 + V5 Compiler V2）：固定顺序合并全部合同层
 * + 最终画面描述 + 跨层句级去重。负面词单独走 negativePrompt（与既有
 * final_negative_prompt 提交管线一致，不拼进 prompt 正文）。输出直接进入
 * Generation Carry（promptCompiled=true，ImageStudio 不再二次前置指令）。
 * fullPromptOverride 存在（Prompt Editor「完整 Prompt」模式的手动编辑冻结）时
 * 直接提交该文本，不再装配（Submission Snapshot 冻结语义，V5 §59）。
 */
export function mergeFinalGenerationPrompt(input: CompileFinalPromptInput): CompiledFinalPrompt {
  const { project } = input;
  const person = project.modification.person?.enabled ? project.modification.person : null;
  const refs = input.imageReferences.filter(ref => ref.path?.trim());
  const sections: string[] = [];
  const sectionNames: string[] = [];
  const sectionBlocks: Array<{ name: string; text: string }> = [];
  let lockGuard: CompiledFinalPrompt['lockGuard'];
  let pendingAnimeGuard: CompiledFinalPrompt['animeGuard'];
  // Clothing Source Guard：服装来源 = 人物参考图 ⇒ 模板服装元素不得经任何通道回灌
  const clothingGuardActive = clothingSourceIsPersonReference(project);
  const clothingTokens = clothingGuardActive ? extractTemplateClothingTokens(project) : [];
  const sanitizedSections: string[] = [];
  const clothingRemovedSentences: string[] = [];
  const push = (name: string, block: string) => {
    if (!block) return;
    sections.push(block);
    sectionNames.push(name);
    sectionBlocks.push({ name, text: block });
  };
  const pushSanitized = (name: string, block: string) => {
    if (!block) return;
    if (!clothingGuardActive || clothingTokens.length === 0) {
      push(name, block);
      return;
    }
    const { text, removed } = sanitizeClothingFromBaseline(block, clothingTokens);
    if (removed.length === 0) {
      push(name, block);
      return;
    }
    sanitizedSections.push(name);
    push(name, `${text}\n（服装与配饰一律以人物参考图为准；模板原服装元素不保留）`);
  };

  // 完整 Prompt 手动覆盖：Submission Snapshot 冻结（用户编辑的即最终产物，
  // 系统不再二次拼接——边界与 UI 标注一致，V5 §58/§59）
  if (input.fullPromptOverride?.trim()) {
    const overridePrompt = input.fullPromptOverride.trim();
    return {
      prompt: overridePrompt,
      negativePrompt: [input.negativePrompt?.trim() ?? '', input.negativeAddendum?.trim() ?? '']
        .filter(Boolean).join('，'),
      sections: ['full_prompt_override'],
      sectionBlocks: [{ name: 'full_prompt_override', text: overridePrompt }],
      clothingConflicts: [],
      animeConflicts: [],
    };
  }

  push('image_role', compileImageRoleContract({
    imageReferences: refs,
    personReplacementEnabled: input.personReplacementEnabled,
    clothingPolicy: (project.modification.clothingPolicy as GenerationDirectiveInput['clothingPolicy']) ?? 'preserve_original',
    customClothing: project.modification.customClothing,
  }));

  if (person) push('person_replacement', compilePersonReplacementContract({ person, imageReferences: refs }));
  if (input.includeRegions !== false) {
    pushSanitized('region', compileRegionContract({ regions: project.regions, references: project.references }));
  }
  // Canonical Anime Character：混合媒介 + 动漫主体层 ⇒ 派生唯一角色卡并绑定全部实例
  const animeBinding = bindDetailInsertsToCharacter(project);
  // Strict Visual Reference：角色参考图已在 imageReferences（role=anime_character_reference）
  const animeRefOrdinal = ordinalOf(refs, 'anime_character_reference' as GenerationImageReference['role']);
  const strictMode = project.animeConsistency?.mode === 'strict_visual_reference' && animeRefOrdinal
    ? { animeReferenceOrdinal: animeRefOrdinal }
    : undefined;
  pushSanitized('rendering', compileRenderingContract({
    rendering: animeBinding?.rendering ?? project.renderingContract,
    styleDirection: input.styleDirection,
    clothingFromPersonReference: clothingGuardActive,
    animeCharacter: animeBinding?.character ?? null,
    subjectPoses: project.templateSnapshot?.subjectPoses ?? [],
    // 逐实例同步合同已覆盖全部插图实例（含非动漫）⇒ 媒介层不再内联插图行（去重）
    plainInsertsHandled: !!animeBinding,
  }));
  pushSanitized('anime_character', compileAnimeCharacterContract(animeBinding?.character, strictMode));
  pushSanitized('detail_insert_sync', animeBinding
    ? compileDetailInsertSyncContract({
      bindings: animeBinding.bindings,
      character: animeBinding.character,
      subjectPoses: project.templateSnapshot?.subjectPoses ?? [],
    })
    : '');
  // 表情分离锁定：动作未修改 ⇒ 表情独立高优先级锁定（wink 反稀释；先于风格 / 服装层）
  push('expression_lock', compileFacialExpressionContract(project));
  push('clothing', compileClothingContract({
    clothingPolicy: project.modification.clothingPolicy,
    customClothing: project.modification.customClothing,
    imageReferences: refs,
  }));
  push('dimension', compileDimensionContract(project.modification.activeDimensions));
  if (project.templateSnapshot) {
    pushSanitized('template_preservation', compileTemplatePreservationContract({
      project,
      activeDimensions: project.modification.activeDimensions,
    }));
  }
  if (input.finalDescription.trim()) {
    // §18/§19 + V5 §57：最终画面描述只承载「修改项」的创意表达（Delta）；
    // 锁定维度 canonical 描述唯一来源 = 【模板保留合同】——本段不追加动作基线。
    const guard = project.templateSnapshot
      ? guardLockedDimensionsInDescription({ description: input.finalDescription, project })
      : null;
    // Clothing Guard：模板服装元素在最终画面描述中同样逐句剥离
    const afterLock = guard ? guard.text : input.finalDescription.trim();
    const clothingGuardResult = clothingGuardActive && clothingTokens.length > 0
      ? guardClothingInDescription(afterLock, clothingTokens)
      : null;
    if (clothingGuardResult?.removedSentences.length) {
      clothingRemovedSentences.push(...clothingGuardResult.removedSentences);
    }
    // Anime Character Guard：最终画面描述不得许可「第二套动漫设计」
    // （如"如发色变紫、服饰细节增加"）——逐句剥离后再装配（§22/§32 修正后重新编译）
    let afterClothing = clothingGuardResult ? clothingGuardResult.text : afterLock;
    let animeGuard: CompiledFinalPrompt['animeGuard'];
    if (animeBinding) {
      const sentenceSplit = /(?<=[。！？!?；])|\n/;
      const kept: string[] = [];
      const removed: string[] = [];
      for (const line of afterClothing.split(sentenceSplit)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (sentenceAllowsAnimeRedesign(trimmed)) removed.push(trimmed);
        else kept.push(trimmed);
      }
      if (removed.length > 0) {
        afterClothing = kept.join('\n');
        animeGuard = { removedSentences: removed };
      }
    }
    const modifiedLabels = project.modification.activeDimensions
      .map(key => MODIFIED_DIMENSION_LABELS[key])
      .filter(Boolean);
    const scopeLine = project.templateSnapshot && modifiedLabels.length > 0
      ? `（本段仅描述修改项：${modifiedLabels.join('、')}；未列出的维度一律以上方【模板保留合同】的模板基线为准，本段不得重新描述这些维度）`
      : '';
    push('final_description', `【最终画面描述】${scopeLine}\n${afterClothing}`);
    if (guard && guard.removedSentences.length > 0) {
      lockGuard = {
        removedSentences: guard.removedSentences,
        guardedDimensions: guard.guardedDimensions,
      };
    }
    if (animeGuard) pendingAnimeGuard = animeGuard;
  }

  // Prompt Deduplication V2：跨层完全重复行只保留首次（sectionBlocks 保留原文供 Trace）
  const deduped = dedupePromptSections(sections);
  const finalSections = deduped.sections;

  const negativePrompt = [input.negativePrompt?.trim() ?? '', input.negativeAddendum?.trim() ?? '']
    .filter(Boolean)
    .join('，');

  // E4 兜底校验：装配后的最终 Prompt 不得再含模板服装令牌（阻断生成的依据）
  const clothingConflicts = clothingGuardActive
    ? validateFinalPromptClothingConflict(finalSections.join('\n\n'), clothingTokens)
    : [];
  // 动漫角色一致性兜底：装配后的最终 Prompt 不得许可独立动漫重设计（阻断生成的依据）
  const animeConflicts = animeBinding
    ? validateFinalPromptAnimeConflict(finalSections.join('\n\n'))
    : [];

  return {
    prompt: finalSections.join('\n\n'),
    negativePrompt,
    sections: sectionNames,
    sectionBlocks,
    ...(lockGuard ? { lockGuard } : {}),
    ...(clothingGuardActive && (sanitizedSections.length > 0 || clothingRemovedSentences.length > 0)
      ? { clothingGuard: { sanitizedSections, removedSentences: clothingRemovedSentences } }
      : {}),
    ...(pendingAnimeGuard ? { animeGuard: pendingAnimeGuard } : {}),
    ...(deduped.removedLines.length > 0
      ? { deduplication: { removedLines: deduped.removedLines } }
      : {}),
    clothingConflicts,
    animeConflicts,
  };
}
