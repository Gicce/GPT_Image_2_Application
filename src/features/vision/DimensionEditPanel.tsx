/** 已启用维度的可折叠配置卡。描述继续写入 freeText；参考图继续走 extraImageRefs。 */
import { useImageViewerStore } from '../../store/useImageViewerStore';
import type { DimensionReferenceImage, ModificationDimension } from './modificationIntent';
import { useThumb } from './usePersonThumb';

type ConfigurableDimension = Exclude<ModificationDimension, 'subject' | 'clothing'>;

const COPY: Record<ConfigurableDimension, {
  title: string;
  description: string;
  placeholder: string;
  referenceLabel: string;
}> = {
  pose: {
    title: '动作更改',
    description: '描述新动作，或加入动作参考图；参考图只提供姿态，不替换人物。',
    placeholder: '例如：双手抱胸站立，微微侧身看向镜头…',
    referenceLabel: '动作参考',
  },
  scene: {
    title: '背景更改',
    description: '描述新背景，也可以加载背景参考图；人物身份不会从背景图继承。',
    placeholder: '例如：更换为夜晚霓虹街道，保留主体位置与光影方向…',
    referenceLabel: '背景参考',
  },
  camera: {
    title: '镜头更改',
    description: '指定景别、机位、视角和景深；需要时可加入镜头构图参考。',
    placeholder: '例如：低机位仰拍，中近景，浅景深…',
    referenceLabel: '镜头参考',
  },
  style: {
    title: '风格更改',
    description: '描述目标风格，或加载风格参考图；只提取画风、材质与色彩语言。',
    placeholder: '例如：日系赛璐璐插画，冷紫色调，细腻线稿…',
    referenceLabel: '风格参考',
  },
};

interface DimensionEditPanelProps {
  dimension: ConfigurableDimension;
  value: string;
  reference?: DimensionReferenceImage;
  collapsed?: boolean;
  disabled?: boolean;
  onToggleCollapsed: () => void;
  onValueChange: (value: string) => void;
  onPickGallery: () => void;
  onPickLocal: () => void;
  onRemoveReference: () => void;
}

export default function DimensionEditPanel({
  dimension,
  value,
  reference,
  collapsed,
  disabled,
  onToggleCollapsed,
  onValueChange,
  onPickGallery,
  onPickLocal,
  onRemoveReference,
}: DimensionEditPanelProps) {
  const copy = COPY[dimension];
  const thumb = useThumb(reference?.path);
  const openViewer = () => {
    if (!reference?.path) return;
    useImageViewerStore.getState().openViewer([{
      id: `${dimension}-${reference.path}`,
      path: reference.path,
      title: copy.referenceLabel,
      fileName: reference.label,
      metadata: [{ label: '用途', value: copy.description }],
    }], 0);
  };

  return (
    <section className={`vision-dimension-edit-panel is-${dimension}`} aria-label={copy.title}>
      <header className="vision-subpanel-head">
        <div>
          <span className="vision-subpanel-title">{copy.title}</span>
          <p>{copy.description}</p>
        </div>
        <div className="vision-subpanel-actions">
          <span className="vision-person-business-badge">已启用</span>
          <button
            type="button"
            className="app-btn app-btn-secondary app-btn-sm"
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
          >{collapsed ? '展开' : '收起'}</button>
        </div>
      </header>
      {!collapsed && (
        <div className="vision-dimension-edit-body">
          <div className="form-group vision-dimension-requirement">
            <label htmlFor={`vision-dimension-${dimension}`}>{copy.title.replace('更改', '要求')}</label>
            <textarea
              id={`vision-dimension-${dimension}`}
              rows={2}
              value={value}
              disabled={disabled}
              placeholder={copy.placeholder}
              onChange={event => onValueChange(event.target.value)}
            />
          </div>
          <div className="vision-dimension-reference">
            <div className="vision-dimension-reference-head">
              <span className="vision-person-label">{copy.referenceLabel}（可选）</span>
              <div className="vision-dimension-reference-actions">
                <button type="button" className="app-btn app-btn-secondary app-btn-sm" disabled={disabled} onClick={onPickGallery}>图片库选择</button>
                <button type="button" className="app-btn app-btn-secondary app-btn-sm" disabled={disabled} onClick={onPickLocal}>本地导入</button>
              </div>
            </div>
            {reference ? (
              <div className="vision-dimension-reference-card">
                <button type="button" className="vision-dimension-reference-thumb" disabled={disabled} title="点击在内置图片查看器中查看" onClick={openViewer}>
                  {thumb ? <img src={thumb} alt={copy.referenceLabel} /> : <span>图片加载中…</span>}
                </button>
                <div>
                  <strong>{reference.label || copy.referenceLabel}</strong>
                  <p>仅用于{copy.referenceLabel.replace('参考', '')}，不会覆盖其它维度。</p>
                </div>
                <button type="button" className="app-btn app-btn-secondary app-btn-sm" disabled={disabled} onClick={onRemoveReference}>移除</button>
              </div>
            ) : (
              <p className="vision-hint">未加载参考图；只填写文字要求也可以继续。</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
