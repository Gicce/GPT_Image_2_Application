//! Local user-authored Skill drafts. TypeScript owns the versioned document schema;
//! Rust validates JSON and provides durable SQLite storage only.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::storage;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSkillSummaryRow {
    pub id: String,
    pub name: String,
    pub domain: String,
    pub version: String,
    pub status: String,
    pub source_project_id: Option<String>,
    pub source_revision: i64,
    pub authoring_state: String,
    pub updated_at: String,
}

#[tauri::command]
pub fn list_user_skills(app: AppHandle) -> Result<Vec<UserSkillSummaryRow>, String> {
    let conn = storage::open_app_db(&app)?;
    let mut stmt = conn.prepare(
        "SELECT id, name, domain, version, status, source_project_id, source_revision, authoring_state, updated_at
         FROM user_skills ORDER BY updated_at DESC LIMIT 200",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(UserSkillSummaryRow {
        id: row.get(0)?, name: row.get(1)?, domain: row.get(2)?, version: row.get(3)?,
        status: row.get(4)?, source_project_id: row.get(5)?, source_revision: row.get(6)?,
        authoring_state: row.get(7)?, updated_at: row.get(8)?,
    })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_user_skill(app: AppHandle, id: String) -> Result<Option<String>, String> {
    let conn = storage::open_app_db(&app)?;
    let mut stmt = conn.prepare("SELECT data_json FROM user_skills WHERE id = ?1").map_err(|e| e.to_string())?;
    let mut rows = stmt.query_map([id], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    match rows.next() { Some(row) => Ok(Some(row.map_err(|e| e.to_string())?)), None => Ok(None) }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn save_user_skill(
    app: AppHandle, id: String, name: String, domain: String, version: String,
    status: String, source_project_id: Option<String>, source_revision: i64,
    authoring_state: String, data_json: String,
) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&data_json).map_err(|e| format!("Skill 草稿不是合法 JSON：{e}"))?;
    let now = chrono::Local::now().to_rfc3339();
    let conn = storage::open_app_db(&app)?;
    conn.execute(
        "INSERT INTO user_skills (id, name, domain, version, status, source_project_id, source_revision, authoring_state, data_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, domain=excluded.domain,
         version=excluded.version, status=excluded.status, source_project_id=excluded.source_project_id,
         source_revision=excluded.source_revision, authoring_state=excluded.authoring_state,
         data_json=excluded.data_json, updated_at=excluded.updated_at",
        rusqlite::params![id, name, domain, version, status, source_project_id, source_revision, authoring_state, data_json, now],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_user_skill(app: AppHandle, id: String) -> Result<(), String> {
    delete_user_skill_row(&storage::open_app_db(&app)?, &id)?;
    Ok(())
}

/// 删除本机 Skill 行（V6.1 我的技能删除）：
/// 只动 user_skills 表——服务器投稿记录、视觉项目、图片库原图一律不受影响。
fn delete_user_skill_row(conn: &rusqlite::Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM user_skills WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::delete_user_skill_row;
    use rusqlite::Connection;

    /// 建最小表结构（user_skills + 相邻表），验证删除只影响目标行。
    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE user_skills (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT NOT NULL,
                version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'local',
                source_project_id TEXT, source_revision INTEGER NOT NULL DEFAULT 0,
                authoring_state TEXT NOT NULL DEFAULT 'project_template',
                data_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE visual_projects (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
                revision INTEGER NOT NULL, cover_path TEXT NOT NULL,
                data_json TEXT NOT NULL, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL, last_opened_at TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    fn insert_skill(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO user_skills (id, name, domain, version, status, data_json, created_at, updated_at)
             VALUES (?1, ?1, 'product', '1.0.0', 'local', '{}', '2026-01-01', '2026-01-01')",
            [id],
        )
        .unwrap();
    }

    fn skill_count(conn: &Connection, id: &str) -> i64 {
        conn.query_row("SELECT COUNT(1) FROM user_skills WHERE id = ?1", [id], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn delete_removes_only_target_skill_row() {
        let conn = test_conn();
        insert_skill(&conn, "skill-a");
        insert_skill(&conn, "skill-b");
        conn.execute(
            "INSERT INTO visual_projects (id, name, status, revision, cover_path, data_json, created_at, updated_at, last_opened_at)
             VALUES ('proj-1', '项目', 'draft', 0, '', '{}', '2026-01-01', '2026-01-01', '')",
            [],
        )
        .unwrap();

        delete_user_skill_row(&conn, "skill-a").unwrap();

        assert_eq!(skill_count(&conn, "skill-a"), 0, "目标 Skill 行必须删除");
        assert_eq!(skill_count(&conn, "skill-b"), 1, "其它 Skill 不受影响");
        // 删除持久化：同一连接（模拟重载后的库）中目标行仍不存在
        assert_eq!(skill_count(&conn, "skill-a"), 0);
        let projects: i64 = conn
            .query_row("SELECT COUNT(1) FROM visual_projects", [], |row| row.get(0))
            .unwrap();
        assert_eq!(projects, 1, "视觉项目（历史项目）绝不随 Skill 删除");
    }

    #[test]
    fn delete_missing_id_is_idempotent_no_error() {
        let conn = test_conn();
        // 删除不存在的 id：幂等成功（UI 重试 / 重复确认不得报错）
        delete_user_skill_row(&conn, "not-exist").unwrap();
        assert_eq!(skill_count(&conn, "not-exist"), 0);
    }
}
