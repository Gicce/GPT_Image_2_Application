// 静态 smoke 测试 -- node scripts/provider-runtime.smoke.mjs
//
// 统一 Chat / Agent Provider Runtime 的路由与错误回归：
//   1. ModelRef（profileId + modelId）→ resolveByokAgentConfig 三种 Provider
//      （智谱 GLM / DeepSeek / 第三方）各自命中正确的 baseUrl / token / providerType，
//      绝不经过 Server Agent（packyapi / gpt-5.6-luna 无任何参与路径）。
//   2. 错误分类：智谱「余额不足 code 1113 / HTTP 429」必须归为 insufficient_balance
//      而不是 rate_limited；DeepSeek HTTP 402 Insufficient Balance 同理。
//   3. ProviderError：错误文案必须 Provider 化（「智谱 GLM 请求失败」…），
//      禁止「上游模型接口失败」这类与 Provider 无关的旧 Server Proxy 文案；
//      ProviderError 保留原始 code/status/message。
//   4. Planner 失败归因：planTaskWithAgent 失败结果带 Provider 前缀。
//
// Rust 侧 transport 路由（chat_completions 优先 / gpt-5.6* Responses 优先）
// 由 src-tauri 单元测试 transport_preference_is_model_capability_not_mode 覆盖：
//   cargo test transport_preference

import assert from 'node:assert/strict';
import { loadTs } from './_ts_loader.mjs';

const storeMod = await loadTs('../src/features/aiProviders/store.ts');
const { useAIProviderStore, resolveByokAgentConfig } = storeMod;

const migration = await loadTs('../src/features/aiProviders/migration.ts');
const { createEmptyProfile } = migration;

const modelErrors = await loadTs('../src/features/aiProviders/modelErrors.ts');
const { classifyModelErrorCode } = modelErrors;

const providerErrorMod = await loadTs('../src/features/aiProviders/providerError.ts');
const { buildProviderError, providerErrorCompact, providerFailureLabel, extractProviderCode } = providerErrorMod;

const store = useAIProviderStore.getState();
store.hydrate();

function reset() {
  useAIProviderStore.setState({ profiles: [], selections: {}, defaultProfileId: '', migrated: true });
}

// ============ 一、ModelRef 路由：三种 Provider 各自命中自己的 baseUrl / token ============

let glmProfileId, deepseekProfileId, thirdProfileId;
{
  reset();
  const glm = createEmptyProfile('glm_official', '智谱 GLM');
  const deepseek = createEmptyProfile('deepseek_official', 'DeepSeek 官方');
  const third = createEmptyProfile('openai_compatible', '我的中转 API');
  store.addProfile(glm);
  store.addProfile(deepseek);
  store.addProfile(third);
  store.addCustomModel(third.id, { model_id: 'custom-model', display_name: 'Custom Model' });
  glmProfileId = glm.id;
  deepseekProfileId = deepseek.id;
  thirdProfileId = third.id;

  // --- 智谱 GLM ---
  useAIProviderStore.getState().saveApiKey(glm.id, 'zhipu-user-key-abc');
  useAIProviderStore.getState().setSelection('conv', { profileId: glm.id, modelId: 'glm-5.2' });
  let cfg = resolveByokAgentConfig({ id: 'conv', selected_agent_profile_id: glm.id, selected_agent_model_id: 'glm-5.2' });
  assert.equal(cfg.ok, true, 'GLM ModelRef 必须解析成功');
  assert.equal(cfg.providerType, 'glm_official');
  assert.equal(cfg.baseUrl, 'https://open.bigmodel.cn/api/paas/v4', 'GLM 必须命中智谱官方地址');
  assert.equal(cfg.token, 'zhipu-user-key-abc', 'GLM 必须使用用户自己保存的 Key');
  assert.equal(cfg.model, 'glm-5.2');
  assert.ok(!cfg.baseUrl.includes('packyapi'), 'GLM 路由禁止经过 packyapi 服务器');

  // --- DeepSeek ---
  useAIProviderStore.getState().saveApiKey(deepseek.id, 'deepseek-user-key-xyz');
  cfg = resolveByokAgentConfig({ id: 'conv2', selected_agent_profile_id: deepseek.id, selected_agent_model_id: 'deepseek-chat' });
  assert.equal(cfg.ok, true, 'DeepSeek ModelRef 必须解析成功（即使此前从未真实调用）');
  assert.equal(cfg.providerType, 'deepseek_official');
  assert.equal(cfg.baseUrl, 'https://api.deepseek.com/v1', 'DeepSeek 必须命中官方地址');
  assert.equal(cfg.token, 'deepseek-user-key-xyz');
  assert.equal(cfg.model, 'deepseek-chat');
  assert.ok(!cfg.baseUrl.includes('packyapi'), 'DeepSeek 路由禁止经过服务器');

  // --- 第三方（两个第三方同模型名不冲突）---
  const otherThird = createEmptyProfile('openai_compatible', '另一家中转');
  store.addProfile(otherThird);
  store.addCustomModel(otherThird.id, { model_id: 'custom-model', display_name: '同名模型' });
  useAIProviderStore.getState().saveApiKey(third.id, 'third-key-1');
  useAIProviderStore.getState().saveApiKey(otherThird.id, 'third-key-2');
  useAIProviderStore.getState().updateProfile(third.id, { base_url: 'https://relay-a.example.com/v1' });
  useAIProviderStore.getState().updateProfile(otherThird.id, { base_url: 'https://relay-b.example.com/v1' });
  cfg = resolveByokAgentConfig({ id: 'conv3', selected_agent_profile_id: third.id, selected_agent_model_id: 'custom-model' });
  assert.equal(cfg.ok, true);
  assert.equal(cfg.baseUrl, 'https://relay-a.example.com/v1', '第三方 ModelRef 必须命中该 Provider 自己的 baseUrl');
  assert.equal(cfg.token, 'third-key-1', '同名模型跨 Provider 不允许串 Key');
  console.log('✓ ModelRef 路由：GLM / DeepSeek / 第三方各自命中自己的 baseUrl + Key');
}

// ============ 二、错误分类：1113 / 402 → insufficient_balance ============

{
  // 智谱真实形态：HTTP 429 + code 1113 +「余额不足或无可用资源包」
  assert.equal(
    classifyModelErrorCode({
      httpStatus: 429,
      message: '上游模型接口失败：余额不足或无可用资源包 [code: 1113] (HTTP 429)',
    }),
    'insufficient_balance',
    '智谱 1113 余额错误必须归为 insufficient_balance，不得误判为 rate_limited',
  );
  // DeepSeek 真实形态：HTTP 402 Insufficient Balance
  assert.equal(
    classifyModelErrorCode({ httpStatus: 402, message: 'Insufficient Balance' }),
    'insufficient_balance',
  );
  assert.equal(
    classifyModelErrorCode({ message: '账户欠费，请充值后重试' }),
    'insufficient_balance',
  );
  // 真正的限流仍然是 rate_limited
  assert.equal(
    classifyModelErrorCode({ httpStatus: 429, message: 'Too many requests' }),
    'rate_limited',
  );
  // 鉴权 / 权限 / 未知保持原语义
  assert.equal(classifyModelErrorCode({ httpStatus: 401 }), 'authentication_failed');
  assert.equal(classifyModelErrorCode({ httpStatus: 403 }), 'permission_denied');
  assert.equal(classifyModelErrorCode({ httpStatus: 500 }), 'provider_error');
  console.log('✓ 错误分类：1113/402/欠费 → insufficient_balance；真限流仍为 rate_limited');
}

// ============ 三、ProviderError：Provider 化文案 + 原始信息保留 ============

{
  // GLM 1113
  const glmErr = buildProviderError({
    providerId: glmProfileId,
    providerType: 'glm_official',
    providerName: '智谱 GLM',
    modelId: 'glm-5.2',
    failure: {
      ok: false,
      error_kind: 'rate_limit',
      error_message: '余额不足或无可用资源包 [code: 1113] (HTTP 429)',
      status: 429,
    },
  });
  assert.equal(glmErr.providerLabel, '智谱 GLM');
  assert.equal(glmErr.code, 'insufficient_balance');
  assert.equal(glmErr.providerCode, '1113', '必须保留 Provider 原始错误码');
  assert.equal(glmErr.httpStatus, 429);
  assert.ok(glmErr.userMessage.includes('智谱 GLM 请求失败'), '文案必须 Provider 化');
  assert.ok(!glmErr.userMessage.includes('上游模型'), '禁止旧 Server Proxy 文案「上游模型」');
  assert.ok(glmErr.userMessage.includes('glm-5.2'), '文案应包含模型名');
  assert.ok(providerErrorCompact(glmErr).startsWith('智谱 GLM 请求失败'));

  // DeepSeek 鉴权失败
  const dsErr = buildProviderError({
    providerId: deepseekProfileId,
    providerType: 'deepseek_official',
    providerName: 'DeepSeek 官方',
    modelId: 'deepseek-chat',
    failure: { ok: false, error_kind: 'auth', error_message: 'Authentication Fails, Your api key is invalid', status: 401 },
  });
  assert.equal(dsErr.providerLabel, 'DeepSeek');
  assert.equal(dsErr.code, 'authentication_failed');
  assert.ok(dsErr.userMessage.includes('DeepSeek 请求失败'));

  // 第三方：使用用户命名的 Profile 名
  const thirdErr = buildProviderError({
    providerId: thirdProfileId,
    providerType: 'openai_compatible',
    providerName: '我的中转 API',
    modelId: 'custom-model',
    failure: { ok: false, error_kind: 'server', error_message: 'bad gateway', status: 502 },
  });
  assert.equal(thirdErr.providerLabel, '我的中转 API');
  assert.equal(thirdErr.code, 'provider_error');
  assert.ok(thirdErr.userMessage.includes('我的中转 API 请求失败'));

  // 标签映射 / code 提取
  assert.equal(providerFailureLabel('glm_official'), '智谱 GLM');
  assert.equal(providerFailureLabel('deepseek_official'), 'DeepSeek');
  assert.equal(providerFailureLabel('openai_compatible', 'X 中转'), 'X 中转');
  assert.equal(extractProviderCode('[code: 1113] (HTTP 429)'), '1113');
  assert.equal(extractProviderCode('no code here'), undefined);
  console.log('✓ ProviderError：GLM/DeepSeek/第三方文案 Provider 化；原始 code/status 保留');
}

// ============ 四、Planner 失败归因（promptPlanner 静态断言）============

{
  const plannerMod = await loadTs('../src/utils/agent/promptPlanner.ts');
  const { planningFailedResult } = plannerMod;

  const baseInput = {
    text: '画一只猫',
    hasEditableImage: false,
    agentToken: 'tok',
    agentModel: 'glm-5.2',
    agentBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    providerFailure: { providerId: glmProfileId, providerType: 'glm_official', providerName: '智谱 GLM' },
  };

  // 带 diagnostic（真实 Provider 调用失败）→ 必须带 Provider 前缀
  const failed = planningFailedResult(baseInput, 'raw failure', { errorKind: 'rate_limit' });
  assert.ok(
    failed.errorMessage.startsWith('智谱 GLM 请求失败：'),
    `Planner 失败文案必须归因 Provider，实际：${failed.errorMessage}`,
  );

  // 无 diagnostic（本地校验失败，如输入为空）→ 不套 Provider 前缀
  const localFailed = planningFailedResult(baseInput, '输入为空，无法规划任务。');
  assert.ok(
    !localFailed.errorMessage.includes('请求失败'),
    `本地校验错误不得误标 Provider 前缀，实际：${localFailed.errorMessage}`,
  );

  // 未传 providerFailure（旧调用方）→ 行为不变
  const legacyFailed = planningFailedResult({ ...baseInput, providerFailure: undefined }, 'raw', { errorKind: 'connect' });
  assert.ok(!legacyFailed.errorMessage.includes('智谱'));
  console.log('✓ Planner 失败归因：Provider 调用失败带「智谱 GLM 请求失败：」前缀；本地错误不误标');
}

console.log('\n全部通过：provider-runtime');
