/**
 * PromptOptimizerService —— 统一的 AI 提示词优化服务。
 *
 * 模型来源：resolveModelForRole（V4.1 AI Model Routing 唯一入口）：
 *  - 图片 Prompt 优化 → role=image_prompt_optimizer（agent 档案提示词优化链）
 *  - 视觉复刻 Prompt 优化 → role=vision_prompt_optimizer（默认跟随视觉理解模型；
 *    视觉模型不可用时显式回退提示词优化模型，绝不静默继承聊天默认模型）
 *
 * 使用约定：
 *  - 返回的是「候选 Prompt」，绝不自动覆盖用户原文 —— 由 UI 层显式「采用优化」后写入。
 *  - 优化与生成是两步，本服务不触发任何图片生成。
 */

import { api } from './api';
import { buildProviderError, providerErrorCompact } from '../features/aiProviders/providerError';
import { resolveModelForRole, recordAiRoleUsage, type AiRoleConnection } from '../features/aiRouting/resolveModelForRole';
import { logAiTransport } from '../features/aiRouting/aiRoutingLog';
import type { AiModelSource } from '../features/aiRouting/modelRoles';
import type { RecreationFieldKey, VisualRecreationPlan } from '../features/vision/recreationPlan';

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
  const record = extractBalancedJsonRecord(reply);
  if (!record) return null;
  const positive = typeof record.positive_prompt === 'string' ? record.positive_prompt.trim() : '';
  if (!positive) return null;
  const negative = typeof record.negative_prompt === 'string' ? record.negative_prompt.trim() : '';
  return { prompt: positive, negative: normalizeNegative(negative) };
}

/** cleanReply 后截取首个配平的 {...} 并 JSON.parse；失败返回 null。 */
function extractBalancedJsonRecord(reply: string): Record<string, unknown> | null {
  const cleaned = cleanReply(reply);
  if (!cleaned.includes('{')) return null;

  let candidate = '';
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

  try {
    const parsed = JSON.parse(candidate);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
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
  const resolution = resolveModelForRole('image_prompt_optimizer');
  if (!resolution.ok || !resolution.connection) {
    return { ok: false, error: resolution.ok ? '该功能没有可用的模型连接。' : resolution.error };
  }
  const byok: AiRoleConnection = resolution.connection;
  recordAiRoleUsage(resolution.resolved);
  logAiTransport(resolution.resolved, 'image-studio-optimize');

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
      role: 'image_prompt_optimizer',
      feature: 'image-studio-optimize',
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
  const resolution = resolveModelForRole('image_prompt_optimizer');
  if (!resolution.ok) return null;
  return `${resolution.resolved.providerName} / ${resolution.resolved.displayName}`;
}

// ===== 视觉理解复刻链路：统一「调整要求」→ 最终 Prompt 重建 =====

const VISION_RECREATION_SYSTEM_PROMPT = `你是 CyImagePro 的视觉复刻 Prompt 重建专家。用户已对参考图完成视觉理解，得到一份结构化复刻方案和原始复刻 Prompt；现在用户在「调整要求」中用大白话提出修改意愿（例如"把主体换成蓝色小龙，整体更梦幻"），你负责基于原始方案重建最终生图 Prompt。

规则：
0. 【硬性合同（HARD CONTRACT）不可变更】：用户内容中【硬性合同】段列出的值（人物是否替换 / 人物身份来源 / 服装来源 / 区域是否应用 / 媒介结构 / 用户显式启用的修改维度）是用户已确认的事实，你没有裁决权：不得推翻、省略、软化或"重新决定"它们；你的职责只是把这些已确定的合同表达成更好的生成语言。合同与调整要求冲突时，合同优先并在 summary 说明。
1. 用户手动锁定的维度（最高优先级）：必须保持与结构化方案一致，显式强化保持约束（例如"保持原始上篮动作不变"）；即使用户的调整要求与手动锁定项冲突，也优先保留锁定内容，并在 summary 中说明存在冲突、已优先保留锁定项，且绝不能把它列入 changed_dimensions。
2. 维度权限分档，严格按【结构化复刻方案】行内标注执行：「模板锁定」「用户手动锁定」的维度必须保持基线不变——绝不列入 changed_dimensions、不在 dimension_values 中给出新值、也不得在 positive_prompt 中重新描述这些维度（锁定维度的 canonical 描述由最终装配的【模板保留合同】层承载，你无权另写一份）；只有「用户显式要求修改」与「用户手动开放」的维度允许修改。模糊意图（如"整体更梦幻一点"）不得解锁任何锁定维度。
2a. 结构化方案中标注「用户显式要求修改」的维度、以及调整要求中「重点修改维度」与「XX修改（已启用）」指令行涉及的维度，是用户明确开启的修改项：这些维度必须真实修改（不是可选），必须列入 changed_dimensions 并在 dimension_values 中给出新值；用户未给出具体值时由你设计自洽的新值——动作必须与原图明确不同（新姿势 / 手势 / 视角至少一项显著变化，禁止沿用原图姿势），背景内容必须在保持画面风格与氛围的前提下发生明确变化（背景中的人物 / 屏幕 / 画面元素随之调整），服装严格按「服装处理」指令执行。规则 2 的「禁止大面积放开」不适用于这些显式开启的维度。
3. 修改要整体自洽：例如替换主体后需要重建与新人选自洽的整体描述（性别、年龄、外观、服装与场景/动作/风格的衔接），不是简单字符串替换。
4. 原始复刻 Prompt 中与修改无关的视觉结构必须原样保留语义，不得漂移。
5. 「人物 / 主体」（subject）与「服装 / 造型」（clothing）是两个独立维度，必须区分判定：用户只换人（如"换成一个黑发男性"）而未提及服装 → subject 修改、clothing 保持原服装；用户只描述服装（如"人物不变，换成红色晚礼服"）→ clothing 修改、subject 保持；人物描述中同时包含服装（如"黑发男性，穿白色西装"）→ subject 与 clothing 都修改。
6. 人物替换参考图仅用于身份、脸部、发型、体型等人物特征；是否采用参考图服装必须遵循调整要求中的「服装处理」指令，并在最终 Prompt 中显式写出服装保留或替换的约束（禁止只写"换这个人"式的模糊表达）。「服装处理」指令与 changed_dimensions 的硬性对应：「严格保留原图（画面模板）服装」→ clothing 绝不能出现在 changed_dimensions，最终 Prompt 显式写出保持模板图服装的约束；「使用人物参考图中的服装」→ clothing 必须列入 changed_dimensions，dimension_values.clothing 来自人物参考图服装语义；「更换为指定服装」→ clothing 必须列入 changed_dimensions，dimension_values.clothing 来自自定义服装描述。
6a. 随消息附上的图片按其标注角色使用，双图人物替换工作流必须区分两类来源：画面模板图（延续其画风、视觉氛围、构图与背景关系，最终生成与模板图同风格的图片）+ 人物替换参考图（仅提供主体人物的身份、五官、发型与外貌特征；以及按「服装处理」指令提供服装）。人物参考图中的姿势、动作、身体朝向、观看角度、镜头、构图与背景一律不得采用——这些维度以画面模板图为准（换人 ≠ 换姿势 / 换构图）。替换人物后需要把人物特征与模板图的画风 / 构图 / 场景重新衔接自洽，不得把模板图风格替换成人物参考图的写实风格。
6b. 人物替换是用户的显式业务动作，属于强制条件而非建议：你无权裁决「是否替换人物」。调整要求含「人物替换（强制条件）」时，最终 positive_prompt 必须显式写出：主体人物的身份、脸部五官、脸型、发型以人物参考图为准；不得保留画面模板图原人物的脸部身份或面部特征；模板图仅用于画面布局、风格、背景与整体视觉参考。当随消息附上多张图片时，positive_prompt 开头必须包含「图片使用说明」段：按附图顺序逐张写明职责（图片1=画面模板：构图/风格/背景/氛围；图片2=人物身份参考：身份/五官/发型），让图片生成模型明确每张附图负责什么。「服装处理：严格保留原图（画面模板）服装」只约束服装本身，绝不扩大为保留原图人物（保留服装 ≠ 保留人物）。「复刻强度 / 提高复刻度」只作用于未开放修改的画面维度，绝不作用于人物身份。
6c. 媒介结构（如果硬性合同包含媒介结构）：人物参考图只决定「是谁」，媒介结构决定「怎么画」——二者绝不混淆。混合媒介模板（如真人摄影 × 动漫插画拼贴）的各媒介层必须保持各自媒介类型：真人层保持真人媒介、动漫层保持动漫媒介。动漫主角色是唯一的 Canonical Anime Character（唯一动漫角色设计实例）：它与真人主体属于同一人物身份，但角色设计（发型 / 刘海 / 卷度 / 发色 / 脸型 / 眼型与瞳色 / 服装基底 / 配饰）只允许存在一套——由人物身份参考派生一次并冻结；次要动漫主体与全部动漫局部插图（相框头像 / 眼部特写 / 发型特写等）一律复用这同一套角色设计，各插图只做裁切 / 放大 / 局部展示，绝不各自重新动漫化、不重新设计发型刘海、不改变瞳色与脸型、不恢复模板原动漫人物的身份特征。用户修改风格（如"赛博朋克"）只改变各层的风格化表达，绝不把整图统一成单一媒介；只有硬性合同明确「统一媒介」时才允许。
6d. 区域替换（如果硬性合同包含区域）：区域合同列出的每个区域按其用途 / 替换对象 / 范围 / 约束执行，区域外画面严格保持画面模板。你无权取消任何已启用的区域。
7. positive_prompt 一律使用简体中文，输出为适合 gpt-image-2（GPT Image 系）执行的自然语言长句描述；禁止 Markdown 列表堆砌关键词，禁止中英双份。positive_prompt 只描述修改项（用户显式启用 / 手动开放的维度、人物身份与服装衔接）与必要的整体衔接语句；不得为锁定维度编写新的动作、朝向、镜头、构图、占比或百分比描述（模板分析没有的数字绝不发明）。
8. negative_prompt 用简体中文列出要避免的元素（含典型负面项：低画质、模糊、错误人体结构、多余手指、水印、文字等），并结合修改后的内容重新整理；无可避免项时输出空字符串。
9. summary 是一句话中文摘要，说明做了什么修改、保留了什么（例如"已根据调整要求将主体替换为蓝色小龙并增强梦幻氛围，保留手动锁定的背景、构图与光线"），用于任务提示与历史记录。
10. changed_dimensions 必须如实列出你本轮实际修改的维度 key（只能是 subject / clothing / pose / composition / camera / scene / lighting / style / color 中的若干个；没有修改就输出空数组）。
11. dimension_values 给出本轮修改后各维度的简短中文值（只包含 changed_dimensions 里的维度，每项一句话以内；例如 {"pose": "双手在胸前组成比心手势"}），供前端做修改对比展示。

输出格式（严格遵守）：只输出一个 JSON 对象，不要输出解释、前言或 Markdown 代码块。
{"positive_prompt": "最终生图 Prompt", "negative_prompt": "负面提示词", "summary": "一句话修改摘要", "changed_dimensions": ["pose"], "dimension_values": {"pose": "双手在胸前组成比心手势"}}`;

export interface VisionRecreationOptimizeResult {
  optimizedPrompt: string;
  optimizedNegativePrompt: string;
  summary: string;
  /** 本轮 AI 判定实际修改的维度（结构化修改意图；空数组 = 未修改任何维度）。 */
  changedDimensions: RecreationFieldKey[];
  /** 本轮修改后各维度值（维度 Diff 的「新」侧）。 */
  dimensionValues: Partial<Record<RecreationFieldKey, string>>;
  providerName: string;
  modelName: string;
  /** V4.1 Provenance：执行时模型快照（优化后换模型不影响历史任务展示）。 */
  optimizerModelId: string;
  optimizerProviderId: string;
  optimizerSource: AiModelSource;
  /** 显式回退时的原因与预期模型（source='fallback' 时必有）。 */
  optimizerFallbackReason?: string;
  optimizerRequestedModelId?: string;
  /** 本轮优化器是否真正收到了人物参考图内容（多模态模型才可能为 true）。 */
  optimizerReceivedPersonImage: boolean;
}

/** 复刻 Prompt 优化输入（统一「调整要求」链路，字段名与交互契约一致）。 */
export interface VisionRecreationOptimizeInput {
  /** 视觉理解编译出的原始复刻 Prompt。 */
  originalRecreationPrompt: string;
  /** 结构化复刻方案（含各维度锁定状态与锁定来源 lockSource）。 */
  structuredRecreationPlan: VisualRecreationPlan;
  /** 用户在统一输入框写的大白话调整要求。 */
  userAdjustmentInstruction: string;
  /** 目标图片模型信息（默认 gpt-image-2）。 */
  targetImageModelInfo?: string;
  /** 原始负面提示词（供优化器重新整理）。 */
  originalNegativePrompt?: string;
  /** 视觉页当前选择的模型（follow 链解析目标；缺失时用视觉档案默认）。 */
  visionPreferred?: { profileId?: string; modelId?: string };
  /** 人物替换参考图本地路径（优化器模型具备视觉能力时随消息真实传入）。 */
  personReferencePath?: string;
  /**
   * 图片引用（V4.0.9 双图角色语义）：模板图 / 人物图 / 其它 @引用，
   * 优化器模型具备视觉能力时按顺序以真实 image parts 附上（绝不只当文字）。
   */
  imageReferences?: ReadonlyArray<OptimizerImageReference>;
  /**
   * 用户显式启用的修改维度（快捷 Chip；V4.1 修「点了维度却没生效」）：
   * 这些维度在结构化方案行中标为「用户显式要求修改」——必须真实修改
   * 并列入 changed_dimensions，不受规则 2「禁止大面积放开」约束。
   */
  forcedDimensions?: ReadonlyArray<RecreationFieldKey>;
  /**
   * V4.1 硬性合同行（HARD CONTRACT）：人物替换决策 / 服装来源 / 区域 / 媒介结构 /
   * 模板保留等用户已确认的事实。系统提示词规则 0 明确这些值不可变更 ——
   * 优化器只负责表达，不负责重新决定。
   */
  hardContractLines?: ReadonlyArray<string>;
}

/** 优化器多模态图片引用（role 决定标注文案与模型使用方式）。 */
export interface OptimizerImageReference {
  path: string;
  label: string;
  role: 'template_reference' | 'person_replacement_reference' | 'source_reference' | 'generated_result_reference' | 'background_reference' | 'generic_reference';
}

/** 图片引用的角色标注（随消息图片清单行；模型按角色使用图片）。 */
export function describeOptimizerImageReference(role: OptimizerImageReference['role']): string {
  switch (role) {
    case 'template_reference':
    case 'source_reference':
      return '画面模板——延续其画风、视觉氛围、构图与背景关系（生成与该图同风格的新图）';
    case 'person_replacement_reference':
      return '人物身份参考（主体人物身份唯一主来源）——身份、脸部五官、脸型、发型、体型等人物特征一律以该图为准；画面模板图原人物的脸部身份不得保留；'
        + '该图的姿势、动作、身体朝向、观看角度、镜头、构图与背景一律不得采用（这些维度以画面模板图为准）';
    case 'generated_result_reference':
      return '当前任务生成结果——本任务此前生成的图片';
    case 'background_reference':
      return '背景参考——仅用于背景 / 环境参照';
    case 'generic_reference':
    default:
      return '参考图——按调整要求中的引用语境使用';
  }
}

/**
 * 汇总优化器图片引用：personReferencePath（旧参数）并入 imageReferences，
 * 按归一化路径去重（模板 → 人物 → 其它，顺序稳定；映射对 multimodal parts 成立）。
 */
export function collectOptimizerImageReferences(input: {
  personReferencePath?: string;
  imageReferences?: ReadonlyArray<OptimizerImageReference>;
}): OptimizerImageReference[] {
  const roleOrder: Record<OptimizerImageReference['role'], number> = {
    template_reference: 3,
    source_reference: 2,
    person_replacement_reference: 1,
    generated_result_reference: 0,
    background_reference: 0,
    generic_reference: 0,
  };
  const refs: OptimizerImageReference[] = [];
  if (input.personReferencePath?.trim()) {
    refs.push({ path: input.personReferencePath.trim(), label: '人物参考图', role: 'person_replacement_reference' });
  }
  for (const ref of input.imageReferences ?? []) {
    if (!ref.path?.trim()) continue;
    refs.push({ path: ref.path.trim(), label: ref.label, role: ref.role });
  }
  const seen = new Set<string>();
  return refs
    .filter(ref => {
      const key = ref.path.replace(/\\/g, '/').toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => roleOrder[b.role] - roleOrder[a.role]);
}

/** 图片引用清单文本块（多模态消息里的图片目录；顺序 = image parts 顺序）。 */
export function buildImageReferencesBlock(refs: ReadonlyArray<OptimizerImageReference>): string {
  if (refs.length === 0) return '';
  const lines = refs.map((ref, index) => `- 图片${index + 1}（@${ref.label}）：${describeOptimizerImageReference(ref.role)}`);
  return [
    `【随消息附上的图片引用】共 ${refs.length} 张，按下方清单顺序附在本消息末尾，请按各自角色使用：`,
    ...lines,
  ].join('\n');
}

/** 已知维度 key 集合（与 recreationPlan.RECREATION_FIELD_KEYS 同源；模块内字面量避免循环依赖）。 */
const KNOWN_DIMENSION_KEYS = new Set<string>(['subject', 'clothing', 'pose', 'composition', 'camera', 'scene', 'lighting', 'style', 'color']);

/** 解析 changed_dimensions（只接受已知维度 key；缺失 / 非数组 → 空数组）。 */
function parseChangedDimensions(raw: unknown): RecreationFieldKey[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is RecreationFieldKey => typeof item === 'string' && KNOWN_DIMENSION_KEYS.has(item));
}

/** 解析 dimension_values（只保留已知维度 key 的字符串值）。 */
function parseDimensionValues(raw: unknown): Partial<Record<RecreationFieldKey, string>> {
  if (typeof raw !== 'object' || raw === null) return {};
  const values: Partial<Record<RecreationFieldKey, string>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim() && KNOWN_DIMENSION_KEYS.has(key)) {
      values[key as RecreationFieldKey] = value.trim();
    }
  }
  return values;
}

/** 失败归因（决定用户态中文文案；技术细节只进开发态日志）。 */
export type VisionOptimizerErrorKind =
  | 'config_error'
  | 'provider_error'
  | 'empty_response'
  | 'parse_failed'
  | 'missing_instruction'
  | 'request_failed';

export type VisionRecreationOptimizeOutcome =
  | { ok: true; result: VisionRecreationOptimizeResult }
  | { ok: false; kind: VisionOptimizerErrorKind; error: string };

/** summary 缺省文案（模型未输出 summary 时的兜底，不让解析失败）。 */
const DEFAULT_OPTIMIZE_SUMMARY = '已根据调整要求重新优化最终生图 Prompt。';

/**
 * 解析视觉复刻优化输出（JSON 主协议）：
 * {"positive_prompt","negative_prompt","summary"}。
 * summary / negative 缺失不视为失败 —— 只要有可用的 positive_prompt 即通过
 * （历史缺陷：summary 必填导致模型省略 summary 时整次优化报
 * 「AI 未返回有效的优化结果」）。
 */
export function parseVisionOptimizerJson(
  reply: string,
): {
  prompt: string;
  negative?: string;
  summary?: string;
  changedDimensions: RecreationFieldKey[];
  dimensionValues: Partial<Record<RecreationFieldKey, string>>;
} | null {
  const record = extractBalancedJsonRecord(reply);
  if (!record) return null;
  const positive = typeof record.positive_prompt === 'string' ? record.positive_prompt.trim() : '';
  if (!positive) return null;
  const negative = typeof record.negative_prompt === 'string' ? record.negative_prompt.trim() : '';
  const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
  return {
    prompt: positive,
    negative: normalizeNegative(negative),
    summary: summary || undefined,
    changedDimensions: parseChangedDimensions(record.changed_dimensions),
    dimensionValues: parseDimensionValues(record.dimension_values),
  };
}

/** 摘要段标签：SUMMARY / 修改摘要 / 摘要（行首锚定） */
const SUMMARY_LABEL = /(?:^|\n)\s*(?:SUMMARY|修改摘要|摘要)\s*[:：]\s*/i;

/**
 * 多级兜底解析：JSON 主协议 → 文本标签协议（SUMMARY/NEGATIVE/OPTIMIZED）
 * → 整段视为优化结果。返回 null 仅当清洗后没有任何可用正文。
 */
export function parseVisionOptimizerReply(
  reply: string,
): {
  prompt: string;
  negative?: string;
  summary?: string;
  changedDimensions: RecreationFieldKey[];
  dimensionValues: Partial<Record<RecreationFieldKey, string>>;
} | null {
  const json = parseVisionOptimizerJson(reply);
  if (json) return json;

  const cleaned = cleanReply(reply);
  if (!cleaned) return null;

  // 摘要标签段先摘出（避免混入 prompt 正文）
  let summary: string | undefined;
  let body = cleaned;
  const summaryMatch = body.match(SUMMARY_LABEL);
  if (summaryMatch && summaryMatch.index !== undefined) {
    summary = body.slice(summaryMatch.index + summaryMatch[0].length).trim().split('\n')[0].trim();
    body = body.slice(0, summaryMatch.index);
  }

  const { body: withoutNegative, negative } = splitNegative(body);
  const labelMatch = withoutNegative.match(OPTIMIZED_LABEL);
  const prompt = (labelMatch && labelMatch.index !== undefined
    ? withoutNegative.slice(0, labelMatch.index) + withoutNegative.slice(labelMatch.index + labelMatch[0].length)
    : withoutNegative
  ).trim();
  if (prompt) {
    return { prompt, negative, summary: summary || undefined, changedDimensions: [], dimensionValues: {} };
  }
  return null;
}

/** 构建复刻优化 user 内容（纯函数，供测试锁定「用户手动锁定真正进入提示词」）。 */
export function buildVisionRecreationUserContent(input: VisionRecreationOptimizeInput): string {
  /**
   * 维度三档（Dimension Lock §11）：
   *  - 用户手动锁定（user_override+locked）＞ 模板锁定（未启用修改）＞ 可修改
   *    （用户显式启用 Chip / 手动开放）。模板锁定与用户手动锁定同级约束：
   *    优化器无权修改、不得列入 changed_dimensions、不得在 positive_prompt 重新描述。
   */
  const forced = new Set(input.forcedDimensions ?? []);
  const planLines = input.structuredRecreationPlan.fields
    .map(field => {
      let flag: string;
      if (field.lockSource === 'user_override') {
        flag = field.locked ? '用户手动锁定（最高优先级：必须保持不变）' : '用户手动开放（允许按调整要求修改）';
      } else if (forced.has(field.key)) {
        flag = '用户显式要求修改（必须真实修改该维度并列入 changed_dimensions；新值按调整要求自洽设计，绝不保持原值）';
      } else {
        flag = '模板锁定（未启用修改：保持模板基线不变；禁止修改、禁止列入 changed_dimensions、禁止在 positive_prompt 中重新描述该维度）';
      }
      return `- ${field.label}［${flag}］：${field.value || '（未识别）'}`;
    })
    .join('\n');
  const userLocked = input.structuredRecreationPlan.fields
    .filter(field => field.lockSource === 'user_override' && field.locked)
    .map(field => field.label);
  const lockedLines = userLocked.length ? userLocked.join('、') : '（无）';

  const hardLines = (input.hardContractLines ?? []).map(line => line.trim()).filter(Boolean);

  return [
    ...(hardLines.length > 0
      ? [
        '【硬性合同（不可变更——以下值是用户已确认的事实，规则 0：只能表达，不得推翻 / 省略 / 软化 / 重新决定）】',
        ...hardLines.map(line => `- ${line}`),
        '',
      ]
      : []),
    '【结构化复刻方案】',
    `参考图概述：${input.structuredRecreationPlan.summary}`,
    planLines,
    '',
    '【用户手动锁定项（最高优先级：必须保持不变；与调整要求冲突时优先保留，且不得列入 changed_dimensions）】',
    lockedLines,
    '',
    '【用户调整要求（大白话）】',
    input.userAdjustmentInstruction.trim(),
    '',
    '【原始复刻 Prompt】',
    input.originalRecreationPrompt,
    '',
    '【原始 Negative Prompt】',
    input.originalNegativePrompt?.trim() || '（无）',
    '',
    `目标图片模型：${input.targetImageModelInfo || 'gpt-image-2（GPT Image 系，自然语言长句偏好）'}`,
    '',
    '请基于以上信息重建最终生图 Prompt：只修改「用户显式要求修改」与「用户手动开放」的维度；',
    '标注「模板锁定」与「用户手动锁定」的维度保持基线不变（不列入 changed_dimensions、不在 positive_prompt 中重新描述）；',
    '并如实输出 changed_dimensions 与 dimension_values。',
  ].join('\n');
}

/** 开发态诊断日志：区分空响应 / 解析失败，附返回片段（生产构建不输出）。 */
function logVisionOptimizerFailure(kind: VisionOptimizerErrorKind, detail: unknown): void {
  if (!import.meta.env.DEV) return;
  console.warn(`[视觉复刻优化失败] kind=${kind}`, detail);
}

/**
 * 复刻方案 Prompt 重建：原始复刻 Prompt + 结构化方案 + 锁定项 + 用户调整要求
 * → 最终生图 Prompt。只在复刻方案处于 dirty 状态时调用（optimized 状态禁止重复优化）。
 *
 * 模型路由（V4.1）：role=vision_prompt_optimizer，默认跟随视觉理解模型 ——
 * 页面显示什么视觉模型，优化就用什么模型；视觉模型不可用时显式回退提示词优化
 * 模型（source='fallback' + 原因），绝不静默继承聊天默认模型。
 * 优化器模型具备视觉能力且存在人物替换参考图时，参考图以真实图片内容随消息传入
 * （多模态上下文）；纯文本模型只接收视觉分析产出的结构化描述。
 */
export async function optimizeVisionRecreation(
  input: VisionRecreationOptimizeInput,
): Promise<VisionRecreationOptimizeOutcome> {
  const resolution = resolveModelForRole('vision_prompt_optimizer', {
    visionPreferred: input.visionPreferred,
  });
  if (!resolution.ok || !resolution.connection) {
    return { ok: false, kind: 'config_error', error: resolution.ok ? '该功能没有可用的模型连接。' : resolution.error };
  }
  const byok: AiRoleConnection = resolution.connection;
  const resolved = resolution.resolved;
  recordAiRoleUsage(resolved);
  logAiTransport(resolved, 'vision-recreation');

  const instruction = input.userAdjustmentInstruction.trim();
  if (!instruction) {
    return {
      ok: false,
      kind: 'missing_instruction',
      error: '请先在「调整要求」输入框中描述你希望调整的内容。',
    };
  }

  const baseContent = buildVisionRecreationUserContent({ ...input, userAdjustmentInstruction: instruction });

  // 多模态判定只看 capabilities（禁止按模型名称猜）；unknown / 未声明视为纯文本。
  const optimizerSeesImages = (byok.modelEntity.capabilities ?? []).includes('vision');
  let userContent = baseContent;
  let messages: Array<Record<string, unknown>> = [{ role: 'user', content: userContent }];
  let receivedPersonImage = false;

  // 图片引用（模板图 + 人物图 + @引用）：优化器具备视觉能力时按清单顺序真实附上
  const imageRefs = collectOptimizerImageReferences({
    personReferencePath: input.personReferencePath,
    imageReferences: input.imageReferences,
  });
  if (optimizerSeesImages && imageRefs.length > 0) {
    const readResults: Array<{ ref: OptimizerImageReference; url?: string }> = [];
    for (const ref of imageRefs) {
      try {
        readResults.push({ ref, url: await api.readImageData(ref.path) });
      } catch (error) {
        // 单图读取失败不阻塞其余图片与文本优化（结构化描述仍可用）
        logVisionOptimizerFailure('request_failed', { stage: 'image_reference_read', path: ref.path, error });
      }
    }
    const kept = readResults.filter((entry): entry is { ref: OptimizerImageReference; url: string } => !!entry.url);
    if (kept.length > 0) {
      // 清单 ↔ parts 一一对应（读取失败的图不进清单，不占图片序号）
      const block = buildImageReferencesBlock(kept.map(entry => entry.ref));
      userContent = [baseContent, '', block].join('\n');
      messages = [{
        role: 'user',
        parts: [
          { part_type: 'text', text: userContent },
          ...kept.map(entry => ({ part_type: 'image_url', image_url: entry.url })),
        ],
      }];
      receivedPersonImage = kept.some(entry => entry.ref.role === 'person_replacement_reference');
    }
  }

  try {
    const runResult = await api.runAgentRequest({
      mode: 'chat',
      role: 'vision_prompt_optimizer',
      feature: 'vision-recreation',
      base_url: byok.baseUrl,
      token: byok.token,
      model: byok.model,
      billing_mode: byok.billingMode,
      system_prompt: VISION_RECREATION_SYSTEM_PROMPT,
      messages,
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
      return { ok: false, kind: 'provider_error', error: providerErrorCompact(providerError) };
    }

    const reply = runResult.reply || '';
    if (!reply.trim()) {
      logVisionOptimizerFailure('empty_response', { model: byok.model, replyLength: 0 });
      return {
        ok: false,
        kind: 'empty_response',
        error: '模型未返回可用结果，请重试。',
      };
    }

    const parsed = parseVisionOptimizerReply(reply);
    if (!parsed) {
      logVisionOptimizerFailure('parse_failed', {
        model: byok.model,
        replyLength: reply.length,
        replyHead: reply.slice(0, 200),
      });
      return {
        ok: false,
        kind: 'parse_failed',
        error: '返回结果格式异常，请稍后重试。',
      };
    }
    return {
      ok: true,
      result: {
        optimizedPrompt: parsed.prompt,
        optimizedNegativePrompt: parsed.negative ?? '',
        summary: parsed.summary || DEFAULT_OPTIMIZE_SUMMARY,
        changedDimensions: parsed.changedDimensions,
        dimensionValues: parsed.dimensionValues,
        providerName: byok.profileName,
        modelName: byok.modelEntity.display_name || byok.model,
        optimizerModelId: byok.model,
        optimizerProviderId: byok.profileId,
        optimizerSource: resolved.source,
        ...(resolved.fallbackReason ? { optimizerFallbackReason: resolved.fallbackReason } : {}),
        ...(resolved.requestedModelId ? { optimizerRequestedModelId: resolved.requestedModelId } : {}),
        optimizerReceivedPersonImage: receivedPersonImage,
      },
    };
  } catch (error: any) {
    logVisionOptimizerFailure('request_failed', error);
    return { ok: false, kind: 'request_failed', error: error?.message || '提示词优化请求失败，请重试。' };
  }
}
