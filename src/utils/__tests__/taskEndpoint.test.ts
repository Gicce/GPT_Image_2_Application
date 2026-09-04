import { describe, expect, it } from 'vitest';
import type { Task } from '../../types';
import { getHistoryApiEndpoint } from '../taskEndpoint';

describe('history image endpoint provenance', () => {
  const task = (task_type: string, sub_tasks: unknown[] = []) => ({ task_type, sub_tasks }) as Task;

  it('does not invent a host for tasks without a recorded endpoint', () => {
    expect(getHistoryApiEndpoint(task('generate'))).toBe('POST /v1/images/generations');
    expect(getHistoryApiEndpoint(task('edit'))).toBe('POST /v1/images/edits');
  });

  it('preserves both old and new actual endpoints instead of rewriting history', () => {
    for (const host of ['www.packyapi.com', 'cf.api.fan']) {
      const endpoint = `https://${host}/v1/images/generations`;
      expect(getHistoryApiEndpoint(task('generate', [{
        error_detail: { category: 'network', endpoint, message: 'connection failed' },
      }]))).toBe(`POST ${endpoint}`);
      expect(getHistoryApiEndpoint(task('generate', [{
        error: `图片服务连接失败（connect） [endpoint: ${endpoint}]`,
      }]))).toBe(`POST ${endpoint}`);
    }
  });
});
