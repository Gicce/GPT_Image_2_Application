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
 *   【图片角色】→【人物替换】→【区域编辑】→【媒介结构】→【修改动作】→
 *   【模板保留】→【最终画面描述】→【负面约束】
 */

import type { GenerationImageReference } from '../../../types';
import {
  buildGenerationImageDirective,
  type GenerationDirectiveInput,
} from '../generationDirective';
import { PERSON_REPLACE_SCOPE_LABELS, PERSON_STRENGTH_LABELS, personContractHasImage } from './personContract';
import { REGION_TYPE_LABELS, describeRectPosition } from './region';
import { IDENTITY_RELATION_LABELS, RENDERING_MODE_LABELS, singleMediaModeOf } from './rendering';
import type {
  PersonReplacementContract,
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
 */
export function compileRenderingContract(input: {
  rendering: RenderingContract | null | undefined;
  styleDirection?: string;
}): string {
  const { rendering } = input;
  if (!rendering) return '';
  const styleNote = input.styleDirection?.trim()
    ? `整体风格方向「${input.styleDirection.trim()}」只改变各层的风格化表达，绝不改变各层的媒介类型。`
    : '';
  if (rendering.overallMode === 'mixed_media') {
    const lines: string[] = ['【媒介结构合同（混合媒介，强制执行）】'];
    if (rendering.regions.length > 0) {
      lines.push('本图由多种媒介层构成，各层必须保持自己的媒介类型，禁止整图统一成单一媒介：');
      rendering.regions.forEach((region, index) => {
        const identity = region.identityRelation === 'same_as_primary'
          ? `与主体人物为同一人物（该层人物 = 主体人物以「${RENDERING_MODE_LABELS[region.renderingMode]}」媒介呈现的版本，不是另一个人）`
          : region.identityRelation === 'person_reference'
            ? '人物身份来自人物参考图'
            : region.identityRelation === 'template_identity'
              ? '沿用模板原身份设定'
              : '无特定身份约束';
        lines.push(`- 媒介层${index + 1}（${region.label}，${region.semanticRole}）：以${RENDERING_MODE_LABELS[region.renderingMode]}方式呈现；身份：${identity}${region.description ? `；${region.description}` : ''}。`);
      });
    } else {
      lines.push('本图属于混合媒介作品（多种媒介并存），必须保持模板原有的媒介分层结构，禁止把整图统一成单一媒介。');
    }
    if (rendering.preserveTemplateMediaStructure) {
      lines.push('媒介结构沿用画面模板：模板中的真人层保持真人媒介、动漫层保持动漫媒介、平面元素保持平面设计媒介。');
    }
    if (styleNote) lines.push(styleNote);
    return lines.join('\n');
  }
  const mode = singleMediaModeOf(rendering);
  if (mode === 'unknown') return '';
  return [
    '【媒介结构合同】',
    `本图为单一媒介作品：${RENDERING_MODE_LABELS[mode]}。全图保持该媒介的一致性。`,
    ...(styleNote ? [styleNote] : []),
  ].join('\n');
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
      return `【服装合同】服装 / 造型以${personOrdinal}（人物身份参考）为准（身份与服装都来自人物参考图）。`;
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

/** 模板保留合同（§16 模板保留段；哪些维度回到模板基线）。 */
export function compileTemplatePreservationContract(input: {
  project: VisualProject;
  activeDimensions: ReadonlyArray<string>;
}): string {
  const templateLabel = input.project.sourceAsset.displayName?.trim() || '画面模板图';
  const modified = new Set(input.activeDimensions);
  const dims: Array<[string, string]> = [
    ['动作', input.project.templateSnapshot?.action.originalValue ?? ''],
    ['背景', input.project.templateSnapshot?.background.originalValue ?? ''],
    ['构图', input.project.templateSnapshot?.composition.originalValue ?? ''],
    ['镜头', input.project.templateSnapshot?.camera.originalValue ?? ''],
    ['风格', input.project.templateSnapshot?.style.originalValue ?? ''],
    ['光线', input.project.templateSnapshot?.lighting.originalValue ?? ''],
    ['色彩', input.project.templateSnapshot?.color.originalValue ?? ''],
  ];
  const dimKeyToDimension: Record<string, string> = {
    动作: 'pose', 背景: 'scene', 构图: 'composition', 镜头: 'camera', 风格: 'style', 光线: 'lighting', 色彩: 'color',
  };
  const keep = dims.filter(([label]) => !modified.has(dimKeyToDimension[label] ?? ''));
  const lines: string[] = [`【模板保留合同】以下维度严格沿用${templateLabel}的分析基线：`];
  for (const [label, value] of keep) {
    lines.push(`- ${label}：${value || '（保持模板原样）'}`);
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
}

export interface CompiledFinalPrompt {
  prompt: string;
  negativePrompt: string;
  /** 实际装配的合同层名（测试与调试锚点）。 */
  sections: string[];
}

/**
 * 最终 Prompt 装配（§16 推荐结构）：固定顺序合并全部合同层 + 最终画面描述。
 * 负面词单独走 negativePrompt（与既有 final_negative_prompt 提交管线一致，
 * 不拼进 prompt 正文）。输出直接进入 Generation Carry（promptCompiled=true，
 * ImageStudio 不再二次前置指令）。
 */
export function mergeFinalGenerationPrompt(input: CompileFinalPromptInput): CompiledFinalPrompt {
  const { project } = input;
  const person = project.modification.person?.enabled ? project.modification.person : null;
  const refs = input.imageReferences.filter(ref => ref.path?.trim());
  const sections: string[] = [];
  const sectionNames: string[] = [];
  const push = (name: string, block: string) => {
    if (!block) return;
    sections.push(block);
    sectionNames.push(name);
  };

  push('image_role', compileImageRoleContract({
    imageReferences: refs,
    personReplacementEnabled: input.personReplacementEnabled,
    clothingPolicy: (project.modification.clothingPolicy as GenerationDirectiveInput['clothingPolicy']) ?? 'preserve_original',
    customClothing: project.modification.customClothing,
  }));

  if (person) push('person_replacement', compilePersonReplacementContract({ person, imageReferences: refs }));
  push('region', compileRegionContract({ regions: project.regions, references: project.references }));
  push('rendering', compileRenderingContract({
    rendering: project.renderingContract,
    styleDirection: input.styleDirection,
  }));
  push('clothing', compileClothingContract({
    clothingPolicy: project.modification.clothingPolicy,
    customClothing: project.modification.customClothing,
    imageReferences: refs,
  }));
  push('dimension', compileDimensionContract(project.modification.activeDimensions));
  if (project.templateSnapshot) {
    push('template_preservation', compileTemplatePreservationContract({
      project,
      activeDimensions: project.modification.activeDimensions,
    }));
  }
  if (input.finalDescription.trim()) {
    push('final_description', `【最终画面描述】\n${input.finalDescription.trim()}`);
  }

  const negativePrompt = [input.negativePrompt?.trim() ?? '', input.negativeAddendum?.trim() ?? '']
    .filter(Boolean)
    .join('，');

  return { prompt: sections.join('\n\n'), negativePrompt, sections: sectionNames };
}
