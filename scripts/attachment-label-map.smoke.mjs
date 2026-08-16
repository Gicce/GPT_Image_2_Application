// 静态 smoke 测试 —— node scripts/attachment-label-map.smoke.mjs
//
// 验证 "图一 / 图二 / 图三" 语义编号的核心行为：
//   1. 标签按数组下标生成（图一 / 图二 / 图三 ...），超过 10 用阿拉伯数字。
//   2. 删除中间项后剩余自动重编号（不是把图三留在末尾）。
//   3. 重新选中再加入末尾。
//   4. PlannerAttachmentDescriptor 顺序与输入顺序一致（不允许错位）。
//   5. resolveImageReferences 能把 "图二" / "第二张图" / "第2张" 正确映射到对应附件。
//   6. renderAttachmentMappingForPlanner 不暴露 localPath / 真实路径。
//
// 本文件不依赖 vitest / jest，只用 node 内置 assert。
// 它把 src/utils/agent/attachmentLabels.ts 的实现镜像成等价 JS。

import assert from 'node:assert';

// ---------------------- 规则定义（必须与 .ts 源同步）----------------------

const CHINESE_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function getAttachmentDisplayLabel(index) {
  if (!Number.isFinite(index) || index < 0) return '图?';
  if (index < CHINESE_NUMERALS.length) return `图${CHINESE_NUMERALS[index]}`;
  return `图${index + 1}`;
}

function buildAttachmentDescriptors(attachments) {
  return attachments.map((att, index) => ({
    id: att.id,
    label: getAttachmentDisplayLabel(index),
    originalName: att.filePath ? att.filePath.split(/[\\/]/).pop() || att.name : att.name,
    source: att.source || 'unknown',
  }));
}

function renderAttachmentMappingForPlanner(descriptors) {
  if (descriptors.length === 0) return '';
  const lines = descriptors.map(d => `- ${d.label}：来源=${d.source}，附件标识=${d.id}`);
  return `[图片附件语义映射]\n${lines.join('\n')}\n规则：用户输入中出现 "图一 / 图二 / 图三 / 第一张图 / 第二张图 / 第一张 / 第二张" 等引用时，必须严格对应上面列表中的编号，不要根据文件名自行猜测。\n`;
}

function resolveImageReferences(text, descriptors) {
  if (!text || descriptors.length === 0) return [];
  const results = [];
  const seen = new Set();

  const chineseToIndex = {};
  CHINESE_NUMERALS.forEach((ch, idx) => {
    if (idx < descriptors.length) chineseToIndex[ch] = idx;
  });

  const labelRegex = /图([一二三四五六七八九十]|\d{1,2})/g;
  let m;
  while ((m = labelRegex.exec(text)) !== null) {
    const token = m[1];
    let idx = -1;
    if (/^\d+$/.test(token)) {
      idx = parseInt(token, 10) - 1;
    } else if (token in chineseToIndex) {
      idx = chineseToIndex[token];
    }
    if (idx >= 0 && idx < descriptors.length) {
      const d = descriptors[idx];
      const key = `${d.id}@${m[0]}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ label: d.label, attachmentId: d.id, index: idx, rawMatch: m[0] });
      }
    }
  }

  const ordinalRegex = /第([一二三四五六七八九十]|\d{1,2})张(?:图|图片|照片)?/g;
  while ((m = ordinalRegex.exec(text)) !== null) {
    const token = m[1];
    let idx = -1;
    if (/^\d+$/.test(token)) {
      idx = parseInt(token, 10) - 1;
    } else if (token in chineseToIndex) {
      idx = chineseToIndex[token];
    }
    if (idx >= 0 && idx < descriptors.length) {
      const d = descriptors[idx];
      const key = `${d.id}@${m[0]}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ label: d.label, attachmentId: d.id, index: idx, rawMatch: m[0] });
      }
    }
  }

  return results;
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

console.log('attachment-label-map.smoke: 图一/图二/图三 语义编号');

test('下标 0..2 → 图一/图二/图三', () => {
  assert.equal(getAttachmentDisplayLabel(0), '图一');
  assert.equal(getAttachmentDisplayLabel(1), '图二');
  assert.equal(getAttachmentDisplayLabel(2), '图三');
});

test('下标 9 → 图十；下标 10+ → 阿拉伯数字', () => {
  assert.equal(getAttachmentDisplayLabel(9), '图十');
  assert.equal(getAttachmentDisplayLabel(10), '图11');
  assert.equal(getAttachmentDisplayLabel(11), '图12');
  assert.equal(getAttachmentDisplayLabel(23), '图24');
});

test('非法下标 → 图?', () => {
  assert.equal(getAttachmentDisplayLabel(-1), '图?');
  assert.equal(getAttachmentDisplayLabel(NaN), '图?');
});

test('descriptors 顺序与输入一致 —— 不允许错位', () => {
  const out = buildAttachmentDescriptors([
    { id: 'att_c', source: 'gallery', name: 'c.png' },
    { id: 'att_a', source: 'gallery', name: 'a.png' },
    { id: 'att_b', source: 'upload', name: 'b.png' },
  ]);
  assert.deepEqual(
    out.map(d => d.label),
    ['图一', '图二', '图三'],
  );
  assert.deepEqual(
    out.map(d => d.id),
    ['att_c', 'att_a', 'att_b'],
  );
});

test('删除中间项后剩余自动重编号（图一图二图三 → 删图二 → 图一图二）', () => {
  // 假设用户原来选了 [C, A, B]，对应 图一/图二/图三
  // 现在删掉 A（在数组里下标=1）
  const remaining = [
    { id: 'att_c', source: 'gallery', name: 'c.png' },
    { id: 'att_b', source: 'gallery', name: 'b.png' },
  ];
  const out = buildAttachmentDescriptors(remaining);
  assert.deepEqual(out.map(d => d.label), ['图一', '图二']);
  assert.deepEqual(out.map(d => d.id), ['att_c', 'att_b']);
});

test('重新选中再加入末尾', () => {
  // remaining = [C, B] (图一/图二)，再选 A → [C, B, A] (图一/图二/图三)
  const after = [
    { id: 'att_c', source: 'gallery', name: 'c.png' },
    { id: 'att_b', source: 'gallery', name: 'b.png' },
    { id: 'att_a', source: 'gallery', name: 'a.png' },
  ];
  const out = buildAttachmentDescriptors(after);
  assert.deepEqual(out.map(d => d.label), ['图一', '图二', '图三']);
  assert.deepEqual(out.map(d => d.id), ['att_c', 'att_b', 'att_a']);
});

test('renderAttachmentMappingForPlanner 包含 label + id + 来源', () => {
  const desc = [
    { id: 'att_a', label: '图一', originalName: 'a.png', source: 'gallery' },
    { id: 'att_b', label: '图二', originalName: 'b.png', source: 'gallery' },
  ];
  const out = renderAttachmentMappingForPlanner(desc);
  assert.ok(out.includes('图一'));
  assert.ok(out.includes('图二'));
  assert.ok(out.includes('att_a'));
  assert.ok(out.includes('att_b'));
  assert.ok(out.includes('来源=gallery'));
});

test('renderAttachmentMappingForPlanner 不暴露 localPath / 真实路径', () => {
  const desc = [
    { id: 'att_a', label: '图一', originalName: 'a.png', source: 'gallery' },
  ];
  const out = renderAttachmentMappingForPlanner(desc);
  // 不应包含 Windows / Unix 路径片段
  assert.ok(!out.includes('D:\\'));
  assert.ok(!out.includes('/Users/'));
  assert.ok(!out.includes('/home/'));
  assert.ok(!out.includes('.png')); // 文件名后缀也不直接送 LLM
});

test('resolveImageReferences：把 "图二" 映射到对应附件', () => {
  const desc = [
    { id: 'att_a', label: '图一', source: 'gallery' },
    { id: 'att_b', label: '图二', source: 'gallery' },
    { id: 'att_c', label: '图三', source: 'gallery' },
  ];
  const refs = resolveImageReferences('用图一的人物，参考图二的构图，图三只参考服装', desc);
  assert.equal(refs.length, 3);
  assert.deepEqual(
    refs.map(r => r.label),
    ['图一', '图二', '图三'],
  );
  assert.deepEqual(
    refs.map(r => r.attachmentId),
    ['att_a', 'att_b', 'att_c'],
  );
});

test('resolveImageReferences：第一张图 / 第二张 / 第2张 也能解析', () => {
  const desc = [
    { id: 'att_a', label: '图一', source: 'gallery' },
    { id: 'att_b', label: '图二', source: 'gallery' },
    { id: 'att_c', label: '图三', source: 'gallery' },
  ];
  const refs = resolveImageReferences('把第一张图的左下角 ID 去掉，再把第2张作为参考', desc);
  // 第一张图 → 图一 (att_a)
  assert.ok(refs.some(r => r.attachmentId === 'att_a' && r.rawMatch === '第一张图'));
  // 第2张 → 图二 (att_b)
  assert.ok(refs.some(r => r.attachmentId === 'att_b' && r.rawMatch === '第2张'));
});

test('resolveImageReferences：空 descriptors 返回空数组', () => {
  assert.deepEqual(resolveImageReferences('图一', []), []);
  assert.deepEqual(resolveImageReferences('', [{ id: 'x', label: '图一', source: 'g' }]), []);
});

test('resolveImageReferences：越界引用（图五但只有 3 张）被跳过', () => {
  const desc = [
    { id: 'att_a', label: '图一', source: 'gallery' },
    { id: 'att_b', label: '图二', source: 'gallery' },
    { id: 'att_c', label: '图三', source: 'gallery' },
  ];
  const refs = resolveImageReferences('把图五去掉，图一保留', desc);
  // 图五被跳过，只解析图一
  assert.equal(refs.length, 1);
  assert.equal(refs[0].attachmentId, 'att_a');
});

// ---------------------- 总结 ----------------------

console.log(`\n${passCount}/${testCount} passed`);
if (passCount !== testCount) {
  console.error('attachment-label-map.smoke: FAILED');
  process.exit(1);
}
console.log('attachment-label-map.smoke: OK');
