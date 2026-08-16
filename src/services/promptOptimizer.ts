/**
 * PromptOptimizerService —— 统一的 AI 提示词优化服务。
 *
 * 模型来源：resolveByokConfigForUse('prompt_optimizer')（用户自己配置的
 * GLM / DeepSeek / 第三方 API，禁止 fallback 到服务器 Agent）。
 *
 * 使用约定：
 *  - 返回的是「候选 Prompt」，绝不自动覆盖用户原文 —— 由 UI 层显式「采用优化」后写入。
 *  - 优化与生成是两步，本服务不触发任何图片生成。
 */

import { api } from './api';
import { resolveByokConfigForUse } from '../features/aiProviders/store';
import { buildProviderError, providerErrorCompact } from '../features/aiProviders/providerError';

export interface PromptOptimizeInput {
  /** 原始 Prompt（用户当前输入，不会被修改） */
  prompt: string;
  /** 用户的优化要求（例如"更电影感"）；可空 */
  instruction?: string;
  /** 任务类型：generate=文生图，edit=图生图 */
  taskType?: 'generate' | 'edit';
  /** 目标图片模型 / 能力信息（可选，帮助模型适配输出风格） */
  targetModelInfo?: string;
  /**
   * 多 Prompt 批量规划：存在时优化器不再输出单条提示词，
   * 而是拆成 requestedCount 条相互独立的子提示词（每条只描述一张图的内容）。
   */
  batchPlan?: {
    requestedCount: number;
    /** 已枚举出的对象（例如 ["上海","北京","广州"]），第 i 条必须对应 objects[i]。 */
    objects?: string[];
  };
}

export interface OptimizedPromptItem {
  title: string;
  prompt: string;
}

export interface PromptOptimizeResult {
  optimizedPrompt: string;
  /** 多 Prompt 批量模式下的拆分结果（每条 = 一个子任务 = 一次图片调用）。 */
  items?: OptimizedPromptItem[];
  /** 模型建议的负面提示词（可选） */
  negativePrompt?: string;
  /** 实际使用的规划模型（用于 UI 展示） */
  plannerProviderName: string;
  plannerModelName: string;
}

const OPTIMIZER_SYSTEM_PROMPT = `你是 CyImagePro 的 AI 提示词优化专家。用户输入的是「需求内容」（自然语言描述），你负责把它优化为专业的图片生成提示词。

规则：
1. 保留用户原始意图中的全部关键要素（主体、数量、场景、风格），不擅自增删主体。
2. 按通用最佳实践优化：结构清晰、视觉要素具体、风格与光影明确。
3. positive_prompt 与 negative_prompt 一律使用简体中文（专有名词可保留原文）；即使用户输入是英文，输出仍为简体中文；禁止自动翻译成英文，禁止中英双份输出。
4. 单张复合构图（如"一张图包含 3 个分镜"）必须保持单张输出语义，禁止拆成多条。
5. 正向提示词（positive_prompt）描述想要的画面；负面提示词（negative_prompt）用简体中文列出要避免出现的元素（低画质、模糊、错误人体结构、多余手指、水印、文字、低清晰度等典型负面项），没有可避免项时输出空字符串。

输出格式（严格遵守）：只输出一个 JSON 对象，不要输出解释、前言或 Markdown 代码块。
{"positive_prompt": "完整正向提示词", "negative_prompt": "完整负面提示词"}`;

const MULTI_PROMPT_SYSTEM_PROMPT = `你是 CyImagePro 的多 Prompt 批量规划专家。用户需要多张相互独立的图片（每个对象/主题各一张），你负责把需求拆成多条独立的图片生成提示词。

规则：
1. 必须输出"指定数量"条提示词：不多、不少，绝不擅自增加或合并任务。
2. 每条提示词描述且只描述一张图的内容：一个主体、一个场景。禁止在单条提示词里同时描述多个并列主体。
3. 严禁生成三联画/拼图/分屏/宫格/多联画/多场景组合图语义——每个对象都是一张独立成图。
4. 若给定了对象列表，第 i 条提示词必须对应第 i 个对象（可补充合理的场景/风格细节，但对象不能换）。
5. 若未给定对象列表，由你为每条提示词选择具体、互不重复的对象（例如用户说"3 张不同中国城市夜景"，你可以选上海/北京/广州各一条，但不能选 5 个）。
6. 各条提示词保持共同的风格基调（与用户原始需求一致），只替换主体/对象。
7. 每条提示词与共用负面提示词一律使用简体中文；即使用户输入是英文，输出仍为简体中文；禁止自动翻译成英文。不要输出解释、前言或 Markdown 代码块。

输出格式（严格遵守）：
OPTIMIZED_ITEMS:
1. <短标题> | <完整的单图提示词>
2. <短标题> | <完整的单图提示词>
...
NEGATIVE:
<共用的建议负面提示词；如无必要则输出"无">`;

interface AgentRunResult {
  ok: boolean;
  reply?: string;
  error_kind?: string;
  error_message?: string;
  status?: number;
}

export type PromptOptimizerOutcome =
  | { ok: true; result: PromptOptimizeResult }
  | { ok: false; error: string };

function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|?reasoning[\s\S]*?(?:$|\/>?reasoning\|?>)/gi, '')
    .trim();
}

export function cleanReply(reply: string): string {
  return stripReasoning(reply)
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .trim();
}

function normalizeNegative(raw: string | undefined): string | undefined {
  const value = (raw || '').trim();
  return value && value !== '无' && value.toUpperCase() !== 'NONE' ? value : undefined;
}

/** 负面提示词段标签：规范 NEGATIVE: + 模型常见中文变体（行首锚定） */
const NEGATIVE_LABEL = /(?:^|\n)\s*(?:NEGATIVE|建议负面提示词|负面提示词|建议负面提示)\s*[:：]?\s*/i;

/** 拆分列表标签：规范 OPTIMIZED_ITEMS: + 模型变体（_ITEMS: / __ITEMS__ / ITEMS: 等，行首锚定） */
const ITEMS_LABEL = /(?:^|\n)\s*(?:OPTIMIZED_ITEMS|_{1,4}ITEMS_{0,4}|ITEMS_{0,4})\s*[:：]?\s*/i;

const OPTIMIZED_LABEL = /(?:^|\n)\s*OPTIMIZED\s*[:：]?\s*/i;

/** 行首负面标签前切分：body = 正向内容，negative = 负面内容 */
function splitNegative(cleaned: string): { body: string; negative?: string } {
  const match = cleaned.match(NEGATIVE_LABEL);
  if (!match || match.index === undefined) return { body: cleaned };
  return {
    body: cleaned.slice(0, match.index).trim(),
    negative: normalizeNegative(cleaned.slice(match.index + match[0].length)),
  };
}

export function parseOptimizerReply(reply: string): { prompt: string; negative?: string } | null {
  const { body, negative } = splitNegative(cleanReply(reply));
  const labelMatch = body.match(OPTIMIZED_LABEL);
  const prompt = (labelMatch && labelMatch.index !== undefined
    ? body.slice(0, labelMatch.index) + body.slice(labelMatch.index + labelMatch[0].length)
    : body
  ).trim();
  // 模型未按格式输出：整段视为优化结果（不丢弃有效输出）
  if (prompt) return { prompt, negative };
  return null;
}

/**
 * 结构化 JSON 解析：{"positive_prompt": "...", "negative_prompt": "..."}。
 *
 * 健壮性要求（不能裸 JSON.parse 一崩全崩）：
 *  - 剥离 <think> 推理段与 Markdown 代码栅栏（```json ... ```）；
 *  - 容忍 JSON 前后的说明文字：截取首个 { 到与之配平的 } 之间的片段；
 *  - 字段缺失 / 类型不符 / "无" / "NONE" → 归一化为 undefined；
 *  - 解析失败返回 null（调用方回落旧文本协议或报错，绝不返回半截结果）。
 */
export function parseOptimizerJson(reply: string): { prompt: string; negative?: string } | null {
  const cleaned = cleanReply(reply);
  if (!cleaned.includes('{')) return null;

  let candidate = '';
  // 优先取 fenced 代码块内的内容（```` 已经被 cleanReply 剥掉栅栏标记）
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { candidate = cleaned.slice(start, i + 1); break; }
    }
  }
  if (!candidate) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const positive = typeof record.positive_prompt === 'string' ? record.positive_prompt.trim() : '';
  if (!positive) return null;
  const negative = typeof record.negative_prompt === 'string' ? record.negative_prompt.trim() : '';
  return { prompt: positive, negative: normalizeNegative(negative) };
}

/** 编号/符号列表行 → 子 Prompt 条目（标题 | 提示词，无分隔符时截断生成标题） */
function parseItemListLines(listBody: string): OptimizedPromptItem[] {
  const items: OptimizedPromptItem[] = [];
  for (const rawLine of listBody.split('\n')) {
    const line = rawLine.replace(/^\s*(?:[-*•]|\d{1,2})\s*[.、)．]?\s*/, '').trim();
    if (!line) continue;
    const pipeIdx = line.indexOf('|');
    let title: string;
    let prompt: string;
    if (pipeIdx > 0 && pipeIdx < line.length - 1) {
      title = line.slice(0, pipeIdx).trim();
      prompt = line.slice(pipeIdx + 1).trim();
    } else {
      prompt = line;
      title = line.length > 16 ? `${line.slice(0, 16)}…` : line;
    }
    if (prompt) items.push({ title: title || prompt.slice(0, 12), prompt });
  }
  return items;
}

/**
 * 解析多 Prompt 批量结构化输出（编号列表）。
 * 返回 null 表示模型没有按列表格式返回（调用方应报错而非降级成单条——
 * 单条合并 Prompt 会把多个主体塞进一张图，正是要避免的三联画问题）。
 * 兼容模型未按规范输出 OPTIMIZED_ITEMS 而写成 _ITEMS / __ITEMS__ 的变体。
 */
export function parseOptimizerItems(reply: string): { items: OptimizedPromptItem[]; negative?: string } | null {
  const { body, negative } = splitNegative(cleanReply(reply));
  const labelMatch = body.match(ITEMS_LABEL);
  if (!labelMatch || labelMatch.index === undefined) return null;
  const listBody = body.slice(labelMatch.index + labelMatch[0].length);
  if (!listBody.trim()) return null;

  const items = parseItemListLines(listBody);
  if (items.length < 2) return null;
  return { items, negative };
}

export async function optimizePrompt(input: PromptOptimizeInput): Promise<PromptOptimizerOutcome> {
  const byok = resolveByokConfigForUse('prompt_optimizer');
  if (!byok.ok) {
    return { ok: false, error: byok.error };
  }

  const batchPlan = input.batchPlan && input.batchPlan.requestedCount >= 2 ? input.batchPlan : undefined;
  const taskLabel = input.taskType === 'edit' ? '图生图（图片编辑）' : '文生图';
  const userContent = [
    `任务类型：${taskLabel}`,
    input.targetModelInfo ? `目标图片模型：${input.targetModelInfo}` : '',
    batchPlan ? `批量要求：拆成 ${batchPlan.requestedCount} 条独立提示词（每条一张图）` : '',
    batchPlan?.objects?.length ? `指定对象（按顺序对应每条提示词）：${batchPlan.objects.join('、')}` : '',
    '',
    '需求内容：',
    input.prompt.trim(),
    '',
    input.instruction?.trim() ? `优化要求：\n${input.instruction.trim()}` : '',
  ].filter(line => line !== '').join('\n');

  try {
    const runResult = await api.runAgentRequest({
      mode: 'chat',
      base_url: byok.baseUrl,
      token: byok.token,
      model: byok.model,
      billing_mode: byok.billingMode,
      system_prompt: batchPlan ? MULTI_PROMPT_SYSTEM_PROMPT : OPTIMIZER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }) as AgentRunResult;

    if (!runResult.ok) {
      const providerError = buildProviderError({
        providerId: byok.profileId,
        providerType: byok.providerType,
        providerName: byok.profileName,
        billingMode: byok.billingMode,
        modelId: byok.model,
        failure: {
          ok: false,
          error_kind: runResult.error_kind,
          error_message: runResult.error_message,
          status: runResult.status,
        },
      });
      return { ok: false, error: providerErrorCompact(providerError) };
    }

    if (batchPlan) {
      const parsedItems = parseOptimizerItems(runResult.reply || '');
      if (!parsedItems) {
        return { ok: false, error: 'AI 未按多 Prompt 列表格式返回优化结果，请重试（已保留原始提示词）。' };
      }
      // 任务数量受 requestedCount 约束：多退不补（少于要求数量时如实返回实际条数）
      const items = parsedItems.items.slice(0, batchPlan.requestedCount);
      return {
        ok: true,
        result: {
          optimizedPrompt: items.map((item, i) => `${i + 1}. ${item.title}：${item.prompt}`).join('\n'),
          items,
          negativePrompt: parsedItems.negative,
          plannerProviderName: byok.profileName,
          plannerModelName: byok.modelEntity.display_name || byok.model,
        },
      };
    }

    // 单条模式下模型也可能按列表格式返回（多对象各一张）：
    // 先按列表解析成结构化 items，绝不把 _ITEMS: 这类协议文本原样返回给 UI
    const parsedAsItems = parseOptimizerItems(runResult.reply || '');
    if (parsedAsItems) {
      return {
        ok: true,
        result: {
          optimizedPrompt: parsedAsItems.items.map((item, i) => `${i + 1}. ${item.title}：${item.prompt}`).join('\n'),
          items: parsedAsItems.items,
          negativePrompt: parsedAsItems.negative,
          plannerProviderName: byok.profileName,
          plannerModelName: byok.modelEntity.display_name || byok.model,
        },
      };
    }

    // 结构化 JSON（主协议）→ 旧文本协议（OPTIMIZED:/NEGATIVE:，兼容未按 JSON 输出的模型）
    const parsed = parseOptimizerJson(runResult.reply || '') || parseOptimizerReply(runResult.reply || '');
    if (!parsed) {
      return { ok: false, error: 'AI 未返回有效的优化结果，请重试（已保留原始需求）。' };
    }
    return {
      ok: true,
      result: {
        optimizedPrompt: parsed.prompt,
        negativePrompt: parsed.negative,
        plannerProviderName: byok.profileName,
        plannerModelName: byok.modelEntity.display_name || byok.model,
      },
    };
  } catch (error: any) {
    return { ok: false, error: error?.message || '提示词优化请求失败，请重试。' };
  }
}

/** 当前 Prompt 优化模型（用于 UI 展示"优化模型：智谱 / GLM-5.2"） */
export function resolvePromptOptimizerModelLabel(): string | null {
  const byok = resolveByokConfigForUse('prompt_optimizer');
  if (!byok.ok) return null;
  return `${byok.profileName} / ${byok.modelEntity.display_name || byok.model}`;
}
