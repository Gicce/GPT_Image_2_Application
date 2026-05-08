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

    if token.is_empty() {
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
        .unwrap();

    let mut success_count = 0usize;
    let mut failed_count = 0usize;
    let total = task.count;

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

        let result = if task.task_type == "edit" {
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
            if t.status != "cancelled" {
                t.status = if failed_count == total {
                    "failed".to_string()
                } else {
                    "completed".to_string()
                };
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
        "prompt": task.prompt,
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
        return Err(format!("API 错误 {}: {}", status, text));
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
    })
}

pub fn mime_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "image/png",
    }
}

async fn edit_single_image(
    client: &reqwest::Client,
    token: &str,
    task: &Task,
    index: usize,
) -> Result<ImageRecord, String> {

    let mut form = reqwest::multipart::Form::new()
        .text("model", "gpt-image-2")
        .text("prompt", task.prompt.clone())
        .text("n", "1")
        .text("size", task.size.clone())
        .text("response_format", "b64_json");

    for img_path in &task.source_images {
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
        return Err(format!("API 错误 {}: {}", status, text));
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
    })
}
