/**
 * 对话图片附件就绪判定（V4.0.8）—— 拖图 / 选图后客户端即时提示，不等发送后报服务端错误。
 *
 * chat 模式下图片附件不是直接进对话模型，而是先经图片理解模型转成文字摘要
 * （understandAttachmentsForAgent）。没有可用视觉模型时发送必然失败 ——
 * 在附件落位时就给出明确提示。task 模式附件作为参考图直接参与任务规划，无需视觉模型。
 */

export interface ChatImageReadinessInput {
  /** 图片理解模型 id（空 / 缺失 = 当前无法理解图片）。 */
  visionModel?: string | null;
}

export interface ChatImageReadinessResult {
  ok: boolean;
  /** ok=false 时的提示文案。 */
  message?: string;
}

export const CHAT_VISION_UNSUPPORTED_MESSAGE =
  '当前模型不支持图片理解，请切换到支持视觉输入的模型。';

export function resolveChatImageReadiness(input: ChatImageReadinessInput): ChatImageReadinessResult {
  if ((input.visionModel ?? '').trim()) return { ok: true };
  return { ok: false, message: CHAT_VISION_UNSUPPORTED_MESSAGE };
}
