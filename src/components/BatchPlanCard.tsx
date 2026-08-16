/**
 * 批量方案简洁卡片 —— 主页只展示重点信息（编号 / 标题 / 摘要 / 标签 / 状态 / 操作），
 * 完整 description 与正负提示词只在详情抽屉里查看。
 * 摘要 / 标题 / 标签全部来自 AI 正式产出，此处只做展示 fallback，绝不做 Prompt 截断。
 */

import { useEffect, useRef, useState } from 'react';
import type { GenerationPlan } from '../utils/batchPlans';
import { isPlanReady } from '../utils/batchPlans';
import { copyText } from '../utils/clipboard';
import { toastError, toastSuccess } from './Toast';
import './BatchPlans.css';

export function planStatusBadge(plan: GenerationPlan): { label: string; cls: string } {
  if (plan.optimizationStatus === 'loading') return { label: 'AI 优化中', cls: 'loading' };
  if (plan.optimizationStatus === 'error') return { label: '优化失败', cls: 'error' };
  if (!isPlanReady(plan)) return { label: '待完善', cls: 'pending' };
  if (plan.isManuallyEdited) return { label: '✓ 已优化 · 已手动修改', cls: 'success' };
  return { label: '✓ 已优化', cls: 'success' };
}

async function copy(text: string, label: string) {
  if (!text.trim()) {
    toastError('内容为空，无法复制');
    return;
  }
  if (await copyText(text)) toastSuccess(label);
}

export default function BatchPlanCard(props: {
  plan: GenerationPlan;
  index: number;
  selected: boolean;
  optimizerConfigured: boolean;
  onOpenDetail: () => void;
  onReoptimize: () => void;
  onAiFill: () => void;
  onDelete: () => void;
}) {
  const { plan, index } = props;
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const status = planStatusBadge(plan);
  const ready = isPlanReady(plan);
  const optimizing = plan.optimizationStatus === 'loading';
  const title = plan.title.trim() || `方案 ${index + 1}`;
  const summary = plan.summary.trim() || plan.description.trim();

  useEffect(() => {
    if (!moreOpen) return;
    function onDocClick(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [moreOpen]);

  return (
    <div className={`bp-card${props.selected ? ' selected' : ''}`}>
      <span className="bp-card-index">{index + 1}</span>
      <div className="bp-card-main">
        <div className="bp-card-head">
          <span className="bp-card-title" title={title}>{title}</span>
          <span className={`bp-status-badge ${status.cls}`}>{status.label}</span>
        </div>

        {optimizing && (
          <p className="bp-card-summary">AI 正在重新优化该方案，其他方案不受影响…</p>
        )}

        {plan.optimizationStatus === 'error' && (
          <p className="bp-card-error">重新优化失败：{plan.optimizationError || '请重试'}（已保留原方案）</p>
        )}

        {!optimizing && !ready && (
          <p className="bp-card-pending-hint">
            请填写方案描述，或让 AI 根据总需求补充。
          </p>
        )}

        {!optimizing && ready && summary && (
          <p className="bp-card-summary" title={summary}>{summary}</p>
        )}

        {plan.tags.length > 0 && (
          <div className="bp-card-tags">
            {plan.tags.map(tag => <span className="bp-tag" key={tag}>{tag}</span>)}
          </div>
        )}

        <div className="bp-card-actions">
          <button
            type="button"
            className="settings-btn settings-btn-outline settings-btn-sm"
            title="查看方案详情"
            onClick={props.onOpenDetail}
          >
            查看详情
          </button>
          {ready ? (
            <>
              <button
                type="button"
                className="settings-btn settings-btn-secondary settings-btn-sm"
                title="重新优化当前方案（不影响其他方案）"
                disabled={optimizing || !props.optimizerConfigured}
                onClick={props.onReoptimize}
              >
                {optimizing ? '优化中…' : '重新优化'}
              </button>
              <div className="bp-more-wrap" ref={moreRef}>
                <button
                  type="button"
                  className="settings-btn settings-btn-secondary settings-btn-sm"
                  title="更多操作"
                  aria-label="更多操作"
                  onClick={() => setMoreOpen(v => !v)}
                >
                  更多 ▾
                </button>
                {moreOpen && (
                  <div className="bp-more-menu">
                    <button type="button" onClick={() => { setMoreOpen(false); void copy(`${plan.title.trim() || title}\n${summary}`, '方案摘要已复制'); }}>
                      复制方案摘要
                    </button>
                    <button type="button" onClick={() => { setMoreOpen(false); void copy(plan.positivePrompt, '正向提示词已复制'); }}>
                      复制正向提示词
                    </button>
                    <button type="button" onClick={() => { setMoreOpen(false); void copy(plan.negativePrompt, '负面提示词已复制'); }}>
                      复制负面提示词
                    </button>
                    <button type="button" className="bp-more-danger" onClick={() => { setMoreOpen(false); props.onDelete(); }}>
                      删除方案
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <button
              type="button"
              className="settings-btn settings-btn-primary settings-btn-sm"
              disabled={optimizing || !props.optimizerConfigured}
              title={plan.description.trim() ? 'AI 优化当前方案（不影响其他方案）' : 'AI 根据总需求补充当前方案'}
              onClick={props.onAiFill}
            >
              {optimizing ? 'AI 处理中…' : plan.description.trim() ? '✨ AI 优化当前方案' : '✨ AI 补充方案'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
