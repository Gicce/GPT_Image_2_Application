import type { PageType } from '../types';
import './Sidebar.css';

interface SidebarProps {
  currentPage: PageType;
  onNavigate: (page: PageType) => void;
}

const menuItems: { id: PageType; label: string; icon: string }[] = [
  { id: 'create', label: '创建任务', icon: '✦' },
  { id: 'queue', label: '任务队列', icon: '☰' },
  { id: 'gallery', label: '图片库', icon: '▦' },
  { id: 'history', label: '历史记录', icon: '🕐' },
  { id: 'settings', label: '设置', icon: '⚙' },
];

export default function Sidebar({ currentPage, onNavigate }: SidebarProps) {
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
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <p>v1.0.0 MVP</p>
      </div>
    </aside>
  );
}
