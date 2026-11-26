import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveDataDir } from '../shared/paths.ts'
import type {
  ActiveSessionBinding,
  DaemonDiscovery,
  ExecOutcome,
  ExecRequest,
  FailureInfo,
  HostHealthSnapshot,
  JobOutputResponse,
  JobSummary,
  MutateOutcome,
  MutateRequest,
  QuotaSnapshot,
  ReadDocOutcome,
  ReadDocRequest,
  ReadFilesOutcome,
  ReadFilesRequest,
  ResultPageRequest,
  ResultPageResponse,
  SearchOutcome,
  SearchRequest,
  SessionSummary,
  ShellInfo,
  SidecarStateSnapshot,
  SpillEntrySummary,
  TerminalConfig,
  TokenSavingsSummary,
} from '../shared/types.ts'
import { ConfigStore } from '../server/config.ts'
import { readDaemonDiscovery } from '../server/daemon-discovery.ts'
import { ExecEngine } from '../server/exec-engine.ts'
import { inspectAntigravityHostHealth } from '../server/host-health.ts'
import { JobManager } from '../server/job-manager.ts'
import { OpsEngine } from '../server/ops-engine.ts'
import { AntigravityQuotaReader } from '../server/quota-reader.ts'
import { RustWorker } from '../server/rust-worker.ts'
import {
  DEFAULT_SESSION_ID,
  sanitizeSessionId,
  SessionManager,
} from '../server/session-manager.ts'
import { ShellDiscovery } from '../server/shells.ts'
import { SpillStore } from '../server/spill-store.ts'
import { resolveWorkspaceRoots } from '../server/workspace.ts'
import type { DaemonSyncStatus } from './format.ts'
import { TerminalClientError, type OpsBackendClient } from './tools.ts'

const HEALTHZ_TIMEOUT_MS = 800
const HEALTHZ_RETRY_DELAY_MS = 150
const DEFAULT_HTTP_TIMEOUT_MS = 30_000
const OPS_HTTP_TIMEOUT_MS = 60_000
const FALLBACK_VERSION = '1.0.0'
const ACTIVE_SESSION_FILENAME = 'active-session.json'
const ACTIVE_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days (supports resumed conversations across restarts)

export interface DaemonClientOptions {
  dataDir?: string
  healthTimeoutMs?: number
  getWorkspaceRoots?: (sessionId?: string) => Promise<string[]>
  explicitCwd?: string
  defaultSessionId?: string
}

interface ActiveSessionCacheEntry {
  filePath: string
  mtimeMs: number
  size: number
  conversationId: string
  updatedAt: number
}

interface LocalFallbackRuntime {
  configStore: ConfigStore
  shellDiscovery: ShellDiscovery
  spillStore: SpillStore
  sessionManager: SessionManager
  rustWorker: RustWorker
  jobManager: JobManager
  execEngine: ExecEngine
  opsEngine: OpsEngine
}

const activeSessionCache = new Map<string, ActiveSessionCacheEntry>()

/**
 * Reads `${dataDir}/active-session.json` written by `hook-session.mjs`, caching
 * by mtime + size so repeated tool calls pay only a single stat check when unchanged.
 * Falls back to `process.env.ANTIGRAVITY_CONVERSATION_ID || 'default'`.
 */
export function readActiveSessionId(dataDir: string = resolveDataDir()): string {
  const filePath = path.join(dataDir, ACTIVE_SESSION_FILENAME)
  try {
    const st = statSync(filePath)
    const cached = activeSessionCache.get(filePath)
    if (
      cached &&
      cached.mtimeMs === st.mtimeMs &&
      cached.size === st.size
    ) {
      if (Date.now() - cached.updatedAt <= ACTIVE_SESSION_MAX_AGE_MS) {
        return cached.conversationId
      }
      activeSessionCache.delete(filePath)
    } else {
      const rawText = readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(rawText) as Partial<ActiveSessionBinding>
      const rawId =
        typeof parsed?.conversationId === 'string' ? parsed.conversationId.trim() : ''
      const updatedAt =
        typeof parsed?.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
          ? parsed.updatedAt
          : 0
      if (
        rawId.length > 0 &&
        updatedAt > 0 &&
        Date.now() - updatedAt <= ACTIVE_SESSION_MAX_AGE_MS
      ) {
        const sanitized = sanitizeSessionId(rawId)
        activeSessionCache.set(filePath, {
          filePath,
          mtimeMs: st.mtimeMs,
          size: st.size,
          conversationId: sanitized,
          updatedAt,
        })
        return sanitized
      }
      activeSessionCache.delete(filePath)
    }
  } catch {
    activeSessionCache.delete(filePath)
  }

  const envId = process.env.ANTIGRAVITY_CONVERSATION_ID?.trim()
  if (envId && envId.toLowerCase() !== 'all') {
    return sanitizeSessionId(envId)
  }
  return DEFAULT_SESSION_ID
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref()
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function mapServerError(
  status: number,
  body: Record<string, unknown>,
  fallbackMessage: string,
): TerminalClientError {
  const code =
    typeof body.code === 'string' && body.code.length > 0
      ? body.code
      : status === 404
        ? 'NOT_FOUND'
        : status === 400
          ? 'BAD_REQUEST'
          : `HTTP_${status}`
  const message =
    typeof body.message === 'string' && body.message.length > 0
      ? body.message
      : fallbackMessage

  const isClientError = status >= 400 && status < 500
  const failure: FailureInfo = {
    code,
    message,
    effectState: isClientError ? 'none' : 'unknown',
    retry: isClientError ? 'after-input-change' : 'safe',
    nextAction:
      status === 404
        ? 'Verify the requested job or reference ID and retry.'
        : isClientError
          ? 'Correct the request parameters and retry.'
          : 'Run pulse_result({ action: "stats" }) or check [Pulse](sidecar://agy-pulse/pulse/) before retrying.',
  }
  return new TerminalClientError(failure)
}

function appendQueryParam(route: string, key: string, value: string): string {
  const sep = route.includes('?') ? '&' : '?'
  return `${route}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`
}

export class DaemonClient implements OpsBackendClient {
  readonly dataDir: string
  private readonly healthTimeoutMs: number
  private readonly explicitCwd?: string
  private readonly defaultSessionId?: string
  private readonly getWorkspaceRootsFn: (sessionId?: string) => Promise<string[]>
  private fallback: LocalFallbackRuntime | null = null
  private fallbackSessionTempDir: string | null = null
  private readonly quotaReader: AntigravityQuotaReader
  private cachedDaemon: {
    discovery: DaemonDiscovery
    mtimeMs: number
    size: number
  } | null = null
  private daemonJsonPath: string

  constructor(options: DaemonClientOptions = {}) {
    this.dataDir = options.dataDir ?? resolveDataDir()
    this.daemonJsonPath = path.join(this.dataDir, 'daemon.json')
    this.healthTimeoutMs = options.healthTimeoutMs ?? HEALTHZ_TIMEOUT_MS
    this.quotaReader = new AntigravityQuotaReader({ dataDir: this.dataDir })
    this.explicitCwd = options.explicitCwd?.trim()
      ? path.resolve(options.explicitCwd.trim())
      : undefined
    const defSess = options.defaultSessionId?.trim()
    this.defaultSessionId =
      defSess && defSess.toLowerCase() !== 'all' ? sanitizeSessionId(defSess) : undefined
    this.getWorkspaceRootsFn =
      options.getWorkspaceRoots ??
      ((sessionId?: string) => resolveWorkspaceRoots(sessionId, undefined, undefined, this.dataDir))
  }

  resolveSessionId(explicit?: string): string {
    if (typeof explicit === 'string') {
      const trimmed = explicit.trim()
      if (trimmed.length > 0 && trimmed.toLowerCase() !== 'all') {
        return sanitizeSessionId(trimmed)
      }
    }
    if (this.defaultSessionId) {
      return this.defaultSessionId
    }
    return readActiveSessionId(this.dataDir)
  }

  private getFallback(): LocalFallbackRuntime {
    if (!this.fallback) {
      const configStore = new ConfigStore(this.dataDir)
      const shellDiscovery = new ShellDiscovery()
      const spillStore = new SpillStore(this.dataDir, () => configStore.get())
      // Prevent transient fallback from overwriting live daemon session files when daemon.json is present.
      let sessionDataDir = this.dataDir
      if (existsSync(this.daemonJsonPath)) {
        try {
          this.fallbackSessionTempDir = mkdtempSync(
            path.join(tmpdir(), 'agy-pulse-fallback-sessions-'),
          )
          sessionDataDir = this.fallbackSessionTempDir
        } catch {
          sessionDataDir = this.dataDir
        }
      }
      const sessionManager = new SessionManager({
        dataDir: sessionDataDir,
        getConfig: () => configStore.get(),
        spillStore,
      })
      const rustWorker = new RustWorker()
      const jobManager = new JobManager({ spillStore })
      const execEngine = new ExecEngine({
        configStore,
        shellDiscovery,
        spillStore,
        jobManager,
        sessionManager,
        getWorkspaceRoots: this.getWorkspaceRootsFn,
      })
      const opsEngine = new OpsEngine({
        rustWorker,
        configStore,
        spillStore,
        sessionManager,
        getWorkspaceRoots: this.getWorkspaceRootsFn,
      })
      this.fallback = {
        configStore,
        shellDiscovery,
        spillStore,
        sessionManager,
        rustWorker,
        jobManager,
        execEngine,
        opsEngine,
      }
    }
    return this.fallback
  }

  private async probeDaemonOnce(): Promise<{
    discovery: DaemonDiscovery
    mtimeMs: number
    size: number
  } | null> {
    let st: { mtimeMs: number; size: number }
    try {
      const rawStat = statSync(this.daemonJsonPath)
      st = { mtimeMs: rawStat.mtimeMs, size: rawStat.size }
    } catch {
      return null
    }

    const discovery = readDaemonDiscovery(this.dataDir)
    if (!discovery) {
      return null
    }

    const url = `http://127.0.0.1:${discovery.port}/healthz`
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: 'GET',
          headers: {
            'X-Sidecar-Token': discovery.token,
            Accept: 'application/json',
          },
        },
        this.healthTimeoutMs,
      )
      if (!res.ok) {
        return null
      }
      return { discovery, mtimeMs: st.mtimeMs, size: st.size }
    } catch {
      return null
    }
  }

  /**
   * Resolves the live Sidecar daemon using an mtime+size cache over `${DATA_DIR}/daemon.json`,
   * avoiding per-call `/healthz` probes when the daemon metadata has not changed.
   * Retries a transient probe failure once after a short delay before falling back to local mode.
   */
  async discoverLiveDaemon(forceProbe = false): Promise<DaemonDiscovery | null> {
    let st: { mtimeMs: number; size: number }
    try {
      const rawStat = statSync(this.daemonJsonPath)
      st = { mtimeMs: rawStat.mtimeMs, size: rawStat.size }
    } catch {
      this.cachedDaemon = null
      return null
    }

    if (
      !forceProbe &&
      this.cachedDaemon &&
      this.cachedDaemon.mtimeMs === st.mtimeMs &&
      this.cachedDaemon.size === st.size
    ) {
      return this.cachedDaemon.discovery
    }

    const first = await this.probeDaemonOnce()
    if (first) {
      this.cachedDaemon = first
      return first.discovery
    }

    // Retry once after a brief delay in case the sidecar daemon is mid-restart or transiently busy.
    await new Promise((resolve) => {
      const t = setTimeout(resolve, HEALTHZ_RETRY_DELAY_MS)
      t.unref()
    })
    const second = await this.probeDaemonOnce()
    if (second) {
      this.cachedDaemon = second
      return second.discovery
    }

    this.cachedDaemon = null
    return null
  }

  private async requestJson<T>(
    daemon: DaemonDiscovery,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    route: string,
    body?: unknown,
    timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS,
    sessionId?: string,
    allowReconnectRetry = true,
  ): Promise<T> {
    const url = `http://127.0.0.1:${daemon.port}${route}`
    const headers: Record<string, string> = {
      'X-Sidecar-Token': daemon.token,
      Accept: 'application/json',
    }
    if (sessionId) {
      headers['X-Session-Id'] = sessionId
    }
    if (this.explicitCwd) {
      headers['X-Pulse-Cwd'] = this.explicitCwd
    }
    let payload: string | undefined
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8'
      payload = JSON.stringify(body)
    }

    let res: Response
    try {
      res = await fetchWithTimeout(
        url,
        {
          method,
          headers,
          body: payload,
        },
        timeoutMs,
      )
    } catch (err) {
      // Cached daemon may have restarted on a new port; invalidate and retry once if a fresh live daemon exists.
      this.cachedDaemon = null
      if (allowReconnectRetry) {
        const fresh = await this.discoverLiveDaemon(true)
        if (fresh && (fresh.port !== daemon.port || fresh.token !== daemon.token)) {
          return this.requestJson<T>(fresh, method, route, body, timeoutMs, sessionId, false)
        }
      }
      const detail = err instanceof Error ? err.message : String(err)
      throw new TerminalClientError({
        code: 'DAEMON_REQUEST_FAILED',
        message: `Sidecar daemon request (${method} ${route}) failed: ${detail}`,
        effectState: method === 'GET' ? 'none' : 'unknown',
        retry: method === 'GET' ? 'safe' : 'after-input-change',
        nextAction:
          'Check job/daemon status via pulse_job({ action: "list" }) or pulse_result({ action: "stats" }) before retrying.',
      })
    }

    if (res.status === 401 && allowReconnectRetry) {
      this.cachedDaemon = null
      const fresh = await this.discoverLiveDaemon(true)
      if (fresh && (fresh.port !== daemon.port || fresh.token !== daemon.token)) {
        return this.requestJson<T>(fresh, method, route, body, timeoutMs, sessionId, false)
      }
    }

    const text = await res.text()
    let parsed: unknown = {}
    if (text.trim().length > 0) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = { message: text.slice(0, 500) }
      }
    }

    if (!res.ok) {
      throw mapServerError(
        res.status,
        asRecord(parsed),
        `Sidecar daemon returned HTTP ${res.status} for ${method} ${route}.`,
      )
    }

    return parsed as T
  }

  async readFiles(req: ReadFilesRequest, sessionId?: string): Promise<ReadFilesOutcome> {
    const activeSessionId = this.resolveSessionId(sessionId)
    const daemon = await this.discoverLiveDaemon()
    if (daemon) {
      const raw = await this.requestJson<Record<string, unknown>>(
        daemon,
        'POST',
        '/api/pulse/read-files',
        {
          ...req,
          source: 'agent',
          sessionId: activeSessionId,
          ...(this.explicitCwd ? { cwd: this.explicitCwd } : {}),
        },
        OPS_HTTP_TIMEOUT_MS,
        activeSessionId,
      )
      return (raw.outcome ?? raw) as ReadFilesOutcome
    }

    const fb = this.getFallback()
    return fb.opsEngine.readFiles(req, 'agent', activeSessionId)
  }

  async search(req: SearchRequest, sessionId?: string): Promise<SearchOutcome> {
    const activeSessionId = this.resolveSessionId(sessionId)
    const daemon = await this.discoverLiveDaemon()
    if (daemon) {
      const raw = await this.requestJson<Record<string, unknown>>(
        daemon,
        'POST',
        '/api/pulse/search',
        {
          ...req,
          source: 'agent',
          sessionId: activeSessionId,
          ...(this.explicitCwd ? { cwd: this.explicitCwd } : {}),
        },
        OPS_HTTP_TIMEOUT_MS,
        activeSessionId,
      )
      return (raw.outcome ?? raw) as SearchOutcome
    }

    const fb = this.getFallback()
    return fb.opsEngine.search(req, 'agent', activeSessionId)
  }

  async mutate(req: MutateRequest, sessionId?: string): Promise<MutateOutcome> {
    const activeSessionId = this.resolveSessionId(sessionId)
    const daemon = await this.discoverLiveDaemon()
    if (daemon) {
      const raw = await this.requestJson<Record<string, unknown>>(
        daemon,
        'POST',
        '/api/pulse/mutate',
        {
          ...req,
          source: 'agent',
          sessionId: activeSessionId,
          ...(this.explicitCwd ? { cwd: this.explicitCwd } : {}),
        },
        OPS_HTTP_TIMEOUT_MS,
        activeSessionId,
      )
      return (raw.outcome ?? raw) as MutateOutcome
    }

    const fb = this.getFallback()
    return fb.opsEngine.mutate(req, 'agent', activeSessionId)
  }

  async readDoc(req: ReadDocRequest, sessionId?: string): Promise<ReadDocOutcome> {
    const activeSessionId = this.resolveSessionId(sessionId)
    const daemon = await this.discoverLiveDaemon()
    if (daemon) {
      const raw = await this.requestJson<Record<string, unknown>>(
        daemon,
        'POST',
        '/api/pulse/read-doc',
        {
          ...req,
          source: 'agent',
          sessionId: activeSessionId,
          ...(this.explicitCwd ? { cwd: this.explicitCwd } : {}),
        },
        OPS_HTTP_TIMEOUT_MS,
        activeSessionId,
      )
      return (raw.outcome ?? raw) as ReadDocOutcome
    }

    const fb = this.getFallback()
    return fb.opsEngine.readDoc(req, 'agent', activeSessionId)
  }

  async exec(req: ExecRequest, sessionId?: string): Promise<ExecOutcome> {
    const activeSessionId = this.resolveSessionId(sessionId)
    const daemon = await this.discoverLiveDaemon()
    if (daemon) {
      const requestedTimeout = req.timeoutMs ?? 60_000
      const httpTimeout = Math.max(DEFAULT_HTTP_TIMEOUT_MS, requestedTimeout + 15_000)
      const raw = await this.requestJson<Record<string, unknown>>(
        daemon,
        'POST',
        '/api/exec',
        {
          ...req,
          source: 'agent',
          sessionId: activeSessionId,
          ...(this.explicitCwd ? { cwd: this.explicitCwd } : {}),
        },
        httpTimeout,
        activeSessionId,
      )
      return (raw.outcome ?? raw) as ExecOutcome
    }

    const fb = this.getFallback()
    return fb.execEngine.execute(req, 'agent', activeSessionId)
  }

  async listJobs(): Promise<JobSummary[]> {
    const activeSessionId = this.resolveSessionId()
    const daemon = await this.discoverLiveDaemon()
    const localJobs = this.fallback ? this.fallback.jobManager.listJobs() : []

    if (daemon) {
      const raw = await this.requestJson<Record<string, unknown> | JobSummary[]>(
        daemon,
        'GET',
        appendQueryParam('/api/jobs', 'conversationId', activeSessionId),
        undefined,
        DEFAULT_HTTP_TIMEOUT_MS,
        activeSessionId,
      )
      const daemonJobs = Array.isArray(raw)
        ? raw
        : Array.isArray(raw.jobs)
          ? (raw.jobs as JobSummary[])
          : []
      if (localJobs.length === 0) return daemonJobs
      const seen = new Set(daemonJobs.map((j) => j.id))
      return [...daemonJobs, ...localJobs.filter((j) => !seen.has(j.id))]
    }

    const fb = this.getFallback()
    return fb.jobManager.listJobs()
  }

  async jobOutput(
    jobId: string,
    opts: {
      stdoutOffset?: number
      stderrOffset?: number
      wait?: boolean
      waitTimeoutMs?: number
      maxBytes?: number
    } = {},
  ): Promise<JobOutputResponse> {
    if (this.fallback?.jobManager.getJob(jobId)) {
      return this.fallback.jobManager.getOutput(jobId, opts)
    }

    const activeSessionId = this.resolveSessionId()
    const daemon = await this.discoverLiveDaemon()
    if (daemon) {
      const httpTimeout = Math.max(
        DEFAULT_HTTP_TIMEOUT_MS,
        (opts.wait ? (opts.waitTimeoutMs ?? 15_000) : 0) + 10_000,
      )
      const raw = await this.requestJson<Record<string, unknown>>(
        daemon,
        'POST',
        `/api/jobs/${encodeURIComponent(jobId)}/output`,
        { ...opts, sessionId: activeSessionId },
        httpTimeout,
        activeSessionId,
      )
      return (raw.output ?? raw) as JobOutputResponse
    }

    const fb = this.getFallback()
    try {
      return await fb.jobManager.getOutput(jobId, opts)
    } catch (err) {
      throw new TerminalClientError({
        code: 'JOB_NOT_FOUND',
        message: err instanceof Error ? err.message : String(err),
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: 'Call pulse_job({ action: "list" }) to inspect available job IDs.',
      })
    }
  }

  async jobInput(
    jobId: string,
    input: string,
  ): Promise<{ jobId: string; bytesWritten: number; job?: JobSummary }> {
    const bytesWritten = Buffer.byteLength(input, 'utf8')
    if (this.fallback?.jobManager.getJob(jobId)) {
      try {
        const res = this.fallback.jobManager.sendInput(jobId, input)
        return { jobId, bytesWritten, job: res.job }
      } catch (err) {
        throw new TerminalClientError({
          code: 'JOB_INPUT_FAILED',
          message: err instanceof Error ? err.message : String(err),
          effectState: 'none',
          retry: 'after-input-change',
          nextAction: 'Check job status via pulse_job({ action: "list" }).',
        })
      }
    }

    const activeSessionId = this.resolveSessionId()
    const daemon = await this.discoverLiveDaemon()
    if (daemon) {
      const raw = await this.requestJson<Record<string, unknown>>(
        daemon,
        'POST',
        `/api/jobs/${encodeURIComponent(jobId)}/input`,
        { input, data: input, sessionId: activeSessionId },
        DEFAULT_HTTP_TIMEOUT_MS,
        activeSessionId,
      )
      return {
        jobId,
        bytesWritten:
          typeof raw.bytesWritten === 'number' ? raw.bytesWritten : bytesWritten,
        job: raw.job as JobSummary | undefined,
      }
    }

    const fb = this.getFallback()
    try {
      const res = fb.jobManager.sendInput(jobId, input)
      return { jobId, bytesWritten, job: res.job }
    } catch (err) {
      throw new TerminalClientError({
        code: 'JOB_INPUT_FAILED',
        message: err instanceof Error ? err.message : String(err),
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: 'Call pulse_job({ action: "list" }) to verify the job is still running.',
      })
    }
  }

  async jobKill(
    jobId: string,
  ): Promise<{ jobId: string; killed: boolean; job?: JobSummary; note?: string }> {
    if (this.fallback?.jobManager.getJob(jobId)) {
      const prev = this.fallback.jobManager.getJob(jobId)
      const job = await this.fallback.jobManager.killJob(jobId)
      return {
        jobId,
        killed: prev?.status === 'running' || job.status === 'killed',
        job,
        note:
          prev?.status !== 'running'
            ? `Job "${jobId}" had already finished with status "${job.status}".`
            : undefined,
      }
    }

    const activeSessionId = this.resolveSessionId()
    const daemon = await this.discoverLiveDaemon()
    if (daemon) {
      const raw = await this.requestJson<Record<string, unknown>>(
        daemon,
        'POST',
        `/api/jobs/${encodeURIComponent(jobId)}/kill`,
        { sessionId: activeSessionId },
        DEFAULT_HTTP_TIMEOUT_MS,
        activeSessionId,
      )
      const job = raw.job as JobSummary | undefined
      return {
        jobId,
        killed: typeof raw.killed === 'boolean' ? raw.killed : true,
        job,
        note: typeof raw.note === 'string' ? raw.note : undefined,
      }
    }

    const fb = this.getFallback()
    try {
      const prev = fb.jobManager.getJob(jobId)
      const job = await fb.jobManager.killJob(jobId)
      return {
        jobId,
        killed: prev?.status === 'running' || job.status === 'killed',
        job,
      }
    } catch (err) {
      throw new TerminalClientError({
        code: 'JOB_NOT_FOUND',
        message: err instanceof Error ? err.message : String(err),
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: 'Call pulse_job({ action: "list" }) to inspect available job IDs.',
      })
    }
  }

  async pageResult(req: ResultPageRequest): Promise<ResultPageResponse> {
    const activeSessionId = this.resolveSessionId()
    const daemon = await this.discoverLiveDaemon()
    if (daemon) {
      const raw = await this.requestJson<Record<string, unknown>>(
        daemon,
        'POST',
        '/api/results/page',
        { ...req, sessionId: activeSessionId },
        DEFAULT_HTTP_TIMEOUT_MS,
        activeSessionId,
      )
      return (raw.page ?? raw.result ?? raw) as ResultPageResponse
    }

    const fb = this.getFallback()
    try {
      return fb.spillStore.pageResult(req)
    } catch (err) {
      throw new TerminalClientError({
        code: 'SPILL_NOT_FOUND',
        message: err instanceof Error ? err.message : String(err),
        effectState: 'none',
        retry: 'after-input-change',
        nextAction:
          'Verify the ref_id handle or call pulse_result({ action: "stats" }) to list active spills.',
      })
    }
  }

  async releaseResult(refId: string): Promise<{ refId: string; released: boolean }> {
    const activeSessionId = this.resolveSessionId()
    const daemon = await this.discoverLiveDaemon()
    if (daemon) {
      const raw = await this.requestJson<Record<string, unknown>>(
        daemon,
        'POST',
        '/api/results/release',
        { refId, sessionId: activeSessionId },
        DEFAULT_HTTP_TIMEOUT_MS,
        activeSessionId,
      )
      return {
        refId: typeof raw.refId === 'string' ? raw.refId : refId,
        released: Boolean(raw.released),
      }
    }

    const fb = this.getFallback()
    try {
      return fb.spillStore.releaseResult(refId)
    } catch (err) {
      throw new TerminalClientError({
        code: 'INVALID_REF_ID',
        message: err instanceof Error ? err.message : String(err),
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: 'Provide a valid stored reference handle (ref://spill/<id>).',
      })
    }
  }

  async listSpills(sessionId?: string, limit = 100): Promise<SpillEntrySummary[]> {
    const activeSessionId = this.resolveSessionId(sessionId)
    const daemon = await this.discoverLiveDaemon()
    if (daemon) {
      let route = `/api/results?limit=${encodeURIComponent(String(limit))}`
      route = appendQueryParam(route, 'conversationId', activeSessionId)
      const raw = await this.requestJson<Record<string, unknown>>(
        daemon,
        'GET',
        route,
        undefined,
        DEFAULT_HTTP_TIMEOUT_MS,
        activeSessionId,
      )
      return Array.isArray(raw.spills) ? (raw.spills as SpillEntrySummary[]) : []
    }

    const fb = this.getFallback()
    return fb.spillStore.listSpills(limit, activeSessionId)
  }

  async getSessions(): Promise<{
    sessions: SessionSummary[]
    activeSessionId: string
  }> {
    const activeSessionId = this.resolveSessionId()
    const daemon = await this.discoverLiveDaemon()
    if (daemon) {
      const raw = await this.requestJson<Record<string, unknown>>(
        daemon,
        'GET',
        appendQueryParam('/api/sessions', 'conversationId', activeSessionId),
        undefined,
        DEFAULT_HTTP_TIMEOUT_MS,
        activeSessionId,
      )
      return {
        sessions: Array.isArray(raw.sessions) ? (raw.sessions as SessionSummary[]) : [],
        activeSessionId:
          typeof raw.activeSessionId === 'string' && raw.activeSessionId.length > 0
            ? raw.activeSessionId
            : activeSessionId,
      }
    }

    const fb = this.getFallback()
    return {
      sessions: fb.sessionManager.listSessions(activeSessionId),
      activeSessionId,
    }
  }

  async getTelemetry(sessionId?: string): Promise<{
    telemetry: TokenSavingsSummary
    dedupEntryCount: number
    sessionId: string
  }> {
    const activeSessionId = this.resolveSessionId(sessionId)
    const daemon = await this.discoverLiveDaemon()
    if (daemon) {
      const raw = await this.requestJson<Record<string, unknown>>(
        daemon,
        'GET',
        appendQueryParam('/api/telemetry', 'conversationId', activeSessionId),
        undefined,
        DEFAULT_HTTP_TIMEOUT_MS,
        activeSessionId,
      )
      return {
        telemetry: raw.telemetry as TokenSavingsSummary,
        dedupEntryCount:
          typeof raw.dedupEntryCount === 'number' ? raw.dedupEntryCount : 0,
        sessionId:
          typeof raw.sessionId === 'string' && raw.sessionId.length > 0
            ? raw.sessionId
            : activeSessionId,
      }
    }

    const fb = this.getFallback()
    const tel = fb.sessionManager.getSessionTelemetry(activeSessionId)
    return {
      telemetry: tel.telemetry,
      dedupEntryCount: tel.dedupEntryCount,
      sessionId: tel.sessionId,
    }
  }

  async getShells(): Promise<{
    shells: ShellInfo[]
    config: TerminalConfig
    sync: DaemonSyncStatus
  }> {
    const { state, sync } = await this.getState()
    return {
      shells: state.shells,
      config: state.config,
      sync,
    }
  }

  async getQuotas(force = false): Promise<QuotaSnapshot> {
    const daemon = await this.discoverLiveDaemon()
    if (daemon) {
      try {
        const route = force ? '/api/quotas?refresh=1' : '/api/quotas'
        const raw = await this.requestJson<Record<string, unknown>>(
          daemon,
          force ? 'POST' : 'GET',
          force ? '/api/quotas/refresh' : route,
          force ? {} : undefined,
          DEFAULT_HTTP_TIMEOUT_MS,
        )
        const candidate = (raw.quotas ?? raw) as QuotaSnapshot
        if (candidate && candidate.provider === 'antigravity' && Array.isArray(candidate.pools)) {
          return candidate
        }
      } catch {
        // Fall through to GET /api/quotas?refresh=1 or local probe if daemon lacks the route.
        if (force) {
          try {
            const raw = await this.requestJson<Record<string, unknown>>(
              daemon,
              'GET',
              '/api/quotas?refresh=1',
              undefined,
              DEFAULT_HTTP_TIMEOUT_MS,
            )
            const candidate = (raw.quotas ?? raw) as QuotaSnapshot
            if (candidate && candidate.provider === 'antigravity' && Array.isArray(candidate.pools)) {
              return candidate
            }
          } catch {
          }
        }
      }
    }
    return this.quotaReader.getSnapshot(force)
  }

  async getHostHealth(): Promise<HostHealthSnapshot> {
    const daemon = await this.discoverLiveDaemon()
    if (daemon) {
      try {
        const raw = await this.requestJson<Record<string, unknown>>(
          daemon,
          'GET',
          '/api/host-health',
          undefined,
          DEFAULT_HTTP_TIMEOUT_MS,
        )
        const candidate = (raw.hostHealth ?? raw) as HostHealthSnapshot
        if (candidate && Array.isArray(candidate.entries)) {
          return candidate
        }
      } catch {
      }
    }
    return inspectAntigravityHostHealth()
  }

  async getState(sessionId?: string): Promise<{
    state: SidecarStateSnapshot
    sync: DaemonSyncStatus
  }> {
    const activeSessionId = this.resolveSessionId(sessionId)
    const daemon = await this.discoverLiveDaemon()
    if (daemon) {
      return this.getStateFromDaemon(daemon, activeSessionId)
    }

    const fb = this.getFallback()
    const [shells, workspaceRoots] = await Promise.all([
      fb.shellDiscovery.detect(),
      this.getWorkspaceRootsFn(activeSessionId),
    ])
    const config = fb.configStore.get()
    const primaryWorkspaceRoot = workspaceRoots[0] ?? process.cwd()
    const workerAvailable = fb.rustWorker.isAvailable()
    const workerPath = fb.rustWorker.getBinaryPath()
    const ctx = fb.sessionManager.peekSession(activeSessionId)
    const tel = fb.sessionManager.getSessionTelemetry(activeSessionId)
    const sessions = fb.sessionManager.listSessions(activeSessionId)
    const spills = fb.spillStore.listSpills(100, activeSessionId)
    const hostHealth = inspectAntigravityHostHealth()

    const state: SidecarStateSnapshot = {
      snapshotVersion: 1,
      workspaceRoots,
      primaryWorkspaceRoot,
      platform: process.platform,
      config,
      shells,
      jobs: fb.jobManager.listJobs(),
      activities: ctx ? ctx.activityStore.list() : [],
      unreadAnomalies: ctx ? ctx.activityStore.getUnreadAnomalies() : 0,
      daemonVersion: FALLBACK_VERSION,
      workerAvailable,
      workerPath,
      telemetry: tel.telemetry,
      spills,
      dedupEntryCount: tel.dedupEntryCount,
      sessionId: activeSessionId,
      sessionScope: 'conversation',
      sessions,
      quotas: this.quotaReader.getCached(),
      hostHealth,
    }

    return {
      state,
      sync: {
        connected: false,
        mode: 'local-fallback',
        version: FALLBACK_VERSION,
        mcpVersion: FALLBACK_VERSION,
        dataDir: this.dataDir,
        workspaceRoots,
        primaryWorkspaceRoot,
        workerAvailable,
        workerPath,
        dedupEntryCount: tel.dedupEntryCount,
        sessionId: activeSessionId,
      },
    }
  }

  private async getStateFromDaemon(
    daemon: DaemonDiscovery,
    activeSessionId: string,
  ): Promise<{
    state: SidecarStateSnapshot
    sync: DaemonSyncStatus
  }> {
    let route = appendQueryParam('/api/state', 'conversationId', activeSessionId)
    route = appendQueryParam(route, 'scope', 'conversation')
    const raw = await this.requestJson<Record<string, unknown>>(
      daemon,
      'GET',
      route,
      undefined,
      DEFAULT_HTTP_TIMEOUT_MS,
      activeSessionId,
    )
    const state = (raw.state ?? raw) as SidecarStateSnapshot
    return {
      state,
      sync: {
        connected: true,
        mode: 'sidecar-daemon',
        pid: daemon.pid,
        port: daemon.port,
        version: daemon.version || state.daemonVersion,
        dataDir: this.dataDir,
        workspaceRoots: state.workspaceRoots ?? [],
        primaryWorkspaceRoot: state.primaryWorkspaceRoot ?? process.cwd(),
        workerAvailable: Boolean(state.workerAvailable),
        workerPath: state.workerPath,
        dedupEntryCount: state.dedupEntryCount ?? 0,
        sessionId: state.sessionId ?? activeSessionId,
      },
    }
  }

  async dispose(): Promise<void> {
    this.cachedDaemon = null
    if (this.fallback) {
      this.fallback.rustWorker.dispose()
      // Never flush fallback session state over a live daemon's session files.
      if (!this.fallbackSessionTempDir && !existsSync(this.daemonJsonPath)) {
        this.fallback.sessionManager.flushAll()
      }
      await this.fallback.jobManager.disposeAll()
    }
    if (this.fallbackSessionTempDir) {
      try {
        rmSync(this.fallbackSessionTempDir, { recursive: true, force: true })
      } catch {
      }
      this.fallbackSessionTempDir = null
    }
  }
}

export function createDaemonClient(options?: DaemonClientOptions): DaemonClient {
  return new DaemonClient(options)
}
