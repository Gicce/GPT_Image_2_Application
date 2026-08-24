/**
 * 服装策略状态不变量（V4.0.9 状态模型修复）：
 *   clothing ∈ activeDimensions ⇔ clothingPolicy ≠ 'preserve_original'
 *
 * 「修改服装」与「严格保留原图（画面模板）服装」永远不能同时存在于有效状态中。
 * 覆盖：Chip 点击自动切换、三来源 radio 联动、空自定义守卫、持久化归一、
 * 四处一致（Chips / 当前规则 / 合成指令 / 快照语义）。
 */

import { describe, expect, it } from 'vitest';
import {
  buildModificationInstruction,
  clearPersonReplacement,
  clothingReadinessError,
  EMPTY_MODIFICATION_DRAFT,
  migrateModificationDraft,
  normalizeModificationState,
  setClothingPolicy,
  setPersonReplacement,
  toggleModificationDimension,
  type ModificationDraft,
} from '../modificationIntent';
import { buildReplacementSummary } from '../replacementRules';

const personWithImage = {
  source: 'gallery' as const,
  assetId: 'asset-person',
  path: 'D:/imgs/person.png',
  label: 'person.png',
};

function draftWith(patch: Partial<ModificationDraft>): ModificationDraft {
  return { ...EMPTY_MODIFICATION_DRAFT, ...patch };
}

function assertInvariant(draft: ModificationDraft): void {
  const clothingActive = draft.activeDimensions.includes('clothing');
  const preserved = draft.clothingPolicy === 'preserve_original';
  expect(clothingActive).toBe(!preserved);
}

describe('normalizeModificationState（不变量单一收口）', () => {
  it('矛盾态（clothing 维度 + 原图服装）被归一：保留策略优先，维度移除', () => {
    const fixed = normalizeModificationState(
      draftWith({ activeDimensions: ['clothing'], clothingPolicy: 'preserve_original' }),
    );
    expect(fixed.activeDimensions).not.toContain('clothing');
    expect(fixed.clothingPolicy).toBe('preserve_original');
    assertInvariant(fixed);
  });

  it('非保留策略但维度未开：自动启用 clothing 维度', () => {
    const fixed = normalizeModificationState(
      draftWith({ person: personWithImage, clothingPolicy: 'use_subject_reference' }),
    );
    expect(fixed.activeDimensions).toContain('clothing');
    assertInvariant(fixed);
  });

  it('无人物参考图时 use_subject_reference 降级 custom', () => {
    const fixed = normalizeModificationState(
      draftWith({ activeDimensions: ['clothing'], clothingPolicy: 'use_subject_reference' }),
    );
    expect(fixed.clothingPolicy).toBe('custom');
    expect(fixed.activeDimensions).toContain('clothing');
  });

  it('服装策略不参与语义（无人物且未启用维度）时回落默认并清空描述', () => {
    const fixed = normalizeModificationState(
      draftWith({ clothingPolicy: 'custom', customClothing: '黑色风衣' } as Partial<ModificationDraft>),
    );
    expect(fixed.clothingPolicy).toBe('preserve_original');
    expect(fixed.customClothing).toBe('');
  });

  it('幂等：对已合法状态不做任何改动', () => {
    const legal = draftWith({ person: personWithImage, activeDimensions: ['subject', 'clothing'], clothingPolicy: 'use_subject_reference' });
    expect(normalizeModificationState(legal)).toEqual(legal);
  });
});

describe('Case A：preserve_original 状态下点击「修改服装」', () => {
  it('有人物参考 → 自动切换 use_subject_reference 且 clothing 维度激活', () => {
    const next = toggleModificationDimension(
      draftWith({ person: personWithImage, activeDimensions: ['subject'], clothingPolicy: 'preserve_original' }),
      'clothing',
    );
    expect(next.clothingPolicy).toBe('use_subject_reference');
    expect(next.activeDimensions).toContain('clothing');
    assertInvariant(next);
  });

  it('无人物参考 → 自动切换 custom（不伪造内容）', () => {
    const next = toggleModificationDimension(
      draftWith({ clothingPolicy: 'preserve_original' }),
      'clothing',
    );
    expect(next.clothingPolicy).toBe('custom');
    expect(next.activeDimensions).toContain('clothing');
    expect(next.customClothing).toBe('');
    expect(clothingReadinessError(next)).toBe('请描述新的服装 / 造型。');
  });

  it('再次点击「修改服装」= 取消：回到原图服装', () => {
    const active = draftWith({ activeDimensions: ['clothing'], clothingPolicy: 'custom', customClothing: '白色西装' } as Partial<ModificationDraft>);
    const next = toggleModificationDimension(active, 'clothing');
    expect(next.activeDimensions).not.toContain('clothing');
    expect(next.clothingPolicy).toBe('preserve_original');
    expect(next.customClothing).toBe('');
    assertInvariant(next);
  });
});

describe('Case B / C / D：三来源 radio 切换（setClothingPolicy）', () => {
  it('Case B 原图服装 → clothing 维度 OFF', () => {
    const next = setClothingPolicy(
      draftWith({ activeDimensions: ['clothing'], clothingPolicy: 'use_subject_reference', customClothing: '黑色风衣' } as Partial<ModificationDraft>),
      'preserve_original',
    );
    expect(next.activeDimensions).not.toContain('clothing');
    expect(next.clothingPolicy).toBe('preserve_original');
    expect(next.customClothing).toBe('');
    assertInvariant(next);
  });

  it('Case C 人物服装 → clothing 维度 ON（需要人物参考图）', () => {
    const next = setClothingPolicy(
      draftWith({ person: personWithImage, activeDimensions: ['subject'], clothingPolicy: 'preserve_original' }),
      'use_subject_reference',
    );
    expect(next.activeDimensions).toContain('clothing');
    expect(next.clothingPolicy).toBe('use_subject_reference');
    assertInvariant(next);
  });

  it('Case D 自定义服装 → clothing 维度 ON；空描述触发就绪错误', () => {
    const next = setClothingPolicy(
      draftWith({ activeDimensions: [], clothingPolicy: 'preserve_original' }),
      'custom',
    );
    expect(next.activeDimensions).toContain('clothing');
    expect(clothingReadinessError(next)).toBe('请描述新的服装 / 造型。');
    const filled = { ...next, customClothing: '红色晚礼服' };
    expect(clothingReadinessError(filled)).toBeNull();
    assertInvariant(filled);
  });
});

describe('人物替换与持久化的不变量保持', () => {
  it('移除人物替换时保留显式启用的服装修改（策略降级 custom）', () => {
    const next = clearPersonReplacement(
      draftWith({
        person: personWithImage,
        activeDimensions: ['subject', 'clothing'],
        clothingPolicy: 'use_subject_reference',
      }),
    );
    expect(next.person).toBeNull();
    expect(next.activeDimensions).toContain('clothing');
    expect(next.clothingPolicy).toBe('custom');
    assertInvariant(next);
  });

  it('移除人物替换且服装未显式启用 → 整体回默认', () => {
    const next = clearPersonReplacement(
      draftWith({ person: personWithImage, activeDimensions: ['subject'], clothingPolicy: 'preserve_original' }),
    );
    expect(next.clothingPolicy).toBe('preserve_original');
    expect(next.activeDimensions).not.toContain('clothing');
    expect(next.customClothing).toBe('');
  });

  it('设置人物参考自动激活 subject 维度，服装策略不动', () => {
    const next = setPersonReplacement(draftWith({}), personWithImage);
    expect(next.activeDimensions).toContain('subject');
    expect(next.clothingPolicy).toBe('preserve_original');
    assertInvariant(next);
  });

  it('旧持久化矛盾数据（clothing + preserve_original）恢复即归一', () => {
    const restored = migrateModificationDraft({
      freeText: '换个造型',
      activeDimensions: ['clothing'],
      clothingPolicy: 'preserve_original',
    });
    expect(restored.activeDimensions).not.toContain('clothing');
    expect(restored.clothingPolicy).toBe('preserve_original');
    assertInvariant(restored);
  });

  it('旧持久化合法数据（person + 人物服装）恢复后自动补 clothing 维度', () => {
    const restored = migrateModificationDraft({
      activeDimensions: ['subject'],
      person: personWithImage,
      clothingPolicy: 'use_subject_reference',
    });
    expect(restored.activeDimensions).toContain('clothing');
    assertInvariant(restored);
  });
});

describe('四处一致：Chips / 当前规则 / 合成指令 / 快照语义', () => {
  it('同一工作区（人物/动作/背景 + 人物服装）四处服装语义一致', () => {
    const draft = draftWith({
      freeText: '保留原图风格',
      person: personWithImage,
      activeDimensions: ['subject', 'pose', 'scene', 'clothing'],
      clothingPolicy: 'use_subject_reference',
    });
    assertInvariant(draft);

    // ① 修改 Chip：clothing 处于选中
    expect(draft.activeDimensions).toContain('clothing');

    // ② 人物替换卡「当前规则」：服装 ← @人物参考
    const summary = buildReplacementSummary(draft)!;
    const clothingRow = summary.rows.find(row => row.kind === 'clothing')!;
    expect(clothingRow.source).toBe('@人物参考');

    // ③ 合成指令（优化器输入 / AI 方案同源）：服装处理 = 使用人物参考服装 + 服装修改（已启用）
    const instruction = buildModificationInstruction(draft);
    expect(instruction).toContain('重点修改维度：动作、背景、服装');
    expect(instruction).toContain('服装修改（已启用）');
    expect(instruction).toContain('服装处理：使用人物参考图中的服装');
    expect(instruction).not.toContain('严格保留原图（画面模板）服装');
  });

  it('服装保留态（原图服装）四处一致：无修改指令、无矛盾文本', () => {
    const draft = draftWith({
      person: personWithImage,
      activeDimensions: ['subject'],
      clothingPolicy: 'preserve_original',
    });
    assertInvariant(draft);
    expect(draft.activeDimensions).not.toContain('clothing');

    const summary = buildReplacementSummary(draft)!;
    const clothingRow = summary.rows.find(row => row.kind === 'clothing')!;
    expect(clothingRow.source).toBe('@原图');

    const instruction = buildModificationInstruction(draft);
    expect(instruction).toContain('服装处理：严格保留原图（画面模板）服装');
    expect(instruction).not.toContain('服装修改（已启用）');
    expect(instruction).not.toContain('重点修改维度');
  });
});
