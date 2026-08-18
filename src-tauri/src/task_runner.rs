use std::fs;
use std::path::Path;

use tauri::{AppHandle, Emitter, Manager};

use crate::models::{ImageRecord, RuntimeAuthConfig, Task};
use crate::reconciliation::{fail_task_in_place, finalize_task_in_place};
use crate::storage;
use crate::RuntimeAuthState;

#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
struct ApiRequestBody {
    model: String,
    prompt: String,
    size: String,
    quality: String,
    output_format: String,
    response_format: String,
    n: u32,
}

#[derive(Debug, serde::Deserialize)]
struct ApiResponseImage {
    b64_json: Option<String>,
    #[allow(dead_code)]
    url: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct ApiResponse {
    data: Vec<ApiResponseImage>,
}

fn extract_error_parts(text: &str) -> (Option<String>, Option<String>) {
    let parsed = serde_json::from_str::<serde_json::Value>(text).ok();
    if let Some(value) = parsed {
        let detail = value
            .get("detail")
            .and_then(|v| v.as_str())
            .or_else(|| value.get("message").and_then(|v| v.as_str()))
            .or_else(|| {
                value
                    .get("error")
                    .and_then(|v| v.get("message"))
                    .and_then(|v| v.as_str())
            })
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string);
        let code = value
            .get("code")
            .and_then(|v| v.as_str())
            .or_else(|| {
                value
                    .get("error")
                    .and_then(|v| v.get("code"))
                    .and_then(|v| v.as_str())
            })
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string);
        return (detail, code);
    }

    let trimmed = text.trim();
    if trimmed.is_empty() {
        (None, None)
    } else {
        (Some(trimmed.to_string()), None)
    }
}

fn format_upstream_image_error(status: reqwest::StatusCode, text: &str) -> String {
    let (detail, code) = extract_error_parts(text);
    let primary = detail
        .clone()
        .or_else(|| code.clone())
        .unwrap_or_else(|| "上游图片接口失败".to_string());
    let mut message = if primary == "openai_error" {
        "上游图片接口失败：openai_error".to_string()
    } else if primary.starts_with("上游图片接口失败") {
        primary
    } else {
        format!("上游图片接口失败：{primary}")
    };
    if let Some(code_value) = code {
        if !message.contains(&code_value) {
            message.push_str(&format!(" [code: {code_value}]"));
        }
    }
    message.push_str(&format!(" (HTTP {})", status.as_u16()));
    message
}

/// Translate a reqwest send error into a friendly, classified message for the task queue.
/// We do NOT expose the Authorization header or token value here — only network/HTTP signals.
fn format_send_error(err: &reqwest::Error, url: &str) -> String {
    let kind = if err.is_timeout() {
        "timeout"
    } else if err.is_connect() {
        "connect"
    } else if err.is_request() {
        "request"
    } else {
        "network"
    };
    let hint = match kind {
        "timeout" => "请求超时。请前往“设置 → 一键检查运行环境”确认代理可达、或适当调低尺寸/质量后重试。",
        "connect" => "无法建立连接。请检查 Windows 系统代理（如 127.0.0.1:7897）是否启用且可达，前往“设置 → 一键检查运行环境”可一键诊断。",
        "request" => "请求在客户端被拒绝，请前往“设置 → 一键检查运行环境”查看详情。",
        _ => "网络异常，请检查代理与本地网络后重试。",
    };
    format!("图片服务连接失败（{kind}）：{hint} [endpoint: {url}]")
}

/// Read runtime auth config from memory (never persisted).
/// Returns a snapshot; if the mutex is poisoned, returns default (empty).
fn read_runtime_config(app: &AppHandle) -> RuntimeAuthConfig {
    if let Some(state) = app.try_state::<RuntimeAuthState>() {
        if let Ok(guard) = state.config.lock() {
            return guard.clone();
        }
    }
    RuntimeAuthConfig::default()
}

/// Resolve image token: prefer runtime memory, fallback to settings.token.
fn resolve_image_token(runtime: &RuntimeAuthConfig, settings_token: &str) -> String {
    let rt = runtime.image_token.trim().to_string();
    if !rt.is_empty() {
        rt
    } else {
        settings_token.trim().to_string()
    }
}

/// Resolve image base_url: prefer runtime memory, fallback to default.
fn resolve_image_base_url(runtime: &RuntimeAuthConfig) -> String {
    let rt = runtime.image_base_url.trim().to_string();
    if rt.is_empty() {
        "https://www.packyapi.com".to_string()
    } else {
        rt.trim_end_matches('/').to_string()
    }
}

fn effective_prompt(task: &Task, index: usize) -> String {
    if let Some(item) = task.batch_items.get(index) {
        let override_prompt = item.prompt_override.trim();
        if !override_prompt.is_empty() {
            return override_prompt.to_string();
        }
    }
    let base = if task.final_prompt.is_empty() {
        task.prompt.clone()
    } else {
        task.final_prompt.clone()
    };
    if let Some(item) = task.batch_items.get(index) {
        let delta = item.prompt_delta.trim();
        if !delta.is_empty() {
            return format!("{base}\n{delta}");
        }
    }
    base
}

/// 子任务级负面提示词：batch_items[i].negative_override 优先，回落任务级字段。
fn effective_negative_prompt(task: &Task, index: usize) -> String {
    if let Some(item) = task.batch_items.get(index) {
        let override_negative = item.negative_override.trim();
        if !override_negative.is_empty() {
            return override_negative.to_string();
        }
    }
    if !task.final_negative_prompt.trim().is_empty() {
        task.final_negative_prompt.trim().to_string()
    } else {
        task.negative_prompt.trim().to_string()
    }
}

/// 子任务级图片描述：批量方案任务（batch_items 带 label，例如「方案 1 · 红黑重甲 · 长枪 · 古城墙」）
/// 写入 ImageRecord.description，图库卡片优先展示方案标题而非整段 Prompt。
fn batch_item_description(task: &Task, index: usize) -> Option<String> {
    let label = task
        .batch_items
        .get(index)
        .map(|item| item.label.trim())
        .unwrap_or("");
    if label.is_empty() {
        None
    } else {
        Some(label.to_string())
    }
}

/// gpt-image-2 走 OpenAI Images API，没有独立的 negative_prompt 参数；
/// 负面提示词在适配层（这里）组合进最终指令，UI 不感知 Provider 差异。
fn compose_model_instruction(positive: &str, negative: &str) -> String {
    let negative = negative.trim();
    if negative.is_empty() {
        return positive.trim().to_string();
    }
    format!(
        "{}\n\n画面中严格避免出现以下内容：{}",
        positive.trim(),
        negative
    )
}

fn effective_source_images(task: &Task, index: usize) -> Vec<String> {
    if let Some(item) = task.batch_items.get(index) {
        if !item.source_images.is_empty() {
            return item.source_images.clone();
        }
    }
    if task.execution_mode == "batch" && task.batch_strategy == "multi_input" {
        if let Some(source) = task.source_images.get(index) {
            return vec![source.clone()];
        }
    }
    task.source_images.clone()
}

pub async fn process_next_task(app: &AppHandle) {
    // Find a pending task
    let task_opt = storage::with_tasks(app, |tasks| {
        tasks.iter().find(|t| t.status == "pending").cloned()
    });

    let task = match task_opt {
        Some(t) => t,
        None => return,
    };

    // Mark as running
    storage::with_tasks(app, |tasks| {
        if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
            t.status = "running".to_string();
            if t.started_at.is_none() {
                t.started_at = Some(chrono::Local::now().to_rfc3339());
            }
        }
    });

    let _ = app.emit("task-updated", &task.id);

    // Get token: prefer runtime memory token, fallback to settings.token
    let settings_path = storage::settings_path(app);
    let settings: crate::models::Settings = storage::read_json(&settings_path, Default::default());
    let runtime_config = read_runtime_config(app);
    let token = resolve_image_token(&runtime_config, &settings.token);
    let image_base_url = resolve_image_base_url(&runtime_config);
    let requires_openai_token = task.task_type != "remove_background";

    if requires_openai_token && token.is_empty() {
        storage::with_tasks(app, |tasks| {
            if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
                fail_task_in_place(t, "API Token 未设置");
            }
        });
        let _ = app.emit("task-updated", &task.id);
        return;
    }

    // Ensure output directory exists
    let output_dir = task.output_dir.clone();
    if !Path::new(&output_dir).exists() {
        if fs::create_dir_all(&output_dir).is_err() {
            storage::with_tasks(app, |tasks| {
                if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
                    fail_task_in_place(t, "无法创建输出目录");
                }
            });
            let _ = app.emit("task-updated", &task.id);
            return;
        }
    }

    let client = {
        let mut builder = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .connect_timeout(std::time::Duration::from_secs(30))
            .use_native_tls();
        if let Some(proxy_url) = crate::commands::read_windows_system_proxy() {
            if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
                builder = builder.proxy(proxy);
            }
        }
        builder.build().unwrap_or_else(|_| reqwest::Client::new())
    };

    let mut success_count = 0usize;
    let mut failed_count = 0usize;
    let total = task.count;
    let mut was_cancelled = false;

    for i in 0..total {
        // Check if cancelled
        let cancelled = storage::with_tasks(app, |tasks| {
            tasks
                .iter()
                .find(|t| t.id == task.id)
                .map(|t| t.status == "cancelled")
                .unwrap_or(false)
        });

        if cancelled {
            was_cancelled = true;
            break;
        }

        // Update sub-task to running
        storage::with_tasks(app, |tasks| {
            if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
                if i < t.sub_tasks.len() {
                    t.sub_tasks[i].status = "running".to_string();
                }
            }
        });
        let _ = app.emit("task-updated", &task.id);

        let result = if task.task_type == "remove_background" {
            remove_background_single_image(&settings, &task, i).await
        } else if task.task_type == "edit" {
            edit_single_image(&client, &token, &image_base_url, &task, i).await
        } else {
            generate_single_image(&client, &token, &image_base_url, &task, i).await
        };

        match result {
            Ok(image_record) => {
                success_count += 1;
                storage::with_tasks(app, |tasks| {
                    if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
                        if i < t.sub_tasks.len() {
                            t.sub_tasks[i].status = "completed".to_string();
                            t.sub_tasks[i].image_id = Some(image_record.id.clone());
                            t.sub_tasks[i].error = None;
                        }
                        t.success_count = success_count;
                    }
                });
                storage::with_images(app, |images| {
                    images.push(image_record);
                });
            }
            Err(e) => {
                failed_count += 1;
                storage::with_tasks(app, |tasks| {
                    if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
                        if i < t.sub_tasks.len() {
                            t.sub_tasks[i].status = "failed".to_string();
                            t.sub_tasks[i].error = Some(e.clone());
                        }
                        t.failed_count = failed_count;
                    }
                });
            }
        }

        let _ = app.emit("task-updated", &task.id);
    }

    // Finalize task status：状态与计数统一由 reconciliation 模块从 sub_tasks 事实派生
    storage::with_tasks(app, |tasks| {
        if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
            finalize_task_in_place(t, was_cancelled);
        }
    });
    let _ = app.emit("task-updated", &task.id);
}

async fn generate_single_image(
    client: &reqwest::Client,
    token: &str,
    base_url: &str,
    task: &Task,
    index: usize,
) -> Result<ImageRecord, String> {
    let body = serde_json::json!({
        "model": "gpt-image-2",
        "prompt": compose_model_instruction(
            &effective_prompt(task, index),
            &effective_negative_prompt(task, index),
        ),
        "size": task.size,
        "quality": task.quality,
        "output_format": task.output_format,
        "response_format": "b64_json",
        "n": 1
    });

    let url = format!("{}/v1/images/generations", base_url);

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format_send_error(&e, &url))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format_upstream_image_error(status, &text));
    }

    let api_response: ApiResponse = response
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let image_data = api_response
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "API 未返回图片数据".to_string())?;

    let b64 = image_data
        .b64_json
        .ok_or_else(|| "响应中缺少 base64 数据".to_string())?;

    let image_bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &b64)
        .map_err(|e| format!("Base64 解码失败: {}", e))?;

    let now = chrono::Local::now();
    let timestamp = now.format("%Y%m%d_%H%M%S");
    let ext = &task.output_format;
    let file_name = format!("{}_{}.{}", timestamp, index + 1, ext);

    let file_path = Path::new(&task.output_dir).join(&file_name);
    fs::write(&file_path, &image_bytes).map_err(|e| format!("保存图片失败: {}", e))?;

    let image_id = uuid::Uuid::new_v4().to_string();

    Ok(ImageRecord {
        id: image_id,
        task_id: task.id.clone(),
        local_path: file_path.to_string_lossy().replace('\\', "/"),
        file_name,
        created_at: now.to_rfc3339(),
        status: "saved".to_string(),
        source_kind: "output".to_string(),
        missing: false,
        last_seen_at: Some(now.to_rfc3339()),
        width: None,
        height: None,
        description: batch_item_description(task, index),
        tags: Vec::new(),
        indexed_at: None,
    })
}

pub fn mime_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "image/png",
    }
}

async fn remove_background_single_image(
    settings: &crate::models::Settings,
    task: &Task,
    index: usize,
) -> Result<ImageRecord, String> {
    let api_key = settings.removebg_api_key.trim();
    if api_key.is_empty() {
        return Err("请先在设置中配置 remove.bg API Key".to_string());
    }

    let source_path = task
        .source_images
        .get(index)
        .or_else(|| task.source_images.first())
        .ok_or_else(|| "去背景任务缺少源图".to_string())?;
    let path = Path::new(source_path);
    if !path.exists() {
        return Err(format!("源图不存在: {}", source_path));
    }

    let bytes = fs::read(path).map_err(|e| format!("读取源图失败: {}", e))?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image.png")
        .to_string();
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(mime_for_path(path))
        .map_err(|e| format!("构建上传文件失败: {}", e))?;
    let form = reqwest::multipart::Form::new()
        .part("image_file", part)
        .text("size", "auto");

    let resp = reqwest::Client::new()
        .post("https://api.remove.bg/v1.0/removebg")
        .header("X-Api-Key", api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("remove.bg 请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("remove.bg 错误 {}: {}", status, text));
    }

    let transparent_dir = Path::new(&task.output_dir).join("transparent");
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

    Ok(ImageRecord {
        id: uuid::Uuid::new_v4().to_string(),
        task_id: task.id.clone(),
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
    })
}

async fn edit_single_image(
    client: &reqwest::Client,
    token: &str,
    base_url: &str,
    task: &Task,
    index: usize,
) -> Result<ImageRecord, String> {
    // ===== 源图前置校验（图生图执行的硬边界）=====
    // 空源图 / 源图文件不存在时必须在本地立即失败，给出明确错误；
    // 绝不把无源图 / 坏路径的 edit 请求发给上游，也绝不静默 fallback 到其它图片。
    let source_images = effective_source_images(task, index);
    if source_images.is_empty() {
        return Err(
            "图生图任务缺少源图片，请在任务卡中重新绑定源图片后再执行。".to_string(),
        );
    }
    for img_path in &source_images {
        if !Path::new(img_path).exists() {
            return Err(format!(
                "源图片不存在：{}。该任务引用的源图可能已被删除或移动，请在任务卡中切换源图片后重试。",
                img_path
            ));
        }
    }

    let mut form = reqwest::multipart::Form::new()
        .text("model", "gpt-image-2")
        .text(
            "prompt",
            compose_model_instruction(
                &effective_prompt(task, index),
                &effective_negative_prompt(task, index),
            ),
        )
        .text("n", "1")
        .text("size", task.size.clone())
        .text("response_format", "b64_json");

    for img_path in &source_images {
        let path = Path::new(img_path);
        let file_bytes =
            fs::read(path).map_err(|e| format!("无法读取源图片 {}: {}", img_path, e))?;
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("image.png")
            .to_string();
        let mime = mime_for_path(path);
        let part = reqwest::multipart::Part::bytes(file_bytes)
            .file_name(file_name)
            .mime_str(mime)
            .unwrap();
        form = form.part("image[]", part);
    }

    let url = format!("{}/v1/images/edits", base_url);

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format_send_error(&e, &url))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format_upstream_image_error(status, &text));
    }

    let api_response: ApiResponse = response
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let image_data = api_response
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "API 未返回图片数据".to_string())?;

    let image_bytes = if let Some(b64) = image_data.b64_json {
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &b64)
            .map_err(|e| format!("Base64 解码失败: {}", e))?
    } else {
        return Err("响应中缺少 b64_json 数据".to_string());
    };

    let now = chrono::Local::now();
    let timestamp = now.format("%Y%m%d_%H%M%S");
    let ext = &task.output_format;
    let file_name = format!("{}_{}_edit.{}", timestamp, index + 1, ext);

    let file_path = Path::new(&task.output_dir).join(&file_name);
    fs::write(&file_path, &image_bytes).map_err(|e| format!("保存图片失败: {}", e))?;

    let image_id = uuid::Uuid::new_v4().to_string();

    Ok(ImageRecord {
        id: image_id,
        task_id: task.id.clone(),
        local_path: file_path.to_string_lossy().replace('\\', "/"),
        file_name,
        created_at: now.to_rfc3339(),
        status: "saved".to_string(),
        source_kind: "output".to_string(),
        missing: false,
        last_seen_at: Some(now.to_rfc3339()),
        width: None,
        height: None,
        description: batch_item_description(task, index),
        tags: Vec::new(),
        indexed_at: None,
    })
}
