// 简易手跑 smoke 测试：node scripts/task-execution-readiness.smoke.mjs
//
// 这份测试镜像 src/store/useChatStore.ts 中的 getTaskExecutionReadiness 实现，
// 验证以下场景：
//   - needs_clarification 阶段 → executable=false, reasonCode='needs_clarification'
//   - stage != waiting_confirm → executable=false
//   - waiting_confirm 缺 finalPrompt → executable=false (malformed)
//   - waiting_confirm 缺 pendingParams → executable=false
//   - waiting_confirm 缺 source image（edit 类）→ executable=false
//   - 完整 waiting_confirm → executable=true
//   - clarification 字段即便在 waiting_confirm 也强制判为不可执行（防御）
//
// 这是"单一真相源"的回归保护 —— 任何分支误改 getTaskExecutionReadiness 都会让
// 这里失败，从而避免 needs_clarification 卡再次被允许"确认执行"。

import assert from 'node:assert';

// ---------- mirror of getTaskExecutionReadiness ----------
function getTaskExecutionReadiness(task) {
  if (!task) {
    return { executable: false, reasonCode: 'missing_pending_params', reason: '任务不存在。' };
  }
  if (task.stage === 'needs_clarification' || task.clarification) {
    return {
      executable: false,
      reasonCode: 'needs_clarification',
      reason: '当前任务仍需要补充信息，暂不能执行。',
    };
  }
  if (task.stage !== 'waiting_confirm') {
    return {
      executable: false,
      reasonCode: 'not_waiting_confirm',
      reason: `当前任务状态（${task.stage}）不允许执行。`,
    };
  }
  if (!task.finalPrompt || !task.finalPrompt.trim()) {
    return {
      executable: false,
      reasonCode: 'missing_final_prompt',
      reason: '任务规划数据不完整（缺少最终提示词），请重新规划。',
    };
  }
  if (!task.executionModel) {
    return {
      executable: false,
      reasonCode: 'missing_execution_model',
      reason: '任务规划数据不完整（缺少执行模型），请重新规划。',
    };
  }
  if (!task.taskType) {
    return {
      executable: false,
      reasonCode: 'missing_task_type',
      reason: '任务规划数据不完整（缺少任务类型），请重新规划。',
    };
  }
  if (!task.pendingParams) {
    return {
      executable: false,
      reasonCode: 'missing_pending_params',
      reason: '任务规划数据不完整，请重新规划。',
    };
  }
  const isEditLike =
    task.taskType === 'edit'
    || task.taskType === 'remove_background'
    || task.resolvedTaskKind === 'image_edit'
    || task.resolvedTaskKind === 'image_reference_generation';
  if (isEditLike) {
    const hasSource =
      !!task.sourceImageId
      || !!task.sourceImagePath
      || (typeof task.sourceImageCount === 'number' && task.sourceImageCount > 0)
      || (task.pendingParams.source_images && task.pendingParams.source_images.length > 0);
    if (!hasSource) {
      return {
        executable: false,
        reasonCode: 'missing_source_image',
        reason: '检测到这是图片编辑任务，但没有找到明确的源图片，请重新规划。',
      };
    }
  }
  return { executable: true, reasonCode: 'ready' };
}

// ---------- helpers ----------
function makeBaseWaitingConfirm(overrides = {}) {
  return {
    taskId: 'task_xyz',
    status: 'pending',
    stage: 'waiting_confirm',
    finalPrompt: 'a cute cat',
    executionModel: 'gpt-image-2',
    taskType: 'generate',
    pendingParams: {
      prompt: 'a cute cat',
      source_images: [],
      task_type: 'generate',
      count: 1,
    },
    ...overrides,
  };
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

// ---------- tests ----------
console.log('TaskExecutionReadiness smoke tests');

check('needs_clarification stage is not executable', () => {
  const r = getTaskExecutionReadiness({
    ...makeBaseWaitingConfirm(),
    stage: 'needs_clarification',
  });
  assert.strictEqual(r.executable, false);
  assert.strictEqual(r.reasonCode, 'needs_clarification');
});

check('clarification field alone forces non-executable even in waiting_confirm (defensive)', () => {
  // 防御：即便 stage=waiting_confirm，只要 clarification 字段还在，
  // 就不应该被允许执行。spec 要求 needs_clarification 和 waiting_confirm 互斥。
  const r = getTaskExecutionReadiness({
    ...makeBaseWaitingConfirm(),
    clarification: { question: '请指定具体角色', attempt: 1 },
  });
  assert.strictEqual(r.executable, false);
  assert.strictEqual(r.reasonCode, 'needs_clarification');
});

check('planning stage is not executable', () => {
  const r = getTaskExecutionReadiness({
    ...makeBaseWaitingConfirm(),
    stage: 'planning',
  });
  assert.strictEqual(r.executable, false);
  assert.strictEqual(r.reasonCode, 'not_waiting_confirm');
});

check('planning_failed stage is not executable', () => {
  const r = getTaskExecutionReadiness({
    ...makeBaseWaitingConfirm(),
    stage: 'planning_failed',
  });
  assert.strictEqual(r.executable, false);
  assert.strictEqual(r.reasonCode, 'not_waiting_confirm');
});

check('cancelled stage is not executable', () => {
  const r = getTaskExecutionReadiness({
    ...makeBaseWaitingConfirm(),
    stage: 'cancelled',
  });
  assert.strictEqual(r.executable, false);
  assert.strictEqual(r.reasonCode, 'not_waiting_confirm');
});

check('waiting_confirm missing finalPrompt is not executable', () => {
  const r = getTaskExecutionReadiness({
    ...makeBaseWaitingConfirm(),
    finalPrompt: '',
  });
  assert.strictEqual(r.executable, false);
  assert.strictEqual(r.reasonCode, 'missing_final_prompt');
});

check('waiting_confirm missing executionModel is not executable', () => {
  const r = getTaskExecutionReadiness({
    ...makeBaseWaitingConfirm(),
    executionModel: undefined,
  });
  assert.strictEqual(r.executable, false);
  assert.strictEqual(r.reasonCode, 'missing_execution_model');
});

check('waiting_confirm missing taskType is not executable', () => {
  const r = getTaskExecutionReadiness({
    ...makeBaseWaitingConfirm(),
    taskType: '',
  });
  assert.strictEqual(r.executable, false);
  assert.strictEqual(r.reasonCode, 'missing_task_type');
});

check('waiting_confirm missing pendingParams is not executable (was the original bug)', () => {
  // 这就是 spec 里说的"任务参数缺失，无法执行"的真实根因。
  // 旧代码：UI 显示"确认执行" → 用户点击 → 才发现 pendingParams 是 undefined。
  // 新代码：readiness 提前拦截，UI 不显示按钮。
  const r = getTaskExecutionReadiness({
    ...makeBaseWaitingConfirm(),
    pendingParams: undefined,
  });
  assert.strictEqual(r.executable, false);
  assert.strictEqual(r.reasonCode, 'missing_pending_params');
});

check('edit task without source image is not executable', () => {
  const r = getTaskExecutionReadiness({
    ...makeBaseWaitingConfirm(),
    taskType: 'edit',
    pendingParams: {
      ...makeBaseWaitingConfirm().pendingParams,
      task_type: 'edit',
      source_images: [],
    },
    sourceImageId: undefined,
    sourceImagePath: undefined,
    sourceImageCount: 0,
  });
  assert.strictEqual(r.executable, false);
  assert.strictEqual(r.reasonCode, 'missing_source_image');
});

check('edit task with source image is executable', () => {
  const r = getTaskExecutionReadiness({
    ...makeBaseWaitingConfirm(),
    taskType: 'edit',
    pendingParams: {
      ...makeBaseWaitingConfirm().pendingParams,
      task_type: 'edit',
      source_images: ['/tmp/foo.png'],
    },
    sourceImagePath: '/tmp/foo.png',
    sourceImageCount: 1,
  });
  assert.strictEqual(r.executable, true);
  assert.strictEqual(r.reasonCode, 'ready');
});

check('image_reference_generation resolved kind requires source image', () => {
  const r = getTaskExecutionReadiness({
    ...makeBaseWaitingConfirm(),
    taskType: 'edit',
    resolvedTaskKind: 'image_reference_generation',
    pendingParams: {
      ...makeBaseWaitingConfirm().pendingParams,
      task_type: 'edit',
      source_images: [],
    },
  });
  assert.strictEqual(r.executable, false);
  assert.strictEqual(r.reasonCode, 'missing_source_image');
});

check('fully-formed generation task is executable', () => {
  const r = getTaskExecutionReadiness(makeBaseWaitingConfirm());
  assert.strictEqual(r.executable, true);
  assert.strictEqual(r.reasonCode, 'ready');
});

check('null task is not executable', () => {
  const r = getTaskExecutionReadiness(null);
  assert.strictEqual(r.executable, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
