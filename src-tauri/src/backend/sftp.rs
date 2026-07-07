//! SFTP backend, built on russh (a pure-Rust SSH implementation — no system
//! `ssh` binary or libssh2 needed, which is what makes it work cleanly on
//! Windows) plus russh-sftp for the SFTP subsystem itself.

use std::sync::{Arc, Mutex as StdMutex};

use async_trait::async_trait;
use russh::client::{self, AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncSeekExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;

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

pub struct SftpBackend {
    // Kept alive for the lifetime of the session: dropping the handle tears
    // down the SSH connection that the SFTP channel rides on. Wrapped in a
    // Mutex so the backend is `Sync` regardless of the handle's own bounds.
    _ssh: Mutex<Handle<ClientHandler>>,
    sftp: Mutex<SftpSession>,
}

impl SftpBackend {
    /// Connect and authenticate. A *changed* host key (possible MITM) is recorded
    /// in `host_key_capture` and the handshake rejected, so the caller can prompt
    /// the user to re-trust it (mirrors the FTPS cert flow).
    pub async fn connect(config: &SftpConfig, host_key_capture: HostKeyCapture) -> BackendResult<Self> {
        let ssh_config = Arc::new(client::Config::default());
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

        Ok(Self {
            _ssh: Mutex::new(handle),
            sftp: Mutex::new(sftp),
        })
    }
}

#[async_trait]
impl StorageBackend for SftpBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Sftp
    }

    async fn list(&self, path: &str) -> BackendResult<Vec<Entry>> {
        let sftp = self.sftp.lock().await;
        let dir = sftp.read_dir(path.to_string()).await?;
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
        let sftp = self.sftp.lock().await;
        Ok(sftp.canonicalize(path.to_string()).await?)
    }

    async fn open_read(&self, path: &str) -> BackendResult<Box<dyn AsyncRead + Send + Unpin>> {
        // The returned File owns its own handle to the session, so it can
        // outlive this lock guard and be streamed independently.
        let sftp = self.sftp.lock().await;
        Ok(Box::new(sftp.open(path.to_string()).await?))
    }

    async fn open_write(&self, path: &str) -> BackendResult<Box<dyn AsyncWrite + Send + Unpin>> {
        let sftp = self.sftp.lock().await;
        Ok(Box::new(sftp.create(path.to_string()).await?))
    }

    async fn open_read_at(
        &self,
        path: &str,
        offset: u64,
    ) -> BackendResult<Box<dyn AsyncRead + Send + Unpin>> {
        // SFTP is random-access: open then seek to the resume offset.
        let sftp = self.sftp.lock().await;
        let mut file = sftp.open_with_flags(path.to_string(), OpenFlags::READ).await?;
        file.seek(std::io::SeekFrom::Start(offset)).await?;
        Ok(Box::new(file))
    }

    async fn open_append(&self, path: &str) -> BackendResult<Box<dyn AsyncWrite + Send + Unpin>> {
        let sftp = self.sftp.lock().await;
        let file = sftp
            .open_with_flags(path.to_string(), OpenFlags::WRITE | OpenFlags::APPEND)
            .await?;
        Ok(Box::new(file))
    }

    async fn read_file(&self, path: &str) -> BackendResult<Vec<u8>> {
        let sftp = self.sftp.lock().await;
        Ok(sftp.read(path.to_string()).await?)
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> BackendResult<()> {
        // Not sftp.write(): russh-sftp's helper opens with OpenFlags::WRITE
        // only (no CREATE), so writing a file that doesn't exist yet fails
        // with NoSuchFile. Open the way the streaming path does — create /
        // truncate — and shut down explicitly to surface close errors. The
        // lock covers only the open (like open_write), so concurrent calls
        // overlap on the wire instead of serializing whole files.
        let mut file = {
            let sftp = self.sftp.lock().await;
            sftp.create(path.to_string()).await?
        };
        file.write_all(data).await?;
        file.shutdown().await?;
        Ok(())
    }

    async fn mkdir(&self, path: &str) -> BackendResult<()> {
        let sftp = self.sftp.lock().await;
        sftp.create_dir(path.to_string()).await?;
        Ok(())
    }

    async fn mkdir_many(&self, paths: &[String]) -> Vec<bool> {
        // One lock for the whole batch: SftpSession multiplexes concurrent
        // requests over the channel (matched by request id), so firing them
        // together pipelines the round-trips instead of paying one per
        // directory.
        let sftp = self.sftp.lock().await;
        let futs = paths.iter().map(|p| sftp.create_dir(p.to_string()));
        futures_util::future::join_all(futs)
            .await
            .into_iter()
            .map(|r| r.is_ok())
            .collect()
    }

    async fn remove(&self, path: &str, is_dir: bool) -> BackendResult<()> {
        let sftp = self.sftp.lock().await;
        if is_dir {
            sftp.remove_dir(path.to_string()).await?;
        } else {
            sftp.remove_file(path.to_string()).await?;
        }
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> BackendResult<()> {
        let sftp = self.sftp.lock().await;
        sftp.rename(from.to_string(), to.to_string()).await?;
        Ok(())
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
async fn authenticate(handle: &mut Handle<ClientHandler>, config: &SftpConfig) -> BackendResult<()> {
    if !config.key_path.is_empty() {
        return authenticate_key(handle, &config.username, &config.key_path, &config.passphrase)
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
    use super::join_path;

    #[test]
    fn join_path_avoids_double_slash_at_root() {
        assert_eq!(join_path("/", "file.txt"), "/file.txt");
        assert_eq!(join_path("/home/user", "file.txt"), "/home/user/file.txt");
        // A base that already ends in a slash isn't doubled.
        assert_eq!(join_path("/home/user/", "file.txt"), "/home/user/file.txt");
    }
}
