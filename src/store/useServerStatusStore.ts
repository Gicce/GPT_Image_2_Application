import { create } from 'zustand';
import { useSettingsStore } from './useSettingsStore';
import { useAuthStore } from './useAuthStore';
import { testServerConnection, getConfiguredServerUrl } from '../services/serverApi';
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

const HEALTH_CHECK_INTERVAL_MS = 60 * 1000; // 60 seconds
const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 60 seconds

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
    const baseUrl = getConfiguredServerUrl();

    if (!baseUrl) {
      set({ connectionStatus: 'disconnected', serverHost: '', lastCheckedAt: new Date().toISOString() });
      return false;
    }

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

    return result.ok;
  },

  sendHeartbeat: async () => {
    const { connectionStatus } = get();
    const { isLoggedIn } = useAuthStore.getState();
    const settings = useSettingsStore.getState().settings;

    console.log('[heartbeat] start');
    console.log('[heartbeat] connectionStatus:', connectionStatus);
    console.log('[heartbeat] isLoggedIn:', isLoggedIn);

    // Only send heartbeat if connected and logged in
    if (connectionStatus !== 'connected' || !isLoggedIn) {
      console.log('[heartbeat] skipped: not connected or not logged in');
      return false;
    }

    const baseUrl = getConfiguredServerUrl();
    const deviceId = settings.device_id;

    console.log('[heartbeat] baseUrl:', baseUrl);
    console.log('[heartbeat] deviceId:', deviceId ? 'exists' : 'missing');

    if (!baseUrl || !deviceId) {
      console.log('[heartbeat] skipped: no baseUrl or deviceId');
      return false;
    }

    // Get JWT token
    const jwt = localStorage.getItem('cy_jwt');
    console.log('[heartbeat] token exists:', !!jwt);
    if (!jwt) {
      console.log('[heartbeat] skipped: no JWT token');
      return false;
    }

    const appName = 'CyImagePro';
    const appVersion = RELEASE_INFO.version;
    const platform = 'windows';
    const deviceName = navigator.userAgent.includes('Windows') ? 'Windows PC' : 'Desktop';

    const finalUrl = `${baseUrl}/api/client/heartbeat`;
    const payload = {
      device_id: deviceId,
      device_name: deviceName,
      app_version: appVersion,
      platform,
      server_url: baseUrl,
      app_name: appName,
    };

    console.log('[heartbeat] final url:', finalUrl);
    console.log('[heartbeat] payload:', JSON.stringify(payload));

    set({ heartbeatStatus: 'pending' });

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

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

      console.log('[heartbeat] response status:', response.status);

      if (response.ok) {
        const data = await response.json();
        console.log('[heartbeat] response body:', JSON.stringify(data));
        set({
          heartbeatStatus: 'success',
          lastHeartbeatAt: new Date().toISOString(),
          heartbeatError: null,
        });
        return true;
      } else {
        const errorText = await response.text();
        console.error('[heartbeat] failed with status:', response.status, errorText);
        set({
          heartbeatStatus: 'failed',
          heartbeatError: `HTTP ${response.status}`,
        });
        return false;
      }
    } catch (error) {
      console.error('[heartbeat] failed:', error);
      set({
        connectionStatus: 'disconnected',
        heartbeatStatus: 'failed',
        heartbeatError: error instanceof Error ? error.message : 'network error',
      });
      return false;
    }
  },
}));

export function startHealthCheckLoop() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
  }

  // Check immediately on start
  useServerStatusStore.getState().checkConnection();

  // Then check every 60 seconds
  healthCheckTimer = setInterval(() => {
    useServerStatusStore.getState().checkConnection();
  }, HEALTH_CHECK_INTERVAL_MS);
}

export function startHeartbeatLoop() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }

  // Send heartbeat immediately on start
  useServerStatusStore.getState().sendHeartbeat();

  // Then send heartbeat every 60 seconds
  heartbeatTimer = setInterval(() => {
    useServerStatusStore.getState().sendHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
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
