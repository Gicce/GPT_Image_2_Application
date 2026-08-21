use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub token: String,
    pub default_size: String,
    pub default_quality: String,
    pub default_format: String,
    pub default_output_dir: String,
    #[serde(default)]
    pub library_input_dir: String,
    #[serde(default = "default_agent_name")]
    pub agent_name: String,
    #[serde(default)]
    pub agent_token: String,
    #[serde(default)]
    pub agent_model: String,
    #[serde(default)]
    pub agent_base_url: String,
    #[serde(default)]
    pub agent_system_prompt: String,
    #[serde(default = "default_context_window")]
    pub agent_context_window: usize,
    #[serde(default)]
    pub ai_avatar_data_url: String,
    #[serde(default)]
    pub user_avatar_data_url: String,
    #[serde(default)]
    pub removebg_api_key: String,
    #[serde(default)]
    pub upscale_provider: String,
    #[serde(default)]
    pub topaz_api_key: String,
    #[serde(default)]
    pub vision_model: String,
    #[serde(default)]
    pub chat_token: String,
    #[serde(default)]
    pub chat_model: String,
    #[serde(default)]
    pub chat_base_url: String,
    #[serde(default)]
    pub chat_system_prompt: String,
    #[serde(default)]
    pub server_url: String,
    #[serde(default = "default_true")]
    pub notice_enabled: bool,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub device_id: String,
    /// 用户手动选择并保存的 CY Video Studio 可执行文件路径（同步素材用；空 = 未配置）
    #[serde(default)]
    pub video_studio_executable: String,
}

fn default_true() -> bool {
    true
}
fn default_context_window() -> usize {
    32768
}
fn default_theme() -> String {
    "system".to_string()
}
fn default_agent_name() -> String {
    "CyImage Agent".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            token: String::new(),
            default_size: "1024x1024".to_string(),
            default_quality: "auto".to_string(),
            default_format: "png".to_string(),
            default_output_dir: String::new(),
            library_input_dir: String::new(),
            agent_name: default_agent_name(),
            agent_token: String::new(),
            agent_model: "gpt-4o".to_string(),
            agent_base_url: "https://www.packyapi.com/v1".to_string(),
            agent_system_prompt: String::new(),
            agent_context_window: default_context_window(),
            ai_avatar_data_url: String::new(),
            user_avatar_data_url: String::new(),
            removebg_api_key: String::new(),
            upscale_provider: "disabled".to_string(),
            topaz_api_key: String::new(),
            vision_model: "gpt-4o".to_string(),
            chat_token: String::new(),
            chat_model: "gpt-4o".to_string(),
            chat_base_url: "https://www.packyapi.com/v1".to_string(),
            chat_system_prompt: String::new(),
            server_url: "http://localhost:4001".to_string(),
            notice_enabled: true,
            theme: default_theme(),
            device_id: String::new(),
            video_studio_executable: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubTask {
    pub index: usize,
    pub status: String,
    pub image_id: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    /// 手动「重新生成」累计次数（旧 tasks.json 缺省 0）
    #[serde(default)]
    pub retry_count: u32,
    /// 历史 attempt 失败原因（最近在后，最多保留 5 条；成功后 error 清空但历史保留）
    #[serde(default)]
    pub attempt_errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TaskBatchItem {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub prompt_delta: String,
    #[serde(default)]
    pub prompt_override: String,
    /// 该子任务独立的负面提示词（需求任务模型：每条需求可有自己的负面词）。
    /// 为空时回落任务级 final_negative_prompt / negative_prompt。
    #[serde(default)]
    pub negative_override: String,
    #[serde(default)]
    pub negative_delta: String,
    #[serde(default)]
    pub source_images: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 方案元数据快照（新版批量方案任务创建时冻结，历史详情只读；旧 tasks.json 缺失时为空）。
    #[serde(default)]
    pub plan_title: String,
    #[serde(default)]
    pub plan_summary: String,
    #[serde(default)]
    pub plan_tags: Vec<String>,
    #[serde(default)]
    pub plan_description: String,
}

/// 单张复合构图布局（一张图内部的分格结构），与 batch 互斥。
/// 字段名与 TS 侧 TaskCompositeLayout 对齐（type / panelCount）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskCompositeLayout {
    #[serde(rename = "type")]
    pub layout_type: String,
    #[serde(rename = "panelCount", alias = "panel_count")]
    pub panel_count: usize,
}

/// 提示词优化结构化快照 —— 任务创建时冻结（provider/model/时间），
/// 历史记录只读这里；旧 tasks.json 没有该字段，serde default 兼容。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PromptOptimizationSnapshot {
    #[serde(default)]
    pub applied: bool,
    #[serde(default)]
    pub provider_name: String,
    #[serde(default)]
    pub model_name: String,
    #[serde(default)]
    pub original_prompt: String,
    #[serde(default)]
    pub optimized_at: String,
    #[serde(default)]
    pub manually_edited_after: bool,
    /// 优化来源标记：vision_recreation = 视觉理解复刻链路（已优化，禁止重复优化）
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub prompt: String,
    pub negative_prompt: String,
    #[serde(default)]
    pub user_prompt_raw: String,
    #[serde(default)]
    pub final_prompt: String,
    #[serde(default)]
    pub final_negative_prompt: String,
    #[serde(default)]
    pub prompt_optimized: bool,
    #[serde(default)]
    pub prompt_optimization: Option<PromptOptimizationSnapshot>,
    #[serde(default)]
    pub agent_intent: String,
    #[serde(default)]
    pub task_source: String,
    pub size: String,
    pub quality: String,
    pub output_format: String,
    pub count: usize,
    pub status: String,
    pub created_at: String,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
    pub output_dir: String,
    pub success_count: usize,
    pub failed_count: usize,
    pub sub_tasks: Vec<SubTask>,
    #[serde(default)]
    pub task_type: String,
    #[serde(default)]
    pub source_images: Vec<String>,
    #[serde(default)]
    pub execution_mode: String,
    #[serde(default)]
    pub batch_strategy: String,
    #[serde(default)]
    pub task_plan_summary: String,
    #[serde(default)]
    pub batch_items: Vec<TaskBatchItem>,
    #[serde(default)]
    pub composite_layout: Option<TaskCompositeLayout>,
    #[serde(default)]
    pub subject_entities: Vec<String>,
    /// 来源任务 id（视觉理解 → 图片生成 的链路关联；普通任务为 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_task_id: Option<String>,
    /// 来源任务类型快照（如 vision_understanding），任务列表免查源即可显示来源
    #[serde(default)]
    pub source_task_kind: String,
    /// 执行中的阶段性中文提示（视觉理解任务等前端驱动任务用；终态后保留最后一条）
    #[serde(default)]
    pub stage_note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageRecord {
    pub id: String,
    pub task_id: String,
    pub local_path: String,
    pub file_name: String,
    pub created_at: String,
    pub status: String,
    #[serde(default)]
    pub source_kind: String,
    #[serde(default)]
    pub missing: bool,
    #[serde(default)]
    pub last_seen_at: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub indexed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    pub reasoning: String,
    #[serde(default)]
    pub reasoning_duration: String,
    #[serde(default)]
    pub generated_image: String,
    pub created_at: String,
    // ====== 结构化任务消息（TaskMessageCard）======
    // 关键修复：以前 Rust 端 ChatMessage 没有 task_message 字段，导致 serde 在
    // save_conversation 时把整个 TaskMessageState 静默丢掉。重新加载后只剩 content 文本，
    // TaskMessageCard 无法渲染。这里以 serde_json::Value 透传整个结构化 payload，
    // 让前端自己负责 schema/version 校验。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_message: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_proposal: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gallery_search: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_image: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatConversation {
    pub id: String,
    pub title: String,
    pub messages: Vec<ChatMessage>,
    pub created_at: String,
    #[serde(default)]
    pub last_prompt_tokens: Option<u32>,
    #[serde(default)]
    pub last_completion_tokens: Option<u32>,
    #[serde(default)]
    pub context_summary: String,
    #[serde(default)]
    pub context_summary_updated_at: String,
    #[serde(default)]
    pub conversation_mode: String,
    #[serde(default)]
    pub active_task_draft: Option<serde_json::Value>,
    // ====== 会话级状态字段透传（同样修复持久化丢失问题）======
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_image_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_image_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateTaskParams {
    pub prompt: String,
    pub negative_prompt: String,
    #[serde(default)]
    pub user_prompt_raw: String,
    #[serde(default)]
    pub final_prompt: String,
    #[serde(default)]
    pub final_negative_prompt: String,
    #[serde(default)]
    pub prompt_optimized: bool,
    #[serde(default)]
    pub prompt_optimization: Option<PromptOptimizationSnapshot>,
    #[serde(default)]
    pub agent_intent: String,
    #[serde(default)]
    pub task_source: String,
    pub size: String,
    pub quality: String,
    pub output_format: String,
    pub count: usize,
    pub output_dir: String,
    #[serde(default)]
    pub task_type: String,
    #[serde(default)]
    pub source_images: Vec<String>,
    #[serde(default)]
    pub execution_mode: String,
    #[serde(default)]
    pub batch_strategy: String,
    #[serde(default)]
    pub task_plan_summary: String,
    #[serde(default)]
    pub batch_items: Vec<TaskBatchItem>,
    #[serde(default)]
    pub composite_layout: Option<TaskCompositeLayout>,
    #[serde(default)]
    pub subject_entities: Vec<String>,
    #[serde(default)]
    pub source_task_id: Option<String>,
    #[serde(default)]
    pub source_task_kind: String,
}

/// 视觉理解任务的阶段性状态更新（前端驱动；task_runner 不参与执行）。
#[derive(Debug, Deserialize)]
pub struct UpdateVisionTaskParams {
    pub task_id: String,
    /// running | completed | failed | cancelled
    pub status: String,
    /// 执行中的阶段性中文提示（如"正在分析参考图片…"）
    #[serde(default)]
    pub stage_note: String,
    /// 任务摘要（完成后写入 task_plan_summary，任务列表展示"已分析参考图：…"）
    #[serde(default)]
    pub plan_summary: String,
    /// 失败原因（status=failed 时写入子任务错误）
    #[serde(default)]
    pub error: String,
}

/// V4.0.6 批量任务重做：应用到全部选中子项的统一参数覆盖。
/// None / 空串 = 继承源任务对应字段。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BatchRedoGlobalOverrides {
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub output_format: Option<String>,
    #[serde(default)]
    pub output_dir: Option<String>,
    /// 追加到每个选中子项生效 Prompt 之前（不覆盖原内容）
    #[serde(default)]
    pub prompt_prefix: Option<String>,
    /// 追加到每个选中子项生效 Prompt 之后
    #[serde(default)]
    pub prompt_suffix: Option<String>,
}

/// 单个子任务级覆盖（优先级最高，index 指向源任务 batch_items 下标）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BatchRedoItemOverride {
    pub index: usize,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    /// Some("") 表示显式清空该子项负面词
    #[serde(default)]
    pub negative_prompt: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CreateBatchRedoRequest {
    pub source_task_id: String,
    pub selected_indexes: Vec<usize>,
    #[serde(default)]
    pub global_overrides: BatchRedoGlobalOverrides,
    #[serde(default)]
    pub item_overrides: Vec<BatchRedoItemOverride>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentTemplateClarificationRules {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub required_fields: Vec<String>,
    #[serde(default)]
    pub fallback_question: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentTemplateOutputSchema {
    #[serde(default = "default_true")]
    pub final_prompt: bool,
    #[serde(default = "default_true")]
    pub final_negative_prompt: bool,
    #[serde(default = "default_true")]
    pub recommended_action: bool,
    #[serde(default = "default_true")]
    pub clarification_question: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTaskTemplate {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_template_priority")]
    pub priority: i32,
    pub category: String,
    pub scene: String,
    pub intent: String,
    #[serde(default = "default_match_mode")]
    pub match_mode: String,
    #[serde(default)]
    pub trigger_keywords: Vec<String>,
    #[serde(default)]
    pub exclude_keywords: Vec<String>,
    #[serde(default)]
    pub requires_source_images: bool,
    #[serde(default)]
    pub min_source_images: i32,
    #[serde(default)]
    pub max_source_images: Option<i32>,
    #[serde(default = "default_true")]
    pub requires_confirmation: bool,
    #[serde(default)]
    pub allow_auto_execute: bool,
    #[serde(default)]
    pub clarification_rules: AgentTemplateClarificationRules,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub prompt_template: String,
    #[serde(default)]
    pub negative_prompt_template: String,
    #[serde(default)]
    pub recommended_action_template: String,
    #[serde(default)]
    pub output_schema: AgentTemplateOutputSchema,
    #[serde(default)]
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
}

impl Default for AgentTaskTemplate {
    fn default() -> Self {
        let now = chrono::Local::now().to_rfc3339();
        Self {
            id: String::new(),
            name: String::new(),
            enabled: true,
            priority: default_template_priority(),
            category: "generate".to_string(),
            scene: "general".to_string(),
            intent: "image_generate".to_string(),
            match_mode: default_match_mode(),
            trigger_keywords: Vec::new(),
            exclude_keywords: Vec::new(),
            requires_source_images: false,
            min_source_images: 0,
            max_source_images: None,
            requires_confirmation: true,
            allow_auto_execute: false,
            clarification_rules: AgentTemplateClarificationRules::default(),
            system_prompt: String::new(),
            prompt_template: String::new(),
            negative_prompt_template: String::new(),
            recommended_action_template: String::new(),
            output_schema: AgentTemplateOutputSchema::default(),
            notes: String::new(),
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStyleTemplate {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_template_priority")]
    pub priority: i32,
    pub style_group: String,
    #[serde(default)]
    pub trigger_keywords: Vec<String>,
    #[serde(default)]
    pub exclude_keywords: Vec<String>,
    #[serde(default)]
    pub style_prompt_fragment: String,
    #[serde(default)]
    pub negative_prompt_fragment: String,
    #[serde(default)]
    pub compatible_intents: Vec<String>,
    #[serde(default)]
    pub compatible_scenes: Vec<String>,
    #[serde(default)]
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
}

impl Default for AgentStyleTemplate {
    fn default() -> Self {
        let now = chrono::Local::now().to_rfc3339();
        Self {
            id: String::new(),
            name: String::new(),
            enabled: true,
            priority: default_template_priority(),
            style_group: "visual_style".to_string(),
            trigger_keywords: Vec::new(),
            exclude_keywords: Vec::new(),
            style_prompt_fragment: String::new(),
            negative_prompt_fragment: String::new(),
            compatible_intents: vec!["image_generate".to_string(), "image_edit".to_string()],
            compatible_scenes: Vec::new(),
            notes: String::new(),
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentTemplateLog {
    pub id: String,
    #[serde(default)]
    pub conversation_id: String,
    #[serde(default)]
    pub message_id: String,
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub matched_task_template_id: String,
    #[serde(default)]
    pub matched_style_template_ids: Vec<String>,
    #[serde(default)]
    pub user_prompt_raw: String,
    #[serde(default)]
    pub final_prompt: String,
    #[serde(default)]
    pub final_negative_prompt: String,
    #[serde(default)]
    pub recommended_action: String,
    #[serde(default)]
    pub intent: String,
    #[serde(default)]
    pub api_kind: String,
    #[serde(default)]
    pub confidence: f64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentTemplateExportPayload {
    #[serde(default = "default_template_version")]
    pub version: u32,
    #[serde(default)]
    pub task_templates: Vec<AgentTaskTemplate>,
    #[serde(default)]
    pub style_templates: Vec<AgentStyleTemplate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentTemplateDraftCurrentTemplate {
    pub id: String,
    pub name: String,
    pub category: String,
    pub scene: String,
    pub intent: String,
    #[serde(default)]
    pub trigger_keywords: Vec<String>,
    #[serde(default)]
    pub requires_source_images: bool,
    #[serde(default = "default_true")]
    pub requires_confirmation: bool,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub prompt_template: String,
    #[serde(default)]
    pub negative_prompt_template: String,
    #[serde(default)]
    pub recommended_action_template: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentTemplateDraftRequirements {
    #[serde(default)]
    pub target_use_cases: Vec<String>,
    #[serde(default)]
    pub must_keep: Vec<String>,
    #[serde(default)]
    pub should_improve: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentTemplateDraftExpectedOutput {
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub prompt_template: String,
    #[serde(default)]
    pub negative_prompt_template: String,
    #[serde(default)]
    pub recommended_action_template: String,
    #[serde(default)]
    pub extra_trigger_keywords: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentTemplateDraftPayload {
    pub template_type: String,
    #[serde(default = "default_draft_mode")]
    pub draft_mode: String,
    pub goal: String,
    pub current_template: AgentTemplateDraftCurrentTemplate,
    pub requirements: AgentTemplateDraftRequirements,
    pub expected_output: AgentTemplateDraftExpectedOutput,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentTemplateImportPayload {
    #[serde(default = "default_template_version")]
    pub version: u32,
    #[serde(default)]
    pub task_templates: Vec<AgentTaskTemplate>,
    #[serde(default)]
    pub style_templates: Vec<AgentStyleTemplate>,
}

fn default_template_priority() -> i32 {
    100
}
fn default_match_mode() -> String {
    "hybrid".to_string()
}
fn default_template_version() -> u32 {
    1
}
fn default_draft_mode() -> String {
    "agent_editable".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RuntimeAuthConfig {
    #[serde(default)]
    pub image_token: String,
    #[serde(default)]
    pub image_base_url: String,
    #[serde(default)]
    pub agent_token: String,
    #[serde(default)]
    pub agent_base_url: String,
    #[serde(default)]
    pub postprocess_token: String,
    #[serde(default)]
    pub postprocess_base_url: String,
}
