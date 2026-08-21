import { describe, it, expect } from 'vitest';
import {
  describeModelUsability,
  isModelUsable,
  isModelAvailableForVision,
  getAvailableVisionModels,
  resolveModelSelectionOrFirst,
  invalidateModelTestStatus,
} from '../modelUsability';
import { capabilityOptionSuffix, capabilityBadgeSummaries } from '../../../components/ModelCapabilityBadges';
import type { AIProviderModel, AIProviderProfile } from '../types';
import glmRegistry from '../registry/glm.json';

function makeModel(overrides: Partial<AIProviderModel> = {}): AIProviderModel {
  return {
    id: 'row-1',
    model_id: 'test-vision',
    display_name: 'Test Vision',
    model_source: 'official_registry',
    enabled: true,
    supports_vision: true,
    capabilities: ['text', 'vision'],
    lifecycle: 'active',
    test_status: 'available',
    ...overrides,
  };
}

function makeProfile(overrides: {
  id?: string;
  enabled?: boolean;
  category?: 'agent' | 'vision';
  models?: AIProviderModel[];
} = {}): AIProviderProfile {
  return {
    id: overrides.id ?? 'profile-1',
    name: '视觉服务',
    provider_type: 'glm_official',
    category: overrides.category ?? 'vision',
    base_url: 'https://example.com/v4',
    api_key: 'sk-test',
    enabled: overrides.enabled ?? true,
    default_model_id: 'test-vision',
    vision_model_id: '',
    system_prompt: '',
    context_window: 128000,
    fallback_token: '',
    avatar_data_url: '',
    models: overrides.models ?? [makeModel()],
    created_at: '',
    updated_at: '',
  } as AIProviderProfile;
}

describe('模型可用性状态判定（模型中心是唯一事实源）', () => {
  it('已删除/下线模型：retired 与 missing 均判 removed，不进业务页面', () => {
    expect(describeModelUsability(makeProfile(), makeModel({ lifecycle: 'retired' }))).toBe('removed');
    expect(describeModelUsability(makeProfile(), makeModel({ lifecycle: 'missing' }))).toBe('removed');
    expect(isModelUsable(makeProfile(), makeModel({ lifecycle: 'retired' }))).toBe(false);
  });

  it('已禁用：档案禁用或模型禁用均判 disabled', () => {
    expect(describeModelUsability(makeProfile({ enabled: false }), makeModel())).toBe('disabled');
    expect(describeModelUsability(makeProfile(), makeModel({ enabled: false }))).toBe('disabled');
  });

  it('测试失败（含 429 限流暂时异常）判 failed：模型保留在模型管理，可重测恢复', () => {
    const model = makeModel({ test_status: 'failed', last_error_status: 429 });
    expect(describeModelUsability(makeProfile(), model)).toBe('failed');
    expect(isModelUsable(makeProfile(), model)).toBe(false);
  });

  it('待测试（untested）与检测中（testing）均不进业务页面', () => {
    expect(describeModelUsability(makeProfile(), makeModel({ test_status: 'untested' }))).toBe('untested');
    expect(describeModelUsability(makeProfile(), makeModel({ test_status: 'testing' }))).toBe('testing');
  });

  it('可用 = 测试通过 + 启用链完整', () => {
    expect(describeModelUsability(makeProfile(), makeModel())).toBe('available');
    expect(isModelUsable(makeProfile(), makeModel())).toBe(true);
  });

  it('deprecated（即将弃用）仍可用，不影响准入', () => {
    expect(isModelUsable(makeProfile(), makeModel({ lifecycle: 'deprecated' }))).toBe(true);
  });
});

describe('视觉准入（测试通过 ≠ 适用于视觉业务，两个维度分离）', () => {
  it('测试通过且 capabilities 含 vision → 进入视觉模型列表', () => {
    expect(isModelAvailableForVision(makeProfile(), makeModel())).toBe(true);
  });

  it('测试通过但无视觉能力（纯文本模型）→ 不进视觉页面', () => {
    const textModel = makeModel({ capabilities: ['text', 'reasoning', 'tools'] });
    expect(isModelUsable(makeProfile(), textModel)).toBe(true);
    expect(isModelAvailableForVision(makeProfile(), textModel)).toBe(false);
  });

  it('能力未声明（unknown / 空）保守处理：不进视觉页面', () => {
    expect(isModelAvailableForVision(makeProfile(), makeModel({ capabilities: ['unknown'] }))).toBe(false);
    expect(isModelAvailableForVision(makeProfile(), makeModel({ capabilities: [] }))).toBe(false);
  });

  it('支持视频理解（video_vision）但无 vision 的模型仍不进图片视觉页面', () => {
    expect(isModelAvailableForVision(makeProfile(), makeModel({ capabilities: ['text', 'video_vision'] }))).toBe(false);
  });
});

describe('getAvailableVisionModels（视觉页面下拉列表唯一来源）', () => {
  const visionModel = makeModel({ id: 'r1', model_id: 'glm-vision', test_status: 'available' });
  const failedVisionModel = makeModel({ id: 'r2', model_id: 'glm-vision-bad', test_status: 'failed' });
  const untestedVisionModel = makeModel({ id: 'r3', model_id: 'glm-vision-new', test_status: 'untested' });
  const disabledVisionModel = makeModel({ id: 'r4', model_id: 'glm-vision-off', enabled: false });
  const retiredVisionModel = makeModel({ id: 'r5', model_id: 'glm-vision-old', lifecycle: 'retired' });
  const textOnlyModel = makeModel({ id: 'r6', model_id: 'glm-text', capabilities: ['text'], test_status: 'available' });

  it('只输出「可用 + 图片视觉」模型：失败/未测试/禁用/下线/非视觉/agent 档案全部排除', () => {
    const profiles = [
      makeProfile({
        id: 'vision-profile',
        models: [visionModel, failedVisionModel, untestedVisionModel, disabledVisionModel, retiredVisionModel, textOnlyModel],
      }),
      makeProfile({ id: 'disabled-profile', enabled: false, models: [makeModel({ id: 'r7', model_id: 'glm-vision-2' })] }),
      makeProfile({ id: 'agent-profile', category: 'agent', models: [makeModel({ id: 'r8', model_id: 'glm-chat' })] }),
    ];
    const options = getAvailableVisionModels(profiles);
    expect(options.map(o => o.modelId)).toEqual(['glm-vision']);
    expect(options[0].profileId).toBe('vision-profile');
    expect(options[0].displayName).toBe('Test Vision');
  });

  it('跨多个 vision 档案按档案顺序汇总', () => {
    const profiles = [
      makeProfile({ id: 'p-a', models: [makeModel({ id: 'a1', model_id: 'va' })] }),
      makeProfile({ id: 'p-b', models: [makeModel({ id: 'b1', model_id: 'vb' })] }),
    ];
    expect(getAvailableVisionModels(profiles).map(o => `${o.profileId}/${o.modelId}`)).toEqual(['p-a/va', 'p-b/vb']);
  });
});

describe('resolveModelSelectionOrFirst（恢复已保存模型选择）', () => {
  const options = [
    { profileId: 'p1', modelId: 'm1' },
    { profileId: 'p2', modelId: 'm2' },
  ];

  it('原选择仍可用 → 保留', () => {
    expect(resolveModelSelectionOrFirst({ profileId: 'p2', modelId: 'm2' }, options))
      .toEqual({ profileId: 'p2', modelId: 'm2' });
  });

  it('原选择失效（删除/禁用/测试失败）→ 回落列表第一个，绝不恢复失效 ID', () => {
    expect(resolveModelSelectionOrFirst({ profileId: 'p9', modelId: 'm9' }, options))
      .toEqual({ profileId: 'p1', modelId: 'm1' });
  });

  it('无任何可用模型 → 置空（禁止硬编码 fallback）', () => {
    expect(resolveModelSelectionOrFirst({ profileId: 'p1', modelId: 'm1' }, []))
      .toEqual({ profileId: '', modelId: '' });
  });
});

describe('invalidateModelTestStatus（连接配置变更 → 测试状态失效）', () => {
  it('Key / Base URL 变更路径：全目录复位 untested 并清除错误现场', () => {
    const models = [
      makeModel({ id: 'a', test_status: 'available' }),
      makeModel({ id: 'b', test_status: 'failed', last_error_code: 'rate_limited', last_error_message: 'HTTP 429', last_error_status: 429 }),
    ];
    const next = invalidateModelTestStatus(models);
    expect(next.every(m => m.test_status === 'untested')).toBe(true);
    expect(next[1].last_error_code).toBeUndefined();
    expect(next[1].last_error_status).toBeUndefined();
  });

  it('指定 rowId 只失效单个模型（custom 模型改 model_id 路径）', () => {
    const models = [
      makeModel({ id: 'a', test_status: 'available' }),
      makeModel({ id: 'b', test_status: 'available' }),
    ];
    const next = invalidateModelTestStatus(models, 'b');
    expect(next[0].test_status).toBe('available');
    expect(next[1].test_status).toBe('untested');
  });
});

describe('GLM 视觉模型能力（Registry 数据，禁止按名称猜测）', () => {
  const glmModels = glmRegistry.models as Array<{ model_id: string; capabilities: string[] }>;

  it('GLM-5V-Turbo：图片视觉 + 视频视觉 + 思考（reasoning）齐备', () => {
    const turbo = glmModels.find(m => m.model_id === 'glm-5v-turbo')!;
    expect(turbo.capabilities).toContain('vision');
    expect(turbo.capabilities).toContain('video_vision');
    expect(turbo.capabilities).toContain('reasoning');
  });

  it('GLM-4.6V 同样声明视频理解；GLM-4V-Flash 仅图片（不虚标视频）', () => {
    const v46 = glmModels.find(m => m.model_id === 'glm-4.6v')!;
    expect(v46.capabilities).toContain('video_vision');
    const flash = glmModels.find(m => m.model_id === 'glm-4v-flash')!;
    expect(flash.capabilities).toContain('vision');
    expect(flash.capabilities).not.toContain('video_vision');
  });

  it('能力徽章派生：GLM-5V-Turbo 选项后缀含 图片/视频/思考（用户无需按名称猜能力）', () => {
    const turbo = glmModels.find(m => m.model_id === 'glm-5v-turbo')!;
    const suffix = capabilityOptionSuffix(turbo.capabilities as never);
    expect(suffix).toContain('图片');
    expect(suffix).toContain('视频');
    expect(suffix).toContain('思考');

    const summaries = capabilityBadgeSummaries(turbo.capabilities as never);
    expect(summaries.find(s => s.capability === 'vision')?.full).toBe('支持图片理解');
    expect(summaries.find(s => s.capability === 'video_vision')?.full).toBe('支持视频理解');
    expect(summaries.find(s => s.capability === 'reasoning')?.full).toBe('支持思考模式');
  });

  it('纯文本模型不产生视觉徽章；未声明能力折叠为「能力未知」', () => {
    expect(capabilityOptionSuffix(['text', 'reasoning'])).not.toContain('图片');
    expect(capabilityBadgeSummaries(['unknown']).map(s => s.short)).toEqual(['能力未知']);
    expect(capabilityBadgeSummaries([]).map(s => s.short)).toEqual(['能力未知']);
  });
});
