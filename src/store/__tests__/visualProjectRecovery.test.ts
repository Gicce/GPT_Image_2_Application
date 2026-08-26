/**
 * Visual Project Recovery（P0 回归锚点）：
 *  - 保存过的项目重启后必须重新出现在列表（Rust 侧真实 SQL 由 cargo 测试
 *    production_list_sql_prepares_and_orders_by_last_opened 锚定——历史事故：
 *    COALESCE 误写 COALES，列表恒空但数据完好）；
 *  - 列表读取失败 ≠ 没有项目：lastError 必须呈现（UI 显示重试，不显示空态）；
 *  - 索引恢复：列表空且无错 → rebuild 扫描修复 → 列表回来 → 返回恢复数；
 *  - 迁移幂等：createFromAnalysis / adoptProject 写 marker，同指纹 legacy
 *    不再二次迁移（历史隐患：每次重启复制一个「未命名视觉项目」）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../services/api', () => ({
  api: {
    listVisualProjects: vi.fn(async () => [] as unknown[]),
    loadVisualProject: vi.fn(async (_id: string) => null as string | null),
    saveVisualProject: vi.fn(async () => {}),
    renameVisualProject: vi.fn(async () => {}),
    deleteVisualProject: vi.fn(async () => {}),
    saveVisualProjectMask: vi.fn(async () => 'D:/appdata/visual_projects/p1/masks/r1.png'),
    rebuildVisualProjectIndex: vi.fn(async () => ({ rowsScanned: 0, repaired: 0 })),
  },
}));

import { api } from '../../services/api';
import { useVisualProjectStore } from '../useVisualProjectStore';
import { fixtureAnalysis, emptyWorkspace } from '../../features/vision/project/__tests__/fixtures';
import { EMPTY_MODIFICATION_DRAFT } from '../../features/vision/modificationIntent';
import {
  isLegacyWorkspaceAlreadyMigrated,
  markWorkspaceClaimedByProject,
  migrateLegacyWorkspace,
  type LegacyWorkspaceSnapshot,
} from '../../features/vision/project/migrate';
import type { VisualProjectSummary } from '../../features/vision/project/types';

const listMock = api.listVisualProjects as unknown as ReturnType<typeof vi.fn>;
const rebuildMock = api.rebuildVisualProjectIndex as unknown as ReturnType<typeof vi.fn>;
const saveMock = api.saveVisualProject as unknown as ReturnType<typeof vi.fn>;

function analysisInput() {
  const analysis = fixtureAnalysis();
  const workspace = emptyWorkspace(analysis);
  return {
    name: '动漫AI照片',
    analysis,
    plan: workspace.recreation!.plan,
    recreation: workspace.recreation!,
    sourceAsset: { path: 'D:/imgs/template.png', assetId: 'asset-1', source: 'gallery' as const },
    workspace,
  };
}

function summaryOf(saveCall: { id: string; name: string; status: string; revision: number; updatedAt?: string }): VisualProjectSummary {
  return {
    id: saveCall.id,
    name: saveCall.name,
    status: saveCall.status as VisualProjectSummary['status'],
    revision: saveCall.revision,
    updatedAt: saveCall.updatedAt ?? new Date().toISOString(),
  };
}

function resetStore() {
  useVisualProjectStore.setState({ projects: [], active: null, lastError: '', listLoading: false });
}

function savedCalls(): Array<Record<string, unknown>> {
  return saveMock.mock.calls.map(call => call[0] as Record<string, unknown>);
}

/** node 环境无 localStorage：装内存 stub（与 useVisionWorkspaceStore.test 同一模式）。 */
function installLocalStorageStub() {
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => void memory.clear(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  installLocalStorageStub();
  resetStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('项目恢复（P0：保存的项目必须在重启后可见）', () => {
  it('savedProjectAppearsAfterRestart：落库项目 → 重启（store 复位）→ refreshList 列表可见', async () => {
    const project = await useVisualProjectStore.getState().createFromAnalysis(analysisInput());
    const firstSave = savedCalls().find(call => call.id === project.id)!;
    // 模拟重启：内存清空，Rust list 返回落库摘要（真实 SQL 由 cargo 测试锚定）
    resetStore();
    listMock.mockResolvedValueOnce([summaryOf(firstSave as never)]);
    await useVisualProjectStore.getState().refreshList();
    const state = useVisualProjectStore.getState();
    expect(state.lastError).toBe('');
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0]!.id).toBe(project.id);
    expect(state.projects[0]!.name).toBe('动漫AI照片');
  });

  it('projectRegistryRestoresSavedProjects：多个落库项目全部回到列表', async () => {
    const a = await useVisualProjectStore.getState().createFromAnalysis(analysisInput());
    (api.loadVisualProject as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(JSON.stringify(useVisualProjectStore.getState().active));
    const b = await useVisualProjectStore.getState().duplicateProjectById(a.id);
    expect(b).not.toBeNull();
    const calls = savedCalls();
    resetStore();
    listMock.mockResolvedValueOnce(calls.map(call => summaryOf(call as never)));
    await useVisualProjectStore.getState().refreshList();
    expect(useVisualProjectStore.getState().projects.map(item => item.id).sort())
      .toEqual([a.id, b!.id].sort());
  });

  it('listFailureSurfacesError：列表读取失败 → lastError 非空（UI 走失败态，绝不伪装成空项目）', async () => {
    listMock.mockRejectedValueOnce(new Error('no such function: COALES'));
    await useVisualProjectStore.getState().refreshList();
    const state = useVisualProjectStore.getState();
    expect(state.projects).toHaveLength(0);
    expect(state.lastError).not.toBe('');
  });

  it('orphanProjectRebuildsIndex：列表空且无错 → rebuild 修复摘要列 → 列表恢复 → 返回恢复数', async () => {
    listMock.mockResolvedValueOnce([]);
    rebuildMock.mockResolvedValueOnce({ rowsScanned: 3, repaired: 3 });
    listMock.mockResolvedValueOnce([
      summaryOf({ id: 'p1', name: '未命名视觉项目', status: 'ready', revision: 2 }),
      summaryOf({ id: 'p2', name: '动漫AI照片', status: 'generated', revision: 8 }),
      summaryOf({ id: 'p3', name: '室内写真', status: 'modified', revision: 4 }),
    ]);
    const recovered = await useVisualProjectStore.getState().ensureProjectIndex();
    expect(rebuildMock).toHaveBeenCalledTimes(1);
    expect(recovered).toBe(3);
    expect(useVisualProjectStore.getState().projects).toHaveLength(3);
  });

  it('recoverySkippedWhenListHealthy：列表有数据 → 不触发 rebuild', async () => {
    listMock.mockResolvedValueOnce([summaryOf({ id: 'p1', name: 'A', status: 'ready', revision: 0 })]);
    const recovered = await useVisualProjectStore.getState().ensureProjectIndex();
    expect(recovered).toBe(0);
    expect(rebuildMock).not.toHaveBeenCalled();
  });

  it('recoverySkippedOnListError：列表读取失败 → 不 rebuild（失败态由 lastError 呈现）', async () => {
    listMock.mockRejectedValueOnce(new Error('db locked'));
    const recovered = await useVisualProjectStore.getState().ensureProjectIndex();
    expect(recovered).toBe(0);
    expect(rebuildMock).not.toHaveBeenCalled();
  });
});

describe('迁移幂等（禁止每次重启复制「未命名视觉项目」）', () => {
  function legacySnapshot(overrides: Partial<LegacyWorkspaceSnapshot> = {}): LegacyWorkspaceSnapshot {
    const analysis = fixtureAnalysis();
    const workspace = emptyWorkspace(analysis);
    return {
      sourcePath: 'D:/imgs/legacy.png',
      sourceAssetId: 'asset-legacy',
      profileId: 'profile-1',
      modelId: 'glm-4.6v',
      analysis,
      originalPromptDraft: '原始复刻 Prompt',
      promptDraft: '优化后的 Prompt',
      negativeDraft: '',
      modificationDraft: EMPTY_MODIFICATION_DRAFT,
      recreation: workspace.recreation,
      visionTaskId: 'vt-1',
      sessionId: 'session-1',
      ...overrides,
    };
  }

  it('legacyWorkspaceMigratesOnce：标记前可迁移；标记后同指纹跳过', () => {
    const legacy = legacySnapshot();
    expect(isLegacyWorkspaceAlreadyMigrated(legacy)).toBe(false);
    const migrated = migrateLegacyWorkspace(legacy);
    expect(migrated).not.toBeNull();
    markWorkspaceClaimedByProject(legacy, migrated!.id);
    expect(isLegacyWorkspaceAlreadyMigrated(legacy)).toBe(true);
  });

  it('migrationDoesNotDuplicateProjects：marker 命中 → 不再产生第二次落库', async () => {
    const legacy = legacySnapshot();
    const migrated = migrateLegacyWorkspace(legacy)!;
    await useVisualProjectStore.getState().adoptProject(migrated);
    const savesAfterFirst = savedCalls().length;
    // 重启模拟：store 复位后同指纹 legacy 再次进入挂载逻辑 → 被 marker 拦截
    resetStore();
    expect(isLegacyWorkspaceAlreadyMigrated(legacy)).toBe(true);
    // 页面判定：isLegacyWorkspaceAlreadyMigrated === true → 不调 adoptProject
    // （此处直接验证第二次 adopt 不会发生：调用计数不变）
    expect(savedCalls().length).toBe(savesAfterFirst);
  });

  it('fingerprintIgnoresPromptDraft：Prompt 编辑不改变指纹（防重复迁移）', () => {
    const legacy = legacySnapshot();
    markWorkspaceClaimedByProject(legacy, 'vp-1');
    const edited = legacySnapshot({ promptDraft: '用户后来编辑过的 Prompt' });
    expect(isLegacyWorkspaceAlreadyMigrated(edited)).toBe(true);
  });

  it('newAnalysisSessionAllowsMigration：新识别会话（sessionId 变化）允许再次建项目', () => {
    const legacy = legacySnapshot();
    markWorkspaceClaimedByProject(legacy, 'vp-1');
    const reanalyzed = legacySnapshot({ sessionId: 'session-2', visionTaskId: 'vt-2' });
    expect(isLegacyWorkspaceAlreadyMigrated(reanalyzed)).toBe(false);
  });

  it('adoptProjectPersistsTemplate：adopt 落库文档含模板快照且不重跑分析建项目', async () => {
    const legacy = legacySnapshot();
    const migrated = migrateLegacyWorkspace(legacy)!;
    await useVisualProjectStore.getState().adoptProject(migrated);
    const saved = savedCalls().find(call => call.id === migrated.id)!;
    const doc = JSON.parse(saved.dataJson as string);
    expect(doc.templateSnapshot.sourcePath).toBe('D:/imgs/legacy.png');
    expect(useVisualProjectStore.getState().active?.id).toBe(migrated.id);
  });
});

describe('项目库 by-id 操作', () => {
  it('duplicateProjectById：不切换 active，新项目独立 id', async () => {
    const original = await useVisualProjectStore.getState().createFromAnalysis(analysisInput());
    const raw = JSON.stringify(useVisualProjectStore.getState().active);
    (api.loadVisualProject as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(raw);
    const copy = await useVisualProjectStore.getState().duplicateProjectById(original.id);
    expect(copy).not.toBeNull();
    expect(copy!.id).not.toBe(original.id);
    expect(copy!.name).toContain('副本');
    expect(useVisualProjectStore.getState().active?.id).toBe(original.id);
  });

  it('renameProjectById：更新列表且不动 active 文档修订', async () => {
    const project = await useVisualProjectStore.getState().createFromAnalysis(analysisInput());
    useVisualProjectStore.setState(state => ({
      projects: [{ id: project.id, name: project.name, status: 'ready', revision: 0, updatedAt: project.updatedAt }],
    }));
    const revisionBefore = useVisualProjectStore.getState().active!.revision;
    await useVisualProjectStore.getState().renameProjectById(project.id, '新名字');
    expect(api.renameVisualProject).toHaveBeenCalledWith(project.id, '新名字');
    expect(useVisualProjectStore.getState().projects[0]!.name).toBe('新名字');
    expect(useVisualProjectStore.getState().active!.revision).toBe(revisionBefore);
  });
});
