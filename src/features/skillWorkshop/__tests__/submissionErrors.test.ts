import { describe, expect, test } from 'vitest';
import { describeSubmissionFailure } from '../submissionService';

/** 投稿错误文案映射（401/404/405/409/413/422/5xx/网络），并保证不透出原始技术错误。 */
describe('describeSubmissionFailure 状态码映射', () => {
  test('401 → 登录失效', () => {
    const failure = describeSubmissionFailure(401);
    expect(failure.kind).toBe('unauthorized');
    expect(failure.message).toBe('登录已失效，请重新登录后再投稿。');
  });

  test('404 / 405 → 服务器未部署投稿服务（FastAPI 默认 detail=Not Found 不外露）', () => {
    for (const status of [404, 405]) {
      const failure = describeSubmissionFailure(status, { detail: 'Not Found' });
      expect(failure.kind).toBe('server_unsupported');
      expect(failure.message).toBe('当前服务器尚未部署 Skill 投稿服务，请更新服务端；本地 Skill 不受影响。');
      expect(failure.message).not.toContain('Not Found');
    }
  });

  test('409 → 同修订已投稿（可恢复），服务端中文 message 优先', () => {
    const fallback = describeSubmissionFailure(409);
    expect(fallback.kind).toBe('duplicate');
    expect(fallback.message).toContain('当前修订已经投稿');
    const structured = describeSubmissionFailure(409, {
      detail: { code: 'SKILL_SUBMISSION_DUPLICATE', message: '当前修订已经投稿。将载入已有投稿状态；如需修改内容请创建新修订。' },
    });
    expect(structured.message).toContain('创建新修订');
  });

  test('413 → 样例图片过大', () => {
    const failure = describeSubmissionFailure(413);
    expect(failure.kind).toBe('sample_too_large');
    expect(failure.message).toBe('样例图片过大，请压缩后重试。');
  });

  test('422 → 数据格式不兼容', () => {
    const failure = describeSubmissionFailure(422, {
      detail: [{ loc: ['body', 'source_facts'], msg: 'str type expected' }],
    });
    expect(failure.kind).toBe('payload_incompatible');
    expect(failure.message).not.toContain('str type expected');
  });

  test('5xx → 服务器暂时不可用', () => {
    for (const status of [500, 502, 503]) {
      const failure = describeSubmissionFailure(status, { detail: 'Internal Server Error' });
      expect(failure.kind).toBe('server_error');
      expect(failure.message).toBe('服务器暂时不可用，请稍后重试。');
    }
  });

  test('400 结构化净化错误 → unsafe_content，采用服务端中文 message', () => {
    const failure = describeSubmissionFailure(400, {
      detail: { code: 'SKILL_SUBMISSION_UNSAFE', message: '投稿内容包含不安全信息，已拒绝提交。', errors: ['payload.core_rules[0] 含本地文件路径'] },
    });
    expect(failure.kind).toBe('unsafe_content');
    expect(failure.message).toBe('投稿内容包含不安全信息，已拒绝提交。');
  });

  test('400 无结构化 message → 通用文案，不透出原始 detail 字符串', () => {
    const failure = describeSubmissionFailure(400, { detail: 'Some proxy error' });
    expect(failure.kind).toBe('bad_request');
    expect(failure.message).not.toContain('Some proxy error');
  });

  test('未知状态 → 通用兜底', () => {
    const failure = describeSubmissionFailure(418);
    expect(failure.kind).toBe('bad_request');
    expect(failure.message).toContain('投稿请求被拒绝');
  });
});
