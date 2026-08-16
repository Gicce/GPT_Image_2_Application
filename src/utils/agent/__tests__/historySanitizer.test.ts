import { describe, expect, it } from 'vitest';
import {
  isSyntheticAssistantMessage,
  sanitizeHistoryMessageContent,
  stripReasoningFromReply,
} from '../historySanitizer';

describe('stripReasoningFromReply', () => {
  it('剥离成对 <think> 标签（DeepSeek-R1 风格）', () => {
    const { reply, reasoning } = stripReasoningFromReply('<think>先分析问题</think>\n\n你好，答案是 42。');
    expect(reply).toBe('你好，答案是 42。');
    expect(reasoning).toBe('先分析问题');
  });

  it('剥离成对 <thinking> 标签（旧版本已支持的形态）', () => {
    const { reply, reasoning } = stripReasoningFromReply('<thinking>思考中</thinking>最终回答');
    expect(reply).toBe('最终回答');
    expect(reasoning).toBe('思考中');
  });

  it('剥离未闭合的 <think> 开标签（reasoning 流未收尾）', () => {
    const { reply, reasoning } = stripReasoningFromReply('<think>模型中断，只有思考没有回答');
    expect(reply).toBe('');
    expect(reasoning).toBe('模型中断，只有思考没有回答');
  });

  it('未闭合标签之前已有正文时保留正文', () => {
    const { reply, reasoning } = stripReasoningFromReply('回答正文甲。<think>后续泄漏的思考');
    expect(reply).toBe('回答正文甲。');
    expect(reasoning).toBe('后续泄漏的思考');
  });

  it('多个 think 块全部剥离并合并 reasoning', () => {
    const { reply, reasoning } = stripReasoningFromReply('<think>a</think>中段<think>b</think>结尾');
    expect(reply).toBe('中段结尾');
    expect(reasoning).toBe('a\nb');
  });

  it('没有 reasoning 标签时原样返回', () => {
    const { reply, reasoning } = stripReasoningFromReply('普通回答，含 <b>html</b> 标签');
    expect(reply).toBe('普通回答，含 <b>html</b> 标签');
    expect(reasoning).toBe('');
  });
});

describe('isSyntheticAssistantMessage', () => {
  const genuine = { role: 'assistant' as const, content: '你好，有什么可以帮你？' };

  it('真实 assistant 回答不是合成消息', () => {
    expect(isSyntheticAssistantMessage(genuine)).toBe(false);
  });

  it('任务卡 / 提案 / 图库检索消息是合成消息（不能回放进模型历史）', () => {
    expect(isSyntheticAssistantMessage({ role: 'assistant', content: '⚡ 正在规划任务……', task_message: { taskId: 't1' } as never })).toBe(true);
    expect(isSyntheticAssistantMessage({ role: 'assistant', content: '任务识别：…', agent_proposal: { id: 'p1' } as never })).toBe(true);
    expect(isSyntheticAssistantMessage({ role: 'assistant', content: '检索中', gallery_search: {} as never })).toBe(true);
  });

  it('错误 / 警告 / 中断占位是合成消息', () => {
    expect(isSyntheticAssistantMessage({ role: 'assistant', content: '❌ 请求失败' })).toBe(true);
    expect(isSyntheticAssistantMessage({ role: 'assistant', content: '⚠️ 未配置模型' })).toBe(true);
    expect(isSyntheticAssistantMessage({ role: 'assistant', content: '*[已停止]*' })).toBe(true);
  });

  it('空 assistant 占位与 user 消息的处理', () => {
    expect(isSyntheticAssistantMessage({ role: 'assistant', content: '' })).toBe(true);
    expect(isSyntheticAssistantMessage({ role: 'user', content: '' })).toBe(false);
    expect(isSyntheticAssistantMessage({ role: 'user', content: '❌ 用户就是想打这个字符' })).toBe(false);
  });
});

describe('sanitizeHistoryMessageContent', () => {
  it('历史 assistant content 中残留的 reasoning 被剥离后再回放', () => {
    expect(sanitizeHistoryMessageContent({ role: 'assistant', content: '<think>旧版本泄漏</think>真实回答' })).toBe('真实回答');
  });

  it('user 消息不做任何改写', () => {
    expect(sanitizeHistoryMessageContent({ role: 'user', content: '<think>用户原话不能动</think>' })).toBe('<think>用户原话不能动</think>');
  });
});
