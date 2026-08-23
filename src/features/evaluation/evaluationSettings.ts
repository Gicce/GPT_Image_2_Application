/**
 * 评价设置（localStorage 轻量持久化，模式对齐 vision_workspace_v1）。
 *
 * 「生成后自动评价」默认开启：评价复用 BYOK 视觉模型（与聊天 / 提示词优化同路，
 * 不产生服务端计费）；关闭后仅在用户点击「重新评价」时手动调用。
 */

import type { UserRating } from './types';

export interface EvaluationSettings {
  autoEvaluate: boolean;
}

const STORAGE_KEY = 'evaluation_settings_v1';

const DEFAULTS: EvaluationSettings = {
  autoEvaluate: true,
};

export function readEvaluationSettings(): EvaluationSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<EvaluationSettings>;
    return {
      autoEvaluate: typeof parsed.autoEvaluate === 'boolean' ? parsed.autoEvaluate : DEFAULTS.autoEvaluate,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeEvaluationSettings(settings: EvaluationSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage 不可用：仅本次会话生效
  }
}

/** 用户反馈合法值守卫（与 Rust update_image_evaluation_feedback 对齐）。 */
export function normalizeUserRating(value: unknown): UserRating | null {
  return value === 'liked' || value === 'disliked' ? value : null;
}
