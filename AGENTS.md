# AGENTS.md

Guidance for AI agents working in the Packetboat repository. Build commands, architecture, and conventions live in [CLAUDE.md](CLAUDE.md) — read that first; this file defines how the agent team is organized.

## Team structure

**The Fable-class model is the lead agent** for this repository (Fable 5.1 as of this writing — the name here is intentionally version-free). The lead owns:

- **Planning** — breaking a request into a concrete implementation plan before code changes, especially anything touching the `StorageBackend` trait, the transfer engine, connect/trust flows, or release tooling.
- **Architecture decisions** — whether new logic belongs in a backend, the command layer (`lib.rs`), the transfer queue, or the frontend; keeping the backend abstraction symmetric and secrets in the keychain.
- **Execution and integration** — the lead implements the critical-path and cross-cutting work itself, and reviews and integrates everything the subagents return.
- **Final review** — verifying tests pass (`npm test` + `npm run test:rust`), the version files stay in sync, and the diff matches the plan before anything is committed.

**Claude Sonnet 5 subagents** (spawned via the Agent tool with `model: "sonnet"`) handle scoped, parallelizable work delegated by the lead:

- Fan-out exploration and research across the codebase (use the read-only `Explore` type for search-only tasks).
- Well-bounded implementation tasks with a clear spec from the lead — e.g. a new dialog in `main.js`, a pure helper + tests in `util.js`, a config option threaded through `Site`.
- Mechanical or repetitive changes (renames, test additions, doc updates) where the plan fully determines the outcome.

### Delegation rules

1. The lead writes the plan; subagents never make architectural decisions. If a subagent hits an ambiguity, it reports back instead of guessing.
2. Every delegated task gets a self-contained prompt: relevant file paths, the convention to follow (see CLAUDE.md), and the definition of done — subagents start cold.
3. Subagent output is not trusted blind: the lead reads the diff, runs the tests, and owns the result.
4. Don't parallelize edits to the same file (`main.js` and `lib.rs` are large single files — split by file, not by feature, when fanning out).

### Subagent mechanics (current harness)

- Subagents run **in the background by default**; the lead keeps working and is notified on completion. Use `run_in_background: false` only when the very next step depends on the result.
- To continue a finished subagent with its context intact, **SendMessage** it by name — don't respawn and re-explain.
- `isolation: "worktree"` gives a subagent its own git worktree; use it when fanning out implementation that could collide (a worktree also keeps `cargo`/`npm` builds from stepping on each other).
- The multi-agent **Workflow** tool runs only when the user explicitly opts in ("use a workflow" / "ultracode"); otherwise stay with individual Agent calls.
- Subagents start cold and cannot see the lead's memory or conversation — everything they need goes in the prompt.

## Hard rules for all agents

- Never hand-edit version numbers — use `npm run bump` (`scripts/version.mjs` syncs all four files).
- Secrets never go in `sites.json`, code, or logs — passwords and cloud keys live in the OS keychain; 1Password sites store only the `op://` reference.
- New remote-facing file-name handling must go through `safe_component()` (path-traversal guard) on the Rust side.
- Pure JS logic goes in `src/util.js` with tests in `src/util.test.js`; Rust tests are `#[cfg(test)]` modules at the bottom of the file they cover.
- Don't search or read inside `src-tauri/target/` or `node_modules/`.
