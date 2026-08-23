/**
 * AI 评价面板（Phase 14/15/17）：
 *  - 轻量头部（综合完成度一个数字）+ 展开的六维详情（null 维度显示「不适用」）；
 *  - strengths / issues / 下一轮建议（自然语言，不堆术语）；
 *  - 用户反馈区（👍 满意 / 👎 需要调整 + dislike 多选问题标签 + 补充说明）：
 *    AI 评分与用户反馈永远分离、分开落库；
 *  - 评价失败显示「暂无评价」+ 重新评价（绝不影响生成任务本身）；
 *  - liked = 满意（成功方案标记，只记录，不做任何自动训练 / Prompt 改写）。
 */

import { useMemo, useState } from 'react';
import { toastError, toastSuccess } from '../../components/Toast';
import { useEvaluationStore } from '../../store/useEvaluationStore';
import { useImageStore } from '../../store/useImageStore';
import type { Task } from '../../types';
import {
  DIMENSION_LABELS,
  DIMENSION_ORDER,
  composeFeedbackInstruction,
} from './evaluationModel';
import { ISSUE_TAG_OPTIONS, type ImageEvaluation, type UserRating } from './types';
import './EvaluationPanel.css';

interface EvaluationPanelProps {
  assetId: string;
  /** 重新评价需要任务上下文；缺省时隐藏「重新评价」入口。 */
  task?: Task | null;
  /** 评分口径标题：视觉复刻页「复刻完成度」，其余「综合完成度」。 */
  overallLabel?: string;
  /** 「继续调整」回调（反馈闭环；仅提供时显示按钮）。 */
  onContinueAdjust?: (evaluation: ImageEvaluation) => void;
}

function formatTime(iso: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function EvaluationPanel({
  assetId,
  task,
  overallLabel = '综合完成度',
  onContinueAdjust,
}: EvaluationPanelProps) {
  const evaluation = useEvaluationStore(s => s.evaluations[assetId]);
  const pending = useEvaluationStore(s => !!s.pending[assetId]);
  const failedMessage = useEvaluationStore(s => s.failed[assetId]);
  const submitFeedback = useEvaluationStore(s => s.submitFeedback);
  const images = useImageStore(s => s.images);

  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [textExpanded, setTextExpanded] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);

  const rating = evaluation?.user_rating ?? null;

  const canContinue = useMemo(
    () => !!onContinueAdjust && !!evaluation,
    [onContinueAdjust, evaluation],
  );

  const submitRating = async (next: UserRating) => {
    if (saving) return;
    setSaving(true);
    try {
      if (next === 'liked') {
        await submitFeedback(assetId, 'liked', [], '');
        toastSuccess('已标记为满意方案');
      } else {
        // 需要调整：先展开问题标签选择，保存由「保存反馈」完成
        setFeedbackOpen(true);
      }
    } catch (err: any) {
      toastError(err?.message || '反馈保存失败');
    } finally {
      setSaving(false);
    }
  };

  const saveDislikeFeedback = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await submitFeedback(assetId, 'disliked', selectedTags, comment.trim());
      setFeedbackOpen(false);
      toastSuccess('反馈已记录，可点击「继续调整」进入下一轮');
    } catch (err: any) {
      toastError(err?.message || '反馈保存失败');
    } finally {
      setSaving(false);
    }
  };

  const clearRating = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await submitFeedback(assetId, null, [], '');
      setSelectedTags([]);
      setComment('');
      setFeedbackOpen(false);
    } catch (err: any) {
      toastError(err?.message || '反馈清除失败');
    } finally {
      setSaving(false);
    }
  };

  const reEvaluate = async () => {
    if (!task) return;
    const { reEvaluateAsset } = await import('./evaluationService');
    const imageById = new Map(images.map(img => [img.id, img]));
    useEvaluationStore.getState().markPending(assetId);
    const saved = await reEvaluateAsset(task, imageById, assetId);
    useEvaluationStore.getState().clearPending(assetId);
    if (saved) {
      toastSuccess('重新评价完成');
    } else {
      const reason = useEvaluationStore.getState().failed[assetId] || '评价失败，请稍后重试';
      toastError(reason);
    }
  };

  const continueAdjust = () => {
    if (evaluation && onContinueAdjust) onContinueAdjust(evaluation);
  };

  return (
    <div className="eval-panel">
      <div className="eval-panel-head">
        <span className="eval-panel-title">AI 评价</span>
        {evaluation?.overall_score != null && (
          <span className="eval-panel-overall">
            {overallLabel} <strong>{evaluation.overall_score}</strong>
          </span>
        )}
      </div>

      {pending && (
        <p className="eval-panel-state">正在评价…</p>
      )}

      {!pending && !evaluation && (
        <div className="eval-panel-empty">
          <p className="eval-panel-state">暂无评价</p>
          {failedMessage && <p className="eval-panel-error" title={failedMessage}>{failedMessage}</p>}
          {task && (
            <button className="eval-panel-action" onClick={() => void reEvaluate()}>重新评价</button>
          )}
        </div>
      )}

      {!pending && evaluation && (
        <>
          <div className="eval-score-grid">
            {DIMENSION_ORDER.map(key => {
              const score = evaluation[key];
              return (
                <div key={key} className="eval-score-row">
                  <span className="eval-score-label">{DIMENSION_LABELS[key]}</span>
                  <span className={`eval-score-value ${score == null ? 'is-na' : score >= 90 ? 'is-high' : score < 70 ? 'is-low' : ''}`}>
                    {score == null ? '不适用' : score}
                  </span>
                </div>
              );
            })}
          </div>

          {(evaluation.strengths.length > 0 || evaluation.issues.length > 0) && (
            <>
              <div className={`eval-panel-text ${textExpanded ? 'is-expanded' : ''}`}>
                {evaluation.strengths.length > 0 && (
                  <p>{evaluation.strengths.join('；')}。</p>
                )}
                {evaluation.issues.length > 0 && (
                  <p>{evaluation.issues.join('；')}。</p>
                )}
              </div>
              {(evaluation.strengths.join('') + evaluation.issues.join('')).length > 96 && (
                <button className="eval-panel-action" onClick={() => setTextExpanded(v => !v)}>
                  {textExpanded ? '收起' : '查看完整评价'}
                </button>
              )}
            </>
          )}

          {evaluation.suggestion.trim() && (
            <div className="eval-panel-suggestion">
              <span className="eval-panel-suggestion-label">下一轮建议</span>
              <p>{evaluation.suggestion}</p>
            </div>
          )}

          <div className="eval-panel-feedback">
            <p className="eval-feedback-question">这次生成怎么样？</p>
            {rating == null && !feedbackOpen && (
              <div className="eval-feedback-actions">
                <button
                  className="eval-feedback-btn"
                  disabled={saving}
                  onClick={() => void submitRating('liked')}
                >
                  👍 满意
                </button>
                <button
                  className="eval-feedback-btn"
                  disabled={saving}
                  onClick={() => void submitRating('disliked')}
                >
                  👎 需要调整
                </button>
              </div>
            )}
            {rating != null && !feedbackOpen && (
              <div className="eval-feedback-current">
                <span>{rating === 'liked' ? '👍 你已标记为满意方案' : '👎 你已标记为需要调整'}</span>
                {rating === 'disliked' && evaluation.user_comment.trim() && (
                  <span className="eval-feedback-comment" title={evaluation.user_comment}>
                    {evaluation.user_comment}
                  </span>
                )}
                {rating === 'disliked' && evaluation.user_issue_tags.length > 0 && (
                  <span className="eval-feedback-tags">{evaluation.user_issue_tags.join('、')}</span>
                )}
                <button className="eval-panel-action" disabled={saving} onClick={() => void clearRating()}>
                  清除反馈
                </button>
              </div>
            )}
            {feedbackOpen && (
              <div className="eval-feedback-form">
                <div className="eval-feedback-tags-row">
                  {ISSUE_TAG_OPTIONS.map(tag => (
                    <button
                      key={tag}
                      type="button"
                      className={`eval-tag-chip ${selectedTags.includes(tag) ? 'is-active' : ''}`}
                      onClick={() => setSelectedTags(prev =>
                        prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag],
                      )}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
                <textarea
                  className="eval-feedback-textarea"
                  rows={2}
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  placeholder="补充说明（可选），例如：脸再接近原图一点，其他地方保持不变。"
                />
                <div className="eval-feedback-form-actions">
                  <button className="eval-panel-action" disabled={saving} onClick={() => setFeedbackOpen(false)}>取消</button>
                  <button
                    className="eval-feedback-save"
                    disabled={saving || (selectedTags.length === 0 && !comment.trim())}
                    onClick={() => void saveDislikeFeedback()}
                  >
                    {saving ? '保存中…' : '保存反馈'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {canContinue && (
            <button
              className="eval-continue-btn"
              onClick={continueAdjust}
              title={composeFeedbackInstruction(evaluation) || '基于上一轮评价与反馈继续调整'}
            >
              继续调整
            </button>
          )}

          <p className="eval-panel-meta">
            {evaluation.evaluated_at && <>评价于 {formatTime(evaluation.evaluated_at)}</>}
            {evaluation.evaluated_by && <> · {evaluation.evaluated_by}</>}
            {evaluation.evaluation_version && <> · {evaluation.evaluation_version}</>}
          </p>
          {task && (
            <button className="eval-panel-action eval-reevaluate" onClick={() => void reEvaluate()}>
              重新评价
            </button>
          )}
        </>
      )}
    </div>
  );
}
