/**
 * 演员库弹窗（Phase 1.2-E，规格 §17/§23/§24）——替代旧内联列表：
 *  - §24 列表信息分层：缩略图 / 角色名称 / 来源 / 最近使用 / 搜索 / 选择；
 *  - §24.1 分类过滤（全部 / AI 创建 / 上传 / 图库，简单 chips，不做 DAM）；
 *  - §23 空态必须是可行动的：还没有保存过演员 + [AI 创建一个][从图库添加][上传参考图]
 *    + 当前项目有已锁定角色时 [保存当前〈名〉到演员库]；
 *  - browse 模式（§27 [查看演员库]）：只看不选，隐藏每行「选择」。
 * 纯展示组件：数据与动作全部来自 props，不直接触碰 store。
 */

import { useEffect, useMemo, useState } from 'react';
import './ComicDialog.css';
import { api } from '../../../services/api';
import type { ComicCharacterSummary } from '../../../store/useComicStore';

/** §24.1 分类 chips：source 'temporary' 归入 AI 创建（同一起源两条路径）。 */
const LIBRARY_CATEGORY_LABELS: Array<{ id: 'all' | 'ai' | 'upload' | 'gallery'; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'ai', label: 'AI 创建' },
  { id: 'upload', label: '上传' },
  { id: 'gallery', label: '图库' },
];

const SOURCE_LABELS: Record<string, string> = {
  ai: 'AI 创建',
  temporary: 'AI 创建',
  upload: '上传',
  gallery: '图库',
  library: '演员库',
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? 'AI 创建';
}

function inCategory(source: string, category: 'all' | 'ai' | 'upload' | 'gallery'): boolean {
  if (category === 'all') return true;
  if (category === 'ai') return source === 'ai' || source === 'temporary';
  return source === category;
}

/** 最近使用（§24）：库摘要富化列缺省回退 0 / 行 updated_at（Rust 侧保证）。 */
function recentLabel(item: ComicCharacterSummary): string {
  const count = item.usageCount ?? 0;
  const stamp = item.lastUsedAt || item.updatedAt;
  const date = stamp ? stamp.slice(0, 10) : '—';
  return count > 0 ? `用过 ${count} 次 · ${date}` : `未用过 · ${date}`;
}

export interface ComicActorLibraryDialogProps {
  open: boolean;
  /** select = 槽位选角（每行「选择」）；browse = [查看演员库] 只读浏览。 */
  mode: 'select' | 'browse';
  onClose: () => void;
  characters: ComicCharacterSummary[];
  busy: boolean;
  onPick: (item: ComicCharacterSummary) => void;
  /** §23 空态动作（browse 模式同样可加演员）。 */
  onQuickCreateAi: () => void;
  onAddFromGallery: () => void;
  onUploadReference: () => void;
  /** §23：当前项目有已锁定角色 → [保存当前〈名〉到演员库]。 */
  savableCharacterName?: string | null;
  onSaveCurrent: () => void;
}

export default function ComicActorLibraryDialog(props: ComicActorLibraryDialogProps) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'all' | 'ai' | 'upload' | 'gallery'>('all');
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  const visible = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return props.characters.filter(item => inCategory(item.source, category)
      && (!keyword || item.name.toLowerCase().includes(keyword) || item.role.toLowerCase().includes(keyword)));
  }, [props.characters, category, search]);

  // §24 缩略图：随可见列表懒读（readThumbnail 失败静默降级为占位，不阻塞选择）
  useEffect(() => {
    let alive = true;
    const paths = new Map<string, string>();
    for (const item of visible.slice(0, 60)) {
      if (item.thumbnailPath) paths.set(item.id, item.thumbnailPath);
    }
    if (paths.size === 0) {
      setThumbs({});
      return;
    }
    void Promise.all([...paths.entries()].map(async ([id, path]) => {
      try {
        return [id, await api.readThumbnail(path)] as const;
      } catch {
        return [id, ''] as const;
      }
    })).then(entries => {
      if (!alive) return;
      setThumbs(Object.fromEntries(entries.filter(([, data]) => data)));
    });
    return () => { alive = false; };
  }, [visible]);

  if (!props.open) return null;

  return (
    <div className="comic-dialog-overlay" onMouseDown={e => { if (e.target === e.currentTarget) props.onClose(); }}>
      <section className="comic-dialog comic-actor-dialog" role="dialog" aria-modal="true" aria-label={props.mode === 'browse' ? '演员库' : '从演员库选择'} onMouseDown={e => e.stopPropagation()}>
        <header className="comic-dialog-header">
          <div>
            <h3>{props.mode === 'browse' ? '演员库' : '从演员库选择'}</h3>
            <p>{props.mode === 'browse'
              ? '可跨项目复用的角色资产；库里修改不影响历史项目快照'
              : '已保存的漫画角色直接出演（快照冻结入项目）'}</p>
          </div>
          <button type="button" className="comic-dialog-close" aria-label="关闭" onClick={props.onClose}>×</button>
        </header>
        <div className="comic-dialog-body">
          {props.characters.length > 0 && (
            <>
              <div className="comic-actor-toolbar">
                <div className="form-group comic-actor-search">
                  <input
                    type="search"
                    placeholder="搜索名称或角色定位"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    aria-label="搜索演员"
                  />
                </div>
                <div className="app-segmented" aria-label="演员分类">
                  {LIBRARY_CATEGORY_LABELS.map(chip => (
                    <button
                      type="button"
                      key={chip.id}
                      className={`app-segmented-btn${category === chip.id ? ' active' : ''}`}
                      aria-pressed={category === chip.id}
                      onClick={() => setCategory(chip.id)}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>
              {visible.length === 0 && (
                <p className="comic-empty-hint">这个分类 / 搜索词下没有演员</p>
              )}
              <div className="comic-actor-list">
                {visible.map(item => (
                  <div className="comic-actor-row" key={item.id} data-testid={`comic-actor-row-${item.id}`}>
                    {thumbs[item.id]
                      ? <img className="comic-actor-thumb" src={thumbs[item.id]} alt={item.name} />
                      : <span className="comic-actor-thumb comic-actor-thumb-placeholder">无参考图</span>}
                    <div className="comic-actor-info">
                      <strong>{item.name}</strong>
                      <span>{item.role} · 来源：{sourceLabel(item.source)}</span>
                      <span className="comic-muted">{recentLabel(item)}</span>
                    </div>
                    {props.mode === 'select' && (
                      <button type="button" className="app-btn app-btn-secondary app-btn-sm" disabled={props.busy} onClick={() => props.onPick(item)}>
                        选择
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
          {props.characters.length === 0 && (
            <div className="comic-actor-empty">
              <p>还没有保存过演员。你可以：</p>
              <div className="comic-actions-row">
                <button type="button" className="app-btn app-btn-primary app-btn-sm" onClick={props.onQuickCreateAi}>AI 创建一个</button>
                <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={props.onAddFromGallery}>从图库添加</button>
                <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={props.onUploadReference}>上传参考图</button>
              </div>
              {props.savableCharacterName && (
                <div className="comic-actions-row">
                  <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={props.onSaveCurrent}>
                    保存当前{props.savableCharacterName}到演员库
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
