/**
 * RecreationOptimizer（V4.0.6）
 *
 * 差异驱动的 Prompt 校正：只针对真实差异做增量修正，绝不整段重写
 * （防止 Prompt drift —— 每轮全量重写会让已正确的部分也漂移）。
 *
 * 实现为本地确定性规则（输入 = 双图评审差异 + 本地构图差异），
 * 不额外调用模型 —— 高复刻循环的 API 成本因此严格可预估：
 * 每轮 = 1 次图片生成 + 1 次候选图分析 + 1 次双图评审。
 */

import type { ReversePromptResult, PromptSections } from './reversePrompt';
import type { SimilarityReport } from './similarity';

export interface OptimizationResult {
  prompt: string;
  negativePrompt: string;
  /** 应用的修正（每条对应一个真实差异） */
  appliedCorrections: string[];
  /** 差异说明（UI 展示"本轮改了什么"） */
  changeLog: string[];
}

/** 停止条件判定：target 达标 / 改善不足 / 达到最大轮数 */
export interface StopDecision {
  shouldStop: boolean;
  reason: 'target_reached' | 'no_improvement' | 'max_iterations' | 'continue';
  message: string;
}

export interface StopCheckInput {
  latestScore: number;
  previousScore: number | null;
  targetScore: number;
  iteration: number;
  maxIterations: number;
  minImprovement: number;
}

export function evaluateStopCondition(input: StopCheckInput): StopDecision {
  if (input.latestScore >= input.targetScore) {
    return {
      shouldStop: true,
      reason: 'target_reached',
      message: `综合估算 ${Math.round(input.latestScore * 100)} 分，已达目标 ${Math.round(input.targetScore * 100)} 分。`,
    };
  }
  if (input.iteration >= input.maxIterations) {
    return {
      shouldStop: true,
      reason: 'max_iterations',
      message: `已达最大校准轮数（${input.maxIterations} 轮），当前综合估算 ${Math.round(input.latestScore * 100)} 分。`,
    };
  }
  if (input.previousScore !== null && input.latestScore - input.previousScore < input.minImprovement) {
    return {
      shouldStop: true,
      reason: 'no_improvement',
      message: `本轮改善不足（${Math.round((input.latestScore - input.previousScore) * 1000) / 10} 分 < ${Math.round(input.minImprovement * 1000) / 10} 分），提前停止以免无效消耗。`,
    };
  }
  return { shouldStop: false, reason: 'continue', message: '' };
}

/** 差异 → 修正指令 的确定性映射（可测试、无模型调用） */
function correctionDirectives(report: SimilarityReport): string[] {
  const byRawText = new Map<string, string>();
  const push = (raw: string, directive: string) => {
    const key = raw.replace(/\s+/g, '').toLowerCase();
    if (key && !byRawText.has(key)) byRawText.set(key, directive);
  };
  for (const diff of report.differences) {
    const text = diff.text.trim();
    if (!text) continue;
    switch (diff.kind) {
      case 'missing':
        push(text, `必须包含：${text}`);
        break;
      case 'extra':
        push(text, `移除画面中的：${text}`);
        break;
      case 'layout':
        push(text, `构图修正：${text}`);
        break;
      case 'style':
        push(text, `风格修正：${text}`);
        break;
      case 'lighting':
        push(text, `光线修正：${text}`);
        break;
      case 'color':
        push(text, `色彩修正：${text}`);
        break;
      case 'text':
        push(text, `文字修正：${text}`);
        break;
    }
  }
  // 双图评审直接给出的可执行修正指令（模型产出，中文短语）
  for (const rec of report.recommendations) {
    const text = rec.trim();
    if (text) push(text, text);
  }
  return [...byRawText.values()];
}

/**
 * 增量修正：原 Prompt 保持不动，把本轮修正指令作为「复刻修正要求」块追加。
 * 这样每轮只叠加"差异修复"，不推翻上一轮已验证的部分。
 */
export function applyRecreationCorrection(
  current: ReversePromptResult,
  report: SimilarityReport,
): OptimizationResult {
  const directives = correctionDirectives(report);
  if (directives.length === 0) {
    return {
      prompt: current.prompt,
      negativePrompt: current.negativePrompt,
      appliedCorrections: [],
      changeLog: ['本轮未发现可修正的具体差异，Prompt 保持不变。'],
    };
  }

  // 修正指令拼入 Prompt 尾部（detail 节之后），以明确的块标记隔开
  const correctionBlock = directives.map(d => `- ${d}`).join('\n');
  const prompt = `${current.prompt}\n\n复刻修正要求（以下为与参考图的差异修正，必须遵循）：\n${correctionBlock}`;

  // 缺失元素同时进入负面词（防生成侧"多余/缺失"反复合唱）
  const missingExtras = report.differences
    .filter(d => d.kind === 'extra')
    .map(d => d.text.trim())
    .filter(Boolean);
  const negativePrompt = missingExtras.length > 0
    ? `${current.negativePrompt}，${missingExtras.slice(0, 4).join('，')}`
    : current.negativePrompt;

  return {
    prompt,
    negativePrompt,
    appliedCorrections: directives,
    changeLog: directives,
  };
}

/** 供测试与 UI 展示的分节重建（不参与实际流程） */
export function rebuildSections(sections: PromptSections): string {
  return (Object.keys(sections) as (keyof PromptSections)[])
    .map(key => sections[key])
    .filter(Boolean)
    .join('，');
}
