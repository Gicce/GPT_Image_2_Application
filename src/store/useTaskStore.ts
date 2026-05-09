import { create } from 'zustand';
import type { Task } from '../types';
import { api } from '../services/api';
import { serverApi } from '../services/serverApi';
import { useAuthStore } from './useAuthStore';
import { useSettingsStore } from './useSettingsStore';

interface TaskState {
  tasks: Task[];
  loading: boolean;
  loadTasks: () => Promise<void>;
  addTask: (task: Task) => void;
  updateTask: (updated: Task) => void;
  refreshTask: (taskId: string) => Promise<void>;
  cancelTask: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string, deleteImages: boolean) => Promise<void>;
  // 对比前后任务列表，上报新完成的 sub_task
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
      get().reportNewlyCompleted(prevTasks, tasks);
      set({ tasks, loading: false });
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
    get().reportNewlyCompleted(prevTasks, tasks);
    set({ tasks });
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
    if (!isLoggedIn || !settings.server_url) return;

    // Build index: taskId + subTask.index → prev status
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
        const prev = prevSubStatus[key];
        if (st.status === 'completed' && prev && prev !== 'completed') {
          newlyCompleted++;
        }
      }
    }

    if (newlyCompleted > 0) {
      serverApi.reportImage('gpt-image-2', newlyCompleted).then(res => {
        useAuthStore.getState().updateBalance(res.balance_usd);
      }).catch(() => {});
    }
  },
}));
