import { describe, expect, it } from 'vitest';
import { deriveTaskState, isDerivedTerminal } from '../taskState';
import type { SubTask, Task } from '../../types';

function sub(index: number, status: SubTask['status']): SubTask {
  return { index, status };
}

function task(status: Task['status'], subs: SubTask[]): Pick<Task, 'status' | 'sub_tasks'> {
  return { status, sub_tasks: subs };
}

describe('deriveTaskTerminalState 主任务终态聚合（spec §29 专项）', () => {
  it('Case 1：1/1 failed → failed（即使 parent 仍停在 running，也不再显示执行中）', () => {
    // 实机 bug 快照：子任务全部失败、父任务 status 仍是 running（finalize 事件丢失）
    const derived = deriveTaskState(task('running', [sub(0, 'failed')]));
    expect(derived).toBe('failed');
    expect(isDerivedTerminal(derived)).toBe(true);
  });

  it('Case 2：1 completed + 1 failed → partial', () => {
    expect(deriveTaskState(task('failed', [sub(0, 'completed'), sub(1, 'failed')]))).toBe('partial');
  });

  it('Case 3：全部 completed → completed', () => {
    expect(deriveTaskState(task('completed', [sub(0, 'completed'), sub(1, 'completed')]))).toBe('completed');
  });

  it('Case 4：手动重试 failed slot 后 → queued / running（不再被视为终态）', () => {
    // retry_task_subtasks 重置后：parent pending、failed 槽 pending、completed 槽保持
    const afterReset = deriveTaskState(
      task('pending', [sub(0, 'pending'), sub(1, 'completed')]),
    );
    expect(afterReset).toBe('queued');
    expect(isDerivedTerminal(afterReset)).toBe(false);

    // runner 认领后（parent running、子任务 running）
    const claimed = deriveTaskState(
      task('running', [sub(0, 'running'), sub(1, 'completed')]),
    );
    expect(claimed).toBe('running');
    expect(isDerivedTerminal(claimed)).toBe(false);
  });

  it('queued：存在 pending 子任务且任务未被认领', () => {
    expect(deriveTaskState(task('pending', [sub(0, 'pending'), sub(1, 'pending')]))).toBe('queued');
  });

  it('running：任一子任务 running', () => {
    expect(deriveTaskState(task('running', [sub(0, 'completed'), sub(1, 'running')]))).toBe('running');
  });

  it('running：parent 已认领但仍有可执行 queued 子任务', () => {
    expect(deriveTaskState(task('running', [sub(0, 'completed'), sub(1, 'pending')]))).toBe('running');
  });

  it('cancelled：任务明确取消且没有 running 子任务', () => {
    expect(deriveTaskState(task('cancelled', [sub(0, 'completed'), sub(1, 'cancelled')]))).toBe('cancelled');
  });

  it('全部子任务 cancelled（parent 异常未标取消）→ cancelled', () => {
    expect(deriveTaskState(task('pending', [sub(0, 'cancelled')]))).toBe('cancelled');
  });

  it('全部终态且 0 成功 0 失败不可能出现时回落 cancelled；无子任务历史数据退回 parent status', () => {
    expect(deriveTaskState(task('completed', []))).toBe('completed');
    expect(deriveTaskState(task('running', []))).toBe('running');
    expect(deriveTaskState(task('pending', []))).toBe('queued');
  });

  it('mapTaskToStage：parent 卡 running 但子任务全部终态时给出正确 stage（Chat 卡片同源）', async () => {
    const { mapTaskToStage } = await import('../../store/useTaskStore');
    const stuck = {
      status: 'running',
      count: 1,
      success_count: 0,
      failed_count: 1,
      sub_tasks: [sub(0, 'failed')],
    } as Task;
    expect(mapTaskToStage(stuck)).toBe('failed');

    const stuckSuccess = {
      status: 'running',
      count: 1,
      success_count: 1,
      failed_count: 0,
      sub_tasks: [sub(0, 'completed')],
    } as Task;
    expect(mapTaskToStage(stuckSuccess)).toBe('success');
  });
});
