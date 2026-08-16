/**
 * Atomic Entity Extraction（原子实体提取）。
 *
 * 历史问题：extractEntityList 按 bullet / 编号行粒度提取实体，而真实 Assistant
 * 回复常出现"分组展开"形态：
 *
 *   - 五岳：泰山、华山、衡山、嵩山、恒山
 *   - 黄山：以奇松、怪石、云海闻名
 *
 * 旧行为把整行当成 1 个实体，用户说"前3个山"时切出来的是
 * ["五岳：泰山、华山、衡山、嵩山、恒山", "黄山：……", ...] —— 整个山列表被
 * 过度继承进任务。正确语义是：
 *
 *   - "五岳" 是 group label（分类标签），泰山 / 华山 / 衡山 / 嵩山 / 恒山 才是
 *     atomic entities（5 个）。
 *   - "黄山：以奇松、怪石、云海闻名" 中冒号后是描述文本，不是实体列表 ——
 *     只有"黄山"本身是实体，"奇松 / 怪石 / 云海"不能被拆成山。
 *
 * 判别启发式（通用，不硬编码任何名单）：
 *   group expansion（冒号后是实体列表）当且仅当：
 *     1. 冒号前 group label 是短名词（≤ 8 字，如 五岳 / 四大名著 / 主要角色）；
 *     2. 冒号后可按顿号 / 逗号拆成 ≥ 2 段；
 *     3. 每段都是"专名形态"：长度 1~8、不含描述性功能词
 *        （以 / 因 / 闻名 / 位于 / 海拔 / 风景 / 之一……）。
 *   否则视为 description —— 冒号前整段（若本身是专名）是实体，冒号后忽略。
 *
 * 粒度约定：
 *   - 顶层 bullet / 编号行沿用宽松清洗（≤30 字，允许 国家体育场"鸟巢" 这类
 *     带引号全名），保证既有行为不回归；
 *   - 严格专名校验只用于"分组展开判定"（冒号后的 parts 与 group label）。
 */

export interface OrderedSemanticEntity {
  /** 原子实体名（泰山 / 红楼梦 / 角色A）。 */
  label: string;
  /** 分组标签（五岳 / 四大名著 / 主要角色），无分组时 undefined。 */
  groupLabel?: string;
  /** 在来源消息中的顺序（0-based，跨行连续）。 */
  sourceOrder: number;
  /** 来源消息 id（调用方填充，诊断用）。 */
  sourceMessageId?: string;
}

/** 描述性功能词 —— 命中任意一个即认为该段是描述文本而非实体名。 */
const DESCRIPTION_MARKER_PATTERN =
  /(以|因|而|自|从|其|该|还|也|均|皆|闻名|著称|位于|海拔|享有|誉为|称为|属于|包括|还有|其中|之一|风景|景色|名胜|景区|特色|特点|外观|简介|拥有|呈现|画面|风格)/;

/** 列表引导词 —— 出现在冒号前时该行是引导句，group label 本身不是实体。 */
const GUIDE_WORD_PATTERN = /(例如|如下|以下|列举|包括|推荐|常见|这些|名单|清单|大全)/;

/**
 * 严格专名校验 —— 只用于分组展开判定（parts 与 group label）。
 * 顶层 bullet 行不走这里（宽松规则），避免误杀"国家体育场"鸟巢""类全名。
 */
function isNameLike(part: string): boolean {
  const p = part.trim();
  if (!p) return false;
  // 分组内实体名长度 1~8（"泰山"2、"红楼梦"3、"三国演义"4）。
  if (p.length > 8) return false;
  // 纯数字 / 尺寸不是实体。
  if (/^\d[\d.x×*%]*$/.test(p)) return false;
  if (DESCRIPTION_MARKER_PATTERN.test(p)) return false;
  return true;
}

/** 行内 markdown 清洗（加粗 / 链接 / 标题符）。 */
function cleanLineItem(item: string): string {
  return item
    .replace(/\*\*/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/, '')
    .trim();
}

/** 顶层实体行清洗（与 extractEntityList 原有行为一致）。 */
function cleanTopLevelItem(item: string): string | null {
  let cleaned = cleanLineItem(item);
  // 截断尾部说明（"长城 —— 中国古代防御工程" → "长城"），
  // 但保留引号内的名称（国家体育场"鸟巢"）。
  const dashSplit = cleaned.split(/\s*[—–\-]{1,2}\s+/);
  if (dashSplit.length > 1 && dashSplit[0].length >= 1) {
    cleaned = dashSplit[0].trim();
  }
  if (!cleaned) return null;
  // 过滤纯数字 / 尺寸 / 版本号（1024x1024、11、3.5）
  if (/^\d[\d.x×*]*$/.test(cleaned)) return null;
  if (/^\d+(\.\d+)+$/.test(cleaned)) return null;
  // 过滤超长条目（更像句子而不是实体）
  if (cleaned.length > 30) return null;
  return cleaned;
}

/** 去掉实体尾部 "—— 说明" 形式的补充描述。 */
function stripTrailingDescription(label: string): string {
  const dashSplit = label.split(/\s*[—–\-]{1,2}\s+/);
  return (dashSplit.length > 1 ? dashSplit[0] : label).trim();
}

/** 把 rest 按顿号 / 逗号拆成清洗后的段。 */
function splitNameParts(rest: string): string[] {
  return rest
    .replace(/……|…$/, '')
    .split(/[、，,]/)
    .map(p => cleanLineItem(p))
    .filter(Boolean);
}

/** 判定冒号后的 rest 是不是实体列表（group expansion）。 */
function isGroupExpansion(rest: string): boolean {
  const parts = splitNameParts(rest);
  if (parts.length < 2) return false;
  return parts.every(part => isNameLike(part));
}

/**
 * 处理一条已清洗的列表项 / 单行：按 atomic 粒度追加实体。
 * 返回 true 表示该行产出至少 1 个实体。
 */
function pushAtomicFromItem(item: string, entities: OrderedSemanticEntity[]): boolean {
  // 含冒号的行：只走 group expansion / 专名判定。冒号后为空或 label 过长的
  // 是引导句（"中国著名的山有很多：" / "常见角色如下："），整行丢弃，
  // 绝不能落入通用路径被当成实体。
  if (item.includes('：') || item.includes(':')) {
    const colonMatch = item.match(/^([^：:]{1,12})[：:]\s*(.+)$/);
    if (!colonMatch) return false;
    const groupLabel = cleanLineItem(colonMatch[1]);
    const rest = colonMatch[2].trim();
    if (isGroupExpansion(rest)) {
      for (const part of splitNameParts(rest)) {
        entities.push({ label: part, groupLabel: groupLabel || undefined, sourceOrder: entities.length });
      }
      return true;
    }
    // 不是实体列表 → 冒号后是描述。只有 group label 本身是专名且不是引导词时
    // 才作为实体（"黄山：以奇松、怪石、云海闻名" → 实体=黄山）。
    if (isNameLike(groupLabel) && !GUIDE_WORD_PATTERN.test(groupLabel)) {
      entities.push({ label: groupLabel, sourceOrder: entities.length });
      return true;
    }
    return false;
  }
  // 无冒号：普通实体行（可带 "—— 说明" 尾部）。
  const label = stripTrailingDescription(item);
  if (label && !/^\d[\d.x×*%]*$/.test(label) && label.length <= 30) {
    entities.push({ label, sourceOrder: entities.length });
    return true;
  }
  return false;
}

/**
 * 从 Assistant 文本中提取有序原子实体列表。
 * 支持三种形态（与 extractEntityList 一致），但粒度细化到分组展开：
 *   1. bullet / 编号行，每行可再展开 group（"五岳：泰山、华山……"）；
 *   2. 单行顿号列举（"例如：长城、故宫、天坛……"）；
 *   3. 带 group label 的展开行（"四大名著：红楼梦、西游记……"）。
 *
 * 注意：本函数不做 "≥3 才算列表" 的守卫 —— 守卫由调用方（extractEntityList /
 * resolveChatExecutionContext）按原规则执行，这里只负责把文本拆成原子实体。
 */
export function extractOrderedAtomicEntities(text: string): OrderedSemanticEntity[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const entities: OrderedSemanticEntity[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const bulletMatch = line.match(/^[-*•·]\s*(.+)$/);
    const numberedMatch = line.match(/^(\d{1,3})[.、．)）]\s*(.+)$/);
    if (bulletMatch || numberedMatch) {
      const item = cleanLineItem(
        bulletMatch ? bulletMatch[1] : numberedMatch![2],
      );
      pushAtomicFromItem(item, entities);
      continue;
    }

    // 单行顿号列举（"例如：长城、故宫、天坛、颐和园……" /
    // "四大名著：红楼梦、西游记、水浒传、三国演义"）。
    if (line.includes('：') || line.includes(':')) {
      pushAtomicFromItem(cleanLineItem(line), entities);
    }
  }

  return entities;
}

/** 顶层宽松清洗导出（extractEntityList 复用，保持旧 bullet 行为）。 */
export function cleanEntityItemForList(item: string): string | null {
  return cleanTopLevelItem(item);
}
