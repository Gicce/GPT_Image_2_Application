use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::models::{
    AgentStyleTemplate, AgentTaskTemplate, AgentTemplateDraftCurrentTemplate, AgentTemplateDraftExpectedOutput,
    AgentTemplateDraftPayload, AgentTemplateDraftRequirements, AgentTemplateExportPayload, AgentTemplateImportPayload,
    AgentTemplateLog, ChatConversation, CreateTaskParams, ImageRecord, Settings, SubTask, Task,
};
use crate::storage;

static HTTP_CLIENT: once_cell::sync::Lazy<reqwest::Client> = once_cell::sync::Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .use_native_tls()
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
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
}

fn normalize_agent_base_url(base_url: &str) -> String {
    let mut base = base_url.trim().trim_end_matches('/').to_string();
    if !base.ends_with("/v1") {
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
    let detail = value
        .get("error")
        .and_then(|v| v.get("message"))
        .and_then(|v| v.as_str())
        .or_else(|| value.get("detail").and_then(|v| v.as_str()))
        .or_else(|| value.get("message").and_then(|v| v.as_str()))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let code = value
        .get("code")
        .and_then(|v| v.as_str())
        .or_else(|| value.get("error").and_then(|v| v.get("code")).and_then(|v| v.as_str()))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    (detail, code)
}

fn build_responses_api_error(status: u16, body: &serde_json::Value, fallback: &str) -> AgentEndpointStatus {
    let (detail, code) = extract_error_parts_from_value(body);
    let kind = classify_upstream_error(status, detail.as_deref(), code.as_deref());
    let message = build_upstream_error_message(fallback, status, &kind, detail.as_deref(), code.as_deref());
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
            if matches!(map.get("type").and_then(|v| v.as_str()), Some("output_text")) {
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

fn extract_responses_output_text(value: &serde_json::Value) -> Option<String> {
    let mut parts = Vec::new();
    collect_response_output_text(value, &mut parts);
    let joined = parts.join("\n").trim().to_string();
    if joined.is_empty() { None } else { Some(joined) }
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
    let body = response.json::<serde_json::Value>().await.unwrap_or_else(|_| json!({}));
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

    if message_contains_any(&lower, &["must contain the word 'json'", "must contain the word json", "json_object"]) {
        return "json_output_unsupported".to_string();
    }
    if message_contains_any(&lower, &["image_url", "input_image", "multimodal", "vision", "content[", "messages[", "array of content parts", "unsupported content"]) {
        return "multimodal_unsupported".to_string();
    }
    if message_contains_any(&lower, &["does not exist", "unknown model", "unsupported model", "model not found", "access to model", "no permission"]) ||
        message_contains_any(&code_lower, &["model_not_found", "invalid_model", "unsupported_model"])
    {
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

fn build_upstream_error_message(prefix: &str, status: u16, kind: &str, detail: Option<&str>, code: Option<&str>) -> String {
    let mut message = match kind {
        "json_output_unsupported" => "模型可以对话，但不稳定遵循 JSON 输出要求".to_string(),
        "multimodal_unsupported" => "当前代理支持基础对话，但不兼容聊天链路中的图片或多段 content 消息格式".to_string(),
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
        if !code_value.is_empty() && !message.contains(code_value) && !code_value.eq_ignore_ascii_case("openai_error") {
            message.push_str(&format!(" [code: {code_value}]"));
        }
    }
    message.push_str(&format!(" (HTTP {status})"));
    message
}

fn format_upstream_message(prefix: &str, status: u16, value: &serde_json::Value) -> (String, String) {
    let (detail, code) = extract_error_parts_from_value(value);
    let kind = classify_upstream_error(status, detail.as_deref(), code.as_deref());
    let message = build_upstream_error_message(prefix, status, &kind, detail.as_deref(), code.as_deref());
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
                    return response
                        .json::<serde_json::Value>()
                        .await
                        .map_err(|_| AgentEndpointStatus {
                            ok: false,
                            kind: Some("invalid_response".to_string()),
                            message: "服务返回了无效响应".to_string(),
                            status: Some(status),
                        });
                }

                let body = response.json::<serde_json::Value>().await.unwrap_or_else(|_| json!({}));
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

fn local_endpoint_status(ok: bool, message: &str) -> AgentEndpointStatus {
    AgentEndpointStatus {
        ok,
        kind: if ok { None } else { Some("invalid_response".to_string()) },
        message: message.to_string(),
        status: None,
    }
}

fn extract_json_object_text(content: &str) -> Option<String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return None;
    }

    let candidate = if trimmed.starts_with("```") {
        let lines: Vec<&str> = trimmed.lines().collect();
        if lines.len() >= 3 {
            lines[1..lines.len() - 1].join("\n")
        } else {
            trimmed.to_string()
        }
    } else {
        trimmed.to_string()
    };

    let normalized = candidate.trim();
    if normalized.starts_with('{') && normalized.ends_with('}') {
        return Some(normalized.to_string());
    }

    let start = normalized.find('{')?;
    let end = normalized.rfind('}')?;
    if end > start {
        Some(normalized[start..=end].to_string())
    } else {
        None
    }
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
    let Ok(entries) = fs::read_dir(dir) else { return; };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_image_files(&path, output);
        } else if is_supported_image(&path) {
            output.push(path);
        }
    }
}

fn classify_source_kind(path: &Path, settings: &Settings) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if !settings.library_input_dir.trim().is_empty() {
        let input_dir = settings.library_input_dir.replace('\\', "/");
        if normalized.starts_with(&input_dir) {
            return "library_input".to_string();
        }
    }
    if !settings.default_output_dir.trim().is_empty() {
        let output_dir = settings.default_output_dir.replace('\\', "/");
        if normalized.starts_with(&output_dir) {
            if normalized.contains("/chat/") {
                return "chat".to_string();
            }
            if normalized.contains("/transparent/") {
                return "postprocess".to_string();
            }
            return "output".to_string();
        }
    }
    "output".to_string()
}

fn sync_images(app: &tauri::AppHandle) -> Vec<ImageRecord> {
    let settings: Settings = storage::read_json(&storage::settings_path(app), Settings::default());
    let now = chrono::Local::now().to_rfc3339();
    let mut discovered_paths = Vec::new();

    if !settings.library_input_dir.trim().is_empty() {
        collect_image_files(Path::new(&settings.library_input_dir), &mut discovered_paths);
    }
    if !settings.default_output_dir.trim().is_empty() {
        collect_image_files(Path::new(&settings.default_output_dir), &mut discovered_paths);
    }

    let discovered_set: HashSet<String> = discovered_paths
        .iter()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .collect();

    storage::with_images(app, |images| {
        let mut by_path: HashMap<String, usize> = HashMap::new();
        for (index, image) in images.iter_mut().enumerate() {
            image.missing = !Path::new(&image.local_path).exists();
            if !image.missing {
                image.last_seen_at = Some(now.clone());
            }
            if image.source_kind.trim().is_empty() {
                image.source_kind = classify_source_kind(Path::new(&image.local_path), &settings);
            }
            by_path.insert(image.local_path.clone(), index);
        }

        for path in discovered_paths {
            let normalized = path.to_string_lossy().replace('\\', "/");
            if let Some(index) = by_path.get(&normalized).copied() {
                let image = &mut images[index];
                image.missing = false;
                image.last_seen_at = Some(now.clone());
                image.file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or(&image.file_name).to_string();
                image.source_kind = classify_source_kind(&path, &settings);
            } else {
                let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("image").to_string();
                let created_at = fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .ok()
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
                    description: None,
                    tags: Vec::new(),
                    indexed_at: None,
                });
            }
        }

        for image in images.iter_mut() {
            if !discovered_set.contains(&image.local_path) && (image.source_kind == "library_input" || image.source_kind == "output") {
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
    storage::read_json(&path, Settings::default())
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    let path = storage::settings_path(&app);
    let previous = storage::read_json(&path, Settings::default());
    let should_rescan_images =
        previous.default_output_dir != settings.default_output_dir
        || previous.library_input_dir != settings.library_input_dir;
    storage::write_json(&path, &settings);
    if should_rescan_images {
        let _ = sync_images(&app);
    }
    Ok(())
}

#[tauri::command]
pub async fn run_agent_request(payload: AgentRunPayload) -> Result<AgentRunResult, String> {
    if payload.base_url.trim().is_empty() || payload.token.trim().is_empty() || payload.model.trim().is_empty() {
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
        });
    }

    let body = if payload.mode == "interpret" {
        json!({
            "model": payload.model,
            "messages": [
                {
                    "role": "system",
                    "content": "你是图片任务编排智能体。请理解用户输入和附件摘要，并且仅以合法 JSON 输出结果。Return valid JSON only. 不要输出 markdown，不要输出额外解释，不要输出代码块。输出字段必须且只能包含：{\"intent\":\"chat|gallery_search|image_understanding|image_generate|image_edit|remove_background|upscale\",\"confidence\":0-1,\"needs_clarification\":true|false,\"clarification_question\":\"...\",\"recommended_action\":\"...\",\"should_propose_execution\":true|false,\"final_prompt\":\"...\",\"final_negative_prompt\":\"...\",\"api_kind\":\"generation|edit|remove_background|upscale\"}。规则：图库查询优先于生图；有图片且用户要求修改图片时，优先判断为 image_edit 或 remove_background；不确定时 needs_clarification=true；请确保输出为合法 JSON 对象。"
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
            "temperature": 0.1,
            "max_tokens": 900
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
                            part.text.map(|text| json!({ "type": "text", "text": text }))
                        } else if part.part_type == "image_url" {
                            part.image_url.map(|url| json!({ "type": "image_url", "image_url": { "url": url } }))
                        } else {
                            None
                        }
                    })
                    .collect();
                messages.push(json!({ "role": message.role, "content": content }));
            } else {
                messages.push(json!({ "role": message.role, "content": message.content.unwrap_or_default() }));
            }
        }
        json!({
            "model": payload.model,
            "messages": messages,
            "max_tokens": 4096
        })
    };

    match post_chat_completions(&payload.base_url, &payload.token, body).await {
        Ok(value) => {
            if payload.mode == "interpret" {
                let content = value
                    .get("choices")
                    .and_then(|v| v.get(0))
                    .and_then(|v| v.get("message"))
                    .and_then(|v| v.get("content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let json_text = extract_json_object_text(&content).unwrap_or(content);
                let parsed: serde_json::Value = match serde_json::from_str::<serde_json::Value>(&json_text) {
                    Ok(value) if value.is_object() => value,
                    _ => {
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
                            error_kind: Some("invalid_response".to_string()),
                            error_message: Some("Agent 理解接口返回的内容不是合法 JSON，请检查模型兼容性".to_string()),
                            status: None,
                            used_local_fallback: Some(false),
                        });
                    }
                };
                return Ok(AgentRunResult {
                    ok: true,
                    intent: parsed.get("intent").and_then(|v| v.as_str()).map(str::to_string),
                    confidence: parsed.get("confidence").and_then(|v| v.as_f64()),
                    needs_clarification: parsed.get("needs_clarification").and_then(|v| v.as_bool()),
                    clarification_question: parsed.get("clarification_question").and_then(|v| v.as_str()).map(str::to_string),
                    recommended_action: parsed.get("recommended_action").and_then(|v| v.as_str()).map(str::to_string),
                    should_propose_execution: parsed.get("should_propose_execution").and_then(|v| v.as_bool()),
                    final_prompt: parsed.get("final_prompt").and_then(|v| v.as_str()).map(str::to_string),
                    final_negative_prompt: parsed.get("final_negative_prompt").and_then(|v| v.as_str()).map(str::to_string),
                    api_kind: parsed.get("api_kind").and_then(|v| v.as_str()).map(str::to_string),
                    reply: None,
                    reasoning: None,
                    prompt_tokens: value.get("usage").and_then(|v| v.get("prompt_tokens")).and_then(|v| v.as_u64()).map(|v| v as u32),
                    completion_tokens: value.get("usage").and_then(|v| v.get("completion_tokens")).and_then(|v| v.as_u64()).map(|v| v as u32),
                    error_kind: None,
                    error_message: None,
                    status: None,
                    used_local_fallback: Some(false),
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
                prompt_tokens: value.get("usage").and_then(|v| v.get("prompt_tokens")).and_then(|v| v.as_u64()).map(|v| v as u32),
                completion_tokens: value.get("usage").and_then(|v| v.get("completion_tokens")).and_then(|v| v.as_u64()).map(|v| v as u32),
                error_kind: None,
                error_message: None,
                status: None,
                used_local_fallback: Some(false),
            })
        }
        Err(error) => Ok(AgentRunResult {
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
            error_kind: error.kind,
            error_message: Some(error.message),
            status: error.status,
            used_local_fallback: Some(false),
        }),
    }
}

#[tauri::command]
pub async fn understand_chat_images(
    app: tauri::AppHandle,
    payload: VisionUnderstandPayload,
) -> Result<VisionUnderstandResult, String> {
    let settings: Settings = storage::read_json(&storage::settings_path(&app), Settings::default());
    let token = settings.token.trim().to_string();
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

    if agent_base_url.trim().is_empty() || agent_model.trim().is_empty() || agent_token.trim().is_empty() {
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
            message: "带 system prompt 的聊天请求依赖基础对话接口，当前未通过基础对话检测".to_string(),
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
            message: "Agent 理解接口依赖带 system prompt 的聊天请求，当前未通过该项检测".to_string(),
            status: chat_with_system.status,
        }
    };

    Ok(AgentEndpointCheckResult { chat, chat_with_system, chat_multimodal, official_vision, interpret, generation, edit })
}

// ========== Agent templates ==========

#[tauri::command]
pub fn get_agent_task_templates(app: tauri::AppHandle) -> Result<Vec<AgentTaskTemplate>, String> {
    storage::get_agent_task_templates(&app)
}

#[tauri::command]
pub fn save_agent_task_template(app: tauri::AppHandle, template: AgentTaskTemplate) -> Result<AgentTaskTemplate, String> {
    storage::save_agent_task_template(&app, template)
}

#[tauri::command]
pub fn delete_agent_task_template(app: tauri::AppHandle, id: String) -> Result<(), String> {
    storage::delete_agent_task_template(&app, &id)
}

#[tauri::command]
pub fn toggle_agent_task_template(app: tauri::AppHandle, id: String, enabled: bool) -> Result<(), String> {
    storage::toggle_agent_task_template(&app, &id, enabled)
}

#[tauri::command]
pub fn get_agent_style_templates(app: tauri::AppHandle) -> Result<Vec<AgentStyleTemplate>, String> {
    storage::get_agent_style_templates(&app)
}

#[tauri::command]
pub fn save_agent_style_template(app: tauri::AppHandle, template: AgentStyleTemplate) -> Result<AgentStyleTemplate, String> {
    storage::save_agent_style_template(&app, template)
}

#[tauri::command]
pub fn delete_agent_style_template(app: tauri::AppHandle, id: String) -> Result<(), String> {
    storage::delete_agent_style_template(&app, &id)
}

#[tauri::command]
pub fn toggle_agent_style_template(app: tauri::AppHandle, id: String, enabled: bool) -> Result<(), String> {
    storage::toggle_agent_style_template(&app, &id, enabled)
}

#[tauri::command]
pub fn get_agent_template_logs(app: tauri::AppHandle, limit: Option<usize>) -> Result<Vec<AgentTemplateLog>, String> {
    storage::get_agent_template_logs(&app, limit)
}

#[tauri::command]
pub fn append_agent_template_log(app: tauri::AppHandle, log: AgentTemplateLog) -> Result<AgentTemplateLog, String> {
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
            goal: format!("请完善模板“{}”，让它更适合当前图片业务场景。", template.name),
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
                target_use_cases: vec!["图片生成".to_string(), "图片编辑".to_string(), "电商图像场景".to_string()],
                must_keep: vec!["任务识别准确".to_string(), "提示词可执行".to_string()],
                should_improve: vec!["提示词完整度".to_string(), "负面提示词质量".to_string(), "推荐执行说明".to_string()],
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
        goal: format!("请完善风格模板“{}”，让它更适合当前图片业务场景。", template.name),
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
            should_improve: vec!["风格片段质量".to_string(), "负面风格约束".to_string(), "关键词覆盖".to_string()],
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
    let has_design_target = ["详情图", "长图", "海报", "A+图", "a+图", "主图", "说明图", "测量图", "展示图", "客户看", "电商图", "详情页"]
        .iter()
        .any(|keyword| text.contains(keyword));
    if !has_design_target {
        return false;
    }
    let has_model_signal = ["模特", "人物", "穿搭", "上身", "实穿", "展示参考"]
        .iter()
        .any(|keyword| text.contains(keyword));
    let has_product_signal = ["产品", "商品", "衣服", "服装", "单品", "白底图", "产品图", "商品图"]
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

#[tauri::command]
pub fn create_task(app: tauri::AppHandle, params: CreateTaskParams) -> Result<Task, String> {
    if params.prompt.trim().is_empty() {
        return Err("提示词不能为空".to_string());
    }
    if params.output_dir.trim().is_empty() {
        return Err("请选择输出目录".to_string());
    }
    if params.task_type == "edit" && params.source_images.is_empty() {
        return Err("图生图任务必须至少提供一张源图片".to_string());
    }
    let reference_bound_design_text = is_reference_bound_detail_task_text(&format!("{}\n{}", params.user_prompt_raw, params.final_prompt));
    if reference_bound_design_text && params.source_images.len() < 2 {
        return Err("该详情图任务至少需要 2 张参考图：1 张模特图 + 1 张产品白底图".to_string());
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Local::now().to_rfc3339();
    let mut task_type = if params.task_type.is_empty() { "generate".to_string() } else { params.task_type.clone() };
    if reference_bound_design_text && params.source_images.len() >= 2 && task_type == "generate" {
        task_type = "edit".to_string();
    }
    let prompt = params.prompt.clone();
    let negative_prompt = params.negative_prompt.clone();

    let task = Task {
        id,
        prompt: prompt.clone(),
        negative_prompt: negative_prompt.clone(),
        user_prompt_raw: if params.user_prompt_raw.trim().is_empty() { prompt.clone() } else { params.user_prompt_raw },
        final_prompt: if params.final_prompt.trim().is_empty() { prompt.clone() } else { params.final_prompt },
        final_negative_prompt: if params.final_negative_prompt.trim().is_empty() { negative_prompt.clone() } else { params.final_negative_prompt },
        prompt_optimized: params.prompt_optimized,
        agent_intent: params.agent_intent,
        task_source: if params.task_source.trim().is_empty() { "manual".to_string() } else { params.task_source },
        size: params.size,
        quality: params.quality,
        output_format: params.output_format,
        count: params.count,
        status: "pending".to_string(),
        created_at: now,
        output_dir: params.output_dir,
        success_count: 0,
        failed_count: 0,
        task_type,
        source_images: params.source_images.clone(),
        execution_mode: if params.execution_mode.trim().is_empty() { "single".to_string() } else { params.execution_mode.clone() },
        batch_strategy: params.batch_strategy.clone(),
        task_plan_summary: params.task_plan_summary.clone(),
        batch_items: params.batch_items.clone(),
        sub_tasks: (0..params.count)
            .map(|i| SubTask {
                index: i,
                status: "pending".to_string(),
                image_id: None,
                error: None,
                label: params.batch_items.get(i).map(|item| item.label.clone()),
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
    storage::with_tasks(&app, |tasks| {
        if let Some(t) = tasks.iter_mut().find(|t| t.id == task_id) {
            t.status = "cancelled".to_string();
        }
    });
    Ok(())
}

#[tauri::command]
pub fn retry_task(app: tauri::AppHandle, task_id: String) -> Result<Task, String> {
    let new_task = storage::with_tasks(&app, |tasks| {
        let original = tasks
            .iter()
            .find(|t| t.id == task_id)
            .ok_or_else(|| "任务不存在".to_string())?;

        let now = chrono::Local::now().to_rfc3339();
        let mut task_type = if original.task_type.is_empty() { "generate".to_string() } else { original.task_type.clone() };
        let reference_bound_design_text = is_reference_bound_detail_task_text(&format!("{}\n{}", original.user_prompt_raw, original.final_prompt));
        if reference_bound_design_text && original.source_images.len() >= 2 && task_type == "generate" {
            task_type = "edit".to_string();
        }

        let new_task = Task {
            id: uuid::Uuid::new_v4().to_string(),
            prompt: original.prompt.clone(),
            negative_prompt: original.negative_prompt.clone(),
            user_prompt_raw: original.user_prompt_raw.clone(),
            final_prompt: original.final_prompt.clone(),
            final_negative_prompt: original.final_negative_prompt.clone(),
            prompt_optimized: original.prompt_optimized,
            agent_intent: original.agent_intent.clone(),
            task_source: original.task_source.clone(),
            size: original.size.clone(),
            quality: original.quality.clone(),
            output_format: original.output_format.clone(),
            count: original.count,
            status: "pending".to_string(),
            created_at: now,
            output_dir: original.output_dir.clone(),
            success_count: 0,
            failed_count: 0,
            task_type,
            source_images: original.source_images.clone(),
            execution_mode: original.execution_mode.clone(),
            batch_strategy: original.batch_strategy.clone(),
            task_plan_summary: original.task_plan_summary.clone(),
            batch_items: original.batch_items.clone(),
            sub_tasks: (0..original.count)
                .map(|i| SubTask {
                    index: i,
                    status: "pending".to_string(),
                    image_id: None,
                    error: None,
                    label: original.batch_items.get(i).map(|item| item.label.clone()),
                })
                .collect(),
        };
        tasks.push(new_task.clone());
        Ok::<Task, String>(new_task)
    })?;

    Ok(new_task)
}

// ========== Images ==========

#[tauri::command]
pub fn read_thumbnail(app: tauri::AppHandle, path: String) -> Result<String, String> {
    if !Path::new(&path).exists() {
        return Err("文件已移动或不存在".to_string());
    }
    let cache_dir = storage::data_dir(&app).join("thumbs");
    fs::create_dir_all(&cache_dir).ok();

    let path_hash = format!("{:x}", md5::compute(&path));
    let _ext = Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("png");
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
    thumb.write_to(&mut buf, image::ImageFormat::Jpeg).map_err(|e| format!("编码缩略图失败: {}", e))?;
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
pub fn delete_task(app: tauri::AppHandle, task_id: String, delete_images: bool) -> Result<(), String> {
    // Collect image IDs from sub-tasks before removing the task
    let image_ids: Vec<String> = {
        let tasks: Vec<Task> = storage::read_json(&storage::tasks_path(&app), Vec::new());
        tasks.iter()
            .find(|t| t.id == task_id)
            .map(|t| t.sub_tasks.iter().filter_map(|s| s.image_id.clone()).collect())
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

#[tauri::command]
pub async fn select_directory(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let dir = app.dialog().file().blocking_pick_folder();
    dir.map(|p| p.to_string())
}

#[tauri::command]
pub async fn select_image_file(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let file = app.dialog()
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
    let file = app.dialog()
        .file()
        .add_filter("Text Files", &[
            "txt", "md", "json", "csv", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "log",
            "py", "js", "ts", "tsx", "jsx", "html", "css", "scss", "less",
            "java", "c", "cpp", "h", "hpp", "cs", "go", "rs", "rb", "php", "sh", "bat", "ps1",
            "sql", "graphql", "vue", "svelte",
        ])
        .set_title("选择文本文件")
        .blocking_pick_file();
    match file {
        Some(path) => {
            let path_str = path.to_string();
            let p = Path::new(&path_str);
            let name = p.file_name()
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
                        Some(TextFileResult { name, content, size })
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
pub async fn save_image_as(app: tauri::AppHandle, b64_data: String, default_name: String) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog().file()
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

// ========== Conversations ==========

#[tauri::command]
pub fn get_conversations(app: tauri::AppHandle) -> Vec<ChatConversation> {
    let path = storage::conversations_path(&app);
    storage::read_json(&path, Vec::new())
}

#[tauri::command]
pub fn save_conversations(app: tauri::AppHandle, conversations: Vec<ChatConversation>) -> Result<(), String> {
    let path = storage::conversations_path(&app);
    storage::write_json(&path, &conversations);
    Ok(())
}

#[tauri::command]
pub fn save_conversation(app: tauri::AppHandle, conversation: ChatConversation) -> Result<(), String> {
    let path = storage::conversations_path(&app);
    let mut conversations: Vec<ChatConversation> = storage::read_json(&path, Vec::new());

    if let Some(existing) = conversations.iter_mut().find(|item| item.id == conversation.id) {
        *existing = conversation;
    } else {
        conversations.insert(0, conversation);
    }

    storage::write_json(&path, &conversations);
    Ok(())
}

// ========== Chat Image Save ==========

#[tauri::command]
pub fn save_chat_image(app: tauri::AppHandle, b64_data: String, conversation_id: String) -> Result<ImageRecord, String> {
    let settings: Settings = storage::read_json(&storage::settings_path(&app), Settings::default());
    let output_dir = if settings.default_output_dir.is_empty() {
        dirs::desktop_dir().unwrap_or_else(|| std::path::PathBuf::from(".")).to_string_lossy().to_string()
    } else {
        settings.default_output_dir.clone()
    };

    let chat_dir = Path::new(&output_dir).join("chat");
    fs::create_dir_all(&chat_dir).ok();

    let b64_clean = b64_data.split(',').last().unwrap_or(&b64_data);
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64_clean)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    let now = chrono::Local::now();
    let id_short = if conversation_id.len() >= 8 { &conversation_id[..8] } else { &conversation_id };
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
pub async fn remove_background(app: tauri::AppHandle, image_path: String) -> Result<ImageRecord, String> {
    let settings: Settings = storage::read_json(&storage::settings_path(&app), Settings::default());
    if settings.removebg_api_key.trim().is_empty() {
        return Err("请先在设置中配置 remove.bg API Key".to_string());
    }

    let path = Path::new(&image_path);
    if !path.exists() {
        return Err(format!("源图片不存在: {}", image_path));
    }

    let bytes = fs::read(path).map_err(|e| format!("读取源图片失败: {}", e))?;
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("image.png").to_string();
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
        dirs::desktop_dir().unwrap_or_else(|| std::path::PathBuf::from(".")).to_string_lossy().to_string()
    } else {
        settings.default_output_dir.clone()
    };
    let transparent_dir = Path::new(&output_dir).join("transparent");
    fs::create_dir_all(&transparent_dir).map_err(|e| format!("创建透明图目录失败: {}", e))?;

    let now = chrono::Local::now();
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let filename = format!("{}_transparent_{}.png", stem, now.format("%Y%m%d_%H%M%S"));
    let filepath = transparent_dir.join(&filename);
    let image_bytes = resp.bytes().await.map_err(|e| format!("读取 remove.bg 响应失败: {}", e))?;
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

            if !line.starts_with("data: ") { continue; }
            let payload = line[6..].trim();
            if payload == "[DONE]" { continue; }

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
    prompt: String,
    model: String,
) -> Result<String, String> {
    let settings: Settings = storage::read_json(&storage::settings_path(&app), Settings::default());
    let token = settings.token.clone();
    if token.is_empty() {
        return Err("请先在设置页面配置图片生成 API Token".to_string());
    }

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

    let resp = client
        .post("https://www.packyapi.com/v1/responses")
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
    image_path: String,
    prompt: String,
    model: String,
) -> Result<String, String> {
    let settings: Settings = storage::read_json(&storage::settings_path(&app), Settings::default());
    let token = settings.token.clone();
    if token.is_empty() {
        return Err("请先在设置页面配置图片生成 API Token".to_string());
    }

    let path = Path::new(&image_path);
    if !path.exists() {
        return Err(format!("源图片不存在: {}", image_path));
    }

    let file_bytes = fs::read(path)
        .map_err(|e| format!("无法读取源图片: {}", e))?;
    let mime = crate::task_runner::mime_for_path(path);
    let b64_encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &file_bytes);
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

    let resp = client
        .post("https://www.packyapi.com/v1/responses")
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

    let data: Vec<serde_json::Value> = resp.json().await
        .map_err(|e| format!("瑙ｆ瀽澶辫触: {}", e))?;

    let releases = data.into_iter().take(3).map(|r| {
        let tag = r["tag_name"].as_str().unwrap_or("").to_string();
        let version = tag.trim_start_matches("app-v").trim_start_matches('v').to_string();
        let date: String = r["published_at"].as_str().unwrap_or("").chars().take(10).collect();
        let notes = r["body"].as_str().unwrap_or("").to_string();
        ReleaseNote { version, date, notes }
    }).collect();

    Ok(releases)
}

