import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDataDir } from '../shared/paths.ts'
import type { ActiveSessionBinding } from '../shared/types.ts'
import { buildWorkspaceSnapshot } from './snapshot.ts'

const TARGET_MCP_SERVER = 'agy-pulse_pulse'
const ACTIVE_SESSION_FILENAME = 'active-session.json'
const AUTHORIZED_WORKSPACES_FILENAME = 'authorized-workspaces.json'
const SESSION_TRANSCRIPTS_FILENAME = 'session-transcripts.json'
const AUTHORIZED_WORKSPACE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const AUTHORIZED_WORKSPACE_MAX_SESSIONS = 30
const SESSION_TRANSCRIPT_MAX_ENTRIES = 30
const AUTHORIZED_TOUCH_DEBOUNCE_MS = 5 * 60 * 1000 // 5 minutes

const MULTIMODAL_READ_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.svgz',
  '.tif',
  '.tiff',
  '.avif',
  '.heic',
  '.heif',
  '.mp4',
  '.mov',
  '.webm',
  '.mkv',
  '.avi',
  '.m4v',
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.flac',
  '.aac',
  '.pdf',
])

const DOC_READ_EXTENSIONS = new Set(['.csv', '.tsv', '.docx'])

const BUILTIN_READ_TOOLS = new Set(['read_file', 'view_file'])
const BUILTIN_EDIT_TOOLS = new Set([
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
])
const BUILTIN_WRITE_TOOLS = new Set(['write_file', 'write_to_file'])
const BUILTIN_COMMAND_TOOLS = new Set(['run_command'])

// Commands requiring Antigravity's executor-injected auth/RPC environment variables
// that are not present inside the Pulse sidecar daemon process.
const HOST_ENV_COMMAND_RE =
  /\b(?:AGY_ACCOUNT=|ANTIGRAVITY_CSRF_TOKEN|ANTIGRAVITY_LS_ADDRESS)\b/

// Simple git status / git diff invocations that should route to pulse_search.
const PURE_GIT_INSPECT_RE =
  /^\s*git(?:\.exe)?\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)?(?:status|diff)\b[^;&|\n]*$/i

interface HookToolCall {
  id?: unknown
  name?: unknown
  args?: Record<string, unknown> | null
}

interface HookStdinPayload {
  conversationId?: unknown
  workspacePaths?: unknown
  workspace_paths?: unknown
  workspaceRoots?: unknown
  workspace_roots?: unknown
  artifactDirectoryPath?: unknown
  artifact_directory_path?: unknown
  transcriptPath?: unknown
  transcript_path?: unknown
  cwd?: unknown
  hookEventName?: unknown
  hook_event_name?: unknown
  toolCall?: HookToolCall | null
}

interface ToolGuardDecision {
  decision: 'allow' | 'deny'
  reason?: string
  overwrite?: Record<string, unknown>
}

interface AuthorizedWorkspaceEntry {
  workspacePaths: string[]
  updatedAt: number
}

interface AuthorizedWorkspacesRegistry {
  version: 1
  sessions: Record<string, AuthorizedWorkspaceEntry>
}

interface SessionTranscriptEntry {
  transcriptPath: string
  updatedAt: number
}

interface SessionTranscriptsRegistry {
  version: 1
  sessions: Record<string, SessionTranscriptEntry>
}

async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: string[] = []
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
  }
  return chunks.join('')
}

function writeAndExit(payload: string): void {
  let exited = false
  const done = () => {
    if (exited) return
    exited = true
    process.exit(0)
  }
  const failsafe = setTimeout(done, 150)
  failsafe.unref()
  process.stdout.on('error', done)
  try {
    process.stdout.write(payload, done)
  } catch {
    done()
  }
}

function pickString(obj: Record<string, unknown> | null | undefined, keys: string[]): string {
  if (!obj || typeof obj !== 'object') return ''
  for (const key of keys) {
    const val = obj[key]
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim()
    }
  }
  return ''
}

function extractWorkspacePaths(parsed: HookStdinPayload | null): string[] {
  const candidates = [
    parsed?.workspacePaths,
    parsed?.workspace_paths,
    parsed?.workspaceRoots,
    parsed?.workspace_roots,
  ]
  for (const list of candidates) {
    if (Array.isArray(list)) {
      const cleaned = list.filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
      )
      if (cleaned.length > 0) return cleaned
    }
  }
  if (typeof parsed?.cwd === 'string' && parsed.cwd.trim().length > 0) {
    return [parsed.cwd.trim()]
  }
  return []
}

function normalizeComparablePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function isSafeRegistryWorkspaceRoot(rawPath: string): boolean {
  const normalized = normalizeInputPath(rawPath)
  if (!normalized) return false
  const parsed = path.parse(normalized)
  // Refuse filesystem roots like `/` or `C:\`.
  if (normalized === parsed.root) return false
  // Refuse user home directory as a broad multi-project root.
  const home = normalizeInputPath(homedir())
  if (home && normalizeComparablePath(normalized) === normalizeComparablePath(home)) {
    return false
  }
  const comp = normalizeComparablePath(normalized)
  if (
    comp.endsWith('/sidecars/pulse') ||
    comp.endsWith('/sidecars/pulse/dist') ||
    comp.endsWith('/plugins/agy-pulse')
  ) {
    return false
  }
  return true
}

function normalizeInputPath(rawPath: string, baseDir?: string): string {
  let trimmed = rawPath.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('file://')) {
    try {
      trimmed = fileURLToPath(trimmed)
    } catch {
      trimmed = trimmed.slice(7)
    }
  }
  if (process.platform === 'win32') {
    const msys = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(trimmed)
    if (msys) {
      const drive = msys[1].toUpperCase()
      const rest = (msys[2] ?? '').replace(/\//g, '\\')
      trimmed = `${drive}:\\${rest}`
    }
  }
  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : baseDir
      ? path.resolve(baseDir, trimmed)
      : path.resolve(trimmed)

  const realpathFn =
    typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync

  try {
    return realpathFn(resolved)
  } catch {
    const trailing: string[] = []
    let current = resolved
    while (true) {
      const parent = path.dirname(current)
      if (parent === current) return resolved
      trailing.unshift(path.basename(current))
      current = parent
      if (existsSync(current)) {
        try {
          return path.join(realpathFn(current), ...trailing)
        } catch {
          return resolved
        }
      }
    }
  }
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  if (!candidatePath || !rootPath) return false
  const normCandidate =
    process.platform === 'win32' ? candidatePath.toLowerCase() : candidatePath
  const normRoot = process.platform === 'win32' ? rootPath.toLowerCase() : rootPath
  if (normCandidate === normRoot) return true
  const rel = path.relative(normRoot, normCandidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function isPathInsideAnyRoot(
  rawPath: string,
  roots: string[],
  baseDir?: string,
): boolean {
  if (!rawPath || roots.length === 0) return false
  const candidate = normalizeInputPath(rawPath, baseDir)
  if (!candidate) return false
  for (const root of roots) {
    if (!root || root.trim().length === 0) continue
    const normRoot = normalizeInputPath(root)
    if (isPathInsideRoot(candidate, normRoot)) {
      return true
    }
  }
  return false
}

function isSamePath(rawA: string, rawB: string, baseDir?: string): boolean {
  if (!rawA || !rawB) return false
  const a = normalizeInputPath(rawA, baseDir)
  const b = normalizeInputPath(rawB)
  if (!a || !b) return false
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b
}

function sameWorkspaceList(a: string[] | undefined, b: string[] | undefined): boolean {
  const listA = (a ?? []).map(normalizeComparablePath).filter(Boolean)
  const listB = (b ?? []).map(normalizeComparablePath).filter(Boolean)
  if (listA.length !== listB.length) return false
  for (let i = 0; i < listA.length; i++) {
    if (listA[i] !== listB[i]) return false
  }
  return true
}

function writeJsonAtomic(filePath: string, data: unknown): boolean {
  const dir = path.dirname(filePath)
  const tmpPath = path.join(
    dir,
    `${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
  )
  const payload = `${JSON.stringify(data)}\n`
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmpPath, filePath)
    return true
  } catch {
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      // Ignore best-effort temp file cleanup failures.
    }
    try {
      writeFileSync(filePath, payload, { encoding: 'utf8', mode: 0o600 })
      return true
    } catch {
      return false
    }
  }
}

function readActiveSessionBindingRaw(dataDir: string): Partial<ActiveSessionBinding> | null {
  const targetPath = path.join(dataDir, ACTIVE_SESSION_FILENAME)
  try {
    if (!existsSync(targetPath)) return null
    const parsed = JSON.parse(readFileSync(targetPath, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Partial<ActiveSessionBinding>) : null
  } catch {
    return null
  }
}

function writeActiveSessionAtomic(binding: ActiveSessionBinding): boolean {
  const dataDir = resolveDataDir()
  return writeJsonAtomic(path.join(dataDir, ACTIVE_SESSION_FILENAME), binding)
}

function readAuthorizedWorkspacesRegistry(dataDir: string): AuthorizedWorkspacesRegistry {
  const targetPath = path.join(dataDir, AUTHORIZED_WORKSPACES_FILENAME)
  try {
    if (!existsSync(targetPath)) {
      return { version: 1, sessions: {} }
    }
    const parsed = JSON.parse(readFileSync(targetPath, 'utf8')) as Partial<AuthorizedWorkspacesRegistry>
    if (parsed && parsed.sessions && typeof parsed.sessions === 'object') {
      return { version: 1, sessions: { ...parsed.sessions } }
    }
  } catch {
    // Ignore malformed registry; rebuild on next write.
  }
  return { version: 1, sessions: {} }
}

function recordAuthorizedWorkspaces(
  dataDir: string,
  conversationId: string,
  workspacePaths: string[],
  now = Date.now(),
): boolean {
  const safeRoots = workspacePaths.filter(isSafeRegistryWorkspaceRoot)
  if (safeRoots.length === 0) return false
  const sessionKey = conversationId.trim() || 'default'

  const registry = readAuthorizedWorkspacesRegistry(dataDir)
  const existing = registry.sessions[sessionKey]
  if (
    existing &&
    sameWorkspaceList(existing.workspacePaths, safeRoots) &&
    typeof existing.updatedAt === 'number' &&
    now - existing.updatedAt < AUTHORIZED_TOUCH_DEBOUNCE_MS
  ) {
    return true
  }

  // Prune expired sessions, drop deleted directories, and cap at AUTHORIZED_WORKSPACE_MAX_SESSIONS.
  const entries: Array<[string, AuthorizedWorkspaceEntry]> = []
  for (const [key, entry] of Object.entries(registry.sessions)) {
    if (
      key === sessionKey ||
      !entry ||
      typeof entry.updatedAt !== 'number' ||
      now - entry.updatedAt > AUTHORIZED_WORKSPACE_MAX_AGE_MS ||
      !Array.isArray(entry.workspacePaths) ||
      entry.workspacePaths.length === 0
    ) {
      continue
    }
    const livePaths = entry.workspacePaths.filter(
      (p) => typeof p === 'string' && isSafeRegistryWorkspaceRoot(p) && existsSync(p),
    )
    if (livePaths.length === 0) continue
    entries.push([key, { workspacePaths: livePaths, updatedAt: entry.updatedAt }])
  }
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
  const kept = entries.slice(0, AUTHORIZED_WORKSPACE_MAX_SESSIONS - 1)
  const nextSessions: Record<string, AuthorizedWorkspaceEntry> = Object.fromEntries(kept)
  nextSessions[sessionKey] = {
    workspacePaths: safeRoots,
    updatedAt: now,
  }

  return writeJsonAtomic(path.join(dataDir, AUTHORIZED_WORKSPACES_FILENAME), {
    version: 1,
    sessions: nextSessions,
  } satisfies AuthorizedWorkspacesRegistry)
}

function readSessionTranscriptsRegistry(dataDir: string): SessionTranscriptsRegistry {
  const targetPath = path.join(dataDir, SESSION_TRANSCRIPTS_FILENAME)
  try {
    if (!existsSync(targetPath)) {
      return { version: 1, sessions: {} }
    }
    const parsed = JSON.parse(readFileSync(targetPath, 'utf8')) as Partial<SessionTranscriptsRegistry>
    if (parsed && parsed.sessions && typeof parsed.sessions === 'object') {
      return { version: 1, sessions: { ...parsed.sessions } }
    }
  } catch {
    // Ignore malformed registry; rebuild on next write.
  }
  return { version: 1, sessions: {} }
}

function recordSessionTranscript(
  dataDir: string,
  conversationId: string,
  transcriptPath: string,
  now = Date.now(),
): void {
  const sessionKey = conversationId.trim()
  const cleanTranscript = transcriptPath.trim()
  if (!sessionKey || !cleanTranscript) return

  const registry = readSessionTranscriptsRegistry(dataDir)
  const existing = registry.sessions[sessionKey]
  if (
    existing &&
    existing.transcriptPath === cleanTranscript &&
    typeof existing.updatedAt === 'number' &&
    now - existing.updatedAt < AUTHORIZED_TOUCH_DEBOUNCE_MS
  ) {
    return
  }

  const entries: Array<[string, SessionTranscriptEntry]> = []
  for (const [key, entry] of Object.entries(registry.sessions)) {
    if (
      key === sessionKey ||
      !entry ||
      typeof entry.transcriptPath !== 'string' ||
      entry.transcriptPath.trim().length === 0 ||
      typeof entry.updatedAt !== 'number'
    ) {
      continue
    }
    entries.push([key, { transcriptPath: entry.transcriptPath.trim(), updatedAt: entry.updatedAt }])
  }
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
  const kept = entries.slice(0, SESSION_TRANSCRIPT_MAX_ENTRIES - 1)
  const nextSessions: Record<string, SessionTranscriptEntry> = Object.fromEntries(kept)
  nextSessions[sessionKey] = {
    transcriptPath: cleanTranscript,
    updatedAt: now,
  }

  writeJsonAtomic(path.join(dataDir, SESSION_TRANSCRIPTS_FILENAME), {
    version: 1,
    sessions: nextSessions,
  } satisfies SessionTranscriptsRegistry)
}

function getAuthorizedRootsFromDisk(dataDir: string): string[] {
  const roots: string[] = []
  const active = readActiveSessionBindingRaw(dataDir)
  if (Array.isArray(active?.workspacePaths)) {
    roots.push(...active.workspacePaths)
  }
  const registry = readAuthorizedWorkspacesRegistry(dataDir)
  const now = Date.now()
  for (const entry of Object.values(registry.sessions)) {
    if (
      entry &&
      typeof entry.updatedAt === 'number' &&
      now - entry.updatedAt <= AUTHORIZED_WORKSPACE_MAX_AGE_MS &&
      Array.isArray(entry.workspacePaths)
    ) {
      roots.push(...entry.workspacePaths)
    }
  }
  return roots
}

function normalizeToolName(rawName: unknown): string {
  if (typeof rawName !== 'string') return ''
  return rawName
    .trim()
    .toLowerCase()
    .replace(/^cortex_step_type_/, '')
}

/**
 * Anti-deadlock check #1: verify that the plugin's `mcp_config.json` (when resolvable)
 * has neither disabled the `pulse` MCP server nor set the target tool to `eager: true`
 * (which Antigravity can evict and disable under multi-plugin context budgets).
 */
function isPulseTargetSafeForGuard(targetTool: string): boolean {
  const candidates: string[] = []
  if (process.env.PLUGIN_ROOT) candidates.push(path.join(process.env.PLUGIN_ROOT, 'mcp_config.json'))
  if (process.env.AGY_PLUGIN_ROOT) {
    candidates.push(path.join(process.env.AGY_PLUGIN_ROOT, 'mcp_config.json'))
  }
  try {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url))
    candidates.push(path.resolve(scriptDir, '..', '..', '..', 'mcp_config.json'))
  } catch {
    // Ignore import.meta.url edge cases.
  }

  for (const cfgPath of candidates) {
    if (!existsSync(cfgPath)) continue
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
        mcpServers?: {
          pulse?: {
            disabled?: boolean
            tools?: Record<string, { eager?: boolean; disabled?: boolean }>
          }
        }
      }
      const pulse = parsed?.mcpServers?.pulse
      if (!pulse || pulse.disabled === true) return false
      const toolCfg = pulse.tools?.[targetTool]
      if (toolCfg?.disabled === true) return false
      // Guard must fail-open if the target tool is marked eager:true to avoid Antigravity eviction deadlocks.
      if (toolCfg?.eager === true) return false
      return true
    } catch {
      return false
    }
  }
  // If mcp_config.json isn't adjacent (e.g. standalone unit test invocation), assume active.
  return true
}

/**
 * Anti-deadlock check #2 (multi-project safety):
 * If `active-session.json` exists on disk and points to ANOTHER project (because the user
 * switched conversations or runs multiple workspaces in parallel), immediately self-heal
 * `active-session.json` + `authorized-workspaces.json` so the redirected `pulse_*` call
 * will succeed without `FILE_OUTSIDE_WORKSPACE` / `WORKDIR_OUTSIDE_WORKSPACE`.
 * If self-healing fails and the current workspace is still unauthorized on disk, fail-open.
 */
function ensureWorkspaceAuthorizedForPulse(
  parsed: HookStdinPayload | null,
  workspacePaths: string[],
): boolean {
  if (workspacePaths.length === 0) return false
  const dataDir = resolveDataDir()
  const existingActive = readActiveSessionBindingRaw(dataDir)
  // If no active-session.json exists yet (fresh/test env), do zero disk I/O and proceed normally.
  if (!existingActive) return true

  const activeRoots = Array.isArray(existingActive.workspacePaths)
    ? existingActive.workspacePaths
    : []
  const currentPrimary = workspacePaths[0]
  const activeCoversCurrent = isPathInsideAnyRoot(currentPrimary, activeRoots)
  if (activeCoversCurrent) {
    return true
  }

  // Another project overwrote active-session.json; update both active binding and registry.
  const convId =
    typeof parsed?.conversationId === 'string' && parsed.conversationId.trim().length > 0
      ? parsed.conversationId.trim()
      : 'default'
  const transcriptPath = pickString(parsed as Record<string, unknown> | null, [
    'transcriptPath',
    'transcript_path',
  ])
  const now = Date.now()
  const healedActive = writeActiveSessionAtomic({
    conversationId: convId,
    updatedAt: now,
    workspacePaths,
    ...(transcriptPath ? { transcriptPath } : {}),
  })
  recordAuthorizedWorkspaces(dataDir, convId, workspacePaths, now)
  if (transcriptPath && convId !== 'default') {
    recordSessionTranscript(dataDir, convId, transcriptPath, now)
  }
  if (healedActive) return true

  // Fallback check: maybe the registry already authorizes this workspace.
  const diskRoots = getAuthorizedRootsFromDisk(dataDir)
  return isPathInsideAnyRoot(currentPrimary, diskRoots)
}

function denyIfPulseSafe(
  targetTool: string,
  reason: string,
  parsed: HookStdinPayload | null,
  workspacePaths: string[],
): ToolGuardDecision {
  if (!isPulseTargetSafeForGuard(targetTool)) {
    return { decision: 'allow' }
  }
  if (!ensureWorkspaceAuthorizedForPulse(parsed, workspacePaths)) {
    return { decision: 'allow' }
  }
  return { decision: 'deny', reason }
}

const SWARM_SKIP_INJECT_RE = /^(?:monitor|narrator)(?:-\d+)?$/i

function resolvePulseCliScriptPath(): string {
  const candidates: string[] = []
  if (process.env.PLUGIN_ROOT) {
    candidates.push(path.join(process.env.PLUGIN_ROOT, 'sidecars', 'pulse', 'dist', 'mcp-server.mjs'))
  }
  if (process.env.AGY_PLUGIN_ROOT) {
    candidates.push(
      path.join(process.env.AGY_PLUGIN_ROOT, 'sidecars', 'pulse', 'dist', 'mcp-server.mjs'),
    )
  }
  try {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url))
    candidates.push(path.join(scriptDir, 'mcp-server.mjs'))
    candidates.push(
      path.resolve(scriptDir, '..', '..', 'sidecars', 'pulse', 'dist', 'mcp-server.mjs'),
    )
  } catch {
    // Ignore import.meta.url edge cases.
  }
  const geminiHome = process.env.GEMINI_HOME?.trim() || path.join(homedir(), '.gemini')
  const defaultInstalled = path.join(
    geminiHome,
    'config',
    'plugins',
    'agy-pulse',
    'sidecars',
    'pulse',
    'dist',
    'mcp-server.mjs',
  )
  candidates.push(defaultInstalled)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return defaultInstalled
}

function evaluateBuiltinToolGuard(
  parsed: HookStdinPayload | null,
  workspacePaths: string[],
): ToolGuardDecision | null {
  const toolName = normalizeToolName(parsed?.toolCall?.name)
  if (!toolName) return null

  const isSwarm = toolName === 'swarm'
  const isRead = BUILTIN_READ_TOOLS.has(toolName)
  const isEdit = BUILTIN_EDIT_TOOLS.has(toolName)
  const isWrite = BUILTIN_WRITE_TOOLS.has(toolName)
  const isCommand = BUILTIN_COMMAND_TOOLS.has(toolName)
  if (!isSwarm && !isRead && !isEdit && !isWrite && !isCommand) {
    return null
  }

  if (process.env.AGY_PULSE_DISABLE_TOOL_GUARD === '1') {
    return { decision: 'allow' }
  }

  // Without an active workspace root, pulse_* tools cannot resolve a workspace jail; fail-open.
  if (workspacePaths.length === 0) {
    return { decision: 'allow' }
  }

  const args =
    parsed?.toolCall?.args && typeof parsed.toolCall.args === 'object'
      ? parsed.toolCall.args
      : {}

  if (isSwarm) {
    if (args.action !== 'add') {
      return { decision: 'allow' }
    }
    const brief = typeof args.brief === 'string' ? args.brief : ''
    const workerName = typeof args.name === 'string' ? args.name.trim() : ''
    if (!brief.trim() || !workerName) {
      return { decision: 'allow' }
    }
    if (SWARM_SKIP_INJECT_RE.test(workerName)) {
      return { decision: 'allow' }
    }
    if (brief.includes('[agy-pulse swarm]') || brief.includes('--cli')) {
      return { decision: 'allow' }
    }
    const primaryWorkspace = workspacePaths[0]?.trim()
    if (!primaryWorkspace) {
      return { decision: 'allow' }
    }
    const cliScriptPath = resolvePulseCliScriptPath()
    const tip = `[agy-pulse swarm] Swarm workers do not receive MCP tools. For large file outlines/symbols, searches, or verbose builds/tests, prefer CLI mode via run_command: node "${cliScriptPath}" --cli <outline|read|search|mutate|exec|result> --cwd "${primaryWorkspace}" --session "swarm-${workerName}" (use --stdin for JSON payloads; keep built-in read_file/edit_file for tiny <1KB files).`
    return {
      decision: 'allow',
      overwrite: {
        brief: `${brief}\n\n${tip}`,
      },
    }
  }
  const baseCwd =
    typeof parsed?.cwd === 'string' && parsed.cwd.trim().length > 0
      ? parsed.cwd.trim()
      : workspacePaths[0]
  const artifactDir = pickString(parsed as Record<string, unknown> | null, [
    'artifactDirectoryPath',
    'artifact_directory_path',
  ])
  const transcriptPath = pickString(parsed as Record<string, unknown> | null, [
    'transcriptPath',
    'transcript_path',
  ])

  if (isRead) {
    const rawPath = pickString(args, ['Path', 'AbsolutePath', 'path', 'file_path'])
    if (!rawPath) return { decision: 'allow' }
    if (artifactDir && isPathInsideAnyRoot(rawPath, [artifactDir], baseCwd)) {
      return { decision: 'allow' }
    }
    if (transcriptPath && isSamePath(rawPath, transcriptPath, baseCwd)) {
      return { decision: 'allow' }
    }
    if (!isPathInsideAnyRoot(rawPath, workspacePaths, baseCwd)) {
      return { decision: 'allow' }
    }
    const ext = path.extname(rawPath).toLowerCase()
    if (MULTIMODAL_READ_EXTENSIONS.has(ext)) {
      return { decision: 'allow' }
    }
    if (DOC_READ_EXTENSIONS.has(ext)) {
      return denyIfPulseSafe(
        'pulse_read_doc',
        `agy-pulse guard: workspace document must use call_mcp_tool({ ServerName: "agy-pulse_pulse", ToolName: "pulse_read_doc", Arguments: { path: ${JSON.stringify(rawPath)} } }) instead of built-in read_file.`,
        parsed,
        workspacePaths,
      )
    }
    return denyIfPulseSafe(
      'pulse_read_files',
      `agy-pulse guard: workspace file is inside the active workspace. Use call_mcp_tool({ ServerName: "agy-pulse_pulse", ToolName: "pulse_read_files", Arguments: { files: [{ path: ${JSON.stringify(rawPath)} }] } }) (supports batch 1-32 files, view:"outline", symbol, offset/limit, and dedup) instead of built-in read_file.`,
      parsed,
      workspacePaths,
    )
  }

  if (isEdit || isWrite) {
    if (args.ArtifactMetadata != null) {
      return { decision: 'allow' }
    }
    if (isWrite && args.Append === true) {
      return { decision: 'allow' }
    }
    const rawPath = pickString(args, ['Path', 'TargetFile', 'path', 'file_path'])
    if (!rawPath) return { decision: 'allow' }
    if (artifactDir && isPathInsideAnyRoot(rawPath, [artifactDir], baseCwd)) {
      return { decision: 'allow' }
    }
    if (!isPathInsideAnyRoot(rawPath, workspacePaths, baseCwd)) {
      return { decision: 'allow' }
    }
    if (isEdit) {
      return denyIfPulseSafe(
        'pulse_mutate',
        `agy-pulse guard: workspace edits must use call_mcp_tool({ ServerName: "agy-pulse_pulse", ToolName: "pulse_mutate", Arguments: { action: "edit", path: ${JSON.stringify(rawPath)}, edits: [{ old_text, new_text }] } }) instead of built-in edit_file.`,
        parsed,
        workspacePaths,
      )
    }
    return denyIfPulseSafe(
      'pulse_mutate',
      `agy-pulse guard: workspace writes must use call_mcp_tool({ ServerName: "agy-pulse_pulse", ToolName: "pulse_mutate", Arguments: { action: "write", path: ${JSON.stringify(rawPath)}, content: "..." } }) instead of built-in write_file.`,
      parsed,
      workspacePaths,
    )
  }

  if (args.IsDaemon === true) {
    return { decision: 'allow' }
  }
  const cmdCwd = pickString(args, ['Cwd', 'cwd'])
  if (cmdCwd && !isPathInsideAnyRoot(cmdCwd, workspacePaths, baseCwd)) {
    return { decision: 'allow' }
  }
  const commandLine = pickString(args, ['CommandLine', 'command'])
  if (commandLine && HOST_ENV_COMMAND_RE.test(commandLine)) {
    return { decision: 'allow' }
  }
  const targetWorkdir = cmdCwd || baseCwd
  if (commandLine && PURE_GIT_INSPECT_RE.test(commandLine)) {
    return denyIfPulseSafe(
      'pulse_search',
      `agy-pulse guard: use call_mcp_tool({ ServerName: "agy-pulse_pulse", ToolName: "pulse_search", Arguments: { action: "git_status", path: ${JSON.stringify(targetWorkdir)} } }) (or "git_diff") instead of built-in run_command.`,
      parsed,
      workspacePaths,
    )
  }
  return denyIfPulseSafe(
    'pulse_exec',
    `agy-pulse guard: use call_mcp_tool({ ServerName: "agy-pulse_pulse", ToolName: "pulse_exec", Arguments: { description: "...", command: "...", workdir: ${JSON.stringify(targetWorkdir)} } }) instead of built-in run_command. Use run_in_background:true for long jobs (or IsDaemon:true on run_command only for persistent dev servers).`,
    parsed,
    workspacePaths,
  )
}

async function main(): Promise<void> {
  const pretoolModeHint = process.env.AGY_PULSE_HOOK_MODE === 'pretool-guard'
  const failOpenFallback = pretoolModeHint ? '{"decision":"allow"}\n' : '{}\n'

  let raw = ''
  try {
    raw = await readStdinText()
  } catch {
    writeAndExit(failOpenFallback)
    return
  }

  let parsed: HookStdinPayload | null = null
  if (raw.trim().length > 0) {
    try {
      const candidate: unknown = JSON.parse(raw)
      if (candidate && typeof candidate === 'object') {
        parsed = candidate as HookStdinPayload
      }
    } catch {
      // Fail open on malformed JSON.
      const looksPreToolUse = pretoolModeHint || raw.includes('"PreToolUse"')
      writeAndExit(looksPreToolUse ? '{"decision":"allow"}\n' : '{}\n')
      return
    }
  }

  const hookEventName =
    typeof parsed?.hookEventName === 'string'
      ? parsed.hookEventName
      : typeof parsed?.hook_event_name === 'string'
        ? parsed.hook_event_name
        : ''
  const isPreToolUse = hookEventName === 'PreToolUse' || (pretoolModeHint && !hookEventName)
  const isSessionStart = hookEventName === 'SessionStart'
  const isPreInvocation = hookEventName === 'PreInvocation'

  const workspacePaths = extractWorkspacePaths(parsed)
  const rawConversationId =
    typeof parsed?.conversationId === 'string'
      ? parsed.conversationId.trim()
      : ''
  const transcriptPath = pickString(parsed as Record<string, unknown> | null, [
    'transcriptPath',
    'transcript_path',
  ])
  const dataDir = resolveDataDir()

  if (isPreToolUse) {
    const guardDecision = evaluateBuiltinToolGuard(parsed, workspacePaths)
    if (guardDecision) {
      if (rawConversationId && transcriptPath) {
        try {
          recordSessionTranscript(dataDir, rawConversationId, transcriptPath)
        } catch {
          // Fail-open.
        }
      }
      writeAndExit(`${JSON.stringify(guardDecision)}\n`)
      return
    }

    const args = parsed?.toolCall?.args
    const serverName =
      args && typeof args === 'object' ? args.ServerName : undefined
    if (
      typeof serverName === 'string' &&
      serverName.length > 0 &&
      serverName !== TARGET_MCP_SERVER
    ) {
      // Zero disk I/O fast path for unrelated MCP servers.
      writeAndExit('{"decision":"allow"}\n')
      return
    }
  }

  if (rawConversationId.length > 0) {
    const toolCallId =
      typeof parsed?.toolCall?.id === 'string' &&
      parsed.toolCall.id.trim().length > 0
        ? parsed.toolCall.id.trim()
        : undefined

    const now = Date.now()
    const existing = readActiveSessionBindingRaw(dataDir)
    const effectiveTranscriptPath =
      transcriptPath ||
      (existing?.conversationId === rawConversationId &&
      typeof existing.transcriptPath === 'string' &&
      existing.transcriptPath.trim().length > 0
        ? existing.transcriptPath.trim()
        : '')

    let shouldWriteActive = true
    if (isPreInvocation) {
      // On PreInvocation, skip rewriting active-session.json when conversation, workspaces, and transcript are unchanged.
      if (
        existing &&
        existing.conversationId === rawConversationId &&
        sameWorkspaceList(existing.workspacePaths, workspacePaths) &&
        (existing.transcriptPath ?? '') === effectiveTranscriptPath
      ) {
        shouldWriteActive = false
      }
    }

    if (shouldWriteActive) {
      const binding: ActiveSessionBinding = {
        conversationId: rawConversationId,
        updatedAt: now,
        ...(workspacePaths.length > 0 ? { workspacePaths } : {}),
        ...(effectiveTranscriptPath ? { transcriptPath: effectiveTranscriptPath } : {}),
        ...(toolCallId ? { toolCallId } : {}),
      }
      try {
        writeActiveSessionAtomic(binding)
      } catch {
        // Fail-open: never block Antigravity hook execution.
      }
    }

    if (transcriptPath) {
      try {
        recordSessionTranscript(dataDir, rawConversationId, transcriptPath, now)
      } catch {
        // Fail-open.
      }
    }

    if (workspacePaths.length > 0) {
      try {
        recordAuthorizedWorkspaces(dataDir, rawConversationId, workspacePaths, now)
      } catch {
        // Fail-open: never block Antigravity hook execution.
      }
    }
  } else if (isPreInvocation && workspacePaths.length > 0) {
    try {
      recordAuthorizedWorkspaces(dataDir, 'default', workspacePaths)
    } catch {
      // Fail-open.
    }
  }

  if (isPreToolUse) {
    writeAndExit('{"decision":"allow"}\n')
    return
  }

  // On SessionStart, inject a compact (<1.5 KB, <=250 ms) workspace orientation snapshot.
  if (isSessionStart && workspacePaths.length > 0 && process.env.AGY_PULSE_DISABLE_SNAPSHOT !== '1') {
    try {
      const snapshot = await buildWorkspaceSnapshot(workspacePaths[0])
      if (snapshot) {
        const response = {
          injectSteps: [
            {
              systemMessage: {
                systemMessage: snapshot,
              },
            },
          ],
        }
        writeAndExit(`${JSON.stringify(response)}\n`)
        return
      }
    } catch {
      // Fail-open: return empty JSON if snapshot generation fails.
    }
  }

  writeAndExit('{}\n')
}

void main().catch(() => {
  const pretoolModeHint = process.env.AGY_PULSE_HOOK_MODE === 'pretool-guard'
  writeAndExit(pretoolModeHint ? '{"decision":"allow"}\n' : '{}\n')
})
