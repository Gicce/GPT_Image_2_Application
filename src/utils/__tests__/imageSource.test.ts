import { describe, it, expect } from 'vitest';
import {
  resolveImageSource,
  IMAGE_SOURCE_LABELS,
  IMAGE_SOURCE_FILTER_TABS,
  type GallerySourceFilter,
} from '../imageSource';
import type { ImageRecord, Task } from '../../types';

/**
 * Image Source Provenance resolver 契约：
 * - 生成资产继承任务来源（含视觉复刻链 source_task_id → vision_understanding）；
 * - 「本地」只属于用户导入（library_input 且无任务关联）；
 * - linked task 的资产绝不能因为 source_kind 缺失 / 误标而变成「本地」；
 * - 筛选桶与中文来源词一一对应（copy.md 来源表）。
 */

function task(partial: Partial<Task> & { id: string }): Task {
  return {
    task_type: 'generate',
    execution_mode: 'single',
    count: 1,
    status: 'completed',
    prompt: '',
    final_prompt: '',
    negative_prompt: '',
    user_prompt_raw: '',
    size: '1024x1024',
    quality: 'auto',
    output_format: 'png',
    output_dir: '',
    source_images: [],
    task_source: 'manual',
    created_at: new Date().toISOString(),
    ...partial,
  } as Task;
}

function image(partial: Partial<Pick<ImageRecord, 'task_id' | 'source_kind'>>): Pick<ImageRecord, 'task_id' | 'source_kind'> {
  return { task_id: 'library', source_kind: 'library_input', ...partial };
}

describe('本地导入（唯一允许显示「本地」的来源）', () => {
  it('library_input 索引行（用户手动放入本地目录）→ 本地', () => {
    const info = resolveImageSource(image({ task_id: 'library', source_kind: 'library_input' }));
    expect(info.kind).toBe('local_import');
    expect(info.label).toBe('本地');
    expect(info.isLocal).toBe(true);
    expect(info.filterKey).toBe('all');
  });

  it('拖拽 / 本地选择导入（同走 library_input 索引）→ 本地', () => {
    const info = resolveImageSource(image({ source_kind: 'library_input' }));
    expect(info.kind).toBe('local_import');
  });
});

describe('生成资产继承任务来源（任务关联优先，绝不回退本地）', () => {
  const taskById = new Map<string, Task>();

  it('text2image 任务 → 文生图', () => {
    const info = resolveImageSource(image({ task_id: 't-t2i', source_kind: 'output' }), taskById.get('t-t2i') ?? task({ id: 't-t2i', task_type: 'generate' }), taskById);
    expect(info.kind).toBe('text_to_image');
    expect(info.label).toBe('文生图');
    expect(info.filterKey).toBe('t2i');
    expect(info.isLocal).toBe(false);
  });

  it('image2image（edit 任务 + 参考图）→ 图生图', () => {
    const info = resolveImageSource(
      image({ task_id: 't-i2i', source_kind: 'output' }),
      task({ id: 't-i2i', task_type: 'edit' }),
    );
    expect(info.kind).toBe('image_to_image');
    expect(info.label).toBe('图生图');
    expect(info.filterKey).toBe('i2i');
  });

  it('edit（remove_background 去背景）→ 编辑结果', () => {
    const info = resolveImageSource(
      image({ task_id: 't-rg', source_kind: 'postprocess' }),
      task({ id: 't-rg', task_type: 'remove_background' }),
    );
    expect(info.kind).toBe('image_edit');
    expect(info.label).toBe('编辑结果');
    expect(info.filterKey).toBe('edit_result');
  });

  it('batch（execution_mode=batch 或 count>1）→ 批量结果', () => {
    const byMode = resolveImageSource(
      image({ task_id: 't-b1', source_kind: 'output' }),
      task({ id: 't-b1', task_type: 'generate', execution_mode: 'batch', count: 1 }),
    );
    expect(byMode.kind).toBe('batch_generation');
    expect(byMode.label).toBe('批量结果');
    expect(byMode.filterKey).toBe('batch');

    const byCount = resolveImageSource(
      image({ task_id: 't-b2', source_kind: 'output' }),
      task({ id: 't-b2', task_type: 'edit', execution_mode: 'single', count: 4 }),
    );
    expect(byCount.kind).toBe('batch_generation');
  });

  it('visual recreation（生成任务 source_task_id → vision_understanding）→ 视觉复刻', () => {
    const visionTask = task({ id: 'vt-1', task_type: 'vision_understanding' });
    const genTask = task({ id: 'gen-1', task_type: 'edit', source_task_id: 'vt-1' });
    const taskById = new Map<string, Task>([['vt-1', visionTask], ['gen-1', genTask]]);
    const info = resolveImageSource(image({ task_id: 'gen-1', source_kind: 'output' }), genTask, taskById);
    expect(info.kind).toBe('visual_recreation');
    expect(info.label).toBe('视觉复刻');
    expect(info.filterKey).toBe('vision');
  });

  it('batch redo 的 source_task_id 指向普通任务 → 不误判视觉复刻', () => {
    const origin = task({ id: 'src-1', task_type: 'generate' });
    const redo = task({ id: 'redo-1', task_type: 'generate', source_task_id: 'src-1' });
    const taskById = new Map<string, Task>([['src-1', origin], ['redo-1', redo]]);
    const info = resolveImageSource(image({ task_id: 'redo-1', source_kind: 'output' }), redo, taskById);
    expect(info.kind).toBe('text_to_image');
  });
});

describe('linked task 绝不变本地（历史 source_kind 被目录误标）', () => {
  it('任务存在但 source_kind 被覆写成 library_input → 仍按任务来源', () => {
    // Rust classify_source_kind 历史 bug：输出目录嵌套在本地目录之下时被误标
    const info = resolveImageSource(
      image({ task_id: 't-1', source_kind: 'library_input' }),
      task({ id: 't-1', task_type: 'generate' }),
    );
    expect(info.kind).toBe('text_to_image');
    expect(info.isLocal).toBe(false);
  });

  it('任务记录缺失（含 chat 会话保存图）→ 生成结果，绝不当本地导入', () => {
    const info = resolveImageSource(image({ task_id: 'conv-123', source_kind: 'chat' }));
    expect(info.kind).toBe('generated');
    expect(info.label).toBe('生成结果');
    expect(info.isLocal).toBe(false);
  });

  it('任务记录缺失 + postprocess → 编辑结果', () => {
    const info = resolveImageSource(image({ task_id: 'lost-1', source_kind: 'postprocess' }));
    expect(info.kind).toBe('image_edit');
  });

  it('无任务关联 + output 扫描行 → 生成结果（不是本地）', () => {
    const info = resolveImageSource(image({ task_id: 'library', source_kind: 'output' }));
    expect(info.kind).toBe('generated');
    expect(info.isLocal).toBe(false);
  });
});

describe('来源词与筛选 Tab（copy.md 来源表）', () => {
  it('八类来源词固定（本地/文生图/图生图/编辑结果/批量结果/视觉复刻/动作白膜/生成结果）', () => {
    expect(IMAGE_SOURCE_LABELS).toEqual({
      local_import: '本地',
      text_to_image: '文生图',
      image_to_image: '图生图',
      image_edit: '编辑结果',
      batch_generation: '批量结果',
      visual_recreation: '视觉复刻',
      video_pose: '动作白膜',
      generated: '生成结果',
    });
  });

  it('筛选 Tab：全部/文生图/图生图/编辑结果/批量结果/视觉复刻/CY Video，与 resolver 筛选桶一致', () => {
    expect(IMAGE_SOURCE_FILTER_TABS.map(t => t.key)).toEqual(
      ['all', 't2i', 'i2i', 'edit_result', 'batch', 'vision', 'video'] as GallerySourceFilter[],
    );

    const visionTask = task({ id: 'vt', task_type: 'vision_understanding' });
    const genTask = task({ id: 'g', task_type: 'generate', source_task_id: 'vt' });
    const taskById = new Map<string, Task>([['vt', visionTask], ['g', genTask]]);

    const cases: { partial: Partial<Pick<ImageRecord, 'task_id' | 'source_kind'>>; linked: Task | undefined; bucket: GallerySourceFilter }[] = [
      { partial: { task_id: 'g', source_kind: 'output' }, linked: genTask, bucket: 'vision' },
      { partial: { task_id: 'a', source_kind: 'output' }, linked: task({ id: 'a', task_type: 'generate' }), bucket: 't2i' },
      { partial: { task_id: 'b', source_kind: 'output' }, linked: task({ id: 'b', task_type: 'edit' }), bucket: 'i2i' },
      { partial: { task_id: 'c', source_kind: 'postprocess' }, linked: task({ id: 'c', task_type: 'remove_background' }), bucket: 'edit_result' },
      { partial: { task_id: 'd', source_kind: 'output' }, linked: task({ id: 'd', task_type: 'generate', execution_mode: 'batch' }), bucket: 'batch' },
      { partial: { task_id: 'p', source_kind: 'output' }, linked: poseBatchTask('转身挥手'), bucket: 'video' },
    ];
    for (const c of cases) {
      const info = resolveImageSource(image(c.partial), c.linked, taskById);
      expect(info.filterKey).toBe(c.bucket);
    }
  });
});

/** 标准契约 Fixture：CY Video Studio 动作白膜批（转身挥手 · 5 槽位） */
function poseBatchTask(actionName: string): Task {
  return task({
    id: 'pose-t1',
    task_source: 'cy-video-studio',
    source_app: 'cy-video-studio',
    source_request_id: 'video-pose-request-001',
    task_type: 'generate',
    execution_mode: 'batch',
    count: 5,
    pose_batch: {
      batch_id: 'pose-batch-001',
      contract_version: 1,
      preset_version: 'ACTION_MANNEQUIN_V1',
      action_id: 'motion-123',
      action_name: actionName,
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
  });
}

describe('动作白膜（CY Video Studio Pose Batch）来源继承', () => {
  it('pose_batch 任务产物 → 动作白膜 · 动作名，优先于批量细分', () => {
    const poseTask = poseBatchTask('转身挥手');
    const info = resolveImageSource(image({ task_id: 'pose-t1', source_kind: 'output' }), poseTask);
    expect(info.kind).toBe('video_pose');
    expect(info.label).toBe('动作白膜 · 转身挥手');
    expect(info.filterKey).toBe('video');
    expect(info.isLocal).toBe(false);
    expect(info.sourceApp).toBe('CY Video Studio');
  });

  it('动作名缺失（防御旧/异常数据）→ 裸「动作白膜」标签，不崩溃', () => {
    const poseTask = poseBatchTask('');
    const info = resolveImageSource(image({ task_id: 'pose-t1', source_kind: 'output' }), poseTask);
    expect(info.kind).toBe('video_pose');
    expect(info.label).toBe('动作白膜');
  });

  it('重试产物仍继承批来源（retry 后 source_kind 误标也不变）', () => {
    const poseTask = poseBatchTask('转身挥手');
    const info = resolveImageSource(image({ task_id: 'pose-t1', source_kind: 'library_input' }), poseTask);
    expect(info.kind).toBe('video_pose');
    expect(info.isLocal).toBe(false);
  });

  it('普通 ImagePro 批量任务（无 pose_batch）不误标为动作白膜', () => {
    const info = resolveImageSource(
      image({ task_id: 't-norm', source_kind: 'output' }),
      task({ id: 't-norm', task_type: 'generate', execution_mode: 'batch', count: 5 }),
    );
    expect(info.kind).toBe('batch_generation');
    expect(info.sourceApp).toBeUndefined();
  });

  it('旧数据（无 pose_batch 字段）与本地导入不受影响', () => {
    const legacy = resolveImageSource(image({ task_id: 'old-1', source_kind: 'output' }), task({ id: 'old-1' }));
    expect(legacy.kind).toBe('text_to_image');

    const local = resolveImageSource(image({ task_id: 'library', source_kind: 'library_input' }));
    expect(local.kind).toBe('local_import');
    expect(local.isLocal).toBe(true);
  });
});
