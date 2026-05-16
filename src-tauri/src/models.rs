use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub token: String,
    pub default_size: String,
    pub default_quality: String,
    pub default_format: String,
    pub default_output_dir: String,
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
}

fn default_true() -> bool { true }

impl Default for Settings {
    fn default() -> Self {
        Settings {
            token: String::new(),
            default_size: "1024x1024".to_string(),
            default_quality: "auto".to_string(),
            default_format: "png".to_string(),
            default_output_dir: String::new(),
            chat_token: String::new(),
            chat_model: "gpt-4o".to_string(),
            chat_base_url: "https://www.packyapi.com/v1".to_string(),
            chat_system_prompt: String::new(),
            server_url: String::new(),
            notice_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubTask {
    pub index: usize,
    pub status: String,
    pub image_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub prompt: String,
    pub negative_prompt: String,
    pub size: String,
    pub quality: String,
    pub output_format: String,
    pub count: usize,
    pub status: String,
    pub created_at: String,
    pub output_dir: String,
    pub success_count: usize,
    pub failed_count: usize,
    pub sub_tasks: Vec<SubTask>,
    #[serde(default)]
    pub task_type: String,
    #[serde(default)]
    pub source_images: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageRecord {
    pub id: String,
    pub task_id: String,
    pub local_path: String,
    pub file_name: String,
    pub created_at: String,
    pub status: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatConversation {
    pub id: String,
    pub title: String,
    pub messages: Vec<ChatMessage>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateTaskParams {
    pub prompt: String,
    pub negative_prompt: String,
    pub size: String,
    pub quality: String,
    pub output_format: String,
    pub count: usize,
    pub output_dir: String,
    #[serde(default)]
    pub task_type: String,
    #[serde(default)]
    pub source_images: Vec<String>,
}
