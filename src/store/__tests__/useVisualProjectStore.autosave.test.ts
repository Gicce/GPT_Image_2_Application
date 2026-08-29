/**
 * V6.2 Visual Project 自动保存状态测试（ProjectSaveState）：
 *  - 语义修改 → pending（防抖已排程）→ flush → saving → saved（savedRevision 记录）；
 *  - 保存失败 → error 且内存文档保留（dirty 可重试）→ retrySave 成功回 saved；
 *  - 状态按 projectId 隔离：非当前项目的落库不污染保存指示；
 *  - openProject 先冲刷上一个项目在途防抖（V6.2 修复：切项目丢最后一步修改）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../services/api', () => ({
  api: {
    listVisualProjects: vi.fn(async () => []),
    loadVisualProject: vi.fn(async (_id: string) => null as string | null),
    saveVisualProject: vi.fn(async () => {}),
    renameVisualProject: vi.fn(async () => {}),
    deleteVisualProject: vi.fn(async () => {}),
    saveVisualProjectMask: vi.fn(async (_p: string, _r: string, _b: string) => 'm.png'),
  },
}));

import { api } from '../../services/api';
import { useVisualProjectStore } from '../useVisualProjectStore';
import { fixtureAnalysis, emptyWorkspace } from '../../features/vision/project/__tests__/fixtures';

function analysisInput(name = '自动保存项目') {
  const analysis = fixtureAnalysis();
  const workspace = emptyWorkspace(analysis);
  return {
    name,
    analysis,
    plan: workspace.recreation!.plan,
    recreation: workspace.recreation!,
    sourceAsset: { path: 'D:/imgs/template.png', assetId: 'asset-1', source: 'gallery' as const },
    workspace,
  };
}

const saveMock = api.saveVisualProject as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  useVisualProjectStore.setState({
    projects: [],
    active: null,
    lastError: '',
    listLoading: false,
    saveState: { status: 'idle', projectId: null },
  });
});

describe('ProjectSaveState（V6.2 自动保存诚实状态）', () => {
  it('semanticEditMarksPendingThenSaved：语义修改 pending → flush → saved', async () => {
    const project = await useVisualProjectStore.getState().createFromAnalysis(analysisInput());
    // createFromAnalysis 立即落库 → saved
    expect(useVisualProjectStore.getState().saveState).toMatchObject({ status: 'saved', projectId: project.id });
    // 语义修改 → 防抖排程（pending，同步可观察）
    useVisualProjectStore.getState().updateActive('free_text', draft => ({
      ...draft,
      modification: { ...draft.modification, freeText: '换个动作' },
    }));
    expect(useVisualProjectStore.getState().saveState.status).toBe('pending');
    // flush → saving → saved（记录已保存修订）
    await useVisualProjectStore.getState().flushPersist();
    const state = useVisualProjectStore.getState();
    expect(state.saveState.status).toBe('saved');
    expect(state.saveState.projectId).toBe(project.id);
    expect(state.saveState.savedRevision).toBe(project.revision + 1);
  });

  it('rapidSemanticChangesSaveLatestRevision：R10→R11→R12 防抖合并，落库只有最新修订', async () => {
    await useVisualProjectStore.getState().createFromAnalysis(analysisInput());
    const callsAfterCreate = saveMock.mock.calls.length;
    // 防抖窗口内连续三次语义修订（spec §47：saving 中改 R11/R12，DB 必须最终保存最新）
    for (const text of ['R10 修改', 'R11 修改', 'R12 修改']) {
      useVisualProjectStore.getState().updateActive('free_text', draft => ({
        ...draft,
        modification: { ...draft.modification, freeText: text },
      }));
    }
    expect(saveMock.mock.calls.length).toBe(callsAfterCreate); // 全部还在同一防抖窗口
    await useVisualProjectStore.getState().flushPersist();
    // 防抖窗口只触发一次落库，且载荷 = 最新修订 R12（旧修订绝不回写覆盖）
    expect(saveMock.mock.calls.length).toBe(callsAfterCreate + 1);
    const payload = saveMock.mock.calls[saveMock.mock.calls.length - 1][0];
    expect(payload.dataJson).toContain('R12 修改');
    expect(payload.dataJson).not.toContain('R10 修改');
    const state = useVisualProjectStore.getState();
    expect(state.saveState.savedRevision).toBe(state.active?.revision);
  });

  it('saveFailureKeepsDirtyAndRetryRecovers：失败保 dirty → retrySave 回 saved', async () => {
    const project = await useVisualProjectStore.getState().createFromAnalysis(analysisInput());
    saveMock.mockRejectedValueOnce(new Error('disk full'));
    useVisualProjectStore.getState().updateActive('free_text', draft => ({
      ...draft,
      modification: { ...draft.modification, freeText: '再改一处' },
    }));
    await useVisualProjectStore.getState().flushPersist();
    const failed = useVisualProjectStore.getState();
    expect(failed.saveState.status).toBe('error');
    expect(failed.saveState.error).toContain('disk full');
    expect(failed.lastError).toContain('disk full');
    // 失败绝不清空内存文档（dirty 保留）
    expect(failed.active?.modification.freeText).toBe('再改一处');
    // 重试成功 → saved
    await useVisualProjectStore.getState().retrySave();
    const recovered = useVisualProjectStore.getState();
    expect(recovered.saveState.status).toBe('saved');
    expect(recovered.saveState.projectId).toBe(project.id);
  });

  it('saveStateIsIsolatedByProject：切项目后旧状态立即失效', async () => {
    const projectA = await useVisualProjectStore.getState().createFromAnalysis(analysisInput('A'));
    expect(useVisualProjectStore.getState().saveState.projectId).toBe(projectA.id);
    // 手动切换 active（模拟 openProject 完成后的状态切换）
    useVisualProjectStore.setState({ active: { ...projectA, id: 'project-b', name: 'B' } });
    // 旧 projectId 状态不再指向当前项目 —— UI（ProjectHeaderBar）按 projectId 忽略
    expect(useVisualProjectStore.getState().saveState.projectId).not.toBe('project-b');
  });

  it('openProjectFlushesPreviousProjectDebounce：打开新项目前先冲刷旧项目在途防抖', async () => {
    const projectA = await useVisualProjectStore.getState().createFromAnalysis(analysisInput('A'));
    const callsAfterCreate = saveMock.mock.calls.length;
    // A 有一次未冲刷的防抖保存
    useVisualProjectStore.getState().updateActive('free_text', draft => ({
      ...draft,
      modification: { ...draft.modification, freeText: '最后一步修改' },
    }));
    expect(saveMock.mock.calls.length).toBe(callsAfterCreate); // 还在防抖窗口内
    // 把 A 的最新文档作为磁盘内容读回（模拟磁盘已有该项目）
    const savedJson = JSON.stringify(useVisualProjectStore.getState().active);
    (api.loadVisualProject as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(savedJson);
    await useVisualProjectStore.getState().openProject(projectA.id);
    // openProject 第一步 = flushPersist：防抖中的最后一步修改必须已落库
    const lastPayload = saveMock.mock.calls[saveMock.mock.calls.length - 1][0];
    expect(lastPayload.dataJson).toContain('最后一步修改');
  });

  it('headerWiringUsesSaveStateNotListLoading：保存指示不得错接列表 loading', async () => {
    const pageSrc = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../../pages/VisionUnderstanding.tsx', import.meta.url), 'utf8'));
    expect(pageSrc).not.toContain('saving={projectStore.listLoading}');
    expect(pageSrc).toContain('saveState={projectStore.saveState}');
    expect(pageSrc).toContain('onRetrySave');
    // Header：按 projectId 隔离展示 + error 态内联重试
    const headerSrc = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../../features/vision/project/ProjectHeaderBar.tsx', import.meta.url), 'utf8'));
    expect(headerSrc).toContain('saveState.projectId === project?.id');
    expect(headerSrc).toContain('自动保存失败');
    expect(headerSrc).toContain('已自动保存');
  });
});
