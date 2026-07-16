# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Packetboat is a cross-platform file-transfer client (FTP-first, cloud-capable) built on **Tauri 2**: a Rust backend in `src-tauri/` and a framework-less HTML/CSS/JS frontend in `src/` (no bundler, no JS build step). See [AGENTS.md](AGENTS.md) for how model roles are split when working in this repo.

## Commands

```sh
npm install          # installs the Tauri CLI (the only JS dependency)
npm run dev          # tauri dev — launches the app with the Rust backend
npm run build        # tauri build — native installer (needs signing key, see below)
npm run build:local  # Windows: signed local build (resolves key/password via scripts/signing-key.ps1)

npm test             # frontend unit tests (Node test runner over src/**/*.test.js)
npm run test:rust    # backend unit tests (cargo test --manifest-path src-tauri/Cargo.toml --lib)
```

Run a single test:

```sh
node --test --test-name-pattern "dedupeName" src/util.test.js
cargo test --manifest-path src-tauri/Cargo.toml --lib retry      # filter by test name
```

Rust checks without a full build: `cargo clippy --manifest-path src-tauri/Cargo.toml` / `cargo fmt --manifest-path src-tauri/Cargo.toml`.

### Versioning and releases

**Never hand-edit version numbers.** `scripts/version.mjs` keeps `package.json`, `tauri.conf.json`, `Cargo.toml`, and `Cargo.lock` in sync:

```sh
npm run version:check    # verify all four files match
npm run bump -- patch    # or minor / major / an explicit version like 1.3.0
```

Pushing a tag `vX.Y.Z` triggers `.github/workflows/release.yml`, which builds installers for Windows/macOS/Linux and publishes a GitHub release. Releases are deliberately **not** marked pre-release — the in-app updater reads `releases/latest`, which skips pre-releases.

`npm run build` signs updater artifacts (`createUpdaterArtifacts` is enabled), so it needs `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` in the environment; on Windows use `npm run build:local` instead, which resolves them from `.tauri/packetboat.key` + 1Password / env / a gitignored pass file. The Windows crypto build needs no NASM install — `src-tauri/.cargo/config.toml` sets `AWS_LC_SYS_PREBUILT_NASM=1`.

## Architecture

### Everything is a StorageBackend

The core abstraction is the `StorageBackend` trait in [src-tauri/src/backend/mod.rs](src-tauri/src/backend/mod.rs): `list`, `canonicalize`, streaming `open_read` / `open_write`, and resume variants `open_read_at` / `open_append`, plus mkdir/remove/rename. Four implementations live beside it:

- `local.rs` — the local filesystem **is itself a backend**, which keeps the dual-pane UI and the transfer engine symmetric (upload and download are the same copy loop with source/destination swapped).
- `sftp.rs` — russh + russh-sftp, with trust-on-first-use host-key verification.
- `ftp.rs` — suppaftp + rustls, per-site TLS modes (plain / explicit / implicit), TOFU certificate trust with change detection, and a per-site transfer-connection pool.
- `cloud.rs` — Apache OpenDAL (S3 & S3-compatible, Backblaze B2, WebDAV). Adding a cloud service is configuration, not new plumbing.

Paths are backend-native strings: POSIX-style for remote backends, OS-native for local. `safe_component()` in `mod.rs` is the backend-side guard against path traversal from malicious server listings — don't rely on frontend sanitization alone.

### Command layer and state

[src-tauri/src/lib.rs](src-tauri/src/lib.rs) is the entire Tauri command surface. `AppState` holds a `HashMap<u32, Arc<dyn StorageBackend>>` of live connections — **one id per tab** — shared with the transfer engine. The `Site` struct is the saved-site schema; secrets (passwords, cloud keys, key passphrases) go in the **OS keychain keyed by site id, never the site file**. 1Password sites store only an `op://` reference, resolved via the `op` CLI at connect time.

Connect flows that hit an untrusted/changed host key (SFTP) or certificate (FTPS) don't fail — they return an outcome object with a `hostKeyPrompt` / `certPrompt` for the frontend to confirm, then the connect is retried. Follow this pattern for any new trust decision.

Persisted config (sites, known hosts, trusted certs) lives in `config_dir()` — `%APPDATA%\Packetboat` / `~/Library/Application Support/Packetboat` / `~/.config/Packetboat`.

### Transfer engine

[src-tauri/src/transfer.rs](src-tauri/src/transfer.rs) is an async queue that streams (128 KiB chunks, no whole-file buffering) between any two backends, with configurable concurrency, automatic retry on transient errors, a 60 s stall timeout, and resume via `resume_offset`. It reports to the frontend solely through the `transfer://update` Tauri event, throttled by bytes and time.

### Frontend

- [src/main.js](src/main.js) — all UI logic (~4.5k lines, single module). Talks to Rust exclusively via `window.__TAURI__.core.invoke` and Tauri events; the Tauri API is guarded so the shell still renders in a plain browser.
- [src/util.js](src/util.js) — **pure helpers only** (path/name munging, FileZilla import parsing, op:// reference cleanup), kept dependency-free so they run under the Node test runner ([src/util.test.js](src/util.test.js)). New pure logic goes here, with tests.
- Theming is layered: `theme.css` (brand color tokens, dark + light) → `components.css` (token → component bindings) → `styles.css` (layout + app variables). Dark is the default; light is `:root[data-theme="light"]`.

### Testing conventions

Rust tests are `#[cfg(test)]` modules at the bottom of the file they cover, focused on pure helpers prone to silent regression (path conventions, retry heuristic, `Site` defaults, cert fingerprinting, op:// parsing). Frontend tests cover `util.js` only — UI logic in `main.js` is not unit-tested. There is no lint/format step for the JS side.

## Notes

- `docs/TODO.md` tracks bugs/ideas; `docs/1password-integration.md` documents the 1Password logon type.
- The "Packetboat" name and logo are trademarks not covered by the GPL (see `NOTICE`).
- Ignore `src-tauri/target/` and `node_modules/` when searching; they dominate the file tree.
