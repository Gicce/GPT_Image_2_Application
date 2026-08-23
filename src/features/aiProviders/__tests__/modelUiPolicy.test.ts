import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  MODEL_PICKER_PRIMARY_MAX,
  MODEL_PICKER_PRIMARY_MIN,
  getRecommendedModelIds,
  isModelHiddenFromPicker,
  splitModelsForPicker,
} from '../modelUiPolicy';
import type { AIProviderModel } from '../types';

/**
 * Model UI Policy 回归守卫（V4.0.9）。
 *
 * 历史问题：AI 智能体选择器把 24 个 GLM 模型（含 deprecated）全部平铺，
 * 认知成本极高。本测试锁定：默认只展示「当前选中 + 默认 + registry 推荐」
 * （不足 3 个补齐 / 上限 6 个），其余进「更多模型」；deprecated 不进常用区；
 * retired / missing / disabled / 非 chat 范围完全隐藏。
 */

function makeModel(overrides: Partial<AIProviderModel> & { model_id: string }): AIProviderModel {
  return {
    id: `row-${overrides.model_id}`,
    display_name: overrides.model_id,
    model_source: 'official_registry',
    enabled: true,
    supports_vision: false,
    capabilities: ['text'],
    lifecycle: 'active',
    test_status: 'untested',
    ...overrides,
  };
}

interface RegistryJson {
  models: Array<{ model_id: string; lifecycle?: string; recommended?: boolean }>;
}

function loadGlmRegistryModels(): AIProviderModel[] {
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, '../registry/glm.json'), 'utf-8'),
  ) as RegistryJson;
  return raw.models.map(entry => makeModel({
    model_id: entry.model_id,
    lifecycle: (entry.lifecycle || 'active') as AIProviderModel['lifecycle'],
  }));
}

describe('getRecommendedModelIds —— 推荐 id 来自 registry 数据', () => {
  test('GLM registry 返回数据侧策展的推荐模型（首个为旗舰 glm-5.3）', () => {
    const ids = getRecommendedModelIds('glm_official');
    expect(ids[0]).toBe('glm-5.3');
    expect(ids).toContain('glm-5-turbo');
    expect(ids).toContain('glm-4.7-flash');
    expect(ids).toContain('glm-5v-turbo');
    // 推荐保持精简（目标每 Provider 3~6 个常用模型）
    expect(ids.length).toBeGreaterThanOrEqual(MODEL_PICKER_PRIMARY_MIN - 1);
    expect(ids.length).toBeLessThanOrEqual(MODEL_PICKER_PRIMARY_MAX);
  });

  test('deprecated 模型不会被 registry 推荐计算接纳', () => {
    const ids = getRecommendedModelIds('glm_official');
    expect(ids).not.toContain('glm-4-flash'); // lifecycle deprecated
  });

  test('第三方 Provider 无 registry → 无推荐（回落补齐逻辑）', () => {
    expect(getRecommendedModelIds('openai_compatible')).toEqual([]);
  });
});

describe('isModelHiddenFromPicker —— 完全隐藏规则', () => {
  test('retired / missing / disabled / 非 chat 使用范围 → 隐藏', () => {
    expect(isModelHiddenFromPicker(makeModel({ model_id: 'a', lifecycle: 'retired' }))).toBe(true);
    expect(isModelHiddenFromPicker(makeModel({ model_id: 'a', lifecycle: 'missing' }))).toBe(true);
    expect(isModelHiddenFromPicker(makeModel({ model_id: 'a', enabled: false }))).toBe(true);
    expect(isModelHiddenFromPicker(makeModel({ model_id: 'a', use_scopes: { chat: false, planner: true, prompt_optimizer: true } }))).toBe(true);
  });

  test('active / deprecated 且启用 + chat 范围 → 不隐藏', () => {
    expect(isModelHiddenFromPicker(makeModel({ model_id: 'a' }))).toBe(false);
    expect(isModelHiddenFromPicker(makeModel({ model_id: 'a', lifecycle: 'deprecated' }))).toBe(false);
  });
});

describe('splitModelsForPicker —— 常用 / 更多分组', () => {
  test('GLM 全目录：默认列表明显缩短，其余进「更多模型」', () => {
    const models = loadGlmRegistryModels();
    expect(models.length).toBe(24);
    const { primary, secondary } = splitModelsForPicker(
      { provider_type: 'glm_official', default_model_id: 'glm-5.3', models },
    );
    expect(primary.length).toBeLessThanOrEqual(MODEL_PICKER_PRIMARY_MAX);
    expect(primary.map(m => m.model_id)).toEqual(['glm-5.3', 'glm-5-turbo', 'glm-4.7-flash', 'glm-5v-turbo']);
    // 其余 20 个模型（含 deprecated）仍可从「更多模型」访问，不丢失入口
    expect(secondary.length).toBe(models.length - primary.length);
  });

  test('deprecated 模型只出现在「更多模型」', () => {
    const models = loadGlmRegistryModels();
    const { primary, secondary } = splitModelsForPicker(
      { provider_type: 'glm_official', default_model_id: 'glm-5.3', models },
    );
    expect(primary.some(m => m.lifecycle === 'deprecated')).toBe(false);
    const deprecatedIds = secondary.filter(m => m.lifecycle === 'deprecated').map(m => m.model_id);
    expect(deprecatedIds).toEqual(expect.arrayContaining(['glm-4-flash', 'glm-4v', 'glm-4v-plus']));
  });

  test('disabled / retired / missing 模型完全不出现', () => {
    const models = [
      makeModel({ model_id: 'ok-1' }),
      makeModel({ model_id: 'off', enabled: false }),
      makeModel({ model_id: 'gone', lifecycle: 'retired' }),
      makeModel({ model_id: 'lost', lifecycle: 'missing' }),
    ];
    const { primary, secondary } = splitModelsForPicker(
      { provider_type: 'glm_official', default_model_id: 'ok-1', models },
    );
    const allIds = [...primary, ...secondary].map(m => m.model_id);
    expect(allIds).toEqual(['ok-1']);
  });

  test('当前会话选中项永远置顶常用区（即使它不在推荐列表）', () => {
    const models = loadGlmRegistryModels();
    const { primary } = splitModelsForPicker(
      { provider_type: 'glm_official', default_model_id: 'glm-5.3', models },
      'glm-4.5-air',
    );
    expect(primary[0]?.model_id).toBe('glm-4.5-air');
    expect(primary.map(m => m.model_id)).toContain('glm-5.3');
    expect(primary.length).toBeLessThanOrEqual(MODEL_PICKER_PRIMARY_MAX);
  });

  test('推荐不足 MIN 个时按「测试通过优先 → 目录顺序」补齐', () => {
    const models = [
      makeModel({ model_id: 'm-a', test_status: 'untested' }),
      makeModel({ model_id: 'm-b', test_status: 'available' }),
      makeModel({ model_id: 'm-c', test_status: 'untested' }),
      makeModel({ model_id: 'm-d', test_status: 'untested' }),
    ];
    const { primary } = splitModelsForPicker(
      { provider_type: 'openai_compatible', default_model_id: 'm-a', models },
    );
    // 种子 = 默认 m-a；补齐到 MIN=3：available 的 m-b 优先，再按目录顺序
    expect(primary.map(m => m.model_id)).toEqual(['m-a', 'm-b', 'm-c']);
  });

  test('任意目录常用区永不超上限', () => {
    const models = Array.from({ length: 10 }, (_, i) => makeModel({ model_id: `m-${i}`, test_status: 'available' }));
    const { primary } = splitModelsForPicker(
      { provider_type: 'openai_compatible', default_model_id: 'm-0', models },
    );
    expect(primary.length).toBeLessThanOrEqual(MODEL_PICKER_PRIMARY_MAX);
  });

  test('DeepSeek 官方目录：2 个模型全部保留（不过度裁剪）', () => {
    const models = [
      makeModel({ model_id: 'deepseek-chat' }),
      makeModel({ model_id: 'deepseek-reasoner' }),
    ];
    const { primary, secondary } = splitModelsForPicker(
      { provider_type: 'deepseek_official', default_model_id: 'deepseek-chat', models },
    );
    expect(primary.map(m => m.model_id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(secondary).toHaveLength(0);
  });
});
