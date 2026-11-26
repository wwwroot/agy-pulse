import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const MCP_ENTRY = join(ROOT, 'sidecars', 'pulse', 'dist', 'mcp-server.mjs')
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

function runSessionHook(payload, hookDataDir) {
  return new Promise((resolveHook, rejectHook) => {
    const child = spawn(process.execPath, [HOOK_ENTRY], {
      env: { ...process.env, AGY_PULSE_DATA_DIR: hookDataDir },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c) => {
      stdout += c
    })
    child.once('error', rejectHook)
    child.once('close', (code) => resolveHook({ code, stdout: stdout.trim() }))
    child.stdin.end(JSON.stringify(payload))
  })
}

function initMcpGitFixture(repoDir) {
  mkdirSync(join(repoDir, 'src'), { recursive: true })
  const runGit = (args) =>
    execFileSync('git', args, {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      encoding: 'utf8',
    })

  runGit(['init', '-q'])
  runGit(['config', 'user.email', 'mcp-qa@example.com'])
  runGit(['config', 'user.name', 'MCP QA'])

  writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const version = 1\n', 'utf8')
  const lockA = Array.from({ length: 60 }, (_, i) => `  "dep-${i}": "1.0.${i}",`).join('\n')
  writeFileSync(join(repoDir, 'package-lock.json'), `{\n${lockA}\n}\n`, 'utf8')
  runGit(['add', '.'])
  runGit(['commit', '-q', '-m', 'init'])

  writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const version = 2\n', 'utf8')
  const lockB = Array.from({ length: 60 }, (_, i) => `  "dep-${i}": "2.0.${i}-updated",`).join('\n')
  writeFileSync(join(repoDir, 'package-lock.json'), `{\n${lockB}\n}\n`, 'utf8')
}

class StdioMcpClient {
  constructor(child) {
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    this.stderr = ''
    this.buffer = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk
      let idx
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx).trim()
        this.buffer = this.buffer.slice(idx + 1)
        if (!line) continue
        const msg = JSON.parse(line)
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          clearTimeout(entry.timer)
          if (msg.error) {
            entry.reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`))
          } else {
            entry.resolve(msg.result)
          }
        }
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk
    })

    child.once('exit', (code, signal) => {
      for (const [id, entry] of this.pending.entries()) {
        clearTimeout(entry.timer)
        entry.reject(new Error(`MCP server exited (${code ?? signal}) while awaiting id=${id}`))
      }
      this.pending.clear()
    })
  }

  request(method, params = {}, timeoutMs = 15_000) {
    const id = this.nextId++
    return new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectReq(new Error(`MCP request "${method}" (id=${id}) timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolveReq, reject: rejectReq, timer })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  callTool(name, args = {}, timeoutMs = 15_000) {
    return this.request('tools/call', { name, arguments: args }, timeoutMs)
  }

  async close() {
    if (this.child.exitCode !== null) return
    const exited = new Promise((r) => this.child.once('exit', r))
    this.child.stdin.end()
    await Promise.race([
      exited,
      new Promise((r) => setTimeout(r, 4000)).then(() => {
        if (this.child.exitCode === null) {
          try {
            this.child.kill('SIGTERM')
          } catch {
            // Ignore.
          }
        }
      }),
    ])
  }
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

describe('Stdio MCP Server v0.3.0 E2E (sidecars/pulse/dist/mcp-server.mjs)', () => {
  let dataDir
  let workspaceDir
  let workerBinDir
  let workerBinPath
  let mcpClient
  let serverProc

  before(async () => {
    assert.equal(existsSync(MCP_ENTRY), true, `Missing bundled MCP server at ${MCP_ENTRY}`)
    assert.equal(existsSync(SERVER_ENTRY), true, `Missing bundled Sidecar server at ${SERVER_ENTRY}`)
    assert.equal(existsSync(DIST_WORKER_BIN), true, `Missing compiled worker at ${DIST_WORKER_BIN}`)

    dataDir = mkdtempSync(join(tmpdir(), 'agy-ops-mcp-data-'))
    workspaceDir = mkdtempSync(join(tmpdir(), 'agy-ops-mcp-ws-'))
    mkdirSync(join(workspaceDir, 'lib'), { recursive: true })

    if (IS_WIN) {
      workerBinDir = mkdtempSync(join(tmpdir(), 'agy-ops-mcp-bin-'))
      workerBinPath = join(workerBinDir, 'agy-pulse-worker.exe')
      copyFileSync(DIST_WORKER_BIN, workerBinPath)
    } else {
      workerBinPath = DIST_WORKER_BIN
    }

    const pad = Array.from({ length: 16 }, (_, i) => `export const padLine_${i} = ${i} // padding`).join('\n')
    writeFileSync(
      join(workspaceDir, 'lib', 'math.ts'),
      `export function addNumbers(a: number, b: number): number {\n  return a + b\n}\n${pad}\n`,
      'utf8',
    )
    writeFileSync(
      join(workspaceDir, 'lib', 'use.ts'),
      `import { addNumbers } from './math'\nexport const r1 = addNumbers(2, 3)\nexport const r2 = addNumbers(4, 5)\n${pad}\n`,
      'utf8',
    )
    writeFileSync(
      join(workspaceDir, 'lib', 'report.csv'),
      'tool,saved_tokens\npulse_read_files,2400\npulse_search,1850\n',
      'utf8',
    )

    // v0.3.0 outline/symbol & git fixtures (outside lib/ so lib/**/*.ts glob stays 2)
    mkdirSync(join(workspaceDir, 'v3'), { recursive: true })
    const longMethodLines = Array.from(
      { length: 22 },
      (_, i) => `    const step_${i} = value + ${i} // filler logic line ${i}`,
    ).join('\n')
    writeFileSync(
      join(workspaceDir, 'v3', 'planner.ts'),
      [
        'import path from "node:path"',
        '',
        '/** Plans multi-step workspace operations. */',
        'export class OpsPlanner {',
        '  /** Computes a weighted score. */',
        '  score(value: number): number {',
        longMethodLines,
        '    return step_0 + step_21',
        '  }',
        '',
        '  /** Normalizes a workspace label. */',
        '  label(target: string): string {',
        '    return path.basename(target)',
        '  }',
        '}',
        '',
        '/** Standalone formatter helper. */',
        'export function formatPlanTag(name: string): string {',
        '  return `plan:${name}`',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    initMcpGitFixture(join(workspaceDir, 'git-ws'))

    const cleanEnv = { ...process.env }
    delete cleanEnv.ANTIGRAVITY_CONVERSATION_ID
    delete cleanEnv.ANTIGRAVITY_AGENTAPI_EXE
    delete cleanEnv.ANTIGRAVITY_LS_ADDRESS

    const child = spawn(process.execPath, [MCP_ENTRY], {
      cwd: workspaceDir,
      env: {
        ...cleanEnv,
        AGY_PULSE_WORKER_BIN: workerBinPath,
        AGY_PULSE_DATA_DIR: dataDir,
        ANTIGRAVITY_WORKSPACE_DIR: workspaceDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    mcpClient = new StdioMcpClient(child)
  })

  after(async () => {
    await mcpClient?.close()
    await stopChild(serverProc)
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(workspaceDir, { recursive: true, force: true })
    if (workerBinDir) rmSync(workerBinDir, { recursive: true, force: true })
  })

  it('handles initialize v1.0.0 and exposes exact 7 pulse_* tools with total schema <= 10.5 KB', async () => {
    const init = await mcpClient.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agy-ops-verifier', version: '1.0.0' },
    })
    assert.equal(init.serverInfo.name, 'agy-pulse')
    assert.equal(init.serverInfo.version, '1.0.0')
    assert.ok(init.capabilities.tools)
    mcpClient.notify('notifications/initialized')

    const listed = await mcpClient.request('tools/list')
    const toolNames = listed.tools.map((t) => t.name).sort()
    assert.deepEqual(toolNames, [
      'pulse_exec',
      'pulse_job',
      'pulse_mutate',
      'pulse_read_doc',
      'pulse_read_files',
      'pulse_result',
      'pulse_search',
    ])

    const totalSchemaBytes = Buffer.byteLength(JSON.stringify(listed.tools), 'utf8')
    assert.ok(
      totalSchemaBytes <= 10_752,
      `Expected total tool schema <= 10.5 KB (10,752 bytes), got ${totalSchemaBytes}`,
    )
  })

  it('rejects unknown arguments strictly with effectState=none and camelCase alias hints', async () => {
    const execBad = await mcpClient.callTool('pulse_exec', {
      description: 'Test unknown arg',
      command: 'echo should_not_run',
      cwd: '.',
    })
    assert.equal(execBad.isError, true)
    assert.equal(execBad.structuredContent.ok, false)
    assert.equal(execBad.structuredContent.failure.code, 'UNKNOWN_ARGUMENTS')
    assert.equal(execBad.structuredContent.failure.effectState, 'none')
    assert.match(execBad.content[0].text, /"cwd" -> "workdir"/)

    const readBad = await mcpClient.callTool('pulse_read_files', {
      files: [{ path: 'lib/math.ts' }],
      statOnly: true,
    })
    assert.equal(readBad.isError, true)
    assert.equal(readBad.structuredContent.failure.code, 'UNKNOWN_ARGUMENTS')
    assert.equal(readBad.structuredContent.failure.effectState, 'none')
    assert.match(readBad.content[0].text, /"statOnly" -> "stat_only"/)

    const gitBad = await mcpClient.callTool('pulse_search', {
      action: 'git_diff',
      baseRef: 'HEAD',
      includeLockfiles: false,
      maxHunkLines: 80,
    })
    assert.equal(gitBad.isError, true)
    assert.equal(gitBad.structuredContent.failure.code, 'UNKNOWN_ARGUMENTS')
    assert.equal(gitBad.structuredContent.failure.effectState, 'none')
    assert.match(gitBad.content[0].text, /"baseRef" -> "base_ref"/)
    assert.match(gitBad.content[0].text, /"includeLockfiles" -> "include_lockfiles"/)
    assert.match(gitBad.content[0].text, /"maxHunkLines" -> "max_hunk_lines"/)
  })

  it('runs all 7 pulse_* tools cleanly in offline local-fallback mode', async () => {
    // 1. pulse_result stats (verify local-fallback)
    const stats0 = await mcpClient.callTool('pulse_result', { action: 'stats' })
    assert.equal(stats0.isError, undefined)
    assert.equal(stats0.structuredContent.sync.mode, 'local-fallback')
    assert.equal(stats0.structuredContent.sync.connected, false)
    assert.equal(stats0.structuredContent.sync.workerAvailable, true)

    // 2. pulse_read_files batch + immediate dedup re-read
    const read1 = await mcpClient.callTool('pulse_read_files', {
      files: [
        { path: 'lib/math.ts', offset: 1, limit: 100 },
        { path: 'lib/use.ts', offset: 1, limit: 100 },
      ],
    })
    assert.equal(read1.isError, undefined)
    assert.equal(read1.structuredContent.dedupHits, 0)
    assert.match(read1.content[0].text, /\[Base:/)
    const mathRev = read1.structuredContent.items[0].revision

    const read2 = await mcpClient.callTool('pulse_read_files', {
      files: [
        { path: 'lib/math.ts', offset: 1, limit: 100 },
        { path: 'lib/use.ts', offset: 1, limit: 100 },
      ],
    })
    assert.equal(read2.isError, undefined)
    assert.equal(read2.structuredContent.dedupHits, 2)
    assert.match(read2.content[0].text, /\[Unchanged: already read in this session/)

    // 3. pulse_search (glob + grep definitions)
    const globRes = await mcpClient.callTool('pulse_search', {
      action: 'glob',
      pattern: 'lib/**/*.ts',
    })
    assert.equal(globRes.isError, undefined)
    assert.equal(globRes.structuredContent.totalMatched, 2)

    const defsRes = await mcpClient.callTool('pulse_search', {
      action: 'grep',
      pattern: 'addNumbers',
      path: 'lib',
      output_mode: 'definitions',
    })
    assert.equal(defsRes.isError, undefined)
    assert.equal(defsRes.structuredContent.definitionMatches, 1)
    assert.ok(defsRes.structuredContent.impliedReferences >= 2)

    // 4. pulse_mutate (edit + write + diff + replace + batch)
    const editRes = await mcpClient.callTool('pulse_mutate', {
      action: 'edit',
      path: 'lib/math.ts',
      expected_revision: mathRev,
      edits: [{ old_text: 'return a + b', new_text: 'return a + b + 0' }],
    })
    assert.equal(editRes.isError, undefined)
    assert.equal(editRes.structuredContent.status, 'completed')
    assert.match(editRes.content[0].text, /```diff\n/)

    const writeRes = await mcpClient.callTool('pulse_mutate', {
      action: 'write',
      path: 'lib/scratch.txt',
      expected_revision: 'absent',
      content: 'FALLBACK_VAL\n',
    })
    assert.equal(writeRes.isError, undefined)

    const batchRes = await mcpClient.callTool('pulse_mutate', {
      action: 'batch',
      operations: [
        { op: 'move', path: 'lib/scratch.txt', to: 'lib/scratch-moved.txt' },
        { op: 'copy', path: 'lib/report.csv', to: 'lib/report-copy.csv' },
      ],
    })
    assert.equal(batchRes.isError, undefined)

    // 5. pulse_read_doc (CSV)
    const docRes = await mcpClient.callTool('pulse_read_doc', {
      path: 'lib/report.csv',
      format: 'auto',
      header: true,
    })
    assert.equal(docRes.isError, undefined)
    assert.equal(docRes.structuredContent.format, 'table')
    assert.match(docRes.content[0].text, /pulse_read_files/)

    // 6. pulse_exec (foreground + background + spillover) & pulse_job (list/output/kill) & pulse_result (page/release)
    const fgRes = await mcpClient.callTool('pulse_exec', {
      description: 'Run foreground echo via MCP v2',
      command: 'echo MCP_V2_FG_OK',
      shell: FAST_SHELL,
    })
    assert.equal(fgRes.isError, undefined)
    assert.match(fgRes.content[0].text, /MCP_V2_FG_OK/)

    const bgScript = join(workspaceDir, 'mcp-v2-bg.mjs')
    writeFileSync(bgScript, 'console.log("MCP_V2_BG_READY");\nsetInterval(() => {}, 1000);\n', 'utf8')
    const bgStart = await mcpClient.callTool('pulse_exec', {
      description: 'Start background helper',
      command: `"${process.execPath}" "${bgScript}"`,
      shell: FAST_SHELL,
      run_in_background: true,
    })
    const jobId = bgStart.structuredContent.jobId
    assert.ok(jobId)

    const jobList = await mcpClient.callTool('pulse_job', { action: 'list' })
    assert.ok(jobList.structuredContent.jobs.some((j) => j.id === jobId))

    let collected = ''
    let offset = 0
    const deadline = Date.now() + 8_000
    while (!collected.includes('MCP_V2_BG_READY') && Date.now() < deadline) {
      const out = await mcpClient.callTool('pulse_job', {
        action: 'output',
        job_id: jobId,
        stdout_offset: offset,
        wait: true,
        wait_timeout_ms: 4000,
      })
      collected += out.content[0].text
      offset = out.structuredContent.nextStdoutOffset
    }
    assert.match(collected, /MCP_V2_BG_READY/)

    const killed = await mcpClient.callTool('pulse_job', { action: 'kill', job_id: jobId })
    assert.equal(killed.structuredContent.killed, true)

    // Spillover + pulse_result page/release
    const spillScript = join(workspaceDir, 'mcp-v2-spill.mjs')
    writeFileSync(
      spillScript,
      'for (let i = 1; i <= 450; i++) console.log(`ROW_${i} ${i === 301 ? "MCP_V2_NEEDLE_301" : "y".repeat(48)}`);\n',
      'utf8',
    )
    const spillExec = await mcpClient.callTool('pulse_exec', {
      description: 'Generate oversized output for spillover paging',
      command: `"${process.execPath}" "${spillScript}"`,
      shell: FAST_SHELL,
    })
    const refId = spillExec.structuredContent.refId
    assert.ok(typeof refId === 'string' && refId.startsWith('ref://spill/'))
    const rendered = spillExec.content[0].text
    assert.ok(rendered.indexOf(`[Stored reference: refId=${refId}]`) < rendered.indexOf('**stdout'))
    assert.match(rendered, /\*\*stdout.*\n```text\n/)

    const pageRes = await mcpClient.callTool('pulse_result', {
      action: 'page',
      ref_id: refId,
      search: 'MCP_V2_NEEDLE_301',
      stream: 'stdout',
    })
    assert.match(pageRes.content[0].text, /MCP_V2_NEEDLE_301/)

    const relRes = await mcpClient.callTool('pulse_result', { action: 'release', ref_id: refId })
    assert.equal(relRes.structuredContent.released, true)
  })

  it('upgrades automatically to live sidecar-daemon mode across pulse_* tools and reports token savings in pulse_result stats', async () => {
    const token = randomBytes(16).toString('hex')
    const cleanEnv = { ...process.env }
    delete cleanEnv.ANTIGRAVITY_CONVERSATION_ID
    delete cleanEnv.ANTIGRAVITY_AGENTAPI_EXE
    delete cleanEnv.ANTIGRAVITY_LS_ADDRESS

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

    const rawDiscovery = await waitForFile(join(dataDir, 'daemon.json'), 10_000)
    const discovery = JSON.parse(rawDiscovery)

    // Verify automatic daemon upgrade via pulse_read_files (first + dedup hit)
    const liveRead1 = await mcpClient.callTool('pulse_read_files', {
      files: [
        { path: 'lib/math.ts', offset: 1, limit: 100 },
        { path: 'lib/use.ts', offset: 1, limit: 100 },
      ],
    })
    assert.equal(liveRead1.isError, undefined)

    const liveRead2 = await mcpClient.callTool('pulse_read_files', {
      files: [
        { path: 'lib/math.ts', offset: 1, limit: 100 },
        { path: 'lib/use.ts', offset: 1, limit: 100 },
      ],
    })
    assert.equal(liveRead2.isError, undefined)
    assert.equal(liveRead2.structuredContent.dedupHits, 2)

    const liveSearch = await mcpClient.callTool('pulse_search', {
      action: 'grep',
      pattern: 'addNumbers',
      path: 'lib',
      output_mode: 'definitions',
    })
    assert.equal(liveSearch.isError, undefined)
    assert.equal(liveSearch.structuredContent.definitionMatches, 1)

    const liveDoc = await mcpClient.callTool('pulse_read_doc', {
      path: 'lib/report.csv',
      format: 'auto',
      header: true,
    })
    assert.equal(liveDoc.isError, undefined)

    const liveExec = await mcpClient.callTool('pulse_exec', {
      description: 'Verify live daemon activity mirror v2',
      command: 'echo LIVE_DAEMON_V2_OK',
      shell: FAST_SHELL,
    })
    assert.equal(liveExec.isError, undefined)
    assert.match(liveExec.content[0].text, /LIVE_DAEMON_V2_OK/)

    // Live pulse_result({ action: "stats" }) token savings report
    const liveStats = await mcpClient.callTool('pulse_result', { action: 'stats' })
    assert.equal(liveStats.isError, undefined)
    assert.equal(liveStats.structuredContent.sync.mode, 'sidecar-daemon')
    assert.equal(liveStats.structuredContent.sync.connected, true)
    assert.equal(liveStats.structuredContent.sync.port, discovery.port)
    assert.equal(liveStats.structuredContent.sync.workerAvailable, true)
    assert.ok(liveStats.structuredContent.telemetry.totalSavedBytes > 0)
    assert.ok(liveStats.structuredContent.telemetry.estimatedTokensSaved > 0)
    assert.ok(liveStats.structuredContent.telemetry.dedupHits >= 2)
    assert.ok(liveStats.structuredContent.telemetry.roundTripsSaved >= 2)
    assert.match(liveStats.content[0].text, /\[Pulse\]\(sidecar:\/\/agy-pulse\/pulse\/\)/)

    // Confirm activity mirroring on the live daemon
    const stateRes = await fetch(`http://127.0.0.1:${discovery.port}/api/state`, {
      headers: { 'X-Sidecar-Token': token },
    })
    const stateJson = await stateRes.json()
    assert.ok(
      stateJson.activities.some((a) => a.description === 'Verify live daemon activity mirror v2'),
      'Expected MCP execution to appear in Sidecar daemon activity feed',
    )
    assert.equal(mcpClient.stderr.trim(), '', `Unexpected MCP stderr: ${mcpClient.stderr}`)
  })

  it('supports v0.3.0 pulse_read_files (outline & symbol) and pulse_search (git_status & git_diff with lockfile exclusion)', async () => {
    // 1. Outline view
    const outlineRes = await mcpClient.callTool('pulse_read_files', {
      files: [{ path: 'v3/planner.ts', view: 'outline' }],
    })
    assert.equal(outlineRes.isError, undefined)
    assert.equal(outlineRes.structuredContent.items[0].view, 'outline')
    assert.ok(outlineRes.structuredContent.items[0].fullFileBytes > 0)
    assert.ok(outlineRes.structuredContent.savedBytes > 0)
    assert.match(outlineRes.content[0].text, /export class OpsPlanner/)
    assert.match(outlineRes.content[0].text, /export function formatPlanTag/)

    // 2. Targeted symbol read (qualified + bare) + missing symbol
    const symRes = await mcpClient.callTool('pulse_read_files', {
      files: [
        { path: 'v3/planner.ts', symbol: 'OpsPlanner.label' },
        { path: 'v3/planner.ts', symbol: 'formatPlanTag' },
        { path: 'v3/planner.ts', symbol: 'MissingHelper' },
      ],
    })
    assert.equal(symRes.isError, undefined)
    assert.equal(symRes.structuredContent.status, 'partial')
    assert.equal(symRes.structuredContent.items[0].view, 'symbol')
    assert.equal(symRes.structuredContent.items[0].symbol, 'OpsPlanner.label')
    assert.equal(symRes.structuredContent.items[1].view, 'symbol')
    assert.equal(symRes.structuredContent.items[1].symbol, 'formatPlanTag')
    assert.match(symRes.content[0].text, /Normalizes a workspace label/)
    assert.match(symRes.content[0].text, /export function formatPlanTag/)
    assert.equal(symRes.structuredContent.items[2].error.code, 'SYMBOL_NOT_FOUND')
    assert.equal(symRes.structuredContent.items[2].error.effectState, 'none')

    // 3. Compact git_status
    const statusRes = await mcpClient.callTool('pulse_search', {
      action: 'git_status',
      path: 'git-ws',
    })
    assert.equal(statusRes.isError, undefined)
    assert.equal(statusRes.structuredContent.action, 'git_status')
    assert.ok(statusRes.structuredContent.gitSkippedLockfiles.includes('package-lock.json'))
    assert.match(statusRes.content[0].text, /src\/index\.ts/)
    assert.match(statusRes.content[0].text, /skipped 1 lockfile/)

    // 4. Compact git_diff
    const diffRes = await mcpClient.callTool('pulse_search', {
      action: 'git_diff',
      path: 'git-ws',
    })
    assert.equal(diffRes.isError, undefined)
    assert.equal(diffRes.structuredContent.action, 'git_diff')
    assert.ok(diffRes.structuredContent.gitSkippedLockfiles.includes('package-lock.json'))
    assert.ok(diffRes.structuredContent.savedBytes > 1000)
    assert.match(diffRes.content[0].text, /\+export const version = 2/)
    assert.equal(diffRes.content[0].text.includes('2.0.10-updated'), false)
  })

  it('switches active session automatically via hook-driven active-session.json for pulse_read_files dedup and pulse_result stats', async () => {
    const convA = 'conv-mcp-alpha-1001'
    const convB = 'conv-mcp-beta-20002'

    // 1. Bind Session A via hook-session.mjs (PreToolUse for agy-pulse_pulse)
    const hookA = await runSessionHook(
      {
        hookEventName: 'PreToolUse',
        conversationId: convA,
        workspacePaths: [workspaceDir],
        toolCall: { id: 'tc-a-1', args: { ServerName: 'agy-pulse_pulse' } },
      },
      dataDir,
    )
    assert.equal(hookA.code, 0)
    assert.equal(hookA.stdout, '{"decision":"allow"}')

    // First read in Session A -> dedupHits = 0; second read -> dedupHits = 1
    const aRead1 = await mcpClient.callTool('pulse_read_files', {
      files: [{ path: 'lib/math.ts', offset: 1, limit: 100 }],
    })
    assert.equal(aRead1.isError, undefined)
    assert.equal(aRead1.structuredContent.dedupHits, 0)

    const aRead2 = await mcpClient.callTool('pulse_read_files', {
      files: [{ path: 'lib/math.ts', offset: 1, limit: 100 }],
    })
    assert.equal(aRead2.isError, undefined)
    assert.equal(aRead2.structuredContent.dedupHits, 1)

    const statsA = await mcpClient.callTool('pulse_result', { action: 'stats' })
    assert.equal(statsA.isError, undefined)
    assert.equal(statsA.structuredContent.sessionId, convA)
    assert.equal(statsA.structuredContent.telemetry.dedupHits, 1)
    assert.match(statsA.content[0].text, new RegExp(convA))

    // 2. Switch active session to Session B via hook-session.mjs
    await new Promise((r) => setTimeout(r, 25))
    const hookB = await runSessionHook(
      {
        hookEventName: 'PreToolUse',
        conversationId: convB,
        workspacePaths: [workspaceDir],
        toolCall: { id: 'tc-b-1', args: { ServerName: 'agy-pulse_pulse' } },
      },
      dataDir,
    )
    assert.equal(hookB.code, 0)
    assert.equal(hookB.stdout, '{"decision":"allow"}')

    // Reading the EXACT SAME file in Session B MUST NOT get a false dedup hit from Session A
    const bRead1 = await mcpClient.callTool('pulse_read_files', {
      files: [{ path: 'lib/math.ts', offset: 1, limit: 100 }],
    })
    assert.equal(bRead1.isError, undefined)
    assert.equal(bRead1.structuredContent.dedupHits, 0)

    const statsB = await mcpClient.callTool('pulse_result', { action: 'stats' })
    assert.equal(statsB.isError, undefined)
    assert.equal(statsB.structuredContent.sessionId, convB)
    assert.equal(statsB.structuredContent.telemetry.dedupHits, 0)
    assert.equal(statsB.structuredContent.telemetry.totalCalls, 1)
    assert.match(statsB.content[0].text, new RegExp(convB))

    // 3. Switch back to Session A -> dedup cache for Session A is still warm!
    await new Promise((r) => setTimeout(r, 25))
    const hookABack = await runSessionHook(
      {
        hookEventName: 'SessionStart',
        conversationId: convA,
        workspacePaths: [workspaceDir],
      },
      dataDir,
    )
    assert.equal(hookABack.code, 0)
    const hookBackParsed = JSON.parse(hookABack.stdout)
    assert.ok(
      typeof hookBackParsed === 'object' &&
        (Object.keys(hookBackParsed).length === 0 ||
          typeof hookBackParsed?.injectSteps?.[0]?.systemMessage?.systemMessage === 'string'),
    )

    const aRead3 = await mcpClient.callTool('pulse_read_files', {
      files: [{ path: 'lib/math.ts', offset: 1, limit: 100 }],
    })
    assert.equal(aRead3.isError, undefined)
    assert.equal(aRead3.structuredContent.dedupHits, 1)
    assert.equal(mcpClient.stderr.trim(), '', `Unexpected MCP stderr: ${mcpClient.stderr}`)
  })

  it('v0.4.0: keeps rendered MCP responses <= 9,400 bytes and shows symbol tip on outline reads', async () => {
    const outlineRes = await mcpClient.callTool('pulse_read_files', {
      files: [{ path: 'v3/planner.ts', view: 'outline' }],
    })
    assert.equal(outlineRes.isError, undefined)
    assert.match(outlineRes.content[0].text, /\[Tip: fetch a specific symbol directly/i)

    const bigOriginal = Array.from({ length: 240 }, (_, i) => `mcp_line_${i}: ${'k'.repeat(64)}`).join('\n') + '\n'
    const bigUpdated = Array.from({ length: 240 }, (_, i) => `mcp_next_${i}: ${'m'.repeat(64)}`).join('\n') + '\n'
    writeFileSync(join(workspaceDir, 'v3', 'big-mcp.txt'), bigOriginal, 'utf8')

    const bigRead = await mcpClient.callTool('pulse_read_files', {
      files: [{ path: 'v3/big-mcp.txt', offset: 1, limit: 240 }],
    })
    assert.equal(bigRead.isError, undefined)
    const readBytes = Buffer.byteLength(bigRead.content[0].text, 'utf8')
    assert.ok(readBytes <= 9_400, `Expected MCP pulse_read_files response <= 9,400 bytes, got ${readBytes}`)
    assert.ok(bigRead.structuredContent.refId?.startsWith('ref://spill/'))

    const bigDiff = await mcpClient.callTool('pulse_mutate', {
      action: 'diff',
      path: 'v3/big-mcp.txt',
      content: bigUpdated,
    })
    assert.equal(bigDiff.isError, undefined)
    const diffBytes = Buffer.byteLength(bigDiff.content[0].text, 'utf8')
    assert.ok(diffBytes <= 9_400, `Expected MCP pulse_mutate diff response <= 9,400 bytes, got ${diffBytes}`)
    assert.ok(bigDiff.structuredContent.refId?.startsWith('ref://spill/'))
    assert.match(bigDiff.content[0].text, /\[Stored reference: refId=/)
  })

  it('v0.5.0: pulse_result(stats) exposes daemonVersion, hostHealth, contextWindow and --cli doctor/quotas emit JSON', async () => {
    const transcriptPath = join(workspaceDir, 'v050-transcript.jsonl')
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        created_at: new Date().toISOString(),
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 4_000,
          cache_read_input_tokens: 12_000,
          output_tokens: 500,
        },
      })}\n`,
      'utf8',
    )

    const hookBind = await runSessionHook(
      {
        hook_event_name: 'SessionStart',
        conversation_id: 'conv_v050_stats',
        workspace_paths: [workspaceDir],
        transcript_path: transcriptPath,
      },
      dataDir,
    )
    assert.equal(hookBind.code, 0)

    const statsRes = await mcpClient.callTool('pulse_result', { action: 'stats' })
    assert.equal(statsRes.isError, undefined)
    const sc = statsRes.structuredContent
    assert.equal(sc.daemonVersion, '1.0.0')
    assert.equal(sc.mcpVersion, '1.0.0')
    assert.ok(sc.hostHealth && Array.isArray(sc.hostHealth.entries))
    assert.ok('contextWindow' in sc)
    if (sc.contextWindow?.available) {
      assert.equal(sc.contextWindow.turnCount, 1)
      assert.match(statsRes.content[0].text, /Context Window:/i)
    }
    assert.match(statsRes.content[0].text, /Host MCP health/i)

    const fakeGeminiHome = mkdtempSync(join(tmpdir(), 'agy-pulse-cli-gemini-'))
    try {
      const cfgDir = join(fakeGeminiHome, 'config')
      mkdirSync(cfgDir, { recursive: true })
      writeFileSync(
        join(cfgDir, 'mcp_config.json'),
        JSON.stringify(
          {
            mcpServers: {
              pulse: {
                command: 'node',
                args: [MCP_ENTRY],
                timeoutSeconds: 86400,
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      )

      const runCli = (cliArgs, extraEnv = {}) =>
        new Promise((resolveRun, rejectRun) => {
          const proc = spawn(process.execPath, [MCP_ENTRY, '--cli', ...cliArgs], {
            cwd: workspaceDir,
            env: {
              ...process.env,
              AGY_PULSE_DATA_DIR: dataDir,
              GEMINI_HOME: fakeGeminiHome,
              ...extraEnv,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          })
          let stdout = ''
          let stderr = ''
          proc.stdout.setEncoding('utf8')
          proc.stderr.setEncoding('utf8')
          proc.stdout.on('data', (c) => {
            stdout += c
          })
          proc.stderr.on('data', (c) => {
            stderr += c
          })
          proc.once('error', rejectRun)
          proc.once('close', (code) => resolveRun({ code, stdout, stderr }))
        })

      const docRun = await runCli(['doctor', '--json'])
      assert.equal(docRun.code, 0, `doctor stderr: ${docRun.stderr}`)
      const docJson = JSON.parse(docRun.stdout)
      assert.ok(Array.isArray(docJson.entries))
      assert.ok(docJson.entries.some((e) => e.status === 'ok'))

      const quotaRun = await runCli(['quotas', '--json'])
      const quotaJson = JSON.parse(quotaRun.stdout)
      assert.equal(quotaJson.provider, 'antigravity')
      assert.ok(['cli', 'app', 'none'].includes(quotaJson.source))
      assert.ok(Array.isArray(quotaJson.pools))
      assert.ok(Array.isArray(quotaJson.warnings))
    } finally {
      rmSync(fakeGeminiHome, { recursive: true, force: true })
    }
  })
})
