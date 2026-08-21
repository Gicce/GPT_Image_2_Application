/**
 * 复刻方案页文案唯一来源（统一「调整要求」输入框 + 优化 + 生成）。
 *
 * 主流程：页面内统一输入框写大白话调整要求（状态切 dirty，绝不直接生图）
 * → 「优化复刻 Prompt」重建最终 Prompt（state → optimized）→ 选生成参数
 * → 「确认生成图片」。所有 toast 文案集中在此，供页面与测试共用，避免口径漂移。
 */

export const ADJUST_INPUT = {
  title: '调整要求',
  desc: '请直接输入你希望调整的内容。系统会结合复刻方案、锁定项和你的要求，通过 AI 重新优化生成新的最终 Prompt。',
  label: '调整要求',
  placeholder:
    '例如：\n· 把主体换成一个年轻女性，保持背景和构图不变\n· 整体改得更像电影海报，光线更柔和\n· 把衣服改成白色，背景不要动\n· 保持场景不变，让主体更突出\n· 让画面更梦幻一些，但不要改变构图',
} as const;

export const OPTIMIZE_TOAST = {
  /** 优化成功（dirty → optimized） */
  success: '优化完成，已生成新的最终生图 Prompt。现在可以确认生成图片。',
  /** ready / optimized 状态点优化按钮：空跑保护 */
  idleGuard: '当前 Prompt 已是最终生图 Prompt，可直接确认生成图片，无需重复优化。',
  /** dirty 但调整要求为空：先引导输入 */
  emptyInstruction: '请先在「调整要求」输入框中描述你希望调整的内容，再点击优化。',
} as const;

/** 「重新优化」：强制再执行一次 AI 优化（保留工作区全部内容；失败保留旧结果）。 */
export const REOPTIMIZE_ACTION = {
  label: '重新优化',
  /** Tooltip：明确会再次调用 AI（消耗 Token） */
  hint: '基于当前图片、分析结果与你的调整要求，重新调用 AI 优化生图 Prompt（会再次消耗 Token）。失败时保留现有结果。',
  emptyInstruction: '请先在「调整要求」输入框中描述你希望调整的内容，再重新优化。',
} as const;

/** 「重新开始」：确认后清空当前视觉理解工作区（不动历史任务与已生成图片）。 */
export const RESTART_ACTION = {
  label: '重新开始',
  dialogTitle: '重新开始视觉理解任务',
  dialogDesc: '确定开始新的视觉理解任务吗？当前工作区内容将被清空（图片、分析结果、调整要求与最终 Prompt；历史任务与已生成图片不受影响）。',
  confirmLabel: '清空并重新开始',
} as const;

/** 视觉理解页无可用视觉模型时的统一提示（模型管理是唯一事实源）。 */
export const NO_USABLE_VISION_MODEL =
  '当前没有可用的视觉模型，请先到模型管理中启用并测试一个支持图片理解的模型。';

export const GENERATE_DIALOG = {
  title: '确认生成图片',
  desc: '将携带当前最终 Prompt 与生成参数进入图片工作室（ImageStudio）创建生图任务，提交前可再检查参数。',
  confirmLabel: '确认，进入图片工作室',
} as const;

export const GENERATION_PARAMS = {
  title: '生成参数',
  hint: '与图片工作室图生图参数一致；比例与尺寸联动，生成时一并带入任务。',
  ratioLabel: '比例',
  sizeLabel: '尺寸',
  qualityLabel: '质量',
  countLabel: '生成数量',
  countUnit: '张',
} as const;

/** V4.0.8 生成方式：视觉理解只负责理解与出 Prompt，不强制文生图。 */
export const GENERATION_MODE = {
  title: '生成方式',
  t2iLabel: '文生图',
  i2iLabel: '图生图',
  /** 轻量用途说明（选择器下方一行）。 */
  t2iHint: '根据分析结果重新创作，不强制保持原图主体',
  i2iHint: '自动携带参考原图，更适合保持人物、服装与主体一致性',
  /** 确认弹层事实行。 */
  i2iFact: '图生图：参考原图将自动作为参考图带入图片工作室',
  t2iFact: '文生图：仅按最终 Prompt 生成，不携带原图',
} as const;

/**
 * 优化失败提示：按错误类别给出用户可理解的中文（不暴露技术细节）。
 * kind 由服务层归因（provider_error 原因已由 providerErrorCompact 翻译）。
 */
export function optimizeFailureMessage(error: string): string {
  const base = error.trim().replace(/。+$/, '');
  return `${base}。可点击「优化复刻 Prompt」重试，或调整要求后重新优化。`;
}
