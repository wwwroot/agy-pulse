import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const IS_WIN = process.platform === 'win32'
const MCP_ENTRY = join(ROOT, 'sidecars', 'pulse', 'dist', 'mcp-server.mjs')
const SERVER_ENTRY = join(ROOT, 'sidecars', 'pulse', 'dist', 'server.mjs')
const INSTALL_SCRIPT = join(ROOT, 'scripts', 'install.mjs')
const DIST_WORKER_BIN = join(
  ROOT,
  'sidecars',
  'pulse',
  'dist',
  IS_WIN ? 'agy-pulse-worker.exe' : 'agy-pulse-worker',
)

function runNode(args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Ignore.
      }
      rejectRun(new Error(`Process timed out for: node ${args.join(' ')}`))
    }, options.timeoutMs ?? 15_000)

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
      rejectRun(err)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolveRun({ code, stdout, stderr })
    })

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin)
    } else {
      child.stdin.end()
    }
  })
}

describe('P2 Ecosystem Suite (--cli dual-mode, installer, config, doctor, uninstall)', () => {
  let wsDir
  let dataDir
  let binDir
  let workerBin
  let cliEnv

  before(() => {
    assert.equal(existsSync(MCP_ENTRY), true, `Missing MCP bundle at ${MCP_ENTRY}`)
    assert.equal(existsSync(DIST_WORKER_BIN), true, `Missing worker binary at ${DIST_WORKER_BIN}`)

    wsDir = mkdtempSync(join(tmpdir(), 'agy-pulse-p2-ws-'))
    dataDir = mkdtempSync(join(tmpdir(), 'agy-pulse-p2-data-'))
    if (IS_WIN) {
      binDir = mkdtempSync(join(tmpdir(), 'agy-pulse-p2-bin-'))
      workerBin = join(binDir, 'agy-pulse-worker.exe')
      copyFileSync(DIST_WORKER_BIN, workerBin)
    } else {
      workerBin = DIST_WORKER_BIN
    }

    mkdirSync(join(wsDir, 'src'), { recursive: true })
    writeFileSync(
      join(wsDir, 'src', 'OrderProcessor.ts'),
      [
        'export interface Order {',
        '  id: string',
        '  total: number',
        '}',
        '',
        'export function processOrder(order: Order): number {',
        '  return order.total * 2',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(join(wsDir, 'metrics.csv'), 'k,v\nlatency,12\nsaved,9400\n', 'utf8')

    const cleanEnv = { ...process.env }
    delete cleanEnv.ANTIGRAVITY_CONVERSATION_ID
    delete cleanEnv.ANTIGRAVITY_AGENTAPI_EXE
    delete cleanEnv.ANTIGRAVITY_LS_ADDRESS
    cliEnv = {
      ...cleanEnv,
      AGY_PULSE_DATA_DIR: dataDir,
      AGY_PULSE_WORKER_BIN: workerBin,
    }
  })

  after(async () => {
    if (IS_WIN) {
      await new Promise((r) => setTimeout(r, 80))
    }
    rmSync(wsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    if (binDir) {
      rmSync(binDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('supports --cli dual-mode across help, outline, read slice, fuzzy, grep, mutate --stdin, doc, and stats --json', async () => {
    const helpRes = await runNode([MCP_ENTRY, '--cli', '--help'], { env: cliEnv })
    assert.equal(helpRes.code, 0)
    assert.match(helpRes.stdout, /agy-pulse CLI/)

    const outlineRes = await runNode(
      [MCP_ENTRY, '--cli', 'outline', 'src/OrderProcessor.ts', '--cwd', wsDir],
      { env: cliEnv },
    )
    assert.equal(outlineRes.code, 0, outlineRes.stderr)
    assert.match(outlineRes.stdout, /export function processOrder/)

    const sliceRes = await runNode(
      [MCP_ENTRY, '--cli', 'read', 'src/OrderProcessor.ts:6-8', '--cwd', wsDir],
      { env: cliEnv },
    )
    assert.equal(sliceRes.code, 0, sliceRes.stderr)
    assert.match(sliceRes.stdout, /return order\.total \* 2/)

    const fuzzyRes = await runNode(
      [MCP_ENTRY, '--cli', 'search', 'fuzzy', 'ordproc', '--cwd', wsDir],
      { env: cliEnv },
    )
    assert.equal(fuzzyRes.code, 0, fuzzyRes.stderr)
    assert.match(fuzzyRes.stdout, /OrderProcessor\.ts/)

    const grepRes = await runNode(
      [MCP_ENTRY, '--cli', 'search', 'grep', 'processOrder', '--mode', 'definitions', '--cwd', wsDir],
      { env: cliEnv },
    )
    assert.equal(grepRes.code, 0, grepRes.stderr)
    assert.match(grepRes.stdout, /definitions=1/)

    const diffRes = await runNode(
      [MCP_ENTRY, '--cli', 'mutate', '--stdin', '--cwd', wsDir],
      {
        env: cliEnv,
        stdin: JSON.stringify({
          action: 'diff',
          path: 'src/OrderProcessor.ts',
          edits: [{ old_text: 'order.total * 2', new_text: 'order.total * 3' }],
        }),
      },
    )
    assert.equal(diffRes.code, 0, diffRes.stderr)
    assert.match(diffRes.stdout, /\+  return order\.total \* 3/)

    const docRes = await runNode(
      [MCP_ENTRY, '--cli', 'doc', 'metrics.csv', '--cwd', wsDir],
      { env: cliEnv },
    )
    assert.equal(docRes.code, 0, docRes.stderr)
    assert.match(docRes.stdout, /latency/)

    const statsRes = await runNode(
      [MCP_ENTRY, '--cli', 'result', 'stats', '--json', '--cwd', wsDir],
      { env: cliEnv },
    )
    assert.equal(statsRes.code, 0, statsRes.stderr)
    const parsedStats = JSON.parse(statsRes.stdout)
    assert.equal(parsedStats.ok, true)
    assert.equal(parsedStats.tool, 'pulse_result')
  })

  it('supports per-subcommand --help, positional search (grep/fuzzy/glob dir), and --session/--cwd live-daemon isolation', async () => {
    // 1. Per-subcommand --help
    for (const [sub, expectedPattern] of [
      ['read', /--outline/],
      ['search', /--output-mode/],
      ['mutate', /@'\.\.\.'@ \| node/],
      ['exec', /--workdir/],
      ['job', /--wait/],
      ['result', /--ref-id/],
      ['doc', /--format/],
    ]) {
      const h = await runNode([MCP_ENTRY, '--cli', sub, '--help'], { env: cliEnv })
      assert.equal(h.code, 0, h.stderr)
      assert.match(h.stdout, expectedPattern)
    }

    // 2. Positional search: grep <pattern> <path>, fuzzy <pattern> <path>, glob <pattern> <dir>
    const posGrep = await runNode(
      [MCP_ENTRY, '--cli', 'search', 'grep', 'processOrder', 'src', '--cwd', wsDir],
      { env: cliEnv },
    )
    assert.equal(posGrep.code, 0, posGrep.stderr)
    assert.match(posGrep.stdout, /OrderProcessor\.ts/)

    const posFuzzy = await runNode(
      [MCP_ENTRY, '--cli', 'search', 'fuzzy', 'OrderProcessor', 'src', '--cwd', wsDir],
      { env: cliEnv },
    )
    assert.equal(posFuzzy.code, 0, posFuzzy.stderr)
    assert.match(posFuzzy.stdout, /OrderProcessor\.ts/)

    const posGlob = await runNode(
      [MCP_ENTRY, '--cli', 'search', 'glob', '*.ts', 'src', '--cwd', wsDir],
      { env: cliEnv },
    )
    assert.equal(posGlob.code, 0, posGlob.stderr)
    assert.match(posGlob.stdout, /OrderProcessor\.ts/)

    // 3. Cross-agent --session & --cwd in live daemon mode
    const subRepo = join(wsDir, 'subrepo')
    mkdirSync(join(subRepo, 'src'), { recursive: true })
    const longBody = Array.from({ length: 12 }, (_, i) => `export const item_${i} = ${i} // filler`).join('\n')
    writeFileSync(join(subRepo, 'src', 'target.ts'), `${longBody}\n`, 'utf8')

    const liveDataDir = mkdtempSync(join(tmpdir(), 'agy-pulse-p2-live-'))
    const token = randomBytes(16).toString('hex')
    const serverProc = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: wsDir,
      env: {
        ...cliEnv,
        AGY_PULSE_DATA_DIR: liveDataDir,
        ANTIGRAVITY_WORKSPACE_DIR: wsDir,
        ANTIGRAVITY_SIDECAR_WEB_PORT: '0',
        ANTIGRAVITY_SIDECAR_UI_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    try {
      const daemonJsonPath = join(liveDataDir, 'daemon.json')
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (existsSync(daemonJsonPath) && readFileSync(daemonJsonPath, 'utf8').trim().length > 0) {
          break
        }
        await new Promise((r) => setTimeout(r, 80))
      }
      assert.equal(existsSync(daemonJsonPath), true, 'Expected live daemon.json')

      const liveCliEnv = { ...cliEnv, AGY_PULSE_DATA_DIR: liveDataDir }

      // --cwd resolves relative path against subrepo in live daemon mode + session A first read -> full content
      const alpha1 = await runNode(
        [
          MCP_ENTRY,
          '--cli',
          'read',
          'src/target.ts',
          '--cwd',
          subRepo,
          '--session',
          'swarm-alpha',
          '--json',
        ],
        { env: liveCliEnv },
      )
      assert.equal(alpha1.code, 0, alpha1.stderr)
      const alpha1Json = JSON.parse(alpha1.stdout)
      assert.equal(alpha1Json.structuredContent.dedupHits, 0)
      assert.match(alpha1Json.text, /item_11/)

      // Session A second read -> dedup hit
      const alpha2 = await runNode(
        [
          MCP_ENTRY,
          '--cli',
          'read',
          'src/target.ts',
          '--cwd',
          subRepo,
          '--session',
          'swarm-alpha',
          '--json',
        ],
        { env: liveCliEnv },
      )
      assert.equal(alpha2.code, 0, alpha2.stderr)
      assert.equal(JSON.parse(alpha2.stdout).structuredContent.dedupHits, 1)

      // Session B (via AGY_PULSE_SESSION_ID) reading the exact same file MUST NOT get a dedup hit from Session A
      const beta1 = await runNode(
        [MCP_ENTRY, '--cli', 'read', 'src/target.ts', '--cwd', subRepo, '--json'],
        { env: { ...liveCliEnv, AGY_PULSE_SESSION_ID: 'swarm-beta' } },
      )
      assert.equal(beta1.code, 0, beta1.stderr)
      const beta1Json = JSON.parse(beta1.stdout)
      assert.equal(beta1Json.structuredContent.dedupHits, 0)
      assert.match(beta1Json.text, /item_11/)
    } finally {
      try {
        serverProc.kill('SIGTERM')
      } catch {
        // Ignore.
      }
      await new Promise((r) => setTimeout(r, 120))
      rmSync(liveDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('supports install, config --tool-loading hybrid/lazy/eager and --tool-guard on/off, doctor self-check, and uninstall', async () => {
    const installDir = mkdtempSync(join(tmpdir(), 'agy-pulse-p2-inst-'))
    try {
      const inst = await runNode([INSTALL_SCRIPT, 'install', `--target=${installDir}`])
      assert.equal(inst.code, 0, inst.stderr)
      assert.equal(existsSync(join(installDir, 'plugin.json')), true)
      assert.equal(existsSync(join(installDir, 'mcp_config.json')), true)

      const defaultCfg = JSON.parse(readFileSync(join(installDir, 'mcp_config.json'), 'utf8'))
      assert.equal(defaultCfg.mcpServers.pulse.tools.pulse_read_files.eager, false)
      assert.equal(defaultCfg.mcpServers.pulse.tools.pulse_exec.eager, false)
      assert.equal(defaultCfg.mcpServers.pulse.tools.pulse_result.eager, false)

      const setLazy = await runNode([
        INSTALL_SCRIPT,
        'config',
        '--tool-loading',
        'lazy',
        `--target=${installDir}`,
      ])
      assert.equal(setLazy.code, 0, setLazy.stderr)
      const lazyCfg = JSON.parse(readFileSync(join(installDir, 'mcp_config.json'), 'utf8'))
      assert.equal(lazyCfg.mcpServers.pulse.tools.pulse_read_files.eager, false)

      const setEager = await runNode([
        INSTALL_SCRIPT,
        'config',
        '--tool-loading',
        'eager',
        `--target=${installDir}`,
      ])
      assert.equal(setEager.code, 0, setEager.stderr)
      const eagerCfg = JSON.parse(readFileSync(join(installDir, 'mcp_config.json'), 'utf8'))
      assert.equal(eagerCfg.mcpServers.pulse.tools.pulse_read_files.eager, true)
      assert.equal(eagerCfg.mcpServers.pulse.tools.pulse_result.eager, true)

      const setHybridGuardOff = await runNode([
        INSTALL_SCRIPT,
        'config',
        '--tool-loading',
        'hybrid',
        '--tool-guard',
        'off',
        `--target=${installDir}`,
      ])
      assert.equal(setHybridGuardOff.code, 0, setHybridGuardOff.stderr)
      const hybridCfg = JSON.parse(readFileSync(join(installDir, 'mcp_config.json'), 'utf8'))
      assert.equal(hybridCfg.mcpServers.pulse.tools.pulse_exec.eager, true)
      assert.equal(hybridCfg.mcpServers.pulse.tools.pulse_job.eager, false)
      const hooksOff = JSON.parse(readFileSync(join(installDir, 'hooks.json'), 'utf8'))
      assert.equal(hooksOff['agy-pulse-tool-guard'].enabled, false)

      const setGuardOn = await runNode([
        INSTALL_SCRIPT,
        'config',
        '--tool-guard',
        'on',
        `--target=${installDir}`,
      ])
      assert.equal(setGuardOn.code, 0, setGuardOn.stderr)
      const hooksOn = JSON.parse(readFileSync(join(installDir, 'hooks.json'), 'utf8'))
      assert.equal(hooksOn['agy-pulse-tool-guard'].enabled, true)

      const doc = await runNode([INSTALL_SCRIPT, 'doctor', `--target=${installDir}`])
      assert.equal(doc.code, 0, `${doc.stdout}\n${doc.stderr}`)
      assert.match(doc.stdout, /All 7 checks passed/)

      const uninst = await runNode([INSTALL_SCRIPT, 'uninstall', `--target=${installDir}`])
      assert.equal(uninst.code, 0, uninst.stderr)
      assert.equal(existsSync(installDir), false)
    } finally {
      if (existsSync(installDir)) {
        rmSync(installDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      }
    }
  })
})
