// 简易手跑 smoke 测试：node scripts/negative-prompt-normalize.smoke.mjs
//
// 镜像 src/utils/agent/promptPlanner.ts 中的 normalizeOptionalPrompt 实现。
// 验证 negativePrompt / finalPrompt 类型安全归一化：
//   - 字符串原样返回（trim）
//   - 空字符串 → undefined
//   - 数字（1/0） → undefined  ← 这是 spec 中 "负面提示词 1" 的根因
//   - 布尔值 → undefined
//   - null / undefined → undefined
//   - 对象 / 数组 → undefined
//
// 旧实现 `String(value || '')` 会把 1 → "1"、true → "true"，最终在确认卡上
// 显示"负面提示词：1"。新实现拒绝任何非字符串类型。

import assert from 'node:assert';

function normalizeOptionalPrompt(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log('Negative Prompt Normalize smoke tests');

check('legit string passes through', () => {
  assert.strictEqual(normalizeOptionalPrompt('低清晰度、错误肢体'), '低清晰度、错误肢体');
});

check('string with whitespace is trimmed', () => {
  assert.strictEqual(normalizeOptionalPrompt('  hello  '), 'hello');
});

check('empty string becomes undefined', () => {
  assert.strictEqual(normalizeOptionalPrompt(''), undefined);
  assert.strictEqual(normalizeOptionalPrompt('   '), undefined);
});

check('number 1 becomes undefined (was the bug)', () => {
  // 这是 spec 第一百零一节列出的"负面提示词 1"根因：
  // Planner 偶尔输出 "final_negative_prompt": 1（数字），旧代码 String(1) = "1"。
  assert.strictEqual(normalizeOptionalPrompt(1), undefined);
});

check('number 0 becomes undefined', () => {
  assert.strictEqual(normalizeOptionalPrompt(0), undefined);
});

check('boolean true / false become undefined', () => {
  assert.strictEqual(normalizeOptionalPrompt(true), undefined);
  assert.strictEqual(normalizeOptionalPrompt(false), undefined);
});

check('null / undefined become undefined', () => {
  assert.strictEqual(normalizeOptionalPrompt(null), undefined);
  assert.strictEqual(normalizeOptionalPrompt(undefined), undefined);
});

check('object / array become undefined', () => {
  assert.strictEqual(normalizeOptionalPrompt({ foo: 'bar' }), undefined);
  assert.strictEqual(normalizeOptionalPrompt(['a', 'b']), undefined);
});

check('UI conditional `{state.finalNegativePrompt && ...}` would NOT render when normalized to undefined', () => {
  // 模拟 React 渲染条件
  const state = { finalNegativePrompt: normalizeOptionalPrompt(1) };
  assert.strictEqual(Boolean(state.finalNegativePrompt), false);
});

check('UI conditional renders legit negative prompt', () => {
  const state = { finalNegativePrompt: normalizeOptionalPrompt('乱码、畸形') };
  assert.ok(state.finalNegativePrompt);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
