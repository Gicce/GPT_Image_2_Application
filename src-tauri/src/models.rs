use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub token: String,
    pub default_size: String,
    pub default_quality: String,
    pub default_format: String,
    pub default_output_dir: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            token: String::new(),
            default_size: "1024x1024".to_string(),
            default_quality: "auto".to_string(),
            default_format: "png".to_string(),
            default_output_dir: String::new(),
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

#[derive(Debug, Deserialize)]
pub struct CreateTaskParams {
    pub prompt: String,
    pub negative_prompt: String,
    pub size: String,
    pub quality: String,
    pub output_format: String,
    pub count: usize,
    pub output_dir: String,
}
