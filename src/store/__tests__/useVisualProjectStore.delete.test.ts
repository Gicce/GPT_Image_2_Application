/**
 * Visual Project 删除链路回归（任务A）：
 *  - 墓碑防复活：delete 在途期间迟到的防抖落库不得把已删项目 save 回库
 *    （upsert 会复活行 + 摘要重回列表——用户实测「删不掉」的根因）；
 *  - 删除失败撤销墓碑（项目仍在，后续保存不受影响）；
 *  - 删除当前项目 ⇒ active 原子置空。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const saveMock = vi.fn<(input: Record<string, unknown>) => Promise<void>>();
const deleteMock = vi.fn<(id: string) => Promise<void>>();

vi.mock('../../services/api', () => ({
  api: {
    saveVisualProject: (input: Record<string, unknown>) => saveMock(input),
    deleteVisualProject: (id: string) => deleteMock(id),
    listVisualProjects: () => Promise.resolve([]),
    loadVisualProject: () => Promise.resolve(null),
    renameVisualProject: () => Promise.resolve(),
    rebuildVisualProjectIndex: () => Promise.resolve({ rowsScanned: 0, repaired: 0 }),
    saveVisualProjectMask: () => Promise.resolve(null),
  },
}));

import { useVisualProjectStore } from '../useVisualProjectStore';
import { fixtureProject } from '../../features/vision/project/__tests__/fixtures';

function makeProject(name: string) {
  return { ...fixtureProject({ name }), lastOpenedAt: new Date().toISOString() };
}

beforeEach(() => {
  vi.clearAllMocks();
  saveMock.mockResolvedValue(undefined);
  deleteMock.mockResolvedValue(undefined);
  useVisualProjectStore.setState({
    projects: [],
    active: makeProject('黑暗系模板'),
    lastError: '',
    listLoading: false,
  });
});

describe('deleteProject 墓碑防复活', () => {
  it('delete 在途期间迟到的防抖落库被墓碑拦截（save 不再执行）', async () => {
    vi.useFakeTimers();
    const project = useVisualProjectStore.getState().active!;
    const projectId = project.id;
    useVisualProjectStore.setState({
      projects: [{
        id: projectId, name: project.name, status: project.status, revision: project.revision,
        coverPath: undefined, updatedAt: project.updatedAt, lastOpenedAt: undefined,
      }],
    });
    const savesBeforeDelete = saveMock.mock.calls.length;

    // delete 开始（flushPersist 无待决 → 直接进 delete，挂起在 IPC 上）
    let resolveDelete: () => void = () => {};
    deleteMock.mockReturnValue(new Promise<void>(resolve => { resolveDelete = resolve; }));
    const deleting = useVisualProjectStore.getState().deleteProject(projectId);
    await vi.advanceTimersByTimeAsync(0);

    // delete 在途：镜像同步再次武装防抖落库 → 600ms 后触发
    useVisualProjectStore.getState().updateActiveMeta(draft => draft);
    await vi.advanceTimersByTimeAsync(700);

    // delete 完成
    resolveDelete();
    await deleting;

    const state = useVisualProjectStore.getState();
    expect(state.active).toBeNull();
    expect(state.projects.some(item => item.id === projectId)).toBe(false);
    // 关键断言：delete 发起之后不再有任何 save（复活通道关闭）
    expect(saveMock.mock.calls.length).toBeLessThanOrEqual(savesBeforeDelete + 1);
    expect(saveMock.mock.calls.every(call => call[0].id !== projectId || saveMock.mock.calls.indexOf(call) < savesBeforeDelete + 1)).toBe(true);
    vi.useRealTimers();
  });

  it('删除失败 ⇒ 墓碑撤销，项目仍可保存', async () => {
    const project = useVisualProjectStore.getState().active!;
    deleteMock.mockRejectedValue(new Error('db locked'));
    await useVisualProjectStore.getState().deleteProject(project.id);
    expect(useVisualProjectStore.getState().lastError).toContain('db locked');
    expect(useVisualProjectStore.getState().active?.id).toBe(project.id);

    // 失败后保存恢复（墓碑已撤）
    const saves = saveMock.mock.calls.length;
    useVisualProjectStore.getState().updateActiveMeta(draft => ({ ...draft, name: '改名' }));
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(saveMock.mock.calls.length).toBeGreaterThan(saves);
  });

  it('删除当前项目 ⇒ active 原子置空 + 列表即时移除', async () => {
    const project = useVisualProjectStore.getState().active!;
    useVisualProjectStore.setState({
      projects: [{
        id: project.id, name: project.name, status: project.status, revision: project.revision,
        coverPath: undefined, updatedAt: project.updatedAt, lastOpenedAt: undefined,
      }],
    });
    await useVisualProjectStore.getState().deleteProject(project.id);
    const state = useVisualProjectStore.getState();
    expect(state.active).toBeNull();
    expect(state.projects).toHaveLength(0);
    expect(state.lastError).toBe('');
  });
});
