//! OpenYak Desktop — Tauri 2.0 application entry point.
//!
//! Registers plugins, sets up the backend sidecar, tray, menu,
//! and all IPC command handlers.

mod backend;
mod commands;
mod menu;
mod tray;

use backend::BackendState;
use log::{error, info};
use tokio::sync::Mutex;
use tauri::{Emitter, Manager};
#[cfg(target_os = "macos")]
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

pub struct PendingNavigationState(Mutex<Option<String>>);

impl PendingNavigationState {
    fn new() -> Self {
        Self(Mutex::new(None))
    }

    async fn set(&self, value: Option<String>) {
        *self.0.lock().await = value;
    }

    async fn take(&self) -> Option<String> {
        self.0.lock().await.take()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let backend_state = BackendState::new();
    let pending_navigation = PendingNavigationState::new();

    tauri::Builder::default()
        // -- Plugins --
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus existing window when a second instance is launched
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                if window.is_minimized().unwrap_or(false) {
                    let _ = window.unminimize();
                }
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        .difference(tauri_plugin_window_state::StateFlags::MAXIMIZED)
                        .difference(tauri_plugin_window_state::StateFlags::FULLSCREEN),
                )
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // -- Managed state --
        .manage(backend_state)
        .manage(pending_navigation)
        // -- Commands --
        .invoke_handler(tauri::generate_handler![
            commands::get_backend_url,
            commands::get_pending_navigation,
            commands::window_minimize,
            commands::window_maximize,
            commands::window_close,
            commands::is_maximized,
            commands::get_platform,
            commands::open_external,
            commands::download_and_save,
        ])
        // -- Setup --
        .setup(|app| {
            let handle = app.handle().clone();

            #[cfg(target_os = "macos")]
            {
                // macOS: enable native traffic lights with overlay title bar.
                // Config has decorations=false for Windows/Linux, so we override here.
                if let Some(window) = app.get_webview_window("main") {
                    use tauri::TitleBarStyle;
                    let _ = window.set_decorations(true);
                    let _ = window.set_title_bar_style(TitleBarStyle::Overlay);
                }

                // Warn users when launching directly from mounted DMG volume.
                if is_running_from_dmg_volume(app) {
                    app.dialog()
                        .message(
                            "OpenYak is running from the DMG volume.\n\nPlease copy OpenYak.app to Applications and launch it from there.",
                        )
                        .title("Install OpenYak to Applications")
                        .kind(MessageDialogKind::Warning)
                        .blocking_show();
                }
            }

            if let Some(urls) = app.deep_link().get_current()? {
                let app_handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(route) = extract_route_from_urls(urls.iter().map(|url| url.as_str())) {
                        let pending_state = app_handle.state::<PendingNavigationState>();
                        pending_state.set(Some(route.clone())).await;
                        focus_and_emit_navigation(&app_handle, &route);
                    }
                });
            }

            let app_handle = handle.clone();
            app.deep_link().on_open_url(move |event| {
                if let Some(route) = extract_route_from_urls(event.urls().iter().map(|url| url.as_str())) {
                    let app_handle = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let pending_state = app_handle.state::<PendingNavigationState>();
                        pending_state.set(Some(route.clone())).await;
                        focus_and_emit_navigation(&app_handle, &route);
                    });
                }
            });

            // Create system tray once for background mode.
            tray::create_tray(&handle)?;

            // Create app menu
            let menu = menu::create_menu(&handle)?;
            app.set_menu(menu)?;

            // Handle menu events
            app.on_menu_event(move |app_handle, event| {
                menu::handle_menu_event(app_handle, event.id().as_ref());
            });

            // "Close to tray/dock" — hide window instead of quitting on all platforms.
            if let Some(window) = app.get_webview_window("main") {
                let win = window.clone();
                window.on_window_event(move |event| {
                    match event {
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            api.prevent_close();
                            let _ = win.hide();
                        }
                        #[cfg(not(target_os = "macos"))]
                        tauri::WindowEvent::Resized(_) => {
                            if let Ok(maximized) = win.is_maximized() {
                                let _ = win.emit("maximize-change", maximized);
                            }
                        }
                        _ => {}
                    }
                });
            }

            // Start backend
            let app_handle = handle.clone();
            if cfg!(debug_assertions) {
                // Dev mode: backend already running via `npm run dev:backend` on port 8000
                info!("Dev mode — using existing backend at http://127.0.0.1:8000");
                tauri::async_runtime::spawn(async move {
                    let state = app_handle.state::<BackendState>();
                    state.set_dev_port(8000).await;
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                    }
                });
            } else {
                // Production: spawn and manage backend process
                tauri::async_runtime::spawn(async move {
                    let state = app_handle.state::<BackendState>();
                    match state.start(&app_handle).await {
                        Ok(url) => {
                            info!("Backend started at {url}");
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.show();
                            }
                        }
                        Err(err) => {
                            error!("Failed to start backend: {err}");
                            let _ = app_handle.emit("backend-crash", &err);
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.show();
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        // -- Cleanup --
        .on_window_event(|_window, _event| {})
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::ExitRequested { .. } => {
                    // Gracefully stop backend on exit
                    let handle = app_handle.clone();
                    tauri::async_runtime::block_on(async {
                        let state = handle.state::<BackendState>();
                        if let Err(e) = state.stop().await {
                            error!("Error stopping backend: {e}");
                        }
                    });
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    // macOS: clicking Dock icon re-shows the hidden window
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                _ => {}
            }
        });
}

#[cfg(target_os = "macos")]
fn is_running_from_dmg_volume(app: &tauri::App) -> bool {
    app.path()
        .resource_dir()
        .map(|p| p.to_string_lossy().starts_with("/Volumes/"))
        .unwrap_or(false)
}

fn extract_route_from_urls<'a>(mut urls: impl Iterator<Item = &'a str>) -> Option<String> {
    urls.find_map(extract_route_from_url)
}

fn extract_route_from_url(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "openyak" {
        return None;
    }

    match url.host_str()? {
        "billing" => match url
            .query_pairs()
            .find_map(|(key, value)| (key == "checkout").then(|| value.into_owned()))
            .as_deref()
        {
            Some("success") => Some("/billing?checkout=success".to_string()),
            Some("cancel") => Some("/billing?checkout=cancel".to_string()),
            _ => Some("/billing".to_string()),
        },
        _ => None,
    }
}

fn focus_and_emit_navigation(app: &tauri::AppHandle, route: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.emit("navigate", route);
    }
}
