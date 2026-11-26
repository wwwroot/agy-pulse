import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const IS_WIN = process.platform === 'win32'
const WORKER_BIN_NAME = IS_WIN ? 'agy-pulse-worker.exe' : 'agy-pulse-worker'
const EXPECTED_TOOLS = [
  'pulse_exec',
  'pulse_job',
  'pulse_mutate',
  'pulse_read_doc',
  'pulse_read_files',
  'pulse_result',
  'pulse_search',
]
const CORE_EAGER_TOOLS = new Set([
  'pulse_read_files',
  'pulse_search',
  'pulse_mutate',
  'pulse_exec',
])

function isLockError(err) {
  if (!err || typeof err !== 'object') return false
  const code = 'code' in err ? err.code : undefined
  const errno = 'errno' in err ? err.errno : undefined
  return (
    code === 'EBUSY' ||
    code === 'EPERM' ||
    code === 'EACCES' ||
    code === 'EPIPE' ||
    errno === 32
  )
}

function parseArgValue(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1)
    if (arg === flag && i + 1 < argv.length) return argv[i + 1]
  }
  return undefined
}

function resolveTargetDir(argv) {
  const explicit = parseArgValue(argv, '--target')
  if (explicit) return resolve(explicit)
  if (argv.includes('--project')) {
    return join(process.cwd(), '.agents', 'plugins', 'agy-pulse')
  }
  const geminiHome = process.env.GEMINI_HOME?.trim() || join(homedir(), '.gemini')
  return join(geminiHome, 'config', 'plugins', 'agy-pulse')
}

function applyToolLoading(mcpConfigPath, mode) {
  const raw = JSON.parse(readFileSync(mcpConfigPath, 'utf8'))
  const pulse = raw?.mcpServers?.pulse
  if (!pulse || typeof pulse !== 'object') {
    throw new Error(`Invalid mcp_config.json at ${mcpConfigPath}: missing mcpServers.pulse`)
  }
  if (mode === 'lazy') {
    pulse.tools = Object.fromEntries(EXPECTED_TOOLS.map((name) => [name, { eager: false }]))
  } else if (mode === 'hybrid') {
    pulse.tools = Object.fromEntries(
      EXPECTED_TOOLS.map((name) => [name, { eager: CORE_EAGER_TOOLS.has(name) }]),
    )
  } else {
    pulse.tools = Object.fromEntries(EXPECTED_TOOLS.map((name) => [name, { eager: true }]))
  }
  writeFileSync(mcpConfigPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
}

function applyToolGuard(hooksPath, enabled) {
  const raw = JSON.parse(readFileSync(hooksPath, 'utf8'))
  const guard = raw?.['agy-pulse-tool-guard']
  if (!guard || typeof guard !== 'object') {
    throw new Error(`Invalid hooks.json at ${hooksPath}: missing agy-pulse-tool-guard`)
  }
  guard.enabled = enabled
  writeFileSync(hooksPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
}

function getWorkerReleaseUrl(version) {
  const ext = IS_WIN ? '.exe' : ''
  const assetName = `agy-pulse-worker-${process.platform}-${process.arch}${ext}`
  return `https://github.com/wwwroot/agy-pulse/releases/download/v${version}/${assetName}`
}

async function downloadWorkerBinary(version, dest) {
  const url = getWorkerReleaseUrl(version)
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  })
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status} from ${url}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) {
    throw new Error(`Empty binary response from ${url}`)
  }

  mkdirSync(dirname(dest), { recursive: true })
  const tmpPath = `${dest}.download.${process.pid}`
  writeFileSync(tmpPath, buf)
  try {
    renameSync(tmpPath, dest)
  } catch (err) {
    if (IS_WIN && existsSync(dest) && isLockError(err)) {
      renameSync(dest, `${dest}.old.${Date.now()}`)
      renameSync(tmpPath, dest)
    } else {
      rmSync(tmpPath, { force: true })
      throw err
    }
  }
  if (!IS_WIN) {
    chmodSync(dest, 0o755)
  }
  return url
}

async function cmdInstall(argv) {
  const targetDir = resolveTargetDir(argv)
  const toolLoading = parseArgValue(argv, '--tool-loading')
  if (
    toolLoading &&
    toolLoading !== 'hybrid' &&
    toolLoading !== 'eager' &&
    toolLoading !== 'lazy'
  ) {
    console.error(
      `[install] Invalid --tool-loading value "${toolLoading}". Use "hybrid", "eager", or "lazy".`,
    )
    process.exit(1)
  }
  const toolGuard = parseArgValue(argv, '--tool-guard')
  if (toolGuard && toolGuard !== 'on' && toolGuard !== 'off') {
    console.error(`[install] Invalid --tool-guard value "${toolGuard}". Use "on" or "off".`)
    process.exit(1)
  }

  const distDir = join(ROOT, 'sidecars', 'pulse', 'dist')
  const workerArtifact = join(distDir, WORKER_BIN_NAME)
  const requiredArtifacts = [
    join(distDir, 'server.mjs'),
    join(distDir, 'mcp-server.mjs'),
    join(distDir, 'hook-session.mjs'),
    join(distDir, 'main.js'),
    join(distDir, 'styles.css'),
    workerArtifact,
  ]

  const missing = requiredArtifacts.filter((artifact) => !existsSync(artifact))
  const missingJs = missing.filter((artifact) => artifact !== workerArtifact)
  if (missingJs.length > 0) {
    console.error(
      `[install] Missing built dist artifacts (${missingJs.join(', ')}). Run \`npm run build\` first.`,
    )
    process.exit(1)
  }

  if (missing.includes(workerArtifact)) {
    const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
    const url = getWorkerReleaseUrl(pkgVersion)
    console.log(`[install] Missing ${WORKER_BIN_NAME}; downloading from ${url}`)
    try {
      await downloadWorkerBinary(pkgVersion, workerArtifact)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(
        `[install] Missing built dist artifact (${workerArtifact}) and release download failed (${msg}). Run \`npm run build\` first.`,
      )
      process.exit(1)
    }
  }

  mkdirSync(targetDir, { recursive: true })

  const targetDistDir = join(targetDir, 'sidecars', 'pulse', 'dist')
  if (existsSync(targetDistDir)) {
    for (const name of readdirSync(targetDistDir)) {
      const isStaleWorker = name.startsWith(`${WORKER_BIN_NAME}.old.`)
      const isLegacyPty =
        name === 'agy-pulse-pty' ||
        name === 'agy-pulse-pty.exe' ||
        name.startsWith('agy-pulse-pty.exe.old.') ||
        name.startsWith('agy-pulse-pty.old.')
      if (isStaleWorker || isLegacyPty) {
        const stalePath = join(targetDistDir, name)
        try {
          rmSync(stalePath, { force: true })
        } catch (err) {
          if (isLegacyPty && !name.includes('.old.') && isLockError(err)) {
            try {
              renameSync(stalePath, `${stalePath}.old.${Date.now()}`)
            } catch {
              // Ignore still-locked legacy binaries until the process exits.
            }
          }
        }
      }
    }
  }

  const targetWorkerBin = join(targetDistDir, WORKER_BIN_NAME)
  const items = [
    'plugin.json',
    'mcp_config.json',
    'hooks.json',
    'assets',
    'skills',
    'rules',
    'sidecars',
    'README.md',
    'LICENSE',
  ]

  for (const item of items) {
    const src = join(ROOT, item)
    if (!existsSync(src)) continue
    try {
      cpSync(src, join(targetDir, item), { recursive: true, force: true })
    } catch (err) {
      if (item === 'sidecars' && existsSync(targetWorkerBin) && isLockError(err)) {
        // Windows locks running .exe files against in-place overwrite, yet allows renaming in the same directory.
        renameSync(targetWorkerBin, `${targetWorkerBin}.old.${Date.now()}`)
        cpSync(src, join(targetDir, item), { recursive: true, force: true })
      } else {
        throw err
      }
    }
  }

  if (!IS_WIN && existsSync(targetWorkerBin)) {
    chmodSync(targetWorkerBin, 0o755)
  }

  if (toolLoading) {
    applyToolLoading(join(targetDir, 'mcp_config.json'), toolLoading)
  }
  if (toolGuard) {
    applyToolGuard(join(targetDir, 'hooks.json'), toolGuard === 'on')
  }

  console.log(`[install] Installed agy-pulse runtime plugin to ${targetDir}`)
}

function cmdConfig(argv) {
  const targetDir = resolveTargetDir(argv)
  const toolLoading = parseArgValue(argv, '--tool-loading')
  const toolGuard = parseArgValue(argv, '--tool-guard')
  if (!toolLoading && !toolGuard) {
    console.error(
      '[config] Usage: node scripts/install.mjs config [--tool-loading <hybrid|eager|lazy>] [--tool-guard <on|off>] [--target=<dir>]',
    )
    process.exit(1)
  }
  if (
    toolLoading &&
    toolLoading !== 'hybrid' &&
    toolLoading !== 'eager' &&
    toolLoading !== 'lazy'
  ) {
    console.error(
      '[config] Invalid --tool-loading value. Use: hybrid | eager | lazy',
    )
    process.exit(1)
  }
  if (toolGuard && toolGuard !== 'on' && toolGuard !== 'off') {
    console.error('[config] Invalid --tool-guard value. Use: on | off')
    process.exit(1)
  }
  if (toolLoading) {
    const mcpPath = join(targetDir, 'mcp_config.json')
    if (!existsSync(mcpPath)) {
      console.error(`[config] mcp_config.json not found at ${mcpPath}. Run install first.`)
      process.exit(1)
    }
    applyToolLoading(mcpPath, toolLoading)
    console.log(`[config] Set tool-loading=${toolLoading} in ${mcpPath}`)
    if (toolLoading !== 'lazy') {
      console.log(
        '[config] Note: Antigravity may evict/disable eager MCP tools when many plugins are installed. Switch back to `--tool-loading lazy` if any pulse_* tool reports disabled.',
      )
    }
  }
  if (toolGuard) {
    const hooksPath = join(targetDir, 'hooks.json')
    if (!existsSync(hooksPath)) {
      console.error(`[config] hooks.json not found at ${hooksPath}. Run install first.`)
      process.exit(1)
    }
    applyToolGuard(hooksPath, toolGuard === 'on')
    console.log(`[config] Set tool-guard=${toolGuard} in ${hooksPath}`)
  }
}

function cmdUninstall(argv) {
  const targetDir = resolveTargetDir(argv)
  if (!existsSync(targetDir)) {
    console.log(`[uninstall] Nothing to remove at ${targetDir}`)
    return
  }
  try {
    rmSync(targetDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 80 })
    console.log(`[uninstall] Removed agy-pulse plugin from ${targetDir}`)
  } catch (err) {
    console.error(
      `[uninstall] Failed removing ${targetDir} (${err instanceof Error ? err.message : String(err)}). Close Antigravity and retry.`,
    )
    process.exit(1)
  }
}

function runWorkerDaemonSmoke(workerBin, probeDir) {
  return new Promise((resolveProbe, rejectProbe) => {
    const started = Date.now()
    const child = spawn(workerBin, ['--daemon'], {
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
      rejectProbe(new Error('Worker --daemon smoke test timed out after 8000ms'))
    }, 8_000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', (err) => {
      clearTimeout(timer)
      rejectProbe(err)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      const line = stdout.trim().split(/\r?\n/)[0]
      if (!line) {
        rejectProbe(new Error(`Worker returned empty output (code=${code}): ${stderr}`))
        return
      }
      try {
        const parsed = JSON.parse(line)
        if (parsed.ok !== true) {
          rejectProbe(new Error(`Worker returned error: ${JSON.stringify(parsed.error)}`))
          return
        }
        resolveProbe({ durationMs: Date.now() - started, code })
      } catch (err) {
        rejectProbe(new Error(`Malformed worker JSON: ${err instanceof Error ? err.message : String(err)}`))
      }
    })

    const req = JSON.stringify({
      op: 'stat',
      roots: [probeDir],
      credentialFence: true,
      maxInlineBytes: 7800,
      args: { path: '.' },
    })
    child.stdin.end(`${req}\n`)
  })
}

function runMcpHandshakeSmoke(mcpEntry, probeDir, workerBin) {
  return new Promise((resolveSmoke, rejectSmoke) => {
    const started = Date.now()
    const tmpData = mkdtempSync(join(tmpdir(), 'agy-pulse-doctor-'))
    const child = spawn(process.execPath, [mcpEntry], {
      cwd: probeDir,
      env: {
        ...process.env,
        AGY_PULSE_DATA_DIR: tmpData,
        ANTIGRAVITY_WORKSPACE_DIR: probeDir,
        AGY_PULSE_WORKER_BIN: workerBin,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let buf = ''
    let stderr = ''
    let stage = 'init'
    const cleanup = () => {
      clearTimeout(timer)
      try {
        child.stdin.end()
      } catch {
        // Ignore.
      }
      try {
        child.kill('SIGTERM')
      } catch {
        // Ignore.
      }
      try {
        rmSync(tmpData, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      } catch {
        // Ignore.
      }
    }

    const timer = setTimeout(() => {
      cleanup()
      rejectSmoke(new Error(`MCP handshake timed out at stage=${stage}`))
    }, 10_000)

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c) => {
      stderr += c
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === 1 && stage === 'init') {
          stage = 'list'
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
        } else if (msg.id === 2 && stage === 'list') {
          const tools = msg.result?.tools ?? []
          const names = tools.map((t) => t.name).sort()
          const schemaBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8')
          cleanup()
          resolveSmoke({ durationMs: Date.now() - started, names, schemaBytes, stderr })
          return
        }
      }
    })
    child.once('error', (err) => {
      cleanup()
      rejectSmoke(err)
    })

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'agy-pulse-doctor', version: '1.0.0' },
        },
      })}\n`,
    )
  })
}

const MIN_SAFE_TIMEOUT_SECONDS = 180
const REPAIR_TIMEOUT_SECONDS = 86_400

function isPlainObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFileSafe(p) {
  if (!p || typeof p !== 'string') return false
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function writeJsonAtomicPreserveSymlink(filePath, data) {
  let target = filePath
  let mode = IS_WIN ? undefined : 0o600
  try {
    target = realpathSync(filePath)
    if (!IS_WIN) {
      mode = statSync(target).mode & 0o777
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: 'utf8',
    ...(mode !== undefined ? { mode } : {}),
  })
  renameSync(tmp, target)
}

function findPulseEntryInServers(servers) {
  for (const key of ['pulse', 'agy-pulse', 'agy-pulse_pulse']) {
    if (isPlainObj(servers[key])) return { key, entry: servers[key] }
  }
  for (const [key, entry] of Object.entries(servers)) {
    if (!isPlainObj(entry)) continue
    const args = Array.isArray(entry.args) ? entry.args : []
    if (args.some((a) => typeof a === 'string' && (a.includes('agy-pulse') || a.endsWith('mcp-server.mjs')))) {
      return { key, entry }
    }
  }
  return null
}

function inspectAndMaybeRepairHostMcp(targetDir, doRepair) {
  const geminiHome = process.env.GEMINI_HOME?.trim() || join(homedir(), '.gemini')
  const pluginMcpPath = join(targetDir, 'mcp_config.json')
  const userMcpPath = join(geminiHome, 'config', 'mcp_config.json')
  const expectedServerPath = join(targetDir, 'sidecars', 'pulse', 'dist', 'mcp-server.mjs')
  const repairs = []
  const warnings = []
  const problems = []

  const checkOne = (label, cfgPath, pluginRoot) => {
    if (!existsSync(cfgPath)) return { present: false }
    let parsed
    try {
      parsed = JSON.parse(readFileSync(cfgPath, 'utf8'))
    } catch (err) {
      problems.push(`${label}: invalid JSON (${err instanceof Error ? err.message : String(err)})`)
      return { present: true }
    }
    const servers = isPlainObj(parsed) && isPlainObj(parsed.mcpServers) ? parsed.mcpServers : null
    const found = servers ? findPulseEntryInServers(servers) : null
    if (!found) return { present: false }

    const entry = found.entry
    const rawArg0 = Array.isArray(entry.args) && typeof entry.args[0] === 'string' ? entry.args[0] : ''
    const resolvedArg0 = pluginRoot ? rawArg0.replace(/\$\{PLUGIN_ROOT\}/g, pluginRoot) : rawArg0
    const timeout = typeof entry.timeoutSeconds === 'number' ? entry.timeoutSeconds : null
    const argMissing = !isFileSafe(resolvedArg0)
    const timeoutLow = timeout === null || timeout < MIN_SAFE_TIMEOUT_SECONDS

    if (doRepair && (argMissing || timeoutLow) && isFileSafe(expectedServerPath)) {
      const nextEntry = { ...entry }
      if (argMissing) {
        nextEntry.command = 'node'
        nextEntry.args = [pluginRoot ? '${PLUGIN_ROOT}/sidecars/pulse/dist/mcp-server.mjs' : expectedServerPath]
      }
      if (timeoutLow) {
        nextEntry.timeoutSeconds = REPAIR_TIMEOUT_SECONDS
      }
      const nextServers = { ...servers, [found.key]: nextEntry }
      writeJsonAtomicPreserveSymlink(cfgPath, { ...parsed, mcpServers: nextServers })
      repairs.push(`${label} (${cfgPath})`)
      return { present: true, repaired: true }
    }

    if (argMissing) {
      problems.push(`${label}: stale script path "${resolvedArg0 || '(missing)'}"`)
    }
    if (timeoutLow) {
      warnings.push(
        `${label}: timeoutSeconds=${timeout ?? 'unset'} (recommend >= ${MIN_SAFE_TIMEOUT_SECONDS}s; run \`doctor --repair\`)`,
      )
    }
    return { present: true }
  }

  const pluginInfo = checkOne('plugin', pluginMcpPath, targetDir)
  const userInfo = checkOne('user', userMcpPath, null)

  if (!pluginInfo.present && !userInfo.present) {
    problems.push(`No pulse MCP entry found in ${pluginMcpPath} or ${userMcpPath}`)
  }

  return { ok: problems.length === 0, repairs, warnings, problems }
}

async function cmdDoctor(argv) {
  const targetDir = resolveTargetDir(argv)
  const doRepair = argv.includes('--repair')
  const checks = []
  const pass = (name, detail) => checks.push({ ok: true, name, detail })
  const fail = (name, detail) => checks.push({ ok: false, name, detail })

  // Check host MCP configuration in-process (and repair if requested).
  const hostHealth = inspectAndMaybeRepairHostMcp(targetDir, doRepair)
  if (hostHealth.ok) {
    const repairSuffix =
      hostHealth.repairs.length > 0 ? ` · repaired: ${hostHealth.repairs.join(', ')}` : ''
    const warnSuffix =
      hostHealth.warnings.length > 0 ? ` · warn: ${hostHealth.warnings.join('; ')}` : ''
    pass('host mcp health', `OK${repairSuffix}${warnSuffix}`)
  } else {
    fail('host mcp health', hostHealth.problems.join('; '))
  }

  const manifestPath = join(targetDir, 'plugin.json')
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (m.name === 'agy-pulse' && typeof m.version === 'string') {
        pass('plugin.json', `v${m.version} (${targetDir})`)
      } else {
        fail('plugin.json', 'Missing required name/version fields')
      }
    } catch (err) {
      fail('plugin.json', `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    fail('plugin.json', `Not found at ${manifestPath}`)
  }

  const mcpConfigPath = join(targetDir, 'mcp_config.json')
  if (existsSync(mcpConfigPath)) {
    try {
      const cfg = JSON.parse(readFileSync(mcpConfigPath, 'utf8'))
      const toolsCfg = cfg?.mcpServers?.pulse?.tools ?? {}
      const eagerTools = EXPECTED_TOOLS.filter((t) => toolsCfg[t]?.eager === true)
      const isHybrid =
        eagerTools.length === CORE_EAGER_TOOLS.size &&
        eagerTools.every((t) => CORE_EAGER_TOOLS.has(t))
      const modeDetail =
        eagerTools.length === 0
          ? `${EXPECTED_TOOLS.length}/${EXPECTED_TOOLS.length} tools lazy (eviction-safe)`
          : isHybrid
            ? `${eagerTools.length}/${EXPECTED_TOOLS.length} core tools eager, ${EXPECTED_TOOLS.length - eagerTools.length} lazy (hybrid)`
            : `${eagerTools.length}/${EXPECTED_TOOLS.length} tools eager`
      pass('mcp_config.json', modeDetail)
    } catch (err) {
      fail('mcp_config.json', `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    fail('mcp_config.json', `Not found at ${mcpConfigPath}`)
  }

  // Verify SessionStart/PreInvocation hooks and selective PreToolUse guard (no wildcard matcher).
  const hooksPath = join(targetDir, 'hooks.json')
  if (existsSync(hooksPath)) {
    try {
      const h = JSON.parse(readFileSync(hooksPath, 'utf8'))
      const bind = h['agy-pulse-session-bind']
      const guard = h['agy-pulse-tool-guard']
      const hasStart = Array.isArray(bind?.SessionStart) && bind.SessionStart.length > 0
      const hasPreInvocation = Array.isArray(bind?.PreInvocation) && bind.PreInvocation.length > 0
      const hasWildcardPreTool =
        Boolean(bind?.PreToolUse) ||
        (Array.isArray(guard?.PreToolUse) &&
          guard.PreToolUse.some((g) => !g?.matcher || g.matcher === '*' || g.matcher === '.*'))
      const hasSelectiveGuard =
        Array.isArray(guard?.PreToolUse) &&
        guard.PreToolUse.length > 0 &&
        guard.PreToolUse.every(
          (g) =>
            typeof g?.matcher === 'string' &&
            g.matcher.includes('run_command') &&
            g.matcher.includes('swarm'),
        )
      if (hasStart && hasPreInvocation && hasSelectiveGuard && !hasWildcardPreTool) {
        const guardState = guard?.enabled === false ? 'disabled' : 'enabled'
        pass(
          'hooks.json',
          `SessionStart + PreInvocation multi-workspace sync + selective built-in PreToolUse guard (${guardState}, 0 happy-path tax)`,
        )
      } else {
        fail(
          'hooks.json',
          `Invalid hooks config (hasStart=${hasStart}, hasPreInvocation=${hasPreInvocation}, hasSelectiveGuard=${hasSelectiveGuard}, hasWildcardPreTool=${hasWildcardPreTool})`,
        )
      }
    } catch (err) {
      fail('hooks.json', `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    fail('hooks.json', `Not found at ${hooksPath}`)
  }

  const distDir = join(targetDir, 'sidecars', 'pulse', 'dist')
  const required = ['server.mjs', 'mcp-server.mjs', 'hook-session.mjs', 'main.js', 'styles.css', WORKER_BIN_NAME]
  const missing = required.filter((f) => !existsSync(join(distDir, f)))
  if (missing.length === 0) {
    pass('dist artifacts', `All ${required.length} bundles & native worker present`)
  } else {
    fail('dist artifacts', `Missing: ${missing.join(', ')}`)
  }

  // 5. Live Rust worker --daemon smoke test (copy to %TEMP% on Windows if needed)
  const distWorkerBin = join(distDir, WORKER_BIN_NAME)
  let tempBinDir = null
  let activeWorkerBin = distWorkerBin
  const probeDir = mkdtempSync(join(tmpdir(), 'agy-pulse-probe-'))
  try {
    if (existsSync(distWorkerBin)) {
      if (IS_WIN) {
        tempBinDir = mkdtempSync(join(tmpdir(), 'agy-pulse-docbin-'))
        activeWorkerBin = join(tempBinDir, WORKER_BIN_NAME)
        copyFileSync(distWorkerBin, activeWorkerBin)
      }
      try {
        const w = await runWorkerDaemonSmoke(activeWorkerBin, probeDir)
        pass('rust-worker --daemon', `OK in ${w.durationMs}ms`)
      } catch (err) {
        fail('rust-worker --daemon', err instanceof Error ? err.message : String(err))
      }
    } else {
      fail('rust-worker --daemon', 'Skipped (binary missing)')
    }

    // 6. Live MCP initialize + tools/list handshake
    const mcpEntry = join(distDir, 'mcp-server.mjs')
    if (existsSync(mcpEntry)) {
      try {
        const m = await runMcpHandshakeSmoke(mcpEntry, probeDir, activeWorkerBin)
        const namesOk = JSON.stringify(m.names) === JSON.stringify(EXPECTED_TOOLS)
        const budgetOk = m.schemaBytes <= 10_752
        if (namesOk && budgetOk) {
          pass('mcp handshake', `7/7 tools, schema=${m.schemaBytes} B (<= 10.5 KB) in ${m.durationMs}ms`)
        } else {
          fail(
            'mcp handshake',
            `namesOk=${namesOk}, schemaBytes=${m.schemaBytes} (limit 10752)`,
          )
        }
      } catch (err) {
        fail('mcp handshake', err instanceof Error ? err.message : String(err))
      }
    } else {
      fail('mcp handshake', 'Skipped (mcp-server.mjs missing)')
    }
  } finally {
    if (IS_WIN) {
      await new Promise((r) => setTimeout(r, 60))
    }
    rmSync(probeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    if (tempBinDir) {
      rmSync(tempBinDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  }

  console.log(`\n[agy-pulse doctor] target: ${targetDir}`)
  for (const c of checks) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(22)} ${c.detail}`)
  }

  const failed = checks.filter((c) => !c.ok)
  if (failed.length > 0) {
    console.error(`\n[agy-pulse doctor] ${failed.length} check(s) failed.`)
    process.exit(1)
  }
  console.log(`\n[agy-pulse doctor] All ${checks.length} checks passed.`)
}

const rawArgs = process.argv.slice(2)
const sub = rawArgs[0] && !rawArgs[0].startsWith('-') ? rawArgs[0] : 'install'
const subArgs = rawArgs[0] && !rawArgs[0].startsWith('-') ? rawArgs.slice(1) : rawArgs

switch (sub) {
  case 'install':
    await cmdInstall(subArgs)
    break
  case 'doctor':
  case 'status':
    await cmdDoctor(subArgs)
    break
  case 'config':
    cmdConfig(subArgs)
    break
  case 'uninstall':
    cmdUninstall(subArgs)
    break
  default:
    console.error(
      `[agy-pulse] Unknown subcommand "${sub}". Use: install | doctor | status | config | uninstall`,
    )
    process.exit(1)
}
