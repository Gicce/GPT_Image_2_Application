//! AI 漫画本地持久化（Phase 1，规格 §8.2 / D-007）：
//! - 三表：comic_projects（本期创作）/ comic_skills（漫画 Skill 库）/ comic_characters（角色演员库）；
//! - schema 由前端 TS 单一维护（同 visual_projects/user_skills 先例），Rust 只做
//!   行级 CRUD + JSON 合法性校验，绝不反序列化领域字段；
//! - comic_skills 独立于 user_skills：后者是视觉配方形状，混存会被既有归一化损坏。

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::storage;

// ---------------------------------------------------------------------------
// comic_projects（本期漫画项目）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicProjectSummaryRow {
    pub id: String,
    pub name: String,
    pub stage: String,
    pub skill_id: Option<String>,
    pub updated_at: String,
    #[serde(default)]
    pub last_opened_at: Option<String>,
}

/// 列表查询 SQL（const 化：单测执行同一条语句，杜绝命令与测试各写一份的漂移；
/// 先例：visual_projects 的 COALES 截断事故）。
const LIST_PROJECTS_SQL: &str = "SELECT id, name, stage, skill_id, updated_at, last_opened_at
             FROM comic_projects
             ORDER BY COALESCE(NULLIF(last_opened_at, ''), updated_at) DESC
             LIMIT 200";

#[tauri::command]
pub fn list_comic_projects(app: AppHandle) -> Result<Vec<ComicProjectSummaryRow>, String> {
    let conn = storage::open_app_db(&app)?;
    let mut stmt = conn.prepare(LIST_PROJECTS_SQL).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(ComicProjectSummaryRow {
        id: row.get(0)?,
        name: row.get(1)?,
        stage: row.get(2)?,
        skill_id: row.get(3)?,
        updated_at: row.get(4)?,
        last_opened_at: row.get::<_, Option<String>>(5)?,
    })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_comic_project(app: AppHandle, id: String) -> Result<Option<String>, String> {
    load_row_json(&storage::open_app_db(&app)?, "comic_projects", &id)
}

#[tauri::command]
pub fn save_comic_project(
    app: AppHandle,
    id: String,
    name: String,
    stage: String,
    skill_id: Option<String>,
    data_json: String,
    last_opened_at: Option<String>,
) -> Result<(), String> {
    validate_json(&data_json, "漫画项目文档")?;
    let now = chrono::Local::now().to_rfc3339();
    let conn = storage::open_app_db(&app)?;
    conn.execute(
        "INSERT INTO comic_projects (id, name, stage, skill_id, data_json, created_at, updated_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, stage = excluded.stage,
            skill_id = excluded.skill_id, data_json = excluded.data_json,
            updated_at = excluded.updated_at,
            last_opened_at = COALESCE(excluded.last_opened_at, comic_projects.last_opened_at)",
        rusqlite::params![id, name, stage, skill_id, data_json, now, last_opened_at.unwrap_or_default()],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn rename_comic_project(app: AppHandle, id: String, name: String) -> Result<(), String> {
    rename_row(&storage::open_app_db(&app)?, "comic_projects", &id, &name)
}

/// 删除漫画项目行：只动 comic_projects——角色库、漫画 Skill、素材库图片一律不受影响
/// （生成图归图片库所有，删除项目不得清图）。
#[tauri::command]
pub fn delete_comic_project(app: AppHandle, id: String) -> Result<(), String> {
    delete_row(&storage::open_app_db(&app)?, "comic_projects", &id)
}

// ---------------------------------------------------------------------------
// comic_skills（漫画 Skill 库）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicSkillSummaryRow {
    pub id: String,
    pub name: String,
    pub comic_form: String,
    pub version: i64,
    pub source: String,
    pub updated_at: String,
}

const LIST_SKILLS_SQL: &str = "SELECT id, name, comic_form, version, source, updated_at
             FROM comic_skills ORDER BY updated_at DESC LIMIT 500";

#[tauri::command]
pub fn list_comic_skills(app: AppHandle) -> Result<Vec<ComicSkillSummaryRow>, String> {
    let conn = storage::open_app_db(&app)?;
    let mut stmt = conn.prepare(LIST_SKILLS_SQL).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(ComicSkillSummaryRow {
        id: row.get(0)?,
        name: row.get(1)?,
        comic_form: row.get(2)?,
        version: row.get(3)?,
        source: row.get(4)?,
        updated_at: row.get(5)?,
    })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_comic_skill(app: AppHandle, id: String) -> Result<Option<String>, String> {
    load_row_json(&storage::open_app_db(&app)?, "comic_skills", &id)
}

#[tauri::command]
pub fn save_comic_skill(
    app: AppHandle,
    id: String,
    name: String,
    comic_form: String,
    version: i64,
    source: String,
    data_json: String,
) -> Result<(), String> {
    validate_json(&data_json, "漫画 Skill 文档")?;
    let now = chrono::Local::now().to_rfc3339();
    let conn = storage::open_app_db(&app)?;
    conn.execute(
        "INSERT INTO comic_skills (id, name, comic_form, version, source, data_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, comic_form = excluded.comic_form,
            version = excluded.version, source = excluded.source,
            data_json = excluded.data_json, updated_at = excluded.updated_at",
        rusqlite::params![id, name, comic_form, version, source, data_json, now],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_comic_skill(app: AppHandle, id: String) -> Result<(), String> {
    delete_row(&storage::open_app_db(&app)?, "comic_skills", &id)
}

// ---------------------------------------------------------------------------
// comic_characters（角色演员库，跨项目复用）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicCharacterSummaryRow {
    pub id: String,
    pub name: String,
    pub role: String,
    pub status: String,
    pub source: String,
    pub updated_at: String,
    /// 演员库元数据（Phase 1.2 §18/§24）：从 data_json 提取，摘要列表直接可展示。
    pub usage_count: i64,
    pub last_used_at: String,
    pub thumbnail_path: String,
}

const LIST_CHARACTERS_SQL: &str = "SELECT id, name, role, status, source, updated_at,
       COALESCE(json_extract(data_json, '$.usageCount'), 0),
       COALESCE(json_extract(data_json, '$.lastUsedAt'), updated_at),
       COALESCE(json_extract(data_json, '$.referenceImage.path'), '')
             FROM comic_characters ORDER BY updated_at DESC LIMIT 500";

#[tauri::command]
pub fn list_comic_characters(app: AppHandle) -> Result<Vec<ComicCharacterSummaryRow>, String> {
    let conn = storage::open_app_db(&app)?;
    let mut stmt = conn.prepare(LIST_CHARACTERS_SQL).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok(ComicCharacterSummaryRow {
        id: row.get(0)?,
        name: row.get(1)?,
        role: row.get(2)?,
        status: row.get(3)?,
        source: row.get(4)?,
        updated_at: row.get(5)?,
        usage_count: row.get(6)?,
        last_used_at: row.get(7)?,
        thumbnail_path: row.get(8)?,
    })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_comic_character(app: AppHandle, id: String) -> Result<Option<String>, String> {
    load_row_json(&storage::open_app_db(&app)?, "comic_characters", &id)
}

#[tauri::command]
pub fn save_comic_character(
    app: AppHandle,
    id: String,
    name: String,
    role: String,
    status: String,
    source: String,
    data_json: String,
) -> Result<(), String> {
    validate_json(&data_json, "漫画角色文档")?;
    let now = chrono::Local::now().to_rfc3339();
    let conn = storage::open_app_db(&app)?;
    conn.execute(
        "INSERT INTO comic_characters (id, name, role, status, source, data_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role,
            status = excluded.status, source = excluded.source,
            data_json = excluded.data_json, updated_at = excluded.updated_at",
        rusqlite::params![id, name, role, status, source, data_json, now],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_comic_character(app: AppHandle, id: String) -> Result<(), String> {
    delete_row(&storage::open_app_db(&app)?, "comic_characters", &id)
}

// ---------------------------------------------------------------------------
// 共享行级操作（表名字段全部内部常量，不暴露拼 SQL 入口）
// ---------------------------------------------------------------------------

fn validate_json(data_json: &str, label: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(data_json)
        .map_err(|e| format!("{label}不是合法 JSON：{e}"))?;
    Ok(())
}

fn load_row_json(conn: &rusqlite::Connection, table: &str, id: &str) -> Result<Option<String>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT data_json FROM {table} WHERE id = ?1"))
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map([id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(row) => Ok(Some(row.map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

fn rename_row(conn: &rusqlite::Connection, table: &str, id: &str, name: &str) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        &format!("UPDATE {table} SET name = ?2, updated_at = ?3 WHERE id = ?1"),
        rusqlite::params![id, name, now],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn delete_row(conn: &rusqlite::Connection, table: &str, id: &str) -> Result<(), String> {
    conn.execute(&format!("DELETE FROM {table} WHERE id = ?1"), [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// 建与 storage.rs 相同形状的三表（测试执行真实 LIST_SQL 常量）。
    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE comic_projects (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'skill_draft',
                skill_id TEXT, data_json TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                last_opened_at TEXT NOT NULL DEFAULT '');
             CREATE TABLE comic_skills (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, comic_form TEXT NOT NULL DEFAULT '四格漫画',
                version INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'ai_draft',
                data_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE comic_characters (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '辅助角色',
                status TEXT NOT NULL DEFAULT 'draft', source TEXT NOT NULL DEFAULT 'temporary',
                data_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn production_list_sqls_prepare_and_execute() {
        let conn = test_conn();
        for sql in [LIST_PROJECTS_SQL, LIST_SKILLS_SQL, LIST_CHARACTERS_SQL] {
            let mut stmt = conn.prepare(sql).unwrap();
            let count = stmt.query_map([], |_| Ok(())).unwrap().count();
            assert_eq!(count, 0, "空库查询不得报错：{sql}");
            assert!(!sql.contains("COALES("), "禁止 COALESCE 截断拼写回归");
        }
    }

    #[test]
    fn projects_ordered_by_last_opened_then_updated() {
        let conn = test_conn();
        let now = "2026-08-30T09:00:00+08:00";
        for (id, opened) in [("p1", ""), ("p2", "2026-08-30T12:00:00+08:00")] {
            conn.execute(
                "INSERT INTO comic_projects (id, name, stage, data_json, created_at, updated_at, last_opened_at)
                 VALUES (?1, ?1, 'story_ready', '{}', ?2, ?2, ?3)",
                rusqlite::params![id, now, opened],
            )
            .unwrap();
        }
        let mut stmt = conn.prepare(LIST_PROJECTS_SQL).unwrap();
        let ids: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(ids, vec!["p2".to_string(), "p1".to_string()]);
    }

    #[test]
    fn delete_only_touches_target_table_row() {
        let conn = test_conn();
        for (table, prefix) in [
            ("comic_projects", "proj"),
            ("comic_skills", "skill"),
            ("comic_characters", "char"),
        ] {
            for n in 1..=2 {
                conn.execute(
                    &format!(
                        "INSERT INTO {table} (id, name, data_json, created_at, updated_at) \
                         VALUES (?1, ?1, '{{}}', '2026-08-30', '2026-08-30')"
                    ),
                    [format!("{prefix}-{n}")],
                )
                .unwrap();
            }
        }
        delete_row(&conn, "comic_projects", "proj-1").unwrap();
        delete_row(&conn, "comic_skills", "skill-1").unwrap();
        delete_row(&conn, "comic_characters", "char-1").unwrap();

        for (table, prefix) in [
            ("comic_projects", "proj"),
            ("comic_skills", "skill"),
            ("comic_characters", "char"),
        ] {
            let remaining: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(1) FROM {table} WHERE id = ?1"),
                    [format!("{prefix}-1")],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(remaining, 0, "{table} 目标行必须删除");
            let kept: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(1) FROM {table} WHERE id = ?1"),
                    [format!("{prefix}-2")],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(kept, 1, "{table} 相邻行不受影响");
        }
    }

    #[test]
    fn delete_missing_id_is_idempotent() {
        let conn = test_conn();
        delete_row(&conn, "comic_projects", "not-exist").unwrap();
        delete_row(&conn, "comic_skills", "not-exist").unwrap();
        delete_row(&conn, "comic_characters", "not-exist").unwrap();
    }

    #[test]
    fn load_missing_returns_none_not_error() {
        let conn = test_conn();
        assert!(load_row_json(&conn, "comic_projects", "ghost").unwrap().is_none());
        assert!(load_row_json(&conn, "comic_skills", "ghost").unwrap().is_none());
        assert!(load_row_json(&conn, "comic_characters", "ghost").unwrap().is_none());
    }

    #[test]
    fn validate_json_rejects_garbage() {
        assert!(validate_json("not json", "测试").is_err());
        assert!(validate_json("{\"ok\":true}", "测试").is_ok());
    }

    #[test]
    fn character_summary_enriches_from_data_json_with_fallbacks() {
        let conn = test_conn();
        let now = "2026-09-01T10:00:00+08:00";
        conn.execute(
            "INSERT INTO comic_characters (id, name, role, status, source, data_json, created_at, updated_at)
             VALUES ('rich', '汤圆', '主角', 'locked', 'library',
               '{\"usageCount\":3,\"lastUsedAt\":\"2026-08-31T09:00:00+08:00\",\"referenceImage\":{\"path\":\"/refs/a.png\"}}',
               ?1, ?1)",
            rusqlite::params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO comic_characters (id, name, role, status, source, data_json, created_at, updated_at)
             VALUES ('bare', '无参考', '辅助角色', 'draft', 'upload', '{}', ?1, ?1)",
            rusqlite::params![now],
        )
        .unwrap();

        let mut stmt = conn.prepare(LIST_CHARACTERS_SQL).unwrap();
        let rows: Vec<ComicCharacterSummaryRow> = stmt
            .query_map([], |row| Ok(ComicCharacterSummaryRow {
                id: row.get(0)?,
                name: row.get(1)?,
                role: row.get(2)?,
                status: row.get(3)?,
                source: row.get(4)?,
                updated_at: row.get(5)?,
                usage_count: row.get(6)?,
                last_used_at: row.get(7)?,
                thumbnail_path: row.get(8)?,
            }))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        let rich = rows.iter().find(|r| r.id == "rich").unwrap();
        assert_eq!(rich.usage_count, 3);
        assert_eq!(rich.last_used_at, "2026-08-31T09:00:00+08:00");
        assert_eq!(rich.thumbnail_path, "/refs/a.png");
        // 缺元数据的老文档：usageCount=0、lastUsedAt 回退行 updated_at、缩略图为空串
        let bare = rows.iter().find(|r| r.id == "bare").unwrap();
        assert_eq!(bare.usage_count, 0);
        assert_eq!(bare.last_used_at, now);
        assert_eq!(bare.thumbnail_path, "");
    }
}
