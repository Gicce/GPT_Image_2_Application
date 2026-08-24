use std::fs;
use std::path::Path;

use tauri::{AppHandle, Emitter, Manager};

use crate::models::{ImageRecord, RuntimeAuthConfig, SubTaskErrorDetail, Task};
use crate::reconciliation::{fail_task_in_place, finalize_task_in_place};
use crate::storage;
use crate::task_failure::{
    build_local_failure_detail, build_send_failure_detail, build_upstream_failure_detail,
    TaskFailure,
};
use crate::RuntimeAuthState;

#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
struct ApiRequestBody {
    model: String,
    prompt: String,
    size: String,
    quality: String,
    output_format: String,
    response_format: String,
    n: u32,
}

#[derive(Debug, serde::Deserialize)]
struct ApiResponseImage {
    b64_json: Option<String>,
    #[allow(dead_code)]
    url: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct ApiResponse {
    data: Vec<ApiResponseImage>,
}

fn extract_error_parts(text: &str) -> (Option<String>, Option<String>, Option<String>) {
    let parsed = serde_json::from_str::<serde_json::Value>(text).ok();
    if let Some(value) = parsed {
        let detail = value
            .get("detail")
            .and_then(|v| v.as_str())
            .or_else(|| value.get("message").and_then(|v| v.as_str()))
            .or_else(|| {
                value
                    .get("error")
                    .and_then(|v| v.get("message"))
                    .and_then(|v| v.as_str())
            })
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string);
        let code = value
            .get("code")
            .and_then(|v| v.as_str())
            .or_else(|| {
                value
                    .get("error")
                    .and_then(|v| v.get("code"))
                    .and_then(|v| v.as_str())
            })
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string);
        let request_id = value
            .get("request_id")
            .or_else(|| value.get("requestId"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .or_else(|| {
                // packyapi 把 request id 埋在 body 文本里（无独立字段）
                crate::task_failure::extract_request_id(text)
            });
        return (detail, code, request_id);
    }

    let trimmed = text.trim();
    if trimmed.is_empty() {
        (None, None, None)
    } else {
        (
            Some(trimmed.to_string()),
            None,
            crate::task_failure::extract_request_id(trimmed),
        )
    }
}

fn format_upstream_image_error_parts(
    status: reqwest::StatusCode,
    primary: &str,
    code: &Option<String>,
    url: &str,
) -> String {
    let mut message = if primary == "openai_error" {
        "上游图片接口失败：openai_error".to_string()
    } else if primary.starts_with("上游图片接口失败") {
        primary.to_string()
    } else {
        format!("上游图片接口失败：{primary}")
    };
    if let Some(code_value) = code {
        if !message.contains(code_value) {
            message.push_str(&format!(" [code: {code_value}]"));
        }
    }
    // V4.0.8：带上 endpoint（与 format_send_error 一致），前端据此区分
    // 「文生图接口失败」与「图生图接口失败」，不再泛化成同一句能力不匹配。
    message.push_str(&format!(" [endpoint: {url}] (HTTP {})", status.as_u16()));
    message
}

fn format_upstream_image_error(status: reqwest::StatusCode, text: &str, url: &str) -> String {
    let (detail, code, _) = extract_error_parts(text);
    let primary = detail
        .clone()
        .or_else(|| code.clone())
        .unwrap_or_else(|| "上游图片接口失败".to_string());
    format_upstream_image_error_parts(status, &primary, &code, url)
}

/// 上游非 2xx 失败 → 稳定展示文案 + 结构化快照（V4.1 canonical failure model）。
fn upstream_image_failure(status: reqwest::StatusCode, text: &str, url: &str) -> TaskFailure {
    let (detail, code, request_id) = extract_error_parts(text);
    let primary = detail
        .clone()
        .or_else(|| code.clone())
        .unwrap_or_else(|| "上游图片接口失败".to_string());
    let message = format_upstream_image_error_parts(status, &primary, &code, url);
    let snapshot = build_upstream_failure_detail(
        status.as_u16(),
        code.as_deref(),
        &primary,
        request_id.as_deref(),
        url,
    );
    TaskFailure { message, detail: Some(snapshot) }
}

/// Translate a reqwest send error into a friendly, classified message for the task queue.
/// We do NOT expose the Authorization header or token value here — only network/HTTP signals.
fn format_send_error(err: &reqwest::Error, url: &str) -> String {
    let kind = if err.is_timeout() {
        "timeout"
    } else if err.is_connect() {
        "connect"
    } else if err.is_request() {
        "request"
    } else {
        "network"
    };
    let hint = match kind {
        "timeout" => "请求超时。请前往“设置 → 一键检查运行环境”确认代理可达、或适当调低尺寸/质量后重试。",
        "connect" => "无法建立连接。请检查 Windows 系统代理（如 127.0.0.1:7897）是否启用且可达，前往“设置 → 一键检查运行环境”可一键诊断。",
        "request" => "请求在客户端被拒绝，请前往“设置 → 一键检查运行环境”查看详情。",
        _ => "网络异常，请检查代理与本地网络后重试。",
    };
    format!("图片服务连接失败（{kind}）：{hint} [endpoint: {url}]")
}

/// 瞬时网络错误判定：只认连接建立失败 / 超时（代理抖动、DNS 瞬断、连接被重置）。
/// HTTP 状态码错误（如 400/500 业务响应）不属于此类，绝不自动重试。
fn is_transient_send_error(err: &reqwest::Error) -> bool {
    err.is_connect() || err.is_timeout()
}

/// 无依赖的轻量抖动（0~199ms）：避免同批多个子任务重试严格同时打到代理。
fn jitter_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::from(d.subsec_millis()) % 200)
        .unwrap_or(0)
}

/// 发送层最终失败载体：message 是稳定展示文案，detail 是结构化快照
/// （V4.1 canonical failure model；视觉模块用 detail.category 替代文案关键词还原）。
pub(crate) struct SendFailure {
    pub message: String,
    pub detail: SubTaskErrorDetail,
}

/// 发送 + 瞬时错误有限自动重试（最多补 2 次，500ms / 1500ms + 抖动退避）。
/// build_request 每次重试重建请求（RequestBuilder 一次性消费；client 由闭包捕获复用）；
/// 最终失败返回分类后的错误文案 + 结构化快照。
/// V4.0.6 起公开（pub(crate)）：视觉理解模块复用同一瞬时重试策略
/// （全项目仅此一份实现，禁止出现第二套 retry）。
pub(crate) async fn send_with_transient_retry(
    url: &str,
    build_request: impl Fn() -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, SendFailure> {
    const MAX_RETRIES: u32 = 2;
    let mut attempt: u32 = 0;
    loop {
        let result = build_request().send().await;
        match result {
            Ok(resp) => return Ok(resp),
            Err(err) => {
                if is_transient_send_error(&err) && attempt < MAX_RETRIES {
                    attempt += 1;
                    let base_ms = if attempt == 1 { 500 } else { 1500 };
                    tokio::time::sleep(std::time::Duration::from_millis(
                        base_ms + jitter_millis(),
                    ))
                    .await;
                    continue;
                }
                let kind = if err.is_timeout() {
                    "timeout"
                } else if err.is_connect() {
                    "connect"
                } else if err.is_request() {
                    "request"
                } else {
                    "network"
                };
                let mut message = format_send_error(&err, url);
                if attempt > 0 {
                    message.push_str(&format!("（已自动重试 {attempt} 次仍失败）"));
                }
                let detail = build_send_failure_detail(kind, url, err.is_timeout());
                return Err(SendFailure { message, detail });
            }
        }
    }
}

/// Read runtime auth config from memory (never persisted).
/// Returns a snapshot; if the mutex is poisoned, returns default (empty).
fn read_runtime_config(app: &AppHandle) -> RuntimeAuthConfig {
    if let Some(state) = app.try_state::<RuntimeAuthState>() {
        if let Ok(guard) = state.config.lock() {
            return guard.clone();
        }
    }
    RuntimeAuthConfig::default()
}

/// Resolve image token: prefer runtime memory, fallback to settings.token.
fn resolve_image_token(runtime: &RuntimeAuthConfig, settings_token: &str) -> String {
    let rt = runtime.image_token.trim().to_string();
    if !rt.is_empty() {
        rt
    } else {
        settings_token.trim().to_string()
    }
}

/// Resolve image base_url: prefer runtime memory, fallback to default.
fn resolve_image_base_url(runtime: &RuntimeAuthConfig) -> String {
    let rt = runtime.image_base_url.trim().to_string();
    if rt.is_empty() {
        "https://www.packyapi.com".to_string()
    } else {
        rt.trim_end_matches('/').to_string()
    }
}

fn effective_prompt(task: &Task, index: usize) -> String {
    if let Some(item) = task.batch_items.get(index) {
        let override_prompt = item.prompt_override.trim();
        if !override_prompt.is_empty() {
            return override_prompt.to_string();
        }
    }
    let base = if task.final_prompt.is_empty() {
        task.prompt.clone()
    } else {
        task.final_prompt.clone()
    };
    if let Some(item) = task.batch_items.get(index) {
        let delta = item.prompt_delta.trim();
        if !delta.is_empty() {
            return format!("{base}\n{delta}");
        }
    }
    base
}

/// 子任务级负面提示词：batch_items[i].negative_override 优先，回落任务级字段。
fn effective_negative_prompt(task: &Task, index: usize) -> String {
    if let Some(item) = task.batch_items.get(index) {
        let override_negative = item.negative_override.trim();
        if !override_negative.is_empty() {
            return override_negative.to_string();
        }
    }
    if !task.final_negative_prompt.trim().is_empty() {
        task.final_negative_prompt.trim().to_string()
    } else {
        task.negative_prompt.trim().to_string()
    }
}

/// 子任务级图片描述：批量方案任务（batch_items 带 label，例如「方案 1 · 红黑重甲 · 长枪 · 古城墙」）
/// 写入 ImageRecord.description，图库卡片优先展示方案标题而非整段 Prompt。
fn batch_item_description(task: &Task, index: usize) -> Option<String> {
    let label = task
        .batch_items
        .get(index)
        .map(|item| item.label.trim())
        .unwrap_or("");
    if label.is_empty() {
        None
    } else {
        Some(label.to_string())
    }
}

/// gpt-image-2 走 OpenAI Images API，没有独立的 negative_prompt 参数；
/// 负面提示词在适配层（这里）组合进最终指令，UI 不感知 Provider 差异。
fn compose_model_instruction(positive: &str, negative: &str) -> String {
    let negative = negative.trim();
    if negative.is_empty() {
        return positive.trim().to_string();
    }
    format!(
        "{}\n\n画面中严格避免出现以下内容：{}",
        positive.trim(),
        negative
    )
}

fn effective_source_images(task: &Task, index: usize) -> Vec<String> {
    if let Some(item) = task.batch_items.get(index) {
        if !item.source_images.is_empty() {
            return item.source_images.clone();
        }
    }
    if task.execution_mode == "batch" && task.batch_strategy == "multi_input" {
        if let Some(source) = task.source_images.get(index) {
            return vec![source.clone()];
        }
    }
    task.source_images.clone()
}

/// Pose Batch 一致性（master_reference）：当前槽位若应以批内 master 白膜为参考图，
/// 把 master 本地路径写入 live 任务与本地克隆的 batch_items[i].source_images
/// （编辑路由的 effective_source_images 读这里），返回 true → 该槽走 Edits 路由。
/// master 缺失（未产生 / 资产被删 / 文件移动）自动回落 Generations，绝不阻塞批执行。
fn prepare_pose_slot_reference(app: &AppHandle, task: &mut Task, index: usize) -> bool {
    // 读 live 任务的批元数据（首槽成功后本地克隆即过期）
    let Some(pb) = storage::with_tasks(app, |tasks| {
        tasks.iter().find(|t| t.id == task.id).and_then(|t| t.pose_batch.clone())
    }) else {
        return false;
    };
    if !crate::pose_batch::slot_should_use_master_reference(&pb, index) {
        return false;
    }
    let Some(master_id) = pb.master_image_id.clone() else {
        return false;
    };
    let Some(master_path) = storage::with_images(app, |imgs| {
        imgs.iter().find(|r| r.id == master_id).map(|r| r.local_path.clone())
    }) else {
        return false;
    };
    if !Path::new(&master_path).exists() {
        return false;
    }
    storage::with_tasks(app, |tasks| {
        if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
            if let Some(item) = t.batch_items.get_mut(index) {
                item.source_images = vec![master_path.clone()];
            }
        }
    });
    if let Some(item) = task.batch_items.get_mut(index) {
        item.source_images = vec![master_path];
    }
    true
}

/// master_reference 策略：首张成功白膜登记为 master（后续 / 重试槽位以其为参考图）。
fn record_pose_master_if_needed(app: &AppHandle, task: &Task, index: usize, image_id: &str) {
    let Some(pb) = task.pose_batch.as_ref() else { return; };
    if pb.consistency_strategy != "master_reference" || pb.master_image_id.is_some() {
        return;
    }
    storage::with_tasks(app, |tasks| {
        if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
            if let Some(pb) = t.pose_batch.as_mut() {
                if pb.master_image_id.is_none() {
                    pb.master_image_id = Some(image_id.to_string());
                    pb.master_slot_index = Some(index);
                }
            }
        }
    });
}

/// 前端驱动型任务（视觉理解）：由页面直接调用模型并推进状态，
/// 后台执行器绝不认领，否则会把分析描述当图片 Prompt 送进生成接口。
pub fn is_frontend_driven_task(task: &Task) -> bool {
    !resolve_execution_route(&task.task_type).is_runner_executed()
}

// ===== V4.0.8 图片执行路由适配边界 =====
// endpoint 决策唯一入口：task_type → 路由 → endpoint。业务层（前端 / 任务模型）
// 不关心 Provider 用 /images/generations 还是 /images/edits；图片任务绝无可能
// 被路由到 chat / responses 文本会话通道。新增图片能力时在此处声明，禁止散落判断。

/// 图片任务执行路由（协议差异边界）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageExecutionRoute {
    /// 文生图：JSON POST {base}/v1/images/generations
    Generations,
    /// 图生图（编辑）：multipart POST {base}/v1/images/edits，参考图作为 image[] 部件
    Edits,
    /// 去背景：remove.bg 专用接口
    RemoveBackground,
    /// 前端驱动（视觉理解）：runner 不认领、无 endpoint
    FrontendDriven,
}

/// task_type → 执行路由（唯一判定点；空 task_type 按历史约定回落文生图）。
pub fn resolve_execution_route(task_type: &str) -> ImageExecutionRoute {
    match task_type {
        "edit" => ImageExecutionRoute::Edits,
        "remove_background" => ImageExecutionRoute::RemoveBackground,
        "vision_understanding" => ImageExecutionRoute::FrontendDriven,
        _ => ImageExecutionRoute::Generations,
    }
}

impl ImageExecutionRoute {
    /// 路由 → 请求 endpoint（FrontendDriven 无 endpoint，返回空串）。
    pub fn endpoint_url(self, base_url: &str) -> String {
        match self {
            ImageExecutionRoute::Generations => format!("{}/v1/images/generations", base_url),
            ImageExecutionRoute::Edits => format!("{}/v1/images/edits", base_url),
            ImageExecutionRoute::RemoveBackground => {
                "https://api.remove.bg/v1.0/removebg".to_string()
            }
            ImageExecutionRoute::FrontendDriven => String::new(),
        }
    }

    /// 是否由后台 runner 执行（前端驱动型任务不进队列执行）。
    pub fn is_runner_executed(self) -> bool {
        !matches!(self, ImageExecutionRoute::FrontendDriven)
    }
}

pub async fn process_next_task(app: &AppHandle) {
    // Find a pending task
    let task_opt = storage::with_tasks(app, |tasks| {
        tasks
            .iter()
            .find(|t| t.status == "pending" && !is_frontend_driven_task(t))
            .cloned()
    });

    let mut task = match task_opt {
        Some(t) => t,
        None => return,
    };

    // Mark as running
    storage::with_tasks(app, |tasks| {
        if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
            t.status = "running".to_string();
            if t.started_at.is_none() {
                t.started_at = Some(chrono::Local::now().to_rfc3339());
            }
        }
    });

    let _ = app.emit("task-updated", &task.id);

    // Get token: prefer runtime memory token, fallback to settings.token
    let settings_path = storage::settings_path(app);
    let settings: crate::models::Settings = storage::read_json(&settings_path, Default::default());
    let runtime_config = read_runtime_config(app);
    let token = resolve_image_token(&runtime_config, &settings.token);
    let image_base_url = resolve_image_base_url(&runtime_config);
    let requires_openai_token = task.task_type != "remove_background";

    if requires_openai_token && token.is_empty() {
        storage::with_tasks(app, |tasks| {
            if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
                fail_task_in_place(t, "API Token 未设置");
            }
        });
        let _ = app.emit("task-updated", &task.id);
        return;
    }

    // Ensure output directory exists
    let output_dir = task.output_dir.clone();
    if !Path::new(&output_dir).exists() {
        if fs::create_dir_all(&output_dir).is_err() {
            storage::with_tasks(app, |tasks| {
                if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
                    fail_task_in_place(t, "无法创建输出目录");
                }
            });
            let _ = app.emit("task-updated", &task.id);
            return;
        }
    }

    let client = {
        let mut builder = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .connect_timeout(std::time::Duration::from_secs(30))
            .use_native_tls();
        if let Some(proxy_url) = crate::commands::read_windows_system_proxy() {
            if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
                builder = builder.proxy(proxy);
            }
        }
        builder.build().unwrap_or_else(|_| reqwest::Client::new())
    };

    // 计数从 sub_tasks 事实初始化：V4.0.5 部分重试时已完成/已失败子任务保留原状态，
    // 本轮只补失败槽位，计数必须在既有事实基础上累加（而非从 0 重新数导致回退）。
    let mut success_count = task
        .sub_tasks
        .iter()
        .filter(|st| st.status == "completed")
        .count();
    let mut failed_count = task
        .sub_tasks
        .iter()
        .filter(|st| st.status == "failed")
        .count();
    let total = task.count;
    let mut was_cancelled = false;

    for i in 0..total {
        // Check if cancelled / skip already-completed children（V4.0.5 单子任务重试：
        // 已成功子任务绝不重跑，其图片与结果保持原样）
        let (cancelled, skip_completed) = storage::with_tasks(app, |tasks| {
            tasks
                .iter()
                .find(|t| t.id == task.id)
                .map(|t| {
                    (
                        t.status == "cancelled",
                        i < t.sub_tasks.len() && t.sub_tasks[i].status == "completed",
                    )
                })
                .unwrap_or((false, false))
        });

        if cancelled {
            was_cancelled = true;
            break;
        }
        if skip_completed {
            continue;
        }

        // Update sub-task to running
        storage::with_tasks(app, |tasks| {
            if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
                if i < t.sub_tasks.len() {
                    t.sub_tasks[i].status = "running".to_string();
                }
            }
        });
        let _ = app.emit("task-updated", &task.id);

        // V4.0.8：执行路由唯一决策点（ImageExecutionRoute），禁止再按字符串散落分发。
        // Pose Batch master_reference：该槽以批内 master 白膜为参考图 → Edits 路由。
        let pose_master_reference = prepare_pose_slot_reference(app, &mut task, i);
        let result = match if pose_master_reference {
            ImageExecutionRoute::Edits
        } else {
            resolve_execution_route(&task.task_type)
        } {
            ImageExecutionRoute::RemoveBackground => {
                remove_background_single_image(&settings, &task, i).await
            }
            ImageExecutionRoute::Edits => {
                edit_single_image(&client, &token, &image_base_url, &task, i).await
            }
            ImageExecutionRoute::FrontendDriven => continue, // 理论不可达（认领时已过滤）
            ImageExecutionRoute::Generations => {
                generate_single_image(&client, &token, &image_base_url, &task, i).await
            }
        };

        match result {
            Ok(image_record) => {
                success_count += 1;
                storage::with_tasks(app, |tasks| {
                    if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
                        if i < t.sub_tasks.len() {
                            t.sub_tasks[i].status = "completed".to_string();
                            t.sub_tasks[i].image_id = Some(image_record.id.clone());
                            t.sub_tasks[i].error = None;
                            t.sub_tasks[i].error_detail = None;
                        }
                        t.success_count = success_count;
                    }
                });
                record_pose_master_if_needed(app, &task, i, &image_record.id);
                storage::with_images(app, |images| {
                    images.push(image_record);
                });
            }
            Err(f) => {
                failed_count += 1;
                storage::with_tasks(app, |tasks| {
                    if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
                        if i < t.sub_tasks.len() {
                            let st = &mut t.sub_tasks[i];
                            st.status = "failed".to_string();
                            st.error = Some(f.message.clone());
                            st.error_detail = f.detail.clone();
                            // attempt 历史：最近在后，封顶 5 条（重试成功后 error 清空、历史保留）
                            st.attempt_errors.push(f.message.clone());
                            if st.attempt_errors.len() > 5 {
                                st.attempt_errors.remove(0);
                            }
                            if let Some(d) = &f.detail {
                                st.attempt_details.push(d.clone());
                                if st.attempt_details.len() > 5 {
                                    st.attempt_details.remove(0);
                                }
                            }
                        }
                        t.failed_count = failed_count;
                    }
                });
            }
        }

        let _ = app.emit("task-updated", &task.id);
    }

    // Finalize task status：状态与计数统一由 reconciliation 模块从 sub_tasks 事实派生
    storage::with_tasks(app, |tasks| {
        if let Some(t) = tasks.iter_mut().find(|t| t.id == task.id) {
            finalize_task_in_place(t, was_cancelled);
        }
    });
    let _ = app.emit("task-updated", &task.id);
}

async fn generate_single_image(
    client: &reqwest::Client,
    token: &str,
    base_url: &str,
    task: &Task,
    index: usize,
) -> Result<ImageRecord, TaskFailure> {
    let body = serde_json::json!({
        "model": "gpt-image-2",
        "prompt": compose_model_instruction(
            &effective_prompt(task, index),
            &effective_negative_prompt(task, index),
        ),
        "size": task.size,
        "quality": task.quality,
        "output_format": task.output_format,
        "response_format": "b64_json",
        "n": 1
    });

    let url = ImageExecutionRoute::Generations.endpoint_url(base_url);

    let response = send_with_transient_retry(&url, || {
        client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", token))
            .json(&body)
    })
    .await
    .map_err(|f| TaskFailure { message: f.message, detail: Some(f.detail) })?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(upstream_image_failure(status, &text, &url));
    }

    let api_response: ApiResponse = response
        .json()
        .await
        .map_err(|e| TaskFailure::processing(format!("解析响应失败: {}", e)))?;

    let image_data = api_response
        .data
        .into_iter()
        .next()
        .ok_or_else(|| TaskFailure::processing("API 未返回图片数据".to_string()))?;

    let b64 = image_data
        .b64_json
        .ok_or_else(|| TaskFailure::processing("响应中缺少 base64 数据".to_string()))?;

    let image_bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &b64)
        .map_err(|e| TaskFailure::processing(format!("Base64 解码失败: {}", e)))?;

    let now = chrono::Local::now();
    let timestamp = now.format("%Y%m%d_%H%M%S");
    let ext = &task.output_format;
    let file_name = format!("{}_{}.{}", timestamp, index + 1, ext);

    let file_path = Path::new(&task.output_dir).join(&file_name);
    fs::write(&file_path, &image_bytes)
        .map_err(|e| TaskFailure::local_file(format!("保存图片失败: {}", e)))?;

    let image_id = uuid::Uuid::new_v4().to_string();

    Ok(ImageRecord {
        id: image_id,
        task_id: task.id.clone(),
        local_path: file_path.to_string_lossy().replace('\\', "/"),
        file_name,
        created_at: now.to_rfc3339(),
        status: "saved".to_string(),
        source_kind: "output".to_string(),
        missing: false,
        last_seen_at: Some(now.to_rfc3339()),
        width: None,
        height: None,
        file_size: Some(image_bytes.len() as u64),
        description: batch_item_description(task, index),
        tags: Vec::new(),
        indexed_at: None,
    })
}

pub fn mime_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "image/png",
    }
}

async fn remove_background_single_image(
    settings: &crate::models::Settings,
    task: &Task,
    index: usize,
) -> Result<ImageRecord, TaskFailure> {
    let api_key = settings.removebg_api_key.trim();
    if api_key.is_empty() {
        let message = "请先在设置中配置 remove.bg API Key".to_string();
        return Err(TaskFailure {
            detail: Some(build_local_failure_detail("auth", &message, false)),
            message,
        });
    }

    let source_path = task
        .source_images
        .get(index)
        .or_else(|| task.source_images.first())
        .ok_or_else(|| TaskFailure::local_file("去背景任务缺少源图".to_string()))?;
    let path = Path::new(source_path);
    if !path.exists() {
        return Err(TaskFailure::local_file(format!("源图不存在: {}", source_path)));
    }

    let bytes = fs::read(path)
        .map_err(|e| TaskFailure::local_file(format!("读取源图失败: {}", e)))?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image.png")
        .to_string();
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(mime_for_path(path))
        .map_err(|e| TaskFailure::processing(format!("构建上传文件失败: {}", e)))?;
    let form = reqwest::multipart::Form::new()
        .part("image_file", part)
        .text("size", "auto");

    let resp = reqwest::Client::new()
        .post("https://api.remove.bg/v1.0/removebg")
        .header("X-Api-Key", api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| TaskFailure::unclassified(format!("remove.bg 请求失败: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(TaskFailure::unclassified(format!(
            "remove.bg 错误 {}: {}",
            status, text
        )));
    }

    let transparent_dir = Path::new(&task.output_dir).join("transparent");
    fs::create_dir_all(&transparent_dir)
        .map_err(|e| TaskFailure::local_file(format!("创建透明图目录失败: {}", e)))?;

    let now = chrono::Local::now();
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let filename = format!("{}_transparent_{}.png", stem, now.format("%Y%m%d_%H%M%S"));
    let filepath = transparent_dir.join(&filename);
    let image_bytes = resp
        .bytes()
        .await
        .map_err(|e| TaskFailure::processing(format!("读取 remove.bg 响应失败: {}", e)))?;
    fs::write(&filepath, &image_bytes)
        .map_err(|e| TaskFailure::local_file(format!("保存透明图失败: {}", e)))?;

    Ok(ImageRecord {
        id: uuid::Uuid::new_v4().to_string(),
        task_id: task.id.clone(),
        local_path: filepath.to_string_lossy().replace('\\', "/"),
        file_name: filename,
        created_at: now.to_rfc3339(),
        status: "transparent".to_string(),
        source_kind: "postprocess".to_string(),
        missing: false,
        last_seen_at: Some(now.to_rfc3339()),
        width: None,
        height: None,
        file_size: Some(image_bytes.len() as u64),
        description: None,
        tags: Vec::new(),
        indexed_at: None,
    })
}

async fn edit_single_image(
    client: &reqwest::Client,
    token: &str,
    base_url: &str,
    task: &Task,
    index: usize,
) -> Result<ImageRecord, TaskFailure> {
    // ===== 源图前置校验（图生图执行的硬边界）=====
    // 空源图 / 源图文件不存在时必须在本地立即失败，给出明确错误；
    // 绝不把无源图 / 坏路径的 edit 请求发给上游，也绝不静默 fallback 到其它图片。
    let source_images = effective_source_images(task, index);
    if source_images.is_empty() {
        return Err(TaskFailure::local_file(
            "图生图任务缺少源图片，请在任务卡中重新绑定源图片后再执行。".to_string(),
        ));
    }
    for img_path in &source_images {
        if !Path::new(img_path).exists() {
            return Err(TaskFailure::local_file(format!(
                "源图片不存在：{}。该任务引用的源图可能已被删除或移动，请在任务卡中切换源图片后重试。",
                img_path
            )));
        }
    }

    // 源图字节一次性预读（重试时不重复读盘），Form 每次发送时重建（multipart Form 不可 Clone）
    let mut image_parts: Vec<(String, Vec<u8>, &'static str)> = Vec::new();
    for img_path in &source_images {
        let path = Path::new(img_path);
        let file_bytes = fs::read(path)
            .map_err(|e| TaskFailure::local_file(format!("无法读取源图片 {}: {}", img_path, e)))?;
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("image.png")
            .to_string();
        image_parts.push((file_name, file_bytes, mime_for_path(path)));
    }
    let prompt_text = compose_model_instruction(
        &effective_prompt(task, index),
        &effective_negative_prompt(task, index),
    );
    let size_text = task.size.clone();

    // 区域替换 mask（视觉项目 Region V1）：真实进入 edits 请求的 `mask` 部件。
    // 与源图同级硬校验 —— 声明了 mask 但文件缺失 / 读取失败必须本地失败，
    // 绝不静默降级成「无 mask 全图重绘」（那会让区域约束悄悄失效）。
    let mask_bytes: Option<Vec<u8>> = match &task.mask_image {
        Some(mask_path) if !mask_path.trim().is_empty() => {
            let path = Path::new(mask_path);
            if !path.exists() {
                return Err(TaskFailure::local_file(format!(
                    "区域 mask 文件不存在：{}。该任务引用的 mask 可能已被删除，请重新编辑区域后重试。",
                    mask_path
                )));
            }
            Some(fs::read(path)
                .map_err(|e| TaskFailure::local_file(format!("无法读取区域 mask {}: {}", mask_path, e)))?)
        }
        _ => None,
    };

    let build_form = || {
        let mut form = reqwest::multipart::Form::new()
            .text("model", "gpt-image-2")
            .text("prompt", prompt_text.clone())
            .text("n", "1")
            .text("size", size_text.clone())
            .text("response_format", "b64_json");
        for (file_name, bytes, mime) in &image_parts {
            let part = reqwest::multipart::Part::bytes(bytes.clone())
                .file_name(file_name.clone())
                .mime_str(mime)
                .unwrap();
            form = form.part("image[]", part);
        }
        if let Some(bytes) = &mask_bytes {
            let part = reqwest::multipart::Part::bytes(bytes.clone())
                .file_name("mask.png")
                .mime_str("image/png")
                .unwrap();
            form = form.part("mask", part);
        }
        form
    };

    let url = ImageExecutionRoute::Edits.endpoint_url(base_url);

    let response = send_with_transient_retry(&url, || {
        client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .multipart(build_form())
    })
    .await
    .map_err(|f| TaskFailure { message: f.message, detail: Some(f.detail) })?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(upstream_image_failure(status, &text, &url));
    }

    let api_response: ApiResponse = response
        .json()
        .await
        .map_err(|e| TaskFailure::processing(format!("解析响应失败: {}", e)))?;

    let image_data = api_response
        .data
        .into_iter()
        .next()
        .ok_or_else(|| TaskFailure::processing("API 未返回图片数据".to_string()))?;

    let image_bytes = if let Some(b64) = image_data.b64_json {
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &b64)
            .map_err(|e| TaskFailure::processing(format!("Base64 解码失败: {}", e)))?
    } else {
        return Err(TaskFailure::processing("响应中缺少 b64_json 数据".to_string()));
    };

    let now = chrono::Local::now();
    let timestamp = now.format("%Y%m%d_%H%M%S");
    let ext = &task.output_format;
    let file_name = format!("{}_{}_edit.{}", timestamp, index + 1, ext);

    let file_path = Path::new(&task.output_dir).join(&file_name);
    fs::write(&file_path, &image_bytes)
        .map_err(|e| TaskFailure::local_file(format!("保存图片失败: {}", e)))?;

    let image_id = uuid::Uuid::new_v4().to_string();

    Ok(ImageRecord {
        id: image_id,
        task_id: task.id.clone(),
        local_path: file_path.to_string_lossy().replace('\\', "/"),
        file_name,
        created_at: now.to_rfc3339(),
        status: "saved".to_string(),
        source_kind: "output".to_string(),
        missing: false,
        last_seen_at: Some(now.to_rfc3339()),
        width: None,
        height: None,
        file_size: Some(image_bytes.len() as u64),
        description: batch_item_description(task, index),
        tags: Vec::new(),
        indexed_at: None,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        format_upstream_image_error, is_frontend_driven_task, resolve_execution_route,
        ImageExecutionRoute,
    };
    use crate::models::{SubTask, Task};

    fn task_of_type(task_type: &str) -> Task {
        Task {
            id: "t".to_string(),
            prompt: "p".to_string(),
            negative_prompt: String::new(),
            user_prompt_raw: "p".to_string(),
            final_prompt: "p".to_string(),
            final_negative_prompt: String::new(),
            prompt_optimized: false,
            prompt_optimization: None,
            agent_intent: String::new(),
            task_source: "manual".to_string(),
            size: "1024x1024".to_string(),
            quality: "auto".to_string(),
            output_format: "png".to_string(),
            count: 1,
            status: "pending".to_string(),
            created_at: "2026-01-01T00:00:00".to_string(),
            started_at: None,
            completed_at: None,
            output_dir: "/tmp".to_string(),
            success_count: 0,
            failed_count: 0,
            sub_tasks: vec![SubTask {
                index: 0,
                status: "pending".to_string(),
                image_id: None,
                error: None,
                label: None,
                retry_count: 0,
                attempt_errors: Vec::new(),
                error_detail: None,
                attempt_details: Vec::new(),
            }],
            task_type: task_type.to_string(),
            source_images: Vec::new(),
            mask_image: None,
            execution_mode: "single".to_string(),
            batch_strategy: String::new(),
            task_plan_summary: String::new(),
            batch_items: Vec::new(),
            composite_layout: None,
            subject_entities: Vec::new(),
            source_task_id: None,
            source_task_kind: String::new(),
            stage_note: String::new(),
            source_app: String::new(),
            source_request_id: String::new(),
            source_context: None,
            pose_batch: None,
            provenance: None,
        }
    }

    #[test]
    fn vision_understanding_tasks_are_never_claimed_by_runner() {
        assert!(is_frontend_driven_task(&task_of_type("vision_understanding")));
        assert!(!is_frontend_driven_task(&task_of_type("generate")));
        assert!(!is_frontend_driven_task(&task_of_type("edit")));
        assert!(!is_frontend_driven_task(&task_of_type("remove_background")));
    }

    // ===== V4.0.8 路由适配：task_type → 路由 → endpoint（业务语义路由，禁止 edit 走文本通道）=====

    #[test]
    fn edit_tasks_route_to_images_edits_endpoint() {
        let route = resolve_execution_route("edit");
        assert_eq!(route, ImageExecutionRoute::Edits);
        assert_eq!(
            route.endpoint_url("https://www.packyapi.com"),
            "https://www.packyapi.com/v1/images/edits"
        );
        assert!(route.is_runner_executed());
    }

    #[test]
    fn generate_tasks_route_to_images_generations_endpoint() {
        let route = resolve_execution_route("generate");
        assert_eq!(route, ImageExecutionRoute::Generations);
        assert_eq!(
            route.endpoint_url("https://www.packyapi.com"),
            "https://www.packyapi.com/v1/images/generations"
        );
        // 空 task_type 历史约定回落文生图
        assert_eq!(resolve_execution_route(""), ImageExecutionRoute::Generations);
    }

    #[test]
    fn remove_background_routes_to_removebg() {
        let route = resolve_execution_route("remove_background");
        assert_eq!(route, ImageExecutionRoute::RemoveBackground);
        assert_eq!(
            route.endpoint_url("https://ignored.example.com"),
            "https://api.remove.bg/v1.0/removebg"
        );
    }

    #[test]
    fn vision_tasks_are_frontend_driven_without_endpoint() {
        let route = resolve_execution_route("vision_understanding");
        assert_eq!(route, ImageExecutionRoute::FrontendDriven);
        assert_eq!(route.endpoint_url("https://www.packyapi.com"), "");
        assert!(!route.is_runner_executed());
    }

    #[test]
    fn upstream_error_message_carries_endpoint_tag() {
        let status = reqwest::StatusCode::BAD_REQUEST;
        let body = r#"{"code":"text_conversation_not_supported","message":"model does not support image conversation"}"#;
        let message = format_upstream_image_error(
            status,
            body,
            "https://www.packyapi.com/v1/images/edits",
        );
        assert!(message.contains("[code: text_conversation_not_supported]"));
        assert!(message.contains("[endpoint: https://www.packyapi.com/v1/images/edits]"));
        assert!(message.contains("(HTTP 400)"));
    }
}
