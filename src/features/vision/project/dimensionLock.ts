/**
 * Dimension Lock Contract（§11/§12）—— 修改维度「锁定 / 修改」二态合同。
 *
 * 铁律：
 *  - LOCKED ≠「尽量沿用」。LOCKED = Prompt Optimizer 无权修改、
 *    Final Description 无权改写、Compiler 直接从 Template Snapshot 复制
 *    canonical constraints（§12 HARD RULE）；
 *  - 判定规则（§11）：维度在 modification.activeDimensions 中（用户点了修改 Chip）
 *    或被用户在方案卡手动开放（user_override 解锁）⇒ modified；否则 ⇒ locked；
 *  - 生成前结构化校验（§20）：locked 维度的有效方案值必须等于模板基线，
 *    冲突即阻断生成，绝不偷偷继续。
 *
 * 纯函数层：只读 VisualProject，不 import 任何 store / service。
 */

import {
  PLAN_FIELD_LABELS,
  RECREATION_FIELD_KEYS,
  type RecreationFieldKey,
} from '../recreationPlan';
import type { ModificationDimension } from '../modificationIntent';
import type { VisualProject, VisualTemplateSnapshot } from './types';

/** 快捷修改维度 → 复刻方案维度 key（subject/clothing/pose/scene/camera/style 同名）。 */
const DIMENSION_TO_FIELD: Record<ModificationDimension, RecreationFieldKey> = {
  subject: 'subject',
  clothing: 'clothing',
  pose: 'pose',
  scene: 'scene',
  camera: 'camera',
  style: 'style',
};

export type DimensionLockMode = 'locked' | 'modified';

export interface DimensionContract {
  key: RecreationFieldKey;
  mode: DimensionLockMode;
  /** 模板 canonical 基线（locked 维度的唯一合法值）。 */
  baseline: string;
}

/** 模板快照维度 → 复刻方案维度 key 的基线读取。 */
export function templateBaselineOf(
  snapshot: VisualTemplateSnapshot,
  key: RecreationFieldKey,
): string {
  switch (key) {
    case 'subject': return snapshot.subject.originalValue;
    case 'pose': return snapshot.action.originalValue;
    case 'scene': return snapshot.background.originalValue;
    case 'composition': return snapshot.composition.originalValue;
    case 'camera': return snapshot.camera.originalValue;
    case 'lighting': return snapshot.lighting.originalValue;
    case 'style': return snapshot.style.originalValue;
    case 'color': return snapshot.color.originalValue;
    case 'clothing': return snapshot.clothing.originalValue;
    default: return '';
  }
}

/** 用户在方案卡手动开放的维度（user_override 且未锁定；既有锁定三来源的尊重项）。 */
function userUnlockedKeys(project: VisualProject): Set<RecreationFieldKey> {
  const keys = new Set<RecreationFieldKey>();
  for (const field of project.workspace.recreation?.plan.fields ?? []) {
    if (field.lockSource === 'user_override' && !field.locked) keys.add(field.key);
  }
  return keys;
}

function modifiedKeysOf(project: VisualProject): Set<RecreationFieldKey> {
  const modified = new Set<RecreationFieldKey>();
  for (const dimension of project.modification.activeDimensions) {
    modified.add(DIMENSION_TO_FIELD[dimension]);
  }
  for (const key of userUnlockedKeys(project)) modified.add(key);
  return modified;
}

/** Dimension Lock 合同全量构建（9 维；无模板快照时全部退化为 modified，不阻断）。 */
export function buildDimensionContracts(project: VisualProject): DimensionContract[] {
  const snapshot = project.templateSnapshot;
  if (!snapshot) return RECREATION_FIELD_KEYS.map(key => ({ key, mode: 'modified' as const, baseline: '' }));
  const modified = modifiedKeysOf(project);
  return RECREATION_FIELD_KEYS.map(key => ({
    key,
    mode: modified.has(key) ? ('modified' as const) : ('locked' as const),
    baseline: templateBaselineOf(snapshot, key),
  }));
}

/** 锁定维度 key 列表（优化器输出清洗与生成前校验共用）。 */
export function lockedDimensionKeys(project: VisualProject): RecreationFieldKey[] {
  return buildDimensionContracts(project)
    .filter(contract => contract.mode === 'locked')
    .map(contract => contract.key);
}

/** 锁定维度基线值表（清洗时回填模板 canonical 值）。 */
export function lockBaselineValues(project: VisualProject): Partial<Record<RecreationFieldKey, string>> {
  const values: Partial<Record<RecreationFieldKey, string>> = {};
  for (const contract of buildDimensionContracts(project) as Array<DimensionContract & { mode: DimensionLockMode }>) {
    if (contract.mode === 'locked') values[contract.key] = contract.baseline;
  }
  return values;
}

/**
 * 生成前结构化校验（§20 Contract Validator）：
 * locked 维度的有效方案值（workspace.recreation.plan 字段）与模板基线冲突
 * ⇒ 阻断生成（调用方提示「请重新优化 Prompt」，绝不静默放行）。
 * 只比对结构化 EffectivePlan 字段，不做 prompt 正文 regex。
 */
export function validateDimensionLockContract(project: VisualProject | null): string[] {
  if (!project?.templateSnapshot) return [];
  const modified = modifiedKeysOf(project);
  const fields = project.workspace.recreation?.plan.fields ?? [];
  const drifted: string[] = [];
  for (const key of RECREATION_FIELD_KEYS) {
    if (modified.has(key)) continue;
    const field = fields.find(item => item.key === key);
    const baseline = templateBaselineOf(project.templateSnapshot, key).trim();
    if (!field || !baseline) continue;
    if (field.value.trim() && field.value.trim() !== baseline) {
      drifted.push(PLAN_FIELD_LABELS[key]);
    }
  }
  if (drifted.length === 0) return [];
  return [`当前生成方案与模板锁定规则冲突（${drifted.join('、')}已锁定沿用模板），请重新优化 Prompt。`];
}
