/**
 * AI 漫画 Store（Phase 2）—— 漫画工作台状态唯一载体（useVisualProjectStore 同族）。
 *
 * 职责：
 *  - 三库列表与文档：comic_projects（本期项目）/ comic_skills（Skill 库）/ comic_characters（演员库）；
 *  - active 项目 = load data_json + normalizeComicProject 恢复，**绝不调用 LLM / 生图 API**
 *    （打开项目只读本地持久化数据，与视觉项目同一铁律）；
 *  - 语义修改经 updateActive（mutate 返回新文档）→ 600ms 防抖落库；
 *  - 删除墓碑：deleteProject 后在途 / 防抖落库不得把项目 save 回库（防行复活）；
 *  - Skill 库保存 +version（项目内冻结的是快照，改库不回写历史项目——快照语义在
 *    createComicProject 时刻定死）。
 */

import { create } from 'zustand';
import { api } from '../services/api';
import {
  bumpComicCharacterUsage,
  createCharacterSnapshot,
  createSkillSnapshot,
} from '../features/comic/domain';
import {
  newComicId,
  normalizeComicCharacter,
  normalizeComicProject,
  normalizeComicSkill,
} from '../features/comic/normalize';
import type {
  ComicCharacter,
  ComicPresentationSource,
  ComicProject,
  ComicSkill,
  ComicStory,
} from '../features/comic/types';

const PERSIST_DEBOUNCE_MS = 600;

export interface ComicProjectSummary {
  id: string;
  name: string;
  stage: string;
  skillId?: string | null;
  updatedAt: string;
  lastOpenedAt?: string | null;
}

export interface ComicSkillSummary {
  id: string;
  name: string;
  comicForm: string;
  version: number;
  source: string;
  updatedAt: string;
}

export interface ComicCharacterSummary {
  id: string;
  name: string;
  role: string;
  status: string;
  source: string;
  updatedAt: string;
  /** Phase 1.2-E（§18/§24）：库摘要富化列（Rust json_extract data_json），空值回退 0 / 行 updated_at / ''。 */
  usageCount: number;
  lastUsedAt: string;
  thumbnailPath: string;
}

export interface ComicSaveState {
  status: 'idle' | 'pending' | 'saving' | 'saved' | 'error';
  projectId: string | null;
  savedAt?: string;
  error?: string;
}

export interface ComicState {
  projects: ComicProjectSummary[];
  skills: ComicSkillSummary[];
  characters: ComicCharacterSummary[];
  active: ComicProject | null;
  lastError: string;
  listLoading: boolean;
  saveState: ComicSaveState;
  refreshLists: () => Promise<void>;
  /** 打开项目（本地恢复；缺失 / 文档损坏返回 null 并写 lastError）。 */
  openProject: (id: string) => Promise<ComicProject | null>;
  closeProject: () => void;
  /**
   * 从（可能未落库的）Skill 草稿创建项目：冻结 Skill 与角色快照。
   * V4.2.7：携带推荐方案的故事草稿时，种子进 uiDraft.story（phase=review）——
   * 用户落地 Step 1「本期故事」即看到完整故事审定，不必重新描述刚选中的故事。
   */
  createProject: (input: {
    name: string;
    skill: ComicSkill;
    characters?: ComicCharacter[];
    bindings?: Record<string, string>;
    skillId?: string;
    storyDraft?: ComicStory;
    requirement?: string;
    /** V4.2.8 §49~§57：user_fixed = 用户指定形式，后续对话式微调不得改排版。 */
    presentationSource?: ComicPresentationSource;
  }) => Promise<ComicProject>;
  /** 语义更新唯一入口（mutate 返回新文档；updatedAt 由本入口刷新）。 */
  updateActive: (mutate: (draft: ComicProject) => ComicProject) => void;
  renameActive: (name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  flushPersist: () => Promise<void>;
  retrySave: () => Promise<void>;
  /** Skill 库：保存（version +1）/ 删除。 */
  saveSkill: (skill: ComicSkill) => Promise<void>;
  deleteSkill: (id: string) => Promise<void>;
  /** 演员库：保存（已存在则覆盖）；返回是否成功（§27 锁定即入库的 toast 需要结果信号）。 */
  saveCharacter: (character: ComicCharacter) => Promise<boolean>;
  /** 演员库：被项目引用时 +1 使用计数 / 刷新 lastUsedAt（§18 引用即计数）。 */
  recordCharacterUsage: (id: string) => Promise<void>;
  deleteCharacter: (id: string) => Promise<void>;
}

/** 删除墓碑（会话级）：已删除行 id；在途 / 防抖落库不得复活。 */
const deletedProjectIds = new Set<string>();
const deletedSkillIds = new Set<string>();
const deletedCharacterIds = new Set<string>();

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistInFlight: Promise<void> | null = null;

function serialize(project: ComicProject): string {
  return JSON.stringify(project);
}

/** 只对「仍是当前项目」的保存写状态（非 active 落库不污染保存指示）。 */
function setSaveStateFor(projectId: string, patch: Partial<ComicSaveState> & { status: ComicSaveState['status'] }): void {
  if (useComicStore.getState().active?.id !== projectId) return;
  useComicStore.setState(state => ({ saveState: { ...state.saveState, ...patch, projectId } }));
}

async function persistProject(
  project: ComicProject,
  immediate = false,
  /** 覆写落库文档（V4.2.13 §14/§15：打开项目只刷新 lastOpenedAt，原文回写，不落 normalize/migration 结果）。 */
  overrideDataJson?: string,
): Promise<void> {
  if (deletedProjectIds.has(project.id)) return;
  const run = async () => {
    if (deletedProjectIds.has(project.id)) return;
    setSaveStateFor(project.id, { status: 'saving', error: undefined });
    try {
      await api.saveComicProject({
        id: project.id,
        name: project.name,
        stage: project.stage,
        skillId: project.skillId ?? null,
        dataJson: overrideDataJson ?? serialize(project),
        lastOpenedAt: new Date().toISOString(),
      });
      useComicStore.setState(state => ({
        lastError: '',
        projects: [
          {
            id: project.id,
            name: project.name,
            stage: project.stage,
            skillId: project.skillId ?? null,
            updatedAt: project.updatedAt,
            lastOpenedAt: new Date().toISOString(),
          },
          ...state.projects.filter(item => item.id !== project.id),
        ],
      }));
      if (!persistTimer) {
        setSaveStateFor(project.id, { status: 'saved', savedAt: new Date().toISOString() });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '漫画项目保存失败。';
      useComicStore.setState({ lastError: message });
      setSaveStateFor(project.id, { status: 'error', error: message });
    }
  };
  if (immediate) {
    if (persistInFlight) await persistInFlight;
    persistInFlight = run();
    await persistInFlight;
    persistInFlight = null;
    return;
  }
  if (persistTimer) clearTimeout(persistTimer);
  setSaveStateFor(project.id, { status: 'pending' });
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const current = useComicStore.getState().active;
    if (current) void persistProject(current, true);
  }, PERSIST_DEBOUNCE_MS);
}

export const useComicStore = create<ComicState>((set, get) => ({
  projects: [],
  skills: [],
  characters: [],
  active: null,
  lastError: '',
  listLoading: false,
  saveState: { status: 'idle', projectId: null },

  refreshLists: async () => {
    set({ listLoading: true });
    try {
      const [projects, skills, characters] = await Promise.all([
        api.listComicProjects(),
        api.listComicSkills(),
        api.listComicCharacters(),
      ]);
      set({
        projects: projects.filter(item => !deletedProjectIds.has(item.id)),
        skills: skills.filter(item => !deletedSkillIds.has(item.id)),
        characters: characters.filter(item => !deletedCharacterIds.has(item.id)),
        listLoading: false,
        lastError: '',
      });
    } catch (error) {
      set({
        listLoading: false,
        lastError: error instanceof Error ? error.message : '漫画数据读取失败。',
      });
    }
  },

  openProject: async id => {
    try {
      await get().flushPersist();
      const raw = await api.loadComicProject(id);
      if (!raw) {
        set({ lastError: '漫画项目不存在或已被删除。' });
        return null;
      }
      const parsed = normalizeComicProject(JSON.parse(raw) as ComicProject);
      if (!parsed) {
        set({ lastError: '漫画项目文档已损坏，无法打开。' });
        return null;
      }
      const opened: ComicProject = parsed;
      set({ active: opened, lastError: '' });
      // V4.2.13 §14/§15：打开 ≠ 保存——只刷新 lastOpenedAt（原文 JSON 回写），
      // normalize / 几何 migration 结果仅存在于内存，用户真正编辑（updateActive）
      // 后才落库为当前 geometry contract。
      void persistProject(opened, true, raw);
      return opened;
    } catch (error) {
      set({ lastError: error instanceof Error ? error.message : '漫画项目打开失败。' });
      return null;
    }
  },

  closeProject: () => {
    set({ active: null });
  },

  createProject: async ({ name, skill, characters = [], bindings = {}, skillId, storyDraft, requirement, presentationSource }) => {
    const now = new Date().toISOString();
    const project: ComicProject = {
      id: newComicId('project'),
      name: name.trim() || `${skill.name} · 新一期`,
      stage: 'skill_draft',
      // 规格铁律：项目冻结 Skill / 角色快照，改库不回写历史项目
      skillSnapshot: createSkillSnapshot(skill),
      characterSnapshots: characters.map(createCharacterSnapshot),
      characterBindings: { ...bindings },
      panels: [],
      dialogues: [],
      uiDraft: storyDraft
        ? { story: { requirement: requirement?.trim() || undefined, storyDraft, phase: 'review' } }
        : undefined,
      createdAt: now,
      updatedAt: now,
      skillId,
      presentationSource,
    };
    set({ active: project, lastError: '' });
    await persistProject(project, true);
    return project;
  },

  updateActive: mutate => {
    const current = get().active;
    if (!current) return;
    const next = { ...mutate(current), updatedAt: new Date().toISOString() };
    set({ active: next });
    void persistProject(next);
  },

  renameActive: async name => {
    const current = get().active;
    if (!current) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === current.name) return;
    const next = { ...current, name: trimmed };
    set({ active: next });
    try {
      await api.renameComicProject(current.id, trimmed);
      set(state => ({
        projects: state.projects.map(item => (item.id === current.id ? { ...item, name: trimmed } : item)),
      }));
    } catch (error) {
      set({ lastError: error instanceof Error ? error.message : '重命名失败。' });
    }
    void persistProject(next);
  },

  deleteProject: async id => {
    await get().flushPersist();
    deletedProjectIds.add(id);
    try {
      await api.deleteComicProject(id);
      set(state => ({
        projects: state.projects.filter(item => item.id !== id),
        active: state.active?.id === id ? null : state.active,
        lastError: '',
      }));
    } catch (error) {
      deletedProjectIds.delete(id);
      set({ lastError: error instanceof Error ? error.message : '漫画项目删除失败。' });
    }
  },

  flushPersist: async () => {
    if (persistInFlight) await persistInFlight.catch(() => undefined);
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
      const current = get().active;
      if (current) await persistProject(current, true);
    }
  },

  retrySave: async () => {
    const current = get().active;
    if (!current) return;
    await persistProject(current, true);
  },

  saveSkill: async skill => {
    deletedSkillIds.delete(skill.id);
    try {
      const next: ComicSkill = { ...skill, version: skill.version + 1, updatedAt: new Date().toISOString() };
      await api.saveComicSkill({
        id: next.id,
        name: next.name,
        comicForm: next.comicForm,
        version: next.version,
        source: next.source === 'ai_draft' ? 'user_saved' : next.source,
        dataJson: JSON.stringify(normalizeComicSkill(next)),
      });
      set(state => ({
        lastError: '',
        skills: [
          {
            id: next.id, name: next.name, comicForm: next.comicForm, version: next.version,
            source: next.source, updatedAt: next.updatedAt,
          },
          ...state.skills.filter(item => item.id !== next.id),
        ],
      }));
    } catch (error) {
      set({ lastError: error instanceof Error ? error.message : '漫画 Skill 保存失败。' });
    }
  },

  deleteSkill: async id => {
    deletedSkillIds.add(id);
    try {
      await api.deleteComicSkill(id);
      set(state => ({ skills: state.skills.filter(item => item.id !== id), lastError: '' }));
    } catch (error) {
      deletedSkillIds.delete(id);
      set({ lastError: error instanceof Error ? error.message : '漫画 Skill 删除失败。' });
    }
  },

  saveCharacter: async character => {
    deletedCharacterIds.delete(character.id);
    try {
      const next = normalizeComicCharacter(character);
      if (!next) {
        set({ lastError: '角色文档无效（缺少名字）。' });
        return false;
      }
      const stamped: ComicCharacter = { ...next, updatedAt: new Date().toISOString() };
      await api.saveComicCharacter({
        id: stamped.id,
        name: stamped.name,
        role: stamped.role,
        status: stamped.status,
        source: stamped.source,
        dataJson: JSON.stringify(stamped),
      });
      set(state => ({
        lastError: '',
        characters: [
          {
            id: stamped.id, name: stamped.name, role: stamped.role,
            status: stamped.status, source: stamped.source, updatedAt: stamped.updatedAt,
            usageCount: stamped.usageCount ?? 0,
            lastUsedAt: stamped.lastUsedAt ?? stamped.updatedAt,
            thumbnailPath: stamped.referenceImage?.path ?? '',
          },
          ...state.characters.filter(item => item.id !== stamped.id),
        ],
      }));
      return true;
    } catch (error) {
      set({ lastError: error instanceof Error ? error.message : '角色保存失败。' });
      return false;
    }
  },

  recordCharacterUsage: async id => {
    try {
      if (deletedCharacterIds.has(id)) return;
      const raw = await api.loadComicCharacter(id);
      if (!raw || deletedCharacterIds.has(id)) return;
      const parsed = normalizeComicCharacter(JSON.parse(raw));
      if (!parsed) return;
      await get().saveCharacter(bumpComicCharacterUsage(parsed));
    } catch (error) {
      // 计数失败不阻断选角主流程（§18 是元数据，不是门禁）
      set({ lastError: error instanceof Error ? error.message : '演员使用计数更新失败。' });
    }
  },

  deleteCharacter: async id => {
    deletedCharacterIds.add(id);
    try {
      await api.deleteComicCharacter(id);
      set(state => ({ characters: state.characters.filter(item => item.id !== id), lastError: '' }));
    } catch (error) {
      deletedCharacterIds.delete(id);
      set({ lastError: error instanceof Error ? error.message : '角色删除失败。' });
    }
  },
}));
