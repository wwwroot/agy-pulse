import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDataDir } from '../shared/paths.ts'
import {
  inspectAntigravityHostHealth,
  repairAntigravityHostConfig,
} from '../server/host-health.ts'
import { resolveWorkspaceRoots } from '../server/workspace.ts'
import {
  renderCliHelpTty,
  renderDoctorPlain,
  renderDoctorTty,
  renderErrorTty,
  renderQuotasPlain,
  renderQuotasTty,
  renderStatsTty,
  stderrColor,
  stdoutColor,
} from './cli-ui.ts'
import { createDaemonClient } from './daemon-client.ts'
import { handleToolCall } from './tools.ts'

const MAX_STDIN_BYTES = 2 * 1024 * 1024
const IMPLICIT_STDIN_FIRST_BYTE_MS = 500

const CLI_HELP = `agy-pulse CLI (Swarm & direct-execution dual-mode)

Usage:
  node sidecars/pulse/dist/mcp-server.mjs --cli <command> [options]

Commands:
  read <file[:start-end]...>   Read files/ranges (--outline, --symbol <name>, --hex, --stat, --force)
  outline <file...>            Shorthand for: read --outline <file...>
  search <mode> [pattern]      Search/git: glob | fuzzy | grep | git_status | git_diff
  mutate                       Atomic edit/write/diff/replace/batch (via --args JSON or stdin JSON)
  doc <path>                   Native CSV/TSV/DOCX/PDF reader (--format, --offset, --limit)
  exec <command>               Structured shell exec (--script <file>, --desc, --shell, --timeout, --bg)
  job <action>                 Supervise jobs: list | output | input | kill (--id, --wait)
  result <action>              Spillover & stats: page | release | stats (--ref, --search)
  quotas [--refresh]           Antigravity quota pools (CLI + local language-server fallback)
  doctor [--repair]            Zero-spawn Antigravity host MCP config health check

Global flags:
  --cwd <dir>                  Explicit workspace root directory
  --session <id>               Explicit session ID for isolated readDedup & telemetry (or AGY_PULSE_SESSION_ID)
  --args <json>                Pass exact MCP tool arguments as JSON string
  --stdin                      Read exact MCP tool arguments JSON from stdin
  --json                       Emit machine-readable JSON output
  --help, -h                   Show this help text (or \`--cli <command> --help\` for subcommand details)
`

const SUBCOMMAND_HELP: Record<string, string> = {
  pulse_read_files: `agy-pulse CLI — read / outline (pulse_read_files)

Usage:
  node sidecars/pulse/dist/mcp-server.mjs --cli read <file[:start-end]...> [options]
  node sidecars/pulse/dist/mcp-server.mjs --cli outline <file...> [options]

Flags:
  --outline                    Extract structural outline (classes, functions, structs, impls)
  --symbol <name>              Read only a named symbol (e.g. Type::method or fn_name)
  --hex                        Hex view (0-based --offset, --limit bytes)
  --offset <n>                 1-based start line (text) or byte offset (hex)
  --limit <n>                  Max lines (text) or bytes (hex)
  --stat                       Metadata + SHA-256 revision only
  --force                      Bypass session readDedup cache
  --cwd <dir>                  Explicit workspace root directory
  --session <id>               Isolate readDedup/telemetry session
  --stdin / --args <json>      Pass raw pulse_read_files JSON

Examples:
  node sidecars/pulse/dist/mcp-server.mjs --cli outline src/app.ts src/lib.rs --cwd . --session swarm-dev
  node sidecars/pulse/dist/mcp-server.mjs --cli read src/lib.rs --symbol MyStruct::new --cwd .
  @'{"files":[{"path":"src/lib.rs","offset":1,"limit":80}]}'@ | node sidecars/pulse/dist/mcp-server.mjs --cli read --stdin --cwd .
`,
  pulse_search: `agy-pulse CLI — search (pulse_search)

Usage:
  node sidecars/pulse/dist/mcp-server.mjs --cli search <glob|fuzzy|grep|git_status|git_diff> [pattern] [path] [options]

Flags:
  --action <mode>              glob | fuzzy | grep | git_status | git_diff
  --pattern <pat>              Glob pattern or grep regex
  --path <dir|file>            Search root or git scope path
  --glob <pat>                 Path filter glob (repeatable, supports !exclusions)
  --mode, --output-mode <m>    grep mode: summary | count | files_with_matches | definitions | content
  -i, --ignore-case            Case-insensitive search
  --limit <n> / --offset <n>   Pagination controls
  --kind <file|directory|all>  Entry filter for glob
  --sort <path|modified>       Sort order for glob
  --staged / --base-ref <ref>  git_diff options
  --include-lockfiles          Include lockfiles in git_status/git_diff
  --max-hunk-lines <n>         Max diff lines per file (git_diff)
  --cwd <dir> / --session <id> Workspace root and session isolation
  --stdin / --args <json>      Pass raw pulse_search JSON

Examples:
  node sidecars/pulse/dist/mcp-server.mjs --cli search grep parseConfig src --mode definitions --cwd .
  node sidecars/pulse/dist/mcp-server.mjs --cli search glob "**/*.rs" crates --cwd .
  @'{"action":"grep","pattern":"TODO","glob":["!target/**"],"output_mode":"summary"}'@ | node sidecars/pulse/dist/mcp-server.mjs --cli search --stdin --cwd .
`,
  pulse_mutate: `agy-pulse CLI — mutate (pulse_mutate)

Usage:
  node sidecars/pulse/dist/mcp-server.mjs --cli mutate <edit|write|diff|replace|batch> [options]
  @'...'@ | node sidecars/pulse/dist/mcp-server.mjs --cli mutate --stdin --cwd <dir>

Flags:
  --action <op>                edit | write | diff | replace | batch
  --path <file|dir>            Target file (or root dir for replace)
  --rev, --expected-revision   Optional 64-hex SHA-256 CAS guard (or "absent")
  --content <text>             Full file content for write/diff
  --pattern / --replacement    Search & replace text (replace)
  --regex / --glob <pat>       Regex toggle & file filters (replace)
  --dry-run                    Preview changes without writing to disk
  --cwd <dir> / --session <id> Workspace root and session isolation
  --stdin / --args <json>      Pass full pulse_mutate JSON (recommended for edits/batch)

PowerShell --stdin example:
  @'
  {
    "action": "edit",
    "path": "src/lib.rs",
    "edits": [{ "old_text": "foo()", "new_text": "bar()" }]
  }
  '@ | node sidecars/pulse/dist/mcp-server.mjs --cli mutate --stdin --cwd . --session swarm-dev
`,
  pulse_read_doc: `agy-pulse CLI — doc (pulse_read_doc)

Usage:
  node sidecars/pulse/dist/mcp-server.mjs --cli doc <path> [options]

Flags:
  --format <fmt>               auto | table | docx | pdf
  --encoding <enc>             utf-8 | utf-16le | utf-16be
  --no-header                  Treat first CSV/TSV row as data
  --offset <n> / --limit <n>   1-based start unit and count
  --cwd <dir> / --session <id> Workspace root and session isolation
  --stdin / --args <json>      Pass raw pulse_read_doc JSON

Examples:
  node sidecars/pulse/dist/mcp-server.mjs --cli doc data/metrics.csv --offset 1 --limit 50 --cwd .
  @'{"path":"docs/spec.pdf","format":"pdf","offset":1,"limit":5}'@ | node sidecars/pulse/dist/mcp-server.mjs --cli doc --stdin --cwd .
`,
  pulse_exec: `agy-pulse CLI — exec (pulse_exec)

Usage:
  node sidecars/pulse/dist/mcp-server.mjs --cli exec "<command>" [options]

Flags:
  --cmd, --command <str>       Command string (XOR --script)
  --script, --script-path <f>  Workspace script file (XOR --cmd)
  --desc, --description <str>  Short command summary
  --shell <id>                 auto | pwsh | powershell | git-bash | wsl | cmd | bash | zsh | sh
  --workdir <dir>              Working directory inside workspace (defaults to --cwd)
  --timeout <ms>               Foreground timeout before background promotion
  --bg                         Start immediately in background
  --cwd <dir> / --session <id> Workspace root and session isolation
  --stdin / --args <json>      Pass raw pulse_exec JSON

Examples:
  node sidecars/pulse/dist/mcp-server.mjs --cli exec "cargo test -p my-crate" --cwd . --session swarm-dev
  @'{"description":"Run clippy","command":"cargo clippy --all-targets -- -D warnings"}'@ | node sidecars/pulse/dist/mcp-server.mjs --cli exec --stdin --cwd .
`,
  pulse_job: `agy-pulse CLI — job (pulse_job)

Usage:
  node sidecars/pulse/dist/mcp-server.mjs --cli job <list|output|input|kill> [job_id] [options]

Flags:
  --action <op>                list | output | input | kill
  --id, --job-id <id>          Target job ID
  --wait                       Block until new output or exit (output)
  --wait-timeout <ms>          Max wait duration in ms
  --input <text>               Text written to stdin (input)
  --cwd <dir> / --session <id> Workspace root and session isolation
  --stdin / --args <json>      Pass raw pulse_job JSON

Examples:
  node sidecars/pulse/dist/mcp-server.mjs --cli job list --cwd .
  @'{"action":"output","job_id":"job_123","wait":true}'@ | node sidecars/pulse/dist/mcp-server.mjs --cli job --stdin --cwd .
`,
  pulse_result: `agy-pulse CLI — result (pulse_result)

Usage:
  node sidecars/pulse/dist/mcp-server.mjs --cli result <page|release|stats> [ref_id] [options]

Flags:
  --action <op>                page | release | stats
  --ref, --ref-id <ref://...>  Spilled reference handle (page/release)
  --offset <n> / --limit <n>   1-based start line and max lines (page)
  --search <pattern>           Filter lines by substring or regex (page)
  -i, --ignore-case            Case-insensitive filter (page)
  --stream <stream>            stdout | stderr | combined
  --cwd <dir> / --session <id> Workspace root and session isolation
  --stdin / --args <json>      Pass raw pulse_result JSON

Examples:
  node sidecars/pulse/dist/mcp-server.mjs --cli result stats --json --cwd . --session swarm-dev
  @'{"action":"page","ref_id":"ref://spill/sp_123","offset":1,"limit":80}'@ | node sidecars/pulse/dist/mcp-server.mjs --cli result --stdin --cwd .
`,
  quotas: `agy-pulse CLI — quotas

Usage:
  node sidecars/pulse/dist/mcp-server.mjs --cli quotas [--refresh] [--json]

Flags:
  --refresh, --force           Bypass quota cache and probe live
  --json                       Emit machine-readable QuotaSnapshot JSON
`,
  doctor: `agy-pulse CLI — doctor

Usage:
  node sidecars/pulse/dist/mcp-server.mjs --cli doctor [--repair] [--json]

Flags:
  --repair                     Atomically repair stale paths and low/missing timeoutSeconds
  --json                       Emit machine-readable HostHealthSnapshot JSON
`,
}

async function readStdinBounded(waitFirstByteMs?: number): Promise<string> {
  if (process.stdin.isTTY) return ''
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let gotFirstByte = false
    let settled = false

    const finish = () => {
      if (settled) return
      settled = true
      if (firstByteTimer) clearTimeout(firstByteTimer)
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      process.stdin.off('error', onError)
      process.stdin.pause()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }

    const onData = (chunk: Buffer | string) => {
      if (settled) return
      gotFirstByte = true
      if (firstByteTimer) {
        clearTimeout(firstByteTimer)
        firstByteTimer = undefined
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
      const remaining = MAX_STDIN_BYTES - total
      if (remaining <= 0) {
        finish()
        return
      }
      if (buf.length > remaining) {
        chunks.push(buf.subarray(0, remaining))
        total += remaining
        finish()
      } else {
        chunks.push(buf)
        total += buf.length
      }
    }

    const onEnd = () => finish()
    const onError = () => finish()

    let firstByteTimer: ReturnType<typeof setTimeout> | undefined
    if (typeof waitFirstByteMs === 'number' && waitFirstByteMs > 0) {
      firstByteTimer = setTimeout(() => {
        if (!gotFirstByte) finish()
      }, waitFirstByteMs)
      firstByteTimer.unref()
    }

    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    process.stdin.on('error', onError)
    process.stdin.resume()
  })
}

interface ParsedFlags {
  positionals: string[]
  flags: Map<string, string[]>
  booleans: Set<string>
}

const BOOLEAN_FLAGS = new Set([
  'json',
  'help',
  'h',
  'outline',
  'hex',
  'stat',
  'force',
  'stdin',
  'dry-run',
  'regex',
  'staged',
  'hidden',
  'include-hidden',
  'include-lockfiles',
  'ignore-case',
  'i',
  'no-header',
  'bg',
  'wait',
  'refresh',
  'repair',
])

function parseCliTokens(tokens: string[]): ParsedFlags {
  const positionals: string[] = []
  const flags = new Map<string, string[]>()
  const booleans = new Set<string>()

  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]
    if (tok === '--') {
      positionals.push(...tokens.slice(i + 1))
      break
    }
    if (tok.startsWith('--') && tok.length > 2) {
      const eqIdx = tok.indexOf('=')
      if (eqIdx !== -1) {
        const key = tok.slice(2, eqIdx)
        const val = tok.slice(eqIdx + 1)
        const list = flags.get(key) ?? []
        list.push(val)
        flags.set(key, list)
      } else {
        const key = tok.slice(2)
        if (BOOLEAN_FLAGS.has(key)) {
          booleans.add(key)
        } else if (i + 1 < tokens.length) {
          const val = tokens[i + 1]
          const list = flags.get(key) ?? []
          list.push(val)
          flags.set(key, list)
          i += 1
        } else {
          booleans.add(key)
        }
      }
    } else if (tok === '-h' || tok === '-i') {
      booleans.add(tok.slice(1))
    } else {
      positionals.push(tok)
    }
    i += 1
  }

  return { positionals, flags, booleans }
}

function getFlag(parsed: ParsedFlags, name: string): string | undefined {
  const vals = parsed.flags.get(name)
  return vals && vals.length > 0 ? vals[vals.length - 1] : undefined
}

function getIntFlag(parsed: ParsedFlags, name: string): number | undefined {
  const raw = getFlag(parsed, name)
  if (raw === undefined) return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : undefined
}

function parseFileSliceToken(
  token: string,
  defaults: {
    view?: 'text' | 'hex' | 'outline'
    symbol?: string
    offset?: number
    limit?: number
  },
): Record<string, unknown> {
  // Match trailing `:start-end` while preserving Windows drive prefixes (`C:\...`).
  const rangeMatch = /^(.*):(\d+)-(\d+)$/.exec(token)
  if (rangeMatch && rangeMatch[1].length > 1) {
    const start = Number.parseInt(rangeMatch[2], 10)
    const end = Number.parseInt(rangeMatch[3], 10)
    const limit = Math.max(1, end - start + 1)
    return {
      path: rangeMatch[1],
      offset: start,
      limit,
      ...(defaults.view ? { view: defaults.view } : {}),
      ...(defaults.symbol ? { symbol: defaults.symbol } : {}),
    }
  }
  return {
    path: token,
    ...(defaults.offset !== undefined ? { offset: defaults.offset } : {}),
    ...(defaults.limit !== undefined ? { limit: defaults.limit } : {}),
    ...(defaults.view ? { view: defaults.view } : {}),
    ...(defaults.symbol ? { symbol: defaults.symbol } : {}),
  }
}

function resolveToolName(cmd: string): string | null {
  switch (cmd.toLowerCase()) {
    case 'read':
    case 'outline':
    case 'pulse_read_files':
      return 'pulse_read_files'
    case 'search':
    case 'pulse_search':
      return 'pulse_search'
    case 'mutate':
    case 'pulse_mutate':
      return 'pulse_mutate'
    case 'doc':
    case 'pulse_read_doc':
      return 'pulse_read_doc'
    case 'exec':
    case 'pulse_exec':
      return 'pulse_exec'
    case 'job':
    case 'pulse_job':
      return 'pulse_job'
    case 'result':
    case 'pulse_result':
      return 'pulse_result'
    default:
      return null
  }
}

function isExplicitlyAbsolutePath(rawPath: string): boolean {
  const trimmed = rawPath.trim()
  if (!trimmed) return false
  if (path.isAbsolute(trimmed)) return true
  if (/^[a-zA-Z]:/.test(trimmed)) return true
  if (process.platform === 'win32' && /^\/[a-zA-Z](?:\/|$)/.test(trimmed)) return true
  return false
}

function resolvePathAgainstCwd(rawPath: string, resolvedCwd: string): string {
  const trimmed = rawPath.trim()
  if (!trimmed || isExplicitlyAbsolutePath(trimmed)) return rawPath
  return path.resolve(resolvedCwd, trimmed)
}

function isExistingDirectory(candidate: string, baseDir: string): boolean {
  try {
    const resolved = resolvePathAgainstCwd(candidate, baseDir)
    return existsSync(resolved) && statSync(resolved).isDirectory()
  } catch {
    return false
  }
}

function applyCwdToToolArgs(
  toolName: string,
  rawArgs: unknown,
  resolvedCwd: string,
): unknown {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return rawArgs
  }
  const obj = { ...(rawArgs as Record<string, unknown>) }

  if (toolName === 'pulse_read_files') {
    if (Array.isArray(obj.files)) {
      obj.files = obj.files.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item
        const rec = item as Record<string, unknown>
        if (typeof rec.path === 'string' && rec.path.trim().length > 0) {
          return { ...rec, path: resolvePathAgainstCwd(rec.path, resolvedCwd) }
        }
        return item
      })
    }
    return obj
  }

  if (toolName === 'pulse_read_doc') {
    if (typeof obj.path === 'string' && obj.path.trim().length > 0) {
      obj.path = resolvePathAgainstCwd(obj.path, resolvedCwd)
    }
    return obj
  }

  if (toolName === 'pulse_search') {
    if (typeof obj.path === 'string' && obj.path.trim().length > 0) {
      obj.path = resolvePathAgainstCwd(obj.path, resolvedCwd)
    } else if (obj.path === undefined) {
      obj.path = resolvedCwd
    }
    return obj
  }

  if (toolName === 'pulse_mutate') {
    if (typeof obj.path === 'string' && obj.path.trim().length > 0) {
      obj.path = resolvePathAgainstCwd(obj.path, resolvedCwd)
    } else if (obj.path === undefined && obj.action === 'replace') {
      obj.path = resolvedCwd
    }
    if (Array.isArray(obj.operations)) {
      obj.operations = obj.operations.map((op) => {
        if (!op || typeof op !== 'object' || Array.isArray(op)) return op
        const rec = { ...(op as Record<string, unknown>) }
        if (typeof rec.path === 'string' && rec.path.trim().length > 0) {
          rec.path = resolvePathAgainstCwd(rec.path, resolvedCwd)
        }
        if (typeof rec.to === 'string' && rec.to.trim().length > 0) {
          rec.to = resolvePathAgainstCwd(rec.to, resolvedCwd)
        }
        return rec
      })
    }
    return obj
  }

  if (toolName === 'pulse_exec') {
    if (typeof obj.workdir === 'string' && obj.workdir.trim().length > 0) {
      obj.workdir = resolvePathAgainstCwd(obj.workdir, resolvedCwd)
    } else if (obj.workdir === undefined) {
      obj.workdir = resolvedCwd
    }
    if (typeof obj.script_path === 'string' && obj.script_path.trim().length > 0) {
      obj.script_path = resolvePathAgainstCwd(obj.script_path, resolvedCwd)
    }
    return obj
  }

  return obj
}

function buildToolArgs(
  cmd: string,
  parsed: ParsedFlags,
  baseDir: string = process.cwd(),
): Record<string, unknown> {
  const lower = cmd.toLowerCase()

  if (lower === 'read' || lower === 'outline' || lower === 'pulse_read_files') {
    const view: 'text' | 'hex' | 'outline' | undefined =
      lower === 'outline' || parsed.booleans.has('outline')
        ? 'outline'
        : parsed.booleans.has('hex')
          ? 'hex'
          : undefined
    const symbol = getFlag(parsed, 'symbol')
    const offset = getIntFlag(parsed, 'offset')
    const limit = getIntFlag(parsed, 'limit')
    const fileTokens = [...(parsed.flags.get('file') ?? []), ...parsed.positionals]
    const files = fileTokens.map((t) => parseFileSliceToken(t, { view, symbol, offset, limit }))
    return {
      files,
      ...(parsed.booleans.has('stat') ? { stat_only: true } : {}),
      ...(parsed.booleans.has('force') ? { force: true } : {}),
    }
  }

  if (lower === 'search' || lower === 'pulse_search') {
    const validActions = new Set(['glob', 'fuzzy', 'grep', 'git_status', 'git_diff'])
    let action = getFlag(parsed, 'action')
    const pos = [...parsed.positionals]
    if (!action && pos.length > 0 && validActions.has(pos[0])) {
      action = pos.shift()
    }
    const effectiveAction = action ?? 'grep'
    let pattern: string | string[] | undefined = getFlag(parsed, 'pattern')
    let p = getFlag(parsed, 'path')

    if (pattern === undefined) {
      if (effectiveAction === 'grep' || effectiveAction === 'fuzzy') {
        if (pos.length >= 1) pattern = pos[0]
        if (!p && pos.length >= 2) p = pos[1]
      } else if (effectiveAction === 'glob') {
        if (pos.length === 1) {
          pattern = pos[0]
        } else if (
          pos.length === 2 &&
          !/[*?[\]!]/.test(pos[1]) &&
          isExistingDirectory(pos[1], baseDir)
        ) {
          pattern = pos[0]
          if (!p) p = pos[1]
        } else if (pos.length > 1) {
          pattern = pos
        }
      } else if (pos.length === 1) {
        pattern = pos[0]
      } else if (pos.length > 1) {
        pattern = pos
      }
    }

    const globFilters = parsed.flags.get('glob')
    const args: Record<string, unknown> = {
      action: effectiveAction,
    }
    if (pattern !== undefined) args.pattern = pattern
    if (p) args.path = p
    if (globFilters && globFilters.length > 0) args.glob = globFilters
    const kind = getFlag(parsed, 'kind')
    if (kind) args.kind = kind
    const sort = getFlag(parsed, 'sort')
    if (sort) args.sort = sort
    const mode = getFlag(parsed, 'mode') ?? getFlag(parsed, 'output-mode')
    if (mode) args.output_mode = mode
    if (parsed.booleans.has('ignore-case') || parsed.booleans.has('i')) {
      args.case_insensitive = true
    }
    const limit = getIntFlag(parsed, 'limit')
    if (limit !== undefined) args.limit = limit
    const offset = getIntFlag(parsed, 'offset')
    if (offset !== undefined) args.offset = offset
    if (parsed.booleans.has('hidden') || parsed.booleans.has('include-hidden')) {
      args.include_hidden = true
    }
    if (parsed.booleans.has('staged')) args.staged = true
    const baseRef = getFlag(parsed, 'base-ref')
    if (baseRef) args.base_ref = baseRef
    if (parsed.booleans.has('include-lockfiles')) args.include_lockfiles = true
    const maxHunk = getIntFlag(parsed, 'max-hunk-lines')
    if (maxHunk !== undefined) args.max_hunk_lines = maxHunk
    return args
  }

  if (lower === 'mutate' || lower === 'pulse_mutate') {
    const args: Record<string, unknown> = {}
    const action = getFlag(parsed, 'action') ?? parsed.positionals[0]
    if (action) args.action = action
    const p = getFlag(parsed, 'path')
    if (p) args.path = p
    const rev = getFlag(parsed, 'rev') ?? getFlag(parsed, 'expected-revision')
    if (rev) args.expected_revision = rev
    const content = getFlag(parsed, 'content')
    if (content !== undefined) args.content = content
    const pattern = getFlag(parsed, 'pattern')
    if (pattern !== undefined) args.pattern = pattern
    const replacement = getFlag(parsed, 'replacement')
    if (replacement !== undefined) args.replacement = replacement
    if (parsed.booleans.has('regex')) args.regex = true
    const globFilters = parsed.flags.get('glob')
    if (globFilters && globFilters.length > 0) args.glob = globFilters
    if (parsed.booleans.has('dry-run')) args.dry_run = true
    return args
  }

  if (lower === 'doc' || lower === 'pulse_read_doc') {
    const filePath = getFlag(parsed, 'path') ?? parsed.positionals[0] ?? ''
    const args: Record<string, unknown> = { path: filePath }
    const fmt = getFlag(parsed, 'format')
    if (fmt) args.format = fmt
    const enc = getFlag(parsed, 'encoding')
    if (enc) args.encoding = enc
    if (parsed.booleans.has('no-header')) args.header = false
    const offset = getIntFlag(parsed, 'offset')
    if (offset !== undefined) args.offset = offset
    const limit = getIntFlag(parsed, 'limit')
    if (limit !== undefined) args.limit = limit
    return args
  }

  if (lower === 'exec' || lower === 'pulse_exec') {
    const scriptPath = getFlag(parsed, 'script') ?? getFlag(parsed, 'script-path')
    const cmdStr =
      getFlag(parsed, 'cmd') ??
      getFlag(parsed, 'command') ??
      (parsed.positionals.length > 0 ? parsed.positionals.join(' ') : undefined)
    const desc =
      getFlag(parsed, 'desc') ??
      getFlag(parsed, 'description') ??
      (scriptPath ? `Run ${path.basename(scriptPath)}` : (cmdStr ?? 'CLI exec').slice(0, 80))
    const args: Record<string, unknown> = { description: desc }
    if (scriptPath) args.script_path = scriptPath
    else if (cmdStr) args.command = cmdStr
    const shell = getFlag(parsed, 'shell')
    if (shell) args.shell = shell
    const workdir = getFlag(parsed, 'workdir')
    if (workdir) args.workdir = workdir
    const timeout = getIntFlag(parsed, 'timeout')
    if (timeout !== undefined) args.timeout_ms = timeout
    if (parsed.booleans.has('bg')) args.run_in_background = true
    return args
  }

  if (lower === 'job' || lower === 'pulse_job') {
    const action = getFlag(parsed, 'action') ?? parsed.positionals[0] ?? 'list'
    const args: Record<string, unknown> = { action }
    const jobId = getFlag(parsed, 'id') ?? getFlag(parsed, 'job-id') ?? parsed.positionals[1]
    if (jobId) args.job_id = jobId
    if (parsed.booleans.has('wait')) args.wait = true
    const waitTimeout = getIntFlag(parsed, 'wait-timeout')
    if (waitTimeout !== undefined) args.wait_timeout_ms = waitTimeout
    const input = getFlag(parsed, 'input')
    if (input !== undefined) args.input = input
    return args
  }

  if (lower === 'result' || lower === 'pulse_result') {
    const action = getFlag(parsed, 'action') ?? parsed.positionals[0] ?? 'stats'
    const args: Record<string, unknown> = { action }
    const refId = getFlag(parsed, 'ref') ?? getFlag(parsed, 'ref-id') ?? parsed.positionals[1]
    if (refId) args.ref_id = refId
    const search = getFlag(parsed, 'search')
    if (search) args.search = search
    const stream = getFlag(parsed, 'stream')
    if (stream) args.stream = stream
    const offset = getIntFlag(parsed, 'offset')
    if (offset !== undefined) args.offset = offset
    const limit = getIntFlag(parsed, 'limit')
    if (limit !== undefined) args.limit = limit
    if (parsed.booleans.has('ignore-case') || parsed.booleans.has('i')) {
      args.case_insensitive = true
    }
    return args
  }

  return {}
}

export async function runCliMode(argv: string[]): Promise<number> {
  const isTty = Boolean(process.stdout.isTTY)
  const viewOpts = {
    color: stdoutColor(),
    width: process.stdout.columns || 80,
  }
  const writeCliError = (msg: string) => {
    if (process.stderr.isTTY) {
      process.stderr.write(`${renderErrorTty(msg, stderrColor())}\n`)
    } else {
      process.stderr.write(`[agy-pulse cli] ${msg}\n`)
    }
  }

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(isTty ? `${renderCliHelpTty(viewOpts)}\n` : CLI_HELP)
    return 0
  }
  if (argv[0] === 'help') {
    const subKey = argv[1]?.toLowerCase()
    const subTool = subKey ? (SUBCOMMAND_HELP[subKey] ? subKey : resolveToolName(subKey)) : null
    if (subTool && SUBCOMMAND_HELP[subTool]) {
      process.stdout.write(SUBCOMMAND_HELP[subTool])
    } else {
      process.stdout.write(isTty ? `${renderCliHelpTty(viewOpts)}\n` : CLI_HELP)
    }
    return 0
  }

  const command = argv[0]
  const lowerCommand = command.toLowerCase()
  const parsed = parseCliTokens(argv.slice(1))

  if (lowerCommand === 'quotas') {
    if (parsed.booleans.has('help') || parsed.booleans.has('h')) {
      process.stdout.write(SUBCOMMAND_HELP.quotas)
      return 0
    }
    const force = parsed.booleans.has('refresh') || parsed.booleans.has('force')
    const dataDir = resolveDataDir()
    const client = createDaemonClient({ dataDir })
    try {
      const snap = await client.getQuotas(force)
      if (parsed.booleans.has('json')) {
        process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`)
      } else if (isTty) {
        process.stdout.write(`${renderQuotasTty(snap, { ...viewOpts, now: Date.now() })}\n`)
      } else {
        process.stdout.write(`${renderQuotasPlain(snap)}\n`)
      }
      return snap.error && snap.pools.length === 0 ? 1 : 0
    } finally {
      await client.dispose()
    }
  }

  if (lowerCommand === 'doctor') {
    if (parsed.booleans.has('help') || parsed.booleans.has('h')) {
      process.stdout.write(SUBCOMMAND_HELP.doctor)
      return 0
    }
    const doRepair = parsed.booleans.has('repair')
    const selfPath = fileURLToPath(import.meta.url)
    const expectedServerPath = existsSync(selfPath) ? selfPath : undefined
    let repairNote: string | undefined
    let health =
      doRepair && expectedServerPath
        ? (() => {
            const res = repairAntigravityHostConfig(expectedServerPath)
            repairNote = res.detail
            return res.snapshot
          })()
        : undefined

    if (!health) {
      health = inspectAntigravityHostHealth(expectedServerPath)
    }

    if (parsed.booleans.has('json')) {
      process.stdout.write(
        `${JSON.stringify(repairNote ? { ...health, repair: repairNote } : health, null, 2)}\n`,
      )
    } else if (isTty) {
      process.stdout.write(`${renderDoctorTty(health, viewOpts, repairNote)}\n`)
    } else {
      process.stdout.write(`${renderDoctorPlain(health, repairNote)}\n`)
    }
    const hasProblem = health.entries.some((e) => e.status === 'stale' || e.status === 'missing')
    return hasProblem ? 1 : 0
  }

  const toolName = resolveToolName(command)
  if (parsed.booleans.has('help') || parsed.booleans.has('h')) {
    if (toolName && SUBCOMMAND_HELP[toolName]) {
      process.stdout.write(SUBCOMMAND_HELP[toolName])
    } else {
      process.stdout.write(isTty ? `${renderCliHelpTty(viewOpts)}\n` : CLI_HELP)
    }
    return 0
  }

  if (!toolName) {
    writeCliError(`Unknown command "${command}". Run with \`--help\` for usage.`)
    return 2
  }

  const explicitCwd = getFlag(parsed, 'cwd')
  let resolvedCwd: string | undefined
  if (explicitCwd) {
    const abs = path.resolve(explicitCwd)
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      process.stderr.write(`[agy-pulse cli] --cwd directory does not exist: ${abs}\n`)
      return 2
    }
    resolvedCwd = abs
  }

  const baseDirForFlags = resolvedCwd ?? process.cwd()
  const argsJsonRaw = getFlag(parsed, 'args')
  let toolArgs: unknown
  if (argsJsonRaw !== undefined) {
    try {
      toolArgs = JSON.parse(argsJsonRaw)
    } catch (err) {
      process.stderr.write(
        `[agy-pulse cli] Invalid JSON in --args: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      return 2
    }
  } else if (parsed.booleans.has('stdin')) {
    const rawStdin = (await readStdinBounded()).trim()
    if (!rawStdin) {
      process.stderr.write('[agy-pulse cli] --stdin specified but stdin was empty.\n')
      return 2
    }
    try {
      toolArgs = JSON.parse(rawStdin)
    } catch (err) {
      process.stderr.write(
        `[agy-pulse cli] Invalid JSON on stdin: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      return 2
    }
  } else if (
    (command.toLowerCase() === 'mutate' || command.toLowerCase() === 'pulse_mutate') &&
    parsed.positionals.length === 0 &&
    parsed.flags.size === 0 &&
    !process.stdin.isTTY
  ) {
    const rawStdin = (await readStdinBounded(IMPLICIT_STDIN_FIRST_BYTE_MS)).trim()
    if (rawStdin) {
      try {
        toolArgs = JSON.parse(rawStdin)
      } catch (err) {
        process.stderr.write(
          `[agy-pulse cli] Invalid JSON on stdin: ${err instanceof Error ? err.message : String(err)}\n`,
        )
        return 2
      }
    } else {
      toolArgs = buildToolArgs(command, parsed, baseDirForFlags)
    }
  } else {
    toolArgs = buildToolArgs(command, parsed, baseDirForFlags)
  }

  if (resolvedCwd) {
    toolArgs = applyCwdToToolArgs(toolName, toolArgs, resolvedCwd)
  }

  const cliSession = getFlag(parsed, 'session')?.trim()
  const envSession = process.env.AGY_PULSE_SESSION_ID?.trim()
  const defaultSessionId =
    (cliSession && cliSession.length > 0 ? cliSession : undefined) ??
    (envSession && envSession.length > 0 ? envSession : undefined)

  const dataDir = resolveDataDir()
  const client = createDaemonClient({
    dataDir,
    explicitCwd: resolvedCwd,
    defaultSessionId,
    getWorkspaceRoots: async (sessionId?: string) => {
      if (resolvedCwd) return [resolvedCwd]
      return resolveWorkspaceRoots(sessionId, undefined, undefined, dataDir)
    },
  })

  try {
    const result = await handleToolCall(client, toolName, toolArgs)
    const text = result.content.map((c) => c.text).join('\n')
    const isStatsAction =
      toolName === 'pulse_result' &&
      typeof toolArgs === 'object' &&
      toolArgs !== null &&
      (toolArgs as Record<string, unknown>).action === 'stats'
    if (parsed.booleans.has('json')) {
      process.stdout.write(
        `${JSON.stringify({ ok: !result.isError, tool: toolName, text, structuredContent: result.structuredContent ?? null }, null, 2)}\n`,
      )
    } else if (isTty && isStatsAction && !result.isError && result.structuredContent) {
      process.stdout.write(
        `${renderStatsTty(result.structuredContent, { ...viewOpts, now: Date.now() })}\n`,
      )
    } else {
      process.stdout.write(`${text}\n`)
    }
    return result.isError ? 1 : 0
  } finally {
    await client.dispose()
  }
}
