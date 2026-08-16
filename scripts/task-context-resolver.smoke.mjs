// 静态 smoke 测试 —— node scripts/task-context-resolver.smoke.mjs
//
// 本文件不依赖 vitest / jest，只用 node 内置 assert。
// 它把 src/utils/agent/taskContextResolver.ts 的核心函数转写成等价的 JS 实现，
// 然后跑 spec 第十一节列出的几个核心场景。
//
// 如果 src/utils/agent/taskContextResolver.ts 改了规则，这里必须同步更新。
// 维护成本：复制规则字符串 + 改一下 import 风格（type-only / .ts → .mjs）。

import assert from 'node:assert';

// ---------------------- 规则定义（必须与 .ts 源同步）----------------------

const AUGMENTATION_PATTERNS = [
  /边上再(?:加上|来一个|补一个|放一个)/,
  /旁边再(?:加上|来一个|补一个|放一个)/,
  /左侧再(?:加上|来一个|补一个|放一个)/,
  /左侧再来一个/,
  /右边再(?:加上|来一个|补一个|放一个)/,
  /再(?:加上|补充|来一个|补一个|放一个|添加)/,
  /同时(?:加上|补充|添加|放入)/,
  /保留这个.{0,8}再/,
  /把他改成/,
  /把她改成/,
  /把它改成/,
  /换个姿势/,
  /换一个姿势/,
  /原型态/,
  /本体形态/,
  /本体/,
  /另一个形态/,
  /同一个角色/,
  /同角色/,
];

const PRONOUN_LIST = ['他', '她', '它', '这个', '这只', '这位'];

const NON_IMAGE_TASK_PATTERNS = [
  /帮我写.{0,4}(文案|文章|诗|邮件|朋友圈|微信)/,
  /写一段.{0,4}(文案|文章|介绍)/,
  /^翻译/,
  /解释一下.{0,8}代码/,
];

const MAX_LOOKBACK_MESSAGES = 8;

// ---------------------- helpers（与 .ts 同步）----------------------

function extractWorkTitle(text) {
  if (!text) return undefined;
  const angleMatch = text.match(/《([^《》]{1,80})》/);
  if (angleMatch) return angleMatch[1].trim();
  const doubleQuoteMatch = text.match(/["“”]([^"“”]{1,80})["“”]/);
  if (doubleQuoteMatch) return doubleQuoteMatch[1].trim();
  return undefined;
}

function extractPrimarySubject(text) {
  if (!text) return undefined;
  const candidates = [];

  const inWorkMatch = text.match(/(?:里的|中的|里面(?:的|的)?|里头(?:的)?)\s*([一-龥A-Za-z0-9·\-_/]{1,20})/);
  if (inWorkMatch && inWorkMatch[1]) candidates.push(inWorkMatch[1].trim());

  const roleKeywordMatch = text.match(/([一-龥A-Za-z0-9·\-_/]{1,20})\s*(?:这个角色|该角色|角色)/);
  if (roleKeywordMatch && roleKeywordMatch[1]) candidates.push(roleKeywordMatch[1].trim());

  const roleKeywordMatch2 = text.match(/(?:角色|主人公|主角|女主|男主)\s*([一-龥A-Za-z0-9·\-_/]{1,20})/);
  if (roleKeywordMatch2 && roleKeywordMatch2[1]) candidates.push(roleKeywordMatch2[1].trim());

  if (/(角色|里的|中的|主角|男主|女主|主人公)/.test(text)) {
    const commonSubjectMatch = text.match(/(萌王|史莱姆|利姆鲁|鲁路修|luffy|路飞|naruto|鸣人|saber|阿尔托莉雅)/i);
    if (commonSubjectMatch && commonSubjectMatch[1]) candidates.push(commonSubjectMatch[1].trim());
  }

  const aliases = [];
  for (const candidate of candidates) {
    if (candidate === '萌王') aliases.push('利姆鲁');
    if (candidate === '利姆鲁') aliases.push('萌王');
  }

  const seen = new Set();
  const unique = candidates.filter(item => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) return undefined;
  return { subject: unique[0], aliases: Array.from(new Set(aliases)) };
}

function isAugmentationMessage(text) {
  if (!text || !text.trim()) return false;
  if (text.length > 120) return false;
  return AUGMENTATION_PATTERNS.some(pattern => pattern.test(text));
}

function isNonImageTaskMessage(text) {
  if (!text || !text.trim()) return false;
  return NON_IMAGE_TASK_PATTERNS.some(pattern => pattern.test(text));
}

function resolveTaskSemanticContext(input) {
  const currentMessage = (input.currentMessage || '').trim();
  const sourceMessages = (input.sourceMessages || []).slice(-MAX_LOOKBACK_MESSAGES);

  const base = { currentMessage, sourceMessages, augmentationDetected: false, inheritedFromPreviousTurn: false };

  if (!currentMessage) return base;

  if (isNonImageTaskMessage(currentMessage)) return base;

  const augmentationDetected = isAugmentationMessage(currentMessage);
  const hasPronoun = PRONOUN_LIST.some(pronoun => currentMessage.includes(pronoun));

  let anchorIndex = -1;
  for (let i = sourceMessages.length - 1; i >= 0; i -= 1) {
    const msg = sourceMessages[i];
    if (!msg || !msg.text || !msg.text.trim()) continue;
    if (isNonImageTaskMessage(msg.text)) continue;
    anchorIndex = i;
    break;
  }

  if (anchorIndex < 0) return { ...base, augmentationDetected };

  const anchor = sourceMessages[anchorIndex];
  const shouldInherit = augmentationDetected || hasPronoun;
  if (!shouldInherit) return { ...base, augmentationDetected };

  const promptForExtract = anchor.finalPrompt || anchor.text;
  const workTitle = extractWorkTitle(promptForExtract) || extractWorkTitle(anchor.text);
  const subjectInfo = extractPrimarySubject(promptForExtract) || extractPrimarySubject(anchor.text);

  const pronounBindings = {};
  if (subjectInfo) {
    const subjectLabel = subjectInfo.aliases.length > 0
      ? `${subjectInfo.subject}/${subjectInfo.aliases.join('/')}`
      : subjectInfo.subject;
    for (const pronoun of PRONOUN_LIST) {
      if (currentMessage.includes(pronoun)) {
        pronounBindings[pronoun] = subjectLabel;
      }
    }
  }

  const augmentations = [];
  const augMatch = currentMessage.match(/(边上再(?:加上|来一个|补一个|放一个)[^，。！？,!?]*)/);
  if (augMatch) augmentations.push(augMatch[1].trim());
  const protoMatch = currentMessage.match(/((?:他|她|它|该|其)?\s*(?:的)?\s*(?:原型态|本体形态|本体|另一个形态|同角色[^，。！？,!?]*))/);
  if (protoMatch) augmentations.push(protoMatch[1].trim());

  return {
    ...base,
    augmentationDetected,
    inheritedFromPreviousTurn: true,
    workTitle,
    primarySubject: subjectInfo?.subject,
    subjectAliases: subjectInfo?.aliases,
    pronounBindings: Object.keys(pronounBindings).length > 0 ? pronounBindings : undefined,
    previousFinalPrompt: anchor.finalPrompt,
    previousTaskType: anchor.taskType,
    augmentations: augmentations.length > 0 ? augmentations : undefined,
  };
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
    console.error('    ' + err.message);
    process.exitCode = 1;
  }
}

console.log('\n[TaskContextResolver smoke] running scenarios...\n');

// 测试 1：多轮上下文继承 — 角色 + 补充形态（spec 第十一节 测试 1）
test('测试1 多轮继承：萌王 + 史莱姆原型态', () => {
  const sources = [
    {
      text: '给我生成一张《关于我转生变成史莱姆这档事》里的萌王，持剑姿势',
      finalPrompt: '《关于我转生变成史莱姆这档事》主角萌王（利姆鲁），持剑站立姿势，全身，写实风格',
      taskType: 'generate',
    },
  ];
  const ctx = resolveTaskSemanticContext({
    currentMessage: '我希望边上再加上他史莱姆的原型态',
    sourceMessages: sources,
  });

  assert.strictEqual(ctx.inheritedFromPreviousTurn, true, 'inheritedFromPreviousTurn 必须为 true');
  assert.strictEqual(ctx.augmentationDetected, true, 'augmentationDetected 必须为 true');
  assert.strictEqual(ctx.workTitle, '关于我转生变成史莱姆这档事', 'workTitle 必须继承');
  assert.strictEqual(ctx.primarySubject, '萌王', 'primarySubject 必须是萌王');
  assert.ok(ctx.subjectAliases && ctx.subjectAliases.includes('利姆鲁'), '别名必须包含利姆鲁');
  assert.ok(ctx.pronounBindings && ctx.pronounBindings['他'], '必须为他生成 pronounBinding');
  assert.ok(
    ctx.pronounBindings['他'].includes('萌王') && ctx.pronounBindings['他'].includes('利姆鲁'),
    '他 → 萌王/利姆鲁',
  );
});

// 测试 2：多轮上下文继承 — 补充语义识别（spec 第十一节 测试 2）
test('测试2 多轮继承："他的本体形态" 回指上一主体', () => {
  const sources = [
    {
      text: '给我生成一个角色站姿',
      finalPrompt: '一个角色站立姿势，全身',
      taskType: 'generate',
    },
  ];
  const ctx = resolveTaskSemanticContext({
    currentMessage: '左边再加一个他的本体形态',
    sourceMessages: sources,
  });

  assert.strictEqual(ctx.augmentationDetected, true);
  // "角色"作为主体应该被识别（"生成一个角色站姿"里的"角色"会被 role keyword 捕获）
  assert.ok(ctx.inheritedFromPreviousTurn, '应继承');
  assert.ok(ctx.pronounBindings?.['他'], '他的本体形态必须为他生成 pronounBinding');
});

// 测试 3：不相关任务不合并（spec 第十一节 测试 3）
test('测试3 不相关任务不合并：写文案不应被识别为图像任务继承', () => {
  const sources = [
    {
      text: '给我生成萌王持剑姿势',
      finalPrompt: '萌王持剑站立姿势',
      taskType: 'generate',
    },
  ];
  const ctx = resolveTaskSemanticContext({
    currentMessage: '帮我写一个朋友圈文案',
    sourceMessages: sources,
  });

  // 当前消息是非图像任务 → 直接返回，不做继承
  assert.strictEqual(ctx.inheritedFromPreviousTurn, false, '文案任务不应继承');
  assert.strictEqual(ctx.augmentationDetected, false, '文案任务不应被识别为补充');
  assert.strictEqual(ctx.workTitle, undefined);
});

// 测试 4：单轮新任务不应被错误继承
test('测试4 单轮全新任务不应继承', () => {
  const sources = [];
  const ctx = resolveTaskSemanticContext({
    currentMessage: '生成一张故宫雪景图',
    sourceMessages: sources,
  });
  assert.strictEqual(ctx.inheritedFromPreviousTurn, false);
});

// 测试 5：augmentation 但无源消息 → augmentationDetected=true，但不继承
test('测试5 augmentation 但无源消息时不继承', () => {
  const ctx = resolveTaskSemanticContext({
    currentMessage: '边上再加上一个原型态',
    sourceMessages: [],
  });
  assert.strictEqual(ctx.augmentationDetected, true);
  assert.strictEqual(ctx.inheritedFromPreviousTurn, false);
});

// 测试 6：长消息（>120 字）不应被识别为补充
test('测试6 长消息（>120 字）不应视为补充', () => {
  const longMsg = '我希望边上再加上他史莱姆的原型态'.padEnd(140, '描述');
  const ctx = resolveTaskSemanticContext({
    currentMessage: longMsg,
    sourceMessages: [{ text: '给我生成萌王持剑姿势' }],
  });
  assert.strictEqual(ctx.augmentationDetected, false, '长消息不应视为 augmentation');
});

console.log(`\n[TaskContextResolver smoke] ${passCount}/${testCount} passed\n`);
