/**
 * 任务执行耗时工具 —— TaskMessageState.executionStartedAt / executionFinishedAt /
 * executionDurationMs 的格式化与推导。
 *
 * 设计约束（spec 第六十六 ~ 一百零二节）：
 *   - 最终 duration 持久化在 TaskMessageState（事实源），不在 React state。
 *   - 实时 timer 由 UI 层（250ms interval）用 Date.now() - executionStartedAt 计算，
 *     组件卸载必须 clearInterval。
 *   - 多任务并发：每个任务卡各自持有 executionStartedAt，互不干扰。
 *   - Planning / 等待确认耗时绝不计入执行耗时 —— 计时从用户"确认执行"那一刻开始。
 */

/**
 * 中文用户友好的耗时格式。
 *   < 1s        → "0.8 秒"
 *   < 60s       → "18.4 秒"
 *   >= 60s      → "1分12.4秒"
 */
export function formatDuration(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) {
    return `${(ms / 1000).toFixed(1)} 秒`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} 秒`;
  }
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const remainSeconds = totalSeconds - minutes * 60;
  return `${minutes}分${remainSeconds.toFixed(1)}秒`;
}

/** 精确毫秒形式，用于任务详情："12.846 秒（12846 ms）"。 */
export function formatDurationPrecise(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  return `${(ms / 1000).toFixed(3)} 秒（${Math.round(ms)} ms）`;
}

/**
 * 从 startedAt / finishedAt（ISO 字符串或 epoch ms）推导 duration ms。
 * 任一缺失或时间非法时返回 null —— 调用方据此决定是否显示耗时。
 */
export function computeDurationMs(
  startedAt: string | number | undefined | null,
  finishedAt: string | number | undefined | null,
): number | null {
  const start = toEpochMs(startedAt);
  const end = toEpochMs(finishedAt);
  if (start == null || end == null) return null;
  const duration = end - start;
  return duration >= 0 ? duration : null;
}

function toEpochMs(value: string | number | undefined | null): number | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 执行中任务的实时已耗时（ms）。
 * 任务不在执行阶段（没有 startedAt 或已有 durationMs）时返回 null。
 */
export function liveElapsedMs(
  startedAt: string | number | undefined | null,
  now: number = Date.now(),
): number | null {
  const start = toEpochMs(startedAt);
  if (start == null) return null;
  const elapsed = now - start;
  return elapsed >= 0 ? elapsed : 0;
}

/**
 * App Restart 中断恢复审计（spec 六十三）：磁盘上读到 stage 仍为 running 但
 * executionStartedAt 是旧 session 的任务时，用"发现中断的时刻"封顶 duration，
 * 避免一直累加成离谱时间。调用方应在 loadConversations 的 interrupted 分支调用。
 */
export function capInterruptedDuration(
  startedAt: string | number | undefined | null,
  discoveredAt: number = Date.now(),
): number | null {
  return computeDurationMs(startedAt, discoveredAt);
}

/** 按任务类型给出执行中的动词文案："正在生成图片" / "正在编辑图片" / "正在执行"。 */
export function executionVerbLabel(taskType?: string, resolvedTaskKind?: string): string {
  if (taskType === 'edit' || resolvedTaskKind === 'image_edit' || resolvedTaskKind === 'image_reference_generation') {
    return '正在编辑图片';
  }
  if (taskType === 'remove_background') {
    return '正在执行';
  }
  return '正在生成图片';
}
