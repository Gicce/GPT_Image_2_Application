/**
 * Image Mention（V4.0.9 @图片引用 + 双图角色语义）。
 *
 * 三件事：
 *  1. 当前任务图片池（buildVisionContextImages）：聚合主参考图 / 人物替换参考 /
 *     图库附加参考 / 当前任务生成结果，按路径去重、业务标签标注——
 *     @ 弹层、引用 chips、优化器 payload 共用这一个池（禁止各自维护图片数组）。
 *  2. Mention token（@标签）：插入 / 定位 / 清理——freeText 中的 @token 是普通文本
 *     （持久化安全），真实图片绑定在 draft.mentions 侧车表（assetId / path / role）。
 *  3. 双图角色解析（resolveImageMentionRoles）：把「把 @图二 的人物换成 @图三」类
 *     表达映射为 template（模板/风格/构图参考）+ person（人物替换来源）；
 *     面板显式选择 > 明确 Mention > 自然语言推断，绝不偷偷覆盖面板值。
 *
 * 本模块为纯函数（无 React / store / api 依赖），方便单测与 Rust 无关复用。
 */

/** 图片引用在当前任务中的语义角色（角色 → 中文标签单一来源）。 */
export type ImageMentionRole =
  | 'template_reference'
  | 'person_replacement_reference'
  | 'source_reference'
  | 'generated_result_reference'
  | 'background_reference'
  | 'generic_reference';

export const IMAGE_MENTION_ROLE_LABELS: Record<ImageMentionRole, string> = {
  template_reference: '模板图',
  person_replacement_reference: '人物参考',
  source_reference: '主参考图',
  generated_result_reference: '生成结果',
  background_reference: '背景参考',
  generic_reference: '图片引用',
};

/** @ 弹层 / 引用 chip 中对用户的角色说明（用途一句话）。 */
export const IMAGE_MENTION_ROLE_NOTES: Record<ImageMentionRole, string> = {
  template_reference: '延续画风、构图、背景与整体氛围',
  person_replacement_reference: '替换主角身份、五官、发型和人物特征',
  source_reference: '当前任务的主参考图（画面模板）',
  generated_result_reference: '本任务已生成的图片',
  background_reference: '背景参考',
  generic_reference: '从图片库加入当前任务的参考图',
};

/** 一条真实图片引用绑定（token 在 freeText 里，本结构是侧车绑定）。 */
export interface ImageMention {
  id: string;
  assetId?: string;
  path: string;
  /** 展示名（弹层 / chip / 优化器标注）。 */
  label: string;
  /** 插入文本的 token 名（label 去空白版；匹配 @token 用）。 */
  token: string;
  role: ImageMentionRole;
}

/** 图片池条目（当前任务上下文中的可引用图片）。 */
export interface VisionContextImage {
  /** 稳定 key：assetId 优先，否则归一化路径。 */
  key: string;
  assetId?: string;
  path: string;
  label: string;
  role: ImageMentionRole;
  roleLabel: string;
  note: string;
}

/** 人物替换参考的结构最小面（与 PersonReplacement 结构兼容，避免循环依赖）。 */
interface PersonLike {
  source: string;
  assetId?: string;
  path?: string;
  label?: string;
  description?: string;
}

export interface VisionContextPoolInput {
  sourcePath?: string;
  sourceAssetId?: string;
  person?: PersonLike | null;
  extraReferences?: ReadonlyArray<{ assetId?: string; path: string; label?: string }>;
  generatedResults?: ReadonlyArray<{ assetId?: string; path?: string }>;
  /** 生成结果展示名（默认按序号「生成结果 N」）。 */
  generatedLabels?: ReadonlyArray<string>;
}

/** 路径归一（Windows 大小写 / 分隔符差异不影响去重）。 */
export function normalizeImagePath(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase();
}

function fileLabelOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * 构建当前任务图片池（唯一来源）。
 *
 * 顺序：人物参考（已设置时置顶，便于 @ 候选优先）→ 主参考图 → 图库附加参考 → 生成结果。
 * 去重：同路径只保留一条，角色优先级 person > source > generic > generated
 * （更具体的业务标签覆盖更泛的标签，同一张图绝不出现两次）。
 */
export function buildVisionContextImages(input: VisionContextPoolInput): VisionContextImage[] {
  const entries: Array<{ image: Omit<VisionContextImage, 'key' | 'roleLabel'>; priority: number }> = [];

  if (input.person && input.person.source !== 'description' && input.person.path?.trim()) {
    entries.push({
      image: {
        assetId: input.person.assetId,
        path: input.person.path,
        label: input.person.label?.trim() || fileLabelOf(input.person.path),
        role: 'person_replacement_reference',
        note: IMAGE_MENTION_ROLE_NOTES.person_replacement_reference,
      },
      priority: 3,
    });
  }
  if (input.sourcePath?.trim()) {
    entries.push({
      image: {
        assetId: input.sourceAssetId,
        path: input.sourcePath,
        label: '原图',
        role: 'source_reference',
        note: IMAGE_MENTION_ROLE_NOTES.source_reference,
      },
      priority: 2,
    });
  }
  for (const ref of input.extraReferences ?? []) {
    if (!ref.path?.trim()) continue;
    entries.push({
      image: {
        assetId: ref.assetId,
        path: ref.path,
        label: ref.label?.trim() || fileLabelOf(ref.path),
        role: 'generic_reference',
        note: IMAGE_MENTION_ROLE_NOTES.generic_reference,
      },
      priority: 1,
    });
  }
  let generatedIndex = 0;
  for (const result of input.generatedResults ?? []) {
    const path = result.path?.trim();
    if (!path) continue;
    generatedIndex += 1;
    entries.push({
      image: {
        assetId: result.assetId,
        path,
        label: input.generatedLabels?.[generatedIndex - 1] || `生成结果 ${generatedIndex}`,
        role: 'generated_result_reference',
        note: IMAGE_MENTION_ROLE_NOTES.generated_result_reference,
      },
      priority: 0,
    });
  }

  const byPath = new Map<string, { image: Omit<VisionContextImage, 'key' | 'roleLabel'>; priority: number }>();
  for (const entry of entries) {
    const key = normalizeImagePath(entry.image.path);
    const existing = byPath.get(key);
    if (!existing || entry.priority > existing.priority) byPath.set(key, entry);
  }
  return [...byPath.values()].map(({ image }) => ({
    ...image,
    key: image.assetId ?? normalizeImagePath(image.path),
    roleLabel: IMAGE_MENTION_ROLE_LABELS[image.role],
  }));
}

// ===== Mention token（插入 / 定位 / 清理） =====

/** label → token：去掉空白并截断（超长文件名不得压坏输入区；完整名在 chip / hover 可见）。 */
export function mentionTokenOf(label: string): string {
  const compact = label.replace(/\s+/g, '');
  return compact.length > 16 ? `${compact.slice(0, 15)}…` : (compact || '图片');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface MentionTokenMatch {
  mentionId: string;
  start: number;
  end: number;
}

/** 文本中全部 @token 出现位置（token 长者优先，避免前缀吞并；按出现位置排序）。 */
export function findMentionTokens(text: string, mentions: ReadonlyArray<ImageMention>): MentionTokenMatch[] {
  const matches: MentionTokenMatch[] = [];
  const sorted = [...mentions].sort((a, b) => b.token.length - a.token.length);
  const consumed: Array<[number, number]> = [];
  const overlaps = (start: number, end: number) => consumed.some(([s, e]) => start < e && end > s);
  for (const mention of sorted) {
    const needle = `@${escapeRegExp(mention.token)}`;
    const regex = new RegExp(needle, 'g');
    let hit: RegExpExecArray | null;
    while ((hit = regex.exec(text)) !== null) {
      const start = hit.index;
      const end = start + hit[0].length;
      if (!overlaps(start, end)) {
        consumed.push([start, end]);
        matches.push({ mentionId: mention.id, start, end });
      }
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

/** 文本中仍然存在的 mention（文本被手动删改后，孤儿绑定随之失效）。 */
export function pruneMentions(text: string, mentions: ReadonlyArray<ImageMention>): ImageMention[] {
  const alive = new Set(findMentionTokens(text, mentions).map(match => match.mentionId));
  return mentions.filter(mention => alive.has(mention.id));
}

/**
 * 在光标处插入 mention token：替换触发中的 `@query` 片段为 `@token `（尾随空格），
 * 返回新文本与新光标。纯函数（组件负责 setState）。
 */
export function insertMentionToken(
  text: string,
  caret: number,
  image: Pick<VisionContextImage, 'label' | 'assetId' | 'path' | 'role'>,
  triggerStart: number,
): { text: string; caret: number; token: string } {
  const token = mentionTokenOf(image.label);
  const before = text.slice(0, Math.min(triggerStart, caret));
  const after = text.slice(Math.max(triggerStart, caret));
  const next = `${before}@${token} ${after}`;
  return { text: next, caret: before.length + token.length + 2, token };
}

/** 从文本移除某 mention 的首个 @token（引用 chip 的 ×）。 */
export function removeMentionToken(text: string, mention: ImageMention): string {
  const match = findMentionTokens(text, [mention])[0];
  if (!match) return text;
  let end = match.end;
  // 吞掉 token 后紧跟的一个空格，避免留下双空格
  if (text[end] === ' ') end += 1;
  return text.slice(0, match.start) + text.slice(end);
}

// ===== @ 触发检测（输入框弹层开关；纯视图，绝不触发语义修改） =====

export interface MentionTrigger {
  start: number;
  query: string;
}

/** query 内出现即视为 mention 已终止的字符（空白 / 第二个 @ / 中西文标点终止符）。 */
const MENTION_QUERY_TERMINATOR = /[\s@，。；、！？：,. ;:!?…—～~（）()【】\[\]「」『』“”‘’\n\r]/;

/**
 * 光标处是否处于待补全的 @query 片段：
 * 从光标向前找到最近一个 `@`，之间无空白 / 无第二个 @ / 无标点终止符。
 *
 * `@` 前一个字符的边界规则（中文无词间空格，前缀绝不能要求空白）：
 *  - 仅拉丁字母 / 数字（`abc@` / `123@`）视为邮箱 / 用户名片段，不触发；
 *  - CJK 汉字（`根据@` / `把@`）、空白、标点、行首全部正常触发。
 * query 限长 32。
 */
export function detectMentionTrigger(text: string, caret: number): MentionTrigger | null {
  const head = text.slice(0, caret);
  const at = head.lastIndexOf('@');
  if (at === -1) return null;
  const query = head.slice(at + 1);
  if (query.length > 32) return null;
  if (MENTION_QUERY_TERMINATOR.test(query)) return null;
  const prev = at === 0 ? '' : head[at - 1];
  if (/[A-Za-z0-9]/.test(prev)) return null;
  return { start: at, query };
}

// ===== 双图角色语义解析（模板图 / 替换人物） =====

export interface MentionRoleResolution {
  /** 模板 / 风格 / 构图参考（图二类）：未显式提及时间接回落主参考图。 */
  template?: { path: string; label: string; origin: 'mention' | 'source' };
  /** 人物替换来源（图三类）。 */
  person?: { path: string; label: string; assetId?: string; origin: 'panel' | 'mention' | 'pool' };
  /** explicit = 明确 @mention 绑定；inferred = 自然语言推断；none = 未识别。 */
  confidence: 'explicit' | 'inferred' | 'none';
}

/** 池内按 mention 绑定取上下文图片（mention 先绑定 assetId，其次路径）。 */
function resolvePoolImage(
  mention: ImageMention,
  pool: ReadonlyArray<VisionContextImage>,
): VisionContextImage | null {
  return pool.find(image => image.assetId && image.assetId === mention.assetId)
    ?? pool.find(image => normalizeImagePath(image.path) === normalizeImagePath(mention.path))
    ?? null;
}

/** 中文数字（一~十 / 两）与阿拉伯数字 → 序号（1 起）；无法解析返回 null。 */
function ordinalOf(text: string): number | null {
  const digits = text.match(/\d+/);
  if (digits) return parseInt(digits[0], 10);
  const cjk: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  for (const [char, value] of Object.entries(cjk)) {
    if (text.includes(char)) return value;
  }
  return null;
}

/** 序号 → 可能的数字写法（2 / 二 / 两），用于「图二.png」类文件名标签匹配。 */
function numeralsOf(ordinal: number): string[] {
  const cjk: Record<number, string[]> = {
    1: ['一'], 2: ['二', '两'], 3: ['三'], 4: ['四'], 5: ['五'],
    6: ['六'], 7: ['七'], 8: ['八'], 9: ['九'], 10: ['十'],
  };
  return [String(ordinal), ...(cjk[ordinal] ?? [])];
}

/** 替换动词短语（换成人/人物/主角/主体/她/他…）。 */
const REPLACE_VERB = /(?:换成|替换成|替换为|换上|变为|变成|更换为)/;
/** 「像 @图二 这样 / 参考 @图二 的风格」：比喻 / 参照关键字直接贴着 mention 前方 → 该 mention 是模板。 */
const LIKENESS_BEFORE = /(?:像|如同|照着|按照|参考|保留)\s*$/;

/**
 * 双图角色解析（优先级：面板显式选择 > 明确 Mention > 自然语言推断）。
 *
 * - 面板已设置人物 → person.origin='panel'（mention / 推断绝不覆盖它）；
 * - 两个不同 mention 挨着替换动词 → 动词后为 person、另一方为 template；
 * - 单 mention + 换人句式 → 该 mention 为 person，template 回落主参考图；
 * - 自然语言「图二/图3/第二张」序号 → 池内第 N 张；
 * - 换人意图存在而 person 只来自池 → origin='pool'（建议态，不直接落面板）。
 */
export function resolveImageMentionRoles(input: {
  freeText: string;
  mentions: ReadonlyArray<ImageMention>;
  pool: ReadonlyArray<VisionContextImage>;
}): MentionRoleResolution {
  const { freeText, pool } = input;
  const mentions = pruneMentions(freeText, input.mentions);
  const text = freeText.replace(/\s+/g, ' ');
  const poolPerson = pool.find(image => image.role === 'person_replacement_reference') ?? null;
  const poolSource = pool.find(image => image.role === 'source_reference') ?? null;

  const resolution: MentionRoleResolution = { confidence: 'none' };
  const setTemplateFromPool = () => {
    if (poolSource) resolution.template = { path: poolSource.path, label: poolSource.label, origin: 'source' };
  };

  // 1) 面板人物（最高优先级，绝不被 mention / 推断覆盖）
  if (poolPerson) {
    resolution.person = { path: poolPerson.path, label: poolPerson.label, assetId: poolPerson.assetId, origin: 'panel' };
    setTemplateFromPool();
  }

  // 2) 明确 Mention 绑定
  if (mentions.length >= 2) {
    const positioned = mentions
      .map(mention => ({ mention, index: text.indexOf(`@${mention.token}`) }))
      .filter(entry => entry.index >= 0);
    if (positioned.length >= 2) {
      const verbMatch = text.match(REPLACE_VERB);
      const verbIndex = verbMatch?.index ?? -1;
      let personMention: ImageMention | null = null;
      let templateMention: ImageMention | null = null;
      if (verbIndex >= 0) {
        // 「把 @A 的人物换成 @B」：替换动词之后的 mention 是人物来源，另一方是模板
        const after = positioned.filter(p => p.index > verbIndex).sort((a, b) => a.index - b.index)[0];
        const before = positioned.filter(p => p.index < verbIndex).sort((a, b) => b.index - a.index)[0];
        if (after && before) {
          personMention = after.mention;
          templateMention = before.mention;
        }
      } else {
        // 「让 @B 也生成成像 @A 这样」：贴着像/参考/保留关键字的 mention 是模板，另一方是人物
        for (const entry of positioned) {
          if (LIKENESS_BEFORE.test(text.slice(Math.max(0, entry.index - 6), entry.index))) {
            templateMention = entry.mention;
            personMention = positioned.find(p => p.mention.id !== entry.mention.id)?.mention ?? null;
            break;
          }
        }
      }
      if (!personMention || !templateMention) {
        // 无动词也无比喻句式：按池内角色判定（人物角色的 mention = person）
        personMention = mentions.find(m => m.role === 'person_replacement_reference') ?? null;
        templateMention = personMention
          ? mentions.find(m => m.id !== personMention!.id) ?? null
          : null;
      }
      if (personMention && templateMention && personMention.id !== templateMention.id) {
        resolution.person ??= {
          path: personMention.path,
          label: personMention.label,
          assetId: personMention.assetId,
          origin: 'mention',
        };
        const templateImage = resolvePoolImage(templateMention, pool);
        resolution.template = {
          path: templateImage?.path ?? templateMention.path,
          label: templateImage?.label ?? templateMention.label,
          origin: 'mention',
        };
        resolution.confidence = 'explicit';
        return resolution;
      }
    }
  }

  if (mentions.length === 1) {
    const mention = mentions[0];
    const wantsReplace = REPLACE_VERB.test(text);
    if (wantsReplace) {
      // 「把人物换成 @X」：@X 是人物来源；模板回落主参考图
      resolution.person ??= { path: mention.path, label: mention.label, assetId: mention.assetId, origin: 'mention' };
      const templateImage = resolvePoolImage(mention, pool);
      if (templateImage && templateImage.role !== 'person_replacement_reference') {
        resolution.template = { path: templateImage.path, label: templateImage.label, origin: 'mention' };
      } else {
        setTemplateFromPool();
      }
      resolution.confidence = 'explicit';
      return resolution;
    }
    // 单 mention 且绑定主参考图 → 模板意图（「照着 @原图 的风格…」）
    const templateImage = resolvePoolImage(mention, pool);
    if (templateImage && (templateImage.role === 'source_reference' || mention.role === 'template_reference')) {
      resolution.template = { path: templateImage.path, label: templateImage.label, origin: 'mention' };
      resolution.confidence = 'explicit';
    }
  }

  // 3) 自然语言推断（无 @mention）：换人句式 + 序号（图二/图3/第二张）
  if (resolution.confidence === 'none' && REPLACE_VERB.test(text)) {
    const ordinals = [...text.matchAll(/(?:图|第)\s*([0-9一二两三四五六七八九十]+)\s*张?/g)];
    /** 序号 → 池内图片：先按「图N」标签 / 文件名匹配（图二.png 类），再按池序号。 */
    const byOrdinal = (ordinal: number): VisionContextImage | null => {
      const numerals = numeralsOf(ordinal);
      const byName = pool.find(image => {
        const fileName = image.path.split(/[\\/]/).pop() ?? '';
        return numerals.some(numeral => image.label.includes(`图${numeral}`) || fileName.includes(`图${numeral}`));
      });
      if (byName) return byName;
      return pool[ordinal - 1] ?? null;
    };
    if (ordinals.length >= 2) {
      // 「把图二的人物换成图三」：替换动词后的序号是人物，另一个是模板
      const verbIndex = text.search(REPLACE_VERB);
      const after = ordinals.find(match => match.index! >= verbIndex);
      const before = ordinals.find(match => match.index! < verbIndex);
      const personImage = after ? byOrdinal(ordinalOf(after[1]) ?? 0) : null;
      const templateImage = before ? byOrdinal(ordinalOf(before[1]) ?? 0) : null;
      if (personImage && personImage.role !== 'source_reference') {
        resolution.person ??= { path: personImage.path, label: personImage.label, assetId: personImage.assetId, origin: 'pool' };
      } else if (poolPerson) {
        resolution.person ??= { path: poolPerson.path, label: poolPerson.label, assetId: poolPerson.assetId, origin: 'pool' };
      }
      if (templateImage) {
        resolution.template = { path: templateImage.path, label: templateImage.label, origin: 'source' };
      } else {
        setTemplateFromPool();
      }
    } else {
      // 「保留图二这种风格和构图，把里面的人换成图三」只有一个序号可对上池内人物
      if (poolPerson) {
        resolution.person ??= { path: poolPerson.path, label: poolPerson.label, assetId: poolPerson.assetId, origin: 'pool' };
      }
      setTemplateFromPool();
    }
    if (resolution.person || resolution.template) resolution.confidence = 'inferred';
  }

  return resolution;
}

/** resolution → 建议态签名（变化才重新弹「应用到人物替换」建议）。 */
export function mentionSuggestionSignature(resolution: MentionRoleResolution): string {
  return [resolution.template?.path ?? '', resolution.person?.path ?? '', resolution.confidence].join('|');
}
