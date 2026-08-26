/**
 * Generation Provenance（V4.0.9 生成溯源快照）——「确认生成图片」时冻结的真实执行上下文。
 *
 * 三层 Provenance 严禁混淆（铁律）：
 *  1. userInstruction    = 用户真正输入的自然语言要求（@token 展示层解析为 @label）；
 *  2. modificationIntent = 结构化修改方案（维度 / 人物替换 / 服装策略）；
 *  3. finalPrompt        = 真正提交给图片生成 API 的最终 Prompt（Task.final_prompt，本模块不复制）。
 *
 * 历史详情只读这份快照；禁止用 optimizedPrompt / final_prompt 伪造「用户要求」，
 * 禁止读取当前 Settings 回填模型记录（必须来自生成时快照）。
 */

import type { GenerationImageReference, GenerationProvenanceSnapshot } from '../../types';
import {
  MODIFICATION_DIMENSION_LABELS,
  personHasImage,
  type ModificationDimension,
  type ModificationDraft,
} from './modificationIntent';
import { findMentionTokens, normalizeImagePath, pruneMentions } from './imageMention';
import type { RecreationState } from './recreationPlan';

/** 快照输入中的模型信息（页面在生成时刻解析后传入；不在此读任何 Settings）。 */
export interface ProvenanceModelInfo {
  modelId?: string;
  displayName?: string;
  providerName?: string;
  source?: string;
}

export interface GenerationProvenanceInput {
  draft: ModificationDraft;
  recreation: RecreationState;
  /** 视觉理解工作区主参考图（画面模板）。 */
  sourcePath?: string;
  sourceAssetId?: string;
  /** 双图角色解析出的模板展示名（缺省「原图」）。 */
  templateLabel?: string;
  /** @mention 解析出的人物来源（面板为空时的补充；有 path 才生效）。 */
  personMention?: { path: string; assetId?: string; label?: string };
  /** 生成参考图（顺序 = 提交顺序；缺省按 draft/source/mention 推导）。 */
  imageReferences?: ReadonlyArray<GenerationImageReference>;
  visionModel?: ProvenanceModelInfo;
  optimizerModel?: ProvenanceModelInfo;
  evaluationModel?: ProvenanceModelInfo;
  /** V4.1 Visual Project 上下文（项目化链路冻结 projectId / 修订 / 区域 / 媒介合同）。 */
  project?: {
    id: string;
    name: string;
    revision: number;
    personContract?: {
      strength: 'natural' | 'balanced' | 'strict';
      replaceScope: 'whole_person' | 'face' | 'upper_body' | 'custom_region';
      targetRegionId?: string;
      applyIdentityTo: 'primary_subject_only' | 'all_corresponding_subjects';
      preserveTemplateIdentity: false;
    };
    regions?: ReadonlyArray<RegionSnapshotInput>;
    renderingContract?: GenerationProvenanceSnapshot['renderingContract'];
    /** Canonical Anime Character（混合媒介动漫主体存在时由调用方派生冻结）。 */
    animeCharacterSnapshot?: GenerationProvenanceSnapshot['animeCharacterSnapshot'];
    /** 动漫插图绑定（编译时刻 bindDetailInsertsToCharacter 的产物）。 */
    detailInsertBindings?: GenerationProvenanceSnapshot['detailInsertBindings'];
  };
}

/** 区域快照输入（VisualProject.regions → 溯源冻结的形状；personReferenceLabel 由调用侧从 references 解析）。 */
export interface RegionSnapshotInput {
  id: string;
  name: string;
  replaceType: 'person' | 'background' | 'object' | 'custom';
  constraintStrength: 'natural' | 'balanced' | 'strict';
  replaceScope?: 'face' | 'upper_body' | 'whole_person';
  personReferenceLabel?: string;
  prompt?: string;
  enabled: boolean;
  maskPath?: string;
  shape:
    | { kind: 'rect'; x: number; y: number; w: number; h: number }
    | { kind: 'brush'; strokes: ReadonlyArray<unknown>; naturalWidth: number; naturalHeight: number };
}

/** @token → @label 的人类可读版（底层原文与绑定表另行保留用于追踪）。 */
export function renderUserInstruction(freeText: string, mentions: ModificationDraft['mentions']): string {
  const text = freeText.trim();
  if (!text) return '';
  const matches = findMentionTokens(text, mentions);
  if (matches.length === 0) return text;
  let result = '';
  let cursor = 0;
  for (const match of matches) {
    const mention = mentions.find(item => item.id === match.mentionId);
    if (!mention) continue;
    result += text.slice(cursor, match.start) + `@${mention.label}`;
    cursor = match.end;
  }
  result += text.slice(cursor);
  return result;
}

/** 快照参考图角色（types 侧 union 的本地别名）。 */
type ProvenanceImageRole = NonNullable<GenerationProvenanceSnapshot['imageRoles']>[number]['role'];

/** mention 角色 → 快照参考图角色（生成结果引用不作为生成输入，直接排除）。 */
function snapshotRoleOf(role: string): ProvenanceImageRole | null {
  switch (role) {
    case 'template_reference':
    case 'source_reference':
      return 'template';
    case 'person_replacement_reference':
      return 'person_reference';
    case 'background_reference':
      return 'background_reference';
    case 'style_reference':
      return 'style_reference';
    case 'generic_reference':
      return 'generic_reference';
    default:
      return null; // generated_result_reference 等不进入生成参考图
  }
}

/**
 * 生成参考图唯一解析器（V4.0.9.1）：产出「顺序 = 最终提交顺序」的角色清单。
 *
 * 顺序与优先级：template（工作区主参考图）→ person（面板人物图，缺省回落
 * @mention 人物）→ 其余活跃 @mention（模板 / 人物已占位的路径除外）。
 * 按归一化路径去重（模板与人物路径不同 ⇒ 两张都必须存活，绝不因同任务/同目录误删）。
 * 该清单同时喂给溯源快照（imageRoles）与生成 carry（i2i 参考图），两侧永不失配。
 */
export function resolveGenerationImageReferences(input: {
  draft: ModificationDraft;
  sourcePath?: string;
  sourceAssetId?: string;
  templateLabel?: string;
  personMention?: { path: string; assetId?: string; label?: string };
}): GenerationImageReference[] {
  const { draft } = input;
  const refs: GenerationImageReference[] = [];
  const seen = new Set<string>();
  const push = (ref: GenerationImageReference) => {
    const key = normalizeImagePath(ref.path);
    if (!key || seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  if (input.sourcePath?.trim()) {
    push({
      assetId: input.sourceAssetId,
      path: input.sourcePath,
      label: input.templateLabel?.trim() || '原图',
      role: 'template',
    });
  }
  const panelPerson = personHasImage(draft.person) ? draft.person : undefined;
  const personRef = panelPerson
    ? {
      assetId: panelPerson.assetId,
      path: panelPerson.path!,
      label: panelPerson.label?.trim() || '人物参考',
    }
    : input.personMention?.path?.trim()
      ? {
        assetId: input.personMention.assetId,
        path: input.personMention.path,
        label: input.personMention.label?.trim() || '人物参考',
      }
      : undefined;
  if (personRef) push({ ...personRef, role: 'person_reference' });

  const freeText = draft.freeText.trim();
  for (const mention of pruneMentions(freeText, draft.mentions)) {
    const role = snapshotRoleOf(mention.role);
    if (!role || role === 'person_reference') continue; // 人物位已占（或由面板/mention 统一提供）
    push({ assetId: mention.assetId, path: mention.path, label: mention.label, role });
  }
  return refs;
}

/** 最近一次成功优化中 AI 判定修改的维度（lockSource=intent 且未锁定；未优化为空）。 */
function changedDimensionsOf(recreation: RecreationState): string[] {
  return recreation.plan.fields
    .filter(field => field.lockSource === 'intent' && !field.locked)
    .map(field => field.key);
}

/** 生成溯源快照唯一构建入口（「确认生成图片」时刻调用，随 Task 冻结落库）。 */
export function buildGenerationProvenance(input: GenerationProvenanceInput): GenerationProvenanceSnapshot {
  const { draft, recreation } = input;
  const freeText = draft.freeText.trim();
  const activeMentions = pruneMentions(freeText, draft.mentions);

  // 参考图角色：优先用调用方传入的角色清单（与生成 carry 同源、同序）；
  // 缺省按 draft / sourcePath / personMention 推导（兼容旧调用方）。
  const imageRoles: NonNullable<GenerationProvenanceSnapshot['imageRoles']> = input.imageReferences
    ? input.imageReferences.filter(ref => ref.path?.trim()).map(ref => ({ ...ref }))
    : resolveGenerationImageReferences(input);

  const snapshot: GenerationProvenanceSnapshot = {
    schemaVersion: 1,
    feature: 'vision_recreation',
    models: {
      visionAnalysis: input.visionModel,
      promptOptimizer: input.optimizerModel,
      imageGeneration: { modelId: 'gpt-image-2', displayName: 'gpt-image-2' },
      imageEvaluation: input.evaluationModel,
    },
  };

  if (freeText) {
    snapshot.userInstruction = renderUserInstruction(freeText, draft.mentions);
    snapshot.userInstructionRaw = freeText;
  }
  if (activeMentions.length > 0) {
    snapshot.mentionBindings = activeMentions.map(mention => ({
      token: mention.token,
      label: mention.label,
      path: mention.path,
      assetId: mention.assetId,
    }));
  }
  if (imageRoles.length > 0) snapshot.imageRoles = imageRoles;

  const changed = changedDimensionsOf(recreation);
  // 人物替换快照：面板人物优先；面板为空但 @mention 提供了人物图 → 同样按强替换冻结
  const panelPersonHasImage = personHasImage(draft.person);
  const mentionPersonPath = !draft.person && input.personMention?.path?.trim() ? input.personMention.path : undefined;
  const personReplacement = draft.person || mentionPersonPath
    ? {
        enabled: true,
        ...(draft.person ? { source: draft.person.source } : {}),
        label: draft.person
          ? panelPersonHasImage
            ? draft.person.label?.trim() || draft.person.path?.split(/[\\/]/).pop()
            : draft.person.description?.trim().slice(0, 40)
          : input.personMention?.label?.trim() || '人物参考',
        hasReferenceImage: panelPersonHasImage || !!mentionPersonPath,
        replacementMode: (panelPersonHasImage || mentionPersonPath
          ? 'strict_identity_replace'
          : 'description_replace') as 'strict_identity_replace' | 'description_replace',
        ...(panelPersonHasImage
          ? {
              personReferencePath: draft.person!.path,
              ...(draft.person!.assetId ? { personReferenceAssetId: draft.person!.assetId } : {}),
            }
          : mentionPersonPath
            ? {
                personReferencePath: mentionPersonPath,
                ...(input.personMention?.assetId ? { personReferenceAssetId: input.personMention.assetId } : {}),
              }
            : {}),
      }
    : undefined;
  snapshot.modificationIntent = {
    activeDimensions: [...draft.activeDimensions],
    ...(changed.length > 0 ? { changedDimensions: changed } : {}),
    ...(personReplacement ? { personReplacement } : {}),
    clothingPolicy: draft.clothingPolicy,
    ...(draft.customClothing.trim() ? { customClothing: draft.customClothing.trim() } : {}),
    ...(draft.replicationBoost ? { replicationBoost: true } : {}),
  };

  // V4.1 项目化冻结：projectId / 修订 / 人物合同 V2 / 区域 / 媒介结构
  // （§20：生成瞬间冻结，之后项目演进不影响本快照；非项目链路缺省不伪造）
  const project = input.project;
  if (project) {
    snapshot.projectId = project.id;
    snapshot.projectName = project.name;
    snapshot.projectRevision = project.revision;
    if (project.personContract) snapshot.personContract = { ...project.personContract };
    const enabledRegions = (project.regions ?? []).filter(region => region.enabled);
    if (enabledRegions.length > 0) {
      snapshot.regions = enabledRegions.map(region => ({
        id: region.id,
        name: region.name,
        replaceType: region.replaceType,
        constraintStrength: region.constraintStrength,
        ...(region.replaceScope ? { replaceScope: region.replaceScope } : {}),
        ...(region.personReferenceLabel ? { personReferenceLabel: region.personReferenceLabel } : {}),
        ...(region.prompt?.trim() ? { prompt: region.prompt.trim() } : {}),
        ...(region.shape.kind === 'rect'
          ? { rect: { x: region.shape.x, y: region.shape.y, w: region.shape.w, h: region.shape.h } }
          : {
            brush: {
              strokes: region.shape.strokes.length,
              naturalWidth: region.shape.naturalWidth,
              naturalHeight: region.shape.naturalHeight,
            },
          }),
        ...(region.maskPath ? { maskPath: region.maskPath } : {}),
      }));
    }
    if (project.renderingContract) snapshot.renderingContract = project.renderingContract;
    if (project.animeCharacterSnapshot) snapshot.animeCharacterSnapshot = project.animeCharacterSnapshot;
    if (project.detailInsertBindings && project.detailInsertBindings.length > 0) {
      snapshot.detailInsertBindings = project.detailInsertBindings;
    }
  }

  return snapshot;
}

// ===== 历史详情展示模型（纯函数；History 只消费，不自行推断） =====

/** 参考图角色中文标签（copy.md §任务详情固定词，禁止页面另写）。 */
export const PROVENANCE_ROLE_LABELS: Record<
  NonNullable<GenerationProvenanceSnapshot['imageRoles']>[number]['role'],
  string
> = {
  template: '画面模板',
  person_reference: '人物参考',
  anime_character_reference: '动漫角色参考',
  background_reference: '背景参考',
  style_reference: '风格参考',
  generic_reference: '参考图',
};

/** 服装策略中文描述（修改方案行 / 详情共用）。 */
export function describeClothingPolicy(
  policy: string | undefined,
  customClothing?: string,
): string {
  switch (policy) {
    case 'use_subject_reference': return '使用人物参考服装';
    case 'custom': return customClothing?.trim() ? `自定义：${customClothing.trim()}` : '自定义服装（未填写描述）';
    case 'preserve_original': return '保留原图服装';
    default: return '';
  }
}

export interface ProvenancePlanRow {
  label: string;
  value: string;
  kind: 'modified' | 'keep' | 'source';
}

/** 「本次修改方案」结构化行（模板标签用于「沿用 @原图」类来源行）。 */
export function describeProvenanceModificationPlan(
  snapshot: GenerationProvenanceSnapshot,
): ProvenancePlanRow[] {
  const intent = snapshot.modificationIntent;
  if (!intent) return [];
  const active = new Set(intent.activeDimensions);
  const templateLabel = snapshot.imageRoles?.find(role => role.role === 'template')?.label || '原图';
  const personLabel = intent.personReplacement?.label || '人物参考';
  const personEnabled = !!intent.personReplacement?.enabled;
  const rows: ProvenancePlanRow[] = [];

  rows.push(active.has('subject')
    ? {
        label: MODIFICATION_DIMENSION_LABELS.subject,
        value: personEnabled
          ? intent.personReplacement?.hasReferenceImage
            ? `替换为 @${personLabel}（身份 / 五官 / 发型以人物参考为准）`
            : `按文字描述重建（${personLabel || '未填写描述'}）`
          : '修改（未设置人物参考）',
        kind: 'source',
      }
    : { label: MODIFICATION_DIMENSION_LABELS.subject, value: `沿用 @${templateLabel}`, kind: 'keep' });

  // 人物身份来源显式审计行：强替换时「模板人物身份：不保留」必须可见
  if (personEnabled && intent.personReplacement?.hasReferenceImage) {
    rows.push({ label: '模板人物身份', value: '不保留（仅保留画面模板 / 风格 / 构图）', kind: 'modified' });
  }

  const dimensionKeys: ModificationDimension[] = ['pose', 'scene', 'camera', 'style'];
  for (const key of dimensionKeys) {
    rows.push(active.has(key)
      ? { label: MODIFICATION_DIMENSION_LABELS[key], value: '修改', kind: 'modified' }
      : { label: MODIFICATION_DIMENSION_LABELS[key], value: `沿用 @${templateLabel}`, kind: 'keep' });
  }

  rows.push(active.has('clothing')
    ? {
        label: MODIFICATION_DIMENSION_LABELS.clothing,
        value: describeClothingPolicy(intent.clothingPolicy, intent.customClothing),
        kind: 'modified',
      }
    : {
        label: MODIFICATION_DIMENSION_LABELS.clothing,
        value: personEnabled && intent.personReplacement?.hasReferenceImage
          ? `沿用 @${templateLabel}（仅服装；人物身份仍来自 @${personLabel}）`
          : '保留原图服装',
        kind: 'keep',
      });
  rows.push({ label: '构图', value: `沿用 @${templateLabel}`, kind: 'keep' });

  if (intent.replicationBoost) {
    rows.push({ label: '复刻强度', value: '提高复刻度（不作用于人物身份）', kind: 'modified' });
  }
  return rows;
}

/**
 * 「执行规则摘要」（spec §21）：最终 Prompt 之前的确定性规则速览——
 * 只读快照结构化字段（绝不解析 final_prompt 反推），供用户直接审计
 * 人物身份来源 / 模板人物处置 / 服装来源 / 各维度修改态。
 */
export function describeExecutionRules(snapshot: GenerationProvenanceSnapshot): string[] {
  const intent = snapshot.modificationIntent;
  if (!intent) return [];
  const rules: string[] = [];
  const templateLabel = snapshot.imageRoles?.find(role => role.role === 'template')?.label || '模板';
  const personLabel = intent.personReplacement?.label || '人物参考';
  const personEnabled = !!intent.personReplacement?.enabled;
  const personHasRef = personEnabled && !!intent.personReplacement?.hasReferenceImage;

  if (personEnabled) {
    rules.push(personHasRef
      ? `人物身份：@${personLabel}（人物参考图）`
      : `人物身份：按文字描述重建（${personLabel || '未填写描述'}）`);
    if (personHasRef) rules.push('模板人物身份：不保留');
  } else {
    rules.push(`人物身份：沿用 @${templateLabel}`);
  }
  const clothingRule = describeClothingPolicy(intent.clothingPolicy, intent.customClothing);
  rules.push(`服装：${clothingRule
    || (personHasRef ? `沿用 @${templateLabel}（仅服装）` : `沿用 @${templateLabel}`)}`);
  for (const key of ['pose', 'scene', 'camera', 'style'] as const) {
    rules.push(`${MODIFICATION_DIMENSION_LABELS[key]}：${intent.activeDimensions.includes(key) ? '修改' : `沿用 @${templateLabel}`}`);
  }
  if (intent.replicationBoost) rules.push('复刻度：提高（不作用于人物身份）');
  return rules;
}
