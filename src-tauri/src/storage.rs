use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use tauri::AppHandle;
use tauri::Manager;

use crate::models::{ImageRecord, Task};

pub fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().expect("failed to resolve app data dir");
    fs::create_dir_all(&dir).ok();
    dir
}

pub fn settings_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("settings.json")
}

pub fn tasks_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("tasks.json")
}

pub fn images_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("images.json")
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &PathBuf, default: T) -> T {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(default)
}

pub fn write_json<T: serde::Serialize>(path: &PathBuf, data: &T) {
    if let Ok(json) = serde_json::to_string_pretty(data) {
        let _ = fs::write(path, json);
    }
}

// Simple file-based locking to prevent concurrent access issues
static TASK_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

pub fn with_tasks<F, R>(app: &AppHandle, f: F) -> R
where
    F: FnOnce(&mut Vec<Task>) -> R,
{
    let _lock = TASK_LOCK.lock().unwrap();
    let path = tasks_path(app);
    let mut tasks: Vec<Task> = read_json(&path, Vec::new());
    let result = f(&mut tasks);
    write_json(&path, &tasks);
    result
}

pub fn with_images<F, R>(app: &AppHandle, f: F) -> R
where
    F: FnOnce(&mut Vec<ImageRecord>) -> R,
{
    let path = images_path(app);
    let mut images: Vec<ImageRecord> = read_json(&path, Vec::new());
    let result = f(&mut images);
    write_json(&path, &images);
    result
}
