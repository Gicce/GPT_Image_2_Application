/**
 * 复刻方案页文案唯一来源（统一「你想怎么修改这张图片？」+ 优化 + 生成 + 评价闭环）。
 *
 * 主流程（V4.0.9 简化工作流）：选原图 → AI 理解（summary 常驻、详细分析折叠）
 * → 输入修改意图（大白话，状态切 dirty，绝不直接生图）→「优化复刻 Prompt」重建
 * 最终 Prompt →「确认生成图片」→ 生成结果 + AI 评价 + 用户反馈 → 继续调整。
 * 所有 toast 文案集中在此，供页面与测试共用，避免口径漂移。
 */

export const ADJUST_INPUT = {
  title: '你想怎么修改这张图片？',
  desc: '点击快捷按钮选择要修改的维度，或直接描述需求。输入 @ 可引用当前任务图片，例如：「把 @图二 的人物换成 @图三，并保留 @图二 的动漫AI照片风效果。」',
  label: '修改意图',
  placeholder: '描述你想怎么修改，输入 @ 引用当前任务图片…',
} as const;

/** @图片引用（Image Mention）输入与弹层文案。 */
export const IMAGE_MENTION = {
  popupTitle: '引用图片',
  popupSectionTask: '当前任务',
  popupPickGallery: '从图片库选择…',
  popupEmpty: '当前任务还没有可引用的图片；可先从图片库选择加入当前任务。',
  popupHint: '↑↓ 选择 · Enter 插入 · Esc 关闭',
  chipsLabel: '已引用图片',
  chipsRemove: '移除引用',
  chipsView: '点击在内置图片查看器中查看',
  chipAlt: '引用图片缩略图',
  viewerTitle: '引用图片',
} as const;

/** 「已识别图片角色」建议条（自然语言 / @mention → 人物替换面板，不偷偷覆盖）。 */
export const MENTION_SUGGESTION = {
  title: '已识别图片角色',
  templateLabel: '模板图',
  personLabel: '替换人物',
  apply: '应用到人物替换',
  dismiss: '忽略',
  note: '应用后可在人物替换面板中查看与调整；不会覆盖你已手动设置的内容。',
} as const;

/**
 * 修改维度快捷 Chip（V4.1 Modification Dimension Selector）：
 * 结构化选择器（toggle / 唯一槽位），绝不向 textarea 追加文本；
 * 定义单一来源见 features/vision/modificationIntent.ts。
 */
export const MODIFICATION_CHIPS = {
  groupLabel: '快捷修改',
  boostLabel: '提高复刻度',
  boostHint: '更贴近原图：未提及的视觉结构从严保持（不是视觉维度，独立生效）',
} as const;

/** 人物替换面板（V6.3 紧凑分组版：主体映射 / 来源 / 执行范围 / 替换强度 四组）。 */
export const PERSON_REPLACEMENT = {
  title: '人物替换',
  businessBadge: '已启用',
  businessDesc: '将原画面中的主体人物替换为新的参考人物。未特别指定时，画面风格沿用原图（模板图）；已启用的维度（动作 / 背景等）会继续参与修改。',
  /** V6.3 分组标签（§28-§34）：面板按 主体 / 来源 / 执行范围 / 替换强度 分组，一行一组语义。 */
  groupSubject: '主体',
  groupSource: '来源',
  groupScope: '执行范围',
  groupStrength: '替换强度',
  templateLabel: '画面模板',
  templateUseHint: '保留画风 / 构图 / 背景氛围',
  templateChangeButton: '更换模板',
  templateChangeNote: '更换模板图会替换当前参考图，需要重新理解图片',
  templateMissing: '尚未选择模板图（当前任务的参考图）',
  templateToken: '原图',
  personBlockLabel: '替换人物',
  personUseHint: '替换人物身份 / 五官 / 发型 / 服装参考',
  sourceLabel: '身份来源',
  sourceGallery: '图片库',
  sourceLocal: '本地导入',
  sourceDescription: '文字描述',
  galleryChangeButton: '图片库更换',
  localChangeButton: '本地导入',
  descriptionChangeButton: '文字描述',
  personCardTitle: '人物参考',
  personCardSourceGallery: '图片库',
  personCardSourceLocal: '本地导入',
  personTextCardTitle: '文字描述人物',
  personEmptyAction: '选择人物参考',
  personEmptyHint: '图片库 / 本地导入 / 文字描述',
  changeButton: '更换人物参考',
  cancelPickButton: '取消',
  removeButton: '移除人物替换',
  galleryPickButton: '从图片库选择',
  localPickButton: '选择本地图片',
  localDropHint: '也可以直接把图片拖入本页（面板打开时优先作为人物参考）',
  descriptionLabel: '人物描述',
  descriptionPlaceholder: '例如：25 岁亚洲女性，银色短发，蓝色眼睛，纤细体型',
  descriptionHint: '只描述人物特征（身份 / 脸部 / 发型 / 体型），服装在下方单独决定',
  thumbnailAlt: '人物参考图',
  mappingArrowLabel: '替换为',
} as const;

/** 服装来源（Clothing Policy）文案；语义 payload 见 clothingPolicyInstruction（与 UI 文案解耦）。
 * V4.0.9 状态不变量：clothing ∈ activeDimensions ⇔ clothingPolicy ≠ preserve_original
 * （「原图服装」自动取消「修改服装」维度；「人物服装 / 自定义」自动启用——由系统处理，
 *  V6.8 减法原则：每个来源只保留一句上下文提示，不向用户解释实现规则）。 */
export const CLOTHING_POLICY = {
  sectionLabel: '服装来源',
  preserveOriginal: '原图服装',
  preserveOriginalHint: '保持原图服装不变。',
  useSubjectReference: '人物服装',
  useSubjectReferenceHint: '将使用人物参考图中的服装。',
  custom: '自定义',
  customHint: '描述希望替换的服装与造型。',
  customInputLabel: '服装描述',
  customInputPlaceholder: '描述希望替换的服装……',
  referenceLabel: '服装参考',
  referenceHintCustom: '可用图片库或本地图片指定服装款式。',
  multiLabel: '多人服装',
  multiButton: '分别设置',
  refCardNote: '仅用于服装、配饰与造型参考。',
} as const;

/** 视觉理解「正在分析」阶段的产品化文案（VisualAnalysisProgress）。 */
export const ANALYSIS_PROGRESS = {
  subtitle: '正在识别人物、动作、构图与风格',
  modelPrefix: '视觉模型',
  messages: [
    '正在拆开这张图的视觉密码…',
    '开始组装这幅世界拼图…',
    '正在认识画面里的主角…',
    '正在读懂人物的动作与姿态…',
    '正在寻找镜头里的构图线索…',
    '正在捕捉光线和色彩的小心思…',
    '正在整理服装与造型细节…',
    '正在分析背景和空间关系…',
    '正在把画面翻译成可复刻的视觉语言…',
    '正在整理一份可以重新生成的视觉配方…',
    '马上就能告诉你 AI 看懂了什么…',
  ],
} as const;

/** 轮播文案唯一取值入口（index 越界自动取模；测试锚点）。 */
export function getVisualAnalysisMessage(index: number): string {
  const pool = ANALYSIS_PROGRESS.messages;
  const safe = pool.length > 0 ? ((index % pool.length) + pool.length) % pool.length : 0;
  return pool[safe];
}

/** AI 生成方案卡（自然语言方案为视觉主体；最终 Prompt 编辑统一在 FinalPromptEditor）。 */
export const AI_PLAN = {
  title: 'AI 生成方案',
  readySummaryPrefix: '将按原图方案直接复刻',
  lockedSummary: '保留',
  unlockedSummary: '可修改',
} as const;

/**
 * 最终生图 Prompt 区（Prompt Provenance：显示值 = 提交值，唯一来源）。
 * 页面唯一 Prompt 编辑器（FinalPromptEditor）：「最终版本」可编辑 /「修改对比」Diff，
 * 禁止再出现第二套「编辑生成方案」Prompt 输入框。
 */
export const FINAL_PROMPT = {
  title: '最终生图 Prompt',
  desc: '实际将提交给图片生成模型的完整 Prompt',
  tabFinal: '最终版本',
  tabDiff: '修改对比',
  copyLabel: '复制 Prompt',
  copiedToast: '最终生图 Prompt 已复制',
  editorHint: '可直接编辑；手动修改后无需重新优化也能生成',
  statusReady: '最终 Prompt 已生成',
  statusManual: 'Prompt 已手动修改，可直接生成，也可重新优化',
  statusDirty: '修改已记录，最终 Prompt 待重新生成；此前优化结果已保留，改回原条件可自动恢复',
  statusFailed: '本次优化失败',
  statusFailedFallback: '仍可使用上一次成功的 Prompt',
  useLastButton: '使用上一次 Prompt',
  useLastToast: '已回退到上一次成功的最终 Prompt，可直接确认生成图片。',
  diffTitle: '修改对比',
  diffSubtitle: '原始复刻 Prompt → 最终生图 Prompt',
  diffAddedLabel: '新增',
  diffRemovedLabel: '删除',
  diffEmpty: '最终 Prompt 与原始复刻 Prompt 一致，暂无修改。',
  summaryTitle: '本次重点修改',
  summaryStatusPlanned: '待优化',
  summaryStatusApplied: '已修改',
  keyChangesTitle: '本次关键变化',
  keyChangesHint: '上方为修改意图的结构化摘要；全文逐字对比见 diff 区。',
} as const;

/** 维度锁定卡（锁定 / 可修改 / 已修改 + AI 判断与用户手动的区分）。 */
export const DIMENSION_LOCK = {
  locked: '锁定',
  unlocked: '可修改',
  changed: '已修改',
  manualSuffix: '手动',
  aiLabel: 'AI 判断',
  userLabel: '你的手动设置',
  oldValuePrefix: '原',
  newValuePrefix: '新',
  intentHint: '「已修改」由 AI 根据你的修改意图判定；点击角标可手动切换（手动设置优先于 AI 判断，重新优化也不会被覆盖）。',
  pendingHint: '优化完成后，AI 会根据你的修改意图自动判定哪些维度需要修改。',
} as const;

/** 高级设置折叠区（模型 / Prompt / 生成方式 / 参数 / 高复刻，默认全部收起）。 */
export const ADVANCED_SETTINGS = {
  title: '高级设置',
  hint: '视觉模型、Prompt 细节、生成方式与参数、高复刻验证、自动评价开关。',
} as const;

/** AI 理解卡（summary 常驻 + 详细分析默认折叠）。 */
export const UNDERSTANDING = {
  title: 'AI 已理解这张图片',
  detailToggle: '查看详细分析',
} as const;

export const EVALUATION_COPY = {
  sectionTitle: '生成结果',
  overallLabel: '复刻完成度',
  continueAdjust: '继续调整',
  continueFilledToast: '已把上一轮评价与你的反馈填入修改意图，确认后点击「优化复刻 Prompt」。',
  autoEvaluateLabel: '生成后自动评价',
  autoEvaluateHint: '生成完成后自动调用你的视觉模型逐张评分（使用你的 API Key，可在任意时刻关闭）。',
} as const;

export const OPTIMIZE_TOAST = {
  /** 优化成功（dirty → optimized） */
  success: '优化完成，已生成新的最终生图 Prompt。现在可以确认生成图片。',
  /** ready / optimized 状态点优化按钮：空跑保护 */
  idleGuard: '当前 Prompt 已是最终生图 Prompt，可直接确认生成图片，无需重复优化。',
  /** dirty 但调整要求为空：先引导输入 */
  emptyInstruction: '请先在「修改意图」输入框中描述你希望调整的内容，再点击优化。',
} as const;

/** 「重新优化」：强制再执行一次 AI 优化（保留工作区全部内容；失败保留旧结果）。 */
export const REOPTIMIZE_ACTION = {
  label: '重新优化',
  /** Tooltip：明确会再次调用 AI（消耗 Token） */
  hint: '基于当前图片、分析结果与你的修改要求，重新调用 AI 优化生图 Prompt（会再次消耗 Token）。失败时保留现有结果。',
  emptyInstruction: '请先在「修改意图」输入框中描述你希望调整的内容，再重新优化。',
} as const;

/**
 * 「复刻成我的技能」（V6.8.1 恢复）：把当前复刻项目保存为技能工坊 → 我的技能
 * （可重放 Recipe；Secondary Action，与「确认生成图片」同层但不高强调）。
 * 显示条件沿用技能创建链路旧逻辑：有项目 + 最终 Prompt 存在且有效（非待优化、非优化中）。
 */
export const SAVE_AS_SKILL_ACTION = {
  label: '复刻成我的技能',
  hint: '把当前复刻方案保存为技能工坊 → 我的技能，可反复复用（需要先生成有效的最终 Prompt）。',
  staleHint: '最终 Prompt 已修改、待重新优化——请先点击「优化复刻 Prompt」再保存技能。',
  optimizingHint: '正在优化最终 Prompt，完成后可保存为技能。',
  savedToast: '已保存到技能工坊 → 我的技能',
  savePendingToast: '项目尚未保存成功，请重试后再创建可复用技能。',
} as const;

/** 「重新开始」：确认后清空当前视觉理解工作区（不动历史任务与已生成图片）。 */
export const RESTART_ACTION = {
  label: '重新开始',
  dialogTitle: '重新开始视觉理解任务',
  dialogDesc: '确定开始新的视觉理解任务吗？当前工作区内容将被清空（图片、分析结果、修改意图与最终 Prompt；历史任务与已生成图片不受影响）。',
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

/** 生成方式（V4.0.9 起移入高级设置；视觉复刻默认图生图）。 */
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
  /** 参考图约束强度说明（gpt-image-2 无独立 strength 参数，以 Prompt 约束表达）。 */
  referenceStrengthHint: '生成模型不提供独立的参考图强度参数；需要弱化原图约束时，请在修改意图中说明（如「构图可自由发挥」）。',
} as const;

/**
 * 优化失败提示：按错误类别给出用户可理解的中文（不暴露技术细节）。
 * kind 由服务层归因（provider_error 原因已由 providerErrorCompact 翻译）。
 */
export function optimizeFailureMessage(error: string): string {
  const base = error.trim().replace(/。+$/, '');
  return `${base}。可点击「优化复刻 Prompt」重试，或调整要求后重新优化。`;
}
