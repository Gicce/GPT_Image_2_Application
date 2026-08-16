// 静态 smoke 测试 -- node scripts/agent-model-testing.smoke.mjs
//
// 验证模型测试服务的错误分类与边界行为（v3.1 统一 ModelErrorCode）：
//   1. classifyModelErrorCode：401/403/404/429/timeout/network/5xx 正确映射
//   2. 快速 / 深度检测：配置不完整 -> missing_api_key，且不发起任何请求
//   3. 测试调用不得写入 Conversation（纯诊断 -- modelTest 模块不依赖任何 chat store）

import assert from 'node:assert/strict';
import { loadTs } from './_ts_loader.mjs';

const mod = await loadTs('../src/features/aiProviders/modelTest.ts');
const { classifyModelError, quickTestModelAvailability, deepTestModelAvailability, MODEL_ERROR_LABELS } = mod;

// ============ 一、错误分类映射 ============

{
  assert.equal(classifyModelError({ httpStatus: 401 }), 'authentication_failed');
  assert.equal(classifyModelError({ errorKind: 'auth' }), 'authentication_failed');
  assert.equal(classifyModelError({ message: 'Invalid API key provided' }), 'authentication_failed');

  assert.equal(classifyModelError({ httpStatus: 403 }), 'permission_denied');

  // 裸 404 不能等同"模型不存在"（可能是 endpoint 路径错误）；
  // 只有 Provider 在真实调用中明确指出（错误码 / 消息）才映射 model_not_found。
  assert.equal(classifyModelError({ httpStatus: 404 }), 'provider_error');
  assert.equal(classifyModelError({ errorKind: 'model_not_found' }), 'model_not_found');
  assert.equal(classifyModelError({ message: 'model_not_found: no such model' }), 'model_not_found');
  assert.equal(classifyModelError({ message: '请求的模型不存在（code: 1211）' }), 'model_not_found');

  assert.equal(classifyModelError({ httpStatus: 429 }), 'rate_limited');
  assert.equal(classifyModelError({ message: 'Rate limit reached for requests' }), 'rate_limited');

  assert.equal(classifyModelError({ errorKind: 'timeout' }), 'timeout');
  assert.equal(classifyModelError({ message: 'request timed out after 60s' }), 'timeout');

  assert.equal(classifyModelError({ httpStatus: 500 }), 'provider_error');
  assert.equal(classifyModelError({ httpStatus: 503 }), 'provider_error');
  assert.equal(classifyModelError({ errorKind: 'server' }), 'provider_error');
  assert.equal(classifyModelError({ errorKind: 'model_error' }), 'provider_error');

  assert.equal(classifyModelError({ errorKind: 'connect' }), 'network_error');
  assert.equal(classifyModelError({ message: 'fetch failed: connection refused' }), 'network_error');

  // 每个错误码都有可理解的用户文案 + 处理建议
  for (const label of Object.values(MODEL_ERROR_LABELS)) {
    assert.ok(typeof label === 'string' && label.length > 0);
  }
  console.log('✓ 401/403/404/429/timeout/5xx/network 全部正确映射到统一错误码');
}

// ============ 二、配置不完整 -> missing_api_key，零请求 ============

{
  const noUrl = await quickTestModelAvailability({ base_url: '', api_key: 'k', fallback_token: '', provider_type: 'openai_compatible' }, { model_id: 'm' });
  assert.equal(noUrl.ok, false);
  assert.equal(noUrl.errorCode, 'missing_api_key');
  assert.equal(noUrl.latencyMs, 0);

  const noKey = await quickTestModelAvailability({ base_url: 'https://example.com/v1', api_key: '', fallback_token: '', provider_type: 'openai_compatible' }, { model_id: 'm' });
  assert.equal(noKey.errorCode, 'missing_api_key');

  const noModel = await quickTestModelAvailability({ base_url: 'https://example.com/v1', api_key: 'k', fallback_token: '', provider_type: 'openai_compatible' }, { model_id: '' });
  assert.equal(noModel.errorCode, 'missing_api_key');

  const deepNoKey = await deepTestModelAvailability({ base_url: '', api_key: '', fallback_token: '', provider_type: 'openai_compatible' }, { model_id: 'm' });
  assert.equal(deepNoKey.errorCode, 'missing_api_key');
  console.log('✓ 配置不完整 -> missing_api_key，不发起请求');
}

// ============ 三、fallback_token 兜底语义（深度检测） ============

{
  // api_key 为空但 fallback_token 存在 -> 不算 missing_api_key（会尝试真实请求，node 下 invoke 抛错 -> 结构化失败）
  const outcome = await deepTestModelAvailability(
    { base_url: 'https://example.com/v1', api_key: '', fallback_token: 'fb-token', provider_type: 'openai_compatible' },
    { model_id: 'm' },
  );
  assert.equal(outcome.ok, false);
  assert.notEqual(outcome.errorCode, 'missing_api_key', '有 fallback token 时不属于配置缺失');
  assert.ok(typeof outcome.latencyMs === 'number');
  assert.ok(outcome.errorMessage, '失败必须带可读信息');
  console.log('✓ fallback_token 兜底语义正确（区分"未配置"与"请求失败"）');
}

// ============ 四、测试不污染聊天的结构保证 ============

// modelTest.ts 是纯模块：不 import useChatStore / useAIProviderStore，
// 从模块依赖层面保证测试调用不可能写入 Conversation / 创建 Task / 触发 Handoff。
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/features/aiProviders/modelTest.ts'),
    'utf8',
  );
  assert.ok(!src.includes('useChatStore'), 'modelTest 不得依赖 useChatStore');
  assert.ok(!src.includes('useAIProviderStore'), 'modelTest 不得依赖 profile store（避免写状态）');
  const adaptersSrc = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/features/aiProviders/adapters.ts'),
    'utf8',
  );
  assert.ok(adaptersSrc.includes('Respond with exactly: OK'), '深度测试必须是最小 completion');
  assert.ok(adaptersSrc.includes('listProviderModels'), '快速检测必须走 Rust list_provider_models（禁止前端 fetch）');
  console.log('✓ 模型检测为纯诊断调用（快速走 /models，深度为最小 completion）');
}

console.log('\n全部通过：agent-model-testing');
