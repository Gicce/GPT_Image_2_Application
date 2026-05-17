import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import UpdateNotification from './components/UpdateNotification';
import MarqueeNotice from './components/MarqueeNotice';
import Auth from './pages/Auth';
import CreateTask from './pages/CreateTask';
import ImageEdit from './pages/ImageEdit';
import Chat from './pages/Chat';
import TaskQueue from './pages/TaskQueue';
import Gallery from './pages/Gallery';
import History from './pages/History';
import Settings from './pages/Settings';
import About from './pages/About';
import Account from './pages/Account';
import { useSettingsStore } from './store/useSettingsStore';
import { useUpdateStore } from './store/useUpdateStore';
import { useAuthStore, setGroupTypeMap } from './store/useAuthStore';
import { serverApi } from './services/serverApi';
import type { PageType } from './types';
import './App.css';

export default function App() {
  const [currentPage, setCurrentPage] = useState<PageType>('create');
  const [showAuth, setShowAuth] = useState(false);
  const loadSettings = useSettingsStore(s => s.loadSettings);
  const checkUpdate = useUpdateStore(s => s.checkUpdate);
  const { loadFromStorage, isLoggedIn, refreshUser, authPromptVisible, hideAuthPrompt, requestedPage, clearRequestedPage } = useAuthStore();
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
          const map: Record<string, 'image' | 'chat'> = {};
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

  // 跨页面跳转请求（如 Chat 页占位的"前往账户页"）
  useEffect(() => {
    if (requestedPage) {
      setCurrentPage(requestedPage as PageType);
      clearRequestedPage();
    }
  }, [requestedPage]);

  function handleNavigate(page: PageType) {
    // 点「我的账户」时，若未登录则弹登录框
    if (page === 'account' && !isLoggedIn) {
      setShowAuth(true);
      return;
    }
    setCurrentPage(page);
  }

  const renderPage = () => {
    switch (currentPage) {
      case 'create': return <CreateTask />;
      case 'edit': return <ImageEdit />;
      case 'chat': return <Chat />;
      case 'queue': return <TaskQueue />;
      case 'gallery': return <Gallery />;
      case 'history': return <History />;
      case 'settings': return <Settings />;
      case 'about': return <About />;
      case 'account': return <Account />;
    }
  };

  return (
    <div className="app">
      <Sidebar currentPage={currentPage} onNavigate={handleNavigate} />
      <div className="main-wrapper">
        <MarqueeNotice />
        <main className={`main-content ${currentPage === 'chat' ? 'chat-mode' : ''}`}>
          <UpdateNotification />
          {renderPage()}
        </main>
      </div>
      {showAuth && (
        <Auth
          onSuccess={() => { setShowAuth(false); hideAuthPrompt(); setCurrentPage('account'); }}
          onClose={() => { setShowAuth(false); hideAuthPrompt(); }}
        />
      )}
    </div>
  );
}
