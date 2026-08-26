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

import type { GenerationImageReference, GenerationProvenanceSnapshot, VisionAnalysis } from '../../types';

export type RecreationFieldKey =
  | 'subject'
  | 'clothing'
  | 'pose'
  | 'composition'
  | 'camera'
  | 'scene'
  | 'lighting'
  | 'style'
  | 'color';

/** 全部维度 key（固定顺序；优化器 changed_dimensions 校验与测试矩阵的单一来源）。 */
export const RECREATION_FIELD_KEYS: RecreationFieldKey[] = [
  'subject', 'clothing', 'pose', 'composition', 'camera', 'scene', 'lighting', 'style', 'color',
];

/**
 * 锁定来源（优先级：user_override > intent > default）：
 *  - default：初始提取的默认保留（软约束，AI 可按修改意图打开）；
 *  - intent：本轮 AI 按修改意图判定为需要修改 / 保持的维度；
 *  - user_override：用户手动切换过（硬约束，后续 AI 重新判定不得覆盖）。
 * 旧会话数据缺省该字段 → 视为 default。
 */
export type FieldLockSource = 'default' | 'intent' | 'user_override';

export interface RecreationPlanField {
  key: RecreationFieldKey;
  label: string;
  value: string;
  /** 锁定 = Prompt 优化时必须保持不变的维度（优化器会显式强化约束）。 */
  locked: boolean;
  /** V4.1：锁定来源（旧数据缺省 = default）。 */
  lockSource?: FieldLockSource;
  /** V4.1：初始分析值（维度 Diff 的「原」侧；旧数据缺省 = 不展示维度 Diff）。 */
  originalValue?: string;
}

export interface VisualRecreationPlan {
  summary: string;
  fields: RecreationPlanField[];
  aspectRatio?: string;
}

export const PLAN_FIELD_LABELS: Record<RecreationFieldKey, string> = {
  subject: '人物 / 主体',
  clothing: '服装 / 造型',
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
      ]
        .filter(Boolean)
        .join('')
    : '';

  const clothingText = primary?.clothing?.length ? primary.clothing.join('，') : '';

  const fields: RecreationPlanField[] = [
    {
      key: 'subject',
      label: PLAN_FIELD_LABELS.subject,
      value: subjectText || analysis.summary.slice(0, 60),
      locked: !DEFAULT_UNLOCKED.includes('subject'),
      lockSource: 'default',
      originalValue: subjectText || analysis.summary.slice(0, 60),
    },
    {
      key: 'clothing',
      label: PLAN_FIELD_LABELS.clothing,
      value: clothingText,
      locked: true,
      lockSource: 'default',
      originalValue: clothingText,
    },
    {
      key: 'pose',
      label: PLAN_FIELD_LABELS.pose,
      value: joinDefined([primary?.pose, primary?.action]),
      locked: true,
      lockSource: 'default',
      originalValue: joinDefined([primary?.pose, primary?.action]),
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
      lockSource: 'default',
      originalValue: joinDefined([
        analysis.composition.subject_placement,
        analysis.composition.symmetry,
        analysis.composition.crop,
      ]),
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
      lockSource: 'default',
      originalValue: joinDefined([
        analysis.camera.shot_type,
        analysis.camera.angle,
        analysis.camera.depth_of_field,
      ]),
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
      lockSource: 'default',
      originalValue: joinDefined([
        analysis.scene.environment,
        analysis.scene.location,
        analysis.scene.background,
        analysis.scene.time_of_day,
      ]),
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
      lockSource: 'default',
      originalValue: joinDefined([
        analysis.lighting.source,
        analysis.lighting.direction,
        analysis.lighting.softness,
        analysis.lighting.contrast,
      ]),
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
      lockSource: 'default',
      originalValue: joinDefined([
        analysis.style.category,
        analysis.style.medium,
        analysis.style.rendering,
      ]),
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
      lockSource: 'default',
      originalValue: joinDefined([
        analysis.colors.dominant_palette?.slice(0, 6).join(' '),
        analysis.colors.temperature,
        analysis.colors.saturation,
      ]),
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

/**
 * 优化快照（Replication Boost 解耦 §B）：一次成功优化 = 一份「条件 → 产物」快照。
 * 条件签名 = 合成指令原文 + 复刻方案结构签名（维度 / 锁定 / 值）。
 * 用户把条件改回历史快照的一致状态（例如仅取消「提高复刻度」）时，
 * 直接恢复对应产物——附加可逆意图绝不破坏已优化成功的可用方案。
 */
export interface OptimizationSnapshotEntry {
  /** 产出该结果的合成指令原文（adjustInstruction）。 */
  instruction: string;
  /** 产出该结果时的复刻方案结构签名（恢复时必须仍一致）。 */
  planSignature: string;
  optimizedPrompt: string;
  optimizedNegativePrompt: string;
  summary?: string;
  optimizedAt: string;
  providerName?: string;
  modelName?: string;
  optimizerModelId?: string;
}

/** 快照保留上限（同一指令去重更新；超出裁剪最旧）。 */
const OPTIMIZATION_SNAPSHOT_LIMIT = 8;

/** 复刻方案结构签名（维度 key + 锁定 + 锁定来源 + 当前值；纯函数）。 */
export function signatureOfRecreationPlan(plan: VisualRecreationPlan): string {
  return JSON.stringify(
    plan.fields.map(field => [field.key, field.locked ? 1 : 0, field.lockSource ?? 'default', field.value]),
  );
}

/** 快照合法化（持久化恢复：形状校验，无效条目丢弃）。 */
function normalizeOptimizationHistory(raw: unknown): OptimizationSnapshotEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: OptimizationSnapshotEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const instruction = typeof record.instruction === 'string' ? record.instruction.trim() : '';
    const prompt = typeof record.optimizedPrompt === 'string' ? record.optimizedPrompt.trim() : '';
    if (!instruction || !prompt) continue;
    entries.push({
      instruction,
      planSignature: typeof record.planSignature === 'string' ? record.planSignature : '',
      optimizedPrompt: prompt,
      optimizedNegativePrompt: typeof record.optimizedNegativePrompt === 'string' ? record.optimizedNegativePrompt : '',
      summary: typeof record.summary === 'string' && record.summary.trim() ? record.summary : undefined,
      optimizedAt: typeof record.optimizedAt === 'string' ? record.optimizedAt : new Date().toISOString(),
      providerName: typeof record.providerName === 'string' ? record.providerName : undefined,
      modelName: typeof record.modelName === 'string' ? record.modelName : undefined,
      optimizerModelId: typeof record.optimizerModelId === 'string' ? record.optimizerModelId : undefined,
    });
  }
  return entries;
}

export interface RecreationState {
  plan: VisualRecreationPlan;
  /** 视觉理解编译出的原始复刻 Prompt（描述事实，保留展示）。 */
  originalPrompt: string;
  originalNegativePrompt: string;
  editState: RecreationEditState;
  /**
   * V4.1 语义修订模型（View State 与 Semantic State 分离的核心）：
   *  - semanticRevision：只有真实语义修改（自然语言要求 / 维度 / 人物 / 服装 / 参考资产）才 +1；
   *  - optimizedRevision：优化成功时对齐 semanticRevision；
   *  - needsOptimization = semanticRevision !== optimizedRevision（派生，替代旧的粘滞 modified 标记）。
   * 折叠 / 展开 / Tab / Viewer / 选中缩略图等纯 UI 操作绝不改变 revision。
   */
  semanticRevision: number;
  optimizedRevision: number;
  /** 统一「调整要求」输入框内容（大白话 + 结构化修改意图合成；优化器的主要输入之一）。 */
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
  /** V4.1 Optimizer Provenance：执行时模型快照（之后换模型不影响历史展示）。 */
  optimizerModelId?: string;
  optimizerProviderId?: string;
  optimizerSource?: 'manual' | 'follow' | 'default' | 'fallback';
  optimizerFallbackReason?: string;
  /**
   * Dimension Lock（§21）：本轮优化器试图改写锁定维度而被强制忽略的 key
   * （存在即说明优化器越权；最终值一律采用模板基线，绝不采纳其改写）。
   */
  optimizerViolations?: RecreationFieldKey[];
  /**
   * 优化快照史（Replication Boost 解耦）：每次优化成功按指令去重落一份；
   * 条件改回历史一致状态（如仅取消「提高复刻度」）时自动恢复，无需重新优化。
   */
  optimizationHistory?: OptimizationSnapshotEntry[];
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
    semanticRevision: 0,
    optimizedRevision: 0,
    adjustInstruction: '',
    optimizedPrompt: originalPrompt,
    optimizedNegativePrompt: originalNegativePrompt,
    optimizedBy: 'analysis',
  };
}

/**
 * 旧持久化数据（vision_workspace_v1 / vision_sessions_v1）缺 revision 字段的迁移：
 * 旧 `modified: true` → 语义修订领先 1（保持「已修改待优化」语义），否则双双归 0。
 */
export function normalizeRecreationState(state: RecreationState): RecreationState {
  const history = normalizeOptimizationHistory(state.optimizationHistory);
  const withHistory: RecreationState = history.length > 0
    ? { ...state, optimizationHistory: history }
    : state;
  if (typeof withHistory.semanticRevision === 'number' && typeof withHistory.optimizedRevision === 'number') {
    return withHistory;
  }
  const legacyModified = (withHistory as RecreationState & { modified?: boolean }).modified === true;
  return {
    ...withHistory,
    semanticRevision: legacyModified ? 1 : 0,
    optimizedRevision: 0,
  };
}

/** 是否需要重新优化（唯一派生判定；纯 UI 操作不改变 revision 因而不影响本函数）。 */
export function needsOptimization(state: RecreationState): boolean {
  return state.semanticRevision !== state.optimizedRevision;
}

/** 任何真实语义修改（调整要求 / 锁定项 / 原始 Prompt / 结构化修改意图）统一进入 dirty。 */
export function markRecreationDirty(state: RecreationState): RecreationState {
  return {
    ...state,
    editState: 'dirty',
    semanticRevision: state.semanticRevision + 1,
    optimizeError: undefined,
  };
}

/**
 * 结构化修改意图合成指令落位（V4.1 修改意图 = 自由文本 + 快捷维度 + 人物替换 + 服装策略）：
 *  - 有内容且与某份优化快照的条件完全一致（指令 + 方案结构签名）→ 直接恢复该快照
 *    （Replication Boost 解耦：仅取消「提高复刻度」回到既有条件 ⇒ 自动复原已优化结果，
 *    绝不强迫用户重新优化一次）；
 *  - 有内容但无匹配快照 → dirty（revision +1，记录合成指令，清空历史失败原因）；
 *  - 内容清空且无待消化修改 → 维持现状（优化产物仍有效，绝不空指令卡死在 dirty）；
 *  - 内容清空但有待消化修改 → 对齐 revision（用户放弃未优化的修改，保留当前生效 Prompt）。
 */
export function applyModificationInstruction(state: RecreationState, instruction: string): RecreationState {
  const next = instruction.trim();
  if (next) {
    const snapshot = findRestorableSnapshot(state, next);
    if (snapshot) {
      return restoreOptimizationSnapshot(state, next, snapshot);
    }
    return { ...markRecreationDirty(state), adjustInstruction: next };
  }
  if (!needsOptimization(state)) {
    return { ...state, adjustInstruction: '', optimizeError: undefined };
  }
  return { ...revertToLastSuccessfulPrompt(state), adjustInstruction: '' };
}

/** 条件完全一致的快照才可恢复：指令相同 + 方案结构签名相同（有产物）。 */
export function findRestorableSnapshot(
  state: RecreationState,
  instruction: string,
): OptimizationSnapshotEntry | null {
  const target = instruction.trim();
  const signature = signatureOfRecreationPlan(state.plan);
  const entries = state.optimizationHistory ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.instruction === target && entry.planSignature === signature && entry.optimizedPrompt.trim()) {
      return entry;
    }
  }
  return null;
}

/** 恢复快照：修订对齐 + 优化产物 / 溯源字段整体回贴（保持 optimized 语义完整）。 */
function restoreOptimizationSnapshot(
  state: RecreationState,
  instruction: string,
  entry: OptimizationSnapshotEntry,
): RecreationState {
  return {
    ...state,
    editState: 'optimized',
    semanticRevision: state.optimizedRevision,
    adjustInstruction: instruction.trim(),
    optimizeError: undefined,
    optimizedPrompt: entry.optimizedPrompt,
    optimizedNegativePrompt: entry.optimizedNegativePrompt,
    summary: entry.summary,
    optimizedBy: 'optimizer',
    optimizedAt: entry.optimizedAt,
    providerName: entry.providerName,
    modelName: entry.modelName,
    optimizerModelId: entry.optimizerModelId,
  };
}

/** 兼容旧调用名：统一「调整要求」输入框变更（语义同 applyModificationInstruction）。 */
export function applyAdjustmentInput(state: RecreationState, value: string): RecreationState {
  return applyModificationInstruction(state, value);
}

/** 切换锁定项：用户手动操作 → lockSource=user_override（后续 AI 判定不得覆盖），状态进入 dirty。 */
export function togglePlanFieldLock(state: RecreationState, key: RecreationFieldKey): RecreationState {
  const fields = state.plan.fields.map(f =>
    f.key === key ? { ...f, locked: !f.locked, lockSource: 'user_override' as FieldLockSource } : f,
  );
  return { ...markRecreationDirty(state), plan: { ...state.plan, fields } };
}

/**
 * 结构化维度意图落位（优化成功的配套动作）：
 *  - changedDimensions = 本轮优化中 AI 判定「按用户修改意图需要修改」的维度；
 *  - 优先级强制：user_override 字段保持用户设定（锁定值与原值都不动，即使 AI 报告改了它）；
 *  - 其余字段：在 changed 内 → 解锁（lockSource=intent）+ 更新维度值；不在 → 锁定（default）；
 *  - lockedBaseline（Dimension Lock §21）：锁定维度的值强制回填模板 canonical 基线
 *    （修复历史漂移：旧会话被越权改写的锁定值在下一次优化时回归模板）；
 *  - 未知 key 一律忽略；dimensionValues 缺失时仅更新锁定状态，不改值。
 */
export function applyDimensionIntent(
  state: RecreationState,
  changedDimensions: RecreationFieldKey[],
  dimensionValues?: Partial<Record<RecreationFieldKey, string>>,
  lockedBaseline?: Partial<Record<RecreationFieldKey, string>>,
): RecreationState {
  const changed = new Set(changedDimensions.filter(key => RECREATION_FIELD_KEYS.includes(key)));
  const fields = state.plan.fields.map(field => {
    if (field.lockSource === 'user_override') return field;
    const isChanged = changed.has(field.key);
    const baseline = lockedBaseline?.[field.key]?.trim();
    const nextValue = isChanged
      ? (dimensionValues?.[field.key] ?? field.value).trim() || field.value
      : baseline ?? field.value;
    return {
      ...field,
      locked: !isChanged,
      lockSource: 'intent' as FieldLockSource,
      value: nextValue,
    };
  });
  return { ...state, plan: { ...state.plan, fields } };
}

// ===== Dimension Lock Enforcement（§21：优化器输出无权改写锁定维度） =====

export interface DimensionLockEnforcement {
  /** 模板锁定维度（用户未启用修改且未手动开放）。 */
  lockedKeys: RecreationFieldKey[];
  /** 锁定维度的模板 canonical 基线（清洗后回填）。 */
  baseline: Partial<Record<RecreationFieldKey, string>>;
}

/**
 * 优化器结果强制清洗（结构性守门，不依赖模型自觉）：
 *  - changed_dimensions 里的锁定维度 → 剔除并记入 violations；
 *  - dimension_values 里的锁定维度 → 丢弃（模板没有的值绝不引入，§24）；
 *  - 违规记录落在 state.optimizerViolations，最终值一律 = 模板基线。
 */
export function enforceOptimizerDimensionLocks(
  changedDimensions: ReadonlyArray<RecreationFieldKey>,
  dimensionValues: Partial<Record<RecreationFieldKey, string>>,
  locks: DimensionLockEnforcement,
): {
  changedDimensions: RecreationFieldKey[];
  dimensionValues: Partial<Record<RecreationFieldKey, string>>;
  violations: RecreationFieldKey[];
} {
  const locked = new Set(locks.lockedKeys);
  const violations = changedDimensions.filter(key => locked.has(key));
  const changed = changedDimensions.filter(key => !locked.has(key));
  const values: Partial<Record<RecreationFieldKey, string>> = {};
  for (const key of Object.keys(dimensionValues) as RecreationFieldKey[]) {
    if (!locked.has(key)) values[key] = dimensionValues[key];
  }
  return { changedDimensions: changed, dimensionValues: values, violations };
}

/**
 * 「使用上一次 Prompt」：优化失败 / 待优化时放弃当前修改，回退到最近一次成功的
 * 最终 Prompt（无优化史时回退 ready = 原始复刻 Prompt）。调用方需同步刷新
 * promptDraft / negativeDraft / 修改意图草稿。
 */
export function revertToLastSuccessfulPrompt(state: RecreationState): RecreationState {
  const hasOptimizerResult = state.optimizedBy === 'optimizer' && !!state.optimizedPrompt?.trim();
  return {
    ...state,
    editState: hasOptimizerResult ? 'optimized' : 'ready',
    semanticRevision: state.optimizedRevision,
    optimizeError: undefined,
    adjustInstruction: '',
    optimizedPrompt: state.optimizedPrompt?.trim() || state.originalPrompt,
    optimizedNegativePrompt: state.optimizedNegativePrompt?.trim() || state.originalNegativePrompt,
  };
}

/** 是否存在可回退的「上一次成功 Prompt」（失败横幅显示「使用上一次 Prompt」的条件）。 */
export function hasSuccessfulPrompt(state: RecreationState | null): boolean {
  if (!state) return false;
  return !!state.optimizedPrompt?.trim();
}

/**
 * 「优化复刻 Prompt」开始：dirty → optimizing。
 * 从已对齐状态（ready / optimized，如「重新优化」）发起 = 一次新的待消化语义尝试：
 * revision +1，失败后保持领先（守卫拦截 + 状态栏显示「优化失败」+ 可回退上一次 Prompt）。
 */
export function markOptimizing(state: RecreationState): RecreationState {
  const pendingAttempt = state.semanticRevision === state.optimizedRevision
    ? { semanticRevision: state.semanticRevision + 1 }
    : {};
  return { ...state, editState: 'optimizing', optimizeError: undefined, ...pendingAttempt };
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
  if (needsOptimization(state)) {
    return { allowed: false, reason: '当前方案已修改但尚未优化，请先点击【优化复刻 Prompt】。' };
  }
  if (!state.optimizedPrompt || !state.optimizedPrompt.trim()) {
    return { allowed: false, reason: '当前缺少可用于生图的最终 Prompt，请先执行提示词优化。' };
  }
  return { allowed: true };
}

/** 重复点击优化时是否需要再次优化：语义修订落后才需要（ready / optimized 直接用现成 Prompt）。 */
export function needsReoptimization(state: RecreationState): boolean {
  return needsOptimization(state);
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
  if (needsOptimization(state)) {
    if (state.optimizeError) {
      const fallback = state.optimizedBy === 'optimizer' && state.optimizedPrompt?.trim()
        ? '上一次成功的 Prompt 仍在，可点「使用上一次 Prompt」直接生成。'
        : '';
      return {
        key: 'optimize_failed',
        label: '优化失败',
        tone: 'red',
        note: `优化失败：${state.optimizeError}。可点击「优化复刻 Prompt」重试。${fallback}`,
      };
    }
    return {
      key: 'dirty',
      label: '已修改，待重新优化',
      tone: 'orange',
      note: '已记录你的调整要求（因为你修改了条件）。请点击「优化复刻 Prompt」重建最终 Prompt。'
        + ((state.optimizationHistory ?? []).length > 0
          ? '此前的优化结果已保留：把条件改回上一次（例如仅取消「提高复刻度」）会自动恢复对应优化结果，不会丢失。'
          : ''),
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
    /** V4.1 Optimizer Provenance：执行时模型快照。 */
    optimizerModelId?: string;
    optimizerProviderId?: string;
    optimizerSource?: 'manual' | 'follow' | 'default' | 'fallback';
    optimizerFallbackReason?: string;
    /** V4.1：AI 判定的本轮需修改维度（存在即同步落位锁定来源，空缺 = 保持现锁定结构）。 */
    changedDimensions?: RecreationFieldKey[];
    /** V4.1：AI 重建后的各维度值（维度 Diff 的「新」侧；只对非 user_override 字段生效）。 */
    dimensionValues?: Partial<Record<RecreationFieldKey, string>>;
    /** Dimension Lock（§21）：传入即先做锁定清洗——优化器对锁定维度的改写被忽略。 */
    dimensionLocks?: DimensionLockEnforcement;
  },
): RecreationState {
  const enforced = result.dimensionLocks && result.changedDimensions
    ? enforceOptimizerDimensionLocks(result.changedDimensions, result.dimensionValues ?? {}, result.dimensionLocks)
    : null;
  const withIntent = enforced
    ? applyDimensionIntent(
      state,
      enforced.changedDimensions,
      enforced.dimensionValues,
      result.dimensionLocks?.baseline,
    )
    : result.changedDimensions
      ? applyDimensionIntent(state, result.changedDimensions, result.dimensionValues)
      : state;
  const optimizedAt = new Date().toISOString();
  // 优化快照（Replication Boost 解耦）：按指令去重落一份「条件 → 产物」，
  // 条件改回一致状态时 applyModificationInstruction 直接恢复（无需重新优化）。
  const instruction = withIntent.adjustInstruction.trim();
  const nextHistory = [
    ...(withIntent.optimizationHistory ?? []).filter(entry => entry.instruction !== instruction),
    ...(instruction && result.optimizedPrompt.trim()
      ? [{
        instruction,
        planSignature: signatureOfRecreationPlan(withIntent.plan),
        optimizedPrompt: result.optimizedPrompt,
        optimizedNegativePrompt: result.optimizedNegativePrompt,
        summary: result.summary,
        optimizedAt,
        providerName: result.providerName,
        modelName: result.modelName,
        optimizerModelId: result.optimizerModelId,
      }]
      : []),
  ].slice(-OPTIMIZATION_SNAPSHOT_LIMIT);
  return {
    ...withIntent,
    editState: 'optimized',
    // 修改已被本轮优化消化：修订对齐，否则优化后仍会被生图守卫拦截
    optimizedRevision: withIntent.semanticRevision,
    optimizeError: undefined,
    optimizedPrompt: result.optimizedPrompt,
    optimizedNegativePrompt: result.optimizedNegativePrompt,
    summary: result.summary,
    optimizedBy: 'optimizer',
    optimizedAt,
    providerName: result.providerName,
    modelName: result.modelName,
    optimizerModelId: result.optimizerModelId,
    optimizerProviderId: result.optimizerProviderId,
    optimizerSource: result.optimizerSource,
    optimizerFallbackReason: result.optimizerFallbackReason,
    optimizerViolations: enforced && enforced.violations.length > 0 ? enforced.violations : undefined,
    ...(nextHistory.length > 0 ? { optimizationHistory: nextHistory } : {}),
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
  /** V4.1 人物替换参考图（i2i 时作为第二张参考图；身份 / 脸部 / 发型 / 体型）。 */
  personReferencePath?: string;
  /** V4.0.9.1 带角色的生成参考图（顺序 = 最终提交 gpt-image-2 的图片顺序）。 */
  imageReferences?: GenerationImageReference[];
  /** V4.0.9.1 人物替换语义（驱动确定性图片使用说明指令编译）。 */
  personReplacement?: {
    enabled: boolean;
    clothingPolicy?: string;
    customClothing?: string;
  };
  /** V4.0.9 生成溯源快照：用户原话 / 修改方案 / 参考图角色 / 服装策略 / 模型记录。 */
  provenance?: GenerationProvenanceSnapshot;
  /** V4.1 Prompt Compiler：prompt 已分层编译（carryApply 不再前置图片使用说明）。 */
  promptCompiled?: boolean;
  /** V4.1 Region V1：区域合成 mask 路径（真实进入 create_task.mask_image → edits mask 部件）。 */
  maskImagePath?: string;
  /** V4.1 Visual Project 来源（任务冻结项目 id / 名称 / 修订）。 */
  projectId?: string;
  projectName?: string;
  projectRevision?: number;
  /** 已优化标记：ImageStudio 提交时冻结快照，绝不再执行一次 AI 优化。 */
  optimization?: {
    providerName?: string;
    modelName?: string;
    /** V4.1 Provenance：执行时优化器模型 id 与路由来源。 */
    modelId?: string;
    source?: 'manual' | 'follow' | 'default' | 'fallback';
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
    /** V4.1 人物替换参考图路径（i2i 时作为第二张参考图带入图片工作室）。 */
    personReferencePath?: string;
    /** V4.0.9.1 带角色的生成参考图（顺序 = 提交顺序；写入 carry.imageReferences）。 */
    imageReferences?: GenerationImageReference[];
    /** V4.0.9.1 人物替换语义（写入 carry.personReplacement）。 */
    personReplacement?: {
      enabled: boolean;
      clothingPolicy?: string;
      customClothing?: string;
    };
    /** V4.0.9 生成溯源快照（页面在生成时刻构建，随 Task 冻结落库）。 */
    provenance?: GenerationProvenanceSnapshot;
    /** V4.1 Prompt Compiler：prompt 已分层编译（carryApply 不再前置图片使用说明）。 */
    promptCompiled?: boolean;
    /** V4.1 Region V1：区域合成 mask 路径（真实进入 create_task.mask_image）。 */
    maskImagePath?: string;
    /** V4.1 Visual Project 来源（任务冻结项目 id / 名称 / 修订）。 */
    projectId?: string;
    projectName?: string;
    projectRevision?: number;
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
    personReferencePath: extra.personReferencePath,
    imageReferences: extra.imageReferences,
    personReplacement: extra.personReplacement,
    provenance: extra.provenance,
    promptCompiled: extra.promptCompiled,
    maskImagePath: extra.maskImagePath,
    projectId: extra.projectId,
    projectName: extra.projectName,
    projectRevision: extra.projectRevision,
    optimization: {
      providerName: state.providerName,
      modelName: state.modelName,
      modelId: state.optimizerModelId,
      source: state.optimizerSource,
      originalPrompt: state.originalPrompt,
      optimizedAt: state.optimizedAt || new Date().toISOString(),
    },
  };
}
