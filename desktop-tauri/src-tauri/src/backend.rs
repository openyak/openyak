//! Python backend lifecycle manager.
//!
//! Spawns the FastAPI backend as a child process, health-checks it,
//! and gracefully shuts it down on app exit. Includes watchdog for
//! detecting hung processes and auto-restart with exponential backoff.

use std::process::Stdio;
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use log::{error, info, warn};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::sleep;

/// Watchdog polling interval.
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(10);
/// How long to poll for the backend's session_token.json after /livez passes.
/// The backend writes the token before it starts the HTTP server, but we
/// read it in a separate step so we tolerate a short race window.
const TOKEN_MAX_WAIT: Duration = Duration::from_secs(5);
/// Interval between retries while waiting for the token file to appear.
const TOKEN_POLL_INTERVAL: Duration = Duration::from_millis(100);
/// Consecutive health failures before watchdog triggers a restart.
const WATCHDOG_MAX_FAILURES: u32 = 3;
/// Maximum time to wait for health endpoint during startup.
const HEALTH_MAX_RETRIES: u32 = 60;
/// Interval between health check retries during startup.
const HEALTH_RETRY_INTERVAL: Duration = Duration::from_millis(500);
/// Timeout for graceful shutdown before force-killing.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(12);
/// Maximum auto-restart attempts within the crash window.
const MAX_CRASH_RESTARTS: u32 = 3;
/// Reset crash count after this many ms of stability.
const CRASH_WINDOW_MS: u64 = 60_000;

/// Windows CREATE_NEW_PROCESS_GROUP flag.
#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Shared backend state managed by Tauri.
pub struct BackendState {
    inner: Arc<Mutex<BackendInner>>,
}

struct BackendInner {
    port: u16,
    process: Option<Child>,
    intentional_stop: bool,
    watchdog_running: bool,
    restarting: bool,
    crash_count: u32,
    last_crash_time: u64,
    /// Session bearer token loaded from the backend's session_token.json.
    /// Cleared on restart and repopulated from disk after the new backend
    /// passes its health check — never sent over the wire by the backend,
    /// only written to a 0600 file we read directly.
    session_token: Option<String>,
    /// Data directory the backend writes its session token into. Set at
    /// spawn (prod) or via set_dev_data_dir (dev) so token refresh after
    /// an auto-restart uses the same path.
    data_dir: Option<PathBuf>,
}

impl BackendState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(BackendInner {
                port: 0,
                process: None,
                intentional_stop: false,
                watchdog_running: false,
                restarting: false,
                crash_count: 0,
                last_crash_time: 0,
                session_token: None,
                data_dir: None,
            })),
        }
    }

    /// Returns the backend URL (http://127.0.0.1:{port}).
    pub async fn url(&self) -> String {
        let inner = self.inner.lock().await;
        format!("http://127.0.0.1:{}", inner.port)
    }

    /// Set port for dev mode (backend already running externally).
    pub async fn set_dev_port(&self, port: u16) {
        let mut inner = self.inner.lock().await;
        inner.port = port;
    }

    /// Set the backend data directory in dev mode and load its session
    /// token. In dev the backend is started externally by `dev-desktop.mjs`
    /// so there is no spawn to hook into; we poll the well-known token
    /// path instead. Returns the token on success.
    pub async fn set_dev_data_dir(&self, data_dir: PathBuf) -> Result<String, String> {
        {
            let mut inner = self.inner.lock().await;
            inner.data_dir = Some(data_dir.clone());
        }
        let token = load_session_token(&data_dir).await?;
        let mut inner = self.inner.lock().await;
        inner.session_token = Some(token.clone());
        Ok(token)
    }

    /// Returns the backend session bearer token, or an error if the
    /// backend has not yet written it. The frontend calls this through
    /// the `get_backend_token` Tauri command and attaches the value to
    /// every HTTP request.
    pub async fn token(&self) -> Result<String, String> {
        let inner = self.inner.lock().await;
        inner
            .session_token
            .clone()
            .ok_or_else(|| "Backend session token not yet available".to_string())
    }

    /// Start the Python backend process.
    pub async fn start(&self, app: &AppHandle) -> Result<String, String> {
        let mut inner = self.inner.lock().await;

        // Port selection: reuse previous port if available, otherwise pick a new one.
        // This avoids stale-URL windows on restart — the frontend already has the right URL cached.
        let previous_port = inner.port;
        let port = if previous_port > 0 && portpicker::is_free(previous_port) {
            previous_port
        } else {
            portpicker::pick_unused_port().ok_or("No available port")?
        };

        inner.port = port;
        inner.intentional_stop = false;

        // Determine binary path and data directory
        let is_dev = cfg!(debug_assertions);

        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data dir: {e}"))?
            .join("data");

        // Ensure data directory exists
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create data dir: {e}"))?;

        // Set up log file
        let log_dir = app
            .path()
            .app_log_dir()
            .map_err(|e| format!("Failed to get log dir: {e}"))?;
        std::fs::create_dir_all(&log_dir)
            .map_err(|e| format!("Failed to create log dir: {e}"))?;
        let log_path = log_dir.join("backend.log");
        let desktop_log_path = log_dir.join("desktop.log");
        write_desktop_log(
            &desktop_log_path,
            &format!(
                "Starting desktop backend | app_version={} | data_dir={} | log_dir={}",
                app.package_info().version,
                data_dir.display(),
                log_dir.display()
            ),
        );

        let mut child = if is_dev {
            // Development: use system Python
            let backend_dir = std::env::current_dir()
                .map_err(|e| format!("Failed to get cwd: {e}"))?
                .parent()
                .ok_or("No parent dir")?
                .join("backend");

            info!(
                "Starting backend (dev) at {}:{}",
                backend_dir.display(),
                port
            );
            write_desktop_log(
                &desktop_log_path,
                &format!(
                    "Dev backend startup | backend_dir={} | port={}",
                    backend_dir.display(),
                    port
                ),
            );

            let mut cmd = Command::new("python");
            cmd.args([
                    "-m",
                    "uvicorn",
                    "app.main:create_app",
                    "--factory",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    &port.to_string(),
                ])
                .current_dir(&backend_dir)
                .env("PYTHONUNBUFFERED", "1")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .stdin(Stdio::null());

            // Windows: isolate process group so CTRL_BREAK_EVENT doesn't leak to Tauri
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);

            cmd.spawn()
                .map_err(|e| format!("Failed to spawn backend: {e}"))?
        } else {
            // Production: use PyInstaller binary from resources
            let resource_dir = app
                .path()
                .resource_dir()
                .map_err(|e| format!("Failed to get resource dir: {e}"))?;
            let backend_binary = if cfg!(target_os = "windows") {
                "openyak-backend.exe"
            } else {
                "openyak-backend"
            };
            let backend_path = resource_dir.join("backend").join(backend_binary);
            let backend_dir = resource_dir.join("backend");

            info!("Starting backend (prod) at {}", backend_path.display());
            write_desktop_log(
                &desktop_log_path,
                &format!(
                    "Prod backend startup | resource_dir={} | backend_dir={} | backend_path={} | port={}",
                    resource_dir.display(),
                    backend_dir.display(),
                    backend_path.display(),
                    port
                ),
            );
            validate_backend_resources(&backend_dir, &backend_path, &desktop_log_path)?;

            let mut cmd = Command::new(&backend_path);
            cmd.args([
                    "--port",
                    &port.to_string(),
                    "--data-dir",
                    &data_dir.to_string_lossy(),
                    "--resource-dir",
                    &resource_dir.to_string_lossy(),
                ])
                .env("PYTHONUNBUFFERED", "1")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .stdin(Stdio::null());

            // Windows: isolate process group so CTRL_BREAK_EVENT doesn't leak to Tauri
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);

            cmd.spawn()
                .map_err(|e| format!("Failed to spawn backend: {e}"))?
        };

        // Take stdout/stderr before storing child (to avoid partial move)
        let child_stdout = child.stdout.take();
        let child_stderr = child.stderr.take();

        // Store the process
        inner.process = Some(child);

        drop(inner); // Release lock before waiting for health

        // Pipe output to log file in background
        if let Some(stdout) = child_stdout {
            let log_path_clone = log_path.clone();
            tokio::spawn(async move {
                let reader = BufReader::new(stdout);
                let mut lines = reader.lines();
                let file = tokio::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&log_path_clone)
                    .await;
                if let Ok(mut file) = file {
                    while let Ok(Some(line)) = lines.next_line().await {
                        let _ = file.write_all(format!("{line}\n").as_bytes()).await;
                    }
                }
            });
        }
        if let Some(stderr) = child_stderr {
            let log_path_clone = log_path.clone();
            tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                let file = tokio::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&log_path_clone)
                    .await;
                if let Ok(mut file) = file {
                    while let Ok(Some(line)) = lines.next_line().await {
                        let _ = file
                            .write_all(format!("[stderr] {line}\n").as_bytes())
                            .await;
                    }
                }
            });
        }

        // Wait for backend health check (use lightweight /livez endpoint)
        self.wait_for_health(port, &log_path, &desktop_log_path).await?;

        // Load the session token the backend wrote on startup. Every
        // authenticated request from the frontend carries it as a
        // bearer; without it the backend rejects us. We poll briefly
        // to tolerate the race where /livez is up before the token
        // file has been flushed.
        let token_data_dir = data_dir.clone();
        let token = load_session_token(&token_data_dir).await.map_err(|e| {
            let msg = format!("Session token unavailable: {e}");
            write_desktop_log(&desktop_log_path, &msg);
            msg
        })?;

        // Reset crash count on successful healthy start; cache token and
        // data_dir so a later restart can refresh the token from disk.
        {
            let mut inner = self.inner.lock().await;
            inner.crash_count = 0;
            inner.session_token = Some(token);
            inner.data_dir = Some(token_data_dir);
        }

        // Start watchdog
        self.start_watchdog(app.clone());

        // Start process exit monitor — detects crashes faster than the watchdog
        self.start_exit_monitor(app.clone());

        let url = format!("http://127.0.0.1:{port}");
        info!("Backend ready at {url}");
        write_desktop_log(&desktop_log_path, &format!("Backend ready at {url}"));
        Ok(url)
    }

    /// Wait for the backend /livez endpoint to respond.
    async fn wait_for_health(
        &self,
        port: u16,
        backend_log_path: &Path,
        desktop_log_path: &Path,
    ) -> Result<(), String> {
        let url = format!("http://127.0.0.1:{port}/livez");
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

        for i in 0..HEALTH_MAX_RETRIES {
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    info!(
                        "Backend health check passed (attempt {}/{})",
                        i + 1,
                        HEALTH_MAX_RETRIES
                    );
                    write_desktop_log(
                        desktop_log_path,
                        &format!(
                            "Backend health check passed | attempt={}/{} | url={}",
                            i + 1,
                            HEALTH_MAX_RETRIES,
                            url
                        ),
                    );
                    return Ok(());
                }
                _ => {}
            }

            // Check if process is still alive
            let inner = self.inner.lock().await;
            if inner.process.is_none() {
                return Err("Backend process exited before becoming ready".into());
            }
            drop(inner);

            sleep(HEALTH_RETRY_INTERVAL).await;
        }

        let recent_backend_log = read_recent_log_lines(backend_log_path, 20);
        let msg = format!(
            "Backend did not become ready after {}ms. Recent backend log:\n{}",
            HEALTH_MAX_RETRIES as u64 * HEALTH_RETRY_INTERVAL.as_millis() as u64,
            recent_backend_log
        );
        write_desktop_log(desktop_log_path, &msg);
        Err(msg)
    }

    /// Start the watchdog that monitors backend health.
    fn start_watchdog(&self, app: AppHandle) {
        let inner = self.inner.clone();

        tokio::spawn(async move {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap();

            let mut consecutive_failures: u32 = 0;

            {
                let mut guard = inner.lock().await;
                guard.watchdog_running = true;
            }

            loop {
                sleep(WATCHDOG_INTERVAL).await;

                let guard = inner.lock().await;
                if guard.intentional_stop || guard.process.is_none() {
                    break;
                }
                let port = guard.port;
                drop(guard);

                // Use lightweight /livez endpoint — no external API calls
                let url = format!("http://127.0.0.1:{port}/livez");
                match client.get(&url).send().await {
                    Ok(resp) if resp.status().is_success() => {
                        consecutive_failures = 0;
                    }
                    _ => {
                        consecutive_failures += 1;
                        warn!(
                            "Watchdog: health check failed ({}/{})",
                            consecutive_failures, WATCHDOG_MAX_FAILURES
                        );

                        if consecutive_failures >= WATCHDOG_MAX_FAILURES {
                            error!("Watchdog: backend unresponsive, forcing restart");

                            // Kill the hung process
                            let mut guard = inner.lock().await;
                            if let Some(ref mut child) = guard.process {
                                let _ = kill_process_tree(child).await;
                                guard.process = None;
                            }
                            guard.watchdog_running = false;
                            drop(guard);

                            // Attempt auto-restart
                            let state = app.state::<BackendState>();
                            attempt_restart(&state, &app).await;
                            break;
                        }
                    }
                }
            }

            let mut guard = inner.lock().await;
            guard.watchdog_running = false;
        });
    }

    /// Monitor the child process for unexpected exits.
    /// Detects crashes immediately instead of waiting for watchdog polling.
    fn start_exit_monitor(&self, app: AppHandle) {
        let inner = self.inner.clone();

        tokio::spawn(async move {
            // We need to call child.wait() but the child is behind a Mutex.
            // Poll periodically using try_wait semantics by checking child.id().
            loop {
                sleep(Duration::from_secs(2)).await;

                let mut guard = inner.lock().await;
                if guard.intentional_stop {
                    break;
                }

                let process_gone = match guard.process {
                    Some(ref mut child) => {
                        // try_wait: check if process exited without blocking
                        match child.try_wait() {
                            Ok(Some(status)) => {
                                warn!("Exit monitor: backend exited with status {status}");
                                true
                            }
                            Ok(None) => false, // still running
                            Err(_) => true,    // can't query — treat as dead
                        }
                    }
                    None => break, // no process to monitor
                };

                if process_gone {
                    guard.process = None;
                    drop(guard);

                    // Attempt auto-restart
                    let state = app.state::<BackendState>();
                    attempt_restart(&state, &app).await;
                    break;
                }
            }
        });
    }

    /// Stop the backend process gracefully.
    pub async fn stop(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        inner.intentional_stop = true;
        inner.restarting = false;

        if inner.process.is_none() {
            return Ok(());
        }

        let port = inner.port;
        // Clone the token while we hold the lock so the HTTP shutdown
        // below can authenticate. Without a bearer token the backend
        // rejects /shutdown exactly like any other mutating request.
        let token = inner.session_token.clone();

        info!("Stopping backend (port={port})...");

        // Step 1: Try HTTP graceful shutdown (release lock first to avoid holding it during I/O)
        drop(inner);

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap_or_default();

        let shutdown_url = format!("http://127.0.0.1:{port}/shutdown");
        let mut req = client.post(&shutdown_url);
        if let Some(t) = token.as_deref() {
            req = req.bearer_auth(t);
        }
        match req.send().await {
            Ok(resp) if resp.status().is_success() => {
                info!("Shutdown request accepted");
            }
            Ok(resp) => {
                warn!(
                    "Shutdown request rejected (status={}), will force kill",
                    resp.status()
                );
            }
            Err(_) => {
                warn!("HTTP shutdown failed, will force kill");
            }
        }

        // Step 2: Wait for process to exit
        let mut inner = self.inner.lock().await;
        if let Some(ref mut child) = inner.process {
            let wait_result = tokio::time::timeout(SHUTDOWN_TIMEOUT, child.wait()).await;

            match wait_result {
                Ok(Ok(status)) => {
                    info!("Backend exited with status: {status}");
                }
                _ => {
                    // Step 3: Force kill
                    warn!("Backend did not exit gracefully, force killing...");
                    let _ = kill_process_tree(child).await;
                }
            }
        }

        inner.process = None;
        Ok(())
    }

}

/// Emit recent backend.log lines to the frontend for crash diagnosis.
fn emit_crash_log(app: &AppHandle) {
    let log_dir = match app.path().app_log_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    let log_path = log_dir.join("backend.log");
    let recent = read_recent_log_lines(&log_path, 50);
    if !recent.starts_with('<') {
        // Only emit if there's actual content (not "<backend log empty>")
        let _ = app.emit("backend-crash-log", &recent);
    }
}

/// Attempt to restart the backend with exponential backoff.
/// Emits `backend-restart` on success or `backend-crash` on final failure.
async fn attempt_restart(state: &BackendState, app: &AppHandle) {
    // Emit crash log to frontend BEFORE restarting (so devs can see why it died)
    emit_crash_log(app);

    let should_restart = {
        let mut inner = state.inner.lock().await;
        if inner.intentional_stop || inner.restarting {
            return; // Another restart already in progress, or intentional stop
        }

        let now = epoch_ms();
        // Reset crash counter if stable for a while
        if now - inner.last_crash_time > CRASH_WINDOW_MS {
            inner.crash_count = 0;
        }
        inner.crash_count += 1;
        inner.last_crash_time = now;
        inner.restarting = true;

        inner.crash_count <= MAX_CRASH_RESTARTS
    };

    if !should_restart {
        let mut inner = state.inner.lock().await;
        let msg = format!(
            "Backend crashed {} times in {}s, giving up",
            inner.crash_count,
            CRASH_WINDOW_MS / 1000
        );
        inner.restarting = false;
        drop(inner);
        error!("{msg}");
        let _ = app.emit("backend-crash", &msg);
        return;
    }

    let crash_count = {
        let inner = state.inner.lock().await;
        inner.crash_count
    };

    // Exponential backoff: 1s, 2s, 4s (capped)
    let delay_ms = std::cmp::min(1000 * 2u64.pow(crash_count - 1), 4000);
    info!(
        "Backend crashed (attempt {}/{}), restarting in {}ms...",
        crash_count, MAX_CRASH_RESTARTS, delay_ms
    );
    sleep(Duration::from_millis(delay_ms)).await;

    // Check if intentional stop was requested during the delay
    {
        let inner = state.inner.lock().await;
        if inner.intentional_stop {
            // restarting flag cleared by stop()
            return;
        }
    }

    // Tell frontend to pause SSE reconnection until backend is ready
    let _ = app.emit("backend-restarting", ());

    // Clear restarting flag before start() — start() will spawn new monitors
    {
        let mut inner = state.inner.lock().await;
        inner.restarting = false;
    }

    match state.start(app).await {
        Ok(url) => {
            info!("Backend restarted successfully at {url}");
            // Notify frontend of new backend URL (matches the event the frontend listens for)
            let _ = app.emit("backend-restart", &url);
        }
        Err(err) => {
            error!("Backend restart failed: {err}");
            let _ = app.emit("backend-crash", &format!("Backend restart failed: {err}"));
        }
    }
}

fn validate_backend_resources(
    backend_dir: &Path,
    backend_path: &Path,
    desktop_log_path: &Path,
) -> Result<(), String> {
    if !backend_dir.exists() {
        let msg = format!("Packaged backend directory is missing: {}", backend_dir.display());
        write_desktop_log(desktop_log_path, &msg);
        return Err(msg);
    }

    if !backend_path.exists() {
        let msg = format!("Packaged backend executable is missing: {}", backend_path.display());
        write_desktop_log(desktop_log_path, &msg);
        return Err(msg);
    }

    #[cfg(target_os = "windows")]
    {
        let python_dll = backend_dir.join("_internal").join("python312.dll");
        if !python_dll.exists() {
            let msg = format!(
                "Packaged Python runtime is missing: {}",
                python_dll.display()
            );
            write_desktop_log(desktop_log_path, &msg);
            return Err(msg);
        }
    }

    // Node.js runtime (optional — used by OpenClaw channels)
    let nodejs_dir = backend_dir.parent().unwrap_or(backend_dir).join("nodejs");
    let node_binary = if cfg!(target_os = "windows") {
        nodejs_dir.join("node.exe")
    } else {
        nodejs_dir.join("bin").join("node")
    };
    if nodejs_dir.exists() && !node_binary.exists() {
        write_desktop_log(
            desktop_log_path,
            &format!(
                "WARNING: nodejs directory exists but node binary missing: {}",
                node_binary.display()
            ),
        );
    }

    write_desktop_log(
        desktop_log_path,
        &format!(
            "Validated packaged backend resources | backend_dir={} | backend_path={} | nodejs={}",
            backend_dir.display(),
            backend_path.display(),
            node_binary.exists()
        ),
    );
    Ok(())
}

fn write_desktop_log(log_path: &Path, message: &str) {
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "{message}");
    }
}

/// Poll the backend's session token file until it appears or we time out.
///
/// The backend writes `session_token.json` at startup with mode 0600. We
/// read it directly rather than trusting any HTTP field, so a tampered
/// backend on the same host — or a malicious process masquerading on the
/// same port — cannot inject an attacker-chosen token: the reader's own
/// UID is what gates access via filesystem permissions.
async fn load_session_token(data_dir: &Path) -> Result<String, String> {
    let token_path = data_dir.join("session_token.json");
    let deadline = std::time::Instant::now() + TOKEN_MAX_WAIT;

    loop {
        match tokio::fs::read_to_string(&token_path).await {
            Ok(raw) => {
                // Minimal JSON parse: we expect `{"token": "openyak_st_..."}`.
                // Bringing in serde_json here would be overkill for a two-field
                // file we control the format of, so we extract the string
                // value directly.
                if let Some(token) = extract_token_field(&raw) {
                    return Ok(token);
                }
                return Err(format!(
                    "session_token.json at {} is malformed",
                    token_path.display()
                ));
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                if std::time::Instant::now() >= deadline {
                    return Err(format!(
                        "Timed out waiting for {} (backend did not write session token)",
                        token_path.display()
                    ));
                }
                sleep(TOKEN_POLL_INTERVAL).await;
            }
            Err(err) => {
                return Err(format!(
                    "Cannot read {}: {}",
                    token_path.display(),
                    err
                ));
            }
        }
    }
}

/// Extract the `"token"` field from `{"token": "..."}` without pulling in
/// a full JSON parser. The file is written by our own backend so the
/// format is fixed; we only need to tolerate whitespace variations.
fn extract_token_field(raw: &str) -> Option<String> {
    let key = "\"token\"";
    let start = raw.find(key)?;
    // Advance past the key, any whitespace, and the colon.
    let after_key = raw[start + key.len()..].trim_start();
    let after_colon = after_key.strip_prefix(':')?.trim_start();
    let rest = after_colon.strip_prefix('"')?;
    let end = rest.find('"')?;
    let value = &rest[..end];
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn read_recent_log_lines(path: &Path, max_lines: usize) -> String {
    match std::fs::read_to_string(path) {
        Ok(content) => {
            let lines: Vec<&str> = content.lines().rev().take(max_lines).collect();
            if lines.is_empty() {
                "<backend log empty>".to_string()
            } else {
                lines.into_iter().rev().collect::<Vec<_>>().join("\n")
            }
        }
        Err(_) => "<backend log unavailable>".to_string(),
    }
}

/// Kill a process and its entire tree (important on Windows).
async fn kill_process_tree(child: &mut Child) -> Result<(), String> {
    if cfg!(target_os = "windows") {
        if let Some(pid) = child.id() {
            let output = tokio::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output()
                .await;
            match output {
                Ok(o) if o.status.success() => {
                    info!("taskkill succeeded for pid {pid}");
                }
                Ok(o) => {
                    let stderr = String::from_utf8_lossy(&o.stderr);
                    warn!("taskkill for pid {pid}: {stderr}");
                }
                Err(e) => {
                    warn!("taskkill failed: {e}");
                }
            }
        }
    }

    // Fallback: direct kill
    let _ = child.kill().await;
    Ok(())
}
