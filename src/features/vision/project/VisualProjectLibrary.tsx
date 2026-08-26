/**
 * VisualProjectLibrary（全部项目管理，§8）—— 项目库弹层：
 *  - 筛选：全部 / 最近使用 / 已理解 / 已修改 / 已生成；
 *  - 项目卡：缩略图 / 名称 / 更新时间 / 状态 / Revision；
 *  - 操作：打开 / 重命名 / 复制 / 基于此方案新建 / 删除（删除必须确认）。
 *
 * 视图状态全部组件局部（筛选 / hover / 重命名草稿），绝不触发项目修订；
 * 语义操作全部走 props 回调（页面接 store 的 by-id 动作）。
 */

import { useEffect, useMemo, useState } from 'react';
import { describeProjectStatus } from './project';
import { ProjectThumb } from './ProjectHeaderBar';
import type { VisualProjectStatus, VisualProjectSummary } from './types';

type LibraryFilter = 'all' | 'recent' | 'ready' | 'modified' | 'generated';

const FILTERS: Array<{ key: LibraryFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'recent', label: '最近使用' },
  { key: 'ready', label: '已理解' },
  { key: 'modified', label: '已修改' },
  { key: 'generated', label: '已生成' },
];

const STATUS_LABELS: Record<VisualProjectStatus, string> = {
  draft: '草稿', analyzing: '识别中', ready: '已理解', modified: '已修改',
  generating: '生成中', generated: '已生成', error: '失败',
};

function formatUpdated(iso?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

interface VisualProjectLibraryProps {
  projects: ReadonlyArray<VisualProjectSummary>;
  activeProjectId?: string;
  onClose: () => void;
  onOpenProject: (id: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onDuplicateProject: (id: string) => void;
  onDeriveProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onNewProject: () => void;
}

export default function VisualProjectLibrary({
  projects,
  activeProjectId,
  onClose,
  onOpenProject,
  onRenameProject,
  onDuplicateProject,
  onDeriveProject,
  onDeleteProject,
  onNewProject,
}: VisualProjectLibraryProps) {
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  /**
   * 删除确认态唯一事实源（列表级单值，非逐卡 isDeleting）：
   * 同一时刻至多一个项目进入确认态；取消 / Escape / 删除提交后回落 null。
   */
  const [pendingDeleteProjectId, setPendingDeleteProjectId] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (pendingDeleteProjectId) setPendingDeleteProjectId(null);
        else if (renamingId) setRenamingId(null);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingDeleteProjectId, renamingId, onClose]);

  const filtered = useMemo(() => {
    const source = [...projects].sort((a, b) =>
      (b.lastOpenedAt ?? b.updatedAt).localeCompare(a.lastOpenedAt ?? a.updatedAt));
    switch (filter) {
      case 'recent': return source.slice(0, 10);
      case 'ready': return source.filter(item => item.status === 'ready');
      case 'modified': return source.filter(item => item.status === 'modified' || item.status === 'generating');
      case 'generated': return source.filter(item => item.status === 'generated');
      default: return source;
    }
  }, [projects, filter]);

  const commitRename = (id: string) => {
    setRenamingId(null);
    const next = renameDraft.trim();
    const current = projects.find(item => item.id === id)?.name ?? '';
    if (next && next !== current) onRenameProject(id, next);
  };

  return (
    <div className="vision-modal-overlay" onClick={onClose} data-testid="vision-project-library">
      <div className="vision-modal vision-project-library-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="全部项目">
        <div className="vision-modal-header">
          <h3>全部项目（{projects.length}）</h3>
        </div>
        <p className="vision-modal-desc">打开项目将直接恢复当时的模板与修改方案，不会重新识别。</p>
        <div className="vision-modal-body vision-project-library-body">
          <div className="vision-project-library-filters" role="tablist" aria-label="项目筛选">
            {FILTERS.map(item => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={filter === item.key}
                className={`vision-project-library-filter ${filter === item.key ? 'is-active' : ''}`}
                onClick={() => setFilter(item.key)}
              >{item.label}</button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <div className="vision-project-library-empty">
              <p className="vision-hint">{projects.length === 0 ? '暂无视觉项目' : '当前筛选下没有项目'}</p>
              <button type="button" className="vision-btn vision-btn-sm" onClick={() => { onClose(); onNewProject(); }}>新建项目</button>
            </div>
          ) : (
            <ul className="vision-project-library-list">
              {filtered.map(item => {
                const confirmingDelete = pendingDeleteProjectId === item.id;
                return (
                  <li
                    key={item.id}
                    className={`vision-project-card ${activeProjectId === item.id ? 'is-active' : ''} ${confirmingDelete ? 'is-confirming-delete' : ''}`}
                    data-testid={`vision-project-card-${item.id}`}
                  >
                    <ProjectThumb path={item.coverPath} alt={item.name} />
                    <div className="vision-project-card-main">
                      {renamingId === item.id ? (
                        <input
                          className="vision-project-rename"
                          value={renameDraft}
                          autoFocus
                          aria-label="项目名称"
                          onChange={e => setRenameDraft(e.target.value)}
                          onBlur={() => commitRename(item.id)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') commitRename(item.id);
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                        />
                      ) : (
                        <span className="vision-project-card-name" title={item.name}>{item.name}</span>
                      )}
                      <span className="vision-project-card-meta">
                        {STATUS_LABELS[item.status] ?? describeProjectStatus(item.status)} · R{item.revision} · 更新 {formatUpdated(item.updatedAt)}
                      </span>
                    </div>
                    {/* 三区固定网格（缩略图 / 内容 / 操作）：普通态与删除确认态共用同一
                        布局几何；确认态整体替换操作区（绝不追加按钮挤压内容列） */}
                    <div className="vision-project-card-actions" data-testid={`vision-project-actions-${item.id}`}>
                      {confirmingDelete ? (
                        <>
                          <button
                            type="button"
                            className="vision-btn vision-btn-sm vision-btn-danger"
                            data-testid="confirm-delete-project"
                            onClick={() => { setPendingDeleteProjectId(null); onDeleteProject(item.id); }}
                          >确认删除</button>
                          <button
                            type="button"
                            className="vision-btn vision-btn-sm"
                            data-testid="cancel-delete-project"
                            onClick={() => setPendingDeleteProjectId(null)}
                          >取消</button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="vision-btn vision-btn-sm" onClick={() => { onClose(); onOpenProject(item.id); }}>打开</button>
                          <button type="button" className="vision-btn vision-btn-sm" title="重命名"
                            onClick={() => { setRenamingId(item.id); setRenameDraft(item.name); }}>重命名</button>
                          <button type="button" className="vision-btn vision-btn-sm" title="复制项目（模板 / 合同 / 区域全复制）"
                            onClick={() => onDuplicateProject(item.id)}>复制</button>
                          <button type="button" className="vision-btn vision-btn-sm" title="保留模板与媒介结构，重置人物参考与生成历史"
                            onClick={() => onDeriveProject(item.id)}>基于此方案新建</button>
                          <button type="button" className="vision-btn vision-btn-sm vision-btn-danger" title="删除项目（区域 mask 一并清理）"
                            onClick={() => setPendingDeleteProjectId(item.id)}>删除</button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="vision-modal-footer">
          <button type="button" className="vision-btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
