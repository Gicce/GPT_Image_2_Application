import { describe, expect, it } from 'vitest';
import { classifySubTaskError } from '../subtaskError';

describe('classifySubTaskError', () => {
  it('connect 网络错误 → network_connect（含代理提示）', () => {
    const result = classifySubTaskError(
      '图片服务连接失败（connect）：无法建立连接。请检查 Windows 系统代理（如 127.0.0.1:7897）是否启用且可达，前往“设置 → 一键检查运行环境”可一键诊断。 [endpoint: https://www.packyapi.com/v1/images/generations]',
    );
    expect(result.kind).toBe('network_connect');
    expect(result.title).toBe('连接图片服务失败');
    expect(result.hint).toContain('代理');
  });

  it('timeout 网络错误 → network_timeout', () => {
    const result = classifySubTaskError('图片服务连接失败（timeout）：请求超时。 [endpoint: https://x]');
    expect(result.kind).toBe('network_timeout');
  });

  it('text_conversation_not_supported → upstream_capability（能力/路由不匹配）', () => {
    const result = classifySubTaskError(
      '上游图片接口失败：This model only supports image generation and cannot process text conversation requests. [code: text_conversation_not_supported] (HTTP 400)',
    );
    expect(result.kind).toBe('upstream_capability');
    expect(result.title).toBe('模型调用方式与当前模型能力不匹配');
  });

  it('上游 500 → upstream_5xx', () => {
    const result = classifySubTaskError('上游图片接口失败：bad gateway (HTTP 502)');
    expect(result.kind).toBe('upstream_5xx');
  });

  it('上游 400 无特殊码 → upstream_4xx', () => {
    const result = classifySubTaskError('上游图片接口失败：invalid prompt [code: invalid_prompt] (HTTP 400)');
    expect(result.kind).toBe('upstream_4xx');
  });

  it('API Token 未设置 → runtime_token_missing', () => {
    expect(classifySubTaskError('API Token 未设置').kind).toBe('runtime_token_missing');
  });

  it('源图缺失 → local_file', () => {
    expect(classifySubTaskError('源图片不存在：D:/x.png。该任务引用的源图可能已被删除或移动，请在任务卡中切换源图片后重试。').kind).toBe('local_file');
  });

  it('自动重试后仍失败的附加文案不影响分类', () => {
    const result = classifySubTaskError(
      '图片服务连接失败（connect）：无法建立连接。 [endpoint: https://x]（已自动重试 2 次仍失败）',
    );
    expect(result.kind).toBe('network_connect');
  });

  it('空/未知 → unknown 兜底', () => {
    expect(classifySubTaskError('').kind).toBe('unknown');
    expect(classifySubTaskError(null).kind).toBe('unknown');
    expect(classifySubTaskError('某种没见过的错误').kind).toBe('unknown');
  });
});
