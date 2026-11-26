import type {
  ConversationContextUsage,
  HostHealthSnapshot,
  QuotaSnapshot,
  QuotaWindow,
  SavingsCategory,
  TokenSavingsSummary,
} from '../shared/types.ts'

export type TextStyle =
  | 'bold'
  | 'dim'
  | 'red'
  | 'green'
  | 'yellow'
  | 'cyan'
  | 'gray'

export interface ViewOpts {
  color: boolean
  width: number
  now?: number
}

const SGR: Record<TextStyle, string> = {
  bold: '1',
  dim: '2',
  red: '31',
  green: '32',
  yellow: '33',
  cyan: '36',
  gray: '90',
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g
const NBSP = '\u00a0'
const BAR_WIDTH = 12
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** Determines whether a stream should emit ANSI color codes, honoring NO_COLOR and FORCE_COLOR. */
export function streamColor(stream: { isTTY?: boolean }): boolean {
  if ('NO_COLOR' in process.env && process.env.NO_COLOR !== '') return false
  const force = process.env.FORCE_COLOR
  if (force !== undefined) {
    return force !== '0' && force.toLowerCase() !== 'false'
  }
  return Boolean(stream.isTTY)
}

export const stdoutColor = (): boolean => streamColor(process.stdout)
export const stderrColor = (): boolean => streamColor(process.stderr)

export function paint(
  color: boolean,
  style: TextStyle | TextStyle[],
  text: string,
): string {
  if (!color || text.length === 0) return text
  const list = Array.isArray(style) ? style : [style]
  const codes = list.map((s) => SGR[s]).join(';')
  return `\x1b[${codes}m${text}\x1b[0m`
}

/** Visible column width ignoring ANSI escape sequences. */
export function visibleWidth(text: string): number {
  return text.replace(ANSI_RE, '').length
}

/** Wraps text at spaces to fit `width` visible columns while preserving leading indentation. */
export function wrap(text: string, width: number): string {
  const maxWidth = Math.max(20, width)
  return text
    .split('\n')
    .map((line) => {
      if (visibleWidth(line) <= maxWidth) return line
      const indent = /^ */.exec(line)?.[0] ?? ''
      const rows = [indent]
      let rowWidth = indent.length
      for (const word of line.slice(indent.length).split(' ')) {
        const w = visibleWidth(word)
        const current = rows[rows.length - 1]
        if (rowWidth > indent.length && rowWidth + 1 + w > maxWidth) {
          rows.push(`${indent}${word}`)
          rowWidth = indent.length + w
        } else {
          rows[rows.length - 1] =
            rowWidth === indent.length ? `${current}${word}` : `${current} ${word}`
          rowWidth = rowWidth === indent.length ? rowWidth + w : rowWidth + 1 + w
        }
      }
      return rows.join('\n')
    })
    .join('\n')
}

/**
 * Wraps text while gluing CLI commands (`agy-pulse ...`, `npm run ...`, `node ... --cli ...`,
 * or backticked commands) with NBSP so commands never split mid-invocation across lines.
 */
export function wrapKeep(text: string, width: number): string {
  const glued = text
    .replace(/`[^`]+`/g, (seg) => seg.replaceAll(' ', NBSP))
    .replace(
      /(?:agy-pulse|npm run|node [^\s]+ --cli)(?: [^\s,;.)]+)+/g,
      (cmd) => cmd.replaceAll(' ', NBSP),
    )
  return wrap(glued, width).replaceAll(NBSP, ' ')
}

export function renderBar(
  fraction: number,
  showBar: boolean,
  color: boolean,
  invertTone = false,
): string {
  if (!showBar) return ''
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
  const filled = Math.round(clamped * BAR_WIDTH)
  const pct = Math.round(clamped * 100)
  const tone: TextStyle = invertTone
    ? pct >= 85
      ? 'red'
      : pct >= 65
        ? 'yellow'
        : 'green'
    : pct >= 50
      ? 'green'
      : pct >= 20
        ? 'yellow'
        : 'red'
  return `${paint(color, tone, '█'.repeat(filled))}${paint(color, 'dim', '░'.repeat(BAR_WIDTH - filled))} `
}

function gutter(color: boolean, termWidth: number, wordmark: string, note: string) {
  const width = Math.max(40, termWidth - 3)
  const bar = paint(color, 'gray', '│')
  const lines = [
    `${paint(color, 'gray', '┌')}  ${paint(color, ['bold', 'cyan'], wordmark)} ${paint(color, 'dim', note)}`,
  ]
  const block = (symbol: string, text: string) => {
    for (const [i, line] of wrapKeep(text, width).split('\n').entries()) {
      lines.push(line === '' ? bar : `${i === 0 ? symbol : bar}  ${line}`)
    }
  }
  return {
    width,
    bar,
    lines,
    block,
    section(title: string, body: string) {
      lines.push(bar)
      block(paint(color, 'green', '◇'), title)
      block(bar, body)
    },
    end(): string {
      lines.push(bar, paint(color, 'gray', '└'))
      return lines.join('\n')
    },
  }
}

function renderTable(
  rows: Array<[string, string]>,
  width: number,
  styleLeft: (s: string) => string,
): string {
  if (rows.length === 0) return ''
  const col = Math.min(28, Math.max(...rows.map(([l]) => visibleWidth(l))))
  return rows
    .flatMap(([left, right]) => {
      const wrapped = wrapKeep(right, Math.max(20, width - col - 2)).split('\n')
      if (visibleWidth(left) > col) {
        return [styleLeft(left), ...wrapped.map((l) => `${' '.repeat(col + 2)}${l}`)]
      }
      return wrapped.map(
        (l, i) => `${i === 0 ? styleLeft(left.padEnd(col)) : ' '.repeat(col)}  ${l}`,
      )
    })
    .join('\n')
}

function formatResetShort(epochMs: number, now: number): string {
  const diffMs = epochMs - now
  if (diffMs <= 0) return 'now'
  const totalMin = Math.ceil(diffMs / 60_000)
  if (totalMin < 60) return `in ${totalMin}m`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h < 24) return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`
  const d = Math.floor(h / 24)
  const remH = h % 24
  const dt = new Date(epochMs)
  const hh = String(dt.getHours()).padStart(2, '0')
  const mm = String(dt.getMinutes()).padStart(2, '0')
  return remH > 0
    ? `in ${d}d ${remH}h (${DAYS[dt.getDay()]} ${hh}:${mm})`
    : `in ${d}d (${DAYS[dt.getDay()]} ${hh}:${mm})`
}

function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

function formatWindowDetail(w: QuotaWindow, now: number): string {
  const pct = Math.round(w.remaining * 100)
  const parts = [`${w.label} ${pct}%`]
  if (w.resetsAt !== null && Number.isFinite(w.resetsAt) && w.resetsAt > 0) {
    parts.push(`resets ${formatResetShort(w.resetsAt, now)}`)
  }
  if (typeof w.projectedUnused === 'number' && w.projectedUnused >= 0.01) {
    parts.push(`~${Math.round(w.projectedUnused * 100)}% unused`)
  }
  return parts.join(' · ')
}

function renderQuotaPoolLines(
  snap: QuotaSnapshot,
  opts: { color: boolean; width: number; now: number },
): string[] {
  const { color, width, now } = opts
  const showBar = width >= 60
  const lines: string[] = []

  if (snap.error) {
    lines.push(paint(color, 'yellow', `▲ ${snap.error}`))
  }

  const labelWidth = Math.max(0, ...snap.pools.map((p) => p.name.length))
  for (const pool of snap.pools) {
    if (pool.disabled || pool.windows.length === 0) {
      lines.push(
        `  ${paint(color, 'dim', pool.name.padEnd(labelWidth))}  ${paint(color, 'dim', 'disabled')}`,
      )
      continue
    }
    const binding = pool.windows.reduce((low, w) =>
      w.remaining < low.remaining ? w : low,
    )
    const pct = Math.round(binding.remaining * 100)
    const tone: TextStyle = pct >= 50 ? 'green' : pct >= 20 ? 'yellow' : 'red'
    const bar = renderBar(binding.remaining, showBar, color)
    const pctStr = paint(color, tone, `${pct}%`.padStart(4))
    const label = paint(color, 'bold', pool.name.padEnd(labelWidth))
    const details = pool.windows.map((w) => formatWindowDetail(w, now)).join('  |  ')
    lines.push(`  ${label}  ${bar}${pctStr}  ${paint(color, 'dim', details)}`)
  }

  for (const w of snap.warnings) {
    lines.push(paint(color, 'yellow', `▲ ${w}`))
  }

  return lines
}

export function renderQuotasTty(snap: QuotaSnapshot, opts: ViewOpts): string {
  const now = opts.now ?? Date.now()
  const g = gutter(
    opts.color,
    opts.width,
    'agy-pulse quotas',
    `provider ${snap.provider} · source ${snap.source}`,
  )
  const poolLines = renderQuotaPoolLines(snap, {
    color: opts.color,
    width: g.width,
    now,
  })
  g.section(
    'Antigravity Quotas',
    poolLines.length > 0
      ? poolLines.join('\n')
      : paint(opts.color, 'dim', 'No quota pools reported.'),
  )
  return g.end()
}

export function renderQuotasPlain(
  snap: QuotaSnapshot,
  now: number = Date.now(),
): string {
  const lines = [
    `[agy-pulse quotas] provider=${snap.provider} source=${snap.source}`,
  ]
  if (snap.error) lines.push(`error: ${snap.error}`)
  for (const pool of snap.pools) {
    if (pool.disabled || pool.windows.length === 0) {
      lines.push(`- ${pool.name} (${pool.id}): disabled`)
      continue
    }
    const windows = pool.windows.map((w) => formatWindowDetail(w, now)).join('; ')
    lines.push(`- ${pool.name} (${pool.id}): ${windows}`)
  }
  for (const w of snap.warnings) {
    lines.push(`warning: ${w}`)
  }
  return lines.join('\n')
}

export function renderDoctorTty(
  health: HostHealthSnapshot,
  opts: ViewOpts,
  repairNote?: string,
): string {
  const { color } = opts
  const g = gutter(color, opts.width, 'agy-pulse doctor', 'host MCP health')
  const rows: Array<[string, string]> = health.entries.map((e) => {
    const glyph =
      e.status === 'ok'
        ? paint(color, 'green', '✓')
        : e.status === 'stale'
          ? paint(color, 'yellow', '▲')
          : e.status === 'missing'
            ? paint(color, 'red', '✗')
            : paint(color, 'dim', '○')
    return [`${glyph} ${e.host}`, `${e.status} · ${e.detail}`]
  })
  g.section(
    'Host MCP Entries',
    rows.length > 0
      ? renderTable(rows, g.width, (s) => s)
      : paint(color, 'dim', 'No host entries found.'),
  )
  if (repairNote) {
    g.section('Repair', paint(color, 'cyan', repairNote))
  }
  if (health.warnings.length > 0) {
    g.section(
      'Warnings',
      health.warnings.map((w) => paint(color, 'yellow', `▲ ${w}`)).join('\n'),
    )
  }
  return g.end()
}

export function renderDoctorPlain(
  health: HostHealthSnapshot,
  repairNote?: string,
): string {
  const lines = ['[agy-pulse doctor] host MCP health']
  for (const e of health.entries) {
    lines.push(`- ${e.host}: status=${e.status} path=${e.configPath} (${e.detail})`)
  }
  if (repairNote) {
    lines.push(`repair: ${repairNote}`)
  }
  for (const w of health.warnings) {
    lines.push(`warning: ${w}`)
  }
  return lines.join('\n')
}

const CATEGORY_ORDER: readonly SavingsCategory[] = [
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
]

export function renderStatsTty(
  structured: Record<string, unknown>,
  opts: ViewOpts,
): string {
  const { color } = opts
  const now = opts.now ?? Date.now()
  const sessionId = String(structured.sessionId ?? 'default')
  const sync = (structured.sync ?? {}) as Record<string, unknown>
  const mode = String(sync.mode ?? 'unknown')
  const ver = String(structured.daemonVersion ?? sync.version ?? '1.0.0')

  const g = gutter(
    color,
    opts.width,
    'agy-pulse stats',
    `v${ver} · session ${sessionId} · ${mode}`,
  )
  const showBar = g.width >= 60

  if (structured.versionSkewWarning) {
    g.block(paint(color, 'yellow', '▲'), String(structured.versionSkewWarning))
  }

  const cw = structured.contextWindow as ConversationContextUsage | null | undefined
  if (cw?.available) {
    const frac = typeof cw.usagePct === 'number' ? cw.usagePct / 100 : 0
    const pctLabel =
      typeof cw.usagePct === 'number' ? `${cw.usagePct.toFixed(1)}%` : 'n/a'
    const bar = renderBar(frac, showBar, color, true)
    const limitText = cw.contextLimit
      ? `${cw.contextTokens.toLocaleString('en-US')} / ${cw.contextLimit.toLocaleString('en-US')} tok`
      : `${cw.contextTokens.toLocaleString('en-US')} tok`
    g.section(
      `Context Window  ${paint(color, 'dim', cw.modelLabel ?? cw.model ?? '')}`,
      `  ${bar}${paint(color, 'bold', pctLabel)}  ${limitText} · cache ${cw.cacheHitPct.toFixed(0)}% · ${cw.turnCount} turns`,
    )
  }

  const quotas = structured.quotas as QuotaSnapshot | null | undefined
  if (quotas) {
    const qLines = renderQuotaPoolLines(quotas, { color, width: g.width, now })
    if (qLines.length > 0) {
      g.section(
        `Antigravity Quotas  ${paint(color, 'dim', `source ${quotas.source}`)}`,
        qLines.join('\n'),
      )
    }
  }

  const telemetry = structured.telemetry as TokenSavingsSummary | undefined
  if (telemetry) {
    const reductionPct =
      telemetry.totalRawBytes > 0
        ? ((telemetry.totalSavedBytes / telemetry.totalRawBytes) * 100).toFixed(1)
        : '0.0'
    const summaryRows: Array<[string, string]> = [
      [
        'Tokens saved',
        `~${telemetry.estimatedTokensSaved.toLocaleString('en-US')} tok (${reductionPct}% reduction)`,
      ],
      [
        'Bytes trimmed',
        `${formatBytesCompact(telemetry.totalSavedBytes)} avoided / ${formatBytesCompact(telemetry.totalRawBytes)} raw`,
      ],
      [
        'Efficiency',
        `${telemetry.totalCalls} calls · ${telemetry.dedupHits} dedup hits · ${telemetry.roundTripsSaved} round-trips saved`,
      ],
    ]
    g.section(
      'Token Savings',
      renderTable(summaryRows, g.width, (s) => paint(color, 'dim', s)),
    )

    const catRows: Array<[string, string]> = CATEGORY_ORDER.filter(
      (cat) =>
        telemetry.byCategory[cat]?.calls > 0 ||
        telemetry.byCategory[cat]?.savedBytes > 0,
    ).map((cat) => {
      const e = telemetry.byCategory[cat]
      return [
        cat,
        `${e.calls} calls · ${formatBytesCompact(e.savedBytes)} (~${e.estimatedTokensSaved} tok)`,
      ]
    })
    if (catRows.length > 0) {
      g.section(
        'By Mechanism',
        renderTable(catRows, g.width, (s) => paint(color, 'cyan', s)),
      )
    }
  }

  const hostHealth = structured.hostHealth as HostHealthSnapshot | null | undefined
  if (hostHealth && hostHealth.entries.length > 0) {
    const hRows: Array<[string, string]> = hostHealth.entries.map((e) => {
      const badge =
        e.status === 'ok'
          ? paint(color, 'green', '✓ ok')
          : e.status === 'stale'
            ? paint(color, 'yellow', '▲ stale')
            : paint(color, 'red', `✗ ${e.status}`)
      return [e.host, `${badge} · ${e.detail}`]
    })
    g.section(
      'Host MCP Health',
      renderTable(hRows, g.width, (s) => paint(color, 'dim', s)),
    )
  }

  const runtimeRows: Array<[string, string]> = [
    ['Workspace', String(sync.primaryWorkspaceRoot ?? '')],
    [
      'Rust worker',
      sync.workerAvailable
        ? paint(color, 'green', `ready (${String(sync.workerPath ?? 'detected')})`)
        : paint(color, 'red', 'unavailable'),
    ],
    [
      'Sidecar',
      sync.connected && sync.port !== undefined
        ? `127.0.0.1:${String(sync.port)} (pid ${String(sync.pid ?? '?')}, v${ver})`
        : 'offline (local fallback)',
    ],
  ]
  g.section(
    'Runtime',
    renderTable(runtimeRows, g.width, (s) => paint(color, 'dim', s)),
  )

  return g.end()
}

export function renderCliHelpTty(opts: ViewOpts, version = '1.0.0'): string {
  const { color } = opts
  const g = gutter(
    color,
    opts.width,
    'agy-pulse',
    `v${version} · native Rust workspace engine & telemetry CLI`,
  )
  const cyan = (s: string) => paint(color, 'cyan', s)
  g.section(
    'Commands',
    renderTable(
      [
        ['read <file[:a-b]...>', 'Read files/ranges (--outline, --symbol, --hex, --stat, --force)'],
        ['outline <file...>', 'Shorthand for read --outline'],
        ['search <mode> [pat]', 'glob | fuzzy | grep | git_status | git_diff'],
        ['mutate', 'Atomic edit/write/diff/replace/batch (--args or --stdin JSON)'],
        ['doc <path>', 'Native CSV/TSV/DOCX/PDF reader (--format, --offset, --limit)'],
        ['exec <command>', 'Structured shell exec (--script, --desc, --shell, --timeout, --bg)'],
        ['job <action>', 'Supervise background jobs: list | output | input | kill'],
        ['result <action>', 'Spillover & stats: page | release | stats (--ref, --search)'],
        ['quotas [--refresh]', 'Show Antigravity quota pools (CLI + local language-server fallback)'],
        ['doctor [--repair]', 'Check Antigravity host MCP config health (zero-spawn)'],
      ],
      g.width,
      cyan,
    ),
  )
  g.section(
    'Global Options',
    renderTable(
      [
        ['--cwd <dir>', 'Explicit workspace root directory'],
        ['--session <id>', 'Session ID for isolated readDedup & telemetry'],
        ['--args <json>', 'Pass exact MCP tool arguments as JSON'],
        ['--stdin', 'Read exact MCP tool arguments JSON from stdin'],
        ['--json', 'Emit pure machine-readable JSON'],
        ['-h, --help', 'Show help (or `--cli <command> --help`)'],
      ],
      g.width,
      cyan,
    ),
  )
  return g.end()
}

export function renderErrorTty(message: string, color: boolean): string {
  const styled = message.replace(/`([^`]+)`/g, (_, cmd: string) =>
    paint(color, 'cyan', cmd),
  )
  return `${paint(color, 'red', '✗')} ${styled}`
}
