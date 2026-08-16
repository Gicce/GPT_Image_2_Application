// 静态 smoke 测试 -- node scripts/settings-migration.smoke.mjs
//
// 验证旧单智能体配置（settings.agent_* / chat_*）-> 多 AIProviderProfile 迁移：
//   1. 完整旧配置 -> OPENAI_COMPATIBLE profile（packyapi 场景）
//   2. 旧 model 成为 CUSTOM 模型且 enabled
//   3. vision model / system prompt / context window 正确迁移
//   4. 空配置 -> 不迁移（不制造空 Profile，更不恢复内置 GPT Agent）
//   5. 幂等：由调用方 marker 保证；本测试验证迁移函数本身可重复执行产出一致形状
//   6. 官方 Base URL（deepseek/glm）-> 对应官方 provider_type，模型来自 Catalog

import assert from 'node:assert/strict';
import { loadTs } from './_ts_loader.mjs';

const migration = await loadTs('../src/features/aiProviders/migration.ts');
const { migrateLegacyAgentSettings, createEmptyProfile, normalizeBaseUrl, validateCustomModelId } = migration;

const registryMod = await loadTs('../src/features/aiProviders/registry/registry.ts');
const { officialBaseUrl, getBuiltInRegistry, isOfficialProvider } = registryMod;

// ============ 一、服务器 Agent 旧配置禁止迁移（BYOK 架构）============

{
  // Runtime 场景：CyImage Agent + packyapi 服务器地址 + 服务器下发 token + gpt-5.6-luna。
  // 这是服务器账户计费模型链路，不得迁移成用户 Profile（否则服务器 Agent 模型
  // 会经迁移混入 BYOK 模型选择器）。用户应自行重新配置 Provider。
  const legacy = {
    agent_name: 'CyImage Agent',
    agent_token: 'sk-server-issued-token',
    chat_token: 'sk-fallback-token',
    agent_model: 'gpt-5.6-luna',
    agent_base_url: 'https://www.packyapi.com/v1',
    agent_system_prompt: '你是专业电商设计助手',
    agent_context_window: 65536,
    vision_model: 'qwen-vision-x',
    ai_avatar_data_url: 'data:image/png;base64,xxx',
  };
  assert.equal(migrateLegacyAgentSettings(legacy), null, '服务器默认地址的旧配置不得迁移');
  assert.equal(migrateLegacyAgentSettings({ ...legacy, agent_base_url: '' }), null, '空地址（服务器链路默认值）同样不迁移');

  // 用户自己的第三方 Provider（自定义 Base URL + 自有 Key）必须正常迁移
  const own = migrateLegacyAgentSettings({
    ...legacy,
    agent_base_url: 'https://my-proxy.example.com/v1',
  });
  assert.ok(own, '自定义 Base URL 的旧配置必须迁移出 profile');
  assert.equal(own.provider_type, 'openai_compatible');
  assert.equal(own.base_url, 'https://my-proxy.example.com/v1');
  assert.equal(own.api_key, 'sk-server-issued-token');
  assert.equal(own.system_prompt, '你是专业电商设计助手');
  assert.equal(own.context_window, 65536);
  const model = own.models.find(m => m.model_id === 'gpt-5.6-luna');
  assert.ok(model, '旧 agent_model 必须成为 profile 的模型');
  assert.equal(model.model_source, 'custom');
  assert.equal(model.enabled, true);
  assert.equal(own.default_model_id, 'gpt-5.6-luna');
  assert.equal(own.fallback_token, 'sk-fallback-token');

  console.log('✓ 服务器 Agent 旧配置不迁移；用户自有第三方 Provider 正常迁移');
}

// ============ 二、空配置不迁移、绝不制造内置 GPT Agent ============

{
  const empty = migrateLegacyAgentSettings({ agent_name: '', agent_token: '', agent_model: '', agent_base_url: '' });
  assert.equal(empty, null, '全空配置不得迁移出 profile');

  const fresh = createEmptyProfile('openai_compatible');
  assert.equal(fresh.models.length, 0, '第三方新 profile 不应内置任何模型');
  console.log('✓ 空配置不迁移；新 profile 不内置 GPT 模型');
}

// ============ 三、官方 Base URL 识别 ============

{
  const deepseek = migrateLegacyAgentSettings({
    agent_base_url: 'https://api.deepseek.com/v1',
    agent_token: 'sk-ds',
    agent_model: 'deepseek-chat',
  });
  assert.equal(deepseek.provider_type, 'deepseek_official');
  assert.equal(deepseek.base_url, officialBaseUrl('deepseek_official'));
  assert.equal(deepseek.default_model_id, 'deepseek-chat');

  // 旧 model 不在官方 Registry -> 以 legacy 身份保留，默认模型绝不静默切换
  const glmUnknown = migrateLegacyAgentSettings({
    agent_base_url: 'https://open.bigmodel.cn/api/paas/v4',
    agent_token: 'sk-glm',
    agent_model: 'glm-legacy-old',
  });
  assert.equal(glmUnknown.provider_type, 'glm_official');
  assert.equal(glmUnknown.default_model_id, 'glm-legacy-old', '旧默认模型必须保留，不静默替换');
  const legacyModel = glmUnknown.models.find(m => m.model_id === 'glm-legacy-old');
  assert.ok(legacyModel, '未确认的旧模型必须保留（source=legacy）');
  assert.equal(legacyModel.model_source, 'legacy');
  console.log('✓ 官方 Base URL 正确识别；未确认旧模型保留为 legacy，默认模型不被切换');
}

// ============ 四、幂等形状：同一输入迁移两次，关键字段一致 ============

{
  const legacy = { agent_base_url: 'https://my-proxy.example.com/v1', agent_model: 'gpt-5.6-luna', agent_token: 't' };
  const a = migrateLegacyAgentSettings(legacy);
  const b = migrateLegacyAgentSettings(legacy);
  assert.equal(a.provider_type, b.provider_type);
  assert.equal(a.base_url, b.base_url);
  assert.equal(a.models[0].model_id, b.models[0].model_id);
  assert.notEqual(a.id, b.id, 'id 各自独立生成（幂等由调用方 marker 保证，不靠 id 判重）');
  console.log('✓ 迁移输出形状稳定');
}

// ============ 五、工具函数 ============

{
  assert.equal(normalizeBaseUrl('https://example.com/v1/'), 'https://example.com/v1');
  assert.equal(normalizeBaseUrl('  https://example.com/v1  '), 'https://example.com/v1');
  assert.equal(isOfficialProvider('deepseek_official'), true);
  assert.equal(isOfficialProvider('openai_compatible'), false);

  assert.equal(validateCustomModelId('  ').ok, false);
  assert.equal(validateCustomModelId('a b').ok, false);
  assert.equal(validateCustomModelId('gpt-5.6-luna').ok, true);
  assert.equal(validateCustomModelId('glm-custom/qwen.max:v2').ok, true, '/ : . _ - 不应被误拦');
  console.log('✓ Base URL 规范化与 model_id 校验');
}

console.log('\n全部通过：settings-migration');
