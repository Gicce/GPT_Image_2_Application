import { requestServerUrl } from '../../services/serverApi';
import { BUILTIN_CATALOG, BUILTIN_DESK_PACKAGE } from './builtinCatalog';
import type { SkillCatalogItem, SkillPackage } from './types';

const CATALOG_KEY = 'cy_skill_catalog_v1';
const PACKAGE_KEY = 'cy_skill_package_professional_desk_setup_1.0.0';

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
  try {
    const response = await fetch(`${requestServerUrl()}/api/skills/${skillId}/versions/${version}`);
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    const payload = (body.payload ?? body) as Record<string, any>;
    const normalizeId = (id: unknown) => String(id).replaceAll('_', '-').replace('theme-none', 'none');
    const defaultIds = Array.isArray(payload.default_profile_ids) ? payload.default_profile_ids.map(normalizeId) : [];
    const pkg: SkillPackage = {
      schema_version: 1, skill_id: String(body.skill_id ?? skillId), version: String(body.version ?? version),
      name: String(body.name ?? '专业桌搭'), domain: (body.domain ?? 'desk_setup') as SkillPackage['domain'],
      summary: String(body.summary ?? ''), readiness: payload.availability === 'ready' ? 'ready' : 'testing',
      wizard_steps: (payload.wizard_steps ?? []).map((step: any) => String(step.name ?? step)),
      profiles: (payload.profiles ?? []).map((p: any) => ({ id: normalizeId(p.id), name: String(p.name), kind: p.kind, prompt: String(p.prompt ?? '') })),
      core_rules: payload.core_rules ?? [], defaults: {
        base: String(defaultIds.find((id: string) => id.includes('walnut')) ?? 'business-walnut'),
        style: String(defaultIds.find((id: string) => id === 'business') ?? 'business'),
        theme: String(defaultIds.find((id: string) => id === 'none' || id === 'original-cute' || id === 'custom') ?? 'none'), platform: 'general',
      }, asset_roles: (payload.asset_roles ?? []).map((r: any) => String(r.id ?? r)), review_rubric: payload.review_rubric ?? [],
    };
    localStorage.setItem(PACKAGE_KEY, JSON.stringify(pkg));
    return pkg;
  } catch {
    const cached = localStorage.getItem(PACKAGE_KEY);
    if (cached) { try { return JSON.parse(cached); } catch { /* fallback */ } }
    return BUILTIN_DESK_PACKAGE;
  }
}
