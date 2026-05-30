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
  TaskBatchItem,
  TaskBatchStrategy,
  VisionUnderstandResult,
} from '../types';
import { api } from '../services/api';
import { serverApi } from '../services/serverApi';
import { useAuthStore } from './useAuthStore';
import { useSettingsStore } from './useSettingsStore';
import { useTaskStore } from './useTaskStore';
import { useImageStore } from './useImageStore';
import { explainError, isAuthError } from '../utils/errors';
import { classifyAgentIntent } from '../utils/agentIntent';
import { resolveAgentConfig } from '../utils/agentConfig';
import { getAgentTemplateCache, setAgentTemplateCache } from '../utils/agent/templateCache';

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
};

type TemplateMatchResult = {
  taskTemplate: AgentTaskTemplate | null;
  styleTemplates: AgentStyleTemplate[];
  clarificationQuestion?: string;
};

type ConversationTransitionDecision =
  | { kind: 'execution_confirmation'; executionTarget: { messageId: string; proposal: AgentProposal } | null }
  | { kind: 'retry_submission' }
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

  loadConversations: () => Promise<void>;
  save: () => Promise<void>;
  saveConversation: (conversationId: string) => Promise<void>;
  scheduleSaveConversation: (conversationId: string, delayMs?: number) => void;
  newConversation: () => string;
  switchConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  sendMessage: (text: string, settings: SendSettings, options: SendOptions) => Promise<void>;
  stopGeneration: (conversationId?: string) => void;
  confirmProposal: (conversationId: string, messageId: string, settings: SendSettings) => Promise<void>;
  cancelProposal: (conversationId: string, messageId: string) => Promise<void>;
  updateProposalPrompt: (conversationId: string, messageId: string, finalPrompt: string, finalNegativePrompt: string) => Promise<void>;
  toggleProposalBatchItem: (conversationId: string, messageId: string, itemId: string) => Promise<void>;
}

const CONTEXT_TAIL_MESSAGES = 10;
const CONVERSATION_SAVE_DEBOUNCE_MS = 500;
const pendingConversationSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    images: [],
    reasoning: message.reasoning || '',
    reasoning_duration: message.reasoning_duration || '',
    generated_image: '',
    created_at: message.created_at,
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
  const direct = text.match(/(\d+)\s*(张|份|个|套|版|版本)/);
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
  const count = parseRequestedCount(input.text);
  const imageCount = input.attachments.filter(item => item.type === 'image' && !!item.filePath).length;
  const variationAxis = detectVariationAxis(input.text);
  const asksMany = count > 1 || /(一批|这些都|全部|都给我|批量)/.test(input.text);
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

function proposalIntentLabel(intent: AgentProposal['intent']) {
  return intent === 'image_edit' ? '图生图 / 图片编辑' : intent === 'remove_background' ? '去背景' : intent === 'upscale' ? '高清放大' : '文生图';
}

function buildProposalContent(proposal: AgentProposal) {
  const lines = [
    `任务识别：${proposalIntentLabel(proposal.intent)}`,
    `我理解你的需求：${proposal.user_prompt_raw}`,
    proposal.execution_mode === 'batch' ? `执行模式：批量 / ${proposal.batch_strategy}` : '执行模式：单任务',
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
  const liveMessages = conv.messages.filter(message => message.role === 'user' || message.role === 'assistant');
  const tailMessages = liveMessages.slice(-CONTEXT_TAIL_MESSAGES);
  if (!conv.context_summary?.trim()) return tailMessages;
  const summaryMessage: ChatMessage = {
    id: `${conv.id}_context_summary`,
    role: 'assistant',
    content: `上下文摘要：\n${conv.context_summary.trim()}`,
    created_at: conv.context_summary_updated_at || conv.created_at,
  };
  return [summaryMessage, ...tailMessages];
}

async function estimateOrThrow(items: Parameters<typeof serverApi.estimateUsage>[0]) {
  try {
    const estimate = await serverApi.estimateUsage(items);
    if (!estimate.can_run) {
      const error: any = new Error(estimate.message || '当前余额不足，请前往“我的账户”充值后继续使用。');
      error.status = 402;
      throw error;
    }
  } catch (error: any) {
    if (error?.status === 404 || error?.status === 405) return;
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
    const error: any = new Error('图片理解模型未配置，请到“设置 > AI 智能体”中选择支持视觉的模型。');
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
    text: raw,
    has_images: hasImages,
    editable_image_count: editableImages.length,
    attachment_names: input.attachments.map(item => item.name),
    rough_intent: roughIntent,
  }) as AgentRunRequestResult;

  if (!result.ok) {
    const error: any = new Error(result.error_message || 'Agent 请求失败');
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
    throw new Error('请先在设置中配置输出目录。');
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

  if (effectiveIntent === 'remove_background') {
    await estimateOrThrow([{ type: 'postprocess', tool: 'remove.bg', quantity: count }]);
  } else {
    await estimateOrThrow([{ type: 'image', model: 'gpt-image-2', quantity: count }]);
  }

  const task = await api.createTask({
    prompt: proposal.final_prompt,
    negative_prompt: proposal.final_negative_prompt,
    user_prompt_raw: proposal.user_prompt_raw,
    final_prompt: proposal.final_prompt,
    final_negative_prompt: proposal.final_negative_prompt,
    prompt_optimized: true,
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
  });

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
      executionMode === 'batch' ? `批量任务：${count} 个子任务 / ${proposal.batch_strategy}` : '',
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

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeId: null,
  runtimeById: {},
  error: null,
  abortCtrls: {},

  loadConversations: async () => {
    try {
      const conversations = await api.getConversations();
      const runtimeById = conversations.reduce<Record<string, ConversationRuntime>>((acc, conversation) => {
        acc[conversation.id] = { isSending: false };
        return acc;
      }, {});
      set({
        conversations: conversations.map(rehydrateConversation),
        activeId: conversations[0]?.id || null,
        runtimeById,
      });
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

  switchConversation: (id) => set({
    activeId: id,
    error: null,
  }),

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

    const agentConfig = resolveAgentConfig(settings);
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

    try {
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
          used_local_fallback: usedLocalFallback,
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

      const auth = useAuthStore.getState();
      if (!auth.isLoggedIn) {
        throw new Error('请先登录后再使用对话功能。');
      }
      if (!agentToken) {
        throw new Error('当前账户缺少智能体 Token，请前往“我的账户”充值或申请试用。');
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
      let systemPrompt =
        agentSystemPrompt ||
        '你是 CyImagePro 的图片智能体助手。普通问答直接简洁回复；涉及图库、图片理解、文生图、图生图、去背景或放大任务时，先理解用户需求，再根据上下文继续对话。';
      if (options.planOnly) {
        systemPrompt += '\n\n当前为计划模式，只输出任务理解、推荐动作、费用或余额预估以及待确认事项，不执行图片任务。';
      }
      if (currentVisionSummary) {
        systemPrompt += `\n\n以下是独立图片理解模块对当前附件的观察结果，请基于这些结果回答，不要声称自己直接看到了图片：\n${currentVisionSummary}`;
      }

      for (const message of buildContextMessages(conversation)) {
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        if (message.content || message.images?.length) {
          const content = [
            message.content,
            message.images?.length && message.role === 'user'
              ? `[该轮用户消息附带了 ${message.images.length} 张图片；图片内容不直接注入历史上下文，仅保留文字记录]`
              : '',
          ].filter(Boolean).join('\n');
          if (content) {
            apiMessages.push({ role: message.role, content });
          }
        }
      }

      await estimateOrThrow([{
        type: 'agent',
        model: agentModel,
        input_tokens: Math.max(1, Math.ceil(JSON.stringify(apiMessages).length / 3)),
        output_tokens: 1024,
        cached_tokens: 0,
      }]);

      const runResult = await api.runAgentRequest({
        mode: 'chat',
        base_url: agentBaseURL,
        token: agentToken,
        model: agentModel,
        system_prompt: systemPrompt,
        messages: apiMessages,
      }) as AgentRunRequestResult;

      if (abortCtrl.signal.aborted) {
        finishConversationText(activeId, assistantMessage.id, '*[已停止]*');
        return;
      }

      if (!runResult.ok) {
        const error: any = new Error(runResult.error_message || 'Agent 对话失败');
        error.kind = runResult.error_kind;
        error.status = runResult.status;
        throw error;
      }

      let reply = runResult.reply?.trim() || '(空回复)';
      let reasoning = '';
      let reasoningDuration = '';
      const thinkingMatch = reply.match(/<thinking>([\s\S]*?)<\/thinking>/);
      if (thinkingMatch) {
        reasoning = thinkingMatch[1].trim();
        reply = reply.replace(/<thinking>[\s\S]*?<\/thinking>/, '').trim();
        reasoningDuration = '思考完成';
      }

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
        set(state => ({ error: friendly }));
        clearAbort(activeId);
        await get().saveConversation(activeId);
      }
    }
  },

  stopGeneration: (conversationId) => {
    const targetId = conversationId || get().activeId;
    if (!targetId) return;
    const controller = get().abortCtrls[targetId];
    if (controller) controller.abort();
    clearAbort(targetId);
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
}));


