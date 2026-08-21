import { describe, it, expect } from 'vitest';
import { resolveChatImageReadiness, CHAT_VISION_UNSUPPORTED_MESSAGE } from '../chatImageReadiness';

/**
 * AI 对话图片附件就绪判定（V4.0.8）：
 * chat 模式附件需经图片理解模型转摘要 —— 无视觉模型时附件落位即提示，
 * 不等发送后才报服务端错误。
 */

describe('resolveChatImageReadiness', () => {
  it('配置了视觉模型 → 就绪', () => {
    expect(resolveChatImageReadiness({ visionModel: 'glm-4.6v' }).ok).toBe(true);
    expect(resolveChatImageReadiness({ visionModel: '  ' }).ok).toBe(false);
  });

  it('未配置视觉模型 → 阻断并给出明确切换提示', () => {
    const result = resolveChatImageReadiness({ visionModel: '' });
    expect(result.ok).toBe(false);
    expect(result.message).toBe(CHAT_VISION_UNSUPPORTED_MESSAGE);
    expect(result.message).toContain('当前模型不支持图片理解');
    expect(result.message).toContain('切换到支持视觉输入的模型');
  });

  it('visionModel 缺省 / null 同样判定为不可用', () => {
    expect(resolveChatImageReadiness({}).ok).toBe(false);
    expect(resolveChatImageReadiness({ visionModel: null }).ok).toBe(false);
  });
});
