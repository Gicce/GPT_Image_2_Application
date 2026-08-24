/**
 * Vision Workspace（V4.0.7）—— 视觉理解页工作区状态唯一载体。
 *
 * 职责：页面切换 / 组件卸载 / 应用重启后完整恢复视觉理解工作区
 * （参考图标识、模型、模式、分析结果、复刻方案、Prompt、生成参数、任务关联），
 * 恢复只读取持久化数据 + 本地缩略图，绝不自动重新调用视觉理解 API。
 *
 * 约束：
 *  - 本模块禁止 import services/api（恢复链路无任何网络请求的静态保证）；
 *  - 只保存可重新恢复素材的标识（路径 / assetId），绝不保存图片 base64 / Blob；
 *  - 预览图与元信息（previewUrl / meta）不持久化，挂载后按 sourcePath 本地重读；
 *  - 瞬时进行中状态（analyzing / optimizing 等）落盘前归一化为稳定状态，
 *    恢复后绝不出现"永远进行中"或触发重放。
 */

import { create } from 'zustand';
import type { VisionAnalysis } from '../types';
import type { ReversePromptResult } from '../features/vision/reversePrompt';
import type { SimilarityReport } from '../features/vision/similarity';
import { normalizeRecreationState, type RecreationState } from '../features/vision/recreationPlan';
import type { RecreationIterationRecord, VisionMode } from '../features/vision/session';
import {
  EMPTY_MODIFICATION_DRAFT,
  migrateModificationDraft,
  normalizeModificationState,
  type ModificationDraft,
} from '../features/vision/modificationIntent';

export type VisionStage =
  | 'idle'
  | 'analyzing'
  | 'ready'
  | 'generating_candidate'
  | 'analyzing_candidate'
  | 'comparing'
  | 'scoring'
  | 'failed';

export interface VisionGenParams {
  size: string;
  quality: string;
  count: number;
}

export interface VisionWorkspaceSnapshot {
  /** 参考图：本地路径 + 素材库 id（Gallery 来源时有；恢复时按路径重读缩略图/元信息） */
  sourcePath: string;
  sourceAssetId?: string;
  /** 模型选择（模型中心 profile + model id；恢复时按可用列表校验） */
  profileId: string;
  modelId: string;
  mode: VisionMode;
  /** 视觉分析原始结果 + 编译产物 */
  analysis: VisionAnalysis | null;
  reverseResult: ReversePromptResult | null;
  /** 三个 Prompt 编辑区 + 结构化修改意图（自由文本 + 快捷维度 + 人物替换 + 服装策略） */
  originalPromptDraft: string;
  promptDraft: string;
  negativeDraft: string;
  modificationDraft: ModificationDraft;
  /** 复刻方案状态机（含锁定项 / 优化产物） */
  recreation: RecreationState | null;
  genParams: VisionGenParams;
  /**
   * V4.0.8 生成方式（确认生成图片时带入图片工作室）：
   * i2i = 原图自动作为参考图；t2i = 纯文本重新创作。
   * 切页面 / 重启恢复，不因进入图片工作室再回来而丢失。
   */
  generationMode: 't2i' | 'i2i';
  /** 高复刻配置与结果 */
  hfTarget: number;
  hfMaxIterations: number;
  report: SimilarityReport | null;
  iterations: RecreationIterationRecord[];
  /** 任务与会话关联（来源链路显示） */
  visionTaskId: string;
  sessionId: string;
  stage: VisionStage;
  errorText: string;
  updatedAt: string;
}

const STORAGE_KEY = 'vision_workspace_v1';
/** 文本输入防抖持久化间隔（避免逐字符写盘） */
const TEXT_PERSIST_DEBOUNCE_MS = 500;

const INITIAL: VisionWorkspaceSnapshot = {
  sourcePath: '',
  sourceAssetId: undefined,
  profileId: '',
  modelId: '',
  mode: 'reverse_prompt',
  analysis: null,
  reverseResult: null,
  originalPromptDraft: '',
  promptDraft: '',
  negativeDraft: '',
  modificationDraft: EMPTY_MODIFICATION_DRAFT,
  recreation: null,
  genParams: { size: '1024x1024', quality: 'auto', count: 1 },
  generationMode: 'i2i',
  hfTarget: 0.9,
  hfMaxIterations: 2,
  report: null,
  iterations: [],
  visionTaskId: '',
  sessionId: '',
  stage: 'idle',
  errorText: '',
  updatedAt: '',
};

/** 瞬时进行中状态恢复语义：分析中被打断 → 未完成（idle/failed）；其余回落 ready/idle。 */
function normalizeStage(stage: VisionStage, hasAnalysis: boolean): VisionStage {
  if (stage === 'analyzing' || stage === 'failed') {
    // 分析中的快照说明结果从未落地：恢复为可重新执行的初始/失败态
    return stage === 'analyzing' ? 'idle' : 'failed';
  }
  if (stage === 'generating_candidate' || stage === 'analyzing_candidate' || stage === 'comparing' || stage === 'scoring') {
    return hasAnalysis ? 'ready' : 'idle';
  }
  return stage;
}

/** recreation.editState='optimizing' 是进程内瞬时态：恢复为 dirty（保留全部内容，允许重新优化）。 */
function normalizeRecreation(recreation: RecreationState | null): RecreationState | null {
  if (!recreation) return null;
  const normalized = normalizeRecreationState(recreation);
  if (normalized.editState === 'optimizing') {
    return { ...normalized, editState: 'dirty', optimizeError: '优化被中断，请重新执行优化。' };
  }
  return normalized;
}

function readSnapshot(): VisionWorkspaceSnapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return INITIAL;
    const parsed = JSON.parse(raw) as Partial<VisionWorkspaceSnapshot> & { adjustmentInput?: string };
    if (!parsed || typeof parsed !== 'object') return INITIAL;
    const merged: VisionWorkspaceSnapshot = {
      ...INITIAL,
      ...parsed,
      genParams: { ...INITIAL.genParams, ...(parsed.genParams ?? {}) },
    };
    // V4.1 迁移：旧 adjustmentInput（纯文本）→ modificationDraft.freeText；旧 recreation 补 revision 字段
    merged.modificationDraft = migrateModificationDraft(
      parsed.modificationDraft,
      parsed.adjustmentInput,
    );
    merged.stage = normalizeStage(merged.stage, !!merged.analysis);
    merged.recreation = normalizeRecreation(merged.recreation);
    return merged;
  } catch {
    return INITIAL;
  }
}

function writeSnapshot(state: VisionWorkspaceSnapshot): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }));
  } catch {
    // localStorage 满或被禁用：内存态继续工作，仅丢失持久化
  }
}

interface VisionWorkspaceState extends VisionWorkspaceSnapshot {
  /** 选择参考图（立即持久化；Gallery 来源带 assetId） */
  setSource: (path: string, assetId?: string) => void;
  /** 「移除图片」：清除图片与分析产物，保留模型/模式选择 */
  removeSource: () => void;
  setModelSelection: (profileId: string, modelId: string) => void;
  setMode: (mode: VisionMode) => void;
  markStage: (stage: VisionStage, errorText?: string) => void;
  setVisionTaskId: (id: string) => void;
  /** 分析完成：一次性落位分析结果 / 编译产物 / 复刻方案初始态 / 参数默认值 / 会话 */
  applyAnalysis: (input: {
    analysis: VisionAnalysis;
    reverseResult: ReversePromptResult;
    recreation: RecreationState;
    genParams: VisionGenParams;
    visionProfileId: string;
    visionModelId: string;
    visionTaskId: string;
    sessionId: string;
  }) => void;
  setOriginalPromptDraft: (value: string) => void;
  setPromptDraft: (value: string) => void;
  setNegativeDraft: (value: string) => void;
  /** 结构化修改意图变更（debounce=true 用于 freeText 按键输入；toggle / 人物 / 服装立即）。 */
  setModificationDraft: (draft: ModificationDraft, opts?: { debounce?: boolean }) => void;
  /** debounce=true 用于按键驱动的逐步更新（调整要求输入 / 手动编辑原始 Prompt） */
  setRecreation: (next: RecreationState | null, opts?: { debounce?: boolean }) => void;
  setGenParams: (partial: Partial<VisionGenParams>) => void;
  /** V4.0.8 生成方式（文生图 / 图生图）：立即持久化。 */
  setGenerationMode: (mode: 't2i' | 'i2i') => void;
  setHfConfig: (config: { target?: number; maxIterations?: number }) => void;
  setReportAndIterations: (report: SimilarityReport | null, iterations: RecreationIterationRecord[]) => void;
  /** 「重新开始」：清空整个工作区（含持久化数据；不动历史任务 / 会话记录 / 素材库） */
  reset: () => void;
  /** 文本防抖立即落盘（组件卸载时冲刷） */
  flushPendingPersist: () => void;
}

let textPersistTimer: ReturnType<typeof setTimeout> | null = null;

function persistNow(state: VisionWorkspaceState): void {
  if (textPersistTimer) {
    clearTimeout(textPersistTimer);
    textPersistTimer = null;
  }
  writeSnapshot(state);
}

/** 结构性变化立即落盘；纯文本输入走防抖，避免逐字符 IO。 */
function setAndPersist(
  partial: Partial<VisionWorkspaceSnapshot>,
  debounce: boolean,
): (set: (updater: (state: VisionWorkspaceState) => VisionWorkspaceState) => void, get: () => VisionWorkspaceState) => void {
  return (set, get) => {
    set(state => ({ ...state, ...partial }));
    if (debounce) {
      if (textPersistTimer) clearTimeout(textPersistTimer);
      textPersistTimer = setTimeout(() => {
        textPersistTimer = null;
        writeSnapshot(get());
      }, TEXT_PERSIST_DEBOUNCE_MS);
    } else {
      persistNow(get());
    }
  };
}

export const useVisionWorkspaceStore = create<VisionWorkspaceState>((set, get) => ({
  ...readSnapshot(),

  setSource: (path, assetId) => {
    setAndPersist({ sourcePath: path, sourceAssetId: assetId }, false)(set, get);
  },

  removeSource: () => {
    setAndPersist(
      {
        sourcePath: '',
        sourceAssetId: undefined,
        analysis: null,
        reverseResult: null,
        originalPromptDraft: '',
        promptDraft: '',
        negativeDraft: '',
        modificationDraft: EMPTY_MODIFICATION_DRAFT,
        recreation: null,
        genParams: { size: '1024x1024', quality: 'auto', count: 1 },
        generationMode: 'i2i',
        report: null,
        iterations: [],
        visionTaskId: '',
        sessionId: '',
        stage: 'idle',
        errorText: '',
      },
      false,
    )(set, get);
  },

  setModelSelection: (profileId, modelId) => {
    setAndPersist({ profileId, modelId }, false)(set, get);
  },

  setMode: mode => {
    setAndPersist({ mode }, false)(set, get);
  },

  markStage: (stage, errorText) => {
    setAndPersist({ stage, errorText: errorText ?? '' }, false)(set, get);
  },

  setVisionTaskId: id => {
    setAndPersist({ visionTaskId: id }, false)(set, get);
  },

  applyAnalysis: input => {
    setAndPersist(
      {
        analysis: input.analysis,
        reverseResult: input.reverseResult,
        originalPromptDraft: input.reverseResult.prompt,
        promptDraft: input.reverseResult.prompt,
        negativeDraft: input.reverseResult.negativePrompt,
        modificationDraft: EMPTY_MODIFICATION_DRAFT,
        recreation: input.recreation,
        genParams: input.genParams,
        report: null,
        iterations: [],
        profileId: input.visionProfileId,
        modelId: input.visionModelId,
        visionTaskId: input.visionTaskId,
        sessionId: input.sessionId,
        stage: 'ready',
        errorText: '',
      },
      false,
    )(set, get);
  },

  setOriginalPromptDraft: value => {
    setAndPersist({ originalPromptDraft: value }, true)(set, get);
  },

  setPromptDraft: value => {
    setAndPersist({ promptDraft: value }, true)(set, get);
  },

  setNegativeDraft: value => {
    setAndPersist({ negativeDraft: value }, true)(set, get);
  },

  setModificationDraft: (draft, opts) => {
    // 服装策略状态不变量的最终收口：任何写入路径（含页面直接展开 {...current}）
    // 都不可能把「修改服装 + 原图服装」矛盾态留进 store / 持久化
    setAndPersist({ modificationDraft: normalizeModificationState(draft) }, opts?.debounce === true)(set, get);
  },

  setRecreation: (next, opts) => {
    setAndPersist({ recreation: next }, opts?.debounce === true)(set, get);
  },

  setGenParams: partial => {
    setAndPersist({ genParams: { ...get().genParams, ...partial } }, false)(set, get);
  },

  setGenerationMode: mode => {
    setAndPersist({ generationMode: mode }, false)(set, get);
  },

  setHfConfig: config => {
    setAndPersist(
      {
        hfTarget: config.target ?? get().hfTarget,
        hfMaxIterations: config.maxIterations ?? get().hfMaxIterations,
      },
      false,
    )(set, get);
  },

  setReportAndIterations: (report, iterations) => {
    setAndPersist({ report, iterations }, false)(set, get);
  },

  reset: () => {
    if (textPersistTimer) {
      clearTimeout(textPersistTimer);
      textPersistTimer = null;
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch { /* 忽略 */ }
    set({ ...INITIAL });
  },

  flushPendingPersist: () => {
    if (textPersistTimer) persistNow(get());
  },
}));
