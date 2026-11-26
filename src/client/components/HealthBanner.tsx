import React from 'react'
import type { HostHealthSnapshot, SidecarNotice } from '../../shared/types.ts'
import styles from '../terminal.module.css'
import { formatRelativeAge } from '../utils/format.ts'
import type { WsConnectionStatus } from '../utils/ws.ts'

export interface HealthBannerProps {
  lastError: string | null
  lastSyncedAt: number | null
  now: number
  wsStatus: WsConnectionStatus
  wsFallbackActive: boolean
  workerAvailable: boolean
  workerPath?: string
  hostHealth: HostHealthSnapshot | null
  repairingHost: boolean
  repairedHint: string | null
  notices: SidecarNotice[]
  dismissedNoticeIds: Set<string>
  isRefreshing: boolean
  onRetrySync: () => void
  onRefreshQuotas: () => void
  onRepairHost: () => void
  onDismissRepairedHint: () => void
  onDismissNotice: (id: string) => void
}

function noticeActionLabel(action: SidecarNotice['action']): string {
  switch (action) {
    case 'refresh-quotas':
      return 'Refresh'
    case 'repair-host':
      return 'Repair'
    case 'retry-worker':
      return 'Retry'
    default:
      return ''
  }
}

export const HealthBanner: React.FC<HealthBannerProps> = ({
  lastError,
  lastSyncedAt,
  now,
  workerAvailable,
  workerPath,
  hostHealth,
  repairingHost,
  repairedHint,
  notices,
  dismissedNoticeIds,
  isRefreshing,
  onRetrySync,
  onRefreshQuotas,
  onRepairHost,
  onDismissRepairedHint,
  onDismissNotice,
}) => {
  const unhealthyHosts = (hostHealth?.entries ?? []).filter((e) => e.status !== 'ok')
  const hasRepairableHost = unhealthyHosts.some((e) => e.repairable)

  // Avoid duplicating notices that already have a dedicated banner row above,
  // and suppress noisy unused-quota projections.
  const visibleNotices = notices.filter((n) => {
    if (dismissedNoticeIds.has(n.id)) return false
    if (n.id.startsWith('quota:expiring:')) return false
    if (!workerAvailable && n.action === 'retry-worker') return false
    if (unhealthyHosts.length > 0 && n.action === 'repair-host') return false
    return true
  })

  // HTTP long-poll (/api/events) is the normal live transport inside Antigravity WebViews
  // where WebSocket upgrades are not proxied, so only surface actual sync errors or health issues.
  const showWorkerBanner = !workerAvailable

  const hasAny =
    Boolean(lastError) ||
    Boolean(repairedHint) ||
    showWorkerBanner ||
    unhealthyHosts.length > 0 ||
    visibleNotices.length > 0

  if (!hasAny) return null

  const triggerNoticeAction = (action: SidecarNotice['action']) => {
    if (action === 'refresh-quotas') onRefreshQuotas()
    else if (action === 'repair-host') onRepairHost()
    else if (action === 'retry-worker') onRetrySync()
  }

  return (
    <div className={styles.healthStack} role="region" aria-label="System health and notices">
      {repairedHint && (
        <div className={`${styles.healthBanner} ${styles.healthBannerOk}`} role="status">
          <span className={`${styles.healthGlyph} ${styles.healthGlyphOk}`} aria-hidden="true">
            ✓
          </span>
          <div className={styles.healthBody}>
            <span className={styles.healthTitle}>{repairedHint}</span>
          </div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSm}`}
            onClick={onDismissRepairedHint}
          >
            OK
          </button>
        </div>
      )}

      {lastError && (
        <div className={`${styles.healthBanner} ${styles.healthBannerErr}`} role="alert">
          <span className={`${styles.healthGlyph} ${styles.healthGlyphErr}`} aria-hidden="true">
            !
          </span>
          <div className={styles.healthBody}>
            <span className={styles.healthTitle}>{lastError}</span>
            {lastSyncedAt !== null && (
              <span className={`${styles.healthSub} ${styles.tabular}`}>
                Showing data from {formatRelativeAge(lastSyncedAt, now)}.
              </span>
            )}
          </div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSm}`}
            disabled={isRefreshing}
            onClick={onRetrySync}
          >
            {isRefreshing ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}

      {unhealthyHosts.length > 0 && (
        <div className={`${styles.healthBanner} ${styles.healthBannerWarn}`} role="status">
          <span className={`${styles.healthGlyph} ${styles.healthGlyphWarn}`} aria-hidden="true">
            ▲
          </span>
          <div className={styles.healthBody}>
            {unhealthyHosts.map((entry) => (
              <div key={`${entry.host}:${entry.configPath}`} className={styles.healthHostLine}>
                <span className={styles.healthTitle}>
                  {entry.host} MCP config is {entry.status}
                </span>
                {entry.detail && <span className={styles.healthSub}>{entry.detail}</span>}
              </div>
            ))}
          </div>
          {hasRepairableHost && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
              disabled={repairingHost}
              onClick={onRepairHost}
            >
              {repairingHost ? 'Repairing…' : 'Repair'}
            </button>
          )}
        </div>
      )}

      {showWorkerBanner && (
        <div
          className={`${styles.healthBanner} ${styles.healthBannerWarn}`}
          role="status"
          title={workerPath ? `Worker missing at ${workerPath}` : 'agy-pulse-worker unavailable'}
        >
          <span className={`${styles.healthGlyph} ${styles.healthGlyphWarn}`} aria-hidden="true">
            ▲
          </span>
          <div className={styles.healthBody}>
            <span className={styles.healthTitle}>Rust worker offline — JS fallback active</span>
            {workerPath && <span className={styles.healthSub}>{workerPath}</span>}
          </div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSm}`}
            disabled={isRefreshing}
            onClick={onRetrySync}
          >
            Retry
          </button>
        </div>
      )}

      {visibleNotices.map((notice) => {
        const toneClass =
          notice.level === 'error'
            ? styles.healthBannerErr
            : notice.level === 'warn'
              ? styles.healthBannerWarn
              : styles.healthBannerInfo
        const glyphClass =
          notice.level === 'error'
            ? styles.healthGlyphErr
            : notice.level === 'warn'
              ? styles.healthGlyphWarn
              : styles.healthGlyphInfo
        const glyph = notice.level === 'error' ? '!' : notice.level === 'warn' ? '▲' : 'i'
        const actionLabel = noticeActionLabel(notice.action)

        return (
          <div key={notice.id} className={`${styles.healthBanner} ${toneClass}`} role="status">
            <span className={`${styles.healthGlyph} ${glyphClass}`} aria-hidden="true">
              {glyph}
            </span>
            <div className={styles.healthBody}>
              <span className={styles.healthTitle}>{notice.title}</span>
              {notice.detail && <span className={styles.healthSub}>{notice.detail}</span>}
            </div>
            <div className={styles.healthActions}>
              {notice.action && actionLabel && (
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSm}`}
                  onClick={() => triggerNoticeAction(notice.action)}
                >
                  {actionLabel}
                </button>
              )}
              <button
                type="button"
                className={styles.healthDismiss}
                aria-label={`Dismiss ${notice.title}`}
                title="Dismiss"
                onClick={() => onDismissNotice(notice.id)}
              >
                ×
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
