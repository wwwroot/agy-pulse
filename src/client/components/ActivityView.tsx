import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ActivityItem,
  JobOutputResponse,
  JobSummary,
  ResultPageResponse,
} from '../../shared/types.ts'
import styles from '../terminal.module.css'
import {
  copyToClipboard,
  fetchJobOutput,
  killJob,
  pageResult,
  sendJobInput,
  sendToConversation,
} from '../utils/api.ts'
import {
  formatBytes,
  formatCompactNumber,
  formatDuration,
  formatElapsed,
  formatRelativeAge,
  formatTime,
  middleTruncate,
} from '../utils/format.ts'

export interface ActivityViewProps {
  visible: boolean
  jobs: JobSummary[]
  activities: ActivityItem[]
  unreadAnomalies: number
  now: number
  onAcknowledge: () => Promise<void>
  onRefresh: () => Promise<void>
  onNotify: (message: string, isError?: boolean) => void
}

type FilterMode = 'all' | 'running' | 'anomalies' | 'read' | 'search' | 'mutate' | 'exec' | 'spilled'

const PAGE_SIZE = 20

interface UnifiedCard {
  key: string
  kind: ActivityItem['kind']
  source: 'agent' | 'user'
  description: string
  shortTitle: string
  commandPreview: string
  shell: string
  cwd: string
  status: ActivityItem['status']
  exitCode: number | null
  effectState?: ActivityItem['effectState']
  errorCode?: string
  durationMs: number
  startedAt: number
  endedAt?: number
  jobId?: string
  refId?: string
  outputPreview?: string
  savedBytes: number
  estimatedTokensSaved: number
  roundTripsSaved: number
  anomaly: boolean
  acknowledged: boolean
  job?: JobSummary
}

interface SpillPagerState {
  open: boolean
  loading: boolean
  error: string | null
  stream: 'combined' | 'stdout' | 'stderr'
  search: string
  caseInsensitive: boolean
  offset: number
  limit: number
  page: ResultPageResponse | null
}

const DEFAULT_PAGER: SpillPagerState = {
  open: false,
  loading: false,
  error: null,
  stream: 'combined',
  search: '',
  caseInsensitive: true,
  offset: 1,
  limit: 80,
  page: null,
}

function compactPathSegment(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 2) return normalized
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

function shortenActivityTitle(description: string): string {
  if (!description) return 'Pulse call'
  const compacted = description
    .replace(/[A-Za-z]:\\[^\s,)"']+/g, (m) => compactPathSegment(m))
    .replace(/(?:^|[\s(])(\/(?:[^\s,)"']+\/){2,}[^\s,)"']+)/g, (full, p: string) =>
      full.replace(p, compactPathSegment(p)),
    )
  return middleTruncate(compacted, 56)
}

function toolBadgeMeta(kind: ActivityItem['kind']): { label: string; className: string } {
  switch (kind) {
    case 'read':
      return { label: 'read', className: styles.toolRead }
    case 'search':
      return { label: 'search', className: styles.toolSearch }
    case 'mutate':
      return { label: 'mutate', className: styles.toolMutate }
    case 'doc':
      return { label: 'doc', className: styles.toolDoc }
    case 'job':
      return { label: 'job', className: styles.toolJob }
    case 'result':
      return { label: 'result', className: styles.toolResult }
    case 'exec':
    default:
      return { label: 'exec', className: styles.toolExec }
  }
}

function statusTextClass(status: UnifiedCard['status']): string {
  switch (status) {
    case 'completed':
      return styles.statusLabelOk
    case 'running':
      return styles.statusLabelInfo
    case 'promoted':
    case 'partial':
    case 'planned':
      return styles.statusLabelWarn
    case 'failed':
    case 'rejected':
    case 'killed':
    case 'cancelled':
      return styles.statusLabelErr
  }
}

function statusBadgeLabel(card: UnifiedCard): string {
  if (card.status === 'running') return 'running'
  if (card.status === 'promoted') return 'promoted'
  if (card.status === 'partial') return 'partial'
  if (card.status === 'planned') return 'dry-run'
  if (card.status === 'rejected') return card.errorCode || 'rejected'
  if (card.status === 'killed') return 'killed'
  if (card.status === 'cancelled') return 'cancelled'
  if (card.status === 'failed') return card.exitCode !== null ? `exit ${card.exitCode}` : 'failed'
  return card.status
}

function toolBadgeStatusClass(card: UnifiedCard): string {
  if (
    card.status === 'failed' ||
    card.status === 'rejected' ||
    card.status === 'killed' ||
    card.status === 'cancelled'
  ) {
    return styles.toolBadgeErr
  }
  if (card.status === 'promoted' || card.status === 'partial' || card.status === 'planned') {
    return styles.toolBadgeWarn
  }
  if (card.status === 'running') {
    return styles.toolBadgeInfo
  }
  return ''
}

interface ActivityRowProps {
  card: UnifiedCard
  expanded: boolean
  now: number
  jobOut?: JobOutputResponse
  loadingOut: boolean
  killing: boolean
  jobInput: string
  pager?: SpillPagerState
  onToggle: (card: UnifiedCard) => void
  onLoadJobOutput: (jobId: string) => void
  onKillJob: (jobId: string) => void
  onJobInputChange: (jobId: string, val: string) => void
  onSendJobInput: (jobId: string) => void
  onToggleSpillPager: (card: UnifiedCard) => void
  onLoadSpillPage: (cardKey: string, refId: string, overrides?: Partial<SpillPagerState>) => void
  onPagerSearchChange: (cardKey: string, val: string) => void
  onCopy: (card: UnifiedCard) => void
  onSendToChat: (card: UnifiedCard) => void
}

const ActivityRow: React.FC<ActivityRowProps> = React.memo(
  ({
    card,
    expanded,
    now,
    jobOut,
    loadingOut,
    killing,
    jobInput,
    pager,
    onToggle,
    onLoadJobOutput,
    onKillJob,
    onJobInputChange,
    onSendJobInput,
    onToggleSpillPager,
    onLoadSpillPage,
    onPagerSearchChange,
    onCopy,
    onSendToChat,
  }) => {
    const isRunning = card.status === 'running'
    const isNonOk = card.status !== 'completed'
    const toolBadge = toolBadgeMeta(card.kind)
    const showSavingsChip = card.estimatedTokensSaved > 0
    const activePager = pager ?? DEFAULT_PAGER
    const toolStatusClass = toolBadgeStatusClass(card)

    const elapsedLabel = isRunning
      ? formatElapsed(card.startedAt, null, now)
      : formatDuration(card.durationMs)
    const relativeAge = formatRelativeAge(card.endedAt ?? card.startedAt, now)

    return (
      <article className={styles.card}>
        <button
          type="button"
          className={styles.actRowHeader}
          aria-expanded={expanded}
          onClick={() => onToggle(card)}
          title={`${card.description} (${formatTime(card.startedAt)})`}
        >
          <div className={styles.actRowLeft}>
            {isRunning && <span className={styles.runningSpinner} aria-label="running" />}
            <span
              className={`${styles.toolBadge} ${toolBadge.className} ${toolStatusClass}`.trim()}
            >
              {toolBadge.label}
            </span>
            <span className={styles.actRowTitle}>{card.shortTitle}</span>
          </div>

          <div className={styles.actRowRight}>
            {showSavingsChip && (
              <span
                className={`${styles.actSavingsText} ${styles.tabular}`}
                title={`${card.estimatedTokensSaved.toLocaleString()} tokens (${formatBytes(card.savedBytes)})`}
              >
                -{formatCompactNumber(card.estimatedTokensSaved)}
              </span>
            )}
            {isNonOk && (
              <span className={`${styles.statusLabel} ${statusTextClass(card.status)}`}>
                {statusBadgeLabel(card)}
              </span>
            )}
            <span
              className={`${styles.actDuration} ${styles.tabular}`}
              title={`${isRunning ? 'Elapsed' : 'Duration'}: ${elapsedLabel} · ${relativeAge}`}
            >
              {elapsedLabel}
            </span>
            <span className={styles.chevron} aria-hidden="true">
              {expanded ? '▾' : '▸'}
            </span>
          </div>
        </button>

        {expanded && (
          <div className={styles.cardBody}>
            {card.commandPreview && (
              <div className={styles.actDetailCmd} title={card.commandPreview}>
                {card.kind === 'exec' || card.kind === 'job'
                  ? `$ ${card.commandPreview}`
                  : card.commandPreview}
              </div>
            )}

            {card.cwd && (
              <div className={styles.cwdLine} title={card.cwd}>
                cwd: {middleTruncate(card.cwd, 60)}
              </div>
            )}

            <div className={styles.cardActionRow}>
              <div className={styles.cardMetaRow}>
                <span className={styles.tabular} title={formatTime(card.startedAt)}>
                  {relativeAge}
                </span>
                <span className={styles.tabular}>{formatTime(card.startedAt)}</span>
                {card.shell && <span className={styles.shellTag}>{card.shell}</span>}
                {card.jobId && <span className={styles.shellTag}>{card.jobId}</span>}
                {card.roundTripsSaved > 0 && (
                  <span className={styles.tabular}>-{card.roundTripsSaved} RT</span>
                )}
                {card.refId && <span className={styles.mono}>spilled</span>}
              </div>

              <div className={styles.cardActionGroup}>
                {card.jobId && (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnSm}`}
                    disabled={loadingOut}
                    onClick={() => onLoadJobOutput(card.jobId!)}
                  >
                    {loadingOut ? 'Loading...' : 'Refresh'}
                  </button>
                )}
                {card.jobId && isRunning && (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnSm} ${styles.btnDanger}`}
                    disabled={killing}
                    onClick={() => onKillJob(card.jobId!)}
                  >
                    {killing ? 'Killing...' : 'Kill'}
                  </button>
                )}
                {card.refId && (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
                    onClick={() => onToggleSpillPager(card)}
                  >
                    {activePager.open ? 'Hide spilled' : 'Page full'}
                  </button>
                )}
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSm}`}
                  onClick={() => onCopy(card)}
                >
                  Copy
                </button>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSm}`}
                  onClick={() => onSendToChat(card)}
                >
                  Send
                </button>
              </div>
            </div>

            {card.jobId && isRunning && (
              <div className={styles.jobInputRow}>
                <input
                  type="text"
                  className={styles.jobInputField}
                  placeholder="stdin..."
                  aria-label="Job stdin"
                  value={jobInput}
                  onChange={(e) => onJobInputChange(card.jobId!, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      onSendJobInput(card.jobId!)
                    }
                  }}
                />
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSm}`}
                  disabled={!jobInput}
                  onClick={() => onSendJobInput(card.jobId!)}
                >
                  Send
                </button>
              </div>
            )}

            {jobOut ? (
              <>
                {jobOut.stdout && (
                  <div className={styles.outputBlock}>
                    <div className={styles.outputLabelRow}>
                      <span>stdout</span>
                      <span className={styles.tabular}>
                        {jobOut.eof
                          ? formatBytes(jobOut.nextStdoutOffset)
                          : `streaming (${formatBytes(jobOut.nextStdoutOffset)})`}
                      </span>
                    </div>
                    <pre className={styles.outputPre}>{jobOut.stdout}</pre>
                  </div>
                )}
                {jobOut.stderr && (
                  <div className={styles.outputBlock}>
                    <div className={styles.outputLabelRow}>
                      <span>stderr</span>
                      <span className={styles.tabular}>
                        {formatBytes(jobOut.nextStderrOffset)}
                      </span>
                    </div>
                    <pre className={`${styles.outputPre} ${styles.outputPreErr}`}>
                      {jobOut.stderr}
                    </pre>
                  </div>
                )}
                {!jobOut.stdout && !jobOut.stderr && (
                  <div className={styles.statusText}>No output yet.</div>
                )}
              </>
            ) : card.outputPreview ? (
              <div className={styles.outputBlock}>
                <div className={styles.outputLabelRow}>
                  <span>Preview</span>
                  {card.refId && <span className={styles.mono}>{card.refId}</span>}
                </div>
                <pre className={styles.outputPre}>{card.outputPreview}</pre>
              </div>
            ) : (
              <div className={styles.statusText}>
                {loadingOut ? 'Loading...' : 'No inline output.'}
              </div>
            )}

            {card.refId && activePager.open && (
              <div className={styles.pagerBox}>
                <div className={styles.pagerHeader}>
                  <div className={styles.pagerControls}>
                    <select
                      className={styles.selectInput}
                      value={activePager.stream}
                      onChange={(e) =>
                        onLoadSpillPage(card.key, card.refId!, {
                          stream: e.target.value as 'combined' | 'stdout' | 'stderr',
                          offset: 1,
                        })
                      }
                      aria-label="Output stream"
                    >
                      <option value="combined">Combined</option>
                      <option value="stdout">stdout</option>
                      <option value="stderr">stderr</option>
                    </select>

                    <input
                      type="text"
                      className={styles.pagerSearch}
                      placeholder="Search lines..."
                      value={activePager.search}
                      onChange={(e) => onPagerSearchChange(card.key, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          onLoadSpillPage(card.key, card.refId!, { offset: 1 })
                        }
                      }}
                      aria-label="Search spilled output"
                    />

                    <button
                      type="button"
                      className={`${styles.searchToggleBtn} ${
                        !activePager.caseInsensitive ? styles.searchToggleBtnActive : ''
                      }`}
                      title="Match case"
                      aria-label="Match case"
                      onClick={() =>
                        onLoadSpillPage(card.key, card.refId!, {
                          caseInsensitive: !activePager.caseInsensitive,
                          offset: 1,
                        })
                      }
                    >
                      Aa
                    </button>

                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnSm}`}
                      disabled={activePager.loading}
                      onClick={() => onLoadSpillPage(card.key, card.refId!, { offset: 1 })}
                    >
                      Search
                    </button>
                  </div>

                  <div className={styles.pagerControls}>
                    {activePager.page && (
                      <span className={`${styles.statusText} ${styles.tabular}`}>
                        {activePager.page.offset}–
                        {activePager.page.offset + Math.max(0, activePager.page.returnedLines - 1)}{' '}
                        / {activePager.page.totalLines} ({formatBytes(activePager.page.totalBytes)})
                      </span>
                    )}
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnSm}`}
                      disabled={
                        activePager.loading || !activePager.page || activePager.page.offset <= 1
                      }
                      onClick={() =>
                        onLoadSpillPage(card.key, card.refId!, {
                          offset: Math.max(1, (activePager.page?.offset ?? 1) - activePager.limit),
                        })
                      }
                    >
                      Prev
                    </button>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnSm}`}
                      disabled={activePager.loading || !activePager.page?.nextOffset}
                      onClick={() =>
                        onLoadSpillPage(card.key, card.refId!, {
                          offset: activePager.page?.nextOffset ?? 1,
                        })
                      }
                    >
                      Next
                    </button>
                  </div>
                </div>

                {activePager.loading ? (
                  <div className={styles.statusText}>Loading...</div>
                ) : activePager.error ? (
                  <div className={`${styles.statusText} ${styles.statusTextErr}`}>
                    {activePager.error}
                  </div>
                ) : activePager.page ? (
                  <pre className={styles.outputPre}>
                    {activePager.page.content || '(No matching lines)'}
                  </pre>
                ) : null}
              </div>
            )}
          </div>
        )}
      </article>
    )
  },
)

export const ActivityView: React.FC<ActivityViewProps> = ({
  visible,
  jobs,
  activities,
  unreadAnomalies,
  now,
  onAcknowledge,
  onRefresh,
  onNotify,
}) => {
  const [filter, setFilter] = useState<FilterMode>('all')
  const [query, setQuery] = useState('')
  const [visibleLimit, setVisibleLimit] = useState<number>(PAGE_SIZE)
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set())
  const [jobOutputs, setJobOutputs] = useState<Record<string, JobOutputResponse>>({})
  const [loadingJobIds, setLoadingJobIds] = useState<Set<string>>(() => new Set())
  const [killingJobIds, setKillingJobIds] = useState<Set<string>>(() => new Set())
  const [jobInputs, setJobInputs] = useState<Record<string, string>>({})
  const [pagers, setPagers] = useState<Record<string, SpillPagerState>>({})

  // Keep refs for memo-safe callbacks so typing in one row's pager/stdin does not thrash all ActivityRows.
  const pagersRef = useRef(pagers)
  pagersRef.current = pagers
  const jobInputsRef = useRef(jobInputs)
  jobInputsRef.current = jobInputs
  const jobOutputsRef = useRef(jobOutputs)
  jobOutputsRef.current = jobOutputs

  useEffect(() => {
    setVisibleLimit(PAGE_SIZE)
  }, [filter, query])

  const unifiedCards = useMemo<UnifiedCard[]>(() => {
    const jobById = new Map<string, JobSummary>()
    for (const job of jobs) {
      jobById.set(job.id, job)
    }

    const seenJobIds = new Set<string>()
    const list: UnifiedCard[] = []

    for (const act of activities) {
      const linkedJob = act.jobId ? jobById.get(act.jobId) : undefined
      if (linkedJob) seenJobIds.add(linkedJob.id)

      const mergedStatus = linkedJob ? linkedJob.status : act.status
      const mergedExitCode = linkedJob ? linkedJob.exitCode : act.exitCode
      const mergedDuration = linkedJob ? linkedJob.durationMs : act.durationMs
      const mergedRefId = linkedJob?.refId || act.refId
      const savedBytes = Math.max(0, act.savedBytes ?? 0)
      const estimatedTokensSaved =
        typeof act.estimatedTokensSaved === 'number'
          ? Math.max(0, act.estimatedTokensSaved)
          : Math.round(savedBytes / 4)
      const description = act.description || linkedJob?.description || 'Pulse call'

      list.push({
        key: act.id,
        kind: act.kind,
        source: act.source,
        description,
        shortTitle: shortenActivityTitle(description),
        commandPreview: act.commandPreview || linkedJob?.commandPreview || '',
        shell: act.shell || linkedJob?.shell || '',
        cwd: act.cwd || linkedJob?.cwd || '',
        status: mergedStatus,
        exitCode: mergedExitCode,
        effectState: act.effectState,
        errorCode: act.errorCode,
        durationMs: mergedDuration,
        startedAt: act.startedAt,
        endedAt: linkedJob?.endedAt ?? act.endedAt,
        jobId: act.jobId,
        refId: mergedRefId,
        outputPreview: act.outputPreview,
        savedBytes,
        estimatedTokensSaved,
        roundTripsSaved: Math.max(0, act.roundTripsSaved ?? 0),
        anomaly:
          act.anomaly ||
          mergedStatus === 'failed' ||
          mergedStatus === 'killed' ||
          mergedStatus === 'rejected',
        acknowledged: act.acknowledged,
        job: linkedJob,
      })
    }

    for (const job of jobs) {
      if (seenJobIds.has(job.id)) continue
      const description = job.description || `Job ${job.id}`
      list.push({
        key: `job:${job.id}`,
        kind: 'job',
        source: 'agent',
        description,
        shortTitle: shortenActivityTitle(description),
        commandPreview: job.commandPreview,
        shell: job.shell,
        cwd: job.cwd,
        status: job.status,
        exitCode: job.exitCode,
        durationMs: job.durationMs,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        jobId: job.id,
        refId: job.refId,
        savedBytes: 0,
        estimatedTokensSaved: 0,
        roundTripsSaved: 0,
        anomaly: job.status === 'failed' || job.status === 'killed',
        acknowledged: false,
        job,
      })
    }

    list.sort((a, b) => {
      const aRunning = a.status === 'running' ? 1 : 0
      const bRunning = b.status === 'running' ? 1 : 0
      if (aRunning !== bRunning) return bRunning - aRunning
      return b.startedAt - a.startedAt
    })

    return list
  }, [jobs, activities])

  const counts = useMemo(() => {
    let running = 0
    let anomalies = 0
    let read = 0
    let search = 0
    let mutate = 0
    let exec = 0
    let spilled = 0
    for (const c of unifiedCards) {
      if (c.status === 'running') running += 1
      if (c.anomaly) anomalies += 1
      if (c.kind === 'read' || c.kind === 'doc') read += 1
      if (c.kind === 'search') search += 1
      if (c.kind === 'mutate') mutate += 1
      if (c.kind === 'exec' || c.kind === 'job') exec += 1
      if (c.refId) spilled += 1
    }
    return { running, anomalies, read, search, mutate, exec, spilled }
  }, [unifiedCards])

  const filteredCards = useMemo(() => {
    const q = query.trim().toLowerCase()
    return unifiedCards.filter((card) => {
      if (filter === 'running' && card.status !== 'running') return false
      if (filter === 'anomalies' && !card.anomaly) return false
      if (filter === 'read' && card.kind !== 'read' && card.kind !== 'doc') return false
      if (filter === 'search' && card.kind !== 'search') return false
      if (filter === 'mutate' && card.kind !== 'mutate') return false
      if (filter === 'exec' && card.kind !== 'exec' && card.kind !== 'job') return false
      if (filter === 'spilled' && !card.refId) return false
      if (!q) return true
      return (
        card.kind.toLowerCase().includes(q) ||
        card.description.toLowerCase().includes(q) ||
        card.commandPreview.toLowerCase().includes(q) ||
        card.cwd.toLowerCase().includes(q) ||
        card.shell.toLowerCase().includes(q) ||
        (card.jobId && card.jobId.toLowerCase().includes(q)) ||
        (card.refId && card.refId.toLowerCase().includes(q))
      )
    })
  }, [unifiedCards, filter, query])

  const visibleCards = useMemo(
    () => filteredCards.slice(0, visibleLimit),
    [filteredCards, visibleLimit],
  )
  const remainingCount = Math.max(0, filteredCards.length - visibleCards.length)

  const loadJobOutput = useCallback(
    async (jobId: string) => {
      setLoadingJobIds((prev) => new Set(prev).add(jobId))
      try {
        const res = await fetchJobOutput(jobId, {
          stdoutOffset: 0,
          stderrOffset: 0,
          maxBytes: 32_768,
        })
        setJobOutputs((prev) => ({ ...prev, [jobId]: res }))
      } catch (err) {
        onNotify(err instanceof Error ? err.message : 'Failed to load job output', true)
      } finally {
        setLoadingJobIds((prev) => {
          const next = new Set(prev)
          next.delete(jobId)
          return next
        })
      }
    },
    [onNotify],
  )

  const toggleExpand = useCallback(
    (card: UnifiedCard) => {
      setExpandedKeys((prev) => {
        const next = new Set(prev)
        if (next.has(card.key)) {
          next.delete(card.key)
        } else {
          next.add(card.key)
          if (card.jobId) {
            void loadJobOutput(card.jobId)
          }
        }
        return next
      })
    },
    [loadJobOutput],
  )

  const handleKillJob = useCallback(
    async (jobId: string) => {
      setKillingJobIds((prev) => new Set(prev).add(jobId))
      try {
        await killJob(jobId)
        onNotify(`Killed job ${jobId}`)
        await onRefresh()
        void loadJobOutput(jobId)
      } catch (err) {
        onNotify(err instanceof Error ? err.message : 'Failed to kill job', true)
      } finally {
        setKillingJobIds((prev) => {
          const next = new Set(prev)
          next.delete(jobId)
          return next
        })
      }
    },
    [onNotify, onRefresh, loadJobOutput],
  )

  const handleJobInputChange = useCallback((jobId: string, val: string) => {
    setJobInputs((prev) => ({ ...prev, [jobId]: val }))
  }, [])

  const handleSendJobInput = useCallback(
    async (jobId: string) => {
      const value = jobInputsRef.current[jobId] ?? ''
      if (!value) return
      try {
        await sendJobInput(jobId, value.endsWith('\n') ? value : `${value}\n`)
        setJobInputs((prev) => ({ ...prev, [jobId]: '' }))
        onNotify(`Sent input to ${jobId}`)
        setTimeout(() => void loadJobOutput(jobId), 250)
      } catch (err) {
        onNotify(err instanceof Error ? err.message : 'Failed to send input', true)
      }
    },
    [onNotify, loadJobOutput],
  )

  const loadSpillPage = useCallback(
    async (cardKey: string, refId: string, overrides: Partial<SpillPagerState> = {}) => {
      const prevState = pagersRef.current[cardKey] ?? DEFAULT_PAGER
      const nextState: SpillPagerState = {
        ...prevState,
        ...overrides,
        open: true,
        loading: true,
        error: null,
      }
      setPagers((prev) => ({ ...prev, [cardKey]: nextState }))
      try {
        const page = await pageResult({
          refId,
          offset: nextState.offset,
          limit: nextState.limit,
          maxBytes: 24_576,
          search: nextState.search.trim() || undefined,
          caseInsensitive: nextState.caseInsensitive,
          stream: nextState.stream,
        })
        setPagers((prev) => ({
          ...prev,
          [cardKey]: {
            ...(prev[cardKey] ?? nextState),
            open: true,
            loading: false,
            error: null,
            page,
          },
        }))
      } catch (err) {
        setPagers((prev) => ({
          ...prev,
          [cardKey]: {
            ...(prev[cardKey] ?? nextState),
            open: true,
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to load spilled result',
          },
        }))
      }
    },
    [],
  )

  const handleToggleSpillPager = useCallback(
    (card: UnifiedCard) => {
      if (!card.refId) return
      const existing = pagersRef.current[card.key]
      if (existing?.open) {
        setPagers((prev) => ({
          ...prev,
          [card.key]: { ...(prev[card.key] ?? DEFAULT_PAGER), open: false },
        }))
      } else {
        void loadSpillPage(card.key, card.refId, { offset: 1 })
      }
    },
    [loadSpillPage],
  )

  const handlePagerSearchChange = useCallback((cardKey: string, val: string) => {
    setPagers((prev) => ({
      ...prev,
      [cardKey]: { ...(prev[cardKey] ?? DEFAULT_PAGER), search: val },
    }))
  }, [])

  const buildCardSnippet = useCallback((card: UnifiedCard): string => {
    const jobOut = card.jobId ? jobOutputsRef.current[card.jobId] : undefined
    const pager = pagersRef.current[card.key]
    const badge = toolBadgeMeta(card.kind)
    const lines = [
      `[${badge.label}] ${card.description}`,
      card.commandPreview ? `Target: ${card.commandPreview}` : '',
      card.cwd ? `Cwd: ${card.cwd}` : '',
      card.shell ? `Shell: ${card.shell}` : '',
      `Status: ${statusBadgeLabel(card)} (${formatDuration(card.durationMs)})`,
      card.savedBytes > 0
        ? `Saved: ${formatCompactNumber(card.estimatedTokensSaved)} tok (${formatBytes(card.savedBytes)})`
        : '',
    ].filter(Boolean)

    const body =
      pager?.open && pager.page?.content
        ? pager.page.content
        : jobOut
          ? [
              jobOut.stdout ? `[stdout]\n${jobOut.stdout}` : '',
              jobOut.stderr ? `[stderr]\n${jobOut.stderr}` : '',
            ]
              .filter(Boolean)
              .join('\n')
          : card.outputPreview || ''

    if (body.trim()) {
      lines.push('```text', body.slice(0, 8000), '```')
    }
    if (card.refId) {
      lines.push(`Spill reference: ${card.refId}`)
    }
    return lines.join('\n')
  }, [])

  const handleCopyCard = useCallback(
    async (card: UnifiedCard) => {
      const ok = await copyToClipboard(buildCardSnippet(card))
      onNotify(ok ? 'Copied to clipboard' : 'Copy failed', !ok)
    },
    [buildCardSnippet, onNotify],
  )

  const handleSendCardToChat = useCallback(
    async (card: UnifiedCard) => {
      const outcome = await sendToConversation(buildCardSnippet(card))
      if (outcome === 'sent') {
        onNotify('Sent to chat')
      } else if (outcome === 'copied') {
        onNotify('Copied to clipboard')
      } else {
        onNotify('Failed to send', true)
      }
    },
    [buildCardSnippet, onNotify],
  )

  const handleLoadJobOutput = useCallback((id: string) => void loadJobOutput(id), [loadJobOutput])
  const handleKillJobCb = useCallback((id: string) => void handleKillJob(id), [handleKillJob])
  const handleSendJobInputCb = useCallback(
    (id: string) => void handleSendJobInput(id),
    [handleSendJobInput],
  )
  const handleLoadSpillPageCb = useCallback(
    (k: string, r: string, o?: Partial<SpillPagerState>) => void loadSpillPage(k, r, o),
    [loadSpillPage],
  )
  const handleCopyCb = useCallback((c: UnifiedCard) => void handleCopyCard(c), [handleCopyCard])
  const handleSendCb = useCallback(
    (c: UnifiedCard) => void handleSendCardToChat(c),
    [handleSendCardToChat],
  )

  const filterOptions: Array<{ id: FilterMode; label: string; count: number }> = [
    { id: 'all', label: 'All', count: unifiedCards.length },
    { id: 'running', label: 'Running', count: counts.running },
    { id: 'anomalies', label: 'Errors', count: counts.anomalies },
    { id: 'read', label: 'Read', count: counts.read },
    { id: 'search', label: 'Search', count: counts.search },
    { id: 'mutate', label: 'Mutate', count: counts.mutate },
    { id: 'exec', label: 'Exec', count: counts.exec },
    { id: 'spilled', label: 'Spilled', count: counts.spilled },
  ]

  return (
    <section
      className={`${styles.activityView} ${!visible ? styles.hiddenPane : ''}`}
      aria-label="Activity and jobs"
    >
      <div className={styles.activityToolbar}>
        <div className={styles.activitySearchRow}>
          <input
            type="text"
            className={styles.filterSearch}
            placeholder="Filter activity..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter activity text"
          />

          <select
            className={`${styles.selectInput} ${styles.activityFilterSelect}`}
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterMode)}
            aria-label="Filter activity category"
          >
            {filterOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.id === 'all' || opt.count > 0 ? `${opt.label} (${opt.count})` : opt.label}
              </option>
            ))}
          </select>

          {unreadAnomalies > 0 && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              onClick={() => void onAcknowledge()}
            >
              Clear ({unreadAnomalies})
            </button>
          )}
        </div>
      </div>

      <div className={styles.activityList}>
        <div className={styles.activityInner}>
          {visibleCards.length === 0 ? (
            <div className={styles.panel}>
              <div className={styles.panelEmpty}>
                {unifiedCards.length === 0 ? 'No activity yet.' : 'No matching entries.'}
              </div>
            </div>
          ) : (
            <div className={styles.panel}>
              <div className={styles.actFeedList}>
                {visibleCards.map((card) => (
                  <ActivityRow
                    key={card.key}
                    card={card}
                    expanded={expandedKeys.has(card.key)}
                    now={now}
                    jobOut={card.jobId ? jobOutputs[card.jobId] : undefined}
                    loadingOut={card.jobId ? loadingJobIds.has(card.jobId) : false}
                    killing={card.jobId ? killingJobIds.has(card.jobId) : false}
                    jobInput={card.jobId ? (jobInputs[card.jobId] ?? '') : ''}
                    pager={pagers[card.key]}
                    onToggle={toggleExpand}
                    onLoadJobOutput={handleLoadJobOutput}
                    onKillJob={handleKillJobCb}
                    onJobInputChange={handleJobInputChange}
                    onSendJobInput={handleSendJobInputCb}
                    onToggleSpillPager={handleToggleSpillPager}
                    onLoadSpillPage={handleLoadSpillPageCb}
                    onPagerSearchChange={handlePagerSearchChange}
                    onCopy={handleCopyCb}
                    onSendToChat={handleSendCb}
                  />
                ))}
              </div>

              {remainingCount > 0 && (
                <button
                  type="button"
                  className={`${styles.loadMoreLink} ${styles.tabular}`}
                  onClick={() => setVisibleLimit((prev) => prev + PAGE_SIZE)}
                >
                  Load more ({remainingCount} remaining)
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
