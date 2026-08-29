/**
 * Prompt 优化真实进度（V6.8 §五）—— 阶段型进度状态模型（纯函数层）。
 *
 * Progress Honesty 铁律（Skill §36）：
 *  - 进度对象只保存真实事实：当前阶段（status）、开始时间（startedAt）、错误文本；
 *    绝不保存 / 累积 percent 字段，禁止 setInterval 按 time/random 递增百分比；
 *  - UI 的百分比 = 阶段锚点的纯派生（deriveOptimizationPercent），只随真实阶段切换跳变；
 *    阶段内的等待感由「已用时 X 秒」（每秒真实计时）与不确定态动画表达；
 *  - 阶段事件由 runner（页面 optimizeRecreationPrompt + 服务层 onStage 回调）在真实
 *    边界触发：收集参考图（collecting）→ 模型请求（optimizing）→ 校验返回（validating）；
 *    queued / normalizing / analyzing 为 SSE 细化预留，当前链路不派发（不伪造）。
 */

export type PromptOptimizationStatus =
  | 'idle'
  | 'queued'
  | 'collecting'
  | 'normalizing'
  | 'analyzing'
  | 'optimizing'
  | 'validating'
  | 'completed'
  | 'failed';

/** 运行中状态（非终态）。 */
export const OPTIMIZATION_RUNNING_STATUSES: readonly PromptOptimizationStatus[] = [
  'queued',
  'collecting',
  'normalizing',
  'analyzing',
  'optimizing',
  'validating',
];

export function isOptimizationRunning(status: PromptOptimizationStatus): boolean {
  return OPTIMIZATION_RUNNING_STATUSES.includes(status);
}

/**
 * 阶段 → 进度锚点（百分比只能来源于这里的真实阶段切换）。
 * idle / failed 无百分比（失败显示真实错误，绝不显示伪进度）。
 */
export const OPTIMIZATION_STAGE_PERCENT: Readonly<Record<PromptOptimizationStatus, number | null>> = {
  idle: null,
  queued: 5,
  collecting: 10,
  normalizing: 25,
  analyzing: 45,
  optimizing: 70,
  validating: 90,
  completed: 100,
  failed: null,
};

/** 当前链路实际会经过的阶段（ordered；驱动进度条分段文案与测试断言）。 */
export const OPTIMIZATION_ACTIVE_STAGES: readonly PromptOptimizationStatus[] = [
  'collecting',
  'optimizing',
  'validating',
];

/** 阶段中文标签（唯一来源，UI 禁止另行拼写）。 */
export const OPTIMIZATION_STAGE_LABEL: Readonly<Record<PromptOptimizationStatus, string>> = {
  idle: '待优化',
  queued: '排队中',
  collecting: '收集修改意图与参考图',
  normalizing: '整理修改意图',
  analyzing: '分析画面结构',
  optimizing: 'AI 优化 Prompt',
  validating: '校验优化结果',
  completed: '优化完成',
  failed: '优化失败',
};

/** 派生百分比：只随真实阶段切换跳变（未开始 / 失败 = null，不显示数值）。 */
export function deriveOptimizationPercent(status: PromptOptimizationStatus): number | null {
  return OPTIMIZATION_STAGE_PERCENT[status];
}

/** 已用时秒数（每秒由 UI 重算；这是真实计时，不是伪进度）。 */
export function optimizationElapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** 进度条状态 tone（运行中 / 完成 / 失败；决定颜色与不确定态动画）。 */
export function optimizationProgressTone(status: PromptOptimizationStatus): 'running' | 'completed' | 'failed' {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  return 'running';
}
