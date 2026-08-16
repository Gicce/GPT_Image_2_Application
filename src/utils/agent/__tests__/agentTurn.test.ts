import { describe, expect, it } from 'vitest';
import { classifyAgentTurn } from '../agentTurn';

describe('classifyAgentTurn（AgentTurnResult 统一回合类型）', () => {
  it('普通聊天回复 → chat，且非合成（可回放进模型历史）', () => {
    expect(classifyAgentTurn({ role: 'assistant', content: '你好，有什么可以帮你？' }))
      .toEqual({ kind: 'chat', synthetic: false });
  });

  it('waiting_confirm 任务卡 → task_proposal（不展示 Planner 长正文）', () => {
    const result = classifyAgentTurn({ role: 'assistant', content: '', task_message: { stage: 'waiting_confirm' } });
    expect(result.kind).toBe('task_proposal');
    expect(result.synthetic).toBe(true);
  });

  it('planning / planning_failed 也归入 task_proposal 阶段', () => {
    expect(classifyAgentTurn({ role: 'assistant', task_message: { stage: 'planning' } }).kind).toBe('task_proposal');
    expect(classifyAgentTurn({ role: 'assistant', task_message: { stage: 'planning_failed' } }).kind).toBe('task_proposal');
  });

  it('needs_clarification → clarification', () => {
    expect(classifyAgentTurn({ role: 'assistant', task_message: { stage: 'needs_clarification' } }).kind).toBe('clarification');
  });

  it('执行链路阶段（queued/running/success/failed…）→ execution_update', () => {
    for (const stage of ['queued', 'running', 'success', 'failed', 'cancelled'] as const) {
      expect(classifyAgentTurn({ role: 'assistant', task_message: { stage } }).kind).toBe('execution_update');
    }
  });

  it('旧链路 agent_proposal / gallery_search → task_proposal', () => {
    expect(classifyAgentTurn({ role: 'assistant', agent_proposal: { id: 'p1' } }).kind).toBe('task_proposal');
    expect(classifyAgentTurn({ role: 'assistant', gallery_search: {} }).kind).toBe('task_proposal');
  });

  it('错误 / 警告前缀 → error', () => {
    expect(classifyAgentTurn({ role: 'assistant', content: '❌ 请求失败' }).kind).toBe('error');
    expect(classifyAgentTurn({ role: 'assistant', content: '⚠️ 未配置模型' }).kind).toBe('error');
  });

  it('中断占位 → execution_update（合成）', () => {
    expect(classifyAgentTurn({ role: 'assistant', content: '*[已停止]*' }).kind).toBe('execution_update');
  });

  it('空 assistant 占位 → chat 且合成', () => {
    expect(classifyAgentTurn({ role: 'assistant', content: '' })).toEqual({ kind: 'chat', synthetic: true });
  });
});
