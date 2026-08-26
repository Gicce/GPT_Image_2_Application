/**
 * ProjectHeaderBar（§22 / §26）—— 视觉项目头部：名称 / 基于原图 / 状态 / 修订 /
 * 模型 + 项目操作（重命名 / 保存 / 基于此方案新建 / 重新识别）+ 项目库入口。
 *
 *  - 重命名 / 保存 / 派生 / 重新识别 = 项目语义或元数据操作（走 props 回调）；
 *  - 项目库 Popover 的展开 / hover = 视图状态（组件局部，绝不触发修订）；
 *  - 列表读取失败 ≠ 没有项目：lastError 时显式提示读取失败 + 重试入口，
 *    绝不让持久化故障伪装成「项目全没了」（P0 事故的 UI 侧防线）。
 */

import { useEffect, useState } from 'react';
import { api } from '../../../services/api';
import { describeProjectStatus } from './project';
import type { VisualProject, VisualProjectSummary } from './types';

interface ProjectHeaderBarProps {
  project: VisualProject | null;
  projects: ReadonlyArray<VisualProjectSummary>;
  /** 列表读取错误（空 = 正常；非空时 Popover 显示失败态而非空态）。 */
  listError?: string;
  thumbUrl: string;
  visionModelLabel: string;
  saving?: boolean;
  onRename: (name: string) => void;
  onSave: () => void;
  onDerive: () => void;
  onReanalyze: () => void;
  onOpenProject: (id: string) => void;
  onNewProject: () => void;
  onOpenLibrary: () => void;
  onRetryList: () => void;
  onDeleteProject?: (id: string) => void;
}

function formatLastOpened(iso?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 项目缩略图缓存（coverPath → dataURL；Popover / 项目库共用）。 */
const projectThumbCache = new Map<string, Promise<string>>();

function readProjectThumb(path: string): Promise<string> {
  let load = projectThumbCache.get(path);
  if (!load) {
    load = api.readThumbnail(path).catch(() => '');
    projectThumbCache.set(path, load);
  }
  return load;
}

/** 最近项目行的缩略图（失败 = 占位，不阻塞）。 */
function ProjectThumb({ path, alt }: { path?: string; alt: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    void readProjectThumb(path).then(value => {
      if (!cancelled) setUrl(value);
    });
    return () => { cancelled = true; };
  }, [path]);
  if (!path) return <span className="vision-project-item-thumb is-empty" aria-hidden="true" />;
  return url
    ? <img className="vision-project-item-thumb" src={url} alt={alt} />
    : <span className="vision-project-item-thumb is-empty" aria-hidden="true" />;
}

export default function ProjectHeaderBar({
  project,
  projects,
  listError,
  thumbUrl,
  visionModelLabel,
  saving,
  onRename,
  onSave,
  onDerive,
  onReanalyze,
  onOpenProject,
  onNewProject,
  onOpenLibrary,
  onRetryList,
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

  const recent = projects.slice(0, 6);

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
              {listError ? (
                <div className="vision-project-popover-error" role="alert">
                  <p className="vision-hint">项目列表读取失败，项目数据仍在本地。</p>
                  <button type="button" className="vision-btn vision-btn-sm" onClick={onRetryList}>重试</button>
                </div>
              ) : recent.length === 0 ? (
                <p className="vision-hint">暂无最近项目</p>
              ) : recent.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={`vision-project-item ${project?.id === item.id ? 'is-active' : ''}`}
                  role="menuitem"
                  onClick={() => { setPickerOpen(false); onOpenProject(item.id); }}
                >
                  <ProjectThumb path={item.coverPath} alt={item.name} />
                  <span className="vision-project-item-text">
                    <span className="vision-project-item-name">{item.name}</span>
                    <span className="vision-project-item-meta">
                      {describeProjectStatus(item.status)} · R{item.revision} · {formatLastOpened(item.lastOpenedAt ?? item.updatedAt)}
                    </span>
                  </span>
                </button>
              ))}
              <div className="vision-project-popover-footer">
                <button type="button" className="vision-btn vision-btn-sm" onClick={() => { setPickerOpen(false); onOpenLibrary(); }}>
                  查看全部项目
                </button>
                <button type="button" className="vision-btn vision-btn-sm" onClick={() => { setPickerOpen(false); onNewProject(); }}>
                  新建项目
                </button>
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
            {onDeleteProject && (
              <button
                type="button"
                className="vision-btn vision-btn-sm vision-btn-danger"
                onClick={() => { setPickerOpen(false); onDeleteProject(project.id); }}
              >删除当前项目</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export { readProjectThumb, ProjectThumb };
