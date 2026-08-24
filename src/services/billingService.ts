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
import { requestQuoteConfirmation } from '../store/useQuoteStore';
import { useTaskBillingStore } from '../store/useTaskBillingStore';

/** 402 / QUOTA_EXHAUSTED 的统一用户文案（CY Credits 口径） */
export const QUOTA_EXHAUSTED_MESSAGE = '点数不足，请充值后继续使用';

/** 用户在报价确认弹层取消（调用方可据此静默处理） */
export function isQuoteCancelled(err: any): boolean {
  return Boolean(err?.quoteCancelled);
}

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
 * 生成前报价 + 预占额度（quote → 用户确认 → authorize）。
 *
 * Generation Quote Pattern（V4.2 铁律）：所有付费图片 API 调用入口在
 * authorize 之前必须先取服务端报价，用户在确认弹层看到
 * 单张/预计/余额/剩余 后才继续。报价 10 分钟冻结，authorize 携 quote_id
 * 按冻结价计费；用户取消 → 抛 quoteCancelled 错误。
 *
 * - 402 / QUOTA_EXHAUSTED → 抛出固定文案「点数不足，请充值后继续使用」
 * - 其余错误（403 IMAGE2_DISABLED / 网络错误等）原样抛出
 * - 成功后以后端响应回写本地余额（点数 + 旧 USD 镜像）
 */
export async function authorizeImageTask(
  requestId: string,
  imageCount: number,
  opts?: { feature?: string; skipQuoteConfirm?: boolean },
): Promise<UsageAuthorizeResult> {
  const feature = opts?.feature ?? 'image';
  let quoteId: string | null = null;

  if (!opts?.skipQuoteConfirm) {
    const quote = await requestQuoteConfirmation(feature, imageCount);
    quoteId = quote.quote_id;
  }

  let result: UsageAuthorizeResult;
  try {
    result = await serverApi.authorizeImage2(requestId, imageCount, quoteId, feature);
  } catch (err: any) {
    if (isQuotaExhausted(err)) {
      err.message = QUOTA_EXHAUSTED_MESSAGE;
    }
    throw err;
  }
  if (result && result.balance_usd != null) {
    useAuthStore.getState().updateBalances(result.balance_usd, result.trial_credit_usd, {
      paid: result.paid_credits,
      trial: result.trial_credits,
      gift: result.gift_credits,
      total: result.total_credits,
    });
  }
  // 计费展示侧车：预占成功即登记预计消耗（任务创建后 register 关联 taskId）
  pendingAuthorize.set(requestId, {
    estimated: result.amount_credits ?? 0,
    unit: result.unit_credits ?? null,
    requestId,
  });
  return result;
}

/** authorize 与任务创建之间的短暂桥接（requestId → 预计消耗） */
const pendingAuthorize = new Map<string, { estimated: number; unit: number | null; requestId: string }>();

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
      useAuthStore.getState().updateBalances(result.balance_usd, result.trial_credit_usd, {
        paid: result.paid_credits,
        trial: result.trial_credits,
        gift: result.gift_credits,
        total: result.total_credits,
      });
    }
    // 计费展示侧车：登记实际消耗（partial 任务 actual < estimated，差额已自动退回）
    useTaskBillingStore.getState().recordSettle(
      requestId, result.amount_credits ?? 0, result.status,
    );
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
// retriedIndexes：V4.0.5 部分重试时登记本轮重试的子任务下标——结算只数
// 这些槽位的最终完成数，绝不把上一轮已结算的成功子任务重复计入。
export interface TaskAuthorization {
  requestId: string;
  retriedIndexes?: number[];
}

const taskAuthorization = new Map<string, TaskAuthorization>();

export function registerTaskAuthorization(
  taskId: string,
  requestId: string,
  retriedIndexes?: number[],
): void {
  if (!taskId || !requestId) return;
  taskAuthorization.set(taskId, { requestId, retriedIndexes });
  // 计费展示侧车：把 authorize 的预计消耗关联到任务
  const pending = pendingAuthorize.get(requestId);
  if (pending) {
    useTaskBillingStore.getState().recordAuthorize(taskId, {
      requestId,
      estimated: pending.estimated,
      unit: pending.unit,
    });
    pendingAuthorize.delete(requestId);
  }
}

/** 取出并删除该任务的预占登记；不存在（未授权 / 已结算 / 重启丢失）返回 undefined */
export function takeTaskAuthorization(taskId: string): TaskAuthorization | undefined {
  const auth = taskAuthorization.get(taskId);
  if (auth) taskAuthorization.delete(taskId);
  return auth;
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
