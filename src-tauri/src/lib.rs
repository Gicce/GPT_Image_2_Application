mod commands;
mod models;
mod storage;
mod task_runner;
mod video_bridge;

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
            commands::retry_task,
            commands::get_images,
            commands::rescan_image_library,
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
