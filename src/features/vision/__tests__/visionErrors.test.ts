import { describe, expect, test } from 'vitest';
import { isTechnicalErrorMessage, mapVisionErrorToUserMessage } from '../visionErrors';

/**
 * 视觉理解错误映射（V4.0.9）：
 * - 结构化解析失败（schema_error）永远显示产品级文案；
 * - 任何 serde / JSON / schema 技术细节泄露都被拦截替换；
 * - 网络 / 鉴权等干净的产品级消息正常透传（含可操作细节）。
 */

const FORBIDDEN_TOKENS = [
  'invalid type',
  'sequence',
  'expected a string',
  'serde',
  'deserialize',
  'JSON parse',
  'schema violation',
  'response_format',
  'HTTP response body',
];

describe('mapVisionErrorToUserMessage', () => {
  test('schema_error → 固定产品文案（不透传任何技术细节）', () => {
    const message = mapVisionErrorToUserMessage(
      'schema_error',
      '图片理解没有完成，AI 返回的分析结果不完整，图片与当前工作区内容已保留，可以重新尝试理解。',
    );
    expect(message).toBe('图片理解没有完成，AI 返回的分析结果不完整，图片与当前工作区内容已保留，可以重新尝试理解。');
    for (const token of FORBIDDEN_TOKENS) {
      expect(message.toLowerCase()).not.toContain(token.toLowerCase());
    }
  });

  test('实测事故消息（invalid type: sequence, expected a string）被完全拦截', () => {
    const legacy = mapVisionErrorToUserMessage(
      'invalid_response',
      '结构化分析返回格式无效：视觉分析结构不符合约定：invalid type: sequence, expected a string',
    );
    expect(legacy).not.toContain('invalid type');
    expect(legacy).not.toContain('sequence');
    expect(legacy).not.toContain('serde');
  });

  test('干净的产品级消息透传（网络 / 鉴权 / 限流含可操作细节）', () => {
    expect(mapVisionErrorToUserMessage('rate_limited', '视觉模型服务限流，请稍后重试：Too many requests（HTTP 429）'))
      .toBe('视觉模型服务限流，请稍后重试：Too many requests（HTTP 429）');
    expect(mapVisionErrorToUserMessage('auth', '视觉模型服务鉴权失败，请检查 API Key（HTTP 401）'))
      .toBe('视觉模型服务鉴权失败，请检查 API Key（HTTP 401）');
    expect(mapVisionErrorToUserMessage('unsupported_image', '图片过大（超过 25MB），请压缩后重试'))
      .toBe('图片过大（超过 25MB），请压缩后重试');
  });

  test('not_configured / invalid_response 有固定文案兜底', () => {
    expect(mapVisionErrorToUserMessage('not_configured', null)).toContain('尚未选择视觉模型');
    expect(mapVisionErrorToUserMessage('invalid_response', null)).toContain('没有返回有效内容');
  });

  test('未知 kind + 技术性消息 / 空消息 → 通用产品文案', () => {
    expect(mapVisionErrorToUserMessage(null, null)).toBe('图片理解没有完成，请重新尝试。');
    expect(mapVisionErrorToUserMessage('weird_kind', 'serde_json::from_value failed'))
      .toBe('图片理解没有完成，请重新尝试。');
  });
});

describe('isTechnicalErrorMessage', () => {
  test('识别 serde / parser / schema 特征', () => {
    expect(isTechnicalErrorMessage('invalid type: sequence, expected a string')).toBe(true);
    expect(isTechnicalErrorMessage('视觉分析结构不符合约定：invalid type: map')).toBe(true);
    expect(isTechnicalErrorMessage('panic at src/main.rs')).toBe(true);
  });

  test('产品级中文文案不误伤', () => {
    expect(isTechnicalErrorMessage('视觉模型服务限流，请稍后重试（HTTP 429）')).toBe(false);
    expect(isTechnicalErrorMessage('图片过大（超过 25MB），请压缩后重试')).toBe(false);
    expect(isTechnicalErrorMessage(null)).toBe(false);
    expect(isTechnicalErrorMessage('')).toBe(false);
  });
});
