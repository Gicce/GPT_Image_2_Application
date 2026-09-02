import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * V4.2.4 TEST 10 / 16 / 17 —— History 展示真实执行快照 + 三入口接线（源守卫）。
 *
 * 锁定的规范：
 * - History 展示 用户要求 / 参考图片 / Prompt 来源 / 正向 / 负面 / 实际执行 Prompt
 * - 实际执行 Prompt 优先读冻结快照与 Rust 回写的 executed_prompt，绝不重新推导后冒充真相
 * - 旧任务缺失 → legacy 字段 + 「旧版本任务：未记录完整执行快照」如实标注，禁止伪造
 * - 批量同效果三入口：TaskQueue 成功卡 / History 详情头 / 批量页「从已有任务导入」
 */

const history = readFileSync(resolve(__dirname, '../History.tsx'), 'utf-8').replace(/\r\n/g, '\n');
const taskQueue = readFileSync(resolve(__dirname, '../TaskQueue.tsx'), 'utf-8').replace(/\r\n/g, '\n');
const imageStudio = readFileSync(resolve(__dirname, '../ImageStudio.tsx'), 'utf-8').replace(/\r\n/g, '\n');
const taskRunner = readFileSync(
  resolve(__dirname, '../../../src-tauri/src/task_runner.rs'), 'utf-8',
).replace(/\r\n/g, '\n');

describe('TEST 10：History 展示统一执行快照', () => {
  test('Prompt 来源行存在且读快照（不重算）', () => {
    expect(history).toContain('Prompt 来源：{promptSourceText}');
    expect(history).toContain('promptSourceLabel(executionSnapshot.promptSource)');
    // 旧任务回落文案（如实标注，不伪造来源）
    expect(history).toContain('旧版本任务（未记录 Prompt 来源）');
  });

  test('正向 / 负面优先读快照字段（快照缺失才回落 legacy 字段）', () => {
    expect(history).toContain('snapshotPositive || singlePositive');
    expect(history).toContain('snapshotNegative || singleNegative');
  });

  test('实际执行 Prompt 优先读真实快照（execution_snapshot.effectivePrompt > sub_tasks[].executed_prompt > 推算）', () => {
    expect(history).toContain("executionSnapshot?.effectivePrompt?.trim()");
    expect(history).toContain("task.sub_tasks.map(sub => sub.executed_prompt?.trim() ?? '')");
  });

  test('快照真实值带「真实快照」标题；推算值必须带推算标注', () => {
    expect(history).toContain('实际执行提示词（真实快照）');
    expect(history).toContain('实际执行提示词（按拼接规则推算）');
  });

  test('用户要求 / 参考图片区块保持快照读取（已有回归锁定不动）', () => {
    expect(history).toContain('用户要求');
    expect(history).toContain('参考图片');
    expect(history).toContain('userInstruction');
  });
});

describe('TEST 17：旧任务兼容（绝不伪造）', () => {
  test('无快照 + 无 executed_prompt → 「旧版本任务：未记录完整执行快照」标注', () => {
    expect(history).toContain('旧版本任务：未记录完整执行快照');
  });

  test('批量方案抽屉：优先读 sub.executed_prompt，缺失才推算并标注', () => {
    expect(history).toContain('task.sub_tasks[item.index]?.executed_prompt?.trim()');
    expect(history).toContain('旧版本任务：未记录完整执行快照（上方为按当前拼接规则推算）');
  });

  test('Rust 侧 executed_prompt 回写存在（两条发送路径同一组合函数）', () => {
    expect(taskRunner).toContain('compose_model_instruction');
    expect(taskRunner).toContain('executed_prompt = Some(executed)');
  });
});

describe('TEST 16：批量同效果三入口接线', () => {
  test('History 详情头按钮（成功生成 / 编辑任务）', () => {
    expect(history).toContain('批量同效果生成');
    expect(history).toContain('props.onStartSeries(task.id)');
    expect(history).toContain('canStartSeries');
    expect(history).toContain("<BatchSeriesDialog");
  });

  test('TaskQueue 成功卡按钮（终态 + 成功数 > 0 + generate/edit）', () => {
    expect(taskQueue).toContain('批量同效果生成');
    expect(taskQueue).toContain('setSeriesTaskId(task.id)');
    expect(taskQueue).toContain('task.success_count > 0');
    expect(taskQueue).toContain("<BatchSeriesDialog");
  });

  test('批量页「从已有任务导入（系列批量）」入口', () => {
    expect(imageStudio).toContain('从已有任务导入（系列批量）');
  });

  test('task_source=batch_series 的任务来源标签（两处页面都有）', () => {
    expect(history).toContain("'batch_series') return '系列批量'");
    expect(taskQueue).toContain("'batch_series') return '系列批量'");
  });
});
