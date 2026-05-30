import type { Settings } from '../types';

type AgentConfigInput = Pick<Settings, 'chat_token' | 'chat_model' | 'chat_base_url' | 'chat_system_prompt'> & Partial<Pick<Settings, 'agent_token' | 'agent_model' | 'agent_base_url' | 'agent_system_prompt'>>;

export type ResolvedAgentConfig = {
  token: string;
  model: string;
  baseUrl: string;
  systemPrompt: string;
  source: 'agent' | 'chat';
  hasOverrides: boolean;
  mismatch: boolean;
};

function clean(value?: string) {
  return (value || '').trim();
}

export function resolveAgentConfig(settings: AgentConfigInput): ResolvedAgentConfig {
  const agentToken = clean(settings.agent_token);
  const chatToken = clean(settings.chat_token);
  const agentModel = clean(settings.agent_model);
  const chatModel = clean(settings.chat_model);
  const agentBaseUrl = clean(settings.agent_base_url);
  const chatBaseUrl = clean(settings.chat_base_url);
  const agentSystemPrompt = clean(settings.agent_system_prompt);
  const chatSystemPrompt = clean(settings.chat_system_prompt);

  const source = agentToken || agentModel || agentBaseUrl || agentSystemPrompt ? 'agent' : 'chat';
  const token = agentToken || chatToken;
  const model = agentModel || chatModel;
  const baseUrl = (agentBaseUrl || chatBaseUrl).replace(/\/$/, '');
  const systemPrompt = agentSystemPrompt || chatSystemPrompt;

  return {
    token,
    model,
    baseUrl,
    systemPrompt,
    source,
    hasOverrides: Boolean(agentToken || agentModel || agentBaseUrl || agentSystemPrompt),
    mismatch: Boolean(
      agentModel && chatModel && agentModel !== chatModel
      || agentBaseUrl && chatBaseUrl && agentBaseUrl !== chatBaseUrl
      || agentToken && chatToken && agentToken !== chatToken
    ),
  };
}
