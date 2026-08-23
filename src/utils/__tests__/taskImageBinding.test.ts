import { describe, it, expect } from 'vitest';
import {
  canAutoBindTaskImage,
  deriveTaskImageBindingAfterUserChange,
  resolveStoredTaskImageBinding,
  shouldAdvanceActiveImageOnTaskSuccess,
} from '../agent/taskImageBinding';

/**
 * 任务图片绑定四态（V4.0.8）：uninitialized / auto / manual / none。
 * 核心修复目标 —— 「用户明确解绑（空）」与「尚未初始化（空）」必须是不同状态：
 * 只有 uninitialized 允许自动绑定；none 持久化拒绝一切自动补图。
 */

describe('resolveStoredTaskImageBinding：持久化字段 → 四态（含旧数据迁移）', () => {
  it('无图无标记（旧数据 / 新会话）→ uninitialized', () => {
    expect(resolveStoredTaskImageBinding({})).toBe('uninitialized');
    expect(resolveStoredTaskImageBinding({ active_image_id: null, active_image_binding: null })).toBe('uninitialized');
  });

  it('有图：explicit 来源 → manual；auto 来源 → auto', () => {
    expect(resolveStoredTaskImageBinding({
      active_image_id: 'img-1',
      active_image_source: 'explicit',
    })).toBe('manual');
    expect(resolveStoredTaskImageBinding({
      active_image_id: 'img-1',
      active_image_source: 'auto',
    })).toBe('auto');
  });

  it('有图但无 source（旧数据）→ auto（连续编辑上下文不回退）', () => {
    expect(resolveStoredTaskImageBinding({ active_image_id: 'img-1' })).toBe('auto');
  });

  it('无图 + none 标记 → none（用户明确解绑，禁止复活）', () => {
    expect(resolveStoredTaskImageBinding({
      active_image_id: null,
      active_image_binding: 'none',
    })).toBe('none');
  });

  it('无图 + auto/manual 标记 → 保留（不降级为 uninitialized，避免重启后误开自动绑定）', () => {
    expect(resolveStoredTaskImageBinding({ active_image_binding: 'auto' })).toBe('auto');
    expect(resolveStoredTaskImageBinding({ active_image_binding: 'manual' })).toBe('manual');
  });

  it('manual 标记 + auto 来源新图 → manual（显式选择不被系统推进覆盖）', () => {
    expect(resolveStoredTaskImageBinding({
      active_image_id: 'img-2',
      active_image_source: 'auto',
      active_image_binding: 'manual',
    })).toBe('manual');
  });
});

describe('deriveTaskImageBindingAfterUserChange：用户显式变更后的推导', () => {
  it('场景：用户删除自动绑定图（X）→ none（需求 §8）', () => {
    expect(deriveTaskImageBindingAfterUserChange({
      previousBinding: 'auto',
      hasActiveImage: false,
      activeImageSource: null,
      manualImageCount: 0,
    })).toBe('none');
  });

  it('场景：用户删除最后一张手动图片 → none（需求 §9）', () => {
    expect(deriveTaskImageBindingAfterUserChange({
      previousBinding: 'manual',
      hasActiveImage: false,
      activeImageSource: null,
      manualImageCount: 0,
    })).toBe('none');
  });

  it('场景：none 后用户重新主动加图 → manual（需求 §10，none 不永久禁用）', () => {
    expect(deriveTaskImageBindingAfterUserChange({
      previousBinding: 'none',
      hasActiveImage: false,
      activeImageSource: null,
      manualImageCount: 1,
    })).toBe('manual');
  });

  it('场景：删除自动绑定图但仍保留手动任务图片 → manual', () => {
    expect(deriveTaskImageBindingAfterUserChange({
      previousBinding: 'auto',
      hasActiveImage: false,
      activeImageSource: null,
      manualImageCount: 2,
    })).toBe('manual');
  });

  it('场景：仍有显式绑定的 active image → manual', () => {
    expect(deriveTaskImageBindingAfterUserChange({
      previousBinding: 'manual',
      hasActiveImage: true,
      activeImageSource: 'explicit',
      manualImageCount: 0,
    })).toBe('manual');
  });

  it('场景：从未初始化的会话保持 uninitialized（空 ≠ 用户明确为空）', () => {
    expect(deriveTaskImageBindingAfterUserChange({
      previousBinding: 'uninitialized',
      hasActiveImage: false,
      activeImageSource: null,
      manualImageCount: 0,
    })).toBe('uninitialized');
  });

  it('场景：auto 绑定图仍在（只删了手动图）→ auto', () => {
    expect(deriveTaskImageBindingAfterUserChange({
      previousBinding: 'auto',
      hasActiveImage: true,
      activeImageSource: 'auto',
      manualImageCount: 0,
    })).toBe('auto');
  });
});

describe('canAutoBindTaskImage：自动绑定只允许 uninitialized', () => {
  it('uninitialized → true', () => {
    expect(canAutoBindTaskImage('uninitialized')).toBe(true);
  });
  it('auto / manual / none → false（均为用户或系统已确定的状态）', () => {
    expect(canAutoBindTaskImage('auto')).toBe(false);
    expect(canAutoBindTaskImage('manual')).toBe(false);
    expect(canAutoBindTaskImage('none')).toBe(false);
  });
});

describe('shouldAdvanceActiveImageOnTaskSuccess：任务成功推进守卫', () => {
  it('none → 永不自动绑定新结果图（需求 §19）', () => {
    expect(shouldAdvanceActiveImageOnTaskSuccess({
      binding: 'none',
      candidateAtMs: Date.now(),
      currentAtMs: 0,
    })).toBe(false);
  });

  it('uninitialized / auto / manual → 时间向前才推进', () => {
    const now = Date.now();
    for (const binding of ['uninitialized', 'auto', 'manual'] as const) {
      expect(shouldAdvanceActiveImageOnTaskSuccess({ binding, candidateAtMs: now, currentAtMs: now - 1000 })).toBe(true);
      expect(shouldAdvanceActiveImageOnTaskSuccess({ binding, candidateAtMs: now - 1000, currentAtMs: now })).toBe(false);
    }
  });

  it('时间不可比（旧数据无 set_at）→ 保守放行，避免历史会话卡死在旧图', () => {
    expect(shouldAdvanceActiveImageOnTaskSuccess({
      binding: 'auto',
      candidateAtMs: NaN,
      currentAtMs: NaN,
    })).toBe(true);
  });
});
