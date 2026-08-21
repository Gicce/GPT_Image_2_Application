import { describe, it, expect } from 'vitest';
import { resolveSubmitOptimizationSnapshot } from '../generationCarry';

/**
 * ImageStudio 提交生成的优化快照决策 —— 「source=vision_recreation 不重复优化」的底层硬保证：
 * UI 横幅只是提示，真正拦截在 snapshot.applied + source 标记 + prompt_optimized 参数。
 */

const visionCarry = {
  prompt: '最终 Prompt',
  negativePrompt: '',
  optimization: {
    providerName: '智谱',
    modelName: 'GLM-5.2',
    originalPrompt: '原始 Prompt',
    optimizedAt: '2026-08-21T00:00:00.000Z',
  },
};

describe('resolveSubmitOptimizationSnapshot', () => {
  it('来自 vision_recreation（未采用工作室优化）→ 冻结快照 + 跳过重复优化', () => {
    const decision = resolveSubmitOptimizationSnapshot({
      adopted: false,
      adoptedMeta: {},
      promptText: '最终 Prompt',
      visionCarry,
    });
    expect(decision.visionOptimized).toBe(true);
    expect(decision.snapshot.applied).toBe(true);
    expect(decision.snapshot.source).toBe('vision_recreation');
    expect(decision.snapshot.provider_name).toBe('智谱');
    expect(decision.snapshot.model_name).toBe('GLM-5.2');
    expect(decision.snapshot.original_prompt).toBe('原始 Prompt');
    expect(decision.snapshot.optimized_at).toBe('2026-08-21T00:00:00.000Z');
  });

  it('用户显式采用了工作室 AI 优化结果 → applied=true，来源为工作室而非 vision_recreation', () => {
    const decision = resolveSubmitOptimizationSnapshot({
      adopted: true,
      adoptedMeta: {
        providerName: '智谱',
        modelName: 'GLM-5.2',
        originalPrompt: '原需求',
        manuallyEdited: false,
      },
      promptText: '原需求',
      visionCarry,
    });
    expect(decision.visionOptimized).toBe(false);
    expect(decision.snapshot.applied).toBe(true);
    expect(decision.snapshot.source).toBeUndefined();
    expect(decision.snapshot.original_prompt).toBe('原需求');
    expect(decision.snapshot.optimized_at).toBeTruthy();
  });

  it('普通手动输入（无优化、无视觉链路）→ applied=false', () => {
    const decision = resolveSubmitOptimizationSnapshot({
      adopted: false,
      adoptedMeta: {},
      promptText: '随便写点什么',
      visionCarry: null,
    });
    expect(decision.visionOptimized).toBe(false);
    expect(decision.snapshot).toEqual({ applied: false });
  });

  it('视觉链路草稿缺失 optimization 元数据 → 不视为已优化（宁可少标记，不可假标记）', () => {
    const decision = resolveSubmitOptimizationSnapshot({
      adopted: false,
      adoptedMeta: {},
      promptText: 'p',
      visionCarry: { prompt: 'p', negativePrompt: '' },
    });
    expect(decision.visionOptimized).toBe(false);
    expect(decision.snapshot.applied).toBe(false);
  });
});
