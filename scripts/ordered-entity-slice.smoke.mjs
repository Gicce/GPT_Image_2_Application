// 静态 smoke 测试 —— node scripts/ordered-entity-slice.smoke.mjs
//
// 验证原子实体提取 + 顺序 first-N 切片（本轮核心交付物）：
//   1. entityExtraction —— 分组展开（五岳：泰山、华山……）vs 描述（黄山：以奇松……闻名）
//   2. chatExecutionContext —— extractEntityList 原子粒度 / "前3个" 绑定真实顺序
//   3. Planner handoff —— 存在 ordered selection 时只渲染 selected subset
//
// 通过 esbuild 直接加载真实 TS 实现（scripts/_ts_loader.mjs）。

import assert from 'node:assert/strict';
import { loadTs } from './_ts_loader.mjs';

const extraction = await loadTs('../src/utils/agent/entityExtraction.ts');
const { extractOrderedAtomicEntities } = extraction;

const chatCtx = await loadTs('../src/utils/agent/chatExecutionContext.ts');
const {
  extractEntityList,
  detectChatExecutionIntent,
  resolveChatExecutionContext,
  renderChatHandoffContextForPlanner,
} = chatCtx;

const TRIPTYCH_USER = '给我生成前3个山的风景图把一张图里展示3个风景。3分镜图把';

function buildConversation(messages) {
  return messages.map((m, i) => ({
    id: `m${i}`,
    role: m.role,
    content: m.content || '',
    task_message: m.task_message,
  }));
}

// ============ 一、原子实体提取 ============

// Case B：group expansion
{
  const text = '- 五岳：泰山、华山、衡山、嵩山、恒山\n- 黄山：以奇松、怪石、云海闻名\n- 峨眉山：佛教名山之一';
  const entities = extractOrderedAtomicEntities(text).map(e => e.label);
  assert.deepEqual(
    entities,
    ['泰山', '华山', '衡山', '嵩山', '恒山', '黄山', '峨眉山'],
    `group expansion 原子展开 (got ${JSON.stringify(entities)})`,
  );
  // 分组标签记录
  const grouped = extractOrderedAtomicEntities(text).find(e => e.label === '泰山');
  assert.equal(grouped.groupLabel, '五岳', '泰山 的 groupLabel=五岳');
  const solo = extractOrderedAtomicEntities(text).find(e => e.label === '黄山');
  assert.equal(solo.groupLabel, undefined, '黄山 无 groupLabel（冒号后是描述）');
  console.log('✓ Case B："五岳：泰山、华山……" 展开为 5 个原子实体；黄山/峨眉山 各 1 个');
}

// Case A：简单 bullet（既有行为不回归）
{
  const entities = extractEntityList('- 泰山\n- 黄山\n- 华山\n- 衡山');
  assert.deepEqual(entities, ['泰山', '黄山', '华山', '衡山'], '简单 bullet 原子提取');
  console.log('✓ Case A：简单 bullet → 4 个实体');
}

// Case C：description 逗号不误拆
{
  const entities = extractOrderedAtomicEntities('黄山：奇松、怪石、云海、温泉闻名').map(e => e.label);
  assert.deepEqual(entities, ['黄山'], `"奇松、怪石"不能拆成实体 (got ${JSON.stringify(entities)})`);
  console.log('✓ Case C："黄山：奇松、怪石、云海、温泉闻名" → 只有 黄山');
}

// Case D：人物 group（通用类别）
{
  const entities = extractOrderedAtomicEntities('主要角色：角色A、角色B、角色C、角色D').map(e => e.label);
  assert.deepEqual(entities, ['角色A', '角色B', '角色C', '角色D'], '人物 group 展开');
  console.log('✓ Case D："主要角色：……" → 4 个人物原子实体');
}

// 经典 group：四大名著
{
  const entities = extractOrderedAtomicEntities('四大名著：红楼梦、西游记、水浒传、三国演义').map(e => e.label);
  assert.deepEqual(entities, ['红楼梦', '西游记', '水浒传', '三国演义'], '四大名著展开');
  console.log('✓ "四大名著：……" → 4 个作品（group label 不占实体位）');
}

// 既有行为：数字 / 尺寸过滤
{
  assert.deepEqual(extractEntityList('常见尺寸：\n- 1024x1024\n- 1024x1536\n- 1536x1024'), [], '尺寸过滤');
  console.log('✓ 尺寸 / 版本号列表仍被过滤');
}

// ============ 二、"前3个" ordered slice（Runtime 真实场景）============

const MOUNTAIN_GROUPED_ASSISTANT = `中国著名的山有很多：

五岳：泰山、华山、衡山、嵩山、恒山
黄山：以奇松、怪石、云海闻名
峨眉山：中国四大佛教名山之一
庐山：以雄、奇、险、秀闻名
长白山：以天池和林海雪原著称`;

{
  const entities = extractEntityList(MOUNTAIN_GROUPED_ASSISTANT);
  assert.deepEqual(
    entities,
    ['泰山', '华山', '衡山', '嵩山', '恒山', '黄山', '峨眉山', '庐山', '长白山'],
    `原子化山列表 (got ${JSON.stringify(entities)})`,
  );
  console.log('✓ 分组式山列表 → 9 个原子实体（不再是整行继承）');
}

// Planner Handoff 集成：前3个山 → 泰山/华山/衡山
{
  const intent = detectChatExecutionIntent({ text: TRIPTYCH_USER });
  assert.equal(intent.actionable, true, 'actionable=true（继续进入 Task Card）');
  assert.equal(intent.kind, 'text_to_image', 'kind=text_to_image');
  const ctx = resolveChatExecutionContext({
    currentMessage: TRIPTYCH_USER,
    intent,
    messages: buildConversation([
      { role: 'user', content: '你知道中国有哪些著名的山嘛？' },
      { role: 'assistant', content: MOUNTAIN_GROUPED_ASSISTANT },
      { role: 'user', content: TRIPTYCH_USER },
    ]),
  });
  assert.ok(ctx, 'handoff ctx 存在');
  assert.equal(ctx.source, 'assistant_entity_list', 'source=assistant_entity_list');
  assert.deepEqual(
    ctx.orderedSelection.selectedLabels,
    ['泰山', '华山', '衡山'],
    `前3个山 → 泰山/华山/衡山 (got ${JSON.stringify(ctx.orderedSelection?.selectedLabels)})`,
  );
  assert.equal(ctx.grid.cellCount, 3, '3分镜 → cellCount=3');

  // Planner 只收 selected subset：渲染文本不得包含未选中的实体
  const rendered = renderChatHandoffContextForPlanner(ctx);
  assert.ok(rendered.includes('顺序实体选择'), '渲染包含顺序实体选择段');
  for (const label of ['泰山', '华山', '衡山']) {
    assert.ok(rendered.includes(label), `渲染包含 ${label}`);
  }
  for (const excluded of ['嵩山', '恒山', '黄山', '峨眉山', '庐山', '长白山', '五岳']) {
    assert.ok(!rendered.includes(excluded), `渲染不得包含 ${excluded}`);
  }
  assert.ok(rendered.includes('仅允许使用以上 3 个主体'), '渲染声明仅允许 selected subset');
  assert.ok(!rendered.includes('候选实体'), '存在 ordered selection 时不输出候选实体全表');
  assert.ok(rendered.includes('不是 3 张图'), '渲染明确不是 3 张图');
  assert.ok(rendered.includes('输出数量为 1'), '渲染明确输出数量为 1');
  console.log('✓ Planner handoff 只包含 泰山/华山/衡山，完整山列表不再进入 prompt');
}

// 顺序必须尊重真实聊天顺序（bullet 简单列表）
{
  const assistant = '- 泰山\n- 黄山\n- 华山\n- 衡山';
  const intent = detectChatExecutionIntent({ text: TRIPTYCH_USER });
  const ctx = resolveChatExecutionContext({
    currentMessage: TRIPTYCH_USER,
    intent,
    messages: buildConversation([
      { role: 'assistant', content: assistant },
      { role: 'user', content: TRIPTYCH_USER },
    ]),
  });
  assert.deepEqual(ctx.orderedSelection.selectedLabels, ['泰山', '黄山', '华山'], '按真实顺序 slice');
  console.log('✓ 简单 bullet 列表：前3个 = 泰山/黄山/华山（聊天顺序）');
}

// Case E：前2个
{
  const entities = extractEntityList('四大名著：红楼梦、西游记、水浒传、三国演义');
  const { parseOrderedEntitySelection } = await loadTs('../src/utils/agent/compositionIntentResolver.ts');
  const ordered = parseOrderedEntitySelection('用前两个作品做一张双联画');
  const labels = ordered.selectedIndices.map(i => entities[i - 1]);
  assert.deepEqual(labels, ['红楼梦', '西游记'], `前两个作品 (got ${JSON.stringify(labels)})`);
  console.log('✓ Case E："前两个" → slice 2');
}

// Case F：没有 entity context → 低置信，不乱猜
{
  const intent = detectChatExecutionIntent({ text: '给我生成前3个做张图' });
  assert.equal(intent.referencesPreviousContext, true, '前3个 触发引用');
  const resolved = resolveChatExecutionContext({
    currentMessage: '给我生成前3个做张图',
    intent,
    messages: buildConversation([
      { role: 'user', content: '给我生成前3个做张图' },
    ]),
  });
  assert.ok(!resolved || resolved.source === 'current_message', '无历史实体 → current_message / null（不乱猜）');
  console.log('✓ Case F：无实体上下文 → 不乱猜');
}

// 量词兼容：前3座山
{
  const intent = detectChatExecutionIntent({ text: '给我生成前3座山的风景图，一张图里展示3个风景，3分镜图' });
  assert.equal(intent.actionable, true, '前3座 actionable');
  const ctx = resolveChatExecutionContext({
    currentMessage: '给我生成前3座山的风景图，一张图里展示3个风景，3分镜图',
    intent,
    messages: buildConversation([
      { role: 'assistant', content: MOUNTAIN_GROUPED_ASSISTANT },
      { role: 'user', content: '给我生成前3座山的风景图，一张图里展示3个风景，3分镜图' },
    ]),
  });
  assert.deepEqual(ctx.orderedSelection.selectedLabels, ['泰山', '华山', '衡山'], '前3座 → 前 3 实体');
  console.log('✓ "前3座山"（座 量词）→ 泰山/华山/衡山');
}

// 通用类别：前3个人物
{
  const intent = detectChatExecutionIntent({ text: '把前3个人物做成一张三联画' });
  const ctx = resolveChatExecutionContext({
    currentMessage: '把前3个人物做成一张三联画',
    intent,
    messages: buildConversation([
      { role: 'assistant', content: '主要角色：角色A、角色B、角色C、角色D' },
      { role: 'user', content: '把前3个人物做成一张三联画' },
    ]),
  });
  assert.deepEqual(ctx.orderedSelection.selectedLabels, ['角色A', '角色B', '角色C'], '前3个人物');
  console.log('✓ "前3个人物" → 角色A/角色B/角色C（通用类别）');
}

console.log('\nordered-entity-slice smoke 全部通过');
