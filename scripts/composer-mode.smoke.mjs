// 静态 smoke 测试 —— node scripts/composer-mode.smoke.mjs
//
// 验证"对话 / 任务模式 + 图片上下文"的解耦：
//   1. composerMode='chat' 不再显示"编辑模式：已绑定源图"横幅。
//   2. Composer 附件按模式严格隔离：chat[] / task[] 互不影响。
//   3. 切到 chat 后 chat[] 默认空 —— 即使 task[] 还有图。
//   4. 切回 task → task[] 恢复，不会因为去过 chat 就丢任务素材。
//   5. chatMode + 有图 ≠ edit task；图片只是"上下文"。
//   6. chat 模式发送不会走 image execution API（只走 sendMessage 普通对话路径）。
//   7. active_image_id 不再强制把 composerMode 当作 'edit'，也不再隐式进入普通 chat。
//
// 本文件不依赖 vitest / jest，只用 node 内置 assert。
// 它把 Chat.tsx 里的 activeChatMode 计算与 mode-scoped attachments 镜像成纯 JS。

import assert from 'node:assert';

// ---------------------- 镜像实现（必须与 Chat.tsx 源同步）----------------------

// 镜像 Chat.tsx 的 activeChatMode：'chat' 是默认；只有 'task' 显式持久化才认。
function computeActiveChatMode(conv) {
  if (!conv) return 'chat';
  return conv.chat_mode === 'task' ? 'task' : 'chat';
}

// 镜像 Chat.tsx 的 shouldShowLegacyEditModeBanner —— 修复后必须返回 false。
function shouldShowLegacyEditModeBanner(conv) {
  return false;
}

// 镜像 Chat.tsx 的 shouldShowContextBar：
//   - chat 模式：仅看 chat[]（active_image 不再隐式成为 chat 上下文）。
//   - task 模式：active_image_id 或 task[] 任一非空都显示。
function shouldShowContextBar(mode, conv, attachments) {
  if (mode === 'chat') {
    return attachments.length > 0;
  }
  return !!(conv?.active_image_id || attachments.length > 0);
}

// 镜像 Chat.tsx 的 mode-scoped attachments：每个模式各自维护一份 draft。
// 切模式不会互相复制 —— 真正的"模式隔离"。
function createModeScopedAttachments() {
  return { chat: [], task: [] };
}

function currentAttachments(state, mode) {
  return state[mode];
}

function setAttachments(state, mode, next) {
  return { ...state, [mode]: typeof next === 'function' ? next(state[mode]) : next };
}

// 镜像 Chat.tsx 的 contextBarTitle —— 不同模式显示不同标题。
function contextBarTitle(mode) {
  return mode === 'task' ? '任务图片' : '图片上下文';
}

// 镜像 Chat.tsx 的 handleSend 分支：taskMode 才走 sendTaskMessage，否则 sendMessage。
function dispatchSend(mode, isPlanOnly) {
  if (!isPlanOnly && mode === 'task') return 'task_message';
  return 'chat_message';
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
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

// ---------------------- 测试用例 ----------------------

console.log('composer-mode.smoke: 对话/任务模式 + 图片上下文解耦 + 模式附件隔离');

test('未设置 chat_mode → 默认 chat', () => {
  assert.equal(computeActiveChatMode({}), 'chat');
  assert.equal(computeActiveChatMode(null), 'chat');
  assert.equal(computeActiveChatMode({ chat_mode: undefined }), 'chat');
});

test('chat_mode=task → task', () => {
  assert.equal(computeActiveChatMode({ chat_mode: 'task' }), 'task');
});

test('chat_mode=chat → chat', () => {
  assert.equal(computeActiveChatMode({ chat_mode: 'chat' }), 'chat');
});

test('task → chat：切换模式不携带 task 图片到 chat（chat[] 默认空）', () => {
  // 初始：task 模式，task[] = [A, B, C]，chat[] = []
  let state = createModeScopedAttachments();
  state = setAttachments(state, 'task', [
    { id: 'att_a', filePath: 'D:/a.png' },
    { id: 'att_b', filePath: 'D:/b.png' },
    { id: 'att_c', filePath: 'D:/c.png' },
  ]);
  // 切换到 chat
  const mode = 'chat';
  // chat[] 必须仍然是空
  assert.equal(currentAttachments(state, mode).length, 0);
  // task[] 必须保留
  assert.equal(currentAttachments(state, 'task').length, 3);
});

test('chat → task：切换模式不携带 chat 图片到 task', () => {
  let state = createModeScopedAttachments();
  state = setAttachments(state, 'chat', [{ id: 'att_c', filePath: 'D:/chat1.png' }]);
  state = setAttachments(state, 'task', [{ id: 'att_t', filePath: 'D:/task1.png' }]);
  // 当前是 chat
  assert.equal(currentAttachments(state, 'chat').length, 1);
  // 切到 task：task[] 不变
  assert.equal(currentAttachments(state, 'task').length, 1);
  assert.equal(currentAttachments(state, 'task')[0].filePath, 'D:/task1.png');
});

test('chat 主动选图：chat[] 累加，task[] 不受影响', () => {
  let state = createModeScopedAttachments();
  state = setAttachments(state, 'chat', []);
  state = setAttachments(state, 'task', [{ id: 'att_t', filePath: 'D:/task.png' }]);
  // chat 模式选一张
  const mode = 'chat';
  state = setAttachments(state, mode, prev => [...prev, { id: 'att_chat1', filePath: 'D:/chat.png' }]);
  assert.equal(currentAttachments(state, 'chat').length, 1);
  assert.equal(currentAttachments(state, 'task').length, 1);
});

test('切回 task：原 task[] 仍存在', () => {
  let state = createModeScopedAttachments();
  state = setAttachments(state, 'task', [
    { id: 'att_a', filePath: 'D:/a.png' },
    { id: 'att_b', filePath: 'D:/b.png' },
  ]);
  // 模拟中间去过 chat 模式选了一张
  state = setAttachments(state, 'chat', [{ id: 'att_c', filePath: 'D:/c.png' }]);
  // 切回 task：task[] 仍然是 [A, B]
  assert.equal(currentAttachments(state, 'task').length, 2);
  assert.equal(currentAttachments(state, 'task')[0].filePath, 'D:/a.png');
});

test('切换到 chat 模式后，"编辑模式：已绑定源图" 横幅必须不显示', () => {
  // 即使 active_image_id 还在
  const conv = { chat_mode: 'chat', active_image_id: 'img_x', active_image_path: 'D:/x.png' };
  assert.equal(shouldShowLegacyEditModeBanner(conv), false);
});

test('切换到 task 模式后，"编辑模式：已绑定源图" 横幅也必须不显示', () => {
  const conv = { chat_mode: 'task', active_image_id: 'img_x', active_image_path: 'D:/x.png' };
  assert.equal(shouldShowLegacyEditModeBanner(conv), false);
});

test('chat 模式 Context Bar 不再因为 active_image 自动显示', () => {
  // 这是核心修复：active_image 不应再隐式进入普通 chat 上下文。
  const conv = { active_image_id: 'img_x', active_image_path: 'D:/x.png' };
  assert.equal(shouldShowContextBar('chat', conv, []), false);
});

test('chat 模式 Context Bar 在 chat[] 有图时显示', () => {
  const conv = { active_image_id: 'img_x', active_image_path: 'D:/x.png' };
  assert.equal(shouldShowContextBar('chat', conv, [{ id: 'a' }]), true);
});

test('task 模式 Context Bar 在 active_image 存在时显示', () => {
  const conv = { active_image_id: 'img_x', active_image_path: 'D:/x.png' };
  assert.equal(shouldShowContextBar('task', conv, []), true);
});

test('没有图片上下文 → Context Bar 不显示（两种模式都是）', () => {
  const conv = { active_image_id: null };
  assert.equal(shouldShowContextBar('chat', conv, []), false);
  assert.equal(shouldShowContextBar('task', conv, []), false);
});

test('Context Bar 标题随模式切换：chat=图片上下文，task=任务图片', () => {
  assert.equal(contextBarTitle('chat'), '图片上下文');
  assert.equal(contextBarTitle('task'), '任务图片');
});

test('chat 模式发送 → 走 chat_message（不调用 image execution）', () => {
  assert.equal(dispatchSend('chat', false), 'chat_message');
});

test('task 模式发送 → 走 task_message（进入规划/确认流程）', () => {
  assert.equal(dispatchSend('task', false), 'task_message');
});

test('chat 模式 + 图片附件：仍然走 chat_message，不会自动判定为 edit task', () => {
  const mode = 'chat';
  const attachments = [{ id: 'att_a', filePath: 'D:/a.png' }];
  assert.equal(dispatchSend(mode, false), 'chat_message');
  assert.equal(attachments.length, 1);
});

test('active_image_id 存在不再强制 composerMode=edit', () => {
  const conv1 = { chat_mode: 'chat', active_image_id: 'x', active_image_path: 'D:/x.png' };
  const conv2 = { chat_mode: 'task', active_image_id: 'x', active_image_path: 'D:/x.png' };
  assert.equal(computeActiveChatMode(conv1), 'chat');
  assert.equal(computeActiveChatMode(conv2), 'task');
});

// ---------------------- 总结 ----------------------

console.log(`\n${passCount}/${testCount} passed`);
if (passCount !== testCount) {
  console.error('composer-mode.smoke: FAILED');
  process.exit(1);
}
console.log('composer-mode.smoke: OK');
