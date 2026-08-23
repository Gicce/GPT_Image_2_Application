/**
 * 图片库拖拽导入控制器（V4.1 Gallery Drag Import）—— 纯逻辑层，无 React / 无 Tauri 依赖。
 *
 * 职责边界（与 hooks/useGalleryFileDrop.ts 分工）：
 * - 本模块：drag 状态机（enter / over / leave / drop）、合法图片分流、
 *   processing 防重入、导入结果 → 文案（copy 唯一来源）。
 * - Hook：把 Tauri onDragDropEvent 事件翻译成 handleEvent、注入 api 与 Toast。
 *
 * 铁律：导入只调用注入的 importImages（= Rust import_images_to_library，
 * 复用 sync_images 唯一入库链路）；本模块绝不写 source_kind / 绝不造索引。
 */

import { splitDroppedPaths, fileNameOfPath } from '../../utils/imageDropFiles';
import type { ImageRecord, ImportImagesToLibraryResult } from '../../types';

export interface GalleryFileDropState {
  /** 文件正悬停在窗口上（Gallery 页激活时整个主内容区显示 Overlay）。 */
  active: boolean;
  /** 本次拖入的文件总数（enter 事件携带的 paths 数）。 */
  fileCount: number;
  /** 合法图片数（PNG / JPG / JPEG / WebP）。 */
  acceptedCount: number;
  /** 不支持文件数。 */
  rejectedCount: number;
  /** 一次导入进行中（此时重复 drop 整体忽略）。 */
  processing: boolean;
}

export const GALLERY_FILE_DROP_INITIAL_STATE: GalleryFileDropState = {
  active: false,
  fileCount: 0,
  acceptedCount: 0,
  rejectedCount: 0,
  processing: false,
};

export type GalleryFileDropEvent =
  | { type: 'enter'; paths: string[] }
  | { type: 'over' }
  | { type: 'leave' }
  | { type: 'drop'; paths: string[] };

export interface GalleryDropOverlayCopy {
  /** 主标题（含数量或「没有可导入的图片」）。 */
  title: string;
  /** 说明行。 */
  hint: string;
  /** 支持格式行。 */
  formats: string;
  /** 混合拖入提示（「N 个文件不支持」）；纯合法拖入为空。 */
  warning: string;
}

export const GALLERY_DROP_FORMATS_TEXT = 'PNG · JPG · JPEG · WebP';
const GALLERY_DROP_HINT_TEXT = '图片将保存到 CyImagePro 图片库';

/** Overlay 文案唯一来源（禁止组件随手拼中文）。 */
export function galleryDropOverlayCopy(state: GalleryFileDropState): GalleryDropOverlayCopy {
  if (state.acceptedCount === 0) {
    return {
      title: '没有可导入的图片',
      hint: '仅支持 PNG、JPG、JPEG、WebP 图片',
      formats: GALLERY_DROP_FORMATS_TEXT,
      warning: '',
    };
  }
  const warning =
    state.rejectedCount > 0 ? `${state.rejectedCount} 个文件不支持` : '';
  if (state.rejectedCount > 0) {
    return {
      title: `可导入 ${state.acceptedCount} 张图片`,
      hint: GALLERY_DROP_HINT_TEXT,
      formats: GALLERY_DROP_FORMATS_TEXT,
      warning,
    };
  }
  return {
    title:
      state.acceptedCount === 1
        ? '释放即可导入图片'
        : `释放即可导入 ${state.acceptedCount} 张图片`,
    hint: GALLERY_DROP_HINT_TEXT,
    formats: GALLERY_DROP_FORMATS_TEXT,
    warning: '',
  };
}

export interface GalleryImportToastCopy {
  /** 主提示（loading 之后更新到的终态文案）。 */
  text: string;
  /** success = 全部成功或部分成功；error = 一张都没进。 */
  kind: 'success' | 'error';
}

/** 导入结果 → Toast 文案（copy 唯一来源）。 */
export function describeImportResult(
  result: Pick<ImportImagesToLibraryResult, 'imported' | 'skipped' | 'failed'>,
): { main: GalleryImportToastCopy; failureDetail: string | null } | null {
  const imported = result.imported.length;
  const skipped = result.skipped.length;
  const failed = result.failed.length;
  if (imported === 0 && skipped === 0 && failed === 0) return null;

  if (imported === 0 && skipped === 0) {
    return { main: { text: '没有可导入的图片', kind: 'error' }, failureDetail: null };
  }

  let text: string;
  if (failed === 0 && skipped === 0) {
    text = `已导入 ${imported} 张图片`;
  } else if (failed === 0) {
    text = `已导入 ${imported} 张图片，${skipped} 张已在图片库中`;
  } else if (skipped === 0) {
    text = `已导入 ${imported} 张，${failed} 张失败`;
  } else {
    text = `已导入 ${imported} 张，${skipped} 张已在图片库中，${failed} 张失败`;
  }
  const failureDetail =
    failed > 0
      ? result.failed.map(f => `${fileNameOfPath(f.path)}：${f.reason}`).join('；')
      : null;
  return { main: { text, kind: failed > 0 ? 'error' : 'success' }, failureDetail };
}

export interface GalleryFileDropConfig {
  /** 唯一导入通道（Rust import_images_to_library）。 */
  importImages: (paths: string[]) => Promise<ImportImagesToLibraryResult>;
  /** 导入开始（返回 Toast 句柄，供结束时更新同一条）。 */
  onImportStart?: (acceptedCount: number) => unknown;
  /** 导入结束：结果文案 + 重扫后的全量图库（空数组 = 未触发重扫）。 */
  onImportFinish?: (payload: {
    toastHandle: unknown;
    summary: ReturnType<typeof describeImportResult>;
    images: ImageRecord[];
  }) => void;
  /** 导入异常。 */
  onImportError?: (payload: { toastHandle: unknown; message: string }) => void;
  /** 松手但没有任何合法图片。 */
  onEmptyDrop?: () => void;
}

export interface GalleryFileDropController {
  getState: () => GalleryFileDropState;
  subscribe: (listener: () => void) => () => void;
  handleEvent: (event: GalleryFileDropEvent) => Promise<void>;
  /** 取消当前拖拽态（Modal 打开 / 页面失活时调用）。 */
  reset: () => void;
}

export function createGalleryFileDropController(
  config: GalleryFileDropConfig,
): GalleryFileDropController {
  let state = GALLERY_FILE_DROP_INITIAL_STATE;
  const listeners = new Set<() => void>();

  function setState(patch: Partial<GalleryFileDropState>): void {
    state = { ...state, ...patch };
    listeners.forEach(l => l());
  }

  async function handleEvent(event: GalleryFileDropEvent): Promise<void> {
    if (event.type === 'enter' || event.type === 'over') {
      // enter 携带 paths；over 只带位置，已激活则保持（Tauri 窗口级事件
      // 不经过子元素，天然无 dragenter/dragleave 闪烁问题）
      if (state.processing) return;
      if (event.type === 'over') {
        return;
      }
      const paths = event.paths || [];
      if (paths.length === 0) return;
      const { images, invalid } = splitDroppedPaths(paths);
      setState({
        active: true,
        fileCount: paths.length,
        acceptedCount: images.length,
        rejectedCount: invalid.length,
      });
      return;
    }
    if (event.type === 'leave') {
      setState({ active: false });
      return;
    }
    // drop：一次用户松手 = 一次导入；processing 中整体忽略
    if (state.processing) return;
    setState({ active: false });
    const { images } = splitDroppedPaths(event.paths || []);
    if (images.length === 0) {
      config.onEmptyDrop?.();
      return;
    }
    const paths = images.map(f => f.path);
    const toastHandle = config.onImportStart?.(images.length);
    setState({ processing: true });
    try {
      const result = await config.importImages(paths);
      setState({ processing: false });
      config.onImportFinish?.({
        toastHandle,
        summary: describeImportResult(result),
        images: result.images ?? [],
      });
    } catch (err) {
      setState({ processing: false });
      config.onImportError?.({
        toastHandle,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    getState: () => state,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    handleEvent,
    reset: () => setState({ active: false, fileCount: 0, acceptedCount: 0, rejectedCount: 0 }),
  };
}
