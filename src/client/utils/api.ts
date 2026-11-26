import type {
  HostHealthSnapshot,
  JobOutputResponse,
  JobSummary,
  QuotaSnapshot,
  ResultPageRequest,
  ResultPageResponse,
  SessionSummary,
  ShellInfo,
  SidecarStateSnapshot,
  SpillEntrySummary,
  TerminalConfig,
  TokenSavingsSummary,
} from '../../shared/types.ts'

export interface SidecarBridge {
  conversationId: string | null
  fetch: (url: string, options?: RequestInit) => Promise<Response>
  getWorkspaceUris?: () => Promise<string[]>
  onWorkspaceChange?: (cb: (uris: string[]) => void) => () => void
  agent?: {
    sendMessage: (message: string, conversationId?: string) => Promise<unknown>
    startConversation?: (message: string, title?: string) => Promise<unknown>
    newConversation?: (message: string, model?: string) => Promise<unknown>
    getConversationMetadata?: (conversationId?: string) => Promise<unknown>
  }
  ui?: {
    toggleAuxPane?: (request: Record<string, unknown>) => boolean
    addArtifactComment?: (request: Record<string, unknown>) => boolean
  }
}

declare global {
  interface Window {
    sidecar?: SidecarBridge
    __agyPulseMounted?: boolean
    __AGY_PULSE_FIXTURE__?: Partial<SidecarStateSnapshot> & { __now?: number }
  }
}

export type SessionScope = 'conversation' | 'all'

export interface RequestContext {
  conversationId?: string | null
  sessionId?: string | null
  scope?: SessionScope
  workspaceRoot?: string | null
  workspaceRoots?: string[] | null
}

export interface TelemetryResponse {
  telemetry: TokenSavingsSummary
  dedupEntryCount?: number
  sessionId?: string
}

export interface ClearDedupResponse {
  cleared: number
  dedupEntryCount: number
}

export interface DeleteSessionResponse {
  deleted: boolean
  sessionId: string
  sessions?: SessionSummary[]
}

export interface SessionExportResponse {
  format?: 'markdown' | 'json'
  filename: string
  content: string
  savedPath?: string
}

export interface HostHealthRepairResponse {
  repaired: boolean
  detail: string
  snapshot: HostHealthSnapshot
}

export function getSearchToken(): string {
  if (typeof window === 'undefined') return ''
  return new URLSearchParams(window.location.search).get('token')?.trim() || ''
}

export function getFixtureParam(): string {
  if (typeof window === 'undefined') return ''
  return new URLSearchParams(window.location.search).get('fixture')?.trim() || ''
}

export function getConversationId(explicit?: string | null): string {
  if (explicit?.trim()) return explicit.trim()
  if (typeof window !== 'undefined') {
    const fromBridge = window.sidecar?.conversationId
    if (fromBridge?.trim()) return fromBridge.trim()
    const fromQuery = new URLSearchParams(window.location.search).get('conversationId')
    if (fromQuery?.trim()) return fromQuery.trim()
  }
  return ''
}

export function uriToPathClient(input: string): string {
  const trimmed = input.trim()
  if (!trimmed.startsWith('file://')) return trimmed
  try {
    const parsed = new URL(trimmed)
    let p = decodeURIComponent(parsed.pathname)
    if (/^\/[A-Za-z]:/.test(p)) {
      p = p.slice(1)
    }
    return p
  } catch {
    return trimmed.replace(/^file:\/\/\/?/, '')
  }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
  }

  const activeEl = document.activeElement instanceof HTMLElement ? document.activeElement : null
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '0'
    textarea.style.left = '0'
    textarea.style.opacity = '0'
    textarea.style.pointerEvents = 'none'
    document.body.appendChild(textarea)
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    textarea.remove()
    activeEl?.focus({ preventScroll: true })
    return ok
  } catch {
    activeEl?.focus({ preventScroll: true })
    return false
  }
}

export async function sendToConversation(message: string): Promise<'sent' | 'copied' | 'failed'> {
  const sendMessage = window.sidecar?.agent?.sendMessage
  if (typeof sendMessage === 'function') {
    try {
      const convId = getConversationId()
      await sendMessage(message, convId || undefined)
      return 'sent'
    } catch {
      // Fall back to clipboard if the Antigravity host bridge fails.
    }
  }
  const copied = await copyToClipboard(message)
  return copied ? 'copied' : 'failed'
}

export function triggerFileDownload(
  filename: string,
  content: string,
  mimeType = 'text/plain;charset=utf-8',
): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    return false
  }
  try {
    const blob = new Blob([content], { type: mimeType })
    const href = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = href
    link.download = filename
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => {
      try {
        URL.revokeObjectURL(href)
      } catch {
      }
    }, 1000)
    return true
  } catch {
    return false
  }
}

const DEFAULT_TIMEOUT_MS = 12_000

export function isAbortError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError')
}

async function sidecarFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const token = getSearchToken()
  const headers = new Headers(init.headers || {})
  if (token && !headers.has('X-Sidecar-Token')) {
    headers.set('X-Sidecar-Token', token)
  }

  const controller = new AbortController()
  const externalSignal = init.signal
  let timedOut = false
  const onExternalAbort = () => controller.abort(externalSignal?.reason)
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason)
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort(new Error('Request timed out'))
        }, timeoutMs)
      : null

  try {
    const reqInit: RequestInit = { ...init, headers, signal: controller.signal }
    if (window.sidecar?.fetch) {
      return await window.sidecar.fetch(url, reqInit)
    }
    return await fetch(url, reqInit)
  } catch (err) {
    if (timedOut) {
      throw new Error('Request timed out')
    }
    if (externalSignal?.aborted) {
      const abortErr = new Error('Request aborted')
      abortErr.name = 'AbortError'
      throw abortErr
    }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}

async function parseJson<T>(res: Response): Promise<T> {
  const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok || (raw && raw.ok === false)) {
    const failureObj =
      raw && typeof raw.failure === 'object' && raw.failure !== null
        ? (raw.failure as Record<string, unknown>)
        : null
    const message =
      (raw && typeof raw.message === 'string' && raw.message) ||
      (raw && typeof raw.error === 'string' && raw.error) ||
      (failureObj && typeof failureObj.message === 'string' && failureObj.message) ||
      `HTTP ${res.status}`
    throw new Error(message)
  }
  return raw as T
}

function normalizeRequestContext(ctx?: RequestContext | string): RequestContext {
  if (typeof ctx === 'string') {
    return { sessionId: ctx }
  }
  return ctx ?? {}
}

function resolveEffectiveSessionId(ctx?: RequestContext): string {
  const explicit = ctx?.sessionId?.trim() || ctx?.conversationId?.trim()
  if (explicit) return explicit
  return getConversationId()
}

function buildUrl(
  path: string,
  params: Record<string, string | number | boolean | undefined | null> = {},
  ctx?: RequestContext,
): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      qs.set(k, String(v))
    }
  }
  const convId = resolveEffectiveSessionId(ctx)
  if (convId && !qs.has('conversationId')) {
    qs.set('conversationId', convId)
  }
  if (ctx?.scope && !qs.has('scope')) {
    qs.set('scope', ctx.scope)
  }
  const token = getSearchToken()
  if (token) {
    qs.set('token', token)
  }
  const q = qs.toString()
  return q ? `${path}?${q}` : path
}

export async function fetchFixtureSnapshot(
  fixtureName: string,
  signal?: AbortSignal,
): Promise<Partial<SidecarStateSnapshot> & { __now?: number }> {
  const clean = fixtureName.replace(/[^a-zA-Z0-9._-]/g, '')
  const file = clean.endsWith('.json') ? clean : `${clean}.json`
  const res = await fetch(`./fixtures/${file}`, { signal })
  if (!res.ok) {
    throw new Error(`Failed to load fixture ${file} (HTTP ${res.status})`)
  }
  return (await res.json()) as Partial<SidecarStateSnapshot> & { __now?: number }
}

export async function fetchState(
  ctx: RequestContext = {},
  signal?: AbortSignal,
): Promise<SidecarStateSnapshot> {
  const qs = new URLSearchParams()
  const convId = resolveEffectiveSessionId(ctx)
  if (convId) qs.set('conversationId', convId)
  if (ctx.scope) qs.set('scope', ctx.scope)
  if (ctx.workspaceRoot) qs.set('workspaceRoot', ctx.workspaceRoot)
  if (ctx.workspaceRoots) {
    for (const root of ctx.workspaceRoots) {
      if (root?.trim()) qs.append('workspaceRoots', root.trim())
    }
  }
  const token = getSearchToken()
  if (token) qs.set('token', token)
  const query = qs.toString()
  const res = await sidecarFetch(query ? `/api/state?${query}` : '/api/state', { signal }, 10_000)
  const data = await parseJson<SidecarStateSnapshot & { state?: SidecarStateSnapshot }>(res)
  return data.state ?? data
}

export interface LiveEventsResponse {
  seq: number
  changed: boolean
  state?: SidecarStateSnapshot
}

export async function fetchLiveEvents(
  since: number,
  waitMs = 5_000,
  ctx: RequestContext = {},
  signal?: AbortSignal,
): Promise<LiveEventsResponse> {
  const clampedWait = Math.max(0, Math.min(10_000, Math.floor(waitMs)))
  const qs = new URLSearchParams()
  qs.set('since', String(Math.max(0, Math.floor(since))))
  qs.set('waitMs', String(clampedWait))
  const convId = resolveEffectiveSessionId(ctx)
  if (convId) qs.set('conversationId', convId)
  if (ctx.scope) qs.set('scope', ctx.scope)
  if (ctx.workspaceRoot) qs.set('workspaceRoot', ctx.workspaceRoot)
  if (ctx.workspaceRoots) {
    for (const root of ctx.workspaceRoots) {
      if (root?.trim()) qs.append('workspaceRoots', root.trim())
    }
  }
  const token = getSearchToken()
  if (token) qs.set('token', token)
  const res = await sidecarFetch(
    `/api/events?${qs.toString()}`,
    { signal },
    Math.max(5_000, clampedWait + 4_000),
  )
  return parseJson<LiveEventsResponse>(res)
}

export async function fetchQuotas(signal?: AbortSignal): Promise<QuotaSnapshot | null> {
  const res = await sidecarFetch(buildUrl('/api/quotas'), { signal }, 30_000)
  const data = await parseJson<{ quotas?: QuotaSnapshot | null } & Partial<QuotaSnapshot>>(res)
  if ('quotas' in data) return data.quotas ?? null
  return data.provider ? (data as QuotaSnapshot) : null
}

export async function refreshQuotas(): Promise<QuotaSnapshot | null> {
  const res = await sidecarFetch(
    buildUrl('/api/quotas/refresh'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
    30_000,
  )
  const data = await parseJson<{ quotas?: QuotaSnapshot | null } & Partial<QuotaSnapshot>>(res)
  if ('quotas' in data) return data.quotas ?? null
  return data.provider ? (data as QuotaSnapshot) : null
}

export async function fetchHostHealth(signal?: AbortSignal): Promise<HostHealthSnapshot | null> {
  const res = await sidecarFetch(buildUrl('/api/host-health'), { signal })
  const data = await parseJson<
    { hostHealth?: HostHealthSnapshot | null } & Partial<HostHealthSnapshot>
  >(res)
  if ('hostHealth' in data) return data.hostHealth ?? null
  return Array.isArray(data.entries) ? (data as HostHealthSnapshot) : null
}

export async function repairHostHealth(): Promise<HostHealthRepairResponse> {
  const res = await sidecarFetch(buildUrl('/api/host-health/repair'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const data = await parseJson<
    Partial<HostHealthRepairResponse> & { hostHealth?: HostHealthSnapshot }
  >(res)
  return {
    repaired: Boolean(data.repaired),
    detail: data.detail || (data.repaired ? 'Host MCP config repaired.' : 'No repair needed.'),
    snapshot: data.snapshot ??
      data.hostHealth ?? {
        checkedAt: Date.now(),
        entries: [],
        warnings: [],
      },
  }
}

export async function fetchSessions(ctx: RequestContext = {}): Promise<SessionSummary[]> {
  const res = await sidecarFetch(buildUrl('/api/sessions', {}, ctx))
  const data = await parseJson<{ sessions?: SessionSummary[] } | SessionSummary[]>(res)
  if (Array.isArray(data)) return data
  return Array.isArray(data.sessions) ? data.sessions : []
}

export async function deleteSession(sessionId: string): Promise<DeleteSessionResponse> {
  const res = await sidecarFetch(buildUrl(`/api/sessions/${encodeURIComponent(sessionId)}`), {
    method: 'DELETE',
  })
  const data = await parseJson<Partial<DeleteSessionResponse>>(res)
  return {
    deleted: data.deleted ?? true,
    sessionId: data.sessionId ?? sessionId,
    sessions: Array.isArray(data.sessions) ? data.sessions : undefined,
  }
}

export async function exportSessionReport(
  sessionId: string,
  format: 'markdown' | 'json',
  options: { saveToDownloads?: boolean } = {},
): Promise<SessionExportResponse> {
  const targetId = sessionId.trim() || getConversationId() || 'default'
  const save = options.saveToDownloads === true
  const res = await sidecarFetch(
    buildUrl(`/api/sessions/${encodeURIComponent(targetId)}/export`, {
      format,
      scope: targetId === 'all' ? 'all' : undefined,
      ...(save ? { save: 1 } : {}),
    }),
    save
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }
      : undefined,
  )
  const data = await parseJson<Partial<SessionExportResponse>>(res)
  const ext = format === 'json' ? 'json' : 'md'
  return {
    format: data.format ?? format,
    filename: data.filename || `agy-pulse-${targetId.slice(0, 12)}.${ext}`,
    content: typeof data.content === 'string' ? data.content : '',
    savedPath: typeof data.savedPath === 'string' ? data.savedPath : undefined,
  }
}

export async function fetchShells(refresh = false): Promise<ShellInfo[]> {
  const url = buildUrl('/api/shells', refresh ? { refresh: true } : {})
  const res = await sidecarFetch(url)
  const data = await parseJson<{ shells?: ShellInfo[] } | ShellInfo[]>(res)
  if (Array.isArray(data)) return data
  return Array.isArray(data.shells) ? data.shells : []
}

export async function fetchConfig(): Promise<TerminalConfig> {
  const res = await sidecarFetch(buildUrl('/api/config'))
  const data = await parseJson<TerminalConfig & { config?: TerminalConfig }>(res)
  return data.config ?? data
}

export async function updateConfig(patch: Partial<TerminalConfig>): Promise<TerminalConfig> {
  const res = await sidecarFetch(buildUrl('/api/config'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data = await parseJson<TerminalConfig & { config?: TerminalConfig }>(res)
  return data.config ?? data
}

export async function patchConfig(patch: Partial<TerminalConfig>): Promise<TerminalConfig> {
  // Use POST (accepted alongside PATCH/PUT by /api/config) so host WebView HTTP proxies never drop PATCH.
  const res = await sidecarFetch(buildUrl('/api/config'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data = await parseJson<TerminalConfig & { config?: TerminalConfig }>(res)
  return data.config ?? data
}

export async function resetConfig(): Promise<TerminalConfig> {
  const res = await sidecarFetch(buildUrl('/api/config/reset'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const data = await parseJson<TerminalConfig & { config?: TerminalConfig }>(res)
  return data.config ?? data
}

export async function fetchTelemetry(ctx: RequestContext = {}): Promise<TelemetryResponse> {
  const res = await sidecarFetch(buildUrl('/api/telemetry', {}, ctx))
  const data = await parseJson<
    TokenSavingsSummary & {
      telemetry?: TokenSavingsSummary
      dedupEntryCount?: number
      sessionId?: string
    }
  >(res)
  return {
    telemetry: data.telemetry ?? data,
    dedupEntryCount: typeof data.dedupEntryCount === 'number' ? data.dedupEntryCount : undefined,
    sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
  }
}

export async function resetTelemetry(
  ctxOrSessionId?: RequestContext | string,
): Promise<TelemetryResponse> {
  const ctx = normalizeRequestContext(ctxOrSessionId)
  const effectiveSessionId = resolveEffectiveSessionId(ctx)
  const payload: Record<string, unknown> = {}
  if (effectiveSessionId) payload.sessionId = effectiveSessionId
  if (ctx.scope) payload.scope = ctx.scope
  const res = await sidecarFetch(buildUrl('/api/telemetry/reset', {}, ctx), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await parseJson<
    TokenSavingsSummary & {
      telemetry?: TokenSavingsSummary
      dedupEntryCount?: number
      sessionId?: string
    }
  >(res)
  return {
    telemetry: data.telemetry ?? data,
    dedupEntryCount: typeof data.dedupEntryCount === 'number' ? data.dedupEntryCount : undefined,
    sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
  }
}

export async function clearDedupCache(
  ctxOrSessionId?: RequestContext | string,
): Promise<ClearDedupResponse> {
  const ctx = normalizeRequestContext(ctxOrSessionId)
  const effectiveSessionId = resolveEffectiveSessionId(ctx)
  const payload: Record<string, unknown> = {}
  if (effectiveSessionId) payload.sessionId = effectiveSessionId
  if (ctx.scope) payload.scope = ctx.scope
  const res = await sidecarFetch(buildUrl('/api/cache/clear-dedup', {}, ctx), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await parseJson<{ cleared?: number; dedupEntryCount?: number }>(res)
  return {
    cleared: typeof data.cleared === 'number' ? data.cleared : 0,
    dedupEntryCount: typeof data.dedupEntryCount === 'number' ? data.dedupEntryCount : 0,
  }
}

export async function fetchJobs(ctx: RequestContext = {}): Promise<JobSummary[]> {
  const res = await sidecarFetch(buildUrl('/api/jobs', {}, ctx))
  const data = await parseJson<{ jobs?: JobSummary[] } | JobSummary[]>(res)
  if (Array.isArray(data)) return data
  return Array.isArray(data.jobs) ? data.jobs : []
}

export async function fetchJobOutput(
  jobId: string,
  opts: {
    stdoutOffset?: number
    stderrOffset?: number
    wait?: boolean
    waitTimeoutMs?: number
    maxBytes?: number
  } = {},
): Promise<JobOutputResponse> {
  const timeout = opts.wait
    ? Math.max(DEFAULT_TIMEOUT_MS, (opts.waitTimeoutMs ?? 15_000) + 5000)
    : DEFAULT_TIMEOUT_MS
  const res = await sidecarFetch(
    buildUrl(`/api/jobs/${encodeURIComponent(jobId)}/output`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    },
    timeout,
  )
  const data = await parseJson<JobOutputResponse & { output?: JobOutputResponse }>(res)
  return data.output ?? data
}

export async function sendJobInput(jobId: string, input: string): Promise<void> {
  const res = await sidecarFetch(buildUrl(`/api/jobs/${encodeURIComponent(jobId)}/input`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  })
  await parseJson(res)
}

export async function killJob(jobId: string): Promise<JobSummary | undefined> {
  const res = await sidecarFetch(buildUrl(`/api/jobs/${encodeURIComponent(jobId)}/kill`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const data = await parseJson<{ job?: JobSummary }>(res)
  return data.job
}

export async function fetchResults(ctx: RequestContext = {}): Promise<SpillEntrySummary[]> {
  const res = await sidecarFetch(buildUrl('/api/results', {}, ctx))
  const data = await parseJson<
    { spills?: SpillEntrySummary[]; results?: SpillEntrySummary[] } | SpillEntrySummary[]
  >(res)
  if (Array.isArray(data)) return data
  if (Array.isArray(data.spills)) return data.spills
  if (Array.isArray(data.results)) return data.results
  return []
}

export async function pageResult(req: ResultPageRequest): Promise<ResultPageResponse> {
  const res = await sidecarFetch(buildUrl('/api/results/page'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  const data = await parseJson<ResultPageResponse & { page?: ResultPageResponse }>(res)
  return data.page ?? data
}

export async function releaseResult(refId: string): Promise<void> {
  const res = await sidecarFetch(buildUrl('/api/results/release'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refId }),
  })
  await parseJson(res)
}

export async function acknowledgeActivities(
  ctxOrSessionId?: RequestContext | string,
): Promise<{ unreadAnomalies: number }> {
  const ctx = normalizeRequestContext(ctxOrSessionId)
  const effectiveSessionId = resolveEffectiveSessionId(ctx)
  const payload: Record<string, unknown> = {}
  if (effectiveSessionId) payload.sessionId = effectiveSessionId
  if (ctx.scope) payload.scope = ctx.scope
  const res = await sidecarFetch(buildUrl('/api/activity/ack', {}, ctx), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await parseJson<{ unreadAnomalies?: number }>(res)
  return { unreadAnomalies: typeof data.unreadAnomalies === 'number' ? data.unreadAnomalies : 0 }
}
