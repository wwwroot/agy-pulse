import path from 'node:path'
import type { ReadFileItemResult } from '../shared/types.ts'

const MIN_DEDUP_CONTENT_CHARS = 160
const DEFAULT_MAX_DEDUP_ENTRIES = 2048

export interface ReadDedupEntry {
  path: string
  revision: string
  mtimeMs?: number
  size: number
  rawBytes: number
  readAt: number
}

export type ReadDedupCheckResult =
  | {
      deduplicated: true
      savedBytes: number
      notice: string
    }
  | {
      deduplicated: false
    }

export function normalizeDedupPath(filePath: string): string {
  const resolved = path.resolve(filePath).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export interface LineInterval {
  start: number
  end: number
}

export interface PersistedReadDedupRange {
  path: string
  revision: string
  intervals: LineInterval[]
}

export interface PersistedReadDedupSnapshot {
  entries: Array<[string, ReadDedupEntry]>
  textRanges: PersistedReadDedupRange[]
}

const DEFAULT_PERSIST_MAX_ENTRIES = 256
const DEFAULT_PERSIST_MAX_RANGES = 128

function mergeIntervals(intervals: LineInterval[], added: LineInterval): LineInterval[] {
  const next = [...intervals, added].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: LineInterval[] = []
  for (const iv of next) {
    const prev = merged[merged.length - 1]
    if (!prev || iv.start > prev.end + 1) {
      merged.push({ start: iv.start, end: iv.end })
    } else if (iv.end > prev.end) {
      prev.end = iv.end
    }
  }
  return merged
}

/**
 * Extracts exact contiguous numbered line intervals delivered inline inside `content`,
 * splitting across middle-truncation markers and dropping potentially partial boundary
 * lines adjacent to an omission marker so omitted lines are never marked seen.
 */
export function extractDeliveredLineIntervals(content: string): LineInterval[] {
  if (!content) return []
  const rawLines = content.split(/\r?\n/)
  const runs: LineInterval[] = []
  let runStart = -1
  let runEnd = -1
  let prevWasOmission = false

  const flushRun = (trimEnd: boolean) => {
    if (runStart > 0 && runEnd >= runStart) {
      const safeEnd = trimEnd ? runEnd - 1 : runEnd
      if (safeEnd - runStart + 1 >= 3) {
        runs.push({ start: runStart, end: safeEnd })
      }
    }
    runStart = -1
    runEnd = -1
  }

  let lastRunEndedBeforeBlank = false

  for (const line of rawLines) {
    if (line.includes('chars omitted') || line.startsWith('...[truncated inline')) {
      if (runStart > 0) {
        flushRun(true)
      } else if (lastRunEndedBeforeBlank && runs.length > 0) {
        const prev = runs[runs.length - 1]
        prev.end -= 1
        if (prev.end - prev.start + 1 < 3) {
          runs.pop()
        }
      }
      lastRunEndedBeforeBlank = false
      prevWasOmission = true
      continue
    }
    if (line.trim().length === 0) {
      if (runStart > 0) {
        flushRun(false)
        lastRunEndedBeforeBlank = true
      }
      continue
    }
    const m = /^\s*(\d+)\|/.exec(line)
    if (!m) {
      flushRun(false)
      lastRunEndedBeforeBlank = false
      continue
    }
    lastRunEndedBeforeBlank = false
    const lineNo = Number.parseInt(m[1], 10)
    if (!Number.isFinite(lineNo) || lineNo <= 0) continue

    // Skip the very first numbered line right after an omission marker in case its prefix was cut.
    if (prevWasOmission) {
      prevWasOmission = false
      continue
    }

    if (runStart === -1) {
      runStart = lineNo
      runEnd = lineNo
    } else if (lineNo === runEnd + 1) {
      runEnd = lineNo
    } else {
      flushRun(false)
      runStart = lineNo
      runEnd = lineNo
    }
  }
  flushRun(false)
  return runs
}

export class ReadDedupStore {
  private readonly isEnabled: () => boolean
  private readonly maxEntries: number
  private readonly cache = new Map<string, ReadDedupEntry>()
  // Merged inline-delivered text line intervals per (normalizedPath -> { revision, intervals })
  private readonly textRanges = new Map<string, { revision: string; intervals: LineInterval[] }>()

  constructor(
    isEnabled: () => boolean = () => true,
    maxEntries: number = DEFAULT_MAX_DEDUP_ENTRIES,
  ) {
    this.isEnabled = isEnabled
    this.maxEntries = Math.max(64, maxEntries)
  }

  private buildKey(item: ReadFileItemResult, requestedLimit?: number): {
    normPath: string
    key: string
  } {
    const normPath = normalizeDedupPath(item.path)
    const limitPart =
      typeof requestedLimit === 'number' && Number.isFinite(requestedLimit)
        ? Math.floor(requestedLimit)
        : item.returnedLines
    const symbolPart = item.symbol ? item.symbol.trim() : ''
    const key = `${normPath}|${item.offset}|${limitPart}|${item.view}|${symbolPart}`
    return { normPath, key }
  }

  private isEligible(item: ReadFileItemResult): boolean {
    return Boolean(
      item.exists &&
        !item.error &&
        !item.isDir &&
        item.view !== 'stat' &&
        item.revision &&
        item.revision.trim().length > 0,
    )
  }

  check(
    item: ReadFileItemResult,
    force = false,
    requestedLimit?: number,
  ): ReadDedupCheckResult {
    if (!this.isEligible(item) || force || !this.isEnabled()) {
      return { deduplicated: false }
    }
    if (item.content.length <= MIN_DEDUP_CONTENT_CHARS) {
      return { deduplicated: false }
    }

    const { normPath, key } = this.buildKey(item, requestedLimit)
    const rawBytes = Buffer.byteLength(item.content, 'utf-8')
    const cached = this.cache.get(key)

    if (cached && cached.revision === item.revision) {
      this.cache.delete(key)
      this.cache.set(key, { ...cached, readAt: Date.now() })
      const notice = `[Unchanged: already read in this session; rev=${item.revision}]`
      const noticeBytes = Buffer.byteLength(notice, 'utf-8')
      return {
        deduplicated: true,
        savedBytes: Math.max(0, rawBytes - noticeBytes),
        notice,
      }
    }

    // Interval/subset containment check for text views on the same revision:
    // if the requested lines [start..end] were already delivered inline earlier in this session,
    // deduplicate even when offset/limit differs from the original read call.
    if (item.view === 'text' && item.returnedLines > 0) {
      const rangeState = this.textRanges.get(normPath)
      if (rangeState && rangeState.revision === item.revision) {
        const reqStart = item.offset
        const reqEnd = item.offset + item.returnedLines - 1
        const covered = rangeState.intervals.some(
          (iv) => iv.start <= reqStart && reqEnd <= iv.end,
        )
        if (covered) {
          const notice = `[Unchanged: L${reqStart}-L${reqEnd} already read in this session; rev=${item.revision}]`
          const noticeBytes = Buffer.byteLength(notice, 'utf-8')
          return {
            deduplicated: true,
            savedBytes: Math.max(0, rawBytes - noticeBytes),
            notice,
          }
        }
      }
    }

    return { deduplicated: false }
  }

  record(item: ReadFileItemResult, requestedLimit?: number): void {
    if (!this.isEligible(item)) return

    const { normPath, key } = this.buildKey(item, requestedLimit)
    const rawBytes = Buffer.byteLength(item.content, 'utf-8')

    this.cache.delete(key)
    this.cache.set(key, {
      path: normPath,
      revision: item.revision,
      mtimeMs: item.mtimeMs,
      size: item.bytes,
      rawBytes,
      readAt: Date.now(),
    })

    if ((item.view === 'text' || item.view === 'symbol') && item.returnedLines > 0 && item.offset > 0) {
      const iv: LineInterval = {
        start: item.offset,
        end: item.offset + item.returnedLines - 1,
      }
      const existing = this.textRanges.get(normPath)
      if (existing && existing.revision === item.revision) {
        existing.intervals = mergeIntervals(existing.intervals, iv)
      } else {
        this.textRanges.set(normPath, { revision: item.revision, intervals: [iv] })
      }
    }

    if (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey)
      }
    }
  }

  /**
   * Records exact delivered line intervals for a partially truncated text read so
   * already-delivered head/tail spans deduplicate while omitted lines stay uncached.
   */
  recordLineRanges(filePath: string, revision: string, intervals: LineInterval[]): void {
    if (!this.isEnabled() || !filePath || !revision || intervals.length === 0) return
    const normPath = normalizeDedupPath(filePath)
    let existing = this.textRanges.get(normPath)
    if (!existing || existing.revision !== revision) {
      existing = { revision, intervals: [] }
      this.textRanges.set(normPath, existing)
    }
    for (const iv of intervals) {
      if (iv.start > 0 && iv.end >= iv.start) {
        existing.intervals = mergeIntervals(existing.intervals, iv)
      }
    }
    if (this.textRanges.size > this.maxEntries) {
      const oldest = this.textRanges.keys().next().value
      if (oldest !== undefined) this.textRanges.delete(oldest)
    }
  }

  /**
   * Exports a bounded snapshot of recent dedup entries and line intervals for session persistence.
   */
  exportSnapshot(
    maxEntries: number = DEFAULT_PERSIST_MAX_ENTRIES,
    maxRanges: number = DEFAULT_PERSIST_MAX_RANGES,
  ): PersistedReadDedupSnapshot {
    const allEntries = [...this.cache.entries()]
    const keptEntries =
      allEntries.length > maxEntries ? allEntries.slice(allEntries.length - maxEntries) : allEntries

    const textRanges: PersistedReadDedupRange[] = []
    for (const [normPath, state] of this.textRanges.entries()) {
      textRanges.push({
        path: normPath,
        revision: state.revision,
        intervals: state.intervals.slice(0, 64).map((iv) => ({ start: iv.start, end: iv.end })),
      })
      if (textRanges.length >= maxRanges) break
    }

    return {
      entries: keptEntries.map(([key, entry]) => [key, { ...entry }]),
      textRanges,
    }
  }

  /**
   * Restores a persisted dedup snapshot on session load.
   */
  hydrateSnapshot(snapshot: PersistedReadDedupSnapshot | undefined): void {
    this.cache.clear()
    this.textRanges.clear()
    if (!snapshot || typeof snapshot !== 'object') return

    if (Array.isArray(snapshot.entries)) {
      const slice =
        snapshot.entries.length > this.maxEntries
          ? snapshot.entries.slice(snapshot.entries.length - this.maxEntries)
          : snapshot.entries
      for (const pair of slice) {
        if (!Array.isArray(pair) || pair.length !== 2) continue
        const [key, entry] = pair
        if (
          typeof key !== 'string' ||
          !entry ||
          typeof entry !== 'object' ||
          typeof entry.path !== 'string' ||
          typeof entry.revision !== 'string' ||
          entry.revision.length === 0
        ) {
          continue
        }
        this.cache.set(key, {
          path: entry.path,
          revision: entry.revision,
          mtimeMs: typeof entry.mtimeMs === 'number' ? entry.mtimeMs : undefined,
          size: typeof entry.size === 'number' ? entry.size : 0,
          rawBytes: typeof entry.rawBytes === 'number' ? entry.rawBytes : 0,
          readAt: typeof entry.readAt === 'number' ? entry.readAt : Date.now(),
        })
      }
    }

    if (Array.isArray(snapshot.textRanges)) {
      for (const item of snapshot.textRanges) {
        if (
          !item ||
          typeof item !== 'object' ||
          typeof item.path !== 'string' ||
          typeof item.revision !== 'string' ||
          !Array.isArray(item.intervals)
        ) {
          continue
        }
        let merged: LineInterval[] = []
        for (const iv of item.intervals) {
          if (
            iv &&
            typeof iv.start === 'number' &&
            typeof iv.end === 'number' &&
            Number.isFinite(iv.start) &&
            Number.isFinite(iv.end) &&
            iv.start >= 1 &&
            iv.end >= iv.start
          ) {
            merged = mergeIntervals(merged, {
              start: Math.floor(iv.start),
              end: Math.floor(iv.end),
            })
          }
        }
        if (merged.length > 0) {
          this.textRanges.set(item.path, { revision: item.revision, intervals: merged })
        }
      }
    }
  }

  checkAndRecord(
    item: ReadFileItemResult,
    force = false,
    requestedLimit?: number,
  ): ReadDedupCheckResult {
    const hit = this.check(item, force, requestedLimit)
    if (hit.deduplicated) {
      return hit
    }
    this.record(item, requestedLimit)
    return { deduplicated: false }
  }

  invalidatePath(filePath: string): number {
    if (!filePath || filePath.trim().length === 0) return 0
    const target = normalizeDedupPath(filePath)
    const prefix = `${target}/`
    let removed = 0

    for (const [key, entry] of this.cache.entries()) {
      if (entry.path === target || entry.path.startsWith(prefix)) {
        this.cache.delete(key)
        removed++
      }
    }

    for (const trackedPath of this.textRanges.keys()) {
      if (trackedPath === target || trackedPath.startsWith(prefix)) {
        this.textRanges.delete(trackedPath)
      }
    }

    return removed
  }

  invalidateAll(): number {
    const count = this.size()
    this.cache.clear()
    this.textRanges.clear()
    return count
  }

  size(): number {
    if (this.textRanges.size === 0) return this.cache.size
    const cachePaths = new Set<string>()
    for (const entry of this.cache.values()) {
      cachePaths.add(entry.path)
    }
    let rangeOnlyPaths = 0
    for (const normPath of this.textRanges.keys()) {
      if (!cachePaths.has(normPath)) rangeOnlyPaths++
    }
    return this.cache.size + rangeOnlyPaths
  }
}
