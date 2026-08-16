// 静态 smoke 测试 —— node scripts/gallery-identity.smoke.mjs
//
// 验证图库唯一身份与去重（本轮核心交付物）：
//   1. normalizeGalleryPath：Windows 分隔符 / 大小写 / `.` / `..` 归一
//   2. dedupeGalleryItems：同 normalized path 合并为一条 display item
//   3. selected 身份：同 path 两条记录只产出 1 个可见卡片（选中态基础）
//
// 通过 esbuild 直接加载真实 TS 实现（scripts/_ts_loader.mjs）。

import assert from 'node:assert/strict';
import { loadTs } from './_ts_loader.mjs';

const gi = await loadTs('../src/utils/galleryIdentity.ts');
const { normalizeGalleryPath, dedupeGalleryItems } = gi;

// ============ 一、normalizeGalleryPath ============

// Case 2：Windows 大小写
assert.equal(
  normalizeGalleryPath('D:\\Images\\A.PNG'),
  normalizeGalleryPath('d:\\images\\a.png'),
  'Windows 大小写归一',
);

// Case 3：slash 差异
assert.equal(
  normalizeGalleryPath('D:\\Images\\a.png'),
  normalizeGalleryPath('D:/Images/a.png'),
  '反斜杠 / 正斜杠归一',
);

// 尾斜杠
assert.equal(
  normalizeGalleryPath('D:/Images/'),
  normalizeGalleryPath('D:\\Images'),
  '尾斜杠归一',
);

// `.` 与 `..` 解析
assert.equal(
  normalizeGalleryPath('D:/Images/./sub/../a.png'),
  normalizeGalleryPath('D:\\Images\\a.png'),
  '. / .. 段解析',
);

console.log('✓ normalizeGalleryPath：大小写 / 分隔符 / 尾斜杠 / 相对段全部归一');

// ============ 二、dedupeGalleryItems ============

// Case 1：同一路径不同 source（全部视图聚合）
{
  const items = [
    { id: 'a1', local_path: 'D:\\Images\\a.png', source_kind: 'library_input' },
    { id: 'a2', local_path: 'D:/Images/a.png', source_kind: 'output' },
  ];
  const deduped = dedupeGalleryItems(items);
  assert.equal(deduped.length, 1, `同 path 不同 source → 1 item (got ${deduped.length})`);
  assert.equal(deduped[0].id, 'a1', '保留顺序中的第一条');
  console.log('✓ Case 1：同一路径不同 source → 全部视图只显示 1 条');
}

// Case 2：Windows 大小写重复
{
  const items = [
    { id: 'b1', local_path: 'D:\\Images\\A.PNG', source_kind: 'library_input' },
    { id: 'b2', local_path: 'd:\\images\\a.png', source_kind: 'library_input' },
  ];
  assert.equal(dedupeGalleryItems(items).length, 1, '大小写重复 → 1 item');
  console.log('✓ Case 2：Windows 大小写差异 → 1 item');
}

// Case 3：slash 差异重复
{
  const items = [
    { id: 'c1', local_path: 'D:\\Images\\a.png' },
    { id: 'c2', local_path: 'D:/Images/a.png' },
  ];
  assert.equal(dedupeGalleryItems(items).length, 1, 'slash 差异 → 1 item');
  console.log('✓ Case 3：slash 差异 → 1 item');
}

// Case 4：不同路径同文件名 → 独立文件，保留 2 条
{
  const items = [
    { id: 'd1', local_path: 'D:\\Images\\a.png' },
    { id: 'd2', local_path: 'D:\\Other\\a.png' },
  ];
  assert.equal(dedupeGalleryItems(items).length, 2, '不同路径 → 2 items');
  console.log('✓ Case 4：不同路径（即使同名）→ 不错误合并');
}

// Case 5：重复扫描（同 path 两条 index row）→ selector 返回 1 个 display item
{
  const items = [
    { id: 'e1', local_path: 'D:\\Poke\\charmander.png', source_kind: 'library_input' },
    { id: 'e2', local_path: 'D:\\Poke\\charmander.png', source_kind: 'library_input' },
  ];
  const deduped = dedupeGalleryItems(items);
  assert.equal(deduped.length, 1, '重复 index row → 1 display item');
  console.log('✓ Case 5：同 path 两条索引记录 → 1 个 display item');
}

// Case 6：selected 一致性 —— 两条重复记录时，normalized 身份下只允许 1 个可见选中卡片
{
  const attachments = [{ id: 'att1', filePath: 'D:/Poke/charmander.png' }];
  const visible = dedupeGalleryItems([
    { id: 'f1', local_path: 'D:\\Poke\\charmander.png' },
    { id: 'f2', local_path: 'D:\\Poke\\charmander.png' },
  ]);
  const selectedVisible = visible.filter(img =>
    attachments.some(att => normalizeGalleryPath(att.filePath) === normalizeGalleryPath(img.local_path)),
  );
  assert.equal(attachments.length, 1, 'selected count = 1');
  assert.equal(selectedVisible.length, 1, `可见 selected 卡片数 = 1 (got ${selectedVisible.length})`);
  console.log('✓ Case 6：已选 1 张 → 可见绿框卡片恰好 1 个（不再双卡同时高亮）');
}

// 空路径守卫
assert.equal(dedupeGalleryItems([{ id: 'g1', local_path: '' }]).length, 0, '空 path 丢弃');
console.log('✓ 空 path 条目被丢弃');

console.log('\ngallery-identity smoke 全部通过');
