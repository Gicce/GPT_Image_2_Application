/**
 * PersonReplacementPanel（V4.1 视觉映射版）——「修改人物」维度的业务卡编排器。
 *
 * 结构（一眼看懂“谁被换成谁、服装跟谁、哪些内容保留”）：
 *  A. 业务卡头：人物替换 · 已启用 + 一句话说明 + 移除（secondary，非 danger）；
 *  B. ReferenceMapping：画面模板（@原图）→ 替换人物（@人物参考）双栏视觉映射；
 *  C. CharacterSourcePicker：人物来源 Segmented（仅未选 / 更换中 / 描述编辑中可见）；
 *  D. ClothingSourceControl：服装来源 Segmented（原图服装 / 人物服装 / 自定义按需展开）；
 *  E. ReplacementSummary：当前替换规则（真实配置动态派生，绝不写死）。
 *
 * 语义边界：来源 Tab 切换、更换人物进入选择态是视图操作（不产生语义修改）；真正落 draft
 *  的是人物数据（参考图 / 文字描述）与服装策略（走 props 回调 = 页面语义通道）。
 */

import { useEffect, useState } from 'react';
import { personHasImage, type ClothingPolicy, type ModificationDimension, type PersonReplacement, type PersonSource } from './modificationIntent';
import { PERSON_REPLACEMENT } from './recreationCopy';
import CharacterSourcePicker from './CharacterSourcePicker';
import ClothingSourceControl from './ClothingSourceControl';
import ReferenceMapping from './ReferenceMapping';
import ReplacementSummary from './ReplacementSummary';
import {
  PERSON_REPLACE_SCOPE_LABELS,
  PERSON_STRENGTH_LABELS,
} from './project/personContract';
import type {
  PersonConstraintStrength,
  PersonReplacementContract,
  PersonReplaceScope,
} from './project/types';

/** 画面模板信息（当前任务主参考图）。 */
export interface PersonPanelTemplate {
  path: string;
  label: string;
  assetId?: string;
}

interface PersonReplacementPanelProps {
  person: PersonReplacement | null;
  clothingPolicy: ClothingPolicy;
  customClothing: string;
  /** 画面模板（当前任务主参考图；缺失时显示占位）。 */
  template?: PersonPanelTemplate | null;
  /** clothing 独立维度同时激活时，服装策略区提示其作用于整体造型。 */
  clothingDimensionActive?: boolean;
  /** 已启用的修改维度（动作 / 背景等；「当前将执行」规则摘要动态派生）。 */
  activeDimensions?: ReadonlyArray<ModificationDimension>;
  /**
   * V4.1 人物替换合同 V2（项目化链路传入；缺省 = 非项目模式，不渲染 V2 控制区）：
   * strength / replaceScope / applyIdentityTo 由合同驱动，禁止组件自行造状态。
   */
  personContract?: PersonReplacementContract | null;
  onPersonContractChange?: (partial: Partial<PersonReplacementContract>) => void;
  /** 可选区域清单（replaceScope = custom_region 时的目标选择）。 */
  regionOptions?: ReadonlyArray<{ id: string; name: string; enabled: boolean }>;
  disabled?: boolean;
  onPersonChange: (person: PersonReplacement | null) => void;
  onClothingPolicyChange: (policy: ClothingPolicy) => void;
  onCustomClothingChange: (text: string) => void;
  onRemove: () => void;
  onGalleryPick: () => void;
  onLocalPick: () => void;
  /** 打开区域编辑器（创建 custom_region 目标）。 */
  onOpenRegionEditor?: () => void;
  /** 更换模板图（打开图库选新的主参考图；会重置当前分析）。 */
  onTemplateChange?: () => void;
}

const STRENGTH_OPTIONS: ReadonlyArray<{ value: PersonConstraintStrength; label: string; hint: string }> = [
  { value: 'strict', label: PERSON_STRENGTH_LABELS.strict, hint: '人物身份以参考图为准，模板人物身份不保留' },
  { value: 'balanced', label: PERSON_STRENGTH_LABELS.balanced, hint: '以参考图为主，允许与画面风格自然衔接' },
  { value: 'natural', label: PERSON_STRENGTH_LABELS.natural, hint: '参考图仅提供人物方向，不承诺保留具体面部特征' },
];

const SCOPE_OPTIONS: ReadonlyArray<{ value: PersonReplaceScope; label: string }> = [
  { value: 'whole_person', label: PERSON_REPLACE_SCOPE_LABELS.whole_person },
  { value: 'upper_body', label: PERSON_REPLACE_SCOPE_LABELS.upper_body },
  { value: 'face', label: PERSON_REPLACE_SCOPE_LABELS.face },
  { value: 'custom_region', label: PERSON_REPLACE_SCOPE_LABELS.custom_region },
];

export default function PersonReplacementPanel({
  person,
  clothingPolicy,
  customClothing,
  template,
  clothingDimensionActive,
  activeDimensions,
  personContract,
  onPersonContractChange,
  regionOptions,
  disabled,
  onPersonChange,
  onClothingPolicyChange,
  onCustomClothingChange,
  onRemove,
  onGalleryPick,
  onLocalPick,
  onOpenRegionEditor,
  onTemplateChange,
}: PersonReplacementPanelProps) {
  // 来源 Tab / 更换选择态 = 视图状态：切换不产生语义修改
  const [activeTab, setActiveTab] = useState<PersonSource>(person?.source ?? 'gallery');
  const [picking, setPicking] = useState(false);

  // 外部人物来源变化（图库 / 本地选图）时同步默认 Tab；选中图片人物即退出选择态
  useEffect(() => {
    if (person?.source) setActiveTab(person.source);
  }, [person?.source]);
  useEffect(() => {
    if (personHasImage(person)) setPicking(false);
  }, [person?.path, person]);

  const hasImageRef = personHasImage(person);
  /** 来源选择区可见性：未选 / 更换中 / 文字描述编辑中（已选图片人物 = 只显示卡片）。 */
  const showSourcePicker = picking || !hasImageRef;

  /** 描述输入（CharacterSourcePicker 内部防抖后回调）：非空创建描述人物，空 = 清除。 */
  const handleDescriptionChange = (text: string) => {
    onPersonChange(text.trim() ? { source: 'description', description: text } : null);
  };

  return (
    <div className="vision-person-panel is-business">
      {/* ===== A. 业务卡头 ===== */}
      <div className="vision-person-business-head">
        <span className="vision-person-business-icon" aria-hidden="true">👤</span>
        <div className="vision-person-business-text">
          <span className="vision-person-business-title">
            {PERSON_REPLACEMENT.title}
            <em className="vision-person-business-badge">{PERSON_REPLACEMENT.businessBadge}</em>
          </span>
          <p className="vision-person-business-desc">{PERSON_REPLACEMENT.businessDesc}</p>
        </div>
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

      {/* ===== B. 视觉映射：画面模板 → 替换人物 ===== */}
      <ReferenceMapping
        template={template}
        person={person}
        disabled={disabled}
        onTemplateChange={onTemplateChange}
        onPickPerson={onGalleryPick}
        onChangePerson={() => setPicking(true)}
      />

      {/* ===== C. 人物来源（未选 / 更换中 / 描述编辑中可见） ===== */}
      {showSourcePicker && (
        <CharacterSourcePicker
          person={person}
          activeTab={activeTab}
          disabled={disabled}
          picking={picking}
          onCancelPick={() => setPicking(false)}
          onTabChange={setActiveTab}
          onGalleryPick={onGalleryPick}
          onLocalPick={onLocalPick}
          onDescriptionChange={handleDescriptionChange}
        />
      )}

      {/* ===== D. 服装来源 ===== */}
      <ClothingSourceControl
        clothingPolicy={clothingPolicy}
        customClothing={customClothing}
        personHasReference={hasImageRef}
        clothingDimensionActive={clothingDimensionActive}
        disabled={disabled}
        onClothingPolicyChange={onClothingPolicyChange}
        onCustomClothingChange={onCustomClothingChange}
      />

      {/* ===== D2. 人物替换合同 V2（项目化链路：强度 / 范围 / 身份应用） ===== */}
      {personContract && personContract.enabled && onPersonContractChange && (
        <div className="vision-person-contract">
          <div className="vision-person-contract-row" role="radiogroup" aria-label="人物替换强度">
            <span className="vision-person-contract-label">人物替换强度</span>
            <div className="vision-person-contract-options">
              {STRENGTH_OPTIONS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={personContract.strength === option.value}
                  className={`vision-person-contract-btn ${personContract.strength === option.value ? 'active' : ''}`}
                  disabled={disabled}
                  title={option.hint}
                  onClick={() => onPersonContractChange({ strength: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="vision-hint">{STRENGTH_OPTIONS.find(o => o.value === personContract.strength)?.hint}</p>
          </div>

          <div className="vision-person-contract-row" role="radiogroup" aria-label="替换范围">
            <span className="vision-person-contract-label">替换范围</span>
            <div className="vision-person-contract-options">
              {SCOPE_OPTIONS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={personContract.replaceScope === option.value}
                  className={`vision-person-contract-btn vision-person-contract-sm ${personContract.replaceScope === option.value ? 'active' : ''}`}
                  disabled={disabled}
                  onClick={() => onPersonContractChange({ replaceScope: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {personContract.replaceScope === 'custom_region' && (
              <div className="vision-person-contract-region">
                {(regionOptions ?? []).filter(r => r.enabled).length > 0 ? (
                  <select
                    value={personContract.targetRegionId ?? ''}
                    disabled={disabled}
                    aria-label="目标区域"
                    onChange={e => onPersonContractChange({ targetRegionId: e.target.value || undefined })}
                  >
                    <option value="">选择区域…</option>
                    {(regionOptions ?? []).filter(r => r.enabled).map(region => (
                      <option key={region.id} value={region.id}>{region.name}</option>
                    ))}
                  </select>
                ) : (
                  <span className="vision-hint">
                    还没有可用区域。
                    {onOpenRegionEditor && (
                      <button type="button" className="vision-btn vision-btn-sm" disabled={disabled} onClick={onOpenRegionEditor}>
                        打开区域编辑器
                      </button>
                    )}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="vision-person-contract-row" role="radiogroup" aria-label="身份应用范围">
            <span className="vision-person-contract-label">身份应用</span>
            <div className="vision-person-contract-options">
              <button
                type="button"
                role="radio"
                aria-checked={personContract.applyIdentityTo === 'primary_subject_only'}
                className={`vision-person-contract-btn vision-person-contract-sm ${personContract.applyIdentityTo === 'primary_subject_only' ? 'active' : ''}`}
                disabled={disabled}
                onClick={() => onPersonContractChange({ applyIdentityTo: 'primary_subject_only' })}
              >
                仅主体人物
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={personContract.applyIdentityTo === 'all_corresponding_subjects'}
                className={`vision-person-contract-btn vision-person-contract-sm ${personContract.applyIdentityTo === 'all_corresponding_subjects' ? 'active' : ''}`}
                disabled={disabled}
                onClick={() => onPersonContractChange({ applyIdentityTo: 'all_corresponding_subjects' })}
              >
                所有对应主体（含分身 / 多姿态）
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== E. 当前替换规则（真实配置动态派生） ===== */}
      <ReplacementSummary
        person={person}
        clothingPolicy={clothingPolicy}
        customClothing={customClothing}
        activeDimensions={activeDimensions}
      />
    </div>
  );
}
