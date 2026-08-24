/**
 * AI Transport 统一日志（V4.1）—— 所有 AI 请求的模型路由可见性入口。
 *
 * 输出形如：
 *   [AITransport] role=vision_prompt_optimizer feature=vision-recreation
 *   model=glm-5v-turbo provider=智谱 GLM billing_mode=api source=follow
 * fallback 时附加 requested=... reason=...。
 * 禁止输出 API Key / Bearer token / Secret。
 */

import type { ResolvedAiModel } from './resolveModelForRole';

export function logAiTransport(
  resolved: ResolvedAiModel,
  feature: string,
): void {
  const parts = [
    `role=${resolved.role}`,
    `feature=${feature}`,
    `model=${resolved.resolvedModelId}`,
    `provider=${resolved.providerName}`,
    ...(resolved.billingMode ? [`billing_mode=${resolved.billingMode}`] : []),
    `source=${resolved.source}`,
    ...(resolved.followedRole ? [`followed=${resolved.followedRole}`] : []),
  ];
  if (resolved.source === 'fallback') {
    parts.push(
      ...(resolved.requestedModelId ? [`requested=${resolved.requestedModelId}`] : []),
      `reason=${resolved.fallbackReason ?? ''}`,
    );
  }
  console.log(`[AITransport] ${parts.join(' ')}`);
}

/** 人类可读的回退提示（UI 展示用；开发态日志走 logAiTransport）。 */
export function describeFallback(resolved: ResolvedAiModel): string {
  if (resolved.source !== 'fallback') return '';
  const requested = resolved.requestedModelId
    || (resolved.followedRole ? `跟随的模型` : '原模型');
  return `${requested} 不可用，已回退至 ${resolved.displayName}（${resolved.fallbackReason ?? '原因未知'}）`;
}
