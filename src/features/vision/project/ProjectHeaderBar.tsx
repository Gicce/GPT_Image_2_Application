/**
 * ProjectHeaderBar（§22 / §26）—— 视觉项目头部：名称 / 基于原图 / 状态 / 修订 /
 * 模型 + 项目操作（重命名 / 保存 / 基于此方案新建 / 重新识别）+ 项目库入口。
 *
 *  - 重命名 / 保存 / 派生 / 重新识别 = 项目语义或元数据操作（走 props 回调）；
 *  - 项目库 Popover 的展开 / hover = 视图状态（组件局部，绝不触发修订）。
 */

import { useState } from 'react';
import { describeProjectStatus } from './project';
import type { VisualProject, VisualProjectSummary } from './types';

interface ProjectHeaderBarProps {
  project: VisualProject | null;
  projects: ReadonlyArray<VisualProjectSummary>;
  thumbUrl: string;
  visionModelLabel: string;
  saving?: boolean;
  onRename: (name: string) => void;
  onSave: () => void;
  onDerive: () => void;
  onReanalyze: () => void;
  onOpenProject: (id: string) => void;
  onNewProject: () => void;
  onDeleteProject?: (id: string) => void;
}

function formatLastOpened(iso?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function ProjectHeaderBar({
  project,
  projects,
  thumbUrl,
  visionModelLabel,
  saving,
  onRename,
  onSave,
  onDerive,
  onReanalyze,
  onOpenProject,
  onNewProject,
  onDeleteProject,
}: ProjectHeaderBarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  const commitRename = () => {
    setRenaming(false);
    const next = nameDraft.trim();
    if (next && project && next !== project.name) onRename(next);
  };

  return (
    <div className="vision-project-header" data-testid="vision-project-header">
      <div className="vision-project-header-main">
        {renaming && project ? (
          <input
            className="vision-project-rename"
            value={nameDraft}
            autoFocus
            aria-label="项目名称"
            onChange={e => setNameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="vision-project-name"
            title="点击重命名项目"
            disabled={!project}
            onClick={() => {
              if (!project) return;
              setNameDraft(project.name);
              setRenaming(true);
            }}
          >{project?.name ?? '未命名视觉项目'}</button>
        )}

        {project && (
          <span className="vision-project-meta">
            {thumbUrl && <img className="vision-project-thumb" src={thumbUrl} alt="" />}
            基于 @{project.sourceAsset.displayName?.trim() || '原图'}
            {' · '}
            {describeProjectStatus(project.status)} · Revision {project.revision}
            {' · '}
            {visionModelLabel || '—'}
          </span>
        )}
      </div>

      <div className="vision-project-header-actions">
        <div className="vision-project-picker">
          <button
            type="button"
            className="vision-btn vision-btn-sm"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen(value => !value)}
          >项目 ▾</button>
          {pickerOpen && (
            <div className="vision-project-popover" role="menu" aria-label="最近项目">
              <span className="vision-project-popover-title">最近项目</span>
              {projects.length === 0 && <p className="vision-hint">还没有保存的项目</p>}
              {projects.slice(0, 6).map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={`vision-project-item ${project?.id === item.id ? 'is-active' : ''}`}
                  role="menuitem"
                  onClick={() => { setPickerOpen(false); onOpenProject(item.id); }}
                >
                  <span className="vision-project-item-name">{item.name}</span>
                  <span className="vision-project-item-meta">
                    {describeProjectStatus(item.status)} · R{item.revision} · {formatLastOpened(item.lastOpenedAt ?? item.updatedAt)}
                  </span>
                </button>
              ))}
              <div className="vision-project-popover-footer">
                <button type="button" className="vision-btn vision-btn-sm" onClick={() => { setPickerOpen(false); onNewProject(); }}>
                  新建项目
                </button>
                {project && onDeleteProject && (
                  <button
                    type="button"
                    className="vision-btn vision-btn-sm vision-btn-danger"
                    onClick={() => { setPickerOpen(false); onDeleteProject(project.id); }}
                  >删除当前项目</button>
                )}
              </div>
            </div>
          )}
        </div>
        {project && (
          <>
            <button type="button" className="vision-btn vision-btn-sm" disabled={saving} onClick={onSave}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button type="button" className="vision-btn vision-btn-sm" onClick={onDerive}>基于此方案新建</button>
            <button type="button" className="vision-btn vision-btn-sm" onClick={onReanalyze}>重新识别</button>
          </>
        )}
      </div>
    </div>
  );
}
