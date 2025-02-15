#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_notification::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      #[cfg(desktop)]
      {
        // use tauri::Manager;
        use tauri::Emitter;
        use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};

        app.handle().plugin(
          tauri_plugin_global_shortcut::Builder::new()
            .with_shortcuts(["ctrl+d", "alt+space"])?
            .with_handler(|app, shortcut, event| {
              if event.state == ShortcutState::Pressed  {
                if shortcut.matches(Modifiers::CONTROL, Code::KeyD) {
                  let _ = app.emit("shortcut-event", "Ctrl+D triggered");
                }
                if shortcut.matches(Modifiers::ALT, Code::Space) {
                  let _ = app.emit("shortcut-event", "Alt+Space triggered");
                }
              }
            })
            .build(),
        )?;
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
