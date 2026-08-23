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
  /** 自然语言修改要求（textarea，与快捷维度互不替代）。 */
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
}

export const EMPTY_MODIFICATION_DRAFT: ModificationDraft = {
  freeText: '',
  activeDimensions: [],
  person: null,
  clothingPolicy: 'preserve_original',
  customClothing: '',
  replicationBoost: false,
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

/** 维度 toggle：激活 → 唯一槽位；再次点击 → 删除该维度结构化意图（绝无重复）。 */
export function toggleModificationDimension(
  draft: ModificationDraft,
  key: ModificationDimension,
): ModificationDraft {
  const active: ModificationDimension[] = draft.activeDimensions.includes(key)
    ? draft.activeDimensions.filter(item => item !== key)
    : [...draft.activeDimensions, key];
  const next: ModificationDraft = { ...draft, activeDimensions: active };
  if (key === 'subject' && !active.includes('subject')) {
    // 取消「修改人物」= 整体移除人物替换（含仅因人物替换产生的服装自定义）
    return clearPersonReplacement(next);
  }
  return next;
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
 * 服装仅因人物替换产生时回到默认（沿用原图），不触碰其它维度与 freeText。
 */
export function clearPersonReplacement(draft: ModificationDraft): ModificationDraft {
  const clothingOnlyForPerson = draft.clothingPolicy === 'use_subject_reference'
    || (draft.clothingPolicy === 'custom' && !draft.activeDimensions.includes('clothing'));
  return {
    ...draft,
    person: null,
    activeDimensions: draft.activeDimensions.filter(item => item !== 'subject'),
    clothingPolicy: clothingOnlyForPerson ? 'preserve_original' : draft.clothingPolicy,
    customClothing: clothingOnlyForPerson ? '' : draft.customClothing,
  };
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
        ? '服装处理：使用人物参考图中的服装（服装 / 造型以人物参考图为准）'
        : '服装处理：使用人物描述中的服装';
    case 'custom': {
      const custom = customClothing.trim();
      return custom ? `服装处理：更换为指定服装——${custom}` : '服装处理：更换服装（未指定具体描述，由 AI 按整体意图自洽设计）';
    }
    case 'preserve_original':
    default:
      return '服装处理：严格保留原图服装（不采用人物参考图 / 描述中的服装）';
  }
}

/**
 * 合成优化器输入指令：freeText + 快捷维度 + 人物替换 + 服装策略 + 复刻强度。
 * 只有 freeText 时输出原文（与旧协议完全一致）；结构化部分逐行拼接，机器可读、人可校对。
 */
export function buildModificationInstruction(draft: ModificationDraft): string {
  const lines: string[] = [];
  const freeText = draft.freeText.trim();
  if (freeText) lines.push(freeText);

  const dims = draft.activeDimensions.filter(key => key !== 'subject' || !draft.person);
  if (dims.length > 0) {
    lines.push(`重点修改维度：${dims.map(key => DIMENSION_LABELS[key]).join('、')}`);
  }

  if (draft.person) {
    const description = describePerson(draft.person);
    const sourceText = draft.person.source === 'gallery'
      ? '图片库人物'
      : draft.person.source === 'local' ? '本地导入人物' : '文字描述人物';
    if (personHasImage(draft.person)) {
      lines.push(
        `人物替换：使用${sourceText}参考图${description ? `（${description}）` : ''}；`
        + '参考图仅用于身份、脸部、发型、体型等人物特征',
      );
    } else {
      lines.push(`人物替换：${description || '（未填写人物描述，由 AI 按整体意图自洽设计）'}`);
    }
    lines.push(clothingPolicyInstruction(draft.clothingPolicy, draft.customClothing, personHasImage(draft.person)));
  } else if (draft.activeDimensions.includes('clothing')) {
    // 单独修改服装（无人物替换）：策略同样显式化
    lines.push(clothingPolicyInstruction(draft.clothingPolicy, draft.customClothing, false));
  }

  if (draft.replicationBoost) {
    lines.push('复刻强度：更贴近原图，提高复刻度（未提及的视觉结构从严保持）');
  }

  return lines.join('\n');
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
  return {
    freeText,
    activeDimensions: person && !uniqueDimensions.includes('subject')
      ? [...uniqueDimensions, 'subject']
      : uniqueDimensions,
    person,
    clothingPolicy: person || uniqueDimensions.includes('clothing') ? policy : 'preserve_original',
    customClothing: typeof raw.customClothing === 'string' ? raw.customClothing : '',
    replicationBoost: raw.replicationBoost === true,
  };
}
