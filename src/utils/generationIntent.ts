/**
 * 文生图自然语言意图解析（本地、确定性、可测试，不调用 LLM）。
 *
 * 职责：
 *   1. parsePromptImageCount —— 从正向提示词解析"用户想要的图片张数"。
 *      只认图像量词（张 / 幅 / 张图 / 版本 / 方案），
 *      绝不把画面内实体计数（"3 个人""3 栋楼""前 3 个山"）当成张数。
 *   2. classifyGenerationIntent —— 判定批量语义：
 *        single       单张（含单张复合构图）
 *        repeat_same  同 Prompt 多变体（同一主体要 N 个随机变体）
 *        multi_prompt 多 Prompt 批量（不同对象 / 不同风格各出一张）
 *
 * 负面提示词禁止进入本模块（批量判定只看正向需求）。
 */

import { resolveOutputStructure } from './agent/compositionIntentResolver';

// ============================================================================
// 数量解析
// ============================================================================

const CN_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 中文数字 → 数值（支持 一~九、十、十几、几十、几十几，上限 99）。 */
function cnNumToInt(text: string): number | null {
  const s = text.replace(/\s+/g, '');
  if (!s) return null;
  if (s === '十') return 10;
  const tenIdx = s.indexOf('十');
  if (tenIdx === -1) {
    if (s.length === 1) return CN_DIGITS[s] ?? null;
    // 纯中文数字串（如"三十五"以外的奇怪形态）逐位只支持单字符
    return null;
  }
  const tensPart = s.slice(0, tenIdx);
  const onesPart = s.slice(tenIdx + 1);
  const tens = tensPart === '' ? 1 : CN_DIGITS[tensPart];
  if (tens === undefined) return null;
  if (onesPart === '') return tens * 10;
  if (onesPart.length !== 1) return null;
  const ones = CN_DIGITS[onesPart];
  if (ones === undefined) return null;
  return tens * 10 + ones;
}

/** 剥离"前 N 个 / 第 N 张"型顺序引用，防止实体计数污染图片张数。 */
function stripOrderedReferences(text: string): string {
  return text
    .replace(/前\s*\d{1,2}\s*(?:个|张|位|座|项|条|栋|棵|只|头)/g, '')
    .replace(/前\s*[一二两三四五六七八九十]+\s*(?:个|张|位|座|项|条|栋|棵|只|头)/g, '')
    .replace(/第\s*\d{1,2}\s*(?:个|张|位|座|项|条|栋|棵|只|头)/g, '')
    .replace(/第\s*[一二两三四五六七八九十]+\s*(?:个|张|位|座|项|条|栋|棵|只|头)/g, '');
}

const DIGIT_IMAGE_COUNT = /(\d{1,2})\s*(?:张|幅)(?:\s*(?:图|图片|照片|图像))?/;
const CN_IMAGE_COUNT = /([一二两三四五六七八九十]{1,3})\s*(?:张|幅)(?:\s*(?:图|图片|照片|图像))?/;
const VERSION_COUNT = /(\d{1,2})\s*个?\s*(?:版本|方案)/;

/** "各一张 / 分别一张 / 每个一张"是每对象配额，不是总张数，解析总量前先剥掉。 */
function stripPerObjectAllocations(text: string): string {
  return text
    .replace(/各\s*自?\s*[一二两三四五六七八九十\d]{0,2}\s*[张幅]/g, '')
    .replace(/分别\s*[一二两三四五六七八九十\d]{0,2}\s*[张幅]/g, '')
    .replace(/每\s*[个张张图像]{0,3}[^，。；;]{0,6}?\s*一?\s*[张幅]/g, '');
}

/**
 * 解析用户明确表达的图片张数。
 *
 * 返回 null 表示提示词里没有可识别的张数信号（UI 不应改动数量字段）。
 * 单张复合构图（"一张图里展示…"）返回 1。
 */
export function parsePromptImageCount(text: string): number | null {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  const structure = resolveOutputStructure(trimmed);
  if (structure.kind === 'single_composite_image') return 1;

  const cleaned = stripPerObjectAllocations(stripOrderedReferences(trimmed));

  const digit = cleaned.match(DIGIT_IMAGE_COUNT);
  if (digit) {
    const n = parseInt(digit[1], 10);
    if (n >= 1 && n <= 50) return n;
  }
  const version = cleaned.match(VERSION_COUNT);
  if (version) {
    const n = parseInt(version[1], 10);
    if (n >= 1 && n <= 50) return n;
  }
  const cn = cleaned.match(CN_IMAGE_COUNT);
  if (cn) {
    const n = cnNumToInt(cn[1]);
    if (n !== null && n >= 1 && n <= 50) return n;
  }
  return null;
}

// ============================================================================
// 生成数量状态机（manual > prompt > default）
// ============================================================================

export type GenerationCountSource = 'default' | 'prompt' | 'manual';

export interface GenerationCountState {
  /** 当前生成数量（UI 数字输入框的单一来源） */
  count: number;
  /** 数量来源：手动设置永不回落；提示词识别可被后续识别覆盖；系统默认可被识别提升 */
  source: GenerationCountSource;
  /** 是否显示"已从提示词识别：N 张"徽标 */
  fromPrompt: boolean;
}

/**
 * Prompt 变化时推导下一态生成数量。
 *
 * 关键规则：programmatic=true（AI 优化采用 / 恢复原文 / 模板写回等程序性
 * Prompt 更新）时直接返回 prev —— 不重新识别，也不回落默认值。
 * 只有用户手动编辑 Prompt 才允许触发自然语言数量识别；
 * manual 来源在任何情况下都不被覆盖。
 */
export function nextGenerationCountState(
  prompt: string,
  prev: GenerationCountState,
  options: { defaultCount: number; programmatic?: boolean },
): GenerationCountState {
  if (options.programmatic) return prev;
  if (prev.source === 'manual') return prev;

  const parsed = parsePromptImageCount(prompt);
  if (parsed !== null) {
    return { count: parsed, source: 'prompt', fromPrompt: true };
  }
  if (prev.source === 'prompt') {
    // 用户主动删掉了数量表达 → 回落系统默认（AI 写回不经过这里）
    return { count: options.defaultCount, source: 'default', fromPrompt: false };
  }
  return prev;
}

// ============================================================================
// 批量语义分类
// ============================================================================

export type GenerationBatchMode = 'single' | 'repeat_same' | 'multi_prompt';

export interface GenerationIntent {
  mode: GenerationBatchMode;
  /** 用户期望的总张数（各一张型 = 对象数）。 */
  requestedCount: number;
  /** 枚举出的差异化对象（"上海、北京、广州各一张" → 3 个），未知时为空。 */
  objects: string[];
  /** 是否表达"不同内容 / 差异化"意图。 */
  distinct: boolean;
  /** 判定证据（测试 / 日志用）。 */
  evidence: string[];
}

const DISTINCT_PATTERN = /(不同|分别|各自|各一?[张幅]|不一样|多种|多个(?:不同|不一样)|每[个张][^，。；;、]{0,8}一[张幅])/;

const ENUMERATION_SPLIT = /[、，,]|和|与|跟|加上/;

/**
 * 提取"A、B、C 各一张 / 分别一张"形态中的对象列表。
 * 只在出现"各一张 / 分别 / 各自"类分配词时尝试，避免误拆普通描述。
 *
 * 支持两种形态：
 *   1. 分隔符枚举："上海、北京、广州各一张"
 *   2. 等长连写："上海北京广州各一张"（中文常见无分隔符写法，按等长切块）
 */
export function extractDistinctObjects(text: string): string[] {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  const allocMatch = trimmed.match(/各一?[张幅]|分别|各自/);
  if (!allocMatch || allocMatch.index === undefined) return [];
  // 分配词之前最近的枚举段（截到分配词；容忍"各一张夜景"这类后缀）
  const before = trimmed.slice(0, allocMatch.index).replace(/[、，,。；;\s]+$/, '');
  // 枚举段 = 最后一个不包含句读/换行的连续片段
  const segments = before.split(/[。；;！!？?\n，,]/);
  const candidate = (segments[segments.length - 1] || '')
    .replace(/^(?:帮我|给我|请|生成|做|来|画|要|需要|出|制作)+/, '')
    .trim();
  if (!candidate || /的|了|是/.test(candidate)) return [];

  if (ENUMERATION_SPLIT.test(candidate)) {
    const objects = candidate
      .split(ENUMERATION_SPLIT)
      .map(part => part.trim())
      .filter(part => part.length >= 1 && part.length <= 10)
      .filter(Boolean);
    if (objects.length >= 2 && objects.length <= 20) return objects;
    return [];
  }

  // 无分隔符等长连写（仅在明确的"各一张 / 分别一张 / 各自一张"分配语境下启用）：
  // 偶数长度优先按 2 字块（上海北京广州→上海/北京/广州），否则按 3 的约数块。
  if (!/(?:各|分别|各自)\s*一?\s*[张幅]/.test(trimmed)) return [];
  const len = candidate.length;
  let chunkSize = 0;
  if (len >= 4 && len <= 12 && len % 2 === 0) chunkSize = 2;
  else if (len >= 3 && len <= 9 && len % 3 === 0) chunkSize = Math.max(1, Math.floor(len / 3));
  if (!chunkSize) return [];
  const objects: string[] = [];
  for (let i = 0; i < len; i += chunkSize) objects.push(candidate.slice(i, i + chunkSize));
  return objects.length >= 2 && objects.length <= 8 ? objects : [];
}

/**
 * 判定批量语义。
 *
 * 优先级（与产品规则一致）：
 *   1. 单张复合构图 → single（输出 1 张，绝不拆分）。
 *   2. 枚举对象 + 各一张 / 差异化表达 → multi_prompt（一对象一 Prompt 一张图）。
 *   3. 有张数但无差异化表达 → repeat_same（同 Prompt 随机变体）。
 */
export function classifyGenerationIntent(text: string): GenerationIntent {
  const trimmed = (text || '').trim();
  const evidence: string[] = [];
  if (!trimmed) {
    return { mode: 'single', requestedCount: 1, objects: [], distinct: false, evidence: ['空输入'] };
  }

  const structure = resolveOutputStructure(trimmed);
  if (structure.kind === 'single_composite_image') {
    evidence.push(`复合构图:${structure.evidence.join('|')}`);
    return { mode: 'single', requestedCount: 1, objects: [], distinct: false, evidence };
  }

  const objects = extractDistinctObjects(trimmed);
  if (objects.length >= 2) evidence.push(`枚举对象×${objects.length}:${objects.join('/')}`);

  const distinct = DISTINCT_PATTERN.test(trimmed) || objects.length >= 2;
  if (distinct && objects.length < 2) evidence.push('差异化表达');

  const directCount = parsePromptImageCount(trimmed);
  // "A、B、C 各一张"形态：对象数就是总张数（每个对象恰好一张）
  const requestedCount = objects.length >= 2
    ? objects.length
    : (directCount ?? (structure.requestedImageCount || 1));

  if (requestedCount <= 1 && objects.length < 2) {
    // "猫狗兔各一张"这类无分隔符、张数不明的分配表达：至少拆 2 张独立图
    if (distinct) {
      return { mode: 'multi_prompt', requestedCount: 2, objects: [], distinct: true, evidence: [...evidence, '分配语境'] };
    }
    return { mode: 'single', requestedCount: 1, objects, distinct: false, evidence: [...evidence, '无批量信号'] };
  }
  if (distinct) {
    return { mode: 'multi_prompt', requestedCount: Math.max(2, requestedCount), objects, distinct: true, evidence };
  }
  return { mode: 'repeat_same', requestedCount: Math.max(2, requestedCount), objects, distinct: false, evidence };
}
