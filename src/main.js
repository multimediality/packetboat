// Packetboat frontend. Talks to the Rust backend exclusively through Tauri
// commands (see src-tauri/src/lib.rs). The dark theme lives in styles.css.

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
  el.setConflictDownload = document.getElementById("set-conflict-download");
  el.setConflictUpload = document.getElementById("set-conflict-upload");
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
  el.sitesError = document.getElementById("sites-error");
  el.siteName = document.getElementById("site-name");
  el.siteProtocol = document.getElementById("site-protocol");
  el.siteHost = document.getElementById("site-host");
  el.sitePort = document.getElementById("site-port");
  el.siteUser = document.getElementById("site-user");
  el.sitePass = document.getElementById("site-pass");
  el.siteLogon = document.getElementById("site-logon");
  el.siteLogonHint = document.getElementById("site-logon-hint");
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
let dragItem = null;

function renderList(body, entries, side) {
  if (entries.length === 0) {
    setPaneMessage(body, "This folder is empty.");
    return;
  }
  sortEntries(entries);
  body.innerHTML = "";
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

    row.addEventListener("click", () => selectRow(body, row));
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
      dragItem = { side, name: e.name, path: e.path, size: e.size, kind: e.kind };
      row.classList.add("dragging");
      ev.dataTransfer.effectAllowed = "copy";
      ev.dataTransfer.setData("text/plain", e.path);
    });
    row.addEventListener("dragend", () => {
      dragItem = null;
      row.classList.remove("dragging");
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

function selectRow(body, row) {
  body.querySelectorAll(".row.selected").forEach((r) => r.classList.remove("selected"));
  row.classList.add("selected");
}

// ---- Navigation ----
async function navigateLocal(path) {
  setPaneMessage(el.bodyLocal, "Loading…");
  try {
    const entries = await invoke("list_local", { path });
    state.local.path = path;
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
  setPaneMessage(el.bodyRemote, "Loading…");
  try {
    const entries = await invoke("list_remote", { id: activeTabId, path });
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

function pathSep(p) {
  return p.includes("\\") ? "\\" : "/";
}

// `path` relative to `root` (compared with forward slashes), or null if `path`
// isn't under `root`.
function relativeUnder(path, root) {
  const np = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const nr = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (np === nr) return "";
  return np.startsWith(nr + "/") ? np.slice(nr.length + 1) : null;
}

function joinUnder(root, rel) {
  if (!rel) return root;
  const sep = pathSep(root);
  return root.replace(/[/\\]+$/, "") + sep + rel.split("/").join(sep);
}

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
  if (navigate) {
    if (tab && tab.remote.path) navigateRemote(tab.remote.path);
    else {
      el.bodyRemote.innerHTML = "";
      el.pathRemote.value = "";
    }
  }
}

function addTab(id, label, cloud = false) {
  // `cloud` marks object-store backends (S3/B2/WebDAV) which can't resume
  // uploads (no append) — used to hide that option in the conflict prompt.
  tabs.push({ id, label, cloud, remote: { path: null, connected: true }, tree: freshTree() });
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
async function doConnectWith({
  protocol,
  host,
  port,
  username,
  password,
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
      result = await invoke("connect_sftp", { config: { host, port, username, password } });
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
    await navigateRemote(remoteDir || result.home);
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
let selectedSiteId = null;

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
  } catch (_) {
    sites = [];
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
    return;
  }
  for (const site of sites) {
    const item = document.createElement("div");
    item.className = "site-item" + (site.id === selectedSiteId ? " selected" : "");
    const name = document.createElement("span");
    name.textContent = site.name || site.host || "Untitled";
    const sub = document.createElement("span");
    sub.className = "site-host";
    const detail = isCloud(site.protocol)
      ? (site.config && (site.config.bucket || site.config.endpoint)) || "—"
      : site.host || "—";
    sub.textContent = `${site.protocol.toUpperCase()} · ${detail}`;
    item.append(name, sub);
    item.addEventListener("click", () => selectSite(site.id));
    el.sitesList.appendChild(item);
  }
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
  // Cloud sites pre-fill the per-service inputs from saved config; secret keys
  // are loaded from the keychain in selectSite().
  updateProtocolFields(site && site.config ? { ...site.config } : {});
  el.siteLocalDir.value = site ? site.local_dir || "" : "";
  el.siteRemoteDir.value = site ? site.remote_dir || "" : "";
  el.siteSync.checked = site ? !!site.sync_browsing : false;
}

async function selectSite(id) {
  selectedSiteId = id;
  const site = sites.find((s) => s.id === id);
  fillSiteForm(site);
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
    } else {
      await invoke("secret_delete", { id: site.id });
    }
    setSitesError(null);
    renderSites();
    setStatus(`Saved site "${site.name}"`);
  } catch (e) {
    setSitesError(String(e));
  }
}

async function deleteSite() {
  const idx = sites.findIndex((s) => s.id === selectedSiteId);
  if (idx < 0) return;
  const [removed] = sites.splice(idx, 1);
  selectedSiteId = null;
  try {
    if (isCloud(removed.protocol)) {
      for (const key of cloudSecretKeys(removed.protocol)) {
        await invoke("secret_delete", { id: `${removed.id}:${key}` });
      }
    } else {
      await invoke("secret_delete", { id: removed.id });
    }
    await invoke("sites_save", { sites });
  } catch (_) {
    /* ignore */
  }
  fillSiteForm(null);
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
  encryption,
  passive,
  siteId,
  localDir,
  remoteDir,
  sync,
}) {
  let user = username;
  let pw = password || "";

  if (logonType === "anonymous") {
    user = "anonymous";
    pw = "";
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
    encryption,
    passive,
    label: name && name !== host ? `${name} — ${who}` : who,
    localDir,
    remoteDir,
    sync,
  });
}

// Enable/disable the username and password fields to match the logon type.
function updateLogonFields() {
  const t = el.siteLogon.value;
  const showUser = t !== "anonymous";
  const showPass = t === "normal";
  el.siteUser.closest(".field").hidden = !showUser;
  el.sitePass.closest(".field").hidden = !showPass;
  if (!showUser) el.siteUser.value = "";
  if (!showPass) el.sitePass.value = "";
  el.siteLogonHint.textContent =
    {
      normal:
        "Username and password are saved — the password goes in your OS keychain (Windows Credential Manager), never the site file.",
      ask: "Only the username is saved. You'll be asked for the password each time you connect.",
      anonymous: "Connects as “anonymous” — no username or password needed (FTP).",
    }[t] || "";
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

function openSites() {
  setSitesError(null);
  el.sitesModal.hidden = false;
  loadSites();
}

function closeSites() {
  el.sitesModal.hidden = true;
}

// ---- Transfers ----
const queue = new Map();
// Full TransferRequest per id, kept so a failed/cancelled transfer can be retried.
const transferRequests = new Map();

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

// Build a non-colliding "name (n).ext" within the destination directory.
function dedupeName(name, dirMap) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let n = 1;
  let candidate;
  do {
    candidate = `${base} (${n})${ext}`;
    n += 1;
  } while (dirMap.has(candidate));
  return candidate;
}

// Decide what to do with a file whose target may already exist. Returns
// { proceed, name, resumeOffset? } — `name` may be a renamed copy, proceed:false
// means skip, resumeOffset means continue an interrupted transfer from that byte.
// `allowPrompt` is false for batch (folder) transfers so they don't prompt per
// file — they fall back to overwrite when the policy is "ask". `resumable` is
// false for paths that can't resume (OS drag-drop via put_bytes).
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
  let policy = direction === "download" ? settings.conflictDownload : settings.conflictUpload;
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
    if (choice.always) {
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
// { action, always } or null if cancelled.
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
      '<label class="field-toggle"><span>Always use this action</span><input type="checkbox" class="switch" id="cf-always" /></label>' +
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
        always: form.querySelector("#cf-always").checked,
      });
    });
    form.querySelector("[data-cancel]").addEventListener("click", () => done(null));
    backdrop.addEventListener("click", (e) => {
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
  conflictCache.clear();
  const r = await resolveConflict(
    direction,
    destSide,
    destDir,
    entry.name,
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
  // walk lists directories before their children, so parents come first.
  const mkdirCmd = destSide === "local" ? "local_mkdir" : "remote_mkdir";
  const destRoot = joinPath(destDir, entry.name);
  await safeMkdir(mkdirCmd, destDir, entry.name);
  for (const t of tree) {
    if (t.kind !== "dir") continue;
    await safeMkdir(mkdirCmd, joinPath(destRoot, relParent(t.rel)), relName(t.rel));
  }
  // Queue every file into its destination subdirectory, applying the file-exists
  // policy per file (folders don't prompt — they overwrite when policy is "ask").
  conflictCache.clear();
  let count = 0;
  let skipped = 0;
  for (const t of tree) {
    if (t.kind !== "file") continue;
    const fileDestDir = joinPath(destRoot, relParent(t.rel));
    const fileName = relName(t.rel);
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

// Path helpers for building destination paths. Joining with "/" is fine for
// remote (POSIX) and for local on Windows (the backend normalizes separators).
function joinPath(base, sub) {
  if (!sub) return base;
  return `${base.replace(/[/\\]+$/, "")}/${sub}`;
}
function relParent(rel) {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}
function relName(rel) {
  const i = rel.lastIndexOf("/");
  return i < 0 ? rel : rel.slice(i + 1);
}

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
    if (file.size > 100 * 1024 * 1024) {
      log(`${file.name} is too large to drag-import (100 MB limit for now).`, "error");
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
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      await invoke("put_bytes", { id: activeTabId ?? 0, side: destSide, dir: destDir, name: r.name, data: bytes });
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
  } else if (dragItem && dragItem.side !== destSide) {
    transferTo(dragItem, dragItem.side, destSide, destDir);
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
      if (it) log(`${it.direction === "download" ? "Downloading" : "Uploading"} ${it.name}…`);
      break;
    }
    case "progress":
      updateQueueProgress(u.id, u.transferred, u.size);
      break;
    case "retry":
      setQueueStat(u.id, `Retrying (${u.attempt}/${u.max})…`);
      break;
    case "done": {
      const it = queue.get(u.id);
      if (it) {
        it.fill.style.width = "100%";
        it.stat.textContent = "Done";
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

function addQueueRow(u) {
  const row = document.createElement("div");
  row.className = "q-row";
  row.dataset.status = "active";
  row.innerHTML =
    `<span class="q-dir">${u.direction === "download" ? "↓" : "↑"}</span>` +
    `<span class="q-name"></span>` +
    `<span class="q-size">${u.size ? formatSize(u.size) : ""}</span>` +
    `<div class="q-bar"><div class="q-fill"></div></div>` +
    `<span class="q-stat">Queued</span>` +
    `<span class="q-actions">` +
    `<button class="q-act q-cancel" title="Cancel transfer" aria-label="Cancel">✕</button>` +
    `<button class="q-act q-retry" title="Retry transfer" aria-label="Retry" hidden>↻</button>` +
    `</span>`;
  row.querySelector(".q-name").textContent = u.name;
  document.getElementById("queue-list").appendChild(row);
  const it = {
    row,
    direction: u.direction,
    name: u.name,
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
  it.stat.textContent =
    size > 0 ? `${pct}% · ${formatSize(transferred)}` : formatSize(transferred);
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

function showFileMenu(x, y, entry, side) {
  const items = [];
  if (entry.kind !== "dir") {
    items.push({
      label: side === "remote" ? "Download" : "Upload",
      action: () => transferEntry(entry, side),
    });
  }
  items.push({ label: "Rename…", action: () => renameEntry(entry, side) });
  items.push({ label: "Delete", danger: true, action: () => deleteEntry(entry, side) });
  items.push({ sep: true });
  items.push({ label: "New folder…", action: () => newFolder(side) });
  items.push({ label: "Refresh", action: () => refresh(side) });
  showMenu(x, y, items);
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

async function deleteEntry(entry, side) {
  const detail =
    entry.kind === "dir"
      ? "This deletes the folder and everything in it."
      : "This can't be undone.";
  if (!(await confirmDialog(`Delete "${entry.name}"?`, detail, "Delete"))) return;
  try {
    await invoke(side === "local" ? "local_remove" : "remote_remove", {
      id: activeTabId,
      path: entry.path,
      dir: entry.kind === "dir",
    });
    setStatus(`Deleted ${entry.name}`);
    refresh(side);
  } catch (e) {
    setStatus(`Delete failed: ${e}`, true);
  }
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
  return [...ev.dataTransfer.types].includes("Files") || (dragItem && dragItem.side !== targetSide);
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
  // What to do when a transfer's target file already exists. One of:
  // ask | overwrite | newer | size | rename | skip.
  conflictDownload: "ask",
  conflictUpload: "ask",
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
  el.setConflictDownload.value = settings.conflictDownload;
  el.setConflictUpload.value = settings.conflictUpload;
  el.settingsModal.hidden = false;
}

function closeSettings() {
  el.settingsModal.hidden = true;
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
  document.getElementById("site-delete").addEventListener("click", deleteSite);
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
  el.settingsModal.addEventListener("click", (e) => {
    if (e.target === el.settingsModal) closeSettings();
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
  el.setConflictDownload.addEventListener("change", () => {
    settings.conflictDownload = el.setConflictDownload.value;
    saveSettings();
  });
  el.setConflictUpload.addEventListener("change", () => {
    settings.conflictUpload = el.setConflictUpload.value;
    saveSettings();
  });
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

  // Right-click context menus on each pane (rows and empty area).
  for (const [body, side] of [
    [el.bodyLocal, "local"],
    [el.bodyRemote, "remote"],
  ]) {
    body.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const rowEl = ev.target.closest(".row");
      if (rowEl && rowEl._entry) {
        selectRow(body, rowEl);
        showFileMenu(ev.clientX, ev.clientY, rowEl._entry, side);
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
    const versionEl = document.getElementById("app-version");
    if (versionEl && v) versionEl.textContent = `v${v}`;
  } catch (_) {
    /* version label is best-effort */
  }
  if (tauriEvent) {
    await tauriEvent.listen("transfer://update", (e) => onTransferUpdate(e.payload));
  }
  try {
    await loadTreeRoots("local");
    const home = await invoke("local_home");
    await navigateLocal(home);
  } catch (e) {
    setStatus(`Could not open home directory: ${e}`, true);
  }
}

window.addEventListener("DOMContentLoaded", init);
