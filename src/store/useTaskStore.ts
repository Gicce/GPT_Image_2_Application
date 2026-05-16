import { create } from 'zustand';
import type { Task } from '../types';
import { api } from '../services/api';
import { serverApi } from '../services/serverApi';
import { useAuthStore } from './useAuthStore';
import { useSettingsStore } from './useSettingsStore';
import { explainError, isAuthError } from '../utils/errors';

// 防止并发 loadTasks 重复上报同一批完成任务
const reportedKeys = new Set<string>();

interface TaskState {
  tasks: Task[];
  loading: boolean;
  loadTasks: () => Promise<void>;
  addTask: (task: Task) => void;
  updateTask: (updated: Task) => void;
  refreshTask: (taskId: string) => Promise<void>;
  cancelTask: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string, deleteImages: boolean) => Promise<void>;
  reportNewlyCompleted: (prevTasks: Task[], nextTasks: Task[]) => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  loading: false,

  loadTasks: async () => {
    set({ loading: true });
    try {
      const prevTasks = get().tasks;
      const tasks = await api.getTasks();
      // 先更新 tasks，再上报，防止并发调用重复计数
      set({ tasks, loading: false });
      get().reportNewlyCompleted(prevTasks, tasks);
    } catch {
      set({ loading: false });
    }
  },

  addTask: (task) => {
    set({ tasks: [task, ...get().tasks] });
  },

  updateTask: (updated) => {
    set({ tasks: get().tasks.map(t => t.id === updated.id ? updated : t) });
  },

  refreshTask: async (taskId) => {
    const prevTasks = get().tasks;
    const tasks = await api.getTasks();
    // 先更新 tasks，再上报
    set({ tasks });
    get().reportNewlyCompleted(prevTasks, tasks);
  },

  cancelTask: async (taskId) => {
    await api.cancelTask(taskId);
    const tasks = await api.getTasks();
    set({ tasks });
  },

  deleteTask: async (taskId, deleteImages) => {
    await api.deleteTask(taskId, deleteImages);
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
      serverApi.reportImage('gpt-image-2', newlyCompleted).then(res => {
        const auth = useAuthStore.getState();
        if (res.group) auth.updateTokenBalance(res.group, res.balance_usd);
        if (res.account_type) auth.updateAccountType(res.account_type);
        if (!res.group) auth.refreshUser();
      }).catch((err: any) => {
        if (isAuthError(err)) {
          useAuthStore.getState().logout();
          useAuthStore.getState().showAuthPrompt();
        }
        console.warn('图片用量上报失败:', explainError(err));
      });
    }
  },
}));
