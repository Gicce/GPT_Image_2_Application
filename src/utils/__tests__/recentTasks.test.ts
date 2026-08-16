import { describe, it, expect } from 'vitest';
import { selectRecentImageTasks, recentTaskTitle, recentTaskDisplayTitle, RECENT_TASKS_LIMIT } from '../recentTasks';
import type { Task } from '../../types';

function makeTask(patch: Partial<Task> & { id: string }): Task {
  return {
    prompt: '',
    negative_prompt: '',
    status: 'pending',
    created_at: new Date().toISOString(),
    sub_tasks: [],
    count: 1,
    success_count: 0,
    failed_count: 0,
    source_images: [],
    task_type: 'generate',
    execution_mode: 'single',
    ...patch,
  } as Task;
}

describe('selectRecentImageTasks', () => {
  it('按 createdAt 倒序返回（tasks.json 的 push 顺序是最旧在前，必须重排）', () => {
    const tasks = [
      makeTask({ id: 'old', created_at: '2026-01-01T00:00:00Z' }),
      makeTask({ id: 'new', created_at: '2026-08-15T00:00:00Z' }),
      makeTask({ id: 'mid', created_at: '2026-05-01T00:00:00Z' }),
    ];
    expect(selectRecentImageTasks(tasks).map(t => t.id)).toEqual(['new', 'mid', 'old']);
  });

  it('只保留图片类任务，过滤无关 task_type', () => {
    const tasks = [
      makeTask({ id: 'img', task_type: 'generate' }),
      makeTask({ id: 'edit', task_type: 'edit' }),
      makeTask({ id: 'other', task_type: 'remove_background' }),
    ];
    const ids = selectRecentImageTasks(tasks).map(t => t.id);
    expect(ids).toContain('img');
    expect(ids).toContain('edit');
    expect(ids).toContain('other');
    expect(selectRecentImageTasks([makeTask({ id: 'x', task_type: '' })])).toHaveLength(0);
  });

  it('limit 截断到配置条数（默认 8）', () => {
    const tasks = Array.from({ length: 20 }, (_, i) =>
      makeTask({ id: `t${i}`, created_at: new Date(2026, 0, i + 1).toISOString() }));
    expect(selectRecentImageTasks(tasks)).toHaveLength(RECENT_TASKS_LIMIT);
    expect(selectRecentImageTasks(tasks)[0].id).toBe('t19');
    expect(selectRecentImageTasks(tasks, 3)).toHaveLength(3);
  });

  it('同一 taskId 只出现一次（running→succeeded 原地更新，不产生重复条目）', () => {
    const running = makeTask({ id: 'same', status: 'running' });
    const done = makeTask({ id: 'same', status: 'completed', success_count: 1 });
    expect(selectRecentImageTasks([running, done])).toHaveLength(1);
    expect(selectRecentImageTasks([running, done])[0].status).toBe('completed');
  });
});

describe('recentTaskTitle', () => {
  it('优先 task_plan_summary，其次 prompt 首行，超长截断', () => {
    expect(recentTaskTitle(makeTask({ id: 'a', task_plan_summary: '同 Prompt 多变体 × 4', prompt: '很长的prompt'.repeat(20) })))
      .toBe('同 Prompt 多变体 × 4');
    const long = '日本街道风景图'.repeat(10);
    expect(recentTaskTitle(makeTask({ id: 'b', prompt: long }))).toBe(`${long.slice(0, 24)}…`);
  });

  it('多行 prompt 只取首行', () => {
    expect(recentTaskTitle(makeTask({ id: 'c', prompt: '第一行\n第二行' }))).toBe('第一行');
  });

  it('无任何文本时回落到类型 + 时间', () => {
    expect(recentTaskTitle(makeTask({ id: 'd' }))).toMatch(/2026|\d{4}/);
  });

  it('展示标题带类型前缀', () => {
    expect(recentTaskDisplayTitle(makeTask({ id: 'e', task_type: 'edit', prompt: '把背景换成夜景' }))).toBe('[图生图] 把背景换成夜景');
    expect(recentTaskDisplayTitle(makeTask({ id: 'f', task_type: 'remove_background', prompt: 'x' }))).toBe('[抠图] x');
  });
});
