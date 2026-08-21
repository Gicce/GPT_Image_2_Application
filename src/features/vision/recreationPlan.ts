/**
 * 结构化复刻方案（视觉理解 → 统一「调整要求」→ Prompt 优化 → 生图 链路核心）。
 *
 * 职责：
 *  - 把 VisionAnalysis（视觉模型结构化分析）编译为可编辑、可锁定的复刻方案字段；
 *  - 维护复刻方案的编辑状态机：ready（提取完成可直接生成）→ dirty（已修改待优化）
 *    → optimizing → optimized（优化完成可生成）。未修改时原始复刻 Prompt 即最终
 *    生图 Prompt（compileReversePrompt 已按 gpt_image 方言编译），禁止空跑一次优化；
 *  - 统一「调整要求」输入：大白话要求 + 锁定项共同构成 dirty 的修改内容，
 *    由 Prompt 优化器消化（锁定项在优化器内真正生效，不只是前端展示）；
 *  - 生成前的统一守卫 canGenerateFromRecreation（错误文案唯一来源）；
 *  - 主状态栏文案 describeRecreationStatus（状态 → 标签 / 色调 / 引导语唯一来源）；
 *  - 构建「带入图片生成」的草稿（含来源视觉理解任务 id、生成参数与优化快照，禁止二次优化）。
 */

import type { VisionAnalysis } from '../../types';

export type RecreationFieldKey =
  | 'subject'
  | 'pose'
  | 'composition'
  | 'camera'
  | 'scene'
  | 'lighting'
  | 'style'
  | 'color';

export interface RecreationPlanField {
  key: RecreationFieldKey;
  label: string;
  value: string;
  /** 锁定 = Prompt 优化时必须保持不变的维度（优化器会显式强化约束）。 */
  locked: boolean;
}

export interface VisualRecreationPlan {
  summary: string;
  fields: RecreationPlanField[];
  aspectRatio?: string;
}

export const PLAN_FIELD_LABELS: Record<RecreationFieldKey, string> = {
  subject: '人物 / 主体',
  pose: '动作',
  composition: '构图',
  camera: '镜头',
  scene: '背景 / 场景',
  lighting: '光线',
  style: '风格',
  color: '色彩',
};

/** 默认锁定项：主体可改，其余视觉结构锁定（防止优化时整体漂移）。 */
const DEFAULT_UNLOCKED: RecreationFieldKey[] = ['subject'];

function joinDefined(parts: Array<string | null | undefined>): string {
  return parts.map(p => (p || '').trim()).filter(Boolean).join('，');
}

/** VisionAnalysis → 结构化复刻方案（字段命名贴合现有 VisionAnalysis 体系）。 */
export function buildRecreationPlan(analysis: VisionAnalysis): VisualRecreationPlan {
  const primary = analysis.subjects[0];
  const subjectText = primary
    ? [
        primary.count && primary.count > 1 ? `${primary.count} 名` : '',
        primary.label,
        primary.appearance?.length ? `（${primary.appearance.join('、')}）` : '',
        primary.clothing?.length ? `，身着 ${primary.clothing.join('、')}` : '',
      ]
        .filter(Boolean)
        .join('')
    : '';

  const fields: RecreationPlanField[] = [
    {
      key: 'subject',
      label: PLAN_FIELD_LABELS.subject,
      value: subjectText || analysis.summary.slice(0, 60),
      locked: !DEFAULT_UNLOCKED.includes('subject'),
    },
    {
      key: 'pose',
      label: PLAN_FIELD_LABELS.pose,
      value: joinDefined([primary?.pose, primary?.action]),
      locked: true,
    },
    {
      key: 'composition',
      label: PLAN_FIELD_LABELS.composition,
      value: joinDefined([
        analysis.composition.subject_placement,
        analysis.composition.symmetry,
        analysis.composition.crop,
      ]),
      locked: true,
    },
    {
      key: 'camera',
      label: PLAN_FIELD_LABELS.camera,
      value: joinDefined([
        analysis.camera.shot_type,
        analysis.camera.angle,
        analysis.camera.depth_of_field,
      ]),
      locked: true,
    },
    {
      key: 'scene',
      label: PLAN_FIELD_LABELS.scene,
      value: joinDefined([
        analysis.scene.environment,
        analysis.scene.location,
        analysis.scene.background,
        analysis.scene.time_of_day,
      ]),
      locked: true,
    },
    {
      key: 'lighting',
      label: PLAN_FIELD_LABELS.lighting,
      value: joinDefined([
        analysis.lighting.source,
        analysis.lighting.direction,
        analysis.lighting.softness,
        analysis.lighting.contrast,
      ]),
      locked: true,
    },
    {
      key: 'style',
      label: PLAN_FIELD_LABELS.style,
      value: joinDefined([
        analysis.style.category,
        analysis.style.medium,
        analysis.style.rendering,
      ]),
      locked: true,
    },
    {
      key: 'color',
      label: PLAN_FIELD_LABELS.color,
      value: joinDefined([
        analysis.colors.dominant_palette?.slice(0, 6).join(' '),
        analysis.colors.temperature,
        analysis.colors.saturation,
      ]),
      locked: true,
    },
  ];

  return { summary: analysis.summary, fields, aspectRatio: undefined };
}

/**
 * 复刻方案编辑状态机（四态语义严格拆分）：
 *  - ready：初始提取完成，原始复刻 Prompt 即最终生图 Prompt，可直接生成；
 *  - dirty：调整要求 / 锁定项 / 原始 Prompt 已修改，必须先优化；
 *  - optimizing：正在执行「优化复刻 Prompt」；
 *  - optimized：修改后优化完成，可确认生成。
 */
export type RecreationEditState = 'ready' | 'dirty' | 'optimizing' | 'optimized';

export interface RecreationState {
  plan: VisualRecreationPlan;
  /** 视觉理解编译出的原始复刻 Prompt（描述事实，保留展示）。 */
  originalPrompt: string;
  originalNegativePrompt: string;
  editState: RecreationEditState;
  /** 用户是否已做修改（决定生图前是否必须重新优化）。 */
  modified: boolean;
  /** 统一「调整要求」输入框内容（大白话；优化器的主要输入之一）。 */
  adjustInstruction: string;
  /** 最近一次「优化复刻 Prompt」失败原因（dirty 状态下非空 → 主状态栏显示「优化失败」）。 */
  optimizeError?: string;
  /** 当前生效的最终生图 Prompt（未修改时 = originalPrompt）。 */
  optimizedPrompt?: string;
  optimizedNegativePrompt?: string;
  /** 优化器生成的人读摘要（任务提示 / 历史记录展示）。 */
  summary?: string;
  optimizedBy?: 'analysis' | 'optimizer';
  optimizedAt?: string;
  providerName?: string;
  modelName?: string;
}

/** 初始状态：分析完成即 ready（未修改不强制空跑优化）。 */
export function initialRecreationState(
  plan: VisualRecreationPlan,
  originalPrompt: string,
  originalNegativePrompt: string,
): RecreationState {
  return {
    plan,
    originalPrompt,
    originalNegativePrompt,
    editState: 'ready',
    modified: false,
    adjustInstruction: '',
    optimizedPrompt: originalPrompt,
    optimizedNegativePrompt: originalNegativePrompt,
    optimizedBy: 'analysis',
  };
}

/** 任何修改（调整要求 / 锁定项 / 原始 Prompt）统一进入 dirty。 */
export function markRecreationDirty(state: RecreationState): RecreationState {
  return { ...state, editState: 'dirty', modified: true, optimizeError: undefined };
}

/**
 * 统一「调整要求」输入框变更：
 *  - 有内容 → dirty（记录 adjustInstruction，清空历史失败原因）；
 *  - 清空且从未成功优化过 → 回到 ready（没有待消化的修改，避免空指令卡死在 dirty）；
 *  - 清空但已有优化产物 → 保持 dirty（内容变化即 dirty，需重新优化或重新输入）。
 */
export function applyAdjustmentInput(state: RecreationState, value: string): RecreationState {
  const instruction = value.trim();
  if (instruction) {
    return { ...markRecreationDirty(state), adjustInstruction: instruction };
  }
  if (state.editState === 'ready' || state.optimizedBy !== 'optimizer') {
    return { ...state, adjustInstruction: '', editState: 'ready', modified: false, optimizeError: undefined };
  }
  return { ...markRecreationDirty(state), adjustInstruction: '' };
}

/** 切换锁定项：锁定状态立即生效并进入 dirty（锁定项参与下一次优化）。 */
export function togglePlanFieldLock(state: RecreationState, key: RecreationFieldKey): RecreationState {
  const fields = state.plan.fields.map(f => (f.key === key ? { ...f, locked: !f.locked } : f));
  return { ...markRecreationDirty(state), plan: { ...state.plan, fields } };
}

/** 「优化复刻 Prompt」开始：dirty → optimizing。 */
export function markOptimizing(state: RecreationState): RecreationState {
  return { ...state, editState: 'optimizing', optimizeError: undefined };
}

/** 「优化复刻 Prompt」失败：回到 dirty 并记录失败原因（状态栏切红色「优化失败」）。 */
export function markOptimizationFailed(
  state: RecreationState,
  error: string,
): RecreationState {
  return { ...state, editState: 'dirty', optimizeError: error };
}

// ===== 生图守卫（错误文案唯一来源，测试锚点） =====

export type GenerationReadiness =
  | { allowed: true }
  | { allowed: false; reason: string };

export function canGenerateFromRecreation(state: RecreationState | null): GenerationReadiness {
  if (!state) {
    return { allowed: false, reason: '视觉理解尚未完成，暂时不能生成图片。' };
  }
  if (state.editState === 'optimizing') {
    return { allowed: false, reason: '正在优化提示词，请稍候再确认生成。' };
  }
  if (state.editState === 'dirty' || state.modified) {
    return { allowed: false, reason: '当前方案已修改但尚未优化，请先点击【优化复刻 Prompt】。' };
  }
  if (!state.optimizedPrompt || !state.optimizedPrompt.trim()) {
    return { allowed: false, reason: '当前缺少可用于生图的最终 Prompt，请先执行提示词优化。' };
  }
  return { allowed: true };
}

/** 重复点击优化时是否需要再次优化：只有 dirty 才需要（ready / optimized 直接用现成 Prompt）。 */
export function needsReoptimization(state: RecreationState): boolean {
  return state.editState === 'dirty';
}

// ===== 主状态栏（状态 → 标签 / 色调 / 引导语，文案唯一来源，测试锚点） =====

export type RecreationStatusKey =
  | 'not_extracted'
  | 'ready'
  | 'dirty'
  | 'optimizing'
  | 'optimized'
  | 'optimize_failed';

/** 色调与 UI 一一对应：gray=未提取 / orange=待优化 / blue=优化中 / green=可生成 / red=失败。 */
export type RecreationStatusTone = 'gray' | 'orange' | 'blue' | 'green' | 'red';

export interface RecreationStatusInfo {
  key: RecreationStatusKey;
  label: string;
  tone: RecreationStatusTone;
  /** 状态栏引导语：告诉用户当前处于流程哪一步、下一步做什么。 */
  note: string;
}

export function describeRecreationStatus(state: RecreationState | null): RecreationStatusInfo {
  if (!state) {
    return {
      key: 'not_extracted',
      label: '未提取',
      tone: 'gray',
      note: '请先分析参考图，提取结构化复刻方案。',
    };
  }
  if (state.editState === 'optimizing') {
    return {
      key: 'optimizing',
      label: '正在优化',
      tone: 'blue',
      note: '正在结合复刻方案、锁定项与你的调整要求优化提示词，完成后即可确认生成图片。',
    };
  }
  if (state.editState === 'dirty') {
    if (state.optimizeError) {
      return {
        key: 'optimize_failed',
        label: '优化失败',
        tone: 'red',
        note: `优化失败：${state.optimizeError}。可点击「优化复刻 Prompt」重试，或调整要求后重新优化。`,
      };
    }
    return {
      key: 'dirty',
      label: '已修改，待优化',
      tone: 'orange',
      note: '已记录你的调整要求。请点击「优化复刻 Prompt」重建最终 Prompt，再确认生成图片。',
    };
  }
  if (state.editState === 'optimized') {
    return {
      key: 'optimized',
      label: '已优化，可生成',
      tone: 'green',
      note: '最终生图 Prompt 已按你的调整要求重建完成。点击「确认生成图片」进入图片工作室（提交时不会重复优化）。',
    };
  }
  return {
    key: 'ready',
    label: '可直接生成',
    tone: 'green',
    note: '原始复刻 Prompt 即最终生图 Prompt。可直接确认生成图片（提交时不会执行 AI 优化），也可在下方输入调整要求。',
  };
}

// ===== 优化结果落位 =====

export function applyOptimizationResult(
  state: RecreationState,
  result: {
    optimizedPrompt: string;
    optimizedNegativePrompt: string;
    summary: string;
    providerName?: string;
    modelName?: string;
  },
): RecreationState {
  return {
    ...state,
    editState: 'optimized',
    // 修改已被本轮优化消化：modified 复位，否则优化后仍会被生图守卫拦截
    modified: false,
    optimizeError: undefined,
    optimizedPrompt: result.optimizedPrompt,
    optimizedNegativePrompt: result.optimizedNegativePrompt,
    summary: result.summary,
    optimizedBy: 'optimizer',
    optimizedAt: new Date().toISOString(),
    providerName: result.providerName,
    modelName: result.modelName,
  };
}

// ===== 带入图片生成（来源链路 + 生成参数 + 禁止二次优化） =====

export interface GenerationCarryMeta {
  prompt: string;
  negativePrompt: string;
  sourceVisionSessionId?: string;
  sourceVisionTaskId?: string;
  taskPlanSummary?: string;
  /** 用户在复刻页选择的生成参数（尺寸 / 质量 / 数量；比例经尺寸体现）。 */
  size?: string;
  quality?: string;
  count?: number;
  /** V4.0.8 生成方式：i2i = 原图自动成为参考图（复刻 / 人物锁定优先）。 */
  generationMode?: 't2i' | 'i2i';
  /** V4.0.8 图生图参考图：视觉理解工作区原图路径（复用素材，不重复导入）。 */
  sourceImagePath?: string;
  sourceAssetId?: string;
  /** 已优化标记：ImageStudio 提交时冻结快照，绝不再执行一次 AI 优化。 */
  optimization?: {
    providerName?: string;
    modelName?: string;
    originalPrompt: string;
    optimizedAt: string;
  };
}

/** 从复刻方案构建「确认生成图片」草稿（调用前必须先过 canGenerateFromRecreation）。 */
export function buildGenerationCarry(
  state: RecreationState,
  extra: {
    sourceVisionSessionId?: string;
    sourceVisionTaskId?: string;
    size?: string;
    quality?: string;
    count?: number;
    /** V4.0.8 生成方式与图生图参考图（原图来自视觉理解工作区）。 */
    generationMode?: 't2i' | 'i2i';
    sourceImagePath?: string;
    sourceAssetId?: string;
  },
): GenerationCarryMeta {
  const instruction = state.adjustInstruction.trim();
  const actionLabel = instruction
    ? `按「${instruction.slice(0, 40)}」调整`
    : '直接复刻';
  return {
    prompt: state.optimizedPrompt?.trim() || state.originalPrompt,
    negativePrompt: state.optimizedNegativePrompt?.trim() || state.originalNegativePrompt,
    sourceVisionSessionId: extra.sourceVisionSessionId,
    sourceVisionTaskId: extra.sourceVisionTaskId,
    taskPlanSummary: `基于视觉理解复刻方案${actionLabel}生成`,
    size: extra.size,
    quality: extra.quality,
    count: extra.count,
    generationMode: extra.generationMode,
    sourceImagePath: extra.sourceImagePath,
    sourceAssetId: extra.sourceAssetId,
    optimization: {
      providerName: state.providerName,
      modelName: state.modelName,
      originalPrompt: state.originalPrompt,
      optimizedAt: state.optimizedAt || new Date().toISOString(),
    },
  };
}
