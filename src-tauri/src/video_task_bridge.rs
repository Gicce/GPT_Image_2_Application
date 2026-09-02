//! CY Image Task Bridge V1（接收端）：CY Video Studio → CyImagePro 的真实图片任务通道。
//!
//! 与既有 CY Video Bridge（CyImagePro → Video 推图，video_bridge.rs 发送端）互为镜像：
//! - 本模块启动 127.0.0.1 随机端口 HTTP 服务，并把发现文件原子写到
//!   `%LOCALAPPDATA%\CyImagePro\task-bridge.json`（protocol=CY_IMAGE_TASK_BRIDGE_V1，
//!   含 host/port/pid/token；正常退出清理）；
//! - `POST /bridge/create-task`：创建**真实 Task**（进入任务队列 / 任务中心 / 历史，
//!   task_source="cy-video-studio" 带来源 Badge），requestId 幂等（重复请求返回既有任务）；
//! - `POST /bridge/task-status`：查询任务状态与产物（ImageRecord 列表）；
//! - Prompt 契约：Video 传 userPrompt（原始要求）+ finalPrompt（最终提交）+ promptOptimized；
//!   CyImagePro 绝不再次改写（任务创建链路本身无自动优化，快照 prompt_optimization.source
//!   标记来源），双方任务详情展示同一内容。
//!
//! Pose Batch Contract V1（动作白膜批，详见 docs/14-POSE-BATCH-CONTRACT.md）：
//! - `POST /bridge/create-pose-batch`：整批接收（N 槽位 = 一个 Task 的 N 个 sub_tasks，
//!   Prompt 由本端 ACTION_MANNEQUIN_V1 Preset 生成），requestId 幂等红线同上；
//! - `POST /bridge/pose-batch-status`：整批状态 + 逐槽结果（Video 只轮询这一个接口）；
//! - `POST /bridge/pose-batch-retry`：只重试失败槽位（已完成槽位绝不再付费生成）；
//! - `POST /bridge/pose-batch-cancel`：取消未完成槽位。

use crate::models::{ImageRecord, Settings, SubTask, Task};
use crate::pose_batch;
use crate::storage;
use serde::Deserialize;
use std::io::Read;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Emitter;

pub const IMAGE_TASK_BRIDGE_PROTOCOL: &str = "CY_IMAGE_TASK_BRIDGE_V1";
/// 来源白名单：仅接受 CY Video Studio
pub const SOURCE_APP_CY_VIDEO: &str = "cy-video-studio";

const MAX_BODY: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTaskRequest {
    source_app: String,
    request_id: String,
    #[serde(default)]
    user_prompt: String,
    final_prompt: String,
    #[serde(default)]
    prompt_optimized: bool,
    #[serde(default)]
    negative_prompt: Option<String>,
    #[serde(default)]
    count: usize,
    #[serde(default)]
    size: Option<String>,
    #[serde(default)]
    quality: Option<String>,
    #[serde(default)]
    output_format: Option<String>,
    #[serde(default)]
    source_images: Vec<String>,
    #[serde(default)]
    source_context: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskStatusRequest {
    task_id: String,
}

/// 启动接收端 Bridge：返回 (port, token)。发现文件由调用方（lib.rs setup）写盘。
pub fn start(app: AppHandle, token: String) -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = std::sync::Arc::new(token);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let app = app.clone();
            let token = token.clone();
            std::thread::spawn(move || {
                if let Err(e) = handle_conn(stream, app, token) {
                    eprintln!("[video-task-bridge] request error: {e}");
                }
            });
        }
    });
    Ok(port)
}

fn handle_conn(
    mut stream: std::net::TcpStream,
    app: AppHandle,
    token: std::sync::Arc<String>,
) -> Result<(), String> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let mut header_end = None;
    loop {
        let n = stream.read(&mut tmp).map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..n]);
        if header_end.is_none() {
            header_end = buf.windows(4).position(|w| w == b"\r\n\r\n");
        }
        if header_end.is_some() || buf.len() > 64 * 1024 {
            break;
        }
    }
    let header_end = header_end.ok_or("header 未结束")?;
    let header = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let first = header.lines().next().unwrap_or_default().to_string();
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let bearer = header
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            if k.trim().eq_ignore_ascii_case("authorization") {
                v.trim().strip_prefix("Bearer ").map(str::to_string)
            } else {
                None
            }
        })
        .unwrap_or_default();
    if !constant_time_eq(&bearer, &token) {
        return respond(&mut stream, 401, r#"{"ok":false,"message":"unauthorized"}"#);
    }
    let content_length: usize = header
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            if k.trim().eq_ignore_ascii_case("content-length") {
                v.trim().parse().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    if content_length > MAX_BODY {
        return respond(&mut stream, 413, r#"{"ok":false,"message":"body too large"}"#);
    }
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut tmp).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    let body_str = String::from_utf8_lossy(&body).into_owned();
    match (method.as_str(), path.as_str()) {
        ("GET", "/bridge/health") => respond(
            &mut stream,
            200,
            &format!(
                r#"{{"ok":true,"app":"cy-image","protocol":"{IMAGE_TASK_BRIDGE_PROTOCOL}","version":1,"poseBatchContract":{}}}"#,
                pose_batch::POSE_BATCH_CONTRACT_VERSION
            ),
        ),
        ("POST", "/bridge/create-task") => handle_create(&mut stream, &app, &body_str),
        ("POST", "/bridge/task-status") => handle_status(&mut stream, &app, &body_str),
        ("POST", "/bridge/create-pose-batch") => handle_pose_create(&mut stream, &app, &body_str),
        ("POST", "/bridge/pose-batch-status") => handle_pose_status(&mut stream, &app, &body_str),
        ("POST", "/bridge/pose-batch-retry") => handle_pose_retry(&mut stream, &app, &body_str),
        ("POST", "/bridge/pose-batch-cancel") => handle_pose_cancel(&mut stream, &app, &body_str),
        _ => respond(&mut stream, 404, r#"{"ok":false,"message":"not found"}"#),
    }
}

fn handle_create(
    stream: &mut std::net::TcpStream,
    app: &AppHandle,
    body: &str,
) -> Result<(), String> {
    let req: CreateTaskRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => {
            let msg = format!(r#"{{"ok":false,"message":"bad json: {e}"}}"#);
            return respond(stream, 400, &msg);
        }
    };
    if req.source_app != SOURCE_APP_CY_VIDEO {
        let msg = format!(
            r#"{{"ok":false,"message":"来源应用不被允许：{}`"#,
            req.source_app
        );
        return respond(stream, 400, &msg);
    }
    if req.final_prompt.trim().is_empty() {
        return respond(stream, 400, r#"{"ok":false,"message":"finalPrompt 不能为空"}"#);
    }
    if req.request_id.trim().is_empty() {
        return respond(stream, 400, r#"{"ok":false,"message":"requestId 不能为空"}"#);
    }
    // requestId 幂等：重复请求（连点 / 网络重试）返回既有任务，绝不重复创建付费任务
    let existing: Option<String> = storage::with_tasks(app, |tasks| {
        tasks
            .iter()
            .find(|t| t.source_request_id == req.request_id)
            .map(|t| t.id.clone())
    });
    if let Some(task_id) = existing {
        let resp = serde_json::json!({
            "ok": true, "taskId": task_id, "alreadyExists": true,
            "message": "请求已受理：返回既有任务（幂等）"
        });
        return respond(stream, 200, &resp.to_string());
    }

    let settings: Settings = {
        let path = storage::settings_path(app);
        storage::read_json(&path, Settings::default())
    };
    let count = req.count.clamp(1, 8);
    let size = req
        .size
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if settings.default_size.trim().is_empty() {
                "2048x2048".to_string()
            } else {
                settings.default_size.clone()
            }
        });
    let quality = req
        .quality
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if settings.default_quality.trim().is_empty() {
                "high".to_string()
            } else {
                settings.default_quality.clone()
            }
        });
    let output_format = req
        .output_format
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if settings.default_format.trim().is_empty() {
                "png".to_string()
            } else {
                settings.default_format.clone()
            }
        });
    // 输出目录：设置默认目录 → 应用数据目录 bridge_output 兜底（确保存在）
    let output_dir = resolve_output_dir(app, &settings);
    let task_type = if req.source_images.is_empty() {
        "generate".to_string()
    } else {
        "edit".to_string()
    };
    let source_ctx = sanitize_source_context(&req.source_context);
    let now = chrono::Local::now().to_rfc3339();
    let task = Task {
        id: uuid::Uuid::new_v4().to_string(),
        prompt: req.final_prompt.trim().to_string(),
        negative_prompt: String::new(),
        user_prompt_raw: if req.user_prompt.trim().is_empty() {
            req.final_prompt.trim().to_string()
        } else {
            req.user_prompt.trim().to_string()
        },
        final_prompt: req.final_prompt.trim().to_string(),
        final_negative_prompt: req.negative_prompt.clone().unwrap_or_default(),
        prompt_optimized: req.prompt_optimized,
        prompt_optimization: Some(crate::models::PromptOptimizationSnapshot {
            applied: req.prompt_optimized,
            provider_name: "CY Video Studio".to_string(),
            model_name: String::new(),
            original_prompt: req.user_prompt.trim().to_string(),
            optimized_at: if req.prompt_optimized {
                now.clone()
            } else {
                String::new()
            },
            manually_edited_after: false,
            // video_replication = Video Studio 视频复刻链路传入（已定稿，禁止再次优化）
            source: "video_replication".to_string(),
        }),
        agent_intent: String::new(),
        task_source: SOURCE_APP_CY_VIDEO.to_string(),
        size,
        quality,
        output_format,
        count,
        status: "pending".to_string(),
        created_at: now,
        started_at: None,
        completed_at: None,
        output_dir,
        success_count: 0,
        failed_count: 0,
        sub_tasks: (0..count)
            .map(|i| SubTask {
                index: i,
                status: "pending".to_string(),
                image_id: None,
                error: None,
                label: None,
                retry_count: 0,
                attempt_errors: Vec::new(),
                error_detail: None,
                attempt_details: Vec::new(),
                executed_prompt: None,
            })
            .collect(),
        task_type,
        source_images: req.source_images.clone(),
        mask_image: None,
        execution_mode: "single".to_string(),
        batch_strategy: String::new(),
        task_plan_summary: source_ctx
            .get("purpose")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_default(),
        batch_items: Vec::new(),
        composite_layout: None,
        subject_entities: Vec::new(),
        source_task_id: None,
        source_task_kind: "video_replication".to_string(),
        stage_note: String::new(),
        source_app: SOURCE_APP_CY_VIDEO.to_string(),
        source_request_id: req.request_id.clone(),
        source_context: Some(source_ctx),
        pose_batch: None,
        provenance: None,
        execution_snapshot: None,
    };
    let task_id = task.id.clone();
    storage::with_tasks(app, |tasks| {
        tasks.push(task);
    });
    let _ = app.emit("task-updated", &task_id);
    let resp = serde_json::json!({
        "ok": true, "taskId": task_id, "alreadyExists": false, "message": "任务已创建"
    });
    respond(stream, 200, &resp.to_string())
}

fn handle_status(
    stream: &mut std::net::TcpStream,
    app: &AppHandle,
    body: &str,
) -> Result<(), String> {
    let req: TaskStatusRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => {
            let msg = format!(r#"{{"ok":false,"message":"bad json: {e}"}}"#);
            return respond(stream, 400, &msg);
        }
    };
    let found: Option<Task> = storage::with_tasks(app, |tasks| {
        tasks.iter().find(|t| t.id == req.task_id).cloned()
    });
    let Some(task) = found else {
        return respond(
            stream,
            404,
            r#"{"ok":false,"message":"任务不存在（可能已被删除）"}"#,
        );
    };
    let images: Vec<serde_json::Value> = storage::with_images(app, |images| {
        images
            .iter()
            .filter(|i: &&ImageRecord| i.task_id == task.id)
            .map(|i| {
                serde_json::json!({
                    "imageId": i.id,
                    "filePath": i.local_path,
                    "fileName": i.file_name,
                    "width": i.width,
                    "height": i.height,
                    "createdAt": i.created_at,
                })
            })
            .collect()
    });
    let error = task
        .sub_tasks
        .iter()
        .filter_map(|s| s.error.clone())
        .find(|e| !e.is_empty());
    let resp = serde_json::json!({
        "ok": true,
        "status": task.status,
        "images": images,
        "successCount": task.success_count,
        "totalCount": task.count,
        "error": error,
    });
    respond(stream, 200, &resp.to_string())
}

/// 只保留可展示字段，绝不透传任意结构
fn sanitize_source_context(v: &serde_json::Value) -> serde_json::Value {
    let pick = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .map(str::to_string)
            .unwrap_or_default()
    };
    serde_json::json!({
        "feature": pick("feature"),
        "projectName": pick("projectName"),
        "trackType": pick("trackType"),
        "trackId": pick("trackId"),
        "purpose": pick("purpose"),
    })
}

// ========== Pose Batch Contract V1 ==========

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PoseBatchStatusRequest {
    #[serde(default)]
    batch_id: String,
    #[serde(default)]
    request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PoseBatchRetryRequest {
    batch_id: String,
    #[serde(default)]
    slot_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PoseBatchCancelRequest {
    batch_id: String,
}

fn read_settings(app: &AppHandle) -> Settings {
    let path = storage::settings_path(app);
    storage::read_json(&path, Settings::default())
}

/// 输出目录：设置默认目录 → 应用数据目录 bridge_output 兜底（确保存在）
fn resolve_output_dir(app: &AppHandle, settings: &Settings) -> String {
    let base = if settings.default_output_dir.trim().is_empty() {
        storage::data_dir(app).join("bridge_output")
    } else {
        PathBuf::from(settings.default_output_dir.trim())
    };
    let _ = std::fs::create_dir_all(&base);
    base.to_string_lossy().to_string()
}

fn handle_pose_create(
    stream: &mut std::net::TcpStream,
    app: &AppHandle,
    body: &str,
) -> Result<(), String> {
    let req: pose_batch::PoseBatchRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => {
            let msg = format!(r#"{{"ok":false,"code":"bad_json","message":"bad json: {e}"}}"#);
            return respond(stream, 400, &msg);
        }
    };
    let settings = read_settings(app);
    let plan = match pose_batch::plan_pose_batch(&req, &settings) {
        Ok(p) => p,
        Err(e) => {
            let resp = serde_json::json!({
                "ok": false, "code": e.code, "message": e.message
            });
            return respond(stream, 400, &resp.to_string());
        }
    };

    // requestId 幂等红线：重复请求返回既有 Batch，绝不重复创建 / 重复付费
    let existing: Option<(String, String)> = storage::with_tasks(app, |tasks| {
        pose_batch::find_pose_batch_task(tasks, "", &plan.request_id)
            .map(|t| (t.id.clone(), t.pose_batch.as_ref().map(|p| p.batch_id.clone()).unwrap_or_default()))
    });
    if let Some((task_id, batch_id)) = existing {
        let resp = serde_json::json!({
            "ok": true, "alreadyExists": true,
            "batchId": batch_id, "taskId": task_id,
            "contractVersion": pose_batch::POSE_BATCH_CONTRACT_VERSION,
            "message": "请求已受理：返回既有动作白膜批（幂等）"
        });
        return respond(stream, 200, &resp.to_string());
    }
    // batchId 冲突保护：保证 batchId → Batch 查找无歧义
    let conflict: Option<String> = storage::with_tasks(app, |tasks| {
        pose_batch::find_pose_batch_task(tasks, &plan.batch_id, "")
            .filter(|t| t.source_request_id != plan.request_id)
            .map(|t| t.id.clone())
    });
    if let Some(task_id) = conflict {
        let resp = serde_json::json!({
            "ok": false, "code": "batch_id_conflict",
            "message": format!("batchId 已被任务 {task_id} 使用，请更换 batchId")
        });
        return respond(stream, 409, &resp.to_string());
    }

    let output_dir = resolve_output_dir(app, &settings);
    let task = pose_batch::build_pose_batch_task(&plan, output_dir);
    let task_id = task.id.clone();
    let batch_id = plan.batch_id.clone();
    let slot_ids: Vec<String> = plan.slots.iter().map(|s| s.slot_id.clone()).collect();
    let clamped = plan.candidate_count_clamped;
    let total = plan.slots.len();
    storage::with_tasks(app, |tasks| {
        tasks.push(task);
    });
    let _ = app.emit("task-updated", &task_id);
    let resp = serde_json::json!({
        "ok": true, "alreadyExists": false,
        "contractVersion": pose_batch::POSE_BATCH_CONTRACT_VERSION,
        "batchId": batch_id, "taskId": task_id,
        "status": "queued", "totalSlots": total, "slotIds": slot_ids,
        "candidateCount": plan.candidate_count_effective,
        "candidateCountClamped": clamped,
        "message": if clamped {
            "动作白膜批已创建（V1 单候选：candidateCount 已按 1 生效）"
        } else {
            "动作白膜批已创建"
        }
    });
    respond(stream, 200, &resp.to_string())
}

/// Pose Batch 完整状态载荷：批状态 + 逐槽结果（含图片 / 选优 / 评分 / 错误）。
/// V1 单候选：images 恒 ≤1 张，selectedImageId = 唯一产物（选优语义自然成立）。
fn pose_batch_payload(app: &AppHandle, task: &Task) -> serde_json::Value {
    let Some(pb) = task.pose_batch.as_ref() else {
        return serde_json::json!({"ok": false, "message": "任务不是动作白膜批"});
    };
    let image_ids: Vec<String> = task.sub_tasks.iter().filter_map(|s| s.image_id.clone()).collect();
    let images: Vec<ImageRecord> = storage::with_images(app, |imgs| {
        imgs.iter().filter(|i| image_ids.contains(&i.id)).cloned().collect()
    });
    let evaluations = crate::evaluation::get_image_evaluations(app.clone(), Some(image_ids))
        .unwrap_or_default();
    let completed = task.sub_tasks.iter().filter(|s| s.status == "completed").count();
    let failed = task.sub_tasks.iter().filter(|s| s.status == "failed").count();
    let slots: Vec<serde_json::Value> = pb
        .slots
        .iter()
        .map(|slot| {
            let sub = task.sub_tasks.get(slot.sub_index);
            let image = sub
                .and_then(|s| s.image_id.as_ref())
                .and_then(|id| images.iter().find(|i| i.id == *id));
            let evaluation = sub
                .and_then(|s| s.image_id.as_ref())
                .and_then(|id| evaluations.iter().find(|e| &e.asset_id == id));
            let image_json = |i: &ImageRecord| {
                serde_json::json!({
                    "imageId": i.id,
                    "filePath": i.local_path,
                    "fileName": i.file_name,
                    "width": i.width,
                    "height": i.height,
                    "createdAt": i.created_at,
                })
            };
            serde_json::json!({
                "slotId": slot.slot_id,
                "view": slot.view,
                "keyframe": slot.keyframe,
                "label": pose_batch::slot_label(&slot.view, &slot.keyframe),
                "status": sub.map(|s| pose_batch::slot_status(&s.status)).unwrap_or("queued"),
                "taskId": task.id,
                "retryCount": sub.map(|s| s.retry_count).unwrap_or(0),
                "images": image.map(image_json).map(|v| vec![v]).unwrap_or_default(),
                "selectedImageId": image.map(|i| i.id.clone()),
                "scores": evaluation
                    .map(|e| serde_json::json!({"overall": e.overall_score, "version": e.evaluation_version})),
                "error": sub
                    .and_then(|s| s.error.clone())
                    .filter(|e| !e.is_empty())
                    .map(|message| serde_json::json!({"code": "generation_failed", "message": message})),
            })
        })
        .collect();
    serde_json::json!({
        "ok": true,
        "contractVersion": pb.contract_version,
        "batchId": pb.batch_id,
        "requestId": task.source_request_id,
        "taskId": task.id,
        "sourceApp": task.source_app,
        "sourceFeature": task.source_context.as_ref()
            .and_then(|c| c.get("feature"))
            .and_then(|v| v.as_str()),
        "action": {"id": pb.action_id, "name": pb.action_name, "normalizedPose": pb.normalized_pose},
        "presetVersion": pb.preset_version,
        "consistencyStrategy": pb.consistency_strategy,
        "masterImageId": pb.master_image_id,
        "aspectRatio": pb.aspect_ratio,
        "candidateCount": 1,
        "autoSelectBest": true,
        "status": pose_batch::derive_batch_status(task),
        "total": task.count,
        "completed": completed,
        "failed": failed,
        "createdAt": task.created_at,
        "updatedAt": task.completed_at.clone()
            .or(task.started_at.clone())
            .unwrap_or_else(|| task.created_at.clone()),
        "slots": slots,
    })
}

fn handle_pose_status(
    stream: &mut std::net::TcpStream,
    app: &AppHandle,
    body: &str,
) -> Result<(), String> {
    let req: PoseBatchStatusRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => {
            let msg = format!(r#"{{"ok":false,"code":"bad_json","message":"bad json: {e}"}}"#);
            return respond(stream, 400, &msg);
        }
    };
    let found: Option<Task> = storage::with_tasks(app, |tasks| {
        pose_batch::find_pose_batch_task(tasks, &req.batch_id, &req.request_id).cloned()
    });
    let Some(task) = found else {
        return respond(
            stream,
            404,
            r#"{"ok":false,"code":"batch_not_found","message":"动作白膜批不存在（可能已被删除）"}"#,
        );
    };
    let payload = pose_batch_payload(app, &task);
    respond(stream, 200, &payload.to_string())
}

fn handle_pose_retry(
    stream: &mut std::net::TcpStream,
    app: &AppHandle,
    body: &str,
) -> Result<(), String> {
    let req: PoseBatchRetryRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => {
            let msg = format!(r#"{{"ok":false,"code":"bad_json","message":"bad json: {e}"}}"#);
            return respond(stream, 400, &msg);
        }
    };
    let found: Option<Task> = storage::with_tasks(app, |tasks| {
        pose_batch::find_pose_batch_task(tasks, &req.batch_id, "").cloned()
    });
    let Some(task) = found else {
        return respond(
            stream,
            404,
            r#"{"ok":false,"code":"batch_not_found","message":"动作白膜批不存在（可能已被删除）"}"#,
        );
    };
    let Some(pb) = task.pose_batch.clone() else {
        return respond(
            stream,
            404,
            r#"{"ok":false,"code":"not_a_pose_batch","message":"任务不是动作白膜批"}"#,
        );
    };
    let indexes = match pose_batch::map_slot_ids_to_indexes(&pb, &req.slot_ids) {
        Ok(v) => v,
        Err(e) => {
            let resp = serde_json::json!({"ok": false, "code": "unknown_slot", "message": e});
            return respond(stream, 400, &resp.to_string());
        }
    };
    // 只重置 failed 槽位（completed 绝不动 → 已成功图片不再付费生成），复用 V4.0.5 机制
    let reset_indexes: Vec<usize> = storage::with_tasks(app, |tasks| {
        tasks
            .iter_mut()
            .find(|t| t.id == task.id)
            .map(|t| crate::reconciliation::reset_failed_subtasks_for_retry(t, if indexes.is_empty() { None } else { Some(&indexes) }))
            .unwrap_or_default()
    });
    let _ = app.emit("task-updated", &task.id);
    let retried_slot_ids: Vec<String> = reset_indexes
        .iter()
        .filter_map(|&i| pb.slots.iter().find(|s| s.sub_index == i).map(|s| s.slot_id.clone()))
        .collect();
    let resp = serde_json::json!({
        "ok": true,
        "batchId": pb.batch_id,
        "taskId": task.id,
        "retriedSlotIds": retried_slot_ids,
        "resetCount": reset_indexes.len(),
        "status": if reset_indexes.is_empty() { "unchanged" } else { "queued" },
        "message": if reset_indexes.is_empty() {
            "没有可重试的失败槽位（已完成槽位绝不重复生成）"
        } else {
            "失败槽位已重新入队"
        }
    });
    respond(stream, 200, &resp.to_string())
}

fn handle_pose_cancel(
    stream: &mut std::net::TcpStream,
    app: &AppHandle,
    body: &str,
) -> Result<(), String> {
    let req: PoseBatchCancelRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => {
            let msg = format!(r#"{{"ok":false,"code":"bad_json","message":"bad json: {e}"}}"#);
            return respond(stream, 400, &msg);
        }
    };
    let found: Option<Task> = storage::with_tasks(app, |tasks| {
        pose_batch::find_pose_batch_task(tasks, &req.batch_id, "").cloned()
    });
    let Some(task) = found else {
        return respond(
            stream,
            404,
            r#"{"ok":false,"code":"batch_not_found","message":"动作白膜批不存在（可能已被删除）"}"#,
        );
    };
    // 终态保护：completed/failed/partial 不可取消（与任务中心口径一致）
    let cancelled = storage::with_tasks(app, |tasks| {
        tasks
            .iter_mut()
            .find(|t| t.id == task.id)
            .map(crate::reconciliation::cancel_task_in_place)
            .unwrap_or(false)
    });
    let _ = app.emit("task-updated", &task.id);
    let status = storage::with_tasks(app, |tasks| {
        tasks.iter().find(|t| t.id == task.id).map(pose_batch::derive_batch_status).unwrap_or("failed")
    });
    let resp = serde_json::json!({
        "ok": true,
        "batchId": req.batch_id,
        "taskId": task.id,
        "cancelled": cancelled,
        "status": status,
        "message": if cancelled { "批已取消（执行中槽位完成后停止）" } else { "批处于终态，无需取消" }
    });
    respond(stream, 200, &resp.to_string())
}

fn respond(stream: &mut std::net::TcpStream, status: u16, body: &str) -> Result<(), String> {
    use std::io::Write;
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;
    Ok(())
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

/// 发现文件路径：`%LOCALAPPDATA%\CyImagePro\task-bridge.json`（与 Video 侧读取约定一致）
pub fn discovery_path() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join("CyImagePro").join("task-bridge.json"))
}

fn generate_session_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// 启动 Bridge 并原子写发现文件（tmp → rename）。返回 (port, token)。
pub fn start_with_discovery(app: AppHandle) -> Result<(u16, String), String> {
    let token = generate_session_token();
    let port = start(app, token.clone())?;
    if let Some(dir) = discovery_path() {
        if let Some(parent) = dir.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let discovery = serde_json::json!({
            "protocol": IMAGE_TASK_BRIDGE_PROTOCOL,
            "version": 1,
            "app": "cy-image",
            "host": "127.0.0.1",
            "port": port,
            "pid": std::process::id(),
            "token": token,
            "started_at": chrono::Local::now().to_rfc3339(),
        });
        let tmp = dir.with_extension("json.tmp");
        if std::fs::write(&tmp, discovery.to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, &dir);
        }
    }
    Ok((port, token))
}

/// 正常退出时清理发现文件（仅 pid 匹配时；崩溃残留由外部按 health 校验）
pub fn cleanup_discovery() {
    let Some(path) = discovery_path() else { return };
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            let pid = v.get("pid").and_then(|p| p.as_u64()).unwrap_or(0);
            if pid == std::process::id() as u64 {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_context_keeps_known_fields_only() {
        let raw = serde_json::json!({
            "feature": "video-replication",
            "projectName": "测试01",
            "trackType": "character",
            "evil": "<script>",
        });
        let out = sanitize_source_context(&raw);
        assert_eq!(out["projectName"], "测试01");
        assert!(out.get("evil").is_none(), "未知字段被剔除");
    }

    #[test]
    fn constant_time_eq_basics() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
    }

    #[test]
    fn discovery_path_under_cyimagepro_dir() {
        let p = discovery_path().unwrap();
        assert!(p.to_string_lossy().contains("CyImagePro"));
        assert!(p.to_string_lossy().contains("task-bridge.json"));
    }
}
