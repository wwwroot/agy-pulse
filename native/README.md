# `agy-pulse-worker`

Native Rust (edition 2024, `#![forbid(unsafe_code)]`) worker binary for `agy-pulse`. Executes file reads, workspace search, atomic compare-and-swap mutations, and structured document extraction over stdin/stdout JSON (one-shot or `--daemon` NDJSON mode).

## Architecture

The worker reads UTF-8 `WorkerRequest` objects (up to 8 MiB) from `stdin` and writes `WorkerResponse` JSON lines to `stdout`. Both `src/main.rs` (`#![forbid(unsafe_code)]`) and `Cargo.toml` (`[lints.rust] unsafe_code = "forbid"`) prohibit `unsafe` code.

Every requested path is canonicalized (falling back to the nearest existing ancestor when creating new files), stripped of Windows verbatim prefixes (`\\?\`), and checked against `roots`; paths outside `roots` fail with `WORKDIR_OUTSIDE_WORKSPACE` (`effectState: "none"`). When `credentialFence` is `true`, access is blocked to `.ssh`, `.aws`, `.azure`, `.config/gcloud`, `.kube`, `.docker/config.json`, `.netrc`, `.git-credentials`, `.npmrc`, `.pypirc`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, `*credentials*.{json,yaml,yml,ini}`, `service-account*.json`, `.env`, and `.env.*` except `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, and `.env.schema`.

## Wire protocol

Request (`stdin`):

```json
{
  "op": "read_files | stat | glob | fuzzy | grep | diff | write | edit | replace | batch | read_doc",
  "roots": ["E:\\workspace"],
  "credentialFence": true,
  "maxInlineBytes": 65536,
  "args": {}
}
```

Response (`stdout`):

Success returns `{"ok": true, "result": { ... }}`. Failure returns:

```json
{
  "ok": false,
  "error": {
    "code": "REVISION_MISMATCH",
    "message": "...",
    "effectState": "none",
    "retry": "after-input-change",
    "nextAction": "..."
  }
}
```

## Supported operations

| Operation | Description |
| --- | --- |
| `read_files` | Parallel (`rayon`) batch reader for 1 to 32 file ranges supporting `text` (strict UTF-8 + reversible escaping), 16-byte `hex` dump, `outline` (compact multi-language structural skeleton with grouped imports and exact line ranges), targeted `symbol` extraction (exact qualified `Container::Name` / `Container.Name`, exact bare name, or case-insensitive fallback including contiguous doc comments/attributes, returning `SYMBOL_NOT_FOUND` with up to 20 available symbols on miss), or `statOnly`. Returns SHA-256 `revision`, `bytes`, `lineCount`, `mtimeMs`, plus `fullFileBytes` (and `symbol`) for `outline`/`symbol` views. |
| `stat` | File/directory metadata plus SHA-256 `revision` (`"absent"` if missing, `"directory"` if directory). |
| `glob` | Bounded no-follow directory walk (max 25,000 entries, depth 64) with positive and `!exclude` glob matching, `path`/`modified` sorting, and paging. |
| `fuzzy` | Ranked subsequence path matcher over workspace candidate files with paging. |
| `grep` | Parallel deterministic regex search with 5 output modes (`summary`, `count`, `files_with_matches`, `definitions` with `definitionMatches` and `impliedReferences`, and `content` with optional `beforeContext`/`afterContext`), plus `rawBytes` estimate. |
| `diff` | Unified diff (`similar`) comparing current file content against proposed content, returning `beforeRevision`, `afterRevision`, `addedLines`, and `removedLines`. |
| `write` | Compare-and-swap atomic write verifying `expectedRevision` (`"absent"` or 64-hex SHA-256) via sibling temp file and rename, with `dryRun` support. |
| `edit` | Compare-and-swap atomic multi-edit (1 to 100 non-overlapping unique edits) with reversible escape fallback and CRLF adaptation, plus `dryRun` support. |
| `replace` | Multi-file literal or regex search-and-replace capped at `maxReplacements` (default 500), skipping binary files, with atomic per-file writes and `dryRun`. |
| `batch` | Preflight-validated batch `copy` / `move` / `remove` (1 to 512 ops) enforcing no-clobber, cycle detection, and zero overlapping targets before executing any filesystem change. |
| `read_doc` | Native paged reader for CSV/TSV (`table` with UTF-8, UTF-16LE, or UTF-16BE decoding), Word `.docx` (`zip` + `quick-xml`, blocking macro-enabled `word/vbaProject.bin`), and PDF (`lopdf` text extraction). |

## Building

```powershell
cargo build --release --manifest-path native/Cargo.toml --target-dir "$env:TEMP\agy-pulse-cargo-target"
```

On POSIX hosts:

```bash
cargo build --release --manifest-path native/Cargo.toml
```
