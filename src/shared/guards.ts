import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { FailureInfo } from './types.ts'

export interface CredentialFenceResult {
  blocked: boolean
  reason?: string
  matchedPattern?: string
  failure?: FailureInfo
}

export interface DownloadGuardResult {
  blocked: boolean
  matchedTool?: string
  url?: string
  file?: string
  suggestion?: string
  failure?: FailureInfo
}

const SENSITIVE_DIR_SEGMENTS = new Set([
  '.ssh',
  '.aws',
  '.azure',
  '.kube',
  '.gnupg',
])

const SENSITIVE_EXACT_BASENAMES = new Set([
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
])

const SAFE_ENV_TEMPLATE_NAMES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
  '.env.schema',
])

const SENSITIVE_KEY_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx']

function canonicalizePathForCheck(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (!trimmed) return ''

  // Expand home-like prefixes to a synthetic POSIX root so path-segment rules apply uniformly.
  const homeExpanded = trimmed
    .replace(/^~(?=[\\/]|$)/, '/__HOME__')
    .replace(/^\$HOME(?=[\\/]|$)/i, '/__HOME__')
    .replace(/^\$\{HOME\}(?=[\\/]|$)/i, '/__HOME__')
    .replace(/^%USERPROFILE%(?=[\\/]|$)/i, '/__HOME__')
    .replace(/^\$env:USERPROFILE(?=[\\/]|$)/i, '/__HOME__')

  if (homeExpanded.startsWith('/__HOME__')) {
    return homeExpanded.replace(/\\/g, '/')
  }

  const realpathFn =
    typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync

  const resolved = path.resolve(trimmed)
  try {
    return realpathFn(resolved).replace(/\\/g, '/')
  } catch {
    const trailing: string[] = []
    let current = resolved
    while (true) {
      const parent = path.dirname(current)
      if (parent === current) {
        return resolved.replace(/\\/g, '/')
      }
      trailing.unshift(path.basename(current))
      current = parent
      if (existsSync(current)) {
        try {
          const ancestor = realpathFn(current)
          return path.join(ancestor, ...trailing).replace(/\\/g, '/')
        } catch {
          return resolved.replace(/\\/g, '/')
        }
      }
    }
  }
}

function matchSensitivePath(normalizedSlashPath: string): { pattern: string; reason: string } | null {
  if (!normalizedSlashPath) return null

  const lower = normalizedSlashPath.toLowerCase()
  const segments = lower.split('/').filter(Boolean)
  if (segments.length === 0) return null

  for (const seg of segments) {
    if (SENSITIVE_DIR_SEGMENTS.has(seg)) {
      return {
        pattern: seg,
        reason: `Access to sensitive credential directory "${seg}" is blocked by the Credential Fence.`,
      }
    }
  }

  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === '.config' && segments[i + 1] === 'gcloud') {
      return {
        pattern: '.config/gcloud',
        reason: 'Access to Google Cloud credentials under ".config/gcloud" is blocked by the Credential Fence.',
      }
    }
    if (segments[i] === '.docker' && segments[i + 1] === 'config.json') {
      return {
        pattern: '.docker/config.json',
        reason: 'Access to Docker registry credentials (".docker/config.json") is blocked by the Credential Fence.',
      }
    }
  }

  const basename = segments[segments.length - 1]

  if (SENSITIVE_EXACT_BASENAMES.has(basename)) {
    return {
      pattern: basename,
      reason: `Access to sensitive credential file "${basename}" is blocked by the Credential Fence.`,
    }
  }

  if (basename === '.env' || basename.startsWith('.env.')) {
    if (!SAFE_ENV_TEMPLATE_NAMES.has(basename)) {
      return {
        pattern: basename,
        reason: `Access to environment secret file "${basename}" is blocked by the Credential Fence.`,
      }
    }
  }

  for (const ext of SENSITIVE_KEY_EXTENSIONS) {
    if (basename.endsWith(ext) && basename.length > ext.length) {
      return {
        pattern: `*${ext}`,
        reason: `Access to private key or certificate file "${basename}" is blocked by the Credential Fence.`,
      }
    }
  }

  if (/credentials.*\.(json|ya?ml|ini)$/i.test(basename)) {
    return {
      pattern: '*credentials*.{json,yaml,yml,ini}',
      reason: `Access to credential file "${basename}" is blocked by the Credential Fence.`,
    }
  }

  if (/^service[-_]?account.*\.json$/i.test(basename)) {
    return {
      pattern: 'service-account*.json',
      reason: `Access to service account key "${basename}" is blocked by the Credential Fence.`,
    }
  }

  return null
}

function buildFenceFailure(pattern: string, reason: string): CredentialFenceResult {
  return {
    blocked: true,
    matchedPattern: pattern,
    reason,
    failure: {
      code: 'CREDENTIAL_FENCE_BLOCKED',
      message: reason,
      effectState: 'none',
      retry: 'after-input-change',
      nextAction:
        'Remove references to secret or credential paths from the command or target path. If access is genuinely required, adjust the Credential Fence setting in the Pulse Settings view.',
    },
  }
}

/**
 * Quote-aware shell tokenizer that extracts individual tokens while respecting
 * single quotes, double quotes, and backslash escapes.
 */
function tokenizeShellSegment(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let inToken = false

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]

    if (quote === "'") {
      if (ch === "'") {
        quote = null
      } else {
        current += ch
      }
      inToken = true
      continue
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null
      } else if (ch === '\\' && i + 1 < segment.length && ['"', '\\', '$', '`'].includes(segment[i + 1])) {
        current += segment[++i]
      } else {
        current += ch
      }
      inToken = true
      continue
    }

    if (ch === "'" || ch === '"') {
      quote = ch
      inToken = true
      continue
    }

    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current)
        current = ''
        inToken = false
      }
      continue
    }

    current += ch
    inToken = true
  }

  if (inToken) {
    tokens.push(current)
  }

  return tokens
}

/**
 * Splits a shell command string into individual subcommand segments on `;`, `&&`,
 * `||`, `|`, and newlines while respecting quotes and skipping heredoc bodies.
 */
function splitSubcommands(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let pendingHeredocDelimiter: string | null = null
  let activeHeredocDelimiter: string | null = null

  const lines = command.split(/\r?\n/)
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]

    if (activeHeredocDelimiter !== null) {
      if (line.trim() === activeHeredocDelimiter) {
        activeHeredocDelimiter = null
      }
      continue
    }

    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      const next = i + 1 < line.length ? line[i + 1] : ''

      if (quote === "'") {
        current += ch
        if (ch === "'") quote = null
        continue
      }

      if (quote === '"') {
        current += ch
        if (ch === '\\' && i + 1 < line.length) {
          current += line[++i]
        } else if (ch === '"') {
          quote = null
        }
        continue
      }

      if (ch === "'" || ch === '"') {
        quote = ch
        current += ch
        continue
      }

      // Detect heredoc operator `<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<-EOF` (not `<<<` here-string).
      if (ch === '<' && next === '<' && line[i + 2] !== '<') {
        const rest = line.slice(i + 2)
        const heredocMatch = /^-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_-]*))/.exec(rest)
        if (heredocMatch) {
          pendingHeredocDelimiter = heredocMatch[1] || heredocMatch[2] || heredocMatch[3] || null
        }
        current += ch
        continue
      }

      // Comment outside quotes.
      if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
        break
      }

      if (ch === ';') {
        if (current.trim()) segments.push(current.trim())
        current = ''
        continue
      }

      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
        if (current.trim()) segments.push(current.trim())
        current = ''
        i++
        continue
      }

      if (ch === '|') {
        if (current.trim()) segments.push(current.trim())
        current = ''
        continue
      }

      current += ch
    }

    if (quote === null) {
      if (current.trim()) segments.push(current.trim())
      current = ''
      if (pendingHeredocDelimiter !== null) {
        activeHeredocDelimiter = pendingHeredocDelimiter
        pendingHeredocDelimiter = null
      }
    } else {
      current += '\n'
    }
  }

  if (current.trim()) {
    segments.push(current.trim())
  }

  return segments
}

/**
 * Checks whether a target path or shell command attempts to access protected
 * credential stores, private keys, or environment secret files.
 */
export function checkCredentialFence(
  targetPath: string,
  commandText?: string,
): CredentialFenceResult {
  if (targetPath && targetPath.trim().length > 0) {
    const canonical = canonicalizePathForCheck(targetPath)
    const match = matchSensitivePath(canonical)
    if (match) {
      return buildFenceFailure(match.pattern, match.reason)
    }
  }

  if (commandText && commandText.trim().length > 0) {
    const segments = splitSubcommands(commandText)
    for (const seg of segments) {
      const tokens = tokenizeShellSegment(seg)
      for (const rawToken of tokens) {
        if (!rawToken) continue
        // Strip leading redirection operators (`<`, `>`, `>>`, `2>`) or `--flag=value` prefixes.
        const candidates: string[] = []
        const eqIdx = rawToken.indexOf('=')
        if (eqIdx > 0 && rawToken.startsWith('-')) {
          candidates.push(rawToken.slice(eqIdx + 1))
        }
        const stripped = rawToken.replace(/^[0-9]*[<>]+/, '')
        if (stripped) {
          candidates.push(stripped)
        }

        for (const candidate of candidates) {
          if (!candidate || candidate.startsWith('http://') || candidate.startsWith('https://')) {
            continue
          }
          // Normalize directly without resolving unrelated bare words against cwd unless path-like or exact sensitive name.
          const slashNorm = candidate
            .replace(/^~(?=[\\/]|$)/, '/__HOME__')
            .replace(/^\$HOME(?=[\\/]|$)/i, '/__HOME__')
            .replace(/^\$\{HOME\}(?=[\\/]|$)/i, '/__HOME__')
            .replace(/^%USERPROFILE%(?=[\\/]|$)/i, '/__HOME__')
            .replace(/^\$env:USERPROFILE(?=[\\/]|$)/i, '/__HOME__')
            .replace(/\\/g, '/')

          const directMatch = matchSensitivePath(slashNorm)
          if (directMatch) {
            return buildFenceFailure(directMatch.pattern, directMatch.reason)
          }
        }
      }
    }
  }

  return { blocked: false }
}

function isHelpInvocation(tokens: string[]): boolean {
  return tokens.some((t) => {
    const lower = t.toLowerCase()
    return lower === '--help' || lower === '-h' || lower === '-?' || lower === '/?'
  })
}

function isNullOutputTarget(target: string): boolean {
  const lower = target.trim().toLowerCase()
  return (
    lower === '-' ||
    lower === '/dev/null' ||
    lower === 'nul' ||
    lower === 'null' ||
    lower === '$null' ||
    lower === '&1' ||
    lower === '&2'
  )
}

function extractUrlFromTokens(tokens: string[]): string | undefined {
  for (const t of tokens) {
    if (/^https?:\/\/\S+/i.test(t) || /^ftp:\/\/\S+/i.test(t)) {
      return t
    }
  }
  return undefined
}

function inferFilenameFromUrl(url: string | undefined): string {
  if (!url) return 'output.bin'
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/').filter(Boolean)
    const last = parts[parts.length - 1]
    if (last && last.length <= 128) return last
  } catch {
    // Ignore malformed URLs.
  }
  return 'output.bin'
}

function extractRedirectTarget(segment: string): string | null {
  // Match top-level `>` or `>>` redirection outside quotes.
  let quote: "'" | '"' | null = null
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (ch === '\\') {
        i++
      } else if (ch === '"') {
        quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '>') {
      // Skip `2>` stderr-only redirections.
      const prev = i > 0 ? segment[i - 1] : ''
      if (prev === '2') continue
      let j = i + 1
      if (segment[j] === '>') j++
      while (j < segment.length && /\s/.test(segment[j])) j++
      const rest = segment.slice(j)
      const targetTokens = tokenizeShellSegment(rest)
      if (targetTokens.length > 0) {
        return targetTokens[0]
      }
    }
  }
  return null
}

function formatDownloadSuggestion(
  template: string,
  url: string | undefined,
  file: string | undefined,
): string {
  const safeUrl = url ?? '<url>'
  const safeFile = file ?? inferFilenameFromUrl(url)
  const trimmed = template.trim()
  if (trimmed.length > 0) {
    return trimmed
      .replace(/\{url\}/gi, safeUrl)
      .replace(/\{file\}/gi, safeFile)
  }
  return `Use your configured download tool to fetch ${safeUrl} into ${safeFile}, or disable the Download Guard in Pulse Settings if direct downloads are intended.`
}

function buildDownloadBlock(
  matchedTool: string,
  url: string | undefined,
  file: string | undefined,
  template: string,
): DownloadGuardResult {
  const suggestion = formatDownloadSuggestion(template, url, file)
  return {
    blocked: true,
    matchedTool,
    url,
    file,
    suggestion,
    failure: {
      code: 'DOWNLOAD_GUARD_BLOCKED',
      message: `Disk-writing download via "${matchedTool}" was blocked by the Download Guard.`,
      effectState: 'none',
      retry: 'after-input-change',
      nextAction: suggestion,
    },
  }
}

/**
 * Quote-aware guard that intercepts disk-writing CLI downloads (`curl`, `wget`,
 * `Invoke-WebRequest`/`Invoke-RestMethod`/`iwr`/`irm -OutFile`, `Start-BitsTransfer`)
 * when the opt-in Download Guard is enabled.
 */
export function checkDownloadGuard(
  command: string,
  _shell: string,
  template: string,
): DownloadGuardResult {
  if (!command || command.trim().length === 0) {
    return { blocked: false }
  }

  const segments = splitSubcommands(command)
  for (const segment of segments) {
    const tokens = tokenizeShellSegment(segment)
    if (tokens.length === 0 || isHelpInvocation(tokens)) {
      continue
    }

    // Skip leading env var assignments (`FOO=bar curl ...`) and wrappers (`env`, `command`, `sudo`, `&`).
    let cmdIdx = 0
    while (cmdIdx < tokens.length) {
      const tok = tokens[cmdIdx]
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok) || ['env', 'command', 'sudo', '&'].includes(tok.toLowerCase())) {
        cmdIdx++
      } else {
        break
      }
    }
    if (cmdIdx >= tokens.length) continue

    const rawCmd = tokens[cmdIdx]
    const cmdBase = path.basename(rawCmd.replace(/\\/g, '/')).toLowerCase()
    const args = tokens.slice(cmdIdx + 1)
    const url = extractUrlFromTokens(args)

    if (cmdBase === 'curl' || cmdBase === 'curl.exe') {
      let explicitOut: string | undefined
      let writesRemoteName = false

      for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if (a === '-o' || a === '--output') {
          explicitOut = args[i + 1] ?? ''
          i++
        } else if (a.startsWith('--output=')) {
          explicitOut = a.slice('--output='.length)
        } else if (a.startsWith('-o') && a.length > 2) {
          explicitOut = a.slice(2)
        } else if (
          a === '-O' ||
          a === '--remote-name' ||
          a === '--remote-name-all' ||
          (/^-[a-zA-Z]+$/.test(a) && a.includes('O'))
        ) {
          writesRemoteName = true
        }
      }

      if (explicitOut !== undefined) {
        if (!isNullOutputTarget(explicitOut)) {
          return buildDownloadBlock('curl', url, explicitOut, template)
        }
        continue
      }

      if (writesRemoteName) {
        return buildDownloadBlock('curl', url, inferFilenameFromUrl(url), template)
      }

      const redirectTarget = extractRedirectTarget(segment)
      if (redirectTarget && !isNullOutputTarget(redirectTarget)) {
        return buildDownloadBlock('curl', url, redirectTarget, template)
      }
      continue
    }

    if (cmdBase === 'wget' || cmdBase === 'wget.exe') {
      let stdoutMode = false
      let spiderMode = false
      let explicitOut: string | undefined

      for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if (a === '--spider') {
          spiderMode = true
        } else if (a === '-O-' || a === '--output-document=-') {
          stdoutMode = true
        } else if (a === '-O' || a === '--output-document') {
          const next = args[i + 1] ?? ''
          if (isNullOutputTarget(next)) {
            stdoutMode = true
          } else {
            explicitOut = next
          }
          i++
        } else if (a.startsWith('--output-document=')) {
          const val = a.slice('--output-document='.length)
          if (isNullOutputTarget(val)) {
            stdoutMode = true
          } else {
            explicitOut = val
          }
        } else if (/^-[a-zA-Z]*O-$/.test(a)) {
          stdoutMode = true
        } else if (/^-[a-zA-Z]*O$/.test(a)) {
          const next = args[i + 1] ?? ''
          if (isNullOutputTarget(next)) {
            stdoutMode = true
          } else {
            explicitOut = next
          }
          i++
        }
      }

      if (spiderMode || stdoutMode) {
        continue
      }

      if (url || explicitOut) {
        return buildDownloadBlock('wget', url, explicitOut ?? inferFilenameFromUrl(url), template)
      }
      continue
    }

    if (
      cmdBase === 'invoke-webrequest' ||
      cmdBase === 'invoke-restmethod' ||
      cmdBase === 'iwr' ||
      cmdBase === 'irm'
    ) {
      let outFile: string | undefined
      for (let i = 0; i < args.length; i++) {
        const lower = args[i].toLowerCase()
        if (lower === '-outfile' || lower === '-o') {
          outFile = args[i + 1] ?? ''
          i++
        } else if (lower.startsWith('-outfile:')) {
          outFile = args[i].slice('-outfile:'.length)
        }
      }
      if (outFile && !isNullOutputTarget(outFile)) {
        return buildDownloadBlock(rawCmd, url, outFile, template)
      }
      continue
    }

    if (cmdBase === 'start-bitstransfer') {
      let dest: string | undefined
      for (let i = 0; i < args.length; i++) {
        const lower = args[i].toLowerCase()
        if (lower === '-destination') {
          dest = args[i + 1] ?? ''
          i++
        } else if (lower.startsWith('-destination:')) {
          dest = args[i].slice('-destination:'.length)
        }
      }
      if (dest && !isNullOutputTarget(dest)) {
        return buildDownloadBlock(rawCmd, url, dest, template)
      }
    }
  }

  return { blocked: false }
}

function parseSleepSeconds(rawValue: string): number | null {
  const trimmed = rawValue.trim().toLowerCase()
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/.exec(trimmed)
  if (!match) return null
  const amount = Number.parseFloat(match[1])
  if (!Number.isFinite(amount)) return null
  const unit = match[2] ?? 's'
  if (unit === 's') return amount
  if (unit === 'm') return amount * 60
  if (unit === 'h') return amount * 3600
  if (unit === 'd') return amount * 86400
  return amount
}

const SLEEP_POLLING_GUIDANCE =
  'Avoid sleep-based polling for background jobs. Use pulse_job({ action: "output", job_id: "<id>", wait: true }) to wait efficiently until new output arrives or the job completes.'

/**
 * Detects standalone `sleep >= 20` or PowerShell `Start-Sleep >= 20` polling commands
 * and returns a `pulse_job` nudge.
 */
export function detectSleepPolling(command: string): string | null {
  if (!command || command.trim().length === 0) return null

  const segments = splitSubcommands(command)
  if (segments.length !== 1) return null

  const tokens = tokenizeShellSegment(segments[0])
  if (tokens.length < 2) return null

  const cmd = path.basename(tokens[0].replace(/\\/g, '/')).toLowerCase()

  if (cmd === 'sleep') {
    let totalSeconds = 0
    for (let i = 1; i < tokens.length; i++) {
      const secs = parseSleepSeconds(tokens[i])
      if (secs === null) return null
      totalSeconds += secs
    }
    return totalSeconds >= 20 ? SLEEP_POLLING_GUIDANCE : null
  }

  if (cmd === 'start-sleep') {
    for (let i = 1; i < tokens.length; i++) {
      const lower = tokens[i].toLowerCase()
      if (lower === '-seconds' || lower === '-s') {
        const val = Number.parseFloat(tokens[i + 1] ?? '')
        if (Number.isFinite(val) && val >= 20) return SLEEP_POLLING_GUIDANCE
        return null
      }
      if (lower === '-milliseconds' || lower === '-m') {
        const val = Number.parseFloat(tokens[i + 1] ?? '')
        if (Number.isFinite(val) && val >= 20_000) return SLEEP_POLLING_GUIDANCE
        return null
      }
      if (!lower.startsWith('-')) {
        const val = Number.parseFloat(lower)
        if (Number.isFinite(val) && val >= 20) return SLEEP_POLLING_GUIDANCE
        return null
      }
    }
  }

  if (cmd === 'timeout' || cmd === 'timeout.exe') {
    for (let i = 1; i < tokens.length; i++) {
      const lower = tokens[i].toLowerCase()
      if (lower === '/t') {
        const val = Number.parseFloat(tokens[i + 1] ?? '')
        if (Number.isFinite(val) && val >= 20) return SLEEP_POLLING_GUIDANCE
      }
    }
  }

  return null
}
