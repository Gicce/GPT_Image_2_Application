/**
 * OptimizeProgressCard（V6.8 §五）——「优化复刻 Prompt」运行期真实进度卡。
 *
 * 替换 CTA 按钮区渲染（ContextRail CTA 卡 / 无项目 footer 双入口共用）：
 *  - 运行中：标题 + 阶段型进度条（百分比只随真实阶段切换跳变）+ 当前阶段 + 已用时秒数；
 *  - 失败：真实错误 + [重新优化]（绝不停留在「正在优化」）；
 *  - 完成：✓ 优化完成 100%。
 * 已用时 = 每秒真实计时（Progress Honesty 允许的事实），不是伪进度。
 */

import { useEffect, useState } from 'react';
import {
  OPTIMIZATION_STAGE_LABEL,
  deriveOptimizationPercent,
  isOptimizationRunning,
  optimizationElapsedSeconds,
  optimizationProgressTone,
  type PromptOptimizationStatus,
} from './optimizeProgress';

interface OptimizeProgressCardProps {
  status: PromptOptimizationStatus;
  startedAt: number | null;
  modelLabel?: string | null;
  errorText?: string | null;
  onRetry?: () => void;
}

export default function OptimizeProgressCard({
  status,
  startedAt,
  modelLabel,
  errorText,
  onRetry,
}: OptimizeProgressCardProps) {
  const running = isOptimizationRunning(status);
  const tone = optimizationProgressTone(status);
  // 每秒重算已用时：模型调用没有 token 级进度，UI 只报真实计时
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const percent = deriveOptimizationPercent(status);
  const elapsed = startedAt ? optimizationElapsedSeconds(startedAt, now) : 0;

  return (
    <div
      className={`vision-optimize-progress is-${tone}`}
      data-testid="vision-optimize-progress"
      role="status"
      aria-live="polite"
    >
      <div className="vision-optimize-progress-head">
        <span className="vision-optimize-progress-title">
          {tone === 'completed' ? '✓ 优化完成' : tone === 'failed' ? OPTIMIZATION_STAGE_LABEL.failed : '正在优化复刻 Prompt'}
        </span>
        {modelLabel ? <span className="vision-optimize-progress-model">{modelLabel}</span> : null}
      </div>
      {/* 失败态不渲染进度条：进度已停止，任何条形/百分比都会误导（Progress Honesty） */}
      {tone !== 'failed' && (
        <div className="vision-optimize-progress-bar" aria-hidden="true">
          {percent !== null ? (
            <div
              className={`vision-optimize-progress-fill${running ? ' is-animated' : ''}`}
              style={{ width: `${percent}%` }}
              data-testid="vision-optimize-progress-fill"
            />
          ) : (
            <div className="vision-optimize-progress-fill is-animated" style={{ width: '100%' }} />
          )}
        </div>
      )}
      <div className="vision-optimize-progress-meta">
        <span className="vision-optimize-progress-stage" data-testid="vision-optimize-progress-stage">
          {OPTIMIZATION_STAGE_LABEL[status]}
        </span>
        <span className="vision-optimize-progress-percent">
          {percent !== null ? `${percent}%` : tone === 'failed' ? '已停止' : '…'}
        </span>
        {running && <span className="vision-optimize-progress-elapsed">已用时 {elapsed} 秒</span>}
      </div>
      {tone === 'failed' && (
        <div className="vision-optimize-progress-error">
          <p>{errorText || '优化失败，请重试。'}</p>
          {onRetry && (
            <button
              type="button"
              className="vision-btn vision-btn-sm vision-btn-caution"
              data-testid="vision-optimize-retry"
              onClick={onRetry}
            >
              重新优化
            </button>
          )}
        </div>
      )}
    </div>
  );
}
