/**
 * TaskQueue → History 任务详情深链（V4.1）。
 *
 * 单一详情原则：TaskQueue 只做运营状态，点「查看任务详情」复用 History
 * 的同一套 Task Detail，绝不另造第二套详情弹层。
 * 实现沿用既有 cyimage-navigate 全局导航事件 + localStorage 传参模式
 * （与 cy_taskqueue_focus_id 同构）：History 挂载 / 任务加载后按键精确选中。
 */

export const HISTORY_FOCUS_KEY = 'cy_history_focus_task_id';

/** 从任务队列一键进入历史记录中该任务的详情（列表选中 + 详情自动打开）。 */
export function openTaskDetailFromQueue(taskId: string) {
  try {
    localStorage.setItem(HISTORY_FOCUS_KEY, taskId);
  } catch {}
  window.dispatchEvent(
    new CustomEvent('cyimage-navigate', { detail: { page: 'history', focusTaskId: taskId } }),
  );
}
