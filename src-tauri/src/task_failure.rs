//! 图片生成失败 canonical failure model（V4.1 Task Failure UX）。
//!
//! 职责边界（与 TS 侧 `src/utils/taskFailure.ts` 一一对应）：
//!  - Rust：在错误信息最完整的时刻（reqwest::Error / HTTP status + body）把它
//!    正规化成结构化 `SubTaskErrorDetail`（category / http_status / provider_code /
//!    request_id / endpoint / message），随 SubTask 持久化；
//!  - TS：`classifyGenerationFailure` 只负责 copy / presentation（category →
//!    标题 / 说明 / 建议 / retryable）。禁止 TS 再对结构化数据二次 substring 分类。
//!
//! 旧 tasks.json 只有 string error：TS classifier 按稳定文案前缀回落解析，
//! 两套输入最终落到同一组 category。

use crate::models::SubTaskErrorDetail;

/// 上游图片接口失败分类（status + code + body primary 三信号）。
/// 返回 (category, retryable)；category 字符串与 TS FailureCategory 一致。
pub fn classify_upstream_failure(
    status: u16,
    code: Option<&str>,
    primary: Option<&str>,
) -> (&'static str, bool) {
    let code_text = code.unwrap_or("").trim().to_ascii_lowercase();
    let primary_text = primary.unwrap_or("").trim().to_ascii_lowercase();
    let combined = format!("{} {}", code_text, primary_text);

    // 余额类错误码可能随 400/402 出现，必须在状态码之前判定
    if combined.contains("1113")
        || combined.contains("insufficient_balance")
        || combined.contains("insufficient quota")
        || combined.contains("余额不足")
        || combined.contains("欠费")
    {
        return ("insufficient_balance", false);
    }
    if combined.contains("content_policy")
        || combined.contains("content_filter")
        || combined.contains("content_violation")
        || combined.contains("moderation")
        || combined.contains("prohibited_content")
        || combined.contains("sensitive_content")
    {
        return ("content_rejected", false);
    }
    match status {
        401 | 403 => ("auth", false),
        402 => ("insufficient_balance", false),
        429 => ("rate_limit", true),
        s if s >= 500 => ("upstream_5xx", true),
        s if (400..500).contains(&s) => ("invalid_request", false),
        _ => ("unknown", true),
    }
}

/// 发送层（reqwest）失败分类：只认 connect/timeout/request/other 四类信号。
pub fn classify_send_failure(is_timeout: bool) -> (&'static str, bool) {
    if is_timeout {
        ("timeout", true)
    } else {
        ("network", true)
    }
}

/// 从错误正文提取 request id（packyapi 把它埋在 body 文本里，无独立字段）。
/// 匹配 `request id: xxx` / `request_id=xxx` / `requestId: xxx`（大小写不敏感），
/// id 取 [A-Za-z0-9_\-.]+ 连续段。
pub fn extract_request_id(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let bytes = text.as_bytes();
    let mut search_from = 0usize;
    while let Some(pos) = lower[search_from..].find("request") {
        let start = search_from + pos;
        let mut cursor = start + "request".len();
        // 容许 `_id` / ` id` / `Id` 变体
        if lower[cursor..].starts_with("_id") {
            cursor += 3;
        } else if lower[cursor..].starts_with(" id") {
            cursor += 3;
        } else {
            search_from = start + 7;
            continue;
        }
        while cursor < bytes.len()
            && (bytes[cursor] == b' ' || bytes[cursor] == b':' || bytes[cursor] == b'=')
        {
            cursor += 1;
        }
        let id_start = cursor;
        while cursor < bytes.len() {
            let b = bytes[cursor];
            let is_id_char = b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.';
            if !is_id_char {
                break;
            }
            cursor += 1;
        }
        if cursor > id_start && cursor - id_start >= 6 {
            return Some(text[id_start..cursor].to_string());
        }
        search_from = cursor.max(start + 7);
    }
    None
}

fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339()
}

/// 发送层失败（连接失败 / 超时等），由 send_with_transient_retry 最终失败时构造。
pub fn build_send_failure_detail(kind: &str, url: &str, is_timeout: bool) -> SubTaskErrorDetail {
    let (category, retryable) = classify_send_failure(is_timeout);
    SubTaskErrorDetail {
        timestamp: now_rfc3339(),
        category: category.to_string(),
        retryable,
        http_status: None,
        provider_code: None,
        request_id: None,
        endpoint: Some(url.to_string()),
        message: format!("图片服务连接失败（{}）", kind),
    }
}

/// 上游 HTTP 非 2xx 失败：body 的 detail/code 由调用方解析传入。
pub fn build_upstream_failure_detail(
    status: u16,
    code: Option<&str>,
    primary: &str,
    request_id: Option<&str>,
    url: &str,
) -> SubTaskErrorDetail {
    let (category, retryable) = classify_upstream_failure(status, code, Some(primary));
    SubTaskErrorDetail {
        timestamp: now_rfc3339(),
        category: category.to_string(),
        retryable,
        http_status: Some(status),
        provider_code: code.map(str::to_string),
        request_id: request_id.map(str::to_string),
        endpoint: Some(url.to_string()),
        message: primary.to_string(),
    }
}

/// 本地执行类失败（源图缺失 / 保存失败 / 解析失败等）：category 由调用方指定。
pub fn build_local_failure_detail(category: &str, message: &str, retryable: bool) -> SubTaskErrorDetail {
    SubTaskErrorDetail {
        timestamp: now_rfc3339(),
        category: category.to_string(),
        retryable,
        http_status: None,
        provider_code: None,
        request_id: None,
        endpoint: None,
        message: message.to_string(),
    }
}

/// 任务执行错误载体：message 是持久化的稳定展示文案（与旧版完全一致，
/// 旧数据兼容读取），detail 是结构化快照（新数据才有）。
#[derive(Debug, Clone)]
pub struct TaskFailure {
    pub message: String,
    pub detail: Option<SubTaskErrorDetail>,
}

impl TaskFailure {
    /// 本地文件 / 前置校验失败（源图缺失、mask 缺失、remove.bg 未配置等）。
    pub fn local_file(message: String) -> Self {
        let detail = build_local_failure_detail("local_file", &message, true);
        Self { message, detail: Some(detail) }
    }

    /// 本地处理失败（响应解析 / Base64 / 写盘等），重试通常无效但保留手动入口。
    pub fn processing(message: String) -> Self {
        let detail = build_local_failure_detail("unknown", &message, false);
        Self { message, detail: Some(detail) }
    }

    /// 兜底：无法归类的失败（保持与旧版 string error 等价的展示）。
    pub fn unclassified(message: String) -> Self {
        Self { message, detail: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_500_with_do_request_failed_is_upstream_5xx() {
        // 本轮实机 fixture：/v1/images/edits HTTP 500 code=do_request_failed
        let (category, retryable) =
            classify_upstream_failure(500, Some("do_request_failed"), Some("upstream error: do request failed"));
        assert_eq!(category, "upstream_5xx");
        assert!(retryable);
    }

    #[test]
    fn http_500_must_not_be_timeout_or_auth() {
        let (category, _) = classify_upstream_failure(500, None, Some("internal error"));
        assert_ne!(category, "timeout");
        assert_ne!(category, "auth");
        assert_ne!(category, "invalid_request");
    }

    #[test]
    fn auth_rate_limit_and_balance_are_separated() {
        assert_eq!(classify_upstream_failure(401, None, None).0, "auth");
        assert_eq!(classify_upstream_failure(403, None, None).0, "auth");
        assert_eq!(classify_upstream_failure(429, None, None), ("rate_limit", true));
        assert_eq!(classify_upstream_failure(402, None, None).0, "insufficient_balance");
        // 1113 余额码可能随 400 出现，必须在 400 之前判定
        assert_eq!(
            classify_upstream_failure(400, Some("1113"), Some("余额不足，请充值")).0,
            "insufficient_balance"
        );
    }

    #[test]
    fn invalid_request_and_content_rejected() {
        assert_eq!(classify_upstream_failure(400, Some("invalid_prompt"), None), ("invalid_request", false));
        assert_eq!(
            classify_upstream_failure(400, Some("content_policy_violation"), None).0,
            "content_rejected"
        );
    }

    #[test]
    fn send_failure_timeout_is_retryable_network_kind() {
        assert_eq!(classify_send_failure(true), ("timeout", true));
        assert_eq!(classify_send_failure(false), ("network", true));
    }

    #[test]
    fn extract_request_id_from_body_text() {
        let text = "upstream error: do request failed, request id: req-20260824-ab12cd34ef";
        assert_eq!(
            extract_request_id(text).as_deref(),
            Some("req-20260824-ab12cd34ef")
        );
        assert_eq!(extract_request_id("no marker here"), None);
        assert_eq!(
            extract_request_id("request_id=abc1234567").as_deref(),
            Some("abc1234567")
        );
        // 短于 6 个字符的段落不当作 request id
        assert_eq!(extract_request_id("request id: ab1"), None);
    }
}
