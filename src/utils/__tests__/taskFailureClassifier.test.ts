import { describe, expect, it } from 'vitest';
import {
  attemptFailureHistory,
  classifyGenerationFailure,
  type FailureCategory,
} from '../taskFailure';
import type { SubTaskErrorDetail } from '../../types';

/** 本轮实机 fixture：/v1/images/edits HTTP 500，code=do_request_failed，2 次尝试 */
const PACKYAPI_500_MESSAGE =
  '上游图片接口失败：upstream error: do request failed, request id: 20260824184502AbCdEfGh1234 [code: do_request_failed] [endpoint: https://www.packyapi.com/v1/images/edits] (HTTP 500)';

const PACKYAPI_500_DETAIL: SubTaskErrorDetail = {
  timestamp: '2026-08-24T18:45:19+08:00',
  category: 'upstream_5xx',
  retryable: true,
  http_status: 500,
  provider_code: 'do_request_failed',
  request_id: '20260824184502AbCdEfGh1234',
  endpoint: 'https://www.packyapi.com/v1/images/edits',
  message: 'upstream error: do request failed',
};

describe('classifyGenerationFailure · 本轮 HTTP 500 专项回归（spec §30）', () => {
  it('结构化 detail：category=upstream_5xx，retryable=true，四要素技术详情齐全', () => {
    const info = classifyGenerationFailure({ detail: PACKYAPI_500_DETAIL, message: PACKYAPI_500_MESSAGE });
    expect(info.category).toBe('upstream_5xx');
    expect(info.retryable).toBe(true);
    expect(info.technical?.httpStatus).toBe(500);
    expect(info.technical?.providerCode).toBe('do_request_failed');
    expect(info.technical?.requestId).toBe('20260824184502AbCdEfGh1234');
    expect(info.technical?.endpoint).toBe('https://www.packyapi.com/v1/images/edits');
  });

  it('旧 string 数据（无 detail）同样归类 upstream_5xx，并从文案还原技术详情', () => {
    const info = classifyGenerationFailure({ message: PACKYAPI_500_MESSAGE });
    expect(info.category).toBe('upstream_5xx');
    expect(info.retryable).toBe(true);
    expect(info.technical?.httpStatus).toBe(500);
    expect(info.technical?.providerCode).toBe('do_request_failed');
    expect(info.technical?.requestId).toBe('20260824184502AbCdEfGh1234');
  });

  it('禁止误分类：HTTP 500 绝不是 timeout / auth / invalid_request', () => {
    for (const source of [
      { detail: PACKYAPI_500_DETAIL, message: PACKYAPI_500_MESSAGE },
      { message: '上游图片接口失败：internal error (HTTP 500)' },
      { message: '上游图片接口失败：bad gateway (HTTP 502)' },
      { message: '上游图片接口失败：service unavailable (HTTP 503)' },
    ]) {
      const info = classifyGenerationFailure(source);
      expect(info.category).toBe('upstream_5xx');
      expect(['timeout', 'auth', 'invalid_request']).not.toContain(info.category);
    }
  });
});

describe('classifyGenerationFailure · Timeout 专项（spec §31）', () => {
  const TIMEOUT_MESSAGE = '图片服务连接失败（timeout）：请求超时。请前往“设置 → 一键检查运行环境”确认代理可达、或适当调低尺寸/质量后重试。 [endpoint: https://www.packyapi.com/v1/images/edits]（已自动重试 2 次仍失败）';

  it('Rust timeout 前缀 → timeout，retryable=true', () => {
    const info = classifyGenerationFailure({ message: TIMEOUT_MESSAGE });
    expect(info.category).toBe('timeout');
    expect(info.retryable).toBe(true);
  });

  it('结构化 detail（category=timeout）→ timeout', () => {
    const info = classifyGenerationFailure({
      detail: { timestamp: 't', category: 'timeout', retryable: true, message: 'request timed out' },
    });
    expect(info.category).toBe('timeout');
  });

  it('英文超时标记（request timed out / deadline exceeded / connect timeout）→ timeout', () => {
    for (const message of ['request timed out', 'deadline exceeded after 600s', 'connect timeout 30s']) {
      expect(classifyGenerationFailure({ message }).category).toBe('timeout');
    }
  });

  it('“do request failed” 不含超时标记，绝不落入 timeout', () => {
    expect(classifyGenerationFailure({ message: 'do request failed' }).category).not.toBe('timeout');
  });
});

describe('classifyGenerationFailure · 其余类别', () => {
  const cases: Array<{ name: string; source: Parameters<typeof classifyGenerationFailure>[0]; category: FailureCategory; retryable: boolean }> = [
    { name: 'connect 前缀 → network', source: { message: '图片服务连接失败（connect）：无法建立连接 [endpoint: https://x]' }, category: 'network', retryable: true },
    { name: '429 → rate_limit', source: { message: '上游图片接口失败：too many requests (HTTP 429)' }, category: 'rate_limit', retryable: true },
    { name: '401 → auth（不可重试）', source: { message: '上游图片接口失败：invalid api key (HTTP 401)' }, category: 'auth', retryable: false },
    { name: '403 → auth（不可重试）', source: { message: '上游图片接口失败：forbidden (HTTP 403)' }, category: 'auth', retryable: false },
    { name: '402 → insufficient_balance', source: { message: '上游图片接口失败：payment required (HTTP 402)' }, category: 'insufficient_balance', retryable: false },
    { name: '400 + 1113 → insufficient_balance（先于 400 判定）', source: { message: '上游图片接口失败：余额不足 [code: 1113] (HTTP 400)' }, category: 'insufficient_balance', retryable: false },
    { name: '400 → invalid_request（不可重试）', source: { message: '上游图片接口失败：invalid prompt [code: invalid_prompt] (HTTP 400)' }, category: 'invalid_request', retryable: false },
    { name: '内容审核码 → content_rejected', source: { message: '上游图片接口失败：rejected [code: content_policy_violation] (HTTP 400)' }, category: 'content_rejected', retryable: false },
    { name: 'API Token 未设置 → auth', source: { message: 'API Token 未设置' }, category: 'auth', retryable: false },
    { name: '源图缺失 → local_file', source: { message: '源图片不存在：D:/x.png。该任务引用的源图可能已被删除或移动。' }, category: 'local_file', retryable: true },
    { name: '应用重启中断 → cancelled（可恢复）', source: { message: '客户端重启导致任务中断，请重试该任务。' }, category: 'cancelled', retryable: true },
    { name: '未知 → unknown', source: { message: '某种没见过的错误' }, category: 'unknown', retryable: true },
    { name: '空 → unknown', source: { message: '' }, category: 'unknown', retryable: true },
  ];

  for (const { name, source, category, retryable } of cases) {
    it(`${name}`, () => {
      const info = classifyGenerationFailure(source);
      expect(info.category).toBe(category);
      expect(info.retryable).toBe(retryable);
    });
  }

  it('text_conversation_not_supported 保留 V4.0.5 专项能力文案（category=invalid_request）', () => {
    const info = classifyGenerationFailure({
      message: '上游图片接口失败：model cannot process text conversation [code: text_conversation_not_supported] [endpoint: https://www.packyapi.com/v1/images/edits] (HTTP 400)',
    });
    expect(info.category).toBe('invalid_request');
    expect(info.title).toBe('模型调用方式与当前模型能力不匹配');
    expect(info.userMessage).toContain('图生图接口');
    expect(info.userMessage).toContain('误路由');
  });
});

describe('attemptFailureHistory · 尝试历史（spec §18 §24）', () => {
  it('新数据：attempt_details 与 attempt_errors 逐条对齐（含时间戳）', () => {
    const detail: SubTaskErrorDetail = {
      timestamp: '2026-08-24T18:45:06+08:00',
      category: 'upstream_5xx',
      retryable: true,
      http_status: 500,
      provider_code: 'do_request_failed',
      message: 'upstream error: do request failed',
    };
    const history = attemptFailureHistory({
      attempt_errors: ['第一次失败', '第二次失败'],
      attempt_details: [{ ...detail, timestamp: '2026-08-24T18:45:02+08:00' }, detail],
    });
    expect(history).toHaveLength(2);
    expect(history[0].timestamp).toBe('2026-08-24T18:45:02+08:00');
    expect(history[1].info.category).toBe('upstream_5xx');
    expect(history[1].info.technical?.httpStatus).toBe(500);
  });

  it('旧数据（只有 string）也能产出历史，无时间戳但标题可用', () => {
    const history = attemptFailureHistory({
      attempt_errors: [PACKYAPI_500_MESSAGE, PACKYAPI_500_MESSAGE],
    });
    expect(history).toHaveLength(2);
    expect(history[0].timestamp).toBeUndefined();
    expect(history[0].info.title).toBe('上游图片服务异常');
  });

  it('混合数据：details 与 errors 尾部对齐（旧错误在前、新快照在后）', () => {
    const history = attemptFailureHistory({
      attempt_errors: ['旧 string 失败', '图片服务连接失败（timeout）：x', '上游图片接口失败：boom (HTTP 500)'],
      attempt_details: [
        { timestamp: '2026-08-24T18:46:00+08:00', category: 'upstream_5xx', retryable: true, http_status: 500, message: 'boom' },
      ],
    });
    expect(history).toHaveLength(3);
    // 前两条旧数据无时间戳，最后一条与 detail 对齐
    expect(history[0].timestamp).toBeUndefined();
    expect(history[1].timestamp).toBeUndefined();
    expect(history[2].timestamp).toBe('2026-08-24T18:46:00+08:00');
    expect(history[2].info.technical?.providerCode).toBeUndefined();
    expect(history[2].info.technical?.httpStatus).toBe(500);
  });
});
