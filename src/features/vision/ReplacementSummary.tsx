/**
 * ReplacementSummary（V4.1）——人物替换卡底部「当前替换规则」轻量摘要。
 *
 * 内容全部由 buildReplacementSummary 从真实配置派生（人物来源 / 服装策略 / 自定义描述），
 * 绝不写死；无人物时不渲染。用户不用读说明就能看懂 AI 准备怎么替换。
 */

import { REPLACEMENT_SUMMARY_LABELS, buildReplacementSummary } from './replacementRules';
import type { ClothingPolicy, ModificationDimension, PersonReplacement } from './modificationIntent';

interface ReplacementSummaryProps {
  person: PersonReplacement | null;
  clothingPolicy: ClothingPolicy;
  customClothing: string;
  /** 已启用的修改维度（动作 / 背景等；「修改」行与「保留」行动态派生）。 */
  activeDimensions?: ReadonlyArray<ModificationDimension>;
}

const KIND_LABELS: Record<'replace' | 'clothing' | 'modify' | 'keep', string> = {
  replace: REPLACEMENT_SUMMARY_LABELS.replaceKind,
  clothing: REPLACEMENT_SUMMARY_LABELS.clothingKind,
  modify: REPLACEMENT_SUMMARY_LABELS.modifyKind,
  keep: REPLACEMENT_SUMMARY_LABELS.keepKind,
};

export default function ReplacementSummary({ person, clothingPolicy, customClothing, activeDimensions }: ReplacementSummaryProps) {
  const model = buildReplacementSummary({ person, clothingPolicy, customClothing, activeDimensions });
  if (!model) return null;
  return (
    <div className="vision-person-summary" aria-label="当前替换规则">
      <span className="vision-person-summary-title">当前规则</span>
      <dl className="vision-person-summary-rows">
        {model.rows.map(row => (
          <div key={`${row.kind}:${row.items.join('-')}`} className={`vision-person-summary-row is-${row.kind}`}>
            <dt>{KIND_LABELS[row.kind]}</dt>
            <dd>
              <span className="vision-person-summary-items">{row.items.join(' · ')}</span>
              {row.kind === 'modify'
                ? (
                  <span className="vision-person-summary-plain is-note">{row.source}</span>
                ) : (
                  <>
                    <span className="vision-person-summary-arrow" aria-hidden="true">←</span>
                    <span className={row.isToken ? 'vision-person-summary-token' : 'vision-person-summary-plain'}>
                      {row.source}
                    </span>
                  </>
                )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
