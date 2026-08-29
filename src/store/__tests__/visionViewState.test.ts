import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { VisionAnalysis } from '../../types';
import {
  applyModificationInstruction,
  applyOptimizationResult,
  buildRecreationPlan,
  canGenerateFromRecreation,
  initialRecreationState,
  markOptimizing,
  needsOptimization,
  type RecreationState,
} from '../../features/vision/recreationPlan';
import { buildModificationInstruction, EMPTY_MODIFICATION_DRAFT, toggleModificationDimension } from '../../features/vision/modificationIntent';

/**
 * UI-only 回归矩阵（V4.1 View State / Semantic State 分离铁律）：
 * 折叠 / 展开 / Tab / Viewer / 选中展示等纯 UI 操作绝不允许把「已优化，可生成」
 * 翻转成「已修改，待优化」；只有真实语义修改才增加 semanticRevision。
 * 场景锚定 GUI 实测 Bug：优化完成 → 收起维度 → 展开 → 确认生成被禁止。
 */

function installLocalStorageStub() {
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => { memory.set(key, String(value)); },
    removeItem: (key: string) => { memory.delete(key); },
    clear: () => memory.clear(),
  });
  return memory;
}

function fixtureAnalysis(): VisionAnalysis {
  return {
    summary: '一名男性篮球运动员在室内球馆上篮',
    subjects: [],
    scene: { environment: '室内篮球馆', location: '', background: '', time_of_day: '' },
    composition: { subject_placement: '中心', symmetry: '', crop: '' },
    camera: { shot_type: '低角度仰拍', angle: '', depth_of_field: '' },
    lighting: { source: '顶光', direction: '', softness: '', contrast: '' },
    colors: { dominant_palette: ['红色'], temperature: '暖色', saturation: '', contrast: '' },
    style: { category: '运动摄影', medium: '照片', texture: '', rendering: '写实', photographic_characteristics: '' },
    text_elements: [],
    fine_details: [],
    generation_risks: [],
    objects: [],
  } as unknown as VisionAnalysis;
}

/** 构造「已优化，可生成」的 recreation（semanticRevision = optimizedRevision = 5）。 */
function optimizedRecreation(): RecreationState {
  let state = initialRecreationState(buildRecreationPlan(fixtureAnalysis()), '原始 Prompt', '低画质');
  state = applyModificationInstruction(state, '把动作改成双手抱胸');
  state = applyOptimizationResult(markOptimizing(state), {
    optimizedPrompt: '优化后的最终 Prompt',
    optimizedNegativePrompt: '低画质',
    summary: '已优化',
  });
  // 对齐到目标修订号 5/5（模拟多轮优化后的工作区）
  state = { ...state, semanticRevision: 5, optimizedRevision: 5 };
  return state;
}

let workspace: typeof import('../useVisionWorkspaceStore')['useVisionWorkspaceStore'];
let view: typeof import('../useVisionViewStore')['useVisionViewStore'];
let viewer: typeof import('../useImageViewerStore')['useImageViewerStore'];

beforeEach(async () => {
  vi.resetModules();
  installLocalStorageStub();
  workspace = (await import('../useVisionWorkspaceStore')).useVisionWorkspaceStore;
  view = (await import('../useVisionViewStore')).useVisionViewStore;
  viewer = (await import('../useImageViewerStore')).useImageViewerStore;

  workspace.getState().setSource('D:/imgs/ref.png');
  workspace.getState().applyAnalysis({
    analysis: fixtureAnalysis(),
    reverseResult: {
      prompt: '原始 Prompt',
      negativePrompt: '低画质',
      recommended: {},
      sections: {} as never,
      risks: [],
      warnings: [],
    },
    recreation: optimizedRecreation(),
    genParams: { size: '1024x1024', quality: 'auto', count: 1 },
    visionProfileId: 'p',
    visionModelId: 'm',
    visionTaskId: 't-1',
    sessionId: 's-1',
  });
  workspace.getState().setPromptDraft('优化后的最终 Prompt');
  workspace.getState().setModificationDraft({ ...EMPTY_MODIFICATION_DRAFT, freeText: '把动作改成双手抱胸' });
  workspace.getState().flushPendingPersist();
});

describe('场景 6（GUI 实测 Bug 回归）：反复收起 / 展开维度锁定', () => {
  it('collapse dimensions → expand dimensions × N：始终已优化，可生成', () => {
    const before = workspace.getState().recreation!;
    const snapshot = JSON.stringify(before);
    expect(before.editState).toBe('optimized');
    expect(canGenerateFromRecreation(before)).toEqual({ allowed: true });

    for (let i = 0; i < 4; i++) {
      view.getState().toggleDimensions(); // 收起
      view.getState().toggleDimensions(); // 展开
    }

    const after = workspace.getState().recreation!;
    expect(after).toBe(before); // 引用级不变：workspace 从未被写入
    expect(JSON.stringify(after)).toBe(snapshot);
    expect(after.editState).toBe('optimized');
    expect(after.semanticRevision).toBe(5);
    expect(after.optimizedRevision).toBe(5);
    expect(needsOptimization(after)).toBe(false);
    expect(canGenerateFromRecreation(after)).toEqual({ allowed: true });
    expect(workspace.getState().promptDraft).toBe('优化后的最终 Prompt');
  });
});

describe('场景 7：其它 UI-only 操作矩阵（Tab / 高级设置 / Viewer / 详细分析）', () => {
  const uiOnlyActions: Array<[string, () => void]> = [
    ['展开 / 收起项目预览', () => { view.getState().toggleProjectPreview(); view.getState().toggleProjectPreview(); }],
    ['展开 / 收起自定义修改内容', () => { view.getState().toggleCustomContent(); view.getState().toggleCustomContent(); }],
    ['展开 / 收起人物替换', () => { view.getState().togglePersonReplacement(); view.getState().togglePersonReplacement(); }],
    ['展开 / 收起服装更改', () => { view.getState().toggleClothingChange(); view.getState().toggleClothingChange(); }],
    ['展开 / 收起动作与背景配置', () => {
      view.getState().toggleDimensionEditor('pose'); view.getState().toggleDimensionEditor('pose');
      view.getState().toggleDimensionEditor('scene'); view.getState().toggleDimensionEditor('scene');
    }],
    ['切换最终版本 / 修改对比 Tab', () => { view.getState().setPromptView('diff'); view.getState().setPromptView('final'); }],
    ['V6.7 四步向导切换 / 回退（1→2→3→4→1）', () => {
      view.getState().setVisionStep(2); view.getState().setVisionStep(3); view.getState().setVisionStep(4); view.getState().setVisionStep(1);
    }],
    ['展开 / 收起高级设置', () => { view.getState().toggleAdvanced(); view.getState().toggleAdvanced(); }],
    ['展开 / 收起 AI 详细分析', () => { view.getState().toggleAnalysisDetail(); view.getState().toggleAnalysisDetail(); }],
    ['打开 / 关闭 ImageViewer', () => {
      viewer.getState().openViewer([{ id: 'i', path: 'D:/imgs/ref.png' }], 0);
      viewer.getState().close();
    }],
    ['多图 Viewer 内切换', () => {
      viewer.getState().openViewer([
        { id: 'a', path: 'D:/imgs/a.png' },
        { id: 'b', path: 'D:/imgs/b.png' },
      ], 0);
      viewer.getState().close();
    }],
  ];

  for (const [label, action] of uiOnlyActions) {
    it(`${label}：状态完全不变（不 dirty、不 needsOptimization、revision 不变、promptDraft 不变）`, () => {
      const before = workspace.getState().recreation!;
      const promptBefore = workspace.getState().promptDraft;
      expect(canGenerateFromRecreation(before).allowed).toBe(true);

      action();

      const after = workspace.getState().recreation!;
      expect(after).toBe(before);
      expect(after.semanticRevision).toBe(5);
      expect(after.optimizedRevision).toBe(5);
      expect(needsOptimization(after)).toBe(false);
      expect(canGenerateFromRecreation(after).allowed).toBe(true);
      expect(workspace.getState().promptDraft).toBe(promptBefore);
      expect(view.getState().promptView === 'final' || view.getState().promptView === 'diff').toBe(true);
    });
  }

  it('View store 刻意不持久化（重进页面回到默认视图，语义数据不受影响）', () => {
    view.getState().toggleDimensions();
    view.getState().setPromptView('diff');
    expect(view.getState().dimensionsCollapsed).toBe(false);
    expect(view.getState().promptView).toBe('diff');
    view.getState().reset();
    expect(view.getState().dimensionsCollapsed).toBe(true);
    expect(view.getState().promptView).toBe('final');
    expect(view.getState().wizardStep).toBe(1);
    expect(view.getState().projectPreviewCollapsed).toBe(false);
    expect(view.getState().customContentCollapsed).toBe(false);
    expect(view.getState().personReplacementCollapsed).toBe(false);
    expect(view.getState().clothingChangeCollapsed).toBe(false);
    expect(view.getState().dimensionEditorCollapsed).toEqual({});
    // 视图重置不触碰工作区
    expect(workspace.getState().recreation!.editState).toBe('optimized');
  });
});

describe('场景 8：真实语义修改 → 已修改，待优化 → 生成暂时禁止', () => {
  it('切换快捷维度（如修改动作）→ semanticRevision +1，needsOptimization，canGenerate=false', () => {
    const current = workspace.getState();
    const draft = toggleModificationDimension(current.modificationDraft, 'pose');
    const next = applyModificationInstruction(current.recreation!, buildModificationInstruction(draft));

    expect(next.semanticRevision).toBe(6);
    expect(next.optimizedRevision).toBe(5);
    expect(needsOptimization(next)).toBe(true);
    expect(next.editState).toBe('dirty');
    expect(canGenerateFromRecreation(next)).toEqual({
      allowed: false,
      reason: '当前方案已修改但尚未优化，请先点击【优化复刻 Prompt】。',
    });
  });

  it('优化成功 → revision 对齐 → 恢复可生成', () => {
    const current = workspace.getState();
    const draft = toggleModificationDimension(current.modificationDraft, 'pose');
    const dirty = applyModificationInstruction(current.recreation!, buildModificationInstruction(draft));
    const optimized = applyOptimizationResult(markOptimizing(dirty), {
      optimizedPrompt: '新动作版 Prompt',
      optimizedNegativePrompt: '低画质',
      summary: '已改动作',
    });
    expect(optimized.semanticRevision).toBe(optimized.optimizedRevision);
    expect(canGenerateFromRecreation(optimized).allowed).toBe(true);
  });
});

describe('场景 9：手动修改最终 Prompt → 不触发语义 dirty，仍可直接生成', () => {
  it('promptDraft 手动编辑：recreation 完全不变（manual 状态独立于 semantic intent）', () => {
    const before = workspace.getState().recreation!;
    workspace.getState().setPromptDraft('用户手动微调后的 Prompt');
    workspace.getState().flushPendingPersist();

    const after = workspace.getState().recreation!;
    expect(after).toBe(before);
    expect(needsOptimization(after)).toBe(false);
    expect(canGenerateFromRecreation(after).allowed).toBe(true);
    expect(workspace.getState().promptDraft).toBe('用户手动微调后的 Prompt');
  });
});

describe('空修改意图归一（旧粘滞 dirty 陷阱回归）', () => {
  it('优化后清空全部修改意图 → 维持 optimized（绝不空指令卡死在 dirty）', () => {
    const current = workspace.getState();
    const cleared = applyModificationInstruction(current.recreation!, '');
    expect(cleared.editState).toBe('optimized');
    expect(needsOptimization(cleared)).toBe(false);
    expect(canGenerateFromRecreation(cleared).allowed).toBe(true);
    expect(cleared.adjustInstruction).toBe('');
  });
});
