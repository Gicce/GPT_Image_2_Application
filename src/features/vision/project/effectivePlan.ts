/**
 * Current Effective Plan（§13）—— Template + Modification + Regions + References
 * + RenderingContract 合成后的有效方案（纯函数）。
 *
 * 所有 UI（Context Rail「本次将这样生成」、确认弹层、Prompt Compiler、
 * 溯源快照）都读本产物；组件不得自行重新拼装。
 */

import { MODIFICATION_DIMENSION_LABELS } from '../modificationIntent';
import { describeClothingPolicy } from '../generationProvenance';
import { resolveAnimeCharacter, validateAnimeCharacterConsistency } from './animeCharacter';
import { countInsertInstances } from './detailInsert';
import { PERSON_REPLACE_SCOPE_LABELS, PERSON_STRENGTH_LABELS, personContractHasImage } from './personContract';
import { REGION_TYPE_LABELS, describeRectPosition } from './region';
import { RENDERING_MODE_LABELS, singleMediaModeOf } from './rendering';
import { validateDimensionLockContract } from './dimensionLock';
import { validateGenerationContract } from './validators';
import type {
  EffectivePlanRow,
  EffectivePlanSourceRef,
  EffectiveVisualPlan,
  PersonReplacementContract,
  VisualProject,
} from './types';

const PLAN_DIMENSION_ORDER = ['subject', 'pose', 'scene', 'camera', 'style', 'clothing'] as const;

// ===== 来源显示（不变量：任何可预览 / 可点击的来源 label 永不为空）=====

/** @chip 展示名上限（超长名保留可见前缀 + 扩展名；完整名走 fullLabel / title）。 */
const SOURCE_LABEL_MAX = 18;

const SOURCE_ROLE_FALLBACK_LABELS: Record<EffectivePlanSourceRef['role'], string> = {
  template: '模板图',
  person: '人物参考图',
  mention: '图片引用',
};

const SOURCE_ROLE_NOTES: Record<EffectivePlanSourceRef['role'], string> = {
  template: '类型：模板图 · 作用：复刻的画面基线（布局 / 背景 / 锁定维度）',
  person: '类型：人物参考 · 作用：提供人物身份（与按合同的服装）',
  mention: '类型：图片引用 · 作用：当前修改意图中 @ 引用的图片',
};

function fileBasename(path: string | undefined): string {
  if (!path?.trim()) return '';
  return path.split(/[\\/]/).pop() ?? '';
}

/** 超长名缩短（保留可见前缀 + 扩展名；无扩展名截断加省略号）。 */
function shortenSourceLabel(label: string, maxLength = SOURCE_LABEL_MAX): string {
  if (label.length <= maxLength) return label;
  const extMatch = label.match(/\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i);
  if (extMatch) {
    const ext = extMatch[0];
    const keep = Math.max(4, maxLength - ext.length - 1);
    return `${label.slice(0, keep)}…${ext}`;
  }
  return `${label.slice(0, maxLength - 1)}…`;
}

/**
 * 来源 ref 唯一构建入口（Rail / 确认弹层 / 溯源共用）：
 * label 兜底链 = 显式名 > 文件 basename > 角色兜底名，永不为空串；
 * label 为缩短展示名，fullLabel 为完整名（title / hover 浮层）。
 */
export function buildPlanSourceRef(input: {
  key: string;
  label?: string;
  path?: string;
  assetId?: string;
  role: EffectivePlanSourceRef['role'];
}): EffectivePlanSourceRef {
  const fullLabel = input.label?.trim() || fileBasename(input.path) || SOURCE_ROLE_FALLBACK_LABELS[input.role];
  return {
    key: input.key,
    label: shortenSourceLabel(fullLabel),
    fullLabel,
    roleNote: SOURCE_ROLE_NOTES[input.role],
    ...(input.path?.trim() ? { path: input.path } : {}),
    ...(input.assetId ? { assetId: input.assetId } : {}),
    role: input.role,
  };
}

function personSummary(person: PersonReplacementContract | null): EffectiveVisualPlan['person'] {
  if (!person?.enabled) return null;
  return {
    label: person.source === 'description'
      ? (person.description?.trim() || '文字描述人物')
      : (person.label?.trim() || person.path?.split(/[\\/]/).pop() || '人物参考'),
    path: personContractHasImage(person) ? person.path : undefined,
    strength: person.strength,
    scope: person.replaceScope,
  };
}

/**
 * 有效方案行（模板基线 + 修改 overlay 的合成视图；keep 行读模板，modified 行读合同）。
 * §A 来源可视：@token 一律带 refs（真实图片侧车），已替换 / 不保留带状态徽标——
 * 用户一眼看懂「哪些维度已替换、来源是哪张图、哪些维度锁定沿用模板」。
 */
function buildRows(project: VisualProject): EffectivePlanRow[] {
  // 模板显示名走产品口径：显式名 > 「原图」（basename 对模板无信息量，且与既有文案一致）
  const templateRef = buildPlanSourceRef({
    key: 'tpl',
    label: project.sourceAsset.displayName?.trim() || '原图',
    path: project.sourceAsset.path,
    assetId: project.sourceAsset.assetId,
    role: 'template',
  });
  const templateLabel = templateRef.label;
  const { modification } = project;
  const activeDims = new Set(modification.activeDimensions);
  const person = modification.person?.enabled ? modification.person : null;
  const personSummaryRow = personSummary(modification.person);
  const rows: EffectivePlanRow[] = [];

  const personRef: EffectivePlanSourceRef | null = person && personSummaryRow?.path
    ? buildPlanSourceRef({
      key: 'person',
      label: personSummaryRow.label,
      path: personSummaryRow.path,
      assetId: person.assetId,
      role: 'person',
    })
    : null;
  const personRefLabel = personRef?.label ?? '人物参考';

  // 人物身份（source 行）：强替换 → 来自人物参考；否则沿用模板
  rows.push(person && personContractHasImage(person)
    ? {
      key: 'person_identity',
      label: '人物身份',
      value: `替换为 @${personRefLabel}`,
      kind: 'source',
      refs: [personRef!],
      badge: { text: '已替换', tone: 'success' },
    }
    : {
      key: 'person_identity',
      label: '人物身份',
      value: `沿用 @${templateLabel}`,
      kind: 'keep',
      refs: [templateRef],
    });

  if (person) {
    rows.push({
      key: 'person_strength',
      label: '人物约束',
      value: PERSON_STRENGTH_LABELS[person.strength],
      kind: 'source',
    });
    rows.push({
      key: 'person_scope',
      label: '替换范围',
      value: person.replaceScope === 'custom_region'
        ? `指定区域${person.targetRegionId ? '' : '（未选择）'}`
        : PERSON_REPLACE_SCOPE_LABELS[person.replaceScope],
      kind: 'source',
    });
    if (personContractHasImage(person)) {
      rows.push({
        key: 'template_identity',
        label: '模板人物',
        value: `不保留（模板图 @${templateLabel} 中的原人物身份；新身份来自 @${personRefLabel}）`,
        kind: 'modified',
        refs: [templateRef, personRef!],
        badge: { text: '不保留', tone: 'warn' },
      });
    }
    rows.push({
      key: 'identity_apply',
      label: '身份应用',
      value: person.applyIdentityTo === 'all_corresponding_subjects' ? '所有对应主体' : '仅主体人物',
      kind: 'info',
    });
  }

  // 修改维度（pose≡动作、scene≡背景；沿用基线 = keep）
  for (const key of PLAN_DIMENSION_ORDER) {
    if (key === 'subject') continue; // subject 由人物身份行表达
    const label = MODIFICATION_DIMENSION_LABELS[key];
    if (key === 'clothing') {
      if (activeDims.has('clothing')) {
        const usesPersonClothing = modification.clothingPolicy === 'use_subject_reference' && !!personRef;
        rows.push({
          key: 'clothing',
          label,
          value: usesPersonClothing
            ? `使用 @${personRefLabel} 的服装`
            : describeClothingPolicy(modification.clothingPolicy, modification.customClothing),
          kind: 'modified',
          ...(usesPersonClothing
            ? { refs: [personRef!], badge: { text: '已替换', tone: 'success' as const } }
            : {}),
        });
      } else {
        rows.push({
          key: 'clothing',
          label,
          value: person
            ? `沿用 @${templateLabel}（仅服装；人物身份仍来自 @${personRefLabel}）`
            : `沿用 @${templateLabel}`,
          kind: 'keep',
          refs: personRef ? [templateRef, personRef] : [templateRef],
        });
      }
      continue;
    }
    rows.push(activeDims.has(key)
      ? { key, label, value: '修改', kind: 'modified' }
      : {
        key,
        label,
        value: `沿用 @${templateLabel}`,
        kind: 'keep',
        refs: [templateRef],
      });
  }

  // 不可 Chip 化的锁定维度（§15/§28：无修改入口 ⇒ 恒 locked，Rail 显式可见）
  rows.push({
    key: 'composition',
    label: '构图',
    value: `沿用 @${templateLabel}`,
    kind: 'keep',
    refs: [templateRef],
  });

  // 媒介结构（Rendering Contract；混合媒介保持模板分层 = §10/§11 修复点）
  const rendering = project.renderingContract;
  if (rendering?.overallMode === 'mixed_media') {
    const layerText = rendering.regions.length
      ? rendering.regions
        .map(region => {
          const identity = region.identityRelation === 'same_as_primary'
            ? '（与主体同一人物）'
            : region.identityRelation === 'person_reference' ? '（人物参考身份）' : '';
          return `${region.label}=${RENDERING_MODE_LABELS[region.renderingMode]}${identity}`;
        })
        .join('；')
      : '保持模板混合结构';
    rows.push({
      key: 'media_structure',
      label: '媒介结构',
      value: rendering.preserveTemplateMediaStructure ? `保持模板混合媒介：${layerText}` : layerText,
      kind: 'keep',
    });
  } else if (rendering) {
    const mode = singleMediaModeOf(rendering);
    rows.push({
      key: 'media_structure',
      label: '媒介结构',
      value: mode !== 'unknown' ? `单一媒介：${RENDERING_MODE_LABELS[mode]}` : '未识别媒介',
      kind: 'keep',
    });
  }

  // 动漫角色一致性（Canonical Anime Character 存在时的摘要行；hover 走 refs 预览）
  const animeCharacter = resolveAnimeCharacter(project);
  if (animeCharacter) {
    const hairFacts = animeCharacter.hair.facts;
    const hairBrief = hairFacts
      ? `${hairFacts.baseColor || '?'}发 · ${hairFacts.length} · ${hairFacts.texture} · 刘海${hairFacts.bangs}`
      : animeCharacter.hair.binding === 'person_reference' ? '发型随人物参考' : '发型随模板动漫主体';
    const consistencyMode = project.animeConsistency?.mode ?? 'standard';
    const animeFullLabel = `动漫主角色「${animeCharacter.sourceSubjectLabel}」· 身份来源：${
      animeCharacter.identitySource.kind === 'person_reference'
        ? `@${animeCharacter.identitySource.label ?? '人物参考图'}`
        : animeCharacter.identitySource.kind === 'manual' ? '文字描述' : '模板原身份'
    } · ${hairBrief} · 服装来源：${
      animeCharacter.clothing.source === 'person_reference'
        ? '人物参考（动漫媒介呈现）'
        : animeCharacter.clothing.source === 'custom' ? '自定义' : '模板'
    }`;
    const characterAsset = project.animeConsistency?.characterAsset;
    rows.push({
      key: 'anime_character',
      label: '动漫角色',
      value: consistencyMode === 'strict_visual_reference'
        ? `🔒 已统一角色卡 · 强一致性${characterAsset?.localPath ? '（已建角色参考图）' : '（角色参考图待生成）'}`
        : '🔒 已统一角色卡 · 标准',
      kind: 'keep',
      refs: personRef
        ? [{ ...personRef, key: 'anime-character', fullLabel: animeFullLabel, roleNote: animeFullLabel }]
        : undefined,
    });
    if (consistencyMode === 'strict_visual_reference' && characterAsset?.localPath) {
      rows.push({
        key: 'anime_character_reference',
        label: '动漫角色参考',
        value: '@角色参考图（生成时随图提交，全部动漫区域唯一视觉角色设计来源）',
        kind: 'source',
        refs: [{
          key: 'anime-character-asset',
          label: '角色参考图',
          fullLabel: '动漫角色参考图（由人物参考派生生成；人物参考 / 服装 / 角色设计不变则复用，不重复计费）',
          roleNote: '类型：动漫角色参考 · 作用：Strict 模式第三参考图（全部动漫区域唯一视觉角色设计来源）',
          path: characterAsset.localPath,
          ...(characterAsset.libraryAssetId ? { assetId: characterAsset.libraryAssetId } : {}),
          role: 'person',
        }],
      });
    }
    // V5 实例口径：一个画框 = 一个 instance（Group 不再冒充 Instance）
    const counts = countInsertInstances(rendering);
    rows.push({
      key: 'detail_inserts',
      label: '动漫特写',
      value: counts.anime > 0
        ? `🔒 同步 @动漫主角色 · ${counts.anime} 个插图${counts.incompleteRegions.length > 0 ? `（另有 ${counts.incompleteRegions.length} 层未逐实例识别）` : ''}`
        : counts.incompleteRegions.length > 0
          ? `⚠ 有插图层未逐实例识别`
          : '🔒 同步主动漫角色',
      kind: 'keep',
    });
  }

  // 区域
  const enabledRegions = project.regions.filter(region => region.enabled);
  rows.push(enabledRegions.length > 0
    ? {
      key: 'regions',
      label: '区域替换',
      value: `${enabledRegions.length} 个区域`,
      kind: 'modified',
    }
    : { key: 'regions', label: '区域替换', value: '无', kind: 'keep' });

  if (modification.replicationBoost) {
    rows.push({
      key: 'replication',
      label: '复刻强度',
      value: '提高复刻度（不作用于人物身份；取消后可自动恢复上一版优化结果）',
      kind: 'modified',
    });
  }

  return rows;
}

/** 有效方案唯一构建入口（Rail / 确认弹层 / Compiler / 溯源共用）。 */
export function buildEffectiveVisualPlan(project: VisualProject): EffectiveVisualPlan {
  const templateRef = buildPlanSourceRef({
    key: 'tpl-head',
    label: project.sourceAsset.displayName?.trim() || '原图',
    path: project.sourceAsset.path,
    assetId: project.sourceAsset.assetId,
    role: 'template',
  });
  return {
    template: project.templateSnapshot
      ? { label: templateRef.label, fullLabel: templateRef.fullLabel, roleNote: templateRef.roleNote, path: project.sourceAsset.path }
      : null,
    person: personSummary(project.modification.person),
    rows: buildRows(project),
    regions: project.regions.filter(region => region.enabled),
    rendering: project.renderingContract ?? null,
    blockingErrors: [
      ...validateGenerationContract(project),
      // Dimension Lock §20：锁定维度与模板基线冲突 = 阻断（Rail 即时可见）
      ...validateDimensionLockContract(project),
      // Anime Character Consistency：动漫插图未绑定唯一角色卡 = 阻断
      ...validateAnimeCharacterConsistency(project),
    ],
  };
}

/** 区域行详情（区域卡 / History 区域段共用）。 */
export function describeRegionRow(
  region: VisualProject['regions'][number],
  references: ReadonlyArray<{ id: string; label: string }>,
): { typeLabel: string; scopeLabel: string; strengthLabel: string; positionLabel: string; refLabel?: string } {
  const ref = references.find(item => item.id === region.personReferenceId);
  return {
    typeLabel: REGION_TYPE_LABELS[region.replaceType],
    scopeLabel: region.replaceScope ? PERSON_REPLACE_SCOPE_LABELS[region.replaceScope] : '—',
    strengthLabel: PERSON_STRENGTH_LABELS[region.constraintStrength],
    positionLabel: region.shape.kind === 'rect'
      ? describeRectPosition(region.shape)
      : '画笔涂抹区域',
    refLabel: ref?.label,
  };
}
