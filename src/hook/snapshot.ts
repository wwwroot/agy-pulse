import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const DEFAULT_MAX_BYTES = 1_500
const DEFAULT_SCAN_TIMEOUT_MS = 250
const DEFAULT_GIT_TIMEOUT_MS = 220

const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  'coverage',
  '.idea',
  '.vscode',
])

export interface SnapshotOptions {
  maxBytes?: number
  scanTimeoutMs?: number
  gitTimeoutMs?: number
}

function isHomeOrSystemRoot(dirPath: string): boolean {
  const resolved = path.resolve(dirPath)
  const parsed = path.parse(resolved)
  if (resolved === parsed.root) return true
  const home = homedir()
  if (home && path.resolve(home).toLowerCase() === resolved.toLowerCase()) {
    return true
  }
  const lower = resolved.replace(/\\/g, '/').toLowerCase()
  if (
    lower === '/etc' ||
    lower === '/usr' ||
    lower === '/var' ||
    lower === '/tmp' ||
    lower === 'c:/windows' ||
    lower === 'c:/program files' ||
    lower === 'c:/program files (x86)'
  ) {
    return true
  }
  return false
}

function runGitReadOnly(cwd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'diff.external=',
        ...args,
      ],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
        },
      },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        resolve(typeof stdout === 'string' ? stdout.trim() : null)
      },
    )
    child.unref?.()
  })
}

async function readManifestSummary(rootDir: string): Promise<string[]> {
  const notes: string[] = []

  try {
    const raw = await fs.readFile(path.join(rootDir, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { name?: unknown; scripts?: Record<string, unknown> }
    const name = typeof pkg.name === 'string' ? pkg.name : ''
    const scripts =
      pkg.scripts && typeof pkg.scripts === 'object'
        ? Object.keys(pkg.scripts).slice(0, 8)
        : []
    const scriptStr = scripts.length > 0 ? ` scripts=[${scripts.join(', ')}]` : ''
    notes.push(`node${name ? `(${name})` : ''}${scriptStr}`)
  } catch {
    // Optional manifest.
  }

  try {
    const raw = await fs.readFile(path.join(rootDir, 'Cargo.toml'), 'utf8')
    const isWorkspace = /\[workspace\]/.test(raw)
    const nameMatch = /^\s*name\s*=\s*"([^"]+)"/m.exec(raw)
    notes.push(`rust${nameMatch ? `(${nameMatch[1]})` : isWorkspace ? '(workspace)' : ''}`)
  } catch {
    // Optional manifest.
  }

  try {
    await fs.access(path.join(rootDir, 'pyproject.toml'))
    notes.push('python(pyproject)')
  } catch {
    // Optional manifest.
  }

  try {
    const raw = await fs.readFile(path.join(rootDir, 'go.mod'), 'utf8')
    const modMatch = /^module\s+(\S+)/m.exec(raw)
    notes.push(`go${modMatch ? `(${modMatch[1]})` : ''}`)
  } catch {
    // Optional manifest.
  }

  return notes
}

async function collectTwoLevelLayout(rootDir: string, deadlineAt: number): Promise<string[]> {
  if (Date.now() >= deadlineAt) return []
  let topEntries
  try {
    topEntries = await fs.readdir(rootDir, { withFileTypes: true })
  } catch {
    return []
  }

  const dirs: string[] = []
  const files: string[] = []
  for (const ent of topEntries) {
    const name = ent.name
    if (SKIP_DIRS.has(name)) continue
    if (ent.isDirectory()) {
      dirs.push(name)
    } else if (ent.isFile()) {
      files.push(name)
    }
  }
  dirs.sort((a, b) => a.localeCompare(b))
  files.sort((a, b) => a.localeCompare(b))

  const lines: string[] = []
  const maxDirs = 12
  for (const dirName of dirs.slice(0, maxDirs)) {
    if (Date.now() >= deadlineAt) break
    let childPreview = ''
    try {
      const subEntries = await fs.readdir(path.join(rootDir, dirName), { withFileTypes: true })
      const children = subEntries
        .filter((e) => !SKIP_DIRS.has(e.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort((a, b) => a.localeCompare(b))
      if (children.length > 0) {
        const shown = children.slice(0, 6).join(', ')
        const more = children.length > 6 ? `, +${children.length - 6}` : ''
        childPreview = ` (${shown}${more})`
      }
    } catch {
      // Ignore unreadable subdirectory.
    }
    lines.push(`  ${dirName}/${childPreview}`)
  }
  if (dirs.length > maxDirs) {
    lines.push(`  ... +${dirs.length - maxDirs} more dir(s)`)
  }
  if (files.length > 0) {
    const shown = files.slice(0, 10).join(', ')
    const more = files.length > 10 ? `, +${files.length - 10}` : ''
    lines.push(`  files: ${shown}${more}`)
  }

  return lines
}

function capUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const suffix = '\n...[snapshot capped]'
  const budget = Math.max(32, maxBytes - Buffer.byteLength(suffix, 'utf8'))
  const buf = Buffer.from(text, 'utf8')
  let end = Math.min(buf.length, budget)
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1
  }
  let sliced = buf.subarray(0, end).toString('utf8')
  if (sliced.endsWith('\uFFFD')) {
    sliced = sliced.slice(0, -1)
  }
  return `${sliced}${suffix}`
}

/**
 * Builds a compact (<1.5 KB) workspace orientation snapshot within a 250 ms scan
 * deadline for injection on Antigravity `SessionStart`.
 */
export async function buildWorkspaceSnapshot(
  workspaceDir: string,
  options: SnapshotOptions = {},
): Promise<string | null> {
  const trimmed = workspaceDir?.trim()
  if (!trimmed || isHomeOrSystemRoot(trimmed)) {
    return null
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const scanTimeoutMs = options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS
  const gitTimeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  const deadlineAt = Date.now() + scanTimeoutMs

  try {
    const st = await fs.stat(trimmed)
    if (!st.isDirectory()) return null
  } catch {
    return null
  }

  const workPromise = (async (): Promise<string | null> => {
    const [manifests, layoutLines, gitStatus, gitLog] = await Promise.all([
      readManifestSummary(trimmed),
      collectTwoLevelLayout(trimmed, deadlineAt),
      runGitReadOnly(trimmed, ['status', '--porcelain=v1', '-b'], gitTimeoutMs),
      runGitReadOnly(trimmed, ['log', '-n', '3', '--pretty=format:%h %s'], gitTimeoutMs),
    ])

    const parts: string[] = [`[agy-pulse snapshot] root="${trimmed}"`]

    if (manifests.length > 0) {
      parts.push(`stack: ${manifests.join(' | ')}`)
    }

    if (gitStatus) {
      const statusLines = gitStatus.split(/\r?\n/).filter(Boolean)
      const branchLine = statusLines[0]?.replace(/^##\s*/, '') || 'detached'
      const dirtyCount = Math.max(0, statusLines.length - 1)
      parts.push(`git: ${branchLine} (dirty=${dirtyCount})`)
    }

    if (gitLog) {
      const commits = gitLog
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, 3)
        .map((c) => (c.length > 72 ? `${c.slice(0, 69)}...` : c))
      if (commits.length > 0) {
        parts.push(`recent: ${commits.join(' | ')}`)
      }
    }

    if (layoutLines.length > 0) {
      parts.push('layout:')
      parts.push(...layoutLines)
    }

    if (parts.length <= 1) {
      return null
    }

    return capUtf8Bytes(parts.join('\n'), maxBytes)
  })()

  const timeoutPromise = new Promise<null>((resolve) => {
    const timer = setTimeout(() => resolve(null), scanTimeoutMs + 60)
    timer.unref()
  })

  return Promise.race([workPromise, timeoutPromise])
}
