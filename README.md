# Packetboat

A modern, cross-platform file-transfer client — FTP-first, cloud-capable. A
clean dual-pane client, dark by default and free of adware.

> **Status:** working desktop app. SFTP, FTP/FTPS, and cloud backends (S3 &
> S3-compatible, Backblaze B2, WebDAV) all run behind one storage abstraction.
> SFTP and FTP/FTPS are confirmed against live servers and B2 against a live
> bucket; S3 and WebDAV are wired and locally verified but not yet exercised
> against every provider.

## Features

- **Protocols** — SFTP ([`russh`]), FTP/FTPS ([`suppaftp`] + rustls), and cloud
  storage via [Apache OpenDAL] (S3 & S3-compatible, Backblaze B2, WebDAV). Every
  protocol speaks the same [`StorageBackend`] trait, so adding a service is
  configuration, not new plumbing.
- **FTP security** — selectable encryption per site (require explicit TLS,
  opportunistic, implicit, or plain) plus a trust-on-first-use prompt for unknown
  or mismatched server certificates, with change detection.
- **Dual-pane browser** — local ⇄ remote, each with a folder tree and a file
  list. Tabbed, so several remote connections can be open at once (each tab keeps
  its own local + remote folder). **Multi-select** (click / Ctrl / Shift / marquee
  drag) and **type-ahead** (type a name to jump to it). Optional **synchronized
  browsing** mirrors navigation between the two panes.
- **Transfers** — a queue that **streams** with live per-file progress (no
  whole-file buffering), running **several at once** (configurable, with per-site
  connection pooling for FTP). Drag-and-drop between panes, onto folders, and
  from Explorer; **whole folders transfer recursively**. Interrupted transfers
  can **resume** (SFTP and FTP both ways, plus cloud downloads).
- **Conflict handling** — when a file already exists, overwrite, keep the
  newer / larger, resume, auto-rename, or skip — per transfer, for the session,
  or as a saved default for uploads and downloads.
- **Connections** — a Quick Connect bar plus a Site Manager with saved sites,
  per-site logon types, and per-service cloud config. Passwords and cloud
  secrets live in the OS keychain (Windows Credential Manager / macOS Keychain /
  Secret Service) — never the site file. A **1Password** logon type resolves an
  `op://` secret reference at connect time, and sites **import** from a FileZilla
  XML export.
- **Desktop integration** — optional **close-to-system-tray**, **desktop
  notifications** when the queue finishes in the background (click to open the
  app), and **auto-updates** from signed GitHub releases (on-launch / daily /
  weekly / monthly, plus a manual check).
- **Chrome** — message log, transfer queue, SFTP host-key verification
  (trust-on-first-use with change detection), and a Settings panel (General /
  Transfers / Updates tabs) with dark / light / system theming.

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
  util.js                Pure helpers (paths/names/references), unit-tested
  util.test.js           Node test-runner tests for util.js
  styles.css             Layout + app variables (aliased to the theme tokens)
  theme.css              Brand colour tokens (dark + light)
  components.css         Token → component bindings
  fonts.css, fonts/      Self-hosted Sora + Space Mono
  assets/                Logo exports
src-tauri/
  src/lib.rs             Tauri commands + app state (unit tests at the bottom)
  src/transfer.rs        Streaming transfer queue + concurrency dispatcher
  src/toast.rs           Windows-branded toast notifications
  src/backend/mod.rs     StorageBackend trait, Entry types, errors
  src/backend/local.rs   Local filesystem backend
  src/backend/sftp.rs    SFTP (russh + russh-sftp)
  src/backend/ftp.rs     FTP / FTPS (suppaftp + rustls) + transfer-connection pool
  src/backend/cloud.rs   Cloud via OpenDAL (S3, B2, WebDAV)
  icons/                 App icon set
  .cargo/config.toml     Windows: prebuilt NASM for the crypto backend
scripts/                 Build + release helpers
  version.mjs            Version source of truth (check / set / bump all files)
  build-local.ps1        Signed local build (injects the updater key + password)
  signing-key.ps1        Resolves the signing key/password (env / 1Password / file)
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

## Test

```sh
npm test           # frontend unit tests (Node test runner — src/**/*.test.js)
npm run test:rust  # backend unit tests (cargo test --lib)
```

Frontend tests cover the pure helpers in [`src/util.js`](src/util.js) (path/name
munging, the FileZilla RemoteDir parser, 1Password-reference cleanup). Backend
tests live alongside their code as `#[cfg(test)]` modules and cover the pure
helpers that are prone to silent regressions — path conventions, the retry
heuristic, `Site` config defaults, certificate fingerprinting, and the 1Password
error/reference parsing.

## Releases

Pushing a version tag (e.g. `v0.1.0`) triggers the
[release workflow](.github/workflows/release.yml), which builds and **publishes**
a GitHub release with installers for Windows, macOS (Intel + Apple Silicon), and
Linux. Releases are published as normal (non-pre-release) releases on purpose:
GitHub's `releases/latest` — the in-app updater endpoint — skips pre-releases, so
marking them pre-release would hide every build from the updater.

Bump the version with the sync script ([scripts/version.mjs](scripts/version.mjs))
so `package.json`, `tauri.conf.json`, `Cargo.toml`, and `Cargo.lock` never drift:

```sh
npm run version:check          # print each file's version + verify they match
npm run bump -- 0.5.0          # set an explicit version everywhere
npm run bump -- patch          # or bump patch / minor / major
```

Then commit and tag: `git tag v0.5.0 && git push --tags`.

### Local builds

`npm run build` (`tauri build`) produces the installers under
`src-tauri/target/release/bundle/{msi,nsis}/` plus the portable
`target/release/packetboat.exe`. The NASM requirement for the crypto backend is
already handled by [`src-tauri/.cargo/config.toml`](src-tauri/.cargo/config.toml).

Because `createUpdaterArtifacts` is enabled, a build signs the updater bundle and
therefore needs the signing key + password in the environment. On Windows,
**`npm run build:local`** ([scripts/build-local.ps1](scripts/build-local.ps1))
handles that: it loads the private key from `.tauri/packetboat.key` and resolves
the password without exposing it, trying, in order — the
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` env var, **1Password** (`op read` of
`$env:PACKETBOAT_OP_PASSWORD_REF`, default `op://Development/Packetboat/h45hpkrdaxawvnuhnk62iutvge`),
a gitignored `.tauri/packetboat.key.pass` file, then an interactive prompt. When
`$env:OP_SERVICE_ACCOUNT_TOKEN` is set (a user-scope env var, e.g. in
`HKCU\Environment`), `op` authenticates with it automatically — no biometric
prompt; otherwise it falls back to your signed-in 1Password desktop-app session.
Override `PACKETBOAT_OP_PASSWORD_REF` for a different item (or edit the default
in [scripts/signing-key.ps1](scripts/signing-key.ps1)). CI signs from GitHub
secrets and doesn't use this script.

## Auto-updates

Packetboat can check for updates automatically and prompt to install. **Settings
→ Updates** exposes a toggle to check automatically, a frequency (on every
launch / daily / weekly / monthly), and a **Check now** button for an on-demand
check. It uses the [Tauri updater](https://tauri.app/plugin/updater/): the app
fetches a signed `latest.json` from the latest GitHub release and verifies the
update signature against a public key baked into the build. **One-time setup
before this works:**

1. Generate a signing keypair (keep the private key safe — it can't be
   recovered):
   ```sh
   npm run tauri signer generate -- -w packetboat.key
   ```
2. Put the **public** key in `src-tauri/tauri.conf.json` under
   `plugins.updater.pubkey` (replacing the `REPLACE_WITH_…` placeholder).
3. Add the **private** key and its password as GitHub Actions repository
   secrets named `TAURI_SIGNING_PRIVATE_KEY` and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

With `bundle.createUpdaterArtifacts` enabled, the release workflow then signs
each build and publishes `latest.json` alongside the installers, so tagged
releases are picked up automatically. Until the key is set, the update check
simply no-ops.

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
