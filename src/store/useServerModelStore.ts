import { create } from 'zustand';
import { serverApi, type ServerModel } from '../services/serverApi';
import { useAuthStore, setGroupTypeMap } from './useAuthStore';
import { useServerStatusStore } from './useServerStatusStore';
import { useRuntimeStore } from './useRuntimeStore';

/**
 * 服务器模型同步的唯一真相源。
 *
 * 触发规则（V4.0.3）：
 *  - runtimeReady（settings 恢复 + 登录态恢复）后做首次同步
 *  - 登录成功后同步；登出清空
 *  - server_url 变化 → 缓存失效（按 Server 隔离）+ 重新同步
 *  - 连接 offline → online 自动恢复同步
 *  - network_error / 5xx 按 1s/3s/10s 退避自动重试（最多 3 次）；401/403/配置错误不自动重试
 *
 * 所有请求经 in-flight 去重：启动 / mount / 恢复 / 手动重试同时触发只发一个请求。
 */

export type ServerModelSyncStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ServerModelError {
  kind: 'runtime_not_ready' | 'configuration_error' | 'network_error' | 'http_error' | 'unknown';
  message: string;
  retryable: boolean;
}

export type GroupTypeMap = Record<string, 'image' | 'agent' | 'postprocess' | 'chat'>;

interface ServerModelState {
  status: ServerModelSyncStatus;
  error: ServerModelError | null;
  models: ServerModel[];
  groupTypeMap: GroupTypeMap;
  /** 当前数据归属的 server URL（缓存按 Server 隔离的判断依据） */
  dataServerUrl: string;
  lastSyncAt: number | null;
  /** true = 上方数据来自本地缓存而非本次服务器响应（UI 需区分“缓存”与“实时”） */
  fromCache: boolean;
  sync: (opts?: { force?: boolean }) => Promise<void>;
  invalidate: () => void;
  clear: () => void;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const RETRY_DELAYS_MS = [1000, 3000, 10_000];

// 模块级缓存（按 server URL 隔离）与单例调度状态
const cacheByUrl = new Map<string, { models: ServerModel[]; at: number }>();
// in-flight 按 URL 去重：同一 URL 的并发触发只发一个请求；
// 不同 URL（切换 Server）互不阻塞，旧 URL 的晚到响应由 stale 防护丢弃
const inFlightByUrl = new Map<string, Promise<void>>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let retryServerUrl = '';

function buildGroupTypeMap(models: ServerModel[]): GroupTypeMap {
  const map: GroupTypeMap = {};
  for (const m of models) {
    if (m.group) map[m.group] = m.model_type;
  }
  return map;
}

function clearRetryTimer() {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function classifyError(err: unknown): ServerModelError {
  const anyErr = err as any;
  const kind: ServerModelError['kind'] =
    anyErr?.kind === 'runtime_not_ready' || anyErr?.kind === 'configuration_error' ||
    anyErr?.kind === 'network_error' || anyErr?.kind === 'http_error'
      ? anyErr.kind
      : 'unknown';
  const status: number | undefined = anyErr?.status;
  const retryable =
    kind === 'network_error' ||
    (kind === 'http_error' && status != null && status >= 500);
  return { kind, message: anyErr?.message || '服务器模型同步失败', retryable };
}

function applyModels(baseUrl: string, models: ServerModel[], fromCache: boolean) {
  const groupTypeMap = buildGroupTypeMap(models);
  cacheByUrl.set(baseUrl, { models, at: Date.now() });
  useServerModelStore.setState({
    status: 'ready',
    error: null,
    models,
    groupTypeMap,
    dataServerUrl: baseUrl,
    lastSyncAt: fromCache ? useServerModelStore.getState().lastSyncAt : Date.now(),
    fromCache,
  });
  setGroupTypeMap(groupTypeMap);
}

export const useServerModelStore = create<ServerModelState>((set, get) => ({
  status: 'idle',
  error: null,
  models: [],
  groupTypeMap: {},
  dataServerUrl: '',
  lastSyncAt: null,
  fromCache: false,

  sync: async (opts) => {
    const { isLoggedIn } = useAuthStore.getState();
    if (!isLoggedIn) return;

    const baseUrl = useRuntimeStore.getState().resolvedServerUrl;
    if (!baseUrl) return;

    // 未强制刷新时优先使用同 Server 的未过期缓存
    if (!opts?.force) {
      const cached = cacheByUrl.get(baseUrl);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        applyModels(baseUrl, cached.models, true);
        return;
      }
    }

    if (inFlightByUrl.has(baseUrl)) return inFlightByUrl.get(baseUrl)!;

    // 换 Server / 手动重试时取消未决的旧退避定时器，避免旧 Server 的重试晚到覆盖
    clearRetryTimer();

    set({ status: 'loading', error: null, fromCache: false });
    const requestServerUrl = baseUrl;
    const promise = (async () => {
      try {
        const models = await serverApi.getModels();
        // stale response 防护：请求期间用户切换了 Server，丢弃旧响应
        if (requestServerUrl !== useRuntimeStore.getState().resolvedServerUrl) {
          console.warn('[serverModels] stale response ignored', requestServerUrl);
          return;
        }
        retryAttempt = 0;
        applyModels(requestServerUrl, models, false);
      } catch (err) {
        if (requestServerUrl !== useRuntimeStore.getState().resolvedServerUrl) {
          return;
        }
        const error = classifyError(err);
        set({ status: 'error', error, fromCache: false });
        // 401 交给认证流程处理，不在这里自动重试
        if ((err as any)?.status === 401) {
          useAuthStore.getState().logout();
          useAuthStore.getState().showAuthPrompt();
          return;
        }
        if (error.retryable && retryAttempt < RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[retryAttempt];
          retryAttempt += 1;
          retryServerUrl = requestServerUrl;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (retryServerUrl === useRuntimeStore.getState().resolvedServerUrl) {
              void useServerModelStore.getState().sync({ force: true });
            }
          }, delay);
        }
      } finally {
        inFlightByUrl.delete(requestServerUrl);
      }
    })();
    inFlightByUrl.set(requestServerUrl, promise);
    return promise;
  },

  invalidate: () => {
    clearRetryTimer();
    retryAttempt = 0;
    cacheByUrl.clear();
    set({
      status: 'idle',
      error: null,
      models: [],
      groupTypeMap: {},
      dataServerUrl: '',
      lastSyncAt: null,
      fromCache: false,
    });
  },

  clear: () => {
    clearRetryTimer();
    retryAttempt = 0;
    set({
      status: 'idle',
      error: null,
      models: [],
      groupTypeMap: {},
      dataServerUrl: '',
      lastSyncAt: null,
      fromCache: false,
    });
  },
}));

// ── 模块级单例订阅：统一驱动初始同步 / Server 切换 / 连接恢复 / 登录态 ──

let wired = false;
export function ensureServerModelSync() {
  if (wired) return;
  wired = true;

  // 1) runtimeReady 变化（含 settings 恢复出的 server_url 变化）
  let lastReady = false;
  let lastServerUrl = '';
  useRuntimeStore.subscribe(state => {
    if (state.runtimeReady && !lastReady) {
      void useServerModelStore.getState().sync();
    }
    lastReady = state.runtimeReady;
    if (state.runtimeReady && state.resolvedServerUrl !== lastServerUrl) {
      if (lastServerUrl) {
        // Server 切换：旧缓存失效（缓存本身按 URL 隔离，这里重置状态触发重新拉取）
        useServerModelStore.setState({
          status: 'idle',
          error: null,
          models: [],
          groupTypeMap: {},
          dataServerUrl: '',
          fromCache: false,
        });
        clearRetryTimer();
        retryAttempt = 0;
        void useServerModelStore.getState().sync({ force: true });
      }
    }
    if (state.runtimeReady) lastServerUrl = state.resolvedServerUrl;
  });

  // 2) 登录成功 → 同步；登出 → 清空（内存态；缓存 Map 留作快速恢复也随 invalidate 清理）
  useAuthStore.subscribe((state, prev) => {
    if (state.isLoggedIn && !prev.isLoggedIn && useRuntimeStore.getState().runtimeReady) {
      void useServerModelStore.getState().sync();
    }
    if (!state.isLoggedIn && prev.isLoggedIn) {
      useServerModelStore.getState().clear();
      cacheByUrl.clear();
    }
  });

  // 3) 连接 offline → online：自动恢复同步（不需要用户手动点重试）
  useServerStatusStore.subscribe((state, prev) => {
    if (
      state.connectionStatus === 'connected' &&
      prev.connectionStatus !== 'connected' &&
      useAuthStore.getState().isLoggedIn &&
      useRuntimeStore.getState().runtimeReady
    ) {
      const st = useServerModelStore.getState();
      if (st.status === 'error' || st.status === 'idle') {
        retryAttempt = 0;
        void useServerModelStore.getState().sync({ force: true });
      }
    }
  });
}
