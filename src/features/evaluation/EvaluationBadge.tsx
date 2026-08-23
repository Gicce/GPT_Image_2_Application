/**
 * 图片资产轻量评分徽章（Phase 23）：图库卡片 / 结果网格右上角只放一个数字
 * （+ 满意 👍），保持媒体优先——六维详情一律进 EvaluationPanel，禁止堆上卡片。
 */

import type { ImageEvaluation } from './types';
import './EvaluationBadge.css';

export default function EvaluationBadge({ evaluation }: { evaluation: ImageEvaluation | null | undefined }) {
  if (!evaluation) return null;
  const score = evaluation.overall_score;
  if (score == null) return null;
  const tone = score >= 90 ? 'excellent' : score >= 70 ? 'good' : 'poor';
  return (
    <span className={`eval-badge eval-badge-${tone}`} title={`AI 评价 · 综合完成度 ${score}`}>
      {score}
      {evaluation.user_rating === 'liked' && <span className="eval-badge-like" aria-label="我满意的">👍</span>}
    </span>
  );
}
