/**
 * 本期故事阶段（Phase 1.2 Step 1 + V4.2.9 审定重设计，docs/ai-comic/17 §五/§六）——
 * 用户创建漫画后的第一屏：
 *  - 无故事：一句话需求 → planComicStory（居中 AIPlanningSurface，阶段清单 + 真实
 *    模型名 + 已用时，无百分比）→ 故事审定（Story Hero 层级：标题 → 形式/格数/主题
 *    chips → 概要（可读宽度）→ 节拍可视化（列数与展示形式几何同源：四宫格 2×2、
 *    九宫格 3×3）→ 结尾 Punchline callout → 涉及角色 → [确认这个故事] 唯一 Primary）；
 *  - 已确认：Story Hero Card 同一层级呈现，[调整这个故事（大白话）] 回需求输入；
 *  - Replan 红线（§55）：规划中旧 Story 不清空——已有故事时上方保留淡化 Hero，
 *    失败后仍可返回使用；规划输入不回退。
 * 确认走 applyStoryOnlyToProject（只写 story；旧分镜 stale 化，分镜草稿在 Step 4 重出）。
 * 草稿不丢（§30/§85）：requirement / 审定草稿 / phase 写穿 project.uiDraft.story，
 * 切步骤 / 刷新后挂载恢复（本地 state 仍是输入主载体，打字不重渲染全工作台）。
 */

import { useState } from 'react';
import { toastSuccess } from '../../../components/Toast';
import { planComicStory } from '../../../services/comicPlanner';
import { getStoryOverview } from '../comicStudioFlow';
import { resolveComicPresentation } from '../presentation';
import { useDebouncedDraftText } from '../useComicUiDraft';
import { comicStoryFingerprint } from '../domain';
import { resolveModelForRole } from '../../aiRouting/resolveModelForRole';
import type { ComicProject, ComicStory, ComicUiDraft } from '../types';
import AIPlanningSurface from './AIPlanningSurface';
import { isComicPlannerRunning, type ComicPlannerProgressStatus } from '../comicPlannerProgress';

export interface ComicStoryStageProps {
  project: ComicProject;
  /** 确认故事（页面层 → applyStoryOnlyToProject，Step 1 的语义写入）。 */
  onConfirmStory: (story: ComicStory) => void;
  /** 步骤草稿写穿（页面层 → updateActive 只写 uiDraft，不参与阶段派生）。 */
  onDraft: (mutate: (uiDraft: ComicUiDraft) => ComicUiDraft) => void;
}

type Phase = 'hero' | 'requirement' | 'review';

interface PlannerRunState {
  status: ComicPlannerProgressStatus;
  startedAt: number | null;
  errorText: string | null;
  modelLabel: string | null;
}

export default function ComicStoryStage(props: ComicStoryStageProps) {
  const { project } = props;
  const skill = project.skillSnapshot;
  const overview = getStoryOverview(project);

  /**
   * uiDraft.story 合并写（storyDraft / phase 即时；requirement 走防抖写穿）。
   * 协议：字段 undefined = 不动；null / 空串 = 清除该键；全空则整个 story 键剥离。
   */
  const patchStoryDraft = (patch: {
    requirement?: string | null;
    storyDraft?: ComicStory | null;
    phase?: Phase | null;
  }) => {
    props.onDraft(draft => {
      const current = draft.story ?? {};
      const next = {
        requirement: patch.requirement === undefined ? current.requirement : (patch.requirement || undefined),
        storyDraft: patch.storyDraft === undefined ? current.storyDraft : (patch.storyDraft ?? undefined),
        phase: patch.phase === undefined ? current.phase : (patch.phase ?? undefined),
      };
      if (!next.requirement && !next.storyDraft && !next.phase) {
        const rest = { ...draft };
        delete rest.story;
        return rest;
      }
      return { ...draft, story: next };
    });
  };

  const [requirement, setRequirement] = useDebouncedDraftText(
    () => project.uiDraft?.story?.requirement ?? '',
    value => patchStoryDraft({ requirement: value }),
  );
  const [phase, setPhase] = useState<Phase>(
    () => project.uiDraft?.story?.phase ?? (project.story ? 'hero' : 'requirement'),
  );
  const [story, setStory] = useState<ComicStory | null>(() => {
    const saved = project.uiDraft?.story?.storyDraft;
    // Story Lock（V4.2.13 R1，与 ComicStoryboardStage 同防线）：残留的故事草稿
    // 必须属于当前已确认故事；指纹不符（故事已在别处重新确认）→ 丢弃，不复活旧故事。
    if (saved && (!project.story || comicStoryFingerprint(project.story) === comicStoryFingerprint(saved))) {
      return saved;
    }
    return null;
  });
  const [run, setRun] = useState<PlannerRunState | null>(null);

  const goPhase = (next: Phase) => {
    setPhase(next);
    if (next === 'hero') {
      // 确认后的回落：审定草稿已消费，phase 回缺省
      patchStoryDraft({ phase: null, storyDraft: null });
    } else {
      patchStoryDraft({ phase: next });
    }
  };

  const busy = run !== null && isComicPlannerRunning(run.status);

  const characters = project.characterSnapshots.filter(character =>
    Object.values(project.characterBindings).includes(character.id));

  // §2.2：模型预显（resolveModelForRole 只读，不暴露 Key / Base URL / Token）
  const plannerPreview = (() => {
    const resolution = resolveModelForRole('comic_planner');
    return resolution.ok ? resolution.resolved.displayName : null;
  })();

  const patchRun = (patch: Partial<PlannerRunState>) => {
    setRun(prev => (prev ? { ...prev, ...patch } : prev));
  };

  const runPlanStory = async () => {
    if (!requirement.trim()) {
      setRun({ status: 'failed', startedAt: null, errorText: '请先填写本期主题或需求', modelLabel: null });
      return;
    }
    const resolution = resolveModelForRole('comic_planner');
    if (!resolution.ok) {
      setRun({ status: 'failed', startedAt: null, errorText: resolution.error, modelLabel: null });
      return;
    }
    setRun({ status: 'resolving', startedAt: Date.now(), errorText: null, modelLabel: resolution.resolved.displayName });
    try {
      const outcome = await planComicStory({
        skill,
        characters,
        requirement,
        onStage: stage => patchRun({ status: stage }),
      });
      if (!outcome.ok) {
        patchRun({ status: 'failed', errorText: outcome.error });
        return;
      }
      setStory(outcome.story);
      setPhase('review');
      patchStoryDraft({ storyDraft: outcome.story, phase: 'review' });
      setRun(null);
    } catch (err) {
      patchRun({
        status: 'failed',
        errorText: err instanceof Error ? err.message : '故事规划失败，请重试',
      });
    }
  };

  const confirmStory = () => {
    if (!story) return;
    props.onConfirmStory(story);
    toastSuccess('本期故事已确认，接下来定画面与形式');
    setStory(null);
    goPhase('hero');
  };

  /**
   * 节拍网格列数（V4.2.9）：与展示形式几何同源——resolveComicPresentation 单点派生，
   * 四宫格 2×2、九宫格 3×3、竖排 / 多页 / 通栏 1 列；禁止审定视图自定一套网格。
   */
  const beatsColumns = (value: ComicStory): number => {
    const presentation = resolveComicPresentation(skill, { totalPanels: value.panelCount });
    return Math.min(3, Math.max(1, presentation.pages[0]?.columns ?? 1));
  };

  /**
   * 审定卡 / Hero 卡共用的故事主体（V4.2.9 信息层级）：概要（可读宽度）→
   * 节拍可视化网格 → 结尾 Punchline callout（结尾类型徽标 + 最后一拍）。
   * hero 卡已用 one-liner 呈现概要时传 skipSummary 避免重复。
   */
  const storyBody = (value: ComicStory, options?: { skipSummary?: boolean }) => {
    const view = getStoryOverview({ ...project, story: value });
    const lastBeat = value.beats.length > 0 ? value.beats[value.beats.length - 1] : null;
    return (
      <>
        {!options?.skipSummary && value.summary && (
          <p className="comic-story-review-summary" data-testid="comic-story-review-summary">{value.summary}</p>
        )}
        <div className="comic-story-beats-section">
          <h5 className="comic-story-section-title">节拍预演 · {value.beats.length} 拍</h5>
          <ol
            className="comic-story-beats"
            data-testid="comic-story-beats"
            style={{ gridTemplateColumns: `repeat(${beatsColumns(value)}, minmax(0, 1fr))` }}
          >
            {value.beats.map((beat, index) => (
              <li className="comic-story-beat" key={index}>
                <span className="comic-story-beat-index">{index + 1}</span>
                <p>{beat}</p>
              </li>
            ))}
          </ol>
        </div>
        {lastBeat && (
          <aside className="comic-story-punchline" data-testid="comic-story-punchline">
            <span className="comic-story-punchline-label">结尾 · {view.endingTypeLabel ?? value.endingType}</span>
            <p>{lastBeat}</p>
          </aside>
        )}
      </>
    );
  };

  /** 已确认故事的 Hero 卡；faded = Replan 期间保留的当前故事（只读，红线 §55）。 */
  const storyHeroCard = (value: ComicStory, faded = false) => {
    const view = getStoryOverview({ ...project, story: value });
    return (
      <section
        className={`comic-card comic-story-hero-card${faded ? ' is-faded' : ''}`}
        data-testid={faded ? 'comic-story-hero-faded' : 'comic-story-hero'}
        aria-disabled={faded || undefined}
      >
        <p className="comic-story-hero-kicker">
          {faded ? '当前故事 · 正在重新规划，失败后仍可返回使用' : view.comicName}
        </p>
        <h3 className="comic-story-hero-title">{view.storyTitle}</h3>
        {view.oneLiner && (
          <p className="comic-story-one-liner" data-testid="comic-story-one-liner">{view.oneLiner}</p>
        )}
        {storyBody(value, { skipSummary: true })}
        <div className="comic-story-hero-meta">
          <span>展示形式：{view.presentationLabel}</span>
          {value.topic && <span>主题：{value.topic}</span>}
          {view.characterNames.length > 0 && <span>涉及角色：{view.characterNames.join('、')}</span>}
        </div>
        {!faded && (
          <div className="comic-actions-row">
            <button type="button" className="app-btn app-btn-secondary" onClick={() => goPhase('requirement')}>
              调整这个故事（大白话）
            </button>
          </div>
        )}
      </section>
    );
  };

  return (
    <div className="comic-stage">
      {phase === 'hero' && project.story && storyHeroCard(project.story)}

      {phase === 'requirement' && (() => {
        // V4.2.9：规划中 = 内容区居中 Planning Surface（推荐弹窗同一反馈语言）；
        // Replan 红线：旧 Story 不清空——已有故事时上方保留淡化 Hero。
        if (run && (isComicPlannerRunning(run.status) || run.status === 'failed')) {
          return (
            <>
              {project.story && storyHeroCard(project.story, true)}
              <div className="comic-planning-stage-wrap" data-testid="comic-story-planning-stage">
                <div className="comic-planning-recap" data-testid="comic-story-planning-recap">
                  <span className="comic-planning-recap-row">
                    <span className="comic-planning-recap-label">本期需求</span>
                    <span className="comic-planning-recap-text">{requirement}</span>
                  </span>
                </div>
                <AIPlanningSurface
                  title="AI 正在规划本期故事"
                  hint="按当前方案的故事模式产出节拍与结尾类型"
                  status={run.status}
                  startedAt={run.startedAt}
                  modelLabel={run.modelLabel}
                  errorText={run.errorText}
                  onRetry={run.status === 'failed' ? () => void runPlanStory() : undefined}
                  retryLabel="重新规划"
                  onDismiss={run.status === 'failed' ? () => setRun(null) : undefined}
                  dismissLabel="返回修改需求"
                />
              </div>
            </>
          );
        }
        return (
          <section className="comic-card">
            <h4 className="comic-card-title">{project.story ? '调整本期故事' : '本期故事'}</h4>
            <div className="form-group">
              <label htmlFor="comic-story-requirement">这期讲什么（大白话）</label>
              <textarea
                id="comic-story-requirement"
                rows={4}
                placeholder={`例：写一期「${skill.name}」的例会延期梗，结尾要反转；也可以写“不要励志，改成搞笑一点”`}
                value={requirement}
                onChange={e => setRequirement(e.target.value)}
                disabled={busy}
              />
              <p className="comic-helper">
                AI 会按当前方案的故事模式产出节拍与结尾类型
                {plannerPreview ? ` · 规划模型：${plannerPreview}` : ''}
              </p>
            </div>
            <div className="comic-actions-row">
              <button type="button" className="app-btn app-btn-primary" disabled={busy} data-testid="comic-story-plan" onClick={() => void runPlanStory()}>
                {project.story ? '重新规划本期故事' : '规划本期故事'}
              </button>
              {project.story && !busy && (
                <button type="button" className="app-btn app-btn-secondary" onClick={() => goPhase('hero')}>
                  返回当前故事
                </button>
              )}
            </div>
          </section>
        );
      })()}

      {phase === 'review' && story && (() => {
        // V4.2.9 故事审定（docs/ai-comic/17 §六）：Story Hero 层级，
        // 确认 = 唯一 Primary；不再是 dl 字段详情页。
        const view = getStoryOverview({ ...project, story });
        return (
          <section className="comic-card comic-story-review" data-testid="comic-story-review">
            <p className="comic-story-review-kicker">故事审定 · 请确认本期故事</p>
            <h3 className="comic-story-review-title" data-testid="comic-story-review-title">{story.title}</h3>
            <div className="comic-story-review-chips" data-testid="comic-story-review-chips">
              <span className="comic-story-chip">{view.presentationLabel}</span>
              <span className="comic-story-chip">
                {view.totalPanels} 格{view.pageCount > 1 ? ` · ${view.pageCount} 页` : ''}
              </span>
              {story.topic && <span className="comic-story-chip">{story.topic}</span>}
            </div>
            {storyBody(story)}
            {view.characterNames.length > 0 && (
              <div className="comic-story-context" data-testid="comic-story-characters">
                <span className="comic-story-context-label">涉及角色</span>
                <div className="comic-story-context-chips">
                  {view.characterNames.map(name => (
                    <span className="comic-story-chip" key={name}>{name}</span>
                  ))}
                </div>
              </div>
            )}
            <div className="comic-actions-row comic-story-review-actions">
              <button type="button" className="app-btn app-btn-secondary" disabled={busy} onClick={() => goPhase('requirement')}>
                重新描述
              </button>
              <button type="button" className="app-btn app-btn-primary" disabled={busy} data-testid="comic-story-confirm" onClick={confirmStory}>
                确认这个故事
              </button>
            </div>
            {run && (
              <div className="comic-planning-stage-wrap" data-testid="comic-story-planning-stage">
                <AIPlanningSurface
                  title="AI 正在规划本期故事"
                  status={run.status}
                  startedAt={run.startedAt}
                  modelLabel={run.modelLabel}
                  errorText={run.errorText}
                  onRetry={run.status === 'failed' ? () => void runPlanStory() : undefined}
                  retryLabel="重新规划"
                />
              </div>
            )}
          </section>
        );
      })()}
    </div>
  );
}
