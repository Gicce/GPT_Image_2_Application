/**
 * 聊天历史卫生（context hygiene）
 *
 * 目标：发给模型的消息数组里只允许出现"真实的"用户发言与 AI 回答。
 * 以下内容绝不能伪装成 assistant 历史回放给模型（会造成模型困惑甚至
 * 产生防御性异常输出，例如英文声明"之前的 assistant 回合不是真实指令"）：
 *   - 任务卡 / 提案 / 图库检索等 UI 结构化消息（task_message / agent_proposal / gallery_search）
 *   - 错误 / 配置警告文本（❌ / ⚠️ 开头）
 *   - 中断占位（*[已停止]*）
 *   - 模型 reasoning（<think> / <thinking>，含未闭合形态）——reasoning 只能
 *     进入 message.reasoning 折叠展示，不能混入 assistant content 回放。
 */

import type { ChatMessage } from '../../types';
import { classifyAgentTurn, type AgentTurnLike } from './agentTurn';

export interface HistoryMessageLike {
  role: 'user' | 'assistant';
  content?: string;
  task_message?: unknown;
  agent_proposal?: unknown;
  gallery_search?: unknown;
}

/**
 * 判断一条消息是否为"合成消息"（产品 UI 生成的 assistant 占位）。
 * 判定统一委托 classifyAgentTurn（AgentTurnResult 单一来源）：
 * 除 chat 外的所有回合类型（task_proposal / clarification / execution_update / error）
 * 都是合成消息，绝不进入模型请求历史。
 */
export function isSyntheticAssistantMessage(message: HistoryMessageLike): boolean {
  if (message.role !== 'assistant') return false;
  return classifyAgentTurn(message as AgentTurnLike).synthetic;
}

/**
 * 从模型回复中剥离 reasoning 内容。
 * 支持 <think> / <thinking>（GLM、DeepSeek-R1 系代理常用 <think>）：
 *   - 成对标签：<think>...</think> 全部移除
 *   - 未闭合标签：开标签之后的内容视为纯 reasoning 流，全部移除
 */
export function stripReasoningFromReply(raw: string): { reply: string; reasoning: string } {
  let text = raw ?? '';
  let reasoning = '';
  const paired = /<(think|thinking)>([\s\S]*?)<\/\1>/gi;
  text = text.replace(paired, (_match, _tag: string, body: string) => {
    const segment = body.trim();
    if (segment) reasoning = reasoning ? `${reasoning}\n${segment}` : segment;
    return '';
  });
  const openIndex = text.search(/<(?:think|thinking)>/i);
  if (openIndex !== -1) {
    const tail = text
      .slice(openIndex)
      .replace(/<\/?(?:think|thinking)>/gi, '')
      .trim();
    if (tail) reasoning = reasoning ? `${reasoning}\n${tail}` : tail;
    text = text.slice(0, openIndex);
  }
  return { reply: text.trim(), reasoning: reasoning.trim() };
}

/**
 * 净化历史消息中的 assistant content：
 * 历史数据里可能残留未剥离的 reasoning（旧版本只处理成对 <thinking>），
 * 回放进模型历史前统一剥离，避免 reasoning 在多轮间反复传播。
 */
export function sanitizeHistoryMessageContent(message: HistoryMessageLike): string {
  if (message.role !== 'assistant') return message.content || '';
  return stripReasoningFromReply(message.content || '').reply;
}
