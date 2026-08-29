/**
 * ClothingChangePanel（V6.4 / V6.8 减法版）——「修改服装」维度的独立业务面板。
 *
 * 结构（任务规范 §三）：服装来源三选一 / 服装参考（仅自定义时可选；
 * 人物服装自动使用人物参考）/ 多人服装单行。每个来源最多一句上下文提示，
 * 状态不变量等实现规则由系统处理，不向用户展示。
 * 服装策略与自定义描述仍通过 setClothingPolicy / commitModificationDraft 语义入口写入。
 */

import ClothingSourceControl from './ClothingSourceControl';
import { useImageViewerStore } from '../../store/useImageViewerStore';
import { personHasImage, type ClothingPolicy, type DimensionReferenceImage, type PersonReplacement } from './modificationIntent';
import { CLOTHING_POLICY } from './recreationCopy';
import { useThumb } from './usePersonThumb';

interface ClothingChangePanelProps {
  person: PersonReplacement | null;
  clothingPolicy: ClothingPolicy;
  customClothing: string;
  clothingReference?: DimensionReferenceImage;
  collapsed?: boolean;
  disabled?: boolean;
  onToggleCollapsed?: () => void;
  onClothingPolicyChange: (policy: ClothingPolicy) => void;
  onCustomClothingChange: (text: string) => void;
  onPickReferenceGallery: () => void;
  onPickReferenceLocal: () => void;
  onRemoveReference: () => void;
  onOpenMultiPersonMapping?: () => void;
}

export default function ClothingChangePanel({
  person,
  clothingPolicy,
  customClothing,
  clothingReference,
  collapsed,
  disabled,
  onToggleCollapsed,
  onClothingPolicyChange,
  onCustomClothingChange,
  onPickReferenceGallery,
  onPickReferenceLocal,
  onRemoveReference,
  onOpenMultiPersonMapping,
}: ClothingChangePanelProps) {
  const clothingThumb = useThumb(clothingReference?.path);
  const openClothingViewer = () => {
    if (!clothingReference?.path) return;
    useImageViewerStore.getState().openViewer([{
      id: `clothing-${clothingReference.path}`,
      path: clothingReference.path,
      title: CLOTHING_POLICY.referenceLabel,
      fileName: clothingReference.label,
      metadata: [{ label: '用途', value: CLOTHING_POLICY.refCardNote }],
    }], 0);
  };
  return (
    <section className="vision-clothing-panel" aria-label="服装更改">
      <header className="vision-subpanel-head">
        <div>
          <span className="vision-subpanel-title">服装更改</span>
        </div>
        <div className="vision-subpanel-actions">
          {onToggleCollapsed && (
            <button
              type="button"
              className="app-btn app-btn-secondary app-btn-sm"
              aria-expanded={!collapsed}
              onClick={onToggleCollapsed}
            >
              {collapsed ? '展开' : '收起'}
            </button>
          )}
        </div>
      </header>
      {!collapsed && (
        <div className="vision-clothing-body">
          <ClothingSourceControl
            clothingPolicy={clothingPolicy}
            customClothing={customClothing}
            personHasReference={personHasImage(person)}
            disabled={disabled}
            onClothingPolicyChange={onClothingPolicyChange}
            onCustomClothingChange={onCustomClothingChange}
          />
          {/* 服装参考：仅「自定义」时提供选择入口；「人物服装」自动使用人物参考；
              已存在的参考卡在任何来源下都可见（可移除），不隐藏数据 */}
          {clothingPolicy === 'custom' && (
            <div className="vision-dimension-reference">
              <div className="vision-dimension-reference-head">
                <span className="vision-person-label">{CLOTHING_POLICY.referenceLabel}</span>
                <div className="vision-dimension-reference-actions">
                  <button type="button" className="app-btn app-btn-secondary app-btn-sm" disabled={disabled} onClick={onPickReferenceGallery}>图片库选择</button>
                  <button type="button" className="app-btn app-btn-secondary app-btn-sm" disabled={disabled} onClick={onPickReferenceLocal}>本地导入</button>
                </div>
              </div>
              {!clothingReference && <p className="vision-hint">{CLOTHING_POLICY.referenceHintCustom}</p>}
            </div>
          )}
          {clothingReference && (
            <div className="vision-dimension-reference">
              <div className="vision-dimension-reference-card">
                <button type="button" className="vision-dimension-reference-thumb" disabled={disabled} title="点击在内置图片查看器中查看" onClick={openClothingViewer}>
                  {clothingThumb ? <img src={clothingThumb} alt="服装参考" /> : <span>图片加载中…</span>}
                </button>
                <div><strong>{clothingReference.label || CLOTHING_POLICY.referenceLabel}</strong><p>{CLOTHING_POLICY.refCardNote}</p></div>
                <button type="button" className="app-btn app-btn-secondary app-btn-sm" disabled={disabled} onClick={onRemoveReference}>移除</button>
              </div>
            </div>
          )}
          <div className="vision-clothing-multi">
            <strong>{CLOTHING_POLICY.multiLabel}</strong>
            {onOpenMultiPersonMapping && <button type="button" className="app-btn app-btn-secondary app-btn-sm" disabled={disabled} onClick={onOpenMultiPersonMapping}>{CLOTHING_POLICY.multiButton}</button>}
          </div>
        </div>
      )}
    </section>
  );
}
