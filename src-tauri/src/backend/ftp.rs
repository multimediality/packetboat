//! FTP / FTPS backend, built on suppaftp's tokio-native async client.
//!
//! FTPS uses rustls with the aws-lc-rs provider (which builds on Windows via
//! the prebuilt-NASM config) rather than native-tls, whose suppaftp module uses
//! Unix-only `std::os::fd` and doesn't compile on Windows. A plain and a
//! TLS-wrapped session are distinct suppaftp types, so [`Conn`] dispatches over
//! them and exposes a uniform API to the rest of the backend.
//!
//! Transfers stream incrementally over the FTP data connection. Because a
//! suppaftp data stream borrows the control session (and the plain vs TLS
//! sessions are distinct types), each transfer runs in a spawned task that owns
//! the connection lock and pumps fixed-size chunks through a bounded channel;
//! the returned [`ChannelReader`]/[`ChannelWriter`] bridge that channel to the
//! engine's tokio AsyncRead/AsyncWrite. Backpressure on the channel means the
//! engine's byte counter tracks real network progress.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::str::FromStr;
use std::sync::{Arc, Mutex as StdMutex};
use std::task::{Context, Poll};
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use suppaftp::list::File as FtpListItem;
use suppaftp::tokio::{AsyncFtpStream, AsyncRustlsConnector, AsyncRustlsFtpStream};
use suppaftp::tokio_rustls::rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use suppaftp::tokio_rustls::rustls::client::WebPkiServerVerifier;
use suppaftp::tokio_rustls::rustls::crypto::aws_lc_rs;
use suppaftp::tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use suppaftp::tokio_rustls::rustls::{
    ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme,
};
use suppaftp::tokio_rustls::TlsConnector as RustlsTlsConnector;
use suppaftp::types::{FileType, Mode};
use suppaftp::{FtpError, FtpResult, Status};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::sync::mpsc;
use tokio::sync::Mutex;

/// Chunk size for the streaming data pump.
const STREAM_CHUNK: usize = 128 * 1024;

/// True for errors that mean the control connection is dead and a fresh login
/// would recover: a socket-level failure (reset/abort/broken pipe) or a `421`
/// "service not available — closing control connection" (the idle timeout).
fn is_ftp_conn_error(e: &FtpError) -> bool {
    match e {
        FtpError::ConnectionError(_) => true,
        // 421 = service not available. The data-transfer lifecycle codes
        // (125/150/225/226/425/426) should never be the reply to a control
        // command like LIST/PWD — when they are, the control stream is desynced
        // by a leftover response from an aborted/stalled transfer, so reconnect
        // to resync the session.
        FtpError::UnexpectedResponse(resp) => matches!(
            resp.status,
            Status::NotAvailable
                | Status::AlreadyOpen
                | Status::AboutToSend
                | Status::DataConnectionOpen
                | Status::ClosingDataConnection
                | Status::CannotOpenDataConnection
                | Status::TransferAborted
        ),
        _ => false,
    }
}

/// Run an FTP control-connection operation; if it fails because the connection
/// dropped (idle timeout, reset), transparently reconnect once and retry. `$op`
/// must use the bound `$conn` guard and evaluate to an `FtpResult`.
macro_rules! with_reconnect {
    ($self:ident, $conn:ident, $op:expr) => {{
        let first = {
            let mut $conn = $self.conn.lock().await;
            $op
        };
        match first {
            Err(ref e) if is_ftp_conn_error(e) => {
                $self.reconnect().await?;
                let mut $conn = $self.conn.lock().await;
                $op
            }
            other => other,
        }
    }};
}

use super::{BackendError, BackendKind, BackendResult, Entry, EntryKind, StorageBackend};

/// Connection parameters for an FTP/FTPS site.
#[derive(Debug, Clone, Deserialize)]
pub struct FtpConfig {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// TLS mode: "plain" | "explicit_optional" (try explicit TLS, fall back to
    /// plain) | "explicit" (require explicit TLS) | "implicit" (TLS from the
    /// first byte, usually port 990).
    #[serde(default = "default_encryption")]
    pub encryption: String,
    /// Data-connection mode: passive (client connects out — the default, works
    /// behind NAT) or active (server connects back to the client).
    #[serde(default = "default_passive")]
    pub passive: bool,
}

fn default_port() -> u16 {
    21
}

fn default_encryption() -> String {
    "explicit".to_string()
}

fn default_passive() -> bool {
    true
}

/// A connected FTP control session, plain or TLS-wrapped. The two are distinct
/// suppaftp types (`ImplAsyncFtpStream<AsyncNoTlsStream>` vs
/// `<AsyncRustlsStream>`), so the operations dispatch over the variants here.
enum Conn {
    Plain(AsyncFtpStream),
    Secure(AsyncRustlsFtpStream),
}

impl Conn {
    async fn login(&mut self, user: &str, password: &str) -> FtpResult<()> {
        match self {
            Conn::Plain(s) => s.login(user, password).await,
            Conn::Secure(s) => s.login(user, password).await,
        }
    }

    /// Switch to binary (image) transfer mode. Without this the server stays in
    /// its default ASCII mode and mangles non-text files (e.g. images) via
    /// line-ending translation.
    async fn set_binary(&mut self) -> FtpResult<()> {
        match self {
            Conn::Plain(s) => s.transfer_type(FileType::Binary).await,
            Conn::Secure(s) => s.transfer_type(FileType::Binary).await,
        }
    }

    async fn pwd(&mut self) -> FtpResult<String> {
        match self {
            Conn::Plain(s) => s.pwd().await,
            Conn::Secure(s) => s.pwd().await,
        }
    }

    /// Apply data-connection settings before any transfer: active vs passive
    /// mode, and the passive NAT workaround — when a server behind NAT advertises
    /// an unroutable address in its PASV reply, use the control-connection IP
    /// instead (otherwise the data connection hangs). The workaround is harmless
    /// in active mode, so it's always on.
    fn configure(&mut self, mode: Mode) {
        match self {
            Conn::Plain(s) => {
                s.set_mode(mode);
                s.set_passive_nat_workaround(true);
            }
            Conn::Secure(s) => {
                s.set_mode(mode);
                s.set_passive_nat_workaround(true);
            }
        }
    }

    async fn list(&mut self, path: &str) -> FtpResult<Vec<String>> {
        match self {
            Conn::Plain(s) => s.list(Some(path)).await,
            Conn::Secure(s) => s.list(Some(path)).await,
        }
    }

    /// Download a whole file into memory (handles the retr stream + finalize).
    async fn retr_all(&mut self, path: &str) -> FtpResult<Vec<u8>> {
        macro_rules! read_all {
            ($s:expr) => {{
                let mut stream = $s.retr_as_stream(path).await?;
                let mut buf = Vec::new();
                // A read failure mid-download is a dropped connection.
                stream
                    .read_to_end(&mut buf)
                    .await
                    .map_err(FtpError::ConnectionError)?;
                $s.finalize_retr_stream(stream).await?;
                buf
            }};
        }
        Ok(match self {
            Conn::Plain(s) => read_all!(s),
            Conn::Secure(s) => read_all!(s),
        })
    }

    async fn put(&mut self, path: &str, data: &[u8]) -> FtpResult<()> {
        let mut cursor = std::io::Cursor::new(data);
        match self {
            Conn::Plain(s) => s.put_file(path, &mut cursor).await.map(|_| ()),
            Conn::Secure(s) => s.put_file(path, &mut cursor).await.map(|_| ()),
        }
    }

    /// Stream a download: read the data connection in chunks, sending each over
    /// `tx`, then finalize. Stops early (best-effort) if the receiver is gone.
    /// A non-zero `offset` issues `REST` first to resume from that byte.
    async fn stream_download(
        &mut self,
        path: &str,
        offset: u64,
        tx: mpsc::Sender<io::Result<Vec<u8>>>,
    ) -> BackendResult<()> {
        macro_rules! pump {
            ($s:expr) => {{
                if offset > 0 {
                    $s.resume_transfer(offset as usize).await?;
                }
                let mut stream = $s.retr_as_stream(path).await?;
                let mut buf = vec![0u8; STREAM_CHUNK];
                loop {
                    let n = stream.read(&mut buf).await?;
                    if n == 0 {
                        break;
                    }
                    if tx.send(Ok(buf[..n].to_vec())).await.is_err() {
                        break; // receiver dropped — transfer cancelled
                    }
                }
                $s.finalize_retr_stream(stream).await?;
            }};
        }
        match self {
            Conn::Plain(s) => pump!(s),
            Conn::Secure(s) => pump!(s),
        }
        Ok(())
    }

    /// Stream an upload: write chunks received on `rx` to the data connection as
    /// they arrive, then finalize. When `append` is true, uses `APPE` so the
    /// data continues after the file's existing content (resume).
    async fn stream_upload(
        &mut self,
        path: &str,
        append: bool,
        mut rx: mpsc::Receiver<Vec<u8>>,
    ) -> BackendResult<()> {
        macro_rules! pump {
            ($s:expr) => {{
                let mut stream = if append {
                    $s.append_with_stream(path).await?
                } else {
                    $s.put_with_stream(path).await?
                };
                while let Some(chunk) = rx.recv().await {
                    stream.write_all(&chunk).await?;
                }
                $s.finalize_put_stream(stream).await?;
            }};
        }
        match self {
            Conn::Plain(s) => pump!(s),
            Conn::Secure(s) => pump!(s),
        }
        Ok(())
    }

    async fn mkdir(&mut self, path: &str) -> FtpResult<()> {
        match self {
            Conn::Plain(s) => s.mkdir(path).await,
            Conn::Secure(s) => s.mkdir(path).await,
        }
    }

    async fn rmdir(&mut self, path: &str) -> FtpResult<()> {
        match self {
            Conn::Plain(s) => s.rmdir(path).await,
            Conn::Secure(s) => s.rmdir(path).await,
        }
    }

    async fn rm(&mut self, path: &str) -> FtpResult<()> {
        match self {
            Conn::Plain(s) => s.rm(path).await,
            Conn::Secure(s) => s.rm(path).await,
        }
    }

    async fn rename(&mut self, from: &str, to: &str) -> FtpResult<()> {
        match self {
            Conn::Plain(s) => s.rename(from, to).await,
            Conn::Secure(s) => s.rename(from, to).await,
        }
    }
}

/// Max idle transfer connections kept for reuse (extras are closed on return).
const POOL_MAX_IDLE: usize = 8;

/// A pool of extra FTP connections for concurrent transfers, so several
/// transfers to one site run at once instead of serializing on the single
/// control connection. Each is a full login; idle ones are reused.
struct XferPool {
    config: FtpConfig,
    idle: StdMutex<Vec<Conn>>,
}

impl XferPool {
    fn new(config: FtpConfig) -> Self {
        Self {
            config,
            idle: StdMutex::new(Vec::new()),
        }
    }

    /// Take an idle connection or open a fresh one.
    async fn acquire(&self) -> BackendResult<Conn> {
        if let Some(conn) = self.idle.lock().unwrap().pop() {
            return Ok(conn);
        }
        // The cert was trusted on the main connection (already in the trust
        // store if needed), so a throwaway capture is fine here.
        let capture: CertCapture = Arc::new(StdMutex::new(None));
        establish(&self.config, &capture).await
    }

    /// Return a healthy connection for reuse. A broken one is dropped by the
    /// caller instead (which closes it), so it never re-enters the pool.
    fn release(&self, conn: Conn) {
        let mut idle = self.idle.lock().unwrap();
        if idle.len() < POOL_MAX_IDLE {
            idle.push(conn);
        }
    }
}

pub struct FtpBackend {
    /// Control connection: listings, mkdir, rename, delete, pwd.
    conn: Arc<Mutex<Conn>>,
    /// Kept so a dropped/idle control connection can be re-established.
    config: FtpConfig,
    /// Extra connections for concurrent transfers (see [`XferPool`]). Keeping
    /// transfers off the control connection also means an aborted transfer can't
    /// desync navigation — the aborted connection is simply dropped.
    pool: Arc<XferPool>,
}

impl FtpBackend {
    /// Connect, optionally upgrade to TLS, and log in. Returns the backend and
    /// the server's working directory (the pane's starting path). An untrusted
    /// FTPS cert is recorded in `capture` so the caller can prompt and retry.
    pub async fn connect(
        config: &FtpConfig,
        capture: CertCapture,
    ) -> BackendResult<(Self, String)> {
        let mut conn = establish(config, &capture).await?;
        let home = conn.pwd().await.unwrap_or_else(|_| "/".to_string());
        Ok((
            Self {
                conn: Arc::new(Mutex::new(conn)),
                config: config.clone(),
                pool: Arc::new(XferPool::new(config.clone())),
            },
            home,
        ))
    }

    /// Re-establish the control connection in place after it drops (idle
    /// timeout, reset). Paths are absolute, so the lost working directory
    /// doesn't matter. The cert was already trusted at initial connect, so a
    /// throwaway capture is fine here.
    async fn reconnect(&self) -> BackendResult<()> {
        let capture: CertCapture = Arc::new(StdMutex::new(None));
        let fresh = establish(&self.config, &capture).await?;
        *self.conn.lock().await = fresh;
        Ok(())
    }

    /// Spawn a download task on a pooled connection, pumping the data connection
    /// (resuming from `offset` when non-zero) into a channel reader.
    fn spawn_download(&self, path: &str, offset: u64) -> Box<dyn AsyncRead + Send + Unpin> {
        let (tx, rx) = mpsc::channel::<io::Result<Vec<u8>>>(4);
        let pool = self.pool.clone();
        let path = path.to_string();
        let handle = tokio::spawn(async move {
            let mut conn = match pool.acquire().await {
                Ok(c) => c,
                Err(e) => {
                    let _ = tx.send(Err(io::Error::other(e.to_string()))).await;
                    return;
                }
            };
            match conn.stream_download(&path, offset, tx.clone()).await {
                Ok(()) => pool.release(conn), // healthy → reuse
                Err(e) => {
                    // Broken connection: drop it (closes it) and report.
                    let _ = tx.send(Err(io::Error::other(e.to_string()))).await;
                }
            }
        });
        Box::new(ChannelReader::new(rx, handle.abort_handle()))
    }

    /// Spawn an upload task on a pooled connection, writing the channel to the
    /// data connection (appending when `append` is true).
    fn spawn_upload(&self, path: &str, append: bool) -> Box<dyn AsyncWrite + Send + Unpin> {
        let (tx, rx) = mpsc::channel::<Vec<u8>>(4);
        let pool = self.pool.clone();
        let path = path.to_string();
        let handle = tokio::spawn(async move {
            let mut conn = pool.acquire().await?;
            let result = conn.stream_upload(&path, append, rx).await;
            if result.is_ok() {
                pool.release(conn); // healthy → reuse (dropped otherwise)
            }
            result
        });
        Box::new(ChannelWriter::new(tx, handle))
    }
}

// ---- FTPS certificate trust (trust-on-first-use) ----
//
// Mirrors the SSH known_hosts flow in sftp.rs. The TLS verifier first runs the
// standard webpki check (Mozilla CA bundle + hostname); only when that fails
// (self-signed, untrusted CA, or hostname mismatch) does it fall back to a
// fingerprint trust store (`known_certs.json`). An unknown/changed cert is
// captured and the handshake rejected so the connect command can surface it to
// a "trust this certificate?" prompt; once the user trusts the SHA-256
// fingerprint, the retry connects.

/// Details of an untrusted server certificate, surfaced to the trust prompt.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertInfo {
    pub host: String,
    pub port: u16,
    /// SHA-256 fingerprint, uppercase hex with colon separators.
    pub fingerprint: String,
    pub subject: String,
    pub issuer: String,
    /// Subject Alternative Names — the hostnames the cert is actually valid for.
    pub sans: Vec<String>,
    pub not_before: String,
    pub not_after: String,
    /// True when a *different* cert was previously trusted for this host (a
    /// possible man-in-the-middle), as opposed to a first-time unknown cert.
    pub changed: bool,
}

/// Shared slot the verifier writes an untrusted cert into during the handshake,
/// for the connect command to read after a rejected connection.
pub type CertCapture = Arc<StdMutex<Option<CertInfo>>>;

/// Path to the JSON FTPS cert trust store in the app config dir.
fn cert_store_path() -> PathBuf {
    super::config_dir().join("known_certs.json")
}

/// Load the trust store: "host:port" -> SHA-256 fingerprint.
fn load_cert_store(path: &Path) -> HashMap<String, String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_cert_store(path: &Path, store: &HashMap<String, String>) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(store) {
        let _ = std::fs::write(path, json);
    }
}

/// Trust a certificate fingerprint for `host:port` (called after the user
/// accepts the prompt). The next connect to that host accepts this exact cert.
pub fn trust_certificate(host: &str, port: u16, fingerprint: &str) {
    let path = cert_store_path();
    let mut store = load_cert_store(&path);
    store.insert(format!("{host}:{port}"), fingerprint.to_string());
    save_cert_store(&path, &store);
}

/// SHA-256 of the DER cert as uppercase colon-separated hex.
fn fingerprint_of(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    digest
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// A rustls verifier that augments standard webpki validation with a
/// fingerprint trust store for self-signed / mismatched certs.
#[derive(Debug)]
struct TofuVerifier {
    host: String,
    port: u16,
    store_path: PathBuf,
    capture: CertCapture,
    /// Standard webpki verifier; trusted-CA + matching-hostname certs pass here
    /// without a prompt, and it backs the handshake-signature checks.
    webpki: Arc<WebPkiServerVerifier>,
}

impl TofuVerifier {
    /// Build the [`CertInfo`] for an untrusted cert, parsing what details we can
    /// out of the DER for the prompt.
    fn describe(&self, der: &[u8], fingerprint: String, changed: bool) -> CertInfo {
        let mut subject = String::new();
        let mut issuer = String::new();
        let mut sans = Vec::new();
        let mut not_before = String::new();
        let mut not_after = String::new();
        if let Ok((_, cert)) = x509_parser::parse_x509_certificate(der) {
            subject = cert.subject().to_string();
            issuer = cert.issuer().to_string();
            not_before = cert.validity().not_before.to_string();
            not_after = cert.validity().not_after.to_string();
            if let Ok(Some(ext)) = cert.subject_alternative_name() {
                for name in &ext.value.general_names {
                    sans.push(name.to_string());
                }
            }
        }
        CertInfo {
            host: self.host.clone(),
            port: self.port,
            fingerprint,
            subject,
            issuer,
            sans,
            not_before,
            not_after,
            changed,
        }
    }
}

impl ServerCertVerifier for TofuVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, suppaftp::tokio_rustls::rustls::Error> {
        // Standard path first: a CA-trusted cert whose name matches needs no
        // prompt (and we don't record it).
        if self
            .webpki
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
            .is_ok()
        {
            return Ok(ServerCertVerified::assertion());
        }

        // Otherwise fall back to the fingerprint trust store.
        let fingerprint = fingerprint_of(end_entity.as_ref());
        let key = format!("{}:{}", self.host, self.port);
        let stored = load_cert_store(&self.store_path).get(&key).cloned();
        match stored {
            Some(ref known) if *known == fingerprint => Ok(ServerCertVerified::assertion()),
            other => {
                let changed = other.is_some();
                let info = self.describe(end_entity.as_ref(), fingerprint, changed);
                if let Ok(mut slot) = self.capture.lock() {
                    *slot = Some(info);
                }
                Err(suppaftp::tokio_rustls::rustls::Error::General(
                    "server certificate is not trusted".to_string(),
                ))
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, suppaftp::tokio_rustls::rustls::Error> {
        self.webpki.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, suppaftp::tokio_rustls::rustls::Error> {
        self.webpki.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.webpki.supported_verify_schemes()
    }
}

/// Build the rustls TLS connector for FTPS. Trusted-CA certs validate normally;
/// otherwise the [`TofuVerifier`] consults the fingerprint trust store and, for
/// an unknown/changed cert, records it in `capture` and fails the handshake so
/// the caller can prompt.
fn build_connector(host: &str, port: u16, capture: CertCapture) -> BackendResult<AsyncRustlsConnector> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let provider = Arc::new(aws_lc_rs::default_provider());
    let webpki = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone())
        .build()
        .map_err(|e| BackendError::Ftp(e.to_string()))?;
    let verifier = Arc::new(TofuVerifier {
        host: host.to_string(),
        port,
        store_path: cert_store_path(),
        capture,
        webpki,
    });
    let tls_config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| BackendError::Ftp(e.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    Ok(AsyncRustlsConnector::from(RustlsTlsConnector::from(Arc::new(tls_config))))
}

/// Open a fresh control session per the configured encryption mode, log in, and
/// switch to binary mode. An untrusted FTPS cert is recorded in `capture`.
async fn establish(config: &FtpConfig, capture: &CertCapture) -> BackendResult<Conn> {
    let addr = (config.host.as_str(), config.port);
    let connector = || build_connector(&config.host, config.port, capture.clone());

    let mut conn = match config.encryption.as_str() {
        "plain" => Conn::Plain(AsyncFtpStream::connect(addr).await?),
        "implicit" => {
            let secure =
                AsyncRustlsFtpStream::connect_secure_implicit(addr, connector()?, &config.host)
                    .await?;
            Conn::Secure(secure)
        }
        "explicit_optional" => {
            // Try explicit TLS. If TLS negotiated but the certificate was
            // untrusted (captured), surface that error so the caller can prompt
            // — don't silently downgrade an encryptable connection to plaintext.
            // Only fall back to plain when no TLS was on offer at all.
            match AsyncRustlsFtpStream::connect(addr)
                .await?
                .into_secure(connector()?, &config.host)
                .await
            {
                Ok(secure) => Conn::Secure(secure),
                Err(e) => {
                    let untrusted_cert =
                        capture.lock().map(|c| c.is_some()).unwrap_or(false);
                    if untrusted_cert {
                        return Err(e.into());
                    }
                    Conn::Plain(AsyncFtpStream::connect(addr).await?)
                }
            }
        }
        // "explicit" (require) and any unknown value.
        _ => {
            let secure = AsyncRustlsFtpStream::connect(addr)
                .await?
                .into_secure(connector()?, &config.host)
                .await?;
            Conn::Secure(secure)
        }
    };

    // Active vs passive data connections (+ the always-on passive NAT workaround).
    conn.configure(if config.passive {
        Mode::Passive
    } else {
        Mode::Active
    });

    // Blank username means anonymous FTP.
    let user = if config.username.is_empty() {
        "anonymous"
    } else {
        config.username.as_str()
    };
    conn.login(user, &config.password).await?;
    conn.set_binary().await?;
    Ok(conn)
}

#[async_trait]
impl StorageBackend for FtpBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Ftp
    }

    async fn list(&self, path: &str) -> BackendResult<Vec<Entry>> {
        let lines = with_reconnect!(self, conn, conn.list(path).await)?;
        let mut entries = Vec::new();
        for line in lines {
            // Skip lines we can't parse (e.g. the "total N" header on some
            // POSIX servers).
            let Ok(item) = FtpListItem::from_str(&line) else {
                continue;
            };
            let name = item.name().to_string();
            if name == "." || name == ".." {
                continue;
            }
            let kind = if item.is_symlink() {
                EntryKind::Symlink
            } else if item.is_directory() {
                EntryKind::Dir
            } else {
                EntryKind::File
            };
            let modified = item
                .modified()
                .duration_since(UNIX_EPOCH)
                .ok()
                .map(|d| d.as_secs());
            entries.push(Entry {
                path: join_path(path, &name),
                name,
                kind,
                size: item.size() as u64,
                modified,
            });
        }
        Ok(entries)
    }

    async fn canonicalize(&self, path: &str) -> BackendResult<String> {
        if path == "." {
            Ok(with_reconnect!(self, conn, conn.pwd().await)?)
        } else {
            Ok(path.to_string())
        }
    }

    async fn open_read(&self, path: &str) -> BackendResult<Box<dyn AsyncRead + Send + Unpin>> {
        Ok(self.spawn_download(path, 0))
    }

    async fn open_read_at(
        &self,
        path: &str,
        offset: u64,
    ) -> BackendResult<Box<dyn AsyncRead + Send + Unpin>> {
        Ok(self.spawn_download(path, offset))
    }

    async fn open_write(&self, path: &str) -> BackendResult<Box<dyn AsyncWrite + Send + Unpin>> {
        Ok(self.spawn_upload(path, false))
    }

    async fn open_append(&self, path: &str) -> BackendResult<Box<dyn AsyncWrite + Send + Unpin>> {
        Ok(self.spawn_upload(path, true))
    }

    async fn read_file(&self, path: &str) -> BackendResult<Vec<u8>> {
        Ok(with_reconnect!(self, conn, conn.retr_all(path).await)?)
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> BackendResult<()> {
        with_reconnect!(self, conn, conn.put(path, data).await)?;
        Ok(())
    }

    async fn mkdir(&self, path: &str) -> BackendResult<()> {
        with_reconnect!(self, conn, conn.mkdir(path).await)?;
        Ok(())
    }

    async fn remove(&self, path: &str, is_dir: bool) -> BackendResult<()> {
        with_reconnect!(
            self,
            conn,
            if is_dir {
                conn.rmdir(path).await
            } else {
                conn.rm(path).await
            }
        )?;
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> BackendResult<()> {
        with_reconnect!(self, conn, conn.rename(from, to).await)?;
        Ok(())
    }
}

/// An [`AsyncRead`] that serves bytes delivered by the download task over a
/// channel, keeping a leftover buffer for partial reads.
struct ChannelReader {
    rx: mpsc::Receiver<io::Result<Vec<u8>>>,
    leftover: Vec<u8>,
    pos: usize,
    /// Aborts the download task on drop (e.g. a cancelled/stalled download where
    /// the task is blocked reading a dead data connection). Aborting drops the
    /// task's pooled connection, so the broken connection is discarded rather
    /// than returned to the pool.
    abort: tokio::task::AbortHandle,
}

impl ChannelReader {
    fn new(rx: mpsc::Receiver<io::Result<Vec<u8>>>, abort: tokio::task::AbortHandle) -> Self {
        Self {
            rx,
            leftover: Vec::new(),
            pos: 0,
            abort,
        }
    }
}

impl Drop for ChannelReader {
    fn drop(&mut self) {
        // Still-running task = unclean drop (cancel/stall): abort it so its
        // pooled connection is dropped rather than left blocked. A finished
        // download is a no-op.
        if !self.abort.is_finished() {
            self.abort.abort();
        }
    }
}

impl AsyncRead for ChannelReader {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.pos >= this.leftover.len() {
            match this.rx.poll_recv(cx) {
                Poll::Ready(Some(Ok(chunk))) => {
                    this.leftover = chunk;
                    this.pos = 0;
                }
                Poll::Ready(Some(Err(e))) => return Poll::Ready(Err(e)),
                Poll::Ready(None) => return Poll::Ready(Ok(())), // EOF
                Poll::Pending => return Poll::Pending,
            }
        }
        let n = std::cmp::min(buf.remaining(), this.leftover.len() - this.pos);
        buf.put_slice(&this.leftover[this.pos..this.pos + n]);
        this.pos += n;
        Poll::Ready(Ok(()))
    }
}

type ReserveFut =
    Pin<Box<dyn Future<Output = Result<mpsc::OwnedPermit<Vec<u8>>, mpsc::error::SendError<()>>> + Send>>;

/// An [`AsyncWrite`] that hands each chunk to the upload task over a bounded
/// channel (the bound provides backpressure → real progress), and on shutdown
/// closes the channel and awaits the task's finalize result.
struct ChannelWriter {
    tx: Option<mpsc::Sender<Vec<u8>>>,
    reserve: Option<ReserveFut>,
    handle: Option<tokio::task::JoinHandle<BackendResult<()>>>,
    /// Aborts the upload task. Used on drop so a stalled/cancelled transfer
    /// doesn't leave the task blocked on a dead data connection. Aborting drops
    /// the task's pooled connection, discarding the broken connection.
    abort: tokio::task::AbortHandle,
    finish: Option<Pin<Box<dyn Future<Output = io::Result<()>> + Send>>>,
}

impl ChannelWriter {
    fn new(
        tx: mpsc::Sender<Vec<u8>>,
        handle: tokio::task::JoinHandle<BackendResult<()>>,
    ) -> Self {
        Self {
            tx: Some(tx),
            reserve: None,
            abort: handle.abort_handle(),
            handle: Some(handle),
            finish: None,
        }
    }
}

impl Drop for ChannelWriter {
    fn drop(&mut self) {
        // If the task is still running we're being dropped mid-transfer
        // (stall/cancel/error): abort it so its pooled connection is dropped
        // rather than left blocked. A cleanly finished transfer is a no-op.
        if !self.abort.is_finished() {
            self.abort.abort();
        }
    }
}

impl AsyncWrite for ChannelWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let Some(tx) = this.tx.as_ref() else {
            return Poll::Ready(Err(io::Error::other("writer closed")));
        };
        if this.reserve.is_none() {
            this.reserve = Some(Box::pin(tx.clone().reserve_owned()));
        }
        match this.reserve.as_mut().unwrap().as_mut().poll(cx) {
            Poll::Ready(Ok(permit)) => {
                this.reserve = None;
                permit.send(data.to_vec());
                Poll::Ready(Ok(data.len()))
            }
            Poll::Ready(Err(_)) => {
                this.reserve = None;
                Poll::Ready(Err(io::Error::other("upload channel closed")))
            }
            Poll::Pending => Poll::Pending,
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        // Close the channel so the upload task finalizes, then await its result.
        this.reserve = None;
        this.tx = None;
        if this.finish.is_none() {
            let handle = this.handle.take();
            this.finish = Some(Box::pin(async move {
                match handle {
                    Some(h) => match h.await {
                        Ok(Ok(())) => Ok(()),
                        Ok(Err(e)) => Err(io::Error::other(e.to_string())),
                        Err(e) => Err(io::Error::other(e.to_string())),
                    },
                    None => Ok(()),
                }
            }));
        }
        this.finish.as_mut().unwrap().as_mut().poll(cx)
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

#[cfg(test)]
mod tests {
    use super::{default_encryption, default_passive, default_port, fingerprint_of, join_path};

    #[test]
    fn fingerprint_is_uppercase_colon_hex_sha256() {
        // Known SHA-256("abc"), formatted the way the TOFU trust store stores it.
        assert_eq!(
            fingerprint_of(b"abc"),
            "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD"
        );
        // Distinct inputs → distinct fingerprints; same input → stable.
        assert_ne!(fingerprint_of(b"abc"), fingerprint_of(b"abd"));
        assert_eq!(fingerprint_of(b"x"), fingerprint_of(b"x"));
    }

    #[test]
    fn ftp_defaults() {
        assert_eq!(default_port(), 21);
        assert_eq!(default_encryption(), "explicit");
        assert!(default_passive());
    }

    #[test]
    fn join_path_root() {
        assert_eq!(join_path("/", "a"), "/a");
        assert_eq!(join_path("/pub", "a"), "/pub/a");
    }
}
