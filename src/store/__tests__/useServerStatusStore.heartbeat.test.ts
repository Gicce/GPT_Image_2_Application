import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 不触达真实 Tauri / 网络：全部外部依赖 mock
vi.mock('../../services/serverApi', () => ({
  getConfiguredServerUrl: vi.fn(() => 'http://server.test'),
  requestServerUrl: vi.fn(() => 'http://server.test'),
  testServerConnection: vi.fn(),
}));
vi.mock('../../services/api', () => ({ api: {} }));
vi.mock('../../services/runtimeTokenService', () => ({
  clearRuntimeConfig: vi.fn(),
  loadRuntimeConfig: vi.fn(),
}));

import { useServerStatusStore, startHeartbeatLoop, stopHeartbeatLoop, isHeartbeatLoopRunning } from '../useServerStatusStore';
import { useAuthStore } from '../useAuthStore';
import { useSettingsStore } from '../useSettingsStore';

// node 环境 stub 浏览器全局
class LocalStorageStub {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
vi.stubGlobal('localStorage', new LocalStorageStub());
vi.stubGlobal('navigator', { userAgent: 'Windows TestAgent' });

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// 冲刷 sendHeartbeat 内部 await 链（fetch -> json -> set）
async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  await new Promise(resolve => setTimeout(resolve, 0));
}

function setLoggedIn(jwt = 'jwt-token') {
  localStorage.setItem('cy_jwt', jwt);
  useAuthStore.setState({ jwt, user: { id: 'u1', username: 'u1' } as any, isLoggedIn: true });
}

function setLoggedOut() {
  localStorage.removeItem('cy_jwt');
  useAuthStore.setState({ jwt: null, user: null, isLoggedIn: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  stopHeartbeatLoop();
  useServerStatusStore.setState({
    connectionStatus: 'connecting', lastCheckedAt: null, serverHost: '', checking: false,
    serverService: undefined, serverVersion: undefined,
    heartbeatStatus: 'idle', lastHeartbeatAt: null, heartbeatError: null,
  });
  useSettingsStore.setState({
    settings: { ...useSettingsStore.getState().settings, device_id: 'device-stable-id', server_url: 'http://server.test' },
    settingsLoaded: true,
  } as any);
});

afterEach(() => {
  stopHeartbeatLoop();
  vi.useRealTimers();
});

describe('心跳单例服务（useServerStatusStore）', () => {
  it('登录且连接正常时立即发送心跳，携带 JWT 与设备信息', async () => {
    setLoggedIn();
    useServerStatusStore.setState({ connectionStatus: 'connected' });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ok' }) });

    const ok = await useServerStatusStore.getState().sendHeartbeat();

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://server.test/api/client/heartbeat');
    expect(init.headers.Authorization).toBe('Bearer jwt-token');
    const payload = JSON.parse(init.body);
    expect(payload.device_id).toBe('device-stable-id');
    expect(payload.app_name).toBe('CyImagePro');
    expect(useServerStatusStore.getState().heartbeatStatus).toBe('success');
    expect(useServerStatusStore.getState().lastHeartbeatAt).toBeTruthy();
  });

  it('未登录或未连接时心跳静默跳过，不产生请求', async () => {
    setLoggedOut();
    useServerStatusStore.setState({ connectionStatus: 'connected' });
    expect(await useServerStatusStore.getState().sendHeartbeat()).toBe(false);

    setLoggedIn();
    useServerStatusStore.setState({ connectionStatus: 'disconnected' });
    expect(await useServerStatusStore.getState().sendHeartbeat()).toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('心跳网络失败不影响连接状态、不登出用户（下一周期重试）', async () => {
    setLoggedIn();
    useServerStatusStore.setState({ connectionStatus: 'connected' });
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    const ok = await useServerStatusStore.getState().sendHeartbeat();

    expect(ok).toBe(false);
    // 心跳失败只是运维问题：不能把用户踢下线
    expect(useServerStatusStore.getState().connectionStatus).toBe('connected');
    expect(useAuthStore.getState().isLoggedIn).toBe(true);
    expect(useServerStatusStore.getState().heartbeatStatus).toBe('failed');
  });

  it('连接建立/恢复时会为已登录用户自动补一次心跳', async () => {
    const { testServerConnection } = await import('../../services/serverApi');
    (testServerConnection as any).mockResolvedValue({ ok: true, host: 'server.test', service: 'cyimagepro-server', version: '4.0.2' });

    setLoggedIn();
    useServerStatusStore.setState({ connectionStatus: 'disconnected' });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) });

    await useServerStatusStore.getState().checkConnection();

    expect(useServerStatusStore.getState().connectionStatus).toBe('connected');
    // 离线 → 在线恢复：立即触发心跳，无需等下一个周期
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('startHeartbeatLoop 幂等：重复调用（重复导航/多页面）不会产生多个定时器', () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) });
    setLoggedIn();
    useServerStatusStore.setState({ connectionStatus: 'connected' });

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(1 as any);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    try {
      startHeartbeatLoop();
      startHeartbeatLoop();
      startHeartbeatLoop();

      // 单例守卫：三次启动只创建一个 interval
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(isHeartbeatLoopRunning()).toBe(true);
    } finally {
      stopHeartbeatLoop();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('登出后 stopHeartbeatLoop 停止定时上报；重新登录可再次启动并切换用户上下文', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) });
    useServerStatusStore.setState({ connectionStatus: 'connected' });

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(1 as any);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    try {
      setLoggedIn('jwt-A');
      startHeartbeatLoop();
      await flushMicrotasks();
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer jwt-A');

      // 登出：调度停止
      setLoggedOut();
      stopHeartbeatLoop();
      expect(isHeartbeatLoopRunning()).toBe(false);
      expect(clearIntervalSpy).toHaveBeenCalled();

      // 用户 B 登录：重新启动后立即心跳上下文切换
      const callsBefore = fetchMock.mock.calls.length;
      setLoggedIn('jwt-B');
      startHeartbeatLoop();
      await flushMicrotasks();
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
      const last = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
      expect(last[1].headers.Authorization).toBe('Bearer jwt-B');
    } finally {
      stopHeartbeatLoop();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('手动「立即上报」与自动心跳走同一 sendHeartbeat 服务函数', async () => {
    setLoggedIn();
    useServerStatusStore.setState({ connectionStatus: 'connected' });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ok' }) });

    // Settings 页「立即上报」按钮直接调用同一 store action
    const ok = await useServerStatusStore.getState().sendHeartbeat();
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
