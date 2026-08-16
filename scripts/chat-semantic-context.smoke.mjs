// 静态 smoke 测试 —— node scripts/chat-semantic-context.smoke.mjs
//
// 验证 Chat Execution Context Resolver（src/utils/agent/chatExecutionContext.ts）
// 的语义指代解析能力 —— 本轮核心交付物。
//
// 通过 esbuild 直接加载真实 TS 实现（scripts/_ts_loader.mjs），
// 测的是源代码本体，不是镜像拷贝。

import assert from 'node:assert/strict';
import { loadTs } from './_ts_loader.mjs';

const ctx = await loadTs('../src/utils/agent/chatExecutionContext.ts');
const { detectChatExecutionIntent, resolveChatExecutionContext, extractEntityList, parseGridLayout } = ctx;

// ============ 建筑列表 fixtures（Runtime 真实对话 mirror，spec 八十四节）============

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

const BUILDING_GRID_USER = '你可以帮我生成这些建筑得9宫格图嘛？'; // 注意错别字"得"

function buildConversation(messages) {
  // 包装成 resolver 输入形态：时间顺序（旧→新），最后一轮是当前 user 消息
  return messages.map((m, i) => ({
    id: `m${i}`,
    role: m.role,
    content: m.content || '',
    task_message: m.task_message,
  }));
}

// ============ 一、Intent 检测 ============

// Runtime 核心（spec 八十四节）：错别字"得"不能导致失效
{
  const intent = detectChatExecutionIntent({ text: BUILDING_GRID_USER });
  assert.equal(intent.actionable, true, 'actionable=true');
  assert.equal(intent.kind, 'text_to_image', 'kind=text_to_image');
  assert.equal(intent.referencesPreviousContext, true, 'referencesPreviousContext=true');
  assert.equal(intent.entityCategoryHint, 'building', 'entityCategoryHint=building');
  assert.equal(intent.grid.rows, 3, 'gridRows=3');
  assert.equal(intent.grid.columns, 3, 'gridColumns=3');
  assert.equal(intent.grid.cellCount, 9, 'gridCellCount=9');
  console.log('✓ Runtime 九宫格 intent（含错别字"得"）');
}

// 普通问答不误转 Task（spec 九十三节）
{
  const intent = detectChatExecutionIntent({ text: '你知道中国最著名的建筑有哪些嘛？' });
  assert.equal(intent.actionable, false, '普通问答 actionable=false');
  console.log('✓ 建筑普通问答不 Handoff');
}

// "九宫格是什么意思"不能 Handoff（spec 九十四节）
{
  const intent = detectChatExecutionIntent({ text: '九宫格图片是什么意思？' });
  assert.equal(intent.actionable, false, '疑问句式 actionable=false');
  console.log('✓ 九宫格是什么 → 普通 Chat');
}

// "你觉得这些建筑哪个最漂亮" → 普通讨论（spec 一百五十六节）
{
  const intent = detectChatExecutionIntent({ text: '你觉得这些建筑哪个最漂亮？' });
  assert.equal(intent.actionable, false, '讨论句式 actionable=false');
  console.log('✓ 讨论句式不 Handoff');
}

// 明确生成九宫格（自包含请求，spec 九十五节）
{
  const intent = detectChatExecutionIntent({ text: '帮我生成一个中国建筑九宫格' });
  assert.equal(intent.actionable, true, '自包含生成 actionable=true');
  assert.equal(intent.grid.cellCount, 9, '自包含九宫格 grid=9');
  console.log('✓ 自包含九宫格生成 Handoff');
}

// ============ 二、实体列表提取 ============

// bullet 列表（Runtime mirror，spec 八十三节）
{
  const entities = extractEntityList(BUILDING_LIST_ASSISTANT);
  assert.equal(entities.length, 10, `entities=10 (got ${entities.length})`);
  assert.ok(entities.includes('长城'), '包含长城');
  assert.ok(entities.includes('广州塔'), '包含广州塔');
  console.log('✓ bullet 实体列表提取（10 个建筑）');
}

// 编号列表
{
  const entities = extractEntityList('常见角色如下：\n1. A角色\n2. B角色\n3. C角色\n4. D角色');
  assert.equal(entities.length, 4, '编号列表 4 实体');
  console.log('✓ 编号列表实体提取');
}

// 顿号单行列举
{
  const entities = extractEntityList('例如：长城、故宫、天坛、颐和园、布达拉宫');
  assert.equal(entities.length, 5, `顿号列举 5 实体 (got ${entities.length})`);
  console.log('✓ 顿号单行实体提取');
}

// 尺寸列表不是实体主体（数字过滤，spec 二十一节）
{
  const entities = extractEntityList('常见尺寸：\n- 1024x1024\n- 1024x1536\n- 1536x1024');
  assert.equal(entities.length, 0, '尺寸列表过滤为空');
  console.log('✓ 尺寸列表不当实体');
}

// ============ 三、Context Resolver（Runtime 核心 mirror）============

// 场景 A：建筑九宫格（spec 八十四节完整断言）
{
  const messages = buildConversation([
    { role: 'user', content: '你知道中国最著名的建筑有哪些嘛？' },
    { role: 'assistant', content: BUILDING_LIST_ASSISTANT },
    { role: 'user', content: BUILDING_GRID_USER },
  ]);
  const intent = detectChatExecutionIntent({ text: BUILDING_GRID_USER });
  const resolved = resolveChatExecutionContext({
    currentMessage: BUILDING_GRID_USER,
    intent,
    messages,
  });
  assert.ok(resolved, 'resolved 非空');
  assert.equal(resolved.source, 'assistant_entity_list', 'source=assistant_entity_list');
  assert.equal(resolved.entities.length, 10, 'entities=10');
  assert.equal(resolved.grid.rows, 3, 'gridRows=3');
  assert.equal(resolved.grid.columns, 3, 'gridColumns=3');
  assert.equal(resolved.grid.cellCount, 9, 'gridCellCount=9');
  assert.ok(resolved.sourceMessageIds.length >= 1, 'sourceMessageIds 存在');
  assert.ok(resolved.sourceLabel.includes('建筑'), `sourceLabel 含建筑 (${resolved.sourceLabel})`);
  // Planner handoff 渲染：10 实体 > 9 格 → 自主筛选指令
  const rendered = ctx.renderChatHandoffContextForPlanner(resolved);
  assert.ok(rendered.includes('[对话转任务上下文]'), 'handoff 段落存在');
  assert.ok(rendered.includes('候选实体'), '候选实体段落存在');
  assert.ok(rendered.includes('3×3 宫格'), '布局描述存在');
  assert.ok(rendered.includes('自主选择最具代表性的 9 个'), '实体超容量 → 自主筛选指令');
  console.log('✓ 建筑九宫格完整链路（10 实体 / 3×3 / 自主筛选）');
}

// 场景 B：这些人物（spec 八十七节）
{
  const messages = buildConversation([
    { role: 'user', content: '推荐几个角色' },
    { role: 'assistant', content: '常见角色：\n- A\n- B\n- C\n- D' },
    { role: 'user', content: '把这些人物做成三人海报' },
  ]);
  const intent = detectChatExecutionIntent({ text: '把这些人物做成三人海报' });
  assert.equal(intent.actionable, true, '人物海报 actionable');
  const resolved = resolveChatExecutionContext({ currentMessage: '把这些人物做成三人海报', intent, messages });
  assert.equal(resolved.source, 'assistant_entity_list', '人物 source=assistant_entity_list');
  assert.equal(resolved.entities.length, 4, '人物 entities=4');
  console.log('✓ 这些人物 → 实体引用');
}

// 场景 C：这些产品（spec 八十八节）
{
  const messages = buildConversation([
    { role: 'assistant', content: '推荐：\n- 产品A\n- 产品B\n- 产品C' },
    { role: 'user', content: '把这些产品做一张宣传图' },
  ]);
  const intent = detectChatExecutionIntent({ text: '把这些产品做一张宣传图' });
  const resolved = resolveChatExecutionContext({ currentMessage: '把这些产品做一张宣传图', intent, messages });
  assert.equal(resolved.source, 'assistant_entity_list', '产品 source=assistant_entity_list');
  assert.equal(resolved.entities.length, 3, '产品 entities=3');
  console.log('✓ 这些产品 → 实体引用');
}

// 场景 D："这些"无上下文（spec 八十九节）→ 低置信 current_message，
// sendMessage 检测 resolvable=false → 不 Handoff（普通 chat / Planner 自行 clarification）
{
  const messages = buildConversation([
    { role: 'user', content: '把这些做一张图' },
  ]);
  const intent = detectChatExecutionIntent({ text: '把这些做一张图' });
  const resolved = resolveChatExecutionContext({ currentMessage: '把这些做一张图', intent, messages });
  // 无可解析上下文时返回 current_message 或 null —— 两种都视为"不乱猜"
  assert.ok(!resolved || resolved.source === 'current_message', '无上下文 → current_message / null');
  console.log('✓ 无上下文"这些" → 不乱猜');
}

// 场景 E：不相关列表（spec 九十节）—— "这些建筑"但历史只有 Windows 版本列表
{
  const messages = buildConversation([
    { role: 'assistant', content: 'Windows版本：\n- 10\n- 11' }, // 只有 2 项，extractEntityList 需要 >=3
    { role: 'user', content: '这些建筑做九宫格' },
  ]);
  const intent = detectChatExecutionIntent({ text: '这些建筑做九宫格' });
  const resolved = resolveChatExecutionContext({ currentMessage: '这些建筑做九宫格', intent, messages });
  assert.ok(!resolved || resolved.source === 'current_message', '不相关列表 → current_message / null（不继承）');
  console.log('✓ 不相关 Windows 列表不被继承');
}

// 场景 F：类别不匹配的 3+ 项列表（intro 是版本、实体是数字版本号）
{
  const messages = buildConversation([
    { role: 'assistant', content: '可选版本如下：\n- Windows 10 家庭版\n- Windows 11 专业版\n- Windows 11 家庭版' },
    { role: 'user', content: '这些建筑做九宫格' },
  ]);
  const intent = detectChatExecutionIntent({ text: '这些建筑做九宫格' });
  const resolved = resolveChatExecutionContext({ currentMessage: '这些建筑做九宫格', intent, messages });
  // intro "可选版本如下" 不含建筑词 → 类别分数 0 → 不满足 minScore → current_message / null
  assert.ok(!resolved || resolved.source === 'current_message', '类别不匹配 → 不继承');
  console.log('✓ 类别不匹配列表不被继承');
}

// 场景 G：Prompt Context 回归（思思FM，spec 九十一节）
{
  const messages = buildConversation([
    { role: 'user', content: '帮我写一个思思FM的电台海报提示词' },
    { role: 'assistant', content: '好的，这是提示词：\n深夜电台风格海报，中央一个复古麦克风，暖色调灯光，左侧一台老式收音机……\n\n负面提示词：\n模糊、畸形、乱码' },
    { role: 'user', content: '根据你刚才的提示词生成一张1024x1024的图' },
  ]);
  const intent = detectChatExecutionIntent({ text: '根据你刚才的提示词生成一张1024x1024的图' });
  assert.equal(intent.actionable, true, '思思FM actionable=true');
  const resolved = resolveChatExecutionContext({ currentMessage: '根据你刚才的提示词生成一张1024x1024的图', intent, messages });
  assert.equal(resolved.source, 'assistant_prompt', 'source=assistant_prompt');
  assert.ok(resolved.prompt && resolved.prompt.includes('麦克风'), '继承提示词内容');
  assert.ok(resolved.negativePrompt && resolved.negativePrompt.includes('模糊'), '继承负面提示词');
  console.log('✓ Prompt Context 回归（思思FM）');
}

// 场景 H：Visual Proposal Context（spec 九十二节）
{
  const messages = buildConversation([
    { role: 'assistant', content: '我建议画面做成深夜蓝色背景，中间放一个复古麦克风，左侧摆一台老式收音机，右侧是透过窗户的城市夜景，整体暖黄色灯光点缀，营造安静的深夜电台氛围。' },
    { role: 'user', content: '那就按你说的做一张' },
  ]);
  const intent = detectChatExecutionIntent({ text: '那就按你说的做一张' });
  const resolved = resolveChatExecutionContext({ currentMessage: '那就按你说的做一张', intent, messages });
  assert.equal(resolved.source, 'assistant_visual_plan', 'source=assistant_visual_plan');
  assert.ok(resolved.semanticSummary && resolved.semanticSummary.includes('麦克风'), 'semanticSummary 继承视觉方案');
  console.log('✓ Visual Proposal Context');
}

// 场景 I：Previous Task Context（spec 三十五节）
{
  const messages = buildConversation([
    { role: 'assistant', content: '任务已完成。', task_message: { stage: 'success', finalPrompt: '一只橘猫在窗台上晒太阳，温暖午后光线，写实风格' } },
    { role: 'user', content: '刚才那张再生成个横版' },
  ]);
  const intent = detectChatExecutionIntent({ text: '刚才那张再生成个横版' });
  const resolved = resolveChatExecutionContext({ currentMessage: '刚才那张再生成个横版', intent, messages });
  assert.equal(resolved.source, 'previous_task', 'source=previous_task');
  assert.ok(resolved.prompt && resolved.prompt.includes('橘猫'), '继承 previous finalPrompt');
  console.log('✓ Previous Task Context');
}

// 场景 J：引用关系优先于 Prompt 默认优先级（spec 三十七节）
{
  const messages = buildConversation([
    { role: 'assistant', content: '提示词：\n一个赛博朋克城市的夜景，霓虹灯密集……' },
    { role: 'assistant', content: '中国著名建筑包括：\n- 长城\n- 故宫\n- 天坛\n- 颐和园\n- 布达拉宫\n- 广州塔\n- 东方明珠\n- 鸟巢\n- 水立方\n- 天安门' },
    { role: 'user', content: '把这些建筑做九宫格' },
  ]);
  const intent = detectChatExecutionIntent({ text: '把这些建筑做九宫格' });
  const resolved = resolveChatExecutionContext({ currentMessage: '把这些建筑做九宫格', intent, messages });
  assert.equal(resolved.source, 'assistant_entity_list', '引用建筑 → entity_list 而不是 prompt');
  assert.equal(resolved.entities.length, 10, '实体 = 10');
  console.log('✓ 引用关系优先于 Prompt 优先级');
}

// ============ 四、九宫格解析 variants ============

for (const [text, expected] of [
  ['九宫格', 9], ['9宫格', 9], ['9 宫格', 9], ['3x3', 9], ['3×3', 9],
  ['十六宫格', 16], ['4宫格', 4],
]) {
  const grid = parseGridLayout(text);
  assert.ok(grid, `${text} → grid 解析成功`);
  assert.equal(grid.cellCount, expected, `${text} → cellCount=${expected}`);
}
console.log('✓ 九宫格 variants 解析');

console.log('\n全部 chat-semantic-context smoke tests 通过');
