import { describe, it, expect } from 'vitest';
import {
  getTaskCategory,
  getTaskCategoryLabel,
  getTaskCategoryCounts,
  getTaskTypeExtraLabel,
  filterTasksByCategory,
  filterTasksByStatus,
} from '../taskCategory';
import type { Task } from '../../types';

function makeTask(patch: Partial<Task>): Task {
  return {
    id: `task-${Math.random().toString(36).slice(2, 10)}`,
    prompt: '一只猫',
    negative_prompt: '',
    size: '1024x1024',
    quality: 'high',
    output_format: 'png',
    count: 1,
    status: 'completed',
    created_at: '2026-08-21T10:00:00',
    output_dir: '/tmp/out',
    success_count: 1,
    failed_count: 0,
    sub_tasks: [],
    task_type: 'generate',
    source_images: [],
    ...patch,
  };
}

describe('getTaskCategory（结构化字段分类）', () => {
  it('task_type=generate → 文生图；旧数据空串同样归为文生图', () => {
    expect(getTaskCategory(makeTask({ task_type: 'generate' }))).toBe('text_to_image');
    expect(getTaskCategory(makeTask({ task_type: '' }))).toBe('text_to_image');
  });

  it('task_type=edit / remove_background → 图生图', () => {
    expect(getTaskCategory(makeTask({ task_type: 'edit' }))).toBe('image_to_image');
    expect(getTaskCategory(makeTask({ task_type: 'remove_background' }))).toBe('image_to_image');
  });

  it('task_type=vision_understanding → 视觉理解', () => {
    expect(getTaskCategory(makeTask({ task_type: 'vision_understanding' }))).toBe('vision_understanding');
    expect(getTaskCategoryLabel(makeTask({ task_type: 'vision_understanding' }))).toBe('视觉理解');
  });

  it('来自视觉理解的生成任务按自身 task_type 归类，来源字段不参与分类', () => {
    const task = makeTask({
      task_type: 'generate',
      source_task_kind: 'vision_understanding',
      source_task_id: 'abcd1234-5678',
    });
    expect(getTaskCategory(task)).toBe('text_to_image');
    expect(getTaskCategoryLabel(task)).toBe('文生图');

    const editTask = makeTask({
      task_type: 'edit',
      source_task_kind: 'vision_understanding',
      source_task_id: 'abcd1234-5678',
    });
    expect(getTaskCategory(editTask)).toBe('image_to_image');
  });

  it('分类标签：文生图 / 图生图 / 视觉理解', () => {
    expect(getTaskCategoryLabel(makeTask({ task_type: 'generate' }))).toBe('文生图');
    expect(getTaskCategoryLabel(makeTask({ task_type: 'edit' }))).toBe('图生图');
    expect(getTaskCategoryLabel(makeTask({ task_type: 'remove_background' }))).toBe('图生图');
    expect(getTaskCategoryLabel(makeTask({ task_type: 'vision_understanding' }))).toBe('视觉理解');
  });

  it('remove_background 保留「透明背景」补充标签，其余为空', () => {
    expect(getTaskTypeExtraLabel(makeTask({ task_type: 'remove_background' }))).toBe('透明背景');
    expect(getTaskTypeExtraLabel(makeTask({ task_type: 'edit' }))).toBe('');
    expect(getTaskTypeExtraLabel(makeTask({ task_type: 'generate' }))).toBe('');
  });
});

describe('getTaskCategoryCounts（真实数量动态计算）', () => {
  const tasks = [
    makeTask({ id: 'a', task_type: 'generate' }),
    makeTask({ id: 'b', task_type: 'generate', source_task_kind: 'vision_understanding' }),
    makeTask({ id: 'c', task_type: 'generate' }),
    makeTask({ id: 'd', task_type: 'edit' }),
    makeTask({ id: 'e', task_type: 'remove_background' }),
    makeTask({ id: 'f', task_type: 'vision_understanding' }),
    makeTask({ id: 'g', task_type: 'vision_understanding' }),
  ];

  it('各分类数量正确，all = 任务总数', () => {
    expect(getTaskCategoryCounts(tasks)).toEqual({
      all: 7,
      text_to_image: 3,
      image_to_image: 2,
      vision_understanding: 2,
    });
  });

  it('删除任务后数量立即更新（重新计算即新值）', () => {
    const afterDelete = tasks.filter(t => t.id !== 'f');
    expect(getTaskCategoryCounts(afterDelete)).toEqual({
      all: 6,
      text_to_image: 3,
      image_to_image: 2,
      vision_understanding: 1,
    });
  });

  it('空任务列表全部为 0', () => {
    expect(getTaskCategoryCounts([])).toEqual({
      all: 0,
      text_to_image: 0,
      image_to_image: 0,
      vision_understanding: 0,
    });
  });
});

describe('类型 + 状态组合筛选', () => {
  const tasks = [
    makeTask({ id: 't2i-ok', task_type: 'generate', status: 'completed' }),
    makeTask({ id: 't2i-fail', task_type: 'generate', status: 'failed' }),
    makeTask({ id: 't2i-run', task_type: 'generate', status: 'running' }),
    makeTask({ id: 'i2i-ok', task_type: 'edit', status: 'completed' }),
    makeTask({ id: 'i2i-wait', task_type: 'edit', status: 'pending' }),
    makeTask({ id: 'vis-ok', task_type: 'vision_understanding', status: 'completed' }),
    makeTask({ id: 'vis-fail', task_type: 'vision_understanding', status: 'failed' }),
    makeTask({ id: 'cancelled', task_type: 'generate', status: 'cancelled' }),
  ];

  it('all + all 返回全部（含已取消）', () => {
    expect(filterTasksByCategory(tasks, 'all')).toHaveLength(8);
    expect(filterTasksByStatus(tasks, 'all')).toHaveLength(8);
  });

  it('视觉理解 + 已完成 组合', () => {
    const result = filterTasksByStatus(filterTasksByCategory(tasks, 'vision_understanding'), 'completed');
    expect(result.map(t => t.id)).toEqual(['vis-ok']);
  });

  it('文生图 + 失败 组合（不含图生图/视觉理解的失败）', () => {
    const result = filterTasksByStatus(filterTasksByCategory(tasks, 'text_to_image'), 'failed');
    expect(result.map(t => t.id)).toEqual(['t2i-fail']);
  });

  it('图生图分类包含 edit 与 remove_background', () => {
    const mixed = [
      makeTask({ id: 'x1', task_type: 'edit' }),
      makeTask({ id: 'x2', task_type: 'remove_background' }),
      makeTask({ id: 'x3', task_type: 'generate' }),
    ];
    expect(filterTasksByCategory(mixed, 'image_to_image').map(t => t.id)).toEqual(['x1', 'x2']);
  });

  it('已取消任务不出现在任何具体状态筛选（只在「全部」）', () => {
    for (const status of ['pending', 'running', 'completed', 'failed'] as const) {
      const ids = filterTasksByStatus(tasks, status).map(t => t.id);
      expect(ids).not.toContain('cancelled');
    }
  });
});
