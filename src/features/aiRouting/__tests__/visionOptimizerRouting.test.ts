/**
 * optimizeVisionRecreation 路由行为测试（V4.1）：
 *  - 复刻 Prompt 优化实际调用 resolveModelForRole('vision_prompt_optimizer') 的模型
 *    （视觉页 GLM-5V-Turbo → 请求 model=glm-5v-turbo，绝不 deepseek-v4-flash）
 *  - 优化器模型具备视觉能力时，人物替换参考图以真实 image_url 进入 multimodal payload
 *    （纯文本模型只收结构化描述 —— 测试不能只断言文本包含路径）
 *  - 结果携带 optimizer provenance（modelId / source）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AIProviderModel, AIProviderProfile } from '../../aiProviders/types';

vi.mock('../../../services/api', () => ({
  api: {
    runAgentRequest: vi.fn(async (payload: any) => ({
      ok: true,
      reply: JSON.stringify({
        positive_prompt: '优化后的 Prompt',
        negative_prompt: '低画质',
        summary: '已按调整要求优化',
        changed_dimensions: ['pose'],
        dimension_values: { pose: '双手比心' },
      }),
      ...(payload || {}),
    })),
    readImageData: vi.fn(async () => 'data:image/png;base64,PERSON_IMAGE_BYTES'),
  },
}));

import { api } from '../../../services/api';
import { useAIProviderStore } from '../../aiProviders/store';
import { useAiModelRoutingStore } from '../modelRoutingPolicy';
import { optimizeVisionRecreation } from '../../../services/promptOptimizer';
import type { VisualRecreationPlan } from '../../vision/recreationPlan';

const runAgentRequestMock = api.runAgentRequest as ReturnType<typeof vi.fn>;
const readImageDataMock = api.readImageData as ReturnType<typeof vi.fn>;

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
  } as AIProviderModel;
}

function makeProfile(overrides: Partial<AIProviderProfile> & { id: string; models: AIProviderModel[] }): AIProviderProfile {
  return {
    name: '测试服务',
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
    created_at: '',
    updated_at: '',
    ...overrides,
  } as AIProviderProfile;
}

const plan: VisualRecreationPlan = {
  summary: '一名篮球运动员上篮',
  fields: [
    { key: 'subject', label: '人物 / 主体', value: '篮球运动员', locked: true, lockSource: 'default', originalValue: '篮球运动员' },
    { key: 'pose', label: '动作', value: '上篮', locked: false, originalValue: '上篮' },
  ],
};

const baseInput = {
  originalRecreationPrompt: '原始复刻 Prompt',
  structuredRecreationPlan: plan,
  userAdjustmentInstruction: '把动作改成比心',
};

beforeEach(() => {
  vi.clearAllMocks();
  useAIProviderStore.setState({
    profiles: [
      makeProfile({
        id: 'vp1',
        name: '智谱 GLM',
        category: 'vision',
        default_model_id: 'glm-5v-turbo',
        models: [makeModel('glm-5v-turbo', { display_name: 'GLM-5V-Turbo', capabilities: ['vision', 'text'] })],
      }),
      makeProfile({
        id: 'ap1',
        name: 'DeepSeek',
        provider_type: 'deepseek_official',
        default_model_id: 'deepseek-v4-flash',
        models: [makeModel('deepseek-v4-flash', { display_name: 'DeepSeek V4 Flash', capabilities: ['text'] })],
      }),
    ],
    selections: {},
    defaultProfileId: 'ap1',
    defaultVisionProfileId: 'vp1',
    migrated: true,
    hydrated: true,
  });
  useAiModelRoutingStore.setState({ config: {}, hydrated: true, lastUsed: {} });
});

describe('Bug 回归：视觉页 GLM-5V-Turbo → 优化请求 model=glm-5v-turbo', () => {
  it('请求携带 role/feature 与视觉模型', async () => {
    const outcome = await optimizeVisionRecreation({
      ...baseInput,
      visionPreferred: { profileId: 'vp1', modelId: 'glm-5v-turbo' },
    });
    expect(outcome.ok).toBe(true);
    const payload = runAgentRequestMock.mock.calls[0][0];
    expect(payload.model).toBe('glm-5v-turbo');
    expect(payload.model).not.toBe('deepseek-v4-flash');
    expect(payload.role).toBe('vision_prompt_optimizer');
    expect(payload.feature).toBe('vision-recreation');
    if (outcome.ok) {
      expect(outcome.result.optimizerModelId).toBe('glm-5v-turbo');
      expect(outcome.result.optimizerSource).toBe('follow');
    }
  });
});

describe('@图片：优化器是否真正拿到人物参考图内容', () => {
  it('多模态优化器：参考图以 image_url part 进入 payload（不是只有文本路径）', async () => {
    const outcome = await optimizeVisionRecreation({
      ...baseInput,
      visionPreferred: { profileId: 'vp1', modelId: 'glm-5v-turbo' },
      personReferencePath: 'D:/imgs/person.png',
    });
    expect(outcome.ok).toBe(true);
    const payload = runAgentRequestMock.mock.calls[0][0];
    const message = payload.messages[0];
    expect(message.parts).toBeTruthy();
    const imagePart = message.parts.find((part: any) => part.part_type === 'image_url');
    expect(imagePart?.image_url).toBe('data:image/png;base64,PERSON_IMAGE_BYTES');
    expect(readImageDataMock).toHaveBeenCalledWith('D:/imgs/person.png');
    if (outcome.ok) {
      expect(outcome.result.optimizerReceivedPersonImage).toBe(true);
    }
  });

  it('纯文本优化器（manual=DeepSeek）：只收结构化描述，不伪造图片上下文', async () => {
    useAiModelRoutingStore.getState().setEntry('vision_prompt_optimizer', {
      mode: 'manual',
      profileId: 'ap1',
      modelId: 'deepseek-v4-flash',
    });
    const outcome = await optimizeVisionRecreation({
      ...baseInput,
      visionPreferred: { profileId: 'vp1', modelId: 'glm-5v-turbo' },
      personReferencePath: 'D:/imgs/person.png',
    });
    expect(outcome.ok).toBe(true);
    const payload = runAgentRequestMock.mock.calls[0][0];
    const message = payload.messages[0];
    expect(typeof message.content).toBe('string');
    expect(message.parts).toBeUndefined();
    expect(readImageDataMock).not.toHaveBeenCalled();
    if (outcome.ok) {
      expect(outcome.result.optimizerReceivedPersonImage).toBe(false);
      expect(outcome.result.optimizerSource).toBe('manual');
    }
  });
});
