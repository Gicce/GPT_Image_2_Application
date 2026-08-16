// 简易手跑 smoke 测试：node scripts/clarification-state-machine.smoke.mjs
//
// 这份测试镜像 src/store/useChatStore.ts 中的辅助函数：
//   - looksLikeExplicitNewTask(text)
//   - buildClarificationContinuationText({ originalRequest, clarificationQuestion, userAnswer, attempt })
//   - findPendingClarificationTask(conversation) （构造测试用 conversation 数据）
//
// 验证以下 spec 关键场景：
//   1. 用户在 needs_clarification 后输入"黑崎一护" → 不是新任务，应作为补充回答
//   2. 用户在 needs_clarification 后输入"给我生成一张日本街道夜景" → 是新任务，不被吸附
//   3. clarification 续接文本必须同时包含原始任务、问题、用户补充、轮次
//   4. findPendingClarificationTask 找到最近一张 needs_clarification 卡
//   5. findPendingClarificationTask 遇到中间的 waiting_confirm / success 等态时停止向前查找

import assert from 'node:assert';

// ---------- mirror of looksLikeExplicitNewTask ----------
function looksLikeExplicitNewTask(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (t.length > 80) return true;
  const newTaskPatterns = [
    /^(?:给我|帮我|请|想要|来一张|来一个|新建|重新做|再做一张|再来一张|画一张|画一个|生成一张|生成一个|做一张|做一个)/,
    /(再生成|新生成|新做一张|新画一张)/,
  ];
  return newTaskPatterns.some(re => re.test(t));
}

// ---------- mirror of buildClarificationContinuationText ----------
function buildClarificationContinuationText(input) {
  const { originalRequest, clarificationQuestion, userAnswer, attempt } = input;
  const lines = [];
  lines.push('[任务补充上下文]');
  lines.push('- 以下是一段"原任务 + Planner 上一轮 clarification + 用户本轮补充"的组合，必须视为同一个任务的完整描述。');
  lines.push('- 不要再把本轮内容当成独立新任务。');
  lines.push(`- clarification_round: ${attempt}（这是第 ${attempt} 次补充；如果你仍然打算再次询问已经在下面回答过的信息，必须停止并直接给出 ready 规划。）`);
  lines.push('');
  lines.push('[原始任务]');
  lines.push(originalRequest || '(无)');
  lines.push('');
  lines.push('[上一轮 Planner 要求补充的信息]');
  lines.push(clarificationQuestion || '(无)');
  lines.push('');
  lines.push('[用户本轮补充]');
  lines.push(userAnswer || '(无)');
  lines.push('');
  lines.push('请基于以上完整信息重新生成可执行规划，不要再次询问已经补充过的信息。');
  return lines.join('\n');
}

// ---------- mirror of findPendingClarificationTask ----------
function findPendingClarificationTask(conversation) {
  if (!conversation) return null;
  for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
    const m = conversation.messages[i];
    const tm = m.task_message;
    if (!tm) continue;
    if (tm.stage === 'needs_clarification') {
      return { message: m, task: tm };
    }
    if (
      tm.stage === 'waiting_confirm'
      || tm.stage === 'running'
      || tm.stage === 'success'
      || tm.stage === 'failed'
      || tm.stage === 'cancelled'
      || tm.stage === 'planning'
    ) {
      return null;
    }
  }
  return null;
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

console.log('Clarification State Machine smoke tests');

// ---------- looksLikeExplicitNewTask ----------
check('character name only ("黑崎一护") is NOT a new task', () => {
  assert.strictEqual(looksLikeExplicitNewTask('黑崎一护'), false);
});

check('short place/style answers are NOT new tasks', () => {
  assert.strictEqual(looksLikeExplicitNewTask('东京'), false);
  assert.strictEqual(looksLikeExplicitNewTask('夜晚'), false);
  assert.strictEqual(looksLikeExplicitNewTask('赛博朋克风格'), false);
});

check('"给我生成一张日本街道夜景" IS a new task', () => {
  assert.strictEqual(looksLikeExplicitNewTask('给我生成一张日本街道夜景'), true);
});

check('"再来一张" IS a new task (used by regenerate flow)', () => {
  assert.strictEqual(looksLikeExplicitNewTask('再来一张'), true);
});

check('"画一张XXX" IS a new task', () => {
  assert.strictEqual(looksLikeExplicitNewTask('画一张故宫雪景'), true);
});

check('long text (>80 chars) is treated as new task', () => {
  // 注意 JavaScript .length 按 UTF-16 code unit 计数；中文每个字符 = 1 code unit。
  // 这里故意拼一段 ≥81 字符的长描述，验证"长输入视为新任务"的保护。
  const long = '我希望在画面左侧加上一棵很大的樱花树，树下有一只小猫，整体氛围要像新海诚的风格，色彩鲜艳，光影柔和，远景是富士山，画面右上角再放一只飞鸟，整体色调偏冷，画面中央要有一个穿校服的女孩';
  assert.ok(long.length > 80, `expected >80 chars, got ${long.length}`);
  assert.strictEqual(looksLikeExplicitNewTask(long), true);
});

check('empty input is not a new task', () => {
  assert.strictEqual(looksLikeExplicitNewTask(''), false);
  assert.strictEqual(looksLikeExplicitNewTask('   '), false);
});

// ---------- buildClarificationContinuationText ----------
check('continuation text contains original task, question, answer, and round', () => {
  const text = buildClarificationContinuationText({
    originalRequest: '给我生成一张《死神》动漫里的人物全画像',
    clarificationQuestion: '请指定《死神》中的具体角色，例如黑崎一护、朽木露琪亚等。',
    userAnswer: '黑崎一护',
    attempt: 1,
  });
  assert.ok(text.includes('给我生成一张《死神》动漫里的人物全画像'), 'must include original');
  assert.ok(text.includes('请指定《死神》中的具体角色'), 'must include question');
  assert.ok(text.includes('黑崎一护'), 'must include user answer');
  assert.ok(text.includes('clarification_round: 1'), 'must include attempt number');
  assert.ok(text.includes('不要再次询问'), 'must instruct planner not to re-ask');
});

// ---------- findPendingClarificationTask ----------
function mkMessage(id, stage) {
  return {
    id,
    role: 'assistant',
    task_message: { taskId: `task_${id}`, stage },
  };
}

check('findPendingClarificationTask returns the most recent needs_clarification card', () => {
  const conv = {
    id: 'c1',
    messages: [
      mkMessage('m1', 'success'),
      mkMessage('m2', 'needs_clarification'),
    ],
  };
  const r = findPendingClarificationTask(conv);
  assert.ok(r);
  assert.strictEqual(r.message.id, 'm2');
});

check('findPendingClarificationTask stops at any newer non-clarification task', () => {
  // 用户已经走过 clarification，进入 waiting_confirm —— 不应再吸附到旧 clarification。
  const conv = {
    id: 'c1',
    messages: [
      mkMessage('m1', 'needs_clarification'),
      mkMessage('m2', 'waiting_confirm'),
    ],
  };
  const r = findPendingClarificationTask(conv);
  assert.strictEqual(r, null);
});

check('findPendingClarificationTask stops at success', () => {
  const conv = {
    id: 'c1',
    messages: [
      mkMessage('m1', 'needs_clarification'),
      mkMessage('m2', 'success'),
    ],
  };
  const r = findPendingClarificationTask(conv);
  assert.strictEqual(r, null);
});

check('findPendingClarificationTask returns null when no clarification exists', () => {
  const conv = {
    id: 'c1',
    messages: [mkMessage('m1', 'success')],
  };
  assert.strictEqual(findPendingClarificationTask(conv), null);
});

check('findPendingClarificationTask returns null for empty conversation', () => {
  assert.strictEqual(findPendingClarificationTask({ id: 'c1', messages: [] }), null);
  assert.strictEqual(findPendingClarificationTask(undefined), null);
});

// ---------- end-to-end style scenario ----------
check('scenario: 死神 → clarification → 黑崎一护 should route as answer', () => {
  // 1. 当前会话有一张 needs_clarification 卡
  const conv = {
    id: 'c1',
    messages: [
      mkMessage('m_clar', 'needs_clarification'),
    ],
  };
  const pending = findPendingClarificationTask(conv);
  assert.ok(pending, 'should find pending clarification');

  // 2. 用户输入 "黑崎一护"
  const userAnswer = '黑崎一护';
  assert.strictEqual(looksLikeExplicitNewTask(userAnswer), false, 'should NOT be flagged as new task');

  // 3. 构造的续接文本同时包含原始任务和用户回答
  const text = buildClarificationContinuationText({
    originalRequest: '给我生成一张《死神》动漫里的人物全画像',
    clarificationQuestion: '请指定具体角色',
    userAnswer,
    attempt: 1,
  });
  assert.ok(text.includes('死神'));
  assert.ok(text.includes('黑崎一护'));
});

check('scenario: pending clarification + "给我生成日本街道夜景" should NOT route as answer', () => {
  const conv = {
    id: 'c1',
    messages: [mkMessage('m_clar', 'needs_clarification')],
  };
  const pending = findPendingClarificationTask(conv);
  assert.ok(pending);

  const userText = '给我生成一张日本街道夜景';
  // 这条输入明显是新任务 → sendTaskMessage 应该走"新建任务"路径而不是 clarification 续接。
  assert.strictEqual(looksLikeExplicitNewTask(userText), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
