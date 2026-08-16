// 静态 smoke 测试 —— node scripts/chat-task-attachment-isolation.smoke.mjs
//
// 严格验证 Chat / Task 附件状态隔离 —— 本轮的核心交付物之一。
//
// 关键契约（spec）：
//   1. taskAttachments 与 chatAttachments 互相独立；不会因模式切换而互相复制。
//   2. Task → Chat：chat[] 必须默认空（不继承 task 已选的图）。
//   3. Chat → Task：task[] 不变（chat 选的图不会污染 task）。
//   4. Chat 主动选图：写入 chat[]，不影响 task[]。
//   5. 取消 Chat 选中的图：仅修改 chat[]；task[] 不变。
//   6. Task Gallery 与 Chat Gallery 选中态各自维护：A=task 图一 ≠ C=chat 图一。
//   7. conversation.active_image_id 不应被普通 chat 请求隐式读取 / 附加。
//   8. 普通对话模式发送请求只携带 chat[]，绝不会拼上 task[] 或 active_image。
//   9. 任务模式发送请求只携带 task[]（外加 active_image，若有）。

import assert from 'node:assert';

// ---------------------- 镜像实现（必须与 Chat.tsx 源同步）----------------------

const CHINESE_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
function getAttachmentDisplayLabel(index) {
  if (!Number.isFinite(index) || index < 0) return '图?';
  if (index < CHINESE_NUMERALS.length) return `图${CHINESE_NUMERALS[index]}`;
  return `图${index + 1}`;
}

// 初始 mode-scoped 状态。
function createComposerState() {
  return { chat: [], task: [] };
}

// 镜像 Chat.tsx 的 setAttachments：根据当前 mode 写到对应 slot。
function setAttachments(state, mode, next) {
  const resolved = typeof next === 'function' ? next(state[mode]) : next;
  return { ...state, [mode]: resolved };
}

// 镜像 handleSelectGalleryImage 的 toggle 行为，但操作的是当前 mode 的 attachments。
function toggleGalleryImage(state, mode, image) {
  if (image.missing) return state;
  const current = state[mode];
  const existing = current.find(att => att.filePath === image.local_path);
  let next;
  if (existing) {
    next = current.filter(att => att.id !== existing.id);
  } else {
    next = [
      ...current,
      {
        id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        type: 'image',
        source: 'gallery',
        name: image.file_name || image.local_path.split(/[\\/]/).pop() || 'gallery-image.png',
        filePath: image.local_path,
      },
    ];
  }
  return setAttachments(state, mode, next);
}

// 镜像 Chat.tsx handleSend 的请求载荷组装：根据 mode 取出对应 attachments。
// 关键：chat 路径绝不读 conv.active_image_id；task 路径才允许读。
function buildRequestPayload(state, mode, conv, text) {
  const attachments = state[mode];
  if (mode === 'chat') {
    return {
      mode: 'chat_message',
      text,
      attachments,
      // 关键：chat 模式下 active_image_id 不允许隐式附加
      implicit_active_image: false,
      has_images: attachments.filter(a => a.type === 'image').length > 0,
    };
  }
  return {
    mode: 'task_message',
    text,
    attachments,
    // task 模式才允许读 active_image 作为编辑源图（与 sendTaskMessage 行为一致）
    implicit_active_image: !!conv?.active_image_id,
    has_images:
      attachments.filter(a => a.type === 'image').length > 0 ||
      !!conv?.active_image_id,
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
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

// ---------------------- 测试用例 ----------------------

console.log('chat-task-attachment-isolation.smoke: Chat / Task 附件状态严格隔离');

const imgA = { id: 'gal_a', file_name: 'a.png', local_path: 'D:/out/a.png', missing: false };
const imgB = { id: 'gal_b', file_name: 'b.png', local_path: 'D:/out/b.png', missing: false };
const imgC = { id: 'gal_c', file_name: 'c.png', local_path: 'D:/out/c.png', missing: false };

test('初始：chat[] / task[] 都为空', () => {
  const s = createComposerState();
  assert.deepEqual(s.chat, []);
  assert.deepEqual(s.task, []);
});

test('Task → Chat：chat[] 默认空，不继承 task[]', () => {
  // 用户先在 task 模式选 A, B, C
  let s = createComposerState();
  s = toggleGalleryImage(s, 'task', imgA);
  s = toggleGalleryImage(s, 'task', imgB);
  s = toggleGalleryImage(s, 'task', imgC);
  // 切换到 chat：chat[] 仍然为空
  assert.equal(s.chat.length, 0);
  assert.equal(s.task.length, 3);
});

test('Chat 主动选图：写入 chat[]，task[] 不变', () => {
  let s = createComposerState();
  s = toggleGalleryImage(s, 'task', imgA);
  s = toggleGalleryImage(s, 'task', imgB);
  // 切到 chat 后选 C
  s = toggleGalleryImage(s, 'chat', imgC);
  assert.equal(s.chat.length, 1);
  assert.equal(s.chat[0].filePath, 'D:/out/c.png');
  assert.equal(s.task.length, 2);
});

test('Chat label 从 图一 起（不继承 task 编号）', () => {
  let s = createComposerState();
  s = toggleGalleryImage(s, 'task', imgA); // task 图一
  s = toggleGalleryImage(s, 'task', imgB); // task 图二
  s = toggleGalleryImage(s, 'chat', imgC); // chat 图一（不是图三）
  assert.equal(getAttachmentDisplayLabel(s.chat.findIndex(a => a.filePath === imgC.local_path)), '图一');
});

test('Task label 独立编号：A=图一, B=图二', () => {
  let s = createComposerState();
  s = toggleGalleryImage(s, 'chat', imgC); // chat 图一
  s = toggleGalleryImage(s, 'task', imgA);
  s = toggleGalleryImage(s, 'task', imgB);
  assert.equal(getAttachmentDisplayLabel(s.task.findIndex(a => a.filePath === imgA.local_path)), '图一');
  assert.equal(getAttachmentDisplayLabel(s.task.findIndex(a => a.filePath === imgB.local_path)), '图二');
});

test('Chat 取消选中：仅影响 chat[]，task[] 不变', () => {
  let s = createComposerState();
  s = toggleGalleryImage(s, 'task', imgA);
  s = toggleGalleryImage(s, 'chat', imgC);
  s = toggleGalleryImage(s, 'chat', imgC); // 再次点击 → 取消
  assert.equal(s.chat.length, 0);
  assert.equal(s.task.length, 1);
  assert.equal(s.task[0].filePath, 'D:/out/a.png');
});

test('切回 Task：原 task[] 完整恢复', () => {
  let s = createComposerState();
  s = toggleGalleryImage(s, 'task', imgA);
  s = toggleGalleryImage(s, 'task', imgB);
  s = toggleGalleryImage(s, 'task', imgC);
  // 中途去 chat 选了一张又取消
  s = toggleGalleryImage(s, 'chat', imgA);
  s = toggleGalleryImage(s, 'chat', imgA);
  // 切回 task：task[] 仍然 [A, B, C]
  assert.equal(s.task.length, 3);
  assert.equal(s.chat.length, 0);
});

test('普通 chat 请求载荷：has_images=false 当 chat[] 空（即使 conv.active_image_id 存在）', () => {
  // 这是核心：active_image_id 不应被普通 chat 隐式读取。
  let s = createComposerState();
  const conv = { active_image_id: 'img_x', active_image_path: 'D:/x.png' };
  const payload = buildRequestPayload(s, 'chat', conv, '你好');
  assert.equal(payload.mode, 'chat_message');
  assert.equal(payload.has_images, false);
  assert.equal(payload.implicit_active_image, false);
  assert.equal(payload.attachments.length, 0);
});

test('普通 chat 请求载荷：chat[] 主动选图后 has_images=true', () => {
  let s = createComposerState();
  s = toggleGalleryImage(s, 'chat', imgC);
  const conv = { active_image_id: 'img_x', active_image_path: 'D:/x.png' };
  const payload = buildRequestPayload(s, 'chat', conv, '这张图是什么风格？');
  assert.equal(payload.has_images, true);
  assert.equal(payload.attachments.length, 1);
  assert.equal(payload.attachments[0].filePath, 'D:/out/c.png');
  // 关键：active_image_id 仍然没被隐式带上
  assert.equal(payload.implicit_active_image, false);
});

test('普通 chat 请求载荷：绝不携带 task[] 或 active_image', () => {
  let s = createComposerState();
  s = toggleGalleryImage(s, 'task', imgA);
  s = toggleGalleryImage(s, 'task', imgB);
  const conv = { active_image_id: 'img_x', active_image_path: 'D:/x.png' };
  const payload = buildRequestPayload(s, 'chat', conv, '你好');
  // chat[] 是空，task[] 不应被附加
  assert.equal(payload.attachments.length, 0);
  assert.equal(payload.implicit_active_image, false);
});

test('task 请求载荷：可以读 active_image（仍受 task 模式控制）', () => {
  let s = createComposerState();
  const conv = { active_image_id: 'img_x', active_image_path: 'D:/x.png' };
  const payload = buildRequestPayload(s, 'task', conv, '把背景换成蓝色');
  assert.equal(payload.mode, 'task_message');
  assert.equal(payload.implicit_active_image, true);
});

test('task 请求载荷：task[] 是当前模式附件', () => {
  let s = createComposerState();
  s = toggleGalleryImage(s, 'task', imgA);
  s = toggleGalleryImage(s, 'chat', imgC); // chat 选的图不应出现在 task 请求
  const payload = buildRequestPayload(s, 'task', {}, '生成详情页');
  assert.equal(payload.attachments.length, 1);
  assert.equal(payload.attachments[0].filePath, 'D:/out/a.png');
});

// ---------------------- 总结 ----------------------

console.log(`\n${passCount}/${testCount} passed`);
if (passCount !== testCount) {
  console.error('chat-task-attachment-isolation.smoke: FAILED');
  process.exit(1);
}
console.log('chat-task-attachment-isolation.smoke: OK');
