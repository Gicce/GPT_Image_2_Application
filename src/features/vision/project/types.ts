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
  NormalizedRegion,
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
 * 单主体姿态快照（Dimension Lock §13/§14）：混合媒介模板里每个主体
 * （真人主体 / 动漫对应角色 / 次要主体）的动作与朝向各自冻结，
 * 「未选择修改动作 ⇒ 每个主体的姿态锁定」据此逐主体锁定。
 * 只保存分析真实产出的字段，禁止发明占比 / 百分比数字。
 *
 * 表情分离不变量（动作未修改 ⇒ 姿态/手势/表情/视线/朝向整套锁定）：
 *  gesture / facialExpression / gaze 与 poseDescription 分列存储；
 *  动漫主体（anime_counterpart / secondary）的 wink 表情经
 *  classifyFacialExpression 识别后由表情锁定合同独立强化编译。
 */
export interface RegionPoseSnapshot {
  id: string;
  label: string;
  subjectRole: 'primary_subject' | 'anime_counterpart' | 'secondary_subject' | 'detail_insert';
  poseDescription: string;
  /** 手势基线（分析产出 gesture；与姿态分离锁定）。 */
  gesture?: string;
  /** 面部表情基线（如 右眼闭合的wink；动作锁定时独立锁定，禁止漂移成半眯眼）。 */
  facialExpression?: string;
  /** 视线基线。 */
  gaze?: string;
  bodyOrientation?: string;
  /** 归一化空间锚点（0..1；来自视觉分析 subjects[].position）。 */
  spatialAnchor?: NormalizedRegion;
  source: 'template_analysis';
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
  /** 各主体姿态（多主体 / 混合媒介的动作锁定依据；旧快照缺省回落 action 单维度）。 */
  subjectPoses?: RegionPoseSnapshot[];
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

/** detail_insert 层与其所属主体的同步维度（继承谁的那一面）。 */
export type DetailInsertMirrorAspect =
  | 'identity'
  | 'facial_expression'
  | 'gaze'
  | 'hair'
  | 'face'
  | 'eyes'
  | 'accessories'
  | 'clothing';

/** detail_insert 的裁切类型（从插图标签确定性派生；决定允许变化的范围）。 */
export type DetailInsertCropType = 'face' | 'eyes' | 'hair' | 'feet' | 'clothing' | 'expression' | 'other';

/** detail_insert 表情策略：镜像动漫主角色 / 保留模板插图自身表情 / 显式自定义。 */
export type DetailInsertExpressionPolicy = 'mirror_secondary' | 'preserve_template_insert' | 'explicit_custom';

/**
 * Detail Insert Instance（V5 Group/Instance 分离）：
 * RenderingRegion（Group）描述「一类插图」，Instance 描述「画面里真实存在的那一个」
 * ——一个画框 = 一个 instance。Region Count != Actual Insert Count 的历史缺陷
 * 正是在这里修复：数量与位置一律来自视觉分析结构化响应，禁止固定套数。
 */
export interface DetailInsertInstance {
  /** 实例 id（group 内稳定：`${region.id}-ins-${n}`）。 */
  id: string;
  groupId: string;
  /** 实例自身的媒介（决定绑定目标：动漫实例 → Canonical Character；真人/图形实例 → 所属主体）。 */
  mediaType: RenderingMode;
  cropType: DetailInsertCropType | 'body';
  /** 归一化空间位置（0..1；分析产出，未产出 = 缺省）。 */
  bounds?: NormalizedRegion;
  targetSubjectRole?: 'primary_subject' | 'secondary_subject';
  /** 实例 label（如「左上动漫眼部特写框」）。 */
  label: string;
  /** 实例自身描述（如「右下上方 wink 面部特写」）。 */
  description?: string;
  /** 引用的 Canonical Anime Character id（仅动漫实例；bindDetailInsertsToCharacter 写入）。 */
  characterRef?: string;
  /** 表情策略（面部 / 眼部实例默认 preserve_template_insert）。 */
  expressionPolicy?: DetailInsertExpressionPolicy;
  /** 视觉分析置信度（0..1；分析未给出 = 缺省，禁止发明）。 */
  confidence?: number;
}

export interface RenderingRegion {
  id: string;
  label: string;
  semanticRole: RenderingSemanticRole;
  renderingMode: RenderingMode;
  identityRelation: IdentityRelation;
  description?: string;
  /**
   * detail_insert 绑定（确定性派生，非模型自由发挥）：局部插图与哪个主体同步。
   * 眼部 / 面部特写必须 mirrors facial_expression —— 模板动漫主体是 wink 时，
   * 对应插图继承同一 wink 表情基线，绝不各画各的表情。
   */
  mirrors?: DetailInsertMirrorAspect[];
  /** 被镜像的主体角色（动漫对应角色优先，否则主体人物）。 */
  mirrorTargetRole?: 'primary_subject' | 'secondary_subject';
  /**
   * 引用的 Canonical Anime Character id（Anime Character Consistency 合同）：
   * 动漫 detail_insert 由 bindDetailInsertsToCharacter 在编译/校验时刻写入，
   * 与 anime detail insert 自身的外观描述互斥——插图不得自建角色外观。
   * V5 起权威位置在 instances[].characterRef（组级字段 = 无实例数据时的兜底）。
   */
  characterRef?: string;
  /** 裁切类型（从标签确定性派生：face / eyes / hair / feet / clothing / expression / other）。 */
  cropType?: DetailInsertCropType;
  /** 表情策略（镜像动漫主角色 / 保留模板插图自身表情基线）。 */
  expressionPolicy?: DetailInsertExpressionPolicy;
  /**
   * 实例清单（V5 Group/Instance 分离；一个画框 = 一个 instance）。
   * 缺省 = 分析未产出实例（旧快照）：渲染为单实例兜底或触发不完整校验，
   * 绝不按层描述伪造多实例。
   */
  instances?: DetailInsertInstance[];
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

// ===== Canonical Anime Character（动漫角色一致性合同）=====

// ----- V5 Resolved Facts（Source Instruction ≠ Design Fact）-----

/** 发型设计事实（从人物参考外貌分析解析；枚举值 = 确定性词表，free text 兜底）。 */
export interface CharacterHairFacts {
  baseColor: string;
  length: 'short' | 'shoulder' | 'chest' | 'waist' | 'other';
  texture: 'straight' | 'soft_wave' | 'large_wave' | 'curly' | 'other';
  parting: 'center' | 'left' | 'right' | 'none' | 'other';
  bangs: 'none' | 'curtain' | 'side' | 'full' | 'wispy' | 'other';
  silhouetteDescription: string;
}

/** 脸部设计事实。 */
export interface CharacterFaceFacts {
  shape: string;
  eyeShape: string;
  irisColor: string;
  eyelashStyle?: string;
}

/**
 * 人物参考外貌快照（ReferenceAppearanceSnapshot）：人物参考图第一次需要时
 * 解析一次并缓存（按图片指纹失效）；绝不每次生成重新 Vision Call。
 */
export interface ReferenceAppearanceSnapshot {
  /** 解析对象指纹（person path + assetId；不匹配当前人物参考 = 过期重析）。 */
  fingerprint: string;
  hair: CharacterHairFacts;
  face: CharacterFaceFacts;
  accessories: string[];
  clothing: string[];
  /** 解析模型快照（展示用）。 */
  model?: ModelExecutionSnapshot;
  analyzedAt: string;
}

// ----- V5 Anime Consistency Mode（Standard / Strict Visual Reference）-----

export type AnimeConsistencyMode = 'standard' | 'strict_visual_reference';

/**
 * Canonical Anime Character Visual Asset（Strict 模式的内部中间产物；
 * UI 口径 = 「动漫角色参考图」，绝不向用户暴露工程命名）。
 * 生成一次按指纹缓存复用——改动作 / 构图 / 背景 / 镜头绝不 invalidate。
 */
export interface CanonicalAnimeCharacterAsset {
  id: string;
  /** 资产创建时的项目修订。 */
  projectRevision: number;
  sourcePersonAssetId?: string;
  sourcePersonPath?: string;
  styleTemplateAssetId?: string;
  /** 本地图片路径（生成任务产物）。 */
  localPath: string;
  libraryAssetId?: string;
  /** 创建时的角色卡引用（characterSnapshotId 恒 = canonical id）。 */
  characterSnapshotId: string;
  /** 缓存指纹（输入变化 = 失效重建：人物参考 / 服装来源 / 角色设计 / 媒介基线）。 */
  fingerprint: string;
  /** 创建它的生成任务 id（成本追溯）。 */
  taskId?: string;
  createdAt: string;
}

/** 项目级动漫一致性配置（Strict 模式 + 角色参考图资产缓存）。 */
export interface AnimeConsistencyConfig {
  mode: AnimeConsistencyMode;
  /** 可复用的角色参考图资产（fingerprint 过期 = 需重建）。 */
  characterAsset?: CanonicalAnimeCharacterAsset;
}

/**
 * Person Identity ≠ Anime Character Design ≠ Detail Insert Crop（三者铁律）：
 *  - 人物参考图负责 Person Identity（是谁）；
 *  - 本快照负责 Anime Character Design（这一个动漫角色长什么样）：
 *    由 Person Identity + 模板动漫媒介结构派生，一旦派生即冻结为唯一实例；
 *  - detail insert 只是对该角色的裁切（Crop），不得自建外观。
 *
 * 唯一性不变量：同一 projectRevision + 动漫主体 ⇔ 至多一个 canonical 快照
 * （项目上单字段承载，结构性保证；所有动漫层经 characterRef 引用它）。
 */
export interface AnimeCharacterSnapshot {
  /** canonical 引用 id（常量 'canonical-anime-character'；detail insert characterRef 指向它）。 */
  id: string;
  /** 被规范化的动漫主体标签（模板混合媒介层中的动漫角色名）。 */
  sourceSubjectLabel: string;
  /** 人物身份来源（是谁）：人物参考图 / 模板原身份 / 手动描述。 */
  identitySource: {
    kind: 'person_reference' | 'template' | 'manual';
    label?: string;
    assetId?: string;
    path?: string;
  };
  /** 角色设计来源：由人物参考派生 / 沿用模板动漫设计。 */
  designSource: 'derived_from_person_reference' | 'template_anime_design';
  hair: AnimeCharacterAttribute<CharacterHairFacts>;
  face: AnimeCharacterAttribute<CharacterFaceFacts>;
  eyes: AnimeCharacterAttribute<CharacterFaceFacts>;
  accessories: AnimeCharacterAttribute;
  clothing: {
    source: 'template' | 'person_reference' | 'custom';
    canonicalDescription: string;
  };
  expression: {
    policy: DetailInsertExpressionPolicy;
    /** 表情基线（来自模板动漫主体的表情快照，如 wink）。 */
    description?: string;
  };
  rendering: {
    mediaType: 'anime_illustration';
    styleDescription: string;
  };
  /** 派生时的项目修订（= project.revision；过期即重新派生，绝不复用旧卡）。 */
  revision: number;
}

/**
 * 动漫角色单属性的事实绑定（值 = 哪来的 + 确定性描述）。
 * V5：source（binding + description 指向来源）≠ resolved facts（已解析的具体
 * 设计事实）——Canonical Character 不能只有「看参考图」，必须有解析结果。
 */
export interface AnimeCharacterAttribute<F = CharacterHairFacts | CharacterFaceFacts> {
  binding: 'person_reference' | 'template_subject' | 'custom';
  description: string;
  /** 已解析的设计事实（人物参考外貌分析产出；缺省 = 未解析，不得伪造）。 */
  facts?: F;
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
  /**
   * V5 Prompt Editor「完整 Prompt」模式的手动覆盖（Submission Snapshot 冻结语义）：
   * 存在时生成直接提交该文本、不再装配合同层；清空 = 恢复系统编译。
   */
  fullPromptOverride?: string;
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
  /**
   * 最近一次技能执行快照（V4.2 Runtime Skill Trace；优化/生成时冻结，
   * 工作台 Trace Drawer 读这里。历史任务读 provenance.skillExecutionSnapshot，
   * 两者职责分离：这里是「项目当前态」，History 是「当时态」）。
   * 旧项目缺省 = 无技能记录（UI 如实提示，禁止伪造）。
   */
  skillExecution?: import('../../../types').SkillExecutionSnapshot;
  /**
   * Canonical Anime Character（动漫角色一致性）：优化/生成时确定性派生并冻结；
   * revision 落后项目修订 = 过期（读取方一律重新派生，绝不使用旧卡）。
   * 旧项目缺省 = 无动漫角色卡（未派生，不伪造）。
   */
  animeCharacter?: AnimeCharacterSnapshot;
  /**
   * 人物参考外貌快照（V5）：第一次需要时解析一次并缓存（按指纹失效）。
   * 旧项目缺省 = 未解析（角色卡回落来源指示语义，不伪造事实）。
   */
  referenceAppearance?: ReferenceAppearanceSnapshot;
  /**
   * 动漫角色一致性配置（V5）：standard 单次生成 / strict_visual_reference
   * 附带可缓存复用的动漫角色参考图资产。旧项目缺省 = standard。
   */
  animeConsistency?: AnimeConsistencyConfig;
  /** 最近一次执行时生效的技能清单（信息性冻结；生效判定在 runtime skill store）。 */
  enabledSkillIds?: string[];
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

/**
 * 方案行来源图片引用（§A 来源可视）：@token 背后的真实图片侧车数据。
 * Context Rail 据此渲染可交互 @chip——hover 预览缩略图、点击打开内置查看器、
 * title 显示完整文件名 / 标签（组件不得凭 value 字符串自行猜图）。
 */
export interface EffectivePlanSourceRef {
  /** 行内唯一标识。 */
  key: string;
  /** 展示名（@label；过长时保留可见前缀的缩短名，永不空串）。 */
  label: string;
  /** 完整名（title / hover 浮层展示；不截断）。 */
  fullLabel: string;
  /** 来源角色说明（hover 浮层：模板图 / 人物参考 / 图片引用）。 */
  roleNote: string;
  /** 本地路径（缺省 = 纯文字描述，不可预览）。 */
  path?: string;
  assetId?: string;
  role: 'template' | 'person' | 'mention';
}

/** 方案行状态徽标（§A：替换 / 不保留一眼可辨）。 */
export interface EffectivePlanRowBadge {
  /** 徽标文案（如「已替换」「不保留」）。 */
  text: string;
  /** success = 绿色（已替换）；warn = 警示（负向状态）。 */
  tone: 'success' | 'warn';
}

/** 有效方案行（Context Rail / 确认弹层 / 溯源快照 / History 共用，组件不得自行拼装）。 */
export interface EffectivePlanRow {
  key: string;
  label: string;
  value: string;
  kind: 'source' | 'modified' | 'keep' | 'info';
  /** value 中 @token 的真实图片引用（同名 token 按 label 匹配）。 */
  refs?: EffectivePlanSourceRef[];
  /** 状态徽标（已替换 / 不保留等显著视觉状态）。 */
  badge?: EffectivePlanRowBadge;
}

export interface EffectiveVisualPlan {
  template: { label: string; fullLabel?: string; roleNote?: string; path?: string } | null;
  person: { label: string; path?: string; strength: PersonConstraintStrength; scope: PersonReplaceScope } | null;
  rows: EffectivePlanRow[];
  regions: RegionReplacement[];
  rendering: RenderingContract | null;
  /** 生成硬校验结果（§38：只有语义错误才阻断）。 */
  blockingErrors: string[];
}
