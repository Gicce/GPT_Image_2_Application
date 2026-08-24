/**
 * 视觉理解错误 → 用户文案映射（V4.0.9）。
 *
 * 强制规则：
 * - Internal transport / parser / schema errors MUST NEVER be exposed directly
 *   in user-facing UI（serde/JSON/schema 细节只进开发日志）。
 * - Hiding an error message is NOT error recovery —— 恢复在 Rust 规范化层完成
 *   （normalize → validate → 最多一次模型修复）；这里是最后一道 UI 防线，
 *   只做错误分类映射与技术信息拦截，绝不吞掉错误状态。
 */

/** 技术错误特征：命中即视为开发诊断信息，禁止进入用户 UI。 */
const TECHNICAL_ERROR_PATTERN =
  /invalid type|expected a|sequence|serde|deserialize|json parse|parse error|schema violation|response_format|http response|rust|panic/i;

export function isTechnicalErrorMessage(message?: string | null): boolean {
  if (!message) return false;
  return TECHNICAL_ERROR_PATTERN.test(message);
}

/** error_kind → 固定产品文案（结构化解析失败 / 未配置等无细节可透传的分类）。 */
const KIND_MESSAGES: Record<string, string> = {
  schema_error: '图片理解没有完成，AI 返回的分析结果不完整，图片与当前工作区内容已保留，可以重新尝试理解。',
  not_configured: '尚未选择视觉模型，请先在模型管理中配置。',
  invalid_response: '视觉模型没有返回有效内容，请重试。',
};

/** 兜底文案（不可分类且无干净消息可用时）。 */
const GENERIC_MESSAGE = '图片理解没有完成，请重新尝试。';

/**
 * 视觉理解失败 → 用户可见文案。
 * 优先透传干净的产品级消息（Rust 侧网络 / 鉴权 / 限流文案含可操作细节）；
 * 任何技术细节泄露（serde/JSON/schema）都会被拦截替换。
 */
export function mapVisionErrorToUserMessage(kind?: string | null, message?: string | null): string {
  if (kind && KIND_MESSAGES[kind]) {
    return KIND_MESSAGES[kind];
  }
  if (message && !isTechnicalErrorMessage(message)) {
    return message;
  }
  return GENERIC_MESSAGE;
}
