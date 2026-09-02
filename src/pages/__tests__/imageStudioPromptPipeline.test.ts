import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * V4.2.4 TEST 1 / 2 / 3 / 6 / 7 —— 图生图双规划器 + PromptDraft 统一语义（源守卫）。
 *
 * 锁定的规范（回归即失败）：
 * - 图生图双入口：AI 智能规划（纯文本，有无参考图都可用）+ 视觉理解优化（需 ≥1 参考图）
 * - 视觉理解优化无参考图 → disabled + tooltip「需要至少 1 张参考图片」，绝不静默可点
 * - 单一 PromptDraft 语义：绝不出现 `finalPrompt = optimizedPrompt || userRequirement`
 * - 过期不静默回落原文：必须弹「仍要用原文生成」确认层
 * - 负面词端到端：i2i 表单槽 → 采用结果 / 手填 → finalNegative → createAndExecuteTask
 * - 执行快照：生成前冻结并随任务创建提交（execution_snapshot）
 */

const tsx = readFileSync(resolve(__dirname, '../ImageStudio.tsx'), 'utf-8').replace(/\r\n/g, '\n');

describe('TEST 1：图生图双规划器共存', () => {
  test('两个按钮都在图生图模式下渲染（AI 智能规划 + 视觉理解优化）', () => {
    expect(tsx).toContain("onClick={() => void optimizeSingle('text')}");
    expect(tsx).toContain("onClick={() => void optimizeSingle('visual')}");
    expect(tsx).toContain('✨ AI 智能规划');
    expect(tsx).toContain('视觉理解优化');
    expect(tsx).toContain('正在规划…');
    expect(tsx).toContain('正在理解并优化…');
  });

  test('AI 智能规划按钮 disabled 条件不含 i2iSources（无参考图仍可用）', () => {
    // 按钮块内逐条断言：text 按钮 disabled 表达式只看 optimizing/promptText/optimizer/视觉链路锁定
    const textBtn = tsx.match(/<button[^>]*onClick=\{\(\) => void optimizeSingle\('text'\)\}[^>]*>/s);
    expect(textBtn).not.toBeNull();
    expect(textBtn![0]).toContain('disabled={optimizing || !promptText.trim() || !optimizerModelLabel || visualCarryLocked}');
    expect(textBtn![0]).not.toContain('i2iSources.length === 0');
  });

  test('文字规划链路走 optimizePrompt（planner 恢复），编辑任务 taskType=edit', () => {
    expect(tsx).toContain("await optimizePrompt({ prompt: promptText, taskType: isEdit ? 'edit' : 'generate' })");
  });
});

describe('TEST 2：视觉理解优化参考图门槛', () => {
  test('无参考图 → 按钮 disabled + tooltip「需要至少 1 张参考图片」', () => {
    const visualBtn = tsx.match(/<button[^>]*onClick=\{\(\) => void optimizeSingle\('visual'\)\}[^>]*>/s);
    expect(visualBtn).not.toBeNull();
    expect(visualBtn![0]).toContain('i2iSources.length === 0');
    expect(tsx).toContain("'需要至少 1 张参考图片'");
  });

  test('点击态运行时二次校验（错误信息同样口径）', () => {
    expect(tsx).toContain("if (kind === 'visual' && i2iSources.length === 0)");
    expect(tsx).toContain("'视觉理解优化需要至少 1 张参考图片。'");
  });

  test('视觉优化签名含参考图 / 文字规划签名不含（按 kind 区分，避免假过期）', () => {
    expect(tsx).toContain('sourceSignature: optimizationSignature(promptText, i2iSources)');
    expect(tsx).toContain('sourceSignature: optimizationSignature(promptText),');
  });
});

describe('TEST 3：单一 PromptDraft 语义（严禁 optimizedPrompt || userRequirement）', () => {
  test('finalPrompt 只经 adopted 三元判定（采用优化结果或原文，显式无静默顶替）', () => {
    expect(tsx).toContain('adopted ? opt.positivePrompt.trim() : promptText');
    // 反模式守卫：任何「优化结果 || 原文」的短路回退都视为回归
    expect(tsx).not.toMatch(/finalPrompt\s*=\s*opt\.positivePrompt\s*\|\|\s*promptText/);
    expect(tsx).not.toMatch(/optimizedPrompt\s*\|\|\s*(userRequirement|promptText|singlePrompt)/);
  });

  test('userRequirement / positivePrompt / negativePrompt 三元分离提交', () => {
    expect(tsx).toContain('user_prompt_raw: promptText');
    expect(tsx).toContain('prompt: finalPrompt');
    expect(tsx).toContain('finalNegative = (adopted ? opt.negativePrompt : manualNegative).trim()');
  });

  test('负面词 i2i 表单槽存在且双向绑定（负面不再只属于文生图）', () => {
    expect(tsx).toContain('imageEditNegative: i2iNegative');
    expect(tsx).toContain('value={isEdit ? i2iNegative : t2iNegative}');
  });

  test('Prompt 来源判定唯一入口（vision-recreation > 采用优化 > raw）', () => {
    expect(tsx).toContain("visionCarryMeta?.optimization\n      ? 'vision-recreation'");
    expect(tsx).toContain('resolveAdoptedPromptSource(opt.kind, opt.manuallyEdited)');
    expect(tsx).toContain(": 'raw'");
  });
});

describe('TEST 6/7：过期守卫 + 执行快照', () => {
  test('过期绝不静默回落：先弹确认层，用户显式选择后才能用原文生成', () => {
    expect(tsx).toContain('setStaleConfirmOpen(true)');
    expect(tsx).toContain('submitSingle({ bypassStaleGuard: true })');
    expect(tsx).toContain('此前的优化结果已过期');
    expect(tsx).toContain('当前需求或参考图已变化');
    expect(tsx).toContain('仍要用原文生成');
    // 守卫条件本体：未采用 + 过期 + 有历史优化结果 → 阻断
    expect(tsx).toContain('if (!options?.bypassStaleGuard && !adopted && optimizationStale && opt.positivePrompt.trim().length > 0)');
  });

  test('生成前冻结执行快照并随任务提交（execution_snapshot 唯一真相）', () => {
    expect(tsx).toContain('const executionSnapshot = buildSingleExecutionSnapshot({');
    expect(tsx).toContain('logPromptExecution(executionSnapshot, referenceImages.length)');
    expect(tsx).toContain('execution_snapshot: executionSnapshot,');
  });

  test('无 single/multi 参考图 Prompt 分叉（同一提交路径，参考图只决定走哪个优化器）', () => {
    // 提交只有一个 submitSingle；参考图仅作为 source_images 与快照 referenceImages
    expect(tsx.match(/async function submitSingle/g)).toHaveLength(1);
    expect(tsx).not.toMatch(/submitSingleFor|submitMultiRef/);
  });
});

describe('批量页统一规划（V4.2.4 延伸）', () => {
  test('批量视觉理解优化存在且同样有参考图门槛 + 批量负面词槽', () => {
    expect(tsx).toContain('async function optimizeBatchVisual()');
    expect(tsx).toContain('requirementNegative');
    expect(tsx).toContain('negativeHint: batch.requirementNegative.trim()');
  });

  test('批量方案快照：单方案 / N 方案两条构建路径都挂 execution_snapshot', () => {
    const batchPlans = readFileSync(resolve(__dirname, '../../utils/batchPlans.ts'), 'utf-8').replace(/\r\n/g, '\n');
    expect(batchPlans).toContain('execution_snapshot: buildSingleExecutionSnapshot({');
    expect(batchPlans).toContain('execution_snapshot: buildBatchExecutionSnapshot({');
  });

  test('系列批量入口：批量页「从已有任务导入」存在', () => {
    expect(tsx).toContain('从已有任务导入（系列批量）');
    expect(tsx).toContain('seriesDialogOpen');
    expect(tsx).toContain('<BatchSeriesDialog');
  });
});
