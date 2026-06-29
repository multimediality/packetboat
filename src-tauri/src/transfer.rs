//! Transfer engine: a sequential queue that streams files between any two
//! [`StorageBackend`]s (local <-> remote) and reports progress to the frontend
//! via Tauri events. Because both panes are backends, "upload" and "download"
//! are just the same copy loop with the source and destination swapped.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

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
    Done {
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
}

impl TransferManager {
    /// Spawn the worker and return a handle for enqueuing.
    pub fn start(app: AppHandle, connections: Connections) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<(u64, TransferRequest)>();
        let worker_app = app.clone();
        async_runtime::spawn(async move {
            while let Some((id, req)) = rx.recv().await {
                emit(&worker_app, Update::Start { id });
                match run(&worker_app, &connections, id, &req).await {
                    Ok(()) => emit(&worker_app, Update::Done { id }),
                    Err(e) => emit(
                        &worker_app,
                        Update::Error {
                            id,
                            message: e.to_string(),
                        },
                    ),
                }
            }
        });
        Self {
            app,
            tx,
            next_id: AtomicU64::new(1),
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
}

fn emit(app: &AppHandle, update: Update) {
    let _ = app.emit(EVENT, update);
}

async fn run(
    app: &AppHandle,
    connections: &Connections,
    id: u64,
    req: &TransferRequest,
) -> BackendResult<()> {
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

    let mut reader = src_be.open_read(&req.src).await?;
    let mut writer = dst_be.open_write(&dst).await?;

    let mut buf = vec![0u8; CHUNK];
    let mut transferred = 0u64;
    let mut last_emit = 0u64;
    loop {
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
    Ok(())
}
