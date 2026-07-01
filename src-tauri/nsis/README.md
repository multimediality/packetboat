# Vendored NSIS installer template

`installer.nsi` is a **verbatim copy of Tauri's stock NSIS template** with a
single one-line change, wired in via `bundle.windows.nsis.template` in
`tauri.conf.json`.

## The only change

Tauri ships the installer with **"Create desktop shortcut" checked by default**.
We leave it **unchecked** by default (the user can still opt in) by adding one
define next to the finish-page block:

```nsi
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED   ; <-- Packetboat: uncheck by default
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(createDesktop)"
```

There are no other differences from upstream.

## Version pin — re-sync on Tauri upgrades

This template is pinned to **`@tauri-apps/cli` v2.11.4** (source:
`crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi` at that tag). Because
it's a full copy, it can drift from the CLI's built-in template when Tauri is
upgraded — a stale template can miss new installer features or `{{handlebars}}`
variables.

When bumping the Tauri CLI, re-sync:

```sh
# fetch the template for the new CLI version (replace the tag)
curl -fsSL -o src-tauri/nsis/installer.nsi \
  "https://raw.githubusercontent.com/tauri-apps/tauri/@tauri-apps/cli-vX.Y.Z/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi"
# then re-apply the one-line change above (the SHOWREADME_NOTCHECKED define)
```
