import { buildProviderError, providerErrorCompact } from '../features/aiProviders/providerError';
import { logAiTransport } from '../features/aiRouting/aiRoutingLog';
import { recordAiRoleUsage, resolveModelForRole, type AiRoleConnection } from '../features/aiRouting/resolveModelForRole';
import { api } from './api';

export interface VisualPromptImage {
  path: string;
  name: string;
  roleLabel?: string;
}

export interface VisualPromptOptimizeInput {
  prompt: string;
  images: VisualPromptImage[];
}

export interface VisualPromptUnderstanding {
  summary: string;
  preserve: string[];
  changes: string[];
  uncertainties: string[];
}

export interface VisualPromptOptimizeResult {
  optimizedPrompt: string;
  negativePrompt: string;
  understanding: VisualPromptUnderstanding;
  providerName: string;
  modelName: string;
}

export type VisualPromptOptimizeOutcome =
  | { ok: true; result: VisualPromptOptimizeResult }
  | { ok: false; error: string };

interface AgentRunResult {
  ok: boolean;
  reply?: string;
  error_kind?: string;
  error_message?: string;
  status?: number;
}

const VISUAL_PROMPT_SYSTEM = `你是 CyImagePro 的图生图提示词优化专家。你必须先查看随消息提供的真实参考图片，再结合用户的编辑需求，生成可执行的图片编辑提示词。

规则：
1. 图片1是主编辑图，必须作为主体、构图、空间关系与当前视觉事实的基线；图片2及之后是补充参考，只能提供用户需求相关的外观、产品、风格或细节参考。
2. 先区分“必须保留”和“明确修改”。用户没有要求改变的主体身份、构图、比例、镜头关系和重要物体不得擅自改动。
3. 用户需求与画面不一致时，不得假装画面中存在该元素；在 uncertainties 中指出，并给出保守、可执行的处理方式。
4. 不得仅根据文件名猜测内容，不得输出无法从图片或用户需求确认的品牌、人物身份、材质或规格。
5. positive_prompt 必须同时包含图片角色、保留约束、修改内容和最终画面描述；negative_prompt 只描述应避免的错误与漂移。
6. 全部内容使用简体中文。只输出 JSON 对象，不要输出 Markdown、解释或前言。

输出格式：
{"scene_summary":"画面理解摘要","preserve":["建议保留项"],"changes":["明确修改项"],"uncertainties":["不确定项或冲突提醒"],"positive_prompt":"完整正向提示词","negative_prompt":"完整负面提示词"}`;

function cleanReply(reply: string): string {
  return reply
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();
}

function extractJsonRecord(reply: string): Record<string, unknown> | null {
  const cleaned = cleanReply(reply);
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < cleaned.length; index++) {
    const char = cleaned[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) {
        try {
          const value = JSON.parse(cleaned.slice(start, index + 1));
          return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean).join('；');
  if (value && typeof value === 'object') return Object.values(value).map(normalizeText).filter(Boolean).join('；');
  return '';
}

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean);
  const text = normalizeText(value);
  return text ? text.split(/[；;\n]/).map(item => item.trim()).filter(Boolean) : [];
}

export function parseVisualPromptOptimizerReply(reply: string): Omit<VisualPromptOptimizeResult, 'providerName' | 'modelName'> | null {
  const record = extractJsonRecord(reply);
  if (!record) return null;
  const optimizedPrompt = normalizeText(record.positive_prompt);
  const summary = normalizeText(record.scene_summary);
  if (!optimizedPrompt || !summary) return null;
  return {
    optimizedPrompt,
    negativePrompt: normalizeText(record.negative_prompt),
    understanding: {
      summary,
      preserve: normalizeList(record.preserve),
      changes: normalizeList(record.changes),
      uncertainties: normalizeList(record.uncertainties),
    },
  };
}

function userContent(input: VisualPromptOptimizeInput): string {
  const roles = input.images.map((image, index) => `图片${index + 1}（${image.roleLabel || (index === 0 ? '主编辑图' : '补充参考图')}）：${image.name}`);
  return [
    '图片角色：',
    ...roles,
    '',
    '用户编辑需求：',
    input.prompt.trim(),
  ].join('\n');
}

async function runRequest(connection: AiRoleConnection, messages: Array<Record<string, unknown>>, feature: string): Promise<AgentRunResult> {
  return api.runAgentRequest({
    mode: 'chat',
    role: 'vision_analysis',
    feature,
    base_url: connection.baseUrl,
    token: connection.token,
    model: connection.model,
    billing_mode: connection.billingMode,
    system_prompt: VISUAL_PROMPT_SYSTEM,
    messages,
  }) as Promise<AgentRunResult>;
}

function providerFailure(connection: AiRoleConnection, result: AgentRunResult): string {
  return providerErrorCompact(buildProviderError({
    providerId: connection.profileId,
    providerType: connection.providerType,
    providerName: connection.profileName,
    billingMode: connection.billingMode,
    modelId: connection.model,
    failure: {
      ok: false,
      error_kind: result.error_kind,
      error_message: result.error_message,
      status: result.status,
    },
  }));
}

export function resolveVisualPromptOptimizerModelLabel(): string | null {
  const resolution = resolveModelForRole('vision_analysis');
  if (!resolution.ok) return null;
  return `${resolution.resolved.providerName} / ${resolution.resolved.displayName}`;
}

export async function optimizeVisualEditPrompt(input: VisualPromptOptimizeInput): Promise<VisualPromptOptimizeOutcome> {
  if (!input.prompt.trim()) return { ok: false, error: '请先填写图片编辑需求。' };
  if (input.images.length === 0) return { ok: false, error: '请先添加主编辑图。' };

  const resolution = resolveModelForRole('vision_analysis');
  if (!resolution.ok || !resolution.connection) {
    return { ok: false, error: resolution.ok ? '尚未选择视觉模型，请先在模型管理中配置。' : resolution.error };
  }
  const connection = resolution.connection;
  recordAiRoleUsage(resolution.resolved);
  logAiTransport(resolution.resolved, 'image-studio-visual-prompt-optimize');

  const imageParts: Array<Record<string, unknown>> = [];
  for (const image of input.images) {
    try {
      imageParts.push({ part_type: 'image_url', image_url: await api.readImageData(image.path) });
    } catch {
      return { ok: false, error: `无法读取参考图片「${image.name}」，请重新选择后再试。` };
    }
  }

  try {
    const first = await runRequest(connection, [{
      role: 'user',
      parts: [{ part_type: 'text', text: userContent(input) }, ...imageParts],
    }], 'image-studio-visual-prompt-optimize');
    if (!first.ok) return { ok: false, error: providerFailure(connection, first) };

    let parsed = parseVisualPromptOptimizerReply(first.reply || '');
    if (!parsed && first.reply?.trim()) {
      const repair = await runRequest(connection, [{
        role: 'user',
        parts: [
          { part_type: 'text', text: `请把下面内容修复为系统要求的 JSON 对象，只修复结构，不改变画面理解和编辑结论：\n\n${first.reply}` },
          ...imageParts,
        ],
      }], 'image-studio-visual-prompt-repair');
      if (repair.ok) parsed = parseVisualPromptOptimizerReply(repair.reply || '');
    }
    if (!parsed) {
      if (import.meta.env.DEV) console.warn('[VisualPromptOptimizer] structured response unavailable');
      return { ok: false, error: '图片理解没有完成，已保留当前编辑需求，可以重新尝试优化。' };
    }
    return {
      ok: true,
      result: {
        ...parsed,
        providerName: connection.profileName,
        modelName: connection.modelEntity.display_name || connection.model,
      },
    };
  } catch (error) {
    if (import.meta.env.DEV) console.warn('[VisualPromptOptimizer] request failed', error);
    return { ok: false, error: '图片理解没有完成，已保留当前编辑需求，可以重新尝试优化。' };
  }
}
