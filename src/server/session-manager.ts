import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { resolveDataDir } from '../shared/paths.ts'
import {
  DEFAULT_TERMINAL_CONFIG,
  type ActiveSessionBinding,
  type ActivityItem,
  type SavingsCategory,
  type SessionSummary,
  type SpillEntrySummary,
  type TerminalConfig,
  type TokenSavingsSummary,
} from '../shared/types.ts'
import { ActivityStore, type ActivityEventPayload } from './activity-store.ts'
import { ReadDedupStore, type PersistedReadDedupSnapshot } from './read-dedup.ts'
import type { SpillStore } from './spill-store.ts'
import {
  ALL_SAVINGS_CATEGORIES,
  createEmptyBreakdown,
  mergeTokenSavingsSummaries,
  TelemetryStore,
} from './telemetry-store.ts'

export const DEFAULT_SESSION_ID = 'default'
const ACTIVE_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days (supports resumed conversations across restarts)
const MAX_PERSISTED_ACTIVITIES = 50
const PERSIST_DEBOUNCE_MS = 300

const CATEGORY_LABELS: Record<SavingsCategory, string> = {
  'read-dedup': 'Read Deduplication',
  'outline-read': 'Outline Reads',
  'symbol-read': 'Symbol Reads',
  'batch-read': 'Batch File Reads',
  'grep-progressive': 'Progressive Grep / Definitions',
  'git-compact': 'Compact Git',
  'json-digest': 'JSON Digest',
  spillover: 'Spillover Paging',
  'batch-mutate': 'Batch Mutations',
  'native-doc': 'Native Doc Readers',
}

export interface SessionContext {
  readonly sessionId: string
  label: string
  workspaceRoot?: string
  createdAt: number
  updatedAt: number
  estimatedApiCostUsd?: number
  estimatedCacheSavingsUsd?: number
  readonly telemetryStore: TelemetryStore
  readonly readDedupStore: ReadDedupStore
  readonly activityStore: ActivityStore
}

export interface SessionTelemetryEvent {
  sessionId: string
  telemetry: TokenSavingsSummary
  dedupEntryCount: number
}

export interface SessionActivityEvent {
  sessionId: string
  item: ActivityItem
  unreadAnomalies: number
}

export interface SessionAckEvent {
  sessionId: string
  unreadAnomalies: number
}

export interface SessionExportReport {
  format: 'markdown' | 'json'
  filename: string
  content: string
}

interface PersistedSessionRecord {
  version: 1
  sessionId: string
  label: string
  workspaceRoot?: string
  createdAt: number
  updatedAt: number
  estimatedApiCostUsd?: number
  estimatedCacheSavingsUsd?: number
  telemetry: TokenSavingsSummary
  activities: ActivityItem[]
  readDedup?: PersistedReadDedupSnapshot
}

export function normalizeWorkspaceKey(root?: string | null): string | null {
  if (typeof root !== 'string') return null
  const trimmed = root.trim()
  if (!trimmed) return null
  const resolved = path.resolve(trimmed).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export interface SessionManagerDeps {
  dataDir?: string
  getConfig: () => TerminalConfig
  spillStore: SpillStore
}

export function sanitizeSessionId(raw?: string | null): string {
  if (typeof raw !== 'string') return DEFAULT_SESSION_ID
  const trimmed = raw.trim()
  if (!trimmed || trimmed.toLowerCase() === 'all') return DEFAULT_SESSION_ID
  const cleaned = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 96)
  if (!cleaned || cleaned.toLowerCase() === 'all') return DEFAULT_SESSION_ID
  return cleaned
}

export function makeSessionLabel(sessionId: string): string {
  if (sessionId === DEFAULT_SESSION_ID) return 'Default Session'
  const shortId = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId
  return `Session ${shortId}`
}

export function readActiveSessionBinding(dataDir: string): ActiveSessionBinding | null {
  const filePath = path.join(dataDir, 'active-session.json')
  try {
    if (!existsSync(filePath)) return null
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<ActiveSessionBinding>
    if (!raw || typeof raw.conversationId !== 'string' || raw.conversationId.trim().length === 0) {
      return null
    }
    const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : 0
    if (updatedAt <= 0 || Date.now() - updatedAt > ACTIVE_SESSION_MAX_AGE_MS) {
      return null
    }
    return {
      conversationId: raw.conversationId.trim(),
      workspacePaths: Array.isArray(raw.workspacePaths)
        ? raw.workspacePaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : undefined,
      updatedAt,
      toolCallId: typeof raw.toolCallId === 'string' ? raw.toolCallId : undefined,
    }
  } catch {
    return null
  }
}

function createEmptyTelemetrySummary(): TokenSavingsSummary {
  return {
    totalCalls: 0,
    totalRawBytes: 0,
    totalDeliveredBytes: 0,
    totalSavedBytes: 0,
    estimatedTokensSaved: 0,
    roundTripsSaved: 0,
    dedupHits: 0,
    avgDurationMs: 0,
    byCategory: createEmptyBreakdown(),
  }
}

function formatBytesHuman(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${Math.round(bytes)} B`
}

export class SessionManager extends EventEmitter {
  readonly dataDir: string
  readonly sessionsDir: string
  private readonly getConfig: () => TerminalConfig
  private readonly spillStore: SpillStore
  private readonly sessions = new Map<string, SessionContext>()
  private readonly persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly dirtySessions = new Set<string>()

  constructor(deps: SessionManagerDeps) {
    super()
    this.dataDir = deps.dataDir ?? resolveDataDir()
    this.sessionsDir = path.join(this.dataDir, 'sessions')
    this.getConfig = deps.getConfig ?? (() => DEFAULT_TERMINAL_CONFIG)
    this.spillStore = deps.spillStore

    this.loadPersistedSessions()
    this.pruneSessions()
  }

  /**
   * Resolves the effective conversation session ID:
   * 1. Explicit non-empty session/conversation ID (excluding 'all').
   * 2. Fresh `${DATA_DIR}/active-session.json` written by `hook-session.mjs` (<= 30d old).
   * 3. `ANTIGRAVITY_CONVERSATION_ID` environment variable.
   * 4. Fallback `'default'`.
   */
  resolveSessionId(explicit?: string | null): string {
    if (typeof explicit === 'string') {
      const trimmed = explicit.trim()
      if (trimmed.length > 0 && trimmed.toLowerCase() !== 'all') {
        return sanitizeSessionId(trimmed)
      }
    }

    const binding = readActiveSessionBinding(this.dataDir)
    if (binding?.conversationId) {
      return sanitizeSessionId(binding.conversationId)
    }

    const envConv = process.env.ANTIGRAVITY_CONVERSATION_ID?.trim()
    if (envConv && envConv.toLowerCase() !== 'all') {
      return sanitizeSessionId(envConv)
    }

    return DEFAULT_SESSION_ID
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sanitizeSessionId(sessionId))
  }

  /**
   * Returns an existing SessionContext without creating a new entry if absent.
   */
  peekSession(sessionId?: string | null): SessionContext | undefined {
    const resolved = this.resolveSessionId(sessionId)
    return this.sessions.get(resolved)
  }

  getSession(sessionId?: string | null, workspaceRoot?: string): SessionContext {
    const resolved = this.resolveSessionId(sessionId)
    const existing = this.sessions.get(resolved)
    if (existing) {
      if (workspaceRoot && workspaceRoot.trim().length > 0 && !existing.workspaceRoot) {
        existing.workspaceRoot = workspaceRoot.trim()
      }
      return existing
    }

    const now = Date.now()
    const ctx = this.createSessionContext({
      sessionId: resolved,
      label: makeSessionLabel(resolved),
      workspaceRoot: workspaceRoot?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    })

    this.sessions.set(resolved, ctx)
    this.pruneSessions([resolved])
    this.emit('sessions-changed')
    return ctx
  }

  private createSessionContext(meta: {
    sessionId: string
    label: string
    workspaceRoot?: string
    createdAt: number
    updatedAt: number
  }): SessionContext {
    const telemetryStore = new TelemetryStore()
    const readDedupStore = new ReadDedupStore(() => this.getConfig().enableReadDedup)
    const activityStore = new ActivityStore(200, meta.sessionId)

    const ctx: SessionContext = {
      sessionId: meta.sessionId,
      label: meta.label,
      workspaceRoot: meta.workspaceRoot,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      telemetryStore,
      readDedupStore,
      activityStore,
    }

    telemetryStore.on('telemetry', (telemetry: TokenSavingsSummary) => {
      ctx.updatedAt = Date.now()
      this.schedulePersist(ctx.sessionId)
      const payload: SessionTelemetryEvent = {
        sessionId: ctx.sessionId,
        telemetry,
        dedupEntryCount: ctx.readDedupStore.size(),
      }
      this.emit('telemetry', payload)
    })

    activityStore.on('activity', (ev: ActivityEventPayload) => {
      ctx.updatedAt = Date.now()
      this.schedulePersist(ctx.sessionId)
      const payload: SessionActivityEvent = {
        sessionId: ctx.sessionId,
        item: ev.item,
        unreadAnomalies: ev.unreadAnomalies,
      }
      this.emit('activity', payload)
    })

    activityStore.on('ack', (ev: { unreadAnomalies: number }) => {
      this.schedulePersist(ctx.sessionId)
      const payload: SessionAckEvent = {
        sessionId: ctx.sessionId,
        unreadAnomalies: ev.unreadAnomalies,
      }
      this.emit('ack', payload)
    })

    return ctx
  }

  private getSessionFilePath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sanitizeSessionId(sessionId)}.json`)
  }

  private loadPersistedSessions(): void {
    if (!existsSync(this.sessionsDir)) return

    let entries: string[]
    try {
      entries = readdirSync(this.sessionsDir)
    } catch {
      return
    }

    for (const fileName of entries) {
      if (!fileName.endsWith('.json')) continue
      const fullPath = path.join(this.sessionsDir, fileName)
      try {
        const parsed = JSON.parse(readFileSync(fullPath, 'utf-8')) as Partial<PersistedSessionRecord>
        if (!parsed || typeof parsed !== 'object') continue

        const fallbackId = fileName.slice(0, -'.json'.length)
        const sessionId = sanitizeSessionId(
          typeof parsed.sessionId === 'string' && parsed.sessionId.trim().length > 0
            ? parsed.sessionId
            : fallbackId,
        )
        const createdAt =
          typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt)
            ? parsed.createdAt
            : Date.now()
        const updatedAt =
          typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
            ? parsed.updatedAt
            : createdAt
        const label =
          typeof parsed.label === 'string' && parsed.label.trim().length > 0
            ? parsed.label.trim()
            : makeSessionLabel(sessionId)
        const workspaceRoot =
          typeof parsed.workspaceRoot === 'string' && parsed.workspaceRoot.trim().length > 0
            ? parsed.workspaceRoot.trim()
            : undefined

        const ctx = this.createSessionContext({
          sessionId,
          label,
          workspaceRoot,
          createdAt,
          updatedAt,
        })

        if (
          typeof parsed.estimatedApiCostUsd === 'number' &&
          Number.isFinite(parsed.estimatedApiCostUsd) &&
          parsed.estimatedApiCostUsd >= 0
        ) {
          ctx.estimatedApiCostUsd = parsed.estimatedApiCostUsd
        }
        if (
          typeof parsed.estimatedCacheSavingsUsd === 'number' &&
          Number.isFinite(parsed.estimatedCacheSavingsUsd) &&
          parsed.estimatedCacheSavingsUsd >= 0
        ) {
          ctx.estimatedCacheSavingsUsd = parsed.estimatedCacheSavingsUsd
        }
        if (parsed.telemetry && typeof parsed.telemetry === 'object') {
          ctx.telemetryStore.hydrate(parsed.telemetry)
        }
        if (Array.isArray(parsed.activities)) {
          ctx.activityStore.hydrate(parsed.activities.slice(0, MAX_PERSISTED_ACTIVITIES))
        }
        if (parsed.readDedup && typeof parsed.readDedup === 'object') {
          ctx.readDedupStore.hydrateSnapshot(parsed.readDedup)
        }

        this.sessions.set(sessionId, ctx)
      } catch {
        // Ignore corrupted or partially written session files.
      }
    }
  }

  private schedulePersist(sessionId: string): void {
    this.dirtySessions.add(sessionId)
    const existing = this.persistTimers.get(sessionId)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.persistTimers.delete(sessionId)
      this.persistSessionNow(sessionId)
    }, PERSIST_DEBOUNCE_MS)
    timer.unref()
    this.persistTimers.set(sessionId, timer)
  }

  private persistSessionNow(sessionId: string): void {
    this.dirtySessions.delete(sessionId)
    const ctx = this.sessions.get(sessionId)
    if (!ctx) return

    try {
      mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 })
      const readDedupSnapshot = ctx.readDedupStore.exportSnapshot()
      const record: PersistedSessionRecord = {
        version: 1,
        sessionId: ctx.sessionId,
        label: ctx.label,
        ...(ctx.workspaceRoot ? { workspaceRoot: ctx.workspaceRoot } : {}),
        createdAt: ctx.createdAt,
        updatedAt: ctx.updatedAt,
        ...(typeof ctx.estimatedApiCostUsd === 'number' && ctx.estimatedApiCostUsd > 0
          ? { estimatedApiCostUsd: ctx.estimatedApiCostUsd }
          : {}),
        ...(typeof ctx.estimatedCacheSavingsUsd === 'number' && ctx.estimatedCacheSavingsUsd > 0
          ? { estimatedCacheSavingsUsd: ctx.estimatedCacheSavingsUsd }
          : {}),
        telemetry: ctx.telemetryStore.getSummary(),
        activities: ctx.activityStore.list(MAX_PERSISTED_ACTIVITIES),
        ...(readDedupSnapshot.entries.length > 0 || readDedupSnapshot.textRanges.length > 0
          ? { readDedup: readDedupSnapshot }
          : {}),
      }
      const targetPath = this.getSessionFilePath(ctx.sessionId)
      const tempPath = `${targetPath}.${process.pid}.tmp`
      const serialized = `${JSON.stringify(record, null, 2)}\n`

      writeFileSync(tempPath, serialized, { encoding: 'utf-8', mode: 0o600 })
      try {
        renameSync(tempPath, targetPath)
      } catch {
        writeFileSync(targetPath, serialized, { encoding: 'utf-8', mode: 0o600 })
        try {
          if (existsSync(tempPath)) unlinkSync(tempPath)
        } catch {
          // Best-effort temp cleanup.
        }
      }
    } catch {
      // Persistence failure is non-fatal for live operations.
    }
  }

  /**
   * Synchronously flushes all pending dirty sessions to disk (called on graceful shutdown).
   */
  flushAll(): void {
    for (const [sessionId, timer] of this.persistTimers.entries()) {
      clearTimeout(timer)
      this.persistTimers.delete(sessionId)
      this.dirtySessions.add(sessionId)
    }
    for (const sessionId of [...this.dirtySessions]) {
      this.persistSessionNow(sessionId)
    }
  }

  /**
   * Enforces automatic session retention (TTL by `sessionRetentionDays`) and LRU cap
   * (`sessionMaxCount`), deleting both session JSON files and associated spill artifacts.
   */
  pruneSessions(protectedIds: Iterable<string> = []): number {
    const cfg = this.getConfig()
    const retentionDays = Math.max(1, cfg.sessionRetentionDays || DEFAULT_TERMINAL_CONFIG.sessionRetentionDays)
    const maxCount = Math.max(5, cfg.sessionMaxCount || DEFAULT_TERMINAL_CONFIG.sessionMaxCount)
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000

    const protectedSet = new Set<string>()
    for (const id of protectedIds) {
      protectedSet.add(sanitizeSessionId(id))
    }
    const activeBinding = readActiveSessionBinding(this.dataDir)
    if (activeBinding?.conversationId) {
      protectedSet.add(sanitizeSessionId(activeBinding.conversationId))
    }

    const toPrune = new Set<string>()

    for (const ctx of this.sessions.values()) {
      if (protectedSet.has(ctx.sessionId)) continue
      if (ctx.updatedAt < cutoff) {
        toPrune.add(ctx.sessionId)
      }
    }

    const remaining = [...this.sessions.values()]
      .filter((ctx) => !toPrune.has(ctx.sessionId))
      .sort((a, b) => a.updatedAt - b.updatedAt)

    let excess = remaining.length - maxCount
    for (const ctx of remaining) {
      if (excess <= 0) break
      if (protectedSet.has(ctx.sessionId)) continue
      toPrune.add(ctx.sessionId)
      excess--
    }

    if (toPrune.size === 0) return 0

    let prunedCount = 0
    for (const id of toPrune) {
      const removed = this.removeSessionInternal(id)
      if (removed.deleted) prunedCount++
    }

    if (prunedCount > 0) {
      this.emit('sessions-changed')
    }
    return prunedCount
  }

  private removeSessionInternal(sessionId: string): { deleted: boolean; releasedSpills: number } {
    const safeId = sanitizeSessionId(sessionId)
    const timer = this.persistTimers.get(safeId)
    if (timer) {
      clearTimeout(timer)
      this.persistTimers.delete(safeId)
    }
    this.dirtySessions.delete(safeId)

    const existedInMem = this.sessions.delete(safeId)
    let existedOnDisk = false
    const filePath = this.getSessionFilePath(safeId)
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath)
        existedOnDisk = true
      }
    } catch {
      // Best-effort unlink.
    }

    const releasedSpills = this.spillStore.releaseBySession(safeId)
    return {
      deleted: existedInMem || existedOnDisk || releasedSpills > 0,
      releasedSpills,
    }
  }

  private getMatchingSessions(workspaceRoot?: string | null): SessionContext[] {
    const targetKey = normalizeWorkspaceKey(workspaceRoot)
    if (!targetKey) {
      return [...this.sessions.values()]
    }
    const matched: SessionContext[] = []
    for (const ctx of this.sessions.values()) {
      const ctxKey = normalizeWorkspaceKey(ctx.workspaceRoot)
      if (ctxKey && ctxKey === targetKey) {
        matched.push(ctx)
      }
    }
    return matched
  }

  getSessionIdsForWorkspace(workspaceRoot?: string | null): Set<string> {
    const ids = new Set<string>()
    for (const ctx of this.getMatchingSessions(workspaceRoot)) {
      ids.add(ctx.sessionId)
    }
    return ids
  }

  recordSessionCost(
    sessionId: string | null | undefined,
    apiCostUsd: number,
    cacheSavingsUsd: number,
    workspaceRoot?: string,
  ): void {
    if (!Number.isFinite(apiCostUsd) || apiCostUsd < 0) return
    const safeSavings = Number.isFinite(cacheSavingsUsd) && cacheSavingsUsd >= 0 ? cacheSavingsUsd : 0
    const ctx = this.getSession(sessionId, workspaceRoot)
    const changed =
      Math.abs((ctx.estimatedApiCostUsd ?? 0) - apiCostUsd) > 1e-6 ||
      Math.abs((ctx.estimatedCacheSavingsUsd ?? 0) - safeSavings) > 1e-6
    ctx.estimatedApiCostUsd = apiCostUsd
    ctx.estimatedCacheSavingsUsd = safeSavings
    if (changed) {
      this.schedulePersist(ctx.sessionId)
    }
  }

  getAggregatedProjectCost(workspaceRoot?: string | null): {
    apiCostUsd: number
    cacheSavingsUsd: number
  } {
    let apiCostUsd = 0
    let cacheSavingsUsd = 0
    for (const ctx of this.getMatchingSessions(workspaceRoot)) {
      if (typeof ctx.estimatedApiCostUsd === 'number' && Number.isFinite(ctx.estimatedApiCostUsd)) {
        apiCostUsd += ctx.estimatedApiCostUsd
      }
      if (
        typeof ctx.estimatedCacheSavingsUsd === 'number' &&
        Number.isFinite(ctx.estimatedCacheSavingsUsd)
      ) {
        cacheSavingsUsd += ctx.estimatedCacheSavingsUsd
      }
    }
    return { apiCostUsd, cacheSavingsUsd }
  }

  listSessions(currentSessionId?: string | null, workspaceRoot?: string | null): SessionSummary[] {
    const current = currentSessionId ? sanitizeSessionId(currentSessionId) : this.resolveSessionId()
    const spillCounts = new Map<string, number>()

    for (const spill of this.spillStore.listSpills(0)) {
      if (!spill.sessionId) continue
      const sid = sanitizeSessionId(spill.sessionId)
      spillCounts.set(sid, (spillCounts.get(sid) ?? 0) + 1)
    }

    const list: SessionSummary[] = []
    for (const ctx of this.getMatchingSessions(workspaceRoot)) {
      const summary = ctx.telemetryStore.getSummary()
      list.push({
        sessionId: ctx.sessionId,
        label: ctx.label,
        ...(ctx.workspaceRoot ? { workspaceRoot: ctx.workspaceRoot } : {}),
        createdAt: ctx.createdAt,
        updatedAt: ctx.updatedAt,
        totalCalls: summary.totalCalls,
        estimatedTokensSaved: summary.estimatedTokensSaved,
        totalSavedBytes: summary.totalSavedBytes,
        totalRawBytes: summary.totalRawBytes,
        roundTripsSaved: summary.roundTripsSaved,
        dedupHits: summary.dedupHits,
        activeSpills: spillCounts.get(ctx.sessionId) ?? 0,
        isCurrent: ctx.sessionId === current,
      })
    }

    list.sort((a, b) => b.updatedAt - a.updatedAt)
    return list
  }

  getSessionTelemetry(
    sessionId?: string | null,
    workspaceRoot?: string | null,
  ): {
    sessionId: string
    telemetry: TokenSavingsSummary
    dedupEntryCount: number
  } {
    if (typeof sessionId === 'string' && sessionId.trim().toLowerCase() === 'all') {
      const telemetry = this.getAggregatedSummary(workspaceRoot)
      return {
        sessionId: 'all',
        telemetry,
        dedupEntryCount: this.getAggregatedDedupCount(workspaceRoot),
      }
    }

    const resolved = this.resolveSessionId(sessionId)
    const ctx = this.sessions.get(resolved)
    const telemetry = ctx ? ctx.telemetryStore.getSummary() : createEmptyTelemetrySummary()
    const dedupEntryCount = ctx ? ctx.readDedupStore.size() : 0
    return {
      sessionId: resolved,
      telemetry,
      dedupEntryCount,
    }
  }

  getAggregatedSummary(workspaceRoot?: string | null): TokenSavingsSummary {
    const summaries: TokenSavingsSummary[] = []
    for (const ctx of this.getMatchingSessions(workspaceRoot)) {
      summaries.push(ctx.telemetryStore.getSummary())
    }
    return mergeTokenSavingsSummaries(summaries)
  }

  getAggregatedActivities(limit = 200, workspaceRoot?: string | null): ActivityItem[] {
    const all: ActivityItem[] = []
    for (const ctx of this.getMatchingSessions(workspaceRoot)) {
      all.push(...ctx.activityStore.list())
    }
    all.sort((a, b) => b.startedAt - a.startedAt)
    return limit > 0 ? all.slice(0, limit) : all
  }

  getAggregatedUnreadAnomalies(workspaceRoot?: string | null): number {
    let total = 0
    for (const ctx of this.getMatchingSessions(workspaceRoot)) {
      total += ctx.activityStore.getUnreadAnomalies()
    }
    return total
  }

  getAggregatedDedupCount(workspaceRoot?: string | null): number {
    let total = 0
    for (const ctx of this.getMatchingSessions(workspaceRoot)) {
      total += ctx.readDedupStore.size()
    }
    return total
  }

  getSessionActivities(
    sessionId?: string | null,
    limit = 200,
    workspaceRoot?: string | null,
  ): ActivityItem[] {
    if (typeof sessionId === 'string' && sessionId.trim().toLowerCase() === 'all') {
      return this.getAggregatedActivities(limit, workspaceRoot)
    }
    const resolved = this.resolveSessionId(sessionId)
    const ctx = this.sessions.get(resolved)
    return ctx ? ctx.activityStore.list(limit) : []
  }

  getSessionUnreadAnomalies(sessionId?: string | null, workspaceRoot?: string | null): number {
    if (typeof sessionId === 'string' && sessionId.trim().toLowerCase() === 'all') {
      return this.getAggregatedUnreadAnomalies(workspaceRoot)
    }
    const resolved = this.resolveSessionId(sessionId)
    const ctx = this.sessions.get(resolved)
    return ctx ? ctx.activityStore.getUnreadAnomalies() : 0
  }

  acknowledgeActivities(
    sessionId?: string | null,
    workspaceRoot?: string | null,
  ): { unreadAnomalies: number } {
    if (typeof sessionId === 'string' && sessionId.trim().toLowerCase() === 'all') {
      for (const ctx of this.getMatchingSessions(workspaceRoot)) {
        ctx.activityStore.acknowledgeAll()
      }
      return { unreadAnomalies: 0 }
    }
    const resolved = this.resolveSessionId(sessionId)
    const ctx = this.sessions.get(resolved)
    if (!ctx) return { unreadAnomalies: 0 }
    return ctx.activityStore.acknowledgeAll()
  }

  clearDedup(
    sessionId?: string | null,
    workspaceRoot?: string | null,
  ): { cleared: number; dedupEntryCount: number } {
    if (typeof sessionId === 'string' && sessionId.trim().toLowerCase() === 'all') {
      let cleared = 0
      for (const ctx of this.getMatchingSessions(workspaceRoot)) {
        const n = ctx.readDedupStore.invalidateAll()
        if (n > 0) this.schedulePersist(ctx.sessionId)
        cleared += n
      }
      return { cleared, dedupEntryCount: 0 }
    }
    const resolved = this.resolveSessionId(sessionId)
    const ctx = this.sessions.get(resolved)
    if (!ctx) return { cleared: 0, dedupEntryCount: 0 }
    const cleared = ctx.readDedupStore.invalidateAll()
    if (cleared > 0) this.schedulePersist(ctx.sessionId)
    return { cleared, dedupEntryCount: 0 }
  }

  resetSession(
    sessionId?: string | null,
    workspaceRoot?: string | null,
  ): {
    sessionId: string
    telemetry: TokenSavingsSummary
    dedupEntryCount: number
  } {
    if (typeof sessionId === 'string' && sessionId.trim().toLowerCase() === 'all') {
      for (const ctx of this.getMatchingSessions(workspaceRoot)) {
        ctx.telemetryStore.reset()
        this.persistSessionNow(ctx.sessionId)
      }
      const telemetry = this.getAggregatedSummary(workspaceRoot)
      return {
        sessionId: 'all',
        telemetry,
        dedupEntryCount: this.getAggregatedDedupCount(workspaceRoot),
      }
    }

    const resolved = this.resolveSessionId(sessionId)
    const ctx = this.sessions.get(resolved)
    if (!ctx) {
      return {
        sessionId: resolved,
        telemetry: createEmptyTelemetrySummary(),
        dedupEntryCount: 0,
      }
    }

    const telemetry = ctx.telemetryStore.reset()
    ctx.updatedAt = Date.now()
    this.persistSessionNow(ctx.sessionId)
    return {
      sessionId: ctx.sessionId,
      telemetry,
      dedupEntryCount: ctx.readDedupStore.size(),
    }
  }

  deleteSession(sessionId: string): {
    deleted: boolean
    sessionId: string
    releasedSpills: number
  } {
    const safeId = sanitizeSessionId(sessionId)
    const res = this.removeSessionInternal(safeId)
    if (res.deleted) {
      this.emit('sessions-changed')
    }
    return {
      deleted: res.deleted,
      sessionId: safeId,
      releasedSpills: res.releasedSpills,
    }
  }

  exportSessionReport(
    sessionId: string,
    format: 'markdown' | 'json' = 'markdown',
  ): SessionExportReport {
    const isAll = typeof sessionId === 'string' && sessionId.trim().toLowerCase() === 'all'
    const resolvedId = isAll ? 'all' : sanitizeSessionId(sessionId)
    const exportedAt = new Date().toISOString()

    let label: string
    let workspaceRoot: string | undefined
    let createdAt: number | undefined
    let updatedAt: number | undefined
    let telemetry: TokenSavingsSummary
    let activities: ActivityItem[]
    let spills: SpillEntrySummary[]
    let dedupEntryCount: number

    if (isAll) {
      label = 'All Sessions (Aggregate)'
      telemetry = this.getAggregatedSummary()
      activities = this.getAggregatedActivities(50)
      spills = this.spillStore.listSpills(100)
      dedupEntryCount = this.getAggregatedDedupCount()
    } else {
      const ctx = this.sessions.get(resolvedId)
      label = ctx?.label ?? makeSessionLabel(resolvedId)
      workspaceRoot = ctx?.workspaceRoot
      createdAt = ctx?.createdAt
      updatedAt = ctx?.updatedAt
      telemetry = ctx ? ctx.telemetryStore.getSummary() : createEmptyTelemetrySummary()
      activities = ctx ? ctx.activityStore.list(50) : []
      spills = this.spillStore.listSpills(100, resolvedId)
      dedupEntryCount = ctx ? ctx.readDedupStore.size() : 0
    }

    const reductionPct =
      telemetry.totalRawBytes > 0
        ? Math.round((telemetry.totalSavedBytes / telemetry.totalRawBytes) * 1000) / 10
        : 0

    const dateTag = exportedAt.slice(0, 10)
    const safeFilePrefix = isAll ? 'all-sessions' : resolvedId.slice(0, 24)
    const ext = format === 'json' ? 'json' : 'md'
    const filename = `agy-pulse-report-${safeFilePrefix}-${dateTag}.${ext}`

    if (format === 'json') {
      const payload = {
        exportedAt,
        sessionId: resolvedId,
        label,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        ...(createdAt ? { createdAt: new Date(createdAt).toISOString() } : {}),
        ...(updatedAt ? { updatedAt: new Date(updatedAt).toISOString() } : {}),
        reductionPct,
        dedupEntryCount,
        telemetry,
        activeSpills: spills,
        recentActivities: activities,
      }
      return {
        format: 'json',
        filename,
        content: `${JSON.stringify(payload, null, 2)}\n`,
      }
    }

    const lines: string[] = []
    lines.push(`# agy-pulse Token-Savings Report`)
    lines.push('')
    lines.push(`- **Session**: \`${resolvedId}\` (${label})`)
    if (workspaceRoot) lines.push(`- **Workspace**: \`${workspaceRoot}\``)
    lines.push(`- **Exported**: ${exportedAt}`)
    lines.push('')
    lines.push(`## Summary KPIs`)
    lines.push('')
    lines.push(`| Metric | Value |`)
    lines.push(`| --- | ---: |`)
    lines.push(`| Estimated Tokens Saved | ${telemetry.estimatedTokensSaved.toLocaleString('en-US')} |`)
    lines.push(`| Data Trimmed | ${formatBytesHuman(telemetry.totalSavedBytes)} / ${formatBytesHuman(telemetry.totalRawBytes)} (${reductionPct.toFixed(1)}%) |`)
    lines.push(`| Delivered Output | ${formatBytesHuman(telemetry.totalDeliveredBytes)} |`)
    lines.push(`| Total Operations | ${telemetry.totalCalls} |`)
    lines.push(`| Round-Trips Saved | ${telemetry.roundTripsSaved} |`)
    lines.push(`| Read-Dedup Hits | ${telemetry.dedupHits} (${dedupEntryCount} cached entries) |`)
    lines.push(`| Average Latency | ${telemetry.avgDurationMs} ms |`)
    lines.push('')
    lines.push(`## Savings Breakdown by Mechanism`)
    lines.push('')
    lines.push(`| Mechanism | Calls | Bytes Saved | Est. Tokens Saved |`)
    lines.push(`| --- | ---: | ---: | ---: |`)
    for (const cat of ALL_SAVINGS_CATEGORIES) {
      const b = telemetry.byCategory[cat]
      if (!b) continue
      lines.push(
        `| ${CATEGORY_LABELS[cat]} | ${b.calls} | ${formatBytesHuman(b.savedBytes)} | ${b.estimatedTokensSaved.toLocaleString('en-US')} |`,
      )
    }

    if (spills.length > 0) {
      lines.push('')
      lines.push(`## Active Spillover Artifacts (${spills.length})`)
      lines.push('')
      for (const s of spills.slice(0, 20)) {
        lines.push(`- \`${s.refId}\` (${s.tool}, ${formatBytesHuman(s.totalBytes)}) — ${s.description}`)
      }
    }

    if (activities.length > 0) {
      lines.push('')
      lines.push(`## Recent Activity (${activities.length})`)
      lines.push('')
      lines.push(`| Status | Kind | Description | Duration | Saved |`)
      lines.push(`| --- | --- | --- | ---: | ---: |`)
      for (const a of activities.slice(0, 25)) {
        const desc = a.description.replace(/\|/g, '\\|').slice(0, 80)
        const saved = a.savedBytes ? formatBytesHuman(a.savedBytes) : '-'
        lines.push(`| ${a.status} | ${a.kind} | ${desc} | ${a.durationMs} ms | ${saved} |`)
      }
    }

    lines.push('')
    return {
      format: 'markdown',
      filename,
      content: `${lines.join('\n')}\n`,
    }
  }
}
