/**
 * AgentTurnResult —— 一次 Agent 回复的统一回合类型。
 *
 * 任何 assistant 消息（新链路 task_message / 旧链路 agent_proposal / 普通聊天）
 * 都必须能归入以下五类之一。渲染层与历史卫生层共用此判定，避免各处
 * 重复推断「这条消息是什么」：
 *   - chat:             普通聊天回复（唯一允许回放进模型历史的回合类型）
 *   - task_proposal:    任务提案（TaskProposal Card 承载，不展示 Planner 长正文）
 *   - clarification:    规划澄清（需要用户补充信息）
 *   - execution_update: 任务执行状态卡（等待执行 / 正在生成 / 完成 / 失败…）
 *   - error:            错误 / 配置警告
 */

import type { ChatMessage, TaskStage } from '../../types';

export type AgentTurnKind = 'chat' | 'task_proposal' | 'clarification' | 'execution_update' | 'error';

export interface AgentTurnResult {
  kind: AgentTurnKind;
  /** 该回合是否为产品 UI 生成的合成消息（绝不回放进模型历史） */
  synthetic: boolean;
  stage?: TaskStage;
}

export interface AgentTurnLike {
  role: string;
  content?: string;
  task_message?: { stage?: TaskStage; status?: string } | null;
  agent_proposal?: unknown;
  gallery_search?: unknown;
}

const ERROR_PREFIXES = ['❌', '⚠️'];
const STOPPED_MARK = '*[已停止]*';

const PROPOSAL_STAGES: TaskStage[] = ['waiting_confirm', 'planning', 'planning_failed'];
const EXECUTION_STAGES: TaskStage[] = ['queued', 'analyzing', 'running', 'saving', 'success', 'failed', 'cancelled', 'interrupted'];

/** 单一判定点：一条 assistant 消息属于哪类回合。 */
export function classifyAgentTurn(message: AgentTurnLike): AgentTurnResult {
  const content = (message.content || '').trim();

  if (message.task_message) {
    const stage = message.task_message.stage;
    if (stage === 'needs_clarification') {
      return { kind: 'clarification', synthetic: true, stage };
    }
    if (stage && EXECUTION_STAGES.includes(stage)) {
      return { kind: 'execution_update', synthetic: true, stage };
    }
    if (stage && PROPOSAL_STAGES.includes(stage)) {
      return { kind: 'task_proposal', synthetic: true, stage };
    }
    return { kind: 'execution_update', synthetic: true, stage };
  }

  if (message.agent_proposal || message.gallery_search) {
    return { kind: 'task_proposal', synthetic: true };
  }

  if (content.startsWith(STOPPED_MARK)) {
    return { kind: 'execution_update', synthetic: true };
  }
  if (ERROR_PREFIXES.some(prefix => content.startsWith(prefix))) {
    return { kind: 'error', synthetic: true };
  }
  if (!content) {
    return { kind: 'chat', synthetic: true };
  }
  return { kind: 'chat', synthetic: false };
}

/** ChatMessage 适配（结构与 AgentTurnLike 兼容） */
export function classifyChatMessageTurn(message: ChatMessage): AgentTurnResult {
  return classifyAgentTurn(message as unknown as AgentTurnLike);
}
