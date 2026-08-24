/**
 * BatchPlannerService —— 批量生成方案规划（AI Planner）。
 *
 * 输入：一个总需求 + 目标数量 → 输出：N 个结构化 GenerationPlan（title/summary/
 * tags/description/positive_prompt/negative_prompt 全部由 AI 正式产出，
 * 绝不靠前端截断 Prompt 拼凑）。
 *
 * 模型来源与 promptOptimizer 相同：resolveByokConfigForUse('prompt_optimizer')
 * （用户自己配置的 GLM / DeepSeek / 第三方 API），不新建第二套配置。
 *
 * 三种调用（每次只影响目标方案，绝不动其他方案）：
 *  - planBatchFromRequirement：总需求 → N 个不同方案（数量严格校验）
 *  - appendAiPlan：参考已有方案，补充 1 个不重复的新方案
 *  - optimizeSinglePlan：以方案描述为核心输入，重新生成该方案的完整结构化内容
 */

import { api } from './api';
import { buildProviderError, providerErrorCompact } from '../features/aiProviders/providerError';
import { resolveModelForRole, recordAiRoleUsage, type AiRoleConnection } from '../features/aiRouting/resolveModelForRole';
import { logAiTransport } from '../features/aiRouting/aiRoutingLog';
import { cleanReply } from './promptOptimizer';
import { MAX_PLAN_TAGS } from '../utils/batchPlans';

type ResolvedOptimizer = AiRoleConnection;

export interface ParsedAiPlan {
  title: string;
  summary: string;
  tags: string[];
  description: string;
  positivePrompt: string;
  negativePrompt: string;
}

export interface BatchPlannerModelInfo {
  providerName: string;
  modelName: string;
}

export type BatchPlannerOutcome =
  | { ok: true; plans: ParsedAiPlan[] } & BatchPlannerModelInfo
  | { ok: false; error: string };

const JSON_SHAPE_HINT = '{"plans":[{"title":"…","summary":"…","tags":["…"],"description":"…","positive_prompt":"…","negative_prompt":"…"}]}';

const PLAN_STRUCTURE_RULES = `每个方案对象包含：
- title：6～18 个中文字符的抓重点标题（核心造型 / 关键道具 / 场景，用「·」分隔，例如「红黑重甲 · 长枪 · 古城墙」），一眼可区分不同方案
- summary：40～80 个中文字符的简洁摘要，按「主体 → 服装/造型 → 武器/道具 → 动作/姿势 → 场景 → 构图 → 风格 → 光影/氛围」的优先级抓重点
- tags：4～6 个重点标签，语义互补不重复（禁止「战国」「战国时期」「战国女将」这类同义堆叠）
- description：完整方案描述（中文，说明该方案具体要画什么）
- positive_prompt：该方案的专业完整正向提示词（简体中文，例如「一名银蓝色长发的年轻动漫风战士，……，高质量动漫插画」）
- negative_prompt：该方案的负面提示词（简体中文，通用负面项即可，例如「低画质，模糊，错误人体结构，多余手指，水印，文字」，可为空字符串）`;

const PLAN_SYSTEM_PROMPT = `你是 CyImagePro 的批量生成方案规划专家。用户给出一个总需求和目标数量，你负责把它规划成指定数量的、明显不同的生成方案（每个方案 = 一张独立图片）。

职责（不是重复用户需求）：
1. 理解用户批量图像需求的共同主题与风格
2. 拆成指定数量的视觉方案，不同方案必须在「主体姿态、服装造型、主要颜色、武器/道具、场景、构图、镜头距离、光影、氛围、动作」等维度有明显差异
3. ${PLAN_STRUCTURE_RULES}

规则：
- plans 数组长度必须严格等于用户指定的数量，不多、不少
- 禁止把总需求重复 N 次；禁止三联画/拼图/分屏/宫格语义——每个方案都是一张独立成图
- title / summary / tags / description / positive_prompt / negative_prompt 全部使用简体中文；禁止自动翻译成英文（用户输入英文时输出仍为简体中文）；禁止中英双份输出
- 保持所有方案与总需求的共同主题、风格一致，只替换差异维度

输出格式（严格遵守）：只输出一个 JSON 对象，不要输出解释、前言或 Markdown 代码块。
${JSON_SHAPE_HINT}`;

const APPEND_SYSTEM_PROMPT = `你是 CyImagePro 的批量生成方案规划专家。用户已有一批生成方案，需要你补充 1 个新的生成方案。

要求：
1. 只输出 1 个新方案，plans 数组长度必须为 1
2. 新方案必须与已有方案明显不同：优先使用已有方案未覆盖的武器/道具、姿态、镜头、环境、颜色、场景
3. 保持与用户总需求的共同主题、风格一致
4. ${PLAN_STRUCTURE_RULES}

输出格式（严格遵守）：只输出一个 JSON 对象，不要输出解释、前言或 Markdown 代码块。
${JSON_SHAPE_HINT}`;

const OPTIMIZE_SYSTEM_PROMPT = `你是 CyImagePro 的批量生成方案优化专家。用户会给出总需求和一个方案描述（可能已被用户手动修改），你负责只针对这一个方案重新生成完整的结构化内容。

要求：
1. 严格基于该方案的描述生成本方案内容，不得扩展成多个方案，plans 数组长度必须为 1
2. ${PLAN_STRUCTURE_RULES}
3. title / summary / tags / description 一律中文，且必须与方案描述一致（描述改成白甲弓箭，标题就不能再写红甲长枪）
4. positive_prompt / negative_prompt 一律简体中文，禁止自动翻译成英文，禁止中英双份输出

输出格式（严格遵守）：只输出一个 JSON 对象，不要输出解释、前言或 Markdown 代码块。
${JSON_SHAPE_HINT}`;

interface AgentRunResult {
  ok: boolean;
  reply?: string;
  error_kind?: string;
  error_message?: string;
  status?: number;
}

/** 归一化单条 AI 方案；缺正向提示词的条目视为无效（返回 null）。 */
function normalizePlan(raw: unknown): ParsedAiPlan | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const positivePrompt = typeof record.positive_prompt === 'string' ? record.positive_prompt.trim() : '';
  if (!positivePrompt) return null;

  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  let negativePrompt = str(record.negative_prompt);
  if (negativePrompt === '无' || negativePrompt.toUpperCase() === 'NONE') negativePrompt = '';

  const tags: string[] = [];
  if (Array.isArray(record.tags)) {
    const seen = new Set<string>();
    for (const tag of record.tags) {
      if (typeof tag !== 'string') continue;
      const value = tag.trim().slice(0, 12);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      tags.push(value);
      if (tags.length >= MAX_PLAN_TAGS) break;
    }
  }

  return {
    title: str(record.title).slice(0, 40),
    summary: str(record.summary),
    tags,
    description: str(record.description),
    positivePrompt,
    negativePrompt,
  };
}

/**
 * 从模型回复中提取 {"plans":[...]} JSON：
 * 剥离 <think> 与代码栅栏（复用 promptOptimizer 的 cleanReply），
 * 花括号配平截取，字段归一化。解析失败返回 null。
 */
export function parsePlannerReply(reply: string): { plans: ParsedAiPlan[] } | null {
  const cleaned = cleanReply(reply);
  const start = cleaned.indexOf('{');
  if (start === -1) return null;

  let candidate = '';
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
  const rawPlans = Array.isArray(record.plans) ? record.plans : null;
  if (!rawPlans) return null;
  const plans = rawPlans.map(normalizePlan).filter((p): p is ParsedAiPlan => p !== null);
  if (plans.length === 0) return null;
  return { plans };
}

function taskTypeLabel(taskType: 'generate' | 'edit'): string {
  return taskType === 'edit' ? '图生图（图片编辑，方案基于用户提供的参考图片）' : '文生图';
}

interface RunPlannerArgs {
  systemPrompt: string;
  userContent: string;
}

/** 调用批量规划模型（role=batch_planner，默认跟随图片 Prompt 优化模型）；传输失败归因 ProviderError。 */
async function runPlanner(byok: ResolvedOptimizer, args: RunPlannerArgs): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
  try {
    const runResult = await api.runAgentRequest({
      mode: 'chat',
      role: 'batch_planner',
      feature: 'image-studio-batch-plan',
      base_url: byok.baseUrl,
      token: byok.token,
      model: byok.model,
      billing_mode: byok.billingMode,
      system_prompt: args.systemPrompt,
      messages: [{ role: 'user', content: args.userContent }],
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
    return { ok: true, reply: runResult.reply || '' };
  } catch (error: any) {
    return { ok: false, error: error?.message || 'AI 方案规划请求失败，请重试。' };
  }
}

function resolveOptimizerOrError() {
  const resolution = resolveModelForRole('batch_planner');
  if (!resolution.ok || !resolution.connection) {
    return { ok: false as const, error: resolution.ok ? '该功能没有可用的模型连接。' : resolution.error };
  }
  recordAiRoleUsage(resolution.resolved);
  logAiTransport(resolution.resolved, 'image-studio-batch-plan');
  return { ok: true as const, byok: resolution.connection };
}

/**
 * 总需求 → N 个方案。数量校验：plans.length 必须严格等于 requestedCount；
 * 解析失败或数量不符时自动重试 1 次，仍失败则报错（绝不静默接受错误数量）。
 */
export async function planBatchFromRequirement(input: {
  requirement: string;
  requestedCount: number;
  taskType: 'generate' | 'edit';
}): Promise<BatchPlannerOutcome> {
  const resolved = resolveOptimizerOrError();
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { byok } = resolved;

  const userContent = [
    `任务类型：${taskTypeLabel(input.taskType)}`,
    `方案数量：${input.requestedCount}（plans 数组必须严格等于 ${input.requestedCount} 个）`,
    '',
    '总需求：',
    input.requirement.trim(),
  ].join('\n');

  let lastError = 'AI 未返回有效的方案规划结果，请重试。';
  for (let attempt = 0; attempt < 2; attempt++) {
    const run = await runPlanner(byok, { systemPrompt: PLAN_SYSTEM_PROMPT, userContent });
    if (!run.ok) return { ok: false, error: run.error };
    const parsed = parsePlannerReply(run.reply);
    if (parsed) {
      if (parsed.plans.length === input.requestedCount) {
        return { ok: true, plans: parsed.plans, providerName: byok.profileName, modelName: byok.modelEntity.display_name || byok.model };
      }
      lastError = `AI 规划数量异常（期望 ${input.requestedCount} 个方案，实际返回 ${parsed.plans.length} 个），请重新规划。`;
      continue;
    }
    lastError = 'AI 未按结构化格式返回方案规划，请重试。';
  }
  return { ok: false, error: lastError };
}

/** 参考已有方案补充 1 个不重复的新方案。 */
export async function appendAiPlan(input: {
  requirement: string;
  existingPlans: Array<{ title: string; summary: string; description: string }>;
  taskType: 'generate' | 'edit';
}): Promise<BatchPlannerOutcome> {
  const resolved = resolveOptimizerOrError();
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { byok } = resolved;

  const existingLines = input.existingPlans.length > 0
    ? input.existingPlans.map((plan, i) => `${i + 1}. ${plan.title || '（无标题）'}｜${plan.summary || plan.description}`).join('\n')
    : '（暂无已有方案）';

  const userContent = [
    `任务类型：${taskTypeLabel(input.taskType)}`,
    '补充要求：再生成 1 个与已有方案明显不同的新方案（plans 数组长度必须为 1）',
    '',
    '总需求：',
    input.requirement.trim(),
    '',
    '已有方案（新方案禁止与这些重复武器/道具/场景/姿态/颜色组合）：',
    existingLines,
  ].join('\n');

  let lastError = 'AI 未返回有效的新方案，请重试。';
  for (let attempt = 0; attempt < 2; attempt++) {
    const run = await runPlanner(byok, { systemPrompt: APPEND_SYSTEM_PROMPT, userContent });
    if (!run.ok) return { ok: false, error: run.error };
    const parsed = parsePlannerReply(run.reply);
    if (parsed && parsed.plans.length === 1) {
      return { ok: true, plans: parsed.plans, providerName: byok.profileName, modelName: byok.modelEntity.display_name || byok.model };
    }
    lastError = 'AI 未按结构化格式返回新方案，请重试。';
  }
  return { ok: false, error: lastError };
}

/** 单个方案重新优化：以方案描述为核心输入，重新生成完整结构化内容（不影响其他方案）。 */
export async function optimizeSinglePlan(input: {
  originalRequirement: string;
  planTitle: string;
  planDescription: string;
  taskType: 'generate' | 'edit';
}): Promise<BatchPlannerOutcome> {
  const resolved = resolveOptimizerOrError();
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { byok } = resolved;

  const userContent = [
    `任务类型：${taskTypeLabel(input.taskType)}`,
    '',
    '总需求（保持共同主题一致）：',
    input.originalRequirement.trim(),
    '',
    '当前方案描述（以此为核心输入，可能已被用户手动修改）：',
    input.planDescription.trim() || input.planTitle.trim(),
  ].join('\n');

  let lastError = 'AI 未返回有效的优化结果，已保留原方案。';
  for (let attempt = 0; attempt < 2; attempt++) {
    const run = await runPlanner(byok, { systemPrompt: OPTIMIZE_SYSTEM_PROMPT, userContent });
    if (!run.ok) return { ok: false, error: run.error };
    const parsed = parsePlannerReply(run.reply);
    if (parsed && parsed.plans.length === 1) {
      return { ok: true, plans: parsed.plans, providerName: byok.profileName, modelName: byok.modelEntity.display_name || byok.model };
    }
    lastError = 'AI 未按结构化格式返回优化结果，已保留原方案，请重试。';
  }
  return { ok: false, error: lastError };
}
