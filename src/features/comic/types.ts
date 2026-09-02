/**
 * AI 漫画领域模型（Phase 1）——schema 由前端 TS 单一维护，
 * Rust 侧 comic_* 表只存 data_json 整文档（同 visual_projects/user_skills 先例）。
 *
 * 概念（docs/ai-comic/02-COMIC-DESIGN.md）：
 * - ComicSkill 是导演（漫画规则），Character 是演员，Story 是本期故事，Panel 是镜头；
 * - ComicProject 创建时冻结 SkillSnapshot / CharacterSnapshot，后续改库不回写历史项目；
 * - Panel 与 Dialogue 分离：对白属于文字层，修改对白结构上不可能触发生图。
 */
import type { GenerationImageReference } from '../../types';

export type ComicSkillSource = 'ai_draft' | 'user_saved' | 'preset';

/**
 * 展示形式（Phase 1.2 §8/§9）：用户语言里的四宫格 / 九宫格 / 上下双格 / 左右双格 /
 * 三格竖版 / 多页连载。enum 只加不加改——旧项目四种值全部继续合法。
 */
export type ComicLayoutArrangement =
  | 'vertical_2'
  | 'horizontal_2'
  | 'vertical_3'
  | 'grid_4'
  | 'grid_9'
  | 'multi_page'
  | 'single'
  | 'custom';

export interface ComicIntent {
  /** 用途：职场吐槽 / 小红书 / 品牌宣传 … */
  purpose?: string;
  /** 情绪：搞笑 / 冷幽默 / 毒舌 / 憨萌 … */
  tone?: string;
  /** 发布渠道：小红书 / 朋友圈 / 短视频素材 … */
  platform?: string;
}

export interface ComicLayout {
  panelCount: number;
  arrangement: ComicLayoutArrangement;
  /** 布局补充说明（上下双格 / 田字四格 …） */
  description?: string;
  /** 多页连载模式的页数（arrangement='multi_page' 时生效；缺省 = panelCount） */
  pageCount?: number;
}

/**
 * 推荐阶段的形式约束（V4.2.8）：用户在新建弹窗选「AI 自动」或固定一种形式。
 * fixed = 硬约束——三个推荐方案必须全部使用该形式，Validator 校验 + Repair 修复；
 * auto = AI 为每个故事自由选择最合适的形式。
 */
export interface ComicPresentationConstraint {
  mode: 'auto' | 'fixed';
  /** mode='fixed' 时必填：模板 id（COMIC_PRESENTATION_TEMPLATES 之一，不含 custom） */
  templateId?: ComicLayoutArrangement;
}

/**
 * 项目展示形式来源（V4.2.8 §55/§56）：创建项目时固定 = user_fixed（后续对话式
 * 微调不得改 layout，只有「画面与形式」显式选择卡可改）；AI 推荐 = ai_recommended。
 */
export type ComicPresentationSource = 'user_fixed' | 'ai_recommended';

/** 对白呈现方式（Phase 1.2 §12.2：气泡 / 底部字幕 / 旁白框 / 无气泡文字）。 */
export type ComicDialogueMode = 'bubble' | 'subtitle' | 'narration' | 'none';

export interface ComicTextStyle {
  /** 气泡样式提示（系统文字层渲染用，不进图片 Prompt） */
  bubbleStyle: string;
  /** 字体风格提示 */
  fontHint: string;
  /** 对白呈现方式（Phase 1.2；缺省 = 'bubble'） */
  dialogueMode?: ComicDialogueMode;
}

export interface ComicGenerationRules {
  /** 默认无字底图（规格 §15）：图片层禁止可读对白/乱码/水印/签名/logo */
  noText: true;
  negativeConstraints: string[];
  /** Story 明确需要画面内环境文字（店名/标语）时才放开 */
  environmentTextAllowed?: boolean;
  /**
   * V4.2.12 §63 场景表现（面板 Prompt 的环境信息量）：standard 默认——
   * 简化但明确的故事场景背景；minimal 只保留画面必要元素（贴纸/立绘类）；
   * rich 要求更丰富的环境陈设。仅影响 Prompt 编译，不影响已生成图片。
   */
  sceneRichness?: 'minimal' | 'standard' | 'rich';
}

export interface ComicCharacterSlot {
  slotId: string;
  /** 槽位名：主角 / 记者 / 同事 … */
  name: string;
  /**
   * 稳定身份键（V4.2.11 §A）：planner 下发（如 main_duck / duck_mom），
   * 缺省由名字归一推导（characterIdentity）。键相等才视为同一角色，
   * 绝不做纯字符串相似合并。
   */
  characterKey?: string;
  required: boolean;
  /** 显示规则（如「仅手部 + 麦克风，不露脸」），编译进 Prompt 与确认 UI */
  displayRule?: string;
  /** 槽位默认绑定的角色（可换演员不破坏 Skill） */
  defaultCharacterId?: string;
}

/** 漫画 Skill = 漫画规则（导演）。 */
export interface ComicSkill {
  id: string;
  name: string;
  description: string;
  /** 每次保存 +1；项目内冻结的是快照，不跟随最新版 */
  version: number;
  source: ComicSkillSource;
  createdAt: string;
  updatedAt: string;
  intent: ComicIntent;
  comicForm: string;
  visualStyle: string;
  layout: ComicLayout;
  storyPattern: string;
  dialogueStyle: string;
  humorStyle: string;
  textStyle: ComicTextStyle;
  generationRules: ComicGenerationRules;
  characterSlots: ComicCharacterSlot[];
  /** 跨格一致性约束文案（画风/线条/角色特征/留白） */
  consistencyRules: string[];
  /** 面板 Prompt 模板（含 {{panel.scene}} 等槽位，编译器展开） */
  promptTemplate: string;
  referenceStrategy: {
    useAnchorAsStyle: boolean;
    characterRefs: 'required' | 'optional';
    /**
     * V4.2.11 §F 高级项「生成第一格后暂停确认」（默认 false 关闭）：
     * 关闭 = 一次提交全部 Panel（内部一致性由角色参考 + 画风直接建立）；
     * 开启 = 先出第 1 格、用户确认后再生成剩余（V4.2.10 两段式节奏）。
     */
    pauseAfterFirstPanel?: boolean;
  };
  exportDefaults: {
    canvasRatio: '1:1' | '3:4' | '9:16';
    background: string;
  };
}

/** 推荐分镜节拍（V4.2.7）：推荐阶段的预演，不创建正式 ComicPanel；
 *  用户选中方案进入正式链路后，由 Storyboard Planner 重新展开。 */
export interface ComicStoryboardBeat {
  /** 从 1 开始 */
  order: number;
  /** ≤6 字短标题（布局预览格内展示） */
  title: string;
  /** 这一格发生什么（一句话） */
  summary: string;
  /** 出场角色名（与 concept.characters 对应，可空数组） */
  characters: string[];
}

/**
 * AI 推荐方案（V4.2.7 Story-first）：方案首先是一个讲得完的完整故事
 * （storyTitle / oneLineStory / fullStory / punchline / storyboardBeats），
 * 展示形式（layout）只是故事的载体；风格参数（visualStyle / storyPattern /
 * dialogueStyle / reason）属高级详情，不占推荐卡主界面。
 * 旧响应缺故事字段时归一化自动回落（storyTitle→name、oneLineStory→examplePremise）。
 */
export interface ComicConcept {
  id: string;
  /** 方案名（配方名，如「四格冷笑话」） */
  name: string;
  /** 本期故事标题（如《小鸭为什么不怕冷？》） */
  storyTitle: string;
  /** 一句话讲完整个故事（推荐卡最重要字段） */
  oneLineStory: string;
  /** 完整故事（80~200 字，从头讲到尾） */
  fullStory: string;
  /** 结尾包袱 / 点题句 */
  punchline: string;
  reason: string;
  comicForm: string;
  visualStyle: string;
  storyPattern: string;
  dialogueStyle: string;
  /** 展示形式（四宫格 / 九宫格 / 多页 …的几何载体） */
  layout: ComicLayout;
  characters: { name: string; role: string; displayRule?: string; characterKey?: string }[];
  storyboardBeats: ComicStoryboardBeat[];
  tone: string;
  /** 旧字段（选题示例），兼容保留；新推荐卡不默认展示 */
  examplePremise?: string;
}

export type ComicCharacterOrigin = 'ai' | 'upload' | 'gallery' | 'library' | 'temporary';
export type ComicCharacterStatus = 'draft' | 'confirmed' | 'locked';

export interface ComicCharacterReferenceImage {
  path: string;
  assetId?: string;
  label: string;
  /** 生成来源追踪（生成参考图任务回写；图库手选时缺省）。 */
  imageId?: string;
  taskId?: string;
  generatedAt?: string;
}

/** 漫画角色（演员）：不是一段 Prompt 字符串。 */
export interface ComicCharacter {
  id: string;
  name: string;
  description: string;
  /** 主角 / 记者 / 辅助 … */
  role: string;
  source: ComicCharacterOrigin;
  referenceImage?: ComicCharacterReferenceImage;
  /** 一段外观描述（编译进 Prompt） */
  appearance: string;
  /** 不可变特征：黄白毛色 / 圆脸 / 小耳朵 …（跨格强制一致） */
  immutableTraits: string[];
  /** 可变特征：表情 / 动作 / 姿态 / 服装 / 手持物 */
  mutableTraits: string[];
  defaultClothing?: string;
  colorPalette?: string[];
  negativeConstraints: string[];
  status: ComicCharacterStatus;
  /** Brief 修改时已有参考图 → 置 true（参考图过期，需重新生成；换新图自动清除） */
  referenceStale?: boolean;
  /** 演员库元数据（§18）：被项目引用次数 —— 只由库侧维护，项目快照携带但不参与阶段派生 */
  usageCount?: number;
  /** 演员库元数据（§18）：最近一次被引用的时间 */
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ComicProjectStage =
  | 'draft'
  | 'skill_draft'
  | 'character_confirmation'
  | 'story_ready'
  | 'generating_anchor'
  | 'anchor_review'
  | 'generating_panels'
  | 'editing'
  | 'completed'
  | 'failed';

export type ComicPanelGenerationStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed';

export interface ComicPanelImageAsset {
  path: string;
  imageId: string;
  taskId: string;
}

/** 一格分镜：独立对象；generationPrompt 是编译产物冻结（溯源）。 */
export interface ComicPanel {
  id: string;
  order: number;
  /** 画面场景描述（无字底图） */
  scene: string;
  characterIds: string[];
  shotType: string;
  camera: string;
  composition: string;
  characterActions: string[];
  characterExpressions: string[];
  props?: string[];
  background: string;
  /** 画面内环境文字（店名/标语）；缺省 = 无字 */
  environmentText?: string;
  /** V4.2.12 §49/§50：这一格发生在什么时候（清晨/白天/傍晚/夜晚…） */
  time?: string;
  generationStatus: ComicPanelGenerationStatus;
  imageAsset?: ComicPanelImageAsset;
  /** V4.2.14 §63：烘焙文字进图片的派生资产（不覆盖 imageAsset；实验功能） */
  bakedTextAsset?: ComicPanelBakedTextAsset;
  compiledPrompt?: string;
  /** 最近一次生成失败原因（§45 卡片展示；成功落图后清除） */
  lastError?: string;
  /** Story 再生成后旧图过期标记（保留可回看，不静默复用） */
  stale?: boolean;
  regeneratedCount?: number;
}

/** V4.2.14 §63：文字烘焙派生资产 —— 独立文字层随时可回（不破坏原成图）。 */
export interface ComicPanelBakedTextAsset {
  path: string;
  imageId: string;
  taskId: string;
  bakedAt: string;
}

export type ComicDialogueType = 'speech' | 'thought' | 'caption' | 'title' | 'subtitle';
export type ComicDialogueAlignment = 'left' | 'center' | 'right';
/**
 * 气泡样式（V4.2.12 §12 七类主流漫画气泡；旧值继续合法——rounded/spiky/cloud/box
 * 是 V4.2.11 持久化值，渲染语义升级但不改键，soft/whisper 为本轮新增）：
 *  rounded=经典对白（椭圆+尾巴） soft=圆润对白 cloud=思考 box=旁白框
 *  spiky=喊话/爆炸 whisper=低声/悄悄话 none=无气泡文字
 */
/**
 * 气泡样式（V4.2.14 Bubble Library V2：16 样式四分组，docs/ai-comic/28 §6）：
 *  - 对白：rounded=经典 soft=圆润 cloud-talk=云朵 rect=矩形
 *  - 情绪：cloud=思考 spiky=喊话爆炸 sharp=惊讶尖刺 whisper=低声虚线
 *  - 旁白：box-light=白底 box=黑底白字 title-bar=顶部标题 subtitle-bar=底部字幕
 *  - 无框：hand=手绘字 stroke-black=黑字白描边 stroke-white=白字黑描边 plain=纯净
 *  `none` = V4.2.11~13 持久化 legacy 值，渲染语义 = stroke-black（Picker 不再单列）。
 */
export type ComicDialogueBubble =
  | 'rounded'
  | 'soft'
  | 'cloud'
  | 'box'
  | 'spiky'
  | 'whisper'
  | 'none'
  | 'cloud-talk'
  | 'rect'
  | 'sharp'
  | 'box-light'
  | 'title-bar'
  | 'subtitle-bar'
  | 'hand'
  | 'stroke-black'
  | 'stroke-white'
  | 'plain';

/** 气泡尾巴方向（V4.2.12 §23；narration/none 类恒无尾）。 */
export type ComicDialogueTail = 'auto' | 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';

/** 文字层块：与 Panel 分离，修改对白零生图。坐标归一化 0..1（铁律：禁止像素入状态）。 */
export interface ComicDialogue {
  id: string;
  panelId: string;
  speakerId: string | 'narrator';
  type: ComicDialogueType;
  text: string;
  position: { x: number; y: number };
  alignment: ComicDialogueAlignment;
  fontStyle: {
    size: number;
    weight: 400 | 500 | 600 | 700;
    color?: string;
    /** V4.2.12 §30：字体族（本机字体名；缺省 = 跟随导出缺省栈） */
    family?: string;
  };
  bubbleStyle: ComicDialogueBubble;
  /**
   * V4.2.12 §6：气泡尺寸（归一化，相对本格宽高）；缺省 = 内容自适应
   * （V4.2.11 行为）。Resize handles 写入本字段。
   */
  size?: { width: number; height: number };
  /** V4.2.12 §23：尾巴方向；缺省 = auto（按位置自动） */
  tail?: ComicDialogueTail;
  /** V4.2.14 §29：文字描边（无框组预设可逐条覆盖；气泡组缺省无描边） */
  strokeStyle?: { color: string; width: number };
  /** V4.2.14 §30：文字阴影（none / soft；缺省跟随样式预设） */
  shadow?: 'none' | 'soft';
  /**
   * V4.2.14 §82 / V4.2.13 Story Lock：对白来源标记。
   * story_seed=故事/分镜确认时种入（重出分镜只补空白格，人工改动过的不会被覆盖）；
   * manual=手工（story_seed 一经人工修改即升级 manual，优先级最高）；
   * planner=AI 规划 / vision=视觉理解建议（应用后归属）。
   */
  placementSource?: 'story_seed' | 'manual' | 'planner' | 'vision';
}

export type ComicEndingType = 'twist' | 'punchline' | 'warm' | 'flat' | 'custom';

/** 本期故事：结构化，不是一段 Prompt 字符串。 */
export interface ComicStory {
  title: string;
  topic: string;
  summary: string;
  characterIds: string[];
  beats: string[];
  endingType: ComicEndingType;
  panelCount: number;
}

/** 一致性档案：Anchor 锁定后冻结，剩余 Panel 与单格重生成全部继承。 */
export interface ComicConsistencyProfile {
  anchor?: {
    panelId: string;
    path: string;
    imageId: string;
    taskId: string;
    lockedAt: string;
  };
  characterReferences: {
    characterId: string;
    path: string;
    label: string;
  }[];
  colorRules?: string;
  lineRules?: string;
  lightingRules?: string;
  generationParams: { size: string; quality: string; format: string };
}

/**
 * 步骤草稿态（Phase 1.2 §30/§85）：切步骤 / 刷新都不能丢的用户输入。
 * 落 data_json 随项目持久化（600ms 防抖已有）；组件本地 state 仍是输入主载体，
 * 写穿（debounce）到 uiDraft、挂载时从 uiDraft 恢复——打字不重渲染全工作台。
 */
export interface ComicUiDraft {
  story?: {
    /** 需求 / 大白话调整输入 */
    requirement?: string;
    /** 审定中的未应用故事草稿（planComicStory 产物） */
    storyDraft?: ComicStory;
    phase?: 'hero' | 'requirement' | 'review';
  };
  storyboard?: {
    /** 未应用的分镜草稿（draftStoryboard + 修复层产物） */
    storyDraft?: ComicStory;
    panels?: ComicPanel[];
    dialogues?: ComicDialogue[];
    repairs?: string[];
    /** panelId → §38.2 单格大白话微调输入草稿（草稿态 / 已应用通用） */
    patchTexts?: Record<string, string>;
  };
  character?: {
    /** characterId → 微调输入草稿（换人后草稿不串到新演员） */
    patchTexts?: Record<string, string>;
  };
  skill?: {
    /** 对话式微调指令草稿 */
    instruction?: string;
  };
}

/** 漫画项目（本期创作）：内含全部快照，关闭重开完整恢复。 */
/** 组合完成的漫画整页资产（V4.2.11 §F）：本地合成 → 落图库，画廊一级展示。 */
export interface ComicFinalPageAsset {
  /** 第几页（0 基） */
  page: number;
  /** 库内文件路径 */
  path: string;
  /** 图库 ImageRecord id */
  imageId: string;
  /** 参与组合的 panelId（顺序 = 格序） */
  panelIds: string[];
  composedAt: string;
}

export interface ComicProject {
  id: string;
  name: string;
  stage: ComicProjectStage;
  /** 冻结的 Skill 快照（规格 §8.3：改库不回写历史项目） */
  skillSnapshot: ComicSkill;
  /** 冻结的角色快照 */
  characterSnapshots: ComicCharacter[];
  /** slotId → characterId 绑定（换演员不破坏 Skill） */
  characterBindings: Record<string, string>;
  story?: ComicStory;
  panels: ComicPanel[];
  dialogues: ComicDialogue[];
  /** 本地组合的整页资产（§F：只在「导出整页 PNG」时显式组合写入；再次导出更新） */
  finalPages?: ComicFinalPageAsset[];
  consistency?: ComicConsistencyProfile;
  /** 步骤草稿态（切步骤 / 刷新不丢输入） */
  uiDraft?: ComicUiDraft;
  /** 溯源到已保存的漫画 Skill（未保存则空） */
  skillId?: string;
  /** 展示形式来源（V4.2.8）：user_fixed = 用户创建时硬约束的排版，planner 不得偷改 */
  presentationSource?: ComicPresentationSource;
  createdAt: string;
  updatedAt: string;
}

/** 结构化 Skill 补丁：对话式修改只动相关字段，不整卡重生成（验收 C）。 */
export interface ComicSkillPatch {
  /** 白名单路径（COMIC_SKILL_PATCH_FIELDS 校验），如 'humorStyle' / 'layout.panelCount' */
  field: string;
  value: unknown;
  /** field='characterSlot.*' 时必填：目标槽位 */
  slotId?: string;
  reason?: string;
}

/** 漫画任务的 execution_snapshot.comic 溯源块（Rust 透传）。 */
export interface ComicExecutionMarker {
  projectId: string;
  projectName?: string;
  /** 'anchor' | 'panels' | 'panel_regen' | 'character_ref' | 'bake_text' */
  kind: 'anchor' | 'panels' | 'panel_regen' | 'character_ref' | 'bake_text';
  /** kind='panels' 时为空（逐槽在 items[].variables.panelId） */
  panelId?: string;
  /** kind='character_ref' 时必填：目标角色快照 id */
  characterId?: string;
  /** kind='character_ref' 时的角色名（快照冻结，溯源展示用） */
  characterName?: string;
  skillName?: string;
  storyTitle?: string;
}

/** Prompt Compiler 输出：图片生成输入的完整冻结面。 */
export interface CompiledPanelPrompt {
  positive: string;
  negative: string;
  /** 顺序 = 提交 gpt-image-2 的图片顺序（anchor → 角色参考） */
  references: GenerationImageReference[];
}
