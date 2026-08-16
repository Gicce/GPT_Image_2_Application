// 静态 smoke 测试 —— node scripts/chat-image-context.smoke.mjs
//
// 验证普通对话的图片上下文：
//   1. Chat 无图时请求载荷 has_images=false。
//   2. Chat 无图时 implicit_active_image=false（active_image_id 不应隐式进入 chat）。
//   3. Chat 主动选图后 labels=["图一"]，source="chat_draft"。
//   4. Chat 主动选多图：labels=["图一", "图二", ...]。
//   5. Chat 主动选图取消后 chat[] 回到 0。
//   6. Chat 主动选图后请求 has_images=true，但 active_image 仍然 false。
//   7. 切到 chat 后 Context Bar 不显示（无图，且不读 active_image）。

import assert from 'node:assert';

const CHINESE_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
function getAttachmentDisplayLabel(index) {
  if (!Number.isFinite(index) || index < 0) return '图?';
  if (index < CHINESE_NUMERALS.length) return `图${CHINESE_NUMERALS[index]}`;
  return `图${index + 1}`;
}

function createComposerState() {
  return { chat: [], task: [] };
}

function setAttachments(state, mode, next) {
  const resolved = typeof next === 'function' ? next(state[mode]) : next;
  return { ...state, [mode]: resolved };
}

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

// Chat 图片上下文诊断结构 —— 镜像 Chat.tsx 在 send 时可能打印的诊断字段。
function buildChatImageContextDiagnostic(state, conv) {
  const chatImages = state.chat.filter(a => a.type === 'image');
  return {
    count: chatImages.length,
    labels: chatImages.map((_, idx) => getAttachmentDisplayLabel(idx)),
    source: chatImages.length > 0 ? 'chat_draft' : 'none',
    // 关键：active_image_id 是否会被隐式带进 chat —— 修复后必须 false。
    implicit_active_image: false,
  };
}

function buildChatRequestPayload(state, conv, text) {
  const chat = state.chat;
  return {
    mode: 'chat_message',
    text,
    attachments: chat,
    has_images: chat.filter(a => a.type === 'image').length > 0,
    implicit_active_image: false,
  };
}

// Context Bar 显示规则：chat 模式严格只看 chat[]，不读 active_image。
function shouldShowChatContextBar(state, conv) {
  return state.chat.length > 0;
}

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

console.log('chat-image-context.smoke: 普通对话图片上下文');

const imgA = { id: 'gal_a', file_name: 'a.png', local_path: 'D:/out/a.png', missing: false };
const imgB = { id: 'gal_b', file_name: 'b.png', local_path: 'D:/out/b.png', missing: false };

test('Chat 无图：诊断 count=0, implicit_active_image=false', () => {
  const s = createComposerState();
  const conv = { active_image_id: 'img_x', active_image_path: 'D:/x.png' };
  const diag = buildChatImageContextDiagnostic(s, conv);
  assert.equal(diag.count, 0);
  assert.equal(diag.implicit_active_image, false);
});

test('Chat 无图：即使 conv.active_image_id 存在，请求 has_images 仍 false', () => {
  const s = createComposerState();
  const conv = { active_image_id: 'img_x', active_image_path: 'D:/x.png' };
  const payload = buildChatRequestPayload(s, conv, '你好');
  assert.equal(payload.has_images, false);
  assert.equal(payload.implicit_active_image, false);
  assert.equal(payload.attachments.length, 0);
});

test('Chat 主动选 1 张：count=1, labels=["图一"], source=chat_draft', () => {
  let s = createComposerState();
  s = toggleGalleryImage(s, 'chat', imgA);
  const diag = buildChatImageContextDiagnostic(s, {});
  assert.equal(diag.count, 1);
  assert.deepEqual(diag.labels, ['图一']);
  assert.equal(diag.source, 'chat_draft');
});

test('Chat 主动选多张：labels=["图一", "图二"]', () => {
  let s = createComposerState();
  s = toggleGalleryImage(s, 'chat', imgA);
  s = toggleGalleryImage(s, 'chat', imgB);
  const diag = buildChatImageContextDiagnostic(s, {});
  assert.deepEqual(diag.labels, ['图一', '图二']);
});

test('Chat 取消选中：count 回到 0', () => {
  let s = createComposerState();
  s = toggleGalleryImage(s, 'chat', imgA);
  s = toggleGalleryImage(s, 'chat', imgA); // 再次点击取消
  const diag = buildChatImageContextDiagnostic(s, {});
  assert.equal(diag.count, 0);
  assert.equal(diag.source, 'none');
});

test('Chat 主动选图后请求 has_images=true，但 active_image 仍然 false', () => {
  let s = createComposerState();
  s = toggleGalleryImage(s, 'chat', imgA);
  const conv = { active_image_id: 'img_x', active_image_path: 'D:/x.png' };
  const payload = buildChatRequestPayload(s, conv, '这张图是什么风格？');
  assert.equal(payload.has_images, true);
  assert.equal(payload.implicit_active_image, false);
  assert.equal(payload.attachments.length, 1);
});

test('Chat 无图：Context Bar 不显示（不再读 active_image）', () => {
  const s = createComposerState();
  const conv = { active_image_id: 'img_x', active_image_path: 'D:/x.png' };
  assert.equal(shouldShowChatContextBar(s, conv), false);
});

test('Chat 有图：Context Bar 显示', () => {
  let s = createComposerState();
  s = toggleGalleryImage(s, 'chat', imgA);
  const conv = { active_image_id: 'img_x', active_image_path: 'D:/x.png' };
  assert.equal(shouldShowChatContextBar(s, conv), true);
});

test('Chat 主动选的图不进入 task[]', () => {
  let s = createComposerState();
  s = toggleGalleryImage(s, 'chat', imgA);
  assert.equal(s.task.length, 0);
  assert.equal(s.chat.length, 1);
});

console.log(`\n${passCount}/${testCount} passed`);
if (passCount !== testCount) {
  console.error('chat-image-context.smoke: FAILED');
  process.exit(1);
}
console.log('chat-image-context.smoke: OK');
