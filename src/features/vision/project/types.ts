/**
 * Visual Project（V4.1 Workbench V2）—— 项目化视觉方案工作台领域类型。
 *
 * 铁律（领域层，违反即 bug）：
 *  1. TemplateSnapshot 是「原图是什么」的冻结基线；Modification 是 overlay。
 *     用户修改人物 / 背景绝不写回 templateSnapshot 对应维度
 *     （重新分析源图之前 templateSnapshot 不可变）。
 *  2. Identity != RenderingMode：人物参考决定「是谁」，Rendering Contract 决定「怎么画」。
 *     person reference 绝不自动决定媒介；overall style 修改绝不覆写各层 RenderingMode。
 *  3. Region 坐标一律归一化 0..1（不存 CSS pixel）；mask 以文件路径引用（不存 bitmap）。
 *  4. project.revision 只有语义修改（人物/维度/区域/参考/媒介/模板/用户说明）才 +1；
 *     折叠 / Tab / Viewer / hover 等纯视图操作绝不改变 revision。
 *
 * 维度命名沿用既有 RecreationFieldKey 体系（pose≡动作、scene≡背景），
 * 展示层由 MODIFICATION_DIMENSION_LABELS 统一映射。
 */

import type {
  GenerationProvenanceSnapshot,
  VisionAnalysis,
} from '../../../types';
import type { RecreationState } from '../recreationPlan';
import type {
  ClothingPolicy,
  ModificationDimension,
  PersonSource,
} from '../modificationIntent';
import type { ImageMention } from '../imageMention';
import type { ReversePromptResult } from '../reversePrompt';
import type { SimilarityReport } from '../similarity';
import type { RecreationIterationRecord, VisionMode } from '../session';

export type VisualProjectStatus =
  | 'draft'
  | 'analyzing'
  | 'ready'
  | 'modified'
  | 'generating'
  | 'generated'
  | 'error';

/** 项目资产来源（§3.2）。 */
export type VisualAssetSource =
  | 'gallery'
  | 'local_import'
  | 'task_result'
  | 'current_task'
  | 'project_asset';

export interface VisualProjectAsset {
  assetId?: string;
  path: string;
  displayName?: string;
  width?: number;
  height?: number;
  source: VisualAssetSource;
}

/** 模板维度基线（originalValue = 分析时冻结；structured 保留原始结构化片段）。 */
export interface TemplateDimension {
  originalValue: string;
  structured?: unknown;
}

/** 参考资产（人物 / 背景 / 风格 / 区域参考；id = 项目内稳定标识）。 */
export type VisualReferenceKind = 'person' | 'background' | 'style' | 'generic' | 'region';

export interface VisualReferenceAsset {
  id: string;
  assetId?: string;
  path: string;
  label: string;
  kind: VisualReferenceKind;
  source: VisualAssetSource;
}

/** 模型执行快照（分析 / 优化时冻结；之后换模型不影响历史展示）。 */
export interface ModelExecutionSnapshot {
  modelId?: string;
  displayName?: string;
  providerName?: string;
}

/**
 * 视觉模板快照（§3.3）：识别成功后冻结「原图是什么」。
 * 修改人物 / 背景等任何 Modification 绝不覆写这里的维度。
 */
export interface VisualTemplateSnapshot {
  sourceAssetId?: string;
  sourcePath: string;
  subject: TemplateDimension;
  action: TemplateDimension;
  background: TemplateDimension;
  composition: TemplateDimension;
  camera: TemplateDimension;
  style: TemplateDimension;
  lighting: TemplateDimension;
  color: TemplateDimension;
  clothing: TemplateDimension;
  /** 分析出的媒介结构（缺省 = 单一媒介，由 rendering contract 派生兜底）。 */
  mediaStructure?: RenderingContract;
  analysisModel?: ModelExecutionSnapshot;
  analyzedAt: string;
  schemaVersion: 1;
}

// ===== Person Replacement Contract V2（§7）=====

/** 约束等级是 Prompt/Contract 层语义，不是模型参数百分比（禁止伪造 80%/95%）。 */
export type PersonConstraintStrength = 'natural' | 'balanced' | 'strict';

export type PersonReplaceScope = 'whole_person' | 'face' | 'upper_body' | 'custom_region';

export type IdentityApplyScope = 'primary_subject_only' | 'all_corresponding_subjects';

/**
 * 人物替换合同 V2。绑定参考图后默认 strict（用户主动切换前不降级）。
 * preserveTemplateIdentity 恒为 false：strict/balanced 下模板人物身份一律不保留
 * （这是类型级常量，由 normalize 层强制写入，禁止出现 true）。
 */
export interface PersonReplacementContract {
  enabled: boolean;
  source: PersonSource;
  assetId?: string;
  path?: string;
  label?: string;
  description?: string;
  strength: PersonConstraintStrength;
  replaceScope: PersonReplaceScope;
  /** replaceScope === 'custom_region' 时必填（指向 project.regions[i].id）。 */
  targetRegionId?: string;
  /** 恒为 false（模板人物身份永不作为身份来源；类型级不变量）。 */
  preserveTemplateIdentity: false;
  applyIdentityTo: IdentityApplyScope;
}

// ===== Modification Contract（§6 / §8）=====

/**
 * 修改合同：语义上等价既有 ModificationDraft，person 升级为 V2 合同。
 * 服装不变量（A/B/C）仍由 ModificationContract 层的 clothingPolicy 表达
 * （单一事实源，禁止在 person 合同内复制一份）：
 *   A. preserve_template ⇒ clothing ∉ activeDimensions
 *   B. use_person_reference ⇒ clothing ∈ activeDimensions
 *   C. custom ⇒ clothing ∈ activeDimensions 且 customClothing 非空
 */
export interface ModificationContract {
  freeText: string;
  activeDimensions: ModificationDimension[];
  person: PersonReplacementContract | null;
  clothingPolicy: ClothingPolicy;
  customClothing: string;
  replicationBoost: boolean;
  mentions: ImageMention[];
  extraImageRefs: Array<{ assetId?: string; path: string; label?: string }>;
}

// ===== Region Replacement V1（§9）=====

/** 矩形区域（全部坐标归一化 0..1，左上原点）。 */
export interface RectangleRegion {
  kind: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 画笔笔触（点序列 + 归一化半径；naturalWidth/Height 记录原图像素用于比例还原）。 */
export interface BrushStroke {
  points: Array<{ x: number; y: number }>;
  radius: number;
}

export interface BrushMaskRegion {
  kind: 'brush';
  strokes: BrushStroke[];
  naturalWidth: number;
  naturalHeight: number;
}

export type RegionShape = RectangleRegion | BrushMaskRegion;

export type RegionReplaceType = 'person' | 'background' | 'object' | 'custom';

export interface RegionReplacement {
  id: string;
  name: string;
  shape: RegionShape;
  replaceType: RegionReplaceType;
  /** replaceType === 'person' 时可绑定参考资产（references[i].id）。 */
  personReferenceId?: string;
  constraintStrength: PersonConstraintStrength;
  replaceScope?: Exclude<PersonReplaceScope, 'custom_region'>;
  prompt?: string;
  enabled: boolean;
  createdAt: string;
  /** 栅格化 mask 文件路径（PNG；绝对路径，Rust 侧写入）。 */
  maskPath?: string;
}

// ===== Hybrid Media Rendering Contract（§10）=====

export type RenderingMode =
  | 'photorealistic'
  | 'anime_illustration'
  | 'illustration'
  | '3d_render'
  | 'graphic_design'
  | 'mixed_media'
  | 'unknown';

export type RenderingSemanticRole =
  | 'primary_subject'
  | 'secondary_subject'
  | 'anime_counterpart'
  | 'detail_insert'
  | 'background'
  | 'graphic_decoration';

export type IdentityRelation =
  | 'template_identity'
  | 'person_reference'
  | 'same_as_primary'
  | 'none';

export interface RenderingRegion {
  id: string;
  label: string;
  semanticRole: RenderingSemanticRole;
  renderingMode: RenderingMode;
  identityRelation: IdentityRelation;
  description?: string;
}

export interface RenderingContract {
  overallMode: 'single_media' | 'mixed_media';
  /**
   * single_media 时的唯一渲染模式（mixed_media 时缺省）。
   * 混合媒介的渲染模式存 regions[].renderingMode，单一媒介存此处（单一事实源）。
   */
  singleMode?: RenderingMode;
  /** true = 生成时保持模板的媒介分层结构（混合媒介模板默认 true）。 */
  preserveTemplateMediaStructure: boolean;
  regions: RenderingRegion[];
}

// ===== VisualProject（§3.1）=====

/**
 * 恢复载荷：项目关闭应用后仍能完整恢复工作区（分析结果 / 复刻方案 / Prompt /
 * 生成参数 / 模型选择），恢复只读本地数据，绝不重新调用视觉分析 API。
 */
export interface VisualProjectWorkspace {
  profileId: string;
  modelId: string;
  mode: VisionMode;
  analysis: VisionAnalysis | null;
  reverseResult: ReversePromptResult | null;
  originalPromptDraft: string;
  promptDraft: string;
  negativeDraft: string;
  recreation: RecreationState | null;
  genParams: { size: string; quality: string; count: number };
  generationMode: 't2i' | 'i2i';
  hfTarget: number;
  hfMaxIterations: number;
  report: SimilarityReport | null;
  iterations: RecreationIterationRecord[];
  visionTaskId: string;
  sessionId: string;
}

export interface VisualProject {
  id: string;
  name: string;
  status: VisualProjectStatus;
  coverAssetId?: string;
  coverPath?: string;
  sourceAsset: VisualProjectAsset;
  templateSnapshot?: VisualTemplateSnapshot;
  modification: ModificationContract;
  references: VisualReferenceAsset[];
  regions: RegionReplacement[];
  renderingContract?: RenderingContract;
  /** 项目语义修订：只有真实语义修改才 +1（生成任务冻结 generatedFromRevision）。 */
  revision: number;
  /** 最近一次 Prompt 优化对齐的修订（落后 = 待优化）。 */
  optimizedRevision?: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  latestFinalPrompt?: string;
  generationIds?: string[];
  derivedFromProjectId?: string;
  projectVersion: 1;
  workspace: VisualProjectWorkspace;
}

/** 项目列表摘要（Rust list_visual_projects 返回；不含完整 workspace）。 */
export interface VisualProjectSummary {
  id: string;
  name: string;
  status: VisualProjectStatus;
  revision: number;
  coverPath?: string;
  updatedAt: string;
  lastOpenedAt?: string;
}

// ===== Effective Plan（§13）=====

/** 有效方案行（Context Rail / 确认弹层 / 溯源快照 / History 共用，组件不得自行拼装）。 */
export interface EffectivePlanRow {
  key: string;
  label: string;
  value: string;
  kind: 'source' | 'modified' | 'keep' | 'info';
}

export interface EffectiveVisualPlan {
  template: { label: string; path?: string } | null;
  person: { label: string; path?: string; strength: PersonConstraintStrength; scope: PersonReplaceScope } | null;
  rows: EffectivePlanRow[];
  regions: RegionReplacement[];
  rendering: RenderingContract | null;
  /** 生成硬校验结果（§38：只有语义错误才阻断）。 */
  blockingErrors: string[];
}
