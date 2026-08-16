/**
 * Chat → Task 语义执行上下文解析器（General Executable Semantic Context Resolver）。
 *
 * 历史问题（spec 第四节）：Chat Handoff 只擅长继承"结构化 Prompt 块"（提示词：… / 负面提示词：…），
 * 无法解析自然语言指代 —— "这些建筑 / 上面这些 / 刚才那些 / 就按这些生成"。
 * 结果是用户说"你可以帮我生成这些建筑的9宫格图嘛？"时，Agent 回复
 * "请上传或列出你想生成的建筑"而不是创建 Task。
 *
 * 本模块职责（本地、确定、可解释，不调用 LLM）：
 *   1. Intent：当前消息是否是执行型请求（actionable）+ 指代了历史上下文。
 *   2. Entity List：从 Assistant 消息中提取候选实体集合（bullet / 编号 / 顿号列举）。
 *   3. 指代消解："这些建筑" → 匹配 entityCategory 的最近实体列表消息。
 *   4. Grid Layout："九宫格 / 9宫格 / 3x3 / 3×3" → rows=3, columns=3, cellCount=9。
 *   5. Visual Proposal：Assistant 没有明确 Prompt 块时的设计方案文本（semanticSummary）。
 *
 * 原则：
 *   - resolver 只负责"恢复事实 / 实体 / 结构"，最终 Prompt 交给 Planner 生成。
 *   - 不硬编码任何具体实体名单（长城 / 故宫等）。
 *   - 只扫描当前 Conversation 最近 12 条消息，绝不跨会话继承。
 *   - 引用关系优先于 Prompt 默认优先级（spec 三十七节）。
 */

import type { ChatMessage } from '../../types';
import { parseOrderedEntitySelection } from './compositionIntentResolver';
import { extractOrderedAtomicEntities } from './entityExtraction';

// ============================================================================
// 类型
// ============================================================================

export type ChatContextSource =
  | 'current_message'
  | 'assistant_prompt'
  | 'assistant_entity_list'
  | 'assistant_visual_plan'
  | 'user_description'
  | 'previous_task';

export type EntityCategory =
  | 'building'
  | 'character'
  | 'product'
  | 'animal'
  | 'location'
  | 'object'
  | 'unknown';

/** 九宫格等布局解析结果。 */
export interface GridLayout {
  rows: number;
  columns: number;
  cellCount: number;
}

/** 执行意图检测结果。 */
export interface ChatExecutionIntent {
  /** 是否执行型请求（生成 / 编辑 / 制作图片）。 */
  actionable: boolean;
  /** 任务大类。 */
  kind: 'text_to_image' | 'image_edit' | 'remove_background' | 'unknown';
  /** 当前消息是否包含对历史上下文的指代（"这些 / 上面那些 / 刚才说的"）。 */
  referencesPreviousContext: boolean;
  /** 指代中提到的实体类别关键词（"这些建筑" → 'building'），无则 unknown。 */
  entityCategoryHint: EntityCategory;
  /** 布局解析结果（九宫格等），无布局表达时 undefined。 */
  grid?: GridLayout;
}

/** 解析后的语义执行上下文 —— 会注入 Planner 的 user prompt。 */
export interface ResolvedChatExecutionContext {
  source: ChatContextSource;
  /** 用户当前执行请求原文。 */
  currentRequest: string;
  /** 指代词解析出的来源说明（"这些建筑"指上一轮 Agent 列出的建筑）。 */
  referenceExplanation?: string;
  /** 候选实体列表（来自 Assistant 实体列举消息）。 */
  entities?: string[];
  /** 实体类别。 */
  entityCategory?: EntityCategory;
  /** Assistant 设计方案 / Prompt 块文本。 */
  prompt?: string;
  negativePrompt?: string;
  /** 视觉方案语义摘要（无明确 Prompt 块时）。 */
  semanticSummary?: string;
  /** 布局（九宫格等）。 */
  grid?: GridLayout;
  /**
   * 顺序实体引用（"前3个" / "第1和第2个"）：从候选实体中按 1-based 序号选出的子集。
   * "前3个山" + 上文列表 [泰山,黄山,华山,衡山] → selectedLabels = [泰山,黄山,华山]。
   */
  orderedSelection?: {
    phrase: string;
    selectedIndices: number[];
    selectedLabels: string[];
  };
  /** 来源 Assistant 消息 id（诊断用，不进入 Planner prompt）。 */
  sourceMessageIds?: string[];
  /** UI 展示标签："上一轮建筑列表"。 */
  sourceLabel?: string;
}

/** 扫描窗口：只看最近 N 条消息（spec 三十八节：8~12 条）。 */
const MAX_LOOKBACK_MESSAGES = 12;

// ============================================================================
// Intent 检测
// ============================================================================

/** 指代表达（spec 二十二节）—— 出现即视为引用历史上下文。
 *  关键扩展：加入 "前N个" 型顺序引用（"前3个山 / 前三个建筑 / 刚才列的前三个"），
 *  让用户对上文实体列表的顺序选择也能触发 Chat → Task Handoff。 */
const REFERENCE_PATTERN =
  /(这些|这几个|上面这些|上面那些|刚才这些|刚才那些|上面提到的|前面说的|你刚才说的|你列出来的|你列的|就按这些|按照这些|根据这些|用这些|刚才列的|前面列的|如上|刚才的|你刚才给|按你说的|就按你|刚才那个方案|刚才说的|按这个|按刚才|前\s*\d{1,2}\s*[个张位座项条]|前\s*[一二两三四五六七八九十]\s*[个张位座项条]|刚才列的前\s*(?:\d{1,2}|[一二两三四五六七八九十])|第\s*\d{1,2}\s*(?:个|张|位|座|项|条))/;

/** 实体类别关键词 → category 映射（顺序敏感：更具体的放前面）。 */
const ENTITY_CATEGORY_KEYWORDS: Array<{ pattern: RegExp; category: EntityCategory; label: string }> = [
  { pattern: /建筑|大楼|大厦|地标|楼宇|塔楼|宫殿|园林/, category: 'building', label: '建筑' },
  { pattern: /人物|角色|人像|模特|角色们|主人公|主角/, category: 'character', label: '人物' },
  { pattern: /产品|商品|物品|货品/, category: 'product', label: '产品' },
  { pattern: /动物|宠物|猫咪|狗狗/, category: 'animal', label: '动物' },
  { pattern: /风景|景点|地方|城市|地点|山|山脉|名山/, category: 'location', label: '风景' },
];

/** 执行动词（生成 / 制作图片等）。注意错别字兼容："建筑得9宫格"（spec 四十三节）。 */
const EXECUTION_ACTION_PATTERN =
  /(生成|制作|创建|设计|画一张|画个|做一张|做成|做一张图|做几张|帮我做|给我做|帮我生成|给我生成|来一张|做一副|做一幅|拼一张|拼成)/;

/**
 * 自带图像量词的动词短语 —— "做一张 / 来一张 / 画一张 / 做几张" 本身就
 * 隐含视觉输出，不需要句中再出现"图 / 海报"等目标词。
 */
const IMPLICIT_VISUAL_ACTION_PATTERN =
  /(做一张|做几张|来一张|画一张|画几张|做一副|做一幅|出一张|出几张)/;

/** 明确的视觉目标词。 */
const VISUAL_TARGET_PATTERN =
  /(图|图片|图像|海报|头像|图标|logo|主图|封面|九宫格|宫格|壁纸|插画|合影|集体照|宣传图|那张|这张)/;

/** 疑问 / 讨论句式 —— 命中则不是执行请求（spec 九十三 / 九十四节）。 */
const DISCUSSION_PATTERN =
  /(是什么意思|什么意思|是什么意思吗|哪个.*(漂亮|好看|最漂亮|最好看)|你觉得|怎么理解|解释一下|介绍一下.*嘛|介绍一下.*吗|有哪些嘛|有哪些吗|是什么嘛|是什么吗)/;

/** 编辑动词（有附件 / active image 时才生效）。 */
const EDIT_ACTION_PATTERN =
  /(去掉|去除|删除|移除|修改|改成|换成|替换|裁切|放大|修复|重绘|抠图|去背景|透明背景)/;

/**
 * 解析"九宫格 / 9宫格 / 9 宫格 / 3x3 / 3×3 / N宫格 / N×M"。
 */
export function parseGridLayout(text: string): GridLayout | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/\s+/g, '');

  // N分镜（"3分镜图"）：单张图内的横向三联构图，不是 3 张图。
  const storyboardMatch = normalized.match(/(\d{1,2})分镜/);
  if (storyboardMatch) {
    const n = parseInt(storyboardMatch[1], 10);
    if (n > 1 && n <= 16) return { rows: 1, columns: n, cellCount: n };
  }
  const storyboardCnMatch = normalized.match(/([一二两三四五六七八九十])分镜/);
  if (storyboardCnMatch) {
    const cnMap: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const n = cnMap[storyboardCnMatch[1]];
    if (n && n > 1) return { rows: 1, columns: n, cellCount: n };
  }
  // 三联画 / 三分屏 / 分屏
  if (/三联画|三分屏|三联屏/.test(normalized)) return { rows: 1, columns: 3, cellCount: 3 };
  if (/双联画|二分屏|左右分屏/.test(normalized)) return { rows: 1, columns: 2, cellCount: 2 };

  // 九宫格（中文）
  if (/九宫格|9宫格/.test(normalized)) {
    return { rows: 3, columns: 3, cellCount: 9 };
  }

  // 中文数字宫格：四宫格 / 八宫格 / 十六宫格
  const cnNumMap: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十六: 16,
  };
  const cnGridMatch = normalized.match(/([一二两三四五六七八九]|十六|十)宫格/);
  if (cnGridMatch) {
    const n = cnNumMap[cnGridMatch[1]];
    if (n && n > 1) {
      const side = Math.round(Math.sqrt(n));
      if (side * side === n) return { rows: side, columns: side, cellCount: n };
      return { rows: 1, columns: n, cellCount: n };
    }
  }

  // 十六宫格 / 4宫格 / N宫格
  const cellMatch = normalized.match(/(\d{1,2})宫格/);
  if (cellMatch) {
    const n = parseInt(cellMatch[1], 10);
    if (n > 1 && n <= 64) {
      const side = Math.round(Math.sqrt(n));
      if (side * side === n) return { rows: side, columns: side, cellCount: n };
      return { rows: 1, columns: n, cellCount: n };
    }
  }

  // 3x3 / 3×3 / 3*3
  const dimMatch = normalized.match(/(\d{1,2})\s*[x×*]\s*(\d{1,2})/);
  if (dimMatch) {
    const rows = parseInt(dimMatch[1], 10);
    const columns = parseInt(dimMatch[2], 10);
    if (rows > 0 && rows <= 16 && columns > 0 && columns <= 16) {
      return { rows, columns, cellCount: rows * columns };
    }
  }

  return undefined;
}

/**
 * 检测当前消息的执行意图。
 * 注意：hasImageAttachments / hasActiveImage 影响 image_edit 判定；
 * 纯文本文生图请求（"生成这些建筑的9宫格图"）是 text_to_image，
 * 不要求用户上传图片（spec 八十五节）。
 */
export function detectChatExecutionIntent(input: {
  text: string;
  hasImageAttachments?: boolean;
  hasActiveImage?: boolean;
}): ChatExecutionIntent {
  const text = (input.text || '').trim();
  const base: ChatExecutionIntent = {
    actionable: false,
    kind: 'unknown',
    referencesPreviousContext: false,
    entityCategoryHint: 'unknown',
  };
  if (!text) return base;

  // 疑问 / 讨论句式优先 —— "九宫格图片是什么意思？" "你觉得这些建筑哪个最漂亮？" 不能 Handoff。
  if (DISCUSSION_PATTERN.test(text)) {
    return { ...base, referencesPreviousContext: REFERENCE_PATTERN.test(text) };
  }

  const referencesPreviousContext = REFERENCE_PATTERN.test(text);
  const hasGrid = parseGridLayout(text);

  // 实体类别提示："这些建筑" / "这些人物"
  let entityCategoryHint: EntityCategory = 'unknown';
  for (const { pattern, category } of ENTITY_CATEGORY_KEYWORDS) {
    if (pattern.test(text)) {
      entityCategoryHint = category;
      break;
    }
  }

  // 编辑意图（需要图）
  if (input.hasImageAttachments || input.hasActiveImage) {
    if (EDIT_ACTION_PATTERN.test(text)) {
      return {
        actionable: true,
        kind: /去背景|抠图|透明背景/.test(text) ? 'remove_background' : 'image_edit',
        referencesPreviousContext,
        entityCategoryHint,
        grid: hasGrid,
      };
    }
  }

  // 生成意图：执行动词 + 视觉目标（宫格 / 量词短语本身就是视觉信号）。
  // "做九宫格 / 拼九宫格" 这类"动词 + 宫格"直接视为生成（grid 本身就是视觉目标）。
  const hasExecutionVerb = EXECUTION_ACTION_PATTERN.test(text)
    || (hasGrid && /(做|拼|组成|排成|组)/.test(text));
  const isGeneration = hasExecutionVerb
    && (VISUAL_TARGET_PATTERN.test(text) || IMPLICIT_VISUAL_ACTION_PATTERN.test(text) || !!hasGrid);

  if (isGeneration) {
    return {
      actionable: true,
      kind: 'text_to_image',
      referencesPreviousContext,
      entityCategoryHint,
      grid: hasGrid,
    };
  }

  return { ...base, referencesPreviousContext, entityCategoryHint, grid: hasGrid };
}

// ============================================================================
// 实体列表提取
// ============================================================================

/** 提取结果置信度打分要素。 */
interface EntityListCandidate {
  messageId: string;
  entities: string[];
  /** 列表前的引导句原文（例如 "中国著名建筑很多，例如："）。 */
  introLine: string;
  index: number; // 消息在窗口中的位置（越大越新）
}

/**
 * 从 Assistant 文本中提取实体列表（原子粒度）。
 * 支持三种形态（spec 二十节）：
 *   1. markdown bullet：- 长城 / * 长城
 *   2. 编号列表：1. 长城 / 1、长城
 *   3. 顿号 / 逗号列举：例如：长城、故宫、天坛、颐和园……
 *
 * 原子粒度（本轮修复）：分组展开行 "五岳：泰山、华山、衡山、嵩山、恒山"
 * 不再被当成 1 个实体，而是展开成 5 个 atomic entities；
 * "黄山：以奇松、怪石、云海闻名" 的冒号后是描述，只有 "黄山" 进入列表。
 * 详见 entityExtraction.ts。
 *
 * 关键守卫（spec 二十一节）：不是所有 bullet 都是图片主体。
 * 数字 / 尺寸 / 版本号列表（1024x1024 / Windows 10 / 11）必须被过滤。
 */
export function extractEntityList(text: string): string[] {
  if (!text) return [];
  const atomic = extractOrderedAtomicEntities(text).map(e => e.label);
  // 守卫沿用原规则：不足 3 个不算实体列表。
  if (atomic.length < 3) return [];
  return dedupe(atomic);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 判断一条 Assistant 消息的实体列表是否属于给定类别。
 * 打分制（spec 四十节）：intro 行的类别关键词强 boost，
 * 实体内容里的类别词弱 boost。
 */
function entityListCategoryScore(
  candidate: EntityListCandidate,
  category: EntityCategory,
): number {
  if (category === 'unknown') return 1; // 无类别提示时，任何列表都是弱候选
  const def = ENTITY_CATEGORY_KEYWORDS.find(k => k.category === category);
  if (!def) return 0;
  let score = 0;
  if (def.pattern.test(candidate.introLine)) score += 3;
  // 实体本身或前后文匹配（列表前 2 行上下文）
  const contextWindow = candidate.introLine;
  if (def.pattern.test(contextWindow)) score += 0;
  // 任意实体命中类别词（"国家体育场"含"场"不准，这里用宽松判定：任一实体或 intro 命中即得分）
  const hitInEntities = candidate.entities.some(e => def.pattern.test(e));
  if (hitInEntities) score += 1;
  return score;
}

// ============================================================================
// 指代消解 + 上下文解析
// ============================================================================

/** Prompt 块提取（思思FM 回归场景，spec 三十三节）。 */
function extractPromptBlock(text: string): { prompt?: string; negativePrompt?: string } {
  const promptMatch = text.match(/(?:最终)?提示词[：:]\s*\n?([\s\S]+)/);
  const negativeMatch = text.match(/负面提示词[：:]\s*\n?([\s\S]+)/);
  const result: { prompt?: string; negativePrompt?: string } = {};
  if (negativeMatch) {
    result.negativePrompt = negativeMatch[1].trim();
  }
  if (promptMatch) {
    // prompt 块截到负面提示词之前
    let promptText = promptMatch[1];
    const negIdx = promptText.indexOf('负面提示词');
    if (negIdx > 0) promptText = promptText.slice(0, negIdx);
    result.prompt = promptText.trim();
  }
  return result;
}

/** 视觉方案判定：Assistant 长文本含视觉设计词但没有结构化 Prompt 块。 */
const VISUAL_PROPOSAL_PATTERN =
  /(背景|画面|构图|配色|色调|光影|镜头|场景|布局|元素|风格|主题色|放.*(?:中间|左侧|右侧|上方|下方))/;

function isVisualProposalText(text: string): boolean {
  if (!text || text.length < 20) return false;
  if (extractPromptBlock(text).prompt) return false;
  return VISUAL_PROPOSAL_PATTERN.test(text);
}

/**
 * 核心 API：结合当前消息 intent + 最近历史，解析出可交给 Planner 的语义上下文。
 *
 * Candidate 优先级（spec 三十六、三十七节）：
 *   1. 引用关系优先 —— "这些建筑" 明确引用最近的建筑实体列表，
 *      即使更早的消息有更高优先级的 Prompt 块。
 *   2. Assistant Prompt 块（"提示词：…"）
 *   3. 直接引用的 Assistant 实体列表
 *   4. Previous Task finalPrompt
 *   5. Assistant 视觉方案（semanticSummary）
 *
 * @param messages 当前 Conversation 最近消息（时间顺序，旧→新，含当前 user 消息）。
 *                 通常传最后 12 条。
 */
export function resolveChatExecutionContext(input: {
  currentMessage: string;
  intent: ChatExecutionIntent;
  messages: Array<Pick<ChatMessage, 'id' | 'role' | 'content' | 'task_message'>>;
}): ResolvedChatExecutionContext | null {
  const { currentMessage, intent } = input;
  if (!intent.actionable) return null;

  // 只扫描当前消息之前的历史（时间顺序，旧→新）
  const history = input.messages
    .filter(m => m.role === 'assistant' || m.role === 'user')
    .slice(0, -1) // 去掉当前 user 消息（调用方把当前消息也放进来了）
    .slice(-MAX_LOOKBACK_MESSAGES);

  const base = {
    currentRequest: currentMessage,
  };

  // ---- 引用型：找最近匹配类别的实体列表 ----
  if (intent.referencesPreviousContext) {
    // 从最近往回找 Assistant 实体列表候选
    const candidates: EntityListCandidate[] = [];
    history.forEach((msg, idx) => {
      if (msg.role !== 'assistant') return;
      const content = msg.content || '';
      if (!content.trim()) return;
      const entities = extractEntityList(content);
      if (entities.length < 3) return;
      const introLine = findIntroLine(content);
      candidates.push({ messageId: msg.id, entities, introLine, index: idx });
    });

    if (candidates.length > 0) {
      const category = intent.entityCategoryHint;
      // 评分：类别匹配 + recency。只取最近 5 个候选参与评分。
      const scored = candidates.slice(-5).map(c => ({
        candidate: c,
        score: entityListCategoryScore(c, category) + (c.index / Math.max(1, history.length)) * 0.5,
      }));
      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];
      // 置信度守卫（spec 三十九、九十节）：类别提示明确但最佳候选完全不匹配类别
      // （例如"这些建筑"但历史只有 Windows 版本列表）→ 视为没有可信上下文。
      const minScore = category === 'unknown' ? 0.5 : 1;
      if (best && best.score >= minScore) {
        const categoryDef = ENTITY_CATEGORY_KEYWORDS.find(k => k.category === category);
        const categoryLabel = categoryDef?.label || '';
        // ---- 顺序实体选择（"前3个山"）----
        // 从最佳候选实体列表中按序号裁剪出用户实际选择的子集，
        // 让 Planner 拿到确定的 [泰山, 黄山, 华山] 而不是泛化的"三种山景"。
        const ordered = parseOrderedEntitySelection(currentMessage);
        let selectedLabels: string[] | undefined;
        if (ordered) {
          const labels = ordered.selectedIndices
            .map(idx => best.candidate.entities[idx - 1])
            .filter((label): label is string => !!label);
          // 序号全部越界（列表太短）时不做选择，退回全量候选。
          if (labels.length > 0) selectedLabels = labels;
        }
        return {
          ...base,
          source: 'assistant_entity_list',
          entities: best.candidate.entities,
          entityCategory: category,
          grid: intent.grid,
          orderedSelection: ordered && selectedLabels
            ? { phrase: ordered.phrase, selectedIndices: ordered.selectedIndices, selectedLabels }
            : undefined,
          referenceExplanation: ordered && selectedLabels
            ? `“${ordered.phrase}”指上一轮 Agent 列出的${categoryLabel ? categoryLabel : '内容'}中的前 ${selectedLabels.length} 个：${selectedLabels.join('、')}。`
            : categoryLabel
              ? `“这些${categoryLabel}”指上一轮 Agent 列出的${categoryLabel}。`
              : '“这些”指上一轮 Agent 列出的内容。',
          sourceMessageIds: [best.candidate.messageId],
          sourceLabel: `上一轮${categoryLabel}列表`,
        };
      }
      // 引用了"这些"但没有任何可信实体列表 → 返回低置信度结果，
      // 由调用方决定是否 needs_clarification（spec 八十九节）。
      return {
        ...base,
        source: 'current_message',
        grid: intent.grid,
        referenceExplanation: '未能在最近对话中找到所引用的内容。',
      };
    }

    // 没有 entity list 候选 → 退回 Prompt 块 / previous task / visual proposal
    const promptContext = findPromptContext(history, intent);
    if (promptContext) return { ...base, ...promptContext, grid: intent.grid } as ResolvedChatExecutionContext;
    return {
      ...base,
      source: 'current_message' as const,
      grid: intent.grid,
      referenceExplanation: '未能在最近对话中找到所引用的内容。',
    };
  }

  // ---- 非引用型：Prompt 块 / Previous Task / Visual Proposal（原有行为增强） ----
  const promptContext = findPromptContext(history, intent);
  if (promptContext) return { ...base, ...promptContext, grid: intent.grid } as ResolvedChatExecutionContext;

  // 非引用、无上下文：仍然返回 current_message 上下文（有 grid 信息时），
  // 让 Planner 正常处理"帮我生成一个中国建筑九宫格"这种自包含请求。
  return {
    ...base,
    source: 'current_message',
    grid: intent.grid,
  };
}

function findIntroLine(content: string): string {
  const lines = content.split(/\r?\n/);
  // 找列表前最后一行非空文本
  let intro = '';
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^[-*•·]\s/.test(line) || /^\d{1,3}[.、．)）]\s/.test(line)) break;
    intro = line;
  }
  // 单行顿号列举时 intro 是该行本身
  if (!intro) intro = lines[0] || '';
  return intro;
}

/** Prompt 块 → Previous Task → Visual Proposal 的非引用回退链。 */
function findPromptContext(
  history: Array<Pick<ChatMessage, 'id' | 'role' | 'content' | 'task_message'>>,
  intent: ChatExecutionIntent,
): Partial<ResolvedChatExecutionContext> | null {
  // 1. Assistant Prompt 块（从最近往回）
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i];
    if (msg.role !== 'assistant') continue;
    const { prompt, negativePrompt } = extractPromptBlock(msg.content || '');
    if (prompt && prompt.length >= 8) {
      return {
        source: 'assistant_prompt',
        prompt,
        negativePrompt,
        sourceMessageIds: [msg.id],
        sourceLabel: '上一轮提示词',
        referenceExplanation: '继承上一轮 Agent 给出的提示词。',
      };
    }
  }

  // 2. Previous Task finalPrompt（从最近往回）
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i];
    if (msg.role !== 'assistant' || !msg.task_message) continue;
    const finalPrompt = msg.task_message.finalPrompt;
    if (finalPrompt && finalPrompt.trim().length >= 8 && msg.task_message.stage === 'success') {
      return {
        source: 'previous_task',
        prompt: finalPrompt,
        negativePrompt: msg.task_message.finalNegativePrompt || undefined,
        sourceMessageIds: [msg.id],
        sourceLabel: '上一个任务的最终提示词',
        referenceExplanation: '继承最近一个已完成任务的最终提示词。',
      };
    }
  }

  // 3. Assistant 视觉方案（semanticSummary）
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i];
    if (msg.role !== 'assistant') continue;
    const content = msg.content || '';
    if (isVisualProposalText(content)) {
      return {
        source: 'assistant_visual_plan',
        semanticSummary: content.trim().slice(0, 600),
        sourceMessageIds: [msg.id],
        sourceLabel: '上一轮视觉方案',
        referenceExplanation: '继承上一轮 Agent 描述的视觉方案。',
      };
    }
  }

  // 非引用型请求不需要 visual proposal 强行兜底（避免污染自包含请求）。
  if (!intent.referencesPreviousContext) return null;
  return null;
}

// ============================================================================
// Planner Handoff Context 渲染
// ============================================================================

/**
 * 把 ResolvedChatExecutionContext 渲染成 Planner user prompt 中的
 * "[对话转任务上下文]" 段落（spec 三十一节）。
 */
export function renderChatHandoffContextForPlanner(ctx: ResolvedChatExecutionContext): string {
  const lines: string[] = [];
  lines.push('[对话转任务上下文]');
  lines.push(`用户当前执行需求：\n${ctx.currentRequest}`);
  lines.push('');

  if (ctx.referenceExplanation) {
    lines.push(`上下文引用：\n${ctx.referenceExplanation}`);
    lines.push('');
  }

  // 关键（本轮修复）：存在明确 ordered selection（"前3个"）时，Planner 只允许
  // 看到 selected subset —— 完整候选列表不进入 Planner prompt，防止模型重新
  // 使用全部历史实体（"五岳 + 黄山 + 峨眉山……"整体继承的旧根因）。
  const hasOrderedSelection = !!ctx.orderedSelection && ctx.orderedSelection.selectedLabels.length > 0;

  if (hasOrderedSelection) {
    const sel = ctx.orderedSelection!;
    lines.push(`顺序实体选择：`);
    lines.push(`用户所说“${sel.phrase}”已解析为以下 ${sel.selectedLabels.length} 个确定主体（必须逐格绑定，不得泛化、不得替换成其他实体）：`);
    sel.selectedLabels.forEach((label, idx) => {
      lines.push(`第 ${idx + 1} 个主体：${label}`);
    });
    lines.push(`仅允许使用以上 ${sel.selectedLabels.length} 个主体，不要重新使用完整的历史实体列表。`);
    lines.push('');
  } else if (ctx.entities && ctx.entities.length > 0) {
    lines.push('候选实体：');
    ctx.entities.forEach((entity, idx) => {
      lines.push(`${idx + 1}. ${entity}`);
    });
    lines.push('');
  }

  if (ctx.grid) {
    lines.push(`布局：\n${ctx.grid.rows}×${ctx.grid.columns} 宫格，共需要 ${ctx.grid.cellCount} 个主体。`);
    lines.push('');
  }

  if (ctx.prompt) {
    lines.push(`继承的提示词：\n${ctx.prompt.slice(0, 600)}`);
    if (ctx.negativePrompt) {
      lines.push(`继承的负面提示词：\n${ctx.negativePrompt.slice(0, 300)}`);
    }
    lines.push('');
  }

  if (ctx.semanticSummary) {
    lines.push(`继承的视觉方案：\n${ctx.semanticSummary}`);
    lines.push('');
  }

  if (ctx.orderedSelection && ctx.orderedSelection.selectedLabels.length > 0 && ctx.grid) {
    const sel = ctx.orderedSelection;
    lines.push(
      `要求：用户要的是**单张图**中的 ${ctx.grid.rows}×${ctx.grid.columns} 复合构图，不是 ${ctx.grid.cellCount} 张图，也不是批量任务；输出数量为 1。每个格子绑定上方“顺序实体选择”中列出的对应主体（第 ${sel.selectedLabels.map((_, i) => i + 1).join('、')} 格分别对应 ${sel.selectedLabels.join('、')}）。`,
    );
  } else if (ctx.entities && ctx.grid && ctx.entities.length > ctx.grid.cellCount) {
    lines.push(
      `要求：候选实体共 ${ctx.entities.length} 个，超过宫格容量 ${ctx.grid.cellCount} 个。请自主选择最具代表性的 ${ctx.grid.cellCount} 个组成 ${ctx.grid.rows}×${ctx.grid.columns} 宫格，不要为了可合理默认的信息再次询问用户。`,
    );
  } else if (ctx.entities && ctx.entities.length > 0) {
    lines.push('要求：不要要求用户重新列出已经存在于上方候选实体中的内容。');
  }

  return lines.join('\n');
}
