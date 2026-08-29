/**
 * CharacterSourcePicker（V6.4 直接入口版）——替换人物卡内的三种身份来源操作。
 *
 * 图片库 / 本地导入点击即进入原有选择流程；文字描述在同一卡片内原位展开。
 * 来源按钮只改变选择视图，真正选中图片或输入描述后才走语义回调。
 */

import { useRef } from 'react';
import { PERSON_REPLACEMENT } from './recreationCopy';
import { personHasImage, type PersonReplacement, type PersonSource } from './modificationIntent';

export const PERSON_SOURCE_TABS: ReadonlyArray<{ key: PersonSource; label: string }> = [
  { key: 'gallery', label: PERSON_REPLACEMENT.sourceGallery },
  { key: 'local', label: PERSON_REPLACEMENT.sourceLocal },
  { key: 'description', label: PERSON_REPLACEMENT.sourceDescription },
];

interface CharacterSourcePickerProps {
  person: PersonReplacement | null;
  activeTab: PersonSource;
  disabled?: boolean;
  /** 兼容旧调用；直接入口版不再需要额外“更换中”页面。 */
  picking?: boolean;
  onCancelPick?: () => void;
  onTabChange: (tab: PersonSource) => void;
  onGalleryPick: () => void;
  onLocalPick: () => void;
  /** 描述输入（创建 / 更新文字描述人物；空文本 = 清除）。 */
  onDescriptionChange: (text: string) => void;
}

export default function CharacterSourcePicker({
  person,
  activeTab,
  disabled,
  onTabChange,
  onGalleryPick,
  onLocalPick,
  onDescriptionChange,
}: CharacterSourcePickerProps) {
  // 描述输入本地防抖：与自由文本一致，避免每按键一次语义提交 + 会话落库
  const debounceRef = useRef<number>(0);
  const handleDescriptionInput = (text: string) => {
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => onDescriptionChange(text), 400);
  };

  return (
    <div className="vision-person-source">
      <div className="vision-person-source-actions" role="group" aria-label={PERSON_REPLACEMENT.sourceLabel}>
        {PERSON_SOURCE_TABS.map(tab => (
          <button
            key={tab.key}
            type="button"
            aria-pressed={activeTab === tab.key}
            className={`app-btn app-btn-secondary app-btn-sm vision-person-source-action${activeTab === tab.key ? ' active' : ''}`}
            disabled={disabled}
            onClick={() => {
              onTabChange(tab.key);
              if (tab.key === 'gallery') onGalleryPick();
              if (tab.key === 'local') onLocalPick();
            }}
          >
            {tab.key === 'gallery' ? PERSON_REPLACEMENT.galleryChangeButton
              : tab.key === 'local' ? PERSON_REPLACEMENT.localChangeButton
                : PERSON_REPLACEMENT.descriptionChangeButton}
          </button>
        ))}
      </div>
      {activeTab === 'description' && (
        <div className="vision-person-entry">
          <textarea
            className="vision-person-description"
            rows={2}
            disabled={disabled}
            defaultValue={person?.source === 'description' ? person.description ?? '' : ''}
            key={person?.source === 'description' ? 'desc-filled' : 'desc-empty'}
            placeholder={PERSON_REPLACEMENT.descriptionPlaceholder}
            aria-label={PERSON_REPLACEMENT.descriptionLabel}
            onChange={e => handleDescriptionInput(e.target.value)}
          />
          <p className="vision-hint">{PERSON_REPLACEMENT.descriptionHint}</p>
        </div>
      )}
      {activeTab !== 'description' && !personHasImage(person) && <span className="vision-person-source-empty">请选择来源</span>}
    </div>
  );
}
