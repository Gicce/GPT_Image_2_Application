/**
 * ReferenceMapping（V4.1）——人物替换的视觉映射主体：
 *
 *   [画面模板 @原图]  →  [替换人物 @人物参考]
 *
 * 双栏卡片 + 中央替换箭头；窄屏（<720px）纵向堆叠。
 *  - 模板卡：缩略图 + @原图 token + 文件名小字（tooltip 全路径）+ 更换模板；
 *  - 人物卡：空态选择块（＋ 选择人物参考）/ 图片卡（标题「人物参考」、文件名小字、
 *    更换人物）/ 文字描述卡（摘要 + 更换）——「已选 + 大空选择入口」绝不并存。
 * 缩略图点击进全局 ImageViewer；卡内按钮是普通 secondary action。
 */

import { useImageViewerStore } from '../../store/useImageViewerStore';
import { PERSON_REPLACEMENT } from './recreationCopy';
import { personHasImage, type PersonReplacement } from './modificationIntent';
import { useThumb } from './usePersonThumb';
import type { PersonPanelTemplate } from './PersonReplacementPanel';

interface ReferenceMappingProps {
  template?: PersonPanelTemplate | null;
  person: PersonReplacement | null;
  disabled?: boolean;
  onTemplateChange?: () => void;
  /** 空态选择块点击（默认进图片库）。 */
  onPickPerson: () => void;
  /** 已有人物时点「更换人物」进入选择态。 */
  onChangePerson: () => void;
}

function fileNameOf(path: string | undefined): string {
  return path?.split(/[\\/]/).pop() ?? '';
}

export default function ReferenceMapping({
  template,
  person,
  disabled,
  onTemplateChange,
  onPickPerson,
  onChangePerson,
}: ReferenceMappingProps) {
  const templateThumb = useThumb(template?.path);
  const hasImage = personHasImage(person);
  const personThumb = useThumb(hasImage ? person?.path : undefined);

  const openTemplateViewer = () => {
    if (!template?.path) return;
    useImageViewerStore.getState().openViewer([{
      id: `template-${template.path}`,
      path: template.path,
      title: PERSON_REPLACEMENT.templateLabel,
      fileName: fileNameOf(template.path),
      metadata: [{ label: '用途', value: PERSON_REPLACEMENT.templateUseHint }],
    }], 0);
  };

  const openPersonViewer = () => {
    if (!person?.path) return;
    useImageViewerStore.getState().openViewer([{
      id: `person-${person.path}`,
      path: person.path,
      title: PERSON_REPLACEMENT.personCardTitle,
      fileName: fileNameOf(person.path),
      metadata: [{ label: '用途', value: PERSON_REPLACEMENT.personUseHint }],
    }], 0);
  };

  return (
    <div className="vision-person-mapping" role="group" aria-label={PERSON_REPLACEMENT.title}>
      {/* ===== 左：画面模板（原图） ===== */}
      <div className="vision-person-map-col">
        <div className="vision-person-block-head">
          <span className="vision-person-label">{PERSON_REPLACEMENT.templateLabel}</span>
          <span className="vision-person-block-hint">{PERSON_REPLACEMENT.templateUseHint}</span>
        </div>
        {template?.path ? (
          <div className="vision-person-map-card">
            <button
              type="button"
              className="vision-person-map-thumb is-template"
              title="点击在内置图片查看器中查看"
              disabled={disabled}
              onClick={openTemplateViewer}
            >
              {templateThumb
                ? <img src={templateThumb} alt={PERSON_REPLACEMENT.templateToken} />
                : <span className="vision-person-map-placeholder" aria-hidden="true">{PERSON_REPLACEMENT.templateToken}</span>}
            </button>
            <div className="vision-person-map-meta">
              <p className="vision-person-map-token">@{PERSON_REPLACEMENT.templateToken}</p>
              <p className="vision-person-map-name">{template.label || PERSON_REPLACEMENT.templateToken}</p>
              <p className="vision-person-map-file" title={template.path}>{fileNameOf(template.path)}</p>
              {onTemplateChange && (
                <button
                  type="button"
                  className="vision-btn vision-btn-sm"
                  disabled={disabled}
                  title={PERSON_REPLACEMENT.templateChangeNote}
                  onClick={onTemplateChange}
                >
                  {PERSON_REPLACEMENT.templateChangeButton}
                </button>
              )}
            </div>
          </div>
        ) : (
          <p className="vision-hint">{PERSON_REPLACEMENT.templateMissing}</p>
        )}
      </div>

      {/* ===== 中：替换箭头 ===== */}
      <span className="vision-person-map-arrow" role="img" aria-label={PERSON_REPLACEMENT.mappingArrowLabel}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path
            d="M4 12h14M13 6l6 6-6 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>

      {/* ===== 右：替换人物 ===== */}
      <div className="vision-person-map-col">
        <div className="vision-person-block-head">
          <span className="vision-person-label">{PERSON_REPLACEMENT.personBlockLabel}</span>
          <span className="vision-person-block-hint">{PERSON_REPLACEMENT.personUseHint}</span>
        </div>
        {hasImage && person ? (
          <div className="vision-person-map-card is-person">
            <button
              type="button"
              className="vision-person-map-thumb is-person"
              title="点击在内置图片查看器中查看"
              disabled={disabled}
              onClick={openPersonViewer}
            >
              {personThumb
                ? <img src={personThumb} alt={PERSON_REPLACEMENT.personCardTitle} />
                : <span className="vision-person-map-placeholder" aria-hidden="true">人物</span>}
            </button>
            <div className="vision-person-map-meta">
              <p className="vision-person-map-token">@{PERSON_REPLACEMENT.personCardTitle}</p>
              <p className="vision-person-map-name">{PERSON_REPLACEMENT.personCardTitle}</p>
              <p className="vision-person-map-file" title={person.path}>
                {person.source === 'gallery' ? PERSON_REPLACEMENT.personCardSourceGallery : PERSON_REPLACEMENT.personCardSourceLocal}
                {' · '}{person.label || fileNameOf(person.path)}
              </p>
              <button
                type="button"
                className="vision-btn vision-btn-sm"
                disabled={disabled}
                onClick={onChangePerson}
              >
                {PERSON_REPLACEMENT.changeButton}
              </button>
            </div>
          </div>
        ) : person?.source === 'description' ? (
          <div className="vision-person-map-card is-person is-text">
            <div className="vision-person-map-thumb is-text-card">
              <span className="vision-person-map-textmark" aria-hidden="true">文</span>
            </div>
            <div className="vision-person-map-meta">
              <p className="vision-person-map-token">{PERSON_REPLACEMENT.personTextCardTitle}</p>
              <p className="vision-person-map-desc" title={person.description}>{person.description}</p>
              <button
                type="button"
                className="vision-btn vision-btn-sm"
                disabled={disabled}
                onClick={onChangePerson}
              >
                {PERSON_REPLACEMENT.changeButton}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="vision-person-map-card is-empty"
            disabled={disabled}
            onClick={onPickPerson}
          >
            <span className="vision-person-pick-plus" aria-hidden="true">＋</span>
            <span className="vision-person-map-empty-label">{PERSON_REPLACEMENT.personEmptyAction}</span>
            <span className="vision-person-map-empty-hint">{PERSON_REPLACEMENT.personEmptyHint}</span>
          </button>
        )}
      </div>
    </div>
  );
}
