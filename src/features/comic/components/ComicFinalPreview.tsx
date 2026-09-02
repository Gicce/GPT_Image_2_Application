/**
 * 最终页面预览（Phase 1.2 §47/§48）——系列成图后的站内组页预览：
 *  - 布局与选择卡 / 分镜预览同源（computePageLayouts ← resolveComicPresentation，§89）：
 *    四格 2×2、九格 3×3、竖排单列、多页 = 每页一张 page carousel；
 *  - 客户端 canvas 合成（无字底图 + 文字层；缺图画占位框），不重新调用 Image2（§48）；
 *  - 对白 / 分镜成图变化 → 签名驱动重合成；打字草稿等无关更新不触发。
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../../../services/api';
import { activePanels } from '../comicTask';
import { renderComicSheets } from '../comicExport';
import { comicPresentationLabel, resolveComicPresentation } from '../presentation';
import type { ComicProject } from '../types';

export default function ComicFinalPreview(props: { project: ComicProject }) {
  const { project } = props;
  const panels = useMemo(() => activePanels(project), [project]);
  const seriesComplete = panels.length > 0 && panels.every(panel => Boolean(panel.imageAsset));
  const presentation = useMemo(
    () => resolveComicPresentation(project.skillSnapshot, { totalPanels: Math.max(1, panels.length) }),
    [project.skillSnapshot, panels.length],
  );

  // 只对成图与文字层内容变化重合成（uiDraft / 草稿打字等无关更新不触发）。
  // V4.2.14 R6 修复：对白签名必须覆盖全部渲染相关字段（size / bubbleStyle /
  // fontStyle / alignment / tail / stroke / shadow）——此前缺字段导致改字号、
  // 换样式、Resize 后最终页预览保持旧渲染（Inspector 与成品不一致 P0）。
  const signature = useMemo(() => JSON.stringify([
    panels.map(panel => [panel.id, panel.imageAsset?.imageId ?? null, panel.stale ?? false]),
    project.dialogues.map(dialogue => [
      dialogue.id, dialogue.panelId, dialogue.text,
      dialogue.position.x, dialogue.position.y,
      dialogue.size?.width ?? null, dialogue.size?.height ?? null,
      dialogue.bubbleStyle, dialogue.alignment, dialogue.tail ?? null,
      dialogue.fontStyle.size, dialogue.fontStyle.weight,
      dialogue.fontStyle.family ?? null, dialogue.fontStyle.color ?? null,
      dialogue.strokeStyle?.color ?? null, dialogue.strokeStyle?.width ?? null,
      dialogue.shadow ?? null,
    ]),
  ]), [panels, project.dialogues]);

  const [pages, setPages] = useState<string[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!seriesComplete) {
      setPages([]);
      return;
    }
    let alive = true;
    setFailed(false);
    (async () => {
      try {
        const canvases = await renderComicSheets(project, async path => {
          const dataUrl = await api.readImageData(path);
          return await new Promise<HTMLImageElement | null>(resolve => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => resolve(null);
            image.src = dataUrl;
          });
        });
        if (!alive) return;
        setPages(canvases.map(canvas => canvas.toDataURL('image/png')));
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => { alive = false; };
    // signature 已覆盖重合成触发面（项目内容相关字段）
  }, [seriesComplete, signature]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!seriesComplete) return null;
  const current = Math.min(pageIndex, Math.max(0, pages.length - 1));

  return (
    <section className="comic-card comic-final-preview" data-testid="comic-final-preview">
      <div className="comic-card-head">
        <h4 className="comic-card-title">最终页面预览</h4>
        <p className="comic-helper">{comicPresentationLabel(presentation)} · 本地合成预览，不会重新生成图片</p>
      </div>
      {failed && (
        <div className="comic-inline-error"><p>预览合成失败，请检查分镜图片后重试</p></div>
      )}
      {!failed && pages.length === 0 && <p className="comic-muted">正在合成页面预览…</p>}
      {pages.length > 0 && (
        <div className="comic-final-preview-stage">
          <img src={pages[current]!} alt={`第 ${current + 1} 页整页预览`} />
        </div>
      )}
      {pages.length > 1 && (
        <div className="comic-final-preview-nav">
          <button type="button" className="app-btn app-btn-secondary app-btn-sm" disabled={current === 0} onClick={() => setPageIndex(current - 1)}>
            上一页
          </button>
          <span className="comic-muted">第 {current + 1} / {pages.length} 页</span>
          <button type="button" className="app-btn app-btn-secondary app-btn-sm" disabled={current >= pages.length - 1} onClick={() => setPageIndex(current + 1)}>
            下一页
          </button>
        </div>
      )}
    </section>
  );
}
