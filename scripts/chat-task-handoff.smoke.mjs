// 静态 smoke 测试 —— node scripts/chat-task-handoff.smoke.mjs
//
// 验证 Chat → Task Handoff 路由决策（useChatStore.sendMessage 中的
// detectChatExecutionIntent + resolveChatExecutionContext 分流逻辑）。
//
// 通过 esbuild 加载真实 TS 实现；路由守卫条件与 sendMessage 保持同步：
//   shouldHandoff = intent.actionable
//     && (intent.referencesPreviousContext || !!intent.grid)
//     && (!activeDraft || activeDraft.stage === 'completed')
//   resolvable = !referencesPreviousContext || handoffCtx?.source !== 'current_message'

import assert from 'node:assert/strict';
import { loadTs } from './_ts_loader.mjs';

const ctx = await loadTs('../src/utils/agent/chatExecutionContext.ts');
const { detectChatExecutionIntent, resolveChatExecutionContext } = ctx;

const BUILDING_LIST_ASSISTANT = `当然知道。中国著名建筑很多，例如：

- 长城
- 故宫
- 天坛
- 颐和园
- 秦始皇陵兵马俑
- 布达拉宫
- 上海东方明珠
- 国家体育场"鸟巢"
- 国家游泳中心"水立方"
- 广州塔`;

/** 与 sendMessage 中的路由决策同步（规则镜像）。 */
function decideHandoffRouting(input) {
  const { text, messages, activeDraftStage, pendingClarification } = input;
  if (pendingClarification) return { handoff: false, reason: 'clarification_pending' };

  const execIntent = detectChatExecutionIntent({
    text,
    hasImageAttachments: input.hasImageAttachments ?? false,
    hasActiveImage: input.hasActiveImage ?? false,
  });
  const shouldHandoff = execIntent.actionable
    && (execIntent.referencesPreviousContext || !!execIntent.grid)
    && (!activeDraftStage || activeDraftStage === 'completed');
  if (!shouldHandoff) return { handoff: false, reason: 'not_actionable_or_no_context' };

  const handoffCtx = resolveChatExecutionContext({
    currentMessage: text,
    intent: execIntent,
    messages,
  });
  const resolvable = !execIntent.referencesPreviousContext
    || handoffCtx?.source !== 'current_message';
  if (handoffCtx && resolvable) {
    return { handoff: true, kind: execIntent.kind, ctx: handoffCtx };
  }
  return { handoff: false, reason: 'reference_unresolvable' };
}

function conv(messages) {
  return messages.map((m, i) => ({
    id: `m${i}`,
    role: m.role,
    content: m.content || '',
    task_message: m.task_message,
  }));
}

// ============ Runtime 核心场景（spec 一百一十六节完整链路）============

// 建筑 → 九宫格：走 Task Handoff，绝不走 sendMessage（spec 一百五十节）
{
  const messages = conv([
    { role: 'user', content: '你知道中国最著名的建筑有哪些嘛？' },
    { role: 'assistant', content: BUILDING_LIST_ASSISTANT },
    { role: 'user', content: '你可以帮我生成这些建筑得9宫格图嘛？' },
  ]);
  const routing = decideHandoffRouting({
    text: '你可以帮我生成这些建筑得9宫格图嘛？',
    messages,
  });
  assert.equal(routing.handoff, true, '建筑九宫格 → Handoff');
  assert.equal(routing.kind, 'text_to_image', 'kind=text_to_image');
  assert.equal(routing.ctx.entities.length, 10, 'entities=10');
  assert.equal(routing.ctx.grid.cellCount, 9, 'grid=3x3');
  console.log('✓ Runtime 建筑九宫格 → Task Handoff');
}

// 普通建筑问答：不 Handoff，走 sendMessage（spec 一百四十九节）
{
  const messages = conv([
    { role: 'user', content: '你知道中国最著名的建筑有哪些嘛？' },
  ]);
  const routing = decideHandoffRouting({ text: '你知道中国最著名的建筑有哪些嘛？', messages });
  assert.equal(routing.handoff, false, '普通问答不 Handoff');
  console.log('✓ 普通建筑问答 → sendMessage');
}

// "这些"没有上下文（spec 一百五十三节）→ 不 Handoff（保持 chat / 让 interpret 决定）
{
  const messages = conv([
    { role: 'user', content: '把这些建筑做个九宫格' },
  ]);
  const routing = decideHandoffRouting({ text: '把这些建筑做个九宫格', messages });
  assert.equal(routing.handoff, false, '无上下文 → 不 Handoff（resolvable=false）');
  console.log('✓ 无上下文"这些" → 不错误 Handoff');
}

// 思思FM 回归（spec 一百五十四节）
{
  const messages = conv([
    { role: 'user', content: '帮我写一个思思FM的电台海报提示词' },
    { role: 'assistant', content: '提示词：\n深夜电台海报，复古麦克风居中，暖色调，左侧老式收音机，右侧窗景城市夜景，带有"思思FM"标题文字\n\n负面提示词：\n模糊、乱码、畸形' },
    { role: 'user', content: '根据你刚才的提示词生成一张1024x1024的图' },
  ]);
  const routing = decideHandoffRouting({
    text: '根据你刚才的提示词生成一张1024x1024的图',
    messages,
  });
  assert.equal(routing.handoff, true, '思思FM → Handoff');
  assert.equal(routing.ctx.source, 'assistant_prompt', 'source=assistant_prompt');
  assert.ok(routing.ctx.prompt.includes('思思FM'), '继承含思思FM 的提示词');
  console.log('✓ 思思FM Prompt 继承回归');
}

// 这些人物海报（spec 一百五十五节）
{
  const messages = conv([
    { role: 'assistant', content: '常见角色：\n- 主角A\n- 主角B\n- 主角C' },
    { role: 'user', content: '把这些人物做一张海报' },
  ]);
  const routing = decideHandoffRouting({ text: '把这些人物做一张海报', messages });
  assert.equal(routing.handoff, true, '人物海报 → Handoff');
  assert.equal(routing.ctx.entities.length, 3, 'entities=3');
  console.log('✓ 这些人物海报 → Handoff');
}

// 讨论句式（spec 一百五十六节）："你觉得这些建筑哪个最漂亮？" → 普通 Chat
{
  const routing = decideHandoffRouting({
    text: '你觉得这些建筑哪个最漂亮？',
    messages: conv([{ role: 'assistant', content: BUILDING_LIST_ASSISTANT }]),
  });
  assert.equal(routing.handoff, false, '讨论句式不 Handoff');
  console.log('✓ 讨论句式 → 普通 Chat');
}

// pending clarification 优先：不走 handoff（由 sendTaskMessage clarification 续接处理）
{
  const messages = conv([
    { role: 'assistant', content: BUILDING_LIST_ASSISTANT },
    { role: 'user', content: '你可以帮我生成这些建筑得9宫格图嘛？' },
  ]);
  const routing = decideHandoffRouting({
    text: '你可以帮我生成这些建筑得9宫格图嘛？',
    messages,
    pendingClarification: true,
  });
  assert.equal(routing.handoff, false, 'pending clarification 时不 Handoff');
  console.log('✓ pending clarification 优先');
}

// activeDraft=proposed（旧 proposal 流程活跃）时不抢占
{
  const messages = conv([
    { role: 'assistant', content: BUILDING_LIST_ASSISTANT },
    { role: 'user', content: '你可以帮我生成这些建筑得9宫格图嘛？' },
  ]);
  const routing = decideHandoffRouting({
    text: '你可以帮我生成这些建筑得9宫格图嘛？',
    messages,
    activeDraftStage: 'proposed',
  });
  assert.equal(routing.handoff, false, 'activeDraft proposed 时不抢占');
  console.log('✓ activeDraft proposed 不抢占');
}

// 不跨 Conversation 继承：messages 为空（其它会话内容不传入）
{
  const routing = decideHandoffRouting({
    text: '把这些建筑做个九宫格',
    messages: conv([{ role: 'user', content: '把这些建筑做个九宫格' }]),
  });
  assert.equal(routing.handoff, false, '跨会话内容不可见');
  console.log('✓ 不跨 Conversation 继承');
}

// ============ 静态审计：sendMessage 中存在 Handoff 分流代码（spec 一百一十六节）============

{
  const fs = await import('node:fs');
  const source = fs.readFileSync('src/store/useChatStore.ts', 'utf8');
  assert.ok(source.includes('detectChatExecutionIntent'), 'sendMessage 引用 detectChatExecutionIntent');
  assert.ok(source.includes('resolveChatExecutionContext'), 'sendMessage 引用 resolveChatExecutionContext');
  assert.ok(source.includes('[ChatTaskHandoff]'), 'Handoff debug 日志存在');
  assert.ok(source.includes('renderChatHandoffContextForPlanner') || source.includes('chatHandoffContext'), 'handoff context 传入 Planner');
  // Handoff 后不能先发普通 Assistant 回复：sendTaskMessage 调用必须存在
  assert.ok(/sendTaskMessage\(\{\s*text: visibleText/.test(source), 'Handoff 直接进 sendTaskMessage');
  console.log('✓ sendMessage Handoff 分流静态审计');
}

console.log('\n全部 chat-task-handoff smoke tests 通过');
