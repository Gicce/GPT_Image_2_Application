/**
 * 任务图片绑定状态模型（V4.0.8 修复）。
 *
 * 历史问题：旧实现用 `active_image_id == null` 判断"需要自动绑定"，
 * 但空绑定有两种完全不同的含义：
 *   A. 会话尚未初始化任务图片（可以自动绑定最近结果图）
 *   B. 用户明确解绑了所有任务图片（绝不允许自动补回）
 * 两者混用导致「用户点 X 删除 → 切页面回来 → 图片复活」。
 *
 * 四态语义：
 *   uninitialized —— 会话从未做过任务图片决策，允许一次自动绑定
 *   auto          —— 当前绑定来自系统（恢复 / 任务成功推进）
 *   manual        —— 当前图片来自用户主动行为（本地选择 / 拖入 / 图库 / 显式绑定）
 *   none          —— 用户明确选择本会话不绑定任何任务图片，持久化拒绝自动绑定
 */

export type TaskImageBindingMode = 'uninitialized' | 'auto' | 'manual' | 'none';

export interface TaskImageBindingFacts {
  active_image_binding?: TaskImageBindingMode | null;
  active_image_id?: string | null;
  active_image_source?: 'explicit' | 'auto' | null;
}

const SETTLED_MODES: TaskImageBindingMode[] = ['auto', 'manual', 'none'];

/**
 * 从会话持久化字段解析绑定状态（含旧数据迁移）：
 * - 有绑定图 → 按 source 归一为 auto / manual
 * - 无绑定图但已有明确标记（none/auto/manual）→ 保留标记（none = 用户明确解绑）
 * - 无绑定图也无标记 → uninitialized（旧数据 / 新会话，允许首次自动绑定）
 */
export function resolveStoredTaskImageBinding(facts: TaskImageBindingFacts): TaskImageBindingMode {
  if (facts.active_image_id) {
    if (facts.active_image_source === 'explicit') return 'manual';
    return facts.active_image_binding === 'manual' ? 'manual' : 'auto';
  }
  if (facts.active_image_binding && SETTLED_MODES.includes(facts.active_image_binding)) {
    return facts.active_image_binding;
  }
  return 'uninitialized';
}

/**
 * 用户显式变更（X 解绑 / 删除最后一张手动图片）后的绑定推导。
 * 优先级：手动图片存在 → manual；自动绑定图存在 → auto/manual（按来源）；
 * 全空 → 只有从未初始化的会话保持 uninitialized，其余收敛为 none
 * （"用户明确为空"是被持久化的有效状态，禁止再自动补图）。
 */
export function deriveTaskImageBindingAfterUserChange(input: {
  previousBinding: TaskImageBindingMode;
  hasActiveImage: boolean;
  activeImageSource?: 'explicit' | 'auto' | null;
  manualImageCount: number;
}): TaskImageBindingMode {
  if (input.manualImageCount > 0) return 'manual';
  if (input.hasActiveImage) {
    if (input.activeImageSource === 'explicit') return 'manual';
    return input.previousBinding === 'manual' ? 'manual' : 'auto';
  }
  return input.previousBinding === 'uninitialized' ? 'uninitialized' : 'none';
}

/** 自动绑定（restoreActiveImageIds）只允许发生在 uninitialized 会话上。 */
export function canAutoBindTaskImage(binding: TaskImageBindingMode): boolean {
  return binding === 'uninitialized';
}

/**
 * 任务成功后是否允许把 active_image 推进为最新结果图。
 * none —— 用户已明确拒绝绑定，新结果也绝不自动绑定（需求：none 不被新生成图覆盖）。
 * 其余状态沿用"只前进不回退"守卫；时间不可比时保守放行（与旧行为一致，
 * 避免旧数据无 set_at 时会话卡死在旧图）。
 */
export function shouldAdvanceActiveImageOnTaskSuccess(input: {
  binding: TaskImageBindingMode;
  candidateAtMs: number;
  currentAtMs: number;
}): boolean {
  if (input.binding === 'none') return false;
  if (!Number.isFinite(input.candidateAtMs) || !Number.isFinite(input.currentAtMs)) return true;
  return input.candidateAtMs >= input.currentAtMs;
}
