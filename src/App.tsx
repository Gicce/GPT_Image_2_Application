import { lazy, Suspense, useEffect, useState } from 'react';
import Sidebar from './components/Sidebar';
import UpdateNotification from './components/UpdateNotification';
import MarqueeNotice from './components/MarqueeNotice';
import { ToastHost } from './components/Toast';
import { useSettingsStore } from './store/useSettingsStore';
import { useUpdateStore } from './store/useUpdateStore';
import { useAuthStore } from './store/useAuthStore';
import { useAccountStore } from './store/useAccountStore';
import { useServerStatusStore, startHealthCheckLoop, startHeartbeatLoop, stopHeartbeatLoop } from './store/useServerStatusStore';
import { ensureTaskEventBridge } from './store/useTaskStore';
import { loadRuntimeConfig } from './services/runtimeTokenService';
import { ensureServerModelSync } from './store/useServerModelStore';
import { useRuntimeStore } from './store/useRuntimeStore';
import { initAvatarAccountSync } from './services/avatarService';
import type { PageType } from './types';
import './App.css';

const Auth = lazy(() => import('./pages/Auth'));
const AgentChat = lazy(() => import('./pages/AgentChat'));
const ImageStudio = lazy(() => import('./pages/ImageStudio'));
const TaskQueue = lazy(() => import('./pages/TaskQueue'));
const Gallery = lazy(() => import('./pages/Gallery'));
const History = lazy(() => import('./pages/History'));
const Settings = lazy(() => import('./pages/Settings'));
const About = lazy(() => import('./pages/About'));
const Account = lazy(() => import('./pages/Account'));

const PAGE_COMPONENTS: Record<PageType, JSX.Element> = {
  agent: <AgentChat />,
  imagestudio: <ImageStudio />,
  queue: <TaskQueue />,
  gallery: <Gallery />,
  history: <History />,
  settings: <Settings />,
  about: <About />,
  account: <Account />,
};

function PageLoading({ chatMode = false }: { chatMode?: boolean }) {
  return (
    <div className={`page-loading${chatMode ? ' chat-mode' : ''}`}>
      <div className="page-loading-card">
        <div className="page-loading-spinner" />
        <span>页面加载中...</span>
      </div>
    </div>
  );
}

export default function App() {
  const [currentPage, setCurrentPage] = useState<PageType>('agent');
  const [showAuth, setShowAuth] = useState(false);
  const loadSettings = useSettingsStore(s => s.loadSettings);
  const checkUpdate = useUpdateStore(s => s.checkUpdate);
  const { loadFromStorage, isLoggedIn, refreshUser, authPromptVisible, hideAuthPrompt, clearRequestedPage, requestedPage } = useAuthStore();
  const theme = useSettingsStore(s => s.settings.theme);

  // 主题应用
  useEffect(() => {
    const root = document.documentElement;
    const apply = (dark: boolean) => root.setAttribute('data-theme', dark ? 'dark' : 'light');
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      apply(mq.matches);
      const handler = (e: MediaQueryListEvent) => apply(e.matches);
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    } else {
      apply(theme === 'dark');
    }
  }, [theme]);

  useEffect(() => {
    if (import.meta.env.DEV) console.info('[boot] app mounted');
    loadSettings();
    loadFromStorage();
    // 登录态恢复是同步流程，无论是否已登录都标记完成（runtimeReady 不要求已登录）
    useRuntimeStore.getState().markAuthRestored();
    // 全局单点 task-updated 订阅：各页面（ImageStudio / TaskQueue / Chat）不再重复注册
    ensureTaskEventBridge();
    // 服务器模型同步单例：runtimeReady / 登录 / Server 切换 / 断网恢复 统一由 store 内部调度
    ensureServerModelSync();
    // 账号切换时同步各自头像（登出清空、登录恢复缓存）
    const stopAvatarSync = initAvatarAccountSync();
    const timer = setTimeout(() => { checkUpdate(); }, 3000);
    return () => { clearTimeout(timer); stopAvatarSync(); };
  }, []);

  // App 级单例调度器：等 settings 加载完成（server_url / device_id 就绪）后再启动，
  // 避免启动瞬间读到默认值导致首次心跳被守卫跳过
  const settingsLoaded = useSettingsStore(s => s.settingsLoaded);
  useEffect(() => {
    if (!settingsLoaded) return;
    const serverUrl = useSettingsStore.getState().settings.server_url?.trim();
    if (serverUrl) {
      startHealthCheckLoop();
      startHeartbeatLoop();
    }
  }, [settingsLoaded]);

  // 登录状态变化：登录/会话恢复成功立即上报心跳并确保调度器在运行
  // （登出会停止调度器，重新登录必须重启，否则只会上报一次）；
  // 登出停止心跳调度，服务器端 key 随 TTL 自然过期转为离线
  useEffect(() => {
    if (isLoggedIn) {
      startHeartbeatLoop();
      void useServerStatusStore.getState().sendHeartbeat();
    } else {
      stopHeartbeatLoop();
      useServerStatusStore.setState({
        heartbeatStatus: 'idle',
        heartbeatError: null,
        lastHeartbeatAt: null,
      });
    }
  }, [isLoggedIn]);

  // 登录后刷新用户信息 + 首次 runtimeReady 后的初始同步（模型 / 权益 / runtime token）。
  // 全部等待 runtimeReady：settings 未恢复前禁止用默认 server_url 发请求。
  const runtimeReady = useRuntimeStore(s => s.runtimeReady);
  useEffect(() => {
    if (!runtimeReady) return;
    if (import.meta.env.DEV) {
      console.info('[boot] runtime ready', useRuntimeStore.getState().resolvedServerUrl);
    }
    if (isLoggedIn) {
      refreshUser();
      useAccountStore.getState().fetchEntitlements();
      // 模型同步由 useServerModelStore 单例调度（去重 / 缓存 / 自动恢复）
      // Load runtime tokens from server (memory-only, synced to Rust)
      loadRuntimeConfig().catch(() => {});
    } else {
      // 登出时清除权益数据
      useAccountStore.getState().clearEntitlements();
    }
  }, [runtimeReady, isLoggedIn, refreshUser]);

  // 全局登录提示触发（比如 401 后从 store 触发）
  useEffect(() => {
    if (authPromptVisible) setShowAuth(true);
  }, [authPromptVisible]);

  useEffect(() => {
    if (!isLoggedIn || !requestedPage) return;
    setCurrentPage(requestedPage as PageType);
    clearRequestedPage();
  }, [isLoggedIn, requestedPage, clearRequestedPage]);

  function handleNavigate(page: PageType) {
    const authRequiredPages: PageType[] = ['agent', 'imagestudio', 'queue', 'account'];
    if (authRequiredPages.includes(page) && !isLoggedIn) {
      setShowAuth(true);
      useAuthStore.getState().setRequestedPage(page);
      return;
    }
    setCurrentPage(page);
  }

  // 全局导航事件（图片生成工作台 / Empty State 的「前往设置」「查看任务」等入口）
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { page: PageType; section?: string; focusTaskId?: string } | undefined;
      if (!detail?.page) return;
      if (detail.focusTaskId) {
        localStorage.setItem('cy_taskqueue_focus_id', detail.focusTaskId);
      }
      if (detail.page === 'settings' && detail.section) {
        localStorage.setItem('cy_settings_section', detail.section);
        window.dispatchEvent(new CustomEvent('cy-settings-section'));
      }
      handleNavigate(detail.page);
    };
    window.addEventListener('cyimage-navigate', handler);
    return () => window.removeEventListener('cyimage-navigate', handler);
  }, [isLoggedIn]);

  return (
    <div className="app">
      <Sidebar currentPage={currentPage} onNavigate={handleNavigate} />
      <div className="main-wrapper">
        <MarqueeNotice />
        <main className={`main-content ${currentPage === 'agent' ? 'chat-mode' : ''}`}>
          <UpdateNotification />
          <Suspense fallback={<PageLoading chatMode={currentPage === 'agent'} />}>
            {PAGE_COMPONENTS[currentPage]}
          </Suspense>
        </main>
      </div>
      {showAuth && (
        <Suspense fallback={null}>
          <Auth
            onSuccess={() => {
              setShowAuth(false);
              hideAuthPrompt();
              const target = useAuthStore.getState().requestedPage;
              if (target) {
                setCurrentPage(target as PageType);
                clearRequestedPage();
              } else {
                setCurrentPage('account');
              }
            }}
            onClose={() => { setShowAuth(false); hideAuthPrompt(); }}
          />
        </Suspense>
      )}
      <ToastHost />
    </div>
  );
}
