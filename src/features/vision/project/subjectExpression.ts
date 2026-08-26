/**
 * Subject Expression（表情分离锁定）—— facial_expression 的确定性分类与
 * 强执行语义编译（纯函数，零模型裁量）。
 *
 * 不变量（动作未修改 ⇒ 整套动作基线锁定）：
 *  - pose / gesture / facial_expression / gaze / orientation 全部沿用模板基线；
 *  - 分类出 wink 类表情的动漫 / 次要主体：表情进入高优先级【表情锁定合同】，
 *    显式编译「一只眼完全闭合、另一只眼睁开有神、禁止半眯 / 弱化」——
 *    模板里一句自然语言 wink 在长 prompt 中天然会被稀释，这里反向强化；
 *  - detail_insert（眼部 / 面部特写）mirrors facial_expression ⇒ 继承同一表情。
 *
 * 分类只做关键词匹配，不发明画面里不存在的表情；识别不出 = null（不强化）。
 */

import type { RegionPoseSnapshot, VisualProject } from './types';

/** 表情分类（wink 家族细分到左右眼；识别不出 = null）。 */
export type FacialExpressionType =
  | 'wink_left'
  | 'wink_right'
  | 'one_eye_closed'
  | 'smile'
  | 'neutral'
  | 'other';

const WINK_PATTERN = /wink|眨眼|单眼|一只眼[^，。；]*闭|独眼|抛媚眼/i;
/** 左右眼判定按「闭合的那只眼」：左/右眼紧邻闭合词（同分句）才算，另一只眼睁开不干扰。 */
const LEFT_EYE_CLOSED = /左眼[^，。；,]*[闭合]|[闭合][^，。；,]*左眼|wink[_ ]?left/i;
const RIGHT_EYE_CLOSED = /右眼[^，。；,]*[闭合]|[闭合][^，。；,]*右眼|wink[_ ]?right/i;
const BOTH_CLOSED_PATTERN = /双眼[^，。；]*闭|闭着双眼|双眼紧闭/i;
const SMILE_PATTERN = /微笑|笑容|含笑|笑意|smile/i;
const NEUTRAL_PATTERN = /中性|无表情|面无表情|平静/i;

/** 单主体表情分类（输入 = 模板快照冻结的 facialExpression 基线文本）。 */
export function classifyFacialExpression(text: string | null | undefined): FacialExpressionType | null {
  const value = (text || '').trim();
  if (!value) return null;
  if (BOTH_CLOSED_PATTERN.test(value)) return 'other';
  if (WINK_PATTERN.test(value)) {
    const leftClosed = LEFT_EYE_CLOSED.test(value);
    const rightClosed = RIGHT_EYE_CLOSED.test(value);
    if (leftClosed && !rightClosed) return 'wink_left';
    if (rightClosed && !leftClosed) return 'wink_right';
    return 'one_eye_closed';
  }
  if (/闭眼|眼睛闭|眼闭合|眯眼/.test(value)) return 'one_eye_closed';
  if (SMILE_PATTERN.test(value)) return 'smile';
  if (NEUTRAL_PATTERN.test(value)) return 'neutral';
  return 'other';
}

export function isWinkExpression(type: FacialExpressionType | null): boolean {
  return type === 'wink_left' || type === 'wink_right' || type === 'one_eye_closed';
}

const WINK_STRONG_TEXT: Record<string, string> = {
  wink_left: '左眼完全闭合、右眼保持睁开展现清晰可辨的 wink 单眼眨眼',
  wink_right: '右眼完全闭合、左眼保持睁开展现清晰可辨的 wink 单眼眨眼',
  one_eye_closed: '一只眼睛完全闭合、另一只眼睛保持睁开展现清晰可辨的 wink 单眼眨眼',
};

/**
 * 锁定表情的强执行语义（表情锁定合同行）：wink 类显式反稀释条款；
 * 其余表情复述基线并声明禁止改写。
 */
export function lockedExpressionDirective(pose: RegionPoseSnapshot): string {
  const type = classifyFacialExpression(pose.facialExpression);
  const expression = pose.facialExpression!.trim();
  if (type && WINK_STRONG_TEXT[type]) {
    return `${expression}——${WINK_STRONG_TEXT[type]}；闭合的那只眼必须是明确的全闭合，`
      + `另一只眼睁大且有神；不是眯眼、不是半闭半睁、不是困倦的半睁、不是被弱化的轻微闭眼，`
      + `表情清晰、视觉上明显可识别`;
  }
  return `${expression}——保持该表情的明确度与可识别性，禁止弱化、替换或改为其它表情`;
}

/** 动作维度是否锁定（未启用修改动作 ⇔ 整套动作基线锁定）。 */
export function isPoseDimensionLocked(project: VisualProject): boolean {
  const poseModified = project.modification.activeDimensions.includes('pose');
  if (poseModified) return false;
  const poseField = project.workspace.recreation?.plan.fields.find(field => field.key === 'pose');
  if (poseField?.lockSource === 'user_override' && !poseField.locked) return false;
  return true;
}

/**
 * 有表情基线的主体（动作锁定时的表情锁定合同输入）。
 * wink 类主体排前（最易被稀释的放最显眼）。
 */
export function subjectsWithExpression(project: VisualProject): RegionPoseSnapshot[] {
  return (project.templateSnapshot?.subjectPoses ?? [])
    .filter(pose => pose.facialExpression?.trim())
    .sort((a, b) => Number(isWinkExpression(classifyFacialExpression(b.facialExpression)))
      - Number(isWinkExpression(classifyFacialExpression(a.facialExpression))));
}
