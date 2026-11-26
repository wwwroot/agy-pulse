---
name: agy-pulse
description: Reduce LLM token usage and task latency with native Rust batch file reads (outlines, targeted symbols, per-conversation subset deduplication), progressive regex/definition search, lockfile-free git inspection, atomic CAS mutations, native CSV/DOCX/PDF readers, structured shell execution, blocking job supervision, spillover paging, and the Pulse panel.
---

# Pulse Runbook

`agy-pulse` pairs a native Rust worker (`agy-pulse-worker`, built with `#![forbid(unsafe_code)]`) with a local Sidecar daemon, conversation-binding hooks (`hooks.json`), and 7 MCP tools so agents complete multi-file discovery, edits, git inspection, document parsing, and shell workflows in fewer turns and fewer tokens.

## Opening Pulse

When the user wants to inspect Context Window usage, Antigravity quotas, token savings, host MCP health, switch sessions, review activity, supervise background jobs, browse spilled handles, or change settings, surface the clickable sidecar link:

`[Pulse](sidecar://agy-pulse/pulse/)`

The panel has three views synced with the MCP server:

- **Usage**: Live session Context Window telemetry (fill orb and turn timeline), Antigravity quota pools (dual-path `agy -p /usage` CLI + local `language_server` fallback with projected-unused waste forecast), host MCP health banner with one-click repair, session scope toggle (`This chat | All`), KPIs (tokens saved, bytes trimmed, round-trips saved, dedup hits, avg latency), 10-category breakdown, active spillover cache viewer, and quick session actions.
- **Activity**: Stream of `pulse_*` calls and background/promoted jobs with tool-kind filters, per-call savings chips, expandable outputs, inline spillover paging, stdin input, and job termination.
- **Settings**: Runtime configuration for deduplication, session retention (`sessionRetentionDays`, `sessionMaxCount`), shell routing, timeouts, inline byte cap (7,800 B default), auto-promotion, JSON Digest, Credential Fence, Download Guard, and worker/shell diagnostics.

## MCP Tools

| Tool | Mechanism |
| :--- | :--- |
| `pulse_read_files` | Parallel Rust batch read of 1-32 files with `view: "outline"` (20 languages/formats incl. MD/JSON/YAML/CSS/Vue/Svelte), `symbol: "<name>"`, line ranges, `stat_only`, `view: "hex"` (0-based byte offset), per-conversation interval deduplication, and shared `baseDir` factoring. |
| `pulse_search` | Native Rust `.gitignore`-aware `glob`, `fuzzy` file lookup, 5-mode progressive `grep` (`summary`, `count`, `files_with_matches`, `definitions`, `content`), and lockfile-free `git_status` / `git_diff` with bounded hunks. |
| `pulse_mutate` | Atomic CAS `edit` (with closest-region recovery hints) / `write` (checked against SHA-256 `expected_revision` or `"absent"`), unified `diff` (`content` or `edits`), multi-file `replace`, and multi-op `batch` (`copy`/`move`/`remove`) with `dry_run`, automatic diff spillover, and read-dedup invalidation. |
| `pulse_read_doc` | Native Rust parser for CSV/TSV tables, DOCX paragraphs, and PDF text layers with unit pagination. |
| `pulse_exec` | Structured shell execution (`command` XOR `script_path`) with multi-shell routing, non-interactive env hygiene, ANSI/spinner normalization, green-phase log folding, failure head-tail error-cluster packing, JSON Digest, spillover caching, background mode, and auto-promotion on timeout. |
| `pulse_job` | Supervise background and timeout-promoted jobs (`list`, blocking `output` with `wait: true` and auto-advancing byte cursor, `input`, and process-tree `kill`). |
| `pulse_result` | Page, search, or release `ref://spill/...` handles (`action: "page"` / `"release"`), or inspect per-conversation savings, Context Window usage, Antigravity quotas, host MCP health, daemon version-skew warnings, worker health, and host shells (`action: "stats"`). |

## Workflows

### 1. Outline -> Symbol / Batch Read (`pulse_read_files`)

1. Survey candidate files in one call with `view: "outline"`:
   `pulse_read_files({ files: [{ path: "src/server/ops-engine.ts", view: "outline" }, { path: "src/shared/types.ts", view: "outline" }] })`
2. Extract only the target declaration with `symbol`:
   `pulse_read_files({ files: [{ path: "src/server/ops-engine.ts", symbol: "readFiles" }] })`
3. Or pack 2-6 line ranges into one parallel call. Unchanged ranges and subsets return a 1-line dedup marker; pass `force: true` only when raw lines must be re-emitted.

### 2. Progressive Search & Compact Git (`pulse_search`)

- Locate definitions or files before reading content:
  - `pulse_search({ action: "grep", pattern: "TokenSavingsSummary", output_mode: "definitions" })`
  - `pulse_search({ action: "grep", pattern: "SpillStore", output_mode: "files_with_matches", glob: ["src/**/*.ts"] })`
  - `pulse_search({ action: "glob", pattern: ["src/**/*.ts", "!**/dist/**"], sort: "modified", limit: 30 })`
- Inspect git without lockfile noise (`include_lockfiles: true` to opt in):
  - `pulse_search({ action: "git_status" })`
  - `pulse_search({ action: "git_diff", staged: false, max_hunk_lines: 60 })`

### 3. Atomic Edits & Refactors (`pulse_mutate`)

- Pass `expected_revision` (64-hex SHA-256 from `pulse_read_files`, or `"absent"` for new files) so stale writes reject with `effectState: "none"`.
- Preview multi-file `replace` or `batch` operations with `dry_run: true`, then apply in one call.

### 4. Structured Documents (`pulse_read_doc`)

- `pulse_read_doc({ path: "data/metrics.csv", format: "auto", header: true, offset: 1, limit: 50 })`
- `pulse_read_doc({ path: "docs/spec.docx", format: "docx", offset: 1, limit: 40 })`
- `pulse_read_doc({ path: "docs/report.pdf", format: "pdf", offset: 1, limit: 5 })`

### 5. Shell Execution & Blocking Jobs (`pulse_exec` + `pulse_job`)

- Provide a short `description` and exactly one of `command` or `script_path`.
- Write complex or non-ASCII scripts to a workspace file and pass `script_path`.
- Block on background or promoted jobs without sleep-polling:
  `pulse_job({ action: "output", job_id: "<id>", wait: true, wait_timeout_ms: 15000 })`
  Omitting `stdout_offset`/`stderr_offset` resumes from the job's last read cursor automatically.

### 6. Spillover Paging & Session Stats (`pulse_result`)

Outputs above `maxInlineBytes` (7,800 B default) store to disk with `[Stored reference: refId=...]` (and `[JSON Digest]` for large JSON):

- `pulse_result({ action: "page", ref_id: "ref://spill/...", offset: 1, limit: 120, stream: "combined" })`
- `pulse_result({ action: "page", ref_id: "ref://spill/...", search: "FAIL|ERROR", case_insensitive: true })`
- `pulse_result({ action: "release", ref_id: "ref://spill/..." })`
- `pulse_result({ action: "stats" })`

### 7. CLI Diagnostics (`--cli quotas` & `--cli doctor`)

From a terminal or swarm worker without MCP access:

- `node sidecars/pulse/dist/mcp-server.mjs --cli quotas [--refresh] [--json]`: inspect Antigravity quota pools and projected-unused windows.
- `node sidecars/pulse/dist/mcp-server.mjs --cli doctor [--repair] [--json]`: in-process Antigravity host MCP configuration check (with optional atomic repair).

## Safety Guards

- **Workspace Jail**: Enforced in Node.js and Rust (`agy-pulse-worker`). Rejects path escapes, drive-less POSIX absolutes on Windows, and cross-drive relative paths with `effectState: "none"`.
- **Credential Fence**: Enabled by default. Blocks `.ssh`, `.aws`, `.azure`, `.config/gcloud`, `.kube`, `.docker/config.json`, `.netrc`, `.git-credentials`, `.npmrc`, `.pypirc`, private keys, and `.env` secrets (allows `.env.example`, `.sample`, `.template`, `.dist`, `.schema`).
- **Download Guard**: Opt-in in Settings. Blocks disk-writing CLI downloads and returns your configured replacement command template.
