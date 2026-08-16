/**
 * Agent System Prompt AI Builder。
 * 与普通聊天 Prompt 严格隔离：独立的 Builder System Instruction，
 * 生成「候选版本」，绝不直接覆盖用户当前 Prompt。
 */
import { api } from '../../services/api';
import type { AIProviderProfile, AIProviderModel } from './types';
import { profileToken, resolveProfileBaseUrl } from './adapters';
import { normalizeBaseUrl } from './migration';
import { buildProviderError, providerErrorCompact } from './providerError';

export const PROMPT_BUILDER_INSTRUCTION = `你是 CyImagePro 的 Agent Prompt 设计助手。你的任务是根据用户的自然语言描述，为 AI 智能体撰写一份结构化的 System Prompt。

要求：
1. 输出使用简体中文，直接给出最终 System Prompt 正文，不要附加解释、前言或 Markdown 代码块。
2. System Prompt 应包含以下结构（用简短小标题或自然段落组织，避免过度格式化）：
   - 角色：一句话定义该智能体的身份
   - 职责：它做什么、不做什么
   - 工作流程：接到用户请求后的处理步骤
   - 提问方式：信息不足时如何向用户澄清
   - 回复风格：语气、长度、用词偏好
   - 边界与安全：明确超出能力时应如何回应
   - 输出结构：默认回复的排版方式
   - 异常场景：无法理解请求、用户输入矛盾时的处理
3. 如果提供了「现有 Prompt」和「修改要求」：必须保留现有 Prompt 的全部核心设定，仅应用修改要求，不得丢失原有内容。
4. 对于医疗、法律、金融等专业领域角色：定位为辅助分析与信息整理，明确提示涉及诊断、处方、诉讼、投资决策等关键事项时应建议咨询持证专业人员，不得声称拥有最终决定权。
5. Prompt 只描述对话行为（语气、角色、理解偏好、回答风格、领域行为），不得包含任务执行、图像生成、系统规划相关的技术指令。`;

export interface PromptBuilderInput {
  profile: Pick<AIProviderProfile, 'id' | 'name' | 'provider_type' | 'base_url' | 'billing_mode' | 'api_key' | 'fallback_token'>;
  model: Pick<AIProviderModel, 'model_id'>;
  /** 用户对 Agent 的自然语言描述（创建），或对现有 Prompt 的修改要求（优化） */
  instruction: string;
  /** 优化模式下现有的 System Prompt */
  currentPrompt?: string;
  agentName?: string;
}

export interface PromptBuilderOutput {
  ok: boolean;
  prompt?: string;
  errorMessage?: string;
  errorCode?: string;
}

/**
 * 生成候选 System Prompt。
 * revision 由调用方维护（自增）：响应携带发起时的 revision，过期响应由调用方丢弃。
 */
export async function buildAgentPrompt(input: PromptBuilderInput): Promise<PromptBuilderOutput> {
  const token = profileToken(input.profile);
  const baseUrl = normalizeBaseUrl(resolveProfileBaseUrl(input.profile));
  if (!token || !baseUrl || !input.model.model_id) {
    return { ok: false, errorCode: 'missing_api_key', errorMessage: '请先保存 API Key 并选择聊天模型后再使用 AI 生成。' };
  }

  const userContent = [
    input.agentName ? `智能体名称：${input.agentName}` : '',
    input.currentPrompt
      ? `现有 Prompt：\n"""\n${input.currentPrompt}\n"""\n\n修改要求：${input.instruction}`
      : `用户对智能体的描述：${input.instruction}`,
  ].filter(Boolean).join('\n');

  try {
    const result = await api.runAgentRequest({
      mode: 'chat',
      base_url: baseUrl,
      token,
      model: input.model.model_id,
      billing_mode: input.profile.billing_mode,
      system_prompt: PROMPT_BUILDER_INSTRUCTION,
      messages: [{ role: 'user', content: userContent }],
    }) as { ok?: boolean; reply?: string; error_message?: string; error_kind?: string; status?: number };

    if (!result?.ok) {
      const providerError = buildProviderError({
        providerId: input.profile.id ?? '',
        providerType: input.profile.provider_type,
        providerName: input.profile.name,
        billingMode: input.profile.billing_mode,
        modelId: input.model.model_id,
        failure: {
          ok: false,
          error_kind: result?.error_kind,
          error_message: result?.error_message,
          status: result?.status,
        },
      });
      return {
        ok: false,
        errorMessage: providerErrorCompact(providerError),
        errorCode: providerError.code,
      };
    }
    const prompt = (result.reply || '').trim()
      .replace(/^```[a-zA-Z]*\n?/, '')
      .replace(/```$/, '')
      .trim();
    if (!prompt) {
      return { ok: false, errorMessage: '模型未返回有效内容，请重试。' };
    }
    return { ok: true, prompt };
  } catch (error) {
    return { ok: false, errorMessage: (error as Error)?.message || '网络错误，AI 生成失败。' };
  }
}
