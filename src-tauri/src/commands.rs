use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Emitter, Manager};

use crate::models::{
    AgentStyleTemplate, AgentTaskTemplate, AgentTemplateDraftCurrentTemplate,
    AgentTemplateDraftExpectedOutput, AgentTemplateDraftPayload, AgentTemplateDraftRequirements,
    AgentTemplateExportPayload, AgentTemplateImportPayload, AgentTemplateLog, ChatConversation,
    CreateTaskParams, ImageRecord, RuntimeAuthConfig, Settings, SubTask, Task,
};
use crate::storage;
use crate::RuntimeAuthState;

// reqwest 0.12 with default-features=false does not read the Windows Internet Settings
// proxy on its own. The Agent/Vision/Image upstreams (packyapi.com) are unreachable from
// networks where the user must route through a system proxy (e.g. 127.0.0.1:7897). Without
// this we hit TCP-connect timeouts that the UI surfaces as "Agent 请求超时，请稍后重试".
// Localhost (heartbeat / runtime-config via the frontend fetch) is unaffected — it never
// goes through reqwest and the proxy override list excludes private ranges anyway.
#[cfg(target_os = "windows")]
pub(crate) fn read_windows_system_proxy() -> Option<String> {
    use std::process::Command;
    let internet_settings = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    let enable_output = Command::new("reg")
        .args(["query", internet_settings, "/v", "ProxyEnable"])
        .output()
        .ok()?;
    let enable_text = String::from_utf8_lossy(&enable_output.stdout);
    if !enable_text.contains("0x1") {
        return None;
    }

    let server_output = Command::new("reg")
        .args(["query", internet_settings, "/v", "ProxyServer"])
        .output()
        .ok()?;
    let server_text = String::from_utf8_lossy(&server_output.stdout);
    let raw = server_text
        .lines()
        .find_map(|line| line.split("ProxyServer").nth(1))
        .and_then(|rest| rest.split("REG_SZ").nth(1))
        .map(str::trim)?
        .to_string();
    if raw.is_empty() {
        return None;
    }

    let normalize = |addr: &str| -> String {
        if addr.starts_with("http://") || addr.starts_with("https://") {
            addr.to_string()
        } else {
            format!("http://{}", addr)
        }
    };

    if raw.contains('=') {
        for part in raw.split(';') {
            if let Some(addr) = part
                .strip_prefix("https=")
                .or_else(|| part.strip_prefix("http="))
            {
                return Some(normalize(addr));
            }
        }
        return None;
    }
    Some(normalize(&raw))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn read_windows_system_proxy() -> Option<String> {
    None
}

/// V4.0.6 起 pub(crate)：视觉理解命令（vision.rs）复用同一客户端（代理/超时一致）。
pub(crate) static HTTP_CLIENT: once_cell::sync::Lazy<reqwest::Client> = once_cell::sync::Lazy::new(|| {
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .use_native_tls();
    if let Some(proxy_url) = read_windows_system_proxy() {
        if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
            builder = builder.proxy(proxy);
        }
    }
    builder.build().unwrap_or_else(|_| reqwest::Client::new())
});

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AgentMessagePart {
    pub part_type: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub image_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AgentRequestMessage {
    pub role: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub parts: Vec<AgentMessagePart>,
}

#[derive(Debug, Deserialize)]
pub struct AgentRunPayload {
    pub mode: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub model: String,
    /// AI Model Role（V4.1 路由可见性）：前端每次 AI 调用显式携带，
    /// 仅用于诊断日志（[AITransport] role=… feature=…），不参与任何路由判定。
    #[serde(default)]
    pub role: String,
    /// 发起调用的功能标识（如 vision-recreation / image-studio-optimize）。
    #[serde(default)]
    pub feature: String,
    /// Provider 连接的使用方式（如 glm_official 的 api / coding_plan）。
    /// 仅用于诊断日志与错误归因 —— 实际请求地址始终使用 base_url（前端经
    /// resolveProviderBaseUrl 解析后传入），Rust 侧不猜测、不重写。
    #[serde(default)]
    pub billing_mode: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub has_images: bool,
    #[serde(default)]
    pub editable_image_count: usize,
    #[serde(default)]
    pub attachment_names: Vec<String>,
    #[serde(default)]
    pub rough_intent: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub messages: Vec<AgentRequestMessage>,
    /// 输出预算覆盖（V4.2.7 comic-concepts 根因修复）：推理型模型（GLM-5.3 等）
    /// 的 reasoning tokens 与正文共享 max_tokens 预算，4096 会被思考吃掉大半，
    /// 正文 JSON 中途截断（finish_reason=length）。大 JSON 输出的调用方
    /// （comic_planner）显式传更大预算；缺省 None = 维持 4096，既有调用方不受影响。
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct VisionUnderstandPayload {
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct AgentEndpointStatus {
    pub ok: bool,
    pub kind: Option<String>,
    pub message: String,
    pub status: Option<u16>,
}

#[derive(Debug, Serialize, Clone)]
pub struct AgentEndpointCheckResult {
    pub chat: AgentEndpointStatus,
    pub chat_with_system: AgentEndpointStatus,
    pub chat_multimodal: AgentEndpointStatus,
    pub official_vision: AgentEndpointStatus,
    pub interpret: AgentEndpointStatus,
    pub generation: AgentEndpointStatus,
    pub edit: AgentEndpointStatus,
}

#[derive(Debug, Serialize)]
pub struct VisionUnderstandResult {
    pub ok: bool,
    pub summary: Option<String>,
    pub raw_text: Option<String>,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
    pub status: Option<u16>,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct ResponsesShapeDiagnostic {
    /// HTTP 状态码（成功的 2xx 也会回填，方便 UI 一目了然）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    /// Responses 顶层 `status` 字段：completed / incomplete / failed / ...
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_status: Option<String>,
    /// Responses 顶层所有字段名，供 UI 显示原始 shape 概览。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub top_level_keys: Vec<String>,
    /// `output[]` 数组的长度。
    #[serde(default)]
    pub output_count: usize,
    /// `output[]` 中每个 item 的 `type`（reasoning / message / ...），按出现顺序。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub output_types: Vec<String>,
    /// 所有 `message.content[]` 中出现的 `type`（output_text / ...），去重。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub content_types: Vec<String>,
    /// 顶层是否有 `output_text` 字段（部分代理会扁平化返回）。
    #[serde(default)]
    pub has_top_level_output_text: bool,
    /// 是否带 `choices[]`（chat completions shape 直通时为 true）。
    #[serde(default)]
    pub has_choices: bool,
    /// 顶层是否携带"有意义的"上游错误。
    /// v3.0.5 起：只有 `body.error` / `body.last_error` 至少有一个非空
    /// message/type/code/param 字段才为 true。`"error": null` / `"error": {}` /
    /// `"error": {"message": null, ...}` 都不算错误。
    #[serde(default)]
    pub has_error: bool,
    /// 最终从 body 里提取到的 final text 长度（character count）。
    #[serde(default)]
    pub extracted_text_len: usize,
    /// 当 Responses `status=="incomplete"` 时，`incomplete_details.reason` 原值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub incomplete_reason: Option<String>,
    /// 当 body.error / status=failed 时，从 body.error.message / last_error.message
    /// 提取到的上游真实错误文本。HTTP 200 + body.error 场景下尤为关键 ——
    /// 这是用户真正想看到的 "gpt-5.6-luna 失败原因"，而不是一句通用的 upstream_error。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_error_message: Option<String>,
    /// body.error.type（OpenAI 风格：invalid_request_error / rate_limit_error / server_error ...）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_error_type: Option<String>,
    /// body.error.code（unsupported_parameter / model_not_found / ...）。
    /// 用于前端决定是否可以自动 retry、是否建议切换模型。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_error_code: Option<String>,
    /// body.error.param（unsupported_parameter 时通常带具体参数名）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_error_param: Option<String>,
    /// Responses 顶层 `id` 字段（resp_xxx）。Payload Recovery 的 Retrieve 阶段需要它。
    /// None 表示上游没有返回 id，无法做 Retrieve。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_id: Option<String>,
    /// Responses body.usage.output_tokens。**None** 表示上游 usage 没填该字段；
    /// 注意这与 `Some(0)`（明确告知本轮没产生 output token）语义不同。
    /// `provider_response_payload_missing` 判定要求 output_tokens > 0。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    /// chat_completions 通道专用：choices[0].finish_reason（stop / length / ...）。
    /// `finish_reason=length` 是"输出被 max_tokens 截断"的权威信号，
    /// 也是 planner_output_truncated 分类的第一判据。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    /// usage.input_tokens（Responses）/ usage.prompt_tokens（chat）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    /// usage.reasoning_tokens（含 Responses usage.output_tokens_details.reasoning_tokens）。
    /// 推理型模型（DeepSeek v4 / gpt-5.x reasoning）的推理 token 与最终 JSON 共享
    /// max_output_tokens 预算 —— 这是"JSON 输出到一半被截断"的主要根因指标。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
    /// 本次 Planner 调用若触发过"针对性自动重试"（截断 / 空文本），记录轨迹。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_retry: Option<PlannerAutoRetryTrace>,
}

/// Planner 针对性自动重试轨迹（截断 / 空文本各触发一次，总共最多 1 次）。
#[derive(Debug, Serialize, Clone, Default)]
pub struct PlannerAutoRetryTrace {
    /// 触发原因：planner_output_truncated / response_text_missing。
    #[serde(default)]
    pub trigger: String,
    /// 重试结果：recovered / still_truncated / still_empty / request_failed。
    #[serde(default)]
    pub result: String,
}

/// Responses Payload Recovery 执行轨迹。前端 "查看规划详情" 据此展示
/// "响应恢复" 详情区，告诉用户 Primary / Retrieve / Streaming 各自的结果。
///
/// 字段全部 optional —— 例如 Primary 自身成功时 attempted=false 且其他字段为空；
/// Primary payload missing + Retrieve 成功时 stream_* 字段为空。
#[derive(Debug, Serialize, Clone, Default)]
pub struct ResponsesRecoveryTrace {
    /// 是否启动过 Payload Recovery（Primary 出现 payload missing 时才会 true）。
    #[serde(default)]
    pub attempted: bool,
    /// Retrieve 阶段结果：`recovered` / `empty` / `unsupported` / `failed` / `skipped`。
    /// `skipped` 表示 Primary 没有 response_id，无法发起 Retrieve。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retrieve_result: Option<String>,
    /// Retrieve HTTP 状态码。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retrieve_http_status: Option<u16>,
    /// SSE Streaming 阶段结果：`recovered` / `empty` / `unsupported` / `failed` / `skipped`。
    /// `skipped` 表示 Retrieve 已经成功，无需再走 Streaming。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_result: Option<String>,
    /// SSE Streaming HTTP 状态码。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_http_status: Option<u16>,
    /// SSE Streaming 收到的事件总数（包含 created/delta/completed/failed/error 等所有类型）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_event_count: Option<u32>,
    /// SSE Streaming 收到的 response.output_text.delta 事件数。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_text_delta_count: Option<u32>,
    /// 最终恢复文本的来源标签：`retrieve` / `StreamingDelta` /
    /// `StreamingOutputTextDone` / `StreamingCompletedResponse`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_source: Option<String>,
    /// Primary 响应里 usage.output_tokens 的回显（诊断 UI 用）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_output_tokens: Option<u64>,
    /// Primary 响应的 response_id 回显（诊断 UI 用）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_response_id: Option<String>,
}

impl ResponsesRecoveryTrace {
    fn new_not_attempted() -> Self {
        ResponsesRecoveryTrace::default()
    }
}

/// Payload Recovery 每个阶段（Retrieve / Stream）的局部结果。
/// 不直接对外暴露，只在 run_agent_request 内部用来驱动状态机。
#[derive(Debug, Clone)]
enum ResponsesRecoveryOutcome {
    /// 成功恢复 final text。`source` 用于回填 ResponsesRecoveryTrace.text_source。
    Recovered { text: String, source: String },
    /// 阶段执行成功（HTTP 2xx）但仍然拿不到文本 —— 继续下一阶段。
    /// `response_status` 仅用于诊断日志（"completed" / "failed" / 等），不驱动状态机。
    Empty {
        http_status: Option<u16>,
        #[allow(dead_code)]
        response_status: Option<String>,
    },
    /// Provider 不支持此阶段（例如 Retrieve 404 / Stream 返回 unsupported_parameter）。
    /// 继续下一阶段。
    Unsupported {
        reason: String,
        http_status: Option<u16>,
    },
    /// 阶段执行出现真正的失败（网络错误 / 鉴权失败 / 解析失败 等）。
    /// 继续下一阶段或终止（视调用方策略而定）。
    Failed {
        kind: String,
        reason: String,
        http_status: Option<u16>,
    },
}

#[derive(Debug, Serialize)]
pub struct AgentRunResult {
    pub ok: bool,
    pub intent: Option<String>,
    pub confidence: Option<f64>,
    pub needs_clarification: Option<bool>,
    pub clarification_question: Option<String>,
    pub recommended_action: Option<String>,
    pub should_propose_execution: Option<bool>,
    pub final_prompt: Option<String>,
    pub final_negative_prompt: Option<String>,
    pub api_kind: Option<String>,
    pub reply: Option<String>,
    pub reasoning: Option<String>,
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
    pub status: Option<u16>,
    pub used_local_fallback: Option<bool>,
    /// Planner 专用诊断：模型真实返回的文本（已截断到 ~4000 字符）。
    /// 仅在 plan_task / interpret 模式且发生解析失败 / 文本缺失时填入。
    pub planner_raw_output: Option<String>,
    /// Planner 专用诊断：JSON parser 的报错描述（serde_json 的 Display）。
    pub planner_parser_error: Option<String>,
    /// Planner 专用诊断：本次调用的通道（responses / chat_completions）。
    pub planner_transport: Option<String>,
    /// Planner 专用诊断：Responses body 的结构化摘要。无论成功 / 失败都会回填，
    /// 让 TS 端 "查看规划详情" 能够直接展示 HTTP / Responses Status / Output Types /
    /// Content Types / Extracted Text Length，而不是只能看到一句 "response_text_missing"。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planner_diagnostic: Option<ResponsesShapeDiagnostic>,
    /// Planner 专用诊断：Responses Payload Recovery 的执行轨迹。
    /// 仅在 Primary 出现 `provider_response_payload_missing` 后启动 Retrieve + Stream
    /// 恢复流程时填入；其他路径为 None。前端据此展示"响应恢复"详情区。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planner_recovery: Option<ResponsesRecoveryTrace>,
    /// chat 通道 finish_reason（stop / length / ...）：V4.2.7 comic-concepts 修复。
    /// `length` = 输出被 max_tokens 截断，前端据此把"JSON 不闭合"归类为截断并
    /// 生成针对性修复重试指令（压缩输出），而不是原样重发。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
}

/// max_tokens 覆盖的钳制（防调用方传异常值：下限保住基本输出，上限防误传打爆配额）。
fn effective_max_tokens(requested: Option<u32>) -> u32 {
    requested.unwrap_or(4096).clamp(1024, 16384)
}

/// 从 chat completions body 提取 choices[0].finish_reason（截断诊断用）。
fn chat_finish_reason(value: &serde_json::Value) -> Option<String> {
    value
        .get("choices")?
        .get(0)?
        .get("finish_reason")?
        .as_str()
        .map(str::to_string)
}

/// base URL 末段是否已是版本段（v1 / v4 / v1beta 等）。
/// 智谱官方地址形如 `https://open.bigmodel.cn/api/paas/v4`，
/// 早期实现只识别 `/v1`，会给它拼出 `/v4/v1/chat/completions` 这类错误 URL。
fn ends_with_version_segment(base: &str) -> bool {
    let Some((_, last)) = base.rsplit_once('/') else {
        return false;
    };
    let mut chars = last.chars();
    match chars.next() {
        Some('v') if last.len() >= 2 => {}
        _ => return false,
    }
    chars.next().is_some_and(|c| c.is_ascii_digit())
}

fn normalize_agent_base_url(base_url: &str) -> String {
    let mut base = base_url.trim().trim_end_matches('/').to_string();
    if !ends_with_version_segment(&base) {
        base.push_str("/v1");
    }
    base
}

fn status_error_kind(status: u16) -> &'static str {
    match status {
        401 | 403 => "auth",
        429 => "rate_limit",
        500..=599 => "server",
        _ => "invalid_response",
    }
}

fn message_contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn extract_error_parts_from_value(value: &serde_json::Value) -> (Option<String>, Option<String>) {
    let (msg, _kind, code, _param) = extract_full_error_parts_from_value(value);
    (msg, code)
}

/// 从 Responses / chat-completions 错误 body 中提取 4 元组：
/// (message, type, code, param)。
///
/// 优先读取 OpenAI 风格 `body.error.{message,type,code,param}`，
/// 其次是顶层 `body.{detail,message,code,type}` 兜底，
/// 再次是 Responses 协议的 `body.last_error.{code,message}`（status=failed 时常见）。
///
/// 这是 surface gpt-5.6-luna 真实失败原因的核心入口 —— 不允许再把上游的明确
/// error.message 丢掉、只回一句 "upstream_error"。
fn extract_full_error_parts_from_value(
    value: &serde_json::Value,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    // 兼容 string-form error：部分非标准代理把 error / last_error 直接写成字符串。
    // 此时只有 message 字段有意义，type/code/param 全部 None。
    if let Some(s) = value.get("error").and_then(|v| v.as_str()) {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return (Some(trimmed.to_string()), None, None, None);
        }
    }
    if let Some(s) = value.get("last_error").and_then(|v| v.as_str()) {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return (Some(trimmed.to_string()), None, None, None);
        }
    }

    let err_obj = value.get("error").filter(|v| v.is_object());
    let last_error_obj = value.get("last_error").filter(|v| v.is_object());

    let pick_str = |parent: Option<&serde_json::Value>, key: &str| {
        parent
            .and_then(|v| v.get(key))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };

    let message = pick_str(err_obj, "message")
        .or_else(|| pick_str(last_error_obj, "message"))
        .or_else(|| pick_str(Some(value), "detail"))
        .or_else(|| pick_str(Some(value), "message"));
    let kind = pick_str(err_obj, "type").or_else(|| pick_str(Some(value), "type"));
    let code = pick_str(err_obj, "code")
        .or_else(|| pick_str(last_error_obj, "code"))
        .or_else(|| pick_str(Some(value), "code"));
    let param = pick_str(err_obj, "param").or_else(|| pick_str(Some(value), "param"));
    (message, kind, code, param)
}

/// 单一来源的"上游是否真的报错"判定。这是把 `error:null` / `error:{}` /
/// `error:{message:null,code:null}` 与真正错误区分开的核心入口。
///
/// 规则：只要 `body.error` 或 `body.last_error` 至少有一个非空 message / type / code /
/// param 字段，就视为有意义的上游错误。仅仅 JSON 里存在 `error` 这个 key
/// （值为 null / 空对象 / 全 null 字段对象）不算错误。
///
/// **项目里所有需要"判断上游是否报错"的地方都必须走这个函数**，
/// 否则会出现 `has_error` 与 `upstream_error_*` 字段语义漂移。
fn has_meaningful_upstream_error(body: &serde_json::Value) -> bool {
    let (msg, kind, code, param) = extract_full_error_parts_from_value(body);
    msg.is_some() || kind.is_some() || code.is_some() || param.is_some()
}

fn build_responses_api_error(
    status: u16,
    body: &serde_json::Value,
    fallback: &str,
) -> AgentEndpointStatus {
    let (detail, code) = extract_error_parts_from_value(body);
    let kind = classify_upstream_error(status, detail.as_deref(), code.as_deref());
    let message =
        build_upstream_error_message(fallback, status, &kind, detail.as_deref(), code.as_deref());
    AgentEndpointStatus {
        ok: false,
        kind: Some(kind),
        message,
        status: Some(status),
    }
}

fn collect_response_output_text(value: &serde_json::Value, parts: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(text) = map.get("output_text").and_then(|v| v.as_str()) {
                let text = text.trim();
                if !text.is_empty() {
                    parts.push(text.to_string());
                }
            }
            if matches!(
                map.get("type").and_then(|v| v.as_str()),
                Some("output_text")
            ) {
                if let Some(text) = map.get("text").and_then(|v| v.as_str()) {
                    let text = text.trim();
                    if !text.is_empty() {
                        parts.push(text.to_string());
                    }
                }
            }
            for value in map.values() {
                collect_response_output_text(value, parts);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_response_output_text(item, parts);
            }
        }
        _ => {}
    }
}

/// 旧提取函数的兼容入口 —— 官方视觉理解等场景仍然在使用。
/// 现统一委托给 `extract_final_responses_text`，确保整个项目只有一份提取逻辑。
fn extract_responses_output_text(value: &serde_json::Value) -> Option<String> {
    extract_final_responses_text(value)
}

async fn call_official_vision_model(
    token: &str,
    model: &str,
    prompt: &str,
    images: &[String],
) -> Result<String, AgentEndpointStatus> {
    let mut content = vec![json!({ "type": "input_text", "text": prompt })];
    for image in images {
        content.push(json!({ "type": "input_image", "image_url": image }));
    }

    let response = HTTP_CLIENT
        .post("https://www.packyapi.com/v1/responses")
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&json!({
            "model": model,
            "input": [
                {
                    "role": "user",
                    "content": content
                }
            ],
            "max_output_tokens": 600
        }))
        .send()
        .await
        .map_err(|err| AgentEndpointStatus {
            ok: false,
            kind: Some(classify_reqwest_error(&err).to_string()),
            message: match classify_reqwest_error(&err) {
                "timeout" => "官方图片理解请求超时，请稍后重试".to_string(),
                "connect" => "无法连接官方图片理解服务，请检查网络".to_string(),
                _ => format!("官方图片理解请求失败：{}", err),
            },
            status: None,
        })?;

    let status = response.status().as_u16();
    let body = response
        .json::<serde_json::Value>()
        .await
        .unwrap_or_else(|_| json!({}));
    if status >= 400 {
        return Err(build_responses_api_error(status, &body, "官方图片理解失败"));
    }

    match extract_responses_output_text(&body) {
        Some(text) => Ok(text),
        None => Err(AgentEndpointStatus {
            ok: false,
            kind: Some("invalid_response".to_string()),
            message: "官方图片理解接口返回成功，但未返回可解析文本".to_string(),
            status: Some(status),
        }),
    }
}

fn classify_upstream_error(status: u16, detail: Option<&str>, code: Option<&str>) -> String {
    let lower = detail.unwrap_or("").to_ascii_lowercase();
    let code_lower = code.unwrap_or("").to_ascii_lowercase();

    // protocol_not_supported: model only speaks the OTHER transport.
    // This must be classified distinctly so `run_agent_request` can apply its
    // single-attempt protocol fallback (chat_completions ↔ responses).
    if message_contains_any(
        &lower,
        &[
            "protocol_not_supported",
            "不支持 chat completions",
            "does not support chat completions",
            "unsupported protocol",
        ],
    ) || code_lower.contains("protocol_not_supported")
    {
        return "protocol_not_supported".to_string();
    }
    if message_contains_any(
        &lower,
        &[
            "must contain the word 'json'",
            "must contain the word json",
            "json_object",
        ],
    ) {
        return "json_output_unsupported".to_string();
    }
    if message_contains_any(
        &lower,
        &[
            "image_url",
            "input_image",
            "multimodal",
            "vision",
            "content[",
            "messages[",
            "array of content parts",
            "unsupported content",
        ],
    ) {
        return "multimodal_unsupported".to_string();
    }
    if message_contains_any(
        &lower,
        &[
            "does not exist",
            "unknown model",
            "unsupported model",
            "model not found",
            "access to model",
            "no permission",
        ],
    ) || message_contains_any(
        &code_lower,
        &["model_not_found", "invalid_model", "unsupported_model"],
    ) {
        return "model_error".to_string();
    }
    if status == 400 || status == 422 {
        return "invalid_request".to_string();
    }
    if status_error_kind(status) == "invalid_response" && (detail.is_some() || code.is_some()) {
        return "upstream_api".to_string();
    }
    status_error_kind(status).to_string()
}

fn build_upstream_error_message(
    prefix: &str,
    status: u16,
    kind: &str,
    detail: Option<&str>,
    code: Option<&str>,
) -> String {
    let mut message = match kind {
        "json_output_unsupported" => "模型可以对话，但不稳定遵循 JSON 输出要求".to_string(),
        "multimodal_unsupported" => {
            "当前代理支持基础对话，但不兼容聊天链路中的图片或多段 content 消息格式".to_string()
        }
        "model_error" => {
            if let Some(text) = detail.filter(|text| !text.eq_ignore_ascii_case("openai_error")) {
                format!("{prefix}：模型配置不可用，{text}")
            } else {
                format!("{prefix}：模型配置不可用，请检查模型名或当前账号权限")
            }
        }
        "invalid_request" => {
            if let Some(text) = detail.filter(|text| !text.eq_ignore_ascii_case("openai_error")) {
                format!("{prefix}：{text}")
            } else {
                format!("{prefix}：上游拒绝了当前请求，请检查模型名、Base URL 或请求参数")
            }
        }
        _ => {
            if let Some(text) = detail.filter(|text| !text.eq_ignore_ascii_case("openai_error")) {
                if text.starts_with(prefix) {
                    text.to_string()
                } else {
                    format!("{prefix}：{text}")
                }
            } else {
                format!("{prefix}：上游拒绝了请求，但未返回具体原因")
            }
        }
    };

    if let Some(code_value) = code {
        if !code_value.is_empty()
            && !message.contains(code_value)
            && !code_value.eq_ignore_ascii_case("openai_error")
        {
            message.push_str(&format!(" [code: {code_value}]"));
        }
    }
    message.push_str(&format!(" (HTTP {status})"));
    message
}

fn format_upstream_message(
    prefix: &str,
    status: u16,
    value: &serde_json::Value,
) -> (String, String) {
    let (detail, code) = extract_error_parts_from_value(value);
    let kind = classify_upstream_error(status, detail.as_deref(), code.as_deref());
    let message =
        build_upstream_error_message(prefix, status, &kind, detail.as_deref(), code.as_deref());
    (kind, message)
}

fn classify_reqwest_error(err: &reqwest::Error) -> &'static str {
    if err.is_timeout() {
        "timeout"
    } else if err.is_connect() {
        "connect"
    } else {
        "invalid_response"
    }
}

fn should_retry_status(status: u16) -> bool {
    (500..=599).contains(&status)
}

fn should_retry_error_kind(kind: &str) -> bool {
    matches!(kind, "connect" | "timeout" | "server")
}

// ============================================================================
// Model Transport Capability —— single source of truth for protocol routing.
//
// Upstream providers (packyapi / OpenAI) increasingly split models by the wire
// protocol they accept: some models only speak Responses (`POST /v1/responses`),
// others only speak Chat Completions (`POST /v1/chat/completions`). Calling the
// wrong one returns HTTP 400 `protocol_not_supported`, which is exactly what
// gpt-5.6-luna surfaces today.
//
// `resolve_transport_preference(model, mode)` returns the ORDERED list of
// transports the caller should try. The first entry is the primary; subsequent
// entries are fallbacks attempted ONLY when the upstream returns
// `protocol_not_supported` (or equivalent shape).
//
//   - For known Responses-only models (gpt-5.6-luna, gpt-5.6-*) →
//     ["responses", "chat_completions"] in ALL modes including plain chat.
//   - For everything else → ["chat_completions", "responses"] so we preserve
//     existing behaviour for gpt-5.4 / chat-class models, but still recover
//     automatically if a model is later migrated to Responses-only.
//
// IMPORTANT: this is the ONLY place that decides per-model transport.
// Do not sprinkle `if model == "gpt-5.6-luna"` elsewhere.
//
// NOTE: transport preference is a MODEL capability, never a mode decision.
// plan_task / interpret used to force Responses-first, which broke BYOK
// providers that only expose /chat/completions (Zhipu GLM, DeepSeek): their
// /responses endpoint 404s and the error surfaced as a planner failure.
// Responses-only models are already covered by model_prefer_responses_transport.
// ============================================================================

fn model_prefer_responses_transport(model: &str) -> bool {
    let lower = model.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    // gpt-5.6 family — confirmed Responses-only at packyapi.
    if lower.starts_with("gpt-5.6") || lower.contains("5.6-luna") {
        return true;
    }
    // Future-proofing: any explicitly-tagged "-responses" suffix.
    if lower.ends_with("-responses") {
        return true;
    }
    false
}

fn resolve_transport_preference(model: &str, _mode: &str) -> Vec<&'static str> {
    if model_prefer_responses_transport(model) {
        vec!["responses", "chat_completions"]
    } else {
        vec!["chat_completions", "responses"]
    }
}

/// True when an AgentEndpointStatus represents the upstream rejecting the
/// current transport entirely (model only speaks the OTHER protocol).
/// Used to drive the single-attempt protocol fallback in `run_agent_request`.
fn is_protocol_not_supported(status: &AgentEndpointStatus) -> bool {
    if status.kind.as_deref() == Some("protocol_not_supported") {
        return true;
    }
    // Some upstreams phrase it differently — match the literal code/text too.
    let msg = status.message.to_ascii_lowercase();
    if msg.contains("protocol_not_supported") {
        return true;
    }
    if msg.contains("不支持 chat completions")
        || msg.contains("does not support chat completions")
        || msg.contains("unsupported protocol")
    {
        return true;
    }
    false
}

async fn post_chat_completions(
    base_url: &str,
    token: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, AgentEndpointStatus> {
    let url = format!("{}/chat/completions", normalize_agent_base_url(base_url));
    let mut last_error: Option<AgentEndpointStatus> = None;

    for attempt in 0..2 {
        match HTTP_CLIENT
            .post(&url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
        {
            Ok(response) => {
                let status = response.status().as_u16();
                if response.status().is_success() {
                    return response.json::<serde_json::Value>().await.map_err(|_| {
                        AgentEndpointStatus {
                            ok: false,
                            kind: Some("invalid_response".to_string()),
                            message: "服务返回了无效响应".to_string(),
                            status: Some(status),
                        }
                    });
                }

                let body = response
                    .json::<serde_json::Value>()
                    .await
                    .unwrap_or_else(|_| json!({}));
                let (kind, message) = format_upstream_message("上游模型接口失败", status, &body);
                let error = AgentEndpointStatus {
                    ok: false,
                    kind: Some(kind.clone()),
                    message,
                    status: Some(status),
                };
                if attempt == 0 && should_retry_status(status) {
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
            Err(err) => {
                let kind = classify_reqwest_error(&err).to_string();
                let error = AgentEndpointStatus {
                    ok: false,
                    kind: Some(kind.clone()),
                    message: match kind.as_str() {
                        "timeout" => "Agent 请求超时，请稍后重试".to_string(),
                        "connect" => "无法连接 Agent 服务，请检查网络或后端地址".to_string(),
                        _ => err.to_string(),
                    },
                    status: None,
                };
                if attempt == 0 && should_retry_error_kind(&kind) {
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
        }
    }

    Err(last_error.unwrap_or(AgentEndpointStatus {
        ok: false,
        kind: Some("invalid_response".to_string()),
        message: "请求失败".to_string(),
        status: None,
    }))
}

// 部分上游模型（例如规划用的 gpt-5.6-luna）只接受 OpenAI Responses API
// （POST {base}/v1/responses），不再支持传统的 /chat/completions。
// 直接走 /chat/completions 会得到类似 "模型 gpt-5.6-luna 不支持 chat completions"
// 的错误。这里通过 Responses API 入口调用，并在外层做必要时回退到 chat completions。
async fn post_responses_api(
    base_url: &str,
    token: &str,
    body: serde_json::Value,
) -> Result<(serde_json::Value, u16), AgentEndpointStatus> {
    // base_url 可能是 https://host，也可能是 https://host/v1 或 .../api/paas/v4。
    // 已带版本段的不重复追加。
    let trimmed = base_url.trim().trim_end_matches('/');
    let normalized = normalize_agent_base_url(trimmed);
    let url = format!("{}/responses", normalized);

    let response = HTTP_CLIENT
        .post(&url)
        .bearer_auth(token)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|err| {
            let kind = classify_reqwest_error(&err);
            AgentEndpointStatus {
                ok: false,
                kind: Some(kind.to_string()),
                message: match kind {
                    "timeout" => "Agent 请求超时，请稍后重试".to_string(),
                    "connect" => "无法连接 Agent 服务，请检查网络或后端地址".to_string(),
                    _ => format!("Agent 请求失败：{err}"),
                },
                status: None,
            }
        })?;

    // 关键：response body 只读取一次。早期实现里曾出现"先日志后 json()"的双重消费，
    // 这里把 body 文本一次性读出来再交给 serde，所有后续逻辑共用同一份字符串。
    let status = response.status().as_u16();
    let body_text = response.text().await.unwrap_or_default();
    let body_value: serde_json::Value = serde_json::from_str(&body_text).unwrap_or_else(|_| {
        // 解析失败时保留原始文本的 preview 进 diagnostic，但仍以空对象兜底。
        println!(
            "[ResponsesAdapter] body_parse_failed http_status={} body_len={} preview={:?}",
            status,
            body_text.chars().count(),
            body_text.chars().take(500).collect::<String>(),
        );
        json!({})
    });

    if status >= 200 && status < 300 {
        return Ok((body_value, status));
    }

    let (detail, code) = extract_error_parts_from_value(&body_value);
    let kind = classify_upstream_error(status, detail.as_deref(), code.as_deref());
    let message = build_upstream_error_message(
        "上游模型接口失败",
        status,
        &kind,
        detail.as_deref(),
        code.as_deref(),
    );
    Err(AgentEndpointStatus {
        ok: false,
        kind: Some(kind),
        message,
        status: Some(status),
    })
}

// ============================================================================
// Responses Payload Recovery —— Retrieve + SSE Streaming Fallback
//
// 触发条件：Primary POST 返回 HTTP 2xx + status=completed + has_error=false
//           + extract_final_responses_text_with_source 返回 None + output_count=0
//           + usage.output_tokens > 0。
//
// 这意味着 Provider 记录了 token 但最终 payload 丢失了 output。直接再原样 POST
// 一次只会重复消耗 token，因此进入如下两阶段恢复：
//   1. Retrieve：GET {base}/v1/responses/{id} —— 不再消耗模型 token，
//      OpenAI 协议要求 Retrieve 返回与 POST 等价的完整 Response 对象。
//   2. SSE Streaming Fallback：POST {base}/v1/responses + stream=true，
//      从 response.output_text.delta 增量事件直接收集模型正文。
//
// 总预算：1 Primary + 1 Retrieve + 1 Stream，不允许循环。
// ============================================================================

/// Recovery 阶段 1：Retrieve existing Response by id。
///
/// 协议：GET {base}/v1/responses/{response_id}，与 Primary 共用 Authorization / base_url。
/// 这不会触发新的模型推理，是成本最低的恢复手段，优先尝试。
async fn retrieve_responses_recovery(
    base_url: &str,
    token: &str,
    response_id: &str,
) -> ResponsesRecoveryOutcome {
    let trimmed = base_url.trim().trim_end_matches('/');
    let normalized = if trimmed.ends_with("/v1") {
        trimmed.to_string()
    } else if trimmed.ends_with("/v1/") {
        trimmed.trim_end_matches('/').to_string()
    } else {
        format!("{}/v1", trimmed)
    };
    let url = format!("{}/responses/{}", normalized, response_id);

    println!(
        "[ResponsesRecovery] stage=retrieve response_id={:?} url_prefix={:?}",
        response_id,
        normalized, // 不打印完整 URL / token；只打印 base 前缀
    );

    let response = match HTTP_CLIENT
        .get(&url)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(r) => r,
        Err(err) => {
            let kind = classify_reqwest_error(&err);
            return ResponsesRecoveryOutcome::Failed {
                kind: kind.to_string(),
                reason: format!("Retrieve transport error: {err}"),
                http_status: None,
            };
        }
    };

    let status = response.status().as_u16();
    let body_text = response.text().await.unwrap_or_default();
    let body_value: serde_json::Value = serde_json::from_str(&body_text).unwrap_or_else(|_| {
        println!(
            "[ResponsesRecovery] stage=retrieve body_parse_failed http_status={} body_len={}",
            status,
            body_text.chars().count(),
        );
        json!({})
    });

    // HTTP 404 / 405 / 501 视为 Provider 不支持 Retrieve endpoint（兼容代理常见情况）。
    if matches!(status, 404 | 405 | 501) {
        let reason = format!("Provider Retrieve endpoint not supported (HTTP {})", status);
        println!(
            "[ResponsesRecovery] stage=retrieve result=unsupported http_status={} response_status={:?}",
            status,
            body_value.get("status").and_then(|v| v.as_str()),
        );
        return ResponsesRecoveryOutcome::Unsupported {
            reason,
            http_status: Some(status),
        };
    }

    if !(200..300).contains(&status) {
        let (msg, _kind, code, _param) = extract_full_error_parts_from_value(&body_value);
        let reason = msg
            .clone()
            .unwrap_or_else(|| format!("Retrieve HTTP {} with no error body", status));
        println!(
            "[ResponsesRecovery] stage=retrieve result=failed http_status={} code={:?} reason_preview={:?}",
            status,
            code.as_deref(),
            reason.chars().take(160).collect::<String>(),
        );
        return ResponsesRecoveryOutcome::Failed {
            kind: code.unwrap_or_else(|| format!("http_{}", status)),
            reason,
            http_status: Some(status),
        };
    }

    // 2xx —— 复用统一 extractor，绝不另写一份提取逻辑。
    if let Some((text, source)) = extract_final_responses_text_with_source(&body_value) {
        println!(
            "[ResponsesRecovery] stage=retrieve result=recovered text_len={} source={:?} response_status={:?}",
            text.chars().count(),
            source,
            body_value.get("status").and_then(|v| v.as_str()),
        );
        return ResponsesRecoveryOutcome::Recovered {
            text,
            source: format!("retrieve:{:?}", source),
        };
    }

    let response_status = body_value
        .get("status")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    println!(
        "[ResponsesRecovery] stage=retrieve result=empty http_status={} response_status={:?} output_count={}",
        status,
        response_status.as_deref(),
        body_value.get("output").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
    );
    ResponsesRecoveryOutcome::Empty {
        http_status: Some(status),
        response_status,
    }
}

// ---------------------- SSE Streaming Fallback ----------------------
//
// SSE 增量解析器设计要点：
//   1. 网络字节流可能把一个 UTF-8 字符或一个 SSE 事件切到任意位置，
//      因此用 `Vec<u8>` 做 buffer，按 ASCII 边界标记（`\n\n` / `\r\n\r\n`）切片。
//      UTF-8 编码保证多字节字符的子字节不会与 ASCII 字符重合，所以按字节查找分隔符是安全的。
//   2. 完整事件 block（分隔符之间的内容）才解码为字符串，避免半截 UTF-8 序列。
//   3. 一个 block 可能包含多行 `event:` / `data:`，且 `type` 字段可能来自 SSE event 行
//      也可能来自 data JSON —— 两者都要兼容。
//   4. `[DONE]` 是 OpenAI 流式协议的终止哨兵，不是 JSON —— 不要尝试解析它。

/// 单个 SSE 事件解析结果。`event_type` 优先取 `event:` 行，否则取 data JSON 里的 `type` 字段。
#[derive(Debug, Clone)]
struct SseParsedEvent {
    event_type: String,
    data: serde_json::Value,
}

/// 从 buffer 头部找下一个完整事件范围。
/// 返回 (事件字节数, 含分隔符在内的总长度)。None 表示 buffer 还没有完整事件。
///
/// 优先匹配 `\r\n\r\n`（兼容 CRLF），再匹配 `\n\n`（标准 SSE）。
/// 两者都是 ASCII 序列，按字节查找是 UTF-8 安全的。
fn next_sse_event_range(buffer: &[u8]) -> Option<(usize, usize)> {
    let rel_crlf = buffer.windows(4).position(|w| w == b"\r\n\r\n");
    let rel_lf = buffer.windows(2).position(|w| w == b"\n\n");
    match (rel_crlf, rel_lf) {
        (Some(rc), Some(rl)) => {
            // 取更靠前的那个；若 CRLF 与 LF 在同一位置（CRLF 包含 LF）则按 CRLF 处理。
            if rc <= rl {
                Some((rc, rc + 4))
            } else {
                Some((rl, rl + 2))
            }
        }
        (Some(rc), None) => Some((rc, rc + 4)),
        (None, Some(rl)) => Some((rl, rl + 2)),
        (None, None) => None,
    }
}

/// 把一个完整 SSE event block 解析成结构化事件。block 内可能包含多行 event:/data:。
/// 容错：data 不是合法 JSON（或为 `[DONE]`）时返回 None，由调用方决定是否终止。
fn parse_sse_event(block: &[u8]) -> Option<SseParsedEvent> {
    // 此时 block 是有效的 UTF-8（因为我们按 ASCII 分隔符切片，且整个 stream 都是 UTF-8）。
    // 但理论上 chunk 边界仍可能把多字节字符切到下一个 chunk —— 不过这里 block 已经是
    // 完整事件（两个分隔符之间），所以一定是一段完整的 UTF-8 文本。
    let block_str = std::str::from_utf8(block).ok()?;
    let mut event_type_from_line: Option<String> = None;
    let mut data_lines: Vec<String> = Vec::new();

    for line in block_str.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("event:") {
            event_type_from_line = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim().to_string());
        }
        // SSE 规范还定义了 id:/retry:/注释（: 开头）字段 —— 这里不需要处理。
    }

    let data_raw = data_lines.join("\n");
    if data_raw.is_empty() {
        return None;
    }
    if data_raw.trim() == "[DONE]" {
        return Some(SseParsedEvent {
            event_type: "[done]".to_string(),
            data: serde_json::Value::Null,
        });
    }
    let data: serde_json::Value = serde_json::from_str(&data_raw).ok()?;
    let event_type = event_type_from_line
        .filter(|s| !s.is_empty())
        .or_else(|| {
            data.get("type")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();
    if event_type.is_empty() {
        return None;
    }
    Some(SseParsedEvent { event_type, data })
}

/// Recovery 阶段 2：POST /v1/responses + stream=true，从 SSE 增量事件收集模型正文。
///
/// 与 Primary 完全共用 base_url / token / model / input snapshot。仅多加 `stream: true`。
/// 内部维护 buffer 增量解析事件，文本聚合优先级：
///   1. response.output_text.delta 累积（最常见，逐 token 增量）
///   2. response.output_text.done 携带的完整 text（部分代理不发 delta 只发 done）
///   3. response.completed 内部 response 对象走统一 extractor（兜底）
async fn stream_responses_recovery(
    base_url: &str,
    token: &str,
    primary_body: serde_json::Value,
) -> ResponsesRecoveryOutcome {
    use futures_util::StreamExt;

    let trimmed = base_url.trim().trim_end_matches('/');
    let normalized = if trimmed.ends_with("/v1") {
        trimmed.to_string()
    } else if trimmed.ends_with("/v1/") {
        trimmed.trim_end_matches('/').to_string()
    } else {
        format!("{}/v1", trimmed)
    };
    let url = format!("{}/responses", normalized);

    // 复用 Primary 的同一份 body 快照，只覆盖 stream=true。
    // 不允许在此处重新读取 system prompt / user input —— 必须保持与 Primary 同源。
    let mut stream_body = primary_body;
    if let Some(obj) = stream_body.as_object_mut() {
        obj.insert("stream".to_string(), json!(true));
    } else {
        return ResponsesRecoveryOutcome::Failed {
            kind: "internal".to_string(),
            reason: "Primary body is not a JSON object; cannot attach stream=true".to_string(),
            http_status: None,
        };
    }

    println!(
        "[ResponsesRecovery] stage=stream url_prefix={:?} body_top_keys={:?}",
        normalized,
        stream_body
            .as_object()
            .map(|m| m.keys().cloned().collect::<Vec<_>>()),
    );

    let response = match HTTP_CLIENT
        .post(&url)
        .bearer_auth(token)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .json(&stream_body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(err) => {
            let kind = classify_reqwest_error(&err);
            return ResponsesRecoveryOutcome::Failed {
                kind: kind.to_string(),
                reason: format!("Stream transport error: {err}"),
                http_status: None,
            };
        }
    };

    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    if !(200..300).contains(&status) {
        // 非 2xx：尝试解析 body 拿到错误信息。
        let body_text = response.text().await.unwrap_or_default();
        let body_value: serde_json::Value =
            serde_json::from_str(&body_text).unwrap_or_else(|_| json!({}));
        let (msg, kind, code, _param) = extract_full_error_parts_from_value(&body_value);
        let lower_code = code.as_deref().unwrap_or("").to_ascii_lowercase();
        let lower_kind = kind.as_deref().unwrap_or("").to_ascii_lowercase();
        let reason = msg.unwrap_or_else(|| format!("Stream HTTP {}", status));

        // unsupported_parameter / invalid_request 类的参数错误 —— 不属于"流式不支持"，
        // 但仍然归类为 Failed，让 recovery 终止；UI 会显示真正的参数错。
        // 这里专门检测"streaming not supported"语义的反馈。
        let looks_unsupported = lower_code.contains("unsupported")
            || lower_code.contains("stream")
            || lower_kind.contains("unsupported")
            || reason.to_ascii_lowercase().contains("stream");
        if looks_unsupported {
            println!(
                "[ResponsesRecovery] stage=stream result=unsupported http_status={} code={:?}",
                status,
                code.as_deref(),
            );
            return ResponsesRecoveryOutcome::Unsupported {
                reason,
                http_status: Some(status),
            };
        }
        println!(
            "[ResponsesRecovery] stage=stream result=failed http_status={} code={:?} reason_preview={:?}",
            status,
            code.as_deref(),
            reason.chars().take(160).collect::<String>(),
        );
        return ResponsesRecoveryOutcome::Failed {
            kind: code.unwrap_or_else(|| format!("http_{}", status)),
            reason,
            http_status: Some(status),
        };
    }

    // 2xx —— 但 Provider 可能没真的发 SSE，而是把整份 JSON 当响应体返回。
    // content_type 不是 text/event-stream 时，直接读完整 body 走统一 extractor。
    if !content_type.contains("text/event-stream") {
        let body_text = response.text().await.unwrap_or_default();
        let body_value: serde_json::Value =
            serde_json::from_str(&body_text).unwrap_or_else(|_| json!({}));
        if let Some((text, source)) = extract_final_responses_text_with_source(&body_value) {
            println!(
                "[ResponsesRecovery] stage=stream result=recovered_via_non_sse_body content_type={:?} text_len={} source={:?}",
                content_type,
                text.chars().count(),
                source,
            );
            return ResponsesRecoveryOutcome::Recovered {
                text,
                source: format!("StreamingNonSseBody:{:?}", source),
            };
        }
        println!(
            "[ResponsesRecovery] stage=stream result=empty content_type={:?} (Provider 2xx 但未返回 event-stream，且 body 无 final text)",
            content_type,
        );
        return ResponsesRecoveryOutcome::Empty {
            http_status: Some(status),
            response_status: body_value
                .get("status")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        };
    }

    // 真正的 SSE 流 —— 增量解析。
    let mut byte_buffer: Vec<u8> = Vec::with_capacity(8192);
    let mut text_buffer = String::new();
    let mut done_event_text: Option<String> = None;
    let mut completed_response: Option<serde_json::Value> = None;
    let mut event_count = 0u32;
    let mut text_delta_count = 0u32;
    let mut failed_payload: Option<(String, String)> = None;
    let mut stream_done = false;

    let mut bytes_stream = response.bytes_stream();
    while let Some(chunk_result) = bytes_stream.next().await {
        let chunk = match chunk_result {
            Ok(c) => c,
            Err(err) => {
                let kind = classify_reqwest_error(&err);
                println!(
                    "[ResponsesRecovery] stage=stream chunk_read_error kind={} msg={}",
                    kind, err,
                );
                return ResponsesRecoveryOutcome::Failed {
                    kind: kind.to_string(),
                    reason: format!("Stream read error: {err}"),
                    http_status: Some(status),
                };
            }
        };
        byte_buffer.extend_from_slice(&chunk);

        // 反复从 buffer 头部取出完整事件，直到剩下的不足一个事件。
        while let Some(range) = next_sse_event_range(&byte_buffer) {
            let (event_end, total_end) = range;
            // block = byte_buffer[0..event_end]（不含分隔符）
            let block_bytes: Vec<u8> = byte_buffer.drain(..total_end).collect();
            let block = &block_bytes[..event_end];
            let parsed = match parse_sse_event(block) {
                Some(p) => p,
                None => continue,
            };
            event_count += 1;
            let etype = parsed.event_type.as_str();

            // 安全日志：只打 event 类型 + delta 长度，绝不打印 delta 内容。
            if etype == "response.output_text.delta" {
                if let Some(delta) = parsed.data.get("delta").and_then(|v| v.as_str()) {
                    text_buffer.push_str(delta);
                    text_delta_count += 1;
                }
                if cfg!(debug_assertions) && text_delta_count % 16 == 1 {
                    let delta_len = parsed
                        .data
                        .get("delta")
                        .and_then(|v| v.as_str())
                        .map(|s| s.chars().count())
                        .unwrap_or(0);
                    println!(
                        "[ResponsesStream] event={} delta_len={} total_text_len={} delta_count={}",
                        etype,
                        delta_len,
                        text_buffer.chars().count(),
                        text_delta_count,
                    );
                }
            } else if etype == "response.output_text.done" {
                if text_buffer.is_empty() {
                    if let Some(text) = parsed.data.get("text").and_then(|v| v.as_str()) {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            done_event_text = Some(trimmed.to_string());
                        }
                    }
                }
                if cfg!(debug_assertions) {
                    println!(
                        "[ResponsesStream] event={} done_text_len={}",
                        etype,
                        parsed
                            .data
                            .get("text")
                            .and_then(|v| v.as_str())
                            .map(|s| s.chars().count())
                            .unwrap_or(0),
                    );
                }
            } else if etype == "response.completed" {
                if let Some(resp) = parsed.data.get("response") {
                    completed_response = Some(resp.clone());
                }
                stream_done = true;
                if cfg!(debug_assertions) {
                    println!(
                        "[ResponsesStream] event={} has_response={} events_so_far={}",
                        etype,
                        completed_response.is_some(),
                        event_count,
                    );
                }
            } else if etype == "response.failed" {
                if let Some(resp) = parsed.data.get("response") {
                    let (msg, _t, code, _p) = extract_full_error_parts_from_value(resp);
                    failed_payload = Some((
                        code.unwrap_or_else(|| "response_failed".to_string()),
                        msg.unwrap_or_else(|| "Responses streaming response.failed".to_string()),
                    ));
                } else {
                    failed_payload = Some((
                        "response_failed".to_string(),
                        "Responses streaming response.failed with no body".to_string(),
                    ));
                }
                if cfg!(debug_assertions) {
                    println!(
                        "[ResponsesStream] event={} events_so_far={}",
                        etype, event_count
                    );
                }
            } else if etype == "error" {
                let (msg, _t, code, _p) = extract_full_error_parts_from_value(&parsed.data);
                failed_payload = Some((
                    code.unwrap_or_else(|| "stream_error".to_string()),
                    msg.unwrap_or_else(|| "Responses streaming error event".to_string()),
                ));
                if cfg!(debug_assertions) {
                    println!(
                        "[ResponsesStream] event={} events_so_far={}",
                        etype, event_count
                    );
                }
            } else if etype == "[done]" {
                stream_done = true;
                if cfg!(debug_assertions) {
                    println!(
                        "[ResponsesStream] event=[DONE] events_so_far={}",
                        event_count
                    );
                }
            } else if cfg!(debug_assertions) {
                // 只在 debug 模式下打印事件类型 + 顶层 keys，避免日志爆炸 / 泄漏正文。
                let keys: Vec<&str> = parsed
                    .data
                    .as_object()
                    .map(|m| m.keys().map(String::as_str).collect())
                    .unwrap_or_default();
                println!(
                    "[ResponsesStream] event={} keys={:?} events_so_far={}",
                    etype, keys, event_count,
                );
            }
        }
    }

    println!(
        "[ResponsesStream] completed events={} text_delta_events={} text_len={} has_failed={} done_text_present={} completed_response_present={}",
        event_count,
        text_delta_count,
        text_buffer.chars().count(),
        failed_payload.is_some(),
        done_event_text.is_some(),
        completed_response.is_some(),
    );

    if let Some((code, msg)) = failed_payload {
        return ResponsesRecoveryOutcome::Failed {
            kind: code,
            reason: msg,
            http_status: Some(status),
        };
    }

    if !text_buffer.is_empty() {
        return ResponsesRecoveryOutcome::Recovered {
            text: text_buffer,
            source: "StreamingDelta".to_string(),
        };
    }
    if let Some(text) = done_event_text {
        return ResponsesRecoveryOutcome::Recovered {
            text,
            source: "StreamingOutputTextDone".to_string(),
        };
    }
    if let Some(resp) = completed_response {
        if let Some((text, source)) = extract_final_responses_text_with_source(&resp) {
            return ResponsesRecoveryOutcome::Recovered {
                text,
                source: format!("StreamingCompletedResponse:{:?}", source),
            };
        }
    }

    let _ = stream_done; // stream_done 仅用于调试，最终判定走 text/failed 三条路径
    ResponsesRecoveryOutcome::Empty {
        http_status: Some(status),
        response_status: Some("completed".to_string()),
    }
}

///   - 字符串：截断到 `max_str` 字符（按 Unicode scalar），超出加 "..." 后缀
///   - 数组：只保留前 `max_arr` 项，超出加 "(N more)" 后缀
///   - 对象：递归深度限制为 `depth`；超过则替换为 `<omitted>`
///   - 数字 / bool / null 原样输出
///
/// 不读取任何字段名做特殊处理 —— 这是通用的 redact 工具，调用方决定传入哪一棵子树。
fn redact_json(value: &serde_json::Value, max_str: usize, max_arr: usize, depth: u32) -> String {
    match value {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => {
            let chars: Vec<char> = s.chars().collect();
            if chars.len() <= max_str {
                serde_json::to_string(s).unwrap_or_else(|_| "\"<unprintable>\"".to_string())
            } else {
                let head: String = chars.iter().take(max_str).collect();
                format!("\"{}...\"", head.replace('\\', "\\\\").replace('"', "\\\""))
            }
        }
        serde_json::Value::Array(arr) => {
            if depth == 0 {
                return "<omitted>".to_string();
            }
            if arr.is_empty() {
                return "[]".to_string();
            }
            let head: Vec<String> = arr
                .iter()
                .take(max_arr)
                .map(|v| redact_json(v, max_str, max_arr, depth - 1))
                .collect();
            if arr.len() > max_arr {
                format!("[{}, ({} more)]", head.join(", "), arr.len() - max_arr)
            } else {
                format!("[{}]", head.join(", "))
            }
        }
        serde_json::Value::Object(map) => {
            if depth == 0 {
                return "<omitted>".to_string();
            }
            if map.is_empty() {
                return "{}".to_string();
            }
            let entries: Vec<String> = map
                .iter()
                .map(|(k, v)| format!("{:?}: {}", k, redact_json(v, max_str, max_arr, depth - 1)))
                .collect();
            format!("{{{}}}", entries.join(", "))
        }
    }
}

/// 构造一段安全的 "Responses Raw Shape Diagnostic" 日志行。
/// 仅挑选对诊断 upstream 行为最有价值的字段：status / model / error / last_error /
/// incomplete_details / output / text / reasoning / choices / usage，并对每个字段值
/// 调用 redact_json 做长度 / 数量限制。
///
/// 响应 body 本身不含鉴权信息（API Key 在 request header），但仍按字段单独 redact，
/// 以避免任何意外（例如 reasoning.summary 偶尔会包含用户原 prompt 的回显）。
fn build_responses_raw_shape_summary(body: &serde_json::Value) -> String {
    let pick = |key: &str| -> String {
        match body.get(key) {
            None => "null".to_string(),
            Some(v) => redact_json(v, 500, 3, 3),
        }
    };
    let id = body.get("id").and_then(|v| v.as_str()).unwrap_or("<none>");
    let object = body
        .get("object")
        .and_then(|v| v.as_str())
        .unwrap_or("<none>");
    format!(
        "id={:?} object={:?} status={} model={} error={} last_error={} incomplete_details={} output={} text={} reasoning={} choices={} usage={}",
        id,
        object,
        pick("status"),
        pick("model"),
        pick("error"),
        pick("last_error"),
        pick("incomplete_details"),
        pick("output"),
        pick("text"),
        pick("reasoning"),
        pick("choices"),
        pick("usage"),
    )
}

// 将 Responses API 的返回体（包含 output / output_text 字段）规整成
// 与 /chat/completions 兼容的 {choices:[{message:{content}}]} 形态，
// 这样上层解析逻辑可以共用。同时构造一份结构化诊断，无论成功 / 失败都回填到
// AgentRunResult.planner_diagnostic，让 TS 端 "查看规划详情" 可以显示
// HTTP / Responses Status / Output Types / Content Types / Text Length，
// 而不是只能看到一句 "response_text_missing"。
fn responses_body_normalize(
    value: serde_json::Value,
    http_status: u16,
) -> (serde_json::Value, ResponsesShapeDiagnostic) {
    let extracted = extract_final_responses_text_with_source(&value);
    let text = extracted.as_ref().map(|(t, _)| t.clone());
    let text_source = extracted.as_ref().map(|(_, s)| s.clone());
    let extracted_text_len = text.as_deref().map(|s| s.chars().count()).unwrap_or(0);
    let diag = build_responses_diagnostic(http_status, &value, extracted_text_len);

    println!(
        "[ResponsesAdapter] http_status={} response_status={:?} output_count={} output_types={:?} content_types={:?} has_top_output_text={} has_choices={} has_error={} extracted_text_len={} text_source={:?}",
        http_status,
        diag.response_status,
        diag.output_count,
        diag.output_types,
        diag.content_types,
        diag.has_top_level_output_text,
        diag.has_choices,
        diag.has_error,
        diag.extracted_text_len,
        text_source,
    );

    // v3.0.5：开发态额外打印一份脱敏后的 Raw Shape Diagnostic。
    // 目的：当出现 "HTTP 200 + status=completed + output=[]" 这种结构化 diag
    // 无法立刻定位的奇怪返回时，能在日志里直接看到 status / model / error /
    // last_error / incomplete_details / output / text / reasoning / usage 等字段的
    // 真实内容，从而判断到底是 packy 没填、还是放到了非标准位置。
    //
    // 安全约束：响应 body 里不含 API Key / Authorization / 用户原 prompt / 图片 base64
    // （这些都在 request 端）。仍会对所有字符串/数组做长度上限 + 数量上限，避免日志爆炸。
    if cfg!(debug_assertions) {
        println!(
            "[ResponsesRawDiagnostic] {}",
            build_responses_raw_shape_summary(&value)
        );
    }

    if let Some(text) = text {
        let normalized = json!({
            "choices": [
                {
                    "message": {
                        "content": text
                    }
                }
            ],
            "usage": value.get("usage").cloned().unwrap_or(json!({}))
        });
        (normalized, diag)
    } else {
        // 兜底：保留原始 body，让上层根据 diag 自行判断到底发生了什么。
        (value, diag)
    }
}

/// 构造 ResponsesShapeDiagnostic —— 把 body 的关键 shape 摘要出来。
/// 注意：这里绝不读取 Authorization / token / 完整 body 文本，只摘要结构信息。
fn build_responses_diagnostic(
    http_status: u16,
    body: &serde_json::Value,
    extracted_text_len: usize,
) -> ResponsesShapeDiagnostic {
    let top_level_keys: Vec<String> = body
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();

    let response_status = body
        .get("status")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let output_array = body.get("output").and_then(|v| v.as_array());
    let output_count = output_array.map(|a| a.len()).unwrap_or(0);
    let output_types: Vec<String> = output_array
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    item.get("type")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .collect()
        })
        .unwrap_or_default();

    // 收集所有 message.content[] 的 type（去重保序）
    let mut content_types: Vec<String> = Vec::new();
    if let Some(arr) = output_array {
        for item in arr {
            if matches!(item.get("type").and_then(|v| v.as_str()), Some("message")) {
                if let Some(content) = item.get("content").and_then(|v| v.as_array()) {
                    for piece in content {
                        if let Some(t) = piece.get("type").and_then(|v| v.as_str()) {
                            let owned = t.to_string();
                            if !content_types.contains(&owned) {
                                content_types.push(owned);
                            }
                        }
                    }
                }
            }
        }
    }

    let has_top_level_output_text = body.get("output_text").is_some();
    let has_choices = body
        .get("choices")
        .and_then(|v| v.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    let incomplete_reason = body
        .get("incomplete_details")
        .and_then(|v| v.get("reason"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // 关键修复（v3.0.5）：把 upstream error 的"是否报错"和"报错内容"统一到
    // 同一份 extract_full_error_parts_from_value 上。这样 `has_error` 不再因为
    // JSON 里存在 `error: null` 就被错判成 true，与 upstream_error_* 字段也不再漂移。
    //   - `"error": null` → has_error=false, upstream_error_*=None
    //   - `"error": {}`  → has_error=false, upstream_error_*=None
    //   - `"error": {"message": null, "code": null}` → has_error=false, upstream_error_*=None
    //   - `"error": {"message": "x"}` → has_error=true, upstream_error_message=Some("x")
    //   - `"last_error": null` → has_error=false
    //   - `"last_error": {"code": "server_error", ...}` → has_error=true
    //
    // has_meaningful_upstream_error 是该项目意义上"上游是否真的报错"的单一来源；
    // 这里再用 extract_full_error_parts_from_value 取一次具体字段，两份信息都来自
    // 同一个纯函数，永远不会漂移。
    let has_error = has_meaningful_upstream_error(body);
    let (upstream_error_message, upstream_error_type, upstream_error_code, upstream_error_param) =
        if has_error {
            extract_full_error_parts_from_value(body)
        } else {
            (None, None, None, None)
        };

    ResponsesShapeDiagnostic {
        http_status: Some(http_status),
        response_status,
        top_level_keys,
        output_count,
        output_types,
        content_types,
        has_top_level_output_text,
        has_choices,
        has_error,
        extracted_text_len,
        incomplete_reason,
        upstream_error_message,
        upstream_error_type,
        upstream_error_code,
        upstream_error_param,
        response_id: body
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        output_tokens: extract_output_token_count(body),
        input_tokens: body
            .get("usage")
            .and_then(|u| u.get("input_tokens"))
            .and_then(value_as_u64),
        reasoning_tokens: body
            .get("usage")
            .and_then(|u| u.get("output_tokens_details"))
            .and_then(|d| d.get("reasoning_tokens"))
            .and_then(value_as_u64)
            .or_else(|| {
                body.get("usage")
                    .and_then(|u| u.get("reasoning_tokens"))
                    .and_then(value_as_u64)
            }),
        finish_reason: None,
        auto_retry: None,
    }
}

/// 从 Responses body 中读取 `usage.output_tokens`。
///
/// 兼容三种结构：
///   - `{"usage":{"output_tokens":544}}`（OpenAI 标准 / Packy 实测形态）
///   - `{"output_tokens":544}`（扁平化兜底，少数代理这么做）
///   - `{"usage":{"output_tokens":"544"}}`（字符串形态兜底）
///
/// 不存在 → `None`。注意 `None` 与 `Some(0)` 语义不同：
///   - `None` 表示上游 usage 没填该字段，无法判断"模型是否真的产生了 token"
///   - `Some(0)` 表示上游明确告知本轮没有产生任何 output token
///
/// 这一区分是 `is_provider_response_payload_missing` 的核心依据。
pub(crate) fn extract_output_token_count(body: &serde_json::Value) -> Option<u64> {
    let from_usage = body
        .get("usage")
        .and_then(|u| u.get("output_tokens"))
        .and_then(value_as_u64);
    if from_usage.is_some() {
        return from_usage;
    }
    body.get("output_tokens").and_then(value_as_u64)
}

fn value_as_u64(v: &serde_json::Value) -> Option<u64> {
    match v {
        serde_json::Value::Number(n) => n.as_u64(),
        serde_json::Value::String(s) => s.trim().parse::<u64>().ok(),
        _ => None,
    }
}

/// 单一来源的 "Provider Payload Missing" 判定。
///
/// 触发条件（全部成立）：
///   1. HTTP 2xx（成功响应）
///   2. Responses `status == "completed"`
///   3. `has_meaningful_upstream_error == false`（不是真正的上游报错）
///   4. `extract_final_responses_text_with_source(body) == None`（拿不到 final text）
///   5. `output` 数组里没有有效的 message item（output 为空 / 只有非 message item）
///   6. `usage.output_tokens > 0`（模型本轮真的产生了 token，但最终 payload 缺失）
///
/// 这条规则只在 **Provider 行为异常**（Packy 等代理记录了 token 却丢失 output）
/// 时为 true；普通 "模型本轮没说话"（tokens=0 或 usage 缺失）仍属于
/// `response_text_missing`，由 `classify_missing_text` 处理。
///
/// 入口单一 —— 项目里任何需要判定此场景的地方都必须走这个函数，不允许重复实现。
pub(crate) fn is_provider_response_payload_missing(
    http_status: u16,
    body: &serde_json::Value,
    diagnostic: &ResponsesShapeDiagnostic,
) -> bool {
    // 1. HTTP 2xx
    if !(200..300).contains(&http_status) {
        return false;
    }
    // 2. status == completed（None 也允许 —— 个别代理 status 字段缺失但 HTTP 200）
    if let Some(status) = diagnostic.response_status.as_deref() {
        if status != "completed" {
            return false;
        }
    }
    // 3. 不能是真正的上游报错
    if diagnostic.has_error {
        return false;
    }
    // 4. 必须拿不到 final text
    if extract_final_responses_text_with_source(body).is_some() {
        return false;
    }
    // 5. output 必须没有有效 message —— 简化为 output_count == 0
    //    （reasoning-only 场景理论上也可能满足，但那种情况 output_tokens 通常为 0
    //     或较少；为了规则简单 + 严格，这里要求 output_count == 0）
    if diagnostic.output_count > 0 {
        // output 里有东西但 extractor 拿不到 —— 这种情况留给 response_text_missing
        return false;
    }
    // 6. 必须有 output_tokens > 0 的明确证据
    matches!(diagnostic.output_tokens, Some(tokens) if tokens > 0)
}

/// 标记 `extract_final_responses_text_with_source` 实际命中了哪一种 Responses 文本
/// 形态。日志会把它作为 `text_source=...` 输出，未来再出现 "成功但前端拿不到文本"
/// 时能立刻判断是 extractor 选错分支，还是上游根本没产出 final text。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ResponsesTextSource {
    /// 顶层 `output_text` 字段（OpenAI Responses SDK stream=false 时常用）。
    TopLevelOutputText,
    /// `output[].message.content[].output_text` / `.text`（标准 Responses 形态）。
    OutputMessageContentText,
    /// 递归兜底命中（兼容历史 / 非标准代理）。仅收集 output_text 字段或
    /// `{type:output_text,text}` 对象，不会误识别 reasoning。
    RecursiveFallback,
    /// `choices[0].message.content`（chat-completions 直通形态）。
    ChoicesMessageContent,
}

/// 与 `extract_final_responses_text` 相同的提取逻辑，但额外返回命中的 source。
/// 诊断日志使用此变体，主路径仍走 `extract_final_responses_text` 以保持稳定 ABI。
pub(crate) fn extract_final_responses_text_with_source(
    body: &serde_json::Value,
) -> Option<(String, ResponsesTextSource)> {
    // 1. 顶层 output_text
    if let Some(text) = body.get("output_text").and_then(|v| v.as_str()) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some((trimmed.to_string(), ResponsesTextSource::TopLevelOutputText));
        }
    }

    let output_array = body.get("output").and_then(|v| v.as_array());

    // 2 + 3. message → content → output_text/text
    if let Some(arr) = output_array {
        let mut ordered_parts: Vec<String> = Vec::new();
        for item in arr {
            if !matches!(item.get("type").and_then(|v| v.as_str()), Some("message")) {
                continue;
            }
            let content = item.get("content").and_then(|v| v.as_array());
            if let Some(content_arr) = content {
                for piece in content_arr {
                    let piece_type = piece.get("type").and_then(|v| v.as_str());
                    let text_value = piece.get("text").and_then(|v| v.as_str());
                    if let Some(text) = text_value {
                        let trimmed = text.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let is_output_text =
                            piece_type.is_none() || piece_type == Some("output_text");
                        if is_output_text {
                            ordered_parts.push(trimmed.to_string());
                        }
                    }
                }
            }
        }
        if !ordered_parts.is_empty() {
            let joined = ordered_parts.join("\n").trim().to_string();
            if !joined.is_empty() {
                return Some((joined, ResponsesTextSource::OutputMessageContentText));
            }
        }
    }

    // 4. 递归兜底
    let mut fallback_parts: Vec<String> = Vec::new();
    collect_response_output_text(body, &mut fallback_parts);
    if !fallback_parts.is_empty() {
        let joined = fallback_parts.join("\n").trim().to_string();
        if !joined.is_empty() {
            return Some((joined, ResponsesTextSource::RecursiveFallback));
        }
    }

    // 5. chat-completions choices 兼容
    let choices_text = body
        .get("choices")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|first| first.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string());
    if choices_text
        .as_deref()
        .map(|s| !s.is_empty())
        .unwrap_or(false)
    {
        return Some((
            choices_text.unwrap(),
            ResponsesTextSource::ChoicesMessageContent,
        ));
    }

    None
}

/// 单一的 final-text 提取入口。优先级严格按以下顺序：
///
/// 1. 顶层 `output_text` 字段（部分代理会扁平化返回非空字符串）
/// 2. 遍历 `output[]` 中所有 `type=="message"` 的 item，按出现顺序拼接其
///    `content[]` 里所有 `type=="output_text"`（或带 `text` 字段）的文本
/// 3. 遍历 `output[]` 中所有 message 的 `content[]` 里 `text` 字段非空但 type
///    不明的 piece（兼容部分代理只给 `{text:"..."}` 的形态）
/// 4. 兜底：递归遍历整棵树收集 output_text / `{type:output_text,text}`
/// 5. 最后才尝试 chat-completions 的 `choices[0].message.content` 兼容形态
///
/// 注意：与旧的 `collect_response_output_text` 不同，本函数 **不会** 把 reasoning /
/// reasoning_summary / tool 元数据当作 final text。Planner 只关心 final message。
///
/// 实现委托给 `extract_final_responses_text_with_source`，source 标签在
/// `responses_body_normalize` 里另外记录到日志。
pub(crate) fn extract_final_responses_text(body: &serde_json::Value) -> Option<String> {
    extract_final_responses_text_with_source(body).map(|(text, _)| text)
}

/// 根据 Responses shape diagnostic 推断"为什么没拿到 final text"的细分类。
/// 仅在 extract_final_responses_text 已经返回 None 之后调用。
fn classify_missing_text(diang: &ResponsesShapeDiagnostic) -> (String, String) {
    // 顶层 error 优先 —— 这是上游报错，不是"模型没回话"。
    // 关键修复：把上游真实 message 嵌入 reason，让用户/前端能立刻看到失败原因，
    // 而不是只看到 "上游返回了 error 字段" 这种空泛的话。
    if diang.has_error {
        let reason = build_upstream_error_reason(
            diang.upstream_error_message.as_deref(),
            diang.upstream_error_code.as_deref(),
            diang.upstream_error_type.as_deref(),
            diang.upstream_error_param.as_deref(),
            "上游返回了 error 字段，请检查模型 / 鉴权 / 限流状态后再试。",
        );
        return ("upstream_error".to_string(), reason);
    }
    // status=failed / incomplete 由 Responses 协议明确告知
    if let Some(status) = diang.response_status.as_deref() {
        if status == "failed" {
            // status=failed 时 OpenAI 协议要求 last_error 字段携带真实失败原因，
            // build_responses_diagnostic 已经把它读到 upstream_error_message 里。
            let reason = build_upstream_error_reason(
                diang.upstream_error_message.as_deref(),
                diang.upstream_error_code.as_deref(),
                diang.upstream_error_type.as_deref(),
                diang.upstream_error_param.as_deref(),
                "Responses status=failed，上游模型本轮执行失败。",
            );
            return ("upstream_error".to_string(), reason);
        }
        if status == "incomplete" {
            let reason = diang.incomplete_reason.as_deref().unwrap_or("unknown");
            return (
                "response_incomplete".to_string(),
                format!("Responses status=incomplete（reason={}），可能是 max_output_tokens 预算不足或安全策略截断。", reason),
            );
        }
    }
    // 只有 reasoning，没有 final message —— 这是"reasoning 吃光预算"的典型表现
    let has_reasoning = diang.output_types.iter().any(|s| s == "reasoning");
    let has_message = diang.output_types.iter().any(|s| s == "message");
    if has_reasoning && !has_message {
        return (
            "response_text_missing".to_string(),
            "Responses 只返回了 reasoning，没有 final message —— 通常是 max_output_tokens 预算被推理消耗殆尽，已自动重试并提升预算。".to_string(),
        );
    }
    // 完全没东西
    if diang.output_count == 0 {
        // 关键新分支：模型本轮产生了 output token（usage.output_tokens > 0），
        // 但 Responses payload 里的 output 数组却是空的。这是 Provider 兼容层
        // 丢失 output 的典型表现 —— 必须独立分类为 provider_response_payload_missing，
        // 触发 Retrieve + SSE Streaming 恢复流程，而不是再原样 POST 一次。
        //
        // 注意：output_tokens == None（usage 缺失）和 Some(0)（明确没产生 token）
        // 都不属于此分支，仍归 response_text_missing。
        if let Some(tokens) = diang.output_tokens {
            if tokens > 0 {
                return (
                    "provider_response_payload_missing".to_string(),
                    format!("Responses 请求已完成且 usage 记录了 {} 个 output token，但响应 payload 中没有可读取的 output item —— 这通常属于模型服务或兼容代理的 Responses 返回异常。", tokens),
                );
            }
        }
        return (
            "response_text_missing".to_string(),
            "Responses output[] 为空，模型本轮没有产生任何输出 item。".to_string(),
        );
    }
    // 有 message 但 content 里没有 output_text
    if has_message && diang.content_types.iter().all(|s| s != "output_text") {
        return (
            "response_text_missing".to_string(),
            "Responses message 存在但 content 里没有 output_text，模型可能仅返回了 refusal 或空文本。".to_string(),
        );
    }
    (
        "response_text_missing".to_string(),
        "未能在 Responses body 中找到可解析的 final text。".to_string(),
    )
}

/// 把上游真实的 message / type / code / param 拼成一段用户可读的简短文案。
/// 主卡只展示 1~2 行（截断到 ~240 字符），完整字段在"查看规划详情"里看。
fn build_upstream_error_reason(
    message: Option<&str>,
    code: Option<&str>,
    kind: Option<&str>,
    param: Option<&str>,
    fallback: &str,
) -> String {
    let truncate = |s: &str| -> String {
        let trimmed = s.trim();
        let chars: Vec<char> = trimmed.chars().collect();
        if chars.len() <= 240 {
            trimmed.to_string()
        } else {
            format!("{}…", chars.iter().take(240).collect::<String>())
        }
    };

    let msg_part = message.map(truncate);
    let mut parts: Vec<String> = Vec::new();
    if let Some(m) = &msg_part {
        parts.push(m.clone());
    }
    // 把 code/type/param 作为后缀括注，方便一眼定位（例如 "（code=unsupported_parameter, param=text.format）"）。
    let mut meta: Vec<String> = Vec::new();
    if let Some(c) = code {
        meta.push(format!("code={}", c));
    }
    if let Some(p) = param {
        meta.push(format!("param={}", p));
    }
    if let Some(k) = kind {
        meta.push(format!("type={}", k));
    }
    if !meta.is_empty() && msg_part.is_some() {
        parts.push(format!("（{}）", meta.join(", ")));
    } else if !meta.is_empty() {
        // message 缺失时，至少把 code/type/param 抛出来，避免只剩一句 fallback。
        parts.push(format!("上游错误：{}", meta.join(", ")));
    }

    if parts.is_empty() {
        fallback.to_string()
    } else {
        parts.join("")
    }
}

/// 判断"上游 body.error"是否值得重试一次。
///
/// 规则（与 spec 第 51~53 节一致）：
///   - server / 临时不可用 / rate limit → 可以 retry（最多一次）
///   - 参数错 / 模型不支持 / 鉴权 / 内容策略 → 绝不 retry
///   - 未知 / 缺失 → 保守地不 retry，把真实错误抛给用户
fn is_retryable_upstream_error_code(code: Option<&str>, kind: Option<&str>) -> bool {
    let code_norm = code.unwrap_or("").to_ascii_lowercase();
    let kind_norm = kind.unwrap_or("").to_ascii_lowercase();
    let retryable_codes = [
        "server_error",
        "internal_error",
        "temporarily_unavailable",
        "service_unavailable",
        "unavailable",
        "bad_gateway",
        "gateway_timeout",
        "rate_limit_exceeded",
        "rate_limit",
        "overloaded",
    ];
    let retryable_kinds = [
        "server_error",
        "rate_limit_error",
        "temporarily_unavailable",
        "service_unavailable",
        "internal_error",
    ];
    let hard_fail_codes = [
        "unsupported_parameter",
        "invalid_request",
        "invalid_request_error",
        "model_not_found",
        "model_endpoint_unsupported",
        "authentication_error",
        "permission_error",
        "content_policy_violation",
        "billing_hard_limit_reached",
        "insufficient_quota",
    ];
    let hard_fail_kinds = [
        "invalid_request_error",
        "authentication_error",
        "permission_error",
        "not_found_error",
    ];
    if retryable_codes.iter().any(|c| *c == code_norm)
        || retryable_kinds.iter().any(|k| *k == kind_norm)
    {
        return true;
    }
    if hard_fail_codes.iter().any(|c| *c == code_norm)
        || hard_fail_kinds.iter().any(|k| *k == kind_norm)
    {
        return false;
    }
    // 未知错误保守不重试 —— 让用户看到真实 message 自己决定。
    false
}

fn local_endpoint_status(ok: bool, message: &str) -> AgentEndpointStatus {
    AgentEndpointStatus {
        ok,
        kind: if ok {
            None
        } else {
            Some("invalid_response".to_string())
        },
        message: message.to_string(),
        status: None,
    }
}

/// Strip a single surrounding Markdown code fence (``` or ```json) if present.
/// Only strips when the fence is the first non-whitespace token; otherwise the
/// leading prose is handled by the balanced-brace scan that runs afterwards.
fn strip_leading_code_fence(content: &str) -> String {
    let trimmed = content.trim();
    if !trimmed.starts_with("```") {
        return content.to_string();
    }
    let lines: Vec<&str> = trimmed.lines().collect();
    if lines.len() < 2 {
        return content.to_string();
    }
    // First line is the opening fence (possibly with a language tag like ```json).
    // If the last line is a closing fence, drop both; otherwise just drop the opening.
    let has_closing = lines
        .last()
        .map(|line| line.trim().starts_with("```"))
        .unwrap_or(false);
    let inner_start = 1;
    let inner_end = if has_closing {
        lines.len() - 1
    } else {
        lines.len()
    };
    lines[inner_start..inner_end].join("\n")
}

/// Walk the input character-by-character to find the first top-level balanced
/// `{...}` object. Handles JSON strings, escape sequences, nested objects and
/// arrays. Returns the byte range of the matched object so callers can slice it.
fn find_first_balanced_object(content: &str) -> Option<(usize, usize)> {
    let bytes = content.as_bytes();
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escape = false;
    let mut start: Option<usize> = None;

    for (i, &byte) in bytes.iter().enumerate() {
        if in_string {
            if escape {
                escape = false;
            } else if byte == b'\\' {
                escape = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }

        match byte {
            b'"' => {
                in_string = true;
                escape = false;
            }
            b'{' => {
                if depth == 0 {
                    start = Some(i);
                }
                depth += 1;
            }
            b'}' => {
                if depth > 0 {
                    depth -= 1;
                    if depth == 0 {
                        if let Some(s) = start {
                            return Some((s, i));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    None
}

/// Robust extractor for the JSON object produced by the Planner model.
///
/// Strategy (in order):
/// 1. trim, fast-path the trivial "already a JSON object" case
/// 2. if the entire trimmed string parses as a JSON object, return it as-is
/// 3. strip a leading ``` / ```json code fence and retry step 2
/// 4. scan for the first balanced `{...}` substring and return that slice
///
/// The scan in step 4 correctly handles JSON strings containing `}` or `{`
/// (which a naive `rfind('}')` would mishandle) and tolerates leading or
/// trailing prose like "下面是规划结果：{...} 以上为任务规划结果。".
/// 判断 Planner 文本是否"JSON 输出到一半被截断"。
///
/// 判据（结构启发式，不依赖上游元数据）：
///   - 文本里出现过 object 起始 `{`；
///   - `extract_json_object_text` 找不到任何平衡对象；
///   - 逐字符扫描后：要么花括号深度 > 0（对象未闭合），要么停在未闭合的字符串内部。
///
/// 典型样例：`{"intent":"EDIT_IMAGE",...,"final_prompt":"少女的白色发丝随风轻扬`
/// 这类内容绝不允许"补个引号补个 }"式脑补修复 —— final_prompt 本身也没生成完。
pub(crate) fn looks_like_truncated_json(content: &str) -> bool {
    let trimmed = content.trim();
    if trimmed.is_empty() || !trimmed.contains('{') {
        return false;
    }
    if extract_json_object_text(trimmed).is_some() {
        return false;
    }
    let mut in_string = false;
    let mut escape = false;
    let mut depth: i64 = 0;
    let mut saw_object_start = false;
    for ch in trimmed.chars() {
        if in_string {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => {
                saw_object_start = true;
                depth += 1;
            }
            '}' => depth -= 1,
            _ => {}
        }
    }
    saw_object_start && (depth > 0 || in_string)
}

/// Planner JSON 解析失败的细分类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlannerParseFailureKind {
    /// 输出被截断（finish_reason=length / status=incomplete / 结构启发式命中）。
    Truncated,
    /// 完整文本但不是合法 JSON / 不是 JSON 对象。
    Malformed,
}

/// 结合上游元数据 + 结构启发式，把 Planner 解析失败归类为 Truncated / Malformed。
/// 上游显式信号优先：`finish_reason=length`（chat）与 `status=incomplete`（Responses）
/// 是协议层面的权威截断信号，即使结构扫描没命中也按截断处理。
pub(crate) fn classify_planner_parse_failure(
    content: &str,
    finish_reason: Option<&str>,
    response_status: Option<&str>,
) -> PlannerParseFailureKind {
    if finish_reason == Some("length") || response_status == Some("incomplete") {
        return PlannerParseFailureKind::Truncated;
    }
    if looks_like_truncated_json(content) {
        return PlannerParseFailureKind::Truncated;
    }
    PlannerParseFailureKind::Malformed
}

/// 截断重试的 system 追加指令：要求模型压缩输出并确保 JSON 完整闭合。
const PLANNER_TRUNCATED_RETRY_NUDGE: &str = "\n\n【输出被截断，重新输出】上一次输出因达到长度上限被截断。请重新输出完整结果，并严格遵守：只输出一个完整 JSON 对象，不要输出任何解释或 markdown；recommended_action 压缩到 60 字以内；title 压缩到 20 字以内；final_prompt 压缩到 400 字以内；确保 JSON 以 } 完整结束。";

/// 空文本重试的 system 追加指令。
const PLANNER_EMPTY_RETRY_NUDGE: &str = "\n\n【重要】上一次没有返回任何文本内容。请直接输出一个完整 JSON 对象，不要输出任何其他内容，确保 JSON 以 } 完整结束。";

fn extract_json_object_text(content: &str) -> Option<String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        if serde_json::from_str::<serde_json::Value>(trimmed).is_ok() {
            return Some(trimmed.to_string());
        }
    }

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if value.is_object() {
            return Some(trimmed.to_string());
        }
    }

    let fence_stripped = strip_leading_code_fence(trimmed);
    let candidate = fence_stripped.trim();
    if !candidate.is_empty() && candidate != trimmed {
        if candidate.starts_with('{') && candidate.ends_with('}') {
            if serde_json::from_str::<serde_json::Value>(candidate).is_ok() {
                return Some(candidate.to_string());
            }
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(candidate) {
            if value.is_object() {
                return Some(candidate.to_string());
            }
        }
    }

    let scan_source = if !candidate.is_empty() {
        candidate
    } else {
        trimmed
    };
    if let Some((start, end)) = find_first_balanced_object(scan_source) {
        return Some(scan_source[start..=end].to_string());
    }

    None
}

#[derive(Debug, Serialize)]
pub struct ImageMeta {
    pub width: u32,
    pub height: u32,
    pub file_size: u64,
}

fn is_supported_image(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.to_ascii_lowercase()),
        Some(ext) if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp")
    )
}

fn collect_image_files(dir: &Path, output: &mut Vec<PathBuf>) {
    if !dir.exists() || !dir.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_image_files(&path, output);
        } else if is_supported_image(&path) {
            output.push(path);
        }
    }
}

/// 图库路径唯一身份键：统一分隔符 + 去尾斜杠；Windows 大小写不敏感。
/// `D:\Images\a.png` / `D:/Images/a.png` / `d:\images\a.png` 必须得到同一个 key，
/// 否则同一文件会在索引里出现两条记录（本轮图库重复的真实根因）。
fn normalize_image_path_key(path: &str) -> String {
    let mut key = path.trim().replace('\\', "/");
    while key.ends_with('/') {
        key.pop();
    }
    if cfg!(windows) {
        key.to_lowercase()
    } else {
        key
    }
}

fn classify_source_kind(path: &Path, settings: &Settings) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let under_dir = |raw: &str| -> Option<usize> {
        let dir = raw.replace('\\', "/");
        let dir = dir.trim().trim_end_matches('/');
        if dir.is_empty() {
            return None;
        }
        if normalized == dir || normalized.starts_with(&format!("{}/", dir)) {
            Some(dir.len())
        } else {
            None
        }
    };
    // 输出目录专属子目录（chat 会话保存 / transparent 去背景）最具体，先于根归属判定，
    // 不受本地目录与输出目录嵌套关系影响。
    let in_input = under_dir(&settings.library_input_dir);
    let in_output = under_dir(&settings.default_output_dir);
    if in_output.is_some() {
        if normalized.contains("/chat/") {
            return "chat".to_string();
        }
        if normalized.contains("/transparent/") {
            return "postprocess".to_string();
        }
    }
    // 最长前缀（更具体的目录）优先；两目录配置成同一路径时平局归 library_input：
    // 该目录下无任务关联的索引行只能来自用户导入 / 手动放入（任务产出由 task_runner /
    // chat / postprocess 写入自己的 source_kind，不走本函数）。历史上平局判 output，
    // 导致「本地目录 = 输出目录」配置下拖入图片被标 output、图库显示「生成结果」。
    let output_wins = match (in_output, in_input) {
        (Some(out_len), Some(in_len)) => out_len > in_len,
        (Some(_), None) => true,
        (None, _) => false,
    };
    if output_wins {
        return "output".to_string();
    }
    if in_input.is_some() {
        return "library_input".to_string();
    }
    "output".to_string()
}

fn sync_images(app: &tauri::AppHandle) -> Vec<ImageRecord> {
    let settings: Settings = storage::read_json(&storage::settings_path(app), Settings::default());
    let now = chrono::Local::now().to_rfc3339();
    let mut discovered_paths = Vec::new();

    if !settings.library_input_dir.trim().is_empty() {
        collect_image_files(
            Path::new(&settings.library_input_dir),
            &mut discovered_paths,
        );
    }
    if !settings.default_output_dir.trim().is_empty() {
        collect_image_files(
            Path::new(&settings.default_output_dir),
            &mut discovered_paths,
        );
    }
    // 图库自定义文件夹（ADR-029）：注册表路径并入扫描根，
    // 使 default_output_dir 之外（如系统图片目录回落）的文件夹内图片同样进图库。
    for folder_root in crate::image_folders::folder_scan_roots(app) {
        collect_image_files(Path::new(&folder_root), &mut discovered_paths);
    }

    let discovered_set: HashSet<String> = discovered_paths
        .iter()
        .map(|path| normalize_image_path_key(&path.to_string_lossy()))
        .collect();

    storage::with_images(app, |images| {
        // ---- 1. 清理历史脏数据：同 normalize key 的重复索引行 ----
        // 旧版本有两个缺陷导致重复：(a) by_path 用原始存储路径，反斜杠 / 大小写
        // 差异被视为不同文件；(b) 新插入的行不回填 by_path，目录重叠时同一文件
        // 被插入两次。这里按 key 分组，每组只保留一条。
        // 安全约束：sub_tasks[].image_id 引用 ImageRecord.id，真实任务产出
        //（task_id != "library"）的行永不删除；只允许合并纯索引行（task_id == "library"），
        // 且组内存在真实任务行时保留真实任务行。
        {
            let mut kept: HashMap<String, String> = HashMap::new(); // key -> 保留行的 id
            let mut remove_ids: Vec<String> = Vec::new();
            for image in images.iter() {
                let key = normalize_image_path_key(&image.local_path);
                if key.is_empty() {
                    continue;
                }
                let is_library_row = image.task_id == "library";
                match kept.get(&key) {
                    None => {
                        kept.insert(key, image.id.clone());
                    }
                    Some(existing_id) => {
                        // 找到已保留行的信息，决定谁留下（真实任务行 > 索引行）。
                        let existing_is_library = images
                            .iter()
                            .find(|i| i.id == *existing_id)
                            .map(|i| i.task_id == "library")
                            .unwrap_or(true);
                        if existing_is_library && !is_library_row {
                            // 已保留的是索引行，当前是真实任务行 → 换成当前行。
                            remove_ids.push(existing_id.clone());
                            kept.insert(key, image.id.clone());
                        } else if is_library_row {
                            // 当前行是多余索引行 → 删除。
                            remove_ids.push(image.id.clone());
                        }
                        // 两个都是真实任务行（同路径双写）→ 不动，交给上层显示去重。
                    }
                }
            }
            if !remove_ids.is_empty() {
                images.retain(|i| !remove_ids.contains(&i.id));
            }
        }

        // ---- 2. 建立归一化 path → index 映射（upsert 幂等的关键）----
        let mut by_path: HashMap<String, usize> = HashMap::new();
        for (index, image) in images.iter_mut().enumerate() {
            image.missing = !Path::new(&image.local_path).exists();
            if !image.missing {
                image.last_seen_at = Some(now.clone());
            }
            if image.source_kind.trim().is_empty() {
                image.source_kind = classify_source_kind(Path::new(&image.local_path), &settings);
            }
            // 旧记录统一归一化成分隔符 `/` 的形式，杜绝 `\` 与 `/` 混存。
            image.local_path = image.local_path.replace('\\', "/");
            by_path.insert(normalize_image_path_key(&image.local_path), index);
        }

        for path in discovered_paths {
            let normalized = path.to_string_lossy().replace('\\', "/");
            let key = normalize_image_path_key(&normalized);
            if let Some(index) = by_path.get(&key).copied() {
                let image = &mut images[index];
                image.missing = false;
                image.last_seen_at = Some(now.clone());
                image.file_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(&image.file_name)
                    .to_string();
                // 任务关联行的 source_kind 由产出链路写入（task_runner / chat / postprocess），
                // 目录重扫不得覆写（历史 bug：嵌套目录前缀误判把任务产出改成 library_input，
                // 图库因此整片显示「本地」）；只有纯索引行（task_id == "library"）按目录重判。
                if image.task_id == "library" {
                    image.source_kind = classify_source_kind(&path, &settings);
                }
                if let Ok(meta) = fs::metadata(&path) {
                    image.file_size = Some(meta.len());
                }
            } else {
                let file_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("image")
                    .to_string();
                let metadata = fs::metadata(&path).ok();
                let created_at = metadata
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .map(|t| chrono::DateTime::<chrono::Local>::from(t).to_rfc3339())
                    .unwrap_or_else(|| now.clone());
                images.push(ImageRecord {
                    id: uuid::Uuid::new_v4().to_string(),
                    task_id: "library".to_string(),
                    local_path: normalized.clone(),
                    file_name,
                    created_at,
                    status: "indexed".to_string(),
                    source_kind: classify_source_kind(&path, &settings),
                    missing: false,
                    last_seen_at: Some(now.clone()),
                    width: None,
                    height: None,
                    file_size: metadata.as_ref().map(|m| m.len()),
                    description: None,
                    tags: Vec::new(),
                    indexed_at: None,
                });
                // 关键：新插入的行必须回填 by_path —— 否则同一目录被两个扫描根
                //（本地目录 + 输出目录重叠）重复发现时会插入第二条重复记录。
                by_path.insert(key, images.len() - 1);
            }
        }

        for image in images.iter_mut() {
            if !discovered_set.contains(&normalize_image_path_key(&image.local_path))
                && (image.source_kind == "library_input" || image.source_kind == "output")
            {
                image.missing = !Path::new(&image.local_path).exists();
            }
        }

        images.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        images.clone()
    })
}

// ========== Settings ==========

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Settings {
    let path = storage::settings_path(&app);
    let mut settings: Settings = storage::read_json(&path, Settings::default());

    // Generate device_id if not present
    if settings.device_id.trim().is_empty() {
        settings.device_id = uuid::Uuid::new_v4().to_string();
        storage::write_json(&path, &settings);
    }

    settings
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    let path = storage::settings_path(&app);
    let previous = storage::read_json(&path, Settings::default());
    let should_rescan_images = previous.default_output_dir != settings.default_output_dir
        || previous.library_input_dir != settings.library_input_dir;

    // Preserve device_id if the new settings don't have one
    let mut final_settings = settings;
    if final_settings.device_id.trim().is_empty() && !previous.device_id.trim().is_empty() {
        final_settings.device_id = previous.device_id;
    }
    // Generate device_id if still empty
    if final_settings.device_id.trim().is_empty() {
        final_settings.device_id = uuid::Uuid::new_v4().to_string();
    }

    storage::write_json(&path, &final_settings);
    if should_rescan_images {
        let _ = sync_images(&app);
    }
    Ok(())
}

// ========== Provider Model Discovery ==========
//
// 模型发现与快速检测统一走 Rust（禁止前端直接 fetch Provider API）：
//   GET {base_url}/models （OpenAI Compatible 标准模型目录接口）
// 只做连接 / 鉴权 / 目录 / 模型 id 存在性检测，不发送任何生成请求，不产生 Token 消耗。

#[derive(Debug, Deserialize)]
pub struct ProviderModelsPayload {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub token: String,
}

#[derive(Debug, Serialize)]
pub struct ProviderModelsResult {
    pub ok: bool,
    pub status: Option<u16>,
    pub models: Vec<String>,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
}

/// 宽容解析 /models 响应：标准 `{data:[{id}]}`
fn extract_model_ids(body: &serde_json::Value) -> Vec<String> {
    fn push_unique(ids: &mut Vec<String>, raw: &str) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() && !ids.iter().any(|existing| existing == trimmed) {
            ids.push(trimmed.to_string());
        }
    }
    let mut ids: Vec<String> = Vec::new();
    if let Some(data) = body.get("data").and_then(|v| v.as_array()) {
        for item in data {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                push_unique(&mut ids, id);
            }
        }
    }
    if ids.is_empty() {
        if let Some(array) = body.as_array() {
            for item in array {
                if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                    push_unique(&mut ids, id);
                } else if let Some(s) = item.as_str() {
                    push_unique(&mut ids, s);
                }
            }
        }
    }
    ids
}

#[tauri::command]
pub async fn list_provider_models(
    payload: ProviderModelsPayload,
) -> Result<ProviderModelsResult, String> {
    let base = payload.base_url.trim().trim_end_matches('/').to_string();
    let token = payload.token.trim().to_string();
    if base.is_empty() || token.is_empty() {
        return Ok(ProviderModelsResult {
            ok: false,
            status: None,
            models: Vec::new(),
            error_kind: Some("not_configured".to_string()),
            error_message: Some("Base URL 或 API Key 未配置".to_string()),
        });
    }

    let url = format!("{}/models", base);
    let response = HTTP_CLIENT
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await;

    match response {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body_text = resp.text().await.unwrap_or_default();
            if (200..300).contains(&status) {
                let parsed: serde_json::Value = serde_json::from_str(&body_text).unwrap_or(
                    serde_json::Value::Object(serde_json::Map::new()),
                );
                let models = extract_model_ids(&parsed);
                Ok(ProviderModelsResult {
                    ok: true,
                    status: Some(status),
                    models,
                    error_kind: None,
                    error_message: None,
                })
            } else {
                let body_value: serde_json::Value = serde_json::from_str(&body_text)
                    .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                let (message, _code) = extract_error_parts_from_value(&body_value);
                Ok(ProviderModelsResult {
                    ok: false,
                    status: Some(status),
                    models: Vec::new(),
                    error_kind: Some(status_error_kind(status).to_string()),
                    error_message: message,
                })
            }
        }
        Err(err) => {
            let kind = classify_reqwest_error(&err);
            Ok(ProviderModelsResult {
                ok: false,
                status: None,
                models: Vec::new(),
                error_kind: Some(kind.to_string()),
                error_message: Some(err.to_string()),
            })
        }
    }
}

/// Planner 原始返回诊断日志 —— 必须打印**真实命中的通道**（transport_used），
/// 而不是硬编码 "responses"。旧版日志把 chat_completions 通道也打成 transport=responses，
/// 导致"为什么 prefer_responses=false 却显示 responses"的误判。
/// 同时带上 finish_reason / usage / reasoning_tokens：这是判断"JSON 为什么停止输出"
/// （截断 vs 模型胡说）的关键证据。preview 限 1000 字符，绝不打印鉴权头 / 完整请求体。
fn log_planner_raw_response(
    transport_used: Option<&str>,
    model: &str,
    content: &str,
    diag: Option<&ResponsesShapeDiagnostic>,
) {
    let content_preview: String = content.chars().take(1000).collect();
    let content_has_fence = content.starts_with("```");
    let content_has_leading_prose =
        !content.is_empty() && !content.starts_with('{') && !content.starts_with('`');
    let (finish_reason, response_status, input_tokens, output_tokens, reasoning_tokens) =
        match diag {
            Some(d) => (
                d.finish_reason.as_deref(),
                d.response_status.as_deref(),
                d.input_tokens,
                d.output_tokens,
                d.reasoning_tokens,
            ),
            None => (None, None, None, None, None),
        };
    println!(
        "[PlannerRawResponse] transport={} model={} content_len={} finish_reason={:?} response_status={:?} usage=(input={:?} output={:?} reasoning={:?}) has_fence={} has_leading_prose={} preview={:?}",
        transport_used.unwrap_or("unknown"),
        model,
        content.len(),
        finish_reason,
        response_status,
        input_tokens,
        output_tokens,
        reasoning_tokens,
        content_has_fence,
        content_has_leading_prose,
        content_preview,
    );
}

/// 从 chat/responses 归一化 body 中提取 Planner 文本（choices[0].message.content）。
fn planner_content_from_value(value: &serde_json::Value) -> String {
    value
        .get("choices")
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("message"))
        .and_then(|v| v.get("content"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// chat_completions 通道的 Planner 诊断（未经 responses_body_normalize，手工构造）。
/// 关键字段是 finish_reason：`length` = 输出被 max_tokens 截断的权威信号。
fn build_chat_completions_diagnostic(value: &serde_json::Value) -> ResponsesShapeDiagnostic {
    let choice = value.get("choices").and_then(|v| v.get(0));
    let finish_reason = choice
        .and_then(|c| c.get("finish_reason"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let usage = value.get("usage");
    let input_tokens = usage
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(value_as_u64);
    let completion_tokens = usage
        .and_then(|u| u.get("completion_tokens"))
        .and_then(value_as_u64);
    let reasoning_tokens = usage
        .and_then(|u| u.get("completion_tokens_details"))
        .and_then(|d| d.get("reasoning_tokens"))
        .and_then(value_as_u64)
        .or_else(|| {
            usage
                .and_then(|u| u.get("reasoning_tokens"))
                .and_then(value_as_u64)
        });
    ResponsesShapeDiagnostic {
        http_status: Some(200),
        has_choices: true,
        finish_reason,
        input_tokens,
        output_tokens: completion_tokens,
        reasoning_tokens,
        extracted_text_len: choice
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|v| v.as_str())
            .map(|s| s.chars().count())
            .unwrap_or(0),
        ..ResponsesShapeDiagnostic::default()
    }
}

/// Planner 阶段统一失败结果构造器 —— 避免每个分支手写 20 个 None 字段。
#[allow(clippy::too_many_arguments)]
fn planner_failure_result(
    transport_used: Option<&str>,
    error_kind: &str,
    error_message: String,
    status: Option<u16>,
    raw_output: Option<String>,
    parser_error: Option<String>,
    diag: Option<ResponsesShapeDiagnostic>,
    recovery: Option<ResponsesRecoveryTrace>,
) -> AgentRunResult {
    AgentRunResult {
        ok: false,
        intent: None,
        confidence: None,
        needs_clarification: None,
        clarification_question: None,
        recommended_action: None,
        should_propose_execution: None,
        final_prompt: None,
        final_negative_prompt: None,
        api_kind: None,
        reply: None,
        reasoning: None,
        prompt_tokens: None,
        completion_tokens: None,
        error_kind: Some(error_kind.to_string()),
        error_message: Some(error_message),
        status,
        used_local_fallback: Some(false),
        planner_raw_output: raw_output,
        planner_parser_error: parser_error,
        planner_transport: transport_used.map(|s| s.to_string()),
        planner_diagnostic: diag,
        planner_recovery: recovery,
        finish_reason: None,
    }
}

/// Planner 针对性单次重试（截断 / 空文本）。
///
/// - 把 nudge 追加到 system 消息后重新请求**同一通道**（transport 与首次一致，
///   不做协议切换 —— 截断是预算问题，不是协议问题）。
/// - chat 通道返回原始 body（调用方再构造 chat 诊断）；
///   responses 通道返回归一化 body + 新诊断。
/// - 任何请求层错误都返回 None（外层按原始失败结果返回，不再叠加重试）。
async fn planner_targeted_retry(
    base_url: &str,
    token: &str,
    model: &str,
    transport: &str,
    mut chat_body: serde_json::Value,
    nudge: &str,
) -> Option<(serde_json::Value, Option<ResponsesShapeDiagnostic>)> {
    if let Some(messages) = chat_body
        .get_mut("messages")
        .and_then(|v| v.as_array_mut())
    {
        if let Some(first) = messages.first_mut() {
            if let Some(sys) = first.get_mut("content") {
                if let Some(s) = sys.as_str() {
                    *sys = serde_json::Value::String(format!("{}{}", s, nudge));
                }
            }
        }
    }
    println!(
        "[PlannerRetry] transport={} model={} nudge_len={} triggered",
        transport,
        model,
        nudge.chars().count(),
    );
    if transport == "responses" {
        let messages_array = chat_body
            .get("messages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let system_content = messages_array
            .first()
            .and_then(|f| f.get("content"))
            .cloned()
            .unwrap_or(json!(""));
        let user_content = messages_array
            .get(1)
            .and_then(|f| f.get("content"))
            .cloned()
            .unwrap_or(json!(""));
        let responses_body = json!({
            "model": model,
            "input": [
                { "role": "system", "content": system_content },
                { "role": "user", "content": user_content }
            ],
            "max_output_tokens": 4000
        });
        match post_responses_api(base_url, token, responses_body).await {
            Ok((raw, http_status)) => {
                let (normalized, diag) = responses_body_normalize(raw, http_status);
                Some((normalized, Some(diag)))
            }
            Err(_) => None,
        }
    } else {
        match post_chat_completions(base_url, token, chat_body).await {
            Ok(v) => Some((v, None)),
            Err(_) => None,
        }
    }
}

#[tauri::command]
pub async fn run_agent_request(payload: AgentRunPayload) -> Result<AgentRunResult, String> {
    if payload.base_url.trim().is_empty()
        || payload.token.trim().is_empty()
        || payload.model.trim().is_empty()
    {
        return Ok(AgentRunResult {
            ok: false,
            intent: None,
            confidence: None,
            needs_clarification: None,
            clarification_question: None,
            recommended_action: None,
            should_propose_execution: None,
            final_prompt: None,
            final_negative_prompt: None,
            api_kind: None,
            reply: None,
            reasoning: None,
            prompt_tokens: None,
            completion_tokens: None,
            error_kind: Some("auth".to_string()),
            error_message: Some("智能体配置不完整，请检查模型、地址和 Token".to_string()),
            status: None,
            used_local_fallback: Some(false),
            planner_raw_output: None,
            planner_parser_error: None,
            planner_transport: None,
            planner_diagnostic: None,
            planner_recovery: None,
            finish_reason: None,
        });
    }

    let body = if payload.mode == "interpret" || payload.mode == "plan_task" {
        let planner_system = if !payload.system_prompt.trim().is_empty() {
            payload.system_prompt.trim().to_string()
        } else {
            "你是 CyImagePro 的图片任务规划智能体（Agent / Planner）。\n你的职责是把用户的原始需求转化为图片执行模型（gpt-image-2）能够高质量执行的提示词，并输出结构化 JSON。\n\n重要规则：\n1. final_prompt 必须是基于用户原始需求扩展后的完整图片提示词，包含：主体、构图、风格、光影、背景、文字布局、清晰度、限制项等要素。\n2. 严禁把 final_prompt 直接等于用户原话。必须做真正的视觉设计扩展。\n3. 同时严禁改变用户明确指定的核心文案、核心主体或否定要求。例如用户说「不要油画」，最终 Prompt 必须保留「不要油画 / 禁止油画笔触」类约束。\n4. 如果用户提供了必须出现的文字内容（如标题、广告语、商品名），把这些文字作为必须严格保留的文字内容写入 final_prompt，并要求图模型不要自行添加其他无关文字，避免乱码。\n5. final_negative_prompt 用于填写负面提示词，例如：乱码、错误文字、重复字符、模糊、畸形、低分辨率等。\n6. api_kind 取值：generation（文生图）/ edit（图生图或图片编辑）/ remove_background / upscale。\n7. intent 取值：chat / gallery_search / image_understanding / image_generate / image_edit / remove_background / upscale。\n8. 当 has_images=true 且用户要求基于原图修改时，应判断为 image_edit（api_kind=edit）；当用户明确要求抠图去背景时为 remove_background。\n9. 不确定时 needs_clarification=true，并给出 clarification_question。\n\n只输出合法 JSON 对象，不要输出 markdown、代码块或额外解释。\n输出字段必须且只能包含：{\"intent\":\"...\",\"confidence\":0-1,\"needs_clarification\":true|false,\"clarification_question\":\"...\",\"recommended_action\":\"...\",\"should_propose_execution\":true|false,\"final_prompt\":\"...\",\"final_negative_prompt\":\"...\",\"api_kind\":\"generation|edit|remove_background|upscale\"}".to_string()
        };
        json!({
            "model": payload.model,
            "messages": [
                {
                    "role": "system",
                    "content": planner_system
                },
                {
                    "role": "user",
                    "content": json!({
                        "text": payload.text,
                        "has_images": payload.has_images,
                        "editable_image_count": payload.editable_image_count,
                        "attachment_names": payload.attachment_names,
                        "rough_intent": payload.rough_intent,
                    }).to_string()
                }
            ],
            "temperature": 0.2,
            // 1600 → 4096：deepseek-v4-flash 等推理型模型的思考 token 与最终 JSON
            // 共享 max_tokens 预算。1600 时中文 final_prompt 稍长就会被推理挤爆，
            // 表现为 JSON 输出到一半停止（finish_reason=length）。4096 与 Responses
            // 通道的 4000 max_output_tokens 量级对齐，足够容纳 reasoning + 完整 JSON。
            "max_tokens": 4096
        })
    } else {
        let mut messages = Vec::new();
        if !payload.system_prompt.trim().is_empty() {
            messages.push(json!({ "role": "system", "content": payload.system_prompt }));
        }
        for message in payload.messages {
            if !message.parts.is_empty() {
                let content: Vec<serde_json::Value> = message
                    .parts
                    .into_iter()
                    .filter_map(|part| {
                        if part.part_type == "text" {
                            part.text
                                .map(|text| json!({ "type": "text", "text": text }))
                        } else if part.part_type == "image_url" {
                            part.image_url.map(
                                |url| json!({ "type": "image_url", "image_url": { "url": url } }),
                            )
                        } else {
                            None
                        }
                    })
                    .collect();
                messages.push(json!({ "role": message.role, "content": content }));
            } else {
                messages.push(
                    json!({ "role": message.role, "content": message.content.unwrap_or_default() }),
                );
            }
        }
        json!({
            "model": payload.model,
            "messages": messages,
            // 调用方可覆盖（comic_planner 等大 JSON 输出传 8192）；缺省 4096 不变
            "max_tokens": effective_max_tokens(payload.max_tokens)
        })
    };

    // transport 只由模型能力决定（单一事实源：`model_prefer_responses_transport` +
    // `resolve_transport_preference`）：Responses-only 模型（gpt-5.6-luna 等）走
    // Responses；其余模型（GLM / DeepSeek / 标准 OpenAI Compatible）走
    // chat/completions，另一协议仅在 protocol_not_supported / 404 时单次回退。
    let prefer_responses = model_prefer_responses_transport(&payload.model);

    println!(
        "[AITransport] role={} feature={} mode={} model={} billing_mode={:?} prefer_responses={} resolved_order={:?}",
        if payload.role.is_empty() { "unspecified" } else { &payload.role },
        if payload.feature.is_empty() { "-" } else { &payload.feature },
        payload.mode,
        payload.model,
        payload.billing_mode,
        prefer_responses,
        resolve_transport_preference(&payload.model, &payload.mode),
    );

    let mut value: Option<serde_json::Value> = None;
    // 记录 Planner 本次实际命中的上游通道，方便诊断"模型只支持某通道"类问题。
    let mut transport_used: Option<&str> = None;
    // Planner 专用诊断：在 plan_task / interpret 分支里透传给最终结果，
    // 让前端 "查看规划详情" 能展示 Responses shape。
    let mut responses_diag: Option<ResponsesShapeDiagnostic> = None;
    // Payload Recovery 轨迹：仅当 Primary 命中 provider_response_payload_missing
    // 并启动 Retrieve + SSE Streaming 恢复时 attempted=true。其他路径保持默认（None）。
    let mut recovery_trace: ResponsesRecoveryTrace = ResponsesRecoveryTrace::new_not_attempted();

    if prefer_responses {
        // Build the Responses `input` array.
        // - interpret / plan_task: single system + single user (Planner is single-shot).
        // - chat (and any other multi-turn mode): preserve the FULL message history so
        //   normal conversations don't degenerate into single-turn calls.
        let messages_array = body
            .get("messages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let responses_body = if payload.mode == "chat" {
            // Multi-turn chat: 1:1 messages → input mapping. Content shape stays
            // the same — Responses accepts both `{type:"text"|"image_url",...}` parts
            // arrays and plain strings, just like chat completions.
            json!({
                "model": payload.model,
                "input": messages_array,
                "max_output_tokens": effective_max_tokens(payload.max_tokens)
            })
        } else {
            let system_content = messages_array
                .first()
                .and_then(|first| first.get("content"))
                .cloned()
                .unwrap_or(json!(""));
            let user_content = messages_array
                .get(1)
                .and_then(|first| first.get("content"))
                .cloned()
                .unwrap_or(json!(payload.text));
            // max_output_tokens 从 1600 提升到 4000：gpt-5.4 / gpt-5.6-luna 在做规划时
            // 可能先消耗 reasoning tokens，1600 的预算偶尔会被推理吃光，导致最终
            // message item 无法产出，前端表现为 response_text_missing。
            // 4000 既能容纳 reasoning + final JSON，也仍在 packyapi 配额合理范围内。
            json!({
                "model": payload.model,
                "input": [
                    { "role": "system", "content": system_content },
                    { "role": "user", "content": user_content }
                ],
                "max_output_tokens": 4000
            })
        };

        // === 自动单次重试策略 ===
        // 触发条件（仅可恢复错误）：
        //   - transport: timeout / connect
        //   - HTTP 5xx
        //   - 2xx 但 extract_final_responses_text 返回 None（典型: reasoning-only /
        //     output 为空 / Responses status=incomplete）
        // 不允许触发重试的错误：
        //   - 401 / 403（auth）
        //   - 422 / 400 invalid_request（模型不支持 / 参数错）
        //   - model_error / multimodal_unsupported
        //   - rate_limit（重试只会再被限一次）
        // 一旦命中重试条件，最多重试 1 次。两次都失败按真实错误类型返回。
        //
        // === Payload Recovery ===（新增）
        // 当 Primary 命中 provider_response_payload_missing（HTTP 2xx + completed
        // + has_error=false + output_tokens>0 + extract 返回 None）时，**不再走
        // 原样 POST retry**，直接跳出循环进入 Retrieve + SSE Streaming 恢复流程。
        // 这避免重复消耗模型 token 而恢复概率不变的情况。
        let mut last_diag: Option<ResponsesShapeDiagnostic> = None;
        // Primary 调用拿到的原始 raw body —— Payload Recovery 检测要用，
        // 因为 is_provider_response_payload_missing 需要重新跑 extractor 验证。
        #[allow(unused_assignments)]
        let mut primary_raw_body: Option<serde_json::Value> = None;
        #[allow(unused_assignments)]
        let mut primary_http_status: u16 = 0;
        let mut payload_missing_detected = false;
        for attempt in 0..2u8 {
            match post_responses_api(&payload.base_url, &payload.token, responses_body.clone())
                .await
            {
                Ok((raw, http_status)) => {
                    transport_used = Some("responses");
                    primary_raw_body = Some(raw.clone());
                    primary_http_status = http_status;
                    let (normalized, diag) = responses_body_normalize(raw, http_status);
                    last_diag = Some(diag.clone());
                    let has_text = normalized
                        .get("choices")
                        .and_then(|v| v.as_array())
                        .and_then(|arr| arr.first())
                        .and_then(|first| first.get("message"))
                        .and_then(|m| m.get("content"))
                        .and_then(|v| v.as_str())
                        .map(|s| !s.trim().is_empty())
                        .unwrap_or(false);
                    if has_text {
                        value = Some(normalized);
                        break;
                    }
                    // 关键新分支：检测到 Payload Missing（completed + tokens>0 + 无 output）
                    // 时立刻跳出 retry 循环，转入 Recovery 流程 —— 不允许原样 POST 重试。
                    let fallback_empty = json!({});
                    let raw_for_check = primary_raw_body.as_ref().unwrap_or(&fallback_empty);
                    if attempt == 0
                        && is_provider_response_payload_missing(
                            primary_http_status,
                            raw_for_check,
                            &diag,
                        )
                    {
                        println!(
                            "[ResponsesAdapter] payload_missing detected attempt={} output_tokens={:?} response_id={:?} → skip retry, enter recovery",
                            attempt + 1,
                            diag.output_tokens,
                            diag.response_id,
                        );
                        payload_missing_detected = true;
                        value = Some(normalized);
                        break;
                    }
                    if attempt == 1 {
                        value = Some(normalized);
                        break;
                    }
                    // 第一次没拿到 text，但 body 是 2xx —— 检查是否值得重试。
                    // 关键策略（spec 第 51~53 节）：
                    //   - response_text_missing / response_incomplete 类（无 error）→ retry（可能是 reasoning 吃光预算）
                    //   - body.error 但 code 是 server_error / rate_limit / temporarily_unavailable → retry
                    //   - body.error 且 code 是 unsupported_parameter / invalid_request / model_not_found / auth → 不 retry
                    //     否则用户点十次重新规划都会被同一个参数错打回。
                    let soft_cause = if diag.has_error {
                        is_retryable_upstream_error_code(
                            diag.upstream_error_code.as_deref(),
                            diag.upstream_error_type.as_deref(),
                        )
                    } else {
                        matches!(
                            diag.response_status.as_deref(),
                            None | Some("completed") | Some("incomplete")
                        )
                    };
                    println!(
                        "[ResponsesAdapter] retry_decision attempt={} soft_cause={} has_text={} diag_has_error={} upstream_code={:?} upstream_type={:?}",
                        attempt + 1,
                        soft_cause,
                        has_text,
                        diag.has_error,
                        diag.upstream_error_code,
                        diag.upstream_error_type,
                    );
                    if !soft_cause {
                        // 例如 status=failed / 顶层 error —— 不重试，直接走提取失败分支
                        value = Some(normalized);
                        break;
                    }
                    value = Some(normalized);
                    // soft_cause 为 true 时落入下一次循环（attempt=1）重试
                    continue;
                }
                Err(err) => {
                    let kind = err.kind.as_deref().unwrap_or("");
                    let status = err.status.unwrap_or(0);
                    let recoverable = matches!(kind, "timeout" | "connect" | "server")
                        || (500..=599).contains(&status);
                    println!(
                        "[ResponsesAdapter] upstream_err attempt={} kind={} status={} recoverable={}",
                        attempt + 1, kind, status, recoverable,
                    );
                    if attempt == 0 && recoverable {
                        // 落入下一次循环重试
                        continue;
                    }
                    // 不可恢复错误：判断是否需要回退到 chat completions
                    // protocol_not_supported 必须可以回退 —— 这是统一 transport 路由的
                    // 关键：Responses 告诉我们 "模型只支持 chat completions" 时立刻切换。
                    // 裸 404 同样回退：/responses endpoint 不存在（GLM / DeepSeek 等
                    // 纯 chat/completions Provider）不等于模型错误。
                    let can_fallback = err.status == Some(404)
                        || (matches!(
                            err.kind.as_deref(),
                            Some("model_error")
                                | Some("invalid_request")
                                | Some("multimodal_unsupported")
                        ) && err
                            .status
                            .map(|s| s == 400 || s == 404 || s == 422)
                            .unwrap_or(false))
                        || is_protocol_not_supported(&err);
                    if !can_fallback {
                        return Ok(AgentRunResult {
                            ok: false,
                            intent: None,
                            confidence: None,
                            needs_clarification: None,
                            clarification_question: None,
                            recommended_action: None,
                            should_propose_execution: None,
                            final_prompt: None,
                            final_negative_prompt: None,
                            api_kind: None,
                            reply: None,
                            reasoning: None,
                            prompt_tokens: None,
                            completion_tokens: None,
                            error_kind: err.kind,
                            error_message: Some(err.message),
                            status: err.status,
                            used_local_fallback: Some(false),
                            planner_raw_output: None,
                            planner_parser_error: None,
                            planner_transport: Some("responses".to_string()),
                            planner_diagnostic: last_diag.clone(),
                            planner_recovery: None,
                            finish_reason: None,
                        });
                    }
                    break;
                }
            }
        }
        // 把 last_diag 提到 plan_task 分支外面，供后续空文本分类使用。
        // 注意：value 此时已经被填上 normalized body（无论是否拿到 text）。
        responses_diag = last_diag.clone();

        // === Payload Recovery Pipeline ===
        // 只有 Primary 命中 payload_missing 时进入。Retrieve 优先（不消耗模型 token），
        // 失败/不支持/empty 再走 SSE Streaming Fallback。总预算：1 Primary + 1 Retrieve
        // + 1 Stream，不允许循环。
        if payload_missing_detected {
            recovery_trace.attempted = true;
            if let Some(diag) = &last_diag {
                recovery_trace.provider_output_tokens = diag.output_tokens;
                recovery_trace.provider_response_id = diag.response_id.clone();
            }

            // Stage 1: Retrieve existing Response by id（不消耗模型 token）
            let response_id = last_diag
                .as_ref()
                .and_then(|d| d.response_id.clone())
                .filter(|s| !s.is_empty());
            if let Some(rid) = response_id.as_deref() {
                let retrieve_outcome =
                    retrieve_responses_recovery(&payload.base_url, &payload.token, rid).await;
                match retrieve_outcome {
                    ResponsesRecoveryOutcome::Recovered { text, source } => {
                        recovery_trace.retrieve_result = Some("recovered".to_string());
                        recovery_trace.text_source = Some(source);
                        recovery_trace.stream_result = Some("skipped".to_string());
                        println!(
                            "[ResponsesRecoverySummary] primary=payload_missing retrieve=recovered stream=skipped final_result=success text_len={}",
                            text.chars().count(),
                        );
                        // 把恢复出来的文本塞回 normalized choices 形态，让后续 Planner JSON
                        // 解析路径把它当作 success 处理。usage 此时已经无意义（恢复出来的文本
                        // 来自 Retrieve 而非新一轮推理），留空对象即可。
                        value = Some(json!({
                            "choices": [{ "message": { "content": text } }],
                            "usage": json!({}),
                        }));
                    }
                    ResponsesRecoveryOutcome::Empty { http_status, .. } => {
                        recovery_trace.retrieve_result = Some("empty".to_string());
                        recovery_trace.retrieve_http_status = http_status;
                    }
                    ResponsesRecoveryOutcome::Unsupported {
                        http_status,
                        reason,
                    } => {
                        recovery_trace.retrieve_result = Some("unsupported".to_string());
                        recovery_trace.retrieve_http_status = http_status;
                        println!(
                            "[ResponsesRecovery] stage=retrieve unsupported reason={}",
                            reason,
                        );
                    }
                    ResponsesRecoveryOutcome::Failed {
                        http_status,
                        kind,
                        reason,
                    } => {
                        recovery_trace.retrieve_result = Some("failed".to_string());
                        recovery_trace.retrieve_http_status = http_status;
                        println!(
                            "[ResponsesRecovery] stage=retrieve failed kind={} reason={}",
                            kind, reason,
                        );
                    }
                }
            } else {
                recovery_trace.retrieve_result = Some("skipped".to_string());
                println!(
                    "[ResponsesRecovery] stage=retrieve skipped reason=no_response_id_in_primary_body",
                );
            }

            // Stage 2: SSE Streaming Fallback（仅在 Retrieve 未恢复时执行）
            if recovery_trace.retrieve_result.as_deref() != Some("recovered") {
                let stream_outcome = stream_responses_recovery(
                    &payload.base_url,
                    &payload.token,
                    responses_body.clone(),
                )
                .await;
                match stream_outcome {
                    ResponsesRecoveryOutcome::Recovered { text, source } => {
                        recovery_trace.stream_result = Some("recovered".to_string());
                        recovery_trace.text_source = Some(source);
                        println!(
                            "[ResponsesRecoverySummary] primary=payload_missing retrieve={} stream=recovered final_result=success text_len={}",
                            recovery_trace.retrieve_result.as_deref().unwrap_or("skipped"),
                            text.chars().count(),
                        );
                        value = Some(json!({
                            "choices": [{ "message": { "content": text } }],
                            "usage": json!({}),
                        }));
                    }
                    ResponsesRecoveryOutcome::Empty { http_status, .. } => {
                        recovery_trace.stream_result = Some("empty".to_string());
                        recovery_trace.stream_http_status = http_status;
                    }
                    ResponsesRecoveryOutcome::Unsupported {
                        http_status,
                        reason,
                    } => {
                        recovery_trace.stream_result = Some("unsupported".to_string());
                        recovery_trace.stream_http_status = http_status;
                        println!(
                            "[ResponsesRecovery] stage=stream unsupported reason={}",
                            reason,
                        );
                    }
                    ResponsesRecoveryOutcome::Failed {
                        http_status,
                        kind,
                        reason,
                    } => {
                        recovery_trace.stream_result = Some("failed".to_string());
                        recovery_trace.stream_http_status = http_status;
                        println!(
                            "[ResponsesRecovery] stage=stream failed kind={} reason={}",
                            kind, reason,
                        );
                    }
                }
            }

            // 若恢复失败，value 仍保留 Primary 的 normalized empty body；
            // 下游 classify_missing_text 会基于 diag（含 output_tokens）判定为
            // provider_response_payload_missing。
            if recovery_trace.retrieve_result.as_deref() != Some("recovered")
                && recovery_trace.stream_result.as_deref() != Some("recovered")
            {
                println!(
                    "[ResponsesRecoverySummary] primary=payload_missing retrieve={} stream={} final_result=provider_response_payload_missing",
                    recovery_trace.retrieve_result.as_deref().unwrap_or("skipped"),
                    recovery_trace.stream_result.as_deref().unwrap_or("skipped"),
                );
            }
        }
    }

    if value.is_none() {
        // Take a reference first so we can re-read messages for the reverse
        // Responses fallback when chat completions returns protocol_not_supported.
        let chat_body_for_request = body.clone();
        match post_chat_completions(&payload.base_url, &payload.token, chat_body_for_request).await
        {
            Ok(v) => {
                transport_used = Some("chat_completions");
                value = Some(v);
            }
            Err(err) => {
                // Single-attempt reverse fallback: chat completions rejected with
                // protocol_not_supported → model only speaks Responses. Try Responses
                // exactly once. We do NOT loop back to chat completions afterwards.
                //
                // This guards models whose capability table later flips to Responses-only
                // even though `model_prefer_responses_transport` didn't recognise them.
                if is_protocol_not_supported(&err) && transport_used.is_none() {
                    println!(
                        "[ChatTransport] chat_completions returned protocol_not_supported; falling back to responses (single attempt)",
                    );
                    // Build a Responses body from the same message history. For chat we
                    // already preserved the messages array; for interpret / plan_task we
                    // fall back to the 2-message planner shape.
                    let messages_array = body
                        .get("messages")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    let fallback_responses_body = if payload.mode == "chat" {
                        json!({
                            "model": payload.model,
                            "input": messages_array,
                            "max_output_tokens": effective_max_tokens(payload.max_tokens)
                        })
                    } else {
                        let system_content = messages_array
                            .first()
                            .and_then(|first| first.get("content"))
                            .cloned()
                            .unwrap_or(json!(""));
                        let user_content = messages_array
                            .get(1)
                            .and_then(|first| first.get("content"))
                            .cloned()
                            .unwrap_or(json!(payload.text));
                        json!({
                            "model": payload.model,
                            "input": [
                                { "role": "system", "content": system_content },
                                { "role": "user", "content": user_content }
                            ],
                            "max_output_tokens": 4000
                        })
                    };
                    match post_responses_api(
                        &payload.base_url,
                        &payload.token,
                        fallback_responses_body,
                    )
                    .await
                    {
                        Ok((raw, http_status)) => {
                            transport_used = Some("responses");
                            let (normalized, diag) = responses_body_normalize(raw, http_status);
                            responses_diag = Some(diag);
                            // If Responses also returns no text, fall through to the
                            // existing empty-text classification below — we will not
                            // retry chat completions.
                            value = Some(normalized);
                        }
                        Err(responses_err) => {
                            // Both transports failed with explicit protocol mismatches.
                            // Surface the more informative of the two errors.
                            let final_kind = responses_err.kind.clone();
                            let final_message = responses_err.message.clone();
                            let final_status = responses_err.status;
                            return Ok(AgentRunResult {
                                ok: false,
                                intent: None,
                                confidence: None,
                                needs_clarification: None,
                                clarification_question: None,
                                recommended_action: None,
                                should_propose_execution: None,
                                final_prompt: None,
                                final_negative_prompt: None,
                                api_kind: None,
                                reply: None,
                                reasoning: None,
                                prompt_tokens: None,
                                completion_tokens: None,
                                error_kind: final_kind,
                                error_message: Some(final_message),
                                status: final_status,
                                used_local_fallback: Some(false),
                                planner_raw_output: None,
                                planner_parser_error: None,
                                planner_transport: Some("responses".to_string()),
                                planner_diagnostic: responses_diag.clone(),
                                planner_recovery: None,
                                finish_reason: None,
                            });
                        }
                    }
                } else {
                    return Ok(AgentRunResult {
                        ok: false,
                        intent: None,
                        confidence: None,
                        needs_clarification: None,
                        clarification_question: None,
                        recommended_action: None,
                        should_propose_execution: None,
                        final_prompt: None,
                        final_negative_prompt: None,
                        api_kind: None,
                        reply: None,
                        reasoning: None,
                        prompt_tokens: None,
                        completion_tokens: None,
                        error_kind: err.kind,
                        error_message: Some(err.message),
                        status: err.status,
                        used_local_fallback: Some(false),
                        planner_raw_output: None,
                        planner_parser_error: None,
                        planner_transport: Some("chat_completions".to_string()),
                        planner_diagnostic: responses_diag.clone(),
                        planner_recovery: None,
                        finish_reason: None,
                    });
                }
            }
        }
    }

    let mut value = value.unwrap_or(json!({}));
    if payload.mode == "interpret" || payload.mode == "plan_task" {
        // chat_completions 通道没有经过 responses_body_normalize —— 手工构造一份诊断，
        // 把 finish_reason / usage 带进"查看规划详情"；responses 通道已在 normalize 时填充。
        if transport_used == Some("chat_completions") && responses_diag.is_none() {
            responses_diag = Some(build_chat_completions_diagnostic(&value));
        }
        let mut content = planner_content_from_value(&value);
        log_planner_raw_response(transport_used, &payload.model, &content, responses_diag.as_ref());

        // ===== Planner 解析主循环（首次 + 最多 1 次针对性自动重试）=====
        // 重试触发条件（总共只允许一次）：
        //   - 空文本（仅 chat 通道；responses 通道 primary 循环已对空文本重试过）
        //   - JSON 截断（finish_reason=length / status=incomplete / 结构启发式命中）：
        //     重试时在 system 追加"压缩输出、确保 JSON 闭合"指令，同一通道重发。
        // 绝不做的事：对截断 JSON 做脑补补全 —— final_prompt 本身没生成完，
        // 补出来的只会是残缺任务。截断必须重新请求。
        let mut auto_retry: Option<PlannerAutoRetryTrace> = None;
        let mut retry_done = false;
        let mut parsed: Option<serde_json::Value> = None;
        let mut failure: Option<(String, String, Option<String>)> = None;
        let mut strategy = "balanced-object";
        let mut json_text = String::new();

        loop {
            if content.is_empty() {
                if !retry_done && transport_used == Some("chat_completions") {
                    match planner_targeted_retry(
                        &payload.base_url,
                        &payload.token,
                        &payload.model,
                        "chat_completions",
                        body.clone(),
                        PLANNER_EMPTY_RETRY_NUDGE,
                    )
                    .await
                    {
                        Some((retry_value, retry_diag)) => {
                            let retry_content = planner_content_from_value(&retry_value);
                            let recovered = !retry_content.is_empty();
                            retry_done = true;
                            auto_retry = Some(PlannerAutoRetryTrace {
                                trigger: "response_text_missing".to_string(),
                                result: if recovered {
                                    "recovered".to_string()
                                } else {
                                    "still_empty".to_string()
                                },
                            });
                            println!(
                                "[PlannerRetry] empty_text result={}",
                                auto_retry.as_ref().map(|t| t.result.as_str()).unwrap_or("?")
                            );
                            if recovered {
                                value = retry_value;
                                responses_diag = Some(
                                    retry_diag
                                        .unwrap_or_else(|| build_chat_completions_diagnostic(&value)),
                                );
                                content = retry_content;
                                log_planner_raw_response(
                                    transport_used,
                                    &payload.model,
                                    &content,
                                    responses_diag.as_ref(),
                                );
                                continue;
                            }
                        }
                        None => {
                            auto_retry = Some(PlannerAutoRetryTrace {
                                trigger: "response_text_missing".to_string(),
                                result: "request_failed".to_string(),
                            });
                            println!("[PlannerRetry] empty_text request_failed");
                        }
                    }
                }
                // 上游 2xx 但没有可解析文本。按 diag 细分：
                //   - upstream_error（顶层 error / status=failed）
                //   - response_incomplete（status=incomplete）
                //   - response_text_missing（reasoning-only / output 空）
                let (fine_kind, fine_reason) = match &responses_diag {
                    Some(d) => classify_missing_text(d),
                    None => (
                        "response_text_missing".to_string(),
                        "Agent 上游未返回任何可解析文本，请检查模型兼容性或稍后重试。".to_string(),
                    ),
                };
                println!(
                    "[PlannerRawResponse] empty_text classified kind={} reason={} auto_retry={:?}",
                    fine_kind, fine_reason, auto_retry,
                );
                let mut diag = responses_diag.clone();
                if let Some(d) = diag.as_mut() {
                    d.auto_retry = auto_retry.clone();
                }
                return Ok(planner_failure_result(
                    transport_used,
                    &fine_kind,
                    fine_reason,
                    responses_diag.as_ref().and_then(|d| d.http_status),
                    None,
                    None,
                    diag,
                    if recovery_trace.attempted {
                        Some(recovery_trace.clone())
                    } else {
                        None
                    },
                ));
            }

            let finish_reason = responses_diag.as_ref().and_then(|d| d.finish_reason.as_deref());
            let response_status = responses_diag
                .as_ref()
                .and_then(|d| d.response_status.as_deref());

            // JSON 提取（纯 JSON / markdown fence / 前后说明文字 → 平衡对象）
            // + serde 解析。两个失败点统一进入 Err((kind, parser_error))。
            let parse_outcome: Result<serde_json::Value, (String, Option<String>)> =
                match extract_json_object_text(&content) {
                    Some(text) => {
                        json_text = text;
                        strategy = if json_text == content.trim() {
                            "direct-json"
                        } else if content.starts_with("```") {
                            "code-fence"
                        } else {
                            "balanced-object"
                        };
                        match serde_json::from_str::<serde_json::Value>(&json_text) {
                            Ok(v) if v.is_object() => Ok(v),
                            Ok(other) => {
                                let kind_label = match &other {
                                    serde_json::Value::Null => "null",
                                    serde_json::Value::Bool(_) => "bool",
                                    serde_json::Value::Number(_) => "number",
                                    serde_json::Value::String(_) => "string",
                                    serde_json::Value::Array(_) => "array",
                                    serde_json::Value::Object(_) => "object",
                                };
                                Err((
                                    "planner_schema_invalid".to_string(),
                                    Some(format!("解析结果不是 JSON 对象（实际类型：{}）", kind_label)),
                                ))
                            }
                            Err(err) => Err((
                                "planner_json_parse_failed".to_string(),
                                Some(format!("{}", err)),
                            )),
                        }
                    }
                    None => Err((
                        "planner_json_parse_failed".to_string(),
                        Some("未找到可解析的 JSON 对象".to_string()),
                    )),
                };

            match parse_outcome {
                Ok(v) => {
                    println!(
                        "[PlannerParser] strategy={} success json_len={} fields={} auto_retry={:?}",
                        strategy,
                        json_text.len(),
                        v.as_object().map(|m| m.len()).unwrap_or(0),
                        auto_retry.as_ref().map(|t| t.result.as_str()),
                    );
                    parsed = Some(v);
                    break;
                }
                Err((kind, parser_error)) => {
                    // 关键分类：截断 vs 格式错误 —— 二者的修复路径完全不同。
                    let failure_kind =
                        classify_planner_parse_failure(&content, finish_reason, response_status);
                    let truncated = failure_kind == PlannerParseFailureKind::Truncated;
                    println!(
                        "[PlannerParser] strategy={} failed kind={} truncated={} parser_error={:?} json_text_len={} content_len={} finish_reason={:?} response_status={:?}",
                        strategy,
                        kind,
                        truncated,
                        parser_error,
                        json_text.len(),
                        content.len(),
                        finish_reason,
                        response_status,
                    );
                    if truncated && !retry_done && transport_used.is_some() {
                        let transport = transport_used.unwrap_or("chat_completions");
                        match planner_targeted_retry(
                            &payload.base_url,
                            &payload.token,
                            &payload.model,
                            transport,
                            body.clone(),
                            PLANNER_TRUNCATED_RETRY_NUDGE,
                        )
                        .await
                        {
                            Some((retry_value, retry_diag)) => {
                                let retry_content = planner_content_from_value(&retry_value);
                                let retry_recovered = extract_json_object_text(&retry_content)
                                    .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                                    .map(|v| v.is_object())
                                    .unwrap_or(false);
                                retry_done = true;
                                auto_retry = Some(PlannerAutoRetryTrace {
                                    trigger: "planner_output_truncated".to_string(),
                                    result: if retry_recovered {
                                        "recovered".to_string()
                                    } else {
                                        "still_truncated".to_string()
                                    },
                                });
                                println!(
                                    "[PlannerRetry] truncated result={}",
                                    auto_retry.as_ref().map(|t| t.result.as_str()).unwrap_or("?")
                                );
                                // 无论是否恢复都用重试结果继续下一轮：
                                // 恢复 → 走成功；未恢复 → retry_done 已置位，走最终截断错误。
                                value = retry_value;
                                match retry_diag {
                                    Some(d) => responses_diag = Some(d),
                                    None => responses_diag = Some(build_chat_completions_diagnostic(&value)),
                                }
                                content = retry_content;
                                log_planner_raw_response(
                                    transport_used,
                                    &payload.model,
                                    &content,
                                    responses_diag.as_ref(),
                                );
                                continue;
                            }
                            None => {
                                auto_retry = Some(PlannerAutoRetryTrace {
                                    trigger: "planner_output_truncated".to_string(),
                                    result: "request_failed".to_string(),
                                });
                                println!("[PlannerRetry] truncated request_failed");
                            }
                        }
                    }
                    let (final_kind, final_message) = if truncated {
                        (
                            "planner_output_truncated".to_string(),
                            if auto_retry.is_some() {
                                "规划结果被截断，系统已自动重试一次仍未获得完整 JSON，请重新规划或修改任务后重试。".to_string()
                            } else {
                                "规划结果被截断（输出长度达到上限），请重新规划或修改任务后重试。".to_string()
                            },
                        )
                    } else {
                        (
                            kind,
                            "规划模型返回了内容，但不是合法任务 JSON。".to_string(),
                        )
                    };
                    failure = Some((final_kind, final_message, parser_error));
                    break;
                }
            }
        }

        if let Some((kind, message, parser_error)) = failure {
            // 安全截断：避免上游返回异常长内容时把诊断卡撑爆或污染日志。
            // 仅截取前 4000 字符（按 Unicode scalar），对模型输出已足够。
            let raw_output_truncated: String = content.chars().take(4000).collect();
            let mut diag = responses_diag.clone();
            if let Some(d) = diag.as_mut() {
                d.auto_retry = auto_retry.clone();
            }
            return Ok(planner_failure_result(
                transport_used,
                &kind,
                message,
                None,
                Some(raw_output_truncated),
                parser_error,
                diag,
                if recovery_trace.attempted {
                    Some(recovery_trace.clone())
                } else {
                    None
                },
            ));
        }

        let parsed = match parsed {
            Some(v) => v,
            // 理论不可达：循环必然以 parsed 或 failure 结束。防御性兜底。
            None => {
                return Ok(planner_failure_result(
                    transport_used,
                    "planner_json_parse_failed",
                    "规划结果解析异常终止。".to_string(),
                    None,
                    None,
                    None,
                    responses_diag.clone(),
                    None,
                ))
            }
        };
        return Ok(AgentRunResult {
            ok: true,
            intent: parsed
                .get("intent")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            confidence: parsed.get("confidence").and_then(|v| v.as_f64()),
            needs_clarification: parsed.get("needs_clarification").and_then(|v| v.as_bool()),
            clarification_question: parsed
                .get("clarification_question")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            recommended_action: parsed
                .get("recommended_action")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            should_propose_execution: parsed
                .get("should_propose_execution")
                .and_then(|v| v.as_bool()),
            final_prompt: parsed
                .get("final_prompt")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            final_negative_prompt: parsed
                .get("final_negative_prompt")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            api_kind: parsed
                .get("api_kind")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            reply: None,
            reasoning: None,
            prompt_tokens: value
                .get("usage")
                .and_then(|v| v.get("prompt_tokens"))
                .and_then(|v| v.as_u64())
                .map(|v| v as u32),
            completion_tokens: value
                .get("usage")
                .and_then(|v| v.get("completion_tokens"))
                .and_then(|v| v.as_u64())
                .map(|v| v as u32),
            error_kind: None,
            error_message: None,
            status: None,
            used_local_fallback: Some(false),
            planner_raw_output: None,
            planner_parser_error: None,
            planner_transport: transport_used.map(|s| s.to_string()),
            planner_diagnostic: responses_diag.clone(),
            planner_recovery: if recovery_trace.attempted {
                Some(recovery_trace.clone())
            } else {
                None
            },
            finish_reason: None,
        });
    }

    let reply = value
        .get("choices")
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("message"))
        .and_then(|v| v.get("content"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    // 截断可见性（V4.2.7 comic-concepts 根因）：finish_reason=length 意味着正文
    // 被 max_tokens 砍断（推理型模型的思考 token 与正文共享预算），下游 JSON
    // 必然不闭合。打印一条真实事件日志，让"结构化失败"在控制台可归因。
    let finish_reason = chat_finish_reason(&value);
    if finish_reason.as_deref() == Some("length") {
        println!(
            "[ChatTransport] finish_reason=length role={} feature={} content_chars={} （输出被截断）",
            if payload.role.is_empty() { "unspecified" } else { &payload.role },
            if payload.feature.is_empty() { "-" } else { &payload.feature },
            reply.chars().count(),
        );
    }

    Ok(AgentRunResult {
        ok: true,
        intent: None,
        confidence: None,
        needs_clarification: None,
        clarification_question: None,
        recommended_action: None,
        should_propose_execution: None,
        final_prompt: None,
        final_negative_prompt: None,
        api_kind: None,
        reply: Some(reply),
        reasoning: None,
        prompt_tokens: value
            .get("usage")
            .and_then(|v| v.get("prompt_tokens"))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
        completion_tokens: value
            .get("usage")
            .and_then(|v| v.get("completion_tokens"))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
        error_kind: None,
        error_message: None,
        status: None,
        used_local_fallback: Some(false),
        planner_raw_output: None,
        planner_parser_error: None,
        planner_transport: None,
        planner_diagnostic: None,
        planner_recovery: None,
        finish_reason,
    })
}

#[tauri::command]
pub async fn understand_chat_images(
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeAuthState>,
    payload: VisionUnderstandPayload,
) -> Result<VisionUnderstandResult, String> {
    let settings: Settings = storage::read_json(&storage::settings_path(&app), Settings::default());

    // Prefer runtime memory token, fallback to settings.token
    let runtime_config = match state.config.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => RuntimeAuthConfig::default(),
    };
    let token = if !runtime_config.image_token.trim().is_empty() {
        runtime_config.image_token.trim().to_string()
    } else {
        settings.token.trim().to_string()
    };
    if token.is_empty() {
        return Ok(VisionUnderstandResult {
            ok: false,
            summary: None,
            raw_text: None,
            error_kind: Some("auth".to_string()),
            error_message: Some("官方图片理解未配置，请先在设置中填写图片 API Token".to_string()),
            status: None,
        });
    }

    let model = payload.model.trim().to_string();
    if model.is_empty() {
        return Ok(VisionUnderstandResult {
            ok: false,
            summary: None,
            raw_text: None,
            error_kind: Some("model_error".to_string()),
            error_message: Some("图片理解模型未配置，请在设置中选择支持视觉的模型".to_string()),
            status: None,
        });
    }

    if payload.images.is_empty() {
        return Ok(VisionUnderstandResult {
            ok: false,
            summary: None,
            raw_text: None,
            error_kind: Some("vision_error".to_string()),
            error_message: Some("当前请求未包含可识别的图片".to_string()),
            status: None,
        });
    }

    let instruction = format!(
        "你是独立图片理解模块。请根据用户问题理解附件图片，并只输出简洁纯文本，不要使用 Markdown。\n\
用户问题：{}\n\
输出要求：\n\
1. 直接回答用户问题；\n\
2. 补充主体、场景、风格、关键细节；\n\
3. 如果有多张图，说明它们的共同点或差异；\n\
4. 若图片信息不足，请明确说明不确定点。",
        payload.prompt.trim()
    );

    match call_official_vision_model(&token, &model, &instruction, &payload.images).await {
        Ok(text) => Ok(VisionUnderstandResult {
            ok: true,
            summary: Some(text.clone()),
            raw_text: Some(text),
            error_kind: None,
            error_message: None,
            status: None,
        }),
        Err(error) => Ok(VisionUnderstandResult {
            ok: false,
            summary: None,
            raw_text: None,
            error_kind: error.kind,
            error_message: Some(error.message),
            status: error.status,
        }),
    }
}

#[tauri::command]
pub async fn check_agent_endpoints(
    agent_base_url: String,
    agent_model: String,
    agent_token: String,
    official_token: String,
    vision_model: String,
) -> Result<AgentEndpointCheckResult, String> {
    let official_vision = if official_token.trim().is_empty() || vision_model.trim().is_empty() {
        AgentEndpointStatus {
            ok: false,
            kind: Some("not_configured".to_string()),
            message: "官方图片理解配置不完整，请检查图片 Token 或图片理解模型".to_string(),
            status: None,
        }
    } else {
        match call_official_vision_model(
            official_token.trim(),
            vision_model.trim(),
            "请只回复 ok。",
            &vec!["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0e0AAAAASUVORK5CYII=".to_string()],
        )
        .await
        {
            Ok(_) => local_endpoint_status(true, "官方图片理解接口可用"),
            Err(error) => error,
        }
    };

    if agent_base_url.trim().is_empty()
        || agent_model.trim().is_empty()
        || agent_token.trim().is_empty()
    {
        let not_configured = AgentEndpointStatus {
            ok: false,
            kind: Some("not_configured".to_string()),
            message: "智能体配置不完整".to_string(),
            status: None,
        };
        return Ok(AgentEndpointCheckResult {
            chat: not_configured.clone(),
            chat_with_system: not_configured.clone(),
            chat_multimodal: not_configured.clone(),
            official_vision,
            interpret: not_configured.clone(),
            generation: not_configured.clone(),
            edit: not_configured,
        });
    }

    let chat = match post_chat_completions(
        &agent_base_url,
        &agent_token,
        json!({
            "model": agent_model,
            "messages": [
                { "role": "system", "content": "你是接口连通性检测助手，请只回复 ok。" },
                { "role": "user", "content": "ok" }
            ],
            "max_tokens": 8
        }),
    )
    .await
    {
        Ok(_) => local_endpoint_status(true, "Agent 对话接口可用"),
        Err(error) => error,
    };

    let chat_with_system = if chat.ok {
        match post_chat_completions(
            &agent_base_url,
            &agent_token,
            json!({
                "model": agent_model,
                "messages": [
                    { "role": "system", "content": "你是接口连通性检测助手，请简短回复 ok。" },
                    { "role": "user", "content": "只回复 ok" }
                ],
                "max_tokens": 12
            }),
        )
        .await
        {
            Ok(_) => local_endpoint_status(true, "带 system prompt 的聊天请求可用"),
            Err(error) => error,
        }
    } else {
        AgentEndpointStatus {
            ok: false,
            kind: chat.kind.clone(),
            message: "带 system prompt 的聊天请求依赖基础对话接口，当前未通过基础对话检测"
                .to_string(),
            status: chat.status,
        }
    };

    let chat_multimodal = if chat.ok {
        match post_chat_completions(
            &agent_base_url,
            &agent_token,
            json!({
                "model": agent_model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            { "type": "text", "text": "请回复 ok。若不支持多段 content 或图片消息格式，请直接返回错误。" },
                            { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0e0AAAAASUVORK5CYII=" } }
                        ]
                    }
                ],
                "max_tokens": 12
            }),
        )
        .await
        {
            Ok(_) => local_endpoint_status(true, "聊天链路兼容图片与多段 content 消息格式"),
            Err(mut error) => {
                if matches!(error.kind.as_deref(), Some("invalid_request") | Some("upstream_api") | Some("invalid_response")) {
                    error.kind = Some("multimodal_unsupported".to_string());
                    error.message = format!(
                        "当前代理基础对话可用，但不兼容聊天链路中的多模态消息格式。{}",
                        error.message
                    );
                }
                error
            }
        }
    } else {
        AgentEndpointStatus {
            ok: false,
            kind: chat.kind.clone(),
            message: "多模态聊天兼容性检测依赖基础对话接口，当前未通过基础对话检测".to_string(),
            status: chat.status,
        }
    };

    let generation = if chat.ok {
        local_endpoint_status(true, "文生图接口配置已就绪")
    } else {
        AgentEndpointStatus {
            ok: false,
            kind: chat.kind.clone(),
            message: if chat.kind.as_deref() == Some("invalid_response") {
                "模型可对话，但不稳定遵循 JSON 输出要求".to_string()
            } else {
                "文生图接口依赖同一服务配置，当前未通过对话接口检测".to_string()
            },
            status: chat.status,
        }
    };

    let edit = if chat.ok {
        local_endpoint_status(true, "图生图接口配置已就绪")
    } else {
        AgentEndpointStatus {
            ok: false,
            kind: chat.kind.clone(),
            message: if chat.kind.as_deref() == Some("invalid_response") {
                "模型可对话，但不稳定遵循 JSON 输出要求".to_string()
            } else {
                "图生图接口依赖同一服务配置，当前未通过对话接口检测".to_string()
            },
            status: chat.status,
        }
    };

    let interpret = if chat_with_system.ok {
        let interpret_body = json!({
            "model": agent_model,
            "messages": [
                { "role": "system", "content": "Return valid JSON only. 请仅输出合法 JSON，不要输出 markdown，不要输出额外解释。必须返回对象：{\"intent\":\"chat\",\"confidence\":0.9,\"needs_clarification\":false,\"clarification_question\":\"\",\"recommended_action\":\"\",\"should_propose_execution\":false,\"final_prompt\":\"\",\"final_negative_prompt\":\"\",\"api_kind\":\"generation\"}" },
                { "role": "user", "content": "请返回一个最小合法 JSON 示例。" }
            ],
            "max_tokens": 180
        });

        match post_chat_completions(&agent_base_url, &agent_token, interpret_body).await {
            Ok(payload) => {
                let content = payload
                    .get("choices")
                    .and_then(|v| v.get(0))
                    .and_then(|v| v.get("message"))
                    .and_then(|v| v.get("content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                match extract_json_object_text(content)
                    .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                    .filter(|value| value.is_object())
                {
                    Some(_) => local_endpoint_status(true, "Agent 理解接口可正常返回 JSON"),
                    None => AgentEndpointStatus {
                        ok: false,
                        kind: Some("json_output_unsupported".to_string()),
                        message: "模型可对话，但不稳定遵循 JSON 输出要求".to_string(),
                        status: None,
                    },
                }
            }
            Err(error) => error,
        }
    } else {
        AgentEndpointStatus {
            ok: false,
            kind: chat_with_system.kind.clone(),
            message: "Agent 理解接口依赖带 system prompt 的聊天请求，当前未通过该项检测"
                .to_string(),
            status: chat_with_system.status,
        }
    };

    Ok(AgentEndpointCheckResult {
        chat,
        chat_with_system,
        chat_multimodal,
        official_vision,
        interpret,
        generation,
        edit,
    })
}

// ========== Agent templates ==========

#[tauri::command]
pub fn get_agent_task_templates(app: tauri::AppHandle) -> Result<Vec<AgentTaskTemplate>, String> {
    storage::get_agent_task_templates(&app)
}

#[tauri::command]
pub fn save_agent_task_template(
    app: tauri::AppHandle,
    template: AgentTaskTemplate,
) -> Result<AgentTaskTemplate, String> {
    storage::save_agent_task_template(&app, template)
}

#[tauri::command]
pub fn delete_agent_task_template(app: tauri::AppHandle, id: String) -> Result<(), String> {
    storage::delete_agent_task_template(&app, &id)
}

#[tauri::command]
pub fn toggle_agent_task_template(
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    storage::toggle_agent_task_template(&app, &id, enabled)
}

#[tauri::command]
pub fn get_agent_style_templates(app: tauri::AppHandle) -> Result<Vec<AgentStyleTemplate>, String> {
    storage::get_agent_style_templates(&app)
}

#[tauri::command]
pub fn save_agent_style_template(
    app: tauri::AppHandle,
    template: AgentStyleTemplate,
) -> Result<AgentStyleTemplate, String> {
    storage::save_agent_style_template(&app, template)
}

#[tauri::command]
pub fn delete_agent_style_template(app: tauri::AppHandle, id: String) -> Result<(), String> {
    storage::delete_agent_style_template(&app, &id)
}

#[tauri::command]
pub fn toggle_agent_style_template(
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    storage::toggle_agent_style_template(&app, &id, enabled)
}

#[tauri::command]
pub fn get_agent_template_logs(
    app: tauri::AppHandle,
    limit: Option<usize>,
) -> Result<Vec<AgentTemplateLog>, String> {
    storage::get_agent_template_logs(&app, limit)
}

#[tauri::command]
pub fn append_agent_template_log(
    app: tauri::AppHandle,
    log: AgentTemplateLog,
) -> Result<AgentTemplateLog, String> {
    storage::append_agent_template_log(&app, log)
}

#[tauri::command]
pub fn export_agent_templates(app: tauri::AppHandle) -> Result<AgentTemplateExportPayload, String> {
    storage::export_agent_templates(&app)
}

#[tauri::command]
pub fn import_agent_templates(
    app: tauri::AppHandle,
    payload: AgentTemplateImportPayload,
    conflict_mode: Option<String>,
) -> Result<AgentTemplateExportPayload, String> {
    storage::import_agent_templates(&app, payload, conflict_mode.as_deref().unwrap_or("skip"))
}

#[tauri::command]
pub fn export_agent_template_draft(
    app: tauri::AppHandle,
    template_type: String,
    template_id: String,
) -> Result<AgentTemplateDraftPayload, String> {
    if template_type == "task" {
        let template = storage::get_agent_task_templates(&app)?
            .into_iter()
            .find(|item| item.id == template_id)
            .ok_or_else(|| "未找到指定的主任务模板".to_string())?;
        return Ok(AgentTemplateDraftPayload {
            template_type: "task".to_string(),
            draft_mode: "agent_editable".to_string(),
            goal: format!(
                "请完善模板“{}”，让它更适合当前图片业务场景。",
                template.name
            ),
            current_template: AgentTemplateDraftCurrentTemplate {
                id: template.id,
                name: template.name,
                category: template.category,
                scene: template.scene,
                intent: template.intent,
                trigger_keywords: template.trigger_keywords,
                requires_source_images: template.requires_source_images,
                requires_confirmation: template.requires_confirmation,
                system_prompt: template.system_prompt,
                prompt_template: template.prompt_template,
                negative_prompt_template: template.negative_prompt_template,
                recommended_action_template: template.recommended_action_template,
            },
            requirements: AgentTemplateDraftRequirements {
                target_use_cases: vec![
                    "图片生成".to_string(),
                    "图片编辑".to_string(),
                    "电商图像场景".to_string(),
                ],
                must_keep: vec!["任务识别准确".to_string(), "提示词可执行".to_string()],
                should_improve: vec![
                    "提示词完整度".to_string(),
                    "负面提示词质量".to_string(),
                    "推荐执行说明".to_string(),
                ],
            },
            expected_output: AgentTemplateDraftExpectedOutput {
                system_prompt: "string".to_string(),
                prompt_template: "string".to_string(),
                negative_prompt_template: "string".to_string(),
                recommended_action_template: "string".to_string(),
                extra_trigger_keywords: vec!["string".to_string()],
            },
        });
    }

    let template = storage::get_agent_style_templates(&app)?
        .into_iter()
        .find(|item| item.id == template_id)
        .ok_or_else(|| "未找到指定的风格模板".to_string())?;
    Ok(AgentTemplateDraftPayload {
        template_type: "style".to_string(),
        draft_mode: "agent_editable".to_string(),
        goal: format!(
            "请完善风格模板“{}”，让它更适合当前图片业务场景。",
            template.name
        ),
        current_template: AgentTemplateDraftCurrentTemplate {
            id: template.id,
            name: template.name,
            category: "style".to_string(),
            scene: "general".to_string(),
            intent: "image_generate".to_string(),
            trigger_keywords: template.trigger_keywords,
            requires_source_images: false,
            requires_confirmation: true,
            system_prompt: String::new(),
            prompt_template: template.style_prompt_fragment,
            negative_prompt_template: template.negative_prompt_fragment,
            recommended_action_template: String::new(),
        },
        requirements: AgentTemplateDraftRequirements {
            target_use_cases: vec!["风格扩展".to_string(), "视觉统一".to_string()],
            must_keep: vec!["风格描述稳定".to_string()],
            should_improve: vec![
                "风格片段质量".to_string(),
                "负面风格约束".to_string(),
                "关键词覆盖".to_string(),
            ],
        },
        expected_output: AgentTemplateDraftExpectedOutput {
            system_prompt: String::new(),
            prompt_template: "string".to_string(),
            negative_prompt_template: "string".to_string(),
            recommended_action_template: String::new(),
            extra_trigger_keywords: vec!["string".to_string()],
        },
    })
}

// ========== Tasks ==========

#[tauri::command]
pub fn get_tasks(app: tauri::AppHandle) -> Vec<Task> {
    let path = storage::tasks_path(&app);
    storage::read_json(&path, Vec::new())
}

fn is_reference_bound_detail_task_text(text: &str) -> bool {
    let has_design_target = [
        "详情图",
        "长图",
        "海报",
        "A+图",
        "a+图",
        "主图",
        "说明图",
        "测量图",
        "展示图",
        "客户看",
        "电商图",
        "详情页",
    ]
    .iter()
    .any(|keyword| text.contains(keyword));
    if !has_design_target {
        return false;
    }
    let has_model_signal = ["模特", "人物", "穿搭", "上身", "实穿", "展示参考"]
        .iter()
        .any(|keyword| text.contains(keyword));
    let has_product_signal = [
        "产品",
        "商品",
        "衣服",
        "服装",
        "单品",
        "白底图",
        "产品图",
        "商品图",
    ]
    .iter()
    .any(|keyword| text.contains(keyword));
    let has_binding_signal = [
        "根据我提供",
        "基于我提供",
        "参考我提供",
        "同时参考",
        "参考关系",
        "保持一致",
        "模特图",
        "产品图",
        "白底图",
    ]
    .iter()
    .any(|keyword| text.contains(keyword));
    has_model_signal && has_product_signal && has_binding_signal
}

/// 任务最终生成数量：携带 batch_items 时以子项数为准（防止 count 与子项不一致悄悄放大/回落）；
/// single 模式（无 batch_items）强制为 1——mode 是语义来源，不信任客户端 count
fn resolve_task_count(count: usize, batch_items_len: usize, execution_mode: &str) -> usize {
    if batch_items_len > 0 {
        batch_items_len
    } else if execution_mode == "single" {
        1
    } else {
        count
    }
}

/// V4.0.8：任务 task_type 最终决策（create / retry 共用，纯函数可测）。
/// 规则：默认原样保留（空回落 generate）——图生图任务重试 / 重建后仍是图生图；
/// 唯一例外是「参考绑定详情图」启发式把满足条件的 generate 升级为 edit。
/// 任何图片任务类型都不可能经此函数进入文本会话通道。
fn resolve_final_task_type(
    original_task_type: &str,
    reference_bound_design_text: bool,
    source_image_count: usize,
) -> String {
    let mut task_type = if original_task_type.is_empty() {
        "generate".to_string()
    } else {
        original_task_type.to_string()
    };
    if reference_bound_design_text && source_image_count >= 2 && task_type == "generate" {
        task_type = "edit".to_string();
    }
    task_type
}

#[tauri::command]
pub fn create_task(app: tauri::AppHandle, params: CreateTaskParams) -> Result<Task, String> {
    // 视觉理解任务由前端驱动（BYOK 视觉模型分析），不产出图片文件：
    // 放宽输出目录要求，也不参与详情图参考图数量校验
    let is_vision_task = params.task_type == "vision_understanding";
    if params.prompt.trim().is_empty() {
        return Err("提示词不能为空".to_string());
    }
    if params.output_dir.trim().is_empty() && !is_vision_task {
        return Err("请选择输出目录".to_string());
    }
    if params.task_type == "edit" && params.source_images.is_empty() {
        return Err("图生图任务必须至少提供一张源图片".to_string());
    }
    let reference_bound_design_text = !is_vision_task
        && is_reference_bound_detail_task_text(&format!(
            "{}\n{}",
            params.user_prompt_raw, params.final_prompt
        ));
    if reference_bound_design_text && params.source_images.len() < 2 {
        return Err("该详情图任务至少需要 2 张参考图：1 张模特图 + 1 张产品白底图".to_string());
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Local::now().to_rfc3339();
    let task_type = resolve_final_task_type(
        &params.task_type,
        reference_bound_design_text,
        params.source_images.len(),
    );
    let prompt = params.prompt.clone();
    let negative_prompt = params.negative_prompt.clone();

    let execution_mode = if params.execution_mode.trim().is_empty() {
        "single".to_string()
    } else {
        params.execution_mode.trim().to_string()
    };

    // 携带 batch_items 的批量任务（variant_set / multi_input）：生成数量必须与子项数严格一致，
    // 否则 task_runner 的 effective_prompt 会把多余指标回落到基础 Prompt，悄悄多生成图片（历史 3->4 的残留通道）。
    // single 模式恒为 1（服务端兜底，不信任客户端 count）
    let count = resolve_task_count(params.count, params.batch_items.len(), &execution_mode);

    let task = Task {
        id,
        prompt: prompt.clone(),
        negative_prompt: negative_prompt.clone(),
        user_prompt_raw: if params.user_prompt_raw.trim().is_empty() {
            prompt.clone()
        } else {
            params.user_prompt_raw
        },
        final_prompt: if params.final_prompt.trim().is_empty() {
            prompt.clone()
        } else {
            params.final_prompt
        },
        final_negative_prompt: if params.final_negative_prompt.trim().is_empty() {
            negative_prompt.clone()
        } else {
            params.final_negative_prompt
        },
        prompt_optimized: params.prompt_optimized,
        prompt_optimization: params.prompt_optimization.clone(),
        agent_intent: params.agent_intent,
        task_source: if params.task_source.trim().is_empty() {
            "manual".to_string()
        } else {
            params.task_source
        },
        size: params.size,
        quality: params.quality,
        output_format: params.output_format,
        count,
        status: "pending".to_string(),
        created_at: now,
        started_at: None,
        completed_at: None,
        output_dir: params.output_dir,
        success_count: 0,
        failed_count: 0,
        task_type,
        source_images: params.source_images.clone(),
        mask_image: params.mask_image.clone(),
        execution_mode,
        batch_strategy: params.batch_strategy.clone(),
        task_plan_summary: params.task_plan_summary.clone(),
        batch_items: params.batch_items.clone(),
        composite_layout: params.composite_layout.clone(),
        subject_entities: params.subject_entities.clone(),
        source_task_id: params.source_task_id.clone(),
        source_task_kind: params.source_task_kind.clone(),
        stage_note: String::new(),
        source_app: String::new(),
        source_request_id: String::new(),
        source_context: None,
        pose_batch: None,
        provenance: params.provenance.clone(),
        execution_snapshot: params.execution_snapshot.clone(),
        sub_tasks: (0..count)
            .map(|i| SubTask {
                index: i,
                status: "pending".to_string(),
                image_id: None,
                error: None,
                label: if is_vision_task {
                    Some("视觉分析".to_string())
                } else {
                    params.batch_items.get(i).map(|item| item.label.clone())
                },
                retry_count: 0,
                attempt_errors: Vec::new(),
                error_detail: None,
                attempt_details: Vec::new(),
                executed_prompt: None,
            })
            .collect(),
    };

    storage::with_tasks(&app, |tasks| {
        tasks.push(task.clone());
    });

    Ok(task)
}

#[tauri::command]
pub fn cancel_task(app: tauri::AppHandle, task_id: String) -> Result<(), String> {
    // 终态保护（CAS 语义，在 with_tasks 互斥锁内做条件更新）：
    // completed/failed/cancelled 不允许被改写成 cancelled —— 这是“手动取消把
    // 已完成任务覆盖成 cancelled”的根因。只有 pending/running 任务可取消。
    let cancelled = storage::with_tasks(&app, |tasks| {
        if let Some(t) = tasks.iter_mut().find(|t| t.id == task_id) {
            crate::reconciliation::cancel_task_in_place(t)
        } else {
            false
        }
    });
    if cancelled {
        let _ = app.emit("task-updated", &task_id);
    }
    Ok(())
}

/// 视觉理解任务状态推进（纯函数部分，便于单测）。
///
/// 状态机：pending → running → completed / failed；活跃态可 → cancelled。
/// 终态一律拒绝再次更新（防止页面侧旧请求覆盖新结果）。
pub fn apply_vision_task_update(
    task: &mut Task,
    status: &str,
    stage_note: &str,
    plan_summary: &str,
    error: &str,
) -> Result<(), String> {
    if task.task_type != "vision_understanding" {
        return Err("仅视觉理解任务支持此更新通道".to_string());
    }
    if crate::reconciliation::is_terminal_status(&task.status) {
        return Err("任务已结束，不能重复更新".to_string());
    }
    match status {
        "running" => {
            task.status = "running".to_string();
            if task.started_at.is_none() {
                task.started_at = Some(chrono::Local::now().to_rfc3339());
            }
        }
        "completed" => {
            task.status = "completed".to_string();
            for st in task.sub_tasks.iter_mut() {
                if !crate::reconciliation::is_terminal_status(&st.status) {
                    st.status = "completed".to_string();
                    st.error = None;
                }
            }
            task.completed_at = Some(chrono::Local::now().to_rfc3339());
        }
        "failed" => {
            task.status = "failed".to_string();
            for st in task.sub_tasks.iter_mut() {
                if !crate::reconciliation::is_terminal_status(&st.status) {
                    st.status = "failed".to_string();
                    st.error = Some(if error.is_empty() {
                        "视觉理解失败".to_string()
                    } else {
                        error.to_string()
                    });
                }
            }
            task.completed_at = Some(chrono::Local::now().to_rfc3339());
        }
        "cancelled" => {
            crate::reconciliation::cancel_task_in_place(task);
        }
        other => {
            return Err(format!("非法的视觉理解任务状态：{other}"));
        }
    }
    if !stage_note.is_empty() {
        task.stage_note = stage_note.to_string();
    }
    if !plan_summary.is_empty() {
        task.task_plan_summary = plan_summary.to_string();
    }
    let (success, failed) = (
        task.sub_tasks.iter().filter(|st| st.status == "completed").count(),
        task.sub_tasks.iter().filter(|st| st.status == "failed").count(),
    );
    task.success_count = success;
    task.failed_count = failed;
    Ok(())
}

#[tauri::command]
pub fn update_vision_task(
    app: tauri::AppHandle,
    params: crate::models::UpdateVisionTaskParams,
) -> Result<Task, String> {
    let updated = storage::with_tasks(&app, |tasks| {
        let task = tasks
            .iter_mut()
            .find(|t| t.id == params.task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        apply_vision_task_update(
            task,
            &params.status,
            &params.stage_note,
            &params.plan_summary,
            &params.error,
        )?;
        Ok::<Task, String>(task.clone())
    })?;
    let _ = app.emit("task-updated", &params.task_id);
    Ok(updated)
}

#[tauri::command]
pub fn retry_task(app: tauri::AppHandle, task_id: String) -> Result<Task, String> {
    let new_task = storage::with_tasks(&app, |tasks| {
        let original = tasks
            .iter()
            .find(|t| t.id == task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        // 视觉理解任务由前端驱动，队列重试会产生一个永远 pending 的僵尸任务
        if original.task_type == "vision_understanding" {
            return Err("视觉理解任务不支持队列重试，请在视觉理解页重新发起分析".to_string());
        }

        let now = chrono::Local::now().to_rfc3339();
        // V4.0.8：重试沿用原任务类型（图生图重试仍是图生图，参考图 / 参数全部保留）
        let task_type = resolve_final_task_type(
            &original.task_type,
            is_reference_bound_detail_task_text(&format!(
                "{}\n{}",
                original.user_prompt_raw, original.final_prompt
            )),
            original.source_images.len(),
        );

        let new_task = Task {
            id: uuid::Uuid::new_v4().to_string(),
            prompt: original.prompt.clone(),
            negative_prompt: original.negative_prompt.clone(),
            user_prompt_raw: original.user_prompt_raw.clone(),
            final_prompt: original.final_prompt.clone(),
            final_negative_prompt: original.final_negative_prompt.clone(),
            prompt_optimized: original.prompt_optimized,
            prompt_optimization: original.prompt_optimization.clone(),
            agent_intent: original.agent_intent.clone(),
            task_source: original.task_source.clone(),
            size: original.size.clone(),
            quality: original.quality.clone(),
            output_format: original.output_format.clone(),
            count: original.count,
            status: "pending".to_string(),
            created_at: now,
            started_at: None,
            completed_at: None,
            output_dir: original.output_dir.clone(),
            success_count: 0,
            failed_count: 0,
            task_type,
            source_images: original.source_images.clone(),
            mask_image: original.mask_image.clone(),
            execution_mode: original.execution_mode.clone(),
            batch_strategy: original.batch_strategy.clone(),
            task_plan_summary: original.task_plan_summary.clone(),
            batch_items: original.batch_items.clone(),
            composite_layout: original.composite_layout.clone(),
            subject_entities: original.subject_entities.clone(),
            source_task_id: original.source_task_id.clone(),
            source_task_kind: original.source_task_kind.clone(),
            source_app: original.source_app.clone(),
            source_request_id: String::new(),
            source_context: original.source_context.clone(),
            // 动作白膜批：整批重提克隆保留批元数据（来源继承；batchId 查找仍命中原任务）
            pose_batch: original.pose_batch.clone(),
            provenance: original.provenance.clone(),
            // V4.2.4：整批重提继承执行快照（创建时刻执行意图与源一致）
            execution_snapshot: original.execution_snapshot.clone(),
            stage_note: String::new(),
            sub_tasks: (0..original.count)
                .map(|i| SubTask {
                    index: i,
                    status: "pending".to_string(),
                    image_id: None,
                    error: None,
                    label: original.batch_items.get(i).map(|item| item.label.clone()),
                    retry_count: 0,
                    attempt_errors: Vec::new(),
                    error_detail: None,
                    attempt_details: Vec::new(),
                    executed_prompt: None,
                })
                .collect(),
        };
        tasks.push(new_task.clone());
        Ok::<Task, String>(new_task)
    })?;

    Ok(new_task)
}

// ========== Images ==========

/// V4.0.5 单/批量失败子任务重试结果：reset_indexes 供前端精确计费（只预占重试的槽位数）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrySubtasksResult {
    pub reset_indexes: Vec<usize>,
    pub reset_count: usize,
}

/// 重试失败子任务：把指定下标（None = 全部）的 failed 子任务重置为 pending，
/// 任务回到 pending 由执行器只补跑这些槽位；已完成子任务的图片与状态绝不动。
#[tauri::command]
pub fn retry_task_subtasks(
    app: tauri::AppHandle,
    task_id: String,
    sub_task_indexes: Option<Vec<usize>>,
) -> Result<RetrySubtasksResult, String> {
    let reset = storage::with_tasks(&app, |tasks| {
        let task = tasks
            .iter_mut()
            .find(|t| t.id == task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.task_type == "vision_understanding" {
            return Err("视觉理解任务不支持队列重试，请在视觉理解页重新发起分析".to_string());
        }
        if !crate::reconciliation::is_terminal_status(&task.status) {
            return Err("任务仍在执行或排队中，请等待完成后再重试失败项".to_string());
        }
        Ok(crate::reconciliation::reset_failed_subtasks_for_retry(
            task,
            sub_task_indexes.as_deref(),
        ))
    })?;
    if reset.is_empty() {
        return Err("没有可重试的失败子任务".to_string());
    }
    let _ = app.emit("task-updated", &task_id);
    Ok(RetrySubtasksResult {
        reset_count: reset.len(),
        reset_indexes: reset,
    })
}

/// V4.0.6 批量任务重做：基于源 Batch Task 的选中子项创建全新任务。
/// 源任务（含子任务状态 / retry 历史 / 结果图）绝不被修改；
/// 计费授权由前端在调用前完成（redo = 新的生成任务，正常授权结算）。
#[tauri::command]
pub fn create_batch_redo_task(
    app: tauri::AppHandle,
    request: crate::models::CreateBatchRedoRequest,
) -> Result<Task, String> {
    if request.source_task_id.trim().is_empty() {
        return Err("缺少源任务 ID".to_string());
    }
    let new_task = storage::with_tasks(&app, |tasks| {
        let source = tasks
            .iter()
            .find(|t| t.id == request.source_task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        let task = crate::batch_redo::build_batch_redo_task(
            source,
            &request,
            chrono::Local::now().to_rfc3339(),
        )?;
        tasks.push(task.clone());
        Ok::<Task, String>(task)
    })?;
    let _ = app.emit("task-updated", &new_task.id);
    Ok(new_task)
}

#[tauri::command]
pub fn read_thumbnail(app: tauri::AppHandle, path: String) -> Result<String, String> {
    if !Path::new(&path).exists() {
        return Err("文件已移动或不存在".to_string());
    }
    let cache_dir = storage::data_dir(&app).join("thumbs");
    fs::create_dir_all(&cache_dir).ok();

    let path_hash = format!("{:x}", md5::compute(&path));
    let _ext = Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    let cache_path = cache_dir.join(format!("{}_thumb.jpg", path_hash));

    if cache_path.exists() {
        // Invalidate cache if source file is newer than cached thumb
        let source_modified = fs::metadata(&path).and_then(|m| m.modified()).ok();
        let cache_modified = fs::metadata(&cache_path).and_then(|m| m.modified()).ok();
        let cache_valid = match (source_modified, cache_modified) {
            (Some(src), Some(cached)) => cached >= src,
            _ => true,
        };
        if cache_valid {
            let data = fs::read(&cache_path).map_err(|e| format!("读取缓存失败: {}", e))?;
            let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, data);
            return Ok(format!("data:image/jpeg;base64,{}", b64));
        }
    }

    let data = fs::read(&path).map_err(|e| format!("无法读取图片: {}", e))?;
    let img = image::load_from_memory(&data).map_err(|e| format!("解码图片失败: {}", e))?;
    let thumb = img.thumbnail(200, 200);
    let mut buf = std::io::Cursor::new(Vec::new());
    thumb
        .write_to(&mut buf, image::ImageFormat::Jpeg)
        .map_err(|e| format!("编码缩略图失败: {}", e))?;
    let thumb_bytes = buf.into_inner();
    let _ = fs::write(&cache_path, &thumb_bytes);

    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, thumb_bytes);
    Ok(format!("data:image/jpeg;base64,{}", b64))
}

#[tauri::command]
pub fn get_images(app: tauri::AppHandle) -> Vec<ImageRecord> {
    sync_images(&app)
}

#[tauri::command]
pub fn rescan_image_library(app: tauri::AppHandle) -> Vec<ImageRecord> {
    sync_images(&app)
}

// ========== 图片库导入（Gallery Drag Import，V4.1） ==========
//
// 唯一入库链路仍是 sync_images（目录扫描索引）；本命令只负责
// 「外部文件 → 复制进 library_input_dir → 触发同一套扫描」，
// 不自建索引写入，保证拖拽导入与手动放入目录的记录形态完全一致
//（task_id = "library"、source_kind 由 classify_source_kind 判定 = library_input）。

#[derive(Debug, Serialize)]
pub struct ImportedLibraryImage {
    pub file_name: String,
    pub local_path: String,
}

#[derive(Debug, Serialize)]
pub struct LibraryImportIssue {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Serialize, Default)]
pub struct ImportImagesToLibraryResult {
    pub imported: Vec<ImportedLibraryImage>,
    pub skipped: Vec<LibraryImportIssue>,
    pub failed: Vec<LibraryImportIssue>,
    /// 导入触发了重扫时返回全量图库记录（前端直接刷新 store，不再二次扫描）。
    pub images: Vec<ImageRecord>,
}

/// 路径是否位于管理目录之下（与 classify_source_kind 同一套归一化前缀规则，
/// Windows 大小写不敏感；「本地导入目录 / 输出目录」内的文件都算已在图片库中）。
fn path_under_managed_dir(path: &str, dir: &str) -> bool {
    let key = normalize_image_path_key(path);
    let dir_key = normalize_image_path_key(dir);
    if dir_key.is_empty() {
        return false;
    }
    key == dir_key || key.starts_with(&format!("{}/", dir_key))
}

fn file_md5(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    Some(format!("{:x}", md5::compute(&bytes)))
}

/// 目标名冲突时的重名策略：`girl.png` → `girl (1).png`、`girl (2).png`…
/// （Windows 资源管理器同形态）。策略只存在于本导入命令内；
/// 页面 / 前端禁止自行拼接副本后缀。
fn next_available_dest(input_dir: &Path, file_name: &str) -> PathBuf {
    let direct = input_dir.join(file_name);
    if !direct.exists() {
        return direct;
    }
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image")
        .to_string();
    let ext = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    for n in 1..1000u32 {
        let candidate = if ext.is_empty() {
            format!("{} ({})", stem, n)
        } else {
            format!("{} ({}).{}", stem, n, ext)
        };
        let path = input_dir.join(&candidate);
        if !path.exists() {
            return path;
        }
    }
    direct
}

fn import_images_to_library_core(
    settings: &Settings,
    paths: &[String],
) -> Result<ImportImagesToLibraryResult, String> {
    let input_dir_raw = settings.library_input_dir.trim();
    if input_dir_raw.is_empty() {
        return Err("请先在「设置与更新 → 图片与文件」中配置本地导入目录".to_string());
    }
    let input_dir = Path::new(input_dir_raw);
    fs::create_dir_all(input_dir).map_err(|e| format!("无法访问本地导入目录: {}", e))?;

    let mut result = ImportImagesToLibraryResult::default();
    let mut seen_sources: HashSet<String> = HashSet::new();

    for raw in paths {
        let path_str = raw.trim().to_string();
        if path_str.is_empty() {
            continue;
        }
        // 同一次拖入中的重复路径只处理一次
        if !seen_sources.insert(normalize_image_path_key(&path_str)) {
            continue;
        }
        let path = Path::new(&path_str);

        if !path.exists() {
            result.failed.push(LibraryImportIssue {
                path: path_str.clone(),
                reason: "文件不存在".to_string(),
            });
            continue;
        }
        if path.is_dir() {
            result.failed.push(LibraryImportIssue {
                path: path_str.clone(),
                reason: "不支持文件夹".to_string(),
            });
            continue;
        }
        if !is_supported_image(path) {
            result.failed.push(LibraryImportIssue {
                path: path_str.clone(),
                reason: "不支持该文件格式".to_string(),
            });
            continue;
        }
        // 已在管理目录内：不复制（绝不产生 girl (1).png 副本），
        // 交由 sync_images 刷新 / 补建索引。
        if path_under_managed_dir(&path_str, &settings.library_input_dir)
            || path_under_managed_dir(&path_str, &settings.default_output_dir)
        {
            result.skipped.push(LibraryImportIssue {
                path: path_str.clone(),
                reason: "已在图片库目录中".to_string(),
            });
            continue;
        }

        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("image")
            .to_string();
        let direct_dest = input_dir.join(&file_name);
        // 同名且同内容（md5 一致）= 同一张图再次拖入：跳过，不造副本
        if direct_dest.exists() {
            let same_content = match (file_md5(path), file_md5(&direct_dest)) {
                (Some(a), Some(b)) => a == b,
                _ => false,
            };
            if same_content {
                result.skipped.push(LibraryImportIssue {
                    path: path_str.clone(),
                    reason: "已在图片库中".to_string(),
                });
                continue;
            }
        }

        let dest = next_available_dest(input_dir, &file_name);
        match fs::copy(path, &dest) {
            Ok(_) => {
                // 记录时间 = 导入时间（fs::copy 在 Windows 保留源 mtime，
                // 这里显式刷新，让新导入在「最新优先」排序下出现在最前）
                if let Ok(file) = fs::File::options().write(true).open(&dest) {
                    let _ = file.set_modified(std::time::SystemTime::now());
                }
                result.imported.push(ImportedLibraryImage {
                    file_name: dest
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(&file_name)
                        .to_string(),
                    local_path: dest.to_string_lossy().replace('\\', "/"),
                });
            }
            Err(e) => {
                result.failed.push(LibraryImportIssue {
                    path: path_str.clone(),
                    reason: format!("复制失败: {}", e),
                });
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn import_images_to_library(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<ImportImagesToLibraryResult, String> {
    let settings: Settings = storage::read_json(&storage::settings_path(&app), Settings::default());
    let mut result = import_images_to_library_core(&settings, &paths)?;
    // 有新复制 / 有管理目录内文件需要刷新索引时才重扫；
    // 索引建立完全复用 sync_images（与手动放入目录同一链路）。
    if !result.imported.is_empty() || !result.skipped.is_empty() {
        result.images = sync_images(&app);
    }
    Ok(result)
}

#[tauri::command]
pub fn get_image_meta(path: String) -> Result<ImageMeta, String> {
    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err("文件已移动或不存在".to_string());
    }
    let bytes = fs::read(file_path).map_err(|e| format!("无法读取图片: {}", e))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("无法解码图片: {}", e))?;
    Ok(ImageMeta {
        width: img.width(),
        height: img.height(),
        file_size: bytes.len() as u64,
    })
}

#[tauri::command]
pub fn update_image_index(
    app: tauri::AppHandle,
    image_id: String,
    width: Option<u32>,
    height: Option<u32>,
    description: Option<String>,
    tags: Vec<String>,
) -> Result<ImageRecord, String> {
    let updated = storage::with_images(&app, |images| {
        images.iter_mut().find(|img| img.id == image_id).map(|img| {
            img.width = width.or(img.width);
            img.height = height.or(img.height);
            img.missing = !Path::new(&img.local_path).exists();
            if !img.missing {
                img.last_seen_at = Some(chrono::Local::now().to_rfc3339());
            }
            if let Some(desc) = description {
                if !desc.trim().is_empty() {
                    img.description = Some(desc);
                }
            }
            if !tags.is_empty() {
                img.tags = tags;
            }
            img.indexed_at = Some(chrono::Local::now().to_rfc3339());
            img.clone()
        })
    });
    updated.ok_or_else(|| "未找到图片记录".to_string())
}

#[tauri::command]
pub fn delete_image(app: tauri::AppHandle, image_id: String) -> Result<(), String> {
    storage::with_images(&app, |images| {
        if let Some(img) = images.iter().find(|i| i.id == image_id) {
            if Path::new(&img.local_path).exists() {
                let _ = fs::remove_file(&img.local_path);
            }
        }
        images.retain(|i| i.id != image_id);
    });
    Ok(())
}

#[tauri::command]
pub fn delete_task(
    app: tauri::AppHandle,
    task_id: String,
    delete_images: bool,
) -> Result<(), String> {
    // Collect image IDs from sub-tasks before removing the task
    let image_ids: Vec<String> = {
        let tasks: Vec<Task> = storage::read_json(&storage::tasks_path(&app), Vec::new());
        tasks
            .iter()
            .find(|t| t.id == task_id)
            .map(|t| {
                t.sub_tasks
                    .iter()
                    .filter_map(|s| s.image_id.clone())
                    .collect()
            })
            .unwrap_or_default()
    };

    // Remove task
    storage::with_tasks(&app, |tasks| {
        tasks.retain(|t| t.id != task_id);
    });

    // Optionally delete associated images
    if delete_images && !image_ids.is_empty() {
        let images_path = storage::images_path(&app);
        let mut images: Vec<ImageRecord> = storage::read_json(&images_path, Vec::new());
        for id in &image_ids {
            if let Some(img) = images.iter().find(|i| &i.id == id) {
                if Path::new(&img.local_path).exists() {
                    let _ = fs::remove_file(&img.local_path);
                }
            }
        }
        images.retain(|i| !image_ids.contains(&i.id));
        storage::write_json(&images_path, &images);
    }

    Ok(())
}

// ========== File Operations ==========

#[tauri::command]
pub fn read_image_data(path: String) -> Result<String, String> {
    if !Path::new(&path).exists() {
        return Err("文件已移动或不存在".to_string());
    }
    let data = fs::read(&path).map_err(|e| format!("无法读取图片: {}", e))?;
    let ext = Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    let mime = match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    };
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, data);
    Ok(format!("data:{};base64,{}", mime, b64))
}

#[tauri::command]
pub async fn open_file(path: String) -> Result<(), String> {
    opener::open(&path).map_err(|e| format!("无法打开文件: {}", e))
}

#[tauri::command]
pub async fn open_folder(path: String) -> Result<(), String> {
    let parent = Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(path);
    opener::open(&parent).map_err(|e| format!("无法打开目录: {}", e))
}

/// 图库图片 -> CY Video Studio 素材库（经 CY_VIDEO_BRIDGE_V1，见 video_bridge.rs）
#[tauri::command]
pub async fn sync_image_to_video(
    params: crate::video_bridge::VideoSyncParams,
) -> Result<crate::video_bridge::VideoSyncResult, String> {
    crate::video_bridge::sync_image(params).await
}

/// CY Video Studio Bridge 是否在线（前端启动后轮询用，短超时）
#[tauri::command]
pub async fn video_bridge_online() -> bool {
    crate::video_bridge::bridge_online().await
}

/// 自动启动 CY Video Studio：进程已在（启动中）不重复拉起；找不到安装位置返回 CY_VIDEO_NOT_FOUND: 前缀错误
#[tauri::command]
pub fn launch_video_studio(app: tauri::AppHandle) -> Result<crate::video_bridge::VideoLaunchOutcome, String> {
    let saved = storage::read_json(&storage::settings_path(&app), crate::models::Settings::default());
    crate::video_bridge::launch_video_studio(&saved.video_studio_executable)
}

/// 手动选择 CY Video Studio.exe：校验后保存到应用设置（video_studio_executable）
#[tauri::command]
pub async fn pick_video_studio_executable(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let file = app
        .dialog()
        .file()
        .add_filter("可执行文件", &["exe"])
        .blocking_pick_file();
    let Some(picked) = file else {
        return Err("已取消选择".to_string());
    };
    let path = crate::video_bridge::validate_saved_executable(&picked.to_string())?;
    let display = path.display().to_string();
    let settings_path = storage::settings_path(&app);
    let mut settings: crate::models::Settings =
        storage::read_json(&settings_path, crate::models::Settings::default());
    settings.video_studio_executable = display.clone();
    storage::write_json(&settings_path, &settings);
    Ok(display)
}

/// 打开外部浏览器链接。仅允许 https，拒绝任意字符串进入系统 shell。
#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !trimmed.starts_with("https://") || trimmed.contains(|c: char| c.is_control()) {
        return Err("仅允许打开 https 链接".to_string());
    }
    opener::open(trimmed).map_err(|e| format!("无法打开链接: {}", e))
}

#[tauri::command]
pub async fn select_directory(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let dir = app.dialog().file().blocking_pick_folder();
    dir.map(|p| p.to_string())
}

#[tauri::command]
pub async fn select_image_file(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let file = app
        .dialog()
        .file()
        .add_filter("Image", &["png", "jpg", "jpeg", "webp"])
        .blocking_pick_file();
    file.map(|p| p.to_string())
}

// ========== Text File Selection ==========

#[derive(serde::Serialize)]
pub struct TextFileResult {
    pub name: String,
    pub content: String,
    pub size: usize,
}

#[tauri::command]
pub async fn select_text_file(app: tauri::AppHandle) -> Option<TextFileResult> {
    use tauri_plugin_dialog::DialogExt;
    let file = app
        .dialog()
        .file()
        .add_filter(
            "Text Files",
            &[
                "txt", "md", "json", "csv", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf",
                "log", "py", "js", "ts", "tsx", "jsx", "html", "css", "scss", "less", "java", "c",
                "cpp", "h", "hpp", "cs", "go", "rs", "rb", "php", "sh", "bat", "ps1", "sql",
                "graphql", "vue", "svelte",
            ],
        )
        .set_title("选择文本文件")
        .blocking_pick_file();
    match file {
        Some(path) => {
            let path_str = path.to_string();
            let p = Path::new(&path_str);
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file")
                .to_string();
            match fs::read_to_string(p) {
                Ok(content) => {
                    let size = content.len();
                    // Limit to 2MB
                    if size > 2 * 1024 * 1024 {
                        None
                    } else {
                        Some(TextFileResult {
                            name,
                            content,
                            size,
                        })
                    }
                }
                Err(_) => None,
            }
        }
        None => None,
    }
}

// ========== Save Image As ==========

#[tauri::command]
pub async fn save_image_as(
    app: tauri::AppHandle,
    b64_data: String,
    default_name: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .add_filter("Image", &["png", "jpg", "webp"])
        .set_file_name(&default_name)
        .blocking_save_file();
    if let Some(path) = path {
        let b64_clean = b64_data.split(',').last().unwrap_or(&b64_data);
        let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64_clean)
            .map_err(|e| format!("解码失败: {}", e))?;
        fs::write(path.to_string(), &bytes).map_err(|e| format!("保存失败: {}", e))?;
        Ok(true)
    } else {
        Ok(false)
    }
}

// ========== Comic Final Page（V4.2.11 §F 组合漫画页面落库） ==========

/// 将本地合成的漫画整页 PNG 写入图片库导入目录（无对话框，自动组合链路专用）。
/// 返回库内路径；索引由调用方随后经 import_images_to_library / rescan 建立。
#[tauri::command]
pub fn save_comic_page_to_library(
    app: tauri::AppHandle,
    b64_data: String,
    file_name: String,
) -> Result<String, String> {
    let settings: Settings = storage::read_json(&storage::settings_path(&app), Settings::default());
    let input_dir_raw = settings.library_input_dir.trim();
    if input_dir_raw.is_empty() {
        return Err("请先在「设置与更新 → 图片与文件」中配置本地导入目录".to_string());
    }
    let input_dir = Path::new(input_dir_raw);
    fs::create_dir_all(input_dir).map_err(|e| format!("无法访问本地导入目录: {}", e))?;

    // 文件名清洗：剥掉路径成分与 Windows 非法字符，强制 .png 后缀
    let cleaned: String = file_name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    let base = if trimmed.is_empty() { "comic-page".to_string() } else { trimmed };
    let png_name = if base.to_lowercase().ends_with(".png") { base } else { format!("{}.png", base) };

    let b64_clean = b64_data.split(',').last().unwrap_or(&b64_data);
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64_clean)
        .map_err(|e| format!("解码失败: {}", e))?;
    if bytes.is_empty() {
        return Err("合成页数据为空".to_string());
    }
    let dest = next_available_dest(input_dir, &png_name);
    fs::write(&dest, &bytes).map_err(|e| format!("写入失败: {}", e))?;
    // 记录时间 = 组合时间（最新优先排序下整页出现在最前）
    if let Ok(file) = fs::File::options().write(true).open(&dest) {
        let _ = file.set_modified(std::time::SystemTime::now());
    }
    Ok(dest.to_string_lossy().replace('\\', "/"))
}

// ========== Conversations ==========

#[tauri::command]
pub fn get_conversations(app: tauri::AppHandle) -> Vec<ChatConversation> {
    let path = storage::conversations_path(&app);
    storage::read_json(&path, Vec::new())
}

#[tauri::command]
pub fn save_conversations(
    app: tauri::AppHandle,
    conversations: Vec<ChatConversation>,
) -> Result<(), String> {
    let path = storage::conversations_path(&app);
    storage::write_json(&path, &conversations);
    Ok(())
}

#[tauri::command]
pub fn save_conversation(
    app: tauri::AppHandle,
    conversation: ChatConversation,
) -> Result<(), String> {
    let path = storage::conversations_path(&app);
    let mut conversations: Vec<ChatConversation> = storage::read_json(&path, Vec::new());

    if let Some(existing) = conversations
        .iter_mut()
        .find(|item| item.id == conversation.id)
    {
        *existing = conversation;
    } else {
        conversations.insert(0, conversation);
    }

    storage::write_json(&path, &conversations);
    Ok(())
}

// ========== Chat Image Save ==========

#[tauri::command]
pub fn save_chat_image(
    app: tauri::AppHandle,
    b64_data: String,
    conversation_id: String,
) -> Result<ImageRecord, String> {
    let settings: Settings = storage::read_json(&storage::settings_path(&app), Settings::default());
    let output_dir = if settings.default_output_dir.is_empty() {
        dirs::desktop_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .to_string_lossy()
            .to_string()
    } else {
        settings.default_output_dir.clone()
    };

    let chat_dir = Path::new(&output_dir).join("chat");
    fs::create_dir_all(&chat_dir).ok();

    let b64_clean = b64_data.split(',').last().unwrap_or(&b64_data);
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64_clean)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    let now = chrono::Local::now();
    let id_short = if conversation_id.len() >= 8 {
        &conversation_id[..8]
    } else {
        &conversation_id
    };
    let filename = format!("chat_{}_{}.png", now.format("%Y%m%d_%H%M%S"), id_short);
    let filepath = chat_dir.join(&filename);

    fs::write(&filepath, &bytes).map_err(|e| format!("保存图片失败: {}", e))?;

    let record = ImageRecord {
        id: uuid::Uuid::new_v4().to_string(),
        task_id: conversation_id,
        local_path: filepath.to_string_lossy().replace('\\', "/"),
        file_name: filename,
        created_at: now.to_rfc3339(),
        status: "saved".to_string(),
        source_kind: "chat".to_string(),
        missing: false,
        last_seen_at: Some(now.to_rfc3339()),
        width: None,
        height: None,
        file_size: Some(bytes.len() as u64),
        description: None,
        tags: Vec::new(),
        indexed_at: None,
    };

    storage::with_images(&app, |images| {
        images.push(record.clone());
    });

    Ok(record)
}

#[tauri::command]
pub async fn remove_background(
    app: tauri::AppHandle,
    image_path: String,
) -> Result<ImageRecord, String> {
    let settings: Settings = storage::read_json(&storage::settings_path(&app), Settings::default());
    if settings.removebg_api_key.trim().is_empty() {
        return Err("请先在设置中配置 remove.bg API Key".to_string());
    }

    let path = Path::new(&image_path);
    if !path.exists() {
        return Err(format!("源图片不存在: {}", image_path));
    }

    let bytes = fs::read(path).map_err(|e| format!("读取源图片失败: {}", e))?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image.png")
        .to_string();
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(crate::task_runner::mime_for_path(path))
        .map_err(|e| format!("构建上传文件失败: {}", e))?;
    let form = reqwest::multipart::Form::new()
        .part("image_file", part)
        .text("size", "auto");

    let resp = HTTP_CLIENT
        .post("https://api.remove.bg/v1.0/removebg")
        .header("X-Api-Key", settings.removebg_api_key.trim())
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("remove.bg 请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("remove.bg 错误 {}: {}", status, text));
    }

    let output_dir = if settings.default_output_dir.is_empty() {
        dirs::desktop_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .to_string_lossy()
            .to_string()
    } else {
        settings.default_output_dir.clone()
    };
    let transparent_dir = Path::new(&output_dir).join("transparent");
    fs::create_dir_all(&transparent_dir).map_err(|e| format!("创建透明图目录失败: {}", e))?;

    let now = chrono::Local::now();
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let filename = format!("{}_transparent_{}.png", stem, now.format("%Y%m%d_%H%M%S"));
    let filepath = transparent_dir.join(&filename);
    let image_bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取 remove.bg 响应失败: {}", e))?;
    fs::write(&filepath, &image_bytes).map_err(|e| format!("保存透明图失败: {}", e))?;

    let record = ImageRecord {
        id: uuid::Uuid::new_v4().to_string(),
        task_id: "agent_postprocess".to_string(),
        local_path: filepath.to_string_lossy().replace('\\', "/"),
        file_name: filename,
        created_at: now.to_rfc3339(),
        status: "transparent".to_string(),
        source_kind: "postprocess".to_string(),
        missing: false,
        last_seen_at: Some(now.to_rfc3339()),
        width: None,
        height: None,
        file_size: Some(image_bytes.len() as u64),
        description: None,
        tags: Vec::new(),
        indexed_at: None,
    };

    storage::with_images(&app, |images| {
        images.push(record.clone());
    });

    Ok(record)
}

// ========== Chat Image Generation via Rust (SSE streaming) ==========

/// Extract base64 image data from a SSE event JSON value (recursive search)
pub fn find_image_b64(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            for (key, val) in map {
                if key == "result" || key == "b64_json" || key == "image_data" {
                    if let Some(s) = val.as_str() {
                        if s.len() > 100 {
                            return Some(s.to_string());
                        }
                    }
                }
                if let Some(found) = find_image_b64(val) {
                    return Some(found);
                }
            }
            None
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                if let Some(found) = find_image_b64(item) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

/// Parse SSE stream from Responses API and extract generated image base64
async fn parse_sse_for_image(resp: reqwest::Response) -> Result<String, String> {
    use futures_util::StreamExt;

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut image_b64 = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取流失败: {}", e))?;
        buffer += &String::from_utf8_lossy(&chunk);

        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer = buffer[pos + 1..].to_string();

            if !line.starts_with("data: ") {
                continue;
            }
            let payload = line[6..].trim();
            if payload == "[DONE]" {
                continue;
            }

            let evt: serde_json::Value = match serde_json::from_str(payload) {
                Ok(v) => v,
                Err(_) => continue,
            };

            if let Some(b64) = find_image_b64(&evt) {
                image_b64 = b64;
            }
        }
    }

    if !image_b64.is_empty() {
        Ok(image_b64)
    } else {
        Err("API 未返回图片数据（流式响应中未找到图片）".to_string())
    }
}

#[tauri::command]
pub async fn chat_generate_image(
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeAuthState>,
    prompt: String,
    model: String,
) -> Result<String, String> {
    let settings: Settings = storage::read_json(&storage::settings_path(&app), Settings::default());

    // Prefer runtime memory token, fallback to settings.token
    let runtime_config = match state.config.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => RuntimeAuthConfig::default(),
    };
    let token = if !runtime_config.image_token.trim().is_empty() {
        runtime_config.image_token.trim().to_string()
    } else {
        settings.token.trim().to_string()
    };
    if token.is_empty() {
        return Err("请先在设置页面配置图片生成 API Token".to_string());
    }

    let base_url = if !runtime_config.image_base_url.trim().is_empty() {
        runtime_config
            .image_base_url
            .trim()
            .trim_end_matches('/')
            .to_string()
    } else {
        "https://www.packyapi.com".to_string()
    };

    let client = &*HTTP_CLIENT;

    let body = serde_json::json!({
        "model": model,
        "stream": true,
        "input": [
            {
                "role": "user",
                "content": [
                    { "type": "input_text", "text": prompt }
                ]
            }
        ],
        "tools": [{ "type": "image_generation" }]
    });

    let url = format!("{}/v1/responses", base_url);

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("图片生成失败: {}", text));
    }

    parse_sse_for_image(resp).await
}

#[tauri::command]
pub async fn chat_edit_image(
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeAuthState>,
    image_path: String,
    prompt: String,
    model: String,
) -> Result<String, String> {
    let settings: Settings = storage::read_json(&storage::settings_path(&app), Settings::default());

    // Prefer runtime memory token, fallback to settings.token
    let runtime_config = match state.config.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => RuntimeAuthConfig::default(),
    };
    let token = if !runtime_config.image_token.trim().is_empty() {
        runtime_config.image_token.trim().to_string()
    } else {
        settings.token.trim().to_string()
    };
    if token.is_empty() {
        return Err("请先在设置页面配置图片生成 API Token".to_string());
    }

    let base_url = if !runtime_config.image_base_url.trim().is_empty() {
        runtime_config
            .image_base_url
            .trim()
            .trim_end_matches('/')
            .to_string()
    } else {
        "https://www.packyapi.com".to_string()
    };

    let path = Path::new(&image_path);
    if !path.exists() {
        return Err(format!("源图片不存在: {}", image_path));
    }

    let file_bytes = fs::read(path).map_err(|e| format!("无法读取源图片: {}", e))?;
    let mime = crate::task_runner::mime_for_path(path);
    let b64_encoded =
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &file_bytes);
    let data_url = format!("data:{};base64,{}", mime, b64_encoded);

    let client = &*HTTP_CLIENT;

    let body = serde_json::json!({
        "model": model,
        "stream": true,
        "input": [
            {
                "role": "user",
                "content": [
                    { "type": "input_text", "text": prompt },
                    { "type": "input_image", "image_url": data_url }
                ]
            }
        ],
        "tools": [{ "type": "image_generation" }]
    });

    let url = format!("{}/v1/responses", base_url);

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("图片编辑失败: {}", text));
    }

    parse_sse_for_image(resp).await
}

// ========== Releases ==========

#[derive(serde::Serialize)]
pub struct ReleaseNote {
    pub version: String,
    pub date: String,
    pub notes: String,
}

#[tauri::command]
pub async fn fetch_releases() -> Result<Vec<ReleaseNote>, String> {
    let resp = HTTP_CLIENT
        .get("https://api.github.com/repos/Gicce/GPT_Image_2_Application/releases?per_page=3")
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "CyImagePro")
        .send()
        .await
        .map_err(|e| format!("璇锋眰澶辫触: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API 閿欒: {}", resp.status()));
    }

    let data: Vec<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| format!("瑙ｆ瀽澶辫触: {}", e))?;

    let releases = data
        .into_iter()
        .take(3)
        .map(|r| {
            let tag = r["tag_name"].as_str().unwrap_or("").to_string();
            let version = tag
                .trim_start_matches("app-v")
                .trim_start_matches('v')
                .to_string();
            let date: String = r["published_at"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(10)
                .collect();
            let notes = r["body"].as_str().unwrap_or("").to_string();
            ReleaseNote {
                version,
                date,
                notes,
            }
        })
        .collect();

    Ok(releases)
}

// ========== Runtime Auth (in-memory only) ==========

#[derive(serde::Serialize)]
pub struct RuntimeAuthStatus {
    pub has_image_token: bool,
    pub has_agent_token: bool,
    pub has_postprocess_token: bool,
    pub image_base_url: String,
    pub agent_base_url: String,
    pub postprocess_base_url: String,
}

#[tauri::command]
pub fn set_runtime_auth_config(
    state: tauri::State<'_, RuntimeAuthState>,
    config: RuntimeAuthConfig,
) -> Result<(), String> {
    let mut guard = state
        .config
        .lock()
        .map_err(|e| format!("锁获取失败: {}", e))?;
    *guard = config;
    Ok(())
}

#[tauri::command]
pub fn clear_runtime_auth_config(state: tauri::State<'_, RuntimeAuthState>) -> Result<(), String> {
    let mut guard = state
        .config
        .lock()
        .map_err(|e| format!("锁获取失败: {}", e))?;
    *guard = RuntimeAuthConfig::default();
    Ok(())
}

#[tauri::command]
pub fn get_runtime_auth_status(
    state: tauri::State<'_, RuntimeAuthState>,
) -> Result<RuntimeAuthStatus, String> {
    let guard = state
        .config
        .lock()
        .map_err(|e| format!("锁获取失败: {}", e))?;
    Ok(RuntimeAuthStatus {
        has_image_token: !guard.image_token.is_empty(),
        has_agent_token: !guard.agent_token.is_empty(),
        has_postprocess_token: !guard.postprocess_token.is_empty(),
        image_base_url: guard.image_base_url.clone(),
        agent_base_url: guard.agent_base_url.clone(),
        postprocess_base_url: guard.postprocess_base_url.clone(),
    })
}

// ========== Environment self-check ==========

#[derive(Debug, Serialize, Clone)]
pub struct EnvCheckItem {
    pub key: String,
    pub title: String,
    pub status: String,  // "ok" | "warn" | "error" | "pending"
    pub summary: String, // short headline shown next to the title
    pub detail: String,  // multi-line detail (no secrets)
    pub latency_ms: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct EnvCheckResult {
    pub items: Vec<EnvCheckItem>,
    pub diagnostic_text: String,
}

fn ok_item<S1: Into<String>, S2: Into<String>, S3: Into<String>, S4: Into<String>>(
    key: S1,
    title: S2,
    summary: S3,
    detail: S4,
    latency_ms: Option<u64>,
) -> EnvCheckItem {
    EnvCheckItem {
        key: key.into(),
        title: title.into(),
        status: "ok".to_string(),
        summary: summary.into(),
        detail: detail.into(),
        latency_ms,
    }
}

fn warn_item<S1: Into<String>, S2: Into<String>, S3: Into<String>, S4: Into<String>>(
    key: S1,
    title: S2,
    summary: S3,
    detail: S4,
) -> EnvCheckItem {
    EnvCheckItem {
        key: key.into(),
        title: title.into(),
        status: "warn".to_string(),
        summary: summary.into(),
        detail: detail.into(),
        latency_ms: None,
    }
}

fn error_item<S1: Into<String>, S2: Into<String>, S3: Into<String>, S4: Into<String>>(
    key: S1,
    title: S2,
    summary: S3,
    detail: S4,
) -> EnvCheckItem {
    EnvCheckItem {
        key: key.into(),
        title: title.into(),
        status: "error".to_string(),
        summary: summary.into(),
        detail: detail.into(),
        latency_ms: None,
    }
}

#[allow(dead_code)]
fn pending_item<S1: Into<String>, S2: Into<String>>(key: S1, title: S2) -> EnvCheckItem {
    EnvCheckItem {
        key: key.into(),
        title: title.into(),
        status: "pending".to_string(),
        summary: "检查中...".to_string(),
        detail: String::new(),
        latency_ms: None,
    }
}

fn mask_token(token: &str) -> String {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.len() <= 12 {
        return "••••".to_string();
    }
    format!("{}...{}", &trimmed[..6], &trimmed[trimmed.len() - 4..])
}

/// Lightweight environment self-check. Does NOT trigger real image generation costs.
/// For the Image group we only verify token presence and endpoint reachability with a HEAD/GET
/// against the upstream root (which returns 401/404 for unauthenticated requests but proves
/// the TCP/TLS path works through the proxy).
#[tauri::command]
pub async fn check_environment(app: tauri::AppHandle) -> Result<EnvCheckResult, String> {
    use std::time::Instant;

    let mut items: Vec<EnvCheckItem> = Vec::new();

    // 1) Settings + runtime config snapshot
    let settings_path = storage::settings_path(&app);
    let settings: Settings = storage::read_json(&settings_path, Default::default());
    let runtime_config = match app.try_state::<RuntimeAuthState>() {
        Some(state) => state.config.lock().map(|g| g.clone()).unwrap_or_default(),
        None => RuntimeAuthConfig::default(),
    };

    // 2) Account server reachability (server_url) — uses HTTP_CLIENT (proxy-aware)
    let server_url = if settings.server_url.trim().is_empty() {
        "http://localhost:4001".to_string()
    } else {
        settings.server_url.trim().trim_end_matches('/').to_string()
    };
    let health_url = format!("{}/api/health", server_url);
    let t0 = Instant::now();
    let server_check = HTTP_CLIENT.get(&health_url).send().await;
    let server_latency = t0.elapsed().as_millis() as u64;
    let server_item = match server_check {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if resp.status().is_success() {
                ok_item(
                    "account_server",
                    "账户服务器",
                    &format!("HTTP {} ({} ms)", status, server_latency),
                    &format!("URL: {}\n检测接口：/api/health", server_url),
                    Some(server_latency),
                )
            } else {
                warn_item(
                    "account_server",
                    "账户服务器",
                    &format!("HTTP {}", status),
                    &format!(
                        "URL: {}\n账户服务器返回非 200，但 TCP/TLS 通路正常。",
                        server_url
                    ),
                )
            }
        }
        Err(err) => {
            let kind = classify_reqwest_error(&err);
            error_item(
                "account_server",
                "账户服务器",
                &format!("{} 失败", kind),
                &format!(
                    "URL: {}\n错误：{}\n建议：确认服务器进程已启动，端口未占用。",
                    server_url, err
                ),
            )
        }
    };
    items.push(server_item);

    // 3) Runtime config presence (image / agent / postprocess tokens from server)
    let has_image_rt = !runtime_config.image_token.is_empty();
    let has_agent_rt = !runtime_config.agent_token.is_empty();
    let has_postprocess_rt = !runtime_config.postprocess_token.is_empty();
    let rt_summary = format!(
        "image:{} / agent:{} / postprocess:{}",
        if has_image_rt {
            "已获取"
        } else {
            "未获取"
        },
        if has_agent_rt {
            "已获取"
        } else {
            "未获取"
        },
        if has_postprocess_rt {
            "已获取"
        } else {
            "未获取"
        },
    );
    let rt_detail = format!(
        "服务器下发的 runtime-config 状态。\nimage_base_url: {}\nagent_base_url: {}\npostprocess_base_url: {}",
        if runtime_config.image_base_url.is_empty() { "(空)" } else { &runtime_config.image_base_url },
        if runtime_config.agent_base_url.is_empty() { "(空)" } else { &runtime_config.agent_base_url },
        if runtime_config.postprocess_base_url.is_empty() { "(空)" } else { &runtime_config.postprocess_base_url },
    );
    items.push(EnvCheckItem {
        key: "runtime_config".to_string(),
        title: "Runtime Config".to_string(),
        status: if has_image_rt || has_agent_rt || has_postprocess_rt {
            "ok".to_string()
        } else {
            "warn".to_string()
        },
        summary: rt_summary,
        detail: rt_detail,
        latency_ms: None,
    });

    // 4) Windows system proxy
    let proxy_url = read_windows_system_proxy();
    let proxy_item = match &proxy_url {
        Some(url) => {
            // Probe the proxy port with a trivial TCP connect
            let host_port = url
                .trim_start_matches("http://")
                .trim_start_matches("https://")
                .trim_end_matches('/');
            let connect_result = std::net::TcpStream::connect_timeout(
                &std::net::SocketAddr::from(
                    host_port.parse::<std::net::SocketAddr>().unwrap_or_else(|_| {
                        // fallback: assume 127.0.0.1:port if parsing fails (rare)
                        "127.0.0.1:0".parse().unwrap()
                    }),
                ),
                std::time::Duration::from_secs(3),
            );
            match connect_result {
                Ok(_) => ok_item(
                    "windows_proxy",
                    "Windows 系统代理",
                    &format!("{} (TCP 可达)", url),
                    &format!("注册表 ProxyServer：{}", url),
                    None,
                ),
                Err(e) => error_item(
                    "windows_proxy",
                    "Windows 系统代理",
                    &format!("{} (TCP 失败)", url),
                    &format!("无法连接到代理端口：{}\n请确认代理客户端（Clash / V2Ray 等）正在运行。", e),
                ),
            }
        }
        None => warn_item(
            "windows_proxy",
            "Windows 系统代理",
            "未启用".to_string(),
            "Windows 注册表未配置系统代理。\n如果您的网络不能直连 packyapi.com，请先在代理客户端中开启系统代理。".to_string(),
        ),
    };
    items.push(proxy_item);

    // 5) Agent API — use agent_token + agent_base_url from runtime first, then settings
    let agent_token = if !runtime_config.agent_token.is_empty() {
        runtime_config.agent_token.clone()
    } else {
        settings.agent_token.clone()
    };
    let agent_base_url = if !runtime_config.agent_base_url.is_empty() {
        runtime_config.agent_base_url.clone()
    } else {
        settings.agent_base_url.clone()
    };
    let agent_model = if settings.agent_model.is_empty() {
        "gpt-4o".to_string()
    } else {
        settings.agent_model.clone()
    };
    let agent_url = format!(
        "{}/chat/completions",
        normalize_agent_base_url(&agent_base_url)
    );
    if agent_token.trim().is_empty() {
        items.push(error_item(
            "agent_api",
            "Agent 服务",
            "Token 未配置".to_string(),
            "当前账户未下发 Agent 分组 Token，且本地 agent_token 也为空。请前往账户中心购买/激活 Agent 分组。".to_string(),
        ));
    } else {
        let t1 = Instant::now();
        let body = json!({
            "model": agent_model,
            "messages": [
                { "role": "system", "content": "你是接口连通性检测助手，请只回复 ok。" },
                { "role": "user", "content": "ok" }
            ],
            "max_tokens": 8
        });
        let agent_resp = HTTP_CLIENT
            .post(&agent_url)
            .header("Authorization", format!("Bearer {}", agent_token))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await;
        let agent_latency = t1.elapsed().as_millis() as u64;
        let agent_item = match agent_resp {
            Ok(r) => {
                let status = r.status().as_u16();
                if r.status().is_success() {
                    ok_item(
                        "agent_api",
                        "Agent 服务",
                        &format!("HTTP {} ({} ms)", status, agent_latency),
                        &format!(
                            "模型：{}\nEndpoint：{}\nToken：{}",
                            agent_model,
                            agent_url,
                            mask_token(&agent_token)
                        ),
                        Some(agent_latency),
                    )
                } else {
                    let text = r.text().await.unwrap_or_default();
                    let value: serde_json::Value =
                        serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
                    let (detail, _code) = extract_error_parts_from_value(&value);
                    error_item(
                        "agent_api",
                        "Agent 服务",
                        format!("HTTP {}", status),
                        format!(
                            "模型：{}\nEndpoint：{}\n错误：{}",
                            agent_model,
                            agent_url,
                            detail.unwrap_or_default()
                        ),
                    )
                }
            }
            Err(err) => {
                let kind = classify_reqwest_error(&err);
                error_item(
                    "agent_api",
                    "Agent 服务",
                    &format!("{} 失败", kind),
                    &format!("Endpoint：{}\n错误：{}", agent_url, err),
                )
            }
        };
        items.push(agent_item);
    }

    // 6) Image API — lightweight endpoint reachability
    let image_token = if !runtime_config.image_token.is_empty() {
        runtime_config.image_token.clone()
    } else {
        settings.token.clone()
    };
    let image_base_url = if !runtime_config.image_base_url.is_empty() {
        runtime_config
            .image_base_url
            .trim_end_matches('/')
            .to_string()
    } else {
        "https://www.packyapi.com".to_string()
    };
    let image_probe_url = format!("{}/v1/models", image_base_url);
    if image_token.trim().is_empty() {
        items.push(error_item(
            "image_api",
            "图片生成",
            "Token 未配置".to_string(),
            "当前账户未下发 Image 分组 Token，且本地 token 也为空。请前往账户中心购买/激活 Image/Sora 分组。".to_string(),
        ));
    } else {
        let t2 = Instant::now();
        let image_resp = HTTP_CLIENT
            .get(&image_probe_url)
            .header("Authorization", format!("Bearer {}", image_token))
            .send()
            .await;
        let image_latency = t2.elapsed().as_millis() as u64;
        let image_item = match image_resp {
            Ok(r) => {
                let status = r.status().as_u16();
                // 200 means token+endpoint both work. 401/403 means token issue. 404 means endpoint mismatch.
                if status == 200 || (status >= 200 && status < 300) {
                    ok_item(
                        "image_api",
                        "图片生成",
                        &format!("HTTP {} ({} ms)", status, image_latency),
                        &format!(
                            "模型：gpt-image-2\nBase URL：{}\nEndpoint：{}/v1/images/generations\nToken：{}\n注意：这只是连通性自检，未真实生成图片。",
                            image_base_url, image_base_url, mask_token(&image_token)
                        ),
                        Some(image_latency),
                    )
                } else if status == 401 || status == 403 {
                    error_item(
                        "image_api",
                        "图片生成",
                        &format!("HTTP {}", status),
                        &format!(
                            "Base URL：{}\nToken 可能无效或不属于 Image/Sora 分组。\nToken：{}",
                            image_base_url,
                            mask_token(&image_token)
                        ),
                    )
                } else if status == 404 {
                    warn_item(
                        "image_api",
                        "图片生成",
                        &format!("HTTP {}", status),
                        &format!(
                            "Base URL：{}\n/v1/models 返回 404，但实际生成 endpoint 可能仍然有效。",
                            image_base_url
                        ),
                    )
                } else {
                    warn_item(
                        "image_api",
                        "图片生成",
                        &format!("HTTP {}", status),
                        &format!(
                            "Base URL：{}\n未知状态，建议继续做真实生成测试。",
                            image_base_url
                        ),
                    )
                }
            }
            Err(err) => {
                let kind = classify_reqwest_error(&err);
                error_item(
                    "image_api",
                    "图片生成",
                    &format!("{} 失败", kind),
                    &format!(
                        "Endpoint：{}\n错误：{}\n建议：检查 Windows 系统代理是否启用、代理客户端是否运行。",
                        image_probe_url, err
                    ),
                )
            }
        };
        items.push(image_item);
    }

    // 7) Vision API — config + token presence (no actual image upload)
    let vision_token = settings.token.clone();
    let vision_model = if settings.vision_model.is_empty() {
        "gpt-4o".to_string()
    } else {
        settings.vision_model.clone()
    };
    if vision_token.trim().is_empty() {
        items.push(warn_item(
            "vision_api",
            "图片理解",
            "未配置".to_string(),
            "本地图片 Token（settings.token）为空。请在账户中心获取 Image/Sora 分组 Token 后由服务器下发，或在高级设置中手工填写。".to_string(),
        ));
    } else {
        items.push(ok_item(
            "vision_api",
            "图片理解",
            "已配置".to_string(),
            &format!(
                "模型：{}\nToken：{}",
                vision_model,
                mask_token(&vision_token)
            ),
            None,
        ));
    }

    // 8) Postprocess — remove.bg API key presence only
    let removebg_key = settings.removebg_api_key.trim();
    if removebg_key.is_empty() {
        items.push(warn_item(
            "postprocess",
            "后处理（remove.bg）",
            "未配置".to_string(),
            "remove.bg API Key 未配置，去背景功能将不可用。其他生成流程不受影响。".to_string(),
        ));
    } else {
        items.push(ok_item(
            "postprocess",
            "后处理（remove.bg）",
            "已配置".to_string(),
            &format!("Token：{}", mask_token(removebg_key)),
            None,
        ));
    }

    // 9) Output dir writable
    let output_dir = if settings.default_output_dir.trim().is_empty() {
        dirs::data_dir()
            .map(|p| p.join("com.gptimage.batch-generator"))
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .to_string_lossy()
            .to_string()
    } else {
        settings.default_output_dir.clone()
    };
    let output_path = std::path::Path::new(&output_dir);
    let output_check = (|| -> Result<(), String> {
        fs::create_dir_all(output_path).map_err(|e| format!("无法创建目录：{}", e))?;
        let probe = output_path.join(".cyimagepro_probe");
        fs::write(&probe, b"probe").map_err(|e| format!("无法写入：{}", e))?;
        fs::remove_file(&probe).map_err(|e| format!("无法删除探针文件：{}", e))?;
        Ok(())
    })();
    let output_item = match output_check {
        Ok(_) => ok_item(
            "output_dir",
            "图片保存目录",
            "可写".to_string(),
            &format!("路径：{}", output_dir),
            None,
        ),
        Err(msg) => error_item(
            "output_dir",
            "图片保存目录",
            "不可写".to_string(),
            &format!("路径：{}\n{}", output_dir, msg),
        ),
    };
    items.push(output_item);

    // Build diagnostic text (no secrets)
    let mut diag_lines: Vec<String> = vec!["CyImagePro v3.0.5 environment self-check".to_string()];
    for item in &items {
        let icon = match item.status.as_str() {
            "ok" => "[OK]",
            "warn" => "[WARN]",
            "error" => "[ERR]",
            _ => "[..]",
        };
        diag_lines.push(format!("{} {} - {}", icon, item.title, item.summary));
        for line in item.detail.lines().take(3) {
            if !line.is_empty() {
                diag_lines.push(format!("    {}", line));
            }
        }
    }
    let diagnostic_text = diag_lines.join("\n");

    Ok(EnvCheckResult {
        items,
        diagnostic_text,
    })
}

#[derive(Debug, Serialize)]
pub struct GenerateTestImageResult {
    pub ok: bool,
    pub endpoint: String,
    pub http_status: Option<u16>,
    pub latency_ms: u64,
    pub saved_path: Option<String>,
    pub output_format: String,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
}

/// Real image generation test. Will incur ONE real gpt-image-2 call (low quality, ~$0.04).
/// Saved to <default_output_dir>/self-test/image-api-test-<timestamp>.<ext>.
/// Does NOT touch tasks.json, does NOT report usage — this is a connectivity/cost sanity check.
#[tauri::command]
pub async fn generate_test_image(app: tauri::AppHandle) -> Result<GenerateTestImageResult, String> {
    use base64::Engine;
    use std::time::Instant;

    let settings_path = storage::settings_path(&app);
    let settings: Settings = storage::read_json(&settings_path, Default::default());
    let runtime_config = match app.try_state::<RuntimeAuthState>() {
        Some(state) => state.config.lock().map(|g| g.clone()).unwrap_or_default(),
        None => RuntimeAuthConfig::default(),
    };

    let token = if !runtime_config.image_token.is_empty() {
        runtime_config.image_token.clone()
    } else {
        settings.token.clone()
    };
    let base_url = if !runtime_config.image_base_url.is_empty() {
        runtime_config
            .image_base_url
            .trim_end_matches('/')
            .to_string()
    } else {
        "https://www.packyapi.com".to_string()
    };
    let endpoint = format!("{}/v1/images/generations", base_url);

    if token.trim().is_empty() {
        return Ok(GenerateTestImageResult {
            ok: false,
            endpoint,
            http_status: None,
            latency_ms: 0,
            saved_path: None,
            output_format: "png".to_string(),
            error_kind: Some("not_configured".to_string()),
            error_message: Some("Image Token 未配置".to_string()),
        });
    }

    // Build proxy-aware client with extended timeout for real image generation
    let client = {
        let mut builder = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .connect_timeout(std::time::Duration::from_secs(30))
            .use_native_tls();
        if let Some(proxy_url) = read_windows_system_proxy() {
            if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
                builder = builder.proxy(proxy);
            }
        }
        builder.build().unwrap_or_else(|_| reqwest::Client::new())
    };

    let body = json!({
        "model": "gpt-image-2",
        "prompt": "a simple red apple on a clean white background",
        "size": "1024x1024",
        "quality": "low",
        "output_format": "png",
        "n": 1
    });

    let t0 = Instant::now();
    let resp = client
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .await;
    let latency_ms = t0.elapsed().as_millis() as u64;

    match resp {
        Ok(response) => {
            let status = response.status();
            let status_code = status.as_u16();
            if !status.is_success() {
                let text = response.text().await.unwrap_or_default();
                let value: serde_json::Value =
                    serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
                let (detail, _code) = extract_error_parts_from_value(&value);
                return Ok(GenerateTestImageResult {
                    ok: false,
                    endpoint,
                    http_status: Some(status_code),
                    latency_ms,
                    saved_path: None,
                    output_format: "png".to_string(),
                    error_kind: Some(status_error_kind(status_code).to_string()),
                    error_message: Some(format!(
                        "HTTP {}: {}",
                        status_code,
                        detail.unwrap_or_default()
                    )),
                });
            }
            let parsed: serde_json::Value = response
                .json()
                .await
                .map_err(|e| format!("解析响应失败：{}", e))?;
            let b64 = parsed
                .get("data")
                .and_then(|v| v.get(0))
                .and_then(|v| v.get("b64_json"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| "响应缺少 data[0].b64_json".to_string())?;
            let image_bytes = Engine::decode(&base64::engine::general_purpose::STANDARD, b64)
                .map_err(|e| format!("Base64 解码失败：{}", e))?;

            let output_root = if settings.default_output_dir.trim().is_empty() {
                dirs::data_dir()
                    .map(|p| p.join("com.gptimage.batch-generator"))
                    .unwrap_or_else(|| std::path::PathBuf::from("."))
            } else {
                std::path::PathBuf::from(settings.default_output_dir.trim())
            };
            let self_test_dir = output_root.join("self-test");
            fs::create_dir_all(&self_test_dir).map_err(|e| format!("创建测试目录失败：{}", e))?;
            let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
            let filename = format!("image-api-test-{}.png", ts);
            let file_path = self_test_dir.join(&filename);
            fs::write(&file_path, &image_bytes).map_err(|e| format!("保存图片失败：{}", e))?;

            Ok(GenerateTestImageResult {
                ok: true,
                endpoint,
                http_status: Some(status_code),
                latency_ms,
                saved_path: Some(file_path.to_string_lossy().replace('\\', "/")),
                output_format: "png".to_string(),
                error_kind: None,
                error_message: None,
            })
        }
        Err(err) => {
            let kind = classify_reqwest_error(&err);
            Ok(GenerateTestImageResult {
                ok: false,
                endpoint,
                http_status: None,
                latency_ms,
                saved_path: None,
                output_format: "png".to_string(),
                error_kind: Some(kind.to_string()),
                error_message: Some(format!("{}", err)),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expect_intent(content: &str) -> String {
        let text = extract_json_object_text(content).expect("extraction should succeed");
        let value: serde_json::Value =
            serde_json::from_str(&text).expect("extracted text must parse");
        value
            .get("intent")
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string()
    }

    #[test]
    fn planner_parser_handles_pure_json() {
        let s = r#"{"intent":"CREATE_IMAGE","task_type":"generation","final_prompt":"LOL 对战场景","execution_model":"gpt-image-2","source_image_id":null}"#;
        assert_eq!(expect_intent(s), "CREATE_IMAGE");
    }

    // ===== V4.0.8 任务类型决策：重试 / 重建绝不改变图生图语义 =====

    #[test]
    fn retry_keeps_edit_task_type() {
        assert_eq!(resolve_final_task_type("edit", false, 3), "edit");
        // 参考绑定启发式只升级 generate，绝不把 edit 改回 generate
        assert_eq!(resolve_final_task_type("edit", true, 2), "edit");
    }

    #[test]
    fn retry_upgrades_reference_bound_generate_to_edit_only_with_two_sources() {
        assert_eq!(resolve_final_task_type("generate", true, 2), "edit");
        assert_eq!(resolve_final_task_type("generate", true, 1), "generate");
        assert_eq!(resolve_final_task_type("generate", false, 3), "generate");
    }

    #[test]
    fn empty_task_type_falls_back_to_generate() {
        assert_eq!(resolve_final_task_type("", false, 0), "generate");
    }

    // ===== 图库来源判定：目录嵌套不再误判生成产物为本地导入 =====

    fn settings_with_dirs(input: &str, output: &str) -> Settings {
        Settings {
            library_input_dir: input.to_string(),
            default_output_dir: output.to_string(),
            ..Settings::default()
        }
    }

    #[test]
    fn classify_source_kind_output_inside_library_parent_is_output() {
        // 本地目录是输出目录的父级：生成产物必须归 output，绝不因前缀命中变 library_input
        let settings = settings_with_dirs("D:/Images", "D:/Images/output");
        assert_eq!(
            classify_source_kind(Path::new("D:/Images/output/task1/a.png"), &settings),
            "output"
        );
        // 真正放在本地目录根下的文件仍是本地导入
        assert_eq!(
            classify_source_kind(Path::new("D:/Images/photo.png"), &settings),
            "library_input"
        );
    }

    #[test]
    fn classify_source_kind_library_inside_output_parent_is_library_input() {
        // 反向嵌套：本地目录更具体，优先于输出目录
        let settings = settings_with_dirs("D:/Images/library", "D:/Images");
        assert_eq!(
            classify_source_kind(Path::new("D:/Images/library/photo.png"), &settings),
            "library_input"
        );
        assert_eq!(
            classify_source_kind(Path::new("D:/Images/task1/a.png"), &settings),
            "output"
        );
    }

    #[test]
    fn classify_source_kind_sibling_dirs_and_chat_postprocess() {
        let settings = settings_with_dirs("D:/Library", "D:/Output");
        assert_eq!(
            classify_source_kind(Path::new("D:/Library/photo.png"), &settings),
            "library_input"
        );
        assert_eq!(
            classify_source_kind(Path::new("D:/Output/task1/a.png"), &settings),
            "output"
        );
        assert_eq!(
            classify_source_kind(Path::new("D:/Output/chat/chat_1.png"), &settings),
            "chat"
        );
        assert_eq!(
            classify_source_kind(Path::new("D:/Output/transparent/a.png"), &settings),
            "postprocess"
        );
        // 两个目录都未配置 / 命中：默认 output
        assert_eq!(
            classify_source_kind(Path::new("E:/Elsewhere/a.png"), &settings),
            "output"
        );
    }

    #[test]
    fn classify_source_kind_no_prefix_confusion_between_similar_names() {
        // 前缀必须按目录段匹配：D:/Images2 不吃掉 D:/Images 下的文件
        let settings = settings_with_dirs("D:/Images", "D:/Other");
        assert_eq!(
            classify_source_kind(Path::new("D:/Images2/photo.png"), &settings),
            "output"
        );
    }

    #[test]
    fn classify_source_kind_same_dir_for_input_and_output_is_library_input() {
        // 用户把「本地导入目录」与「输出目录」配置成同一路径：无任务关联的索引行
        // 只能来自用户导入（拖入 / 手动放入），必须归 library_input（图库显示「本地」），
        // 绝不能因平局判 output 被显示成「生成结果」。
        let shared = "D:/Image2图片";
        let settings = settings_with_dirs(shared, shared);
        assert_eq!(
            classify_source_kind(Path::new("D:/Image2图片/808c9edfc624ab.png"), &settings),
            "library_input"
        );
        // 输出目录专属子目录仍然最具体，不受平局影响
        assert_eq!(
            classify_source_kind(Path::new("D:/Image2图片/chat/chat_1.png"), &settings),
            "chat"
        );
        assert_eq!(
            classify_source_kind(Path::new("D:/Image2图片/transparent/a.png"), &settings),
            "postprocess"
        );
    }

    // ===== V4.1 图片库拖拽导入：复制 / 跳过 / 失败 / 重名 =====

    fn temp_workspace(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cyimage-import-test-{}-{}", label, uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp workspace");
        dir
    }

    fn write_png(path: &Path, payload: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, payload).expect("write png");
    }

    #[test]
    fn import_copies_external_files_into_library_dir() {
        let ws = temp_workspace("copy");
        let external = ws.join("downloads");
        write_png(&external.join("girl.png"), b"png-bytes-a");
        write_png(&external.join("cat.webp"), b"webp-bytes-b");

        let settings = settings_with_dirs(
            &ws.join("library").to_string_lossy(),
            &ws.join("output").to_string_lossy(),
        );
        let result = import_images_to_library_core(
            &settings,
            &[
                external.join("girl.png").to_string_lossy().to_string(),
                external.join("cat.webp").to_string_lossy().to_string(),
            ],
        )
        .expect("import should succeed");

        assert_eq!(result.imported.len(), 2);
        assert!(result.failed.is_empty() && result.skipped.is_empty());
        // 复制进管理目录，路径归一化为 /
        let dest_girl = ws.join("library").join("girl.png");
        assert!(dest_girl.exists());
        assert!(result
            .imported
            .iter()
            .any(|i| i.local_path == dest_girl.to_string_lossy().replace('\\', "/")));
        // 复制后的文件 classify 结果 = library_input（本地来源链路不破坏）
        assert_eq!(classify_source_kind(&dest_girl, &settings), "library_input");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn import_from_wechat_temp_dir_with_shared_dirs_resolves_library_input() {
        // GUI 实机 Bug 回归：微信 / 下载 / 桌面等外部临时目录拖入 +
        // 「本地导入目录 == 输出目录」配置下，入库后必须是 library_input（本地），
        // 绝不能被目录平局判成 output → 图库「生成结果」。
        let ws = temp_workspace("wechat-shared");
        let wechat_temp = ws.join("AppData").join("Local").join("Temp").join("WeChat Files");
        write_png(&wechat_temp.join("808c9edfc624ab.png"), b"wechat-image-bytes");
        write_png(&ws.join("Desktop").join("a.png"), b"desktop-image");
        write_png(&ws.join("Downloads").join("b.png"), b"download-image");

        let shared = ws.join("Image2");
        let settings = settings_with_dirs(
            &shared.to_string_lossy(),
            &shared.to_string_lossy(),
        );
        let result = import_images_to_library_core(
            &settings,
            &[
                wechat_temp.join("808c9edfc624ab.png").to_string_lossy().to_string(),
                ws.join("Desktop").join("a.png").to_string_lossy().to_string(),
                ws.join("Downloads").join("b.png").to_string_lossy().to_string(),
            ],
        )
        .expect("import should succeed");

        assert_eq!(result.imported.len(), 3);
        for imported in &result.imported {
            let classified = classify_source_kind(Path::new(&imported.local_path), &settings);
            assert_eq!(
                classified, "library_input",
                "外部拖入文件（{}）入库后必须判定为 library_input",
                imported.file_name
            );
        }
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn import_file_already_in_managed_dirs_is_skipped_without_copy() {
        let ws = temp_workspace("skip");
        write_png(&ws.join("library").join("photo.png"), b"existing");
        write_png(&ws.join("output").join("task1").join("a.png"), b"generated");

        let settings = settings_with_dirs(
            &ws.join("library").to_string_lossy(),
            &ws.join("output").to_string_lossy(),
        );
        let result = import_images_to_library_core(
            &settings,
            &[
                ws.join("library").join("photo.png").to_string_lossy().to_string(),
                ws.join("output").join("task1").join("a.png").to_string_lossy().to_string(),
            ],
        )
        .expect("import should succeed");

        assert!(result.imported.is_empty());
        assert_eq!(result.skipped.len(), 2);
        // 绝不出现 photo (1).png 之类的副本
        assert!(!ws.join("library").join("photo (1).png").exists());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn import_same_name_same_content_skips_and_different_content_suffixes() {
        let ws = temp_workspace("collision");
        write_png(&ws.join("library").join("girl.png"), b"same-content");
        let external = ws.join("downloads");
        write_png(&external.join("girl.png"), b"same-content"); // 同内容
        write_png(&external.join("girl2.png"), b"different"); // 改名后再拖同名不同内容

        let settings = settings_with_dirs(
            &ws.join("library").to_string_lossy(),
            &ws.join("output").to_string_lossy(),
        );
        // 同内容同名 → 跳过，不造副本
        let result = import_images_to_library_core(
            &settings,
            &[external.join("girl.png").to_string_lossy().to_string()],
        )
        .expect("import should succeed");
        assert!(result.imported.is_empty());
        assert_eq!(result.skipped.len(), 1);
        assert!(!ws.join("library").join("girl (1).png").exists());

        // 先放入 girl.png（不同内容）再导入 → 生成 girl (1).png 副本
        write_png(&ws.join("library").join("same.png"), b"placeholder");
        let result2 = import_images_to_library_core(
            &settings,
            &[external.join("girl2.png").to_string_lossy().to_string()],
        )
        .expect("import should succeed");
        assert_eq!(result2.imported.len(), 1);
        // 不同名文件直接原名入库
        assert!(ws.join("library").join("girl2.png").exists());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn import_name_collision_different_content_gets_suffix() {
        let ws = temp_workspace("suffix");
        write_png(&ws.join("library").join("girl.png"), b"library-version");
        let external = ws.join("downloads");
        write_png(&external.join("girl.png"), b"downloads-version");

        let settings = settings_with_dirs(
            &ws.join("library").to_string_lossy(),
            &ws.join("other-output").to_string_lossy(),
        );
        let result = import_images_to_library_core(
            &settings,
            &[external.join("girl.png").to_string_lossy().to_string()],
        )
        .expect("import should succeed");

        assert_eq!(result.imported.len(), 1);
        assert_eq!(result.imported[0].file_name, "girl (1).png");
        assert!(ws.join("library").join("girl (1).png").exists());
        // 原文件不被覆盖
        assert_eq!(fs::read(ws.join("library").join("girl.png")).unwrap(), b"library-version");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn import_rejects_missing_directory_and_unsupported_formats() {
        let ws = temp_workspace("invalid");
        let external = ws.join("downloads");
        write_png(&external.join("doc.pdf"), b"pdf");
        fs::create_dir_all(external.join("folder.png")).expect("create dir");

        let settings = settings_with_dirs(
            &ws.join("library").to_string_lossy(),
            &ws.join("output").to_string_lossy(),
        );
        let result = import_images_to_library_core(
            &settings,
            &[
                external.join("missing.png").to_string_lossy().to_string(),
                external.join("folder.png").to_string_lossy().to_string(),
                external.join("doc.pdf").to_string_lossy().to_string(),
            ],
        )
        .expect("import should succeed");

        assert!(result.imported.is_empty());
        assert_eq!(result.failed.len(), 3);
        let reasons: Vec<&str> = result.failed.iter().map(|f| f.reason.as_str()).collect();
        assert!(reasons.contains(&"文件不存在"));
        assert!(reasons.contains(&"不支持文件夹"));
        assert!(reasons.contains(&"不支持该文件格式"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn import_requires_configured_input_dir() {
        let err = import_images_to_library_core(&Settings::default(), &["D:/a.png".to_string()])
            .expect_err("empty library_input_dir must fail");
        assert!(err.contains("本地导入目录"));
    }

    #[test]
    fn import_dedupes_repeated_paths_in_one_drop() {
        let ws = temp_workspace("dedupe");
        let external = ws.join("downloads");
        write_png(&external.join("girl.png"), b"png-bytes-a");

        let settings = settings_with_dirs(
            &ws.join("library").to_string_lossy(),
            &ws.join("output").to_string_lossy(),
        );
        // Windows 反斜杠与正斜杠混写、大小写不同 —— 同一文件只导入一次
        let p1 = external.join("girl.png").to_string_lossy().to_string();
        let p2 = p1.replace('/', "\\");
        let result =
            import_images_to_library_core(&settings, &[p1, p2]).expect("import should succeed");
        assert_eq!(result.imported.len(), 1);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn agent_run_payload_billing_mode_backward_compatible() {
        // 旧前端 payload（无 billing_mode 字段）必须继续反序列化成功（serde default）
        let legacy = serde_json::json!({
            "mode": "chat",
            "base_url": "https://open.bigmodel.cn/api/paas/v4",
            "token": "sk-x",
            "model": "glm-5.2"
        });
        let payload: AgentRunPayload =
            serde_json::from_value(legacy).expect("legacy payload without billing_mode must parse");
        assert_eq!(payload.billing_mode, None);
        assert_eq!(payload.base_url, "https://open.bigmodel.cn/api/paas/v4");

        // 新前端 payload：billing_mode 仅透传诊断，不影响 base_url
        let modern = serde_json::json!({
            "mode": "chat",
            "base_url": "https://open.bigmodel.cn/api/coding/paas/v4",
            "token": "sk-y",
            "model": "glm-5.2",
            "billing_mode": "coding_plan"
        });
        let payload: AgentRunPayload = serde_json::from_value(modern).expect("modern payload must parse");
        assert_eq!(payload.billing_mode.as_deref(), Some("coding_plan"));
        assert_eq!(
            payload.base_url,
            "https://open.bigmodel.cn/api/coding/paas/v4",
            "Rust 不按 billing_mode 猜测地址，始终使用前端 resolver 解析后的 base_url"
        );
    }

    #[test]
    fn transport_preference_is_model_capability_not_mode() {
        // GLM / DeepSeek / 普通 OpenAI Compatible 模型：任何模式（含 plan_task /
        // interpret）都必须 chat/completions 优先 —— 它们没有 /responses endpoint。
        for model in ["glm-5.2", "glm-4.5-air", "deepseek-chat", "deepseek-reasoner", "gpt-5.4"] {
            for mode in ["chat", "plan_task", "interpret"] {
                assert_eq!(
                    resolve_transport_preference(model, mode),
                    vec!["chat_completions", "responses"],
                    "model={model} mode={mode} must prefer chat_completions"
                );
            }
        }
        // Responses-only 模型：任何模式都 Responses 优先。
        for model in ["gpt-5.6-luna", "gpt-5.6-chat", "my-model-responses"] {
            for mode in ["chat", "plan_task", "interpret"] {
                assert_eq!(
                    resolve_transport_preference(model, mode),
                    vec!["responses", "chat_completions"],
                    "model={model} mode={mode} must prefer responses"
                );
            }
        }
    }

    #[test]
    fn extract_model_ids_supports_openai_and_string_forms() {
        let standard: serde_json::Value =
            serde_json::from_str(r#"{"data":[{"id":"glm-5.3"},{"id":"glm-4.5-air"},{"id":""}]}"#)
                .unwrap();
        assert_eq!(
            extract_model_ids(&standard),
            vec!["glm-5.3".to_string(), "glm-4.5-air".to_string()]
        );

        let string_form: serde_json::Value =
            serde_json::from_str(r#"["model-a","model-b","model-a"]"#).unwrap();
        assert_eq!(
            extract_model_ids(&string_form),
            vec!["model-a".to_string(), "model-b".to_string()]
        );

        let empty: serde_json::Value = serde_json::from_str("{}").unwrap();
        assert!(extract_model_ids(&empty).is_empty());
    }

    #[test]
    #[test]
    fn effective_max_tokens_defaults_and_clamps() {
        // 缺省 None = 4096（既有调用方行为不变）
        assert_eq!(effective_max_tokens(None), 4096);
        // comic_planner 大 JSON 输出的显式覆盖
        assert_eq!(effective_max_tokens(Some(8192)), 8192);
        // 异常值钳制：下限保基本输出，上限防误传打爆配额
        assert_eq!(effective_max_tokens(Some(64)), 1024);
        assert_eq!(effective_max_tokens(Some(1_000_000)), 16384);
    }

    #[test]
    fn chat_finish_reason_extracts_from_choices() {
        let body = serde_json::json!({
            "choices": [{ "message": { "content": "{}" }, "finish_reason": "length" }]
        });
        assert_eq!(
            chat_finish_reason(&body).as_deref(),
            Some("length"),
            "finish_reason=length 是前端截断归类的关键信号"
        );
        assert_eq!(chat_finish_reason(&serde_json::json!({})), None);
        // finish_reason 为 null（部分网关）→ None 而不是崩溃
        let null_reason = serde_json::json!({ "choices": [{ "finish_reason": null }] });
        assert_eq!(chat_finish_reason(&null_reason), None);
    }

    fn normalize_agent_base_url_respects_version_segments() {
        // 智谱官方地址已带 /v4，不得再拼 /v1
        assert_eq!(
            normalize_agent_base_url("https://open.bigmodel.cn/api/paas/v4/"),
            "https://open.bigmodel.cn/api/paas/v4"
        );
        // 常见 /v1 / v1beta 形式保持不变
        assert_eq!(
            normalize_agent_base_url("https://www.packyapi.com/v1"),
            "https://www.packyapi.com/v1"
        );
        assert_eq!(
            normalize_agent_base_url("https://example.com/v1beta"),
            "https://example.com/v1beta"
        );
        // 裸域名补 /v1
        assert_eq!(
            normalize_agent_base_url("https://api.example.com"),
            "https://api.example.com/v1"
        );
    }

    #[test]
    fn planner_parser_handles_json_code_fence() {
        let s = "```json\n{\"intent\":\"CREATE_IMAGE\",\"final_prompt\":\"x\",\"execution_model\":\"gpt-image-2\"}\n```";
        assert_eq!(expect_intent(s), "CREATE_IMAGE");
    }

    #[test]
    fn planner_parser_handles_plain_code_fence() {
        let s = "```\n{\"intent\":\"EDIT_IMAGE\",\"final_prompt\":\"x\"}\n```";
        assert_eq!(expect_intent(s), "EDIT_IMAGE");
    }

    #[test]
    fn planner_parser_handles_leading_prose() {
        let s = "下面是规划结果：\n{\"intent\":\"CREATE_IMAGE\",\"final_prompt\":\"x\"}";
        assert_eq!(expect_intent(s), "CREATE_IMAGE");
    }

    #[test]
    fn planner_parser_handles_trailing_prose() {
        let s = "{\"intent\":\"CREATE_IMAGE\",\"final_prompt\":\"x\"}\n\n以上为任务规划结果。";
        assert_eq!(expect_intent(s), "CREATE_IMAGE");
    }

    #[test]
    fn planner_parser_handles_braces_inside_strings() {
        // 字符串里出现的 `}` 不应该让 balanced 扫描提前收口或错位。
        let s = "{\"intent\":\"CREATE_IMAGE\",\"final_prompt\":\"场景：{城市背景}，人物站在街角\"}";
        assert_eq!(expect_intent(s), "CREATE_IMAGE");
    }

    #[test]
    fn planner_parser_rejects_truly_illegal_text() {
        let s = "我认为应该生成一张 LOL 对战图，但没给出 JSON。";
        assert!(extract_json_object_text(s).is_none());
    }

    // ========================================================================
    // Planner 截断检测（planner_output_truncated）—— 本轮修复的核心回归防线。
    // 截断 JSON 与"模型胡说"必须区分为不同 error_kind，且绝不允许脑补补全。
    // ========================================================================

    #[test]
    fn truncated_json_detected_when_stops_mid_string() {
        // 实际日志样例：停在 final_prompt 字符串内部，没有闭引号也没有 }
        let s = "{\n  \"intent\": \"EDIT_IMAGE\",\n  \"title\": \"夜晚动态白毛";
        assert!(looks_like_truncated_json(s));
        assert!(extract_json_object_text(s).is_none());
    }

    #[test]
    fn truncated_json_detected_when_stops_after_unclosed_object() {
        // 字符串完整闭合了，但对象本身没有闭合
        let s = "{\"intent\": \"EDIT_IMAGE\", \"final_prompt\": \"白发少女\"";
        assert!(looks_like_truncated_json(s));
    }

    #[test]
    fn truncated_json_not_flagged_for_complete_json() {
        let s = "{\"intent\": \"EDIT_IMAGE\", \"final_prompt\": \"白发少女\"}";
        assert!(!looks_like_truncated_json(s));
    }

    #[test]
    fn truncated_json_not_flagged_for_prose_without_object() {
        // 模型输出解释性文字（没有任何 {）→ 是格式错误，不是截断
        let s = "我认为应该生成一张 LOL 对战图，但没给出 JSON。";
        assert!(!looks_like_truncated_json(s));
    }

    #[test]
    fn truncated_json_handles_braces_inside_strings() {
        // 字符串里的 { } 不应干扰深度扫描
        let s = "{\"final_prompt\": \"构图 {城市} 与 {人物}";
        assert!(looks_like_truncated_json(s));
    }

    #[test]
    fn classify_failure_prefers_explicit_length_signal() {
        // finish_reason=length 是权威截断信号，即使结构扫描不命中也按截断处理
        // （例如模型恰好停在 } 之后但 JSON 中间缺失）。
        assert_eq!(
            classify_planner_parse_failure("garbage", Some("length"), None),
            PlannerParseFailureKind::Truncated
        );
        // Responses status=incomplete 同理。
        assert_eq!(
            classify_planner_parse_failure("garbage", None, Some("incomplete")),
            PlannerParseFailureKind::Truncated
        );
        // finish_reason=stop + 纯文字 → 格式错误。
        assert_eq!(
            classify_planner_parse_failure("就是不想给 JSON", Some("stop"), Some("completed")),
            PlannerParseFailureKind::Malformed
        );
    }

    #[test]
    fn classify_failure_structural_heuristic_without_metadata() {
        assert_eq!(
            classify_planner_parse_failure("{\"intent\": \"EDIT", None, None),
            PlannerParseFailureKind::Truncated
        );
        assert_eq!(
            classify_planner_parse_failure("没有任何对象的胡话", None, None),
            PlannerParseFailureKind::Malformed
        );
    }

    // ========================================================================
    // Responses Adapter fixture 测试 —— 验证 extract_final_responses_text /
    // build_responses_diagnostic / classify_missing_text 在各种真实上游
    // 返回 shape 下的行为。这些测试是 "response_text_missing 根治" 的回归防线。
    // ========================================================================

    fn diag_for(body: serde_json::Value) -> (Option<String>, ResponsesShapeDiagnostic) {
        let text = extract_final_responses_text(&body);
        let extracted_text_len = text.as_deref().map(|s| s.chars().count()).unwrap_or(0);
        let diag = build_responses_diagnostic(200, &body, extracted_text_len);
        (text, diag)
    }

    #[test]
    fn responses_case_a_top_level_output_text() {
        // 一些 SDK / 代理会把 final text 直接扁平化到顶层 output_text 字段。
        let body = json!({ "output_text": "{\"intent\":\"CREATE_IMAGE\"}" });
        let (text, diag) = diag_for(body);
        assert_eq!(text.as_deref(), Some("{\"intent\":\"CREATE_IMAGE\"}"));
        assert!(diag.has_top_level_output_text);
        assert_eq!(
            diag.extracted_text_len,
            "{\"intent\":\"CREATE_IMAGE\"}".chars().count()
        );
    }

    #[test]
    fn responses_case_b_message_with_output_text() {
        // OpenAI Responses 标准形态：output[0] 是 message，content[0] 是 output_text。
        let body = json!({
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "content": [
                        { "type": "output_text", "text": "{\"intent\":\"CREATE_IMAGE\"}" }
                    ]
                }
            ]
        });
        let (text, diag) = diag_for(body);
        assert_eq!(text.as_deref(), Some("{\"intent\":\"CREATE_IMAGE\"}"));
        assert_eq!(diag.output_count, 1);
        assert_eq!(diag.output_types, vec!["message".to_string()]);
        assert_eq!(diag.content_types, vec!["output_text".to_string()]);
    }

    #[test]
    fn responses_case_c_reasoning_then_message() {
        // gpt-5.4 / gpt-5.6-luna 经典形态：先 reasoning 后 message。
        // 旧的 "只读 output[0]" 假设会拿不到 final text —— 这里验证遍历正确。
        let body = json!({
            "status": "completed",
            "output": [
                { "type": "reasoning", "id": "rs_1" },
                {
                    "type": "message",
                    "content": [
                        { "type": "output_text", "text": "{\"intent\":\"CREATE_IMAGE\"}" }
                    ]
                }
            ]
        });
        let (text, diag) = diag_for(body);
        assert_eq!(text.as_deref(), Some("{\"intent\":\"CREATE_IMAGE\"}"));
        assert_eq!(diag.output_count, 2);
        assert_eq!(
            diag.output_types,
            vec!["reasoning".to_string(), "message".to_string()]
        );
        assert_eq!(diag.content_types, vec!["output_text".to_string()]);
    }

    #[test]
    fn responses_case_d_multiple_output_text_in_one_message() {
        // 一个 message 的 content 里被切成多段 output_text —— 必须按顺序拼接。
        let body = json!({
            "output": [
                {
                    "type": "message",
                    "content": [
                        { "type": "output_text", "text": "part1" },
                        { "type": "output_text", "text": "part2" }
                    ]
                }
            ]
        });
        let (text, _diag) = diag_for(body);
        assert_eq!(text.as_deref(), Some("part1\npart2"));
    }

    #[test]
    fn responses_case_e_multiple_messages() {
        // 多个 message item —— 按出现顺序收集所有 final text。
        let body = json!({
            "output": [
                {
                    "type": "message",
                    "content": [{ "type": "output_text", "text": "msg1" }]
                },
                {
                    "type": "message",
                    "content": [{ "type": "output_text", "text": "msg2" }]
                }
            ]
        });
        let (text, diag) = diag_for(body);
        assert_eq!(text.as_deref(), Some("msg1\nmsg2"));
        assert_eq!(diag.output_count, 2);
    }

    #[test]
    fn responses_case_f_reasoning_only() {
        // 只返回 reasoning，没有 final message —— 这是 "reasoning 吃光预算" 的典型表现。
        // extract 应返回 None，classify 应给出 response_text_missing 且 message 指明原因。
        let body = json!({
            "status": "completed",
            "output": [
                { "type": "reasoning", "id": "rs_1" }
            ]
        });
        let (text, diag) = diag_for(body);
        assert!(text.is_none());
        let (kind, reason) = classify_missing_text(&diag);
        assert_eq!(kind, "response_text_missing");
        assert!(
            reason.contains("reasoning"),
            "reason should mention reasoning: {}",
            reason
        );
    }

    #[test]
    fn responses_case_g_error_body() {
        // 顶层 error —— 不能 fall through 到 response_text_missing，必须分类为 upstream_error。
        // 关键：error.message / type / code / param 必须完整透传到 diagnostic，
        // 前端"查看规划详情"才能告诉用户 gpt-5.6-luna 真正为什么失败。
        let body = json!({
            "error": {
                "message": "rate limit exceeded",
                "type": "rate_limit_error",
                "code": "rate_limit_exceeded",
                "param": null
            }
        });
        let (text, diag) = diag_for(body);
        assert!(text.is_none());
        assert!(diag.has_error);
        assert_eq!(
            diag.upstream_error_message.as_deref(),
            Some("rate limit exceeded")
        );
        assert_eq!(
            diag.upstream_error_type.as_deref(),
            Some("rate_limit_error")
        );
        assert_eq!(
            diag.upstream_error_code.as_deref(),
            Some("rate_limit_exceeded")
        );
        let (kind, reason) = classify_missing_text(&diag);
        assert_eq!(kind, "upstream_error");
        assert!(
            reason.contains("rate limit exceeded"),
            "reason must embed upstream message: {}",
            reason
        );
    }

    #[test]
    fn responses_case_g2_unsupported_parameter_not_retryable() {
        // gpt-5.6-luna 典型场景：HTTP 200 + body.error.code = unsupported_parameter。
        // 必须把真实 message / code / param 透传，并且判定为不可重试，
        // 否则用户点十次"重新规划"都会被同一个参数错打回。
        let body = json!({
            "error": {
                "message": "Unsupported parameter: text.format is not supported by this model.",
                "type": "invalid_request_error",
                "code": "unsupported_parameter",
                "param": "text.format"
            }
        });
        let (text, diag) = diag_for(body);
        assert!(text.is_none());
        assert!(diag.has_error);
        assert_eq!(
            diag.upstream_error_code.as_deref(),
            Some("unsupported_parameter")
        );
        assert_eq!(diag.upstream_error_param.as_deref(), Some("text.format"));
        assert!(diag
            .upstream_error_message
            .as_deref()
            .unwrap_or("")
            .contains("text.format"));
        let (kind, reason) = classify_missing_text(&diag);
        assert_eq!(kind, "upstream_error");
        assert!(
            reason.contains("text.format"),
            "reason must embed param so user knows what to change: {}",
            reason
        );
        // 不允许自动 retry —— 这是确定性参数错误，重试只是浪费一次配额。
        assert!(!is_retryable_upstream_error_code(
            diag.upstream_error_code.as_deref(),
            diag.upstream_error_type.as_deref(),
        ));
    }

    #[test]
    fn responses_case_g3_status_failed_last_error() {
        // Responses 协议的 status=failed —— 真实原因在 last_error 里。
        let body = json!({
            "status": "failed",
            "last_error": {
                "code": "server_error",
                "message": "inference pipeline degraded"
            }
        });
        let (text, diag) = diag_for(body);
        assert!(text.is_none());
        assert_eq!(diag.response_status.as_deref(), Some("failed"));
        assert_eq!(diag.upstream_error_code.as_deref(), Some("server_error"));
        assert_eq!(
            diag.upstream_error_message.as_deref(),
            Some("inference pipeline degraded")
        );
        let (kind, reason) = classify_missing_text(&diag);
        assert_eq!(kind, "upstream_error");
        assert!(reason.contains("inference pipeline degraded"));
        // server_error 允许 retry 一次
        assert!(is_retryable_upstream_error_code(
            diag.upstream_error_code.as_deref(),
            diag.upstream_error_type.as_deref(),
        ));
    }

    #[test]
    fn retry_classifier_distinguishes_hard_fail_vs_transient() {
        // 确定性参数 / 模型 / 鉴权 / 内容策略错误 —— 绝不 retry
        assert!(!is_retryable_upstream_error_code(
            Some("unsupported_parameter"),
            Some("invalid_request_error"),
        ));
        assert!(!is_retryable_upstream_error_code(
            Some("invalid_request"),
            None,
        ));
        assert!(!is_retryable_upstream_error_code(
            Some("model_not_found"),
            None,
        ));
        assert!(!is_retryable_upstream_error_code(
            Some("authentication_error"),
            None,
        ));
        // 临时性 / 上游服务问题 —— 允许 retry 一次
        assert!(is_retryable_upstream_error_code(Some("server_error"), None,));
        assert!(is_retryable_upstream_error_code(
            Some("temporarily_unavailable"),
            None,
        ));
        assert!(is_retryable_upstream_error_code(
            None,
            Some("rate_limit_error"),
        ));
        // 未知错误 —— 保守不 retry，把真实 message 抛给用户
        assert!(!is_retryable_upstream_error_code(None, None));
        assert!(!is_retryable_upstream_error_code(
            Some("something_bizarre"),
            Some("never_seen"),
        ));
    }

    #[test]
    fn responses_case_h_status_incomplete() {
        // Responses status=incomplete —— 应分类为 response_incomplete。
        let body = json!({
            "status": "incomplete",
            "incomplete_details": { "reason": "max_output_tokens" },
            "output": [
                { "type": "reasoning", "id": "rs_1" }
            ]
        });
        let (text, diag) = diag_for(body);
        assert!(text.is_none());
        assert_eq!(diag.response_status.as_deref(), Some("incomplete"));
        assert_eq!(diag.incomplete_reason.as_deref(), Some("max_output_tokens"));
        let (kind, reason) = classify_missing_text(&diag);
        // 注意：incomplete 的优先级高于 reasoning-only
        assert_eq!(kind, "response_incomplete");
        assert!(reason.contains("max_output_tokens"));
    }

    #[test]
    fn responses_case_i_chat_completions_choices_fallback() {
        // 个别代理在 Responses endpoint 也返回 chat completions shape —— 必须兜底支持。
        let body = json!({
            "choices": [
                { "message": { "content": "{\"intent\":\"CREATE_IMAGE\"}" } }
            ]
        });
        let (text, diag) = diag_for(body);
        assert_eq!(text.as_deref(), Some("{\"intent\":\"CREATE_IMAGE\"}"));
        assert!(diag.has_choices);
    }

    #[test]
    fn responses_case_j_message_without_output_text() {
        // message 存在但 content 里只有 refusal —— 应识别为 missing，且原因提到 "没有 output_text"。
        let body = json!({
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "content": [{ "type": "refusal", "refusal": "I can't do that" }]
                }
            ]
        });
        let (text, diag) = diag_for(body);
        assert!(text.is_none());
        let (kind, reason) = classify_missing_text(&diag);
        assert_eq!(kind, "response_text_missing");
        assert!(
            reason.contains("output_text"),
            "reason should mention output_text: {}",
            reason
        );
    }

    #[test]
    fn responses_case_k_completely_empty_output() {
        // output[] 完全为空 —— classify 给出明确的 missing 原因。
        let body = json!({ "status": "completed", "output": [] });
        let (text, diag) = diag_for(body);
        assert!(text.is_none());
        let (kind, reason) = classify_missing_text(&diag);
        assert_eq!(kind, "response_text_missing");
        assert!(reason.contains("为空"));
    }

    // ========================================================================
    // v3.0.5 回归防线：error:null / error:{} / error:{all-null-fields} 不能被
    // 错判成 upstream_error。这是用户实际命中过的 bug —— 顶层 `error: null` 让
    // 旧 `body.get("error").is_some()` 错判为 true，进而把 completed + output=[]
    // 错分类成 upstream_error，同时 retry policy 也跟着跳过自动重试。
    // ========================================================================

    #[test]
    fn error_null_is_not_meaningful_error() {
        // 上游很多代理（含 packy）在 2xx 成功响应里也保留 `"error": null` 字段。
        let body = json!({ "status": "completed", "error": null, "output": [] });
        assert!(!has_meaningful_upstream_error(&body));
        let (_text, diag) = diag_for(body);
        assert!(!diag.has_error);
        assert_eq!(diag.upstream_error_message, None);
        assert_eq!(diag.upstream_error_type, None);
        assert_eq!(diag.upstream_error_code, None);
        assert_eq!(diag.upstream_error_param, None);
    }

    #[test]
    fn error_empty_object_is_not_meaningful_error() {
        let body = json!({ "status": "completed", "error": {}, "output": [] });
        assert!(!has_meaningful_upstream_error(&body));
        let (_text, diag) = diag_for(body);
        assert!(!diag.has_error);
    }

    #[test]
    fn error_all_null_fields_is_not_meaningful_error() {
        // 一些代理把所有 error 子字段都序列化成 null —— 旧逻辑会因 key 存在判错。
        let body = json!({
            "status": "completed",
            "error": { "message": null, "type": null, "code": null, "param": null },
            "output": []
        });
        assert!(!has_meaningful_upstream_error(&body));
        let (_text, diag) = diag_for(body);
        assert!(!diag.has_error);
    }

    #[test]
    fn error_real_object_is_meaningful_and_not_retryable_for_unsupported_parameter() {
        let body = json!({
            "error": {
                "message": "Unsupported parameter: text.format is not supported by this model.",
                "type": "invalid_request_error",
                "code": "unsupported_parameter",
                "param": "text.format"
            }
        });
        assert!(has_meaningful_upstream_error(&body));
        let (_text, diag) = diag_for(body);
        assert!(diag.has_error);
        assert_eq!(
            diag.upstream_error_code.as_deref(),
            Some("unsupported_parameter")
        );
        assert_eq!(diag.upstream_error_param.as_deref(), Some("text.format"));
        assert!(!is_retryable_upstream_error_code(
            diag.upstream_error_code.as_deref(),
            diag.upstream_error_type.as_deref(),
        ));
    }

    #[test]
    fn error_string_form_is_meaningful() {
        // 个别非标准代理把 error 直接写成字符串。
        let body = json!({ "error": "upstream failed" });
        assert!(has_meaningful_upstream_error(&body));
        // 这种形态 extract_full_error_parts_from_value 走 detail / message fallback
        // 不会捕获到字符串形态，但仍按"是否存在 error key 且非空"判定为有意义错误。
        // 这里只断言 meaningful 判定，extract 行为在其它测试覆盖。
    }

    #[test]
    fn last_error_null_is_not_meaningful_error() {
        // Responses 协议要求 status=failed 时携带 last_error；但即便失败，
        // 个别代理把 last_error 也填成 null —— 不能因为 key 存在就报 upstream_error。
        let body = json!({ "status": "failed", "last_error": null });
        assert!(!has_meaningful_upstream_error(&body));
    }

    #[test]
    fn last_error_real_object_is_meaningful_and_retryable_for_server_error() {
        let body = json!({
            "status": "failed",
            "last_error": { "code": "server_error", "message": "Temporary failure" }
        });
        assert!(has_meaningful_upstream_error(&body));
        let (_text, diag) = diag_for(body);
        assert_eq!(diag.upstream_error_code.as_deref(), Some("server_error"));
        assert_eq!(
            diag.upstream_error_message.as_deref(),
            Some("Temporary failure")
        );
        assert!(is_retryable_upstream_error_code(
            diag.upstream_error_code.as_deref(),
            diag.upstream_error_type.as_deref(),
        ));
    }

    #[test]
    fn completed_empty_output_with_error_null_classifies_as_response_text_missing() {
        // 真实命中过的 bug 场景：HTTP 200 + status=completed + error=null + output=[]。
        // 必须分类为 response_text_missing（可 retry 一次），而不是 upstream_error。
        let body = json!({
            "status": "completed",
            "error": null,
            "output": []
        });
        let (text, diag) = diag_for(body);
        assert!(text.is_none());
        assert!(!diag.has_error);
        let (kind, _reason) = classify_missing_text(&diag);
        assert_eq!(
            kind, "response_text_missing",
            "completed + error:null + output=[] must NOT be upstream_error"
        );
    }

    #[test]
    fn retry_soft_cause_true_for_completed_empty_output_with_error_null() {
        // 与 retry 策略的合约：has_error=false + status=completed → soft_cause=true（retry 一次）。
        // 这里直接断言 retry 策略在 diag 上的等价判断。
        let body = json!({
            "status": "completed",
            "error": null,
            "output": []
        });
        let (_text, diag) = diag_for(body);
        let soft_cause = if diag.has_error {
            is_retryable_upstream_error_code(
                diag.upstream_error_code.as_deref(),
                diag.upstream_error_type.as_deref(),
            )
        } else {
            matches!(
                diag.response_status.as_deref(),
                None | Some("completed") | Some("incomplete")
            )
        };
        assert!(
            soft_cause,
            "should retry once on completed+error:null+empty output"
        );
    }

    // ========================================================================
    // text source 跟踪 —— 验证 extract_final_responses_text_with_source 在
    // 各典型形态下命中正确的 source 标签。未来日志里看到 text_source=... 就能
    // 立刻判断是 extractor 选错分支还是上游没产出 final text。
    // ========================================================================

    #[test]
    fn text_source_top_level_output_text() {
        let body = json!({ "output_text": "{\"intent\":\"CREATE_IMAGE\"}" });
        let extracted = extract_final_responses_text_with_source(&body);
        let (text, source) = extracted.expect("should extract");
        assert_eq!(text, "{\"intent\":\"CREATE_IMAGE\"}");
        assert_eq!(source, ResponsesTextSource::TopLevelOutputText);
    }

    #[test]
    fn text_source_output_message_content_text() {
        let body = json!({
            "output": [
                {
                    "type": "message",
                    "content": [{ "type": "output_text", "text": "hello" }]
                }
            ]
        });
        let (text, source) =
            extract_final_responses_text_with_source(&body).expect("should extract");
        assert_eq!(text, "hello");
        assert_eq!(source, ResponsesTextSource::OutputMessageContentText);
    }

    #[test]
    fn text_source_choices_message_content_for_chat_completions_passthrough() {
        let body = json!({
            "choices": [{ "message": { "content": "hi from chat completions" } }]
        });
        let (text, source) =
            extract_final_responses_text_with_source(&body).expect("should extract");
        assert_eq!(text, "hi from chat completions");
        assert_eq!(source, ResponsesTextSource::ChoicesMessageContent);
    }

    #[test]
    fn text_source_none_when_output_empty() {
        let body = json!({ "status": "completed", "output": [] });
        assert!(extract_final_responses_text_with_source(&body).is_none());
    }

    // ========================================================================
    // Raw Shape Diagnostic 脱敏 —— 长字符串截断、数组限项、嵌套深度限制。
    // ========================================================================

    #[test]
    fn redact_json_truncates_long_strings() {
        let long = "x".repeat(600);
        let v = json!({ "message": long });
        let s = redact_json(&v, 100, 3, 3);
        // 输出不应包含完整的 600 个 x；只应包含截断后的前 100 个 + "..."
        assert!(!s.contains(&"x".repeat(200)));
        assert!(s.contains("..."));
    }

    #[test]
    fn redact_json_caps_array_items() {
        let v = json!({ "output": [1, 2, 3, 4, 5] });
        let s = redact_json(&v, 100, 3, 3);
        assert!(
            s.contains("(2 more)"),
            "should note 2 truncated items, got: {}",
            s
        );
    }

    #[test]
    fn redact_json_depth_limits_nested_objects() {
        let v = json!({
            "a": { "b": { "c": { "d": { "e": "deep" } } } }
        });
        let s = redact_json(&v, 100, 3, 2);
        assert!(
            s.contains("<omitted>"),
            "should hit depth limit, got: {}",
            s
        );
    }

    #[test]
    fn raw_shape_summary_does_not_panic_on_minimal_body() {
        // 当上游返回极简外壳（packy 200 + output=[]）时，summary 必须能安全生成。
        let body = json!({ "status": "completed", "output": [], "error": null });
        let s = build_responses_raw_shape_summary(&body);
        assert!(s.contains("status="));
        assert!(s.contains("output="));
        assert!(s.contains("error=null"));
    }

    // ========================================================================
    // Responses Payload Recovery —— provider_response_payload_missing 检测、
    // Retrieve / SSE Streaming 各阶段、SSE 增量解析器（split chunk / 多事件 /
    // CRLF / [DONE] / response.failed / error）的回归防线。
    //
    // 这批测试对应"为什么 usage.output_tokens > 0 但 response.output=[]" 这一真实
    // 运行时问题：客户端已确认 Provider 返回的最终非流式 JSON 本身就是 output=[]，
    // 静态代码无法知道代理内部为什么丢失 output。我们能做的是：检测此场景，
    // 触发 Retrieve + SSE Streaming 恢复流程，而不是再原样 POST 重试一次。
    // ========================================================================

    #[test]
    fn extract_output_token_count_reads_usage_output_tokens() {
        let body = json!({ "usage": { "output_tokens": 544 } });
        assert_eq!(extract_output_token_count(&body), Some(544));
    }

    #[test]
    fn extract_output_token_count_returns_none_when_usage_missing() {
        let body = json!({ "status": "completed", "output": [] });
        assert_eq!(extract_output_token_count(&body), None);
    }

    #[test]
    fn extract_output_token_count_returns_some_zero_when_explicit_zero() {
        // 关键：Some(0) 与 None 语义不同。Some(0) 表示模型明确没产生 token。
        let body = json!({ "usage": { "output_tokens": 0 } });
        assert_eq!(extract_output_token_count(&body), Some(0));
    }

    #[test]
    fn extract_output_token_count_supports_string_form() {
        // 个别非标准代理把 token 数序列化成字符串。
        let body = json!({ "usage": { "output_tokens": "533" } });
        assert_eq!(extract_output_token_count(&body), Some(533));
    }

    #[test]
    fn payload_missing_true_for_completed_empty_output_with_tokens() {
        // 真实命中过的运行时场景：HTTP 200 + completed + error=null + output=[]
        // + usage.output_tokens=544。必须判定为 payload_missing。
        let body = json!({
            "id": "resp_test",
            "status": "completed",
            "error": null,
            "output": [],
            "usage": { "output_tokens": 544 }
        });
        let diag = build_responses_diagnostic(200, &body, 0);
        assert!(is_provider_response_payload_missing(200, &body, &diag));
        assert_eq!(diag.response_id.as_deref(), Some("resp_test"));
        assert_eq!(diag.output_tokens, Some(544));
    }

    #[test]
    fn payload_missing_false_when_output_tokens_zero() {
        // output_tokens=0：模型明确没产生 token，不属于 payload missing。
        let body = json!({
            "status": "completed",
            "error": null,
            "output": [],
            "usage": { "output_tokens": 0 }
        });
        let diag = build_responses_diagnostic(200, &body, 0);
        assert!(!is_provider_response_payload_missing(200, &body, &diag));
    }

    #[test]
    fn payload_missing_false_when_usage_missing() {
        // usage 缺失：无法证明模型产生了 token，不属于 payload missing。
        let body = json!({ "status": "completed", "error": null, "output": [] });
        let diag = build_responses_diagnostic(200, &body, 0);
        assert!(!is_provider_response_payload_missing(200, &body, &diag));
    }

    #[test]
    fn payload_missing_false_when_has_meaningful_error() {
        // 真正的上游报错（unsupported_parameter）绝不能落入 payload recovery。
        let body = json!({
            "status": "completed",
            "error": {
                "message": "Unsupported parameter",
                "type": "invalid_request_error",
                "code": "unsupported_parameter",
                "param": "text.format"
            },
            "output": [],
            "usage": { "output_tokens": 100 }
        });
        let diag = build_responses_diagnostic(200, &body, 0);
        assert!(!is_provider_response_payload_missing(200, &body, &diag));
    }

    #[test]
    fn payload_missing_false_when_status_failed() {
        let body = json!({
            "status": "failed",
            "last_error": { "code": "server_error", "message": "down" },
            "output": [],
            "usage": { "output_tokens": 100 }
        });
        let diag = build_responses_diagnostic(200, &body, 0);
        assert!(!is_provider_response_payload_missing(200, &body, &diag));
    }

    #[test]
    fn payload_missing_false_when_output_has_message() {
        // output 里有 message —— extractor 应该能拿到 text，不属于 payload missing。
        let body = json!({
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{ "type": "output_text", "text": "{\"intent\":\"CREATE_IMAGE\"}" }]
            }],
            "usage": { "output_tokens": 100 }
        });
        let diag = build_responses_diagnostic(200, &body, 26);
        assert!(!is_provider_response_payload_missing(200, &body, &diag));
    }

    #[test]
    fn classify_missing_text_returns_payload_missing_when_tokens_positive() {
        // classify_missing_text 在 output_tokens > 0 + output_count=0 时
        // 必须返回 provider_response_payload_missing，而不是 response_text_missing。
        let body = json!({
            "status": "completed",
            "error": null,
            "output": [],
            "usage": { "output_tokens": 544 }
        });
        let (_text, diag) = diag_for(body);
        let (kind, reason) = classify_missing_text(&diag);
        assert_eq!(kind, "provider_response_payload_missing");
        assert!(
            reason.contains("544"),
            "reason should mention token count: {}",
            reason
        );
    }

    #[test]
    fn classify_missing_text_still_response_text_missing_when_no_usage() {
        // 没有 usage（output_tokens=None）—— 仍属于 response_text_missing。
        // 这是 v3.0.5 回归测试的延续：error:null 不再被误判，但也不应该跳到 payload_missing。
        let body = json!({ "status": "completed", "error": null, "output": [] });
        let (_text, diag) = diag_for(body);
        let (kind, _reason) = classify_missing_text(&diag);
        assert_eq!(kind, "response_text_missing");
    }

    // ---------------------------------------------------------------- --------
    // 批量任务数量一致性（历史 3->4 防线之二：服务端钳位）
    // ---------------------------------------------------------------- --------

    #[test]
    fn resolve_task_count_batch_items_win() {
        // 3 条 Prompt = 3 项，count 传入多少都被钳位到子项数
        assert_eq!(resolve_task_count(3, 3, "batch"), 3);
        assert_eq!(resolve_task_count(4, 3, "batch"), 3);
        assert_eq!(resolve_task_count(0, 3, "single"), 3);
    }

    #[test]
    fn resolve_task_count_single_forced_to_one() {
        // 单张模式：即使客户端误传 count=4 也强制为 1
        assert_eq!(resolve_task_count(4, 0, "single"), 1);
        assert_eq!(resolve_task_count(1, 0, "single"), 1);
    }

    #[test]
    fn resolve_task_count_batch_without_items_uses_count() {
        // 历史 repeat_same 批量任务（无 batch_items）：count 原样生效
        assert_eq!(resolve_task_count(4, 0, "batch"), 4);
        assert_eq!(resolve_task_count(1, 0, "batch"), 1);
    }

    // ---------------------------------------------------------------- --------
    // Model Transport Capability Resolver —— 决定每个模型 / 模式走哪种 wire protocol
    // 关键契约：gpt-5.6-luna 在 chat 模式下必须走 Responses，否则上游回 protocol_not_supported。
    // ---------------------------------------------------------------- --------

    #[test]
    fn transport_resolver_gpt56_luna_chat_prefers_responses() {
        let order = resolve_transport_preference("gpt-5.6-luna", "chat");
        assert_eq!(order, vec!["responses", "chat_completions"]);
    }

    #[test]
    fn transport_resolver_gpt56_family_chat_prefers_responses() {
        for model in ["gpt-5.6", "gpt-5.6-mini", "gpt-5.6-luna"] {
            let order = resolve_transport_preference(model, "chat");
            assert_eq!(
                order,
                vec!["responses", "chat_completions"],
                "model={model}"
            );
        }
    }

    #[test]
    fn transport_resolver_gpt54_chat_keeps_chat_completions_primary() {
        // gpt-5.4 当前是 chat completions 兼容 —— 不允许凭假设一刀切到 Responses。
        let order = resolve_transport_preference("gpt-5.4", "chat");
        assert_eq!(order, vec!["chat_completions", "responses"]);
    }

    #[test]
    fn transport_resolver_other_models_chat_keeps_chat_completions_primary() {
        for model in ["gpt-4o", "claude-sonnet-4", ""] {
            let order = resolve_transport_preference(model, "chat");
            assert_eq!(
                order,
                vec!["chat_completions", "responses"],
                "model={model}"
            );
        }
    }

    #[test]
    fn transport_resolver_plan_task_follows_model_capability() {
        // transport 只由模型能力决定（mode 不覆盖）：标准 chat/completions 模型
        // 在 plan_task 模式下也 chat_completions 优先 —— 曾因 mode 强制
        // responses-first 导致 GLM / DeepSeek 任务规划 404。
        let order = resolve_transport_preference("gpt-4o", "plan_task");
        assert_eq!(order, vec!["chat_completions", "responses"]);
    }

    #[test]
    fn transport_resolver_interpret_follows_model_capability() {
        let order = resolve_transport_preference("gpt-4o", "interpret");
        assert_eq!(order, vec!["chat_completions", "responses"]);
        // Responses-only 模型在 interpret 下仍 Responses 优先
        assert_eq!(
            resolve_transport_preference("gpt-5.6-luna", "interpret"),
            vec!["responses", "chat_completions"]
        );
    }

    #[test]
    fn classify_upstream_error_flags_protocol_not_supported_chinese() {
        let kind = classify_upstream_error(
            400,
            Some("模型 gpt-5.6-luna 不支持 chat completions 协议"),
            None,
        );
        assert_eq!(kind, "protocol_not_supported");
    }

    #[test]
    fn classify_upstream_error_flags_protocol_not_supported_english() {
        let kind =
            classify_upstream_error(400, Some("model does not support chat completions"), None);
        assert_eq!(kind, "protocol_not_supported");
    }

    #[test]
    fn classify_upstream_error_flags_protocol_not_supported_by_code() {
        let kind =
            classify_upstream_error(400, Some("Bad request"), Some("protocol_not_supported"));
        assert_eq!(kind, "protocol_not_supported");
    }

    #[test]
    fn classify_upstream_error_does_not_misclassify_plain_invalid_request() {
        let kind = classify_upstream_error(400, Some("messages.0.content is required"), None);
        assert_eq!(kind, "invalid_request");
    }

    #[test]
    fn is_protocol_not_supported_detects_kind() {
        let s = AgentEndpointStatus {
            ok: false,
            kind: Some("protocol_not_supported".to_string()),
            message: "上游模型接口失败".to_string(),
            status: Some(400),
        };
        assert!(is_protocol_not_supported(&s));
    }

    #[test]
    fn is_protocol_not_supported_detects_message_text() {
        let s = AgentEndpointStatus {
            ok: false,
            kind: Some("invalid_request".to_string()),
            message: "模型 gpt-5.6-luna 不支持 chat completions 协议".to_string(),
            status: Some(400),
        };
        assert!(is_protocol_not_supported(&s));
    }

    #[test]
    fn is_protocol_not_supported_false_for_plain_auth_error() {
        let s = AgentEndpointStatus {
            ok: false,
            kind: Some("auth".to_string()),
            message: "Invalid API key".to_string(),
            status: Some(401),
        };
        assert!(!is_protocol_not_supported(&s));
    }

    // ---------------------------------------------------------------- --------
    // SSE 增量解析器 —— 验证 chunk boundary / 多事件 / CRLF / [DONE] / failed / error
    // ------------------------------------------------------------------------

    #[test]
    fn sse_next_event_range_finds_lf_pair() {
        // "data: {\"type\":\"x\"}" 占 18 字节，所以 \n\n 在 18..20。
        let buf = b"data: {\"type\":\"x\"}\n\ndata: more";
        let r = next_sse_event_range(buf).expect("should find LF boundary");
        assert_eq!(r, (18, 20));
    }

    #[test]
    fn sse_next_event_range_finds_crlf_pair() {
        // 同上，但分隔符是 \r\n\r\n（4 字节）。
        let buf = b"data: {\"type\":\"x\"}\r\n\r\ndata: more";
        let r = next_sse_event_range(buf).expect("should find CRLF boundary");
        assert_eq!(r, (18, 22));
    }

    #[test]
    fn sse_next_event_range_prefers_earlier_boundary() {
        // 当 \n\n 和 \r\n\r\n 都存在时，取更靠前的。
        // "data: a" 占 7 字节，所以 \n\n 在 7..9。
        let buf = b"data: a\n\ndata: b\r\n\r\ndata: c";
        let r = next_sse_event_range(buf).expect("should find first LF boundary");
        assert_eq!(r, (7, 9));
    }

    #[test]
    fn sse_next_event_range_returns_none_when_no_boundary() {
        let buf = b"data: partial without end";
        assert!(next_sse_event_range(buf).is_none());
    }

    #[test]
    fn sse_parse_event_reads_type_from_data_json() {
        // 没有 event: 行时，type 来自 data JSON 的 "type" 字段。
        let block = b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n";
        let parsed = parse_sse_event(block).expect("should parse");
        assert_eq!(parsed.event_type, "response.output_text.delta");
        assert_eq!(
            parsed.data.get("delta").and_then(|v| v.as_str()),
            Some("hi")
        );
    }

    #[test]
    fn sse_parse_event_prefers_event_line_over_data_type() {
        // event: 行优先于 data JSON 的 type 字段（部分代理只发 event: + raw JSON）。
        let block = b"event: response.output_text.delta\ndata: {\"delta\":\"x\"}\n";
        let parsed = parse_sse_event(block).expect("should parse");
        assert_eq!(parsed.event_type, "response.output_text.delta");
    }

    #[test]
    fn sse_parse_event_handles_multiline_data() {
        // OpenAI 协议允许 data: 字段跨多行，parser 需要把多行 data 按 \n 拼接后再解析。
        // 这里构造一个跨 3 行的 JSON：拼接后是合法的 `{\n"type":"x"\n}`。
        let block = b"data: {\ndata: \"type\":\"x\"\ndata: }\n";
        let parsed = parse_sse_event(block).expect("should parse");
        assert!(parsed.data.is_object());
        assert_eq!(parsed.event_type, "x");
    }

    #[test]
    fn sse_parse_event_done_sentinel() {
        let block = b"data: [DONE]\n";
        let parsed = parse_sse_event(block).expect("should parse [DONE]");
        assert_eq!(parsed.event_type, "[done]");
        assert!(parsed.data.is_null());
    }

    #[test]
    fn sse_parse_event_returns_none_for_invalid_json() {
        let block = b"data: not json\n";
        assert!(parse_sse_event(block).is_none());
    }

    /// 模拟"网络把 UTF-8 字符 / SSE 事件切到任意位置"的增量解析。
    /// 把完整 buffer 按 chunk_size 切片，逐块喂给 parser，期望解析出所有事件。
    fn drive_sse_parser_incremental(full: &[u8], chunk_size: usize) -> Vec<SseParsedEvent> {
        let mut buffer: Vec<u8> = Vec::new();
        let mut events: Vec<SseParsedEvent> = Vec::new();
        for i in (0..full.len()).step_by(chunk_size) {
            let end = (i + chunk_size).min(full.len());
            buffer.extend_from_slice(&full[i..end]);
            loop {
                let range = match next_sse_event_range(&buffer) {
                    Some(r) => r,
                    None => break,
                };
                let (event_end, total_end) = range;
                let block_bytes: Vec<u8> = buffer.drain(..total_end).collect();
                let block = &block_bytes[..event_end];
                if let Some(parsed) = parse_sse_event(block) {
                    events.push(parsed);
                }
            }
        }
        events
    }

    #[test]
    fn sse_incremental_parser_handles_chunk_split_inside_utf8() {
        // 把一个完整 delta 事件按 7 字节切片 —— chunk 边界可能落在
        // "response.output_text.delta" 中间，也可能落在 UTF-8 多字节字符中间。
        // parser 必须等到完整事件（分隔符之间）才解码，避免半截 UTF-8 序列。
        let full = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"你好\"}\n\n".as_bytes();
        let events = drive_sse_parser_incremental(full, 7);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "response.output_text.delta");
        assert_eq!(
            events[0].data.get("delta").and_then(|v| v.as_str()),
            Some("你好")
        );
    }

    #[test]
    fn sse_incremental_parser_handles_multiple_events_per_chunk() {
        // 一个大 chunk 里包含多个事件 —— 一次循环应该全部取出。
        let full = b"event: response.created\ndata: {\"type\":\"response.created\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\"}\n\n";
        let events = drive_sse_parser_incremental(full, 1024);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_type, "response.created");
        assert_eq!(events[1].event_type, "response.completed");
    }

    #[test]
    fn sse_incremental_parser_handles_crlf_boundaries() {
        let full = b"event: response.created\r\ndata: {\"type\":\"response.created\"}\r\n\r\nevent: response.completed\r\ndata: {\"type\":\"response.completed\"}\r\n\r\n";
        let events = drive_sse_parser_incremental(full, 5);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_type, "response.created");
        assert_eq!(events[1].event_type, "response.completed");
    }

    #[test]
    fn sse_incremental_parser_handles_done_sentinel() {
        let full = b"event: response.completed\ndata: {\"type\":\"response.completed\"}\n\ndata: [DONE]\n\n";
        let events = drive_sse_parser_incremental(full, 3);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_type, "response.completed");
        assert_eq!(events[1].event_type, "[done]");
    }

    #[test]
    fn sse_incremental_parser_handles_split_done_sentinel() {
        // [DONE] 也可能被切到 chunk 边界。parser 必须等到完整事件 block 才解析。
        let full = b"data: [DONE]\n\n";
        let events = drive_sse_parser_incremental(full, 3);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "[done]");
    }

    #[test]
    fn sse_parse_event_extracts_response_failed_payload() {
        // response.failed 事件应该能解析出 response.error 字段，用于 failed 分类。
        let block = b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"message\":\"server error\",\"code\":\"server_error\"}}}\n";
        let parsed = parse_sse_event(block).expect("should parse");
        assert_eq!(parsed.event_type, "response.failed");
        let resp = parsed.data.get("response").expect("response field");
        let (msg, _kind, code, _param) = extract_full_error_parts_from_value(resp);
        assert_eq!(msg.as_deref(), Some("server error"));
        assert_eq!(code.as_deref(), Some("server_error"));
    }

    #[test]
    fn sse_parse_event_extracts_top_level_error_event() {
        // 部分代理在出错时直接发 error 事件，data 里就是 {message/code/type/param}。
        let block =
            b"event: error\ndata: {\"message\":\"stream interrupted\",\"code\":\"server_error\"}\n";
        let parsed = parse_sse_event(block).expect("should parse");
        assert_eq!(parsed.event_type, "error");
        let (msg, _kind, code, _param) = extract_full_error_parts_from_value(&parsed.data);
        assert_eq!(msg.as_deref(), Some("stream interrupted"));
        assert_eq!(code.as_deref(), Some("server_error"));
    }

    // ------------------------------------------------------------------------
    // Responses Recovery Trace —— 默认状态、attempted 标记、文本来源标签
    // ------------------------------------------------------------------------

    #[test]
    fn recovery_trace_default_is_not_attempted() {
        let trace = ResponsesRecoveryTrace::new_not_attempted();
        assert!(!trace.attempted);
        assert!(trace.retrieve_result.is_none());
        assert!(trace.stream_result.is_none());
        assert!(trace.text_source.is_none());
    }

    #[test]
    fn recovery_trace_serializes_skipped_stream_after_retrieve_success() {
        // Retrieve 成功后 stream_result 必须是 "skipped"，让 UI 能区分"未尝试"和"未到达"。
        let trace = ResponsesRecoveryTrace {
            attempted: true,
            retrieve_result: Some("recovered".to_string()),
            stream_result: Some("skipped".to_string()),
            text_source: Some("retrieve:OutputMessageContentText".to_string()),
            provider_output_tokens: Some(544),
            provider_response_id: Some("resp_test".to_string()),
            ..Default::default()
        };
        let json_str = serde_json::to_string(&trace).expect("should serialize");
        assert!(json_str.contains("\"attempted\":true"));
        assert!(json_str.contains("\"retrieve_result\":\"recovered\""));
        assert!(json_str.contains("\"stream_result\":\"skipped\""));
        assert!(json_str.contains("\"provider_output_tokens\":544"));
    }

    // ------------------------------------------------------------------------
    // 端到端 fixture 验证：Primary payload missing 触发 classify 走 payload_missing
    // 分支。Retrieve / Stream 真正的网络调用不在单测范围（需要 mock HTTP server），
    // 但我们能验证状态机入口的判定是正确的。
    // ------------------------------------------------------------------------

    #[test]
    fn classify_path_for_real_packy_runtime_fixture() {
        // 这是从真实运行时日志里直接搬过来的 fixture：
        //   status=completed / error=null / output=[] / usage.output_tokens=544
        // 必须命中 provider_response_payload_missing（而不是 response_text_missing）。
        let body = json!({
            "id": "resp_06dc22afd4bae102016a7db74d462c8198aa8466c0ab1e11dc",
            "object": "response",
            "status": "completed",
            "model": "gpt-5.4",
            "error": null,
            "last_error": null,
            "incomplete_details": null,
            "output": [],
            "text": { "format": { "type": "text" }, "verbosity": "medium" },
            "reasoning": {
                "context": "current_turn",
                "effort": "none",
                "mode": "standard",
                "summary": null
            },
            "choices": null,
            "usage": {
                "input_tokens": 5312,
                "input_tokens_details": {
                    "cache_write_tokens": 0,
                    "cached_tokens": 3840
                },
                "output_tokens": 544,
                "output_tokens_details": {
                    "reasoning_tokens": 0
                },
                "total_tokens": 5856
            }
        });
        let (_text, diag) = diag_for(body.clone());
        assert_eq!(diag.output_tokens, Some(544));
        assert!(diag.response_id.is_some());
        assert!(!diag.has_error);
        // 关键合约：Primary payload missing 必须被识别 —— 否则系统会再次原样 POST，
        // 浪费一次完整推理预算而不提高恢复概率。
        assert!(is_provider_response_payload_missing(200, &body, &diag));
        let (kind, reason) = classify_missing_text(&diag);
        assert_eq!(kind, "provider_response_payload_missing");
        assert!(reason.contains("544"));
    }

    // ===== V4.0.7 视觉理解任务状态机 =====

    fn vision_task(status: &str) -> Task {
        Task {
            id: "vt-1".to_string(),
            prompt: "分析参考图并生成复刻方案".to_string(),
            negative_prompt: String::new(),
            user_prompt_raw: "分析参考图".to_string(),
            final_prompt: String::new(),
            final_negative_prompt: String::new(),
            prompt_optimized: false,
            prompt_optimization: None,
            agent_intent: String::new(),
            task_source: "manual".to_string(),
            size: "1024x1024".to_string(),
            quality: "auto".to_string(),
            output_format: "png".to_string(),
            count: 1,
            status: status.to_string(),
            created_at: "2026-01-01T00:00:00".to_string(),
            started_at: None,
            completed_at: None,
            output_dir: String::new(),
            success_count: 0,
            failed_count: 0,
            sub_tasks: vec![SubTask {
                index: 0,
                status: "pending".to_string(),
                image_id: None,
                error: None,
                label: Some("视觉分析".to_string()),
                retry_count: 0,
                attempt_errors: Vec::new(),
                error_detail: None,
                attempt_details: Vec::new(),
                executed_prompt: None,
            }],
            task_type: "vision_understanding".to_string(),
            source_images: vec!["D:/ref.jpg".to_string()],
            mask_image: None,
            execution_mode: "single".to_string(),
            batch_strategy: String::new(),
            task_plan_summary: String::new(),
            batch_items: Vec::new(),
            composite_layout: None,
            subject_entities: Vec::new(),
            source_task_id: None,
            source_task_kind: String::new(),
            stage_note: String::new(),
            source_app: String::new(),
            source_request_id: String::new(),
            source_context: None,
            pose_batch: None,
            provenance: None,
            execution_snapshot: None,
        }
    }

    #[test]
    fn vision_update_rejects_non_vision_task() {
        let mut task = vision_task("pending");
        task.task_type = "generate".to_string();
        assert!(apply_vision_task_update(&mut task, "running", "", "", "").is_err());
    }

    #[test]
    fn vision_update_running_sets_started_at_and_stage() {
        let mut task = vision_task("pending");
        apply_vision_task_update(&mut task, "running", "正在分析参考图片…", "分析中", "")
            .expect("pending -> running must succeed");
        assert_eq!(task.status, "running");
        assert!(task.started_at.is_some());
        assert_eq!(task.stage_note, "正在分析参考图片…");
        assert_eq!(task.task_plan_summary, "分析中");
    }

    #[test]
    fn vision_update_completed_finalizes_subtask_and_counts() {
        let mut task = vision_task("running");
        apply_vision_task_update(
            &mut task,
            "completed",
            "视觉理解完成",
            "已分析参考图：篮球运动员上篮 · 模型 GLM-5V-Turbo",
            "",
        )
        .expect("running -> completed must succeed");
        assert_eq!(task.status, "completed");
        assert_eq!(task.sub_tasks[0].status, "completed");
        assert_eq!(task.success_count, 1);
        assert_eq!(task.failed_count, 0);
        assert!(task.completed_at.is_some());
        assert!(task.task_plan_summary.contains("篮球运动员"));
    }

    #[test]
    fn vision_update_failed_records_error_on_subtask() {
        let mut task = vision_task("running");
        apply_vision_task_update(&mut task, "failed", "", "", "视觉理解失败，请重试或更换视觉模型。")
            .expect("running -> failed must succeed");
        assert_eq!(task.status, "failed");
        assert_eq!(task.sub_tasks[0].status, "failed");
        assert_eq!(
            task.sub_tasks[0].error.as_deref(),
            Some("视觉理解失败，请重试或更换视觉模型。")
        );
        assert_eq!(task.failed_count, 1);
    }

    #[test]
    fn vision_update_rejects_terminal_and_invalid_status() {
        let mut done = vision_task("completed");
        assert!(apply_vision_task_update(&mut done, "running", "", "", "").is_err());
        let mut task = vision_task("pending");
        assert!(apply_vision_task_update(&mut task, "generating", "", "", "").is_err());
        assert_eq!(task.status, "pending", "非法状态不得部分写入");
    }

    #[test]
    fn vision_update_cancelled_from_pending() {
        let mut task = vision_task("pending");
        apply_vision_task_update(&mut task, "cancelled", "已取消", "", "")
            .expect("pending -> cancelled must succeed");
        assert_eq!(task.status, "cancelled");
        assert_eq!(task.sub_tasks[0].status, "cancelled");
    }
}
