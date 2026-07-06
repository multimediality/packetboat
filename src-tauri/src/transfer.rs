//! Transfer engine: a sequential queue that streams files between any two
//! [`StorageBackend`]s (local <-> remote) and reports progress to the frontend
//! via Tauri events. Because both panes are backends, "upload" and "download"
//! are just the same copy loop with the source and destination swapped.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{async_runtime, AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex, Notify};

use crate::backend::{local::LocalBackend, BackendError, BackendResult, StorageBackend};

/// All live remote connections, keyed by id, shared between the command layer
/// and the transfer worker so a queued transfer targets the right session.
pub type Connections = Arc<Mutex<HashMap<u32, Arc<dyn StorageBackend>>>>;

/// Event name the frontend listens on for queue updates.
const EVENT: &str = "transfer://update";

/// Chunk size for the copy loop.
const CHUNK: usize = 128 * 1024;

/// Re-emit progress at most this often (by bytes) to avoid flooding the UI.
const PROGRESS_STEP: u64 = 512 * 1024;

/// Also re-emit progress on this time interval even if under [`PROGRESS_STEP`],
/// so slow links still get regular updates (the UI derives speed from them).
const PROGRESS_TICK: Duration = Duration::from_millis(500);

/// How many times to automatically retry a transfer that fails with a transient
/// (connection-like) error before giving up. Set fairly high because some
/// servers are flaky on the data connection (intermittent 451s), and a retry
/// almost always succeeds.
const MAX_RETRIES: u32 = 4;

/// If a single read or write makes no progress for this long, the transfer is
/// treated as stalled and fails (rather than hanging the queue forever).
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// How a single transfer attempt ended.
enum Outcome {
    Done,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    /// Remote -> local.
    Download,
    /// Local -> remote.
    Upload,
}

/// A transfer the frontend asks for. The destination is given as a directory
/// plus the file name so the engine can join it with the destination
/// backend's own path style.
#[derive(Debug, Clone, Deserialize)]
pub struct TransferRequest {
    pub direction: Direction,
    /// Which remote connection this transfer's remote side belongs to.
    #[serde(default)]
    pub connection_id: u32,
    pub src: String,
    pub dst_dir: String,
    pub name: String,
    #[serde(default)]
    pub size: u64,
    /// When set, resume: read the source from this byte offset and append to the
    /// (partially-transferred) destination instead of truncating it.
    #[serde(default)]
    pub resume_offset: Option<u64>,
}

/// Queue update sent to the frontend. Serializes with an `event` tag, e.g.
/// `{ "event": "progress", "id": 3, "transferred": 1024, "size": 4096 }`.
#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "lowercase")]
enum Update {
    Queued {
        id: u64,
        name: String,
        direction: Direction,
        size: u64,
        /// Source path (remote for downloads, local for uploads) and destination
        /// directory — so the queue UI can show the full local + remote paths.
        src: String,
        dst_dir: String,
        /// The remote connection this transfer belongs to, so the queue can label
        /// each row with its server.
        connection_id: u32,
    },
    Start {
        id: u64,
    },
    Progress {
        id: u64,
        transferred: u64,
        size: u64,
    },
    /// A transient failure is being retried (attempt N of `max`).
    Retry {
        id: u64,
        attempt: u32,
        max: u32,
        /// The error that triggered the retry, surfaced to the log.
        message: String,
    },
    Done {
        id: u64,
    },
    Cancelled {
        id: u64,
    },
    Error {
        id: u64,
        message: String,
    },
}

/// Runtime concurrency limits (settable from the frontend). A dispatcher pulls
/// queued jobs and runs up to `max` at once, respecting the per-direction caps.
struct Limits {
    max: AtomicUsize,    // overall simultaneous transfers (>= 1)
    max_dl: AtomicUsize, // per-direction cap; 0 = unlimited
    max_ul: AtomicUsize,
    active: AtomicUsize,
    active_dl: AtomicUsize,
    active_ul: AtomicUsize,
    slot_freed: Notify, // wakes the dispatcher when a slot frees or a limit rises
}

impl Limits {
    fn new() -> Self {
        Self {
            max: AtomicUsize::new(2), // FileZilla's default
            max_dl: AtomicUsize::new(0),
            max_ul: AtomicUsize::new(0),
            active: AtomicUsize::new(0),
            active_dl: AtomicUsize::new(0),
            active_ul: AtomicUsize::new(0),
            slot_freed: Notify::new(),
        }
    }

    fn set(&self, max: usize, dl: usize, ul: usize) {
        self.max.store(max.max(1), Ordering::Relaxed);
        self.max_dl.store(dl, Ordering::Relaxed);
        self.max_ul.store(ul, Ordering::Relaxed);
        self.slot_freed.notify_one(); // a raised limit may open slots
    }

    fn dir_counters(&self, dir: Direction) -> (&AtomicUsize, &AtomicUsize) {
        match dir {
            Direction::Download => (&self.active_dl, &self.max_dl),
            Direction::Upload => (&self.active_ul, &self.max_ul),
        }
    }

    fn has_slot(&self, dir: Direction) -> bool {
        if self.active.load(Ordering::Relaxed) >= self.max.load(Ordering::Relaxed) {
            return false;
        }
        let (active, max) = self.dir_counters(dir);
        let m = max.load(Ordering::Relaxed);
        m == 0 || active.load(Ordering::Relaxed) < m
    }

    fn acquire(&self, dir: Direction) {
        self.active.fetch_add(1, Ordering::Relaxed);
        self.dir_counters(dir).0.fetch_add(1, Ordering::Relaxed);
    }

    fn release(&self, dir: Direction) {
        self.active.fetch_sub(1, Ordering::Relaxed);
        self.dir_counters(dir).0.fetch_sub(1, Ordering::Relaxed);
        self.slot_freed.notify_one();
    }
}

/// Owns the queue. A dispatcher runs jobs concurrently up to the current limits.
pub struct TransferManager {
    app: AppHandle,
    tx: mpsc::UnboundedSender<(u64, TransferRequest)>,
    next_id: AtomicU64,
    /// Ids the user has asked to cancel — checked when a job is pulled (queued)
    /// and on each chunk (running).
    cancel: Arc<StdMutex<HashSet<u64>>>,
    limits: Arc<Limits>,
}

impl TransferManager {
    /// Spawn the dispatcher and return a handle for enqueuing.
    pub fn start(app: AppHandle, connections: Connections) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<(u64, TransferRequest)>();
        let cancel: Arc<StdMutex<HashSet<u64>>> = Arc::new(StdMutex::new(HashSet::new()));
        let limits = Arc::new(Limits::new());
        let d_app = app.clone();
        let d_cancel = cancel.clone();
        let d_limits = limits.clone();
        async_runtime::spawn(async move {
            while let Some((id, req)) = rx.recv().await {
                let dir = req.direction;
                // Wait for a free slot for this transfer's direction, then run it
                // concurrently so other transfers keep flowing.
                while !d_limits.has_slot(dir) {
                    d_limits.slot_freed.notified().await;
                }
                d_limits.acquire(dir);
                let app = d_app.clone();
                let cancel = d_cancel.clone();
                let limits = d_limits.clone();
                let conns = connections.clone();
                tokio::spawn(async move {
                    run_one(&app, &conns, id, req, &cancel).await;
                    limits.release(dir);
                });
            }
        });
        Self {
            app,
            tx,
            next_id: AtomicU64::new(1),
            cancel,
            limits,
        }
    }

    /// Apply new concurrency limits (overall max, per-direction caps; 0 = none).
    pub fn set_limits(&self, max: usize, downloads: usize, uploads: usize) {
        self.limits.set(max, downloads, uploads);
    }

    /// Add a transfer to the queue and return its id.
    pub fn enqueue(&self, req: TransferRequest) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        emit(
            &self.app,
            Update::Queued {
                id,
                name: req.name.clone(),
                direction: req.direction,
                size: req.size,
                src: req.src.clone(),
                dst_dir: req.dst_dir.clone(),
                connection_id: req.connection_id,
            },
        );
        let _ = self.tx.send((id, req));
        id
    }

    /// Request cancellation of a queued or in-flight transfer.
    pub fn cancel(&self, id: u64) {
        self.cancel.lock().unwrap().insert(id);
    }
}

/// Remove `id` from the cancel set, returning whether it was present.
fn take_cancel(cancel: &StdMutex<HashSet<u64>>, id: u64) -> bool {
    cancel.lock().unwrap().remove(&id)
}

/// Process one transfer end to end: emit Start, run with retry/backoff, then
/// emit the final result. Run concurrently by the dispatcher.
async fn run_one(
    app: &AppHandle,
    connections: &Connections,
    id: u64,
    req: TransferRequest,
    cancel: &Arc<StdMutex<HashSet<u64>>>,
) {
    // Cancelled while still sitting in the queue?
    if take_cancel(cancel, id) {
        emit(app, Update::Cancelled { id });
        return;
    }
    emit(app, Update::Start { id });
    let mut attempt = 0u32;
    let result = loop {
        match run(app, connections, id, &req, cancel).await {
            Ok(Outcome::Done) => break Update::Done { id },
            Ok(Outcome::Cancelled) => break Update::Cancelled { id },
            Err(e) if attempt < MAX_RETRIES && is_retryable(&e) => {
                attempt += 1;
                let message = e.to_string();
                eprintln!("[transfer {id}] attempt {attempt} failed (retrying): {message}");
                emit(
                    app,
                    Update::Retry {
                        id,
                        attempt,
                        max: MAX_RETRIES,
                        message,
                    },
                );
                tokio::time::sleep(Duration::from_millis(700 * attempt as u64)).await;
                if take_cancel(cancel, id) {
                    break Update::Cancelled { id };
                }
            }
            Err(e) => {
                let message = e.to_string();
                eprintln!("[transfer {id}] failed: {message}");
                break Update::Error { id, message };
            }
        }
    };
    // Drop any lingering cancel request now the job is finished.
    cancel.lock().unwrap().remove(&id);
    emit(app, result);
}

/// Heuristic: which failures are worth an automatic retry — transient,
/// connection-level errors rather than permanent ones (auth, not-found).
fn is_retryable(e: &BackendError) -> bool {
    let m = e.to_string().to_lowercase();
    [
        "timeout",
        "timed out",
        "connection",
        "reset",
        "aborted",
        "broken pipe",
        "10053",
        "10054",
        " eof",
        "421",
        "temporar",
        // A stalled transfer retries: the stalled attempt's pooled connection is
        // dropped, so the retry runs on a fresh connection, which often clears a
        // server-side lock (e.g. re-uploading a file just downloaded).
        "stall",
    ]
    .iter()
    .any(|p| m.contains(p))
}

fn emit(app: &AppHandle, update: Update) {
    let _ = app.emit(EVENT, update);
}

async fn run(
    app: &AppHandle,
    connections: &Connections,
    id: u64,
    req: &TransferRequest,
    cancel: &StdMutex<HashSet<u64>>,
) -> BackendResult<Outcome> {
    let local: Arc<dyn StorageBackend> = Arc::new(LocalBackend);
    let remote_be = {
        let guard = connections.lock().await;
        guard
            .get(&req.connection_id)
            .ok_or(BackendError::NotConnected)?
            .clone()
    };

    let (src_be, dst_be): (Arc<dyn StorageBackend>, Arc<dyn StorageBackend>) = match req.direction {
        Direction::Download => (remote_be, local),
        Direction::Upload => (local, remote_be),
    };

    // The destination file name must be a single, safe component. On download
    // it comes from the remote server's listing; a name with separators or ".."
    // could otherwise escape the chosen directory (path traversal).
    crate::backend::safe_component(&req.name)?;

    // Join the destination directory and file name using the destination's
    // path convention (OS-native locally, POSIX remotely).
    let dst = match req.direction {
        Direction::Download => Path::new(&req.dst_dir)
            .join(&req.name)
            .to_string_lossy()
            .into_owned(),
        Direction::Upload => format!("{}/{}", req.dst_dir.trim_end_matches('/'), req.name),
    };

    // Resume picks up from the partial destination's length: read the source
    // from that offset and append, rather than re-reading + truncating.
    let (mut reader, mut writer) = match req.resume_offset {
        Some(offset) if offset > 0 => (
            src_be.open_read_at(&req.src, offset).await?,
            dst_be.open_append(&dst).await?,
        ),
        _ => (
            src_be.open_read(&req.src).await?,
            dst_be.open_write(&dst).await?,
        ),
    };

    let mut buf = vec![0u8; CHUNK];
    let mut transferred = req.resume_offset.unwrap_or(0);
    let mut last_emit = 0u64;
    let mut last_emit_at = Instant::now();
    loop {
        let n = match guarded(reader.read(&mut buf), id, cancel).await? {
            Some(n) => n,
            None => return Ok(Outcome::Cancelled),
        };
        if n == 0 {
            break;
        }
        if guarded(writer.write_all(&buf[..n]), id, cancel).await?.is_none() {
            return Ok(Outcome::Cancelled);
        }
        transferred += n as u64;
        if transferred - last_emit >= PROGRESS_STEP
            || (transferred > last_emit && last_emit_at.elapsed() >= PROGRESS_TICK)
        {
            last_emit = transferred;
            last_emit_at = Instant::now();
            emit(
                app,
                Update::Progress {
                    id,
                    transferred,
                    size: req.size,
                },
            );
        }
    }
    if guarded(
        async {
            writer.flush().await?;
            writer.shutdown().await
        },
        id,
        cancel,
    )
    .await?
    .is_none()
    {
        return Ok(Outcome::Cancelled);
    }

    emit(
        app,
        Update::Progress {
            id,
            transferred,
            size: req.size.max(transferred),
        },
    );
    Ok(Outcome::Done)
}

/// Drive an I/O future while staying responsive to cancellation and bailing if
/// it stalls. Polls the op in short slices: returns `Ok(Some(v))` when it
/// completes, `Ok(None)` if the user cancelled, or `Err` if it made no progress
/// for [`STALL_TIMEOUT`] (which prevents a dead connection hanging the queue).
async fn guarded<T>(
    op: impl std::future::Future<Output = std::io::Result<T>>,
    id: u64,
    cancel: &StdMutex<HashSet<u64>>,
) -> BackendResult<Option<T>> {
    tokio::pin!(op);
    let start = std::time::Instant::now();
    loop {
        if cancel.lock().unwrap().contains(&id) {
            return Ok(None);
        }
        match tokio::time::timeout(Duration::from_millis(150), op.as_mut()).await {
            Ok(r) => return Ok(Some(r?)),
            Err(_) => {
                if start.elapsed() >= STALL_TIMEOUT {
                    return Err(BackendError::Other(
                        "transfer stalled: no data moved for 60s".into(),
                    ));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_retryable;
    use crate::backend::BackendError;

    #[test]
    fn transient_errors_retry() {
        for m in [
            "connection reset by peer",
            "operation timed out",
            "451 Error during read from data connection",
            "broken pipe",
            "os error 10054",
            "421 service not available",
            "transfer stalled: no data moved for 60s",
        ] {
            assert!(is_retryable(&BackendError::Other(m.into())), "should retry: {m}");
        }
    }

    #[test]
    fn permanent_errors_do_not_retry() {
        for m in [
            "550 permission denied",
            "no such file or directory",
            "authentication failed",
        ] {
            assert!(!is_retryable(&BackendError::Other(m.into())), "should not retry: {m}");
        }
    }
}
