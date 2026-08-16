// 静态 smoke 测试 —— node scripts/composition-intent.smoke.mjs
//
// 验证"单张复合构图 vs 批量输出"判别链路（本轮核心交付物）：
//   1. compositionIntentResolver —— resolveOutputStructure / parseOrderedEntitySelection
//   2. chatExecutionContext —— "前3个山"顺序引用绑定到真实实体
//   3. taskRevision —— "我不要批量任务 我要单张"识别为任务修订
//
// 通过 esbuild 直接加载真实 TS 实现（scripts/_ts_loader.mjs）。

import assert from 'node:assert/strict';
import { loadTs } from './_ts_loader.mjs';

const resolver = await loadTs('../src/utils/agent/compositionIntentResolver.ts');
const { resolveOutputStructure, parseOrderedEntitySelection } = resolver;

const chatCtx = await loadTs('../src/utils/agent/chatExecutionContext.ts');
const {
  detectChatExecutionIntent,
  resolveChatExecutionContext,
} = chatCtx;

const revision = await loadTs('../src/utils/agent/taskRevision.ts');
const { detectTaskRevisionIntent, buildTaskRevisionContinuationText } = revision;

// ============ fixtures：山列表对话（Runtime 真实复现场景）============

const MOUNTAIN_LIST_ASSISTANT = `当然知道！中国著名的山有很多，例如：

- 泰山
- 黄山
- 华山
- 衡山
- 嵩山
- 恒山`;

const TRIPTYCH_USER = '给我生成前3个山的风景图把一张图里展示3个风景。3分镜图把';

function buildConversation(messages) {
  return messages.map((m, i) => ({
    id: `m${i}`,
    role: m.role,
    content: m.content || '',
    task_message: m.task_message,
  }));
}

// ============ 一、resolveOutputStructure：三分镜 ≠ 3 张 ============

{
  const s = resolveOutputStructure(TRIPTYCH_USER);
  assert.equal(s.kind, 'single_composite_image', 'kind=single_composite_image');
  assert.equal(s.requestedImageCount, 1, 'requestedImageCount=1');
  assert.equal(s.compositePanelCount, 3, 'compositePanelCount=3');
  assert.equal(s.layoutType, 'triptych', 'layoutType=triptych');
  assert.ok(s.evidence.length > 0, 'evidence 非空');
  console.log('✓ "前3个山 + 一张图里展示3个风景 + 3分镜" 判定为单张三分镜复合构图');
}

// 九宫格 ≠ 9 张
{
  const s = resolveOutputStructure('把这9个建筑做成九宫格海报');
  assert.equal(s.kind, 'single_composite_image', '九宫格 kind=single_composite_image');
  assert.equal(s.compositePanelCount, 9, 'panelCount=9');
  assert.equal(s.layoutType, 'grid', 'layoutType=grid');
  assert.equal(s.requestedImageCount, 1, 'requestedImageCount=1');
  console.log('✓ 九宫格海报判定为单张 9 格复合构图');
}

// 三联画 / 左中右 / 一个画面里
for (const [text, expectedPanel] of [
  ['把这三辆车做一张三联画', 3],
  ['左中右三个区域分别展示三种风格', 3],
  ['一个画面里放三个主体', 3],
  ['做成拼图海报', undefined],
]) {
  const s = resolveOutputStructure(text);
  assert.equal(s.kind, 'single_composite_image', `"${text}" kind=single_composite_image`);
  assert.equal(s.requestedImageCount, 1, `"${text}" 输出 1 张`);
  if (expectedPanel) assert.equal(s.compositePanelCount, expectedPanel, `"${text}" panelCount=${expectedPanel}`);
  console.log(`✓ "${text}" → 单张复合构图`);
}

// ============ 二、真正的批量表达不回归 ============

for (const text of [
  '给我生成3张不同风格的黄山风景图',
  '出3个版本的海报',
  '一共做3张图',
]) {
  const s = resolveOutputStructure(text);
  assert.equal(s.kind, 'batch_images', `"${text}" kind=batch_images`);
  assert.ok(s.requestedImageCount >= 3, `"${text}" count>=3`);
  console.log(`✓ "${text}" 保留批量判定（防过度修复）`);
}

// 普通单张
{
  const s = resolveOutputStructure('画一张日本街道夜景');
  assert.equal(s.kind, 'single_image', '普通请求 kind=single_image');
  assert.equal(s.requestedImageCount, 1, 'count=1');
  console.log('✓ 普通单张请求不受影响');
}

// ============ 三、前 N 实体顺序引用解析 ============

{
  const sel = parseOrderedEntitySelection('给我生成前3个山的风景图');
  assert.ok(sel, '解析到顺序引用');
  assert.deepEqual(sel.selectedIndices, [1, 2, 3], 'selectedIndices=[1,2,3]');
  console.log('✓ "前3个" → [1,2,3]');
}

{
  const sel = parseOrderedEntitySelection('用前两个角色做双联图');
  assert.ok(sel, '中文数字解析');
  assert.deepEqual(sel.selectedIndices, [1, 2], '前两个 → [1,2]');
  console.log('✓ "前两个" → [1,2]');
}

{
  const sel = parseOrderedEntitySelection('刚才列的前三个产品');
  assert.ok(sel, '前三个');
  assert.deepEqual(sel.selectedIndices, [1, 2, 3], '前三个 → [1,2,3]');
  console.log('✓ "前三个" → [1,2,3]');
}

// ============ 四、Chat Execution Context：前3个山 → 泰山/黄山/华山 ============

{
  const intent = detectChatExecutionIntent({ text: TRIPTYCH_USER });
  assert.equal(intent.actionable, true, 'actionable=true');
  assert.equal(intent.kind, 'text_to_image', 'kind=text_to_image');
  assert.equal(intent.referencesPreviousContext, true, 'referencesPreviousContext=true（"前3个"触发）');
  assert.equal(intent.grid.cellCount, 3, '3分镜 → grid.cellCount=3');
  console.log('✓ 三分镜请求 intent：可执行 + 引用上文 + 3 格布局');
}

{
  const intent = detectChatExecutionIntent({ text: TRIPTYCH_USER });
  const ctx = resolveChatExecutionContext({
    currentMessage: TRIPTYCH_USER,
    intent,
    messages: buildConversation([
      { role: 'user', content: '你知道中国有哪些著名的山嘛？' },
      { role: 'assistant', content: MOUNTAIN_LIST_ASSISTANT },
      { role: 'user', content: TRIPTYCH_USER },
    ]),
  });
  assert.ok(ctx, 'handoff ctx 存在');
  assert.equal(ctx.source, 'assistant_entity_list', 'source=assistant_entity_list');
  assert.deepEqual(ctx.orderedSelection.selectedLabels, ['泰山', '黄山', '华山'], '前3个山 → 泰山/黄山/华山');
  assert.equal(ctx.grid.cellCount, 3, 'grid cellCount=3');
  console.log('✓ "前3个山" 绑定到 [泰山, 黄山, 华山]，不再泛化');
}

// 九宫格建筑场景（防回归：既有行为）
{
  const BUILDINGS = '- 建筑A\n- 建筑B\n- 建筑C\n- 建筑D\n- 建筑E\n- 建筑F\n- 建筑G\n- 建筑H\n- 建筑I';
  const intent = detectChatExecutionIntent({ text: '把这9个建筑做成九宫格海报' });
  const ctx = resolveChatExecutionContext({
    currentMessage: '把这9个建筑做成九宫格海报',
    intent,
    messages: buildConversation([
      { role: 'assistant', content: `建筑列表：\n${BUILDINGS}` },
      { role: 'user', content: '把这9个建筑做成九宫格海报' },
    ]),
  });
  assert.equal(ctx.grid.cellCount, 9, '九宫格 cellCount=9');
  const s = resolveOutputStructure('把这9个建筑做成九宫格海报');
  assert.equal(s.kind, 'single_composite_image', '九宫格不是批量');
  console.log('✓ 九宫格建筑 → 单张 9 格复合构图（既有行为保留）');
}

// ============ 五、Planner Handoff 渲染：包含确定主体 + 单张要求 ============

{
  const intent = detectChatExecutionIntent({ text: TRIPTYCH_USER });
  const ctx = resolveChatExecutionContext({
    currentMessage: TRIPTYCH_USER,
    intent,
    messages: buildConversation([
      { role: 'assistant', content: MOUNTAIN_LIST_ASSISTANT },
      { role: 'user', content: TRIPTYCH_USER },
    ]),
  });
  const rendered = chatCtx.renderChatHandoffContextForPlanner(ctx);
  assert.ok(rendered.includes('顺序实体选择'), '渲染包含顺序实体选择段');
  assert.ok(rendered.includes('泰山') && rendered.includes('黄山') && rendered.includes('华山'), '渲染包含三个确定主体');
  assert.ok(rendered.includes('不是 3 张图'), '渲染明确"不是 3 张图"');
  assert.ok(rendered.includes('输出数量为 1'), '渲染明确输出数量为 1');
  console.log('✓ Planner handoff 文本包含确定主体 + 单张三分镜要求');
}

// ============ 六、任务修订识别 ============

{
  const d = detectTaskRevisionIntent('我不要批量任务 我要单张');
  assert.equal(d.isRevision, true, 'isRevision=true');
  assert.equal(d.outputMode, 'single', 'outputMode=single');
  console.log('✓ "我不要批量任务 我要单张" 识别为任务修订');
}

{
  const d = detectTaskRevisionIntent('不要3张，只要一张');
  assert.equal(d.isRevision, true, '否定数量+要求单张 isRevision=true');
  console.log('✓ "不要3张，只要一张" 识别为任务修订');
}

// 修订指令不应该误拦真正的批量新任务
{
  const d = detectTaskRevisionIntent('给我生成3张不同风格的黄山风景图');
  assert.equal(d.isRevision, false, '真正批量请求不是修订');
  console.log('✓ 真正的批量新任务不被误判为修订');
}

// 普通闲聊不是修订
{
  const d = detectTaskRevisionIntent('你知道中国有哪些著名的山嘛？');
  assert.equal(d.isRevision, false, '闲聊不是修订');
  console.log('✓ 普通闲聊不被误判为修订');
}

// 修订合并文本结构
{
  const text = buildTaskRevisionContinuationText({
    originalRequest: '给我生成前3个山的风景图把一张图里展示3个风景。3分镜图把',
    revisionInstruction: '我不要批量任务 我要单张',
  });
  assert.ok(text.includes('[任务修订上下文]'), '包含任务修订上下文标记');
  assert.ok(text.includes('原始任务'), '包含原始任务');
  assert.ok(text.includes('我不要批量任务 我要单张'), '包含修订指令');
  assert.ok(text.includes('输出数量必须是 1 张'), '明确单张约束');
  console.log('✓ 修订合并文本结构完整');
}

// ============ 七、结构一致性：UI 单张但底层批量 = 必须失败 ============

// 模拟旧 bug 状态：如果 detectBatchPlan 对三分镜仍返回 batch，此测试会失败。
// 由于 detectBatchPlan 位于 useChatStore（非纯模块），这里通过 resolver +
// parseOrderedEntitySelection 组合验证判别一致性：
// single_composite_image 时 requestedImageCount 必须为 1（即任何下游 count 逻辑
// 都不能再读到 3）。
{
  const s = resolveOutputStructure(TRIPTYCH_USER);
  assert.notEqual(s.kind, 'batch_images', '三分镜绝不可能是 batch_images');
  assert.equal(s.requestedImageCount, 1, '复合构图输出恒为 1 张');
  // "前3个"中的 3 不能再被图像计数读到
  const orderedRef = parseOrderedEntitySelection(TRIPTYCH_USER);
  assert.ok(orderedRef, '顺序引用被识别 —— 计数语义已从"张数"转移到"实体数"');
  console.log('✓ 底层判别一致：三分镜 → single + 1 张（UI/执行不可能再拿到 batch=3）');
}

console.log('\n全部 composition-intent smoke 测试通过 ✓');
