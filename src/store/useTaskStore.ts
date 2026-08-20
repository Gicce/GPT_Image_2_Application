import { create } from 'zustand';
import type { CreateTaskParams, Task, TaskStage } from '../types';
import { TERMINAL_TASK_STATUSES } from '../types';
import { api } from '../services/api';
import { useAuthStore } from './useAuthStore';
import { isAuthError } from '../utils/errors';
import {
  authorizeImageTask,
  settleImageTask,
  registerTaskAuthorization,
  takeTaskAuthorization,
  createRequestId,
} from '../services/billingService';

// 进行中任务的"恢复降级"用集合：记录已知存在过的 taskId
const knownTaskIds = new Set<string>();

/** 统一排序：createdAt 倒序 + 按 id 去重（后出现的快照覆盖旧快照）。
 * tasks.json 为 push 顺序、最旧在前，不能直接作为"最近任务"依据；
 * 同一任务 running→succeeded 只保留最新快照，绝不显示成两条。 */
function sortTasksDesc(tasks: Task[]): Task[] {
  const byId = new Map<string, Task>();
  for (const task of tasks) byId.set(task.id, task);
  return [...byId.values()].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

let taskEventBridgeBound = false;
let taskEventBridgeTimer: ReturnType<typeof setTimeout> | null = null;
const pendingEventTaskIds = new Set<string>();
const taskRefreshHooks = new Set<(taskId: string) => void>();

/**
 * 注册“store 刷新完成后”钩子：事件 → 去抖 loadTasks（拿到最新快照）→ 按 taskId 回调。
 * 聊天任务卡同步必须挂在这里 —— 直接在事件回调里读 TaskStore 会读到上一次刷新的
 * 旧快照，最终终态（completed/failed）永远不会落到卡片上（V4.0.3 根因修复）。
 */
export function registerTaskRefreshHook(hook: (taskId: string) => void): () => void {
  taskRefreshHooks.add(hook);
  return () => taskRefreshHooks.delete(hook);
}

/**
 * 全局单点 task-updated 订阅：App 启动后调用一次。
 * 组件（ImageStudio / TaskQueue / Chat）不再各自 listen，避免重复注册与重复全量刷新；
 * 事件以 200ms 去抖合并，仅刷新 store（tasksById 语义由 task.id 保持，不产生重复条目）。
 * 刷新完成后触发 taskRefreshHooks —— 保证消费者看到的永远是刷新后的状态。
 */
export function ensureTaskEventBridge() {
  if (taskEventBridgeBound) return;
  taskEventBridgeBound = true;
  void api.onTaskUpdated((taskId: string) => {
    if (typeof taskId === 'string' && taskId) pendingEventTaskIds.add(taskId);
    if (taskEventBridgeTimer !== null) return;
    taskEventBridgeTimer = setTimeout(async () => {
      taskEventBridgeTimer = null;
      const ids = [...pendingEventTaskIds];
      pendingEventTaskIds.clear();
      const refreshed = await useTaskStore.getState().loadTasks();
      if (!refreshed) {
        // 刷新失败：没有新鲜快照可同步，钩子不触发（等待下一轮事件或 focus reconcile）
        return;
      }
      // 仅同步本次事件窗口内真正变化的任务，避免全量扫描所有会话
      for (const id of ids) {
        for (const hook of taskRefreshHooks) {
          try {
            hook(id);
          } catch (err) {
            console.warn('[TaskBridge] refresh hook failed', id, err);
          }
        }
      }
    }, 200);
  });
}

interface TaskState {
  tasks: Task[];
  loading: boolean;
  /** 返回是否成功读取到后端快照（事件桥据此决定是否通知消费者） */
  loadTasks: () => Promise<boolean>;
  addTask: (task: Task) => void;
  updateTask: (updated: Task) => void;
  getTask: (taskId: string) => Task | undefined;
  createAndExecuteTask: (params: CreateTaskParams) => Promise<Task>;
  retryTask: (taskId: string) => Promise<Task>;
  /** V4.0.5 只重试失败的子任务（指定下标 = 单个；缺省 = 全部失败项），已完成子任务保持原结果 */
  retryTaskFailed: (taskId: string, subTaskIndexes?: number[]) => Promise<{ resetIndexes: number[]; resetCount: number }>;
  refreshTask: (taskId: string) => Promise<void>;
  cancelTask: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string, deleteImages: boolean) => Promise<void>;
  reportNewlyCompleted: (prevTasks: Task[], nextTasks: Task[]) => void;
}

export function mapTaskToStage(task: Task): TaskStage {
  if (task.status === 'completed') return 'success';
  if (task.status === 'failed') return 'failed';
  if (task.status === 'cancelled') return 'cancelled';
  if (task.status === 'pending') return 'queued';
  if (task.status === 'running') {
    const total = task.count || 1;
    const done = task.success_count + task.failed_count;
    if (done >= total && task.success_count === 0) return 'running';
    return 'running';
  }
  return 'queued';
}

export function taskStageLabel(stage: TaskStage): string {
  switch (stage) {
    case 'waiting_confirm': return '等待确认';
    case 'queued': return '排队中';
    case 'analyzing': return '正在分析任务';
    case 'running': return '正在生成图片';
    case 'saving': return '正在保存结果';
    case 'success': return '已完成';
    case 'failed': return '执行失败';
    case 'cancelled': return '已取消';
    case 'interrupted': return '任务因应用中断未完成';
    default: return stage;
  }
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  loading: false,

  loadTasks: async () => {
    set({ loading: true });
    try {
      const prevTasks = get().tasks;
      const tasks = sortTasksDesc(await api.getTasks());
      // 先更新 tasks，再上报，防止并发调用重复计数
      set({ tasks, loading: false });
      for (const t of tasks) knownTaskIds.add(t.id);
      get().reportNewlyCompleted(prevTasks, tasks);
      return true;
    } catch {
      set({ loading: false });
      return false;
    }
  },

  addTask: (task) => {
    knownTaskIds.add(task.id);
    set({ tasks: [task, ...get().tasks] });
  },

  updateTask: (updated) => {
    knownTaskIds.add(updated.id);
    set({ tasks: get().tasks.map(t => t.id === updated.id ? updated : t) });
  },

  getTask: (taskId) => get().tasks.find(t => t.id === taskId),

  createAndExecuteTask: async (params) => {
    console.log('[AgentTask] create task', { prompt: params.prompt?.slice(0, 60), task_type: params.task_type });
    const task = await api.createTask(params);
    knownTaskIds.add(task.id);
    set({ tasks: [task, ...get().tasks.filter(t => t.id !== task.id)] });
    // 后端在创建任务后会自动开始执行；这里立即拉一次以同步最新状态
    try {
      await get().loadTasks();
    } catch (err) {
      console.warn('[AgentTask] loadTasks after create failed', err);
    }
    console.log('[TaskExecution] task started', task.id);
    return task;
  },

  retryTask: async (taskId) => {
    console.log('[AgentTask] retry task', taskId);
    // 重试会重新生成图片，属新的计费单元：先 authorize 预占，创建后登记
    const { isLoggedIn } = useAuthStore.getState();
    let requestId: string | undefined;
    if (isLoggedIn) {
      const original = get().tasks.find(t => t.id === taskId);
      const count = Math.max(1, original?.count ?? original?.sub_tasks?.length ?? 1);
      requestId = createRequestId('retry');
      await authorizeImageTask(requestId, count);
    }
    let retried: Task;
    try {
      retried = await api.retryTask(taskId);
    } catch (err) {
      if (requestId) void settleImageTask(requestId, false, 0, 'retry create failed');
      throw err;
    }
    knownTaskIds.add(retried.id);
    if (requestId) registerTaskAuthorization(retried.id, requestId);
    await get().loadTasks();
    console.log('[TaskExecution] task retried', retried.id);
    return retried;
  },

  retryTaskFailed: async (taskId, subTaskIndexes) => {
    console.log('[AgentTask] retry failed subtasks', taskId, subTaskIndexes ?? '(all failed)');
    const original = get().tasks.find(t => t.id === taskId);
    if (!original) throw new Error('任务不存在');
    const failedIndexes = subTaskIndexes
      ?? original.sub_tasks.map((st, i) => (st.status === 'failed' ? i : -1)).filter(i => i >= 0);
    if (failedIndexes.length === 0) throw new Error('没有可重试的失败子任务');

    // 部分重试只按本轮重试的槽位数预占；结算时也只数这些槽位（见 reportNewlyCompleted）
    const { isLoggedIn } = useAuthStore.getState();
    let requestId: string | undefined;
    if (isLoggedIn) {
      requestId = createRequestId('retry-sub');
      await authorizeImageTask(requestId, failedIndexes.length);
    }
    let result: { resetIndexes: number[]; resetCount: number };
    try {
      result = await api.retryTaskSubtasks(taskId, failedIndexes);
    } catch (err) {
      if (requestId) void settleImageTask(requestId, false, 0, 'retry-sub create failed');
      throw err;
    }
    if (requestId) registerTaskAuthorization(taskId, requestId, result.resetIndexes);
    await get().loadTasks();
    console.log('[TaskExecution] failed subtasks retried', taskId, result.resetIndexes);
    return result;
  },

  refreshTask: async (taskId) => {
    const prevTasks = get().tasks;
    const tasks = sortTasksDesc(await api.getTasks());
    for (const t of tasks) knownTaskIds.add(t.id);
    // 先更新 tasks，再上报
    set({ tasks });
    get().reportNewlyCompleted(prevTasks, tasks);
    // 若任务存在过但现在不在列表里，不在此处强制清理；上层处理
    void taskId;
  },

  cancelTask: async (taskId) => {
    await api.cancelTask(taskId);
    const tasks = sortTasksDesc(await api.getTasks());
    set({ tasks });
  },

  deleteTask: async (taskId, deleteImages) => {
    await api.deleteTask(taskId, deleteImages);
    knownTaskIds.delete(taskId);
    set({ tasks: get().tasks.filter(t => t.id !== taskId) });
  },

  reportNewlyCompleted: (prevTasks, nextTasks) => {
    const { isLoggedIn } = useAuthStore.getState();
    if (!isLoggedIn) return;
    void prevTasks;

    // V4 两阶段计费：任务到达终态后，按创建时登记的 request_id 结算
    // （取后即删，天然幂等；未登记的任务——如应用重启后创建前丢失——依赖服务端 2h 自动释放兜底）
    for (const t of nextTasks) {
      if (!TERMINAL_TASK_STATUSES.has(t.status)) continue;
      const auth = takeTaskAuthorization(t.id);
      if (!auth) continue;
      const requestId = auth.requestId;
      // 部分重试：只数本轮重试槽位的最终完成数，上一轮已结算的成功子任务绝不重复计入
      const completed = auth.retriedIndexes
        ? auth.retriedIndexes.filter(i => t.sub_tasks?.[i]?.status === 'completed').length
        : (t.success_count ?? (t.sub_tasks || []).filter(st => st.status === 'completed').length);
      const success = completed > 0;
      console.log('[billing] settle task', t.id, { requestId, success, completed, retried: auth.retriedIndexes?.length ?? 0 });
      settleImageTask(requestId, success, completed, success ? undefined : `task ${t.status}`).catch(err => {
        console.warn('[billing] settle task failed:', t.id, err);
        if (isAuthError(err)) {
          useAuthStore.getState().logout();
          useAuthStore.getState().showAuthPrompt();
        }
      });
    }
  },
}));
