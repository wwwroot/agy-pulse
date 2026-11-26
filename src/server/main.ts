import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { WebSocket, WebSocketServer } from 'ws'
import { resolveDataDir } from '../shared/paths.ts'
import type {
  ConversationContextUsage,
  ExecRequest,
  HostHealthSnapshot,
  JobSummary,
  MutateRequest,
  QuotaSnapshot,
  ReadDocRequest,
  ReadFilesRequest,
  ResultPageRequest,
  SearchRequest,
  SidecarNotice,
  SidecarStateSnapshot,
  TerminalConfig,
  WsClientMessage,
  WsServerMessage,
} from '../shared/types.ts'
import { ConfigStore } from './config.ts'
import { readConversationContextUsage, resolveTranscriptFilePath } from './context-window.ts'
import { DaemonDiscoveryManager } from './daemon-discovery.ts'
import { ExecEngine } from './exec-engine.ts'
import { inspectAntigravityHostHealth, repairAntigravityHostConfig } from './host-health.ts'
import { JobManager } from './job-manager.ts'
import { OpsEngine } from './ops-engine.ts'
import { AntigravityQuotaReader } from './quota-reader.ts'
import { RustWorker } from './rust-worker.ts'
import {
  SessionManager,
  type SessionAckEvent,
  type SessionActivityEvent,
  type SessionTelemetryEvent,
} from './session-manager.ts'
import { ShellDiscovery } from './shells.ts'
import { SpillStore } from './spill-store.ts'
import { readJsonBody, ServerError, writeError, writeJson, writeOk } from './wire.ts'
import { isRealPathWithin, resolveWorkspaceRoots, uriToFsPath } from './workspace.ts'

const execFileAsync = promisify(execFile)

const SNAPSHOT_VERSION = 1
const DAEMON_VERSION = '1.0.0'
const BIND_HOST = '127.0.0.1'
const PORT = (() => {
  const raw = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT?.trim()
  if (!raw) return 0
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
})()
// Always enforce a non-empty bearer token even in standalone mode so local browser
// tabs cannot invoke /api/exec or /api/pulse/* without authenticating via daemon.json.
const UI_TOKEN =
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN?.trim() || randomBytes(24).toString('hex')

const DIST_DIR = dirname(fileURLToPath(import.meta.url))
const SIDECAR_DIR = dirname(DIST_DIR)
const PLUGIN_DIR = dirname(dirname(SIDECAR_DIR))
const DATA_DIR = resolveDataDir()

function resolveGlobalDownloadsDir(): string {
  const override = process.env.PULSE_DOWNLOADS_DIR?.trim()
  if (override) return pathResolve(override)
  const home = homedir()
  if (process.platform === 'linux') {
    const envDir = process.env.XDG_DOWNLOAD_DIR?.trim()
    if (envDir) return pathResolve(envDir.replace(/^\$HOME(?=\/|$)/, home).replace(/^~(?=\/|$)/, home))
    try {
      const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
      const userDirsPath = join(configHome, 'user-dirs.dirs')
      if (existsSync(userDirsPath)) {
        const text = readFileSync(userDirsPath, 'utf-8')
        const match = /^XDG_DOWNLOAD_DIR=(?:"([^"]+)"|'([^']+)'|(\S+))/m.exec(text)
        const raw = (match?.[1] || match?.[2] || match?.[3] || '').trim()
        if (raw) {
          return pathResolve(raw.replace(/^\$HOME(?=\/|$)/, home).replace(/^~(?=\/|$)/, home))
        }
      }
    } catch {
      // fall back to ~/Downloads
    }
  }
  return join(home, 'Downloads')
}

function saveExportToDownloads(
  filename: string,
  content: string,
): { filename: string; savedPath: string } {
  const downloadsDir = resolveGlobalDownloadsDir()
  mkdirSync(downloadsDir, { recursive: true })
  const safeBase = basename(filename).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'pulse-export.txt'
  const ext = extname(safeBase)
  const stem = ext ? safeBase.slice(0, -ext.length) : safeBase
  let finalName = safeBase
  let targetPath = join(downloadsDir, finalName)
  for (let suffix = 2; existsSync(targetPath) && suffix <= 999; suffix++) {
    finalName = `${stem}-${suffix}${ext}`
    targetPath = join(downloadsDir, finalName)
  }
  writeFileSync(targetPath, content, 'utf-8')
  return { filename: finalName, savedPath: targetPath }
}

function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf-8')
  const bb = Buffer.from(b, 'utf-8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

function validateRequestToken(req: IncomingMessage, url: URL): boolean {
  const headerToken = req.headers['x-sidecar-token']
  const candidate = Array.isArray(headerToken) ? headerToken[0] : headerToken
  if (typeof candidate === 'string' && tokensMatch(candidate.trim(), UI_TOKEN)) {
    return true
  }
  const queryToken = url.searchParams.get('token')?.trim()
  if (queryToken && tokensMatch(queryToken, UI_TOKEN)) {
    return true
  }
  return false
}

function resolveAllowedCorsOrigin(originHeader: string | string[] | undefined): string | null {
  const raw = Array.isArray(originHeader) ? originHeader[0] : originHeader
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed === 'null' || trimmed.startsWith('vscode-webview://')) {
    return trimmed
  }
  try {
    const parsed = new URL(trimmed)
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.hostname === '127.0.0.1' ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === '[::1]')
    ) {
      return trimmed
    }
  } catch {
    // Reject malformed Origin headers.
  }
  return null
}

function resolvePreloadScript(): string {
  const candidates = [
    process.env.ANTIGRAVITY_APP_DATA_DIR
      ? join(process.env.ANTIGRAVITY_APP_DATA_DIR, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js')
      : '',
    join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return readFileSync(candidate, 'utf-8')
      }
    } catch {
      // Try next candidate.
    }
  }

  return `(() => {
  if (window.sidecar) return;
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';
  const convId = params.get('conversationId') || '';
  window.sidecar = {
    conversationId: convId || null,
    fetch(url, options = {}) {
      const headers = new Headers(options.headers || {});
      if (token) headers.set('X-Sidecar-Token', token);
      return fetch(url, { ...options, headers });
    },
    async getWorkspaceUris() { return []; },
    onWorkspaceChange() { return () => {}; },
    agent: {
      async sendMessage() { throw new Error('Antigravity host bridge unavailable in standalone mode'); },
      async newConversation() { throw new Error('Antigravity host bridge unavailable in standalone mode'); },
      async getConversationMetadata() { return {}; }
    },
    ui: {
      toggleAuxPane() { return false; },
      addArtifactComment() { return false; }
    }
  };
})();\n`
}

const PRELOAD_JS = resolvePreloadScript()

function renderIndexHtml(url: URL): string {
  const indexPath = join(SIDECAR_DIR, 'index.html')
  let html = readFileSync(indexPath, 'utf-8')
  const qs = new URLSearchParams()
  const reqToken = url.searchParams.get('token')?.trim() || UI_TOKEN
  const convId =
    url.searchParams.get('conversationId')?.trim() ||
    process.env.ANTIGRAVITY_CONVERSATION_ID?.trim() ||
    ''
  if (reqToken) qs.set('token', reqToken)
  if (convId) qs.set('conversationId', convId)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  html = html
    .replace('href="/styles.css"', `href="/styles.css${suffix}"`)
    .replace('src="/preload.js"', `src="/preload.js${suffix}"`)
    .replace('src="/main.js"', `src="/main.js${suffix}"`)
  return html
}

async function execAgentApi(
  args: string[],
  options: { projectId?: string } = {},
): Promise<unknown> {
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE?.trim()
  if (!exe && !process.env.ANTIGRAVITY_LS_ADDRESS) {
    throw new ServerError('UNAVAILABLE', 'agentapi is not configured in this environment.', 503)
  }
  const file = exe || 'agentapi'
  const base = basename(file).toLowerCase()
  const execArgs = exe && !base.startsWith('agentapi') ? ['agentapi', ...args] : args
  const env = { ...process.env }
  if (options.projectId) {
    env.ANTIGRAVITY_PROJECT_ID = options.projectId
  }
  const { stdout } = await execFileAsync(file, execArgs, {
    encoding: 'utf-8',
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    env,
    windowsHide: true,
  })
  return stdout.trim() ? JSON.parse(stdout) : {}
}

function sendAsset(res: ServerResponse, filePath: string, contentType: string): void {
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not found')
    return
  }
  const buf = readFileSync(filePath)
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache',
  })
  res.end(buf)
}

function parseOptionalInt(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : undefined
}

function parseOptionalBool(raw: string | null): boolean | undefined {
  if (raw === null) return undefined
  const lower = raw.trim().toLowerCase()
  if (lower === '1' || lower === 'true' || lower === 'yes') return true
  if (lower === '0' || lower === 'false' || lower === 'no') return false
  return undefined
}

function parseScope(raw: string | null | undefined): 'conversation' | 'all' {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'all' ? 'all' : 'conversation'
}

function extractSessionHint(
  req: IncomingMessage,
  url: URL,
  body?: { sessionId?: string; conversationId?: string; scope?: string },
): string | undefined {
  if (typeof body?.scope === 'string' && body.scope.trim().toLowerCase() === 'all') {
    return 'all'
  }
  if (typeof body?.sessionId === 'string' && body.sessionId.trim().length > 0) {
    return body.sessionId.trim()
  }
  if (typeof body?.conversationId === 'string' && body.conversationId.trim().length > 0) {
    return body.conversationId.trim()
  }
  const headerVal = req.headers['x-session-id']
  const headerCandidate = Array.isArray(headerVal) ? headerVal[0] : headerVal
  if (typeof headerCandidate === 'string' && headerCandidate.trim().length > 0) {
    return headerCandidate.trim()
  }
  const queryScope = url.searchParams.get('scope')
  if (queryScope && queryScope.trim().toLowerCase() === 'all') {
    return 'all'
  }
  const querySession =
    url.searchParams.get('sessionId')?.trim() || url.searchParams.get('conversationId')?.trim()
  if (querySession) return querySession
  return undefined
}

const requestCwdStorage = new AsyncLocalStorage<string>()

function extractHeaderString(req: IncomingMessage, headerName: string): string | undefined {
  const raw = req.headers[headerName]
  const val = Array.isArray(raw) ? raw[0] : raw
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined
}

function normalizeComparableRoot(dirPath: string): string {
  const resolved = pathResolve(dirPath).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

async function resolveValidatedRequestCwd(
  req: IncomingMessage,
  body: { cwd?: unknown },
  sessionHint?: string,
): Promise<string | undefined> {
  if (body.cwd !== undefined && typeof body.cwd !== 'string') {
    throw new ServerError('BAD_REQUEST', 'Parameter "cwd" must be a string.', 400)
  }
  const bodyCwd = typeof body.cwd === 'string' && body.cwd.trim().length > 0 ? body.cwd.trim() : undefined
  const headerCwd = extractHeaderString(req, 'x-pulse-cwd')
  const rawCwd = bodyCwd ?? headerCwd
  if (!rawCwd) return undefined

  if (rawCwd.includes('\0')) {
    throw new ServerError('WORKDIR_OUTSIDE_WORKSPACE', 'Requested cwd contains null bytes.', 403)
  }

  const authorizedRoots = await getCurrentWorkspaceRoots(sessionHint)
  if (authorizedRoots.length === 0) {
    throw new ServerError(
      'WORKDIR_OUTSIDE_WORKSPACE',
      'No authorized workspace root could be resolved for this session.',
      403,
    )
  }

  let candidate = uriToFsPath(rawCwd)
  if (process.platform === 'win32') {
    const msys = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(candidate)
    if (msys) {
      candidate = `${msys[1].toUpperCase()}:\\${(msys[2] ?? '').replace(/\//g, '\\')}`
    }
  }
  const resolvedCwd = isAbsolute(candidate)
    ? pathResolve(candidate)
    : pathResolve(authorizedRoots[0], candidate)

  if (!authorizedRoots.some((root) => isRealPathWithin(resolvedCwd, root))) {
    throw new ServerError(
      'WORKDIR_OUTSIDE_WORKSPACE',
      `Requested cwd "${rawCwd}" is outside the authorized workspace roots.`,
      403,
    )
  }

  let isDir = false
  try {
    isDir = existsSync(resolvedCwd) && statSync(resolvedCwd).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) {
    throw new ServerError(
      'WORKDIR_NOT_FOUND',
      `Requested cwd "${resolvedCwd}" does not exist or is not a directory.`,
      400,
    )
  }

  return resolvedCwd
}

async function runWithValidatedCwd<T>(
  req: IncomingMessage,
  body: { cwd?: unknown },
  sessionHint: string | undefined,
  fn: (validatedCwd: string | undefined) => Promise<T>,
): Promise<T> {
  const validatedCwd = await resolveValidatedRequestCwd(req, body, sessionHint)
  return validatedCwd ? requestCwdStorage.run(validatedCwd, () => fn(validatedCwd)) : fn(undefined)
}

// Track per-session workspace hints pushed by the Sidecar UI host bridge.
// Never leak one conversation's hints into another conversation.
const sessionHintRoots = new Map<string, string[]>()

function rememberSessionHints(conversationId: string | undefined, hints: string[]): void {
  if (!conversationId || hints.length === 0) return
  sessionHintRoots.set(conversationId, hints)
  // Cap map growth across long-lived daemon sessions.
  if (sessionHintRoots.size > 200) {
    const oldestKey = sessionHintRoots.keys().next().value
    if (oldestKey) sessionHintRoots.delete(oldestKey)
  }
}

async function getCurrentWorkspaceRoots(
  conversationId?: string,
  hintRoot?: string,
  hintRoots?: string[],
): Promise<string[]> {
  const sessionHints = conversationId ? sessionHintRoots.get(conversationId) : undefined
  const effectiveHints =
    hintRoots && hintRoots.length > 0
      ? hintRoots
      : hintRoot
        ? [hintRoot]
        : sessionHints && sessionHints.length > 0
          ? sessionHints
          : undefined
  const roots = await resolveWorkspaceRoots(conversationId, hintRoot, effectiveHints, DATA_DIR)
  const requestCwd = requestCwdStorage.getStore()
  if (!requestCwd) return roots
  const normRequestCwd = normalizeComparableRoot(requestCwd)
  return [requestCwd, ...roots.filter((r) => normalizeComparableRoot(r) !== normRequestCwd)]
}

const configStore = new ConfigStore(DATA_DIR)
const discoveryManager = new DaemonDiscoveryManager(DATA_DIR)
const shellDiscovery = new ShellDiscovery()
const spillStore = new SpillStore(DATA_DIR, () => configStore.get())
const sessionManager = new SessionManager({
  dataDir: DATA_DIR,
  getConfig: () => configStore.get(),
  spillStore,
})
const rustWorker = new RustWorker()
const quotaReader = new AntigravityQuotaReader({ dataDir: DATA_DIR })
const QUOTA_BACKGROUND_STALE_MS = 5 * 60_000
const QUOTA_BACKGROUND_MIN_RETRY_MS = 60_000
let quotaBgRefreshInFlight = false
let lastQuotaBgAttemptAt = 0

function isQuotaSnapshotStale(snap: QuotaSnapshot | null, now = Date.now()): boolean {
  if (!snap) return true
  if (now - snap.fetchedAt >= QUOTA_BACKGROUND_STALE_MS) return true
  for (const pool of snap.pools) {
    if (pool.disabled) continue
    for (const win of pool.windows) {
      if (win.resetsAt !== null && win.resetsAt > 0 && win.resetsAt <= now) {
        return true
      }
    }
  }
  return false
}

function triggerStaleQuotaRefreshIfNeeded(): void {
  if (quotaBgRefreshInFlight) return
  if (process.env.NODE_TEST_CONTEXT || process.env.AGY_PULSE_DISABLE_AUTO_QUOTA === '1') return
  const now = Date.now()
  if (now - lastQuotaBgAttemptAt < QUOTA_BACKGROUND_MIN_RETRY_MS) return
  const cached = quotaReader.getCached()
  if (!isQuotaSnapshotStale(cached, now)) return
  lastQuotaBgAttemptAt = now
  quotaBgRefreshInFlight = true
  void quotaReader
    .getSnapshot(true)
    .then((fresh) => {
      notifyLiveChange()
      broadcastWs({ type: 'state-update', state: { seq: liveSeq, quotas: fresh } })
    })
    .catch(() => {
      // Non-fatal background refresh error.
    })
    .finally(() => {
      quotaBgRefreshInFlight = false
    })
}
const jobManager = new JobManager({ spillStore })

function getExpectedMcpServerPath(): string {
  return join(DIST_DIR, 'mcp-server.mjs')
}

function buildSidecarNotices(params: {
  workerAvailable: boolean
  hostHealth: HostHealthSnapshot | null
  contextWindow: ConversationContextUsage | null
  quotas: QuotaSnapshot | null
}): SidecarNotice[] {
  const notices: SidecarNotice[] = []
  const seen = new Set<string>()
  const push = (notice: SidecarNotice) => {
    if (seen.has(notice.id)) return
    seen.add(notice.id)
    notices.push(notice)
  }

  if (!params.workerAvailable) {
    push({
      id: 'worker:offline',
      level: 'error',
      title: 'Native Rust worker unavailable',
      detail: 'agy-pulse-worker binary was not found alongside server.mjs. Rebuild or reinstall the plugin.',
      action: 'retry-worker',
    })
  }

  if (params.hostHealth) {
    const staleEntry = params.hostHealth.entries.find(
      (e) => e.status === 'stale' || e.status === 'missing',
    )
    if (staleEntry) {
      push({
        id: 'host:stale:antigravity',
        level: 'warn',
        title: `Host MCP config ${staleEntry.status}`,
        detail: staleEntry.detail,
        action: staleEntry.repairable ? 'repair-host' : undefined,
      })
    } else if (params.hostHealth.warnings.length > 0) {
      push({
        id: 'host:stale:antigravity',
        level: 'warn',
        title: 'Host MCP configuration warning',
        detail: params.hostHealth.warnings[0],
        action: params.hostHealth.entries.some((e) => e.repairable) ? 'repair-host' : undefined,
      })
    }
  }

  const cw = params.contextWindow
  if (cw?.available && cw.usagePct !== null && cw.usagePct >= 80) {
    push({
      id: `context:high:${cw.conversationId}`,
      level: cw.usagePct >= 90 ? 'error' : 'warn',
      title: `Context window at ${cw.usagePct.toFixed(1)}%`,
      detail: `${cw.contextTokens.toLocaleString('en-US')} / ${cw.contextLimit?.toLocaleString('en-US') ?? '?'} tokens used. Consider compacting the conversation.`,
    })
  }

  return notices
}
const execEngine = new ExecEngine({
  configStore,
  shellDiscovery,
  spillStore,
  jobManager,
  sessionManager,
  getWorkspaceRoots: (sessionId) => getCurrentWorkspaceRoots(sessionId),
})
const opsEngine = new OpsEngine({
  rustWorker,
  configStore,
  spillStore,
  sessionManager,
  getWorkspaceRoots: (sessionId) => getCurrentWorkspaceRoots(sessionId),
})

const wss = new WebSocketServer({ noServer: true })

interface WsClientSub {
  sessionId?: string
  scope: 'conversation' | 'all'
}

const wsClientSubs = new Map<WebSocket, WsClientSub>()
const lastTranscriptSigBySession = new Map<string, string>()

function shouldDeliverToWsClient(sub: WsClientSub | undefined, targetSessionId?: string): boolean {
  if (!targetSessionId || targetSessionId === 'all') return true
  if (!sub || sub.scope === 'all' || !sub.sessionId) return true
  return sub.sessionId === targetSessionId
}

function sendWs(ws: WebSocket, msg: WsServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(JSON.stringify(msg))
  } catch {
    // Ignore transient socket send failure.
  }
}

function broadcastWs(msg: WsServerMessage, targetSessionId?: string): void {
  const serialized = JSON.stringify(msg)
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue
    if (!shouldDeliverToWsClient(wsClientSubs.get(client), targetSessionId)) continue
    try {
      client.send(serialized)
    } catch {
      // Ignore individual client write error.
    }
  }
}

// Live sequence counter and HTTP long-poll waiters (guarantees real-time updates inside
// Antigravity Sidecar WebViews via window.sidecar.fetch even when WebSocket upgrades or
// query-string tokens are unavailable).
let liveSeq = 1
const liveWaiters = new Set<() => void>()
const liveWaiterSessions = new Map<() => void, string | undefined>()

function notifyLiveChange(): void {
  liveSeq += 1
  if (liveWaiters.size === 0) return
  const callbacks = Array.from(liveWaiters)
  liveWaiters.clear()
  liveWaiterSessions.clear()
  for (const cb of callbacks) {
    try {
      cb()
    } catch {
      // Ignore waiter callback failure.
    }
  }
}

function waitForLiveChange(
  sinceSeq: number,
  waitMs: number,
  req: IncomingMessage,
  sessionId?: string,
): Promise<boolean> {
  if (liveSeq > sinceSeq || waitMs <= 0) {
    return Promise.resolve(liveSeq > sinceSeq)
  }
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (changed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      liveWaiters.delete(onChange)
      liveWaiterSessions.delete(onChange)
      req.off('close', onClose)
      resolve(changed)
    }
    const onChange = () => finish(true)
    const onClose = () => finish(false)
    const timer = setTimeout(() => finish(liveSeq > sinceSeq), waitMs)
    liveWaiters.add(onChange)
    liveWaiterSessions.set(onChange, sessionId)
    req.once('close', onClose)
  })
}

function hasOpenWsClients(targetSessionId?: string): boolean {
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue
    if (shouldDeliverToWsClient(wsClientSubs.get(client), targetSessionId)) return true
  }
  return false
}

/**
 * Schedules a non-blocking WebSocket broadcast off the hot MCP request path.
 * When no matching UI panel is connected over WebSocket, the payload factory is never invoked.
 */
function scheduleWsBroadcast(
  buildMessage: () => WsServerMessage,
  targetSessionId?: string,
): void {
  if (!hasOpenWsClients(targetSessionId)) return
  setImmediate(() => {
    if (!hasOpenWsClients(targetSessionId)) return
    try {
      broadcastWs(buildMessage(), targetSessionId)
    } catch {
      // Never impact daemon stability on background UI broadcast errors.
    }
  })
}

jobManager.on('job-update', (jobSummary?: JobSummary) => {
  notifyLiveChange()
  const seq = liveSeq
  const changedSessionId = jobSummary?.sessionId
  if (!hasOpenWsClients(changedSessionId)) return
  setImmediate(() => {
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue
      const sub = wsClientSubs.get(client)
      if (!shouldDeliverToWsClient(sub, changedSessionId)) continue
      const scopedJobs =
        sub && sub.scope === 'conversation' && sub.sessionId
          ? jobManager.listJobs(sub.sessionId)
          : jobManager.listJobs()
      sendWs(client, {
        type: 'state-update',
        state: { seq, jobs: scopedJobs },
      })
    }
  })
})

sessionManager.on('activity', (payload: SessionActivityEvent) => {
  notifyLiveChange()
  scheduleWsBroadcast(
    () => ({
      type: 'activity-event',
      item: payload.item,
      unreadAnomalies: payload.unreadAnomalies,
    }),
    payload.sessionId,
  )
})

sessionManager.on('ack', (payload: SessionAckEvent) => {
  notifyLiveChange()
  const seq = liveSeq
  scheduleWsBroadcast(
    () => ({
      type: 'state-update',
      state: {
        seq,
        sessionId: payload.sessionId,
        activities: sessionManager.getSessionActivities(payload.sessionId),
        unreadAnomalies: payload.unreadAnomalies,
      },
    }),
    payload.sessionId,
  )
})

sessionManager.on('telemetry', (payload: SessionTelemetryEvent) => {
  notifyLiveChange()
  scheduleWsBroadcast(
    () => ({
      type: 'telemetry-update',
      telemetry: payload.telemetry,
      dedupEntryCount: payload.dedupEntryCount,
      sessionId: payload.sessionId,
      sessions: sessionManager.listSessions(payload.sessionId),
    }),
    payload.sessionId,
  )
})

sessionManager.on('sessions-changed', () => {
  notifyLiveChange()
  const seq = liveSeq
  scheduleWsBroadcast(() => ({
    type: 'state-update',
    state: { seq, sessions: sessionManager.listSessions() },
  }))
})

spillStore.on('change', () => {
  notifyLiveChange()
  const seq = liveSeq
  scheduleWsBroadcast(() => ({
    type: 'state-update',
    state: { seq, spills: spillStore.listSpills() },
  }))
})

function seedTranscriptSignature(conversationId: string): void {
  const filePath = resolveTranscriptFilePath(conversationId, DATA_DIR)
  if (!filePath) return
  try {
    const st = statSync(filePath)
    if (!st.isFile()) return
    lastTranscriptSigBySession.set(conversationId, `${filePath}|${st.mtimeMs}|${st.size}`)
    if (lastTranscriptSigBySession.size > 64) {
      const oldestKey = lastTranscriptSigBySession.keys().next().value
      if (oldestKey !== undefined) lastTranscriptSigBySession.delete(oldestKey)
    }
  } catch {
    // Ignore stat errors.
  }
}

const transcriptWatchTimer = setInterval(() => {
  if (!hasOpenWsClients() && liveWaiters.size === 0) return
  const targets = new Set<string>()
  const activeId = sessionManager.resolveSessionId(undefined)
  if (activeId && activeId !== 'default' && activeId !== 'all') {
    targets.add(activeId)
  }
  for (const sub of wsClientSubs.values()) {
    if (sub.sessionId && sub.sessionId !== 'default' && sub.sessionId !== 'all') {
      targets.add(sub.sessionId)
    }
  }
  for (const waiterConvId of liveWaiterSessions.values()) {
    if (waiterConvId && waiterConvId !== 'default' && waiterConvId !== 'all') {
      targets.add(waiterConvId)
    }
  }
  for (const convId of targets) {
    const filePath = resolveTranscriptFilePath(convId, DATA_DIR)
    if (!filePath) continue
    try {
      const st = statSync(filePath)
      if (!st.isFile()) continue
      const sig = `${filePath}|${st.mtimeMs}|${st.size}`
      if (lastTranscriptSigBySession.get(convId) === sig) continue
      lastTranscriptSigBySession.set(convId, sig)
      if (lastTranscriptSigBySession.size > 64) {
        const oldestKey = lastTranscriptSigBySession.keys().next().value
        if (oldestKey !== undefined) lastTranscriptSigBySession.delete(oldestKey)
      }
      const contextWindow = readConversationContextUsage(
        convId,
        DATA_DIR,
        filePath,
        configStore.get().costPricingOverrides,
      )
      notifyLiveChange()
      scheduleWsBroadcast(
        () => ({
          type: 'state-update',
          state: { seq: liveSeq, contextWindow },
        }),
        convId,
      )
    } catch {
      // Ignore transient stat/read failures while transcript is being written.
    }
  }
}, 2_500)
transcriptWatchTimer.unref()

wss.on('connection', (ws, req) => {
  let clientConvId: string | undefined
  let clientScope: 'conversation' | 'all' = 'conversation'
  try {
    const wsUrl = new URL(req?.url || '/ws', `http://${BIND_HOST}:${PORT || 80}`)
    const rawScope = wsUrl.searchParams.get('scope')?.trim().toLowerCase()
    const rawConv =
      wsUrl.searchParams.get('conversationId')?.trim() ||
      wsUrl.searchParams.get('sessionId')?.trim()
    if (rawScope === 'all' || rawConv?.toLowerCase() === 'all') {
      clientScope = 'all'
    } else if (rawConv) {
      clientConvId = rawConv
    }
  } catch {
    // Ignore malformed WS query URL.
  }
  wsClientSubs.set(ws, { sessionId: clientConvId, scope: clientScope })

  ws.on('message', (raw) => {
    let msg: WsClientMessage
    try {
      const text = typeof raw === 'string' ? raw : raw.toString('utf-8')
      msg = JSON.parse(text) as WsClientMessage
    } catch {
      return
    }

    if (msg && msg.type === 'ping') {
      sendWs(ws, { type: 'pong', ts: typeof msg.ts === 'number' ? msg.ts : Date.now() })
    }
  })

  ws.on('close', () => {
    wsClientSubs.delete(ws)
  })

  ws.on('error', () => {
    // Handled cleanly on close.
  })
})

async function buildStateSnapshot(
  conversationId?: string,
  workspaceRoot?: string,
  extraRoots?: string[],
  scope: 'conversation' | 'all' = 'conversation',
  options: { recordHints?: boolean } = {},
): Promise<SidecarStateSnapshot> {
  const isAllScope =
    scope === 'all' ||
    (typeof conversationId === 'string' && conversationId.trim().toLowerCase() === 'all')
  const sessionScope: 'conversation' | 'all' = isAllScope ? 'all' : 'conversation'
  const effectiveConvId = isAllScope ? undefined : conversationId

  const combinedHints = [
    ...(workspaceRoot ? [workspaceRoot] : []),
    ...(extraRoots ?? []),
  ].filter(Boolean)
  if (options.recordHints !== false && effectiveConvId && combinedHints.length > 0) {
    rememberSessionHints(effectiveConvId, combinedHints)
  }

  const [roots, shells] = await Promise.all([
    getCurrentWorkspaceRoots(effectiveConvId, workspaceRoot, extraRoots),
    shellDiscovery.detect(),
  ])

  const primary =
    workspaceRoot && roots.some((r) => r.toLowerCase() === workspaceRoot.toLowerCase())
      ? workspaceRoot
      : roots[0]

  const targetSessionId = isAllScope ? 'all' : sessionManager.resolveSessionId(effectiveConvId)
  // Scope "all" ("This project") to conversations belonging to the active project workspace.
  const projectWorkspaceFilter = isAllScope ? primary : undefined
  const activeConvId = !isAllScope ? targetSessionId : sessionManager.resolveSessionId(conversationId)
  const costOverrides = configStore.get().costPricingOverrides
  const contextWindow = isAllScope
    ? null
    : readConversationContextUsage(targetSessionId, DATA_DIR, undefined, costOverrides)
  if (!isAllScope) {
    seedTranscriptSignature(targetSessionId)
    if (contextWindow?.available && contextWindow.cost) {
      sessionManager.recordSessionCost(
        targetSessionId,
        contextWindow.cost.totalUsd,
        contextWindow.cost.cacheSavingsUsd,
        primary,
      )
    }
  } else if (activeConvId && activeConvId !== 'default' && activeConvId !== 'all') {
    const activeCtx = readConversationContextUsage(activeConvId, DATA_DIR, undefined, costOverrides)
    if (activeCtx?.available && activeCtx.cost) {
      sessionManager.recordSessionCost(
        activeConvId,
        activeCtx.cost.totalUsd,
        activeCtx.cost.cacheSavingsUsd,
        primary,
      )
    }
  }

  const { telemetry, dedupEntryCount } = sessionManager.getSessionTelemetry(
    targetSessionId,
    projectWorkspaceFilter,
  )
  const activities = sessionManager.getSessionActivities(
    targetSessionId,
    200,
    projectWorkspaceFilter,
  )
  const unreadAnomalies = sessionManager.getSessionUnreadAnomalies(
    targetSessionId,
    projectWorkspaceFilter,
  )
  const projectSessionIds = isAllScope
    ? sessionManager.getSessionIdsForWorkspace(projectWorkspaceFilter)
    : null
  const spills = isAllScope
    ? spillStore
        .listSpills(100)
        .filter((s) => !projectSessionIds || !s.sessionId || projectSessionIds.has(s.sessionId))
    : spillStore.listSpills(100, targetSessionId)
  const sessions = sessionManager.listSessions(
    isAllScope ? activeConvId : targetSessionId,
    projectWorkspaceFilter,
  )
  const projectCost = sessionManager.getAggregatedProjectCost(primary)
  const jobs = isAllScope
    ? jobManager
        .listJobs(undefined)
        .filter((j) => !projectSessionIds || !j.sessionId || projectSessionIds.has(j.sessionId))
    : jobManager.listJobs(targetSessionId)
  const workerAvailable = rustWorker.isAvailable()
  const quotas = quotaReader.getCached()
  if (isQuotaSnapshotStale(quotas)) {
    triggerStaleQuotaRefreshIfNeeded()
  }
  let hostHealth: HostHealthSnapshot | null = null
  try {
    hostHealth = inspectAntigravityHostHealth(getExpectedMcpServerPath())
  } catch {
    hostHealth = null
  }
  const notices = buildSidecarNotices({
    workerAvailable,
    hostHealth,
    contextWindow,
    quotas,
  })

  return {
    snapshotVersion: SNAPSHOT_VERSION,
    seq: liveSeq,
    workspaceRoots: roots,
    primaryWorkspaceRoot: primary,
    platform: process.platform,
    config: configStore.get(),
    shells,
    jobs,
    activities,
    unreadAnomalies,
    daemonVersion: DAEMON_VERSION,
    workerAvailable,
    workerPath: rustWorker.getBinaryPath(),
    telemetry,
    spills,
    dedupEntryCount,
    sessionId: targetSessionId,
    sessionScope,
    sessions,
    contextWindow,
    projectApiCostUsd: projectCost.apiCostUsd,
    projectCacheSavingsUsd: projectCost.cacheSavingsUsd,
    quotas,
    hostHealth,
    notices,
  }
}

const server = createServer(async (req, res) => {
  const method = (req.method || 'GET').toUpperCase()
  const url = new URL(req.url || '/', `http://${BIND_HOST}:${PORT || 80}`)
  const pathname = url.pathname
  const startedAt = Date.now()

  res.on('finish', () => {
    const elapsed = Date.now() - startedAt
    const isNormalLongPoll = pathname === '/api/events' && res.statusCode < 400
    if (
      res.statusCode >= 400 ||
      pathname === '/' ||
      pathname === '/index.html' ||
      (!isNormalLongPoll && elapsed >= 1000)
    ) {
      console.log(`[agy-pulse] ${method} ${pathname} -> ${res.statusCode} (${elapsed}ms)`)
    }
  })

  const allowedOrigin = resolveAllowedCorsOrigin(req.headers.origin)
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Sidecar-Token, X-Session-Id, X-Pulse-Cwd',
  )

  if (method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  try {
    const isReadMethod = method === 'GET' || method === 'HEAD'

    if (isReadMethod && pathname === '/healthz') {
      writeOk(res, {
        version: DAEMON_VERSION,
        pid: process.pid,
        workerAvailable: rustWorker.isAvailable(),
        workerPath: rustWorker.getBinaryPath(),
      })
      return
    }

    if (isReadMethod && (pathname === '/' || pathname === '/index.html')) {
      const html = renderIndexHtml(url)
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
      })
      res.end(method === 'HEAD' ? undefined : html)
      return
    }

    if (isReadMethod && pathname === '/preload.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Length': Buffer.byteLength(PRELOAD_JS),
        'Cache-Control': 'no-store',
      })
      res.end(method === 'HEAD' ? undefined : PRELOAD_JS)
      return
    }

    if (isReadMethod && pathname === '/main.js') {
      sendAsset(res, join(DIST_DIR, 'main.js'), 'application/javascript; charset=utf-8')
      return
    }

    if (isReadMethod && pathname === '/styles.css') {
      sendAsset(res, join(DIST_DIR, 'styles.css'), 'text/css; charset=utf-8')
      return
    }

    if (isReadMethod && pathname === '/assets/logo.svg') {
      sendAsset(res, join(PLUGIN_DIR, 'assets', 'logo.svg'), 'image/svg+xml; charset=utf-8')
      return
    }

    const isProtectedRoute = pathname.startsWith('/api/') || pathname.startsWith('/_sidecar/')
    if (isProtectedRoute && !validateRequestToken(req, url)) {
      throw new ServerError('UNAUTHORIZED', 'Invalid or missing sidecar token.', 401)
    }

    if (pathname === '/_sidecar/send-message' && method === 'POST') {
      const data = await readJsonBody<{
        conversationId: string
        message: string
        title?: string
        projectId?: string
      }>(req)
      const args = ['send-message']
      if (data.title) args.push('--title', data.title)
      args.push(data.conversationId, data.message)
      const result = await execAgentApi(args, { projectId: data.projectId })
      writeJson(res, result)
      return
    }

    if (pathname === '/_sidecar/new-conversation' && method === 'POST') {
      const data = await readJsonBody<{ message: string; model?: string; projectId?: string }>(req)
      const result = await execAgentApi(
        ['new-conversation', '--model', data.model || 'flash', data.message],
        { projectId: data.projectId },
      )
      writeJson(res, result)
      return
    }

    if (
      pathname === '/_sidecar/get-conversation-metadata' &&
      (method === 'POST' || method === 'GET')
    ) {
      const data =
        method === 'POST'
          ? await readJsonBody<{ conversationId?: string }>(req, { allowEmpty: true })
          : { conversationId: url.searchParams.get('conversationId') || undefined }
      const convId = data.conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || ''
      const result = await execAgentApi(['get-conversation-metadata', convId])
      writeJson(res, result)
      return
    }

    if (pathname === '/api/state' && method === 'GET') {
      const convId =
        url.searchParams.get('sessionId') || url.searchParams.get('conversationId') || undefined
      const scope = parseScope(url.searchParams.get('scope'))
      const workspaceRoot = url.searchParams.get('workspaceRoot') || undefined
      const extraRoots = url.searchParams
        .getAll('workspaceRoots')
        .filter((s) => s.trim().length > 0)
      const state = await buildStateSnapshot(convId, workspaceRoot, extraRoots, scope)
      writeOk(res, { state, ...state })
      return
    }

    if (pathname === '/api/events' && method === 'GET') {
      const convId =
        url.searchParams.get('sessionId') || url.searchParams.get('conversationId') || undefined
      const scope = parseScope(url.searchParams.get('scope'))
      const workspaceRoot = url.searchParams.get('workspaceRoot') || undefined
      const extraRoots = url.searchParams
        .getAll('workspaceRoots')
        .filter((s) => s.trim().length > 0)
      const since = parseOptionalInt(url.searchParams.get('since')) ?? 0
      const rawWaitMs = parseOptionalInt(url.searchParams.get('waitMs')) ?? 5_000
      const waitMs = Math.max(0, Math.min(10_000, rawWaitMs))

      const waiterSessionId =
        scope === 'all' ? undefined : sessionManager.resolveSessionId(convId)
      const changed = await waitForLiveChange(since, waitMs, req, waiterSessionId)
      if (res.writableEnded || req.destroyed) return
      if (!changed) {
        writeOk(res, { seq: liveSeq, changed: false })
        return
      }
      const state = await buildStateSnapshot(convId, workspaceRoot, extraRoots, scope, {
        recordHints: false,
      })
      writeOk(res, { seq: liveSeq, changed: true, state })
      return
    }

    if (pathname === '/api/quotas' && method === 'GET') {
      const force =
        (parseOptionalBool(url.searchParams.get('force')) ??
          parseOptionalBool(url.searchParams.get('refresh'))) ??
        false
      const quotas = await quotaReader.getSnapshot(force)
      writeOk(res, { quotas, ...quotas })
      return
    }

    if (pathname === '/api/quotas/refresh' && method === 'POST') {
      const quotas = await quotaReader.getSnapshot(true)
      notifyLiveChange()
      broadcastWs({ type: 'state-update', state: { seq: liveSeq, quotas } })
      writeOk(res, { quotas, ...quotas })
      return
    }

    if (pathname === '/api/host-health' && method === 'GET') {
      const hostHealth = inspectAntigravityHostHealth(getExpectedMcpServerPath())
      writeOk(res, { hostHealth, ...hostHealth })
      return
    }

    if (pathname === '/api/host-health/repair' && method === 'POST') {
      const result = repairAntigravityHostConfig(getExpectedMcpServerPath())
      notifyLiveChange()
      broadcastWs({ type: 'state-update', state: { seq: liveSeq, hostHealth: result.snapshot } })
      writeOk(res, { ...result, hostHealth: result.snapshot })
      return
    }

    if (pathname === '/api/shells' && method === 'GET') {
      const refresh = parseOptionalBool(url.searchParams.get('refresh')) ?? false
      const shells = await shellDiscovery.detect(refresh)
      if (refresh) {
        notifyLiveChange()
        broadcastWs({ type: 'state-update', state: { seq: liveSeq, shells } })
      }
      writeOk(res, { shells })
      return
    }

    if (pathname === '/api/sessions' && method === 'GET') {
      const currentHint =
        url.searchParams.get('sessionId') || url.searchParams.get('conversationId') || undefined
      const activeSessionId = sessionManager.resolveSessionId(currentHint)
      const sessions = sessionManager.listSessions(activeSessionId)
      writeOk(res, { sessions, activeSessionId })
      return
    }

    const sessionExportMatch = /^\/api\/sessions\/([^/]+)\/export$/.exec(pathname)
    if (sessionExportMatch && (method === 'GET' || method === 'POST')) {
      const targetId = decodeURIComponent(sessionExportMatch[1])
      const rawFormat = (url.searchParams.get('format') || 'markdown').trim().toLowerCase()
      const format: 'markdown' | 'json' = rawFormat === 'json' ? 'json' : 'markdown'
      const report = sessionManager.exportSessionReport(targetId, format)
      const saveFlag = (url.searchParams.get('save') || '').trim().toLowerCase()
      const shouldSave = method === 'POST' || saveFlag === '1' || saveFlag === 'true'
      if (shouldSave) {
        const saved = saveExportToDownloads(report.filename, report.content)
        writeOk(res, { ...report, filename: saved.filename, savedPath: saved.savedPath })
        return
      }
      writeOk(res, { ...report })
      return
    }

    const sessionDeleteMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname)
    if (sessionDeleteMatch && method === 'DELETE') {
      const targetId = decodeURIComponent(sessionDeleteMatch[1])
      const result = sessionManager.deleteSession(targetId)
      if (!result.deleted) {
        throw new ServerError('SESSION_NOT_FOUND', `Session "${targetId}" was not found.`, 404)
      }
      writeOk(res, { ...result, sessions: sessionManager.listSessions() })
      return
    }

    if (pathname === '/api/telemetry' && method === 'GET') {
      const sessionHint = extractSessionHint(req, url)
      const result = sessionManager.getSessionTelemetry(sessionHint)
      writeOk(res, result)
      return
    }

    if (pathname === '/api/telemetry/reset' && method === 'POST') {
      const body = await readJsonBody<{
        sessionId?: string
        conversationId?: string
        scope?: string
      }>(req, { allowEmpty: true })
      const sessionHint = extractSessionHint(req, url, body)
      const activeRoots = sessionHint === 'all' ? await getCurrentWorkspaceRoots() : []
      const result = sessionManager.resetSession(sessionHint, activeRoots[0])
      notifyLiveChange()
      writeOk(res, result)
      return
    }

    if (pathname === '/api/cache/clear-dedup' && method === 'POST') {
      const body = await readJsonBody<{
        sessionId?: string
        conversationId?: string
        scope?: string
      }>(req, { allowEmpty: true })
      const sessionHint = extractSessionHint(req, url, body)
      const activeRoots = sessionHint === 'all' ? await getCurrentWorkspaceRoots() : []
      const { cleared, dedupEntryCount } = sessionManager.clearDedup(sessionHint, activeRoots[0])
      const snapshot = sessionManager.getSessionTelemetry(sessionHint, activeRoots[0])
      notifyLiveChange()
      broadcastWs(
        {
          type: 'telemetry-update',
          telemetry: snapshot.telemetry,
          dedupEntryCount,
          sessionId: snapshot.sessionId,
        },
        snapshot.sessionId,
      )
      broadcastWs(
        { type: 'state-update', state: { seq: liveSeq, dedupEntryCount } },
        snapshot.sessionId,
      )
      writeOk(res, { sessionId: snapshot.sessionId, cleared, dedupEntryCount })
      return
    }

    if (pathname === '/api/config' && method === 'GET') {
      const config = configStore.get()
      writeOk(res, { config, ...config })
      return
    }

    if (pathname === '/api/config' && (method === 'PUT' || method === 'POST' || method === 'PATCH')) {
      const patch = await readJsonBody<Partial<TerminalConfig>>(req)
      try {
        const config = configStore.update(patch)
        sessionManager.pruneSessions()
        notifyLiveChange()
        broadcastWs({ type: 'state-update', state: { seq: liveSeq, config } })
        writeOk(res, { config, ...config })
      } catch (err) {
        throw new ServerError(
          'INVALID_CONFIG',
          err instanceof Error ? err.message : String(err),
          400,
        )
      }
      return
    }

    if (pathname === '/api/config/reset' && method === 'POST') {
      const config = configStore.reset()
      sessionManager.pruneSessions()
      notifyLiveChange()
      broadcastWs({ type: 'state-update', state: { seq: liveSeq, config } })
      writeOk(res, { config, ...config })
      return
    }

    if (pathname === '/api/pulse/read-files' && method === 'POST') {
      const body = await readJsonBody<
        ReadFilesRequest & {
          source?: 'agent' | 'user'
          sessionId?: string
          conversationId?: string
          cwd?: string
        }
      >(req)
      const source: 'agent' | 'user' = body.source === 'user' ? 'user' : 'agent'
      const sessionHint = extractSessionHint(req, url, body)
      const outcome = await runWithValidatedCwd(req, body, sessionHint, () =>
        opsEngine.readFiles(body, source, sessionHint),
      )
      writeOk(res, { outcome, ...outcome })
      return
    }

    if (pathname === '/api/pulse/search' && method === 'POST') {
      const body = await readJsonBody<
        SearchRequest & {
          source?: 'agent' | 'user'
          sessionId?: string
          conversationId?: string
          cwd?: string
        }
      >(req)
      const source: 'agent' | 'user' = body.source === 'user' ? 'user' : 'agent'
      const sessionHint = extractSessionHint(req, url, body)
      const outcome = await runWithValidatedCwd(req, body, sessionHint, () =>
        opsEngine.search(body, source, sessionHint),
      )
      writeOk(res, { outcome, ...outcome })
      return
    }

    if (pathname === '/api/pulse/mutate' && method === 'POST') {
      const body = await readJsonBody<
        MutateRequest & {
          source?: 'agent' | 'user'
          sessionId?: string
          conversationId?: string
          cwd?: string
        }
      >(req)
      const source: 'agent' | 'user' = body.source === 'user' ? 'user' : 'agent'
      const sessionHint = extractSessionHint(req, url, body)
      const outcome = await runWithValidatedCwd(req, body, sessionHint, () =>
        opsEngine.mutate(body, source, sessionHint),
      )
      writeOk(res, { outcome, ...outcome })
      return
    }

    if (pathname === '/api/pulse/read-doc' && method === 'POST') {
      const body = await readJsonBody<
        ReadDocRequest & {
          source?: 'agent' | 'user'
          sessionId?: string
          conversationId?: string
          cwd?: string
        }
      >(req)
      const source: 'agent' | 'user' = body.source === 'user' ? 'user' : 'agent'
      const sessionHint = extractSessionHint(req, url, body)
      const outcome = await runWithValidatedCwd(req, body, sessionHint, () =>
        opsEngine.readDoc(body, source, sessionHint),
      )
      writeOk(res, { outcome, ...outcome })
      return
    }

    if (pathname === '/api/exec' && method === 'POST') {
      const body = await readJsonBody<
        ExecRequest & {
          source?: 'agent' | 'user'
          sessionId?: string
          conversationId?: string
          cwd?: string
        }
      >(req)
      const source: 'agent' | 'user' = body.source === 'user' ? 'user' : 'agent'
      const sessionHint = extractSessionHint(req, url, body)
      const outcome = await runWithValidatedCwd(req, body, sessionHint, (validatedCwd) => {
        const execBody =
          validatedCwd && (!body.workdir || !body.workdir.trim())
            ? { ...body, workdir: validatedCwd }
            : body
        return execEngine.execute(execBody, source, sessionHint)
      })
      writeOk(res, { outcome, ...outcome })
      return
    }

    if (pathname === '/api/jobs' && method === 'GET') {
      const scope = parseScope(url.searchParams.get('scope'))
      const rawSession =
        url.searchParams.get('sessionId') || url.searchParams.get('conversationId') || undefined
      const filterSessionId =
        scope === 'all' || rawSession?.trim().toLowerCase() === 'all'
          ? undefined
          : rawSession
            ? sessionManager.resolveSessionId(rawSession)
            : undefined
      const jobs = jobManager.listJobs(filterSessionId)
      writeOk(res, { jobs })
      return
    }

    const jobMatch = /^\/api\/jobs\/([^/]+)(?:\/(output|input|kill))?$/.exec(pathname)
    if (jobMatch) {
      const jobId = decodeURIComponent(jobMatch[1])
      const action = jobMatch[2]

      if (!action && method === 'GET') {
        const job = jobManager.getJob(jobId)
        if (!job) throw new ServerError('JOB_NOT_FOUND', `Background job "${jobId}" was not found.`, 404)
        writeOk(res, { job })
        return
      }

      if (!action && method === 'DELETE') {
        try {
          const job = await jobManager.killJob(jobId)
          writeOk(res, { job })
        } catch (err) {
          throw new ServerError('JOB_NOT_FOUND', err instanceof Error ? err.message : String(err), 404)
        }
        return
      }

      if (action === 'output' && (method === 'GET' || method === 'POST')) {
        const body =
          method === 'POST'
            ? await readJsonBody<{
                stdoutOffset?: number
                stderrOffset?: number
                wait?: boolean
                waitTimeoutMs?: number
                maxBytes?: number
              }>(req, { allowEmpty: true })
            : {}
        const opts = {
          stdoutOffset: body.stdoutOffset ?? parseOptionalInt(url.searchParams.get('stdoutOffset')),
          stderrOffset: body.stderrOffset ?? parseOptionalInt(url.searchParams.get('stderrOffset')),
          wait: body.wait ?? parseOptionalBool(url.searchParams.get('wait')),
          waitTimeoutMs:
            body.waitTimeoutMs ?? parseOptionalInt(url.searchParams.get('waitTimeoutMs')),
          maxBytes: body.maxBytes ?? parseOptionalInt(url.searchParams.get('maxBytes')),
        }
        try {
          const output = await jobManager.getOutput(jobId, opts)
          writeOk(res, { output, ...output })
        } catch (err) {
          throw new ServerError('JOB_NOT_FOUND', err instanceof Error ? err.message : String(err), 404)
        }
        return
      }

      if (action === 'input' && method === 'POST') {
        const body = await readJsonBody<{ input?: string; data?: string }>(req)
        const text = typeof body.input === 'string' ? body.input : body.data
        if (typeof text !== 'string') {
          throw new ServerError('BAD_REQUEST', 'Missing "input" string.', 400)
        }
        try {
          const result = jobManager.sendInput(jobId, text)
          writeOk(res, { job: result.job })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const status = msg.includes('not found') ? 404 : 400
          throw new ServerError('JOB_INPUT_ERROR', msg, status)
        }
        return
      }

      if (action === 'kill' && method === 'POST') {
        try {
          const job = await jobManager.killJob(jobId)
          writeOk(res, { job })
        } catch (err) {
          throw new ServerError('JOB_NOT_FOUND', err instanceof Error ? err.message : String(err), 404)
        }
        return
      }
    }

    if (pathname === '/api/results' && method === 'GET') {
      const limit = parseOptionalInt(url.searchParams.get('limit')) ?? 100
      const scope = parseScope(url.searchParams.get('scope'))
      const rawSession =
        url.searchParams.get('sessionId') || url.searchParams.get('conversationId') || undefined
      const filterSessionId =
        scope === 'all' || rawSession?.trim().toLowerCase() === 'all'
          ? undefined
          : rawSession
            ? sessionManager.resolveSessionId(rawSession)
            : undefined
      const spills = spillStore.listSpills(limit, filterSessionId)
      writeOk(res, { spills })
      return
    }

    if (pathname === '/api/results/page' && (method === 'POST' || method === 'GET')) {
      const pageReq: ResultPageRequest =
        method === 'POST'
          ? await readJsonBody<ResultPageRequest>(req)
          : {
              refId: url.searchParams.get('refId') || '',
              offset: parseOptionalInt(url.searchParams.get('offset')),
              limit: parseOptionalInt(url.searchParams.get('limit')),
              maxBytes: parseOptionalInt(url.searchParams.get('maxBytes')),
              search: url.searchParams.get('search') || undefined,
              caseInsensitive: parseOptionalBool(url.searchParams.get('caseInsensitive')),
              stream: (url.searchParams.get('stream') as ResultPageRequest['stream']) || undefined,
            }
      if (!pageReq.refId) {
        throw new ServerError('BAD_REQUEST', 'Missing required "refId" parameter.', 400)
      }
      try {
        const page = spillStore.pageResult(pageReq)
        writeOk(res, { page, ...page })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const status = msg.includes('not found') ? 404 : 400
        throw new ServerError('SPILL_PAGE_ERROR', msg, status)
      }
      return
    }

    if (pathname === '/api/results/release' && method === 'POST') {
      const body = await readJsonBody<{ refId?: string }>(req)
      if (!body.refId) {
        throw new ServerError('BAD_REQUEST', 'Missing required "refId" parameter.', 400)
      }
      try {
        const result = spillStore.releaseResult(body.refId)
        writeOk(res, result)
      } catch (err) {
        throw new ServerError('SPILL_RELEASE_ERROR', err instanceof Error ? err.message : String(err), 400)
      }
      return
    }

    if (pathname === '/api/activity/ack' && method === 'POST') {
      const body = await readJsonBody<{
        sessionId?: string
        conversationId?: string
        scope?: string
      }>(req, { allowEmpty: true })
      const sessionHint = extractSessionHint(req, url, body)
      const result = sessionManager.acknowledgeActivities(sessionHint)
      writeOk(res, result)
      return
    }

    throw new ServerError('NOT_FOUND', `Route not found: ${method} ${pathname}`, 404)
  } catch (err) {
    writeError(res, err)
  }
})

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url || '/', `http://${BIND_HOST}:${PORT || 80}`)
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (!validateRequestToken(req, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  } catch {
    socket.destroy()
  }
})

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(transcriptWatchTimer)
  rustWorker.dispose()
  sessionManager.flushAll()
  discoveryManager.cleanup()
  notifyLiveChange()

  for (const client of wss.clients) {
    try {
      client.close(1001, 'Server shutting down')
    } catch {
      // Ignore close error.
    }
  }
  wss.close()

  await Promise.allSettled([jobManager.disposeAll()])

  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}

process.on('SIGTERM', () => {
  void shutdown()
})
process.on('SIGINT', () => {
  void shutdown()
})

server.listen(PORT, BIND_HOST, () => {
  const addr = server.address()
  const actualPort = typeof addr === 'object' && addr ? addr.port : PORT
  discoveryManager.publish({
    port: actualPort,
    token: UI_TOKEN,
    version: DAEMON_VERSION,
  })
  void shellDiscovery.detect().catch(() => {})
  console.log(
    `[agy-pulse] v${DAEMON_VERSION} ops daemon listening on http://${BIND_HOST}:${actualPort} (worker=${rustWorker.isAvailable() ? 'ready' : 'unavailable'})`,
  )
})
