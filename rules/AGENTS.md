# Pulse Rules

**ALWAYS** use `agy-pulse_pulse` MCP tools (`pulse_read_files`, `pulse_search`, `pulse_mutate`, `pulse_read_doc`, `pulse_exec`, `pulse_job`, `pulse_result`) for all workspace reads, search/git, file edits/writes, document reading, and shell execution.

**NEVER** call built-in `run_command`, `read_file`, `edit_file`, or `write_file` when an `agy-pulse` tool applies. The **ONLY** valid exceptions for built-in tools are:
- **`read_file`**: ONLY for files **outside** workspace roots (e.g. `~/.gemini/...` skills/artifacts) or binary media requiring visual/audio inspection (images, video, audio, scanned PDFs).
- **`write_file` / `edit_file`**: ONLY for files **outside** workspace roots (e.g. Antigravity artifacts with `ArtifactMetadata`) or `Append: true` writes.
- **`run_command`**: ONLY when `IsDaemon: true` is needed for a persistent dev server/watcher, when `Cwd` must be outside workspace roots, or when invoking host-authenticated commands (`AGY_ACCOUNT=...`, `ANTIGRAVITY_CSRF_TOKEN`, `ANTIGRAVITY_LS_ADDRESS`). **Never** use `run_command` for one-liners, `curl`, PowerShell, `git`, builds, tests, or scripts; use `pulse_exec` (`curl` to stdout is allowed; Download Guard only checks disk-writing flags when enabled).

**Direct invocation (0 extra schema-read turns):**
- All 7 tools default to eviction-safe lazy mode (`eager: false`) so Antigravity never evicts or disables them under multi-plugin context budgets.
- Call `call_mcp_tool` directly with `ServerName: "agy-pulse_pulse"` and `ToolName: "pulse_..."` using the Quick Schemas below. Do **not** spend a turn reading `mcp/agy-pulse_pulse/*.json` first. (If eagerly loaded as `mcp_agy-pulse_pulse_*`, call directly.)

| Task | Tool & Best Pattern |
|---|---|
| Map unfamiliar files | `pulse_read_files` with `view: "outline"` across 2-8 files (TS/JS, Rust, Python, Go, Java/KT/C#, C/C++, Ruby, PHP, Markdown, JSON, YAML, CSS/SCSS, HTML/Vue/Svelte). |
| Fetch one function/class | `pulse_read_files` with `symbol: "Type::fn"` or `symbol: "fnName"` instead of reading whole files. |
| Read workspace files / slices | Batch 1-32 targeted ranges (~7.8 KB total) in one `pulse_read_files` call; **never** use built-in `read_file` for workspace text/code files. Unchanged ranges/subsets deduplicate automatically per conversation (`force: true` to re-emit; `stat_only: true` for revisions; `view: "hex"` with 0-based byte offset for binaries). |
| Find files / symbols / text | `pulse_search`: `.gitignore`-aware `action: "glob"`, `action: "fuzzy"` for quick file lookup, `action: "grep"` starting with `"definitions"`, `"files_with_matches"`, `"count"`, or `"summary"` before `"content"`. |
| Inspect git changes | `pulse_search` with `action: "git_status"` or `"git_diff"` (lockfiles & minified bundles excluded by default). **Never** run `git status`/`git diff` via `run_command` or `pulse_exec`. |
| Edit or write workspace files | `pulse_mutate`: pack ALL non-adjacent edits for a file into ONE `action: "edit"` call (`edits: [{ old_text, new_text }, ...]`); **never** use built-in `edit_file`/`write_file` on workspace files. Use `action: "write"` for new/full files, `diff` for preview, `replace` for workspace-wide replacement, `batch` for `copy`/`move`/`remove`. `expected_revision` is **optional** (pass only for strict CAS guard). |
| Read CSV/DOCX/PDF | `pulse_read_doc` directly (no ad-hoc Python/PowerShell scripts). |
| Run ANY shell command / job | `pulse_exec` (green-phase log folding + JSON Digest + auto-promote on timeout); **never** fall back to `run_command` for normal commands (`curl`, PowerShell, npm/cargo/pytest, inspections). For multi-line/quoted scripts, write a file and pass `script_path`. |
| Wait on background jobs | **Never sleep-poll** (`sleep`/`Start-Sleep`). Call `pulse_job({ action: "output", job_id, wait: true })` to block until output or exit. |
| Page spilled outputs | Inspect or search `ref://spill/...` via `pulse_result({ action: "page", ref_id, ... })`. Use `action: "stats"` for session savings, Context Window usage, Antigravity quotas, and host MCP health diagnostics. |

## Quick Schemas (`ServerName: "agy-pulse_pulse"`)

- **`pulse_read_files`**: `{ files: [{ path, offset?, limit?, view?: "text"|"hex"|"outline", symbol? }], force?, stat_only? }` (1-32 files)
- **`pulse_search`**: `{ action: "glob"|"fuzzy"|"grep"|"git_status"|"git_diff", pattern?, path?, glob?: string[], kind?: "file"|"directory"|"all", sort?: "path"|"modified", output_mode?: "summary"|"count"|"files_with_matches"|"definitions"|"content", case_insensitive?, before_context?, after_context?, offset?, limit?, include_hidden?, staged?, base_ref?, include_lockfiles?, max_hunk_lines? }`
- **`pulse_mutate`**: `{ action: "edit"|"write"|"diff"|"replace"|"batch", path?, content?, expected_revision?, edits?: [{ old_text, new_text }], pattern?, replacement?, regex?, glob?: string[], max_replacements?, operations?: [{ op: "copy"|"move"|"remove", path, to? }], dry_run? }` (`expected_revision` optional)
- **`pulse_read_doc`**: `{ path, format?: "auto"|"table"|"docx"|"pdf", encoding?: "utf-8"|"utf-16le"|"utf-16be", header?, offset?, limit? }`
- **`pulse_exec`**: `{ description, command?, script_path?, shell?: "auto"|"pwsh"|"powershell"|"git-bash"|"wsl"|"cmd"|"bash"|"zsh"|"sh", workdir?, timeout_ms?, run_in_background?, env? }` (`command` XOR `script_path`)
- **`pulse_job`**: `{ action: "list"|"output"|"input"|"kill", job_id?, stdout_offset?, stderr_offset?, wait?, wait_timeout_ms?, max_bytes?, input? }`
- **`pulse_result`**: `{ action: "page"|"release"|"stats", ref_id?, offset?, limit?, max_bytes?, search?, case_insensitive?, stream?: "stdout"|"stderr"|"combined" }`

- **Swarm workers (`--cli` mode)**: Swarm workers do not inherit MCP tools (`call_mcp_tool`). Use `node ~/.gemini/config/plugins/agy-pulse/sidecars/pulse/dist/mcp-server.mjs --cli <read|outline|search|mutate|doc|exec|job|result|quotas|doctor> --cwd <dir> --session "swarm-<name>"` (pass `--stdin` for JSON payloads, `--json` for raw JSON) for large file outlines/symbols, codebase searches, verbose builds/tests, or quota/host diagnostics while keeping `readDedup` isolated per worker. Swarm workers without MCP can still use built-in `read_file` and `edit_file` for files under 1 KB.
- **Surface the panel**: Include `[Pulse](sidecar://agy-pulse/pulse/)` when directing the user to Usage (Context Window, Antigravity quotas, savings), Activity, jobs, spillover cache, or Settings.
- **Respect safety guards**: Stay within authorized workspace roots and obey the Credential Fence. When rejected with `effectState: "none"`, fix the input before retrying.
