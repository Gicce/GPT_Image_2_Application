import { lazy, Suspense, useEffect, useState } from 'react';
import Sidebar from './components/Sidebar';
import UpdateNotification from './components/UpdateNotification';
import MarqueeNotice from './components/MarqueeNotice';
import { useSettingsStore } from './store/useSettingsStore';
import { useUpdateStore } from './store/useUpdateStore';
import { useAuthStore, setGroupTypeMap } from './store/useAuthStore';
import { serverApi } from './services/serverApi';
import type { PageType } from './types';
import './App.css';

const Auth = lazy(() => import('./pages/Auth'));
const AgentChat = lazy(() => import('./pages/AgentChat'));
const TaskQueue = lazy(() => import('./pages/TaskQueue'));
const Gallery = lazy(() => import('./pages/Gallery'));
const History = lazy(() => import('./pages/History'));
const Settings = lazy(() => import('./pages/Settings'));
const About = lazy(() => import('./pages/About'));
const Account = lazy(() => import('./pages/Account'));

const PAGE_COMPONENTS: Record<PageType, JSX.Element> = {
  agent: <AgentChat />,
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
    loadSettings();
    loadFromStorage();
    const timer = setTimeout(() => { checkUpdate(); }, 3000);
    return () => clearTimeout(timer);
  }, []);

  // 登录后刷新用户信息 + 预取模型列表填充 groupTypeMap
  useEffect(() => {
    if (isLoggedIn) {
      refreshUser();
      serverApi.getModels()
        .then(list => {
          const map: Record<string, 'image' | 'agent' | 'postprocess' | 'chat'> = {};
          for (const m of list) if (m.group) map[m.group] = m.model_type;
          setGroupTypeMap(map);
        })
        .catch(() => {});
    }
  }, [isLoggedIn]);

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
    const authRequiredPages: PageType[] = ['agent', 'queue', 'account'];
    if (authRequiredPages.includes(page) && !isLoggedIn) {
      setShowAuth(true);
      useAuthStore.getState().setRequestedPage(page);
      return;
    }
    setCurrentPage(page);
  }

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
    </div>
  );
}
