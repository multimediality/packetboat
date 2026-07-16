// Pure, dependency-free helpers shared by the app and its tests. Anything here
// must stay free of DOM, Tauri, and module state so it can be unit-tested under
// Node (see util.test.js).

// Join a directory path and a child name, collapsing a trailing separator on the
// base (works for both POSIX "/" and Windows "\").
export function joinPath(base, sub) {
  if (!sub) return base;
  return `${base.replace(/[/\\]+$/, "")}/${sub}`;
}

// The parent portion of a "/"-relative path ("" if it's a bare name).
export function relParent(rel) {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

// The final component of a "/"-relative path.
export function relName(rel) {
  const i = rel.lastIndexOf("/");
  return i < 0 ? rel : rel.slice(i + 1);
}

// Pick a non-colliding "name (n).ext" for `name` within a directory (a Map keyed
// by existing entry names).
export function dedupeName(name, dirMap) {
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

// Parse FileZilla's serialized RemoteDir. It's a space-separated, length-prefixed
// format: "<serverType> <prefixLen> [<segLen> <segment>]…" — length prefixes let
// segments contain spaces. e.g. "1 0 11 public_html 14 learningcarton" →
// "/public_html/learningcarton". Returns "" when empty/unparseable.
export function parseFileZillaRemoteDir(raw) {
  const s = (raw || "").trim();
  if (!s) return "";
  let i = 0;
  const nextToken = () => {
    let j = s.indexOf(" ", i);
    if (j === -1) j = s.length;
    const tok = s.slice(i, j);
    i = j + 1;
    return tok;
  };
  nextToken(); // server type (1 = Unix) — ignored
  const prefixLen = parseInt(nextToken(), 10) || 0;
  if (prefixLen > 0) i += prefixLen + 1; // skip a server prefix (VMS/MVS), if any
  const segments = [];
  while (i < s.length) {
    const len = parseInt(nextToken(), 10);
    if (isNaN(len)) break;
    segments.push(s.slice(i, i + len));
    i += len + 1;
  }
  return segments.length ? "/" + segments.join("/") : "";
}

// The path separator a path uses (Windows "\" if it contains one, else "/").
export function pathSep(p) {
  return p.includes("\\") ? "\\" : "/";
}

// `path` relative to `root` (compared with forward slashes), or null if `path`
// isn't under `root`.
export function relativeUnder(path, root) {
  const np = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const nr = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (np === nr) return "";
  return np.startsWith(nr + "/") ? np.slice(nr.length + 1) : null;
}

// Re-root a "/"-relative path under `root`, using `root`'s own separator.
export function joinUnder(root, rel) {
  if (!rel) return root;
  const sep = pathSep(root);
  return root.replace(/[/\\]+$/, "") + sep + rel.split("/").join(sep);
}

// 1Password's "Copy Secret Reference" wraps the value in quotes; strip any
// surrounding quotes/whitespace so a pasted reference is usable as-is.
export function normalizeOpRef(v) {
  return v.replace(/^[\s"']+|[\s"']+$/g, "");
}

// Comparator for file-list entries, sorting by `key` ("name" | "size" |
// "modified") in direction `dir` (1 ascending, -1 descending). Directories
// always group before files, whatever the key or direction — only the order
// *within* each group flips. Name (case-insensitive) breaks ties, so entries
// with equal sizes/dates stay in a predictable order; directories have no
// size, so under the "size" key they fall through to the name tiebreak.
// A missing modified time sorts as oldest.
export function entryComparator(key, dir = 1) {
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  return (a, b) => {
    const ad = a.kind === "dir";
    if (ad !== (b.kind === "dir")) return ad ? -1 : 1;
    let cmp = 0;
    if (key === "size" && !ad) cmp = a.size - b.size;
    else if (key === "modified") cmp = (a.modified || 0) - (b.modified || 0);
    if (cmp === 0) cmp = byName(a, b);
    return dir * (cmp < 0 ? -1 : cmp > 0 ? 1 : 0);
  };
}
