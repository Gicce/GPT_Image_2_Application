/**
 * 漫画故事视觉预演（V4.2.8 §30~§36）——「格子本身就是 Beat」的推荐页核心组件：
 *  - 网格（四宫格 / 九宫格 / 双格 / 三格）：每格直接渲染 节拍序号 + 短标题 + 概要，
 *    九宫格面积小 → 紧凑档（序号 + 极短标题，悬浮显示概要）；
 *  - 单格：场景卡（标题 / 概要 / 结尾包袱分隔行），禁止渲染成空白矩形；
 *  - 多页：真实 Page Preview（每页一帧 + 页标签 + 底部「N 页 · 每页 1 格 · 共 N 格」），
 *    不做数据库分页式小方块。
 * 几何同源 resolveConceptPresentation（§89 单点计算）；纯 CSS / DOM，零 Image2、零计费
 * （§37）。与 ComicFormPreviewMini 分工：后者是选择卡 / Rail 的纯几何缩略，本组件承载
 * 节拍内容，推荐结果页 / 创建回顾 / 分镜草稿审读共用。
 */

import type { ComicPresentation } from '../presentation';

/** 预演格内展示的节拍（结构兼容 ComicStoryboardBeat）。 */
export interface ComicStoryPreviewBeat {
  order: number;
  title: string;
  summary: string;
}

export interface ComicStoryPreviewProps {
  presentation: ComicPresentation;
  /** 分镜节拍（格子内容）；缺省退化为纯序号占位 */
  beats?: readonly ComicStoryPreviewBeat[];
  /** 单格场景卡的结尾行（punchline；可空） */
  punchline?: string;
  /** 紧凑档（创建回顾 / 侧栏内嵌） */
  compact?: boolean;
  /** 多页模式最多渲染的页数（超出折叠为 +N 页） */
  maxPages?: number;
}

/** 网格格数 ≥ 该阈值时切紧凑档（格面积小，长文不可读，概要走悬浮）。 */
const DENSE_CELL_THRESHOLD = 6;

export default function ComicStoryPreview(props: ComicStoryPreviewProps) {
  const { presentation, beats = [], punchline, compact = false, maxPages = 4 } = props;
  const isSingle = presentation.arrangement === 'single';
  const isMultiPage = presentation.outputMode === 'multi_page';
  const dense = presentation.totalPanels >= DENSE_CELL_THRESHOLD;
  const beatByOrder = new Map(beats.map(beat => [beat.order, beat]));

  const cellBeat = (order0: number) => beatByOrder.get(order0 + 1);

  const renderCell = (order0: number) => {
    const beat = cellBeat(order0);
    if (!beat) {
      return (
        <span className="comic-story-cell is-empty" key={order0} data-order={order0 + 1}>
          {order0 + 1}
        </span>
      );
    }
    if (dense) {
      // 九宫格档：格内只放 序号 + 极短标题，概要悬浮（§33）
      return (
        <span className="comic-story-cell is-dense" key={order0} data-order={order0 + 1} title={beat.summary || beat.title}>
          <span className="comic-story-cell-order">{order0 + 1}</span>
          <span className="comic-story-cell-title">{beat.title || beat.summary}</span>
        </span>
      );
    }
    return (
      <span className="comic-story-cell" key={order0} data-order={order0 + 1} title={beat.summary || undefined}>
        <span className="comic-story-cell-order">{order0 + 1}</span>
        {beat.title && <span className="comic-story-cell-title">{beat.title}</span>}
        {beat.summary && <span className="comic-story-cell-summary">{beat.summary}</span>}
      </span>
    );
  };

  if (isSingle) {
    // §36 单格场景卡：即使没有真实图片也要读起来像一张漫画草图
    const beat = beats[0];
    return (
      <div
        className={`comic-story-preview is-single${compact ? ' is-compact' : ''}`}
        data-testid="comic-story-preview-single"
        role="img"
        aria-label={`单格场景：${beat?.title || presentation.name}`}
      >
        <span className="comic-story-scene-tag">单格场景</span>
        {beat?.title && <span className="comic-story-scene-title">{beat.title}</span>}
        <span className="comic-story-scene-summary">{beat?.summary || '这一格的画面内容'}</span>
        {punchline && (
          <>
            <span className="comic-story-scene-divider" aria-hidden="true" />
            <span className="comic-story-scene-punchline">结尾：{punchline}</span>
          </>
        )}
      </div>
    );
  }

  const pages = presentation.pages.slice(0, Math.max(1, maxPages));
  const hiddenPages = presentation.pages.length - pages.length;

  return (
    <div
      className={`comic-story-preview${isMultiPage ? ' is-multi' : ''}${compact ? ' is-compact' : ''}`}
      data-testid={`comic-story-preview-${presentation.arrangement}`}
      role="img"
      aria-label={`${presentation.name}故事预演：${presentation.pageCount} 页，共 ${presentation.totalPanels} 格`}
    >
      {pages.map(page => (
        <div
          className="comic-story-page"
          key={page.pageIndex}
          style={{ gridTemplateColumns: `repeat(${page.columns}, 1fr)` }}
          data-page-cells={page.panelOrders.length}
        >
          {isMultiPage && <span className="comic-story-page-tag">第 {page.pageIndex + 1} 页</span>}
          {page.panelOrders.map(renderCell)}
        </div>
      ))}
      {isMultiPage && (
        <span className="comic-story-page-summary" data-testid="comic-story-page-summary">
          {presentation.pageCount} 页 · 每页 {presentation.panelsPerPage} 格 · 共 {presentation.totalPanels} 格
        </span>
      )}
      {hiddenPages > 0 && <span className="comic-story-more">+{hiddenPages} 页</span>}
    </div>
  );
}
