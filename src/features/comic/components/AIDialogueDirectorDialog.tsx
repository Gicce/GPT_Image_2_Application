/**
 * AI 对白导演弹窗（V4.2.14 docs/ai-comic/27 §31~§66）——四个能力面板：
 *  - AI 规划对白（Planner）：Story+分镜+角色 → 每格对白建议；fill 默认只补空白格，
 *    整页重排需显式勾选确认（overwrite 绝不默认）；真实 comic_planner 模型名可见；
 *  - 视觉理解排版（Vision）：成图 → 主体区域 → 本地求解摆放建议；只建议几何
 *    （位置/宽/尾巴），绝不改文字；视觉模型不可用 → REAL_VISION_BLOCKED 如实标注，
 *    绝不 Mock；无成图格回落安全默认布局；
 *  - 一键排对白：fill 规划 + 视觉排版串联，一次确认应用两段结果；
 *  - 烘焙文字进图片（实验，默认收起）：显式计费警告 + 报价确认门，结果只写
 *    bakedTextAsset 派生资产（原图永不覆盖）。
 * 全部「建议 → 用户确认 → apply」两段式；应用动作由页面层承载（弹窗零 store 写入）。
 */

import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './ComicDialog.css';
import {
  directComicDialogues,
  type ComicDialogueDirectMode,
  type ComicDialogueProposal,
} from '../../../services/comicPlanner';
import { resolveModelForRole } from '../../aiRouting/resolveModelForRole';
import {
  dialogueDraftFromProposal,
  makeVisionDirector,
  proposeComicDialoguePlacement,
  type VisionPlacementPanelOutcome,
} from '../dialogueDirector';
import { DIALOGUE_TAIL_LABELS, visibleDialoguesOfPanel } from '../textLayer';
import { comicBubbleStyleMeta } from '../bubbleShape';
import { comicPanelsByOrder } from '../domain';
import type { ComicDialogue, ComicProject } from '../types';
import AIPlanningSurface from './AIPlanningSurface';
import { isComicPlannerRunning, type ComicPlannerProgressStatus } from '../comicPlannerProgress';

export interface AIDialogueDirectorDialogProps {
  open: boolean;
  project: ComicProject;
  onClose: () => void;
  /** 应用 Planner 草稿（页面层映射 applyDialogueDrafts；overwrite 仅整页重排确认后为 true）。 */
  onApplyProposals: (drafts: ComicDialogue[], options: { overwrite: boolean }) => void;
  /** 应用视觉摆放建议（页面层映射 applyVisionPlacement）。 */
  onApplyPlacement: (suggestions: VisionPlacementPanelOutcome[]) => void;
  /** 烘焙任务提交（页面层 buildBakeTextTask → createSeriesTask，自带报价确认）。 */
  onSubmitBakeText: (panelId: string) => void;
  bakeSubmitting?: boolean;
}

type DirectorTab = 'plan' | 'vision' | 'auto' | 'bake';

interface PlannerRunState {
  status: ComicPlannerProgressStatus;
  startedAt: number | null;
  errorText: string | null;
  modelLabel: string | null;
}

interface VisionRunState {
  status: 'running' | 'completed' | 'failed';
  startedAt: number | null;
  errorText: string | null;
  /** REAL_VISION_BLOCKED：视觉模型不可用（如实标注，绝不 Mock 冒充真实分析）。 */
  blocked: boolean;
}

const DIRECT_MODE_LABELS: Record<ComicDialogueDirectMode, string> = {
  fill: '只补空白格（推荐 · 不改已有文字）',
  panel: '重新生成本格对白',
  page: '重新生成整页对白（覆盖现有）',
};

const AUTO_PHASE_LABELS = { plan: 'AI 规划对白', vision: '视觉理解排版' } as const;

export default function AIDialogueDirectorDialog(props: AIDialogueDirectorDialogProps) {
  const { project } = props;
  const [tab, setTab] = useState<DirectorTab>('plan');
  const [mode, setMode] = useState<ComicDialogueDirectMode>('fill');
  const [targetPanelOrder, setTargetPanelOrder] = useState(0);
  const [maxChars, setMaxChars] = useState(24);
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [bakeArmed, setBakeArmed] = useState(false);
  const [bakeConfirmPanelId, setBakeConfirmPanelId] = useState<string | null>(null);

  const [plannerRun, setPlannerRun] = useState<PlannerRunState | null>(null);
  const [proposals, setProposals] = useState<ComicDialogueProposal[] | null>(null);
  const [visionRun, setVisionRun] = useState<VisionRunState | null>(null);
  const [visionPanels, setVisionPanels] = useState<VisionPlacementPanelOutcome[] | null>(null);
  const visionModelRef = useRef<{ providerName: string; modelName: string } | null>(null);

  // 一键排对白（auto）两段结果状态：必须声明在 if (!props.open) 早退之前——
  // 本组件常驻挂载（open=false 也参与渲染），hooks 数量随 open 翻转会触发
  // "Rendered more hooks than during the previous render"（V4.2.13 双问题修复）。
  const [autoPhase, setAutoPhase] = useState<'plan' | 'vision' | null>(null);
  const [autoProposals, setAutoProposals] = useState<ComicDialogueProposal[] | null>(null);
  const [autoVisionPanels, setAutoVisionPanels] = useState<VisionPlacementPanelOutcome[] | null>(null);
  const [autoVisionApplied, setAutoVisionApplied] = useState(false);

  const panels = useMemo(() => comicPanelsByOrder(project), [project]);
  const speakerLabel = useMemo(() => {
    const map = new Map<string, string>([['narrator', '旁白']]);
    for (const character of project.characterSnapshots) map.set(character.id, character.name);
    return (id: string) => map.get(id) ?? '未知角色';
  }, [project.characterSnapshots]);

  // 模型可见性（resolveModelForRole 只读预显；真实调用前记录 usage）
  const plannerPreview = useMemo(() => {
    const resolution = resolveModelForRole('comic_planner');
    return resolution.ok ? resolution.resolved.displayName : null;
  }, []);
  const visionPreview = useMemo(() => {
    const resolution = resolveModelForRole('vision_analysis');
    return resolution.ok ? resolution.resolved.displayName : null;
  }, []);

  const busy = isComicPlannerRunning(plannerRun?.status ?? 'idle') || visionRun?.status === 'running';

  // fill 模式目标可见性（与 directComicDialogues 前置守卫同一语义）：空文字对白
  // 不算「已有对白」；0 格待补时提前在 UI 说明，而不是让用户点了才失败。
  const panelsWithText = useMemo(() => new Set(
    project.dialogues
      .filter(dialogue => dialogue.text.trim().length > 0)
      .map(dialogue => dialogue.panelId),
  ), [project.dialogues]);
  const blankPanelCount = panels.filter(panel => !panelsWithText.has(panel.id)).length;

  if (!props.open) return null;

  const close = () => {
    if (busy) return;
    props.onClose();
  };

  const resetPlanner = () => {
    setPlannerRun(null);
    setProposals(null);
  };
  const resetVision = () => {
    setVisionRun(null);
    setVisionPanels(null);
  };

  // ===== Planner 运行（AI 规划 / 一键排对白共用；auto 固定 fill 语义）=====
  // 异常兜底（V4.2.13 残留修复）：调用方以 `void runPlanner(...)` 触发，链路里任何
  // 未捕获异常都会让状态停在 resolving 且 busy 阻止关闭——表现即「点击后不可用」。
  // 这里统一落到 failed 态，错误可见、可重试、可关闭。
  const runPlanner = async (onDone: (proposals: ComicDialogueProposal[]) => void, modeOverride?: ComicDialogueDirectMode) => {
    try {
      const effectiveMode = modeOverride ?? mode;
      const resolution = resolveModelForRole('comic_planner');
      if (!resolution.ok) {
        setPlannerRun({ status: 'failed', startedAt: null, errorText: resolution.error, modelLabel: null });
        return;
      }
      setPlannerRun({ status: 'resolving', startedAt: Date.now(), errorText: null, modelLabel: resolution.resolved.displayName });
      const outcome = await directComicDialogues({
        skill: project.skillSnapshot,
        story: project.story ?? null,
        panels: panels.map(panel => ({ id: panel.id, order: panel.order, scene: panel.scene, characterIds: panel.characterIds })),
        characters: project.characterSnapshots.map(character => ({ id: character.id, name: character.name, role: character.role })),
        existingDialogues: project.dialogues.map(dialogue => ({ panelId: dialogue.panelId, text: dialogue.text })),
        mode: effectiveMode,
        ...(effectiveMode === 'panel' ? { targetPanelOrder } : {}),
        maxCharsHint: maxChars,
        onStage: stage => setPlannerRun(prev => prev ? { ...prev, status: stage } : prev),
      });
      if (!outcome.ok) {
        setPlannerRun(prev => prev ? { ...prev, status: 'failed', errorText: outcome.error } : prev);
        return;
      }
      setPlannerRun(prev => prev ? { ...prev, status: 'completed' } : prev);
      setProposals(outcome.proposals);
      onDone(outcome.proposals);
    } catch (error) {
      // 结构化错误已在链路内归一；这里是最后一道防线（意外 runtime 异常）
      const message = error instanceof Error ? error.message : '对白规划运行异常，请重试。';
      setPlannerRun(prev => (prev
        ? { ...prev, status: 'failed', errorText: message }
        : { status: 'failed', startedAt: null, errorText: message, modelLabel: null }));
    }
  };

  // ===== Vision 运行（视觉排版 / 一键排对白共用）=====
  const runVision = async (onDone: (panels: VisionPlacementPanelOutcome[]) => void) => {
    try {
      const director = makeVisionDirector();
      if (!director.ok) {
        setVisionRun({ status: 'failed', startedAt: null, errorText: director.error, blocked: true });
        return;
      }
      visionModelRef.current = director.model;
      setVisionRun({ status: 'running', startedAt: Date.now(), errorText: null, blocked: false });
      const outcome = await proposeComicDialoguePlacement({ project, analyze: director.analyze });
      setVisionRun({ status: 'completed', startedAt: null, errorText: null, blocked: false });
      setVisionPanels(outcome.panels);
      onDone(outcome.panels);
    } catch (error) {
      const message = error instanceof Error ? error.message : '视觉排版运行异常，请重试。';
      setVisionRun({ status: 'failed', startedAt: null, errorText: message, blocked: false });
    }
  };

  // ===== 应用（页面层承载写库；弹窗只收集确认结果）=====
  const draftsFromProposals = (list: ComicDialogueProposal[]): ComicDialogue[] => {
    const seedByPanel = new Map<string, number>();
    return list.map(proposal => {
      const panel = panels.find(item => item.order === proposal.order);
      if (!panel) return null;
      const seed = seedByPanel.get(panel.id)
        ?? project.dialogues.filter(dialogue => dialogue.panelId === panel.id).length;
      seedByPanel.set(panel.id, seed + 1);
      return dialogueDraftFromProposal(project, panel, proposal, seed);
    }).filter((draft): draft is ComicDialogue => draft !== null);
  };

  const handleApplyPlanner = () => {
    if (!proposals) return;
    // 「重写本格」语义 = 替换目标格的现有对白（目标格必有旧对白，fill 铁律会整格
    // 跳过 → 此前 overwrite 恒 false 导致 apply 永不生效且静默失败，V4.2.13 残留
    // 修复）；page 模式维持显式勾选确认后才 overwrite。
    const panelScoped = mode === 'panel'
      ? proposals.filter(proposal => proposal.order === targetPanelOrder)
      : proposals;
    props.onApplyProposals(draftsFromProposals(panelScoped), {
      overwrite: mode === 'panel' || (mode === 'page' && overwriteConfirmed),
    });
    resetPlanner();
  };

  // 一键排对白：两段结果都成功后一次应用（fill 语义 + 摆放建议）
  const runAuto = () => {
    setAutoPhase('plan');
    setAutoProposals(null);
    setAutoVisionPanels(null);
    setAutoVisionApplied(false);
    // 一键排对白恒为 fill 语义（只补空白格），不受「AI 规划」页策略选择影响
    void runPlanner(result => {
      setAutoProposals(result);
      setAutoPhase('vision');
      void runVision(visionResult => setAutoVisionPanels(visionResult));
    }, 'fill');
  };

  const handleApplyAuto = () => {
    if (!autoProposals) return;
    props.onApplyProposals(draftsFromProposals(autoProposals), { overwrite: false });
    if (autoVisionPanels) props.onApplyPlacement(autoVisionPanels);
    setAutoVisionApplied(true);
    setAutoPhase(null);
    resetPlanner();
    resetVision();
  };

  const bakeCandidates = panels.filter(panel =>
    panel.imageAsset && visibleDialoguesOfPanel(project, panel.id).length > 0);

  const renderPlannerSurface = (onRetry: () => void) => (
    plannerRun && (isComicPlannerRunning(plannerRun.status) || plannerRun.status === 'failed') ? (
      <AIPlanningSurface
        inline
        title="AI 正在规划对白"
        status={plannerRun.status}
        startedAt={plannerRun.startedAt}
        modelLabel={plannerRun.modelLabel}
        hint="按故事节拍与角色口吻，为每一格写一句漫画对白"
        errorText={plannerRun.errorText}
        onRetry={onRetry}
        onDismiss={resetPlanner}
        dismissLabel="返回"
      />
    ) : null
  );

  return createPortal(
    <div className="comic-dialog-overlay" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <section
        className="comic-dialog comic-dialog-wide comic-director-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="AI 对白导演"
        onMouseDown={e => e.stopPropagation()}
      >
        <header className="comic-dialog-header">
          <div>
            <h3>AI 对白导演</h3>
            <p>规划对白 · 视觉排版 · 一键排对白；所有建议确认后才写入，普通编辑零生图</p>
          </div>
          <button type="button" className="comic-dialog-close" aria-label="关闭" onClick={close}>×</button>
        </header>

        <div className="comic-dialog-body">
          <div className="app-segmented" aria-label="对白导演能力">
            {([['plan', 'AI 规划对白'], ['vision', '视觉理解排版'], ['auto', '一键排对白'], ['bake', '烘焙文字（实验）']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`app-segmented-btn${tab === value ? ' active' : ''}`}
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'plan' && (
            <div className="comic-director-panel" data-testid="comic-director-plan">
              {renderPlannerSurface(() => { resetPlanner(); void runPlanner(() => undefined); })}
              {!plannerRun || plannerRun.status === 'completed' ? (
                <>
                  <div className="comic-dialogue-controls">
                    <div className="form-group">
                      <label htmlFor="director-mode">生成策略</label>
                      <select id="director-mode" value={mode} onChange={e => setMode(e.target.value as ComicDialogueDirectMode)}>
                        {Object.entries(DIRECT_MODE_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    </div>
                    {mode === 'panel' && (
                      <div className="form-group">
                        <label htmlFor="director-panel">目标格</label>
                        <select id="director-panel" value={targetPanelOrder} onChange={e => setTargetPanelOrder(Number(e.target.value))}>
                          {panels.map(panel => (
                            <option key={panel.id} value={panel.order}>第 {panel.order + 1} 格</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="form-group">
                      <label htmlFor="director-maxchars">每格字数上限</label>
                      <select id="director-maxchars" value={maxChars} onChange={e => setMaxChars(Number(e.target.value))}>
                        {[16, 24, 32].map(value => <option key={value} value={value}>{value} 字</option>)}
                      </select>
                    </div>
                  </div>
                  {mode === 'page' && (
                    <label className="comic-director-confirm">
                      <input
                        type="checkbox"
                        checked={overwriteConfirmed}
                        onChange={e => setOverwriteConfirmed(e.target.checked)}
                        data-testid="comic-director-overwrite"
                      />
                      我确认整页重排会<strong>替换全部现有对白</strong>（默认只补空白格，绝不覆盖）
                    </label>
                  )}
                  <p className="comic-field-hint">模型：{plannerPreview ?? '未配置（请前往「设置与更新 → AI 模型使用」启用任务规划模型）'}</p>
                  {proposals ? (
                    <div className="comic-director-result" data-testid="comic-director-proposals">
                      <ul>
                        {proposals.map((proposal, index) => (
                          <li key={`${proposal.order}-${index}`}>
                            <span className="comic-director-proposal-meta">
                              第 {proposal.order + 1} 格 · {speakerLabel(proposal.speakerId)} · {comicBubbleStyleMeta(proposal.suggestedStyle).label}
                            </span>
                            <span className="comic-director-proposal-text">{proposal.text}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="comic-actions-row">
                        <button
                          type="button"
                          className="app-btn app-btn-primary app-btn-sm"
                          data-testid="comic-director-apply"
                          onClick={handleApplyPlanner}
                        >
                          应用 {proposals.length} 条对白
                        </button>
                        <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={resetPlanner}>放弃</button>
                      </div>
                      {mode === 'page' && !overwriteConfirmed && (
                        <p className="comic-field-hint">整页重排需先勾选「替换全部现有对白」确认</p>
                      )}
                      {mode === 'panel' && (
                        <p className="comic-field-hint">将替换第 {targetPanelOrder + 1} 格的现有对白（其他格不动）</p>
                      )}
                    </div>
                  ) : (
                    <div className="comic-actions-row">
                      <button
                        type="button"
                        className="app-btn app-btn-primary app-btn-sm"
                        data-testid="comic-director-run"
                        onClick={() => { resetPlanner(); void runPlanner(() => undefined); }}
                      >
                        生成对白建议
                      </button>
                      {mode === 'fill' && (blankPanelCount === 0
                        ? <span className="comic-field-hint">所有格都已有对白——请换「重新生成本格」或「重新生成整页」</span>
                        : <span className="comic-field-hint">只给还没有文字的格写对白（还有 {blankPanelCount} 格），已有内容原样保留</span>)}
                    </div>
                  )}
                </>
              ) : null}
            </div>
          )}

          {tab === 'vision' && (
            <div className="comic-director-panel" data-testid="comic-director-vision">
              {visionRun?.status === 'running' && (
                <AIPlanningSurface
                  inline
                  title="AI 正在视觉排版"
                  status="planning"
                  startedAt={visionRun.startedAt}
                  modelLabel={visionModelRef.current?.modelName ?? visionPreview}
                  hint="逐格识别画面主体位置，计算避开主体的气泡摆放"
                />
              )}
              {visionRun?.status === 'failed' && (
                <div className="comic-inline-error" data-testid={visionRun.blocked ? 'real-vision-blocked' : 'comic-vision-error'}>
                  <p>{visionRun.blocked ? 'REAL_VISION_BLOCKED：' : ''}{visionRun.errorText ?? '视觉分析失败'}</p>
                  {visionRun.blocked && <p className="comic-field-hint">视觉理解模型不可用（未配置或不支持图片输入）。不会用假数据冒充真实分析；可先在画布手动摆放，或前往「设置与更新 → AI 模型使用」配置视觉模型。</p>}
                  <div className="comic-actions-row">
                    <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={() => void runVision(() => undefined)}>重试</button>
                    <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={resetVision}>返回</button>
                  </div>
                </div>
              )}
              {(!visionRun || visionRun.status === 'completed') && (
                <>
                  <p className="comic-field-hint">
                    模型：{visionPreview ?? '未配置视觉模型'}
                    {visionModelRef.current ? `（本次：${visionModelRef.current.providerName} · ${visionModelRef.current.modelName}）` : ''}
                  </p>
                  <p className="comic-field-hint">视觉理解只建议摆放位置 / 宽度 / 尾巴，<strong>绝不改文字与样式</strong>；应用前逐条可见。</p>
                  {visionPanels ? (
                    <div className="comic-director-result" data-testid="comic-director-vision-result">
                      {visionPanels.map(outcome => (
                        <div key={outcome.panelId} className="comic-director-vision-panel">
                          <span className="comic-director-proposal-meta">
                            第 {outcome.order + 1} 格
                            <em className={`comic-director-basis is-${outcome.analyzed ? 'vision' : 'default'}`}>
                              {outcome.analyzed ? '视觉排版' : '安全默认布局'}
                            </em>
                            {outcome.analysisError ? <em className="comic-director-basis is-default">{outcome.analysisError}</em> : null}
                          </span>
                          <ul>
                            {outcome.suggestions.map(suggestion => {
                              const dialogue = project.dialogues.find(item => item.id === suggestion.dialogueId);
                              return (
                                <li key={suggestion.dialogueId}>
                                  <span className="comic-director-proposal-meta">
                                    {`位置 ${Math.round(suggestion.position.x * 100)}% / ${Math.round(suggestion.position.y * 100)}%`}
                                    {suggestion.tail ? ` · 尾巴${DIALOGUE_TAIL_LABELS[suggestion.tail]}` : ''}
                                  </span>
                                  <span className="comic-director-proposal-text">{dialogue?.text || '（空对白）'}</span>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ))}
                      <div className="comic-actions-row">
                        <button
                          type="button"
                          className="app-btn app-btn-primary app-btn-sm"
                          data-testid="comic-director-vision-apply"
                          onClick={() => { props.onApplyPlacement(visionPanels); resetVision(); }}
                        >
                          应用摆放建议
                        </button>
                        <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={resetVision}>放弃</button>
                      </div>
                    </div>
                  ) : (
                    <div className="comic-actions-row">
                      <button
                        type="button"
                        className="app-btn app-btn-primary app-btn-sm"
                        data-testid="comic-director-vision-run"
                        onClick={() => void runVision(() => undefined)}
                      >
                        分析并建议摆放
                      </button>
                      <span className="comic-field-hint">有文字的格才会出现在建议里；无成图的格用安全默认布局</span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {tab === 'auto' && (
            <div className="comic-director-panel" data-testid="comic-director-auto">
              {renderPlannerSurface(runAuto)}
              {autoPhase === 'vision' && visionRun?.status === 'running' && (
                <AIPlanningSurface inline title="AI 正在视觉排版" status="planning" startedAt={visionRun.startedAt} modelLabel={visionModelRef.current?.modelName ?? visionPreview} hint="对白建议已生成，正在计算摆放" />
              )}
              {autoPhase === 'vision' && visionRun?.status === 'failed' && (
                <div className="comic-inline-error" data-testid={visionRun.blocked ? 'real-vision-blocked' : 'comic-vision-error'}>
                  <p>{visionRun.blocked ? 'REAL_VISION_BLOCKED：' : ''}{visionRun.errorText ?? '视觉分析失败'}——对白建议保留，可单独应用后手动摆放</p>
                </div>
              )}
              {!autoPhase && !autoProposals && (
                <>
                  <p className="comic-field-hint">补空白格的对白规划 + 视觉摆放建议一次完成；既有对白一律不动。</p>
                  <p className="comic-field-hint">规划模型：{plannerPreview ?? '未配置'}；视觉模型：{visionPreview ?? '未配置'}</p>
                  <div className="comic-actions-row">
                    <button
                      type="button"
                      className="app-btn app-btn-primary app-btn-sm"
                      data-testid="comic-director-auto-run"
                      onClick={runAuto}
                    >
                      一键排对白
                    </button>
                  </div>
                </>
              )}
              {autoProposals && (
                <div className="comic-director-result" data-testid="comic-director-auto-result">
                  <p className="comic-field-hint">{AUTO_PHASE_LABELS.plan}：{autoProposals.length} 条建议；{autoVisionPanels ? `${AUTO_PHASE_LABELS.vision}：${autoVisionPanels.length} 格建议` : '视觉排版未完成'}</p>
                  <ul>
                    {autoProposals.map((proposal, index) => (
                      <li key={`auto-${proposal.order}-${index}`}>
                        <span className="comic-director-proposal-meta">
                          第 {proposal.order + 1} 格 · {speakerLabel(proposal.speakerId)} · {comicBubbleStyleMeta(proposal.suggestedStyle).label}
                        </span>
                        <span className="comic-director-proposal-text">{proposal.text}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="comic-actions-row">
                    <button
                      type="button"
                      className="app-btn app-btn-primary app-btn-sm"
                      data-testid="comic-director-auto-apply"
                      disabled={autoVisionApplied}
                      onClick={handleApplyAuto}
                    >
                      {autoVisionApplied ? '已应用' : '应用全部（只补空白格）'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'bake' && (
            <div className="comic-director-panel" data-testid="comic-director-bake">
              <p className="comic-director-warning">
                实验功能：把当前文字层「烘焙」进图片会<strong>真实调用图片生成模型（按张计费）</strong>。
                烘焙结果保存为派生资产（bakedTextAsset），原始成图永不覆盖，独立文字层随时可回；
                正常编辑对白零生图，不受此功能影响。
              </p>
              {!bakeArmed ? (
                <label className="comic-director-confirm">
                  <input
                    type="checkbox"
                    checked={bakeArmed}
                    onChange={e => setBakeArmed(e.target.checked)}
                    data-testid="comic-bake-arm"
                  />
                  我了解烘焙会调用图片生成模型并产生计费
                </label>
              ) : (
                <>
                  {bakeCandidates.length === 0 && <p className="comic-field-hint">没有可烘焙的格（需要已成图且至少有一条文字）</p>}
                  {bakeCandidates.map(panel => {
                    const count = visibleDialoguesOfPanel(project, panel.id).length;
                    const confirming = bakeConfirmPanelId === panel.id;
                    return (
                      <div key={panel.id} className="comic-director-bake-row">
                        <span>第 {panel.order + 1} 格 · {count} 条文字 · 图生图 1 张</span>
                        {!confirming ? (
                          <button
                            type="button"
                            className="app-btn app-btn-secondary app-btn-sm"
                            data-testid={`comic-bake-arm-${panel.id}`}
                            disabled={props.bakeSubmitting}
                            onClick={() => setBakeConfirmPanelId(panel.id)}
                          >
                            烘焙本格文字…
                          </button>
                        ) : (
                          <span className="comic-actions-row">
                            <button
                              type="button"
                              className="app-btn app-btn-primary app-btn-sm"
                              data-testid={`comic-bake-confirm-${panel.id}`}
                              disabled={props.bakeSubmitting}
                              onClick={() => {
                                setBakeConfirmPanelId(null);
                                props.onSubmitBakeText(panel.id);
                              }}
                            >
                              确认计费并提交
                            </button>
                            <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={() => setBakeConfirmPanelId(null)}>取消</button>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}
        </div>

        <footer className="comic-dialog-footer">
          <span className="comic-muted">建议 → 确认 → 应用；文字层编辑与 AI 规划均为纯文本模型调用（BYOK），零 Image2</span>
          <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={close}>关闭</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
