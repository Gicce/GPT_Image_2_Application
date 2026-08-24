//! CY Video Studio 动作白膜批任务（Pose Batch Contract V1）—— 契约 DTO / 校验 /
//! ACTION_MANNEQUIN_V1 Prompt Preset / 任务构建 / Batch 状态派生。
//!
//! 职责边界：Video 决定画什么、画几张（Slot 规划完全由请求驱动，本端绝不增删视角
//! 或关键帧）；CyImagePro 负责把整批图稳定、统一、可追踪地生成出来。
//! 最终图片 Prompt 只在本端维护（Preset 升级到 V2 时 Video 无需改动）。
//!
//! 落地形态：一个 PoseBatch = 一个 Task。sub_tasks[i] = 槽位执行状态（复用 V4.0.5
//! 槽位重试 / 部分完成机制），batch_items[i] = 槽位 Prompt 快照，批级共享上下文
//! （Preset 版本 / 一致性策略 / 画幅 / 槽位语义）存 Task.pose_batch。

use crate::models::{PoseBatchMeta, PoseSlotMeta, Settings, SubTask, Task, TaskBatchItem};

/// Pose Batch 契约版本（/bridge/create-pose-batch 等）
pub const POSE_BATCH_CONTRACT_VERSION: u32 = 1;
/// 动作白膜 Prompt Preset 版本
pub const ACTION_MANNEQUIN_PRESET: &str = "ACTION_MANNEQUIN_V1";
/// 单批槽位上限（与既有 /bridge/create-task 的 count 钳制口径一致）
pub const MAX_POSE_SLOTS: usize = 8;
/// 视角白名单
pub const POSE_VIEWS: [&str; 4] = ["front_3q", "front", "side", "back"];
/// 关键帧白名单
pub const POSE_KEYFRAMES: [&str; 4] = ["none", "start", "middle", "end"];

// ========== 契约 DTO（camelCase，与 Video 侧对接） ==========

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoseBatchRequest {
    #[serde(default)]
    pub contract_version: u32,
    pub request_id: String,
    pub batch_id: String,
    #[serde(default)]
    pub source_context: serde_json::Value,
    pub action: PoseActionDto,
    #[serde(default)]
    pub generation: PoseGenerationDto,
    #[serde(default)]
    pub slots: Vec<PoseSlotDto>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoseActionDto {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub normalized_pose: String,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoseGenerationDto {
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub candidate_count: usize,
    /// V1 前向兼容：单候选下选优恒真（selectedImageId = 唯一产物），多候选是 V2 扩展位
    #[serde(default)]
    #[allow(dead_code)]
    pub auto_select_best: bool,
    #[serde(default)]
    pub mannequin_preset: Option<String>,
    #[serde(default)]
    pub consistency_strategy: Option<String>,
    #[serde(default)]
    pub size: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoseSlotDto {
    pub slot_id: String,
    pub view: String,
    #[serde(default)]
    pub keyframe: String,
    #[serde(default)]
    pub pose_description: String,
    #[serde(default)]
    pub key_pose_points: Vec<String>,
}

// ========== 校验与规划（纯函数） ==========

#[derive(Debug)]
pub struct PoseBatchError {
    pub code: &'static str,
    pub message: String,
}

impl PoseBatchError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

/// 规划产物：槽位 Prompt / 共享参数 / 生效候选数（如实回报，不伪造能力）
#[derive(Debug, Clone)]
pub struct PoseBatchPlan {
    pub request_id: String,
    pub batch_id: String,
    pub action_id: String,
    pub action_name: String,
    pub normalized_pose: String,
    pub source_feature: String,
    pub size: String,
    pub quality: String,
    pub output_format: String,
    pub consistency_strategy: String,
    pub preset_version: String,
    /// V1 固定 1（多候选是 V2 扩展位；请求 >1 时如实标记 clamped）
    pub candidate_count_effective: usize,
    pub candidate_count_clamped: bool,
    pub slots: Vec<PlanSlot>,
}

#[derive(Debug, Clone)]
pub struct PlanSlot {
    pub slot_id: String,
    pub view: String,
    pub keyframe: String,
    pub label: String,
    pub pose_description: String,
    pub key_pose_points: Vec<String>,
    pub final_prompt: String,
    pub negative_prompt: String,
}

fn valid_size(s: &str) -> bool {
    let mut parts = s.splitn(2, 'x');
    let (w, h) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    !w.is_empty()
        && !h.is_empty()
        && w.len() <= 4
        && h.len() <= 4
        && w.bytes().all(|b| b.is_ascii_digit())
        && h.bytes().all(|b| b.is_ascii_digit())
}

/// 校验并规划 Pose Batch。所有拒绝都以 (code, message) 返回，Bridge 映射 400。
pub fn plan_pose_batch(req: &PoseBatchRequest, settings: &Settings) -> Result<PoseBatchPlan, PoseBatchError> {
    let version = if req.contract_version == 0 { 1 } else { req.contract_version };
    if version > POSE_BATCH_CONTRACT_VERSION {
        return Err(PoseBatchError::new(
            "unsupported_contract_version",
            format!("不支持的契约版本 {version}（本端支持 ≤{POSE_BATCH_CONTRACT_VERSION}）"),
        ));
    }
    if req.request_id.trim().is_empty() {
        return Err(PoseBatchError::new("invalid_request_id", "requestId 不能为空"));
    }
    if req.batch_id.trim().is_empty() {
        return Err(PoseBatchError::new("invalid_batch_id", "batchId 不能为空"));
    }
    if req.action.id.trim().is_empty() || req.action.name.trim().is_empty() {
        return Err(PoseBatchError::new("invalid_action", "action.id 与 action.name 不能为空"));
    }
    let normalized_pose = req.action.normalized_pose.trim().to_string();
    if req.slots.is_empty() {
        return Err(PoseBatchError::new("empty_slots", "slots 不能为空"));
    }
    if req.slots.len() > MAX_POSE_SLOTS {
        return Err(PoseBatchError::new(
            "too_many_slots",
            format!("槽位数量 {} 超过上限 {MAX_POSE_SLOTS}", req.slots.len()),
        ));
    }
    if let Some(model_id) = req.generation.model_id.as_deref() {
        if !model_id.trim().is_empty() {
            return Err(PoseBatchError::new(
                "model_not_supported",
                "V1 暂不支持指定模型（图片模型固定 gpt-image-2），请传 null",
            ));
        }
    }
    let preset = req
        .generation
        .mannequin_preset
        .clone()
        .unwrap_or_else(|| ACTION_MANNEQUIN_PRESET.to_string());
    if preset != ACTION_MANNEQUIN_PRESET {
        return Err(PoseBatchError::new(
            "unknown_preset",
            format!("未知的动作白膜 Preset：{preset}（本端仅支持 {ACTION_MANNEQUIN_PRESET}）"),
        ));
    }
    let strategy = req
        .generation
        .consistency_strategy
        .clone()
        .unwrap_or_else(|| "prompt_only".to_string());
    if strategy != "prompt_only" && strategy != "master_reference" {
        return Err(PoseBatchError::new(
            "invalid_consistency_strategy",
            format!("consistencyStrategy 仅支持 prompt_only / master_reference，收到 {strategy}"),
        ));
    }
    // 画幅：请求显式指定 → 竖幅全身像默认（白膜是专项能力，不取通用图的 default_size 方形默认）
    let size = req
        .generation
        .size
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("1024x1536")
        .to_string();
    if !valid_size(&size) {
        return Err(PoseBatchError::new(
            "invalid_size",
            format!("非法画幅 {size}（格式如 1024x1536）"),
        ));
    }
    let quality = if settings.default_quality.trim().is_empty() {
        "high".to_string()
    } else {
        settings.default_quality.trim().to_string()
    };
    let output_format = if settings.default_format.trim().is_empty() {
        "png".to_string()
    } else {
        settings.default_format.trim().to_string()
    };

    let mut plan_slots = Vec::with_capacity(req.slots.len());
    let mut seen_slot_ids = std::collections::HashSet::new();
    let mut has_pose_semantics = !normalized_pose.is_empty();
    for (i, slot) in req.slots.iter().enumerate() {
        let slot_id = slot.slot_id.trim().to_string();
        if slot_id.is_empty() {
            return Err(PoseBatchError::new(
                "invalid_slot_id",
                format!("第 {} 个槽位 slotId 为空", i + 1),
            ));
        }
        if !seen_slot_ids.insert(slot_id.clone()) {
            return Err(PoseBatchError::new(
                "duplicate_slot_id",
                format!("slotId 重复：{slot_id}"),
            ));
        }
        if !POSE_VIEWS.contains(&slot.view.as_str()) {
            return Err(PoseBatchError::new(
                "invalid_view",
                format!("槽位 {slot_id} 视角非法：{}（允许 {}）", slot.view, POSE_VIEWS.join("/")),
            ));
        }
        let keyframe = if slot.keyframe.trim().is_empty() { "none".to_string() } else { slot.keyframe.trim().to_string() };
        if !POSE_KEYFRAMES.contains(&keyframe.as_str()) {
            return Err(PoseBatchError::new(
                "invalid_keyframe",
                format!("槽位 {slot_id} 关键帧非法：{keyframe}（允许 {}）", POSE_KEYFRAMES.join("/")),
            ));
        }
        let pose_description = slot.pose_description.trim().to_string();
        if !pose_description.is_empty() {
            has_pose_semantics = true;
        }
        let key_pose_points = slot
            .key_pose_points
            .iter()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .take(8)
            .collect::<Vec<_>>();
        let label = slot_label(&slot.view, &keyframe);
        let final_prompt = build_slot_final_prompt(
            &req.action.name,
            &normalized_pose,
            &pose_description,
            &key_pose_points,
            &slot.view,
            &keyframe,
        );
        plan_slots.push(PlanSlot {
            slot_id,
            view: slot.view.clone(),
            keyframe,
            label,
            pose_description,
            key_pose_points,
            final_prompt,
            negative_prompt: pose_negative_prompt().to_string(),
        });
    }
    if !has_pose_semantics {
        return Err(PoseBatchError::new(
            "invalid_pose",
            "动作语义为空：normalizedPose 与全部 poseDescription 均为空",
        ));
    }
    let requested_candidates = req.generation.candidate_count.max(1);
    let candidate_count_clamped = requested_candidates > 1;
    let source_feature = req
        .source_context
        .get("feature")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("motion-library")
        .to_string();
    Ok(PoseBatchPlan {
        request_id: req.request_id.trim().to_string(),
        batch_id: req.batch_id.trim().to_string(),
        action_id: req.action.id.trim().to_string(),
        action_name: req.action.name.trim().to_string(),
        normalized_pose,
        source_feature,
        size,
        quality,
        output_format,
        consistency_strategy: strategy,
        preset_version: preset,
        candidate_count_effective: 1,
        candidate_count_clamped,
        slots: plan_slots,
    })
}

// ========== ACTION_MANNEQUIN_V1 Prompt Preset ==========

/// 技术动作参考图（非艺术图）：统一白膜人偶 + 中性棚拍 + 视角/关键帧相机指令。
pub fn build_slot_final_prompt(
    action_name: &str,
    normalized_pose: &str,
    pose_description: &str,
    key_pose_points: &[String],
    view: &str,
    keyframe: &str,
) -> String {
    let camera = view_camera_phrase(view);
    let phase = keyframe_phrase(keyframe);
    let mut pose_line = String::new();
    if !normalized_pose.is_empty() {
        pose_line.push_str(normalized_pose);
    }
    if !pose_description.is_empty() {
        if !pose_line.is_empty() {
            pose_line.push_str("；");
        }
        pose_line.push_str(pose_description);
    }
    let points = if key_pose_points.is_empty() {
        String::new()
    } else {
        format!(" Key pose points: {}.", key_pose_points.join("; "))
    };
    format!(
        "Technical pose reference sheet. Single human mannequin figure, matte white clay material, \
neutral realistic human proportions, full body visible from head to feet, clean silhouette, \
clearly defined joints, clear separation between limbs. Plain light gray studio background, \
soft neutral even lighting, no props, no environment. Camera: {camera}. {phase}\
Pose: {action_name} — {pose_line}.{points} \
Keep the mannequin material, body proportions, camera height, framing and background identical \
across the whole pose series; only the pose, viewing angle and motion phase change between frames. \
Full-body composition, the entire figure centered inside the frame with margins."
    )
}

/// 负面提示词：艺术化 / 人物特征 / 解剖错误 / 镜头畸变 / 干扰元素全部压制
pub fn pose_negative_prompt() -> &'static str {
    "real person, photorealistic face, skin texture, hair, fashion clothing, shoes, accessories, \
props, complex environment, detailed background, multiple people, second figure, cropped hands, \
cropped feet, cut-off limbs, extra limbs, extra fingers, merged limbs, fused limbs, broken \
anatomy, twisted joints, dramatic perspective, fisheye lens, wide-angle distortion, motion blur, \
busy background, text, caption, logo, watermark"
}

/// 视角相机指令（白膜系列共享眼平机位与中等距离，只变角度）
pub fn view_camera_phrase(view: &str) -> &'static str {
    match view {
        "front_3q" => "front three-quarter view, camera rotated about 30-45 degrees from \
straight-on, eye-level camera height, medium distance",
        "front" => "straight-on front view, eye-level camera height, medium distance, figure \
centered and vertical",
        "side" => "strict side profile view at exactly 90 degrees, true lateral view, eye-level \
camera height, medium distance",
        "back" => "back view with the figure facing away from the camera, eye-level camera \
height, medium distance",
        _ => "eye-level camera height, medium distance",
    }
}

pub fn keyframe_phrase(keyframe: &str) -> &'static str {
    match keyframe {
        "start" => "Motion phase: beginning of the action (start keyframe). ",
        "middle" => "Motion phase: middle of the action (apex keyframe). ",
        "end" => "Motion phase: end of the action (final keyframe). ",
        _ => "",
    }
}

/// 视角中文标签
pub fn view_label(view: &str) -> String {
    match view {
        "front_3q" => "前3/4".to_string(),
        "front" => "正面".to_string(),
        "side" => "侧面".to_string(),
        "back" => "背面".to_string(),
        other => other.to_string(),
    }
}

/// 关键帧中文标签（none 返回空串）
pub fn keyframe_label(keyframe: &str) -> &'static str {
    match keyframe {
        "start" => "起始",
        "middle" => "中间",
        "end" => "结束",
        _ => "",
    }
}

/// 槽位中文标签：如「前3/4 · 起始」；keyframe=none 时仅视角
pub fn slot_label(view: &str, keyframe: &str) -> String {
    let kf = keyframe_label(keyframe);
    if kf.is_empty() {
        view_label(view).to_string()
    } else {
        format!("{} · {}", view_label(view), kf)
    }
}

// ========== 任务构建 ==========

/// 由规划产物构建可入队的 Task（pending）。Prompt 全部落在 batch_items[i]
/// 的 override 上，执行器逐槽读取；批语义落 pose_batch。
pub fn build_pose_batch_task(plan: &PoseBatchPlan, output_dir: String) -> Task {
    let now = chrono::Local::now().to_rfc3339();
    let count = plan.slots.len();
    let user_prompt_raw = format!(
        "动作白膜 · {}{}（{} 槽位 · CY Video Studio）",
        plan.action_name,
        if plan.normalized_pose.is_empty() { String::new() } else { format!("：{}", plan.normalized_pose) },
        count
    );
    let first_prompt = plan
        .slots
        .first()
        .map(|s| s.final_prompt.clone())
        .unwrap_or_default();
    Task {
        id: uuid::Uuid::new_v4().to_string(),
        prompt: first_prompt.clone(),
        negative_prompt: String::new(),
        user_prompt_raw,
        final_prompt: first_prompt,
        final_negative_prompt: pose_negative_prompt().to_string(),
        prompt_optimized: false,
        prompt_optimization: Some(crate::models::PromptOptimizationSnapshot {
            applied: false,
            provider_name: "CY Video Studio".to_string(),
            model_name: plan.preset_version.clone(),
            original_prompt: plan.action_name.clone(),
            optimized_at: String::new(),
            manually_edited_after: false,
            // pose_preset = 动作白膜 Preset 产物（本端模板，禁止再次优化）
            source: "pose_preset".to_string(),
        }),
        agent_intent: String::new(),
        task_source: crate::video_task_bridge::SOURCE_APP_CY_VIDEO.to_string(),
        size: plan.size.clone(),
        quality: plan.quality.clone(),
        output_format: plan.output_format.clone(),
        count,
        status: "pending".to_string(),
        created_at: now,
        started_at: None,
        completed_at: None,
        output_dir,
        success_count: 0,
        failed_count: 0,
        sub_tasks: plan
            .slots
            .iter()
            .enumerate()
            .map(|(i, s)| SubTask {
                index: i,
                status: "pending".to_string(),
                image_id: None,
                error: None,
                label: Some(s.label.clone()),
                retry_count: 0,
                attempt_errors: Vec::new(),
                error_detail: None,
                attempt_details: Vec::new(),
            })
            .collect(),
        task_type: "generate".to_string(),
        source_images: Vec::new(),
        mask_image: None,
        execution_mode: "batch".to_string(),
        batch_strategy: String::new(),
        task_plan_summary: plan.action_name.clone(),
        batch_items: plan
            .slots
            .iter()
            .map(|s| TaskBatchItem {
                id: s.slot_id.clone(),
                label: s.label.clone(),
                prompt_delta: String::new(),
                prompt_override: s.final_prompt.clone(),
                negative_override: s.negative_prompt.clone(),
                negative_delta: String::new(),
                source_images: Vec::new(),
                enabled: true,
                plan_title: plan.action_name.clone(),
                plan_summary: plan.normalized_pose.clone(),
                plan_tags: Vec::new(),
                plan_description: s.pose_description.clone(),
            })
            .collect(),
        composite_layout: None,
        subject_entities: Vec::new(),
        source_task_id: None,
        source_task_kind: "video_pose_batch".to_string(),
        stage_note: String::new(),
        source_app: crate::video_task_bridge::SOURCE_APP_CY_VIDEO.to_string(),
        source_request_id: plan.request_id.clone(),
        source_context: Some(serde_json::json!({
            "feature": plan.source_feature,
            "purpose": format!("动作白膜 · {}", plan.action_name),
        })),
        pose_batch: Some(PoseBatchMeta {
            batch_id: plan.batch_id.clone(),
            contract_version: POSE_BATCH_CONTRACT_VERSION,
            preset_version: plan.preset_version.clone(),
            action_id: plan.action_id.clone(),
            action_name: plan.action_name.clone(),
            normalized_pose: plan.normalized_pose.clone(),
            consistency_strategy: plan.consistency_strategy.clone(),
            aspect_ratio: plan.size.clone(),
            master_image_id: None,
            master_slot_index: None,
            slots: plan
                .slots
                .iter()
                .enumerate()
                .map(|(i, s)| PoseSlotMeta {
                    slot_id: s.slot_id.clone(),
                    view: s.view.clone(),
                    keyframe: s.keyframe.clone(),
                    pose_description: s.pose_description.clone(),
                    key_pose_points: s.key_pose_points.clone(),
                    sub_index: i,
                })
                .collect(),
        }),
        provenance: None,
    }
}

// ========== Batch / Slot 状态派生 ==========

/// Batch 状态：queued/running/partial/completed/failed/cancelled。
/// 一个槽位失败不把整批判死（success>0 → partial），与任务中心「部分完成」口径一致。
pub fn derive_batch_status(task: &Task) -> &'static str {
    match task.status.as_str() {
        "pending" => "queued",
        "running" => "running",
        "cancelled" => "cancelled",
        "completed" => "completed",
        "failed" if task.success_count > 0 => "partial",
        _ => "failed",
    }
}

/// 槽位状态契约值：pending→queued，其余原样（cancelled 保留）
pub fn slot_status(sub_status: &str) -> &str {
    match sub_status {
        "pending" => "queued",
        other => other,
    }
}

/// 按 batchId（优先）或 requestId 查找 Pose Batch 任务
pub fn find_pose_batch_task<'a>(tasks: &'a [Task], batch_id: &str, request_id: &str) -> Option<&'a Task> {
    let bid = batch_id.trim();
    if !bid.is_empty() {
        if let Some(t) = tasks.iter().find(|t| t.pose_batch.as_ref().map(|p| p.batch_id == bid).unwrap_or(false)) {
            return Some(t);
        }
    }
    let rid = request_id.trim();
    if !rid.is_empty() {
        return tasks.iter().find(|t| t.source_request_id == rid && t.pose_batch.is_some());
    }
    None
}

/// slotIds → sub_tasks 下标（校验归属；slotIds 为空 = 全部失败槽位）
pub fn map_slot_ids_to_indexes(pb: &PoseBatchMeta, slot_ids: &[String]) -> Result<Vec<usize>, String> {
    let mut indexes = Vec::with_capacity(slot_ids.len());
    for sid in slot_ids {
        let sid = sid.trim();
        let Some(slot) = pb.slots.iter().find(|s| s.slot_id == sid) else {
            return Err(format!("slotId 不属于该批次：{sid}"));
        };
        indexes.push(slot.sub_index);
    }
    Ok(indexes)
}

// ========== master_reference 一致性（纯判定部分） ==========

/// 该槽位是否应以批内 master 白膜为参考图走 Edits 路由。
/// master 未产生（首槽）/ 本槽即 master / 非 master_reference 策略 → false。
pub fn slot_should_use_master_reference(pb: &PoseBatchMeta, sub_index: usize) -> bool {
    pb.consistency_strategy == "master_reference"
        && pb.master_image_id.is_some()
        && pb.master_slot_index != Some(sub_index)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Settings {
        Settings::default()
    }

    /// 标准契约 Fixture：转身挥手 · 5 槽位（前3/4 起始/中间/结束 + 侧面中间 + 背面中间）
    pub fn fixture_request() -> PoseBatchRequest {
        let slot = |id: &str, view: &str, keyframe: &str, desc: &str| PoseSlotDto {
            slot_id: id.to_string(),
            view: view.to_string(),
            keyframe: keyframe.to_string(),
            pose_description: desc.to_string(),
            key_pose_points: Vec::new(),
        };
        PoseBatchRequest {
            contract_version: 1,
            request_id: "video-pose-request-001".to_string(),
            batch_id: "pose-batch-001".to_string(),
            source_context: serde_json::json!({
                "app": "cy-video-studio",
                "feature": "motion-library",
                "type": "pose_reference"
            }),
            action: PoseActionDto {
                id: "motion-123".to_string(),
                name: "转身挥手".to_string(),
                normalized_pose: "身体从正面转向左侧并挥手".to_string(),
            },
            generation: PoseGenerationDto {
                model_id: None,
                candidate_count: 1,
                auto_select_best: true,
                mannequin_preset: None,
                consistency_strategy: None,
                size: None,
            },
            slots: vec![
                slot("front_3q_start", "front_3q", "start", "起始姿态：正面站立，右手抬起准备挥动"),
                slot("front_3q_middle", "front_3q", "middle", "中间姿态：躯干左转约 60 度，右手挥至最高点"),
                slot("front_3q_end", "front_3q", "end", "结束姿态：完成转身面向左侧，右手放下"),
                slot("side_middle", "side", "middle", "中间姿态侧视：可见完整侧面轮廓与挥动手臂"),
                slot("back_middle", "back", "middle", "中间姿态背视：背部朝向镜头，手臂摆动可见"),
            ],
        }
    }

    #[test]
    fn fixture_plans_five_slots_with_labels() {
        let plan = plan_pose_batch(&fixture_request(), &settings()).unwrap();
        assert_eq!(plan.slots.len(), 5);
        assert_eq!(plan.slots[0].label, "前3/4 · 起始");
        assert_eq!(plan.slots[3].label, "侧面 · 中间");
        assert_eq!(plan.slots[4].label, "背面 · 中间");
        assert_eq!(plan.consistency_strategy, "prompt_only");
        assert_eq!(plan.size, "1024x1536");
        assert_eq!(plan.candidate_count_effective, 1);
        assert!(!plan.candidate_count_clamped);
    }

    #[test]
    fn task_carries_source_and_slot_prompts() {
        let plan = plan_pose_batch(&fixture_request(), &settings()).unwrap();
        let task = build_pose_batch_task(&plan, "D:/out".to_string());
        assert_eq!(task.count, 5);
        assert_eq!(task.source_app, "cy-video-studio");
        assert_eq!(task.source_request_id, "video-pose-request-001");
        assert_eq!(task.task_source, "cy-video-studio");
        assert_eq!(task.source_task_kind, "video_pose_batch");
        assert_eq!(task.execution_mode, "batch");
        assert_eq!(task.task_plan_summary, "转身挥手");
        let pb = task.pose_batch.as_ref().unwrap();
        assert_eq!(pb.batch_id, "pose-batch-001");
        assert_eq!(pb.contract_version, 1);
        assert_eq!(pb.preset_version, "ACTION_MANNEQUIN_V1");
        assert_eq!(pb.slots.len(), 5);
        assert_eq!(pb.slots[2].sub_index, 2);
        // 槽位 Prompt 落在 batch_items override，执行器逐槽读取
        assert!(task.batch_items[0].prompt_override.contains("Technical pose reference sheet"));
        assert!(task.batch_items[0].prompt_override.contains("three-quarter"));
        assert!(task.batch_items[3].prompt_override.contains("side profile"));
        assert!(task.batch_items[4].prompt_override.contains("facing away"));
        assert!(task.batch_items[1].prompt_override.contains("转身挥手"));
        assert!(task.batch_items[2].prompt_override.contains("final keyframe"));
        assert!(task.batch_items[0].negative_override.contains("watermark"));
        // 子任务标签 = 槽位中文标签（任务中心直接渲染）
        assert_eq!(task.sub_tasks[0].label.as_deref(), Some("前3/4 · 起始"));
        // 来源上下文（ sanitize 后仅保留白名单键 ）
        let ctx = task.source_context.unwrap();
        assert_eq!(ctx["feature"], "motion-library");
        assert!(ctx.get("type").is_none());
    }

    #[test]
    fn prompt_builder_keeps_pose_semantics_and_series_consistency() {
        let p = build_slot_final_prompt(
            "转身挥手",
            "身体从正面转向左侧并挥手",
            "躯干左转约 60 度",
            &["左脚跟离地".to_string(), "目视前方".to_string()],
            "side",
            "middle",
        );
        assert!(p.contains("matte white clay"));
        assert!(p.contains("only the pose, viewing angle and motion phase change"));
        assert!(p.contains("身体从正面转向左侧并挥手；躯干左转约 60 度"));
        assert!(p.contains("Key pose points: 左脚跟离地; 目视前方"));
        assert!(p.contains("apex keyframe"));
    }

    #[test]
    fn rejects_empty_and_duplicate_and_invalid_slots() {
        let mut req = fixture_request();
        req.slots.clear();
        assert_eq!(plan_pose_batch(&req, &settings()).unwrap_err().code, "empty_slots");

        let mut req = fixture_request();
        req.slots[1].slot_id = req.slots[0].slot_id.clone();
        assert_eq!(plan_pose_batch(&req, &settings()).unwrap_err().code, "duplicate_slot_id");

        let mut req = fixture_request();
        req.slots[2].view = "top_down".to_string();
        assert_eq!(plan_pose_batch(&req, &settings()).unwrap_err().code, "invalid_view");

        let mut req = fixture_request();
        req.slots[3].keyframe = "apex".to_string();
        assert_eq!(plan_pose_batch(&req, &settings()).unwrap_err().code, "invalid_keyframe");

        let mut req = fixture_request();
        req.slots[4].slot_id = "  ".to_string();
        assert_eq!(plan_pose_batch(&req, &settings()).unwrap_err().code, "invalid_slot_id");
    }

    #[test]
    fn rejects_bad_contract_action_model_preset_strategy_size() {
        let mut req = fixture_request();
        req.contract_version = 2;
        assert_eq!(plan_pose_batch(&req, &settings()).unwrap_err().code, "unsupported_contract_version");

        let mut req = fixture_request();
        req.request_id = " ".to_string();
        assert_eq!(plan_pose_batch(&req, &settings()).unwrap_err().code, "invalid_request_id");

        let mut req = fixture_request();
        req.batch_id = String::new();
        assert_eq!(plan_pose_batch(&req, &settings()).unwrap_err().code, "invalid_batch_id");

        let mut req = fixture_request();
        req.action.name = String::new();
        assert_eq!(plan_pose_batch(&req, &settings()).unwrap_err().code, "invalid_action");

        let mut req = fixture_request();
        req.generation.model_id = Some("gpt-image-x".to_string());
        assert_eq!(plan_pose_batch(&req, &settings()).unwrap_err().code, "model_not_supported");

        let mut req = fixture_request();
        req.generation.mannequin_preset = Some("ACTION_MANNEQUIN_V2".to_string());
        assert_eq!(plan_pose_batch(&req, &settings()).unwrap_err().code, "unknown_preset");

        let mut req = fixture_request();
        req.generation.consistency_strategy = Some("seed".to_string());
        assert_eq!(plan_pose_batch(&req, &settings()).unwrap_err().code, "invalid_consistency_strategy");

        let mut req = fixture_request();
        req.generation.size = Some("巨大".to_string());
        assert_eq!(plan_pose_batch(&req, &settings()).unwrap_err().code, "invalid_size");

        let mut req = fixture_request();
        req.action.normalized_pose = String::new();
        for s in req.slots.iter_mut() {
            s.pose_description = String::new();
        }
        assert_eq!(plan_pose_batch(&req, &settings()).unwrap_err().code, "invalid_pose");
    }

    #[test]
    fn too_many_slots_rejected_and_candidate_clamp_reported() {
        let mut req = fixture_request();
        req.slots = req
            .slots
            .iter()
            .cycle()
            .take(9)
            .enumerate()
            .map(|(i, s)| {
                let mut s = s.clone();
                s.slot_id = format!("{}-{i}", s.slot_id);
                s
            })
            .collect();
        assert_eq!(plan_pose_batch(&req, &settings()).unwrap_err().code, "too_many_slots");

        let mut req = fixture_request();
        req.generation.candidate_count = 4;
        let plan = plan_pose_batch(&req, &settings()).unwrap();
        assert_eq!(plan.candidate_count_effective, 1);
        assert!(plan.candidate_count_clamped, "candidateCount>1 必须如实标记钳制");
    }

    #[test]
    fn size_defaults_to_portrait_and_accepts_explicit() {
        // 默认竖幅全身像（不取通用图设置的方形默认）
        let plan = plan_pose_batch(&fixture_request(), &settings()).unwrap();
        assert_eq!(plan.size, "1024x1536");

        let mut s = settings();
        s.default_size = "2048x2048".to_string();
        let plan = plan_pose_batch(&fixture_request(), &s).unwrap();
        assert_eq!(plan.size, "1024x1536");

        let mut req = fixture_request();
        req.generation.size = Some("1536x1024".to_string());
        let plan = plan_pose_batch(&req, &settings()).unwrap();
        assert_eq!(plan.size, "1536x1024");

        let mut req = fixture_request();
        req.generation.size = Some("  ".to_string());
        let plan = plan_pose_batch(&req, &settings()).unwrap();
        assert_eq!(plan.size, "1024x1536");
    }

    #[test]
    fn keyframe_defaults_to_none_and_label_drops_phase() {
        let mut req = fixture_request();
        req.slots[0].keyframe = String::new();
        let plan = plan_pose_batch(&req, &settings()).unwrap();
        assert_eq!(plan.slots[0].keyframe, "none");
        assert_eq!(plan.slots[0].label, "前3/4");
        assert!(!plan.slots[0].final_prompt.contains("Motion phase"));
    }

    #[test]
    fn batch_status_covers_full_state_machine() {
        let mut task = build_pose_batch_task(&plan_pose_batch(&fixture_request(), &settings()).unwrap(), "out".into());
        assert_eq!(derive_batch_status(&task), "queued");
        task.status = "running".into();
        assert_eq!(derive_batch_status(&task), "running");
        task.status = "completed".into();
        assert_eq!(derive_batch_status(&task), "completed");
        task.status = "failed".into();
        task.success_count = 4;
        assert_eq!(derive_batch_status(&task), "partial");
        task.success_count = 0;
        assert_eq!(derive_batch_status(&task), "failed");
        task.status = "cancelled".into();
        assert_eq!(derive_batch_status(&task), "cancelled");
    }

    #[test]
    fn slot_status_maps_pending_to_queued() {
        assert_eq!(slot_status("pending"), "queued");
        assert_eq!(slot_status("running"), "running");
        assert_eq!(slot_status("completed"), "completed");
        assert_eq!(slot_status("failed"), "failed");
        assert_eq!(slot_status("cancelled"), "cancelled");
    }

    #[test]
    fn find_pose_batch_by_batch_id_or_request_id() {
        let task = build_pose_batch_task(&plan_pose_batch(&fixture_request(), &settings()).unwrap(), "out".into());
        let tasks = vec![task];
        assert!(find_pose_batch_task(&tasks, "pose-batch-001", "").is_some());
        assert!(find_pose_batch_task(&tasks, "", "video-pose-request-001").is_some());
        assert!(find_pose_batch_task(&tasks, "other", "").is_none());
        // 幂等查找也命中（同 requestId 复用）
        assert!(find_pose_batch_task(&tasks, "pose-batch-001", "video-pose-request-001").is_some());
    }

    #[test]
    fn slot_id_mapping_validates_membership() {
        let plan = plan_pose_batch(&fixture_request(), &settings()).unwrap();
        let task = build_pose_batch_task(&plan, "out".into());
        let pb = task.pose_batch.unwrap();
        assert_eq!(
            map_slot_ids_to_indexes(&pb, &["side_middle".to_string()]).unwrap(),
            vec![3]
        );
        assert_eq!(map_slot_ids_to_indexes(&pb, &[]).unwrap(), Vec::<usize>::new());
        assert!(map_slot_ids_to_indexes(&pb, &["nope".to_string()]).is_err());
    }

    #[test]
    fn master_reference_eligibility() {
        let plan = plan_pose_batch(&fixture_request(), &settings()).unwrap();
        let task = build_pose_batch_task(&plan, "out".into());
        let mut pb = task.pose_batch.unwrap();
        // master 未产生：首槽走 Generations
        assert!(!slot_should_use_master_reference(&pb, 1));
        pb.consistency_strategy = "master_reference".into();
        assert!(!slot_should_use_master_reference(&pb, 1));
        pb.master_image_id = Some("img-1".into());
        pb.master_slot_index = Some(0);
        // master 槽自身与后续槽位判定
        assert!(!slot_should_use_master_reference(&pb, 0));
        assert!(slot_should_use_master_reference(&pb, 1));
        // 非该策略不受影响
        pb.consistency_strategy = "prompt_only".into();
        assert!(!slot_should_use_master_reference(&pb, 1));
    }

    #[test]
    fn pose_batch_serializes_snake_case_and_old_json_roundtrips() {
        let task = build_pose_batch_task(&plan_pose_batch(&fixture_request(), &settings()).unwrap(), "out".into());
        let json = serde_json::to_value(&task).unwrap();
        // Task JSON 契约 = snake_case（与既有 source_app/source_request_id 同风格，TS 侧直接消费）
        assert_eq!(json["pose_batch"]["batch_id"], "pose-batch-001");
        assert_eq!(json["pose_batch"]["preset_version"], "ACTION_MANNEQUIN_V1");
        assert_eq!(json["pose_batch"]["slots"][3]["slot_id"], "side_middle");
        assert_eq!(json["pose_batch"]["slots"][3]["sub_index"], 3);

        // 旧数据兼容：不含 pose_batch 的历史 tasks.json 必须照常反序列化（serde default None）
        let mut legacy = serde_json::to_value(&task).unwrap();
        let obj = legacy.as_object_mut().unwrap();
        obj.remove("pose_batch");
        let restored: Task = serde_json::from_value(legacy).unwrap();
        assert!(restored.pose_batch.is_none());
        assert_eq!(restored.id, task.id);
    }
}
