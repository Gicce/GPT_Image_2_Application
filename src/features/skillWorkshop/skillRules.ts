/**
 * Skill 创作器「检查规则」页的纯函数层（V4.2.3）。
 *
 * 规则以 string[] 存储；三组规则（coreRules / blockers / reviewRubric）共用
 * 同一套 增/删/改/移动/归一/校验 实现，UI 层不自行操作数组下标。
 */

export type RuleField = 'coreRules' | 'blockers' | 'reviewRubric';

export function addRuleItem(items: string[]): string[] {
  return [...items, ''];
}

export function updateRuleItem(items: string[], index: number, value: string): string[] {
  if (index < 0 || index >= items.length) return items;
  return items.map((item, i) => (i === index ? value : item));
}

export function removeRuleItem(items: string[], index: number): string[] {
  if (index < 0 || index >= items.length) return items;
  return items.filter((_, i) => i !== index);
}

export function moveRuleItem(items: string[], index: number, direction: -1 | 1): string[] {
  const target = index + direction;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** 归一：去首尾空白、丢空行、保序去重（确认规则 / 保存前统一走这里）。 */
export function normalizeRuleList(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of items) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export interface RuleListValidation {
  errors: string[];
}

export interface RuleListOptions {
  /** 卡片标题（错误文案用，如「不可破坏的核心规则」）。 */
  label: string;
  /** 最少条数（0 = 允许为空，如阻断条件）。 */
  min: number;
}

/**
 * 校验一组规则：空行 / 重复行报错；条数不足报错。
 * 只报问题不修改数据（归一由 normalizeRuleList 单独负责）。
 */
export function validateRuleList(items: string[], options: RuleListOptions): RuleListValidation {
  const errors: string[] = [];
  const trimmed = items.map(item => item.trim());
  const firstSeen = new Map<string, number>();
  trimmed.forEach((value, index) => {
    if (!value) {
      errors.push(`「${options.label}」第 ${index + 1} 行不能为空。`);
      return;
    }
    const first = firstSeen.get(value);
    if (first === undefined) firstSeen.set(value, index);
    else errors.push(`「${options.label}」第 ${index + 1} 行与第 ${first + 1} 行重复。`);
  });
  if (trimmed.filter(Boolean).length < options.min) {
    errors.push(`「${options.label}」至少需要 ${options.min} 条。`);
  }
  return { errors };
}

/** 三组规则一次性校验（「确认当前规则」按钮用）。 */
export function validateAllRuleLists(input: {
  coreRules: string[]; blockers: string[]; reviewRubric: string[];
}): RuleListValidation {
  return {
    errors: [
      ...validateRuleList(input.coreRules, { label: '不可破坏的核心规则', min: 1 }).errors,
      ...validateRuleList(input.blockers, { label: '生成前阻断条件', min: 0 }).errors,
      ...validateRuleList(input.reviewRubric, { label: '质检标准', min: 1 }).errors,
    ],
  };
}
