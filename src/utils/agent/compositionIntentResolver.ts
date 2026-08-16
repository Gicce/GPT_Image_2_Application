/**
 * 复合构图 vs 批量输出判别器（Composition Intent Resolver）。
 *
 * 历史问题（本轮 bug 根因）：
 *   用户说 "给我生成前3个山的风景图把一张图里展示3个风景。3分镜图把"，
 *   detectBatchPlan → parseRequestedCount 用 /(\d+)\s*(张|份|个|套|版|版本)/
 *   把 "前3个山" 的 "3个" 误读成 "3 张图"，于是被判成
 *   batch / repeat_same / targetCount=3，最终生成 3 张批量图。
 *
 * 本模块职责（本地、确定、可解释，不调用 LLM）：
 *   1. 识别"单张复合构图"表达（一张图里展示 N 个 / 三分镜 / 三联画 / 九宫格 /
 *      拼图海报 / 分屏 / 左中右 / 三栏……）→ single_composite_image，输出 1 张图。
 *   2. 识别"批量多图输出"表达（生成 3 张 / 出 3 个版本 / 每个来一张……）
 *      → batch_images。
 *   3. 提取顺序实体引用（"前3个 / 前三个 / 第1和第2个"），供上层绑定到
 *      上文 Assistant 实体列表的具体条目。
 *
 * 判定原则：
 *   - "3分镜" ≠ "生成 3 张"；"九宫格" ≠ "生成 9 张"。
 *   - 复合构图信号与批量信号同时出现时，复合构图优先（用户明确说了
 *     "一张图 / 同一张图 / 放在一张图里"）。
 *   - 量词计数必须绑定"张"类图像量词；"前3个山"的"个"是实体计数，
 *     不是图像张数。
 */

// ============================================================================
// 类型
// ============================================================================

export type OutputStructureKind =
  | 'single_image'
  | 'single_composite_image'
  | 'batch_images';

export type CompositeLayoutType =
  | 'triptych'
  | 'grid'
  | 'split_screen'
  | 'unknown';

export interface ResolvedOutputStructure {
  kind: OutputStructureKind;
  /** 用户请求的图片张数。复合构图恒为 1。 */
  requestedImageCount: number;
  /** 复合构图的分格数量（三分镜=3，九宫格=9）。 */
  compositePanelCount?: number;
  layoutType?: CompositeLayoutType;
  confidence: 'high' | 'medium' | 'low';
  /** 判定证据（诊断 / 测试断言用）。 */
  evidence: string[];
}

/** 顺序实体引用（"前3个" / "第1和第2个"）。 */
export interface OrderedEntitySelection {
  /** 引用词原文，例如 "前3个"。 */
  phrase: string;
  /** 选中的序号（1-based）。 */
  selectedIndices: number[];
}

// ============================================================================
// 复合构图表达
// ============================================================================

/**
 * 强复合信号：出现即表明用户要的是"同一张图里的多格构图"。
 * 每条 pattern 附带它暗示的分格数（可选）。
 */
const COMPOSITE_STRONG_PATTERNS: Array<{
  pattern: RegExp;
  label: string;
  panelCount?: number;
  layout?: CompositeLayoutType;
  panelFromDigit?: boolean;
  panelFromCnNum?: boolean;
  panelFromGridWord?: boolean;
}> = [
  { pattern: /一张图(?:里|中|内)?(?:展示|放|包含|呈现|有|显示)/, label: '一张图里展示多个内容' },
  { pattern: /同一张图(?:里|中|内)?/, label: '同一张图' },
  { pattern: /(?:放在|放到|拼[在到]?)一张图(?:里|中|内)?/, label: '放在一张图里' },
  { pattern: /(\d+)\s*分镜/, label: 'N分镜', panelFromDigit: true, layout: 'triptych' },
  { pattern: /([一二三四五六七八九十]+)\s*分镜/, label: '中文数字分镜', panelFromCnNum: true, layout: 'triptych' },
  { pattern: /三联画|三联屏/, label: '联画', panelCount: 3 },
  { pattern: /双联画|二联画/, label: '双联画', panelCount: 2 },
  { pattern: /四联画/, label: '四联画', panelCount: 4 },
  { pattern: /三分屏|分屏展示|多分屏|左右分屏|上下分屏/, label: '分屏', layout: 'split_screen' },
  { pattern: /左中右(?:三个|3个|三块|3块)?(?:区域|画面|部分|格)?/, label: '左中右区域', panelCount: 3, layout: 'split_screen' },
  { pattern: /三栏|三列(?:展示|排列)?|三排/, label: '三栏', panelCount: 3 },
  { pattern: /三宫格|四宫格|五宫格|六宫格|七宫格|八宫格|九宫格|十六宫格|\d{1,2}宫格/, label: 'N宫格', panelFromGridWord: true, layout: 'grid' },
  { pattern: /拼图(?:海报|式)?|拼成一张|拼[成在]一图/, label: '拼图海报' },
  { pattern: /一个画面(?:里|中|内)?(?:放|展示|包含|有)/, label: '一个画面里放多个主体' },
  { pattern: /(?:合成|组合成|合并成)一张/, label: '合成一张' },
];

/**
 * 宫格词 → 分格数（复合信号里提取 panelCount 用）。
 */
const CN_NUM_MAP: Record<string, number> = {
  一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十六: 16,
};

function panelCountFromGridWord(text: string): number | undefined {
  const normalized = text.replace(/\s+/g, '');
  if (/九宫格|9宫格/.test(normalized)) return 9;
  const cnMatch = normalized.match(/([一二两三四五六七八九]|十六|十)宫格/);
  if (cnMatch) return CN_NUM_MAP[cnMatch[1]];
  const digitMatch = normalized.match(/(\d{1,2})宫格/);
  if (digitMatch) return parseInt(digitMatch[1], 10);
  return undefined;
}

// ============================================================================
// 批量输出表达
// ============================================================================

/**
 * 批量信号：数字 + "张"（或版本 / 方案类量词），且前面不是复合构图语境。
 * 关键：**不包含"个"** —— "前3个山"的"个"计实体，不计图片张数。
 */
const BATCH_COUNT_PATTERN = /(\d+)\s*(?:张|套图|组图)|(?:出|生成|做|来|给我)\s*(\d+)\s*(?:张|个?版本|个?方案|个?风格)/;

const BATCH_KEYWORD_PATTERN = /(一批|都给我|每(?:个|张|张图)来一张|分别生成|分别做|一共(?:输出|做|生成)?\s*\d+\s*张|多个版本|多张不同)/;

// ============================================================================
// 顺序实体引用
// ============================================================================

/**
 * "前3个 / 前三个 / 前2个" —— 注意必须排除 "前3个" 被图像计数逻辑误读。
 */
const ORDERED_PREFIX_PATTERN = /前\s*(\d{1,2})\s*(?:个|张|位|座|项|条)/;

const ORDERED_PREFIX_CN_PATTERN = /前\s*([一二两三四五六七八九十])\s*(?:个|张|位|座|项|条)/;

/** "第1和第2个 / 第1、第2个" —— 显式序号选择。 */
const EXPLICIT_INDEX_PATTERN = /第\s*(\d{1,2})\s*(?:个|张|位|座|项|条)?(?:\s*(?:和|与|、|及)\s*第?\s*(\d{1,2})\s*(?:个|张|位|座|项|条)?)*/;

/**
 * 解析"前N个"型顺序引用。
 * 返回 null 表示当前文本没有顺序引用。
 */
export function parseOrderedEntitySelection(text: string): OrderedEntitySelection | null {
  if (!text) return null;
  const digitMatch = text.match(ORDERED_PREFIX_PATTERN);
  if (digitMatch) {
    const n = parseInt(digitMatch[1], 10);
    if (n > 0 && n <= 20) {
      return { phrase: digitMatch[0], selectedIndices: Array.from({ length: n }, (_, i) => i + 1) };
    }
  }
  const cnMatch = text.match(ORDERED_PREFIX_CN_PATTERN);
  if (cnMatch) {
    const n = CN_NUM_MAP[cnMatch[1]];
    if (n && n > 0 && n <= 20) {
      return { phrase: cnMatch[0], selectedIndices: Array.from({ length: n }, (_, i) => i + 1) };
    }
  }
  // "第1和第2个"：收集所有显式序号
  const indexMatches = Array.from(text.matchAll(/第\s*(\d{1,2})\s*(?:个|张|位|座|项|条)/g));
  if (indexMatches.length >= 1) {
    const indices = indexMatches
      .map(m => parseInt(m[1], 10))
      .filter(n => n > 0 && n <= 20);
    if (indices.length > 0) {
      return { phrase: indexMatches.map(m => m[0]).join('、'), selectedIndices: [...new Set(indices)].sort((a, b) => a - b) };
    }
  }
  return null;
}

// ============================================================================
// 核心：resolveOutputStructure
// ============================================================================

/**
 * 判别当前请求的输出结构：单张 / 单张复合构图 / 批量多图。
 *
 * 优先级：
 *   1. 强复合信号（一张图里展示 / 三分镜 / 九宫格……）→ single_composite_image。
 *   2. 批量信号（生成3张 / 3个版本……，且没有复合信号）→ batch_images。
 *   3. 默认 → single_image。
 */
export function resolveOutputStructure(text: string): ResolvedOutputStructure {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { kind: 'single_image', requestedImageCount: 1, confidence: 'high', evidence: ['空输入默认单张'] };
  }

  const evidence: string[] = [];

  // ---- 1. 复合构图信号 ----
  let compositePanelCount: number | undefined;
  let layoutType: CompositeLayoutType | undefined;
  let hasCompositeSignal = false;

  for (const rule of COMPOSITE_STRONG_PATTERNS) {
    const match = trimmed.match(rule.pattern);
    if (!match) continue;
    hasCompositeSignal = true;
    evidence.push(`复合信号:${rule.label}`);
    if (rule.layout && !layoutType) layoutType = rule.layout;
    if (rule.panelFromDigit) {
      const n = parseInt(match[1], 10);
      if (n > 0 && n <= 16) compositePanelCount = n;
    } else if (rule.panelFromCnNum) {
      const n = CN_NUM_MAP[match[1]];
      if (n > 0 && n <= 16) compositePanelCount = n;
    } else if (rule.panelFromGridWord) {
      const n = panelCountFromGridWord(trimmed);
      if (n && n > 1 && (!compositePanelCount || n > compositePanelCount)) compositePanelCount = n;
    } else if (rule.panelCount && !compositePanelCount) {
      compositePanelCount = rule.panelCount;
    }
  }

  // "一张图里展示3个风景" —— "展示 N 个" 也是 panel 计数线索
  if (hasCompositeSignal && !compositePanelCount) {
    const showNMatch = trimmed.match(/(?:展示|放|包含|呈现|有|显示)\s*(\d{1,2}|[一二两三四五六七八九十])\s*(?:个|座|位|处)/);
    if (showNMatch) {
      const n = /^\d+$/.test(showNMatch[1]) ? parseInt(showNMatch[1], 10) : CN_NUM_MAP[showNMatch[1]];
      if (n > 1 && n <= 16) {
        compositePanelCount = n;
        evidence.push(`展示${n}个主体`);
      }
    }
  }

  if (hasCompositeSignal) {
    return {
      kind: 'single_composite_image',
      requestedImageCount: 1,
      compositePanelCount: compositePanelCount || (layoutType === 'split_screen' ? 2 : undefined),
      layoutType: layoutType || (compositePanelCount === 3 ? 'triptych' : compositePanelCount ? 'grid' : 'unknown'),
      confidence: compositePanelCount ? 'high' : 'medium',
      evidence,
    };
  }

  // ---- 2. 批量信号 ----
  const batchCountMatch = trimmed.match(BATCH_COUNT_PATTERN);
  const batchKeyword = BATCH_KEYWORD_PATTERN.test(trimmed);
  if (batchCountMatch || batchKeyword) {
    let count = 1;
    if (batchCountMatch) {
      const raw = batchCountMatch[1] || batchCountMatch[2];
      const n = raw ? parseInt(raw, 10) : 1;
      if (n > 1) count = n;
    }
    if (batchKeyword && count === 1) count = 0; // "一批 / 都给我" → 未知数量
    if (count !== 1) {
      if (batchCountMatch) evidence.push(`批量计数:${batchCountMatch[0]}`);
      if (batchKeyword) evidence.push('批量关键词');
      return { kind: 'batch_images', requestedImageCount: Math.max(2, count), confidence: 'high', evidence };
    }
  }

  // ---- 3. 默认单张 ----
  return { kind: 'single_image', requestedImageCount: 1, confidence: 'medium', evidence: ['无复合/批量信号，默认单张'] };
}

/**
 * 给 detectBatchPlan 用的安全计数：只在判别结果不是 single_composite_image 时
 * 才允许把数字读成图片张数；复合构图恒为 1 张。
 */
export function safeImageCountForBatchPlan(text: string, rawRequestedCount: number): number {
  const structure = resolveOutputStructure(text);
  if (structure.kind === 'single_composite_image') return 1;
  return rawRequestedCount;
}
