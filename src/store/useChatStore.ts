import { create } from 'zustand';
import type {
  AgentTaskDraft,
  AgentProposal,
  AgentRunRequestResult,
  AgentStyleTemplate,
  AgentTaskTemplate,
  ChatAttachment,
  ChatConversation,
  ChatMessage,
  ChatMode,
  CreateTaskParams,
  Task,
  TaskBatchItem,
  TaskBatchStrategy,
  TaskMessageImage,
  TaskMessageState,
  VisionUnderstandResult,
} from '../types';
import { api } from '../services/api';
import { serverApi } from '../services/serverApi';
import { useAuthStore } from './useAuthStore';
import { useSettingsStore } from './useSettingsStore';
import { useTaskStore, registerTaskRefreshHook } from './useTaskStore';
import { useImageStore } from './useImageStore';
import { explainError, isAuthError } from '../utils/errors';
import { authorizeImageTask, settleImageTask, createRequestId, registerTaskAuthorization } from '../services/billingService';
import { classifyAgentIntent } from '../utils/agentIntent';
import { resolveAgentConfig } from '../utils/agentConfig';
import { planTaskWithAgent, DEFAULT_EXECUTION_MODEL, type TaskPlanInput } from '../utils/agent/promptPlanner';
import { resolveTaskSemanticContext } from '../utils/agent/taskContextResolver';
import {
  detectChatExecutionIntent,
  resolveChatExecutionContext,
  renderChatHandoffContextForPlanner,
  type ResolvedChatExecutionContext,
} from '../utils/agent/chatExecutionContext';
import {
  resolveOutputStructure,
  parseOrderedEntitySelection,
} from '../utils/agent/compositionIntentResolver';
import {
  detectTaskRevisionIntent,
  buildTaskRevisionContinuationText,
} from '../utils/agent/taskRevision';
import { buildAttachmentDescriptors } from '../utils/agent/attachmentLabels';
import {
  resolveConversationSourceImage,
  type SourceImageSelection,
} from '../utils/agent/taskSourceImage';
import { extractDistinctObjects } from '../utils/generationIntent';
import { resolveByokAgentConfig, resolveByokConfigForUse } from '../features/aiProviders/store';
import { buildProviderError, providerErrorCompact } from '../features/aiProviders/providerError';
import { getAgentTemplateCache, setAgentTemplateCache } from '../utils/agent/templateCache';
import { isSyntheticAssistantMessage, sanitizeHistoryMessageContent, stripReasoningFromReply } from '../utils/agent/historySanitizer';
import {
  detectSkill,
  buildSkillSystemPrompt,
  type SkillId,
  type SkillRouteResult,
} from '../agent/skills';
import {
  serializeTaskMessageState,
  deserializeTaskMessageState,
  buildRecoveryFailedState,
} from '../utils/taskMessagePersist';

interface SendSettings {
  chat_token: string;
  token: string;
  chat_model: string;
  chat_base_url: string;
  chat_system_prompt: string;
  agent_token?: string;
  agent_model?: string;
  agent_base_url?: string;
  agent_system_prompt?: string;
  agent_context_window?: number;
  vision_model?: string;
}

interface SendOptions {
  planOnly?: boolean;
  attachments: ChatAttachment[];
}

type ConversationRuntime = {
  isSending: boolean;
};

type InterpretIntent =
  | 'chat'
  | 'gallery_search'
  | 'image_understanding'
  | 'image_generate'
  | 'image_edit'
  | 'remove_background'
  | 'upscale';

type InterpretResult = {
  intent: InterpretIntent;
  confidence: number;
  needs_clarification: boolean;
  clarification_question?: string;
  recommended_action: string;
  should_propose_execution: boolean;
  final_prompt: string;
  final_negative_prompt: string;
  api_kind?: 'generation' | 'edit' | 'remove_background' | 'upscale';
};

type BatchPlan = {
  executionMode: 'single' | 'batch';
  batchStrategy?: TaskBatchStrategy;
  targetCount: number;
  variationAxis?: string;
  taskPlanSummary?: string;
  sequenceMode?: 'connected_detail_sequence';
  needsClarification?: boolean;
  clarificationQuestion?: string;
  /** 单张复合构图的结构化表达（三分镜 / 宫格 / 分屏），executionMode='single' 时可携带。 */
  compositeLayout?: {
    type: 'triptych' | 'grid' | 'split_screen';
    panelCount: number;
  };
  /** 多对象差异化批量（"上海北京广州各一张"）——每个对象独立一张图，禁止合入同一画面。 */
  distinctObjects?: string[];
  /** 差异化批量标记：子任务 prompt_override 需附加"独立输出"保护。 */
  distinctBatch?: boolean;
};

type TemplateMatchResult = {
  taskTemplate: AgentTaskTemplate | null;
  styleTemplates: AgentStyleTemplate[];
  clarificationQuestion?: string;
};

type ConversationTransitionDecision =
  | { kind: 'execution_confirmation'; executionTarget: { messageId: string; proposal: AgentProposal } | null }
  | { kind: 'retry_submission' }
  | { kind: 'task_revision' }
  | { kind: 'new_task' }
  | { kind: 'follow_up' }
  | { kind: 'derive_from_completed' }
  | { kind: 'free_chat' };

function shouldInterpretIntent(intent: string, hasImages: boolean) {
  if (intent === 'chat') return hasImages;
  return ['gallery_search', 'image_understanding', 'image_generate', 'image_edit', 'remove_background', 'upscale'].includes(intent);
}

interface ChatState {
  conversations: ChatConversation[];
  activeId: string | null;
  runtimeById: Record<string, ConversationRuntime>;
  error: string | null;
  abortCtrls: Record<string, AbortController>;
  // 任务模式提交态：避免重复点击
  taskSubmitting: boolean;

  // Skill 相关状态
  skillMode: 'auto' | 'manual';
  selectedSkillId: SkillId | null;
  detectedSkillId: SkillId | null;
  lastSkillRoute: SkillRouteResult | null;

  loadConversations: () => Promise<void>;
  save: () => Promise<void>;
  saveConversation: (conversationId: string) => Promise<void>;
  scheduleSaveConversation: (conversationId: string, delayMs?: number) => void;
  /** 关闭顶部错误 Banner（非阻塞错误的-dismiss 入口；错误卡仍保留在消息流里） */
  dismissError: () => void;
  newConversation: () => string;
  switchConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  sendMessage: (text: string, settings: SendSettings, options: SendOptions) => Promise<void>;
  sendTaskMessage: (input: {
    text: string;
    settings: SendSettings;
    attachments: ChatAttachment[];
    mode?: ChatMode;
    /**
     * 显式触发"再来一张"时设为 true。
     * 该选项会让本轮规划彻底忽略会话里的 active_image_id —— 既不传给 Planner 作为上下文，
     * 也不会在 WAITING_CONFIRM 任务卡里保留任何源图字段。Planner 因此能够稳定判定 generation。
     */
    ignoreActiveImage?: boolean;
    /**
     * Chat → Task 语义 Handoff 上下文。
     * 由 sendMessage 在检测到"生成这些建筑的九宫格"这类执行型 + 指代型请求时传入，
     * 包含实体列表 / 布局 / 继承的提示词等，最终注入 Planner user prompt。
     */
    chatHandoffContext?: ResolvedChatExecutionContext;
    /**
     * 仅供 Planner 看到的文本（任务修订路径）：
     * "原任务 + 用户修订指令"的组合文本。提供时 UI 上仍显示用户原始输入，
     * 但 Planner 收到的是完整修订上下文。
     */
    plannerTextOverride?: string;
  }) => Promise<void>;
  confirmTaskMessage: (conversationId: string, taskId: string) => Promise<void>;
  cancelTaskMessage: (conversationId: string, taskId: string) => Promise<void>;
  editTaskMessage: (conversationId: string, taskId: string, finalPrompt: string, finalNegativePrompt?: string) => void;
  /**
   * 在原任务卡上重新调用 Planner。
   *
   * 参数：
   *   - newText：用户通过"修改任务"弹窗输入的全新需求文本。如果提供，
   *     会同时更新原 user message 内容、task_message.prompt 字段，并送入 Planner。
   *   - options.plannerTextOverride：仅供 Planner 看到的合并文本（clarification 续接路径），
   *     不会修改 user message / task_message.prompt。优先级高于 newText。
   *     当传入 plannerTextOverride 时，UI 上仍然展示原始任务，但 Planner 看到的是
   *     "原任务 + 上一轮 clarification + 用户本轮补充"的组合。
   *   - options.clarificationRound：当前澄清轮次；写入 applyPlannerOutcomeToTaskMessage，
   *     用于在再次进入 needs_clarification 时正确累加 attempt。
   */
  replanTaskMessage: (
    conversationId: string,
    taskId: string,
    settings: SendSettings,
    newText?: string,
    options?: {
      plannerTextOverride?: string;
      clarificationRound?: number;
    },
  ) => Promise<void>;
  retryTaskMessage: (conversationId: string, taskId: string) => Promise<void>;
  syncTaskMessage: (taskId: string, conversationId?: string) => Promise<void>;
  /**
   * 扫描所有会话中的任务卡，对所有带真实 taskId 的卡片强制按当前 TaskStore 同步一次。
   * 主要用途：
   *   - 用户从其它页面（图库 / 任务队列）切回 AI 智能体页面时
   *   - 应用窗口重新获得焦点 / 可见性变化
   *   - 历史会话恢复
   * 这里不依赖 task-updated 事件，是为了"事件丢失"或"持久化快照陈旧"场景兜底。
   */
  reconcileTaskMessages: (conversationId?: string) => Promise<void>;
  setConversationChatMode: (conversationId: string, mode: ChatMode) => void;
  /** 会话级 AI 智能体选择（profileId + modelId）；传 null 清除后回落到全局默认 Profile */
  setConversationAgentSelection: (conversationId: string, profileId: string | null, modelId: string | null) => void;
  setActiveTaskId: (conversationId: string, taskId: string | null) => void;
  setActiveImageId: (
    conversationId: string,
    imageId: string | null,
    localPath?: string | null,
    source?: 'explicit' | 'auto',
  ) => void;
  /**
   * 「切换图片」：把当前任务卡（waiting_confirm / planning_failed / needs_clarification）
   * 的源图快照切换为用户手动选择的图片。只覆盖当前任务，不污染会话默认规则。
   * waiting_confirm 的 edit 任务会同步替换 pendingParams.source_images[0]（编辑目标位）。
   */
  switchTaskSourceImage: (
    conversationId: string,
    taskId: string,
    image: { imageId: string; localPath?: string; url?: string; fileName?: string },
  ) => void;
  stopGeneration: (conversationId?: string) => void;
  confirmProposal: (conversationId: string, messageId: string, settings: SendSettings) => Promise<void>;
  cancelProposal: (conversationId: string, messageId: string) => Promise<void>;
  updateProposalPrompt: (conversationId: string, messageId: string, finalPrompt: string, finalNegativePrompt: string) => Promise<void>;
  toggleProposalBatchItem: (conversationId: string, messageId: string, itemId: string) => Promise<void>;

  // Skill 相关方法
  setSkillMode: (mode: 'auto' | 'manual') => void;
  setSelectedSkillId: (id: SkillId | null) => void;
}

const CONTEXT_TAIL_MESSAGES = 10;
/**
 * 多轮上下文继承：扫描最近多少条用户消息作为继承锚点。
 * 上限设为 8 —— 足够覆盖"主体描述 → 形态补充 → 细节调整"这种 2~3 轮的连续追问，
 * 又不会把很久以前的对话拉进来污染当前任务。
 */
const MAX_CONTEXT_LOOKBACK = 8;
const CONVERSATION_SAVE_DEBOUNCE_MS = 500;
const pendingConversationSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ============================================================================
// PlannerJob Registry —— 应用级 Planner 任务生命周期
// ----------------------------------------------------------------------------
// 历史问题：
//   - 旧版本只在 task_message 上挂一个 planningRequestId，异步 Promise 存在于
//     sendTaskMessage / replanTaskMessage 的 local scope 里。
//   - 用户切到任务队列 / 图库 / 设置再切回 AI 智能体时，Chat.tsx 重新 mount →
//     loadConversations() 把磁盘 snapshot 直接覆盖回内存，然后无脑把所有
//     stage='planning' 的卡降级成 planning_failed，理由是"应用重启后异步请求已丢失"。
//   - 但页面切换并不等于应用重启。HTTP 请求其实还在 store 的 floating Promise 里跑，
//     却已经被判了"中断"。
//
// 修复策略：
//   - 用一个 module-level Map（PlannerJob Registry）记录"当前 app session 内还在跑 / 刚刚
//     跑完的 PlannerJob"。Registry 只活在内存里，进程退出即清空。
//   - 每个 TaskMessageState 持久化 plannerJobId + planningSessionId。
//   - loadConversations 读盘遇到 stage='planning' 时：
//       * 同 session + job 在 registry → 保持 planning（或按 job 终态应用结果）
//       * 同 session + job 不在 registry → 标记 planner_job_missing_same_session
//       * 不同 session（真正应用重启） → 标记 planning_interrupted_app_restart
//   - 这样"页面切换"和"应用重启"被严格区分，再也不可能因为切页面而误判中断。
// ============================================================================

/**
 * App 进程级唯一 session id。进程重启后会换一个新的值；
 * 用于区分"页面切换"（同 session）和"应用重启"（不同 session）。
 */
export const APP_SESSION_ID = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

export type PlannerJobStatus = 'running' | 'completed' | 'failed';

export interface PlannerJob {
  /** Job 主键，例如 PJ_1735742400000_abc123。和 task_message.plannerJobId 一一对应。 */
  id: string;
  /** 冗余记录，方便按消息反查（registry.lookupByMessage）。 */
  conversationId: string;
  messageId: string;
  /** 与 task_message.planningRequestId 同步，用于 staleness guard。 */
  planningRequestId: string;
  /** 第几次规划（首次=1，重新规划递增），仅用于诊断日志。 */
  planningAttempt: number;
  /** 本次规划用的 agent 模型，便于诊断 "重新规划换了模型" 场景。 */
  model: string;
  status: PlannerJobStatus;
  startedAt: number;
  finishedAt?: number;
  /**
   * Promise resolve 后存放最终 outcome，供 reconcile 在 race 场景下重放
   * （例如 disk snapshot 还是 planning，但 job 已经完成）。
   */
  outcome?: PlannerCoreOutcome;
  /** resolve 时应用的 prompt / planningAttempt / planningRequestId，重放时需要。 */
  appliedPrompt?: string;
  /** 自动清理定时器 handle，避免重复清理。 */
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

/** Registry 单例 —— 不放进 Zustand reactive state，避免每帧触发 re-render。 */
const plannerJobRegistry = new Map<string, PlannerJob>();

/** Job 完成后保留多久才允许清理，给 race 中的 loadConversations 一个查询窗口。 */
const PLANNER_JOB_RETENTION_MS = 30_000;

function generatePlannerJobId(): string {
  return `PJ_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 注册一个新的 running job。同一 messageId 上若已有旧 job，先取消其清理定时器。 */
function registerPlannerJob(job: {
  conversationId: string;
  messageId: string;
  planningRequestId: string;
  planningAttempt: number;
  model: string;
}): PlannerJob {
  const id = generatePlannerJobId();
  const entry: PlannerJob = {
    id,
    conversationId: job.conversationId,
    messageId: job.messageId,
    planningRequestId: job.planningRequestId,
    planningAttempt: job.planningAttempt,
    model: job.model,
    status: 'running',
    startedAt: Date.now(),
  };
  // 同一 message 上若残留旧 job（理论上不会，但防御性处理），先清掉它的清理定时器。
  for (const existing of plannerJobRegistry.values()) {
    if (existing.messageId === job.messageId && existing.id !== id && existing.cleanupTimer) {
      clearTimeout(existing.cleanupTimer);
    }
  }
  plannerJobRegistry.set(id, entry);
  console.log('[PlannerJob] register', {
    id,
    sessionId: APP_SESSION_ID,
    conversationId: job.conversationId,
    messageId: job.messageId,
    model: job.model,
    attempt: job.planningAttempt,
  });
  return entry;
}

/** 标记 job 进入终态。outcome 用于 reconcile 重放。 */
function settlePlannerJob(
  jobId: string | undefined,
  status: PlannerJobStatus,
  outcome: PlannerCoreOutcome | undefined,
  appliedPrompt?: string,
) {
  if (!jobId) return;
  const entry = plannerJobRegistry.get(jobId);
  if (!entry) {
    console.warn('[PlannerJob] settle: job not found', { jobId, status });
    return;
  }
  if (entry.status !== 'running') {
    // 已经 settle 过了，幂等忽略。
    return;
  }
  entry.status = status;
  entry.finishedAt = Date.now();
  entry.outcome = outcome;
  entry.appliedPrompt = appliedPrompt;
  console.log('[PlannerJob] settle', { jobId, status, outcomeKind: outcome?.kind });
  // 安排延迟清理。期间任何 loadConversations 都能查到 terminal status。
  entry.cleanupTimer = setTimeout(() => {
    plannerJobRegistry.delete(jobId);
    console.log('[PlannerJob] cleanup', { jobId });
  }, PLANNER_JOB_RETENTION_MS);
}

function getPlannerJob(jobId: string | undefined): PlannerJob | undefined {
  if (!jobId) return undefined;
  return plannerJobRegistry.get(jobId);
}

function findRunningPlannerJobByMessageId(messageId: string): PlannerJob | undefined {
  for (const job of plannerJobRegistry.values()) {
    if (job.messageId === messageId) return job;
  }
  return undefined;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function clearScheduledConversationSave(conversationId: string) {
  const timer = pendingConversationSaveTimers.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    pendingConversationSaveTimers.delete(conversationId);
  }
}

function buildPersistedMessage(message: ChatMessage): ChatMessage {
  // 任务卡的图片数组里如果带有 data URL，序列化后会变得非常大，导致会话文件膨胀且容易写入失败。
  // 这里只持久化图片的本地路径和元信息（localPath / id / 宽高 / 文件名），
  // 重新加载时通过 ImageAsset / read_image_data 重新生成 URL。
  const strippedTaskMessage = message.task_message
    ? {
        ...message.task_message,
        images: (message.task_message.images || []).map(img => ({
          id: img.id,
          url: '',
          thumbnailUrl: '',
          localPath: img.localPath,
          width: img.width ?? null,
          height: img.height ?? null,
          file_name: img.file_name,
          imageId: img.imageId,
        })),
        // orderedAttachments.preview 同样是 dataUrl，写入磁盘会膨胀；只保留 id / source / internalName。
        orderedAttachments: (message.task_message.orderedAttachments || []).map(att => ({
          id: att.id,
          source: att.source,
          internalName: att.internalName,
        })),
      }
    : message.task_message;

  // 用带 version + kind 的 envelope 包装，未来字段演化时可基于 version 做迁移。
  // Rust 端已经把 task_message 当作 serde_json::Value 透传，不会丢字段。
  const persistedTaskMessage = strippedTaskMessage
    ? serializeTaskMessageState(strippedTaskMessage)
    : undefined;

  return {
    id: message.id,
    role: message.role,
    content: message.content,
    images: [],
    reasoning: message.reasoning || '',
    reasoning_duration: message.reasoning_duration || '',
    generated_image: '',
    created_at: message.created_at,
    // 任务卡消息需要持久化，以便重启后仍能显示真实任务状态
    task_message: persistedTaskMessage as unknown as ChatMessage['task_message'],
    agent_proposal: message.agent_proposal,
    gallery_search: message.gallery_search,
    attachments: message.attachments,
    chat_mode: message.chat_mode,
    is_image: message.is_image,
    input_tokens: message.input_tokens,
    output_tokens: message.output_tokens,
    provider_profile_id: message.provider_profile_id,
    provider_name_snapshot: message.provider_name_snapshot,
    model_id: message.model_id,
    model_display_name_snapshot: message.model_display_name_snapshot,
  };
}

function buildPersistedConversation(conversation: ChatConversation): ChatConversation {
  return {
    id: conversation.id,
    title: conversation.title,
    messages: conversation.messages.map(buildPersistedMessage),
    created_at: conversation.created_at,
    last_prompt_tokens: conversation.last_prompt_tokens,
    last_completion_tokens: conversation.last_completion_tokens,
    context_summary: conversation.context_summary,
    context_summary_updated_at: conversation.context_summary_updated_at,
    conversation_mode: conversation.conversation_mode,
    active_task_draft: conversation.active_task_draft,
    active_task_id: conversation.active_task_id,
    active_image_id: conversation.active_image_id,
    active_image_path: conversation.active_image_path,
    chat_mode: conversation.chat_mode,
    selected_agent_profile_id: conversation.selected_agent_profile_id,
    selected_agent_model_id: conversation.selected_agent_model_id,
  };
}

function buildPersistedConversationSnapshot(conversations: ChatConversation[]) {
  return conversations.map(buildPersistedConversation);
}

function normalizeDecisionText(text: string): string {
  return text.replace(/[：:，,。.!！?？]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isExecutionConfirmationSignal(text: string): boolean {
  const normalized = normalizeDecisionText(text);
  if (!normalized) return false;
  return /^(确认|确认执行|直接\s*确认|直接\s*)?(出图|生图|执行|开始执行)$/.test(normalized)
    || /^(确认|确认执行)$/.test(normalized)
    || /^(按这个版本|根据你的内容|就按这个|就按这个执行|按刚才这版|按这版|照这个|按这个方案)(\s*直接)?\s*(出图|生图|执行|生成|确认)$/.test(normalized);
}

function isRetrySubmissionSignal(text: string): boolean {
  const normalized = normalizeDecisionText(text);
  if (!normalized) return false;
  return /^(重新提交|重新提交一下|重新提交一次|重新生成|重新跑|重试|再来一次)$/.test(normalized)
    || /^(请)?\s*(帮我)?\s*(重新提交|重新生成|重新跑|重试)(一下|一次)?$/.test(normalized);
}

function hasStrongTaskVerb(text: string): boolean {
  return /(制作|生成|给我做|帮我做|换成|改成|扣出|放大|设计|出一张|做一张|做几张)/.test(text);
}

function hasVisualTaskTarget(text: string): boolean {
  return /(图|图片|图像|海报|主图|详情图|说明图|测量图|长图|封面图|A\+图|a\+图|背景|发型|发色|风格|白底|透明背景|人物|产品)/.test(text);
}

function isLikelyReferentialFollowUp(text: string): boolean {
  if (!text.trim()) return false;
  return /^(脸不要变|脸别动|保留原脸|五官不要变|身份不要变|背景别动|背景不要变|保留背景|衣服别动|服装别动|保留衣服|保留服装|只改头发|只改发型|只改背景|都统一|不要太夸张|更写实|更真实|更自然)/.test(text.trim())
    || /(保留|只执行|仅执行|只要|去掉|不要|取消|移除).*\d+/.test(text);
}

function isLikelyNewTaskMessage(
  activeDraft: AgentTaskDraft | null,
  text: string,
  attachments: ChatAttachment[],
  roughIntent: string,
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (attachments.length > 0) return true;
  if (roughIntent === 'gallery_search') return true;
  if (isExecutionConfirmationSignal(trimmed)) return false;
  if (isLikelyReferentialFollowUp(trimmed)) return false;

  const isTaskIntent = ['image_generate', 'image_edit', 'remove_background', 'upscale', 'image_understanding'].includes(roughIntent);
  const looksLikeIndependentRequest =
    trimmed.length >= 12 && (hasStrongTaskVerb(trimmed) || (hasVisualTaskTarget(trimmed) && /(要求|标注|客户看|给客户|怎么测量|制作一个|生成一个)/.test(trimmed)));

  if (!activeDraft) return isTaskIntent || looksLikeIndependentRequest;
  if (looksLikeIndependentRequest) return true;
  if (isTaskIntent && activeDraft.task_kind !== roughIntent) return true;
  return false;
}

function shouldDeriveFromCompletedTask(text: string): boolean {
  return /(再|继续|基于这张|基于这个版本|这个版本|在这个基础上|这些都|统一|背景再|亮一点|暗一点|白底)/.test(text);
}

function resolveExecutionIntentFromContext(
  conversation: ChatConversation | undefined,
  activeDraft: AgentTaskDraft | null,
  text: string,
): { messageId: string; proposal: AgentProposal } | null {
  if (!conversation || !isExecutionConfirmationSignal(text)) return null;

  const draftBacked = activeDraft && ['proposed', 'failed'].includes(activeDraft.stage);
  if (draftBacked) {
    const draftMessage = [...conversation.messages]
      .reverse()
      .find(message => message.agent_proposal?.status === 'draft' && message.agent_proposal.id === activeDraft.id);
    if (draftMessage?.agent_proposal) {
      return { messageId: draftMessage.id, proposal: draftMessage.agent_proposal };
    }
  }

  const latestProposalMessage = [...conversation.messages]
    .reverse()
    .find(message => message.agent_proposal?.status === 'draft');

  if (latestProposalMessage?.agent_proposal) {
    return { messageId: latestProposalMessage.id, proposal: latestProposalMessage.agent_proposal };
  }

  return null;
}

function decideConversationTransition(input: {
  conversation: ChatConversation | undefined;
  activeDraft: AgentTaskDraft | null;
  text: string;
  attachments: ChatAttachment[];
  roughIntent: string;
}): ConversationTransitionDecision {
  const executionTarget = resolveExecutionIntentFromContext(input.conversation, input.activeDraft, input.text);
  if (executionTarget || isExecutionConfirmationSignal(input.text)) {
    return { kind: 'execution_confirmation', executionTarget };
  }

  if (isRetrySubmissionSignal(input.text)) {
    return { kind: 'retry_submission' };
  }

  // ====== 任务修订（本轮 bug 修复核心）======
  // "我不要批量任务 我要单张" 是对当前待确认提案的修订指令，
  // 不是普通聊天、也不是新任务。必须触发真正的重新规划（replan），
  // 生成新的任务 revision，而不是只回复一段解释文字。
  // 前提：存在尚未执行的提案（draft stage = proposed / variant_planning），
  // 且修订指令命中 detectTaskRevisionIntent。
  if (
    input.activeDraft
    && ['proposed', 'variant_planning', 'clarifying', 'failed'].includes(input.activeDraft.stage)
    && detectTaskRevisionIntent(input.text).isRevision
  ) {
    return { kind: 'task_revision' };
  }

  if (isLikelyNewTaskMessage(input.activeDraft, input.text, input.attachments, input.roughIntent)) {
    return { kind: 'new_task' };
  }

  if (
    input.activeDraft &&
    ['clarifying', 'variant_planning', 'proposed', 'failed'].includes(input.activeDraft.stage) &&
    input.attachments.length === 0 &&
    input.roughIntent !== 'gallery_search'
  ) {
    return { kind: 'follow_up' };
  }

  if (
    input.activeDraft &&
    input.activeDraft.stage === 'completed' &&
    input.attachments.length === 0 &&
    input.roughIntent !== 'gallery_search' &&
    shouldDeriveFromCompletedTask(input.text)
  ) {
    return { kind: 'derive_from_completed' };
  }

  return { kind: 'free_chat' };
}

function keywordScore(text: string, keywords: string[], excludeKeywords: string[]) {
  let score = 0;
  for (const keyword of keywords) {
    const normalized = normalizeText(keyword);
    if (normalized && text.includes(normalized)) score += 1;
  }
  for (const keyword of excludeKeywords) {
    const normalized = normalizeText(keyword);
    if (normalized && text.includes(normalized)) score -= 10;
  }
  return score;
}

async function getTemplateSet() {
  const cached = getAgentTemplateCache();
  if (cached) return cached;
  const [taskTemplates, styleTemplates] = await Promise.all([
    api.getAgentTaskTemplates(),
    api.getAgentStyleTemplates(),
  ]);
  setAgentTemplateCache(taskTemplates, styleTemplates);
  return getAgentTemplateCache()!;
}

function localClarificationFor(roughIntent: string, hasImages: boolean) {
  if (roughIntent === 'gallery_search') {
    return '你是想找以前生成过的图片，还是想基于这些图片继续生成？';
  }
  if (hasImages && roughIntent === 'chat') {
    return '你是想分析这张图，还是想修改这张图后再生成？';
  }
  return undefined;
}

function parseRequestedCount(text: string) {
  // 关键修复：图像张数计数必须排除"前N个"型实体顺序引用 ——
  // "前3个山"的"3个"是实体计数（泰山/黄山/华山），不是"生成 3 张图"。
  // 旧实现 /(\d+)\s*(张|份|个|套|版|版本)/ 会把 "前3个山" 误读成 3 张，
  // 导致"单张三分镜图"被误判成 batch / repeat_same / 3 个子任务。
  const withoutOrderedRefs = text
    .replace(/前\s*\d{1,2}\s*(?:个|张|位|座|项|条)/g, '')
    .replace(/前\s*[一二两三四五六七八九十]\s*(?:个|张|位|座|项|条)/g, '')
    .replace(/第\s*\d{1,2}\s*(?:个|张|位|座|项|条)/g, '');
  const direct = withoutOrderedRefs.match(/(\d+)\s*(张|份|个|套|版|版本)/);
  if (direct) return Math.max(1, Number(direct[1]));
  if (/(一批|这些都|全部|都给我)/.test(text)) return 0;
  return 1;
}

function detectVariationAxis(text: string): string | undefined {
  if (/(背景|场景|街景|白底|海边|城市)/.test(text)) return 'background';
  if (/(风格|赛博朋克|电影感|写实|高级感|暗黑)/.test(text)) return 'style';
  if (/(颜色|发色|色系|色调)/.test(text)) return 'color';
  if (/(发型|刘海|卷发|短发|长发|马尾)/.test(text)) return 'hairstyle';
  return undefined;
}

function isConnectedDetailSequenceRequest(text: string, attachments: ChatAttachment[]): boolean {
  const imageCount = attachments.filter(item => item.type === 'image' && !!item.filePath).length;
  if (imageCount < 2) return false;
  const asksDetail = /(详情图|长图|抖音|竖版|详情页)/.test(text);
  const asksSequence = /(上下关联|前后关联|连续|连续滑动|上下衔接|上下承接|上下连贯|前后连贯|连贯)/.test(text);
  const asksCount = /(\d+)\s*(张|份|页)/.test(text);
  const explicitPagePlan = countSequencePageDirectives(text) >= 2;
  return (asksDetail && asksCount && asksSequence) || (asksDetail && explicitPagePlan);
}

function isReferenceBoundDesignText(text: string, imageCount: number): boolean {
  if (imageCount < 2) return false;
  const hasDesignTarget = /(详情图|长图|海报|a\+图|A\+图|主图|说明图|测量图|展示图|客户看|电商图|详情页)/.test(text);
  if (!hasDesignTarget) return false;
  const hasReferenceBinding = /(第一张.*模特.*第二张.*产品图|根据这两张图|参考这张模特图和这张产品图|按这几张图做|模特图.*产品图|产品图.*场景图|人物图.*服装图)/.test(text);
  const hasModelSignal = /(模特|人物|穿搭|上身|实穿|展示参考)/.test(text);
  const hasProductSignal = /(产品|商品|衣服|服装|单品|白底图|产品图|商品图)/.test(text);
  const hasBindingVerb = /(根据我提供|基于我提供|参考我提供|结合.*生成|结合.*设计|按.*做|用.*做|同时参考|参考关系|保持.*一致)/.test(text);
  const hasPairedReferenceSignal = /(模特.*(产品|白底图|衣服|服装)|产品.*模特|人物.*(服装|产品)|白底图.*模特)/.test(text);
  return hasReferenceBinding || (imageCount >= 2 && hasModelSignal && hasProductSignal && (hasBindingVerb || hasPairedReferenceSignal));
}

function isReferenceBoundDesignTask(text: string, attachments: ChatAttachment[]): boolean {
  const imageCount = attachments.filter(item => item.type === 'image' && !!item.filePath).length;
  return isReferenceBoundDesignText(text, imageCount);
}

function detectBatchPlan(input: {
  text: string;
  roughIntent: string;
  attachments: ChatAttachment[];
}): BatchPlan {
  // ====== 复合构图优先判别（本轮 bug 修复核心）======
  // "一张图里展示3个风景 / 3分镜图 / 九宫格" 是单张复合构图（输出 1 张图），
  // 不是批量任务。必须在做任何批量判定之前先排除。
  const outputStructure = resolveOutputStructure(input.text);
  if (outputStructure.kind === 'single_composite_image') {
    return {
      executionMode: 'single',
      targetCount: 1,
      compositeLayout: outputStructure.layoutType && outputStructure.layoutType !== 'unknown'
        ? { type: outputStructure.layoutType, panelCount: outputStructure.compositePanelCount || 0 }
        : undefined,
      taskPlanSummary: outputStructure.compositePanelCount
        ? `单张复合构图（${outputStructure.compositePanelCount} 格${outputStructure.layoutType === 'triptych' ? '三分镜' : outputStructure.layoutType === 'grid' ? '宫格' : '分屏'}）`
        : '单张复合构图',
    };
  }

  const count = parseRequestedCount(input.text);
  const imageCount = input.attachments.filter(item => item.type === 'image' && !!item.filePath).length;
  const variationAxis = detectVariationAxis(input.text);
  const asksMany = count > 1 || (outputStructure.kind === 'batch_images' && outputStructure.requestedImageCount > 1) || /(一批|这些都|全部|都给我|批量)/.test(input.text);
  const asksDifferent = /(不同|分别|每个不一样|版本|方案|多套)/.test(input.text);
  const multiInput = imageCount > 1 && /(这些都|全部|每张|每个|统一|批量)/.test(input.text);

  if (isConnectedDetailSequenceRequest(input.text, input.attachments)) {
    return {
      executionMode: 'batch',
      batchStrategy: 'variant_set',
      targetCount: count || 3,
      sequenceMode: 'connected_detail_sequence',
      taskPlanSummary: '连续详情图序列',
    };
  }

  if (multiInput) {
    return {
      executionMode: 'batch',
      batchStrategy: 'multi_input',
      targetCount: imageCount,
    };
  }

  if (!asksMany) {
    return { executionMode: 'single', targetCount: 1 };
  }

  if (asksDifferent) {
    // 用户明确枚举了对象（"上海、北京、广州各一张"）→ 多 Prompt 批量：
    // 每个对象一个子任务，优先级高于任何维度轴推断，AI Planner 不得覆盖。
    const distinctObjects = extractDistinctObjects(input.text);
    if (distinctObjects.length >= 2) {
      return {
        executionMode: 'batch',
        batchStrategy: 'variant_set',
        targetCount: distinctObjects.length,
        distinctObjects,
        distinctBatch: true,
        taskPlanSummary: `多 Prompt 批量 × ${distinctObjects.length}`,
      };
    }
    if (!variationAxis && !/(版本|方案)/.test(input.text)) {
      return {
        executionMode: 'batch',
        batchStrategy: 'variant_set',
        targetCount: count || Math.max(2, imageCount),
        needsClarification: true,
        clarificationQuestion: '你这批结果主要希望在哪个维度上变化？比如背景、风格、颜色或构图。',
      };
    }
    return {
      executionMode: 'batch',
      batchStrategy: 'variant_set',
      targetCount: count || Math.max(2, imageCount),
      variationAxis,
      distinctBatch: true,
      taskPlanSummary: `多 Prompt 批量 × ${count || Math.max(2, imageCount)}`,
    };
  }

  return {
    executionMode: 'batch',
    batchStrategy: 'repeat_same',
    targetCount: count || Math.max(2, imageCount),
  };
}

function candidateLabelsForAxis(axis?: string): string[] {
  switch (axis) {
    case 'background':
      return ['城市街景', '纯白背景', '海边晚霞', '咖啡馆', '高级展厅', '夜景街道', '室内客厅', '商业写字楼', '森林户外', '极简摄影棚'];
    case 'style':
      return ['写实摄影', '高级商业感', '电影感', '赛博朋克', '极简电商风', 'iPhone 风格电商', '生活方式风格', '暖色氛围', '冷调时尚', '暗黑质感', '品牌海报风'];
    case 'color':
      return ['自然黑', '深棕', '冷茶棕', '亚麻棕', '蜜糖棕', '雾灰棕', '黑蓝色', '玫瑰棕', '奶茶棕', '浅金棕'];
    case 'hairstyle':
      return ['锁骨发', '法式大波浪', '黑长直', '空气刘海长发', '干练短发', '高马尾', '低盘发', '中长层次微卷', '偏分卷发', '轻盈短发'];
    default:
      return [];
  }
}

type SequenceDirective = {
  index: number;
  label: string;
  prompt_delta: string;
};

type SequencePageRole =
  | 'model_showcase'
  | 'product_detail'
  | 'product_showcase'
  | 'factory_scene'
  | 'product_detail_factory'
  | 'generic_sequence';

function classifySequencePageRole(text: string): SequencePageRole {
  const cleaned = text
    .replace(/^[：:\s，。,\.]+/, '')
    .replace(/[。；;，,]+$/g, '')
    .trim();

  if (!cleaned) return 'generic_sequence';

  const forbidsModel = /(不要出现模特|不出现模特|不要出现人物|不出现人物|不要出现人手|不出现人手|不要出现穿搭模特|禁止出现模特|禁止出现人物|禁止出现人手)/.test(cleaned);
  const hasFactory = /(工厂|车间|工人|裁剪|车缝|整烫|质检|打包|发货|仓储|批发直营|工厂直发|生产场景|制作场景)/.test(cleaned);
  const hasDetail = /(细节|工艺|面料|纹理|领口|袖口|下摆|走线|纽扣|拉链|结构|辅料|品质)/.test(cleaned);
  const hasProductShowcase = /(产品展示|展示产品|单品展示|产品本体|平铺|悬挂)/.test(cleaned);
  const hasModel = /(模特.*展示|展示.*模特|上身|实穿|穿搭)/.test(cleaned);

  if (hasFactory && hasDetail) return 'product_detail_factory';
  if (hasFactory) return 'factory_scene';
  if (hasDetail) return 'product_detail';
  if (hasProductShowcase) return 'product_showcase';
  if (hasModel && !forbidsModel) return 'model_showcase';
  if (forbidsModel && (hasDetail || /产品/.test(cleaned))) return 'product_detail';
  if (forbidsModel && hasFactory) return 'factory_scene';
  return 'generic_sequence';
}

function labelForSequencePageRole(role: SequencePageRole, cleaned: string): string {
  switch (role) {
    case 'model_showcase':
      return '模特展示';
    case 'product_detail':
      return '产品细节展示';
    case 'product_showcase':
      return '产品展示';
    case 'factory_scene':
      return '工厂展示';
    case 'product_detail_factory':
      return '产品细节和工厂展示';
    default:
      return cleaned.slice(0, 18) || '连续详情页';
  }
}

function buildSequencePromptDelta(index: number, body: string): string {
  const cleaned = body
    .replace(/^[：:\s，。,\.]+/, '')
    .replace(/[。；;，,]+$/g, '')
    .trim();
  return `第 ${index} 张重点内容：${cleaned}。保持与前后页面的顶部/底部元素、配色、版式和信息节奏连续，同时突出这一页的核心职责。`;
}

function parseSequencePageDirectives(text: string, targetCount: number): SequenceDirective[] {
  const marker = /第\s*([1-9一二三四五六七八九十])\s*张/g;
  const allMatches = Array.from(text.matchAll(marker));
  const matches = allMatches.length > targetCount ? allMatches.slice(-targetCount) : allMatches;
  if (matches.length === 0) return [];

  const toIndex = (raw: string) => {
    if (/^\d+$/.test(raw)) return Number(raw);
    const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    return map[raw] || 0;
  };

  const directives: SequenceDirective[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const next = matches[i + 1];
    const index = toIndex(current[1]);
    if (!index || index > targetCount) continue;
    const start = (current.index ?? 0) + current[0].length;
    const end = next?.index ?? text.length;
    const rawBody = text.slice(start, end).trim();
    const body = rawBody
      .replace(/^[：:\s，。,\.]+/, '')
      .replace(/[。；;，,]+$/g, '')
      .trim();
    if (!body) continue;
    const role = classifySequencePageRole(body);
    directives.push({
      index,
      label: `图 ${index}：${labelForSequencePageRole(role, body)}`,
      prompt_delta: buildSequencePromptDelta(index, body),
    });
  }

  const deduped = new Map<number, SequenceDirective>();
  for (const item of directives) {
    deduped.set(item.index, item);
  }
  return Array.from(deduped.values()).sort((a, b) => a.index - b.index);
}

function countSequencePageDirectives(text: string): number {
  return parseSequencePageDirectives(text, 10).length;
}

function buildConnectedDetailSequenceItems(targetCount: number, text?: string): TaskBatchItem[] {
  const defaults = [
    {
      label: '图 1：封面与主卖点',
      prompt_delta: '第 1 张作为详情页封面与主卖点引导页，突出模特整体展示、产品第一印象和核心吸引点。画面顶部与底部预留连续承接元素，为下一张详情页过渡。',
    },
    {
      label: '图 2：细节与展示',
      prompt_delta: '第 2 张承接第 1 张，重点展示产品细节、材质、版型或上身展示，保持相同视觉风格、配色和信息节奏，与前后页面自然衔接。',
    },
    {
      label: '图 3：测量说明与购买引导',
      prompt_delta: '第 3 张作为序列收尾页，承接前两张内容，重点放尺寸测量、使用说明或购买引导信息，保持同一视觉体系，并完成整套详情图闭环。',
    },
  ];

  const explicit = text ? parseSequencePageDirectives(text, targetCount) : [];
  const explicitByIndex = new Map<number, SequenceDirective>(explicit.map(item => [item.index, item]));

  return Array.from({ length: targetCount }, (_, index) => {
    const explicitPreset = explicitByIndex.get(index + 1);
    const preset = explicitPreset || defaults[index] || {
      label: `图 ${index + 1}：连续详情页`,
      prompt_delta: `第 ${index + 1} 张作为连续详情图序列中的独立长图页面，保持与前后页的顶部/底部元素、结构和视觉风格连续，并承担独立信息层级职责。`,
    };
    return {
      id: `batch_${index + 1}`,
      label: preset.label,
      prompt_delta: preset.prompt_delta,
      enabled: true,
    };
  });
}

function buildBatchItems(plan: BatchPlan, attachments: ChatAttachment[], text?: string): TaskBatchItem[] {
  if (plan.executionMode !== 'batch') return [];
  if (plan.sequenceMode === 'connected_detail_sequence') {
    return buildConnectedDetailSequenceItems(plan.targetCount, text);
  }
  if (plan.batchStrategy === 'multi_input') {
    return attachments
      .filter(item => item.type === 'image' && !!item.filePath)
      .map((item, index) => ({
        id: `batch_${index + 1}`,
        label: item.name || `源图 ${index + 1}`,
        prompt_delta: '',
        source_images: item.filePath ? [item.filePath] : [],
        enabled: true,
      }));
  }

  if (plan.batchStrategy === 'repeat_same') {
    return Array.from({ length: plan.targetCount }, (_, index) => ({
      id: `batch_${index + 1}`,
      label: `结果 ${index + 1}`,
      prompt_delta: `生成第 ${index + 1} 个版本，保持整体方向一致，但与其他版本有明显差异。`,
      enabled: true,
    }));
  }

  // 多对象差异化批量：每个枚举对象一个子任务，prompt_override 在
  // applyDistinctPromptOverrides 阶段基于最终 Prompt 生成。
  if (plan.distinctObjects && plan.distinctObjects.length >= 2) {
    return plan.distinctObjects.map((object, index) => ({
      id: `batch_${index + 1}`,
      label: object,
      prompt_delta: `本子任务只表现「${object}」，其余公共要求保持一致，禁止把其他并列主体画进本张图。`,
      enabled: true,
    }));
  }

  const labels = candidateLabelsForAxis(plan.variationAxis);
  if (labels.length > 0) {
    return labels.slice(0, plan.targetCount).map((label, index) => ({
      id: `batch_${index + 1}`,
      label,
      prompt_delta: `当前子任务重点变化：${label}。在保持主体与公共约束不变的前提下，围绕该方向生成独立版本。`,
      enabled: true,
    }));
  }

  return Array.from({ length: plan.targetCount }, (_, index) => ({
    id: `batch_${index + 1}`,
    label: `方案 ${index + 1}`,
    prompt_delta: `生成第 ${index + 1} 个差异化版本，保持主体不变，但与其他方案明显不同。`,
    enabled: true,
  }));
}

function stripSequencePageSpecificText(prompt: string): string {
  if (!prompt.trim()) return prompt;
  const lineFiltered = prompt
    .split('\n')
    .filter(line => !/(第\s*[123一二三]\s*张|图\s*[123]\s*[：:])/.test(line))
    .join('\n')
    .trim();

  const sentenceFiltered = lineFiltered
    .replace(/第\s*[一二三123]\s*张[^。；\n]*[。；]?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return sentenceFiltered || prompt;
}

function applySequencePromptOverrides(basePrompt: string, items: TaskBatchItem[]): TaskBatchItem[] {
  return items.map(item => ({
    ...item,
    prompt_override: [
      basePrompt,
      `当前页面职责：${item.label}`,
      item.prompt_delta,
      '只生成当前这一张独立长图页面，不要把其他页面职责混入当前页面。',
      '当前页面必须清晰围绕这一页的主体内容组织版式、视觉重心和信息层级。',
    ].filter(Boolean).join('\n'),
  }));
}

/**
 * 多对象差异化批量的子任务 Prompt 生成：
 * 一个子任务 = 一个对象 = 一次独立图片调用 = 一张独立图片。
 * 防止"3 张不同城市"被合并成一张三联画/拼图。
 */
function applyDistinctPromptOverrides(basePrompt: string, items: TaskBatchItem[]): TaskBatchItem[] {
  return items.map(item => ({
    ...item,
    prompt_override: [
      `本张独立图片的主题：${item.label}。`,
      basePrompt,
      '输出要求：这是一张独立完整的图片，只表现当前主题，禁止把多个并列主题合入同一画面（禁止三联画 / 拼图 / 分屏 / 宫格 / 组合图）。',
    ].filter(Boolean).join('\n'),
  }));
}

function proposalIntentLabel(intent: AgentProposal['intent']) {
  return intent === 'image_edit' ? '图生图 / 图片编辑' : intent === 'remove_background' ? '去背景' : intent === 'upscale' ? '高清放大' : '文生图';
}

function buildProposalContent(proposal: AgentProposal) {
  const compositeLabel = proposal.composite_layout
    ? `单张复合构图（${proposal.composite_layout.type === 'triptych' ? '三分镜' : proposal.composite_layout.type === 'grid' ? `${proposal.composite_layout.panelCount} 宫格` : '分屏'}，输出 1 张图）`
    : '';
  const lines = [
    `任务识别：${proposalIntentLabel(proposal.intent)}`,
    `我理解你的需求：${proposal.user_prompt_raw}`,
    proposal.execution_mode === 'batch' ? `执行模式：批量 / ${proposal.batch_strategy}` : compositeLabel ? `执行模式：${compositeLabel}` : '执行模式：单任务',
    proposal.subject_entities?.length ? `主体：${proposal.subject_entities.join('、')}` : '',
    proposal.matched_task_template_name ? `主任务模板：${proposal.matched_task_template_name}` : '',
    proposal.matched_style_template_names?.length ? `风格模板：${proposal.matched_style_template_names.join('、')}` : '',
    `推荐执行方式：${proposal.recommended_action}`,
    `优化后的提示词：${proposal.final_prompt}`,
    proposal.final_negative_prompt ? `负面提示词：${proposal.final_negative_prompt}` : '',
    `源图数量：${proposal.source_images.length}`,
    `执行接口：${proposal.api_kind}`,
  ];
  if (proposal.execution_mode === 'batch' && proposal.batch_items?.length) {
    lines.push(`批量计划：${proposal.task_plan_summary || `${proposal.batch_items.filter(item => item.enabled !== false).length} 个子任务`}`);
    for (const item of proposal.batch_items) {
      lines.push(`- [${item.enabled === false ? '禁用' : '启用'}] ${item.label}${item.prompt_delta ? `：${item.prompt_delta}` : ''}`);
    }
  }
  if (proposal.used_local_fallback) {
    lines.push('模型结构化输出异常，已使用本地规则生成提案。');
  }
  lines.push('请确认是否执行。');
  return lines.filter(Boolean).join('\n');
}

function proposalFromDraft(draft: AgentTaskDraft): AgentProposal {
  return {
    id: draft.id,
    intent: draft.task_kind === 'gallery_search' || draft.task_kind === 'image_understanding'
      ? 'image_generate'
      : draft.task_kind,
    confidence: draft.confidence,
    needs_clarification: false,
    clarification_question: draft.clarification_questions[0],
    recommended_action: draft.recommended_action,
    final_prompt: draft.final_prompt,
    final_negative_prompt: draft.final_negative_prompt,
    user_prompt_raw: draft.user_prompt_raw,
    source_images: draft.source_images,
    status: 'draft',
    api_kind: draft.api_kind || 'generation',
    matched_task_template_id: draft.matched_task_template_id,
    matched_task_template_name: draft.matched_task_template_name,
    matched_style_template_ids: draft.matched_style_template_ids,
    matched_style_template_names: draft.matched_style_template_names,
    execution_mode: draft.execution_mode,
    batch_strategy: draft.batch_strategy,
    task_plan_summary: draft.task_plan_summary || (draft.variant_plan ? `${draft.variant_plan.items.filter(item => item.enabled !== false).length} 个批量子任务` : ''),
    batch_items: draft.variant_plan?.items,
    used_local_fallback: draft.used_local_fallback,
    linked_task_id: draft.linked_task_id,
    planner_provider_profile_id: draft.planner_provider_profile_id,
    planner_provider_name_snapshot: draft.planner_provider_name_snapshot,
    planner_model_id: draft.planner_model_id,
    planner_model_display_name_snapshot: draft.planner_model_display_name_snapshot,
  };
}

function normalizeDraftForPersistence(draft: AgentTaskDraft): AgentTaskDraft {
  return {
    ...draft,
    stage: draft.stage === 'confirmed' ? 'proposed' : draft.stage,
  };
}

function rebuildProposalMessageFromDraft(draft: AgentTaskDraft): ChatMessage {
  const proposal = proposalFromDraft(draft);
  return {
    id: `m_rehydrated_${draft.id}`,
    role: 'assistant',
    content: buildProposalContent(proposal),
    created_at: draft.updated_at || draft.created_at,
    agent_proposal: proposal,
    is_image: true,
  };
}

function rehydrateConversation(conversation: ChatConversation): ChatConversation {
  let activeDraft = conversation.active_task_draft || null;
  const proposalMessage = [...conversation.messages]
    .reverse()
    .find(message => message.agent_proposal && ['draft', 'submitting'].includes(message.agent_proposal.status));

  if (!activeDraft && proposalMessage?.agent_proposal) {
    const proposal = proposalMessage.agent_proposal;
    const nowIso = proposalMessage.created_at || new Date().toISOString();
    activeDraft = {
      id: proposal.id,
      conversation_id: conversation.id,
      task_kind: proposal.intent,
      stage: proposal.status === 'submitting' ? 'confirmed' : 'proposed',
      execution_mode: proposal.execution_mode || 'single',
      batch_strategy: proposal.batch_strategy,
      task_plan_summary: proposal.task_plan_summary,
      user_prompt_raw: proposal.user_prompt_raw,
      latest_user_message: proposal.user_prompt_raw,
      source_images: proposal.source_images,
      reference_images: [],
      keep_constraints: [],
      change_constraints: [],
      negative_constraints: [],
      unresolved_fields: [],
      clarification_questions: proposal.clarification_question ? [proposal.clarification_question] : [],
      matched_task_template_id: proposal.matched_task_template_id,
      matched_task_template_name: proposal.matched_task_template_name,
      matched_style_template_ids: proposal.matched_style_template_ids || [],
      matched_style_template_names: proposal.matched_style_template_names || [],
      final_prompt: proposal.final_prompt,
      final_negative_prompt: proposal.final_negative_prompt,
      recommended_action: proposal.recommended_action,
      api_kind: proposal.api_kind,
      variant_plan: proposal.execution_mode === 'batch' && proposal.batch_items?.length
        ? {
            target_count: proposal.batch_items.length,
            items: proposal.batch_items,
          }
        : undefined,
      confidence: proposal.confidence,
      used_local_fallback: proposal.used_local_fallback || false,
      linked_task_id: proposal.linked_task_id,
      created_at: nowIso,
      updated_at: nowIso,
    };
  }

  if (!activeDraft) {
    return {
      ...conversation,
      conversation_mode: conversation.conversation_mode || 'free_chat',
      active_task_draft: null,
    };
  }

  const normalizedDraft = normalizeDraftForPersistence(activeDraft);
  const shouldShowProposal = ['clarifying', 'variant_planning', 'proposed', 'confirmed'].includes(normalizedDraft.stage);
  const hasVisibleProposal = conversation.messages.some(message => message.agent_proposal && ['draft', 'submitting'].includes(message.agent_proposal.status));
  const messages = shouldShowProposal && !hasVisibleProposal
    ? [...conversation.messages, rebuildProposalMessageFromDraft(normalizedDraft)]
    : conversation.messages;

  return {
    ...conversation,
    conversation_mode: conversation.conversation_mode || 'task_flow',
    active_task_draft: normalizedDraft,
    messages,
  };
}

/**
 * 把从磁盘读到的 task_message（可能是新 envelope 格式，也可能是旧直通格式，也可能已损坏）
 * 统一反序列化成运行时 TaskMessageState。
 *
 * 重要：
 *   - 反序列化失败也不会抛异常，而是把这条消息的 task_message 替换成"恢复失败"占位状态，
 *     这样 TaskMessageCard 仍然能渲染（而不是退化成普通文本），开发期更容易发现。
 *   - 普通历史消息（没有 task_message 字段）保持原样。
 */
function hydrateTaskMessagesInConversation(conversation: ChatConversation): ChatConversation {
  let changed = false;
  const messages = conversation.messages.map((message) => {
    if (!message.task_message) return message;
    const raw = message.task_message as unknown;
    const result = deserializeTaskMessageState(raw);
    if (result && result.ok) {
      const state = result.state;
      // 检测 raw 是否是 envelope 包装：是的话必须替换成 inner state，避免运行时再感知 envelope。
      const isEnvelope = !!raw && typeof raw === 'object'
        && 'version' in (raw as object)
        && 'kind' in (raw as object)
        && (raw as { kind?: string }).kind === 'task_message';
      if (isEnvelope) {
        changed = true;
        return { ...message, task_message: state };
      }
      return message;
    }
    if (result && !result.ok) {
      console.warn('[TaskMessageHydrate] failed', {
        conversationId: conversation.id,
        messageId: message.id,
        reason: result.reason,
      });
      changed = true;
      const recovered = buildRecoveryFailedState(result.reason, result.partial);
      return { ...message, task_message: recovered };
    }
    // result === null：输入根本不是任务消息（少见，比如某种残留），剥掉 task_message 字段。
    changed = true;
    const { task_message: _drop, ...rest } = message;
    return rest as ChatMessage;
  });
  if (!changed) return conversation;
  return { ...conversation, messages };
}

/**
 * 在 rehydrateConversation 之后调用一次，统一处理所有 task_message envelope。
 */
function rehydrateConversationWithTaskMessages(conversation: ChatConversation): ChatConversation {
  return hydrateTaskMessagesInConversation(rehydrateConversation(conversation));
}

function applyDraftFollowUp(draft: AgentTaskDraft, text: string): AgentTaskDraft | null {
  if (!text.trim()) return null;
  if (!isLikelyReferentialFollowUp(text.trim())) return null;
  let changed = false;
  const next: AgentTaskDraft = {
    ...draft,
    latest_user_message: text,
    updated_at: new Date().toISOString(),
    keep_constraints: [...draft.keep_constraints],
    change_constraints: [...draft.change_constraints],
    negative_constraints: [...draft.negative_constraints],
    unresolved_fields: [...draft.unresolved_fields],
    clarification_questions: [...draft.clarification_questions],
    variant_plan: draft.variant_plan ? { ...draft.variant_plan, items: draft.variant_plan.items.map(item => ({ ...item })) } : undefined,
  };

  const addKeep = (value: string) => {
    if (!next.keep_constraints.includes(value)) {
      next.keep_constraints.push(value);
      changed = true;
    }
  };
  const addChange = (value: string) => {
    if (!next.change_constraints.includes(value)) {
      next.change_constraints.push(value);
      changed = true;
    }
  };

  if (/(脸不要变|脸别动|保留原脸|五官不要变|身份不要变)/.test(text)) addKeep('保持脸部和身份特征不变');
  if (/(背景别动|背景不要变|保留背景)/.test(text)) addKeep('保持背景不变');
  if (/(衣服别动|服装别动|保留衣服|保留服装)/.test(text)) addKeep('保持服装不变');
  if (/(只改头发|只改发型|只改背景|都统一|不要太夸张|更写实|更真实|更自然)/.test(text)) addChange(text.trim());

  if (next.variant_plan) {
    const nums = Array.from(new Set((text.match(/\d+/g) || []).map(v => Number(v)).filter(v => v > 0)));
    if (nums.length > 0 && /(保留|只执行|仅执行|只要)/.test(text)) {
      next.variant_plan.items = next.variant_plan.items.map((item, index) => ({ ...item, enabled: nums.includes(index + 1) }));
      changed = true;
    } else if (nums.length > 0 && /(去掉|不要|取消|移除)/.test(text)) {
      next.variant_plan.items = next.variant_plan.items.map((item, index) => (
        nums.includes(index + 1) ? { ...item, enabled: false } : item
      ));
      changed = true;
    }
  }

  if (!changed) return null;

  const followupLines = [
    next.final_prompt,
    next.keep_constraints.length ? `保留要求：${next.keep_constraints.join('；')}` : '',
    next.change_constraints.length ? `补充约束：${next.change_constraints.join('；')}` : '',
  ].filter(Boolean);
  next.final_prompt = followupLines.join('\n');
  next.stage = 'proposed';
  return next;
}

function syncDraftStageWithTask(draft: AgentTaskDraft | null): AgentTaskDraft | null {
  if (!draft?.linked_task_id) return draft;
  const task = useTaskStore.getState().tasks.find(item => item.id === draft.linked_task_id);
  if (!task) return draft;
  const stageMap: Record<string, AgentTaskDraft['stage']> = {
    pending: 'queued',
    running: 'running',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'cancelled',
  };
  const nextStage = stageMap[task.status] || draft.stage;
  if (nextStage === draft.stage) return draft;
  return {
    ...draft,
    stage: nextStage,
    updated_at: new Date().toISOString(),
  };
}

function deriveDraftFromCompletedTask(draft: AgentTaskDraft, text: string): AgentTaskDraft | null {
  if (!draft.linked_task_id) return null;
  const resultImages = useImageStore.getState().images
    .filter(image => image.task_id === draft.linked_task_id && !image.missing)
    .map(image => image.local_path);
  if (resultImages.length === 0) return null;

  const applyToAll = resultImages.length > 1 && /(这些|都|全部|每张|批量|统一)/.test(text);
  const batchStrategy: TaskBatchStrategy | undefined = applyToAll ? 'multi_input' : undefined;
  const executionMode: 'single' | 'batch' = applyToAll ? 'batch' : 'single';
  const sourceImages = executionMode === 'batch' ? resultImages : [resultImages[0]];
  const batchItems = executionMode === 'batch'
    ? sourceImages.map((path, index) => ({
        id: `derived_${index + 1}`,
        label: `结果图 ${index + 1}`,
        prompt_delta: '',
        source_images: [path],
        enabled: true,
      }))
    : [];

  const nextTaskKind: AgentTaskDraft['task_kind'] =
    draft.task_kind === 'image_generate' ? 'image_edit' : draft.task_kind;
  const now = new Date().toISOString();

  return {
    ...draft,
    id: `draft_${Date.now()}`,
    task_kind: nextTaskKind,
    stage: 'proposed',
    execution_mode: executionMode,
    batch_strategy: batchStrategy,
    user_prompt_raw: text,
    latest_user_message: text,
    source_images: sourceImages,
    reference_images: [],
    linked_task_id: undefined,
    variant_plan: executionMode === 'batch'
      ? { target_count: batchItems.length, items: batchItems }
      : undefined,
    final_prompt: text,
    final_negative_prompt: draft.final_negative_prompt,
    keep_constraints: [...draft.keep_constraints],
    change_constraints: [...draft.change_constraints],
    negative_constraints: [...draft.negative_constraints],
    created_at: now,
    updated_at: now,
  };
}

function localAgentFallback(input: {
  roughIntent: string;
  raw: string;
  hasImages: boolean;
}): InterpretResult {
  return {
    intent: input.roughIntent as InterpretIntent,
    confidence: 0.55,
    needs_clarification: input.roughIntent === 'gallery_search' || (input.hasImages && input.roughIntent === 'chat'),
    clarification_question: localClarificationFor(input.roughIntent, input.hasImages),
    recommended_action: input.roughIntent === 'chat' ? '直接对话回复' : '模型结构化输出异常，已使用本地规则生成提案',
    should_propose_execution: ['image_generate', 'image_edit', 'remove_background'].includes(input.roughIntent),
    final_prompt: input.raw,
    final_negative_prompt: '',
    api_kind:
      input.roughIntent === 'image_edit'
        ? 'edit'
        : input.roughIntent === 'remove_background'
          ? 'remove_background'
          : input.roughIntent === 'image_generate'
            ? 'generation'
            : undefined,
  };
}

function hasRequiredField(text: string, field: string, hasImages: boolean) {
  const normalized = normalizeText(text);
  switch (field) {
    case 'product':
      return /(产品|商品|包装|主图|耳机|鞋子|服装|裙子|护肤|香水|箱包|杯子|瓶子|手表|首饰|眼镜|人物|模特)/.test(normalized);
    case 'scene':
      return /(场景|背景|海边|城市|客厅|卧室|厨房|书房|办公室|街道|街景|电商|白底)/.test(normalized);
    case 'style':
      return /(赛博朋克|写实|真实|商业|电影感|暗黑|白底|暖调|冷调|高级)/.test(normalized);
    case 'selling_point':
      return /(卖点|功能|特点|优势|质感|便携|防水|高端|留白)/.test(normalized);
    case 'source_image':
      return hasImages;
    case 'background_target':
      return /(背景|换成|改成|放到|融入|城市|海边|室内|户外|街景)/.test(normalized);
    default:
      return normalized.includes(field.toLowerCase());
  }
}

function extractTemplateVariables(text: string, attachments: ChatAttachment[]) {
  const normalized = normalizeText(text);
  const variables: Record<string, string> = {};
  const sourceImages = attachments.filter(item => item.type === 'image');

  if (sourceImages.length > 0) {
    variables.source_image = sourceImages.length > 1 ? `${sourceImages.length} 张源图` : (sourceImages[0].name || '源图');
  }

  const productMatch = text.match(/(耳机|鞋子|服装|裙子|箱包|香水|护肤品|杯子|瓶子|产品|商品|包装|手表|首饰|眼镜)/);
  if (productMatch) variables.product = productMatch[1];

  const styleMatch = text.match(/(赛博朋克|写实|真实|商业广告|商业|电影感|暗黑|白底|极简|暖调|冷调|高级感|生活方式|电商风|iPhone风格|iPhone 风格|iphone风格|iphone 风格|苹果风|苹果官网风|Apple风格|apple风格|科技发布会风)/);
  if (styleMatch) variables.style = styleMatch[1];

  const sellingPointMatch = text.match(/(防水|便携|高端|轻便|质感|耐用|收纳|留白|卖点|功能|特点|优势)/);
  if (sellingPointMatch) variables.selling_point = sellingPointMatch[1];

  const scenePatterns = [
    { pattern: /(海边|沙滩|海岸线|晚霞)/, value: '海边晚霞场景' },
    { pattern: /(城市|城里|都市|街道|街景|写字楼)/, value: '城市街景场景' },
    { pattern: /(客厅|卧室|厨房|书房|办公室)/, value: '室内生活场景' },
    { pattern: /(白底|纯白背景)/, value: '纯白背景' },
    { pattern: /(电商|主图)/, value: '电商展示场景' },
  ];
  const scene = scenePatterns.find(item => item.pattern.test(normalized))?.value;
  if (scene) variables.scene = scene;

  const backgroundPatterns = [
    { pattern: /(换成在城里|换成城市|改成城市|放到城里)/, value: '真实城市背景' },
    { pattern: /(换成海边|放到海边|在海边)/, value: '海边背景' },
    { pattern: /(换成室内|在室内|客厅|卧室)/, value: '室内背景' },
    { pattern: /(白底|纯白背景)/, value: '纯白背景' },
  ];
  const backgroundTarget = backgroundPatterns.find(item => item.pattern.test(normalized))?.value;
  if (backgroundTarget) variables.background_target = backgroundTarget;

  if (!variables.product && /(人物|女生|模特|女孩|男生|男人|女人)/.test(normalized)) {
    variables.product = '人物主体';
  }

  return variables;
}

function renderTemplate(template: string, variables: Record<string, string>) {
  if (!template.trim()) return '';
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => variables[key] || '');
}

function buildContextMessages(conv: ChatConversation): ChatMessage[] {
  // 只回放"真实的"用户发言与 AI 回答。任务卡 / 提案 / 错误 / 摘要等
  // 合成消息一旦以 assistant role 回放，模型会把产品 UI 文案当成
  // "自己说过的话"，产生困惑甚至防御性异常输出（英文声明等）。
  // 历史摘要改由 system prompt 的 contextSummary 段落注入（见 buildSkillSystemPrompt）。
  const genuineMessages = conv.messages.filter(message =>
    (message.role === 'user' || message.role === 'assistant')
    && !isSyntheticAssistantMessage(message),
  );
  return genuineMessages.slice(-CONTEXT_TAIL_MESSAGES);
}

/** 生成前预占额度（V4 两阶段计费）。
 * 返回 request_id 供任务创建成功后登记（终态时 settle）；402/QUOTA_EXHAUSTED
 * 抛出「余额不足，请充值后继续使用」；404/405（旧版服务端无此端点）静默放行。 */
async function authorizeImageTaskOrThrow(count: number): Promise<string | undefined> {
  const requestId = createRequestId('chat');
  try {
    await authorizeImageTask(requestId, count);
    return requestId;
  } catch (error: any) {
    if (error?.status === 404 || error?.status === 405) return undefined;
    throw error;
  }
}

async function understandAttachmentsForAgent(input: {
  text: string;
  attachments: ChatAttachment[];
  visionModel?: string;
}): Promise<string> {
  const images = input.attachments
    .filter(item => item.type === 'image' && item.dataUrl)
    .map(item => item.dataUrl!) as string[];

  if (images.length === 0) return '';
  if (!input.visionModel?.trim()) {
    const error: any = new Error('图片理解模型未配置，请到「设置与更新 → AI 智能体」中选择支持视觉的模型。');
    error.kind = 'vision_error';
    throw error;
  }

  const result = await api.understandChatImages({
    prompt: input.text,
    images,
    model: input.visionModel.trim(),
  }) as VisionUnderstandResult;

  if (!result.ok) {
    const error: any = new Error(result.error_message || '官方图片理解失败');
    error.kind = result.error_kind || 'vision_error';
    error.status = result.status;
    throw error;
  }

  return (result.summary || result.raw_text || '').trim();
}

async function interpretAgentRequest(input: {
  text: string;
  attachments: ChatAttachment[];
  token?: string;
  model?: string;
  baseUrl?: string;
  /** Provider 连接的使用方式（透传到 Rust 诊断日志与错误归因） */
  billingMode?: import('../features/aiProviders/types').BillingMode;
  /** Provider 身份（错误 Provider 化用）；缺省时退回通用文案 */
  provider?: { id: string; type: import('../features/aiProviders/types').AIProviderType; name: string };
}): Promise<InterpretResult> {
  const raw = input.text.trim();
  const hasImages = input.attachments.some(item => item.type === 'image');
  const editableImages = input.attachments.filter(item => item.type === 'image' && !!item.filePath);
  const roughIntent = classifyAgentIntent({
    text: raw,
    hasImageAttachments: hasImages,
    hasEditableImage: editableImages.length > 0,
    planOnly: false,
  });

  if (!raw || !input.token || !input.model || !input.baseUrl) {
    return localAgentFallback({ roughIntent, raw, hasImages });
  }

  const result = await api.runAgentRequest({
    mode: 'interpret',
    base_url: input.baseUrl,
    token: input.token,
    model: input.model,
    billing_mode: input.billingMode,
    text: raw,
    has_images: hasImages,
    editable_image_count: editableImages.length,
    attachment_names: input.attachments.map(item => item.name),
    rough_intent: roughIntent,
  }) as AgentRunRequestResult;

  if (!result.ok) {
    let message = result.error_message || 'Agent 请求失败';
    if (input.provider) {
      message = providerErrorCompact(buildProviderError({
        providerId: input.provider.id,
        providerType: input.provider.type,
        providerName: input.provider.name,
        billingMode: input.billingMode,
        modelId: input.model,
        failure: {
          ok: false,
          error_kind: result.error_kind,
          error_message: result.error_message,
          status: result.status,
        },
      }));
    }
    const error: any = new Error(message);
    error.kind = result.error_kind;
    error.status = result.status;
    throw error;
  }

  return {
    intent: (result.intent || roughIntent) as InterpretIntent,
    confidence: Number(result.confidence ?? 0.7),
    needs_clarification: Boolean(result.needs_clarification),
    clarification_question: result.clarification_question || undefined,
    recommended_action: String(result.recommended_action || ''),
    should_propose_execution: Boolean(result.should_propose_execution),
    final_prompt: String(result.final_prompt || raw).trim() || raw,
    final_negative_prompt: String(result.final_negative_prompt || '').trim(),
    api_kind: result.api_kind as InterpretResult['api_kind'],
  };
}

async function matchTemplates(input: {
  text: string;
  intent: InterpretIntent;
  attachments: ChatAttachment[];
}): Promise<TemplateMatchResult> {
  const { taskTemplates, styleTemplates } = await getTemplateSet();
  const normalized = normalizeText(input.text);
  const hasImages = input.attachments.some(item => item.type === 'image');

  const taskTemplate = [...taskTemplates]
    .filter(template => template.enabled && template.intent === input.intent)
    .map(template => ({ template, score: keywordScore(normalized, template.trigger_keywords, template.exclude_keywords) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.template.priority - a.template.priority || b.score - a.score)[0]?.template || null;

  const styleIntent = input.intent as AgentStyleTemplate['compatible_intents'][number];
  const styleTemplatesMatched = [...styleTemplates]
    .filter(template => template.enabled && template.compatible_intents.includes(styleIntent))
    .filter(template => !taskTemplate || template.compatible_scenes.length === 0 || template.compatible_scenes.includes(taskTemplate.scene))
    .map(template => ({ template, score: keywordScore(normalized, template.trigger_keywords, template.exclude_keywords) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.template.priority - a.template.priority || b.score - a.score)
    .map(item => item.template);

  let clarificationQuestion: string | undefined;
  if (taskTemplate?.clarification_rules.enabled) {
    const missingFields = taskTemplate.clarification_rules.required_fields.filter(field => !hasRequiredField(normalized, field, hasImages));
    if (missingFields.length > 0 && taskTemplate.clarification_rules.fallback_question.trim()) {
      clarificationQuestion = taskTemplate.clarification_rules.fallback_question.trim();
    }
  }

  return {
    taskTemplate,
    styleTemplates: styleTemplatesMatched,
    clarificationQuestion,
  };
}

function composeTemplatePrompt(
  basePrompt: string,
  taskTemplate: AgentTaskTemplate | null,
  styleTemplates: AgentStyleTemplate[],
  fallbackNegativePrompt: string,
  variables: Record<string, string>,
) {
  const promptParts: string[] = [];
  const negativeParts: string[] = [];

  const renderedTaskPrompt = taskTemplate ? renderTemplate(taskTemplate.prompt_template, variables).trim() : '';
  const renderedTaskNegative = taskTemplate ? renderTemplate(taskTemplate.negative_prompt_template, variables).trim() : '';
  const renderedAction = taskTemplate ? renderTemplate(taskTemplate.recommended_action_template, variables).trim() : '';

  if (renderedTaskPrompt) promptParts.push(renderedTaskPrompt);
  if (basePrompt.trim()) promptParts.push(basePrompt.trim());

  for (const template of styleTemplates) {
    const stylePrompt = renderTemplate(template.style_prompt_fragment, variables).trim();
    const styleNegative = renderTemplate(template.negative_prompt_fragment, variables).trim();
    if (stylePrompt) promptParts.push(stylePrompt);
    if (styleNegative) negativeParts.push(styleNegative);
  }

  if (renderedTaskNegative) negativeParts.unshift(renderedTaskNegative);
  if (fallbackNegativePrompt.trim()) negativeParts.unshift(fallbackNegativePrompt.trim());

  return {
    finalPrompt: promptParts.filter(Boolean).join('\n'),
    finalNegativePrompt: Array.from(new Set(negativeParts.filter(Boolean))).join(', '),
    recommendedAction: renderedAction,
  };
}

function setConversationSending(conversationId: string, isSending: boolean) {
  useChatStore.setState(state => ({
    runtimeById: {
      ...state.runtimeById,
      [conversationId]: { isSending },
    },
  }));
}

function clearAbort(conversationId: string) {
  useChatStore.setState(state => {
    const next = { ...state.abortCtrls };
    delete next[conversationId];
    return { abortCtrls: next };
  });
}

function resolveNextActiveConversationId(
  previousConversations: ChatConversation[],
  remainingConversations: ChatConversation[],
  deletedId: string,
  currentActiveId: string | null,
) {
  if (remainingConversations.length === 0) return null;
  if (currentActiveId !== deletedId) {
    return remainingConversations.some(conversation => conversation.id === currentActiveId)
      ? currentActiveId
      : remainingConversations[0].id;
  }

  const deletedIndex = previousConversations.findIndex(conversation => conversation.id === deletedId);
  if (deletedIndex === -1) return remainingConversations[0].id;

  const nextAtSameIndex = remainingConversations[deletedIndex];
  if (nextAtSameIndex) return nextAtSameIndex.id;

  const previousConversation = remainingConversations[deletedIndex - 1];
  return previousConversation?.id || null;
}

function patchMessage(conversationId: string, messageId: string, patch: Partial<ChatMessage>) {
  useChatStore.setState(state => ({
    conversations: state.conversations.map(conversation =>
      conversation.id === conversationId
        ? {
            ...conversation,
            messages: conversation.messages.map(message => (message.id === messageId ? { ...message, ...patch } : message)),
          }
        : conversation,
    ),
  }));
}

function finishConversationText(conversationId: string, messageId: string, content: string, extra?: Partial<ChatMessage>) {
  patchMessage(conversationId, messageId, { content, ...extra });
  setConversationSending(conversationId, false);
  clearAbort(conversationId);
  useChatStore.getState().scheduleSaveConversation(conversationId);
}

function dropConversationMessage(conversationId: string, messageId: string) {
  useChatStore.setState(state => ({
    conversations: state.conversations.map(conversation =>
      conversation.id === conversationId
        ? {
            ...conversation,
            messages: conversation.messages.filter(message => message.id !== messageId),
          }
        : conversation,
    ),
  }));
  setConversationSending(conversationId, false);
  clearAbort(conversationId);
  useChatStore.getState().scheduleSaveConversation(conversationId);
}

async function retryTaskFromDraft(conversationId: string, draft: AgentTaskDraft) {
  if (!draft.linked_task_id) {
    throw new Error('当前没有可重新提交的任务，请先确认一个提案或到任务列表重试。');
  }

  const retriedTask = await api.retryTask(draft.linked_task_id);
  await useTaskStore.getState().loadTasks();
  const syncedTask = useTaskStore.getState().tasks.find(item => item.id === retriedTask.id);

  useChatStore.setState(state => ({
    conversations: state.conversations.map(conversation =>
      conversation.id === conversationId
        ? {
            ...conversation,
            conversation_mode: 'task_flow',
            active_task_draft: conversation.active_task_draft
              ? {
                  ...conversation.active_task_draft,
                  linked_task_id: retriedTask.id,
                  stage: 'queued',
                  updated_at: new Date().toISOString(),
                }
              : conversation.active_task_draft,
          }
        : conversation,
    ),
  }));

  return { task: retriedTask, syncedTask };
}

async function createTaskFromProposal(conversationId: string, messageId: string, proposal: AgentProposal) {
  const defaults = useSettingsStore.getState().settings;
  if (!defaults.default_output_dir) {
    throw new Error('请先在「设置与更新 → 图片与文件」中配置输出目录。');
  }

  const referenceBoundDesignTask =
    proposal.intent === 'image_generate'
    && isReferenceBoundDesignText(
      `${proposal.user_prompt_raw || ''}\n${proposal.final_prompt || ''}`,
      proposal.source_images.length,
    );
  const effectiveIntent = referenceBoundDesignTask ? 'image_edit' : proposal.intent;
  const effectiveApiKind =
    referenceBoundDesignTask && proposal.api_kind === 'generation'
      ? 'edit'
      : proposal.api_kind;
  const normalizedSourceImages = referenceBoundDesignTask ? proposal.source_images.filter(Boolean) : proposal.source_images;

  if (referenceBoundDesignTask && normalizedSourceImages.length < 2) {
    throw new Error('该详情图任务需要至少 2 张参考图：1 张模特图 + 1 张产品白底图。');
  }
  if (effectiveIntent === 'image_edit' && normalizedSourceImages.length === 0) {
    throw new Error('图生图任务缺少参考图，无法继续执行。');
  }

  const enabledBatchItems = (proposal.batch_items || []).filter(item => item.enabled !== false);
  const executionMode = proposal.execution_mode || 'single';
  const count = executionMode === 'batch' ? Math.max(1, enabledBatchItems.length) : 1;
  if (executionMode === 'batch' && enabledBatchItems.length === 0) {
    throw new Error('请至少保留一个批量子任务后再执行。');
  }

  // 生成前预占额度（remove_background 已无服务端计费）
  const billingRequestId = effectiveIntent === 'remove_background'
    ? undefined
    : await authorizeImageTaskOrThrow(count);

  let task: Task;
  try {
    task = await api.createTask({
    prompt: proposal.final_prompt,
    negative_prompt: proposal.final_negative_prompt,
    user_prompt_raw: proposal.user_prompt_raw,
    final_prompt: proposal.final_prompt,
    final_negative_prompt: proposal.final_negative_prompt,
    prompt_optimized: true,
    prompt_optimization: {
      applied: true,
      provider_name: proposal.planner_provider_name_snapshot,
      model_name: proposal.planner_model_display_name_snapshot,
      original_prompt: proposal.user_prompt_raw,
      optimized_at: new Date().toISOString(),
    },
    agent_intent: effectiveIntent,
    task_source: 'agent',
    size: defaults.default_size,
    quality: defaults.default_quality,
    output_format: effectiveIntent === 'remove_background' ? 'png' : defaults.default_format,
    count,
    output_dir: defaults.default_output_dir,
    task_type: effectiveIntent === 'image_edit' ? 'edit' : effectiveIntent === 'remove_background' ? 'remove_background' : 'generate',
    source_images: normalizedSourceImages,
    execution_mode: executionMode,
    batch_strategy: proposal.batch_strategy,
    task_plan_summary: proposal.task_plan_summary || (executionMode === 'batch' ? `${count} 个批量子任务` : ''),
    batch_items: enabledBatchItems,
    composite_layout: executionMode === 'single' ? proposal.composite_layout : undefined,
    subject_entities: executionMode === 'single' ? proposal.subject_entities : undefined,
  });
  } catch (err) {
    if (billingRequestId) void settleImageTask(billingRequestId, false, 0, 'create task failed');
    throw err;
  }
  if (billingRequestId) registerTaskAuthorization(task.id, billingRequestId);

  try {
    await api.appendAgentTemplateLog({
      id: '',
      conversation_id: conversationId,
      message_id: messageId,
      task_id: task.id,
      matched_task_template_id: proposal.matched_task_template_id || '',
      matched_style_template_ids: proposal.matched_style_template_ids || [],
      user_prompt_raw: proposal.user_prompt_raw,
      final_prompt: proposal.final_prompt,
      final_negative_prompt: proposal.final_negative_prompt,
      recommended_action: proposal.recommended_action,
      intent: effectiveIntent,
      api_kind: effectiveApiKind,
      confidence: proposal.confidence,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    console.warn('appendAgentTemplateLog failed', error);
  }

  useTaskStore.getState().addTask(task);
  await useTaskStore.getState().loadTasks();
  const syncedTask = useTaskStore.getState().tasks.find(item => item.id === task.id);
  useChatStore.setState(state => ({
    conversations: state.conversations.map(conversation =>
      conversation.id === conversationId
        ? {
            ...conversation,
            active_task_draft: conversation.active_task_draft
              ? {
                  ...conversation.active_task_draft,
                  stage: 'queued',
                  linked_task_id: task.id,
                  updated_at: new Date().toISOString(),
                }
              : null,
          }
        : conversation,
    ),
  }));
  finishConversationText(
    conversationId,
    messageId,
    [
      syncedTask ? '任务已创建' : '任务已提交，但任务列表尚未同步，请刷新队列',
      `任务编号：${task.id.slice(0, 8)}`,
      `任务类型：${task.task_type === 'edit' ? '图生图' : task.task_type === 'remove_background' ? '透明背景' : '文生图'}`,
      executionMode === 'batch' ? `批量任务：${count} 个子任务 / ${proposal.batch_strategy}` : (proposal.composite_layout ? `输出模式：单张复合构图（${proposal.composite_layout.panelCount} 格）` : ''),
      proposal.subject_entities?.length ? `主体：${proposal.subject_entities.join('、')}` : '',
      proposal.task_plan_summary ? `任务计划：${proposal.task_plan_summary}` : '',
      proposal.matched_task_template_name ? `主任务模板：${proposal.matched_task_template_name}` : '',
      proposal.matched_style_template_names?.length ? `风格模板：${proposal.matched_style_template_names.join('、')}` : '',
      `最终提示词：${proposal.final_prompt}`,
      proposal.final_negative_prompt ? `负面提示词：${proposal.final_negative_prompt}` : '',
      `执行接口：${effectiveApiKind}`,
    ].filter(Boolean).join('\n'),
    {
      agent_proposal: { ...proposal, intent: effectiveIntent as AgentProposal['intent'], api_kind: effectiveApiKind, status: 'confirmed', linked_task_id: task.id },
      is_image: true,
    },
  );
}

function markProposalSubmitting(conversationId: string, messageId: string, proposal: AgentProposal) {
  patchMessage(conversationId, messageId, {
    agent_proposal: { ...proposal, status: 'submitting' },
  });
}

function stageDisplayContent(stage: import('../types').TaskStage, task?: Task): string {
  switch (stage) {
    case 'planning': return '⚡ 正在规划任务……';
    case 'planning_failed': return '❌ 任务规划失败';
    case 'needs_clarification': return '⚡ 任务需要补充信息';
    case 'waiting_confirm': return '⚡ 任务已创建，等待确认';
    case 'queued': return '⚡ 任务已确认，正在排队……';
    case 'analyzing': return '⚡ 正在分析任务……';
    case 'running': return '⚡ 正在生成图片……';
    case 'saving': return '⚡ 正在保存结果……';
    case 'success':
      return task
        ? `✅ 任务完成（共 ${task.success_count} 张）`
        : '✅ 任务完成';
    case 'failed': return '❌ 任务执行失败';
    case 'cancelled': return '⚠ 任务已取消';
    case 'interrupted': return '⚠ 任务因应用中断未完成';
    default: return '';
  }
}

// ============================================================================
// Task Execution Readiness —— UI / confirmTask / executeTask 共用的唯一真相源
// ----------------------------------------------------------------------------
// 修复场景：以前 needs_clarification 的卡被错误标成 stage='waiting_confirm'，
// UI 显示"确认执行"，用户点击后才发现 pendingParams 为 undefined，弹出
// "任务参数缺失，无法执行。"。
//
// 现在这里统一回答一个问题：当前这张任务卡，能不能进入 execute 阶段？
//   - stage 必须是 waiting_confirm。
//   - needs_clarification 必须不存在 / 等价 falsy。
//   - finalPrompt 必须存在。
//   - executionModel 必须存在。
//   - pendingParams 必须存在。
//   - 如果是 edit / remove_background / 参考：source image 必须存在。
//
// UI 用它决定按钮可见性；confirmTask 用它做二次保护；executeTask 用它做最终拦截。
// ============================================================================

export type TaskExecutionReadinessReason =
  | 'ready'
  | 'needs_clarification'
  | 'not_waiting_confirm'
  | 'missing_final_prompt'
  | 'missing_execution_model'
  | 'missing_task_type'
  | 'missing_pending_params'
  | 'missing_source_image'
  | 'invalid_execution_params';

export interface TaskExecutionReadiness {
  executable: boolean;
  reasonCode: TaskExecutionReadinessReason;
  reason?: string;
}

export function getTaskExecutionReadiness(task: TaskMessageState | undefined | null): TaskExecutionReadiness {
  if (!task) {
    return {
      executable: false,
      reasonCode: 'missing_pending_params',
      reason: '任务不存在。',
    };
  }
  // 1. needs_clarification 是独立的不可执行态，必须最先拦。
  if (task.stage === 'needs_clarification' || task.clarification) {
    return {
      executable: false,
      reasonCode: 'needs_clarification',
      reason: '当前任务仍需要补充信息，暂不能执行。',
    };
  }
  // 2. 只有 waiting_confirm 才允许进入 execute。其它 stage 一律拒绝。
  if (task.stage !== 'waiting_confirm') {
    return {
      executable: false,
      reasonCode: 'not_waiting_confirm',
      reason: `当前任务状态（${task.stage}）不允许执行。`,
    };
  }
  // 3. waiting_confirm 必须满足完整执行条件 —— 否则视为 malformed。
  if (!task.finalPrompt || !task.finalPrompt.trim()) {
    return {
      executable: false,
      reasonCode: 'missing_final_prompt',
      reason: '任务规划数据不完整（缺少最终提示词），请重新规划。',
    };
  }
  if (!task.executionModel) {
    return {
      executable: false,
      reasonCode: 'missing_execution_model',
      reason: '任务规划数据不完整（缺少执行模型），请重新规划。',
    };
  }
  if (!task.taskType) {
    return {
      executable: false,
      reasonCode: 'missing_task_type',
      reason: '任务规划数据不完整（缺少任务类型），请重新规划。',
    };
  }
  if (!task.pendingParams) {
    return {
      executable: false,
      reasonCode: 'missing_pending_params',
      reason: '任务规划数据不完整，请重新规划。',
    };
  }
  // 4. edit / remove_background 类任务必须携带 source image。
  // 参考 ResolvedTaskKind：image_edit / image_reference_generation 也走 edit api。
  const isEditLike =
    task.taskType === 'edit'
    || task.taskType === 'remove_background'
    || task.resolvedTaskKind === 'image_edit'
    || task.resolvedTaskKind === 'image_reference_generation';
  if (isEditLike) {
    const hasSource =
      !!task.sourceImageId
      || !!task.sourceImagePath
      || (typeof task.sourceImageCount === 'number' && task.sourceImageCount > 0)
      || (task.pendingParams.source_images && task.pendingParams.source_images.length > 0);
    if (!hasSource) {
      return {
        executable: false,
        reasonCode: 'missing_source_image',
        reason: '检测到这是图片编辑任务，但没有找到明确的源图片，请重新规划。',
      };
    }
  }
  return { executable: true, reasonCode: 'ready' };
}

/**
 * 当前 conversation 内最近一张 needs_clarification 任务卡。
 * 用于把用户下一条消息路由成"对同一任务的补充回答"而不是新任务。
 *
 * 选择策略：从尾部往前扫，找到第一条仍然处于 needs_clarification 阶段、
 * 并且尚未被任何后续 user message 显式"超越"的任务卡。
 *
 * 注意：用户如果在 clarification 之后又发起明显的新任务（"画一张XXX"），
 * sendTaskMessage 侧会基于文本判断是否要把它视为新任务，而不是无脑吸附。
 */
function findPendingClarificationTask(
  conversation: ChatConversation | undefined,
): { message: ChatMessage; task: TaskMessageState } | null {
  if (!conversation) return null;
  // 从尾部往前找：最近一条仍处于 needs_clarification 的 task_message。
  for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
    const m = conversation.messages[i];
    const tm = m.task_message;
    if (!tm) continue;
    if (tm.stage === 'needs_clarification') {
      return { message: m, task: tm };
    }
    // 一旦遇到任何 stage=success / failed / cancelled / waiting_confirm / running / planning / interrupted
    // 的"新任务"卡，意味着用户已经走过了 clarification，不要再继续往前找。
    // 这样保证我们只吸附"最近的、尚未被打断的"clarification。
    if (
      tm.stage === 'waiting_confirm'
      || tm.stage === 'running'
      || tm.stage === 'success'
      || tm.stage === 'failed'
      || tm.stage === 'cancelled'
      || tm.stage === 'planning'
      || tm.stage === 'interrupted'
    ) {
      // 但是 planning 也可能是 clarification 重新规划过程中的中间态 ——
      // 我们仍然停止向前查找，等用户主动操作那张卡。
      return null;
    }
  }
  return null;
}

/**
 * 判断一段用户输入是否"明显是新任务"，从而即便当前会话存在 pending clarification
 * 也不应该被自动吸附为补充回答。例如：
 *   - "给我生成一张日本街道夜景"
 *   - "新建一个 XXX"
 *   - "再来一张 YYY"（"再来一张" 在产品里专门用于 regenerate，不应作为 clarification 回答）
 *
 * 注意：纯角色名 / 短回答（"黑崎一护"、"东京"）不应被判为新任务。
 */
function looksLikeExplicitNewTask(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  // 长文本更可能是新任务而不是补充回答
  if (t.length > 80) return true;
  const newTaskPatterns = [
    /^(?:给我|帮我|请|想要|来一张|来一个|新建|重新做|再做一张|再来一张|画一张|画一个|生成一张|生成一个|做一张|做一个)/,
    /(再生成|新生成|新做一张|新画一张)/,
  ];
  return newTaskPatterns.some(re => re.test(t));
}

/**
 * 用户在 clarification 之后给出的回答：拼成一段对 Planner 友好的"任务补充上下文"。
 *
 * 注意：
 *   - 原任务必须保留。
 *   - Planner 上一轮的 clarification_question 必须列出，让 Planner 知道自己问过什么。
 *   - 用户的本轮回答必须显式给出。
 *   - 同时还要把澄清轮次 +1，让 Planner 知道这是第 N 次补充，避免再次循环追问。
 */
function buildClarificationContinuationText(input: {
  originalRequest: string;
  clarificationQuestion: string;
  userAnswer: string;
  attempt: number;
}): string {
  const { originalRequest, clarificationQuestion, userAnswer, attempt } = input;
  const lines: string[] = [];
  lines.push('[任务补充上下文]');
  lines.push('- 以下是一段"原任务 + Planner 上一轮 clarification + 用户本轮补充"的组合，必须视为同一个任务的完整描述。');
  lines.push('- 不要再把本轮内容当成独立新任务。');
  lines.push(`- clarification_round: ${attempt}（这是第 ${attempt} 次补充；如果你仍然打算再次询问已经在下面回答过的信息，必须停止并直接给出 ready 规划。）`);
  lines.push('');
  lines.push('[原始任务]');
  lines.push(originalRequest || '(无)');
  lines.push('');
  lines.push('[上一轮 Planner 要求补充的信息]');
  lines.push(clarificationQuestion || '(无)');
  lines.push('');
  lines.push('[用户本轮补充]');
  lines.push(userAnswer || '(无)');
  lines.push('');
  lines.push('请基于以上完整信息重新生成可执行规划，不要再次询问已经补充过的信息。');
  return lines.join('\n');
}

function summarizePrompt(text: string): string {
  const trimmed = (text || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  if (trimmed.length <= 48) return trimmed;
  return trimmed.slice(0, 46) + '…';
}

function findMessageByTaskId(conversationId: string, taskId: string): ChatMessage | undefined {
  const conversation = useChatStore.getState().conversations.find(c => c.id === conversationId);
  if (!conversation) return undefined;
  return conversation.messages.find(m => m.task_message?.taskId === taskId);
}

function patchTaskMessageState(
  conversationId: string,
  messageId: string,
  updater: (current: TaskMessageState) => TaskMessageState,
) {
  useChatStore.setState(state => ({
    conversations: state.conversations.map(conversation =>
      conversation.id !== conversationId ? conversation : {
        ...conversation,
        messages: conversation.messages.map(message => {
          if (message.id !== messageId || !message.task_message) return message;
          return { ...message, task_message: updater(message.task_message) };
        }),
      },
    ),
  }));
  // 关键修复：任何 task_message 状态变更都必须落到磁盘，否则切换页面 / 重启后会把
  // 内存里的状态全部丢失。以前这一层不调度 save，依赖每个调用方自己 saveConversation；
  // 现在直接挂一层兜底（debounce 500ms，多个连续 patch 会合并成一次写盘）。
  useChatStore.getState().scheduleSaveConversation(conversationId);
}

function patchTaskMessageByTaskId(taskId: string, updater: (current: TaskMessageState) => TaskMessageState) {
  const touchedConversationIds: string[] = [];
  useChatStore.setState(state => ({
    conversations: state.conversations.map(conversation => {
      let touched = false;
      const messages = conversation.messages.map(message => {
        if (message.task_message?.taskId !== taskId) return message;
        touched = true;
        return { ...message, task_message: updater(message.task_message) };
      });
      if (touched) touchedConversationIds.push(conversation.id);
      return touched ? { ...conversation, messages } : conversation;
    }),
  }));
  // 同步持久化：跨会话扫描器只更新内存的话，切换页面就会丢。
  for (const cid of touchedConversationIds) {
    useChatStore.getState().scheduleSaveConversation(cid);
  }
}

function buildTaskMessageFromTask(task: Task, base?: Partial<TaskMessageState>): TaskMessageState {
  const stage = requireTaskStage(task);
  const nowIso = new Date().toISOString();
  // ====== 执行耗时（spec 五十一~五十四节）======
  // startedAt 由确认执行时写入（base.executionStartedAt）；
  // 终态（completed / failed / cancelled）时记录 finishedAt 并计算 durationMs。
  // 失败也保存 duration（方便诊断）。仍在执行时 duration 保持 undefined，
  // UI 用 Date.now() - executionStartedAt 实时显示。
  const executionStartedAt = base?.executionStartedAt;
  const isTerminal = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
  let executionFinishedAt = base?.executionFinishedAt;
  let executionDurationMs = base?.executionDurationMs;
  if (isTerminal && executionStartedAt && !executionFinishedAt) {
    executionFinishedAt = nowIso;
    const start = Date.parse(executionStartedAt);
    if (Number.isFinite(start) && start > 0) {
      executionDurationMs = Math.max(0, Date.parse(nowIso) - start);
    }
    console.log('[TaskExecutionTimer]', {
      taskId: task.id,
      event: 'finish',
      status: task.status,
      duration_ms: executionDurationMs,
    });
  }
  return {
    taskId: task.id,
    status: task.status,
    stage,
    title: base?.title || summarizePrompt(task.user_prompt_raw || task.prompt),
    prompt: base?.prompt || task.user_prompt_raw || task.prompt,
    finalPrompt: base?.finalPrompt || task.final_prompt || task.prompt,
    finalNegativePrompt: base?.finalNegativePrompt || task.final_negative_prompt || '',
    model: base?.model,
    agentModel: base?.agentModel,
    executionModel: base?.executionModel || DEFAULT_EXECUTION_MODEL,
    size: task.size,
    count: task.count,
    error: base?.error,
    images: base?.images || [],
    resultImageIds: base?.resultImageIds,
    createdAt: base?.createdAt || task.created_at || nowIso,
    updatedAt: nowIso,
    taskType: base?.taskType || (task.task_type as TaskMessageState['taskType']) || '',
    apiKind: base?.apiKind,
    sourceImageCount: base?.sourceImageCount ?? task.source_images.length,
    sourceImageId: base?.sourceImageId,
    sourceImageSelection: base?.sourceImageSelection,
    pendingParams: base?.pendingParams,
    confirming: false,
    cancelling: false,
    executionStartedAt,
    executionFinishedAt,
    executionDurationMs,
  };
}

function requireTaskStage(task: Task): import('../types').TaskStage {
  if (task.status === 'completed') return 'success';
  if (task.status === 'failed') return 'failed';
  if (task.status === 'cancelled') return 'cancelled';
  if (task.status === 'running') return 'running';
  return 'queued';
}

/**
 * 从子任务错误文本里推断一个粗粒度的 errorKind，用于失败卡图标 / 文案微调。
 * 不需要严格准确，只要能区分 "网络层" / "鉴权" / "上游业务" / "未知"。
 */
function inferExecutionErrorKind(errorText: string): string | undefined {
  if (!errorText) return undefined;
  const text = errorText.toLowerCase();
  if (/\b401\b|\b403\b|unauthor|forbidden|鉴权|token|invalid_api_key/.test(text)) return 'auth';
  if (/\b429\b|rate.?limit|限流/.test(text)) return 'rate_limit';
  if (/\b5\d{2}\b|server|internal|上游|upstream/.test(text)) return 'upstream_api';
  if (/\b400\b|invalid_request|bad request|参数|invalid/.test(text)) return 'invalid_request';
  if (/timeout|超时|timed? ?out/.test(text)) return 'timeout';
  if (/connect|网络|connection|econnreset|dns/.test(text)) return 'connect';
  return undefined;
}

async function loadTaskResultImages(task: Task): Promise<TaskMessageImage[]> {
  const allImages = useImageStore.getState().images;
  let candidates = allImages.filter(img => img.task_id === task.id && !img.missing);
  if (allImages.length === 0 || candidates.length === 0) {
    try {
      await useImageStore.getState().loadImages();
    } catch {}
    candidates = useImageStore.getState().images.filter(img => img.task_id === task.id && !img.missing);
  }
  const results: TaskMessageImage[] = [];
  for (const img of candidates) {
    let url = '';
    try {
      url = await api.readImageData(img.local_path);
    } catch {
      continue;
    }
    if (!url) continue;
    results.push({
      id: img.id,
      url,
      localPath: img.local_path,
      width: img.width ?? null,
      height: img.height ?? null,
      file_name: img.file_name,
      imageId: img.id,
    });
  }
  return results;
}

/**
 * 重新为已经持久化的 TaskMessageImage 列表生成 URL。
 * 持久化时我们会剥离 data URL，只保留 localPath，重新进入会话或切换页面时需要调用此函数补回 URL。
 */
async function refreshTaskMessageImageUrls(images: TaskMessageImage[]): Promise<TaskMessageImage[]> {
  if (!images || images.length === 0) return images;
  const next: TaskMessageImage[] = [];
  let changed = false;
  for (const img of images) {
    if (img.url) {
      next.push(img);
      continue;
    }
    if (!img.localPath) {
      next.push(img);
      continue;
    }
    try {
      const url = await api.readImageData(img.localPath);
      if (url) {
        next.push({ ...img, url, imageId: img.imageId || img.id });
        changed = true;
      } else {
        next.push(img);
      }
    } catch {
      next.push(img);
    }
  }
  return changed ? next : images;
}

function taskMessageNeedsImageRefresh(state: TaskMessageState | undefined): boolean {
  if (!state) return false;
  if (state.stage !== 'success') return false;
  if (!state.images || state.images.length === 0) return false;
  return state.images.some(img => !img.url && !!img.localPath);
}

/**
 * 扫描会话中的 SUCCESS 任务卡，对缺少 URL 的图片记录重新从本地路径读取，
 * 让历史会话 / 切换页面 / 应用重启后图片仍然能正常显示。
 * convId 为空时扫描全部会话（首屏性能：loadConversations 只传激活会话）。
 */
async function hydrateTaskMessageImageUrls(convId?: string | null) {
  const conversations = useChatStore.getState().conversations
    .filter(conv => !convId || conv.id === convId);
  let anyChanged = false;
  for (const conv of conversations) {
    for (const msg of conv.messages) {
      if (!msg.task_message) continue;
      if (!taskMessageNeedsImageRefresh(msg.task_message)) continue;
      const refreshed = await refreshTaskMessageImageUrls(msg.task_message.images || []);
      if (refreshed !== msg.task_message.images) {
        anyChanged = true;
        patchMessage(conv.id, msg.id, {
          task_message: { ...msg.task_message, images: refreshed },
        });
        console.log('[TaskRestore] restore image urls', msg.task_message.taskId, 'count=' + refreshed.filter(i => i.url).length);
      }
    }
  }
  if (anyChanged) {
    try {
      await useChatStore.getState().save();
    } catch (err) {
      console.warn('[TaskRestore] save after hydrate failed', err);
    }
  }
}

/**
 * 扫描会话，对于没有 active_image_id 但存在成功任务卡的会话，
 * 把最近一张成功图片作为该会话的 active image。
 * 这是从历史会话或应用重启中恢复"连续编辑上下文"的关键。
 */
function restoreActiveImageIds(convId?: string | null) {
  const conversations = useChatStore.getState().conversations
    .filter(conv => !convId || conv.id === convId);
  let anyChanged = false;
  for (const conv of conversations) {
    if (conv.active_image_id && conv.active_image_path) continue;
    let foundImageId: string | null = null;
    let foundImagePath: string | null = null;
    let foundSetAt: string | null = null;
    for (let i = conv.messages.length - 1; i >= 0; i -= 1) {
      const m = conv.messages[i];
      const tm = m.task_message;
      if (!tm || tm.stage !== 'success' || !tm.images?.length) continue;
      const first = tm.images[0];
      if (first.localPath) {
        foundImageId = first.imageId || first.id;
        foundImagePath = first.localPath;
        foundSetAt = tm.updatedAt || tm.createdAt || m.created_at || null;
        break;
      }
    }
    if (foundImageId && foundImagePath) {
      console.log('[Conversation] restore activeImageId:', foundImageId);
      useChatStore.setState(state => ({
        conversations: state.conversations.map(c =>
          c.id === conv.id
            ? {
                ...c,
                active_image_id: foundImageId,
                active_image_path: foundImagePath,
                active_image_source: 'auto',
                ...(foundSetAt ? { active_image_set_at: foundSetAt } : {}),
              }
            : c,
        ),
      }));
      anyChanged = true;
    }
  }
  if (anyChanged) {
    void useChatStore.getState().save().catch(err => console.warn('[TaskRestore] save after restore active ids failed', err));
  }
}

// ============================================================================
// planTaskCore —— 把 sendTaskMessage 里"调用 Planner + 校验结果"那部分抽出来，
// 让首次提交 (sendTaskMessage) 与"重新规划" (replanTaskMessage) 共享同一份逻辑。
// 它本身不修改任何 UI 状态，只返回结构化的结果，由调用方决定如何写回消息卡片。
// ============================================================================
type PlannerSourceImageContext = {
  sourceImageId: string | null;
  sourceImagePath: string | null;
  sourceImagePreviewUrl?: string;
  sourceImageFileName?: string;
  /** 源图绑定方式快照（attachment / explicit / latest / none），随任务卡持久化。 */
  sourceImageSelection?: SourceImageSelection;
};

type PlannerCoreOutcome =
  | ({
      kind: 'planning_failed';
      taskType: 'generate' | 'edit' | 'remove_background';
      apiKind: 'generation' | 'edit' | 'remove_background' | 'upscale';
      error: string;
      agentModel?: string;
      executionModel: string;
      plannerDiagnostic?: import('../types').PlannerDiagnostic;
    } & PlannerSourceImageContext)
  | ({
      kind: 'clarification';
      clarificationQuestion: string;
      /**
       * Planner 标记的可能缺失字段（仅用于诊断 / UI 展示），例如 ['source_image', 'character_name']。
       * 可缺省。
       */
      missingFields?: string[];
      taskType: 'generate' | 'edit' | 'remove_background';
      apiKind: 'generation' | 'edit' | 'remove_background' | 'upscale';
      agentModel?: string;
      executionModel: string;
      resolvedTaskKind?: import('../utils/agent/promptPlanner').ResolvedTaskKind;
    } & PlannerSourceImageContext)
  | ({
      kind: 'waiting_confirm';
      taskType: 'generate' | 'edit' | 'remove_background';
      apiKind: 'generation' | 'edit' | 'remove_background' | 'upscale';
      title: string;
      finalPrompt: string;
      finalNegativePrompt: string;
      pendingParams: CreateTaskParams;
      agentModel?: string;
      executionModel: string;
      resolvedTaskKind?: import('../utils/agent/promptPlanner').ResolvedTaskKind;
      attachmentNames?: string[];
      attachmentDescriptors?: import('../utils/agent/attachmentLabels').PlannerAttachmentDescriptor[];
      orderedAttachments?: import('../types').TaskMessageState['orderedAttachments'];
      editTargetImageCount?: number;
      referenceImageCount?: number;
      resolvedContext?: import('../types').TaskMessageState['resolvedContext'];
      gridLayout?: import('../types').TaskMessageState['gridLayout'];
      compositeLayout?: import('../types').TaskMessageState['compositeLayout'];
      subjectEntities?: import('../types').TaskMessageState['subjectEntities'];
      contextSourceLabel?: string;
    } & PlannerSourceImageContext);

async function planTaskCore(input: {
  text: string;
  agentConfig: ReturnType<typeof resolveAgentConfig>;
  agentDefaults: ReturnType<typeof useSettingsStore.getState>['settings'];
  hasEditableImage: boolean;
  sourceImageCount: number;
  resolved: PlannerSourceImageContext;
  /** 用户当轮新上传的附件路径（首次提交时可能非空；重新规划时恒为空）。 */
  attachmentPaths?: string[];
  /** 用户当轮上传的附件文件名（与 attachmentPaths 同源，但保留原始 name）。 */
  attachmentNames?: string[];
  /** Planner 端的附件语义描述符（图一 / 图二），按用户选择顺序排列。 */
  attachmentDescriptors?: import('../utils/agent/attachmentLabels').PlannerAttachmentDescriptor[];
  /** 任务级上下文继承（多轮补充 / 指代消解 / 作品 / 主体绑定）。 */
  taskSemanticContext?: import('../utils/agent/taskContextResolver').TaskSemanticContext;
  /** Chat → Task 语义 Handoff 上下文（实体列表 / 布局 / 继承提示词）。 */
  chatHandoffContext?: ResolvedChatExecutionContext;
  /** Provider 身份（BYOK）：规划失败时错误归因到具体 Provider。 */
  providerFailure?: TaskPlanInput['providerFailure'];
}): Promise<PlannerCoreOutcome> {
  const {
    text,
    agentConfig,
    agentDefaults,
    hasEditableImage,
    sourceImageCount,
    resolved,
    attachmentPaths = [],
    attachmentNames = [],
    attachmentDescriptors = [],
    taskSemanticContext,
    chatHandoffContext,
    providerFailure,
  } = input;
  const trimmed = (text || '').trim();

  const planResult = await planTaskWithAgent({
    text: trimmed,
    hasEditableImage,
    agentToken: agentConfig.token,
    agentModel: agentConfig.model,
    agentBaseUrl: agentConfig.baseUrl,
    agentBillingMode: agentConfig.billingMode,
    providerFailure,
    sourceImageCount,
    activeImageId: resolved.sourceImageId,
    activeImagePath: resolved.sourceImagePath,
    activeImageTitle: resolved.sourceImageFileName,
    activeImageTaskType: null,
    attachmentNames,
    attachmentDescriptors,
    taskSemanticContext,
    chatHandoffContext,
  });

  console.log('[AgentPlanner]', {
    rawPrompt: planResult.rawPrompt.slice(0, 60),
    taskType: planResult.taskType,
    executionModel: planResult.executionModel,
    agentModel: planResult.agentModel,
    apiKind: planResult.apiKind,
    usedLocalFallback: planResult.usedLocalFallback,
    planningFailed: !!planResult.planningFailed,
    resolvedTaskKind: planResult.resolvedTaskKind,
    augmentationDetected: !!taskSemanticContext?.augmentationDetected,
    inheritedFromPreviousTurn: !!taskSemanticContext?.inheritedFromPreviousTurn,
  });

  const baseContext: PlannerSourceImageContext = {
    sourceImageId: resolved.sourceImageId,
    sourceImagePath: resolved.sourceImagePath,
    sourceImagePreviewUrl: resolved.sourceImagePreviewUrl,
    sourceImageFileName: resolved.sourceImageFileName,
    sourceImageSelection: resolved.sourceImageSelection,
  };

  if (planResult.planningFailed) {
    return {
      kind: 'planning_failed',
      taskType: planResult.taskType,
      apiKind: planResult.apiKind,
      error: planResult.errorMessage || '任务规划失败，请稍后重试或修改描述。',
      agentModel: agentConfig.model,
      executionModel: planResult.executionModel,
      plannerDiagnostic: planResult.plannerDiagnostic,
      ...baseContext,
    };
  }

  const apiKind = planResult.apiKind;
  const taskType = planResult.taskType;

  // 合法性校验：Planner 判 EDIT 但缺少 sourceImageId —— 直接失败，不要"自动改成 generation"。
  if (taskType === 'edit' && !resolved.sourceImageId && attachmentPaths.length === 0) {
    console.warn('[TaskRouting] invalid edit task without sourceImageId', {
      plannerIntent: planResult.intent,
    });
    return {
      kind: 'planning_failed',
      taskType,
      apiKind,
      error: '检测到这是图片编辑任务，但没有找到明确的源图片。请点击"选择图片"绑定一张图，或修改描述后重新规划。',
      agentModel: agentConfig.model,
      executionModel: planResult.executionModel,
      plannerDiagnostic: {
        model: agentConfig.model,
        errorKind: 'planner_schema_invalid',
        errorStage: '任务结构校验',
        reason: '检测到这是图片编辑任务，但没有找到明确的源图片。',
      },
      ...baseContext,
    };
  }

  if (planResult.needsClarification && planResult.clarificationQuestion) {
    return {
      kind: 'clarification',
      clarificationQuestion: planResult.clarificationQuestion,
      missingFields: planResult.clarificationMissingFields,
      taskType,
      apiKind,
      agentModel: agentConfig.model,
      executionModel: planResult.executionModel,
      resolvedTaskKind: planResult.resolvedTaskKind,
      ...baseContext,
    };
  }

  // Generation 清理：Planner 判 generation 时，必须把 source 字段全部清空，
  // 防止上一轮 EDIT 的源图污染本轮 GENERATION。
  let effectiveSourceImageId: string | null = resolved.sourceImageId;
  let effectiveSourceImagePath: string | null = resolved.sourceImagePath;
  let effectiveSourceImagePreviewUrl: string | undefined = resolved.sourceImagePreviewUrl;
  let effectiveSourceImageFileName: string | undefined = resolved.sourceImageFileName;
  let effectiveSourceImageSelection: SourceImageSelection | undefined = resolved.sourceImageSelection;
  if (taskType === 'generate') {
    if (effectiveSourceImageId || effectiveSourceImagePath || attachmentPaths.length > 0) {
      console.warn('[TaskRouting] dropping source image fields for generation task', {
        droppedActiveImageId: effectiveSourceImageId,
        droppedAttachmentCount: attachmentPaths.length,
      });
    }
    effectiveSourceImageId = null;
    effectiveSourceImagePath = null;
    effectiveSourceImagePreviewUrl = undefined;
    effectiveSourceImageFileName = undefined;
    effectiveSourceImageSelection = 'none';
  }

  const finalPrompt = planResult.optimizedPrompt || trimmed;
  const negativePrompt = planResult.negativePrompt || '';
  const sourceImagePaths: string[] = taskType === 'generate'
    ? []
    : (effectiveSourceImagePath ? [effectiveSourceImagePath, ...attachmentPaths] : attachmentPaths);

  if (taskType === 'generate' && sourceImagePaths.length > 0) {
    console.error('[TaskRouting] invalid generation task with source image', { sourceImagePaths });
  }
  if (taskType === 'edit' && sourceImagePaths.length === 0) {
    console.error('[TaskRouting] invalid edit task without source image');
  }

  // 附件角色拆分（仅用于 UI 展示）：
  //   - 编辑任务：第一张作为 edit target，其余作为 reference。
  //   - 参考图生成：所有上传图均视为 reference。
  //   - 文生图：均为 0。
  const localResolvedKind = planResult.resolvedTaskKind;
  let editTargetImageCount = 0;
  let referenceImageCount = 0;
  if (taskType === 'edit') {
    if (effectiveSourceImagePath) {
      editTargetImageCount = 1;
      referenceImageCount = Math.max(0, attachmentPaths.length);
    } else {
      editTargetImageCount = attachmentPaths.length > 0 ? 1 : 0;
      referenceImageCount = Math.max(0, attachmentPaths.length - 1);
    }
  } else if (localResolvedKind === 'image_reference_generation') {
    referenceImageCount = attachmentPaths.length;
  }

  // 调试日志（仅在 dev 工具 console 输出，不影响正式环境）。
  if (typeof console !== 'undefined') {
    if (taskSemanticContext?.augmentationDetected || taskSemanticContext?.inheritedFromPreviousTurn) {
      console.log('[PlannerContextResolve]', {
        currentMessage: trimmed.slice(0, 60),
        resolvedPrimarySubject: taskSemanticContext.primarySubject,
        resolvedWorkTitle: taskSemanticContext.workTitle,
        augmentationDetected: taskSemanticContext.augmentationDetected,
        inheritedFromPreviousTurn: taskSemanticContext.inheritedFromPreviousTurn,
        pronounBindings: taskSemanticContext.pronounBindings,
      });
    }
    if (attachmentNames.length > 0 || editTargetImageCount > 0 || referenceImageCount > 0) {
      console.log('[PlannerAttachments]', {
        total: attachmentNames.length,
        editTargets: editTargetImageCount,
        references: referenceImageCount,
        resolvedTaskKind: localResolvedKind,
      });
    }
    if (localResolvedKind) {
      console.log('[PlannerTaskKind]', {
        hasAttachments: attachmentNames.length > 0,
        userIntent: trimmed.slice(0, 60),
        resolvedTaskKind: localResolvedKind,
        plannerTaskType: taskType,
      });
    }
  }

  // Planner 改写过提示词且非本地回退 → 记为已优化（含模型快照；provider 名 Planner 通道不回传，留空）
  const plannerRewrote = !planResult.usedLocalFallback && finalPrompt !== trimmed;

  const params: CreateTaskParams = {
    prompt: finalPrompt,
    negative_prompt: negativePrompt,
    user_prompt_raw: trimmed,
    final_prompt: finalPrompt,
    final_negative_prompt: negativePrompt,
    prompt_optimized: plannerRewrote,
    prompt_optimization: plannerRewrote ? {
      applied: true,
      model_name: planResult.agentModel,
      original_prompt: trimmed,
      optimized_at: new Date().toISOString(),
    } : { applied: false },
    agent_intent: taskType === 'remove_background' ? 'remove_background' : taskType === 'edit' ? 'image_edit' : 'image_generate',
    task_source: 'agent',
    size: agentDefaults.default_size,
    quality: agentDefaults.default_quality,
    output_format: taskType === 'remove_background' ? 'png' : agentDefaults.default_format,
    count: 1,
    output_dir: agentDefaults.default_output_dir,
    task_type: taskType,
    source_images: sourceImagePaths,
    execution_mode: 'single',
    composite_layout: chatHandoffContext?.orderedSelection?.selectedLabels.length || chatHandoffContext?.grid
      ? {
          type: chatHandoffContext?.grid
            ? (chatHandoffContext.grid.rows === 1 && chatHandoffContext.grid.columns === 3 ? 'triptych' : 'grid')
            : 'triptych',
          panelCount: chatHandoffContext?.grid?.cellCount
            || chatHandoffContext?.orderedSelection?.selectedLabels.length
            || 0,
        }
      : undefined,
    subject_entities: chatHandoffContext?.orderedSelection?.selectedLabels
      ? [...chatHandoffContext.orderedSelection.selectedLabels]
      : undefined,
  };

  return {
    kind: 'waiting_confirm',
    taskType,
    apiKind,
    title: summarizePrompt(planResult.recommendedAction || finalPrompt),
    finalPrompt,
    finalNegativePrompt: negativePrompt,
    pendingParams: params,
    agentModel: agentConfig.model,
    executionModel: planResult.executionModel,
    resolvedTaskKind: localResolvedKind,
    attachmentNames,
    attachmentDescriptors,
    editTargetImageCount,
    referenceImageCount,
    resolvedContext: taskSemanticContext
      ? {
          workTitle: taskSemanticContext.workTitle,
          primarySubject: taskSemanticContext.primarySubject,
          inheritedFromPreviousTurn: taskSemanticContext.inheritedFromPreviousTurn,
          augmentationDetected: taskSemanticContext.augmentationDetected,
          pronounBindings: taskSemanticContext.pronounBindings,
        }
      : undefined,
    gridLayout: chatHandoffContext?.grid
      ? {
          rows: chatHandoffContext.grid.rows,
          columns: chatHandoffContext.grid.columns,
          cellCount: chatHandoffContext.grid.cellCount,
        }
      : undefined,
    compositeLayout: chatHandoffContext?.grid || chatHandoffContext?.orderedSelection
      ? {
          type: chatHandoffContext?.grid
            ? (chatHandoffContext.grid.rows === 1 && chatHandoffContext.grid.columns === 3
                ? 'triptych'
                : 'grid')
            : 'triptych',
          panelCount: chatHandoffContext?.grid?.cellCount
            || chatHandoffContext?.orderedSelection?.selectedLabels.length
            || 0,
        }
      : undefined,
    subjectEntities: chatHandoffContext?.orderedSelection?.selectedLabels
      ? [...chatHandoffContext.orderedSelection.selectedLabels]
      : undefined,
    contextSourceLabel: chatHandoffContext?.sourceLabel,
    sourceImageId: effectiveSourceImageId,
    sourceImagePath: effectiveSourceImagePath,
    sourceImagePreviewUrl: effectiveSourceImagePreviewUrl,
    sourceImageFileName: effectiveSourceImageFileName,
    sourceImageSelection: effectiveSourceImageSelection,
  };
}

/**
 * 规划阶段恢复策略 —— 在 loadConversations 读到 stage='planning' 的卡时调用。
 *
 * 这是本次"页面切换不中断"修复的核心。旧版本无脑把 planning 降级成 planning_failed，
 * 现在 PlannerJob Registry 给出真正的判定：
 *
 *   1. job 仍在跑 → 保持 planning（HTTP 还没回来，继续转圈）
 *   2. job 已 completed/failed 但磁盘 snapshot 还是 planning（race） → 重放 outcome
 *   3. 同 session 但 job 不在 registry（异常） → planner_job_missing_same_session
 *   4. 不同 session（应用真正重启） → planning_interrupted_app_restart
 *
 * 注意：旧版本持久化的 task_message 没有 plannerJobId / planningSessionId 字段，
 * 这种情况按"应用重启"语义处理（保持旧行为），避免历史数据卡死。
 */
function reconcilePlanningMessageWithPlannerJob(
  conversationId: string,
  message: ChatMessage,
) {
  const tm = message.task_message;
  if (!tm || tm.stage !== 'planning') return;

  const jobId = tm.plannerJobId;
  const messageSessionId = tm.planningSessionId;
  const sameSession = !messageSessionId || messageSessionId === APP_SESSION_ID;
  const job = jobId ? getPlannerJob(jobId) : undefined;

  // Case 1 & 2: 同 session 且 job 在 registry
  if (job) {
    if (job.status === 'running') {
      console.log('[PlannerRecovery] keep planning, job still running', {
        conversationId, messageId: message.id, jobId: job.id,
      });
      return;
    }
    // job 已终态 —— 把 outcome 重放一遍，覆盖磁盘的旧 planning snapshot。
    // 这能避免"Planner Promise 刚 resolve，loadConversations 同时跑"的 race。
    if (job.outcome) {
      console.log('[PlannerRecovery] replay settled outcome', {
        conversationId, messageId: message.id, jobId: job.id, status: job.status,
      });
      // staleness guard：job 的 planningRequestId 与磁盘上的 tm.planningRequestId
      // 必须一致，否则用户已经在中间触发过新一轮 replan。
      if (tm.planningRequestId && tm.planningRequestId !== job.planningRequestId) {
        console.warn('[PlannerRecovery] requestId mismatch, skip replay', {
          disk: tm.planningRequestId, job: job.planningRequestId,
        });
        return;
      }
      applyPlannerOutcomeToTaskMessage(conversationId, message.id, job.outcome, {
        planningAttempt: job.planningAttempt,
        planningRequestId: job.planningRequestId,
        prompt: job.appliedPrompt || tm.prompt || '',
      });
    }
    return;
  }

  // Case 4: 不同 session（应用真正重启过）—— 旧 job 不可能还在跑，标记为中断。
  if (!sameSession) {
    console.log('[PlannerRecovery] previous-session interrupted', {
      conversationId, messageId: message.id, messageSessionId, currentSession: APP_SESSION_ID,
    });
    patchTaskMessageState(conversationId, message.id, current => ({
      ...current,
      status: 'failed',
      stage: 'planning_failed',
      error: '上一次任务规划因应用退出而中断，请点击"重新规划"再次尝试。',
      // 清掉旧 job 关联，避免下次又命中"job missing"分支。
      plannerJobId: undefined,
      plannerDiagnostic: {
        model: current.agentModel,
        errorKind: 'planning_interrupted_app_restart',
        errorStage: '规划任务恢复',
        reason: '上一次任务规划因应用退出而中断，请重新规划。',
      },
      updatedAt: new Date().toISOString(),
    }));
    patchMessage(conversationId, message.id, {
      content: stageDisplayContent('planning_failed'),
    });
    return;
  }

  // Case 3: 同 session 但 job 不在 registry —— 这是不该发生的状态，做诊断警告。
  // 不允许永久 spinner，直接显示"规划任务状态异常，请重新规划"。
  console.warn('[PlannerRecovery] WARNING same-session job missing', {
    conversationId, messageId: message.id, jobId,
  });
  patchTaskMessageState(conversationId, message.id, current => ({
    ...current,
    status: 'failed',
    stage: 'planning_failed',
    error: '规划任务状态异常（同一会话内找不到运行中的 PlannerJob），请重新规划。',
    plannerJobId: undefined,
    plannerDiagnostic: {
      model: current.agentModel,
      errorKind: 'planner_job_missing_same_session',
      errorStage: '规划任务恢复',
      reason: '规划任务状态异常（同一会话内找不到运行中的 PlannerJob），请重新规划。',
    },
    updatedAt: new Date().toISOString(),
  }));
  patchMessage(conversationId, message.id, {
    content: stageDisplayContent('planning_failed'),
  });
}

/**
 * 把 planTaskCore 的结果写回到指定的 (conversationId, messageId) 任务卡上。
 * 用于首次提交和重新规划两种路径 —— 都在原地更新同一张卡，不再插入新消息。
 */
function applyPlannerOutcomeToTaskMessage(
  conversationId: string,
  messageId: string,
  outcome: PlannerCoreOutcome,
  options: {
    planningAttempt: number;
    planningRequestId: string;
    prompt: string;
    /**
     * 当前 clarification 轮次（仅 clarification 续接路径会传）。
     * 第一次规划得到 clarification 时为 0 / undefined；用户补充后再规划得到 clarification 时 +1。
     */
    clarificationRound?: number;
  },
) {
  const nowIso = new Date().toISOString();
  if (outcome.kind === 'planning_failed') {
    patchTaskMessageState(conversationId, messageId, current => ({
      ...current,
      status: 'failed',
      stage: 'planning_failed',
      title: '任务规划失败',
      prompt: options.prompt,
      finalPrompt: '',
      finalNegativePrompt: '',
      error: outcome.error,
      agentModel: outcome.agentModel || current.agentModel,
      executionModel: outcome.executionModel || current.executionModel,
      taskType: outcome.taskType,
      apiKind: outcome.apiKind,
      sourceImageId: outcome.sourceImageId ?? undefined,
      sourceImagePath: outcome.sourceImagePath ?? undefined,
      sourceImageSelection: outcome.sourceImageSelection ?? current.sourceImageSelection,
      sourceImagePreviewUrl: outcome.sourceImagePreviewUrl,
      sourceImageFileName: outcome.sourceImageFileName,
      plannerDiagnostic: outcome.plannerDiagnostic,
      // 规划失败时清理任何旧的执行失败诊断，避免 UI 显示错乱
      executionDiagnostic: undefined,
      // 同时清掉 clarification —— 失败和 clarification 是两个独立的不可执行态。
      // 不要让旧 clarification 数据残留影响 UI / readiness 判定。
      clarification: undefined,
      planningAttempt: options.planningAttempt,
      planningRequestId: options.planningRequestId,
      updatedAt: nowIso,
    }));
    patchMessage(conversationId, messageId, {
      content: stageDisplayContent('planning_failed'),
    });
    return;
  }
  if (outcome.kind === 'clarification') {
    // 关键修复（spec）：clarification 是独立的业务态，不能放进 waiting_confirm。
    //  - stage 必须是 'needs_clarification'，与 waiting_confirm 互斥。
    //  - finalPrompt 必须清空（避免 UI 把 clarificationQuestion 当成可执行 prompt）。
    //  - pendingParams 必须 undefined（让 getTaskExecutionReadiness 立刻拦住任何"确认执行"尝试）。
    //  - 把 clarificationQuestion / originalRequest 写到 task.clarification，UI 据此渲染专属卡片。
    //
    // clarificationAttempt 的语义：
    //   - 首次规划得到 clarification（没传 clarificationRound）→ attempt = 1。
    //   - 用户补充后再次得到 clarification（replanTaskMessage 传入了 nextRound）→ attempt = nextRound。
    //   注意：调用方已经在外层把 nextRound 算好了（currentRound + 1），这里不要再 +1。
    const clarificationAttempt = options.clarificationRound != null
      ? options.clarificationRound
      : 1;
    patchTaskMessageState(conversationId, messageId, current => ({
      ...current,
      status: 'pending',
      stage: 'needs_clarification',
      title: '任务需要补充信息',
      prompt: options.prompt,
      // 关键：finalPrompt 必须留空。这里如果塞 clarificationQuestion，
      // 老的 waiting_confirm 分支会把它当成可执行 prompt 渲染并允许"确认执行"。
      finalPrompt: '',
      finalNegativePrompt: '',
      error: undefined,
      agentModel: outcome.agentModel || current.agentModel,
      executionModel: outcome.executionModel || current.executionModel,
      taskType: outcome.taskType,
      apiKind: outcome.apiKind,
      resolvedTaskKind: outcome.resolvedTaskKind ?? current.resolvedTaskKind,
      pendingParams: undefined,
      // clarification 专属字段：UI 用它显示问题、原任务、缺失字段；
      // getTaskExecutionReadiness 用它做硬 Guard，确保不可能进入 execute。
      clarification: {
        question: outcome.clarificationQuestion,
        originalRequest: options.prompt || current.prompt,
        missingFields: outcome.missingFields,
        attempt: clarificationAttempt,
      },
      clarificationRound: clarificationAttempt,
      // 重新规划路径上必须清理上一次失败残留的诊断字段，否则确认卡上还会看到旧错误。
      plannerDiagnostic: undefined,
      executionDiagnostic: undefined,
      planningAttempt: options.planningAttempt,
      planningRequestId: options.planningRequestId,
      updatedAt: nowIso,
    }));
    patchMessage(conversationId, messageId, {
      content: stageDisplayContent('needs_clarification'),
    });
    console.log('[PlannerStateTransition]', {
      messageId,
      from: 'planning',
      to: 'needs_clarification',
      reason: 'planner_requires_clarification',
      clarificationRound: clarificationAttempt,
      questionLen: outcome.clarificationQuestion?.length ?? 0,
    });
    return;
  }
  // waiting_confirm
  patchTaskMessageState(conversationId, messageId, current => ({
    ...current,
    status: 'pending',
    stage: 'waiting_confirm',
    title: outcome.title,
    prompt: options.prompt,
    finalPrompt: outcome.finalPrompt,
    finalNegativePrompt: outcome.finalNegativePrompt,
    error: undefined,
    agentModel: outcome.agentModel || current.agentModel,
    executionModel: outcome.executionModel || current.executionModel,
    taskType: outcome.taskType,
    apiKind: outcome.apiKind,
    resolvedTaskKind: outcome.resolvedTaskKind ?? current.resolvedTaskKind,
    attachmentNames: outcome.attachmentNames ?? current.attachmentNames,
    attachmentDescriptors: outcome.attachmentDescriptors ?? current.attachmentDescriptors,
    orderedAttachments: outcome.orderedAttachments ?? current.orderedAttachments,
    editTargetImageCount: outcome.editTargetImageCount ?? current.editTargetImageCount,
    referenceImageCount: outcome.referenceImageCount ?? current.referenceImageCount,
    resolvedContext: outcome.resolvedContext ?? current.resolvedContext,
    gridLayout: outcome.gridLayout ?? current.gridLayout,
    compositeLayout: outcome.compositeLayout ?? current.compositeLayout,
    subjectEntities: outcome.subjectEntities ?? current.subjectEntities,
    contextSourceLabel: outcome.contextSourceLabel ?? current.contextSourceLabel,
    sourceImageCount: outcome.pendingParams.source_images.length,
    sourceImageId: outcome.sourceImageId ?? undefined,
    sourceImagePath: outcome.sourceImagePath ?? undefined,
    sourceImageSelection: outcome.sourceImageSelection ?? current.sourceImageSelection,
    sourceImagePreviewUrl: outcome.sourceImagePreviewUrl,
    sourceImageFileName: outcome.sourceImageFileName,
    size: outcome.pendingParams.size,
    count: outcome.pendingParams.count,
    pendingParams: outcome.pendingParams,
    // 关键修复（spec）：waiting_confirm 必须把 clarification 字段彻底清空，
    // 否则 getTaskExecutionReadiness 仍然会把这张卡判定为 needs_clarification。
    // 同时把 finalPrompt / pendingParams 等执行字段全部填齐 —— 这是 waiting_confirm 的 invariant。
    clarification: undefined,
    // 重新规划成功 → 必须清理上一次的 planner 失败诊断，避免在确认卡上残留旧错误。
    plannerDiagnostic: undefined,
    executionDiagnostic: undefined,
    planningAttempt: options.planningAttempt,
    planningRequestId: options.planningRequestId,
    updatedAt: nowIso,
  }));
  patchMessage(conversationId, messageId, {
    content: stageDisplayContent('waiting_confirm'),
  });
  console.log('[PlannerStateTransition]', {
    messageId,
    from: 'planning',
    to: 'waiting_confirm',
    reason: 'planner_ready',
    clarificationRoundCleared: true,
  });
}

/**
 * 单会话恢复：planning 卡 reconcile + 真实任务同步 + 结果图 URL 水合 + active_image_id 恢复。
 * 首屏只对激活会话执行；切换会话时懒加载执行 —— 这是 AgentChat 打开卡顿的主修复点。
 */
const restoringConversationIds = new Set<string>();

async function restoreConversationState(conversationId: string | null) {
  if (!conversationId) return;
  if (restoringConversationIds.has(conversationId)) return;
  restoringConversationIds.add(conversationId);
  try {
    const conv = useChatStore.getState().conversations.find(c => c.id === conversationId);
    if (!conv) return;
    const allTasks = useTaskStore.getState().tasks;
    const taskMap = new Map(allTasks.map(t => [t.id, t] as const));
    const toSync: Array<{ convId: string; taskId: string }> = [];
    for (const msg of conv.messages) {
      if (!msg.task_message) continue;
      const stage = msg.task_message.stage;
      if (stage === 'planning') {
        reconcilePlanningMessageWithPlannerJob(conv.id, msg);
        continue;
      }
      if (stage === 'waiting_confirm' || stage === 'planning_failed' || stage === 'needs_clarification') continue;
      const tid = msg.task_message.taskId;
      if (!tid) continue;
      if (tid.startsWith('draft_') || tid.startsWith('pending_') || tid.startsWith('failed_') || tid === 'no_task') continue;
      const live = taskMap.get(tid);
      if (live) {
        // 终态且图片 URL 已水合的任务卡无需再同步（避免每次切换会话重写文件）
        const inFlight = stage === 'queued' || stage === 'analyzing' || stage === 'running' || stage === 'saving';
        const needsImages = (msg.task_message.images || []).some(img => !img.url && !!img.localPath)
          || (live.status === 'completed' && (!msg.task_message.images || msg.task_message.images.length === 0));
        if (inFlight || needsImages || live.status === 'failed' || live.status === 'cancelled') {
          toSync.push({ convId: conv.id, taskId: tid });
        }
      } else {
        patchTaskMessageState(conv.id, msg.id, current => ({
          ...current,
          status: 'failed',
          stage: 'interrupted',
          error: current.error || '任务因应用中断未完成，可点击重试继续执行。',
          executionFinishedAt: current.executionStartedAt && !current.executionFinishedAt
            ? new Date().toISOString()
            : current.executionFinishedAt,
          executionDurationMs: current.executionStartedAt && current.executionDurationMs == null
            ? Math.max(0, Date.now() - Date.parse(current.executionStartedAt))
            : current.executionDurationMs,
          updatedAt: new Date().toISOString(),
        }));
      }
    }
    for (const item of toSync) {
      try {
        await useChatStore.getState().syncTaskMessage(item.taskId, item.convId);
      } catch (err) {
        console.warn('[TaskRestore] sync failed', item.taskId, err);
      }
    }
    await hydrateTaskMessageImageUrls(conversationId);
    restoreActiveImageIds(conversationId);
  } finally {
    restoringConversationIds.delete(conversationId);
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeId: null,
  runtimeById: {},
  error: null,
  abortCtrls: {},
  taskSubmitting: false,

  // Skill 相关初始状态
  skillMode: 'auto',
  selectedSkillId: null,
  detectedSkillId: null,
  lastSkillRoute: null,
  loadConversations: async () => {
    try {
      const conversations = await api.getConversations();
      const runtimeById = conversations.reduce<Record<string, ConversationRuntime>>((acc, conversation) => {
        acc[conversation.id] = { isSending: false };
        return acc;
      }, {});
      set({
        conversations: conversations.map(rehydrateConversationWithTaskMessages),
        activeId: conversations[0]?.id || null,
        runtimeById,
      });
      // 首屏性能：只恢复/同步激活会话，其余会话在 switchConversation 时懒加载，
      // 避免 mount 期「全部会话 × 逐任务串行同步 + 整图 base64 水合 + 全文件重写」风暴。
      try {
        await useTaskStore.getState().loadTasks();
      } catch {}
      await restoreConversationState(get().activeId);
    } catch (error) {
      console.error('加载对话历史失败', error);
      set({ error: '无法加载对话历史。' });
    }
  },

  save: async () => {
    for (const conversationId of pendingConversationSaveTimers.keys()) {
      clearScheduledConversationSave(conversationId);
    }
    await api.saveConversations(buildPersistedConversationSnapshot(get().conversations));
  },

  saveConversation: async (conversationId) => {
    clearScheduledConversationSave(conversationId);
    const conversation = get().conversations.find(item => item.id === conversationId);
    if (!conversation) return;
    await api.saveConversation(buildPersistedConversation(conversation));
  },

  scheduleSaveConversation: (conversationId, delayMs = CONVERSATION_SAVE_DEBOUNCE_MS) => {
    clearScheduledConversationSave(conversationId);
    const timer = setTimeout(() => {
      pendingConversationSaveTimers.delete(conversationId);
      void get().saveConversation(conversationId).catch((error) => {
        console.error('保存会话失败', error);
        set({ error: '会话保存失败，请稍后重试。' });
      });
    }, delayMs);
    pendingConversationSaveTimers.set(conversationId, timer);
  },

  newConversation: () => {
    const id = `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const conversation: ChatConversation = {
      id,
      title: '',
      messages: [],
      created_at: new Date().toISOString(),
      conversation_mode: 'free_chat',
      active_task_draft: null,
    };
    set(state => ({
      conversations: [conversation, ...state.conversations],
      activeId: id,
      error: null,
      runtimeById: { ...state.runtimeById, [id]: { isSending: false } },
    }));
    void get().saveConversation(id);
    return id;
  },

  switchConversation: (id) => {
    set({
      activeId: id,
      error: null,
    });
    // 懒加载：切换到的会话按需恢复任务卡状态与结果图（异步，不阻塞切换）
    void restoreConversationState(id);
  },

  deleteConversation: (id) => {
    const controller = get().abortCtrls[id];
    if (controller) controller.abort();
    clearScheduledConversationSave(id);
    set(state => {
      const conversations = state.conversations.filter(item => item.id !== id);
      const runtimeById = { ...state.runtimeById };
      const abortCtrls = { ...state.abortCtrls };
      delete runtimeById[id];
      delete abortCtrls[id];
      return {
        conversations,
        activeId: resolveNextActiveConversationId(state.conversations, conversations, id, state.activeId),
        runtimeById,
        abortCtrls,
        error: state.activeId === id ? null : state.error,
      };
    });
    void get().save();
  },

  renameConversation: (id, title) => {
    set(state => ({
      conversations: state.conversations.map(item => (item.id === id ? { ...item, title } : item)),
    }));
    void get().saveConversation(id);
  },

  sendMessage: async (text, settings, options) => {
    let activeId = get().activeId;
    if (!activeId) activeId = get().newConversation();
    if (get().runtimeById[activeId]?.isSending) return;

    const imageAttachments = options.attachments.filter(item => item.type === 'image');
    const fileAttachments = options.attachments.filter(item => item.type === 'file' && item.content);
    const visibleText = [
      ...fileAttachments.map(file => `--- 文件: ${file.name} ---\n${file.content}\n--- 结束 ---`),
      text,
    ].filter(Boolean).join('\n\n');

    const now = Date.now();
    const userMessage: ChatMessage = {
      id: `m${now}`,
      role: 'user',
      content: visibleText,
      images: imageAttachments.map(item => item.dataUrl!).filter(Boolean),
      attachments: options.attachments,
      created_at: new Date().toISOString(),
    };
    const assistantMessage: ChatMessage = {
      id: `m${now + 1}`,
      role: 'assistant',
      content: '',
      created_at: new Date().toISOString(),
    };

    set(state => ({
      conversations: state.conversations.map(conversation =>
        conversation.id === activeId
          ? {
              ...conversation,
              title: conversation.title || visibleText.slice(0, 30),
              messages: [...conversation.messages, userMessage, assistantMessage],
            }
          : conversation,
      ),
      error: null,
    }));
    setConversationSending(activeId, true);
    await get().saveConversation(activeId);

    const abortCtrl = new AbortController();
    set(state => ({ abortCtrls: { ...state.abortCtrls, [activeId!]: abortCtrl } }));

    // ====== BYOK 多 AI 智能体路由 =====
    // 会话级 Profile 选择优先（Chat.tsx 选择器写入 conversation.selected_agent_*）。
    // Agent 对话 / Planner 唯一来源 = 用户已保存并启用的 Provider；没有可用选择时
    // 直接终止并提示配置 —— 禁止回退到任何服务器 Agent 模型（含 gpt-5.6-luna）。
    const currentConversationPre = get().conversations.find(item => item.id === activeId);
    const byokConfig = resolveByokAgentConfig(currentConversationPre);
    if (!byokConfig.ok) {
      patchMessage(activeId, assistantMessage.id, { content: `⚠️ ${byokConfig.error}` });
      setConversationSending(activeId, false);
      set(state => ({ error: byokConfig.error }));
      return;
    }
    const agentConfig = {
      token: byokConfig.token,
      model: byokConfig.model,
      baseUrl: byokConfig.baseUrl,
      billingMode: byokConfig.billingMode,
      systemPrompt: byokConfig.systemPrompt,
      source: 'agent' as const,
      hasOverrides: true,
      mismatch: false,
    };
    const agentToken = agentConfig.token;
    const agentModel = agentConfig.model;
    const agentBaseURL = agentConfig.baseUrl;
    const agentSystemPrompt = agentConfig.systemPrompt;
    const currentConversation = get().conversations.find(item => item.id === activeId);
    const activeDraft = syncDraftStageWithTask(currentConversation?.active_task_draft || null);
    if (activeDraft !== currentConversation?.active_task_draft) {
      set(state => ({
        conversations: state.conversations.map(conversation =>
          conversation.id === activeId
            ? { ...conversation, active_task_draft: activeDraft }
            : conversation,
        ),
      }));
    }
    const roughIntent = classifyAgentIntent({
      text: visibleText,
      hasImageAttachments: imageAttachments.length > 0,
      hasEditableImage: imageAttachments.some(item => !!item.filePath),
      planOnly: false,
    });

    // ====== Chat → Task 语义 Handoff（spec 第三节 Runtime 场景）======
    // "你可以帮我生成这些建筑的9宫格图嘛？" 必须直接创建 Task 卡，
    // 不能先发一条普通 Assistant 回复再让用户重新列建筑。
    // 条件：
    //   1. 本地检测为执行型请求（生成 / 编辑，且不是讨论句式）
    //   2. 指代了历史上下文（"这些 / 上面那些"），或当前消息自带布局结构（九宫格）
    //   3. 会话中没有 pending 的 clarification 卡（那种情况由 sendTaskMessage 处理）
    //   4. 不与旧 proposal 流程冲突（activeDraft 为空 或 已完成）
    if (!options.planOnly && visibleText.trim()) {
      const pendingClarification = currentConversation
        ? findPendingClarificationTask(currentConversation)
        : null;
      if (!pendingClarification) {
        const execIntent = detectChatExecutionIntent({
          text: visibleText,
          hasImageAttachments: imageAttachments.length > 0,
          hasActiveImage: !!currentConversation?.active_image_id,
        });
        const shouldHandoff = execIntent.actionable
          && (execIntent.referencesPreviousContext || !!execIntent.grid)
          && (!activeDraft || activeDraft.stage === 'completed');

        if (shouldHandoff) {
          const handoffCtx = resolveChatExecutionContext({
            currentMessage: visibleText,
            intent: execIntent,
            messages: (currentConversation?.messages || []).concat([
              { id: `current_${Date.now()}`, role: 'user', content: visibleText } as ChatMessage,
            ]),
          });
          console.log('[ChatTaskHandoff]', {
            actionable: execIntent.actionable,
            kind: execIntent.kind,
            referencesPreviousContext: execIntent.referencesPreviousContext,
            entityCategoryHint: execIntent.entityCategoryHint,
            entityCount: handoffCtx?.entities?.length ?? 0,
            grid: execIntent.grid ? `${execIntent.grid.rows}x${execIntent.grid.columns}` : undefined,
            source: handoffCtx?.source,
            // [OrderedEntitySelection]（spec 四十九节）：只打印数量与选中 labels，
            // 不输出完整聊天历史。
            orderedSelection: handoffCtx?.orderedSelection
              ? {
                  phrase: handoffCtx.orderedSelection.phrase,
                  requestedCount: handoffCtx.orderedSelection.selectedIndices.length,
                  selectedCount: handoffCtx.orderedSelection.selectedLabels.length,
                  selectedLabels: handoffCtx.orderedSelection.selectedLabels,
                }
              : undefined,
          });
          // 引用了上下文但解析不到任何可信候选 → 保持普通 chat，
          // 让 interpret 流程 / Planner 决定是否 needs_clarification。
          const resolvable = !execIntent.referencesPreviousContext
            || handoffCtx?.source !== 'current_message';
          if (handoffCtx && resolvable) {
            // 移除 sendMessage 已插入的 user / assistant 占位
            //（sendTaskMessage 会重建 user message + planning 卡，保留会导致用户消息重复）。
            dropConversationMessage(activeId, assistantMessage.id);
            dropConversationMessage(activeId, userMessage.id);
            setConversationSending(activeId, false);
            clearAbort(activeId);
            await get().sendTaskMessage({
              text: visibleText,
              settings,
              attachments: options.attachments,
              mode: 'task',
              chatHandoffContext: handoffCtx,
            });
            return;
          }
        }
      }
    }

    try {
      // ====== 任务状态转移 / Intent 解释 / 任务提案 ======
      // V3.0.6：创作能力属于 CyImagePro 本身，所有模型服务共用完整工作流；
      // 旧「对话助手 / 创作智能体」类型已删除，是否参与任务规划由使用范围（use_scopes）决定。
      {
      const transitionDecision = decideConversationTransition({
        conversation: currentConversation,
        activeDraft,
        text: visibleText,
        attachments: imageAttachments,
        roughIntent,
      });

      if (transitionDecision.kind === 'execution_confirmation' && transitionDecision.executionTarget) {
        const executionTarget = transitionDecision.executionTarget;
        if (executionTarget.proposal.status !== 'draft') {
          finishConversationText(activeId, assistantMessage.id, '当前提案正在执行或已处理完成。');
          return;
        }
        markProposalSubmitting(activeId, executionTarget.messageId, executionTarget.proposal);
        if (activeDraft) {
          set(state => ({
            conversations: state.conversations.map(conversation =>
              conversation.id === activeId
                ? {
                    ...conversation,
                    conversation_mode: 'task_flow',
                    active_task_draft: {
                      ...activeDraft,
                      stage: 'confirmed',
                      updated_at: new Date().toISOString(),
                    },
                  }
              : conversation,
            ),
          }));
        }
        try {
          await createTaskFromProposal(activeId, executionTarget.messageId, executionTarget.proposal);
        } catch (error) {
          patchMessage(activeId, executionTarget.messageId, {
            agent_proposal: { ...executionTarget.proposal, status: 'draft' },
          });
          throw error;
        }
        dropConversationMessage(activeId, assistantMessage.id);
        return;
      }

      if (transitionDecision.kind === 'execution_confirmation' && !transitionDecision.executionTarget) {
        finishConversationText(activeId, assistantMessage.id, '你是要按刚才这版直接执行，还是要我先整理成新的任务提案？');
        return;
      }

      // ====== 任务修订（本轮 bug 修复核心）======
      // 用户对当前待确认任务说"我不要批量任务 我要单张"：
      //   1. 旧批量提案立刻失效（status → cancelled），永远不可能再被"确认执行"命中。
      //   2. 组合"原任务 + 修订指令"文本，走 sendTaskMessage 真正重新规划。
      //   3. 新任务卡（新 revision）进入 waiting_confirm，"确认执行"只能执行新 revision。
      // 禁止只回复一段解释文字而不更新底层任务计划。
      if (transitionDecision.kind === 'task_revision' && activeDraft) {
        const revisionDirective = detectTaskRevisionIntent(visibleText);
        const originalRequest = activeDraft.user_prompt_raw || activeDraft.latest_user_message || activeDraft.final_prompt || '';
        const revisionText = buildTaskRevisionContinuationText({
          originalRequest,
          revisionInstruction: visibleText,
        });

        // 1. 旧提案消息标记 cancelled（superseded）—— resolveExecutionIntentFromContext
        //    只找 status='draft' 的 proposal，cancelled 后不可能再被确认执行。
        set(state => ({
          conversations: state.conversations.map(conversation =>
            conversation.id === activeId
              ? {
                  ...conversation,
                  messages: conversation.messages.map(message => (
                    message.agent_proposal?.status === 'draft'
                      ? { ...message, agent_proposal: { ...message.agent_proposal, status: 'cancelled' as const } }
                      : message
                  )),
                  // 2. 旧 draft 立即退场，避免后续消息继续吸附到旧批量结构上。
                  active_task_draft: null,
                }
              : conversation,
          ),
        }));

        // 3. 修订后的用户消息保留在对话里（sendMessage 已 append），
        //    但要移除 assistant 占位 —— sendTaskMessage 会重建 user message + planning 卡。
        dropConversationMessage(activeId, assistantMessage.id);
        dropConversationMessage(activeId, userMessage.id);
        setConversationSending(activeId, false);
        clearAbort(activeId);

        console.log('[TaskRevision]', {
          conversationId: activeId,
          oldDraftId: activeDraft.id,
          outputMode: revisionDirective.outputMode,
          evidence: revisionDirective.evidence,
          originalRequestLen: originalRequest.length,
        });

        await get().sendTaskMessage({
          text: visibleText,
          settings,
          attachments: options.attachments,
          mode: 'task',
          plannerTextOverride: revisionText,
        });
        return;
      }

      if (transitionDecision.kind === 'retry_submission') {
        if (activeDraft && !activeDraft.linked_task_id) {
          finishConversationText(activeId, assistantMessage.id, '当前会话缺少原任务编号，无法在聊天中重新提交，请到任务列表重试。');
          return;
        }
        if (!activeDraft?.linked_task_id) {
          finishConversationText(activeId, assistantMessage.id, '当前没有可重新提交的任务，请先确认一个提案或到任务列表重试。');
          return;
        }
        if (['clarifying', 'variant_planning', 'proposed', 'confirmed', 'queued', 'running'].includes(activeDraft.stage)) {
          finishConversationText(
            activeId,
            assistantMessage.id,
            ['clarifying', 'variant_planning', 'proposed', 'confirmed'].includes(activeDraft.stage)
              ? '当前还是提案状态，请先确认执行。'
              : '当前任务正在执行或排队中，暂时不需要重新提交。',
          );
          return;
        }

        const proposal = proposalFromDraft(activeDraft);
        try {
          const { task, syncedTask } = await retryTaskFromDraft(activeId, activeDraft);
          finishConversationText(
            activeId,
            assistantMessage.id,
            [
              syncedTask ? '任务已重新提交' : '任务已提交重试请求，但任务列表尚未同步，请刷新队列',
              `新任务编号：${task.id.slice(0, 8)}`,
              `任务类型：${task.task_type === 'edit' ? '图生图' : task.task_type === 'remove_background' ? '透明背景' : '文生图'}`,
              task.execution_mode === 'batch' ? `批量任务：${task.count} 个子任务 / ${task.batch_strategy}` : '',
              proposal.task_plan_summary ? `任务计划：${proposal.task_plan_summary}` : '',
              `执行接口：${proposal.api_kind}`,
            ].filter(Boolean).join('\n'),
            { is_image: true },
          );
        } catch (error) {
          throw error;
        }
        return;
      }

      if (transitionDecision.kind === 'follow_up' && activeDraft) {
        const updatedDraft = applyDraftFollowUp(activeDraft, visibleText);
        if (updatedDraft) {
          const proposal = proposalFromDraft(updatedDraft);
          set(state => ({
            conversations: state.conversations.map(conversation =>
              conversation.id === activeId
                ? { ...conversation, conversation_mode: 'task_flow', active_task_draft: updatedDraft }
                : conversation,
            ),
          }));
          finishConversationText(activeId, assistantMessage.id, buildProposalContent(proposal), {
            agent_proposal: proposal,
            is_image: true,
          });
          return;
        }
      }

      if (transitionDecision.kind === 'derive_from_completed' && activeDraft) {
        const derivedDraft = deriveDraftFromCompletedTask(activeDraft, visibleText);
        if (derivedDraft) {
          const derivedProposal = proposalFromDraft(derivedDraft);
          set(state => ({
            conversations: state.conversations.map(conversation =>
              conversation.id === activeId
                ? { ...conversation, conversation_mode: 'task_flow', active_task_draft: derivedDraft }
                : conversation,
            ),
          }));
          finishConversationText(activeId, assistantMessage.id, buildProposalContent(derivedProposal), {
            agent_proposal: derivedProposal,
            is_image: true,
          });
          return;
        }
      }

      let interpreted: InterpretResult;
      let usedLocalFallback = false;
      const shouldInterpret = shouldInterpretIntent(roughIntent, imageAttachments.length > 0);

      if (shouldInterpret) {
        try {
          interpreted = await interpretAgentRequest({
            text: visibleText,
            attachments: options.attachments,
            token: agentToken,
            model: agentModel,
            baseUrl: agentBaseURL,
            billingMode: byokConfig.ok ? byokConfig.billingMode : undefined,
            provider: byokConfig.ok ? { id: byokConfig.profileId, type: byokConfig.providerType, name: byokConfig.profileName } : undefined,
          });
        } catch (interpretError: any) {
          if (['connect', 'timeout', 'server', 'invalid_response'].includes(interpretError?.kind) && ['image_generate', 'image_edit', 'remove_background'].includes(roughIntent)) {
            interpreted = localAgentFallback({
              roughIntent,
              raw: visibleText,
              hasImages: imageAttachments.length > 0,
            });
            usedLocalFallback = true;
          } else {
            throw interpretError;
          }
        }
      } else {
        interpreted = {
          intent: 'chat',
          confidence: 1,
          needs_clarification: false,
          recommended_action: '直接对话回复',
          should_propose_execution: false,
          final_prompt: visibleText,
          final_negative_prompt: '',
        };
      }

      if (abortCtrl.signal.aborted) {
        finishConversationText(activeId, assistantMessage.id, '*[已停止]*');
        return;
      }

      if (interpreted.needs_clarification && interpreted.clarification_question) {
        set(state => ({
          conversations: state.conversations.map(conversation =>
            conversation.id === activeId
              ? {
                  ...conversation,
                  conversation_mode: 'task_flow',
                  active_task_draft: {
                    id: `draft_${Date.now()}`,
                    conversation_id: activeId,
                    task_kind: interpreted.intent as AgentTaskDraft['task_kind'],
                    stage: 'clarifying',
                    execution_mode: 'single',
                    user_prompt_raw: visibleText,
                    latest_user_message: visibleText,
                    source_images: imageAttachments.map(item => item.filePath).filter(Boolean) as string[],
                    reference_images: [],
                    keep_constraints: [],
                    change_constraints: [],
                    negative_constraints: [],
                    unresolved_fields: [],
                    clarification_questions: interpreted.clarification_question ? [interpreted.clarification_question] : [],
                    matched_style_template_ids: [],
                    final_prompt: interpreted.final_prompt || visibleText,
                    final_negative_prompt: interpreted.final_negative_prompt || '',
                    recommended_action: interpreted.recommended_action,
                    api_kind: interpreted.api_kind,
                    confidence: interpreted.confidence,
                    used_local_fallback: usedLocalFallback,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  },
                }
              : conversation,
          ),
        }));
        finishConversationText(activeId, assistantMessage.id, interpreted.clarification_question);
        return;
      }

      if (interpreted.should_propose_execution && ['image_generate', 'image_edit', 'remove_background', 'upscale'].includes(interpreted.intent)) {
        const sourceImagePaths = imageAttachments.map(item => item.filePath).filter(Boolean) as string[];
        const referenceBoundDesignTask = isReferenceBoundDesignTask(visibleText, options.attachments);
        const effectiveIntent: AgentTaskDraft['task_kind'] =
          referenceBoundDesignTask && interpreted.intent === 'image_generate'
            ? 'image_edit'
            : interpreted.intent as AgentTaskDraft['task_kind'];
        const effectiveApiKind =
          referenceBoundDesignTask && interpreted.intent === 'image_generate'
            ? 'edit'
            : interpreted.api_kind || (effectiveIntent === 'image_edit' ? 'edit' : effectiveIntent === 'remove_background' ? 'remove_background' : 'generation');

        const batchPlan = detectBatchPlan({
          text: visibleText,
          roughIntent: effectiveIntent,
          attachments: options.attachments,
        });
        if (batchPlan.needsClarification && batchPlan.clarificationQuestion) {
          finishConversationText(activeId, assistantMessage.id, batchPlan.clarificationQuestion);
          return;
        }
        const templateVariables = extractTemplateVariables(visibleText, options.attachments);
        const templateMatch = await matchTemplates({
          text: visibleText,
          intent: effectiveIntent,
          attachments: options.attachments,
        });

        if (templateMatch.clarificationQuestion) {
          finishConversationText(activeId, assistantMessage.id, templateMatch.clarificationQuestion);
          return;
        }

        const composed = composeTemplatePrompt(
          interpreted.final_prompt || visibleText,
          templateMatch.taskTemplate,
          templateMatch.styleTemplates,
          interpreted.final_negative_prompt || '',
          templateVariables,
        );

        let batchItems = buildBatchItems(batchPlan, options.attachments, visibleText);
        const sequenceBasePrompt =
          batchPlan.sequenceMode === 'connected_detail_sequence'
            ? stripSequencePageSpecificText(composed.finalPrompt)
            : composed.finalPrompt;
        const finalPrompt =
          batchPlan.sequenceMode === 'connected_detail_sequence'
            ? [
                sequenceBasePrompt,
                `输出要求：生成 ${batchItems.length} 张独立竖版长图，适合抖音详情页连续浏览。`,
                '页面关系：各页之间需要形成上下连续关联，上一页底部元素自然承接到下一页顶部，保持统一的模特、产品、版式、配色与信息节奏。',
                '结构要求：不是单张图中的三分镜布局，而是多张独立长图分别承担不同页面职责。',
                '参考关系：其中一张参考图作为模特展示参考，另一张参考图作为产品主体参考，整套详情图要同时体现两者关系，并保持产品外观、材质、颜色与模特参考关系一致。',
              ].join('\n')
            : referenceBoundDesignTask
              ? [
                  composed.finalPrompt,
                  '执行方式：基于上传的参考图进行设计生成，输出内容必须绑定参考图中的主体关系，而不是仅参考风格。',
                  '参考关系：保留参考图中的人物、产品或场景对应关系，生成新的设计图时不得丢失这些主体信息。',
                ].join('\n')
            : composed.finalPrompt;
        if (batchPlan.sequenceMode === 'connected_detail_sequence') {
          batchItems = applySequencePromptOverrides(finalPrompt, batchItems);
        }
        if (batchPlan.distinctBatch && batchItems.length > 0) {
          batchItems = applyDistinctPromptOverrides(finalPrompt, batchItems);
        }
        const nowIso = new Date().toISOString();
        const draft: AgentTaskDraft = {
          id: `draft_${Date.now()}`,
          conversation_id: activeId,
          task_kind: effectiveIntent,
          stage: batchPlan.executionMode === 'batch' ? 'variant_planning' : 'proposed',
          execution_mode: batchPlan.executionMode,
          batch_strategy: batchPlan.batchStrategy,
          task_plan_summary: batchPlan.taskPlanSummary || (batchPlan.executionMode === 'batch' ? `${batchItems.length} 个批量子任务` : ''),
          user_prompt_raw: visibleText,
          latest_user_message: visibleText,
          source_images: sourceImagePaths,
          reference_images: [],
          subject: templateVariables.product,
          scene: templateVariables.scene,
          style: templateVariables.style,
          selling_point: templateVariables.selling_point,
          background_target: templateVariables.background_target,
          keep_constraints: [],
          change_constraints: [],
          negative_constraints: [],
          unresolved_fields: [],
          clarification_questions: [],
          matched_task_template_id: templateMatch.taskTemplate?.id,
          matched_task_template_name: templateMatch.taskTemplate?.name,
          matched_style_template_ids: templateMatch.styleTemplates.map(item => item.id),
          matched_style_template_names: templateMatch.styleTemplates.map(item => item.name),
          final_prompt: finalPrompt,
          final_negative_prompt: composed.finalNegativePrompt,
          recommended_action: referenceBoundDesignTask
            ? '建议按图生图 / 图片编辑处理，保留参考图主体关系并输出新的设计图。'
            : (composed.recommendedAction || interpreted.recommended_action),
          api_kind: effectiveApiKind,
          composite_layout: batchPlan.compositeLayout,
          variant_plan: batchPlan.executionMode === 'batch' ? {
            target_count: batchPlan.targetCount,
            variation_axis: batchPlan.batchStrategy === 'variant_set' ? batchPlan.variationAxis : undefined,
            items: batchItems,
          } : undefined,
          confidence: interpreted.confidence,
          used_local_fallback: usedLocalFallback,
          created_at: nowIso,
          updated_at: nowIso,
        };

        const proposal: AgentProposal = {
          id: draft.id,
          intent: effectiveIntent as AgentProposal['intent'],
          confidence: interpreted.confidence,
          needs_clarification: false,
          clarification_question: interpreted.clarification_question,
          recommended_action: referenceBoundDesignTask
            ? '基于参考图进行设计生成，保留参考主体关系，输出新的详情图/海报/说明图。'
            : (composed.recommendedAction || interpreted.recommended_action || (
            effectiveIntent === 'remove_background'
              ? '建议先执行主体抠图，再决定是否替换背景。'
              : effectiveIntent === 'image_edit'
                ? '建议按图生图处理，保留主体并修改背景或场景。'
                : '建议先按文生图执行。'
          )),
          final_prompt: finalPrompt,
          final_negative_prompt: composed.finalNegativePrompt,
          user_prompt_raw: visibleText,
          source_images: referenceBoundDesignTask ? sourceImagePaths : (effectiveIntent === 'image_generate' ? [] : sourceImagePaths),
          status: 'draft',
          api_kind: effectiveApiKind,
          matched_task_template_id: templateMatch.taskTemplate?.id,
          matched_task_template_name: templateMatch.taskTemplate?.name,
          matched_style_template_ids: templateMatch.styleTemplates.map(item => item.id),
          matched_style_template_names: templateMatch.styleTemplates.map(item => item.name),
          execution_mode: batchPlan.executionMode,
          batch_strategy: batchPlan.batchStrategy,
          task_plan_summary: batchPlan.taskPlanSummary || (batchPlan.executionMode === 'batch' ? `${batchItems.length} 个批量子任务` : ''),
          batch_items: batchItems,
          composite_layout: batchPlan.compositeLayout,
          used_local_fallback: usedLocalFallback,
          planner_provider_profile_id: byokConfig.profileId,
          planner_provider_name_snapshot: byokConfig.profileName,
          planner_model_id: byokConfig.model,
          planner_model_display_name_snapshot: byokConfig.modelEntity.display_name || byokConfig.modelEntity.model_id,
        };

        set(state => ({
          conversations: state.conversations.map(conversation =>
            conversation.id === activeId
              ? {
                  ...conversation,
                  conversation_mode: 'task_flow',
                  active_task_draft: {
                    ...draft,
                    stage: 'proposed',
                  },
                }
              : conversation,
          ),
        }));

        finishConversationText(
          activeId,
          assistantMessage.id,
          buildProposalContent(proposal),
          { agent_proposal: proposal, is_image: true },
        );
        return;
      }
      } // ====== 结束任务链路（状态转移 / Intent 解释 / 提案）======

      const auth = useAuthStore.getState();
      if (!auth.isLoggedIn) {
        throw new Error('请先登录后再使用对话功能。');
      }

      const conversation = get().conversations.find(item => item.id === activeId)!;
      const currentVisionSummary = imageAttachments.length > 0
        ? await understandAttachmentsForAgent({
            text: visibleText,
            attachments: options.attachments,
            visionModel: settings.vision_model,
          })
        : '';
      const apiMessages: { role: string; content?: string }[] = [];

      // ============================================
      // Skill 检测与系统提示词构建（替代旧 Prompt）
      // 本地同步计算，无网络请求，无 AI 调用
      // ============================================
      const routeResult = detectSkill({
        text: visibleText,
        hasImageAttachments: imageAttachments.length > 0,
        hasEditableImage: imageAttachments.some(item => !!item.filePath),
        attachmentCount: imageAttachments.length,
      });

      const effectiveSkillId = get().skillMode === 'manual' && get().selectedSkillId
        ? get().selectedSkillId!
        : routeResult.skillId;

      // 更新 Skill 状态
      set({
        detectedSkillId: effectiveSkillId,
        lastSkillRoute: routeResult,
      });

      // 构建系统提示词（Skill 主控）
      // Prompt 组装顺序：basePrompt + skillPrompt + userCustomPrompt + historySummary + imageContext
      const systemPrompt = buildSkillSystemPrompt({
        skillId: effectiveSkillId,
        routeResult,
        userText: visibleText,
        visionSummary: currentVisionSummary,
        planOnly: options.planOnly,
        userCustomPrompt: agentSystemPrompt,  // 设置中的自定义 prompt，只作补充
        contextSummary: conversation.context_summary?.trim() || '',
      });

      for (const message of buildContextMessages(conversation)) {
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        // 历史 assistant content 统一剥离残留 reasoning，避免多轮传播
        const messageContent = message.role === 'assistant'
          ? sanitizeHistoryMessageContent(message)
          : message.content;
        if (messageContent || message.images?.length) {
          const content = [
            messageContent,
            message.images?.length && message.role === 'user'
              ? `[该轮用户消息附带了 ${message.images.length} 张图片；图片内容不直接注入历史上下文，仅保留文字记录]`
              : '',
          ].filter(Boolean).join('\n');
          if (content) {
            apiMessages.push({ role: message.role, content });
          }
        }
      }

      if (import.meta.env.DEV) {
        // 排查上下文串扰用：只打印结构元信息，不打印 API Key / 完整 System Prompt / 消息正文
        console.log('[ChatRequest]', {
          providerProfileId: byokConfig.profileId,
          providerType: byokConfig.providerType,
          model: agentModel,
          historyMessageCount: apiMessages.length,
          systemPromptLength: systemPrompt.length,
          requestMessageRoles: apiMessages.map(item => item.role),
          responseContentType: 'chat_reply',
        });
      }

      // BYOK：对话直接使用用户 Provider 的 Key 调用，不走服务器 Agent 余额预检 / 计费。
      // 图片 / 后处理等服务器业务保留各自的 estimate 检查。

      const runResult = await api.runAgentRequest({
        mode: 'chat',
        base_url: agentBaseURL,
        token: agentToken,
        model: agentModel,
        billing_mode: agentConfig.billingMode,
        system_prompt: systemPrompt,
        messages: apiMessages,
      }) as AgentRunRequestResult;

      if (abortCtrl.signal.aborted) {
        finishConversationText(activeId, assistantMessage.id, '*[已停止]*');
        return;
      }

      if (!runResult.ok) {
        const providerError = buildProviderError({
          providerId: byokConfig.profileId,
          providerType: byokConfig.providerType,
          providerName: byokConfig.profileName,
          billingMode: byokConfig.billingMode,
          modelId: byokConfig.model,
          failure: {
            ok: false,
            error_kind: runResult.error_kind,
            error_message: runResult.error_message,
            status: runResult.status,
          },
        });
        const error: any = new Error(providerErrorCompact(providerError));
        error.kind = runResult.error_kind;
        error.status = runResult.status;
        error.providerError = providerError;
        throw error;
      }

      let reply = runResult.reply?.trim() || '(空回复)';
      const stripped = stripReasoningFromReply(reply);
      let reasoning = stripped.reasoning;
      reply = stripped.reply || '(空回复)';
      const reasoningDuration = reasoning ? '思考完成' : '';

      const promptTokens = runResult.prompt_tokens ?? 0;
      const completionTokens = runResult.completion_tokens ?? 0;
      let userInputTokens: number | undefined;
      const latest = get().conversations.find(item => item.id === activeId);
      const lastPrompt = latest?.last_prompt_tokens ?? 0;
      const lastCompletion = latest?.last_completion_tokens ?? 0;
      userInputTokens = Math.max(0, promptTokens - lastPrompt - lastCompletion);

      set(state => ({
        conversations: state.conversations.map(item =>
          item.id === activeId
            ? {
                ...item,
                conversation_mode: 'free_chat',
                active_task_draft: null,
                last_prompt_tokens: promptTokens || item.last_prompt_tokens,
                last_completion_tokens: completionTokens || item.last_completion_tokens,
                messages: item.messages.map(message => {
                  if (message.id === assistantMessage.id) {
                    return {
                      ...message,
                      content: reply,
                      reasoning,
                      reasoning_duration: reasoningDuration,
                      output_tokens: completionTokens || message.output_tokens,
                      provider_profile_id: byokConfig.profileId,
                      provider_name_snapshot: byokConfig.profileName,
                      model_id: byokConfig.model,
                      model_display_name_snapshot: byokConfig.modelEntity.display_name || byokConfig.modelEntity.model_id,
                    };
                  }
                  if (message.id === userMessage.id && userInputTokens !== undefined) {
                    return { ...message, input_tokens: userInputTokens };
                  }
                  return message;
                }),
              }
            : item,
        ),
      }));

      setConversationSending(activeId, false);
      clearAbort(activeId);
      await get().saveConversation(activeId);
    } catch (error: any) {
      const currentAbort = get().abortCtrls[activeId];
      if (error?.name === 'AbortError' || abortCtrl.signal.aborted) {
        finishConversationText(activeId, assistantMessage.id, currentAbort ? '*[已停止]*' : '请求超时（超过 2 分钟），请重试。');
      } else {
        const friendly = explainError(error);
        if (isAuthError(error)) {
          useAuthStore.getState().logout();
          useAuthStore.getState().showAuthPrompt();
        }
        patchMessage(activeId, assistantMessage.id, { content: `❌ ${friendly}` });
        setConversationSending(activeId, false);
        // Provider 请求失败的完整错误卡已随消息展示，不再重复轰炸顶部 Banner；
        // Banner 只保留给阻塞型配置错误（未配置模型 / Key 等）。
        clearAbort(activeId);
        await get().saveConversation(activeId);
      }
    }
  },

  dismissError: () => {
    set({ error: null });
  },

  stopGeneration: (conversationId) => {
    const targetId = conversationId || get().activeId;
    if (!targetId) return;
    const controller = get().abortCtrls[targetId];
    if (controller) controller.abort();
    clearAbort(targetId);
  },

  setConversationChatMode: (conversationId, mode) => {
    set(state => ({
      conversations: state.conversations.map(c =>
        c.id === conversationId ? { ...c, chat_mode: mode } : c,
      ),
    }));
  },

  setConversationAgentSelection: (conversationId, profileId, modelId) => {
    set(state => ({
      conversations: state.conversations.map(c =>
        c.id === conversationId
          ? {
              ...c,
              selected_agent_profile_id: profileId || undefined,
              selected_agent_model_id: modelId || undefined,
            }
          : c,
      ),
    }));
    try {
      void get().saveConversation(conversationId);
    } catch {}
  },

  setActiveTaskId: (conversationId, taskId) => {
    set(state => ({
      conversations: state.conversations.map(c =>
        c.id === conversationId ? { ...c, active_task_id: taskId } : c,
      ),
    }));
  },

  setActiveImageId: (conversationId, imageId, localPath, source = 'auto') => {
    set(state => ({
      conversations: state.conversations.map(c =>
        c.id === conversationId
          ? {
              ...c,
              active_image_id: imageId,
              active_image_path: localPath !== undefined ? localPath : (imageId ? c.active_image_path : null),
              // 'explicit' = 用户点"编辑此图"手动绑定；'auto' = 系统推进到最新图。
              active_image_source: imageId ? source : undefined,
              active_image_set_at: imageId ? new Date().toISOString() : undefined,
            }
          : c,
      ),
    }));
    try {
      void get().saveConversation(conversationId);
    } catch {}
  },

  switchTaskSourceImage: (conversationId, taskId, image) => {
    const conversation = get().conversations.find(c => c.id === conversationId);
    const message = conversation?.messages.find(m => m.task_message?.taskId === taskId);
    if (!message?.task_message) return;
    const stage = message.task_message.stage;
    // 只允许在纯前端可编辑态切换；运行中/终态任务的绑定不可变。
    if (stage !== 'waiting_confirm' && stage !== 'planning_failed' && stage !== 'needs_clarification') {
      console.warn('[AgentTask] switch source image ignored: stage not editable', taskId, stage);
      return;
    }
    patchTaskMessageState(conversationId, message.id, current => {
      const next: Partial<TaskMessageState> = {
        // 手动切换 = 显式选择，覆盖当前任务快照；不影响会话默认规则（新任务仍默认最新图）。
        sourceImageId: image.imageId,
        sourceImagePath: image.localPath,
        sourceImagePreviewUrl: image.url,
        sourceImageFileName: image.fileName,
        sourceImageSelection: 'explicit',
        updatedAt: new Date().toISOString(),
      };
      // waiting_confirm 的非生成任务：同步替换 pendingParams.source_images 的
      // 编辑目标位（index 0），参考图保持不变 —— 执行阶段只读 pendingParams。
      if (
        current.stage === 'waiting_confirm'
        && current.pendingParams
        && current.pendingParams.task_type !== 'generate'
        && image.localPath
      ) {
        const sources = [...(current.pendingParams.source_images || [])];
        if (sources.length > 0) {
          sources[0] = image.localPath;
        } else {
          sources.push(image.localPath);
        }
        next.pendingParams = { ...current.pendingParams, source_images: sources };
        next.sourceImageCount = sources.length;
      }
      console.log('[AgentTask] source image switched', {
        taskId,
        stage: current.stage,
        newSourceImageId: image.imageId,
      });
      return { ...current, ...next };
    });
    void get().saveConversation(conversationId);
  },

  sendTaskMessage: async (input) => {
    const { text, attachments, mode, ignoreActiveImage, chatHandoffContext, plannerTextOverride } = input;
    const trimmed = (text || '').trim();
    if (!trimmed && attachments.length === 0) return;
    if (get().taskSubmitting) {
      console.warn('[AgentTask] task submitting already in progress, ignored');
      return;
    }

    let activeId = get().activeId;
    if (!activeId) activeId = get().newConversation();

    const agentDefaults = useSettingsStore.getState().settings;
    if (!agentDefaults.default_output_dir) {
      set({ error: '请先在「设置与更新 → 图片与文件」中配置输出目录。' });
      return;
    }

    const currentConv = get().conversations.find(c => c.id === activeId);

    // ====== 任务修订吸附（本轮 bug 修复核心）======
    // 当前会话存在 waiting_confirm 的任务卡，用户说"我不要批量任务 我要单张"：
    // 必须吸附到那张卡触发 replanTaskMessage（生成新 revision），
    // 绝不允许新建第二张卡、更不允许只回复文字而让旧批量计划继续可执行。
    if (
      currentConv
      && trimmed
      && attachments.length === 0
      && !ignoreActiveImage
      && detectTaskRevisionIntent(trimmed).isRevision
    ) {
      // 从尾部找最近一张 waiting_confirm 的任务卡
      for (let i = currentConv.messages.length - 1; i >= 0; i -= 1) {
        const m = currentConv.messages[i];
        const tm = m.task_message;
        if (!tm) continue;
        if (tm.stage === 'waiting_confirm' || tm.stage === 'needs_clarification') {
          const originalRequest = tm.prompt || tm.clarification?.originalRequest || '';
          const revisionText = buildTaskRevisionContinuationText({
            originalRequest,
            revisionInstruction: trimmed,
          });
          // 修订指令 append 成 user message（replanTaskMessage 不会 append）。
          const revisionUserMessage: ChatMessage = {
            id: `revision_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            role: 'user',
            content: trimmed,
            created_at: new Date().toISOString(),
            chat_mode: 'task',
          };
          set(state => ({
            conversations: state.conversations.map(c =>
              c.id === activeId
                ? { ...c, messages: [...c.messages, revisionUserMessage] }
                : c,
            ),
          }));
          console.log('[TaskRevision] adsorb to existing waiting_confirm card', {
            conversationId: activeId,
            sourceMessageId: m.id,
            taskId: tm.taskId,
            oldExecutionMode: tm.pendingParams?.execution_mode,
          });
          await get().replanTaskMessage(
            activeId,
            tm.taskId,
            input.settings,
            undefined,
            { plannerTextOverride: revisionText },
          );
          return;
        }
        // 遇到更晚的终态任务卡（success / failed / cancelled）就停止 ——
        // 说明 waiting_confirm 已经不是"当前待处理"的任务。
        if (
          tm.stage === 'success'
          || tm.stage === 'failed'
          || tm.stage === 'cancelled'
          || tm.stage === 'running'
          || tm.stage === 'queued'
        ) {
          break;
        }
      }
    }

    // ====== Clarification 续接（必须在创建任何新消息之前判断） ======
    // 当前会话存在尚未回答的 needs_clarification 任务，并且用户本轮输入更像"补充回答"
    // 而不是"明显的新任务"时，把这条输入路由成对原任务的重新规划，而不是新建一张卡。
    //
    // 判定优先级（spec）：
    //   1. 当前 conversation 中存在 pending needs_clarification 卡
    //   2. 用户当前输入没有附件（携带附件视为新任务）
    //   3. 用户当前输入不是明显的新任务（looksLikeExplicitNewTask=false）
    //   4. clarificationRound 没有超过 maxClarificationRounds
    if (
      currentConv
      && trimmed
      && attachments.length === 0
      && !ignoreActiveImage
    ) {
      const pending = findPendingClarificationTask(currentConv);
      if (pending && !looksLikeExplicitNewTask(trimmed)) {
        const MAX_CLARIFICATION_ROUNDS = 3;
        const currentRound = pending.task.clarificationRound ?? pending.task.clarification?.attempt ?? 0;
        if (currentRound >= MAX_CLARIFICATION_ROUNDS) {
          // 超过最大轮数：把这张卡转成 planning_failed，避免 Planner 死循环。
          console.warn('[PlannerClarification] exceeded max rounds', {
            conversationId: activeId,
            sourceMessageId: pending.message.id,
            round: currentRound,
            action: 'fail',
          });
          patchTaskMessageState(activeId, pending.message.id, current => ({
            ...current,
            status: 'failed',
            stage: 'planning_failed',
            error: '当前任务仍无法形成完整规划，请修改完整需求后重新提交。',
            plannerDiagnostic: {
              model: current.agentModel,
              errorKind: 'planner_schema_invalid',
              errorStage: '规划阶段',
              reason: `连续 ${currentRound} 轮仍需要补充信息，已停止追问。`,
            },
            // 注意：保留 clarification 字段，让用户能看到上一轮的问题；
            // 但 stage 已经切到 planning_failed，UI 不会再显示"确认执行"。
            updatedAt: new Date().toISOString(),
          }));
          patchMessage(activeId, pending.message.id, {
            content: stageDisplayContent('planning_failed'),
          });
          await get().saveConversation(activeId);
          set({ taskSubmitting: false });
          return;
        }

        // 路径 A：在原卡上重新规划，把当前用户输入当作"补充回答"。
        // 复用 replanTaskMessage 主体，但传入 clarification 续接文本。
        const originalRequest = pending.task.clarification?.originalRequest
          || pending.task.prompt
          || '';
        const clarificationQuestion = pending.task.clarification?.question || '';
        const nextRound = currentRound + 1;
        const continuationText = buildClarificationContinuationText({
          originalRequest,
          clarificationQuestion,
          userAnswer: trimmed,
          attempt: nextRound,
        });
        console.log('[PlannerClarification]', {
          conversationId: activeId,
          sourceMessageId: pending.message.id,
          answerLen: trimmed.length,
          round: nextRound,
          action: 'replan',
        });
        // 把用户本轮的补充回答 append 到 user message（让用户在聊天里能看到自己说了什么）。
        // 但是 replanTaskMessage 不会 append user message —— 所以这里手动 append 一条。
        // ID 用 supplement_ 前缀避免和后续 sendTaskMessage 产生的 m${now} / m${now+1} 冲突。
        const supplementMessage: ChatMessage = {
          id: `supplement_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          role: 'user',
          content: trimmed,
          created_at: new Date().toISOString(),
          chat_mode: 'task',
        };
        set(state => ({
          conversations: state.conversations.map(c =>
            c.id === activeId
              ? { ...c, messages: [...c.messages, supplementMessage] }
              : c,
          ),
        }));
        // 重新规划这张卡：使用合并后的 clarification 续接文本。
        // 关键：通过 plannerTextOverride 把组合文本只送给 Planner，
        // 不要修改 task_message.prompt（UI 上仍然显示原始任务）。
        await get().replanTaskMessage(
          activeId,
          pending.task.taskId,
          input.settings,
          undefined,
          {
            plannerTextOverride: continuationText,
            clarificationRound: nextRound,
          },
        );
        return;
      }
    }

    const imageAttachments = attachments.filter(item => item.type === 'image' && item.filePath);
    const hasImages = imageAttachments.length > 0;

    // ====== 统一源图解析（单一事实源：utils/agent/taskSourceImage）======
    // Planner 只判断 CREATE / EDIT；「图生图具体用哪张」由应用层在这里决定，
    // 并在下方 planningTaskMessage 里快照固化。优先级：
    //   1. 本轮用户上传附件（编辑目标 = 第一张附件）
    //   2. 会话 active image（"编辑此图"显式绑定 → explicit）
    //   3. 当前对话最后一张有效图片（时间序，latest）
    // ignoreActiveImage=true（"再来一张"强制 GENERATION）时彻底跳过会话解析。
    let resolvedSourceImageId: string | null = null;
    let resolvedSourceImagePath: string | null = null;
    let resolvedSourceImagePreviewUrl: string | undefined;
    let resolvedSourceImageFileName: string | undefined;
    let sourceImageSelection: SourceImageSelection = 'none';
    if (imageAttachments.length > 0) {
      // 附件任务：sourceImageId/Path 留空（附件通过 attachmentPaths 进入 source_images，
      // 第一张附件即编辑目标），不要让会话 active image 抢占编辑目标位。
      sourceImageSelection = 'attachment';
    } else if (!ignoreActiveImage) {
      const conversationSource = resolveConversationSourceImage({
        messages: currentConv?.messages || [],
        activeImageId: currentConv?.active_image_id,
        activeImagePath: currentConv?.active_image_path,
        activeImageSource: currentConv?.active_image_source,
      });
      resolvedSourceImageId = conversationSource.sourceImageId;
      resolvedSourceImagePath = conversationSource.sourceImagePath;
      resolvedSourceImagePreviewUrl = conversationSource.sourceImagePreviewUrl;
      resolvedSourceImageFileName = conversationSource.sourceImageFileName;
      sourceImageSelection = conversationSource.selection;
    }

    if (ignoreActiveImage) {
      console.log('[TaskRouting] ignoreActiveImage=true (explicit regenerate action), skipping active_image_id');
    }

    const hasEditableImage = hasImages || !!resolvedSourceImagePath;
    const sourceImageCount = (resolvedSourceImagePath ? 1 : 0) + imageAttachments.length;

    // 附件文件名 / 路径 —— 必须真正传给 Planner，否则它无法判断"用户已经准备好图"。
    const attachmentNames = imageAttachments.map(item => item.filePath || item.name).filter(Boolean) as string[];

    // 关键：图片附件语义映射（图一 / 图二 / 图三）—— 按用户选择顺序构建，
    // 必须与 imageAttachments 的真实顺序保持一致；后续 API 调用的 images 数组顺序也以此为真相。
    // 同时冻结一份 ordered snapshot，写入任务卡 —— 用户后续在 Composer 里删图不能影响历史任务。
    const attachmentDescriptors = buildAttachmentDescriptors(imageAttachments);
    const orderedAttachments: TaskMessageState['orderedAttachments'] = imageAttachments.map(item => ({
      id: item.id,
      source: item.source || 'unknown',
      internalName: item.filePath ? item.filePath.split(/[\\/]/).pop() || item.name : item.name,
      preview: item.dataUrl,
    }));

    // 任务级上下文继承：扫描当前会话的历史用户消息 + 任务卡，让"边上再加上他史莱姆的原型态"
    // 这种补充语句能够继承上一轮的"萌王 / 利姆鲁 / 作品 IP"。
    // ignoreActiveImage 时不做继承（用户明确要求生成全新图，不应被上一轮污染）。
    const sourceMessagesForContext = ignoreActiveImage || !currentConv
      ? []
      : currentConv.messages
          .filter(msg => msg.role === 'user' && (msg.content || '').trim())
          .slice(-MAX_CONTEXT_LOOKBACK)
          .map(msg => {
            // 找到该用户消息触发的任务卡（assistant 消息紧随其后），用它的 finalPrompt / taskType 作为继承锚点。
            const msgIndex = currentConv.messages.indexOf(msg);
            const followingAssistant = currentConv.messages
              .slice(msgIndex + 1)
              .find(m => m.role === 'assistant' && m.task_message);
            return {
              text: msg.content,
              finalPrompt: followingAssistant?.task_message?.finalPrompt,
              taskType: followingAssistant?.task_message?.taskType,
            };
          });
    const taskSemanticContext = ignoreActiveImage
      ? undefined
      : resolveTaskSemanticContext({
          currentMessage: trimmed,
          sourceMessages: sourceMessagesForContext,
        });

    // BYOK：Planner 按「任务规划」使用范围解析（planner_model_id / planner scope），
    // 与普通聊天共享同一套 token / Base URL / 错误体系（用户 Provider 唯一来源，无服务器回退）
    const taskByok = resolveByokConfigForUse('planner', currentConv);
    if (!taskByok.ok) {
      set({ error: taskByok.error });
      return;
    }
    const taskProfileSelection = {
      profile: { id: taskByok.profileId, name: taskByok.profileName },
      model: taskByok.modelEntity,
    };
    const agentConfig = {
      token: taskByok.token,
      model: taskByok.model,
      baseUrl: taskByok.baseUrl,
      billingMode: taskByok.billingMode,
      systemPrompt: taskByok.systemPrompt,
      source: 'agent' as const,
      hasOverrides: true,
      mismatch: false,
    };

    // ====== 首次提交：创建 user message + assistant 占位卡 (stage='planning')，然后原地更新 ======
    set({ taskSubmitting: true, error: null });

    const now = Date.now();
    const userMessageId = `m${now}`;
    const assistantMessageId = `m${now + 1}`;
    const draftTaskId = `draft_${assistantMessageId}`;
    const planningRequestId = `plan_${now}_${Math.random().toString(36).slice(2, 8)}`;
    // 创建应用级 PlannerJob —— 这样页面切换 / 会话切换都不会再误判中断。
    const plannerJob = registerPlannerJob({
      conversationId: activeId,
      messageId: assistantMessageId,
      planningRequestId,
      planningAttempt: 1,
      model: agentConfig.model,
    });
    const userMessage: ChatMessage = {
      id: userMessageId,
      role: 'user',
      content: trimmed || '(附件任务)',
      images: imageAttachments.map(item => item.dataUrl!).filter(Boolean),
      attachments,
      created_at: new Date().toISOString(),
      chat_mode: mode || 'task',
    };
    const planningTaskMessage: TaskMessageState = {
      taskId: draftTaskId,
      status: 'pending',
      stage: 'planning',
      title: summarizePrompt(trimmed),
      prompt: trimmed,
      finalPrompt: '',
      finalNegativePrompt: '',
      agentModel: agentConfig.model,
      executionModel: DEFAULT_EXECUTION_MODEL,
      plannerProviderProfileId: taskProfileSelection?.profile.id,
      plannerProviderNameSnapshot: taskProfileSelection?.profile.name,
      count: 1,
      images: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      taskType: undefined,
      apiKind: undefined,
      sourceImageCount,
      sourceImageId: resolvedSourceImageId || undefined,
      sourceImageSelection,
      sourceImagePreviewUrl: resolvedSourceImagePreviewUrl,
      sourceImageFileName: resolvedSourceImageFileName,
      // 任务语义层（即便 Planner 还没回来，UI 也能先显示真实的附件 / 继承上下文）。
      attachmentNames,
      attachmentDescriptors,
      orderedAttachments,
      editTargetImageCount: resolvedSourceImagePath ? 1 : 0,
      referenceImageCount: Math.max(0, imageAttachments.length),
      resolvedContext: taskSemanticContext
        ? {
            workTitle: taskSemanticContext.workTitle,
            primarySubject: taskSemanticContext.primarySubject,
            inheritedFromPreviousTurn: taskSemanticContext.inheritedFromPreviousTurn,
            augmentationDetected: taskSemanticContext.augmentationDetected,
            pronounBindings: taskSemanticContext.pronounBindings,
          }
        : undefined,
      // Chat Handoff 语义上下文：布局（九宫格）+ 来源标签，让确认卡 / 导出可见。
      gridLayout: chatHandoffContext?.grid
        ? {
            rows: chatHandoffContext.grid.rows,
            columns: chatHandoffContext.grid.columns,
            cellCount: chatHandoffContext.grid.cellCount,
          }
        : undefined,
      compositeLayout: chatHandoffContext?.orderedSelection || chatHandoffContext?.grid
        ? {
            type: chatHandoffContext?.grid
              ? (chatHandoffContext.grid.rows === 1 && chatHandoffContext.grid.columns === 3 ? 'triptych' : 'grid')
              : 'triptych',
            panelCount: chatHandoffContext?.grid?.cellCount
              || chatHandoffContext?.orderedSelection?.selectedLabels.length
              || 0,
          }
        : undefined,
      subjectEntities: chatHandoffContext?.orderedSelection?.selectedLabels
        ? [...chatHandoffContext.orderedSelection.selectedLabels]
        : undefined,
      contextSourceLabel: chatHandoffContext?.sourceLabel,
      confirming: false,
      cancelling: false,
      sourceUserMessageId: userMessageId,
      planningAttempt: 1,
      planningRequestId,
      // 关键：把 PlannerJob 关联 + 当前 app session id 一起持久化到磁盘。
      // 重新加载时 loadConversations → reconcilePlanningMessage 会读这两个字段，
      // 判断是"页面切换（同 session, job 还活着）"还是"应用重启（不同 session）"。
      plannerJobId: plannerJob.id,
      planningSessionId: APP_SESSION_ID,
    };
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: stageDisplayContent('planning'),
      created_at: new Date().toISOString(),
      is_image: true,
      task_message: planningTaskMessage,
      chat_mode: mode || 'task',
    };

    set(state => ({
      conversations: state.conversations.map(conversation =>
        conversation.id === activeId
          ? {
              ...conversation,
              title: conversation.title || trimmed.slice(0, 30) || '任务需求',
              conversation_mode: 'task_flow',
              chat_mode: mode || 'task',
              messages: [...conversation.messages, userMessage, assistantMessage],
            }
          : conversation,
      ),
    }));
    console.log('[TaskUI] render planning placeholder task=' + draftTaskId);
    // 关键修复：在 Planner 还在跑的时候，先把 planning 占位卡持久化到磁盘。
    // 否则用户切到任务队列 / 关闭应用 → loadConversations 时这条消息直接消失，
    // 用户没法看到"正在规划"或重启后点重新规划。即使 Planner 后续才返回，
    // loadConversations 内置的 "planning → planning_failed" 降级也能让它继续可用。
    void get().saveConversation(activeId);

    try {
      // 任务修订路径：Planner 看到 plannerTextOverride（原任务 + 修订指令的组合文本），
      // UI / user message 仍然显示用户原始输入。
      const textForPlanner = (plannerTextOverride || '').trim() || trimmed;
      const outcome = await planTaskCore({
        text: textForPlanner,
        agentConfig,
        agentDefaults,
        hasEditableImage,
        sourceImageCount,
        resolved: {
          sourceImageId: resolvedSourceImageId,
          sourceImagePath: resolvedSourceImagePath,
          sourceImagePreviewUrl: resolvedSourceImagePreviewUrl,
          sourceImageFileName: resolvedSourceImageFileName,
          sourceImageSelection,
        },
        attachmentPaths: imageAttachments.map(item => item.filePath!).filter(Boolean) as string[],
        attachmentNames,
        attachmentDescriptors,
        taskSemanticContext,
        chatHandoffContext,
        providerFailure: { providerId: taskByok.profileId, providerType: taskByok.providerType, providerName: taskByok.profileName, billingMode: taskByok.billingMode },
      });

      // 防止快速连点"重新规划"导致旧响应覆盖新请求：requestId 必须仍然匹配当前卡片。
      const currentMsg = get().conversations.find(c => c.id === activeId)
        ?.messages.find(m => m.id === assistantMessageId);
      if (currentMsg?.task_message?.planningRequestId !== planningRequestId) {
        console.warn('[AgentTask] planningRequestId mismatch, discarding stale planner outcome', { draftTaskId });
        set({ taskSubmitting: false });
        return;
      }

      applyPlannerOutcomeToTaskMessage(activeId, assistantMessageId, outcome, {
        planningAttempt: 1,
        planningRequestId,
        prompt: trimmed,
      });
      // 把 job 标记成终态 —— 后续若有 race 中的 loadConversations 查到这个 job，
      // 会按 outcome 重放，避免磁盘 snapshot 把状态覆盖回 planning。
      settlePlannerJob(
        plannerJob.id,
        outcome.kind === 'planning_failed' ? 'failed' : 'completed',
        outcome,
        trimmed,
      );

      console.log('[AgentTask] planning resolved', {
        draftTaskId,
        kind: outcome.kind,
        taskType: outcome.taskType,
        apiKind: outcome.apiKind,
      });
    } catch (err: any) {
      console.error('[AgentTask] planning exception', err);
      const fallbackOutcome: PlannerCoreOutcome = {
        kind: 'planning_failed',
        taskType: 'generate',
        apiKind: 'generation',
        error: err?.message || '规划过程中出现异常，请稍后重试。',
        agentModel: agentConfig.model,
        executionModel: DEFAULT_EXECUTION_MODEL,
        plannerDiagnostic: {
          model: agentConfig.model,
          errorKind: 'transport',
          errorStage: '规划模型请求',
          reason: err?.message || '规划过程中出现异常，请稍后重试。',
        },
        sourceImageId: resolvedSourceImageId,
        sourceImagePath: resolvedSourceImagePath,
        sourceImagePreviewUrl: resolvedSourceImagePreviewUrl,
        sourceImageFileName: resolvedSourceImageFileName,
        sourceImageSelection,
      };
      applyPlannerOutcomeToTaskMessage(activeId, assistantMessageId, fallbackOutcome, {
        planningAttempt: 1,
        planningRequestId,
        prompt: trimmed,
      });
      settlePlannerJob(plannerJob.id, 'failed', fallbackOutcome, trimmed);
    }

    set({ taskSubmitting: false });
    await get().saveConversation(activeId);
  },

  confirmTaskMessage: async (conversationId, taskId) => {
    if (!taskId) return;
    if (get().taskSubmitting) return;
    const conversation = get().conversations.find(c => c.id === conversationId);
    const message = conversation?.messages.find(m => m.task_message?.taskId === taskId);
    if (!message?.task_message) return;
    // 关键修复（spec）：执行 Guard 单一真相源。
    // 任何 needs_clarification / malformed waiting_confirm 都必须在这里被拦下来，
    // 而不是等到下面 pendingParams 检查时才用泛泛的"任务参数缺失"应付。
    const readiness = getTaskExecutionReadiness(message.task_message);
    if (!readiness.executable) {
      console.warn('[TaskExecutionGuard]', {
        allowed: false,
        reason: readiness.reasonCode,
        messageId: message.id,
        taskId,
        stage: message.task_message.stage,
      });
      set({ error: readiness.reason || '当前任务暂不能执行。' });
      return;
    }
    if (message.task_message.confirming) {
      console.warn('[AgentTask] confirm ignored: already confirming', taskId);
      return;
    }
    const params = message.task_message.pendingParams!;

    // 标记为确认中，防止重复点击
    patchTaskMessageState(conversationId, message.id, current => ({
      ...current,
      confirming: true,
      updatedAt: new Date().toISOString(),
    }));

    set({ taskSubmitting: true, error: null });

    try {
      // 生成前预占额度（V4 两阶段计费；remove_background 已无服务端计费）
      let billingRequestId: string | undefined;
      try {
        if (params.task_type !== 'remove_background') {
          billingRequestId = await authorizeImageTaskOrThrow(params.count ?? 1);
        }
      } catch (estimateError: any) {
        patchTaskMessageState(conversationId, message.id, current => ({
          ...current,
          confirming: false,
          status: 'failed',
          stage: 'failed',
          error: estimateError?.message || '当前余额不足，请前往“我的账户”充值后继续使用。',
          // 失败也保存 duration（spec 五十四节）—— 计时从确认点算起。
          executionFinishedAt: current.executionStartedAt
            ? new Date().toISOString()
            : undefined,
          executionDurationMs: current.executionStartedAt
            ? Math.max(0, Date.now() - Date.parse(current.executionStartedAt))
            : undefined,
          updatedAt: new Date().toISOString(),
        }));
        set({ taskSubmitting: false });
        await get().saveConversation(conversationId);
        return;
      }

      console.log('[AgentTask] task confirmed, submitting to backend', taskId);
      // ====== 执行耗时计时起点（spec 五十二节）======
      // 从用户"确认执行"这一刻开始，Planning / 等待确认耗时绝不计入。
      const executionStartedAtIso = new Date().toISOString();
      console.log('[TaskExecutionTimer]', { messageId: message.id, event: 'start' });
      const task = await useTaskStore.getState().createAndExecuteTask(params);
      if (billingRequestId) registerTaskAuthorization(task.id, billingRequestId);
      console.log('[TaskExecution] task created', task.id);

      const realStage = buildTaskMessageFromTask(task, {
        title: message.task_message.title,
        prompt: message.task_message.prompt,
        finalPrompt: message.task_message.finalPrompt,
        finalNegativePrompt: message.task_message.finalNegativePrompt,
        model: message.task_message.model,
        agentModel: message.task_message.agentModel,
        executionModel: message.task_message.executionModel || DEFAULT_EXECUTION_MODEL,
        taskType: message.task_message.taskType,
        apiKind: message.task_message.apiKind,
        sourceImageCount: message.task_message.sourceImageCount,
        sourceImageId: message.task_message.sourceImageId,
        sourceImageSelection: message.task_message.sourceImageSelection,
        executionStartedAt: executionStartedAtIso,
      });

      patchMessage(conversationId, message.id, {
        task_message: realStage,
        content: stageDisplayContent(realStage.stage, task),
      });

      set(state => ({
        conversations: state.conversations.map(c =>
          c.id === conversationId
            ? {
                ...c,
                active_task_id: task.id,
                // 任务确认提交后保留 active_image_id：
                // - 如果是 GENERATION 任务，将在 syncTaskMessage 的 SUCCESS 阶段被覆盖为新生成的图片
                // - 如果是 EDIT 任务，源图保持不变直到编辑成功后再被覆盖为编辑结果图
                // 这样下一条自然语言输入能够正确识别为 EDIT 而不是误判为 GENERATION。
              }
            : c,
        ),
      }));

      await get().saveConversation(conversationId);
      void useImageStore.getState().loadImages();
    } catch (error: any) {
      const friendly = explainError(error);
      patchTaskMessageState(conversationId, message.id, current => ({
        ...current,
        confirming: false,
        status: 'failed',
        stage: 'failed',
        error: friendly,
        // 失败也保存 duration：从确认执行的 startedAt 截止到发现失败的时刻。
        executionFinishedAt: current.executionStartedAt
          ? new Date().toISOString()
          : undefined,
        executionDurationMs: current.executionStartedAt
          ? Math.max(0, Date.now() - Date.parse(current.executionStartedAt))
          : undefined,
        updatedAt: new Date().toISOString(),
      }));
      if (isAuthError(error)) {
        useAuthStore.getState().logout();
        useAuthStore.getState().showAuthPrompt();
      }
      set({ error: friendly });
      await get().saveConversation(conversationId);
    } finally {
      set({ taskSubmitting: false });
    }
  },

  cancelTaskMessage: async (conversationId, taskId) => {
    const conversation = get().conversations.find(c => c.id === conversationId);
    const message = conversation?.messages.find(m => m.task_message?.taskId === taskId);
    if (!message?.task_message) return;
    const stage = message.task_message.stage;
    // WAITING_CONFIRM / PLANNING_FAILED / NEEDS_CLARIFICATION 都是纯前端态，直接从消息列表里移除，
    // 不调用任何图片接口、不扣费。取消后当前会话不再有 pending clarification，
    // 下一条用户消息不会再被吸附到这张卡上。
    if (stage === 'waiting_confirm' || stage === 'planning_failed' || stage === 'needs_clarification') {
      set(state => ({
        conversations: state.conversations.map(c =>
          c.id === conversationId
            ? { ...c, messages: c.messages.filter(m => m.id !== message.id) }
            : c,
        ),
      }));
      console.log('[AgentTask] task cancelled (frontend stage)', stage, taskId);
      await get().saveConversation(conversationId);
      return;
    }
    // 运行中任务：调用后端取消
    if (taskId && !taskId.startsWith('draft_') && !taskId.startsWith('pending_') && !taskId.startsWith('failed_')) {
      try {
        await useTaskStore.getState().cancelTask(taskId);
        await get().syncTaskMessage(taskId, conversationId);
      } catch (error: any) {
        set({ error: explainError(error) });
      }
    }
  },

  editTaskMessage: (conversationId, taskId, finalPrompt, finalNegativePrompt) => {
    const conversation = get().conversations.find(c => c.id === conversationId);
    const message = conversation?.messages.find(m => m.task_message?.taskId === taskId);
    if (!message?.task_message) return;
    // WAITING_CONFIRM 才允许原地修改 prompt。needs_clarification 阶段没有 finalPrompt，
    // 用户如果点"修改任务"，应该走 replanTaskMessage 而不是这里。
    if (message.task_message.stage !== 'waiting_confirm') return;
    patchTaskMessageState(conversationId, message.id, current => {
      const nextParams: CreateTaskParams | undefined = current.pendingParams
        ? {
            ...current.pendingParams,
            prompt: finalPrompt,
            final_prompt: finalPrompt,
            final_negative_prompt: finalNegativePrompt ?? current.finalNegativePrompt ?? '',
            negative_prompt: finalNegativePrompt ?? current.finalNegativePrompt ?? '',
          }
        : current.pendingParams;
      return {
        ...current,
        prompt: current.prompt, // 保留原始用户输入
        finalPrompt,
        finalNegativePrompt: finalNegativePrompt ?? current.finalNegativePrompt ?? '',
        pendingParams: nextParams,
        updatedAt: new Date().toISOString(),
      };
    });
    void get().saveConversation(conversationId);
  },

  replanTaskMessage: async (conversationId, taskId, settings, newText, options) => {
    // 重新规划：针对同一张 PLANNING_FAILED / WAITING_CONFIRM / NEEDS_CLARIFICATION 任务卡原地重新调用 Planner。
    // 关键约束（见 spec）：
    //   - 不能再次 append 一条用户消息（"给我生成一张LOL的对战图" 只能出现一次）
    //   - 不能创建第二张 TaskMessageCard
    //   - 用户消息位置 / id 都不能变
    // 因此本函数完全在原 assistant 任务卡上做 stage 切换：planning_failed|waiting_confirm|needs_clarification -> planning -> ...
    //
    // clarification 续接路径会传入 options.plannerTextOverride：
    //   - 这是"原任务 + 上一轮 clarification + 用户本轮补充"的组合文本，仅供 Planner 看。
    //   - 不会修改 user message / task_message.prompt。UI 上仍然显示原任务。
    if (get().taskSubmitting) {
      console.warn('[AgentTask] replan ignored: another task is submitting');
      return;
    }
    const conversation = get().conversations.find(c => c.id === conversationId);
    if (!conversation) return;
    const message = conversation.messages.find(m => m.task_message?.taskId === taskId);
    if (!message?.task_message) return;
    const tm = message.task_message;
    const stage = tm.stage;
    if (stage !== 'planning_failed' && stage !== 'waiting_confirm' && stage !== 'needs_clarification') {
      console.warn('[AgentTask] replan ignored: stage is not planning_failed/waiting_confirm/needs_clarification', taskId, stage);
      return;
    }

    const trimmedNew = (newText || '').trim();
    const plannerTextOverride = (options?.plannerTextOverride || '').trim();
    // textForReplan 是真正送入 Planner 的文本：
    //   1. clarification 续接路径 → plannerTextOverride（合并文本）
    //   2. 修改任务弹窗 → trimmedNew（用户新需求）
    //   3. 直接点重新规划 → tm.prompt（原任务）
    const textForReplan = plannerTextOverride || trimmedNew || tm.prompt || '';
    if (!textForReplan.trim()) {
      set({ error: '请输入要重新规划的需求。' });
      return;
    }

    // 复用同一份 settings 解析 agent 配置。
    const agentDefaults = useSettingsStore.getState().settings;
    if (!agentDefaults.default_output_dir) {
      set({ error: '请先在「设置与更新 → 图片与文件」中配置输出目录。' });
      return;
    }
    // 重新规划同样按「任务规划」使用范围走 BYOK 唯一来源（用户 Provider，无服务器回退）
    const replanByok = resolveByokConfigForUse('planner', conversation);
    if (!replanByok.ok) {
      patchTaskMessageState(conversationId, message.id, current => ({
        ...current,
        status: 'failed',
        error: replanByok.error,
      }));
      set({ error: replanByok.error });
      return;
    }
    const agentConfig = {
      token: replanByok.token,
      model: replanByok.model,
      baseUrl: replanByok.baseUrl,
      billingMode: replanByok.billingMode,
      systemPrompt: replanByok.systemPrompt,
      source: 'agent' as const,
      hasOverrides: true,
      mismatch: false,
    };

    // 重新规划不允许携带新附件（用户修改的文字直接覆盖原 prompt）。
    // 原任务卡上保留的 sourceImageId / Path 仍然作为编辑上下文 ——
    // 重新规划只重跑 Planner Prompt，绝不重新 getLatestImage() 覆盖绑定
    //（除非原任务本来就没有源图快照：上一轮是 GENERATION / 无图场景，
    // 此时按会话默认规则补一张候选，且只在 Planner 判 EDIT 时生效）。
    let resolved: PlannerSourceImageContext;
    if (tm.sourceImageId || tm.sourceImagePath) {
      resolved = {
        sourceImageId: tm.sourceImageId ?? null,
        sourceImagePath: tm.sourceImagePath ?? null,
        sourceImagePreviewUrl: tm.sourceImagePreviewUrl,
        sourceImageFileName: tm.sourceImageFileName,
        sourceImageSelection: tm.sourceImageSelection || 'latest',
      };
    } else {
      const conversationSource = resolveConversationSourceImage({
        messages: conversation.messages,
        activeImageId: conversation.active_image_id,
        activeImagePath: conversation.active_image_path,
        activeImageSource: conversation.active_image_source,
      });
      resolved = {
        sourceImageId: conversationSource.sourceImageId,
        sourceImagePath: conversationSource.sourceImagePath,
        sourceImagePreviewUrl: conversationSource.sourceImagePreviewUrl,
        sourceImageFileName: conversationSource.sourceImageFileName,
        sourceImageSelection: conversationSource.selection,
      };
    }
    const hasEditableImage = !!resolved.sourceImagePath;
    const sourceImageCount = resolved.sourceImagePath ? 1 : 0;

    // 仅当用户通过"修改任务"弹窗改写需求时（trimmedNew 路径），
    // 才把对应的 user message 内容原地更新（不 append 新消息）。
    // clarification 续接路径（plannerTextOverride）不会触碰原 user message，
    // 因为 UI 仍然需要展示原始任务，用户的补充已经在外层 append 成了新 user message。
    const userMessageId = tm.sourceUserMessageId;
    if (!plannerTextOverride && trimmedNew && trimmedNew !== tm.prompt && userMessageId) {
      patchMessage(conversationId, userMessageId, { content: trimmedNew });
    }

    // 生成新的 planningRequestId，并立刻把任务卡切到 stage='planning'。
    const planningRequestId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const nextAttempt = (tm.planningAttempt || 1) + 1;
    // 为本次重新规划注册一个全新的 PlannerJob（不复用旧 job —— 旧 job 已经 settle）。
    // 使用当前用户选择的 agent 模型，因此"5.4 失败 → 顶部切 5.6-luna → 重新规划"
    // 第一帧 UI 显示的就是 5.6-luna。
    const plannerJob = registerPlannerJob({
      conversationId,
      messageId: message.id,
      planningRequestId,
      planningAttempt: nextAttempt,
      model: agentConfig.model,
    });
    patchTaskMessageState(conversationId, message.id, current => ({
      ...current,
      status: 'pending',
      stage: 'planning',
      // prompt 字段的更新规则：
      //   - "修改任务"路径（trimmedNew）：把 prompt 同步成新需求，让 UI 显示用户改写后的版本。
      //   - clarification 续接路径（plannerTextOverride）：**保持原 prompt**，
      //     UI 上仍然显示"原始任务"，避免把组合文本泄露到原任务展示区。
      //   - 直接重新规划：保持原 prompt。
      prompt: plannerTextOverride ? current.prompt : (trimmedNew || current.prompt),
      error: undefined,
      // 切到 planning 时一并刷新 agentModel，让 UI 第一帧就显示当前选择的模型。
      agentModel: agentConfig.model,
      planningAttempt: nextAttempt,
      planningRequestId,
      plannerJobId: plannerJob.id,
      planningSessionId: APP_SESSION_ID,
      // 关键：planning 阶段先清掉旧 clarification，避免在 Planner 还没回来之前
      // getTaskExecutionReadiness 仍然把卡判定为 needs_clarification。
      // 真正下一轮的 clarification（如果有）会在 applyPlannerOutcomeToTaskMessage 里重新写入。
      clarification: undefined,
      updatedAt: new Date().toISOString(),
    }));
    patchMessage(conversationId, message.id, { content: stageDisplayContent('planning') });
    set({ taskSubmitting: true, error: null });

    try {
      const outcome = await planTaskCore({
        text: textForReplan,
        agentConfig,
        agentDefaults,
        hasEditableImage,
        sourceImageCount,
        resolved,
        attachmentPaths: [],
        // 重新规划不会携带新附件 —— 但要把原任务上冻结的附件语义映射继承下去，
        // 否则 Planner 在重规划路径下会丢失 "图一/图二" 的引用上下文。
        attachmentDescriptors: tm.attachmentDescriptors,
        providerFailure: { providerId: replanByok.profileId, providerType: replanByok.providerType, providerName: replanByok.profileName, billingMode: replanByok.billingMode },
      });

      // 防止快速连点"重新规划"导致旧响应覆盖新请求。
      const currentMsg = get().conversations.find(c => c.id === conversationId)
        ?.messages.find(m => m.id === message.id);
      if (currentMsg?.task_message?.planningRequestId !== planningRequestId) {
        console.warn('[AgentTask] replan requestId mismatch, discarding stale outcome', { taskId });
        set({ taskSubmitting: false });
        return;
      }

      // applyPlannerOutcomeToTaskMessage 的 options.prompt 会被写入 task_message.prompt。
      // 对于 clarification 续接路径，我们要保持 task_message.prompt 不变（仍是原任务），
      // 因此传 tm.prompt（保留原值），而不是 plannerTextOverride。
      const promptForOutcome = plannerTextOverride
        ? (tm.prompt || tm.clarification?.originalRequest || plannerTextOverride)
        : (trimmedNew || tm.prompt || textForReplan);
      applyPlannerOutcomeToTaskMessage(conversationId, message.id, outcome, {
        planningAttempt: nextAttempt,
        planningRequestId,
        prompt: promptForOutcome,
        clarificationRound: options?.clarificationRound ?? tm.clarificationRound,
      });
      settlePlannerJob(
        plannerJob.id,
        outcome.kind === 'planning_failed' ? 'failed' : 'completed',
        outcome,
        // 这里 settlePlannerJob 的 appliedPrompt 用于 recovery replay，
        // 应该传"真正给 Planner 的文本"，即 textForReplan（含组合文本）。
        textForReplan,
      );

      console.log('[AgentTask] replan resolved', {
        taskId,
        attempt: nextAttempt,
        kind: outcome.kind,
        taskType: outcome.taskType,
        apiKind: outcome.apiKind,
      });
    } catch (err: any) {
      console.error('[AgentTask] replan exception', err);
      const fallbackOutcome: PlannerCoreOutcome = {
        kind: 'planning_failed',
        taskType: (tm.taskType as PlannerCoreOutcome['taskType']) || 'generate',
        apiKind: (tm.apiKind as PlannerCoreOutcome['apiKind']) || 'generation',
        error: err?.message || '重新规划过程中出现异常，请稍后重试。',
        agentModel: agentConfig.model,
        executionModel: tm.executionModel || DEFAULT_EXECUTION_MODEL,
        plannerDiagnostic: {
          model: agentConfig.model,
          errorKind: 'transport',
          errorStage: '规划模型请求',
          reason: err?.message || '重新规划过程中出现异常，请稍后重试。',
        },
        sourceImageId: resolved.sourceImageId,
        sourceImagePath: resolved.sourceImagePath,
        sourceImagePreviewUrl: resolved.sourceImagePreviewUrl,
        sourceImageFileName: resolved.sourceImageFileName,
        sourceImageSelection: resolved.sourceImageSelection,
      };
      // 再次校验 requestId，避免异常路径上把更新的卡片覆盖回去。
      const currentMsg = get().conversations.find(c => c.id === conversationId)
        ?.messages.find(m => m.id === message.id);
      if (currentMsg?.task_message?.planningRequestId !== planningRequestId) {
        set({ taskSubmitting: false });
        return;
      }
      applyPlannerOutcomeToTaskMessage(conversationId, message.id, fallbackOutcome, {
        planningAttempt: nextAttempt,
        planningRequestId,
        // 同上：clarification 续接路径保持 task_message.prompt = 原任务，
        // 不把组合文本写回 UI 展示字段。
        prompt: plannerTextOverride
          ? (tm.prompt || tm.clarification?.originalRequest || plannerTextOverride)
          : (trimmedNew || tm.prompt || textForReplan),
        clarificationRound: options?.clarificationRound ?? tm.clarificationRound,
      });
      settlePlannerJob(
        plannerJob.id,
        'failed',
        fallbackOutcome,
        textForReplan,
      );
    }

    set({ taskSubmitting: false });
    await get().saveConversation(conversationId);
  },

  retryTaskMessage: async (conversationId, taskId) => {
    if (!taskId || get().taskSubmitting) return;
    set({ taskSubmitting: true, error: null });
    try {
      const retried = await useTaskStore.getState().retryTask(taskId);
      // 找到旧任务卡，更新为新的 taskId / 状态
      const oldMessage = findMessageByTaskId(conversationId, taskId);
      if (oldMessage) {
        const next = buildTaskMessageFromTask(retried, {
          title: oldMessage.task_message?.title,
          prompt: oldMessage.task_message?.prompt,
          model: oldMessage.task_message?.model,
          agentModel: oldMessage.task_message?.agentModel,
          executionModel: oldMessage.task_message?.executionModel || DEFAULT_EXECUTION_MODEL,
          taskType: oldMessage.task_message?.taskType,
          apiKind: oldMessage.task_message?.apiKind,
          sourceImageCount: oldMessage.task_message?.sourceImageCount,
          sourceImageId: oldMessage.task_message?.sourceImageId,
          sourceImageSelection: oldMessage.task_message?.sourceImageSelection,
          // 重试 = 新一次执行：重置计时器（spec 六十八节：并发/重试各自计时）。
          executionStartedAt: new Date().toISOString(),
        });
        patchMessage(conversationId, oldMessage.id, {
          task_message: next,
          content: stageDisplayContent(next.stage, retried),
        });
      }
      set(state => ({
        conversations: state.conversations.map(c =>
          c.id === conversationId ? { ...c, active_task_id: retried.id } : c,
        ),
      }));
      await get().saveConversation(conversationId);
    } catch (error: any) {
      const friendly = explainError(error);
      set({ error: friendly });
    } finally {
      set({ taskSubmitting: false });
    }
  },

  syncTaskMessage: async (taskId, conversationId) => {
    // draft / pending / failed 占位任务没有后端真实 task，跳过同步
    if (!taskId || taskId.startsWith('draft_') || taskId.startsWith('pending_') || taskId.startsWith('failed_')) {
      return;
    }
    const task = useTaskStore.getState().tasks.find(t => t.id === taskId);
    if (!task) {
      // 任务可能已经被删除
      patchTaskMessageByTaskId(taskId, current => {
        // 不要把 PLANNING / WAITING_CONFIRM / PLANNING_FAILED / NEEDS_CLARIFICATION 也同步成 interrupted。
        // 这些态从未创建后端 Task，taskMap 里查不到是正常的。
        if (current.stage === 'planning' || current.stage === 'waiting_confirm' || current.stage === 'planning_failed' || current.stage === 'needs_clarification' || current.stage === 'cancelled') return current;
        console.warn('[TaskSync] task missing in store, marking interrupted', { taskId, messageStage: current.stage });
        return {
          ...current,
          status: 'failed',
          stage: 'interrupted',
          error: current.error || '任务因应用中断或被删除，未能完成。',
          // 中断恢复：封顶 duration，避免旧 startedAt 累加成离谱时间。
          executionFinishedAt: current.executionStartedAt && !current.executionFinishedAt
            ? new Date().toISOString()
            : current.executionFinishedAt,
          executionDurationMs: current.executionStartedAt && current.executionDurationMs == null
            ? Math.max(0, Date.now() - Date.parse(current.executionStartedAt))
            : current.executionDurationMs,
          updatedAt: new Date().toISOString(),
        };
      });
      return;
    }

    // 找到关联消息：如果指定了 conversationId 用之，否则在所有会话中扫描
    const targetConv = conversationId
      ? [useChatStore.getState().conversations.find(c => c.id === conversationId)]
      : useChatStore.getState().conversations;

    for (const conv of targetConv) {
      if (!conv) continue;
      const msg = conv.messages.find(m => m.task_message?.taskId === taskId);
      if (!msg) continue;
      const currentStage = msg.task_message?.stage;
      // PLANNING / WAITING_CONFIRM / PLANNING_FAILED 是前端态，永远不要被后端任务覆盖
      if (currentStage === 'planning' || currentStage === 'waiting_confirm' || currentStage === 'planning_failed') {
        continue;
      }

      const wasRunning = currentStage === 'queued' || currentStage === 'analyzing' || currentStage === 'running' || currentStage === 'saving';
      const next = buildTaskMessageFromTask(task, {
        title: msg.task_message?.title,
        prompt: msg.task_message?.prompt,
        finalPrompt: msg.task_message?.finalPrompt,
        finalNegativePrompt: msg.task_message?.finalNegativePrompt,
        model: msg.task_message?.model,
        agentModel: msg.task_message?.agentModel,
        executionModel: msg.task_message?.executionModel || DEFAULT_EXECUTION_MODEL,
        taskType: msg.task_message?.taskType,
        apiKind: msg.task_message?.apiKind,
        sourceImageCount: msg.task_message?.sourceImageCount,
        sourceImageId: msg.task_message?.sourceImageId,
        sourceImageSelection: msg.task_message?.sourceImageSelection,
        // 执行耗时：startedAt 来自确认执行时刻；终态时 buildTaskMessageFromTask
        // 会补 finishedAt / durationMs。已计算过的 duration 保留，不重复覆盖。
        executionStartedAt: msg.task_message?.executionStartedAt,
        executionFinishedAt: msg.task_message?.executionFinishedAt,
        executionDurationMs: msg.task_message?.executionDurationMs,
      });

      // 完成时加载结果图
      if (task.status === 'completed') {
        const needsLoad = !msg.task_message?.images || msg.task_message.images.length === 0;
        if (needsLoad) {
          try {
            const imgs = await loadTaskResultImages(task);
            next.images = imgs;
            next.resultImageIds = imgs.map(i => i.imageId || i.id);
          } catch (err) {
            console.warn('[TaskEvent] load result images failed', err);
          }
        } else {
          // 持久化时 URL 被剥离，需要根据 localPath 重新生成 URL
          const existingImages = msg.task_message?.images || [];
          next.images = await refreshTaskMessageImageUrls(existingImages);
          if (!next.resultImageIds || next.resultImageIds.length === 0) {
            next.resultImageIds = next.images.map(i => i.imageId || i.id).filter(Boolean) as string[];
          }
        }
      } else if (msg.task_message?.images?.length) {
        next.images = msg.task_message.images;
      }

      // 失败：聚合子任务错误 + 构造 executionDiagnostic
      if (task.status === 'failed') {
        const subErrors = (task.sub_tasks || [])
          .map(s => s.error)
          .filter((e): e is string => !!e);
        if (!next.error) {
          next.error = subErrors[0] || '任务执行失败，请重试或查看任务详情。';
        }
        // 从子任务错误里推断 HTTP 状态码 / 错误类型，方便失败卡展示。
        const firstErr = subErrors[0] || '';
        const httpMatch = firstErr.match(/(?:HTTP|http)\s*(\d{3})/);
        const httpStatus = httpMatch ? Number(httpMatch[1]) : null;
        next.executionDiagnostic = {
          httpStatus,
          errorKind: inferExecutionErrorKind(firstErr),
          summary: firstErr || '任务执行失败，请查看任务详情。',
          subTaskErrors: subErrors.slice(0, 5),
        };
      }
      if (task.status === 'cancelled' && !next.error) {
        next.error = '任务已取消。';
      }

      // === Terminal State Override ===
      // 真实 Task 进入终态时，必须立即覆盖 message 的中间执行态。
      // 这是从根因上修复"任务队列已 FAILED，聊天仍 RUNNING"的关键防线：
      // 不依赖 current.stage 是否还是 running —— 只要后端给出终态，UI 必须跟着终态。
      if (
        (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')
        && currentStage !== next.stage
      ) {
        console.warn('[TaskSync] terminal state override', {
          taskId,
          taskStatus: task.status,
          messageStage: currentStage,
          nextStage: next.stage,
        });
      }

      patchMessage(conv.id, msg.id, {
        task_message: next,
        content: stageDisplayContent(next.stage, task),
      });

      console.log('[TaskRestore] restore task', taskId, 'status=' + task.status, 'stage=' + next.stage);

      // 任务成功后：把当前会话的 active_image_id 推进为最新结果图，
      // 这样下一条自然语言输入（例如"把那艘小船去掉"）能够被识别为 EDIT。
      // 这是从 GENERATION 衔接到 EDIT 的关键衔接点。
      //
      // ===== 防回退守卫（图片漂移根因修复）=====
      // task-updated 事件会对【所有】任务触发（包括旧任务的 retry、focus/visibility
      // 触发的全量 reconcile）。若不加守卫，旧任务后到的事件会把 active image
      // 拉回旧图 —— 下一个编辑任务就绑定了错误源图。守卫规则：
      // 只允许按完成时间向前推进，绝不允许回退。
      if (task.status === 'completed' && next.images && next.images.length > 0) {
        const firstImage = next.images[0];
        const imageId = firstImage.imageId || firstImage.id;
        const imagePath = firstImage.localPath;
        if (imageId && imagePath) {
          const currentConv = get().conversations.find(c => c.id === conv.id);
          if (!currentConv) continue;
          const alreadyCurrent = currentConv.active_image_id === imageId
            && currentConv.active_image_path === imagePath;
          const candidateAt = Date.parse(task.completed_at || task.created_at || '');
          const currentAt = currentConv.active_image_set_at
            ? Date.parse(currentConv.active_image_set_at)
            : NaN;
          // 时间不可比时（旧数据无 set_at / 时间缺失）保守允许推进 ——
          // 与旧行为一致，避免历史会话卡死在旧图上。
          const isForward = !Number.isFinite(candidateAt)
            || !Number.isFinite(currentAt)
            || candidateAt >= currentAt;
          if (!alreadyCurrent && isForward) {
            console.log('[Conversation] activeImageId advanced:', imageId, {
              taskId,
              candidateAt: task.completed_at || task.created_at,
              previousSetAt: currentConv.active_image_set_at,
            });
            set(state => ({
              conversations: state.conversations.map(c =>
                c.id === conv.id
                  ? {
                      ...c,
                      active_image_id: imageId,
                      active_image_path: imagePath,
                      active_task_id: taskId,
                      active_image_source: 'auto',
                      active_image_set_at: task.completed_at
                        || task.created_at
                        || new Date().toISOString(),
                    }
                  : c,
              ),
            }));
          } else if (!alreadyCurrent && !isForward) {
            console.log('[Conversation] activeImageId advance blocked (stale task event)', {
              taskId,
              candidateAt: task.completed_at || task.created_at,
              currentSetAt: currentConv.active_image_set_at,
            });
          }
        }
      }

      // 持久化最新状态，避免下次 loadConversations 读到旧快照
      try { await get().saveConversation(conv.id); } catch (err) {
        console.warn('[TaskRestore] save conversation failed', err);
      }

      // 任务完成后刷新图库
      if (wasRunning && (task.status === 'completed' || task.status === 'failed')) {
        console.log('[TaskEvent] task terminal', taskId, task.status);
        void useImageStore.getState().loadImages();
      }
    }
  },

  reconcileTaskMessages: async (conversationId) => {
    // 收集所有需要同步的 (taskId, conversationId) 对。
    // PLANNING / WAITING_CONFIRM / PLANNING_FAILED 不在此处同步，因为它们是纯前端态。
    const conversations = conversationId
      ? useChatStore.getState().conversations.filter(c => c.id === conversationId)
      : useChatStore.getState().conversations;
    const targets: Array<{ taskId: string; convId: string }> = [];
    for (const conv of conversations) {
      for (const msg of conv.messages) {
        const tm = msg.task_message;
        if (!tm) continue;
        const stage = tm.stage;
        if (stage === 'planning' || stage === 'waiting_confirm' || stage === 'planning_failed' || stage === 'needs_clarification') continue;
        const tid = tm.taskId;
        if (!tid) continue;
        if (tid.startsWith('draft_') || tid.startsWith('pending_') || tid.startsWith('failed_') || tid === 'no_task') continue;
        targets.push({ taskId: tid, convId: conv.id });
      }
    }
    if (targets.length === 0) return;
    // 串行同步，避免一次性的大批 setState 把渲染卡死。
    for (const target of targets) {
      try {
        await get().syncTaskMessage(target.taskId, target.convId);
      } catch (err) {
        console.warn('[TaskReconcile] sync failed', target.taskId, err);
      }
    }
  },

  confirmProposal: async (conversationId, messageId) => {
    const conversation = get().conversations.find(item => item.id === conversationId);
    const message = conversation?.messages.find(item => item.id === messageId);
    const proposal = message?.agent_proposal;
    if (!proposal || proposal.status !== 'draft') return;
    setConversationSending(conversationId, true);
    markProposalSubmitting(conversationId, messageId, proposal);
    try {
      set(state => ({
        conversations: state.conversations.map(conversation =>
          conversation.id === conversationId
            ? {
                ...conversation,
                active_task_draft: conversation.active_task_draft
                  ? { ...conversation.active_task_draft, stage: 'confirmed', updated_at: new Date().toISOString() }
                  : null,
              }
            : conversation,
        ),
      }));
      await createTaskFromProposal(conversationId, messageId, proposal);
    } catch (error: any) {
        finishConversationText(conversationId, messageId, `❌ ${explainError(error)}`, {
        agent_proposal: { ...proposal, status: 'draft' },
      });
    }
  },

  cancelProposal: async (conversationId, messageId) => {
    const conversation = get().conversations.find(item => item.id === conversationId);
    const message = conversation?.messages.find(item => item.id === messageId);
    const proposal = message?.agent_proposal;
    if (!proposal) return;
      patchMessage(conversationId, messageId, {
        content: '已取消本次任务提案。',
      agent_proposal: { ...proposal, status: 'cancelled' },
    });
    set(state => ({
      conversations: state.conversations.map(conversation =>
        conversation.id === conversationId
          ? { ...conversation, active_task_draft: conversation.active_task_draft ? { ...conversation.active_task_draft, stage: 'cancelled', updated_at: new Date().toISOString() } : null }
          : conversation,
      ),
    }));
    await get().saveConversation(conversationId);
  },

  updateProposalPrompt: async (conversationId, messageId, finalPrompt, finalNegativePrompt) => {
    const conversation = get().conversations.find(item => item.id === conversationId);
    const message = conversation?.messages.find(item => item.id === messageId);
    const proposal = message?.agent_proposal;
    if (!proposal) return;
    patchMessage(conversationId, messageId, {
      content: buildProposalContent({
        ...proposal,
        final_prompt: finalPrompt,
        final_negative_prompt: finalNegativePrompt,
      }),
      agent_proposal: {
        ...proposal,
        final_prompt: finalPrompt,
        final_negative_prompt: finalNegativePrompt,
      },
    });
    set(state => ({
      conversations: state.conversations.map(conversation =>
        conversation.id === conversationId
          ? {
              ...conversation,
              active_task_draft: conversation.active_task_draft
                ? {
                    ...conversation.active_task_draft,
                    final_prompt: finalPrompt,
                    final_negative_prompt: finalNegativePrompt,
                    updated_at: new Date().toISOString(),
                  }
                : null,
            }
          : conversation,
      ),
    }));
    get().scheduleSaveConversation(conversationId);
  },

  toggleProposalBatchItem: async (conversationId, messageId, itemId) => {
    const conversation = get().conversations.find(item => item.id === conversationId);
    const message = conversation?.messages.find(item => item.id === messageId);
    const proposal = message?.agent_proposal;
    if (!proposal?.batch_items?.length) return;
    const batchItems = proposal.batch_items.map(item =>
      item.id === itemId ? { ...item, enabled: item.enabled === false ? true : false } : item,
    );
    patchMessage(conversationId, messageId, {
      content: buildProposalContent({ ...proposal, batch_items: batchItems }),
      agent_proposal: { ...proposal, batch_items: batchItems },
    });
    set(state => ({
      conversations: state.conversations.map(conv =>
        conv.id === conversationId
          ? {
              ...conv,
              active_task_draft: conv.active_task_draft && conv.active_task_draft.variant_plan
                ? {
                    ...conv.active_task_draft,
                    variant_plan: {
                      ...conv.active_task_draft.variant_plan,
                      items: conv.active_task_draft.variant_plan.items.map(item =>
                        item.id === itemId ? { ...item, enabled: item.enabled === false ? true : false } : item,
                      ),
                    },
                    updated_at: new Date().toISOString(),
                  }
                : conv.active_task_draft,
            }
          : conv,
      ),
    }));
    get().scheduleSaveConversation(conversationId);
  },

  // Skill 相关方法
  setSkillMode: (mode) => set({ skillMode: mode }),
  setSelectedSkillId: (id) => set({ selectedSkillId: id, skillMode: id ? 'manual' : 'auto' }),
}));

// 任务卡实时同步的唯一入口：TaskStore 刷新完成（拿到 Rust 最新快照）后按 taskId 回调。
// 不得在 task-updated 事件回调里直接读 TaskStore —— 那里读到的是上一次刷新的旧状态。
registerTaskRefreshHook(taskId => {
  void useChatStore.getState().syncTaskMessage(taskId).catch(err => {
    console.warn('[TaskBridge] chat sync failed', taskId, err);
  });
});

