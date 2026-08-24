import { useEffect, useMemo, useState } from 'react';
import { useTaskStore } from '../store/useTaskStore';
import { api } from '../services/api';
import { toastError, toastSuccess } from './Toast';
import { SIZES, QUALITIES, QUALITY_LABELS, FORMATS } from '../types';
import type { BatchRedoItemOverride, CreateBatchRedoRequest, Task } from '../types';
import './BatchRedoModal.css';
import './EditTaskModal.css';
import '../pages/ImageEdit.css';

interface Props {
  task: Task;
  onClose: () => void;
}

/** 与 Rust task_runner::effective_prompt 相同的组合逻辑（展示与脏检测基线） */
export function effectiveItemPrompt(task: Task, index: number): string {
  const item = task.batch_items?.[index];
  if (item?.prompt_override?.trim()) return item.prompt_override;
  const base = task.final_prompt || task.prompt;
  if (item?.prompt_delta?.trim()) return `${base}\n${item.prompt_delta}`;
  return base;
}

export function effectiveItemNegative(task: Task, index: number): string {
  const item = task.batch_items?.[index];
  if (item?.negative_override?.trim()) return item.negative_override;
  return task.final_negative_prompt || task.negative_prompt || '';
}

interface ItemDraft {
  label: string;
  prompt: string;
  negative: string;
}

/**
 * V4.0.6 批量任务重做弹窗：
 * 左侧 = 子任务选择（支持 全选/清空/仅失败/仅成功，含状态与缩略图）；
 * 右侧 = 统一参数（size/quality/format/输出目录/Prompt 前后缀）+ 单项编辑。
 * 提交后创建全新批量任务（源任务不可变），计费按选中数正常授权。
 */
export default function BatchRedoModal({ task, onClose }: Props) {
  const redoBatchTask = useTaskStore(s => s.redoBatchTask);
  const items = useMemo(() => task.batch_items ?? [], [task.batch_items]);
  const failedIndexes = useMemo(
    () => task.sub_tasks.map((st, i) => (st.status === 'failed' ? i : -1)).filter(i => i >= 0),
    [task.sub_tasks],
  );
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [activeItem, setActiveItem] = useState<number | null>(null);
  const [itemDrafts, setItemDrafts] = useState<Record<number, ItemDraft>>({});
  const [size, setSize] = useState(task.size);
  const [quality, setQuality] = useState(task.quality);
  const [format, setFormat] = useState(task.output_format);
  const [outputDir, setOutputDir] = useState(task.output_dir);
  const [promptPrefix, setPromptPrefix] = useState('');
  const [promptSuffix, setPromptSuffix] = useState('');
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // 已完成子任务的结果缩略图
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const images = await api.getImages();
        const byId = new Map(images.map(img => [img.id, img.local_path]));
        const urls: Record<string, string> = {};
        for (const st of task.sub_tasks) {
          if (!st.image_id) continue;
          const path = byId.get(st.image_id);
          if (path) {
            try { urls[st.image_id] = await api.readThumbnail(path); } catch { /* 缩略图失败不阻塞 */ }
          }
        }
        if (!cancelled) setThumbnails(urls);
      } catch { /* 图库读取失败不阻塞重做 */ }
    };
    void load();
    return () => { cancelled = true; };
  }, [task.sub_tasks]);

  const toggleSelect = (index: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(items.map((_, i) => i)));
  const selectNone = () => setSelected(new Set());
  const selectFailed = () => setSelected(new Set(failedIndexes));
  const selectCompleted = () =>
    setSelected(new Set(task.sub_tasks.map((st, i) => (st.status === 'completed' ? i : -1)).filter(i => i >= 0)));

  const activeDraft: ItemDraft | null = activeItem !== null
    ? (itemDrafts[activeItem] ?? {
        label: items[activeItem]?.label || `方案 ${activeItem + 1}`,
        prompt: effectiveItemPrompt(task, activeItem),
        negative: effectiveItemNegative(task, activeItem),
      })
    : null;

  const patchDraft = (patch: Partial<ItemDraft>) => {
    if (activeItem === null) return;
    const base: ItemDraft = itemDrafts[activeItem] ?? {
      label: items[activeItem]?.label || `方案 ${activeItem + 1}`,
      prompt: effectiveItemPrompt(task, activeItem),
      negative: effectiveItemNegative(task, activeItem),
    };
    setItemDrafts(prev => ({ ...prev, [activeItem]: { ...base, ...patch } }));
  };

  const handleSubmit = async () => {
    if (selected.size === 0) {
      toastError('请至少选择一个要重做的子任务');
      return;
    }
    setSubmitting(true);
    try {
      const itemOverrides: BatchRedoItemOverride[] = [];
      for (const [indexText, draft] of Object.entries(itemDrafts)) {
        const index = Number(indexText);
        // 只提交相对基线真正变化的字段（未编辑的项完全继承源任务）
        const baseline: ItemDraft = {
          label: items[index]?.label || `方案 ${index + 1}`,
          prompt: effectiveItemPrompt(task, index),
          negative: effectiveItemNegative(task, index),
        };
        const override: BatchRedoItemOverride = { index };
        if (draft.label.trim() && draft.label !== baseline.label) override.label = draft.label.trim();
        if (draft.prompt.trim() && draft.prompt !== baseline.prompt) override.prompt = draft.prompt.trim();
        if (draft.negative !== baseline.negative) override.negative_prompt = draft.negative.trim();
        if (override.label !== undefined || override.prompt !== undefined || override.negative_prompt !== undefined) {
          itemOverrides.push(override);
        }
      }

      const request: CreateBatchRedoRequest = {
        source_task_id: task.id,
        selected_indexes: [...selected],
        global_overrides: {
          size,
          quality,
          output_format: format,
          output_dir: outputDir,
          prompt_prefix: promptPrefix.trim() || null,
          prompt_suffix: promptSuffix.trim() || null,
        },
        item_overrides: itemOverrides,
      };
      const created = await redoBatchTask(task.id, request);
      toastSuccess(`已创建重做任务（${created.count} 张），原任务保持不变，可在任务队列查看进度`);
      onClose();
    } catch (err: any) {
      toastError(err?.message || err?.toString() || '重做任务创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="edit-modal-overlay" onClick={submitting ? undefined : onClose}>
      <div className="edit-modal batch-redo-modal" onClick={e => e.stopPropagation()}>
        <div className="edit-modal-header">
          <h3>重做批量任务（{items.length} 个子方案）</h3>
          <button onClick={submitting ? undefined : onClose} disabled={submitting}>✕</button>
        </div>

        <div className="edit-modal-body batch-redo-body">
          <div className="batch-redo-left">
            <div className="batch-redo-select-actions">
              <button className="batch-redo-chip" onClick={selectAll}>全选</button>
              <button className="batch-redo-chip" onClick={selectNone}>清空</button>
              <button className="batch-redo-chip" onClick={selectFailed}>仅失败项（{failedIndexes.length}）</button>
              <button className="batch-redo-chip" onClick={selectCompleted}>仅成功项</button>
            </div>
            <div className="batch-redo-item-list">
              {items.map((item, i) => {
                const st = task.sub_tasks[i];
                const status = st?.status ?? 'pending';
                const isSelected = selected.has(i);
                const isActive = activeItem === i;
                const retried = st?.retry_count ?? 0;
                const thumb = st?.image_id ? thumbnails[st.image_id] : undefined;
                return (
                  <div
                    key={item.id || i}
                    className={`batch-redo-item${isSelected ? ' selected' : ''}${isActive ? ' active' : ''}`}
                    onClick={() => setActiveItem(i)}
                  >
                    <label className="batch-redo-item-check" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(i)}
                      />
                    </label>
                    <span className="batch-redo-item-index">#{i + 1}</span>
                    {thumb ? (
                      <img className="batch-redo-item-thumb" src={thumb} alt="" />
                    ) : (
                      <span className={`batch-redo-item-status status-${status}`}>
                        {status === 'completed' ? (retried > 0 ? '重试成功' : '已完成') : status === 'failed' ? '失败' : status === 'running' ? '生成中' : '排队'}
                      </span>
                    )}
                    <div className="batch-redo-item-info">
                      <strong title={item.plan_title || item.label}>{item.label || item.plan_title || `方案 ${i + 1}`}</strong>
                      <p className="batch-redo-item-prompt">
                        {effectiveItemPrompt(task, i).slice(0, 80)}
                      </p>
                      {status === 'failed' && st?.error && (
                        <p className="batch-redo-item-error">{st.error.slice(0, 60)}</p>
                      )}
                      {retried > 0 && <p className="batch-redo-item-retry">已重试 {retried} 次</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="batch-redo-right">
            <section className="batch-redo-section">
              <h4>统一参数（应用到全部选中项）</h4>
              <div className="form-row">
                <div className="form-group">
                  <label>图片尺寸</label>
                  <select value={size} onChange={e => setSize(e.target.value)}>
                    {SIZES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>质量</label>
                  <select value={quality} onChange={e => setQuality(e.target.value)}>
                    {QUALITIES.map(q => <option key={q} value={q}>{QUALITY_LABELS[q] || q}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>输出格式</label>
                  <select value={format} onChange={e => setFormat(e.target.value)}>
                    {FORMATS.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>输出目录</label>
                  <div className="dir-input">
                    <input type="text" value={outputDir} onChange={e => setOutputDir(e.target.value)} placeholder="选择保存位置" readOnly />
                    <button className="browse-btn" onClick={async () => { const dir = await api.selectDirectory(); if (dir) setOutputDir(dir); }}>浏览</button>
                  </div>
                </div>
              </div>
              <div className="form-group">
                <label>统一 Prompt 前缀（可选，加在每项提示词之前）</label>
                <textarea value={promptPrefix} onChange={e => setPromptPrefix(e.target.value)} rows={2} placeholder="例如：电商主图，白色背景" />
              </div>
              <div className="form-group">
                <label>统一 Prompt 后缀（可选，加在每项提示词之后）</label>
                <textarea value={promptSuffix} onChange={e => setPromptSuffix(e.target.value)} rows={2} placeholder="例如：细节丰富，专业布光" />
              </div>
            </section>

            <section className="batch-redo-section">
              <h4>
                单项编辑
                {activeItem !== null
                  ? <span className="batch-redo-active-tag">正在编辑 #{activeItem + 1}</span>
                  : <span className="batch-redo-hint">（点击左侧子方案后编辑；留空表示保持原样）</span>}
              </h4>
              {activeDraft ? (
                <>
                  <div className="form-group">
                    <label>方案标题</label>
                    <input type="text" value={activeDraft.label} onChange={e => patchDraft({ label: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label>提示词（完全替换该子项）</label>
                    <textarea value={activeDraft.prompt} onChange={e => patchDraft({ prompt: e.target.value })} rows={5} />
                  </div>
                  <div className="form-group">
                    <label>负面提示词</label>
                    <textarea value={activeDraft.negative} onChange={e => patchDraft({ negative: e.target.value })} rows={2} />
                  </div>
                </>
              ) : (
                <p className="batch-redo-hint">尚未选择子方案。单项编辑不会影响其它选中项。</p>
              )}
            </section>

            <p className="batch-redo-note">
              重做会创建一个全新的批量任务并按选中数量（当前 {selected.size} 张）正常计费；
              原任务的结果、失败重试历史完全保留，不会被覆盖。
            </p>
          </div>
        </div>

        <div className="edit-modal-footer">
          <button className="btn-secondary" onClick={submitting ? undefined : onClose} disabled={submitting}>取消</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={submitting || selected.size === 0}>
            {submitting ? '提交中…' : `重做选中项（${selected.size}）`}
          </button>
        </div>
      </div>
    </div>
  );
}
