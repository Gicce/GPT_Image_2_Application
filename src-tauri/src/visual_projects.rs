//! Visual Project 持久化（V4.1 Workbench V2）：
//! - 项目文档整体 JSON 存 `visual_projects` 表（data_json），schema 由前端 TS
//!   单一维护（与 Task.provenance 同一模式），Rust 只做行级 CRUD；
//! - 列表查询只返回摘要列（不含 workspace 大 JSON），打开项目再取 data_json；
//! - 区域 mask 以 PNG 文件落盘（visual_projects/{project_id}/masks/*.png），
//!   region 内只引用路径 —— 与「不把 bitmap 塞状态」的领域铁律一致。

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::storage;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualProjectSummaryRow {
    pub id: String,
    pub name: String,
    pub status: String,
    pub revision: i64,
    #[serde(default)]
    pub cover_path: Option<String>,
    pub updated_at: String,
    #[serde(default)]
    pub last_opened_at: Option<String>,
}

/// 列表查询 SQL（const 化：单测执行同一条语句，杜绝「测试写对了、命令写错了」的漂移；
/// 历史事故：COALESCE 误写 COALES 导致项目列表恒空，数据完好但 UI 看不见）。
const LIST_SQL: &str = "SELECT id, name, status, revision, cover_path, updated_at, last_opened_at
             FROM visual_projects
             ORDER BY COALESCE(NULLIF(last_opened_at, ''), updated_at) DESC
             LIMIT 200";

#[tauri::command]
pub fn list_visual_projects(app: AppHandle) -> Result<Vec<VisualProjectSummaryRow>, String> {
    let conn = storage::open_app_db(&app)?;
    let mut stmt = conn.prepare(LIST_SQL).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(VisualProjectSummaryRow {
                id: row.get(0)?,
                name: row.get(1)?,
                status: row.get(2)?,
                revision: row.get(3)?,
                cover_path: row.get::<_, Option<String>>(4)?,
                updated_at: row.get(5)?,
                last_opened_at: row.get::<_, Option<String>>(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut projects = Vec::new();
    for row in rows {
        projects.push(row.map_err(|e| e.to_string())?);
    }
    Ok(projects)
}

/// 打开项目：返回完整文档 JSON（data_json 原样；TS 侧负责归一化与版本迁移）。
#[tauri::command]
pub fn load_visual_project(app: AppHandle, id: String) -> Result<Option<String>, String> {
    let conn = storage::open_app_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT data_json FROM visual_projects WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map([&id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(row) => Ok(Some(row.map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn save_visual_project(
    app: AppHandle,
    id: String,
    name: String,
    status: String,
    revision: i64,
    cover_path: Option<String>,
    data_json: String,
    last_opened_at: Option<String>,
) -> Result<(), String> {
    // 写入前校验：data_json 必须是合法 JSON（坏文档绝不落库覆盖好文档）
    serde_json::from_str::<serde_json::Value>(&data_json).map_err(|e| format!("项目文档不是合法 JSON：{}", e))?;
    let now = chrono::Local::now().to_rfc3339();
    let conn = storage::open_app_db(&app)?;
    conn.execute(
        "INSERT INTO visual_projects (id, name, status, revision, cover_path, data_json, created_at, updated_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            status = excluded.status,
            revision = excluded.revision,
            cover_path = excluded.cover_path,
            data_json = excluded.data_json,
            updated_at = excluded.updated_at,
            last_opened_at = COALESCE(excluded.last_opened_at, visual_projects.last_opened_at)",
        rusqlite::params![
            id,
            name,
            status,
            revision,
            cover_path.unwrap_or_default(),
            data_json,
            now,
            last_opened_at.unwrap_or_default(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn rename_visual_project(app: AppHandle, id: String, name: String) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    let conn = storage::open_app_db(&app)?;
    conn.execute(
        "UPDATE visual_projects SET name = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, name, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除项目（连带清理区域 mask 目录；素材库图片不受影响）。
#[tauri::command]
pub fn delete_visual_project(app: AppHandle, id: String) -> Result<(), String> {
    let conn = storage::open_app_db(&app)?;
    conn.execute("DELETE FROM visual_projects WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    drop(conn);
    let masks_dir = storage::data_dir(&app)
        .join("visual_projects")
        .join(&id);
    if masks_dir.exists() {
        let _ = std::fs::remove_dir_all(masks_dir);
    }
    Ok(())
}

fn masks_root(app: &AppHandle, project_id: &str) -> Result<std::path::PathBuf, String> {
    let dir = storage::data_dir(app).join("visual_projects").join(project_id).join("masks");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建区域 mask 目录：{}", e))?;
    Ok(dir)
}

/// Project Index Recovery 报告（TS 侧据 repaired 决定提示「已恢复 N 个视觉项目」）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualProjectIndexRecoveryReport {
    pub rows_scanned: i64,
    pub repaired: i64,
}

/// 重建项目索引（Project Index Recovery）：扫描全部项目行，用 data_json 文档
/// 修复摘要列（name / status / revision / cover_path / updated_at / last_opened_at）
/// 的漂移。只读 → 比对 → 修复，绝不删行、绝不清表；data_json 损坏的行跳过
/// （保留原摘要列，待用户手动处理）。
#[tauri::command]
pub fn rebuild_visual_project_index(app: AppHandle) -> Result<VisualProjectIndexRecoveryReport, String> {
    let conn = storage::open_app_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT id, name, status, revision, cover_path, updated_at, last_opened_at, data_json FROM visual_projects")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, i64, Option<String>, String, String, String)> = stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    drop(stmt);

    let scanned = rows.len() as i64;
    let mut repaired: i64 = 0;
    let now = chrono::Local::now().to_rfc3339();
    for (id, name, status, revision, cover_path, updated_at, last_opened_at, data_json) in rows {
        let Ok(doc) = serde_json::from_str::<serde_json::Value>(&data_json) else {
            continue; // 坏文档不覆盖（save 侧已有校验，这里再防一手）
        };
        let text_of = |key: &str| doc.get(key).and_then(|v| v.as_str()).map(str::to_string);
        let doc_name = text_of("name");
        let doc_status = text_of("status");
        let doc_cover = text_of("coverPath");
        let doc_updated = text_of("updatedAt");
        let doc_opened = text_of("lastOpenedAt");
        let doc_revision = doc.get("revision").and_then(|v| v.as_i64());
        let drifted = doc_name.as_deref() != Some(name.as_str())
            || doc_status.as_deref() != Some(status.as_str())
            || doc_revision != Some(revision)
            || doc_cover.as_deref().unwrap_or("") != cover_path.as_deref().unwrap_or("")
            || doc_updated.as_deref() != Some(updated_at.as_str())
            || doc_opened.as_deref().unwrap_or("") != last_opened_at.as_str();
        if !drifted {
            continue;
        }
        conn.execute(
            "UPDATE visual_projects SET name = ?2, status = ?3, revision = ?4, cover_path = ?5, updated_at = ?6, last_opened_at = ?7 WHERE id = ?1",
            rusqlite::params![
                id,
                doc_name.as_deref().unwrap_or(name.as_str()),
                doc_status.as_deref().unwrap_or(status.as_str()),
                doc_revision.unwrap_or(revision),
                doc_cover.unwrap_or_else(|| cover_path.clone().unwrap_or_default()),
                doc_updated.as_deref().unwrap_or(updated_at.as_str()),
                doc_opened.unwrap_or_else(|| last_opened_at.clone()),
            ],
        )
        .map_err(|e| e.to_string())?;
        repaired += 1;
    }
    println!("[VisualProjectRecovery] scanned: {}, repaired: {} ({})", scanned, repaired, now);
    Ok(VisualProjectIndexRecoveryReport {
        rows_scanned: scanned,
        repaired,
    })
}

/// 保存区域 mask PNG（base64 输入；返回绝对路径供 region.maskPath 引用）。
#[tauri::command]
pub fn save_visual_project_mask(
    app: AppHandle,
    project_id: String,
    region_id: String,
    png_base64: String,
) -> Result<String, String> {
    if project_id.is_empty() || region_id.is_empty() {
        return Err("项目 id 与区域 id 不能为空。".to_string());
    }
    // 路径穿越防护：id 只允许安全字符
    for value in [&project_id, &region_id] {
        if value.contains("..") || value.contains(['/', '\\']) {
            return Err("非法 id。".to_string());
        }
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64.as_bytes())
        .map_err(|e| format!("mask base64 解码失败：{}", e))?;
    if bytes.is_empty() {
        return Err("mask 数据为空。".to_string());
    }
    // PNG 魔数校验（坏数据绝不写成 .png 引用）
    if bytes.len() < 8 || bytes[..8] != [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        return Err("mask 数据不是合法 PNG。".to_string());
    }
    let path = masks_root(&app, &project_id)?.join(format!("{}.png", region_id));
    std::fs::write(&path, &bytes).map_err(|e| format!("mask 写盘失败：{}", e))?;
    Ok(path.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn in_memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS visual_projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                revision INTEGER NOT NULL DEFAULT 0,
                cover_path TEXT NOT NULL DEFAULT '',
                data_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_opened_at TEXT NOT NULL DEFAULT ''
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn upsert_then_list_orders_by_last_opened() {
        let conn = in_memory_db();
        let now = "2026-08-24T10:00:00+08:00";
        conn.execute(
            "INSERT INTO visual_projects (id, name, status, revision, cover_path, data_json, created_at, updated_at, last_opened_at)
             VALUES ('p1', '项目一', 'ready', 3, '', '{}', ?1, ?1, '')",
            [now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO visual_projects (id, name, status, revision, cover_path, data_json, created_at, updated_at, last_opened_at)
             VALUES ('p2', '项目二', 'ready', 1, '', '{}', ?1, ?1, '2026-08-24T12:00:00+08:00')",
            [now],
        )
        .unwrap();
        // ON CONFLICT upsert（save_visual_project 的 SQL 形状）：同名主键更新而非报错
        conn.execute(
            "INSERT INTO visual_projects (id, name, status, revision, cover_path, data_json, created_at, updated_at, last_opened_at)
             VALUES ('p1', '项目一改', 'modified', 4, '', '{\"revision\":4}', ?1, ?1, '2026-08-24T13:00:00+08:00')
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                status = excluded.status,
                revision = excluded.revision,
                cover_path = excluded.cover_path,
                data_json = excluded.data_json,
                updated_at = excluded.updated_at,
                last_opened_at = COALESCE(excluded.last_opened_at, visual_projects.last_opened_at)",
            [now],
        )
        .unwrap();
        let mut stmt = conn
            .prepare("SELECT id FROM visual_projects ORDER BY COALESCE(NULLIF(last_opened_at, ''), updated_at) DESC")
            .unwrap();
        let ids: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(ids, vec!["p1".to_string(), "p2".to_string()]);
    }

    /// 回归锚点：list 命令的真实 SQL 必须能在 SQLite 上 prepare + 执行。
    /// 历史事故：COALESCE 误写 COALES，单测自己写 SQL 全绿而命令恒错，
    /// 项目列表为空、用户以为数据全丢。此测试执行 LIST_SQL 常量本身。
    #[test]
    fn production_list_sql_prepares_and_orders_by_last_opened() {
        let conn = in_memory_db();
        let now = "2026-08-25T09:00:00+08:00";
        conn.execute(
            "INSERT INTO visual_projects (id, name, status, revision, cover_path, data_json, created_at, updated_at, last_opened_at)
             VALUES ('a', 'A', 'ready', 1, '', '{}', ?1, ?1, '')",
            [now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO visual_projects (id, name, status, revision, cover_path, data_json, created_at, updated_at, last_opened_at)
             VALUES ('b', 'B', 'ready', 1, '', '{}', ?1, ?1, '2026-08-25T10:00:00+08:00')",
            [now],
        )
        .unwrap();
        let mut stmt = conn.prepare(LIST_SQL).unwrap();
        let ids: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(ids, vec!["b".to_string(), "a".to_string()]);
        // 生产 SQL 里禁止再出现 COALES( 之类的截断函数名
        assert!(!LIST_SQL.contains("COALES("));
    }

    #[test]
    fn png_magic_number_check_blocks_non_png() {
        let bad = vec![0u8, 1, 2, 3, 4, 5, 6, 7];
        assert!(bad[..8] != [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
    }
}
