import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { VisionAnalysis } from '../../types';
import type { ReversePromptResult, PromptSections } from '../../features/vision/reversePrompt';
import type { RecreationState } from '../../features/vision/recreationPlan';

/**
 * Vision Workspace 持久化测试（V4.0.7）。
 * store 在模块加载时同步读取 localStorage —— 每个用例先装内存 stub、
 * resetModules 后动态 import，等价于一次「应用重启后的工作区恢复」。
 */

type StoreApi = (typeof import('../useVisionWorkspaceStore'))['useVisionWorkspaceStore'];

const STORE_PATH = fileURLToPath(new URL('../useVisionWorkspaceStore.ts', import.meta.url));

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

async function freshStore(): Promise<StoreApi> {
  vi.resetModules();
  return (await import('../useVisionWorkspaceStore')).useVisionWorkspaceStore;
}

function makeAnalysis(): VisionAnalysis {
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

function makeRecreation(prompt: string): RecreationState {
  return {
    plan: { summary: '方案摘要', fields: [] },
    originalPrompt: prompt,
    originalNegativePrompt: '低画质',
    editState: 'ready' as const,
    semanticRevision: 0,
    optimizedRevision: 0,
    adjustInstruction: '',
    optimizedPrompt: prompt,
    optimizedNegativePrompt: '低画质',
    optimizedBy: 'analysis' as const,
  } as RecreationState;
}

function makeReverseResult(): ReversePromptResult {
  return {
    prompt: 'P',
    negativePrompt: 'N',
    recommended: {},
    sections: {} as PromptSections,
    risks: [],
    warnings: [],
  };
}

let store: StoreApi;

beforeEach(async () => {
  vi.useRealTimers();
  installLocalStorageStub();
  store = await freshStore();
});

describe('Workspace 保存与恢复（页面切换 / 组件卸载 / 应用重启）', () => {
  it('保存参考图标识（路径 + assetId，绝不保存 base64）与模型 / 模式选择', async () => {
    store.getState().setSource('D:/imgs/ref.png', 'asset-42');
    store.getState().setModelSelection('profile-a', 'glm-5v-turbo');
    store.getState().setMode('quick');

    const raw = localStorage.getItem('vision_workspace_v1')!;
    expect(raw).toContain('D:/imgs/ref.png');
    expect(raw).toContain('asset-42');
    expect(raw).not.toMatch(/data:image/);

    // 模拟重启：重新加载模块应完整恢复
    const reloaded = await freshStore();
    const state = reloaded.getState();
    expect(state.sourcePath).toBe('D:/imgs/ref.png');
    expect(state.sourceAssetId).toBe('asset-42');
    expect(state.profileId).toBe('profile-a');
    expect(state.modelId).toBe('glm-5v-turbo');
    expect(state.mode).toBe('quick');
  });

  it('分析完成（applyAnalysis）落位分析结果 / 复刻方案 / 三个 Prompt / 推荐参数 / 任务与会话关联，重启后完整恢复', async () => {
    const analysis = makeAnalysis();
    const reverseResult: ReversePromptResult = {
      prompt: '一名男性篮球运动员在室内球馆上篮，低角度仰拍',
      negativePrompt: '低画质，模糊',
      recommended: { size: '1792x1024', quality: 'high' },
      sections: {} as PromptSections,
      risks: [],
      warnings: [],
    };
    const recreation = makeRecreation(reverseResult.prompt);
    store.getState().setSource('D:/imgs/ref.png');
    store.getState().applyAnalysis({
      analysis,
      reverseResult,
      recreation,
      genParams: { size: '1792x1024', quality: 'high', count: 1 },
      visionProfileId: 'profile-a',
      visionModelId: 'glm-5v-turbo',
      visionTaskId: 'task-7',
      sessionId: 'session-9',
    });
    store.getState().setModificationDraft({
      freeText: '把球衣换成蓝色',
      activeDimensions: ['clothing'],
      person: null,
      // V4.0.9 状态不变量：clothing ∈ activeDimensions ⇔ clothingPolicy ≠ preserve_original
      clothingPolicy: 'custom',
      customClothing: '蓝色球衣',
      replicationBoost: false,
      mentions: [],
      extraImageRefs: [],
    });
    store.getState().flushPendingPersist(); // 文本输入为防抖落盘（组件卸载时同样冲刷）

    const reloaded = await freshStore();
    const state = reloaded.getState();
    expect(state.analysis?.summary).toContain('篮球运动员');
    expect(state.reverseResult?.prompt).toBe(reverseResult.prompt);
    expect(state.recreation?.originalPrompt).toBe(reverseResult.prompt);
    expect(state.genParams).toEqual({ size: '1792x1024', quality: 'high', count: 1 });
    expect(state.visionTaskId).toBe('task-7');
    expect(state.sessionId).toBe('session-9');
    expect(state.stage).toBe('ready');
    // 用户结构化修改意图同样恢复（合法状态原样持久化）
    expect(state.modificationDraft.freeText).toBe('把球衣换成蓝色');
    expect(state.modificationDraft.activeDimensions).toEqual(['clothing']);
    expect(state.modificationDraft.clothingPolicy).toBe('custom');
    expect(state.modificationDraft.customClothing).toBe('蓝色球衣');
  });

  it('旧快照（V4.1 前 adjustmentInput 纯文本）迁移为 modificationDraft.freeText，维度 / 服装为默认', async () => {
    store.getState().setSource('D:/imgs/ref.png');
    // 手工写入旧格式快照（无 modificationDraft，有 adjustmentInput）
    const raw = JSON.parse(localStorage.getItem('vision_workspace_v1')!);
    delete raw.modificationDraft;
    raw.adjustmentInput = '背景换成夜景';
    localStorage.setItem('vision_workspace_v1', JSON.stringify(raw));

    const reloaded = await freshStore();
    const draft = reloaded.getState().modificationDraft;
    expect(draft.freeText).toBe('背景换成夜景');
    expect(draft.activeDimensions).toEqual([]);
    expect(draft.clothingPolicy).toBe('preserve_original');
    expect(draft.person).toBeNull();
  });

  it('旧快照 recreation（modified 标记）恢复为修订语义（needsOptimization 保持）', async () => {
    store.getState().setSource('D:/imgs/ref.png');
    const legacy = { ...makeRecreation('P'), editState: 'dirty' as const, modified: true, adjustInstruction: '换背景' };
    delete (legacy as Partial<typeof legacy>).semanticRevision;
    delete (legacy as Partial<typeof legacy>).optimizedRevision;
    store.getState().setRecreation(legacy as RecreationState);

    const reloaded = await freshStore();
    const recreation = reloaded.getState().recreation!;
    expect(recreation.semanticRevision).toBe(1);
    expect(recreation.optimizedRevision).toBe(0);
    expect(recreation.adjustInstruction).toBe('换背景');
  });

  it('用户编辑的最终 Prompt / 负面词防抖落盘（500ms 内不逐字符写盘）', async () => {
    vi.useFakeTimers();
    store.getState().setPromptDraft('修改后的最终 Prompt');
    expect(localStorage.getItem('vision_workspace_v1')).toBeNull(); // 未到防抖窗口
    vi.advanceTimersByTime(500);
    const raw = localStorage.getItem('vision_workspace_v1');
    expect(raw).toContain('修改后的最终 Prompt');

    store.getState().setNegativeDraft('避免文字');
    store.getState().flushPendingPersist(); // 卸载冲刷
    expect(localStorage.getItem('vision_workspace_v1')).toContain('避免文字');
    vi.useRealTimers();
  });
});

describe('Workspace 状态归一化（恢复绝不重放进行中操作）', () => {
  it('analyzing 中断的快照恢复为 idle（分析未完成，允许重新执行；不会自动重调 API）', async () => {
    store.getState().setSource('D:/imgs/ref.png');
    store.getState().markStage('analyzing', '');
    const reloaded = await freshStore();
    expect(reloaded.getState().stage).toBe('idle');
    expect(reloaded.getState().analysis).toBeNull();
  });

  it('上次请求失败：恢复图片与错误信息，允许重新执行（错误不绑定工作区）', async () => {
    store.getState().setSource('D:/imgs/ref.png');
    store.getState().markStage('failed', '视觉理解失败：HTTP 429');
    const reloaded = await freshStore();
    expect(reloaded.getState().stage).toBe('failed');
    expect(reloaded.getState().errorText).toContain('429');
    expect(reloaded.getState().sourcePath).toBe('D:/imgs/ref.png');
  });

  it('recreation 停在 optimizing 的快照恢复为 dirty 并提示中断（内容全保留）', async () => {
    const analysis = makeAnalysis();
    store.getState().applyAnalysis({
      analysis,
      reverseResult: makeReverseResult(),
      recreation: makeRecreation('P'),
      genParams: { size: '1024x1024', quality: 'auto', count: 1 },
      visionProfileId: 'p', visionModelId: 'm', visionTaskId: 't', sessionId: 's',
    });
    // 手动构造 optimizing 落盘（模拟防抖恰好捕获进行中状态）
    const current = store.getState();
    store.getState().setRecreation({ ...current.recreation!, editState: 'optimizing', adjustInstruction: '换背景' });

    const reloaded = await freshStore();
    const recreation = reloaded.getState().recreation!;
    expect(recreation.editState).toBe('dirty');
    expect(recreation.optimizeError).toContain('中断');
    expect(recreation.originalPrompt).toBe('P');
    expect(recreation.adjustInstruction).toBe('换背景');
  });
});

describe('重新开始 / 移除图片', () => {
  it('reset 清空全部工作区状态并删除持久化数据（不动 localStorage 其他键）', async () => {
    localStorage.setItem('vision_sessions_v1', '[{"id":"history-kept"}]');
    store.getState().setSource('D:/imgs/ref.png');
    store.getState().applyAnalysis({
      analysis: makeAnalysis(),
      reverseResult: makeReverseResult(),
      recreation: makeRecreation('P'),
      genParams: { size: '1024x1024', quality: 'auto', count: 1 },
      visionProfileId: 'p', visionModelId: 'm', visionTaskId: 't', sessionId: 's',
    });
    store.getState().setPromptDraft('用户改过的 Prompt');

    store.getState().reset();

    const state = store.getState();
    expect(state.sourcePath).toBe('');
    expect(state.analysis).toBeNull();
    expect(state.recreation).toBeNull();
    expect(state.promptDraft).toBe('');
    expect(state.stage).toBe('idle');
    expect(localStorage.getItem('vision_workspace_v1')).toBeNull();
    // 历史会话记录不受「重新开始」影响
    expect(localStorage.getItem('vision_sessions_v1')).toContain('history-kept');
  });

  it('removeSource 清除图片与分析产物，但保留模型 / 模式选择', () => {
    store.getState().setSource('D:/imgs/ref.png');
    store.getState().setModelSelection('profile-a', 'glm-5v-turbo');
    store.getState().setMode('high_fidelity');
    store.getState().removeSource();
    const state = store.getState();
    expect(state.sourcePath).toBe('');
    expect(state.analysis).toBeNull();
    expect(state.profileId).toBe('profile-a');
    expect(state.modelId).toBe('glm-5v-turbo');
    expect(state.mode).toBe('high_fidelity');
  });
});

describe('重新理解失败保护（V4.0.9：lastSuccessfulAnalysis 绝不被失败清掉）', () => {
  it('分析 A 成功 → 重新理解 B 失败：A 的分析 / 复刻方案 / Prompt 原样保留，semanticRevision 不变', () => {
    store.getState().setSource('D:/imgs/ref.png');
    store.getState().applyAnalysis({
      analysis: makeAnalysis(),
      reverseResult: makeReverseResult(),
      recreation: makeRecreation('原始复刻 Prompt'),
      genParams: { size: '1024x1024', quality: 'auto', count: 1 },
      visionProfileId: 'p', visionModelId: 'glm-5v-turbo', visionTaskId: 'task-a', sessionId: 'session-a',
    });
    const before = store.getState();
    const analysisBefore = before.analysis;
    const recreationBefore = before.recreation;
    const promptBefore = before.promptDraft;

    // 重新理解失败（schema 漂移 / 网络错误等任何原因）只落 stage + errorText
    store.getState().markStage('failed', '本次重新理解没有完成，仍保留上一次分析结果。图片理解没有完成，AI 返回的分析结果不完整，可以重新尝试理解。');

    const after = store.getState();
    expect(after.analysis).toBe(analysisBefore);           // 同一引用：旧成功结果未被触碰
    expect(after.recreation).toBe(recreationBefore);
    expect(after.recreation!.semanticRevision).toBe(0);    // 失败不是语义修改，不污染修订计数
    expect(after.promptDraft).toBe(promptBefore);
    expect(after.stage).toBe('failed');
    expect(after.errorText).toContain('仍保留上一次分析结果');

    // 失败不死锁：可立即再次进入分析
    store.getState().markStage('analyzing', '');
    expect(store.getState().stage).toBe('analyzing');
    expect(store.getState().analysis).toBe(analysisBefore);
  });

  it('失败后重启恢复：旧成功分析与 failed 状态共存，仍可重新执行', async () => {
    store.getState().setSource('D:/imgs/ref.png');
    store.getState().applyAnalysis({
      analysis: makeAnalysis(),
      reverseResult: makeReverseResult(),
      recreation: makeRecreation('P'),
      genParams: { size: '1024x1024', quality: 'auto', count: 1 },
      visionProfileId: 'p', visionModelId: 'm', visionTaskId: 't', sessionId: 's',
    });
    store.getState().markStage('failed', '本次重新理解没有完成，仍保留上一次分析结果。');

    const reloaded = await freshStore();
    const state = reloaded.getState();
    expect(state.stage).toBe('failed');            // normalizeStage：有内容时 failed 保留
    expect(state.analysis?.summary).toContain('篮球运动员');
    expect(state.recreation?.originalPrompt).toBe('P');
  });
});

describe('防重复 API 静态守卫（恢复工作区绝不自动调用视觉理解 API）', () => {
  it('workspace store 源码不 import services/api、不引用 visionAnalyzeImage / fetch', () => {
    const source = readFileSync(STORE_PATH, 'utf-8');
    expect(source).not.toContain("from '../services/api'");
    expect(source).not.toContain('visionAnalyzeImage');
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});

describe('生成方式（V4.0.8：文生图 / 图生图，切页面回来不丢）', () => {
  it('默认图生图；setGenerationMode 立即落盘，重启后恢复用户选择', async () => {
    expect(store.getState().generationMode).toBe('i2i');
    store.getState().setGenerationMode('t2i');
    expect(JSON.parse(localStorage.getItem('vision_workspace_v1')!).generationMode).toBe('t2i');

    const reloaded = await freshStore();
    expect(reloaded.getState().generationMode).toBe('t2i');

    // 切回图生图 → 再次恢复
    reloaded.getState().setGenerationMode('i2i');
    const again = await freshStore();
    expect(again.getState().generationMode).toBe('i2i');
  });

  it('applyAnalysis（重新分析）不重置用户的生成方式选择', () => {
    store.getState().setGenerationMode('t2i');
    store.getState().applyAnalysis({
      analysis: makeAnalysis(),
      reverseResult: makeReverseResult(),
      recreation: makeRecreation('P'),
      genParams: { size: '1024x1024', quality: 'auto', count: 1 },
      visionProfileId: 'p', visionModelId: 'm', visionTaskId: 't', sessionId: 's',
    });
    expect(store.getState().generationMode).toBe('t2i');
  });

  it('旧快照（无 generationMode 字段）恢复为默认图生图', async () => {
    const raw = JSON.parse(localStorage.getItem('vision_workspace_v1') || '{}');
    delete raw.generationMode;
    localStorage.setItem('vision_workspace_v1', JSON.stringify(raw));
    const reloaded = await freshStore();
    expect(reloaded.getState().generationMode).toBe('i2i');
  });
});

describe('V6.8 素材替换显式确认（无项目链路快照字段）', () => {
  it('默认未确认；旧快照无该字段恢复为 false（保守恢复，不从优化产物反推）', async () => {
    expect(store.getState().materialReplacementDone).toBe(false);
    store.getState().setSource('D:/imgs/ref.png');
    // 手工构造 V6.8 前的旧快照（含曾优化过的 recreation）
    const legacy = makeRecreation('P');
    store.getState().setRecreation(legacy);
    const raw = JSON.parse(localStorage.getItem('vision_workspace_v1')!);
    delete raw.materialReplacementDone;
    localStorage.setItem('vision_workspace_v1', JSON.stringify(raw));

    const reloaded = await freshStore();
    expect(reloaded.getState().materialReplacementDone).toBe(false);
    expect(reloaded.getState().recreation?.originalPrompt).toBe('P'); // 优化产物照常保留
  });

  it('setMaterialReplacementDone(true) 立即落盘，重启后恢复', async () => {
    store.getState().setSource('D:/imgs/ref.png');
    store.getState().setMaterialReplacementDone(true);
    expect(JSON.parse(localStorage.getItem('vision_workspace_v1')!).materialReplacementDone).toBe(true);

    const reloaded = await freshStore();
    expect(reloaded.getState().materialReplacementDone).toBe(true);
  });

  it('removeSource / applyAnalysis（重新理解）复位确认位', () => {
    store.getState().setSource('D:/imgs/ref.png');
    store.getState().setMaterialReplacementDone(true);
    store.getState().removeSource();
    expect(store.getState().materialReplacementDone).toBe(false);

    store.getState().setMaterialReplacementDone(true);
    store.getState().applyAnalysis({
      analysis: makeAnalysis(),
      reverseResult: makeReverseResult(),
      recreation: makeRecreation('P'),
      genParams: { size: '1024x1024', quality: 'auto', count: 1 },
      visionProfileId: 'p', visionModelId: 'm', visionTaskId: 't', sessionId: 's',
    });
    expect(store.getState().materialReplacementDone).toBe(false);
  });

  it('reset 清空确认位（与全部工作区状态一致）', () => {
    store.getState().setSource('D:/imgs/ref.png');
    store.getState().setMaterialReplacementDone(true);
    store.getState().reset();
    expect(store.getState().materialReplacementDone).toBe(false);
  });
});
