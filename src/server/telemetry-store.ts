import { EventEmitter } from 'node:events'
import type {
  SavingsCategory,
  SavingsCategoryBreakdown,
  TokenSavingsSummary,
} from '../shared/types.ts'

export const ALL_SAVINGS_CATEGORIES: readonly SavingsCategory[] = [
  'read-dedup',
  'outline-read',
  'symbol-read',
  'batch-read',
  'grep-progressive',
  'git-compact',
  'json-digest',
  'spillover',
  'batch-mutate',
  'native-doc',
] as const

export interface TelemetryCategoryDelta {
  calls?: number
  savedBytes: number
  roundTripsSaved?: number
}

export interface TelemetryRecordInput {
  rawBytes: number
  deliveredBytes: number
  savedBytes?: number
  durationMs: number
  roundTripsSaved?: number
  dedupHits?: number
  isShellExec?: boolean
  primaryCategory?: SavingsCategory
  categories?: Partial<Record<SavingsCategory, TelemetryCategoryDelta>>
}

export function createEmptyBreakdown(): Record<SavingsCategory, SavingsCategoryBreakdown> {
  return {
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
  }
}

export function estimateTokensFromBytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0
  return Math.round(bytes / 4)
}

export function mergeTokenSavingsSummaries(
  summaries: readonly TokenSavingsSummary[],
): TokenSavingsSummary {
  const byCategory = createEmptyBreakdown()
  let totalCalls = 0
  let totalRawBytes = 0
  let totalDeliveredBytes = 0
  let totalSavedBytes = 0
  let roundTripsSaved = 0
  let dedupHits = 0
  let weightedDurationSum = 0
  let weightedMedianSum = 0
  let weightedMedianCalls = 0
  let weightedOpsSum = 0
  let weightedOpsCalls = 0

  for (const s of summaries) {
    if (!s) continue
    const calls = Math.max(0, Math.round(Number.isFinite(s.totalCalls) ? s.totalCalls : 0))
    totalCalls += calls
    totalRawBytes += Math.max(0, Math.round(Number.isFinite(s.totalRawBytes) ? s.totalRawBytes : 0))
    totalDeliveredBytes += Math.max(
      0,
      Math.round(Number.isFinite(s.totalDeliveredBytes) ? s.totalDeliveredBytes : 0),
    )
    totalSavedBytes += Math.max(
      0,
      Math.round(Number.isFinite(s.totalSavedBytes) ? s.totalSavedBytes : 0),
    )
    roundTripsSaved += Math.max(
      0,
      Math.round(Number.isFinite(s.roundTripsSaved) ? s.roundTripsSaved : 0),
    )
    dedupHits += Math.max(0, Math.round(Number.isFinite(s.dedupHits) ? s.dedupHits : 0))
    weightedDurationSum +=
      calls * Math.max(0, Number.isFinite(s.avgDurationMs) ? s.avgDurationMs : 0)
    if (calls > 0 && typeof s.medianDurationMs === 'number' && Number.isFinite(s.medianDurationMs)) {
      weightedMedianSum += calls * Math.max(0, s.medianDurationMs)
      weightedMedianCalls += calls
    }
    if (calls > 0 && typeof s.opsAvgDurationMs === 'number' && Number.isFinite(s.opsAvgDurationMs)) {
      weightedOpsSum += calls * Math.max(0, s.opsAvgDurationMs)
      weightedOpsCalls += calls
    }

    if (s.byCategory && typeof s.byCategory === 'object') {
      for (const category of ALL_SAVINGS_CATEGORIES) {
        const src = s.byCategory[category]
        if (!src) continue
        const target = byCategory[category]
        target.calls += Math.max(0, Math.round(Number.isFinite(src.calls) ? src.calls : 0))
        target.savedBytes += Math.max(
          0,
          Math.round(Number.isFinite(src.savedBytes) ? src.savedBytes : 0),
        )
        target.estimatedTokensSaved = estimateTokensFromBytes(target.savedBytes)
        if (typeof src.roundTripsSaved === 'number' && Number.isFinite(src.roundTripsSaved) && src.roundTripsSaved > 0) {
          target.roundTripsSaved = (target.roundTripsSaved ?? 0) + Math.round(src.roundTripsSaved)
        }
      }
    }
  }

  return {
    totalCalls,
    totalRawBytes,
    totalDeliveredBytes,
    totalSavedBytes,
    estimatedTokensSaved: estimateTokensFromBytes(totalSavedBytes),
    roundTripsSaved,
    dedupHits,
    avgDurationMs: totalCalls > 0 ? Math.round(weightedDurationSum / totalCalls) : 0,
    ...(weightedMedianCalls > 0
      ? { medianDurationMs: Math.round(weightedMedianSum / weightedMedianCalls) }
      : {}),
    ...(weightedOpsCalls > 0
      ? { opsAvgDurationMs: Math.round(weightedOpsSum / weightedOpsCalls) }
      : {}),
    byCategory,
  }
}

const MAX_RECENT_DURATIONS = 200

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? Math.round(sorted[mid])
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

export class TelemetryStore extends EventEmitter {
  private totalCalls = 0
  private totalRawBytes = 0
  private totalDeliveredBytes = 0
  private totalSavedBytes = 0
  private roundTripsSaved = 0
  private dedupHits = 0
  private totalDurationMs = 0
  private opsCalls = 0
  private opsDurationMs = 0
  private hydratedMedianMs: number | null = null
  private recentDurationsMs: number[] = []
  private byCategory: Record<SavingsCategory, SavingsCategoryBreakdown> = createEmptyBreakdown()

  /**
   * Restores persisted counters on session load without emitting live events.
   */
  hydrate(summary: TokenSavingsSummary): void {
    if (!summary || typeof summary !== 'object') return

    const calls = Math.max(0, Math.round(Number.isFinite(summary.totalCalls) ? summary.totalCalls : 0))
    const avgMs = Math.max(
      0,
      Math.round(Number.isFinite(summary.avgDurationMs) ? summary.avgDurationMs : 0),
    )

    this.totalCalls = calls
    this.totalRawBytes = Math.max(
      0,
      Math.round(Number.isFinite(summary.totalRawBytes) ? summary.totalRawBytes : 0),
    )
    this.totalDeliveredBytes = Math.max(
      0,
      Math.round(Number.isFinite(summary.totalDeliveredBytes) ? summary.totalDeliveredBytes : 0),
    )
    this.totalSavedBytes = Math.max(
      0,
      Math.round(Number.isFinite(summary.totalSavedBytes) ? summary.totalSavedBytes : 0),
    )
    this.roundTripsSaved = Math.max(
      0,
      Math.round(Number.isFinite(summary.roundTripsSaved) ? summary.roundTripsSaved : 0),
    )
    this.dedupHits = Math.max(
      0,
      Math.round(Number.isFinite(summary.dedupHits) ? summary.dedupHits : 0),
    )
    this.totalDurationMs = calls * avgMs
    this.hydratedMedianMs =
      typeof summary.medianDurationMs === 'number' && Number.isFinite(summary.medianDurationMs)
        ? Math.max(0, Math.round(summary.medianDurationMs))
        : null
    this.recentDurationsMs = []
    if (
      typeof summary.opsAvgDurationMs === 'number' &&
      Number.isFinite(summary.opsAvgDurationMs) &&
      calls > 0
    ) {
      this.opsCalls = calls
      this.opsDurationMs = calls * Math.max(0, Math.round(summary.opsAvgDurationMs))
    } else {
      this.opsCalls = 0
      this.opsDurationMs = 0
    }
    this.byCategory = createEmptyBreakdown()

    if (summary.byCategory && typeof summary.byCategory === 'object') {
      for (const category of ALL_SAVINGS_CATEGORIES) {
        const src = summary.byCategory[category]
        if (!src || typeof src !== 'object') continue
        const catCalls = Math.max(0, Math.round(Number.isFinite(src.calls) ? src.calls : 0))
        const catSaved = Math.max(
          0,
          Math.round(Number.isFinite(src.savedBytes) ? src.savedBytes : 0),
        )
        const catTrips =
          typeof src.roundTripsSaved === 'number' && Number.isFinite(src.roundTripsSaved)
            ? Math.max(0, Math.round(src.roundTripsSaved))
            : 0
        this.byCategory[category] = {
          calls: catCalls,
          savedBytes: catSaved,
          estimatedTokensSaved: estimateTokensFromBytes(catSaved),
          ...(catTrips > 0 ? { roundTripsSaved: catTrips } : {}),
        }
      }
    }
  }

  record(input: TelemetryRecordInput): TokenSavingsSummary {
    const rawBytes = Math.max(0, Math.round(Number.isFinite(input.rawBytes) ? input.rawBytes : 0))
    const deliveredBytes = Math.max(
      0,
      Math.round(Number.isFinite(input.deliveredBytes) ? input.deliveredBytes : 0),
    )
    const savedBytes =
      input.savedBytes !== undefined && Number.isFinite(input.savedBytes)
        ? Math.max(0, Math.round(input.savedBytes))
        : Math.max(0, rawBytes - deliveredBytes)
    const durationMs = Math.max(
      0,
      Math.round(Number.isFinite(input.durationMs) ? input.durationMs : 0),
    )
    const roundTrips = Math.max(
      0,
      Math.round(Number.isFinite(input.roundTripsSaved ?? 0) ? (input.roundTripsSaved ?? 0) : 0),
    )
    const dedup = Math.max(
      0,
      Math.round(Number.isFinite(input.dedupHits ?? 0) ? (input.dedupHits ?? 0) : 0),
    )

    this.totalCalls += 1
    this.totalRawBytes += Math.max(rawBytes, deliveredBytes + savedBytes)
    this.totalDeliveredBytes += deliveredBytes
    this.totalSavedBytes += savedBytes
    this.roundTripsSaved += roundTrips
    this.dedupHits += dedup
    this.totalDurationMs += durationMs
    this.recentDurationsMs.push(durationMs)
    if (this.recentDurationsMs.length > MAX_RECENT_DURATIONS) {
      this.recentDurationsMs.shift()
    }
    if (!input.isShellExec) {
      this.opsCalls += 1
      this.opsDurationMs += durationMs
    }

    if (input.categories) {
      for (const category of ALL_SAVINGS_CATEGORIES) {
        const delta = input.categories[category]
        if (!delta) continue
        const catSaved = Math.max(
          0,
          Math.round(Number.isFinite(delta.savedBytes) ? delta.savedBytes : 0),
        )
        const catCalls =
          delta.calls !== undefined && Number.isFinite(delta.calls)
            ? Math.max(0, Math.round(delta.calls))
            : catSaved > 0
              ? 1
              : 0
        const catTrips =
          typeof delta.roundTripsSaved === 'number' && Number.isFinite(delta.roundTripsSaved)
            ? Math.max(0, Math.round(delta.roundTripsSaved))
            : 0
        if (catCalls === 0 && catSaved === 0 && catTrips === 0) continue
        const entry = this.byCategory[category]
        entry.calls += catCalls
        entry.savedBytes += catSaved
        entry.estimatedTokensSaved = estimateTokensFromBytes(entry.savedBytes)
        if (catTrips > 0) {
          entry.roundTripsSaved = (entry.roundTripsSaved ?? 0) + catTrips
        }
      }
    } else if (input.primaryCategory) {
      const entry = this.byCategory[input.primaryCategory]
      entry.calls += 1
      entry.savedBytes += savedBytes
      entry.estimatedTokensSaved = estimateTokensFromBytes(entry.savedBytes)
    }

    const summary = this.getSummary()
    this.emit('telemetry', summary)
    return summary
  }

  getSummary(): TokenSavingsSummary {
    const byCategory = createEmptyBreakdown()
    for (const category of ALL_SAVINGS_CATEGORIES) {
      byCategory[category] = { ...this.byCategory[category] }
    }

    const medianDurationMs =
      this.recentDurationsMs.length > 0
        ? computeMedian(this.recentDurationsMs)
        : this.hydratedMedianMs !== null
          ? this.hydratedMedianMs
          : undefined
    const opsAvgDurationMs =
      this.opsCalls > 0 ? Math.round(this.opsDurationMs / this.opsCalls) : undefined

    return {
      totalCalls: this.totalCalls,
      totalRawBytes: this.totalRawBytes,
      totalDeliveredBytes: this.totalDeliveredBytes,
      totalSavedBytes: this.totalSavedBytes,
      estimatedTokensSaved: estimateTokensFromBytes(this.totalSavedBytes),
      roundTripsSaved: this.roundTripsSaved,
      dedupHits: this.dedupHits,
      avgDurationMs: this.totalCalls > 0 ? Math.round(this.totalDurationMs / this.totalCalls) : 0,
      ...(medianDurationMs !== undefined ? { medianDurationMs } : {}),
      ...(opsAvgDurationMs !== undefined ? { opsAvgDurationMs } : {}),
      byCategory,
    }
  }

  reset(): TokenSavingsSummary {
    this.totalCalls = 0
    this.totalRawBytes = 0
    this.totalDeliveredBytes = 0
    this.totalSavedBytes = 0
    this.roundTripsSaved = 0
    this.dedupHits = 0
    this.totalDurationMs = 0
    this.opsCalls = 0
    this.opsDurationMs = 0
    this.hydratedMedianMs = null
    this.recentDurationsMs = []
    this.byCategory = createEmptyBreakdown()

    const summary = this.getSummary()
    this.emit('telemetry', summary)
    return summary
  }
}
