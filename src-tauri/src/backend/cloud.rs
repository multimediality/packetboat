//! Cloud-storage backend via Apache OpenDAL.
//!
//! One generic adapter wraps an `opendal::Operator` built from a service name +
//! config map (`Operator::via_iter`), so every OpenDAL service — S3, Backblaze
//! B2, WebDAV, and later Google Drive / Dropbox — is reachable through the same
//! [`StorageBackend`] trait without per-service Rust code: adding a service is a
//! Cargo feature plus a frontend form.
//!
//! Transfers stream incrementally: OpenDAL's futures-io reader/writer are
//! bridged to tokio's AsyncRead/AsyncWrite via `tokio_util::compat`, so the
//! transfer engine sees live byte progress and never buffers a whole object.

use std::collections::HashMap;

use async_trait::async_trait;
use opendal::Operator;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::compat::{FuturesAsyncReadCompatExt, FuturesAsyncWriteCompatExt};

use super::{BackendError, BackendKind, BackendResult, Entry, EntryKind, StorageBackend};

pub struct OpendalBackend {
    op: Operator,
}

impl OpendalBackend {
    /// Build an Operator for `service` (e.g. "s3", "webdav", "b2") from the
    /// given config. Returns the backend and the starting directory (root).
    pub async fn connect(
        service: &str,
        config: HashMap<String, String>,
    ) -> BackendResult<(Self, String)> {
        let op = Operator::via_iter(service, config)?;
        Ok((Self { op }, "/".to_string()))
    }
}

#[async_trait]
impl StorageBackend for OpendalBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Cloud
    }

    async fn list(&self, path: &str) -> BackendResult<Vec<Entry>> {
        let dir = to_dir(path);
        let entries = self.op.list(&dir).await?;
        let mut out = Vec::new();
        for entry in entries {
            let opath = entry.path();
            if opath == dir {
                continue; // the directory itself
            }
            let trimmed = opath.trim_end_matches('/');
            if trimmed.is_empty() {
                continue; // root marker
            }
            let name = trimmed.rsplit('/').next().unwrap_or(trimmed);
            if name.is_empty() {
                continue;
            }
            let meta = entry.metadata();
            let kind = if meta.is_dir() {
                EntryKind::Dir
            } else {
                EntryKind::File
            };
            out.push(Entry {
                path: format!("/{trimmed}"),
                name: name.to_string(),
                kind,
                size: meta.content_length(),
                modified: meta
                    .last_modified()
                    .map(|t| t.into_inner().as_second().max(0) as u64),
            });
        }
        Ok(out)
    }

    async fn canonicalize(&self, path: &str) -> BackendResult<String> {
        Ok(if path == "." {
            "/".to_string()
        } else {
            path.to_string()
        })
    }

    async fn open_read(&self, path: &str) -> BackendResult<Box<dyn AsyncRead + Send + Unpin>> {
        let reader = self.op.reader(&to_file(path)).await?;
        let stream = reader.into_futures_async_read(..).await?;
        Ok(Box::new(stream.compat()))
    }

    async fn open_write(&self, path: &str) -> BackendResult<Box<dyn AsyncWrite + Send + Unpin>> {
        let writer = self.op.writer(&to_file(path)).await?;
        Ok(Box::new(writer.into_futures_async_write().compat_write()))
    }

    async fn open_read_at(
        &self,
        path: &str,
        offset: u64,
    ) -> BackendResult<Box<dyn AsyncRead + Send + Unpin>> {
        let reader = self.op.reader(&to_file(path)).await?;
        let stream = reader.into_futures_async_read(offset..).await?;
        Ok(Box::new(stream.compat()))
    }

    async fn open_append(&self, _path: &str) -> BackendResult<Box<dyn AsyncWrite + Send + Unpin>> {
        // Object stores are immutable — there's no append, so a resumed upload
        // would have to re-send the whole object. The UI doesn't offer Resume
        // for cloud uploads; this guards the path if it's reached anyway.
        Err(BackendError::Other(
            "resuming uploads isn't supported for cloud storage".into(),
        ))
    }

    async fn read_file(&self, path: &str) -> BackendResult<Vec<u8>> {
        Ok(self.op.read(&to_file(path)).await?.to_vec())
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> BackendResult<()> {
        self.op.write(&to_file(path), data.to_vec()).await?;
        Ok(())
    }

    async fn mkdir(&self, path: &str) -> BackendResult<()> {
        self.op.create_dir(&to_dir(path)).await?;
        Ok(())
    }

    async fn remove(&self, path: &str, is_dir: bool) -> BackendResult<()> {
        let p = if is_dir { to_dir(path) } else { to_file(path) };
        self.op.delete(&p).await?;
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> BackendResult<()> {
        self.op.rename(&to_file(from), &to_file(to)).await?;
        Ok(())
    }
}

// The frontend uses POSIX-style paths with a leading "/"; OpenDAL uses relative
// paths (no leading slash) where a trailing "/" marks a directory.
fn to_dir(path: &str) -> String {
    let p = path.trim_start_matches('/').trim_end_matches('/');
    if p.is_empty() {
        "/".to_string()
    } else {
        format!("{p}/")
    }
}

fn to_file(path: &str) -> String {
    path.trim_start_matches('/').to_string()
}
