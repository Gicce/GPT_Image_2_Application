import { buildProviderError, providerErrorCompact } from '../features/aiProviders/providerError';
import { logAiTransport } from '../features/aiRouting/aiRoutingLog';
import { recordAiRoleUsage, resolveModelForRole, type AiRoleConnection } from '../features/aiRouting/resolveModelForRole';
import type { AssetRole, SkillProfile } from '../features/skillWorkshop/types';
import type { UserSkillDraft } from '../features/skillWorkshop/userSkill';
import { api } from './api';

export interface SkillAuthoringCandidate {
  summary: string;
  applicableScenarios: string[];
  unsuitableScenarios: string[];
  coreRules: string[];
  profiles: SkillProfile[];
  wizardSteps: UserSkillDraft['wizardSteps'];
  assetRoles: AssetRole[];
  negativeRules: string[];
  blockers: string[];
  reviewRubric: string[];
}

export type SkillAuthoringOutcome =
  | { ok: true; candidate: SkillAuthoringCandidate; modelId: string; providerName: string }
  | { ok: false; error: string };

const SYSTEM_PROMPT = `你是 CyImagePro 的 Skill 通用化整理器。你的任务是把一次具体视觉项目抽象成可重复使用的图片创作 Skill。

硬性规则：
1. 【来源事实】是只读事实，只能抽象表达，不得推翻、删除或虚构项目不存在的能力。
2. 必须把具体人物、文件名、路径、房间、商品和一次性描述改写为“用户上传的人物/产品/空间/风格参考”等素材槽位。
3. 不得输出本地路径、网址、API Key、Token、真实身份、品牌秘钥或第三方 IP 名称。
4. Core Rules 只放跨任务都必须遵守的专业规则；可变化内容进入 Profile 或向导字段。
5. 输出必须适合新手理解，使用简体中文。只输出 JSON 对象，不要 Markdown 或前言。

JSON 格式：
{"summary":"简介","applicable_scenarios":["适用场景"],"unsuitable_scenarios":["不适用场景"],"core_rules":["硬规则"],"profiles":[{"id":"lower-kebab","name":"名称","kind":"base|style|theme|platform","prompt":"规则"}],"wizard_steps":[{"id":"lower-kebab","name":"步骤名","required":true,"helper":"说明"}],"asset_roles":["brand_logo|product|person|space|device|background_reference|style_reference"],"negative_rules":["禁止项"],"blockers":["生成前阻断条件"],"review_rubric":["质检维度"]}`;

const VALID_ROLES = new Set<AssetRole>(['brand_logo', 'product', 'person', 'space', 'device', 'background_reference', 'style_reference']);
const VALID_KINDS = new Set<SkillProfile['kind']>(['base', 'style', 'theme', 'platform']);

function cleanReply(reply: string): string {
  return reply.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
}

function jsonRecord(reply: string): Record<string, unknown> | null {
  const cleaned = cleanReply(reply);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('；');
  return '';
}

function list(value: unknown): string[] {
  if (!Array.isArray(value)) return text(value).split(/[；;\n]/).map(item => item.trim()).filter(Boolean);
  return value.map(text).filter(Boolean);
}

function slug(value: unknown, fallback: string): string {
  const normalized = text(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return normalized || fallback;
}

export function parseSkillAuthoringReply(reply: string): SkillAuthoringCandidate | null {
  const raw = jsonRecord(reply);
  if (!raw) return null;
  const profiles = Array.isArray(raw.profiles) ? raw.profiles.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const kind = text(row.kind) as SkillProfile['kind'];
    const prompt = text(row.prompt);
    if (!VALID_KINDS.has(kind) || !prompt) return [];
    return [{ id: slug(row.id, `profile-${index + 1}`), name: text(row.name) || `配置 ${index + 1}`, kind, prompt }];
  }) : [];
  const wizardSteps = Array.isArray(raw.wizard_steps) ? raw.wizard_steps.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    return [{ id: slug(row.id, `step-${index + 1}`), name: text(row.name) || `步骤 ${index + 1}`, required: row.required !== false, helper: text(row.helper) }];
  }) : [];
  const assetRoles = list(raw.asset_roles).filter((role): role is AssetRole => VALID_ROLES.has(role as AssetRole));
  const candidate = {
    summary: text(raw.summary), applicableScenarios: list(raw.applicable_scenarios), unsuitableScenarios: list(raw.unsuitable_scenarios),
    coreRules: list(raw.core_rules), profiles, wizardSteps, assetRoles,
    negativeRules: list(raw.negative_rules), blockers: list(raw.blockers), reviewRubric: list(raw.review_rubric),
  };
  if (!candidate.summary || candidate.coreRules.length === 0 || !candidate.profiles.some(profile => profile.kind === 'base') || candidate.wizardSteps.length === 0) return null;
  return candidate;
}

function buildInput(draft: UserSkillDraft): string {
  return [
    `Skill 名称：${draft.name}`,
    `领域：${draft.domain}`,
    '【来源事实（不可篡改）】',
    ...draft.sourceFacts.map(fact => `- ${fact.label}：${fact.value}`),
    '【当前项目模板草稿】',
    `简介：${draft.summary}`,
    `规则：${draft.coreRules.join('；')}`,
    `素材角色：${draft.assetRoles.join('、') || '无'}`,
    `负面限制：${draft.negativeRules.join('；') || '无'}`,
    '请将其整理成能适用于不同用户素材和新需求的通用 Skill。',
  ].join('\n');
}

async function request(connection: AiRoleConnection, content: string, feature: string) {
  return api.runAgentRequest({
    mode: 'chat', role: 'skill_authoring', feature,
    base_url: connection.baseUrl, token: connection.token, model: connection.model,
    billing_mode: connection.billingMode, system_prompt: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  }) as Promise<{ ok: boolean; reply?: string; error_kind?: string; error_message?: string; status?: number }>;
}

export function resolveSkillAuthoringModelLabel(): string | null {
  const resolution = resolveModelForRole('skill_authoring');
  return resolution.ok ? `${resolution.resolved.providerName} / ${resolution.resolved.displayName}` : null;
}

export async function authorUserSkill(draft: UserSkillDraft): Promise<SkillAuthoringOutcome> {
  const resolution = resolveModelForRole('skill_authoring');
  if (!resolution.ok || !resolution.connection) return { ok: false, error: resolution.ok ? '尚未配置可用的 Skill 通用化模型。' : resolution.error };
  const connection = resolution.connection;
  recordAiRoleUsage(resolution.resolved);
  logAiTransport(resolution.resolved, 'skill-authoring');
  try {
    const first = await request(connection, buildInput(draft), 'skill-authoring');
    if (!first.ok) {
      return { ok: false, error: providerErrorCompact(buildProviderError({
        providerId: connection.profileId, providerType: connection.providerType, providerName: connection.profileName,
        billingMode: connection.billingMode, modelId: connection.model,
        failure: { ok: false, error_kind: first.error_kind, error_message: first.error_message, status: first.status },
      })) };
    }
    let candidate = parseSkillAuthoringReply(first.reply || '');
    if (!candidate && first.reply?.trim()) {
      const repaired = await request(connection, `请只修复下面内容的结构，使其符合要求的 JSON；不要改变来源事实或规则结论：\n\n${first.reply}`, 'skill-authoring-repair');
      if (repaired.ok) candidate = parseSkillAuthoringReply(repaired.reply || '');
    }
    if (!candidate) return { ok: false, error: 'Skill 通用化没有完成，已保留当前草稿，可以重新尝试。' };
    return { ok: true, candidate, modelId: resolution.resolved.resolvedModelId, providerName: resolution.resolved.providerName };
  } catch (error) {
    if (import.meta.env.DEV) console.warn('[SkillAuthoring] request failed', error);
    return { ok: false, error: 'Skill 通用化没有完成，已保留当前草稿，可以重新尝试。' };
  }
}
