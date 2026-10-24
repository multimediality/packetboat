//! SFTP backend, built on russh (a pure-Rust SSH implementation — no system
//! `ssh` binary or libssh2 needed, which is what makes it work cleanly on
//! Windows) plus russh-sftp for the SFTP subsystem itself.
//!
//! The SSH link can drop under a long-idle app (NAT/firewall idle timeouts, a
//! server-side `ClientAliveCountMax`, a laptop sleeping). Two defences: SSH
//! keepalives so an idle link stays mapped and a dead one is noticed, and a
//! one-shot transparent reconnect — an operation that fails because the
//! session is gone re-establishes it and retries once, the same way the FTP
//! backend handles a dropped control connection.

use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use russh::client::{self, AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncSeekExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Mutex, RwLock};

use super::{BackendError, BackendKind, BackendResult, Entry, EntryKind, StorageBackend};

/// Connection parameters for an SFTP site. Mirrors the frontend connect form.
/// Secrets (password / key passphrase) are supplied per-connect and held only in
/// memory; the Site Manager persists saved passwords in the OS keychain.
#[derive(Debug, Clone, Deserialize)]
pub struct SftpConfig {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// Path to a private key file. When set, authentication uses public-key
    /// auth (with `passphrase` if the key is encrypted) instead of the password.
    #[serde(default)]
    pub key_path: String,
    /// Passphrase for an encrypted private key. Empty for unencrypted keys.
    #[serde(default)]
    pub passphrase: String,
}

fn default_port() -> u16 {
    22
}

/// Send a keepalive after this long without traffic from the server, and give
/// up — closing the handle, so the next operation reconnects instead of
/// hanging — after `KEEPALIVE_MAX` unanswered probes (about 45 s to notice a
/// dead link). Regular probes also keep NAT/firewall idle timers from cutting
/// a quiet session, which is how most "session closed" errors started.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
const KEEPALIVE_MAX: usize = 3;

/// One live SSH connection and the SFTP session riding on it. Replaced as a
/// unit on reconnect.
struct Session {
    // Kept alive for the lifetime of the session: dropping the handle tears
    // down the SSH connection that the SFTP channel rides on. Wrapped in a
    // Mutex so the backend is `Sync` regardless of the handle's own bounds.
    ssh: Mutex<Handle<ClientHandler>>,
    // Deliberately NOT behind a mutex: SftpSession is built for concurrent
    // use (every method takes &self; requests multiplex over the channel,
    // matched by request id), so operations from different tasks — transfers,
    // listings, batched mkdirs — pipeline instead of taking turns. A mutex
    // here serialized every file open behind a full network round-trip.
    sftp: SftpSession,
}

impl Session {
    /// Whether russh has given up on the link (keepalives unanswered, server
    /// hung up). Operations on a closed session fail with "session closed".
    async fn is_closed(&self) -> bool {
        self.ssh.lock().await.is_closed()
    }
}

pub struct SftpBackend {
    /// Kept (secrets included, in memory only) so a dropped session can be
    /// re-established without asking the UI for credentials again.
    config: SftpConfig,
    /// The current session. Operations clone the Arc and drop the read guard
    /// at once, so they still run concurrently; a reconnect takes the write
    /// side to swap in a fresh session.
    session: RwLock<Arc<Session>>,
}

/// True for errors that mean the SSH link is gone — a fresh session would
/// recover — as opposed to a server-side status like "no such file".
/// russh-sftp reports a dropped channel as "session closed" (gone before the
/// request was sent), "sender dropped" (gone mid-request), a `SendError`, or an
/// I/O error from the channel stream; the `Io` arm covers seek/read failures
/// on an open file. A request `Timeout` is deliberately not here: a slow
/// server isn't a dead one, and a dead link is caught by the keepalive-closed
/// check that accompanies this test.
fn is_sftp_conn_error(e: &BackendError) -> bool {
    match e {
        BackendError::Io(_) | BackendError::Ssh(_) => true,
        BackendError::Sftp(m) => {
            let m = m.to_lowercase();
            m.contains("session closed")
                || m.contains("sender dropped")
                || m.contains("senderror")
                || m.starts_with("i/o")
        }
        _ => false,
    }
}

/// Run an SFTP operation on the live session; if it fails because the link is
/// gone, reconnect once and retry. `$s` is bound to the session for `$op`,
/// which must evaluate to a `BackendResult`. A session russh has already
/// closed skips the doomed first attempt.
macro_rules! with_reconnect {
    ($self:ident, $s:ident, $op:expr) => {{
        let $s = $self.session().await;
        let first = if $s.is_closed().await {
            Err(BackendError::Sftp("session closed".into()))
        } else {
            $op
        };
        let lost = match &first {
            Err(e) => is_sftp_conn_error(e) || $s.is_closed().await,
            Ok(_) => false,
        };
        if lost {
            let $s = $self.reconnect(&$s).await?;
            $op
        } else {
            first
        }
    }};
}

impl SftpBackend {
    /// Connect and authenticate. A *changed* host key (possible MITM) is recorded
    /// in `host_key_capture` and the handshake rejected, so the caller can prompt
    /// the user to re-trust it (mirrors the FTPS cert flow).
    pub async fn connect(
        config: &SftpConfig,
        host_key_capture: HostKeyCapture,
    ) -> BackendResult<Self> {
        let session = open_session(config, host_key_capture).await?;
        Ok(Self {
            config: config.clone(),
            session: RwLock::new(Arc::new(session)),
        })
    }

    async fn session(&self) -> Arc<Session> {
        self.session.read().await.clone()
    }

    /// The current session, reconnected first if russh has already closed it.
    async fn live_session(&self) -> BackendResult<Arc<Session>> {
        let s = self.session().await;
        if s.is_closed().await {
            self.reconnect(&s).await
        } else {
            Ok(s)
        }
    }

    /// Re-establish the session after it dropped. `stale` is the session the
    /// caller saw fail: if another task already replaced it, that replacement
    /// is returned instead of connecting twice (the write lock serialises
    /// concurrent failures). The host key was trusted at the first connect, so
    /// a throwaway capture is fine — a key that changed meanwhile still fails
    /// loudly. A failed reconnect leaves the stale session in place, so the
    /// next operation tries again; its error says "connection lost" so the
    /// UI can show the state.
    async fn reconnect(&self, stale: &Arc<Session>) -> BackendResult<Arc<Session>> {
        let mut slot = self.session.write().await;
        if !Arc::ptr_eq(&*slot, stale) {
            return Ok(slot.clone());
        }
        let capture: HostKeyCapture = Arc::new(StdMutex::new(None));
        match open_session(&self.config, capture).await {
            Ok(fresh) => {
                let fresh = Arc::new(fresh);
                *slot = fresh.clone();
                Ok(fresh)
            }
            Err(e) => Err(BackendError::Other(format!(
                "connection lost — reconnect failed: {e}"
            ))),
        }
    }
}

/// Open an SSH connection, authenticate, and start the SFTP subsystem.
async fn open_session(
    config: &SftpConfig,
    host_key_capture: HostKeyCapture,
) -> BackendResult<Session> {
    let ssh_config = Arc::new(client::Config {
        keepalive_interval: Some(KEEPALIVE_INTERVAL),
        keepalive_max: KEEPALIVE_MAX,
        ..Default::default()
    });
    let rejected = Arc::new(StdMutex::new(None));
    let handler = ClientHandler {
        host: config.host.clone(),
        port: config.port,
        host_key: format!("{}:{}", config.host, config.port),
        known_hosts: known_hosts_path(),
        rejected: rejected.clone(),
        capture: host_key_capture,
    };
    let mut handle =
        match client::connect(ssh_config, (config.host.as_str(), config.port), handler).await {
            Ok(handle) => handle,
            Err(e) => {
                // A rejected (changed) host key surfaces as a connect error;
                // replace it with a clear explanation.
                if let Some(reason) = rejected.lock().unwrap().take() {
                    return Err(BackendError::Ssh(reason));
                }
                return Err(e.into());
            }
        };

    authenticate(&mut handle, config).await?;

    let channel = handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let sftp = SftpSession::new(channel.into_stream()).await?;

    Ok(Session {
        ssh: Mutex::new(handle),
        sftp,
    })
}

#[async_trait]
impl StorageBackend for SftpBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Sftp
    }

    async fn list(&self, path: &str) -> BackendResult<Vec<Entry>> {
        let dir = with_reconnect!(
            self,
            s,
            s.sftp
                .read_dir(path.to_string())
                .await
                .map_err(BackendError::from)
        )?;
        let mut entries = Vec::new();
        for item in dir {
            let name = item.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let meta = item.metadata();
            let kind = if meta.is_symlink() {
                EntryKind::Symlink
            } else if meta.is_dir() {
                EntryKind::Dir
            } else {
                EntryKind::File
            };
            entries.push(Entry {
                path: join_path(path, &name),
                name,
                kind,
                size: meta.size.unwrap_or(0),
                modified: meta.mtime.map(|m| m as u64),
            });
        }
        Ok(entries)
    }

    async fn canonicalize(&self, path: &str) -> BackendResult<String> {
        with_reconnect!(
            self,
            s,
            s.sftp
                .canonicalize(path.to_string())
                .await
                .map_err(BackendError::from)
        )
    }

    async fn open_read(&self, path: &str) -> BackendResult<Box<dyn AsyncRead + Send + Unpin>> {
        // The returned File owns its own handle to the session and streams
        // independently of other operations.
        with_reconnect!(
            self,
            s,
            s.sftp
                .open(path.to_string())
                .await
                .map(|f| Box::new(f) as Box<dyn AsyncRead + Send + Unpin>)
                .map_err(BackendError::from)
        )
    }

    async fn open_write(&self, path: &str) -> BackendResult<Box<dyn AsyncWrite + Send + Unpin>> {
        with_reconnect!(
            self,
            s,
            s.sftp
                .create(path.to_string())
                .await
                .map(|f| Box::new(f) as Box<dyn AsyncWrite + Send + Unpin>)
                .map_err(BackendError::from)
        )
    }

    async fn open_read_at(
        &self,
        path: &str,
        offset: u64,
    ) -> BackendResult<Box<dyn AsyncRead + Send + Unpin>> {
        // SFTP is random-access: open then seek to the resume offset.
        with_reconnect!(
            self,
            s,
            async {
                let mut file = s
                    .sftp
                    .open_with_flags(path.to_string(), OpenFlags::READ)
                    .await?;
                file.seek(std::io::SeekFrom::Start(offset)).await?;
                Ok::<Box<dyn AsyncRead + Send + Unpin>, BackendError>(Box::new(file))
            }
            .await
        )
    }

    async fn open_append(&self, path: &str) -> BackendResult<Box<dyn AsyncWrite + Send + Unpin>> {
        with_reconnect!(
            self,
            s,
            s.sftp
                .open_with_flags(path.to_string(), OpenFlags::WRITE | OpenFlags::APPEND)
                .await
                .map(|f| Box::new(f) as Box<dyn AsyncWrite + Send + Unpin>)
                .map_err(BackendError::from)
        )
    }

    async fn read_file(&self, path: &str) -> BackendResult<Vec<u8>> {
        with_reconnect!(
            self,
            s,
            s.sftp
                .read(path.to_string())
                .await
                .map_err(BackendError::from)
        )
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> BackendResult<()> {
        // Not sftp.write(): russh-sftp's helper opens with OpenFlags::WRITE
        // only (no CREATE), so writing a file that doesn't exist yet fails
        // with NoSuchFile. Open the way the streaming path does — create /
        // truncate — and shut down explicitly to surface close errors.
        with_reconnect!(
            self,
            s,
            async {
                let mut file = s.sftp.create(path.to_string()).await?;
                file.write_all(data).await?;
                file.shutdown().await?;
                Ok::<(), BackendError>(())
            }
            .await
        )
    }

    async fn mkdir(&self, path: &str) -> BackendResult<()> {
        with_reconnect!(
            self,
            s,
            s.sftp
                .create_dir(path.to_string())
                .await
                .map_err(BackendError::from)
        )
    }

    async fn mkdir_many(&self, paths: &[String]) -> Vec<bool> {
        // Fired together, the batch pipelines its round-trips instead of
        // paying one per directory. Results are plain bools, so there's no
        // per-call retry here — a known-dead session is reconnected up front,
        // and the caller falls back to per-dir mkdir (which does retry) when
        // the batch reports failures.
        let Ok(s) = self.live_session().await else {
            return vec![false; paths.len()];
        };
        let futs = paths.iter().map(|p| s.sftp.create_dir(p.to_string()));
        futures_util::future::join_all(futs)
            .await
            .into_iter()
            .map(|r| r.is_ok())
            .collect()
    }

    async fn remove(&self, path: &str, is_dir: bool) -> BackendResult<()> {
        with_reconnect!(
            self,
            s,
            async {
                if is_dir {
                    s.sftp.remove_dir(path.to_string()).await?;
                } else {
                    s.sftp.remove_file(path.to_string()).await?;
                }
                Ok::<(), BackendError>(())
            }
            .await
        )
    }

    async fn rename(&self, from: &str, to: &str) -> BackendResult<()> {
        with_reconnect!(
            self,
            s,
            s.sftp
                .rename(from.to_string(), to.to_string())
                .await
                .map_err(BackendError::from)
        )
    }
}

/// Joins a POSIX directory path and an entry name.
fn join_path(base: &str, name: &str) -> String {
    if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}

/// Authenticates `handle` for `config`. With a `key_path`, uses public-key auth;
/// otherwise tries the SSH `password` method first and then keyboard-interactive.
/// Most OpenSSH servers present interactive password logins via
/// keyboard-interactive, so the plain password method alone often fails even with
/// correct credentials — hence the fallback.
async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    config: &SftpConfig,
) -> BackendResult<()> {
    if !config.key_path.is_empty() {
        return authenticate_key(
            handle,
            &config.username,
            &config.key_path,
            &config.passphrase,
        )
        .await;
    }

    let (username, password) = (&config.username, &config.password);
    if let AuthResult::Success = handle.authenticate_password(username, password).await? {
        return Ok(());
    }

    let mut response = handle
        .authenticate_keyboard_interactive_start(username, None::<String>)
        .await?;
    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                // Answer every prompt with the password.
                let answers = vec![password.to_string(); prompts.len()];
                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await?;
            }
            KeyboardInteractiveAuthResponse::Failure {
                remaining_methods, ..
            } => return Err(BackendError::AuthMethods(format!("{remaining_methods:?}"))),
        }
    }
}

/// Public-key authentication from a private key file. Reads and decrypts the key
/// (with `passphrase` if it's encrypted), then offers it to the server. For RSA
/// keys, tries the modern rsa-sha2-512/256 signatures before the legacy SHA-1 one
/// (many servers reject SHA-1), so a valid RSA key isn't spuriously refused.
async fn authenticate_key(
    handle: &mut Handle<ClientHandler>,
    username: &str,
    key_path: &str,
    passphrase: &str,
) -> BackendResult<()> {
    let pass = (!passphrase.is_empty()).then_some(passphrase);
    let key = russh::keys::load_secret_key(key_path, pass).map_err(|e| match e {
        russh::keys::Error::KeyIsEncrypted => BackendError::Ssh(
            "This private key is protected by a passphrase — enter it and try again.".into(),
        ),
        other => BackendError::Ssh(format!(
            "Couldn't load the private key at {key_path}: {other}"
        )),
    })?;

    let key = Arc::new(key);
    // Non-RSA keys ignore the hash alg; for RSA, prefer SHA-2 over legacy SHA-1.
    let hash_algs: &[Option<HashAlg>] = if key.algorithm().is_rsa() {
        &[Some(HashAlg::Sha512), Some(HashAlg::Sha256), None]
    } else {
        &[None]
    };
    for &alg in hash_algs {
        let with_alg = PrivateKeyWithHashAlg::new(key.clone(), alg);
        if let AuthResult::Success = handle.authenticate_publickey(username, with_alg).await? {
            return Ok(());
        }
    }
    Err(BackendError::Ssh(
        "The server rejected this key. Check that it's authorized for this user.".into(),
    ))
}

/// Trust a (new/changed) SSH host key by recording its fingerprint for
/// `host:port`, so the next connect accepts it. Called after the user confirms
/// the "host key changed" prompt.
pub fn trust_host_key(host: &str, port: u16, fingerprint: &str) {
    let path = known_hosts_path();
    let mut hosts = load_known_hosts(&path);
    hosts.insert(format!("{host}:{port}"), fingerprint.to_string());
    save_known_hosts(&path, &hosts);
}

/// Details of an unexpected (changed) SSH host key, surfaced to the re-trust
/// prompt. `known` is the previously-trusted fingerprint (the whole point of the
/// warning); `fingerprint` is what the server offered now.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub host: String,
    pub port: u16,
    /// Key algorithm, e.g. "ssh-ed25519".
    pub key_type: String,
    /// SHA-256 fingerprint the server offered now.
    pub fingerprint: String,
    /// The fingerprint previously trusted for this host.
    pub known: String,
}

/// Shared slot the host-key check writes a changed-key record into, for the
/// connect command to read after the rejected handshake (mirrors FTPS
/// `CertCapture`).
pub type HostKeyCapture = Arc<StdMutex<Option<HostKeyInfo>>>;

/// SSH session callbacks. Verifies the server's host key against a known_hosts
/// file with "accept-new" semantics: an unknown host is trusted on first use
/// and recorded; a host whose key has *changed* is rejected (possible MITM).
struct ClientHandler {
    host: String,
    port: u16,
    /// "host:port", the key into the known_hosts map.
    host_key: String,
    known_hosts: std::path::PathBuf,
    /// Set with an explanation when a changed key is rejected, so `connect` can
    /// surface a clear error instead of a generic handshake failure.
    rejected: Arc<StdMutex<Option<String>>>,
    /// Changed-key details for the re-trust prompt (see [`HostKeyInfo`]).
    capture: HostKeyCapture,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string();
        let mut hosts = load_known_hosts(&self.known_hosts);
        match hosts.get(&self.host_key) {
            Some(stored) if *stored == fingerprint => Ok(true),
            Some(stored) => {
                // Record the change so the connect command can offer a re-trust
                // prompt (instead of a dead-end error the user can only fix by
                // hand-editing known_hosts.json).
                if let Ok(mut slot) = self.capture.lock() {
                    *slot = Some(HostKeyInfo {
                        host: self.host.clone(),
                        port: self.port,
                        key_type: server_public_key.algorithm().to_string(),
                        fingerprint: fingerprint.clone(),
                        known: stored.clone(),
                    });
                }
                *self.rejected.lock().unwrap() = Some(format!(
                    "host key for {} has CHANGED — possible man-in-the-middle. \
                     Known {}, server offered {}.",
                    self.host_key, stored, fingerprint
                ));
                Ok(false)
            }
            None => {
                // Trust on first use and record the key.
                hosts.insert(self.host_key.clone(), fingerprint);
                save_known_hosts(&self.known_hosts, &hosts);
                Ok(true)
            }
        }
    }
}

/// Path to the JSON known_hosts file in the app config dir.
fn known_hosts_path() -> std::path::PathBuf {
    super::config_dir().join("known_hosts.json")
}

fn load_known_hosts(path: &std::path::Path) -> std::collections::HashMap<String, String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_known_hosts(path: &std::path::Path, hosts: &std::collections::HashMap<String, String>) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(hosts) {
        let _ = std::fs::write(path, json);
    }
}

#[cfg(test)]
mod tests {
    use super::{is_sftp_conn_error, join_path};
    use crate::backend::BackendError;

    #[test]
    fn dead_link_errors_trigger_reconnect() {
        for m in [
            "session closed",
            "sender dropped",
            "I/O: broken pipe",
            "SendError: channel closed",
        ] {
            assert!(
                is_sftp_conn_error(&BackendError::Sftp(m.into())),
                "should reconnect: {m}"
            );
        }
        assert!(is_sftp_conn_error(&BackendError::Io(
            std::io::Error::other("eof")
        )));
    }

    #[test]
    fn server_status_errors_do_not_reconnect() {
        for m in ["2: No such file", "3: Permission denied", "Timeout"] {
            assert!(
                !is_sftp_conn_error(&BackendError::Sftp(m.into())),
                "should not reconnect: {m}"
            );
        }
        assert!(!is_sftp_conn_error(&BackendError::NotConnected));
    }

    #[test]
    fn join_path_avoids_double_slash_at_root() {
        assert_eq!(join_path("/", "file.txt"), "/file.txt");
        assert_eq!(join_path("/home/user", "file.txt"), "/home/user/file.txt");
        // A base that already ends in a slash isn't doubled.
        assert_eq!(join_path("/home/user/", "file.txt"), "/home/user/file.txt");
    }
}
