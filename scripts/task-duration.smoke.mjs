// 静态 smoke 测试 —— node scripts/task-duration.smoke.mjs
//
// 验证任务执行耗时（src/utils/taskDuration.ts + useChatStore buildTaskMessageFromTask
// 的 duration 推导逻辑）。
//
// 通过 esbuild 加载真实 TS 实现；buildTaskMessageFromTask 属于 store（有外部依赖），
// 这里用等价的最小实现验证相同的推导规则（规则同步自 useChatStore.ts）。

import assert from 'node:assert/strict';
import { loadTs } from './_ts_loader.mjs';

const durationMod = await loadTs('../src/utils/taskDuration.ts');
const { formatDuration, formatDurationPrecise, computeDurationMs, liveElapsedMs, executionVerbLabel } = durationMod;

// ============ 一、formatDuration（spec 五十八、一百节）============

assert.equal(formatDuration(800), '0.8 秒', '800ms → 0.8 秒');
assert.equal(formatDuration(18400), '18.4 秒', '18400ms → 18.4 秒');
assert.equal(formatDuration(72400), '1分12.4秒', '72400ms → 1分12.4秒');
assert.equal(formatDuration(0), '0.0 秒', '0ms 边界');
assert.equal(formatDuration(undefined), '', 'undefined → 空');
assert.equal(formatDuration(null), '', 'null → 空');
assert.equal(formatDuration(-5), '', '负数 → 空');
console.log('✓ formatDuration 规则');

// 精确格式（spec 五十七节）
assert.equal(formatDurationPrecise(12846), '12.846 秒（12846 ms）', '精确毫秒格式');
console.log('✓ formatDurationPrecise');

// ============ 二、computeDurationMs（spec 九十七节）============

assert.equal(computeDurationMs(1000, 6500), 5500, 'start=1000 finish=6500 → 5500');
assert.equal(computeDurationMs(undefined, 6500), null, '缺 start → null');
assert.equal(computeDurationMs(1000, undefined), null, '缺 finish → null');
assert.equal(computeDurationMs(6500, 1000), null, 'end < start → null（时钟回拨守卫）');
assert.equal(computeDurationMs('2026-01-01T00:00:00Z', '2026-01-01T00:00:02Z'), 2000, 'ISO 字符串输入');
console.log('✓ computeDurationMs');

// ============ 三、liveElapsedMs（执行中实时显示）============

const now = Date.now();
assert.equal(liveElapsedMs(now - 6700, now), 6700, '7 秒前开始 → 6700ms');
assert.equal(liveElapsedMs(undefined, now), null, '无 startedAt → null');
assert.equal(liveElapsedMs(now + 5000, now), 0, '未来时间（异常）→ 0 封顶');
console.log('✓ liveElapsedMs');

// ============ 四、executionVerbLabel（spec 一百零四、一百零五节）============

assert.equal(executionVerbLabel('generate'), '正在生成图片', 'generate → 生成');
assert.equal(executionVerbLabel('edit'), '正在编辑图片', 'edit → 编辑');
assert.equal(executionVerbLabel('edit', 'image_edit'), '正在编辑图片', 'image_edit → 编辑');
assert.equal(executionVerbLabel('remove_background'), '正在执行', 'remove_background → 执行');
assert.equal(executionVerbLabel(undefined), '正在生成图片', '默认 → 生成');
console.log('✓ executionVerbLabel');

// ============ 五、buildTaskMessageFromTask duration 推导规则 ============
// （与 useChatStore.ts 中实现同步的镜像 —— 规则：终态时 finishedAt=now，
//   durationMs = now - startedAt；执行中 duration 保持 undefined）

function deriveExecutionTiming(taskStatus, base) {
  const nowIso = '2026-01-01T00:01:00Z';
  const executionStartedAt = base?.executionStartedAt;
  const isTerminal = taskStatus === 'completed' || taskStatus === 'failed' || taskStatus === 'cancelled';
  let executionFinishedAt = base?.executionFinishedAt;
  let executionDurationMs = base?.executionDurationMs;
  if (isTerminal && executionStartedAt && !executionFinishedAt) {
    executionFinishedAt = nowIso;
    const start = Date.parse(executionStartedAt);
    if (Number.isFinite(start) && start > 0) {
      executionDurationMs = Math.max(0, Date.parse(nowIso) - start);
    }
  }
  return { executionStartedAt, executionFinishedAt, executionDurationMs };
}

// 成功：start=1000(相对) finish → 5500ms（spec 九十七节）
{
  const startIso = '2026-01-01T00:00:54.5Z';
  const r = deriveExecutionTiming('completed', { executionStartedAt: startIso });
  assert.equal(r.executionDurationMs, 5500, `成功 duration=5500 (got ${r.executionDurationMs})`);
  assert.ok(r.executionFinishedAt, 'finishedAt defined');
}
console.log('✓ 成功任务 duration 计算');

// 失败也保存（spec 九十八节）
{
  const startIso = '2026-01-01T00:00:56.4Z';
  const r = deriveExecutionTiming('failed', { executionStartedAt: startIso });
  assert.ok(r.executionFinishedAt, '失败 finishedAt defined');
  assert.equal(r.executionDurationMs, 3600, '失败 duration=3600');
}
console.log('✓ 失败任务 duration 保存');

// 执行中：duration 保持 undefined（UI 用 liveElapsedMs）
{
  const r = deriveExecutionTiming('running', { executionStartedAt: '2026-01-01T00:00:00Z' });
  assert.equal(r.executionDurationMs, undefined, '执行中 duration=undefined');
  assert.equal(r.executionFinishedAt, undefined, '执行中 finishedAt=undefined');
}
console.log('✓ 执行中不提前固化 duration');

// Planning 不计时（spec 九十九节）：waiting_confirm / planning 状态没有 startedAt
{
  const r = deriveExecutionTiming('pending', {});
  assert.equal(r.executionStartedAt, undefined, 'waiting_confirm 无 startedAt（用户确认才开始）');
}
console.log('✓ Planning / 等待确认不计时');

// 已计算的 duration 不被覆盖（幂等）
{
  const r = deriveExecutionTiming('completed', {
    executionStartedAt: '2026-01-01T00:00:00Z',
    executionFinishedAt: '2026-01-01T00:00:18.4Z',
    executionDurationMs: 18400,
  });
  assert.equal(r.executionDurationMs, 18400, '已有 duration 不被重算覆盖');
}
console.log('✓ duration 幂等不被覆盖');

// ============ 六、并发任务互不干扰（spec 一百零二节）============

{
  const taskA = deriveExecutionTiming('running', { executionStartedAt: '2026-01-01T00:00:00Z' });
  const taskB = deriveExecutionTiming('running', { executionStartedAt: '2026-01-01T00:00:10Z' });
  assert.notEqual(taskA.executionStartedAt, taskB.executionStartedAt, 'A/B startedAt 独立');
  const liveA = liveElapsedMs(taskA.executionStartedAt, Date.parse('2026-01-01T00:00:12Z'));
  const liveB = liveElapsedMs(taskB.executionStartedAt, Date.parse('2026-01-01T00:00:12Z'));
  assert.equal(liveA, 12000, 'A 已执行 12 秒');
  assert.equal(liveB, 2000, 'B 已执行 2 秒');
}
console.log('✓ 并发任务计时互不干扰');

// ============ 七、静态审计：timer 不每 tick 持久化（spec 一百零一节）============

{
  const fs = await import('node:fs');
  const chatStore = fs.readFileSync('src/components/TaskMessageCard.tsx', 'utf8');
  // elapsedTick interval 只调用 setElapsedTick（local UI state），
  // 不得出现 saveConversation / scheduleSaveConversation 调用。
  const timerBlockMatch = chatStore.match(/const timer = setInterval\(\(\) => setElapsedTick\(t => t \+ 1\), 250\);[\s\S]{0,400}?return \(\) => clearInterval\(timer\);/);
  assert.ok(timerBlockMatch, '存在 250ms elapsed timer');
  assert.ok(!timerBlockMatch[0].includes('saveConversation'), 'timer 内无持久化调用');
  assert.ok(!timerBlockMatch[0].includes('scheduleSaveConversation'), 'timer 内无 debounced 持久化');
  console.log('✓ Timer 不每 tick 持久化（静态审计）');
}

// ============ 八、静态审计：组件卸载清理（spec 六十七节）============

{
  const fs = await import('node:fs');
  const chatStore = fs.readFileSync('src/components/TaskMessageCard.tsx', 'utf8');
  assert.ok(
    /useEffect\(\(\) => \{\s*if \(!isExecutionTimingStage \|\| !state\.executionStartedAt \|\| state\.executionDurationMs != null\) return;\s*const timer = setInterval[\s\S]*?return \(\) => clearInterval\(timer\);/.test(chatStore),
    'elapsed timer useEffect 有 clearInterval cleanup',
  );
  console.log('✓ Timer cleanup（静态审计）');
}

console.log('\n全部 task-duration smoke tests 通过');
