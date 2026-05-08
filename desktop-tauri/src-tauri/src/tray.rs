//! System tray — Codex-style menu with dynamic recent chats.
//!
//! The menu is rebuilt whenever the frontend pushes a new list of recents
//! via the `update_tray_recents` command. Item IDs of the form `recent:<id>`
//! route to the corresponding chat; everything else is a well-known static ID.

use serde::Deserialize;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

const TRAY_ID: &str = "main-tray";
const RECENT_PREFIX: &str = "recent:";
const MAX_TITLE_CHARS: usize = 48;

#[derive(Debug, Clone, Deserialize)]
pub struct TrayRecent {
    pub id: String,
    pub title: Option<String>,
}

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let tray_icon = Image::from_bytes(include_bytes!("../icons/tray-template@2x.png"))?;

    let menu = build_menu(app, &[])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_icon)
        .tooltip("OpenYak")
        .menu(&menu)
        .icon_as_template(true)
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

/// Rebuild the tray menu with the given recent-chats list.
pub fn set_tray_recents(app: &AppHandle, recents: &[TrayRecent]) -> tauri::Result<()> {
    let menu = build_menu(app, recents)?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

fn build_menu(app: &AppHandle, recents: &[TrayRecent]) -> tauri::Result<Menu<tauri::Wry>> {
    let new_chat = MenuItem::with_id(app, "new_chat", "New Chat", true, None::<&str>)?;
    let search_chats =
        MenuItem::with_id(app, "search_chats", "Search Chats…", true, None::<&str>)?;

    let recent_submenu = build_recent_submenu(app, recents)?;

    let show_window =
        MenuItem::with_id(app, "show_window", "Open OpenYak", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let check_updates = MenuItem::with_id(
        app,
        "check_updates",
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit OpenYak", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[
            &new_chat,
            &search_chats,
            &PredefinedMenuItem::separator(app)?,
            &recent_submenu,
            &PredefinedMenuItem::separator(app)?,
            &show_window,
            &settings,
            &check_updates,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}

fn build_recent_submenu(
    app: &AppHandle,
    recents: &[TrayRecent],
) -> tauri::Result<Submenu<tauri::Wry>> {
    if recents.is_empty() {
        let empty =
            MenuItem::with_id(app, "recent_empty", "No recent chats", false, None::<&str>)?;
        return Submenu::with_items(app, "Recent Chats", true, &[&empty]);
    }

    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();
    for r in recents {
        let label = format_title(r.title.as_deref());
        let id = format!("{RECENT_PREFIX}{}", r.id);
        items.push(Box::new(MenuItem::with_id(app, id, label, true, None::<&str>)?));
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(
        app,
        "recent_show_all",
        "Show All Chats",
        true,
        None::<&str>,
    )?));

    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        items.iter().map(|b| b.as_ref()).collect();
    Submenu::with_items(app, "Recent Chats", true, &refs)
}

fn format_title(raw: Option<&str>) -> String {
    let title = raw.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("Untitled chat");
    if title.chars().count() <= MAX_TITLE_CHARS {
        return title.to_string();
    }
    let truncated: String = title.chars().take(MAX_TITLE_CHARS).collect();
    format!("{truncated}…")
}

fn handle_menu_event(app: &AppHandle, event_id: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let show_and_focus = || {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    };

    if let Some(session_id) = event_id.strip_prefix(RECENT_PREFIX) {
        show_and_focus();
        let _ = window.emit("navigate", format!("/c/{session_id}"));
        return;
    }

    match event_id {
        "new_chat" => {
            show_and_focus();
            let _ = window.emit("navigate", "/c/new");
        }
        "search_chats" => {
            show_and_focus();
            let _ = window.emit("open-search", ());
        }
        "recent_show_all" | "show_window" => {
            show_and_focus();
        }
        "settings" => {
            show_and_focus();
            let _ = window.emit("navigate", "/settings");
        }
        "check_updates" => {
            show_and_focus();
            let _ = window.emit("check-for-updates", ());
        }
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}
