//! The local filesystem as a [`StorageBackend`], so the local pane and the
//! remote pane share one code path.

use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncSeekExt, AsyncWrite};

use super::{BackendKind, BackendResult, Entry, EntryKind, StorageBackend};

pub struct LocalBackend;

#[async_trait]
impl StorageBackend for LocalBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Local
    }

    async fn list(&self, path: &str) -> BackendResult<Vec<Entry>> {
        let mut rd = tokio::fs::read_dir(path).await?;
        let mut entries = Vec::new();
        while let Some(item) = rd.next_entry().await? {
            // Skip entries we can't stat (permissions, broken symlinks) rather
            // than failing the whole listing.
            let Ok(meta) = item.metadata().await else {
                continue;
            };
            let file_type = item.file_type().await?;
            let kind = if file_type.is_symlink() {
                EntryKind::Symlink
            } else if meta.is_dir() {
                EntryKind::Dir
            } else {
                EntryKind::File
            };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            entries.push(Entry {
                name: item.file_name().to_string_lossy().into_owned(),
                path: item.path().to_string_lossy().into_owned(),
                kind,
                size: meta.len(),
                modified,
            });
        }
        Ok(entries)
    }

    async fn canonicalize(&self, path: &str) -> BackendResult<String> {
        let resolved = tokio::fs::canonicalize(path).await?;
        Ok(strip_unc(resolved.to_string_lossy().into_owned()))
    }

    async fn open_read(&self, path: &str) -> BackendResult<Box<dyn AsyncRead + Send + Unpin>> {
        Ok(Box::new(tokio::fs::File::open(path).await?))
    }

    async fn open_write(&self, path: &str) -> BackendResult<Box<dyn AsyncWrite + Send + Unpin>> {
        Ok(Box::new(tokio::fs::File::create(path).await?))
    }

    async fn open_read_at(
        &self,
        path: &str,
        offset: u64,
    ) -> BackendResult<Box<dyn AsyncRead + Send + Unpin>> {
        let mut file = tokio::fs::File::open(path).await?;
        file.seek(std::io::SeekFrom::Start(offset)).await?;
        Ok(Box::new(file))
    }

    async fn open_append(&self, path: &str) -> BackendResult<Box<dyn AsyncWrite + Send + Unpin>> {
        let file = tokio::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .await?;
        Ok(Box::new(file))
    }

    async fn read_file(&self, path: &str) -> BackendResult<Vec<u8>> {
        Ok(tokio::fs::read(path).await?)
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> BackendResult<()> {
        tokio::fs::write(path, data).await?;
        Ok(())
    }

    async fn mkdir(&self, path: &str) -> BackendResult<()> {
        tokio::fs::create_dir(path).await?;
        Ok(())
    }

    async fn remove(&self, path: &str, is_dir: bool) -> BackendResult<()> {
        if is_dir {
            tokio::fs::remove_dir_all(path).await?;
        } else {
            tokio::fs::remove_file(path).await?;
        }
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> BackendResult<()> {
        tokio::fs::rename(from, to).await?;
        Ok(())
    }
}

/// Windows `canonicalize` returns verbatim `\\?\C:\...` paths; trim the prefix
/// so the UI shows a normal `C:\...` path.
fn strip_unc(path: String) -> String {
    path.strip_prefix(r"\\?\")
        .map(str::to_string)
        .unwrap_or(path)
}
