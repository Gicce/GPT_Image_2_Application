mod commands;
mod models;
mod storage;
mod task_runner;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Spawn a background task runner
            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
                rt.block_on(async {
                    let mut interval = tokio::time::interval(tokio::time::Duration::from_millis(500));
                    loop {
                        interval.tick().await;
                        task_runner::process_next_task(&app_handle).await;
                    }
                });
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::get_tasks,
            commands::create_task,
            commands::cancel_task,
            commands::get_images,
            commands::delete_image,
            commands::read_image_data,
            commands::open_file,
            commands::open_folder,
            commands::select_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
