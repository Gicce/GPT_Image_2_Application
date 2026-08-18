import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Runtime Ready Gate / Endpoint Guard 测试。
 * 核心断言：
 *  - settings 未恢复前，任何 serverApi 请求 = runtime_not_ready（不是网络错误）
 *  - 生产环境解析到回环地址 = configuration_error（禁止发送请求）
 *  - 开发环境允许 localhost（本地开发模式保留）
 */

vi.mock('../../services/api', () => ({ api: {} }));

import { useSettingsStore } from '../../store/useSettingsStore';

class LocalStorageStub {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
vi.stubGlobal('localStorage', new LocalStorageStub());

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({
    settings: { ...useSettingsStore.getState().settings, server_url: 'http://localhost:4001' },
    settingsLoaded: false,
  } as any);
});

describe('Endpoint Guard（isLoopbackUrl / assertServerUrlUsable）', () => {
  it('识别 localhost / 127.0.0.1 / ::1 为回环地址', async () => {
    const { isLoopbackUrl } = await import('../../services/serverApi');
    expect(isLoopbackUrl('http://localhost:4001')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:4001')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:4001')).toBe(true);
    expect(isLoopbackUrl('https://www.zjcypc.com')).toBe(false);
    expect(isLoopbackUrl('https://api.example.com')).toBe(false);
  });

  it('生产环境回环地址抛 configuration_error；开发环境放行', async () => {
    const { assertServerUrlUsable } = await import('../../services/serverApi');
    expect(() => assertServerUrlUsable('http://localhost:4001', true)).toThrowError();
    try {
      assertServerUrlUsable('http://localhost:4001', true);
    } catch (err: any) {
      expect(err.kind).toBe('configuration_error');
      expect(err.retryable).toBe(false);
      expect(err.message).not.toContain('无法连接服务器');
    }
    expect(() => assertServerUrlUsable('http://localhost:4001', false)).not.toThrow();
    expect(() => assertServerUrlUsable('https://www.zjcypc.com', true)).not.toThrow();
  });
});

describe('requestServerUrl（Runtime Ready Gate）', () => {
  it('settings 未恢复时抛 runtime_not_ready，而不是读默认 localhost 地址', async () => {
    const { requestServerUrl } = await import('../../services/serverApi');
    try {
      requestServerUrl();
      expect.unreachable('must throw');
    } catch (err: any) {
      expect(err.kind).toBe('runtime_not_ready');
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('尚未就绪');
    }
  });

  it('settings 恢复后返回持久化的真实地址（trim 尾部斜杠）', async () => {
    const { requestServerUrl } = await import('../../services/serverApi');
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, server_url: 'https://www.zjcypc.com/' },
      settingsLoaded: true,
    } as any);
    expect(requestServerUrl()).toBe('https://www.zjcypc.com');
  });

  it('serverApi 请求在 settings 未恢复前不发 fetch，直接 runtime_not_ready', async () => {
    const { serverApi } = await import('../../services/serverApi');
    await expect(serverApi.getNotice()).rejects.toMatchObject({ kind: 'runtime_not_ready' });
    expect(fetchMock).not.toHaveBeenCalled();

    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, server_url: 'https://srv.example.com' },
      settingsLoaded: true,
    } as any);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ content: '', is_active: false }) });
    await expect(serverApi.getNotice()).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://srv.example.com/api/notice');
  });

  it('网络失败归类为 network_error（可重试），配置错误与网络错误是不同 kind', async () => {
    const { serverApi } = await import('../../services/serverApi');
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, server_url: 'https://srv.example.com' },
      settingsLoaded: true,
    } as any);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(serverApi.getNotice()).rejects.toMatchObject({
      kind: 'network_error',
      retryable: true,
      isNetworkError: true,
    });
  });
});
