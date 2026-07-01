// Unit tests for the pure helpers in util.js. Run with `npm test`
// (Node's built-in test runner — no dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";

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

test("joinPath collapses a trailing separator on the base", () => {
  assert.equal(joinPath("/pub", "a.txt"), "/pub/a.txt");
  assert.equal(joinPath("/pub/", "a.txt"), "/pub/a.txt");
  assert.equal(joinPath("C:\\dir\\", "a.txt"), "C:\\dir/a.txt");
  assert.equal(joinPath("/pub", ""), "/pub"); // no child → base unchanged
});

test("relParent / relName split a /-relative path", () => {
  assert.equal(relParent("a/b/c.txt"), "a/b");
  assert.equal(relName("a/b/c.txt"), "c.txt");
  assert.equal(relParent("file.txt"), ""); // bare name
  assert.equal(relName("file.txt"), "file.txt");
});

test("dedupeName finds the first free 'name (n).ext'", () => {
  const dir = new Map([
    ["a.txt", 1],
    ["a (1).txt", 1],
    ["a (2).txt", 1],
  ]);
  assert.equal(dedupeName("a.txt", dir), "a (3).txt");
  // A name with no extension keeps the suffix at the end.
  assert.equal(dedupeName("folder", new Map()), "folder (1)");
  // Dotfiles (leading dot only) are treated as having no extension.
  assert.equal(dedupeName(".gitignore", new Map()), ".gitignore (1)");
});

test("parseFileZillaRemoteDir decodes length-prefixed segments", () => {
  assert.equal(
    parseFileZillaRemoteDir("1 0 11 public_html 14 learningcarton"),
    "/public_html/learningcarton",
  );
  // Segments may contain spaces (that's why lengths are prefixed).
  assert.equal(parseFileZillaRemoteDir("1 0 8 my stuff"), "/my stuff");
  assert.equal(parseFileZillaRemoteDir(""), "");
  assert.equal(parseFileZillaRemoteDir("1 0"), ""); // no segments
});

test("pathSep detects Windows vs POSIX", () => {
  assert.equal(pathSep("C:\\Users\\Steven"), "\\");
  assert.equal(pathSep("/home/steven"), "/");
});

test("relativeUnder returns the sub-path or null", () => {
  assert.equal(relativeUnder("/root/a/b", "/root"), "a/b");
  assert.equal(relativeUnder("/root", "/root"), ""); // same dir
  assert.equal(relativeUnder("/other/a", "/root"), null); // not under root
  // Mixed separators normalize to "/".
  assert.equal(relativeUnder("C:\\root\\a", "C:/root"), "a");
  // A prefix that isn't a path boundary is not "under".
  assert.equal(relativeUnder("/rootx/a", "/root"), null);
});

test("joinUnder re-roots using the root's own separator", () => {
  assert.equal(joinUnder("/local/root", "a/b"), "/local/root/a/b");
  assert.equal(joinUnder("C:\\root", "a/b"), "C:\\root\\a\\b");
  assert.equal(joinUnder("/root", ""), "/root"); // empty rel → root
});

test("normalizeOpRef strips 1Password's surrounding quotes/whitespace", () => {
  assert.equal(
    normalizeOpRef('"op://Private/Item/password"'),
    "op://Private/Item/password",
  );
  assert.equal(normalizeOpRef("'op://V/I/f'"), "op://V/I/f");
  assert.equal(normalizeOpRef("  op://V/I/f  "), "op://V/I/f");
  // Internal spaces (vault/item/section names) are preserved.
  assert.equal(
    normalizeOpRef('"op://Dev/Shock Hosting/cPanel User/password"'),
    "op://Dev/Shock Hosting/cPanel User/password",
  );
});
