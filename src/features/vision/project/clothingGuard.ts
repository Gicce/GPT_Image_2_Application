/**
 * Clothing Source Guard（服装来源守卫）——「服装来自人物参考图」时的反回灌层。
 *
 * 不变量（clothing_source 唯一事实源）：
 *   clothingPolicy = 'use_subject_reference'（且 clothing ∈ activeDimensions）
 *     ⇒ 最终 Prompt 禁止出现模板服装元素描述
 *   例外：clothingPolicy = 'custom'（用户自定义 = 显式指定，可能就是要模板元素）
 *         / 'preserve_original'（沿用模板服装，模板元素本来就应存在）。
 *
 * 模板服装元素进入最终 Prompt 的三条泄露通道（本守卫逐一封堵）：
 *   1. 【模板保留合同】锁定维度基线（风格 / 姿态 / 媒介描述）常携带服装配饰词；
 *   2. 【媒介结构合同】region.description（分析产物）可能描述动漫层黑暗系服饰；
 *   3. 【最终画面描述】优化器复述模板主体外观时重新写回服装元素。
 *
 * 词表策略（与 lockedDimensionGuard 同族：有界词表 + 动态令牌）：
 *   - 动态令牌：从 templateSnapshot.clothing / subject 基线切词（模板真实服装名）；
 *   - 有界词表：常见黑暗系 / 配饰类服装词（覆盖风格行里的服装措辞）。
 */

import type { VisualProject } from './types';

/** 有界服装配饰词表（命中即视为模板服装元素；宁缺毋滥，避免误伤非服装描述）。 */
const TEMPLATE_CLOTHING_LEXICON: readonly string[] = [
  '露肩上衣', '黑色露肩', '高腰短裙', '百褶裙', '项圈', '金属链条', '链条',
  '腿环', '大腿环', '马丁靴', '高筒靴', '高筒绑带靴', '绑带靴', '过膝靴',
  'S形徽章', 'S形Logo', 'S形logo', '黑暗系', '哥特服饰', '哥特装', '朋克项圈',
  ' choker', 'Choker',
  // 服装识别耦合特征（E2：模板主体外观里与服装强耦合的发色 / 发型标记，
  // 服装来自人物参考时人物外观整体来自参考图，模板侧标记不得回灌）
  '紫发', '紫色长发', '双马尾',
];

/** 分隔符切词（中文顿号 / 逗号 / 分号 / 斜杠 / 英文逗号）。 */
const TOKEN_SEPARATORS = /[、，,；;\/／]+/;

/**
 * 从模板快照提取服装令牌：
 *  - 动态令牌只取 clothing 维度基线（subject 维度含主体身份词，切词会误伤
 *    媒介层 / 姿态行里的主体称谓，禁止作为动态来源）；
 *  - 有界词表对 clothing / style 两个维度探测命中（风格行常混入服装措辞）。
 */
export function extractTemplateClothingTokens(project: VisualProject): string[] {
  const snapshot = project.templateSnapshot;
  if (!snapshot) return [];
  const clothingText = snapshot.clothing?.originalValue ?? '';
  const styleText = snapshot.style?.originalValue ?? '';
  const tokens = new Set<string>();
  const pushParts = (value: string) => {
    for (const part of value.split(TOKEN_SEPARATORS).map(item => item.trim())) {
      if (part.length >= 2 && part.length <= 20) tokens.add(part);
    }
  };
  pushParts(clothingText);
  // snapshot.clothing 只合并了第一个主体的服装；多主体模板（混合媒介）其余
  // 主体的服装在 workspace.analysis.subjects[*].clothing，一并纳入
  for (const subject of project.workspace.analysis?.subjects ?? []) {
    for (const item of subject.clothing ?? []) pushParts(item);
  }
  for (const word of TEMPLATE_CLOTHING_LEXICON) {
    if (clothingText.includes(word) || styleText.includes(word)) tokens.add(word);
  }
  // 令牌按长度降序匹配（长词优先，避免「黑色露肩」被「露肩」截断后残留）
  return [...tokens].sort((a, b) => b.length - a.length);
}

/** 服装来源是否 = 人物参考图（守卫生效条件；custom = 用户显式指定不拦截）。 */
export function clothingSourceIsPersonReference(project: VisualProject): boolean {
  return project.modification.clothingPolicy === 'use_subject_reference'
    && project.modification.activeDimensions.includes('clothing');
}

/** 文本中命中的令牌。 */
export function matchClothingTokens(text: string, tokens: ReadonlyArray<string>): string[] {
  return tokens.filter(token => text.includes(token));
}

/** 从基线文本中剥离服装令牌（模板保留 / 媒介层净化用；按行处理多行块）。 */
export function sanitizeClothingFromBaseline(
  text: string,
  tokens: ReadonlyArray<string>,
): { text: string; removed: string[] } {
  if (tokens.length === 0 || !text) return { text, removed: [] };
  const removed: string[] = [];
  const cleanLine = (line: string): string => {
    let next = line;
    for (const token of tokens) {
      if (!next.includes(token)) continue;
      removed.push(token);
      next = next.split(token).join('');
    }
    // 收敛剥离残留：连续分隔符合一、行首行尾悬挂分隔符去掉
    return next
      .replace(/\s*[、，,；;]\s*(?=[、，,；;]|$)/g, '')
      .replace(/^([-\s]*)[、，,；;:\s]+/, '$1')
      .replace(/[、，,；;]\s*$/, '');
  };
  const lines = text.split('\n').map(cleanLine);
  return { text: lines.join('\n'), removed: [...new Set(removed)] };
}

/** 句子切分（含换行；保留结尾标点）。 */
function splitSentences(description: string): string[] {
  return description
    .split(/(?<=[。！？!?；;\n])/)
    .map(part => part.trim())
    .filter(Boolean);
}

/** 最终画面描述守卫：逐句剥离携带模板服装令牌的句子（类比 lockedDimensionGuard）。 */
export function guardClothingInDescription(
  description: string,
  tokens: ReadonlyArray<string>,
): { text: string; removedSentences: string[] } {
  if (tokens.length === 0 || !description.trim()) {
    return { text: description, removedSentences: [] };
  }
  const sentences = splitSentences(description);
  const kept: string[] = [];
  const removedSentences: string[] = [];
  for (const sentence of sentences) {
    if (matchClothingTokens(sentence, tokens).length > 0) removedSentences.push(sentence);
    else kept.push(sentence);
  }
  if (removedSentences.length === 0) return { text: description, removedSentences: [] };
  return { text: kept.join(''), removedSentences };
}

/** 装配后冲突校验（E4 兜底）：最终 Prompt 仍含模板服装令牌的行（应恒为空）。 */
export function validateFinalPromptClothingConflict(
  prompt: string,
  tokens: ReadonlyArray<string>,
): string[] {
  if (tokens.length === 0) return [];
  const offenders: string[] = [];
  for (const line of prompt.split('\n')) {
    const hits = matchClothingTokens(line, tokens);
    if (hits.length > 0) offenders.push(`「${hits.join('、')}」→ ${line.trim().slice(0, 60)}`);
  }
  return offenders;
}

/** 冲突报错文案（E4 指定）。 */
export const CLOTHING_CONFLICT_ERROR =
  '检测到服装来源冲突：当前已指定「服装来自人物参考图」，但最终 Prompt 仍包含模板服装元素，请修复后再生成。';
