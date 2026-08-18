import { create } from 'zustand';
import { useSettingsStore } from './useSettingsStore';
import { useAuthStore } from './useAuthStore';
import { testServerConnection, requestServerUrl } from '../services/serverApi';
import { RELEASE_INFO } from '../config/release';

export type ServerConnectionStatus = 'connected' | 'disconnected' | 'connecting';

export type HeartbeatStatus = 'idle' | 'success' | 'failed' | 'pending';

interface ServerStatusState {
  connectionStatus: ServerConnectionStatus;
  lastCheckedAt: string | null;
  serverHost: string;
  checking: boolean;
  serverService?: string;
  serverVersion?: string;
  heartbeatStatus: HeartbeatStatus;
  lastHeartbeatAt: string | null;
  heartbeatError: string | null;

  checkConnection: () => Promise<boolean>;
  sendHeartbeat: () => Promise<boolean>;
}

const HEALTH_CHECK_INTERVAL_MS = 60 * 1000;
// 服务器 online TTL 为 180s（Redis key 过期即离线），60s 上报间隔允许连续丢失 2 次仍有容错
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const HEARTBEAT_TIMEOUT_MS = 10 * 1000;

let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export const useServerStatusStore = create<ServerStatusState>((set, get) => ({
  connectionStatus: 'connecting',
  lastCheckedAt: null,
  serverHost: '',
  checking: false,
  serverService: undefined,
  serverVersion: undefined,
  heartbeatStatus: 'idle',
  lastHeartbeatAt: null,
  heartbeatError: null,

  checkConnection: async () => {
    let baseUrl: string;
    try {
      // requestServerUrl：settings 未恢复 → runtime_not_ready；生产环境回环地址 → configuration_error
      baseUrl = requestServerUrl();
    } catch (err) {
      if ((err as any)?.kind === 'runtime_not_ready') return false;
      set({
        connectionStatus: 'disconnected',
        serverHost: '',
        lastCheckedAt: new Date().toISOString(),
        heartbeatError: (err as Error).message,
      });
      return false;
    }

    if (!baseUrl) {
      set({ connectionStatus: 'disconnected', serverHost: '', lastCheckedAt: new Date().toISOString() });
      return false;
    }

    const wasConnected = get().connectionStatus === 'connected';
    set({ checking: true, connectionStatus: 'connecting' });

    const result = await testServerConnection(baseUrl);

    const status: ServerConnectionStatus = result.ok ? 'connected' : 'disconnected';

    set({
      connectionStatus: status,
      serverHost: result.host,
      lastCheckedAt: new Date().toISOString(),
      checking: false,
      serverService: result.service,
      serverVersion: result.version,
    });

    // 连接首次建立或从离线恢复时：已登录用户立即补一次心跳，不等下一个上报周期
    if (result.ok && !wasConnected && useAuthStore.getState().isLoggedIn) {
      void useServerStatusStore.getState().sendHeartbeat();
    }

    return result.ok;
  },

  sendHeartbeat: async () => {
    const { connectionStatus } = get();
    const { isLoggedIn } = useAuthStore.getState();
    const settings = useSettingsStore.getState().settings;

    if (connectionStatus !== 'connected' || !isLoggedIn) {
      return false;
    }

    const baseUrl = (() => {
      try {
        return requestServerUrl();
      } catch (err) {
        if ((err as any)?.kind === 'configuration_error') {
          console.warn('[heartbeat] blocked:', (err as Error).message);
          set({ heartbeatStatus: 'failed', heartbeatError: (err as Error).message });
        }
        return '';
      }
    })();
    const deviceId = settings.device_id;

    if (!baseUrl || !deviceId) {
      return false;
    }

    const jwt = localStorage.getItem('cy_jwt');
    if (!jwt) {
      return false;
    }

    const appName = 'CyImagePro';
    const appVersion = RELEASE_INFO.version;
    const ua = navigator.userAgent.toLowerCase();
    const platform = ua.includes('win') ? 'windows' : ua.includes('mac') ? 'macos' : ua.includes('linux') ? 'linux' : 'unknown';
    const deviceName = platform === 'windows' ? 'Windows PC' : platform === 'macos' ? 'Mac' : 'Desktop';

    const finalUrl = `${baseUrl}/api/client/heartbeat`;
    const payload = {
      device_id: deviceId,
      device_name: deviceName,
      app_version: appVersion,
      platform,
      server_url: baseUrl,
      app_name: appName,
    };

    set({ heartbeatStatus: 'pending' });

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT_MS);

      const response = await fetch(finalUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        set({
          heartbeatStatus: 'success',
          lastHeartbeatAt: new Date().toISOString(),
          heartbeatError: null,
        });
        return true;
      } else {
        // 心跳失败是运维辅助能力的问题，不影响连接状态与用户创作，下一周期自动重试
        console.warn(`[heartbeat] failed with status ${response.status}`);
        set({
          heartbeatStatus: 'failed',
          heartbeatError: `HTTP ${response.status}`,
        });
        return false;
      }
    } catch (error) {
      console.warn('[heartbeat] network error:', error instanceof Error ? error.message : error);
      set({
        heartbeatStatus: 'failed',
        heartbeatError: error instanceof Error ? error.message : 'network error',
      });
      return false;
    }
  },
}));

export function startHealthCheckLoop() {
  if (healthCheckTimer) return;

  void useServerStatusStore.getState().checkConnection();

  healthCheckTimer = setInterval(() => {
    void useServerStatusStore.getState().checkConnection();
  }, HEALTH_CHECK_INTERVAL_MS);
}

export function startHeartbeatLoop() {
  if (heartbeatTimer) return;

  // 立即尝试一次；未连接/未登录时由内部守卫跳过，待连接建立后经 checkConnection 触发
  void useServerStatusStore.getState().sendHeartbeat();

  heartbeatTimer = setInterval(() => {
    void useServerStatusStore.getState().sendHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
}

export function isHeartbeatLoopRunning() {
  return heartbeatTimer !== null;
}

export function isHealthCheckLoopRunning() {
  return healthCheckTimer !== null;
}

export function stopHealthCheckLoop() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

export function stopHeartbeatLoop() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
