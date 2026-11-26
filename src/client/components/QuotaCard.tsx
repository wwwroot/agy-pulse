import React from 'react'
import type { QuotaPool, QuotaSnapshot } from '../../shared/types.ts'
import styles from '../terminal.module.css'
import {
  formatCompactQuotaWindow,
  formatQuotaWindowLine,
  formatRelativeAge,
} from '../utils/format.ts'

export interface QuotaCardProps {
  quotas: QuotaSnapshot | null
  now: number
  refreshing: boolean
  onRefresh: () => void
}

const FLOOR_PCT = 2

function getBarToneClass(remaining: number): string {
  if (remaining <= 0.05) return styles.quotaFillErr
  if (remaining <= 0.2) return styles.quotaFillWarn
  return styles.quotaFillOk
}

function isGeminiPool(pool: QuotaPool): boolean {
  const id = pool.id.toLowerCase()
  const name = pool.name.toLowerCase()
  return id.startsWith('agy-gemini') || id.startsWith('agy-argon') || name.includes('gemini')
}

function shortPoolName(pool: QuotaPool): string {
  if (/claude\s+and\s+gpt/i.test(pool.name)) return 'Claude & GPT'
  return pool.name
}

const QuotaPoolBlock: React.FC<{ pool: QuotaPool; now: number }> = ({ pool, now }) => {
  return (
    <div className={styles.quotaPoolBlock}>
      <div className={styles.quotaPoolHeader}>
        <span className={styles.quotaPoolName} title={pool.name}>
          {shortPoolName(pool)}
        </span>
      </div>

      <div className={styles.quotaWindows}>
        {pool.windows.map((win, idx) => {
          const clamped = Number.isFinite(win.remaining)
            ? Math.min(1, Math.max(0, win.remaining))
            : 0
          const { span, pct, meta } = formatCompactQuotaWindow(win, now)
          const fullTitle = formatQuotaWindowLine(win, now)

          return (
            <div
              key={`${pool.id}-${win.kind}-${idx}`}
              className={styles.quotaWindowCompact}
              title={fullTitle}
            >
              <div className={styles.quotaWindowLineTop}>
                <span className={`${styles.quotaWindowSpan} ${styles.tabular}`}>
                  {span} · {pct}%
                </span>
                {meta && (
                  <span className={`${styles.quotaWindowMeta} ${styles.tabular}`}>{meta}</span>
                )}
              </div>
              <div
                className={styles.quotaBarTrack}
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${pool.name} ${win.label || win.kind}: ${pct}% left`}
              >
                <div
                  className={`${styles.quotaBarFill} ${getBarToneClass(clamped)}`}
                  style={{ width: `${pct}%` }}
                />
                <div
                  className={styles.quotaBarFloor}
                  style={{ left: `${FLOOR_PCT}%` }}
                  aria-hidden="true"
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export const QuotaCard: React.FC<QuotaCardProps> = ({ quotas, now, refreshing, onRefresh }) => {
  const activePools = (quotas?.pools ?? []).filter((p) => !p.disabled)
  const hasPools = activePools.length > 0

  const geminiPools = activePools.filter(isGeminiPool)
  const thirdPartyPools = activePools.filter((p) => !isGeminiPool(p))
  const twoCol = geminiPools.length > 0 && thirdPartyPools.length > 0

  return (
    <section className={styles.panel} aria-label="Antigravity quotas">
      <div className={`${styles.panelHeader} ${styles.panelHeaderDivided}`}>
        <span className={styles.panelTitle}>Antigravity quotas</span>
        {quotas && quotas.fetchedAt > 0 && (
          <span
            className={`${styles.panelMeta} ${styles.tabular}`}
            title={`Checked ${new Date(quotas.fetchedAt).toLocaleString()}`}
          >
            {formatRelativeAge(quotas.fetchedAt, now)}
          </span>
        )}
      </div>

      {!quotas ? (
        <div className={styles.quotaEmptyRow}>
          <span className={styles.panelEmptyInline}>
            {refreshing ? 'Loading quotas…' : 'Quota data not fetched yet.'}
          </span>
          {!refreshing && (
            <button type="button" className={`${styles.btn} ${styles.btnSm}`} onClick={onRefresh}>
              Check
            </button>
          )}
        </div>
      ) : !hasPools ? (
        <div className={styles.quotaEmptyRow}>
          <div className={styles.quotaEmptyStack}>
            <span className={styles.panelEmptyInline}>
              {quotas.error || 'No Antigravity quota pools reported.'}
            </span>
            {quotas.warnings.length > 0 && (
              <span className={styles.quotaWarningLine}>{quotas.warnings[0]}</span>
            )}
          </div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSm}`}
            disabled={refreshing}
            onClick={onRefresh}
          >
            Retry
          </button>
        </div>
      ) : (
        <div className={styles.quotaBody}>
          <div className={twoCol ? styles.quotaColumns : styles.quotaList}>
            {twoCol ? (
              <>
                <div className={styles.quotaColumn}>
                  {geminiPools.map((pool) => (
                    <QuotaPoolBlock key={pool.id} pool={pool} now={now} />
                  ))}
                </div>
                <div className={styles.quotaColumn}>
                  {thirdPartyPools.map((pool) => (
                    <QuotaPoolBlock key={pool.id} pool={pool} now={now} />
                  ))}
                </div>
              </>
            ) : (
              activePools.map((pool) => <QuotaPoolBlock key={pool.id} pool={pool} now={now} />)
            )}
          </div>

          {quotas.error && (
            <div className={styles.quotaWarnings}>
              <div className={styles.quotaWarningLine}>
                <span aria-hidden="true">▲</span>
                <span>{quotas.error}</span>
              </div>
            </div>
          )}

          {quotas.warnings.length > 0 && (
            <div className={styles.quotaWarnings}>
              {quotas.warnings.map((w) => (
                <div key={w} className={styles.quotaWarningLine}>
                  <span aria-hidden="true">▲</span>
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
