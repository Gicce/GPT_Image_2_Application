//! 统一图片评价系统（ImageEvaluation V1）：
//! - 评价绑定图片资产（ImageRecord.id），而不是仅任务 —— 一个任务可产出多张图，
//!   每张图独立评分；任务层聚合（best / average）由前端从各资产行计算。
//! - AI 评分 0~100 整数；不适用的维度为 null（绝不当 0 分，0 是合法低分）。
//! - `evaluate_image`：任务感知评价（参考原图 + 修改要求 + preserve/change 语义
//!   + 生成结果 → 分维度评分），调用 BYOK 视觉模型（与 vision.rs 同一条链路，
//!   不产生服务端计费）；失败绝不影响生成任务（评价在任务完成后异步发生）。
//! - 持久化：app.db `image_evaluations` 表（asset_id 主键；重新评价覆盖 AI 字段、
//!   保留用户反馈字段）；`evaluation_version` 标记评分口径版本。

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::storage;
use crate::vision::{call_vision_model, encode_image_data_url};

/// 评价口径版本：Prompt / 权重 / 模型变化后必须递增，旧分新分不可混读。
pub const EVALUATION_VERSION: &str = "image-eval-v1";

// ======================= 数据结构（snake_case 直出，与 TS 镜像） =======================

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ImageEvaluation {
    /// 图片资产 id（ImageRecord.id，uuid v4）——评价唯一归属。
    pub asset_id: String,
    /// 资产本地路径冗余（资产行缺失 / 重扫合并时的降级匹配键）。
    pub asset_path: String,
    pub task_id: String,
    /// vision_recreation | i2i | t2i（决定 overall 权重）。
    pub task_kind: String,
    pub evaluation_version: String,
    /// 综合完成度 0~100；未评价 = null。
    pub overall_score: Option<i32>,
    pub instruction_adherence: Option<i32>,
    pub subject_consistency: Option<i32>,
    pub reference_preservation: Option<i32>,
    pub style_consistency: Option<i32>,
    pub composition_quality: Option<i32>,
    pub technical_quality: Option<i32>,
    #[serde(default)]
    pub strengths: Vec<String>,
    #[serde(default)]
    pub issues: Vec<String>,
    pub suggestion: String,
    /// 评价时的 preserve / change 语义快照（任务感知评分的依据留档）。
    #[serde(default)]
    pub preserve: Vec<String>,
    #[serde(default)]
    pub change: Vec<String>,
    pub edit_instruction: String,
    pub evaluated_by: String,
    pub evaluated_at: String,
    /// 用户反馈与 AI 评分严格分离：liked = 满意（成功方案），disliked = 需要调整。
    pub user_rating: Option<String>,
    #[serde(default)]
    pub user_issue_tags: Vec<String>,
    pub user_comment: String,
    pub user_feedback_at: String,
    /// 用户收藏 / 精选标记（与满意 👍 分离；重新评价时保留）。
    #[serde(default)]
    pub favorite: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct EvaluateImageRequest {
    pub asset_id: String,
    pub asset_path: String,
    pub task_id: String,
    pub task_kind: String,
    /// 参考原图路径（i2i / 视觉复刻必有；t2i 无 → 相关维度 null）。
    pub reference_path: Option<String>,
    /// 用户修改要求（视觉复刻 = 调整要求；普通任务 = 用户原始需求）。
    #[serde(default)]
    pub edit_instruction: String,
    /// 参考图 AI 理解摘要（视觉复刻链路提供，帮助评审理解原图）。
    #[serde(default)]
    pub understanding_summary: String,
    #[serde(default)]
    pub preserve: Vec<String>,
    #[serde(default)]
    pub change: Vec<String>,
    pub base_url: String,
    pub token: String,
    pub model: String,
}

#[derive(Debug, Serialize)]
pub struct EvaluateImageResult {
    pub ok: bool,
    pub evaluation: Option<ImageEvaluation>,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
    pub status: Option<u16>,
}

/// 模型返回的原始维度分（0~100 或 null；小数 / 0~1 小数由归一层处理）。
#[derive(Debug, Default, Deserialize)]
struct RawEvaluationScores {
    instruction_adherence: Option<f64>,
    subject_consistency: Option<f64>,
    reference_preservation: Option<f64>,
    style_consistency: Option<f64>,
    composition_quality: Option<f64>,
    technical_quality: Option<f64>,
    #[serde(default)]
    strengths: Vec<String>,
    #[serde(default)]
    issues: Vec<String>,
    #[serde(default)]
    suggestion: String,
}

// ======================= 评分归一 / 动态权重 =======================

/// 单维归一：null 保持 null；≤1.5 视为 0~1 小数（×100）；随后 clamp 0..=100 取整。
fn normalize_score(raw: Option<f64>) -> Option<i32> {
    let value = raw?;
    let scaled = if value <= 1.5 { value * 100.0 } else { value };
    Some(scaled.clamp(0.0, 100.0).round() as i32)
}

/// 动态整体分：按任务类型取权重预设，null 维度退出加权并重新归一。
/// 视觉复刻重主体/参考保持；普通图生图重指令/技术；文生图只聚合适用维度。
fn compute_overall(kind: &str, e: &ImageEvaluation) -> Option<i32> {
    const VISION_RECREATION: &[(&str, f64)] = &[
        ("instruction", 0.25), ("subject", 0.25), ("reference", 0.20),
        ("style", 0.15), ("composition", 0.10), ("technical", 0.05),
    ];
    const I2I: &[(&str, f64)] = &[
        ("instruction", 0.35), ("subject", 0.15), ("reference", 0.20),
        ("style", 0.05), ("composition", 0.10), ("technical", 0.15),
    ];
    const T2I: &[(&str, f64)] = &[
        ("instruction", 0.45), ("style", 0.15),
        ("composition", 0.20), ("technical", 0.20),
    ];
    let weights = match kind {
        "vision_recreation" => VISION_RECREATION,
        "i2i" => I2I,
        _ => T2I,
    };
    let pick = |key: &str| match key {
        "instruction" => e.instruction_adherence,
        "subject" => e.subject_consistency,
        "reference" => e.reference_preservation,
        "style" => e.style_consistency,
        "composition" => e.composition_quality,
        _ => e.technical_quality,
    };
    let mut weighted = 0.0f64;
    let mut total = 0.0f64;
    for (key, weight) in weights {
        if let Some(score) = pick(key) {
            weighted += score as f64 * weight;
            total += weight;
        }
    }
    if total <= f64::EPSILON {
        return None;
    }
    Some((weighted / total).round() as i32)
}

// ======================= 评审 Prompt =======================

const EVALUATION_SYSTEM_PROMPT: &str = r#"你是「AI 图像生成结果评审器」。用户会给你参考原图（可能没有）与生成结果图，以及用户的修改要求。你的任务是评价生成结果对任务的完成度。

最高原则：完成度 ≠ 相似度。
- 「Change（要求修改）」中的内容：生成图与原图不同是正确行为，绝不能因「与原图不一样」扣分，只评价修改是否按要求完成。
- 「Preserve（要求保持）」中的内容：必须与参考原图一致，走样要扣分。
- 没有参考原图时，subject_consistency 与 reference_preservation 必须返回 null。
- 任务不涉及某维度（例如无主体身份要求）时该维度返回 null，绝不为不适用维度硬造 0 分。

评分维度（0~100 整数，或 null）：
- instruction_adherence：用户的修改要求是否真正完成（最重要维度）。
- subject_consistency：人物 / 产品 / 主体身份特征与参考原图的一致性。
- reference_preservation：Preserve 列表内容是否保持（不评价 Change 部分）。
- style_consistency：画风 / 摄影风格 / 整体视觉语言一致性。
- composition_quality：结果图自身构图合理性（不要求与原图构图相同）。
- technical_quality：技术质量——明显畸形、多手指 / 多肢体、重影、模糊、伪影、错误文字、面部异常。

其他字段：
- strengths：具体优点（最多 3 条）。
- issues：具体问题（最多 3 条，可行动）。
- suggestion：给下一轮生成的改进建议（一句话）。

严格只输出一个 JSON 对象，不要任何解释或 Markdown 围栏：
{
  "instruction_adherence": 0, "subject_consistency": 0, "reference_preservation": 0,
  "style_consistency": 0, "composition_quality": 0, "technical_quality": 0,
  "strengths": ["…"], "issues": ["…"], "suggestion": "…"
}"#;

fn build_evaluation_user_text(request: &EvaluateImageRequest) -> String {
    let mut lines: Vec<String> = Vec::new();
    if request.understanding_summary.trim().is_empty() {
        lines.push("（无参考图 AI 理解摘要）".to_string());
    } else {
        lines.push(format!("参考图理解摘要：{}", request.understanding_summary.trim()));
    }
    if request.edit_instruction.trim().is_empty() {
        lines.push("用户修改要求：未提供（按「尽量复刻参考图」评价指令完成度）".to_string());
    } else {
        lines.push(format!("用户修改要求：{}", request.edit_instruction.trim()));
    }
    if request.preserve.is_empty() {
        lines.push("Preserve（要求保持）：未指定".to_string());
    } else {
        lines.push(format!("Preserve（要求保持）：{}", request.preserve.join("；")));
    }
    if request.change.is_empty() {
        lines.push("Change（要求修改）：未指定".to_string());
    } else {
        lines.push(format!("Change（要求修改）：{}", request.change.join("；")));
    }
    lines.push("图片顺序：第 1 张是参考原图（如提供），最后 1 张是生成结果图。请按维度评分。".to_string());
    lines.join("\n")
}

/// 评审 JSON 解析：剥围栏 → 首个平衡对象 → 兼容 evaluation 包裹键。
fn parse_evaluation_text(text: &str) -> Result<RawEvaluationScores, String> {
    let trimmed = text.trim();
    let without_fence = if trimmed.starts_with("```") {
        trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```JSON")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
    } else {
        trimmed
    };
    let bytes = without_fence.as_bytes();
    let start = bytes
        .iter()
        .position(|b| *b == b'{')
        .ok_or_else(|| "评审未返回 JSON 对象".to_string())?;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    let mut end = None;
    for (i, b) in bytes.iter().enumerate().skip(start) {
        if escaped {
            escaped = false;
            continue;
        }
        match b {
            b'\\' if in_string => escaped = true,
            b'"' => in_string = !in_string,
            b'{' if !in_string => depth += 1,
            b'}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    end = Some(i);
                    break;
                }
            }
            _ => {}
        }
    }
    let end = end.ok_or_else(|| "评审 JSON 未闭合".to_string())?;
    let json_text = without_fence
        .get(start..=end)
        .ok_or_else(|| "评审 JSON 截取失败".to_string())?;
    let value: serde_json::Value = serde_json::from_str(json_text)
        .map_err(|e| format!("评审 JSON 解析失败：{}", e))?;
    let target = if value.get("evaluation").is_some() {
        value.get("evaluation").cloned().unwrap_or(value)
    } else {
        value
    };
    serde_json::from_value::<RawEvaluationScores>(target)
        .map_err(|e| format!("评审结构不符合约定：{}", e))
}

// ======================= 持久化（app.db image_evaluations） =======================

fn row_to_evaluation(row: &rusqlite::Row<'_>) -> rusqlite::Result<ImageEvaluation> {
    let parse_vec = |json: String| serde_json::from_str::<Vec<String>>(&json).unwrap_or_default();
    Ok(ImageEvaluation {
        asset_id: row.get("asset_id")?,
        asset_path: row.get("asset_path")?,
        task_id: row.get("task_id")?,
        task_kind: row.get("task_kind")?,
        evaluation_version: row.get("evaluation_version")?,
        overall_score: row.get("overall_score")?,
        instruction_adherence: row.get("instruction_adherence")?,
        subject_consistency: row.get("subject_consistency")?,
        reference_preservation: row.get("reference_preservation")?,
        style_consistency: row.get("style_consistency")?,
        composition_quality: row.get("composition_quality")?,
        technical_quality: row.get("technical_quality")?,
        strengths: parse_vec(row.get("strengths_json")?),
        issues: parse_vec(row.get("issues_json")?),
        suggestion: row.get("suggestion")?,
        preserve: parse_vec(row.get("preserve_json")?),
        change: parse_vec(row.get("change_json")?),
        edit_instruction: row.get("edit_instruction")?,
        evaluated_by: row.get("evaluated_by")?,
        evaluated_at: row.get("evaluated_at")?,
        user_rating: row.get("user_rating")?,
        user_issue_tags: parse_vec(row.get("user_issue_tags_json")?),
        user_comment: row.get("user_comment")?,
        user_feedback_at: row.get("user_feedback_at")?,
        favorite: row.get::<_, Option<i32>>("favorite")?.unwrap_or(0) != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

const EVALUATION_COLUMNS: &str = "asset_id, asset_path, task_id, task_kind, evaluation_version, \
overall_score, instruction_adherence, subject_consistency, reference_preservation, \
style_consistency, composition_quality, technical_quality, strengths_json, issues_json, \
suggestion, preserve_json, change_json, edit_instruction, evaluated_by, evaluated_at, \
user_rating, user_issue_tags_json, user_comment, user_feedback_at, favorite, created_at, updated_at";

fn stringify_vec(values: &[String]) -> Result<String, String> {
    serde_json::to_string(values).map_err(|e| e.to_string())
}

/// 保存 / 覆盖 AI 评价（asset_id 主键 upsert）：重新评价只覆盖 AI 字段，
/// user_rating / user_issue_tags / user_comment / user_feedback_at 原样保留。
pub fn upsert_evaluation(
    app: &AppHandle,
    evaluation: &ImageEvaluation,
) -> Result<ImageEvaluation, String> {
    let conn = storage::open_app_db(app)?;
    let now = chrono::Local::now().to_rfc3339();
    let mut saved = evaluation.clone();
    // 已有记录：保留 created_at 与用户反馈字段（重新评价不冲掉用户历史）。
    let existing: Option<ImageEvaluation> = conn
        .query_row(
            &format!("SELECT {} FROM image_evaluations WHERE asset_id = ?1", EVALUATION_COLUMNS),
            rusqlite::params![evaluation.asset_id],
            row_to_evaluation,
        )
        .ok();
    if let Some(prev) = &existing {
        saved.created_at = prev.created_at.clone();
        saved.user_rating = prev.user_rating.clone();
        saved.user_issue_tags = prev.user_issue_tags.clone();
        saved.user_comment = prev.user_comment.clone();
        saved.user_feedback_at = prev.user_feedback_at.clone();
        saved.favorite = prev.favorite;
    } else {
        saved.created_at = now.clone();
    }
    saved.updated_at = now;
    conn.execute(
        "INSERT INTO image_evaluations (
            asset_id, asset_path, task_id, task_kind, evaluation_version,
            overall_score, instruction_adherence, subject_consistency, reference_preservation,
            style_consistency, composition_quality, technical_quality,
            strengths_json, issues_json, suggestion, preserve_json, change_json,
            edit_instruction, evaluated_by, evaluated_at,
            user_rating, user_issue_tags_json, user_comment, user_feedback_at,
            favorite, created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
            ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27
        )
        ON CONFLICT(asset_id) DO UPDATE SET
            asset_path = excluded.asset_path,
            task_id = excluded.task_id,
            task_kind = excluded.task_kind,
            evaluation_version = excluded.evaluation_version,
            overall_score = excluded.overall_score,
            instruction_adherence = excluded.instruction_adherence,
            subject_consistency = excluded.subject_consistency,
            reference_preservation = excluded.reference_preservation,
            style_consistency = excluded.style_consistency,
            composition_quality = excluded.composition_quality,
            technical_quality = excluded.technical_quality,
            strengths_json = excluded.strengths_json,
            issues_json = excluded.issues_json,
            suggestion = excluded.suggestion,
            preserve_json = excluded.preserve_json,
            change_json = excluded.change_json,
            edit_instruction = excluded.edit_instruction,
            evaluated_by = excluded.evaluated_by,
            evaluated_at = excluded.evaluated_at,
            updated_at = excluded.updated_at",
        rusqlite::params![
            saved.asset_id,
            saved.asset_path,
            saved.task_id,
            saved.task_kind,
            saved.evaluation_version,
            saved.overall_score,
            saved.instruction_adherence,
            saved.subject_consistency,
            saved.reference_preservation,
            saved.style_consistency,
            saved.composition_quality,
            saved.technical_quality,
            stringify_vec(&saved.strengths)?,
            stringify_vec(&saved.issues)?,
            saved.suggestion,
            stringify_vec(&saved.preserve)?,
            stringify_vec(&saved.change)?,
            saved.edit_instruction,
            saved.evaluated_by,
            saved.evaluated_at,
            saved.user_rating,
            stringify_vec(&saved.user_issue_tags)?,
            saved.user_comment,
            saved.user_feedback_at,
            if saved.favorite { 1 } else { 0 },
            saved.created_at,
            saved.updated_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(saved)
}

// ======================= Tauri 命令 =======================

/// 任务感知 AI 评价：参考图 + 修改要求 + preserve/change + 生成图 → 分维度评分并落库。
/// 失败只返回 ok:false（调用方显示「暂无评价」，绝不影响生成任务本身）。
#[tauri::command]
pub async fn evaluate_image(
    app: AppHandle,
    request: EvaluateImageRequest,
) -> Result<EvaluateImageResult, String> {
    println!(
        "[AITransport] role=image_evaluation feature=image-evaluation model={}",
        request.model
    );
    if request.model.trim().is_empty() || request.base_url.trim().is_empty() || request.token.trim().is_empty() {
        return Ok(EvaluateImageResult {
            ok: false,
            evaluation: None,
            error_kind: Some("not_configured".into()),
            error_message: Some("视觉模型服务未配置（Base URL / API Key / 模型缺失）".into()),
            status: None,
        });
    }
    if request.asset_path.trim().is_empty() {
        return Ok(EvaluateImageResult {
            ok: false,
            evaluation: None,
            error_kind: Some("unsupported_image".into()),
            error_message: Some("生成图路径缺失，无法评价".into()),
            status: None,
        });
    }

    let mut image_urls: Vec<String> = Vec::new();
    let has_reference = request
        .reference_path
        .as_deref()
        .map(|p| !p.trim().is_empty())
        .unwrap_or(false);
    if has_reference {
        match encode_image_data_url(request.reference_path.as_deref().unwrap_or("")) {
            Ok(url) => image_urls.push(url),
            Err(message) => {
                return Ok(EvaluateImageResult {
                    ok: false,
                    evaluation: None,
                    error_kind: Some("unsupported_image".into()),
                    error_message: Some(format!("参考图处理失败：{}", message)),
                    status: None,
                });
            }
        }
    }
    match encode_image_data_url(&request.asset_path) {
        Ok(url) => image_urls.push(url),
        Err(message) => {
            return Ok(EvaluateImageResult {
                ok: false,
                evaluation: None,
                error_kind: Some("unsupported_image".into()),
                error_message: Some(format!("生成图处理失败：{}", message)),
                status: None,
            });
        }
    }

    let reference_note = if has_reference { "第 1 张图是参考原图，第 2 张是生成结果图" } else { "这张图是生成结果图（无参考原图）" };
    let user_text = format!(
        "{}\n{}",
        build_evaluation_user_text(&request),
        reference_note,
    );

    let call = call_vision_model(
        &request.base_url,
        &request.token,
        request.model.trim(),
        EVALUATION_SYSTEM_PROMPT,
        &user_text,
        &image_urls,
        2500,
    )
    .await;

    let text = match call {
        Ok(text) => text,
        Err(error) => {
            return Ok(EvaluateImageResult {
                ok: false,
                evaluation: None,
                error_kind: Some(error.kind),
                error_message: Some(error.message),
                status: error.status,
            });
        }
    };

    let raw = match parse_evaluation_text(&text) {
        Ok(raw) => raw,
        Err(message) => {
            return Ok(EvaluateImageResult {
                ok: false,
                evaluation: None,
                error_kind: Some("invalid_response".into()),
                error_message: Some(format!("评审返回格式无效：{}", message)),
                status: None,
            });
        }
    };

    // 无参考图：主体一致性 / 参考保持强制 null（Prompt 已要求，此处硬保证）。
    let mut evaluation = ImageEvaluation {
        asset_id: request.asset_id.clone(),
        asset_path: request.asset_path.clone(),
        task_id: request.task_id.clone(),
        task_kind: request.task_kind.clone(),
        evaluation_version: EVALUATION_VERSION.to_string(),
        overall_score: None,
        instruction_adherence: normalize_score(raw.instruction_adherence),
        subject_consistency: if has_reference { normalize_score(raw.subject_consistency) } else { None },
        reference_preservation: if has_reference { normalize_score(raw.reference_preservation) } else { None },
        style_consistency: normalize_score(raw.style_consistency),
        composition_quality: normalize_score(raw.composition_quality),
        technical_quality: normalize_score(raw.technical_quality),
        strengths: raw.strengths,
        issues: raw.issues,
        suggestion: raw.suggestion,
        preserve: request.preserve.clone(),
        change: request.change.clone(),
        edit_instruction: request.edit_instruction.clone(),
        evaluated_by: request.model.trim().to_string(),
        evaluated_at: chrono::Local::now().to_rfc3339(),
        ..ImageEvaluation::default()
    };
    evaluation.overall_score = compute_overall(&request.task_kind, &evaluation);

    // 全维度缺失 = 无效评审，不落库（避免保存一条只有 null 的"假评价"）。
    if evaluation.overall_score.is_none() {
        return Ok(EvaluateImageResult {
            ok: false,
            evaluation: None,
            error_kind: Some("invalid_response".into()),
            error_message: Some("评审未返回任何有效维度分数".into()),
            status: None,
        });
    }

    match upsert_evaluation(&app, &evaluation) {
        Ok(saved) => Ok(EvaluateImageResult {
            ok: true,
            evaluation: Some(saved),
            error_kind: None,
            error_message: None,
            status: None,
        }),
        Err(message) => Ok(EvaluateImageResult {
            ok: false,
            evaluation: None,
            error_kind: Some("storage".into()),
            error_message: Some(format!("评价保存失败：{}", message)),
            status: None,
        }),
    }
}

/// 查询评价：asset_ids 缺省 = 全量（图库筛选 / 排序只读持久化分数，绝不现场重算）。
#[tauri::command]
pub fn get_image_evaluations(
    app: AppHandle,
    asset_ids: Option<Vec<String>>,
) -> Result<Vec<ImageEvaluation>, String> {
    let conn = storage::open_app_db(&app)?;
    let sql = format!(
        "SELECT {} FROM image_evaluations{} ORDER BY updated_at DESC",
        EVALUATION_COLUMNS,
        if asset_ids.is_some() { " WHERE asset_id IN (SELECT value FROM json_each(?1))" } else { "" },
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = match &asset_ids {
        Some(ids) => {
            let ids_json = serde_json::to_string(ids).map_err(|e| e.to_string())?;
            stmt.query_map(rusqlite::params![ids_json], row_to_evaluation)
                .map_err(|e| e.to_string())?
        }
        None => stmt
            .query_map([], row_to_evaluation)
            .map_err(|e| e.to_string())?,
    };
    Ok(rows.filter_map(Result::ok).collect())
}

/// 用户反馈独立落库（liked / disliked / null 清除 + 问题标签 + 补充说明）。
/// liked = 满意（成功方案标记，本轮只记录，不做任何自动训练 / Prompt 改写）。
#[tauri::command]
pub fn update_image_evaluation_feedback(
    app: AppHandle,
    asset_id: String,
    rating: Option<String>,
    issue_tags: Option<Vec<String>>,
    comment: Option<String>,
) -> Result<Option<ImageEvaluation>, String> {
    let rating = match rating.as_deref() {
        None | Some("") => None,
        Some("liked") => Some("liked".to_string()),
        Some("disliked") => Some("disliked".to_string()),
        Some(other) => return Err(format!("非法反馈类型：{}", other)),
    };
    let conn = storage::open_app_db(&app)?;
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(1) FROM image_evaluations WHERE asset_id = ?1",
            rusqlite::params![asset_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists == 0 {
        return Ok(None);
    }
    conn.execute(
        "UPDATE image_evaluations SET
            user_rating = ?2,
            user_issue_tags_json = ?3,
            user_comment = ?4,
            user_feedback_at = ?5,
            updated_at = ?5
        WHERE asset_id = ?1",
        rusqlite::params![
            asset_id,
            rating,
            stringify_vec(&issue_tags.unwrap_or_default())?,
            comment.unwrap_or_default(),
            chrono::Local::now().to_rfc3339(),
        ],
    )
    .map_err(|e| e.to_string())?;
    let saved = conn
        .query_row(
            &format!("SELECT {} FROM image_evaluations WHERE asset_id = ?1", EVALUATION_COLUMNS),
            rusqlite::params![asset_id],
            row_to_evaluation,
        )
        .map_err(|e| e.to_string())?;
    Ok(Some(saved))
}

/// 删除资产评价（资产删除时联动清理；不影响其他数据）。
#[tauri::command]
pub fn delete_image_evaluation(app: AppHandle, asset_id: String) -> Result<(), String> {
    let conn = storage::open_app_db(&app)?;
    conn.execute(
        "DELETE FROM image_evaluations WHERE asset_id = ?1",
        rusqlite::params![asset_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 用户收藏 / 取消收藏（♡ 精选标记，与满意 👍 分离）：
/// 未评价过的资产也允许收藏（无评价行时补插最小行，评价字段留空）。
#[tauri::command]
pub fn set_image_favorite(
    app: AppHandle,
    asset_id: String,
    asset_path: String,
    favorite: bool,
) -> Result<ImageEvaluation, String> {
    let conn = storage::open_app_db(&app)?;
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO image_evaluations (
            asset_id, asset_path, task_id, task_kind, evaluation_version,
            strengths_json, issues_json, preserve_json, change_json,
            created_at, updated_at
        ) VALUES (?1, ?2, '', '', '', '[]', '[]', '[]', '[]', ?4, ?4)",
        rusqlite::params![asset_id, asset_path, now],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE image_evaluations SET favorite = ?2, updated_at = ?3 WHERE asset_id = ?1",
        rusqlite::params![asset_id, if favorite { 1 } else { 0 }, now],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        &format!("SELECT {} FROM image_evaluations WHERE asset_id = ?1", EVALUATION_COLUMNS),
        rusqlite::params![asset_id],
        row_to_evaluation,
    )
    .map_err(|e| e.to_string())
}

// ======================= 测试 =======================

#[cfg(test)]
mod tests {
    use super::*;

    fn eval_with(
        instruction: Option<i32>,
        subject: Option<i32>,
        reference: Option<i32>,
        style: Option<i32>,
        composition: Option<i32>,
        technical: Option<i32>,
    ) -> ImageEvaluation {
        ImageEvaluation {
            instruction_adherence: instruction,
            subject_consistency: subject,
            reference_preservation: reference,
            style_consistency: style,
            composition_quality: composition,
            technical_quality: technical,
            ..ImageEvaluation::default()
        }
    }

    #[test]
    fn normalize_score_handles_fraction_percent_null() {
        // 0~1 小数 → 百分制
        assert_eq!(normalize_score(Some(0.94)), Some(94));
        assert_eq!(normalize_score(Some(1.0)), Some(100));
        // 百分制直取
        assert_eq!(normalize_score(Some(87.4)), Some(87));
        assert_eq!(normalize_score(Some(0.0)), Some(0));
        // clamp
        assert_eq!(normalize_score(Some(120.0)), Some(100));
        assert_eq!(normalize_score(Some(-5.0)), Some(0));
        // null = 未评价 / 不适用，绝不当 0
        assert_eq!(normalize_score(None), None);
    }

    #[test]
    fn zero_is_valid_score_not_unrated() {
        assert_eq!(normalize_score(Some(0.0)), Some(0));
        assert_eq!(normalize_score(Some(2.0)), Some(2));
    }

    #[test]
    fn overall_vision_recreation_weighting() {
        // 复刻：instruction .25 + subject .25 + reference .20 + style .15 + comp .10 + tech .05
        let e = eval_with(Some(100), Some(100), Some(100), Some(100), Some(100), Some(100));
        assert_eq!(compute_overall("vision_recreation", &e), Some(100));
        let e = eval_with(Some(0), Some(100), Some(100), Some(100), Some(100), Some(100));
        // (0*.25 + 100*.75) = 75
        assert_eq!(compute_overall("vision_recreation", &e), Some(75));
    }

    #[test]
    fn overall_null_dimensions_renormalize() {
        // t2i：subject/reference 本就 null → 剩余四维归一
        let e = eval_with(Some(80), None, None, Some(80), Some(80), Some(80));
        assert_eq!(compute_overall("t2i", &e), Some(80));
        // 全 null → overall null（禁止 0 分冒充）
        let e = eval_with(None, None, None, None, None, None);
        assert_eq!(compute_overall("t2i", &e), None);
        assert_eq!(compute_overall("i2i", &e), None);
    }

    #[test]
    fn overall_i2i_partial_dims() {
        // i2i：instruction .35 + reference .20 + comp .10 + tech .15（subject/style null 退出）
        // (90*.35 + 80*.20 + 70*.10 + 100*.15) / .80 = (31.5+16+7+15)/0.8 = 86.875 → 87
        let e = eval_with(Some(90), None, Some(80), None, Some(70), Some(100));
        assert_eq!(compute_overall("i2i", &e), Some(87));
    }

    #[test]
    fn parse_evaluation_plain_and_wrapped() {
        let text = r#"{"instruction_adherence":92,"subject_consistency":0.93,"reference_preservation":88,"style_consistency":85,"composition_quality":90,"technical_quality":95,"strengths":["主体保持好"],"issues":["背景轻微偏移"],"suggestion":"加强背景约束"}"#;
        let raw = parse_evaluation_text(text).unwrap();
        assert_eq!(raw.instruction_adherence, Some(92.0));
        assert_eq!(raw.subject_consistency, Some(0.93));
        assert_eq!(raw.issues.len(), 1);
        assert_eq!(raw.suggestion, "加强背景约束");

        let wrapped = format!("```json\n{{\"evaluation\":{}}}\n```", text);
        let raw = parse_evaluation_text(&wrapped).unwrap();
        assert_eq!(raw.instruction_adherence, Some(92.0));
    }

    #[test]
    fn parse_evaluation_null_dims_preserved() {
        let text = r#"{"instruction_adherence":90,"subject_consistency":null,"reference_preservation":null,"style_consistency":88,"composition_quality":80,"technical_quality":92,"strengths":[],"issues":[],"suggestion":""}"#;
        let raw = parse_evaluation_text(text).unwrap();
        assert!(raw.subject_consistency.is_none());
        assert!(raw.reference_preservation.is_none());
        assert_eq!(raw.instruction_adherence, Some(90.0));
    }

    #[test]
    fn parse_evaluation_invalid_rejected() {
        assert!(parse_evaluation_text("这不是 JSON").is_err());
        assert!(parse_evaluation_text("{\"instruction_adherence\": 90").is_err());
    }

    #[test]
    fn user_text_contains_semantics() {
        let request = EvaluateImageRequest {
            asset_id: "a".into(),
            asset_path: "p".into(),
            task_id: "t".into(),
            task_kind: "vision_recreation".into(),
            reference_path: Some("ref.png".into()),
            edit_instruction: "把动作改成奔跑".into(),
            understanding_summary: "二次元女性，城市街道".into(),
            preserve: vec!["人物身份".into(), "服装".into()],
            change: vec!["动作 → 奔跑".into()],
            base_url: String::new(),
            token: String::new(),
            model: String::new(),
        };
        let text = build_evaluation_user_text(&request);
        assert!(text.contains("把动作改成奔跑"));
        assert!(text.contains("人物身份"));
        assert!(text.contains("动作 → 奔跑"));
        assert!(text.contains("二次元女性"));
    }
}
