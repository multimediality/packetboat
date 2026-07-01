// Single source of truth for Packetboat's version. Reports or sets the version
// across every file that carries it, so a release bump is one command instead of
// hand-editing (and drifting) three files.
//
//   node scripts/version.mjs            # check: print every file's version + verify they match
//   node scripts/version.mjs 0.5.0      # set an explicit version everywhere
//   node scripts/version.mjs patch      # bump patch / minor / major from the current version
//
// Files kept in sync: package.json, src-tauri/tauri.conf.json,
// src-tauri/Cargo.toml, and the packetboat entry in src-tauri/Cargo.lock (so a
// bump commit is complete without needing a rebuild). Edits are targeted
// replacements, so the diff is only the version line in each file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// name → [absolute path, regex whose group 2 is the version]
const JSON_VERSION_RE = /("version"\s*:\s*")([^"]+)(")/;
const CARGO_TOML_RE = /(\[package\][\s\S]*?\nversion\s*=\s*")([^"]+)(")/;
const CARGO_LOCK_RE = /(name = "packetboat"\nversion = ")([^"]+)(")/;
const FILES = {
  "package.json": [path.join(root, "package.json"), JSON_VERSION_RE],
  "tauri.conf.json": [path.join(root, "src-tauri", "tauri.conf.json"), JSON_VERSION_RE],
  "Cargo.toml": [path.join(root, "src-tauri", "Cargo.toml"), CARGO_TOML_RE],
  "Cargo.lock": [path.join(root, "src-tauri", "Cargo.lock"), CARGO_LOCK_RE],
};

const SEMVER = /^\d+\.\d+\.\d+$/;
const read = (p) => fs.readFileSync(p, "utf8");

function currentVersions() {
  const out = {};
  for (const [name, [p, re]] of Object.entries(FILES)) {
    out[name] = read(p).match(re)?.[2] ?? null;
  }
  return out;
}

function bump(version, kind) {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
    throw new Error(`current version "${version}" isn't X.Y.Z — pass an explicit version instead`);
  }
  const [maj, min, pat] = parts;
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`; // patch
}

function setVersion(version) {
  for (const [name, [p, re]] of Object.entries(FILES)) {
    const text = read(p);
    if (!re.test(text)) {
      // Cargo.lock is regenerated on the next build, so a miss there is a warning.
      if (name === "Cargo.lock") {
        console.warn(`warning: no packetboat entry in Cargo.lock (it'll update on the next build)`);
        continue;
      }
      throw new Error(`couldn't find the version field in ${name}`);
    }
    fs.writeFileSync(p, text.replace(re, `$1${version}$3`));
  }
}

function main() {
  const arg = process.argv[2];
  const cur = currentVersions();
  const distinct = new Set(Object.values(cur).filter(Boolean));

  if (!arg) {
    for (const [name, v] of Object.entries(cur)) {
      console.log(`  ${name.padEnd(16)} ${v ?? "(not found)"}`);
    }
    if (distinct.size === 1 && !Object.values(cur).includes(null)) {
      console.log(`\nAll in sync at ${[...distinct][0]}.`);
    } else {
      console.error(`\nVERSIONS OUT OF SYNC — run \`node scripts/version.mjs <X.Y.Z>\` to fix.`);
      process.exit(1);
    }
    return;
  }

  let target;
  if (SEMVER.test(arg)) {
    target = arg;
  } else if (["patch", "minor", "major"].includes(arg)) {
    if (distinct.size !== 1) {
      console.error("Versions are out of sync; pass an explicit X.Y.Z rather than a bump keyword.");
      process.exit(1);
    }
    target = bump([...distinct][0], arg);
  } else {
    console.error("Usage: node scripts/version.mjs [<X.Y.Z> | patch | minor | major]");
    process.exit(1);
  }

  setVersion(target);
  console.log(`Version set to ${target} (package.json, tauri.conf.json, Cargo.toml, Cargo.lock).`);
  console.log(`Next: commit, then tag the release — git tag v${target}`);
}

main();
