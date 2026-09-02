/**
 * AIPlanningSurface（V4.2.9，docs/ai-comic/17 §二/§三/§四）—— 漫画 AI 规划统一
 * 状态面，由 ComicPlannerProgressCard 演进（同一阶段模型 comicPlannerProgress.ts，
 * 不是第二套 Loading Box）。推荐 / 技能起草 / 本期故事 / 角色 / 分镜共用的唯一实现：
 *  - 运行中（缺省 = 内容舞台居中）：标题 + 场景语义副文案 + 阶段清单（✓ 已完成 /
 *    ● 当前 / ○ 待执行，真实管道边界 resolving → planning → validating；retrying 是
 *    planning 的真实回退事件，显示在当前状态行）+ 真实 resolved 模型名 +
 *    已用时秒数（每秒真实计时，Progress Honesty 允许的事实）；
 *  - 无百分比（V4.2.9 裁定：规划是单次 LLM 调用，无 token 级进度，阶段锚点百分比
 *    会被读成真实生成进度 → 禁止渲染任何 %）；
 *  - 失败：原位错误 + [重试]（可选 [返回]），绝不停留在「规划中」；
 *  - 完成：✓ 完成态（成功后调用方通常直接切换视图，本态兜底）。
 * inline 档（character / storyboard 卡内嵌场景）保持 width:100% 不居中。
 */

import { useEffect, useState } from 'react';
import {
  COMIC_PLANNER_STAGE_LABEL,
  comicPlannerElapsedSeconds,
  isComicPlannerRunning,
  type ComicPlannerProgressStatus,
} from '../comicPlannerProgress';

/** 阶段清单流（真实可感知管道边界；retrying 不入清单——它是 planning 的回退事件）。 */
const PLANNING_STAGE_FLOW: readonly ComicPlannerProgressStatus[] = ['resolving', 'planning', 'validating'];

function stageIndex(status: ComicPlannerProgressStatus): number {
  if (status === 'resolving') return 0;
  if (status === 'planning' || status === 'retrying') return 1;
  if (status === 'validating') return 2;
  return PLANNING_STAGE_FLOW.length; // completed：全部完成
}

export interface AIPlanningSurfaceProps {
  /** 运行标题（如「AI 正在规划漫画」「AI 正在规划本期故事」）。 */
  title: string;
  status: ComicPlannerProgressStatus;
  startedAt: number | null;
  /** 真实 resolved 模型名（resolveModelForRole 预显或 outcome.modelName 回填）。 */
  modelLabel?: string | null;
  /** 场景语义副文案（如「正在构思 3 个完整故事并预演分镜」）。 */
  hint?: string | null;
  errorText?: string | null;
  onRetry?: () => void;
  /** 失败态重试按钮文案（如「重新推荐」）。 */
  retryLabel?: string;
  /** 失败态返回动作（清 run 回到输入态，输入保留）。 */
  onDismiss?: () => void;
  dismissLabel?: string;
  /** 卡内容流内嵌档（不居中、width:100%）：character / storyboard 场景。 */
  inline?: boolean;
}

export default function AIPlanningSurface({
  title,
  status,
  startedAt,
  modelLabel,
  hint,
  errorText,
  onRetry,
  retryLabel = '重试',
  onDismiss,
  dismissLabel = '返回',
  inline = false,
}: AIPlanningSurfaceProps) {
  const running = isComicPlannerRunning(status);
  const failed = status === 'failed';
  const completed = status === 'completed';
  // 每秒重算已用时：模型调用没有 token 级进度，UI 只报真实计时
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const elapsed = startedAt ? comicPlannerElapsedSeconds(startedAt, now) : 0;
  const currentIndex = stageIndex(status);

  return (
    <div
      className={`comic-planning-surface${inline ? ' is-inline' : ''}${failed ? ' is-failed' : ''}${completed ? ' is-completed' : ''}`}
      data-testid="comic-planning-surface"
      role="status"
      aria-live="polite"
    >
      <div className="comic-planning-surface-head">
        <span className="comic-planning-surface-title">
          {completed ? `✓ ${title.replace(/^AI 正在/, '')}完成` : failed ? 'AI 规划失败' : title}
        </span>
        {modelLabel ? (
          <span className="comic-planning-surface-model" data-testid="comic-planning-surface-model">
            {modelLabel}
          </span>
        ) : null}
      </div>
      {/* 失败态不渲染 spinner / 阶段清单：进度已停止，展示真实错误与重试（Progress Honesty） */}
      {running && <span className="comic-planning-surface-spinner" aria-hidden="true" />}
      {running && hint ? <p className="comic-planning-surface-hint">{hint}</p> : null}
      {running && (
        <ol className="comic-planning-stages" data-testid="comic-planning-stages">
          {PLANNING_STAGE_FLOW.map((stage, index) => {
            const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'pending';
            return (
              <li key={stage} className={`comic-planning-stage is-${state}`}>
                <span className="comic-planning-stage-dot" aria-hidden="true">
                  {state === 'done' ? '✓' : state === 'current' ? '●' : '○'}
                </span>
                <span className="comic-planning-stage-label">{COMIC_PLANNER_STAGE_LABEL[stage]}</span>
              </li>
            );
          })}
        </ol>
      )}
      <div className="comic-planning-surface-meta">
        <span className="comic-planning-surface-stage" data-testid="comic-planning-surface-stage">
          {COMIC_PLANNER_STAGE_LABEL[status]}
        </span>
        {running && <span className="comic-planning-surface-elapsed">已用时 {elapsed} 秒</span>}
      </div>
      {failed && (
        <div className="comic-planning-surface-error">
          <p data-testid="comic-planning-surface-error">{errorText || 'AI 规划失败，请重试。'}</p>
          <div className="comic-planning-surface-actions">
            {onRetry && (
              <button
                type="button"
                className="app-btn app-btn-secondary app-btn-sm"
                data-testid="comic-planning-retry"
                onClick={onRetry}
              >
                {retryLabel}
              </button>
            )}
            {onDismiss && (
              <button
                type="button"
                className="app-btn app-btn-secondary app-btn-sm"
                data-testid="comic-planning-dismiss"
                onClick={onDismiss}
              >
                {dismissLabel}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
