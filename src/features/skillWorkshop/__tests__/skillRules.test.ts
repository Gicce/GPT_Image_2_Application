import { describe, expect, test } from 'vitest';
import {
  addRuleItem, moveRuleItem, normalizeRuleList, removeRuleItem, updateRuleItem,
  validateAllRuleLists, validateRuleList,
} from '../skillRules';

describe('skillRules 数组操作', () => {
  test('新增一条：追加空行', () => {
    expect(addRuleItem(['a'])).toEqual(['a', '']);
    expect(addRuleItem([])).toEqual(['']);
  });

  test('更新指定行；越界原样返回', () => {
    expect(updateRuleItem(['a', 'b'], 1, 'B')).toEqual(['a', 'B']);
    expect(updateRuleItem(['a'], 5, 'x')).toEqual(['a']);
    expect(updateRuleItem(['a'], -1, 'x')).toEqual(['a']);
  });

  test('删除指定行；越界原样返回', () => {
    expect(removeRuleItem(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
    expect(removeRuleItem(['a'], 9)).toEqual(['a']);
  });

  test('上下移动：交换相邻；边界与越界不动作', () => {
    expect(moveRuleItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveRuleItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveRuleItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveRuleItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
    expect(moveRuleItem(['a'], 3, 1)).toEqual(['a']);
  });

  test('归一：去空白、丢空行、保序去重', () => {
    expect(normalizeRuleList(['  a ', '', 'b', 'a', '   '])).toEqual(['a', 'b']);
    expect(normalizeRuleList([])).toEqual([]);
  });
});

describe('skillRules 校验', () => {
  test('空行报错并指明行号', () => {
    const { errors } = validateRuleList(['a', ' ', 'c'], { label: '不可破坏的核心规则', min: 1 });
    expect(errors).toEqual(['「不可破坏的核心规则」第 2 行不能为空。']);
  });

  test('重复行报错并指明两处行号', () => {
    const { errors } = validateRuleList(['a', 'b', 'a'], { label: '质检标准', min: 1 });
    expect(errors).toEqual(['「质检标准」第 3 行与第 1 行重复。']);
  });

  test('条数不足报最低要求；min=0 允许为空', () => {
    expect(validateRuleList([], { label: '生成前阻断条件', min: 0 }).errors).toEqual([]);
    expect(validateRuleList([], { label: '不可破坏的核心规则', min: 1 }).errors)
      .toEqual(['「不可破坏的核心规则」至少需要 1 条。']);
  });

  test('三组规则一次性校验汇总', () => {
    const { errors } = validateAllRuleLists({
      coreRules: ['ok', ''], blockers: [], reviewRubric: ['dup', 'dup'],
    });
    expect(errors).toContain('「不可破坏的核心规则」第 2 行不能为空。');
    expect(errors).toContain('「质检标准」第 2 行与第 1 行重复。');
    expect(validateAllRuleLists({
      coreRules: ['r1'], blockers: [], reviewRubric: ['q1'],
    }).errors).toEqual([]);
  });
});
