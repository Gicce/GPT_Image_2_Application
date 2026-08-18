import { create } from 'zustand';
import { useSettingsStore } from './useSettingsStore';

/**
 * Runtime Ready Gate —— 客户端启动时序的统一语义。
 *
 * runtimeReady = settingsLoaded && authRestored
 *  - settingsLoaded：server_url / device_id 已从持久化设置恢复（首次 loadSettings 完成，无论成败）
 *  - authRestored：登录态恢复流程已结束（未登录也算完成；loadFromStorage 是同步的）
 *
 * 依赖 CyImagePro Server 的自动初始化请求（模型同步 / 权益 / Notice / SSE / runtime token）
 * 必须等待 runtimeReady，禁止读取 settings 默认值发请求（默认值是开发地址 localhost:4001）。
 */
export type RuntimePhase = 'booting' | 'ready' | 'degraded';

interface RuntimeState {
  authRestored: boolean;
  settingsLoaded: boolean;
  runtimeReady: boolean;
  /** settings 恢复出的 server_url（trim 后）；未恢复时为 '' */
  resolvedServerUrl: string;
  /** ready 之后若解析出的服务器地址不可用（如生产环境指向本机回环）则进入 degraded */
  phase: RuntimePhase;
  markAuthRestored: () => void;
  __syncFromSettings: () => void;
}

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  authRestored: false,
  settingsLoaded: false,
  runtimeReady: false,
  resolvedServerUrl: '',
  phase: 'booting',

  markAuthRestored: () => {
    set({ authRestored: true });
    get().__syncFromSettings();
  },

  __syncFromSettings: () => {
    const { authRestored } = get();
    const { settingsLoaded, settings } = useSettingsStore.getState();
    const resolvedServerUrl = settingsLoaded ? (settings.server_url || '').trim().replace(/\/+$/, '') : '';
    const runtimeReady = settingsLoaded && authRestored;
    let phase: RuntimePhase = 'booting';
    if (runtimeReady) {
      phase = resolvedServerUrl ? 'ready' : 'degraded';
    }
    set({ settingsLoaded, resolvedServerUrl, runtimeReady, phase });
  },
}));

// settings 变化 → 镜像进 runtime store（单一订阅，模块加载即生效）
useSettingsStore.subscribe(state => {
  void state;
  useRuntimeStore.getState().__syncFromSettings();
});
