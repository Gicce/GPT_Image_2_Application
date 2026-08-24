/**
 * CharacterSourcePicker（V4.1）——人物来源 Segmented Control + 分来源入口。
 *
 * 只在选择人物阶段可见（未选 / 更换中 / 文字描述编辑中）：
 *  - 图片库 → 空态选择块（点击开图库弹层）；
 *  - 本地导入 → 空态选择块（点击开系统文件选择）；
 *  - 文字描述 → textarea（输入即创建 / 更新描述人物，本地防抖后走语义通道）。
 * 已选择图片人物时整个区块隐藏（卡片 + 更换人物 二选一，禁止“已选 + 大空选择框”并存）。
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
  /** 更换中（已有图片人物、点「更换人物」进入选择态）时显示取消按钮。 */
  picking: boolean;
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
  picking,
  onCancelPick,
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
      <div className="vision-person-block-head">
        <span className="vision-person-label">{PERSON_REPLACEMENT.sourceLabel}</span>
        {picking && onCancelPick && (
          <button
            type="button"
            className="vision-btn vision-btn-sm vision-person-source-cancel"
            disabled={disabled}
            onClick={onCancelPick}
          >
            {PERSON_REPLACEMENT.cancelPickButton}
          </button>
        )}
      </div>
      <div className="vision-person-seg" role="tablist" aria-label={PERSON_REPLACEMENT.sourceLabel}>
        {PERSON_SOURCE_TABS.map(tab => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.key}
            className={`vision-person-seg-btn${activeTab === tab.key ? ' active' : ''}`}
            disabled={disabled}
            onClick={() => onTabChange(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'gallery' && (
        <div className="vision-person-entry">
          <button type="button" className="vision-person-pick-tile" disabled={disabled} onClick={onGalleryPick}>
            <span className="vision-person-pick-plus" aria-hidden="true">＋</span>
            <span className="vision-person-pick-label">{PERSON_REPLACEMENT.galleryPickButton}</span>
          </button>
          {!personHasImage(person) && <p className="vision-hint">{PERSON_REPLACEMENT.personEmptyHint}</p>}
        </div>
      )}
      {activeTab === 'local' && (
        <div className="vision-person-entry">
          <button type="button" className="vision-person-pick-tile" disabled={disabled} onClick={onLocalPick}>
            <span className="vision-person-pick-plus" aria-hidden="true">＋</span>
            <span className="vision-person-pick-label">{PERSON_REPLACEMENT.localPickButton}</span>
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
            defaultValue={person?.source === 'description' ? person.description ?? '' : ''}
            key={person?.source === 'description' ? 'desc-filled' : 'desc-empty'}
            placeholder={PERSON_REPLACEMENT.descriptionPlaceholder}
            aria-label={PERSON_REPLACEMENT.descriptionLabel}
            onChange={e => handleDescriptionInput(e.target.value)}
          />
          <p className="vision-hint">{PERSON_REPLACEMENT.descriptionHint}</p>
        </div>
      )}
    </div>
  );
}
