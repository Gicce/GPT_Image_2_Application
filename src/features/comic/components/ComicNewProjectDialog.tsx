/**
 * 新建漫画项目弹窗（Phase 1.1 §十六 + V4.2.7 Story-first + V4.2.8 推荐入口重构）——双入口：
 *  - AI 起草：大白话需求 + 漫画形式小卡选择器（§4~§11：[AI 自动] + 7 个真实模板，
 *    fixed = 硬约束三方案同形式，auto = AI 自由）→ 阶段 Progress（真实模型名）→
 *    3 个方案 Mini Card + 单方案大 Preview（§25~§47：故事标题 → 一句话 →
 *    ComicStoryPreview「格子即 Beat」视觉预演 → 包袱 → 角色 → 形式元信息 →
 *    [使用这个故事] → 完整故事（默认折叠）→ 创作详情（折叠））→ 技能起草进度 →
 *    预览创建；失败原位显示 + 重试，需求与形式选择全部保留（§18~§22 状态规则）；
 *  - 从技能库：已保存的漫画 Skill 直接开新期（快照冻结，改库不回写）。
 * 弹窗三段式几何固定（Header / Body 内滚 / Footer），步骤差异只在 Body 内消化；
 * 方案切换时 Body 回滚顶部（§29）。推荐可视化 = 纯 CSS（ComicFormPreviewMini /
 * ComicStoryPreview），零 Image2 / 零计费（§37）。
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './ComicDialog.css';
import { toastError } from '../../../components/Toast';
import {
  draftComicSkill,
  recommendComicConcepts,
} from '../../../services/comicPlanner';
import { isQuoteCancelled } from '../../../services/billingService';
import { resolveModelForRole } from '../../aiRouting/resolveModelForRole';
import { normalizeComicSkill, validateComicSkill } from '../normalize';
import {
  COMIC_PRESENTATION_CONSTRAINT_TEMPLATES,
  comicPresentationConstraintHint,
  comicPresentationConstraintLabel,
  comicPresentationLabel,
  comicPresentationTemplateShortLabel,
  resolveConceptPresentation,
  type ComicPresentation,
} from '../presentation';
import { buildStoryDraftFromConcept } from '../domain';
import type {
  ComicConcept,
  ComicPresentationConstraint,
  ComicPresentationSource,
  ComicSkill,
  ComicStory,
} from '../types';
import type { ComicSkillSummary } from '../../../store/useComicStore';
import AIPlanningSurface from './AIPlanningSurface';
import ComicFormPreviewMini from './ComicFormPreviewMini';
import ComicStoryPreview from './ComicStoryPreview';
import { isComicPlannerRunning, type ComicPlannerProgressStatus } from '../comicPlannerProgress';

export interface ComicNewProjectDialogProps {
  open: boolean;
  skills: ComicSkillSummary[];
  onClose: () => void;
  onCreate: (input: {
    name: string;
    skill: ComicSkill;
    skillId?: string;
    /** V4.2.7 §十五：选中方案的故事草稿（种子进 uiDraft.story，进入 Step 1 审定）。 */
    storyDraft?: ComicStory;
    requirement?: string;
    /** V4.2.8 §49~§57：形式的来源（用户指定 = user_fixed，后续规划不可改排版）。 */
    presentationSource: ComicPresentationSource;
  }) => Promise<void>;
  /** 从技能库开新期：父层负责 load 技能文档并走同一 createProject 链路。 */
  onCreateFromLibrary: (input: { name: string; skillId: string }) => Promise<void>;
}

type DraftPhase = 'requirement' | 'concepts' | 'preview';

interface PlannerRunState {
  kind: 'recommend' | 'skill';
  status: ComicPlannerProgressStatus;
  startedAt: number | null;
  errorText: string | null;
  modelLabel: string | null;
}

const RUN_IDLE: PlannerRunState | null = null;

/** 方案 Mini Card 的形式几何小图（§25：图标 + 方案N + 标题 + 形式行 + 基调行）。 */
function ConceptFormGlyph(props: { presentation: ComicPresentation }) {
  const { presentation } = props;
  if (presentation.outputMode === 'multi_page') {
    return (
      <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
        <rect x="0.5" y="3" width="8" height="11" rx="1.2" fill="currentColor" opacity="0.4" />
        <rect x="5.5" y="1" width="8" height="11" rx="1.2" fill="currentColor" opacity="0.85" />
      </svg>
    );
  }
  const page = presentation.pages[0];
  const columns = Math.max(1, page?.columns ?? 1);
  const rows = Math.max(1, Math.ceil((page?.panelOrders.length ?? 1) / columns));
  return (
    <svg
      width={3 + columns * 5}
      height={3 + rows * 5}
      viewBox={`0 0 ${3 + columns * 5} ${3 + rows * 5}`}
      aria-hidden="true"
    >
      {Array.from({ length: rows }).map((_, row) =>
        Array.from({ length: columns }).map((__, column) => (
          <rect
            key={`${row}-${column}`}
            x={1.5 + column * 5}
            y={1.5 + row * 5}
            width="3.6"
            height="3.6"
            rx="0.8"
            fill="currentColor"
          />
        )),
      )}
    </svg>
  );
}

export default function ComicNewProjectDialog(props: ComicNewProjectDialogProps) {
  const [mode, setMode] = useState<'draft' | 'library'>('draft');
  const [requirement, setRequirement] = useState('');
  // §12~§17：形式约束独立于需求文本——编辑需求 / 失败重试 / 换个需求都不重置它，
  // 只在弹窗重新打开时回到默认（AI 自动）。
  const [constraint, setConstraint] = useState<ComicPresentationConstraint>({ mode: 'auto' });
  const [phase, setPhase] = useState<DraftPhase>('requirement');
  const [concepts, setConcepts] = useState<ComicConcept[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [fullStoryOpen, setFullStoryOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedConcept, setSelectedConcept] = useState<ComicConcept | null>(null);
  const [draftSkill, setDraftSkill] = useState<ComicSkill | null>(null);
  const [projectName, setProjectName] = useState('');
  const [run, setRun] = useState<PlannerRunState | null>(RUN_IDLE);
  const [creating, setCreating] = useState(false);
  // 双击竞态防护（V4.2.7 §八）：busy disabled 依赖下一次渲染，慢机上两次快速点击
  // 都能进入 handler → 同一需求发出两组独立请求（[AITransport] 日志翻倍的可疑来源）。
  // ref 同步置位，窗口期为零；失败后释放，重新推荐可再点。
  const recommendInFlight = useRef(false);
  const draftSkillInFlight = useRef(false);
  // §29：切换方案 / 阶段时主区回滚顶部（新故事从标题读起，不从滚动位置接续）
  const bodyRef = useRef<HTMLDivElement>(null);

  const busy = run !== null && isComicPlannerRunning(run.status);
  const activeConcept = concepts[activeIndex] ?? null;

  useEffect(() => {
    if (!props.open) return;
    setMode('draft');
    setPhase('requirement');
    setRequirement('');
    setConstraint({ mode: 'auto' });
    setConcepts([]);
    setActiveIndex(0);
    setFullStoryOpen(false);
    setAdvancedOpen(false);
    setSelectedConcept(null);
    setDraftSkill(null);
    setProjectName('');
    setRun(RUN_IDLE);
    setCreating(false);
  }, [props.open]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [activeIndex, phase]);

  if (!props.open) return null;

  // §2.2：模型预显（resolveModelForRole 只读，不暴露 Key / Base URL / Token）
  const plannerPreview = (() => {
    const resolution = resolveModelForRole('comic_planner');
    return resolution.ok ? resolution.resolved.displayName : null;
  })();

  const close = () => {
    if (busy || creating) return;
    props.onClose();
  };

  const patchRun = (kind: PlannerRunState['kind'], patch: Partial<PlannerRunState>) => {
    setRun(prev => (prev && prev.kind === kind ? { ...prev, ...patch } : prev));
  };

  const runRecommend = async () => {
    if (recommendInFlight.current) return;
    if (!requirement.trim()) {
      toastError('请先填写漫画创作需求');
      return;
    }
    const resolution = resolveModelForRole('comic_planner');
    if (!resolution.ok) {
      setRun({ kind: 'recommend', status: 'failed', startedAt: null, errorText: resolution.error, modelLabel: null });
      return;
    }
    recommendInFlight.current = true;
    setRun({
      kind: 'recommend',
      status: 'resolving',
      startedAt: Date.now(),
      errorText: null,
      modelLabel: resolution.resolved.displayName,
    });
    try {
      const outcome = await recommendComicConcepts({
        requirement,
        count: 3,
        presentationConstraint: constraint,
        onStage: stage => patchRun('recommend', { status: stage }),
      });
      if (!outcome.ok) {
        patchRun('recommend', { status: 'failed', errorText: outcome.error });
        return;
      }
      setConcepts(outcome.concepts);
      setActiveIndex(0);
      setFullStoryOpen(false);
      setAdvancedOpen(false);
      setSelectedConcept(outcome.concepts[0] ?? null);
      setPhase('concepts');
      setRun(RUN_IDLE); // 成功 → 概念卡接管视图
    } catch (err) {
      patchRun('recommend', {
        status: 'failed',
        errorText: err instanceof Error ? err.message : '方案推荐失败，请重试',
      });
    } finally {
      recommendInFlight.current = false;
    }
  };

  const runDraftSkill = async (concept: ComicConcept) => {
    if (draftSkillInFlight.current) return;
    setSelectedConcept(concept);
    const resolution = resolveModelForRole('comic_planner');
    if (!resolution.ok) {
      setRun({ kind: 'skill', status: 'failed', startedAt: null, errorText: resolution.error, modelLabel: null });
      return;
    }
    draftSkillInFlight.current = true;
    setRun({
      kind: 'skill',
      status: 'resolving',
      startedAt: Date.now(),
      errorText: null,
      modelLabel: resolution.resolved.displayName,
    });
    try {
      const outcome = await draftComicSkill({
        requirement,
        concept,
        onStage: stage => patchRun('skill', { status: stage }),
      });
      if (!outcome.ok) {
        patchRun('skill', { status: 'failed', errorText: outcome.error });
        return;
      }
      const skill = normalizeComicSkill(outcome.skill);
      const errors = validateComicSkill(skill);
      if (errors.length > 0) {
        patchRun('skill', { status: 'failed', errorText: `起草的漫画技能不完整：${errors.join('；')}` });
        return;
      }
      setDraftSkill(skill);
      setProjectName(`${skill.name} · 第一期`);
      setPhase('preview');
      setRun(RUN_IDLE);
    } catch (err) {
      patchRun('skill', {
        status: 'failed',
        errorText: err instanceof Error ? err.message : '技能起草失败，请重试',
      });
    } finally {
      draftSkillInFlight.current = false;
    }
  };

  const createFromDraft = async () => {
    if (!draftSkill) return;
    setCreating(true);
    try {
      await props.onCreate({
        name: projectName,
        skill: draftSkill,
        storyDraft: selectedConcept ? buildStoryDraftFromConcept(selectedConcept) : undefined,
        requirement,
        presentationSource: constraint.mode === 'fixed' ? 'user_fixed' : 'ai_recommended',
      });
    } catch (err) {
      if (!isQuoteCancelled(err)) toastError(err instanceof Error ? err.message : '项目创建失败');
    } finally {
      setCreating(false);
    }
  };

  const createFromLibrary = async (summary: ComicSkillSummary) => {
    setCreating(true);
    try {
      await props.onCreateFromLibrary({ name: `${summary.name} · 新一期`, skillId: summary.id });
    } catch (err) {
      toastError(err instanceof Error ? err.message : '项目创建失败');
    } finally {
      setCreating(false);
    }
  };

  return createPortal(
    <div className="comic-dialog-overlay" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <section
        className="comic-dialog comic-dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-label="新建漫画项目"
        onMouseDown={e => e.stopPropagation()}
      >
        <header className="comic-dialog-header">
          <div>
            <h3>新建漫画项目</h3>
            <p>AI 先讲 3 个完整故事并画出分镜预演，选一个再定规则</p>
          </div>
          <button type="button" className="comic-dialog-close" aria-label="关闭" onClick={close}>×</button>
        </header>
        <div className="comic-dialog-body" ref={bodyRef}>
          {mode === 'draft' ? (
            <>
              {phase === 'requirement' && (() => {
                // V4.2.9 §五~§七：推荐运行 / 失败态 = 主舞台切换为居中 Planning Surface
                // （顶部保留「你的要求 + 形式」摘要，§三十八）；成功原位变 3 个方案（phase='concepts'）。
                if (run?.kind === 'recommend' && (isComicPlannerRunning(run.status) || run.status === 'failed')) {
                  return (
                    <div className="comic-planning-stage-wrap" data-testid="comic-recommend-planning-stage">
                      <div className="comic-planning-recap" data-testid="comic-planning-recap">
                        <span className="comic-planning-recap-row">
                          <span className="comic-planning-recap-label">你的要求</span>
                          <span className="comic-planning-recap-text">{requirement}</span>
                        </span>
                        <span className="comic-planning-recap-row">
                          <span className="comic-planning-recap-label">漫画形式</span>
                          <span className="comic-planning-recap-text">{comicPresentationConstraintLabel(constraint)}</span>
                        </span>
                      </div>
                      <AIPlanningSurface
                        title="AI 正在规划漫画"
                        hint="正在构思 3 个讲得完的完整故事，并为每个故事预演分镜"
                        status={run.status}
                        startedAt={run.startedAt}
                        modelLabel={run.modelLabel}
                        errorText={run.errorText}
                        onRetry={run.status === 'failed' ? () => void runRecommend() : undefined}
                        retryLabel="重新推荐"
                        onDismiss={run.status === 'failed' ? () => setRun(RUN_IDLE) : undefined}
                        dismissLabel="返回修改需求"
                      />
                    </div>
                  );
                }
                return (
                  <>
                  <div className="form-group">
                    <label htmlFor="comic-requirement">漫画创作需求</label>
                    <textarea
                      id="comic-requirement"
                      className="comic-requirement-input"
                      rows={5}
                      placeholder="例：我需要一个小鸭子的冷笑话，发朋友圈用"
                      value={requirement}
                      onChange={e => setRequirement(e.target.value)}
                      disabled={busy}
                    />
                    <p className="comic-helper">
                      描述用途 / 主角 / 平台 / 情绪，AI 会推荐 3 个讲得完的完整故事和对应分镜
                      {plannerPreview ? ` · 规划模型：${plannerPreview}` : ''}
                    </p>
                  </div>
                  {/* §4~§7 漫画形式小卡选择器：[AI 自动] + 全部真实模板（可视化缩略，非 Select/Chip） */}
                  <div className="form-group">
                    <h4 className="comic-card-title">漫画形式</h4>
                    <div
                      className="comic-form-selector"
                      role="radiogroup"
                      aria-label="漫画形式"
                      data-testid="comic-form-selector"
                    >
                      <button
                        type="button"
                        className={`comic-form-selector-card${constraint.mode === 'auto' ? ' is-selected' : ''}`}
                        role="radio"
                        aria-checked={constraint.mode === 'auto'}
                        data-template-id="auto"
                        disabled={busy}
                        onClick={() => setConstraint({ mode: 'auto' })}
                      >
                        <span className="comic-form-selector-icon" aria-hidden="true">
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                            <path
                              d="M11 3l1.8 4.9L17.7 9.7l-4.9 1.8L11 16.4l-1.8-4.9L4.3 9.7l4.9-1.8L11 3z"
                              fill="currentColor"
                            />
                            <path
                              d="M18.5 13.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3z"
                              fill="currentColor"
                              opacity="0.55"
                            />
                          </svg>
                        </span>
                        <span className="comic-form-selector-name">AI 自动</span>
                        <span className="comic-form-selector-meta">按故事各自选形式</span>
                      </button>
                      {COMIC_PRESENTATION_CONSTRAINT_TEMPLATES.map(template => {
                        const selected = constraint.mode === 'fixed' && constraint.templateId === template.id;
                        return (
                          <button
                            type="button"
                            key={template.id}
                            className={`comic-form-selector-card${template.id === 'multi_page' ? ' is-multi' : ''}${selected ? ' is-selected' : ''}`}
                            role="radio"
                            aria-checked={selected}
                            data-template-id={template.id}
                            disabled={busy}
                            onClick={() => setConstraint({ mode: 'fixed', templateId: template.id })}
                          >
                            <ComicFormPreviewMini
                              presentation={resolveConceptPresentation({
                                layout: { panelCount: template.defaultPanelCount, arrangement: template.id },
                              })}
                            />
                            <span className="comic-form-selector-name">{template.name}</span>
                            <span className="comic-form-selector-meta">{comicPresentationTemplateShortLabel(template)}</span>
                          </button>
                        );
                      })}
                    </div>
                    {/* §9~§11 当前选择即时反馈：fixed = 三方案都保持该形式；auto = AI 分别选 */}
                    <div className="comic-form-current" data-testid="comic-form-current">
                      <span className="comic-form-current-label">当前选择：{comicPresentationConstraintLabel(constraint)}</span>
                      <span className="comic-form-current-hint">{comicPresentationConstraintHint(constraint)}</span>
                    </div>
                  </div>
                  </>
                );
              })()}
              {phase === 'concepts' && (() => {
                // V4.2.9：技能起草同样进入居中 Planning Surface（同一弹窗同一反馈语言，
                // 顶部摘要 = 已选故事；成功原位变 preview 阶段）。
                if (run?.kind === 'skill' && (isComicPlannerRunning(run.status) || run.status === 'failed')) {
                  return (
                    <div className="comic-planning-stage-wrap" data-testid="comic-skill-planning-stage">
                      <div className="comic-planning-recap" data-testid="comic-skill-planning-recap">
                        <span className="comic-planning-recap-row">
                          <span className="comic-planning-recap-label">已选故事</span>
                          <span className="comic-planning-recap-text">{selectedConcept?.storyTitle ?? '—'}</span>
                        </span>
                      </div>
                      <AIPlanningSurface
                        title="AI 正在起草漫画技能"
                        hint="把选定的故事整理为可复用的创作规则（画风 / 形式 / 角色槽位）"
                        status={run.status}
                        startedAt={run.startedAt}
                        modelLabel={run.modelLabel}
                        errorText={run.errorText}
                        onRetry={run.status === 'failed' && selectedConcept ? () => void runDraftSkill(selectedConcept) : undefined}
                        retryLabel="重新起草"
                        onDismiss={run.status === 'failed' ? () => setRun(RUN_IDLE) : undefined}
                        dismissLabel="返回选择故事"
                      />
                    </div>
                  );
                }
                return (
                  <>
                  {/* §25~§27 方案 Mini Card 切换器：几何小图 + 方案N + 故事标题 + 形式行 + 基调行 */}
                  <div className="comic-concept-mini-row" role="tablist" aria-label="推荐方案切换" data-testid="comic-concept-switcher">
                    {concepts.map((concept, index) => {
                      const conceptPresentation = resolveConceptPresentation(concept);
                      return (
                        <button
                          type="button"
                          key={concept.id}
                          role="tab"
                          aria-selected={index === activeIndex}
                          className={`comic-concept-mini${index === activeIndex ? ' is-selected' : ''}`}
                          disabled={busy}
                          onClick={() => {
                            setActiveIndex(index);
                            setSelectedConcept(concept);
                            setFullStoryOpen(false);
                            setAdvancedOpen(false);
                          }}
                        >
                          <span className="comic-concept-mini-top">
                            <span className="comic-concept-mini-geo" aria-hidden="true">
                              <ConceptFormGlyph presentation={conceptPresentation} />
                            </span>
                            方案 {index + 1} · {conceptPresentation.name}
                          </span>
                          <span className="comic-concept-mini-title">{concept.storyTitle || concept.name}</span>
                          <span className="comic-concept-mini-form">
                            {conceptPresentation.pageCount > 1
                              ? `${conceptPresentation.pageCount} 页 · 共 ${conceptPresentation.totalPanels} 格`
                              : `1 页 · ${conceptPresentation.totalPanels} 格`}
                          </span>
                          <span className="comic-concept-mini-tone">{concept.tone}</span>
                        </button>
                      );
                    })}
                  </div>
                  {activeConcept && (() => {
                    const presentation = resolveConceptPresentation(activeConcept);
                    return (
                      <article className="comic-concept-card" data-testid="comic-concept-card">
                        {/* §28 主区顺序：标题 → 一句话 → 视觉预演 → 包袱 → 角色 → 形式元信息 → 使用 CTA → 完整故事（折叠）→ 创作详情（折叠） */}
                        <header className="comic-concept-card-head">
                          <h4 className="comic-concept-story-title" data-testid="comic-concept-story-title">
                            {activeConcept.storyTitle}
                          </h4>
                          <span className="comic-concept-card-tag">{activeConcept.comicForm} · {activeConcept.tone}</span>
                        </header>
                        {activeConcept.oneLineStory && (
                          <p className="comic-concept-oneliner" data-testid="comic-concept-oneliner">
                            {activeConcept.oneLineStory}
                          </p>
                        )}
                        {/* §30~§36 故事分镜预演：格子本身就是 Beat（纯 CSS，零 Image2 / 零计费） */}
                        <ComicStoryPreview
                          presentation={presentation}
                          beats={activeConcept.storyboardBeats}
                          punchline={activeConcept.punchline || undefined}
                          maxPages={4}
                        />
                        {activeConcept.punchline && (
                          <p className="comic-concept-punchline" data-testid="comic-concept-punchline">
                            结尾包袱：{activeConcept.punchline}
                          </p>
                        )}
                        <div className="comic-concept-characters" data-testid="comic-concept-characters">
                          <span className="comic-concept-characters-label">角色</span>
                          {activeConcept.characters.length > 0 ? activeConcept.characters.map(character => (
                            <span className="comic-concept-character" key={character.name}>
                              {character.name}
                              {character.role ? <i>{character.role}</i> : null}
                            </span>
                          )) : (
                            <span className="comic-concept-character"><i>未指定</i></span>
                          )}
                        </div>
                        <div className="comic-concept-meta">
                          <span data-testid="comic-concept-presentation">
                            {comicPresentationLabel(presentation)} · 预计 {presentation.totalPanels} 张图片
                          </span>
                        </div>
                        <div className="comic-actions-row">
                          <button
                            type="button"
                            className="app-btn app-btn-primary app-btn-sm comic-concept-use"
                            disabled={busy}
                            data-testid="comic-concept-use"
                            onClick={() => void runDraftSkill(activeConcept)}
                          >
                            使用这个故事
                          </button>
                        </div>
                        {activeConcept.fullStory && (
                          <div className="comic-concept-storyfold">
                            <button
                              type="button"
                              className="app-btn app-btn-secondary app-btn-sm comic-concept-story-toggle"
                              aria-expanded={fullStoryOpen}
                              disabled={busy}
                              onClick={() => setFullStoryOpen(value => !value)}
                            >
                              {fullStoryOpen ? '收起完整故事' : '展开完整故事'}
                            </button>
                            {fullStoryOpen && (
                              <div className="comic-concept-story">
                                <span className="comic-concept-story-label">完整故事</span>
                                <p data-testid="comic-concept-fullstory">{activeConcept.fullStory}</p>
                              </div>
                            )}
                          </div>
                        )}
                        <button
                          type="button"
                          className="app-btn app-btn-secondary app-btn-sm comic-concept-advanced-toggle"
                          aria-expanded={advancedOpen}
                          disabled={busy}
                          onClick={() => setAdvancedOpen(value => !value)}
                        >
                          {advancedOpen ? '收起创作详情' : '查看创作详情'}
                        </button>
                        {advancedOpen && (
                          <dl className="comic-concept-grid comic-concept-advanced" data-testid="comic-concept-advanced">
                            <div className="comic-concept-field">
                              <span className="comic-concept-field-label">视觉方向</span>
                              <span className="comic-concept-field-value">{activeConcept.visualStyle}</span>
                            </div>
                            <div className="comic-concept-field">
                              <span className="comic-concept-field-label">剧情结构</span>
                              <span className="comic-concept-field-value">{activeConcept.storyPattern}</span>
                            </div>
                            <div className="comic-concept-field">
                              <span className="comic-concept-field-label">对白风格</span>
                              <span className="comic-concept-field-value">{activeConcept.dialogueStyle || '—'}</span>
                            </div>
                            <div className="comic-concept-field">
                              <span className="comic-concept-field-label">适用场景</span>
                              <span className="comic-concept-field-value">{activeConcept.reason || '—'}</span>
                            </div>
                            {activeConcept.examplePremise && (
                              <div className="comic-concept-field">
                                <span className="comic-concept-field-label">选题示例</span>
                                <span className="comic-concept-field-value">{activeConcept.examplePremise}</span>
                              </div>
                            )}
                          </dl>
                        )}
                      </article>
                    );
                  })()}
                  </>
                );
              })()}
              {phase === 'preview' && draftSkill && (
                <div className="comic-skill-preview">
                  <div className="form-group">
                    <label htmlFor="comic-project-name">项目名称</label>
                    <input id="comic-project-name" type="text" value={projectName} onChange={e => setProjectName(e.target.value)} />
                  </div>
                  {selectedConcept && (
                    <section className="comic-concept-recap" data-testid="comic-concept-recap">
                      <h4 className="comic-card-title">本期故事</h4>
                      <p className="comic-concept-oneliner">{selectedConcept.oneLineStory}</p>
                      <span className="comic-concept-meta-line">
                        {comicPresentationLabel(resolveConceptPresentation(selectedConcept))}
                        {' · '}
                        {constraint.mode === 'fixed' ? '你指定的形式' : 'AI 推荐的形式'}
                      </span>
                      <ComicStoryPreview
                        presentation={resolveConceptPresentation(selectedConcept)}
                        beats={selectedConcept.storyboardBeats}
                        punchline={selectedConcept.punchline || undefined}
                        compact
                        maxPages={3}
                      />
                      <p className="comic-helper">进入项目后第一步就是审定这个故事</p>
                    </section>
                  )}
                  <dl className="comic-skill-facts">
                    <div><dt>漫画形式</dt><dd>{draftSkill.comicForm} · {draftSkill.layout.panelCount} 格</dd></div>
                    <div><dt>画风</dt><dd>{draftSkill.visualStyle}</dd></div>
                    <div><dt>故事模式</dt><dd>{draftSkill.storyPattern}</dd></div>
                    <div><dt>幽默风格</dt><dd>{draftSkill.humorStyle}</dd></div>
                    <div><dt>角色槽位</dt><dd>{draftSkill.characterSlots.map(slot => `${slot.name}${slot.required ? '（必选）' : ''}`).join('、') || '—'}</dd></div>
                    <div><dt>跨格一致性</dt><dd>{draftSkill.consistencyRules.join('；') || '—'}</dd></div>
                  </dl>
                  <p className="comic-helper">进入项目后可继续对话式微调技能与角色</p>
                </div>
              )}
            </>
          ) : (
            <div className="comic-skill-library">
              {props.skills.length === 0 && (
                <p className="comic-empty-hint">技能库还没有保存过的漫画技能，先用 AI 起草一个吧</p>
              )}
              {props.skills.map(skill => (
                <div className="comic-library-row" key={skill.id}>
                  <div className="comic-library-info">
                    <strong>{skill.name}</strong>
                    <span>{skill.comicForm} · v{skill.version}</span>
                  </div>
                  <button
                    type="button"
                    className="app-btn app-btn-secondary app-btn-sm"
                    disabled={creating}
                    onClick={() => void createFromLibrary(skill)}
                  >
                    用它开新期
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <footer className="comic-dialog-footer">
          <div className="app-segmented" aria-label="创建方式">
            <button
              type="button"
              className={`app-segmented-btn${mode === 'draft' ? ' active' : ''}`}
              aria-pressed={mode === 'draft'}
              onClick={() => setMode('draft')}
            >
              AI 起草
            </button>
            <button
              type="button"
              className={`app-segmented-btn${mode === 'library' ? ' active' : ''}`}
              aria-pressed={mode === 'library'}
              onClick={() => setMode('library')}
            >
              从技能库
            </button>
          </div>
          <div className="comic-dialog-actions">
            <button type="button" className="app-btn app-btn-secondary" onClick={close} disabled={busy || creating}>取消</button>
            {mode === 'draft' && phase === 'requirement' && (
              <button type="button" className="app-btn app-btn-primary" disabled={busy} onClick={() => void runRecommend()}>
                推荐漫画方案
              </button>
            )}
            {mode === 'draft' && phase === 'concepts' && (
              <button type="button" className="app-btn app-btn-secondary" disabled={busy} onClick={() => setPhase('requirement')}>换个需求</button>
            )}
            {mode === 'draft' && phase === 'preview' && (
              <>
                <button type="button" className="app-btn app-btn-secondary" disabled={creating} onClick={() => setPhase('concepts')}>上一步</button>
                <button type="button" className="app-btn app-btn-primary" disabled={creating} onClick={() => void createFromDraft()}>
                  {creating ? '创建中…' : '创建项目'}
                </button>
              </>
            )}
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
