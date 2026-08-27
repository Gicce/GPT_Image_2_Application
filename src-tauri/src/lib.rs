mod batch_redo;
mod commands;
mod evaluation;
mod models;
mod pose_batch;
mod reconciliation;
mod storage;
mod task_failure;
mod task_runner;
mod video_bridge;
mod video_task_bridge;
mod vision;
mod vision_normalize;
mod visual_projects;
mod skill_projects;
mod brand_analysis;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

/// In-memory runtime auth state — never persisted to disk.
/// Cleared on logout or app exit.
pub struct RuntimeAuthState {
    pub config: Mutex<models::RuntimeAuthConfig>,
}

impl Default for RuntimeAuthState {
    fn default() -> Self {
        RuntimeAuthState {
            config: Mutex::new(models::RuntimeAuthConfig::default()),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown2 = shutdown.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .manage(RuntimeAuthState::default())
        .setup(move |app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            let app_handle = app.handle().clone();
            let shutdown_flag = shutdown.clone();

            // 启动 reconciliation：上次进程退出时遗留的 running/pending 任务立即收口。
            // 不做这一步，遗留任务会永远停在“执行中”，用户只能手动取消，
            // 产生 parent=cancelled / child=completed 的错误终态。
            {
                let changed = storage::with_tasks(app.handle(), |tasks| {
                    reconciliation::reconcile_interrupted_tasks(tasks)
                });
                if !changed.is_empty() {
                    println!(
                        "[reconcile] {} interrupted task(s) finalized at boot",
                        changed.len()
                    );
                }
            }

            // CY Image Task Bridge V1 接收端：CY Video Studio → CyImagePro 真实图片任务
            // （127.0.0.1 随机端口 + 发现文件 + Bearer Token；失败不阻塞主应用）
            match video_task_bridge::start_with_discovery(app.handle().clone()) {
                Ok((port, _token)) => println!("[video-task-bridge] listening on 127.0.0.1:{port}"),
                Err(e) => eprintln!("[video-task-bridge] start failed: {e}"),
            }

            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
                rt.block_on(async {
                    let mut interval =
                        tokio::time::interval(tokio::time::Duration::from_millis(500));
                    loop {
                        interval.tick().await;
                        if shutdown_flag.load(Ordering::Relaxed) {
                            break;
                        }
                        task_runner::process_next_task(&app_handle).await;
                    }
                });
            });

            Ok(())
        })
        .on_window_event(move |_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                video_task_bridge::cleanup_discovery();
                shutdown2.store(true, Ordering::Relaxed);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::run_agent_request,
            commands::list_provider_models,
            commands::check_agent_endpoints,
            commands::understand_chat_images,
            commands::get_agent_task_templates,
            commands::save_agent_task_template,
            commands::delete_agent_task_template,
            commands::toggle_agent_task_template,
            commands::get_agent_style_templates,
            commands::save_agent_style_template,
            commands::delete_agent_style_template,
            commands::toggle_agent_style_template,
            commands::get_agent_template_logs,
            commands::append_agent_template_log,
            commands::export_agent_templates,
            commands::export_agent_template_draft,
            commands::import_agent_templates,
            commands::get_tasks,
            commands::create_task,
            commands::cancel_task,
            commands::update_vision_task,
            commands::retry_task,
            commands::retry_task_subtasks,
            commands::create_batch_redo_task,
            visual_projects::list_visual_projects,
            visual_projects::load_visual_project,
            visual_projects::save_visual_project,
            visual_projects::rename_visual_project,
            visual_projects::delete_visual_project,
            visual_projects::save_visual_project_mask,
            visual_projects::rebuild_visual_project_index,
            skill_projects::list_skill_projects,
            skill_projects::load_skill_project,
            skill_projects::save_skill_project,
            skill_projects::delete_skill_project,
            brand_analysis::analyze_brand_logo,
            brand_analysis::fingerprint_skill_asset,
            vision::vision_analyze_image,
            vision::vision_extract_detail_inserts,
            vision::vision_analyze_reference_appearance,
            vision::vision_compare_images,
            vision::compute_color_similarity,
            evaluation::evaluate_image,
            evaluation::evaluate_anime_character_consistency,
            evaluation::get_anime_consistency_evaluations,
            evaluation::get_image_evaluations,
            evaluation::update_image_evaluation_feedback,
            evaluation::delete_image_evaluation,
            evaluation::set_image_favorite,
            commands::get_images,
            commands::rescan_image_library,
            commands::import_images_to_library,
            commands::get_image_meta,
            commands::update_image_index,
            commands::delete_image,
            commands::delete_task,
            commands::read_thumbnail,
            commands::read_image_data,
            commands::open_file,
            commands::open_folder,
            commands::sync_image_to_video,
            commands::video_bridge_online,
            commands::launch_video_studio,
            commands::pick_video_studio_executable,
            commands::open_external_url,
            commands::select_directory,
            commands::select_image_file,
            commands::select_text_file,
            commands::get_conversations,
            commands::save_conversations,
            commands::save_conversation,
            commands::save_chat_image,
            commands::save_image_as,
            commands::remove_background,
            commands::chat_generate_image,
            commands::chat_edit_image,
            commands::set_runtime_auth_config,
            commands::clear_runtime_auth_config,
            commands::get_runtime_auth_status,
            commands::check_environment,
            commands::generate_test_image,
            commands::fetch_releases,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
