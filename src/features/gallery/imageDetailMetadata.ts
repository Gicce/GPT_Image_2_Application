/**
 * 图库详情 Metadata 唯一 view-model resolver（V4.1 来源收口）。
 *
 * 来源（这张图片从哪里进入 CyImagePro）一律复用 resolveImageSource，禁止在本模块
 * 复制其推断逻辑；详情 Modal / ImageViewer 只消费本函数产出的行，不允许自行读取
 * source_kind / task_id / pose_batch 拼来源。
 *
 * 来源 Source 与 用途 AssetType 是两个概念：
 * - 来源回答「从哪来」（本地 / 文生图 / … / CY Video Studio）；
 * - 用途回答「在业务里是什么」（动作白膜 …），只有真实存在该 metadata 时才出现，
 *   普通本地 / 生成图片绝不默认补「类型：生成结果」。
 */

import { resolveImageSource, type ImageSourceInfo } from '../../utils/imageSource';
import { poseKeyframeLabel, poseSlotOfImage, poseViewLabel } from '../../utils/poseBatch';
import type { ImageRecord, Task } from '../../types';

/** 图片执行模型（Rust task_runner 固定使用 CyImagePro 图片服务） */
export const IMAGE_EXECUTION_MODEL = 'GPT Image 2';

export interface ImageDetailRow {
  label: string;
  value: string;
  copyValue?: string;
}

export interface ImageDetailMetadata {
  /** 唯一来源 resolver 结果（kind / label / filterKey / isLocal / sourceApp）。 */
  source: ImageSourceInfo;
  /** 详情「来源」行文案：动作白膜显示来源应用（CY Video Studio），其余为来源词。 */
  sourceLabel: string;
  /** 资产用途：仅存在真实业务用途 metadata 的资产（动作白膜）有值。 */
  assetType?: string;
  /** 基础信息区（文件名 / 来源 / 用途 / 时间 / 尺寸 / 格式 / 文件大小 / 生成模型 / 任务 ID）。 */
  basicRows: ImageDetailRow[];
  /** 动作白膜批次追溯（动作 / 视角 / 关键帧 / Batch ID / Slot ID / …）；无 pose_batch 为空。 */
  poseRows: ImageDetailRow[];
  /** ImageViewer 详情面板轻量 metadata（与基础信息同一来源解释）。 */
  viewerMetadata: { label: string; value: string }[];
}

const FORMAT_LABELS: Record<string, string> = {
  png: 'PNG',
  jpg: 'JPG',
  jpeg: 'JPEG',
  webp: 'WebP',
  gif: 'GIF',
  bmp: 'BMP',
};

function formatLabelOf(fileName: string): string | undefined {
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  return FORMAT_LABELS[ext];
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN');
}

export function resolveImageDetailMetadata(
  image: ImageRecord,
  task?: Task,
  taskById?: Map<string, Task> | null,
): ImageDetailMetadata {
  const source = resolveImageSource(image, task, taskById);
  const sourceLabel = source.sourceApp ?? source.label;
  const isLocal = source.isLocal;
  const timeLabel = isLocal ? '导入时间' : '生成时间';
  const timeValue = formatTime(image.created_at);
  const assetType = source.kind === 'video_pose' ? '动作白膜' : undefined;
  const format = formatLabelOf(image.file_name);

  const basicRows: ImageDetailRow[] = [
    { label: '文件名', value: image.file_name },
    { label: '来源', value: sourceLabel },
    ...(assetType ? [{ label: '用途', value: assetType }] : []),
    { label: timeLabel, value: timeValue },
    ...(image.width && image.height ? [{ label: '尺寸', value: `${image.width} × ${image.height}` }] : []),
    ...(format ? [{ label: '格式', value: format }] : []),
    ...(image.file_size != null ? [{ label: '文件大小', value: formatFileSize(image.file_size) }] : []),
    ...(task ? [{ label: '生成模型', value: IMAGE_EXECUTION_MODEL }] : []),
    ...(task ? [{ label: '任务 ID', value: task.id, copyValue: task.id }] : []),
  ];

  // 动作白膜批次区：来源（CY Video Studio）与用途（动作白膜）已在基础信息区，
  // 这里只放批次追溯键，避免同一资产出现两套来源解释。
  const poseBatch = task?.pose_batch;
  const poseSlot = task ? poseSlotOfImage(task, image.id) : undefined;
  const poseRows: ImageDetailRow[] = poseBatch
    ? [
        { label: '动作', value: poseBatch.action_name },
        ...(poseSlot
          ? [
              { label: '视角', value: poseViewLabel(poseSlot.view) },
              ...(poseSlot.keyframe && poseSlot.keyframe !== 'none'
                ? [{ label: '关键帧', value: poseKeyframeLabel(poseSlot.keyframe) }]
                : []),
            ]
          : []),
        { label: 'Batch ID', value: poseBatch.batch_id, copyValue: poseBatch.batch_id },
        ...(poseSlot ? [{ label: 'Slot ID', value: poseSlot.slot_id, copyValue: poseSlot.slot_id }] : []),
        ...(task?.source_request_id
          ? [{ label: 'Request ID', value: task.source_request_id, copyValue: task.source_request_id }]
          : []),
        ...(task?.source_context?.feature
          ? [{ label: 'Source Feature', value: task.source_context.feature }]
          : []),
        { label: 'Preset Version', value: poseBatch.preset_version },
      ]
    : [];

  const viewerMetadata = [
    { label: '来源', value: sourceLabel },
    ...(task ? [{ label: '任务 ID', value: task.id }] : []),
    { label: timeLabel, value: timeValue },
  ];

  return { source, sourceLabel, assetType, basicRows, poseRows, viewerMetadata };
}
