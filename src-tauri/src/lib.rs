//! Packetboat — Tauri entry point: app state, the command surface the frontend
//! invokes, and the wiring between them and the storage backends.

mod backend;
#[cfg(windows)]
mod toast;
mod transfer;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use backend::cloud::OpendalBackend;
use backend::ftp::{CertCapture, CertInfo, FtpBackend, FtpConfig};
use backend::local::LocalBackend;
use backend::sftp::{SftpBackend, SftpConfig};
use backend::{BackendError, BackendResult, Entry, EntryKind, StorageBackend};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;
use transfer::{Connections, TransferManager, TransferRequest};

/// A saved connection in the site manager. Passwords are not stored here — they
/// live in the OS keychain (keyed by `id`) when "save password" is enabled.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Site {
    id: String,
    name: String,
    /// "sftp" | "ftp" | "ftps"
    protocol: String,
    host: String,
    #[serde(default)]
    port: u16,
    #[serde(default)]
    username: String,
    /// How to authenticate: "normal" (save password in the keychain), "ask"
    /// (prompt each connect), "anonymous", or "1password" (resolve `op_reference`
    /// via the 1Password CLI at connect time).
    #[serde(default = "default_logon_type")]
    logon_type: String,
    /// 1Password secret reference (`op://vault/item/field`) resolved at connect
    /// time when `logon_type` is "1password". A pointer, not a secret — safe to
    /// store in the site file.
    #[serde(default)]
    op_reference: String,
    /// FTP TLS mode (plain | explicit_optional | explicit | implicit). Empty for
    /// non-FTP protocols.
    #[serde(default)]
    encryption: String,
    /// FTP data-connection mode: passive (default, NAT-friendly) or active.
    #[serde(default = "default_true")]
    passive: bool,
    /// Cloud-backend (OpenDAL) settings — non-secret config keys only (bucket,
    /// region, endpoint, …). Secret keys live in the OS keychain, like
    /// passwords. Empty for FTP/SFTP sites.
    #[serde(default)]
    config: std::collections::HashMap<String, String>,
    /// Directory to open in the local pane on connect (blank = leave as-is).
    #[serde(default)]
    local_dir: String,
    /// Directory to open in the remote pane on connect (blank = server default).
    #[serde(default)]
    remote_dir: String,
    /// Mirror local/remote navigation relative to the two directories above.
    #[serde(default)]
    sync_browsing: bool,
}

fn default_logon_type() -> String {
    "ask".to_string()
}

fn default_true() -> bool {
    true
}

/// App-wide state: every live remote connection (keyed by id — one per tab)
/// plus the transfer engine that streams between them and the local filesystem.
struct AppState {
    connections: Connections,
    next_id: AtomicU32,
    transfers: TransferManager,
}

/// Result of opening a connection: its id (the tab/connection handle) and the
/// directory to open.
#[derive(Serialize)]
struct ConnectResult {
    id: u32,
    home: String,
}

/// Register a new connection and return its handle.
async fn add_connection(
    state: &AppState,
    backend: Arc<dyn StorageBackend>,
    home: String,
) -> ConnectResult {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.connections.lock().await.insert(id, backend);
    ConnectResult { id, home }
}

/// Clone the remote backend for connection `id`, or error if it's gone.
async fn remote_backend(state: &AppState, id: u32) -> BackendResult<Arc<dyn StorageBackend>> {
    state
        .connections
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or(BackendError::NotConnected)
}

/// Replace the final segment of a POSIX path (for remote rename in place).
fn posix_with_name(path: &str, name: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) | None => format!("/{name}"),
        Some(i) => format!("{}/{}", &trimmed[..i], name),
    }
}

/// Open an SFTP connection as a new remote. Returns its id (the tab handle) and
/// the resolved login directory.
#[tauri::command]
async fn connect_sftp(
    state: State<'_, AppState>,
    config: SftpConfig,
) -> BackendResult<ConnectResult> {
    let backend = SftpBackend::connect(&config).await?;
    let home = backend
        .canonicalize(".")
        .await
        .unwrap_or_else(|_| "/".to_string());
    Ok(add_connection(&state, Arc::new(backend), home).await)
}

/// Outcome of an FTP connect: either a live connection (`id`/`home`) or, when
/// the FTPS server presents an untrusted certificate, a `certPrompt` for the
/// frontend to confirm before retrying.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FtpConnectOutcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    cert_prompt: Option<CertInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    home: Option<String>,
}

/// Open an FTP/FTPS connection as a new remote. On an untrusted FTPS cert,
/// returns `{ certPrompt }` instead of connecting, so the UI can ask the user to
/// trust it (via `trust_cert`) and retry.
#[tauri::command]
async fn connect_ftp(
    state: State<'_, AppState>,
    config: FtpConfig,
) -> BackendResult<FtpConnectOutcome> {
    let capture: CertCapture = Arc::new(std::sync::Mutex::new(None));
    match FtpBackend::connect(&config, capture.clone()).await {
        Ok((backend, home)) => {
            let result = add_connection(&state, Arc::new(backend), home).await;
            Ok(FtpConnectOutcome {
                cert_prompt: None,
                id: Some(result.id),
                home: Some(result.home),
            })
        }
        Err(e) => {
            // An untrusted cert was captured during the handshake → prompt
            // instead of surfacing a raw TLS error.
            let captured = capture.lock().ok().and_then(|mut s| s.take());
            match captured {
                Some(info) => Ok(FtpConnectOutcome {
                    cert_prompt: Some(info),
                    id: None,
                    home: None,
                }),
                None => Err(e),
            }
        }
    }
}

/// Trust an FTPS server certificate by fingerprint (after the user accepts the
/// trust prompt). The next connect to `host:port` accepts this exact cert.
#[tauri::command]
fn trust_cert(host: String, port: u16, fingerprint: String) {
    backend::ftp::trust_certificate(&host, port, &fingerprint);
}

/// Open a cloud connection (any OpenDAL service: S3, B2, WebDAV, …) as a new
/// remote. `service` is the OpenDAL scheme and `config` its key/value settings;
/// both come straight from the frontend's per-service connect form.
#[tauri::command]
async fn connect_opendal(
    state: State<'_, AppState>,
    service: String,
    config: std::collections::HashMap<String, String>,
) -> BackendResult<ConnectResult> {
    let (backend, home) = OpendalBackend::connect(&service, config).await?;
    Ok(add_connection(&state, Arc::new(backend), home).await)
}

#[tauri::command]
async fn disconnect(state: State<'_, AppState>, id: u32) -> BackendResult<()> {
    state.connections.lock().await.remove(&id);
    Ok(())
}

#[tauri::command]
async fn list_remote(
    state: State<'_, AppState>,
    id: u32,
    path: String,
) -> BackendResult<Vec<Entry>> {
    let backend = remote_backend(&state, id).await?;
    backend.list(&path).await
}

#[tauri::command]
async fn list_local(path: String) -> BackendResult<Vec<Entry>> {
    LocalBackend.list(&path).await
}

/// One node in a recursive directory walk. `rel` is the path relative to the
/// walked root (POSIX-style), used to recreate the tree on the destination.
#[derive(Serialize)]
struct TreeEntry {
    path: String,
    rel: String,
    kind: EntryKind,
    size: u64,
    modified: Option<u64>,
}

/// Recursively list everything under `path` (for folder transfers). Directories
/// are emitted before their contents so the caller can create them parent-first;
/// symlinks are skipped to avoid cycles.
#[tauri::command]
async fn list_tree(
    state: State<'_, AppState>,
    side: String,
    id: u32,
    path: String,
) -> BackendResult<Vec<TreeEntry>> {
    let backend: Arc<dyn StorageBackend> = if side == "local" {
        Arc::new(LocalBackend)
    } else {
        remote_backend(&state, id).await?
    };
    let mut out = Vec::new();
    let mut stack = vec![(path, String::new())];
    while let Some((dir, rel)) = stack.pop() {
        let entries = backend.list(&dir).await?;
        for e in entries {
            let child_rel = if rel.is_empty() {
                e.name.clone()
            } else {
                format!("{}/{}", rel, e.name)
            };
            match e.kind {
                EntryKind::Dir => {
                    out.push(TreeEntry {
                        path: e.path.clone(),
                        rel: child_rel.clone(),
                        kind: e.kind,
                        size: 0,
                        modified: None,
                    });
                    stack.push((e.path, child_rel));
                }
                EntryKind::File => out.push(TreeEntry {
                    path: e.path,
                    rel: child_rel,
                    kind: e.kind,
                    size: e.size,
                    modified: e.modified,
                }),
                EntryKind::Symlink => {}
            }
        }
    }
    Ok(out)
}

#[tauri::command]
fn local_home() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".".to_string())
}

#[tauri::command]
fn local_parent(path: String) -> Option<String> {
    std::path::Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Root nodes for the local directory tree: drive letters on Windows, `/`
/// elsewhere.
#[tauri::command]
fn local_roots() -> Vec<String> {
    #[cfg(windows)]
    {
        (b'A'..=b'Z')
            .filter_map(|c| {
                let drive = format!("{}:\\", c as char);
                std::path::Path::new(&drive).exists().then_some(drive)
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        vec!["/".to_string()]
    }
}

/// Queue a file transfer between the panes; returns the new transfer id.
/// Progress is reported asynchronously via the `transfer://update` event.
#[tauri::command]
fn enqueue_transfer(state: State<'_, AppState>, request: TransferRequest) -> u64 {
    state.transfers.enqueue(request)
}

/// Cancel a queued or in-flight transfer by id.
#[tauri::command]
fn cancel_transfer(state: State<'_, AppState>, id: u64) {
    state.transfers.cancel(id);
}

/// Set the transfer concurrency limits: overall max simultaneous transfers, plus
/// per-direction caps (0 = unlimited). Applied to newly-started transfers.
#[tauri::command]
fn set_transfer_limits(state: State<'_, AppState>, max: usize, downloads: usize, uploads: usize) {
    state.transfers.set_limits(max, downloads, uploads);
}

/// Write raw bytes to `dir`/`name` on the given side ("local" or "remote").
/// Used for external drops (files dragged from the OS file manager), where the
/// source path isn't available so the content is sent directly.
#[tauri::command]
async fn put_bytes(
    state: State<'_, AppState>,
    id: u32,
    side: String,
    dir: String,
    name: String,
    data: Vec<u8>,
) -> BackendResult<()> {
    let (backend, path): (Arc<dyn StorageBackend>, String) = if side == "remote" {
        (
            remote_backend(&state, id).await?,
            format!("{}/{}", dir.trim_end_matches('/'), name),
        )
    } else {
        let path = std::path::Path::new(&dir)
            .join(&name)
            .to_string_lossy()
            .into_owned();
        (Arc::new(LocalBackend), path)
    };
    backend.write_file(&path, &data).await
}

// ---- File operations: local ----

#[tauri::command]
async fn local_mkdir(parent: String, name: String) -> BackendResult<()> {
    let path = std::path::Path::new(&parent).join(&name);
    LocalBackend.mkdir(&path.to_string_lossy()).await
}

#[tauri::command]
async fn local_remove(path: String, dir: bool) -> BackendResult<()> {
    LocalBackend.remove(&path, dir).await
}

#[tauri::command]
async fn local_rename(from: String, name: String) -> BackendResult<()> {
    let to = std::path::Path::new(&from).with_file_name(&name);
    LocalBackend.rename(&from, &to.to_string_lossy()).await
}

// ---- File operations: remote ----

#[tauri::command]
async fn remote_mkdir(
    state: State<'_, AppState>,
    id: u32,
    parent: String,
    name: String,
) -> BackendResult<()> {
    let backend = remote_backend(&state, id).await?;
    let path = format!("{}/{}", parent.trim_end_matches('/'), name);
    backend.mkdir(&path).await
}

#[tauri::command]
async fn remote_remove(
    state: State<'_, AppState>,
    id: u32,
    path: String,
    dir: bool,
) -> BackendResult<()> {
    let backend = remote_backend(&state, id).await?;
    backend.remove(&path, dir).await
}

#[tauri::command]
async fn remote_rename(
    state: State<'_, AppState>,
    id: u32,
    from: String,
    name: String,
) -> BackendResult<()> {
    let backend = remote_backend(&state, id).await?;
    backend.rename(&from, &posix_with_name(&from, &name)).await
}

// ---- Site manager: persistence (JSON config file) ----

fn sites_file() -> BackendResult<std::path::PathBuf> {
    let dir = backend::config_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("sites.json");
    // One-time migration: the earliest builds stored sites.json in Tauri's
    // identifier folder, which was the placeholder `app.packetboat.desktop`
    // (a literal historical path — unaffected by later identifier changes). If
    // the new file doesn't exist yet but that old one does, carry it over.
    if !path.exists() {
        if let Some(old) =
            dirs::config_dir().map(|d| d.join("app.packetboat.desktop").join("sites.json"))
        {
            if old.exists() {
                let _ = std::fs::copy(&old, &path);
            }
        }
    }
    Ok(path)
}

#[tauri::command]
fn sites_load() -> BackendResult<Vec<Site>> {
    match std::fs::read(sites_file()?) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
        Err(_) => Ok(Vec::new()),
    }
}

#[tauri::command]
fn sites_save(sites: Vec<Site>) -> BackendResult<()> {
    let json = serde_json::to_vec_pretty(&sites).map_err(|e| BackendError::Other(e.to_string()))?;
    std::fs::write(sites_file()?, json)?;
    Ok(())
}

// ---- Site manager: passwords (OS keychain) ----

#[tauri::command]
fn secret_set(id: String, password: String) -> BackendResult<()> {
    keyring::Entry::new("packetboat", &id)
        .and_then(|entry| entry.set_password(&password))
        .map_err(|e| BackendError::Other(e.to_string()))
}

#[tauri::command]
fn secret_get(id: String) -> Option<String> {
    keyring::Entry::new("packetboat", &id)
        .ok()?
        .get_password()
        .ok()
}

#[tauri::command]
fn secret_delete(id: String) -> BackendResult<()> {
    if let Ok(entry) = keyring::Entry::new("packetboat", &id) {
        let _ = entry.delete_credential();
    }
    Ok(())
}

/// The app version (from Cargo.toml), shown in the title bar.
#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Whether this is a development build. The frontend keeps the WebView's
/// right-click menu (and devtools) in dev but suppresses it in production.
#[tauri::command]
fn is_dev() -> bool {
    cfg!(debug_assertions)
}

/// Show a desktop notification (transfer-complete / failure summaries). Called
/// by the frontend when the transfer queue drains while the app is in the
/// background. `tab` is the connection id to focus when the whole run belonged to
/// one connection (so a click can jump to that tab); `None` when it spanned
/// several tabs or none.
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String, tab: Option<u32>) {
    // Windows: send a branded toast (Packetboat name + icon) under our own
    // AppUserModelID, which works in dev too, and brings the window forward when
    // clicked. Fall through to the plugin if it fails. Other platforms use the
    // plugin directly (the OS focuses the app on click on its own).
    #[cfg(windows)]
    {
        let app_click = app.clone();
        if toast::show(&title, &body, move || {
            activate_from_notification(&app_click, tab)
        })
        .is_ok()
        {
            return;
        }
    }
    let _ = tab;
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Bring the main window forward when a notification is clicked, and — if the
/// finished run was for a single connection — ask the frontend to switch to that
/// tab. Runs the window/emit work on the main thread (the toast callback fires on
/// a WinRT thread).
#[allow(dead_code)] // only wired from the Windows toast path
fn activate_from_notification(app: &AppHandle, tab: Option<u32>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        show_main_window(&handle);
        if let Some(id) = tab {
            let _ = handle.emit("notification://activate", id);
        }
    });
}

/// Read a UTF-8 text file (used to import a user-picked FileZilla site export).
#[tauri::command]
fn read_text_file(path: String) -> BackendResult<String> {
    std::fs::read_to_string(&path).map_err(|e| BackendError::Other(e.to_string()))
}

/// Build an `op` (1Password CLI) command, suppressing the console window that
/// would otherwise flash on Windows when a GUI app spawns a console process.
fn op_command() -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("op");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Whether the 1Password CLI (`op`) is available on PATH (so the Site Manager
/// can warn upfront when the "1Password" logon type won't work).
#[tauri::command]
fn op_available() -> bool {
    op_command()
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Resolve a 1Password secret reference (`op://vault/item/field`) to its value
/// via the user's `op` CLI. The reference is a pointer (safe to store); the
/// resolved value is returned for immediate use and never logged or persisted.
/// Strip the surrounding quotes/whitespace 1Password's "Copy Secret Reference"
/// adds, and verify the result is an `op://` reference. Returns the cleaned
/// reference ready for `op read`, or a friendly error.
fn normalize_op_reference(reference: &str) -> Result<&str, String> {
    let reference = reference
        .trim()
        .trim_matches(|c: char| c == '"' || c == '\'')
        .trim();
    if reference.starts_with("op://") {
        Ok(reference)
    } else {
        Err("Enter a 1Password reference like op://Vault/Item/password.".into())
    }
}

#[tauri::command]
fn resolve_op_reference(reference: String) -> Result<String, String> {
    let reference = normalize_op_reference(&reference)?;
    let output = op_command()
        .arg("read")
        .arg(reference)
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "1Password CLI (op) isn't installed or isn't on your PATH.".to_string()
            } else {
                format!("Couldn't run the 1Password CLI: {e}")
            }
        })?;
    if output.status.success() {
        // `op read` appends a trailing newline; strip only newlines (a password
        // could legitimately end in other whitespace).
        let value = String::from_utf8_lossy(&output.stdout);
        Ok(value.trim_end_matches(['\r', '\n']).to_string())
    } else {
        Err(friendly_op_error(&String::from_utf8_lossy(&output.stderr)))
    }
}

/// Turn `op`'s stderr into a short message. The not-installed / not-signed-in
/// cases get actionable rewording; everything else surfaces `op`'s own message
/// (it names the exact problem — bad vault/item/section/field), which is far more
/// useful for fixing a reference than a generic "not found".
fn friendly_op_error(stderr: &str) -> String {
    let s = stderr.trim();
    let low = s.to_lowercase();
    if low.contains("not currently signed in")
        || low.contains("no account")
        || low.contains("account is not signed in")
        || low.contains("sign in")
        || low.contains("authorization")
    {
        "Not signed in to 1Password. Unlock the 1Password app (or run `op signin`) and try again."
            .into()
    } else if s.is_empty() {
        "1Password couldn't resolve that reference.".into()
    } else {
        format!("1Password: {}", clean_op_line(s.lines().next().unwrap_or(s)))
    }
}

/// Strip `op`'s `[ERROR] YYYY/MM/DD HH:MM:SS` log prefix from a line, leaving the
/// human-readable message.
fn clean_op_line(line: &str) -> &str {
    let mut s = line.trim();
    if s.starts_with('[') {
        if let Some(i) = s.find("] ") {
            s = s[i + 2..].trim_start();
        }
    }
    // Drop a leading date + time token pair (e.g. "2026/07/01 12:00:00 ").
    let mut it = s.splitn(3, ' ');
    if let (Some(a), Some(b), Some(rest)) = (it.next(), it.next(), it.next()) {
        if a.contains('/') && b.contains(':') {
            return rest.trim_start();
        }
    }
    s
}

/// An available update, surfaced to the frontend's "update available" prompt.
#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// Check the configured update endpoint. Returns `Some` when a newer signed
/// release is available, `None` when up to date. Errors (no updater config in
/// dev, offline) are returned as strings and treated as "no update" by the UI.
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => Ok(Some(UpdateInfo {
            version: update.version.clone(),
            notes: update.body.clone(),
        })),
        None => Ok(None),
    }
}

/// Download and install the available update, then restart into it. Re-checks so
/// it needs no shared state between commands.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(()); // nothing to install
    };
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    // `restart()` diverges (returns `!`) — process relaunches into the update.
    app.restart()
}

/// Whether closing the window hides it to the system tray instead of quitting.
/// Set from the frontend setting via [`set_close_to_tray`] and read in the
/// window's close handler. A module-level flag so the close closure can read it
/// without threading app state through.
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

/// Update the close-to-tray preference (called by the frontend on startup and
/// whenever the Settings toggle changes).
#[tauri::command]
fn set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
}

/// Show, unminimize, and focus the main window (tray "Open" / left-click).
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Build the system tray icon and its menu (Open / Quit).
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::MenuBuilder;
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
    let menu = MenuBuilder::new(app)
        .text("open", "Open Packetboat")
        .separator()
        .text("quit", "Quit")
        .build()?;

    TrayIconBuilder::with_id("packetboat_tray")
        .icon(icon)
        .tooltip("Packetboat")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left-click the tray icon to restore the window.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Persist window size/position/maximized across launches. VISIBLE is
        // excluded so close-to-tray's hide() doesn't persist a "hidden" state
        // and launch the app invisibly next time. (The plugin stores its file in
        // the Tauri identifier folder, not the Packetboat config dir.)
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .setup(|app| {
            let connections: Connections = Arc::new(Mutex::new(HashMap::new()));
            let transfers = TransferManager::start(app.handle().clone(), connections.clone());
            app.manage(AppState {
                connections,
                next_id: AtomicU32::new(1),
                transfers,
            });
            // Register our Windows toast identity (name + icon) up front so the
            // first notification already attributes to Packetboat.
            #[cfg(windows)]
            toast::prepare();
            // Best-effort: a tray failure must not abort setup, or the window
            // (which starts hidden) would never be shown below.
            if let Err(e) = setup_tray(app.handle()) {
                eprintln!("tray setup failed: {e}");
            }
            // Close-to-tray: when the setting is on, the window's X button hides
            // to the tray instead of quitting. Window geometry is persisted by
            // the window-state plugin above.
            if let Some(window) = app.get_webview_window("main") {
                let win = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if CLOSE_TO_TRAY.load(Ordering::Relaxed) {
                            api.prevent_close();
                            let _ = win.hide();
                        }
                    }
                });
                // The window starts hidden (visible:false in tauri.conf.json) so
                // the window-state plugin can restore its saved geometry first;
                // reveal it now that geometry is set, avoiding the default-size →
                // restored-size resize flash. The dark backgroundColor covers the
                // moment before the webview paints, so there's no white flash.
                let _ = window.show();
                let _ = window.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connect_sftp,
            connect_ftp,
            trust_cert,
            connect_opendal,
            list_tree,
            disconnect,
            list_remote,
            list_local,
            local_home,
            local_parent,
            local_roots,
            enqueue_transfer,
            cancel_transfer,
            set_transfer_limits,
            put_bytes,
            local_mkdir,
            local_remove,
            local_rename,
            remote_mkdir,
            remote_remove,
            remote_rename,
            sites_load,
            sites_save,
            app_version,
            is_dev,
            notify,
            read_text_file,
            op_available,
            resolve_op_reference,
            check_update,
            install_update,
            set_close_to_tray,
            secret_set,
            secret_get,
            secret_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_reference_strips_1password_quotes_and_whitespace() {
        // 1Password's "Copy Secret Reference" wraps the value in quotes.
        assert_eq!(
            normalize_op_reference("\"op://Private/Item/password\"").unwrap(),
            "op://Private/Item/password"
        );
        assert_eq!(
            normalize_op_reference("'op://Vault/Item/field'").unwrap(),
            "op://Vault/Item/field"
        );
        assert_eq!(
            normalize_op_reference("   op://Vault/Item/password  ").unwrap(),
            "op://Vault/Item/password"
        );
        // Internal spaces (vault/item/section names) are preserved.
        assert_eq!(
            normalize_op_reference("\"op://Development/Shock Hosting/cPanel User/password\"").unwrap(),
            "op://Development/Shock Hosting/cPanel User/password"
        );
    }

    #[test]
    fn op_reference_rejects_non_op_input() {
        assert!(normalize_op_reference("just a password").is_err());
        assert!(normalize_op_reference("https://example.com").is_err());
        assert!(normalize_op_reference("").is_err());
    }

    #[test]
    fn clean_op_line_strips_error_and_timestamp_prefix() {
        assert_eq!(
            clean_op_line("[ERROR] 2026/07/01 12:00:00 \"op://x\" isn't an item"),
            "\"op://x\" isn't an item"
        );
        // No log prefix → returned as-is.
        assert_eq!(clean_op_line("could not read secret"), "could not read secret");
        // Bracket tag but no timestamp.
        assert_eq!(clean_op_line("[ERROR] plain message"), "plain message");
    }

    #[test]
    fn friendly_op_error_rewords_sign_in_but_surfaces_others() {
        assert!(friendly_op_error("[ERROR] 2026/07/01 12:00:00 you are not currently signed in")
            .to_lowercase()
            .contains("unlock the 1password app"));
        // A reference/field problem surfaces op's own message rather than a generic one.
        let msg = friendly_op_error("[ERROR] 2026/07/01 12:00:00 \"op://x/y/z\" isn't an item in the \"y\" vault");
        assert!(msg.starts_with("1Password:"));
        assert!(msg.contains("isn't an item"));
        // Empty stderr → generic fallback.
        assert!(!friendly_op_error("").is_empty());
    }

    #[test]
    fn site_deserializes_with_sensible_defaults() {
        // A minimal site (older config, or a hand-written entry) must fill in the
        // defaults the connect flow relies on.
        let site: Site = serde_json::from_str(
            r#"{"id":"a","name":"Box","protocol":"sftp","host":"h.example"}"#,
        )
        .unwrap();
        assert_eq!(site.logon_type, "ask");
        assert!(site.passive); // default true
        assert_eq!(site.op_reference, "");
        assert_eq!(site.encryption, "");
        assert!(!site.sync_browsing);
        assert!(site.config.is_empty());
    }
}
