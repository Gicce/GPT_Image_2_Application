// 静态 smoke 测试 -- node scripts/model-registry.smoke.mjs
//
// 验证 Model Registry / Discovery / Merge / Lifecycle 核心约束：
//   1. built-in registry 加载（GLM 多代模型 / capabilities / recommended）
//   2. Discovery 发现未知模型 -> 自动接纳（source=provider_discovery，capability=unknown，不丢弃）
//   3. 模型消失 -> lifecycle=missing，不删除；default 引用不变
//   4. custom 模型 display_name 不被 Registry 覆盖
//   5. 远程 Registry：schema 校验失败丢弃回退 / 网络失败回退缓存 / 全部失败回退 builtin
//   6. 旧持久化数据升级：built_in -> official_registry；Registry 不认识的 -> legacy
//   7. store：API Key 显式保存/清除 + validation_state；模型同步不切换默认模型
//   8. Agent Prompt Builder：结构约束（独立 Builder Prompt、候选不覆盖为 UI 层职责，此处验证输入拼装规则）

import assert from 'node:assert/strict';
import { loadTs } from './_ts_loader.mjs';

// node 环境无 localStorage：为 Registry 缓存路径提供内存 shim
const memoryStorage = new Map();
globalThis.localStorage = {
  getItem: key => (memoryStorage.has(key) ? memoryStorage.get(key) : null),
  setItem: (key, value) => memoryStorage.set(key, String(value)),
  removeItem: key => memoryStorage.delete(key),
};

const registryMod = await loadTs('../src/features/aiProviders/registry/registry.ts');
const {
  getBuiltInRegistry, mergeModelCatalogs, loadRegistry, isNewlyDiscovered, recommendedModelId,
} = registryMod;

const migration = await loadTs('../src/features/aiProviders/migration.ts');
const { createEmptyProfile, upgradePersistedProfile } = migration;

// ============ 一、Built-in Registry ============

{
  const glm = getBuiltInRegistry('glm_official');
  assert.ok(glm, 'GLM 内置 Registry 必须存在');
  assert.ok(glm.models.length >= 8, 'GLM Registry 必须收录多代模型（不再是 4 个）');
  const ids = glm.models.map(m => m.model_id);
  for (const required of ['glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-5', 'glm-4.7', 'glm-4.6', 'glm-4.5', 'glm-4v']) {
    assert.ok(ids.includes(required), `Registry 应包含 ${required}`);
  }
  assert.equal(recommendedModelId(glm.models), 'glm-5.3', 'recommended 来自 Registry 数据而非 UI 硬编码');
  const glm53 = glm.models.find(m => m.model_id === 'glm-5.3');
  assert.ok(glm53.capabilities.includes('text'));
  assert.equal(glm53.lifecycle, 'active');

  const ds = getBuiltInRegistry('deepseek_official');
  assert.equal(ds.models.length >= 2, true);
  assert.equal(recommendedModelId(ds.models), 'deepseek-chat');
  assert.ok(getBuiltInRegistry('openai_compatible') === null, '第三方无内置 Registry');
  console.log(`✓ 内置 Registry 加载（GLM ${glm.models.length} / DeepSeek ${ds.models.length}），recommended 来自数据`);
}

// ============ 二、Discovery 未知模型自动接纳 ============

{
  const profile = createEmptyProfile('glm_official', 'GLM');
  const merge = mergeModelCatalogs({
    existing: profile.models,
    discovered: ['glm-5.3', 'glm-6-future', 'third-party-new-model'],
    registry: getBuiltInRegistry('glm_official').models,
  });
  const unknown = merge.models.find(m => m.model_id === 'glm-6-future');
  assert.ok(unknown, 'Registry 不认识的新模型必须被接纳，禁止丢弃');
  assert.equal(unknown.model_source, 'provider_discovery');
  assert.deepEqual(unknown.capabilities, ['unknown'], '未知模型能力必须是 unknown，不强行猜');
  assert.equal(unknown.lifecycle, 'unknown');
  assert.ok(unknown.discovered_at, '新发现模型必须记录 discovered_at');
  assert.ok(merge.added.includes('glm-6-future'));
  assert.ok(isNewlyDiscovered(unknown), '14 天内发现的模型标记为新');
  console.log('✓ Discovery 未知模型自动接纳（capability=unknown，✨新）');
}

// ============ 三、模型消失 -> missing，不删除、不切换默认模型 ============

{
  const profile = createEmptyProfile('glm_official', 'GLM');
  profile.default_model_id = 'glm-4.5';
  // 第一次同步：发现 glm-4.5
  const first = mergeModelCatalogs({
    existing: profile.models,
    discovered: ['glm-4.5', 'glm-5.3'],
    registry: getBuiltInRegistry('glm_official').models,
  });
  // 第二次同步：Provider 不再返回 glm-4.5
  const second = mergeModelCatalogs({
    existing: first.models,
    discovered: ['glm-5.3'],
    registry: getBuiltInRegistry('glm_official').models,
  });
  const disappeared = second.models.find(m => m.model_id === 'glm-4.5');
  assert.ok(disappeared, '消失的模型禁止删除');
  // glm-4.5 在 Registry 中存在 -> 不会标 missing（Registry 优先级高于 Discovery）
  assert.notEqual(disappeared.lifecycle, 'missing');

  // 纯 Discovery 来源的模型消失 -> missing
  const withDiscovered = mergeModelCatalogs({
    existing: first.models,
    discovered: ['glm-5.3', 'glm-6-future'],
    registry: getBuiltInRegistry('glm_official').models,
  });
  const afterVanish = mergeModelCatalogs({
    existing: withDiscovered.models,
    discovered: ['glm-5.3'],
    registry: getBuiltInRegistry('glm_official').models,
  });
  const vanished = afterVanish.models.find(m => m.model_id === 'glm-6-future');
  assert.ok(vanished, 'Discovery 来源模型消失也禁止删除');
  assert.equal(vanished.lifecycle, 'missing');
  assert.ok(afterVanish.missing.includes('glm-6-future'));
  console.log('✓ 模型消失 -> lifecycle=missing（Registry 优先级高于 Discovery；永不删除）');
}

// ============ 四、custom 模型不被 Registry 覆盖 ============

{
  const third = createEmptyProfile('openai_compatible', '第三方');
  const customModel = {
    id: 'model_x', model_id: 'deepseek-chat', display_name: '我的中转 DeepSeek',
    model_source: 'custom', enabled: true, supports_vision: false,
    capabilities: ['text'], lifecycle: 'unknown', test_status: 'untested',
  };
  const merge = mergeModelCatalogs({
    existing: [customModel],
    discovered: ['deepseek-chat'],
    registry: getBuiltInRegistry('deepseek_official').models,
  });
  const kept = merge.models.find(m => m.id === 'model_x');
  assert.equal(kept.display_name, '我的中转 DeepSeek', 'custom display_name 用户优先');
  assert.equal(kept.model_source, 'custom');
  console.log('✓ custom 模型名称/来源不被 Registry 覆盖');
}

// ============ 五、远程 Registry 回退链 ============

{
  // 未启用远程（默认）-> builtin
  const disabled = await loadRegistry('glm_official');
  assert.equal(disabled.origin, 'builtin');

  // schema 非法 -> 丢弃远程，回退 builtin
  const invalid = await loadRegistry('glm_official', { force: true, fetchJson: async () => ({ schema_version: 99, models: 'bad' }) });
  assert.equal(invalid.origin, 'builtin');

  // 网络失败 -> 回退 builtin
  const netFail = await loadRegistry('glm_official', { force: true, fetchJson: async () => { throw new Error('network down'); } });
  assert.equal(netFail.origin, 'builtin');

  // 合法远程 -> remote，且 force 后缓存生效
  const remotePayload = {
    schema_version: 1, provider_type: 'glm_official', display_name: 'x', base_url: '', updated_at: '2026-08-15',
    models: [{ model_id: 'glm-future-remote', display_name: 'GLM Future Remote', capabilities: ['text'], lifecycle: 'active' }],
  };
  const remoteOk = await loadRegistry('glm_official', { force: true, fetchJson: async () => remotePayload });
  assert.equal(remoteOk.origin, 'remote');
  assert.ok(remoteOk.registry.models.some(m => m.model_id === 'glm-future-remote'), '远程新增模型进入目录（客户端无需升级）');
  const fromCache = await loadRegistry('glm_official', { fetchJson: async () => { throw new Error('down'); } });
  assert.equal(fromCache.origin, 'cache', '网络失败时回退缓存而非空目录');
  console.log('✓ 远程 Registry：remote → cache → builtin 回退链 + schema 校验');
}

// ============ 六、旧持久化数据升级 ============

{
  const oldProfile = createEmptyProfile('glm_official', '旧配置');
  // 模拟 v3.0 持久化形状：built_in 来源、无 capabilities、含一个 Registry 已删除的模型
  oldProfile.models = [
    { id: 'a1', model_id: 'glm-4.5', display_name: 'GLM-4.5', model_source: 'built_in', enabled: true, supports_vision: false, test_status: 'available', last_tested_at: '2026-01-01T00:00:00Z' },
    { id: 'a2', model_id: 'glm-3-turbo-ancient', display_name: 'GLM-3 Turbo', model_source: 'built_in', enabled: true, supports_vision: false, test_status: 'untested' },
  ];
  oldProfile.default_model_id = 'glm-3-turbo-ancient';
  const upgraded = upgradePersistedProfile(oldProfile);
  const glm45 = upgraded.models.find(m => m.model_id === 'glm-4.5');
  assert.equal(glm45.model_source, 'official_registry');
  assert.ok(glm45.capabilities.length > 0 && !glm45.capabilities.includes('unknown'), 'Registry 认识的模型补齐 capabilities');
  assert.equal(glm45.test_status, 'available', '检测历史保留');
  assert.equal(glm45.last_tested_at, '2026-01-01T00:00:00Z', '检测时间保留');
  const ancient = upgraded.models.find(m => m.model_id === 'glm-3-turbo-ancient');
  assert.ok(ancient, 'Registry 不认识的旧模型禁止丢弃');
  assert.equal(ancient.model_source, 'legacy');
  assert.equal(upgraded.default_model_id, 'glm-3-turbo-ancient', '默认模型绝不静默切换');
  console.log('✓ 旧数据升级：built_in→official_registry；未知→legacy；默认模型保持');
}

// ============ 七、store：API Key 显式保存 + 模型同步 ============

{
  const storeMod = await loadTs('../src/features/aiProviders/store.ts');
  const { useAIProviderStore } = storeMod;
  const store = useAIProviderStore.getState();
  store.hydrate();
  useAIProviderStore.setState({ profiles: [], selections: {}, defaultProfileId: '', migrated: true });

  const profile = createEmptyProfile('glm_official', 'GLM');
  store.addProfile(profile);
  const pid = profile.id;

  // 未保存 Key -> missing；保存后有 saved_at，且不改变 validation
  store.saveApiKey(pid, 'sk-glm-key');
  let current = useAIProviderStore.getState().profiles.find(p => p.id === pid);
  assert.equal(current.api_key, 'sk-glm-key');
  assert.ok(current.api_key_saved_at);
  assert.equal(current.validation_state, 'unknown', '保存 ≠ 可用：验证状态独立');

  store.setValidationState(pid, 'valid');
  current = useAIProviderStore.getState().profiles.find(p => p.id === pid);
  assert.equal(current.validation_state, 'valid');
  assert.ok(current.last_validated_at);

  // 模型同步：消失的模型保留 + default 引用不变
  const merged = mergeModelCatalogs({
    existing: current.models,
    discovered: ['glm-5.3'],
    registry: getBuiltInRegistry('glm_official').models,
  });
  const beforeDefault = current.default_model_id;
  store.applyModelSync(pid, merged.models, new Date().toISOString());
  current = useAIProviderStore.getState().profiles.find(p => p.id === pid);
  assert.equal(current.default_model_id, beforeDefault, '同步不得切换默认模型');
  assert.ok(current.last_model_sync_at);

  store.clearApiKey(pid);
  current = useAIProviderStore.getState().profiles.find(p => p.id === pid);
  assert.equal(current.api_key, '');
  assert.equal(current.validation_state, 'unknown', '清除 Key 后验证状态重置');
  console.log('✓ API Key 显式保存/验证/清除 + 模型同步不动默认模型');
}

// ============ 八、Agent Prompt Builder 结构约束 ============

{
  const builder = await loadTs('../src/features/aiProviders/promptBuilder.ts');
  const { PROMPT_BUILDER_INSTRUCTION, buildAgentPrompt } = builder;
  // 独立 Builder Prompt：必须包含结构化要求与专业角色安全边界，禁止关键词拦截式实现
  assert.ok(PROMPT_BUILDER_INSTRUCTION.includes('角色'));
  assert.ok(PROMPT_BUILDER_INSTRUCTION.includes('现有 Prompt'));
  assert.ok(PROMPT_BUILDER_INSTRUCTION.includes('辅助分析') || PROMPT_BUILDER_INSTRUCTION.includes('辅助分析与信息整理'));
  assert.ok(!/禁止|黑名单|blocked.?words/i.test(PROMPT_BUILDER_INSTRUCTION), '不得用死板关键词拦截实现安全边界');

  // 未配置 Key / 模型 -> 明确错误（禁止无提示失败）
  const noKey = await buildAgentPrompt({
    profile: { provider_type: 'glm_official', base_url: '', api_key: '', fallback_token: '' },
    model: { model_id: '' },
    instruction: '我需要一个医生',
  });
  assert.equal(noKey.ok, false);
  assert.ok(noKey.errorMessage.includes('API Key'));
  console.log('✓ Agent Prompt Builder：独立 Builder Prompt + 未配置时明确报错');
}

console.log('\n全部通过：model-registry');
