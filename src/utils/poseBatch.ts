/**
 * 动作白膜（Pose Batch）展示辅助：视角 / 关键帧中文标签。
 * 语义字段与 Rust src-tauri/src/pose_batch.rs 对齐（Task.pose_batch 链路）。
 */

import type { PoseSlotMeta, Task } from '../types';

export const POSE_VIEW_LABELS: Record<string, string> = {
  front_3q: '前3/4',
  front: '正面',
  side: '侧面',
  back: '背面',
};

export const POSE_KEYFRAME_LABELS: Record<string, string> = {
  none: '',
  start: '起始',
  middle: '中间',
  end: '结束',
};

export function poseViewLabel(view: string): string {
  return POSE_VIEW_LABELS[view] ?? view;
}

export function poseKeyframeLabel(keyframe: string): string {
  return POSE_KEYFRAME_LABELS[keyframe] ?? keyframe;
}

/** 槽位中文标签：如「前3/4 · 起始」；keyframe=none 时仅视角。 */
export function poseSlotLabel(slot: Pick<PoseSlotMeta, 'view' | 'keyframe'>): string {
  const kf = poseKeyframeLabel(slot.keyframe);
  return kf ? `${poseViewLabel(slot.view)} · ${kf}` : poseViewLabel(slot.view);
}

/** 由图片定位所属槽位（sub_tasks[i].image_id 反查 → slots[sub_index]）。 */
export function poseSlotOfImage(task: Task, imageId: string): PoseSlotMeta | undefined {
  if (!task.pose_batch) return undefined;
  const subIndex = task.sub_tasks.findIndex(st => st.image_id === imageId);
  if (subIndex < 0) return undefined;
  return task.pose_batch.slots.find(s => s.sub_index === subIndex);
}

/** 任务中心来源标签（cy-video-studio 任务细分：动作白膜 vs 视频复刻）。 */
export function poseBatchTaskSourceLabel(task: Task): string {
  return task.pose_batch ? 'CY Video Studio · 动作白膜' : 'CY Video Studio · 视频复刻';
}
