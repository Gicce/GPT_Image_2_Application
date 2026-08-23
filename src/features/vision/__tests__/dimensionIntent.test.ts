import { describe, it, expect } from 'vitest';
import type { VisionAnalysis } from '../../../types';
import {
  applyDimensionIntent,
  applyOptimizationResult,
  buildRecreationPlan,
  canGenerateFromRecreation,
  describeRecreationStatus,
  hasSuccessfulPrompt,
  initialRecreationState,
  markOptimizationFailed,
  markOptimizing,
  applyAdjustmentInput,
  revertToLastSuccessfulPrompt,
  togglePlanFieldLock,
  type RecreationFieldKey,
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
    scene: { environment: '室内篮球馆', location: '比赛球场', time_of_day: '白天', weather: '', background: '观众席虚化', foreground: '' },
    composition: { subject_placement: '主体居中偏左', symmetry: '非对称', negative_space: '', crop: '全身', depth_layers: '' },
    camera: { shot_type: '中远景', perspective: '', angle: '低角度仰拍', depth_of_field: '浅景深', lens_characteristics: '' },
    lighting: { source: '顶部场馆灯', direction: '顶光', softness: '硬光', key_fill_rim: '', contrast: '高对比', time_of_day: '', exposure: '' },
    colors: { dominant_palette: ['红色', '橙色'], temperature: '暖色', saturation: '高', contrast: '' },
    style: { category: '运动摄影', medium: '照片', texture: '', rendering: '写实', photographic_characteristics: '' },
    text_elements: [],
    fine_details: [],
    generation_risks: [],
  } as unknown as VisionAnalysis;
}

function baseState(): RecreationState {
  return initialRecreationState(
    buildRecreationPlan(fixtureAnalysis()),
    '一名男性篮球运动员在室内球馆上篮，低角度仰拍……',
    '低画质，模糊',
  );
}

function locksOf(state: RecreationState): Record<RecreationFieldKey, boolean> {
  const result = {} as Record<RecreationFieldKey, boolean>;
  for (const field of state.plan.fields) result[field.key] = field.locked;
  return result;
}

function fieldOf(state: RecreationState, key: RecreationFieldKey) {
  return state.plan.fields.find(f => f.key === key)!;
}

describe('applyDimensionIntent（修改意图测试矩阵：意图来自 AI 输出，非前端猜测）', () => {
  it('Case 1「把动作改成双手比心」→ 只开放 pose，其余锁定', () => {
    const next = applyDimensionIntent(baseState(), ['pose'], { pose: '双手在胸前组成比心手势' });
    const locks = locksOf(next);
    expect(locks.pose).toBe(false);
    for (const key of ['subject', 'clothing', 'composition', 'camera', 'scene', 'lighting', 'style', 'color'] as RecreationFieldKey[]) {
      expect(locks[key]).toBe(true);
    }
    expect(fieldOf(next, 'pose').value).toBe('双手在胸前组成比心手势');
    expect(fieldOf(next, 'pose').lockSource).toBe('intent');
  });

  it('Case 2「把人物换成成年男性」→ 只开放 subject', () => {
    const next = applyDimensionIntent(baseState(), ['subject'], { subject: '成年男性' });
    expect(locksOf(next).subject).toBe(false);
    expect(locksOf(next).scene).toBe(true);
  });

  it('Case 3「背景换成东京夜景」→ 只开放 scene', () => {
    const next = applyDimensionIntent(baseState(), ['scene'], { scene: '东京夜景街道，霓虹灯光' });
    expect(locksOf(next).scene).toBe(false);
    expect(locksOf(next).pose).toBe(true);
    expect(fieldOf(next, 'scene').value).toBe('东京夜景街道，霓虹灯光');
  });

  it('Case 4「改成低机位仰拍」→ camera（schema 允许附带 composition）', () => {
    const next = applyDimensionIntent(baseState(), ['camera', 'composition'], { camera: '低机位仰拍' });
    expect(locksOf(next).camera).toBe(false);
    expect(locksOf(next).composition).toBe(false);
    expect(locksOf(next).scene).toBe(true);
  });

  it('Case 5「改成暖色电影感」→ style + color + lighting（模糊意图只开放贴切维度）', () => {
    const next = applyDimensionIntent(baseState(), ['style', 'color', 'lighting'], {});
    expect(locksOf(next).style).toBe(false);
    expect(locksOf(next).color).toBe(false);
    expect(locksOf(next).lighting).toBe(false);
    expect(locksOf(next).subject).toBe(true);
    expect(locksOf(next).pose).toBe(true);
  });

  it('Case 6「人物双手比心，背景改成沙滩夕阳」→ pose + scene 多维修改', () => {
    const next = applyDimensionIntent(baseState(), ['pose', 'scene'], {
      pose: '双手比心',
      scene: '沙滩夕阳',
    });
    expect(locksOf(next).pose).toBe(false);
    expect(locksOf(next).scene).toBe(false);
    expect(locksOf(next).style).toBe(true);
    expect(locksOf(next).camera).toBe(true);
  });

  it('未知维度 key 一律忽略（不产生幽灵字段）', () => {
    const next = applyDimensionIntent(baseState(), ['pose', 'mood' as RecreationFieldKey, 'xyz' as RecreationFieldKey], {});
    expect(next.plan.fields.length).toBe(9);
    expect(locksOf(next).pose).toBe(false);
  });

  it('Case 7「人物不变，衣服换成红色晚礼服」→ 只开放 clothing（subject 保持锁定）', () => {
    const next = applyDimensionIntent(baseState(), ['clothing'], { clothing: '红色晚礼服' });
    expect(locksOf(next).clothing).toBe(false);
    expect(locksOf(next).subject).toBe(true);
    expect(fieldOf(next, 'clothing').value).toBe('红色晚礼服');
  });

  it('Case 8「换成黑发男性，穿白色西装」→ subject + clothing 同时开放（人物与服装区分判定）', () => {
    const next = applyDimensionIntent(baseState(), ['subject', 'clothing'], {
      subject: '黑发男性',
      clothing: '白色西装',
    });
    expect(locksOf(next).subject).toBe(false);
    expect(locksOf(next).clothing).toBe(false);
    expect(locksOf(next).pose).toBe(true);
  });

  it('dimensionValues 缺失时仅更新锁定状态，不改维度值', () => {
    const before = fieldOf(baseState(), 'pose').value;
    const next = applyDimensionIntent(baseState(), ['pose']);
    expect(fieldOf(next, 'pose').value).toBe(before);
  });

  it('originalValue 不随优化改写（维度 Diff 的「原」侧固定为初始分析值）', () => {
    const next = applyDimensionIntent(baseState(), ['pose'], { pose: '双手比心' });
    expect(fieldOf(next, 'pose').originalValue).toContain('腾空上篮');
    // 二次优化继续沿用同一 originalValue
    const again = applyDimensionIntent(next, ['pose'], { pose: '单手托球' });
    expect(fieldOf(again, 'pose').originalValue).toContain('腾空上篮');
    expect(fieldOf(again, 'pose').value).toBe('单手托球');
  });
});

describe('用户手动锁定优先级（User Override > Modification Intent > Default）', () => {
  it('AI 判定 action + scene 可修改；用户手动锁定 scene；再次优化后 scene 仍锁定', () => {
    let state = applyDimensionIntent(baseState(), ['pose', 'scene'], { pose: '双手比心', scene: '沙滩' });
    expect(locksOf(state).scene).toBe(false);

    // 用户手动锁定 scene → user_override
    state = togglePlanFieldLock(state, 'scene');
    expect(fieldOf(state, 'scene').locked).toBe(true);
    expect(fieldOf(state, 'scene').lockSource).toBe('user_override');

    // 再次 AI 判定 scene 可修改（优化器返回 changed 含 scene）→ 不覆盖用户锁定
    state = applyDimensionIntent(state, ['pose', 'scene'], { pose: '双手比心 V2', scene: '不应生效的值' });
    expect(fieldOf(state, 'scene').locked).toBe(true);
    expect(fieldOf(state, 'scene').value).not.toBe('不应生效的值');
    expect(fieldOf(state, 'pose').locked).toBe(false);
    expect(fieldOf(state, 'pose').value).toBe('双手比心 V2');
  });

  it('用户手动开放（解锁默认锁定项）同样不被 AI 收回', () => {
    let state = baseState();
    state = togglePlanFieldLock(state, 'lighting'); // 默认锁定 → 用户手动开放
    expect(fieldOf(state, 'lighting').locked).toBe(false);
    state = applyDimensionIntent(state, ['pose'], { pose: '比心' }); // AI 只报 pose
    expect(fieldOf(state, 'lighting').locked).toBe(false); // 用户开放保持
    expect(fieldOf(state, 'lighting').lockSource).toBe('user_override');
  });

  it('togglePlanFieldLock 立即进入 dirty（参与下一次优化）', () => {
    const next = togglePlanFieldLock(baseState(), 'color');
    expect(next.editState).toBe('dirty');
    expect(canGenerateFromRecreation(next).allowed).toBe(false);
  });
});

describe('旧数据兼容（V4.0.9 会话无 lockSource / originalValue）', () => {
  it('缺省 lockSource 视为 default，可被 AI 意图正常落位', () => {
    const legacy = baseState();
    legacy.plan.fields = legacy.plan.fields.map(f => ({ ...f, lockSource: undefined, originalValue: undefined }));
    const next = applyDimensionIntent(legacy, ['pose'], { pose: '比心' });
    expect(fieldOf(next, 'pose').locked).toBe(false);
    expect(fieldOf(next, 'pose').lockSource).toBe('intent');
    expect(fieldOf(next, 'pose').originalValue).toBeUndefined(); // 旧数据不伪造原值（不显示维度 Diff）
  });
});

describe('applyOptimizationResult 集成维度意图（优化成功 → 锁定结构随意图更新）', () => {
  it('携带 changedDimensions / dimensionValues 时同步落位', () => {
    const dirty = applyAdjustmentInput(baseState(), '我需要当前人物做一个比心动作');
    const next = applyOptimizationResult(markOptimizing(dirty), {
      optimizedPrompt: '……双手在胸前组成比心手势……',
      optimizedNegativePrompt: '',
      summary: '已把动作改为比心，其余保持',
      changedDimensions: ['pose'],
      dimensionValues: { pose: '双手在胸前组成比心手势' },
    });
    expect(next.editState).toBe('optimized');
    expect(fieldOf(next, 'pose').locked).toBe(false);
    expect(fieldOf(next, 'pose').value).toBe('双手在胸前组成比心手势');
    expect(fieldOf(next, 'scene').locked).toBe(true);
  });

  it('不携带 changedDimensions（旧协议）→ 保持现锁定结构（向后兼容）', () => {
    const dirty = applyAdjustmentInput(baseState(), '更亮');
    const next = applyOptimizationResult(markOptimizing(dirty), {
      optimizedPrompt: '新 Prompt',
      optimizedNegativePrompt: '',
      summary: '已优化',
    });
    expect(locksOf(next)).toEqual(locksOf(dirty));
  });
});

describe('优化失败与「使用上一次 Prompt」', () => {
  it('成功后再失败：上一次成功 Prompt 保留，状态栏提示可回退', () => {
    let state = applyOptimizationResult(
      applyAdjustmentInput(baseState(), '把衣服改成白色'),
      { optimizedPrompt: '白色球衣版 Prompt', optimizedNegativePrompt: '', summary: '已改白色' },
    );
    expect(hasSuccessfulPrompt(state)).toBe(true);

    // 第二轮重新优化失败
    state = markOptimizationFailed(markOptimizing(state), '模型未返回可用结果');
    expect(state.editState).toBe('dirty');
    expect(state.optimizedPrompt).toBe('白色球衣版 Prompt'); // 不被清空
    const status = describeRecreationStatus(state);
    expect(status.key).toBe('optimize_failed');
    expect(status.note).toContain('使用上一次 Prompt');
  });

  it('revertToLastSuccessfulPrompt：回退后有优化史 → optimized（可直接生成）', () => {
    let state = applyOptimizationResult(
      applyAdjustmentInput(baseState(), '更亮'),
      { optimizedPrompt: '优化后 Prompt', optimizedNegativePrompt: '负面', summary: '完成' },
    );
    state = markOptimizationFailed(markOptimizing(state), '超时');
    const reverted = revertToLastSuccessfulPrompt(state);
    expect(reverted.editState).toBe('optimized');
    expect(reverted.semanticRevision).toBe(reverted.optimizedRevision);
    expect(reverted.optimizeError).toBeUndefined();
    expect(reverted.adjustInstruction).toBe('');
    expect(reverted.optimizedPrompt).toBe('优化后 Prompt');
    expect(canGenerateFromRecreation(reverted).allowed).toBe(true);
  });

  it('无优化史（analysis 产物）失败后回退 → ready（原始复刻 Prompt）', () => {
    const ready = baseState();
    const failed = markOptimizationFailed(markOptimizing(ready), '超时');
    const reverted = revertToLastSuccessfulPrompt(failed);
    expect(reverted.editState).toBe('ready');
    expect(reverted.optimizedPrompt).toBe(ready.originalPrompt);
    expect(canGenerateFromRecreation(reverted).allowed).toBe(true);
  });
});
