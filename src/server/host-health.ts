import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type {
  HostHealthEntry,
  HostHealthSnapshot,
  HostMcpStatus,
} from '../shared/types.ts'

const MIN_RECOMMENDED_TIMEOUT_SECONDS = 180
const SAFE_REPAIR_TIMEOUT_SECONDS = 86_400

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getGeminiHome(): string {
  return process.env.GEMINI_HOME?.trim() || path.join(homedir(), '.gemini')
}

function resolveUserMcpConfigPath(): string {
  return path.join(getGeminiHome(), 'config', 'mcp_config.json')
}

function resolvePluginMcpConfigPath(): string {
  return path.join(getGeminiHome(), 'config', 'plugins', 'agy-pulse', 'mcp_config.json')
}

function isExistingFile(filePath: string | undefined): boolean {
  if (!filePath || filePath.trim().length === 0) return false
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

function safeRealpath(filePath: string): string {
  try {
    return realpathSync(filePath)
  } catch {
    return path.resolve(filePath)
  }
}

function pathsReferToSameFile(a: string, b: string): boolean {
  const ra = safeRealpath(a)
  const rb = safeRealpath(b)
  return process.platform === 'win32'
    ? ra.toLowerCase() === rb.toLowerCase()
    : ra === rb
}

function expandPluginVars(rawPath: string, pluginRootDir?: string): string {
  if (!pluginRootDir) return rawPath
  return rawPath.replace(/\$\{PLUGIN_ROOT\}/g, pluginRootDir)
}

function looksLikePathCommand(command: string): boolean {
  return command.includes('/') || command.includes('\\') || path.isAbsolute(command)
}

function findPulseServerEntry(
  mcpServers: Record<string, unknown>,
): { key: string; entry: Record<string, unknown> } | null {
  for (const key of ['pulse', 'agy-pulse', 'agy-pulse_pulse']) {
    const candidate = mcpServers[key]
    if (isRecord(candidate)) {
      return { key, entry: candidate }
    }
  }
  for (const [key, candidate] of Object.entries(mcpServers)) {
    if (!isRecord(candidate)) continue
    const args = Array.isArray(candidate.args) ? candidate.args : []
    const mentionsPulse = args.some(
      (a) =>
        typeof a === 'string' &&
        (a.includes('agy-pulse') || a.endsWith('mcp-server.mjs')),
    )
    if (mentionsPulse) {
      return { key, entry: candidate }
    }
  }
  return null
}

function parseTimeoutSeconds(entry: Record<string, unknown>): number | null {
  if (typeof entry.timeoutSeconds === 'number' && Number.isFinite(entry.timeoutSeconds)) {
    return entry.timeoutSeconds
  }
  if (typeof entry.timeout === 'number' && Number.isFinite(entry.timeout)) {
    return entry.timeout > 1000 ? Math.round(entry.timeout / 1000) : entry.timeout
  }
  return null
}

function inspectConfigFile(opts: {
  host: string
  configPath: string
  pluginRootDir?: string
  expectedServerPath?: string
  required: boolean
}): { entry: HostHealthEntry; warnings: string[] } {
  const warnings: string[] = []
  const { host, configPath, pluginRootDir, expectedServerPath, required } = opts

  if (!existsSync(configPath)) {
    return {
      entry: {
        host,
        configPath,
        status: required ? 'missing' : 'unknown',
        detail: required
          ? `Config file not found at ${configPath}`
          : `No standalone entry at ${configPath}`,
        timeoutSeconds: null,
        repairable: required,
      },
      warnings: required
        ? [`${host}: MCP config not found at ${configPath}`]
        : [],
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      entry: {
        host,
        configPath,
        status: 'stale',
        detail: `Invalid JSON in ${configPath}: ${msg}`,
        timeoutSeconds: null,
        repairable: false,
      },
      warnings: [`${host}: malformed JSON in ${configPath}`],
    }
  }

  const mcpServers =
    isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : null
  const found = mcpServers ? findPulseServerEntry(mcpServers) : null

  if (!found) {
    return {
      entry: {
        host,
        configPath,
        status: required ? 'missing' : 'unknown',
        detail: required
          ? `No pulse / agy-pulse entry in ${configPath}`
          : `No standalone pulse entry in ${configPath}`,
        timeoutSeconds: null,
        repairable: true,
      },
      warnings: required
        ? [`${host}: no pulse entry in ${configPath}`]
        : [],
    }
  }

  const { entry: serverCfg } = found
  const rawCommand = typeof serverCfg.command === 'string' ? serverCfg.command : ''
  const rawArg0 =
    Array.isArray(serverCfg.args) && typeof serverCfg.args[0] === 'string'
      ? serverCfg.args[0]
      : undefined
  const timeoutSeconds = parseTimeoutSeconds(serverCfg)

  const commandPath = rawCommand
    ? expandPluginVars(rawCommand, pluginRootDir)
    : undefined
  const scriptPath = rawArg0 ? expandPluginVars(rawArg0, pluginRootDir) : undefined

  const problems: string[] = []
  let status: HostMcpStatus = 'ok'

  if (!commandPath) {
    status = 'stale'
    problems.push('missing command field')
  } else if (looksLikePathCommand(commandPath) && !isExistingFile(commandPath)) {
    status = 'stale'
    problems.push(`command not found: ${commandPath}`)
  }

  if (scriptPath) {
    if (!isExistingFile(scriptPath)) {
      status = 'stale'
      problems.push(`script not found: ${scriptPath}`)
    } else if (
      expectedServerPath &&
      isExistingFile(expectedServerPath) &&
      !pathsReferToSameFile(scriptPath, expectedServerPath)
    ) {
      // Only flag mismatch if the config isn't pointing to the installed plugin copy intentionally
      if (!pluginRootDir) {
        status = 'stale'
        problems.push(`script points to ${scriptPath} instead of ${expectedServerPath}`)
      }
    }
  } else if (commandPath && !looksLikePathCommand(commandPath)) {
    status = 'stale'
    problems.push('missing mcp-server.mjs argument')
  }

  if (timeoutSeconds === null) {
    warnings.push(
      `${host}: timeoutSeconds is unset (Antigravity defaults to 180s; recommend >= ${MIN_RECOMMENDED_TIMEOUT_SECONDS}s)`,
    )
  } else if (timeoutSeconds < MIN_RECOMMENDED_TIMEOUT_SECONDS) {
    warnings.push(
      `${host}: timeoutSeconds=${timeoutSeconds}s is below recommended ${MIN_RECOMMENDED_TIMEOUT_SECONDS}s`,
    )
  }

  const detail =
    status === 'ok'
      ? `mcpServers.${found.key} ok${timeoutSeconds !== null ? ` (timeoutSeconds=${timeoutSeconds}s)` : ' (default 180s timeout)'}`
      : `mcpServers.${found.key} stale: ${problems.join('; ')}`

  if (status !== 'ok') {
    warnings.push(`${host}: ${detail}`)
  }

  return {
    entry: {
      host,
      configPath,
      status,
      detail,
      timeoutSeconds,
      commandPath: scriptPath ?? commandPath,
      repairable:
        status !== 'ok' ||
        timeoutSeconds === null ||
        timeoutSeconds < MIN_RECOMMENDED_TIMEOUT_SECONDS,
    },
    warnings,
  }
}

/**
 * Symlink-preserving atomic JSON write (`0600` on POSIX when newly created, preserving
 * existing permissions when overwriting).
 */
function writeJsonAtomic(filePath: string, data: unknown): void {
  let target = filePath
  let mode: number | undefined = process.platform === 'win32' ? undefined : 0o600
  try {
    target = realpathSync(filePath)
    if (process.platform !== 'win32') {
      mode = statSync(target).mode & 0o777
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw err
    }
  }

  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const serialized = `${JSON.stringify(data, null, 2)}\n`
  writeFileSync(tmp, serialized, {
    encoding: 'utf8',
    ...(mode !== undefined ? { mode } : {}),
  })
  renameSync(tmp, target)
}

/**
 * Inspects Antigravity plugin and user MCP configuration files without spawning child processes.
 */
export function inspectAntigravityHostHealth(
  expectedServerPath?: string,
): HostHealthSnapshot {
  const checkedAt = Date.now()
  const pluginConfigPath = resolvePluginMcpConfigPath()
  const pluginRootDir = path.dirname(pluginConfigPath)
  const userConfigPath = resolveUserMcpConfigPath()

  const pluginPresent = existsSync(pluginConfigPath)
  const userHasPulse = (() => {
    if (!existsSync(userConfigPath)) return false
    try {
      const parsed = JSON.parse(readFileSync(userConfigPath, 'utf8'))
      return Boolean(
        isRecord(parsed) &&
          isRecord(parsed.mcpServers) &&
          findPulseServerEntry(parsed.mcpServers),
      )
    } catch {
      return false
    }
  })()

  const entries: HostHealthEntry[] = []
  const warnings: string[] = []

  const pluginRes = inspectConfigFile({
    host: 'antigravity-plugin',
    configPath: pluginConfigPath,
    pluginRootDir,
    expectedServerPath,
    required: !userHasPulse,
  })
  entries.push(pluginRes.entry)
  warnings.push(...pluginRes.warnings)

  if (userHasPulse || !pluginPresent) {
    const userRes = inspectConfigFile({
      host: 'antigravity-user',
      configPath: userConfigPath,
      expectedServerPath,
      required: !pluginPresent,
    })
    entries.push(userRes.entry)
    warnings.push(...userRes.warnings)
  }

  return {
    checkedAt,
    entries,
    warnings,
  }
}

/**
 * Atomically repairs stale paths or missing/low `timeoutSeconds` in the Antigravity
 * plugin or user MCP configuration file. Preserves symlinks and unrelated servers.
 */
export function repairAntigravityHostConfig(expectedServerPath: string): {
  repaired: boolean
  detail: string
  snapshot: HostHealthSnapshot
} {
  const resolvedServer = path.resolve(expectedServerPath)
  if (!isExistingFile(resolvedServer)) {
    const snapshot = inspectAntigravityHostHealth(resolvedServer)
    return {
      repaired: false,
      detail: `Expected MCP server bundle does not exist: ${resolvedServer}`,
      snapshot,
    }
  }

  const pluginConfigPath = resolvePluginMcpConfigPath()
  const pluginRootDir = path.dirname(pluginConfigPath)
  const userConfigPath = resolveUserMcpConfigPath()

  const actions: string[] = []

  if (existsSync(pluginConfigPath)) {
    try {
      const parsed = JSON.parse(readFileSync(pluginConfigPath, 'utf8'))
      if (isRecord(parsed)) {
        const servers = isRecord(parsed.mcpServers) ? { ...parsed.mcpServers } : {}
        const existing = findPulseServerEntry(servers)
        const key = existing?.key ?? 'pulse'
        const current = existing ? { ...existing.entry } : {}

        const pluginDistServer = path.join(
          pluginRootDir,
          'sidecars',
          'pulse',
          'dist',
          'mcp-server.mjs',
        )
        const targetArg = isExistingFile(pluginDistServer)
          ? '${PLUGIN_ROOT}/sidecars/pulse/dist/mcp-server.mjs'
          : resolvedServer

        let changed = false
        if (current.command !== 'node') {
          current.command = 'node'
          changed = true
        }
        const curArgs = Array.isArray(current.args) ? current.args : []
        if (curArgs[0] !== targetArg) {
          current.args = [targetArg]
          changed = true
        }
        const timeout = parseTimeoutSeconds(current)
        if (timeout === null || timeout < MIN_RECOMMENDED_TIMEOUT_SECONDS) {
          current.timeoutSeconds = SAFE_REPAIR_TIMEOUT_SECONDS
          changed = true
        }
        if (changed) {
          servers[key] = current
          writeJsonAtomic(pluginConfigPath, { ...parsed, mcpServers: servers })
          actions.push(`Updated ${pluginConfigPath} (mcpServers.${key})`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        repaired: false,
        detail: `Failed repairing ${pluginConfigPath}: ${msg}`,
        snapshot: inspectAntigravityHostHealth(resolvedServer),
      }
    }
  }

  // Fall back to repairing the user config when no plugin config exists or it already defines pulse.
  const userHasEntry = (() => {
    if (!existsSync(userConfigPath)) return false
    try {
      const parsed = JSON.parse(readFileSync(userConfigPath, 'utf8'))
      return Boolean(
        isRecord(parsed) &&
          isRecord(parsed.mcpServers) &&
          findPulseServerEntry(parsed.mcpServers),
      )
    } catch {
      return false
    }
  })()

  if (userHasEntry || !existsSync(pluginConfigPath)) {
    try {
      const base = existsSync(userConfigPath)
        ? JSON.parse(readFileSync(userConfigPath, 'utf8'))
        : {}
      if (!isRecord(base)) {
        throw new Error(`${userConfigPath} root is not a JSON object`)
      }
      const servers = isRecord(base.mcpServers) ? { ...base.mcpServers } : {}
      const existing = findPulseServerEntry(servers)
      const key = existing?.key ?? 'pulse'
      const current = existing ? { ...existing.entry } : {}

      let changed = false
      if (current.command !== 'node') {
        current.command = 'node'
        changed = true
      }
      const curArgs = Array.isArray(current.args) ? current.args : []
      if (
        typeof curArgs[0] !== 'string' ||
        !isExistingFile(curArgs[0]) ||
        !pathsReferToSameFile(curArgs[0], resolvedServer)
      ) {
        current.args = [resolvedServer]
        changed = true
      }
      const timeout = parseTimeoutSeconds(current)
      if (timeout === null || timeout < MIN_RECOMMENDED_TIMEOUT_SECONDS) {
        current.timeoutSeconds = SAFE_REPAIR_TIMEOUT_SECONDS
        changed = true
      }
      if (changed) {
        servers[key] = current
        writeJsonAtomic(userConfigPath, { ...base, mcpServers: servers })
        actions.push(`Updated ${userConfigPath} (mcpServers.${key})`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        repaired: actions.length > 0,
        detail: `Failed repairing ${userConfigPath}: ${msg}`,
        snapshot: inspectAntigravityHostHealth(resolvedServer),
      }
    }
  }

  const snapshot = inspectAntigravityHostHealth(resolvedServer)
  return {
    repaired: actions.length > 0,
    detail:
      actions.length > 0
        ? actions.join('; ')
        : 'Host MCP configuration is already healthy.',
    snapshot,
  }
}
