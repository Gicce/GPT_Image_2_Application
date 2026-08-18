import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Runtime Ready 语义测试：
 *  - settings 未恢复 / 登录态未恢复完成之前，runtimeReady 必须为 false
 *  - 两者都完成后 runtimeReady=true，resolvedServerUrl 来自恢复的 settings
 *  - 未登录用户也可以完成 Runtime 初始化（不要求已登录）
 */

vi.mock('../../services/api', () => ({ api: {} }));

import { useSettingsStore } from '../useSettingsStore';

async function freshRuntime() {
  const mod = await import('../useRuntimeStore');
  return mod.useRuntimeStore;
}

beforeEach(async () => {
  vi.clearAllMocks();
  // 单例 store 状态在用例间复位（先复位 settings，订阅会把 runtime 镜像置回 booting）
  useSettingsStore.setState({ settingsLoaded: false } as any);
  const runtime = await import('../useRuntimeStore');
  runtime.useRuntimeStore.setState({
    authRestored: false,
    settingsLoaded: false,
    runtimeReady: false,
    resolvedServerUrl: '',
    phase: 'booting',
  });
});

describe('useRuntimeStore（runtimeReady 时序）', () => {
  it('boot 阶段 runtimeReady=false，resolvedServerUrl 为空', async () => {
    useSettingsStore.setState({ settingsLoaded: false } as any);
    const useRuntimeStore = await freshRuntime();
    expect(useRuntimeStore.getState().runtimeReady).toBe(false);
    expect(useRuntimeStore.getState().resolvedServerUrl).toBe('');
    expect(useRuntimeStore.getState().phase).toBe('booting');
  });

  it('仅 settings 恢复（auth 未标记完成）不进入 ready', async () => {
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, server_url: 'https://srv.test' },
      settingsLoaded: true,
    } as any);
    const useRuntimeStore = await freshRuntime();
    expect(useRuntimeStore.getState().settingsLoaded).toBe(true);
    expect(useRuntimeStore.getState().runtimeReady).toBe(false);
  });

  it('auth 恢复标记 + settings 恢复 → runtimeReady，URL 取自恢复的 settings', async () => {
    const useRuntimeStore = await freshRuntime();
    useRuntimeStore.getState().markAuthRestored();
    expect(useRuntimeStore.getState().runtimeReady).toBe(false);

    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, server_url: 'https://srv.test/' },
      settingsLoaded: true,
    } as any);
    expect(useRuntimeStore.getState().runtimeReady).toBe(true);
    expect(useRuntimeStore.getState().resolvedServerUrl).toBe('https://srv.test');
    expect(useRuntimeStore.getState().phase).toBe('ready');
  });

  it('先 auth 后 settings 的恢复顺序同样能进入 ready（顺序无关）', async () => {
    useSettingsStore.setState({ settingsLoaded: false } as any);
    const useRuntimeStore = await freshRuntime();
    useRuntimeStore.getState().markAuthRestored();
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, server_url: 'https://srv.test' },
      settingsLoaded: true,
    } as any);
    expect(useRuntimeStore.getState().runtimeReady).toBe(true);
  });

  it('server_url 切换后 resolvedServerUrl 跟随更新（供缓存失效 / SSE 重建使用）', async () => {
    const useRuntimeStore = await freshRuntime();
    useRuntimeStore.getState().markAuthRestored();
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, server_url: 'https://a.test' },
      settingsLoaded: true,
    } as any);
    expect(useRuntimeStore.getState().resolvedServerUrl).toBe('https://a.test');
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, server_url: 'https://b.test' },
    } as any);
    expect(useRuntimeStore.getState().resolvedServerUrl).toBe('https://b.test');
  });
});
