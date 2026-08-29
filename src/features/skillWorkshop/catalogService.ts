import { requestServerUrl } from '../../services/serverApi';
import { BUILTIN_CATALOG, BUILTIN_DESK_PACKAGE, BUILTIN_UI_PACKAGE } from './builtinCatalog';
import type { SkillCatalogItem, SkillPackage, SkillProfile } from './types';

const CATALOG_KEY = 'cy_skill_catalog_v1';
const packageKey = (skillId: string, version: string) => `cy_skill_package_${skillId}_${version}`;
/** 离线回退：同 skill 有内置包（专业桌搭 / UI 概念设计）则用之，其余方向回落桌搭。 */
const BUILTIN_PACKAGE_FALLBACK: Record<string, SkillPackage> = {
  professional_desk_setup: BUILTIN_DESK_PACKAGE,
  ui_concept: BUILTIN_UI_PACKAGE,
};

export async function loadSkillCatalog(): Promise<{ items: SkillCatalogItem[]; source: 'server' | 'cache' | 'builtin' }> {
  try {
    const response = await fetch(`${requestServerUrl()}/api/skills/catalog`);
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    const rawItems = (body.packages ?? body.items ?? body) as Array<Record<string, unknown>>;
    const items = rawItems.map(item => ({
      skill_id: String(item.skill_id), version: String(item.version), name: String(item.name),
      domain: item.domain as SkillCatalogItem['domain'], summary: String(item.summary ?? ''),
      readiness: item.availability === 'ready' ? 'ready' as const : 'testing' as const,
    }));
    localStorage.setItem(CATALOG_KEY, JSON.stringify(items));
    return { items, source: 'server' };
  } catch {
    const cached = localStorage.getItem(CATALOG_KEY);
    if (cached) { try { return { items: JSON.parse(cached), source: 'cache' }; } catch { /* fallback */ } }
    return { items: BUILTIN_CATALOG, source: 'builtin' };
  }
}

export async function loadSkillPackage(skillId: string, version: string): Promise<SkillPackage> {
  const cacheKey = packageKey(skillId, version);
  try {
    const response = await fetch(`${requestServerUrl()}/api/skills/${skillId}/versions/${version}`);
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    const payload = (body.payload ?? body) as Record<string, any>;
    const normalizeId = (id: unknown) => String(id).replaceAll('_', '-');
    const profiles: SkillProfile[] = (payload.profiles ?? []).map((p: any) => ({ id: normalizeId(p.id), name: String(p.name), kind: p.kind, prompt: String(p.prompt ?? '') }));
    const defaultIds = Array.isArray(payload.default_profile_ids) ? payload.default_profile_ids.map(normalizeId) : [];
    // defaults 与领域解耦：优先 default_profile_ids 里真实存在的同 kind profile，否则回落该 kind 首个。
    const pickDefault = (kind: string) =>
      profiles.find(p => p.kind === kind && defaultIds.includes(p.id))?.id ?? profiles.find(p => p.kind === kind)?.id ?? '';
    const pkg: SkillPackage = {
      schema_version: 1, skill_id: String(body.skill_id ?? skillId), version: String(body.version ?? version),
      name: String(body.name ?? skillId), domain: (body.domain ?? 'desk_setup') as SkillPackage['domain'],
      summary: String(body.summary ?? ''), readiness: payload.availability === 'ready' ? 'ready' : 'testing',
      wizard_steps: (payload.wizard_steps ?? []).map((step: any) => String(step.name ?? step)),
      profiles,
      core_rules: payload.core_rules ?? [], defaults: {
        base: pickDefault('base'), style: pickDefault('style'), theme: pickDefault('theme'), platform: pickDefault('platform'),
      }, asset_roles: (payload.asset_roles ?? []).map((r: any) => String(r.id ?? r)), review_rubric: payload.review_rubric ?? [],
      negative_prompt: payload.default_negative_prompt ? String(payload.default_negative_prompt) : undefined,
    };
    localStorage.setItem(cacheKey, JSON.stringify(pkg));
    return pkg;
  } catch {
    const cached = localStorage.getItem(cacheKey);
    if (cached) { try { return JSON.parse(cached); } catch { /* fallback */ } }
    return BUILTIN_PACKAGE_FALLBACK[skillId] ?? BUILTIN_DESK_PACKAGE;
  }
}
