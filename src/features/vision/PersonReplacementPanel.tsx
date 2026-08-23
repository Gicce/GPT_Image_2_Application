/**
 * PersonReplacementPanel（V4.1）——「修改人物」维度的结构化人物输入器。
 *
 * 三种人物来源（tab 语义）：图片库人物 / 本地导入 / 文字描述；
 * 图片来源（图库 / 本地）额外提供「服装处理」三选一（ClothingPolicy）：
 * 沿用原图服装（推荐）/ 使用参考人物服装 / 自定义服装（附描述输入）。
 *
 * 语义边界：来源 Tab 切换是视图操作（不产生语义修改）；真正落 draft 的是
 * 人物数据（参考图 / 文字描述）与服装策略。人物缩略图点击进全局 ImageViewer。
 */

import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { useImageViewerStore } from '../../store/useImageViewerStore';
import { personHasImage, type ClothingPolicy, type PersonReplacement, type PersonSource } from './modificationIntent';
import { CLOTHING_POLICY, PERSON_REPLACEMENT } from './recreationCopy';

interface PersonReplacementPanelProps {
  person: PersonReplacement | null;
  clothingPolicy: ClothingPolicy;
  customClothing: string;
  /** clothing 独立维度同时激活时，服装策略区提示其作用于整体造型。 */
  clothingDimensionActive?: boolean;
  disabled?: boolean;
  onPersonChange: (person: PersonReplacement | null) => void;
  onClothingPolicyChange: (policy: ClothingPolicy) => void;
  onCustomClothingChange: (text: string) => void;
  onRemove: () => void;
  onGalleryPick: () => void;
  onLocalPick: () => void;
}

const SOURCE_TABS: ReadonlyArray<{ key: PersonSource; label: string }> = [
  { key: 'gallery', label: PERSON_REPLACEMENT.sourceGallery },
  { key: 'local', label: PERSON_REPLACEMENT.sourceLocal },
  { key: 'description', label: PERSON_REPLACEMENT.sourceDescription },
];

export default function PersonReplacementPanel({
  person,
  clothingPolicy,
  customClothing,
  clothingDimensionActive,
  disabled,
  onPersonChange,
  onClothingPolicyChange,
  onCustomClothingChange,
  onRemove,
  onGalleryPick,
  onLocalPick,
}: PersonReplacementPanelProps) {
  // 来源 Tab = 视图状态：person 未落地数据前切 Tab 不产生语义修改
  const [activeTab, setActiveTab] = useState<PersonSource>(person?.source ?? 'gallery');
  const [thumbUrl, setThumbUrl] = useState('');
  const hasImageRef = personHasImage(person);

  useEffect(() => {
    let cancelled = false;
    const path = hasImageRef ? person?.path : '';
    if (!path) {
      setThumbUrl('');
      return;
    }
    void api.readThumbnail(path)
      .then(url => { if (!cancelled) setThumbUrl(url); })
      .catch(() => { if (!cancelled) setThumbUrl(''); });
    return () => { cancelled = true; };
  }, [hasImageRef, person?.path]);

  const openPersonViewer = () => {
    if (!person?.path) return;
    useImageViewerStore.getState().openViewer([{
      id: `person-${person.path}`,
      path: person.path,
      title: PERSON_REPLACEMENT.thumbnailAlt,
      fileName: person.path.split(/[\\/]/).pop(),
      metadata: [{ label: '用途', value: '人物替换参考图' }],
    }], 0);
  };

  const clothingOptions: ReadonlyArray<{
    key: ClothingPolicy;
    label: string;
    hint: string;
  }> = hasImageRef
    ? [
        { key: 'preserve_original', label: CLOTHING_POLICY.preserveOriginal, hint: CLOTHING_POLICY.preserveOriginalHint },
        { key: 'use_subject_reference', label: CLOTHING_POLICY.useSubjectReference, hint: CLOTHING_POLICY.useSubjectReferenceHint },
        { key: 'custom', label: CLOTHING_POLICY.custom, hint: CLOTHING_POLICY.customHint },
      ]
    : [
        { key: 'preserve_original', label: CLOTHING_POLICY.preserveOriginal, hint: CLOTHING_POLICY.preserveOriginalHint },
        { key: 'custom', label: CLOTHING_POLICY.custom, hint: CLOTHING_POLICY.customHint },
      ];

  return (
    <div className="vision-person-panel">
      <div className="vision-person-head">
        <span className="vision-person-title">{PERSON_REPLACEMENT.title}</span>
        <button
          type="button"
          className="vision-btn vision-btn-sm"
          disabled={disabled}
          onClick={onRemove}
          title="删除人物参考与人物修改维度（不影响其它修改与自由文本）"
        >
          {PERSON_REPLACEMENT.removeButton}
        </button>
      </div>

      <div className="vision-person-block">
        <span className="vision-person-label">{PERSON_REPLACEMENT.sourceLabel}</span>
        <div className="vision-person-tabs" role="tablist" aria-label={PERSON_REPLACEMENT.sourceLabel}>
          {SOURCE_TABS.map(tab => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              className={`vision-person-tab${activeTab === tab.key ? ' active' : ''}`}
              disabled={disabled}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="vision-person-block">
        <span className="vision-person-label">{PERSON_REPLACEMENT.referenceLabel}</span>
        {activeTab === 'gallery' && (
          <div className="vision-person-entry">
            <button type="button" className="vision-btn" disabled={disabled} onClick={onGalleryPick}>
              {PERSON_REPLACEMENT.galleryPickButton}
            </button>
            {!person && <p className="vision-hint">{PERSON_REPLACEMENT.emptyHint}</p>}
          </div>
        )}
        {activeTab === 'local' && (
          <div className="vision-person-entry">
            <button type="button" className="vision-btn" disabled={disabled} onClick={onLocalPick}>
              {PERSON_REPLACEMENT.localPickButton}
            </button>
            <p className="vision-hint">{PERSON_REPLACEMENT.localDropHint}</p>
          </div>
        )}
        {activeTab === 'description' && (
          <div className="vision-person-entry">
            <textarea
              className="vision-person-description"
              rows={2}
              disabled={disabled}
              value={person?.source === 'description' ? person.description ?? '' : ''}
              placeholder={PERSON_REPLACEMENT.descriptionPlaceholder}
              aria-label={PERSON_REPLACEMENT.descriptionLabel}
              onChange={e => {
                const text = e.target.value;
                onPersonChange(text.trim() ? { source: 'description', description: text } : null);
              }}
            />
            <p className="vision-hint">{PERSON_REPLACEMENT.descriptionHint}</p>
          </div>
        )}

        {hasImageRef && person && (
          <div className="vision-person-ref">
            <img
              className="vision-person-thumb"
              src={thumbUrl}
              alt={PERSON_REPLACEMENT.thumbnailAlt}
              title="点击在内置图片查看器中查看"
              onClick={openPersonViewer}
            />
            <div className="vision-person-ref-meta">
              <p className="vision-person-ref-label" title={person.path}>{person.label || person.path?.split(/[\\/]/).pop()}</p>
              <div className="vision-person-ref-actions">
                <button
                  type="button"
                  className="vision-btn vision-btn-sm"
                  disabled={disabled}
                  onClick={activeTab === 'gallery' ? onGalleryPick : onLocalPick}
                >
                  {PERSON_REPLACEMENT.changeButton}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="vision-person-block">
        <span className="vision-person-label">{CLOTHING_POLICY.sectionLabel}</span>
        <div className="vision-person-radios" role="radiogroup" aria-label={CLOTHING_POLICY.sectionLabel}>
          {clothingOptions.map(option => (
            <label key={option.key} className={`vision-person-radio${clothingPolicy === option.key ? ' checked' : ''}`}>
              <input
                type="radio"
                name="vision-clothing-policy"
                value={option.key}
                checked={clothingPolicy === option.key}
                disabled={disabled}
                onChange={() => onClothingPolicyChange(option.key)}
              />
              <span className="vision-person-radio-text">
                <span className="vision-person-radio-label">{option.label}</span>
                <span className="vision-person-radio-hint">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
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
          <p className="vision-hint">已同时选择「修改服装」维度：优化后服装 / 造型会出现在维度对比中。</p>
        )}
      </div>
    </div>
  );
}
