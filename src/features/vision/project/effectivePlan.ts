/**
 * Current Effective Plan（§13）—— Template + Modification + Regions + References
 * + RenderingContract 合成后的有效方案（纯函数）。
 *
 * 所有 UI（Context Rail「本次将这样生成」、确认弹层、Prompt Compiler、
 * 溯源快照）都读本产物；组件不得自行重新拼装。
 */

import { MODIFICATION_DIMENSION_LABELS } from '../modificationIntent';
import { describeClothingPolicy } from '../generationProvenance';
import { PERSON_REPLACE_SCOPE_LABELS, PERSON_STRENGTH_LABELS, personContractHasImage } from './personContract';
import { REGION_TYPE_LABELS, describeRectPosition } from './region';
import { RENDERING_MODE_LABELS, singleMediaModeOf } from './rendering';
import { validateGenerationContract } from './validators';
import type {
  EffectivePlanRow,
  EffectiveVisualPlan,
  PersonReplacementContract,
  VisualProject,
} from './types';

const PLAN_DIMENSION_ORDER = ['subject', 'pose', 'scene', 'camera', 'style', 'clothing'] as const;

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

/** 有效方案行（模板基线 + 修改 overlay 的合成视图；keep 行读模板，modified 行读合同）。 */
function buildRows(project: VisualProject): EffectivePlanRow[] {
  const templateLabel = project.sourceAsset.displayName?.trim() || '原图';
  const { modification } = project;
  const activeDims = new Set(modification.activeDimensions);
  const person = modification.person?.enabled ? modification.person : null;
  const personRefLabel = personSummary(modification.person)?.label || '人物参考';
  const rows: EffectivePlanRow[] = [];

  // 人物身份（source 行）：强替换 → 来自人物参考；否则沿用模板
  rows.push(person && personContractHasImage(person)
    ? {
      key: 'person_identity',
      label: '人物身份',
      value: `替换为 @${personRefLabel}`,
      kind: 'source',
    }
    : { key: 'person_identity', label: '人物身份', value: `沿用 @${templateLabel}`, kind: 'keep' });

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
        value: person.strength === 'strict' ? '不保留' : '不保留（身份以人物参考为准）',
        kind: 'modified',
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
      rows.push(activeDims.has('clothing')
        ? {
          key: 'clothing',
          label,
          value: describeClothingPolicy(
            modification.clothingPolicy === 'use_subject_reference' ? 'use_subject_reference' : modification.clothingPolicy,
            modification.customClothing,
          ),
          kind: 'modified',
        }
        : {
          key: 'clothing',
          label,
          value: person
            ? `沿用 @${templateLabel}（仅服装；人物身份仍来自 @${personRefLabel}）`
            : `沿用 @${templateLabel}`,
          kind: 'keep',
        });
      continue;
    }
    rows.push(activeDims.has(key)
      ? { key, label, value: '修改', kind: 'modified' }
      : { key, label, value: `沿用 @${templateLabel}`, kind: 'keep' });
  }

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
    rows.push({ key: 'replication', label: '复刻强度', value: '提高复刻度（不作用于人物身份）', kind: 'modified' });
  }

  return rows;
}

/** 有效方案唯一构建入口（Rail / 确认弹层 / Compiler / 溯源共用）。 */
export function buildEffectiveVisualPlan(project: VisualProject): EffectiveVisualPlan {
  return {
    template: project.templateSnapshot
      ? {
        label: project.sourceAsset.displayName?.trim() || '原图',
        path: project.sourceAsset.path,
      }
      : null,
    person: personSummary(project.modification.person),
    rows: buildRows(project),
    regions: project.regions.filter(region => region.enabled),
    rendering: project.renderingContract ?? null,
    blockingErrors: validateGenerationContract(project),
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
