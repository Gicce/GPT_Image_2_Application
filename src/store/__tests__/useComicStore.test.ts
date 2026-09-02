/**
 * AI 漫画 Store（Phase 2 持久化回归锚点）：
 *  - 项目创建即冻结 Skill / 角色快照（验收 M：改库不回写历史项目）；
 *  - 落库项目重启后可见（Rust 真实 SQL 由 cargo production_list_sqls_prepare_and_execute 锚定）；
 *  - 打开项目 = normalize 恢复，文档损坏（缺 skillSnapshot）不炸、走 lastError；
 *  - 语义更新经防抖落库，flushPersist 冲刷；
 *  - 删除墓碑防行复活；Skill 保存 +version；角色文档无效不入库。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../services/api', () => ({
  api: {
    listComicProjects: vi.fn(async () => [] as unknown[]),
    loadComicProject: vi.fn(async (_id: string) => null as string | null),
    saveComicProject: vi.fn(async () => {}),
    renameComicProject: vi.fn(async () => {}),
    deleteComicProject: vi.fn(async () => {}),
    listComicSkills: vi.fn(async () => [] as unknown[]),
    loadComicSkill: vi.fn(async (_id: string) => null as string | null),
    saveComicSkill: vi.fn(async () => {}),
    deleteComicSkill: vi.fn(async () => {}),
    listComicCharacters: vi.fn(async () => [] as unknown[]),
    loadComicCharacter: vi.fn(async (_id: string) => null as string | null),
    saveComicCharacter: vi.fn(async () => {}),
    deleteComicCharacter: vi.fn(async () => {}),
  },
}));

import { api } from '../../services/api';
import { useComicStore } from '../useComicStore';
import { normalizeComicCharacter, normalizeComicSkill } from '../../features/comic/normalize';
import type { ComicCharacter, ComicSkill } from '../../features/comic/types';

const saveProjectMock = api.saveComicProject as unknown as ReturnType<typeof vi.fn>;
const loadProjectMock = api.loadComicProject as unknown as ReturnType<typeof vi.fn>;
const listProjectsMock = api.listComicProjects as unknown as ReturnType<typeof vi.fn>;
const deleteProjectMock = api.deleteComicProject as unknown as ReturnType<typeof vi.fn>;
const saveSkillMock = api.saveComicSkill as unknown as ReturnType<typeof vi.fn>;
const saveCharacterMock = api.saveComicCharacter as unknown as ReturnType<typeof vi.fn>;

function makeSkill(): ComicSkill {
  return normalizeComicSkill({
    id: 'skill-1',
    name: '职场吐槽四格',
    comicForm: '四格漫画',
    version: 3,
    characterSlots: [
      { slotId: 'hero', name: '主角', required: true },
      { slotId: 'reporter', name: '记者', required: false },
    ],
  });
}

function makeCharacter(): ComicCharacter {
  return normalizeComicCharacter({
    id: 'char-1', name: '汤圆', status: 'confirmed', immutableTraits: ['黄白毛色'],
  }) as ComicCharacter;
}

function resetStore() {
  useComicStore.setState({
    projects: [], skills: [], characters: [],
    active: null, lastError: '', listLoading: false,
    saveState: { status: 'idle', projectId: null },
  });
}

function savedProjectDocs(): Array<Record<string, unknown>> {
  return saveProjectMock.mock.calls.map(call => call[0] as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe('createProject：创建即冻结快照（验收 M）', () => {
  it('事后改 Skill 库不回写已建项目', async () => {
    const skill = makeSkill();
    const character = makeCharacter();
    const project = await useComicStore.getState().createProject({
      name: '第一期',
      skill,
      characters: [character],
      bindings: { hero: character.id },
      skillId: skill.id,
    });
    expect(project.stage).toBe('skill_draft');
    expect(project.skillSnapshot).toEqual(skill);
    expect(project.characterSnapshots).toHaveLength(1);

    // 用户随后改库（Skill 更名 + 版本推进；角色改描述）
    skill.name = '改了名字的 Skill';
    character.description = '改了描述';

    const active = useComicStore.getState().active!;
    expect(active.skillSnapshot.name).toBe('职场吐槽四格');
    expect(active.characterSnapshots[0]!.description).toBe('');

    const saved = savedProjectDocs().find(call => call.id === project.id)!;
    const doc = JSON.parse(saved.dataJson as string);
    expect(doc.skillSnapshot.name).toBe('职场吐槽四格');
    expect(saved.stage).toBe('skill_draft');
    expect(saved.skillId).toBe('skill-1');
  });

  it('快照与源深隔离：改快照不污染源对象', async () => {
    const skill = makeSkill();
    await useComicStore.getState().createProject({ name: 'x', skill });
    const snapshot = useComicStore.getState().active!.skillSnapshot;
    snapshot.characterSlots[0].name = '被污染？';
    expect(skill.characterSlots[0].name).toBe('主角');
  });
});

describe('项目恢复（重启可见）', () => {
  it('savedProjectAppearsAfterRestart：落库 → 重启（store 复位）→ refreshLists 可见', async () => {
    const project = await useComicStore.getState().createProject({ name: '第一期', skill: makeSkill() });
    const firstSave = savedProjectDocs().find(call => call.id === project.id)!;
    resetStore();
    listProjectsMock.mockResolvedValueOnce([{
      id: firstSave.id, name: firstSave.name, stage: firstSave.stage,
      skillId: null, updatedAt: '2026-08-30T00:00:00Z', lastOpenedAt: '2026-08-30T01:00:00Z',
    }]);
    await useComicStore.getState().refreshLists();
    const state = useComicStore.getState();
    expect(state.lastError).toBe('');
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0]!.id).toBe(project.id);
  });

  it('listFailureSurfacesError：读取失败 → lastError 非空（不伪装成空库）', async () => {
    listProjectsMock.mockRejectedValueOnce(new Error('db locked'));
    await useComicStore.getState().refreshLists();
    expect(useComicStore.getState().lastError).not.toBe('');
  });

  it('openProjectRestoresNormalizedDoc：打开 = normalize 恢复 + 立即落库 lastOpenedAt', async () => {
    const project = await useComicStore.getState().createProject({ name: '第一期', skill: makeSkill() });
    loadProjectMock.mockResolvedValueOnce(JSON.stringify(project));
    saveProjectMock.mockClear();
    resetStore();
    const opened = await useComicStore.getState().openProject(project.id);
    expect(opened).not.toBeNull();
    expect(opened!.skillSnapshot.name).toBe('职场吐槽四格');
    expect(useComicStore.getState().active?.id).toBe(project.id);
    expect(saveProjectMock).toHaveBeenCalledTimes(1);
  });

  it('openProjectPersistsRawDocNotNormalized：V4.2.13 §14/§15 打开只刷新 lastOpenedAt，原文回写（migration 结果不落库）', async () => {
    // 旧 schema 文档：对白带百分比位置（42/30）+ px 尺寸（320/180）——normalize 会迁移，
    // 但打开Project 不得把迁移结果写回 DB（用户编辑 save 时才落 geometry contract）
    const legacyRaw = JSON.stringify({
      id: 'legacy-1',
      name: '鸭梨山大 · 第一期',
      stage: 'completed',
      skillSnapshot: makeSkill(),
      panels: [{ id: 'panel-0', order: 0, scene: '开场' }],
      dialogues: [{
        id: 'dlg-legacy', panelId: 'panel-0', speakerId: 'narrator', type: 'speech',
        text: '旧对白', position: { x: 42, y: 30 }, alignment: 'center',
        fontStyle: { size: 16, weight: 500 }, bubbleStyle: 'rounded',
        size: { width: 320, height: 180 },
      }],
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    });
    loadProjectMock.mockResolvedValueOnce(legacyRaw);
    const opened = await useComicStore.getState().openProject('legacy-1');
    expect(opened).not.toBeNull();
    // 内存态 = 迁移后几何（百分比 → 0.42/0.3；px size 丢弃回自适应）
    expect(opened!.dialogues[0]!.position).toEqual({ x: 0.42, y: 0.3 });
    expect(opened!.dialogues[0]!.size).toBeUndefined();
    // 落库 = 原文 JSON（byte 级不回写迁移结果）
    expect(saveProjectMock).toHaveBeenCalledTimes(1);
    expect((saveProjectMock.mock.calls[0]![0] as Record<string, unknown>).dataJson).toBe(legacyRaw);
  });

  it('openProjectRejectsBrokenDoc：缺 skillSnapshot → null + lastError（文档损坏不炸）', async () => {
    loadProjectMock.mockResolvedValueOnce(JSON.stringify({ id: 'p', name: '坏文档' }));
    const opened = await useComicStore.getState().openProject('p');
    expect(opened).toBeNull();
    expect(useComicStore.getState().lastError).toContain('损坏');
  });

  it('openProjectMissingReturnsNull：行不存在 → null + lastError', async () => {
    loadProjectMock.mockResolvedValueOnce(null);
    expect(await useComicStore.getState().openProject('ghost')).toBeNull();
    expect(useComicStore.getState().lastError).not.toBe('');
  });
});

describe('updateActive：语义更新唯一入口', () => {
  it('mutate 后防抖落库，flushPersist 冲刷同一文档', async () => {
    await useComicStore.getState().createProject({ name: '第一期', skill: makeSkill() });
    saveProjectMock.mockClear();
    useComicStore.getState().updateActive(draft => ({ ...draft, stage: 'character_confirmation' }));
    expect(useComicStore.getState().active?.stage).toBe('character_confirmation');
    expect(useComicStore.getState().active?.updatedAt).toBeTruthy();
    await useComicStore.getState().flushPersist();
    const docs = savedProjectDocs();
    expect(docs).toHaveLength(1);
    expect(JSON.parse(docs[0]!.dataJson as string).stage).toBe('character_confirmation');
  });

  it('无 active 时 updateActive 静默无操作', () => {
    expect(() => useComicStore.getState().updateActive(draft => draft)).not.toThrow();
    expect(saveProjectMock).not.toHaveBeenCalled();
  });
});

describe('删除墓碑（防行复活）', () => {
  it('deleteProject 后刷新列表被墓碑过滤；api 失败回滚墓碑并报错', async () => {
    const project = await useComicStore.getState().createProject({ name: '第一期', skill: makeSkill() });
    await useComicStore.getState().deleteProject(project.id);
    expect(deleteProjectMock).toHaveBeenCalledWith(project.id);
    expect(useComicStore.getState().active).toBeNull();

    // 假设 SQLite 行删除延迟可见（upsert 复活场景）：列表仍返回该行 → 必须被墓碑过滤
    listProjectsMock.mockResolvedValueOnce([{
      id: project.id, name: '第一期', stage: 'skill_draft',
      skillId: null, updatedAt: '2026-08-30T00:00:00Z', lastOpenedAt: null,
    }]);
    await useComicStore.getState().refreshLists();
    expect(useComicStore.getState().projects).toHaveLength(0);

    // 失败路径：墓碑回滚 + lastError
    deleteProjectMock.mockRejectedValueOnce(new Error('locked'));
    await useComicStore.getState().deleteProject('p2');
    expect(useComicStore.getState().lastError).not.toBe('');
  });
});

describe('Skill 库 / 角色库', () => {
  it('saveSkill 版本 +1，ai_draft 落库标记 user_saved', async () => {
    const skill = makeSkill();
    await useComicStore.getState().saveSkill(skill);
    expect(saveSkillMock).toHaveBeenCalledTimes(1);
    const call = saveSkillMock.mock.calls[0]![0];
    expect(call.version).toBe(4);
    expect(call.source).toBe('user_saved');
    expect(useComicStore.getState().skills[0]!.version).toBe(4);
  });

  it('saveCharacter 无名角色拒绝入库（文档级校验前置）', async () => {
    const broken = { id: 'c', name: '', description: '' } as ComicCharacter;
    await useComicStore.getState().saveCharacter(broken);
    expect(saveCharacterMock).not.toHaveBeenCalled();
    expect(useComicStore.getState().lastError).not.toBe('');
  });

  it('saveCharacter 正常入库并刷新列表', async () => {
    const ok = await useComicStore.getState().saveCharacter(makeCharacter());
    expect(ok).toBe(true);
    expect(saveCharacterMock).toHaveBeenCalledTimes(1);
    const call = saveCharacterMock.mock.calls[0]![0];
    expect(call.name).toBe('汤圆');
    expect(useComicStore.getState().characters).toHaveLength(1);
  });

  it('saveCharacter 失败返回 false（§27 锁定即入库的 toast 需要结果信号）', async () => {
    saveCharacterMock.mockRejectedValueOnce(new Error('db down'));
    const ok = await useComicStore.getState().saveCharacter(makeCharacter());
    expect(ok).toBe(false);
    expect(useComicStore.getState().lastError).toContain('db down');
  });

  it('saveCharacter 摘要带 §18/§24 富化列（usageCount / lastUsedAt / 缩略路径）', async () => {
    await useComicStore.getState().saveCharacter(normalizeComicCharacter({
      id: 'char-9', name: '小黄鸭', usageCount: 4, lastUsedAt: '2026-08-30T08:00:00.000Z',
      referenceImage: { path: '/refs/duck.png', label: '小黄鸭' },
    }) as ComicCharacter);
    const summary = useComicStore.getState().characters[0]!;
    expect(summary.usageCount).toBe(4);
    expect(summary.lastUsedAt).toBe('2026-08-30T08:00:00.000Z');
    expect(summary.thumbnailPath).toBe('/refs/duck.png');
  });

  it('recordCharacterUsage：库文档 +1 计数 / 刷新 lastUsedAt（§18 引用即计数）', async () => {
    const loadMock = api.loadComicCharacter as unknown as ReturnType<typeof vi.fn>;
    loadMock.mockResolvedValueOnce(JSON.stringify({
      id: 'char-7', name: '汤圆', usageCount: 2, lastUsedAt: '2026-08-01T00:00:00.000Z',
    }));
    await useComicStore.getState().recordCharacterUsage('char-7');
    expect(saveCharacterMock).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(saveCharacterMock.mock.calls[0]![0].dataJson as string);
    expect(saved.usageCount).toBe(3);
    expect(saved.lastUsedAt > '2026-08-01T00:00:00.000Z').toBe(true);
    const summary = useComicStore.getState().characters[0]!;
    expect(summary.usageCount).toBe(3);
  });

  it('recordCharacterUsage：库条目不存在 / 已删除 → 不写不炸（计数是元数据不是门禁）', async () => {
    await useComicStore.getState().recordCharacterUsage('ghost');
    expect(saveCharacterMock).not.toHaveBeenCalled();
  });

  it('renameActive 空名 / 同名不触发重命名', async () => {
    await useComicStore.getState().createProject({ name: '第一期', skill: makeSkill() });
    await useComicStore.getState().renameActive('   ');
    await useComicStore.getState().renameActive('第一期');
    expect(api.renameComicProject).not.toHaveBeenCalled();
  });
});
