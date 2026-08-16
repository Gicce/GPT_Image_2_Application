// 静态 smoke 测试 -- node scripts/chat-task-navigation.smoke.mjs
//
// 验证 Chat -> Task Handoff 与页面导航完全解耦（本轮核心产品规则）：
//   Proposal Handoff ≠ UI Navigation
//
//   1. 三分镜复合构图 handoff 链路仍正确（single + 实体绑定 + draft）
//   2. useChatStore 源码层面不存在任何页面导航调用
//      （setRequestedPage / setCurrentPage / navigate / switchToTask / openTask...）
//   3. 唯一允许的导航入口：TaskMessageCard「查看任务」按钮（UI 层用户主动点击）
//   4. task_revision 修订链路同样不涉及导航
//
// 该测试同时是回归锚：任何人往 useChatStore 加入自动跳页逻辑都会立刻挂掉。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs } from './_ts_loader.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(scriptDir, '../src');

// ============ 一、三分镜 handoff 语义回归（不能因导航解耦改坏）============

const resolver = await loadTs('../src/utils/agent/compositionIntentResolver.ts');
const { resolveOutputStructure } = resolver;

const chatCtx = await loadTs('../src/utils/agent/chatExecutionContext.ts');
const { detectChatExecutionIntent, resolveChatExecutionContext } = chatCtx;

const MOUNTAIN_LIST_ASSISTANT = `当然知道！中国著名的山有很多，例如：

- 泰山
- 黄山
- 华山
- 衡山
- 嵩山
- 恒山`;

const TRIPTYCH_USER = '给我生成前3个山的风景图把一张图里展示3个风景。3分镜图把';

{
  const s = resolveOutputStructure(TRIPTYCH_USER);
  assert.equal(s.kind, 'single_composite_image', '"3分镜"必须判定为单张复合构图');
  assert.equal(s.requestedImageCount, 1, 'image_count 必须是 1，不是 3');

  // 实体绑定走 resolveChatExecutionContext（与 composition-intent.smoke 同一真实链路）
  const execIntent = detectChatExecutionIntent({
    text: TRIPTYCH_USER,
    hasImageAttachments: false,
    hasActiveImage: false,
  });
  const messages = [
    { id: 'm0', role: 'user', content: '你知道中国著名的山吗' },
    { id: 'm1', role: 'assistant', content: MOUNTAIN_LIST_ASSISTANT },
    { id: 'm2', role: 'user', content: TRIPTYCH_USER },
  ];
  const ctx = resolveChatExecutionContext({ currentMessage: TRIPTYCH_USER, intent: execIntent, messages });
  assert.ok(ctx, 'handoff 上下文必须可解析');
  assert.deepEqual(ctx.orderedSelection.selectedLabels, ['泰山', '黄山', '华山'], '前3个山 -> 泰山/黄山/华山');
  // handoff 决策镜像（与 sendMessage 守卫同步）：识别结果用于创建 draft 任务卡，绝不用于导航。
  const shouldHandoff = execIntent.actionable
    && (execIntent.referencesPreviousContext || !!execIntent.grid);
  assert.ok(shouldHandoff, '三分镜 + 引用上下文 -> 应创建 Task Draft（留在 Chat）');
  console.log('✓ 三分镜 = single_composite_image / count=1 / 泰山黄山华山绑定 -> draft');
}

// ============ 二、useChatStore 源码零导航调用 ============

{
  const source = fs.readFileSync(path.join(srcRoot, 'store/useChatStore.ts'), 'utf8');

  // 显式禁止的导航调用（store 层）
  const forbidden = [
    /setRequestedPage\s*\(/,
    /setCurrentPage\s*\(/,
    /\bnavigate\s*\(/,
    /switchToTask\s*\(/,
    /openTaskDetail\s*\(/,
    /location\.href\s*=/,
  ];
  for (const pattern of forbidden) {
    assert.ok(
      !pattern.test(source),
      `useChatStore 不得包含导航调用：${pattern}（Handoff/确认执行/修订都只能改会话状态）`,
    );
  }
  console.log('✓ useChatStore 无任何页面导航调用（handoff / 确认执行 / 修订全程留在 Chat）');
}

// ============ 三、确认执行链路（createTaskFromProposal）只做任务入队 ============

{
  const source = fs.readFileSync(path.join(srcRoot, 'store/useChatStore.ts'), 'utf8');
  const confirmFn = source.slice(
    source.indexOf('createTaskFromProposal'),
    source.indexOf('createTaskFromProposal') + 4000,
  );
  assert.ok(confirmFn.includes('addTask') || confirmFn.includes('createTask'), '确认执行必须真正创建任务');
  assert.ok(!confirmFn.includes('setRequestedPage'), '确认执行不得触发跳转');
  console.log('✓ 确认执行 -> 任务入队 + 卡片状态更新，无导航');
}

// ============ 四、唯一导航入口：TaskMessageCard「查看任务」按钮 ============

{
  const card = fs.readFileSync(path.join(srcRoot, 'components/TaskMessageCard.tsx'), 'utf8');
  assert.ok(card.includes('查看任务'), '任务卡必须保留「查看任务」按钮（用户主动点击才导航）');
  // 查看任务只在非 draft（正式 task）阶段显示
  assert.ok(/onViewTask\s*&&\s*!isWaiting/.test(card) || /!isWaiting[\s\S]{0,200}onViewTask/.test(card),
    '「查看任务」必须跳过 draft 提案阶段');

  const chat = fs.readFileSync(path.join(srcRoot, 'pages/Chat.tsx'), 'utf8');
  // Chat.tsx 的跳转只在 handleViewTask（由查看任务按钮触发）与充值跳转（account）
  const viewTaskNav = /setRequestedPage\('queue'\)/.test(chat);
  assert.ok(viewTaskNav, 'Chat.tsx 中跳任务队列只允许来自「查看任务」路径');
  const queueNavCount = (chat.match(/setRequestedPage\('queue'\)/g) || []).length;
  assert.equal(queueNavCount, 1, `Chat.tsx 中 -> queue 的跳转点必须唯一（当前 ${queueNavCount} 处），防止 handoff 自动跳页回归`);
  console.log('✓ -> 任务页导航唯一入口：TaskMessageCard「查看任务」');
}

// ============ 五、task_revision 链路不导航 ============

{
  const revision = await loadTs('../src/utils/agent/taskRevision.ts');
  const { detectTaskRevisionIntent } = revision;
  assert.equal(detectTaskRevisionIntent('我不要批量任务 我要单张').isRevision, true);

  const source = fs.readFileSync(path.join(srcRoot, 'utils/agent/taskRevision.ts'), 'utf8');
  assert.ok(!/setRequestedPage|setCurrentPage|navigate\s*\(/.test(source), 'taskRevision 不得包含导航');
  console.log('✓ task_revision（批量->单张）纯函数修订，无导航');
}

console.log('\n全部通过：chat-task-navigation');
