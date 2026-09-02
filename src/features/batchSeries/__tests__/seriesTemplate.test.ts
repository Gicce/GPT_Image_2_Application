import { describe, expect, test } from 'vitest';
import type { Task } from '../../../types';
import { getBatchPreset } from '../batchPresets';
import {
  buildSeriesItems,
  buildSeriesTemplate,
  collectCompletedSeriesValues,
  detectPresetValue,
  hasResidualThemeValue,
  renderSeriesPrompt,
  type SeriesLockedConstraint,
} from '../seriesTemplate';

/**
 * V4.2.4 TEST 11 / 13 / 14 / 15 —— 系列模板引擎。
 *
 * 铁律：系列 = 固定部分 + 变量槽，不是任务复制；
 * 绝不在「马」Prompt 后追加「改成鼠」这类与原主题冲突的指令。
 */

const PRESET = getBatchPreset('chinese-zodiac')!;

function templateInput(overrides: Partial<Parameters<typeof buildSeriesTemplate>[0]> = {}) {
  return {
    sourceTaskId: 'task-horse-0001',
    sourcePositivePrompt: '一匹在草原上奔跑的骏马，电影质感',
    sourceNegativePrompt: ' 低清, 水印 ',
    sourceUserRequirement: '画一匹骏马',
    sourceTaskType: 'generate' as const,
    preset: PRESET,
    lockedConstraints: ['positive-prompt-base', 'negative-prompt'] as SeriesLockedConstraint[],
    referenceImages: [],
    generationParams: { size: '1024x1024', quality: 'high', format: 'png' },
    useSuccessImageAsReference: false,
    ...overrides,
  };
}

describe('detectPresetValue（主题原值检测）', () => {
  test('命中生肖值；多命中取最早出现位置', () => {
    expect(detectPresetValue('一匹骏马', PRESET)).toBe('马');
    expect(detectPresetValue('龙腾虎跃', PRESET)).toBe('龙');
    expect(detectPresetValue('一只可爱的小白兔和一条蛇', PRESET)).toBe('兔');
  });

  test('无命中返回 null（走追加式）', () => {
    expect(detectPresetValue('一辆红色的跑车', PRESET)).toBeNull();
  });
});

describe('buildSeriesTemplate（TEST 11：拆分而非追加）', () => {
  const template = buildSeriesTemplate(templateInput());

  test('TEST 11：检测到「马」→ 全部替换为 {{zodiac}} 槽（不是追加「改成鼠」）', () => {
    expect(template.sharedPositiveTemplate).toBe('一匹在草原上奔跑的骏{{zodiac}}，电影质感');
    expect(template.appendedDeclaration).toBe(false);
    // 绝对不能出现「改成」「换成」这类冲突追加指令
    expect(template.sharedPositiveTemplate).not.toContain('改成');
    expect(template.sharedPositiveTemplate).not.toContain('换成');
  });

  test('TEST 15：固定部分与锁定约束保留（负面词 trim 冻结）', () => {
    expect(template.sharedNegativePrompt).toBe('低清, 水印');
    expect(template.lockedConstraints).toEqual(['positive-prompt-base', 'negative-prompt']);
    expect(template.variableSlots[0]).toEqual({ key: 'zodiac', label: '生肖', originalValue: '马' });
    expect(template.presetId).toBe('chinese-zodiac');
    expect(template.presetName).toBe('十二生肖');
    expect(template.sourceUserRequirement).toBe('画一匹骏马');
  });

  test('主题值多次出现全部替换（无残留语义）', () => {
    const tpl = buildSeriesTemplate(templateInput({
      sourcePositivePrompt: '马与马的赛跑，马术比赛',
    }));
    expect(tpl.sharedPositiveTemplate).toBe('{{zodiac}}与{{zodiac}}的赛跑，{{zodiac}}术比赛');
  });

  test('未检出主题值 → 追加独立声明段（新段落，非冲突指令）', () => {
    const tpl = buildSeriesTemplate(templateInput({
      sourcePositivePrompt: '一辆红色的跑车，夕阳下的公路',
    }));
    expect(tpl.appendedDeclaration).toBe(true);
    expect(tpl.sharedPositiveTemplate).toBe('一辆红色的跑车，夕阳下的公路\n\n当前十二生肖主题：{{zodiac}}');
    expect(tpl.variableSlots[0].originalValue).toBeUndefined();
  });

  test('用户改判（themeValue=null 强制追加式 / 指定原值）', () => {
    const forced = buildSeriesTemplate(templateInput({ themeValue: null }));
    expect(forced.appendedDeclaration).toBe(true);
    const manual = buildSeriesTemplate(templateInput({ themeValue: '骏马' }));
    expect(manual.sharedPositiveTemplate).toBe('一匹在草原上奔跑的{{zodiac}}，电影质感');
    expect(manual.variableSlots[0].originalValue).toBe('骏马');
  });

  test('成功结果图路径透传（勾选「使用成功结果图作为系列视觉参考」）', () => {
    const tpl = buildSeriesTemplate(templateInput({
      useSuccessImageAsReference: true,
      successImagePath: 'D:/out/horse.png',
    }));
    expect(tpl.useSuccessImageAsReference).toBe(true);
    expect(tpl.successImagePath).toBe('D:/out/horse.png');
  });
});

describe('renderSeriesPrompt（TEST 14：逐项渲染）', () => {
  test('槽位替换为成员值', () => {
    expect(renderSeriesPrompt('骏{{zodiac}}，电影质感', { zodiac: '鼠' })).toBe('骏鼠，电影质感');
    expect(renderSeriesPrompt('{{zodiac}}与{{zodiac}}', { zodiac: '龙' })).toBe('龙与龙');
  });

  test('未定义的槽原样保留（便于发现遗漏）；非槽双大括号不动', () => {
    expect(renderSeriesPrompt('骏{{zodiac}}，{{color}}', { zodiac: '鼠' })).toBe('骏鼠，{{color}}');
    expect(renderSeriesPrompt('{{  zodiac }}', { zodiac: '鼠' })).toBe('{{  zodiac }}');
  });
});

describe('buildSeriesItems（TEST 13：跳过已完成）', () => {
  const template = buildSeriesTemplate(templateInput());

  test('全量成员 12 项、每项独立渲染 Prompt', () => {
    const items = buildSeriesItems({ template, preset: PRESET, skipCompleted: false });
    expect(items).toHaveLength(12);
    expect(items[0].prompt).toBe('一匹在草原上奔跑的骏鼠，电影质感');
    expect(items[6].prompt).toBe('一匹在草原上奔跑的骏马，电影质感');
    expect(items[0].negativePrompt).toBe('低清, 水印');
    expect(items.every(item => item.enabled)).toBe(true);
  });

  test('TEST 13：马已完成 + 跳过 → 11 项启用、马被禁用且标记 completed', () => {
    const items = buildSeriesItems({
      template, preset: PRESET, skipCompleted: true, completedValues: ['马'],
    });
    expect(items).toHaveLength(12);
    expect(items.filter(item => item.enabled)).toHaveLength(11);
    const horse = items.find(item => item.value === '马')!;
    expect(horse.enabled).toBe(false);
    expect(horse.completed).toBe(true);
  });

  test('label 与 value 都能匹配已完成集合', () => {
    const items = buildSeriesItems({
      template, preset: PRESET, skipCompleted: true, completedValues: ['zodiac-dragon-label'],
    });
    // label 未命中（'zodiac-dragon-label' 不是任何 label）→ 全部启用
    expect(items.every(item => item.enabled)).toBe(true);
  });

  test('不跳过已完成时 completed 项仍启用（仅展示标记）', () => {
    const items = buildSeriesItems({
      template, preset: PRESET, skipCompleted: false, completedValues: ['鼠', '牛'],
    });
    expect(items.filter(item => item.completed)).toHaveLength(2);
    expect(items.every(item => item.enabled)).toBe(true);
  });
});

describe('collectCompletedSeriesValues（完成主题扫描）', () => {
  function seriesTask(overrides: Partial<Task> = {}): Task {
    return {
      id: 't1', prompt: 'p', negative_prompt: '', user_prompt_raw: 'r',
      final_prompt: 'f', final_negative_prompt: '', prompt_optimized: false,
      size: '1024x1024', quality: 'auto', output_format: 'png', count: 2,
      status: 'completed', created_at: '2026-01-01', output_dir: '/tmp',
      success_count: 2, failed_count: 0, task_type: 'generate', source_images: [],
      execution_mode: 'batch', batch_strategy: '', batch_items: [],
      sub_tasks: [],
      task_source: 'batch_series',
      execution_snapshot: {
        schemaVersion: 1, userRequirement: 'r', positivePrompt: 'f', negativePrompt: '',
        effectivePrompt: 'f', promptSource: 'task-derived', referenceImages: [],
        generationParams: {},
        series: { presetId: 'chinese-zodiac' },
        items: [
          { label: '鼠', positivePrompt: 'p', negativePrompt: '', effectivePrompt: 'p', variables: { zodiac: '鼠' } },
          { label: '牛', positivePrompt: 'p', negativePrompt: '', effectivePrompt: 'p', variables: { zodiac: '牛' } },
        ],
      },
      ...overrides,
    } as Task;
  }

  test('同预设成功任务的 variables 值被收集', () => {
    const values = collectCompletedSeriesValues([seriesTask()], 'chinese-zodiac');
    expect(values).toEqual(['鼠', '牛']);
  });

  test('失败 / 无 success 任务不计入；其它预设不计入；去重', () => {
    const failed = seriesTask({ status: 'failed', success_count: 0 });
    const otherPreset = seriesTask({
      execution_snapshot: {
        ...seriesTask().execution_snapshot!,
        series: { presetId: 'four-seasons' },
      },
    });
    const dup = seriesTask();
    expect(collectCompletedSeriesValues([failed, otherPreset, dup], 'chinese-zodiac')).toEqual(['鼠', '牛']);
  });

  test('variables 缺失时回落 item.label 匹配', () => {
    const task = seriesTask({
      execution_snapshot: {
        ...seriesTask().execution_snapshot!,
        items: [
          { label: '虎', positivePrompt: 'p', negativePrompt: '', effectivePrompt: 'p' },
        ],
      },
    });
    expect(collectCompletedSeriesValues([task], 'chinese-zodiac')).toEqual(['虎']);
  });
});

describe('hasResidualThemeValue（残留自检）', () => {
  test('原值被完整替换后渲染结果无残留；手工写回则暴露', () => {
    const template = buildSeriesTemplate(templateInput());
    const ratPrompt = renderSeriesPrompt(template.sharedPositiveTemplate, { zodiac: '鼠' });
    expect(hasResidualThemeValue(ratPrompt, template)).toBe(false);
    expect(hasResidualThemeValue('一匹骏马与一匹骏鼠', template)).toBe(true);
  });
});
