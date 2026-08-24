//! 批量任务「重做」（V4.0.6）：
//! 基于源 Batch Task 的选中子项创建一个**全新的**批量任务。
//! 与 retry 的本质区别 —— retry 原地重置失败槽位（V4.0.5 语义，不动）；
//! redo 生成新 Task，源任务的任何字段、子任务状态、retry 历史、结果图都不可变。

use crate::models::{BatchRedoItemOverride, CreateBatchRedoRequest, SubTask, Task, TaskBatchItem};

/// effective_prompt 与 task_runner 同一逻辑：本模块只在构建期使用，
/// 展平后的新任务子项全部通过 prompt_override 自包含表达。
fn effective_prompt_of(task: &Task, index: usize) -> String {
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

fn effective_negative_of(task: &Task, index: usize) -> String {
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

/// 纯构建函数（无 IO，可测试）：源任务 + 重做请求 → 新任务。
/// 新任务 count = 选中数；子项 Prompt 展平为 prompt_override（继承源任务
/// override/delta 组合结果），global prefix/suffix 与 per-item override 依次套用。
pub fn build_batch_redo_task(
    source: &Task,
    request: &CreateBatchRedoRequest,
    now_iso: String,
) -> Result<Task, String> {
    if source.execution_mode != "batch" {
        return Err("仅批量任务支持重做".to_string());
    }
    if source.batch_items.is_empty() {
        return Err("该批量任务没有子方案（batch_items 为空），无法重做".to_string());
    }
    if request.selected_indexes.is_empty() {
        return Err("请至少选择一个子任务".to_string());
    }

    let mut seen = std::collections::HashSet::new();
    for &idx in &request.selected_indexes {
        if idx >= source.batch_items.len() {
            return Err(format!("子任务下标越界：#{}（该任务共 {} 个子项）", idx + 1, source.batch_items.len()));
        }
        if !seen.insert(idx) {
            return Err(format!("子任务 #{} 被重复选择", idx + 1));
        }
    }

    let mut ordered_indexes = request.selected_indexes.clone();
    ordered_indexes.sort_unstable();
    // 保持用户在界面上看到的顺序（选中顺序即展示顺序）而非排序后顺序：
    // 子任务槽位含义由顺序决定，重排会让「#2 重做后变 #1」造成混淆。
    let _ = &mut ordered_indexes;

    let item_overrides: std::collections::HashMap<usize, &BatchRedoItemOverride> = request
        .item_overrides
        .iter()
        .map(|ov| (ov.index, ov))
        .collect();

    let mut new_items: Vec<TaskBatchItem> = Vec::with_capacity(request.selected_indexes.len());
    for &idx in &request.selected_indexes {
        let mut item = source.batch_items[idx].clone();
        // 展平：新子项自包含（prompt_override 优先级最高，delta 清空防止二次叠加）
        item.prompt_override = effective_prompt_of(source, idx);
        item.prompt_delta = String::new();
        item.negative_override = effective_negative_of(source, idx);
        item.negative_delta = String::new();
        item.enabled = true;
        item.id = uuid::Uuid::new_v4().to_string();

        // 全局 Prompt 前缀 / 后缀（不覆盖各子项内容，只包裹）
        if let Some(prefix) = request.global_overrides.prompt_prefix.as_deref() {
            let prefix = prefix.trim();
            if !prefix.is_empty() {
                item.prompt_override = format!("{}\n{}", prefix, item.prompt_override);
            }
        }
        if let Some(suffix) = request.global_overrides.prompt_suffix.as_deref() {
            let suffix = suffix.trim();
            if !suffix.is_empty() {
                item.prompt_override = format!("{}\n{}", item.prompt_override, suffix);
            }
        }

        // 单项覆盖（最高优先级）
        if let Some(ov) = item_overrides.get(&idx) {
            if let Some(label) = ov.label.as_deref() {
                if !label.trim().is_empty() {
                    item.label = label.trim().to_string();
                }
            }
            if let Some(prompt) = ov.prompt.as_deref() {
                if !prompt.trim().is_empty() {
                    item.prompt_override = prompt.trim().to_string();
                }
            }
            if let Some(negative) = ov.negative_prompt.as_deref() {
                item.negative_override = negative.trim().to_string();
            }
        }
        new_items.push(item);
    }

    let count = new_items.len();
    let source_label: String = source.id.chars().take(8).collect();
    let redo_summary = match source.task_plan_summary.trim() {
        s if !s.is_empty() => format!("重做自 #{}（{}/{} 项）：{}", source_label, count, source.count, s),
        _ => format!("重做自 #{}（{}/{} 项）", source_label, count, source.count),
    };

    Ok(Task {
        id: uuid::Uuid::new_v4().to_string(),
        prompt: source.prompt.clone(),
        negative_prompt: source.negative_prompt.clone(),
        user_prompt_raw: source.user_prompt_raw.clone(),
        final_prompt: source.final_prompt.clone(),
        final_negative_prompt: source.final_negative_prompt.clone(),
        prompt_optimized: source.prompt_optimized,
        prompt_optimization: source.prompt_optimization.clone(),
        agent_intent: source.agent_intent.clone(),
        task_source: source.task_source.clone(),
        size: request
            .global_overrides
            .size
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&source.size)
            .to_string(),
        quality: request
            .global_overrides
            .quality
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&source.quality)
            .to_string(),
        output_format: request
            .global_overrides
            .output_format
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&source.output_format)
            .to_string(),
        count,
        status: "pending".to_string(),
        created_at: now_iso,
        started_at: None,
        completed_at: None,
        output_dir: request
            .global_overrides
            .output_dir
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&source.output_dir)
            .to_string(),
        success_count: 0,
        failed_count: 0,
        sub_tasks: (0..count)
            .map(|i| SubTask {
                index: i,
                status: "pending".to_string(),
                image_id: None,
                error: None,
                label: new_items.get(i).map(|item| item.label.clone()),
                retry_count: 0,
                attempt_errors: Vec::new(),
                error_detail: None,
                attempt_details: Vec::new(),
            })
            .collect(),
        task_type: if source.task_type.is_empty() {
            "generate".to_string()
        } else {
            source.task_type.clone()
        },
        source_images: source.source_images.clone(),
        mask_image: source.mask_image.clone(),
        execution_mode: "batch".to_string(),
        batch_strategy: source.batch_strategy.clone(),
        task_plan_summary: redo_summary,
        batch_items: new_items,
        composite_layout: None,
        subject_entities: source.subject_entities.clone(),
        source_task_id: source.source_task_id.clone(),
        source_task_kind: source.source_task_kind.clone(),
        source_app: source.source_app.clone(),
        source_request_id: String::new(),
        source_context: source.source_context.clone(),
        stage_note: String::new(),
        // 动作白膜批：批量重做克隆保留批元数据（来源继承；batchId 查找仍命中原任务）
        pose_batch: source.pose_batch.clone(),
        provenance: source.provenance.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::BatchRedoGlobalOverrides;

    fn make_source() -> Task {
        let base = Task {
            id: "src-task-0001".to_string(),
            prompt: "基础产品图".to_string(),
            negative_prompt: "低清".to_string(),
            user_prompt_raw: "基础产品图".to_string(),
            final_prompt: "最终基础产品图".to_string(),
            final_negative_prompt: "模糊, 低清".to_string(),
            prompt_optimized: false,
            prompt_optimization: None,
            agent_intent: String::new(),
            task_source: "manual".to_string(),
            size: "1024x1024".to_string(),
            quality: "auto".to_string(),
            output_format: "png".to_string(),
            count: 3,
            status: "failed".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            started_at: None,
            completed_at: None,
            output_dir: "D:/out".to_string(),
            success_count: 1,
            failed_count: 2,
            sub_tasks: vec![
                SubTask { index: 0, status: "completed".to_string(), image_id: Some("img-1".to_string()), error: None, label: Some("方案一".to_string()), retry_count: 0, attempt_errors: vec![], error_detail: None, attempt_details: vec![] },
                SubTask { index: 1, status: "failed".to_string(), image_id: None, error: Some("网络错误".to_string()), label: Some("方案二".to_string()), retry_count: 1, attempt_errors: vec!["网络错误".to_string()], error_detail: None, attempt_details: vec![] },
                SubTask { index: 2, status: "failed".to_string(), image_id: None, error: Some("上游失败".to_string()), label: Some("方案三".to_string()), retry_count: 0, attempt_errors: vec![], error_detail: None, attempt_details: vec![] },
            ],
            task_type: "generate".to_string(),
            source_images: vec![],
            execution_mode: "batch".to_string(),
            mask_image: None,
            batch_strategy: "variant_set".to_string(),
            task_plan_summary: "三个产品方案".to_string(),
            batch_items: vec![
                TaskBatchItem { id: "b1".to_string(), label: "方案一".to_string(), prompt_delta: "红色背景".to_string(), prompt_override: String::new(), negative_override: String::new(), negative_delta: String::new(), source_images: vec![], enabled: true, plan_title: "红".to_string(), plan_summary: String::new(), plan_tags: vec![], plan_description: String::new() },
                TaskBatchItem { id: "b2".to_string(), label: "方案二".to_string(), prompt_delta: String::new(), prompt_override: "蓝色背景特写".to_string(), negative_override: "文字水印".to_string(), negative_delta: String::new(), source_images: vec![], enabled: true, plan_title: "蓝".to_string(), plan_summary: String::new(), plan_tags: vec![], plan_description: String::new() },
                TaskBatchItem { id: "b3".to_string(), label: "方案三".to_string(), prompt_delta: "绿色背景".to_string(), prompt_override: String::new(), negative_override: String::new(), negative_delta: "噪点".to_string(), source_images: vec![], enabled: true, plan_title: "绿".to_string(), plan_summary: String::new(), plan_tags: vec![], plan_description: String::new() },
            ],
            composite_layout: None,
            subject_entities: vec![],
            source_task_id: None,
            source_task_kind: String::new(),
            stage_note: String::new(),
            source_app: String::new(),
            source_request_id: String::new(),
            source_context: None,
            pose_batch: None,
            provenance: None,
        };
        base
    }

    fn empty_request(source_id: &str, indexes: Vec<usize>) -> CreateBatchRedoRequest {
        CreateBatchRedoRequest {
            source_task_id: source_id.to_string(),
            selected_indexes: indexes,
            global_overrides: BatchRedoGlobalOverrides::default(),
            item_overrides: vec![],
        }
    }

    #[test]
    fn redo_single_item_creates_new_pending_task() {
        let source = make_source();
        let request = empty_request(&source.id, vec![1]);
        let new_task = build_batch_redo_task(&source, &request, "2026-08-20T00:00:00Z".to_string()).unwrap();
        assert_eq!(new_task.count, 1);
        assert_eq!(new_task.status, "pending");
        assert_eq!(new_task.execution_mode, "batch");
        assert_eq!(new_task.batch_items.len(), 1);
        assert_eq!(new_task.batch_items[0].label, "方案二");
        // prompt_override 原样继承（源项本身就是 override）
        assert_eq!(new_task.batch_items[0].prompt_override, "蓝色背景特写");
        assert_eq!(new_task.sub_tasks[0].status, "pending");
        assert_eq!(new_task.sub_tasks[0].label.as_deref(), Some("方案二"));
    }

    #[test]
    fn redo_multiple_items_preserves_order_and_flattens_delta() {
        let source = make_source();
        // 用户按 3、1 的顺序勾选
        let request = empty_request(&source.id, vec![2, 0]);
        let new_task = build_batch_redo_task(&source, &request, "now".to_string()).unwrap();
        assert_eq!(new_task.count, 2);
        // 顺序保持勾选顺序
        assert_eq!(new_task.batch_items[0].label, "方案三");
        assert_eq!(new_task.batch_items[1].label, "方案一");
        // delta 展平：方案一 (final_prompt + delta) / 方案三同理
        assert_eq!(new_task.batch_items[0].prompt_override, "最终基础产品图\n绿色背景");
        assert_eq!(new_task.batch_items[1].prompt_override, "最终基础产品图\n红色背景");
        assert!(new_task.batch_items[0].prompt_delta.is_empty());
        // negative 展平：方案三 final_negative + negative_delta 由 effective 逻辑取 final_negative（delta 组合仅 override 优先）
        assert_eq!(new_task.batch_items[0].negative_override, "模糊, 低清");
    }

    #[test]
    fn redo_rejects_invalid_index() {
        let source = make_source();
        assert!(build_batch_redo_task(&source, &empty_request(&source.id, vec![3]), "now".to_string()).is_err());
        assert!(build_batch_redo_task(&source, &empty_request(&source.id, vec![]), "now".to_string()).is_err());
        // 重复选择
        assert!(build_batch_redo_task(&source, &empty_request(&source.id, vec![0, 0]), "now".to_string()).is_err());
    }

    #[test]
    fn redo_rejects_non_batch_task() {
        let mut source = make_source();
        source.execution_mode = "single".to_string();
        let result = build_batch_redo_task(&source, &empty_request(&source.id, vec![0]), "now".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn redo_source_task_immutable() {
        let source = make_source();
        let snapshot = serde_json::to_string(&source).unwrap();
        let request = empty_request(&source.id, vec![0, 1, 2]);
        let _ = build_batch_redo_task(&source, &request, "now".to_string()).unwrap();
        assert_eq!(snapshot, serde_json::to_string(&source).unwrap());
    }

    #[test]
    fn redo_merges_global_overrides() {
        let source = make_source();
        let mut request = empty_request(&source.id, vec![0, 1]);
        request.global_overrides = BatchRedoGlobalOverrides {
            size: Some("1792x1024".to_string()),
            quality: Some("high".to_string()),
            output_format: Some("jpeg".to_string()),
            output_dir: Some("D:/new-out".to_string()),
            prompt_prefix: Some("电商主图".to_string()),
            prompt_suffix: Some("细节丰富".to_string()),
        };
        let new_task = build_batch_redo_task(&source, &request, "now".to_string()).unwrap();
        assert_eq!(new_task.size, "1792x1024");
        assert_eq!(new_task.quality, "high");
        assert_eq!(new_task.output_format, "jpeg");
        assert_eq!(new_task.output_dir, "D:/new-out");
        // 全局前后缀包裹每项 Prompt
        assert!(new_task.batch_items[0].prompt_override.starts_with("电商主图\n"));
        assert!(new_task.batch_items[0].prompt_override.ends_with("\n细节丰富"));
        // 空字符串覆盖不生效（防前端误传空值清掉继承）
        request.global_overrides.size = Some("   ".to_string());
        let task2 = build_batch_redo_task(&source, &request, "now".to_string()).unwrap();
        assert_eq!(task2.size, "1024x1024");
    }

    #[test]
    fn redo_merges_item_overrides() {
        let source = make_source();
        let mut request = empty_request(&source.id, vec![1]);
        request.item_overrides = vec![BatchRedoItemOverride {
            index: 1,
            label: Some("新标题".to_string()),
            prompt: Some("完全替换后的提示词".to_string()),
            negative_prompt: Some("全新负面词".to_string()),
        }];
        let new_task = build_batch_redo_task(&source, &request, "now".to_string()).unwrap();
        assert_eq!(new_task.batch_items[0].label, "新标题");
        assert_eq!(new_task.batch_items[0].prompt_override, "完全替换后的提示词");
        assert_eq!(new_task.batch_items[0].negative_override, "全新负面词");
        // subtask label 跟随覆盖后的 label
        assert_eq!(new_task.sub_tasks[0].label.as_deref(), Some("新标题"));
    }

    #[test]
    fn redo_does_not_inherit_source_results_or_retry_history() {
        let source = make_source();
        let new_task = build_batch_redo_task(&source, &empty_request(&source.id, vec![0]), "now".to_string()).unwrap();
        assert_eq!(new_task.success_count, 0);
        assert_eq!(new_task.failed_count, 0);
        assert_eq!(new_task.sub_tasks[0].retry_count, 0);
        assert!(new_task.sub_tasks[0].image_id.is_none());
        assert!(new_task.sub_tasks[0].attempt_errors.is_empty());
        assert_ne!(new_task.id, source.id);
        assert!(new_task.task_plan_summary.contains("重做自"));
    }
}
