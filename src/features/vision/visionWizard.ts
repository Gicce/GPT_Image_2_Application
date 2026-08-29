/**
 * 视觉理解四步向导（V6.7 / V6.8）：纯视图层定义、门禁与统一工作流步骤状态。
 *
 * 步骤：1 视图理解 → 2 需求描述 → 3 素材替换 → 4 最终提示词。
 * - 步骤栏可随时点击回退；第 3 步门禁 = 必须先在第 2 步描述修改需求；
 * - 自动前进由页面挂接：理解结果就绪 → 进 2；Prompt 优化成功 → 2→3 / 3→4；
 * - V6.8 统一步骤状态模型：完成态只能由 getVisualWorkflowState 单一 selector 派生，
 *   禁止 UI 从零散字段（editState / revision / 面板折叠等）各自猜测；
 * - 「素材替换」完成 = 用户显式确认（materialReplacementDone，V6.8 新版显式状态）。
 *   旧项目缺省 false（保守恢复）——绝不凭「曾优化过」或「已有素材配置」反推完成；
 * - 本模块只做纯函数判定，绝不触碰 modificationDraft / semanticRevision / 优化链。
 */

export type VisionWizardStep = 1 | 2 | 3 | 4;

/** 步骤语义键（任务规范 §二的统一步骤模型）。 */
export type VisualWorkflowStepKey =
  | 'visualUnderstanding'
  | 'requirementDescription'
  | 'materialReplacement'
  | 'finalPrompt';

/** 步骤状态三态：待开始 / 进行中（可编辑）/ 已完成（显式确认或就绪）。 */
export type WorkflowStepStatus = 'pending' | 'current' | 'completed';

export interface VisionWizardStepDef {
  id: VisionWizardStep;
  key: VisualWorkflowStepKey;
  title: string;
  hint: string;
}

export const VISION_WIZARD_STEPS: readonly VisionWizardStepDef[] = [
  { id: 1, key: 'visualUnderstanding', title: '视图理解', hint: '上传原图，AI 完成视觉理解并提取复刻方案' },
  { id: 2, key: 'requirementDescription', title: '需求描述', hint: '描述你想怎么改；描述后优化，AI 优化完成自动进入素材替换' },
  { id: 3, key: 'materialReplacement', title: '素材替换', hint: '绑定人物 / 服装 / 维度参考素材；整理好后点击「继续」进入最终提示词' },
  { id: 4, key: 'finalPrompt', title: '最终提示词', hint: '查看 / 微调最终生图 Prompt 并确认生成' },
];

/**
 * 门禁 / 完成态判定的输入快照（页面从 workspace 派生，纯数据）。
 */
export interface VisionWizardContext {
  /** 视觉理解已完成（存在有效 AI 分析 / 复刻方案）。 */
  hasRecreation: boolean;
  /** 第 2 步已描述（freeText 非空或启用快捷维度）。 */
  described: boolean;
  /**
   * 素材替换已由用户显式确认（V6.8 新版持久化状态；
   * 旧项目 / 未确认 = false，绝不从优化产物反推）。
   */
  materialConfirmed: boolean;
  /** 最终 Prompt 已就绪（存在复刻方案且无需再优化）。 */
  promptReady: boolean;
}

export interface VisualWorkflowStep {
  id: VisionWizardStep;
  key: VisualWorkflowStepKey;
  status: WorkflowStepStatus;
}

export interface VisualWorkflowState {
  /** 第一个未完成步骤（全部完成时 = 4）。 */
  currentStep: VisionWizardStep;
  steps: readonly VisualWorkflowStep[];
}

/**
 * 统一工作流步骤状态 selector（唯一完成态来源）：
 *  - 1 视图理解：有分析 → completed，否则 current；
 *  - 2 需求描述：未理解 → pending；已描述 → completed，否则 current；
 *  - 3 素材替换：未描述 → pending；显式确认 → completed；否则 current
 *    （「没改任何素材」≠「已完成」——必须点「继续 · 生成最终提示词」显式确认）；
 *  - 4 最终提示词：前置未完成 → pending；Prompt 就绪 → completed；否则 current。
 */
export function getVisualWorkflowState(ctx: VisionWizardContext): VisualWorkflowState {
  const steps: readonly VisualWorkflowStep[] = [
    {
      id: 1,
      key: 'visualUnderstanding',
      status: ctx.hasRecreation ? 'completed' : 'current',
    },
    {
      id: 2,
      key: 'requirementDescription',
      status: !ctx.hasRecreation ? 'pending' : ctx.described ? 'completed' : 'current',
    },
    {
      id: 3,
      key: 'materialReplacement',
      status: !ctx.hasRecreation || !ctx.described
        ? 'pending'
        : ctx.materialConfirmed ? 'completed' : 'current',
    },
    {
      id: 4,
      key: 'finalPrompt',
      status: !(ctx.hasRecreation && ctx.described && ctx.materialConfirmed)
        ? 'pending'
        : ctx.promptReady ? 'completed' : 'current',
    },
  ];
  const firstIncomplete = steps.find(step => step.status !== 'completed');
  return { currentStep: firstIncomplete?.id ?? 4, steps };
}

/** 兼容便捷判定：某步是否已完成（内部走统一 selector，禁止另行猜测）。 */
export function visionStepDone(step: VisionWizardStep, ctx: VisionWizardContext): boolean {
  return getVisualWorkflowState(ctx).steps.find(item => item.id === step)?.status === 'completed';
}

/** 统一 selector 中某步的状态（步骤栏 / Rail 进度卡共用）。 */
export function visionStepStatus(step: VisionWizardStep, ctx: VisionWizardContext): WorkflowStepStatus {
  return getVisualWorkflowState(ctx).steps.find(item => item.id === step)?.status ?? 'pending';
}

/** 步骤可达性：不可达时给出面向用户的中文原因（页面 toast 呈现）。 */
export function visionStepReachable(
  step: VisionWizardStep,
  ctx: VisionWizardContext,
): { ok: boolean; reason?: string } {
  if (step >= 2 && !ctx.hasRecreation) {
    return { ok: false, reason: '请先完成第 1 步「视图理解」，AI 理解参考图后才能继续。' };
  }
  if (step === 3 && !ctx.described) {
    return { ok: false, reason: '进入素材替换前，请先在第 2 步「需求描述」描述你的修改需求；AI 优化完成后会自动进入这一步。' };
  }
  return { ok: true };
}
