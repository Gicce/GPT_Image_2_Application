/**
 * ADR-028 目录多方向：ui_concept 1.0.0 做实后的 catalog 服务契约——
 * 包缓存键按 skill+version 分离、defaults 解析与领域解耦、negative_prompt 映射、离线回退。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { BUILTIN_CATALOG, BUILTIN_DESK_PACKAGE, BUILTIN_UI_PACKAGE } from '../builtinCatalog';
import { loadSkillPackage } from '../catalogService';

const UI_SERVER_BODY = {
  skill_id: 'ui_concept', version: '1.0.0', name: 'UI 概念设计', domain: 'ui',
  summary: 'Web、移动端与桌面端界面概念', payload: {
    availability: 'ready',
    default_profile_ids: ['modern_product', 'minimal', 'theme_none', 'desktop_web'],
    wizard_steps: [{ id: 'template', name: '选择模板' }],
    profiles: [
      { id: 'modern_product', kind: 'base', name: '现代产品界面', prompt: '浅色干净基线' },
      { id: 'minimal', kind: 'style', name: '极简', prompt: '留白' },
      { id: 'dark_pro', kind: 'style', name: '暗色专业', prompt: '暗色' },
      { id: 'theme_none', kind: 'theme', name: '无主题', prompt: '无 IP' },
      { id: 'custom', kind: 'theme', name: '自定义素材主题', prompt: '用户素材' },
      { id: 'desktop_web', kind: 'platform', name: '桌面 Web', prompt: '宽幅' },
    ],
    asset_roles: [{ id: 'brand_logo' }, { id: 'style_reference' }],
    core_rules: ['8pt 栅格'],
    review_rubric: ['信息层级'],
    default_negative_prompt: '透视变形，乱码文字',
  },
};

function installStorage() {
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, String(value)),
    removeItem: (key: string) => void memory.delete(key),
  });
  return memory;
}

describe('catalogService 多方向契约（ADR-028）', () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = installStorage();
    // 打开 requestServerUrl 的 settingsLoaded gate，fetch 路径才会真正执行
    useSettingsStore.setState({ settingsLoaded: true } as any);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('内置目录：ui 方向命名为「UI 概念设计」且 ready', () => {
    const ui = BUILTIN_CATALOG.find(item => item.domain === 'ui');
    expect(ui).toMatchObject({ skill_id: 'ui_concept', version: '1.0.0', name: 'UI 概念设计', readiness: 'ready' });
  });

  it('loadSkillPackage：defaults 按 default_profile_ids 实际存在者解析，id 归一为 kebab-case，映射 negative_prompt', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => UI_SERVER_BODY })));
    const pkg = await loadSkillPackage('ui_concept', '1.0.0');
    expect(pkg.skill_id).toBe('ui_concept');
    expect(pkg.defaults).toEqual({ base: 'modern-product', style: 'minimal', theme: 'theme-none', platform: 'desktop-web' });
    expect(pkg.negative_prompt).toBe('透视变形，乱码文字');
    expect(storage.has('cy_skill_package_ui_concept_1.0.0')).toBe(true);
    expect(storage.has('cy_skill_package_professional_desk_setup_1.0.0')).toBe(false);
  });

  it('loadSkillPackage：default_profile_ids 缺失或不存在时回落该 kind 首个 profile', async () => {
    const body = { ...UI_SERVER_BODY, payload: { ...UI_SERVER_BODY.payload, default_profile_ids: ['not_exist'] } };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => body })));
    const pkg = await loadSkillPackage('ui_concept', '1.0.0');
    expect(pkg.defaults.style).toBe('minimal');
    expect(pkg.defaults.theme).toBe('theme-none');
  });

  it('离线回退：ui_concept 回落内置 UI 包，未知 skill 回落桌搭', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await loadSkillPackage('ui_concept', '1.0.0')).toBe(BUILTIN_UI_PACKAGE);
    expect(await loadSkillPackage('other_skill', '0.1.0')).toBe(BUILTIN_DESK_PACKAGE);
  });
});
