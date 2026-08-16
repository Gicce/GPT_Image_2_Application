/**
 * 批量方案详情抽屉 —— 页面最外层 Overlay，审核 / 编辑单个方案。
 *
 * 数据源唯一：plans[id]（父组件 state）。抽屉内部只维护 draft，
 * 「保存修改」显式回写；未保存关闭 / 切换方案前必须确认。
 * 重新优化完成时 AI 新内容直接刷新 draft（保持抽屉打开继续检查）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { GenerationPlan } from '../utils/batchPlans';
import { isPlanReady } from '../utils/batchPlans';
import { copyText } from '../utils/clipboard';
import { toastError, toastSuccess } from './Toast';
import { planStatusBadge } from './BatchPlanCard';
import './BatchPlans.css';

/** 通用确认弹窗（批量页共用：未保存保护 / 重新规划全部 / 覆盖手动修改等） */
export function BpConfirmDialog(props: {
  title: string;
  text: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="bp-confirm-overlay" onClick={props.onCancel}>
      <div className="bp-confirm" onClick={e => e.stopPropagation()}>
        <div className="bp-confirm-title">{props.title}</div>
        <div className="bp-confirm-text">{props.text}</div>
        <div className="bp-confirm-actions">
          <button type="button" className="settings-btn settings-btn-secondary settings-btn-sm" onClick={props.onCancel}>取消</button>
          <button
            type="button"
            className={`settings-btn settings-btn-sm ${props.danger ? 'settings-btn-danger' : 'settings-btn-primary'}`}
            onClick={props.onConfirm}
          >
            {props.confirmLabel || '继续'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PlanDraft {
  title: string;
  summary: string;
  description: string;
  positivePrompt: string;
  negativePrompt: string;
}

function extractDraft(plan: GenerationPlan): PlanDraft {
  return {
    title: plan.title,
    summary: plan.summary,
    description: plan.description,
    positivePrompt: plan.positivePrompt,
    negativePrompt: plan.negativePrompt,
  };
}

function draftDirty(draft: PlanDraft, plan: GenerationPlan): boolean {
  return draft.title !== plan.title
    || draft.summary !== plan.summary
    || draft.description !== plan.description
    || draft.positivePrompt !== plan.positivePrompt
    || draft.negativePrompt !== plan.negativePrompt;
}

async function copy(text: string, label: string) {
  if (!text.trim()) {
    toastError('内容为空，无法复制');
    return;
  }
  if (await copyText(text)) toastSuccess(label);
}

export default function BatchPlanDetailDrawer(props: {
  plan: GenerationPlan;
  index: number;
  total: number;
  optimizerConfigured: boolean;
  optimizerModelLabel: string | null;
  onClose: () => void;
  onSave: (patch: Partial<GenerationPlan>) => void;
  onReoptimize: () => void;
  onDelete: () => void;
  onNavigate: (delta: number) => void;
  /** 只读模式（历史记录方案详情）：隐藏全部编辑能力，body 走只读渲染 + readOnlyExtras。 */
  readOnly?: boolean;
  /** 只读模式下状态 Badge 覆盖（默认显示优化状态，历史需要显示执行状态）。 */
  statusOverride?: { label: string; cls: string };
  /** 只读模式 body 末尾的附加内容（实际执行指令 / 时间 / 结果图等）。 */
  readOnlyExtras?: React.ReactNode;
}) {
  const { plan } = props;
  const readOnly = !!props.readOnly;
  const [draft, setDraft] = useState<PlanDraft>(() => extractDraft(plan));
  const [savedFlash, setSavedFlash] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [pendingNav, setPendingNav] = useState<number | null>(null);
  const prevStatusRef = useRef(plan.optimizationStatus);

  const optimizing = plan.optimizationStatus === 'loading';
  const status = readOnly && props.statusOverride ? props.statusOverride : planStatusBadge(plan);
  const dirty = useMemo(() => !readOnly && draftDirty(draft, plan), [readOnly, draft, plan]);

  // 切换方案：重置 draft
  useEffect(() => {
    setDraft(extractDraft(plan));
    setSavedFlash(false);
    prevStatusRef.current = plan.optimizationStatus;
  }, [plan.id]);

  // 重新优化完成（loading → 非 loading）：AI 新内容刷新 draft，抽屉保持打开
  useEffect(() => {
    if (prevStatusRef.current === 'loading' && plan.optimizationStatus !== 'loading') {
      setDraft(extractDraft(plan));
      setSavedFlash(false);
    }
    prevStatusRef.current = plan.optimizationStatus;
  }, [plan]);

  function requestClose() {
    if (readOnly) {
      props.onClose();
      return;
    }
    if (optimizing) {
      props.onClose();
      return;
    }
    if (dirty) setConfirmClose(true);
    else props.onClose();
  }

  function requestNav(delta: number) {
    if (!readOnly && !optimizing && dirty) {
      setPendingNav(delta);
      return;
    }
    props.onNavigate(delta);
  }

  // Esc 关闭（未保存时走确认）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') requestClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  function patchDraft(patch: Partial<PlanDraft>) {
    setDraft(prev => ({ ...prev, ...patch }));
    setSavedFlash(false);
  }

  function save() {
    props.onSave({
      title: draft.title.trim(),
      summary: draft.summary.trim(),
      description: draft.description.trim(),
      positivePrompt: draft.positivePrompt.trim(),
      negativePrompt: draft.negativePrompt.trim(),
      isManuallyEdited: true,
    });
    setSavedFlash(true);
    toastSuccess('方案已保存');
  }

  function copyAll() {
    const source = readOnly
      ? { title: plan.title, positivePrompt: plan.positivePrompt, negativePrompt: plan.negativePrompt }
      : { title: draft.title, positivePrompt: draft.positivePrompt, negativePrompt: draft.negativePrompt };
    const text = [
      `方案：${source.title.trim() || `方案 ${props.index + 1}`}`,
      '',
      '正向提示词：',
      source.positivePrompt.trim(),
      '',
      '负面提示词：',
      source.negativePrompt.trim() || '（空）',
    ].join('\n');
    void copy(text, '方案完整内容已复制');
  }

  const modelLabel = plan.optimizerProviderName
    ? `${plan.optimizerProviderName} / ${plan.optimizerModelName}`
    : props.optimizerModelLabel || '';

  return (
    <div className="bp-drawer-overlay" onClick={requestClose}>
      <div className="bp-drawer" onClick={e => e.stopPropagation()}>
        <div className="bp-drawer-header">
          <div className="bp-drawer-head-top">
            <span className="bp-drawer-plan-no">方案 {props.index + 1} / {props.total}</span>
            <span className="bp-drawer-title" title={draft.title || `方案 ${props.index + 1}`}>
              {draft.title.trim() || `方案 ${props.index + 1}`}
            </span>
            <button type="button" className="bp-drawer-close" aria-label="关闭" title="关闭" onClick={requestClose}>×</button>
          </div>
          <div className="bp-drawer-meta">
            <span className={`bp-status-badge ${status.cls}`}>{status.label}</span>
            {modelLabel && <span>✨ {modelLabel}</span>}
            {!readOnly && !isPlanReady(plan) && <span>填写方案描述后可 AI 优化为提示词</span>}
          </div>
        </div>

        <div className="bp-drawer-body">
          {readOnly ? (
            <>
              <div className="form-group">
                <div className="bp-drawer-field-head"><label>方案描述</label></div>
                <p className="bp-readonly-text">{plan.description.trim() || '（该方案没有描述）'}</p>
              </div>
              <div className="form-group">
                <div className="bp-drawer-field-head"><label>方案摘要</label></div>
                <p className="bp-readonly-text">{plan.summary.trim() || '（该方案没有摘要）'}</p>
              </div>
              {plan.tags.length > 0 && (
                <div className="form-group">
                  <div className="bp-drawer-field-head"><label>重点标签</label></div>
                  <div className="bp-drawer-tags">
                    {plan.tags.map(tag => <span className="bp-tag" key={tag}>{tag}</span>)}
                  </div>
                </div>
              )}
              <div className="bp-drawer-divider" />
              <div className="form-group">
                <div className="bp-drawer-field-head">
                  <label>正向提示词</label>
                  <button type="button" className="settings-btn settings-btn-secondary settings-btn-sm" onClick={() => void copy(plan.positivePrompt, '正向提示词已复制')}>⧉ 复制</button>
                </div>
                <p className="bp-readonly-text bp-readonly-prompt">{plan.positivePrompt}</p>
              </div>
              <div className="form-group">
                <div className="bp-drawer-field-head">
                  <label>负面提示词</label>
                  <button type="button" className="settings-btn settings-btn-secondary settings-btn-sm" onClick={() => void copy(plan.negativePrompt, '负面提示词已复制')}>⧉ 复制</button>
                </div>
                <p className="bp-readonly-text bp-readonly-prompt bp-readonly-negative">{plan.negativePrompt.trim() || '（空）'}</p>
              </div>
              {props.readOnlyExtras}
            </>
          ) : (
          <>
          {optimizing && (
            <div className="bp-drawer-optimizing">AI 正在重新优化该方案…编辑暂时锁定，其他方案不受影响。</div>
          )}

          {plan.optimizationStatus === 'error' && (
            <p className="bp-card-error">重新优化失败：{plan.optimizationError || '请重试'}（已保留原方案内容）</p>
          )}

          <div className="form-group">
            <div className="bp-drawer-field-head">
              <label>方案标题</label>
            </div>
            <input
              type="text"
              value={draft.title}
              disabled={optimizing}
              placeholder="例如：红黑重甲 · 长枪 · 古城墙"
              onChange={e => patchDraft({ title: e.target.value })}
            />
          </div>

          <div className="form-group">
            <div className="bp-drawer-field-head">
              <label>方案描述 <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>（重新优化的核心输入）</span></label>
            </div>
            <textarea
              rows={4}
              value={draft.description}
              disabled={optimizing}
              placeholder="描述这个方案具体要画什么，例如：骑马女将，雨夜军营，手持长弓……"
              onChange={e => patchDraft({ description: e.target.value })}
            />
          </div>

          <div className="form-group">
            <div className="bp-drawer-field-head">
              <label>方案摘要</label>
            </div>
            <textarea
              rows={2}
              value={draft.summary}
              disabled={optimizing}
              placeholder="AI 生成的简洁摘要（可编辑，主页卡片展示用）"
              onChange={e => patchDraft({ summary: e.target.value })}
            />
          </div>

          {plan.tags.length > 0 && (
            <div className="form-group">
              <div className="bp-drawer-field-head">
                <label>重点标签</label>
              </div>
              <div className="bp-drawer-tags">
                {plan.tags.map(tag => <span className="bp-tag" key={tag}>{tag}</span>)}
              </div>
            </div>
          )}

          <div className="bp-drawer-divider" />

          <div className="form-group">
            <div className="bp-drawer-field-head">
              <label>正向提示词</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" className="settings-btn settings-btn-secondary settings-btn-sm" onClick={() => void copy(draft.positivePrompt, '正向提示词已复制')}>⧉ 复制</button>
              </div>
            </div>
            <textarea
              className="bp-textarea-prompt"
              value={draft.positivePrompt}
              disabled={optimizing}
              placeholder="完整正向提示词（可查看 / 复制 / 手动修改）"
              onChange={e => patchDraft({ positivePrompt: e.target.value })}
            />
          </div>

          <div className="form-group">
            <div className="bp-drawer-field-head">
              <label>负面提示词</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" className="settings-btn settings-btn-secondary settings-btn-sm" onClick={() => void copy(draft.negativePrompt, '负面提示词已复制')}>⧉ 复制</button>
              </div>
            </div>
            <textarea
              className="bp-textarea-negative"
              value={draft.negativePrompt}
              disabled={optimizing}
              placeholder="不希望出现在图片中的内容（可编辑，可为空）"
              onChange={e => patchDraft({ negativePrompt: e.target.value })}
            />
          </div>
          </>
          )}
        </div>

        <div className="bp-drawer-footer">
          {!readOnly && (
          <div className="bp-drawer-footer-row">
            <button
              type="button"
              className="settings-btn settings-btn-secondary settings-btn-sm"
              disabled={optimizing || !props.optimizerConfigured || !draft.description.trim()}
              title="重新优化当前方案（重新生成标题 / 摘要 / 标签 / 提示词）"
              onClick={props.onReoptimize}
            >
              {optimizing ? 'AI 正在重新优化…' : '✨ 重新优化'}
            </button>
            <button
              type="button"
              className="settings-btn settings-btn-primary settings-btn-sm"
              disabled={optimizing || !dirty}
              onClick={save}
            >
              保存修改
            </button>
            {savedFlash && !dirty && <span className="bp-saved-hint">✓ 已保存</span>}
            <span className="bp-footer-spacer" />
            <button
              type="button"
              className="settings-btn settings-btn-secondary settings-btn-sm"
              onClick={copyAll}
            >
              复制全部
            </button>
            <button
              type="button"
              className="settings-btn settings-btn-danger settings-btn-sm"
              disabled={optimizing}
              onClick={props.onDelete}
            >
              删除方案
            </button>
          </div>
          )}
          {readOnly && (
            <div className="bp-drawer-footer-row">
              <span className="bp-drawer-nav-info">历史方案为任务创建时的快照，仅供查看</span>
              <span className="bp-footer-spacer" />
              <button
                type="button"
                className="settings-btn settings-btn-secondary settings-btn-sm"
                onClick={copyAll}
              >
                复制全部
              </button>
            </div>
          )}
          <div className="bp-drawer-nav">
            <button
              type="button"
              className="settings-btn settings-btn-secondary settings-btn-sm"
              disabled={props.index <= 0}
              onClick={() => requestNav(-1)}
            >
              ← 上一个方案
            </button>
            <span className="bp-drawer-nav-info">{dirty ? '有未保存修改' : ''}</span>
            <button
              type="button"
              className="settings-btn settings-btn-secondary settings-btn-sm"
              disabled={props.index >= props.total - 1}
              onClick={() => requestNav(1)}
            >
              下一个方案 →
            </button>
          </div>
        </div>
      </div>

      {(confirmClose || pendingNav !== null) && (
        <BpConfirmDialog
          title="当前方案有未保存修改"
          text={confirmClose ? '关闭后将放弃未保存的修改。' : '切换方案后将放弃未保存的修改。'}
          confirmLabel="放弃修改"
          danger
          onCancel={() => { setConfirmClose(false); setPendingNav(null); }}
          onConfirm={() => {
            const nav = pendingNav;
            setConfirmClose(false);
            setPendingNav(null);
            setDraft(extractDraft(plan));
            if (confirmClose) props.onClose();
            else if (nav !== null) props.onNavigate(nav);
          }}
        />
      )}
    </div>
  );
}
