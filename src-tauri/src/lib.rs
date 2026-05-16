mod commands;
mod models;
mod storage;
mod task_runner;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown2 = shutdown.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

            let app_handle = app.handle().clone();
            let shutdown_flag = shutdown.clone();

            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
                rt.block_on(async {
                    let mut interval = tokio::time::interval(tokio::time::Duration::from_millis(500));
                    loop {
                        interval.tick().await;
                        if shutdown_flag.load(Ordering::Relaxed) { break; }
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
            commands::get_tasks,
            commands::create_task,
            commands::cancel_task,
            commands::retry_task,
            commands::get_images,
            commands::delete_image,
            commands::delete_task,
            commands::read_thumbnail,
            commands::read_image_data,
            commands::open_file,
            commands::open_folder,
            commands::select_directory,
            commands::select_image_file,
            commands::select_text_file,
            commands::get_conversations,
            commands::save_conversations,
            commands::save_chat_image,
            commands::save_image_as,
            commands::chat_generate_image,
            commands::chat_edit_image,
            commands::fetch_releases,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
