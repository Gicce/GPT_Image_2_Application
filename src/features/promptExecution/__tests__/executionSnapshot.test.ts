import { describe, expect, test, vi, afterEach } from 'vitest';
import {
  buildBatchExecutionSnapshot,
  buildSingleExecutionSnapshot,
  composeEffectivePrompt,
  logPromptExecution,
  promptSourceLabel,
  PROMPT_SOURCE_LABELS,
  resolveAdoptedPromptSource,
} from '../executionSnapshot';
import type { PromptSource } from '../../../types';

/**
 * V4.2.4 TEST 4 / 5 / 8 / 9 —— Execution Snapshot 统一执行链路。
 *
 * 铁律：Execute what you save, display what you executed.
 *  - effectivePrompt 组合必须与 Rust compose_model_instruction 逐字一致（镜像）
 *  - 快照字段创建时冻结（trim / schemaVersion / provider / model）
 *  - 批量快照 items[] 每成员独立三元组 + variables 透传
 *  - userRequirement ≠ positivePrompt ≠ effectivePrompt（严禁互相顶替）
 */

describe('composeEffectivePrompt（Rust compose_model_instruction 镜像）', () => {
  test('TEST 5：负面词按适配层格式拼接（与 Rust 逐字一致）', () => {
    expect(composeEffectivePrompt('一匹骏马', '低清, 文字')).toBe(
      '一匹骏马\n\n画面中严格避免出现以下内容：低清, 文字',
    );
  });

  test('无负面词 = 纯正向（不追加空段）', () => {
    expect(composeEffectivePrompt('一匹骏马', '')).toBe('一匹骏马');
    expect(composeEffectivePrompt('一匹骏马', '   ')).toBe('一匹骏马');
  });

  test('首尾空白两侧各自 trim（不破坏中间换行）', () => {
    expect(composeEffectivePrompt('  一匹骏马  ', ' 低清 ')).toBe(
      '一匹骏马\n\n画面中严格避免出现以下内容：低清',
    );
  });
});

describe('PROMPT_SOURCE_LABELS（七来源唯一文案表）', () => {
  test('TEST 6：七个 PromptSource 全部有中文文案，无同义词分叉', () => {
    const sources: PromptSource[] = [
      'raw', 'ai-planning', 'visual-understanding', 'manual-edited',
      'vision-recreation', 'task-derived', 'batch-derived',
    ];
    for (const source of sources) {
      expect(PROMPT_SOURCE_LABELS[source].length).toBeGreaterThan(0);
    }
    expect(promptSourceLabel('ai-planning')).toBe('AI 智能规划');
    expect(promptSourceLabel('visual-understanding')).toBe('视觉理解优化');
    expect(promptSourceLabel('task-derived')).toBe('任务派生');
  });

  test('未知 / 缺失回落：null → 原始输入；未知 slug 原样返回', () => {
    expect(promptSourceLabel(null)).toBe('原始输入');
    expect(promptSourceLabel(undefined)).toBe('原始输入');
    expect(promptSourceLabel('future-source')).toBe('future-source');
  });
});

describe('resolveAdoptedPromptSource（采用来源唯一判定）', () => {
  test('text → ai-planning；visual → visual-understanding；手工修改优先', () => {
    expect(resolveAdoptedPromptSource('text', false)).toBe('ai-planning');
    expect(resolveAdoptedPromptSource('visual', false)).toBe('visual-understanding');
    expect(resolveAdoptedPromptSource('text', true)).toBe('manual-edited');
    expect(resolveAdoptedPromptSource('visual', true)).toBe('manual-edited');
  });
});

describe('buildSingleExecutionSnapshot（TEST 4：单张快照冻结）', () => {
  const snapshot = buildSingleExecutionSnapshot({
    userRequirement: '  画一匹骏马  ',
    positivePrompt: ' 一匹在草原上奔跑的骏马，电影质感 ',
    negativePrompt: ' 低清, 水印 ',
    promptSource: 'ai-planning',
    referenceImages: [
      { path: 'D:/img/a.png', label: '骏马参考', role: 'source_reference', id: 'img-1' },
      { path: 'D:/img/b.png' },
    ],
    generationParams: { size: '1024x1024', quality: 'high', format: 'png' },
    createdAt: '2026-08-29T00:00:00.000Z',
  });

  test('字段创建时冻结并 trim（schemaVersion=1 + provider/model 常量）', () => {
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.userRequirement).toBe('画一匹骏马');
    expect(snapshot.positivePrompt).toBe('一匹在草原上奔跑的骏马，电影质感');
    expect(snapshot.negativePrompt).toBe('低清, 水印');
    expect(snapshot.provider).toBe('packyapi');
    expect(snapshot.model).toBe('gpt-image-2');
    expect(snapshot.createdAt).toBe('2026-08-29T00:00:00.000Z');
  });

  test('TEST 4：userRequirement ≠ positivePrompt ≠ effectivePrompt（三者严禁互相顶替）', () => {
    expect(snapshot.userRequirement).not.toBe(snapshot.positivePrompt);
    expect(snapshot.effectivePrompt).toBe(
      '一匹在草原上奔跑的骏马，电影质感\n\n画面中严格避免出现以下内容：低清, 水印',
    );
    expect(snapshot.effectivePrompt).not.toBe(snapshot.positivePrompt);
    expect(snapshot.effectivePrompt).toContain('严格避免');
  });

  test('参考图逐张冻结（可选字段缺省时不落空键）', () => {
    expect(snapshot.referenceImages).toHaveLength(2);
    expect(snapshot.referenceImages[0]).toEqual({
      id: 'img-1', path: 'D:/img/a.png', label: '骏马参考', role: 'source_reference',
    });
    expect(snapshot.referenceImages[1]).toEqual({ path: 'D:/img/b.png' });
    expect('label' in snapshot.referenceImages[1]).toBe(false);
  });

  test('缺省 createdAt 自动补 ISO 时间', () => {
    const snap = buildSingleExecutionSnapshot({
      userRequirement: 'r', positivePrompt: 'p', negativePrompt: '', promptSource: 'raw',
    });
    expect(snap.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snap.generationParams).toEqual({});
  });
});

describe('buildBatchExecutionSnapshot（TEST 8/9：批量每成员独立快照）', () => {
  const snapshot = buildBatchExecutionSnapshot({
    userRequirement: '十二生肖系列',
    positivePrompt: '一匹骏{{zodiac}}，电影质感',
    negativePrompt: '低清',
    promptSource: 'batch-derived',
    items: [
      { label: '鼠', positivePrompt: '一匹骏鼠，电影质感', negativePrompt: '低清', variables: { zodiac: '鼠' } },
      { label: '牛', positivePrompt: '一匹骏牛，电影质感', negativePrompt: '', variables: { zodiac: '牛' } },
      { label: '虎', positivePrompt: '一匹骏虎，电影质感', negativePrompt: '' },
    ],
    series: {
      sourceTaskId: 'task-src-0001',
      presetId: 'chinese-zodiac',
      variableSlots: [{ key: 'zodiac', label: '生肖', originalValue: '马' }],
      lockedConstraints: ['positive-prompt-base', 'negative-prompt'],
    },
    createdAt: '2026-08-29T00:00:00.000Z',
  });

  test('TEST 8：items 每成员独立三元组 + effectivePrompt 逐项组合', () => {
    expect(snapshot.items!).toHaveLength(3);
    expect(snapshot.items![0].effectivePrompt).toBe(
      '一匹骏鼠，电影质感\n\n画面中严格避免出现以下内容：低清',
    );
    expect(snapshot.items![1].effectivePrompt).toBe('一匹骏牛，电影质感');
    expect(snapshot.items![1].variables).toEqual({ zodiac: '牛' });
  });

  test('空 variables 不落键（普通批量为纯方案，无变量）', () => {
    expect(snapshot.items![2].variables).toBeUndefined();
  });

  test('TEST 9：series 溯源完整透传（来源任务 / 预设 / 变量槽 / 锁定约束）', () => {
    expect(snapshot.series?.sourceTaskId).toBe('task-src-0001');
    expect(snapshot.series?.presetId).toBe('chinese-zodiac');
    expect(snapshot.series?.variableSlots?.[0]).toEqual({ key: 'zodiac', label: '生肖', originalValue: '马' });
    expect(snapshot.series?.lockedConstraints).toContain('positive-prompt-base');
  });

  test('无 series 的普通批量：不落 series 键', () => {
    const snap = buildBatchExecutionSnapshot({
      userRequirement: 'r', positivePrompt: 'p', negativePrompt: '',
      promptSource: 'batch-derived',
      items: [{ label: '方案 1', positivePrompt: 'p1', negativePrompt: '' }],
    });
    expect(snap.series).toBeUndefined();
  });
});

describe('logPromptExecution（开发日志只打长度，不打内容）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test('日志字段只有长度 / 来源 / 数量，绝无 Prompt 全文与密钥', () => {
    vi.stubEnv('MODE', 'development');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const snap = buildSingleExecutionSnapshot({
      userRequirement: '画一匹骏马',
      positivePrompt: '一匹骏马',
      negativePrompt: '低清',
      promptSource: 'raw',
    });
    logPromptExecution(snap, 2);
    expect(spy).toHaveBeenCalled();
    const tag = spy.mock.calls[0][0];
    expect(tag).toBe('[PromptExecution]');
    const payload = spy.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual([
      'source', 'referenceImageCount', 'positivePromptLength',
      'negativePromptLength', 'effectivePromptLength', 'provider', 'model',
    ]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('一匹骏马');
    expect(serialized).not.toContain('低清');
  });

  test('非 development 模式静默（生产不出任何日志）', () => {
    vi.stubEnv('MODE', 'production');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logPromptExecution(buildSingleExecutionSnapshot({
      userRequirement: 'r', positivePrompt: 'p', negativePrompt: '', promptSource: 'raw',
    }), 0);
    expect(spy).not.toHaveBeenCalled();
  });
});
