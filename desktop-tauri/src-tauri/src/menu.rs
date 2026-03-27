//! Native application menu — File, Edit, View, Window, Help.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager,
};

pub fn create_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // File menu
    let new_chat = MenuItem::with_id(app, "menu_new_chat", "New Chat", true, Some("CmdOrCtrl+N"))?;
    let settings =
        MenuItem::with_id(app, "menu_settings", "Settings", true, Some("CmdOrCtrl+,"))?;
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_chat,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Quit"))?,
        ],
    )?;

    // Edit menu
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // View menu
    let toggle_sidebar = MenuItem::with_id(
        app,
        "menu_toggle_sidebar",
        "Toggle Sidebar",
        true,
        Some("CmdOrCtrl+Shift+S"),
    )?;
    let reload = MenuItem::with_id(app, "menu_reload", "Reload", true, Some("CmdOrCtrl+R"))?;
    let dev_tools = MenuItem::with_id(
        app,
        "menu_dev_tools",
        "Developer Tools",
        true,
        Some("CmdOrCtrl+Shift+I"),
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &toggle_sidebar,
            &PredefinedMenuItem::separator(app)?,
            &reload,
            &dev_tools,
        ],
    )?;

    // Window menu
    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let zoom = PredefinedMenuItem::maximize(app, None)?;
    let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &minimize,
            &zoom,
            &PredefinedMenuItem::separator(app)?,
            &fullscreen,
        ],
    )?;

    // Help menu
    let check_updates = MenuItem::with_id(
        app,
        "menu_check_updates",
        "Check for Updates...",
        true,
        None::<&str>,
    )?;
    let about = PredefinedMenuItem::about(app, Some("About OpenYak"), None)?;
    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &check_updates,
            &PredefinedMenuItem::separator(app)?,
            &about,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[&file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )?;

    Ok(menu)
}

/// Handle menu events.
pub fn handle_menu_event(app: &AppHandle, event_id: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    match event_id {
        "menu_new_chat" => {
            let _ = window.emit("navigate", "/c/new");
        }
        "menu_settings" => {
            let _ = window.emit("navigate", "/settings");
        }
        "menu_toggle_sidebar" => {
            let _ = window.emit("toggle-sidebar", ());
        }
        "menu_reload" => {
            let _ = window.eval("window.location.reload()");
        }
        "menu_dev_tools" => {
            if window.is_devtools_open() {
                window.close_devtools();
            } else {
                window.open_devtools();
            }
        }
        "menu_check_updates" => {
            let _ = window.emit("check-for-updates", ());
        }
        _ => {}
    }
}
