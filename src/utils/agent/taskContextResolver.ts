/**
 * 任务级上下文继承与指代消解。
 *
 * 核心目标（修复多轮补充任务被误识别为新任务的问题）：
 *   - 用户第一句 "给我生成一张《XXX》里的萌王，持剑姿势"
 *   - 用户第二句 "我希望边上再加上他史莱姆的原型态"
 *
 * 第二句中的 "他" / "原型态" 必须能回指到第一句的 "萌王 / 利姆鲁" 以及作品《XXX》，
 * 并被识别为对同一任务的"补充要求"而不是一个独立的新任务。
 *
 * 本模块只做"本地、确定、可解释"的语义归纳 —— 不调用 LLM，不引入外部依赖。
 * 它产出的 TaskSemanticContext 会被注入到 Planner 的 user prompt 中，
 * 让 gpt-5.6-luna 在生成 final_prompt 时不会丢失主体 / 作品 / IP / 同角色多形态。
 *
 * 重要原则：
 *   1. 只在"看起来真的是补充语句"时才标记为 augmentation —— 否则不要污染新任务。
 *   2. pronounBindings 只在能找到明确的"上一主体"时才输出。
 *   3. workTitle 用《》/ "" / 英文 " " 提取，不依赖任何 IP 字典。
 *   4. 全部字段都是可选的 —— 任何调用方都能安全地忽略 undefined 字段。
 */

/** 单条历史用户消息（用于上下文归纳）。 */
export interface ContextSourceMessage {
  text: string;
  /** 该用户消息最终生成的任务提示词（如果走过 Planner）。 */
  finalPrompt?: string;
  /** 该用户消息触发的任务类型。 */
  taskType?: 'generate' | 'edit' | 'remove_background' | string;
}

export interface TaskSemanticContext {
  /** 当前用户输入。 */
  currentMessage: string;
  /** 用于归纳上下文的源消息（已经按时间排序，最近的在尾部）。 */
  sourceMessages: ContextSourceMessage[];

  /** 是否被识别为"对上一任务的补充要求"。 */
  augmentationDetected: boolean;
  /** 是否从上一轮继承了主体（true 时上层应把主体带入 final_prompt）。 */
  inheritedFromPreviousTurn: boolean;

  /** 作品 / IP 名（例如 "关于我转生变成史莱姆这档事"）。 */
  workTitle?: string;
  /** 主体角色（例如 "萌王 / 利姆鲁"）。 */
  primarySubject?: string;
  /** 主体的别名 / 指代形式。 */
  subjectAliases?: string[];

  /**
   * 指代消解映射。例如 {"他": "萌王/利姆鲁"}。
   * 只在能找到明确主体时才填，调用方应把它原样注入到 Planner 提示。
   */
  pronounBindings?: Record<string, string>;

  /** 上一轮的最终提示词（用于让 Planner 在生成新 prompt 时保持连续性）。 */
  previousFinalPrompt?: string;
  /** 上一轮的任务类型。 */
  previousTaskType?: string;

  /** 当前轮检测到的"补充要素"，例如 "边上再加上 / 原型态 / 本体形态"。 */
  augmentations?: string[];
}

/** 看起来像"补充语句"的关键词（出现任一即视为补充信号）。 */
const AUGMENTATION_PATTERNS: RegExp[] = [
  /边上再(?:加上|来一个|补一个|放一个)/,
  /旁边再(?:加上|来一个|补一个|放一个)/,
  /左侧再(?:加上|来一个|补一个|放一个)/,
  /左侧再来一个/,
  /右边再(?:加上|来一个|补一个|放一个)/,
  /再(?:加上|补充|来一个|补一个|放一个|添加)/,
  /同时(?:加上|补充|添加|放入)/,
  /保留这个.{0,8}再/,
  /把他改成/,
  /把她改成/,
  /把它改成/,
  /换个姿势/,
  /换一个姿势/,
  /原型态/,
  /本体形态/,
  /本体/,
  /另一个形态/,
  /同一个角色/,
  /同角色/,
];

/** 指代词列表 —— 出现这些词时，需要做 pronounBindings。 */
const PRONOUN_LIST = ['他', '她', '它', '这个', '这只', '这位'];

/** 用于把"明显不是图像任务"的多轮输入排除掉。 */
const NON_IMAGE_TASK_PATTERNS: RegExp[] = [
  /帮我写.{0,4}(文案|文章|诗|邮件|朋友圈|微信)/,
  /写一段.{0,4}(文案|文章|介绍)/,
  /^翻译/,
  /解释一下.{0,8}代码/,
];

/** 提取《》/ "" / '' 中的作品名。 */
function extractWorkTitle(text: string): string | undefined {
  if (!text) return undefined;
  const angleMatch = text.match(/《([^《》]{1,80})》/);
  if (angleMatch) return angleMatch[1].trim();
  const doubleQuoteMatch = text.match(/["“”]([^"“”]{1,80})["“”]/);
  if (doubleQuoteMatch) return doubleQuoteMatch[1].trim();
  return undefined;
}

/**
 * 提取主体角色。
 * 这里不试图做完整的命名实体识别 —— 只是给出几个常见的中文动漫 / 游戏 / 影视信号：
 *   - "里的 XXX" / "中的 XXX"
 *   - "XXX 这个角色" / "角色 XXX"
 *   - "XXX（角色）"
 * 同时也会把"萌王"这种常见外号纳入。
 */
function extractPrimarySubject(text: string): { subject: string; aliases: string[] } | undefined {
  if (!text) return undefined;
  const candidates: string[] = [];

  // 《...》里的 X
  const inWorkMatch = text.match(/(?:里的|中的|里面(?:的|的)?|里头(?:的)?)\s*([一-龥A-Za-z0-9·\-_/]{1,20})/);
  if (inWorkMatch && inWorkMatch[1]) {
    candidates.push(inWorkMatch[1].trim());
  }

  // X 这个角色 / 角色X / X角色
  const roleKeywordMatch = text.match(/([一-龥A-Za-z0-9·\-_/]{1,20})\s*(?:这个角色|该角色|角色)/);
  if (roleKeywordMatch && roleKeywordMatch[1]) {
    candidates.push(roleKeywordMatch[1].trim());
  }
  const roleKeywordMatch2 = text.match(/(?:角色|主人公|主角|女主|男主)\s*([一-龥A-Za-z0-9·\-_/]{1,20})/);
  if (roleKeywordMatch2 && roleKeywordMatch2[1]) {
    candidates.push(roleKeywordMatch2[1].trim());
  }

  // "萌王" / "史莱姆" 这种通俗外号 —— 仅当原文出现了 "角色" / "里的" 时才采纳，
  // 避免把 "我要一张海报" 中的 "海报" 当成主体。
  if (/(角色|里的|中的|主角|男主|女主|主人公)/.test(text)) {
    const commonSubjectMatch = text.match(/(萌王|史莱姆|利姆鲁|鲁路修|luffy|路飞|naruto|鸣人|saber|阿尔托莉雅)/i);
    if (commonSubjectMatch && commonSubjectMatch[1]) {
      candidates.push(commonSubjectMatch[1].trim());
    }
  }

  // 别名映射：把"萌王"扩成"萌王/利姆鲁"这种带原名的形式
  const aliases: string[] = [];
  for (const candidate of candidates) {
    if (candidate === '萌王') aliases.push('利姆鲁');
    if (candidate === '利姆鲁') aliases.push('萌王');
  }

  // 去重 + 保留顺序
  const seen = new Set<string>();
  const unique = candidates.filter(item => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) return undefined;
  return { subject: unique[0], aliases: Array.from(new Set(aliases)) };
}

/** 判断当前消息是不是"补充型"语句。 */
export function isAugmentationMessage(text: string): boolean {
  if (!text || !text.trim()) return false;
  // 长消息（>120 字）更像独立新任务而不是补充
  if (text.length > 120) return false;
  return AUGMENTATION_PATTERNS.some(pattern => pattern.test(text));
}

/** 判断当前消息是不是明显的"非图像任务"（例如写文案）。 */
export function isNonImageTaskMessage(text: string): boolean {
  if (!text || !text.trim()) return false;
  return NON_IMAGE_TASK_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * 在最近若干条源消息里回溯"主体 / 作品 / final_prompt"。
 * 只看最近 8 条，避免无限回溯把几年前的对话污染进来。
 */
const MAX_LOOKBACK_MESSAGES = 8;

/**
 * 解析当前用户输入，结合历史消息，输出 TaskSemanticContext。
 *
 * 注意：
 *   - sourceMessages 必须按时间顺序（旧的在前，新的在后）。
 *   - 该函数不修改输入，所有字段都是从输入里读出来的快照。
 *   - 任何字段都允许 undefined —— 调用方应当容忍空值。
 */
export function resolveTaskSemanticContext(input: {
  currentMessage: string;
  sourceMessages: ContextSourceMessage[];
}): TaskSemanticContext {
  const currentMessage = (input.currentMessage || '').trim();
  const sourceMessages = (input.sourceMessages || []).slice(-MAX_LOOKBACK_MESSAGES);

  const base: TaskSemanticContext = {
    currentMessage,
    sourceMessages,
    augmentationDetected: false,
    inheritedFromPreviousTurn: false,
  };

  if (!currentMessage) return base;

  // Step 1: 当前消息本身是不是非图像任务？是 → 直接返回，不做任何继承。
  if (isNonImageTaskMessage(currentMessage)) {
    return base;
  }

  // Step 2: 当前消息是不是"补充型"语句？
  const augmentationDetected = isAugmentationMessage(currentMessage);
  const hasPronoun = PRONOUN_LIST.some(pronoun => currentMessage.includes(pronoun));

  // Step 3: 在最近若干条里找"最近一条图像任务消息"作为继承源。
  // 从尾部往前找，找到第一条非空的任务消息即可。
  let anchorIndex = -1;
  for (let i = sourceMessages.length - 1; i >= 0; i -= 1) {
    const msg = sourceMessages[i];
    if (!msg || !msg.text || !msg.text.trim()) continue;
    // 跳过明显的非图像任务（写文案等）
    if (isNonImageTaskMessage(msg.text)) continue;
    anchorIndex = i;
    break;
  }

  if (anchorIndex < 0) {
    // 历史里没有任何可继承的消息。仍然把 augmentationDetected 暴露出去，
    // 这样上层可以决定是否给用户一条提示。
    return {
      ...base,
      augmentationDetected,
    };
  }

  const anchor = sourceMessages[anchorIndex];

  // 只有当前消息真的看起来像补充，或者出现了指代词，才视为继承。
  const shouldInherit = augmentationDetected || hasPronoun;
  if (!shouldInherit) {
    return {
      ...base,
      augmentationDetected,
    };
  }

  // Step 4: 从 anchor 中抽取 workTitle / primarySubject。
  // 优先用 anchor.finalPrompt（Planner 扩写后的版本通常更完整），其次用 anchor.text。
  const promptForExtract = anchor.finalPrompt || anchor.text;
  const workTitle = extractWorkTitle(promptForExtract) || extractWorkTitle(anchor.text);
  const subjectInfo = extractPrimarySubject(promptForExtract) || extractPrimarySubject(anchor.text);

  // Step 5: 构建 pronounBindings
  const pronounBindings: Record<string, string> = {};
  if (subjectInfo) {
    const subjectLabel = subjectInfo.aliases.length > 0
      ? `${subjectInfo.subject}/${subjectInfo.aliases.join('/')}`
      : subjectInfo.subject;
    for (const pronoun of PRONOUN_LIST) {
      if (currentMessage.includes(pronoun)) {
        pronounBindings[pronoun] = subjectLabel;
      }
    }
  }

  // Step 6: 提取本轮的 augmentations 短语，便于上层在 final_prompt 里显式带出。
  const augmentations: string[] = [];
  const augMatch = currentMessage.match(/(边上再(?:加上|来一个|补一个|放一个)[^，。！？,!?]*)/);
  if (augMatch) augmentations.push(augMatch[1].trim());
  const protoMatch = currentMessage.match(/((?:他|她|它|该|其)?\s*(?:的)?\s*(?:原型态|本体形态|本体|另一个形态|同角色[^，。！？,!?]*))/);
  if (protoMatch) augmentations.push(protoMatch[1].trim());

  return {
    ...base,
    augmentationDetected,
    inheritedFromPreviousTurn: true,
    workTitle,
    primarySubject: subjectInfo?.subject,
    subjectAliases: subjectInfo?.aliases,
    pronounBindings: Object.keys(pronounBindings).length > 0 ? pronounBindings : undefined,
    previousFinalPrompt: anchor.finalPrompt,
    previousTaskType: anchor.taskType,
    augmentations: augmentations.length > 0 ? augmentations : undefined,
  };
}

/**
 * 把 TaskSemanticContext 渲染成一段中文的、对 Planner 友好的"上下文摘要"。
 * 上层会把这段文本拼到 Planner user prompt 里。
 *
 * 注意：这里输出的内容必须能让 Planner 模型立刻看出：
 *   - 当前消息是不是补充语句
 *   - 应该继承谁
 *   - "他" 应该被绑定到谁
 */
export function renderTaskSemanticContextForPlanner(ctx: TaskSemanticContext): string {
  if (!ctx.inheritedFromPreviousTurn && !ctx.augmentationDetected) return '';

  const lines: string[] = [];
  lines.push('[任务上下文继承]');
  if (ctx.augmentationDetected) {
    lines.push('- augmentation_detected: true（当前消息看起来是对上一任务的补充要求，而不是独立的新任务）');
  }
  if (ctx.inheritedFromPreviousTurn) {
    lines.push('- inherited_from_previous_turn: true（必须继承上一任务的主体 / 作品 / 风格，不要把它们当成新主体）');
  }
  if (ctx.workTitle) {
    lines.push(`- work_title: ${ctx.workTitle}（这是作品 / IP 名，final_prompt 中必须保留）`);
  }
  if (ctx.primarySubject) {
    const alias = ctx.subjectAliases && ctx.subjectAliases.length > 0
      ? `（别名：${ctx.subjectAliases.join('、')}）`
      : '';
    lines.push(`- primary_subject: ${ctx.primarySubject}${alias}（这是上一任务的主体角色，本轮必须沿用）`);
  }
  if (ctx.pronounBindings && Object.keys(ctx.pronounBindings).length > 0) {
    const pairs = Object.entries(ctx.pronounBindings).map(([k, v]) => `"${k}" → "${v}"`);
    lines.push(`- pronoun_bindings: ${pairs.join('; ')}（当前消息里的代词必须按此映射解析）`);
  }
  if (ctx.augmentations && ctx.augmentations.length > 0) {
    lines.push(`- augmentations: ${ctx.augmentations.join('；')}（本轮新增的补充要求，必须体现在 final_prompt 中）`);
  }
  if (ctx.previousFinalPrompt) {
    // 截断超长 previous prompt，避免把 Planner 上下文撑爆。
    const truncated = ctx.previousFinalPrompt.length > 600
      ? ctx.previousFinalPrompt.slice(0, 600) + '…'
      : ctx.previousFinalPrompt;
    lines.push(`- previous_final_prompt: ${truncated}`);
  }
  if (ctx.previousTaskType) {
    lines.push(`- previous_task_type: ${ctx.previousTaskType}`);
  }
  lines.push('- 如果当前消息是对上一任务的补充，final_prompt 必须同时包含：主体角色、作品出处（如果有）、原有动作 / 姿态，以及本轮补充要素。');
  lines.push('- 严禁在补充语句中把代词错误展开为不相关的物体（例如把"他原型态"理解成"加一个不相关的史莱姆"）。');

  return lines.join('\n');
}
