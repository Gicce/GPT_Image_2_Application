/**
 * useTaskBillingStore — 任务计费展示侧车（Task Billing Display）
 *
 * 记录每个任务的 预计/实际 消耗点数（来自 authorize / settle 响应），
 * 供任务队列与历史的「计费」列展示。授权真相在服务端 billing_transactions；
 * 本 store 仅为展示缓存（localStorage 持久化，重启不丢）。
 */

import { create } from 'zustand';

export interface TaskBillingInfo {
  requestId: string;
  /** authorize 预占点数（预计消耗） */
  estimated?: number;
  /** settle 实际计费点数（成功张数 × 单张） */
  actual?: number;
  unit?: number | null;
  /** settle 状态（SUCCESS / FAILED / RELEASED…） */
  status?: string;
  settledAt?: string;
}

interface TaskBillingState {
  billing: Record<string, TaskBillingInfo>;
  recordAuthorize: (taskId: string, info: TaskBillingInfo) => void;
  recordSettle: (requestId: string, actual: number, status: string) => void;
  getByTaskId: (taskId: string) => TaskBillingInfo | undefined;
}

const STORAGE_KEY = 'cy_task_billing';
const MAX_ENTRIES = 500;

function load(): Record<string, TaskBillingInfo> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persist(billing: Record<string, TaskBillingInfo>) {
  try {
    const keys = Object.keys(billing);
    if (keys.length > MAX_ENTRIES) {
      const trimmed: Record<string, TaskBillingInfo> = {};
      for (const k of keys.slice(-MAX_ENTRIES)) trimmed[k] = billing[k];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(billing));
  } catch { /* 存储满等异常不阻断计费 */ }
}

export const useTaskBillingStore = create<TaskBillingState>((set, get) => ({
  billing: load(),

  recordAuthorize: (taskId, info) => {
    const billing = { ...get().billing, [taskId]: info };
    persist(billing);
    set({ billing });
  },

  recordSettle: (requestId, actual, status) => {
    const billing = { ...get().billing };
    const entry = Object.values(billing).find(b => b.requestId === requestId);
    if (!entry) return;
    entry.actual = actual;
    entry.status = status;
    entry.settledAt = new Date().toISOString();
    persist(billing);
    set({ billing });
  },

  getByTaskId: (taskId) => get().billing[taskId],
}));
