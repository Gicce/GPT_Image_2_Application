//! Skill Workshop local persistence. The TypeScript layer owns the versioned document schema;
//! Rust validates JSON and provides durable SQLite row storage only.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::storage;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillProjectSummaryRow {
    pub id: String,
    pub name: String,
    pub skill_id: String,
    pub skill_version: String,
    pub status: String,
    pub revision: i64,
    pub updated_at: String,
    pub last_opened_at: String,
}

#[tauri::command]
pub fn list_skill_projects(app: AppHandle) -> Result<Vec<SkillProjectSummaryRow>, String> {
    let conn = storage::open_app_db(&app)?;
    let mut stmt = conn.prepare(
        "SELECT id, name, skill_id, skill_version, status, revision, updated_at, last_opened_at
         FROM skill_projects ORDER BY COALESCE(NULLIF(last_opened_at, ''), updated_at) DESC LIMIT 200",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(SkillProjectSummaryRow {
        id: row.get(0)?, name: row.get(1)?, skill_id: row.get(2)?, skill_version: row.get(3)?,
        status: row.get(4)?, revision: row.get(5)?, updated_at: row.get(6)?, last_opened_at: row.get(7)?,
    })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_skill_project(app: AppHandle, id: String) -> Result<Option<String>, String> {
    let conn = storage::open_app_db(&app)?;
    let mut stmt = conn.prepare("SELECT data_json FROM skill_projects WHERE id = ?1").map_err(|e| e.to_string())?;
    let mut rows = stmt.query_map([id], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    match rows.next() { Some(row) => Ok(Some(row.map_err(|e| e.to_string())?)), None => Ok(None) }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn save_skill_project(
    app: AppHandle, id: String, name: String, skill_id: String, skill_version: String,
    status: String, revision: i64, data_json: String, last_opened_at: Option<String>,
) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&data_json).map_err(|e| format!("技能项目不是合法 JSON：{e}"))?;
    let now = chrono::Local::now().to_rfc3339();
    let conn = storage::open_app_db(&app)?;
    conn.execute(
        "INSERT INTO skill_projects (id, name, skill_id, skill_version, status, revision, data_json, created_at, updated_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, skill_id=excluded.skill_id,
         skill_version=excluded.skill_version, status=excluded.status, revision=excluded.revision,
         data_json=excluded.data_json, updated_at=excluded.updated_at,
         last_opened_at=COALESCE(excluded.last_opened_at, skill_projects.last_opened_at)",
        rusqlite::params![id, name, skill_id, skill_version, status, revision, data_json, now, last_opened_at.unwrap_or_default()],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_skill_project(app: AppHandle, id: String) -> Result<(), String> {
    storage::open_app_db(&app)?.execute("DELETE FROM skill_projects WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}
