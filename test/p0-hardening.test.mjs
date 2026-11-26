import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { validateConfigPatch } from '../src/server/config.ts'
import { discoverShells } from '../src/server/shells.ts'
import { RustWorker } from '../src/server/rust-worker.ts'
import { SpillStore } from '../src/server/spill-store.ts'
import { resolveWorkspaceRoots } from '../src/server/workspace.ts'
import {
  capUtf8Text,
  formatExecOutcome,
  formatMutate,
  renderCodeFence,
} from '../src/mcp/format.ts'
import { normalizeWorkdir, normalizeWorkerPath } from '../src/shared/paths.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const IS_WIN = process.platform === 'win32'
const SERVER_ENTRY = join(ROOT, 'sidecars', 'pulse', 'dist', 'server.mjs')
const DIST_WORKER_BIN = join(
  ROOT,
  'sidecars',
  'pulse',
  'dist',
  IS_WIN ? 'agy-pulse-worker.exe' : 'agy-pulse-worker',
)

async function waitForFile(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const text = readFileSync(filePath, 'utf8').trim()
      if (text.length > 0) return text
    }
    await new Promise((r) => setTimeout(r, 60))
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((r) => child.once('exit', r))
  try {
    child.kill('SIGTERM')
  } catch {
    // Ignore.
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

describe('P0 Hardening & Bug-Fix Regression Suite', () => {
  let wsDir
  let binDir
  let workerBin
  let worker

  before(() => {
    assert.equal(existsSync(DIST_WORKER_BIN), true, `Missing worker at ${DIST_WORKER_BIN}`)
    wsDir = mkdtempSync(join(tmpdir(), 'agy-pulse-p0-ws-'))
    if (IS_WIN) {
      binDir = mkdtempSync(join(tmpdir(), 'agy-pulse-p0-bin-'))
      workerBin = join(binDir, 'agy-pulse-worker.exe')
      copyFileSync(DIST_WORKER_BIN, workerBin)
    } else {
      workerBin = DIST_WORKER_BIN
    }
    worker = new RustWorker(workerBin)

    mkdirSync(join(wsDir, 'sub', 'empty-dir'), { recursive: true })
    mkdirSync(join(wsDir, 'copy-src'), { recursive: true })
    mkdirSync(join(wsDir, '.gnupg'), { recursive: true })
    writeFileSync(join(wsDir, 'sub', 'hello.txt'), 'alpha = 1\nbeta = 2\ngamma = 3\n', 'utf8')
    writeFileSync(
      join(wsDir, 'bytes48.bin'),
      Buffer.from(Array.from({ length: 48 }, (_, i) => i)),
    )
    writeFileSync(join(wsDir, '.gnupg', 'secring.gpg'), 'SECRET', 'utf8')
    writeFileSync(join(wsDir, 'id_ecdsa'), 'SECRET', 'utf8')
    writeFileSync(join(wsDir, 'id_dsa'), 'SECRET', 'utf8')
    writeFileSync(join(wsDir, 'cert.p12'), 'SECRET', 'utf8')
    writeFileSync(join(wsDir, 'cert.pfx'), 'SECRET', 'utf8')
    writeFileSync(join(wsDir, 'service_account_prod.json'), '{}', 'utf8')
    writeFileSync(join(wsDir, 'serviceaccount.json'), '{}', 'utf8')
    writeFileSync(join(wsDir, 'copy-src', 'ok.txt'), 'safe\n', 'utf8')
    writeFileSync(join(wsDir, 'copy-src', '.env'), 'API_KEY=secret\n', 'utf8')
  })

  after(async () => {
    worker?.dispose()
    if (IS_WIN) {
      await new Promise((r) => setTimeout(r, 80))
    }
    rmSync(wsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    if (binDir) {
      rmSync(binDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('runs persistent --daemon Rust worker across consecutive calls and exits cleanly on EOF', async () => {
    const opts = { roots: [wsDir], credentialFence: true, maxInlineBytes: 7800 }
    const [r1, r2, r3] = await Promise.all([
      worker.invoke('stat', { path: 'sub/hello.txt' }, opts),
      worker.invoke('read_files', { files: [{ path: 'sub/hello.txt', offset: 1, limit: 10 }] }, opts),
      worker.invoke('glob', { pattern: ['sub/**/*'] }, opts),
    ])
    assert.equal(r1.ok, true)
    assert.equal(r1.result.exists, true)
    assert.equal(r2.ok, true)
    assert.match(r2.result.items[0].content, /alpha = 1/)
    assert.equal(r3.ok, true)
    assert.equal(r3.result.totalMatched, 1)
  })

  it('supports pulse_mutate diff with edits without modifying the file on disk', async () => {
    const opts = { roots: [wsDir], credentialFence: true, maxInlineBytes: 7800 }
    const diffRes = await worker.invoke(
      'diff',
      {
        path: 'sub/hello.txt',
        edits: [{ oldText: 'beta = 2', newText: 'beta = 200' }],
      },
      opts,
    )
    assert.equal(diffRes.ok, true)
    assert.equal(diffRes.result.addedLines, 1)
    assert.equal(diffRes.result.removedLines, 1)
    assert.match(diffRes.result.diff, /\+beta = 200/)
    assert.notEqual(diffRes.result.beforeRevision, diffRes.result.afterRevision)
    // File on disk must remain untouched.
    assert.match(readFileSync(join(wsDir, 'sub', 'hello.txt'), 'utf8'), /beta = 2\n/)

    // Providing both content and edits must be rejected.
    const bothRes = await worker.invoke(
      'diff',
      {
        path: 'sub/hello.txt',
        content: 'x',
        edits: [{ oldText: 'beta = 2', newText: 'beta = 3' }],
      },
      opts,
    )
    assert.equal(bothRes.ok, false)
    assert.equal(bothRes.failure.code, 'INVALID_ARGUMENT')
  })

  it('interprets view: "hex" offset and limit as 0-based bytes (matching schema)', async () => {
    const opts = { roots: [wsDir], credentialFence: true, maxInlineBytes: 7800 }

    // Default omitted offset starts at byte 0.
    const fromStart = await worker.invoke(
      'read_files',
      { files: [{ path: 'bytes48.bin', view: 'hex', limit: 16 }] },
      opts,
    )
    assert.equal(fromStart.ok, true)
    assert.equal(fromStart.result.items[0].offset, 0)
    assert.equal(fromStart.result.items[0].nextOffset, 16)
    assert.equal(fromStart.result.items[0].eof, false)
    assert.match(fromStart.result.items[0].content, /^00000000  00 01 02 03/)

    // offset: 16 must start at byte 16 (0x10), NOT row 16 (byte 240).
    const from16 = await worker.invoke(
      'read_files',
      { files: [{ path: 'bytes48.bin', view: 'hex', offset: 16, limit: 16 }] },
      opts,
    )
    assert.equal(from16.ok, true)
    assert.equal(from16.result.items[0].offset, 16)
    assert.equal(from16.result.items[0].nextOffset, 32)
    assert.equal(from16.result.items[0].eof, false)
    assert.match(from16.result.items[0].content, /^00000010  10 11 12 13/)
  })

  it('defaults pulse_search glob kind to "file" (excluding directories unless kind="all")', async () => {
    const opts = { roots: [wsDir], credentialFence: true, maxInlineBytes: 7800 }
    const defaultKind = await worker.invoke('glob', { pattern: ['sub/**/*'] }, opts)
    assert.equal(defaultKind.ok, true)
    assert.equal(defaultKind.result.entries.every((e) => e.kind === 'file'), true)
    assert.equal(defaultKind.result.totalMatched, 1)

    const allKind = await worker.invoke('glob', { pattern: ['sub/**/*'], kind: 'all' }, opts)
    assert.equal(allKind.ok, true)
    assert.equal(allKind.result.entries.some((e) => e.kind === 'directory'), true)
    assert.equal(allKind.result.totalMatched, 2)
  })

  it('enforces full Rust Credential Fence parity with Node and blocks nested secrets in batch copy', async () => {
    const opts = { roots: [wsDir], credentialFence: true, maxInlineBytes: 7800 }
    const fencedFiles = [
      '.gnupg/secring.gpg',
      'id_ecdsa',
      'id_dsa',
      'cert.p12',
      'cert.pfx',
      'service_account_prod.json',
      'serviceaccount.json',
    ]
    for (const rel of fencedFiles) {
      const res = await worker.invoke('read_files', { files: [{ path: rel }] }, opts)
      assert.equal(res.ok, false, `Expected Rust Credential Fence to block ${rel}`)
      assert.equal(res.failure.code, 'CREDENTIAL_FENCE_BLOCKED')
      assert.equal(res.failure.effectState, 'none')
    }

    // Batch copy of directory containing nested .env must fail in preflight with zero side effects.
    const copyRes = await worker.invoke(
      'batch',
      { operations: [{ op: 'copy', path: 'copy-src', to: 'copy-dst' }] },
      opts,
    )
    assert.equal(copyRes.ok, false)
    assert.equal(copyRes.failure.code, 'CREDENTIAL_FENCE_BLOCKED')
    assert.equal(copyRes.failure.effectState, 'none')
    assert.equal(existsSync(join(wsDir, 'copy-dst')), false)
  })

  it('resolves workspacePaths from active-session.json and fails closed when workspace roots are empty', async () => {
    const tmpData = mkdtempSync(join(tmpdir(), 'agy-pulse-p0-data-'))
    const savedWsEnv = process.env.ANTIGRAVITY_WORKSPACE_DIR
    const savedAgentApi = process.env.ANTIGRAVITY_AGENTAPI_EXE
    const savedLs = process.env.ANTIGRAVITY_LS_ADDRESS
    try {
      delete process.env.ANTIGRAVITY_WORKSPACE_DIR
      delete process.env.ANTIGRAVITY_AGENTAPI_EXE
      delete process.env.ANTIGRAVITY_LS_ADDRESS

      writeFileSync(
        join(tmpData, 'active-session.json'),
        JSON.stringify({
          conversationId: 'conv-p0-ws',
          workspacePaths: [wsDir],
          updatedAt: Date.now(),
        }),
        'utf8',
      )

      const roots = await resolveWorkspaceRoots('conv-p0-ws', undefined, undefined, tmpData)
      assert.equal(roots.length, 1)
      assert.equal(roots[0].toLowerCase(), wsDir.toLowerCase())

      // Overnight / resumed conversation (>6h old, e.g. 12h) must still resolve workspace roots cleanly.
      writeFileSync(
        join(tmpData, 'active-session.json'),
        JSON.stringify({
          conversationId: 'conv-p0-ws',
          workspacePaths: [wsDir],
          updatedAt: Date.now() - 12 * 60 * 60 * 1000,
        }),
        'utf8',
      )
      const overnightRoots = await resolveWorkspaceRoots('conv-p0-ws', undefined, undefined, tmpData)
      assert.equal(overnightRoots.length, 1)
      assert.equal(overnightRoots[0].toLowerCase(), wsDir.toLowerCase())

      // Multi-project parallel sessions: authorized-workspaces.json keeps BOTH workspaces authorized
      // even when active-session.json is currently pointing to another project.
      const secondWs = mkdtempSync(join(tmpdir(), 'agy-pulse-p0-ws2-'))
      try {
        writeFileSync(
          join(tmpData, 'active-session.json'),
          JSON.stringify({
            conversationId: 'conv-p0-other',
            workspacePaths: [secondWs],
            updatedAt: Date.now(),
          }),
          'utf8',
        )
        writeFileSync(
          join(tmpData, 'authorized-workspaces.json'),
          JSON.stringify({
            version: 1,
            sessions: {
              'conv-p0-ws': { workspacePaths: [wsDir], updatedAt: Date.now() - 10_000 },
              'conv-p0-other': { workspacePaths: [secondWs], updatedAt: Date.now() },
            },
          }),
          'utf8',
        )
        const multiRoots = await resolveWorkspaceRoots(undefined, undefined, undefined, tmpData)
        const lowerMulti = multiRoots.map((p) => p.toLowerCase())
        assert.equal(lowerMulti.includes(secondWs.toLowerCase()), true)
        assert.equal(lowerMulti.includes(wsDir.toLowerCase()), true)
      } finally {
        rmSync(secondWs, { recursive: true, force: true })
      }

      const emptyJail = normalizeWorkdir(undefined, [])
      assert.equal(emptyJail.ok, false)
      assert.equal(emptyJail.failure.code, 'WORKSPACE_ROOT_UNRESOLVED')
      assert.equal(emptyJail.failure.effectState, 'none')

      const msysPath = normalizeWorkerPath('/d/repo/src/index.ts', 'D:\\repo', 'win32')
      assert.equal(msysPath.ok, true)
      assert.equal(msysPath.path, 'D:\\repo\\src\\index.ts')

      const crossDrive = normalizeWorkerPath('C:foo.ts', 'D:\\repo', 'win32')
      assert.equal(crossDrive.ok, false)
      assert.equal(crossDrive.failure.code, 'CROSS_DRIVE_RELATIVE_PATH')
    } finally {
      if (savedWsEnv !== undefined) process.env.ANTIGRAVITY_WORKSPACE_DIR = savedWsEnv
      if (savedAgentApi !== undefined) process.env.ANTIGRAVITY_AGENTAPI_EXE = savedAgentApi
      if (savedLs !== undefined) process.env.ANTIGRAVITY_LS_ADDRESS = savedLs
      rmSync(tmpData, { recursive: true, force: true })
    }
  })

  it('enforces maxTimeoutMs <= 165,000, maxInlineBytes <= 8,800, spillMaxTotalMb >= 16, accurate cap notice, and SpillStore memory index', async () => {
    assert.ok(validateConfigPatch({ maxTimeoutMs: 200_000 }).length > 0)
    assert.equal(validateConfigPatch({ maxTimeoutMs: 165_000 }).length, 0)
    assert.ok(validateConfigPatch({ defaultTimeoutMs: 180_000 }).length > 0)
    assert.equal(validateConfigPatch({ defaultTimeoutMs: 165_000 }).length, 0)
    assert.ok(validateConfigPatch({ maxInlineBytes: 16_384 }).length > 0)
    assert.equal(validateConfigPatch({ maxInlineBytes: 8_800 }).length, 0)
    assert.ok(validateConfigPatch({ spillMaxTotalMb: 8 }).length > 0)
    assert.equal(validateConfigPatch({ spillMaxTotalMb: 16 }).length, 0)

    // Verify shell discovery detects at least one default shell (and handles WindowsApps pwsh alias)
    const detectedShells = await discoverShells()
    assert.ok(detectedShells.some((s) => s.available && s.isDefault))

    const longText = 'x'.repeat(12_000)
    const cappedNoRef = capUtf8Text(longText, 9_400, false)
    assert.ok(Buffer.byteLength(cappedNoRef, 'utf8') <= 9_400)
    assert.equal(cappedNoRef.includes('pulse_result'), false)

    const cappedWithRef = capUtf8Text(longText, 9_400, true)
    assert.ok(Buffer.byteLength(cappedWithRef, 'utf8') <= 9_400)
    assert.equal(cappedWithRef.includes('pulse_result'), true)

    // Dynamic backtick fence adapts when content contains triple backticks, and capUtf8Text closes open fences.
    const nestedFence = renderCodeFence('before\n```ts\nconst a = 1\n```\nafter', 'markdown')
    assert.match(nestedFence, /^````markdown\n/)
    assert.match(nestedFence, /\n````$/)

    const fencedLong = `**stdout**\n${renderCodeFence('line\n'.repeat(3000), 'text')}`
    const cappedFenced = capUtf8Text(fencedLong, 9_400, true)
    assert.ok(Buffer.byteLength(cappedFenced, 'utf8') <= 9_400)
    assert.match(cappedFenced, /\n```\n\n\.\.\. \[output capped/)

    const mutated = formatMutate({
      action: 'edit',
      status: 'completed',
      dryRun: false,
      durationMs: 12,
      path: 'src/a.css',
      beforeRevision: 'a'.repeat(64),
      afterRevision: 'b'.repeat(64),
      addedLines: 1,
      removedLines: 0,
      diff: '--- a/a.css\n+++ b/a.css\n@@ -1,1 +1,2 @@\n+  color: red;\n',
    })
    assert.match(mutated.content[0].text, /```diff\n--- a\/a\.css/)

    const execFormatted = formatExecOutcome({
      id: 'exec-1',
      status: 'completed',
      kind: 'foreground',
      description: 'npm build',
      shell: 'pwsh',
      cwd: wsDir,
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      durationMs: 50,
      stdout: '> pkg@1.0.0 build\n> tsc\n',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    })
    assert.match(execFormatted.content[0].text, /\*\*stdout\*\*\n```text\n> pkg@1\.0\.0 build/)

    // SpillStore in-memory index consistency
    const spillDataDir = mkdtempSync(join(tmpdir(), 'agy-pulse-p0-spill-'))
    try {
      const store = new SpillStore(spillDataDir)
      const s1 = store.save({ stdout: 'a\nb\n', stderr: '', sessionId: 'sess-1', meta: { tool: 'pulse_exec' } })
      const s2 = store.save({ stdout: 'c\nd\n', stderr: '', sessionId: 'sess-2', meta: { tool: 'pulse_exec' } })
      assert.equal(store.listSpills(100).length, 2)
      assert.equal(store.listSpills(100, 'sess-1').length, 1)
      store.releaseResult(s1.refId)
      assert.equal(store.listSpills(100).length, 1)
      assert.equal(store.releaseBySession('sess-2'), 1)
      assert.equal(store.listSpills(100).length, 0)
    } finally {
      rmSync(spillDataDir, { recursive: true, force: true })
    }
  })

  it('enforces ephemeral auth token and loopback-only CORS when ANTIGRAVITY_SIDECAR_UI_TOKEN is unset', async () => {
    const tmpData = mkdtempSync(join(tmpdir(), 'agy-pulse-p0-cors-'))
    const env = { ...process.env }
    delete env.ANTIGRAVITY_SIDECAR_UI_TOKEN
    delete env.ANTIGRAVITY_CONVERSATION_ID
    delete env.ANTIGRAVITY_AGENTAPI_EXE
    delete env.ANTIGRAVITY_LS_ADDRESS

    const proc = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: wsDir,
      env: {
        ...env,
        AGY_PULSE_WORKER_BIN: workerBin,
        AGY_PULSE_DATA_DIR: tmpData,
        ANTIGRAVITY_WORKSPACE_DIR: wsDir,
        ANTIGRAVITY_SIDECAR_WEB_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    try {
      const discovery = JSON.parse(await waitForFile(join(tmpData, 'daemon.json'), 10_000))
      assert.ok(typeof discovery.token === 'string' && discovery.token.length >= 32)

      const unauth = await fetch(`http://127.0.0.1:${discovery.port}/api/state`, {
        headers: { Origin: 'https://evil.example' },
      })
      assert.equal(unauth.status, 401)
      assert.equal(unauth.headers.get('access-control-allow-origin'), null)

      const authLocal = await fetch(`http://127.0.0.1:${discovery.port}/api/state`, {
        headers: {
          'X-Sidecar-Token': discovery.token,
          Origin: 'http://127.0.0.1:5173',
        },
      })
      assert.equal(authLocal.status, 200)
      assert.equal(authLocal.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173')
    } finally {
      await stopChild(proc)
      rmSync(tmpData, { recursive: true, force: true })
    }
  })
})
