import { describe, expect, test } from 'vitest';
import type { Task } from '../../../types';
import { getBatchPreset } from '../batchPresets';
import { buildSeriesTask, resolveSourceExecutedPrompts } from '../buildSeriesTask';
import { buildSeriesItems, buildSeriesTemplate } from '../seriesTemplate';

/**
 * V4.2.4 系列批量 → CreateTaskParams（复用现有批量引擎）。
 *
 * 铁律：系列任务 = 普通 batch Task + series 溯源，逐项执行 / 失败隔离 /
 * 按槽位重试 / 部分完成结算全部由现有引擎承担（零新执行路径）。
 */

const PRESET = getBatchPreset('chinese-zodiac')!;

function horseTemplate() {
  return buildSeriesTemplate({
    sourceTaskId: 'task-horse-0001',
    sourcePositivePrompt: '一匹在草原上奔跑的骏马，电影质感',
    sourceNegativePrompt: '低清, 水印',
    sourceUserRequirement: '画一匹骏马',
    sourceTaskType: 'generate',
    preset: PRESET,
    lockedConstraints: ['positive-prompt-base', 'negative-prompt', 'generation-params'],
    referenceImages: [],
    generationParams: { size: '1536x1024' },
    useSuccessImageAsReference: false,
  });
}

describe('resolveSourceExecutedPrompts（来源执行值解析）', () => {
  const legacy: Task = {
    id: 't', prompt: 'legacy-prompt', negative_prompt: 'legacy-neg',
    user_prompt_raw: 'legacy-raw', final_prompt: 'legacy-final',
    final_negative_prompt: 'legacy-final-neg',
    success_count: 1, sub_tasks: [], task_source: 'manual',
    execution_snapshot: {
      schemaVersion: 1, userRequirement: '快照需求', positivePrompt: '快照正向',
      negativePrompt: '快照负面', effectivePrompt: '快照正向\n\n画面中严格避免出现以下内容：快照负面',
      promptSource: 'ai-planning', referenceImages: [], generationParams: {},
    },
  } as unknown as Task;

  test('快照优先（fromSnapshot=true），绝不读当前项目态', () => {
    const result = resolveSourceExecutedPrompts(legacy);
    expect(result).toEqual({
      positivePrompt: '快照正向', negativePrompt: '快照负面',
      userRequirement: '快照需求', fromSnapshot: true,
    });
  });

  test('旧任务无快照 → final/prompt 回落（fromSnapshot=false，如实标注）', () => {
    const old = { ...legacy, execution_snapshot: undefined } as Task;
    const result = resolveSourceExecutedPrompts(old);
    expect(result.positivePrompt).toBe('legacy-final');
    expect(result.negativePrompt).toBe('legacy-final-neg');
    expect(result.userRequirement).toBe('legacy-raw');
    expect(result.fromSnapshot).toBe(false);
  });

  test('快照字段为空字符串时回落 legacy 字段（不拿空值当真相）', () => {
    const sparse = { ...legacy, execution_snapshot: { ...legacy.execution_snapshot!, negativePrompt: '' } } as Task;
    expect(resolveSourceExecutedPrompts(sparse).negativePrompt).toBe('legacy-final-neg');
  });
});

describe('buildSeriesTask（CreateTaskParams 构建）', () => {
  const template = horseTemplate();
  const items = buildSeriesItems({ template, preset: PRESET, skipCompleted: false });

  test('批量引擎兼容：execution_mode=batch + batch_items 全量 override', () => {
    const { params, total } = buildSeriesTask({
      template, items, presetId: PRESET.id,
      userRequirement: '十二生肖系列同效果',
      outputDir: 'D:/out', size: '1024x1024', quality: 'high', outputFormat: 'png',
    });
    expect(total).toBe(12);
    expect(params.execution_mode).toBe('batch');
    expect(params.batch_strategy).toBe('variant_set');
    expect(params.count).toBe(12);
    expect(params.batch_items!.every(item => (item.prompt_override ?? '').length > 0)).toBe(true);
    expect(params.batch_items![0].prompt_override).toBe('一匹在草原上奔跑的骏鼠，电影质感');
    expect(params.batch_items![6].prompt_override).toBe('一匹在草原上奔跑的骏马，电影质感');
    // 每成员负面词 override（不是只写任务级）
    expect(params.batch_items!.every(item => item.negative_override === '低清, 水印')).toBe(true);
    // 成员变量值透传（跳过已完成 / 历史回显的数据源）
    expect(params.batch_items![0].variables).toEqual({ zodiac: '鼠' });
  });

  test('系列溯源：task_source=batch_series + source_task_id + series 快照', () => {
    const { params } = buildSeriesTask({
      template, items, presetId: PRESET.id,
      userRequirement: '十二生肖系列同效果',
      outputDir: 'D:/out', size: '1024x1024', quality: 'high', outputFormat: 'png',
    });
    expect(params.task_source).toBe('batch_series');
    expect(params.source_task_id).toBe('task-horse-0001');
    expect(params.source_task_kind).toBe('image_task');
    const snapshot = params.execution_snapshot!;
    expect(snapshot.promptSource).toBe('task-derived');
    expect(snapshot.series?.presetId).toBe('chinese-zodiac');
    expect(snapshot.series?.sourceTaskId).toBe('task-horse-0001');
    expect(snapshot.series?.variableSlots?.[0].originalValue).toBe('马');
    expect(snapshot.items!).toHaveLength(12);
    expect(snapshot.items![0].variables).toEqual({ zodiac: '鼠' });
    expect(snapshot.items![0].effectivePrompt).toBe(
      '一匹在草原上奔跑的骏鼠，电影质感\n\n画面中严格避免出现以下内容：低清, 水印',
    );
  });

  test('禁用项不进入任务（跳过已完成 → 11 项）', () => {
    const enabled = buildSeriesItems({
      template, preset: PRESET, skipCompleted: true, completedValues: ['马'],
    });
    const { params, total } = buildSeriesTask({
      template, items: enabled, presetId: PRESET.id,
      userRequirement: '', outputDir: 'D:/out', size: 's', quality: 'q', outputFormat: 'png',
    });
    expect(total).toBe(11);
    expect(params.count).toBe(11);
    expect(params.batch_items!.some(item => item.variables?.zodiac === '马')).toBe(false);
    // userRequirement 缺省回落来源需求 / 模板
    expect(params.user_prompt_raw!.length).toBeGreaterThan(0);
  });

  test('全部禁用 → 抛错（至少启用一个成员）', () => {
    const allDisabled = items.map(item => ({ ...item, enabled: false }));
    expect(() => buildSeriesTask({
      template, items: allDisabled, presetId: PRESET.id,
      userRequirement: 'x', outputDir: 'D:/out', size: 's', quality: 'q', outputFormat: 'png',
    })).toThrow('至少启用一个系列成员');
  });

  test('图生图系列：成功结果图 + 原参考图进入 source_images（generate 不带）', () => {
    const editTemplate = buildSeriesTemplate({
      sourceTaskId: 'task-edit-0001',
      sourcePositivePrompt: '一匹在草原上奔跑的骏马，电影质感',
      sourceNegativePrompt: '', sourceUserRequirement: '画一匹骏马',
      sourceTaskType: 'edit', preset: PRESET,
      lockedConstraints: ['positive-prompt-base', 'reference-images'],
      referenceImages: ['D:/ref/original.png'],
      generationParams: {},
      useSuccessImageAsReference: true,
      successImagePath: 'D:/out/horse.png',
    });
    const editItems = buildSeriesItems({ template: editTemplate, preset: PRESET, skipCompleted: false });
    const { params } = buildSeriesTask({
      template: editTemplate, items: editItems, presetId: PRESET.id,
      userRequirement: 'x', outputDir: 'D:/out', size: 's', quality: 'q', outputFormat: 'png',
    });
    expect(params.task_type).toBe('edit');
    // 成功结果图在前，原参考图在后（去重）
    expect(params.source_images).toEqual(['D:/out/horse.png', 'D:/ref/original.png']);
    expect(params.batch_items![0].source_images).toEqual(['D:/out/horse.png', 'D:/ref/original.png']);
    expect(params.execution_snapshot!.referenceImages).toEqual([
      { path: 'D:/out/horse.png' }, { path: 'D:/ref/original.png' },
    ]);

    const { params: genParams } = buildSeriesTask({
      template, items, presetId: PRESET.id,
      userRequirement: 'x', outputDir: 'D:/out', size: 's', quality: 'q', outputFormat: 'png',
    });
    expect(genParams.task_type).toBe('generate');
    expect(genParams.source_images).toEqual([]);
  });

  test('失败隔离与按槽位重试兼容：标准 batch_items 结构（id/label/enabled）', () => {
    const { params } = buildSeriesTask({
      template, items, presetId: PRESET.id,
      userRequirement: 'x', outputDir: 'D:/out', size: 's', quality: 'q', outputFormat: 'png',
    });
    const first = params.batch_items![0];
    expect(first.id).toBe('zodiac-rat');
    expect(first.label).toBe('十二生肖 · 鼠');
    expect(first.enabled).toBe(true);
    // batch_items 与 count / sub_tasks 对齐由 Rust create_task 展开，params 只需 count 一致
    expect(params.count).toBe(params.batch_items!.length);
  });
});
