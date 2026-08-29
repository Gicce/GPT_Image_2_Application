/**
 * ProjectPreviewPanel（V6.4）——视觉项目的原图、理解摘要与主要入口集中预览。
 *
 * 组件只负责展示与转发事件；更换图片、移除、重新视觉理解仍调用页面既有逻辑。
 * 折叠由 useVisionViewStore 驱动，绝不写项目 revision。
 */

interface ProjectPreviewPanelProps {
  sourcePath: string;
  previewUrl: string;
  sourceLabel: string;
  imageMeta: string;
  projectName: string;
  projectStatus: string;
  analysisSummary?: string;
  analysisMeta?: string;
  visionModelLabel: string;
  collapsed: boolean;
  analyzing: boolean;
  canAnalyze: boolean;
  onToggleCollapsed: () => void;
  onOpenViewer: () => void;
  onPickLocal: () => void;
  onPickGallery: () => void;
  onOpenFolder: () => void;
  onRemove: () => void;
  onReanalyze: () => void;
  onToggleAnalysisDetail: () => void;
}

export default function ProjectPreviewPanel(props: ProjectPreviewPanelProps) {
  const hasSource = Boolean(props.sourcePath);
  return (
    <section className="vision-card vision-project-preview" data-testid="vision-project-preview">
      <header className="vision-subpanel-head">
        <div>
          <span className="vision-subpanel-title">项目预览</span>
          <p>{hasSource ? `${props.projectName} · ${props.projectStatus}` : '选择一张图片开始视觉理解'}</p>
        </div>
        <button
          type="button"
          className="app-btn app-btn-secondary app-btn-sm"
          aria-expanded={!props.collapsed}
          onClick={props.onToggleCollapsed}
        >
          {props.collapsed ? '展开' : '收起'}
        </button>
      </header>

      {!props.collapsed && (hasSource ? (
        <div className="vision-project-preview-body">
          <button
            type="button"
            className="vision-project-preview-image"
            title="点击在内置图片查看器中查看"
            onClick={props.onOpenViewer}
          >
            {props.previewUrl
              ? <img src={props.previewUrl} alt="画面模板" />
              : <span>图片加载中…</span>}
          </button>
          <div className="vision-project-preview-content">
            <dl className="vision-project-preview-facts">
              <div><dt>图片</dt><dd>{props.imageMeta || '读取元信息中…'} · {props.sourceLabel}</dd></div>
              <div><dt>视觉模型</dt><dd>{props.visionModelLabel || '—'}</dd></div>
              <div><dt>理解结果</dt><dd>{props.analysisSummary || '尚未进行视觉理解'}</dd></div>
              {props.analysisMeta && <div><dt>模板结构</dt><dd>{props.analysisMeta}</dd></div>}
            </dl>
            <div className="vision-project-preview-actions">
              <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={props.onPickGallery}>更换图片</button>
              <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={props.onOpenFolder}>打开所在目录</button>
              <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={props.onRemove}>移除图片</button>
              {props.analysisSummary && (
                <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={props.onToggleAnalysisDetail}>查看详细分析</button>
              )}
              <button
                type="button"
                className="app-btn app-btn-brand-soft app-btn-sm"
                disabled={!props.canAnalyze || props.analyzing}
                onClick={props.onReanalyze}
              >
                {props.analyzing ? '正在视觉理解…' : props.analysisSummary ? '重新视觉理解' : '开始视觉理解'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="vision-dropzone">
          <p className="vision-dropzone-title">拖入图片，或选择来源</p>
          <div className="vision-dropzone-actions">
            <button type="button" className="app-btn app-btn-primary" onClick={props.onPickLocal}>本地选择</button>
            <button type="button" className="app-btn app-btn-secondary" onClick={props.onPickGallery}>从图片库选择</button>
          </div>
          <p className="vision-hint">支持 PNG / JPEG / WebP；图片会直接发送给已配置的视觉模型服务。</p>
        </div>
      ))}
    </section>
  );
}
