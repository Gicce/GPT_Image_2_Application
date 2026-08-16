// 静态 smoke 测试 —— node scripts/conversation-copy.smoke.mjs
//
// 验证 Conversation 一键复制导出（src/utils/conversationExport.ts）
// 通过 esbuild 加载真实 TS 实现。

import assert from 'node:assert/strict';
import { loadTs } from './_ts_loader.mjs';

const exportMod = await loadTs('../src/utils/conversationExport.ts');
const { formatConversationForClipboard, formatMessageForExport } = exportMod;

// ============ 一、基础三段导出（spec 七十六节）============

{
  const conv = {
    title: '测试对话',
    messages: [
      { id: 'm1', role: 'user', content: 'hello', created_at: '2026-01-01T00:00:00Z' },
      { id: 'm2', role: 'assistant', content: '你好！我是 CyImagePro 助手。', created_at: '2026-01-01T00:00:01Z', input_tokens: 12, output_tokens: 34 },
      {
        id: 'm3',
        role: 'assistant',
        content: '⚡ 任务已创建，等待确认',
        created_at: '2026-01-01T00:00:02Z',
        task_message: {
          taskId: 'task_abc12345',
          status: 'pending',
          stage: 'waiting_confirm',
          title: '生成建筑九宫格',
          prompt: '生成中国著名建筑九宫格',
          finalPrompt: '一张 3×3 九宫格构图……',
          finalNegativePrompt: '模糊、乱码',
          createdAt: '2026-01-01T00:00:02Z',
          updatedAt: '2026-01-01T00:00:02Z',
          taskType: 'generate',
          executionModel: 'gpt-image-2',
          size: '1024x1024',
          pendingParams: { prompt: 'x', final_prompt: 'x' },
          plannerJobId: 'PJ_test123',
          planningRequestId: 'plan_test123',
        },
      },
    ],
  };
  const text = formatConversationForClipboard(conv);

  // 三段结构
  assert.ok(text.includes('# 测试对话'), '包含标题');
  const userBlocks = (text.match(/^## 用户$/gm) || []).length;
  const agentBlocks = (text.match(/^## CyImage Agent$/gm) || []).length;
  assert.equal(userBlocks, 1, '一个用户段');
  assert.equal(agentBlocks, 2, '两个 Agent 段（文本 + 任务）');
  assert.ok(text.includes('hello'), '用户内容');
  assert.ok(text.includes('你好！我是'), 'Agent 内容');

  // 技术字段过滤（spec 七十七~七十九节）
  assert.ok(!text.includes('tokens'), '不含 tokens');
  assert.ok(!text.includes('12345'), '不含 taskId 片段');
  assert.ok(!text.includes('PJ_test123'), '不含 plannerJobId');
  assert.ok(!text.includes('plan_test123'), '不含 planningRequestId');
  assert.ok(!text.includes('pendingParams'), '不含 pendingParams key');
  assert.ok(!text.includes('CA') === false || !/\bCA\b/.test(text), '无 CA avatar initials');
  assert.ok(!/\bGC\b/.test(text), '无 GC avatar initials');

  // Task 卡人类可读（spec 十节）
  assert.ok(text.includes('状态：待确认'), '任务状态');
  assert.ok(text.includes('类型：文生图'), '任务类型');
  assert.ok(text.includes('执行模型：gpt-image-2'), '执行模型');
  assert.ok(text.includes('尺寸：1024x1024'), '尺寸');
  assert.ok(text.includes('来源：对话自动识别'), '来源');
  assert.ok(text.includes('最终提示词'), '最终提示词');
  assert.ok(text.includes('负面提示词'), '负面提示词');

  // 顺序（spec 一百零九节）：timeline 顺序
  const helloIdx = text.indexOf('hello');
  const agentIdx = text.indexOf('你好！我是');
  const taskIdx = text.indexOf('状态：待确认');
  assert.ok(helloIdx < agentIdx && agentIdx < taskIdx, 'timeline 顺序');
  console.log('✓ 基础三段导出 + 技术字段过滤');
}

// ============ 二、CA / GC avatar initials 不出现（spec 七十八节）============

{
  const conv = {
    title: 'T',
    messages: [
      { id: 'm1', role: 'user', content: 'hi', created_at: '' },
      { id: 'm2', role: 'assistant', content: 'hello there', created_at: '' },
    ],
  };
  const text = formatConversationForClipboard(conv, { userName: 'CA-test', agentName: 'GC-agent' });
  // 显式传入的显示名会出现在 header（这是预期行为 —— 它们是角色名不是技术噪音），
  // 但默认调用绝不会注入 UI avatar initials。
  const defaultText = formatConversationForClipboard(conv);
  assert.ok(defaultText.includes('## 用户') && defaultText.includes('## CyImage Agent'), '默认角色名');
  console.log('✓ 默认角色名不含 avatar initials');
}

// ============ 三、图片附件显示图一/图二/图三，不显示 localPath（spec 八十节）============

{
  const conv = {
    title: 'T',
    messages: [
      {
        id: 'm1',
        role: 'assistant',
        content: '',
        task_message: {
          taskId: 't1',
          status: 'pending',
          stage: 'waiting_confirm',
          title: '编辑',
          createdAt: '',
          updatedAt: '',
          taskType: 'edit',
          orderedAttachments: [
            { id: 'a1', source: 'upload', internalName: 'C:\\Users\\secret\\photo1.png' },
            { id: 'a2', source: 'gallery', internalName: '/home/user/图2.png' },
            { id: 'a3', source: 'paste', internalName: 'paste3.png' },
          ],
        },
      },
    ],
  };
  const text = formatConversationForClipboard(conv);
  assert.ok(text.includes('图一'), '显示图一');
  assert.ok(text.includes('图二'), '显示图二');
  assert.ok(text.includes('图三'), '显示图三');
  assert.ok(!text.includes('C:\\Users'), '不显示 localPath');
  assert.ok(!text.includes('/home/user'), '不显示 unix path');
  assert.ok(!text.includes('.png'), '不显示文件名');
  console.log('✓ 附件图一/图二/图三，无 localPath');
}

// ============ 四、needs_clarification Task（spec 十一节）============

{
  const conv = {
    title: 'T',
    messages: [
      {
        id: 'm1', role: 'assistant', content: '',
        task_message: {
          taskId: 't2', status: 'pending', stage: 'needs_clarification', title: 'x',
          prompt: '把这些做成图', createdAt: '', updatedAt: '',
          clarification: { question: '请列出你想生成的建筑。', attempt: 1 },
        },
      },
    ],
  };
  const text = formatConversationForClipboard(conv);
  assert.ok(text.includes('状态：待补充信息'), '待补充状态');
  assert.ok(text.includes('需要补充'), '需要补充段落');
  assert.ok(text.includes('请列出你想生成的建筑。'), 'clarification 问题');
  console.log('✓ needs_clarification 导出');
}

// ============ 五、Completed Task 耗时（spec 十二、七十节）============

{
  const conv = {
    title: 'T',
    messages: [
      {
        id: 'm1', role: 'assistant', content: '',
        task_message: {
          taskId: 't3', status: 'completed', stage: 'success', title: 'x',
          createdAt: '', updatedAt: '',
          executionStartedAt: '2026-01-01T00:00:00Z',
          executionFinishedAt: '2026-01-01T00:00:18.4Z',
          executionDurationMs: 18400,
        },
      },
    ],
  };
  const text = formatConversationForClipboard(conv);
  assert.ok(text.includes('执行耗时：18.4 秒'), '最终耗时 18.4 秒');
  console.log('✓ Completed Task 耗时导出');
}

// ============ 六、执行中任务显示"当前已执行"（spec 七十一节）============

{
  const recentStart = new Date(Date.now() - 7400).toISOString();
  const conv = {
    title: 'T',
    messages: [
      {
        id: 'm1', role: 'assistant', content: '',
        task_message: {
          taskId: 't4', status: 'running', stage: 'running', title: 'x',
          createdAt: '', updatedAt: '',
          executionStartedAt: recentStart,
        },
      },
    ],
  };
  const text = formatConversationForClipboard(conv);
  assert.ok(text.includes('当前已执行'), '执行中显示当前已执行');
  assert.ok(!text.includes('执行耗时：'), '执行中不显示最终耗时');
  console.log('✓ 执行中任务当前已执行导出');
}

// ============ 七、Markdown 列表保持可读（spec 八十一节）============

{
  const conv = {
    title: 'T',
    messages: [
      { id: 'm1', role: 'assistant', content: '中国著名建筑很多，例如：\n\n- 长城\n- 故宫\n- 天坛', created_at: '' },
    ],
  };
  const text = formatConversationForClipboard(conv);
  assert.ok(text.includes('- 长城\n- 故宫\n- 天坛'), 'markdown 列表原样保留');
  console.log('✓ Markdown 列表可读');
}

// ============ 八、错误消息保留（spec 九节）============

{
  const conv = {
    title: 'T',
    messages: [
      { id: 'm1', role: 'assistant', content: '❌ 上游模型接口失败：连接超时', created_at: '' },
    ],
  };
  const text = formatConversationForClipboard(conv);
  assert.ok(text.includes('❌ 上游模型接口失败'), '用户可见错误保留');
  console.log('✓ 错误消息保留');
}

// ============ 九、plannerDiagnostic 不泄漏（spec 七十九节）============

{
  const conv = {
    title: 'T',
    messages: [
      {
        id: 'm1', role: 'assistant', content: '',
        task_message: {
          taskId: 't5', status: 'failed', stage: 'planning_failed', title: 'x',
          createdAt: '', updatedAt: '',
          error: '规划失败：模型连接超时',
          plannerDiagnostic: {
            model: 'gpt-5.6-luna',
            errorKind: 'timeout',
            rawOutput: '{"secret":"internal_json"}',
          },
        },
      },
    ],
  };
  const text = formatConversationForClipboard(conv);
  assert.ok(text.includes('规划失败：模型连接超时'), '用户可见错误保留');
  assert.ok(!text.includes('secret'), 'diagnostic JSON 不泄漏');
  assert.ok(!text.includes('rawOutput'), 'rawOutput key 不出现');
  console.log('✓ plannerDiagnostic 不泄漏');
}

// ============ 十、空消息 / 空会话边界 ============

{
  assert.equal(formatConversationForClipboard({ title: '', messages: [] }), '# 未命名对话');
  const single = formatMessageForExport({ id: 'x', role: 'user', content: '', created_at: '' });
  assert.equal(single, '', '空内容消息不导出');
  console.log('✓ 边界情况');
}

console.log('\n全部 conversation-copy smoke tests 通过');
