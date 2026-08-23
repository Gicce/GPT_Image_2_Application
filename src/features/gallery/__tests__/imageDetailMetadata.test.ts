import { describe, it, expect } from 'vitest';
import { resolveImageDetailMetadata, IMAGE_EXECUTION_MODEL } from '../imageDetailMetadata';
import { resolveImageSource } from '../../../utils/imageSource';
import type { ImageRecord, Task } from '../../../types';

/**
 * 图库详情 Metadata resolver 契约（V4.1 来源收口）：
 * - 来源行唯一解释 = resolveImageSource（Card / Filter / Detail / Viewer 不分叉）；
 * - 来源 Source 与 用途 AssetType 是两个概念：本地 / 生成图片无「用途」，动作白膜有；
 * - 详情 / Viewer 绝不出现「类型：生成结果」式混用（基础信息无「类型」行）；
 * - 微信 / 桌面 / 下载等外部路径拖入（library_input 索引行）→ 来源「本地」。
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
    sub_tasks: [],
    task_source: 'manual',
    created_at: '2026-08-24T00:00:00+08:00',
    ...partial,
  } as Task;
}

function image(partial: Partial<ImageRecord> & { task_id?: string; source_kind?: ImageRecord['source_kind'] }): ImageRecord {
  return {
    id: 'img-1',
    task_id: 'library',
    local_path: 'D:/Image2图片/808c9edfc624ab781d3e2ce0bac409a6.png',
    file_name: '808c9edfc624ab781d3e2ce0bac409a6.png',
    created_at: '2026-08-24T00:15:27+08:00',
    status: 'indexed',
    source_kind: 'library_input',
    missing: false,
    ...partial,
  } as ImageRecord;
}

function rowValue(rows: { label: string; value: string }[], label: string): string | undefined {
  return rows.find(row => row.label === label)?.value;
}

function poseBatchTask(actionName: string): Task {
  return task({
    id: 'pose-t1',
    task_source: 'cy-video-studio',
    source_app: 'cy-video-studio',
    source_request_id: 'video-pose-request-001',
    task_type: 'generate',
    execution_mode: 'batch',
    count: 5,
    // 首槽绑定测试图片（img-1）：sub_tasks[0].image_id 反查 → slots[sub_index=0]
    sub_tasks: [
      { index: 0, status: 'completed', image_id: 'img-1' },
      { index: 1, status: 'completed' },
      { index: 2, status: 'completed' },
      { index: 3, status: 'completed' },
      { index: 4, status: 'completed' },
    ],
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
        { slot_id: 'side_middle', view: 'side', keyframe: 'middle', sub_index: 3 },
      ],
    },
  });
}

describe('微信 / 外部路径拖入（Gallery Drag Import → 本地）', () => {
  it('微信临时目录拖入（task_id=library + library_input）→ 来源=本地，无用途，时间叫导入时间', () => {
    const wechat = image({
      local_path: 'D:/Image2图片/808c9edfc624ab781d3e2ce0bac409a6.png',
      file_name: '808c9edfc624ab781d3e2ce0bac409a6.png',
      task_id: 'library',
      source_kind: 'library_input',
      width: 1024,
      height: 1024,
      file_size: 1081344,
    });
    const detail = resolveImageDetailMetadata(wechat);
    expect(detail.source.kind).toBe('local_import');
    expect(detail.sourceLabel).toBe('本地');
    expect(detail.assetType).toBeUndefined();
    expect(rowValue(detail.basicRows, '来源')).toBe('本地');
    expect(rowValue(detail.basicRows, '导入时间')).toContain('2026');
    expect(rowValue(detail.basicRows, '尺寸')).toBe('1024 × 1024');
    expect(rowValue(detail.basicRows, '格式')).toBe('PNG');
    expect(rowValue(detail.basicRows, '文件大小')).toBe('1.03 MB');
    // 本地索引行没有任务：不出现生成侧字段，也不出现「类型 / 用途」行
    expect(rowValue(detail.basicRows, '类型')).toBeUndefined();
    expect(rowValue(detail.basicRows, '用途')).toBeUndefined();
    expect(rowValue(detail.basicRows, '生成模型')).toBeUndefined();
    expect(rowValue(detail.basicRows, '任务 ID')).toBeUndefined();
    expect(rowValue(detail.viewerMetadata, '来源')).toBe('本地');
  });

  it('桌面 / 下载 / 其它外部目录拖入同样解析为本地（外部源路径 ≠ 资产来源）', () => {
    for (const fileName of ['a.png', 'b.jpg', 'c.webp']) {
      const detail = resolveImageDetailMetadata(image({ file_name: fileName, local_path: `D:/Image2图片/${fileName}` }));
      expect(detail.sourceLabel).toBe('本地');
      expect(detail.source.isLocal).toBe(true);
    }
  });
});

describe('Card / Filter / Detail / Viewer 一致性（同一资产同一来源解释）', () => {
  const cases: { name: string; image: ImageRecord; task?: Task; cardLabel: string; sourceLabel: string; bucket: string }[] = [
    { name: '本地导入', image: image({}), cardLabel: '本地', sourceLabel: '本地', bucket: 'all' },
    { name: '文生图', image: image({ task_id: 't-t2i', source_kind: 'output' }), task: task({ id: 't-t2i', task_type: 'generate' }), cardLabel: '文生图', sourceLabel: '文生图', bucket: 't2i' },
    { name: '图生图', image: image({ task_id: 't-i2i', source_kind: 'output' }), task: task({ id: 't-i2i', task_type: 'edit' }), cardLabel: '图生图', sourceLabel: '图生图', bucket: 'i2i' },
    { name: '编辑结果', image: image({ task_id: 't-edit', source_kind: 'postprocess' }), task: task({ id: 't-edit', task_type: 'remove_background' }), cardLabel: '编辑结果', sourceLabel: '编辑结果', bucket: 'edit_result' },
    { name: '批量结果', image: image({ task_id: 't-batch', source_kind: 'output' }), task: task({ id: 't-batch', execution_mode: 'batch' }), cardLabel: '批量结果', sourceLabel: '批量结果', bucket: 'batch' },
    { name: '视觉复刻', image: image({ task_id: 'gen-1', source_kind: 'output' }), task: task({ id: 'gen-1', source_task_id: 'vt-1' }), cardLabel: '视觉复刻', sourceLabel: '视觉复刻', bucket: 'vision' },
    { name: '任务记录缺失', image: image({ task_id: 'conv-123', source_kind: 'chat' }), cardLabel: '生成结果', sourceLabel: '生成结果', bucket: 'all' },
  ];

  it('详情来源行 === 卡片来源词 === 筛选桶语义（非动作白膜资产）', () => {
    for (const c of cases) {
      const taskById = c.task ? new Map([['vt-1', task({ id: 'vt-1', task_type: 'vision_understanding' })], [c.task.id, c.task]]) : null;
      const card = resolveImageSource(c.image, c.task, taskById);
      expect(card.label).toBe(c.cardLabel);
      expect(String(card.filterKey)).toBe(c.bucket);
      const detail = resolveImageDetailMetadata(c.image, c.task, taskById);
      expect(detail.sourceLabel).toBe(c.sourceLabel);
      expect(detail.source.filterKey).toBe(card.filterKey);
      expect(rowValue(detail.basicRows, '来源')).toBe(c.sourceLabel);
      expect(rowValue(detail.viewerMetadata, '来源')).toBe(c.sourceLabel);
      // 一律没有「类型」行
      expect(rowValue(detail.basicRows, '类型')).toBeUndefined();
    }
  });

  it('生成资产展示生成侧字段：生成时间 / 生成模型 / 任务 ID', () => {
    const t2i = task({ id: 't-t2i', task_type: 'generate' });
    const detail = resolveImageDetailMetadata(image({ task_id: 't-t2i', source_kind: 'output' }), t2i);
    expect(rowValue(detail.basicRows, '生成时间')).toContain('2026');
    expect(rowValue(detail.basicRows, '导入时间')).toBeUndefined();
    expect(rowValue(detail.basicRows, '生成模型')).toBe(IMAGE_EXECUTION_MODEL);
    expect(rowValue(detail.basicRows, '任务 ID')).toBe('t-t2i');
  });
});

describe('linked task 绝不误标本地（source_kind 被错误标为 library_input）', () => {
  it('有任务关联但 source_kind=library_input → 按任务恢复来源', () => {
    const t2i = task({ id: 't-1', task_type: 'generate' });
    const detail = resolveImageDetailMetadata(image({ task_id: 't-1', source_kind: 'library_input' }), t2i);
    expect(detail.sourceLabel).toBe('文生图');
    expect(detail.source.isLocal).toBe(false);
    expect(rowValue(detail.basicRows, '导入时间')).toBeUndefined();

    const i2i = resolveImageDetailMetadata(image({ task_id: 't-2', source_kind: 'library_input' }), task({ id: 't-2', task_type: 'edit' }));
    expect(i2i.sourceLabel).toBe('图生图');

    const batch = resolveImageDetailMetadata(image({ task_id: 't-3', source_kind: 'library_input' }), task({ id: 't-3', execution_mode: 'batch' }));
    expect(batch.sourceLabel).toBe('批量结果');

    const visionTask = task({ id: 'vt-1', task_type: 'vision_understanding' });
    const genTask = task({ id: 'gen-1', source_task_id: 'vt-1' });
    const recreation = resolveImageDetailMetadata(
      image({ task_id: 'gen-1', source_kind: 'library_input' }),
      genTask,
      new Map([['vt-1', visionTask], ['gen-1', genTask]]),
    );
    expect(recreation.sourceLabel).toBe('视觉复刻');

    const pose = resolveImageDetailMetadata(image({ task_id: 'pose-t1', source_kind: 'library_input' }), poseBatchTask('转身挥手'));
    expect(pose.sourceLabel).toBe('CY Video Studio');
  });
});

describe('CY Video 动作白膜：来源 / 用途彻底分开', () => {
  it('来源=CY Video Studio、用途=动作白膜 各自独立成行；批次追溯键在动作白膜区', () => {
    const poseTask = poseBatchTask('转身挥手');
    const detail = resolveImageDetailMetadata(image({ task_id: 'pose-t1', source_kind: 'output' }), poseTask);
    expect(detail.source.kind).toBe('video_pose');
    expect(detail.sourceLabel).toBe('CY Video Studio');
    expect(detail.assetType).toBe('动作白膜');
    expect(rowValue(detail.basicRows, '来源')).toBe('CY Video Studio');
    expect(rowValue(detail.basicRows, '用途')).toBe('动作白膜');
    // 批次区只放追溯键，不重复 来源 / 用途 两行
    expect(rowValue(detail.poseRows, '来源')).toBeUndefined();
    expect(rowValue(detail.poseRows, '用途')).toBeUndefined();
    expect(rowValue(detail.poseRows, '动作')).toBe('转身挥手');
    // 首槽绑定测试图片（sub_tasks[0].image_id = img-1 → front_3q_start）
    expect(rowValue(detail.poseRows, '视角')).toBe('前3/4');
    expect(rowValue(detail.poseRows, '关键帧')).toBe('起始');
    expect(rowValue(detail.poseRows, 'Slot ID')).toBe('front_3q_start');
    expect(rowValue(detail.poseRows, 'Batch ID')).toBe('pose-batch-001');
    expect(rowValue(detail.poseRows, 'Request ID')).toBe('video-pose-request-001');
    expect(rowValue(detail.poseRows, 'Preset Version')).toBe('ACTION_MANNEQUIN_V1');
    // Viewer 同一解释
    expect(rowValue(detail.viewerMetadata, '来源')).toBe('CY Video Studio');
  });

  it('卡片与详情同源：卡片角标（sourceApp）与详情来源行都是 CY Video Studio', () => {
    const poseTask = poseBatchTask('转身挥手');
    const card = resolveImageSource(image({ task_id: 'pose-t1', source_kind: 'output' }), poseTask);
    const detail = resolveImageDetailMetadata(image({ task_id: 'pose-t1', source_kind: 'output' }), poseTask);
    expect(detail.sourceLabel).toBe(card.sourceApp);
    expect(detail.sourceLabel).toBe('CY Video Studio');
    // 卡片文字行是「动作白膜 · 动作名」（业务用途 + 动作），详情把它拆成 用途 / 动作 两行
    expect(card.label).toBe('动作白膜 · 转身挥手');
    expect(detail.assetType).toBe('动作白膜');
  });
});

describe('字段只展示真实数据（不伪造、不填满）', () => {
  it('无尺寸 / 文件大小数据时不渲染对应行', () => {
    const detail = resolveImageDetailMetadata(image({ width: null, height: null, file_size: null }));
    expect(rowValue(detail.basicRows, '尺寸')).toBeUndefined();
    expect(rowValue(detail.basicRows, '文件大小')).toBeUndefined();
  });

  it('未知扩展名不强行展示格式行', () => {
    const detail = resolveImageDetailMetadata(image({ file_name: 'photo.raw' }));
    expect(rowValue(detail.basicRows, '格式')).toBeUndefined();
  });

  it('文件大小按量级格式化（KB / B）', () => {
    expect(rowValue(resolveImageDetailMetadata(image({ file_size: 204800 })).basicRows, '文件大小')).toBe('200 KB');
    expect(rowValue(resolveImageDetailMetadata(image({ file_size: 512 })).basicRows, '文件大小')).toBe('512 B');
  });
});

describe('旧数据兼容（source_kind 缺失不 crash、不兜底本地）', () => {
  it('task_id=library 且 source_kind 缺失 → 生成结果（等待 Rust 重扫回填），绝不当本地', () => {
    const legacy = resolveImageDetailMetadata(image({ task_id: 'library', source_kind: undefined }));
    expect(legacy.source.kind).toBe('generated');
    expect(legacy.sourceLabel).toBe('生成结果');
    expect(legacy.source.isLocal).toBe(false);
  });
});
