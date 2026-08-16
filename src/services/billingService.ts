/**
 * billingService.ts - Lightweight billing service for commercial loop
 *
 * Responsibilities:
 * - Pre-run balance check
 * - Post-run usage reporting
 * - Cost estimation
 *
 * Does NOT:
 * - Upload images to server
 * - Proxy image generation requests
 * - Handle payment flows (use serverApi directly)
 */

import { serverApi, UsageEstimateItem, UsageReportResult, UsageEstimate, ServerModel } from './serverApi';
import { useAuthStore } from '../store/useAuthStore';

export type BillingGroup = 'image' | 'agent' | 'postprocess';

export interface BalanceCheckResult {
  canRun: boolean;
  group: string;
  balance_usd: number;
  required_usd: number;
  message?: string;
}

export interface ImageUsagePayload {
  model: string;
  image_count: number;
}

/**
 * Get user's balance for a specific group
 */
export function getGroupBalance(group: string): number {
  const { user } = useAuthStore.getState();
  if (!user?.tokens) return 0;
  const token = user.tokens.find(t => t.group === group);
  return token?.balance_usd ?? 0;
}

/**
 * Get all group balances
 */
export function getAllBalances(): Record<string, number> {
  const { user } = useAuthStore.getState();
  if (!user?.tokens) return {};
  return Object.fromEntries(user.tokens.map(t => [t.group, t.balance_usd]));
}

/**
 * Check if user has enough balance for a given cost in a group
 */
export function checkBalance(group: string, requiredUsd: number): BalanceCheckResult {
  const balance = getGroupBalance(group);
  const canRun = balance >= requiredUsd;
  return {
    canRun,
    group,
    balance_usd: balance,
    required_usd: requiredUsd,
    message: canRun ? undefined : `${group} 余额不足: 需要 $${requiredUsd.toFixed(4)}, 当前 $${balance.toFixed(2)}`,
  };
}

/**
 * Estimate cost for image generation
 * Returns cost in USD, or 0 if model not found
 */
export function estimateImageCost(modelName: string, count: number, models: ServerModel[]): number {
  const model = models.find(m => m.name === modelName && m.billing_type === 'per_call');
  if (!model?.price_per_call) return 0;
  return Number(model.price_per_call) * count;
}

/**
 * Check balance before running an image task
 * Uses server-side estimate for accuracy — no need to pass local models list
 * Throws if balance insufficient
 *
 * V3.0.6：仅图片 / 后处理走服务器余额（CyImagePro 图片服务）。
 * Agent 对话已全面 BYOK —— 不存在 agent/chat 余额预检与上报（旧
 * assertCanRunAgentTask / reportAgentUsage / reportChatUsage 已随服务器 Agent 一并移除）。
 */
export async function assertCanRunImageTask(
  modelName: string,
  count: number,
): Promise<BalanceCheckResult> {
  const items: UsageEstimateItem[] = [
    { type: 'image', model: modelName, image_count: count },
  ];

  const estimate = await serverApi.estimateUsage(items);

  if (!estimate.can_run && estimate.groups.length > 0) {
    const groupInfo = estimate.groups[0];
    throw new Error(
      `余额不足，请先充值后再生成。${groupInfo.group} 需要 $${groupInfo.required_usd.toFixed(4)}, 当前 $${groupInfo.balance_usd.toFixed(2)}`
    );
  }

  // If no groups returned (e.g. model not found on server), allow run
  // — server will reject at report time if model invalid
  const groupInfo = estimate.groups[0];
  return {
    canRun: true,
    group: groupInfo?.group ?? '',
    balance_usd: groupInfo?.balance_usd ?? 0,
    required_usd: groupInfo?.required_usd ?? 0,
  };
}

/**
 * Report image usage after successful generation
 * Updates local balance on success
 */
export async function reportImageUsage(payload: ImageUsagePayload): Promise<UsageReportResult> {
  const result = await serverApi.reportImage(payload.model, payload.image_count);

  // Update local balance
  const auth = useAuthStore.getState();
  if (result.group) {
    auth.updateTokenBalance(result.group, result.balance_usd);
  }
  if (result.account_type) {
    auth.updateAccountType(result.account_type);
  }

  return result;
}

/**
 * Estimate usage cost via server API
 */
export async function estimateUsage(items: UsageEstimateItem[]): Promise<UsageEstimate> {
  return serverApi.estimateUsage(items);
}

/**
 * Quick local balance check without server call
 * Use this for UI display, but use assertCanRun* before actual operations
 */
export function hasEnoughBalance(group: string, requiredUsd: number): boolean {
  return getGroupBalance(group) >= requiredUsd;
}

export const billingService = {
  getGroupBalance,
  getAllBalances,
  checkBalance,
  estimateImageCost,
  assertCanRunImageTask,
  reportImageUsage,
  estimateUsage,
  hasEnoughBalance,
};
