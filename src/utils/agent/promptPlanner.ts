import { api } from '../../services/api';
import { providerFailureLabel } from '../../features/aiProviders/providerError';
import type { AgentRunRequestResult, PlannerDiagnostic, PlannerErrorKind, ResponsesRecoveryTrace } from '../../types';
import { classifyAgentIntent } from './intentClassifier';
import {
  renderTaskSemanticContextForPlanner,
  type TaskSemanticContext,
} from './taskContextResolver';
import {
  renderChatHandoffContextForPlanner,
  type ResolvedChatExecutionContext,
} from './chatExecutionContext';
import {
  buildAttachmentDescriptors,
  renderAttachmentMappingForPlanner,
  type PlannerAttachmentDescriptor,
} from './attachmentLabels';

export type PlannerTaskType = 'generate' | 'edit' | 'remove_background';
export type PlannerApiKind = 'generation' | 'edit' | 'remove_background' | 'upscale';

/**
 * Planner 在 attachment 角色判定后给出的更细粒度任务类型。
 * 上层（store / UI）用它来展示 "图片编辑 / 参考图生成 / 文生图 / 图片分析"，
 * 避免把"用户已上传图片"的任务错误展示成 "文生图"。
 */
export type ResolvedTaskKind =
  | 'text_to_image'
  | 'image_edit'
  | 'image_reference_generation'
  | 'image_analysis'
  | 'unknown';

export interface TaskPlanInput {
  text: string;
  hasEditableImage?: boolean;
  agentToken?: string;
  agentModel?: string;
  agentBaseUrl?: string;
  /** Provider 连接的使用方式（透传到 Rust 诊断日志与错误归因） */
  agentBillingMode?: import('../../features/aiProviders/types').BillingMode;
  /**
   * Provider 身份（BYOK 唯一来源解析得到）：规划失败时用于把错误归因到具体
   * Provider（「智谱 GLM 请求失败」/「DeepSeek 请求失败」/「<第三方名> 请求失败」），
   * 而不是显示与 Provider 无关的「上游模型」文案。
   */
  providerFailure?: {
    providerId: string;
    providerType: import('../../features/aiProviders/types').AIProviderType;
    providerName: string;
    billingMode?: import('../../features/aiProviders/types').BillingMode;
  };
  sourceImageCount?: number;
  /**
   * 当前会话的"活跃图片"：上一张成功生成 / 编辑后的图片。
   * 如果存在，则 Planner 会把它作为可被编辑/继续修改的源图纳入上下文，
   * 让"把那艘小船去掉"这类连续编辑意图能够被识别为 EDIT_IMAGE。
   */
  activeImageId?: string | null;
  activeImagePath?: string | null;
  activeImageTitle?: string | null;
  activeImageTaskType?: 'generate' | 'edit' | 'remove_background' | null;
  /**
   * 用户当轮新上传的附件文件名（用于让 Planner 知道用户实际传了什么图）。
   * 以前这里被硬编码成 []，导致 Planner 即使收到 has_images=true 也无法判断
   * 用户究竟传了几张、叫什么，从而在"去掉左下角 ID"等场景下退化为 needs_clarification。
   *
   * 注意：这是"真实文件名 / 路径"形式，仅用于诊断 / 持久化。
   * Prompt 给 LLM 看的引用编号必须改用 attachmentDescriptors（图一 / 图二 / 图三）。
   */
  attachmentNames?: string[];
  /**
   * Planner 侧的附件语义描述符：label = "图一 / 图二 / 图三"，按用户选择顺序。
   * 调用方负责按当前 Composer 选择顺序生成，不要持久化在快照以外的位置。
   *
   * Prompt 中会显式出现 "[图片附件语义映射]" 段落，让 Planner 真正理解 "图二" 指的是哪张。
   * 与真实图片附件传给执行模型的 images 数组顺序保持一致 —— 不允许错位。
   */
  attachmentDescriptors?: PlannerAttachmentDescriptor[];
  /**
   * 任务级上下文继承（多轮补充、指代消解、作品 / 主体绑定）。
   * 由 taskContextResolver.resolveTaskSemanticContext 产出。
   * 上层应仅在 augmentationDetected / inheritedFromPreviousTurn 为 true 时把它传入。
   */
  taskSemanticContext?: TaskSemanticContext;
  /**
   * Chat → Task 语义 Handoff 上下文（实体列表 / 九宫格布局 / 继承的提示词）。
   * 由 chatExecutionContext.resolveChatExecutionContext 产出 —— 让 Planner
   * 真正理解 "这些建筑 / 上面那些 / 就按这些生成" 指代的历史内容。
   */
  chatHandoffContext?: ResolvedChatExecutionContext;
}

export interface TaskPlanResult {
  taskType: PlannerTaskType;
  apiKind: PlannerApiKind;
  intent: string;
  confidence: number;
  needsClarification: boolean;
  clarificationQuestion?: string;
  /**
   * Planner 标记的可能缺失字段（仅用于诊断 / UI），可缺省。
   * 后端目前不直接产出，留作未来 schema 扩展点。
   */
  clarificationMissingFields?: string[];
  recommendedAction: string;
  rawPrompt: string;
  optimizedPrompt: string;
  negativePrompt: string;
  executionModel: string;
  agentModel: string;
  usedLocalFallback: boolean;
  errorMessage?: string;
  planningFailed?: boolean;
  sourceImageId?: string | null;
  sourceImagePath?: string | null;
  /**
   * 规划失败时的诊断信息（仅当 planningFailed=true 时有意义）。
   * 由后端 run_agent_request 透传：errorKind / rawOutput / parserError / transport。
   * 上层 UI 据此渲染"查看规划详情"展开区。
   */
  plannerDiagnostic?: PlannerDiagnostic;
  /**
   * 本地推断的细粒度任务类型（text_to_image / image_edit / image_reference_generation / image_analysis / unknown）。
   * 由 resolveTaskKindLocally 产出，作为 Planner 判定的健康度检查和 UI 展示标签。
   * 当用户上传了图片但 Planner 退化为 generation 时，本字段会被用来把 taskType 强制改回 edit。
   */
  resolvedTaskKind?: ResolvedTaskKind;
}

export const DEFAULT_EXECUTION_MODEL = 'gpt-image-2';

/**
 * 类型安全的提示词归一化：只接受 string，拒绝 number / boolean / null 等。
 *
 * 修复场景：Planner 偶尔会返回 `"final_negative_prompt": 1`（数字），
 * 旧代码 `String(value || '')` 会把 `1` 渲染成 `"1"`、`true` 渲染成 `"true"`，
 * 最终在确认卡上显示"负面提示词：1"，非常迷惑。
 *
 * 本函数只返回合法的非空字符串或 undefined —— 上层 UI 拿到 undefined 时直接隐藏该行。
 */
export function normalizeOptionalPrompt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * 兼容旧签名：返回字符串（可能是空串）。仅在内部仍然依赖"字符串字段"的旧代码路径上使用。
 * 新代码 / UI 应优先使用 normalizeOptionalPrompt。
 */
function normalizePromptString(value: unknown): string {
  return normalizeOptionalPrompt(value) ?? '';
}

const PLANNER_SYSTEM_PROMPT = `你是 CyImagePro 的图片任务规划智能体（Agent / Planner）。
你的职责是把用户的原始需求转化为图片执行模型（gpt-image-2）能够高质量执行的提示词，并输出结构化 JSON。

== 用户附件识别（关键，必须严格遵守）==
- 用户当轮新上传的图片会以 user_attachments 字段出现在 user prompt 中（包含数量）。
- 同时 user prompt 中会出现 "[图片附件语义映射]" 段落，显式告诉你 "图一 / 图二 / 图三" 分别对应哪个附件标识。
- 即使 current_active_image 为 null，只要 user_attachments.count > 0，就说明"用户已经把图片准备好了"。
- 此时如果用户输入还含有"去掉/去除/删除/移除/擦除/修掉/改/替换/换/修复/增强/裁切/放大/补全/去水印/去ID/去文字"等编辑动词，必须判定为 EDIT_IMAGE。
- 此时如果用户输入含有"参考这张/参考这个风格/按这张做/基于这张生成/用这张的风格/参考图"，必须判定为 IMAGE_REFERENCE_GENERATION（task_type=edit，api_kind=edit，source_image_id 指向 user_attachments 中第一张图）。
- 只有当用户输入是编辑意图但 user_attachments.count=0 且 current_active_image=null 时，才允许 needs_clarification=true 并询问"请上传需要处理的图片"。

== 图片附件语义编号引用（关键，必须严格遵守）==
- 当用户在输入中说 "图一 / 图二 / 图三 / 第一张图 / 第二张 / 第2张" 时，必须严格对应 "[图片附件语义映射]" 中的编号。
- 例如映射是 "图一=att_a, 图二=att_b, 图三=att_c"，用户说 "用图一的人物，参考图二的构图，图三只参考服装"：
  · 图一 = att_a 作为主体来源
  · 图二 = att_b 作为构图参考
  · 图三 = att_c 作为服装参考
- 不要根据文件名自行猜测用户引用的是哪张 —— 编号才是真相。
- 如果用户没有显式指定编辑目标，默认 "图一" 是 edit target，其余为 reference。
- 真实图片附件传给执行模型时的 images 数组顺序，必须与 "[图片附件语义映射]" 中的编号顺序一致，不允许错位。

== Clarification 策略（关键，必须严格遵守）==
CyImagePro 是 Agent 形态的产品：应尽量"自动完成任务"，而不是反复追问用户。
只有当缺失的信息会导致**无法合理执行**时才允许 needs_clarification=true。
判定原则：
1. 阻塞型缺失（允许 clarification）：
   - 用户明确请求编辑/修改/去除/替换，但既没有 user_attachments 也没有 current_active_image。
   - 用户输入完全是上下文代词（例如只说"把它换掉"），且会话里没有任何 prior task / image 可回指。
2. 非阻塞型缺失（禁止 clarification，必须自主补全）：
   - 作品 / IP 范围已确定但未指定具体角色（例如"给我生成一张死神的动漫人物全画像"、"画一个原神角色"）：
     Planner **必须自主选择一个具有代表性的角色**（例如黑崎一护、朽木露琪亚；钟离、温迪），
     并在 final_prompt 中明确写"以 XXX 为主体"，直接进入可执行态。
   - 风格 / 镜头 / 光影 / 色调 / 构图未指定：Planner 自主选择合理默认值。
   - 城市 / 天气 / 季节 / 时间未指定：Planner 自主选择合理默认值。
   - 数量未指定：默认 1 张。
3. 反例：禁止因为"东京还是大阪？"、"白天还是夜晚？"、"男性还是女性？"等可合理自动补全的信息而 clarification。
4. 反例：禁止把"画一张日本街道夜景"、"画一张赛博朋克城市"、"画一张死神的动漫人物全画像"判成 needs_clarification。
   这些都是合法的可执行任务。

== Clarification 续接（关键，必须严格遵守）==
- 如果 user prompt 中出现 "[任务补充上下文]" 段落，意味着用户上一轮的输入信息不足，本轮的内容是用户对 Planner 上一轮 clarification_question 的回答。
- 必须把"原始任务 + 上一轮缺失信息 + 用户本轮补充"视为**同一个任务的完整描述**进行规划，不要再当成独立新任务。
- **绝对不允许再次询问用户已经在补充回答里给出的信息**。例如用户已经回答"黑崎一护"，禁止再问"请指定具体角色"。

== 任务类型判定（intent / api_kind）==
- CREATE_IMAGE / generation：用户想从零开始生成一张全新的图片（例如"再生成一张故宫雪景图""新做一张海报"）。即使当前会话已经有成功图片，只要用户语义是"再生成 / 新做一张 / 来一张全新的"，必须判定为 generation，并把 source_image_id 设为 null。
- EDIT_IMAGE / edit：以下任一条件成立时判定为 edit：
  · current_active_image 存在且用户语义是修改当前画面（例如"把那艘小船去掉""把天空改成晚霞""把雷峰塔放大一些"），source_image_id 指向 current_active_image.image_id；
  · user_attachments.count > 0 且用户输入含编辑动词（去掉/修改/替换/裁切/去水印等），source_image_id 指向 user_attachments 中的第一张图；
  · 用户输入是"参考这张图按这个风格生成一张新的"，source_image_id 指向 user_attachments 中的第一张图（参考图生成也走 edit api）。
- REMOVE_BACKGROUND / remove_background：用户明确要求抠图、去背景、透明背景。
- UPSCALE / upscale：用户明确要求高清放大。
- 当用户输入模糊（例如"改一下""继续"），如果 current_active_image 存在或 user_attachments.count > 0，默认按 edit 处理；否则按 needs_clarification 处理。

== 多轮上下文继承（关键，必须严格遵守）==
- 如果 user prompt 中出现 "[任务上下文继承]" 段落，必须严格按照该段落里的 work_title / primary_subject / pronoun_bindings / augmentations 来生成 final_prompt。
- 例如 augmentation_detected=true 且 primary_subject="萌王/利姆鲁"、pronoun_bindings 含 "他"→"萌王/利姆鲁"，则 final_prompt 必须把"他/原型态"理解为"该角色的史莱姆原型态"，而不是把"他"展开成无关物体或新角色。
- 如果 inherited_from_previous_turn=true，final_prompt 中必须保留作品出处（work_title）和主体角色（primary_subject），即使当前消息里没有再次出现这些词。
- augmentation_detected=true 时禁止把当前消息作为独立新任务处理。

== 对话转任务上下文（关键，必须严格遵守）==
- 如果 user prompt 中出现 "[对话转任务上下文]" 段落，意味着当前任务来自聊天对话的执行请求，段落中给出了候选实体 / 布局 / 继承的提示词。
- 当用户出现"这些 / 上面这些 / 刚才那些 / 就按这些"等表达时，视为引用该段落中的候选实体（entities），不要要求用户重新列出已经存在于 context 中的内容。
- 如果段落中出现 "顺序实体选择"，说明用户所说"前3个"等顺序引用已经解析成确定主体列表；final_prompt 必须逐格绑定这些主体（第1格=第1个主体……），禁止泛化成"几种山景"这类模糊描述，禁止替换成其他实体。
- 如果候选实体数略多于布局容量（例如 10 个实体对应 9 格宫格），必须自主筛选最具代表性的实体填满布局，不要为此 clarification。
- 如果用户要求九宫格，必须规划为 3×3 composition：final_prompt 中明确描述九宫格布局（3 行 3 列，共 9 个格子），每个格子一个主体。
- 文生图请求（无 user_attachments 且无 current_active_image）不需要用户上传图片，直接按候选实体生成即可。

== 单张复合构图 vs 批量多图（关键，必须严格遵守）==
- 当用户描述"一张图里展示多个内容 / 三分镜 / 三联画 / 九宫格 / 拼图海报 / 同一画面多个主体 / 左中右分区"时，必须解释为**单张复合构图**：输出 1 张图，图内包含多个分格，每格一个主体。
- "3分镜" ≠ 生成 3 张图；"九宫格" ≠ 生成 9 张图。
- 只有用户明确要求"生成 N 张 / 出 N 个版本 / 每个来一张 / 分别做 N 张"时才是批量多图输出。
- 单张复合构图任务的 final_prompt 必须明确描述：分格布局（横向三分镜 / N×M 宫格 / 左中右分屏）、每格绑定的具体主体、整图统一的风格与色调。
- 如果 user prompt 中出现 "[任务修订上下文]" 段落，说明用户修正了此前被误规划的任务（例如"我不要批量任务 我要单张"）。必须按修订后的形态重新规划：输出数量 1 张、无任何批量子任务结构，final_prompt 明确描述单张图内部的分格布局。不要再次输出批量结构。

== final_prompt 规则 ==
1. final_prompt 必须是基于用户原始需求扩展后的完整图片提示词，包含：主体、构图、风格、光影、背景、文字布局、清晰度、限制项等要素。
2. 当用户原始需求已经足够完整（例如已经写明主体、风格、光影、构图、比例和限制项），允许 final_prompt 与原话相同或几乎相同；此时不要为了"必须改写"而强行扩写。
3. 同时严禁改变用户明确指定的核心文案、核心主体或否定要求。
4. 如果用户提供了必须出现的文字内容（标题、广告语、商品名等），把这些文字作为必须严格保留的文字内容写入 final_prompt，并要求图模型不得自行添加其他无关文字。
5. final_negative_prompt 用于填写负面提示词，例如：乱码、错误文字、重复字符、模糊、畸形、低分辨率、过度油画质感等。**必须是字符串**，不能是数字或布尔值；如果没有负面项请输出空字符串 ""。
6. final_prompt 也**必须是字符串**，不能是数字 / 布尔 / 数组。
7. 对于 EDIT_IMAGE，final_prompt 中必须明确"保持源图主体、构图、风格、光照、透视不变，仅做用户要求的局部修改"，并要求处理自然无痕。
8. final_prompt 与 final_negative_prompt 一律使用简体中文（专有名词 / 品牌名可保留原文）；即使用户输入是英文，输出仍为简体中文；禁止自动翻译成英文，禁止中英双份输出。

== 输出结构（必须严格 JSON）==
{
  "intent": "CREATE_IMAGE | EDIT_IMAGE | REMOVE_BACKGROUND | UPSCALE",
  "task_type": "generation | edit | remove_background | upscale",
  "confidence": 0-1,
  "needs_clarification": true | false,
  "clarification_question": "...",
  "recommended_action": "...",
  "should_propose_execution": true | false,
  "title": "任务标题（10-20 字）",
  "raw_prompt": "用户原话",
  "final_prompt": "优化后的完整图片提示词（必须是字符串）",
  "final_negative_prompt": "负面提示词（必须是字符串，可为空）",
  "api_kind": "generation | edit | remove_background | upscale",
  "source_image_id": "current_active_image.image_id 或 user_attachments 第一张 id 或 null",
  "execution_model": "gpt-image-2",
  "size": "1024x1024"
}

只输出合法 JSON 对象，不要输出 markdown、代码块或额外解释。`;

function resolveApiKind(intent: string, hasEditableImage: boolean): PlannerApiKind {
  const normalized = String(intent || '').toLowerCase();
  if (normalized === 'remove_background') return 'remove_background';
  if (normalized === 'upscale') return 'upscale';
  if (
    normalized === 'image_edit' ||
    normalized === 'edit_image' ||
    normalized === 'edit' ||
    (hasEditableImage && normalized !== 'image_generate' && normalized !== 'create_image' && normalized !== 'generation')
  ) {
    return 'edit';
  }
  return 'generation';
}

/**
 * 编辑意图关键词 —— 命中任一就视为"用户在请求修改 / 移除 / 替换现有图片内容"。
 * 与 PLANNER_SYSTEM_PROMPT 中告知 Planner 的关键词集合保持同步。
 */
const IMAGE_EDIT_INTENT_PATTERN = /(去掉|去除|删除|移除|擦除|修掉|修一下|修复|修改|改成|换成|替换|裁切|裁剪|放大|补全|去水印|去\s*id|去文字|保留主体|保留人物|保留脸|重绘|抠图|扣图|透明背景|去背景)/i;

/**
 * 参考图生成意图关键词 —— 命中任一就视为"用户上传图作为参考，要求生成新图"。
 */
const IMAGE_REFERENCE_INTENT_PATTERN = /(参考这张|参考这个|参考一下|按这张|按照这张|基于这张|用这张|参考风格|参考一下风格|借鉴|仿照)/i;

/**
 * 图片分析意图关键词 —— 命中任一就视为"用户希望模型读图后回答，而不是出图"。
 */
const IMAGE_ANALYSIS_INTENT_PATTERN = /(这张图是什么|分析这张|识别这张|描述这张|图里有什么|看一(?:下|眼)?这张|解释这张)/i;

/**
 * 基于用户当轮输入 + 附件信息，本地推断一个细粒度任务类型。
 *
 * 用途：
 *   1. UI 展示层用（确认卡 / 历史记录 / 任务详情）。
 *   2. 作为 Planner 判定的健康度检查 —— 当本地推断和 Planner 判定明显冲突时，
 *      上层可以选择信任本地推断（例如 Planner 把"用户上传图 + 去除ID"误判为 text_to_image）。
 *
 * 注意：这个函数只看"语义 + 附件数量"，不依赖任何 LLM 调用结果。
 */
export function resolveTaskKindLocally(input: {
  text: string;
  hasUserAttachments: boolean;
  hasActiveImage: boolean;
}): ResolvedTaskKind {
  const text = (input.text || '').trim();
  if (!text) return 'unknown';

  // 1. 图片分析（必须在最前 —— "这张图是什么"远比 edit 更优先）
  if ((input.hasUserAttachments || input.hasActiveImage) && IMAGE_ANALYSIS_INTENT_PATTERN.test(text)) {
    return 'image_analysis';
  }

  // 2. 用户已上传图 + 编辑动词 → 图片编辑
  if (input.hasUserAttachments && IMAGE_EDIT_INTENT_PATTERN.test(text)) {
    return 'image_edit';
  }

  // 3. 用户已上传图 + 参考动词 → 参考图生成
  if (input.hasUserAttachments && IMAGE_REFERENCE_INTENT_PATTERN.test(text)) {
    return 'image_reference_generation';
  }

  // 4. 用户已上传图但措辞模糊 —— 默认按图片编辑（而不是文生图！）
  //    以前这里会被错误地退化为 text_to_image，导致 UI 把"用户上传图的任务"显示成"文生图"。
  if (input.hasUserAttachments) {
    return 'image_edit';
  }

  // 5. 没有附件但有 active image + 编辑动词 → 图片编辑
  if (input.hasActiveImage && IMAGE_EDIT_INTENT_PATTERN.test(text)) {
    return 'image_edit';
  }

  // 6. 没有附件，也没有 active image，但出现编辑动词 —— 不应退化为文生图。
  //    由 Planner 进入 needs_clarification 询问用户上传图片。这里先返回 unknown，由 UI 显示模糊态。
  if (!input.hasUserAttachments && !input.hasActiveImage && IMAGE_EDIT_INTENT_PATTERN.test(text)) {
    return 'unknown';
  }

  // 7. 默认按文生图
  return 'text_to_image';
}

/**
 * 把 ResolvedTaskKind 翻译成 UI 文案。TaskMessageCard / 历史记录 / 任务详情共用。
 */
export function resolvedTaskKindLabel(kind: ResolvedTaskKind | string | undefined): string {
  switch (kind) {
    case 'text_to_image': return '文生图';
    case 'image_edit': return '图片编辑';
    case 'image_reference_generation': return '参考图生成';
    case 'image_analysis': return '图片分析';
    case 'unknown': return '任务识别中';
    default: return '';
  }
}

function resolveTaskType(apiKind: PlannerApiKind): PlannerTaskType {
  if (apiKind === 'remove_background') return 'remove_background';
  if (apiKind === 'edit') return 'edit';
  return 'generate';
}

/**
 * 规划失败阶段的人类可读中文标签 —— 与后端 error_kind 一一对应。
 * 用于 UI 失败卡顶部的"失败阶段"展示，让用户能立刻看到问题出在哪一步。
 */
export function plannerErrorStageLabel(errorKind?: string): string {
  switch (errorKind) {
    case 'connect':
    case 'timeout':
    case 'transport':
      return '规划模型请求';
    case 'auth':
    case 'rate_limit':
    case 'server':
    case 'invalid_request':
    case 'invalid_response':
    case 'upstream_api':
    case 'upstream_error':
      return '规划模型请求';
    case 'model_error':
    case 'model_incompatible':
    case 'multimodal_unsupported':
    case 'json_output_unsupported':
      return '模型兼容性';
    case 'response_text_missing':
    case 'response_incomplete':
      return '模型输出读取';
    case 'provider_response_payload_missing':
      return '模型输出恢复';
    case 'planner_json_parse_failed':
      return '规划结果解析';
    case 'planner_schema_invalid':
      return '任务结构校验';
    default:
      return '规划阶段';
  }
}

/**
 * 规划失败原因的简短中文文案 —— 与 errorKind 对应，用于 UI 失败卡的"原因"行。
 *
 * 当 errorKind === 'upstream_error' 且 diagnostic 里带有真实上游 message 时，
 * 调用方应该传入 `upstreamMessage`（详见 plannerErrorReasonForDiagnostic），
 * 这里只在缺省时退回到通用文案。
 */
export function plannerErrorReason(errorKind?: string, fallback?: string): string {
  switch (errorKind) {
    case 'connect':
    case 'timeout':
    case 'transport':
      return '无法连接规划模型服务，请检查网络或 Agent Base URL。';
    case 'auth':
      return 'Agent Token 鉴权失败，请检查 Token 是否有效。';
    case 'rate_limit':
      return '规划模型被限流，请稍后重试。';
    case 'server':
      return '规划模型服务异常，请稍后重试。';
    case 'invalid_request':
    case 'invalid_response':
    case 'upstream_api':
    case 'upstream_error':
      return '规划模型上游返回了错误，请查看规划详情或稍后重试。';
    case 'model_error':
    case 'model_incompatible':
    case 'multimodal_unsupported':
    case 'json_output_unsupported':
      return '当前模型无法用于 Agent 任务规划，请在「设置与更新 → AI 智能体」切换为支持 JSON 输出的对话模型。';
    case 'response_text_missing':
      return '规划模型没有返回可解析文本（可能是推理消耗了输出预算，已自动重试一次）。';
    case 'response_incomplete':
      return '规划模型本轮输出被截断（max_output_tokens 不足或被安全策略中断）。';
    case 'provider_response_payload_missing':
      return '规划模型请求已完成并记录了输出 Token，但当前模型服务没有返回可读取的文本内容。CyImagePro 已尝试恢复响应（Retrieve + SSE Streaming），但仍未获取到 Planner 输出。建议更换模型或模型服务后重新规划。';
    case 'planner_json_parse_failed':
      return '规划模型返回了内容，但不是合法任务 JSON。';
    case 'planner_schema_invalid':
      return '规划结果缺少必要字段或字段格式错误。';
    case 'planner_job_missing_same_session':
      return '规划任务状态异常（同一会话内找不到运行中的 PlannerJob），请重新规划。';
    case 'planning_interrupted_app_restart':
      return '上一次任务规划因应用退出而中断，请重新规划。';
    default:
      return fallback || '任务规划失败，请稍后重试或修改描述。';
  }
}

/**
 * 当 errorKind === 'upstream_error' 时，结合真实上游 message / code 生成主卡文案。
 * 优先展示上游自己的话（截断 1~2 行），让用户立刻知道是参数错 / 模型不支持 / 还是临时问题；
 * 没有上游 message 时才退回到通用"上游返回错误"。
 */
export function plannerUpstreamErrorSummary(opts: {
  message?: string;
  code?: string;
  type?: string;
  param?: string;
}): string | null {
  const message = (opts.message || '').trim();
  const code = (opts.code || '').trim();
  const param = (opts.param || '').trim();
  if (!message && !code && !param) return null;
  const truncate = (s: string, n: number) => {
    const chars = Array.from(s);
    return chars.length <= n ? s : `${chars.slice(0, n).join('')}…`;
  };
  if (message) {
    const suffix = param ? `（param=${param}）` : code ? `（code=${code}）` : '';
    return `${truncate(message, 160)}${suffix}`;
  }
  // message 缺失，至少把 code/param 抛出来
  const meta = [code && `code=${code}`, param && `param=${param}`].filter(Boolean).join(', ');
  return meta ? `规划模型上游返回错误：${meta}` : null;
}

/**
 * Retry 决策 —— Rust 端已经按相同规则在 run_agent_request 里实施了一次自动重试。
 * TS 端的这层判断主要用于 UI（决定是否提示"继续重试不会解决此错误"），
 * 以及未来如果需要在前端发起二次重试时复用。
 *
 *   - unsupported_parameter / invalid_request / model_not_found / auth / 内容策略 → 不允许 retry
 *   - server_error / temporarily_unavailable / rate_limit → 允许 retry
 *   - response_text_missing / response_incomplete → 允许 retry（已在 Rust 端 retry 过一次）
 *   - 未知 → 保守不 retry
 */
export function isPlannerErrorRetryable(
  errorKind: string | undefined,
  upstream?: { code?: string; type?: string },
): boolean {
  if (errorKind === 'response_text_missing' || errorKind === 'response_incomplete') return true;
  // provider_response_payload_missing：Recovery 流水线（Retrieve + SSE）已经跑完，
  // 再自动 retry 只会重复消耗 token。允许用户手动重新规划（前端按钮），但禁止自动重试。
  if (errorKind === 'provider_response_payload_missing') return false;
  if (errorKind === 'connect' || errorKind === 'timeout' || errorKind === 'server') return true;
  if (errorKind === 'rate_limit') return true;
  if (errorKind === 'upstream_error') {
    const code = (upstream?.code || '').toLowerCase();
    const type = (upstream?.type || '').toLowerCase();
    const retryable = [
      'server_error', 'temporarily_unavailable', 'service_unavailable',
      'internal_error', 'rate_limit_exceeded', 'rate_limit', 'overloaded',
      'bad_gateway', 'gateway_timeout',
    ];
    const hardFail = [
      'unsupported_parameter', 'invalid_request', 'invalid_request_error',
      'model_not_found', 'model_endpoint_unsupported',
      'authentication_error', 'permission_error',
      'content_policy_violation', 'billing_hard_limit_reached',
    ];
    if (retryable.includes(code) || retryable.includes(type)) return true;
    if (hardFail.includes(code) || hardFail.includes(type)) return false;
    return false;
  }
  return false;
}

/**
 * 创建一个 PLANNING_FAILED 结果。
 * 这是 Planner 调用失败时的唯一出口 —— 不允许把用户原话静默当作 optimizedPrompt 返回。
 * 上层会基于 planningFailed=true 进入 PLANNING_FAILED 卡片，禁止"确认执行"。
 */
export function planningFailedResult(
  input: TaskPlanInput,
  reason: string,
  diagnostic?: PlannerDiagnostic,
): TaskPlanResult {
  const roughIntent = classifyAgentIntent({
    text: input.text,
    hasImageAttachments: input.hasEditableImage ?? false,
    hasEditableImage: input.hasEditableImage ?? false,
    planOnly: false,
  });
  const apiKind = resolveApiKind(roughIntent, !!input.hasEditableImage);
  const taskType = resolveTaskType(apiKind);
  const errorKind = (diagnostic?.errorKind || undefined) as PlannerErrorKind | undefined;
  // 仅在真实 Provider 调用失败（带 diagnostic）时归因到 Provider；
  // 「输入为空 / 模型未配置」等本地校验失败不套用 Provider 前缀。
  const providerPrefix = input.providerFailure && diagnostic
    ? `${providerFailureLabel(input.providerFailure.providerType, input.providerFailure.providerName)} 请求失败：`
    : '';
  const friendlyReason = `${providerPrefix}${
    diagnostic?.errorKind
      ? plannerErrorReason(diagnostic.errorKind, reason)
      : reason
  }`;
  return {
    taskType,
    apiKind,
    intent: roughIntent,
    confidence: 0,
    needsClarification: false,
    recommendedAction: '',
    rawPrompt: input.text,
    optimizedPrompt: '',
    negativePrompt: '',
    executionModel: DEFAULT_EXECUTION_MODEL,
    agentModel: input.agentModel || '(未选择模型)',
    usedLocalFallback: false,
    planningFailed: true,
    errorMessage: friendlyReason || '任务规划失败，请稍后重试或修改描述。',
    sourceImageId: input.activeImageId ?? null,
    sourceImagePath: input.activeImagePath ?? null,
    plannerDiagnostic: diagnostic
      ? {
          model: diagnostic.model || input.agentModel,
          transport: diagnostic.transport,
          errorKind: diagnostic.errorKind,
          errorStage: diagnostic.errorStage || plannerErrorStageLabel(diagnostic.errorKind),
          reason: diagnostic.reason || friendlyReason,
          httpStatus: diagnostic.httpStatus ?? null,
          rawOutput: diagnostic.rawOutput,
          parserError: diagnostic.parserError,
          responsesShape: diagnostic.responsesShape,
          // 关键：把上游真实 message/type/code/param 一起带到 UI，
          // 这样"查看规划详情"才能告诉用户 gpt-5.6-luna 真正为什么失败。
          upstreamErrorMessage: diagnostic.upstreamErrorMessage
            ?? diagnostic.responsesShape?.upstreamErrorMessage,
          upstreamErrorType: diagnostic.upstreamErrorType
            ?? diagnostic.responsesShape?.upstreamErrorType,
          upstreamErrorCode: diagnostic.upstreamErrorCode
            ?? diagnostic.responsesShape?.upstreamErrorCode,
          upstreamErrorParam: diagnostic.upstreamErrorParam
            ?? diagnostic.responsesShape?.upstreamErrorParam,
          recovery: diagnostic.recovery,
        }
      : undefined,
  };
}

export async function planTaskWithAgent(input: TaskPlanInput): Promise<TaskPlanResult> {
  const raw = (input.text || '').trim();
  if (!raw) {
    return planningFailedResult(input, '输入为空，无法规划任务。');
  }
  if (!input.agentToken || !input.agentModel || !input.agentBaseUrl) {
    return planningFailedResult(input, 'Agent 规划模型未配置（token / model / base_url 缺失），请在「设置与更新 → AI 智能体」完成配置后再试。');
  }

  const roughIntent = classifyAgentIntent({
    text: raw,
    hasImageAttachments: input.hasEditableImage ?? false,
    hasEditableImage: input.hasEditableImage ?? false,
    planOnly: false,
  });

  // 把当前会话上下文（activeImageId 等）显式注入到 user prompt 中。
  // 这样模型不需要依赖额外的私有协议字段，也能正确判定 CREATE_IMAGE vs EDIT_IMAGE。
  const contextBlock = input.activeImageId
    ? `\n[当前会话上下文]\n- current_active_image: { image_id: "${input.activeImageId}", path: "${input.activeImagePath || ''}", title: "${input.activeImageTitle || ''}", last_task_type: "${input.activeImageTaskType || ''}" }\n- 用户当前输入若语义是修改/移除/替换/调整这张图片，必须判定为 EDIT_IMAGE 并把 source_image_id 设为 "${input.activeImageId}"。\n- 用户当前输入若语义是"再生成一张全新的图"，必须判定为 CREATE_IMAGE 并把 source_image_id 设为 null。\n`
    : `\n[当前会话上下文]\n- current_active_image: null\n- 当前没有"上一轮成功图"作为可被编辑的源图。\n- 但如果用户当轮已经上传了图片（user_attachments.count > 0），仍然允许判定为 EDIT_IMAGE，source_image_id 指向 user_attachments 中第一张。\n`;

  // 用户当轮上传的附件 —— 必须显式告诉 Planner 用户究竟传了几张、叫什么文件。
  // 以前这里被硬编码成 []，导致"用户上传图 + 去除左下角 ID"这种场景下 Planner 不知道用户已经准备好图了。
  const attachmentNames = (input.attachmentNames || []).filter(Boolean);
  const userAttachmentCount = attachmentNames.length;

  // 关键：图片附件语义映射（图一 / 图二 / 图三）—— 让 Planner 真正能解析
  // 用户在自然语言里的 "图二的人物 / 参考图一的构图" 这种引用。
  // descriptors 由调用方按 Composer 选择顺序构建，与真实图片附件传给执行 API
  // 的 images 数组顺序保持一致，不允许错位。
  const attachmentDescriptors: PlannerAttachmentDescriptor[] =
    input.attachmentDescriptors && input.attachmentDescriptors.length > 0
      ? input.attachmentDescriptors
      : buildAttachmentDescriptors(
          (input.attachmentNames || []).map((name, idx) => ({
            id: `att_planner_${idx}_${Math.random().toString(36).slice(2, 6)}`,
            source: 'unknown',
            name,
          })),
        );

  const semanticMappingBlock = renderAttachmentMappingForPlanner(attachmentDescriptors);

  const attachmentBlock = userAttachmentCount > 0
    ? `\n[用户当轮上传的附件]\n- user_attachments: { count: ${userAttachmentCount} }\n- 这些图片是用户在当前这一轮明确上传的，必须视为任务语义的一部分。\n- 用户引用 "图一 / 图二 / 第一张图 / 第二张" 时，必须严格对应 "${semanticMappingBlock ? '图片附件语义映射' : '选择顺序'}" 中的编号，不要根据文件名自行猜测。\n- 如果用户输入含编辑动词（去掉/修改/替换/去除/移除/擦除/裁切/去水印/去ID 等），必须判定为 EDIT_IMAGE，source_image_id 指向用户引用的那张图；用户没有显式指定时默认 "图一"。\n- 如果用户输入含参考动词（参考这张/参考风格/按这张做/基于这张生成），必须判定为 IMAGE_REFERENCE_GENERATION（task_type=edit，api_kind=edit），source_image_id 指向用户引用的那张图；用户没有显式指定时默认 "图一"。\n`
    : `\n[用户当轮上传的附件]\n- user_attachments: { count: 0 }\n- 用户本轮没有上传任何图片。\n- 此时如果用户输入含编辑动词（去掉/修改/替换 等），不允许判定为 EDIT_IMAGE，应判定为 needs_clarification=true 并询问"请上传需要处理的图片"。\n`;

  // 多轮上下文继承 —— augmentation / pronounBindings / workTitle 等。
  // 仅在 taskSemanticContext 真的有信号时才注入，避免污染单轮新任务。
  const semanticBlock = input.taskSemanticContext
    ? `\n${renderTaskSemanticContextForPlanner(input.taskSemanticContext)}\n`
    : '';

  // Chat → Task 语义 Handoff 上下文：实体列表 / 九宫格布局 / 继承提示词。
  const handoffBlock = input.chatHandoffContext
    ? `\n${renderChatHandoffContextForPlanner(input.chatHandoffContext)}\n`
    : '';

  const plannerUserText = `${contextBlock}${semanticMappingBlock}${attachmentBlock}${semanticBlock}${handoffBlock}\n[用户原始需求]\n${raw}\n`;

  let result: AgentRunRequestResult;
  try {
    console.log('[Planner] start', {
      agentModel: input.agentModel,
      hasEditableImage: !!input.hasEditableImage,
      activeImageId: input.activeImageId || null,
      userAttachmentCount,
      augmentationDetected: !!input.taskSemanticContext?.augmentationDetected,
      inheritedFromPreviousTurn: !!input.taskSemanticContext?.inheritedFromPreviousTurn,
      roughIntent,
    });
    result = await api.runAgentRequest({
      mode: 'plan_task',
      base_url: input.agentBaseUrl,
      token: input.agentToken,
      model: input.agentModel,
      billing_mode: input.agentBillingMode,
      system_prompt: PLANNER_SYSTEM_PROMPT,
      text: plannerUserText,
      has_images: !!input.hasEditableImage,
      editable_image_count: input.sourceImageCount ?? (input.hasEditableImage ? 1 : 0),
      attachment_names: attachmentNames,
      rough_intent: roughIntent,
    }) as AgentRunRequestResult;
  } catch (err: any) {
    console.warn('[Planner] failed (throw)', err?.message);
    const kind = (err?.kind as PlannerErrorKind | undefined) || 'transport';
    return planningFailedResult(input, err?.message || 'Agent 调用异常，请稍后重试。', {
      model: input.agentModel,
      transport: undefined,
      errorKind: kind,
      errorStage: plannerErrorStageLabel(kind),
      reason: plannerErrorReason(kind, err?.message),
      httpStatus: err?.status ?? null,
      rawOutput: undefined,
      parserError: undefined,
    });
  }

  if (!result.ok) {
    console.warn('[Planner] failed (upstream)', {
      errorKind: result.error_kind,
      errorMessage: result.error_message,
      hasRawOutput: !!result.planner_raw_output,
      parserError: result.planner_parser_error,
      transport: result.planner_transport,
      responsesShape: result.planner_diagnostic,
      recovery: result.planner_recovery,
    });
    const kind = (result.error_kind || '') as PlannerErrorKind | string;
    const friendly = plannerErrorReason(kind, result.error_message);
    const transport = result.planner_transport === 'chat_completions'
      ? 'chat_completions'
      : result.planner_transport === 'responses'
        ? 'responses'
        : undefined;
    return planningFailedResult(input, friendly, {
      model: input.agentModel,
      transport,
      errorKind: kind,
      errorStage: plannerErrorStageLabel(kind),
      reason: friendly,
      httpStatus: result.status ?? null,
      rawOutput: result.planner_raw_output,
      parserError: result.planner_parser_error,
      responsesShape: result.planner_diagnostic,
      // 透传上游真实 message / type / code / param —— 这正是 gpt-5.6-luna HTTP 200 + upstream_error
      // 场景下用户最想看到的字段，不再让它被吞掉只剩一个 "upstream_error" 标签。
      upstreamErrorMessage: result.planner_diagnostic?.upstreamErrorMessage,
      upstreamErrorType: result.planner_diagnostic?.upstreamErrorType,
      upstreamErrorCode: result.planner_diagnostic?.upstreamErrorCode,
      upstreamErrorParam: result.planner_diagnostic?.upstreamErrorParam,
      // Payload Recovery 轨迹：让前端"查看规划详情"展示 Primary/Retrieve/Stream 各阶段结果。
      recovery: result.planner_recovery as ResponsesRecoveryTrace | undefined,
    });
  }

  const intent = String(result.intent || roughIntent);
  const apiKind = resolveApiKind(intent, !!input.hasEditableImage);
  const taskType = resolveTaskType(apiKind);
  // 关键：用类型安全的 normalizer。Planner 偶尔会返回 number/bool 类型的
  // final_prompt / final_negative_prompt（例如 "final_negative_prompt": 1），
  // 旧实现 String(value) 会渲染成 "1" / "true"，这里直接 normalize 成空。
  const optimizedPromptRaw = normalizePromptString(result.final_prompt);
  const negativePromptRaw = normalizePromptString(result.final_negative_prompt);
  const optimizedPrompt = optimizedPromptRaw;
  const negativePrompt = negativePromptRaw;

  // 诊断：如果 Planner 给了非字符串的 final_negative_prompt（数字 / bool / 数组），
  // 打一条 warning 让开发态能立刻看到污染源，但不要把这种异常值带到 UI。
  if (
    result.final_negative_prompt !== undefined
    && result.final_negative_prompt !== null
    && typeof result.final_negative_prompt !== 'string'
  ) {
    console.warn('[Planner] non-string final_negative_prompt discarded', {
      valueType: typeof result.final_negative_prompt,
      valuePreview: String(result.final_negative_prompt).slice(0, 80),
    });
  }
  if (
    result.final_prompt !== undefined
    && result.final_prompt !== null
    && typeof result.final_prompt !== 'string'
  ) {
    console.warn('[Planner] non-string final_prompt discarded', {
      valueType: typeof result.final_prompt,
      valuePreview: String(result.final_prompt).slice(0, 80),
    });
  }

  // Planner 调用成功，但模型没有给出可用的 final_prompt —— 视为规划失败。
  // 注意：optimizedPrompt === raw 不再视为失败。用户原始需求可能已经足够完整，
  // 模型判断无需扩写时可能输出与原话一致甚至相同的提示词，这是合法结果。
  if (!optimizedPrompt) {
    console.warn('[Planner] failed (empty optimizedPrompt)', { raw: raw.slice(0, 60) });
    const kind = 'planner_schema_invalid' as PlannerErrorKind;
    return planningFailedResult(
      input,
      '规划模型没有输出有效的优化提示词，请重试或换一种描述。',
      {
        model: input.agentModel,
        transport: result.planner_transport === 'chat_completions'
          ? 'chat_completions'
          : result.planner_transport === 'responses'
            ? 'responses'
            : undefined,
        errorKind: kind,
        errorStage: plannerErrorStageLabel(kind),
        reason: '规划模型返回的 JSON 缺少 final_prompt 字段或字段为空。',
        httpStatus: null,
        rawOutput: result.planner_raw_output,
        parserError: undefined,
        responsesShape: result.planner_diagnostic,
      },
    );
  }
  if (optimizedPrompt === raw) {
    console.log('[Planner] optimizedPrompt unchanged from rawPrompt (still valid)');
  }

  // Planner 是分流的唯一权威：sourceImageId 必须与 Planner 自己判定的 taskType 一致。
  // - generation: 即使会话存在 activeImageId，也必须返回 null，避免上层把 GENERATION 误改成 EDIT。
  // - edit / remove_background: 保留 activeImageId 作为源图，供上层校验。
  const plannerSourceImageId = taskType === 'generate' ? null : (input.activeImageId ?? null);
  const plannerSourceImagePath = taskType === 'generate' ? null : (input.activeImagePath ?? null);

  // ============== 健康度检查（修复"上传图 + 编辑动词"被误判为 generation 的根因）==============
  // 旧链路只依赖 Planner 自报的 taskType。但 Planner 在某些场景下仍然会把"用户上传图 + 去除ID"
  // 错判成 text_to_image —— 因为我们以前没把附件信息真正传给 Planner，或者模型本身偏向于
  // "看到不带图链接的文本就认为是文生图"。
  //
  // 现在我们已经在 user prompt 里显式告诉 Planner 用户传了几张图（user_attachments 段）。
  // 这里再加一层 sanity check：本地推断 = image_edit 但 Planner 判 generate 时，
  // 强制把 taskType 改回 edit（并把 source 指向 user_attachments 的第一张），并打印一条警告。
  const localResolvedKind = resolveTaskKindLocally({
    text: raw,
    hasUserAttachments: (input.attachmentNames || []).length > 0,
    hasActiveImage: !!input.activeImageId,
  });
  const attachmentPaths = (input.attachmentNames || []).filter(Boolean);
  let effectiveTaskType = taskType;
  let effectiveApiKind = apiKind;
  let effectiveSourceImageId = plannerSourceImageId;
  let effectiveSourceImagePath = plannerSourceImagePath;
  if (
    taskType === 'generate'
    && (localResolvedKind === 'image_edit' || localResolvedKind === 'image_reference_generation')
    && attachmentPaths.length > 0
  ) {
    console.warn('[Planner] sanity check: overriding generate → edit (user has attachment + edit/reference intent)', {
      localResolvedKind,
      plannerIntent: intent,
      attachmentCount: attachmentPaths.length,
    });
    effectiveTaskType = 'edit';
    effectiveApiKind = 'edit';
    // 用户上传的图（attachmentNames 通常带路径或文件名，由调用方传入）。
    // 优先用 attachment 的第一项作为 source —— 上层 planTaskCore 已经把 attachmentPaths 一并传过来，
    // 它们和 sourceImageCount 是同源数据。
    effectiveSourceImageId = effectiveSourceImageId || attachmentPaths[0];
    effectiveSourceImagePath = effectiveSourceImagePath || attachmentPaths[0];
  }

  console.log('[Planner] success', {
    intent,
    apiKind: effectiveApiKind,
    taskType: effectiveTaskType,
    localResolvedKind,
    finalPrompt: optimizedPrompt.slice(0, 60),
    usedLocalFallback: !!result.used_local_fallback,
    sourceImageId: effectiveSourceImageId,
  });

  return {
    taskType: effectiveTaskType,
    apiKind: effectiveApiKind,
    intent,
    confidence: Number(result.confidence ?? 0.7),
    needsClarification: !!result.needs_clarification,
    clarificationQuestion: result.clarification_question || undefined,
    recommendedAction: String(result.recommended_action || ''),
    rawPrompt: raw,
    optimizedPrompt,
    negativePrompt,
    executionModel: DEFAULT_EXECUTION_MODEL,
    agentModel: input.agentModel,
    usedLocalFallback: !!result.used_local_fallback,
    sourceImageId: effectiveSourceImageId,
    sourceImagePath: effectiveSourceImagePath,
    resolvedTaskKind: localResolvedKind,
  };
}

