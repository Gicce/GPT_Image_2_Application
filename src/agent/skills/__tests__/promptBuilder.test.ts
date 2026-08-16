import { describe, expect, it } from 'vitest';
import { buildSkillSystemPrompt } from '../promptBuilder';
import { BASE_AGENT_PROMPT } from '../basePrompt';
import { upgradePersistedProfile } from '../../../features/aiProviders/migration';
import { defaultUseScopes } from '../../../features/aiProviders/types';

describe('buildSkillSystemPrompt 统一基础规则（V3.0.6：类型体系已删除）', () => {
  const base = { skillId: 'general_chat' as never, userText: '你好' };

  it('所有模型服务共用同一基础规则，无对话助手分支', () => {
    const prompt = buildSkillSystemPrompt(base);
    expect(prompt.startsWith(BASE_AGENT_PROMPT)).toBe(true);
  });

  it('历史摘要进入 system 上下文段落，而不是 assistant 消息', () => {
    const prompt = buildSkillSystemPrompt({ ...base, contextSummary: '用户之前讨论了泰山日出' });
    expect(prompt).toContain('--- 对话历史摘要');
    expect(prompt).toContain('用户之前讨论了泰山日出');
  });

  it('用户自定义 System Prompt 只作为偏好补充，位于核心规则之后', () => {
    const prompt = buildSkillSystemPrompt({ ...base, userCustomPrompt: '你是一名医生' });
    expect(prompt.indexOf(BASE_AGENT_PROMPT)).toBeLessThan(prompt.indexOf('--- 用户偏好补充'));
    expect(prompt).toContain('你是一名医生');
  });

  it('语言规则：包含"使用用户当前使用的语言"', () => {
    expect(buildSkillSystemPrompt({ ...base })).toContain('使用用户当前使用的语言');
  });
});

describe('upgradePersistedProfile use_scopes 迁移', () => {
  const baseProfile = {
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_key: 'sk-test',
    enabled: true,
    vision_model_id: '',
    system_prompt: '',
    context_window: 32768,
    fallback_token: '',
    avatar_data_url: '',
    models: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };

  it('旧数据（无 use_scopes / agent_type）默认全量使用范围，绝不按名称猜测', () => {
    const legacy = upgradePersistedProfile({
      ...baseProfile,
      id: 'p1',
      name: '智谱健康助手', // 名称带"助手"也必须保持全量范围
      provider_type: 'glm_official',
      default_model_id: 'glm-5.3',
    } as never);
    expect(legacy.use_scopes).toEqual(defaultUseScopes());
  });

  it('旧 conversation 类型映射为 planner 关闭（保留用户意图），其余范围开启', () => {
    const profile = upgradePersistedProfile({
      ...baseProfile,
      id: 'p2',
      name: '健康助手',
      provider_type: 'deepseek_official',
      base_url: 'https://api.deepseek.com/v1',
      agent_type: 'conversation',
      default_model_id: 'deepseek-chat',
    } as never);
    expect(profile.use_scopes).toEqual({ chat: true, planner: false, prompt_optimizer: true });
  });

  it('已有 use_scopes 的数据保持不变（幂等）', () => {
    const profile = upgradePersistedProfile({
      ...baseProfile,
      id: 'p3',
      name: 'GLM',
      provider_type: 'glm_official',
      default_model_id: 'glm-5.3',
      use_scopes: { chat: true, planner: true, prompt_optimizer: false },
    } as never);
    expect(profile.use_scopes).toEqual({ chat: true, planner: true, prompt_optimizer: false });
  });
});
