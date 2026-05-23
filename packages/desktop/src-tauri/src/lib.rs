use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;

/// Sets the inline title text on macOS (visible in the menu bar), the
/// tooltip on Windows/Linux (visible on hover), AND the main window title
/// (visible in the OS taskbar / window switcher / GNOME activity overview).
/// The renderer calls this every second while a timer runs.
///
/// The window-title path is the only one that actually puts the running
/// timer in a *visible* place on Linux without hovering — most Linux trays
/// (and especially GNOME's AppIndicator fallback) don't display the inline
/// title text, so the taskbar entry is our best surface there.
#[tauri::command]
fn set_tray_text(app: AppHandle, text: String) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_title(Some(text.clone()));
        let _ = tray.set_tooltip(Some(text.clone()));
    }
    if let Some(win) = app.get_webview_window("main") {
        let title = if text == "Ylate" {
            "Ylate".to_string()
        } else {
            format!("Ylate — {}", text)
        };
        let _ = win.set_title(&title);
    }
    Ok(())
}

/// Brings the main window forward and tells the renderer to switch to its
/// Preferences view. Invoked from the tray menu and from `Open Preferences`
/// IPC.
#[tauri::command]
fn open_preferences(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
    let _ = app.emit("show-preferences", ());
    Ok(())
}

/* ─────────────────── OS-native token storage (keyring) ──────────────────── */

const KEYRING_SERVICE: &str = "com.javadtavakoli.ylate";
const KEYRING_USER: &str = "youtrack-token";

#[tauri::command]
fn get_token() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn set_token(token: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| e.to_string())?;
    entry.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_token() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
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
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(|app| {
            // Tray with a small "Open" / "Quit" menu plus the live title that
            // gets updated by the renderer via `set_tray_text`.
            let open_item = MenuItem::with_id(app, "open", "Open Ylate", true, None::<&str>)?;
            let prefs_item = MenuItem::with_id(app, "preferences", "Preferences…", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &prefs_item, &quit_item])?;

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
                    "preferences" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                        let _ = app.emit("show-preferences", ());
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
            is_autostart_enabled,
            get_token,
            set_token,
            delete_token
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ylate desktop");
}

