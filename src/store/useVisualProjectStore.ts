/**
 * Visual Project Store（V4.1 Workbench V2）—— 项目化视觉方案工作台状态唯一载体。
 *
 * 职责：
 *  - 项目列表（Rust `visual_projects` 表）与当前打开项目的完整文档（active）；
 *  - 打开项目 = load data_json + normalize，**绝不调用视觉分析 API**（恢复只读
 *    本地持久化数据，与 workspace store 同一铁律）；
 *  - 语义修改经 updateActive（revision 由领域函数裁决）→ 防抖落库；
 *    纯视图操作不进本 store（view state 在 useVisionViewStore / 组件局部）；
 *  - 与 useVisionWorkspaceStore 的镜像同步：项目打开时 hydrateWorkspaceInto
 *    （project → workspace），workspace 变化时 syncFromWorkspace（workspace →
 *    project.workspace），保证两侧永不失配；
 *  - 区域 mask 落盘（api.saveVisualProjectMask → region.maskPath 引用路径）。
 */

import { create } from 'zustand';
import { api } from '../services/api';
import { useVisionWorkspaceStore } from './useVisionWorkspaceStore';
import {
  deriveVisualProject,
  duplicateVisualProject,
  normalizeVisualProject,
  createVisualProjectFromAnalysis,
  type SemanticChangeReason,
} from '../features/vision/project/project';
import type {
  VisualProject,
  VisualProjectSummary,
} from '../features/vision/project/types';

const PERSIST_DEBOUNCE_MS = 600;

export interface VisualProjectState {
  projects: VisualProjectSummary[];
  active: VisualProject | null;
  /** 列表 / 落库最近一次错误（UI 横幅；空 = 无错）。 */
  lastError: string;
  listLoading: boolean;
  /** 立即落库（组件卸载 / 页面切换前冲刷防抖）。 */
  flushPersist: () => Promise<void>;
  refreshList: () => Promise<void>;
  /** 分析成功 → 建项目（模板基线冻结）并设为当前项目。 */
  createFromAnalysis: (input: Parameters<typeof createVisualProjectFromAnalysis>[0]) => Promise<VisualProject>;
  /** 打开项目（本地恢复，绝不重新分析）。 */
  openProject: (id: string) => Promise<VisualProject | null>;
  /** 关闭当前项目（保留落库；页面回到未选态）。 */
  closeProject: () => void;
  /**
   * 语义更新唯一入口（reason 决定 revision；mutate 内禁止直接改 revision）。
   * updateVisualProjectSemanticState 负责 +1，这里负责落库调度。
   */
  updateActive: (
    reason: SemanticChangeReason,
    mutate: (draft: VisualProject) => VisualProject,
  ) => void;
  /**
   * 防抖语义更新（freeText / 文本输入连击）：期间只更新内存与防抖落库、不加修订；
   * 连击结束后（下一次非防抖语义操作 / flushPendingSemantic / 生成前）补一次 +1。
   * 保证「一段文本编辑 = 一次语义修订」，绝不逐键 +1。
   */
  updateActiveDebounced: (
    reason: SemanticChangeReason,
    mutate: (draft: VisualProject) => VisualProject,
  ) => void;
  /** 冲刷防抖语义（补 +1；生成前 / 页面卸载必须调用）。 */
  flushPendingSemantic: () => void;
  /** 非语义更新（重命名 / 状态推进 / lastOpenedAt；不加修订）。 */
  updateActiveMeta: (mutate: (draft: VisualProject) => VisualProject) => void;
  renameActive: (name: string) => Promise<void>;
  duplicateActive: () => Promise<VisualProject | null>;
  deriveActive: () => Promise<VisualProject | null>;
  deleteProject: (id: string) => Promise<void>;
  /** workspace store → 项目文档镜像（页面在 workspace 变化时调用）。 */
  syncFromWorkspace: () => void;
  /** 项目文档 → workspace store 灌注（打开项目时调用）。 */
  hydrateWorkspaceFromActive: () => void;
  /** 区域 mask 落盘并写回 region.maskPath。 */
  saveRegionMask: (regionId: string, pngBase64: string) => Promise<string | null>;
  /** 记录生成结果（generated 状态 + generationIds；语义事件）。 */
  recordGeneration: (taskId: string, finalPrompt: string) => void;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistInFlight: Promise<void> | null = null;
/** 防抖语义待决标记（debounce 文本连击期间为 true；flush 时补一次修订）。 */
let pendingSemantic = false;

function serialize(project: VisualProject): string {
  return JSON.stringify(project);
}

async function persistProject(project: VisualProject, immediate = false): Promise<void> {
  const run = async () => {
    try {
      await api.saveVisualProject({
        id: project.id,
        name: project.name,
        status: project.status,
        revision: project.revision,
        coverPath: project.coverPath ?? null,
        dataJson: serialize(project),
        lastOpenedAt: project.lastOpenedAt ?? null,
      });
      useVisualProjectStore.setState(state => ({
        lastError: '',
        projects: upsertSummary(state.projects, project),
      }));
    } catch (error) {
      useVisualProjectStore.setState({
        lastError: error instanceof Error ? error.message : '项目保存失败。',
      });
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
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const current = useVisualProjectStore.getState().active;
    if (current) void persistProject(current, true);
  }, PERSIST_DEBOUNCE_MS);
}

function upsertSummary(list: VisualProjectSummary[], project: VisualProject): VisualProjectSummary[] {
  const summary: VisualProjectSummary = {
    id: project.id,
    name: project.name,
    status: project.status,
    revision: project.revision,
    coverPath: project.coverPath,
    updatedAt: project.updatedAt,
    lastOpenedAt: project.lastOpenedAt,
  };
  const rest = list.filter(item => item.id !== project.id);
  return [summary, ...rest];
}

export const useVisualProjectStore = create<VisualProjectState>((set, get) => ({
  projects: [],
  active: null,
  lastError: '',
  listLoading: false,

  flushPersist: async () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
      const current = get().active;
      if (current) await persistProject(current, true);
    }
  },

  refreshList: async () => {
    set({ listLoading: true });
    try {
      const projects = await api.listVisualProjects();
      set({ projects, listLoading: false, lastError: '' });
    } catch (error) {
      set({
        listLoading: false,
        lastError: error instanceof Error ? error.message : '项目列表读取失败。',
      });
    }
  },

  createFromAnalysis: async input => {
    const project = createVisualProjectFromAnalysis(input);
    set({ active: project });
    await persistProject(project, true);
    return project;
  },

  openProject: async id => {
    try {
      const raw = await api.loadVisualProject(id);
      if (!raw) {
        set({ lastError: '项目不存在或已被删除。' });
        return null;
      }
      const parsed = normalizeVisualProject(JSON.parse(raw) as VisualProject);
      if (!parsed) {
        set({ lastError: '项目文档已损坏，无法打开。' });
        return null;
      }
      const opened: VisualProject = {
        ...parsed,
        lastOpenedAt: new Date().toISOString(),
      };
      set({ active: opened, lastError: '' });
      void persistProject(opened, true);
      return opened;
    } catch (error) {
      set({ lastError: error instanceof Error ? error.message : '项目打开失败。' });
      return null;
    }
  },

  closeProject: () => {
    set({ active: null });
  },

  updateActive: (reason, mutate) => {
    const current = get().active;
    if (!current) return;
    const mutated = mutate(current);
    // 语义修订由统一函数裁决（mutate 不许自己 +1）；防抖连击的待决修订合并进本次 +1
    const withRevision: VisualProject = {
      ...mutated,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    pendingSemantic = false;
    void reason;
    set({ active: withRevision });
    void persistProject(withRevision);
  },

  updateActiveDebounced: (reason, mutate) => {
    const current = get().active;
    if (!current) return;
    const mutated = mutate(current);
    pendingSemantic = true;
    void reason;
    set({ active: { ...mutated, updatedAt: new Date().toISOString() } });
    void persistProject(mutated);
  },

  flushPendingSemantic: () => {
    if (!pendingSemantic) return;
    const current = get().active;
    if (!current) return;
    pendingSemantic = false;
    const withRevision: VisualProject = {
      ...current,
      revision: current.revision + 1,
      status: current.status === 'ready' ? 'modified' : current.status,
      updatedAt: new Date().toISOString(),
    };
    set({ active: withRevision });
    void persistProject(withRevision);
  },

  updateActiveMeta: mutate => {
    const current = get().active;
    if (!current) return;
    const next = mutate(current);
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
      await api.renameVisualProject(current.id, trimmed);
      set(state => ({
        projects: state.projects.map(item => (item.id === current.id ? { ...item, name: trimmed } : item)),
      }));
    } catch (error) {
      set({ lastError: error instanceof Error ? error.message : '重命名失败。' });
    }
    void persistProject(next);
  },

  duplicateActive: async () => {
    const current = get().active;
    if (!current) return null;
    await get().flushPersist();
    const copy = duplicateVisualProject(get().active ?? current);
    set({ active: copy });
    await persistProject(copy, true);
    return copy;
  },

  deriveActive: async () => {
    const current = get().active;
    if (!current) return null;
    await get().flushPersist();
    const derived = deriveVisualProject(get().active ?? current);
    set({ active: derived });
    await persistProject(derived, true);
    return derived;
  },

  deleteProject: async id => {
    await get().flushPersist();
    try {
      await api.deleteVisualProject(id);
      set(state => ({
        projects: state.projects.filter(item => item.id !== id),
        active: state.active?.id === id ? null : state.active,
        lastError: '',
      }));
    } catch (error) {
      set({ lastError: error instanceof Error ? error.message : '项目删除失败。' });
    }
  },

  syncFromWorkspace: () => {
    const current = get().active;
    if (!current) return;
    const ws = useVisionWorkspaceStore.getState();
    const workspace = {
      ...current.workspace,
      profileId: ws.profileId,
      modelId: ws.modelId,
      analysis: ws.analysis,
      reverseResult: ws.reverseResult,
      originalPromptDraft: ws.originalPromptDraft,
      promptDraft: ws.promptDraft,
      negativeDraft: ws.negativeDraft,
      recreation: ws.recreation,
      genParams: ws.genParams,
      generationMode: ws.generationMode,
      hfTarget: ws.hfTarget,
      hfMaxIterations: ws.hfMaxIterations,
      report: ws.report,
      iterations: ws.iterations,
      visionTaskId: ws.visionTaskId,
      sessionId: ws.sessionId,
    };
    const next: VisualProject = { ...current, workspace };
    set({ active: next });
    void persistProject(next);
  },

  hydrateWorkspaceFromActive: () => {
    const current = get().active;
    if (!current) return;
    useVisionWorkspaceStore.setState(state => ({
      ...state,
      sourcePath: current.sourceAsset.path,
      sourceAssetId: current.sourceAsset.assetId,
      profileId: current.workspace.profileId || state.profileId,
      modelId: current.workspace.modelId || state.modelId,
      analysis: current.workspace.analysis,
      reverseResult: current.workspace.reverseResult,
      originalPromptDraft: current.workspace.originalPromptDraft,
      promptDraft: current.workspace.promptDraft,
      negativeDraft: current.workspace.negativeDraft,
      recreation: current.workspace.recreation,
      genParams: current.workspace.genParams,
      generationMode: current.workspace.generationMode,
      hfTarget: current.workspace.hfTarget,
      hfMaxIterations: current.workspace.hfMaxIterations,
      report: current.workspace.report,
      iterations: current.workspace.iterations,
      visionTaskId: current.workspace.visionTaskId,
      sessionId: current.workspace.sessionId,
      // 项目化路径：modificationDraft 从项目合同派生（单一事实源 = 项目）
      modificationDraft: {
        ...current.modification,
        person: current.modification.person
          ? {
            source: current.modification.person.source,
            assetId: current.modification.person.assetId,
            path: current.modification.person.path,
            label: current.modification.person.label,
            description: current.modification.person.description,
          }
          : null,
      },
      stage: current.workspace.analysis ? 'ready' : 'idle',
      errorText: '',
    }));
  },

  saveRegionMask: async (regionId, pngBase64) => {
    const current = get().active;
    if (!current) return null;
    try {
      const path = await api.saveVisualProjectMask(current.id, regionId, pngBase64);
      const next: VisualProject = {
        ...current,
        regions: current.regions.map(region =>
          region.id === regionId ? { ...region, maskPath: path } : region,
        ),
        updatedAt: new Date().toISOString(),
      };
      set({ active: next });
      void persistProject(next);
      return path;
    } catch (error) {
      set({ lastError: error instanceof Error ? error.message : '区域 mask 保存失败。' });
      return null;
    }
  },

  recordGeneration: (taskId, finalPrompt) => {
    const current = get().active;
    if (!current) return;
    const next: VisualProject = {
      ...current,
      status: 'generated',
      generationIds: [...(current.generationIds ?? []), taskId],
      latestFinalPrompt: finalPrompt,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    set({ active: next });
    void persistProject(next);
  },
}));
