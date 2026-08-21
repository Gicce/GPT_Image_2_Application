import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useImageStore } from '../store/useImageStore';
import { useTaskStore } from '../store/useTaskStore';
import { useAuthStore } from '../store/useAuthStore';
import { useImageEditStore } from '../store/useImageEditStore';
import { api } from '../services/api';
import { authorizeImageTask, settleImageTask, createRequestId, registerTaskAuthorization } from '../services/billingService';
import { setAsAvatarFromDataUrl } from '../services/avatarService';
import type { ImageRecord, Task } from '../types';
import { dedupeGalleryItems } from '../utils/galleryIdentity';
import { copyText } from '../utils/clipboard';
import { toastError, toastInfo, toastLoading, toastSuccess, toastDismiss, toastUpdate } from '../components/Toast';
import PromptTextBlock from '../components/PromptTextBlock';
import './Gallery.css';

const PAGE_SIZE = 24;
/** 图片执行模型（Rust task_runner 固定使用 CyImagePro 图片服务） */
const IMAGE_EXECUTION_MODEL = 'GPT Image 2';
/** 启动 CY Video Studio 后轮询 Bridge 的间隔 / 最长等待 */
const VIDEO_BRIDGE_POLL_INTERVAL_MS = 500;
const VIDEO_BRIDGE_WAIT_TIMEOUT_MS = 15000;
const VIDEO_NOT_FOUND_PREFIX = 'CY_VIDEO_NOT_FOUND:';
const VIDEO_OFFLINE_PREFIX = 'CY_VIDEO_OFFLINE:';

type GalleryFilter = 'all' | 't2i' | 'i2i' | 'edit_result' | 'batch';
type GallerySort = 'newest' | 'oldest' | 'name';

const FILTER_TABS: { key: GalleryFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 't2i', label: '文生图' },
  { key: 'i2i', label: '图生图' },
  { key: 'edit_result', label: '编辑结果' },
  { key: 'batch', label: '批量结果' },
];

/** 图片卡片 / 详情共用的任务归类 */
function classifyImage(image: ImageRecord, task?: Task): { typeLabel: string; filterKey: GalleryFilter; isLocal: boolean } {
  if (image.source_kind === 'library_input') {
    return { typeLabel: '本地导入', filterKey: 'all', isLocal: true };
  }
  if (!task) return { typeLabel: '生成结果', filterKey: 'all', isLocal: false };
  const isBatch = task.execution_mode === 'batch' || task.count > 1;
  if (task.task_type === 'edit') {
    return { typeLabel: isBatch ? `图生图 · 批量` : '图生图', filterKey: isBatch ? 'batch' : 'i2i', isLocal: false };
  }
  if (task.task_type === 'remove_background') {
    return { typeLabel: '编辑结果（抠图）', filterKey: 'edit_result', isLocal: false };
  }
  return { typeLabel: isBatch ? `文生图 · 批量` : '文生图', filterKey: isBatch ? 'batch' : 't2i', isLocal: false };
}

/** 图片标题：优先方案标题（批量方案任务的 per-image description），回落任务 Prompt 摘要 / 文件名 */
function imageTitle(image: ImageRecord, task?: Task): string {
  const planTitle = image.description?.trim();
  if (planTitle) {
    return planTitle.length > 40 ? `${planTitle.slice(0, 40)}…` : planTitle;
  }
  const prompt = task?.user_prompt_raw || task?.final_prompt || task?.prompt;
  if (prompt && prompt.trim()) {
    const line = prompt.trim().split('\n')[0];
    return line.length > 40 ? `${line.slice(0, 40)}…` : line;
  }
  return image.file_name;
}

/**
 * 图库 → 图片编辑的唯一入口（卡片「编辑」与详情「编辑此图」共用）。
 * 携带图片上下文写入一次性编辑 Store，再导航到图片生成工作台的图生图模式；
 * 用户无需重新上传，退出后 Store 已消费、不污染普通文生图。
 */
function openImageEditor(image: ImageRecord, task?: Task): void {
  if (!image.local_path || image.missing) return;
  useImageEditStore.getState().begin({
    sourcePath: image.local_path,
    fileName: image.file_name,
    sourceImageId: image.id,
    sourceTaskId: task?.id,
    // 原始需求带入新需求输入框作参考（不自动提交、不重新触发 AI 优化）
    prefillRequirement: task?.user_prompt_raw?.trim() || undefined,
  });
  window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'imagestudio' } }));
}

export default function Gallery() {
  const { images, loadImages, deleteImage } = useImageStore();
  const { tasks, loadTasks, createAndExecuteTask } = useTaskStore();
  const [preview, setPreview] = useState<ImageRecord | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<GalleryFilter>('all');
  const [sort, setSort] = useState<GallerySort>('newest');
  const loadingRef = useRef<Set<string>>(new Set());

  useEffect(() => { void loadImages(); }, [loadImages]);
  useEffect(() => { void loadTasks(); }, [loadTasks]);

  const taskById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const task of tasks) map.set(task.id, task);
    return map;
  }, [tasks]);

  const sorted = useMemo(() => {
    const base = [...images];
    base.sort((a, b) => {
      if (sort === 'name') return a.file_name.localeCompare(b.file_name, 'zh-CN');
      const diff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      return sort === 'oldest' ? diff : -diff;
    });
    return dedupeGalleryItems(base);
  }, [images, sort]);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return sorted.filter(image => {
      const task = taskById.get(image.task_id);
      if (filter !== 'all' && classifyImage(image, task).filterKey !== filter) return false;
      if (!keyword) return true;
      const haystack = [
        image.file_name,
        task?.user_prompt_raw,
        task?.final_prompt,
        task?.prompt,
        image.task_id,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(keyword);
    });
  }, [sorted, search, filter, taskById]);

  const visibleImages = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  // 筛选 / 搜索变化时重置分页
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [search, filter, sort]);

  const loadThumb = useCallback(async (img: ImageRecord) => {
    if (img.missing) return;
    if (thumbUrls[img.id] || loadingRef.current.has(img.id)) return;
    loadingRef.current.add(img.id);
    try {
      const url = await api.readThumbnail(img.local_path);
      setThumbUrls(prev => ({ ...prev, [img.id]: url }));
    } catch {
      setThumbUrls(prev => {
        const next = { ...prev };
        delete next[img.id];
        return next;
      });
    }
    loadingRef.current.delete(img.id);
  }, [thumbUrls]);

  useEffect(() => {
    visibleImages.forEach(img => { void loadThumb(img); });
  }, [visibleImages, loadThumb]);

  const handleScroll = useCallback(() => {
    if (!hasMore) return;
    const el = document.querySelector('.main-content');
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) {
      setVisibleCount(prev => prev + PAGE_SIZE);
    }
  }, [hasMore]);

  useEffect(() => {
    const el = document.querySelector('.main-content');
    if (!el) return;
    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  return (
    <div className="page gallery-page">
      <div className="page-header">
        <h2>图片库</h2>
        <p>查看、预览和管理全部生成结果（共 {sorted.length} 张）。</p>
      </div>

      {sorted.length === 0 ? (
        <div className="empty-state">
          <p>暂无图片</p>
          <p className="empty-hint">请先在「设置与更新 → 图片与文件」中配置目录。</p>
        </div>
      ) : (
        <>
          <div className="gallery-toolbar">
            <input
              className="gallery-search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索文件名、需求或任务 ID…"
            />
            <div className="gallery-filter-tabs">
              {FILTER_TABS.map(tab => (
                <button
                  key={tab.key}
                  className={`gallery-filter-tab ${filter === tab.key ? 'active' : ''}`}
                  onClick={() => setFilter(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <select className="gallery-sort" value={sort} onChange={e => setSort(e.target.value as GallerySort)}>
              <option value="newest">最新优先</option>
              <option value="oldest">最旧优先</option>
              <option value="name">按名称</option>
            </select>
            <span className="gallery-count">{filtered.length} 张</span>
          </div>

          {filtered.length === 0 ? (
            <div className="empty-state"><p>没有符合筛选条件的图片</p></div>
          ) : (
            <div className="gallery-grid">
              {visibleImages.map(img => {
                const task = taskById.get(img.task_id);
                const cls = classifyImage(img, task);
                return (
                  <div key={img.id} className={`gallery-item ${img.missing ? 'missing' : ''}`}>
                    <div className="gallery-thumb" onClick={() => !img.missing && setPreview(img)}>
                      {img.missing ? (
                        <div className="gallery-loading">文件已移动或不存在</div>
                      ) : thumbUrls[img.id] ? (
                        <img src={thumbUrls[img.id]} alt={img.file_name} />
                      ) : (
                        <div className="gallery-loading">加载中...</div>
                      )}
                      {!img.missing && (
                        <div className="gallery-thumb-overlay">
                          <button onClick={e => { e.stopPropagation(); setPreview(img); }}>预览</button>
                          <button onClick={e => { e.stopPropagation(); openImageEditor(img, task); }}>编辑</button>
                          <button onClick={e => { e.stopPropagation(); setPreview(img); }}>更多</button>
                        </div>
                      )}
                      {cls.isLocal && <span className="gallery-kind-badge">本地</span>}
                    </div>
                    <div className="gallery-info">
                      <p className="gallery-name" title={imageTitle(img, task)}>{imageTitle(img, task)}</p>
                      <p className="gallery-time">
                        {cls.typeLabel}
                        {!cls.isLocal && task ? ` · ${IMAGE_EXECUTION_MODEL}` : ''}
                        {` · ${new Date(img.created_at).toLocaleDateString('zh-CN')}`}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {hasMore && (
            <div className="load-more">
              <button onClick={() => setVisibleCount(prev => prev + PAGE_SIZE)}>
                加载更多（还剩 {filtered.length - visibleCount} 张）
              </button>
            </div>
          )}
        </>
      )}

      {preview && (
        <PreviewModal
          image={preview}
          task={taskById.get(preview.task_id)}
          onClose={() => setPreview(null)}
          onDeleted={async () => {
            await deleteImage(preview.id);
            setPreview(null);
            void loadImages();
          }}
          onRegenerate={async task => {
            const { isLoggedIn } = useAuthStore.getState();
            let billingRequestId: string | undefined;
            if (isLoggedIn) {
              try {
                billingRequestId = createRequestId('regen');
                await authorizeImageTask(billingRequestId, 1);
              } catch (err: any) {
                toastError(err?.message || '余额不足，请充值后继续使用');
                return;
              }
            }
            try {
              const created = await createAndExecuteTask({
                prompt: task.final_prompt || task.prompt,
                negative_prompt: task.final_negative_prompt || task.negative_prompt,
                user_prompt_raw: task.user_prompt_raw,
                prompt_optimized: task.prompt_optimized,
                prompt_optimization: task.prompt_optimization ?? null,
                size: task.size,
                quality: task.quality,
                output_format: task.output_format,
                count: 1,
                output_dir: task.output_dir,
                task_type: task.task_type as 'generate' | 'edit',
                source_images: task.source_images,
                execution_mode: 'single',
                task_source: 'manual',
              });
              if (billingRequestId) registerTaskAuthorization(created.id, billingRequestId);
              setPreview(null);
              window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'queue' } }));
            } catch (err: any) {
              if (billingRequestId) void settleImageTask(billingRequestId, false, 0, 'regenerate failed');
              toastError(err?.message || '再来一张失败');
            }
          }}
        />
      )}
    </div>
  );
}

function PreviewModal(props: {
  image: ImageRecord;
  task?: Task;
  onClose: () => void;
  onDeleted: () => void;
  onRegenerate: (task: Task) => Promise<void>;
}) {
  const { image, task } = props;
  const [url, setUrl] = useState<string>('');
  const [error, setError] = useState('');
  const [regenerating, setRegenerating] = useState(false);
  const [syncingVideo, setSyncingVideo] = useState(false);
  const [videoInstallHint, setVideoInstallHint] = useState<string | null>(null);
  const [pickingVideoExe, setPickingVideoExe] = useState(false);
  const [settingAvatar, setSettingAvatar] = useState(false);
  const [menuPos, setMenuPos] = useState<{ bottom?: number; top?: number; left: number } | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);
  const menuPanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.readImageData(image.local_path)
      .then(value => { if (!cancelled) setUrl(value); })
      .catch(err => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [image.local_path]);

  // 菜单打开时计算 fixed 定位：优先向上展开，视口内钳位，避免被 overflow 祖先裁切
  useEffect(() => {
    if (!menuPos) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuPanelRef.current?.contains(target) || menuBtnRef.current?.contains(target)) return;
      setMenuPos(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuPos(null); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuPos]);

  const toggleMenu = useCallback(() => {
    setMenuPos(prev => {
      if (prev) return null;
      const rect = menuBtnRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const MENU_WIDTH = 168;
      // 7 个菜单项（含「同步到 Video」「设为当前头像」）的实际高度，供向上展开判断与钳位使用
      const MENU_HEIGHT = 270;
      const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
      const spaceAbove = rect.top;
      if (spaceAbove > MENU_HEIGHT + 16) {
        return { bottom: window.innerHeight - rect.top + 6, left };
      }
      return { top: rect.bottom + 6, left };
    });
  }, []);

  const cls = classifyImage(image, task);
  const originalRequirement = task?.user_prompt_raw || '';
  // 批量方案任务：优先展示该图实际使用的方案级提示词快照（batch_items[i]），而非任务级首条
  const subIndex = task?.sub_tasks.findIndex(st => st.image_id === image.id) ?? -1;
  const batchItem = subIndex >= 0 ? task?.batch_items?.[subIndex] : undefined;
  const fullPrompt = batchItem?.prompt_override?.trim()
    || task?.final_prompt || task?.prompt || task?.user_prompt_raw || '';
  const fullNegative = batchItem?.negative_override?.trim()
    || task?.final_negative_prompt || task?.negative_prompt || '';

  /**
   * 同步到 CY Video Studio：Bridge 在线直接传输；离线自动启动 Video →
   * 轮询等待 Bridge Ready（500ms / 上限 15s）→ 自动继续传输。
   * 单条 loading toast 贯穿全部阶段；syncingVideo 为 in-flight lock，连续点击只执行一次。
   */
  async function syncToVideo() {
    if (syncingVideo) return;
    setSyncingVideo(true);
    let toastId = toastLoading('正在检测 CY Video Studio…');
    try {
      let online = await api.videoBridgeOnline();

      if (!online) {
        // —— 离线：自动启动。未检测到安装位置 → 安装提示 Modal（绝不弹路径选择器；
        //    手动指定安装位置仅作为 Modal 内的高级入口，供已安装但自动发现失效的场景）——
        let launchHandled = false;
        for (let attempt = 0; attempt < 2 && !launchHandled; attempt++) {
          if (attempt === 1) toastId = toastLoading('正在启动 CY Video Studio…');
          try {
            await api.launchVideoStudio();
            launchHandled = true;
          } catch (err: any) {
            const message = String(err?.message || err || '');
            if (message.startsWith(VIDEO_NOT_FOUND_PREFIX) && attempt === 0) {
              toastDismiss(toastId);
              setVideoInstallHint('未检测到 CY Video Studio');
              return;
            }
            toastUpdate(toastId, message || '无法启动 CY Video Studio', 'error');
            return;
          }
        }

        if (launchHandled) {
          toastUpdate(toastId, 'CY Video Studio 已启动，正在连接…');
          const deadline = Date.now() + VIDEO_BRIDGE_WAIT_TIMEOUT_MS;
          while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, VIDEO_BRIDGE_POLL_INTERVAL_MS));
            online = await api.videoBridgeOnline();
            if (online) break;
          }
        }
      }

      if (!online) {
        toastUpdate(toastId, 'CY Video Studio 已启动，但暂时无法连接素材服务。请确认其已完全启动后，重新点击「同步到 Video」重试。', 'error');
        return;
      }

      // —— Bridge Ready：传输素材（V0.4.0：完整创作元数据）——
      toastUpdate(toastId, '正在同步图片素材…');
      const result = await api.syncImageToVideo({
        imageId: image.id,
        taskId: task?.id ?? null,
        filePath: image.local_path,
        fileName: image.file_name,
        prompt: fullPrompt || null,
        width: image.width ?? null,
        height: image.height ?? null,
        createdAt: image.created_at,
        model: task ? 'gpt-image-2' : null,
        // 用户原话 / 优化稿 / 负面词分离同步（Video 端分列入库，绝不混装）
        userPromptRaw: originalRequirement || null,
        finalPrompt: fullPrompt || null,
        finalNegativePrompt: fullNegative || null,
        promptOptimized: Boolean(task?.prompt_optimized)
          || (task != null && !!fullPrompt.trim() && originalRequirement !== fullPrompt),
        displayTitle: imageTitle(image, task).slice(0, 40) || null,
      });
      toastUpdate(
        toastId,
        result.alreadySynced
          ? (result.message || '该素材已存在于 CY Video Studio')
          : '✓ 已同步到 CY Video Studio',
        'success',
      );
    } catch (err: any) {
      const message = String(err?.message || err || '同步失败');
      toastUpdate(
        toastId,
        message.startsWith(VIDEO_OFFLINE_PREFIX)
          ? `${message.slice(VIDEO_OFFLINE_PREFIX.length)}（可重新点击「同步到 Video」重新检测）`
          : message,
        'error',
      );
    } finally {
      setSyncingVideo(false);
    }
  }

  /** 设为当前头像：复用已加载的原图 data URL，经 Avatar Service 裁剪保存独立副本 */
  async function handleSetAvatar() {
    if (!url || settingAvatar) return;
    setSettingAvatar(true);
    try {
      await setAsAvatarFromDataUrl(url);
      toastSuccess('头像设置成功');
    } catch (err) {
      toastError(err instanceof Error ? err.message : '头像设置失败，请重试');
    } finally {
      setSettingAvatar(false);
    }
  }

  /** 高级入口：已安装但自动发现失效时，手动指定 CY Video Studio.exe 并继续同步 */
  async function handlePickVideoExeManually() {
    if (pickingVideoExe) return;
    setPickingVideoExe(true);
    try {
      await api.pickVideoStudioExecutable();
      setVideoInstallHint(null);
      // 保存路径已写入设置，直接重新走完整同步链（launch → bridge ready → 传输）
      await syncToVideo();
    } catch (err: any) {
      const message = String(err?.message || err || '');
      if (message === '已取消选择') return; // 用户关闭选择器：留在提示 Modal
      toastError(message || '选择 CY Video Studio 失败');
    } finally {
      setPickingVideoExe(false);
    }
  }

  const basicRows: { label: string; value: string; copyValue?: string }[] = [
    { label: '文件名', value: image.file_name },
    { label: cls.isLocal ? '来源' : '类型', value: cls.isLocal ? '本地导入' : cls.typeLabel },
    ...(task ? [{ label: '执行模型', value: IMAGE_EXECUTION_MODEL }] : []),
    ...(image.width && image.height ? [{ label: '尺寸', value: `${image.width} × ${image.height}` }] : []),
    { label: '创建时间', value: new Date(image.created_at).toLocaleString('zh-CN') },
    ...(task ? [{ label: '任务 ID', value: task.id, copyValue: task.id }] : []),
  ];

  return (
    <div className="preview-overlay" onClick={props.onClose}>
      <div className="preview-modal gallery-detail-modal" onClick={e => e.stopPropagation()}>
        <div className="preview-header">
          <span title={image.file_name}>{imageTitle(image, task)}</span>
          <button onClick={props.onClose}>×</button>
        </div>
        <div className="gallery-detail-body">
          <div className="preview-body">
            {error ? (
              <div className="gallery-loading">{error}</div>
            ) : url ? (
              <img src={url} alt={image.file_name} />
            ) : (
              <div className="gallery-loading">加载原图中...</div>
            )}
          </div>
          <div className="gallery-detail-side">
            <div className="gallery-detail-scroll">
              <div className="gallery-detail-section-title">基础信息</div>
              <div className="gallery-detail-rows">
                {basicRows.map(row => (
                  <div className="gallery-detail-row" key={row.label}>
                    <span className="gallery-detail-label">{row.label}</span>
                    <span className="gallery-detail-value" title={row.value}>{row.value}</span>
                    {row.copyValue && (
                      <button className="gallery-detail-copy" onClick={() => void copyText(row.copyValue!)}>复制</button>
                    )}
                  </div>
                ))}
              </div>
              {(originalRequirement.trim() || fullPrompt.trim() || fullNegative.trim()) && (
                <div className="gallery-detail-section-title">生成参数</div>
              )}
              <PromptTextBlock title="原始需求" content={originalRequirement} copyToastLabel="原始需求已复制" />
              <PromptTextBlock title="方案" content={image.description || ''} copyToastLabel="方案已复制" />
              <PromptTextBlock title="生成提示词" content={fullPrompt} copyToastLabel="提示词已复制" />
              <PromptTextBlock title="负面提示词" content={fullNegative} copyToastLabel="负面提示词已复制" />
            </div>
            <div className="gallery-detail-actions">
              <button
                disabled={!image.local_path || image.missing}
                onClick={() => {
                  setMenuPos(null);
                  openImageEditor(image, task);
                  props.onClose();
                }}
              >
                编辑此图
              </button>
              <button
                disabled={!task || regenerating}
                onClick={() => {
                  if (!task) return;
                  setRegenerating(true);
                  void props.onRegenerate(task).finally(() => setRegenerating(false));
                }}
              >
                {regenerating ? '提交中…' : '再来一张'}
              </button>
              {task && (
                <button onClick={() => {
                  localStorage.setItem('cy_taskqueue_focus_id', task.id);
                  window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'queue', focusTaskId: task.id } }));
                }}>
                  查看任务
                </button>
              )}
              <div className="gallery-detail-menu-wrap">
                <button ref={menuBtnRef} onClick={toggleMenu}>更多 ▾</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      {menuPos && (
        <div className="gallery-detail-menu" ref={menuPanelRef} style={menuPos}>
          <button onClick={() => { void api.openFile(image.local_path); setMenuPos(null); }}>打开原图</button>
          <button onClick={() => { void api.openFolder(image.local_path); setMenuPos(null); }}>打开所在目录</button>
          <button onClick={() => { void copyText(image.local_path, '复制路径失败，请重试'); setMenuPos(null); }}>复制文件路径</button>
          <button
            disabled={!url || settingAvatar}
            onClick={() => { setMenuPos(null); void handleSetAvatar(); }}
          >
            {settingAvatar ? '设置中…' : '设为当前头像'}
          </button>
          {fullPrompt.trim() && (
            <button onClick={() => { void copyText(fullPrompt, '复制提示词失败，请重试'); setMenuPos(null); }}>复制提示词</button>
          )}
          <button
            disabled={!image.local_path || image.missing}
            onClick={() => {
              setMenuPos(null);
              // 视觉理解入口：带原图路径进入 /vision 页（一次消费的 localStorage 传递，不复制文件）
              localStorage.setItem('cy_vision_source_path', image.local_path);
              window.dispatchEvent(new CustomEvent('cyimage-navigate', { detail: { page: 'vision' } }));
            }}
          >
            视觉理解 / 提取 Prompt
          </button>
          <button
            disabled={syncingVideo || !image.local_path || image.missing}
            onClick={() => { setMenuPos(null); void syncToVideo(); }}
          >
            <svg className="gallery-menu-video-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <rect x="1.5" y="3.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M10.5 6.5 14 4.5v7l-3.5-2z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
            {syncingVideo ? '同步中…' : '同步到 Video'}
          </button>
          <button
            className="danger"
            onClick={() => {
              setMenuPos(null);
              if (window.confirm(`确认删除图片「${image.file_name}」？文件将从磁盘移除。`)) {
                void props.onDeleted();
              }
            }}
          >
            删除图片
          </button>
        </div>
      )}
      {videoInstallHint && (
        <div className="preview-overlay gallery-video-install-overlay" onClick={() => setVideoInstallHint(null)}>
          <div className="gallery-video-install-modal" onClick={e => e.stopPropagation()}>
            <h3>未检测到 CY Video Studio</h3>
            <p className="gallery-video-install-text">
              安装 CY Video Studio 后，可以将当前素材直接发送到 Video 项目继续创作。
            </p>
            <p className="gallery-video-install-hint">
              请先安装 CY Video Studio 后重试。如已安装但未能自动识别，可手动指定安装位置。
            </p>
            <div className="gallery-video-install-actions">
              <button className="secondary" onClick={() => setVideoInstallHint(null)}>取消</button>
              <button
                className="primary"
                disabled={pickingVideoExe}
                onClick={() => { void handlePickVideoExeManually(); }}
              >
                {pickingVideoExe ? '选择中…' : '手动选择安装位置…'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
