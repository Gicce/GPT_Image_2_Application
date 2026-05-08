import { create } from 'zustand';
import type { Task } from '../types';
import { api } from '../services/api';

interface TaskState {
  tasks: Task[];
  loading: boolean;
  loadTasks: () => Promise<void>;
  addTask: (task: Task) => void;
  updateTask: (updated: Task) => void;
  refreshTask: (taskId: string) => Promise<void>;
  cancelTask: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string, deleteImages: boolean) => Promise<void>;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  loading: false,

  loadTasks: async () => {
    set({ loading: true });
    try {
      const tasks = await api.getTasks();
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
    const tasks = await api.getTasks();
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
}));
