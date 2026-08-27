//! Explicit, user-triggered structured logo analysis for Skill Workshop.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use crate::vision::{call_vision_model, encode_image_data_url};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandAnalysisRequest {
    pub image_path: String,
    pub base_url: String,
    pub token: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandAnalysisResponse {
    pub analysis: Value,
    pub model: String,
}

#[tauri::command]
pub fn fingerprint_skill_asset(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("无法读取素材：{e}"))?;
    let mut digest = Sha256::new();
    digest.update(&bytes);
    Ok(format!("{:x}", digest.finalize()))
}

fn extract_json(text: &str) -> Result<Value, String> {
    let trimmed = text.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) { return Ok(value); }
    let start = trimmed.find('{').ok_or("Logo 分析未返回 JSON 对象")?;
    let end = trimmed.rfind('}').ok_or("Logo 分析返回的 JSON 不完整")?;
    serde_json::from_str(&trimmed[start..=end]).map_err(|e| format!("Logo 分析 JSON 无法解析：{e}"))
}

#[tauri::command]
pub async fn analyze_brand_logo(request: BrandAnalysisRequest) -> Result<BrandAnalysisResponse, String> {
    let image = encode_image_data_url(&request.image_path)?;
    let system = r#"你是品牌资产规范分析师。仅分析图中可见内容，未知项写 unknown；严格只输出 JSON。不得把推断写成用户确认规则。"#;
    let prompt = r#"分析这份 Logo 原图并输出：
{"structure":"图形结构","visible_text":"可见文字","aspect_ratio":"宽高比例描述","colors":["色值或颜色"],"background_compatibility":["适配背景"],"safe_area":"建议安全区","prohibited_transformations":["禁止拉伸","禁止改色"],"confidence":0.0,"uncertainties":["不确定项"]}
confidence 必须是 0 到 1 的数字。"#;
    let text = call_vision_model(&request.base_url, &request.token, &request.model, system, prompt, &[image], 1200)
        .await.map_err(|e| e.message)?;
    let analysis = extract_json(&text)?;
    Ok(BrandAnalysisResponse { analysis, model: request.model })
}
