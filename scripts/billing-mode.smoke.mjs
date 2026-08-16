// 静态 smoke 测试 -- node scripts/billing-mode.smoke.mjs
//
// 验证 Provider 双使用方式（billing_mode）架构的核心约束：
//   1. Base URL resolver：glm+api / glm+coding_plan / deepseek 单模式 / 第三方
//   2. 旧数据迁移：无 billing_mode 的 glm_official → api（Coding Plan 地址 → coding_plan）
//   3. Credential 隔离：API Key A / Coding Plan Key B 来回切换互不覆盖
//   4. 模型目录缓存按 (profile, billing_mode) 隔离，不串模式
//   5. 错误映射：429+1113 按 billing_mode 区分（API 余额 / Coding Plan 额度）；
//      401 → Key 无效；429+quota(coding_plan) → 套餐额度受限；model not found
//   6. 切换模式后会话选择不偷偷沿用旧模式模型

import assert from 'node:assert/strict';
import { loadTs } from './_ts_loader.mjs';

const registryMod = await loadTs('../src/features/aiProviders/registry/registry.ts');
const {
  resolveProviderBaseUrl,
  getBillingModes,
  defaultBillingMode,
  getBuiltInRegistry,
} = registryMod;

const migration = await loadTs('../src/features/aiProviders/migration.ts');
const { createEmptyProfile, upgradePersistedProfile, applyBillingModeToProfile, buildEmptyModeState } = migration;

const storeMod = await loadTs('../src/features/aiProviders/store.ts');
const { useAIProviderStore, resolveByokAgentConfig } = storeMod;

const errorsMod = await loadTs('../src/features/aiProviders/modelErrors.ts');
const { classifyModelErrorCode } = errorsMod;

const providerErrorMod = await loadTs('../src/features/aiProviders/providerError.ts');
const { buildProviderError } = providerErrorMod;

const store = useAIProviderStore.getState();
store.hydrate();

function reset() {
  useAIProviderStore.setState({ profiles: [], selections: {}, defaultProfileId: '', migrated: true });
}

// ============ 一、Base URL resolver ============
{
  assert.equal(resolveProviderBaseUrl('glm_official', 'api'), 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(resolveProviderBaseUrl('glm_official', 'coding_plan'), 'https://open.bigmodel.cn/api/coding/paas/v4');
  // 不带 mode：返回 registry 第一个 billing_mode（默认）的地址
  assert.equal(resolveProviderBaseUrl('glm_official'), 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(resolveProviderBaseUrl('deepseek_official'), 'https://api.deepseek.com/v1');
  assert.equal(resolveProviderBaseUrl('deepseek_official', 'api'), 'https://api.deepseek.com/v1');
  // 第三方无 registry：resolver 返回空（地址完全由用户配置）
  assert.equal(resolveProviderBaseUrl('openai_compatible'), '');

  const glmModes = getBillingModes('glm_official');
  assert.equal(glmModes.length, 2);
  assert.equal(defaultBillingMode('glm_official'), 'api');
  assert.equal(getBillingModes('deepseek_official').length, 1, 'DeepSeek 单模式（未来套餐可在 registry 扩展）');
  assert.equal(getBillingModes('openai_compatible').length, 0);
  console.log('✓ Base URL resolver：glm api/coding_plan、deepseek 单模式、第三方为空');
}

// ============ 二、新建 / 旧数据迁移 ============
{
  // 新建 glm profile：默认 api 模式 + mode_states 种子
  const fresh = createEmptyProfile('glm_official', '智谱');
  assert.equal(fresh.billing_mode, 'api');
  assert.equal(fresh.base_url, 'https://open.bigmodel.cn/api/paas/v4');
  assert.ok(fresh.mode_states?.api);
  assert.ok(!fresh.mode_states?.coding_plan, '未切换过的模式不预生成');

  // 旧数据：无 billing_mode 的 glm_official（历史版本默认普通 API）→ api
  const legacy = createEmptyProfile('glm_official', '旧智谱');
  delete legacy.billing_mode;
  delete legacy.mode_states;
  legacy.api_key = 'sk-legacy-key';
  legacy.api_key_saved_at = '2026-01-01T00:00:00.000Z';
  const upgraded = upgradePersistedProfile(legacy);
  assert.equal(upgraded.billing_mode, 'api', '旧 glm_official 默认迁移为 api 模式');
  assert.equal(upgraded.base_url, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(upgraded.api_key, 'sk-legacy-key', '迁移不丢 Key');
  assert.equal(upgraded.mode_states?.api?.api_key, 'sk-legacy-key');
  assert.equal(upgraded.mode_states?.api?.api_key_saved_at, '2026-01-01T00:00:00.000Z');
  // 幂等：再跑一遍不改变
  assert.deepEqual(upgradePersistedProfile(upgraded), upgraded);

  // 旧数据：base_url 已是 Coding Plan 地址 → 按地址推断 coding_plan
  const legacyCoding = createEmptyProfile('glm_official', '旧套餐');
  delete legacyCoding.billing_mode;
  delete legacyCoding.mode_states;
  legacyCoding.base_url = 'https://open.bigmodel.cn/api/coding/paas/v4';
  const upgradedCoding = upgradePersistedProfile(legacyCoding);
  assert.equal(upgradedCoding.billing_mode, 'coding_plan');
  assert.equal(upgradedCoding.base_url, 'https://open.bigmodel.cn/api/coding/paas/v4');
  console.log('✓ 迁移：旧 glm → api（Coding 地址 → coding_plan），Key/时间戳保留，幂等');
}

// ============ 三、Credential 隔离（Key A / Key B 互不覆盖）============
{
  reset();
  const profile = createEmptyProfile('glm_official', '智谱双模式');
  useAIProviderStore.getState().addProfile(profile);
  const pid = profile.id;

  useAIProviderStore.getState().saveApiKey(pid, 'sk-api-key-a');
  assert.equal(useAIProviderStore.getState().profiles.find(p => p.id === pid).api_key, 'sk-api-key-a');

  useAIProviderStore.getState().setBillingMode(pid, 'coding_plan');
  let current = useAIProviderStore.getState().profiles.find(p => p.id === pid);
  assert.equal(current.billing_mode, 'coding_plan');
  assert.equal(current.base_url, 'https://open.bigmodel.cn/api/coding/paas/v4');
  assert.equal(current.api_key, '', '切到 Coding Plan 后未配置 Key（不沿用 API Key）');
  assert.equal(current.mode_states.api.api_key, 'sk-api-key-a', 'API Key A 已存回 api 模式');

  useAIProviderStore.getState().saveApiKey(pid, 'sk-coding-key-b');
  current = useAIProviderStore.getState().profiles.find(p => p.id === pid);
  assert.equal(current.api_key, 'sk-coding-key-b');

  // 切回 api：Key A 必须原样恢复
  useAIProviderStore.getState().setBillingMode(pid, 'api');
  current = useAIProviderStore.getState().profiles.find(p => p.id === pid);
  assert.equal(current.api_key, 'sk-api-key-a', '切回 API 模式后 Key A 恢复');
  assert.equal(current.base_url, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(current.mode_states.coding_plan.api_key, 'sk-coding-key-b', 'Key B 仍保存在 coding_plan 模式');
  // api_key_saved_at 按 credential 独立保存（各自的 mode_state 都有自己的一份）
  assert.ok(current.api_key_saved_at && current.mode_states.api.api_key_saved_at);
  assert.ok(current.mode_states.coding_plan.api_key_saved_at);
  console.log('✓ Credential 隔离：Key A / Key B 来回切换互不覆盖，时间戳独立');
}

// ============ 四、模型目录缓存按模式隔离 ============
{
  reset();
  const profile = createEmptyProfile('glm_official', '智谱模型隔离');
  useAIProviderStore.getState().addProfile(profile);
  const pid = profile.id;

  // api 模式下同步一份"API 发现的模型"
  const apiModels = [
    ...buildEmptyModeState('glm_official').models,
    {
      id: 'reg_api-only-model', model_id: 'glm-api-only', display_name: 'API 专属模型',
      model_source: 'provider_discovery', enabled: true, supports_vision: false,
      capabilities: ['unknown'], lifecycle: 'unknown', test_status: 'untested',
    },
  ];
  useAIProviderStore.getState().applyModelSync(pid, apiModels, '2026-08-15T01:00:00.000Z');

  useAIProviderStore.getState().setBillingMode(pid, 'coding_plan');
  let current = useAIProviderStore.getState().profiles.find(p => p.id === pid);
  assert.ok(!current.models.some(m => m.model_id === 'glm-api-only'),
    '切到 Coding Plan 后不得显示 API 模式缓存的模型');
  assert.equal(current.last_model_sync_at, undefined, '同步时间戳按模式隔离');

  useAIProviderStore.getState().setBillingMode(pid, 'api');
  current = useAIProviderStore.getState().profiles.find(p => p.id === pid);
  assert.ok(current.models.some(m => m.model_id === 'glm-api-only'), '切回 API 模式后恢复 API 模型缓存');
  assert.equal(current.last_model_sync_at, '2026-08-15T01:00:00.000Z');
  console.log('✓ 模型缓存按 (profile, billing_mode) 隔离，不串模式');
}

// ============ 五、错误映射（billing_mode 感知）============
{
  const glm1113 = '余额不足或无可用资源包 [code: 1113] (HTTP 429)';

  // API 模式 + 1113：余额错误，不得提示重置 Key
  const apiErr = buildProviderError({
    providerId: 'p1', providerType: 'glm_official', billingMode: 'api', modelId: 'glm-5.2',
    failure: { ok: false, error_kind: 'rate_limit', error_message: glm1113, status: 429 },
  });
  assert.equal(apiErr.code, 'insufficient_balance', '429+1113 必须分类为余额错误（先于 rate_limited）');
  assert.equal(apiErr.title, '普通 API 余额或资源包不可用');
  assert.ok(apiErr.guidance.includes('Coding Plan'), 'API 模式 1113 应建议检查使用方式');
  assert.ok(!apiErr.title.includes('Key'), '余额错误不得当成 Key 错误');
  assert.equal(apiErr.providerCode, '1113');

  // Coding Plan 模式 + 1113：套餐/Key 匹配问题，不是普通余额
  const codingErr = buildProviderError({
    providerId: 'p1', providerType: 'glm_official', billingMode: 'coding_plan', modelId: 'glm-5.2',
    failure: { ok: false, error_kind: 'rate_limit', error_message: glm1113, status: 429 },
  });
  assert.equal(codingErr.code, 'insufficient_balance');
  assert.equal(codingErr.title, 'Coding Plan 额度不可用或 Key 不匹配');
  assert.ok(codingErr.guidance.includes('相互独立'), '不得建议为普通余额充值');

  // Coding Plan + quota 类 429 → 套餐额度受限
  const quotaCode = classifyModelErrorCode({
    httpStatus: 429, message: 'quota exceeded: fair usage limit reached', billingMode: 'coding_plan',
  });
  assert.equal(quotaCode, 'plan_quota_exceeded');
  const quotaErr = buildProviderError({
    providerId: 'p1', providerType: 'glm_official', billingMode: 'coding_plan', modelId: 'glm-5.2',
    failure: { ok: false, error_kind: 'rate_limit', error_message: 'quota exceeded [code: 2410] (HTTP 429)', status: 429 },
  });
  assert.equal(quotaErr.title, 'Coding Plan 当前额度已达到限制');

  // 普通限流：不得误判为余额/套餐
  const rateCode = classifyModelErrorCode({ httpStatus: 429, message: 'too many requests' });
  assert.equal(rateCode, 'rate_limited');

  // 401：Key 无效 → 才允许提示修改 Key
  const authErr = buildProviderError({
    providerId: 'p1', providerType: 'glm_official', billingMode: 'api', modelId: 'glm-5.2',
    failure: { ok: false, error_kind: 'auth', error_message: 'invalid api key [code: 1001] (HTTP 401)', status: 401 },
  });
  assert.equal(authErr.code, 'authentication_failed');
  assert.equal(authErr.title, 'API Key 无效或已失效');

  // 模型不存在
  const modelErr = buildProviderError({
    providerId: 'p1', providerType: 'glm_official', billingMode: 'coding_plan', modelId: 'glm-9.9',
    failure: { ok: false, error_kind: 'model_not_found', error_message: 'model not found [code: 1211] (HTTP 404)', status: 404 },
  });
  assert.equal(modelErr.code, 'model_not_found');
  assert.equal(modelErr.title, '当前模式下模型不可用');
  assert.ok(modelErr.guidance.includes('刷新模型'));

  // 网络/服务器错误 retryable
  const netErr = buildProviderError({
    providerId: 'p1', providerType: 'glm_official',
    failure: { ok: false, error_kind: 'connect', error_message: 'connection refused' },
  });
  assert.equal(netErr.code, 'network_error');
  assert.equal(netErr.retryable, true);
  console.log('✓ 错误映射：429+1113 双模式区分、401、quota、model_not_found、network');
}

// ============ 六、切换模式后会话选择不沿用旧模型 ============
{
  reset();
  const profile = createEmptyProfile('glm_official', '智谱选择迁移');
  useAIProviderStore.getState().addProfile(profile);
  const pid = profile.id;
  useAIProviderStore.getState().saveApiKey(pid, 'sk-api-key-a');

  // api 模式目录含 API 专属模型，会话选择它
  const withApiOnly = [
    ...buildEmptyModeState('glm_official').models,
    {
      id: 'reg_glm-api-only', model_id: 'glm-api-only', display_name: 'API 专属模型',
      model_source: 'provider_discovery', enabled: true, supports_vision: false,
      capabilities: ['unknown'], lifecycle: 'unknown', test_status: 'untested',
    },
  ];
  useAIProviderStore.getState().applyModelSync(pid, withApiOnly, '2026-08-15T02:00:00.000Z');
  useAIProviderStore.getState().setSelection('conv1', { profileId: pid, modelId: 'glm-api-only' });

  // 切到 Coding Plan（目录不含 glm-api-only）→ 选择必须显式回落，不得偷偷沿用
  useAIProviderStore.getState().setBillingMode(pid, 'coding_plan');
  const sel = useAIProviderStore.getState().getSelection('conv1');
  assert.ok(sel, '切换后选择仍可解析');
  assert.notEqual(sel.model.model_id, 'glm-api-only', '不得偷偷沿用新模式目录中不存在的旧模型');
  console.log('✓ 切换模式后会话选择回落到新模式可用模型（不偷偷沿用旧模型）');
}

// ============ 七、Byok 解析携带 billing_mode 与正确 baseUrl ============
{
  reset();
  const profile = createEmptyProfile('glm_official', '智谱 Byok');
  useAIProviderStore.getState().addProfile(profile);
  useAIProviderStore.getState().setBillingMode(profile.id, 'coding_plan');
  useAIProviderStore.getState().saveApiKey(profile.id, 'sk-coding-key-b');

  const byok = resolveByokAgentConfig({ selected_agent_profile_id: profile.id, selected_agent_model_id: 'glm-5.2' });
  assert.ok(byok.ok);
  assert.equal(byok.billingMode, 'coding_plan');
  assert.equal(byok.baseUrl, 'https://open.bigmodel.cn/api/coding/paas/v4', '读取时按模式解析 Base URL');
  assert.equal(byok.token, 'sk-coding-key-b');
  console.log('✓ resolveByokAgentConfig 携带 billing_mode，Base URL 按当前模式解析');
}

// ============ 八、applyBillingModeToProfile 不丢当前模式状态 ============
{
  const profile = createEmptyProfile('glm_official', '智谱切换');
  profile.api_key = 'sk-x';
  const switched = applyBillingModeToProfile(profile, 'coding_plan');
  assert.equal(switched.mode_states.api.api_key, 'sk-x', '切换时当前模式状态先存回');
  assert.equal(applyBillingModeToProfile(switched, 'coding_plan'), switched, '切换到当前模式为幂等 no-op');
  // 非法模式拒绝
  const invalid = applyBillingModeToProfile(profile, 'not_a_mode');
  assert.equal(invalid.billing_mode, 'api');
  // DeepSeek 单模式：不允许切换到 coding_plan
  const ds = createEmptyProfile('deepseek_official', 'DeepSeek');
  assert.equal(applyBillingModeToProfile(ds, 'coding_plan').billing_mode, 'api', 'DeepSeek 不支持 coding_plan，切换被拒绝');
  console.log('✓ applyBillingModeToProfile：存回当前状态、幂等、非法/不支持模式拒绝');
}

console.log('\n全部通过：billing-mode');
