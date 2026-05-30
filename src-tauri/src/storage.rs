use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use rusqlite::{params, Connection};
use tauri::AppHandle;
use tauri::Manager;

use crate::models::{
    AgentStyleTemplate, AgentTaskTemplate, AgentTemplateClarificationRules, AgentTemplateExportPayload,
    AgentTemplateImportPayload, AgentTemplateLog, AgentTemplateOutputSchema, ImageRecord, Task,
};

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

pub fn conversations_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("conversations.json")
}

fn db_path_from_json(path: &PathBuf) -> PathBuf {
    path.parent()
        .map(|p| p.join("app.db"))
        .unwrap_or_else(|| PathBuf::from("app.db"))
}

fn key_for_path(path: &PathBuf) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string()
}

fn open_db(path: &PathBuf) -> Option<Connection> {
    let db_path = db_path_from_json(path);
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let conn = Connection::open(db_path).ok()?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS kv_store (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS migrations (
            id TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_task_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            priority INTEGER NOT NULL DEFAULT 100,
            category TEXT NOT NULL,
            scene TEXT NOT NULL,
            intent TEXT NOT NULL,
            match_mode TEXT NOT NULL DEFAULT 'hybrid',
            trigger_keywords_json TEXT NOT NULL DEFAULT '[]',
            exclude_keywords_json TEXT NOT NULL DEFAULT '[]',
            requires_source_images INTEGER NOT NULL DEFAULT 0,
            min_source_images INTEGER NOT NULL DEFAULT 0,
            max_source_images INTEGER,
            requires_confirmation INTEGER NOT NULL DEFAULT 1,
            allow_auto_execute INTEGER NOT NULL DEFAULT 0,
            clarification_enabled INTEGER NOT NULL DEFAULT 0,
            clarification_required_fields_json TEXT NOT NULL DEFAULT '[]',
            clarification_fallback_question TEXT NOT NULL DEFAULT '',
            system_prompt TEXT NOT NULL DEFAULT '',
            prompt_template TEXT NOT NULL DEFAULT '',
            negative_prompt_template TEXT NOT NULL DEFAULT '',
            recommended_action_template TEXT NOT NULL DEFAULT '',
            output_final_prompt INTEGER NOT NULL DEFAULT 1,
            output_final_negative_prompt INTEGER NOT NULL DEFAULT 1,
            output_recommended_action INTEGER NOT NULL DEFAULT 1,
            output_clarification_question INTEGER NOT NULL DEFAULT 1,
            notes TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_style_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            priority INTEGER NOT NULL DEFAULT 100,
            style_group TEXT NOT NULL,
            trigger_keywords_json TEXT NOT NULL DEFAULT '[]',
            exclude_keywords_json TEXT NOT NULL DEFAULT '[]',
            style_prompt_fragment TEXT NOT NULL DEFAULT '',
            negative_prompt_fragment TEXT NOT NULL DEFAULT '',
            compatible_intents_json TEXT NOT NULL DEFAULT '[]',
            compatible_scenes_json TEXT NOT NULL DEFAULT '[]',
            notes TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_template_logs (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL DEFAULT '',
            message_id TEXT NOT NULL DEFAULT '',
            task_id TEXT NOT NULL DEFAULT '',
            matched_task_template_id TEXT NOT NULL DEFAULT '',
            matched_style_template_ids_json TEXT NOT NULL DEFAULT '[]',
            user_prompt_raw TEXT NOT NULL DEFAULT '',
            final_prompt TEXT NOT NULL DEFAULT '',
            final_negative_prompt TEXT NOT NULL DEFAULT '',
            recommended_action TEXT NOT NULL DEFAULT '',
            intent TEXT NOT NULL DEFAULT '',
            api_kind TEXT NOT NULL DEFAULT '',
            confidence REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_task_templates_enabled_priority
            ON agent_task_templates(enabled, priority DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_task_templates_intent_scene
            ON agent_task_templates(intent, scene);
        CREATE INDEX IF NOT EXISTS idx_agent_style_templates_enabled_priority
            ON agent_style_templates(enabled, priority DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_style_templates_group
            ON agent_style_templates(style_group);
        CREATE INDEX IF NOT EXISTS idx_agent_template_logs_task_id
            ON agent_template_logs(task_id);
        CREATE INDEX IF NOT EXISTS idx_agent_template_logs_conversation_id
            ON agent_template_logs(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_agent_template_logs_created_at
            ON agent_template_logs(created_at DESC);"
    ).ok()?;
    Some(conn)
}

fn open_app_db(app: &AppHandle) -> Result<Connection, String> {
    open_db(&settings_path(app)).ok_or_else(|| "无法打开模板数据库".to_string())
}

fn parse_json_array(text: &str) -> Vec<String> {
    serde_json::from_str(text).unwrap_or_default()
}

fn stringify_json_array(values: &[String]) -> Result<String, String> {
    serde_json::to_string(values).map_err(|e| e.to_string())
}

fn seed_default_agent_templates(conn: &Connection) -> Result<(), String> {
    let task_count: i64 = conn
        .query_row("SELECT COUNT(1) FROM agent_task_templates", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let style_count: i64 = conn
        .query_row("SELECT COUNT(1) FROM agent_style_templates", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    let now = chrono::Local::now().to_rfc3339();

    if task_count == 0 {
        let task_templates = vec![
            AgentTaskTemplate {
                id: "general_text_to_image".to_string(),
                name: "通用文生图".to_string(),
                category: "generate".to_string(),
                scene: "general".to_string(),
                intent: "image_generate".to_string(),
                trigger_keywords: vec!["生成".to_string(), "做一张".to_string(), "来一张".to_string(), "出图".to_string()],
                system_prompt: "你是通用文生图提示词策划助手。".to_string(),
                prompt_template: "生成高质量图片，主体明确，画面完整，构图稳定，整体风格与用户需求一致。".to_string(),
                negative_prompt_template: "低清晰度，模糊，畸形，构图失衡，低质感".to_string(),
                recommended_action_template: "建议按文生图任务执行，并先优化提示词后再生成。".to_string(),
                created_at: now.clone(),
                updated_at: now.clone(),
                ..AgentTaskTemplate::default()
            },
            AgentTaskTemplate {
                id: "img2img_merge_person_into_scene".to_string(),
                name: "人物融入场景".to_string(),
                category: "edit".to_string(),
                scene: "img2img_merge".to_string(),
                intent: "image_edit".to_string(),
                trigger_keywords: vec!["融入".to_string(), "放到".to_string(), "加入".to_string(), "背景换成".to_string()],
                requires_source_images: true,
                min_source_images: 1,
                clarification_rules: AgentTemplateClarificationRules {
                    enabled: true,
                    required_fields: vec!["background_target".to_string()],
                    fallback_question: "你希望保留人物不变，只替换背景或场景，对吗？如果是，请告诉我目标场景。".to_string(),
                },
                prompt_template: "将源图中的主体自然融入{{background_target}}，保留主体身份特征，调整光线、色温、透视和阴影，使整体呈现真实摄影感。".to_string(),
                negative_prompt_template: "抠图痕迹，边缘白边，悬浮感，光影不一致，人物变形，低清晰度".to_string(),
                recommended_action_template: "建议按图生图编辑执行，保留主体并替换背景或场景。".to_string(),
                created_at: now.clone(),
                updated_at: now.clone(),
                ..AgentTaskTemplate::default()
            },
            AgentTaskTemplate {
                id: "ecommerce_main_image".to_string(),
                name: "电商主图".to_string(),
                category: "generate".to_string(),
                scene: "ecommerce_main".to_string(),
                intent: "image_generate".to_string(),
                trigger_keywords: vec!["主图".to_string(), "电商".to_string(), "白底".to_string()],
                clarification_rules: AgentTemplateClarificationRules {
                    enabled: true,
                    required_fields: vec!["product".to_string()],
                    fallback_question: "你要做的是哪种产品主图？如果有特殊卖点，也一起告诉我。".to_string(),
                },
                prompt_template: "生成适合电商平台的高质量主图，主体为{{product}}，构图干净，主体完整清晰，背景简洁，材质和细节真实。".to_string(),
                negative_prompt_template: "背景杂乱，主体不完整，低清晰度，变形，透视错误，廉价感".to_string(),
                recommended_action_template: "建议按电商主图模板生成，优先保证主体清晰和商业展示感。".to_string(),
                created_at: now.clone(),
                updated_at: now.clone(),
                ..AgentTaskTemplate::default()
            },
            AgentTaskTemplate {
                id: "amazon_a_plus_scene".to_string(),
                name: "亚马逊 A+ 场景图".to_string(),
                category: "generate".to_string(),
                scene: "amazon_a_plus".to_string(),
                intent: "image_generate".to_string(),
                trigger_keywords: vec!["A+".to_string(), "亚马逊".to_string(), "卖点图".to_string(), "场景图".to_string()],
                clarification_rules: AgentTemplateClarificationRules {
                    enabled: true,
                    required_fields: vec!["product".to_string(), "scene".to_string(), "selling_point".to_string()],
                    fallback_question: "这张 A+ 图更想突出什么？请补充产品、场景和卖点。".to_string(),
                },
                prompt_template: "生成适用于亚马逊 A+ 内容的高质量品牌场景图，主体为{{product}}，场景为{{scene}}，重点突出{{selling_point}}，整体为高端商业广告摄影风格，并保留适合文案排版的留白区域。".to_string(),
                negative_prompt_template: "背景杂乱，主体不突出，廉价感，低清晰度，构图拥挤，文字区域不足".to_string(),
                recommended_action_template: "建议按 A+ 品牌场景图生成，突出卖点并预留排版空间。".to_string(),
                created_at: now.clone(),
                updated_at: now.clone(),
                ..AgentTaskTemplate::default()
            },
            AgentTaskTemplate {
                id: "remove_background_subject".to_string(),
                name: "主体去背景".to_string(),
                category: "remove_background".to_string(),
                scene: "general".to_string(),
                intent: "remove_background".to_string(),
                trigger_keywords: vec!["去背景".to_string(), "抠图".to_string(), "扣出人物".to_string(), "透明背景".to_string()],
                requires_source_images: true,
                min_source_images: 1,
                prompt_template: "提取源图主体并输出透明背景结果，优先保留边缘细节和主体完整性。".to_string(),
                negative_prompt_template: "边缘毛刺，主体缺失，透明区域脏污，细节丢失".to_string(),
                recommended_action_template: "建议先执行去背景，再决定是否替换背景或继续编辑。".to_string(),
                created_at: now.clone(),
                updated_at: now.clone(),
                ..AgentTaskTemplate::default()
            },
        ];

        for template in task_templates {
            let trigger_keywords_json = serde_json::to_string(&template.trigger_keywords).map_err(|e| e.to_string())?;
            let exclude_keywords_json = serde_json::to_string(&template.exclude_keywords).map_err(|e| e.to_string())?;
            let clarification_required_fields_json = serde_json::to_string(&template.clarification_rules.required_fields).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT OR IGNORE INTO agent_task_templates (
                    id, name, enabled, priority, category, scene, intent, match_mode,
                    trigger_keywords_json, exclude_keywords_json, requires_source_images, min_source_images, max_source_images,
                    requires_confirmation, allow_auto_execute, clarification_enabled, clarification_required_fields_json,
                    clarification_fallback_question, system_prompt, prompt_template, negative_prompt_template,
                    recommended_action_template, output_final_prompt, output_final_negative_prompt,
                    output_recommended_action, output_clarification_question, notes, created_at, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                    ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29
                )",
                params![
                    template.id,
                    template.name,
                    if template.enabled { 1 } else { 0 },
                    template.priority,
                    template.category,
                    template.scene,
                    template.intent,
                    template.match_mode,
                    trigger_keywords_json,
                    exclude_keywords_json,
                    if template.requires_source_images { 1 } else { 0 },
                    template.min_source_images,
                    template.max_source_images,
                    if template.requires_confirmation { 1 } else { 0 },
                    if template.allow_auto_execute { 1 } else { 0 },
                    if template.clarification_rules.enabled { 1 } else { 0 },
                    clarification_required_fields_json,
                    template.clarification_rules.fallback_question,
                    template.system_prompt,
                    template.prompt_template,
                    template.negative_prompt_template,
                    template.recommended_action_template,
                    if template.output_schema.final_prompt { 1 } else { 0 },
                    if template.output_schema.final_negative_prompt { 1 } else { 0 },
                    if template.output_schema.recommended_action { 1 } else { 0 },
                    if template.output_schema.clarification_question { 1 } else { 0 },
                    template.notes,
                    template.created_at,
                    template.updated_at,
                ],
            ).map_err(|e| e.to_string())?;
        }
    }

    if style_count == 0 {
        let style_templates = vec![
            AgentStyleTemplate {
                id: "realistic_photo_style".to_string(),
                name: "写实摄影".to_string(),
                style_group: "visual_style".to_string(),
                trigger_keywords: vec!["写实".to_string(), "真实".to_string(), "摄影".to_string()],
                style_prompt_fragment: "整体采用真实摄影风格，光影自然，细节清晰，质感真实。".to_string(),
                negative_prompt_fragment: "假脸，塑料感，卡通感，低清晰度".to_string(),
                compatible_scenes: vec!["general".to_string(), "amazon_a_plus".to_string(), "ecommerce_main".to_string(), "img2img_merge".to_string()],
                created_at: now.clone(),
                updated_at: now.clone(),
                ..AgentStyleTemplate::default()
            },
            AgentStyleTemplate {
                id: "premium_commercial_style".to_string(),
                name: "高端商业广告".to_string(),
                style_group: "platform".to_string(),
                trigger_keywords: vec!["商业".to_string(), "高级".to_string(), "广告感".to_string()],
                style_prompt_fragment: "整体呈现高端商业广告摄影风格，构图克制，主体突出，画面高级。".to_string(),
                negative_prompt_fragment: "廉价感，画面拥挤，主体不突出".to_string(),
                compatible_scenes: vec!["general".to_string(), "amazon_a_plus".to_string(), "brand_scene".to_string(), "ecommerce_main".to_string()],
                created_at: now.clone(),
                updated_at: now.clone(),
                ..AgentStyleTemplate::default()
            },
            AgentStyleTemplate {
                id: "cyberpunk_style".to_string(),
                name: "赛博朋克风格".to_string(),
                style_group: "visual_style".to_string(),
                trigger_keywords: vec!["赛博朋克".to_string(), "cyberpunk".to_string(), "霓虹未来".to_string()],
                style_prompt_fragment: "整体采用赛博朋克视觉风格，带有霓虹灯光、未来都市氛围和强烈的冷暖光影对比。".to_string(),
                negative_prompt_fragment: "风格不统一，低质霓虹效果，背景脏乱".to_string(),
                compatible_scenes: vec!["general".to_string(), "poster".to_string(), "brand_scene".to_string()],
                created_at: now.clone(),
                updated_at: now.clone(),
                ..AgentStyleTemplate::default()
            },
            AgentStyleTemplate {
                id: "clean_ecommerce_style".to_string(),
                name: "干净电商风".to_string(),
                style_group: "platform".to_string(),
                trigger_keywords: vec!["电商".to_string(), "主图".to_string(), "白底".to_string()],
                style_prompt_fragment: "画面干净简洁，主体边缘清晰，适合电商展示。".to_string(),
                negative_prompt_fragment: "背景杂乱，构图失衡，信息干扰".to_string(),
                compatible_scenes: vec!["ecommerce_main".to_string(), "amazon_a_plus".to_string(), "general".to_string()],
                created_at: now.clone(),
                updated_at: now.clone(),
                ..AgentStyleTemplate::default()
            },
        ];

        for template in style_templates {
            let trigger_keywords_json = serde_json::to_string(&template.trigger_keywords).map_err(|e| e.to_string())?;
            let exclude_keywords_json = serde_json::to_string(&template.exclude_keywords).map_err(|e| e.to_string())?;
            let compatible_intents_json = serde_json::to_string(&template.compatible_intents).map_err(|e| e.to_string())?;
            let compatible_scenes_json = serde_json::to_string(&template.compatible_scenes).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT OR IGNORE INTO agent_style_templates (
                    id, name, enabled, priority, style_group, trigger_keywords_json, exclude_keywords_json,
                    style_prompt_fragment, negative_prompt_fragment, compatible_intents_json, compatible_scenes_json,
                    notes, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    template.id,
                    template.name,
                    if template.enabled { 1 } else { 0 },
                    template.priority,
                    template.style_group,
                    trigger_keywords_json,
                    exclude_keywords_json,
                    template.style_prompt_fragment,
                    template.negative_prompt_fragment,
                    compatible_intents_json,
                    compatible_scenes_json,
                    template.notes,
                    template.created_at,
                    template.updated_at,
                ],
            ).map_err(|e| e.to_string())?;
        }
    }

    let iphone_style_template = AgentStyleTemplate {
        id: "iphone_ecommerce_style".to_string(),
        name: "iPhone 风格电商".to_string(),
        style_group: "platform".to_string(),
        trigger_keywords: vec![
            "iphone".to_string(),
            "iPhone".to_string(),
            "苹果风".to_string(),
            "苹果官网".to_string(),
            "apple风".to_string(),
            "科技发布会".to_string(),
            "新品发布".to_string(),
        ],
        style_prompt_fragment: "整体采用 iPhone 新品发布页式电商视觉语言，极简留白背景，中心化构图，画面干净克制，高级科技感，柔和渐变配色，真实产品材质与精细边缘，高光控制自然。适合纵向详情页排版，预留标题、卖点和参数说明区域，呈现苹果官网式高级商业展示效果。".to_string(),
        negative_prompt_fragment: "背景杂乱，廉价电商风，过度饱和，夸张光效，低端海报感，字体区域拥挤，塑料质感，产品比例错误".to_string(),
        compatible_scenes: vec!["ecommerce_main".to_string(), "amazon_a_plus".to_string(), "general".to_string()],
        created_at: now.clone(),
        updated_at: now.clone(),
        ..AgentStyleTemplate::default()
    };

    let trigger_keywords_json = serde_json::to_string(&iphone_style_template.trigger_keywords).map_err(|e| e.to_string())?;
    let exclude_keywords_json = serde_json::to_string(&iphone_style_template.exclude_keywords).map_err(|e| e.to_string())?;
    let compatible_intents_json = serde_json::to_string(&iphone_style_template.compatible_intents).map_err(|e| e.to_string())?;
    let compatible_scenes_json = serde_json::to_string(&iphone_style_template.compatible_scenes).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO agent_style_templates (
            id, name, enabled, priority, style_group, trigger_keywords_json, exclude_keywords_json,
            style_prompt_fragment, negative_prompt_fragment, compatible_intents_json, compatible_scenes_json,
            notes, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            enabled = excluded.enabled,
            priority = excluded.priority,
            style_group = excluded.style_group,
            trigger_keywords_json = excluded.trigger_keywords_json,
            exclude_keywords_json = excluded.exclude_keywords_json,
            style_prompt_fragment = excluded.style_prompt_fragment,
            negative_prompt_fragment = excluded.negative_prompt_fragment,
            compatible_intents_json = excluded.compatible_intents_json,
            compatible_scenes_json = excluded.compatible_scenes_json,
            notes = excluded.notes,
            updated_at = excluded.updated_at",
        params![
            iphone_style_template.id,
            iphone_style_template.name,
            if iphone_style_template.enabled { 1 } else { 0 },
            iphone_style_template.priority,
            iphone_style_template.style_group,
            trigger_keywords_json,
            exclude_keywords_json,
            iphone_style_template.style_prompt_fragment,
            iphone_style_template.negative_prompt_fragment,
            compatible_intents_json,
            compatible_scenes_json,
            iphone_style_template.notes,
            iphone_style_template.created_at,
            iphone_style_template.updated_at,
        ],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

fn row_to_task_template(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentTaskTemplate> {
    let trigger_keywords_json: String = row.get("trigger_keywords_json")?;
    let exclude_keywords_json: String = row.get("exclude_keywords_json")?;
    let clarification_required_fields_json: String = row.get("clarification_required_fields_json")?;
    Ok(AgentTaskTemplate {
        id: row.get("id")?,
        name: row.get("name")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        priority: row.get("priority")?,
        category: row.get("category")?,
        scene: row.get("scene")?,
        intent: row.get("intent")?,
        match_mode: row.get("match_mode")?,
        trigger_keywords: parse_json_array(&trigger_keywords_json),
        exclude_keywords: parse_json_array(&exclude_keywords_json),
        requires_source_images: row.get::<_, i64>("requires_source_images")? != 0,
        min_source_images: row.get("min_source_images")?,
        max_source_images: row.get("max_source_images")?,
        requires_confirmation: row.get::<_, i64>("requires_confirmation")? != 0,
        allow_auto_execute: row.get::<_, i64>("allow_auto_execute")? != 0,
        clarification_rules: AgentTemplateClarificationRules {
            enabled: row.get::<_, i64>("clarification_enabled")? != 0,
            required_fields: parse_json_array(&clarification_required_fields_json),
            fallback_question: row.get("clarification_fallback_question")?,
        },
        system_prompt: row.get("system_prompt")?,
        prompt_template: row.get("prompt_template")?,
        negative_prompt_template: row.get("negative_prompt_template")?,
        recommended_action_template: row.get("recommended_action_template")?,
        output_schema: AgentTemplateOutputSchema {
            final_prompt: row.get::<_, i64>("output_final_prompt")? != 0,
            final_negative_prompt: row.get::<_, i64>("output_final_negative_prompt")? != 0,
            recommended_action: row.get::<_, i64>("output_recommended_action")? != 0,
            clarification_question: row.get::<_, i64>("output_clarification_question")? != 0,
        },
        notes: row.get("notes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_style_template(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentStyleTemplate> {
    let trigger_keywords_json: String = row.get("trigger_keywords_json")?;
    let exclude_keywords_json: String = row.get("exclude_keywords_json")?;
    let compatible_intents_json: String = row.get("compatible_intents_json")?;
    let compatible_scenes_json: String = row.get("compatible_scenes_json")?;
    Ok(AgentStyleTemplate {
        id: row.get("id")?,
        name: row.get("name")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        priority: row.get("priority")?,
        style_group: row.get("style_group")?,
        trigger_keywords: parse_json_array(&trigger_keywords_json),
        exclude_keywords: parse_json_array(&exclude_keywords_json),
        style_prompt_fragment: row.get("style_prompt_fragment")?,
        negative_prompt_fragment: row.get("negative_prompt_fragment")?,
        compatible_intents: parse_json_array(&compatible_intents_json),
        compatible_scenes: parse_json_array(&compatible_scenes_json),
        notes: row.get("notes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_template_log(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentTemplateLog> {
    let matched_style_template_ids_json: String = row.get("matched_style_template_ids_json")?;
    Ok(AgentTemplateLog {
        id: row.get("id")?,
        conversation_id: row.get("conversation_id")?,
        message_id: row.get("message_id")?,
        task_id: row.get("task_id")?,
        matched_task_template_id: row.get("matched_task_template_id")?,
        matched_style_template_ids: parse_json_array(&matched_style_template_ids_json),
        user_prompt_raw: row.get("user_prompt_raw")?,
        final_prompt: row.get("final_prompt")?,
        final_negative_prompt: row.get("final_negative_prompt")?,
        recommended_action: row.get("recommended_action")?,
        intent: row.get("intent")?,
        api_kind: row.get("api_kind")?,
        confidence: row.get("confidence")?,
        created_at: row.get("created_at")?,
    })
}

pub fn get_agent_task_templates(app: &AppHandle) -> Result<Vec<AgentTaskTemplate>, String> {
    let conn = open_app_db(app)?;
    seed_default_agent_templates(&conn)?;
    let mut stmt = conn
        .prepare("SELECT * FROM agent_task_templates ORDER BY enabled DESC, priority DESC, updated_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_task_template)
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn save_agent_task_template(app: &AppHandle, mut template: AgentTaskTemplate) -> Result<AgentTaskTemplate, String> {
    let conn = open_app_db(app)?;
    let now = chrono::Local::now().to_rfc3339();
    if template.id.trim().is_empty() {
        template.id = format!("task_{}", uuid::Uuid::new_v4().simple());
    }
    if template.created_at.trim().is_empty() {
        template.created_at = now.clone();
    }
    template.updated_at = now;
    let trigger_keywords_json = stringify_json_array(&template.trigger_keywords)?;
    let exclude_keywords_json = stringify_json_array(&template.exclude_keywords)?;
    let clarification_required_fields_json = stringify_json_array(&template.clarification_rules.required_fields)?;
    conn.execute(
        "INSERT INTO agent_task_templates (
            id, name, enabled, priority, category, scene, intent, match_mode,
            trigger_keywords_json, exclude_keywords_json, requires_source_images, min_source_images, max_source_images,
            requires_confirmation, allow_auto_execute, clarification_enabled, clarification_required_fields_json,
            clarification_fallback_question, system_prompt, prompt_template, negative_prompt_template,
            recommended_action_template, output_final_prompt, output_final_negative_prompt,
            output_recommended_action, output_clarification_question, notes, created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
            ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29
        )
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            enabled = excluded.enabled,
            priority = excluded.priority,
            category = excluded.category,
            scene = excluded.scene,
            intent = excluded.intent,
            match_mode = excluded.match_mode,
            trigger_keywords_json = excluded.trigger_keywords_json,
            exclude_keywords_json = excluded.exclude_keywords_json,
            requires_source_images = excluded.requires_source_images,
            min_source_images = excluded.min_source_images,
            max_source_images = excluded.max_source_images,
            requires_confirmation = excluded.requires_confirmation,
            allow_auto_execute = excluded.allow_auto_execute,
            clarification_enabled = excluded.clarification_enabled,
            clarification_required_fields_json = excluded.clarification_required_fields_json,
            clarification_fallback_question = excluded.clarification_fallback_question,
            system_prompt = excluded.system_prompt,
            prompt_template = excluded.prompt_template,
            negative_prompt_template = excluded.negative_prompt_template,
            recommended_action_template = excluded.recommended_action_template,
            output_final_prompt = excluded.output_final_prompt,
            output_final_negative_prompt = excluded.output_final_negative_prompt,
            output_recommended_action = excluded.output_recommended_action,
            output_clarification_question = excluded.output_clarification_question,
            notes = excluded.notes,
            updated_at = excluded.updated_at",
        params![
            template.id,
            template.name,
            if template.enabled { 1 } else { 0 },
            template.priority,
            template.category,
            template.scene,
            template.intent,
            template.match_mode,
            trigger_keywords_json,
            exclude_keywords_json,
            if template.requires_source_images { 1 } else { 0 },
            template.min_source_images,
            template.max_source_images,
            if template.requires_confirmation { 1 } else { 0 },
            if template.allow_auto_execute { 1 } else { 0 },
            if template.clarification_rules.enabled { 1 } else { 0 },
            clarification_required_fields_json,
            template.clarification_rules.fallback_question,
            template.system_prompt,
            template.prompt_template,
            template.negative_prompt_template,
            template.recommended_action_template,
            if template.output_schema.final_prompt { 1 } else { 0 },
            if template.output_schema.final_negative_prompt { 1 } else { 0 },
            if template.output_schema.recommended_action { 1 } else { 0 },
            if template.output_schema.clarification_question { 1 } else { 0 },
            template.notes,
            template.created_at,
            template.updated_at,
        ],
    ).map_err(|e| e.to_string())?;
    Ok(template)
}

pub fn delete_agent_task_template(app: &AppHandle, id: &str) -> Result<(), String> {
    let conn = open_app_db(app)?;
    conn.execute("DELETE FROM agent_task_templates WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn toggle_agent_task_template(app: &AppHandle, id: &str, enabled: bool) -> Result<(), String> {
    let conn = open_app_db(app)?;
    conn.execute(
        "UPDATE agent_task_templates SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, if enabled { 1 } else { 0 }, chrono::Local::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_agent_style_templates(app: &AppHandle) -> Result<Vec<AgentStyleTemplate>, String> {
    let conn = open_app_db(app)?;
    seed_default_agent_templates(&conn)?;
    let mut stmt = conn
        .prepare("SELECT * FROM agent_style_templates ORDER BY enabled DESC, priority DESC, updated_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_style_template)
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn save_agent_style_template(app: &AppHandle, mut template: AgentStyleTemplate) -> Result<AgentStyleTemplate, String> {
    let conn = open_app_db(app)?;
    let now = chrono::Local::now().to_rfc3339();
    if template.id.trim().is_empty() {
        template.id = format!("style_{}", uuid::Uuid::new_v4().simple());
    }
    if template.created_at.trim().is_empty() {
        template.created_at = now.clone();
    }
    template.updated_at = now;
    let trigger_keywords_json = stringify_json_array(&template.trigger_keywords)?;
    let exclude_keywords_json = stringify_json_array(&template.exclude_keywords)?;
    let compatible_intents_json = stringify_json_array(&template.compatible_intents)?;
    let compatible_scenes_json = stringify_json_array(&template.compatible_scenes)?;
    conn.execute(
        "INSERT INTO agent_style_templates (
            id, name, enabled, priority, style_group, trigger_keywords_json, exclude_keywords_json,
            style_prompt_fragment, negative_prompt_fragment, compatible_intents_json, compatible_scenes_json,
            notes, created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
        )
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            enabled = excluded.enabled,
            priority = excluded.priority,
            style_group = excluded.style_group,
            trigger_keywords_json = excluded.trigger_keywords_json,
            exclude_keywords_json = excluded.exclude_keywords_json,
            style_prompt_fragment = excluded.style_prompt_fragment,
            negative_prompt_fragment = excluded.negative_prompt_fragment,
            compatible_intents_json = excluded.compatible_intents_json,
            compatible_scenes_json = excluded.compatible_scenes_json,
            notes = excluded.notes,
            updated_at = excluded.updated_at",
        params![
            template.id,
            template.name,
            if template.enabled { 1 } else { 0 },
            template.priority,
            template.style_group,
            trigger_keywords_json,
            exclude_keywords_json,
            template.style_prompt_fragment,
            template.negative_prompt_fragment,
            compatible_intents_json,
            compatible_scenes_json,
            template.notes,
            template.created_at,
            template.updated_at,
        ],
    ).map_err(|e| e.to_string())?;
    Ok(template)
}

pub fn delete_agent_style_template(app: &AppHandle, id: &str) -> Result<(), String> {
    let conn = open_app_db(app)?;
    conn.execute("DELETE FROM agent_style_templates WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn toggle_agent_style_template(app: &AppHandle, id: &str, enabled: bool) -> Result<(), String> {
    let conn = open_app_db(app)?;
    conn.execute(
        "UPDATE agent_style_templates SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, if enabled { 1 } else { 0 }, chrono::Local::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_agent_template_logs(app: &AppHandle, limit: Option<usize>) -> Result<Vec<AgentTemplateLog>, String> {
    let conn = open_app_db(app)?;
    let max_rows = limit.unwrap_or(200).clamp(1, 1000) as i64;
    let mut stmt = conn
        .prepare("SELECT * FROM agent_template_logs ORDER BY created_at DESC LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![max_rows], row_to_template_log)
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn append_agent_template_log(app: &AppHandle, mut log: AgentTemplateLog) -> Result<AgentTemplateLog, String> {
    let conn = open_app_db(app)?;
    if log.id.trim().is_empty() {
        log.id = uuid::Uuid::new_v4().to_string();
    }
    if log.created_at.trim().is_empty() {
        log.created_at = chrono::Local::now().to_rfc3339();
    }
    let matched_style_template_ids_json = stringify_json_array(&log.matched_style_template_ids)?;
    conn.execute(
        "INSERT OR REPLACE INTO agent_template_logs (
            id, conversation_id, message_id, task_id, matched_task_template_id, matched_style_template_ids_json,
            user_prompt_raw, final_prompt, final_negative_prompt, recommended_action, intent, api_kind, confidence, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            log.id,
            log.conversation_id,
            log.message_id,
            log.task_id,
            log.matched_task_template_id,
            matched_style_template_ids_json,
            log.user_prompt_raw,
            log.final_prompt,
            log.final_negative_prompt,
            log.recommended_action,
            log.intent,
            log.api_kind,
            log.confidence,
            log.created_at,
        ],
    ).map_err(|e| e.to_string())?;
    Ok(log)
}

pub fn export_agent_templates(app: &AppHandle) -> Result<AgentTemplateExportPayload, String> {
    Ok(AgentTemplateExportPayload {
        version: 1,
        task_templates: get_agent_task_templates(app)?,
        style_templates: get_agent_style_templates(app)?,
    })
}

pub fn import_agent_templates(app: &AppHandle, payload: AgentTemplateImportPayload, conflict_mode: &str) -> Result<AgentTemplateExportPayload, String> {
    let existing_task_ids: std::collections::HashSet<String> = get_agent_task_templates(app)?.into_iter().map(|t| t.id).collect();
    let existing_style_ids: std::collections::HashSet<String> = get_agent_style_templates(app)?.into_iter().map(|t| t.id).collect();
    let overwrite = conflict_mode.eq_ignore_ascii_case("overwrite");

    for template in payload.task_templates {
        if !overwrite && existing_task_ids.contains(&template.id) {
            continue;
        }
        let _ = save_agent_task_template(app, template)?;
    }
    for template in payload.style_templates {
        if !overwrite && existing_style_ids.contains(&template.id) {
            continue;
        }
        let _ = save_agent_style_template(app, template)?;
    }

    export_agent_templates(app)
}

fn read_db_value(path: &PathBuf) -> Option<String> {
    let conn = open_db(path)?;
    let key = key_for_path(path);
    let value: Option<String> = conn
        .query_row("SELECT value_json FROM kv_store WHERE key = ?1", params![key], |row| row.get(0))
        .ok();
    if value.is_some() {
        return value;
    }

    if path.exists() {
        let legacy = fs::read_to_string(path).ok()?;
        let now = chrono::Local::now().to_rfc3339();
        let _ = conn.execute(
            "INSERT OR REPLACE INTO kv_store (key, value_json, updated_at) VALUES (?1, ?2, ?3)",
            params![key_for_path(path), legacy, now],
        );
        let _ = conn.execute(
            "INSERT OR IGNORE INTO migrations (id, applied_at) VALUES (?1, ?2)",
            params![format!("json_import_{}", key_for_path(path)), chrono::Local::now().to_rfc3339()],
        );
        return fs::read_to_string(path).ok();
    }
    None
}

fn write_db_value(path: &PathBuf, json: &str) {
    if let Some(conn) = open_db(path) {
        let now = chrono::Local::now().to_rfc3339();
        let _ = conn.execute(
            "INSERT OR REPLACE INTO kv_store (key, value_json, updated_at) VALUES (?1, ?2, ?3)",
            params![key_for_path(path), json, now],
        );
    }
    if path.exists() {
        let backup = path.with_extension("json.bak");
        if !backup.exists() {
            let _ = fs::copy(path, backup);
        }
    }
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &PathBuf, default: T) -> T {
    read_db_value(path)
        .or_else(|| fs::read_to_string(path).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(default)
}

pub fn write_json<T: serde::Serialize>(path: &PathBuf, data: &T) {
    if let Ok(json) = serde_json::to_string_pretty(data) {
        write_db_value(path, &json);
        let _ = fs::write(path, json);
    }
}

// Simple file-based locking to prevent concurrent access issues
static TASK_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static IMAGE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

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
    let _lock = IMAGE_LOCK.lock().unwrap();
    let path = images_path(app);
    let mut images: Vec<ImageRecord> = read_json(&path, Vec::new());
    let result = f(&mut images);
    write_json(&path, &images);
    result
}
