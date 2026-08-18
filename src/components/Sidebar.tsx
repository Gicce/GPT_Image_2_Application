import { useState, useEffect } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import type { PageType } from '../types';
import VersionModal from './VersionModal';
import { useUpdateStore } from '../store/useUpdateStore';
import './Sidebar.css';

interface SidebarProps {
  currentPage: PageType;
  onNavigate: (page: PageType) => void;
}

const menuItems: { id: PageType; label: string; icon: string }[] = [
  { id: 'agent', label: 'AI 智能体', icon: '◎' },
  { id: 'imagestudio', label: '图片生成', icon: '✦' },
  { id: 'queue', label: '任务队列', icon: '▣' },
  { id: 'gallery', label: '图片库', icon: '▦' },
  { id: 'history', label: '历史记录', icon: '◷' },
  { id: 'account', label: '我的账户', icon: '◉' },
  { id: 'settings', label: '设置与更新', icon: '⚙' },
  { id: 'about', label: '关于我们', icon: 'ⓘ' },
];

export default function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  const [appVersion, setAppVersion] = useState('');
  const [showVersionModal, setShowVersionModal] = useState(false);
  const { status, checkUpdate } = useUpdateStore();

  useEffect(() => {
    getVersion().then(v => setAppVersion('V' + v));
    checkUpdate();
  }, []);

  const hasUpdate = status.phase === 'update_available' || status.phase === 'download_failed' || status.phase === 'restart_required';
  const updateTitle = status.phase === 'restart_required'
    ? `新版本 v${status.latestVersion} 已下载，点击重启安装`
    : status.phase === 'download_failed'
      ? `v${status.latestVersion} 下载失败，点击重试更新`
      : `发现新版本 v${status.latestVersion}`;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <img src="/logo.png" alt="Logo" className="sidebar-logo" />
        <h1 className="sidebar-title">CyImagePro</h1>
        <p className="sidebar-subtitle">AI 图片生产智能体</p>
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
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <button
          className={`version-button${hasUpdate ? ' version-button--update' : ''}`}
          onClick={() => setShowVersionModal(true)}
          title={hasUpdate ? updateTitle : '查看版本信息'}
        >
          {appVersion || '...'}
          {hasUpdate && <span className="version-update-dot">●</span>}
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
