/**
 * Reference Appearance Service（V5）—— 人物参考外貌事实的解析与缓存。
 *
 * 铁律（V5 §13）：
 *  - 第一次需要时解析一次，按图片指纹缓存（project.referenceAppearance）；
 *    绝不每次生成重新 Vision Call；
 *  - 失败不阻断任何主链路（角色卡回落来源指示语义，UI 如实提示未解析）；
 *  - 指纹 = assetId + path：换人物参考图 ⇒ 过期重析。
 */

import { api } from '../../../services/api';
import { resolveByokVisionConfig } from '../../aiProviders/store';
import {
  referenceAppearanceFingerprint,
  referenceAppearanceMatches,
} from './animeCharacter';
import type {
  CharacterFaceFacts,
  CharacterHairFacts,
  ModelExecutionSnapshot,
  ReferenceAppearanceSnapshot,
  VisualProject,
} from './types';

const HAIR_LENGTH_VALUES = ['short', 'shoulder', 'chest', 'waist', 'other'] as const;
const HAIR_TEXTURE_VALUES = ['straight', 'soft_wave', 'large_wave', 'curly', 'other'] as const;
const HAIR_PARTING_VALUES = ['center', 'left', 'right', 'none', 'other'] as const;
const HAIR_BANGS_VALUES = ['none', 'curtain', 'side', 'full', 'wispy', 'other'] as const;

function enumOr<T extends string>(values: readonly T[], raw: string, fallback: T): T {
  const value = (raw || '').trim().toLowerCase() as T;
  return values.includes(value) ? value : fallback;
}

function text(raw: string | undefined | null): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Rust 事实体 → 领域结构（枚举不合法回落 other；空串保留 = 观察不到）。 */
export function normalizeAppearanceFacts(facts: NonNullable<Awaited<ReturnType<typeof api.visionAnalyzeReferenceAppearance>>['facts']>): {
  hair: CharacterHairFacts;
  face: CharacterFaceFacts;
  accessories: string[];
  clothing: string[];
} {
  return {
    hair: {
      baseColor: text(facts.hair_color),
      length: enumOr(HAIR_LENGTH_VALUES, facts.hair_length, 'other'),
      texture: enumOr(HAIR_TEXTURE_VALUES, facts.hair_texture, 'other'),
      parting: enumOr(HAIR_PARTING_VALUES, facts.hair_parting, 'other'),
      bangs: enumOr(HAIR_BANGS_VALUES, facts.hair_bangs, 'other'),
      silhouetteDescription: text(facts.hair_silhouette),
    },
    face: {
      shape: text(facts.face_shape),
      eyeShape: text(facts.eye_shape),
      irisColor: text(facts.iris_color),
      ...(text(facts.eyelash_style) ? { eyelashStyle: text(facts.eyelash_style) } : {}),
    },
    accessories: (facts.accessories ?? []).map(item => text(item)).filter(Boolean),
    clothing: (facts.clothing ?? []).map(item => text(item)).filter(Boolean),
  };
}

/** 外貌事实是否值得缓存（至少有一项发型或脸部事实；全空 = 不缓存不伪造）。 */
export function appearanceFactsMeaningful(facts: {
  hair: CharacterHairFacts;
  face: CharacterFaceFacts;
}): boolean {
  return !!(facts.hair.baseColor
    || (facts.hair.length !== 'other')
    || (facts.hair.texture !== 'other')
    || (facts.hair.bangs !== 'other')
    || facts.face.shape
    || facts.face.eyeShape
    || facts.face.irisColor);
}

export interface ReferenceAppearanceOutcome {
  ok: boolean;
  snapshot?: ReferenceAppearanceSnapshot;
  errorMessage?: string;
}

/**
 * 解析（或复用缓存）人物参考外貌快照。
 * 输入：当前项目（人物参考绑定 + 缓存指纹校验）+ 可选模型快照（展示用）。
 * 调用方负责把返回的 snapshot 写回 project.referenceAppearance 并持久化。
 */
export async function ensureReferenceAppearance(
  project: VisualProject,
  model?: ModelExecutionSnapshot,
): Promise<ReferenceAppearanceOutcome> {
  const person = project.modification.person;
  const imagePath = person?.path?.trim();
  if (!person?.enabled || !imagePath) {
    return { ok: false, errorMessage: '未绑定人物参考图' };
  }
  if (referenceAppearanceMatches(project)) {
    return { ok: true, snapshot: project.referenceAppearance };
  }
  const config = resolveByokVisionConfig({
    profileId: project.workspace.profileId || undefined,
    modelId: project.workspace.modelId || undefined,
  });
  if (!config.ok) {
    return { ok: false, errorMessage: config.error };
  }
  try {
    const result = await api.visionAnalyzeReferenceAppearance({
      imagePath,
      baseUrl: config.baseUrl,
      token: config.token,
      model: config.model,
    });
    if (!result.ok || !result.facts) {
      return { ok: false, errorMessage: result.error_message ?? '人物参考外貌解析失败' };
    }
    const facts = normalizeAppearanceFacts(result.facts);
    if (!appearanceFactsMeaningful(facts)) {
      return { ok: false, errorMessage: '人物参考外貌解析结果为空' };
    }
    const snapshot: ReferenceAppearanceSnapshot = {
      fingerprint: referenceAppearanceFingerprint(person.assetId, person.path),
      hair: facts.hair,
      face: facts.face,
      accessories: facts.accessories,
      clothing: facts.clothing,
      ...(model ? { model } : {}),
      analyzedAt: new Date().toISOString(),
    };
    return { ok: true, snapshot };
  } catch (error) {
    return { ok: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}
