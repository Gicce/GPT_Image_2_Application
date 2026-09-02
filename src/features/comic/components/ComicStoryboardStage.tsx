/**
 * 分镜草稿阶段（Phase 1.2 Step 4 + V4.2.11 §E 排版直出）——从 Story 阶段拆出：
 *  AI 把已确认的故事拆成「每一格要画什么」；用户审定后应用。
 *  - V4.2.11 §E（P0-5）：分镜直接按最终排版呈现——四宫格 = 2×2 格位网格，
 *    每格就是一张分镜卡；未规划的格位显示「等待规划」占位，
 *    不再出现巨大空白单图（「当前分镜（0格）」）；
 *  - §38 分镜卡字段分层：第N格 / 标题 / 场景摘要 / 主要角色 / 动作 / 表情 / 对白概要，
 *    §38.1 默认不展示最终 Prompt（已应用格的「生成详情」折叠）；§38.2 大白话改单格
 *    （patchComicPanel 白名单补丁，只 patch 指令涉及的那一格）；
 *  - §40 多页模式按「第 N 页」分组，每页一组排版网格；
 *  - 整体重出 = 重新规划本期版式（重新规划四宫格 / 九宫格…）；
 *    生成 → repairStoryboard 兜底 → 预览（修复动作不静默）→ 应用
 *    （applyStoryToProject：新分镜接管，上一代成图转 stale 供回看）。
 * 草稿不丢（§30/§85）：未应用的分镜草稿 + 单格微调输入写穿 project.uiDraft.storyboard，
 * 切步骤 / 刷新后挂载恢复。可观测性：阶段 Progress 卡（真实模型名）+ 失败原位重试。
 */

import { useState } from 'react';
import { toastSuccess } from '../../../components/Toast';
import { draftStoryboard, patchComicPanel } from '../../../services/comicPlanner';
import { repairStoryboard } from '../storyboard';
import { activePanels } from '../comicTask';
import { applyComicPanelPatches, comicStoryFingerprint, replaceProjectPanel } from '../domain';
import { resolveComicPresentation } from '../presentation';
import { resolveModelForRole } from '../../aiRouting/resolveModelForRole';
import { useDebouncedDraftValue } from '../useComicUiDraft';
import type { ComicDialogue, ComicPanel, ComicProject, ComicStory, ComicUiDraft } from '../types';
import AIPlanningSurface from './AIPlanningSurface';
import { isComicPlannerRunning, type ComicPlannerProgressStatus } from '../comicPlannerProgress';

export interface ComicStoryboardStageProps {
  project: ComicProject;
  /** 应用分镜（页面层 → applyStoryToProject）。 */
  onApply: (story: ComicStory, panels: ComicPanel[], dialogues: ComicDialogue[]) => void;
  /** 已应用分镜的单格修改（页面层 → applyProject → replaceProjectPanel）。 */
  onPatch: (apply: (draft: ComicProject) => ComicProject) => void;
  /** V4.2.12 §41：手动调整分镜顺序（只交换 order，不重新生成图片）。 */
  onPanelMove: (panelId: string, direction: 'up' | 'down') => void;
  /** 步骤草稿写穿（页面层 → updateActive 只写 uiDraft，不参与阶段派生）。 */
  onDraft: (mutate: (uiDraft: ComicUiDraft) => ComicUiDraft) => void;
}

interface StoryboardDraft {
  story: ComicStory;
  panels: ComicPanel[];
  dialogues: ComicDialogue[];
  repairs: string[];
}

interface PlannerRunState {
  status: ComicPlannerProgressStatus;
  startedAt: number | null;
  errorText: string | null;
  modelLabel: string | null;
}

export default function ComicStoryboardStage(props: ComicStoryboardStageProps) {
  const { project } = props;
  const skill = project.skillSnapshot;
  const story = project.story ?? null;
  const [draft, setDraft] = useState<StoryboardDraft | null>(() => {
    const saved = project.uiDraft?.storyboard;
    // Story Lock（V4.2.13 R1）：草稿必须属于当前已确认的故事；故事重新确认后
    // 残留的旧草稿不复活（指纹不符 → 丢弃，界面回到「等待规划」）。
    if (saved?.storyDraft && saved.panels?.length) {
      const belongsToCurrentStory = !project.story
        || comicStoryFingerprint(project.story) === comicStoryFingerprint(saved.storyDraft);
      if (belongsToCurrentStory) {
        return {
          story: saved.storyDraft,
          panels: saved.panels,
          dialogues: saved.dialogues ?? [],
          repairs: saved.repairs ?? [],
        };
      }
    }
    return null;
  });
  const [run, setRun] = useState<PlannerRunState | null>(null);
  const [panelBusy, setPanelBusy] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<Record<string, string | null>>({});

  // §38.2/§30/§85：单格大白话微调输入（panelId 键）防抖写穿 uiDraft.storyboard.patchTexts
  const [patchText, setPatchText] = useDebouncedDraftValue<Record<string, string>>(
    () => project.uiDraft?.storyboard?.patchTexts ?? {},
    value => {
      const kept = Object.fromEntries(Object.entries(value).filter(([, text]) => text));
      props.onDraft(draftState => {
        const rest = { ...draftState };
        if (Object.keys(kept).length === 0) {
          if (!draftState.storyboard?.storyDraft && !draftState.storyboard?.panels?.length) {
            delete rest.storyboard;
            return rest;
          }
          return { ...rest, storyboard: { ...draftState.storyboard, patchTexts: undefined } };
        }
        return { ...rest, storyboard: { ...draftState.storyboard, patchTexts: kept } };
      });
    },
  );

  /** 分镜草稿合并写：null = 消费后剥离（应用 / 重出）；微调输入不随草稿剥离。 */
  const persistDraft = (next: StoryboardDraft | null) => {
    setDraft(next);
    props.onDraft(draftState => {
      if (!next) {
        const rest = { ...draftState };
        if (!draftState.storyboard?.patchTexts || Object.keys(draftState.storyboard.patchTexts).length === 0) {
          delete rest.storyboard;
          return rest;
        }
        // 还有未用完的单格微调输入：只剥草稿本体
        return { ...rest, storyboard: { patchTexts: draftState.storyboard?.patchTexts } };
      }
      return {
        ...draftState,
        storyboard: {
          storyDraft: next.story,
          panels: next.panels,
          dialogues: next.dialogues.length ? next.dialogues : undefined,
          repairs: next.repairs.length ? next.repairs : undefined,
          patchTexts: draftState.storyboard?.patchTexts,
        },
      };
    });
  };

  const busy = run !== null && isComicPlannerRunning(run.status);
  const panels = activePanels(project);
  const showingDraft = draft !== null;

  const characters = project.characterSnapshots.filter(character =>
    Object.values(project.characterBindings).includes(character.id));

  const listPanels = showingDraft ? draft!.panels : panels;
  // §E 排版直出：几何按「本期计划格数 vs 实际分镜数」取大者解析——
  // 还没规划时也按计划格数画出完整版式骨架（四宫格 = 2×2 四个等待规划占位），
  // 不允许回落成一张巨大空白单图。
  const plannedTotal = skill.layout.panelCount > 0 ? skill.layout.panelCount : listPanels.length;
  const presentation = resolveComicPresentation(skill, {
    totalPanels: Math.max(plannedTotal, listPanels.length, 1),
  });
  const listDialoguesOf = (panelId: string) => (showingDraft
    ? draft!.dialogues.filter(dialogue => dialogue.panelId === panelId)
    : project.dialogues.filter(dialogue => dialogue.panelId === panelId));

  const plannerPreview = (() => {
    const resolution = resolveModelForRole('comic_planner');
    return resolution.ok ? resolution.resolved.displayName : null;
  })();

  const patchRun = (patch: Partial<PlannerRunState>) => {
    setRun(prev => (prev ? { ...prev, ...patch } : prev));
  };

  const runStoryboard = async () => {
    if (!story) return;
    const resolution = resolveModelForRole('comic_planner');
    if (!resolution.ok) {
      setRun({ status: 'failed', startedAt: null, errorText: resolution.error, modelLabel: null });
      return;
    }
    setRun({ status: 'resolving', startedAt: Date.now(), errorText: null, modelLabel: resolution.resolved.displayName });
    try {
      const outcome = await draftStoryboard({
        skill,
        story,
        characters,
        onStage: stage => patchRun({ status: stage }),
      });
      if (!outcome.ok) {
        patchRun({ status: 'failed', errorText: outcome.error });
        return;
      }
      const repaired = repairStoryboard(story, outcome.panels, outcome.dialogues, characters);
      if (repaired.report.fatal) {
        patchRun({ status: 'failed', errorText: '本次分镜输出无效（没有可用分镜），请重试' });
        return;
      }
      persistDraft({
        story: repaired.story,
        panels: repaired.panels,
        dialogues: repaired.dialogues,
        repairs: repaired.report.repairs,
      });
      setRun(null);
    } catch (err) {
      patchRun({
        status: 'failed',
        errorText: err instanceof Error ? err.message : '分镜生成失败，请重试',
      });
    }
  };

  const applyDraft = () => {
    if (!draft) return;
    props.onApply(draft.story, draft.panels, draft.dialogues);
    toastSuccess(`已应用 ${draft.panels.length} 格分镜草稿`);
    persistDraft(null);
  };

  /** §38.2 大白话改单格：白名单补丁只落到这一格（草稿态改草稿；已应用改项目）。 */
  const runPatchPanel = async (panel: ComicPanel) => {
    const text = (patchText[panel.id] ?? '').trim();
    if (!text) {
      setPanelError(prev => ({ ...prev, [panel.id]: '请先填写这一格的修改要求' }));
      return;
    }
    setPanelBusy(panel.id);
    setPanelError(prev => ({ ...prev, [panel.id]: null }));
    try {
      const outcome = await patchComicPanel({ panel, instruction: text });
      if (!outcome.ok) {
        setPanelError(prev => ({ ...prev, [panel.id]: outcome.error }));
        return;
      }
      const application = applyComicPanelPatches(panel, outcome.patches);
      if (application.applied.length === 0) {
        setPanelError(prev => ({ ...prev, [panel.id]: '本次调整没有命中可修改的字段，请换一种说法' }));
        return;
      }
      if (showingDraft && draft) {
        persistDraft({
          ...draft,
          panels: draft.panels.map(item => (item.id === panel.id ? application.panel : item)),
        });
      } else {
        props.onPatch(projectDraft => replaceProjectPanel(projectDraft, application.panel));
      }
      setPatchText(prev => ({ ...prev, [panel.id]: '' }));
      toastSuccess(`第 ${panel.order + 1} 格已更新（${application.applied.join('、')}）`);
    } catch (err) {
      setPanelError(prev => ({
        ...prev,
        [panel.id]: err instanceof Error ? err.message : '这一格调整失败，请重试',
      }));
    } finally {
      setPanelBusy(null);
    }
  };

  /** §E 未规划格位占位：保持版式完整（四宫格缺格时也能看到 2×2 四格骨架）。 */
  const renderPendingCell = (order: number) => (
    <div className="comic-panel-card is-pending" key={`pending-${order}`} data-testid={`comic-panel-pending-${order}`}>
      <header className="comic-panel-card-head">
        <span className="comic-panel-order">第 {order + 1} 格</span>
      </header>
      <div className="comic-panel-pending">
        <p className="comic-panel-pending-tag">等待规划</p>
        <p className="comic-muted">生成分镜草稿后，这里显示这一格的画面与对白</p>
      </div>
    </div>
  );

  /** §E/§38 分镜格卡：字段分层（标题/场景摘要/主要角色/动作/表情/对白概要），Prompt 不默认展示。 */
  const renderPanelCard = (panel: ComicPanel) => {
    const panelDialogues = listDialoguesOf(panel.id);
    const panelCharacters = panel.characterIds.map(id => characters.find(c => c.id === id)?.name ?? id);
    const beatTitle = story?.beats?.[panel.order] ?? '';
    // §41 上移/下移只作用于已应用分镜（草稿态顺序由 planner 决定，应用前不提供）
    const activeIndex = showingDraft ? -1 : panels.findIndex(item => item.id === panel.id);
    return (
      <div className={`comic-panel-card${panel.stale ? ' is-stale' : ''}`} key={panel.id} data-testid={`comic-panel-card-${panel.order}`}>
        <header className="comic-panel-card-head">
          <span className="comic-panel-order">第 {panel.order + 1} 格</span>
          {panel.stale && <span className="comic-panel-stale-tag">旧版（内容已改，图片待重出）</span>}
          {activeIndex >= 0 && (
            <span className="comic-panel-order-actions">
              <button
                type="button"
                className="app-btn app-btn-secondary app-btn-sm"
                disabled={activeIndex === 0}
                aria-label={`第 ${panel.order + 1} 格上移`}
                title="调整分镜顺序只会改变漫画排版顺序，不会重新生成图片"
                onClick={() => props.onPanelMove(panel.id, 'up')}
              >
                上移
              </button>
              <button
                type="button"
                className="app-btn app-btn-secondary app-btn-sm"
                disabled={activeIndex === panels.length - 1}
                aria-label={`第 ${panel.order + 1} 格下移`}
                title="调整分镜顺序只会改变漫画排版顺序，不会重新生成图片"
                onClick={() => props.onPanelMove(panel.id, 'down')}
              >
                下移
              </button>
            </span>
          )}
        </header>
        <dl className="comic-panel-facts">
          {beatTitle && <div><dt>标题</dt><dd>{beatTitle}</dd></div>}
          <div><dt>场景摘要</dt><dd>{panel.scene}</dd></div>
          {panelCharacters.length > 0 && <div><dt>主要角色</dt><dd>{panelCharacters.join('、')}</dd></div>}
          {panel.characterActions.length > 0 && <div><dt>动作</dt><dd>{panel.characterActions.join('、')}</dd></div>}
          {panel.characterExpressions.length > 0 && <div><dt>表情</dt><dd>{panel.characterExpressions.join('、')}</dd></div>}
          {panelDialogues.length > 0 && (
            <div><dt>对白概要</dt><dd className="comic-panel-dialogues">
              {panelDialogues.map(dialogue => (
                <span key={dialogue.id}>
                  {dialogue.type === 'caption' || dialogue.speakerId === 'narrator'
                    ? '旁白：'
                    : `${characters.find(c => c.id === dialogue.speakerId)?.name ?? '？'}：`}
                  {dialogue.text}
                </span>
              ))}
            </dd></div>
          )}
        </dl>

        {/* §38.2 大白话改单格 */}
        <div className="form-group comic-panel-patch">
          <label htmlFor={`panel-patch-${panel.id}`}>只改这一格</label>
          <div className="comic-panel-patch-row">
            <textarea
              id={`panel-patch-${panel.id}`}
              rows={1}
              placeholder="例：第 3 格不要掉水里，改成摔到草地"
              value={patchText[panel.id] ?? ''}
              onChange={e => setPatchText(prev => ({ ...prev, [panel.id]: e.target.value }))}
            />
            <button
              type="button"
              className="app-btn app-btn-secondary app-btn-sm"
              disabled={panelBusy === panel.id}
              onClick={() => void runPatchPanel(panel)}
            >
              {panelBusy === panel.id ? '修改中…' : '改这一格'}
            </button>
          </div>
          {panelError[panel.id] && (
            <div className="comic-inline-error"><p>{panelError[panel.id]}</p></div>
          )}
        </div>

        {/* §38.1 默认不展示最终 Prompt；已应用格折叠可查「生成详情」 */}
        {!showingDraft && panel.compiledPrompt && (
          <details className="comic-advanced-card comic-panel-advanced">
            <summary>高级 · 生成详情</summary>
            <p className="comic-muted">最终 Prompt（冻结的编译产物，重生成前不变）：</p>
            <p className="comic-panel-prompt">{panel.compiledPrompt}</p>
          </details>
        )}
      </div>
    );
  };

  if (!story) {
    // 步骤门禁已保证 story 存在；防御旧数据 / 直达深链
    return (
      <div className="comic-stage">
        <section className="comic-card">
          <h4 className="comic-card-title">分镜草稿</h4>
          <p className="comic-muted">本期故事还没有确认，先回到「本期故事」确认后再生成分镜草稿。</p>
        </section>
      </div>
    );
  }

  // §E/§40 排版网格：按 presentation.pages 逐页画格位网格；每格 = 分镜卡或等待规划占位。
  const multiPage = presentation.pages.length > 1;
  const mappedOrders = new Set(presentation.pages.flatMap(page => page.panelOrders));
  const overflowPanels = listPanels.filter(panel => !mappedOrders.has(panel.order));
  const replanLabel = `重新规划${presentation.name}`;

  const renderPageGrid = (pageIndex: number, panelOrders: number[], columns: number) => (
    <div
      className="comic-storyboard-grid"
      key={`page-${pageIndex}`}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      data-testid="comic-storyboard-grid"
      data-columns={columns}
    >
      {panelOrders.map(order => {
        const panel = listPanels.find(item => item.order === order);
        return panel ? renderPanelCard(panel) : renderPendingCell(order);
      })}
    </div>
  );

  return (
    <div className="comic-stage">
      <section className="comic-card">
        <div className="comic-card-head">
          <h4 className="comic-card-title" data-testid="comic-storyboard-title">
            {showingDraft
              ? `分镜草稿（${draft!.panels.length} 格）`
              : panels.length > 0
                ? `当前分镜（${panels.length} 格）`
                : `当前分镜 · ${presentation.name}`}
          </h4>
          <p className="comic-helper">AI 已把故事「{story.title}」拆成每一格要画什么{plannerPreview ? ` · 规划模型：${plannerPreview}` : ''}</p>
        </div>

        {showingDraft && draft!.repairs.length > 0 && (
          <div className="comic-repair-note">
            <p>已自动修正：{draft!.repairs.join('；')}</p>
          </div>
        )}

        {/* §E 排版直出：分镜卡直接落在最终版式格位上（四宫格 = 2×2） */}
        <div className="comic-storyboard-board" data-testid="comic-storyboard-board">
          {multiPage && <h5 className="comic-storyboard-page-title">第 1 页</h5>}
          {renderPageGrid(0, presentation.pages[0]!.panelOrders, presentation.pages[0]!.columns)}
          {presentation.pages.slice(1).map(page => (
            <div className="comic-storyboard-page" key={page.pageIndex}>
              <h5 className="comic-storyboard-page-title">第 {page.pageIndex + 1} 页</h5>
              {renderPageGrid(page.pageIndex, page.panelOrders, page.columns)}
            </div>
          ))}
          {overflowPanels.length > 0 && (
            <div className="comic-storyboard-page">
              <h5 className="comic-storyboard-page-title">补充格</h5>
              {renderPageGrid(presentation.pages.length, overflowPanels.map(panel => panel.order), presentation.columns)}
            </div>
          )}
        </div>

        <div className="comic-actions-row">
          <button type="button" className="app-btn app-btn-secondary" disabled={busy} data-testid="comic-storyboard-run" onClick={() => void runStoryboard()}>
            {showingDraft || panels.length > 0 ? replanLabel : '生成分镜草稿'}
          </button>
          {showingDraft && (
            <button type="button" className="app-btn app-btn-primary" disabled={busy} onClick={applyDraft}>
              应用分镜，去生成漫画画面
            </button>
          )}
        </div>

        {run && (
          <AIPlanningSurface
            title="AI 正在生成分镜草稿"
            status={run.status}
            startedAt={run.startedAt}
            modelLabel={run.modelLabel}
            errorText={run.errorText}
            onRetry={run.status === 'failed' ? () => void runStoryboard() : undefined}
            retryLabel="重新生成分镜"
            inline
          />
        )}
      </section>
    </div>
  );
}
