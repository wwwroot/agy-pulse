import React, { useMemo, useState } from 'react'
import { calculateInputSavingsUsd } from '../../shared/pricing.ts'
import type {
  ConversationContextUsage,
  CostPricingOverrides,
  GoogleAiPlanId,
  QuotaSnapshot,
  SavingsCategory,
  TokenSavingsSummary,
} from '../../shared/types.ts'
import styles from '../terminal.module.css'
import type { SessionScope } from '../utils/api.ts'
import {
  formatBytes,
  formatCompactNumber,
  formatLatency,
  formatUsd,
} from '../utils/format.ts'
import { ContextWindowCard } from './ContextWindowCard.tsx'
import { QuotaCard } from './QuotaCard.tsx'

export interface OverviewViewProps {
  visible: boolean
  scope: SessionScope
  onScopeChange: (scope: SessionScope) => void
  contextWindow: ConversationContextUsage | null
  googleAiPlan: GoogleAiPlanId
  costPricingOverrides?: CostPricingOverrides
  quotas: QuotaSnapshot | null
  refreshingQuotas: boolean
  onRefreshQuotas: () => void
  telemetry: TokenSavingsSummary
  dedupEntryCount: number
  now: number
  onClearDedup: () => Promise<void>
  onExportSession: (format: 'markdown' | 'json') => Promise<void>
  onResetTelemetry: () => Promise<void>
}

interface MechanismMeta {
  key: SavingsCategory
  label: string
}

const MECHANISMS: MechanismMeta[] = [
  { key: 'read-dedup', label: 'Read deduplication' },
  { key: 'outline-read', label: 'Outline reads' },
  { key: 'symbol-read', label: 'Symbol reads' },
  { key: 'batch-read', label: 'Batch file reads' },
  { key: 'grep-progressive', label: 'Progressive grep' },
  { key: 'git-compact', label: 'Compact git' },
  { key: 'json-digest', label: 'JSON digest' },
  { key: 'spillover', label: 'Spillover paging' },
  { key: 'batch-mutate', label: 'Batch mutations' },
  { key: 'native-doc', label: 'Document reads' },
]

export const OverviewView: React.FC<OverviewViewProps> = ({
  visible,
  scope,
  onScopeChange,
  contextWindow,
  googleAiPlan,
  costPricingOverrides,
  quotas,
  refreshingQuotas,
  onRefreshQuotas,
  telemetry,
  dedupEntryCount,
  now,
  onClearDedup,
  onExportSession,
  onResetTelemetry,
}) => {
  const [busyAction, setBusyAction] = useState<string | null>(null)

  const reductionPct = useMemo(() => {
    if (telemetry.totalRawBytes <= 0 || telemetry.totalSavedBytes <= 0) return 0
    return Math.min(100, Math.round((telemetry.totalSavedBytes / telemetry.totalRawBytes) * 100))
  }, [telemetry.totalRawBytes, telemetry.totalSavedBytes])

  const activeRows = useMemo(() => {
    const rawRows = MECHANISMS.map((meta, order) => {
      const stats = telemetry.byCategory?.[meta.key] ?? {
        calls: 0,
        savedBytes: 0,
        estimatedTokensSaved: 0,
      }
      const isTripsOnly =
        stats.savedBytes === 0 && (stats.roundTripsSaved ?? 0) > 0
      const isActive =
        stats.savedBytes > 0 ||
        stats.estimatedTokensSaved > 0 ||
        (stats.roundTripsSaved ?? 0) > 0
      return { meta, stats, order, isActive, isTripsOnly }
    }).filter((r) => r.isActive)

    const maxBytes = rawRows.reduce((max, row) => Math.max(max, row.stats.savedBytes), 0)
    const maxTrips = rawRows.reduce(
      (max, row) => Math.max(max, row.stats.roundTripsSaved ?? 0),
      0,
    )

    return rawRows
      .map((row) => {
        const sharePct =
          telemetry.totalSavedBytes > 0
            ? Math.round((row.stats.savedBytes / telemetry.totalSavedBytes) * 100)
            : 0
        const trips = row.stats.roundTripsSaved ?? 0
        const barWidthPct = row.isTripsOnly
          ? maxTrips > 0
            ? Math.max(6, Math.round((trips / maxTrips) * 100))
            : 0
          : maxBytes > 0
            ? Math.max(
                row.stats.savedBytes > 0 ? 3 : 0,
                Math.round((row.stats.savedBytes / maxBytes) * 100),
              )
            : 0
        return { ...row, sharePct, barWidthPct, trips }
      })
      .sort((a, b) => {
        if (a.isTripsOnly !== b.isTripsOnly) return a.isTripsOnly ? 1 : -1
        if (b.stats.savedBytes !== a.stats.savedBytes) {
          return b.stats.savedBytes - a.stats.savedBytes
        }
        if (b.trips !== a.trips) {
          return b.trips - a.trips
        }
        return a.order - b.order
      })
  }, [telemetry.byCategory, telemetry.totalSavedBytes])

  const pulseSavings = useMemo(
    () =>
      calculateInputSavingsUsd(
        telemetry.estimatedTokensSaved,
        contextWindow?.model,
        now,
        costPricingOverrides,
      ),
    [telemetry.estimatedTokensSaved, contextWindow?.model, now, costPricingOverrides],
  )

  const runQuickAction = async (key: string, fn: () => Promise<void>) => {
    if (busyAction) return
    setBusyAction(key)
    try {
      await fn()
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <section
      className={`${styles.overviewView} ${!visible ? styles.hiddenPane : ''}`}
      aria-label="Context usage, quotas, and token savings"
    >
      <div className={styles.overviewInner}>
        <div className={styles.overviewTopBar}>
          <div className={styles.filterGroup} role="tablist" aria-label="Telemetry scope">
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'conversation'}
              className={`${styles.filterPill} ${
                scope === 'conversation' ? styles.filterPillActive : ''
              }`}
              onClick={() => onScopeChange('conversation')}
            >
              This chat
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'all'}
              className={`${styles.filterPill} ${scope === 'all' ? styles.filterPillActive : ''}`}
              title="Aggregate usage across conversations in this project workspace"
              onClick={() => onScopeChange('all')}
            >
              This project
            </button>
          </div>

          <div className={styles.overviewQuickActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              disabled={busyAction !== null || dedupEntryCount === 0}
              title="Clear session read-dedup cache"
              onClick={() => void runQuickAction('dedup', onClearDedup)}
            >
              {busyAction === 'dedup' ? 'Clearing…' : 'Clear dedup'}
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              disabled={busyAction !== null}
              title="Export session report as Markdown"
              onClick={() => void runQuickAction('md', () => onExportSession('markdown'))}
            >
              .md
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              disabled={busyAction !== null}
              title="Export session report as JSON"
              onClick={() => void runQuickAction('json', () => onExportSession('json'))}
            >
              .json
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              disabled={busyAction !== null || telemetry.totalCalls === 0}
              title="Reset recorded token savings stats"
              onClick={() => void runQuickAction('reset', onResetTelemetry)}
            >
              {busyAction === 'reset' ? 'Resetting…' : 'Reset'}
            </button>
          </div>
        </div>

        {scope === 'conversation' && (
          <ContextWindowCard contextWindow={contextWindow} googleAiPlan={googleAiPlan} />
        )}

        <QuotaCard
          quotas={quotas}
          now={now}
          refreshing={refreshingQuotas}
          onRefresh={onRefreshQuotas}
        />

        <div className={styles.summaryBlock}>
          <div className={styles.summaryHero}>
            <div className={styles.summaryFigureRow}>
              <span
                className={`${styles.summaryFigure} ${styles.tabular}`}
                title={`${telemetry.estimatedTokensSaved.toLocaleString()} estimated tokens saved`}
              >
                {formatCompactNumber(telemetry.estimatedTokensSaved)}
              </span>
              <span className={styles.summaryUnit}>tokens saved</span>
              {reductionPct > 0 && (
                <span className={`${styles.summaryDelta} ${styles.tabular}`}>
                  -{reductionPct}%
                </span>
              )}
              {pulseSavings.usd > 0 && (
                <span
                  className={`${styles.summaryCostPill} ${styles.tabular}`}
                  title={`Estimated API input savings at $${pulseSavings.rate.inputPerMillion}/1M (${pulseSavings.rate.label})`}
                >
                  ~{formatUsd(pulseSavings.usd)} saved
                </span>
              )}
            </div>

            <div className={styles.summaryBarTrack} aria-hidden="true">
              <div
                className={styles.summaryBarFill}
                style={{ width: `${reductionPct}%` }}
              />
            </div>
          </div>

          <div className={styles.summaryStrip}>
            <div className={styles.summaryMetric}>
              <span className={styles.summaryMetricLabel}>Trimmed</span>
              <span className={`${styles.summaryMetricValue} ${styles.tabular}`}>
                {formatBytes(telemetry.totalSavedBytes)}
              </span>
              <span className={`${styles.summaryMetricSub} ${styles.tabular}`}>
                of {formatBytes(telemetry.totalRawBytes)}
              </span>
            </div>

            <div
              className={styles.summaryMetric}
              title={
                telemetry.medianDurationMs !== undefined
                  ? `Median: ${formatLatency(telemetry.medianDurationMs)}${telemetry.opsAvgDurationMs !== undefined ? ` · Workspace ops avg: ${formatLatency(telemetry.opsAvgDurationMs)}` : ''} · Overall avg (incl. shell exec): ${formatLatency(telemetry.avgDurationMs)}`
                  : `Average duration: ${formatLatency(telemetry.avgDurationMs)}`
              }
            >
              <span className={styles.summaryMetricLabel}>Calls</span>
              <span className={`${styles.summaryMetricValue} ${styles.tabular}`}>
                {telemetry.totalCalls.toLocaleString()}
              </span>
              <span className={`${styles.summaryMetricSub} ${styles.tabular}`}>
                {telemetry.medianDurationMs !== undefined
                  ? `${formatLatency(telemetry.medianDurationMs)} med`
                  : `${formatLatency(telemetry.avgDurationMs)} avg`}
              </span>
            </div>

            <div className={styles.summaryMetric}>
              <span className={styles.summaryMetricLabel}>Dedup</span>
              <span className={`${styles.summaryMetricValue} ${styles.tabular}`}>
                {telemetry.dedupHits.toLocaleString()}
              </span>
              <span className={`${styles.summaryMetricSub} ${styles.tabular}`}>
                {dedupEntryCount.toLocaleString()} cached
              </span>
            </div>

            <div
              className={styles.summaryMetric}
              title={
                telemetry.roundTripsSaved > 0 &&
                contextWindow?.available &&
                contextWindow.cost &&
                contextWindow.promptTokens > 0
                  ? `${telemetry.roundTripsSaved.toLocaleString()} avoided LLM round-trips via batching. At current ${formatCompactNumber(contextWindow.promptTokens)} prompt size, each avoided turn saves ~${formatUsd((contextWindow.promptTokens / 1_000_000) * contextWindow.cost.cacheReadPerMillion)} in cached prompt re-reads.`
                  : `${telemetry.roundTripsSaved.toLocaleString()} avoided LLM round-trips via batched reads and multi-hunk edits`
              }
            >
              <span className={styles.summaryMetricLabel}>Trips saved</span>
              <span className={`${styles.summaryMetricValue} ${styles.tabular}`}>
                {telemetry.roundTripsSaved.toLocaleString()}
              </span>
            </div>
          </div>
        </div>

        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className={styles.panelTitle}>By mechanism</div>
            {activeRows.length > 0 && (
              <span className={`${styles.panelMeta} ${styles.tabular}`}>
                {activeRows.length} active
              </span>
            )}
          </div>

          {activeRows.length === 0 ? (
            <div className={styles.panelEmpty}>
              No recorded calls in {scope === 'all' ? 'this project' : 'this conversation'} yet.
            </div>
          ) : (
            <div className={styles.mechList}>
              {activeRows.map(({ meta, stats, sharePct, barWidthPct, isTripsOnly, trips }) => (
                <div key={meta.key} className={styles.mechRow}>
                  <div className={styles.mechTop}>
                    <div className={styles.mechNameGroup}>
                      <span className={styles.mechName}>{meta.label}</span>
                      <span className={`${styles.mechCalls} ${styles.tabular}`}>
                        {stats.calls.toLocaleString()}×
                      </span>
                    </div>
                    <div className={`${styles.mechStats} ${styles.tabular}`}>
                      {isTripsOnly ? (
                        <span className={styles.mechTokens}>
                          {trips.toLocaleString()} trip{trips === 1 ? '' : 's'}
                        </span>
                      ) : (
                        <>
                          <span className={styles.mechTokens}>
                            {formatCompactNumber(stats.estimatedTokensSaved)}
                          </span>
                          <span className={styles.mechBytes}>{formatBytes(stats.savedBytes)}</span>
                          <span className={styles.mechShare}>{sharePct}%</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className={styles.mechBarTrack} aria-hidden="true">
                    <div className={styles.mechBarFill} style={{ width: `${barWidthPct}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
