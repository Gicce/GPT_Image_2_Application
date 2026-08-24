/**
 * Optimizer Provenance 测试（V4.1）：
 *  - applyOptimizationResult 保存执行时模型快照（optimizerModelId / source）
 *  - buildGenerationCarry 冻结快照；之后换设置不影响历史 state
 *  - 旧数据（无 optimizer 字段）读取不崩溃、不伪造
 */

import { describe, it, expect } from 'vitest';
import {
  applyOptimizationResult,
  buildGenerationCarry,
  initialRecreationState,
  type RecreationState,
} from '../recreationPlan';

function baseState(): RecreationState {
  return initialRecreationState(
    { summary: '一名篮球运动员上篮', fields: [] },
    '原始复刻 Prompt',
    '低画质',
  );
}

describe('applyOptimizationResult：保存 optimizer 模型快照', () => {
  it('成功落位 optimizerModelId / optimizerSource / fallback 原因', () => {
    const next = applyOptimizationResult(baseState(), {
      optimizedPrompt: '最终 Prompt',
      optimizedNegativePrompt: '低画质',
      summary: '已优化',
      providerName: '智谱 GLM',
      modelName: 'GLM-5V-Turbo',
      optimizerModelId: 'glm-5v-turbo',
      optimizerProviderId: 'vp1',
      optimizerSource: 'follow',
      changedDimensions: [],
      dimensionValues: {},
    });
    expect(next.optimizerModelId).toBe('glm-5v-turbo');
    expect(next.optimizerProviderId).toBe('vp1');
    expect(next.optimizerSource).toBe('follow');
    expect(next.optimizedAt).toBeTruthy();
    expect(next.optimizedBy).toBe('optimizer');
  });

  it('旧数据（无 optimizer 字段）→ undefined，不崩溃、不伪造', () => {
    const next = applyOptimizationResult(baseState(), {
      optimizedPrompt: '最终 Prompt',
      optimizedNegativePrompt: '',
      summary: '已优化',
    });
    expect(next.optimizerModelId).toBeUndefined();
    expect(next.optimizerSource).toBeUndefined();
    expect(next.optimizedPrompt).toBe('最终 Prompt');
  });
});

describe('buildGenerationCarry：生成任务冻结执行时快照', () => {
  it('carry.optimization 携带 modelId 与 source', () => {
    const optimized = applyOptimizationResult(baseState(), {
      optimizedPrompt: '最终 Prompt',
      optimizedNegativePrompt: '',
      summary: '已优化',
      providerName: '智谱 GLM',
      modelName: 'GLM-5V-Turbo',
      optimizerModelId: 'glm-5v-turbo',
      optimizerSource: 'follow',
    });
    const carry = buildGenerationCarry(optimized, {});
    expect(carry.optimization?.modelId).toBe('glm-5v-turbo');
    expect(carry.optimization?.source).toBe('follow');
    expect(carry.optimization?.modelName).toBe('GLM-5V-Turbo');
    expect(carry.optimization?.optimizedAt).toBeTruthy();
  });

  it('历史 state 快照不随后续（模拟的）设置变化而改变', () => {
    const first = applyOptimizationResult(baseState(), {
      optimizedPrompt: 'V1 Prompt',
      optimizedNegativePrompt: '',
      summary: '第一版',
      optimizerModelId: 'glm-5v-turbo',
      optimizerSource: 'follow',
    });
    const snapshot = JSON.stringify(first);
    // 用户之后单独指定了 DeepSeek：新 state 新值，旧 state 快照原样
    const second = applyOptimizationResult({ ...first, editState: 'dirty' }, {
      optimizedPrompt: 'V2 Prompt',
      optimizedNegativePrompt: '',
      summary: '第二版',
      optimizerModelId: 'deepseek-v4-flash',
      optimizerSource: 'manual',
    });
    expect(second.optimizerModelId).toBe('deepseek-v4-flash');
    expect(JSON.parse(snapshot).optimizerModelId).toBe('glm-5v-turbo');
    expect(first.optimizerModelId).toBe('glm-5v-turbo');
  });
});
