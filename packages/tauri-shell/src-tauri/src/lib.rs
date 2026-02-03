mod passkey;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            passkey::is_passkey_available,
            passkey::create_passkey,
            passkey::get_passkey,
            passkey::get_passkey_assertion,
        ])
        .setup(|app| {
            #[cfg(mobile)]
            {
                app.handle().plugin(tauri_plugin_deep_link::init())?;
            }

            // Initialize passkey support
            passkey::init(app.handle().clone())?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
