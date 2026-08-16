// 简易手跑 smoke 测试：node scripts/planner-parser.smoke.mjs
//
// 这里不复用 Rust 实现，而是用一份与 Rust `extract_json_object_text` 等价的 JS 实现来跑
// spec 第五十一节列出的 6 个 Planner 输入样本。它的目的是让人能快速判定：
//   - 纯 JSON → 成功
//   - ```json fence → 成功
//   - ``` fence → 成功
//   - JSON 前后带说明文字 → 成功
//   - 真正非法 JSON → 返回 null（对应 PLANNING_FAILED）
// Rust 侧的等价测试在 src-tauri/src/commands.rs 的 #[cfg(test)] mod tests 里。

function stripLeadingCodeFence(content) {
  const trimmed = content.trim();
  if (!trimmed.startsWith('```')) return content;
  const lines = trimmed.split('\n');
  if (lines.length < 2) return content;
  const hasClosing = (lines[lines.length - 1] || '').trim().startsWith('```');
  const innerStart = 1;
  const innerEnd = hasClosing ? lines.length - 1 : lines.length;
  return lines.slice(innerStart, innerEnd).join('\n');
}

function findFirstBalancedObject(content) {
  const bytes = Buffer.from(content, 'utf-8');
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (inString) {
      if (escape) escape = false;
      else if (byte === 0x5c) escape = true; // backslash
      else if (byte === 0x22) inString = false; // double quote
      continue;
    }
    if (byte === 0x22) { inString = true; escape = false; continue; }
    if (byte === 0x7b) { // {
      if (depth === 0) start = i;
      depth += 1;
    } else if (byte === 0x7d) { // }
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          // slice by character offsets (Buffer slice works since braces/quotes are single-byte in UTF-8)
          const text = bytes.slice(start, i + 1).toString('utf-8');
          return text;
        }
      }
    }
  }
  return null;
}

function extractJsonObjectText(content) {
  const trimmed = (content || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const v = JSON.parse(trimmed);
      if (v && typeof v === 'object' && !Array.isArray(v)) return trimmed;
    } catch {}
  }
  try {
    const v = JSON.parse(trimmed);
    if (v && typeof v === 'object' && !Array.isArray(v)) return trimmed;
  } catch {}
  const fenceStripped = stripLeadingCodeFence(trimmed).trim();
  if (fenceStripped && fenceStripped !== trimmed) {
    if (fenceStripped.startsWith('{') && fenceStripped.endsWith('}')) {
      try {
        const v = JSON.parse(fenceStripped);
        if (v && typeof v === 'object' && !Array.isArray(v)) return fenceStripped;
      } catch {}
    }
    try {
      const v = JSON.parse(fenceStripped);
      if (v && typeof v === 'object' && !Array.isArray(v)) return fenceStripped;
    } catch {}
  }
  const scanSource = fenceStripped || trimmed;
  const balanced = findFirstBalancedObject(scanSource);
  if (balanced) return balanced;
  return findFirstBalancedObject(trimmed);
}

const cases = [
  {
    name: 'A: pure JSON',
    input: '{"intent":"CREATE_IMAGE","task_type":"generate","final_prompt":"LOL 对战场景","execution_model":"gpt-image-2","source_image_id":null}',
    expectIntent: 'CREATE_IMAGE',
  },
  {
    name: 'B: ```json fence',
    input: '```json\n{"intent":"CREATE_IMAGE","task_type":"generate","final_prompt":"LOL 对战场景","execution_model":"gpt-image-2","source_image_id":null}\n```',
    expectIntent: 'CREATE_IMAGE',
  },
  {
    name: 'C: plain ``` fence',
    input: '```\n{"intent":"CREATE_IMAGE","task_type":"generate","final_prompt":"LOL 对战场景","execution_model":"gpt-image-2","source_image_id":null}\n```',
    expectIntent: 'CREATE_IMAGE',
  },
  {
    name: 'D: leading prose',
    input: '规划结果如下：\n{"intent":"CREATE_IMAGE","task_type":"generate","final_prompt":"LOL 对战场景","execution_model":"gpt-image-2","source_image_id":null}',
    expectIntent: 'CREATE_IMAGE',
  },
  {
    name: 'E: trailing prose',
    input: '{"intent":"CREATE_IMAGE","task_type":"generate","final_prompt":"LOL 对战场景","execution_model":"gpt-image-2","source_image_id":null}\n\n以上为任务规划结果。',
    expectIntent: 'CREATE_IMAGE',
  },
  {
    name: 'F: truly illegal text',
    input: '我认为应该生成一张LOL对战图，但没给 JSON。',
    expectIntent: null,
  },
  {
    name: 'G (extra): braces inside string',
    input: '{"intent":"CREATE_IMAGE","final_prompt":"场景：{城市}，人物"}',
    expectIntent: 'CREATE_IMAGE',
  },
];

let failed = 0;
for (const c of cases) {
  const extracted = extractJsonObjectText(c.input);
  let intent = null;
  if (extracted) {
    try {
      const v = JSON.parse(extracted);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        intent = v.intent || null;
      }
    } catch {
      intent = '__PARSE_ERROR__';
    }
  }
  const ok = intent === c.expectIntent;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  → intent=${intent} (expected ${c.expectIntent})`);
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
} else {
  console.log('\nAll planner parser cases passed.');
}
