//! SFTP backend, built on russh (a pure-Rust SSH implementation — no system
//! `ssh` binary or libssh2 needed, which is what makes it work cleanly on
//! Windows) plus russh-sftp for the SFTP subsystem itself.

use std::sync::Arc;

use async_trait::async_trait;
use russh::client::{self, AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh_sftp::client::SftpSession;
use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Mutex;

use super::{BackendError, BackendKind, BackendResult, Entry, EntryKind, StorageBackend};

/// Connection parameters for an SFTP site. Mirrors the frontend connect form.
/// Passwords live only in memory for now — OS keychain integration is the next
/// step before this is fit for daily use.
#[derive(Debug, Clone, Deserialize)]
pub struct SftpConfig {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub password: String,
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
    pub async fn connect(config: &SftpConfig) -> BackendResult<Self> {
        let ssh_config = Arc::new(client::Config::default());
        let rejected = Arc::new(std::sync::Mutex::new(None));
        let handler = ClientHandler {
            host_key: format!("{}:{}", config.host, config.port),
            known_hosts: known_hosts_path(),
            rejected: rejected.clone(),
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

        authenticate(&mut handle, &config.username, &config.password).await?;

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

    async fn read_file(&self, path: &str) -> BackendResult<Vec<u8>> {
        let sftp = self.sftp.lock().await;
        Ok(sftp.read(path.to_string()).await?)
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> BackendResult<()> {
        let sftp = self.sftp.lock().await;
        sftp.write(path.to_string(), data).await?;
        Ok(())
    }

    async fn mkdir(&self, path: &str) -> BackendResult<()> {
        let sftp = self.sftp.lock().await;
        sftp.create_dir(path.to_string()).await?;
        Ok(())
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

/// Authenticates `handle`, trying the SSH `password` method first and then
/// keyboard-interactive. Most OpenSSH servers present interactive password
/// logins via keyboard-interactive, so the plain password method alone often
/// fails even with correct credentials — hence the fallback.
async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    username: &str,
    password: &str,
) -> BackendResult<()> {
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

/// SSH session callbacks. Verifies the server's host key against a known_hosts
/// file with "accept-new" semantics: an unknown host is trusted on first use
/// and recorded; a host whose key has *changed* is rejected (possible MITM).
struct ClientHandler {
    /// "host:port", the key into the known_hosts map.
    host_key: String,
    known_hosts: std::path::PathBuf,
    /// Set with an explanation when a changed key is rejected, so `connect` can
    /// surface a clear error instead of a generic handshake failure.
    rejected: Arc<std::sync::Mutex<Option<String>>>,
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
                *self.rejected.lock().unwrap() = Some(format!(
                    "host key for {} has CHANGED — possible man-in-the-middle. \
                     Known {}, server offered {}. If you trust the change, remove the \
                     entry from {}.",
                    self.host_key,
                    stored,
                    fingerprint,
                    self.known_hosts.display()
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
    dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("packetboat")
        .join("known_hosts.json")
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
