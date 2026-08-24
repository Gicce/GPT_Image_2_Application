/**
 * resolveModelForRole —— 所有 AI 功能获取模型的唯一入口（V4.1）。
 *
 * 铁律：Displayed model MUST equal resolved runtime model.
 * 页面 / 设置页显示的模型 = 本函数解析出的模型；只有显式 fallback（source='fallback'
 * + fallbackReason）才允许与用户预期模型不同。
 *
 * 来源语义：
 *  - manual：用户在「AI 模型使用」或既有模型设置中显式指定
 *  - follow：跟随另一项功能当前选择的模型（followedRole）
 *  - default：系统默认链（档案默认模型 / 会话解析兜底）
 *  - fallback：预期模型不可用时的显式回退（必须带 fallbackReason，UI 必须可见）
 */

import { useAIProviderStore, resolveConversationAgent, resolveByokVisionConfig } from '../aiProviders/store';
import { resolveProviderBaseUrl } from '../aiProviders/registry/registry';
import type { AIProviderModel, AIProviderProfile, AIProviderType, BillingMode, ModelUseScope } from '../aiProviders/types';
import type { AiModelRole, AiModelSource } from './modelRoles';
import { SERVER_IMAGE_GENERATION_MODEL, getAiRoleDefinition } from './modelRoles';
import { useAiModelRoutingStore } from './modelRoutingPolicy';

export interface ResolvedAiModel {
  role: AiModelRole;
  resolvedModelId: string;
  displayName: string;
  providerId: string;
  providerName: string;
  providerType?: AIProviderType;
  billingMode?: BillingMode;
  source: AiModelSource;
  followedRole?: AiModelRole;
  fallbackReason?: string;
  requestedModelId?: string;
  /** image_generation 等服务端固定模型无 BYOK 连接。 */
  serverSide?: boolean;
}

/** BYOK 连接参数（与 ByokAgentConfig ok 分支同形；vision 档案补齐 providerType）。 */
export interface AiRoleConnection {
  token: string;
  baseUrl: string;
  model: string;
  profileId: string;
  profileName: string;
  providerType: AIProviderType;
  billingMode?: BillingMode;
  modelEntity: AIProviderModel;
}

export type AiRoleResolution =
  | { ok: true; resolved: ResolvedAiModel; connection: AiRoleConnection | null }
  | { ok: false; error: string; resolved: ResolvedAiModel | null };

export interface AiRoleResolveContext {
  /** 会话上下文（assistant_chat / agent_planner 会话级选择）。 */
  conversation?: { id?: string; selected_agent_profile_id?: string; selected_agent_model_id?: string } | null;
  /** 视觉页当前选择的模型（vision_analysis 与 follow 链的页面临时选择）。 */
  visionPreferred?: { profileId?: string; modelId?: string };
}

const NO_MODEL_FOR_USE_ERRORS: Record<ModelUseScope, string> = {
  chat: '尚未配置 AI 对话模型。请前往「设置与更新 → AI 智能体」添加并启用一个模型服务。',
  planner: '尚未配置可用于任务规划的 AI 模型。请前往「设置与更新 → AI 智能体」启用模型服务的「任务规划」使用范围。',
  prompt_optimizer: '尚未配置可用于提示词优化的 AI 模型。请前往「设置与更新 → AI 智能体」启用模型服务的「提示词优化」使用范围。',
};

/** 文本调用能力（与 aiProviders store supportsTextUse 同语义：能力未声明不拦截）。 */
function supportsTextUse(model: AIProviderModel): boolean {
  const caps = model.capabilities ?? [];
  if (caps.length === 0 || caps.includes('unknown')) return true;
  const generationOnly =
    caps.includes('image_generation') || caps.includes('image_edit') || caps.includes('video_generation');
  return !(generationOnly && !caps.includes('text'));
}

/** 视觉能力（与 aiProviders store allowsVisionUse 同语义）。 */
function allowsVisionUse(model: AIProviderModel): boolean {
  const caps = model.capabilities ?? [];
  if (caps.length === 0 || caps.includes('unknown')) return true;
  return caps.includes('vision');
}

function modelAllowsRole(model: AIProviderModel, role: AiModelRole): boolean {
  const capability = getAiRoleDefinition(role).capability;
  if (capability === 'vision') return allowsVisionUse(model);
  if (capability === 'text') return supportsTextUse(model);
  return true;
}

function buildConnection(profile: AIProviderProfile, model: AIProviderModel): AiRoleConnection {
  const token = (profile.api_key || '').trim() || (profile.fallback_token || '').trim();
  return {
    token,
    baseUrl: resolveProviderBaseUrl(profile.provider_type, profile.billing_mode) || profile.base_url,
    model: model.model_id,
    profileId: profile.id,
    profileName: profile.name,
    providerType: profile.provider_type,
    ...(profile.billing_mode ? { billingMode: profile.billing_mode } : {}),
    modelEntity: model,
  };
}

function buildResolved(
  role: AiModelRole,
  profile: AIProviderProfile,
  model: AIProviderModel,
  source: AiModelSource,
  extra?: Partial<ResolvedAiModel>,
): ResolvedAiModel {
  return {
    role,
    resolvedModelId: model.model_id,
    displayName: model.display_name || model.model_id,
    providerId: profile.id,
    providerName: profile.name,
    providerType: profile.provider_type,
    billingMode: profile.billing_mode,
    source,
    ...extra,
  };
}

/** 按显式 manual 目标解析（profile + model 校验 + 能力守卫；失败返回错误）。 */
function resolveManualTarget(
  role: AiModelRole,
  profileId: string,
  modelId: string,
): { ok: true; profile: AIProviderProfile; model: AIProviderModel } | { ok: false; error: string } {
  const profiles = useAIProviderStore.getState().profiles;
  const profile = profiles.find(item => item.id === profileId);
  if (!profile || !profile.enabled) {
    return { ok: false, error: `指定的模型服务已不可用（档案不存在或已停用）。` };
  }
  const model = profile.models.find(item => item.model_id === modelId && item.enabled && item.lifecycle !== 'retired');
  if (!model) {
    return { ok: false, error: `模型 ${modelId} 已不可用（已删除、停用或已下线）。` };
  }
  if (!modelAllowsRole(model, role)) {
    const capability = getAiRoleDefinition(role).capability;
    return {
      ok: false,
      error: capability === 'vision'
        ? `模型 ${model.display_name || modelId} 不支持图片输入，不能用于该功能。`
        : `模型 ${model.display_name || modelId} 不支持文本调用，不能用于该功能。`,
    };
  }
  return { ok: true, profile, model };
}

/** agent 档案 scope 解析（复用 aiProviders store 唯一实现）。 */
function resolveAgentScope(
  use: ModelUseScope,
  conversationId?: string,
): { profile: AIProviderProfile; model: AIProviderModel; manual: boolean } | null {
  const store = useAIProviderStore.getState();
  const selection = store.resolveForUse(use, conversationId);
  if (!selection) return null;
  const perUseField = use === 'planner' ? selection.profile.planner_model_id : selection.profile.prompt_optimizer_model_id;
  return { ...selection, manual: !!perUseField && perUseField === selection.model.model_id };
}

/**
 * 唯一入口：按 role 解析当前应使用的模型。
 * 只读（不写任何 store）；记录「最近使用」由调用方在真实发起请求时执行 recordUsage。
 */
export function resolveModelForRole(role: AiModelRole, context?: AiRoleResolveContext): AiRoleResolution {
  if (role === 'image_generation') {
    return {
      ok: true,
      connection: null,
      resolved: {
        role,
        resolvedModelId: SERVER_IMAGE_GENERATION_MODEL.modelId,
        displayName: SERVER_IMAGE_GENERATION_MODEL.displayName,
        providerId: 'server',
        providerName: SERVER_IMAGE_GENERATION_MODEL.providerName,
        source: 'default',
        serverSide: true,
      },
    };
  }

  const routing = useAiModelRoutingStore.getState();
  routing.hydrate();
  const entry = routing.getEffectiveEntry(role);
  const ctx = context ?? {};

  // ===== 可 routing 配置的 role：manual 优先 =====
  if (entry.mode === 'manual' && entry.profileId && entry.modelId) {
    const target = resolveManualTarget(role, entry.profileId, entry.modelId);
    if (target.ok) {
      if (!buildConnection(target.profile, target.model).token) {
        return {
          ok: false,
          resolved: null,
          error: `模型服务「${target.profile.name}」尚未配置 API Key，请前往模型设置保存后再使用。`,
        };
      }
      return {
        ok: true,
        connection: buildConnection(target.profile, target.model),
        resolved: buildResolved(role, target.profile, target.model, 'manual', { requestedModelId: entry.modelId }),
      };
    }
    // manual 失效（模型删除 / 停用 / 能力不符）→ 显式回退到推荐链，绝不断链
    const fallbackChain = resolveRecommendedChain(role, ctx);
    if (fallbackChain.ok) {
      return {
        ...fallbackChain,
        resolved: {
          ...fallbackChain.resolved,
          requestedModelId: entry.modelId,
          source: 'fallback',
          fallbackReason: `原指定的模型已不可用：${target.error}`,
        },
      };
    }
    return fallbackChain;
  }

  return resolveRecommendedChain(role, ctx);
}

/**
 * 推荐链：follow 目标固定为 role 的 defaultFollow（设置页只提供推荐跟随，
 * 从架构上排除 follow 环）；无 defaultFollow 的 role 走系统默认链。
 */
function resolveRecommendedChain(role: AiModelRole, ctx: AiRoleResolveContext): AiRoleResolution {
  const followTarget = getAiRoleDefinition(role).defaultFollow;
  if (followTarget && followTarget !== role) {
    return resolveFollow(role, followTarget, ctx);
  }

  switch (role) {
    case 'assistant_chat': {
      const selection = resolveConversationAgent(ctx.conversation);
      if (!selection) {
        return { ok: false, resolved: null, error: NO_MODEL_FOR_USE_ERRORS.chat };
      }
      return {
        ok: true,
        connection: buildConnection(selection.profile, selection.model),
        resolved: buildResolved(role, selection.profile, selection.model, 'default'),
      };
    }
    case 'agent_planner': {
      const scoped = resolveAgentScope('planner', ctx.conversation?.id);
      if (!scoped) {
        return { ok: false, resolved: null, error: NO_MODEL_FOR_USE_ERRORS.planner };
      }
      return {
        ok: true,
        connection: buildConnection(scoped.profile, scoped.model),
        resolved: buildResolved(role, scoped.profile, scoped.model, scoped.manual ? 'manual' : 'default'),
      };
    }
    case 'image_prompt_optimizer': {
      const scoped = resolveAgentScope('prompt_optimizer');
      if (!scoped) {
        return { ok: false, resolved: null, error: NO_MODEL_FOR_USE_ERRORS.prompt_optimizer };
      }
      return {
        ok: true,
        connection: buildConnection(scoped.profile, scoped.model),
        resolved: buildResolved(role, scoped.profile, scoped.model, scoped.manual ? 'manual' : 'default'),
      };
    }
    case 'vision_analysis':
    case 'image_evaluation': {
      // 评价 / 视觉理解的默认链 = 视觉档案默认（评价不继承页面临时切换，与既有行为一致）
      const config = resolveByokVisionConfig(role === 'vision_analysis' ? ctx.visionPreferred : undefined);
      if (!config.ok) {
        return { ok: false, resolved: null, error: config.error };
      }
      const profile = useAIProviderStore.getState().profiles.find(item => item.id === config.profileId);
      return {
        ok: true,
        connection: {
          token: config.token,
          baseUrl: config.baseUrl,
          model: config.model,
          profileId: config.profileId,
          profileName: config.profileName,
          providerType: profile?.provider_type ?? 'openai_compatible',
          ...(profile?.billing_mode ? { billingMode: profile.billing_mode } : {}),
          modelEntity: config.modelEntity,
        },
        resolved: {
          role,
          resolvedModelId: config.model,
          displayName: config.modelEntity.display_name || config.model,
          providerId: config.profileId,
          providerName: config.profileName,
          providerType: profile?.provider_type,
          billingMode: profile?.billing_mode,
          source: role === 'vision_analysis' && ctx.visionPreferred?.profileId ? 'manual' : 'default',
        },
      };
    }
    case 'vision_prompt_optimizer':
    case 'batch_planner':
    case 'image_generation':
      // vision_prompt_optimizer / batch_planner 一定有 defaultFollow（modelRoles 定义），
      // 走不到这里；防御性返回配置缺失错误。
      return { ok: false, resolved: null, error: NO_MODEL_FOR_USE_ERRORS.prompt_optimizer };
  }
}

/** follow 解析：解析目标 role 的结果并标注 followedRole；目标失败时显式 fallback。 */
function resolveFollow(role: AiModelRole, target: AiModelRole, ctx: AiRoleResolveContext): AiRoleResolution {
  // 目标自身的 manual 配置优先于被 follow（resolveModelForRole 完整处理 manual + 失效回退）
  const upstream = resolveModelForRole(target, ctx);
  if (upstream.ok) {
    return {
      ok: true,
      connection: upstream.connection,
      resolved: { ...upstream.resolved, role, source: 'follow', followedRole: target },
    };
  }

  // follow 目标不可用 → 仅文本任务显式回退到提示词优化模型（禁止静默换模型）。
  // image_evaluation 需要真实图片输入，跨类别回退到文本模型必然失败 → 如实报错。
  if (role === 'vision_prompt_optimizer') {
    const fallback = resolveAgentScope('prompt_optimizer');
    if (fallback) {
      return {
        ok: true,
        connection: buildConnection(fallback.profile, fallback.model),
        resolved: buildResolved(role, fallback.profile, fallback.model, 'fallback', {
          followedRole: target,
          fallbackReason: upstream.error,
        }),
      };
    }
    return {
      ok: false,
      resolved: null,
      error: `${upstream.error}（回退到提示词优化模型也失败：${NO_MODEL_FOR_USE_ERRORS.prompt_optimizer}）`,
    };
  }
  return { ok: false, resolved: null, error: upstream.error };
}

/** 供调用方在真实发起 AI 请求时记录「最近使用」（进程内，不持久化）。 */
export function recordAiRoleUsage(resolved: ResolvedAiModel): void {
  useAiModelRoutingStore.getState().recordUsage({
    role: resolved.role,
    modelId: resolved.resolvedModelId,
    displayName: resolved.displayName,
    providerName: resolved.providerName,
    at: new Date().toISOString(),
  });
}
