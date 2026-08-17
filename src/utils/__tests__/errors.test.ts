import { describe, expect, it } from 'vitest';
import { explainError } from '../errors';

describe('explainError（账户/充值链路错误展示）', () => {
  it('FastAPI 422 校验错误数组（经 serverApi 归一为 message 字符串）显示具体原因', () => {
    // serverApi.request 已把 detail:[{loc,msg,type}] 归一为 Error.message
    const err = new Error('充值金额必须大于 0；支付方式不能为空');
    (err as any).status = 422;
    const text = explainError(err);
    expect(text).toContain('充值金额必须大于 0');
    expect(text).toContain('支付方式不能为空');
    expect(text).not.toContain('[object Object]');
  });

  it('结构化业务错误（{code, message}）展示 message', () => {
    const err: any = new Error('当前没有可更换的 Image2 Runtime Token，请联系管理员');
    err.status = 409;
    err.detail = { code: 'NO_AVAILABLE_RUNTIME_TOKEN', message: '当前没有可更换的 Image2 Runtime Token，请联系管理员' };
    const text = explainError(err);
    expect(text).toContain('NO_AVAILABLE_RUNTIME_TOKEN'.length > 0 ? '没有可更换' : '');
    expect(text).not.toContain('[object Object]');
  });

  it('字符串 detail 原样展示', () => {
    const err: any = new Error('充值金额需在 $1 ~ $1000 之间');
    err.status = 400;
    expect(explainError(err)).toContain('充值金额需在');
  });

  it('网络错误展示服务器地址提示', () => {
    const err: any = new TypeError('Failed to fetch');
    err.serverUrl = 'http://localhost:4001';
    expect(explainError(err)).toContain('无法连接服务器');
  });

  it('空错误兜底', () => {
    expect(explainError(null)).toBe('操作失败，请重试');
  });
});
