# Packetboat

A modern, cross-platform file-transfer client — FTP-first, cloud-capable. Think
FileZilla or Cyberduck, but clean, dark by default, and free of adware.

> **Status:** working desktop app. SFTP, FTP/FTPS, and cloud backends (S3,
> Backblaze B2, WebDAV, Google Drive, Dropbox) all run behind one storage
> abstraction. SFTP is confirmed against a live server and B2 against a live
> bucket; the other backends are wired and locally verified but not yet
> exercised against every provider.

## Features

- **Protocols** — SFTP ([`russh`]), FTP/FTPS ([`suppaftp`] + rustls), and cloud
  storage via [Apache OpenDAL] (S3 & S3-compatible, Backblaze B2, WebDAV, Google
  Drive, Dropbox). Every protocol speaks the same [`StorageBackend`] trait, so
  adding a service is configuration, not new plumbing.
- **Dual-pane browser** — local ⇄ remote, each with a folder tree and a file
  list. Tabbed, so several remote connections can be open at once.
- **Transfers** — a queue that **streams** with live per-file progress (no
  whole-file buffering). Drag-and-drop between panes, onto folders, and from
  Explorer; **whole folders transfer recursively**.
- **Connections** — a Quick Connect bar plus a Site Manager with saved sites,
  FileZilla-style logon types, and per-service cloud config. Passwords and cloud
  secrets live in the OS keychain (Windows Credential Manager / macOS Keychain /
  Secret Service) — never the site file.
- **Chrome** — message log, transfer queue, SFTP host-key verification
  (trust-on-first-use with change detection), and a Settings panel with
  dark / light / system theming.

## Stack

- **Tauri 2** — Rust backend, web frontend, small native binaries.
- **Frontend** — plain HTML/CSS/JS (no framework, no bundler). Brand colour
  tokens in `src/theme.css` (+ `components.css`); self-hosted Sora + Space Mono.
- **Backends** — `src-tauri/src/backend/`, each implementing [`StorageBackend`].
  The local filesystem is itself a backend, which keeps the dual pane symmetric.
- **Transfer engine** — `src-tauri/src/transfer.rs`: an async queue that copies
  between any two backends and emits progress events to the UI.

## Project layout

```
src/                     Frontend (HTML/CSS/JS)
  index.html             Dual-pane shell, dialogs, toolbar
  main.js                UI logic; calls Rust via Tauri commands
  styles.css             Layout + app variables (aliased to the theme tokens)
  theme.css              Brand colour tokens (dark + light)
  components.css         Token → component bindings
  fonts.css, fonts/      Self-hosted Sora + Space Mono
  assets/                Logo exports
src-tauri/
  src/lib.rs             Tauri commands + app state
  src/transfer.rs        Streaming transfer queue
  src/backend/mod.rs     StorageBackend trait, Entry types, errors
  src/backend/local.rs   Local filesystem backend
  src/backend/sftp.rs    SFTP (russh + russh-sftp)
  src/backend/ftp.rs     FTP / FTPS (suppaftp + rustls)
  src/backend/cloud.rs   Cloud via OpenDAL (S3, B2, WebDAV, Drive, Dropbox)
  icons/                 App icon set
  .cargo/config.toml     Windows: prebuilt NASM for the crypto backend
```

## Prerequisites

- [Rust](https://rustup.rs/) (stable) and the
  [Tauri 2 system dependencies](https://tauri.app/start/prerequisites/).
- [Node.js](https://nodejs.org/) (for the Tauri CLI only; there is no JS build
  step).

**Windows note:** the rustls/`aws-lc-rs` crypto backend normally needs the NASM
assembler. To keep the build self-contained, `src-tauri/.cargo/config.toml` sets
`AWS_LC_SYS_PREBUILT_NASM=1`, which uses the prebuilt NASM objects shipped with
`aws-lc-sys`. No NASM install is required.

## Develop

```sh
npm install        # installs the Tauri CLI
npm run dev        # tauri dev — launches the app with the Rust backend
```

## Build

```sh
npm run build      # tauri build — produces a native installer
```

## License

Packetboat is licensed under the **GNU General Public License v3.0 or later**
(see [`LICENSE`](LICENSE)).

The **"Packetboat" name and logo are trademarks** and are *not* covered by the
GPL — see [`NOTICE`](NOTICE). Forks are welcome, but must rebrand.

[`StorageBackend`]: src-tauri/src/backend/mod.rs
[`russh`]: https://crates.io/crates/russh
[`russh-sftp`]: https://crates.io/crates/russh-sftp
[`suppaftp`]: https://crates.io/crates/suppaftp
[Apache OpenDAL]: https://opendal.apache.org/
