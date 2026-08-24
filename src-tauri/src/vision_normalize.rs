//! 视觉结构化响应规范化层（V4.0.9）：
//! Tolerant External Schema → Canonical Internal Schema 的唯一边界。
//!
//! 架构约束：
//!  - 外部模型响应 = 宽松（string / array / object / null 漂移都能恢复）；
//!  - 本模块 = 容错边界（schema 驱动的确定性归一化，逐字段记录修复日志）；
//!  - 内部 VisionAnalysis / VisionComparison = 严格（业务层永远看到 canonical 类型，
//!    绝不把 serde_json::Value 泄漏给业务代码）。
//!
//! 归一化规则（String-Like 字段：业务语义为单一描述文本）：
//!  - string 原样保留；array 稳定合并（分隔符统一「；」，禁止随机 comma/slash）；
//!  - object 只读取语义 key（description/text/value/name/summary/content/label）；
//!  - null → Canonical 默认（Option=None / String=""）；空数组同 null；
//!  - 禁止 JSON.stringify 式粗暴序列化——object 提不出语义文本就丢弃并记录。
//!
//! 数组语义字段（appearance/clothing/relations/…）保持数组：
//!  - 单字符串包成单元素数组；object 采集全部非空字符串叶子（每叶子一个元素）；
//!  - 绝不「所有 array → join」，也绝不「所有 string → 数组」。

use serde_json::{json, Value};

// ======================= 修复报告（仅开发日志，绝不进用户 UI） =======================

#[derive(Debug, Default, Clone)]
pub struct VisionNormalReport {
    /// 已自动修复的字段：`$.subjects[0].clothing expected=array actual=object action=wrapped`
    pub repaired: Vec<String>,
    /// 无法安全恢复而丢弃的字段：`$.subjects[2] expected=object actual=string action=dropped`
    pub dropped: Vec<String>,
}

impl VisionNormalReport {
    pub fn is_clean(&self) -> bool {
        self.repaired.is_empty() && self.dropped.is_empty()
    }
}

// ======================= Schema 描述（与 vision.rs DTO 一一镜像） =======================

#[derive(Debug, Clone, Copy)]
enum FieldKind {
    /// String（serde default 只兜缺失，null 会炸 → 必须归一为 ""）
    Str,
    /// Option<String>（null = None，canonical）
    OptStr,
    /// Vec<String>（真正的数组语义，保持数组）
    StrList,
    /// Option<u32>
    OptU32,
    /// Option<bool>
    OptBool,
    /// f32（非 Option：null → 0.0）
    F32,
    /// Option<f32>
    OptF32,
    /// Option<NormalizedRegion>
    OptRegion,
    /// 嵌套对象（scene / camera / …；非对象 → {}）
    Object(&'static [(&'static str, FieldKind)]),
    /// 对象数组（subjects / objects / text_elements；单对象 → 包装，非对象元素 → 丢弃）
    ObjectList(&'static [(&'static str, FieldKind)]),
}

const SUBJECT_FIELDS: &[(&str, FieldKind)] = &[
    ("label", FieldKind::Str),
    ("count", FieldKind::OptU32),
    ("appearance", FieldKind::StrList),
    ("pose", FieldKind::OptStr),
    ("action", FieldKind::OptStr),
    ("position", FieldKind::OptRegion),
    ("orientation", FieldKind::OptStr),
    ("clothing", FieldKind::StrList),
    ("relations", FieldKind::StrList),
];

const OBJECT_FIELDS: &[(&str, FieldKind)] = &[
    ("label", FieldKind::Str),
    ("count", FieldKind::OptU32),
    ("position", FieldKind::OptRegion),
    ("attributes", FieldKind::StrList),
];

const SCENE_FIELDS: &[(&str, FieldKind)] = &[
    ("environment", FieldKind::Str),
    ("location", FieldKind::Str),
    ("time_of_day", FieldKind::Str),
    ("weather", FieldKind::Str),
    ("background", FieldKind::Str),
    ("foreground", FieldKind::Str),
];

const COMPOSITION_FIELDS: &[(&str, FieldKind)] = &[
    ("subject_placement", FieldKind::Str),
    ("symmetry", FieldKind::Str),
    ("rule_of_thirds", FieldKind::OptBool),
    ("horizon", FieldKind::OptStr),
    ("negative_space", FieldKind::Str),
    ("crop", FieldKind::Str),
    ("depth_layers", FieldKind::Str),
];

const CAMERA_FIELDS: &[(&str, FieldKind)] = &[
    ("shot_type", FieldKind::Str),
    ("focal_length_estimate", FieldKind::OptStr),
    ("perspective", FieldKind::Str),
    ("angle", FieldKind::Str),
    ("depth_of_field", FieldKind::Str),
    ("lens_characteristics", FieldKind::Str),
];

const LIGHTING_FIELDS: &[(&str, FieldKind)] = &[
    ("source", FieldKind::Str),
    ("direction", FieldKind::Str),
    ("softness", FieldKind::Str),
    ("key_fill_rim", FieldKind::Str),
    ("contrast", FieldKind::Str),
    ("time_of_day", FieldKind::Str),
    ("exposure", FieldKind::Str),
];

const COLOR_FIELDS: &[(&str, FieldKind)] = &[
    ("dominant_palette", FieldKind::StrList),
    ("temperature", FieldKind::Str),
    ("saturation", FieldKind::Str),
    ("contrast", FieldKind::Str),
];

const STYLE_FIELDS: &[(&str, FieldKind)] = &[
    ("category", FieldKind::Str),
    ("medium", FieldKind::Str),
    ("texture", FieldKind::Str),
    ("rendering", FieldKind::Str),
    ("photographic_characteristics", FieldKind::Str),
];

const TEXT_ELEMENT_FIELDS: &[(&str, FieldKind)] = &[
    ("content", FieldKind::Str),
    ("position", FieldKind::OptRegion),
    ("style", FieldKind::Str),
];

const ANALYSIS_FIELDS: &[(&str, FieldKind)] = &[
    ("summary", FieldKind::Str),
    ("subjects", FieldKind::ObjectList(SUBJECT_FIELDS)),
    ("objects", FieldKind::ObjectList(OBJECT_FIELDS)),
    ("scene", FieldKind::Object(SCENE_FIELDS)),
    ("composition", FieldKind::Object(COMPOSITION_FIELDS)),
    ("camera", FieldKind::Object(CAMERA_FIELDS)),
    ("lighting", FieldKind::Object(LIGHTING_FIELDS)),
    ("colors", FieldKind::Object(COLOR_FIELDS)),
    ("style", FieldKind::Object(STYLE_FIELDS)),
    ("text_elements", FieldKind::ObjectList(TEXT_ELEMENT_FIELDS)),
    ("fine_details", FieldKind::StrList),
    ("generation_risks", FieldKind::StrList),
];

const COMPARISON_FIELDS: &[(&str, FieldKind)] = &[
    ("subject", FieldKind::F32),
    ("composition", FieldKind::F32),
    ("style", FieldKind::F32),
    ("lighting", FieldKind::F32),
    ("color", FieldKind::F32),
    ("objects", FieldKind::OptF32),
    ("text", FieldKind::OptF32),
    ("missing_elements", FieldKind::StrList),
    ("extra_elements", FieldKind::StrList),
    ("layout_differences", FieldKind::StrList),
    ("style_differences", FieldKind::StrList),
    ("lighting_differences", FieldKind::StrList),
    ("color_differences", FieldKind::StrList),
    ("prompt_corrections", FieldKind::StrList),
];

// ======================= 基础类型归一化 =======================

/// String-Like 提取 object 时允许的语义 key（白名单，禁止全量采集）。
const SEMANTIC_TEXT_KEYS: &[&str] =
    &["description", "text", "value", "name", "summary", "content", "label"];

/// array → string 合并分隔符（统一规则，禁止随机 comma/slash）。
const LIST_JOIN_SEPARATOR: &str = "；";

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn scalar_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() { None } else { Some(t.to_string()) }
        }
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn object_semantic_text(map: &serde_json::Map<String, Value>) -> Option<String> {
    SEMANTIC_TEXT_KEYS
        .iter()
        .find_map(|key| map.get(*key).and_then(scalar_to_string))
}

fn string_like_element(value: &Value) -> Option<String> {
    match value {
        Value::String(_) | Value::Number(_) | Value::Bool(_) => scalar_to_string(value),
        Value::Object(map) => object_semantic_text(map),
        // 嵌套数组拍平后再合并
        Value::Array(items) => {
            let joined = items
                .iter()
                .filter_map(string_like_element)
                .collect::<Vec<_>>()
                .join(LIST_JOIN_SEPARATOR);
            if joined.is_empty() { None } else { Some(joined) }
        }
        Value::Null => None,
    }
}

/// String-Like 归一化：string 原样；array 稳定合并；object 取语义 key；
/// null / 空数组 / 提不出语义文本的 object → ""。绝不 JSON.stringify。
fn coerce_string_like(value: &Value) -> String {
    match value {
        Value::String(_) | Value::Number(_) | Value::Bool(_) => {
            scalar_to_string(value).unwrap_or_default()
        }
        Value::Array(items) => items
            .iter()
            .filter_map(string_like_element)
            .collect::<Vec<_>>()
            .join(LIST_JOIN_SEPARATOR),
        Value::Object(map) => object_semantic_text(map).unwrap_or_default(),
        Value::Null => String::new(),
    }
}

/// 数组语义字段采集：只收集非空字符串叶子（结构拍平）；数字/布尔叶子视为噪音跳过。
fn harvest_string_leaves(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => {
            let t = s.trim();
            if !t.is_empty() {
                out.push(t.to_string());
            }
        }
        Value::Array(items) => {
            for item in items {
                harvest_string_leaves(item, out);
            }
        }
        Value::Object(map) => {
            for child in map.values() {
                harvest_string_leaves(child, out);
            }
        }
        _ => {}
    }
}

fn coerce_opt_u32(value: &Value) -> Option<u32> {
    match value {
        Value::Number(n) => n.as_f64().map(|f| {
            if f <= 0.0 {
                0u32
            } else {
                f.round().min(u32::MAX as f64) as u32
            }
        }),
        Value::String(s) => s.trim().parse::<u32>().ok(),
        _ => None,
    }
}

fn coerce_opt_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(b) => Some(*b),
        Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "1" => Some(true),
            "false" | "no" | "0" => Some(false),
            _ => None,
        },
        Value::Number(n) => n.as_f64().map(|f| f != 0.0),
        _ => None,
    }
}

fn coerce_f32(value: &Value) -> Option<f32> {
    match value {
        Value::Number(n) => n.as_f64().map(|f| f as f32),
        Value::String(s) => s.trim().parse::<f32>().ok(),
        _ => None,
    }
}

/// 归一化区域：object（数字字段可容忍字符串数字）或 [x, y, width, height] 四元数组。
fn coerce_opt_region(value: &Value) -> Option<Value> {
    match value {
        Value::Object(map) => {
            let pick = |key: &str| map.get(key).and_then(coerce_f32).unwrap_or(0.0);
            Some(json!({
                "x": pick("x"),
                "y": pick("y"),
                "width": pick("width"),
                "height": pick("height"),
            }))
        }
        Value::Array(items) if items.len() == 4 => {
            let nums: Vec<f32> = items.iter().filter_map(coerce_f32).collect();
            if nums.len() == 4 {
                Some(json!({ "x": nums[0], "y": nums[1], "width": nums[2], "height": nums[3] }))
            } else {
                None
            }
        }
        _ => None,
    }
}

/// 判断 JSON 树里是否还有任何非空文本（决定空结果是否值得发起一次模型修复）。
pub fn value_has_text_content(value: &Value) -> bool {
    match value {
        Value::String(s) => !s.trim().is_empty(),
        Value::Array(items) => items.iter().any(value_has_text_content),
        Value::Object(map) => map.values().any(value_has_text_content),
        _ => false,
    }
}

// ======================= Schema 驱动归一化主流程 =======================

fn repair_action(actual: &str) -> &'static str {
    match actual {
        "array" => "joined",
        "object" => "extracted",
        "number" | "bool" => "stringified",
        _ => "defaulted",
    }
}

fn normalize_field(path: &str, value: &mut Value, kind: FieldKind, report: &mut VisionNormalReport) {
    match kind {
        FieldKind::Str => {
            if value.is_string() {
                return;
            }
            let actual = type_name(value);
            let coerced = coerce_string_like(value);
            let action = if coerced.is_empty() && !matches!(actual, "number" | "bool") {
                "emptied"
            } else {
                repair_action(actual)
            };
            *value = Value::String(coerced);
            report.repaired.push(format!(
                "{} expected=string actual={} action={}",
                path, actual, action
            ));
        }
        FieldKind::OptStr => {
            if value.is_null() || value.is_string() {
                return;
            }
            let actual = type_name(value);
            let coerced = coerce_string_like(value);
            if coerced.is_empty() {
                *value = Value::Null;
                report.dropped.push(format!(
                    "{} expected=string actual={} action=dropped",
                    path, actual
                ));
            } else {
                *value = Value::String(coerced);
                report.repaired.push(format!(
                    "{} expected=string actual={} action={}",
                    path,
                    actual,
                    repair_action(actual)
                ));
            }
        }
        FieldKind::StrList => {
            match value {
                Value::Array(items) => {
                    let mut out: Vec<Value> = Vec::with_capacity(items.len());
                    let mut changed = false;
                    for item in items.iter() {
                        match item {
                            Value::String(s) => {
                                let t = s.trim();
                                if t.is_empty() {
                                    changed = true;
                                } else {
                                    out.push(Value::String(t.to_string()));
                                }
                            }
                            _ => {
                                let mut leaves = Vec::new();
                                harvest_string_leaves(item, &mut leaves);
                                for leaf in leaves {
                                    out.push(Value::String(leaf));
                                }
                                changed = true;
                            }
                        }
                    }
                    if changed {
                        let actual = "array(mixed)";
                        *value = Value::Array(out);
                        report.repaired.push(format!(
                            "{} expected=string-array actual={} action=coerced_elements",
                            path, actual
                        ));
                    }
                }
                Value::Null => {
                    *value = Value::Array(Vec::new());
                    report.dropped
                        .push(format!("{} expected=string-array actual=null action=emptied", path));
                }
                Value::String(_) | Value::Object(_) => {
                    let actual = type_name(value);
                    let mut leaves = Vec::new();
                    harvest_string_leaves(value, &mut leaves);
                    *value = Value::Array(leaves.into_iter().map(Value::String).collect());
                    report.repaired.push(format!(
                        "{} expected=string-array actual={} action=wrapped",
                        path, actual
                    ));
                }
                Value::Bool(_) | Value::Number(_) => {
                    let actual = type_name(value);
                    *value = Value::Array(Vec::new());
                    report.dropped.push(format!(
                        "{} expected=string-array actual={} action=dropped",
                        path, actual
                    ));
                }
            }
        }
        FieldKind::OptU32 => {
            if value.is_null() {
                return;
            }
            if let Value::Number(ref n) = value {
                if n.as_u64().is_some() {
                    return; // canonical
                }
            }
            let actual = type_name(value);
            match coerce_opt_u32(value) {
                Some(v) => {
                    *value = json!(v);
                    report.repaired.push(format!(
                        "{} expected=u32 actual={} action=coerced",
                        path, actual
                    ));
                }
                None => {
                    *value = Value::Null;
                    report.dropped.push(format!(
                        "{} expected=u32 actual={} action=dropped",
                        path, actual
                    ));
                }
            }
        }
        FieldKind::OptBool => {
            if value.is_null() || value.is_boolean() {
                return;
            }
            let actual = type_name(value);
            match coerce_opt_bool(value) {
                Some(v) => {
                    *value = Value::Bool(v);
                    report.repaired.push(format!(
                        "{} expected=bool actual={} action=coerced",
                        path, actual
                    ));
                }
                None => {
                    *value = Value::Null;
                    report.dropped.push(format!(
                        "{} expected=bool actual={} action=dropped",
                        path, actual
                    ));
                }
            }
        }
        FieldKind::F32 => {
            if value.is_number() {
                return;
            }
            let actual = type_name(value);
            let coerced = coerce_f32(value).unwrap_or(0.0);
            *value = json!(coerced);
            report.repaired.push(format!(
                "{} expected=number actual={} action=coerced",
                path, actual
            ));
        }
        FieldKind::OptF32 => {
            if value.is_null() || value.is_number() {
                return;
            }
            let actual = type_name(value);
            match coerce_f32(value) {
                Some(v) => {
                    *value = json!(v);
                    report.repaired.push(format!(
                        "{} expected=number actual={} action=coerced",
                        path, actual
                    ));
                }
                None => {
                    *value = Value::Null;
                    report.dropped.push(format!(
                        "{} expected=number actual={} action=dropped",
                        path, actual
                    ));
                }
            }
        }
        FieldKind::OptRegion => {
            if value.is_null() {
                return;
            }
            if let Value::Object(ref map) = value {
                let all_numbers = ["x", "y", "width", "height"]
                    .iter()
                    .all(|k| map.get(*k).map_or(true, |v| v.is_number()));
                if all_numbers {
                    return; // canonical
                }
            }
            let actual = type_name(value);
            match coerce_opt_region(value) {
                Some(region) => {
                    *value = region;
                    report.repaired.push(format!(
                        "{} expected=region-object actual={} action=coerced",
                        path, actual
                    ));
                }
                None => {
                    *value = Value::Null;
                    report.dropped.push(format!(
                        "{} expected=region-object actual={} action=dropped",
                        path, actual
                    ));
                }
            }
        }
        FieldKind::Object(fields) => {
            match value {
                Value::Object(map) => {
                    for (key, sub) in map.iter_mut() {
                        if let Some((_, sub_kind)) = fields.iter().find(|(name, _)| name == key) {
                            normalize_field(
                                &format!("{}.{}", path, key),
                                sub,
                                *sub_kind,
                                report,
                            );
                        }
                        // 未知 key 保留（serde 忽略未知字段），不猜测映射
                    }
                }
                _ => {
                    let actual = type_name(value);
                    *value = Value::Object(serde_json::Map::new());
                    report.dropped.push(format!(
                        "{} expected=object actual={} action=dropped",
                        path, actual
                    ));
                }
            }
        }
        FieldKind::ObjectList(item_fields) => {
            match value {
                Value::Array(items) => {
                    let mut normalized: Vec<Value> = Vec::with_capacity(items.len());
                    let mut changed = false;
                    for (index, item) in items.iter_mut().enumerate() {
                        if item.is_object() {
                            normalize_field(
                                &format!("{}[{}]", path, index),
                                item,
                                FieldKind::Object(item_fields),
                                report,
                            );
                            normalized.push(item.clone());
                        } else {
                            changed = true;
                            report.dropped.push(format!(
                                "{}[{}] expected=object actual={} action=dropped",
                                path,
                                index,
                                type_name(item)
                            ));
                        }
                    }
                    if changed {
                        *value = Value::Array(normalized);
                    }
                }
                Value::Object(_) => {
                    let actual = type_name(value);
                    normalize_field(path, value, FieldKind::Object(item_fields), report);
                    let inner = value.clone();
                    *value = Value::Array(vec![inner]);
                    report.repaired.push(format!(
                        "{} expected=array actual={} action=wrapped",
                        path, actual
                    ));
                }
                _ => {
                    let actual = type_name(value);
                    *value = Value::Array(Vec::new());
                    report.dropped.push(format!(
                        "{} expected=array actual={} action=emptied",
                        path, actual
                    ));
                }
            }
        }
    }
}

/// 单图结构化分析响应归一化（原地修改；返回修复报告供开发日志）。
pub fn normalize_vision_analysis(value: &mut Value) -> VisionNormalReport {
    let mut report = VisionNormalReport::default();
    normalize_field("$", value, FieldKind::Object(ANALYSIS_FIELDS), &mut report);
    report
}

/// 双图交叉评审响应归一化（分数字符串→数字、字符串→字符串数组等漂移）。
pub fn normalize_vision_comparison(value: &mut Value) -> VisionNormalReport {
    let mut report = VisionNormalReport::default();
    normalize_field("$", value, FieldKind::Object(COMPARISON_FIELDS), &mut report);
    report
}

// ======================= 测试 =======================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn string_like_string_kept_number_stringified() {
        assert_eq!(coerce_string_like(&json!("银白色短发")), "银白色短发");
        assert_eq!(coerce_string_like(&json!(3)), "3");
        assert_eq!(coerce_string_like(&json!(true)), "true");
    }

    #[test]
    fn string_like_array_joined_with_unified_separator() {
        assert_eq!(coerce_string_like(&json!(["银白色短发", "侧马尾"])), "银白色短发；侧马尾");
        // 英文数组同样稳定合并
        assert_eq!(coerce_string_like(&json!(["silver hair", "side tail"])), "silver hair；side tail");
        // 嵌套数组拍平
        assert_eq!(
            coerce_string_like(&json!([["a", "b"], "c"])),
            "a；b；c"
        );
    }

    #[test]
    fn string_like_empty_array_and_null_are_empty() {
        assert_eq!(coerce_string_like(&json!([])), "");
        assert_eq!(coerce_string_like(&Value::Null), "");
    }

    #[test]
    fn string_like_object_reads_semantic_keys_only() {
        assert_eq!(
            coerce_string_like(&json!({"description": "黑色连帽外套"})),
            "黑色连帽外套"
        );
        assert_eq!(coerce_string_like(&json!({"text": "夜景"})), "夜景");
        // 无语义 key 的 object：宁可丢弃也不 JSON.stringify
        assert_eq!(coerce_string_like(&json!({"foo": "bar", "baz": 1})), "");
    }

    #[test]
    fn string_list_object_harvests_all_string_leaves() {
        // clothing 语义 = 数组：object 的全部字符串叶子各成一个元素（description + details 都保留）
        let mut out = Vec::new();
        harvest_string_leaves(
            &json!({"description": "黑色短袖", "details": ["深色裙装"]}),
            &mut out,
        );
        assert_eq!(out, vec!["黑色短袖".to_string(), "深色裙装".to_string()]);
    }

    #[test]
    fn scalar_coercions() {
        assert_eq!(coerce_opt_u32(&json!("2")), Some(2));
        assert_eq!(coerce_opt_u32(&json!(1.0)), Some(1));
        assert_eq!(coerce_opt_u32(&json!("abc")), None);
        assert_eq!(coerce_opt_bool(&json!("true")), Some(true));
        assert_eq!(coerce_opt_bool(&json!("False")), Some(false));
        assert_eq!(coerce_opt_bool(&json!(1)), Some(true));
        assert_eq!(coerce_f32(&json!("0.9")), Some(0.9));
        assert_eq!(coerce_f32(&json!(0.87)), Some(0.87));
    }

    #[test]
    fn region_coercions() {
        let region = coerce_opt_region(&json!({"x": "0.5", "y": 0.4, "width": 0.3, "height": 0.6}))
            .unwrap();
        assert_eq!(region["x"], json!(0.5));
        let from_array = coerce_opt_region(&json!([0.1, 0.2, 0.3, 0.4])).unwrap();
        assert!((from_array["width"].as_f64().unwrap() - 0.3).abs() < 1e-6);
        assert!(coerce_opt_region(&json!("left")).is_none());
        assert!(coerce_opt_region(&json!([0.1, "x", 0.3, 0.4])).is_none());
    }

    #[test]
    fn normalize_analysis_full_drift_scenario() {
        let mut value = json!({
            "summary": "一名银发少女站在城市夜景街头",
            "subjects": [{
                "label": "少女",
                "count": "1",
                "appearance": ["银白色短发", "红色眼睛"],
                "pose": ["站立", "身体微微前倾"],
                "action": "回头看镜头",
                "position": {"x": "0.5", "y": 0.4, "width": 0.3, "height": 0.6},
                "clothing": {"description": "黑色连帽外套", "details": ["深色百褶裙"]},
                "relations": null
            }],
            "scene": {"environment": ["城市街道", "夜晚"], "time_of_day": null},
            "composition": {"rule_of_thirds": "true", "horizon": null},
            "camera": {"shot_type": ["中景"]},
            "lighting": {"source": ["霓虹灯", "路灯"]},
            "colors": {"dominant_palette": "#221133", "temperature": ["冷色"]},
            "style": {"category": "illustration"},
            "fine_details": "发梢泛蓝光"
        });
        let report = normalize_vision_analysis(&mut value);
        assert!(!report.is_clean());
        assert!(report.repaired.iter().any(|e| e.contains("$.subjects[0].pose")));
        // 严格反序列化必须成功（Canonical 内部 schema 保持严格）
        let analysis: crate::vision::VisionAnalysis =
            serde_json::from_value(value.clone()).expect("normalized value must parse strictly");
        assert_eq!(analysis.summary, "一名银发少女站在城市夜景街头");
        assert_eq!(analysis.subjects[0].count, Some(1));
        assert_eq!(analysis.subjects[0].pose.as_deref(), Some("站立；身体微微前倾"));
        assert_eq!(analysis.subjects[0].clothing, vec!["黑色连帽外套", "深色百褶裙"]);
        assert_eq!(analysis.subjects[0].relations, Vec::<String>::new());
        assert_eq!(analysis.subjects[0].position.as_ref().unwrap().x, 0.5);
        assert_eq!(analysis.scene.environment, "城市街道；夜晚");
        assert_eq!(analysis.scene.time_of_day, "");
        assert_eq!(analysis.composition.rule_of_thirds, Some(true));
        assert_eq!(analysis.composition.horizon, None);
        assert_eq!(analysis.camera.shot_type, "中景");
        assert_eq!(analysis.lighting.source, "霓虹灯；路灯");
        assert_eq!(analysis.colors.dominant_palette, vec!["#221133".to_string()]);
        assert_eq!(analysis.colors.temperature, "冷色");
        assert_eq!(analysis.fine_details, vec!["发梢泛蓝光".to_string()]);
    }

    #[test]
    fn normalize_analysis_single_subject_object_wrapped() {
        let mut value = json!({"summary": "单人肖像", "subjects": {"label": "女孩", "clothing": "黑色短袖"}});
        let report = normalize_vision_analysis(&mut value);
        assert!(report.repaired.iter().any(|e| e.contains("$.subjects") && e.contains("wrapped")));
        let analysis: crate::vision::VisionAnalysis = serde_json::from_value(value).unwrap();
        assert_eq!(analysis.subjects.len(), 1);
        assert_eq!(analysis.subjects[0].label, "女孩");
        assert_eq!(analysis.subjects[0].clothing, vec!["黑色短袖".to_string()]);
    }

    #[test]
    fn normalize_analysis_subjects_null_becomes_empty_array() {
        let mut value = json!({"summary": "静物", "subjects": null, "objects": "无关字符串"});
        normalize_vision_analysis(&mut value);
        let analysis: crate::vision::VisionAnalysis = serde_json::from_value(value).unwrap();
        assert!(analysis.subjects.is_empty());
        assert!(analysis.objects.is_empty());
    }

    #[test]
    fn normalize_analysis_non_object_member_dropped_not_fatal() {
        // scene 是字符串：无法映射到子字段 → 丢弃（其它字段全部保留）
        let mut value = json!({"summary": "风景", "scene": "户外夜晚", "style": {"category": "photo"}});
        let report = normalize_vision_analysis(&mut value);
        assert!(report.dropped.iter().any(|e| e.contains("$.scene")));
        let analysis: crate::vision::VisionAnalysis = serde_json::from_value(value).unwrap();
        assert_eq!(analysis.summary, "风景");
        assert_eq!(analysis.scene.environment, "");
        assert_eq!(analysis.style.category, "photo");
    }

    #[test]
    fn normalize_analysis_canonical_input_is_clean() {
        let mut value = json!({
            "summary": "红底产品图",
            "subjects": [{"label": "保温杯", "count": 1, "appearance": ["金属拉丝"]}],
            "colors": {"dominant_palette": ["#AA2222"], "temperature": "暖色"}
        });
        let report = normalize_vision_analysis(&mut value);
        assert!(report.is_clean());
    }

    #[test]
    fn normalize_comparison_drift() {
        let mut value = json!({
            "subject": "0.94",
            "composition": 87,
            "style": 1.2,
            "lighting": null,
            "color": 0.91,
            "objects": 95,
            "text": null,
            "missing_elements": "霓虹招牌",
            "prompt_corrections": ["放大主体占比", {"text": "提高饱和度"}]
        });
        let report = normalize_vision_comparison(&mut value);
        assert!(!report.is_clean());
        let comparison: crate::vision::VisionComparison =
            serde_json::from_value(value).expect("normalized comparison must parse strictly");
        assert_eq!(comparison.subject, 0.94);
        assert_eq!(comparison.missing_elements, vec!["霓虹招牌".to_string()]);
        assert_eq!(
            comparison.prompt_corrections,
            vec!["放大主体占比".to_string(), "提高饱和度".to_string()]
        );
    }

    #[test]
    fn value_has_text_content_detects_nested_strings() {
        assert!(value_has_text_content(&json!({"a": {"b": ["", "x"]}})));
        assert!(!value_has_text_content(&json!({"a": [1, 2], "b": ""})));
        assert!(!value_has_text_content(&json!({})));
    }
}
