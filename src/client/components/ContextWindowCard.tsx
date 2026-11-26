import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { getGoogleAiPlan } from '../../shared/pricing.ts'
import type {
  ConversationContextPoint,
  ConversationContextUsage,
  GoogleAiPlanId,
} from '../../shared/types.ts'
import styles from '../terminal.module.css'
import { formatCompactNumber, formatUsd } from '../utils/format.ts'

export interface ContextWindowCardProps {
  contextWindow: ConversationContextUsage | null
  googleAiPlan?: GoogleAiPlanId
}

const CHART_H = 92
const DEFAULT_CHART_W = 320
const MIN_CHART_W = 200
const PAD_LEFT = 4
const PAD_RIGHT = 6
const PAD_TOP = 10
const PAD_BOTTOM = 8
const PLOT_H = CHART_H - PAD_TOP - PAD_BOTTOM
const WARN_THRESHOLD_PCT = 65
const COMPACT_THRESHOLD_PCT = 85

// Seamless 200-unit-wide sine wave paths (period = 100) for dual-layer parallax loop.
const BACK_WAVE_FILL_PATH =
  'M 0 0 C 12.5 0 12.5 -4 25 -4 C 37.5 -4 37.5 0 50 0 C 62.5 0 62.5 4 75 4 C 87.5 4 87.5 0 100 0 C 112.5 0 112.5 -4 125 -4 C 137.5 -4 137.5 0 150 0 C 162.5 0 162.5 4 175 4 C 187.5 4 187.5 0 200 0 L 200 125 L 0 125 Z'

const FRONT_WAVE_CREST_PATH =
  'M 0 0 C 12.5 0 12.5 -3.5 25 -3.5 C 37.5 -3.5 37.5 0 50 0 C 62.5 0 62.5 3.5 75 3.5 C 87.5 3.5 87.5 0 100 0 C 112.5 0 112.5 -3.5 125 -3.5 C 137.5 -3.5 137.5 0 150 0 C 162.5 0 162.5 3.5 175 3.5 C 187.5 3.5 187.5 0 200 0'

const FRONT_WAVE_FILL_PATH = `${FRONT_WAVE_CREST_PATH} L 200 125 L 0 125 Z`

function getContextSeverity(usagePct: number | null): 'ok' | 'warn' | 'err' {
  if (usagePct !== null && usagePct >= COMPACT_THRESHOLD_PCT) return 'err'
  if (usagePct !== null && usagePct >= WARN_THRESHOLD_PCT) return 'warn'
  return 'ok'
}

function formatSignedDelta(delta: number, contextTokens: number): {
  text: string
  tone: 'neutral' | 'ok' | 'warn'
} {
  if (!Number.isFinite(delta) || delta === 0) {
    return { text: '0', tone: 'neutral' }
  }
  if (delta < 0) {
    const abs = Math.abs(delta)
    const isCompaction = abs >= Math.max(1_000, contextTokens * 0.1)
    return {
      text: isCompaction
        ? `-${formatCompactNumber(abs)} compacted`
        : `-${formatCompactNumber(abs)}`,
      tone: isCompaction ? 'ok' : 'neutral',
    }
  }
  return {
    text: `+${formatCompactNumber(delta)}`,
    tone: delta > 50_000 ? 'warn' : 'neutral',
  }
}

interface PlottedPoint {
  point: ConversationContextPoint
  x: number
  yTotal: number
  yCached: number
  isCompaction: boolean
}

export const ContextWindowCard: React.FC<ContextWindowCardProps> = ({
  contextWindow,
  googleAiPlan,
}) => {
  const activePlan = getGoogleAiPlan(googleAiPlan)
  const uid = useId().replace(/:/g, '')
  const orbClipId = `${uid}-orb-clip`
  const orbMaskId = `${uid}-orb-mask`
  const orbGradId = `${uid}-orb-grad`
  const lineGradId = `${uid}-line-grad`
  const areaGradId = `${uid}-area-grad`

  const chartWrapRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [chartWidth, setChartWidth] = useState<number>(DEFAULT_CHART_W)
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  const hasContext = Boolean(contextWindow && contextWindow.available)
  const severity = getContextSeverity(contextWindow?.usagePct ?? null)
  const isNearFull = severity === 'err'

  useEffect(() => {
    const el = chartWrapRef.current
    if (!el) return

    const updateWidth = () => {
      const next = Math.max(MIN_CHART_W, Math.round(el.clientWidth || DEFAULT_CHART_W))
      setChartWidth((prev) => (prev === next ? prev : next))
    }

    updateWidth()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth)
      return () => window.removeEventListener('resize', updateWidth)
    }

    const observer = new ResizeObserver(() => updateWidth())
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasContext, contextWindow?.timeline?.length])

  const orbState = useMemo(() => {
    if (!contextWindow || !contextWindow.available) {
      return {
        fillPct: 0,
        liquidY: 104,
        centerValue: '—',
        isCenterFilled: false,
      }
    }
    const pct = contextWindow.usagePct
    const fillPct =
      pct === null
        ? contextWindow.contextTokens > 0
          ? 35
          : 0
        : Math.min(100, Math.max(0, pct))
    const liquidY =
      fillPct <= 0
        ? 104
        : fillPct >= 100
          ? -8
          : Number((96 - (fillPct / 100) * 96).toFixed(1))

    const centerValue =
      pct !== null ? `${pct.toFixed(1)}%` : formatCompactNumber(contextWindow.contextTokens)
    const isCenterFilled = fillPct >= 52
    return { fillPct, liquidY, centerValue, isCenterFilled }
  }, [contextWindow])

  const plotW = Math.max(120, chartWidth - PAD_LEFT - PAD_RIGHT)

  const chart = useMemo(() => {
    if (!contextWindow || !contextWindow.available) {
      return null
    }
    const pts = Array.isArray(contextWindow.timeline) ? contextWindow.timeline : []
    if (pts.length === 0) {
      return {
        points: [] as PlottedPoint[],
        yMax: 1000,
        showLimitLine: false,
        warnY: null as number | null,
        compactY: null as number | null,
        totalLinePath: '',
        totalAreaPath: '',
        cachedLinePath: '',
      }
    }

    const limit = contextWindow.contextLimit
    const showLimitLine = Boolean(
      limit !== null && limit > 0 && contextWindow.peakContextTokens >= limit * 0.55,
    )
    const yMax = showLimitLine
      ? limit!
      : Math.max(
          contextWindow.peakContextTokens * 1.12,
          contextWindow.contextTokens * 1.12,
          1000,
        )

    const yFor = (val: number): number => {
      const ratio = Math.min(1, Math.max(0, val / yMax))
      return PAD_TOP + PLOT_H - ratio * PLOT_H
    }
    const xFor = (idx: number): number => {
      if (pts.length === 1) return PAD_LEFT + plotW * 0.5
      return PAD_LEFT + (idx / (pts.length - 1)) * plotW
    }

    const warnY = showLimitLine && limit ? yFor(limit * (WARN_THRESHOLD_PCT / 100)) : null
    const compactY = showLimitLine && limit ? yFor(limit * (COMPACT_THRESHOLD_PCT / 100)) : null

    const plotted: PlottedPoint[] = pts.map((pt, i) => {
      const prev = i > 0 ? pts[i - 1] : null
      const isCompaction = Boolean(
        prev && prev.contextTokens > 0 && pt.contextTokens < prev.contextTokens * 0.85,
      )
      return {
        point: pt,
        x: xFor(i),
        yTotal: yFor(pt.contextTokens),
        yCached: yFor(pt.cacheReadTokens),
        isCompaction,
      }
    })

    if (plotted.length === 1) {
      const only = plotted[0]
      return {
        points: plotted,
        yMax,
        showLimitLine,
        warnY,
        compactY,
        totalLinePath: `M ${PAD_LEFT} ${only.yTotal.toFixed(2)} L ${PAD_LEFT + plotW} ${only.yTotal.toFixed(2)}`,
        totalAreaPath: `M ${PAD_LEFT} ${(PAD_TOP + PLOT_H).toFixed(2)} L ${PAD_LEFT} ${only.yTotal.toFixed(2)} L ${PAD_LEFT + plotW} ${only.yTotal.toFixed(2)} L ${PAD_LEFT + plotW} ${(PAD_TOP + PLOT_H).toFixed(2)} Z`,
        cachedLinePath: `M ${PAD_LEFT} ${only.yCached.toFixed(2)} L ${PAD_LEFT + plotW} ${only.yCached.toFixed(2)}`,
      }
    }

    const totalLinePath = plotted
      .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.yTotal.toFixed(2)}`)
      .join(' ')
    const baselineY = (PAD_TOP + PLOT_H).toFixed(2)
    const firstX = plotted[0].x.toFixed(2)
    const lastX = plotted[plotted.length - 1].x.toFixed(2)
    const totalAreaPath = `${totalLinePath} L ${lastX} ${baselineY} L ${firstX} ${baselineY} Z`
    const cachedLinePath = plotted
      .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.yCached.toFixed(2)}`)
      .join(' ')

    return {
      points: plotted,
      yMax,
      showLimitLine,
      warnY,
      compactY,
      totalLinePath,
      totalAreaPath,
      cachedLinePath,
    }
  }, [contextWindow, plotW])

  const activePointIdx =
    chart && chart.points.length > 0
      ? hoveredIdx !== null && hoveredIdx >= 0 && hoveredIdx < chart.points.length
        ? hoveredIdx
        : chart.points.length - 1
      : null

  const activePlotted =
    chart && activePointIdx !== null ? chart.points[activePointIdx] : null
  const isHovering =
    hoveredIdx !== null && chart !== null && hoveredIdx >= 0 && hoveredIdx < chart.points.length

  const handlePointerScrub = (clientX: number) => {
    if (!svgRef.current || !chart || chart.points.length === 0) return
    const rect = svgRef.current.getBoundingClientRect()
    if (rect.width <= 0) return
    const svgX = ((clientX - rect.left) / rect.width) * chartWidth
    let bestIdx = 0
    let bestDist = Infinity
    for (let i = 0; i < chart.points.length; i++) {
      const dist = Math.abs(chart.points[i].x - svgX)
      if (dist < bestDist) {
        bestDist = dist
        bestIdx = i
      }
    }
    setHoveredIdx(bestIdx)
  }

  const handleChartKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (!chart || chart.points.length === 0) return
    const lastIdx = chart.points.length - 1
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setHoveredIdx((prev) => Math.max(0, (prev ?? lastIdx) - 1))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      setHoveredIdx((prev) => Math.min(lastIdx, (prev ?? 0) + 1))
    } else if (e.key === 'Escape') {
      setHoveredIdx(null)
    }
  }

  const lineStroke =
    severity === 'err'
      ? 'var(--term-err)'
      : severity === 'warn'
        ? 'var(--term-warn)'
        : `url(#${lineGradId})`

  const activePointColor =
    severity === 'err'
      ? 'var(--term-err)'
      : severity === 'warn'
        ? 'var(--term-warn)'
        : 'var(--term-accent)'

  const meterToneClass =
    severity === 'err'
      ? styles.contextMeterFillErr
      : severity === 'warn'
        ? styles.contextMeterFillWarn
        : styles.contextMeterFillOk

  const wasCompacted =
    hasContext &&
    contextWindow!.peakContextTokens > Math.max(0, contextWindow!.contextTokens) * 1.15

  const deltaInfo = hasContext
    ? formatSignedDelta(contextWindow!.lastTurnDeltaTokens, contextWindow!.contextTokens)
    : { text: '0', tone: 'neutral' as const }

  const activeCachePct =
    activePlotted && activePlotted.point.contextTokens > 0
      ? Math.min(
          100,
          Math.round(
            (activePlotted.point.cacheReadTokens / activePlotted.point.contextTokens) * 100,
          ),
        )
      : 0

  return (
    <section className={styles.contextInstrument} aria-label="Context window telemetry">
      {!hasContext ? (
        <div className={styles.contextEmptyShell}>
          <div className={styles.contextLedgerHeader}>
            <div className={styles.contextTitleGroup}>
              <span className={styles.contextTitle}>Context window</span>
            </div>
          </div>
          <div className={styles.contextEmpty}>
            Waiting for conversation transcript metrics...
          </div>
        </div>
      ) : (
        <>
          <div className={styles.contextTopZone}>
            <div
              className={`${styles.contextOrb} ${
                isNearFull
                  ? styles.contextOrbErrRim
                  : severity === 'warn'
                    ? styles.contextOrbWarnRim
                    : ''
              }`}
              role="img"
              aria-label={`Context window ${orbState.centerValue}`}
            >
              <svg
                className={styles.contextOrbSvg}
                viewBox="0 0 100 100"
                aria-hidden="true"
              >
                <defs>
                  <clipPath id={orbClipId}>
                    <circle cx="50" cy="50" r="49" />
                  </clipPath>

                  <linearGradient id={orbGradId} x1="12%" y1="92%" x2="88%" y2="8%">
                    {severity === 'err' ? (
                      <>
                        <stop offset="0%" stopColor="var(--term-warn)" />
                        <stop offset="100%" stopColor="var(--term-err)" />
                      </>
                    ) : severity === 'warn' ? (
                      <>
                        <stop offset="0%" stopColor="var(--term-accent)" />
                        <stop offset="100%" stopColor="var(--term-warn)" />
                      </>
                    ) : (
                      <>
                        <stop offset="0%" stopColor="var(--term-accent)" />
                        <stop offset="100%" stopColor="var(--term-ok)" />
                      </>
                    )}
                  </linearGradient>

                  <mask id={orbMaskId}>
                    <rect x="0" y="0" width="100" height="100" fill="#000000" />
                    <g
                      className={styles.contextOrbLevelGroup}
                      style={{ transform: `translateY(${orbState.liquidY}px)` }}
                    >
                      <path
                        d={BACK_WAVE_FILL_PATH}
                        fill="rgba(255, 255, 255, 0.48)"
                        className={styles.contextOrbWaveBack}
                      />
                      <path
                        d={FRONT_WAVE_FILL_PATH}
                        fill="#ffffff"
                        className={styles.contextOrbWaveFront}
                      />
                    </g>
                  </mask>
                </defs>

                <g clipPath={`url(#${orbClipId})`}>
                  <rect
                    x="0"
                    y="0"
                    width="100"
                    height="100"
                    fill={`url(#${orbGradId})`}
                    mask={`url(#${orbMaskId})`}
                  />

                  <g
                    className={styles.contextOrbLevelGroup}
                    style={{ transform: `translateY(${orbState.liquidY}px)` }}
                  >
                    <path
                      d={FRONT_WAVE_CREST_PATH}
                      fill="none"
                      stroke="rgba(255, 255, 255, 0.42)"
                      strokeWidth="1.2"
                      className={styles.contextOrbWaveFront}
                    />
                    {orbState.fillPct > 8 && (
                      <>
                        <circle
                          cx="30"
                          cy="42"
                          r="1.4"
                          className={`${styles.contextOrbBubble} ${styles.contextOrbBubbleA}`}
                        />
                        <circle
                          cx="58"
                          cy="52"
                          r="2.1"
                          className={`${styles.contextOrbBubble} ${styles.contextOrbBubbleB}`}
                        />
                        <circle
                          cx="73"
                          cy="38"
                          r="1.6"
                          className={`${styles.contextOrbBubble} ${styles.contextOrbBubbleC}`}
                        />
                      </>
                    )}
                  </g>
                </g>

                <circle
                  cx="50"
                  cy="50"
                  r="48.5"
                  fill="none"
                  stroke="rgba(255, 255, 255, 0.1)"
                  strokeWidth="1"
                />
              </svg>

              <div
                className={`${styles.contextOrbReadout} ${
                  orbState.isCenterFilled ? styles.contextOrbReadoutFilled : ''
                }`}
              >
                <span className={`${styles.contextOrbValue} ${styles.tabular}`}>
                  {orbState.centerValue}
                </span>
              </div>
            </div>

            <div className={styles.contextLedgerWrap}>
              <div className={styles.contextLedgerHeader}>
                <div className={styles.contextTitleGroup}>
                  <span className={styles.contextTitle}>Context window</span>
                </div>
                {(contextWindow!.modelLabel || contextWindow!.model) && (
                  <span
                    className={styles.contextModelPill}
                    title={contextWindow!.model || contextWindow!.modelLabel}
                  >
                    {contextWindow!.modelLabel || contextWindow!.model}
                  </span>
                )}
              </div>

              <div
                className={styles.contextMeterTrack}
                role="progressbar"
                aria-valuenow={Math.round(orbState.fillPct)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Context usage ${orbState.centerValue}`}
              >
                <div
                  className={`${styles.contextMeterFill} ${meterToneClass}`}
                  style={{ width: `${orbState.fillPct}%` }}
                />
                <div
                  className={`${styles.contextThresholdTick} ${styles.contextThresholdWarn}`}
                  style={{ left: `${WARN_THRESHOLD_PCT}%` }}
                  title={`${WARN_THRESHOLD_PCT}% warning threshold`}
                  aria-hidden="true"
                />
                <div
                  className={`${styles.contextThresholdTick} ${styles.contextThresholdErr}`}
                  style={{ left: `${COMPACT_THRESHOLD_PCT}%` }}
                  title={`${COMPACT_THRESHOLD_PCT}% compaction threshold`}
                  aria-hidden="true"
                />
              </div>

              <div className={styles.contextLedger}>
                <div className={styles.contextLedgerRow}>
                  <span className={styles.contextLedgerKey}>Used</span>
                  <span className={`${styles.contextLedgerVal} ${styles.tabular}`}>
                    <strong className={styles.contextLedgerStrong}>
                      {formatCompactNumber(contextWindow!.contextTokens)}
                    </strong>
                    {contextWindow!.contextLimit !== null && contextWindow!.contextLimit > 0 && (
                      <span
                        className={styles.contextLedgerSub}
                        title={
                          contextWindow!.limitEstimated
                            ? 'Estimated model context window'
                            : 'Model context window'
                        }
                      >
                        {' '}
                        / {formatCompactNumber(contextWindow!.contextLimit)}
                      </span>
                    )}
                  </span>
                </div>

                <div className={styles.contextLedgerRow}>
                  <span className={styles.contextLedgerKey}>Cache hit</span>
                  <span className={`${styles.contextLedgerVal} ${styles.tabular}`}>
                    <strong className={styles.contextLedgerStrong}>
                      {Math.round(contextWindow!.cacheHitPct)}%
                    </strong>
                    <span className={styles.contextLedgerSub}>
                      {' '}
                      · {formatCompactNumber(contextWindow!.cacheReadTokens)}
                    </span>
                  </span>
                </div>

                <div className={styles.contextLedgerRow}>
                  <span className={styles.contextLedgerKey}>
                    {contextWindow!.remainingTokens !== null ? 'Remaining' : 'Peak'}
                  </span>
                  <span className={`${styles.contextLedgerVal} ${styles.tabular}`}>
                    <span className={styles.contextLedgerValText}>
                      {contextWindow!.remainingTokens !== null
                        ? `~${formatCompactNumber(contextWindow!.remainingTokens)}`
                        : `Peak ${formatCompactNumber(contextWindow!.peakContextTokens)}`}
                    </span>
                    {wasCompacted && (
                      <span
                        className={styles.contextCompactedPill}
                        title={`Peak ${formatCompactNumber(contextWindow!.peakContextTokens)} before compaction`}
                      >
                        Compacted
                      </span>
                    )}
                  </span>
                </div>

                <div className={styles.contextLedgerRow}>
                  <span className={styles.contextLedgerKey}>Activity</span>
                  <span className={`${styles.contextLedgerVal} ${styles.tabular}`}>
                    {contextWindow!.turnCount.toLocaleString()} turn
                    {contextWindow!.turnCount === 1 ? '' : 's'} ·{' '}
                    {formatCompactNumber(contextWindow!.totalOutputTokens)} out
                  </span>
                </div>

                {contextWindow!.cost && (
                  <div
                    className={styles.contextLedgerRow}
                    title={`${contextWindow!.cost.modelRateLabel} ($${contextWindow!.cost.inputPerMillion}/1M in, $${contextWindow!.cost.cacheReadPerMillion}/1M cached, $${contextWindow!.cost.outputPerMillion}/1M out) — Input ${formatUsd(contextWindow!.cost.inputUsd + contextWindow!.cost.cacheWriteUsd)}, Cached ${formatUsd(contextWindow!.cost.cacheReadUsd)}, Output ${formatUsd(contextWindow!.cost.outputUsd)}${contextWindow!.cost.cacheSavingsUsd >= 0.005 ? ` · Google prompt cache discount: ${formatUsd(contextWindow!.cost.cacheSavingsUsd)}` : ''}${activePlan && contextWindow!.cost.totalUsd > 0 ? ` · ${(Math.round((contextWindow!.cost.totalUsd / activePlan.monthlyUsd) * 1000) / 10).toFixed(1)}% of ${activePlan.label}` : ''}`}
                  >
                    <span className={styles.contextLedgerKey}>API cost</span>
                    <span className={`${styles.contextLedgerVal} ${styles.tabular}`}>
                      <strong className={styles.contextLedgerStrong}>
                        {formatUsd(contextWindow!.cost.totalUsd)}
                      </strong>
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className={styles.contextTimelineWell}>
            <div className={styles.contextTimelineHeader}>
              <div className={styles.contextTimelineTitleGroup}>
                <span className={styles.contextTimelineTitle}>Timeline</span>
                <span
                  className={`${styles.contextDeltaBadge} ${styles.tabular} ${
                    deltaInfo.tone === 'ok'
                      ? styles.contextDeltaOk
                      : deltaInfo.tone === 'warn'
                        ? styles.contextDeltaWarn
                        : styles.contextDeltaNeutral
                  }`}
                >
                  {deltaInfo.text}
                </span>
              </div>

              <span
                className={`${styles.contextTimelineReadout} ${styles.tabular}`}
                aria-live="polite"
              >
                {isHovering && activePlotted
                  ? `T${activePlotted.point.turn} · ${formatCompactNumber(activePlotted.point.contextTokens)} (${activeCachePct}% cache)`
                  : `Peak ${formatCompactNumber(contextWindow!.peakContextTokens)}`}
              </span>
            </div>

            {!chart || chart.points.length === 0 ? (
              <div className={styles.contextTimelineEmpty}>Waiting for first model turn...</div>
            ) : (
              <>
                <div ref={chartWrapRef} className={styles.contextChartWrap}>
                  <svg
                    ref={svgRef}
                    className={styles.contextTimelineSvg}
                    viewBox={`0 0 ${chartWidth} ${CHART_H}`}
                    width="100%"
                    height={CHART_H}
                    tabIndex={0}
                    role="img"
                    aria-label="Context tokens across turns"
                    onPointerMove={(e) => handlePointerScrub(e.clientX)}
                    onMouseMove={(e) => handlePointerScrub(e.clientX)}
                    onPointerLeave={() => setHoveredIdx(null)}
                    onMouseLeave={() => setHoveredIdx(null)}
                    onBlur={() => setHoveredIdx(null)}
                    onKeyDown={handleChartKeyDown}
                  >
                    <defs>
                      <linearGradient id={lineGradId} x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="var(--term-accent)" />
                        <stop offset="100%" stopColor="var(--term-ok)" />
                      </linearGradient>

                      <linearGradient id={areaGradId} x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop
                          offset="0%"
                          stopColor={
                            severity === 'err'
                              ? 'var(--term-err)'
                              : severity === 'warn'
                                ? 'var(--term-warn)'
                                : 'var(--term-accent)'
                          }
                          stopOpacity="0.2"
                        />
                        <stop
                          offset="100%"
                          stopColor={
                            severity === 'err'
                              ? 'var(--term-err)'
                              : severity === 'warn'
                                ? 'var(--term-warn)'
                                : 'var(--term-accent)'
                          }
                          stopOpacity="0"
                        />
                      </linearGradient>
                    </defs>

                    <line
                      x1={PAD_LEFT}
                      y1={PAD_TOP}
                      x2={PAD_LEFT + plotW}
                      y2={PAD_TOP}
                      className={
                        chart.showLimitLine
                          ? styles.contextChartLimitLine
                          : styles.contextChartGridLine
                      }
                    />
                    <line
                      x1={PAD_LEFT}
                      y1={PAD_TOP + PLOT_H * 0.5}
                      x2={PAD_LEFT + plotW}
                      y2={PAD_TOP + PLOT_H * 0.5}
                      className={styles.contextChartGridLine}
                    />
                    <line
                      x1={PAD_LEFT}
                      y1={PAD_TOP + PLOT_H}
                      x2={PAD_LEFT + plotW}
                      y2={PAD_TOP + PLOT_H}
                      className={styles.contextChartGridLine}
                    />

                    {chart.warnY !== null && (
                      <line
                        x1={PAD_LEFT}
                        y1={chart.warnY}
                        x2={PAD_LEFT + plotW}
                        y2={chart.warnY}
                        className={styles.contextChartWarnLine}
                      />
                    )}
                    {chart.compactY !== null && (
                      <line
                        x1={PAD_LEFT}
                        y1={chart.compactY}
                        x2={PAD_LEFT + plotW}
                        y2={chart.compactY}
                        className={styles.contextChartCompactLine}
                      />
                    )}

                    {chart.showLimitLine && (
                      <text
                        x={PAD_LEFT + plotW}
                        y={PAD_TOP - 2}
                        textAnchor="end"
                        className={styles.contextChartLimitLabel}
                      >
                        LIMIT
                      </text>
                    )}

                    {chart.points.map((p) =>
                      p.isCompaction ? (
                        <g key={`cmp-${p.point.turn}`}>
                          <line
                            x1={p.x}
                            y1={PAD_TOP}
                            x2={p.x}
                            y2={PAD_TOP + PLOT_H}
                            className={styles.contextCompactionLine}
                          />
                          <circle
                            cx={p.x}
                            cy={p.yTotal}
                            r={2.5}
                            className={styles.contextCompactionDot}
                          />
                        </g>
                      ) : null,
                    )}

                    <path d={chart.totalAreaPath} fill={`url(#${areaGradId})`} />

                    <path
                      d={chart.cachedLinePath}
                      fill="none"
                      stroke="var(--term-ok)"
                      strokeOpacity="0.7"
                      strokeWidth="1.2"
                      strokeDasharray="3 3"
                    />

                    <path
                      d={chart.totalLinePath}
                      fill="none"
                      stroke={lineStroke}
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />

                    {activePlotted && (
                      <g>
                        {isHovering && (
                          <line
                            x1={activePlotted.x}
                            y1={PAD_TOP}
                            x2={activePlotted.x}
                            y2={PAD_TOP + PLOT_H}
                            className={styles.contextCrosshair}
                          />
                        )}
                        <circle
                          cx={activePlotted.x}
                          cy={activePlotted.yTotal}
                          r={5.5}
                          fill={activePointColor}
                          fillOpacity="0.22"
                        />
                        <circle
                          cx={activePlotted.x}
                          cy={activePlotted.yTotal}
                          r={2.8}
                          fill={activePointColor}
                          stroke="var(--term-surface)"
                          strokeWidth="1.2"
                        />
                      </g>
                    )}
                  </svg>
                </div>

                <div className={`${styles.contextTimelineAxis} ${styles.tabular}`}>
                  <span>T{chart.points[0].point.turn}</span>
                  <span className={styles.contextTimelineLegend}>
                    <span className={styles.contextLegendItem}>
                      <span
                        className={`${styles.contextLegendLineSolid} ${
                          severity === 'ok' ? styles.contextLegendLineSpectrum : ''
                        }`}
                        style={
                          severity === 'ok' ? undefined : { background: activePointColor }
                        }
                      />
                      <span>Total</span>
                    </span>
                    <span className={styles.contextLegendItem}>
                      <span className={styles.contextLegendLineDashed} />
                      <span>Cached</span>
                    </span>
                  </span>
                  <span>T{chart.points[chart.points.length - 1].point.turn}</span>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </section>
  )
}
