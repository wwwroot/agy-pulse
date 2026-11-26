import { formatUsd } from '../../shared/pricing.ts'
import type { QuotaWindow } from '../../shared/types.ts'

export { formatUsd }

/** Formats durations coarsely without trailing zero units (e.g. `<1m`, `4m`, `4h 15m`, `2d 3h`, `2d`). */
export function formatCoarseDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '<1m'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const m = minutes % 60
    return m === 0 ? `${hours}h` : `${hours}h ${m}m`
  }
  const days = Math.floor(hours / 24)
  const h = hours % 24
  return h === 0 ? `${days}d` : `${days}d ${h}h`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) {
    const secs = ms / 1_000
    const rounded = Math.round(secs * 10) / 10
    if (rounded >= 60) return '1m'
    return Number.isInteger(rounded) ? `${rounded}s` : `${rounded.toFixed(1)}s`
  }
  if (ms < 3_600_000) {
    const mins = Math.floor(ms / 60_000)
    const secs = Math.floor((ms % 60_000) / 1_000)
    return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`
  }
  if (ms < 86_400_000) {
    const totalMins = Math.floor(ms / 60_000)
    const hours = Math.floor(totalMins / 60)
    const mins = totalMins % 60
    return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`
  }
  const totalHours = Math.floor(ms / 3_600_000)
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`
}

export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 ms'
  if (ms < 10) return `${ms.toFixed(1)} ms`
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1_000) return Math.round(value).toLocaleString('en-US')
  if (value < 10_000) return `${(value / 1_000).toFixed(2)}K`
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`
  return `${(value / 1_000_000).toFixed(2)}M`
}

export function formatShortSessionLabel(sessionId: string, label?: string): string {
  const cleanLabel = label?.trim()
  if (cleanLabel) return cleanLabel
  const cleanId = sessionId.trim()
  if (!cleanId || cleanId === 'default') return 'Default Session'
  return `Session ${cleanId.slice(0, 8)}`
}

export function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return ''
  }
}

/** Clock-injectable relative time formatter covering past and future timestamps. */
export function formatRelativeAge(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return 'just now'
  const deltaMs = ts - now
  if (deltaMs > 0) {
    if (deltaMs < 60_000) return 'now'
    return `in ${formatCoarseDuration(deltaMs)}`
  }
  const pastMs = -deltaMs
  if (pastMs < 10_000) return 'just now'
  if (pastMs < 60_000) return `${Math.floor(pastMs / 1_000)}s ago`
  return `${formatCoarseDuration(pastMs)} ago`
}

export function formatElapsed(
  startedAt: number,
  endedAt?: number | null,
  now = Date.now(),
): string {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return '0ms'
  const end =
    endedAt !== undefined && endedAt !== null && Number.isFinite(endedAt) ? endedAt : now
  return formatDuration(Math.max(0, end - startedAt))
}

export function middleTruncate(text: string, maxLen: number): string {
  if (!text || maxLen <= 0) return ''
  if (text.length <= maxLen) return text
  if (maxLen <= 3) return text.slice(0, maxLen)

  const lastSlash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  if (lastSlash > 0 && lastSlash < text.length - 1) {
    const tail = text.slice(lastSlash)
    if (tail.length + 3 <= maxLen) {
      const headLen = maxLen - tail.length - 1
      return `${text.slice(0, headLen)}…${tail}`
    }
  }

  const avail = maxLen - 1
  const headLen = Math.ceil(avail * 0.45)
  const tailLen = avail - headLen
  return `${text.slice(0, headLen)}…${text.slice(text.length - tailLen)}`
}

export function formatWindowSpan(periodHours: number): string {
  if (!Number.isFinite(periodHours) || periodHours <= 0) return '0h'
  const h = Math.round(periodHours)
  return h < 24 || h % 24 !== 0 ? `${h}h` : `${h / 24}d`
}

/** Formats a single-line quota window summary (`7d · 37% left · resets in 2d 3h · ~12% unused`). */
export function formatQuotaWindowLine(
  win: Pick<QuotaWindow, 'periodHours' | 'remaining' | 'resetsAt' | 'projectedUnused'>,
  now = Date.now(),
): string {
  const span = formatWindowSpan(win.periodHours)
  const clamped = Number.isFinite(win.remaining) ? Math.min(1, Math.max(0, win.remaining)) : 0
  const pct = Math.round(clamped * 100)
  const resets =
    win.resetsAt !== null && Number.isFinite(win.resetsAt) && win.resetsAt > 0
      ? `resets ${formatRelativeAge(win.resetsAt, now)}`
      : 'resets —'
  const unused =
    typeof win.projectedUnused === 'number' &&
    Number.isFinite(win.projectedUnused) &&
    win.projectedUnused >= 0.005
      ? ` · ~${Math.round(win.projectedUnused * 100)}% unused`
      : ''
  return `${span} · ${pct}% left · ${resets}${unused}`
}

/** Compact quota window caption for 2-column sidecar cards (omits placeholder reset dashes). */
export function formatCompactQuotaWindow(
  win: Pick<QuotaWindow, 'periodHours' | 'remaining' | 'resetsAt' | 'projectedUnused'>,
  now = Date.now(),
): { span: string; pct: number; meta: string } {
  const span = formatWindowSpan(win.periodHours)
  const clamped = Number.isFinite(win.remaining) ? Math.min(1, Math.max(0, win.remaining)) : 0
  const pct = Math.round(clamped * 100)
  const parts: string[] = []
  if (win.resetsAt !== null && Number.isFinite(win.resetsAt) && win.resetsAt > 0) {
    parts.push(formatRelativeAge(win.resetsAt, now))
  }
  if (
    typeof win.projectedUnused === 'number' &&
    Number.isFinite(win.projectedUnused) &&
    win.projectedUnused >= 0.005
  ) {
    parts.push(`~${Math.round(win.projectedUnused * 100)}% unused`)
  }
  return { span, pct, meta: parts.join(' · ') }
}

export function folderBaseName(fullPath: string): string {
  const cleaned = fullPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const idx = cleaned.lastIndexOf('/')
  return idx >= 0 ? cleaned.slice(idx + 1) || cleaned : cleaned
}
