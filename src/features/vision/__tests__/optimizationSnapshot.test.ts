import { describe, expect, it } from 'vitest';
import {
  applyModificationInstruction,
  applyOptimizationResult,
  canGenerateFromRecreation,
  describeRecreationStatus,
  initialRecreationState,
  needsOptimization,
  normalizeRecreationState,
  signatureOfRecreationPlan,
  togglePlanFieldLock,
} from '../recreationPlan';
import {
  buildModificationInstruction,
  setPersonReplacement,
  toggleReplicationBoost,
  EMPTY_MODIFICATION_DRAFT,
  type ModificationDraft,
} from '../modificationIntent';
import { buildRecreationPlan } from '../recreationPlan';
import { fixtureAnalysis } from '../project/__tests__/fixtures';

/**
 * Replication Boost 解耦回归（GUI 验收 P1）：
 * 「提高复刻度」是可逆附加意图——开启后标记待重新优化（允许），但历史优化快照保留；
 * 关闭后条件回到上一次成功优化的一致状态 ⇒ 自动恢复该优化结果，绝不强迫重新优化。
 */

function baseState() {
  const plan = buildRecreationPlan(fixtureAnalysis());
  return initialRecreationState(plan, '原始复刻 Prompt', '负面词');
}

function draftWith(person: boolean, boost: boolean): ModificationDraft {
  let draft: ModificationDraft = { ...EMPTY_MODIFICATION_DRAFT };
  if (person) {
    draft = setPersonReplacement(draft, {
      source: 'local',
      path: 'D:/imgs/person.png',
      label: '人物参考',
    });
    draft = { ...draft, clothingPolicy: 'use_subject_reference' };
  }
  if (boost) draft = toggleReplicationBoost(draft);
  return draft;
}

const instructionOf = (draft: ModificationDraft) => buildModificationInstruction(draft);

describe('OptimizationSnapshot（提高复刻度与优化快照解耦）', () => {
  it('优化成功落快照；开启提高复刻度 → 待重新优化；关闭 → 自动恢复上一版优化结果', () => {
    const draftNoBoost = draftWith(true, false);
    const draftBoost = draftWith(true, true);
    const instructionNoBoost = instructionOf(draftNoBoost);
    const instructionBoost = instructionOf(draftBoost);
    expect(instructionBoost).not.toBe(instructionNoBoost);
    expect(instructionBoost).toContain('提高复刻度');

    // 第一次优化（未开 boost）
    let state = applyModificationInstruction(baseState(), instructionNoBoost);
    expect(needsOptimization(state)).toBe(true);
    state = applyOptimizationResult(state, {
      optimizedPrompt: 'P1（人物+服装，未开boost）',
      optimizedNegativePrompt: 'N1',
      summary: '第一次优化',
      providerName: '智谱',
      modelName: 'GLM-5V-Turbo',
      optimizerModelId: 'glm-5v-turbo',
    });
    expect(state.editState).toBe('optimized');
    expect(state.optimizationHistory).toHaveLength(1);
    expect(state.optimizedPrompt).toBe('P1（人物+服装，未开boost）');

    // 开启提高复刻度：条件变化 → 待重新优化（此前结果保留在快照）
    state = applyModificationInstruction(state, instructionBoost);
    expect(needsOptimization(state)).toBe(true);
    expect(state.optimizedPrompt).toBe('P1（人物+服装，未开boost）'); // 未被破坏

    // 开 boost 下再优化成功（第二份快照）
    state = applyOptimizationResult(state, {
      optimizedPrompt: 'P2（人物+服装+提高复刻度）',
      optimizedNegativePrompt: 'N2',
      summary: '第二次优化',
    });
    expect(state.optimizationHistory).toHaveLength(2);
    expect(state.optimizedPrompt).toBe('P2（人物+服装+提高复刻度）');

    // 关闭提高复刻度：条件回到第一次 ⇒ 自动恢复 P1，不需要重新优化
    state = applyModificationInstruction(state, instructionNoBoost);
    expect(state.editState).toBe('optimized');
    expect(needsOptimization(state)).toBe(false);
    expect(state.optimizedPrompt).toBe('P1（人物+服装，未开boost）');
    expect(state.optimizedNegativePrompt).toBe('N1');
    expect(state.summary).toBe('第一次优化');
    expect(canGenerateFromRecreation(state).allowed).toBe(true);

    // 再次开启：仍可来回切换（快照双向可恢复）
    state = applyModificationInstruction(state, instructionBoost);
    expect(state.editState).toBe('optimized');
    expect(state.optimizedPrompt).toBe('P2（人物+服装+提高复刻度）');
  });

  it('其他条件变更（指令不同）不会误恢复：正常进入待重新优化', () => {
    const draftA = draftWith(true, false);
    const draftB = { ...draftWith(true, false), freeText: '再加上一些梦幻氛围' };
    let state = applyModificationInstruction(baseState(), instructionOf(draftA));
    state = applyOptimizationResult(state, {
      optimizedPrompt: 'P1',
      optimizedNegativePrompt: '',
      summary: 'S1',
    });
    state = applyModificationInstruction(state, instructionOf(draftB));
    expect(needsOptimization(state)).toBe(true);
    expect(state.editState).toBe('dirty');
  });

  it('复刻方案结构变化（锁定切换）后同样指令不恢复（条件已不一致）', () => {
    const draftA = draftWith(true, false);
    const instruction = instructionOf(draftA);
    let state = applyModificationInstruction(baseState(), instruction);
    state = applyOptimizationResult(state, {
      optimizedPrompt: 'P1',
      optimizedNegativePrompt: '',
      summary: 'S1',
    });
    // 用户手动切换某维度锁定 ⇒ 方案签名变化
    state = togglePlanFieldLock(state, 'style');
    expect(signatureOfRecreationPlan(state.plan)).not.toBe(state.optimizationHistory![0].planSignature);
    const next = applyModificationInstruction(state, instruction);
    expect(needsOptimization(next)).toBe(true);
  });

  it('同一指令重复优化：快照去重更新（不堆积）', () => {
    const instruction = instructionOf(draftWith(true, false));
    let state = applyModificationInstruction(baseState(), instruction);
    state = applyOptimizationResult(state, {
      optimizedPrompt: 'P1',
      optimizedNegativePrompt: '',
      summary: 'S1',
    });
    state = applyModificationInstruction({ ...state, editState: 'optimized', semanticRevision: state.optimizedRevision + 1 }, instruction);
    state = applyOptimizationResult(state, {
      optimizedPrompt: 'P1-new',
      optimizedNegativePrompt: '',
      summary: 'S1-new',
    });
    expect(state.optimizationHistory).toHaveLength(1);
    expect(state.optimizationHistory![0].optimizedPrompt).toBe('P1-new');
  });

  it('normalizeRecreationState：持久化恢复时非法快照条目被丢弃', () => {
    const plan = buildRecreationPlan(fixtureAnalysis());
    const state = initialRecreationState(plan, 'P', 'N');
    const dirty = applyModificationInstruction(state, '要求');
    const optimized = applyOptimizationResult(dirty, {
      optimizedPrompt: 'P1',
      optimizedNegativePrompt: '',
      summary: 'S',
    });
    const corrupted = {
      ...optimized,
      optimizationHistory: [
        { instruction: '', optimizedPrompt: 'x' },
        { optimizedPrompt: 'no-instruction' },
        'garbage',
        optimized.optimizationHistory![0],
      ] as unknown as typeof optimized.optimizationHistory,
    };
    const normalized = normalizeRecreationState(corrupted);
    expect(normalized.optimizationHistory).toHaveLength(1);
    expect(normalized.optimizationHistory![0].optimizedPrompt).toBe('P1');
  });

  it('状态栏文案：待优化时声明「此前优化结果已保留 / 可自动恢复」；无快照时不声明', () => {
    const withHistory = applyOptimizationResult(
      applyModificationInstruction(baseState(), '要求'),
      { optimizedPrompt: 'P1', optimizedNegativePrompt: '', summary: 'S' },
    );
    const boosted = applyModificationInstruction(withHistory, '要求+boost');
    const status = describeRecreationStatus(boosted);
    expect(status.label).toContain('待重新优化');
    expect(status.note).toContain('已保留');
    expect(status.note).toContain('自动恢复');

    const noHistory = applyModificationInstruction(baseState(), '要求');
    expect(describeRecreationStatus(noHistory).note).not.toContain('自动恢复');
  });
});
