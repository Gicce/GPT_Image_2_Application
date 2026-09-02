/**
 * 生成阶段（V4.2.11 §F 重构）——按展示形式编排的 UI 面：
 *  1. 默认（未开启暂停确认）：一个主 CTA「生成漫画画面（N 格）」一次性提交全部
 *     分镜任务（既有批量引擎逐槽执行 / 失败隔离）；一致性由角色参考图 + 风格约束
 *     承担。内部锚点（anchor）/ 系列（series）机制不再构成用户步骤。
 *  2. 高级「生成第一格后暂停确认」（默认关）：恢复两段节奏——
 *     生成视觉基准 → 确认 → 生成剩余 N-1 格（内部仍为 Anchor 锁定链路）。
 *  3. 画面渐进填充：comic-panel-grid 是紧凑预览卡网格（桌面 2 列 / 窄屏 1 列，
 *     主图限高），与最终页排版几何解耦——最终页几何由 ComicFinalPreview 与导出
 *     同构呈现（竖版形式不再把预览卡撑成全宽巨型方块）；逐格显示 排队中 / 生成中 /
 *     已生成 / 失败；单格 [重试]/[重新生成] = batch-of-1 只重出这一格（§44：一格
 *     图内不得再出现四宫格——Prompt 编译层强制单格画面铁律）。
 *  4. 组合漫画页面（§F/§47）：整页合成只在「对白与字幕 → 导出整页 PNG」显式
 *     触发（零 Image2 调用）；ComicFinalPreview 预览与导出同构。
 * 提交 / 计费 / 终态回写都在页面层（单一入口，本组件只发意图）。
 */

import { useMemo } from 'react';
import { useComicPanelThumbs } from './useComicThumbs';
import ComicFinalPreview from './ComicFinalPreview';
import { activePanels } from '../comicTask';
import { resolveComicPresentation } from '../presentation';
import type { ComicProject } from '../types';

export interface ComicGenerateStageProps {
  project: ComicProject;
  /** 系列生成门禁阻塞项（flow 查表）。 */
  seriesBlockers: string[];
  /** 本项目是否有进行中的分镜成图任务（防重复提交）。 */
  taskRunning: boolean;
  /** 高级「生成第一格后暂停确认」（默认 false）。 */
  pauseAfterFirstPanel: boolean;
  onTogglePauseAfterFirstPanel: (enabled: boolean) => void;
  onGenerateAnchor: () => void;
  onRegenerateAnchor: () => void;
  onLockAnchor: () => void;
  onGenerateSeries: () => void;
  onRegeneratePanel: (panelId: string) => void;
}

const STATUS_LABELS: Record<string, string> = {
  pending: '待生成',
  queued: '排队中',
  running: '生成中',
  completed: '已生成',
  failed: '失败',
};

export default function ComicGenerateStage(props: ComicGenerateStageProps) {
  const { project } = props;
  const panels = useMemo(() => activePanels(project), [project]);
  const thumbs = useComicPanelThumbs(panels);
  const anchor = project.consistency?.anchor;
  const anchorPanel = panels.find(panel => panel.id === anchor?.panelId)
    ?? panels.find(panel => panel.generationStatus === 'completed' && panel.imageAsset)
    ?? panels[0];
  const anchorPendingReview = !anchor && anchorPanel?.generationStatus === 'completed' && Boolean(anchorPanel.imageAsset);
  const seriesReady = props.seriesBlockers.length === 0;
  const characters = project.characterSnapshots.filter(character =>
    Object.values(project.characterBindings).includes(character.id));
  const presentation = useMemo(
    () => resolveComicPresentation(project.skillSnapshot, { totalPanels: Math.max(1, panels.length) }),
    [project.skillSnapshot, panels.length],
  );
  const multiPage = presentation.outputMode === 'multi_page';
  const panelTag = (order: number) => (multiPage ? `第 ${order + 1} 页` : `第 ${order + 1} 格`);
  const unit = multiPage ? '张' : '格';
  const completedCount = panels.filter(panel => panel.imageAsset).length;
  const remainingCount = panels.filter(panel => !(anchor?.panelId === panel.id && panel.imageAsset)).length;
  const anchorCharacters = (anchorPanel?.characterIds ?? [])
    .map(id => characters.find(character => character.id === id))
    .filter((character): character is NonNullable<typeof character> => character !== undefined);
  const allDone = panels.length > 0 && completedCount === panels.length;

  return (
    <div className="comic-stage">
      {/* 高级模式（默认关）：恢复两段节奏——生成视觉基准 → 生成剩余 → 组合页面 */}
      {props.pauseAfterFirstPanel && (
        <section className="comic-card">
          <div className="comic-card-head">
            <h4 className="comic-card-title">生成视觉基准</h4>
            <p className="comic-helper">高级模式已开启：先生成第一格并确认，再生成剩余画面，最后组合漫画页面。</p>
          </div>
          {anchorPanel && (
            <div className="comic-anchor-row">
              <div className="comic-anchor-figure">
                {thumbs[anchorPanel.id]
                  ? <img src={thumbs[anchorPanel.id]} alt={panelTag(anchorPanel.order)} />
                  : <span className="comic-ref-placeholder">{anchorPanel.generationStatus === 'running' || anchorPanel.generationStatus === 'queued' ? '生成中…' : '尚未生成'}</span>}
                {anchor && <span className="comic-badge comic-badge-locked">基准已确认</span>}
              </div>
              <div className="comic-anchor-info">
                <dl className="comic-anchor-facts">
                  <div><dt>使用角色</dt><dd>{anchorCharacters.length ? anchorCharacters.map(character => character.name).join('、') : '—'}</dd></div>
                  <div><dt>视觉风格</dt><dd>{project.skillSnapshot.visualStyle || '—'}</dd></div>
                  <div><dt>画面内容</dt><dd>{panelTag(anchorPanel.order)} · {anchorPanel.scene}</dd></div>
                  <div><dt>参考图</dt><dd className="comic-anchor-refs">
                    {anchorCharacters.length === 0 && <span>无出场角色</span>}
                    {anchorCharacters.map(character => (
                      <span key={character.id} className="comic-ref-chip">
                        {character.name}{character.referenceImage ? ' · 参考图已备' : ' · 无参考图'}
                      </span>
                    ))}
                  </dd></div>
                  <div><dt>任务状态</dt><dd>{STATUS_LABELS[anchorPanel.generationStatus] ?? '待生成'}{props.taskRunning ? ' · 任务进行中' : ''}</dd></div>
                </dl>
                <div className="comic-actions-row">
                  {!anchor && !anchorPendingReview && (
                    <button
                      type="button"
                      className="app-btn app-btn-primary app-btn-sm"
                      disabled={props.taskRunning}
                      onClick={props.onGenerateAnchor}
                    >
                      {props.taskRunning ? '任务进行中…' : '生成视觉基准'}
                    </button>
                  )}
                  {anchorPendingReview && (
                    <>
                      <button type="button" className="app-btn app-btn-primary app-btn-sm" onClick={props.onLockAnchor}>
                        确认这个效果
                      </button>
                      <button type="button" className="app-btn app-btn-secondary app-btn-sm" disabled={props.taskRunning} onClick={props.onRegenerateAnchor}>
                        重新生成
                      </button>
                    </>
                  )}
                  {anchor && (
                    <span className="comic-muted">
                      已确认于 {new Date(anchor.lockedAt).toLocaleString()}；剩余画面与单格重新生成都继承这张的画风
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="comic-card">
        <div className="comic-card-head">
          <h4 className="comic-card-title">{multiPage ? '生成漫画页面' : '生成漫画画面'}</h4>
          <p className="comic-helper">
            {props.pauseAfterFirstPanel
              ? `基准确认后按分镜逐${unit}生成，全部完成后进入「对白与字幕」导出整页。`
              : `一次性按分镜生成全部 ${panels.length} ${unit}画面，逐${unit}填入下方排版；整页在「对白与字幕 → 导出整页 PNG」时合成。`}
          </p>
        </div>

        {/* 高级开关：生成第一格后暂停确认（默认关） */}
        <details className="comic-advanced-card comic-pause-toggle">
          <summary>高级 · 节奏控制</summary>
          <label className="comic-pause-toggle-row">
            <input
              type="checkbox"
              checked={props.pauseAfterFirstPanel}
              onChange={e => props.onTogglePauseAfterFirstPanel(e.target.checked)}
            />
            <span>生成第一格后暂停确认（先审定第一格画风，再生成剩余画面）</span>
          </label>
        </details>

        {props.seriesBlockers.length > 0 && (
          <div className="comic-blockers">
            {props.seriesBlockers.map(blocker => <p key={blocker}>· {blocker}</p>)}
          </div>
        )}
        <p className="comic-series-progress" data-testid="comic-series-progress">
          已生成 {completedCount} / {panels.length} {unit}
          {panels.some(panel => panel.generationStatus === 'failed') && ' · 有失败格，只重试失败的那几格'}
          {allDone && ' · 画面已齐，可进入「对白与字幕」'}
        </p>
        {/* 紧凑预览卡网格（V4.2.13 残留修复）：列数由 CSS 响应式决定（桌面 2 列 /
            窄屏 1 列），不再内联 presentation.columns——竖版形式（columns=1）此前
            把预览卡撑成全宽巨型方块，页面被撑爆。最终页几何看 ComicFinalPreview。 */}
        <div
          className="comic-panel-grid"
          data-testid="comic-generate-grid"
        >
          {panels.map(panel => (
            <div className={`comic-panel-cell comic-panel-${panel.generationStatus}`} key={panel.id}>
              <div className="comic-panel-figure">
                {thumbs[panel.id]
                  ? <img src={thumbs[panel.id]} alt={panelTag(panel.order)} />
                  : <span className="comic-ref-placeholder">{STATUS_LABELS[panel.generationStatus] ?? '待生成'}</span>}
                <span className="comic-panel-order-badge">{panelTag(panel.order)}</span>
                {anchor?.panelId === panel.id && <span className="comic-badge comic-badge-locked">基准</span>}
              </div>
              <p className="comic-panel-scene">{panel.scene}</p>
              <div className="comic-panel-foot">
                <span className={`comic-status comic-status-${panel.generationStatus}`}>{STATUS_LABELS[panel.generationStatus] ?? '待生成'}</span>
                {panel.generationStatus !== 'running' && panel.generationStatus !== 'queued' && panel.id !== anchor?.panelId && (
                  <button
                    type="button"
                    className="app-btn app-btn-secondary app-btn-sm"
                    disabled={props.taskRunning}
                    title={panel.generationStatus === 'completed' ? '对此格重新生成（继承画风）' : '只重试这一格'}
                    onClick={() => props.onRegeneratePanel(panel.id)}
                  >
                    {panel.generationStatus === 'failed' ? '重试' : '重新生成'}
                  </button>
                )}
              </div>
              {panel.generationStatus === 'failed' && (
                <p className="comic-panel-error">失败原因：{panel.lastError || '生成失败，可重试这一格'}</p>
              )}
            </div>
          ))}
        </div>
        <div className="comic-actions-row">
          <button
            type="button"
            className="app-btn app-btn-primary"
            disabled={!seriesReady || props.taskRunning}
            title={!seriesReady ? props.seriesBlockers.join('；') : undefined}
            onClick={props.onGenerateSeries}
            data-testid="comic-generate-submit"
          >
            {props.taskRunning
              ? '任务进行中…'
              : props.pauseAfterFirstPanel
                ? `生成剩余${multiPage ? '页面' : '画面'}（${remainingCount} ${unit}）`
                : `${multiPage ? '生成漫画页面' : '生成漫画画面'}（${remainingCount} ${unit}）`}
          </button>
        </div>
      </section>

      <ComicFinalPreview project={project} />
    </div>
  );
}
