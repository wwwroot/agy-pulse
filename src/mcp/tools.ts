import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import type {
  ExecOutcome,
  ExecRequest,
  FailureInfo,
  HostHealthSnapshot,
  JobOutputResponse,
  JobSummary,
  MutateBatchOp,
  MutateEditSpec,
  MutateOutcome,
  MutateRequest,
  QuotaSnapshot,
  ReadDocOutcome,
  ReadDocRequest,
  ReadFileRangeSpec,
  ReadFilesOutcome,
  ReadFilesRequest,
  ResultPageRequest,
  ResultPageResponse,
  SearchOutcome,
  SearchRequest,
  SessionSummary,
  ShellId,
  ShellInfo,
  SidecarStateSnapshot,
  SpillEntrySummary,
  TerminalConfig,
  TokenSavingsSummary,
} from '../shared/types.ts'
import {
  formatExecOutcome,
  formatFailure,
  formatJobInput,
  formatJobKill,
  formatJobList,
  formatJobOutput,
  formatMutate,
  formatReadDoc,
  formatReadFiles,
  formatResultPage,
  formatResultRelease,
  formatSearch,
  formatStats,
  type DaemonSyncStatus,
  type McpToolResult,
} from './format.ts'

export interface OpsBackendClient {
  readFiles(req: ReadFilesRequest): Promise<ReadFilesOutcome>
  search(req: SearchRequest): Promise<SearchOutcome>
  mutate(req: MutateRequest): Promise<MutateOutcome>
  readDoc(req: ReadDocRequest): Promise<ReadDocOutcome>
  exec(req: ExecRequest): Promise<ExecOutcome>
  listJobs(): Promise<JobSummary[]>
  jobOutput(
    jobId: string,
    opts?: {
      stdoutOffset?: number
      stderrOffset?: number
      wait?: boolean
      waitTimeoutMs?: number
      maxBytes?: number
    },
  ): Promise<JobOutputResponse>
  jobInput(
    jobId: string,
    input: string,
  ): Promise<{ jobId: string; bytesWritten: number; job?: JobSummary }>
  jobKill(
    jobId: string,
  ): Promise<{ jobId: string; killed: boolean; job?: JobSummary; note?: string }>
  pageResult(req: ResultPageRequest): Promise<ResultPageResponse>
  releaseResult(refId: string): Promise<{ refId: string; released: boolean }>
  listSpills(sessionId?: string, limit?: number): Promise<SpillEntrySummary[]>
  getTelemetry(sessionId?: string): Promise<{
    telemetry: TokenSavingsSummary
    dedupEntryCount: number
    sessionId?: string
  }>
  getSessions(): Promise<{ sessions: SessionSummary[]; activeSessionId: string }>
  getShells(): Promise<{
    shells: ShellInfo[]
    config: TerminalConfig
    sync: DaemonSyncStatus
  }>
  getState(sessionId?: string): Promise<{ state: SidecarStateSnapshot; sync: DaemonSyncStatus }>
  getQuotas?(force?: boolean): Promise<QuotaSnapshot>
  getHostHealth?(): Promise<HostHealthSnapshot>
  dispose(): Promise<void>
}

export type TerminalBackendClient = OpsBackendClient

export class TerminalClientError extends Error {
  public readonly failure: FailureInfo

  constructor(failure: FailureInfo) {
    super(failure.message)
    this.name = 'TerminalClientError'
    this.failure = failure
  }
}

export const OpsClientError = TerminalClientError

const VALID_SHELL_IDS: readonly ShellId[] = [
  'auto',
  'pwsh',
  'powershell',
  'git-bash',
  'wsl',
  'cmd',
  'bash',
  'zsh',
  'sh',
]

const SHELL_ID_SET = new Set<string>(VALID_SHELL_IDS)
const HEX_64_RE = /^[0-9a-fA-F]{64}$/

const COMMON_ALIAS_HINTS: Record<string, string> = {
  cwd: 'workdir',
  scriptPath: 'script_path',
  timeout: 'timeout_ms',
  timeoutMs: 'timeout_ms',
  runInBackground: 'run_in_background',
  background: 'run_in_background',
  jobId: 'job_id',
  stdoutOffset: 'stdout_offset',
  stderrOffset: 'stderr_offset',
  waitTimeoutMs: 'wait_timeout_ms',
  maxBytes: 'max_bytes',
  refId: 'ref_id',
  caseInsensitive: 'case_insensitive',
  statOnly: 'stat_only',
  outputMode: 'output_mode',
  beforeContext: 'before_context',
  afterContext: 'after_context',
  includeHidden: 'include_hidden',
  expectedRevision: 'expected_revision',
  maxReplacements: 'max_replacements',
  dryRun: 'dry_run',
  oldText: 'old_text',
  newText: 'new_text',
  baseRef: 'base_ref',
  includeLockfiles: 'include_lockfiles',
  maxHunkLines: 'max_hunk_lines',
}

export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'pulse_read_files',
    description:
      'Batch-read 1–32 file ranges, structural outlines, targeted symbols, or metadata in one parallel Rust call with session read-dedup.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          description: '1–32 file specs to read in parallel.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path'],
            properties: {
              path: { type: 'string', description: 'Workspace-relative or absolute path.' },
              offset: { type: 'number', description: '1-based start line (text) or byte offset (hex).' },
              limit: { type: 'number', description: 'Max lines (text) or bytes (hex).' },
              view: {
                type: 'string',
                enum: ['text', 'hex', 'outline'],
                description: 'Read view mode: text, hex, or outline (default: text).',
              },
              symbol: {
                type: 'string',
                description: 'Read only a named function, method, class, struct, or impl block.',
              },
            },
          },
        },
        force: {
          type: 'boolean',
          description: 'Bypass session read-dedup cache and return full content.',
        },
        stat_only: {
          type: 'boolean',
          description: 'Return metadata and SHA-256 revision only without file content.',
        },
      },
    },
  },
  {
    name: 'pulse_search',
    description:
      'Native Rust .gitignore-aware glob, fuzzy file finder, 5-mode progressive grep, and compact git_status/git_diff.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['glob', 'fuzzy', 'grep', 'git_status', 'git_diff'],
          description: 'Search/git mode: glob, fuzzy, grep, git_status, or git_diff.',
        },
        pattern: {
          type: 'string',
          description: 'Glob pattern or grep regex (required for glob/grep/fuzzy; glob also accepts string[] at runtime).',
        },
        path: { type: 'string', description: 'Search root dir/file or git scope path.' },
        glob: {
          type: 'array',
          items: { type: 'string' },
          description: 'Path glob filters for grep or git (supports !exclusions).',
        },
        kind: {
          type: 'string',
          enum: ['file', 'directory', 'all'],
          description: 'Entry kind filter for glob (default: file).',
        },
        sort: {
          type: 'string',
          enum: ['path', 'modified'],
          description: 'Sort order for glob (default: path).',
        },
        output_mode: {
          type: 'string',
          enum: ['summary', 'count', 'files_with_matches', 'definitions', 'content'],
          description: 'Progressive grep output mode.',
        },
        case_insensitive: { type: 'boolean', description: 'Case-insensitive matching.' },
        before_context: { type: 'number', description: 'Lines before each grep match.' },
        after_context: { type: 'number', description: 'Lines after each grep match.' },
        offset: { type: 'number', description: 'Result pagination offset.' },
        limit: { type: 'number', description: 'Max entries to return.' },
        include_hidden: { type: 'boolean', description: 'Include dotfiles and hidden directories.' },
        staged: { type: 'boolean', description: 'Diff staged changes only (git_diff).' },
        base_ref: { type: 'string', description: 'Base git ref to diff against (git_diff).' },
        include_lockfiles: {
          type: 'boolean',
          description: 'Include lockfiles and minified assets (git_status/git_diff).',
        },
        max_hunk_lines: { type: 'number', description: 'Max diff lines per file (git_diff).' },
      },
    },
  },
  {
    name: 'pulse_mutate',
    description:
      'Atomic CAS file edits, writes, unified diffs, multi-file replace, and batch copy/move/remove.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['edit', 'write', 'diff', 'replace', 'batch'],
          description: 'Mutation operation.',
        },
        path: { type: 'string', description: 'Target file path (or root dir for replace).' },
        content: { type: 'string', description: 'Full file content for write or diff.' },
        expected_revision: {
          type: 'string',
          description: '64-hex SHA-256 revision from pulse_read_files, or "absent" for new files.',
        },
        edits: {
          type: 'array',
          description: 'Ordered exact text replacements for edit or diff.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['old_text', 'new_text'],
            properties: {
              old_text: { type: 'string', description: 'Exact text to find.' },
              new_text: { type: 'string', description: 'Replacement text.' },
            },
          },
        },
        pattern: { type: 'string', description: 'Search string or regex for replace.' },
        replacement: { type: 'string', description: 'Replacement text for replace.' },
        regex: { type: 'boolean', description: 'Treat pattern as regex (replace).' },
        glob: {
          type: 'array',
          items: { type: 'string' },
          description: 'File glob filters for replace.',
        },
        max_replacements: { type: 'number', description: 'Cap total replacements (replace).' },
        operations: {
          type: 'array',
          description: 'File operations for batch (copy, move, remove).',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['op', 'path'],
            properties: {
              op: { type: 'string', enum: ['copy', 'move', 'remove'] },
              path: { type: 'string', description: 'Source path.' },
              to: { type: 'string', description: 'Destination path (copy/move).' },
            },
          },
        },
        dry_run: { type: 'boolean', description: 'Preview changes without writing to disk.' },
      },
    },
  },
  {
    name: 'pulse_read_doc',
    description:
      'Native Rust reader for CSV/TSV tables, DOCX paragraphs, and PDF text layers without external scripts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Document path inside workspace.' },
        format: {
          type: 'string',
          enum: ['auto', 'table', 'docx', 'pdf'],
          description: 'Document format (default: auto).',
        },
        encoding: {
          type: 'string',
          enum: ['utf-8', 'utf-16le', 'utf-16be'],
          description: 'Text encoding for CSV/TSV tables (default: utf-8).',
        },
        header: { type: 'boolean', description: 'Treat first CSV/TSV row as column headers.' },
        offset: { type: 'number', description: '1-based start row, paragraph, or page.' },
        limit: { type: 'number', description: 'Max rows, paragraphs, or pages to return.' },
      },
    },
  },
  {
    name: 'pulse_exec',
    description:
      'Structured workspace shell execution (command XOR script_path) with multi-shell routing, env hygiene, JSON digest, spillover cache, and timeout auto-promotion.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['description'],
      properties: {
        description: { type: 'string', description: 'Short 4–10 word summary of the command.' },
        command: { type: 'string', description: 'Shell command string (XOR script_path).' },
        script_path: {
          type: 'string',
          description: 'Workspace script path; prefer for multi-line/quoted/non-ASCII scripts (XOR command).',
        },
        shell: {
          type: 'string',
          enum: [...VALID_SHELL_IDS],
          description: 'Target shell (default: auto).',
        },
        workdir: { type: 'string', description: 'Working directory inside workspace.' },
        timeout_ms: { type: 'number', description: 'Foreground timeout (ms) before background promotion.' },
        run_in_background: { type: 'boolean', description: 'Start immediately as background job.' },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Extra string environment variables.',
        },
      },
    },
  },
  {
    name: 'pulse_job',
    description:
      'Supervise background and timeout-promoted jobs (list, output with blocking wait: true, input, kill).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'output', 'input', 'kill'],
          description: 'Job supervision action.',
        },
        job_id: { type: 'string', description: 'Job ID (required for output, input, kill).' },
        stdout_offset: { type: 'number', description: 'Byte offset into stdout (output).' },
        stderr_offset: { type: 'number', description: 'Byte offset into stderr (output).' },
        wait: { type: 'boolean', description: 'Block until new output or exit (output).' },
        wait_timeout_ms: { type: 'number', description: 'Max ms to wait when wait=true.' },
        max_bytes: { type: 'number', description: 'Max inline bytes per stream (output).' },
        input: { type: 'string', description: 'Text to send to stdin (input; include \\n).' },
      },
    },
  },
  {
    name: 'pulse_result',
    description:
      'Page/search/release spilled output handles (ref://spill/...) or inspect per-session token-savings telemetry & runtime status (action: "stats").',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['page', 'release', 'stats'],
          description: 'page/release a spilled ref_id, or stats for session telemetry & runtime status.',
        },
        ref_id: { type: 'string', description: 'Spilled handle (ref://spill/...); required for page/release.' },
        offset: { type: 'number', description: '1-based start line (page, default: 1).' },
        limit: { type: 'number', description: 'Max lines to return (page, default: 200).' },
        max_bytes: { type: 'number', description: 'Max UTF-8 bytes to return (page).' },
        search: { type: 'string', description: 'Substring or regex line filter (page).' },
        case_insensitive: { type: 'boolean', description: 'Case-insensitive search (page).' },
        stream: {
          type: 'string',
          enum: ['stdout', 'stderr', 'combined'],
          description: 'Stream to inspect (page, default: combined).',
        },
      },
    },
  },
]

const READ_FILES_ALLOWED_KEYS = ['files', 'force', 'stat_only'] as const
const READ_FILE_ITEM_ALLOWED_KEYS = ['path', 'offset', 'limit', 'view', 'symbol'] as const

const SEARCH_ALLOWED_KEYS = [
  'action',
  'pattern',
  'path',
  'glob',
  'kind',
  'sort',
  'output_mode',
  'case_insensitive',
  'before_context',
  'after_context',
  'offset',
  'limit',
  'include_hidden',
  'staged',
  'base_ref',
  'include_lockfiles',
  'max_hunk_lines',
] as const

const MUTATE_ALLOWED_KEYS = [
  'action',
  'path',
  'content',
  'expected_revision',
  'edits',
  'pattern',
  'replacement',
  'regex',
  'glob',
  'max_replacements',
  'operations',
  'dry_run',
] as const
const MUTATE_EDIT_ALLOWED_KEYS = ['old_text', 'new_text'] as const
const MUTATE_BATCH_OP_ALLOWED_KEYS = ['op', 'path', 'to'] as const

const READ_DOC_ALLOWED_KEYS = [
  'path',
  'format',
  'encoding',
  'header',
  'offset',
  'limit',
] as const

const EXEC_ALLOWED_KEYS = [
  'description',
  'command',
  'script_path',
  'shell',
  'workdir',
  'timeout_ms',
  'run_in_background',
  'env',
] as const

const JOB_ALLOWED_KEYS = [
  'action',
  'job_id',
  'stdout_offset',
  'stderr_offset',
  'wait',
  'wait_timeout_ms',
  'max_bytes',
  'input',
] as const

const RESULT_ALLOWED_KEYS = [
  'action',
  'ref_id',
  'offset',
  'limit',
  'max_bytes',
  'search',
  'case_insensitive',
  'stream',
] as const

export type KnownArgsCheck =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; failure: FailureInfo }

/**
 * Validates that `rawArgs` is a plain object containing only known keys,
 * returning an `effectState: 'none'` failure on unknown keys.
 */
export function assertKnownArguments(
  toolName: string,
  rawArgs: unknown,
  allowedKeys: readonly string[],
): KnownArgsCheck {
  if (rawArgs === undefined || rawArgs === null) {
    return { ok: true, args: {} }
  }

  if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return {
      ok: false,
      failure: {
        code: 'INVALID_ARGUMENTS',
        message: `Arguments for "${toolName}" must be a JSON object.`,
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: `Pass a JSON object matching the schema for "${toolName}".`,
      },
    }
  }

  const record = rawArgs as Record<string, unknown>
  const allowedSet = new Set(allowedKeys)
  const unknownKeys = Object.keys(record).filter((k) => !allowedSet.has(k))

  if (unknownKeys.length > 0) {
    const hints: string[] = []
    for (const key of unknownKeys) {
      const suggestion = COMMON_ALIAS_HINTS[key]
      if (suggestion && allowedSet.has(suggestion)) {
        hints.push(`"${key}" -> "${suggestion}"`)
      }
    }
    const hintText = hints.length > 0 ? ` Did you mean: ${hints.join(', ')}?` : ''
    const allowedText = allowedKeys.length > 0 ? allowedKeys.join(', ') : '(none)'

    return {
      ok: false,
      failure: {
        code: 'UNKNOWN_ARGUMENTS',
        message: `Unknown argument(s) for "${toolName}": ${unknownKeys.join(', ')}. Allowed: ${allowedText}.${hintText}`,
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: `Remove unrecognized parameter(s) (${unknownKeys.join(', ')}) and retry "${toolName}".`,
      },
    }
  }

  return { ok: true, args: record }
}

function invalidArgFailure(
  toolName: string,
  message: string,
  nextAction: string,
): FailureInfo {
  return {
    code: 'INVALID_ARGUMENTS',
    message: `[${toolName}] ${message}`,
    effectState: 'none',
    retry: 'after-input-change',
    nextAction,
  }
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
  toolName: string,
): { ok: true; value: string | undefined } | { ok: false; failure: FailureInfo } {
  const val = args[key]
  if (val === undefined) return { ok: true, value: undefined }
  if (typeof val !== 'string') {
    return {
      ok: false,
      failure: invalidArgFailure(
        toolName,
        `Parameter "${key}" must be a string.`,
        `Provide a string value for "${key}" or omit it.`,
      ),
    }
  }
  return { ok: true, value: val }
}

function optionalStringArray(
  args: Record<string, unknown>,
  key: string,
  toolName: string,
): { ok: true; value: string[] | undefined } | { ok: false; failure: FailureInfo } {
  const val = args[key]
  if (val === undefined) return { ok: true, value: undefined }
  if (!Array.isArray(val) || !val.every((item) => typeof item === 'string')) {
    return {
      ok: false,
      failure: invalidArgFailure(
        toolName,
        `Parameter "${key}" must be an array of strings.`,
        `Provide a string[] for "${key}" or omit it.`,
      ),
    }
  }
  return { ok: true, value: val as string[] }
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
  toolName: string,
  opts?: { min?: number; max?: number; integer?: boolean },
): { ok: true; value: number | undefined } | { ok: false; failure: FailureInfo } {
  const val = args[key]
  if (val === undefined) return { ok: true, value: undefined }
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    return {
      ok: false,
      failure: invalidArgFailure(
        toolName,
        `Parameter "${key}" must be a finite number.`,
        `Provide a valid numeric value for "${key}" or omit it.`,
      ),
    }
  }
  if (opts?.min !== undefined && val < opts.min) {
    return {
      ok: false,
      failure: invalidArgFailure(
        toolName,
        `Parameter "${key}" must be >= ${opts.min} (got ${val}).`,
        `Pass a number >= ${opts.min} for "${key}".`,
      ),
    }
  }
  if (opts?.max !== undefined && val > opts.max) {
    return {
      ok: false,
      failure: invalidArgFailure(
        toolName,
        `Parameter "${key}" must be <= ${opts.max} (got ${val}).`,
        `Pass a number <= ${opts.max} for "${key}".`,
      ),
    }
  }
  if (opts?.integer && !Number.isInteger(val)) {
    return {
      ok: false,
      failure: invalidArgFailure(
        toolName,
        `Parameter "${key}" must be an integer (got ${val}).`,
        `Pass a whole number for "${key}".`,
      ),
    }
  }
  return { ok: true, value: val }
}

function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
  toolName: string,
): { ok: true; value: boolean | undefined } | { ok: false; failure: FailureInfo } {
  const val = args[key]
  if (val === undefined) return { ok: true, value: undefined }
  if (typeof val !== 'boolean') {
    return {
      ok: false,
      failure: invalidArgFailure(
        toolName,
        `Parameter "${key}" must be a boolean.`,
        `Provide true or false for "${key}" or omit it.`,
      ),
    }
  }
  return { ok: true, value: val }
}

function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  toolName: string,
  allowed: readonly T[],
): { ok: true; value: T | undefined } | { ok: false; failure: FailureInfo } {
  const str = optionalString(args, key, toolName)
  if (!str.ok) return str
  if (str.value === undefined) return { ok: true, value: undefined }
  if (!(allowed as readonly string[]).includes(str.value)) {
    return {
      ok: false,
      failure: invalidArgFailure(
        toolName,
        `Parameter "${key}" must be one of: ${allowed.join(', ')} (got "${str.value}").`,
        `Choose a valid value for "${key}".`,
      ),
    }
  }
  return { ok: true, value: str.value as T }
}

function optionalShell(
  args: Record<string, unknown>,
  toolName: string,
): { ok: true; value: ShellId | undefined } | { ok: false; failure: FailureInfo } {
  const res = optionalString(args, 'shell', toolName)
  if (!res.ok) return res
  if (res.value === undefined) return { ok: true, value: undefined }
  if (!SHELL_ID_SET.has(res.value)) {
    return {
      ok: false,
      failure: invalidArgFailure(
        toolName,
        `Unsupported shell "${res.value}". Valid: ${VALID_SHELL_IDS.join(', ')}.`,
        'Choose a supported shell id or omit "shell" for "auto".',
      ),
    }
  }
  return { ok: true, value: res.value as ShellId }
}

async function handleOpsReadFiles(
  client: OpsBackendClient,
  rawArgs: unknown,
): Promise<McpToolResult> {
  const toolName = 'pulse_read_files'
  const checked = assertKnownArguments(toolName, rawArgs, READ_FILES_ALLOWED_KEYS)
  if (!checked.ok) return formatFailure(toolName, checked.failure)
  const { args } = checked

  if (!Array.isArray(args.files) || args.files.length === 0 || args.files.length > 32) {
    return formatFailure(
      toolName,
      invalidArgFailure(
        toolName,
        'Parameter "files" is required and must contain 1–32 file range objects.',
        'Pass an array of 1–32 objects like [{ path: "src/index.ts", offset: 1, limit: 200 }].',
      ),
    )
  }

  const specs: ReadFileRangeSpec[] = []
  for (let i = 0; i < args.files.length; i++) {
    const itemCheck = assertKnownArguments(
      `${toolName}.files[${i}]`,
      args.files[i],
      READ_FILE_ITEM_ALLOWED_KEYS,
    )
    if (!itemCheck.ok) return formatFailure(toolName, itemCheck.failure)
    const item = itemCheck.args

    const pathRes = optionalString(item, 'path', `${toolName}.files[${i}]`)
    if (!pathRes.ok) return formatFailure(toolName, pathRes.failure)
    if (!pathRes.value || pathRes.value.trim().length === 0) {
      return formatFailure(
        toolName,
        invalidArgFailure(
          toolName,
          `files[${i}].path is required and must be a non-empty string.`,
          'Provide a valid file path for each entry in "files".',
        ),
      )
    }

    const viewRes = optionalEnum(item, 'view', `${toolName}.files[${i}]`, [
      'text',
      'hex',
      'outline',
    ] as const)
    if (!viewRes.ok) return formatFailure(toolName, viewRes.failure)

    const symbolRes = optionalString(item, 'symbol', `${toolName}.files[${i}]`)
    if (!symbolRes.ok) return formatFailure(toolName, symbolRes.failure)
    if (symbolRes.value !== undefined && symbolRes.value.trim().length === 0) {
      return formatFailure(
        toolName,
        invalidArgFailure(
          toolName,
          `files[${i}].symbol must be a non-empty string when provided.`,
          'Provide a symbol name (e.g. "MyClass.myMethod" or "parseConfig") or omit "symbol".',
        ),
      )
    }

    const minOffset = viewRes.value === 'hex' ? 0 : 1
    const offsetRes = optionalNumber(item, 'offset', `${toolName}.files[${i}]`, {
      min: minOffset,
      integer: true,
    })
    if (!offsetRes.ok) return formatFailure(toolName, offsetRes.failure)

    const limitRes = optionalNumber(item, 'limit', `${toolName}.files[${i}]`, {
      min: 1,
      integer: true,
    })
    if (!limitRes.ok) return formatFailure(toolName, limitRes.failure)

    specs.push({
      path: pathRes.value,
      ...(offsetRes.value !== undefined ? { offset: offsetRes.value } : {}),
      ...(limitRes.value !== undefined ? { limit: limitRes.value } : {}),
      ...(viewRes.value !== undefined ? { view: viewRes.value } : {}),
      ...(symbolRes.value !== undefined ? { symbol: symbolRes.value.trim() } : {}),
    })
  }

  const forceRes = optionalBoolean(args, 'force', toolName)
  if (!forceRes.ok) return formatFailure(toolName, forceRes.failure)

  const statOnlyRes = optionalBoolean(args, 'stat_only', toolName)
  if (!statOnlyRes.ok) return formatFailure(toolName, statOnlyRes.failure)

  const outcome = await client.readFiles({
    files: specs,
    ...(forceRes.value !== undefined ? { force: forceRes.value } : {}),
    ...(statOnlyRes.value !== undefined ? { statOnly: statOnlyRes.value } : {}),
  })
  return formatReadFiles(outcome)
}

async function handleOpsSearch(
  client: OpsBackendClient,
  rawArgs: unknown,
): Promise<McpToolResult> {
  const toolName = 'pulse_search'
  const checked = assertKnownArguments(toolName, rawArgs, SEARCH_ALLOWED_KEYS)
  if (!checked.ok) return formatFailure(toolName, checked.failure)
  const { args } = checked

  const actionRes = optionalEnum(args, 'action', toolName, [
    'glob',
    'fuzzy',
    'grep',
    'git_status',
    'git_diff',
  ] as const)
  if (!actionRes.ok) return formatFailure(toolName, actionRes.failure)
  if (!actionRes.value) {
    return formatFailure(
      toolName,
      invalidArgFailure(
        toolName,
        'Parameter "action" is required ("glob", "fuzzy", "grep", "git_status", or "git_diff").',
        'Pass action: "glob", "fuzzy", "grep", "git_status", or "git_diff".',
      ),
    )
  }
  const action = actionRes.value
  const isGitAction = action === 'git_status' || action === 'git_diff'

  let pattern: string | string[] | undefined
  if (isGitAction) {
    if (args.pattern !== undefined) {
      if (typeof args.pattern === 'string') {
        if (args.pattern.length === 0) {
          return formatFailure(
            toolName,
            invalidArgFailure(
              toolName,
              'Parameter "pattern" must be non-empty when provided.',
              'Provide a non-empty pattern or omit it for git actions.',
            ),
          )
        }
        pattern = args.pattern
      } else if (
        Array.isArray(args.pattern) &&
        args.pattern.length > 0 &&
        args.pattern.every((p) => typeof p === 'string' && p.length > 0)
      ) {
        pattern = args.pattern as string[]
      } else {
        return formatFailure(
          toolName,
          invalidArgFailure(
            toolName,
            'Parameter "pattern" must be a non-empty string or string[] when provided.',
            'Provide a valid "pattern" or omit it for git_status/git_diff.',
          ),
        )
      }
    }
  } else if (typeof args.pattern === 'string') {
    if (args.pattern.length === 0) {
      return formatFailure(
        toolName,
        invalidArgFailure(
          toolName,
          'Parameter "pattern" must be a non-empty string.',
          'Provide a search pattern.',
        ),
      )
    }
    pattern = args.pattern
  } else if (
    action === 'glob' &&
    Array.isArray(args.pattern) &&
    args.pattern.length > 0 &&
    args.pattern.every((p) => typeof p === 'string' && p.length > 0)
  ) {
    pattern = args.pattern as string[]
  } else {
    return formatFailure(
      toolName,
      invalidArgFailure(
        toolName,
        action === 'glob'
          ? 'Parameter "pattern" must be a non-empty string or string[] for glob.'
          : 'Parameter "pattern" must be a non-empty string for grep.',
        'Provide a valid "pattern" value.',
      ),
    )
  }

  const pathRes = optionalString(args, 'path', toolName)
  if (!pathRes.ok) return formatFailure(toolName, pathRes.failure)

  const globRes = optionalStringArray(args, 'glob', toolName)
  if (!globRes.ok) return formatFailure(toolName, globRes.failure)

  const kindRes = optionalEnum(args, 'kind', toolName, ['file', 'directory', 'all'] as const)
  if (!kindRes.ok) return formatFailure(toolName, kindRes.failure)

  const sortRes = optionalEnum(args, 'sort', toolName, ['path', 'modified'] as const)
  if (!sortRes.ok) return formatFailure(toolName, sortRes.failure)

  const modeRes = optionalEnum(args, 'output_mode', toolName, [
    'summary',
    'count',
    'files_with_matches',
    'definitions',
    'content',
  ] as const)
  if (!modeRes.ok) return formatFailure(toolName, modeRes.failure)

  const caseRes = optionalBoolean(args, 'case_insensitive', toolName)
  if (!caseRes.ok) return formatFailure(toolName, caseRes.failure)

  const beforeRes = optionalNumber(args, 'before_context', toolName, { min: 0, integer: true })
  if (!beforeRes.ok) return formatFailure(toolName, beforeRes.failure)

  const afterRes = optionalNumber(args, 'after_context', toolName, { min: 0, integer: true })
  if (!afterRes.ok) return formatFailure(toolName, afterRes.failure)

  const offsetRes = optionalNumber(args, 'offset', toolName, { min: 0, integer: true })
  if (!offsetRes.ok) return formatFailure(toolName, offsetRes.failure)

  const limitRes = optionalNumber(args, 'limit', toolName, { min: 1, integer: true })
  if (!limitRes.ok) return formatFailure(toolName, limitRes.failure)

  const hiddenRes = optionalBoolean(args, 'include_hidden', toolName)
  if (!hiddenRes.ok) return formatFailure(toolName, hiddenRes.failure)

  const stagedRes = optionalBoolean(args, 'staged', toolName)
  if (!stagedRes.ok) return formatFailure(toolName, stagedRes.failure)

  const baseRefRes = optionalString(args, 'base_ref', toolName)
  if (!baseRefRes.ok) return formatFailure(toolName, baseRefRes.failure)
  if (baseRefRes.value !== undefined && baseRefRes.value.trim().length === 0) {
    return formatFailure(
      toolName,
      invalidArgFailure(
        toolName,
        'Parameter "base_ref" must be a non-empty string when provided.',
        'Provide a git ref (e.g. "HEAD~1" or "main") or omit "base_ref".',
      ),
    )
  }

  const includeLockfilesRes = optionalBoolean(args, 'include_lockfiles', toolName)
  if (!includeLockfilesRes.ok) return formatFailure(toolName, includeLockfilesRes.failure)

  const maxHunkLinesRes = optionalNumber(args, 'max_hunk_lines', toolName, {
    min: 1,
    integer: true,
  })
  if (!maxHunkLinesRes.ok) return formatFailure(toolName, maxHunkLinesRes.failure)

  const req: SearchRequest = {
    action,
    ...(pattern !== undefined ? { pattern } : {}),
    ...(pathRes.value !== undefined ? { path: pathRes.value } : {}),
    ...(globRes.value !== undefined ? { glob: globRes.value } : {}),
    ...(kindRes.value !== undefined ? { kind: kindRes.value } : {}),
    ...(sortRes.value !== undefined ? { sort: sortRes.value } : {}),
    ...(modeRes.value !== undefined ? { outputMode: modeRes.value } : {}),
    ...(caseRes.value !== undefined ? { caseInsensitive: caseRes.value } : {}),
    ...(beforeRes.value !== undefined ? { beforeContext: beforeRes.value } : {}),
    ...(afterRes.value !== undefined ? { afterContext: afterRes.value } : {}),
    ...(offsetRes.value !== undefined ? { offset: offsetRes.value } : {}),
    ...(limitRes.value !== undefined ? { limit: limitRes.value } : {}),
    ...(hiddenRes.value !== undefined ? { includeHidden: hiddenRes.value } : {}),
    ...(stagedRes.value !== undefined ? { staged: stagedRes.value } : {}),
    ...(baseRefRes.value !== undefined ? { baseRef: baseRefRes.value.trim() } : {}),
    ...(includeLockfilesRes.value !== undefined
      ? { includeLockfiles: includeLockfilesRes.value }
      : {}),
    ...(maxHunkLinesRes.value !== undefined ? { maxHunkLines: maxHunkLinesRes.value } : {}),
  }

  const outcome = await client.search(req)
  return formatSearch(outcome)
}

async function handleOpsMutate(
  client: OpsBackendClient,
  rawArgs: unknown,
): Promise<McpToolResult> {
  const toolName = 'pulse_mutate'
  const checked = assertKnownArguments(toolName, rawArgs, MUTATE_ALLOWED_KEYS)
  if (!checked.ok) return formatFailure(toolName, checked.failure)
  const { args } = checked

  const actionRes = optionalEnum(args, 'action', toolName, [
    'edit',
    'write',
    'diff',
    'replace',
    'batch',
  ] as const)
  if (!actionRes.ok) return formatFailure(toolName, actionRes.failure)
  if (!actionRes.value) {
    return formatFailure(
      toolName,
      invalidArgFailure(
        toolName,
        'Parameter "action" is required ("edit", "write", "diff", "replace", or "batch").',
        'Specify a valid mutation action.',
      ),
    )
  }
  const action = actionRes.value

  const pathRes = optionalString(args, 'path', toolName)
  if (!pathRes.ok) return formatFailure(toolName, pathRes.failure)

  const contentRes = optionalString(args, 'content', toolName)
  if (!contentRes.ok) return formatFailure(toolName, contentRes.failure)

  const revRes = optionalString(args, 'expected_revision', toolName)
  if (!revRes.ok) return formatFailure(toolName, revRes.failure)
  let expectedRevision: string | undefined
  if (revRes.value !== undefined) {
    const trimmed = revRes.value.trim()
    if (trimmed !== 'absent' && !HEX_64_RE.test(trimmed)) {
      return formatFailure(
        toolName,
        invalidArgFailure(
          toolName,
          'Parameter "expected_revision" must be a 64-char hex SHA-256 hash or "absent".',
          'Pass the exact revision returned by pulse_read_files, or "absent" when creating a new file.',
        ),
      )
    }
    expectedRevision = trimmed === 'absent' ? 'absent' : trimmed.toLowerCase()
  }

  let edits: MutateEditSpec[] | undefined
  if (args.edits !== undefined) {
    if (!Array.isArray(args.edits)) {
      return formatFailure(
        toolName,
        invalidArgFailure(
          toolName,
          'Parameter "edits" must be an array of { old_text, new_text } objects.',
          'Provide an array of edit objects.',
        ),
      )
    }
    edits = []
    for (let i = 0; i < args.edits.length; i++) {
      const editCheck = assertKnownArguments(
        `${toolName}.edits[${i}]`,
        args.edits[i],
        MUTATE_EDIT_ALLOWED_KEYS,
      )
      if (!editCheck.ok) return formatFailure(toolName, editCheck.failure)
      const oldRes = optionalString(editCheck.args, 'old_text', `${toolName}.edits[${i}]`)
      if (!oldRes.ok) return formatFailure(toolName, oldRes.failure)
      const newRes = optionalString(editCheck.args, 'new_text', `${toolName}.edits[${i}]`)
      if (!newRes.ok) return formatFailure(toolName, newRes.failure)
      if (oldRes.value === undefined || newRes.value === undefined) {
        return formatFailure(
          toolName,
          invalidArgFailure(
            toolName,
            `edits[${i}] requires both "old_text" and "new_text" strings.`,
            'Provide both old_text and new_text for every edit.',
          ),
        )
      }
      edits.push({ oldText: oldRes.value, newText: newRes.value })
    }
  }

  const patternRes = optionalString(args, 'pattern', toolName)
  if (!patternRes.ok) return formatFailure(toolName, patternRes.failure)

  const replacementRes = optionalString(args, 'replacement', toolName)
  if (!replacementRes.ok) return formatFailure(toolName, replacementRes.failure)

  const regexRes = optionalBoolean(args, 'regex', toolName)
  if (!regexRes.ok) return formatFailure(toolName, regexRes.failure)

  const globRes = optionalStringArray(args, 'glob', toolName)
  if (!globRes.ok) return formatFailure(toolName, globRes.failure)

  const maxReplRes = optionalNumber(args, 'max_replacements', toolName, {
    min: 1,
    integer: true,
  })
  if (!maxReplRes.ok) return formatFailure(toolName, maxReplRes.failure)

  let operations: MutateBatchOp[] | undefined
  if (args.operations !== undefined) {
    if (!Array.isArray(args.operations)) {
      return formatFailure(
        toolName,
        invalidArgFailure(
          toolName,
          'Parameter "operations" must be an array of { op, path, to? } objects.',
          'Provide an array of batch operations.',
        ),
      )
    }
    operations = []
    for (let i = 0; i < args.operations.length; i++) {
      const opCheck = assertKnownArguments(
        `${toolName}.operations[${i}]`,
        args.operations[i],
        MUTATE_BATCH_OP_ALLOWED_KEYS,
      )
      if (!opCheck.ok) return formatFailure(toolName, opCheck.failure)
      const opRes = optionalEnum(
        opCheck.args,
        'op',
        `${toolName}.operations[${i}]`,
        ['copy', 'move', 'remove'] as const,
      )
      if (!opRes.ok) return formatFailure(toolName, opRes.failure)
      const srcRes = optionalString(opCheck.args, 'path', `${toolName}.operations[${i}]`)
      if (!srcRes.ok) return formatFailure(toolName, srcRes.failure)
      const toRes = optionalString(opCheck.args, 'to', `${toolName}.operations[${i}]`)
      if (!toRes.ok) return formatFailure(toolName, toRes.failure)

      if (!opRes.value || !srcRes.value || srcRes.value.trim().length === 0) {
        return formatFailure(
          toolName,
          invalidArgFailure(
            toolName,
            `operations[${i}] requires valid "op" ("copy"|"move"|"remove") and non-empty "path".`,
            'Fix the malformed batch operation and retry.',
          ),
        )
      }
      if ((opRes.value === 'copy' || opRes.value === 'move') && (!toRes.value || toRes.value.trim().length === 0)) {
        return formatFailure(
          toolName,
          invalidArgFailure(
            toolName,
            `operations[${i}] with op="${opRes.value}" requires a non-empty "to" destination path.`,
            'Provide "to" for copy and move operations.',
          ),
        )
      }
      operations.push({
        op: opRes.value,
        path: srcRes.value,
        ...(toRes.value !== undefined ? { to: toRes.value } : {}),
      })
    }
  }

  const dryRunRes = optionalBoolean(args, 'dry_run', toolName)
  if (!dryRunRes.ok) return formatFailure(toolName, dryRunRes.failure)

  if (action === 'write') {
    if (!pathRes.value?.trim() || contentRes.value === undefined) {
      return formatFailure(
        toolName,
        invalidArgFailure(
          toolName,
          'Action "write" requires "path" and "content".',
          'Provide "path" and "content" (plus optional "expected_revision").',
        ),
      )
    }
  } else if (action === 'edit') {
    if (!pathRes.value?.trim() || !edits || edits.length === 0) {
      return formatFailure(
        toolName,
        invalidArgFailure(
          toolName,
          'Action "edit" requires "path" and a non-empty "edits" array.',
          'Provide "path" and at least one { old_text, new_text } edit.',
        ),
      )
    }
  } else if (action === 'diff') {
    if (!pathRes.value?.trim() || (contentRes.value === undefined && (!edits || edits.length === 0))) {
      return formatFailure(
        toolName,
        invalidArgFailure(
          toolName,
          'Action "diff" requires "path" and either "content" or non-empty "edits".',
          'Provide "path" with target "content" or "edits" to diff.',
        ),
      )
    }
  } else if (action === 'replace') {
    if (!patternRes.value || replacementRes.value === undefined) {
      return formatFailure(
        toolName,
        invalidArgFailure(
          toolName,
          'Action "replace" requires non-empty "pattern" and "replacement".',
          'Provide "pattern" and "replacement" (plus optional "path", "glob", "regex", "dry_run").',
        ),
      )
    }
  } else if (action === 'batch') {
    if (!operations || operations.length === 0) {
      return formatFailure(
        toolName,
        invalidArgFailure(
          toolName,
          'Action "batch" requires a non-empty "operations" array.',
          'Provide one or more { op, path, to? } entries in "operations".',
        ),
      )
    }
  }

  const req: MutateRequest = {
    action,
    ...(pathRes.value !== undefined ? { path: pathRes.value } : {}),
    ...(contentRes.value !== undefined ? { content: contentRes.value } : {}),
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    ...(edits !== undefined ? { edits } : {}),
    ...(patternRes.value !== undefined ? { pattern: patternRes.value } : {}),
    ...(replacementRes.value !== undefined ? { replacement: replacementRes.value } : {}),
    ...(regexRes.value !== undefined ? { regex: regexRes.value } : {}),
    ...(globRes.value !== undefined ? { glob: globRes.value } : {}),
    ...(maxReplRes.value !== undefined ? { maxReplacements: maxReplRes.value } : {}),
    ...(operations !== undefined ? { operations } : {}),
    ...(dryRunRes.value !== undefined ? { dryRun: dryRunRes.value } : {}),
  }

  const outcome = await client.mutate(req)
  return formatMutate(outcome)
}

async function handleOpsReadDoc(
  client: OpsBackendClient,
  rawArgs: unknown,
): Promise<McpToolResult> {
  const toolName = 'pulse_read_doc'
  const checked = assertKnownArguments(toolName, rawArgs, READ_DOC_ALLOWED_KEYS)
  if (!checked.ok) return formatFailure(toolName, checked.failure)
  const { args } = checked

  const pathRes = optionalString(args, 'path', toolName)
  if (!pathRes.ok) return formatFailure(toolName, pathRes.failure)
  if (!pathRes.value || pathRes.value.trim().length === 0) {
    return formatFailure(
      toolName,
      invalidArgFailure(
        toolName,
        'Parameter "path" is required and must be a non-empty file path.',
        'Pass the path to a CSV/TSV, DOCX, or PDF file inside the workspace.',
      ),
    )
  }

  const formatRes = optionalEnum(args, 'format', toolName, [
    'auto',
    'table',
    'docx',
    'pdf',
  ] as const)
  if (!formatRes.ok) return formatFailure(toolName, formatRes.failure)

  const encodingRes = optionalEnum(args, 'encoding', toolName, [
    'utf-8',
    'utf-16le',
    'utf-16be',
  ] as const)
  if (!encodingRes.ok) return formatFailure(toolName, encodingRes.failure)

  const headerRes = optionalBoolean(args, 'header', toolName)
  if (!headerRes.ok) return formatFailure(toolName, headerRes.failure)

  const offsetRes = optionalNumber(args, 'offset', toolName, { min: 1, integer: true })
  if (!offsetRes.ok) return formatFailure(toolName, offsetRes.failure)

  const limitRes = optionalNumber(args, 'limit', toolName, { min: 1, integer: true })
  if (!limitRes.ok) return formatFailure(toolName, limitRes.failure)

  const req: ReadDocRequest = {
    path: pathRes.value,
    ...(formatRes.value !== undefined ? { format: formatRes.value } : {}),
    ...(encodingRes.value !== undefined ? { encoding: encodingRes.value } : {}),
    ...(headerRes.value !== undefined ? { header: headerRes.value } : {}),
    ...(offsetRes.value !== undefined ? { offset: offsetRes.value } : {}),
    ...(limitRes.value !== undefined ? { limit: limitRes.value } : {}),
  }

  const outcome = await client.readDoc(req)
  return formatReadDoc(outcome)
}

async function handleOpsExec(
  client: OpsBackendClient,
  rawArgs: unknown,
): Promise<McpToolResult> {
  const toolName = 'pulse_exec'
  const checked = assertKnownArguments(toolName, rawArgs, EXEC_ALLOWED_KEYS)
  if (!checked.ok) return formatFailure(toolName, checked.failure)
  const { args } = checked

  const descRes = optionalString(args, 'description', toolName)
  if (!descRes.ok) return formatFailure(toolName, descRes.failure)
  if (!descRes.value || descRes.value.trim().length === 0) {
    return formatFailure(
      toolName,
      invalidArgFailure(
        toolName,
        'Parameter "description" is required (4–10 words).',
        'Provide a concise "description" summarizing what this command does.',
      ),
    )
  }

  const cmdRes = optionalString(args, 'command', toolName)
  if (!cmdRes.ok) return formatFailure(toolName, cmdRes.failure)
  const scriptRes = optionalString(args, 'script_path', toolName)
  if (!scriptRes.ok) return formatFailure(toolName, scriptRes.failure)

  const hasCommand = cmdRes.value !== undefined && cmdRes.value.trim().length > 0
  const hasScript = scriptRes.value !== undefined && scriptRes.value.trim().length > 0

  if (hasCommand === hasScript) {
    return formatFailure(
      toolName,
      invalidArgFailure(
        toolName,
        hasCommand
          ? 'Parameters "command" and "script_path" are mutually exclusive.'
          : 'Either "command" or "script_path" is required.',
        'Specify either a non-empty "command" OR a workspace "script_path", not both.',
      ),
    )
  }

  const shellRes = optionalShell(args, toolName)
  if (!shellRes.ok) return formatFailure(toolName, shellRes.failure)

  const workdirRes = optionalString(args, 'workdir', toolName)
  if (!workdirRes.ok) return formatFailure(toolName, workdirRes.failure)

  const timeoutRes = optionalNumber(args, 'timeout_ms', toolName, { min: 1 })
  if (!timeoutRes.ok) return formatFailure(toolName, timeoutRes.failure)

  const bgRes = optionalBoolean(args, 'run_in_background', toolName)
  if (!bgRes.ok) return formatFailure(toolName, bgRes.failure)

  let env: Record<string, string> | undefined
  if (args.env !== undefined) {
    if (typeof args.env !== 'object' || args.env === null || Array.isArray(args.env)) {
      return formatFailure(
        toolName,
        invalidArgFailure(
          toolName,
          'Parameter "env" must be an object mapping variable names to strings.',
          'Pass a flat string map for "env", e.g. { "NODE_ENV": "test" }.',
        ),
      )
    }
    const cleanEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(args.env as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        return formatFailure(
          toolName,
          invalidArgFailure(
            toolName,
            `Environment variable "${k}" must be a string.`,
            `Convert "${k}" to a string and retry.`,
          ),
        )
      }
      cleanEnv[k] = v
    }
    env = cleanEnv
  }

  const req: ExecRequest = {
    description: descRes.value.trim(),
    ...(hasCommand ? { command: cmdRes.value } : {}),
    ...(hasScript ? { scriptPath: scriptRes.value } : {}),
    ...(shellRes.value !== undefined ? { shell: shellRes.value } : {}),
    ...(workdirRes.value !== undefined ? { workdir: workdirRes.value } : {}),
    ...(timeoutRes.value !== undefined ? { timeoutMs: timeoutRes.value } : {}),
    ...(bgRes.value !== undefined ? { runInBackground: bgRes.value } : {}),
    ...(env !== undefined ? { env } : {}),
    mirrorToActivity: true,
  }

  const outcome = await client.exec(req)
  return formatExecOutcome(outcome)
}

async function handleOpsJob(
  client: OpsBackendClient,
  rawArgs: unknown,
): Promise<McpToolResult> {
  const toolName = 'pulse_job'
  const checked = assertKnownArguments(toolName, rawArgs, JOB_ALLOWED_KEYS)
  if (!checked.ok) return formatFailure(toolName, checked.failure)
  const { args } = checked

  const actionRes = optionalEnum(args, 'action', toolName, [
    'list',
    'output',
    'input',
    'kill',
  ] as const)
  if (!actionRes.ok) return formatFailure(toolName, actionRes.failure)
  if (!actionRes.value) {
    return formatFailure(
      toolName,
      invalidArgFailure(
        toolName,
        'Parameter "action" is required ("list", "output", "input", or "kill").',
        'Pass a valid "action" value.',
      ),
    )
  }
  const action = actionRes.value

  if (action === 'list') {
    const jobs = await client.listJobs()
    return formatJobList(jobs)
  }

  const jobIdRes = optionalString(args, 'job_id', toolName)
  if (!jobIdRes.ok) return formatFailure(toolName, jobIdRes.failure)
  const jobId = jobIdRes.value?.trim()
  if (!jobId) {
    return formatFailure(
      toolName,
      invalidArgFailure(
        toolName,
        `Parameter "job_id" is required for action "${action}".`,
        'Call pulse_job({ action: "list" }) to find active job IDs.',
      ),
    )
  }

  if (action === 'output') {
    const stdoutOffset = optionalNumber(args, 'stdout_offset', toolName, {
      min: 0,
      integer: true,
    })
    if (!stdoutOffset.ok) return formatFailure(toolName, stdoutOffset.failure)

    const stderrOffset = optionalNumber(args, 'stderr_offset', toolName, {
      min: 0,
      integer: true,
    })
    if (!stderrOffset.ok) return formatFailure(toolName, stderrOffset.failure)

    const waitRes = optionalBoolean(args, 'wait', toolName)
    if (!waitRes.ok) return formatFailure(toolName, waitRes.failure)

    const waitTimeoutRes = optionalNumber(args, 'wait_timeout_ms', toolName, { min: 1 })
    if (!waitTimeoutRes.ok) return formatFailure(toolName, waitTimeoutRes.failure)

    const maxBytesRes = optionalNumber(args, 'max_bytes', toolName, {
      min: 1,
      integer: true,
    })
    if (!maxBytesRes.ok) return formatFailure(toolName, maxBytesRes.failure)

    const res = await client.jobOutput(jobId, {
      stdoutOffset: stdoutOffset.value,
      stderrOffset: stderrOffset.value,
      wait: waitRes.value,
      waitTimeoutMs: waitTimeoutRes.value,
      maxBytes: maxBytesRes.value,
    })
    return formatJobOutput(res)
  }

  if (action === 'input') {
    const inputRes = optionalString(args, 'input', toolName)
    if (!inputRes.ok) return formatFailure(toolName, inputRes.failure)
    if (inputRes.value === undefined) {
      return formatFailure(
        toolName,
        invalidArgFailure(
          toolName,
          'Parameter "input" is required for action "input".',
          'Provide text to send to stdin (e.g. "yes\\n").',
        ),
      )
    }
    const res = await client.jobInput(jobId, inputRes.value)
    return formatJobInput(res.jobId, res.bytesWritten, res.job)
  }

  const killRes = await client.jobKill(jobId)
  return formatJobKill(killRes.jobId, killRes.killed, killRes.job, killRes.note)
}

export interface McpClientInfo {
  name: string
  version?: string
}

const MCP_VERSION_FOR_STATS = '1.0.0'
const STATS_QUOTA_FAST_TIMEOUT_MS = 2_500

/**
 * MCP 2026-07-28 forward-compatibility: extracts `io.modelcontextprotocol/clientInfo`
 * from request `_meta` when legacy `initialize` clientInfo is absent.
 */
export function extractMetaClientInfo(params: unknown): McpClientInfo | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined
  const meta = (params as Record<string, unknown>)._meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const info = (meta as Record<string, unknown>)['io.modelcontextprotocol/clientInfo']
  if (!info || typeof info !== 'object' || Array.isArray(info)) return undefined
  const rec = info as Record<string, unknown>
  if (typeof rec.name !== 'string' || rec.name.trim().length === 0) return undefined
  return {
    name: rec.name.trim(),
    ...(typeof rec.version === 'string' && rec.version.trim().length > 0
      ? { version: rec.version.trim() }
      : {}),
  }
}

async function resolveStatsQuotas(
  client: OpsBackendClient,
  stateQuotas: QuotaSnapshot | null | undefined,
): Promise<QuotaSnapshot | null | undefined> {
  if (stateQuotas !== undefined && stateQuotas !== null) return stateQuotas
  if (!client.getQuotas) return stateQuotas
  try {
    return await Promise.race([
      client.getQuotas(false),
      new Promise<null>((resolve) => {
        const t = setTimeout(() => resolve(null), STATS_QUOTA_FAST_TIMEOUT_MS)
        t.unref()
      }),
    ])
  } catch {
    return stateQuotas ?? null
  }
}

async function handleOpsResult(
  client: OpsBackendClient,
  rawArgs: unknown,
  clientInfo?: McpClientInfo,
): Promise<McpToolResult> {
  const toolName = 'pulse_result'
  const checked = assertKnownArguments(toolName, rawArgs, RESULT_ALLOWED_KEYS)
  if (!checked.ok) return formatFailure(toolName, checked.failure)
  const { args } = checked

  const actionRes = optionalEnum(args, 'action', toolName, [
    'page',
    'release',
    'stats',
  ] as const)
  if (!actionRes.ok) return formatFailure(toolName, actionRes.failure)
  if (!actionRes.value) {
    return formatFailure(
      toolName,
      invalidArgFailure(
        toolName,
        'Parameter "action" is required ("page", "release", or "stats").',
        'Pass action: "page", "release", or "stats".',
      ),
    )
  }
  const action = actionRes.value

  if (action === 'stats') {
    const { state, sync } = await client.getState()
    const [quotas, hostHealth] = await Promise.all([
      resolveStatsQuotas(client, state.quotas),
      state.hostHealth !== undefined && state.hostHealth !== null
        ? Promise.resolve(state.hostHealth)
        : client.getHostHealth
          ? client.getHostHealth().catch(() => null)
          : Promise.resolve(null),
    ])
    return formatStats({
      telemetry: state.telemetry,
      shells: state.shells,
      config: state.config,
      sync: {
        ...sync,
        mcpVersion: MCP_VERSION_FOR_STATS,
        ...(clientInfo ? { clientInfo } : {}),
        sessionId: state.sessionId,
        workerAvailable: state.workerAvailable,
        workerPath: state.workerPath,
        dedupEntryCount: state.dedupEntryCount,
      },
      spills: state.spills,
      sessionId: state.sessionId,
      sessionScope: state.sessionScope,
      sessions: state.sessions,
      contextWindow: state.contextWindow,
      quotas,
      hostHealth,
      notices: state.notices,
      daemonVersion: state.daemonVersion ?? sync.version,
      mcpVersion: MCP_VERSION_FOR_STATS,
    })
  }

  const refIdRes = optionalString(args, 'ref_id', toolName)
  if (!refIdRes.ok) return formatFailure(toolName, refIdRes.failure)
  const refId = refIdRes.value?.trim()
  if (!refId) {
    return formatFailure(
      toolName,
      invalidArgFailure(
        toolName,
        `Parameter "ref_id" is required for action "${action}".`,
        'Provide the ref_id from `[Stored reference: refId=...]` or run pulse_result({ action: "stats" }) to list active spills.',
      ),
    )
  }

  if (action === 'release') {
    const released = await client.releaseResult(refId)
    return formatResultRelease(released.refId, released.released)
  }

  const offsetRes = optionalNumber(args, 'offset', toolName, { min: 1, integer: true })
  if (!offsetRes.ok) return formatFailure(toolName, offsetRes.failure)

  const limitRes = optionalNumber(args, 'limit', toolName, { min: 1, integer: true })
  if (!limitRes.ok) return formatFailure(toolName, limitRes.failure)

  const maxBytesRes = optionalNumber(args, 'max_bytes', toolName, {
    min: 1,
    integer: true,
  })
  if (!maxBytesRes.ok) return formatFailure(toolName, maxBytesRes.failure)

  const searchRes = optionalString(args, 'search', toolName)
  if (!searchRes.ok) return formatFailure(toolName, searchRes.failure)

  const caseInsensitiveRes = optionalBoolean(args, 'case_insensitive', toolName)
  if (!caseInsensitiveRes.ok) return formatFailure(toolName, caseInsensitiveRes.failure)

  const streamRes = optionalEnum(args, 'stream', toolName, [
    'stdout',
    'stderr',
    'combined',
  ] as const)
  if (!streamRes.ok) return formatFailure(toolName, streamRes.failure)

  const page = await client.pageResult({
    refId,
    offset: offsetRes.value,
    limit: limitRes.value,
    maxBytes: maxBytesRes.value,
    search: searchRes.value,
    caseInsensitive: caseInsensitiveRes.value,
    stream: streamRes.value,
  })
  return formatResultPage(page)
}

export async function handleToolCall(
  client: OpsBackendClient,
  name: string,
  rawArgs: unknown,
  opts?: { clientInfo?: McpClientInfo },
): Promise<McpToolResult> {
  try {
    switch (name) {
      case 'pulse_read_files':
        return await handleOpsReadFiles(client, rawArgs)
      case 'pulse_search':
        return await handleOpsSearch(client, rawArgs)
      case 'pulse_mutate':
        return await handleOpsMutate(client, rawArgs)
      case 'pulse_read_doc':
        return await handleOpsReadDoc(client, rawArgs)
      case 'pulse_exec':
        return await handleOpsExec(client, rawArgs)
      case 'pulse_job':
        return await handleOpsJob(client, rawArgs)
      case 'pulse_result':
        return await handleOpsResult(client, rawArgs, opts?.clientInfo)
      default:
        return formatFailure(name, {
          code: 'UNKNOWN_TOOL',
          message: `Unknown tool "${name}". Available: ${TOOL_DEFINITIONS.map((t) => t.name).join(', ')}.`,
          effectState: 'none',
          retry: 'after-input-change',
          nextAction: 'Invoke one of the 7 agy-pulse pulse_* tools.',
        })
    }
  } catch (err) {
    if (err instanceof TerminalClientError) {
      return formatFailure(name, err.failure)
    }
    const message = err instanceof Error ? err.message : String(err)
    return formatFailure(name, {
      code: 'TOOL_EXECUTION_ERROR',
      message,
      effectState: 'unknown',
      retry: 'after-input-change',
      nextAction:
        'Check the error and run pulse_result({ action: "stats" }) or pulse_job({ action: "list" }) before retrying.',
    })
  }
}

export function registerTools(
  server: Server,
  client: OpsBackendClient,
  opts?: { onClientInfo?: (info: McpClientInfo) => void },
): void {
  let fallbackMetaClientInfo: McpClientInfo | undefined

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params
    const legacy = server.getClientVersion()
    let effectiveClientInfo: McpClientInfo | undefined = legacy?.name
      ? { name: legacy.name, ...(legacy.version ? { version: legacy.version } : {}) }
      : undefined

    // MCP 2026-07-28 forward-compat: capture _meta["io.modelcontextprotocol/clientInfo"] when initialize is absent.
    const metaInfo = extractMetaClientInfo(request.params)
    if (!effectiveClientInfo && metaInfo) {
      fallbackMetaClientInfo = metaInfo
      effectiveClientInfo = metaInfo
      opts?.onClientInfo?.(metaInfo)
    } else if (!effectiveClientInfo && fallbackMetaClientInfo) {
      effectiveClientInfo = fallbackMetaClientInfo
    } else if (effectiveClientInfo) {
      opts?.onClientInfo?.(effectiveClientInfo)
    }

    return handleToolCall(client, name, rawArgs, { clientInfo: effectiveClientInfo })
  })
}
