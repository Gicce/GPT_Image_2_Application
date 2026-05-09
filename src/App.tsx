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
import { useAuthStore } from './store/useAuthStore';
import type { PageType } from './types';
import './App.css';

export default function App() {
  const [currentPage, setCurrentPage] = useState<PageType>('create');
  const [showAuth, setShowAuth] = useState(false);
  const loadSettings = useSettingsStore(s => s.loadSettings);
  const checkUpdate = useUpdateStore(s => s.checkUpdate);
  const { loadFromStorage, isLoggedIn, refreshUser } = useAuthStore();
  const serverUrl = useSettingsStore(s => s.settings.server_url);

  useEffect(() => {
    loadSettings();
    loadFromStorage();
    const timer = setTimeout(() => { checkUpdate(); }, 3000);
    return () => clearTimeout(timer);
  }, []);

  // 登录后刷新用户信息
  useEffect(() => {
    if (isLoggedIn && serverUrl) {
      refreshUser();
    }
  }, [isLoggedIn]);

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
          onSuccess={() => { setShowAuth(false); setCurrentPage('account'); }}
          onClose={() => setShowAuth(false)}
        />
      )}
    </div>
  );
}
