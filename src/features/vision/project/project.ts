/**
 * VisualProject 领域操作（§3 / §4 / §5 / §20 / §21）—— 纯函数层。
 *
 *  - 语义修订（revision）：只有人物 / 维度 / 区域 / 参考图 / 用户说明 /
 *    Rendering Contract / 模板重建 才 +1（§6 白名单）；折叠 / Tab / Viewer /
 *    hover 等视图操作走 updateVisualProjectViewState（不落项目、不加修订）；
 *  - duplicate：模板 / 合同 / 区域全部复制，生成历史不复制（§21.B）；
 *  - derive（基于此方案新建）：保留模板 / 媒介结构 / 风格 / 构图 / 镜头，
 *    重置人物参考与生成历史（§21.C）；
 *  - legacy 迁移：旧 workspace 快照 → 项目（不重新分析，缺模板快照只用已有
 *    结构化内容，§36）。
 */

import type { VisionAnalysis } from '../../../types';
import type { RecreationState, VisualRecreationPlan } from '../recreationPlan';
import {
  EMPTY_MODIFICATION_DRAFT,
  type ModificationDraft,
} from '../modificationIntent';
import { normalizePersonReplacementContract, migrateLegacyPerson } from './personContract';
import { normalizeRegion } from './region';
import { buildTemplateSnapshot, normalizeTemplateSnapshot } from './template';
import type {
  ModificationContract,
  PersonReplacementContract,
  RegionReplacement,
  VisualProject,
  VisualProjectAsset,
  VisualProjectStatus,
  VisualProjectWorkspace,
  VisualReferenceAsset,
} from './types';

export const EMPTY_MODIFICATION_CONTRACT: ModificationContract = {
  ...EMPTY_MODIFICATION_DRAFT,
  person: null,
};

let projectSeq = 0;
export function newProjectId(): string {
  projectSeq += 1;
  return `vp-${Date.now().toString(36)}-${projectSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newReferenceId(): string {
  return `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** ModificationDraft（V1）→ ModificationContract（V2；person 升级、默认 strict）。 */
export function toModificationContract(
  draft: ModificationDraft,
  regions?: ReadonlyArray<RegionReplacement>,
): ModificationContract {
  return {
    ...draft,
    person: migrateLegacyPerson(draft.person, regions),
  };
}

/** ModificationContract → 既有 ModificationDraft（旧组件兼容视图，读路径专用）。 */
export function toModificationDraft(contract: ModificationContract): ModificationDraft {
  return {
    ...contract,
    person: contract.person
      ? {
        source: contract.person.source,
        assetId: contract.person.assetId,
        path: contract.person.path,
        label: contract.person.label,
        description: contract.person.description,
      }
      : null,
  };
}

/** 修改合同统一归一化入口（§8：所有写入路径必须经过，禁止组件各自修状态）。 */
export function normalizeModificationContract(
  contract: ModificationContract,
  regions?: ReadonlyArray<RegionReplacement>,
): ModificationContract {
  const person = normalizePersonReplacementContract(contract.person, regions);
  const participates = person !== null || contract.activeDimensions.includes('clothing');
  let clothingPolicy = contract.clothingPolicy;
  let customClothing = contract.customClothing;
  let activeDimensions = [...contract.activeDimensions];
  if (!participates) {
    clothingPolicy = 'preserve_original';
    customClothing = '';
  } else if (clothingPolicy === 'use_subject_reference' && !(person && person.source !== 'description' && !!person.path?.trim())) {
    clothingPolicy = 'custom';
  }
  if (clothingPolicy === 'preserve_original') {
    // 不变量 A：保留模板服装 ⇒ clothing 维度必须 OFF
    activeDimensions = activeDimensions.filter(key => key !== 'clothing');
  } else if (!activeDimensions.includes('clothing')) {
    // 不变量 B / C：修改服装来源 ⇒ clothing 维度必须 ON
    activeDimensions = [...activeDimensions, 'clothing'];
  }
  if (person && !activeDimensions.includes('subject')) {
    activeDimensions = [...activeDimensions, 'subject'];
  }
  const seenDims = new Set<string>();
  activeDimensions = activeDimensions.filter(key => (seenDims.has(key) ? false : seenDims.add(key)));
  if (clothingPolicy !== 'custom') customClothing = '';
  return { ...contract, person, clothingPolicy, customClothing, activeDimensions };
}

function normalizeWorkspace(workspace: VisualProjectWorkspace | undefined): VisualProjectWorkspace {
  const base: VisualProjectWorkspace = {
    profileId: '',
    modelId: '',
    mode: 'reverse_prompt',
    analysis: null,
    reverseResult: null,
    originalPromptDraft: '',
    promptDraft: '',
    negativeDraft: '',
    recreation: null,
    genParams: { size: '1024x1024', quality: 'auto', count: 1 },
    generationMode: 'i2i',
    hfTarget: 0.9,
    hfMaxIterations: 2,
    report: null,
    iterations: [],
    visionTaskId: '',
    sessionId: '',
  };
  if (!workspace || typeof workspace !== 'object') return base;
  return {
    ...base,
    ...workspace,
    genParams: { ...base.genParams, ...(workspace.genParams ?? {}) },
  };
}

/** 持久化恢复合法化（缺字段回落默认；person / regions / template 全部归一化）。 */
export function normalizeVisualProject(project: VisualProject | null | undefined): VisualProject | null {
  if (!project || typeof project !== 'object' || !project.id) return null;
  const references: VisualReferenceAsset[] = Array.isArray(project.references)
    ? project.references.filter(ref => ref && ref.path?.trim())
    : [];
  const regions: RegionReplacement[] = (Array.isArray(project.regions) ? project.regions : [])
    .map(region => normalizeRegion(region, references));
  const modification = normalizeModificationContract(
    project.modification ?? EMPTY_MODIFICATION_CONTRACT,
    regions,
  );
  return {
    ...project,
    name: project.name?.trim() || '未命名视觉项目',
    status: (['draft', 'analyzing', 'ready', 'modified', 'generating', 'generated', 'error'] as VisualProjectStatus[]).includes(project.status)
      ? project.status
      : 'draft',
    sourceAsset: project.sourceAsset && project.sourceAsset.path
      ? project.sourceAsset
      : { path: '', source: 'local_import' },
    templateSnapshot: normalizeTemplateSnapshot(project.templateSnapshot) ?? undefined,
    modification,
    references,
    regions,
    revision: Number.isFinite(project.revision) ? project.revision : 0,
    optimizedRevision: Number.isFinite(project.optimizedRevision as number) ? project.optimizedRevision : undefined,
    createdAt: project.createdAt || new Date().toISOString(),
    updatedAt: project.updatedAt || new Date().toISOString(),
    projectVersion: 1,
    workspace: normalizeWorkspace(project.workspace),
  };
}

/** 分析成功 → 建项目（§4 createVisualProject；模板基线在此冻结）。 */
export function createVisualProjectFromAnalysis(input: {
  name?: string;
  analysis: VisionAnalysis;
  plan: VisualRecreationPlan;
  recreation: RecreationState;
  sourceAsset: VisualProjectAsset;
  workspace: VisualProjectWorkspace;
  analysisModel?: { modelId?: string; displayName?: string; providerName?: string };
}): VisualProject {
  const now = new Date().toISOString();
  const templateSnapshot = buildTemplateSnapshot({
    analysis: input.analysis,
    plan: input.plan,
    sourcePath: input.sourceAsset.path,
    sourceAssetId: input.sourceAsset.assetId,
    analysisModel: input.analysisModel,
    analyzedAt: now,
  });
  return {
    id: newProjectId(),
    name: input.name?.trim() || '未命名视觉项目',
    status: 'ready',
    coverAssetId: input.sourceAsset.assetId,
    coverPath: input.sourceAsset.path,
    sourceAsset: input.sourceAsset,
    templateSnapshot,
    modification: EMPTY_MODIFICATION_CONTRACT,
    references: [],
    regions: [],
    renderingContract: templateSnapshot.mediaStructure,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    projectVersion: 1,
    workspace: input.workspace,
  };
}

/** 更换识别图（§5）：新模板 + 可选保留修改意图；restart 时清空修改 / 区域 / 参考。 */
export function reapplyTemplateFromAnalysis(
  project: VisualProject,
  input: {
    analysis: VisionAnalysis;
    plan: VisualRecreationPlan;
    recreation: RecreationState;
    sourceAsset: VisualProjectAsset;
    keepModification: boolean;
    analysisModel?: { modelId?: string; displayName?: string; providerName?: string };
  },
): VisualProject {
  const templateSnapshot = buildTemplateSnapshot({
    analysis: input.analysis,
    plan: input.plan,
    sourcePath: input.sourceAsset.path,
    sourceAssetId: input.sourceAsset.assetId,
    analysisModel: input.analysisModel,
  });
  return {
    ...project,
    sourceAsset: input.sourceAsset,
    coverAssetId: input.sourceAsset.assetId,
    coverPath: input.sourceAsset.path,
    templateSnapshot,
    renderingContract: templateSnapshot.mediaStructure,
    modification: input.keepModification ? project.modification : EMPTY_MODIFICATION_CONTRACT,
    regions: input.keepModification ? project.regions : [],
    references: input.keepModification ? project.references : [],
    // 模板重建是语义事件（§6 白名单：模板）
    revision: project.revision + 1,
    status: 'modified',
    updatedAt: new Date().toISOString(),
  };
}

export type SemanticChangeReason =
  | 'modification'
  | 'person'
  | 'dimensions'
  | 'clothing'
  | 'regions'
  | 'references'
  | 'rendering_contract'
  | 'template'
  | 'free_text'
  | 'generation_result';

/** 语义状态更新唯一入口（revision +1 由本函数裁决，组件不得自行累加）。 */
export function updateVisualProjectSemanticState(
  project: VisualProject,
  reason: SemanticChangeReason,
  mutate: (draft: VisualProject) => VisualProject,
): VisualProject {
  const next = mutate(project);
  return { ...next, revision: next.revision + 1, updatedAt: new Date().toISOString() };
}

/**
 * 视图状态更新（§4）：绝不 +1 revision、绝不改变语义字段。
 * 项目卡 lastOpenedAt 等轻量元数据也走这里（打开项目不算语义修改）。
 */
export function updateVisualProjectViewState(
  project: VisualProject,
  mutate: (draft: VisualProject) => VisualProject,
): VisualProject {
  const next = mutate(project);
  return next === project ? project : { ...next, updatedAt: project.updatedAt };
}

/** 复制项目（§21.B）：模板 / 合同 / 区域 / 参考全复制；生成历史与 revision 归零。 */
export function duplicateVisualProject(project: VisualProject, nameSuffix = ' 副本'): VisualProject {
  const now = new Date().toISOString();
  return {
    ...project,
    id: newProjectId(),
    name: `${project.name}${nameSuffix}`,
    status: project.status === 'generated' ? 'modified' : project.status,
    revision: 0,
    optimizedRevision: undefined,
    latestFinalPrompt: undefined,
    generationIds: [],
    derivedFromProjectId: project.id,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    modification: structuredCloneCompat(project.modification),
    regions: project.regions.map(region => ({
      ...region,
      // mask 文件按原路径引用（共享只读资产，复制不复制文件；删除源项目时由
      // 调用方决定是否清理 —— V1 选择共享引用并在 UI 提示）
      maskPath: region.maskPath,
    })),
    references: project.references.map(ref => ({ ...ref, id: newReferenceId() })),
  };
}

/**
 * 基于此方案新建（§21.C 派生）：保留模板 / 媒介结构 / 风格 / 构图 / 镜头，
 * 重置人物参考与生成历史。
 */
export function deriveVisualProject(project: VisualProject, name?: string): VisualProject {
  const derived = duplicateVisualProject(project, '');
  const now = new Date().toISOString();
  return {
    ...derived,
    name: name?.trim() || `基于「${project.name}」新建`,
    modification: {
      ...derived.modification,
      // 派生重置人物参考（§21.C）；其余修改意图（维度 / freeText）一并重置，
      // 模板 / 媒介 / 风格 / 构图 / 镜头由 templateSnapshot + renderingContract 保留
      person: null,
      activeDimensions: [],
      freeText: '',
      customClothing: '',
      replicationBoost: false,
      mentions: [],
      extraImageRefs: [],
      clothingPolicy: 'preserve_original',
    },
    regions: [],
    references: [],
    derivedFromProjectId: project.id,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };
}

/** Person 合同写入（语义事件；统一归一化 + subject 维度联动）。 */
export function setProjectPersonContract(
  project: VisualProject,
  person: PersonReplacementContract | null,
): VisualProject {
  return updateVisualProjectSemanticState(project, 'person', draft => ({
    ...draft,
    modification: normalizeModificationContract(
      { ...draft.modification, person },
      draft.regions,
    ),
    status: 'modified',
  }));
}

function structuredCloneCompat<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 项目状态摘要标签（项目卡 / Header 展示）。 */
export function describeProjectStatus(status: VisualProjectStatus): string {
  const labels: Record<VisualProjectStatus, string> = {
    draft: '草稿',
    analyzing: '识别中',
    ready: '已理解',
    modified: '已修改',
    generating: '生成中',
    generated: '已生成',
    error: '失败',
  };
  return labels[status] ?? '草稿';
}
