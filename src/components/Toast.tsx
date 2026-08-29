import { create } from 'zustand';
import { useEffect } from 'react';
import './Toast.css';

export type ToastKind = 'success' | 'error' | 'warning' | 'info' | 'loading';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  /** 标题（与正文分层展示）；未显式传入时按类型给默认标题。 */
  title: string;
  action?: { label: string; onClick: () => void };
}

interface ToastState {
  toasts: ToastItem[];
  push: (kind: ToastKind, message: string, title?: string, action?: ToastItem['action']) => number;
  dismiss: (id: number) => void;
  /** 更新已有 toast 的文案（loading 进度场景：一条 toast 走完全部状态） */
  update: (id: number, message: string, kind?: ToastKind, title?: string) => void;
}

let toastSeq = 0;

/** 各类型默认标题：成功 / 失败 / 警告 / 提示必须有层次，不允许“一串灰白字”。 */
export const DEFAULT_TOAST_TITLES: Record<ToastKind, string> = {
  success: '成功',
  error: '操作失败',
  warning: '注意',
  info: '提示',
  loading: '进行中',
};

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, message, title, action) => {
    const id = ++toastSeq;
    set(state => ({
      toasts: [...state.toasts, {
        id,
        kind,
        message,
        title: title?.trim() || DEFAULT_TOAST_TITLES[kind],
        ...(action ? { action } : {}),
      }],
    }));
    if (kind !== 'loading') {
      const timer = setTimeout(() => get().dismiss(id), 3600);
      if (typeof timer.unref === 'function') timer.unref();
    }
    return id;
  },
  dismiss: id => set(state => ({ toasts: state.toasts.filter(item => item.id !== id) })),
  update: (id, message, kind, title) => set(state => ({
    toasts: state.toasts.map(item => (item.id === id
      ? { ...item, message, kind: kind ?? item.kind, title: title?.trim() || (kind ? DEFAULT_TOAST_TITLES[kind] : item.title) }
      : item)),
  })),
}));

export function toastSuccess(message: string, title?: string, action?: ToastItem['action']) {
  useToastStore.getState().push('success', message, title, action);
}

export function toastError(message: string, title?: string) {
  useToastStore.getState().push('error', message, title);
}

export function toastWarning(message: string, title?: string, action?: ToastItem['action']) {
  useToastStore.getState().push('warning', message, title, action);
}

export function toastInfo(message: string, title?: string) {
  useToastStore.getState().push('info', message, title);
}

/** loading toast 不自动消失：进度更新用 toastUpdate，结束必须 toastDismiss / toastFinish */
export function toastLoading(message: string, title?: string): number {
  return useToastStore.getState().push('loading', message, title);
}

export function toastUpdate(id: number, message: string, kind?: ToastKind, title?: string) {
  useToastStore.getState().update(id, message, kind, title);
}

export function toastDismiss(id: number) {
  useToastStore.getState().dismiss(id);
}

const TOAST_ICONS: Record<ToastKind, string> = {
  success: '✓',
  error: '!',
  warning: '!',
  info: 'i',
  loading: '',
};

function ToastItemView({ item }: { item: ToastItem }) {
  const dismiss = useToastStore(state => state.dismiss);
  useEffect(() => {
    if (item.kind === 'loading') return;
    const timer = setTimeout(() => dismiss(item.id), 3600);
    return () => clearTimeout(timer);
  }, [item.id, item.kind, dismiss]);

  return (
    <div className={`toast-item toast-${item.kind}`} role="status" aria-live={item.kind === 'error' ? 'assertive' : 'polite'}>
      <span className="toast-icon" aria-hidden="true">
        {item.kind === 'loading' ? <span className="toast-spinner" /> : TOAST_ICONS[item.kind]}
      </span>
      <span className="toast-content">
        <span className="toast-title">{item.title}</span>
        {item.message && item.message !== item.title && (
          <span className="toast-message">{item.message}</span>
        )}
      </span>
      {item.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            item.action?.onClick();
            dismiss(item.id);
          }}
        >{item.action.label}</button>
      )}
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
