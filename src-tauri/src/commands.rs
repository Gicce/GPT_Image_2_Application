use std::fs;
use std::path::Path;

use crate::models::{ChatConversation, CreateTaskParams, ImageRecord, Settings, SubTask, Task};
use crate::storage;

static HTTP_CLIENT: once_cell::sync::Lazy<reqwest::Client> = once_cell::sync::Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .use_native_tls()
        .build()
        .unwrap()
});

// ========== Settings ==========

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Settings {
    let path = storage::settings_path(&app);
    storage::read_json(&path, Settings::default())
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    let path = storage::settings_path(&app);
    storage::write_json(&path, &settings);
    Ok(())
}

// ========== Tasks ==========

#[tauri::command]
pub fn get_tasks(app: tauri::AppHandle) -> Vec<Task> {
    let path = storage::tasks_path(&app);
    storage::read_json(&path, Vec::new())
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

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Local::now().to_rfc3339();
    let task_type = if params.task_type.is_empty() { "generate".to_string() } else { params.task_type.clone() };

    let task = Task {
        id,
        prompt: params.prompt,
        negative_prompt: params.negative_prompt,
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
        sub_tasks: (0..params.count)
            .map(|i| SubTask {
                index: i,
                status: "pending".to_string(),
                image_id: None,
                error: None,
            })
            .collect(),
    };

    let path = storage::tasks_path(&app);
    let mut tasks: Vec<Task> = storage::read_json(&path, Vec::new());
    tasks.push(task.clone());
    storage::write_json(&path, &tasks);

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
    let path = storage::tasks_path(&app);
    let tasks: Vec<Task> = storage::read_json(&path, Vec::new());
    let original = tasks.iter().find(|t| t.id == task_id)
        .ok_or_else(|| "任务不存在".to_string())?;

    let now = chrono::Local::now().to_rfc3339();
    let task_type = if original.task_type.is_empty() { "generate".to_string() } else { original.task_type.clone() };

    let new_task = Task {
        id: uuid::Uuid::new_v4().to_string(),
        prompt: original.prompt.clone(),
        negative_prompt: original.negative_prompt.clone(),
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
        sub_tasks: (0..original.count)
            .map(|i| SubTask {
                index: i,
                status: "pending".to_string(),
                image_id: None,
                error: None,
            })
            .collect(),
    };

    let mut all_tasks: Vec<Task> = storage::read_json(&path, Vec::new());
    all_tasks.push(new_task.clone());
    storage::write_json(&path, &all_tasks);

    Ok(new_task)
}

// ========== Images ==========

#[tauri::command]
pub fn read_thumbnail(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let cache_dir = storage::data_dir(&app).join("thumbs");
    fs::create_dir_all(&cache_dir).ok();

    let path_hash = format!("{:x}", md5::compute(&path));
    let ext = Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("png");
    let cache_path = cache_dir.join(format!("{}_thumb.jpg", path_hash));

    if cache_path.exists() {
        let data = fs::read(&cache_path).map_err(|e| format!("读取缓存失败: {}", e))?;
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, data);
        return Ok(format!("data:image/jpeg;base64,{}", b64));
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
    let path = storage::images_path(&app);
    storage::read_json(&path, Vec::new())
}

#[tauri::command]
pub fn delete_image(app: tauri::AppHandle, image_id: String) -> Result<(), String> {
    let path = storage::images_path(&app);
    let mut images: Vec<ImageRecord> = storage::read_json(&path, Vec::new());

    if let Some(img) = images.iter().find(|i| i.id == image_id) {
        // Delete the file from disk
        let file_path = &img.local_path;
        if Path::new(file_path).exists() {
            let _ = fs::remove_file(file_path);
        }
    }

    images.retain(|i| i.id != image_id);
    storage::write_json(&path, &images);

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
        .map_err(|e| format!("base64解码失败: {}", e))?;

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
pub async fn chat_generate_image(app: tauri::AppHandle, prompt: String, model: String) -> Result<String, String> {
    let settings: Settings = storage::read_json(&storage::settings_path(&app), Settings::default());
    let token = settings.token.clone();
    if token.is_empty() { return Err("请先在设置页面配置图片生成 API Token".to_string()); }

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

    let resp = client.post("https://www.packyapi.com/v1/responses")
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send().await.map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("图片生成失败: {}", text));
    }

    parse_sse_for_image(resp).await
}

#[tauri::command]
pub async fn chat_edit_image(app: tauri::AppHandle, prompt: String, model: String, image_path: String) -> Result<String, String> {
    let settings: Settings = storage::read_json(&storage::settings_path(&app), Settings::default());
    let token = settings.token.clone();
    if token.is_empty() { return Err("请先在设置页面配置图片生成 API Token".to_string()); }

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

    let resp = client.post("https://www.packyapi.com/v1/responses")
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&body)
        .send().await.map_err(|e| format!("请求失败: {}", e))?;

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
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API 错误: {}", resp.status()));
    }

    let data: Vec<serde_json::Value> = resp.json().await
        .map_err(|e| format!("解析失败: {}", e))?;

    let releases = data.into_iter().take(3).map(|r| {
        let tag = r["tag_name"].as_str().unwrap_or("").to_string();
        let version = tag.trim_start_matches("app-v").trim_start_matches('v').to_string();
        let date: String = r["published_at"].as_str().unwrap_or("").chars().take(10).collect();
        let notes = r["body"].as_str().unwrap_or("").to_string();
        ReleaseNote { version, date, notes }
    }).collect();

    Ok(releases)
}
