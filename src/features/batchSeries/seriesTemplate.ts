/**
 * V4.2.4 批量同效果生成 —— 系列模板引擎（纯函数层）。
 *
 * 核心思想：把成功任务的实际执行 Prompt 拆成「固定部分 + 变量槽」，
 * 每个系列成员独立渲染、独立快照、独立执行 —— 绝不是简单复制任务，
 * 也绝不在原 Prompt 后追加「改成鼠」这类与原主题冲突的指令。
 *
 *   来源 Prompt「一匹在草原上奔跑的骏马，电影质感」
 *     --(检测到原主题值「马」→ 替换为槽)-->
 *   模板「一匹在草原上奔跑的骏{{zodiac}}，电影质感」
 *     --(逐项渲染 12 次)-->
 *   「…骏鼠…」「…骏牛…」… 每项自带 Execution Snapshot
 *
 * 用户必须能预览 / 修改模板与每一项（弹窗内完成，见 BatchSeriesDialog）。
 */

import type { Task } from '../../types';
import type { BatchPreset } from './batchPresets';

/** 一致性规则 slug（继承勾选；与 UI 文案一一对应，禁止组件自造） */
export type SeriesLockedConstraint =
  | 'positive-prompt-base'   // 正向 Prompt 基底（固定部分）
  | 'negative-prompt'        // 负面 Prompt
  | 'style'                  // 画风（含在 Prompt 文本内）
  | 'generation-params'      // 尺寸 / 质量 / 格式
  | 'reference-images'       // 来源任务参考图
  | 'success-image-reference'; // 成功结果图作为系列视觉参考

export const SERIES_LOCKED_CONSTRAINT_LABELS: Record<SeriesLockedConstraint, string> = {
  'positive-prompt-base': '正向 Prompt 基底（固定部分）',
  'negative-prompt': '负面 Prompt',
  'style': '画风与画面描述',
  'generation-params': '生成参数（尺寸 / 质量 / 格式）',
  'reference-images': '原参考图片',
  'success-image-reference': '使用成功结果图作为系列视觉参考',
};

export interface SeriesVariableSlot {
  /** 模板槽名（{{zodiac}}） */
  key: string;
  /** 展示名（生肖） */
  label: string;
  /** 从来源 Prompt 检测到的原始值（如「马」）；追加式时缺省 */
  originalValue?: string;
}

export interface BatchPromptTemplate {
  sourceTaskId: string;
  /** 共享正向模板：固定文案 + {{key}} 变量槽（用户可编辑） */
  sharedPositiveTemplate: string;
  sharedNegativePrompt: string;
  lockedConstraints: SeriesLockedConstraint[];
  variableSlots: SeriesVariableSlot[];
  /** 使用的预设（记录便于历史回显「十二生肖」） */
  presetId?: string;
  presetName?: string;
  /**
   * true = 来源 Prompt 中未找到原主题值，模板采用「文末追加声明」
   * （追加「当前十二生肖主题：{{zodiac}}」全新段落，不与原文任何主题冲突）。
   */
  appendedDeclaration: boolean;
  referenceImages: string[];
  generationParams: { size?: string; quality?: string; format?: string };
  useSuccessImageAsReference: boolean;
  successImagePath?: string;
  /** 来源任务的用户原始需求（快照 / 展示用） */
  sourceUserRequirement: string;
  sourceTaskType: 'generate' | 'edit';
}

/**
 * 本地确定性检测：来源 Prompt 中出现的预设主题值。
 * 多个命中时取「出现位置最早、同一位置取更长词」——启发式仅供初判，
 * 结果在弹窗中始终展示且可改判（含「未包含主题 → 改用追加式」）。
 */
export function detectPresetValue(text: string, preset: BatchPreset): string | null {
  const hits: Array<{ needle: string; position: number }> = [];
  for (const item of preset.items) {
    for (const needle of [item.label, item.value]) {
      const position = text.indexOf(needle);
      if (position >= 0) hits.push({ needle, position });
    }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.position - b.position || b.needle.length - a.needle.length);
  return hits[0].needle;
}

export interface BuildSeriesTemplateInput {
  sourceTaskId: string;
  /** 来源任务实际执行的正向 Prompt（execution_snapshot.positivePrompt 优先） */
  sourcePositivePrompt: string;
  sourceNegativePrompt: string;
  sourceUserRequirement: string;
  sourceTaskType: 'generate' | 'edit';
  preset: BatchPreset;
  /** 主题原值：undefined = 自动检测；null = 强制无（追加式）；字符串 = 用户改判 */
  themeValue?: string | null;
  lockedConstraints: SeriesLockedConstraint[];
  referenceImages: string[];
  generationParams: { size?: string; quality?: string; format?: string };
  useSuccessImageAsReference: boolean;
  successImagePath?: string;
}

/** 来源任务 → 系列模板（拆分固定部分 + 变量槽；绝不追加冲突指令）。 */
export function buildSeriesTemplate(input: BuildSeriesTemplateInput): BatchPromptTemplate {
  const detected = input.themeValue === undefined
    ? detectPresetValue(input.sourcePositivePrompt, input.preset)
    : input.themeValue;
  const trimmedSource = input.sourcePositivePrompt.trim();
  let sharedPositiveTemplate: string;
  let appendedDeclaration = false;
  let originalValue: string | undefined;
  if (detected) {
    // 固定+变量拆分：原主题值全部替换为槽位（渲染后原值语义被完整替换，无残留）
    originalValue = detected;
    sharedPositiveTemplate = trimmedSource.split(detected).join(`{{${input.preset.variableKey}}}`);
  } else {
    // 追加式：原文不含可识别主题值 → 追加独立声明段（新段落，不是「改成 X」的冲突指令）
    appendedDeclaration = true;
    sharedPositiveTemplate = `${trimmedSource}\n\n当前${input.preset.name}主题：{{${input.preset.variableKey}}}`;
  }
  return {
    sourceTaskId: input.sourceTaskId,
    sharedPositiveTemplate,
    sharedNegativePrompt: input.sourceNegativePrompt.trim(),
    lockedConstraints: input.lockedConstraints,
    variableSlots: [{
      key: input.preset.variableKey,
      label: input.preset.variableLabel,
      ...(originalValue ? { originalValue } : {}),
    }],
    presetId: input.preset.id,
    presetName: input.preset.name,
    appendedDeclaration,
    referenceImages: input.referenceImages,
    generationParams: input.generationParams,
    useSuccessImageAsReference: input.useSuccessImageAsReference,
    ...(input.successImagePath ? { successImagePath: input.successImagePath } : {}),
    sourceUserRequirement: input.sourceUserRequirement,
    sourceTaskType: input.sourceTaskType,
  };
}

/** 模板 + 变量取值 → 该成员的最终正向 Prompt（未定义槽原样保留 {{key}}，便于发现遗漏）。 */
export function renderSeriesPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-zA-Z][a-zA-Z0-9_-]*)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match);
}

export interface SeriesItemDraft {
  presetItemId: string;
  /** 成员展示名（如「鼠」） */
  label: string;
  /** 渲染进变量槽的值 */
  value: string;
  /** 本成员最终正向 Prompt（模板渲染结果，可逐项编辑） */
  prompt: string;
  negativePrompt: string;
  enabled: boolean;
  /** 主题完成判定初值（跳过已完成的默认勾选来源；用户可改判） */
  completed: boolean;
}

export interface BuildSeriesItemsInput {
  template: BatchPromptTemplate;
  preset: BatchPreset;
  /** 已完成主题的取值集合（label 或 value 匹配任一即算） */
  completedValues?: string[];
  skipCompleted: boolean;
}

/** 模板 → 全部系列成员草稿（每项独立 Prompt，完成项默认禁用）。 */
export function buildSeriesItems(input: BuildSeriesItemsInput): SeriesItemDraft[] {
  const slotKey = input.template.variableSlots[0]?.key ?? input.preset.variableKey;
  const completedValues = input.completedValues ?? [];
  return input.preset.items.map(item => {
    const completed = completedValues.includes(item.label) || completedValues.includes(item.value);
    return {
      presetItemId: item.id,
      label: item.label,
      value: item.value,
      prompt: renderSeriesPrompt(input.template.sharedPositiveTemplate, { [slotKey]: item.value }),
      negativePrompt: input.template.sharedNegativePrompt,
      enabled: !(input.skipCompleted && completed),
      completed,
    };
  });
}

/**
 * 扫描任务历史：同预设系列任务中已成功产出的主题值（「跳过已完成」的数据源）。
 * 只认 success_count > 0 的任务；variables 缺失时回落 label 匹配。
 */
export function collectCompletedSeriesValues(tasks: Task[], presetId: string): string[] {
  const values: string[] = [];
  for (const task of tasks) {
    const series = task.execution_snapshot?.series;
    if (!series || series.presetId !== presetId) continue;
    if (task.success_count <= 0) continue;
    const slotKey = series.variableSlots?.[0]?.key;
    for (const item of task.execution_snapshot?.items ?? []) {
      const value = (slotKey && item.variables?.[slotKey]) || item.label;
      if (value && !values.includes(value)) values.push(value);
    }
  }
  return values;
}

/**
 * 残留检测（测试 / 自检用）：渲染结果中不应再出现原主题值
 * （原值被完整替换；若用户手工把原值写回模板，这里能暴露出来）。
 */
export function hasResidualThemeValue(renderedPrompt: string, template: BatchPromptTemplate): boolean {
  const original = template.variableSlots[0]?.originalValue;
  if (!original) return false;
  return renderedPrompt.includes(original);
}
