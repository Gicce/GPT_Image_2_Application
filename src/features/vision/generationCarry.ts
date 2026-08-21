/**
 * 图片工作室（ImageStudio）提交生成时的优化快照决策（纯函数，底层硬保证）。
 *
 * 规则：
 *  - 用户在工作室手动采用了单张 AI 优化结果 → 快照 applied=true（来源 studio）；
 *  - Prompt 来自视觉理解复刻链路（visionCarry.optimization 存在）→ 快照 applied=true
 *    且 source='vision_recreation'，提交参数 prompt_optimized=true —— 底层冻结
 *    「已优化」事实，提交生成绝不再次执行 AI 优化；
 *  - 其余情况 → applied=false，不携带优化标记。
 * UI 文案（来源横幅）只做提示；真正的「禁止重复优化」由本函数产出的快照与
 * visionOptimized 标志在提交链路强制生效。
 */

import type { PromptOptimizationSnapshot } from '../../types';
import type { VisionCarryDraft } from '../../store/useDraftStore';

export interface SubmitOptimizationInput {
  /** 用户采用了工作室单张 AI 优化结果（singleOpt.status==='success' && useOptimized）。 */
  adopted: boolean;
  /** 采用优化时的元数据（singleOpt 字段子集）。 */
  adoptedMeta: {
    providerName?: string;
    modelName?: string;
    originalPrompt?: string;
    manuallyEdited?: boolean;
  };
  /** 表单当前提示词原文（作为 original_prompt 兜底）。 */
  promptText: string;
  /** 视觉理解页「确认生成图片」带入的一次性草稿。 */
  visionCarry: VisionCarryDraft | null;
}

export interface SubmitOptimizationDecision {
  /** true = Prompt 已在视觉理解链路优化完成，提交时冻结快照并跳过再次优化。 */
  visionOptimized: boolean;
  snapshot: PromptOptimizationSnapshot;
}

export function resolveSubmitOptimizationSnapshot(input: SubmitOptimizationInput): SubmitOptimizationDecision {
  if (input.adopted) {
    return {
      visionOptimized: false,
      snapshot: {
        applied: true,
        provider_name: input.adoptedMeta.providerName || undefined,
        model_name: input.adoptedMeta.modelName || undefined,
        original_prompt: input.adoptedMeta.originalPrompt || input.promptText,
        optimized_at: new Date().toISOString(),
        manually_edited_after: input.adoptedMeta.manuallyEdited,
      },
    };
  }
  const carry = input.visionCarry?.optimization;
  if (carry) {
    return {
      visionOptimized: true,
      snapshot: {
        applied: true,
        provider_name: carry.providerName || undefined,
        model_name: carry.modelName || undefined,
        original_prompt: carry.originalPrompt || input.promptText,
        optimized_at: carry.optimizedAt,
        source: 'vision_recreation',
      },
    };
  }
  return { visionOptimized: false, snapshot: { applied: false } };
}
