//! Packetboat — Tauri entry point: app state, the command surface the frontend
//! invokes, and the wiring between them and the storage backends.

mod backend;
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
use tauri::{AppHandle, Manager, State};
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
    /// (prompt each connect), or "anonymous".
    #[serde(default = "default_logon_type")]
    logon_type: String,
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
            setup_tray(app.handle())?;
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
            set_close_to_tray,
            secret_set,
            secret_get,
            secret_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
