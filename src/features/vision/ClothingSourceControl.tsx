/**
 * ClothingSourceControl（V4.1）——服装来源 Segmented Control。
 *
 * [原图服装] [人物服装] [自定义] 三选一（人物服装仅在有参考图时可选，语义与旧版一致）；
 * 选中项下方一行动态说明；只有「自定义」才展开服装描述输入（不占常驻高度）。
 * 键盘可达（原生 button）+ role=radiogroup/radio + aria-checked。
 */

import { CLOTHING_POLICY } from './recreationCopy';
import type { ClothingPolicy } from './modificationIntent';

interface ClothingSourceControlProps {
  clothingPolicy: ClothingPolicy;
  customClothing: string;
  /** 人物携带参考图（决定「人物服装」是否可选；无图时隐藏该选项，行为与旧版一致）。 */
  personHasReference: boolean;
  /** clothing 独立维度同时激活时的提示。 */
  clothingDimensionActive?: boolean;
  disabled?: boolean;
  onClothingPolicyChange: (policy: ClothingPolicy) => void;
  onCustomClothingChange: (text: string) => void;
}

export default function ClothingSourceControl({
  clothingPolicy,
  customClothing,
  personHasReference,
  clothingDimensionActive,
  disabled,
  onClothingPolicyChange,
  onCustomClothingChange,
}: ClothingSourceControlProps) {
  const options: ReadonlyArray<{ key: ClothingPolicy; label: string; hint: string }> = personHasReference
    ? [
        { key: 'preserve_original', label: CLOTHING_POLICY.preserveOriginal, hint: CLOTHING_POLICY.preserveOriginalHint },
        { key: 'use_subject_reference', label: CLOTHING_POLICY.useSubjectReference, hint: CLOTHING_POLICY.useSubjectReferenceHint },
        { key: 'custom', label: CLOTHING_POLICY.custom, hint: CLOTHING_POLICY.customHint },
      ]
    : [
        { key: 'preserve_original', label: CLOTHING_POLICY.preserveOriginal, hint: CLOTHING_POLICY.preserveOriginalHint },
        { key: 'custom', label: CLOTHING_POLICY.custom, hint: CLOTHING_POLICY.customHint },
      ];

  const activeHint = options.find(option => option.key === clothingPolicy)?.hint ?? '';
  /** 无参考图时旧选中值不可达：显示原图服装说明兜底。 */
  const fallbackHint = clothingPolicy === 'use_subject_reference' && !personHasReference
    ? CLOTHING_POLICY.preserveOriginalHint
    : activeHint;

  return (
    <div className="vision-person-block">
      <span className="vision-person-label">{CLOTHING_POLICY.sectionLabel}</span>
      <div className="vision-person-seg" role="radiogroup" aria-label={CLOTHING_POLICY.sectionLabel}>
        {options.map(option => (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={clothingPolicy === option.key}
            className={`vision-person-seg-btn${clothingPolicy === option.key ? ' active' : ''}`}
            disabled={disabled}
            onClick={() => onClothingPolicyChange(option.key)}
          >
            {option.label}
            {clothingPolicy === option.key && <span className="vision-person-seg-check" aria-hidden="true">✓</span>}
          </button>
        ))}
      </div>
      <p className="vision-person-seg-hint" role="status">{fallbackHint}</p>
      {clothingPolicy === 'custom' && (
        <div className="vision-person-custom">
          <label className="vision-person-label" htmlFor="vision-custom-clothing">{CLOTHING_POLICY.customInputLabel}</label>
          <textarea
            id="vision-custom-clothing"
            className="vision-person-description"
            rows={2}
            disabled={disabled}
            value={customClothing}
            placeholder={CLOTHING_POLICY.customInputPlaceholder}
            onChange={e => onCustomClothingChange(e.target.value)}
          />
        </div>
      )}
      {clothingDimensionActive && (
        <p className="vision-hint">「修改服装」维度已随服装来源自动启用：服装 / 造型会真实修改并出现在维度对比中（选择「原图服装」会自动取消该维度）。</p>
      )}
    </div>
  );
}
