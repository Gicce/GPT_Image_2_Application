/**
 * billingService.ts - Image2 统一余额计费（V4 两阶段：authorize → settle）
 *
 * 服务端已从「多模型分组余额」重构为「Image2 单模型 + 统一余额」
 * （balance_usd 现金 + trial_credit_usd 试用）。计费架构不变：
 * 客户端直连上游生图，服务端记账——
 * - 生成前：authorize 预占额度（余额不足 402，客户端显示固定文案）
 * - 生成后：settle 按实际成功数结算（幂等；服务端对超时未 settle
 *   的预占有 2 小时自动释放兜底）
 *
 * Does NOT:
 * - Upload images to server
 * - Proxy image generation requests
 * - Handle payment flows (use serverApi directly)
 * - 触碰 Agent / BYOK / 本地 Provider（那是另一套独立的计费体系）
 */

import { serverApi, UsageAuthorizeResult, UsageSettleResult } from './serverApi';
import { useAuthStore } from '../store/useAuthStore';

/** 402 / QUOTA_EXHAUSTED 的统一用户文案 */
export const QUOTA_EXHAUSTED_MESSAGE = '余额不足，请充值后继续使用';

export interface UnifiedBalance {
  balanceUsd: number;
  trialCreditUsd: number;
}

/**
 * 读取统一余额（仅展示用）。
 * 后端返回字符串，parseFloat 后直接展示；
 * 客户端绝不做余额加减累计——一切以后端 authorize/settle 响应回写为准。
 */
export function getUnifiedBalance(): UnifiedBalance {
  const { user } = useAuthStore.getState();
  return {
    balanceUsd: parseFloat(user?.balance_usd ?? '0') || 0,
    trialCreditUsd: parseFloat(user?.trial_credit_usd ?? '0') || 0,
  };
}

/**
 * 生成全局唯一 request_id（8-64 字符）。
 * 同一计费单元的 authorize / settle 必须复用同一个 ID。
 */
export function createRequestId(scope: string): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${scope}-${uuid}`.slice(0, 64);
}

function isQuotaExhausted(err: any): boolean {
  return err?.status === 402 || err?.code === 'QUOTA_EXHAUSTED';
}

/**
 * 生成前预占额度（authorize）。
 * - 402 / QUOTA_EXHAUSTED → 抛出固定文案「余额不足，请充值后继续使用」
 * - 其余错误（403 IMAGE2_DISABLED / 网络错误等）原样抛出，message 已由
 *   serverApi 从 detail.message 提取
 * - 成功后以后端响应回写本地余额
 */
export async function authorizeImageTask(
  requestId: string,
  imageCount: number,
): Promise<UsageAuthorizeResult> {
  let result: UsageAuthorizeResult;
  try {
    result = await serverApi.authorizeImage2(requestId, imageCount);
  } catch (err: any) {
    if (isQuotaExhausted(err)) {
      err.message = QUOTA_EXHAUSTED_MESSAGE;
    }
    throw err;
  }
  if (result && result.balance_usd != null) {
    useAuthStore.getState().updateBalances(result.balance_usd, result.trial_credit_usd);
  }
  return result;
}

/**
 * 生成后结算（settle）。失败静默容错（console.warn，不阻断 UI）——
 * 服务端对超时未 settle 的预占有 2 小时自动释放兜底。
 */
export async function settleImageTask(
  requestId: string,
  success: boolean,
  imageCount?: number,
  failureReason?: string,
): Promise<UsageSettleResult | null> {
  try {
    const result = await serverApi.settleImage2(requestId, success, imageCount, failureReason);
    if (result && result.balance_usd != null) {
      useAuthStore.getState().updateBalances(result.balance_usd, result.trial_credit_usd);
    }
    return result;
  } catch (err) {
    console.warn(`[billing] settle 失败（依赖服务端 2h 自动释放兜底）: ${requestId}`, err);
    return null;
  }
}

// ── 任务级预占登记 ──
// authorize 发生在任务创建之前（此时 task.id 未知），任务创建成功后按
// task.id 登记 request_id；useTaskStore.reportNewlyCompleted 在任务终态时
// 按登记的 request_id settle（取后即删，天然幂等去重）。
// 应用重启会丢失登记 → 无法 settle → 服务端 2h 自动释放兜底。
const taskAuthorization = new Map<string, string>();

export function registerTaskAuthorization(taskId: string, requestId: string): void {
  if (!taskId || !requestId) return;
  taskAuthorization.set(taskId, requestId);
}

/** 取出并删除该任务的预占 ID；不存在（未授权 / 已结算 / 重启丢失）返回 undefined */
export function takeTaskAuthorization(taskId: string): string | undefined {
  const requestId = taskAuthorization.get(taskId);
  if (requestId) taskAuthorization.delete(taskId);
  return requestId;
}

/**
 * 兼容旧调用形态的生成前预检：内部转为 authorize 预占。
 * 402 时抛出「余额不足，请充值后继续使用」；其余错误原样抛出。
 * 注意：modelName 参数仅为兼容旧签名保留（V4 服务端只有 gpt-image-2 一个模型）。
 */
export async function assertCanRunImageTask(
  modelName: string,
  count: number,
  requestId: string,
): Promise<UsageAuthorizeResult> {
  void modelName;
  return authorizeImageTask(requestId, count);
}

export const billingService = {
  getUnifiedBalance,
  createRequestId,
  authorizeImageTask,
  settleImageTask,
  registerTaskAuthorization,
  takeTaskAuthorization,
  assertCanRunImageTask,
};
