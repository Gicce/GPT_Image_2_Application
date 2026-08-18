import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * 服务器模型同步（useServerModelStore）测试：
 *  - runtimeReady 前 / 未登录 → 不发请求
 *  - ready 后触发同步；并发触发去重为一个请求
 *  - 网络失败 = error（不是空数据）；退避自动重试；成功后回到 ready
 *  - 401 不自动重试，交给认证流程
 *  - 请求期间切换 Server → 旧响应丢弃（stale 防护）
 *  - 缓存按 Server 隔离
 */

const getModelsMock = vi.fn();
vi.mock('../../services/serverApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/serverApi')>();
  return {
    ...original,
    serverApi: { ...original.serverApi, getModels: (...args: unknown[]) => getModelsMock(...args) },
  };
});
vi.mock('../../services/api', () => ({
  api: {
    clearRuntimeAuthConfig: vi.fn(() => Promise.resolve()),
    setRuntimeAuthConfig: vi.fn(() => Promise.resolve()),
  },
}));

import { useSettingsStore } from '../useSettingsStore';
import { useAuthStore } from '../useAuthStore';
import { useServerStatusStore } from '../useServerStatusStore';
import { useServerModelStore } from '../useServerModelStore';
import { useRuntimeStore } from '../useRuntimeStore';

class LocalStorageStub {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
vi.stubGlobal('localStorage', new LocalStorageStub());

function makeModel(group: string) {
  return {
    id: group, name: group, display_name: group, provider: 'p', billing_type: 'per_call',
    model_type: 'image', trial_allowed: true, group, user_has_access: true,
    price_input: null, price_output: null, price_cached: null, price_per_call: '0.01',
  } as any;
}

function setReady(serverUrl: string) {
  useSettingsStore.setState({
    settings: { ...useSettingsStore.getState().settings, server_url: serverUrl },
    settingsLoaded: true,
  } as any);
  useRuntimeStore.getState().markAuthRestored();
}

// 本机 vitest 4.1.10：useFakeTimers 放在 hook 里会让 useRealTimers 挂起，
// 因此统一在各用例内部启停假定时器（参考 useTaskStore.bridge.test.ts）。
function withFakeTimers<T>(fn: () => Promise<T>): Promise<T> {
  return (async () => {
    vi.useFakeTimers();
    try {
      return await fn();
    } finally {
      vi.useRealTimers();
    }
  })();
}

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ settingsLoaded: false } as any);
  useAuthStore.setState({ jwt: 'jwt', user: { id: 'u1', username: 'u1' } as any, isLoggedIn: true });
  useServerModelStore.getState().invalidate();
});

describe('useServerModelStore', () => {
  it('runtimeReady 之前调用 sync 也不发请求', async () => {
    await withFakeTimers(async () => {
      useSettingsStore.setState({ settingsLoaded: false } as any);
      await useServerModelStore.getState().sync();
      expect(getModelsMock).not.toHaveBeenCalled();
    });
  });

  it('未登录不发请求', async () => {
    await withFakeTimers(async () => {
      useAuthStore.setState({ isLoggedIn: false });
      setReady('https://a.test');
      await useServerModelStore.getState().sync();
      expect(getModelsMock).not.toHaveBeenCalled();
    });
  });

  it('ready 后同步一次成功；并发 3 次触发只发 1 个请求（in-flight 去重）', async () => {
    await withFakeTimers(async () => {
      setReady('https://a.test');
      getModelsMock.mockResolvedValue([makeModel('image2')]);

      await Promise.all([
        useServerModelStore.getState().sync(),
        useServerModelStore.getState().sync(),
        useServerModelStore.getState().sync(),
      ]);

      expect(getModelsMock).toHaveBeenCalledTimes(1);
      expect(useServerModelStore.getState().status).toBe('ready');
      expect(useServerModelStore.getState().groupTypeMap['image2']).toBe('image');
      expect(useServerModelStore.getState().dataServerUrl).toBe('https://a.test');
    });
  });

  it('TTL 内重复 sync 使用缓存不再发请求（fromCache=true）', async () => {
    await withFakeTimers(async () => {
      setReady('https://a.test');
      getModelsMock.mockResolvedValue([makeModel('image2')]);
      await useServerModelStore.getState().sync();
      getModelsMock.mockClear();

      await useServerModelStore.getState().sync();

      expect(getModelsMock).not.toHaveBeenCalled();
      expect(useServerModelStore.getState().fromCache).toBe(true);
    });
  });

  it('网络失败 → error（非空数据伪装）；1s 后自动重试；成功后回到 ready', async () => {
    await withFakeTimers(async () => {
      setReady('https://a.test');
      const networkErr: any = new Error('无法连接服务器（https://a.test）');
      networkErr.kind = 'network_error';
      getModelsMock.mockRejectedValueOnce(networkErr).mockResolvedValueOnce([makeModel('image2')]);

      await useServerModelStore.getState().sync({ force: true });
      expect(useServerModelStore.getState().status).toBe('error');
      expect(useServerModelStore.getState().error?.kind).toBe('network_error');
      expect(useServerModelStore.getState().error?.retryable).toBe(true);

      await vi.advanceTimersByTimeAsync(1100);
      expect(getModelsMock).toHaveBeenCalledTimes(2);
      expect(useServerModelStore.getState().status).toBe('ready');
    });
  });

  it('401 不自动重试，触发登出', async () => {
    await withFakeTimers(async () => {
      setReady('https://a.test');
      const err: any = new Error('HTTP 401');
      err.kind = 'http_error';
      err.status = 401;
      getModelsMock.mockRejectedValueOnce(err);

      await useServerModelStore.getState().sync({ force: true });
      expect(useServerModelStore.getState().status).toBe('error');

      await vi.advanceTimersByTimeAsync(11_000);
      expect(getModelsMock).toHaveBeenCalledTimes(1);
      expect(useAuthStore.getState().isLoggedIn).toBe(false);
    });
  });

  it('请求期间切换 Server：旧响应被丢弃，不覆盖新 Server 的状态', async () => {
    await withFakeTimers(async () => {
      setReady('https://a.test');
      let resolveA: (v: any[]) => void = () => {};
      getModelsMock.mockImplementationOnce(() => new Promise<any[]>(res => { resolveA = res; }));

      const pending = useServerModelStore.getState().sync({ force: true });
      useSettingsStore.setState({
        settings: { ...useSettingsStore.getState().settings, server_url: 'https://b.test' },
      } as any);
      resolveA([makeModel('group-a')]);
      await pending;

      expect(useServerModelStore.getState().status).not.toBe('ready');
      expect(useServerModelStore.getState().dataServerUrl).not.toBe('https://a.test');
      expect(useServerModelStore.getState().groupTypeMap['group-a']).toBeUndefined();
    });
  });

  it('缓存按 Server 隔离：切回旧 Server 在 TTL 内仍可用旧缓存，不串数据', async () => {
    await withFakeTimers(async () => {
      setReady('https://a.test');
      getModelsMock.mockResolvedValueOnce([makeModel('group-a')]);
      await useServerModelStore.getState().sync();
      expect(useServerModelStore.getState().groupTypeMap['group-a']).toBe('image');

      useSettingsStore.setState({
        settings: { ...useSettingsStore.getState().settings, server_url: 'https://b.test' },
      } as any);
      getModelsMock.mockResolvedValueOnce([makeModel('group-b')]);
      await useServerModelStore.getState().sync({ force: true });
      expect(useServerModelStore.getState().groupTypeMap['group-b']).toBe('image');
      expect(useServerModelStore.getState().groupTypeMap['group-a']).toBeUndefined();

      useSettingsStore.setState({
        settings: { ...useSettingsStore.getState().settings, server_url: 'https://a.test' },
      } as any);
      await useServerModelStore.getState().sync();
      expect(useServerModelStore.getState().groupTypeMap['group-a']).toBe('image');
      expect(getModelsMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe('useServerModelStore 连接恢复自动同步（ensureServerModelSync）', () => {
  it('offline → online 自动刷新（status=error 时），无需人工重试', async () => {
    await withFakeTimers(async () => {
      setReady('https://a.test');

      const networkErr: any = new Error('无法连接服务器（https://a.test）');
      networkErr.kind = 'network_error';
      getModelsMock.mockRejectedValueOnce(networkErr).mockResolvedValue([makeModel('image2')]);

      await useServerModelStore.getState().sync({ force: true });
      expect(useServerModelStore.getState().status).toBe('error');

      const mod = await import('../useServerModelStore');
      mod.ensureServerModelSync();
      useServerStatusStore.setState({ connectionStatus: 'disconnected' });
      useServerStatusStore.setState({ connectionStatus: 'connected' });

      await vi.advanceTimersByTimeAsync(50);
      expect(useServerModelStore.getState().status).toBe('ready');
      expect(useServerModelStore.getState().groupTypeMap['image2']).toBe('image');
    });
  });
});
