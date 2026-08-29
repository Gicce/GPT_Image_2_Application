export type SkillDomain = 'desk_setup' | 'ecommerce' | 'product' | 'brand_ad' | 'interior' | 'sports' | 'ui';
export type AssetRole = 'brand_logo' | 'product' | 'person' | 'space' | 'device' | 'background_reference' | 'style_reference';

export interface SkillProfile { id: string; name: string; kind: 'base' | 'style' | 'theme' | 'platform'; prompt: string; }
export interface SkillCatalogItem { skill_id: string; version: string; name: string; domain: SkillDomain; summary: string; readiness: 'ready' | 'testing'; }
export interface SkillPackage {
  schema_version: number; skill_id: string; version: string; name: string; domain: SkillDomain;
  summary: string; readiness: 'ready' | 'testing'; wizard_steps: string[]; profiles: SkillProfile[];
  core_rules: string[]; defaults: Record<string, string>; asset_roles: AssetRole[]; review_rubric: string[];
  /** 服务端可选键：领域默认负面词基线（desk 无此键时沿用客户端内置桌搭默认）。 */
  negative_prompt?: string;
}
export interface BrandCard {
  assetId: string; fingerprint: string; sourcePath: string; analyzedAt: string; model: string;
  structure: string; visibleText: string; aspectRatio: string; colors: string[];
  backgroundCompatibility: string[]; safeArea: string; prohibitedTransformations: string[];
  confidence: number; uncertainties: string[]; confirmed: boolean; userNotes: string;
}
export interface SkillAsset { id: string; role: AssetRole; path: string; name: string; fingerprint: string; brandCard?: BrandCard; }
export interface SkillProject {
  schemaVersion: 1; id: string; name: string; skillId: string; skillVersion: string; revision: number;
  status: 'draft' | 'generated'; mode: 'guided' | 'professional'; purpose: string; audience: string;
  styleId: string; themeId: string; platformId: string; userOverrides: string; negativePrompt: string;
  assets: SkillAsset[]; output: { size: string; quality: string; format: string; count: number; directory: string };
  compiledPrompt: string; lastTaskId?: string; createdAt: string; updatedAt: string;
  sync: { accountId?: string; remoteVersion?: number; conflict?: boolean };
}
export interface PromptCompileResult { prompt: string; blockers: string[]; sections: { label: string; text: string }[]; }
