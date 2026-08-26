/**
 * 结构化修改意图（V4.1 Modification Dimension Selector）。
 *
 * 快捷按钮（修改人物 / 动作 / 背景 / 镜头 / 风格 / 服装）不是往 textarea 追加文本，
 * 而是结构化选择器：每个维度在 draft.activeDimensions 中最多存在一次（唯一槽位），
 * 不同维度可同时激活；再次点击同一维度 = 取消并删除该维度的结构化意图。
 * 修改人物维度额外打开 Person Replacement Panel（图库 / 本地 / 文字 + 服装策略）。
 *
 * 自由文本（freeText）与快捷维度共存：两者合并为一条合成指令交给 Prompt 优化器，
 * AI Intent Recognition 仍然独立工作（freeText 中提到的维度由优化器判定）。
 */

import { IMAGE_MENTION_ROLE_LABELS, pruneMentions, type ImageMention } from './imageMention';

/** 快捷修改维度（映射到复刻方案维度 key；与 RecreationFieldKey 同名子集）。 */
export type ModificationDimension = 'subject' | 'clothing' | 'pose' | 'scene' | 'camera' | 'style';

/** 人物参考图的服装处理策略（严格单选）。 */
export type ClothingPolicy = 'preserve_original' | 'use_subject_reference' | 'custom';

/** 人物替换来源。 */
export type PersonSource = 'gallery' | 'local' | 'description';

export interface PersonReplacement {
  source: PersonSource;
  /** 图片库来源的素材 id。 */
  assetId?: string;
  /** 本地 / 图库文件路径（缩略图按路径本地重读，绝不持久化 base64）。 */
  path?: string;
  /** 展示名（文件名 / 素材名 / 描述摘要）。 */
  label?: string;
  /** 文字描述人物（source === 'description' 时生效）。 */
  description?: string;
}

export interface ModificationDraft {
  /** 自然语言修改要求（textarea，与快捷维度互不替代；@token 是其中的普通文本）。 */
  freeText: string;
  /** 激活的快捷维度（唯一槽位：同一维度最多一个，toggle 切换）。 */
  activeDimensions: ModificationDimension[];
  /** 人物替换（结构化；「修改人物」维度的强表达）。 */
  person: PersonReplacement | null;
  /** 服装处理策略（默认沿用原图服装）。 */
  clothingPolicy: ClothingPolicy;
  /** 自定义服装描述（clothingPolicy === 'custom' 时生效）。 */
  customClothing: string;
  /** 「提高复刻度」：不是视觉维度，是独立的复刻强度偏好。 */
  replicationBoost: boolean;
  /** @图片引用绑定（token 在 freeText，此处为真实图片侧车表；孤儿绑定随文本清理）。 */
  mentions: ImageMention[];
  /** 用户从图库加入当前任务的附加参考图（@ 弹层「从图片库选择」落这里）。 */
  extraImageRefs: Array<{ assetId?: string; path: string; label?: string }>;
}

export const EMPTY_MODIFICATION_DRAFT: ModificationDraft = {
  freeText: '',
  activeDimensions: [],
  person: null,
  clothingPolicy: 'preserve_original',
  customClothing: '',
  replicationBoost: false,
  mentions: [],
  extraImageRefs: [],
};

/** 快捷 Chip 定义（顺序 = 展示顺序；label 遵循 copy.md 术语表）。 */
export const MODIFICATION_CHIP_DEFS: ReadonlyArray<{ key: ModificationDimension; label: string }> = [
  { key: 'subject', label: '修改人物' },
  { key: 'pose', label: '修改动作' },
  { key: 'scene', label: '修改背景' },
  { key: 'camera', label: '修改镜头' },
  { key: 'style', label: '修改风格' },
  { key: 'clothing', label: '修改服装' },
];

/** 「提高复刻度」独立 Chip（preservation strength，不占用维度槽位）。 */
export const REPLICATION_BOOST_LABEL = '提高复刻度';

const DIMENSION_LABELS: Record<ModificationDimension, string> = {
  subject: '人物',
  clothing: '服装',
  pose: '动作',
  scene: '背景',
  camera: '镜头',
  style: '风格',
};

/** 维度中文标签（History「本次修改方案」等展示层共用，禁止各处另写一份）。 */
export const MODIFICATION_DIMENSION_LABELS = DIMENSION_LABELS;

/** 单个修改维度展示名（页面使用，避免复制映射表）。 */
export function modificationDimensionLabel(key: ModificationDimension): string {
  return DIMENSION_LABELS[key];
}

/**
 * 服装策略状态不变量（V4.0.9 状态模型修复）：
 *
 *   clothing ∈ activeDimensions ⇔ clothingPolicy ≠ 'preserve_original'
 *
 * 「修改服装」与「严格保留原图（画面模板）服装」是语义矛盾，任何有效状态都不得同时成立：
 *  - 选中「原图服装」→ clothing 维度必须 OFF（「修改服装」Chip 自动取消高亮）；
 *  - 选中「人物服装」/「自定义服装」→ clothing 维度必须 ON；
 *  - 点击「修改服装」Chip → 策略自动从 preserve_original 切换
 *    （有人物参考图 → use_subject_reference；否则 custom，等用户补描述）；
 *  - use_subject_reference 仅在人物携带参考图时可达（无图降级 custom）。
 *
 * 所有写入路径（toggle / setClothingPolicy / clearPersonReplacement / 持久化恢复 /
 * store setter）最终都经过 normalizeModificationState，绝不把矛盾态留给 Prompt 编译器。
 */
export function normalizeModificationState(draft: ModificationDraft): ModificationDraft {
  const participates = draft.person !== null || draft.activeDimensions.includes('clothing');
  if (!participates) {
    // 服装策略不参与语义（无人物且未启用服装维度）：回落默认，清掉残留描述
    return draft.clothingPolicy === 'preserve_original' && !draft.customClothing
      ? draft
      : { ...draft, clothingPolicy: 'preserve_original', customClothing: '' };
  }
  const policy: ClothingPolicy = draft.clothingPolicy === 'use_subject_reference' && !personHasImage(draft.person)
    ? 'custom'
    : draft.clothingPolicy;
  if (policy === 'preserve_original') {
    // 保留原图服装 ⇒ 绝不允许「修改服装」同时激活
    return draft.activeDimensions.includes('clothing')
      ? { ...draft, activeDimensions: draft.activeDimensions.filter(key => key !== 'clothing') }
      : draft;
  }
  // 人物服装 / 自定义服装 ⇒ 服装必然处于修改态
  if (!draft.activeDimensions.includes('clothing')) {
    return { ...draft, clothingPolicy: policy, activeDimensions: [...draft.activeDimensions, 'clothing'] };
  }
  return policy === draft.clothingPolicy ? draft : { ...draft, clothingPolicy: policy };
}

/**
 * 自定义服装空描述守卫：clothingPolicy='custom'（参与语义）但未填写描述时，
 * 优化 / 生成入口必须拦截并提示（禁止「伪造自定义内容」交给 AI 自由发挥）。
 */
export function clothingReadinessError(draft: ModificationDraft): string | null {
  if (draft.clothingPolicy !== 'custom') return null;
  return draft.customClothing.trim() ? null : '请描述新的服装 / 造型。';
}

/** 维度 toggle：激活 → 唯一槽位；再次点击 → 删除该维度结构化意图（绝无重复）。 */
export function toggleModificationDimension(
  draft: ModificationDraft,
  key: ModificationDimension,
): ModificationDraft {
  const activating = !draft.activeDimensions.includes(key);
  const active: ModificationDimension[] = activating
    ? [...draft.activeDimensions, key]
    : draft.activeDimensions.filter(item => item !== key);
  let next: ModificationDraft = { ...draft, activeDimensions: active };
  if (key === 'subject' && !active.includes('subject')) {
    // 取消「修改人物」= 整体移除人物替换（含仅因人物替换产生的服装自定义）
    return clearPersonReplacement(next);
  }
  if (key === 'clothing') {
    if (activating && draft.clothingPolicy === 'preserve_original') {
      // 点击「修改服装」而服装仍是「原图服装」= 状态矛盾：按推荐规则自动切换来源
      // （有人物参考图 → 人物服装；否则自定义，等用户补描述）
      next = { ...next, clothingPolicy: personHasImage(draft.person) ? 'use_subject_reference' : 'custom' };
    } else if (!activating) {
      // 取消「修改服装」= 回到「沿用原图服装」（biconditional 不变量的另一半）
      next = { ...next, clothingPolicy: 'preserve_original', customClothing: '' };
    }
  }
  return normalizeModificationState(next);
}

/**
 * 服装策略切换（radiogroup 唯一写入口）：
 *  - 「原图服装」→ clothing 维度 OFF（修改服装 Chip 自动取消）；
 *  - 「人物服装」/「自定义」→ clothing 维度 ON（修改服装自动启用）。
 */
export function setClothingPolicy(draft: ModificationDraft, policy: ClothingPolicy): ModificationDraft {
  if (policy === 'preserve_original') {
    return normalizeModificationState({
      ...draft,
      clothingPolicy: policy,
      activeDimensions: draft.activeDimensions.filter(key => key !== 'clothing'),
      customClothing: '',
    });
  }
  return normalizeModificationState({
    ...draft,
    clothingPolicy: policy,
    activeDimensions: draft.activeDimensions.includes('clothing')
      ? draft.activeDimensions
      : [...draft.activeDimensions, 'clothing'],
  });
}

/** 「提高复刻度」toggle（独立于维度体系）。 */
export function toggleReplicationBoost(draft: ModificationDraft): ModificationDraft {
  return { ...draft, replicationBoost: !draft.replicationBoost };
}

/** 设置人物替换（图库 / 本地 / 文字描述）；自动激活 subject 维度。 */
export function setPersonReplacement(
  draft: ModificationDraft,
  person: PersonReplacement | null,
): ModificationDraft {
  if (!person) return clearPersonReplacement(draft);
  const activeDimensions: ModificationDimension[] = draft.activeDimensions.includes('subject')
    ? draft.activeDimensions
    : [...draft.activeDimensions, 'subject'];
  return { ...draft, person, activeDimensions };
}

/**
 * 「移除人物替换」：删除人物参考资产与 subject 结构化意图；
 * 服装仅在「因人物产生」时回到默认（沿用原图）——用户显式启用过「修改服装」维度
 * 则保留修改态（策略降级 custom，由用户补描述），不触碰其它维度与 freeText。
 */
export function clearPersonReplacement(draft: ModificationDraft): ModificationDraft {
  const clothingExplicit = draft.activeDimensions.includes('clothing');
  return normalizeModificationState({
    ...draft,
    person: null,
    activeDimensions: draft.activeDimensions.filter(item => item !== 'subject'),
    clothingPolicy: clothingExplicit ? 'custom' : 'preserve_original',
    customClothing: clothingExplicit ? draft.customClothing : '',
  });
}

/** 是否存在结构化修改意图（维度 / 人物 / 自定义服装 / 复刻强度任一）。 */
export function hasStructuredIntent(draft: ModificationDraft): boolean {
  return draft.activeDimensions.length > 0
    || draft.person !== null
    || (draft.clothingPolicy === 'custom' && !!draft.customClothing.trim())
    || draft.replicationBoost;
}

/** 合成修改意图是否为空（freeText 与结构化意图全部为空）。 */
export function isModificationDraftEmpty(draft: ModificationDraft): boolean {
  return !draft.freeText.trim() && !hasStructuredIntent(draft);
}

/** 人物替换描述（文字描述或参考图标签）。 */
export function describePerson(person: PersonReplacement): string {
  if (person.source === 'description') return person.description?.trim() || '';
  return person.label?.trim() || person.path?.split(/[\\/]/).pop() || '参考人物';
}

/** 人物参考是否携带图片（图库 / 本地）。 */
export function personHasImage(person: PersonReplacement | null): boolean {
  return !!person && person.source !== 'description' && !!person.path?.trim();
}

/** 服装策略 → 优化器指令文本（保留 / 替换必须显式，禁止一句「换这个人」）。 */
export function clothingPolicyInstruction(
  policy: ClothingPolicy,
  customClothing: string,
  personHasReference: boolean,
): string {
  switch (policy) {
    case 'use_subject_reference':
      return personHasReference
        ? '服装处理：使用人物参考图中的服装（服装 / 造型 / 穿搭整体以人物参考图为准；不仅替换脸部，还必须继承该人物的服装与造型特征，并在最终 Prompt 中显式写出服装描述）'
        : '服装处理：使用人物描述中的服装';
    case 'custom': {
      const custom = customClothing.trim();
      return custom ? `服装处理：更换为指定服装——${custom}` : '服装处理：更换服装（未指定具体描述，由 AI 按整体意图自洽设计）';
    }
    case 'preserve_original':
    default:
      return '服装处理：严格保留原图（画面模板）服装（不采用人物参考图 / 描述中的服装）；'
        + '「保留服装」仅限于服装本身——绝不代表保留原图人物，人物身份、面部、发型仍必须来自人物参考图（保留服装 ≠ 保留人物）';
  }
}

/**
 * 逐维度 must-change 指令（V4.1：启用 = 必须真实修改，不是「可选」）。
 * 用户点了「修改动作 / 修改背景 / …」Chip 后，对应维度在优化器输入里必须拿到
 * 明确的修改语义——即使用户没写具体值，也绝不退化成「保持原样」。
 */
export function dimensionDirectiveInstruction(key: ModificationDimension): string | null {
  switch (key) {
    case 'pose':
      return '动作修改（已启用）：原图动作不再保留——必须生成与原图明确不同的新动作；'
        + '用户未指定具体动作时，由 AI 设计自然合理的新姿势（手势、头部角度、身体朝向、手臂位置、视线方向至少一项发生明显变化），'
        + '并在最终 Prompt 中显式写出新动作描述，禁止沿用原图姿势';
    case 'scene':
      return '背景修改（已启用）：背景内容不再照搬原图——背景中的动漫人物、屏幕内容与画面元素应随整体修改同步调整为新的内容；'
        + '保持原图整体画面风格与动漫氛围（如动漫AI照片风效果）不变，但背景内容本身必须有明确变化';
    case 'camera':
      return '镜头修改（已启用）：镜头语言（景别 / 角度 / 视角 / 景深）按整体意图调整为新的镜头表达，与画面自洽';
    case 'style':
      return '风格修改（已启用）：画面风格按整体意图调整为新的风格表达，与人物、场景自洽';
    case 'clothing':
      return '服装修改（已启用）：服装 / 造型必须真实修改并列入 changed_dimensions；'
        + '来源按「服装处理」指令执行（人物参考图服装 / 自定义描述），绝不沿用原图服装';
    case 'subject':
      return null; // subject 由人物替换块表达（setPersonReplacement 强制激活）
    default:
      return null;
  }
}

/**
 * 双图角色上下文（V4.0.9）：人物替换工作流的「图二模板 + 图三人」显式语义。
 * 由页面从 resolveImageMentionRoles 解析后传入；缺省时指令保持旧协议（完全兼容）。
 */
export interface ModificationInstructionContext {
  /** 画面模板（图二类；通常 = 当前主参考图）。 */
  template?: { label: string };
  /** 人物替换来源经 @mention 绑定（面板为空、仅文本 @引用时的补充语义）。 */
  personMention?: { label: string };
}

/**
 * 合成优化器输入指令：freeText + 快捷维度 + 人物替换 + 双图角色 + 服装策略 + 复刻强度。
 * 只有 freeText 时输出原文（与旧协议完全一致）；结构化部分逐行拼接，机器可读、人可校对。
 */
export function buildModificationInstruction(
  draft: ModificationDraft,
  context?: ModificationInstructionContext,
): string {
  const lines: string[] = [];
  const freeText = draft.freeText.trim();
  if (freeText) lines.push(freeText);

  // @图片引用绑定行：优化器据此对齐 @token 与真实图片的对应关系（multimodal 图片按同序附上）
  const activeMentions = pruneMentions(freeText, draft.mentions);
  if (activeMentions.length > 0) {
    const binding = activeMentions
      .map(m => `@${m.token}=随消息附上的对应图片（${m.label}）`)
      .join('；');
    lines.push(`图片引用：${binding}`);
  }

  const dims = draft.activeDimensions.filter(key => key !== 'subject' || !draft.person);
  if (dims.length > 0) {
    lines.push(`重点修改维度：${dims.map(key => DIMENSION_LABELS[key]).join('、')}`);
  }

  // 逐维度 must-change 指令：启用 = 必须真实修改（V4.1 修「点了维度却没生效」）
  for (const key of draft.activeDimensions) {
    const directive = dimensionDirectiveInstruction(key);
    if (directive) lines.push(directive);
  }
  if (!draft.person && !context?.personMention && draft.activeDimensions.includes('subject')) {
    // 纯文本主体修改（未设置人物参考）：subject 也要 must-change 语义
    lines.push('人物修改（已启用）：主体人物按调整要求修改（未设置人物参考图，以文字意图为准）');
  }

  /** 人物替换之外还启用了哪些维度（决定模板行「其余沿用」的口径）。 */
  const otherModifiedLabels = draft.activeDimensions
    .filter(key => key !== 'subject')
    .map(key => DIMENSION_LABELS[key]);

  if (draft.person || context?.personMention) {
    const personLabel = draft.person
      ? describePerson(draft.person)
      : context!.personMention!.label;
    if (draft.person) {
      const sourceText = draft.person.source === 'gallery'
        ? '图片库人物'
        : draft.person.source === 'local' ? '本地导入人物' : '文字描述人物';
      if (personHasImage(draft.person)) {
        lines.push(
          `人物替换（强制条件）：使用${sourceText}参考图${personLabel ? `（${personLabel}）` : ''}；`
          + '主体人物必须整体替换为该参考图中的人物——身份、脸部五官、脸型、发型发色、体型与整体外貌气质一律以人物参考图为准；'
          + '不得保留原图（画面模板）原人物的脸部身份或面部特征；模板图仅用于画面布局、风格、背景与整体视觉参考',
        );
      } else {
        lines.push(`人物替换：${personLabel || '（未填写人物描述，由 AI 按整体意图自洽设计）'}`);
      }
    } else {
      // 面板为空但文本 @引用了人物图：显式写出人物来源语义（不与面板冲突）
      lines.push(`人物替换：人物来源=@${context!.personMention!.label}（随消息附上的图片）；仅用于身份、脸部、发型、体型等人物特征`);
    }
    if (context?.template) {
      lines.push(
        `画面模板：以「${context.template.label}」为画面模板——`
        + (otherModifiedLabels.length > 0
          ? `延续其画风、视觉氛围与整体画面气质；已启用的修改维度（${otherModifiedLabels.join('、')}）按各自修改指令执行，其余视觉结构尽量沿用模板图`
          : '延续其画风、视觉氛围、构图与背景关系；仅替换主体人物，其余视觉结构尽量沿用模板图'),
      );
    }
    lines.push(clothingPolicyInstruction(draft.clothingPolicy, draft.customClothing, personHasImage(draft.person) || !!context?.personMention));
  } else if (draft.activeDimensions.includes('clothing')) {
    // 单独修改服装（无人物替换）：策略同样显式化
    lines.push(clothingPolicyInstruction(draft.clothingPolicy, draft.customClothing, false));
  }

  if (draft.replicationBoost) {
    lines.push('复刻强度：更贴近原图，提高复刻度（仅指未开放修改的构图 / 风格 / 氛围等画面维度从严保持；'
      + (draft.person ? '不作用于人物身份——人物替换不受复刻强度影响' : '不作用于人物身份维度') + '）');
  }

  return lines.join('\n');
}

/** 持久化 mentions 合法化：字段形状校验 + id/path 去重（token 可由 label 重建）。 */
function migrateMentions(raw: unknown): ImageMention[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const mentions: ImageMention[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path.trim() : '';
    if (!path) continue;
    const dedupeKey = typeof record.assetId === 'string' && record.assetId ? record.assetId : path;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const label = typeof record.label === 'string' && record.label.trim() ? record.label.trim() : path.split(/[\\/]/).pop()!;
    mentions.push({
      id: typeof record.id === 'string' && record.id ? record.id : crypto.randomUUID(),
      assetId: typeof record.assetId === 'string' ? record.assetId : undefined,
      path,
      label,
      token: typeof record.token === 'string' && record.token ? record.token : label.replace(/\s+/g, ''),
      role: typeof record.role === 'string' && record.role in IMAGE_MENTION_ROLE_LABELS
        ? record.role as ImageMention['role']
        : 'generic_reference',
    });
  }
  return mentions;
}

/** 持久化 extraImageRefs 合法化（path 必填，去重）。 */
function migrateExtraImageRefs(raw: unknown): Array<{ assetId?: string; path: string; label?: string }> {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const refs: Array<{ assetId?: string; path: string; label?: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path.trim() : '';
    if (!path || seen.has(path)) continue;
    seen.add(path);
    refs.push({
      assetId: typeof record.assetId === 'string' ? record.assetId : undefined,
      path,
      label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : undefined,
    });
  }
  return refs;
}

/** 旧持久化数据（仅 freeText）迁移：adjustmentInput → draft.freeText。 */
export function migrateModificationDraft(
  raw: Partial<ModificationDraft> | undefined,
  legacyFreeText?: string,
): ModificationDraft {
  if (!raw || typeof raw !== 'object') {
    return { ...EMPTY_MODIFICATION_DRAFT, freeText: legacyFreeText?.trim() ? legacyFreeText : '' };
  }
  const activeDimensions = Array.isArray(raw.activeDimensions)
    ? raw.activeDimensions.filter(
        (item): item is ModificationDimension => typeof item === 'string' && item in DIMENSION_LABELS,
      )
    : [];
  // 去重（同一维度唯一槽位的持久化保证）
  const uniqueDimensions: ModificationDimension[] = [];
  for (const key of activeDimensions) {
    if (!uniqueDimensions.includes(key)) uniqueDimensions.push(key);
  }
  const policy: ClothingPolicy = raw.clothingPolicy === 'use_subject_reference' || raw.clothingPolicy === 'custom'
    ? raw.clothingPolicy
    : 'preserve_original';
  const freeText = typeof raw.freeText === 'string'
    ? raw.freeText
    : legacyFreeText?.trim() ? legacyFreeText : '';
  const person = raw.person && typeof raw.person === 'object' && ['gallery', 'local', 'description'].includes(raw.person.source)
    ? {
        source: raw.person.source,
        assetId: typeof raw.person.assetId === 'string' ? raw.person.assetId : undefined,
        path: typeof raw.person.path === 'string' ? raw.person.path : undefined,
        label: typeof raw.person.label === 'string' ? raw.person.label : undefined,
        description: typeof raw.person.description === 'string' ? raw.person.description : undefined,
      }
    : null;
  return normalizeModificationState({
    freeText,
    activeDimensions: person && !uniqueDimensions.includes('subject')
      ? [...uniqueDimensions, 'subject']
      : uniqueDimensions,
    person,
    clothingPolicy: person || uniqueDimensions.includes('clothing') ? policy : 'preserve_original',
    customClothing: typeof raw.customClothing === 'string' ? raw.customClothing : '',
    replicationBoost: raw.replicationBoost === true,
    mentions: migrateMentions(raw.mentions),
    extraImageRefs: migrateExtraImageRefs(raw.extraImageRefs),
  });
}
