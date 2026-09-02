/**
 * AI 漫画规划真实进度（Phase 1.1 §二/§十三 + V4.2.9 审计 17 §二）—— 阶段型进度
 * 状态模型（纯函数层），镜像 vision/optimizeProgress.ts 先例（V6.8 §五）。
 *
 * Progress Honesty 铁律（cyimagepro-ui 规则 29/32 + V4.2.9 裁定）：
 *  - 进度对象只保存真实事实：当前阶段（status）、开始时间（startedAt）、错误文本；
 *    绝不保存 / 累积 percent 字段，禁止按 time/random 递增百分比；
 *  - V4.2.9：规划是单次 LLM 调用，阶段锚点百分比（resolving=10/planning=40/…）
 *    会被用户读成真实生成进度 → **百分比派生整体移除**，等待感由
 *    「阶段清单（✓/●/○）+ 已用时 X 秒（每秒真实计时）+ 不确定态动画」表达；
 *  - 阶段事件来自真实管道边界：resolving（resolveModelForRole 只读解析，UI 发起前）、
 *    planning（runAgentRequest 发出）/ validating（回复解析校验）/ retrying（首次结果无效
 *    进入第二次尝试）——全部由 comicPlanner onStage 回调派发；LLM 内部阶段不可观察，不伪造。
 */

export type ComicPlannerProgressStatus =
  | 'idle'
  | 'resolving'
  | 'planning'
  | 'validating'
  | 'retrying'
  | 'completed'
  | 'failed';

/** 运行中状态（非终态）。 */
export const COMIC_PLANNER_RUNNING_STATUSES: readonly ComicPlannerProgressStatus[] = [
  'resolving',
  'planning',
  'validating',
  'retrying',
];

export function isComicPlannerRunning(status: ComicPlannerProgressStatus): boolean {
  return COMIC_PLANNER_RUNNING_STATUSES.includes(status);
}

/** 阶段中文标签（唯一来源，UI 禁止另行拼写）。 */
export const COMIC_PLANNER_STAGE_LABEL: Readonly<Record<ComicPlannerProgressStatus, string>> = {
  idle: '待启动',
  resolving: '解析模型连接',
  planning: 'AI 规划中',
  validating: '校验返回结果',
  retrying: '首次结果无效 · 自动重试',
  completed: '完成',
  failed: '失败',
};

/** 已用时秒数（每秒由 UI 重算；这是真实计时，不是伪进度）。 */
export function comicPlannerElapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** 进度条状态 tone（运行中 / 完成 / 失败；决定颜色与不确定态动画）。 */
export function comicPlannerProgressTone(
  status: ComicPlannerProgressStatus,
): 'running' | 'completed' | 'failed' {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  return 'running';
}

/** onStage 服务回调 → 进度状态映射（planning/validating/retrying 原样；终态由调用结果写入）。 */
export function comicPlannerStageToStatus(
  stage: 'planning' | 'validating' | 'retrying',
): ComicPlannerProgressStatus {
  return stage;
}
