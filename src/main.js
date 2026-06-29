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
  el.siteFtpFields = document.getElementById("site-ftp-fields");
  el.cloudFields = document.getElementById("cloud-fields");
  el.cloudHint = document.getElementById("cloud-hint");
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
  // subfolders show (like FileZilla, the tree follows the list).
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

function addTab(id, label) {
  tabs.push({ id, label, remote: { path: null, connected: true }, tree: freshTree() });
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
async function doConnectWith({ protocol, host, port, username, password, label, service, config }) {
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
  log(`Connecting to ${target}…`);
  try {
    let result;
    if (cloud) {
      result = await invoke("connect_opendal", { service, config });
    } else if (protocol === "sftp") {
      result = await invoke("connect_sftp", { config: { host, port, username, password } });
    } else {
      result = await invoke("connect_ftp", {
        config: { host, port, username, password, secure: protocol === "ftps" },
      });
    }
    addTab(result.id, label || (cloud ? target : `${username || "anonymous"}@${host}`));
    log(`Connected to ${target}`, "success");
    await loadTreeRoots("remote");
    await navigateRemote(result.home);
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

function defaultPort(protocol) {
  return protocol === "sftp" ? 22 : 21;
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
  gdrive: {
    label: "Google Drive",
    note: "Paste a short-lived access token, or a refresh token plus client ID/secret for persistent access.",
    fields: [
      { key: "access_token", label: "Access token", secret: true },
      { key: "refresh_token", label: "Refresh token", secret: true },
      { key: "client_id", label: "Client ID" },
      { key: "client_secret", label: "Client secret", secret: true },
      { key: "root", label: "Root folder", placeholder: "/" },
    ],
  },
  dropbox: {
    label: "Dropbox",
    note: "Paste a short-lived access token, or a refresh token plus app key/secret for persistent access.",
    fields: [
      { key: "access_token", label: "Access token", secret: true },
      { key: "refresh_token", label: "Refresh token", secret: true },
      { key: "client_id", label: "App key (client ID)" },
      { key: "client_secret", label: "App secret", secret: true },
      { key: "root", label: "Root folder", placeholder: "/" },
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
async function connectCloud(service, config, label, siteId) {
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
  return await doConnectWith({ service, config, label });
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
  el.siteProtocol.value = site ? site.protocol : "sftp";
  el.siteHost.value = site ? site.host || "" : "";
  el.sitePort.value = site ? site.port || defaultPort(site.protocol) : 22;
  el.siteUser.value = site ? site.username || "" : "";
  el.sitePass.value = "";
  el.siteLogon.value = site ? site.logon_type || "ask" : "normal";
  // Cloud sites pre-fill the per-service inputs from saved config; secret keys
  // are loaded from the keychain in selectSite().
  updateProtocolFields(site && site.config ? { ...site.config } : {});
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

function readSiteForm() {
  const protocol = el.siteProtocol.value;
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
    };
  }
  return {
    name: el.siteName.value.trim() || el.siteHost.value.trim(),
    protocol,
    host: el.siteHost.value.trim(),
    port: parseInt(el.sitePort.value, 10) || defaultPort(protocol),
    username: el.siteUser.value.trim(),
    logon_type: el.siteLogon.value,
    config: {},
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
async function connectUsing({ name, protocol, host, port, username, logonType, password, siteId }) {
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
    port: port || defaultPort(protocol),
    username: user,
    password: pw,
    label: name && name !== host ? `${name} — ${who}` : who,
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
  if (isCloud(el.siteProtocol.value)) {
    const service = el.siteProtocol.value;
    const { config, secrets } = readCloudFields();
    const label = el.siteName.value.trim() || CLOUD_SERVICES[service].label;
    closeSites();
    await connectCloud(service, { ...config, ...secrets }, label, site.id);
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
    siteId: site.id,
  });
}

// Connect directly to a saved site (from the quick-connect dropdown), pulling
// the password from the keychain when saved.
async function connectFromMenu(site) {
  if (isCloud(site.protocol)) {
    const label = site.name || CLOUD_SERVICES[site.protocol].label;
    await connectCloud(site.protocol, { ...(site.config || {}) }, label, site.id);
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
    siteId: site.id,
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

// Files transfer to the *other* pane's current directory: a local file goes
// up to the remote, a remote file comes down to the local pane.
async function transferEntry(entry, side) {
  const dest = side === "local" ? "remote" : "local";
  await transferTo(entry, side, dest, dest === "remote" ? state.remote.path : state.local.path);
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
  await enqueue(direction, entry.path, destDir, entry.name, entry.size);
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
  // Queue every file into its destination subdirectory.
  let count = 0;
  for (const t of tree) {
    if (t.kind !== "file") continue;
    await enqueue(direction, t.path, joinPath(destRoot, relParent(t.rel)), relName(t.rel), t.size);
    count++;
  }
  if (count === 0) log(`${entry.name} has no files to transfer.`);
  else log(`Queued ${count} file${count === 1 ? "" : "s"} from ${entry.name}.`, "success");
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
  for (const file of files) {
    if (file.size > 100 * 1024 * 1024) {
      log(`${file.name} is too large to drag-import (100 MB limit for now).`, "error");
      continue;
    }
    try {
      log(`${destSide === "remote" ? "Uploading" : "Importing"} ${file.name}…`);
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      await invoke("put_bytes", { id: activeTabId ?? 0, side: destSide, dir: destDir, name: file.name, data: bytes });
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

async function enqueue(direction, src, dstDir, name, size) {
  try {
    await invoke("enqueue_transfer", {
      request: { direction, connection_id: activeTabId, src, dst_dir: dstDir, name, size },
    });
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
    case "done": {
      finishQueueRow(u.id);
      const it = queue.get(u.id);
      if (it) {
        log(`Transfer complete: ${it.name}`, "success");
        // Show the result in the destination pane (debounced so a folder of
        // many files refreshes once, not per file).
        scheduleRefresh(it.direction === "download" ? "local" : "remote");
      }
      break;
    }
    case "error":
      errorQueueRow(u.id, u.message);
      log(`Transfer failed: ${u.message}`, "error");
      break;
  }
}

// Coalesce post-transfer pane refreshes so a folder of many files re-lists once.
const refreshTimers = {};
function scheduleRefresh(side) {
  clearTimeout(refreshTimers[side]);
  refreshTimers[side] = setTimeout(() => refresh(side), 400);
}

function addQueueRow(u) {
  document.getElementById("queue").hidden = false;
  const row = document.createElement("div");
  row.className = "q-row";
  row.innerHTML =
    `<span class="q-dir">${u.direction === "download" ? "↓" : "↑"}</span>` +
    `<span class="q-name">${escapeHtml(u.name)}</span>` +
    `<div class="q-bar"><div class="q-fill"></div></div>` +
    `<span class="q-stat">Queued</span>`;
  document.getElementById("queue-list").appendChild(row);
  queue.set(u.id, {
    row,
    direction: u.direction,
    name: u.name,
    fill: row.querySelector(".q-fill"),
    stat: row.querySelector(".q-stat"),
  });
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

function finishQueueRow(id) {
  const it = queue.get(id);
  if (!it) return;
  it.fill.style.width = "100%";
  it.row.classList.add("done");
  it.stat.textContent = "Done";
  // Show the freshly transferred file in the destination pane.
  if (it.direction === "download") refresh("local");
  else refresh("remote");
}

function errorQueueRow(id, message) {
  const it = queue.get(id);
  if (!it) return;
  it.row.classList.add("error");
  it.stat.textContent = "Failed";
  it.row.title = message;
}

function clearFinished() {
  for (const [id, it] of queue) {
    if (it.row.classList.contains("done") || it.row.classList.contains("error")) {
      it.row.remove();
      queue.delete(id);
    }
  }
  if (queue.size === 0) document.getElementById("queue").hidden = true;
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
const settings = { theme: "dark", onConnect: "ask" };

function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"));
  } catch (_) {
    /* ignore */
  }
  applyTheme(settings.theme);
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
  el.settingsModal.hidden = false;
}

function closeSettings() {
  el.settingsModal.hidden = true;
}

// FileZilla-style prompt shown when connecting while already connected.
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
      '<label class="check"><input type="checkbox" id="cb-always" /> Always do this</label>' +
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
  el.sitesModal.addEventListener("mousedown", (e) => {
    if (e.target === el.sitesModal) closeSites();
  });
  el.siteProtocol.addEventListener("change", () => {
    const p = el.sitePort.value;
    if (!p || p === "22" || p === "21") el.sitePort.value = defaultPort(el.siteProtocol.value);
    updateProtocolFields();
  });
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
  document.getElementById("log-clear").addEventListener("click", () => {
    el.logList.innerHTML = "";
  });

  document.getElementById("tool-refresh").addEventListener("click", () => {
    refresh("local");
    refresh("remote");
  });
  const logBtn = document.getElementById("tool-log");
  logBtn.classList.add("active"); // log panel is shown by default
  logBtn.addEventListener("click", () => {
    el.logpanel.hidden = !el.logpanel.hidden;
    logBtn.classList.toggle("active", !el.logpanel.hidden);
  });
  const queueBtn = document.getElementById("tool-queue");
  queueBtn.addEventListener("click", () => {
    const q = document.getElementById("queue");
    q.hidden = !q.hidden;
    queueBtn.classList.toggle("active", !q.hidden);
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
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (settings.theme === "system") applyTheme("system");
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
