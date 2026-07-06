// Packetboat frontend. Talks to the Rust backend exclusively through Tauri
// commands (see src-tauri/src/lib.rs). The dark theme lives in styles.css.

// Pure helpers (path/name/reference munging) live in their own module so they
// can be unit-tested under Node (see util.test.js).
import {
  joinPath,
  relParent,
  relName,
  dedupeName,
  parseFileZillaRemoteDir,
  pathSep,
  relativeUnder,
  joinUnder,
  normalizeOpRef,
} from "./util.js";

// Guard the Tauri API so the shell still renders outside a Tauri window
// (e.g. a plain HTML preview); commands simply error if invoked there.
const invoke = window.__TAURI__
  ? window.__TAURI__.core.invoke
  : async () => {
      throw new Error("Tauri API unavailable (run inside the app)");
    };
const tauriEvent = window.__TAURI__ ? window.__TAURI__.event : null;

const state = {
  local: { path: null },
  remote: { path: null, connected: false },
};

// ---- Element refs ----
const el = {};
function cacheEls() {
  el.bodyLocal = document.getElementById("body-local");
  el.bodyRemote = document.getElementById("body-remote");
  el.treeLocal = document.getElementById("tree-local");
  el.treeRemote = document.getElementById("tree-remote");
  el.listLocal = document.querySelector("#pane-local .list");
  el.listRemote = document.querySelector("#pane-remote .list");
  el.pathLocal = document.getElementById("path-local");
  el.pathRemote = document.getElementById("path-remote");
  el.emptyRemote = document.getElementById("empty-remote");
  el.connStatus = document.getElementById("conn-status");
  el.connLabel = document.getElementById("conn-label");
  el.disconnectBtn = document.getElementById("disconnect-btn");
  el.tabBar = document.getElementById("tab-bar");
  el.settingsModal = document.getElementById("settings-modal");
  el.setTheme = document.getElementById("set-theme");
  el.setOnConnect = document.getElementById("set-onconnect");
  el.setShowLog = document.getElementById("set-show-log");
  el.setShowQueue = document.getElementById("set-show-queue");
  el.setCloseToTray = document.getElementById("set-close-to-tray");
  el.setNotifications = document.getElementById("set-notifications");
  el.setMaxTransfers = document.getElementById("set-max-transfers");
  el.setMaxDownloads = document.getElementById("set-max-downloads");
  el.setMaxUploads = document.getElementById("set-max-uploads");
  el.setReplaceInvalid = document.getElementById("set-replace-invalid");
  el.setInvalidReplacement = document.getElementById("set-invalid-replacement");
  el.setConflictDownload = document.getElementById("set-conflict-download");
  el.setConflictUpload = document.getElementById("set-conflict-upload");
  el.setUpdateCheck = document.getElementById("set-update-check");
  el.setUpdateInterval = document.getElementById("set-update-interval");
  el.updateIntervalField = document.getElementById("update-interval-field");
  el.checkUpdatesBtn = document.getElementById("set-check-updates");
  el.updateStatus = document.getElementById("update-status");
  el.updateLast = document.getElementById("update-last");
  el.status = document.getElementById("status-msg");
  el.logpanel = document.getElementById("logpanel");
  el.logList = document.getElementById("log-list");

  // Quick connect bar
  el.qcProtocol = document.getElementById("qc-protocol");
  el.qcHost = document.getElementById("qc-host");
  el.qcUser = document.getElementById("qc-user");
  el.qcPass = document.getElementById("qc-pass");
  el.qcPort = document.getElementById("qc-port");

  // Site manager
  el.sitesModal = document.getElementById("sites-modal");
  el.sitesList = document.getElementById("sites-list");
  el.sitesForm = document.querySelector(".sites-form");
  el.siteDuplicate = document.getElementById("site-duplicate");
  el.siteDelete = document.getElementById("site-delete");
  el.siteExport = document.getElementById("site-export");
  el.siteExportAll = document.getElementById("site-export-all");
  el.siteSaveBtn = document.getElementById("site-save");
  el.siteConnectBtn = document.getElementById("site-connect");
  el.sitesError = document.getElementById("sites-error");
  el.siteName = document.getElementById("site-name");
  el.siteProtocol = document.getElementById("site-protocol");
  el.siteHost = document.getElementById("site-host");
  el.sitePort = document.getElementById("site-port");
  el.siteUser = document.getElementById("site-user");
  el.sitePass = document.getElementById("site-pass");
  el.siteLogon = document.getElementById("site-logon");
  el.siteLogonHint = document.getElementById("site-logon-hint");
  el.siteOpField = document.getElementById("site-op-field");
  el.siteOpReference = document.getElementById("site-op-reference");
  el.siteOpTest = document.getElementById("site-op-test");
  el.siteOpResult = document.getElementById("site-op-result");
  el.siteKeyField = document.getElementById("site-key-field");
  el.siteKeyPath = document.getElementById("site-key-path");
  el.siteKeyBrowse = document.getElementById("site-key-browse");
  el.siteKeyPass = document.getElementById("site-key-pass");
  el.siteEncryption = document.getElementById("site-encryption");
  el.siteEncryptionField = document.getElementById("site-encryption-field");
  el.sitePassive = document.getElementById("site-passive");
  el.siteTransferModeField = document.getElementById("site-transfer-mode-field");
  el.siteFtpFields = document.getElementById("site-ftp-fields");
  el.cloudFields = document.getElementById("cloud-fields");
  el.cloudHint = document.getElementById("cloud-hint");
  el.siteLocalDir = document.getElementById("site-local-dir");
  el.siteRemoteDir = document.getElementById("site-remote-dir");
  el.siteLocalBrowse = document.getElementById("site-local-browse");
  el.siteSync = document.getElementById("site-sync");
}

// ---- Formatting helpers ----
function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function formatSpeed(bytesPerSec) {
  return `${formatSize(Math.round(bytesPerSec))}/s`;
}

function formatDate(secs) {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const ICONS = {
  dir: '<svg class="ico" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>',
  file: '<svg class="ico" viewBox="0 0 24 24"><path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M14 2v4h4"/></svg>',
  symlink:
    '<svg class="ico" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
};

// ---- Status helpers ----
function setStatus(msg, isError = false) {
  el.status.textContent = msg;
  document.querySelector(".statusbar").classList.toggle("error", isError);
}

// Render a centered message (loading / empty / error) inside a pane body.
function setPaneMessage(body, text, isError = false) {
  body.innerHTML = "";
  const div = document.createElement("div");
  div.className = isError ? "pane-msg error" : "pane-msg";
  div.textContent = text;
  body.appendChild(div);
}

// Append a timestamped entry to the message log and surface it in the status bar.
function log(message, level = "info") {
  const list = el.logList;
  if (list) {
    const entry = document.createElement("div");
    entry.className = `log-entry ${level}`;
    const now = new Date();
    const p = (n) => String(n).padStart(2, "0");
    entry.innerHTML = '<span class="log-time"></span><span class="log-msg"></span>';
    entry.children[0].textContent = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
    entry.children[1].textContent = message;
    list.appendChild(entry);
    while (list.children.length > 500) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
  }
  setStatus(message, level === "error");
}

// ---- Rendering ----
function sortEntries(entries) {
  return entries.sort((a, b) => {
    const ad = a.kind === "dir";
    const bd = b.kind === "dir";
    if (ad !== bd) return ad ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

// The file currently being dragged between panes, or null.
let dragItems = null; // items being dragged between panes (the selection)

function renderList(body, entries, side) {
  if (entries.length === 0) {
    setPaneMessage(body, "This folder is empty.");
    return;
  }
  sortEntries(entries);
  body.innerHTML = "";
  body._anchor = null; // fresh listing → reset the shift-select pivot
  const frag = document.createDocumentFragment();
  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "row";
    row._entry = e;
    const navigable = e.kind === "dir" || e.kind === "symlink";
    if (navigable) row.classList.add("dir");
    row.innerHTML =
      `<span class="cell name">${ICONS[e.kind] || ICONS.file}<span class="label">${escapeHtml(e.name)}</span></span>` +
      `<span class="cell size">${e.kind === "dir" ? "" : formatSize(e.size)}</span>` +
      `<span class="cell date">${formatDate(e.modified)}</span>`;

    row.addEventListener("click", (ev) => onRowClick(body, row, ev));
    row.addEventListener("dblclick", () => {
      if (navigable) {
        if (side === "local") navigateLocal(e.path);
        else navigateRemote(e.path);
      } else {
        // Double-clicking a file transfers it to the other pane.
        transferEntry(e, side);
      }
    });
    // Any row can be dragged to the other pane to transfer it — folders go
    // recursively (their whole subtree).
    row.draggable = true;
    row.addEventListener("dragstart", (ev) => {
      // Drag the whole selection if this row is part of it; otherwise the drag
      // becomes the selection.
      if (!row.classList.contains("selected")) {
        clearSelection(body);
        row.classList.add("selected");
        body._anchor = [...body.querySelectorAll(".row")].indexOf(row);
      }
      const rows = selectedRows(body);
      dragItems = rows.map((r) => ({
        side,
        name: r._entry.name,
        path: r._entry.path,
        size: r._entry.size,
        kind: r._entry.kind,
      }));
      rows.forEach((r) => r.classList.add("dragging"));
      ev.dataTransfer.effectAllowed = "copy";
      ev.dataTransfer.setData("text/plain", dragItems.map((d) => d.path).join("\n"));
    });
    row.addEventListener("dragend", () => {
      dragItems = null;
      body.querySelectorAll(".row.dragging").forEach((r) => r.classList.remove("dragging"));
    });
    if (navigable) {
      // Folder rows are also drop targets — drop onto one to transfer into it.
      row.addEventListener("dragover", (ev) => {
        if (dropAccepts(ev, side)) {
          ev.preventDefault();
          ev.stopPropagation();
          ev.dataTransfer.dropEffect = "copy";
          row.classList.add("drop-target");
        }
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
      row.addEventListener("drop", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        row.classList.remove("drop-target");
        handleDrop(ev, side, e.path);
      });
    }
    frag.appendChild(row);
  }
  body.appendChild(frag);
}

// ---- Multi-select ----
// Selection is the `.selected` class on rows; `body._anchor` is the index of the
// last plain/Ctrl click, used as the pivot for Shift-range selection.

function selectedRows(body) {
  return [...body.querySelectorAll(".row.selected")];
}
function selectedEntries(body) {
  return selectedRows(body)
    .map((r) => r._entry)
    .filter(Boolean);
}
function clearSelection(body) {
  body.querySelectorAll(".row.selected").forEach((r) => r.classList.remove("selected"));
}

// Row click: plain = single, Ctrl/Cmd = toggle one, Shift = range from the
// anchor (Ctrl+Shift extends the range without clearing).
function onRowClick(body, row, ev) {
  const rows = [...body.querySelectorAll(".row")];
  const idx = rows.indexOf(row);
  const additive = ev.ctrlKey || ev.metaKey;
  if (ev.shiftKey && body._anchor != null && body._anchor < rows.length) {
    if (!additive) clearSelection(body);
    const [a, b] = body._anchor <= idx ? [body._anchor, idx] : [idx, body._anchor];
    for (let i = a; i <= b; i += 1) rows[i].classList.add("selected");
  } else if (additive) {
    row.classList.toggle("selected");
    body._anchor = idx;
  } else {
    clearSelection(body);
    row.classList.add("selected");
    body._anchor = idx;
  }
}

// ---- Type-ahead: jump to a file by typing its name (FileZilla / Explorer) ----
// Typing printable characters in a focused pane selects the first entry whose
// name starts with what's been typed. The buffer clears after a short pause;
// repeating a single letter cycles through the entries starting with it.
const typeahead = { buffer: "", timer: null, body: null };

function resetTypeahead() {
  clearTimeout(typeahead.timer);
  typeahead.buffer = "";
  typeahead.timer = null;
  typeahead.body = null;
}

function onPaneTypeahead(body, ev) {
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return; // leave shortcuts alone
  if (ev.key === "Escape") return resetTypeahead();
  if (ev.key.length !== 1) return; // arrows, Enter, Backspace, modifiers, …
  if (ev.key === " " && typeahead.buffer === "") return; // ignore a leading space
  const rows = [...body.querySelectorAll(".row")];
  if (rows.length === 0) return;
  ev.preventDefault(); // don't let Space scroll the list, etc.

  if (typeahead.body !== body) typeahead.buffer = ""; // switched panes → fresh
  typeahead.body = body;
  clearTimeout(typeahead.timer);
  typeahead.timer = setTimeout(resetTypeahead, 800);
  typeahead.buffer += ev.key.toLowerCase();

  const names = rows.map((r) => (r._entry ? r._entry.name.toLowerCase() : ""));
  const selected = body.querySelector(".row.selected");
  const cur = selected ? rows.indexOf(selected) : -1;

  // Repeating one letter (e.g. "aaa") cycles through matches starting just after
  // the current selection; otherwise jump to the first prefix match from the top.
  const cycling = typeahead.buffer.length > 1 && /^(.)\1+$/.test(typeahead.buffer);
  const needle = cycling ? typeahead.buffer[0] : typeahead.buffer;

  let match = -1;
  if (cycling) {
    for (let i = 1; i <= rows.length; i += 1) {
      const idx = (cur + i) % rows.length;
      if (names[idx].startsWith(needle)) {
        match = idx;
        break;
      }
    }
  } else {
    match = names.findIndex((n) => n.startsWith(needle));
  }
  if (match < 0) return;

  clearSelection(body);
  rows[match].classList.add("selected");
  body._anchor = match;
  rows[match].scrollIntoView({ block: "nearest" });
}

// Rubber-band (marquee) selection: drag a rectangle over empty pane space to
// select the rows it touches. Ctrl/Cmd adds to the existing selection. Set up
// once per pane body (rows themselves handle their own click/drag).
function setupMarquee(body) {
  let band = null;
  let sx = 0;
  let sy = 0;
  let additive = false;
  let base = [];
  const onMove = (ev) => {
    if (!band) return;
    const x1 = Math.min(sx, ev.clientX);
    const y1 = Math.min(sy, ev.clientY);
    const x2 = Math.max(sx, ev.clientX);
    const y2 = Math.max(sy, ev.clientY);
    const rect = body.getBoundingClientRect();
    band.style.left = `${x1 - rect.left + body.scrollLeft}px`;
    band.style.top = `${y1 - rect.top + body.scrollTop}px`;
    band.style.width = `${x2 - x1}px`;
    band.style.height = `${y2 - y1}px`;
    for (const r of body.querySelectorAll(".row")) {
      const rr = r.getBoundingClientRect();
      const hit = rr.left < x2 && rr.right > x1 && rr.top < y2 && rr.bottom > y1;
      if (hit) r.classList.add("selected");
      else if (!(additive && base.includes(r))) r.classList.remove("selected");
    }
  };
  const onUp = () => {
    if (band) band.remove();
    band = null;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  body.addEventListener("mousedown", (ev) => {
    // Only start a marquee on empty space — rows drag/click themselves.
    if (ev.button !== 0 || ev.target.closest(".row")) return;
    additive = ev.ctrlKey || ev.metaKey;
    base = additive ? selectedRows(body) : [];
    if (!additive) clearSelection(body);
    body._anchor = null;
    sx = ev.clientX;
    sy = ev.clientY;
    band = document.createElement("div");
    band.className = "marquee";
    body.appendChild(band);
    ev.preventDefault();
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ---- Navigation ----
async function navigateLocal(path) {
  const tabAtStart = activeTabId;
  setPaneMessage(el.bodyLocal, "Loading…");
  try {
    const entries = await invoke("list_local", { path });
    // If the user switched tabs while this was loading, discard the stale result
    // instead of writing it into the now-active tab (which would corrupt sync).
    if (tabAtStart !== activeTabId) return;
    state.local.path = path;
    // Remember this tab's local folder so switching tabs restores it (each
    // connection browses its own local dir — important for synced browsing and
    // sites with a default local directory).
    const t = activeTab();
    if (t) t.localPath = path;
    el.pathLocal.value = path;
    renderList(el.bodyLocal, entries, "local");
    setStatus(`Local: ${path} — ${entries.length} item${entries.length === 1 ? "" : "s"}`);
    revealInTree("local", path, entries);
    await syncMirror("local", path);
  } catch (e) {
    setPaneMessage(el.bodyLocal, `${e}`, true);
    setStatus(`Local: ${e}`, true);
  }
}

async function navigateRemote(path) {
  if (!state.remote.connected) return;
  // Bind this navigation to the tab it started on, so a listing that finishes
  // after the user switched tabs is discarded rather than applied to (or run
  // against) the wrong connection.
  const id = activeTabId;
  setPaneMessage(el.bodyRemote, "Loading…");
  try {
    const entries = await invoke("list_remote", { id, path });
    if (id !== activeTabId) return; // switched tabs mid-load — stale result
    state.remote.path = path;
    el.pathRemote.value = path;
    renderList(el.bodyRemote, entries, "remote");
    log(`Directory listing of ${path} — ${entries.length} item${entries.length === 1 ? "" : "s"}`);
    revealInTree("remote", path, entries);
    await syncMirror("remote", path);
  } catch (e) {
    // The pane stays neutral; the reason (concise) goes to the message log,
    // which mirrors it into the status bar — no verbose error wall, no triplate.
    setPaneMessage(el.bodyRemote, "Couldn't open this folder.", true);
    log(`Could not list ${path}: ${e}`, "error");
  }
}

// Parent of a POSIX path (remote). Local parents are resolved in Rust.
function parentPosix(path) {
  if (!path || path === "/") return null;
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

// ---- Synchronized browsing ----
// When a connection has sync browsing on, navigating one pane mirrors the move
// to the other pane, relative to the two root directories anchored at connect.
let syncing = false; // guard so the mirror navigation doesn't echo back

function syncCounterpart(fromSide, path, tab) {
  const [root, otherRoot] =
    fromSide === "local" ? [tab.localRoot, tab.remoteRoot] : [tab.remoteRoot, tab.localRoot];
  if (!root || !otherRoot) return null;
  const rel = relativeUnder(path, root);
  return rel == null ? null : joinUnder(otherRoot, rel);
}

async function dirExists(side, path) {
  try {
    const args = side === "local" ? { path } : { id: activeTabId, path };
    await invoke(side === "local" ? "list_local" : "list_remote", args);
    return true;
  } catch (_) {
    return false;
  }
}

async function mkdirOnSide(side, path) {
  const trimmed = path.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const parent = i <= 0 ? trimmed.slice(0, i + 1) || "/" : trimmed.slice(0, i);
  const name = trimmed.slice(i + 1);
  await invoke(side === "local" ? "local_mkdir" : "remote_mkdir", { id: activeTabId, parent, name });
}

// After navigating one pane, mirror the move to the other (when sync is on for
// the active connection), prompting to create the directory if it's missing.
async function syncMirror(fromSide, path) {
  if (syncing) return;
  const tab = activeTab();
  if (!tab || !tab.sync || !tab.remote.connected) return;
  const counterpart = syncCounterpart(fromSide, path, tab);
  if (counterpart == null) return; // navigated outside the sync root
  const otherSide = fromSide === "local" ? "remote" : "local";
  const currentOther = otherSide === "local" ? state.local.path : tab.remote.path;
  if (currentOther === counterpart) return; // already there
  if (!(await dirExists(otherSide, counterpart))) {
    const choice = await promptSyncMissing(otherSide, counterpart);
    if (choice === "disable") {
      tab.sync = false;
      log("Synchronized browsing disabled.");
      return;
    }
    if (choice !== "create") return; // cancelled
    try {
      await mkdirOnSide(otherSide, counterpart);
    } catch (e) {
      log(`Sync: couldn't create ${counterpart} — ${e}`, "error");
      return;
    }
  }
  syncing = true;
  try {
    if (otherSide === "remote") await navigateRemote(counterpart);
    else await navigateLocal(counterpart);
  } finally {
    syncing = false;
  }
}

// Prompt shown when the mirrored directory doesn't exist.
// Resolves to "create" | "disable" | null (cancel).
function promptSyncMissing(side, path) {
  return new Promise((resolve) => {
    const label = side === "remote" ? "remote" : "local";
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const form = document.createElement("form");
    form.className = "modal modal-sm";
    form.innerHTML =
      "<h2>Synchronized browsing</h2>" +
      `<p class="dialog-body">The ${label} directory <strong></strong> does not exist.</p>` +
      `<label class="radio"><input type="radio" name="sb" value="create" checked /> Create the missing ${label} directory and enter it</label>` +
      '<label class="radio"><input type="radio" name="sb" value="disable" /> Disable synchronized browsing and continue</label>' +
      '<div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn btn-primary">OK</button></div>';
    form.querySelector("strong").textContent = path;
    backdrop.appendChild(form);
    document.body.appendChild(backdrop);
    const done = (r) => {
      backdrop.remove();
      resolve(r);
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      done(form.querySelector('input[name="sb"]:checked').value);
    });
    form.querySelector("[data-cancel]").addEventListener("click", () => done(null));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) done(null);
    });
  });
}

// "Unknown certificate" trust prompt for FTPS. Shows the cert
// details and resolves true if the user chooses to trust it. Cert fields are set
// via textContent (never innerHTML) since they come from the server.
function promptCertTrust(cert) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const form = document.createElement("form");
    form.className = "modal";
    const intro = cert.changed
      ? '<p class="dialog-warn">⚠ This server’s certificate has changed since you last trusted it. If you did not expect this, it could indicate a man-in-the-middle attack — do not continue unless you know why it changed.</p>'
      : '<p class="dialog-body">This server’s certificate isn’t signed by a trusted authority or doesn’t match the host you connected to. Review the details before trusting it.</p>';
    form.innerHTML =
      `<h2>${cert.changed ? "Certificate changed" : "Unknown certificate"}</h2>` +
      intro +
      '<dl class="cert-details">' +
      '<dt>Host</dt><dd data-f="hostport"></dd>' +
      '<dt>Subject</dt><dd data-f="subject"></dd>' +
      '<dt>Issuer</dt><dd data-f="issuer"></dd>' +
      '<dt>Valid for</dt><dd data-f="sans"></dd>' +
      '<dt>Valid from</dt><dd data-f="from"></dd>' +
      '<dt>Valid until</dt><dd data-f="until"></dd>' +
      '<dt>SHA-256</dt><dd class="cert-fp" data-f="fp"></dd>' +
      "</dl>" +
      '<div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn btn-primary">Trust certificate and connect</button></div>';
    const set = (f, v) => {
      form.querySelector(`[data-f="${f}"]`).textContent = v && String(v).trim() ? v : "—";
    };
    set("hostport", `${cert.host}:${cert.port}`);
    set("subject", cert.subject);
    set("issuer", cert.issuer);
    set("sans", (cert.sans || []).join(", "));
    set("from", cert.notBefore);
    set("until", cert.notAfter);
    set("fp", cert.fingerprint);
    backdrop.appendChild(form);
    document.body.appendChild(backdrop);
    const done = (r) => {
      backdrop.remove();
      resolve(r);
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      done(true);
    });
    form.querySelector("[data-cancel]").addEventListener("click", () => done(false));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) done(false);
    });
  });
}

// "Host key changed" re-trust prompt for SFTP — mirrors the FTPS cert prompt.
// Shows the previously-trusted vs. offered fingerprints and resolves true if the
// user chooses to trust the new key. Values are set via textContent (server data).
function promptHostKeyChanged(info) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const form = document.createElement("form");
    form.className = "modal";
    form.innerHTML =
      "<h2>Host key changed</h2>" +
      '<p class="dialog-warn">⚠ This server’s SSH host key has changed since you last trusted it. If you did not expect this, it could indicate a man-in-the-middle attack — do not continue unless you know why it changed.</p>' +
      '<dl class="cert-details">' +
      '<dt>Host</dt><dd data-f="hostport"></dd>' +
      '<dt>Key type</dt><dd data-f="keytype"></dd>' +
      '<dt>New fingerprint</dt><dd class="cert-fp" data-f="fp"></dd>' +
      '<dt>Previously trusted</dt><dd class="cert-fp" data-f="known"></dd>' +
      "</dl>" +
      '<div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn btn-primary">Trust new key and connect</button></div>';
    const set = (f, v) => {
      form.querySelector(`[data-f="${f}"]`).textContent = v && String(v).trim() ? v : "—";
    };
    set("hostport", `${info.host}:${info.port}`);
    set("keytype", info.keyType);
    set("fp", info.fingerprint);
    set("known", info.known);
    backdrop.appendChild(form);
    document.body.appendChild(backdrop);
    const done = (r) => {
      backdrop.remove();
      resolve(r);
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      done(true);
    });
    form.querySelector("[data-cancel]").addEventListener("click", () => done(false));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) done(false);
    });
  });
}

async function goUp(side) {
  if (side === "local") {
    if (!state.local.path) return;
    const parent = await invoke("local_parent", { path: state.local.path });
    if (parent) navigateLocal(parent);
  } else {
    const parent = parentPosix(state.remote.path);
    if (parent) navigateRemote(parent);
  }
}

function refresh(side) {
  if (side === "local") {
    if (state.local.path) navigateLocal(state.local.path);
  } else if (state.remote.path) {
    navigateRemote(state.remote.path);
  }
}

// ---- Folder tree ----
const tree = {
  local: { roots: [], expanded: new Set(), children: new Map(), selected: null },
  remote: { roots: [], expanded: new Set(), children: new Map(), selected: null },
};

function treeEl(side) {
  return side === "local" ? el.treeLocal : el.treeRemote;
}

async function loadTreeRoots(side) {
  const st = tree[side];
  st.expanded = new Set();
  st.children = new Map();
  st.selected = null;
  if (side === "local") {
    try {
      st.roots = await invoke("local_roots");
    } catch (_) {
      st.roots = [];
    }
  } else {
    st.roots = ["/"];
  }
  renderTree(side);
}

function clearTree(side) {
  tree[side] = { roots: [], expanded: new Set(), children: new Map(), selected: null };
  renderTree(side);
}

function dirsFrom(entries) {
  return entries
    .filter((e) => e.kind === "dir")
    .map((e) => ({ name: e.name, path: e.path }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

async function loadTreeChildren(side, path) {
  const st = tree[side];
  try {
    const args = side === "local" ? { path } : { id: activeTabId, path };
    const entries = await invoke(side === "local" ? "list_local" : "list_remote", args);
    st.children.set(path, dirsFrom(entries));
  } catch (_) {
    st.children.set(path, []);
  }
}

async function toggleTreeNode(side, path) {
  const st = tree[side];
  if (st.expanded.has(path)) {
    st.expanded.delete(path);
  } else {
    st.expanded.add(path);
    if (!st.children.has(path)) await loadTreeChildren(side, path);
  }
  renderTree(side);
}

function rootLabel(side, path) {
  return side === "local" ? path.replace(/\\$/, "") : path; // "C:\" -> "C:"
}

function makeTreeRow(side, node, level) {
  const st = tree[side];
  const row = document.createElement("div");
  row.className = "tree-node" + (st.selected === node.path ? " selected" : "");
  row.style.paddingLeft = `${6 + level * 14}px`;

  const chevron = document.createElement("span");
  chevron.className = "tree-chevron" + (st.expanded.has(node.path) ? " open" : "");
  chevron.textContent = "▸";
  chevron.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleTreeNode(side, node.path);
  });
  row.appendChild(chevron);
  row.insertAdjacentHTML("beforeend", ICONS.dir);

  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = node.name;
  row.appendChild(label);

  row.addEventListener("click", () => {
    if (side === "local") navigateLocal(node.path);
    else navigateRemote(node.path);
  });
  // Drop a file onto this folder to transfer it into that folder.
  row.addEventListener("dragover", (ev) => {
    if (dropAccepts(ev, side)) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "copy";
      row.classList.add("drop-target");
    }
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
  row.addEventListener("drop", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    row.classList.remove("drop-target");
    handleDrop(ev, side, node.path);
  });
  return row;
}

function renderTree(side) {
  const container = treeEl(side);
  const st = tree[side];
  container.innerHTML = "";
  if (st.roots.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = side === "remote" ? "Not connected." : "";
    container.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  const walk = (nodes, level) => {
    for (const node of nodes) {
      frag.appendChild(makeTreeRow(side, node, level));
      if (st.expanded.has(node.path)) {
        walk(st.children.get(node.path) || [], level + 1);
      }
    }
  };
  walk(
    st.roots.map((p) => ({ path: p, name: rootLabel(side, p) })),
    0,
  );
  container.appendChild(frag);
}

// Ancestor directory paths (root → parent) for `path`, for the side's path style.
function ancestorPaths(side, path) {
  if (side === "remote") {
    const parts = path.split("/").filter(Boolean);
    const res = ["/"];
    let cur = "";
    for (let i = 0; i < parts.length - 1; i++) {
      cur += "/" + parts[i];
      res.push(cur);
    }
    return res;
  }
  const parts = path.replace(/\//g, "\\").split("\\").filter(Boolean);
  if (parts.length === 0) return [];
  const res = [parts[0] + "\\"]; // drive root, e.g. "C:\"
  let cur = parts[0];
  for (let i = 1; i < parts.length - 1; i++) {
    cur += "\\" + parts[i];
    res.push(cur);
  }
  return res;
}

// Expand the tree down to `path` and select it, keeping it in sync with the list.
async function revealInTree(side, path, entries) {
  const st = tree[side];
  if (st.roots.length === 0) return;
  st.selected = path;
  // Reuse the listing we just loaded for this dir, and expand it so its
  // subfolders show (the tree follows the list).
  if (entries) st.children.set(path, dirsFrom(entries));
  st.expanded.add(path);
  for (const a of ancestorPaths(side, path)) {
    st.expanded.add(a);
    if (!st.children.has(a)) await loadTreeChildren(side, a);
  }
  renderTree(side);
  const sel = treeEl(side).querySelector(".tree-node.selected");
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

// ---- Connection ----
function setConnState(connected, label) {
  state.remote.connected = connected;
  el.connStatus.dataset.state = connected ? "on" : "off";
  el.connLabel.textContent = label;
  el.disconnectBtn.hidden = !connected;
  el.emptyRemote.hidden = connected;
  el.pathRemote.disabled = !connected;
  updateAppbarWrap();
}

// When the connection cluster (label + Site Manager + Disconnect) no longer fits
// beside the brand/toolbar it wraps to its own row; in that case stack it so the
// label is left-aligned and the buttons group to the right. Measured with the
// compact (un-stacked) layout so it can also un-stack when the window widens.
function updateAppbarWrap() {
  const left = document.querySelector(".appbar-left");
  const conn = document.querySelector(".conn");
  if (!left || !conn) return;
  conn.classList.remove("stacked");
  const wrapped = conn.getBoundingClientRect().top >= left.getBoundingClientRect().bottom - 1;
  conn.classList.toggle("stacked", wrapped);
}

// ---- Connection tabs (one live remote connection per tab; local is shared) ----
let tabs = [];
let activeTabId = null;

function activeTab() {
  return tabs.find((t) => t.id === activeTabId) || null;
}

function freshRemote() {
  return { path: null, connected: false };
}
function freshTree() {
  return { roots: [], expanded: new Set(), children: new Map(), selected: null };
}

// Point the shared `state.remote`/`tree.remote` at the active tab and refresh
// the remote UI. With `navigate`, re-list the tab's current directory.
function activateTab(id, navigate) {
  activeTabId = id;
  const tab = activeTab();
  state.remote = tab ? tab.remote : freshRemote();
  tree.remote = tab ? tab.tree : freshTree();
  renderTabs();
  syncRemoteUI();
  renderTree("remote");
  if (navigate) restoreTabPanes(tab);
}

// Restore a tab's remote and local folders on switch. Each pane goes back to its
// saved path (they were consistent when the tab was last active, so the mirror
// early-returns). Bails between steps if the user switched tabs again mid-load,
// so a slow restore can't stomp on the newly-active tab.
async function restoreTabPanes(tab) {
  const id = tab ? tab.id : null;
  if (tab && tab.localPath && tab.localPath !== state.local.path) {
    await navigateLocal(tab.localPath);
    if (id !== activeTabId) return; // switched away while local was loading
  }
  if (id !== activeTabId) return;
  if (tab && tab.remote.path) {
    await navigateRemote(tab.remote.path);
  } else {
    el.bodyRemote.innerHTML = "";
    el.pathRemote.value = "";
  }
}

function addTab(id, label, cloud = false) {
  // `cloud` marks object-store backends (S3/B2/WebDAV) which can't resume
  // uploads (no append) — used to hide that option in the conflict prompt.
  // `localPath` seeds from the current local folder; the connect flow overrides
  // it if the site has a default local dir.
  tabs.push({
    id,
    label,
    cloud,
    remote: { path: null, connected: true },
    tree: freshTree(),
    localPath: state.local.path,
  });
  activateTab(id, false); // the caller navigates to the login dir
}

async function closeTab(id) {
  try {
    await invoke("disconnect", { id });
  } catch (_) {
    /* ignore */
  }
  log("Disconnected");
  tabs = tabs.filter((t) => t.id !== id);
  if (activeTabId === id) activateTab(tabs.length ? tabs[tabs.length - 1].id : null, true);
  else renderTabs();
}

function syncRemoteUI() {
  const tab = activeTab();
  if (tab) setConnState(true, tab.label);
  else setConnState(false, "Not connected");
}

function renderTabs() {
  const bar = el.tabBar;
  bar.innerHTML = "";
  for (const tab of tabs) {
    const t = document.createElement("div");
    t.className = "tab" + (tab.id === activeTabId ? " active" : "");
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tab.label;
    label.addEventListener("click", () => activateTab(tab.id, true));
    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close connection");
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    t.appendChild(label);
    t.appendChild(close);
    bar.appendChild(t);
  }
}

// Shared connect path used by both quick connect and the site manager.
// Resolve a site's saved "default remote directory" against the live server.
// An absolute path that doesn't exist as-is is retried relative to the login
// home, so a familiar "/public_html" works on servers (e.g. cPanel over SFTP)
// where it actually lives under the home rather than at the filesystem root —
// while a genuinely absolute path like "/var/www/html" is still used verbatim.
async function resolveStartDir(id, remoteDir, home) {
  const want = (remoteDir || "").trim();
  if (!want) return home;
  const opens = async (p) => {
    try {
      await invoke("list_remote", { id, path: p });
      return true;
    } catch (_) {
      return false;
    }
  };
  if (await opens(want)) return want;
  // Retry "/public_html" as "<home>/public_html" (leading slash relative to home).
  if (want.startsWith("/") && home && home !== "/") {
    const underHome = joinPath(home, want.replace(/^\/+/, ""));
    if (await opens(underHome)) return underHome;
  }
  // Configured dir can't be opened: land on home so the pane isn't stuck on an
  // error, and say why.
  log(`Couldn't open the site's remote directory “${want}”; opened ${home} instead.`, "error");
  return home;
}

async function doConnectWith({
  protocol,
  host,
  port,
  username,
  password,
  keyPath,
  passphrase,
  encryption,
  passive,
  label,
  service,
  config,
  localDir,
  remoteDir,
  sync,
}) {
  const cloud = !!service;
  if (!cloud) {
    if (!host) {
      setStatus("Host is required.", true);
      return false;
    }
    if (protocol === "sftp" && !username) {
      setStatus("Username is required for SFTP.", true);
      return false;
    }
  }
  // Already connected? Honor the "when already connected" setting.
  if (tabs.length > 0) {
    let action = settings.onConnect;
    if (action === "ask") {
      const choice = await askConnectBehavior();
      if (!choice) return false; // cancelled
      action = choice.action;
      if (choice.always) {
        settings.onConnect = action;
        saveSettings();
      }
    }
    if (action === "replace") await closeTab(activeTabId);
  }
  const target = cloud ? CLOUD_SERVICES[service]?.label || service : host;
  el.connStatus.dataset.state = "busy";
  el.connLabel.textContent = `Connecting to ${target}…`;
  updateAppbarWrap();
  log(`Connecting to ${target}…`);
  try {
    let result;
    if (cloud) {
      result = await invoke("connect_opendal", { service, config });
    } else if (protocol === "sftp") {
      const cfg = {
        host,
        port,
        username,
        password,
        key_path: keyPath || "",
        passphrase: passphrase || "",
      };
      result = await invoke("connect_sftp", { config: cfg });
      // Changed host key (possible MITM): prompt to re-trust it, then retry.
      if (result.hostKeyPrompt) {
        const trusted = await promptHostKeyChanged(result.hostKeyPrompt);
        if (!trusted) {
          log("Connection cancelled — host key not trusted.", "error");
          syncRemoteUI();
          return false;
        }
        await invoke("trust_host_key", {
          host: cfg.host,
          port: cfg.port,
          fingerprint: result.hostKeyPrompt.fingerprint,
        });
        result = await invoke("connect_sftp", { config: cfg });
        if (result.hostKeyPrompt) throw new Error("host key still not trusted");
      }
    } else {
      const cfg = {
        host,
        port,
        username,
        password,
        encryption: ftpEncryption(protocol, encryption),
        passive: passive !== false, // default to passive
      };
      result = await invoke("connect_ftp", { config: cfg });
      // Untrusted FTPS cert: prompt to trust it (TOFU), then retry the connect.
      if (result.certPrompt) {
        const trusted = await promptCertTrust(result.certPrompt);
        if (!trusted) {
          log("Connection cancelled — certificate not trusted.", "error");
          syncRemoteUI();
          return false;
        }
        await invoke("trust_cert", {
          host: cfg.host,
          port: cfg.port,
          fingerprint: result.certPrompt.fingerprint,
        });
        result = await invoke("connect_ftp", { config: cfg });
        if (result.certPrompt) throw new Error("certificate still not trusted");
      }
    }
    addTab(result.id, label || (cloud ? target : `${username || "anonymous"}@${host}`), cloud);
    log(`Connected to ${target}`, "success");
    await loadTreeRoots("remote");
    await navigateRemote(await resolveStartDir(result.id, remoteDir, result.home));
    if (localDir) await navigateLocal(localDir);
    // Synchronized browsing: anchor the mirror at the two directories the panes
    // just landed on.
    if (sync) {
      const tab = tabs.find((t) => t.id === result.id);
      if (tab) {
        tab.sync = true;
        tab.localRoot = state.local.path;
        tab.remoteRoot = tab.remote.path;
      }
    }
    return true;
  } catch (e) {
    syncRemoteUI();
    log(`Connection failed: ${e}`, "error");
    return false;
  }
}

async function quickConnect() {
  const protocol = el.qcProtocol.value;
  const port = parseInt(el.qcPort.value, 10) || defaultPort(protocol);
  const ok = await doConnectWith({
    protocol,
    host: el.qcHost.value.trim(),
    port,
    username: el.qcUser.value.trim(),
    password: el.qcPass.value,
  });
  if (ok) el.qcPass.value = "";
}

async function doDisconnect() {
  if (activeTabId !== null) closeTab(activeTabId);
}

// ---- Site manager ----
let sites = [];
// The single "active" site (its form is shown/editable) when exactly one is
// selected; null when zero or many are selected.
let selectedSiteId = null;
// All selected site ids (multi-select via Ctrl/Shift, like the file list), plus
// the anchor index for Shift-range selection.
let selectedSiteIds = [];
let siteAnchorIndex = -1;

function defaultPort(protocol, encryption) {
  if (protocol === "sftp") return 22;
  if (encryption === "implicit") return 990; // implicit FTPS
  return 21;
}

// Resolve the FTP TLS mode sent to the backend. The Site Manager passes an
// explicit mode; Quick Connect (and legacy "ftps"/"ftp" protocols) map to a
// sensible default: ftps → require explicit TLS, plain ftp → opportunistic.
function ftpEncryption(protocol, encryption) {
  if (encryption) return encryption;
  return protocol === "ftps" ? "explicit" : "explicit_optional";
}

// ---- Cloud (OpenDAL) services ----
// Each protocol value maps to a connect_opendal `service` scheme plus its config
// fields. `secret` fields go to the OS keychain (composite key `<siteId>:<key>`),
// never the site file; non-secret fields persist in the site's `config` map.
// Field keys match OpenDAL's service config keys exactly.
const CLOUD_SERVICES = {
  s3: {
    label: "Amazon S3",
    fields: [
      { key: "bucket", label: "Bucket", required: true },
      { key: "region", label: "Region", placeholder: "us-east-1" },
      {
        key: "endpoint",
        label: "Endpoint",
        placeholder: "https://s3.amazonaws.com — set for S3-compatible (R2, MinIO…)",
      },
      { key: "access_key_id", label: "Access Key ID", required: true },
      { key: "secret_access_key", label: "Secret Access Key", secret: true, required: true },
      { key: "root", label: "Root path", placeholder: "/" },
    ],
  },
  b2: {
    label: "Backblaze B2",
    fields: [
      { key: "bucket", label: "Bucket name", required: true },
      { key: "bucket_id", label: "Bucket ID", required: true },
      { key: "application_key_id", label: "Key ID", required: true },
      { key: "application_key", label: "Application Key", secret: true, required: true },
      { key: "root", label: "Root path", placeholder: "/" },
    ],
  },
  webdav: {
    label: "WebDAV",
    fields: [
      { key: "endpoint", label: "Server URL", placeholder: "https://dav.example.com", required: true },
      { key: "username", label: "Username" },
      { key: "password", label: "Password", secret: true },
      { key: "root", label: "Root path", placeholder: "/" },
    ],
  },
};

function isCloud(protocol) {
  return Object.prototype.hasOwnProperty.call(CLOUD_SERVICES, protocol);
}

// Build the per-service config inputs into #cloud-fields, pre-filled from a
// {key: value} map.
function renderCloudFields(service, values) {
  const def = CLOUD_SERVICES[service];
  el.cloudFields.innerHTML = "";
  if (!def) return;
  for (const f of def.fields) {
    const label = document.createElement("label");
    label.className = "field";
    const span = document.createElement("span");
    span.textContent = f.label + (f.required ? "" : " (optional)");
    const input = document.createElement("input");
    input.type = f.secret ? "password" : "text";
    input.autocomplete = "off";
    input.dataset.key = f.key;
    if (f.secret) input.dataset.secret = "true";
    if (f.placeholder) input.placeholder = f.placeholder;
    input.value = (values && values[f.key]) || "";
    label.append(span, input);
    el.cloudFields.appendChild(label);
  }
}

// Read #cloud-fields into separate non-secret `config` and `secrets` maps
// (non-empty values only).
function readCloudFields() {
  const config = {};
  const secrets = {};
  for (const input of el.cloudFields.querySelectorAll("input[data-key]")) {
    const v = input.value.trim();
    if (!v) continue;
    if (input.dataset.secret) secrets[input.dataset.key] = v;
    else config[input.dataset.key] = v;
  }
  return { config, secrets };
}

function cloudSecretKeys(service) {
  return (CLOUD_SERVICES[service]?.fields || []).filter((f) => f.secret).map((f) => f.key);
}

// Show the FTP/SFTP field group or the cloud field group for the current
// protocol. `values` pre-fills cloud inputs (used when loading a saved site).
function updateProtocolFields(values) {
  const proto = el.siteProtocol.value;
  const cloud = isCloud(proto);
  el.siteFtpFields.hidden = cloud;
  el.cloudFields.hidden = !cloud;
  el.cloudHint.hidden = !cloud;
  // Encryption + transfer mode only apply to FTP (not SFTP).
  el.siteEncryptionField.hidden = proto !== "ftp";
  el.siteTransferModeField.hidden = proto !== "ftp";
  // Key-file auth is SFTP-only; disable the option (and revert a stale choice)
  // for other protocols.
  const keyOpt = el.siteLogon.querySelector('option[value="key"]');
  if (keyOpt) keyOpt.disabled = proto !== "sftp";
  if (proto !== "sftp" && el.siteLogon.value === "key") el.siteLogon.value = "normal";
  if (cloud) {
    const def = CLOUD_SERVICES[proto];
    const base =
      "Secret keys are stored in your OS keychain (Windows Credential Manager), never the site file.";
    el.cloudHint.textContent = `${def.label} via OpenDAL. ${def.note ? def.note + " " : ""}${base}`;
    renderCloudFields(proto, values || {});
  } else {
    updateLogonFields();
  }
}

// Resolve any missing required secrets (keychain, then prompt) and open a cloud
// connection.
async function connectCloud(service, config, label, siteId, dirs = {}) {
  const def = CLOUD_SERVICES[service];
  for (const f of def.fields) {
    if (config[f.key] || !f.secret) continue;
    if (siteId) {
      try {
        const val = await invoke("secret_get", { id: `${siteId}:${f.key}` });
        if (val) {
          config[f.key] = val;
          continue;
        }
      } catch (_) {
        /* ignore */
      }
    }
    if (f.required) {
      const v = await promptPassword(`Enter ${f.label}`, def.label);
      if (v === null) return false; // cancelled
      if (v) config[f.key] = v;
    }
  }
  return await doConnectWith({
    service,
    config,
    label,
    localDir: dirs.localDir,
    remoteDir: dirs.remoteDir,
    sync: dirs.sync,
  });
}

async function loadSites() {
  try {
    sites = await invoke("sites_load");
  } catch (e) {
    // The saved sites file was corrupt; the backend backed it up. Surface it
    // rather than showing an unexplained empty list.
    sites = [];
    log(`${e}`, "error");
  }
  renderSites();
}

function renderSites() {
  el.sitesList.innerHTML = "";
  if (sites.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sites-empty";
    empty.textContent = "No saved sites yet.";
    el.sitesList.appendChild(empty);
    updateSiteButtons();
    return;
  }
  sites.forEach((site, index) => {
    const item = document.createElement("div");
    item.className = "site-item" + (selectedSiteIds.includes(site.id) ? " selected" : "");
    const name = document.createElement("span");
    name.textContent = site.name || site.host || "Untitled";
    const sub = document.createElement("span");
    sub.className = "site-host";
    const detail = isCloud(site.protocol)
      ? (site.config && (site.config.bucket || site.config.endpoint)) || "—"
      : site.host || "—";
    sub.textContent = `${site.protocol.toUpperCase()} · ${detail}`;
    item.append(name, sub);
    item.addEventListener("click", (ev) => onSiteClick(index, ev));
    el.sitesList.appendChild(item);
  });
}

// Site-list click: plain = single, Ctrl/Cmd = toggle, Shift = range from the
// anchor — mirrors the file-list multi-select.
function onSiteClick(index, ev) {
  const id = sites[index].id;
  if (ev.ctrlKey || ev.metaKey) {
    const i = selectedSiteIds.indexOf(id);
    if (i >= 0) selectedSiteIds.splice(i, 1);
    else selectedSiteIds.push(id);
    siteAnchorIndex = index;
  } else if (ev.shiftKey && siteAnchorIndex >= 0 && siteAnchorIndex < sites.length) {
    const [a, b] = siteAnchorIndex <= index ? [siteAnchorIndex, index] : [index, siteAnchorIndex];
    selectedSiteIds = sites.slice(a, b + 1).map((s) => s.id);
  } else {
    selectedSiteIds = [id];
    siteAnchorIndex = index;
  }
  applySiteSelection();
}

// Reflect the current selection: a single selection fills + enables the form;
// zero or many blanks + disables it. Always refreshes the button states.
function applySiteSelection() {
  if (selectedSiteIds.length === 1) {
    selectSite(selectedSiteIds[0]); // fills the form + loads secrets + renders
  } else {
    selectedSiteId = null;
    setSiteFormEnabled(false); // blanks + disables the form
    updateSiteButtons();
    renderSites();
  }
}

// Enable (single selection) or blank+disable (zero/multi) the editable site form.
function setSiteFormEnabled(enabled) {
  if (!enabled) fillSiteForm(null); // clear the fields
  el.sitesForm.classList.toggle("form-disabled", !enabled);
  el.sitesForm.querySelectorAll("input, select, button").forEach((c) => {
    c.disabled = !enabled;
  });
}

// Enable/disable the list-action + footer buttons for the current selection.
function updateSiteButtons() {
  const n = selectedSiteIds.length;
  if (el.siteDuplicate) el.siteDuplicate.disabled = n !== 1; // single only
  if (el.siteDelete) el.siteDelete.disabled = n === 0;
  if (el.siteExport) el.siteExport.disabled = n === 0;
  if (el.siteSaveBtn) el.siteSaveBtn.disabled = n !== 1;
  if (el.siteConnectBtn) el.siteConnectBtn.disabled = n !== 1;
}

function fillSiteForm(site) {
  el.siteName.value = site ? site.name : "";
  // Legacy sites stored protocol "ftps"; fold that into FTP + explicit TLS.
  el.siteProtocol.value = site ? (site.protocol === "ftps" ? "ftp" : site.protocol) : "sftp";
  el.siteEncryption.value = site
    ? site.encryption || (site.protocol === "ftps" ? "explicit" : "explicit_optional")
    : "explicit_optional";
  // Passive by default (new sites and any saved site that predates this field).
  el.sitePassive.checked = site ? site.passive !== false : true;
  el.siteHost.value = site ? site.host || "" : "";
  el.sitePort.value = site ? site.port || defaultPort(site.protocol, site.encryption) : 22;
  el.siteUser.value = site ? site.username || "" : "";
  el.sitePass.value = "";
  el.siteLogon.value = site ? site.logon_type || "ask" : "normal";
  el.siteOpReference.value = site ? site.op_reference || "" : "";
  el.siteKeyPath.value = site ? site.key_path || "" : "";
  el.siteKeyPass.value = ""; // passphrase is loaded from the keychain in selectSite()
  setOpResult("", "");
  // Cloud sites pre-fill the per-service inputs from saved config; secret keys
  // are loaded from the keychain in selectSite().
  updateProtocolFields(site && site.config ? { ...site.config } : {});
  el.siteLocalDir.value = site ? site.local_dir || "" : "";
  el.siteRemoteDir.value = site ? site.remote_dir || "" : "";
  el.siteSync.checked = site ? !!site.sync_browsing : false;
}

async function selectSite(id) {
  selectedSiteId = id;
  selectedSiteIds = [id];
  const idx = sites.findIndex((s) => s.id === id);
  if (idx >= 0) siteAnchorIndex = idx;
  setSiteFormEnabled(true);
  const site = sites.find((s) => s.id === id);
  fillSiteForm(site);
  updateSiteButtons();
  renderSites();
  if (!site) return;
  if (isCloud(site.protocol)) {
    // Pull saved secret config from the keychain into the rendered fields.
    for (const key of cloudSecretKeys(site.protocol)) {
      try {
        const val = await invoke("secret_get", { id: `${site.id}:${key}` });
        if (val) {
          const input = el.cloudFields.querySelector(`input[data-key="${key}"]`);
          if (input) input.value = val;
        }
      } catch (_) {
        /* ignore */
      }
    }
  } else if (site.logon_type === "normal") {
    // Pre-fill the saved password if one is stored in the keychain.
    try {
      const pw = await invoke("secret_get", { id });
      if (pw) el.sitePass.value = pw;
    } catch (_) {
      /* ignore */
    }
  } else if (site.logon_type === "key") {
    // Pre-fill the saved key passphrase from the keychain.
    try {
      const pp = await invoke("secret_get", { id: `${id}:keypass` });
      if (pp) el.siteKeyPass.value = pp;
    } catch (_) {
      /* ignore */
    }
  }
}

function newSite() {
  const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
  sites.push({
    id,
    name: "New site",
    protocol: "sftp",
    host: "",
    port: 22,
    username: "",
    logon_type: "normal",
  });
  selectSite(id);
}

function newSiteId() {
  return (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());
}

// Duplicate the single selected site (FileZilla-style): a deep copy with a new
// id and a "(copy)" name, including any keychain secrets (password / cloud keys).
async function duplicateSite() {
  if (selectedSiteIds.length !== 1) return;
  const src = sites.find((s) => s.id === selectedSiteIds[0]);
  if (!src) return;
  const copy = JSON.parse(JSON.stringify(src)); // deep copy (config map included)
  copy.id = newSiteId();
  const names = new Set(sites.map((s) => s.name));
  let base = `${src.name || src.host || "Site"} (copy)`;
  let name = base;
  let n = 2;
  while (names.has(name)) name = `${base} ${n++}`;
  copy.name = name;
  sites.push(copy);
  try {
    await invoke("sites_save", { sites });
    // Copy the source's keychain secrets to the new id so the duplicate connects.
    if (isCloud(src.protocol)) {
      for (const key of cloudSecretKeys(src.protocol)) {
        const val = await invoke("secret_get", { id: `${src.id}:${key}` }).catch(() => null);
        if (val) await invoke("secret_set", { id: `${copy.id}:${key}`, password: val });
      }
    } else {
      const pw = await invoke("secret_get", { id: src.id }).catch(() => null);
      if (pw) await invoke("secret_set", { id: copy.id, password: pw });
      // Key sites keep their passphrase under a ":keypass" composite key.
      const pp = await invoke("secret_get", { id: `${src.id}:keypass` }).catch(() => null);
      if (pp) await invoke("secret_set", { id: `${copy.id}:keypass`, password: pp });
    }
  } catch (e) {
    setSitesError(String(e));
  }
  selectSite(copy.id);
  setStatus(`Duplicated site "${src.name || src.host}"`);
}

// ---- FileZilla import ----

// UTF-8-safe base64 decode for FileZilla's <Pass encoding="base64"> values.
function decodeBase64(s) {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
  } catch (_) {
    return "";
  }
}

// UTF-8-safe base64 encode (for writing FileZilla <Pass encoding="base64">).
function encodeBase64(s) {
  let bin = "";
  new TextEncoder().encode(s).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

// FileZilla serializes <RemoteDir> as "<type> <prefixLen> [<segLen> <segment>]…"
// where each path segment is preceded by its character length (so segments may
// contain spaces). E.g. "1 0 11 public_html 14 learningcarton" → "/public_html/
// learningcarton". Returns "" for an empty/unparseable value.
// Map one FileZilla <Server> element to a Packetboat site + its password.
// Returns null for unsupported protocols (Storj, S3, …) or missing host.
function fileZillaServerToSite(server) {
  const t = (tag) => {
    const e = server.querySelector(`:scope > ${tag}`);
    return e ? e.textContent.trim() : "";
  };
  // FileZilla ServerProtocol: 0=FTP(opportunistic TLS), 1=SFTP, 3=FTPS(implicit),
  // 4=FTPES(explicit), 6=INSECURE_FTP(plain). Others (HTTP/S3/Storj/…) unsupported.
  let protocol;
  let encryption = "";
  switch (parseInt(t("Protocol"), 10)) {
    case 0:
      protocol = "ftp";
      encryption = "explicit_optional";
      break;
    case 1:
      protocol = "sftp";
      break;
    case 3:
      protocol = "ftp";
      encryption = "implicit";
      break;
    case 4:
      protocol = "ftp";
      encryption = "explicit";
      break;
    case 6:
      protocol = "ftp";
      encryption = "plain";
      break;
    default:
      return null; // unsupported backend
  }
  const host = t("Host");
  if (!host) return null;
  // FileZilla Logontype: 0=Anonymous, 1=Normal, others (Ask/Interactive/…) → ask.
  const logonCode = parseInt(t("Logontype"), 10);
  const logon_type = logonCode === 0 ? "anonymous" : logonCode === 1 ? "normal" : "ask";
  const passEl = server.querySelector(":scope > Pass");
  let password = "";
  if (passEl && logon_type === "normal") {
    password =
      passEl.getAttribute("encoding") === "base64"
        ? decodeBase64(passEl.textContent)
        : passEl.textContent;
  }
  return {
    site: {
      id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random()),
      name: t("Name") || fzServerName(server) || host,
      protocol,
      host,
      port: parseInt(t("Port"), 10) || defaultPort(protocol, encryption),
      username: t("User"),
      logon_type,
      encryption,
      // FileZilla PasvMode: MODE_ACTIVE forces active; default/passive → passive.
      passive: t("PasvMode") !== "MODE_ACTIVE",
      config: {},
      local_dir: t("LocalDir"), // FileZilla stores a plain OS path
      remote_dir: parseFileZillaRemoteDir(t("RemoteDir")),
      sync_browsing: t("SyncBrowsing") === "1",
    },
    password,
  };
}

// Import sites from a FileZilla Site Manager XML export. Saved passwords move
// into the OS keychain (an upgrade — FileZilla stores them base64-plaintext).
// Local/remote default dirs import too (remote dirs are decoded from FileZilla's
// serialized format). On a name/host/user/protocol collision the user is
// prompted per site (skip / overwrite / keep both), with an apply-to-all option.
async function importSites() {
  let path;
  try {
    path = await invoke("plugin:dialog|open", {
      options: {
        multiple: false,
        title: "Choose a site export (Packetboat or FileZilla)",
        filters: [{ name: "Site export", extensions: ["json", "xml"] }],
      },
    });
  } catch (e) {
    setSitesError(`Import failed: ${e}`);
    return;
  }
  if (typeof path !== "string") return; // cancelled
  let text;
  try {
    text = await invoke("read_text_file", { path });
  } catch (e) {
    setSitesError(`Couldn't read that file: ${e}`);
    return;
  }

  // Detect the format: JSON = Packetboat export (maybe encrypted), XML = FileZilla.
  // Each parser returns [{ site, password?, cloudSecrets? }], or null.
  const trimmed = text.trimStart();
  let imported;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      /* not JSON */
    }
    if (parsed && parsed.format === "packetboat-sites-encrypted") {
      // Encrypted Packetboat export — ask for the passphrase and decrypt.
      const pass = await buildDialog({
        title: "Encrypted export",
        label: "Enter the password this export was encrypted with.",
        input: true,
        inputType: "password",
        trim: false,
        confirmText: "Import",
      });
      if (pass === null) return; // cancelled
      let plain;
      try {
        plain = await decryptExport(parsed, pass);
      } catch (_) {
        setSitesError("Wrong password, or the file is damaged.");
        return;
      }
      imported = parsePacketboatExport(plain);
    } else {
      imported = parsePacketboatExport(text);
    }
  } else {
    imported = parseFileZillaExport(text);
  }
  if (!imported) {
    setSitesError("That isn't a Packetboat or FileZilla site export.");
    return;
  }
  if (imported.length === 0) {
    setSitesError("No importable sites found in that file.");
    return;
  }

  // Shared apply logic (per-duplicate prompt, then commit after the loop so a
  // mid-import cancel leaves sites untouched).
  let skipped = 0;
  const added = [];
  const overwrites = []; // { target, data }
  const secretJobs = []; // { id, password } | { id, secrets: {key:val} }
  let applyToAll = null;
  for (const item of imported) {
    const s = item.site;
    const existing = sites.find(
      (e) =>
        e.protocol === s.protocol &&
        e.host === s.host &&
        e.username === s.username &&
        e.name === s.name,
    );
    if (existing) {
      let action = applyToAll;
      if (!action) {
        const res = await promptDuplicate(s);
        if (!res) return; // cancelled — nothing applied yet
        action = res.action;
        if (res.all) applyToAll = action;
      }
      if (action === "skip") {
        skipped++;
        continue;
      }
      if (action === "overwrite") {
        overwrites.push({ target: existing, data: s });
        queueImportSecrets(secretJobs, existing.id, item);
        continue;
      }
      // "keep" → add as a separate copy (s already has a fresh id).
    }
    added.push(s);
    queueImportSecrets(secretJobs, s.id, item);
  }
  if (added.length + overwrites.length === 0) {
    setSitesError(`Nothing imported${skipped ? ` — ${skipped} skipped or unsupported` : ""}.`);
    return;
  }
  for (const o of overwrites) Object.assign(o.target, o.data, { id: o.target.id });
  sites.push(...added);
  try {
    await invoke("sites_save", { sites });
    for (const job of secretJobs) {
      try {
        if (job.secrets) {
          for (const [k, v] of Object.entries(job.secrets)) {
            await invoke("secret_set", { id: `${job.id}:${k}`, password: v });
          }
        } else if (job.password) {
          await invoke("secret_set", { id: job.id, password: job.password });
        }
      } catch (_) {
        /* one secret failing shouldn't abort the import */
      }
    }
  } catch (e) {
    setSitesError(`Couldn't save imported sites: ${e}`);
    return;
  }
  setSitesError(null);
  renderSites();
  const parts = [];
  if (added.length) parts.push(`${added.length} imported`);
  if (overwrites.length) parts.push(`${overwrites.length} updated`);
  if (skipped) parts.push(`${skipped} skipped`);
  setStatus(`Import: ${parts.join(", ")}.`);
}

// Queue the keychain writes for one imported item (cloud secrets or a password).
function queueImportSecrets(jobs, id, item) {
  if (item.cloudSecrets && Object.keys(item.cloudSecrets).length) {
    jobs.push({ id, secrets: item.cloudSecrets });
  } else if (item.password) {
    jobs.push({ id, password: item.password });
  }
}

// Parse a FileZilla XML export → [{ site, password }], or null if not FileZilla.
function parseFileZillaExport(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror") || !doc.querySelector("FileZilla3")) return null;
  const out = [];
  // querySelectorAll("Server") flattens the folder tree — nested sites included.
  for (const server of doc.querySelectorAll("Server")) {
    const mapped = fileZillaServerToSite(server);
    if (mapped) out.push({ site: mapped.site, password: mapped.password });
  }
  return out;
}

// Parse a Packetboat JSON export → [{ site, password, cloudSecrets }], or null.
function parsePacketboatExport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return null;
  }
  const arr = Array.isArray(data) ? data : data && data.sites;
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const raw of arr) {
    if (!raw || !raw.protocol || !raw.host) continue;
    const site = { ...raw };
    delete site.password;
    delete site.secrets;
    site.id = newSiteId(); // exports omit ids; give each a fresh one
    if (!site.name) site.name = site.host;
    out.push({ site, password: raw.password || "", cloudSecrets: raw.secrets || {} });
  }
  return out;
}

// The site name in a FileZilla export is the trailing text node of <Server>
// (some versions use a <Name> child instead — the caller tries that first).
function fzServerName(server) {
  let name = "";
  for (const node of server.childNodes) {
    if (node.nodeType === 3 /* text */) name += node.textContent;
  }
  return name.trim();
}

// ---- Site export ----

// Export `list`: choose a format (Packetboat always; FileZilla only when every
// site is FTP/SFTP), pick a path, and write the file.
async function exportSites(list) {
  if (!list || list.length === 0) return;
  const allFileZillaCompatible = list.every((s) => !isCloud(s.protocol));
  const choice = await promptExport(allFileZillaCompatible);
  if (!choice) return; // cancelled
  const { format, passphrase } = choice;
  let contents;
  let defaultName;
  let ext;
  let filterName;
  if (format === "filezilla") {
    contents = await buildFileZillaExport(list);
    defaultName = "sites.xml";
    ext = "xml";
    filterName = "FileZilla site export";
  } else {
    contents = await buildPacketboatExport(list);
    if (passphrase) {
      contents = await encryptExport(contents, passphrase);
      defaultName = "packetboat-sites-encrypted.json";
    } else {
      defaultName = "packetboat-sites.json";
    }
    ext = "json";
    filterName = "Packetboat sites";
  }
  let path;
  try {
    path = await invoke("plugin:dialog|save", {
      options: { title: "Export sites", defaultPath: defaultName, filters: [{ name: filterName, extensions: [ext] }] },
    });
  } catch (e) {
    setSitesError(`Export failed: ${e}`);
    return;
  }
  if (typeof path !== "string") return; // cancelled
  try {
    await invoke("write_text_file", { path, contents });
    setStatus(`Exported ${list.length} site${list.length === 1 ? "" : "s"}.`);
  } catch (e) {
    setSitesError(`Export failed: ${e}`);
  }
}

// Packetboat JSON export: each site object plus its keychain secrets, so the file
// is a complete, re-importable backup. Secrets are in plaintext in the file (the
// same tradeoff as FileZilla's base64) — it's the user's own backup.
async function buildPacketboatExport(list) {
  const out = [];
  for (const s of list) {
    const site = JSON.parse(JSON.stringify(s));
    delete site.id; // regenerated on import
    if (isCloud(s.protocol)) {
      const secrets = {};
      for (const key of cloudSecretKeys(s.protocol)) {
        const v = await invoke("secret_get", { id: `${s.id}:${key}` }).catch(() => null);
        if (v) secrets[key] = v;
      }
      if (Object.keys(secrets).length) site.secrets = secrets;
    } else if (s.logon_type === "normal") {
      const pw = await invoke("secret_get", { id: s.id }).catch(() => null);
      if (pw) site.password = pw;
    }
    out.push(site);
  }
  return JSON.stringify({ format: "packetboat-sites", version: 1, sites: out }, null, 2);
}

// FileZilla XML export (FTP/SFTP only; cloud sites are skipped as unsupported).
async function buildFileZillaExport(list) {
  const esc = (v) => escapeHtml(String(v ?? ""));
  let body = "";
  for (const s of list) {
    if (isCloud(s.protocol)) continue;
    const port = s.port || defaultPort(s.protocol, s.encryption);
    let passXml = "";
    if (s.logon_type === "normal") {
      const pw = await invoke("secret_get", { id: s.id }).catch(() => null);
      if (pw) passXml = `\n      <Pass encoding="base64">${esc(encodeBase64(pw))}</Pass>`;
    }
    body +=
      "    <Server>\n" +
      `      <Host>${esc(s.host)}</Host>\n` +
      `      <Port>${port}</Port>\n` +
      `      <Protocol>${fzProtocolCode(s)}</Protocol>\n` +
      "      <Type>0</Type>\n" +
      `      <User>${esc(s.username)}</User>${passXml}\n` +
      `      <Logontype>${fzLogontypeCode(s)}</Logontype>\n` +
      `      <PasvMode>${s.passive === false ? "MODE_ACTIVE" : "MODE_DEFAULT"}</PasvMode>\n` +
      `      <LocalDir>${esc(s.local_dir || "")}</LocalDir>\n` +
      `      <RemoteDir>${esc(serializeFileZillaRemoteDir(s.remote_dir || ""))}</RemoteDir>\n` +
      `      <SyncBrowsing>${s.sync_browsing ? 1 : 0}</SyncBrowsing>\n` +
      `      ${esc(s.name || s.host)}\n` +
      "    </Server>\n";
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<FileZilla3>\n  <Servers>\n${body}  </Servers>\n</FileZilla3>\n`;
}

// Packetboat protocol/encryption → FileZilla ServerProtocol (reverse of import).
function fzProtocolCode(s) {
  if (s.protocol === "sftp") return 1;
  const enc = s.encryption || (s.protocol === "ftps" ? "explicit" : "explicit_optional");
  return enc === "implicit" ? 3 : enc === "explicit" ? 4 : enc === "plain" ? 6 : 0;
}
function fzLogontypeCode(s) {
  return s.logon_type === "anonymous" ? 0 : s.logon_type === "normal" ? 1 : 2; // 2 = Ask
}
// Serialize a "/a/b" path into FileZilla's "<type> <prefixLen> [<len> <seg>]…".
function serializeFileZillaRemoteDir(remoteDir) {
  const segs = String(remoteDir || "").split("/").filter(Boolean);
  if (!segs.length) return "";
  let out = "1 0"; // 1 = Unix server type, 0 = no server prefix
  for (const seg of segs) out += ` ${seg.length} ${seg}`;
  return out;
}

// Export prompt: choose the format (FileZilla offered only when every site is
// FTP/SFTP) and an optional encryption passphrase for the Packetboat format.
// Resolves to { format: "packetboat" | "filezilla", passphrase } or null.
function promptExport(allFileZillaCompatible) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const form = document.createElement("form");
    form.className = "modal modal-sm modal-export";
    const formatSection = allFileZillaCompatible
      ? '<p class="dialog-body">Choose an export format.</p>' +
        '<label class="radio"><input type="radio" name="fmt" value="packetboat" checked /> Packetboat (JSON) — full, re-importable backup</label>' +
        '<label class="radio"><input type="radio" name="fmt" value="filezilla" /> FileZilla (XML) — to import into FileZilla</label>'
      : '<p class="dialog-body">Exporting as <strong>Packetboat (JSON)</strong>.</p>';
    form.innerHTML =
      "<h2>Export sites</h2>" +
      formatSection +
      '<label class="field" id="export-encrypt-field"><span>Encrypt with a password (optional)</span>' +
      '<input type="password" id="export-pass" autocomplete="new-password" /></label>' +
      '<p class="hint" id="export-pass-hint">Leave blank to export unencrypted — the file will contain your saved passwords. With a password, it\'s encrypted (AES-256) and you\'ll need that password to import it.</p>' +
      '<div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn btn-primary">Export…</button></div>';
    backdrop.appendChild(form);
    document.body.appendChild(backdrop);
    const done = (r) => {
      backdrop.remove();
      resolve(r);
    };
    const chosenFormat = () => {
      const r = form.querySelector('input[name="fmt"]:checked');
      return r ? r.value : "packetboat";
    };
    // Encryption applies to the Packetboat format only; hide it for FileZilla.
    const encField = form.querySelector("#export-encrypt-field");
    const encHint = form.querySelector("#export-pass-hint");
    const syncEnc = () => {
      const pb = chosenFormat() === "packetboat";
      encField.hidden = !pb;
      encHint.hidden = !pb;
    };
    form.querySelectorAll('input[name="fmt"]').forEach((r) => r.addEventListener("change", syncEnc));
    syncEnc();
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const format = chosenFormat();
      done({ format, passphrase: format === "packetboat" ? form.querySelector("#export-pass").value : "" });
    });
    form.querySelector("[data-cancel]").addEventListener("click", () => done(null));
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) done(null);
    });
  });
}

// ---- Export encryption (AES-256-GCM, PBKDF2-SHA256 key from a passphrase) ----
// Web Crypto — no dependencies. Produces/consumes a self-describing JSON envelope.
const EXPORT_KDF_ITERATIONS = 210000;

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function deriveExportKey(passphrase, salt, iterations, usage) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}
async function encryptExport(plaintext, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveExportKey(passphrase, salt, EXPORT_KDF_ITERATIONS, "encrypt");
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return JSON.stringify(
    {
      format: "packetboat-sites-encrypted",
      version: 1,
      kdf: "PBKDF2-SHA256",
      iterations: EXPORT_KDF_ITERATIONS,
      salt: bufToBase64(salt),
      iv: bufToBase64(iv),
      ciphertext: bufToBase64(ct),
    },
    null,
    2,
  );
}
async function decryptExport(env, passphrase) {
  const key = await deriveExportKey(
    passphrase,
    base64ToBytes(env.salt),
    env.iterations || EXPORT_KDF_ITERATIONS,
    "decrypt",
  );
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(env.iv) },
    key,
    base64ToBytes(env.ciphertext),
  );
  return new TextDecoder().decode(pt);
}

// Per-duplicate prompt during import. Resolves to { action: "skip" | "overwrite"
// | "keep", all: bool } or null to cancel the whole import.
function promptDuplicate(site) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const form = document.createElement("form");
    form.className = "modal modal-sm";
    form.innerHTML =
      "<h2>Site already exists</h2>" +
      '<p class="dialog-body">A site matching <strong></strong> is already in Packetboat.</p>' +
      '<label class="radio"><input type="radio" name="dup" value="skip" checked /> Skip — keep the existing site</label>' +
      '<label class="radio"><input type="radio" name="dup" value="overwrite" /> Overwrite it with the imported one</label>' +
      '<label class="radio"><input type="radio" name="dup" value="keep" /> Keep both (import as a copy)</label>' +
      '<label class="check"><input type="checkbox" class="switch" id="dup-all" /> Apply to all remaining duplicates</label>' +
      '<div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel import</button><button type="submit" class="btn btn-primary">OK</button></div>';
    form.querySelector("strong").textContent = `“${site.name}” (${site.host})`;
    backdrop.appendChild(form);
    document.body.appendChild(backdrop);
    const done = (r) => {
      backdrop.remove();
      resolve(r);
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      done({
        action: form.querySelector('input[name="dup"]:checked').value,
        all: form.querySelector("#dup-all").checked,
      });
    });
    form.querySelector("[data-cancel]").addEventListener("click", () => done(null));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) done(null);
    });
  });
}

// Native folder picker for the "Default local directory" field.
async function browseLocalDir() {
  try {
    const dir = await invoke("plugin:dialog|open", {
      options: {
        directory: true,
        multiple: false,
        title: "Choose the default local folder",
        defaultPath: el.siteLocalDir.value || undefined,
      },
    });
    if (typeof dir === "string") el.siteLocalDir.value = dir;
  } catch (e) {
    log(`Folder picker failed: ${e}`, "error");
  }
}

// Native file picker for the SFTP "Private key file" field.
async function browseKeyFile() {
  try {
    const path = await invoke("plugin:dialog|open", {
      options: {
        directory: false,
        multiple: false,
        title: "Choose a private key file",
        defaultPath: el.siteKeyPath.value || undefined,
      },
    });
    if (typeof path === "string") el.siteKeyPath.value = path;
  } catch (e) {
    log(`File picker failed: ${e}`, "error");
  }
}

function readSiteForm() {
  const protocol = el.siteProtocol.value;
  // Default directories apply to every protocol (where to start each pane).
  const dirs = {
    local_dir: el.siteLocalDir.value.trim(),
    remote_dir: el.siteRemoteDir.value.trim(),
    sync_browsing: el.siteSync.checked,
  };
  if (isCloud(protocol)) {
    const { config } = readCloudFields(); // secrets handled separately, via the keychain
    return {
      name: el.siteName.value.trim() || CLOUD_SERVICES[protocol].label,
      protocol,
      host: "",
      port: 0,
      username: "",
      logon_type: "normal",
      config,
      ...dirs,
    };
  }
  return {
    name: el.siteName.value.trim() || el.siteHost.value.trim(),
    protocol,
    host: el.siteHost.value.trim(),
    port: parseInt(el.sitePort.value, 10) || defaultPort(protocol, el.siteEncryption.value),
    username: el.siteUser.value.trim(),
    logon_type: el.siteLogon.value,
    op_reference: normalizeOpRef(el.siteOpReference.value),
    key_path: el.siteLogon.value === "key" ? el.siteKeyPath.value.trim() : "",
    encryption: protocol === "ftp" ? el.siteEncryption.value : "",
    passive: protocol === "ftp" ? el.sitePassive.checked : true,
    config: {},
    ...dirs,
  };
}

async function saveSite() {
  const site = sites.find((s) => s.id === selectedSiteId);
  if (!site) {
    setSitesError("Create or select a site first.");
    return;
  }
  Object.assign(site, readSiteForm());
  try {
    await invoke("sites_save", { sites });
    if (isCloud(site.protocol)) {
      // Route each secret config key to the keychain (or clear it if blank).
      const { secrets } = readCloudFields();
      for (const key of cloudSecretKeys(site.protocol)) {
        const compositeId = `${site.id}:${key}`;
        if (secrets[key]) {
          await invoke("secret_set", { id: compositeId, password: secrets[key] });
        } else {
          await invoke("secret_delete", { id: compositeId });
        }
      }
    } else if (site.logon_type === "normal" && el.sitePass.value) {
      await invoke("secret_set", { id: site.id, password: el.sitePass.value });
      await invoke("secret_delete", { id: `${site.id}:keypass` });
    } else if (site.logon_type === "key") {
      // Key auth has no password; the optional passphrase lives in the keychain.
      await invoke("secret_delete", { id: site.id });
      if (el.siteKeyPass.value) {
        await invoke("secret_set", { id: `${site.id}:keypass`, password: el.siteKeyPass.value });
      } else {
        await invoke("secret_delete", { id: `${site.id}:keypass` });
      }
    } else {
      await invoke("secret_delete", { id: site.id });
      await invoke("secret_delete", { id: `${site.id}:keypass` });
    }
    setSitesError(null);
    renderSites();
    setStatus(`Saved site "${site.name}"`);
  } catch (e) {
    setSitesError(String(e));
  }
}

async function deleteSite() {
  const toDelete = sites.filter((s) => selectedSiteIds.includes(s.id));
  if (toDelete.length === 0) return;
  const title =
    toDelete.length === 1
      ? `Delete "${toDelete[0].name || toDelete[0].host}"?`
      : `Delete ${toDelete.length} sites?`;
  if (!(await confirmDialog(title, "This can't be undone.", "Delete"))) return;
  const ids = new Set(toDelete.map((s) => s.id));
  sites = sites.filter((s) => !ids.has(s.id));
  selectedSiteIds = [];
  selectedSiteId = null;
  siteAnchorIndex = -1;
  try {
    for (const removed of toDelete) {
      if (isCloud(removed.protocol)) {
        for (const key of cloudSecretKeys(removed.protocol)) {
          await invoke("secret_delete", { id: `${removed.id}:${key}` }).catch(() => {});
        }
      } else {
        await invoke("secret_delete", { id: removed.id }).catch(() => {});
        // Also clear a key site's passphrase (stored under a ":keypass" key).
        await invoke("secret_delete", { id: `${removed.id}:keypass` }).catch(() => {});
      }
    }
    await invoke("sites_save", { sites });
  } catch (_) {
    /* ignore */
  }
  setSiteFormEnabled(false);
  updateSiteButtons();
  renderSites();
}

// Resolve a password (prompting if needed) and connect, labeling the bar with
// the site name when there is one.
async function connectUsing({
  name,
  protocol,
  host,
  port,
  username,
  logonType,
  password,
  opReference,
  keyPath,
  keyPassphrase,
  encryption,
  passive,
  siteId,
  localDir,
  remoteDir,
  sync,
}) {
  let user = username;
  let pw = password || "";
  let keyFile = keyPath || "";
  let passphrase = keyPassphrase || "";

  if (logonType === "anonymous") {
    user = "anonymous";
    pw = "";
  } else if (logonType === "1password") {
    if (!opReference) {
      setStatus("Add a 1Password secret reference for this site first.", true);
      return;
    }
    setStatus("Resolving 1Password reference…");
    try {
      pw = await invoke("resolve_op_reference", { reference: opReference });
    } catch (e) {
      setStatus(String(e), true);
      return;
    }
  } else if (logonType === "key") {
    if (!keyFile) {
      setStatus("Choose a private key file for this site first.", true);
      return;
    }
    // Key auth uses no password; pull the saved passphrase if we don't have one.
    pw = "";
    if (!passphrase && siteId) {
      try {
        passphrase = (await invoke("secret_get", { id: `${siteId}:keypass` })) || "";
      } catch (_) {
        /* ignore */
      }
    }
  } else {
    // "Normal" sites keep the password in the keychain; pull it if we don't
    // already have a typed one.
    if (!pw && logonType === "normal" && siteId) {
      try {
        pw = (await invoke("secret_get", { id: siteId })) || "";
      } catch (_) {
        /* ignore */
      }
    }
    if (!pw) {
      pw = await promptPassword("Enter password", `${user} @ ${host}`);
      if (pw === null) return; // cancelled
    }
  }

  const who = `${user || "anonymous"}@${host}`;
  await doConnectWith({
    protocol,
    host,
    port: port || defaultPort(protocol, encryption),
    username: user,
    password: pw,
    keyPath: keyFile,
    passphrase,
    encryption,
    passive,
    label: name && name !== host ? `${name} — ${who}` : who,
    localDir,
    remoteDir,
    sync,
  });
}

// Enable/disable the username, password, and 1Password-reference fields to match
// the logon type.
function updateLogonFields() {
  const t = el.siteLogon.value;
  const showUser = t !== "anonymous";
  const showPass = t === "normal";
  const showOp = t === "1password";
  const showKey = t === "key";
  el.siteUser.closest(".field").hidden = !showUser;
  el.sitePass.closest(".field").hidden = !showPass;
  el.siteOpField.hidden = !showOp;
  el.siteKeyField.hidden = !showKey;
  if (!showUser) el.siteUser.value = "";
  if (!showPass) el.sitePass.value = "";
  el.siteLogonHint.textContent =
    {
      normal:
        "Username and password are saved — the password goes in your OS keychain (Windows Credential Manager), never the site file.",
      ask: "Only the username is saved. You'll be asked for the password each time you connect.",
      key: "SFTP only. The username and key file path are saved; an optional passphrase goes in your OS keychain, never the site file.",
      anonymous: "Connects as “anonymous” — no username or password needed (FTP).",
      "1password":
        "The username is saved. At connect time Packetboat resolves the reference with the 1Password CLI (op) — only the pointer is stored, never the password.",
    }[t] || "";
  // Warn upfront if the 1Password CLI isn't installed (the result line is
  // otherwise blank until a Test / connect).
  if (showOp && !el.siteOpResult.textContent) {
    ensureOpCheck().then((ok) => {
      if (!ok && el.siteLogon.value === "1password" && !el.siteOpResult.textContent) {
        setOpResult("1Password CLI (op) not found on your PATH.", "err");
      }
    });
  }
}

// One-time (cached) check of whether the `op` CLI is available.
let opAvailableCache = null;
async function ensureOpCheck() {
  if (opAvailableCache === null) {
    try {
      opAvailableCache = await invoke("op_available");
    } catch (_) {
      opAvailableCache = false;
    }
  }
  return opAvailableCache;
}

function setOpResult(text, kind) {
  el.siteOpResult.textContent = text;
  el.siteOpResult.className = `hint op-result${kind ? ` ${kind}` : ""}`;
}

// "Test" button: resolve the reference once to confirm it works, without
// revealing the value.
async function testOpReference() {
  const ref = normalizeOpRef(el.siteOpReference.value);
  if (!ref) return setOpResult("Enter a reference first.", "err");
  setOpResult("Resolving…", "");
  try {
    await invoke("resolve_op_reference", { reference: ref });
    setOpResult("✓ Resolved successfully.", "ok");
  } catch (e) {
    setOpResult(String(e), "err");
  }
}

// Connect from the Site Manager's Connect button (uses the live form values,
// including a possibly-edited password).
async function connectSite() {
  const site = sites.find((s) => s.id === selectedSiteId);
  if (!site) {
    setSitesError("Select a site to connect.");
    return;
  }
  const dirs = {
    localDir: el.siteLocalDir.value.trim(),
    remoteDir: el.siteRemoteDir.value.trim(),
    sync: el.siteSync.checked,
  };
  if (isCloud(el.siteProtocol.value)) {
    const service = el.siteProtocol.value;
    const { config, secrets } = readCloudFields();
    const label = el.siteName.value.trim() || CLOUD_SERVICES[service].label;
    closeSites();
    await connectCloud(service, { ...config, ...secrets }, label, site.id, dirs);
    return;
  }
  const form = readSiteForm();
  const typed = el.sitePass.value;
  closeSites();
  await connectUsing({
    name: form.name,
    protocol: form.protocol,
    host: form.host,
    port: form.port,
    username: form.username,
    logonType: form.logon_type,
    password: typed,
    opReference: form.op_reference,
    keyPath: form.key_path,
    keyPassphrase: el.siteKeyPass.value,
    encryption: form.encryption,
    passive: form.passive,
    siteId: site.id,
    ...dirs,
  });
}

// Connect directly to a saved site (from the quick-connect dropdown), pulling
// the password from the keychain when saved.
async function connectFromMenu(site) {
  const dirs = {
    localDir: site.local_dir || "",
    remoteDir: site.remote_dir || "",
    sync: !!site.sync_browsing,
  };
  if (isCloud(site.protocol)) {
    const label = site.name || CLOUD_SERVICES[site.protocol].label;
    await connectCloud(site.protocol, { ...(site.config || {}) }, label, site.id, dirs);
    return;
  }
  await connectUsing({
    name: site.name,
    protocol: site.protocol,
    host: site.host,
    port: site.port,
    username: site.username,
    logonType: site.logon_type,
    password: "",
    opReference: site.op_reference,
    keyPath: site.key_path || "",
    keyPassphrase: "",
    encryption: site.encryption,
    passive: site.passive,
    siteId: site.id,
    ...dirs,
  });
}

function openSitesDropdown(anchorEl) {
  const items = [];
  if (sites.length === 0) {
    items.push({ label: "No saved sites", action: openSites });
  } else {
    for (const site of sites) {
      items.push({
        label: `${site.name || site.host} · ${site.protocol.toUpperCase()}`,
        action: () => connectFromMenu(site),
      });
    }
  }
  items.push({ sep: true });
  items.push({ label: "Open Site Manager…", action: openSites });
  const r = anchorEl.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, items);
}

function setSitesError(msg) {
  if (msg) {
    el.sitesError.textContent = msg;
    el.sitesError.hidden = false;
  } else {
    el.sitesError.hidden = true;
  }
}

async function openSites() {
  setSitesError(null);
  selectedSiteIds = [];
  selectedSiteId = null;
  siteAnchorIndex = -1;
  el.sitesModal.hidden = false;
  await loadSites();
  // Nothing selected yet → blank, disabled form until the user picks or adds one.
  setSiteFormEnabled(false);
  updateSiteButtons();
}

function closeSites() {
  el.sitesModal.hidden = true;
}

// ---- Transfers ----
const queue = new Map();
// Full TransferRequest per id, kept so a failed/cancelled transfer can be retried.
const transferRequests = new Map();
// Per-run tally for the "queue finished" notification: success/failure counts
// since the queue was last idle, the set of connection ids the run touched (so a
// single-tab run's notification can jump to that tab), plus the previous active
// count so we can spot the active→0 drain edge.
const queueRun = { success: 0, failed: 0, conns: new Set() };
let prevActiveCount = 0;

// Files transfer to the *other* pane's current directory: a local file goes
// up to the remote, a remote file comes down to the local pane.
async function transferEntry(entry, side) {
  const dest = side === "local" ? "remote" : "local";
  await transferTo(entry, side, dest, dest === "remote" ? state.remote.path : state.local.path);
}

// ---- File-exists conflict handling ----
// Short-lived cache of destination directory contents (name -> entry), so a
// batch only lists each directory once. Cleared at the start of each transfer.
let conflictCache = new Map();

async function dirEntries(side, dir) {
  const key = `${side}:${dir}`;
  if (conflictCache.has(key)) return conflictCache.get(key);
  const map = new Map();
  try {
    const args = side === "local" ? { path: dir } : { id: activeTabId, path: dir };
    const entries = await invoke(side === "local" ? "list_local" : "list_remote", args);
    for (const e of entries) map.set(e.name, e);
  } catch (_) {
    // Directory may not exist yet (fresh transfer) → no conflicts.
  }
  conflictCache.set(key, map);
  return map;
}

// The local OS. Filename-character sanitizing only matters on Windows, whose
// filesystem forbids \ / : * ? " < > | (and control chars) in names.
const localIsWindows = /windows/i.test(navigator.userAgent);
// eslint-disable-next-line no-control-regex
const INVALID_LOCAL_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

// Replace characters the local OS forbids in a single filename (per the setting),
// so a download from a server that allows them (e.g. Unix) can still be written.
function sanitizeLocalName(name) {
  if (!localIsWindows || !settings.replaceInvalidChars) return name;
  // The replacement can't itself contain forbidden chars (would reintroduce them).
  const repl = String(settings.invalidCharReplacement ?? "_").replace(INVALID_LOCAL_CHARS, "");
  return name.replace(INVALID_LOCAL_CHARS, repl);
}

// Sanitize each component of a relative path ("a:b/c?d" → "a_b/c_d"), keeping the
// "/" separators, for nested folder-download destinations.
function sanitizeRelPath(rel) {
  return rel.split("/").map(sanitizeLocalName).join("/");
}

// Build a non-colliding "name (n).ext" within the destination directory.
// Decide what to do with a file whose target may already exist. Returns
// { proceed, name, resumeOffset? } — `name` may be a renamed copy, proceed:false
// means skip, resumeOffset means continue an interrupted transfer from that byte.
// `allowPrompt` is false for batch (folder) transfers so they don't prompt per
// file — they fall back to overwrite when the policy is "ask". `resumable` is
// false for paths that can't resume (OS drag-drop via put_bytes).
// Conflict action chosen "for this session" (per direction). Shadows the saved
// default without persisting — cleared on restart or when the default changes.
const sessionConflict = { download: null, upload: null };

async function resolveConflict(
  direction,
  destSide,
  destDir,
  name,
  srcSize,
  srcModified,
  srcPath,
  allowPrompt,
  resumable = true,
) {
  let policy =
    sessionConflict[direction] ||
    (direction === "download" ? settings.conflictDownload : settings.conflictUpload);
  if (policy === "overwrite") return { proceed: true, name };
  const dir = await dirEntries(destSide, destDir);
  const target = dir.get(name);
  if (!target) return { proceed: true, name }; // no conflict

  // Resume needs an appendable destination: local always is; a remote is unless
  // it's an object store (cloud upload). `resumable` is false for paths that
  // can't resume at all (OS drag-drop, which re-sends whole files via put_bytes).
  const canResume = resumable && (direction === "download" || !(activeTab() && activeTab().cloud));

  if (policy === "ask") {
    if (!allowPrompt) return { proceed: true, name };
    const choice = await promptConflict({ direction, name, destDir, srcSize, srcModified, srcPath, target, canResume });
    if (!choice) return { proceed: false }; // cancelled
    if (choice.scope === "session") {
      sessionConflict[direction] = choice.action; // this run only, not saved
    } else if (choice.scope === "always") {
      if (direction === "download") settings.conflictDownload = choice.action;
      else settings.conflictUpload = choice.action;
      saveSettings();
    }
    policy = choice.action;
    if (policy === "overwrite") return { proceed: true, name };
  }

  switch (policy) {
    case "newer":
      // Overwrite only if the source is newer; if either time is unknown,
      // overwrite (don't silently skip on missing metadata).
      return srcModified == null || target.modified == null || srcModified > target.modified
        ? { proceed: true, name }
        : { proceed: false };
    case "size":
      return srcSize !== target.size ? { proceed: true, name } : { proceed: false };
    case "rename":
      return { proceed: true, name: dedupeName(name, dir) };
    case "resume":
      if (!canResume) return { proceed: true, name }; // not resumable → overwrite
      // Continue from the partial; if it's already complete (>= source), skip.
      return target.size < srcSize
        ? { proceed: true, name, resumeOffset: target.size }
        : { proceed: false };
    case "skip":
      return { proceed: false };
    default:
      return { proceed: true, name };
  }
}

// "Target file already exists" prompt. Resolves to
// { action, scope } (scope: "once" | "session" | "always") or null if cancelled.
function promptConflict({ direction, name, destDir, srcSize, srcModified, srcPath, target, canResume }) {
  return new Promise((resolve) => {
    const srcSideName = direction === "upload" ? "Local (source)" : "Remote (source)";
    const dstSideName = direction === "upload" ? "Remote (target)" : "Local (target)";
    const targetPath = joinPath(destDir, name);
    // Offer Resume only when the destination is appendable and the partial is
    // actually shorter than the source (something left to transfer).
    const resumeRadio =
      canResume && target.size < srcSize
        ? `<label class="radio"><input type="radio" name="cf" value="resume" /> Resume from ${formatSize(target.size)}</label>`
        : "";
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const form = document.createElement("form");
    form.className = "modal modal-conflict";
    form.innerHTML =
      "<h2>Target file already exists</h2>" +
      '<div class="dialog-scroll">' +
      `<p class="dialog-body"><strong>${escapeHtml(name)}</strong> already exists in the destination. Choose what to do.</p>` +
      '<div class="conflict-files">' +
      `<div class="conflict-file"><span class="cf-label">${srcSideName}</span>` +
      `<span class="cf-path"></span>` +
      `<span class="cf-meta">${formatSize(srcSize)} · ${formatDate(srcModified)}</span></div>` +
      `<div class="conflict-file"><span class="cf-label">${dstSideName}</span>` +
      `<span class="cf-path"></span>` +
      `<span class="cf-meta">${formatSize(target.size)} · ${formatDate(target.modified)}</span></div>` +
      "</div>" +
      '<div class="conflict-actions">' +
      '<label class="radio"><input type="radio" name="cf" value="overwrite" checked /> Overwrite</label>' +
      '<label class="radio"><input type="radio" name="cf" value="newer" /> Overwrite if source is newer</label>' +
      '<label class="radio"><input type="radio" name="cf" value="size" /> Overwrite if size differs</label>' +
      resumeRadio +
      '<label class="radio"><input type="radio" name="cf" value="rename" /> Rename (keep both)</label>' +
      '<label class="radio"><input type="radio" name="cf" value="skip" /> Skip</label>' +
      "</div>" +
      '<label class="field-toggle"><span>Remember this choice</span>' +
      '<select id="cf-scope" class="cf-scope">' +
      '<option value="once">Just this time</option>' +
      '<option value="session">For this session</option>' +
      '<option value="always">Always (save as default)</option>' +
      "</select></label>" +
      "</div>" +
      '<div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn btn-primary">OK</button></div>';
    // Set paths via textContent (avoid HTML-escaping issues with odd chars).
    const paths = form.querySelectorAll(".cf-path");
    paths[0].textContent = srcPath;
    paths[1].textContent = targetPath;
    backdrop.appendChild(form);
    document.body.appendChild(backdrop);
    const done = (r) => {
      backdrop.remove();
      resolve(r);
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      done({
        action: form.querySelector('input[name="cf"]:checked').value,
        scope: form.querySelector("#cf-scope").value,
      });
    });
    form.querySelector("[data-cancel]").addEventListener("click", () => done(null));
    // mousedown (not click) so releasing a resize drag over the backdrop doesn't
    // dismiss the prompt.
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) done(null);
    });
  });
}

// Transfer `entry` from `sourceSide` into `destDir` on `destSide`.
async function transferTo(entry, sourceSide, destSide, destDir) {
  if (sourceSide === destSide || !destDir) return;
  if (destSide === "remote" && !state.remote.connected) {
    setStatus("Connect to a server before uploading.", true);
    return;
  }
  if (entry.kind === "dir") {
    await transferFolder(entry, sourceSide, destSide, destDir);
    return;
  }
  const direction = destSide === "remote" ? "upload" : "download";
  // Downloading to Windows: swap characters the local OS forbids in filenames
  // so the file can actually be written (e.g. "a:b?.log" → "a_b_.log").
  const destName = direction === "download" ? sanitizeLocalName(entry.name) : entry.name;
  conflictCache.clear();
  const r = await resolveConflict(
    direction,
    destSide,
    destDir,
    destName,
    entry.size,
    entry.modified,
    entry.path,
    true,
  );
  if (!r.proceed) {
    addSkippedRow(direction, entry.name, entry.size);
    log(`Skipped ${entry.name} — target already exists.`);
    return;
  }
  await enqueue(direction, entry.path, destDir, r.name, entry.size, r.resumeOffset);
}

// Recursively transfer a folder: walk the source subtree once, recreate its
// directories on the destination (parents first), then queue every file.
async function transferFolder(entry, sourceSide, destSide, destDir) {
  const direction = destSide === "remote" ? "upload" : "download";
  log(`Scanning folder ${entry.name}…`);
  let tree;
  try {
    tree = await invoke("list_tree", { side: sourceSide, id: activeTabId, path: entry.path });
  } catch (e) {
    log(`Could not read folder ${entry.name}: ${e}`, "error");
    return;
  }
  // Recreate the destination directory tree. entry.name is the new root; the
  // walk lists directories before their children, so parents come first. When
  // downloading, sanitize every dest name/component so server names with
  // Windows-forbidden characters land on disk (source paths stay original).
  const clean = direction === "download" ? sanitizeLocalName : (s) => s;
  const cleanRel = direction === "download" ? sanitizeRelPath : (s) => s;
  const mkdirCmd = destSide === "local" ? "local_mkdir" : "remote_mkdir";
  const destRoot = joinPath(destDir, clean(entry.name));
  await safeMkdir(mkdirCmd, destDir, clean(entry.name));
  for (const t of tree) {
    if (t.kind !== "dir") continue;
    await safeMkdir(mkdirCmd, joinPath(destRoot, cleanRel(relParent(t.rel))), clean(relName(t.rel)));
  }
  // Queue every file into its destination subdirectory, applying the file-exists
  // policy per file (folders don't prompt — they overwrite when policy is "ask").
  conflictCache.clear();
  let count = 0;
  let skipped = 0;
  for (const t of tree) {
    if (t.kind !== "file") continue;
    const fileDestDir = joinPath(destRoot, cleanRel(relParent(t.rel)));
    const fileName = clean(relName(t.rel));
    const r = await resolveConflict(direction, destSide, fileDestDir, fileName, t.size, t.modified, t.path, false);
    if (!r.proceed) {
      addSkippedRow(direction, fileName, t.size);
      skipped++;
      continue;
    }
    await enqueue(direction, t.path, fileDestDir, r.name, t.size, r.resumeOffset);
    count++;
  }
  const skipNote = skipped ? ` (${skipped} skipped)` : "";
  if (count === 0 && skipped === 0) log(`${entry.name} has no files to transfer.`);
  else log(`Queued ${count} file${count === 1 ? "" : "s"} from ${entry.name}${skipNote}.`, "success");
  refresh(destSide);
}

async function safeMkdir(cmd, parent, name) {
  try {
    await invoke(cmd, { id: activeTabId, parent, name });
  } catch (_) {
    // Already exists (re-transfer) or a benign race — the file step will
    // surface any real problem.
  }
}

// Cap on drag-imported file size. The bytes travel in one raw IPC body and are
// buffered once in memory, so a bound is kept (unbounded streaming of OS drops
// would require Tauri's native drag-drop to expose the real file path).
const MAX_DRAG_IMPORT_BYTES = 250 * 1024 * 1024;

// Base64-encode a small object as UTF-8 JSON, for the x-pb-meta upload header.
function encodeMeta(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Path helpers for building destination paths. Joining with "/" is fine for
// remote (POSIX) and for local on Windows (the backend normalizes separators).
// Import OS files (dragged in from the file manager) into `destDir` by sending
// their bytes — the webview can't see their real path, only their content.
async function importExternalFiles(files, destSide, destDir) {
  if (!destDir) return;
  if (destSide === "remote" && !state.remote.connected) {
    setStatus("Connect to a server before uploading.", true);
    return;
  }
  const direction = destSide === "remote" ? "upload" : "download";
  conflictCache.clear();
  for (const file of files) {
    if (file.size > MAX_DRAG_IMPORT_BYTES) {
      log(`${file.name} is too large to drag-import (${formatSize(MAX_DRAG_IMPORT_BYTES)} limit).`, "error");
      continue;
    }
    const srcModified = file.lastModified ? Math.floor(file.lastModified / 1000) : null;
    // resumable=false: OS drops re-send the whole file via put_bytes (no append).
    const r = await resolveConflict(direction, destSide, destDir, file.name, file.size, srcModified, file.name, true, false);
    if (!r.proceed) {
      addSkippedRow(direction, file.name, file.size);
      log(`Skipped ${file.name} — target already exists.`);
      continue;
    }
    try {
      log(`${destSide === "remote" ? "Uploading" : "Importing"} ${file.name}…`);
      // Send the bytes as a raw IPC body (not a JSON number-array, which peaks
      // at several times the file size in memory); routing metadata rides in a
      // base64-encoded header.
      const buf = await file.arrayBuffer();
      const meta = encodeMeta({ id: activeTabId ?? 0, side: destSide, dir: destDir, name: r.name });
      await invoke("put_bytes", buf, { headers: { "x-pb-meta": meta } });
      log(`Transfer complete: ${file.name}`, "success");
    } catch (e) {
      log(`Transfer failed: ${file.name} — ${e}`, "error");
    }
  }
  refresh(destSide);
}

// Unified drop target: OS files take priority, else an in-app dragged file.
function handleDrop(ev, destSide, destDir) {
  const files = ev.dataTransfer.files;
  if (files && files.length > 0) {
    importExternalFiles(files, destSide, destDir);
  } else if (dragItems && dragItems.length && dragItems[0].side !== destSide) {
    transferManyTo(dragItems, dragItems[0].side, destSide, destDir);
  }
}

async function transferManyTo(items, srcSide, destSide, destDir) {
  for (const item of items) {
    await transferTo(item, srcSide, destSide, destDir);
  }
}

async function enqueue(direction, src, dstDir, name, size, resumeOffset) {
  const request = { direction, connection_id: activeTabId, src, dst_dir: dstDir, name, size };
  if (resumeOffset) request.resume_offset = resumeOffset;
  try {
    const id = await invoke("enqueue_transfer", { request });
    transferRequests.set(id, request); // keep for retry
  } catch (e) {
    setStatus(`Transfer: ${e}`, true);
  }
}

function onTransferUpdate(u) {
  switch (u.event) {
    case "queued":
      addQueueRow(u);
      break;
    case "start": {
      setQueueStat(u.id, "Starting…");
      const it = queue.get(u.id);
      if (it) {
        it.rate = null;
        log(`${it.direction === "download" ? "Downloading" : "Uploading"} ${it.name}…`);
      }
      break;
    }
    case "progress":
      updateQueueProgress(u.id, u.transferred, u.size);
      break;
    case "retry": {
      setQueueStat(u.id, `Retrying (${u.attempt}/${u.max})…`);
      const it = queue.get(u.id);
      if (it) it.rate = null;
      if (u.message) {
        const what = it ? it.name : `transfer ${u.id}`;
        log(`Retrying ${what} (${u.attempt}/${u.max}): ${u.message}`, "error");
      }
      break;
    }
    case "done": {
      const it = queue.get(u.id);
      if (it) {
        it.fill.style.width = "100%";
        it.stat.textContent = "Done";
        queueRun.success++;
        if (it.connectionId != null) queueRun.conns.add(it.connectionId);
        setRowStatus(it, "success");
        log(`Transfer complete: ${it.name}`, "success");
        // Show the result in the destination pane (debounced so a folder of
        // many files refreshes once, not per file).
        scheduleRefresh(it.direction === "download" ? "local" : "remote");
      }
      break;
    }
    case "cancelled": {
      const it = queue.get(u.id);
      if (it) {
        it.stat.textContent = "Cancelled";
        setRowStatus(it, "failed");
        log(`Transfer cancelled: ${it.name}`);
      }
      break;
    }
    case "error": {
      const it = queue.get(u.id);
      if (it) {
        it.stat.textContent = "Failed";
        it.row.title = u.message;
        queueRun.failed++;
        if (it.connectionId != null) queueRun.conns.add(it.connectionId);
        setRowStatus(it, "failed");
      }
      log(`Transfer failed: ${u.message}`, "error");
      break;
    }
  }
}

// Coalesce post-transfer pane refreshes so a folder of many files re-lists once.
const refreshTimers = {};
function scheduleRefresh(side) {
  clearTimeout(refreshTimers[side]);
  refreshTimers[side] = setTimeout(() => refresh(side), 400);
}

// Join a directory and file name with the destination's path style.
function joinTransferPath(dir, name, remote) {
  if (!dir) return name || "";
  const sep = remote ? "/" : dir.includes("\\") ? "\\" : "/";
  return dir.replace(/[/\\]+$/, "") + sep + name;
}

function addQueueRow(u) {
  const isDownload = u.direction === "download";
  // The Queued event carries src (remote for downloads, local for uploads) +
  // dst_dir, so we can show the full local and remote paths. Skipped-file rows
  // pass only id/direction/name/size, so guard for missing path data.
  const hasPaths = u.src != null && u.dst_dir != null;
  const localPath = hasPaths
    ? isDownload
      ? joinTransferPath(u.dst_dir, u.name, false)
      : u.src
    : "";
  const remotePath = hasPaths ? (isDownload ? u.src : joinTransferPath(u.dst_dir, u.name, true)) : "";
  const tab = tabs.find((t) => t.id === u.connection_id);
  const server = tab ? tab.label : "";

  const row = document.createElement("div");
  row.className = "q-row";
  row.dataset.status = "active";
  row.innerHTML =
    '<div class="q-head">' +
    `<span class="q-dir" title="${isDownload ? "Download" : "Upload"}">${isDownload ? "↓" : "↑"}</span>` +
    `<span class="q-name"></span>` +
    `<span class="q-size">${u.size ? formatSize(u.size) : ""}</span>` +
    `<div class="q-bar"><div class="q-fill"></div></div>` +
    `<span class="q-stat">Queued</span>` +
    `<span class="q-actions">` +
    `<button class="q-act q-cancel" title="Cancel transfer" aria-label="Cancel">✕</button>` +
    `<button class="q-act q-retry" title="Retry transfer" aria-label="Retry" hidden>↻</button>` +
    `</span>` +
    "</div>" +
    '<div class="q-paths">' +
    `<span class="q-server"></span>` +
    `<span class="q-route"><span class="q-local"></span>` +
    `<span class="q-arrow">${isDownload ? "←" : "→"}</span><span class="q-remote"></span></span>` +
    "</div>";
  row.querySelector(".q-name").textContent = u.name;
  const paths = row.querySelector(".q-paths");
  if (hasPaths || server) {
    const serverEl = row.querySelector(".q-server");
    serverEl.textContent = server;
    serverEl.title = server;
    const localEl = row.querySelector(".q-local");
    const remoteEl = row.querySelector(".q-remote");
    localEl.textContent = localPath;
    localEl.title = localPath;
    remoteEl.textContent = remotePath;
    remoteEl.title = remotePath;
  } else {
    paths.hidden = true; // skipped rows have no path data
  }
  document.getElementById("queue-list").appendChild(row);
  const it = {
    row,
    direction: u.direction,
    name: u.name,
    connectionId: u.connection_id,
    fill: row.querySelector(".q-fill"),
    stat: row.querySelector(".q-stat"),
    cancelBtn: row.querySelector(".q-cancel"),
    retryBtn: row.querySelector(".q-retry"),
  };
  it.cancelBtn.addEventListener("click", () => cancelTransfer(u.id));
  it.retryBtn.addEventListener("click", () => retryTransfer(u.id));
  queue.set(u.id, it);
  updateQueueCounts();
  return it;
}

// Files skipped by the file-exists policy land in the Successful tab, marked
// "Skipped", rather than just being logged. They use a local
// string id since there's no backend transfer.
let skipCounter = 0;
function addSkippedRow(direction, name, size) {
  const it = addQueueRow({ id: `skip-${(skipCounter += 1)}`, direction, name, size });
  if (!it) return;
  it.row.classList.add("q-skipped");
  it.fill.style.width = "0%";
  it.stat.textContent = "Skipped";
  setRowStatus(it, "success");
}

function updateQueueProgress(id, transferred, size) {
  const it = queue.get(id);
  if (!it) return;
  const pct = size > 0 ? Math.min(100, Math.round((transferred / size) * 100)) : 0;
  it.fill.style.width = `${pct}%`;
  // Derive speed from successive progress events, smoothed (EMA) so it reads
  // steady rather than jumping with every network hiccup. A byte count lower
  // than the last sample means the transfer restarted — drop the baseline.
  const now = performance.now();
  if (!it.rate || transferred < it.rate.bytes) {
    it.rate = { t: now, bytes: transferred, speed: 0 };
  } else if (now - it.rate.t >= 200) {
    const inst = ((transferred - it.rate.bytes) * 1000) / (now - it.rate.t);
    it.rate.speed = it.rate.speed ? it.rate.speed * 0.7 + inst * 0.3 : inst;
    it.rate.t = now;
    it.rate.bytes = transferred;
  }
  const speed = it.rate.speed ? ` · ${formatSpeed(it.rate.speed)}` : "";
  it.stat.textContent =
    (size > 0 ? `${pct}% · ${formatSize(transferred)}` : formatSize(transferred)) + speed;
}

function setQueueStat(id, text) {
  const it = queue.get(id);
  if (it) it.stat.textContent = text;
}

// Move a row between the Queued / Failed / Successful groups (data-status drives
// which tab shows it) and toggle the relevant action button.
function setRowStatus(it, status) {
  it.row.dataset.status = status;
  it.cancelBtn.hidden = status !== "active";
  it.retryBtn.hidden = status !== "failed";
  updateQueueCounts();
}

function updateQueueCounts() {
  let active = 0;
  let failed = 0;
  let success = 0;
  for (const it of queue.values()) {
    const s = it.row.dataset.status;
    if (s === "active") active++;
    else if (s === "failed") failed++;
    else if (s === "success") success++;
  }
  document.getElementById("count-active").textContent = active;
  document.getElementById("count-failed").textContent = failed;
  document.getElementById("count-success").textContent = success;
  // The queue just drained (last active transfer reached a terminal state) —
  // notify with this run's tally.
  if (prevActiveCount > 0 && active === 0) notifyQueueDrained();
  prevActiveCount = active;
}

// Desktop notification when the queue finishes, but only while Packetboat is in
// the background (hidden to tray or another window focused) — no point nudging
// someone who's watching the queue. Resets the per-run tally either way.
function notifyQueueDrained() {
  const { success, failed, conns } = queueRun;
  // If the whole run went to one connection, clicking the notification can jump
  // to that tab; otherwise just focus the window.
  const tab = conns.size === 1 ? [...conns][0] : null;
  queueRun.success = 0;
  queueRun.failed = 0;
  queueRun.conns = new Set();
  if (!settings.notifications || success + failed === 0 || document.hasFocus()) return;
  const files = (n) => `${n} file${n === 1 ? "" : "s"}`;
  let title, body;
  if (failed === 0) {
    title = "Transfers complete";
    body = `${files(success)} transferred.`;
  } else if (success === 0) {
    title = "Transfers failed";
    body = `${failed} transfer${failed === 1 ? "" : "s"} failed.`;
  } else {
    title = "Transfers finished";
    body = `${success} transferred, ${failed} failed.`;
  }
  invoke("notify", { title, body, tab }).catch(() => {});
}

function switchQueueTab(tab) {
  document.getElementById("queue-list").dataset.tab = tab;
  for (const btn of document.querySelectorAll(".q-tab")) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
}

async function cancelTransfer(id) {
  try {
    await invoke("cancel_transfer", { id });
  } catch (e) {
    log(`Cancel failed: ${e}`, "error");
  }
}

async function retryTransfer(id) {
  const request = transferRequests.get(id);
  if (!request) return;
  // Drop the failed row + record, then re-enqueue (a fresh row arrives via the
  // queued event) and jump to the Queued tab.
  const it = queue.get(id);
  if (it) it.row.remove();
  queue.delete(id);
  transferRequests.delete(id);
  try {
    const newId = await invoke("enqueue_transfer", { request });
    transferRequests.set(newId, request);
  } catch (e) {
    setStatus(`Transfer: ${e}`, true);
  }
  updateQueueCounts();
  switchQueueTab("active");
}

function clearFinished() {
  for (const [id, it] of queue) {
    const s = it.row.dataset.status;
    if (s === "success" || s === "failed") {
      it.row.remove();
      queue.delete(id);
      transferRequests.delete(id);
    }
  }
  updateQueueCounts();
}

// ---- File operations & context menu ----
let activeMenu = null;

function closeMenu() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
}

function showMenu(x, y, items) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  for (const it of items) {
    if (it.sep) {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      menu.appendChild(sep);
      continue;
    }
    const item = document.createElement("div");
    item.className = "ctx-item" + (it.danger ? " danger" : "");
    item.textContent = it.label;
    item.addEventListener("click", () => {
      closeMenu();
      it.action();
    });
    menu.appendChild(item);
  }
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);
  // Keep the menu on screen.
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = `${Math.max(4, x - r.width)}px`;
  if (r.bottom > window.innerHeight) menu.style.top = `${Math.max(4, y - r.height)}px`;
  activeMenu = menu;
}

function showFileMenu(x, y, entries, side) {
  const items = [];
  const n = entries.length;
  const many = n > 1 ? ` (${n})` : "";
  items.push({
    label: (side === "remote" ? "Download" : "Upload") + many,
    action: () => transferManyEntries(entries, side),
  });
  if (n === 1) items.push({ label: "Rename…", action: () => renameEntry(entries[0], side) });
  items.push({
    label: n > 1 ? `Delete${many}` : "Delete",
    danger: true,
    action: () => deleteEntries(entries, side),
  });
  items.push({ sep: true });
  items.push({ label: "New folder…", action: () => newFolder(side) });
  items.push({ label: "Refresh", action: () => refresh(side) });
  showMenu(x, y, items);
}

async function transferManyEntries(entries, side) {
  for (const e of entries) {
    // eslint-disable-next-line no-await-in-loop
    await transferEntry(e, side);
  }
}

function showBgMenu(x, y, side) {
  showMenu(x, y, [
    { label: "New folder…", action: () => newFolder(side) },
    { label: "Refresh", action: () => refresh(side) },
  ]);
}

async function renameEntry(entry, side) {
  const name = await promptDialog(`Rename "${entry.name}"`, "New name", entry.name);
  if (!name || name === entry.name) return;
  try {
    await invoke(side === "local" ? "local_rename" : "remote_rename", {
      id: activeTabId,
      from: entry.path,
      name,
    });
    setStatus(`Renamed to ${name}`);
    refresh(side);
  } catch (e) {
    setStatus(`Rename failed: ${e}`, true);
  }
}

// Delete an entry. The local backend removes folders recursively already; remote
// backends' rmdir/RMD is not recursive, so for a remote folder we walk its tree
// (list_tree returns full backend-native paths, parents before children) and
// delete files first, then directories deepest-first, then the folder itself.
async function removeEntry(entry, side) {
  if (entry.kind === "dir" && side !== "local") {
    const tree = await invoke("list_tree", { side, id: activeTabId, path: entry.path });
    const rm = (path, dir) => invoke("remote_remove", { id: activeTabId, path, dir });
    for (const t of tree) if (t.kind !== "dir") await rm(t.path, false);
    for (const t of [...tree].reverse()) if (t.kind === "dir") await rm(t.path, true);
    await rm(entry.path, true);
    return;
  }
  await invoke(side === "local" ? "local_remove" : "remote_remove", {
    id: activeTabId,
    path: entry.path,
    dir: entry.kind === "dir",
  });
}

async function deleteEntry(entry, side) {
  const detail =
    entry.kind === "dir"
      ? "This deletes the folder and everything in it."
      : "This can't be undone.";
  if (!(await confirmDialog(`Delete "${entry.name}"?`, detail, "Delete"))) return;
  try {
    await removeEntry(entry, side);
    setStatus(`Deleted ${entry.name}`);
    refresh(side);
  } catch (e) {
    setStatus(`Delete failed: ${e}`, true);
  }
}

async function deleteEntries(entries, side) {
  if (entries.length <= 1) {
    if (entries.length === 1) await deleteEntry(entries[0], side);
    return;
  }
  const detail = "This can't be undone. Folders are deleted with everything in them.";
  if (!(await confirmDialog(`Delete ${entries.length} items?`, detail, "Delete"))) return;
  let failed = 0;
  for (const e of entries) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await removeEntry(e, side);
    } catch (_) {
      failed += 1;
    }
  }
  setStatus(
    failed
      ? `Deleted ${entries.length - failed} of ${entries.length} — ${failed} failed`
      : `Deleted ${entries.length} items`,
  );
  refresh(side);
}

async function newFolder(side) {
  const parent = side === "local" ? state.local.path : state.remote.path;
  if (!parent) return;
  const name = await promptDialog("New folder", "Folder name", "");
  if (!name) return;
  try {
    await invoke(side === "local" ? "local_mkdir" : "remote_mkdir", { id: activeTabId, parent, name });
    setStatus(`Created ${name}`);
    refresh(side);
  } catch (e) {
    setStatus(`New folder failed: ${e}`, true);
  }
}

// ---- Dialogs (promise-based prompt / confirm) ----
function buildDialog({ title, label, value, confirmText, input, inputType, trim }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const form = document.createElement("form");
    form.className = "modal modal-sm";

    const h = document.createElement("h2");
    h.textContent = title;
    form.appendChild(h);
    if (label) {
      const p = document.createElement("p");
      p.className = "dialog-body";
      p.textContent = label;
      form.appendChild(p);
    }
    let field = null;
    if (input) {
      field = document.createElement("input");
      field.className = "dialog-input";
      field.type = inputType || "text";
      field.value = value || "";
      form.appendChild(field);
    }
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.type = "submit";
    ok.className = "btn btn-primary";
    ok.textContent = confirmText || "OK";
    actions.append(cancel, ok);
    form.appendChild(actions);
    backdrop.appendChild(form);
    document.body.appendChild(backdrop);

    if (field) {
      field.focus();
      field.select();
    } else {
      ok.focus();
    }

    const done = (result) => {
      backdrop.remove();
      resolve(result);
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      done(input ? (trim === false ? field.value : field.value.trim()) : true);
    });
    cancel.addEventListener("click", () => done(input ? null : false));
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) done(input ? null : false);
    });
    backdrop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done(input ? null : false);
    });
  });
}

function promptDialog(title, label, value) {
  return buildDialog({ title, label, value, input: true, confirmText: "OK" });
}

function confirmDialog(title, label, confirmText) {
  return buildDialog({ title, label, input: false, confirmText });
}

// Masked password prompt (no trimming — passwords may contain spaces).
function promptPassword(title, label) {
  return buildDialog({ title, label, input: true, inputType: "password", trim: false, confirmText: "Connect" });
}

// Make a pane's list a drop target for files dragged from the other pane.
function dropAccepts(ev, targetSide) {
  return (
    [...ev.dataTransfer.types].includes("Files") ||
    (dragItems && dragItems.length && dragItems[0].side !== targetSide)
  );
}

function setupDropZone(listEl, targetSide) {
  listEl.addEventListener("dragover", (ev) => {
    if (dropAccepts(ev, targetSide)) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "copy";
      listEl.classList.add("drop-active");
    }
  });
  listEl.addEventListener("dragleave", (ev) => {
    if (!listEl.contains(ev.relatedTarget)) listEl.classList.remove("drop-active");
  });
  listEl.addEventListener("drop", (ev) => {
    ev.preventDefault();
    listEl.classList.remove("drop-active");
    handleDrop(ev, targetSide, state[targetSide].path);
  });
}

// ---- Settings ----
const SETTINGS_KEY = "packetboat.settings";
const settings = {
  theme: "dark",
  onConnect: "ask",
  showLog: true,
  showQueue: true,
  // When on (the default), closing the window hides Packetboat to the system
  // tray instead of quitting.
  closeToTray: true,
  // Desktop notification when the transfer queue finishes while the app is in
  // the background.
  notifications: true,
  // Concurrent transfers: overall cap (1-10) plus per-direction caps (0 = no
  // limit).
  maxTransfers: 2,
  maxDownloads: 0,
  maxUploads: 0,
  // Replace characters the local OS forbids in filenames when downloading, and
  // the character to replace them with.
  replaceInvalidChars: true,
  invalidCharReplacement: "_",
  // What to do when a transfer's target file already exists. One of:
  // ask | overwrite | newer | size | rename | skip.
  conflictDownload: "ask",
  conflictUpload: "ask",
  // Auto-update: whether to check on a schedule, how often (launch | daily |
  // weekly | monthly), and when the last successful check ran (epoch ms).
  updateCheckEnabled: true,
  updateInterval: "launch",
  lastUpdateCheck: 0,
};

function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"));
  } catch (_) {
    /* ignore */
  }
  applyTheme(settings.theme);
  applyPanelVisibility();
  applyCloseToTray();
  applyTransferLimits();
}

// Push the concurrency limits to the transfer engine (no-op without a backend).
function applyTransferLimits() {
  invoke("set_transfer_limits", {
    max: clampInt(settings.maxTransfers, 1, 10, 2),
    downloads: clampInt(settings.maxDownloads, 0, 10, 0),
    uploads: clampInt(settings.maxUploads, 0, 10, 0),
  }).catch(() => {});
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Push the close-to-tray preference to the backend, which owns the window's
// close behavior. Best-effort (no-op when there's no Tauri backend, e.g. the
// browser dev preview).
function applyCloseToTray() {
  invoke("set_close_to_tray", { enabled: settings.closeToTray }).catch(() => {});
}

// Show/hide the message log + transfer queue per the saved settings, and keep
// the toolbar toggle buttons' active state in sync.
function applyPanelVisibility() {
  el.logpanel.hidden = !settings.showLog;
  document.getElementById("queue").hidden = !settings.showQueue;
  document.getElementById("tool-log").classList.toggle("active", settings.showLog);
  document.getElementById("tool-queue").classList.toggle("active", settings.showQueue);
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (_) {
    /* ignore */
  }
}

function applyTheme(theme) {
  const resolved =
    theme === "system"
      ? matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : theme;
  document.documentElement.setAttribute("data-theme", resolved);
}

function openSettings() {
  el.setTheme.value = settings.theme;
  el.setOnConnect.value = settings.onConnect;
  el.setShowLog.checked = settings.showLog;
  el.setShowQueue.checked = settings.showQueue;
  el.setCloseToTray.checked = settings.closeToTray;
  el.setNotifications.checked = settings.notifications;
  el.setMaxTransfers.value = settings.maxTransfers;
  el.setMaxDownloads.value = settings.maxDownloads;
  el.setMaxUploads.value = settings.maxUploads;
  el.setReplaceInvalid.checked = settings.replaceInvalidChars;
  el.setInvalidReplacement.value = settings.invalidCharReplacement;
  el.setInvalidReplacement.disabled = !settings.replaceInvalidChars;
  el.setConflictDownload.value = settings.conflictDownload;
  el.setConflictUpload.value = settings.conflictUpload;
  el.setUpdateCheck.checked = settings.updateCheckEnabled;
  el.setUpdateInterval.value = settings.updateInterval;
  el.updateIntervalField.hidden = !settings.updateCheckEnabled;
  renderUpdateStatus(null); // clear any stale result from a prior open
  renderLastChecked();
  switchSettingsTab("general");
  el.settingsModal.hidden = false;
}

function closeSettings() {
  el.settingsModal.hidden = true;
}

// Show one settings category (General / Transfers) and mark its tab active.
function switchSettingsTab(name) {
  el.settingsModal.querySelectorAll(".settings-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.settingsTab === name);
  });
  el.settingsModal.querySelectorAll(".settings-section").forEach((section) => {
    section.hidden = section.dataset.settingsSection !== name;
  });
}

// Prompt shown when connecting while already connected.
// Resolves to { action: "new-tab" | "replace", always } or null if cancelled.
function askConnectBehavior() {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const form = document.createElement("form");
    form.className = "modal modal-sm";
    form.innerHTML =
      "<h2>Already connected</h2>" +
      '<p class="dialog-body">You’re already connected to a server.</p>' +
      '<label class="radio"><input type="radio" name="cb" value="new-tab" checked /> Open the connection in a new tab</label>' +
      '<label class="radio"><input type="radio" name="cb" value="replace" /> Replace the current connection</label>' +
      '<label class="check"><input type="checkbox" class="switch" id="cb-always" /> Always do this</label>' +
      '<div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn btn-primary">OK</button></div>';
    backdrop.appendChild(form);
    document.body.appendChild(backdrop);
    const done = (r) => {
      backdrop.remove();
      resolve(r);
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      done({
        action: form.querySelector('input[name="cb"]:checked').value,
        always: form.querySelector("#cb-always").checked,
      });
    });
    form.querySelector("[data-cancel]").addEventListener("click", () => done(null));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) done(null);
    });
  });
}

// ---- Wiring ----
function wireEvents() {
  el.disconnectBtn.addEventListener("click", doDisconnect);

  // Quick connect
  document.getElementById("qc-connect").addEventListener("click", quickConnect);
  el.qcHost.addEventListener("keydown", (e) => {
    if (e.key === "Enter") quickConnect();
  });
  el.qcPass.addEventListener("keydown", (e) => {
    if (e.key === "Enter") quickConnect();
  });
  el.qcProtocol.addEventListener("change", () => {
    const p = el.qcPort.value;
    if (!p || p === "22" || p === "21") el.qcPort.value = defaultPort(el.qcProtocol.value);
  });

  // Site manager
  document.getElementById("open-sites").addEventListener("click", openSites);
  document.getElementById("sites-dropdown").addEventListener("click", (ev) => {
    ev.stopPropagation(); // don't let the global click handler close the menu we open
    openSitesDropdown(ev.currentTarget);
  });
  document.getElementById("connect-btn-2").addEventListener("click", openSites);
  document.getElementById("sites-close").addEventListener("click", closeSites);
  document.getElementById("site-new").addEventListener("click", newSite);
  document.getElementById("site-duplicate").addEventListener("click", duplicateSite);
  document.getElementById("site-delete").addEventListener("click", deleteSite);
  document.getElementById("site-import").addEventListener("click", importSites);
  document.getElementById("site-export").addEventListener("click", () =>
    exportSites(sites.filter((s) => selectedSiteIds.includes(s.id))),
  );
  // The caret opens a menu so it's explicit what gets exported: the current
  // selection, or every saved site.
  document.getElementById("site-export-all").addEventListener("click", (ev) => {
    ev.stopPropagation(); // don't let the global click handler close the menu we open
    const selected = sites.filter((s) => selectedSiteIds.includes(s.id));
    const items = [];
    if (selected.length) {
      items.push({
        label: `Export selected (${selected.length})`,
        action: () => exportSites(selected),
      });
    }
    items.push({ label: `Export all sites (${sites.length})`, action: () => exportSites([...sites]) });
    const r = ev.currentTarget.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, items);
  });
  document.getElementById("site-save").addEventListener("click", saveSite);
  document.getElementById("site-connect").addEventListener("click", connectSite);
  el.siteLocalBrowse.addEventListener("click", browseLocalDir);
  el.sitesModal.addEventListener("mousedown", (e) => {
    if (e.target === el.sitesModal) closeSites();
  });
  const reDefaultSitePort = () => {
    const p = el.sitePort.value;
    if (!p || p === "22" || p === "21" || p === "990")
      el.sitePort.value = defaultPort(el.siteProtocol.value, el.siteEncryption.value);
  };
  el.siteProtocol.addEventListener("change", () => {
    reDefaultSitePort();
    updateProtocolFields();
  });
  // Implicit FTPS conventionally uses port 990; reflect that as the default.
  el.siteEncryption.addEventListener("change", reDefaultSitePort);
  el.siteLogon.addEventListener("change", updateLogonFields);
  el.siteKeyBrowse.addEventListener("click", browseKeyFile);
  el.siteOpTest.addEventListener("click", testOpReference);
  // Clean pasted references (1Password copies them wrapped in quotes) as you go.
  el.siteOpReference.addEventListener("input", () => {
    const cleaned = normalizeOpRef(el.siteOpReference.value);
    if (cleaned !== el.siteOpReference.value) el.siteOpReference.value = cleaned;
  });

  document.querySelectorAll(".pane-tools .icon-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const { act, side } = btn.dataset;
      if (act === "up") goUp(side);
      else if (act === "refresh") refresh(side);
    });
  });

  setupDropZone(el.listLocal, "local");
  setupDropZone(el.listRemote, "remote");

  el.pathLocal.addEventListener("keydown", (e) => {
    if (e.key === "Enter") navigateLocal(el.pathLocal.value.trim());
  });
  el.pathRemote.addEventListener("keydown", (e) => {
    if (e.key === "Enter") navigateRemote(el.pathRemote.value.trim());
  });

  document.getElementById("queue-clear").addEventListener("click", clearFinished);
  for (const tab of document.querySelectorAll(".q-tab")) {
    tab.addEventListener("click", () => switchQueueTab(tab.dataset.tab));
  }
  document.getElementById("log-clear").addEventListener("click", () => {
    el.logList.innerHTML = "";
  });

  document.getElementById("tool-refresh").addEventListener("click", () => {
    refresh("local");
    refresh("remote");
  });
  document.getElementById("tool-log").addEventListener("click", () => {
    settings.showLog = !settings.showLog;
    saveSettings();
    applyPanelVisibility();
  });
  document.getElementById("tool-queue").addEventListener("click", () => {
    settings.showQueue = !settings.showQueue;
    saveSettings();
    applyPanelVisibility();
  });

  document.getElementById("tool-settings").addEventListener("click", openSettings);
  document.getElementById("settings-close").addEventListener("click", closeSettings);
  // Dismiss on a backdrop press (mousedown, like the Site Manager) rather than
  // click — so releasing a resize drag outside the modal doesn't close it.
  el.settingsModal.addEventListener("mousedown", (e) => {
    if (e.target === el.settingsModal) closeSettings();
  });
  el.settingsModal.querySelectorAll(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchSettingsTab(tab.dataset.settingsTab));
  });
  el.setTheme.addEventListener("change", () => {
    settings.theme = el.setTheme.value;
    applyTheme(settings.theme);
    saveSettings();
  });
  el.setOnConnect.addEventListener("change", () => {
    settings.onConnect = el.setOnConnect.value;
    saveSettings();
  });
  el.setShowLog.addEventListener("change", () => {
    settings.showLog = el.setShowLog.checked;
    saveSettings();
    applyPanelVisibility();
  });
  el.setShowQueue.addEventListener("change", () => {
    settings.showQueue = el.setShowQueue.checked;
    saveSettings();
    applyPanelVisibility();
  });
  el.setCloseToTray.addEventListener("change", () => {
    settings.closeToTray = el.setCloseToTray.checked;
    saveSettings();
    applyCloseToTray();
  });
  el.setNotifications.addEventListener("change", () => {
    settings.notifications = el.setNotifications.checked;
    saveSettings();
  });
  for (const [input, key] of [
    [el.setMaxTransfers, "maxTransfers"],
    [el.setMaxDownloads, "maxDownloads"],
    [el.setMaxUploads, "maxUploads"],
  ]) {
    input.addEventListener("change", () => {
      settings[key] = clampInt(input.value, key === "maxTransfers" ? 1 : 0, 10, settings[key]);
      input.value = settings[key];
      saveSettings();
      applyTransferLimits();
    });
  }
  el.setReplaceInvalid.addEventListener("change", () => {
    settings.replaceInvalidChars = el.setReplaceInvalid.checked;
    el.setInvalidReplacement.disabled = !settings.replaceInvalidChars;
    saveSettings();
  });
  el.setInvalidReplacement.addEventListener("change", () => {
    // Strip any forbidden char so the replacement can't reintroduce one.
    settings.invalidCharReplacement = el.setInvalidReplacement.value.replace(INVALID_LOCAL_CHARS, "");
    el.setInvalidReplacement.value = settings.invalidCharReplacement;
    saveSettings();
  });
  el.setConflictDownload.addEventListener("change", () => {
    settings.conflictDownload = el.setConflictDownload.value;
    sessionConflict.download = null; // new default clears any session override
    saveSettings();
  });
  el.setConflictUpload.addEventListener("change", () => {
    settings.conflictUpload = el.setConflictUpload.value;
    sessionConflict.upload = null;
    saveSettings();
  });
  el.setUpdateCheck.addEventListener("change", () => {
    settings.updateCheckEnabled = el.setUpdateCheck.checked;
    el.updateIntervalField.hidden = !settings.updateCheckEnabled;
    saveSettings();
  });
  el.setUpdateInterval.addEventListener("change", () => {
    settings.updateInterval = el.setUpdateInterval.value;
    saveSettings();
  });
  el.checkUpdatesBtn.addEventListener("click", manualCheckUpdate);
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (settings.theme === "system") applyTheme("system");
  });
  // Re-evaluate whether the connection cluster needs its own row as the window
  // resizes (rAF-debounced).
  let wrapRaf = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(wrapRaf);
    wrapRaf = requestAnimationFrame(updateAppbarWrap);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeMenu();
    if (!el.sitesModal.hidden) closeSites();
  });

  // Right-click context menus + marquee selection on each pane.
  for (const [body, side] of [
    [el.bodyLocal, "local"],
    [el.bodyRemote, "remote"],
  ]) {
    setupMarquee(body);
    // Focusable (so it can receive keystrokes) + type-ahead: clicking a pane
    // focuses its body, then typing jumps to the matching file.
    body.tabIndex = -1;
    body.addEventListener("keydown", (ev) => onPaneTypeahead(body, ev));
    body.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const rowEl = ev.target.closest(".row");
      if (rowEl && rowEl._entry) {
        // Right-clicking outside the current selection re-selects just that row;
        // right-clicking within it keeps the whole selection for the menu.
        if (!rowEl.classList.contains("selected")) {
          clearSelection(body);
          rowEl.classList.add("selected");
          body._anchor = [...body.querySelectorAll(".row")].indexOf(rowEl);
        }
        showFileMenu(ev.clientX, ev.clientY, selectedEntries(body), side);
      } else if (!(side === "remote" && !state.remote.connected)) {
        showBgMenu(ev.clientX, ev.clientY, side);
      }
    });
  }
  document.addEventListener("click", closeMenu);
  document.addEventListener("scroll", closeMenu, true);

  // Suppress the WebView's built-in right-click menu (Back / Refresh / Save as /
  // Print / Inspect) outside the panes. Block by default so production never
  // flashes it, then lift the block in dev builds so devtools stay reachable.
  // The panes' own menus run first and aren't affected.
  const blockContextMenu = (ev) => ev.preventDefault();
  document.addEventListener("contextmenu", blockContextMenu);
  invoke("is_dev")
    .then((dev) => {
      if (dev) document.removeEventListener("contextmenu", blockContextMenu);
    })
    .catch(() => {
      /* couldn't determine build; stay blocked (prod-safe) */
    });
}

async function init() {
  cacheEls();
  loadSettings();
  wireEvents();
  setConnState(false, "Not connected");
  renderTabs(); // no connections yet → tab bar hidden
  loadSites(); // populate the quick-connect dropdown
  renderTree("remote"); // "Not connected." placeholder
  log("Welcome to Packetboat.");
  try {
    const v = await invoke("app_version");
    appVersion = v || "";
    const versionEl = document.getElementById("app-version");
    if (versionEl && v) versionEl.textContent = `v${v}`;
  } catch (_) {
    /* version label is best-effort */
  }
  if (tauriEvent) {
    await tauriEvent.listen("transfer://update", (e) => onTransferUpdate(e.payload));
    // Clicking a "transfers finished" notification for a single-tab run jumps to
    // that connection's tab (the window is already brought forward by Rust).
    await tauriEvent.listen("notification://activate", (e) => {
      const id = e.payload;
      if (tabs.some((t) => t.id === id)) activateTab(id, true);
    });
  }
  try {
    await loadTreeRoots("local");
    const home = await invoke("local_home");
    await navigateLocal(home);
  } catch (e) {
    setStatus(`Could not open home directory: ${e}`, true);
  }
  if (shouldAutoCheckUpdate()) checkForUpdate();
}

// The app's own version (from the Rust `app_version` command), shown in the
// Updates tab. Set in init(); empty until then.
let appVersion = "";

const UPDATE_INTERVAL_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

// Whether an automatic (launch-time) update check is due, per the user's
// "check automatically" toggle and chosen frequency.
function shouldAutoCheckUpdate() {
  if (!settings.updateCheckEnabled) return false;
  if (settings.updateInterval === "launch") return true;
  const waitMs = UPDATE_INTERVAL_MS[settings.updateInterval];
  if (!waitMs) return true; // unknown interval → don't suppress
  return Date.now() - (settings.lastUpdateCheck || 0) >= waitMs;
}

// Ask the backend whether a newer signed release is available; if so, prompt.
// Silent on failure (dev builds, offline, updater not yet configured). Records
// the time only on a successful check so a failure retries next launch.
async function checkForUpdate() {
  try {
    const info = await invoke("check_update");
    settings.lastUpdateCheck = Date.now();
    saveSettings();
    if (info) promptUpdate(info);
  } catch (_) {
    /* no update / not configured */
  }
}

// Manual "Check now" from the Updates settings tab: shows inline status rather
// than the launch prompt.
async function manualCheckUpdate() {
  el.checkUpdatesBtn.disabled = true;
  renderUpdateStatus({ state: "checking" });
  try {
    const info = await invoke("check_update");
    settings.lastUpdateCheck = Date.now();
    saveSettings();
    renderLastChecked();
    renderUpdateStatus(info ? { state: "available", info } : { state: "uptodate" });
  } catch (err) {
    console.warn("update check failed:", err);
    renderUpdateStatus({ state: "error", message: String(err) });
  } finally {
    el.checkUpdatesBtn.disabled = false;
  }
}

// Render the inline update-check status box. `s` is null (hidden) or
// { state: "checking" | "uptodate" | "error" | "available", info? }.
function renderUpdateStatus(s) {
  const box = el.updateStatus;
  if (!box) return;
  box.textContent = "";
  box.className = "update-status";
  if (!s) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (s.state === "checking") {
    box.classList.add("muted");
    box.textContent = "Checking for updates…";
  } else if (s.state === "uptodate") {
    box.classList.add("success");
    box.textContent = appVersion
      ? `You're on the latest version (v${appVersion}).`
      : "You're on the latest version.";
  } else if (s.state === "error") {
    box.classList.add("muted");
    const detail = (s.message || "").replace(/\s+/g, " ").trim();
    const low = detail.toLowerCase();
    if (
      low.includes("404") ||
      low.includes("not found") ||
      low.includes("could not fetch") ||
      low.includes("no release") ||
      low.includes("json")
    ) {
      // The endpoint 404s until a signed release with latest.json is published.
      box.textContent =
        "No published release found yet — the updater starts working once your first signed GitHub release is published.";
    } else if (detail) {
      box.textContent = `Couldn't check for updates: ${detail}`;
    } else {
      box.textContent = "Couldn't check for updates.";
    }
  } else if (s.state === "available") {
    const msg = document.createElement("p");
    msg.className = "update-msg";
    const strong = document.createElement("strong");
    strong.textContent = `v${s.info.version}`;
    msg.append(strong, " is available.");
    box.appendChild(msg);
    // No release-body notes here — see promptUpdate for why.
    const install = document.createElement("button");
    install.type = "button";
    install.className = "btn btn-primary update-install";
    install.textContent = "Install and restart";
    install.addEventListener("click", async () => {
      install.disabled = true;
      install.textContent = "Downloading…";
      try {
        await invoke("install_update"); // app restarts on success
      } catch (err) {
        console.warn("update install failed:", err);
        renderUpdateStatus({ state: "error" });
      }
    });
    box.appendChild(install);
  }
}

// "Last checked <date>" line in the Updates tab (blank if never checked).
function renderLastChecked() {
  if (!el.updateLast) return;
  el.updateLast.textContent = settings.lastUpdateCheck
    ? `Last checked ${formatDate(Math.floor(settings.lastUpdateCheck / 1000))}`
    : "";
}

// "Update available" prompt. On accept, downloads + installs + relaunches (the
// install command doesn't return — the app restarts into the new version).
function promptUpdate(info) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const form = document.createElement("form");
  form.className = "modal modal-sm modal-update";
  // Note: we intentionally don't show `info.notes` here — the release body is a
  // download guide meant for the GitHub release page, not in-app update notes,
  // and it's raw markdown. If a proper changelog is added later, render it as
  // markdown rather than dumping the release body.
  form.innerHTML =
    "<h2>Update available</h2>" +
    '<p class="dialog-body">Packetboat <strong></strong> is available. Install it and restart now?</p>' +
    '<div class="modal-actions">' +
    '<button type="button" class="btn" data-later>Later</button>' +
    '<button type="submit" class="btn btn-primary" data-install>Install and restart</button>' +
    "</div>";
  form.querySelector("strong").textContent = `v${info.version}`;
  backdrop.appendChild(form);
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  form.querySelector("[data-later]").addEventListener("click", close);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("[data-install]");
    btn.disabled = true;
    btn.textContent = "Downloading…";
    try {
      await invoke("install_update"); // app restarts on success
    } catch (err) {
      setStatus(`Update failed: ${err}`, true);
      close();
    }
  });
}

window.addEventListener("DOMContentLoaded", init);
