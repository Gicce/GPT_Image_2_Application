import { describe, it, expect } from 'vitest';
import { computePromptDiff, dimensionDiff, tokenizePrompt } from '../promptDiff';

describe('tokenizePrompt（中英标点稳定 token 流）', () => {
  it('中文逐字、英文按词、空白归并、标点单字', () => {
    expect(tokenizePrompt('一只猫')).toEqual(['一', '只', '猫']);
    expect(tokenizePrompt('a cat 42')).toEqual(['a', ' ', 'cat', ' ', '42']);
    expect(tokenizePrompt('你好，world！')).toEqual(['你', '好', '，', 'world', '！']);
  });

  it('空文本 → 空 token 流', () => {
    expect(tokenizePrompt('')).toEqual([]);
  });
});

describe('computePromptDiff（全文 Prompt Diff）', () => {
  it('中文增加：只标记新增片段，其余为 equal', () => {
    const result = computePromptDiff('一名男性篮球运动员在室内球馆上篮', '一名男性篮球运动员在室内球馆双手扣篮');
    expect(result.addedCount).toBeGreaterThan(0);
    expect(result.segments.some(seg => seg.type === 'added' && seg.text.includes('双手'))).toBe(true);
    expect(result.segments.some(seg => seg.type === 'equal' && seg.text.includes('篮球运动员'))).toBe(true);
  });

  it('中文删除：删除片段带 removed 类型', () => {
    const result = computePromptDiff('红色球衣的运动员在打球', '运动员在打球');
    expect(result.removedCount).toBeGreaterThan(0);
    expect(result.segments.some(seg => seg.type === 'removed' && seg.text.includes('红色球衣'))).toBe(true);
  });

  it('句子改写（产品 Diff 示例）：动词段 removed + 新句 added，公共前后缀 equal', () => {
    // 原：动作：保持站立姿态，双臂在胸前自然展开。→ 新：动作：双手在胸前组成比心手势。
    const result = computePromptDiff(
      '动作：保持站立姿态，双臂在胸前自然展开。',
      '动作：双手在胸前组成比心手势。',
    );
    expect(result.segments.some(seg => seg.type === 'equal' && seg.text.includes('动作'))).toBe(true);
    expect(result.segments.some(seg => seg.type === 'removed' && seg.text.includes('保持站立姿态'))).toBe(true);
    expect(result.segments.some(seg => seg.type === 'added' && seg.text.includes('比心手势'))).toBe(true);
    // 语义顺序：removed 片段出现在对应 added 片段之前
    const firstRemoved = result.segments.findIndex(seg => seg.type === 'removed');
    const firstAdded = result.segments.findIndex(seg => seg.type === 'added');
    expect(firstRemoved).toBeGreaterThanOrEqual(0);
    expect(firstAdded).toBeGreaterThan(firstRemoved);
  });

  it('英文增删：按词 diff，不把整段判成删除+新增', () => {
    const result = computePromptDiff('a red jersey player in the gym', 'a blue jersey player in the gym');
    const removed = result.segments.filter(s => s.type === 'removed').map(s => s.text).join('');
    const added = result.segments.filter(s => s.type === 'added').map(s => s.text).join('');
    expect(removed).toContain('red');
    expect(added).toContain('blue');
    // 共同前缀保留为 equal（不是整段替换）
    expect(result.segments[0].type).toBe('equal');
  });

  it('标点变化：只 diff 变化处', () => {
    const result = computePromptDiff('球员, 球衣', '球员，球衣');
    expect(result.addedCount + result.removedCount).toBeGreaterThan(0);
    expect(result.segments.some(seg => seg.type === 'equal' && seg.text.includes('球员'))).toBe(true);
  });

  it('完全相同 → 全 equal，计数为 0', () => {
    const result = computePromptDiff('同一句话', '同一句话');
    expect(result.addedCount).toBe(0);
    expect(result.removedCount).toBe(0);
    expect(result.segments.every(seg => seg.type === 'equal')).toBe(true);
  });

  it('旧文本为空 → 整段 added；新文本为空 → 整段 removed', () => {
    expect(computePromptDiff('', '新增内容').segments).toEqual([{ type: 'added', text: '新增内容' }]);
    expect(computePromptDiff('删除内容', '').segments).toEqual([{ type: 'removed', text: '删除内容' }]);
  });

  it('片段拼接可还原新文本（渲染无丢字）', () => {
    const oldText = '一名男性篮球运动员在室内球馆上篮，低角度仰拍，硬光。';
    const newText = '一名男性篮球运动员在室外球场双手扣篮，低角度仰拍，柔光。';
    const result = computePromptDiff(oldText, newText);
    const rebuilt = result.segments
      .filter(seg => seg.type !== 'removed')
      .map(seg => seg.text)
      .join('');
    expect(rebuilt).toBe(newText);
  });

  it('超长文本（>3000 token）整体替换兜底，不崩溃', () => {
    const huge = '字'.repeat(4000);
    const result = computePromptDiff(huge, huge + '新增');
    expect(result.segments.some(seg => seg.type === 'removed')).toBe(true);
    expect(result.segments.some(seg => seg.type === 'added')).toBe(true);
  });
});

describe('dimensionDiff（维度级语义 Diff）', () => {
  it('维度完全不变 → changed=false', () => {
    expect(dimensionDiff('站立，双臂自然下垂', '站立，双臂自然下垂')).toEqual({
      changed: false,
      oldValue: '站立，双臂自然下垂',
      newValue: '站立，双臂自然下垂',
    });
  });

  it('整个维度被替换 → changed=true，保留原/新全文', () => {
    const diff = dimensionDiff('站立，双臂自然下垂', '双手在胸前组成比心手势');
    expect(diff.changed).toBe(true);
    expect(diff.oldValue).toBe('站立，双臂自然下垂');
    expect(diff.newValue).toBe('双手在胸前组成比心手势');
  });

  it('旧数据缺省 originalValue → 视为无变化（不展示维度 Diff）', () => {
    expect(dimensionDiff(undefined, '某个值').changed).toBe(true);
    expect(dimensionDiff('某个值', undefined).changed).toBe(true);
    expect(dimensionDiff(undefined, undefined).changed).toBe(false);
  });

  it('仅首尾空白差异不算修改', () => {
    expect(dimensionDiff('  双手比心  ', '双手比心').changed).toBe(false);
  });
});
