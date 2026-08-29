import { describe, it, expect, beforeEach, vi } from 'vitest';

// mock IPC：store 行为测试不触达真实 Tauri
vi.mock('../../services/api', () => ({
  api: {
    listVisualProjects: vi.fn(async () => []),
    loadVisualProject: vi.fn(async (_id: string) => null as string | null),
    saveVisualProject: vi.fn(async () => {}),
    renameVisualProject: vi.fn(async () => {}),
    deleteVisualProject: vi.fn(async () => {}),
    saveVisualProjectMask: vi.fn(async (_p: string, _r: string, _b: string) => 'D:/appdata/visual_projects/p1/masks/r1.png'),
  },
}));

import { api } from '../../services/api';
import { useVisualProjectStore } from '../useVisualProjectStore';
import { fixtureAnalysis, emptyWorkspace } from '../../features/vision/project/__tests__/fixtures';
import { setProjectPersonContract } from '../../features/vision/project/project';


function analysisInput() {
  const analysis = fixtureAnalysis();
  const workspace = emptyWorkspace(analysis);
  return {
    name: '动漫照片风',
    analysis,
    plan: workspace.recreation!.plan,
    recreation: workspace.recreation!,
    sourceAsset: { path: 'D:/imgs/template.png', assetId: 'asset-1', source: 'gallery' as const },
    workspace,
  };
}

function resetStore() {
  useVisualProjectStore.setState({
    projects: [],
    active: null,
    lastError: '',
    listLoading: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (api.listVisualProjects as ReturnType<typeof vi.fn>).mockClear();
  resetStore();
});

describe('useVisualProjectStore（项目持久化与恢复）', () => {
  it('visualProjectRestoresWithoutReanalysis：openProject 只读本地 JSON，绝不调用视觉分析', async () => {
    const project = setProjectPersonContract(
      useVisualProjectStore.getState().active ?? (await useVisualProjectStore.getState().createFromAnalysis(analysisInput())),
      null,
    );
    // createFromAnalysis 落库后，把同一文档作为「磁盘上的项目」读回
    const savedJson = (api.saveVisualProject as ReturnType<typeof vi.fn>).mock.calls[0][0].dataJson;
    (api.loadVisualProject as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(savedJson);
    resetStore();
    const restored = await useVisualProjectStore.getState().openProject(project.id);
    expect(restored).not.toBeNull();
    expect(restored!.id).toBe(project.id);
    expect(restored!.templateSnapshot?.sourcePath).toBe('D:/imgs/template.png');
    expect(restored!.workspace.analysis?.summary).toContain('篮球');
    // 只发生 list/load/save IPC：无任何视觉分析调用（mock 面板里根本没有该方法）
    expect(api.loadVisualProject).toHaveBeenCalledTimes(1);
  });

  it('regionPersistsAcrossProjectReload：区域随项目文档往返不丢', async () => {
    await useVisualProjectStore.getState().createFromAnalysis(analysisInput());
    const region = {
      id: 'region-1',
      name: '区域 1',
      shape: { kind: 'rect' as const, x: 0.1, y: 0.1, w: 0.3, h: 0.5 },
      replaceType: 'person' as const,
      constraintStrength: 'strict' as const,
      replaceScope: 'whole_person' as const,
      enabled: true,
      createdAt: new Date().toISOString(),
      maskPath: 'D:/appdata/visual_projects/p1/masks/region-1.png',
    };
    useVisualProjectStore.getState().updateActive('regions', draft => ({ ...draft, regions: [region] }));
    await useVisualProjectStore.getState().flushPersist();
    const savedJson = (api.saveVisualProject as ReturnType<typeof vi.fn>).mock.calls[(api.saveVisualProject as ReturnType<typeof vi.fn>).mock.calls.length - 1]![0].dataJson;
    (api.loadVisualProject as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(savedJson);
    resetStore();
    const restored = await useVisualProjectStore.getState().openProject(
      JSON.parse(savedJson).id,
    );
    expect(restored!.regions).toHaveLength(1);
    expect(restored!.regions[0].maskPath).toBe(region.maskPath);
    expect(restored!.regions[0].shape).toEqual(region.shape);
  });

  it('updateActive 语义修改 revision+1；renameActive 不加修订', async () => {
    await useVisualProjectStore.getState().createFromAnalysis(analysisInput());
    const before = useVisualProjectStore.getState().active!.revision;
    useVisualProjectStore.getState().updateActive('free_text', draft => ({
      ...draft,
      modification: { ...draft.modification, freeText: '换个动作' },
    }));
    expect(useVisualProjectStore.getState().active!.revision).toBe(before + 1);
    const atRename = useVisualProjectStore.getState().active!.revision;
    await useVisualProjectStore.getState().renameActive('室内写真');
    expect(useVisualProjectStore.getState().active!.name).toBe('室内写真');
    expect(useVisualProjectStore.getState().active!.revision).toBe(atRename);
  });

  it('saveRegionMask：落盘返回路径并写回 region.maskPath', async () => {
    await useVisualProjectStore.getState().createFromAnalysis(analysisInput());
    useVisualProjectStore.getState().updateActive('regions', draft => ({
      ...draft,
      regions: [{
        id: 'r1',
        name: '区域 1',
        shape: { kind: 'rect', x: 0, y: 0, w: 0.2, h: 0.2 },
        replaceType: 'person',
        constraintStrength: 'strict',
        replaceScope: 'whole_person',
        enabled: true,
        createdAt: new Date().toISOString(),
      }],
    }));
    const path = await useVisualProjectStore.getState().saveRegionMask('r1', 'iVBORw0KGgo=');
    expect(path).toBe('D:/appdata/visual_projects/p1/masks/r1.png');
    expect(useVisualProjectStore.getState().active!.regions[0].maskPath).toBe(path);
  });

  it('deleteProject：清理列表与 active', async () => {
    const project = await useVisualProjectStore.getState().createFromAnalysis(analysisInput());
    await useVisualProjectStore.getState().deleteProject(project.id);
    expect(api.deleteVisualProject).toHaveBeenCalledWith(project.id);
    expect(useVisualProjectStore.getState().active).toBeNull();
  });

  it('duplicateActive / deriveActive 生成新项目且 immediate 落库', async () => {
    const original = await useVisualProjectStore.getState().createFromAnalysis(analysisInput());
    const copy = await useVisualProjectStore.getState().duplicateActive();
    expect(copy!.id).not.toBe(original.id);
    expect(copy!.name).toContain('副本');
    const derived = await useVisualProjectStore.getState().deriveActive();
    expect(derived!.id).not.toBe(original.id);
    expect(derived!.modification.person).toBeNull();
    const saveCalls = (api.saveVisualProject as ReturnType<typeof vi.fn>).mock.calls;
    expect(saveCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('openProject 损坏 JSON → 错误态，不 crash', async () => {
    (api.loadVisualProject as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce('{bad json');
    const result = await useVisualProjectStore.getState().openProject('p-x');
    expect(result).toBeNull();
    expect(useVisualProjectStore.getState().lastError).not.toBe('');
  });

  it('recordGeneration：状态 generated + generationIds 追加 + revision+1', async () => {
    await useVisualProjectStore.getState().createFromAnalysis(analysisInput());
    const before = useVisualProjectStore.getState().active!.revision;
    useVisualProjectStore.getState().recordGeneration('task-9', '最终 Prompt');
    const active = useVisualProjectStore.getState().active!;
    expect(active.status).toBe('generated');
    expect(active.generationIds).toEqual(['task-9']);
    expect(active.latestFinalPrompt).toBe('最终 Prompt');
    expect(active.revision).toBe(before + 1);
  });
});

describe('V6.8 素材替换显式确认（materialReplacementDone 持久化 / 保守恢复 / 复位）', () => {
  function lastSavedJson(): any {
    const calls = (api.saveVisualProject as ReturnType<typeof vi.fn>).mock.calls;
    return JSON.parse(calls[calls.length - 1]![0].dataJson);
  }

  it('老项目保守恢复：旧文档无确认字段（即使曾优化过 optimizedRevision=revision）→ 恢复为未确认', async () => {
    const project = await useVisualProjectStore.getState().createFromAnalysis(analysisInput());
    await useVisualProjectStore.getState().flushPersist();
    // 构造「旧版项目文档」：删除 V6.8 确认字段，并带上「曾优化完成」的旧痕迹
    const legacy = lastSavedJson();
    delete legacy.workspace.materialReplacementDone;
    legacy.workspace.recreation = legacy.workspace.recreation ?? null;
    legacy.optimizedRevision = legacy.revision;
    (api.loadVisualProject as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(JSON.stringify(legacy));
    resetStore();
    const restored = await useVisualProjectStore.getState().openProject(project.id);
    expect(restored).not.toBeNull();
    expect(restored!.workspace.materialReplacementDone).toBe(false);
  });

  it('确认走 updateActiveMeta：置 true 且不加修订，往返持久化不丢', async () => {
    await useVisualProjectStore.getState().createFromAnalysis(analysisInput());
    await useVisualProjectStore.getState().flushPersist();
    const revisionBefore = useVisualProjectStore.getState().active!.revision;
    useVisualProjectStore.getState().updateActiveMeta(draft => ({
      ...draft,
      workspace: { ...draft.workspace, materialReplacementDone: true },
    }));
    expect(useVisualProjectStore.getState().active!.workspace.materialReplacementDone).toBe(true);
    // 检查点不是方案内容：不加修订
    expect(useVisualProjectStore.getState().active!.revision).toBe(revisionBefore);
    await useVisualProjectStore.getState().flushPersist();
    const saved = lastSavedJson();
    expect(saved.workspace.materialReplacementDone).toBe(true);
    (api.loadVisualProject as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(JSON.stringify(saved));
    resetStore();
    const restored = await useVisualProjectStore.getState().openProject(saved.id);
    expect(restored!.workspace.materialReplacementDone).toBe(true);
  });

  it('素材域语义修改复位确认（人物替换变更 → 回到未确认；修订 +1 照常）', async () => {
    await useVisualProjectStore.getState().createFromAnalysis(analysisInput());
    useVisualProjectStore.getState().updateActiveMeta(draft => ({
      ...draft,
      workspace: { ...draft.workspace, materialReplacementDone: true },
    }));
    const revisionBefore = useVisualProjectStore.getState().active!.revision;
    useVisualProjectStore.getState().updateActive('person', draft => setProjectPersonContract(draft, null));
    const active = useVisualProjectStore.getState().active!;
    expect(active.workspace.materialReplacementDone).toBe(false);
    expect(active.revision).toBe(revisionBefore + 1);
  });

  it('generation_result 不复位确认（生成结果不是素材编辑）', async () => {
    await useVisualProjectStore.getState().createFromAnalysis(analysisInput());
    useVisualProjectStore.getState().updateActiveMeta(draft => ({
      ...draft,
      workspace: { ...draft.workspace, materialReplacementDone: true },
    }));
    useVisualProjectStore.getState().updateActive('generation_result', draft => ({
      ...draft,
      latestFinalPrompt: '生成用 Prompt',
    }));
    expect(useVisualProjectStore.getState().active!.workspace.materialReplacementDone).toBe(true);
  });
});

