/**
 * ContextRail（§25）—— 工作台右侧「当前执行合同」栏（桌面端 sticky）。
 *
 *  - 内容全部读 EffectiveVisualPlan（buildEffectiveVisualPlan 唯一构建入口；
 *    本组件绝不自行拼装合同行）；
 *  - CTA（重新优化 / 优化复刻 Prompt / 确认生成图片）唯一渲染处：主工作区不再
 *    重复第二组生成按钮（单列布局下 Rail 随网格自然下移，仍只有一个 CTA 源）；
 *  - 「待优化」状态 = 项目修订落后于已优化修订 / recreation needsOptimization
 *    （派生比较；纯 UI 操作绝不影响这里的判定）。
 */

import { useMemo } from 'react';
import { buildEffectiveVisualPlan } from './effectivePlan';
import { describeRecreationStatus } from '../recreationPlan';
import type { VisualProject } from './types';

interface ContextRailProps {
  project: VisualProject | null;
  /** recreation 待优化判定（页面传入；与项目修订独立）。 */
  recreationNeedsOptimization: boolean;
  optimizerModelLabel: string | null;
  optimizerSourceSuffix: string;
  visionModelLabel: string;
  disabled?: boolean;
  showUseLastPrompt?: boolean;
  onUseLastPrompt?: () => void;
  onReoptimize?: () => void;
  onOptimize?: () => void;
  onGenerate?: () => void;
}

export default function ContextRail({
  project,
  recreationNeedsOptimization,
  optimizerModelLabel,
  optimizerSourceSuffix,
  visionModelLabel,
  disabled,
  showUseLastPrompt,
  onUseLastPrompt,
  onReoptimize,
  onOptimize,
  onGenerate,
}: ContextRailProps) {
  const plan = useMemo(() => (project ? buildEffectiveVisualPlan(project) : null), [project]);
  const status = describeRecreationStatus(null);

  if (!project || !plan) {
    return (
      <aside className="vision-rail" data-testid="vision-context-rail" aria-label="当前方案">
        <div className="vision-rail-card">
          <span className="vision-rail-title">当前方案</span>
          <p className="vision-hint">{status.note}</p>
        </div>
      </aside>
    );
  }

  const pending = recreationNeedsOptimization;

  return (
    <aside className="vision-rail" data-testid="vision-context-rail" aria-label="当前方案">
      <div className="vision-rail-card">
        <div className="vision-rail-head">
          <span className="vision-rail-title">当前方案</span>
          {pending && <em className="vision-rail-pending" title="合同已变更，最终 Prompt 尚未重建">待优化</em>}
        </div>

        {plan.template && (
          <div className="vision-rail-block">
            <span className="vision-rail-label">模板</span>
            <span className="vision-rail-value">@{plan.template.label}</span>
          </div>
        )}
        {plan.rows.map(row => (
          <div key={row.key} className={`vision-rail-row kind-${row.kind}`}>
            <span className="vision-rail-label">{row.label}</span>
            <span className="vision-rail-value" title={row.value}>{row.value}</span>
          </div>
        ))}

        <div className="vision-rail-divider" />

        <div className="vision-rail-block">
          <span className="vision-rail-label">Prompt 优化</span>
          <span className="vision-rail-value">
            {optimizerModelLabel ? `${optimizerModelLabel}${optimizerSourceSuffix || ' · 系统默认'}` : '未配置'}
          </span>
        </div>
        <div className="vision-rail-block">
          <span className="vision-rail-label">视觉分析</span>
          <span className="vision-rail-value">{visionModelLabel || '—'}</span>
        </div>
        <div className="vision-rail-block">
          <span className="vision-rail-label">图片生成</span>
          <span className="vision-rail-value">gpt-image-2</span>
        </div>
      </div>

      {plan.blockingErrors.length > 0 && (
        <div className="vision-rail-card is-error" role="alert">
          <span className="vision-rail-title">生成前需处理</span>
          <ul>
            {plan.blockingErrors.map(error => <li key={error}>{error}</li>)}
          </ul>
        </div>
      )}

      <div className="vision-rail-card vision-rail-cta">
        {showUseLastPrompt && onUseLastPrompt && (
          <button type="button" className="vision-btn vision-btn-sm" disabled={disabled} onClick={onUseLastPrompt}>
            使用上一次 Prompt
          </button>
        )}
        <button type="button" className="vision-btn vision-btn-sm" disabled={disabled} onClick={onReoptimize} title="基于当前图片与修改意图强制再优化一次">
          重新优化
        </button>
        <button
          type="button"
          className="vision-btn vision-btn-caution"
          disabled={disabled}
          onClick={onOptimize}
        >{pending ? '优化复刻 Prompt' : '优化复刻 Prompt'}</button>
        <button
          type="button"
          className="vision-btn vision-btn-primary"
          disabled={disabled || plan.blockingErrors.length > 0}
          onClick={onGenerate}
        >确认生成图片</button>
      </div>
    </aside>
  );
}
