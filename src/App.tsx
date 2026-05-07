import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import UpdateNotification from './components/UpdateNotification';
import CreateTask from './pages/CreateTask';
import ImageEdit from './pages/ImageEdit';
import Chat from './pages/Chat';
import TaskQueue from './pages/TaskQueue';
import Gallery from './pages/Gallery';
import History from './pages/History';
import Settings from './pages/Settings';
import About from './pages/About';
import { useSettingsStore } from './store/useSettingsStore';
import { useUpdateStore } from './store/useUpdateStore';
import type { PageType } from './types';
import './App.css';

export default function App() {
  const [currentPage, setCurrentPage] = useState<PageType>('create');
  const loadSettings = useSettingsStore(s => s.loadSettings);
  const checkUpdate = useUpdateStore(s => s.checkUpdate);

  useEffect(() => {
    loadSettings();
    const timer = setTimeout(() => { checkUpdate(); }, 3000);
    return () => clearTimeout(timer);
  }, []);

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
    }
  };

  return (
    <div className="app">
      <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} />
      <main className={`main-content ${currentPage === 'chat' ? 'chat-mode' : ''}`}>
        <UpdateNotification />
        {renderPage()}
      </main>
    </div>
  );
}
