import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_TOAST_TITLES,
  toastDismiss,
  toastError,
  toastInfo,
  toastLoading,
  toastSuccess,
  toastUpdate,
  toastWarning,
  useToastStore,
} from '../Toast';

/**
 * Toast 体系契约：
 * 1) success / error / warning / info / loading 五态齐全（含默认标题分层）；
 * 2) 深浅主题高对比度 —— 历史缺陷：曾引用 App.css 不存在的 --bg-elevated / --border-color，
 *    深色主题白底白字完全不可读；CSS 回归守卫禁止再引用未定义变量。
 */

describe('Toast store（五态 + 标题分层）', () => {
  beforeEach(() => {
    useToastStore.getState().toasts.forEach(t => toastDismiss(t.id));
  });

  it('success / error / warning / info 各自入队且带默认标题', () => {
    toastSuccess('已复制');
    toastError('优化失败');
    toastWarning('余额不足');
    toastInfo('提示内容');
    const toasts = useToastStore.getState().toasts;
    expect(toasts.map(t => t.kind)).toEqual(['success', 'error', 'warning', 'info']);
    expect(toasts.map(t => t.title)).toEqual([
      DEFAULT_TOAST_TITLES.success,
      DEFAULT_TOAST_TITLES.error,
      DEFAULT_TOAST_TITLES.warning,
      DEFAULT_TOAST_TITLES.info,
    ]);
    expect(toasts.map(t => t.message)).toEqual(['已复制', '优化失败', '余额不足', '提示内容']);
  });

  it('默认标题按类型区分：成功 / 失败 / 注意 / 提示 / 进行中', () => {
    expect(DEFAULT_TOAST_TITLES.success).toBe('成功');
    expect(DEFAULT_TOAST_TITLES.error).toBe('操作失败');
    expect(DEFAULT_TOAST_TITLES.warning).toBe('注意');
    expect(DEFAULT_TOAST_TITLES.info).toBe('提示');
    expect(DEFAULT_TOAST_TITLES.loading).toBe('进行中');
  });

  it('自定义标题优先于默认标题（标题 / 正文有层次）', () => {
    toastSuccess('优化完成，已生成新的最终生图 Prompt。现在可以确认生成图片。', '优化完成');
    const toast = useToastStore.getState().toasts[0];
    expect(toast.title).toBe('优化完成');
    expect(toast.message).toContain('最终生图 Prompt');
  });

  it('loading 不自动消失；update 可切换类型并换标题；dismiss 移除', () => {
    const id = toastLoading('正在分析…');
    expect(useToastStore.getState().toasts[0].kind).toBe('loading');
    toastUpdate(id, '优化完成，已生成新的最终生图 Prompt。', 'success', '优化完成');
    const updated = useToastStore.getState().toasts[0];
    expect(updated.kind).toBe('success');
    expect(updated.title).toBe('优化完成');
    toastDismiss(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});

describe('Toast.css 深色主题高对比度守卫', () => {
  const css = readFileSync(resolve(__dirname, '../Toast.css'), 'utf-8');
  const appCss = readFileSync(resolve(__dirname, '../../App.css'), 'utf-8');

  it('禁止引用主题表未定义的变量（--bg-elevated / --border-color 历史事故根因）', () => {
    expect(css).not.toMatch(/var\(--bg-elevated/);
    expect(css).not.toMatch(/var\(--border-color/);
  });

  it('正文 / 标题 / 背景引用的变量真实存在于 App.css 主题定义', () => {
    const required = ['--text-primary', '--text-secondary', '--bg-card', '--border-default'];
    for (const name of required) {
      expect(css).toContain(`var(${name}`);
      expect(appCss).toMatch(new RegExp(`${name}\\s*:`));
    }
  });

  it('五种类型均有类型色条（success / error / warning / info / loading）', () => {
    for (const cls of ['.toast-success', '.toast-error', '.toast-warning', '.toast-info', '.toast-loading']) {
      expect(css).toContain(cls);
    }
    expect(css).toContain('border-left-color: var(--accent-success)');
    expect(css).toContain('border-left-color: var(--accent-danger)');
    expect(css).toContain('border-left-color: var(--accent-orange)');
    expect(css).toContain('border-left-color: var(--accent-primary)');
  });

  it('标题 / 正文分层 + 关闭按钮独立可点', () => {
    expect(css).toContain('.toast-title');
    expect(css).toContain('.toast-message');
    expect(css).toContain('.toast-close:hover');
  });
});
