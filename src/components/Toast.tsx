import { create } from 'zustand';
import { useEffect } from 'react';
import './Toast.css';

export type ToastKind = 'success' | 'error' | 'info' | 'loading';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastState {
  toasts: ToastItem[];
  push: (kind: ToastKind, message: string) => number;
  dismiss: (id: number) => void;
  /** 更新已有 toast 的文案（loading 进度场景：一条 toast 走完全部状态） */
  update: (id: number, message: string, kind?: ToastKind) => void;
}

let toastSeq = 0;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, message) => {
    const id = ++toastSeq;
    set(state => ({ toasts: [...state.toasts, { id, kind, message }] }));
    if (kind !== 'loading') {
      const timer = setTimeout(() => get().dismiss(id), 3200);
      if (typeof timer.unref === 'function') timer.unref();
    }
    return id;
  },
  dismiss: id => set(state => ({ toasts: state.toasts.filter(item => item.id !== id) })),
  update: (id, message, kind) => set(state => ({
    toasts: state.toasts.map(item => (item.id === id ? { ...item, message, kind: kind ?? item.kind } : item)),
  })),
}));

export function toastSuccess(message: string) {
  useToastStore.getState().push('success', message);
}

export function toastError(message: string) {
  useToastStore.getState().push('error', message);
}

export function toastInfo(message: string) {
  useToastStore.getState().push('info', message);
}

/** loading toast 不自动消失：进度更新用 toastUpdate，结束必须 toastDismiss / toastFinish */
export function toastLoading(message: string): number {
  return useToastStore.getState().push('loading', message);
}

export function toastUpdate(id: number, message: string, kind?: ToastKind) {
  useToastStore.getState().update(id, message, kind);
}

export function toastDismiss(id: number) {
  useToastStore.getState().dismiss(id);
}

const TOAST_ICONS: Record<ToastKind, string> = {
  success: '✓',
  error: '!',
  info: 'i',
  loading: '',
};

function ToastItemView({ item }: { item: ToastItem }) {
  const dismiss = useToastStore(state => state.dismiss);
  useEffect(() => {
    if (item.kind === 'loading') return;
    const timer = setTimeout(() => dismiss(item.id), 3200);
    return () => clearTimeout(timer);
  }, [item.id, item.kind, dismiss]);

  return (
    <div className={`toast-item toast-${item.kind}`} role="status" aria-live={item.kind === 'error' ? 'assertive' : 'polite'}>
      <span className="toast-icon" aria-hidden="true">
        {item.kind === 'loading' ? <span className="toast-spinner" /> : TOAST_ICONS[item.kind]}
      </span>
      <span className="toast-message">{item.message}</span>
      <button className="toast-close" onClick={() => dismiss(item.id)} aria-label="关闭提示">×</button>
    </div>
  );
}

export function ToastHost() {
  const toasts = useToastStore(state => state.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host">
      {toasts.map(item => <ToastItemView key={item.id} item={item} />)}
    </div>
  );
}
