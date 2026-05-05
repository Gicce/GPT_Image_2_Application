import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import CreateTask from './pages/CreateTask';
import TaskQueue from './pages/TaskQueue';
import Gallery from './pages/Gallery';
import History from './pages/History';
import Settings from './pages/Settings';
import { useSettingsStore } from './store/useSettingsStore';
import type { PageType } from './types';
import './App.css';

export default function App() {
  const [currentPage, setCurrentPage] = useState<PageType>('create');
  const loadSettings = useSettingsStore(s => s.loadSettings);

  useEffect(() => {
    loadSettings();
  }, []);

  const renderPage = () => {
    switch (currentPage) {
      case 'create': return <CreateTask />;
      case 'queue': return <TaskQueue />;
      case 'gallery': return <Gallery />;
      case 'history': return <History />;
      case 'settings': return <Settings />;
    }
  };

  return (
    <div className="app">
      <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} />
      <main className="main-content">
        {renderPage()}
      </main>
    </div>
  );
}
