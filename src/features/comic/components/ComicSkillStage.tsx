/**
 * 画面与形式阶段（Phase 1.2 Step 2，原「技能打磨」重构，规格 §7~§12）——
 * 用户确认故事后决定「这一期长什么样」：
 *  - 漫画形式：七个展示形式模板可视化选择卡（ComicFormPreviewMini 纯 CSS 缩略图，
 *    几何同源 resolveComicPresentation；禁止 Image2 生成预览 §8.1）；
 *  - 对白呈现：四种对白方式（§12.2，不只艺术名词，各配一句适配说明）；
 *  - 视觉风格：预设卡（§12.1 缩略示意 + 一句说明；label 给用户 / promptText 入 Prompt）；
 *  - 高级（折叠）：漫画规则只读卡 + 对话式微调（Phase 10 白名单补丁链路保留）
 *    + [保存为漫画技能]（§7：Skill 是可保存复用的资产，不是前置门槛）。
 * Presentation 确认 = Skill 确认（stage≠skill_draft，D-101 不引入第二套确认状态）；
 * §73 形式变化影响格数 → domain 标 stale + 本地 toast 提示「现有分镜需要重新规划」。
 * 草稿不丢（§30/§85）：微调指令防抖写穿 project.uiDraft.skill，切步骤 / 刷新后挂载恢复。
 */

import { useState } from 'react';
import { toastError, toastSuccess, toastWarning } from '../../../components/Toast';
import { patchComicSkill } from '../../../services/comicPlanner';
import {
  applyComicSkillPatches,
  applyDialogueModeToProject,
  applyPresentationToProject,
  applyVisualStyleToProject,
  guardComicPatchesAgainstPresentationLock,
} from '../domain';
import { normalizeComicLayout } from '../normalize';
import {
  COMIC_DIALOGUE_MODE_HINTS,
  COMIC_DIALOGUE_MODE_LABELS,
  COMIC_PRESENTATION_TEMPLATES,
  COMIC_VISUAL_STYLE_PRESETS,
  comicPresentationLabel,
  comicPresentationTemplateOf,
  presentationPatchFor,
  resolveComicPresentation,
  type ComicPresentationTemplate,
} from '../presentation';
import { useDebouncedDraftText } from '../useComicUiDraft';
import type { ComicProject, ComicUiDraft } from '../types';
import ComicFormPreviewMini from './ComicFormPreviewMini';

export interface ComicSkillStageProps {
  project: ComicProject;
  onPatch: (apply: (draft: ComicProject) => ComicProject) => void;
  onConfirm: () => void;
  confirmed: boolean;
  /** 保存当前方案快照为可复用漫画技能（§7 资产能力）。 */
  onSaveAsSkill: () => void;
  /** 步骤草稿写穿（页面层 → updateActive 只写 uiDraft，不参与阶段派生）。 */
  onDraft: (mutate: (uiDraft: ComicUiDraft) => ComicUiDraft) => void;
}

/** §12.1 风格卡缩略示意：一支笔触语言一个风格（currentColor 继承令牌色，不引第二套色）。 */
function styleSketch(presetId: string): JSX.Element | null {
  switch (presetId) {
    case 'cute-sketch':
      return (
        <svg viewBox="0 0 40 28" aria-hidden>
          <circle cx="20" cy="14" r="9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <circle cx="17" cy="12" r="1.4" fill="currentColor" />
          <circle cx="23" cy="12" r="1.4" fill="currentColor" />
          <path d="M16.5 17.5 Q20 20 23.5 17.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      );
    case 'hand-drawn':
      return (
        <svg viewBox="0 0 40 28" aria-hidden>
          <path d="M12 6 Q19 4 27 7 Q34 10 28 16 Q21 22 13 18 Q7 14 12 6 Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M17 11 Q18 10.5 19 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M23 11 Q24 10.5 25 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M17 15 Q20 17 23.5 14.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case 'japanese-fresh':
      return (
        <svg viewBox="0 0 40 28" aria-hidden>
          <circle cx="20" cy="14" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M20 5.5 L20 22.5 M11.5 14 L28.5 14" stroke="currentColor" strokeWidth="0.9" />
          <circle cx="20" cy="14" r="3" fill="currentColor" opacity="0.16" />
        </svg>
      );
    case 'muted-illustration':
      return (
        <svg viewBox="0 0 40 28" aria-hidden>
          <rect x="7" y="8" width="10" height="12" rx="3" fill="currentColor" opacity="0.5" />
          <rect x="19" y="5" width="8" height="15" rx="4" fill="currentColor" opacity="0.32" />
          <rect x="29" y="10" width="6" height="10" rx="2" fill="currentColor" opacity="0.18" />
        </svg>
      );
    case 'retro-print':
      return (
        <svg viewBox="0 0 40 28" aria-hidden>
          {Array.from({ length: 4 }).map((_, row) => (
            Array.from({ length: 6 }).map((__, col) => (
              <circle key={`${row}-${col}`} cx={7 + col * 5.4} cy={6 + row * 5.4} r={row < 2 ? 1.6 : 1.1} fill="currentColor" opacity={row < 2 ? 0.55 : 0.3} />
            ))
          ))}
        </svg>
      );
    default:
      return null;
  }
}

export default function ComicSkillStage(props: ComicSkillStageProps) {
  const { project } = props;
  const skill = project.skillSnapshot;
  const presentation = resolveComicPresentation(skill);
  const [instruction, setInstruction] = useDebouncedDraftText(
    () => project.uiDraft?.skill?.instruction ?? '',
    value => props.onDraft(draft => {
      if (!value) {
        const rest = { ...draft };
        delete rest.skill;
        return rest;
      }
      return { ...draft, skill: { instruction: value } };
    }),
  );
  const [busy, setBusy] = useState(false);
  const [lastApplied, setLastApplied] = useState<{ applied: string[]; ignored: string[] } | null>(null);

  /** §8 选择卡缩略图：模板默认几何（presentationPatchFor → normalize → resolve，同源）。 */
  const previewOf = (template: ComicPresentationTemplate) => resolveComicPresentation(
    { ...skill, layout: normalizeComicLayout({ ...skill.layout, ...presentationPatchFor(template) }) },
  );

  const selectTemplate = (template: ComicPresentationTemplate) => {
    const outcome = applyPresentationToProject(project, template);
    if (!outcome.changed) return;
    props.onPatch(() => outcome.project);
    toastSuccess(`已选择「${template.name}」`);
    // §73：形式变化影响格数 → 既有活跃分镜需重新规划（domain 已标 stale，不偷偷覆盖）
    if (outcome.panelCountChanged && project.panels.some(panel => !panel.stale)) {
      toastWarning('展示形式已变化，现有分镜需要重新规划（到「分镜草稿」重出一版）');
    }
  };

  const selectDialogueMode = (mode: NonNullable<typeof presentation.dialogueMode>) => {
    const next = applyDialogueModeToProject(project, mode);
    if (next === project) return;
    props.onPatch(() => next);
    toastSuccess(`对白呈现已切换为「${COMIC_DIALOGUE_MODE_LABELS[mode]}」`);
  };

  const selectVisualStyle = (promptText: string) => {
    const next = applyVisualStyleToProject(project, promptText);
    if (next === project) return;
    props.onPatch(() => next);
    toastSuccess('视觉风格已更新');
  };

  const runPatch = async () => {
    if (!instruction.trim()) {
      toastError('请先填写调整要求');
      return;
    }
    setBusy(true);
    try {
      const outcome = await patchComicSkill({ skill, instruction });
      if (!outcome.ok) {
        toastError(outcome.error);
        return;
      }
      // V4.2.8 §49~§57：新建入口用户指定的形式（presentationSource=user_fixed）是
      // 硬约束——对话式微调补丁不得改排版（换形式的唯一入口 = 本步骤的显式选择卡）
      const guard = guardComicPatchesAgainstPresentationLock(outcome.patches, project.presentationSource);
      if (guard.ignored.length > 0) {
        toastWarning('漫画形式是你在新建时指定的，对话式调整不能修改排版；要换形式请用上方的形式选择卡');
      }
      const application = applyComicSkillPatches(skill, guard.patches);
      props.onPatch(draft => ({ ...draft, skillSnapshot: application.skill }));
      setLastApplied(application);
      if (application.applied.length > 0) {
        setInstruction('');
        toastSuccess(`已应用 ${application.applied.length} 处修改`);
      } else if (guard.ignored.length === 0) {
        toastError('本次调整没有命中可修改的字段，请换一种说法');
      }
    } catch (err) {
      toastError(err instanceof Error ? err.message : '技能调整失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="comic-stage">
      <section className="comic-card">
        <div className="comic-card-head">
          <h4 className="comic-card-title">漫画形式</h4>
          <p className="comic-helper">
            当前：{comicPresentationLabel(presentation)}——选一种形式，AI 按它拆分每一格
          </p>
        </div>
        <div className="comic-presentation-grid" data-testid="comic-presentation-grid">
          {COMIC_PRESENTATION_TEMPLATES.map(template => {
            const preview = previewOf(template);
            const selected = presentation.template?.id === template.id;
            return (
              <button
                type="button"
                key={template.id}
                className={`comic-presentation-card${selected ? ' is-selected' : ''}`}
                data-testid={`comic-presentation-${template.id}`}
                aria-pressed={selected}
                onClick={() => selectTemplate(template)}
              >
                {/* V4.2.12 §64-68：全部形式卡统一 Mini Canvas（多页 = 堆叠页 +「+N 页」，
                    不再渲染「第 N 页」绝对定位标签 → 与相邻卡/页框零重叠） */}
                <ComicFormPreviewMini presentation={preview} />
                <strong className="comic-presentation-name">{template.name}</strong>
                <span className="comic-presentation-meta">
                  {preview.outputMode === 'multi_page'
                    ? `${preview.pageCount} 页 · 每页 ${preview.panelsPerPage} 张 · 共 ${preview.totalPanels} 张成品图`
                    : `${preview.pageCount} 页 · 每页 ${preview.panelsPerPage} 格 · 共 ${preview.totalPanels} 格`}
                </span>
                <span className="comic-presentation-desc">{template.description}</span>
                <span className="comic-presentation-dialogue">对白：{template.dialogueHint}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="comic-card">
        <div className="comic-card-head">
          <h4 className="comic-card-title">对白呈现</h4>
          <p className="comic-helper">文字独立于图片（改对白永不重新生成图片），这里只定呈现方式</p>
        </div>
        <div className="comic-dialogue-mode-grid">
          {(Object.keys(COMIC_DIALOGUE_MODE_LABELS) as Array<NonNullable<typeof presentation.dialogueMode>>).map(mode => {
            const selected = presentation.dialogueMode === mode;
            return (
              <button
                type="button"
                key={mode}
                className={`comic-mode-card${selected ? ' is-selected' : ''}`}
                data-testid={`comic-dialogue-mode-${mode}`}
                aria-pressed={selected}
                onClick={() => selectDialogueMode(mode)}
              >
                <strong>{COMIC_DIALOGUE_MODE_LABELS[mode]}</strong>
                <span>{COMIC_DIALOGUE_MODE_HINTS[mode]}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="comic-card">
        <div className="comic-card-head">
          <h4 className="comic-card-title">视觉风格</h4>
          <p className="comic-helper">
            当前画风：{skill.visualStyle}
            {comicPresentationTemplateOf(skill.layout.arrangement) ? '' : '（自定义排版沿用原画风）'}
          </p>
        </div>
        <div className="comic-style-grid">
          {COMIC_VISUAL_STYLE_PRESETS.map(preset => {
            const selected = skill.visualStyle === preset.promptText;
            return (
              <button
                type="button"
                key={preset.id}
                className={`comic-mode-card comic-style-card${selected ? ' is-selected' : ''}`}
                data-testid={`comic-style-${preset.id}`}
                aria-pressed={selected}
                onClick={() => selectVisualStyle(preset.promptText)}
              >
                <span className="comic-style-sketch">{styleSketch(preset.id)}</span>
                <strong>{preset.label}</strong>
                <span>{preset.description}</span>
              </button>
            );
          })}
        </div>
      </section>

      <div className="comic-actions-row comic-stage-confirm">
        <button
          type="button"
          className="app-btn app-btn-primary"
          onClick={props.onConfirm}
          title={props.confirmed ? '画面与形式已确认，可回到角色演员步骤' : '确认画面与形式，进入角色演员'}
        >
          {props.confirmed ? '返回角色确认' : '确认画面与形式，下一步'}
        </button>
      </div>

      <details className="comic-advanced-card">
        <summary>高级 · 漫画规则与微调</summary>
        <section className="comic-card">
          <h4 className="comic-card-title">漫画规则（导演）</h4>
          <dl className="comic-skill-facts">
            <div><dt>名称</dt><dd>{skill.name}</dd></div>
            <div><dt>漫画形式</dt><dd>{comicPresentationLabel(presentation)}</dd></div>
            <div><dt>画风</dt><dd>{skill.visualStyle}</dd></div>
            <div><dt>故事模式</dt><dd>{skill.storyPattern}</dd></div>
            <div><dt>对白风格</dt><dd>{skill.dialogueStyle}</dd></div>
            <div><dt>幽默风格</dt><dd>{skill.humorStyle}</dd></div>
            <div><dt>角色槽位</dt><dd>{skill.characterSlots.map(slot => `${slot.name}${slot.required ? '（必选）' : '（可选）'}${slot.displayRule ? `：${slot.displayRule}` : ''}`).join('；') || '—'}</dd></div>
            <div><dt>跨格一致性</dt><dd>{skill.consistencyRules.join('；') || '—'}</dd></div>
            <div><dt>底图规则</dt><dd>无字底图（文字层由系统独立渲染，改对白不重生成图片）</dd></div>
          </dl>
          <div className="comic-actions-row">
            <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={props.onSaveAsSkill}>
              保存为漫画技能
            </button>
          </div>
        </section>

        <section className="comic-card">
          <h4 className="comic-card-title">对话式微调</h4>
          <div className="form-group">
            <label htmlFor="comic-skill-instruction">调整要求</label>
            <textarea
              id="comic-skill-instruction"
              rows={3}
              placeholder="例：画风再简单一点，主角槽位改成只在最后两格出场"
              value={instruction}
              onChange={e => setInstruction(e.target.value)}
            />
            <p className="comic-helper">AI 只按白名单字段出补丁（画风 / 形式 / 槽位 / 一致性规则等），每次修改可追溯</p>
          </div>
          <div className="comic-actions-row">
            <button type="button" className="app-btn app-btn-secondary" disabled={busy} onClick={() => void runPatch()}>
              {busy ? '生成补丁中…' : '应用调整'}
            </button>
          </div>
          {lastApplied && (lastApplied.applied.length > 0 || lastApplied.ignored.length > 0) && (
            <div className="comic-patch-report">
              {lastApplied.applied.length > 0 && <p>已应用：{lastApplied.applied.join('、')}</p>}
              {lastApplied.ignored.length > 0 && <p className="comic-muted">已忽略（不在白名单）：{lastApplied.ignored.join('、')}</p>}
            </div>
          )}
        </section>
      </details>
    </div>
  );
}
