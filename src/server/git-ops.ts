import { execFile, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { checkCredentialFence } from '../shared/guards.ts'
import type { FailureInfo } from '../shared/types.ts'
import type { SpillStore } from './spill-store.ts'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 15_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
const DEFAULT_MAX_HUNK_LINES = 120
const MIN_MAX_HUNK_LINES = 10
const MAX_MAX_HUNK_LINES = 2_000

const NOISY_LOCKFILE_BASENAMES = new Set([
  'package-lock.json',
  'cargo.lock',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'poetry.lock',
  'composer.lock',
])

const NOISY_ARTIFACT_SUFFIXES = ['.min.js', '.min.css', '.map']

const SAFE_GIT_REF_RE = /^[a-zA-Z0-9._/@^~:-]+$/

export interface GitStatusOptions {
  path?: string
  glob?: string[]
  includeLockfiles?: boolean
  maxInlineBytes: number
  credentialFence?: boolean
  spillStore?: SpillStore
  sessionId?: string
}

export interface GitDiffOptions {
  path?: string
  glob?: string[]
  staged?: boolean
  baseRef?: string
  includeLockfiles?: boolean
  maxHunkLines?: number
  maxInlineBytes: number
  credentialFence?: boolean
  spillStore?: SpillStore
  sessionId?: string
}

export interface GitOpSuccess {
  ok: true
  root: string
  gitBranch: string
  gitDirtyFiles: number
  gitSkippedLockfiles: string[]
  gitText: string
  truncated: boolean
  rawBytes: number
  deliveredBytes: number
  gitCompactSavedBytes: number
  spillSavedBytes: number
  savedBytes: number
  refId?: string
  spillPath?: string
}

export interface GitOpFailure {
  ok: false
  failure: FailureInfo
}

export type GitOpResult = GitOpSuccess | GitOpFailure

interface NumstatEntry {
  added: number
  deleted: number
  binary: boolean
  filePath: string
}

function buildGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: '1',
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    LC_MESSAGES: 'C',
    GIT_TERMINAL_PROMPT: '0',
  }
}

export function isNoisyLockOrArtifact(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').trim()
  if (!normalized) return false
  const lower = normalized.toLowerCase()
  const base = path.posix.basename(lower)
  if (NOISY_LOCKFILE_BASENAMES.has(base)) {
    return true
  }
  for (const suffix of NOISY_ARTIFACT_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return true
    }
  }
  return false
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) {
    return { text, truncated: false }
  }
  const buf = Buffer.from(text, 'utf-8')
  let end = Math.max(0, maxBytes)
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--
  }
  let sliced = buf.subarray(0, end).toString('utf-8')
  if (sliced.endsWith('\uFFFD') && !text.startsWith(sliced)) {
    sliced = sliced.slice(0, -1)
  }
  return { text: sliced, truncated: true }
}

function normalizeGitError(err: unknown, cwd: string): FailureInfo {
  const e = err as {
    code?: string | number
    killed?: boolean
    signal?: string
    stderr?: string
    message?: string
  }
  const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : ''
  const msg = stderr || (typeof e?.message === 'string' ? e.message : String(err))

  if (e?.code === 'ENOENT') {
    return {
      code: 'GIT_UNAVAILABLE',
      message: 'Git executable was not found on PATH.',
      effectState: 'none',
      retry: 'never',
      nextAction: 'Install Git and ensure the git binary is available on PATH.',
    }
  }

  if (e?.killed || e?.signal === 'SIGTERM' || /timed out/i.test(msg)) {
    return {
      code: 'GIT_TIMEOUT',
      message: `Git command exceeded the ${GIT_TIMEOUT_MS} ms timeout in "${cwd}".`,
      effectState: 'none',
      retry: 'after-input-change',
      nextAction: 'Narrow the target path or glob filter before retrying.',
    }
  }

  if (/not a git repository/i.test(msg)) {
    return {
      code: 'NOT_A_GIT_REPO',
      message: `Directory "${cwd}" is not inside a Git repository.`,
      effectState: 'none',
      retry: 'after-input-change',
      nextAction: 'Pass a path inside a Git repository or run git init first.',
    }
  }

  if (/unknown revision|bad revision|ambiguous argument/i.test(msg)) {
    return {
      code: 'INVALID_GIT_REF',
      message: `Invalid Git reference: ${msg}`,
      effectState: 'none',
      retry: 'after-input-change',
      nextAction: 'Verify the baseRef commit, branch, or tag name and retry.',
    }
  }

  return {
    code: 'GIT_COMMAND_FAILED',
    message: msg || 'Git command failed.',
    effectState: 'none',
    retry: 'after-input-change',
    nextAction: 'Inspect the repository state and parameters before retrying.',
  }
}

async function execGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    env: buildGitEnv(),
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  })
  return stdout
}

/**
 * Counts exact stdout byte length of a git command via streaming without buffering
 * megabytes of skipped lockfile diffs in memory.
 */
async function measureGitStdoutBytes(cwd: string, args: string[]): Promise<number> {
  return new Promise<number>((resolve) => {
    let totalBytes = 0
    let settled = false
    const child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      env: buildGitEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(totalBytes)
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Ignore already-closed child.
      }
      finish()
    }, GIT_TIMEOUT_MS)
    timer.unref()

    child.stdout?.on('data', (chunk: Buffer | string) => {
      totalBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, 'utf-8')
    })
    child.on('error', finish)
    child.on('close', finish)
  })
}

function sanitizeGlobPathspecs(globs?: string[]): string[] {
  if (!Array.isArray(globs)) return []
  const result: string[] = []
  for (const g of globs) {
    if (typeof g !== 'string') continue
    const trimmed = g.trim()
    if (!trimmed || trimmed.includes('\0')) continue
    // Prevent pathspec option confusion if a glob starts with a dash.
    if (trimmed.startsWith('-')) continue
    if (trimmed.startsWith('!')) {
      const inner = trimmed.slice(1).trim()
      if (inner) result.push(`:(exclude,glob)${inner}`)
    } else if (trimmed.startsWith(':(')) {
      result.push(trimmed)
    } else {
      result.push(`:(glob)${trimmed}`)
    }
  }
  return result
}

function resolveGitTarget(root: string, subPath?: string): { cwd: string; pathFilter?: string } {
  const target = subPath ? path.resolve(root, subPath) : path.resolve(root)
  try {
    if (existsSync(target) && statSync(target).isFile()) {
      return {
        cwd: path.dirname(target),
        pathFilter: path.basename(target),
      }
    }
  } catch {
    // Fall through to directory assumption.
  }
  return { cwd: target }
}

function parseBranchHeader(headerLine: string): string {
  const rest = headerLine.replace(/^##\s*/, '').trim()
  if (!rest) return 'HEAD'
  const noCommits = /^No commits yet on\s+(.+)$/i.exec(rest)
  if (noCommits) return noCommits[1].trim()
  const initial = /^Initial commit on\s+(.+)$/i.exec(rest)
  if (initial) return initial[1].trim()
  return rest
}

function extractStatusFilePath(porcelainLine: string): string {
  // Porcelain v1 format: `XY path` or `XY old -> new`
  const body = porcelainLine.slice(3).trim()
  const arrowIdx = body.lastIndexOf(' -> ')
  const raw = arrowIdx >= 0 ? body.slice(arrowIdx + 4).trim() : body
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1)
  }
  return raw
}

function formatByteCount(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

/**
 * Runs a compact, lockfile-aware `git status` inside the authorized workspace directory.
 */
export async function runGitStatus(
  root: string,
  options: GitStatusOptions,
): Promise<GitOpResult> {
  const { cwd, pathFilter } = resolveGitTarget(root, options.path)
  const includeLockfiles = Boolean(options.includeLockfiles)
  const maxInlineBytes = Math.max(512, options.maxInlineBytes)

  const pathspecs: string[] = []
  if (pathFilter) pathspecs.push(pathFilter)
  pathspecs.push(...sanitizeGlobPathspecs(options.glob))

  const args = ['status', '--porcelain=v1', '-b']
  if (pathspecs.length > 0) {
    args.push('--', ...pathspecs)
  }

  let porcelainOut: string
  try {
    porcelainOut = await execGit(cwd, args)
  } catch (err) {
    return { ok: false, failure: normalizeGitError(err, cwd) }
  }

  const rawPorcelainBytes = Buffer.byteLength(porcelainOut, 'utf-8')
  const rawLines = porcelainOut
    .split(/\r?\n/)
    .filter((line) => line.length > 0)

  let gitBranch = 'HEAD'
  const entryLines: string[] = []

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]
    if (i === 0 && line.startsWith('## ')) {
      gitBranch = parseBranchHeader(line)
      continue
    }
    entryLines.push(line)
  }

  const keptLines: string[] = []
  const skippedLockfiles: string[] = []
  const redactedFiles: string[] = []
  const credentialFence = options.credentialFence !== false
  let stagedCount = 0
  let unstagedCount = 0
  let untrackedCount = 0

  for (const line of entryLines) {
    const x = line[0] ?? ' '
    const y = line[1] ?? ' '
    if (x === '?' && y === '?') {
      untrackedCount++
    } else {
      if (x !== ' ' && x !== '?') stagedCount++
      if (y !== ' ' && y !== '?') unstagedCount++
    }

    const filePath = extractStatusFilePath(line)
    if (credentialFence && checkCredentialFence(filePath).blocked) {
      redactedFiles.push(filePath)
      continue
    }
    if (!includeLockfiles && isNoisyLockOrArtifact(filePath)) {
      skippedLockfiles.push(filePath)
      continue
    }
    keptLines.push(line)
  }

  const gitDirtyFiles = entryLines.length
  const outLines: string[] = []
  outLines.push(`branch: ${gitBranch}`)

  if (gitDirtyFiles === 0) {
    outLines.push('clean working tree (0 dirty files)')
  } else {
    const counts: string[] = []
    if (stagedCount > 0) counts.push(`staged=${stagedCount}`)
    if (unstagedCount > 0) counts.push(`modified=${unstagedCount}`)
    if (untrackedCount > 0) counts.push(`untracked=${untrackedCount}`)
    const detail = counts.length > 0 ? ` (${counts.join(', ')})` : ''
    outLines.push(`dirty: ${gitDirtyFiles} file(s)${detail}`)
    outLines.push(...keptLines)
    if (skippedLockfiles.length > 0) {
      const shown = skippedLockfiles.slice(0, 8).join(', ')
      const more = skippedLockfiles.length > 8 ? ` +${skippedLockfiles.length - 8} more` : ''
      outLines.push(`[skipped ${skippedLockfiles.length} lockfile/artifact(s): ${shown}${more}]`)
    }
    if (redactedFiles.length > 0) {
      outLines.push(`[redacted ${redactedFiles.length} credential-fenced file(s)]`)
    }
  }

  const compactText = outLines.join('\n')
  const preSpillBytes = Buffer.byteLength(compactText, 'utf-8')
  let gitText = compactText
  let truncated = false
  let refId: string | undefined
  let spillPath: string | undefined
  let spillSavedBytes = 0

  if (preSpillBytes > maxInlineBytes) {
    if (options.spillStore) {
      try {
        const saved = options.spillStore.save({
          stdout: compactText,
          stderr: '',
          meta: {
            tool: 'pulse_search',
            action: 'git_status',
            description: `Git status (${gitBranch})`,
            root: cwd,
            sessionId: options.sessionId,
          },
        })
        refId = saved.refId
        spillPath = saved.spillPath
      } catch {
        // Non-fatal spill failure; still apply inline ceiling.
      }
    }

    const clipped = truncateUtf8(compactText, maxInlineBytes)
    gitText = clipped.truncated
      ? `${clipped.text}\n...[truncated inline; page full output via pulse_result]`
      : clipped.text
    truncated = true
    const deliveredAfterSpill = Buffer.byteLength(gitText, 'utf-8')
    spillSavedBytes = Math.max(0, preSpillBytes - deliveredAfterSpill)
  }

  const deliveredBytes = Buffer.byteLength(gitText, 'utf-8')
  const gitCompactSavedBytes = Math.max(0, rawPorcelainBytes - preSpillBytes)
  const savedBytes = gitCompactSavedBytes + spillSavedBytes
  const rawBytes = deliveredBytes + savedBytes

  return {
    ok: true,
    root: cwd,
    gitBranch,
    gitDirtyFiles,
    gitSkippedLockfiles: skippedLockfiles,
    gitText,
    truncated,
    rawBytes,
    deliveredBytes,
    gitCompactSavedBytes,
    spillSavedBytes,
    savedBytes,
    refId,
    spillPath,
  }
}

function parseNumstatOutput(output: string): NumstatEntry[] {
  const entries: NumstatEntry[] = []
  const lines = output.split(/\r?\n/).filter((l) => l.length > 0)
  for (const line of lines) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const rawAdded = parts[0]
    const rawDeleted = parts[1]
    const filePath = parts.slice(2).join('\t').trim()
    if (!filePath) continue
    const binary = rawAdded === '-' || rawDeleted === '-'
    entries.push({
      added: binary ? 0 : Number.parseInt(rawAdded, 10) || 0,
      deleted: binary ? 0 : Number.parseInt(rawDeleted, 10) || 0,
      binary,
      filePath,
    })
  }
  return entries
}

function normalizeRenamePath(numstatPath: string): string {
  // Handle git numstat rename syntax like `dir/{old.ts => new.ts}` or `old.ts => new.ts`.
  const braceMatch = /^(.*)\{.* => (.*)\}(.*)$/.exec(numstatPath)
  if (braceMatch) {
    return `${braceMatch[1]}${braceMatch[2]}${braceMatch[3]}`.replace(/\/+/g, '/')
  }
  const arrowIdx = numstatPath.indexOf(' => ')
  if (arrowIdx >= 0) {
    return numstatPath.slice(arrowIdx + 4).trim()
  }
  return numstatPath
}

function compactifyUnifiedDiff(
  rawDiff: string,
  numstatByPath: Map<string, NumstatEntry>,
  maxHunkLines: number,
): { text: string; truncatedAnyFile: boolean } {
  if (!rawDiff.trim()) {
    return { text: '', truncatedAnyFile: false }
  }

  const sections: string[] = []
  const lines = rawDiff.split(/\r?\n/)
  let current: string[] = []

  for (const line of lines) {
    if (line.startsWith('diff --git ') && current.length > 0) {
      sections.push(current.join('\n'))
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) {
    sections.push(current.join('\n'))
  }

  const renderedSections: string[] = []
  let truncatedAnyFile = false

  for (const section of sections) {
    const secLines = section.split('\n')
    const headerLine = secLines[0] ?? ''
    let filePath = ''
    const gitHeaderMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(headerLine)
    if (gitHeaderMatch) {
      filePath = gitHeaderMatch[2]
    }

    const stats = filePath ? numstatByPath.get(filePath) : undefined
    const statTag = stats
      ? stats.binary
        ? ' (binary)'
        : ` (+${stats.added}/-${stats.deleted})`
      : ''

    const bodyLines: string[] = []
    let isBinaryFile = false
    for (let i = 1; i < secLines.length; i++) {
      const l = secLines[i]
      // Strip redundant git header lines that repeat the path or commit hashes.
      if (
        l.startsWith('index ') ||
        l.startsWith('--- a/') ||
        l.startsWith('+++ b/') ||
        l === '--- /dev/null' ||
        l === '+++ /dev/null'
      ) {
        continue
      }
      if (l.startsWith('Binary files ') || l === 'GIT binary patch') {
        isBinaryFile = true
        bodyLines.push(l)
        continue
      }
      if (
        l.startsWith('new file mode ') ||
        l.startsWith('deleted file mode ') ||
        l.startsWith('rename from ') ||
        l.startsWith('rename to ')
      ) {
        bodyLines.push(l)
        continue
      }
      bodyLines.push(l)
    }

    const compactHeader = `=== ${filePath || headerLine}${statTag} ===`
    if (isBinaryFile && bodyLines.length <= 2) {
      renderedSections.push(`${compactHeader}\n[binary file changed]`)
      continue
    }

    if (bodyLines.length > maxHunkLines) {
      truncatedAnyFile = true
      const kept = bodyLines.slice(0, maxHunkLines)
      const omitted = bodyLines.length - maxHunkLines
      renderedSections.push(
        `${compactHeader}\n${kept.join('\n')}\n...[+${omitted} more diff line(s) in ${filePath || 'file'} omitted by maxHunkLines=${maxHunkLines}]`,
      )
    } else {
      renderedSections.push(`${compactHeader}\n${bodyLines.join('\n')}`)
    }
  }

  return {
    text: renderedSections.join('\n\n'),
    truncatedAnyFile,
  }
}

/**
 * Runs a compact, lockfile-filtered `git diff` inside the authorized workspace directory,
 * measuring exact raw bytes avoided from skipped lockfiles, stripped metadata, hunk caps, and spillover.
 */
export async function runGitDiff(
  root: string,
  options: GitDiffOptions,
): Promise<GitOpResult> {
  const { cwd, pathFilter } = resolveGitTarget(root, options.path)
  const includeLockfiles = Boolean(options.includeLockfiles)
  const credentialFence = options.credentialFence !== false
  const maxInlineBytes = Math.max(512, options.maxInlineBytes)
  const maxHunkLines = Math.max(
    MIN_MAX_HUNK_LINES,
    Math.min(
      MAX_MAX_HUNK_LINES,
      Math.floor(
        typeof options.maxHunkLines === 'number' && Number.isFinite(options.maxHunkLines)
          ? options.maxHunkLines
          : DEFAULT_MAX_HUNK_LINES,
      ),
    ),
  )

  const baseRef = typeof options.baseRef === 'string' ? options.baseRef.trim() : ''
  if (baseRef) {
    if (baseRef.startsWith('-') || !SAFE_GIT_REF_RE.test(baseRef)) {
      return {
        ok: false,
        failure: {
          code: 'INVALID_ARGUMENT',
          message: `Invalid baseRef "${baseRef}". References must not start with "-" or contain shell/control characters.`,
          effectState: 'none',
          retry: 'after-input-change',
          nextAction: 'Provide a valid Git branch, tag, or commit ref (for example, "HEAD~1" or "main").',
        },
      }
    }
  }

  const pathspecs: string[] = []
  if (pathFilter) pathspecs.push(pathFilter)
  pathspecs.push(...sanitizeGlobPathspecs(options.glob))

  const baseDiffArgs = ['diff', '--no-color', '--no-ext-diff']
  if (options.staged) baseDiffArgs.push('--cached')
  if (baseRef) baseDiffArgs.push(baseRef)

  const numstatArgs = [...baseDiffArgs, '--numstat']
  if (pathspecs.length > 0) numstatArgs.push('--', ...pathspecs)

  let numstatOut: string
  let gitBranch = 'HEAD'
  try {
    const [ns, br] = await Promise.all([
      execGit(cwd, numstatArgs),
      execGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD'),
    ])
    numstatOut = ns
    gitBranch = br.trim() || 'HEAD'
  } catch (err) {
    return { ok: false, failure: normalizeGitError(err, cwd) }
  }

  const numstatEntries = parseNumstatOutput(numstatOut)
  const gitDirtyFiles = numstatEntries.length
  const scopeLabel = [
    options.staged ? 'staged' : 'working-tree',
    baseRef ? `base=${baseRef}` : '',
  ]
    .filter(Boolean)
    .join(', ')

  if (gitDirtyFiles === 0) {
    const gitText = `branch: ${gitBranch} | git diff (${scopeLabel}): no changes`
    const bytes = Buffer.byteLength(gitText, 'utf-8')
    return {
      ok: true,
      root: cwd,
      gitBranch,
      gitDirtyFiles: 0,
      gitSkippedLockfiles: [],
      gitText,
      truncated: false,
      rawBytes: bytes,
      deliveredBytes: bytes,
      gitCompactSavedBytes: 0,
      spillSavedBytes: 0,
      savedBytes: 0,
    }
  }

  // Resolve repository toplevel so path filters for excluded/kept files match git numstat paths.
  let repoTopLevel = cwd
  try {
    repoTopLevel = (await execGit(cwd, ['rev-parse', '--show-toplevel'])).trim() || cwd
  } catch {
    repoTopLevel = cwd
  }

  const keptPaths: string[] = []
  const skippedLockfiles: string[] = []
  const redactedFiles: string[] = []
  const numstatByPath = new Map<string, NumstatEntry>()
  let totalAdded = 0
  let totalDeleted = 0

  for (const entry of numstatEntries) {
    const cleanPath = normalizeRenamePath(entry.filePath)
    numstatByPath.set(cleanPath, entry)

    if (credentialFence && checkCredentialFence(cleanPath).blocked) {
      redactedFiles.push(cleanPath)
      continue
    }
    if (!includeLockfiles && isNoisyLockOrArtifact(cleanPath)) {
      skippedLockfiles.push(cleanPath)
      continue
    }
    totalAdded += entry.added
    totalDeleted += entry.deleted
    keptPaths.push(cleanPath)
  }

  const hasExclusions = skippedLockfiles.length > 0 || redactedFiles.length > 0

  let keptDiffRaw = ''
  let skippedRawBytes = 0

  try {
    const keptPromise =
      keptPaths.length > 0
        ? hasExclusions
          ? execGit(repoTopLevel, [...baseDiffArgs, '--unified=3', '--', ...keptPaths])
          : execGit(
              cwd,
              pathspecs.length > 0
                ? [...baseDiffArgs, '--unified=3', '--', ...pathspecs]
                : [...baseDiffArgs, '--unified=3'],
            )
        : Promise.resolve('')

    const skippedPromise =
      skippedLockfiles.length > 0
        ? measureGitStdoutBytes(repoTopLevel, [
            ...baseDiffArgs,
            '--unified=3',
            '--',
            ...skippedLockfiles,
          ])
        : Promise.resolve(0)

    ;[keptDiffRaw, skippedRawBytes] = await Promise.all([keptPromise, skippedPromise])
  } catch (err) {
    return { ok: false, failure: normalizeGitError(err, cwd) }
  }

  const rawKeptBytes = Buffer.byteLength(keptDiffRaw, 'utf-8')
  const rawUnfilteredBytes = rawKeptBytes + skippedRawBytes

  const { text: compactBody, truncatedAnyFile } = compactifyUnifiedDiff(
    keptDiffRaw,
    numstatByPath,
    maxHunkLines,
  )

  const headerLines: string[] = [
    `branch: ${gitBranch} | git diff (${scopeLabel}): ${keptPaths.length} file(s) shown (+${totalAdded}/-${totalDeleted})`,
  ]
  if (skippedLockfiles.length > 0) {
    const shown = skippedLockfiles.slice(0, 8).join(', ')
    const more = skippedLockfiles.length > 8 ? ` +${skippedLockfiles.length - 8} more` : ''
    const avoidedNote = skippedRawBytes > 0 ? ` (${formatByteCount(skippedRawBytes)} avoided)` : ''
    headerLines.push(
      `[skipped ${skippedLockfiles.length} lockfile/artifact(s): ${shown}${more}${avoidedNote}]`,
    )
  }
  if (redactedFiles.length > 0) {
    headerLines.push(`[redacted ${redactedFiles.length} credential-fenced file(s)]`)
  }

  const compactText = compactBody
    ? `${headerLines.join('\n')}\n\n${compactBody}`
    : headerLines.join('\n')
  const preSpillBytes = Buffer.byteLength(compactText, 'utf-8')

  let gitText = compactText
  let truncated = truncatedAnyFile
  let refId: string | undefined
  let spillPath: string | undefined
  let spillSavedBytes = 0

  if (preSpillBytes > maxInlineBytes) {
    if (options.spillStore) {
      try {
        const spillSource = keptDiffRaw || compactText
        const saved = options.spillStore.save({
          stdout: spillSource,
          stderr: '',
          meta: {
            tool: 'pulse_search',
            action: 'git_diff',
            description: `Git diff (${scopeLabel})`,
            root: cwd,
            branch: gitBranch,
            sessionId: options.sessionId,
          },
        })
        refId = saved.refId
        spillPath = saved.spillPath
      } catch {
        // Non-fatal spill error; still enforce inline cap below.
      }
    }

    const clipped = truncateUtf8(compactText, maxInlineBytes)
    gitText = clipped.truncated
      ? `${clipped.text}\n...[truncated inline; page full diff via pulse_result]`
      : clipped.text
    truncated = true
    const postSpillBytes = Buffer.byteLength(gitText, 'utf-8')
    spillSavedBytes = Math.max(0, preSpillBytes - postSpillBytes)
  }

  const deliveredBytes = Buffer.byteLength(gitText, 'utf-8')
  const gitCompactSavedBytes = Math.max(0, rawUnfilteredBytes - preSpillBytes)
  const savedBytes = gitCompactSavedBytes + spillSavedBytes
  const rawBytes = deliveredBytes + savedBytes

  return {
    ok: true,
    root: cwd,
    gitBranch,
    gitDirtyFiles,
    gitSkippedLockfiles: skippedLockfiles,
    gitText,
    truncated,
    rawBytes,
    deliveredBytes,
    gitCompactSavedBytes,
    spillSavedBytes,
    savedBytes,
    refId,
    spillPath,
  }
}
