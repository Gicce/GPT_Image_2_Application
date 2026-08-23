import { describe, it, expect } from 'vitest';
import { poseViewLabel, poseKeyframeLabel, poseSlotLabel, poseSlotOfImage, poseBatchTaskSourceLabel } from '../poseBatch';
import type { Task } from '../../types';

/**
 * 动作白膜（Pose Batch）展示辅助契约：
 * - 视角 / 关键帧中文标签固定（与 Rust pose_batch.rs 同表）；
 * - 图片 → 槽位反查（sub_tasks[i].image_id → slots[sub_index]）；
 * - 任务中心来源标签区分「动作白膜」与「视频复刻」。
 */

function poseTask(): Task {
  return {
    id: 'pose-t1',
    task_type: 'generate',
    execution_mode: 'batch',
    count: 5,
    status: 'completed',
    prompt: '',
    final_prompt: '',
    negative_prompt: '',
    user_prompt_raw: '',
    size: '1024x1536',
    quality: 'high',
    output_format: 'png',
    output_dir: '',
    source_images: [],
    task_source: 'cy-video-studio',
    success_count: 5,
    failed_count: 0,
    created_at: new Date().toISOString(),
    sub_tasks: [
      { index: 0, status: 'completed', image_id: 'img-a' },
      { index: 1, status: 'completed', image_id: 'img-b' },
      { index: 2, status: 'completed', image_id: 'img-c' },
      { index: 3, status: 'completed', image_id: 'img-d' },
      { index: 4, status: 'completed', image_id: 'img-e' },
    ],
    pose_batch: {
      batch_id: 'pose-batch-001',
      contract_version: 1,
      preset_version: 'ACTION_MANNEQUIN_V1',
      action_id: 'motion-123',
      action_name: '转身挥手',
      normalized_pose: '身体从正面转向左侧并挥手',
      consistency_strategy: 'prompt_only',
      aspect_ratio: '1024x1536',
      master_image_id: null,
      master_slot_index: null,
      slots: [
        { slot_id: 'front_3q_start', view: 'front_3q', keyframe: 'start', sub_index: 0 },
        { slot_id: 'front_3q_middle', view: 'front_3q', keyframe: 'middle', sub_index: 1 },
        { slot_id: 'front_3q_end', view: 'front_3q', keyframe: 'end', sub_index: 2 },
        { slot_id: 'side_middle', view: 'side', keyframe: 'middle', sub_index: 3 },
        { slot_id: 'back_middle', view: 'back', keyframe: 'middle', sub_index: 4 },
      ],
    },
  } as Task;
}

describe('视角 / 关键帧中文标签', () => {
  it('四视角标签固定', () => {
    expect(poseViewLabel('front_3q')).toBe('前3/4');
    expect(poseViewLabel('front')).toBe('正面');
    expect(poseViewLabel('side')).toBe('侧面');
    expect(poseViewLabel('back')).toBe('背面');
  });

  it('未知视角原样返回（防御异常数据，不崩溃）', () => {
    expect(poseViewLabel('top_down')).toBe('top_down');
  });

  it('关键帧标签：起始/中间/结束，none 为空', () => {
    expect(poseKeyframeLabel('start')).toBe('起始');
    expect(poseKeyframeLabel('middle')).toBe('中间');
    expect(poseKeyframeLabel('end')).toBe('结束');
    expect(poseKeyframeLabel('none')).toBe('');
  });

  it('槽位标签组合：前3/4 · 起始；none 时仅视角', () => {
    expect(poseSlotLabel({ view: 'front_3q', keyframe: 'start' })).toBe('前3/4 · 起始');
    expect(poseSlotLabel({ view: 'side', keyframe: 'middle' })).toBe('侧面 · 中间');
    expect(poseSlotLabel({ view: 'back', keyframe: 'none' })).toBe('背面');
  });
});

describe('图片 → 槽位反查（详情来源区数据源）', () => {
  it('sub_tasks[i].image_id → slots[sub_index] 对齐', () => {
    const task = poseTask();
    expect(poseSlotOfImage(task, 'img-d')?.slot_id).toBe('side_middle');
    expect(poseSlotOfImage(task, 'img-d')?.view).toBe('side');
    expect(poseSlotOfImage(task, 'img-a')?.keyframe).toBe('start');
  });

  it('图片不属于该任务 / 任务无批 → undefined（不崩溃）', () => {
    const task = poseTask();
    expect(poseSlotOfImage(task, 'img-other')).toBeUndefined();
    const plain = { ...task, pose_batch: undefined } as Task;
    expect(poseSlotOfImage(plain, 'img-a')).toBeUndefined();
  });
});

describe('任务中心来源标签', () => {
  it('pose_batch 任务 → CY Video Studio · 动作白膜', () => {
    expect(poseBatchTaskSourceLabel(poseTask())).toBe('CY Video Studio · 动作白膜');
  });

  it('普通 cy-video-studio 任务（视频复刻单任务）→ CY Video Studio · 视频复刻', () => {
    const replication = { ...poseTask(), pose_batch: undefined } as Task;
    expect(poseBatchTaskSourceLabel(replication)).toBe('CY Video Studio · 视频复刻');
  });
});
