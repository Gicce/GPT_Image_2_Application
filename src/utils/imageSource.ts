/**
 * Image Source Provenance（图片来源唯一 resolver）：
 * 图库资产「从哪来」必须真实可信，禁止 source 缺失 / 目录误判时一律回退「本地」。
 *
 * 优先级（高 → 低）：
 *   1. 关联任务（task_id 指向真实生成任务）→ 继承任务来源（动作白膜 > 视觉复刻 > 批量 > 任务类型）
 *   2. 任务关联存在但任务记录缺失（含 chat 会话保存）→ 生成资产（按 source_kind 细分）
 *   3. 无任务关联 + source_kind=library_input → 本地导入（用户手动放进本地目录）
 *   4. 无任务关联 + 其余 source_kind → 输出目录扫描的生成结果
 *
 * 「本地」只允许出现在 3：用户主动导入 / 拖入 / 复制进图库本地目录的文件。
 * Rust 端 classify_source_kind 按目录前缀判定，历史上曾把输出目录里的任务产出
 * 误覆写成 library_input —— 读取时任务关联优先级更高，旧资产在展示层即可恢复真实来源。
 */

import type { ImageRecord, Task } from '../types';

export type ImageSourceKind =
  | 'local_import'
  | 'text_to_image'
  | 'image_to_image'
  | 'image_edit'
  | 'batch_generation'
  | 'visual_recreation'
  | 'video_pose'
  | 'generated';

export type GallerySourceFilter = 'all' | 't2i' | 'i2i' | 'edit_result' | 'batch' | 'vision' | 'video';

export interface ImageSourceInfo {
  kind: ImageSourceKind;
  /** 中文来源词（copy.md 来源表固定，禁止同义词漂移）。 */
  label: string;
  /** 图库来源筛选桶。 */
  filterKey: GallerySourceFilter;
  /** 本地导入资产（卡片角标「本地」）。 */
  isLocal: boolean;
  /** 来源应用徽标文案（如 CY Video Studio）；本地图库生成资产为空。 */
  sourceApp?: string;
}

export const IMAGE_SOURCE_LABELS: Record<ImageSourceKind, string> = {
  local_import: '本地',
  text_to_image: '文生图',
  image_to_image: '图生图',
  image_edit: '编辑结果',
  batch_generation: '批量结果',
  visual_recreation: '视觉复刻',
  video_pose: '动作白膜',
  generated: '生成结果',
};

const KIND_FILTER: Record<ImageSourceKind, GallerySourceFilter> = {
  local_import: 'all',
  text_to_image: 't2i',
  image_to_image: 'i2i',
  image_edit: 'edit_result',
  batch_generation: 'batch',
  visual_recreation: 'vision',
  video_pose: 'video',
  generated: 'all',
};

export const IMAGE_SOURCE_FILTER_TABS: { key: GallerySourceFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 't2i', label: '文生图' },
  { key: 'i2i', label: '图生图' },
  { key: 'edit_result', label: '编辑结果' },
  { key: 'batch', label: '批量结果' },
  { key: 'vision', label: '视觉复刻' },
  { key: 'video', label: 'CY Video' },
];

function infoOf(kind: ImageSourceKind): ImageSourceInfo {
  return { kind, label: IMAGE_SOURCE_LABELS[kind], filterKey: KIND_FILTER[kind], isLocal: kind === 'local_import' };
}

/** 动作白膜（CY Video Studio Pose Batch）：标签带动作名，卡片角标为来源应用。 */
function videoPoseInfo(task: Task): ImageSourceInfo {
  const actionName = task.pose_batch?.action_name?.trim();
  return {
    kind: 'video_pose',
    label: actionName ? `动作白膜 · ${actionName}` : IMAGE_SOURCE_LABELS.video_pose,
    filterKey: 'video',
    isLocal: false,
    sourceApp: 'CY Video Studio',
  };
}

function isBatchTask(task: Task): boolean {
  return task.execution_mode === 'batch' || (task.count ?? 1) > 1;
}

/**
 * 解析图库资产真实来源。
 * @param image  图库记录（task_id / source_kind）
 * @param task   image.task_id 对应的任务（调用方已查好时可直传）
 * @param taskById 任务索引（用于查关联任务与视觉理解上游任务；不传则只按入参判定）
 */
export function resolveImageSource(
  image: Pick<ImageRecord, 'task_id' | 'source_kind'>,
  task?: Task,
  taskById?: Map<string, Task> | null,
): ImageSourceInfo {
  const hasTaskLink = Boolean(image.task_id) && image.task_id !== 'library';
  const linked = task ?? (hasTaskLink ? taskById?.get(image.task_id!) : undefined);

  if (hasTaskLink) {
    if (linked) {
      // 动作白膜（CY Video Studio Pose Batch）：调用方来源最具体，优先于批量 / 任务类型细分
      if (linked.pose_batch) return videoPoseInfo(linked);
      // 视觉复刻：生成任务的 source_task_id 指向 vision_understanding 任务（最具体来源，优先）
      const upstream = linked.source_task_id ? taskById?.get(linked.source_task_id) : undefined;
      if (upstream?.task_type === 'vision_understanding') return infoOf('visual_recreation');
      if (linked.task_type === 'remove_background') return infoOf('image_edit');
      if (isBatchTask(linked)) return infoOf('batch_generation');
      if (linked.task_type === 'edit') return infoOf('image_to_image');
      return infoOf('text_to_image');
    }
    // 任务记录缺失（含 chat 会话保存图）：仍是生成资产，绝不当本地导入
    if (image.source_kind === 'postprocess') return infoOf('image_edit');
    return infoOf('generated');
  }

  if (image.source_kind === 'library_input') return infoOf('local_import');
  if (image.source_kind === 'postprocess') return infoOf('image_edit');
  return infoOf('generated');
}
