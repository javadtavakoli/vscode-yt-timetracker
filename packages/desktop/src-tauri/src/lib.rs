use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;

/// Sets the inline title text on macOS (visible in the menu bar) and the
/// tooltip on Windows/Linux (visible on hover). The renderer calls this every
/// second while a timer runs.
#[tauri::command]
fn set_tray_text(app: AppHandle, text: String) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_title(Some(text.clone()));
        let _ = tray.set_tooltip(Some(text));
    }
    Ok(())
}

/// Opens (or focuses) the main window so the user can hit the Preferences UI
/// inside the React panel. Once we have a dedicated Preferences window we
/// will open that instead.
#[tauri::command]
fn open_preferences(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        // Renderer can listen for this and switch its view to Preferences.
        let _ = app.emit("open-preferences", ());
    }
    Ok(())
}

/// Opt-in autostart toggle, surfaced from the Preferences UI.
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())?;
    } else {
        manager.disable().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn is_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        // Second `tauri-app` launch focuses the running instance instead of
        // spawning a duplicate.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(|app| {
            // Tray with a small "Open" / "Quit" menu plus the live title that
            // gets updated by the renderer via `set_tray_text`.
            let open_item = MenuItem::with_id(app, "open", "Open Ylate", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or_else(|| -> Box<dyn std::error::Error> {
                    "missing default window icon".into()
                })?;

            TrayIconBuilder::with_id("main")
                .icon(icon)
                .title("Ylate")
                .tooltip("Ylate")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            let visible = win.is_visible().unwrap_or(false);
                            if visible {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Window-close button hides the window instead of quitting the
            // process — the timer needs to keep ticking in the tray.
            if let Some(main) = app.get_webview_window("main") {
                let win = main.clone();
                main.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let _ = win.hide();
                        api.prevent_close();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_tray_text,
            open_preferences,
            set_autostart,
            is_autostart_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ylate desktop");
}

