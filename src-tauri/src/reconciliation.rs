//! 任务状态收口（V4.0.3 Runtime Stability）。
//!
//! 三个职责，全部以 sub_tasks 事实为唯一统计来源：
//!  1. 启动 reconciliation：上次运行遗留的 running/pending 任务在启动时收口，
//!     不允许“子任务已完成、父任务永远 running”。
//!  2. cancel 终态保护：completed/failed/cancelled 不允许被改写成 cancelled。
//!  3. 计数派生：success_count/failed_count 一律从 sub_tasks 状态推导，禁止分散自增。

use crate::models::Task;

const TERMINAL: [&str; 3] = ["completed", "failed", "cancelled"];

pub fn is_terminal_status(status: &str) -> bool {
    TERMINAL.contains(&status)
}

/// 只有活跃（非终态）任务允许被取消。
pub fn cancel_task_in_place(task: &mut Task) -> bool {
    if is_terminal_status(&task.status) {
        return false;
    }
    let now = chrono::Local::now().to_rfc3339();
    task.status = "cancelled".to_string();
    task.completed_at = task.completed_at.take().or(Some(now));
    for st in &mut task.sub_tasks {
        if !is_terminal_status(&st.status) {
            st.status = "cancelled".to_string();
        }
    }
    true
}

fn derive_counts(task: &Task) -> (usize, usize) {
    let success = task
        .sub_tasks
        .iter()
        .filter(|st| st.status == "completed")
        .count();
    let failed = task
        .sub_tasks
        .iter()
        .filter(|st| st.status == "failed")
        .count();
    (success, failed)
}

/// 执行器正常跑完后的收口：状态由 sub_tasks 事实决定，计数同步派生。
/// 任何失败子任务 → failed（与历史产品语义一致：2 成功 + 1 失败 = failed，但计数如实反映 2/1）。
pub fn finalize_task_in_place(task: &mut Task, was_cancelled: bool) {
    if was_cancelled || task.status == "cancelled" {
        task.status = "cancelled".to_string();
        for st in &mut task.sub_tasks {
            if !is_terminal_status(&st.status) {
                st.status = "cancelled".to_string();
            }
        }
    } else if is_terminal_status(&task.status) {
        // 防御：状态已被并发置为终态（如 cancel 抢先落盘），不覆盖，仅补计数
    } else if task
        .sub_tasks
        .iter()
        .any(|st| st.status == "failed")
    {
        task.status = "failed".to_string();
        for st in &mut task.sub_tasks {
            if !is_terminal_status(&st.status) {
                st.status = "failed".to_string();
                if st.error.is_none() {
                    st.error = Some("未执行：前序子任务失败导致任务中断".to_string());
                }
            }
        }
    } else {
        task.status = "completed".to_string();
    }

    let (success, failed) = derive_counts(task);
    task.success_count = success;
    task.failed_count = failed;
    if task.completed_at.is_none() {
        task.completed_at = Some(chrono::Local::now().to_rfc3339());
    }
}

/// 执行器前置校验失败（如 API Token 未设置）时的收口：
/// 全部子任务标记失败并携带原因，计数必须同步（历史 bug：状态 failed 但 failed_count=0）。
pub fn fail_task_in_place(task: &mut Task, reason: &str) {
    let now = chrono::Local::now().to_rfc3339();
    task.status = "failed".to_string();
    task.completed_at = Some(now);
    for st in &mut task.sub_tasks {
        st.status = "failed".to_string();
        if st.error.is_none() {
            st.error = Some(reason.to_string());
        }
    }
    task.failed_count = task.sub_tasks.iter().filter(|st| st.status == "failed").count();
    task.success_count = task.sub_tasks.iter().filter(|st| st.status == "completed").count();
}

/// V4.0.5 单子任务重试：把指定（或全部）failed 子任务重置为 pending，
/// 供执行器只重跑这些槽位（completed 子任务绝不动——不重跑、不删图）。
/// 返回实际重置的下标（过滤掉非 failed / 越界）；空 = 无可重试项，任务保持原状。
/// retry_count 累加；attempt_errors 保留历史（成功后 error 清空但历史仍在）。
pub fn reset_failed_subtasks_for_retry(task: &mut Task, indexes: Option<&[usize]>) -> Vec<usize> {
    let failed: Vec<usize> = match indexes {
        Some(list) => list
            .iter()
            .copied()
            .filter(|&i| {
                task.sub_tasks
                    .get(i)
                    .map(|st| st.status == "failed")
                    .unwrap_or(false)
            })
            .collect(),
        None => task
            .sub_tasks
            .iter()
            .enumerate()
            .filter(|(_, st)| st.status == "failed")
            .map(|(i, _)| i)
            .collect(),
    };
    if failed.is_empty() {
        return failed;
    }
    for &i in &failed {
        let st = &mut task.sub_tasks[i];
        st.status = "pending".to_string();
        st.error = None;
        st.retry_count += 1;
    }
    task.status = "pending".to_string();
    task.completed_at = None;
    task.started_at = None;
    failed
}

/// 启动 reconciliation：上次进程退出时仍在 running/pending 的任务收口。
/// 规则（谨慎处理历史数据，terminal 任务一律不动）：
///  - 非终态任务的 pending/running 子任务 → failed（“客户端重启导致任务中断”）
///  - 子任务全部 completed（图片已生成、只是没来得及 finalize）→ completed
///  - 存在 failed 子任务 → failed
/// 返回被修改的任务 id（用于事件通知）。
pub fn reconcile_interrupted_tasks(tasks: &mut Vec<Task>) -> Vec<String> {
    let mut changed = Vec::new();
    for task in tasks.iter_mut() {
        if is_terminal_status(&task.status) {
            continue;
        }
        let has_sub_work = !task.sub_tasks.is_empty();
        let interrupted: Vec<usize> = task
            .sub_tasks
            .iter()
            .enumerate()
            .filter(|(_, st)| !is_terminal_status(&st.status))
            .map(|(i, _)| i)
            .collect();

        let now = chrono::Local::now().to_rfc3339();
        let task_id = task.id.clone();
        {
            for i in interrupted {
                task.sub_tasks[i].status = "failed".to_string();
                if task.sub_tasks[i].error.is_none() {
                    task.sub_tasks[i].error =
                        Some("客户端重启导致任务中断，请重试该任务。".to_string());
                }
            }
            let (success, failed) = derive_counts(task);
            task.success_count = success;
            task.failed_count = failed;
            if has_sub_work && failed == 0 && success > 0 {
                task.status = "completed".to_string();
            } else {
                task.status = "failed".to_string();
            }
            if task.completed_at.is_none() {
                task.completed_at = Some(now);
            }
        }
        changed.push(task_id);
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SubTask, Task};

    fn base_task(status: &str, sub: &[&str]) -> Task {
        Task {
            id: "t1".into(),
            prompt: "p".into(),
            negative_prompt: String::new(),
            user_prompt_raw: "p".into(),
            final_prompt: "p".into(),
            final_negative_prompt: String::new(),
            prompt_optimized: false,
            prompt_optimization: None,
            agent_intent: String::new(),
            task_source: "agent".into(),
            size: "1024x1024".into(),
            quality: "auto".into(),
            output_format: "png".into(),
            count: sub.len(),
            status: status.into(),
            created_at: "2026-01-01T00:00:00".into(),
            started_at: None,
            completed_at: None,
            output_dir: "/tmp".into(),
            success_count: 0,
            failed_count: 0,
            task_type: "generate".into(),
            source_images: Vec::new(),
            execution_mode: "single".into(),
            batch_strategy: String::new(),
            task_plan_summary: String::new(),
            batch_items: Vec::new(),
            composite_layout: None,
            subject_entities: Vec::new(),
            sub_tasks: sub
                .iter()
                .enumerate()
                .map(|(i, s)| SubTask {
                    index: i,
                    status: (*s).into(),
                    image_id: None,
                    error: None,
                    label: None,
                    retry_count: 0,
                    attempt_errors: Vec::new(),
                })
                .collect(),
        }
    }

    #[test]
    fn reconcile_all_children_completed_completes_parent() {
        let mut tasks = vec![base_task("running", &["completed"])];
        let changed = reconcile_interrupted_tasks(&mut tasks);
        assert_eq!(changed.len(), 1);
        assert_eq!(tasks[0].status, "completed");
        assert_eq!(tasks[0].success_count, 1);
        assert_eq!(tasks[0].failed_count, 0);
        assert!(tasks[0].completed_at.is_some());
    }

    #[test]
    fn reconcile_interrupted_children_fail_parent() {
        let mut tasks = vec![base_task("running", &["running"])];
        reconcile_interrupted_tasks(&mut tasks);
        assert_eq!(tasks[0].status, "failed");
        assert_eq!(tasks[0].failed_count, 1);
        assert!(tasks[0].sub_tasks[0].error.as_deref().unwrap().contains("重启"));
    }

    #[test]
    fn reconcile_mixed_children_yield_failed_with_factual_counts() {
        let mut tasks = vec![base_task("pending", &["completed", "completed", "pending"])];
        reconcile_interrupted_tasks(&mut tasks);
        assert_eq!(tasks[0].status, "failed");
        assert_eq!(tasks[0].success_count, 2);
        assert_eq!(tasks[0].failed_count, 1);
    }

    #[test]
    fn reconcile_never_touches_terminal_tasks() {
        let mut tasks = vec![
            base_task("completed", &["completed"]),
            base_task("cancelled", &["cancelled"]),
            base_task("failed", &["failed"]),
        ];
        let changed = reconcile_interrupted_tasks(&mut tasks);
        assert!(changed.is_empty());
        assert_eq!(tasks[0].status, "completed");
        assert_eq!(tasks[1].status, "cancelled");
        assert_eq!(tasks[2].status, "failed");
    }

    #[test]
    fn cancel_guard_blocks_terminal_states() {
        for status in ["completed", "failed", "cancelled"] {
            let mut task = base_task(status, &["completed"]);
            assert!(!cancel_task_in_place(&mut task), "cancel must not override {status}");
            assert_eq!(task.status, status);
        }
    }

    #[test]
    fn cancel_active_task_sweeps_non_terminal_sub_tasks() {
        let mut task = base_task("running", &["completed", "running"]);
        assert!(cancel_task_in_place(&mut task));
        assert_eq!(task.status, "cancelled");
        assert_eq!(task.sub_tasks[0].status, "completed");
        assert_eq!(task.sub_tasks[1].status, "cancelled");
        assert!(task.completed_at.is_some());
    }

    #[test]
    fn finalize_success_completes_parent_with_derived_counts() {
        let mut task = base_task("running", &["completed", "completed", "completed"]);
        finalize_task_in_place(&mut task, false);
        assert_eq!(task.status, "completed");
        assert_eq!(task.success_count, 3);
        assert_eq!(task.failed_count, 0);
    }

    #[test]
    fn finalize_any_failure_fails_parent_but_keeps_factual_counts() {
        let mut task = base_task("running", &["completed", "completed", "failed"]);
        finalize_task_in_place(&mut task, false);
        assert_eq!(task.status, "failed");
        assert_eq!(task.success_count, 2);
        assert_eq!(task.failed_count, 1);
    }

    #[test]
    fn finalize_cancelled_wins_over_loop_result() {
        // 执行循环期间用户取消：cancel 已落盘 → cancelled 保持，未完成子任务标 cancelled
        let mut task = base_task("cancelled", &["completed", "running"]);
        finalize_task_in_place(&mut task, false);
        assert_eq!(task.status, "cancelled");
        assert_eq!(task.sub_tasks[1].status, "cancelled");
        assert_eq!(task.success_count, 1);
        assert_eq!(task.failed_count, 0);
    }

    #[test]
    fn fail_task_sets_failure_count() {
        // 历史 bug 回归：Token 未设置 → failed 但 failed_count=0
        let mut task = base_task("running", &["pending", "pending"]);
        fail_task_in_place(&mut task, "API Token 未设置");
        assert_eq!(task.status, "failed");
        assert_eq!(task.failed_count, 2);
        assert_eq!(task.success_count, 0);
        assert_eq!(task.sub_tasks[0].error.as_deref(), Some("API Token 未设置"));
        assert!(task.completed_at.is_some());
    }

    #[test]
    fn retry_all_resets_only_failed_children() {
        // 6 张：4 成功 2 失败 → 重试全部失败项只重置 failed 槽位
        let mut task = base_task(
            "failed",
            &["failed", "completed", "completed", "failed", "completed", "completed"],
        );
        task.sub_tasks[0].error = Some("connect".into());
        task.sub_tasks[3].error = Some("400".into());
        let reset = reset_failed_subtasks_for_retry(&mut task, None);
        assert_eq!(reset, vec![0, 3]);
        assert_eq!(task.status, "pending");
        assert!(task.completed_at.is_none());
        for i in [1, 2, 4, 5] {
            assert_eq!(task.sub_tasks[i].status, "completed", "child {i} must stay completed");
        }
        for i in [0, 3] {
            assert_eq!(task.sub_tasks[i].status, "pending");
            assert_eq!(task.sub_tasks[i].retry_count, 1);
            assert!(task.sub_tasks[i].error.is_none());
        }
    }

    #[test]
    fn retry_single_child_never_touches_others() {
        let mut task = base_task("failed", &["failed", "completed", "failed"]);
        let reset = reset_failed_subtasks_for_retry(&mut task, Some(&[2]));
        assert_eq!(reset, vec![2]);
        assert_eq!(task.sub_tasks[0].status, "failed");
        assert_eq!(task.sub_tasks[1].status, "completed");
        assert_eq!(task.sub_tasks[2].status, "pending");
    }

    #[test]
    fn retry_filters_non_failed_and_out_of_range_indexes() {
        let mut task = base_task("failed", &["completed", "failed"]);
        // 0 是 completed、99 越界：都不得重置
        let reset = reset_failed_subtasks_for_retry(&mut task, Some(&[0, 1, 99]));
        assert_eq!(reset, vec![1]);
        assert_eq!(task.sub_tasks[0].status, "completed");
    }

    #[test]
    fn retry_without_failed_children_is_noop() {
        let mut task = base_task("completed", &["completed", "completed"]);
        task.completed_at = Some("2026-01-01T00:00:00".into());
        let reset = reset_failed_subtasks_for_retry(&mut task, None);
        assert!(reset.is_empty());
        assert_eq!(task.status, "completed", "no-op must not resurrect a terminal task");
        assert!(task.completed_at.is_some());
    }

    #[test]
    fn retry_accumulates_retry_count_across_rounds() {
        let mut task = base_task("failed", &["failed"]);
        reset_failed_subtasks_for_retry(&mut task, None);
        task.sub_tasks[0].status = "failed".into();
        reset_failed_subtasks_for_retry(&mut task, None);
        assert_eq!(task.sub_tasks[0].retry_count, 2);
    }
}
