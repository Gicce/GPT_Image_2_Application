import { describe, it, expect } from 'vitest';
import type { VisionAnalysis } from '../../../types';
import {
  applyAdjustmentInput,
  applyOptimizationResult,
  buildGenerationCarry,
  buildRecreationPlan,
  canGenerateFromRecreation,
  describeRecreationStatus,
  initialRecreationState,
  markOptimizationFailed,
  markOptimizing,
  markRecreationDirty,
  needsOptimization,
  needsReoptimization,
  normalizeRecreationState,
  revertToLastSuccessfulPrompt,
  togglePlanFieldLock,
  PLAN_FIELD_LABELS,
  type RecreationState,
} from '../recreationPlan';

function fixtureAnalysis(): VisionAnalysis {
  return {
    summary: '一名男性篮球运动员在室内球馆上篮',
    subjects: [
      {
        label: '成年男性篮球运动员',
        appearance: ['短发', '红色球衣'],
        clothing: ['红色 23 号球衣'],
        pose: '腾空上篮',
        action: '单手扣篮',
        position: { x: 0.3, y: 0.2, width: 0.4, height: 0.7 },
        relations: [],
      },
    ],
    objects: [{ label: '篮球', attributes: ['橙色'] }],
    scene: {
      environment: '室内篮球馆',
      location: '比赛球场',
      time_of_day: '白天',
      weather: '',
      background: '观众席虚化',
      foreground: '',
    },
    composition: {
      subject_placement: '主体居中偏左',
      symmetry: '非对称',
      negative_space: '',
      crop: '全身',
      depth_layers: '',
    },
    camera: {
      shot_type: '中远景',
      perspective: '',
      angle: '低角度仰拍',
      depth_of_field: '浅景深',
      lens_characteristics: '',
    },
    lighting: {
      source: '顶部场馆灯',
      direction: '顶光',
      softness: '硬光',
      key_fill_rim: '',
      contrast: '高对比',
      time_of_day: '',
      exposure: '',
    },
    colors: { dominant_palette: ['红色', '橙色'], temperature: '暖色', saturation: '高', contrast: '' },
    style: { category: '运动摄影', medium: '照片', texture: '', rendering: '写实', photographic_characteristics: '' },
    text_elements: [],
    fine_details: [],
    generation_risks: [],
  } as unknown as VisionAnalysis;
}

describe('buildRecreationPlan（结构化复刻方案）', () => {
  it('从 VisionAnalysis 派生九类字段（含服装 / 造型独立维度）并默认锁定主体以外的维度', () => {
    const plan = buildRecreationPlan(fixtureAnalysis());
    const keys = plan.fields.map(f => f.key);
    expect(keys).toEqual(['subject', 'clothing', 'pose', 'composition', 'camera', 'scene', 'lighting', 'style', 'color']);

    const subject = plan.fields.find(f => f.key === 'subject')!;
    expect(subject.value).toContain('成年男性篮球运动员');
    expect(subject.locked).toBe(false);

    const clothing = plan.fields.find(f => f.key === 'clothing')!;
    expect(clothing.value).toBe('红色 23 号球衣');
    expect(clothing.label).toBe(PLAN_FIELD_LABELS.clothing);
    expect(clothing.locked).toBe(true);

    const pose = plan.fields.find(f => f.key === 'pose')!;
    expect(pose.value).toContain('腾空上篮');
    expect(pose.locked).toBe(true);

    const scene = plan.fields.find(f => f.key === 'scene')!;
    expect(scene.value).toContain('室内篮球馆');
    expect(scene.label).toBe(PLAN_FIELD_LABELS.scene);
  });
});

describe('语义修订模型（semanticRevision / optimizedRevision / needsOptimization）', () => {
  const base = () =>
    initialRecreationState(
      buildRecreationPlan(fixtureAnalysis()),
      '一名男性篮球运动员在室内球馆上篮，低角度仰拍……',
      '低画质，模糊',
    );

  it('分析完成即 ready：双修订归零，无需优化，允许直接生成', () => {
    const state = base();
    expect(state.editState).toBe('ready');
    expect(state.semanticRevision).toBe(0);
    expect(state.optimizedRevision).toBe(0);
    expect(needsOptimization(state)).toBe(false);
    expect(state.adjustInstruction).toBe('');
    expect(state.optimizedPrompt).toBe(state.originalPrompt);
    expect(canGenerateFromRecreation(state).allowed).toBe(true);
    expect(needsReoptimization(state)).toBe(false);
  });

  it('真实语义修改（调整要求）→ revision +1，needsOptimization，生成被拦截', () => {
    const next = applyAdjustmentInput(base(), '把主体换成一个年轻女性，保持背景和构图不变');
    expect(next.semanticRevision).toBe(1);
    expect(next.optimizedRevision).toBe(0);
    expect(needsOptimization(next)).toBe(true);
    expect(next.editState).toBe('dirty');
    expect(next.adjustInstruction).toBe('把主体换成一个年轻女性，保持背景和构图不变');
    expect(canGenerateFromRecreation(next).allowed).toBe(false);
    expect(needsReoptimization(next)).toBe(true);
  });

  it('优化成功 → optimizedRevision 对齐 semanticRevision（needsOptimization 归 false）', () => {
    const dirty = applyAdjustmentInput(base(), '更亮');
    const optimizing = markOptimizing(dirty);
    const optimized = applyOptimizationResult(optimizing, {
      optimizedPrompt: '最终 Prompt',
      optimizedNegativePrompt: '',
      summary: '已微调',
    });
    expect(optimized.semanticRevision).toBe(1);
    expect(optimized.optimizedRevision).toBe(1);
    expect(needsOptimization(optimized)).toBe(false);
    expect(canGenerateFromRecreation(optimized).allowed).toBe(true);
  });

  it('优化失败 → revision 不变（待消化修改仍在），needsOptimization 保持 true', () => {
    const dirty = applyAdjustmentInput(base(), '更亮');
    const failed = markOptimizationFailed(markOptimizing(dirty), '网络超时');
    expect(failed.semanticRevision).toBe(1);
    expect(failed.optimizedRevision).toBe(0);
    expect(needsOptimization(failed)).toBe(true);
    expect(failed.optimizeError).toBe('网络超时');
    expect(canGenerateFromRecreation(failed).allowed).toBe(false);
  });

  it('优化完成后清空修改要求 → 维持 optimized（空意图绝不卡死在 dirty）', () => {
    const optimized = applyOptimizationResult(applyAdjustmentInput(base(), '更亮'), {
      optimizedPrompt: '最终 Prompt',
      optimizedNegativePrompt: '',
      summary: '已微调',
    });
    const cleared = applyAdjustmentInput(optimized, '');
    expect(cleared.editState).toBe('optimized');
    expect(cleared.adjustInstruction).toBe('');
    expect(needsOptimization(cleared)).toBe(false);
    expect(canGenerateFromRecreation(cleared).allowed).toBe(true);
  });

  it('待优化状态下清空全部修改意图 → 对齐 revision（放弃未优化修改，保留当前 Prompt）', () => {
    const dirty = applyAdjustmentInput(base(), '更亮');
    const cleared = applyAdjustmentInput(dirty, '');
    expect(cleared.editState).toBe('ready');
    expect(cleared.semanticRevision).toBe(cleared.optimizedRevision);
    expect(needsOptimization(cleared)).toBe(false);
    expect(canGenerateFromRecreation(cleared).allowed).toBe(true);
  });

  it('markRecreationDirty / 锁定项修改同样增加 revision（真实语义修改统一入口）', () => {
    const state = base();
    expect(markRecreationDirty(state).semanticRevision).toBe(1);
    const toggled = togglePlanFieldLock(state, 'scene');
    expect(toggled.semanticRevision).toBe(1);
    expect(toggled.plan.fields.find(f => f.key === 'scene')!.locked).toBe(false);
    expect(needsOptimization(toggled)).toBe(true);
  });

  it('「使用上一次 Prompt」→ revision 对齐，回到 optimized / ready', () => {
    const optimized = applyOptimizationResult(applyAdjustmentInput(base(), '更亮'), {
      optimizedPrompt: '上一轮成功 Prompt',
      optimizedNegativePrompt: '',
      summary: '已微调',
    });
    const pending = applyAdjustmentInput(optimized, '再改一版');
    const reverted = revertToLastSuccessfulPrompt(pending);
    expect(reverted.semanticRevision).toBe(reverted.optimizedRevision);
    expect(needsOptimization(reverted)).toBe(false);
    expect(reverted.optimizedPrompt).toBe('上一轮成功 Prompt');
    expect(canGenerateFromRecreation(reverted).allowed).toBe(true);
  });

  it('旧持久化数据（modified 标记）迁移：modified=true → 修订领先 1，否则归零', () => {
    const legacyDirty = { ...base() } as Partial<RecreationState> & { modified?: boolean };
    delete legacyDirty.semanticRevision;
    delete legacyDirty.optimizedRevision;
    legacyDirty.modified = true;
    const migrated = normalizeRecreationState(legacyDirty as RecreationState);
    expect(migrated.semanticRevision).toBe(1);
    expect(migrated.optimizedRevision).toBe(0);
    expect(needsOptimization(migrated)).toBe(true);
    const legacyClean = { ...base() } as Partial<RecreationState> & { modified?: boolean };
    delete legacyClean.semanticRevision;
    delete legacyClean.optimizedRevision;
    legacyClean.modified = false;
    const migratedClean = normalizeRecreationState(legacyClean as RecreationState);
    expect(migratedClean.semanticRevision).toBe(0);
    expect(needsOptimization(migratedClean)).toBe(false);
  });
});

describe('复刻方案状态机（ready → dirty → optimizing → optimized，统一调整要求输入）', () => {
  const base = () =>
    initialRecreationState(
      buildRecreationPlan(fixtureAnalysis()),
      '一名男性篮球运动员在室内球馆上篮，低角度仰拍……',
      '低画质，模糊',
    );

  it('调整要求输入变化 → dirty（记录大白话指令，清空历史失败原因）', () => {
    const state = base();
    const next = applyAdjustmentInput(state, '把主体换成一个年轻女性，保持背景和构图不变');
    expect(next.editState).toBe('dirty');
    expect(next.adjustInstruction).toBe('把主体换成一个年轻女性，保持背景和构图不变');
    expect(canGenerateFromRecreation(next).allowed).toBe(false);
  });

  it('锁定项变化 → dirty 且锁定状态立即翻转', () => {
    const state = base();
    const next = togglePlanFieldLock(state, 'scene');
    expect(next.editState).toBe('dirty');
    expect(next.plan.fields.find(f => f.key === 'scene')!.locked).toBe(false);
    const restored = togglePlanFieldLock(next, 'scene');
    expect(restored.plan.fields.find(f => f.key === 'scene')!.locked).toBe(true);
    // 优化后再次改锁定项 → 重新进入 dirty
    const optimized = applyOptimizationResult(next, {
      optimizedPrompt: '最终 Prompt',
      optimizedNegativePrompt: '',
      summary: '已优化',
    });
    expect(optimized.editState).toBe('optimized');
    expect(togglePlanFieldLock(optimized, 'color').editState).toBe('dirty');
  });

  it('点击优化：dirty → optimizing → optimized（失败 → dirty + 失败原因）', () => {
    const dirty = applyAdjustmentInput(base(), '把衣服改成白色，背景不要动');
    const optimizing = markOptimizing(dirty);
    expect(optimizing.editState).toBe('optimizing');
    expect(canGenerateFromRecreation(optimizing).allowed).toBe(false);

    const optimized = applyOptimizationResult(optimizing, {
      optimizedPrompt: '一名身穿白色球衣的运动员在室内球馆上篮……',
      optimizedNegativePrompt: '低画质，模糊，错误人体结构',
      summary: '已根据调整要求把球衣改为白色，保留锁定的背景与构图。',
      providerName: '智谱',
      modelName: 'GLM-5.2',
    });
    expect(optimized.editState).toBe('optimized');
    expect(optimized.optimizedBy).toBe('optimizer');
    expect(optimized.optimizedPrompt).toContain('白色球衣');
    expect(optimized.summary).toContain('保留锁定');
    expect(canGenerateFromRecreation(optimized).allowed).toBe(true);
    expect(needsReoptimization(optimized)).toBe(false);

    const failed = markOptimizationFailed(markOptimizing(applyAdjustmentInput(base(), '换背景')), '模型未返回可用结果');
    expect(failed.editState).toBe('dirty');
    expect(failed.optimizeError).toBe('模型未返回可用结果');
    expect(canGenerateFromRecreation(failed).allowed).toBe(false);
    // 重新输入调整要求 → 失败原因清空，回到普通「待优化」
    const reapplied = applyAdjustmentInput(failed, '换成雪山背景');
    expect(reapplied.optimizeError).toBeUndefined();
    expect(reapplied.editState).toBe('dirty');
  });
});

describe('describeRecreationStatus（主状态栏：状态 / 标签 / 色调 / 引导语）', () => {
  const plan = () => buildRecreationPlan(fixtureAnalysis());

  it('未提取 → 灰色「未提取」', () => {
    const status = describeRecreationStatus(null);
    expect(status).toMatchObject({ key: 'not_extracted', label: '未提取', tone: 'gray' });
  });

  it('初始提取成功 → 绿色「可直接生成」（ready）', () => {
    const status = describeRecreationStatus(initialRecreationState(plan(), 'p', 'n'));
    expect(status).toMatchObject({ key: 'ready', label: '可直接生成', tone: 'green' });
    expect(status.note).toContain('确认生成');
  });

  it('输入调整要求 → 橙色「已修改，待重新优化」（dirty），引导语指向「优化复刻 Prompt」', () => {
    const status = describeRecreationStatus(applyAdjustmentInput(initialRecreationState(plan(), 'p', 'n'), '更亮'));
    expect(status).toMatchObject({ key: 'dirty', label: '已修改，待重新优化', tone: 'orange' });
    expect(status.note).toContain('优化复刻 Prompt');
  });

  it('优化中 → 蓝色「正在优化」（optimizing）', () => {
    const state = markOptimizing(applyAdjustmentInput(initialRecreationState(plan(), 'p', 'n'), '更亮'));
    expect(describeRecreationStatus(state)).toMatchObject({ key: 'optimizing', label: '正在优化', tone: 'blue' });
  });

  it('优化成功 → 绿色「已优化，可生成」（optimized，与 ready 语义分离）', () => {
    const state = applyOptimizationResult(applyAdjustmentInput(initialRecreationState(plan(), 'p', 'n'), '更亮'), {
      optimizedPrompt: '最终 Prompt',
      optimizedNegativePrompt: '',
      summary: '已微调',
    });
    expect(describeRecreationStatus(state)).toMatchObject({ key: 'optimized', label: '已优化，可生成', tone: 'green' });
  });

  it('优化失败 → 红色「优化失败」，引导语包含失败原因', () => {
    const failed = markOptimizationFailed(applyAdjustmentInput(initialRecreationState(plan(), 'p', 'n'), '更亮'), '网络超时');
    const status = describeRecreationStatus(failed);
    expect(status).toMatchObject({ key: 'optimize_failed', label: '优化失败', tone: 'red' });
    expect(status.note).toContain('网络超时');
  });
});

describe('canGenerateFromRecreation（生图守卫与中文错误文案）', () => {
  it('视觉理解未完成 → 拦截', () => {
    const result = canGenerateFromRecreation(null);
    expect(result).toEqual({ allowed: false, reason: '视觉理解尚未完成，暂时不能生成图片。' });
  });

  it('优化中 → 拦截', () => {
    const state = markOptimizing(initialRecreationState(buildRecreationPlan(fixtureAnalysis()), 'p', 'n'));
    expect(canGenerateFromRecreation(state)).toEqual({
      allowed: false,
      reason: '正在优化提示词，请稍候再确认生成。',
    });
  });

  it('已修改未优化（修订未对齐）→ 拦截：必须先点击优化复刻 Prompt', () => {
    const state = applyAdjustmentInput(initialRecreationState(buildRecreationPlan(fixtureAnalysis()), 'p', 'n'), '换背景');
    expect(canGenerateFromRecreation(state)).toEqual({
      allowed: false,
      reason: '当前方案已修改但尚未优化，请先点击【优化复刻 Prompt】。',
    });
  });

  it('ready 状态允许直接生成；optimized 状态允许生成', () => {
    const ready = initialRecreationState(buildRecreationPlan(fixtureAnalysis()), 'p', 'n');
    expect(canGenerateFromRecreation(ready)).toEqual({ allowed: true });
    const optimized = applyOptimizationResult(applyAdjustmentInput(ready, '更亮'), {
      optimizedPrompt: '最终 Prompt',
      optimizedNegativePrompt: '',
      summary: '已微调',
    });
    expect(canGenerateFromRecreation(optimized)).toEqual({ allowed: true });
  });

  it('缺少最终 Prompt（optimizedPrompt 为空）→ 拦截确认生成', () => {
    const state = {
      ...initialRecreationState(buildRecreationPlan(fixtureAnalysis()), 'p', 'n'),
      optimizedPrompt: '  ',
    };
    expect(canGenerateFromRecreation(state)).toEqual({
      allowed: false,
      reason: '当前缺少可用于生图的最终 Prompt，请先执行提示词优化。',
    });
  });
});

describe('buildGenerationCarry（生成参数带入 + 来源联动 + 禁止重复优化 + 人物参考）', () => {
  it('携带用户选择的生成参数（尺寸 / 质量 / 数量）与来源任务 id', () => {
    const state = applyOptimizationResult(
      applyAdjustmentInput(initialRecreationState(buildRecreationPlan(fixtureAnalysis()), '原始 Prompt', '负面'), '把主体换成蓝色小龙'),
      {
        optimizedPrompt: '最终 Prompt',
        optimizedNegativePrompt: '最终负面',
        summary: '已按调整要求优化',
        providerName: '智谱',
        modelName: 'GLM-5.2',
      },
    );
    const carry = buildGenerationCarry(state, {
      sourceVisionSessionId: 'sess-1',
      sourceVisionTaskId: 'task-vision-1',
      size: '1024x1792',
      quality: 'high',
      count: 4,
    });
    expect(carry.sourceVisionTaskId).toBe('task-vision-1');
    expect(carry.prompt).toBe('最终 Prompt');
    expect(carry.negativePrompt).toBe('最终负面');
    expect(carry.size).toBe('1024x1792');
    expect(carry.quality).toBe('high');
    expect(carry.count).toBe(4);
    expect(carry.optimization?.originalPrompt).toBe('原始 Prompt');
    expect(carry.optimization?.providerName).toBe('智谱');
    expect(carry.taskPlanSummary).toContain('视觉理解复刻方案');
    expect(carry.taskPlanSummary).toContain('蓝色小龙');
  });

  it('人物替换参考图随 carry 带出（i2i 第二参考）', () => {
    const state = initialRecreationState(buildRecreationPlan(fixtureAnalysis()), 'p', 'n');
    const carry = buildGenerationCarry(state, { personReferencePath: 'D:/refs/person.png' });
    expect(carry.personReferencePath).toBe('D:/refs/person.png');
    const without = buildGenerationCarry(state, {});
    expect(without.personReferencePath).toBeUndefined();
  });

  it('未修改直接生成时摘要为直接复刻（不触发优化）', () => {
    const state = initialRecreationState(buildRecreationPlan(fixtureAnalysis()), 'p', 'n');
    const carry = buildGenerationCarry(state, {});
    expect(carry.taskPlanSummary).toContain('直接复刻');
    expect(carry.optimization).toBeDefined();
    expect(carry.count).toBeUndefined();
  });
});

describe('重新优化（force 再执行一次，旧结果失败保留 / 成功才替换）', () => {
  const base = () =>
    initialRecreationState(
      buildRecreationPlan(fixtureAnalysis()),
      '一名男性篮球运动员在室内球馆上篮，低角度仰拍……',
      '低画质，模糊',
    );

  it('从 optimized 强制重新优化失败：旧优化产物原样保留，状态回 dirty 并记录原因', () => {
    const optimized = applyOptimizationResult(
      applyAdjustmentInput(base(), '把球衣换成蓝色'),
      {
        optimizedPrompt: '按调整要求重建后的新 Prompt',
        optimizedNegativePrompt: '低画质',
        summary: '已按调整重建',
      },
    );
    expect(optimized.editState).toBe('optimized');

    // 重新优化失败路径：optimizing → markOptimizationFailed
    const failed = markOptimizationFailed(markOptimizing(optimized), '网络中断');
    expect(failed.editState).toBe('dirty');
    expect(failed.optimizeError).toBe('网络中断');
    // 旧结果保留：上一轮优化产物不被清空
    expect(failed.optimizedPrompt).toBe('按调整要求重建后的新 Prompt');
    expect(failed.optimizedBy).toBe('optimizer');
  });

  it('从 ready（未修改）强制重新优化成功：直接进入 optimized', () => {
    const ready = base();
    const reoptimized = applyOptimizationResult(
      markOptimizing({ ...ready, adjustInstruction: '整体更梦幻' }),
      { optimizedPrompt: '更梦幻的重建 Prompt', optimizedNegativePrompt: '低画质', summary: '重建完成' },
    );
    expect(reoptimized.editState).toBe('optimized');
    expect(reoptimized.optimizedPrompt).toBe('更梦幻的重建 Prompt');
    expect(needsOptimization(reoptimized)).toBe(false);
  });

  it('失败后处于 dirty：生图守卫拦截，直至重新优化成功', () => {
    const optimized = applyOptimizationResult(
      applyAdjustmentInput(base(), '换背景'),
      { optimizedPrompt: '新版 Prompt', optimizedNegativePrompt: '低画质', summary: '完成' },
    );
    const failed = markOptimizationFailed(markOptimizing(optimized), '超时');
    expect(canGenerateFromRecreation(failed).allowed).toBe(false);
    const recovered = applyOptimizationResult(
      markOptimizing(failed),
      { optimizedPrompt: '恢复后的 Prompt', optimizedNegativePrompt: '低画质', summary: '重试成功' },
    );
    expect(canGenerateFromRecreation(recovered).allowed).toBe(true);
  });
});
