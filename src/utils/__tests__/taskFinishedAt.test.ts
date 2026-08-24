import { describe, expect, it } from 'vitest';
import { resolveTaskFinishedAt, resolveTaskStartedAt, taskDurationMs } from '../taskState';
import type { Task } from '../../types';

describe('resolveTaskFinishedAt / 任务时间口径（spec §3 §28）', () => {
  it('结束时间唯一来源是 completed_at（completed / failed / partial / cancelled 共用）', () => {
    const finished = '2026-08-24T18:45:19+08:00';
    expect(resolveTaskFinishedAt({ completed_at: finished })).toBe(finished);
    expect(resolveTaskFinishedAt({ completed_at: null })).toBeNull();
    expect(resolveTaskFinishedAt({ completed_at: undefined })).toBeNull();
  });

  it('非法时间字符串不当作结束时间（绝不显示伪值）', () => {
    expect(resolveTaskFinishedAt({ completed_at: 'not-a-date' })).toBeNull();
    expect(resolveTaskFinishedAt({ completed_at: '' })).toBeNull();
  });

  it('旧任务没有 completed_at 时 UI 应显示「—」而不是当前时间补值', () => {
    // resolveTaskFinishedAt 返回 null 是「显示 —」的唯一信号源
    expect(resolveTaskFinishedAt({ completed_at: null })).toBeNull();
  });

  it('开始时间读 started_at；缺失返回 null', () => {
    const started = '2026-08-24T18:45:05+08:00';
    expect(resolveTaskStartedAt({ started_at: started })).toBe(started);
    expect(resolveTaskStartedAt({ started_at: null })).toBeNull();
  });

  it('耗时 = 结束 - 开始（ms）；任一缺失返回 null（禁止用 created_at 凑数）', () => {
    const started = '2026-08-24T18:45:05+08:00';
    const finished = '2026-08-24T18:45:19+08:00';
    expect(taskDurationMs({ started_at: started, completed_at: finished })).toBe(14_000);
    expect(taskDurationMs({ started_at: null, completed_at: finished })).toBeNull();
    expect(taskDurationMs({ started_at: started, completed_at: null })).toBeNull();
    // 结束早于开始（异常数据）不输出负耗时
    expect(taskDurationMs({ started_at: finished, completed_at: started })).toBeNull();
  });

  it('重试语义：reset 清空 completed_at 后不再被当作终态结束时间', () => {
    // Rust reset_failed_subtasks_for_retry 会置 completed_at = None；
    // 前端唯一读取入口随之返回 null（Case 4 spec §29）
    const task = { started_at: null, completed_at: null } as Pick<Task, 'started_at' | 'completed_at'>;
    expect(resolveTaskFinishedAt(task)).toBeNull();
    expect(taskDurationMs(task)).toBeNull();
  });
});
