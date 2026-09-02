/**
 * 漫画形式选择卡统一 Mini Preview 画布（V4.2.9，docs/ai-comic/17 §1.3）——
 * 「AI 自动」卡示意位（72×96）与全部真实模板卡共用同一固定 viewport，
 * 只有内部 geometry 随 presentation 变化（resolveConceptPresentation 单点派生，
 * 禁止每种形式自己一套尺寸）：
 *  - 单页形式：画布内一页框（60×80，3:4）+ 格子网格（columns × rows）；
 *  - 多页连载：画布内两张重叠页（前页 + 右下偏移后页）+「+N 页」角标 ——
 *    一眼可读「这是多页，不是九宫格」；页数细节由卡正文
 *    （comicPresentationTemplateShortLabel：4 页 · 每页 1 张）承载，
 *    preview 内不渲染「第 N 页」文字标签（审计 17 根因 B/C 的修复）。
 * 纯 CSS 零 Image2 / 零计费（V4.2.7 §九约束继续成立）。
 */

import type { ComicPresentation } from '../presentation';

export interface ComicFormPreviewMiniProps {
  presentation: ComicPresentation;
}

export default function ComicFormPreviewMini({ presentation }: ComicFormPreviewMiniProps) {
  const isMultiPage = presentation.outputMode === 'multi_page' && presentation.pageCount > 1;

  if (isMultiPage) {
    const hiddenPages = presentation.pageCount - 1;
    return (
      <div
        className="comic-form-preview-mini is-multi"
        role="img"
        aria-label={`${presentation.name}示意：${presentation.pageCount} 页 · 每页 1 张`}
        data-testid="comic-form-preview-multi"
      >
        {/* 后页（右下偏移、半透明）与前页重叠：多页结构的视觉语言 */}
        <span className="comic-form-preview-page is-back" aria-hidden="true" />
        <span className="comic-form-preview-page is-front">
          <span className="comic-form-preview-cell">1</span>
        </span>
        <span className="comic-form-preview-pages">+{hiddenPages} 页</span>
      </div>
    );
  }

  const page = presentation.pages[0];
  const columns = Math.max(1, page?.columns ?? 1);
  const cells = Math.max(1, page?.panelOrders.length ?? 1);
  return (
    <div
      className="comic-form-preview-mini"
      role="img"
      aria-label={`${presentation.name}示意：1 页 · ${cells} 格`}
      data-testid={`comic-form-preview-${presentation.arrangement}`}
    >
      <span
        className="comic-form-preview-page is-front"
        style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
      >
        {Array.from({ length: cells }, (_, index) => (
          <span className="comic-form-preview-cell" key={index}>{index + 1}</span>
        ))}
      </span>
    </div>
  );
}
