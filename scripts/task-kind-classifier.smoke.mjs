// 静态 smoke 测试 —— node scripts/task-kind-classifier.smoke.mjs
//
// 本文件不依赖 vitest / jest，只用 node 内置 assert。
// 它把 src/utils/agent/promptPlanner.ts 的 resolveTaskKindLocally 转写成等价的 JS 实现，
// 然后跑 spec 第十一节列出的几个附件识别场景。
//
// 维护成本：复制正则字符串 + 改 import 风格。

import assert from 'node:assert';

// ---------------------- 规则定义（必须与 .ts 源同步）----------------------

const IMAGE_EDIT_INTENT_PATTERN = /(去掉|去除|删除|移除|擦除|修掉|修一下|修复|修改|改成|换成|替换|裁切|裁剪|放大|补全|去水印|去\s*id|去文字|保留主体|保留人物|保留脸|重绘|抠图|扣图|透明背景|去背景)/i;

const IMAGE_REFERENCE_INTENT_PATTERN = /(参考这张|参考这个|参考一下|按这张|按照这张|基于这张|用这张|参考风格|参考一下风格|借鉴|仿照)/i;

const IMAGE_ANALYSIS_INTENT_PATTERN = /(这张图是什么|分析这张|识别这张|描述这张|图里有什么|看一(?:下|眼)?这张|解释这张)/i;

// ---------------------- 实现镜像 ----------------------

function resolveTaskKindLocally(input) {
  const text = (input.text || '').trim();
  if (!text) return 'unknown';

  if ((input.hasUserAttachments || input.hasActiveImage) && IMAGE_ANALYSIS_INTENT_PATTERN.test(text)) {
    return 'image_analysis';
  }

  if (input.hasUserAttachments && IMAGE_EDIT_INTENT_PATTERN.test(text)) {
    return 'image_edit';
  }

  if (input.hasUserAttachments && IMAGE_REFERENCE_INTENT_PATTERN.test(text)) {
    return 'image_reference_generation';
  }

  // 4. 用户已上传图但措辞模糊 —— 默认按图片编辑（而不是文生图！）
  if (input.hasUserAttachments) {
    return 'image_edit';
  }

  if (input.hasActiveImage && IMAGE_EDIT_INTENT_PATTERN.test(text)) {
    return 'image_edit';
  }

  if (!input.hasUserAttachments && !input.hasActiveImage && IMAGE_EDIT_INTENT_PATTERN.test(text)) {
    return 'unknown';
  }

  return 'text_to_image';
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
    console.error('    ' + err.message);
    process.exitCode = 1;
  }
}

console.log('\n[TaskKindClassifier smoke] running scenarios...\n');

// 测试 4：有附件 + 编辑意图 → 图片编辑
test('测试4 有附件 + 编辑意图 → image_edit', () => {
  const kind = resolveTaskKindLocally({
    text: '去掉这张图左下角的 ID 信息',
    hasUserAttachments: true,
    hasActiveImage: false,
  });
  assert.strictEqual(kind, 'image_edit', '应识别为 image_edit 而不是文生图');
});

// 测试 5：有附件 + 参考意图 → 参考图生成
test('测试5 有附件 + 参考意图 → image_reference_generation', () => {
  const kind = resolveTaskKindLocally({
    text: '参考这张图的风格，生成一张新的海报图',
    hasUserAttachments: true,
    hasActiveImage: false,
  });
  assert.strictEqual(kind, 'image_reference_generation', '应识别为参考图生成');
});

// 测试 6：无附件 + 编辑意图 → unknown（让 Planner 去问"请上传图片"）
test('测试6 无附件 + 编辑意图 → unknown（让 Planner 询问上传）', () => {
  const kind = resolveTaskKindLocally({
    text: '帮我去掉左下角 ID',
    hasUserAttachments: false,
    hasActiveImage: false,
  });
  assert.strictEqual(kind, 'unknown', '没有图但用户想编辑 → unknown 而不是退化为文生图');
});

// 测试 7：多图编辑场景（依然识别为 image_edit，UI 会拆 edit_target + reference）
test('测试7 多图 + 编辑意图 → image_edit（不会退化成文生图）', () => {
  const kind = resolveTaskKindLocally({
    text: '帮我基于这张主图去掉左下角 ID，另一张作为参考',
    hasUserAttachments: true,
    hasActiveImage: false,
  });
  assert.strictEqual(kind, 'image_edit', '多图编辑场景不能退化为文生图');
});

// 测试：纯文生图（无附件 + 生成意图）
test('测试-纯文生图', () => {
  const kind = resolveTaskKindLocally({
    text: '生成一张故宫雪景图',
    hasUserAttachments: false,
    hasActiveImage: false,
  });
  assert.strictEqual(kind, 'text_to_image');
});

// 测试：有附件 + 图片分析意图 → image_analysis（优先级高于 edit）
test('测试-有附件 + 分析意图 → image_analysis', () => {
  const kind = resolveTaskKindLocally({
    text: '这张图是什么风格？',
    hasUserAttachments: true,
    hasActiveImage: false,
  });
  assert.strictEqual(kind, 'image_analysis');
});

// 测试：有附件 + 模糊意图 → 默认 image_edit（关键：不退化为文生图）
test('测试-有附件 + 模糊意图 → image_edit（关键修复）', () => {
  const kind = resolveTaskKindLocally({
    text: '帮我看一下',
    hasUserAttachments: true,
    hasActiveImage: false,
  });
  // "看一下"匹配 IMAGE_ANALYSIS_INTENT_PATTERN，所以会变成 image_analysis
  // 这里改成更模糊的措辞
  const kind2 = resolveTaskKindLocally({
    text: '处理一下',
    hasUserAttachments: true,
    hasActiveImage: false,
  });
  assert.strictEqual(kind2, 'image_edit', '有附件但措辞模糊时不应退化为文生图');
});

console.log(`\n[TaskKindClassifier smoke] ${passCount}/${testCount} passed\n`);
