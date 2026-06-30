//! Transfer engine: a sequential queue that streams files between any two
//! [`StorageBackend`]s (local <-> remote) and reports progress to the frontend
//! via Tauri events. Because both panes are backends, "upload" and "download"
//! are just the same copy loop with the source and destination swapped.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{async_runtime, AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex};

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

/// How many times to automatically retry a transfer that fails with a transient
/// (connection-like) error before giving up.
const MAX_RETRIES: u32 = 2;

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

/// Owns the queue. Jobs are processed one at a time by a background worker.
pub struct TransferManager {
    app: AppHandle,
    tx: mpsc::UnboundedSender<(u64, TransferRequest)>,
    next_id: AtomicU64,
    /// Ids the user has asked to cancel — checked when a job is pulled (queued)
    /// and on each chunk (running).
    cancel: Arc<StdMutex<HashSet<u64>>>,
}

impl TransferManager {
    /// Spawn the worker and return a handle for enqueuing.
    pub fn start(app: AppHandle, connections: Connections) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<(u64, TransferRequest)>();
        let cancel: Arc<StdMutex<HashSet<u64>>> = Arc::new(StdMutex::new(HashSet::new()));
        let worker_app = app.clone();
        let worker_cancel = cancel.clone();
        async_runtime::spawn(async move {
            while let Some((id, req)) = rx.recv().await {
                // Cancelled while still sitting in the queue?
                if take_cancel(&worker_cancel, id) {
                    emit(&worker_app, Update::Cancelled { id });
                    continue;
                }
                emit(&worker_app, Update::Start { id });

                let mut attempt = 0u32;
                let result = loop {
                    match run(&worker_app, &connections, id, &req, &worker_cancel).await {
                        Ok(Outcome::Done) => break Update::Done { id },
                        Ok(Outcome::Cancelled) => break Update::Cancelled { id },
                        Err(e) if attempt < MAX_RETRIES && is_retryable(&e) => {
                            attempt += 1;
                            emit(
                                &worker_app,
                                Update::Retry {
                                    id,
                                    attempt,
                                    max: MAX_RETRIES,
                                },
                            );
                            tokio::time::sleep(Duration::from_millis(700 * attempt as u64)).await;
                            if take_cancel(&worker_cancel, id) {
                                break Update::Cancelled { id };
                            }
                        }
                        Err(e) => {
                            break Update::Error {
                                id,
                                message: e.to_string(),
                            }
                        }
                    }
                };
                // Drop any lingering cancel request now the job is finished.
                worker_cancel.lock().unwrap().remove(&id);
                emit(&worker_app, result);
            }
        });
        Self {
            app,
            tx,
            next_id: AtomicU64::new(1),
            cancel,
        }
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
    loop {
        if cancel.lock().unwrap().contains(&id) {
            return Ok(Outcome::Cancelled);
        }
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n]).await?;
        transferred += n as u64;
        if transferred - last_emit >= PROGRESS_STEP {
            last_emit = transferred;
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
    writer.flush().await?;
    writer.shutdown().await?;

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
