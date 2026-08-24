/**
 * AI Model Routing 测试（V4.1）—— 锁定两条铁律：
 *  - 视觉页显示的模型 === 复刻 Prompt 优化实际执行的模型（Bug 回归）
 *  - 显式 fallback 必须带来源与原因；manual / follow / default / fallback 全链可解析
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useAIProviderStore } from '../../aiProviders/store';
import type { AIProviderModel, AIProviderProfile } from '../../aiProviders/types';
import { useAiModelRoutingStore, recommendedEntry } from '../modelRoutingPolicy';
import { resolveModelForRole, recordAiRoleUsage } from '../resolveModelForRole';
import { buildRolePickerGroups, modelSatisfiesRole } from '../roleModelFilter';
import { AI_MODEL_ROLES, getAiRoleDefinition } from '../modelRoles';

function makeModel(modelId: string, overrides: Partial<AIProviderModel> = {}): AIProviderModel {
  return {
    id: `row-${modelId}`,
    model_id: modelId,
    display_name: modelId,
    model_source: 'official_registry',
    enabled: true,
    supports_vision: (overrides.capabilities ?? ['text']).includes('vision'),
    capabilities: ['text'],
    lifecycle: 'active',
    test_status: 'available',
    ...overrides,
  };
}

function makeProfile(overrides: Partial<AIProviderProfile> & { id: string; models: AIProviderModel[] }): AIProviderProfile {
  return {
    name: overrides.name ?? '测试服务',
    provider_type: 'glm_official',
    base_url: 'https://api.test/v1',
    api_key: 'test-key',
    enabled: true,
    default_model_id: overrides.models[0]?.model_id ?? '',
    vision_model_id: '',
    system_prompt: '',
    context_window: 128000,
    fallback_token: '',
    avatar_data_url: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as AIProviderProfile;
}

const glmVision = makeModel('glm-5v-turbo', { display_name: 'GLM-5V-Turbo', capabilities: ['vision', 'text'] });
const glmVisionAlt = makeModel('glm-4.6v', { display_name: 'GLM-4.6V', capabilities: ['vision', 'text'] });
const deepseek = makeModel('deepseek-v4-flash', { display_name: 'DeepSeek V4 Flash', capabilities: ['text'] });

function installDefaultProfiles() {
  const visionProfile = makeProfile({
    id: 'vp1',
    name: '智谱 GLM',
    category: 'vision',
    default_model_id: 'glm-5v-turbo',
    models: [glmVision, glmVisionAlt],
  });
  const agentProfile = makeProfile({
    id: 'ap1',
    name: 'DeepSeek',
    provider_type: 'deepseek_official',
    default_model_id: 'deepseek-v4-flash',
    models: [deepseek],
  });
  useAIProviderStore.setState({
    profiles: [visionProfile, agentProfile],
    selections: {},
    defaultProfileId: 'ap1',
    defaultVisionProfileId: 'vp1',
    migrated: true,
    hydrated: true,
  });
  return { visionProfile, agentProfile };
}

beforeEach(() => {
  installDefaultProfiles();
  useAiModelRoutingStore.setState({ config: {}, hydrated: true, lastUsed: {} });
});

describe('Bug 回归：视觉页 GLM-5V-Turbo 时，复刻 Prompt 优化绝不能跑 deepseek-v4-flash', () => {
  it('follow 模式解析为视觉理解当前模型（source=follow）', () => {
    const outcome = resolveModelForRole('vision_prompt_optimizer', {
      visionPreferred: { profileId: 'vp1', modelId: 'glm-5v-turbo' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resolved.resolvedModelId).toBe('glm-5v-turbo');
    expect(outcome.resolved.source).toBe('follow');
    expect(outcome.resolved.followedRole).toBe('vision_analysis');
    expect(outcome.connection?.model).toBe('glm-5v-turbo');
    expect(outcome.connection?.token).toBe('test-key');
  });

  it('视觉模型切换后 optimizer 同步变化（无需重复配置）', () => {
    const a = resolveModelForRole('vision_prompt_optimizer', {
      visionPreferred: { profileId: 'vp1', modelId: 'glm-5v-turbo' },
    });
    expect(a.ok && a.resolved.resolvedModelId).toBe('glm-5v-turbo');
    const b = resolveModelForRole('vision_prompt_optimizer', {
      visionPreferred: { profileId: 'vp1', modelId: 'glm-4.6v' },
    });
    expect(b.ok && b.resolved.resolvedModelId).toBe('glm-4.6v');
  });
});

describe('manual 单独指定', () => {
  it('manual=DeepSeek 时优化实际使用 DeepSeek（source=manual）', () => {
    useAiModelRoutingStore.getState().setEntry('vision_prompt_optimizer', {
      mode: 'manual',
      profileId: 'ap1',
      modelId: 'deepseek-v4-flash',
    });
    const outcome = resolveModelForRole('vision_prompt_optimizer', {
      visionPreferred: { profileId: 'vp1', modelId: 'glm-5v-turbo' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resolved.resolvedModelId).toBe('deepseek-v4-flash');
    expect(outcome.resolved.source).toBe('manual');
  });

  it('manual 指向已删除模型时显式回退（source=fallback + 原因），绝不断链', () => {
    useAiModelRoutingStore.getState().setEntry('vision_prompt_optimizer', {
      mode: 'manual',
      profileId: 'ap1',
      modelId: 'gone-model',
    });
    const outcome = resolveModelForRole('vision_prompt_optimizer');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resolved.source).toBe('fallback');
    expect(outcome.resolved.requestedModelId).toBe('gone-model');
    expect(outcome.resolved.fallbackReason).toBeTruthy();
    expect(outcome.resolved.fallbackReason).toContain('不可用');
    // 回退目标 = 视觉理解模型（推荐链），而不是 agent 聊天默认
    expect(outcome.resolved.resolvedModelId).toBe('glm-5v-turbo');
  });
});

describe('显式 fallback（视觉模型不可用）', () => {
  it('视觉模型测试失败 → 回退提示词优化模型并携带原因', () => {
    useAIProviderStore.setState({
      profiles: [
        makeProfile({
          id: 'vp1',
          name: '智谱 GLM',
          category: 'vision',
          default_model_id: 'glm-5v-turbo',
          models: [makeModel('glm-5v-turbo', { capabilities: ['vision', 'text'], test_status: 'failed' })],
        }),
        makeProfile({
          id: 'ap1',
          name: 'DeepSeek',
          provider_type: 'deepseek_official',
          default_model_id: 'deepseek-v4-flash',
          models: [deepseek],
        }),
      ],
    });
    const outcome = resolveModelForRole('vision_prompt_optimizer', {
      visionPreferred: { profileId: 'vp1', modelId: 'glm-5v-turbo' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resolved.source).toBe('fallback');
    expect(outcome.resolved.resolvedModelId).toBe('deepseek-v4-flash');
    expect(outcome.resolved.fallbackReason).toBeTruthy();
  });

  it('完全无视觉档案 → 回退并解析成功', () => {
    useAIProviderStore.setState({
      profiles: [
        makeProfile({
          id: 'ap1',
          name: 'DeepSeek',
          provider_type: 'deepseek_official',
          default_model_id: 'deepseek-v4-flash',
          models: [deepseek],
        }),
      ],
      defaultVisionProfileId: '',
    });
    const outcome = resolveModelForRole('vision_prompt_optimizer');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resolved.source).toBe('fallback');
    expect(outcome.resolved.resolvedModelId).toBe('deepseek-v4-flash');
  });

  it('image_evaluation 不跨类别回退（文本模型看不了图，回退必坏）', () => {
    useAIProviderStore.setState({ profiles: [] });
    const outcome = resolveModelForRole('image_evaluation');
    expect(outcome.ok).toBe(false);
  });
});

describe('设置页映射：每个真实 role 可解析且字段完整', () => {
  it('所有 role 有 label / description，且解析结果非 undefined', () => {
    expect(AI_MODEL_ROLES.length).toBeGreaterThanOrEqual(8);
    for (const def of AI_MODEL_ROLES) {
      expect(def.label).toBeTruthy();
      expect(def.description).toBeTruthy();
      const outcome = resolveModelForRole(def.role);
      if (def.role === 'image_evaluation' || def.role === 'vision_analysis') {
        // 视觉档案存在 → 必须成功
        expect(outcome.ok).toBe(true);
      }
      if (outcome.ok) {
        expect(outcome.resolved.resolvedModelId).toBeTruthy();
        expect(outcome.resolved.displayName).toBeTruthy();
        expect(outcome.resolved.providerName).toBeTruthy();
        expect(['manual', 'follow', 'default', 'fallback']).toContain(outcome.resolved.source);
      } else {
        expect(typeof outcome.error).toBe('string');
        expect(outcome.error.length).toBeGreaterThan(0);
      }
    }
  });

  it('image_generation 为服务端固定模型（无 BYOK 连接）', () => {
    const outcome = resolveModelForRole('image_generation');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resolved.serverSide).toBe(true);
    expect(outcome.resolved.resolvedModelId).toBe('gpt-image-2');
    expect(outcome.connection).toBeNull();
  });

  it('assistant_chat / agent_planner 解析 agent 档案默认模型', () => {
    const chat = resolveModelForRole('assistant_chat');
    expect(chat.ok && chat.resolved.resolvedModelId).toBe('deepseek-v4-flash');
    const planner = resolveModelForRole('agent_planner');
    expect(planner.ok && planner.resolved.resolvedModelId).toBe('deepseek-v4-flash');
  });

  it('旧配置兼容：空 routing store 全部按推荐 follow 解析', () => {
    expect(Object.keys(useAiModelRoutingStore.getState().config)).toHaveLength(0);
    const outcome = resolveModelForRole('vision_prompt_optimizer');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resolved.source).toBe('follow');
    expect(outcome.resolved.followedRole).toBe('vision_analysis');
  });

  it('batch_planner 默认跟随 image_prompt_optimizer（与既有共用配置一致）', () => {
    const outcome = resolveModelForRole('batch_planner');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resolved.source).toBe('follow');
    expect(outcome.resolved.followedRole).toBe('image_prompt_optimizer');
    expect(outcome.resolved.resolvedModelId).toBe('deepseek-v4-flash');
  });

  it('推荐条目：vision_prompt_optimizer 跟随 vision_analysis', () => {
    expect(recommendedEntry('vision_prompt_optimizer')).toEqual({ mode: 'follow', followedRole: 'vision_analysis' });
  });
});

describe('ModelPicker 能力过滤', () => {
  it('vision role 不出现纯文本模型；image-only 模型不进 optimizer', () => {
    const profiles = useAIProviderStore.getState().profiles.map(profile =>
      profile.id === 'ap1'
        ? {
            ...profile,
            models: [
              deepseek,
              makeModel('image-only-model', { capabilities: ['image_generation'] }),
              makeModel('retired-model', { capabilities: ['text'], lifecycle: 'retired' }),
            ],
          }
        : profile,
    );
    const visionGroups = buildRolePickerGroups('vision_analysis', profiles);
    const visionModelIds = visionGroups.flatMap(g => g.models.map(m => m.model_id));
    expect(visionModelIds).toContain('glm-5v-turbo');
    expect(visionModelIds).toContain('glm-4.6v');
    expect(visionModelIds).not.toContain('deepseek-v4-flash');

    const optimizerGroups = buildRolePickerGroups('vision_prompt_optimizer', profiles);
    const optimizerModelIds = optimizerGroups.flatMap(g => g.models.map(m => m.model_id));
    expect(optimizerModelIds).toContain('deepseek-v4-flash');
    expect(optimizerModelIds).not.toContain('image-only-model');
    expect(optimizerModelIds).not.toContain('retired-model');
  });

  it('modelSatisfiesRole：image_evaluation 拒绝纯文本模型', () => {
    expect(modelSatisfiesRole('image_evaluation', deepseek)).toBe(false);
    expect(modelSatisfiesRole('image_evaluation', glmVision)).toBe(true);
  });
});

describe('最近使用记录（进程内）', () => {
  it('recordAiRoleUsage 写入 lastUsed，供设置页轻量展示', () => {
    const outcome = resolveModelForRole('image_prompt_optimizer');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) recordAiRoleUsage(outcome.resolved);
    const usage = useAiModelRoutingStore.getState().lastUsed.image_prompt_optimizer;
    expect(usage?.modelId).toBe('deepseek-v4-flash');
    expect(usage?.at).toBeTruthy();
  });
});

describe('role 目录完整性（禁止虚构功能）', () => {
  it('vision_prompt_optimizer 的修改意图识别在同一次调用（不单列 role）', () => {
    const def = getAiRoleDefinition('vision_prompt_optimizer');
    expect(def.description).toContain('修改意图');
    expect(AI_MODEL_ROLES.filter(r => r.role.startsWith('vision_intent'))).toHaveLength(0);
  });
});
