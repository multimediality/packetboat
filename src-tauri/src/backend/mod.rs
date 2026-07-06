//! Storage backend abstraction.
//!
//! Every protocol Packetboat speaks reaches the rest of the app through the
//! same [`StorageBackend`] trait, so the UI and (eventually) the transfer
//! engine never need to know which backend they're driving. SFTP ships in the
//! MVP; FTP/FTPS, S3, B2, WebDAV, Google Drive and Dropbox slot in behind the
//! same trait later. The local filesystem is itself a backend
//! ([`local::LocalBackend`]), which keeps the dual-pane browser symmetric.

use async_trait::async_trait;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite};

pub mod cloud;
pub mod ftp;
pub mod local;
pub mod sftp;

/// The app's config directory, capitalized for a tidy Windows folder name:
/// `%APPDATA%\Packetboat` (Windows), `~/Library/Application Support/Packetboat`
/// (macOS), `~/.config/Packetboat` (Linux). All persisted config — saved sites,
/// SSH known-hosts, FTPS trusted certs — lives here.
pub fn config_dir() -> std::path::PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("Packetboat")
}

/// Reject a `name` that isn't a single, safe path component. Download
/// destinations are built by joining a directory with a file name that
/// originates from the *remote* server's listing; a name containing a path
/// separator, or equal to "." / ".." / empty, could escape the target
/// directory (path traversal) when a server is malicious or compromised. This
/// is the backend's own guard — it does not depend on the frontend sanitizer.
///
/// `\` is only a path separator on Windows, so it's rejected only there (a Unix
/// file may legitimately contain a backslash in its name).
pub fn safe_component(name: &str) -> BackendResult<()> {
    let bad_backslash = cfg!(windows) && name.contains('\\');
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\0')
        || bad_backslash
    {
        return Err(BackendError::Other(format!("unsafe file name: {name:?}")));
    }
    Ok(())
}

/// A single entry in a directory listing. Shared by every backend and sent
/// straight to the frontend as JSON.
#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub name: String,
    /// Full backend-native path to the entry.
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
    /// Modification time as a Unix timestamp (seconds), when available.
    pub modified: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Dir,
    File,
    Symlink,
}

/// Identifies which concrete backend an instance is — mostly for the UI.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    Local,
    Sftp,
    Ftp,
    Cloud,
}

pub type BackendResult<T> = Result<T, BackendError>;

/// The swappable contract every backend implements.
///
/// Paths are backend-native strings: POSIX-style (`/var/www`) for remote
/// backends, OS-native for [`local::LocalBackend`].
//
// Some methods are the forward-looking surface (file read/write, mkdir,
// remove, rename, `kind`) that the transfer queue and file operations will use.
// They're implemented now so every backend is complete, even though the MVP UI
// only drives `list` and `canonicalize` so far.
#[allow(dead_code)]
#[async_trait]
pub trait StorageBackend: Send + Sync {
    fn kind(&self) -> BackendKind;

    /// List the entries directly under `path`.
    async fn list(&self, path: &str) -> BackendResult<Vec<Entry>>;

    /// Resolve `path` (which may be relative, e.g. `"."`) to an absolute path.
    async fn canonicalize(&self, path: &str) -> BackendResult<String>;

    /// Open `path` for streaming reads. The transfer engine copies from this
    /// into a destination [`open_write`](Self::open_write) handle.
    async fn open_read(&self, path: &str) -> BackendResult<Box<dyn AsyncRead + Send + Unpin>>;

    /// Open `path` for streaming writes, creating or truncating it.
    async fn open_write(&self, path: &str) -> BackendResult<Box<dyn AsyncWrite + Send + Unpin>>;

    /// Open `path` for reading starting at byte `offset` — used to resume a
    /// partially-completed transfer.
    async fn open_read_at(
        &self,
        path: &str,
        offset: u64,
    ) -> BackendResult<Box<dyn AsyncRead + Send + Unpin>>;

    /// Open `path` for appending: writes continue after the existing content
    /// (the other half of a resumed transfer). Backends that can't append —
    /// object stores like S3/B2 — return an error.
    async fn open_append(&self, path: &str) -> BackendResult<Box<dyn AsyncWrite + Send + Unpin>>;

    /// Read an entire file into memory. Convenience for small files; the
    /// transfer engine uses the streaming handles above instead.
    async fn read_file(&self, path: &str) -> BackendResult<Vec<u8>>;

    /// Write `data` to `path`, creating or truncating the file.
    async fn write_file(&self, path: &str, data: &[u8]) -> BackendResult<()>;

    async fn mkdir(&self, path: &str) -> BackendResult<()>;

    /// Create a batch of directories, returning per-path success (`true` =
    /// actually created). Bulk operations (folder drops) use this so backends
    /// that can pipeline requests over one connection don't pay a full network
    /// round-trip per directory. A failure ("already exists", usually) is a
    /// per-path result, not an error. Backends may create the batch
    /// concurrently, so callers must not put a directory and its parent in the
    /// same call — send one tree level at a time.
    async fn mkdir_many(&self, paths: &[String]) -> Vec<bool> {
        let mut out = Vec::with_capacity(paths.len());
        for p in paths {
            out.push(self.mkdir(p).await.is_ok());
        }
        out
    }

    async fn remove(&self, path: &str, is_dir: bool) -> BackendResult<()>;

    async fn rename(&self, from: &str, to: &str) -> BackendResult<()>;
}

/// Errors any backend can raise. Serializes to a plain message string so Tauri
/// commands can hand it straight to the frontend.
#[derive(Debug, thiserror::Error)]
pub enum BackendError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("SSH error: {0}")]
    Ssh(String),
    #[error("SFTP error: {0}")]
    Sftp(String),
    #[error("FTP error: {0}")]
    Ftp(String),
    #[error("cloud error: {0}")]
    Cloud(String),
    #[error("authentication failed — check your username and password (this server accepts: {0})")]
    AuthMethods(String),
    #[error("not connected")]
    NotConnected,
    // General-purpose variant kept for backends/operations added later.
    #[allow(dead_code)]
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for BackendError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<russh::Error> for BackendError {
    fn from(e: russh::Error) -> Self {
        BackendError::Ssh(e.to_string())
    }
}

impl From<russh_sftp::client::error::Error> for BackendError {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        BackendError::Sftp(e.to_string())
    }
}

impl From<suppaftp::FtpError> for BackendError {
    fn from(e: suppaftp::FtpError) -> Self {
        BackendError::Ftp(e.to_string())
    }
}

impl From<opendal::Error> for BackendError {
    fn from(e: opendal::Error) -> Self {
        BackendError::Cloud(concise_opendal_error(&e))
    }
}

/// OpenDAL stringifies errors as a verbose dump — the full HTTP request/response
/// context (URI, headers, status). For display we want just the human-meaningful
/// reason: the `message: "..."` field of the underlying service error when
/// present, otherwise a trimmed fallback.
fn concise_opendal_error(e: &opendal::Error) -> String {
    let full = e.to_string();
    const MARK: &str = "message: \"";
    if let Some(idx) = full.rfind(MARK) {
        let rest = &full[idx + MARK.len()..];
        if let Some(end) = rest.find('"') {
            if !rest[..end].is_empty() {
                return rest[..end].to_string();
            }
        }
    }
    let trimmed: String = full.chars().take(160).collect();
    if full.chars().count() > 160 {
        format!("{trimmed}…")
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::safe_component;

    #[test]
    fn safe_component_accepts_ordinary_names() {
        for name in ["file.txt", "My Photo (1).jpg", "archive.tar.gz", ".hidden", "a.b.c"] {
            assert!(safe_component(name).is_ok(), "should accept: {name}");
        }
    }

    #[test]
    fn safe_component_rejects_traversal_and_separators() {
        for name in ["", ".", "..", "a/b", "../evil", "/etc/passwd", "with\0nul"] {
            assert!(safe_component(name).is_err(), "should reject: {name:?}");
        }
    }

    #[test]
    #[cfg(windows)]
    fn safe_component_rejects_backslash_on_windows() {
        assert!(safe_component("a\\b").is_err());
        assert!(safe_component("..\\..\\evil").is_err());
    }

    #[test]
    #[cfg(not(windows))]
    fn safe_component_allows_backslash_off_windows() {
        // A backslash is a legal filename character on Unix.
        assert!(safe_component("a\\b").is_ok());
    }
}
