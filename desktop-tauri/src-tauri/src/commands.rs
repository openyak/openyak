//! Tauri command handlers — the IPC bridge between frontend and Rust.

use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use crate::{backend::BackendState, PendingNavigationState};

/// Get the backend URL (http://127.0.0.1:{port}).
#[tauri::command]
pub async fn get_backend_url(state: tauri::State<'_, BackendState>) -> Result<String, String> {
    Ok(state.url().await)
}

#[tauri::command]
pub async fn get_pending_navigation(
    state: tauri::State<'_, PendingNavigationState>,
) -> Result<Option<String>, String> {
    Ok(state.take().await)
}

/// Minimize the window.
#[tauri::command]
pub fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

/// Toggle maximize/unmaximize.
#[tauri::command]
pub fn window_maximize(window: WebviewWindow) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

/// Close the window (hides to tray on Windows/Linux).
#[tauri::command]
pub fn window_close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

/// Check if window is maximized.
#[tauri::command]
pub fn is_maximized(window: WebviewWindow) -> Result<bool, String> {
    window.is_maximized().map_err(|e| e.to_string())
}

/// Get the current platform.
#[tauri::command]
pub fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

/// Open a URL in the system default browser.
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Save a file via a native save dialog.
///
/// Accepts either a `url` (fetched via GET) or raw `data` bytes.
/// WebView2 does not support blob-URL downloads triggered by `<a>.click()`,
/// so we handle file exports through Tauri IPC instead.
#[tauri::command]
pub async fn download_and_save(
    app: AppHandle,
    url: Option<String>,
    data: Option<Vec<u8>>,
    default_name: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;

    // Derive filter label + extension from the default filename
    let ext = default_name
        .rsplit('.')
        .next()
        .unwrap_or("*")
        .to_string();
    let label = ext.to_uppercase();

    // Show native save dialog
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter(&label, &[&ext])
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    let file_path = rx.await.map_err(|e| format!("Dialog error: {e}"))?;
    let path = match file_path {
        Some(p) => p,
        None => return Ok(false), // User cancelled
    };

    let real_path = path
        .as_path()
        .ok_or_else(|| "Invalid save path".to_string())?;

    // Get bytes: from provided data or by downloading from URL
    let bytes = if let Some(raw) = data {
        raw
    } else if let Some(download_url) = url {
        let response = reqwest::get(&download_url)
            .await
            .map_err(|e| format!("Download failed: {e}"))?;
        response
            .bytes()
            .await
            .map_err(|e| format!("Failed to read response: {e}"))?
            .to_vec()
    } else {
        return Err("Either 'url' or 'data' must be provided".into());
    };

    tokio::fs::write(real_path, &bytes)
        .await
        .map_err(|e| format!("Failed to write file: {e}"))?;

    Ok(true)
}
