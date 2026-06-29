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

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::str::FromStr;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use serde::Deserialize;
use suppaftp::list::File as FtpListItem;
use suppaftp::tokio::{AsyncFtpStream, AsyncRustlsConnector, AsyncRustlsFtpStream};
use suppaftp::tokio_rustls::rustls::crypto::aws_lc_rs;
use suppaftp::tokio_rustls::rustls::{ClientConfig, RootCertStore};
use suppaftp::tokio_rustls::TlsConnector as RustlsTlsConnector;
use suppaftp::types::FileType;
use suppaftp::FtpResult;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::sync::mpsc;
use tokio::sync::Mutex;

/// Chunk size for the streaming data pump.
const STREAM_CHUNK: usize = 128 * 1024;

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
    /// When true, upgrade to FTPS (explicit TLS) before login.
    #[serde(default)]
    pub secure: bool,
}

fn default_port() -> u16 {
    21
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

    async fn list(&mut self, path: &str) -> FtpResult<Vec<String>> {
        match self {
            Conn::Plain(s) => s.list(Some(path)).await,
            Conn::Secure(s) => s.list(Some(path)).await,
        }
    }

    /// Download a whole file into memory (handles the retr stream + finalize).
    async fn retr_all(&mut self, path: &str) -> BackendResult<Vec<u8>> {
        macro_rules! read_all {
            ($s:expr) => {{
                let mut stream = $s.retr_as_stream(path).await?;
                let mut buf = Vec::new();
                stream.read_to_end(&mut buf).await?;
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
    async fn stream_download(
        &mut self,
        path: &str,
        tx: mpsc::Sender<io::Result<Vec<u8>>>,
    ) -> BackendResult<()> {
        macro_rules! pump {
            ($s:expr) => {{
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
    /// they arrive, then finalize.
    async fn stream_upload(
        &mut self,
        path: &str,
        mut rx: mpsc::Receiver<Vec<u8>>,
    ) -> BackendResult<()> {
        macro_rules! pump {
            ($s:expr) => {{
                let mut stream = $s.put_with_stream(path).await?;
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

pub struct FtpBackend {
    conn: Arc<Mutex<Conn>>,
}

impl FtpBackend {
    /// Connect, optionally upgrade to TLS, and log in. Returns the backend and
    /// the server's working directory (the pane's starting path).
    pub async fn connect(config: &FtpConfig) -> BackendResult<(Self, String)> {
        let addr = (config.host.as_str(), config.port);

        let mut conn = if config.secure {
            // Explicit FTPS: connect, then upgrade the control connection.
            let mut roots = RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let tls_config =
                ClientConfig::builder_with_provider(Arc::new(aws_lc_rs::default_provider()))
                    .with_safe_default_protocol_versions()
                    .map_err(|e| BackendError::Ftp(e.to_string()))?
                    .with_root_certificates(roots)
                    .with_no_client_auth();
            let connector =
                AsyncRustlsConnector::from(RustlsTlsConnector::from(Arc::new(tls_config)));
            let secure = AsyncRustlsFtpStream::connect(addr)
                .await?
                .into_secure(connector, &config.host)
                .await?;
            Conn::Secure(secure)
        } else {
            Conn::Plain(AsyncFtpStream::connect(addr).await?)
        };

        // Blank username means anonymous FTP.
        let user = if config.username.is_empty() {
            "anonymous"
        } else {
            config.username.as_str()
        };
        conn.login(user, &config.password).await?;
        conn.set_binary().await?;

        let home = conn.pwd().await.unwrap_or_else(|_| "/".to_string());
        Ok((
            Self {
                conn: Arc::new(Mutex::new(conn)),
            },
            home,
        ))
    }
}

#[async_trait]
impl StorageBackend for FtpBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Ftp
    }

    async fn list(&self, path: &str) -> BackendResult<Vec<Entry>> {
        let lines = self.conn.lock().await.list(path).await?;
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
            Ok(self.conn.lock().await.pwd().await?)
        } else {
            Ok(path.to_string())
        }
    }

    async fn open_read(&self, path: &str) -> BackendResult<Box<dyn AsyncRead + Send + Unpin>> {
        let (tx, rx) = mpsc::channel::<io::Result<Vec<u8>>>(4);
        let conn = self.conn.clone();
        let path = path.to_string();
        // Own the connection lock for the whole download; the channel feeds the
        // engine as bytes arrive.
        tokio::spawn(async move {
            let mut guard = conn.lock_owned().await;
            if let Err(e) = guard.stream_download(&path, tx.clone()).await {
                let _ = tx.send(Err(io::Error::other(e.to_string()))).await;
            }
        });
        Ok(Box::new(ChannelReader::new(rx)))
    }

    async fn open_write(&self, path: &str) -> BackendResult<Box<dyn AsyncWrite + Send + Unpin>> {
        let (tx, rx) = mpsc::channel::<Vec<u8>>(4);
        let conn = self.conn.clone();
        let path = path.to_string();
        let handle = tokio::spawn(async move {
            let mut guard = conn.lock_owned().await;
            guard.stream_upload(&path, rx).await
        });
        Ok(Box::new(ChannelWriter::new(tx, handle)))
    }

    async fn read_file(&self, path: &str) -> BackendResult<Vec<u8>> {
        self.conn.lock().await.retr_all(path).await
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> BackendResult<()> {
        self.conn.lock().await.put(path, data).await?;
        Ok(())
    }

    async fn mkdir(&self, path: &str) -> BackendResult<()> {
        self.conn.lock().await.mkdir(path).await?;
        Ok(())
    }

    async fn remove(&self, path: &str, is_dir: bool) -> BackendResult<()> {
        let mut conn = self.conn.lock().await;
        if is_dir {
            conn.rmdir(path).await?;
        } else {
            conn.rm(path).await?;
        }
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> BackendResult<()> {
        self.conn.lock().await.rename(from, to).await?;
        Ok(())
    }
}

/// An [`AsyncRead`] that serves bytes delivered by the download task over a
/// channel, keeping a leftover buffer for partial reads.
struct ChannelReader {
    rx: mpsc::Receiver<io::Result<Vec<u8>>>,
    leftover: Vec<u8>,
    pos: usize,
}

impl ChannelReader {
    fn new(rx: mpsc::Receiver<io::Result<Vec<u8>>>) -> Self {
        Self {
            rx,
            leftover: Vec::new(),
            pos: 0,
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
            handle: Some(handle),
            finish: None,
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
