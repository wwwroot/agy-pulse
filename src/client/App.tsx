import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_TERMINAL_CONFIG,
  type ActivityItem,
  type ConversationContextUsage,
  type HostHealthSnapshot,
  type JobSummary,
  type QuotaSnapshot,
  type ShellInfo,
  type SidecarNotice,
  type SidecarStateSnapshot,
  type TerminalConfig,
  type TokenSavingsSummary,
} from '../shared/types.ts'
import { ActivityView } from './components/ActivityView.tsx'
import { HealthBanner } from './components/HealthBanner.tsx'
import { OverviewView } from './components/OverviewView.tsx'
import { SettingsView } from './components/SettingsView.tsx'
import { TabBar, type ActiveView } from './components/TabBar.tsx'
import styles from './terminal.module.css'
import {
  acknowledgeActivities,
  clearDedupCache,
  exportSessionReport,
  fetchFixtureSnapshot,
  fetchLiveEvents,
  fetchQuotas,
  fetchShells,
  fetchState,
  getConversationId,
  getFixtureParam,
  isAbortError,
  patchConfig,
  refreshQuotas,
  repairHostHealth,
  resetConfig,
  resetTelemetry,
  triggerFileDownload,
  uriToPathClient,
  type SessionScope,
} from './utils/api.ts'
import { OpsWsClient, type WsConnectionStatus } from './utils/ws.ts'

const MAX_CLIENT_ACTIVITIES = 100
const FOCUS_REFRESH_THROTTLE_MS = 3_000
const FALLBACK_POLL_WAIT_MS = 5_000

const EMPTY_TELEMETRY: TokenSavingsSummary = {
  totalCalls: 0,
  totalRawBytes: 0,
  totalDeliveredBytes: 0,
  totalSavedBytes: 0,
  estimatedTokensSaved: 0,
  roundTripsSaved: 0,
  dedupHits: 0,
  avgDurationMs: 0,
  byCategory: {
    'read-dedup': { calls: 0, savedBytes: 0, estimatedTokensSaved: 0 },
    'outline-read': { calls: 0, savedBytes: 0, estimatedTokensSaved: 0 },
    'symbol-read': { calls: 0, savedBytes: 0, estimatedTokensSaved: 0 },
    'batch-read': { calls: 0, savedBytes: 0, estimatedTokensSaved: 0 },
    'grep-progressive': { calls: 0, savedBytes: 0, estimatedTokensSaved: 0 },
    'git-compact': { calls: 0, savedBytes: 0, estimatedTokensSaved: 0 },
    'json-digest': { calls: 0, savedBytes: 0, estimatedTokensSaved: 0 },
    spillover: { calls: 0, savedBytes: 0, estimatedTokensSaved: 0 },
    'batch-mutate': { calls: 0, savedBytes: 0, estimatedTokensSaved: 0 },
    'native-doc': { calls: 0, savedBytes: 0, estimatedTokensSaved: 0 },
  },
}

function upsertActivity(list: ActivityItem[], item: ActivityItem): ActivityItem[] {
  const idx = list.findIndex((a) => a.id === item.id)
  if (idx >= 0) {
    const next = list.slice()
    next[idx] = item
    return next
  }
  const next = [item, ...list]
  return next.length > MAX_CLIENT_ACTIVITIES ? next.slice(0, MAX_CLIENT_ACTIVITIES) : next
}

function inferFixtureNow(
  fixture: Partial<SidecarStateSnapshot> & { __now?: number },
): number {
  if (typeof fixture.__now === 'number' && Number.isFinite(fixture.__now)) {
    return fixture.__now
  }
  const anchor =
    fixture.contextWindow?.updatedAt ||
    fixture.quotas?.fetchedAt ||
    fixture.hostHealth?.checkedAt ||
    1_700_000_000_000
  return anchor + 120_000
}

export const App: React.FC = () => {
  const hostConversationId = useMemo(() => getConversationId(), [])
  const fixtureParam = useMemo(() => getFixtureParam(), [])
  const inlineFixture = useMemo(
    () => (typeof window !== 'undefined' ? window.__AGY_PULSE_FIXTURE__ : undefined),
    [],
  )
  const isFixtureMode = Boolean(inlineFixture || fixtureParam)

  const [activeView, setActiveView] = useState<ActiveView>('overview')
  const [scope, setScope] = useState<SessionScope>('conversation')
  const [resolvedSessionId, setResolvedSessionId] = useState<string>(() => getConversationId() || '')

  const [activeWorkspaceRoot, setActiveWorkspaceRoot] = useState('')
  const [platform, setPlatform] = useState('')
  const [daemonVersion, setDaemonVersion] = useState('1.0.0')
  const [workerAvailable, setWorkerAvailable] = useState(true)
  const [workerPath, setWorkerPath] = useState<string | undefined>(undefined)
  const [config, setConfig] = useState<TerminalConfig>(DEFAULT_TERMINAL_CONFIG)
  const [shells, setShells] = useState<ShellInfo[]>([])
  const [jobs, setJobs] = useState<JobSummary[]>([])
  const [activities, setActivities] = useState<ActivityItem[]>([])
  const [unreadAnomalies, setUnreadAnomalies] = useState(0)
  const [telemetry, setTelemetry] = useState<TokenSavingsSummary>(EMPTY_TELEMETRY)
  const [contextWindow, setContextWindow] = useState<ConversationContextUsage | null>(null)
  const [dedupEntryCount, setDedupEntryCount] = useState(0)
  const [quotas, setQuotas] = useState<QuotaSnapshot | null>(null)
  const [hostHealth, setHostHealth] = useState<HostHealthSnapshot | null>(null)
  const [notices, setNotices] = useState<SidecarNotice[]>([])
  const [dismissedNoticeIds, setDismissedNoticeIds] = useState<Set<string>>(() => new Set())

  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>(
    isFixtureMode ? 'connected' : 'connecting',
  )
  const [wsFallbackActive, setWsFallbackActive] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshingQuotas, setRefreshingQuotas] = useState(false)
  const [repairingHost, setRepairingHost] = useState(false)
  const [repairedHint, setRepairedHint] = useState<string | null>(null)
  const [now, setNow] = useState<number>(() =>
    inlineFixture ? inferFixtureNow(inlineFixture) : Date.now(),
  )
  const [isDocHidden, setIsDocHidden] = useState<boolean>(
    () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  )
  const [toast, setToast] = useState<{ text: string; isError?: boolean } | null>(null)

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastWorkspaceSigRef = useRef<string | null>(null)
  const prevWsStatusRef = useRef<WsConnectionStatus>('connecting')
  const liveSeqRef = useRef<number>(0)
  const stateReqSeqRef = useRef<number>(0)
  const stateAbortRef = useRef<AbortController | null>(null)
  const lastFocusRefreshRef = useRef<number>(0)
  const scopeRef = useRef<SessionScope>(scope)
  scopeRef.current = scope

  const resolvedSessionIdRef = useRef<string>(resolvedSessionId)
  resolvedSessionIdRef.current = resolvedSessionId

  const showToast = useCallback((text: string, isError = false) => {
    setToast({ text, isError })
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null
      setToast(null)
    }, 3000)
  }, [])

  useEffect(() => {
    const onVis = () => setIsDocHidden(document.visibilityState === 'hidden')
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      stateAbortRef.current?.abort()
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  const applyStateSnapshot = useCallback(
    (snapshot: Partial<SidecarStateSnapshot>, syncedAtOverride?: number) => {
      if (typeof snapshot.seq === 'number' && snapshot.seq > liveSeqRef.current) {
        liveSeqRef.current = snapshot.seq
      }
      if (Array.isArray(snapshot.workspaceRoots)) {
        setActiveWorkspaceRoot((prev) => {
          if (prev && snapshot.workspaceRoots!.includes(prev)) return prev
          return snapshot.primaryWorkspaceRoot || snapshot.workspaceRoots![0] || prev
        })
      } else if (snapshot.primaryWorkspaceRoot) {
        setActiveWorkspaceRoot((prev) => prev || snapshot.primaryWorkspaceRoot!)
      }

      if (typeof snapshot.platform === 'string') setPlatform(snapshot.platform)
      if (typeof snapshot.daemonVersion === 'string') setDaemonVersion(snapshot.daemonVersion)
      if (typeof snapshot.workerAvailable === 'boolean') setWorkerAvailable(snapshot.workerAvailable)
      if (typeof snapshot.workerPath === 'string') setWorkerPath(snapshot.workerPath)
      if (snapshot.config) setConfig(snapshot.config)
      if (Array.isArray(snapshot.shells)) setShells(snapshot.shells)
      if (Array.isArray(snapshot.jobs)) setJobs(snapshot.jobs)
      if (Array.isArray(snapshot.activities)) setActivities(snapshot.activities)
      if (typeof snapshot.unreadAnomalies === 'number') setUnreadAnomalies(snapshot.unreadAnomalies)
      if (snapshot.telemetry) setTelemetry(snapshot.telemetry)
      if (snapshot.contextWindow !== undefined) {
        setContextWindow(snapshot.contextWindow ?? null)
      }
      if (snapshot.quotas !== undefined) {
        const incoming = snapshot.quotas ?? null
        setQuotas((prev) => {
          if (!incoming) return prev
          if (prev && incoming.fetchedAt < prev.fetchedAt) return prev
          return incoming
        })
      }
      if (snapshot.hostHealth !== undefined) {
        setHostHealth(snapshot.hostHealth ?? null)
      }
      if (Array.isArray(snapshot.notices)) {
        setNotices(snapshot.notices)
        // Keep only still-active IDs so resolved notices re-arm if they recur.
        const activeIds = new Set(snapshot.notices.map((n) => n.id))
        setDismissedNoticeIds((prev) => {
          if (prev.size === 0) return prev
          const next = new Set<string>()
          for (const id of prev) {
            if (activeIds.has(id)) next.add(id)
          }
          return next.size === prev.size ? prev : next
        })
      }
      if (typeof snapshot.dedupEntryCount === 'number') {
        setDedupEntryCount(snapshot.dedupEntryCount)
      }
      if (typeof snapshot.sessionId === 'string' && snapshot.sessionId) {
        setResolvedSessionId(snapshot.sessionId)
      }
      setLastSyncedAt(syncedAtOverride ?? Date.now())
      setLastError(null)
    },
    [],
  )

  // Bootstrap fixture mode for Playwright UI snapshots without a live daemon.
  useEffect(() => {
    if (!isFixtureMode) return
    const ac = new AbortController()
    const applyFixture = (data: Partial<SidecarStateSnapshot> & { __now?: number }) => {
      const frozenNow = inferFixtureNow(data)
      setNow(frozenNow)
      applyStateSnapshot(data, frozenNow - 120_000)
    }

    if (inlineFixture) {
      applyFixture(inlineFixture)
      return () => ac.abort()
    }

    if (fixtureParam) {
      void fetchFixtureSnapshot(fixtureParam, ac.signal)
        .then((data) => {
          if (!ac.signal.aborted) applyFixture(data)
        })
        .catch((err) => {
          if (!ac.signal.aborted && !isAbortError(err)) {
            setLastError(err instanceof Error ? err.message : 'Failed to load fixture')
          }
        })
    }
    return () => ac.abort()
  }, [isFixtureMode, inlineFixture, fixtureParam, applyStateSnapshot])

  const refreshState = useCallback(
    async (hintRoots?: string[], scopeOverride?: SessionScope): Promise<boolean> => {
      if (isFixtureMode) return true
      const reqId = ++stateReqSeqRef.current
      const sessionId = hostConversationId || resolvedSessionIdRef.current || undefined
      const effectiveScope = scopeOverride ?? scopeRef.current

      stateAbortRef.current?.abort()
      const ac = new AbortController()
      stateAbortRef.current = ac

      const explicitRoots = hintRoots && hintRoots.length > 0 ? hintRoots : undefined
      setIsRefreshing(true)

      const loadOnce = async (attempt = 0): Promise<SidecarStateSnapshot> => {
        try {
          return await fetchState(
            {
              sessionId,
              scope: effectiveScope,
              workspaceRoot: explicitRoots ? explicitRoots[0] : undefined,
              workspaceRoots: explicitRoots,
            },
            ac.signal,
          )
        } catch (err) {
          if (reqId !== stateReqSeqRef.current || isAbortError(err) || attempt >= 1) {
            throw err
          }
          await new Promise((resolve) => setTimeout(resolve, 350))
          if (reqId !== stateReqSeqRef.current || ac.signal.aborted) {
            throw err
          }
          return loadOnce(attempt + 1)
        }
      }

      try {
        const snapshot = await loadOnce()
        if (reqId !== stateReqSeqRef.current) return false
        setNow(Date.now())
        applyStateSnapshot(snapshot)
        return true
      } catch (err) {
        if (reqId !== stateReqSeqRef.current || isAbortError(err)) return false
        const msg = err instanceof Error ? err.message : 'Failed to load dashboard state'
        setLastError(msg)
        showToast(msg, true)
        return false
      } finally {
        if (reqId === stateReqSeqRef.current) {
          setIsRefreshing(false)
        }
      }
    },
    [isFixtureMode, hostConversationId, applyStateSnapshot, showToast],
  )

  useEffect(() => {
    if (isFixtureMode) return
    const client = new OpsWsClient({
      conversationId: hostConversationId || resolvedSessionIdRef.current || undefined,
      scope,
    })

    const offStatus = client.onStatusChange((nextStatus) => {
      const prevStatus = prevWsStatusRef.current
      prevWsStatusRef.current = nextStatus
      setWsStatus(nextStatus)
      if (nextStatus === 'connected') {
        setWsFallbackActive(false)
        if (prevStatus === 'reconnecting' || prevStatus === 'suspended' || prevStatus === 'failed') {
          void refreshState()
        }
      } else if (nextStatus === 'failed') {
        setWsFallbackActive(true)
      }
    })

    const offState = client.onStateUpdate((partial) => {
      const currentId = hostConversationId || resolvedSessionIdRef.current
      const activeScope = scopeRef.current
      const scopeMatches = !partial.sessionScope || partial.sessionScope === activeScope
      const sessionMatches =
        activeScope === 'all' ||
        !partial.sessionId ||
        !currentId ||
        partial.sessionId === currentId
      if (scopeMatches && sessionMatches) {
        applyStateSnapshot(partial)
      } else {
        if (partial.config) setConfig(partial.config)
        if (Array.isArray(partial.shells)) setShells(partial.shells)
        if (Array.isArray(partial.jobs)) setJobs(partial.jobs)
        if (partial.quotas !== undefined) setQuotas(partial.quotas ?? null)
        if (partial.hostHealth !== undefined) setHostHealth(partial.hostHealth ?? null)
        if (Array.isArray(partial.notices)) setNotices(partial.notices)
      }
    })

    const offActivity = client.onActivityEvent((ev) => {
      const currentId = hostConversationId || resolvedSessionIdRef.current
      if (
        scopeRef.current !== 'all' &&
        ev.item.sessionId &&
        currentId &&
        ev.item.sessionId !== currentId
      ) {
        return
      }
      setActivities((prev) => upsertActivity(prev, ev.item))
      setUnreadAnomalies(ev.unreadAnomalies)
      setLastSyncedAt(Date.now())
    })

    const offTelemetry = client.onTelemetryUpdate((ev) => {
      const currentId = hostConversationId || resolvedSessionIdRef.current
      if (
        scopeRef.current !== 'all' &&
        ev.sessionId &&
        currentId &&
        ev.sessionId !== currentId
      ) {
        return
      }
      setTelemetry(ev.telemetry)
      setDedupEntryCount(ev.dedupEntryCount)
      setLastSyncedAt(Date.now())
    })

    return () => {
      offStatus()
      offState()
      offActivity()
      offTelemetry()
      client.dispose()
    }
  }, [isFixtureMode, hostConversationId, scope, applyStateSnapshot, refreshState])

  useEffect(() => {
    if (isFixtureMode || !wsFallbackActive) return

    let disposed = false
    let activeAbort: AbortController | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let backoffMs = 500

    const isHidden = () => document.visibilityState === 'hidden'

    const stopLoop = () => {
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      activeAbort?.abort()
      activeAbort = null
    }

    const schedule = (delayMs: number) => {
      if (disposed || isHidden()) return
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = setTimeout(() => {
        retryTimer = null
        void loop()
      }, delayMs)
    }

    const loop = async () => {
      if (disposed || isHidden()) return
      if (activeAbort) return
      const ac = new AbortController()
      activeAbort = ac
      try {
        const res = await fetchLiveEvents(
          liveSeqRef.current,
          FALLBACK_POLL_WAIT_MS,
          {
            sessionId: hostConversationId || undefined,
            scope: scopeRef.current,
          },
          ac.signal,
        )
        if (disposed || isHidden()) return
        backoffMs = 500
        if (typeof res.seq === 'number' && res.seq > liveSeqRef.current) {
          liveSeqRef.current = res.seq
        }
        if (res.changed && res.state) {
          applyStateSnapshot(res.state)
        }
        schedule(150)
      } catch (err) {
        if (disposed || isHidden() || isAbortError(err) || ac.signal.aborted) return
        backoffMs = Math.min(5000, Math.round(backoffMs * 1.7))
        schedule(backoffMs)
      } finally {
        if (activeAbort === ac) activeAbort = null
      }
    }

    const onVisibilityChange = () => {
      if (isHidden()) {
        stopLoop()
        return
      }
      if (!activeAbort && !retryTimer) {
        void loop()
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    if (!isHidden()) {
      schedule(120)
    }

    return () => {
      disposed = true
      stopLoop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [isFixtureMode, wsFallbackActive, hostConversationId, applyStateSnapshot])

  useEffect(() => {
    if (isFixtureMode) return
    let cancelled = false
    let initialDone = false
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null

    const syncWorkspaceUris = async (uris?: string[], force = false) => {
      const paths = (uris || []).map(uriToPathClient).filter(Boolean)
      const sig = paths.join('|')
      if (!force && uris !== undefined && lastWorkspaceSigRef.current === sig) {
        return
      }
      if (cancelled) return
      initialDone = true
      const ok = await refreshState(paths.length > 0 ? paths : undefined)
      if (cancelled) return
      if (ok && uris !== undefined) {
        lastWorkspaceSigRef.current = sig
      } else if (!ok) {
        lastWorkspaceSigRef.current = null
      }
    }

    const isEmbedded = typeof window !== 'undefined' && window.parent !== window

    const unsubscribe = window.sidecar?.onWorkspaceChange?.((uris) => {
      const hasPaths = (uris || []).map(uriToPathClient).filter(Boolean).length > 0
      if (!hasPaths && !initialDone && isEmbedded) {
        return
      }
      if (fallbackTimer) {
        clearTimeout(fallbackTimer)
        fallbackTimer = null
      }
      void syncWorkspaceUris(uris, !initialDone)
    })

    const resyncOnVisibleOrFocus = (isVisibilityReturn: boolean) => {
      if (cancelled || document.visibilityState === 'hidden') return
      const currentNow = Date.now()
      if (!isVisibilityReturn && currentNow - lastFocusRefreshRef.current < FOCUS_REFRESH_THROTTLE_MS) {
        return
      }
      lastFocusRefreshRef.current = currentNow
      if (isEmbedded && typeof window.sidecar?.getWorkspaceUris === 'function') {
        void window.sidecar
          .getWorkspaceUris()
          .then((uris) => {
            if (cancelled) return
            const paths = (uris || []).map(uriToPathClient).filter(Boolean)
            if (paths.length > 0) {
              void syncWorkspaceUris(uris, true)
            } else {
              void refreshState()
            }
          })
          .catch(() => {
            if (!cancelled) void refreshState()
          })
      } else {
        void refreshState()
      }
    }

    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') {
        resyncOnVisibleOrFocus(true)
      }
    }
    const onFocus = () => {
      resyncOnVisibleOrFocus(false)
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)

    if (typeof window.sidecar?.getWorkspaceUris === 'function') {
      void window.sidecar
        .getWorkspaceUris()
        .then((uris) => {
          if (cancelled) return
          const hasPaths = (uris || []).map(uriToPathClient).filter(Boolean).length > 0
          if (!hasPaths && isEmbedded && !initialDone) {
            return
          }
          if (fallbackTimer) {
            clearTimeout(fallbackTimer)
            fallbackTimer = null
          }
          void syncWorkspaceUris(uris, !initialDone)
        })
        .catch(() => {
          if (!cancelled && !initialDone && !isEmbedded) {
            void syncWorkspaceUris(undefined, true)
          }
        })

      fallbackTimer = setTimeout(
        () => {
          fallbackTimer = null
          if (!cancelled && !initialDone) {
            void syncWorkspaceUris(undefined, true)
          }
        },
        isEmbedded ? 1200 : 350,
      )
    } else {
      void syncWorkspaceUris(undefined, true)
    }

    return () => {
      cancelled = true
      if (fallbackTimer) clearTimeout(fallbackTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      unsubscribe?.()
    }
  }, [isFixtureMode, refreshState])

  const runningJobsCount = useMemo(
    () => jobs.filter((j) => j.status === 'running').length,
    [jobs],
  )

  const runningActivitiesCount = useMemo(
    () => activities.filter((a) => a.status === 'running').length,
    [activities],
  )
  const hasRunning = runningJobsCount > 0 || runningActivitiesCount > 0

  useEffect(() => {
    if (isFixtureMode || isDocHidden) return
    const intervalMs = hasRunning ? 1_000 : 30_000
    const id = setInterval(() => {
      setNow(Date.now())
    }, intervalMs)
    return () => clearInterval(id)
  }, [isFixtureMode, isDocHidden, hasRunning])

  const effectiveSessionId = hostConversationId || resolvedSessionId

  const handleScopeChange = useCallback(
    (nextScope: SessionScope) => {
      setScope(nextScope)
      void refreshState(undefined, nextScope)
    },
    [refreshState],
  )

  const handleAcknowledge = useCallback(async () => {
    try {
      const res = await acknowledgeActivities({
        sessionId: effectiveSessionId || undefined,
        scope,
      })
      setUnreadAnomalies(res.unreadAnomalies)
      setActivities((prev) => prev.map((a) => ({ ...a, acknowledged: true })))
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to acknowledge anomalies', true)
    }
  }, [effectiveSessionId, scope, showToast])

  const handlePatchConfig = useCallback(
    async (patch: Partial<TerminalConfig>): Promise<TerminalConfig> => {
      const saved = await patchConfig(patch)
      setConfig(saved)
      void refreshState()
      return saved
    },
    [refreshState],
  )

  const handleResetConfig = useCallback(async (): Promise<TerminalConfig> => {
    const restored = await resetConfig()
    setConfig(restored)
    void refreshState()
    return restored
  }, [refreshState])

  const handleRefreshShells = useCallback(async () => {
    try {
      const detected = await fetchShells(true)
      setShells(detected)
      showToast('Refreshed host shell diagnostics')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to refresh shells', true)
    }
  }, [showToast])

  const handleRefreshQuotas = useCallback(async () => {
    if (isFixtureMode || refreshingQuotas) return
    setRefreshingQuotas(true)
    try {
      const next = await refreshQuotas()
      setQuotas(next)
      setNow(Date.now())
      showToast(next?.error ? next.error : 'Refreshed Antigravity quotas', Boolean(next?.error))
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to refresh quotas', true)
    } finally {
      setRefreshingQuotas(false)
    }
  }, [isFixtureMode, refreshingQuotas, showToast])

  const autoQuotaInFlightRef = useRef(false)
  const lastAutoQuotaAttemptRef = useRef(0)
  useEffect(() => {
    if (isFixtureMode || isDocHidden || lastSyncedAt === null) return
    const stale =
      quotas === null ||
      now - quotas.fetchedAt >= 5 * 60_000 ||
      quotas.pools.some(
        (p) =>
          !p.disabled &&
          p.windows.some((w) => w.resetsAt !== null && w.resetsAt > 0 && w.resetsAt <= now),
      )
    if (!stale || autoQuotaInFlightRef.current) return
    if (Date.now() - lastAutoQuotaAttemptRef.current < 60_000) return
    lastAutoQuotaAttemptRef.current = Date.now()
    autoQuotaInFlightRef.current = true
    const ac = new AbortController()
    setRefreshingQuotas(true)
    const fetchOp = quotas === null ? fetchQuotas(ac.signal) : refreshQuotas()
    void fetchOp
      .then((next) => {
        if (!ac.signal.aborted && next) {
          setQuotas((prev) => (prev && next.fetchedAt < prev.fetchedAt ? prev : next))
          setNow(Date.now())
        }
      })
      .catch(() => {
        // Silent on background refresh; manual Refresh button surfaces errors.
      })
      .finally(() => {
        autoQuotaInFlightRef.current = false
        if (!ac.signal.aborted) setRefreshingQuotas(false)
      })
    return () => {
      ac.abort()
      autoQuotaInFlightRef.current = false
    }
  }, [isFixtureMode, isDocHidden, lastSyncedAt, quotas, now])

  const handleRepairHost = useCallback(async () => {
    if (isFixtureMode || repairingHost) return
    setRepairingHost(true)
    try {
      const res = await repairHostHealth()
      setHostHealth(res.snapshot)
      setRepairedHint(res.detail)
      void refreshState()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to repair host config', true)
    } finally {
      setRepairingHost(false)
    }
  }, [isFixtureMode, repairingHost, refreshState, showToast])

  const handleClearDedup = useCallback(async () => {
    if (isFixtureMode) return
    try {
      const res = await clearDedupCache({
        sessionId: effectiveSessionId || undefined,
        scope,
      })
      setDedupEntryCount(res.dedupEntryCount)
      showToast(`Cleared ${res.cleared} cached read range${res.cleared === 1 ? '' : 's'}`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to clear dedup cache', true)
    }
  }, [isFixtureMode, effectiveSessionId, scope, showToast])

  const handleResetTelemetry = useCallback(async () => {
    if (isFixtureMode) return
    try {
      const res = await resetTelemetry({
        sessionId: effectiveSessionId || undefined,
        scope,
      })
      setTelemetry(res.telemetry)
      if (typeof res.dedupEntryCount === 'number') setDedupEntryCount(res.dedupEntryCount)
      showToast('Reset token savings statistics')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to reset statistics', true)
    }
  }, [isFixtureMode, effectiveSessionId, scope, showToast])

  const handleExportSession = useCallback(
    async (format: 'markdown' | 'json') => {
      if (isFixtureMode) return
      try {
        const target = scope === 'all' ? 'all' : effectiveSessionId || 'default'
        const res = await exportSessionReport(target, format, { saveToDownloads: true })
        if (res.savedPath) {
          showToast(`Saved to Downloads: ${res.filename}`)
          return
        }
        const mime =
          format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8'
        const ok = triggerFileDownload(res.filename, res.content, mime)
        showToast(ok ? `Exported ${res.filename}` : 'Export download blocked', !ok)
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to export session', true)
      }
    },
    [isFixtureMode, scope, effectiveSessionId, showToast],
  )

  const handleDismissNotice = useCallback((id: string) => {
    setDismissedNoticeIds((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  return (
    <div className={styles.app}>
      <TabBar
        activeView={activeView}
        onSelectView={setActiveView}
        activeWorkspaceRoot={activeWorkspaceRoot}
        lastSyncedAt={lastSyncedAt}
        now={now}
        isRefreshing={isRefreshing}
        onRefresh={() => {
          void refreshState()
          void handleRefreshQuotas()
        }}
      />

      <HealthBanner
        lastError={lastError}
        lastSyncedAt={lastSyncedAt}
        now={now}
        wsStatus={wsStatus}
        wsFallbackActive={wsFallbackActive}
        workerAvailable={workerAvailable}
        workerPath={workerPath}
        hostHealth={hostHealth}
        repairingHost={repairingHost}
        repairedHint={repairedHint}
        notices={notices}
        dismissedNoticeIds={dismissedNoticeIds}
        isRefreshing={isRefreshing}
        onRetrySync={() => void refreshState()}
        onRefreshQuotas={() => void handleRefreshQuotas()}
        onRepairHost={() => void handleRepairHost()}
        onDismissRepairedHint={() => setRepairedHint(null)}
        onDismissNotice={handleDismissNotice}
      />

      <main className={styles.mainArea}>
        <OverviewView
          visible={activeView === 'overview'}
          scope={scope}
          onScopeChange={handleScopeChange}
          contextWindow={contextWindow}
          googleAiPlan={config.googleAiPlan ?? 'pro'}
          costPricingOverrides={config.costPricingOverrides}
          quotas={quotas}
          refreshingQuotas={refreshingQuotas}
          onRefreshQuotas={() => void handleRefreshQuotas()}
          telemetry={telemetry}
          dedupEntryCount={dedupEntryCount}
          now={now}
          onClearDedup={handleClearDedup}
          onExportSession={handleExportSession}
          onResetTelemetry={handleResetTelemetry}
        />

        <ActivityView
          visible={activeView === 'activity'}
          jobs={jobs}
          activities={activities}
          unreadAnomalies={unreadAnomalies}
          now={now}
          onAcknowledge={handleAcknowledge}
          onRefresh={async () => {
            await refreshState()
          }}
          onNotify={showToast}
        />

        <SettingsView
          visible={activeView === 'settings'}
          config={config}
          shells={shells}
          platform={platform}
          daemonVersion={daemonVersion}
          workerAvailable={workerAvailable}
          workerPath={workerPath}
          dedupEntryCount={dedupEntryCount}
          onPatchConfig={handlePatchConfig}
          onResetConfig={handleResetConfig}
          onRefreshShells={handleRefreshShells}
        />
      </main>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`${styles.toast} ${toast.isError ? styles.toastError : ''}`}
        >
          {toast.text}
        </div>
      )}
    </div>
  )
}
