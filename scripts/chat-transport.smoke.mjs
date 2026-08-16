// 静态 smoke 测试 —— node scripts/chat-transport.smoke.mjs
//
// 验证 Model Transport Capability Resolver：
//   1. gpt-5.6-luna 在 chat 模式下必须解析为 ['responses', 'chat_completions']。
//      —— 不允许走 chat_completions 主路径，否则上游回 HTTP 400 protocol_not_supported。
//   2. gpt-5.6 家族（gpt-5.6, gpt-5.6-mini 等）同样默认 Responses-only。
//   3. 其它模型（gpt-5.4 / gpt-4o / claude-... 等）保持 chat_completions 主路径，
//      responses 仅作为 protocol_not_supported 时的单次回退。
//   4. plan_task / interpret 模式不论模型都优先 Responses。
//   5. protocol_not_supported 必须归类为可触发协议回退的错误。
//   6. protocol fallback 最多一次 —— 不会无限切协议。
//
// 本文件镜像 src-tauri/src/commands.rs 的 resolve_transport_preference /
// model_prefer_responses_transport / is_protocol_not_supported 三个函数。
// Rust 端如果改了判定逻辑，这里必须同步。

import assert from 'node:assert';

// ---------------------- 镜像实现 ----------------------

function modelPreferResponsesTransport(model) {
  const lower = (model || '').trim().toLowerCase();
  if (!lower) return false;
  if (lower.startsWith('gpt-5.6') || lower.includes('5.6-luna')) return true;
  if (lower.endsWith('-responses')) return true;
  return false;
}

function resolveTransportPreference(model, mode) {
  const preferResponses =
    modelPreferResponsesTransport(model) || mode === 'interpret' || mode === 'plan_task';
  return preferResponses
    ? ['responses', 'chat_completions']
    : ['chat_completions', 'responses'];
}

// 镜像 classify_upstream_error 对 protocol_not_supported 的识别：
// 关键字 / code 必须与 Rust 端 message_contains_any 列表一致。
function classifyUpstreamError(status, detail, code) {
  const lower = (detail || '').toLowerCase();
  const codeLower = (code || '').toLowerCase();
  if (
    lower.includes('protocol_not_supported') ||
    lower.includes('不支持 chat completions') ||
    lower.includes('does not support chat completions') ||
    lower.includes('unsupported protocol') ||
    codeLower.includes('protocol_not_supported')
  ) {
    return 'protocol_not_supported';
  }
  if (status === 400 || status === 422) return 'invalid_request';
  return 'other';
}

// 模拟 run_agent_request 的协议回退：最多尝试 transport 列表里前两个 transport，
// 协议错误才前进，其它错误立即终止。
function simulateTransportRun(model, mode, responsesOutcome, chatCompletionsOutcome) {
  const order = resolveTransportPreference(model, mode);
  const attempts = [];
  for (const transport of order) {
    const outcome = transport === 'responses' ? responsesOutcome : chatCompletionsOutcome;
    attempts.push({ transport, outcome: outcome.kind });
    if (outcome.kind === 'ok') {
      return { ok: true, used: transport, attempts };
    }
    if (outcome.kind === 'protocol_not_supported') {
      // 仅在 protocol_not_supported 时前进到下一个 transport
      continue;
    }
    // 其它错误：终止，不无限切协议
    return { ok: false, used: transport, attempts, errorKind: outcome.kind };
  }
  // 所有 transport 都失败
  return { ok: false, used: null, attempts, errorKind: 'all_protocols_failed' };
}

// ---------------------- 断言 ----------------------

let testCount = 0;
let passCount = 0;
function test(name, fn) {
  testCount += 1;
  try {
    fn();
    passCount += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

// ---------------------- 测试用例 ----------------------

console.log('chat-transport.smoke: Model Transport Resolver + protocol fallback');

test('gpt-5.6-luna (chat) → 优先 Responses', () => {
  assert.deepEqual(resolveTransportPreference('gpt-5.6-luna', 'chat'), [
    'responses',
    'chat_completions',
  ]);
});

test('gpt-5.6-luna (plan_task) → 优先 Responses', () => {
  assert.deepEqual(resolveTransportPreference('gpt-5.6-luna', 'plan_task'), [
    'responses',
    'chat_completions',
  ]);
});

test('gpt-5.6-luna (interpret) → 优先 Responses', () => {
  assert.deepEqual(resolveTransportPreference('gpt-5.6-luna', 'interpret'), [
    'responses',
    'chat_completions',
  ]);
});

test('gpt-5.6 家族（不带 -luna）也走 Responses', () => {
  assert.deepEqual(resolveTransportPreference('gpt-5.6', 'chat'), [
    'responses',
    'chat_completions',
  ]);
  assert.deepEqual(resolveTransportPreference('gpt-5.6-mini', 'chat'), [
    'responses',
    'chat_completions',
  ]);
});

test('gpt-5.4 (chat) → 保持 chat_completions 主路径', () => {
  // gpt-5.4 当前是 chat completions 兼容的；不能凭假设一刀切到 Responses。
  assert.deepEqual(resolveTransportPreference('gpt-5.4', 'chat'), [
    'chat_completions',
    'responses',
  ]);
});

test('其它模型 (chat) → chat_completions 主路径，Responses 作 fallback', () => {
  assert.deepEqual(resolveTransportPreference('gpt-4o', 'chat'), [
    'chat_completions',
    'responses',
  ]);
  assert.deepEqual(resolveTransportPreference('claude-sonnet-4', 'chat'), [
    'chat_completions',
    'responses',
  ]);
});

test('空模型名 → 默认 chat_completions', () => {
  assert.deepEqual(resolveTransportPreference('', 'chat'), [
    'chat_completions',
    'responses',
  ]);
});

test('plan_task 模式覆盖模型偏好 —— 一律优先 Responses', () => {
  assert.deepEqual(resolveTransportPreference('gpt-4o', 'plan_task'), [
    'responses',
    'chat_completions',
  ]);
});

test('interpret 模式覆盖模型偏好 —— 一律优先 Responses', () => {
  assert.deepEqual(resolveTransportPreference('gpt-4o', 'interpret'), [
    'responses',
    'chat_completions',
  ]);
});

test('classify: protocol_not_supported (中文) 正确归类', () => {
  assert.equal(
    classifyUpstreamError(400, '模型 gpt-5.6-luna 不支持 chat completions 协议', null),
    'protocol_not_supported',
  );
});

test('classify: protocol_not_supported (英文) 正确归类', () => {
  assert.equal(
    classifyUpstreamError(400, 'model does not support chat completions', null),
    'protocol_not_supported',
  );
});

test('classify: code=protocol_not_supported 正确归类', () => {
  assert.equal(classifyUpstreamError(400, 'Bad request', 'protocol_not_supported'), 'protocol_not_supported');
});

test('classify: 普通 400 invalid_request 不会被误判为协议错误', () => {
  assert.equal(classifyUpstreamError(400, 'messages.0.content is required', null), 'invalid_request');
});

test('protocol fallback：Responses primary 成功 → 不会调用 chat_completions', () => {
  const r = simulateTransportRun(
    'gpt-5.6-luna',
    'chat',
    { kind: 'ok' },
    { kind: 'should-not-be-called' },
  );
  assert.equal(r.ok, true);
  assert.equal(r.used, 'responses');
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].transport, 'responses');
});

test('protocol fallback：chat_completions primary 成功 → 不会调用 Responses', () => {
  const r = simulateTransportRun(
    'gpt-5.4',
    'chat',
    { kind: 'should-not-be-called' },
    { kind: 'ok' },
  );
  assert.equal(r.ok, true);
  assert.equal(r.used, 'chat_completions');
  assert.equal(r.attempts.length, 1);
});

test('protocol fallback：Responses 返回 protocol_not_supported → 回退 chat_completions 一次', () => {
  const r = simulateTransportRun(
    'gpt-5.6-luna',
    'chat',
    { kind: 'protocol_not_supported' },
    { kind: 'ok' },
  );
  assert.equal(r.ok, true);
  assert.equal(r.used, 'chat_completions');
  assert.equal(r.attempts.length, 2);
});

test('protocol fallback：chat_completions 返回 protocol_not_supported → 回退 Responses 一次', () => {
  const r = simulateTransportRun(
    'gpt-5.4',
    'chat',
    { kind: 'ok' },
    { kind: 'protocol_not_supported' },
  );
  assert.equal(r.ok, true);
  assert.equal(r.used, 'responses');
  assert.equal(r.attempts.length, 2);
});

test('protocol fallback：两个 transport 都 protocol_not_supported → 不会无限循环', () => {
  const r = simulateTransportRun(
    'gpt-5.6-luna',
    'chat',
    { kind: 'protocol_not_supported' },
    { kind: 'protocol_not_supported' },
  );
  assert.equal(r.ok, false);
  assert.equal(r.attempts.length, 2); // 最多两次，不会循环
  assert.equal(r.errorKind, 'all_protocols_failed');
});

test('protocol fallback：Responses 上的非协议错误立即终止，不切到 chat_completions', () => {
  const r = simulateTransportRun(
    'gpt-5.6-luna',
    'chat',
    { kind: 'auth' },
    { kind: 'should-not-be-called' },
  );
  assert.equal(r.ok, false);
  assert.equal(r.attempts.length, 1);
  assert.equal(r.errorKind, 'auth');
});

test('protocol fallback：chat_completions 上的非协议错误立即终止，不切到 Responses', () => {
  const r = simulateTransportRun(
    'gpt-5.4',
    'chat',
    { kind: 'should-not-be-called' },
    { kind: 'rate_limit' },
  );
  assert.equal(r.ok, false);
  assert.equal(r.attempts.length, 1);
  assert.equal(r.errorKind, 'rate_limit');
});

// ---------------------- 总结 ----------------------

console.log(`\n${passCount}/${testCount} passed`);
if (passCount !== testCount) {
  console.error('chat-transport.smoke: FAILED');
  process.exit(1);
}
console.log('chat-transport.smoke: OK');
