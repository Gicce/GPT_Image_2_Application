/**
 * Generation Directive（V4.0.9.1 人物强替换）—— 提交给 gpt-image-2 的
 * **确定性**图片角色指令编译器（纯函数，零模型裁量）。
 *
 * 为什么必须存在：图片生成 API 只接受无角色的 image[] 数组；优化器输出的
 * positive_prompt 是否写明「每张图负责什么」取决于模型自觉。本模块在
 * 「确认生成图片 → carry → ImageStudio 提交」链路上把角色语义**强制**编译进
 * 最终生图 Prompt（附加在优化结果之前），保证：
 *
 *   person replacement ON + person reference 存在
 *   ⇒ 模板图只负责画面模板（构图/风格/背景/氛围），
 *     人物参考图是主体人物身份的唯一主来源，
 *     模板图原人物的脸部身份 / 面部特征 / 发型被显式排除。
 *
 * 服装三态在此显式区分「服装来源」与「身份来源」（preserve outfit ≠ preserve identity）；
 * 「提高复刻度」只作用于未开放修改的模板维度，绝不作用到人物身份。
 */

import type { GenerationImageReference } from '../../types';
import type { ClothingPolicy } from './modificationIntent';

export interface GenerationDirectiveInput {
  /** 按提交顺序的参考图（template → person → extras；carry 事实源）。 */
  imageReferences: ReadonlyArray<GenerationImageReference>;
  /** 人物替换是否启用。 */
  personReplacementEnabled: boolean;
  /** 服装策略（三态）。 */
  clothingPolicy: ClothingPolicy;
  /** 自定义服装描述（clothingPolicy === 'custom'）。 */
  customClothing?: string;
}

/** 图片序号（1 起）→ 指令行中的称呼。 */
function imageOrdinal(index: number): string {
  return `图片${index + 1}`;
}

const TEMPLATE_ALLOWED = '构图、镜头、背景结构、光影、色彩氛围与整体画风（含动漫AI照片风等风格语言）';
const TEMPLATE_FORBIDDEN = '禁止从该图提取或保留人物的脸部身份、五官、脸型、发型与人物外貌特征';
const PERSON_IDENTITY = '脸部身份、五官比例、脸型、发型发色、眼神气质、人物外貌与整体形象';

/** 单张参考图的职责行（角色 → 模型必须遵守的使用方式）。 */
function describeRoleLine(ref: GenerationImageReference, index: number, personEnabled: boolean): string {
  const ordinal = imageOrdinal(index);
  const label = ref.label?.trim() || '参考图';
  switch (ref.role) {
    case 'template':
      return personEnabled
        ? `- ${ordinal}（@${label}，画面模板）：仅提供${TEMPLATE_ALLOWED}；${TEMPLATE_FORBIDDEN}。`
        : `- ${ordinal}（@${label}，画面模板）：提供${TEMPLATE_ALLOWED}，生成与该图同风格的新图。`;
    case 'person_reference':
      return `- ${ordinal}（@${label}，人物身份参考）：主体人物身份的唯一主来源——${PERSON_IDENTITY}必须以该图为准；`
        + '主体人物必须整体替换为该图中的人物，不得保留画面模板图原人物的脸部身份或面部特征。';
    case 'background_reference':
      return `- ${ordinal}（@${label}，背景参考）：仅提供背景 / 环境参照，不提供人物身份。`;
    case 'style_reference':
      return `- ${ordinal}（@${label}，风格参考）：仅提供画风 / 视觉风格参照，不提供人物身份。`;
    case 'generic_reference':
    default:
      return `- ${ordinal}（@${label}，参考图）：按正文的引用语境使用，不作为人物身份来源。`;
  }
}

/** 服装三态 → 身份 / 服装来源分离声明（preserve outfit ≠ preserve identity）。 */
function clothingRuleLine(input: GenerationDirectiveInput, templateOrdinal: string, personOrdinal: string): string {
  switch (input.clothingPolicy) {
    case 'use_subject_reference':
      return `服装规则：服装 / 造型同样以${personOrdinal}（人物身份参考）为准（身份与服装都来自人物参考图）。`;
    case 'custom': {
      const custom = input.customClothing?.trim();
      return `服装规则：服装 / 造型按自定义描述执行${custom ? `——${custom}` : ''}；人物身份仍必须来自${personOrdinal}（人物身份参考）。`;
    }
    case 'preserve_original':
    default:
      return `服装规则：服装 / 服装设计沿用${templateOrdinal}（画面模板）的服装；「沿用服装」仅限于服装本身，`
        + `绝不代表保留${templateOrdinal}的人物——人物身份、面部、发型仍必须来自${personOrdinal}（人物身份参考）。`;
  }
}

/**
 * 编译图片角色指令块（附加在优化后 Prompt 之前，随生成请求一起提交）。
 *
 * - 无参考图 → 返回空串（不污染纯文生图任务）；
 * - 有人物替换 → 强制替换 + 排除模板人物身份 + 服装来源分离 三段俱全；
 * - 无人物替换 → 仅按角色清单声明各图职责（保持既有行为语义）。
 */
export function buildGenerationImageDirective(input: GenerationDirectiveInput): string {
  const refs = input.imageReferences.filter(ref => ref.path?.trim());
  if (refs.length === 0) return '';

  const personIndex = refs.findIndex(ref => ref.role === 'person_reference');
  const templateIndex = refs.findIndex(ref => ref.role === 'template');
  const personEnabled = input.personReplacementEnabled && personIndex >= 0;

  const lines: string[] = [
    `【图片使用说明（强制执行）】本次生成随请求附上 ${refs.length} 张图片，按提交顺序：`,
    ...refs.map((ref, index) => describeRoleLine(ref, index, personEnabled)),
  ];

  if (personEnabled) {
    lines.push(
      '人物替换（强制条件，无裁量空间）：主体人物必须替换为人物身份参考图中的人物；'
      + '不得保留画面模板图原人物的脸部身份、五官或面部特征；画面模板图仅用于画面布局、风格、背景与整体视觉参考。',
    );
    lines.push(clothingRuleLine(
      input,
      templateIndex >= 0 ? imageOrdinal(templateIndex) : '画面模板图',
      imageOrdinal(personIndex),
    ));
  }

  return lines.join('\n');
}

/**
 * 人物替换开启时的负面提示词追加项（追加到 negative prompt，双通道排斥模板人物身份）。
 * 无人物替换 / 无人物参考图 → 返回空串。
 */
export function buildGenerationNegativeAddendum(input: GenerationDirectiveInput): string {
  const hasPerson = input.imageReferences.some(ref => ref.path?.trim() && ref.role === 'person_reference');
  if (!input.personReplacementEnabled || !hasPerson) return '';
  return '画面模板图原人物的脸部身份、五官与面部特征';
}

/** 拼接负面提示词（去重：追加项已存在时不重复添加）。 */
export function appendNegativeAddendum(negative: string, addendum: string): string {
  const base = negative.trim();
  const extra = addendum.trim();
  if (!extra) return base;
  if (base.includes(extra)) return base;
  return base ? `${base}，${extra}` : extra;
}
