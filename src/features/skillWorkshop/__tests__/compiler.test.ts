import { describe, expect, it } from 'vitest';
import { BUILTIN_DESK_PACKAGE } from '../builtinCatalog';
import { compileSkillPrompt } from '../compiler';
import type { SkillProject } from '../types';

function project(overrides: Partial<SkillProject> = {}): SkillProject {
  return {
    schemaVersion: 1, id: 'p1', name: 'desk', skillId: 'professional_desk_setup', skillVersion: '1.0.0', revision: 0,
    status: 'draft', mode: 'guided', purpose: '高级少女风专业桌搭', audience: '', styleId: 'cute', themeId: 'none', platformId: 'general',
    userOverrides: '雾粉色只占15%', negativePrompt: '', assets: [],
    output: { size: '1536x1024', quality: 'high', format: 'png', count: 1, directory: 'D:/out' },
    compiledPrompt: '', createdAt: '', updatedAt: '', sync: {}, ...overrides,
  };
}

describe('compileSkillPrompt', () => {
  it('is deterministic and preserves contract order', () => {
    const a = compileSkillPrompt(BUILTIN_DESK_PACKAGE, project());
    const b = compileSkillPrompt(BUILTIN_DESK_PACKAGE, project());
    expect(a.prompt).toBe(b.prompt);
    expect(a.prompt.indexOf('领域硬规则')).toBeLessThan(a.prompt.indexOf('用户本次要求'));
    expect(a.prompt.indexOf('用户本次要求')).toBeLessThan(a.prompt.indexOf('风格与主题'));
  });

  it('blocks unconfirmed logo and custom theme without assets', () => {
    const unconfirmed = project({ assets: [{ id: 'a1', role: 'brand_logo', path: 'logo.png', name: 'logo.png', fingerprint: 'x' }] });
    expect(compileSkillPrompt(BUILTIN_DESK_PACKAGE, unconfirmed).blockers[0]).toContain('Logo');
    expect(compileSkillPrompt(BUILTIN_DESK_PACKAGE, project({ themeId: 'custom' })).blockers[0]).toContain('自定义');
  });

  it('compiles confirmed brand rules before core rules', () => {
    const p = project({ assets: [{
      id: 'a1', role: 'brand_logo', path: 'logo.png', name: 'logo.png', fingerprint: 'x',
      brandCard: { assetId: 'a1', fingerprint: 'x', sourcePath: 'logo.png', analyzedAt: '', model: 'vision', structure: '圆形图标', visibleText: 'CY', aspectRatio: '1:1', colors: ['蓝色'], backgroundCompatibility: ['白色'], safeArea: '10%', prohibitedTransformations: ['拉伸'], confidence: .9, uncertainties: [], confirmed: true, userNotes: '保留原色' },
    }] });
    const result = compileSkillPrompt(BUILTIN_DESK_PACKAGE, p);
    expect(result.blockers).toEqual([]);
    expect(result.prompt).toContain('使用附件原始 Logo');
    expect(result.prompt.indexOf('已确认素材卡')).toBeLessThan(result.prompt.indexOf('领域硬规则'));
  });
});
