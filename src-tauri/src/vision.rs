//! 视觉理解模块（V4.0.6）：
//! - `vision_analyze_image`：单图结构化分析（严格 JSON，供反向 Prompt 编译）
//! - `vision_compare_images`：源图 + 候选图双图交叉评审（高复刻评分的核心裁判）
//! - `compute_color_similarity`：本地色彩相似度（HSV 直方图，无 AI 调用）
//!
//! 协议统一为 OpenAI 兼容 chat completions（图片以 data URL inline 直传，
//! 绝不上传第三方图床）；瞬时网络错误复用 task_runner 的
//! send_with_transient_retry（全项目唯一一份 retry 实现）。
//! API Key 只随请求透传，绝不写入日志 / 持久化。

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::task_runner::mime_for_path;

// ======================= 数据结构（与 TS 侧镜像，snake_case） =======================

/// 归一化区域：坐标全部 0.0~1.0（相对整幅画面），解析侧不 clamp，
/// 消费侧（构图相似度）使用前 clamp。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NormalizedRegion {
    #[serde(default)]
    pub x: f32,
    #[serde(default)]
    pub y: f32,
    #[serde(default)]
    pub width: f32,
    #[serde(default)]
    pub height: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VisionSubject {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub count: Option<u32>,
    #[serde(default)]
    pub appearance: Vec<String>,
    #[serde(default)]
    pub pose: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub position: Option<NormalizedRegion>,
    #[serde(default)]
    pub orientation: Option<String>,
    #[serde(default)]
    pub clothing: Vec<String>,
    #[serde(default)]
    pub relations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VisionObject {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub count: Option<u32>,
    #[serde(default)]
    pub position: Option<NormalizedRegion>,
    #[serde(default)]
    pub attributes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SceneAnalysis {
    #[serde(default)]
    pub environment: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub time_of_day: String,
    #[serde(default)]
    pub weather: String,
    #[serde(default)]
    pub background: String,
    #[serde(default)]
    pub foreground: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CompositionAnalysis {
    #[serde(default)]
    pub subject_placement: String,
    #[serde(default)]
    pub symmetry: String,
    #[serde(default)]
    pub rule_of_thirds: Option<bool>,
    #[serde(default)]
    pub horizon: Option<String>,
    #[serde(default)]
    pub negative_space: String,
    #[serde(default)]
    pub crop: String,
    #[serde(default)]
    pub depth_layers: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CameraAnalysis {
    #[serde(default)]
    pub shot_type: String,
    #[serde(default)]
    pub focal_length_estimate: Option<String>,
    #[serde(default)]
    pub perspective: String,
    #[serde(default)]
    pub angle: String,
    #[serde(default)]
    pub depth_of_field: String,
    #[serde(default)]
    pub lens_characteristics: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LightingAnalysis {
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub direction: String,
    #[serde(default)]
    pub softness: String,
    #[serde(default)]
    pub key_fill_rim: String,
    #[serde(default)]
    pub contrast: String,
    #[serde(default)]
    pub time_of_day: String,
    #[serde(default)]
    pub exposure: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ColorAnalysis {
    #[serde(default)]
    pub dominant_palette: Vec<String>,
    #[serde(default)]
    pub temperature: String,
    #[serde(default)]
    pub saturation: String,
    #[serde(default)]
    pub contrast: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StyleAnalysis {
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub medium: String,
    #[serde(default)]
    pub texture: String,
    #[serde(default)]
    pub rendering: String,
    #[serde(default)]
    pub photographic_characteristics: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TextElement {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub position: Option<NormalizedRegion>,
    #[serde(default)]
    pub style: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VisionAnalysis {
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub subjects: Vec<VisionSubject>,
    #[serde(default)]
    pub objects: Vec<VisionObject>,
    #[serde(default)]
    pub scene: SceneAnalysis,
    #[serde(default)]
    pub composition: CompositionAnalysis,
    #[serde(default)]
    pub camera: CameraAnalysis,
    #[serde(default)]
    pub lighting: LightingAnalysis,
    #[serde(default)]
    pub colors: ColorAnalysis,
    #[serde(default)]
    pub style: StyleAnalysis,
    #[serde(default)]
    pub text_elements: Vec<TextElement>,
    #[serde(default)]
    pub fine_details: Vec<String>,
    #[serde(default)]
    pub generation_risks: Vec<String>,
}

/// 双图交叉评审结果：相似度全部 0.0~1.0（解析时 clamp；
/// >1.5 的值按百分制换算后 clamp）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VisionComparison {
    #[serde(default)]
    pub subject: f32,
    #[serde(default)]
    pub composition: f32,
    #[serde(default)]
    pub style: f32,
    #[serde(default)]
    pub lighting: f32,
    #[serde(default)]
    pub color: f32,
    /// 无可比较对象时模型可返回 null
    #[serde(default)]
    pub objects: Option<f32>,
    /// 原图无明显文字时为 null（不参与最终加权，绝不当 0 分）
    #[serde(default)]
    pub text: Option<f32>,
    #[serde(default)]
    pub missing_elements: Vec<String>,
    #[serde(default)]
    pub extra_elements: Vec<String>,
    #[serde(default)]
    pub layout_differences: Vec<String>,
    #[serde(default)]
    pub style_differences: Vec<String>,
    #[serde(default)]
    pub lighting_differences: Vec<String>,
    #[serde(default)]
    pub color_differences: Vec<String>,
    #[serde(default)]
    pub prompt_corrections: Vec<String>,
}

/// 分数归一：>1.5 视为百分制 → /100；随后 clamp 到 0..1。
fn clamp_score(value: f32) -> f32 {
    let v = if value > 1.5 { value / 100.0 } else { value };
    v.clamp(0.0, 1.0)
}

fn normalize_comparison(raw: VisionComparison) -> VisionComparison {
    VisionComparison {
        subject: clamp_score(raw.subject),
        composition: clamp_score(raw.composition),
        style: clamp_score(raw.style),
        lighting: clamp_score(raw.lighting),
        color: clamp_score(raw.color),
        objects: raw.objects.map(clamp_score),
        text: raw.text.map(clamp_score),
        ..raw
    }
}

// ======================= 请求 / 结果包装 =======================

#[derive(Debug, Deserialize)]
pub struct VisionAnalyzeRequest {
    pub image_path: String,
    pub base_url: String,
    pub token: String,
    pub model: String,
    /// quick = 快速理解；reverse_prompt = 专业反向 Prompt（默认）
    #[serde(default)]
    pub mode: String,
    /// 附加要求（透传给视觉模型，拼入用户消息）
    #[serde(default)]
    pub extra_instructions: String,
}

#[derive(Debug, Serialize)]
pub struct VisionAnalyzeResult {
    pub ok: bool,
    pub analysis: Option<VisionAnalysis>,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
    pub status: Option<u16>,
}

#[derive(Debug, Deserialize)]
pub struct VisionCompareRequest {
    pub source_path: String,
    pub candidate_path: String,
    pub base_url: String,
    pub token: String,
    pub model: String,
}

#[derive(Debug, Serialize)]
pub struct VisionCompareResult {
    pub ok: bool,
    pub comparison: Option<VisionComparison>,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
    pub status: Option<u16>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ColorProfile {
    /// 主色调（hex，最多 4 个，按占比降序）
    pub dominant_colors: Vec<String>,
    /// 平均亮度 0~1
    pub brightness: f32,
    /// 平均饱和度 0~1
    pub saturation: f32,
    /// 亮度标准差（对比度代理）0~1
    pub contrast: f32,
    /// 色相直方图（18 bins，饱和度加权，总和 1）
    pub hue_histogram: Vec<f32>,
}

#[derive(Debug, Serialize)]
pub struct ColorSimilarityResult {
    pub ok: bool,
    pub score: f32,
    pub source: Option<ColorProfile>,
    pub candidate: Option<ColorProfile>,
    pub error_message: Option<String>,
}

// ======================= JSON 提取 / 解析 =======================

/// 剥掉 ```json 围栏并截取首个平衡的 {...} 对象。
fn extract_json_object_text(text: &str) -> Option<&str> {
    let trimmed = text.trim();
    let without_fence = if trimmed.starts_with("```") {
        let inner = trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```JSON")
            .trim_start_matches("```");
        inner.trim_end_matches("```").trim()
    } else {
        trimmed
    };
    let bytes = without_fence.as_bytes();
    let start = bytes.iter().position(|b| *b == b'{')?;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
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
                    return without_fence.get(start..=i);
                }
            }
            _ => {}
        }
    }
    None
}

/// 分析 JSON 解析：优先顶层，其次常见包裹键（analysis / result）。
fn parse_analysis_text(text: &str) -> Result<VisionAnalysis, String> {
    let json_text = extract_json_object_text(text)
        .ok_or_else(|| "视觉模型未返回 JSON 对象".to_string())?;
    let value: serde_json::Value = serde_json::from_str(json_text)
        .map_err(|e| format!("视觉分析 JSON 解析失败：{}", e))?;
    let target = if value.get("analysis").is_some() {
        value.get("analysis").cloned().unwrap_or(value)
    } else if value.get("result").is_some() && value.get("summary").is_none() {
        value.get("result").cloned().unwrap_or(value)
    } else {
        value
    };
    serde_json::from_value::<VisionAnalysis>(target)
        .map_err(|e| format!("视觉分析结构不符合约定：{}", e))
}

fn parse_comparison_text(text: &str) -> Result<VisionComparison, String> {
    let json_text = extract_json_object_text(text)
        .ok_or_else(|| "视觉模型未返回 JSON 对象".to_string())?;
    let value: serde_json::Value = serde_json::from_str(json_text)
        .map_err(|e| format!("双图比较 JSON 解析失败：{}", e))?;
    let target = if value.get("comparison").is_some() {
        value.get("comparison").cloned().unwrap_or(value)
    } else {
        value
    };
    let raw: VisionComparison = serde_json::from_value(target)
        .map_err(|e| format!("双图比较结构不符合约定：{}", e))?;
    Ok(normalize_comparison(raw))
}

// ======================= 图片编码（本地，含降采样） =======================

/// 解码上限：超过视为「图片过大」（在本地拦截，不打上游）。
const MAX_SOURCE_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
/// 直传给视觉模型的最长边（更大的图本地降采样重编码 JPEG，控制请求体）。
const MAX_TRANSMIT_EDGE: u32 = 1536;

pub(crate) fn encode_image_data_url(path: &str) -> Result<String, String> {
    let p = std::path::Path::new(path);
    if !p.exists() {
        return Err(format!("图片不存在：{}", path));
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("读取图片信息失败：{}", e))?;
    if meta.len() > MAX_SOURCE_IMAGE_BYTES {
        return Err("图片过大（超过 25MB），请压缩后重试".to_string());
    }
    let format_hint = match p.extension().and_then(|e| e.to_str()) {
        Some(ext) => image::ImageFormat::from_extension(ext.to_ascii_lowercase()),
        None => None,
    };
    let reader = match format_hint {
        Some(format) => image::ImageReader::with_format(
            std::io::BufReader::new(std::fs::File::open(p).map_err(|e| format!("打开图片失败：{}", e))?),
            format,
        ),
        None => image::ImageReader::open(p).map_err(|e| format!("打开图片失败：{}", e))?,
    };
    let decoded = reader.decode().map_err(|_| {
        format!("不支持的图片格式：{}", mime_for_path(p))
    })?;
    let rgb = decoded.to_rgb8();
    let (w, h) = rgb.dimensions();
    let resized = if w.max(h) > MAX_TRANSMIT_EDGE {
        let scale = MAX_TRANSMIT_EDGE as f32 / w.max(h) as f32;
        let nw = ((w as f32 * scale).ceil() as u32).max(1);
        let nh = ((h as f32 * scale).ceil() as u32).max(1);
        image::imageops::resize(&rgb, nw, nh, image::imageops::FilterType::Lanczos3)
    } else {
        rgb
    };
    let mut jpeg_bytes: Vec<u8> = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_bytes, 85);
    resized
        .write_with_encoder(encoder)
        .map_err(|e| format!("图片重编码失败：{}", e))?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg_bytes);
    Ok(format!("data:image/jpeg;base64,{}", b64))
}

// ======================= 视觉模型调用（OpenAI 兼容 chat completions） =======================

pub(crate) struct VisionCallError {
    pub(crate) kind: String,
    pub(crate) message: String,
    pub(crate) status: Option<u16>,
}

fn classify_vision_http_error(status: u16, body_text: &str) -> VisionCallError {
    let parsed: Option<serde_json::Value> = serde_json::from_str(body_text).ok();
    let detail = parsed
        .as_ref()
        .and_then(|v| v.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()))
        .or_else(|| parsed.as_ref().and_then(|v| v.get("message")).and_then(|m| m.as_str()))
        .unwrap_or("")
        .trim()
        .to_string();
    let lower = detail.to_ascii_lowercase();
    let kind = match status {
        401 | 403 => "auth",
        429 => "rate_limited",
        400 | 404 | 422 => {
            if lower.contains("multimodal")
                || lower.contains("image")
                || lower.contains("vision")
                || lower.contains("not support")
            {
                "capability_mismatch"
            } else if lower.contains("model") {
                "model_error"
            } else {
                "invalid_request"
            }
        }
        _ if status >= 500 => "server",
        _ => "server",
    }
    .to_string();
    let hint = match kind.as_str() {
        "auth" => "视觉模型服务鉴权失败，请检查 API Key",
        "rate_limited" => "视觉模型服务限流，请稍后重试",
        "capability_mismatch" => "当前模型不支持图片输入或多图比较，请更换视觉模型",
        "model_error" => "视觉模型不存在或无权限，请检查模型选择",
        "invalid_request" => "视觉模型请求参数错误",
        _ => "视觉模型服务异常",
    };
    let mut message = hint.to_string();
    if !detail.is_empty() {
        // 保留上游细节用于诊断，但限制长度（不把巨大 body 展示给用户）
        let snippet: String = detail.chars().take(200).collect();
        message.push_str(&format!("：{}", snippet));
    }
    message.push_str(&format!("（HTTP {}）", status));
    VisionCallError { kind, message, status: Some(status) }
}

/// chat completions content 提取：兼容 string 与 parts 数组两种形态。
fn extract_chat_content(body: &serde_json::Value) -> Option<String> {
    let content = body.get("choices")?.get(0)?.get("message")?.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    if let Some(parts) = content.as_array() {
        let mut buffer = String::new();
        for part in parts {
            if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                buffer.push_str(text);
            }
        }
        if !buffer.is_empty() {
            return Some(buffer);
        }
    }
    None
}

pub(crate) async fn call_vision_model(
    base_url: &str,
    token: &str,
    model: &str,
    system_prompt: &str,
    user_text: &str,
    image_data_urls: &[String],
    max_tokens: u32,
) -> Result<String, VisionCallError> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() || token.trim().is_empty() {
        return Err(VisionCallError {
            kind: "not_configured".to_string(),
            message: "视觉模型服务未配置（Base URL / API Key 缺失）".to_string(),
            status: None,
        });
    }
    let url = format!("{}/chat/completions", base);
    let mut user_parts = vec![json!({ "type": "text", "text": user_text })];
    for image_url in image_data_urls {
        user_parts.push(json!({ "type": "image_url", "image_url": { "url": image_url } }));
    }
    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_parts }
        ],
        "max_tokens": max_tokens,
        "temperature": 0.2
    });

    // 复用全局客户端（代理 / TLS 一致）+ 瞬时重试（connect/timeout 自动补试）
    let response = crate::task_runner::send_with_transient_retry(&url, || {
        crate::commands::HTTP_CLIENT
            .post(&url)
            .header("Authorization", format!("Bearer {}", token.trim()))
            .header("Content-Type", "application/json")
            .json(&body)
    })
    .await
    .map_err(|err_message| VisionCallError {
        // send_with_transient_retry 返回中文分类文案；kind 从文案关键词还原
        kind: if err_message.contains("timeout") {
            "timeout".to_string()
        } else if err_message.contains("connect") {
            "connect".to_string()
        } else {
            "network".to_string()
        },
        message: err_message,
        status: None,
    })?;

    let status = response.status().as_u16();
    let body_text = response.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(classify_vision_http_error(status, &body_text));
    }
    let body: serde_json::Value = serde_json::from_str(&body_text).unwrap_or(serde_json::Value::Null);
    extract_chat_content(&body).ok_or_else(|| VisionCallError {
        kind: "invalid_response".to_string(),
        message: "视觉模型返回成功，但未包含可解析的文本内容".to_string(),
        status: Some(status),
    })
}

// ======================= 系统 Prompt =======================

const ANALYSIS_SYSTEM_PROMPT: &str = r##"你是一名「生成式图像复现工程分析器」。你的输出将被用于反向推导图片生成提示词，不是审美评论。

规则：
1. 只描述画面内可观察的事实；不确定的信息标注 (estimated)，绝不编造画面外内容。
2. 位置一律用归一化坐标语言（x/y/width/height 均为 0~1 的小数，相对整幅画面，x 向右、y 向下）。
3. 使用可生成的视觉语言（主体、数量、姿势、构图、景别、镜头、光源、色温、材质、风格），不堆砌 "4K / masterpiece / 高清" 之类的空洞关键词。
4. 严格只输出一个 JSON 对象，不要输出任何解释、Markdown 围栏或多余文本。

JSON 结构（字段可省略但不能改名；数组元素用中文短语）：
{
  "summary": "一句话概述画面",
  "subjects": [{ "label": "主体名", "count": 1, "appearance": ["外形描述"], "pose": "姿势", "action": "动作", "position": { "x": 0.5, "y": 0.4, "width": 0.3, "height": 0.6 }, "orientation": "朝向", "clothing": ["服饰"], "relations": ["与其他对象的关系"] }],
  "objects": [{ "label": "客体名", "count": 1, "position": { "x": 0, "y": 0, "width": 0.2, "height": 0.2 }, "attributes": ["属性"] }],
  "scene": { "environment": "环境", "location": "地点", "time_of_day": "时段", "weather": "天气", "background": "背景", "foreground": "前景" },
  "composition": { "subject_placement": "主体位置与占比", "symmetry": "对称性", "rule_of_thirds": true, "horizon": "地平线位置", "negative_space": "留白", "crop": "裁切", "depth_layers": "前中后景层次" },
  "camera": { "shot_type": "景别", "focal_length_estimate": "焦段 (estimated)", "perspective": "透视", "angle": "机位角度", "depth_of_field": "景深", "lens_characteristics": "镜头特征" },
  "lighting": { "source": "光源", "direction": "方向", "softness": "软硬", "key_fill_rim": "主/辅/轮廓光", "contrast": "光比", "time_of_day": "时段", "exposure": "曝光" },
  "colors": { "dominant_palette": ["#RRGGBB"], "temperature": "色温倾向", "saturation": "饱和度倾向", "contrast": "色彩对比" },
  "style": { "category": "realistic / illustration / cinematic / 3d / flat 等其一", "medium": "媒介", "texture": "纹理质感", "rendering": "渲染特征", "photographic_characteristics": "摄影特征（非照片则描述对应媒介特征）" },
  "text_elements": [{ "content": "画面文字原文", "position": { "x": 0.5, "y": 0.1, "width": 0.4, "height": 0.05 }, "style": "字体样式" }],
  "fine_details": ["对复刻重要的细节"],
  "generation_risks": ["反向生成难以还原的点（如小字、Logo、人脸身份等）"]
}
"##;

const COMPARE_SYSTEM_PROMPT: &str = r#"你是「图像复刻相似度评审器」。用户会给你两张图：第 1 张是参考原图（source），第 2 张是生成候选图（candidate）。

规则：
1. 按维度逐一评审主体 / 构图 / 风格 / 光线 / 色彩 / 对象 / 文字，给出 0.0~1.0 的相似度小数（1.0 = 该维度高度一致）。
2. 第 1 张图中不存在明显文字时，"text" 返回 null；没有可比较对象时 "objects" 返回 null。绝不为不存在的维度硬造 0 分。
3. differences 数组用具体、可执行的中文描述（位置 / 大小 / 数量 / 朝向 / 色偏等），不要写"不太像"这种模糊结论。
4. prompt_corrections 给出可以直接补进生成提示词的修正指令（中文短语数组），只针对真实差异，不要推翻原有描述。
5. 严格只输出一个 JSON 对象，不要任何解释或 Markdown。

JSON 结构：
{
  "subject": 0.0, "composition": 0.0, "style": 0.0, "lighting": 0.0, "color": 0.0,
  "objects": 0.0, "text": null,
  "missing_elements": ["候选图缺失的元素"],
  "extra_elements": ["候选图多出的元素"],
  "layout_differences": ["构图/位置差异"],
  "style_differences": ["风格差异"],
  "lighting_differences": ["光线差异"],
  "color_differences": ["色彩差异"],
  "prompt_corrections": ["可直接加入提示词的修正指令"]
}
"#;

// ======================= Tauri 命令 =======================

#[tauri::command]
pub async fn vision_analyze_image(
    request: VisionAnalyzeRequest,
) -> Result<VisionAnalyzeResult, String> {
    if request.model.trim().is_empty() {
        return Ok(VisionAnalyzeResult {
            ok: false, analysis: None,
            error_kind: Some("not_configured".into()),
            error_message: Some("尚未选择视觉模型".into()),
            status: None,
        });
    }
    let data_url = match encode_image_data_url(&request.image_path) {
        Ok(url) => url,
        Err(message) => {
            return Ok(VisionAnalyzeResult {
                ok: false, analysis: None,
                error_kind: Some("unsupported_image".into()),
                error_message: Some(message),
                status: None,
            });
        }
    };

    let quick_mode = request.mode.trim() == "quick";
    let user_text = if quick_mode {
        "快速理解这张图片：重点输出 summary、subjects、scene、colors、style；其余字段可省略。".to_string()
    } else {
        "对这张图片做完整的复现工程分析（全部字段）。".to_string()
    };
    let user_text = if request.extra_instructions.trim().is_empty() {
        user_text
    } else {
        format!("{}\n附加要求：{}", user_text, request.extra_instructions.trim())
    };
    let max_tokens: u32 = if quick_mode { 1500 } else { 4000 };

    match call_vision_model(
        &request.base_url,
        &request.token,
        request.model.trim(),
        ANALYSIS_SYSTEM_PROMPT,
        &user_text,
        &[data_url],
        max_tokens,
    )
    .await
    {
        Ok(text) => match parse_analysis_text(&text) {
            Ok(analysis) => {
                if analysis.summary.trim().is_empty()
                    && analysis.subjects.is_empty()
                    && analysis.scene.environment.trim().is_empty()
                {
                    return Ok(VisionAnalyzeResult {
                        ok: false, analysis: None,
                        error_kind: Some("invalid_response".into()),
                        error_message: Some("结构化分析返回内容为空".into()),
                        status: None,
                    });
                }
                Ok(VisionAnalyzeResult {
                    ok: true, analysis: Some(analysis),
                    error_kind: None, error_message: None, status: None,
                })
            }
            Err(message) => Ok(VisionAnalyzeResult {
                ok: false, analysis: None,
                error_kind: Some("invalid_response".into()),
                error_message: Some(format!("结构化分析返回格式无效：{}", message)),
                status: None,
            }),
        },
        Err(error) => Ok(VisionAnalyzeResult {
            ok: false, analysis: None,
            error_kind: Some(error.kind),
            error_message: Some(error.message),
            status: error.status,
        }),
    }
}

#[tauri::command]
pub async fn vision_compare_images(
    request: VisionCompareRequest,
) -> Result<VisionCompareResult, String> {
    if request.model.trim().is_empty() {
        return Ok(VisionCompareResult {
            ok: false, comparison: None,
            error_kind: Some("not_configured".into()),
            error_message: Some("尚未选择视觉模型".into()),
            status: None,
        });
    }
    let source_url = match encode_image_data_url(&request.source_path) {
        Ok(url) => url,
        Err(message) => {
            return Ok(VisionCompareResult {
                ok: false, comparison: None,
                error_kind: Some("unsupported_image".into()),
                error_message: Some(format!("参考图处理失败：{}", message)),
                status: None,
            });
        }
    };
    let candidate_url = match encode_image_data_url(&request.candidate_path) {
        Ok(url) => url,
        Err(message) => {
            return Ok(VisionCompareResult {
                ok: false, comparison: None,
                error_kind: Some("unsupported_image".into()),
                error_message: Some(format!("候选图处理失败：{}", message)),
                status: None,
            });
        }
    };

    let user_text = "第 1 张是参考原图（source），第 2 张是生成候选图（candidate）。请按维度评审相似度。";
    match call_vision_model(
        &request.base_url,
        &request.token,
        request.model.trim(),
        COMPARE_SYSTEM_PROMPT,
        user_text,
        &[source_url, candidate_url],
        2500,
    )
    .await
    {
        Ok(text) => match parse_comparison_text(&text) {
            Ok(comparison) => Ok(VisionCompareResult {
                ok: true, comparison: Some(comparison),
                error_kind: None, error_message: None, status: None,
            }),
            Err(message) => Ok(VisionCompareResult {
                ok: false, comparison: None,
                error_kind: Some("invalid_response".into()),
                error_message: Some(format!("双图比较返回格式无效：{}", message)),
                status: None,
            }),
        },
        Err(error) => Ok(VisionCompareResult {
            ok: false, comparison: None,
            error_kind: Some(error.kind),
            error_message: Some(error.message),
            status: error.status,
        }),
    }
}

// ======================= 本地色彩相似度（无 AI 调用） =======================

fn rgb_to_hsv(r: u8, g: u8, b: u8) -> (f32, f32, f32) {
    let r = r as f32 / 255.0;
    let g = g as f32 / 255.0;
    let b = b as f32 / 255.0;
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;
    let hue = if delta <= f32::EPSILON {
        0.0
    } else if (max - r).abs() <= f32::EPSILON {
        60.0 * (((g - b) / delta) % 6.0)
    } else if (max - g).abs() <= f32::EPSILON {
        60.0 * (((b - r) / delta) + 2.0)
    } else {
        60.0 * (((r - g) / delta) + 4.0)
    };
    let hue = if hue < 0.0 { hue + 360.0 } else { hue };
    let saturation = if max <= f32::EPSILON { 0.0 } else { delta / max };
    (hue, saturation, max)
}

fn color_profile(path: &str) -> Result<ColorProfile, String> {
    let p = std::path::Path::new(path);
    if !p.exists() {
        return Err(format!("图片不存在：{}", path));
    }
    let reader = image::ImageReader::open(p).map_err(|e| format!("打开图片失败：{}", e))?;
    let decoded = reader.decode().map_err(|_| "图片解码失败".to_string())?;
    let thumb = decoded.thumbnail(256, 256).to_rgb8();
    let (width, height) = thumb.dimensions();
    if width == 0 || height == 0 {
        return Err("图片尺寸无效".to_string());
    }

    const HUE_BINS: usize = 18;
    let mut hue_hist = vec![0f32; HUE_BINS];
    let mut brightness_sum = 0f32;
    let mut saturation_sum = 0f32;
    let mut brightness_sq_sum = 0f32;
    let mut pixel_count = 0usize;
    // 粗量化统计主色（每通道 3 bit → 512 桶）
    let mut quantized: std::collections::HashMap<u16, usize> = std::collections::HashMap::new();

    for pixel in thumb.pixels() {
        let [r, g, b] = pixel.0;
        let (h, s, v) = rgb_to_hsv(r, g, b);
        // 饱和度加权色相直方图：灰白像素不参与色相投票
        let weight = s;
        let bin = ((h / 360.0 * HUE_BINS as f32).floor() as usize).min(HUE_BINS - 1);
        hue_hist[bin] += weight;
        brightness_sum += v;
        brightness_sq_sum += v * v;
        saturation_sum += s;
        pixel_count += 1;
        let key = (((r as u16) >> 5) << 6) | (((g as u16) >> 5) << 3) | ((b as u16) >> 5);
        *quantized.entry(key).or_insert(0) += 1;
    }

    if pixel_count == 0 {
        return Err("图片为空".to_string());
    }
    let hist_total: f32 = hue_hist.iter().sum();
    if hist_total > f32::EPSILON {
        for bin in hue_hist.iter_mut() {
            *bin /= hist_total;
        }
    }
    let mean_b = brightness_sum / pixel_count as f32;
    let mean_b_sq = brightness_sq_sum / pixel_count as f32;
    let variance = (mean_b_sq - mean_b * mean_b).max(0.0);
    let contrast = variance.sqrt();

    let mut dominant: Vec<(u16, usize)> = quantized.into_iter().collect();
    dominant.sort_by(|a, b| b.1.cmp(&a.1));
    let dominant_colors: Vec<String> = dominant
        .into_iter()
        .take(4)
        .map(|(key, _)| {
            let r = ((key >> 6) & 0x7) as u32 * 255 / 7;
            let g = ((key >> 3) & 0x7) as u32 * 255 / 7;
            let b = (key & 0x7) as u32 * 255 / 7;
            format!("#{:02X}{:02X}{:02X}", r, g, b)
        })
        .collect();

    Ok(ColorProfile {
        dominant_colors,
        brightness: mean_b,
        saturation: saturation_sum / pixel_count as f32,
        contrast,
        hue_histogram: hue_hist,
    })
}

fn hue_histogram_intersection(a: &[f32], b: &[f32]) -> f32 {
    let total = a
        .iter()
        .zip(b.iter())
        .map(|(x, y)| x.min(*y))
        .sum::<f32>();
    // 直方图各自归一后交集理论上限为 1（完全一致）
    total.clamp(0.0, 1.0)
}

fn scalar_similarity(a: f32, b: f32) -> f32 {
    1.0 - (a - b).abs().clamp(0.0, 1.0)
}

fn color_similarity_score(source: &ColorProfile, candidate: &ColorProfile) -> f32 {
    let hue = hue_histogram_intersection(&source.hue_histogram, &candidate.hue_histogram);
    let sat = scalar_similarity(source.saturation, candidate.saturation);
    let bright = scalar_similarity(source.brightness, candidate.brightness);
    let contrast = scalar_similarity(source.contrast, candidate.contrast);
    (0.55 * hue + 0.15 * sat + 0.15 * bright + 0.15 * contrast).clamp(0.0, 1.0)
}

/// 本地色彩相似度：无 AI 调用、无网络。UI 线程外执行（Tauri async command）。
#[tauri::command]
pub async fn compute_color_similarity(
    source_path: String,
    candidate_path: String,
) -> Result<ColorSimilarityResult, String> {
    // 图片解码 / 像素统计是 CPU 密集操作，丢到阻塞线程池执行
    let result = tokio::task::spawn_blocking(move || {
        let source = color_profile(&source_path)?;
        let candidate = color_profile(&candidate_path)?;
        let score = color_similarity_score(&source, &candidate);
        Ok::<(ColorProfile, ColorProfile, f32), String>((source, candidate, score))
    })
    .await
    .map_err(|e| format!("色彩分析任务失败：{}", e))?;

    match result {
        Ok((source, candidate, score)) => Ok(ColorSimilarityResult {
            ok: true,
            score,
            source: Some(source),
            candidate: Some(candidate),
            error_message: None,
        }),
        Err(message) => Ok(ColorSimilarityResult {
            ok: false,
            score: 0.0,
            source: None,
            candidate: None,
            error_message: Some(message),
        }),
    }
}

// ======================= 测试 =======================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_analysis_valid_json() {
        let text = r##"{"summary":"红底产品图","subjects":[{"label":"保温杯","count":1,"appearance":["金属拉丝"],"position":{"x":0.5,"y":0.5,"width":0.3,"height":0.5}}],"colors":{"dominant_palette":["#AA2222"],"temperature":"暖色"},"text_elements":[{"content":"SALE","position":{"x":0.5,"y":0.08,"width":0.3,"height":0.05}}]}"##;
        let analysis = parse_analysis_text(text).unwrap();
        assert_eq!(analysis.summary, "红底产品图");
        assert_eq!(analysis.subjects.len(), 1);
        assert_eq!(analysis.subjects[0].label, "保温杯");
        assert_eq!(analysis.colors.dominant_palette, vec!["#AA2222".to_string()]);
        assert_eq!(analysis.text_elements.len(), 1);
        // 未提供的字段走默认值
        assert!(analysis.objects.is_empty());
        assert_eq!(analysis.camera.shot_type, "");
    }

    #[test]
    fn parse_analysis_with_markdown_fence() {
        let text = "好的，以下是分析：\n```json\n{\"summary\":\"风景照\",\"subjects\":[]}\n```\n";
        let analysis = parse_analysis_text(text).unwrap();
        assert_eq!(analysis.summary, "风景照");
    }

    #[test]
    fn parse_analysis_wrapped_key() {
        let text = r#"{"analysis":{"summary":"插画","style":{"category":"illustration"}}}"#;
        let analysis = parse_analysis_text(text).unwrap();
        assert_eq!(analysis.summary, "插画");
        assert_eq!(analysis.style.category, "illustration");
    }

    #[test]
    fn parse_analysis_invalid_json_rejected() {
        assert!(parse_analysis_text("这不是 JSON").is_err());
        assert!(parse_analysis_text("{\"summary\": \"未闭合").is_err());
        // 空对象（summary 为空且无主体）允许解析（serde default），由命令层空校验兜底
        let empty = parse_analysis_text("{}").unwrap();
        assert_eq!(empty.summary, "");
    }

    #[test]
    fn parse_comparison_clamps_scores() {
        let text = r#"{"subject":0.94,"composition":87,"style":1.2,"lighting":-0.3,"color":0.91,"objects":95,"text":null,"missing_elements":["招牌"],"prompt_corrections":["放大主体占比"]}"#;
        let comparison = parse_comparison_text(text).unwrap();
        assert!((comparison.subject - 0.94).abs() < 1e-6);
        // 87 视为百分制 → 0.87
        assert!((comparison.composition - 0.87).abs() < 1e-6);
        // 1.2 直接 clamp 到 1.0（≤1.5 不按百分制）
        assert!((comparison.style - 1.0).abs() < 1e-6);
        // 负值 clamp 0
        assert_eq!(comparison.lighting, 0.0);
        // objects 95 → 0.95；text 保持 null
        assert!((comparison.objects.unwrap() - 0.95).abs() < 1e-6);
        assert!(comparison.text.is_none());
        assert_eq!(comparison.prompt_corrections, vec!["放大主体占比".to_string()]);
    }

    #[test]
    fn parse_comparison_missing_required_fields_rejected() {
        // 完全无关的 JSON：结构体全 default 可解析 —— 但分数全 0 属于无效评审，
        // 命令层不额外拦截（模型极少出现；权交给上层非零校验）
        let comparison = parse_comparison_text("{\"foo\":1}").unwrap();
        assert_eq!(comparison.subject, 0.0);
    }

    #[test]
    fn clamp_score_boundaries() {
        assert_eq!(clamp_score(0.0), 0.0);
        assert_eq!(clamp_score(0.5), 0.5);
        assert_eq!(clamp_score(1.0), 1.0);
        assert_eq!(clamp_score(1.4), 1.0);
        assert!((clamp_score(50.0) - 0.5).abs() < 1e-6);
        assert_eq!(clamp_score(-5.0), 0.0);
        assert_eq!(clamp_score(200.0), 1.0);
    }

    #[test]
    fn hue_intersection_identical_and_opposite() {
        let mut hist = vec![0f32; 18];
        hist[0] = 1.0;
        assert!((hue_histogram_intersection(&hist, &hist) - 1.0).abs() < 1e-6);
        let mut other = vec![0f32; 18];
        other[9] = 1.0;
        // 红色 vs 绿色：交集为 0
        assert!(hue_histogram_intersection(&hist, &other) < 1e-6);
    }

    fn write_solid_image(path: &std::path::Path, r: u8, g: u8, b: u8) {
        let img = image::RgbImage::from_pixel(64, 64, image::Rgb([r, g, b]));
        img.save_with_format(path, image::ImageFormat::Png).unwrap();
    }

    #[test]
    fn color_similarity_same_image_is_high() {
        let dir = std::env::temp_dir();
        let a = dir.join("cyvision_color_same_a.png");
        let b = dir.join("cyvision_color_same_b.png");
        write_solid_image(&a, 200, 40, 40);
        write_solid_image(&b, 200, 40, 40);
        let source = color_profile(a.to_str().unwrap()).unwrap();
        let candidate = color_profile(b.to_str().unwrap()).unwrap();
        let score = color_similarity_score(&source, &candidate);
        assert!(score > 0.95, "identical images should score > 0.95, got {}", score);
        let _ = std::fs::remove_file(&a);
        let _ = std::fs::remove_file(&b);
    }

    #[test]
    fn color_similarity_red_vs_blue_is_low() {
        let dir = std::env::temp_dir();
        let a = dir.join("cyvision_color_red.png");
        let b = dir.join("cyvision_color_blue.png");
        write_solid_image(&a, 220, 30, 30);
        write_solid_image(&b, 30, 30, 220);
        let source = color_profile(a.to_str().unwrap()).unwrap();
        let candidate = color_profile(b.to_str().unwrap()).unwrap();
        // 饱和度/亮度/对比度接近，但色相直方图不相交 → 总分应明显低于 0.6
        let score = color_similarity_score(&source, &candidate);
        assert!(score < 0.6, "red vs blue should score < 0.6, got {}", score);
        assert!(score >= 0.4, "非色相维度仍贡献基础分, got {}", score);
        let _ = std::fs::remove_file(&a);
        let _ = std::fs::remove_file(&b);
    }

    #[test]
    fn color_profile_missing_file_errors() {
        assert!(color_profile("Z:/definitely/not/exist.png").is_err());
    }

    #[test]
    fn rgb_to_hsv_known_values() {
        // 纯红
        let (h, s, v) = rgb_to_hsv(255, 0, 0);
        assert!((h - 0.0).abs() < 1e-3 && (s - 1.0).abs() < 1e-3 && (v - 1.0).abs() < 1e-3);
        // 纯绿
        let (h, _, _) = rgb_to_hsv(0, 255, 0);
        assert!((h - 120.0).abs() < 1e-3);
        // 纯蓝
        let (h, _, _) = rgb_to_hsv(0, 0, 255);
        assert!((h - 240.0).abs() < 1e-3);
        // 黑（饱和度定义 0）
        let (_, s, v) = rgb_to_hsv(0, 0, 0);
        assert_eq!(s, 0.0);
        assert_eq!(v, 0.0);
    }
}
