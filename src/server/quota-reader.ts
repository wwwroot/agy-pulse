import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { QuotaPool, QuotaSnapshot, QuotaWindow } from '../shared/types.ts'

const execFileAsync = promisify(execFile)

const CLI_TIMEOUT_MS = 25_000
const CLI_MAX_BYTES = 1024 * 1024
const APP_PROBE_TIMEOUT_MS = 4_000
const APP_REQUEST_TIMEOUT_MS = 5_000
const DEFAULT_TTL_MS = 60_000
const DEFAULT_ERROR_TTL_MS = 30_000

const APP_QUOTA_PATH =
  '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
const APP_REQUEST_BODY = JSON.stringify({
  metadata: {
    ideName: 'antigravity',
    extensionName: 'antigravity',
    ideVersion: 'unknown',
    locale: 'en',
  },
})

const AGY_POOLS: Record<string, { id: string; name: string }> = {
  'Gemini Models': { id: 'agy-gemini', name: 'Gemini Models' },
  'Gemini 4 Argon': { id: 'agy-argon', name: 'Gemini 4 Argon' },
  'Claude and GPT models': { id: 'agy-3p', name: 'Claude and GPT models' },
}

const AGY_WINDOWS: Record<
  string,
  { kind: QuotaWindow['kind']; label: string; hours: number }
> = {
  weekly: { kind: 'period', label: '7d', hours: 168 },
  '5h': { kind: 'short', label: '5h', hours: 5 },
}

const LANG_SERVER_RE =
  /(^|\/)language[_-]server([_-][a-z0-9]+)*(\.exe)?(\s|"|$)/
const CSRF_FLAG_RE = /--csrf_token[=\s]+("([^"]+)"|'([^']+)'|(\S+))/i
const IDE_MARKERS = [
  'antigravity ide.app/',
  '--app_data_dir antigravity-ide',
  '--app_data_dir=antigravity-ide',
  '/extensions/antigravity/bin/language_server',
]

/**
 * Billing/provider override environment variables stripped before spawning `agy`
 * so ambient keys cannot reroute subscription reads onto paid API endpoints.
 */
const STRIPPED_BILLING_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_API_KEY',
  'MODEL_PROVIDER',
  'CODEX_CONFIG',
  'DEFAULT_AUTH_REQUEST',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'XAI_API_KEY',
  'GROK_CODE_XAI_API_KEY',
  'GROK_AUTH',
  'GROK_MODELS_BASE_URL',
  'GROK_XAI_API_BASE_URL',
  'GROK_CLI_CHAT_PROXY_BASE_URL',
  'OPENCODE_API_KEY',
] as const

export interface AgyAppServerEntry {
  pid: number
  csrf: string
}

export interface AgyQuotaDeps {
  cli: (bin: string) => Promise<QuotaSnapshot>
  listProcesses: () => Promise<string>
  listeningPorts: (pid: number) => Promise<number[]>
  postLocalHttps: (
    port: number,
    reqPath: string,
    headers: Record<string, string>,
    body: string,
    timeoutMs: number,
  ) => Promise<{ status: number; body: string }>
}

export interface AntigravityQuotaReaderOptions {
  ttlMs?: number
  errorTtlMs?: number
  dataDir?: string
  cliBin?: string
  deps?: Partial<AgyQuotaDeps>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
}

/**
 * Computes IEEE-754-safe remaining fraction in [0, 1] from a `usedPct` (0..100).
 * Uses `(100 - usedPct) / 100` so 98% used equals exactly `0.02`; NaN fails closed to `0`.
 */
export function safeRemainingFromUsedPct(usedPct: number): number {
  if (!Number.isFinite(usedPct)) return 0
  return Math.min(1, Math.max(0, (100 - usedPct) / 100))
}

/**
 * Estimates the fraction of a quota window expected to expire unused at the current spend rate.
 * Returns `null` when reset time is unknown, before window start, or after reset.
 */
export function projectedUnused(
  remaining: number,
  resetsAt: number | null,
  periodHours: number,
  now: number = Date.now(),
): number | null {
  if (
    resetsAt === null ||
    !Number.isFinite(remaining) ||
    !Number.isFinite(periodHours) ||
    periodHours <= 0
  ) {
    return null
  }
  const hoursLeft = (resetsAt - now) / 3_600_000
  const elapsed = periodHours - hoursLeft
  if (elapsed <= 0 || hoursLeft < 0) {
    return null
  }
  const clamped = Math.min(1, Math.max(0, remaining))
  const projected = clamped - ((1 - clamped) / elapsed) * hoursLeft
  return Math.max(0, Math.min(1, projected))
}

/** Redacts any discovered CSRF tokens so secrets never appear in errors or warnings. */
export function scrubTokens(text: string, tokens: readonly string[]): string {
  let cleaned = text
  for (const token of tokens) {
    if (token) {
      cleaned = cleaned.replaceAll(token, '[redacted]')
    }
  }
  return cleaned
}

function scrubEnvForAgy(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  const stripped = new Set<string>(STRIPPED_BILLING_ENV_VARS)
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue
    if (stripped.has(k.toUpperCase())) continue
    env[k] = v
  }
  env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true'
  return env
}

function prependPath(env: Record<string, string>, dir: string): Record<string, string> {
  const next = { ...env }
  if (process.platform === 'win32') {
    const pathKey =
      Object.keys(next).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
    const existing = next[pathKey]
    next[pathKey] = existing ? `${dir}${path.delimiter}${existing}` : dir
  } else {
    next.PATH = next.PATH ? `${dir}${path.delimiter}${next.PATH}` : dir
  }
  return next
}

async function installBrowserGuard(): Promise<{ dir: string; launcher: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agy-pulse-quota-'))
  try {
    if (process.platform === 'win32') {
      const script = '@echo off\r\nexit /b 1\r\n'
      const launchers = ['open.cmd', 'xdg-open.cmd', 'browser-guard.cmd']
      for (const name of launchers) {
        await writeFile(path.join(dir, name), script, 'utf8')
      }
      return { dir, launcher: path.join(dir, 'browser-guard.cmd') }
    }
    const script = '#!/bin/sh\nexit 1\n'
    const launchers = ['open', 'xdg-open']
    for (const name of launchers) {
      const target = path.join(dir, name)
      await writeFile(target, script, 'utf8')
      await chmod(target, 0o700)
    }
    return { dir, launcher: path.join(dir, 'open') }
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

function killProcessTree(child: ChildProcess, detachedGroup: boolean): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.unref()
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // Ignore already-exited child.
      }
    }
    return
  }
  if (detachedGroup) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      // Group already gone; fall through to direct kill.
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // Ignore.
  }
}

function runBoundedAgyCli(
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<{ stdout?: string; error?: string }> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const useDetached = !isWin
    let child: ChildProcess
    try {
      if (isWin && !bin.toLowerCase().endsWith('.exe')) {
        // On Windows `agy` is frequently installed as an `.cmd` shim; run through cmd.exe without shell interpolation.
        const comspec = process.env.ComSpec || 'cmd.exe'
        child = spawn(comspec, ['/d', '/s', '/c', bin, ...args], {
          cwd: opts.cwd,
          env: opts.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } else {
        child = spawn(bin, args, {
          cwd: opts.cwd,
          env: opts.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: useDetached,
          windowsHide: true,
        })
      }
    } catch (err) {
      resolve({ error: `agy /usage spawn failed: ${firstLine(errorMessage(err))}` })
      return
    }

    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let totalBytes = 0
    let errBytes = 0
    let settled = false

    const finish = (result: { stdout?: string; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const abort = (error: string) => {
      killProcessTree(child, useDetached)
      finish({ error })
    }

    const timer = setTimeout(() => {
      abort(`agy /usage timed out after ${opts.timeoutMs} ms`)
    }, opts.timeoutMs)
    timer.unref()

    child.stdout?.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > CLI_MAX_BYTES) {
        abort(`agy /usage output exceeded ${CLI_MAX_BYTES} bytes`)
        return
      }
      chunks.push(chunk)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes < 4096) {
        errChunks.push(chunk)
        errBytes += chunk.length
      }
    })

    child.once('error', (err) => {
      finish({ error: `agy /usage failed: ${firstLine(errorMessage(err))}` })
    })

    child.once('exit', () => {
      if (useDetached) {
        killProcessTree(child, true)
      }
    })

    child.once('close', (code, signal) => {
      if (code !== 0) {
        const errTail = firstLine(Buffer.concat(errChunks).toString('utf8'))
        const status = signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`
        finish({
          error: `agy /usage failed (${status})${errTail ? `: ${errTail}` : ''}`,
        })
        return
      }
      finish({ stdout: Buffer.concat(chunks).toString('utf8') })
    })
  })
}

function parseAgyResetTime(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return Number.NaN
    const ms = value * 1000
    return ms <= 0 ? null : ms
  }
  if (typeof value === 'string') {
    const iso = Date.parse(value)
    if (!Number.isNaN(iso)) {
      return iso <= 0 ? null : iso
    }
    const trimmed = value.trim()
    const secs = trimmed !== '' ? Number(trimmed) : Number.NaN
    if (!Number.isFinite(secs)) return Number.NaN
    const ms = secs * 1000
    return ms <= 0 ? null : ms
  }
  return Number.NaN
}

function readBucketFraction(bucket: Record<string, unknown>): unknown {
  if (bucket.remainingFraction !== undefined) {
    return bucket.remainingFraction
  }
  if (bucket.remaining_fraction !== undefined) {
    return bucket.remaining_fraction
  }
  if (isRecord(bucket.remaining)) {
    if (bucket.remaining.remainingFraction !== undefined) {
      return bucket.remaining.remainingFraction
    }
    if (bucket.remaining.case === 'remainingFraction') {
      return bucket.remaining.value
    }
  }
  return undefined
}

/**
 * Shared parser for Antigravity quota summary `groups` (both app-server camelCase
 * and CLI snake_case payloads).
 */
export function parseAgyGroups(
  groups: unknown,
  warnings: string[],
  now: number = Date.now(),
): QuotaPool[] | { error: string } {
  if (!Array.isArray(groups)) {
    return { error: 'agy quota groups are missing' }
  }
  const pools: QuotaPool[] = []
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) {
      return { error: 'agy quota group is malformed' }
    }
    const rawName =
      typeof group.displayName === 'string' && group.displayName !== ''
        ? group.displayName
        : group.name
    if (typeof rawName !== 'string') {
      return { error: 'agy quota group is malformed' }
    }
    const target = AGY_POOLS[rawName]
    if (!target) {
      warnings.push(`unknown agy usage group "${rawName}"`)
      continue
    }
    const windows: QuotaWindow[] = []
    let allDisabled = group.buckets.length > 0
    for (const bucket of group.buckets) {
      if (!isRecord(bucket)) {
        return { error: `agy quota bucket in "${rawName}" is malformed` }
      }
      if (bucket.disabled === true) {
        continue
      }
      allDisabled = false
      const spec =
        typeof bucket.window === 'string' ? AGY_WINDOWS[bucket.window] : undefined
      if (!spec) {
        warnings.push(
          `unknown agy usage window ${JSON.stringify(bucket.window)} in "${rawName}"`,
        )
        continue
      }
      const fraction = readBucketFraction(bucket)
      const resetsAt = parseAgyResetTime(bucket.resetTime ?? bucket.reset_time)
      if (
        typeof fraction !== 'number' ||
        !Number.isFinite(fraction) ||
        Number.isNaN(resetsAt)
      ) {
        return {
          error: `agy ${bucket.window} bucket in "${rawName}" has an unreadable value`,
        }
      }
      const remaining = safeRemainingFromUsedPct(100 * (1 - fraction))
      windows.push({
        kind: spec.kind,
        label: spec.label,
        remaining,
        resetsAt,
        periodHours: spec.hours,
        projectedUnused: projectedUnused(remaining, resetsAt, spec.hours, now),
      })
    }
    if (windows.length > 0) {
      pools.push({ id: target.id, name: target.name, windows })
    } else if (allDisabled) {
      pools.push({ id: target.id, name: target.name, windows: [], disabled: true })
    }
  }
  const activePools = pools.filter((p) => !p.disabled && p.windows.length > 0)
  if (activePools.length === 0) {
    return { error: 'agy has no enabled buckets in a known group' }
  }
  return pools
}

/** Maps `agy -p /usage --output-format json` output to a `QuotaSnapshot`. */
export function parseAgyUsage(
  raw: unknown,
  now: number = Date.now(),
): QuotaSnapshot {
  const warnings: string[] = []
  const fail = (error: string): QuotaSnapshot => ({
    provider: 'antigravity',
    fetchedAt: now,
    source: 'none',
    pools: [],
    error,
    warnings,
  })

  if (!isRecord(raw) || raw.status !== 'SUCCESS') {
    return fail(
      `agy /usage did not succeed: status ${JSON.stringify(isRecord(raw) ? raw.status : raw)}`,
    )
  }
  if (raw.num_turns !== 0) {
    return fail(
      `agy /usage ran model turns: num_turns ${JSON.stringify(raw.num_turns)}`,
    )
  }
  const data =
    isRecord(raw.command) && isRecord(raw.command.data) ? raw.command.data : null
  if (!data || !Array.isArray(data.groups)) {
    return fail('agy /usage result has no command.data.groups')
  }

  const parsed = parseAgyGroups(data.groups, warnings, now)
  if (!Array.isArray(parsed)) {
    return fail(parsed.error)
  }
  return {
    provider: 'antigravity',
    fetchedAt: now,
    source: 'cli',
    pools: parsed,
    warnings,
  }
}

/**
 * Extracts Antigravity app `language_server` processes (excluding IDE markers)
 * carrying `--csrf_token`. Works on both POSIX `ps` output and Windows CIM output.
 */
export function findAgyAppServers(processOutput: string): AgyAppServerEntry[] {
  const servers: AgyAppServerEntry[] = []
  for (const rawLine of processOutput.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = /^(\d+)\s+(.+)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    const command = match[2]
    const lower = command.replace(/\\/g, '/').toLowerCase()
    if (!LANG_SERVER_RE.test(lower)) continue
    const hasAppMarker =
      (lower.includes('--app_data_dir') && lower.includes('antigravity')) ||
      lower.includes('antigravity.app/') ||
      lower.includes('/gemini.app/') ||
      lower.includes('/antigravity/')
    if (!hasAppMarker || IDE_MARKERS.some((marker) => lower.includes(marker))) {
      continue
    }
    const csrfMatch = CSRF_FLAG_RE.exec(command)
    const csrf = csrfMatch?.[2] ?? csrfMatch?.[3] ?? csrfMatch?.[4]
    if (!csrf) continue
    servers.push({ pid, csrf })
  }
  return servers
}

/** Parses listening TCP ports from POSIX `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>`. */
export function parseListeningPorts(lsofOutput: string): number[] {
  const ports = new Set<number>()
  for (const match of lsofOutput.matchAll(/:(\d+)\s+\(LISTEN\)/g)) {
    const port = Number(match[1])
    if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) {
      ports.add(port)
    }
  }
  return [...ports].sort((a, b) => a - b)
}

/** Parses listening localhost TCP ports for `pid` from Windows `netstat -ano -p TCP`. */
export function parseWindowsListeningPorts(netstatOutput: string, pid: number): number[] {
  const ports = new Set<number>()
  for (const rawLine of netstatOutput.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || !line.toUpperCase().startsWith('TCP')) continue
    const parts = line.split(/\s+/)
    // Format: TCP <localAddr> <foreignAddr> LISTENING <pid>
    if (parts.length < 5) continue
    const localAddr = parts[1]
    const state = parts[3]?.toUpperCase()
    const rowPid = Number(parts[4])
    if (state !== 'LISTENING' || rowPid !== pid) continue
    if (
      !localAddr.startsWith('127.0.0.1:') &&
      !localAddr.startsWith('0.0.0.0:') &&
      !localAddr.startsWith('[::1]:') &&
      !localAddr.startsWith('[::]:')
    ) {
      continue
    }
    const colonIdx = localAddr.lastIndexOf(':')
    if (colonIdx === -1) continue
    const port = Number(localAddr.slice(colonIdx + 1))
    if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) {
      ports.add(port)
    }
  }
  return [...ports].sort((a, b) => a - b)
}

function isAppResponseCodeOk(code: unknown): boolean {
  if (code === undefined || code === null) return true
  if (typeof code === 'number') return code === 0
  if (typeof code === 'string') {
    const lower = code.toLowerCase()
    return lower === 'ok' || lower === 'success' || code === '0'
  }
  return false
}

function defaultPostLocalHttps(
  port: number,
  reqPath: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': String(Buffer.byteLength(body)),
        },
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        let totalBytes = 0
        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length
          if (totalBytes > CLI_MAX_BYTES) {
            req.destroy(new Error('response too large'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
        res.on('error', reject)
      },
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs} ms`))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function defaultListProcesses(): Promise<string> {
  if (process.platform === 'win32') {
    const psScript =
      'Get-CimInstance Win32_Process -Filter "Name LIKE \'language_server%\'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      {
        timeout: APP_PROBE_TIMEOUT_MS,
        maxBuffer: CLI_MAX_BYTES,
        windowsHide: true,
      },
    )
    return stdout
  }
  const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='], {
    timeout: APP_PROBE_TIMEOUT_MS,
    maxBuffer: CLI_MAX_BYTES,
  })
  return stdout
}

async function defaultListeningPorts(pid: number): Promise<number[]> {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'TCP'], {
      timeout: APP_PROBE_TIMEOUT_MS,
      maxBuffer: CLI_MAX_BYTES * 2,
      windowsHide: true,
    })
    return parseWindowsListeningPorts(stdout, pid)
  }
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)],
      {
        timeout: APP_PROBE_TIMEOUT_MS,
        maxBuffer: CLI_MAX_BYTES,
      },
    )
    return parseListeningPorts(stdout)
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string }
    if (e.code === 1 && !(e.stderr ?? '').trim()) {
      return parseListeningPorts(e.stdout ?? '')
    }
    throw err
  }
}

async function defaultReadCli(bin: string): Promise<QuotaSnapshot> {
  const now = Date.now()
  const fail = (error: string): QuotaSnapshot => ({
    provider: 'antigravity',
    fetchedAt: now,
    source: 'none',
    pools: [],
    error,
    warnings: [],
  })

  let guard: { dir: string; launcher: string }
  try {
    guard = await installBrowserGuard()
  } catch (err) {
    return fail(`agy /usage browser guard failed: ${firstLine(errorMessage(err))}`)
  }

  let runResult: { stdout?: string; error?: string }
  try {
    const env = prependPath(scrubEnvForAgy(), guard.dir)
    env.BROWSER = guard.launcher
    runResult = await runBoundedAgyCli(
      bin,
      ['-p', '/usage', '--output-format', 'json'],
      {
        cwd: guard.dir,
        env,
        timeoutMs: CLI_TIMEOUT_MS,
      },
    )
  } finally {
    await rm(guard.dir, { recursive: true, force: true }).catch(() => {})
  }

  if (runResult.error !== undefined) {
    return fail(runResult.error)
  }
  let raw: unknown
  try {
    raw = JSON.parse(runResult.stdout ?? '')
  } catch {
    return fail('agy /usage output is not JSON')
  }
  return parseAgyUsage(raw, Date.now())
}

async function probeAppServer(
  deps: AgyQuotaDeps,
  now: number,
): Promise<QuotaSnapshot | { fallthrough: string }> {
  let psOutput: string
  try {
    psOutput = await deps.listProcesses()
  } catch {
    return { fallthrough: 'no Antigravity app server' }
  }
  const servers = findAgyAppServers(psOutput)
  if (servers.length === 0) {
    return { fallthrough: 'no Antigravity app server' }
  }

  const tokens = servers.map((s) => s.csrf)
  const scrub = (text: string): string => scrubTokens(text, tokens)
  let lastReason: string | undefined

  for (const server of servers) {
    let ports: number[]
    try {
      ports = await deps.listeningPorts(server.pid)
    } catch {
      lastReason ??= 'Antigravity app server unreachable'
      continue
    }
    for (const port of ports) {
      let res: { status: number; body: string }
      try {
        res = await deps.postLocalHttps(
          port,
          APP_QUOTA_PATH,
          {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'X-Codeium-Csrf-Token': server.csrf,
          },
          APP_REQUEST_BODY,
          APP_REQUEST_TIMEOUT_MS,
        )
      } catch {
        lastReason ??= 'Antigravity app server unreachable'
        continue
      }
      if (res.status !== 200) {
        lastReason = `Antigravity app server HTTP ${res.status}`
        continue
      }
      let raw: unknown
      try {
        raw = JSON.parse(res.body)
      } catch {
        lastReason = 'Antigravity app server response is not JSON'
        continue
      }
      if (!isRecord(raw)) {
        lastReason = 'Antigravity app server response is malformed'
        continue
      }
      if (!isAppResponseCodeOk(raw.code)) {
        const label =
          typeof raw.code === 'number' || typeof raw.code === 'string'
            ? String(raw.code)
            : 'invalid'
        lastReason = scrub(`Antigravity app server code ${label}`)
        continue
      }
      const payload = isRecord(raw.response)
        ? raw.response
        : isRecord(raw.summary)
          ? raw.summary
          : raw
      if (!Array.isArray(payload.groups)) {
        lastReason = 'Antigravity app server response has no groups'
        continue
      }
      const warnings: string[] = []
      const parsed = parseAgyGroups(payload.groups, warnings, now)
      if (!Array.isArray(parsed)) {
        lastReason = scrub(parsed.error)
        continue
      }
      return {
        provider: 'antigravity',
        fetchedAt: now,
        source: 'app',
        pools: parsed,
        warnings: warnings.map(scrub),
      }
    }
  }

  return {
    fallthrough: scrub(lastReason ?? 'Antigravity app server unreachable'),
  }
}

export class AntigravityQuotaReader {
  readonly ttlMs: number
  readonly errorTtlMs: number
  readonly dataDir?: string
  private readonly cliBin: string
  private readonly deps: AgyQuotaDeps
  private cached: QuotaSnapshot | null = null
  private inFlight: Promise<QuotaSnapshot> | null = null

  constructor(options: AntigravityQuotaReaderOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.errorTtlMs = options.errorTtlMs ?? DEFAULT_ERROR_TTL_MS
    this.dataDir = options.dataDir
    this.cliBin = options.cliBin ?? 'agy'
    this.deps = {
      cli: options.deps?.cli ?? defaultReadCli,
      listProcesses: options.deps?.listProcesses ?? defaultListProcesses,
      listeningPorts: options.deps?.listeningPorts ?? defaultListeningPorts,
      postLocalHttps: options.deps?.postLocalHttps ?? defaultPostLocalHttps,
    }
  }

  getCached(): QuotaSnapshot | null {
    return this.cached
  }

  async getSnapshot(force = false): Promise<QuotaSnapshot> {
    const now = Date.now()
    if (!force && this.cached) {
      const ttl = this.cached.error ? this.errorTtlMs : this.ttlMs
      if (now - this.cached.fetchedAt < ttl) {
        return this.cached
      }
    }
    if (this.inFlight) {
      return this.inFlight
    }

    const promise = this.probe().finally(() => {
      if (this.inFlight === promise) {
        this.inFlight = null
      }
    })
    this.inFlight = promise
    return promise
  }

  private async probe(): Promise<QuotaSnapshot> {
    try {
      // Ensure dataDir exists if configured (no-op if unused), never throw on fs errors.
      if (this.dataDir) {
        await mkdir(this.dataDir, { recursive: true, mode: 0o700 }).catch(() => {})
      }

      let cliSnap: QuotaSnapshot
      try {
        cliSnap = await this.deps.cli(this.cliBin)
      } catch (err) {
        cliSnap = {
          provider: 'antigravity',
          fetchedAt: Date.now(),
          source: 'none',
          pools: [],
          error: `agy /usage failed: ${firstLine(errorMessage(err))}`,
          warnings: [],
        }
      }

      if (!cliSnap.error && cliSnap.pools.length > 0) {
        this.cached = { ...cliSnap, source: 'cli' }
        return this.cached
      }

      const appResult = await probeAppServer(this.deps, Date.now())
      if (!('fallthrough' in appResult) && !appResult.error) {
        this.cached = appResult
        return this.cached
      }

      const appReason =
        'fallthrough' in appResult ? appResult.fallthrough : appResult.error
      const combined: QuotaSnapshot = {
        provider: 'antigravity',
        fetchedAt: Date.now(),
        source: 'none',
        pools: [],
        error: `${cliSnap.error ?? 'agy /usage unavailable'} (app: ${appReason ?? 'unreachable'})`,
        warnings: cliSnap.warnings,
      }
      this.cached = combined
      return combined
    } catch (err) {
      const fallback: QuotaSnapshot = {
        provider: 'antigravity',
        fetchedAt: Date.now(),
        source: 'none',
        pools: [],
        error: `Quota probe error: ${firstLine(errorMessage(err))}`,
        warnings: [],
      }
      this.cached = fallback
      return fallback
    }
  }
}
