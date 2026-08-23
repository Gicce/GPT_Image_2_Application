/**
 * ModificationChip 行（V4.1 Modification Dimension Selector）。
 *
 * 快捷按钮 = 结构化维度选择器（不是 textarea 文本追加）：
 *  - 选中态从 modificationDraft.activeDimensions 读取（绝不 includes() 解析 textarea）；
 *  - 同一维度唯一槽位：再次点击 = 取消并删除该维度结构化意图；
 *  - 不同维度可同时激活；「提高复刻度」是独立复刻强度开关，不占维度槽位；
 *  - 键盘可达 + aria-pressed；选中态 Brand Soft（不与 Primary CTA 同强度）。
 */

import { MODIFICATION_CHIP_DEFS, REPLICATION_BOOST_LABEL, type ModificationDraft, type ModificationDimension } from './modificationIntent';

interface ModificationChipsProps {
  draft: ModificationDraft;
  disabled?: boolean;
  onToggleDimension: (key: ModificationDimension) => void;
  onToggleBoost: () => void;
}

export default function ModificationChips({ draft, disabled, onToggleDimension, onToggleBoost }: ModificationChipsProps) {
  return (
    <div className="vision-intent-chips" role="group" aria-label="快捷修改维度">
      {MODIFICATION_CHIP_DEFS.map(chip => {
        const active = draft.activeDimensions.includes(chip.key);
        return (
          <button
            key={chip.key}
            type="button"
            className={`vision-intent-chip${active ? ' selected' : ''}`}
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onToggleDimension(chip.key)}
          >
            {active ? `✓ ${chip.label}` : chip.label}
          </button>
        );
      })}
      <button
        type="button"
        className={`vision-intent-chip vision-intent-chip-boost${draft.replicationBoost ? ' selected' : ''}`}
        aria-pressed={draft.replicationBoost}
        disabled={disabled}
        onClick={onToggleBoost}
        title="更贴近原图：未提及的视觉结构从严保持（独立生效，不是视觉维度）"
      >
        {draft.replicationBoost ? `✓ ${REPLICATION_BOOST_LABEL}` : REPLICATION_BOOST_LABEL}
      </button>
    </div>
  );
}
