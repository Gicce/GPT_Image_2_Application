/**
 * RegionEditorPanel（§28 / V6.8 §四）—— 素材替换的第三个子面板（区域替换）。
 *
 *  - 列表态：区域卡（名称 / 用途 / 替换对象 / 范围 / 约束 / mask 状态 / 编辑 / 删除）+
 *    [添加替换区域] 入口；
 *  - 编辑态：全宽 RegionCanvasEditor（页面级切换，不塞 Modal）；
 *  - 区域数据（project.regions）与人物替换 scope 完全分离，互不推导；
 *  - 所有变更经页面语义通道（onRegionsChange → 项目 store，revision +1）；
 *    打开 / 关闭编辑器 / 切工具 = 视图操作（不触发修订）。
 */

import { useEffect, useState } from 'react';
import RegionCanvasEditor from './RegionCanvasEditor';
import { createRegion, REGION_TYPE_LABELS } from '../project/region';
import { describeRegionRow } from '../project/effectivePlan';
import { PERSON_REPLACE_SCOPE_LABELS, PERSON_STRENGTH_LABELS } from '../project/personContract';
import type {
  PersonConstraintStrength,
  RegionReplacement,
  RegionReplaceType,
  VisualReferenceAsset,
} from '../project/types';

interface RegionEditorPanelProps {
  imagePath: string;
  regions: ReadonlyArray<RegionReplacement>;
  references: ReadonlyArray<VisualReferenceAsset>;
  /** 外部「打开区域编辑器」请求（递增计数信号；0 = 无请求）。 */
  openRequest?: number;
  /** 外部打开时预设新区域用途；多人映射入口传 person。 */
  openPurpose?: RegionReplaceType;
  disabled?: boolean;
  onRegionsChange: (updater: (regions: RegionReplacement[]) => RegionReplacement[]) => void;
  /** 单区域 mask PNG 落盘（导出该区域自身 mask 并回填路径）。 */
  onPersistRegionMask: (regionId: string) => void;
  /** 人物参考绑定选择（区域用途=人物时）。 */
  onPickRegionPersonReference: (regionId: string) => void;
}

const TYPE_OPTIONS: ReadonlyArray<{ value: RegionReplaceType; label: string }> = [
  { value: 'person', label: REGION_TYPE_LABELS.person },
  { value: 'background', label: REGION_TYPE_LABELS.background },
  { value: 'object', label: REGION_TYPE_LABELS.object },
  { value: 'custom', label: REGION_TYPE_LABELS.custom },
];

const STRENGTH_OPTIONS: PersonConstraintStrength[] = ['natural', 'balanced', 'strict'];

export default function RegionEditorPanel({
  imagePath,
  regions,
  references,
  openRequest,
  openPurpose,
  disabled,
  onRegionsChange,
  onPersistRegionMask,
  onPickRegionPersonReference,
}: RegionEditorPanelProps) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingPurpose, setPendingPurpose] = useState<RegionReplaceType>('custom');

  // 外部打开信号（PersonPanel custom_region 空区域提示的 CTA）
  useEffect(() => {
    if (openRequest && openRequest > 0) {
      setPendingPurpose(openPurpose ?? 'custom');
      setEditorOpen(true);
    }
  }, [openPurpose, openRequest]);

  if (editorOpen) {
    return (
      <RegionCanvasEditor
        imagePath={imagePath}
        disabled={disabled}
        onBack={() => setEditorOpen(false)}
        onCommit={shape => {
          const created = createRegion({ shape, replaceType: pendingPurpose });
          onRegionsChange(list => {
            return [...list, created];
          });
          setExpandedId(created.id);
          setEditorOpen(false);
        }}
      />
    );
  }

  return (
    <section className="vision-regions vision-subpanel" data-testid="region-panel" aria-label="区域替换">
      <header className="vision-subpanel-head">
        <div>
          <span className="vision-subpanel-title">区域替换</span>
          <p>选择画面区域并指定新的内容。</p>
        </div>
        <div className="vision-subpanel-actions">
          {regions.length > 0 && (
            <span className="vision-region-count-badge" data-testid="vision-region-count">{regions.length} 个区域</span>
          )}
          <button
            type="button"
            className="vision-btn vision-btn-sm"
            data-testid="vision-region-add"
            disabled={disabled}
            onClick={() => { setPendingPurpose('custom'); setEditorOpen(true); }}
          >添加替换区域</button>
        </div>
      </header>

      {regions.length === 0 && (
        <p className="vision-hint vision-regions-empty">还没有区域。点击「添加替换区域」框选第一个区域。</p>
      )}

      {regions.map(region => {
        const info = describeRegionRow(region, references);
        const expanded = expandedId === region.id;
        return (
          <div key={region.id} className={`vision-region-card ${region.enabled ? '' : 'is-disabled'}`} data-region-id={region.id}>
            <button
              type="button"
              className="vision-region-card-head"
              onClick={() => setExpandedId(expanded ? null : region.id)}
              aria-expanded={expanded}
            >
              <span className="vision-region-card-name">
                {region.name}
                <em className="vision-region-card-type">{info.typeLabel}</em>
              </span>
              <span className="vision-region-card-meta">
                {region.replaceType === 'person' && info.refLabel ? `@${info.refLabel} · ` : ''}
                {info.positionLabel} · {PERSON_STRENGTH_LABELS[region.constraintStrength]}
                {region.maskPath ? ' · mask 已保存' : ' · 无 mask'}
                {region.enabled ? '' : ' · 已停用'}
              </span>
            </button>

            {expanded && (
              <div className="vision-region-card-body">
                <div className="vision-region-form-row">
                  <label>区域名称</label>
                  <input
                    type="text"
                    value={region.name}
                    disabled={disabled}
                    onChange={e => onRegionsChange(list =>
                      list.map(item => item.id === region.id ? { ...item, name: e.target.value } : item))}
                  />
                </div>
                <div className="vision-region-form-row">
                  <label>用途</label>
                  <select
                    value={region.replaceType}
                    disabled={disabled}
                    onChange={e => onRegionsChange(list =>
                      list.map(item => item.id === region.id
                        ? { ...item, replaceType: e.target.value as RegionReplaceType }
                        : item))}
                  >
                    {TYPE_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                {region.replaceType === 'person' && (
                  <>
                    <div className="vision-region-form-row">
                      <label>替换人物</label>
                      {region.personReferenceId ? (
                        <span className="vision-region-ref-label">
                          @{references.find(ref => ref.id === region.personReferenceId)?.label ?? '—'}
                          <button
                            type="button"
                            className="vision-btn vision-btn-sm"
                            disabled={disabled}
                            onClick={() => onPickRegionPersonReference(region.id)}
                          >更换</button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="vision-btn vision-btn-sm"
                          disabled={disabled}
                          onClick={() => onPickRegionPersonReference(region.id)}
                        >@人物参考…</button>
                      )}
                    </div>
                    <div className="vision-region-form-row" role="radiogroup" aria-label="替换范围">
                      <label>替换范围</label>
                      <div className="vision-region-seg">
                        {(['whole_person', 'upper_body', 'face'] as const).map(scope => (
                          <button
                            key={scope}
                            type="button"
                            role="radio"
                            aria-checked={(region.replaceScope ?? 'whole_person') === scope}
                            className={`vision-region-seg-btn ${(region.replaceScope ?? 'whole_person') === scope ? 'active' : ''}`}
                            disabled={disabled}
                            onClick={() => onRegionsChange(list =>
                              list.map(item => item.id === region.id ? { ...item, replaceScope: scope } : item))}
                          >{PERSON_REPLACE_SCOPE_LABELS[scope]}</button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
                <div className="vision-region-form-row" role="radiogroup" aria-label="区域约束">
                  <label>约束</label>
                  <div className="vision-region-seg">
                    {STRENGTH_OPTIONS.map(strength => (
                      <button
                        key={strength}
                        type="button"
                        role="radio"
                        aria-checked={region.constraintStrength === strength}
                        className={`vision-region-seg-btn ${region.constraintStrength === strength ? 'active' : ''}`}
                        disabled={disabled}
                        onClick={() => onRegionsChange(list =>
                          list.map(item => item.id === region.id ? { ...item, constraintStrength: strength } : item))}
                      >{PERSON_STRENGTH_LABELS[strength]}</button>
                    ))}
                  </div>
                </div>
                <div className="vision-region-form-row">
                  <label>附加要求</label>
                  <input
                    type="text"
                    value={region.prompt ?? ''}
                    placeholder="可选：对该区域的额外描述"
                    disabled={disabled}
                    onChange={e => onRegionsChange(list =>
                      list.map(item => item.id === region.id ? { ...item, prompt: e.target.value } : item))}
                  />
                </div>
                <div className="vision-region-card-actions">
                  <button
                    type="button"
                    className="vision-btn vision-btn-sm"
                    disabled={disabled}
                    onClick={() => onRegionsChange(list =>
                      list.map(item => item.id === region.id ? { ...item, enabled: !item.enabled } : item))}
                  >{region.enabled ? '停用' : '启用'}</button>
                  <button
                    type="button"
                    className="vision-btn vision-btn-sm"
                    disabled={disabled}
                    onClick={() => onPersistRegionMask(region.id)}
                  >{region.maskPath ? '重建 mask' : '生成 mask'}</button>
                  <button
                    type="button"
                    className="vision-btn vision-btn-sm vision-btn-danger"
                    disabled={disabled}
                    onClick={() => onRegionsChange(list => list.filter(item => item.id !== region.id))}
                  >删除区域</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
