use std::fs;
use std::path::Path;

use tauri::{AppHandle, Emitter};

use crate::models::{ImageRecord, Task};
use crate::storage;

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
            .or_else(|| value.get("error").and_then(|v| v.get("message")).and_then(|v| v.as_str()))
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
        tasks
            .iter()
            .find(|t| t.status == "pending")
            .cloned()
    });

    let task = match task_opt {
        Some(t) => t,
        None => return,
    };

    // Mark as running
    storage::with_tasks(app, |tasks| {
        if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
            t.status = "running".to_string();
        }
    });

    let _ = app.emit("task-updated", &task.id);

    // Get token
    let settings_path = storage::settings_path(app);
    let settings: crate::models::Settings = storage::read_json(&settings_path, Default::default());
    let token = settings.token.clone();
    let requires_openai_token = task.task_type != "remove_background";

    if requires_openai_token && token.is_empty() {
        storage::with_tasks(app, |tasks| {
            if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
                t.status = "failed".to_string();
                for st in &mut t.sub_tasks {
                    st.status = "failed".to_string();
                    st.error = Some("API Token 未设置".to_string());
                }
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
                    t.status = "failed".to_string();
                    for st in &mut t.sub_tasks {
                        st.status = "failed".to_string();
                        st.error = Some("无法创建输出目录".to_string());
                    }
                }
            });
            let _ = app.emit("task-updated", &task.id);
            return;
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .use_native_tls()
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

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
            edit_single_image(&client, &token, &task, i).await
        } else {
            generate_single_image(&client, &token, &task, i).await
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

    // Finalize task status
    storage::with_tasks(app, |tasks| {
        if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
            if was_cancelled || t.status == "cancelled" {
                t.status = "cancelled".to_string();
                for sub_task in &mut t.sub_tasks {
                    if sub_task.status == "pending" || sub_task.status == "running" {
                        sub_task.status = "cancelled".to_string();
                    }
                }
            } else if failed_count > 0 {
                t.status = "failed".to_string();
                for sub_task in &mut t.sub_tasks {
                    if sub_task.status == "pending" || sub_task.status == "running" {
                        sub_task.status = "failed".to_string();
                        if sub_task.error.is_none() {
                            sub_task.error = Some("未执行：前序子任务失败导致任务中断".to_string());
                        }
                    }
                }
            } else {
                t.status = "completed".to_string();
            }
        }
    });
    let _ = app.emit("task-updated", &task.id);
}

async fn generate_single_image(
    client: &reqwest::Client,
    token: &str,
    task: &Task,
    index: usize,
) -> Result<ImageRecord, String> {

    let body = serde_json::json!({
        "model": "gpt-image-2",
        "prompt": effective_prompt(task, index),
        "size": task.size,
        "quality": task.quality,
        "output_format": task.output_format,
        "response_format": "b64_json",
        "n": 1
    });

    let response = client
        .post("https://www.packyapi.com/v1/images/generations")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;

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
        description: None,
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
    let image_bytes = resp.bytes().await.map_err(|e| format!("读取 remove.bg 响应失败: {}", e))?;
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
    task: &Task,
    index: usize,
) -> Result<ImageRecord, String> {

    let mut form = reqwest::multipart::Form::new()
        .text("model", "gpt-image-2")
        .text("prompt", effective_prompt(task, index))
        .text("n", "1")
        .text("size", task.size.clone())
        .text("response_format", "b64_json");

    for img_path in &effective_source_images(task, index) {
        let path = Path::new(img_path);
        let file_bytes = fs::read(path)
            .map_err(|e| format!("无法读取源图片 {}: {}", img_path, e))?;
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

    let response = client
        .post("https://www.packyapi.com/v1/images/edits")
        .header("Authorization", format!("Bearer {}", token))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {} (is_connect={}, is_timeout={})", e, e.is_connect(), e.is_timeout()))?;

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
        description: None,
        tags: Vec::new(),
        indexed_at: None,
    })
}
