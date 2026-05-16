import { useState, useEffect } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import type { PageType } from '../types';
import VersionModal from './VersionModal';
import { useUpdateStore } from '../store/useUpdateStore';
import { useAuthStore } from '../store/useAuthStore';
import './Sidebar.css';

interface SidebarProps {
  currentPage: PageType;
  onNavigate: (page: PageType) => void;
}

const menuItems: { id: PageType; label: string; icon: string }[] = [
  { id: 'create', label: '文生图', icon: '✦' },
  { id: 'edit', label: '图生图', icon: '✎' },
  { id: 'chat', label: '智能对话', icon: '💬' },
  { id: 'queue', label: '任务队列', icon: '☰' },
  { id: 'gallery', label: '图片库', icon: '▦' },
  { id: 'history', label: '历史记录', icon: '🕐' },
  { id: 'account', label: '我的账户', icon: '👤' },
  { id: 'settings', label: '设置', icon: '⚙' },
  { id: 'about', label: '关于我们', icon: '◉' },
];

export default function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  const [appVersion, setAppVersion] = useState('');
  const [showVersionModal, setShowVersionModal] = useState(false);
  const { status, checkUpdate } = useUpdateStore();
  const { user, isLoggedIn } = useAuthStore();

  useEffect(() => {
    getVersion().then(v => setAppVersion('v' + v));
    checkUpdate();
  }, []);

  const hasUpdate = status.updateAvailable;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <img src="/logo.png" alt="Logo" className="sidebar-logo" />
        <h1 className="sidebar-title">CyImagePro</h1>
        <p className="sidebar-subtitle">AI 图片批量生成工具</p>
      </div>
      <nav className="sidebar-nav">
        {menuItems.map(item => (
          <button
            key={item.id}
            className={`sidebar-item ${currentPage === item.id ? 'active' : ''}`}
            onClick={() => onNavigate(item.id)}
          >
            <span className="sidebar-icon">{item.icon}</span>
            <span className="sidebar-label">{item.label}</span>
            {item.id === 'account' && isLoggedIn && user && (
              <span className="sidebar-balance">
                ${(user.tokens?.reduce((s, t) => s + (t.balance_usd || 0), 0) ?? 0).toFixed(2)}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <button
          className={`version-button${hasUpdate ? ' version-button--update' : ''}`}
          onClick={() => setShowVersionModal(true)}
          title={hasUpdate ? `发现新版本 v${status.updateInfo?.version}，点击查看` : '点击查看版本信息'}
        >
          {appVersion || '...'}
          {hasUpdate && <span className="version-update-dot">★</span>}
        </button>
      </div>
      {showVersionModal && (
        <VersionModal
          version={appVersion}
          onClose={() => setShowVersionModal(false)}
        />
      )}
    </aside>
  );
}
