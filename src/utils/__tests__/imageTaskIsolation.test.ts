import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildBatchPlanTaskParams } from '../batchPlans';
import { createPlan } from '../batchPlans';

/**
 * 模型职责隔离守卫（V4.0.8）：
 * Chat / Planner / Prompt Optimizer / Vision 模型（全部 BYOK）绝不允许成为
 * 图片执行模型。图片任务参数不携带任何模型字段，执行模型只由服务端图片目录
 * （imageModelCapability）与 Rust task_runner 常量决定。源码级断言防止回归到
 * `selectedModel || defaultModel` 式模糊 fallback。
 */

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8');
}

describe('图片任务参数不含模型字段（模型由执行层固定）', () => {
  it('批量任务参数（buildBatchPlanTaskParams）没有任何 model 键', () => {
    const plans = [
      { ...createPlan({ description: '方案一' }), ...{ positivePrompt: 'P1', negativePrompt: '' } },
      { ...createPlan({ description: '方案二' }), ...{ positivePrompt: 'P2', negativePrompt: '' } },
    ];
    const built = buildBatchPlanTaskParams(plans, {
      taskType: 'edit',
      originalRequirement: '需求',
      sourceImages: ['D:/ref.png'],
      size: '1024x1024',
      quality: 'auto',
      outputFormat: 'png',
      outputDir: 'D:/out',
    });
    const params = built.params as unknown as Record<string, unknown>;
    expect(params.task_type).toBe('edit');
    expect(params.source_images).toEqual(['D:/ref.png']);
    for (const key of Object.keys(params)) {
      expect(key.toLowerCase()).not.toContain('model');
    }
  });
});

describe('源码守卫：图片链路不得引用 BYOK 模型解析', () => {
  it('ImageStudio 不解析 BYOK 配置作为图片模型，且提交前有 capability 门禁', () => {
    const source = readSource('../../pages/ImageStudio.tsx');
    expect(source).toContain('gateImageModelForKind');
    expect(source).not.toMatch(/resolveByokConfigForUse|resolveByokVisionConfig|resolveForUse\b/);
  });

  it('Rust task_runner：图片执行模型固定、路由走 ImageExecutionRoute、无文本会话 endpoint', () => {
    const source = readSource('../../../src-tauri/src/task_runner.rs');
    expect(source).toContain('resolve_execution_route(&task.task_type)');
    expect(source).toContain('"gpt-image-2"');
    expect(source).not.toContain('/chat/completions');
    expect(source).not.toContain('/v1/responses');
  });

  it('Agent 任务创建：image_edit intent 映射为 edit task_type（不走文生图通道）', () => {
    const source = readSource('../../store/useChatStore.ts');
    expect(source).toContain(`effectiveIntent === 'image_edit' ? 'edit'`);
  });

  it('编辑重发保留原任务类型与负面词（不能只恢复 Prompt）', () => {
    const source = readSource('../../components/EditTaskModal.tsx');
    expect(source).toContain(`isEdit ? 'edit' : 'generate'`);
    expect(source).toContain('final_negative_prompt');
  });
});
