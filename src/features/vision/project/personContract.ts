/**
 * Person Replacement Contract V2（§7 / §8）—— 人物替换合同的归一化与校验。
 *
 *  - strength 是 Prompt / Contract 层约束等级（natural / balanced / strict），
 *    绝不是模型参数百分比（禁止伪造 80% / 95% / 100% 的"identity strength"）；
 *  - 绑定人物参考图后默认 strict（用户主动切换前不降级）；
 *  - preserveTemplateIdentity 恒为 false：strict 语义 = 人物身份主来源必须是
 *    person reference，模板不得继续提供脸部身份 / 脸型 / 五官 / 发型 / 外貌身份；
 *  - 服装不变量由 ModificationContract.clothingPolicy 单一来源表达
 *    （A: preserve_template ⇒ clothing ∉ dims；B/C: use_person_reference / custom
 *     ⇒ clothing ∈ dims 且 custom 时描述非空），本模块只做校验，不复制状态。
 */

import type { PersonReplacement } from '../modificationIntent';
import type {
  IdentityApplyScope,
  PersonConstraintStrength,
  PersonReplacementContract,
  PersonReplaceScope,
} from './types';
import type { RegionReplacement } from './types';

const STRENGTHS: ReadonlyArray<PersonConstraintStrength> = ['natural', 'balanced', 'strict'];
const SCOPES: ReadonlyArray<PersonReplaceScope> = ['whole_person', 'face', 'upper_body', 'custom_region'];
const APPLY_SCOPES: ReadonlyArray<IdentityApplyScope> = ['primary_subject_only', 'all_corresponding_subjects'];

export const PERSON_STRENGTH_LABELS: Record<PersonConstraintStrength, string> = {
  natural: '自然',
  balanced: '平衡',
  strict: '严格',
};

export const PERSON_REPLACE_SCOPE_LABELS: Record<PersonReplaceScope, string> = {
  whole_person: '整个人物',
  face: '脸部',
  upper_body: '上半身',
  custom_region: '指定区域',
};

/** 人物参考是否携带图片（图库 / 本地）。 */
export function personContractHasImage(person: PersonReplacementContract | null): boolean {
  return !!person && person.enabled && person.source !== 'description' && !!person.path?.trim();
}

/**
 * 归一化：字段形状 / 枚举合法化 + 不变量强制。
 *  - 绑定参考图（gallery/local 有 path）且未显式选过强度 → strict（§7.2 默认策略
 *    通过显式传入 undefined 实现：迁移 / 新建路径都不带 strength 字段）；
 *  - preserveTemplateIdentity 恒写 false；
 *  - custom_region 但 region 不存在 → 回落 whole_person（校验层另行报错的输入不进 store）。
 */
export function normalizePersonReplacementContract(
  person: PersonReplacementContract | null | undefined,
  regions?: ReadonlyArray<RegionReplacement>,
): PersonReplacementContract | null {
  if (!person || typeof person !== 'object') return null;
  const source = person.source === 'local' || person.source === 'description' ? person.source : 'gallery';
  const hasImage = source !== 'description' && !!person.path?.trim();
  const strength = STRENGTHS.includes(person.strength) ? person.strength : undefined;
  const replaceScope = SCOPES.includes(person.replaceScope) ? person.replaceScope : undefined;

  let scope: PersonReplaceScope = replaceScope ?? 'whole_person';
  if (scope === 'custom_region') {
    const regionExists = !!person.targetRegionId && (regions ?? []).some(r => r.id === person.targetRegionId);
    if (!regionExists) scope = 'whole_person';
  }

  return {
    enabled: person.enabled !== false,
    source,
    assetId: typeof person.assetId === 'string' ? person.assetId : undefined,
    path: typeof person.path === 'string' ? person.path : undefined,
    label: typeof person.label === 'string' ? person.label : undefined,
    description: typeof person.description === 'string' ? person.description : undefined,
    strength: strength ?? (hasImage ? 'strict' : 'balanced'),
    replaceScope: scope,
    targetRegionId: scope === 'custom_region' ? person.targetRegionId : undefined,
    preserveTemplateIdentity: false,
    applyIdentityTo: APPLY_SCOPES.includes(person.applyIdentityTo) ? person.applyIdentityTo : 'primary_subject_only',
  };
}

/** 从既有 ModificationDraft.person（V1）迁移为 V2 合同（默认 strict）。 */
export function migrateLegacyPerson(
  legacy: PersonReplacement | null,
  regions?: ReadonlyArray<RegionReplacement>,
): PersonReplacementContract | null {
  if (!legacy) return null;
  return normalizePersonReplacementContract(
    {
      enabled: true,
      source: legacy.source,
      assetId: legacy.assetId,
      path: legacy.path,
      label: legacy.label,
      description: legacy.description,
      strength: undefined as unknown as PersonConstraintStrength,
      replaceScope: 'whole_person',
      preserveTemplateIdentity: false,
      applyIdentityTo: 'primary_subject_only',
    },
    regions,
  );
}

/** V2 合同 → 既有 ModificationDraft.person（旧组件兼容视图；写路径禁止反向绕过合同）。 */
export function toLegacyPerson(contract: PersonReplacementContract | null): PersonReplacement | null {
  if (!contract) return null;
  return {
    source: contract.source,
    assetId: contract.assetId,
    path: contract.path,
    label: contract.label,
    description: contract.description,
  };
}

/**
 * 人物绑定同步（页面镜像用）：V1 draft.person 变化时生成 V2 合同；
 * 同一人物（同来源 + 同路径）保留既有 V2 字段（strength / replaceScope /
 * applyIdentityTo / targetRegionId —— 用户显式选择过的值不因镜像而重置）。
 * 换人物 → 全新合同（绑定图默认 strict）。
 */
export function mergePersonContract(
  prev: PersonReplacementContract | null,
  legacy: PersonReplacement | null,
  regions?: ReadonlyArray<RegionReplacement>,
): PersonReplacementContract | null {
  if (!legacy) return null;
  const next = migrateLegacyPerson(legacy, regions);
  if (!next) return null;
  if (
    prev
    && prev.source === next.source
    && (prev.path ?? '') === (next.path ?? '')
  ) {
    return { ...prev, enabled: true, label: next.label, description: next.description };
  }
  return next;
}

/** 语义校验（§37）：strict + 无参考图 = 语义错误（生成阻断）。 */
export function validatePersonReplacement(
  person: PersonReplacementContract | null,
): string[] {
  if (!person || !person.enabled) return [];
  const errors: string[] = [];
  if (person.strength === 'strict' && !personContractHasImage(person) && person.source !== 'description') {
    errors.push('人物严格替换需要先绑定人物参考图。');
  }
  if (person.source === 'description' && !person.description?.trim()) {
    errors.push('文字描述人物需要先填写人物描述。');
  }
  if (person.replaceScope === 'custom_region' && !person.targetRegionId) {
    errors.push('替换范围为「指定区域」时必须先选择区域。');
  }
  if (person.preserveTemplateIdentity !== false) {
    errors.push('模板人物身份不允许保留（preserveTemplateIdentity 恒为 false）。');
  }
  return errors;
}
