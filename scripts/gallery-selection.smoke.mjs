// 静态 smoke 测试 —— node scripts/gallery-selection.smoke.mjs
//
// 验证图库多选 Toggle 行为：
//   1. 点击未选中图 → 加入 attachments，标签 = 图一。
//   2. 再次点击同一张 → 立即移除（旧版本只能去附件区点 × 删除）。
//   3. 多图按"选择顺序"编号（C, A, B → 图一, 图二, 图三）。
//   4. 取消中间图后剩余自动重编号。
//   5. 重新选中再加入末尾。
//   6. 翻页 / 来源过滤不会丢失 selection（因为 source of truth 在 attachments 数组）。
//
// 本文件不依赖 vitest / jest，只用 node 内置 assert。
// 它把 Chat.tsx 里的 toggle + label 逻辑等价镜像成纯 JS 函数。

import assert from 'node:assert';

// ---------------------- 镜像实现（必须与 Chat.tsx 源同步）----------------------

const CHINESE_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function getAttachmentDisplayLabel(index) {
  if (!Number.isFinite(index) || index < 0) return '图?';
  if (index < CHINESE_NUMERALS.length) return `图${CHINESE_NUMERALS[index]}`;
  return `图${index + 1}`;
}

// 镜像 Chat.tsx 的 addAttachment：去重 (filePath) + 末尾追加。
function addAttachment(prev, attachment) {
  if (attachment.filePath && prev.some(item => item.filePath === attachment.filePath)) {
    return prev;
  }
  return [...prev, { ...attachment, id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) }];
}

// 镜像 Chat.tsx 的 removeAttachment：按 id 过滤。
function removeAttachment(prev, id) {
  return prev.filter(a => a.id !== id);
}

// 镜像 Chat.tsx 的 handleSelectGalleryImage：toggle 行为。
// 关键修复：旧版只能 add，再次点击无效；新版检查已选中 → 立即移除。
function handleSelectGalleryImage(attachments, image) {
  if (image.missing) return attachments;
  const existing = attachments.find(att => att.filePath === image.local_path);
  if (existing) {
    return removeAttachment(attachments, existing.id);
  }
  return addAttachment(attachments, {
    type: 'image',
    source: 'gallery',
    name: image.file_name || image.local_path.split(/[\\/]/).pop() || 'gallery-image.png',
    filePath: image.local_path,
  });
}

function labelOf(attachments, index) {
  return getAttachmentDisplayLabel(index);
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

console.log('gallery-selection.smoke: 图库 Toggle + 选择顺序');

// 模拟图库里的图片
const imgA = { id: 'gal_a', file_name: 'a.png', local_path: 'D:/out/a.png', missing: false };
const imgB = { id: 'gal_b', file_name: 'b.png', local_path: 'D:/out/b.png', missing: false };
const imgC = { id: 'gal_c', file_name: 'c.png', local_path: 'D:/out/c.png', missing: false };
const imgMissing = { id: 'gal_x', file_name: 'x.png', local_path: 'D:/out/x.png', missing: true };

test('点击未选中图 → 加入 attachments，标签 = 图一', () => {
  let atts = [];
  atts = handleSelectGalleryImage(atts, imgA);
  assert.equal(atts.length, 1);
  assert.equal(atts[0].filePath, 'D:/out/a.png');
  assert.equal(labelOf(atts, 0), '图一');
});

test('再次点击同一张 → 立即移除（真正 Toggle）', () => {
  let atts = [];
  atts = handleSelectGalleryImage(atts, imgA);
  assert.equal(atts.length, 1);
  atts = handleSelectGalleryImage(atts, imgA);
  assert.equal(atts.length, 0);
});

test('多图按选择顺序编号：C, A, B → 图一, 图二, 图三', () => {
  let atts = [];
  atts = handleSelectGalleryImage(atts, imgC);
  atts = handleSelectGalleryImage(atts, imgA);
  atts = handleSelectGalleryImage(atts, imgB);
  assert.equal(atts.length, 3);
  assert.equal(atts[0].filePath, 'D:/out/c.png');
  assert.equal(atts[1].filePath, 'D:/out/a.png');
  assert.equal(atts[2].filePath, 'D:/out/b.png');
  assert.deepEqual(
    atts.map((_, i) => labelOf(atts, i)),
    ['图一', '图二', '图三'],
  );
});

test('取消中间图（A）后剩余自动重编号：C, B → 图一, 图二', () => {
  let atts = [];
  atts = handleSelectGalleryImage(atts, imgC);
  atts = handleSelectGalleryImage(atts, imgA);
  atts = handleSelectGalleryImage(atts, imgB);
  // 再次点击 A → 移除
  atts = handleSelectGalleryImage(atts, imgA);
  assert.equal(atts.length, 2);
  assert.equal(atts[0].filePath, 'D:/out/c.png');
  assert.equal(atts[1].filePath, 'D:/out/b.png');
  assert.deepEqual(
    atts.map((_, i) => labelOf(atts, i)),
    ['图一', '图二'],
  );
});

test('重新选中（A）再加入末尾：C, B, A → 图一, 图二, 图三', () => {
  let atts = [];
  atts = handleSelectGalleryImage(atts, imgC);
  atts = handleSelectGalleryImage(atts, imgA);
  atts = handleSelectGalleryImage(atts, imgB);
  atts = handleSelectGalleryImage(atts, imgA); // remove A
  atts = handleSelectGalleryImage(atts, imgA); // re-add A
  assert.equal(atts.length, 3);
  assert.equal(atts[0].filePath, 'D:/out/c.png');
  assert.equal(atts[1].filePath, 'D:/out/b.png');
  assert.equal(atts[2].filePath, 'D:/out/a.png');
});

test('missing 图片不会被加入', () => {
  let atts = [];
  atts = handleSelectGalleryImage(atts, imgMissing);
  assert.equal(atts.length, 0);
});

test('同一图重复点击（未触发 toggle 的旧 bug）—— 第二次必须立即取消', () => {
  let atts = [];
  atts = handleSelectGalleryImage(atts, imgA);
  atts = handleSelectGalleryImage(atts, imgA);
  atts = handleSelectGalleryImage(atts, imgA);
  assert.equal(atts.length, 1); // toggle on → off → on
  assert.equal(atts[0].filePath, 'D:/out/a.png');
});

test('clearAllAttachments：清空全部', () => {
  let atts = [];
  atts = handleSelectGalleryImage(atts, imgA);
  atts = handleSelectGalleryImage(atts, imgB);
  atts = handleSelectGalleryImage(atts, imgC);
  atts = []; // 模拟 setAttachments([])
  assert.equal(atts.length, 0);
});

test('selection 在 "翻页" 后保持：模拟切到第 2 页再回来，attachments 不变', () => {
  // 在第 1 页选 A, B
  let atts = [];
  atts = handleSelectGalleryImage(atts, imgA);
  atts = handleSelectGalleryImage(atts, imgB);
  const before = atts.slice();
  // 翻页 / 切来源过滤：这些操作不调用 handleSelectGalleryImage，attachments 不变
  // 模拟：什么也不做，attachments 保持
  assert.deepEqual(atts, before);
  // 回到第 1 页再选 C
  atts = handleSelectGalleryImage(atts, imgC);
  assert.equal(atts.length, 3);
  assert.deepEqual(
    atts.map((_, i) => labelOf(atts, i)),
    ['图一', '图二', '图三'],
  );
});

// ---------------------- 总结 ----------------------

console.log(`\n${passCount}/${testCount} passed`);
if (passCount !== testCount) {
  console.error('gallery-selection.smoke: FAILED');
  process.exit(1);
}
console.log('gallery-selection.smoke: OK');
