use std::fs;
use std::path::Path;

use crate::models::{CreateTaskParams, ImageRecord, Settings, SubTask, Task};
use crate::storage;

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

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Local::now().to_rfc3339();

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

// ========== Images ==========

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
