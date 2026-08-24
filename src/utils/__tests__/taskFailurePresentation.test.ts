import { describe, expect, it } from 'vitest';
import { classifyGenerationFailure, describeEndpoint } from '../taskFailure';

describe('失败呈现文案（spec §8-§13 固定文案表）', () => {
  it('upstream_5xx：标题 / 说明 / 建议与 spec 逐字一致', () => {
    const info = classifyGenerationFailure({
      detail: {
        timestamp: 't',
        category: 'upstream_5xx',
        retryable: true,
        http_status: 500,
        provider_code: 'do_request_failed',
        message: 'upstream error: do request failed',
      },
    });
    expect(info.title).toBe('上游图片服务异常');
    expect(info.userMessage).toBe('图片服务返回了服务器错误（HTTP 500），本次生成未完成。');
    expect(info.suggestion).toBe('通常属于临时服务异常，建议稍后重试。');
    expect(info.retryable).toBe(true);
  });

  it('timeout：生成请求超时 + 建议重新生成', () => {
    const info = classifyGenerationFailure({
      detail: { timestamp: 't', category: 'timeout', retryable: true, message: 'request timed out' },
    });
    expect(info.title).toBe('生成请求超时');
    expect(info.userMessage).toBe('图片服务在规定时间内没有完成响应，本次生成已停止。');
    expect(info.suggestion).toBe('网络波动或服务繁忙时可能出现，建议重新生成。');
    expect(info.retryable).toBe(true);
  });

  it('rate_limit：请求过于频繁', () => {
    const info = classifyGenerationFailure({
      detail: { timestamp: 't', category: 'rate_limit', retryable: true, http_status: 429, message: 'too many requests' },
    });
    expect(info.title).toBe('请求过于频繁');
    expect(info.userMessage).toBe('当前图片服务请求较多，请稍后再试。');
    expect(info.retryable).toBe(true);
  });

  it('auth：模型服务授权失败，retryable=false', () => {
    const info = classifyGenerationFailure({
      detail: { timestamp: 't', category: 'auth', retryable: false, http_status: 401, message: 'invalid key' },
    });
    expect(info.title).toBe('模型服务授权失败');
    expect(info.suggestion).toBe('请检查当前模型服务配置或 API 凭据。');
    expect(info.retryable).toBe(false);
  });

  it('insufficient_balance：余额不足，引导充值', () => {
    const info = classifyGenerationFailure({
      detail: { timestamp: 't', category: 'insufficient_balance', retryable: false, message: '余额不足' },
    });
    expect(info.title).toBe('模型服务余额不足');
    expect(info.suggestion).toBe('请前往「我的账户」充值后再重试。');
    expect(info.retryable).toBe(false);
  });

  it('invalid_request：不显示「上游服务暂时不可用」', () => {
    const info = classifyGenerationFailure({
      detail: { timestamp: 't', category: 'invalid_request', retryable: false, http_status: 400, message: 'bad size' },
    });
    expect(info.title).toBe('生成参数不符合当前模型要求');
    expect(info.title).not.toContain('暂时不可用');
    expect(info.suggestion).toBe('请检查参考图、尺寸或生成参数后重试。');
  });

  it('运行 Token 未配置：auth 类下的专项文案', () => {
    const info = classifyGenerationFailure({ message: 'API Token 未设置' });
    expect(info.title).toBe('当前没有可用的运行 Token');
    expect(info.suggestion).toBe('请重新登录或等待运行配置下发后再重试。');
    expect(info.retryable).toBe(false);
  });

  it('friendly 与 technical 永远同时保留（不吞原始错误）', () => {
    const message = '上游图片接口失败：weird crash trace [code: x_y] (HTTP 500)';
    const info = classifyGenerationFailure({ message });
    expect(info.technical?.rawMessage).toBe(message);
    expect(info.title).toBe('上游图片服务异常');
  });
});

describe('describeEndpoint · Endpoint 脱敏（spec §14）', () => {
  it('摘要只显示 接口名 · 路径，不显示 scheme/host', () => {
    expect(describeEndpoint('https://www.packyapi.com/v1/images/edits')).toBe('图片生成接口 · /v1/images/edits');
    expect(describeEndpoint('https://www.packyapi.com/v1/images/generations')).toBe('图片生成接口 · /v1/images/generations');
    expect(describeEndpoint('https://api.remove.bg/v1.0/removebg')).toBe('去背景接口 · /v1.0/removebg');
  });

  it('直接传 path 也可识别', () => {
    expect(describeEndpoint('/v1/images/edits')).toBe('图片生成接口 · /v1/images/edits');
  });

  it('绝不携带 Authorization / API Key / Bearer', () => {
    const summary = describeEndpoint('https://www.packyapi.com/v1/images/edits');
    expect(summary).not.toMatch(/bearer|api[-_]?key|authorization/i);
  });

  it('空值返回空串（UI 自行省略）', () => {
    expect(describeEndpoint(null)).toBe('');
    expect(describeEndpoint('')).toBe('');
  });
});
