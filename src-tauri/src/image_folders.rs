//! 图库自定义文件夹（V6.6，ADR-029）：物理目录 + SQLite 注册表双轨。
//! 文件夹 = 磁盘真实目录（默认建在 default_output_dir 下，为空回落系统图片目录）；
//! 注册表只记 id/name/path，图片归属由前端按 local_path 前缀判定——不写 ImageRecord。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::models::Settings;
use crate::storage;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFolderRow {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: String,
}

/// 文件夹名清洗：剥 Windows 非法字符与控制符，压缩空白；全剥后为空则报错。
fn sanitize_folder_name(raw: &str) -> Result<String, String> {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        Err("文件夹名称不能为空，且不能只包含符号。".to_string())
    } else {
        Ok(collapsed)
    }
}

/// 重名去重：name 被占用时依次尝试「name (2)」「name (3)」…；
/// occupied 同时覆盖注册表路径与磁盘已存在目录（base/name 归一化前缀键）。
fn unique_folder_name(base: &std::path::Path, name: &str, occupied: &dyn Fn(&std::path::Path) -> bool) -> String {
    let mut candidate = name.to_string();
    let mut counter = 2u32;
    while occupied(&base.join(&candidate)) {
        candidate = format!("{name} ({counter})");
        counter += 1;
    }
    candidate
}

fn folder_base_dir(settings: &Settings) -> Result<PathBuf, String> {
    let trimmed = settings.default_output_dir.trim();
    if !trimmed.is_empty() {
        return Ok(PathBuf::from(trimmed));
    }
    dirs::picture_dir().ok_or_else(|| {
        "无法确定文件夹位置：请先在「设置与更新 → 图片与文件」配置生成图片保存目录。".to_string()
    })
}

fn list_rows(conn: &rusqlite::Connection) -> Result<Vec<ImageFolderRow>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, path, created_at FROM image_folders ORDER BY created_at ASC, name ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok(ImageFolderRow {
            id: row.get(0)?,
            name: row.get(1)?,
            path: row.get(2)?,
            created_at: row.get(3)?,
        }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// sync_images 扫描根扩展：注册表里的文件夹路径（读取失败静默忽略，不阻断图库扫描）。
pub fn folder_scan_roots(app: &AppHandle) -> Vec<String> {
    let conn = match storage::open_app_db(app) {
        Ok(conn) => conn,
        Err(_) => return Vec::new(),
    };
    list_rows(&conn).unwrap_or_default().into_iter().map(|row| row.path).collect()
}

#[tauri::command]
pub fn list_image_folders(app: AppHandle) -> Result<Vec<ImageFolderRow>, String> {
    let conn = storage::open_app_db(&app)?;
    list_rows(&conn)
}

#[tauri::command]
pub fn create_image_folder(app: AppHandle, name: String) -> Result<ImageFolderRow, String> {
    let clean_name = sanitize_folder_name(&name)?;
    let settings: Settings = storage::read_json(&storage::settings_path(&app), Settings::default());
    let base = folder_base_dir(&settings)?;
    let conn = storage::open_app_db(&app)?;

    let taken_paths: Vec<String> = list_rows(&conn)?
        .into_iter()
        .map(|row| row.path)
        .collect();
    let occupied = |candidate: &std::path::Path| -> bool {
        let key = normalize_dir_key(&candidate.to_string_lossy());
        if candidate.exists() {
            return true;
        }
        taken_paths.iter().any(|p| normalize_dir_key(p) == key)
    };
    let final_name = unique_folder_name(&base, &clean_name, &occupied);
    let folder_path = base.join(&final_name);
    std::fs::create_dir_all(&folder_path)
        .map_err(|e| format!("文件夹创建失败（{}）：{e}", folder_path.display()))?;

    let row = ImageFolderRow {
        id: uuid::Uuid::new_v4().to_string(),
        name: final_name,
        path: folder_path.to_string_lossy().to_string(),
        created_at: chrono::Local::now().to_rfc3339(),
    };
    conn.execute(
        "INSERT INTO image_folders (id, name, path, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![row.id, row.name, row.path, row.created_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(row)
}

#[tauri::command]
pub fn delete_image_folder(app: AppHandle, id: String) -> Result<(), String> {
    let conn = storage::open_app_db(&app)?;
    conn.execute("DELETE FROM image_folders WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 目录归一化键：统一分隔符 + 去尾斜杠 + Windows 小写（与图库路径身份键同规则）。
fn normalize_dir_key(raw: &str) -> String {
    let mut key = raw.trim().replace('\\', "/");
    while key.ends_with('/') {
        key.pop();
    }
    if cfg!(windows) {
        key.to_lowercase()
    } else {
        key
    }
}

#[cfg(test)]
mod tests {
    use super::{list_rows, sanitize_folder_name, unique_folder_name};
    use rusqlite::Connection;
    use std::path::Path;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE image_folders (
                id TEXT PRIMARY KEY, name TEXT NOT NULL,
                path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    fn insert(conn: &Connection, id: &str, name: &str, path: &str) {
        conn.execute(
            "INSERT INTO image_folders (id, name, path, created_at) VALUES (?1, ?2, ?3, '2026-01-01')",
            [id, name, path],
        )
        .unwrap();
    }

    #[test]
    fn sanitize_strips_windows_illegal_chars_and_rejects_empty() {
        // 非法字符替换为空格后按空白折叠：`我的:图*片?` → 三个词素「我的 图 片」
        assert_eq!(sanitize_folder_name(" 我的:图*片? ").unwrap(), "我的 图 片");
        assert_eq!(sanitize_folder_name("a/b\\c|d").unwrap(), "a b c d");
        assert!(sanitize_folder_name("///").is_err());
        assert!(sanitize_folder_name("   ").is_err());
    }

    #[test]
    fn unique_name_appends_counter_only_when_occupied() {
        let base = Path::new("/gallery");
        let free = |_: &Path| false;
        assert_eq!(unique_folder_name(base, "产品图", &free), "产品图");

        // 原名被占用（精确到目录级）时依次尝试 (2)/(3)
        let taken_exact = |candidate: &Path| candidate.to_string_lossy().ends_with("产品图");
        assert_eq!(unique_folder_name(base, "产品图", &taken_exact), "产品图 (2)");
        let taken_two = |candidate: &Path| {
            let s = candidate.to_string_lossy();
            s.ends_with("产品图") || s.ends_with("产品图 (2)")
        };
        assert_eq!(unique_folder_name(base, "产品图", &taken_two), "产品图 (3)");

        // 只有「产品图 (2)」被占用时，原名未被占用则不加后缀
        let taken2 = |candidate: &Path| candidate.to_string_lossy().ends_with("产品图 (2)");
        assert_eq!(unique_folder_name(base, "产品图", &taken2), "产品图");
    }

    #[test]
    fn list_rows_orders_by_created_at_then_name() {
        let conn = test_conn();
        insert(&conn, "1", "B", "/g/b");
        insert(&conn, "2", "A", "/g/a");
        let names: Vec<String> = list_rows(&conn).unwrap().into_iter().map(|r| r.name).collect();
        // created_at 相同（测试固定值）时按 name 排序
        assert_eq!(names, vec!["A".to_string(), "B".to_string()]);
    }
}
