import { create } from 'zustand';
import type { CreateTaskParams, Task, TaskStage } from '../types';
import { api } from '../services/api';
import { serverApi } from '../services/serverApi';
import { useAuthStore } from './useAuthStore';
import { useSettingsStore } from './useSettingsStore';
import { explainError, isAuthError } from '../utils/errors';

// 防止并发 loadTasks 重复上报同一批完成任务
const reportedKeys = new Set<string>();

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
let taskEventBridgeTimer: number | null = null;

/**
 * 全局单点 task-updated 订阅：App 启动后调用一次。
 * 组件（ImageStudio / TaskQueue / Chat）不再各自 listen，避免重复注册与重复全量刷新；
 * 事件以 200ms 去抖合并，仅刷新 store（tasksById 语义由 task.id 保持，不产生重复条目）。
 */
export function ensureTaskEventBridge() {
  if (taskEventBridgeBound) return;
  taskEventBridgeBound = true;
  void api.onTaskUpdated(() => {
    if (taskEventBridgeTimer !== null) return;
    taskEventBridgeTimer = window.setTimeout(() => {
      taskEventBridgeTimer = null;
      void useTaskStore.getState().loadTasks();
    }, 200);
  });
}

interface TaskState {
  tasks: Task[];
  loading: boolean;
  loadTasks: () => Promise<void>;
  addTask: (task: Task) => void;
  updateTask: (updated: Task) => void;
  getTask: (taskId: string) => Task | undefined;
  createAndExecuteTask: (params: CreateTaskParams) => Promise<Task>;
  retryTask: (taskId: string) => Promise<Task>;
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
    } catch {
      set({ loading: false });
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
    const retried = await api.retryTask(taskId);
    knownTaskIds.add(retried.id);
    await get().loadTasks();
    console.log('[TaskExecution] task retried', retried.id);
    return retried;
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
    const { settings } = useSettingsStore.getState();
    if (!isLoggedIn) return;

    const prevSubStatus: Record<string, string> = {};
    for (const t of prevTasks) {
      for (const st of t.sub_tasks || []) {
        prevSubStatus[`${t.id}:${st.index}`] = st.status;
      }
    }

    let newlyCompleted = 0;
    for (const t of nextTasks) {
      for (const st of t.sub_tasks || []) {
        const key = `${t.id}:${st.index}`;
        // 用全局 Set 去重，同一个 sub_task 只上报一次
        if (st.status === 'completed' && !reportedKeys.has(key)) {
          const prev = prevSubStatus[key];
          if (prev && prev !== 'completed') {
            reportedKeys.add(key);
            newlyCompleted++;
          }
        }
      }
    }

    if (newlyCompleted > 0) {
      console.log('[reportImage] 上报批量图片用量: model=gpt-image-2, count=', newlyCompleted);
      serverApi.reportImage('gpt-image-2', newlyCompleted).then(res => {
        console.log('[reportImage] 上报成功:', res);
        const auth = useAuthStore.getState();
        if (res.group) auth.updateTokenBalance(res.group, res.balance_usd);
        if (res.account_type) auth.updateAccountType(res.account_type);
        if (!res.group) auth.refreshUser();
      }).catch((err: any) => {
        console.error('[reportImage] 上报失败:', err);
        if (isAuthError(err)) {
          useAuthStore.getState().logout();
          useAuthStore.getState().showAuthPrompt();
        }
        console.warn('图片用量上报失败:', explainError(err));
      });
    }
  },
}));
