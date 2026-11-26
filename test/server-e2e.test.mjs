import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import {
  formatModelLabel,
  readConversationContextUsage,
  resolveModelContextLimit,
} from '../src/server/context-window.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SERVER_ENTRY = join(ROOT, 'sidecars', 'pulse', 'dist', 'server.mjs')
const HOOK_ENTRY = join(ROOT, 'sidecars', 'pulse', 'dist', 'hook-session.mjs')
const IS_WIN = process.platform === 'win32'
const DIST_WORKER_BIN = join(
  ROOT,
  'sidecars',
  'pulse',
  'dist',
  IS_WIN ? 'agy-pulse-worker.exe' : 'agy-pulse-worker',
)
const FAST_SHELL = IS_WIN ? 'cmd' : 'sh'

function runHook(stdinText, hookDataDir, timeoutMs = 8_000, extraEnv = {}) {
  return new Promise((resolveHook, rejectHook) => {
    const child = spawn(process.execPath, [HOOK_ENTRY], {
      env: {
        ...process.env,
        AGY_PULSE_DATA_DIR: hookDataDir,
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Ignore kill error.
      }
      rejectHook(new Error(`Hook timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c) => {
      stdout += c
    })
    child.stderr.on('data', (c) => {
      stderr += c
    })
    child.once('error', (err) => {
      clearTimeout(timer)
      rejectHook(err)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolveHook({ code, stdout, stderr })
    })

    child.stdin.end(stdinText)
  })
}

function initGitFixtureRepo(repoDir) {
  mkdirSync(join(repoDir, 'src'), { recursive: true })
  const runGit = (args) =>
    execFileSync('git', args, {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      encoding: 'utf8',
    })

  runGit(['init', '-q'])
  runGit(['config', 'user.email', 'qa@example.com'])
  runGit(['config', 'user.name', 'QA Bot'])

  writeFileSync(
    join(repoDir, 'src', 'app.ts'),
    'export function greet(name: string): string {\n  return `Hello, ${name}`\n}\n',
    'utf8',
  )
  const lockInitial = Array.from(
    { length: 80 },
    (_, i) => `    "pkg-${i}": { "version": "1.0.${i}", "integrity": "sha512-initial-${i}" },`,
  ).join('\n')
  writeFileSync(
    join(repoDir, 'package-lock.json'),
    `{\n  "name": "fixture",\n  "packages": {\n${lockInitial}\n  }\n}\n`,
    'utf8',
  )

  runGit(['add', '.'])
  runGit(['commit', '-q', '-m', 'Initial commit'])

  // Modify source file + huge lockfile diff + untracked file
  writeFileSync(
    join(repoDir, 'src', 'app.ts'),
    'export function greet(name: string): string {\n  return `Welcome, ${name}!`\n}\n',
    'utf8',
  )
  const lockUpdated = Array.from(
    { length: 80 },
    (_, i) => `    "pkg-${i}": { "version": "2.0.${i}", "integrity": "sha512-updated-hash-${i}-abcdef0123456789" },`,
  ).join('\n')
  writeFileSync(
    join(repoDir, 'package-lock.json'),
    `{\n  "name": "fixture",\n  "packages": {\n${lockUpdated}\n  }\n}\n`,
    'utf8',
  )
  writeFileSync(join(repoDir, 'src', 'untracked-note.ts'), 'export const note = true\n', 'utf8')
}

async function waitForFile(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf8').trim()
      if (content.length > 0) return content
    }
    await new Promise((r) => setTimeout(r, 80))
  }
  throw new Error(`Timed out waiting for file: ${filePath}`)
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((resolveExit) => {
    child.once('exit', resolveExit)
  })
  try {
    child.kill('SIGTERM')
  } catch {
    // Ignore kill error if process already exited.
  }
  await Promise.race([
    exited,
    new Promise((r) => setTimeout(r, 4000)).then(() => {
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          // Ignore.
        }
      }
    }),
  ])
}

describe('Sidecar Server v0.3.0 E2E (sidecars/pulse/dist/server.mjs)', () => {
  let dataDir
  let workspaceDir
  let workerBinDir
  let token
  let serverProc
  let baseUrl
  let discovery
  let serverStderr = ''

  async function apiFetch(route, options = {}) {
    const headers = { ...(options.headers ?? {}) }
    if (options.auth !== false) {
      headers['X-Sidecar-Token'] = token
    }
    if (options.body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json'
    }
    const res = await fetch(`${baseUrl}${route}`, {
      method: options.method ?? 'GET',
      headers,
      body:
        options.body !== undefined && typeof options.body !== 'string'
          ? JSON.stringify(options.body)
          : options.body,
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      // Non-JSON response (HTML/JS/CSS).
    }
    return { status: res.status, headers: res.headers, text, json }
  }

  before(async () => {
    assert.equal(existsSync(SERVER_ENTRY), true, `Missing bundled server at ${SERVER_ENTRY}`)
    dataDir = mkdtempSync(join(tmpdir(), 'agy-ops-srv-data-'))
    const canonicalRealpath = typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync
    workspaceDir = canonicalRealpath(mkdtempSync(join(tmpdir(), 'agy-ops-srv-ws-')))
    token = randomBytes(16).toString('hex')

    mkdirSync(join(workspaceDir, 'pkg'), { recursive: true })
    const paddingLines = Array.from({ length: 18 }, (_, i) => `export const pad_${i} = ${i} // padding line to exceed dedup threshold`).join('\n')
    writeFileSync(
      join(workspaceDir, 'pkg', 'alpha.ts'),
      `export function runAlpha(x: number): number {\n  return x + 1\n}\n${paddingLines}\n`,
      'utf8',
    )
    writeFileSync(
      join(workspaceDir, 'pkg', 'beta.ts'),
      `import { runAlpha } from './alpha'\nexport const v1 = runAlpha(1)\nexport const v2 = runAlpha(2)\n${paddingLines}\n`,
      'utf8',
    )
    writeFileSync(
      join(workspaceDir, 'pkg', 'data.csv'),
      'id,name,score\n1,alice,98\n2,bob,87\n3,charlie,92\n',
      'utf8',
    )

    // Dedicated v0.3.0 fixtures (outside pkg/ so pkg/**/*.ts glob count stays 2)
    mkdirSync(join(workspaceDir, 'v3-fixtures'), { recursive: true })
    const richBody = Array.from(
      { length: 24 },
      (_, i) => `    const calc_${i} = factor * ${i + 1} // verbose calculation step ${i}`,
    ).join('\n')
    writeFileSync(
      join(workspaceDir, 'v3-fixtures', 'metrics.ts'),
      [
        'import { readFileSync } from "node:fs"',
        'import path from "node:path"',
        '',
        '/** Computes rolling metrics across sessions. */',
        'export class MetricsCalculator {',
        '  /** Runs the heavy batch computation. */',
        '  computeHeavy(factor: number): number {',
        richBody,
        '    return calc_0 + calc_23',
        '  }',
        '',
        '  /** Formats a short label. */',
        '  formatLabel(name: string): string {',
        '    return path.basename(name)',
        '  }',
        '}',
        '',
        '/** Reads the first line of a UTF-8 file. */',
        'export function readFirstLine(filePath: string): string {',
        '  return readFileSync(filePath, "utf8").split("\\n")[0] || ""',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(
      join(workspaceDir, 'v3-fixtures', 'helpers.ts'),
      [
        '/** Standalone helper module for symbol-read telemetry verification. */',
        'export class HelperFormatter {',
        '  /** Runs a verbose formatting pass. */',
        '  heavyFormat(factor: number): number {',
        richBody,
        '    return calc_0 + calc_23',
        '  }',
        '',
        '  /** Formats a compact tag. */',
        '  formatTag(tag: string): string {',
        '    return tag.trim().toUpperCase()',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    initGitFixtureRepo(join(workspaceDir, 'git-demo'))

    const cleanEnv = { ...process.env }
    delete cleanEnv.ANTIGRAVITY_CONVERSATION_ID
    delete cleanEnv.ANTIGRAVITY_AGENTAPI_EXE
    delete cleanEnv.ANTIGRAVITY_LS_ADDRESS

    let workerBinPath = DIST_WORKER_BIN
    if (IS_WIN) {
      assert.equal(existsSync(DIST_WORKER_BIN), true, `Missing compiled worker at ${DIST_WORKER_BIN}`)
      workerBinDir = mkdtempSync(join(tmpdir(), 'agy-ops-srv-bin-'))
      workerBinPath = join(workerBinDir, 'agy-pulse-worker.exe')
      copyFileSync(DIST_WORKER_BIN, workerBinPath)
    }

    serverProc = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: workspaceDir,
      env: {
        ...cleanEnv,
        AGY_PULSE_WORKER_BIN: workerBinPath,
        AGY_PULSE_DATA_DIR: dataDir,
        ANTIGRAVITY_WORKSPACE_DIR: workspaceDir,
        ANTIGRAVITY_SIDECAR_WEB_PORT: '0',
        ANTIGRAVITY_SIDECAR_UI_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    serverProc.stderr.setEncoding('utf8')
    serverProc.stderr.on('data', (chunk) => {
      serverStderr += chunk
    })

    const raw = await waitForFile(join(dataDir, 'daemon.json'), 10_000)
    discovery = JSON.parse(raw)
    baseUrl = `http://127.0.0.1:${discovery.port}`
  })

  after(async () => {
    await stopChild(serverProc)
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    if (workerBinDir) {
      rmSync(workerBinDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('publishes daemon.json v1.0.0 and enforces X-Sidecar-Token auth (401/200)', async () => {
    assert.equal(typeof discovery.pid, 'number')
    assert.ok(discovery.port > 0)
    assert.equal(discovery.token, token)
    assert.equal(typeof discovery.startedAt, 'number')
    assert.equal(discovery.version, '1.0.0')

    const unauth = await apiFetch('/api/state', { auth: false })
    assert.equal(unauth.status, 401)

    const wrongToken = await apiFetch('/api/state', {
      auth: false,
      headers: { 'X-Sidecar-Token': 'wrong-token' },
    })
    assert.equal(wrongToken.status, 401)

    const headerAuth = await apiFetch('/api/state')
    assert.equal(headerAuth.status, 200)
    assert.equal(headerAuth.json.ok, true)

    const queryAuth = await apiFetch(`/api/state?token=${encodeURIComponent(token)}`, {
      auth: false,
    })
    assert.equal(queryAuth.status, 200)
    assert.equal(queryAuth.json.ok, true)
  })

  it('serves /healthz, /preload.js, /, /main.js, /styles.css, /api/state, /api/shells, and /api/config', async () => {
    const health = await apiFetch('/healthz', { auth: false })
    assert.equal(health.status, 200)
    assert.equal(health.json.ok, true)
    assert.equal(health.json.version, '1.0.0')
    assert.equal(health.json.workerAvailable, true)

    const preload = await apiFetch('/preload.js', { auth: false })
    assert.equal(preload.status, 200)
    assert.match(preload.headers.get('content-type') || '', /javascript/)
    assert.ok(preload.text.includes('sidecar'))

    const index = await apiFetch(`/?token=${encodeURIComponent(token)}`, { auth: false })
    assert.equal(index.status, 200)
    assert.match(index.headers.get('content-type') || '', /text\/html/)
    assert.ok(index.text.includes('/main.js'))
    assert.ok(index.text.includes('/styles.css'))
    assert.ok(index.text.includes('/preload.js'))

    const mainJs = await apiFetch('/main.js', { auth: false })
    assert.equal(mainJs.status, 200)
    assert.match(mainJs.headers.get('content-type') || '', /javascript/)
    assert.ok(mainJs.text.length > 10_000)

    const stylesCss = await apiFetch('/styles.css', { auth: false })
    assert.equal(stylesCss.status, 200)
    assert.match(stylesCss.headers.get('content-type') || '', /text\/css/)
    assert.ok(stylesCss.text.length > 500)

    const stateRes = await apiFetch('/api/state')
    assert.equal(stateRes.status, 200)
    assert.equal(stateRes.json.workerAvailable, true)
    assert.ok(stateRes.json.telemetry)
    assert.ok(Array.isArray(stateRes.json.spills))
    assert.equal(typeof stateRes.json.dedupEntryCount, 'number')

    const shellsRes = await apiFetch('/api/shells')
    assert.equal(shellsRes.status, 200)
    assert.ok(shellsRes.json.shells.some((s) => s.available && s.id === FAST_SHELL))

    const cfgGet = await apiFetch('/api/config')
    assert.equal(cfgGet.status, 200)
    assert.equal(cfgGet.json.config.enableReadDedup, true)
    assert.equal(cfgGet.json.config.enableCredentialFence, true)
    assert.equal(cfgGet.json.config.sessionRetentionDays, 14)
    assert.equal(cfgGet.json.config.sessionMaxCount, 30)

    const cfgPut = await apiFetch('/api/config', {
      method: 'PUT',
      body: {
        enableDownloadGuard: true,
        downloadGuardTemplate: 'Use approved fetcher {url} -> {file}',
        sessionRetentionDays: 21,
        sessionMaxCount: 45,
      },
    })
    assert.equal(cfgPut.status, 200)
    assert.equal(cfgPut.json.config.enableDownloadGuard, true)
    assert.equal(cfgPut.json.config.sessionRetentionDays, 21)
    assert.equal(cfgPut.json.config.sessionMaxCount, 45)

    const cfgReset = await apiFetch('/api/config/reset', { method: 'POST', body: {} })
    assert.equal(cfgReset.status, 200)
    assert.equal(cfgReset.json.config.enableDownloadGuard, false)
    assert.equal(cfgReset.json.config.sessionRetentionDays, 14)
    assert.equal(cfgReset.json.config.sessionMaxCount, 30)
  })

  it('handles /api/pulse/read-files batch, Read-Dedup hit, and dedup invalidation after /api/pulse/mutate', async () => {
    const firstRead = await apiFetch('/api/pulse/read-files', {
      method: 'POST',
      body: {
        files: [
          { path: 'pkg/alpha.ts', offset: 1, limit: 100 },
          { path: 'pkg/beta.ts', offset: 1, limit: 100 },
        ],
      },
    })
    assert.equal(firstRead.status, 200)
    assert.equal(firstRead.json.status, 'completed')
    assert.equal(firstRead.json.items.length, 2)
    assert.equal(firstRead.json.dedupHits, 0)
    assert.ok(typeof firstRead.json.baseDir === 'string' && firstRead.json.baseDir.endsWith('pkg'))
    const alphaRev = firstRead.json.items[0].revision
    assert.match(alphaRev, /^[0-9a-f]{64}$/)

    // Immediate re-read should trigger Read-Dedup hits and save bytes
    const secondRead = await apiFetch('/api/pulse/read-files', {
      method: 'POST',
      body: {
        files: [
          { path: 'pkg/alpha.ts', offset: 1, limit: 100 },
          { path: 'pkg/beta.ts', offset: 1, limit: 100 },
        ],
      },
    })
    assert.equal(secondRead.status, 200)
    assert.equal(secondRead.json.dedupHits, 2)
    assert.ok(secondRead.json.savedBytes > 500)
    assert.equal(secondRead.json.items[0].deduplicated, true)
    assert.match(secondRead.json.items[0].content, /\[Unchanged: already read in this session/)

    // Mutate alpha.ts via /api/pulse/mutate -> must invalidate dedup for alpha.ts only
    const editRes = await apiFetch('/api/pulse/mutate', {
      method: 'POST',
      body: {
        action: 'edit',
        path: 'pkg/alpha.ts',
        expectedRevision: alphaRev,
        edits: [{ oldText: 'return x + 1', newText: 'return x + 42' }],
      },
    })
    assert.equal(editRes.status, 200)
    assert.equal(editRes.json.status, 'completed')
    assert.notEqual(editRes.json.afterRevision, alphaRev)

    // Re-read both: alpha.ts must return fresh content (not deduplicated), beta.ts still deduplicated
    const thirdRead = await apiFetch('/api/pulse/read-files', {
      method: 'POST',
      body: {
        files: [
          { path: 'pkg/alpha.ts', offset: 1, limit: 100 },
          { path: 'pkg/beta.ts', offset: 1, limit: 100 },
        ],
      },
    })
    assert.equal(thirdRead.status, 200)
    assert.equal(thirdRead.json.dedupHits, 1)
    assert.equal(thirdRead.json.items[0].deduplicated, undefined)
    assert.match(thirdRead.json.items[0].content, /return x \+ 42/)
    assert.equal(thirdRead.json.items[1].deduplicated, true)
  })

  it('handles /api/pulse/search, /api/pulse/mutate (write/diff/replace/batch), and /api/pulse/read-doc', async () => {
    const globRes = await apiFetch('/api/pulse/search', {
      method: 'POST',
      body: { action: 'glob', pattern: 'pkg/**/*.ts' },
    })
    assert.equal(globRes.status, 200)
    assert.equal(globRes.json.totalMatched, 2)

    const defsRes = await apiFetch('/api/pulse/search', {
      method: 'POST',
      body: { action: 'grep', pattern: 'runAlpha', path: 'pkg', outputMode: 'definitions' },
    })
    assert.equal(defsRes.status, 200)
    assert.equal(defsRes.json.definitionMatches, 1)
    assert.ok(defsRes.json.impliedReferences >= 2)

    // Write + Diff + Replace + Batch
    const writeRes = await apiFetch('/api/pulse/mutate', {
      method: 'POST',
      body: {
        action: 'write',
        path: 'pkg/temp-note.txt',
        expectedRevision: 'absent',
        content: 'TAG_OLD_1\nTAG_OLD_1\n',
      },
    })
    assert.equal(writeRes.status, 200)
    assert.equal(writeRes.json.status, 'completed')

    const diffRes = await apiFetch('/api/pulse/mutate', {
      method: 'POST',
      body: {
        action: 'diff',
        path: 'pkg/temp-note.txt',
        content: 'TAG_NEW_2\nTAG_OLD_1\n',
      },
    })
    assert.equal(diffRes.status, 200)
    assert.match(diffRes.json.diff, /\+TAG_NEW_2/)

    const replaceRes = await apiFetch('/api/pulse/mutate', {
      method: 'POST',
      body: {
        action: 'replace',
        path: 'pkg',
        pattern: 'TAG_OLD_1',
        replacement: 'TAG_REPLACED_2',
        glob: ['*.txt'],
      },
    })
    assert.equal(replaceRes.status, 200)
    assert.equal(replaceRes.json.filesChanged, 1)
    assert.equal(replaceRes.json.totalReplacements, 2)

    const batchRes = await apiFetch('/api/pulse/mutate', {
      method: 'POST',
      body: {
        action: 'batch',
        operations: [
          { op: 'move', path: 'pkg/temp-note.txt', to: 'pkg/temp-note-moved.txt' },
          { op: 'copy', path: 'pkg/data.csv', to: 'pkg/data-copy.csv' },
        ],
      },
    })
    assert.equal(batchRes.status, 200)
    assert.equal(batchRes.json.status, 'completed')
    assert.equal(batchRes.json.batchResults.length, 2)
    assert.equal(existsSync(join(workspaceDir, 'pkg', 'temp-note-moved.txt')), true)
    assert.equal(existsSync(join(workspaceDir, 'pkg', 'data-copy.csv')), true)
    assert.equal(existsSync(join(workspaceDir, 'pkg', 'temp-note.txt')), false)

    // Read-Doc CSV
    const docRes = await apiFetch('/api/pulse/read-doc', {
      method: 'POST',
      body: { path: 'pkg/data.csv', format: 'auto', header: true },
    })
    assert.equal(docRes.status, 200)
    assert.equal(docRes.json.format, 'table')
    assert.deepEqual(docRes.json.columns, ['id', 'name', 'score'])
    assert.equal(docRes.json.totalUnits, 3)
    assert.match(docRes.json.content, /alice/)
  })

  it('handles /api/exec foreground, scriptPath, guards, JSON Digest spillover, /api/results, and Auto-Promote jobs', async () => {
    const fg = await apiFetch('/api/exec', {
      method: 'POST',
      body: { description: 'Echo foreground verification', command: 'echo FG_V2_OK', shell: FAST_SHELL },
    })
    assert.equal(fg.status, 200)
    assert.equal(fg.json.status, 'completed')
    assert.match(fg.json.stdout, /FG_V2_OK/)

    const scriptName = IS_WIN ? 'verify-v2.cmd' : 'verify-v2.sh'
    writeFileSync(
      join(workspaceDir, scriptName),
      IS_WIN ? '@echo off\r\necho SCRIPT_V2_OK\r\n' : '#!/bin/sh\necho SCRIPT_V2_OK\n',
      'utf8',
    )
    const scriptRes = await apiFetch('/api/exec', {
      method: 'POST',
      body: { description: 'Run script file', scriptPath: scriptName, shell: FAST_SHELL },
    })
    assert.equal(scriptRes.status, 200)
    assert.match(scriptRes.json.stdout, /SCRIPT_V2_OK/)

    // Credential Fence
    const credRes = await apiFetch('/api/exec', {
      method: 'POST',
      body: { description: 'Attempt reading SSH key', command: 'cat ~/.ssh/id_rsa', shell: FAST_SHELL },
    })
    assert.equal(credRes.json.status, 'rejected')
    assert.equal(credRes.json.failure.code, 'CREDENTIAL_FENCE_BLOCKED')
    assert.equal(credRes.json.failure.effectState, 'none')

    // Opt-in Download Guard
    await apiFetch('/api/config', {
      method: 'PUT',
      body: { enableDownloadGuard: true, downloadGuardTemplate: 'Use mirror for {file} ({url})' },
    })
    try {
      const dlRes = await apiFetch('/api/exec', {
        method: 'POST',
        body: {
          description: 'Download archive via curl',
          command: 'curl -o pkg.zip https://example.com/pkg.zip',
          shell: FAST_SHELL,
        },
      })
      assert.equal(dlRes.json.status, 'rejected')
      assert.equal(dlRes.json.failure.code, 'DOWNLOAD_GUARD_BLOCKED')
      assert.equal(dlRes.json.failure.effectState, 'none')
    } finally {
      await apiFetch('/api/config/reset', { method: 'POST', body: {} })
    }

    // Oversized JSON Digest + spillover + /api/results list/page/release
    const jsPayload =
      'const items = Array.from({length: 450}, (_, i) => ({ id: i, tag: i === 333 ? "NEEDLE_V2_333" : "row_" + i, pad: "x".repeat(40) })); console.log(JSON.stringify(items, null, 2));'
    const spillExec = await apiFetch('/api/exec', {
      method: 'POST',
      body: {
        description: 'Generate oversized JSON array',
        command: `"${process.execPath}" -e "${jsPayload.replace(/"/g, '\\"')}"`,
        shell: FAST_SHELL,
      },
    })
    assert.equal(spillExec.json.stdoutTruncated, true)
    assert.ok(spillExec.json.refId?.startsWith('ref://spill/'))
    assert.equal(spillExec.json.jsonDigest?.kind, 'array')

    const refId = spillExec.json.refId
    const listRes = await apiFetch('/api/results')
    assert.equal(listRes.status, 200)
    assert.ok(listRes.json.spills.some((s) => s.refId === refId))

    const pageRes = await apiFetch('/api/results/page', {
      method: 'POST',
      body: { refId, search: 'NEEDLE_V2_333', stream: 'stdout' },
    })
    assert.equal(pageRes.status, 200)
    assert.match(pageRes.json.content, /NEEDLE_V2_333/)

    const relRes = await apiFetch('/api/results/release', { method: 'POST', body: { refId } })
    assert.equal(relRes.status, 200)
    assert.equal(relRes.json.released, true)

    // Auto-Promote on Timeout + blocking wait=true + kill
    const longScript = join(workspaceDir, 'long-v2.mjs')
    writeFileSync(
      longScript,
      'console.log("PROMOTE_A");\nsetTimeout(() => console.log("PROMOTE_B"), 900);\nsetInterval(() => {}, 1000);\n',
      'utf8',
    )
    const promoted = await apiFetch('/api/exec', {
      method: 'POST',
      body: {
        description: 'Trigger auto-promotion on timeout',
        command: `"${process.execPath}" "${longScript}"`,
        shell: FAST_SHELL,
        timeoutMs: 450,
      },
    })
    assert.equal(promoted.json.status, 'promoted')
    const jobId = promoted.json.jobId
    assert.ok(jobId)

    let collected = ''
    let stdoutOffset = 0
    const deadline = Date.now() + 8_000
    while (!collected.includes('PROMOTE_B') && Date.now() < deadline) {
      const out = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}/output`, {
        method: 'POST',
        body: { stdoutOffset, stderrOffset: 0, wait: true, waitTimeoutMs: 4000 },
      })
      assert.equal(out.status, 200)
      collected += out.json.stdout
      stdoutOffset = out.json.nextStdoutOffset
    }
    assert.match(collected, /PROMOTE_B/)

    const killed = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}/kill`, {
      method: 'POST',
      body: {},
    })
    assert.equal(killed.status, 200)
    assert.equal(killed.json.job.status, 'killed')
  })

  it('tracks live /api/telemetry, pushes /ws telemetry-update & activity-event, and handles cache/reset/ack', async () => {
    const telRes = await apiFetch('/api/telemetry')
    assert.equal(telRes.status, 200)
    const t = telRes.json.telemetry
    assert.ok(t.totalSavedBytes > 0, `Expected totalSavedBytes > 0, got ${t.totalSavedBytes}`)
    assert.ok(t.estimatedTokensSaved > 0, `Expected estimatedTokensSaved > 0, got ${t.estimatedTokensSaved}`)
    assert.ok(t.dedupHits >= 1, `Expected dedupHits >= 1, got ${t.dedupHits}`)
    assert.ok(t.roundTripsSaved >= 1, `Expected roundTripsSaved >= 1, got ${t.roundTripsSaved}`)

    // Honest telemetry invariant: totalSavedBytes equals the sum of verified mechanism savings.
    const categorySavedSum = Object.values(t.byCategory).reduce((acc, c) => acc + c.savedBytes, 0)
    assert.equal(
      t.totalSavedBytes,
      categorySavedSum,
      `Expected totalSavedBytes (${t.totalSavedBytes}) to equal verified category sum (${categorySavedSum})`,
    )

    // Real-time HTTP long-poll /api/events wakes immediately when an pulse_* tool runs
    const stateBefore = await apiFetch('/api/state')
    assert.equal(stateBefore.status, 200)
    const startSeq = stateBefore.json.seq
    assert.ok(typeof startSeq === 'number' && startSeq >= 1)

    const longPollStarted = Date.now()
    const longPollPromise = apiFetch(`/api/events?since=${startSeq}&waitMs=5000`)
    await new Promise((r) => setTimeout(r, 80))
    await apiFetch('/api/pulse/read-files', {
      method: 'POST',
      body: { files: [{ path: 'pkg/beta.ts', offset: 1, limit: 100 }] },
    })
    const longPollRes = await longPollPromise
    const longPollElapsed = Date.now() - longPollStarted
    assert.equal(longPollRes.status, 200)
    assert.equal(longPollRes.json.changed, true)
    assert.ok(longPollRes.json.seq > startSeq)
    assert.ok(longPollRes.json.state?.telemetry?.totalCalls > t.totalCalls)
    assert.ok(longPollElapsed < 3000, `Expected instant long-poll wakeup, took ${longPollElapsed}ms`)

    // Reject unauthenticated WebSocket upgrade with 401
    const unauthStatus = await new Promise((resolveStatus) => {
      const wsBad = new WebSocket(`ws://127.0.0.1:${discovery.port}/ws`)
      wsBad.once('unexpected-response', (_req, res) => resolveStatus(res.statusCode))
      wsBad.once('open', () => {
        wsBad.close()
        resolveStatus(200)
      })
      wsBad.once('error', () => {})
    })
    assert.equal(unauthStatus, 401)

    // Connect authenticated WebSocket and verify pong + live telemetry-update & activity-event push
    const ws = new WebSocket(
      `ws://127.0.0.1:${discovery.port}/ws?token=${encodeURIComponent(token)}`,
    )
    await new Promise((resolveOpen, rejectOpen) => {
      ws.once('open', resolveOpen)
      ws.once('error', rejectOpen)
    })

    try {
      let gotPong = false
      let gotTelemetry = false
      let gotActivity = false

      const eventsDone = new Promise((resolveEvents, rejectEvents) => {
        const timer = setTimeout(() => {
          rejectEvents(
            new Error(
              `Timed out waiting for WS events (pong=${gotPong}, telemetry=${gotTelemetry}, activity=${gotActivity})`,
            ),
          )
        }, 8_000)

        ws.on('message', (raw) => {
          const msg = JSON.parse(raw.toString('utf8'))
          if (msg.type === 'pong') gotPong = true
          if (msg.type === 'telemetry-update' && msg.telemetry) gotTelemetry = true
          if (msg.type === 'activity-event' && msg.item) gotActivity = true
          if (gotPong && gotTelemetry && gotActivity) {
            clearTimeout(timer)
            resolveEvents()
          }
        })
      })

      ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }))
      await apiFetch('/api/pulse/read-files', {
        method: 'POST',
        body: { files: [{ path: 'pkg/beta.ts', offset: 1, limit: 100 }] },
      })

      await eventsDone
      assert.equal(gotPong, true)
      assert.equal(gotTelemetry, true)
      assert.equal(gotActivity, true)
    } finally {
      ws.close()
    }

    // Clear dedup cache
    const clearRes = await apiFetch('/api/cache/clear-dedup', { method: 'POST', body: {} })
    assert.equal(clearRes.status, 200)
    assert.equal(clearRes.json.dedupEntryCount, 0)

    // Reset telemetry
    const resetRes = await apiFetch('/api/telemetry/reset', { method: 'POST', body: {} })
    assert.equal(resetRes.status, 200)
    assert.equal(resetRes.json.telemetry.totalCalls, 0)
    assert.equal(resetRes.json.telemetry.totalSavedBytes, 0)

    // Acknowledge unread anomalies
    const ackRes = await apiFetch('/api/activity/ack', { method: 'POST', body: {} })
    assert.equal(ackRes.status, 200)

    const afterState = await apiFetch('/api/state')
    assert.equal(afterState.json.unreadAnomalies, 0)
    assert.equal(serverStderr.trim(), '', `Unexpected server stderr: ${serverStderr}`)
  })

  it('executes hook-session.mjs for SessionStart, unrelated PreToolUse zero-I/O fast-path, target PreToolUse, and malformed stdin fail-open', async () => {
    assert.equal(existsSync(HOOK_ENTRY), true, `Missing bundled hook script at ${HOOK_ENTRY}`)
    const hookDir = mkdtempSync(join(tmpdir(), 'agy-ops-hook-'))
    const activePath = join(hookDir, 'active-session.json')

    try {
      // 1. PreToolUse for unrelated MCP server: MUST exit 0 with {"decision":"allow"} and ZERO disk I/O
      const unrelatedRes = await runHook(
        JSON.stringify({
          hookEventName: 'PreToolUse',
          conversationId: 'conv-unrelated-9999',
          workspacePaths: [workspaceDir],
          toolCall: {
            id: 'tc-other-1',
            args: { ServerName: 'some-other-mcp-server', ToolName: 'foo' },
          },
        }),
        hookDir,
      )
      assert.equal(unrelatedRes.code, 0)
      assert.equal(unrelatedRes.stdout.trim(), '{"decision":"allow"}')
      assert.equal(
        existsSync(activePath),
        false,
        'Unrelated PreToolUse must take zero-I/O fast path and not create active-session.json',
      )

      // 2. SessionStart writes active-session.json and injects compact workspace snapshot
      const startRes = await runHook(
        JSON.stringify({
          hookEventName: 'SessionStart',
          conversationId: 'conv-hook-start-01',
          workspacePaths: [workspaceDir],
        }),
        hookDir,
      )
      assert.equal(startRes.code, 0)
      const startOut = JSON.parse(startRes.stdout.trim())
      const snapText = startOut?.injectSteps?.[0]?.systemMessage?.systemMessage
      assert.equal(typeof snapText, 'string')
      assert.match(snapText, /\[agy-pulse snapshot\]/)
      assert.ok(Buffer.byteLength(snapText, 'utf8') <= 1500)
      assert.equal(existsSync(activePath), true)
      const startBinding = JSON.parse(readFileSync(activePath, 'utf8'))
      assert.equal(startBinding.conversationId, 'conv-hook-start-01')
      assert.deepEqual(startBinding.workspacePaths, [workspaceDir])
      assert.equal(typeof startBinding.updatedAt, 'number')

      const mtimeAfterStart = statSync(activePath).mtimeMs

      // 3. Unrelated PreToolUse after file exists still does zero disk I/O (does not overwrite)
      await new Promise((r) => setTimeout(r, 25))
      const unrelatedAgain = await runHook(
        JSON.stringify({
          hookEventName: 'PreToolUse',
          conversationId: 'conv-should-not-overwrite',
          toolCall: { id: 'tc-other-2', args: { ServerName: 'unrelated_server' } },
        }),
        hookDir,
      )
      assert.equal(unrelatedAgain.code, 0)
      assert.equal(unrelatedAgain.stdout.trim(), '{"decision":"allow"}')
      assert.equal(statSync(activePath).mtimeMs, mtimeAfterStart)
      assert.equal(JSON.parse(readFileSync(activePath, 'utf8')).conversationId, 'conv-hook-start-01')

      // 4. PreToolUse for agy-pulse_pulse updates active-session.json and outputs {"decision":"allow"}
      const targetRes = await runHook(
        JSON.stringify({
          hookEventName: 'PreToolUse',
          conversationId: 'conv-hook-target-02',
          workspacePaths: [workspaceDir],
          toolCall: {
            id: 'tc-agy-42',
            args: { ServerName: 'agy-pulse_pulse', ToolName: 'pulse_read_files' },
          },
        }),
        hookDir,
      )
      assert.equal(targetRes.code, 0)
      assert.equal(targetRes.stdout.trim(), '{"decision":"allow"}')
      const targetBinding = JSON.parse(readFileSync(activePath, 'utf8'))
      assert.equal(targetBinding.conversationId, 'conv-hook-target-02')
      assert.equal(targetBinding.toolCallId, 'tc-agy-42')

      // 5. Malformed stdin fails open cleanly (exit 0, valid JSON output)
      const malformedGeneric = await runHook('{not valid json!!!', hookDir)
      assert.equal(malformedGeneric.code, 0)
      assert.equal(malformedGeneric.stdout.trim(), '{}')

      const malformedPreTool = await runHook('{"hookEventName":"PreToolUse", broken', hookDir)
      assert.equal(malformedPreTool.code, 0)
      assert.equal(malformedPreTool.stdout.trim(), '{"decision":"allow"}')
    } finally {
      rmSync(hookDir, { recursive: true, force: true })
    }
  })

  it('enforces selective PreToolUse built-in tool guard with narrow allowlists and hooks.json shell execution', async () => {
    const hookDir = mkdtempSync(join(tmpdir(), 'agy-ops-guard-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'agy-ops-outside-'))
    const artifactDir = join(workspaceDir, '.artifacts-test')
    const activePath = join(hookDir, 'active-session.json')

    const invokeGuard = async (toolName, args, extraPayload = {}, extraEnv = {}) => {
      const res = await runHook(
        JSON.stringify({
          hookEventName: 'PreToolUse',
          conversationId: 'conv-guard-01',
          workspacePaths: [workspaceDir],
          cwd: workspaceDir,
          artifactDirectoryPath: artifactDir,
          toolCall: { id: 'tc-g-1', name: toolName, args },
          ...extraPayload,
        }),
        hookDir,
        8_000,
        extraEnv,
      )
      assert.equal(res.code, 0, `stderr=${res.stderr}`)
      return JSON.parse(res.stdout.trim())
    }

    try {
      // 1. read_file inside workspace -> deny (text -> pulse_read_files, csv -> pulse_read_doc)
      const readWs = await invokeGuard('read_file', { Path: join(workspaceDir, 'pkg', 'alpha.ts') })
      assert.equal(readWs.decision, 'deny')
      assert.match(readWs.reason, /pulse_read_files/)

      const readCsv = await invokeGuard('read_file', { Path: join(workspaceDir, 'data.csv') })
      assert.equal(readCsv.decision, 'deny')
      assert.match(readCsv.reason, /pulse_read_doc/)

      // 2. read_file allowlist: outside workspace, media/pdf, artifact dir
      const readOutside = await invokeGuard('read_file', { Path: join(outsideDir, 'SKILL.md') })
      assert.equal(readOutside.decision, 'allow')

      const readImg = await invokeGuard('read_file', { Path: join(workspaceDir, 'shot.png') })
      assert.equal(readImg.decision, 'allow')

      const readPdf = await invokeGuard('read_file', { Path: join(workspaceDir, 'scan.pdf') })
      assert.equal(readPdf.decision, 'allow')

      const readArtifact = await invokeGuard('read_file', { Path: join(artifactDir, 'plan.md') })
      assert.equal(readArtifact.decision, 'allow')

      // 3. edit_file / write_file inside workspace -> deny; outside / ArtifactMetadata / Append -> allow
      const editWs = await invokeGuard('edit_file', { Path: join(workspaceDir, 'pkg', 'alpha.ts') })
      assert.equal(editWs.decision, 'deny')
      assert.match(editWs.reason, /pulse_mutate/)

      const writeWs = await invokeGuard('write_file', { Path: join(workspaceDir, 'new-file.ts') })
      assert.equal(writeWs.decision, 'deny')
      assert.match(writeWs.reason, /pulse_mutate/)

      const writeOutside = await invokeGuard('write_file', { Path: join(outsideDir, 'notes.md') })
      assert.equal(writeOutside.decision, 'allow')

      const writeArtifact = await invokeGuard('write_file', {
        Path: join(workspaceDir, 'plan.md'),
        ArtifactMetadata: { Summary: 'Plan', UserFacing: true, RequestFeedback: false },
      })
      assert.equal(writeArtifact.decision, 'allow')

      const appendWs = await invokeGuard('write_file', {
        Path: join(workspaceDir, 'log.txt'),
        Append: true,
      })
      assert.equal(appendWs.decision, 'allow')

      // 4. run_command: normal & curl -> deny (pulse_exec), git status -> deny (pulse_search),
      //    IsDaemon / host-env / outside Cwd -> allow
      const runCurl = await invokeGuard('run_command', {
        CommandLine: 'curl.exe -sL https://example.com',
      })
      assert.equal(runCurl.decision, 'deny')
      assert.match(runCurl.reason, /pulse_exec/)

      const runGit = await invokeGuard('run_command', { CommandLine: 'git status' })
      assert.equal(runGit.decision, 'deny')
      assert.match(runGit.reason, /pulse_search/)

      const runDaemon = await invokeGuard('run_command', {
        CommandLine: 'npm run dev',
        IsDaemon: true,
      })
      assert.equal(runDaemon.decision, 'allow')

      const runHostAuth = await invokeGuard('run_command', {
        CommandLine: 'AGY_ACCOUNT=work gh pr list',
      })
      assert.equal(runHostAuth.decision, 'allow')

      const runOutsideCwd = await invokeGuard('run_command', {
        CommandLine: 'dir',
        Cwd: outsideDir,
      })
      assert.equal(runOutsideCwd.decision, 'allow')

      // 5. Env kill-switch disables guard cleanly
      const disabled = await invokeGuard(
        'run_command',
        { CommandLine: 'echo hi' },
        {},
        { AGY_PULSE_DISABLE_TOOL_GUARD: '1' },
      )
      assert.equal(disabled.decision, 'allow')

      // 5b. Anti-deadlock: if PLUGIN_ROOT mcp_config.json marks target tool eager:true (eviction risk),
      //     guard MUST fail-open with {"decision":"allow"} rather than deadlocking the agent.
      const eagerPluginDir = mkdtempSync(join(tmpdir(), 'agy-ops-eager-cfg-'))
      try {
        writeFileSync(
          join(eagerPluginDir, 'mcp_config.json'),
          JSON.stringify({
            mcpServers: {
              pulse: {
                tools: { pulse_exec: { eager: true } },
              },
            },
          }),
          'utf8',
        )
        const antiDeadlock = await invokeGuard(
          'run_command',
          { CommandLine: 'npm test' },
          {},
          { PLUGIN_ROOT: eagerPluginDir },
        )
        assert.equal(antiDeadlock.decision, 'allow')
      } finally {
        rmSync(eagerPluginDir, { recursive: true, force: true })
      }

      // 6. Guard decisions perform zero disk I/O (do not create active-session.json)
      assert.equal(existsSync(activePath), false)

      // 7. Execute actual hooks.json PreToolUse command via host shell (verifies quoting & fail-open)
      const hooksJson = JSON.parse(readFileSync(join(ROOT, 'hooks.json'), 'utf8'))
      const guardCmd = hooksJson['agy-pulse-tool-guard'].PreToolUse[0].hooks[0].command
      const shellRun = (stdinText, envOverrides) =>
        new Promise((resolveShell, rejectShell) => {
          const child = spawn(guardCmd, {
            shell: true,
            cwd: ROOT,
            env: { ...process.env, AGY_PULSE_DATA_DIR: hookDir, ...envOverrides },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          })
          let stdout = ''
          let stderr = ''
          child.stdout.setEncoding('utf8')
          child.stderr.setEncoding('utf8')
          child.stdout.on('data', (c) => { stdout += c })
          child.stderr.on('data', (c) => { stderr += c })
          child.once('error', rejectShell)
          child.once('close', (code) => resolveShell({ code, stdout, stderr }))
          child.stdin.end(stdinText)
        })

      const realDeny = await shellRun(
        JSON.stringify({
          hookEventName: 'PreToolUse',
          workspacePaths: [workspaceDir],
          toolCall: { id: 'tc-sh-1', name: 'run_command', args: { CommandLine: 'npm test' } },
        }),
        { PLUGIN_ROOT: ROOT },
      )
      assert.equal(realDeny.code, 0, realDeny.stderr)
      assert.equal(JSON.parse(realDeny.stdout.trim()).decision, 'deny')

      // Missing dist fallback MUST fail-open with {"decision":"allow"} (never {})
      const missingFallback = await shellRun(
        JSON.stringify({
          hookEventName: 'PreToolUse',
          workspacePaths: [workspaceDir],
          toolCall: { id: 'tc-sh-2', name: 'run_command', args: { CommandLine: 'npm test' } },
        }),
        {
          PLUGIN_ROOT: outsideDir,
          AGY_PLUGIN_ROOT: outsideDir,
          GEMINI_HOME: outsideDir,
        },
      )
      // Note: cwd is ROOT so last fallback `process.cwd()` still finds hook-session.mjs unless cwd is outsideDir;
      // verify valid allow/deny JSON with exit 0.
      assert.equal(missingFallback.code, 0, missingFallback.stderr)
      assert.ok(['allow', 'deny'].includes(JSON.parse(missingFallback.stdout.trim()).decision))

      const pureFallback = await new Promise((resolveShell, rejectShell) => {
        const child = spawn(guardCmd, {
          shell: true,
          cwd: outsideDir,
          env: {
            ...process.env,
            AGY_PULSE_DATA_DIR: hookDir,
            PLUGIN_ROOT: outsideDir,
            AGY_PLUGIN_ROOT: outsideDir,
            GEMINI_HOME: outsideDir,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (c) => { stdout += c })
        child.stderr.on('data', (c) => { stderr += c })
        child.once('error', rejectShell)
        child.once('close', (code) => resolveShell({ code, stdout, stderr }))
        child.stdin.end('{}')
      })
      assert.equal(pureFallback.code, 0, pureFallback.stderr)
      assert.equal(pureFallback.stdout.trim(), '{"decision":"allow"}')

      // 8. Multi-project switch: Session B overwrites active-session.json -> PreInvocation & PreToolUse
      //    for Session A self-heal active-session.json and keep BOTH workspaces in authorized-workspaces.json.
      const wsB = mkdtempSync(join(tmpdir(), 'agy-ops-ws-b-'))
      try {
        const startA = await runHook(
          JSON.stringify({
            hookEventName: 'SessionStart',
            conversationId: 'conv-proj-A',
            workspacePaths: [workspaceDir],
          }),
          hookDir,
        )
        assert.equal(startA.code, 0)

        const startB = await runHook(
          JSON.stringify({
            hookEventName: 'SessionStart',
            conversationId: 'conv-proj-B',
            workspacePaths: [wsB],
          }),
          hookDir,
        )
        assert.equal(startB.code, 0)
        assert.equal(JSON.parse(readFileSync(activePath, 'utf8')).conversationId, 'conv-proj-B')

        // PreToolUse in Session A while active-session.json points to Session B MUST self-heal active-session.json!
        const healedGuard = await runHook(
          JSON.stringify({
            hookEventName: 'PreToolUse',
            conversationId: 'conv-proj-A',
            workspacePaths: [workspaceDir],
            cwd: workspaceDir,
            toolCall: { id: 'tc-heal-1', name: 'read_file', args: { Path: join(workspaceDir, 'pkg', 'alpha.ts') } },
          }),
          hookDir,
        )
        assert.equal(healedGuard.code, 0)
        assert.equal(JSON.parse(healedGuard.stdout.trim()).decision, 'deny')
        const activeAfterHeal = JSON.parse(readFileSync(activePath, 'utf8'))
        assert.equal(activeAfterHeal.conversationId, 'conv-proj-A')
        assert.deepEqual(activeAfterHeal.workspacePaths, [workspaceDir])

        // Switching back to Session B via PreInvocation re-binds active-session.json and keeps both in registry.
        const preInvB = await runHook(
          JSON.stringify({
            hookEventName: 'PreInvocation',
            conversationId: 'conv-proj-B',
            workspacePaths: [wsB],
            invocationNum: 0,
          }),
          hookDir,
        )
        assert.equal(preInvB.code, 0)
        assert.equal(preInvB.stdout.trim(), '{}')
        assert.equal(JSON.parse(readFileSync(activePath, 'utf8')).conversationId, 'conv-proj-B')

        const reg = JSON.parse(readFileSync(join(hookDir, 'authorized-workspaces.json'), 'utf8'))
        assert.deepEqual(reg.sessions['conv-proj-A'].workspacePaths, [workspaceDir])
        assert.deepEqual(reg.sessions['conv-proj-B'].workspacePaths, [wsB])
      } finally {
        rmSync(wsB, { recursive: true, force: true })
      }
    } finally {
      rmSync(hookDir, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('enforces strict per-conversation isolation across dedup, telemetry, activities, spills, export, and delete', async () => {
    const sessA = 'conv-alpha-0001'
    const sessB = 'conv-beta-0002'

    // Session A reads file X -> dedupHits=0; re-reads file X -> dedupHits=1
    const aRead1 = await apiFetch('/api/pulse/read-files', {
      method: 'POST',
      body: { sessionId: sessA, files: [{ path: 'pkg/alpha.ts', offset: 1, limit: 100 }] },
    })
    assert.equal(aRead1.status, 200)
    assert.equal(aRead1.json.dedupHits, 0)

    const aRead2 = await apiFetch('/api/pulse/read-files', {
      method: 'POST',
      body: { sessionId: sessA, files: [{ path: 'pkg/alpha.ts', offset: 1, limit: 100 }] },
    })
    assert.equal(aRead2.status, 200)
    assert.equal(aRead2.json.dedupHits, 1)
    assert.equal(aRead2.json.items[0].deduplicated, true)

    // Session B reads the SAME file X -> MUST NOT falsely get a dedup hit from Session A
    const bRead1 = await apiFetch('/api/pulse/read-files', {
      method: 'POST',
      body: { sessionId: sessB, files: [{ path: 'pkg/alpha.ts', offset: 1, limit: 100 }] },
    })
    assert.equal(bRead1.status, 200)
    assert.equal(bRead1.json.dedupHits, 0)
    assert.equal(bRead1.json.items[0].deduplicated, undefined)

    // Session A creates a spill via oversized exec; Session B executes a distinct small command
    const spillJs =
      'for (let i = 0; i < 400; i++) console.log("ALPHA_SPILL_LINE_" + i + " " + "z".repeat(40));'
    const aSpillExec = await apiFetch('/api/exec', {
      method: 'POST',
      body: {
        sessionId: sessA,
        description: 'Session A oversized spill generator',
        command: `"${process.execPath}" -e "${spillJs.replace(/"/g, '\\"')}"`,
        shell: FAST_SHELL,
      },
    })
    assert.equal(aSpillExec.status, 200)
    assert.equal(aSpillExec.json.stdoutTruncated, true)
    const alphaRefId = aSpillExec.json.refId
    assert.ok(alphaRefId?.startsWith('ref://spill/'))

    const bExec = await apiFetch('/api/exec', {
      method: 'POST',
      body: {
        sessionId: sessB,
        description: 'Session B unique echo activity',
        command: 'echo SESSION_B_ONLY',
        shell: FAST_SHELL,
      },
    })
    assert.equal(bExec.status, 200)

    // Verify isolated telemetry, activities, and spills per session
    const stateA = await apiFetch(`/api/state?sessionId=${encodeURIComponent(sessA)}`)
    const stateB = await apiFetch(`/api/state?sessionId=${encodeURIComponent(sessB)}`)
    assert.equal(stateA.status, 200)
    assert.equal(stateB.status, 200)

    assert.equal(stateA.json.sessionId, sessA)
    assert.equal(stateB.json.sessionId, sessB)
    assert.equal(stateA.json.telemetry.dedupHits, 1)
    assert.equal(stateB.json.telemetry.dedupHits, 0)
    assert.ok(stateA.json.telemetry.totalSavedBytes > stateB.json.telemetry.totalSavedBytes)

    assert.ok(stateA.json.activities.every((a) => a.sessionId === sessA))
    assert.ok(stateB.json.activities.every((a) => a.sessionId === sessB))
    assert.ok(stateA.json.activities.some((a) => a.description === 'Session A oversized spill generator'))
    assert.ok(!stateA.json.activities.some((a) => a.description === 'Session B unique echo activity'))
    assert.ok(stateB.json.activities.some((a) => a.description === 'Session B unique echo activity'))
    assert.ok(!stateB.json.activities.some((a) => a.description === 'Session A oversized spill generator'))

    assert.ok(stateA.json.spills.some((s) => s.refId === alphaRefId))
    assert.equal(stateB.json.spills.some((s) => s.refId === alphaRefId), false)

    // GET /api/sessions lists both sessions
    const sessionsRes = await apiFetch('/api/sessions')
    assert.equal(sessionsRes.status, 200)
    const ids = sessionsRes.json.sessions.map((s) => s.sessionId)
    assert.ok(ids.includes(sessA))
    assert.ok(ids.includes(sessB))

    // GET /api/state?scope=all aggregates both sessions
    const allState = await apiFetch('/api/state?scope=all')
    assert.equal(allState.status, 200)
    assert.equal(allState.json.sessionScope, 'all')
    assert.equal(allState.json.sessionId, 'all')
    assert.ok(
      allState.json.telemetry.totalCalls >=
        stateA.json.telemetry.totalCalls + stateB.json.telemetry.totalCalls,
    )
    assert.ok(
      allState.json.telemetry.totalSavedBytes >=
        stateA.json.telemetry.totalSavedBytes + stateB.json.telemetry.totalSavedBytes,
    )
    assert.ok(allState.json.spills.some((s) => s.refId === alphaRefId))

    // Export Markdown and JSON reports for Session A
    const exportMd = await apiFetch(
      `/api/sessions/${encodeURIComponent(sessA)}/export?format=markdown`,
    )
    assert.equal(exportMd.status, 200)
    assert.equal(exportMd.json.format, 'markdown')
    assert.match(exportMd.json.filename, /^agy-pulse-report-.*\.md$/)
    assert.match(exportMd.json.content, /^# agy-pulse Token-Savings Report/m)
    assert.match(exportMd.json.content, /conv-alpha-0001/)
    assert.match(exportMd.json.content, /Read Deduplication/)

    const exportJson = await apiFetch(
      `/api/sessions/${encodeURIComponent(sessA)}/export?format=json`,
    )
    assert.equal(exportJson.status, 200)
    assert.equal(exportJson.json.format, 'json')
    assert.match(exportJson.json.filename, /^agy-pulse-report-.*\.json$/)
    const parsedExport = JSON.parse(exportJson.json.content)
    assert.equal(parsedExport.sessionId, sessA)
    assert.equal(parsedExport.telemetry.dedupHits, 1)
    assert.equal(typeof parsedExport.reductionPct, 'number')

    // DELETE /api/sessions/conv-alpha-0001 removes Session A AND cleans up its spills
    const delRes = await apiFetch(`/api/sessions/${encodeURIComponent(sessA)}`, {
      method: 'DELETE',
    })
    assert.equal(delRes.status, 200)
    assert.equal(delRes.json.deleted, true)
    assert.ok(delRes.json.releasedSpills >= 1, `Expected releasedSpills >= 1, got ${delRes.json.releasedSpills}`)
    assert.equal(
      delRes.json.sessions.some((s) => s.sessionId === sessA),
      false,
    )

    // Verify alphaRefId spill is truly gone from disk
    const deadPage = await apiFetch('/api/results/page', {
      method: 'POST',
      body: { refId: alphaRefId },
    })
    assert.equal(deadPage.status, 404)

    // Session B remains completely intact
    const stateBAfter = await apiFetch(`/api/state?sessionId=${encodeURIComponent(sessB)}`)
    assert.equal(stateBAfter.status, 200)
    assert.equal(stateBAfter.json.telemetry.totalCalls, stateB.json.telemetry.totalCalls)
  })

  it('prevents stale UI workspaceRoot hints from poisoning hook-bound sessions and optimizes stdout-only spills', async () => {
    const convId = 'conv-anti-poison-01'
    const otherWs = mkdtempSync(join(tmpdir(), 'agy-ops-other-ws-'))
    const otherFile = join(otherWs, 'note.txt')
    writeFileSync(otherFile, 'other workspace content\n', 'utf8')

    try {
      // 1. Bind convId to workspaceDir via authorized-workspaces.json & active-session.json in server dataDir
      const hookBind = await runHook(
        JSON.stringify({
          hookEventName: 'SessionStart',
          conversationId: convId,
          workspacePaths: [workspaceDir],
        }),
        dataDir,
      )
      assert.equal(hookBind.code, 0)

      // 2. Simulate a stale UI iframe sending a different workspaceRoot on /api/state and /api/events
      const staleState = await apiFetch(
        `/api/state?conversationId=${encodeURIComponent(convId)}&workspaceRoot=${encodeURIComponent(otherWs)}`,
      )
      assert.equal(staleState.status, 200)
      const roots = staleState.json.workspaceRoots || []
      assert.equal(
        roots[0]?.toLowerCase(),
        workspaceDir.toLowerCase(),
        `Expected hook-bound workspaceDir first, got ${JSON.stringify(roots)}`,
      )
      assert.ok(
        roots.some((r) => r.toLowerCase() === otherWs.toLowerCase()),
        `Expected hinted otherWs merged alongside workspaceDir, got ${JSON.stringify(roots)}`,
      )

      const stalePoll = await apiFetch(
        `/api/events?conversationId=${encodeURIComponent(convId)}&workspaceRoot=${encodeURIComponent(otherWs)}&since=999999&waitMs=50`,
      )
      assert.equal(stalePoll.status, 200)
      assert.equal(stalePoll.json.changed, false)

      // 3. Relative path in workspaceDir MUST still resolve to workspaceDir (never poisoned to otherWs!)
      const relRead = await apiFetch('/api/pulse/read-files', {
        method: 'POST',
        body: { sessionId: convId, files: [{ path: 'pkg/alpha.ts', offset: 1, limit: 20 }] },
      })
      assert.equal(relRead.status, 200)
      assert.equal(relRead.json.status, 'completed')
      assert.equal(relRead.json.items[0].exists, true)

      // 4. Absolute path inside workspaceDir MUST remain authorized (never WORKDIR_OUTSIDE_WORKSPACE)
      const absRead = await apiFetch('/api/pulse/read-files', {
        method: 'POST',
        body: {
          sessionId: convId,
          files: [{ path: join(workspaceDir, 'pkg', 'alpha.ts'), offset: 1, limit: 20 }],
        },
      })
      assert.equal(absRead.status, 200)
      assert.equal(absRead.json.status, 'completed')

      // 5. Stdout-only spill avoids writing duplicate combined.txt & empty stderr.txt, yet pages all streams + regex search
      const spillScript =
        'for (let i = 0; i < 450; i++) console.log((i === 123 ? "NEEDLE_REGEX_HIT_" : "ROW_") + i + " " + "q".repeat(36));'
      const spillRes = await apiFetch('/api/exec', {
        method: 'POST',
        body: {
          sessionId: convId,
          description: 'Stdout-only spill optimization check',
          command: `"${process.execPath}" -e "${spillScript.replace(/"/g, '\\"')}"`,
          shell: FAST_SHELL,
        },
      })
      assert.equal(spillRes.status, 200)
      const refId = spillRes.json.refId
      assert.ok(refId?.startsWith('ref://spill/'))
      const spillId = refId.slice('ref://spill/'.length)
      assert.equal(existsSync(join(dataDir, 'spills', `${spillId}.stdout.txt`)), true)
      assert.equal(existsSync(join(dataDir, 'spills', `${spillId}.stderr.txt`)), false)
      assert.equal(existsSync(join(dataDir, 'spills', `${spillId}.combined.txt`)), false)

      const combinedSearch = await apiFetch('/api/results/page', {
        method: 'POST',
        body: { refId, stream: 'combined', search: 'NEEDLE_REGEX_HIT_\\d+' },
      })
      assert.equal(combinedSearch.status, 200)
      assert.equal(combinedSearch.json.totalLines, 1)
      assert.match(combinedSearch.json.content, /NEEDLE_REGEX_HIT_123/)

      const emptyStderr = await apiFetch('/api/results/page', {
        method: 'POST',
        body: { refId, stream: 'stderr' },
      })
      assert.equal(emptyStderr.status, 200)
      assert.equal(emptyStderr.json.totalLines, 0)
    } finally {
      rmSync(otherWs, { recursive: true, force: true })
      rmSync(join(dataDir, 'active-session.json'), { force: true })
      rmSync(join(dataDir, 'authorized-workspaces.json'), { force: true })
    }
  })

  it('tracks v0.3.0 outline-read, symbol-read, and git-compact categories with strict honest totalSavedBytes invariant', async () => {
    const v3Sess = 'conv-v3-features-01'

    // 1. Outline read
    const outlineRes = await apiFetch('/api/pulse/read-files', {
      method: 'POST',
      body: {
        sessionId: v3Sess,
        files: [{ path: 'v3-fixtures/metrics.ts', view: 'outline' }],
      },
    })
    assert.equal(outlineRes.status, 200)
    assert.equal(outlineRes.json.status, 'completed')
    assert.equal(outlineRes.json.items[0].view, 'outline')
    assert.ok(outlineRes.json.items[0].fullFileBytes > 0)
    assert.ok(outlineRes.json.savedBytes > 0)
    assert.match(outlineRes.json.items[0].content, /MetricsCalculator/)

    // 2. Symbol read (separate fixture so outline+symbol baseline dedup does not zero out symbol-read)
    const symbolRes = await apiFetch('/api/pulse/read-files', {
      method: 'POST',
      body: {
        sessionId: v3Sess,
        files: [{ path: 'v3-fixtures/helpers.ts', symbol: 'HelperFormatter.formatTag' }],
      },
    })
    assert.equal(symbolRes.status, 200)
    assert.equal(symbolRes.json.status, 'completed')
    assert.equal(symbolRes.json.items[0].view, 'symbol')
    assert.equal(symbolRes.json.items[0].symbol, 'HelperFormatter.formatTag')
    assert.ok(symbolRes.json.savedBytes > 0)
    assert.match(symbolRes.json.items[0].content, /formatTag\(tag: string\)/)

    // 3. Compact git_status (excludes package-lock.json)
    const gitStatusRes = await apiFetch('/api/pulse/search', {
      method: 'POST',
      body: {
        sessionId: v3Sess,
        action: 'git_status',
        path: 'git-demo',
      },
    })
    assert.equal(gitStatusRes.status, 200)
    assert.equal(gitStatusRes.json.status, 'completed')
    assert.equal(gitStatusRes.json.action, 'git_status')
    assert.ok(typeof gitStatusRes.json.gitBranch === 'string' && gitStatusRes.json.gitBranch.length > 0)
    assert.ok(gitStatusRes.json.gitDirtyFiles >= 3)
    assert.ok(gitStatusRes.json.gitSkippedLockfiles.includes('package-lock.json'))
    assert.match(gitStatusRes.json.gitText, /src\/app\.ts/)
    assert.match(gitStatusRes.json.gitText, /skipped 1 lockfile/)

    // 4. Compact git_diff (excludes package-lock.json and avoids its massive byte cost)
    const gitDiffRes = await apiFetch('/api/pulse/search', {
      method: 'POST',
      body: {
        sessionId: v3Sess,
        action: 'git_diff',
        path: 'git-demo',
      },
    })
    assert.equal(gitDiffRes.status, 200)
    assert.equal(gitDiffRes.json.status, 'completed')
    assert.equal(gitDiffRes.json.action, 'git_diff')
    assert.ok(gitDiffRes.json.gitSkippedLockfiles.includes('package-lock.json'))
    assert.match(gitDiffRes.json.gitText, /=== src\/app\.ts/)
    assert.match(gitDiffRes.json.gitText, /\+  return `Welcome, \$\{name\}!`/)
    assert.equal(gitDiffRes.json.gitText.includes('sha512-updated-hash'), false)
    assert.ok(
      gitDiffRes.json.savedBytes > 2000,
      `Expected git_diff to avoid >2KB lockfile bytes, got ${gitDiffRes.json.savedBytes}`,
    )

    // Verify all 3 new telemetry categories + strict honest sum invariant
    const telRes = await apiFetch(`/api/telemetry?sessionId=${encodeURIComponent(v3Sess)}`)
    assert.equal(telRes.status, 200)
    const t = telRes.json.telemetry
    assert.ok(t.byCategory['outline-read'].calls >= 1)
    assert.ok(t.byCategory['outline-read'].savedBytes > 0)
    assert.ok(t.byCategory['symbol-read'].calls >= 1)
    assert.ok(t.byCategory['symbol-read'].savedBytes > 0)
    assert.ok(t.byCategory['git-compact'].calls >= 1)
    assert.ok(t.byCategory['git-compact'].savedBytes > 2000)

    const categorySavedSum = Object.values(t.byCategory).reduce((acc, c) => acc + c.savedBytes, 0)
    assert.equal(
      t.totalSavedBytes,
      categorySavedSum,
      `Honest invariant violated: totalSavedBytes (${t.totalSavedBytes}) !== sum(byCategory) (${categorySavedSum})`,
    )
    assert.ok(t.estimatedTokensSaved > 0)
  })

  it('auto-prunes oldest LRU sessions and their on-disk files when exceeding sessionMaxCount', async () => {
    const sessionsDir = join(dataDir, 'sessions')

    // Set sessionMaxCount to 5
    const cfgRes = await apiFetch('/api/config', {
      method: 'PUT',
      body: { sessionMaxCount: 5 },
    })
    assert.equal(cfgRes.status, 200)
    assert.equal(cfgRes.json.config.sessionMaxCount, 5)

    try {
      const gcIds = Array.from({ length: 7 }, (_, i) => `conv-gc-lru-0${i + 1}`)

      // Create the first 5 sessions with spaced timestamps and let debounced persistence flush them to disk
      for (let i = 0; i < 5; i++) {
        const res = await apiFetch('/api/pulse/read-files', {
          method: 'POST',
          body: {
            sessionId: gcIds[i],
            files: [{ path: 'v3-fixtures/metrics.ts', view: 'outline' }],
          },
        })
        assert.equal(res.status, 200)
        await new Promise((r) => setTimeout(r, 25))
      }

      // Wait for debounced disk persistence (300ms debounce) so all 5 JSON files exist on disk
      await new Promise((r) => setTimeout(r, 500))
      for (let i = 0; i < 5; i++) {
        assert.equal(
          existsSync(join(sessionsDir, `${gcIds[i]}.json`)),
          true,
          `Expected persisted session file ${gcIds[i]}.json to exist before GC`,
        )
      }

      // Create 2 more sessions (total 7 created > cap 5) -> oldest 2 MUST be auto-pruned from memory & disk
      for (let i = 5; i < 7; i++) {
        const res = await apiFetch('/api/pulse/read-files', {
          method: 'POST',
          body: {
            sessionId: gcIds[i],
            files: [{ path: 'v3-fixtures/metrics.ts', view: 'outline' }],
          },
        })
        assert.equal(res.status, 200)
        await new Promise((r) => setTimeout(r, 25))
      }

      await new Promise((r) => setTimeout(r, 450))

      const listRes = await apiFetch('/api/sessions')
      assert.equal(listRes.status, 200)
      assert.ok(
        listRes.json.sessions.length <= 5,
        `Expected <= 5 sessions after LRU GC, got ${listRes.json.sessions.length}`,
      )

      const remainingIds = new Set(listRes.json.sessions.map((s) => s.sessionId))
      assert.equal(remainingIds.has(gcIds[0]), false, `Oldest session ${gcIds[0]} should have been pruned`)
      assert.equal(remainingIds.has(gcIds[1]), false, `Second oldest session ${gcIds[1]} should have been pruned`)
      assert.equal(remainingIds.has(gcIds[5]), true, `Newest session ${gcIds[5]} should remain`)
      assert.equal(remainingIds.has(gcIds[6]), true, `Newest session ${gcIds[6]} should remain`)

      assert.equal(
        existsSync(join(sessionsDir, `${gcIds[0]}.json`)),
        false,
        `Pruned session file ${gcIds[0]}.json must be removed from disk`,
      )
      assert.equal(
        existsSync(join(sessionsDir, `${gcIds[1]}.json`)),
        false,
        `Pruned session file ${gcIds[1]}.json must be removed from disk`,
      )

      const diskFiles = existsSync(sessionsDir)
        ? readdirSync(sessionsDir).filter((f) => f.endsWith('.json'))
        : []
      assert.ok(diskFiles.length <= 5, `Expected <= 5 session files on disk, got ${diskFiles.length}`)
    } finally {
      await apiFetch('/api/config/reset', { method: 'POST', body: {} })
    }
  })

  it('v0.4.0: supports subset line-range read dedup, skips dedup on spilled truncated reads, spills oversized mutate diffs, and auto-advances pulse_job wait cursor', async () => {
    const sess = 'conv-v031-regression'

    // 1. Subset interval Read-Dedup: read L1-L120, then request subset L20-L70 -> dedup hit
    const rangeLines = Array.from({ length: 120 }, (_, i) => `export const line_${i + 1} = ${i + 1}; // pad`).join('\n') + '\n'
    writeFileSync(join(workspaceDir, 'v3-fixtures', 'subset-dedup.ts'), rangeLines, 'utf8')

    const readFull = await apiFetch('/api/pulse/read-files', {
      method: 'POST',
      body: { sessionId: sess, files: [{ path: 'v3-fixtures/subset-dedup.ts', offset: 1, limit: 120 }] },
    })
    assert.equal(readFull.status, 200)
    assert.equal(readFull.json.dedupHits, 0)
    assert.notEqual(readFull.json.items[0].truncated, true)

    const readSubset = await apiFetch('/api/pulse/read-files', {
      method: 'POST',
      body: { sessionId: sess, files: [{ path: 'v3-fixtures/subset-dedup.ts', offset: 20, limit: 50 }] },
    })
    assert.equal(readSubset.status, 200)
    assert.equal(readSubset.json.dedupHits, 1)
    assert.equal(readSubset.json.items[0].deduplicated, true)
    assert.ok(readSubset.json.savedBytes > 0)

    // 2. Truncated spilled read must NOT falsely mark unread tail lines as already read
    const hugeLines = Array.from({ length: 280 }, (_, i) => `LINE_${String(i + 1).padStart(3, '0')}: ${'x'.repeat(58)}`).join('\n') + '\n'
    writeFileSync(join(workspaceDir, 'v3-fixtures', 'huge-spill.txt'), hugeLines, 'utf8')

    const readHuge = await apiFetch('/api/pulse/read-files', {
      method: 'POST',
      body: { sessionId: sess, files: [{ path: 'v3-fixtures/huge-spill.txt', offset: 1, limit: 280 }] },
    })
    assert.equal(readHuge.status, 200)
    assert.ok(readHuge.json.refId?.startsWith('ref://spill/'))
    assert.match(readHuge.json.items[0].content, /truncated/i)

    const readTail = await apiFetch('/api/pulse/read-files', {
      method: 'POST',
      body: { sessionId: sess, files: [{ path: 'v3-fixtures/huge-spill.txt', offset: 220, limit: 30 }] },
    })
    assert.equal(readTail.status, 200)
    assert.equal(readTail.json.dedupHits, 0)
    assert.notEqual(readTail.json.items[0].deduplicated, true)
    assert.match(readTail.json.items[0].content, /LINE_220:/)

    // 3. Oversized pulse_mutate diff spills cleanly to SpillStore and keeps honest telemetry sum
    const origMutate = Array.from({ length: 140 }, (_, i) => `old_entry_${i} = "${'a'.repeat(70)}"`).join('\n') + '\n'
    const nextMutate = Array.from({ length: 140 }, (_, i) => `new_entry_${i} = "${'b'.repeat(70)}"`).join('\n') + '\n'
    writeFileSync(join(workspaceDir, 'v3-fixtures', 'big-mutate.txt'), origMutate, 'utf8')

    const bigDiff = await apiFetch('/api/pulse/mutate', {
      method: 'POST',
      body: { sessionId: sess, action: 'diff', path: 'v3-fixtures/big-mutate.txt', content: nextMutate },
    })
    assert.equal(bigDiff.status, 200)
    assert.equal(bigDiff.json.status, 'planned')
    assert.ok(bigDiff.json.refId?.startsWith('ref://spill/'), `Expected oversized mutate diff to spill, got refId=${bigDiff.json.refId}`)
    assert.ok(Buffer.byteLength(bigDiff.json.diff || '', 'utf8') <= 8_200)

    const tel = (await apiFetch(`/api/telemetry?sessionId=${encodeURIComponent(sess)}`)).json.telemetry
    const sumByCat = Object.values(tel.byCategory).reduce((acc, c) => acc + c.savedBytes, 0)
    assert.equal(tel.totalSavedBytes, sumByCat)

    // 4. pulse_job wait=true without explicit offsets auto-advances cursor and blocks for new output
    const stepScript = join(workspaceDir, 'job-cursor-v031.mjs')
    writeFileSync(
      stepScript,
      'console.log("CURSOR_STEP_1");\nsetTimeout(() => { console.log("CURSOR_STEP_2"); process.exit(0); }, 450);\n',
      'utf8',
    )
    const started = await apiFetch('/api/exec', {
      method: 'POST',
      body: {
        sessionId: sess,
        description: 'Verify job wait auto-cursor',
        command: `"${process.execPath}" "${stepScript}"`,
        shell: FAST_SHELL,
        runInBackground: true,
      },
    })
    assert.equal(started.status, 200)
    const jobId = started.json.jobId
    assert.ok(jobId)

    const firstPoll = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}/output`, {
      method: 'POST',
      body: { wait: true, waitTimeoutMs: 4000 },
    })
    assert.equal(firstPoll.status, 200)
    assert.match(firstPoll.json.stdout, /CURSOR_STEP_1/)

    // Second call omits stdoutOffset/stderrOffset -> must NOT immediately replay CURSOR_STEP_1
    const secondStart = Date.now()
    const secondPoll = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}/output`, {
      method: 'POST',
      body: { wait: true, waitTimeoutMs: 4000 },
    })
    const secondElapsed = Date.now() - secondStart
    assert.equal(secondPoll.status, 200)
    assert.equal(secondPoll.json.stdout.includes('CURSOR_STEP_1'), false, 'Second wait poll must not replay already-read STEP_1')
    assert.match(secondPoll.json.stdout, /CURSOR_STEP_2/)
    assert.ok(secondElapsed >= 150, `Expected second wait poll to block until STEP_2 arrived, elapsed=${secondElapsed}ms`)
  })

  it('v0.4.1: supports X-Pulse-Cwd/body.cwd with workspace jail, coalesces pulse_job wait exit, and avoids symbol baseline double-counting', async () => {
    const sess = 'conv-v041-server-fixes'

    // 1. Per-request cwd via X-Pulse-Cwd header and body.cwd on /api/pulse/* and /api/exec
    const cwdSub = join(workspaceDir, 'cwd-sub')
    mkdirSync(join(cwdSub, 'nested'), { recursive: true })
    writeFileSync(join(cwdSub, 'nested', 'hello.txt'), 'HELLO_FROM_CWD_SUB\n', 'utf8')

    const cwdRead = await apiFetch('/api/pulse/read-files', {
      method: 'POST',
      headers: { 'X-Pulse-Cwd': cwdSub },
      body: { sessionId: sess, files: [{ path: 'nested/hello.txt' }] },
    })
    assert.equal(cwdRead.status, 200)
    assert.equal(cwdRead.json.items[0].exists, true)
    assert.match(cwdRead.json.items[0].content, /HELLO_FROM_CWD_SUB/)

    const cwdSearch = await apiFetch('/api/pulse/search', {
      method: 'POST',
      body: { sessionId: sess, cwd: cwdSub, action: 'glob', pattern: '**/*.txt' },
    })
    assert.equal(cwdSearch.status, 200)
    assert.equal(cwdSearch.json.totalMatched, 1)
    assert.match(cwdSearch.json.entries[0].path, /nested[\\/]hello\.txt/)

    const cwdExec = await apiFetch('/api/exec', {
      method: 'POST',
      headers: { 'X-Pulse-Cwd': cwdSub },
      body: {
        sessionId: sess,
        description: 'Verify X-Pulse-Cwd default exec workdir',
        command: `"${process.execPath}" -e "console.log(process.cwd())"`,
        shell: FAST_SHELL,
      },
    })
    assert.equal(cwdExec.status, 200)
    assert.equal(cwdExec.json.cwd.toLowerCase(), cwdSub.toLowerCase())
    assert.ok(cwdExec.json.stdout.toLowerCase().includes('cwd-sub'))

    // Workspace jail enforcement: cwd outside authorized workspace roots MUST be rejected
    const outsideDir = mkdtempSync(join(tmpdir(), 'agy-pulse-outside-cwd-'))
    try {
      const outsideRes = await apiFetch('/api/pulse/read-files', {
        method: 'POST',
        headers: { 'X-Pulse-Cwd': outsideDir },
        body: { sessionId: sess, files: [{ path: 'v3-fixtures/metrics.ts', offset: 1, limit: 5 }] },
      })
      assert.equal(outsideRes.status, 403)
      assert.equal(outsideRes.json.code, 'WORKDIR_OUTSIDE_WORKSPACE')
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }

    // 2. pulse_job wait=true coalesces child close immediately after final stdout chunk (no extra poll)
    const fastExitScript = join(workspaceDir, 'job-exit-coalesce.mjs')
    writeFileSync(
      fastExitScript,
      'setTimeout(() => { console.log("FINAL_CHUNK_OK"); process.exit(0); }, 150);\n',
      'utf8',
    )
    const bgStarted = await apiFetch('/api/exec', {
      method: 'POST',
      body: {
        sessionId: sess,
        description: 'Verify job exit coalescing on wait',
        command: `"${process.execPath}" "${fastExitScript}"`,
        shell: FAST_SHELL,
        runInBackground: true,
      },
    })
    assert.equal(bgStarted.status, 200)
    const exitPoll = await apiFetch(`/api/jobs/${encodeURIComponent(bgStarted.json.jobId)}/output`, {
      method: 'POST',
      body: { wait: true, waitTimeoutMs: 4000 },
    })
    assert.equal(exitPoll.status, 200)
    assert.match(exitPoll.json.stdout, /FINAL_CHUNK_OK/)
    assert.equal(exitPoll.json.job.status, 'completed')
    assert.equal(exitPoll.json.job.exitCode, 0)
    assert.equal(exitPoll.json.eof, true)

    // 3. Honest symbol/outline fullFileBytes baseline tracking (credits once per path+revision)
    const symSess = 'conv-v041-symbol-baseline'
    const sym1 = await apiFetch('/api/pulse/read-files', {
      method: 'POST',
      body: {
        sessionId: symSess,
        files: [{ path: 'v3-fixtures/metrics.ts', symbol: 'MetricsCalculator.computeHeavy' }],
      },
    })
    assert.equal(sym1.status, 200)
    assert.ok(sym1.json.savedBytes > 0)

    // Second symbol + outline on the SAME (path, revision) must NOT re-credit fullFileBytes
    const sym2 = await apiFetch('/api/pulse/read-files', {
      method: 'POST',
      body: {
        sessionId: symSess,
        files: [{ path: 'v3-fixtures/metrics.ts', symbol: 'MetricsCalculator.formatLabel' }],
      },
    })
    assert.equal(sym2.status, 200)
    assert.equal(sym2.json.savedBytes, 0)
    assert.equal(sym2.json.rawBytes, sym2.json.deliveredBytes)

    const outlineAfter = await apiFetch('/api/pulse/read-files', {
      method: 'POST',
      body: {
        sessionId: symSess,
        files: [{ path: 'v3-fixtures/metrics.ts', view: 'outline' }],
      },
    })
    assert.equal(outlineAfter.status, 200)
    assert.equal(outlineAfter.json.savedBytes, 0)

    const telBeforeReset = (await apiFetch(`/api/telemetry?sessionId=${encodeURIComponent(symSess)}`)).json.telemetry
    const fullSize = statSync(join(workspaceDir, 'v3-fixtures', 'metrics.ts')).size
    assert.ok(
      telBeforeReset.totalRawBytes < fullSize * 2,
      `Expected cumulative rawBytes (${telBeforeReset.totalRawBytes}) not to double-count fullFileBytes (${fullSize})`,
    )
    const catSum = Object.values(telBeforeReset.byCategory).reduce((acc, c) => acc + c.savedBytes, 0)
    assert.equal(telBeforeReset.totalSavedBytes, catSum)

    // After session telemetry reset, baseline tracking clears and credits cleanly again
    await apiFetch('/api/telemetry/reset', { method: 'POST', body: { sessionId: symSess } })
    const symAfterReset = await apiFetch('/api/pulse/read-files', {
      method: 'POST',
      body: {
        sessionId: symSess,
        files: [{ path: 'v3-fixtures/metrics.ts', symbol: 'readFirstLine' }],
      },
    })
    assert.equal(symAfterReset.status, 200)
    assert.ok(symAfterReset.json.savedBytes > 0)
  })

  it('v0.4.2: tracks real-time conversation context window from transcript.jsonl and exposes contextWindow in /api/state', async () => {
    // 1. Unit checks for model label formatting & estimated context limits
    assert.equal(formatModelLabel('gemini-4-neon-high'), 'Gemini 4 Neon (High)')
    assert.equal(formatModelLabel('gemini-4-neon-xhigh'), 'Gemini 4 Neon (XHigh)')
    assert.equal(formatModelLabel('claude-sonnet-4-5'), 'Claude Sonnet 4.5')
    assert.equal(formatModelLabel('gpt-4o'), 'GPT-4o')

    assert.deepEqual(resolveModelContextLimit('gemini-1.5-pro-002'), { limit: 2_000_000, estimated: true })
    assert.deepEqual(resolveModelContextLimit('gemini-4-hydrogen-high'), { limit: 1_000_000, estimated: true })
    assert.deepEqual(resolveModelContextLimit('claude-sonnet-4-5'), { limit: 200_000, estimated: true })
    assert.deepEqual(resolveModelContextLimit('claude-opus-4-1m'), { limit: 1_000_000, estimated: true })
    assert.deepEqual(resolveModelContextLimit('gpt-4.1-mini'), { limit: 1_000_000, estimated: true })
    assert.deepEqual(resolveModelContextLimit('gpt-5'), { limit: 400_000, estimated: true })
    assert.deepEqual(resolveModelContextLimit('gpt-4o'), { limit: 128_000, estimated: true })
    assert.deepEqual(resolveModelContextLimit('o3-mini'), { limit: 200_000, estimated: true })
    assert.deepEqual(resolveModelContextLimit('my-custom-local-model'), { limit: null, estimated: false })

    // 2. Multi-turn JSONL fixture with compaction drop & malformed trailing line
    const convCtxId = 'conv-v042-context-window'
    const transcriptFile = join(workspaceDir, 'v3-fixtures', 'sample-transcript.jsonl')
    const jsonlLines = [
      JSON.stringify({ type: 'USER_INPUT', text: 'hello' }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-neon-high',
        input_tokens: 12_000,
        cache_read_tokens: 0,
        output_tokens: 500,
        created_at: '2026-11-25T10:00:00Z',
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-neon-high',
        input_tokens: 5_000,
        cache_read_tokens: 340_000,
        output_tokens: 1_500,
        created_at: '2026-11-25T10:01:00Z',
      }),
      // Simulate context compaction on turn 3 (peak 346,500 > current 101,000)
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-neon-high',
        input_tokens: 4_000,
        cache_read_tokens: 96_000,
        output_tokens: 1_000,
        created_at: '2026-11-25T10:02:00Z',
      }),
      '{"type":"PLANNER_RESPONSE","input_tokens":999_MALFORMED_MID_WRITE',
    ]
    writeFileSync(transcriptFile, `${jsonlLines.join('\n')}\n`, 'utf8')

    const parsed = readConversationContextUsage(convCtxId, dataDir, transcriptFile)
    assert.ok(parsed)
    assert.equal(parsed.available, true)
    assert.equal(parsed.conversationId, convCtxId)
    assert.equal(parsed.model, 'gemini-4-neon-high')
    assert.equal(parsed.modelLabel, 'Gemini 4 Neon (High)')
    assert.equal(parsed.uncachedInputTokens, 4_000)
    assert.equal(parsed.cacheReadTokens, 96_000)
    assert.equal(parsed.promptTokens, 100_000)
    assert.equal(parsed.lastOutputTokens, 1_000)
    assert.equal(parsed.contextTokens, 101_000)
    assert.equal(parsed.cacheHitPct, 96)
    assert.equal(parsed.contextLimit, 1_000_000)
    assert.equal(parsed.limitEstimated, true)
    assert.equal(parsed.usagePct, 10.1)
    assert.equal(parsed.remainingTokens, 899_000)
    assert.equal(parsed.peakContextTokens, 346_500)
    assert.equal(parsed.totalOutputTokens, 3_000)
    assert.equal(parsed.turnCount, 3)
    assert.equal(parsed.lastTurnDeltaTokens, 101_000 - 346_500)
    assert.equal(parsed.timeline.length, 3)
    assert.deepEqual(
      parsed.timeline.map((p) => ({ turn: p.turn, contextTokens: p.contextTokens })),
      [
        { turn: 1, contextTokens: 12_500 },
        { turn: 2, contextTokens: 346_500 },
        { turn: 3, contextTokens: 101_000 },
      ],
    )
    assert.ok(parsed.timeline[0].ts > 0)

    // >120 turn timeline downsampling preserves turn 1, peak, compaction drop, and final turn <= 120 points
    const longFile = join(workspaceDir, 'v3-fixtures', 'long-transcript.jsonl')
    const longLines = []
    for (let t = 1; t <= 185; t++) {
      let input = 2_000
      let cache = t * 3_000
      if (t === 90) {
        // Global peak at turn 90
        input = 10_000
        cache = 700_000
      } else if (t === 91) {
        // Sharp compaction drop at turn 91 (< 85% of 710,500)
        input = 2_000
        cache = 120_000
      } else if (t > 91) {
        cache = 120_000 + (t - 91) * 2_000
      }
      longLines.push(
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-neon-high',
          input_tokens: input,
          cache_read_tokens: cache,
          output_tokens: 500,
        }),
      )
    }
    writeFileSync(longFile, `${longLines.join('\n')}\n`, 'utf8')
    const longUsage = readConversationContextUsage('conv-long-timeline', dataDir, longFile)
    assert.ok(longUsage)
    assert.equal(longUsage.turnCount, 185)
    assert.ok(longUsage.timeline.length <= 120)
    assert.equal(longUsage.timeline[0].turn, 1)
    assert.equal(longUsage.timeline[longUsage.timeline.length - 1].turn, 185)
    assert.ok(longUsage.timeline.some((p) => p.turn === 90 && p.contextTokens === longUsage.peakContextTokens))
    assert.ok(longUsage.timeline.some((p) => p.turn === 91 && p.contextTokens === 122_500))
    for (let i = 1; i < longUsage.timeline.length; i++) {
      assert.ok(longUsage.timeline[i].turn > longUsage.timeline[i - 1].turn)
    }

    // Unknown model returns contextLimit: null without crashing
    const unknownFile = join(workspaceDir, 'v3-fixtures', 'unknown-transcript.jsonl')
    writeFileSync(
      unknownFile,
      `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        model: 'custom-local-llm',
        input_tokens: 1_500,
        cache_read_tokens: 500,
        output_tokens: 250,
      })}\n`,
      'utf8',
    )
    const unknownUsage = readConversationContextUsage('conv-unknown-model', dataDir, unknownFile)
    assert.ok(unknownUsage)
    assert.equal(unknownUsage.available, true)
    assert.equal(unknownUsage.contextLimit, null)
    assert.equal(unknownUsage.usagePct, null)
    assert.equal(unknownUsage.remainingTokens, null)
    assert.equal(unknownUsage.contextTokens, 2_250)

    // 3. Hook persists transcriptPath and /api/state exposes contextWindow
    const hookRes = await runHook(
      JSON.stringify({
        hookEventName: 'SessionStart',
        conversationId: convCtxId,
        workspacePaths: [workspaceDir],
        transcriptPath: transcriptFile,
      }),
      dataDir,
    )
    assert.equal(hookRes.code, 0)

    try {
      const stateRes = await apiFetch(`/api/state?sessionId=${encodeURIComponent(convCtxId)}`)
      assert.equal(stateRes.status, 200)
      assert.ok(stateRes.json.contextWindow, 'Expected /api/state to include contextWindow')
      assert.equal(stateRes.json.contextWindow.available, true)
      assert.equal(stateRes.json.contextWindow.conversationId, convCtxId)
      assert.equal(stateRes.json.contextWindow.contextTokens, 101_000)
      assert.equal(stateRes.json.contextWindow.peakContextTokens, 346_500)
      assert.equal(stateRes.json.contextWindow.turnCount, 3)
    } finally {
      rmSync(join(dataDir, 'active-session.json'), { force: true })
      rmSync(join(dataDir, 'authorized-workspaces.json'), { force: true })
      rmSync(join(dataDir, 'session-transcripts.json'), { force: true })
    }
  })

  it('v0.5.0: exposes snapshotVersion/hostHealth/notices, strict PATCH /api/config, session-scoped /api/jobs, and WS conversation scoping', async () => {
    // 1. State snapshot includes snapshotVersion=1, daemonVersion=1.0.0, hostHealth, and notices
    const stateRes = await apiFetch('/api/state')
    assert.equal(stateRes.status, 200)
    assert.equal(stateRes.json.snapshotVersion, 1)
    assert.equal(stateRes.json.daemonVersion, '1.0.0')
    assert.ok(stateRes.json.hostHealth && typeof stateRes.json.hostHealth.checkedAt === 'number')
    assert.ok(Array.isArray(stateRes.json.notices))

    // 2. GET /api/host-health returns HostHealthSnapshot
    const hhRes = await apiFetch('/api/host-health')
    assert.equal(hhRes.status, 200)
    assert.ok(hhRes.json.hostHealth && Array.isArray(hhRes.json.hostHealth.entries))

    // 3. PATCH /api/config accepts valid fields and rejects unknown keys with 400
    const badPatch = await apiFetch('/api/config', {
      method: 'PATCH',
      body: { nonExistentOption: 42 },
    })
    assert.equal(badPatch.status, 400)
    assert.equal(badPatch.json.code, 'INVALID_CONFIG')

    const goodPatch = await apiFetch('/api/config', {
      method: 'PATCH',
      body: { maxInlineBytes: 7_400 },
    })
    assert.equal(goodPatch.status, 200)
    assert.equal(goodPatch.json.config.maxInlineBytes, 7_400)
    await apiFetch('/api/config/reset', { method: 'POST', body: {} })

    // 4. Session-scoped /api/jobs
    const sessA = 'conv-v05-jobs-a'
    const sessB = 'conv-v05-jobs-b'
    let jobAId = ''
    let jobBId = ''
    let wsA = null
    let wsAll = null
    try {
      const jobA = await apiFetch('/api/exec', {
        method: 'POST',
        body: {
          description: 'Job A background',
          command: 'echo jobA',
          runInBackground: true,
          sessionId: sessA,
        },
      })
      const jobB = await apiFetch('/api/exec', {
        method: 'POST',
        body: {
          description: 'Job B background',
          command: 'echo jobB',
          runInBackground: true,
          sessionId: sessB,
        },
      })
      assert.equal(jobA.status, 200)
      assert.equal(jobB.status, 200)
      jobAId = jobA.json.jobId
      jobBId = jobB.json.jobId

      const listA = await apiFetch(`/api/jobs?conversationId=${encodeURIComponent(sessA)}`)
      assert.equal(listA.status, 200)
      assert.ok(listA.json.jobs.some((j) => j.id === jobAId))
      assert.ok(!listA.json.jobs.some((j) => j.id === jobBId))

      const listAll = await apiFetch(
        `/api/jobs?conversationId=${encodeURIComponent(sessA)}&scope=all`,
      )
      assert.equal(listAll.status, 200)
      assert.ok(listAll.json.jobs.some((j) => j.id === jobAId))
      assert.ok(listAll.json.jobs.some((j) => j.id === jobBId))

      // 5. WebSocket scoping: socket bound to sessA does NOT receive sessB activity/telemetry
      const wsAEvents = []
      const wsAllEvents = []
      wsA = new WebSocket(
        `ws://127.0.0.1:${discovery.port}/ws?token=${encodeURIComponent(token)}&conversationId=${encodeURIComponent(sessA)}`,
      )
      wsAll = new WebSocket(
        `ws://127.0.0.1:${discovery.port}/ws?token=${encodeURIComponent(token)}&scope=all`,
      )
      await Promise.all([
        new Promise((resolve, reject) => {
          wsA.once('open', resolve)
          wsA.once('error', reject)
        }),
        new Promise((resolve, reject) => {
          wsAll.once('open', resolve)
          wsAll.once('error', reject)
        }),
      ])
      wsA.on('message', (d) => {
        try {
          wsAEvents.push(JSON.parse(String(d)))
        } catch {
          // ignore
        }
      })
      wsAll.on('message', (d) => {
        try {
          wsAllEvents.push(JSON.parse(String(d)))
        } catch {
          // ignore
        }
      })

      await apiFetch('/api/pulse/read-files', {
        method: 'POST',
        body: {
          files: [{ path: join(workspaceDir, 'hello.txt') }],
          sessionId: sessB,
        },
      })
      await new Promise((r) => setTimeout(r, 150))
      assert.ok(
        wsAllEvents.some((ev) => ev.type === 'activity-event' && ev.item?.sessionId === sessB),
        'scope=all WS client should receive sessB activity',
      )
      assert.ok(
        !wsAEvents.some((ev) => ev.type === 'activity-event' && ev.item?.sessionId === sessB),
        'sessA-scoped WS client must NOT receive sessB activity',
      )
    } finally {
      wsA?.close()
      wsAll?.close()
      if (jobAId) {
        await apiFetch(`/api/jobs/${encodeURIComponent(jobAId)}/kill`, { method: 'POST', body: {} }).catch(() => {})
      }
      if (jobBId) {
        await apiFetch(`/api/jobs/${encodeURIComponent(jobBId)}/kill`, { method: 'POST', body: {} }).catch(() => {})
      }
    }
  })
})
