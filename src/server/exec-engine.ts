import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { checkCredentialFence, checkDownloadGuard, detectSleepPolling } from '../shared/guards.ts'
import { normalizeWorkdir, resolveAuthorizedFile } from '../shared/paths.ts'
import type { ActivityItem, ExecOutcome, ExecRequest, FailureInfo } from '../shared/types.ts'
import type { ActivityStore } from './activity-store.ts'
import type { ConfigStore } from './config.ts'
import { buildJsonDigest } from './json-digest.ts'
import { JobManager, killProcessTree } from './job-manager.ts'
import { compactTerminalStream, packFailureHeadTail } from './output-compactor.ts'
import type { SessionManager } from './session-manager.ts'
import type { ShellDiscovery } from './shells.ts'
import type { SpillStore } from './spill-store.ts'
import { estimateTokensFromBytes, type TelemetryStore } from './telemetry-store.ts'

const MAX_SCRIPT_SCAN_BYTES = 512 * 1024
const EXIT_STREAM_GRACE_MS = 250

export const DANGEROUS_CALLER_ENV_VARS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'BASH_ENV',
  'ENV',
  'GIT_SSH_COMMAND',
  'PYTHONSTARTUP',
  'PERL5OPT',
  'RUBYOPT',
])

export interface ExecEngineDeps {
  configStore: ConfigStore
  shellDiscovery: ShellDiscovery
  spillStore: SpillStore
  jobManager: JobManager
  sessionManager?: SessionManager
  activityStore?: ActivityStore
  telemetryStore?: TelemetryStore
  getWorkspaceRoots: (sessionId?: string) => Promise<string[]>
}

function generateExecId(): string {
  return `exec_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
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

function makeCommandPreview(req: ExecRequest): string {
  if (req.scriptPath && req.scriptPath.trim()) {
    return `[script] ${req.scriptPath.trim()}`
  }
  const oneLine = (req.command || '').replace(/\s+/g, ' ').trim()
  return oneLine.length > 180 ? `${oneLine.slice(0, 177)}...` : oneLine
}

function readScriptPreviewForGuards(filePath: string): string {
  let fd: number | undefined
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(MAX_SCRIPT_SCAN_BYTES)
    const bytesRead = readSync(fd, buf, 0, MAX_SCRIPT_SCAN_BYTES, 0)
    return buf.subarray(0, bytesRead).toString('utf-8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Ignore close error.
      }
    }
  }
}

/**
 * Builds a non-interactive shell environment that disables ANSI colors and pagers
 * while preserving UTF-8 LC_CTYPE.
 */
export function buildNonInteractiveEnv(callerEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  env.NO_COLOR = '1'
  env.TERM = 'dumb'
  env.PAGER = 'cat'
  env.GIT_PAGER = 'cat'
  env.LC_MESSAGES = 'C'

  if (!env.LC_CTYPE && process.platform !== 'win32') {
    const lang = env.LANG || ''
    if (/utf-?8/i.test(lang)) {
      env.LC_CTYPE = lang
    }
  }

  if (callerEnv && typeof callerEnv === 'object') {
    for (const [key, value] of Object.entries(callerEnv)) {
      if (typeof key !== 'string' || key.length === 0 || typeof value !== 'string') continue
      if (DANGEROUS_CALLER_ENV_VARS.has(key.trim().toUpperCase())) continue
      env[key] = value
    }
  }

  return env
}

export class ExecEngine {
  private readonly configStore: ConfigStore
  private readonly shellDiscovery: ShellDiscovery
  private readonly spillStore: SpillStore
  private readonly jobManager: JobManager
  private readonly sessionManager?: SessionManager
  private readonly fallbackActivityStore?: ActivityStore
  private readonly fallbackTelemetryStore?: TelemetryStore
  private readonly getWorkspaceRoots: (sessionId?: string) => Promise<string[]>

  constructor(deps: ExecEngineDeps) {
    this.configStore = deps.configStore
    this.shellDiscovery = deps.shellDiscovery
    this.spillStore = deps.spillStore
    this.jobManager = deps.jobManager
    this.sessionManager = deps.sessionManager
    this.fallbackActivityStore = deps.activityStore
    this.fallbackTelemetryStore = deps.telemetryStore
    this.getWorkspaceRoots = deps.getWorkspaceRoots
  }

  async execute(
    req: ExecRequest,
    source: 'agent' | 'user' = 'agent',
    sessionId?: string,
  ): Promise<ExecOutcome> {
    const id = generateExecId()
    const startedAt = Date.now()
    const config = this.configStore.get()
    const session = this.sessionManager?.getSession(sessionId)
    const effectiveSessionId = session?.sessionId
    const activityStore = session?.activityStore ?? this.fallbackActivityStore
    const telemetryStore = session?.telemetryStore ?? this.fallbackTelemetryStore
    const description =
      typeof req.description === 'string' && req.description.trim().length > 0
        ? req.description.trim().slice(0, 200)
        : makeCommandPreview(req) || 'Run terminal command'
    const commandPreview = makeCommandPreview(req)
    const mirror = req.mirrorToActivity !== false

    const reject = (
      failure: FailureInfo,
      shellLabel = req.shell || 'auto',
      cwd = req.workdir || '',
    ): ExecOutcome => {
      const durationMs = Math.max(0, Date.now() - startedAt)
      if (mirror && activityStore) {
        activityStore.record({
          id,
          kind: 'exec',
          source,
          description,
          commandPreview,
          shell: shellLabel,
          cwd,
          status: 'rejected',
          exitCode: null,
          effectState: failure.effectState,
          errorCode: failure.code,
          durationMs,
          startedAt,
          endedAt: Date.now(),
          outputPreview: failure.message,
          sessionId: effectiveSessionId,
          anomaly: true,
          acknowledged: false,
        })
      }
      return {
        status: 'rejected',
        kind: req.runInBackground ? 'background' : 'foreground',
        id,
        description,
        shell: shellLabel,
        cwd,
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: false,
        durationMs,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        failure,
      }
    }

    const hasCommand = typeof req.command === 'string' && req.command.trim().length > 0
    const hasScriptPath = typeof req.scriptPath === 'string' && req.scriptPath.trim().length > 0
    if (hasCommand === hasScriptPath) {
      return reject({
        code: 'INVALID_EXEC_ARGS',
        message: hasCommand
          ? 'Both "command" and "scriptPath" were provided. Provide exactly one.'
          : 'Neither "command" nor "scriptPath" was provided. Provide exactly one.',
        effectState: 'none',
        retry: 'after-input-change',
        nextAction:
          'Specify either "command" for a short shell expression or "scriptPath" for a script file inside the workspace.',
      })
    }

    const workspaceRoots = await this.getWorkspaceRoots(effectiveSessionId)
    if (session && !session.workspaceRoot && workspaceRoots[0]) {
      session.workspaceRoot = workspaceRoots[0]
    }
    const workdirRes = normalizeWorkdir(req.workdir, workspaceRoots)
    if (!workdirRes.ok) {
      return reject(workdirRes.failure)
    }
    const cwd = workdirRes.path

    try {
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        return reject(
          {
            code: 'WORKDIR_NOT_FOUND',
            message: `Working directory "${cwd}" does not exist or is not a directory.`,
            effectState: 'none',
            retry: 'after-input-change',
            nextAction: 'Provide an existing directory inside the workspace or omit workdir.',
          },
          req.shell || 'auto',
          cwd,
        )
      }
    } catch {
      return reject(
        {
          code: 'WORKDIR_NOT_ACCESSIBLE',
          message: `Working directory "${cwd}" could not be accessed.`,
          effectState: 'none',
          retry: 'after-input-change',
          nextAction: 'Verify the working directory path and permissions.',
        },
        req.shell || 'auto',
        cwd,
      )
    }

    let resolvedScriptPath = ''
    let textForGuards = req.command ?? ''
    if (hasScriptPath) {
      const scriptRes = resolveAuthorizedFile(req.scriptPath!, workspaceRoots)
      if (!scriptRes.ok) {
        return reject(scriptRes.failure, req.shell || 'auto', cwd)
      }
      resolvedScriptPath = scriptRes.path
      try {
        if (!existsSync(resolvedScriptPath) || !statSync(resolvedScriptPath).isFile()) {
          return reject(
            {
              code: 'SCRIPT_NOT_FOUND',
              message: `Script file "${resolvedScriptPath}" does not exist or is not a regular file.`,
              effectState: 'none',
              retry: 'after-input-change',
              nextAction: 'Create the script file inside the workspace before executing it.',
            },
            req.shell || 'auto',
            cwd,
          )
        }
      } catch {
        return reject(
          {
            code: 'SCRIPT_NOT_ACCESSIBLE',
            message: `Script file "${resolvedScriptPath}" could not be read.`,
            effectState: 'none',
            retry: 'after-input-change',
            nextAction: 'Verify the script file path and permissions.',
          },
          req.shell || 'auto',
          cwd,
        )
      }
      textForGuards = readScriptPreviewForGuards(resolvedScriptPath)
    }

    // Resolve shell early so error messages and Download Guard have the concrete shell ID.
    const shellInfo = await this.shellDiscovery.resolveShell(req.shell, config.defaultShell)
    if (!shellInfo) {
      const available = (await this.shellDiscovery.detect())
        .filter((s) => s.available)
        .map((s) => s.id)
      return reject(
        {
          code: 'SHELL_UNAVAILABLE',
          message: `Requested shell "${req.shell || config.defaultShell}" is not available on this host.`,
          effectState: 'none',
          retry: 'after-input-change',
          nextAction:
            available.length > 0
              ? `Use shell "auto" or one of the available host shells: ${available.join(', ')}.`
              : 'Install a supported shell on the host system and refresh shell diagnostics.',
        },
        req.shell || config.defaultShell,
        cwd,
      )
    }

    if (config.enableCredentialFence) {
      const cwdFence = checkCredentialFence(cwd)
      if (cwdFence.blocked && cwdFence.failure) {
        return reject(cwdFence.failure, shellInfo.id, cwd)
      }
      const execFence = checkCredentialFence(resolvedScriptPath, textForGuards)
      if (execFence.blocked && execFence.failure) {
        return reject(execFence.failure, shellInfo.id, cwd)
      }
    }

    if (config.enableDownloadGuard) {
      const dlGuard = checkDownloadGuard(
        textForGuards,
        shellInfo.id,
        config.downloadGuardTemplate,
      )
      if (dlGuard.blocked && dlGuard.failure) {
        return reject(dlGuard.failure, shellInfo.id, cwd)
      }
    }

    let guidance: string | undefined
    if (hasCommand && this.jobManager.hasRunningJobs()) {
      const sleepNudge = detectSleepPolling(req.command!)
      if (sleepNudge) {
        guidance = sleepNudge
      }
    }

    const mode = hasScriptPath ? 'script' : 'exec'
    const payload = hasScriptPath ? resolvedScriptPath : req.command!
    const invocation = this.shellDiscovery.resolveCommand(shellInfo, mode, payload)
    const env = buildNonInteractiveEnv(req.env)

    if (req.runInBackground) {
      const job = this.jobManager.startJob({
        activityId: mirror ? id : undefined,
        sessionId: effectiveSessionId,
        activityStore,
        description,
        shell: shellInfo.id,
        executable: invocation.executable,
        args: invocation.args,
        cwd,
        commandPreview,
        env,
        maxInlineBytes: config.maxInlineBytes,
        maxSpillBytes: config.maxSpillBytes,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      })

      if (mirror && activityStore) {
        activityStore.record({
          id,
          kind: 'job',
          source,
          description,
          commandPreview,
          shell: shellInfo.id,
          cwd,
          status: 'running',
          exitCode: null,
          durationMs: 0,
          startedAt,
          jobId: job.id,
          sessionId: effectiveSessionId,
          anomaly: false,
          acknowledged: true,
        })
      }

      return {
        status: 'running',
        kind: 'background',
        id,
        jobId: job.id,
        description,
        shell: shellInfo.id,
        cwd,
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: false,
        durationMs: Math.max(0, Date.now() - startedAt),
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        guidance:
          guidance ??
          `Background job "${job.id}" started. Use pulse_job({ action: "output", job_id: "${job.id}", wait: true }) to read output or wait for completion.`,
      }
    }

    if (mirror && activityStore) {
      activityStore.record({
        id,
        kind: 'exec',
        source,
        description,
        commandPreview,
        shell: shellInfo.id,
        cwd,
        status: 'running',
        exitCode: null,
        durationMs: 0,
        startedAt,
        sessionId: effectiveSessionId,
        anomaly: false,
        acknowledged: true,
      })
    }

    const rawTimeout =
      typeof req.timeoutMs === 'number' && Number.isFinite(req.timeoutMs)
        ? req.timeoutMs
        : config.defaultTimeoutMs
    const timeoutMs = Math.max(1_000, Math.min(config.maxTimeoutMs, Math.round(rawTimeout)))

    return new Promise<ExecOutcome>((resolvePromise) => {
      const child = spawn(invocation.executable, invocation.args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      })

      // Close stdin immediately for non-interactive foreground commands so prompts do not hang.
      try {
        child.stdin?.end()
      } catch {
        // Ignore already-closed stdin.
      }

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let stdoutCapped = false
      let stderrCapped = false
      let spawned = typeof child.pid === 'number' && child.pid > 0
      let settled = false
      let exitGraceTimer: ReturnType<typeof setTimeout> | undefined

      const clearExitGraceTimer = () => {
        if (exitGraceTimer) {
          clearTimeout(exitGraceTimer)
          exitGraceTimer = undefined
        }
      }

      const onSpawn = () => {
        spawned = true
      }

      const onStdout = (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (stdoutBytes + buf.length <= config.maxSpillBytes) {
          stdoutChunks.push(buf)
          stdoutBytes += buf.length
        } else {
          const remaining = config.maxSpillBytes - stdoutBytes
          if (remaining > 0) {
            stdoutChunks.push(buf.subarray(0, remaining))
            stdoutBytes += remaining
          }
          stdoutCapped = true
        }
      }

      const onStderr = (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (stderrBytes + buf.length <= config.maxSpillBytes) {
          stderrChunks.push(buf)
          stderrBytes += buf.length
        } else {
          const remaining = config.maxSpillBytes - stderrBytes
          if (remaining > 0) {
            stderrChunks.push(buf.subarray(0, remaining))
            stderrBytes += remaining
          }
          stderrCapped = true
        }
      }

      const detachForegroundListeners = () => {
        clearExitGraceTimer()
        child.off('spawn', onSpawn)
        child.stdout?.off('data', onStdout)
        child.stderr?.off('data', onStderr)
        child.off('error', onError)
        child.off('exit', onExit)
        child.off('close', onClose)
      }

      const finalizeOutput = (
        fullStdout: string,
        fullStderr: string,
        meta: Record<string, unknown>,
        allowDigest: boolean,
      ) => {
        const rawCombinedBytes =
          Buffer.byteLength(fullStdout, 'utf-8') + Buffer.byteLength(fullStderr, 'utf-8')

        const compactedOut = compactTerminalStream(fullStdout, allowDigest && config.enableJsonDigest)
        const compactedErr = compactTerminalStream(fullStderr, false)
        const cleanStdout = compactedOut.text
        const cleanStderr = compactedErr.text
        const compactedBytes =
          Buffer.byteLength(cleanStdout, 'utf-8') + Buffer.byteLength(cleanStderr, 'utf-8')

        let refId: string | undefined
        let spillPath: string | undefined
        let inlineStdout = cleanStdout
        let inlineStderr = cleanStderr
        let stdoutTruncated = stdoutCapped
        let stderrTruncated = stderrCapped

        if (compactedBytes > config.maxInlineBytes || stdoutCapped || stderrCapped) {
          try {
            const saved = this.spillStore.save({
              stdout: fullStdout,
              stderr: fullStderr,
              sessionId: effectiveSessionId,
              meta: {
                ...meta,
                ...(effectiveSessionId ? { sessionId: effectiveSessionId } : {}),
              },
            })
            refId = saved.refId
            spillPath = saved.spillPath
          } catch {
            // Non-fatal spill error; still apply inline truncation below.
          }

          const stderrBudget =
            cleanStderr.length === 0
              ? 0
              : Math.min(Buffer.byteLength(cleanStderr, 'utf-8'), Math.floor(config.maxInlineBytes * 0.35))
          const stdoutBudget = Math.max(512, config.maxInlineBytes - stderrBudget)

          const tOut = allowDigest
            ? truncateUtf8(cleanStdout, stdoutBudget)
            : packFailureHeadTail(cleanStdout, stdoutBudget)
          const tErr = allowDigest
            ? truncateUtf8(cleanStderr, Math.max(256, stderrBudget || config.maxInlineBytes))
            : packFailureHeadTail(cleanStderr, Math.max(256, stderrBudget || config.maxInlineBytes))
          inlineStdout = tOut.text
          inlineStderr = tErr.text
          stdoutTruncated = stdoutTruncated || tOut.truncated
          stderrTruncated = stderrTruncated || tErr.truncated
        }

        let jsonDigest =
          allowDigest && config.enableJsonDigest
            ? buildJsonDigest(fullStdout, { fullRefId: refId, fullPath: spillPath })
            : undefined

        // If a JSON digest was produced for an unspilled output (e.g. 8-16 KiB), spill it so pointers are valid.
        if (jsonDigest && !refId) {
          try {
            const saved = this.spillStore.save({
              stdout: fullStdout,
              stderr: fullStderr,
              sessionId: effectiveSessionId,
              meta: {
                ...meta,
                ...(effectiveSessionId ? { sessionId: effectiveSessionId } : {}),
              },
            })
            refId = saved.refId
            spillPath = saved.spillPath
            jsonDigest = { ...jsonDigest, fullRefId: refId, fullPath: spillPath }
          } catch {
            // Leave digest without spill pointer if disk write fails.
          }
        }

        const rawBytes = rawCombinedBytes
        let deliveredBytes =
          Buffer.byteLength(inlineStdout, 'utf-8') + Buffer.byteLength(inlineStderr, 'utf-8')

        if (jsonDigest) {
          const digestBytes =
            Buffer.byteLength(jsonDigest.summary, 'utf-8') +
            Buffer.byteLength(jsonDigest.preview, 'utf-8') +
            Buffer.byteLength(inlineStderr, 'utf-8')
          deliveredBytes = Math.min(deliveredBytes, digestBytes)
        }

        const savedBytes = Math.max(0, rawBytes - deliveredBytes)

        return {
          inlineStdout,
          inlineStderr,
          stdoutTruncated,
          stderrTruncated,
          refId,
          spillPath,
          jsonDigest,
          rawBytes,
          deliveredBytes,
          savedBytes,
        }
      }

      const onError = (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        detachForegroundListeners()

        const durationMs = Math.max(0, Date.now() - startedAt)
        const failure: FailureInfo = {
          code: 'SPAWN_FAILED',
          message: `Failed to spawn shell "${shellInfo.id}" (${invocation.executable}): ${err.message}`,
          effectState: spawned ? 'unknown' : 'none',
          retry: 'after-input-change',
          nextAction: 'Verify the shell executable exists and check pulse_result({ action: "stats" }) diagnostics.',
        }

        if (mirror && activityStore) {
          activityStore.update(id, {
            status: 'failed',
            exitCode: null,
            effectState: failure.effectState,
            errorCode: failure.code,
            durationMs,
            endedAt: Date.now(),
            outputPreview: failure.message,
          })
        }

        resolvePromise({
          status: 'failed',
          kind: 'foreground',
          id,
          description,
          shell: shellInfo.id,
          cwd,
          exitCode: null,
          signal: null,
          timedOut: false,
          cancelled: false,
          durationMs,
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8'),
          stdoutTruncated: stdoutCapped,
          stderrTruncated: stderrCapped,
          guidance,
          failure,
        })
      }

      const onExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled || exitGraceTimer) return
        // Give stdout/stderr pipes a short grace window to flush; if a detached grandchild
        // holds the pipes open after the shell exits, close them so the process does not hang.
        exitGraceTimer = setTimeout(() => {
          exitGraceTimer = undefined
          if (settled) return
          try {
            child.stdout?.destroy()
          } catch {
            // Ignore stream destroy failure.
          }
          try {
            child.stderr?.destroy()
          } catch {
            // Ignore stream destroy failure.
          }
          onClose(exitCode, signal)
        }, EXIT_STREAM_GRACE_MS)
        exitGraceTimer.unref()
      }

      const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        detachForegroundListeners()

        const durationMs = Math.max(0, Date.now() - startedAt)
        const fullStdout = Buffer.concat(stdoutChunks).toString('utf-8')
        const fullStderr = Buffer.concat(stderrChunks).toString('utf-8')
        const succeeded = exitCode === 0 && signal === null

        const out = finalizeOutput(
          fullStdout,
          fullStderr,
          {
            tool: 'pulse_exec',
            execId: id,
            description,
            shell: shellInfo.id,
            cwd,
            exitCode,
            signal,
            durationMs,
          },
          succeeded,
        )

        if (telemetryStore) {
          const categories: Partial<Record<'json-digest' | 'spillover', { calls: number; savedBytes: number }>> = {}
          if (out.jsonDigest && out.savedBytes > 0) {
            categories['json-digest'] = { calls: 1, savedBytes: out.savedBytes }
          } else if (out.savedBytes > 0) {
            categories.spillover = { calls: 1, savedBytes: out.savedBytes }
          }
          telemetryStore.record({
            rawBytes: out.rawBytes,
            deliveredBytes: out.deliveredBytes,
            savedBytes: out.savedBytes,
            durationMs,
            isShellExec: true,
            categories: Object.keys(categories).length > 0 ? categories : undefined,
          })
        }

        const status: ExecOutcome['status'] = succeeded ? 'completed' : 'failed'
        const failure: FailureInfo | undefined = succeeded
          ? undefined
          : {
              code: signal ? 'TERMINATED_BY_SIGNAL' : 'NON_ZERO_EXIT',
              message: signal
                ? `Command terminated by signal ${signal}.`
                : `Command exited with status code ${exitCode}.`,
              effectState: 'unknown',
              retry: 'after-input-change',
              nextAction: out.refId
                ? `Inspect stderr or page full output with pulse_result({ action: "page", ref_id: "${out.refId}" }).`
                : 'Inspect stdout/stderr to diagnose the failure before retrying.',
            }

        if (mirror && activityStore) {
          const preview = (out.inlineStdout || out.inlineStderr || failure?.message || '').slice(
            0,
            1024,
          )
          activityStore.update(id, {
            status,
            exitCode,
            effectState: succeeded ? 'applied' : 'unknown',
            errorCode: failure?.code,
            durationMs,
            endedAt: Date.now(),
            refId: out.refId,
            outputPreview: preview,
            savedBytes: out.savedBytes > 0 ? out.savedBytes : undefined,
            estimatedTokensSaved:
              out.savedBytes > 0 ? estimateTokensFromBytes(out.savedBytes) : undefined,
          })
        }

        resolvePromise({
          status,
          kind: 'foreground',
          id,
          description,
          shell: shellInfo.id,
          cwd,
          exitCode,
          signal,
          timedOut: false,
          cancelled: false,
          durationMs,
          stdout: out.inlineStdout,
          stderr: out.inlineStderr,
          stdoutTruncated: out.stdoutTruncated,
          stderrTruncated: out.stderrTruncated,
          refId: out.refId,
          spillPath: out.spillPath,
          jsonDigest: out.jsonDigest,
          guidance,
          failure,
        })
      }

      const timer = setTimeout(async () => {
        if (settled) return
        settled = true
        const durationMs = Math.max(0, Date.now() - startedAt)

        if (config.autoPromoteOnTimeout && spawned && child.exitCode === null && child.signalCode === null) {
          detachForegroundListeners()

          const job = this.jobManager.adoptProcess({
            activityId: mirror ? id : undefined,
            sessionId: effectiveSessionId,
            activityStore,
            description,
            shell: shellInfo.id,
            cwd,
            commandPreview,
            child,
            stdoutChunks,
            stderrChunks,
            startedAt,
            maxInlineBytes: config.maxInlineBytes,
            maxSpillBytes: config.maxSpillBytes,
          })

          const capturedStdout = Buffer.concat(stdoutChunks).toString('utf-8')
          const capturedStderr = Buffer.concat(stderrChunks).toString('utf-8')
          const out = finalizeOutput(
            capturedStdout,
            capturedStderr,
            {
              tool: 'pulse_exec',
              execId: id,
              jobId: job.id,
              description,
              shell: shellInfo.id,
              cwd,
              promoted: true,
              durationMs,
            },
            false,
          )

          if (telemetryStore && out.savedBytes > 0) {
            telemetryStore.record({
              rawBytes: out.rawBytes,
              deliveredBytes: out.deliveredBytes,
              savedBytes: out.savedBytes,
              durationMs,
              isShellExec: true,
              primaryCategory: 'spillover',
            })
          }

          const promotedGuidance =
            `Command exceeded ${timeoutMs} ms and was automatically promoted to background job "${job.id}". ` +
            `Use pulse_job({ action: "output", job_id: "${job.id}", wait: true }) to continue reading output, ` +
            `or pulse_job({ action: "kill", job_id: "${job.id}" }) to stop it.`

          if (mirror && activityStore) {
            const patch: Partial<ActivityItem> = {
              kind: 'job',
              status: 'promoted',
              jobId: job.id,
              durationMs,
              refId: out.refId,
              outputPreview: (out.inlineStdout || out.inlineStderr).slice(0, 1024),
              savedBytes: out.savedBytes > 0 ? out.savedBytes : undefined,
              estimatedTokensSaved:
                out.savedBytes > 0 ? estimateTokensFromBytes(out.savedBytes) : undefined,
            }
            activityStore.update(id, patch)
          }

          resolvePromise({
            status: 'promoted',
            kind: 'promoted',
            id,
            jobId: job.id,
            description,
            shell: shellInfo.id,
            cwd,
            exitCode: null,
            signal: null,
            timedOut: true,
            cancelled: false,
            durationMs,
            stdout: out.inlineStdout,
            stderr: out.inlineStderr,
            stdoutTruncated: out.stdoutTruncated,
            stderrTruncated: out.stderrTruncated,
            refId: out.refId,
            spillPath: out.spillPath,
            guidance: guidance ? `${promotedGuidance} ${guidance}` : promotedGuidance,
          })
          return
        }

        detachForegroundListeners()
        await killProcessTree(child.pid, child)

        const fullStdout = Buffer.concat(stdoutChunks).toString('utf-8')
        const fullStderr = Buffer.concat(stderrChunks).toString('utf-8')
        const out = finalizeOutput(
          fullStdout,
          fullStderr,
          {
            tool: 'pulse_exec',
            execId: id,
            description,
            shell: shellInfo.id,
            cwd,
            timedOut: true,
            durationMs,
          },
          false,
        )

        if (telemetryStore && out.savedBytes > 0) {
          telemetryStore.record({
            rawBytes: out.rawBytes,
            deliveredBytes: out.deliveredBytes,
            savedBytes: out.savedBytes,
            durationMs,
            isShellExec: true,
            primaryCategory: 'spillover',
          })
        }

        const failure: FailureInfo = {
          code: 'EXEC_TIMEOUT',
          message: `Command exceeded timeout of ${timeoutMs} ms and was terminated.`,
          effectState: 'unknown',
          retry: 'after-input-change',
          nextAction:
            'Increase timeoutMs, set runInBackground: true, or enable Auto-Promote on Timeout in Settings for long-running commands.',
        }

        if (mirror && activityStore) {
          activityStore.update(id, {
            status: 'failed',
            exitCode: null,
            effectState: failure.effectState,
            errorCode: failure.code,
            durationMs,
            endedAt: Date.now(),
            refId: out.refId,
            outputPreview: (out.inlineStdout || out.inlineStderr || failure.message).slice(0, 1024),
          })
        }

        resolvePromise({
          status: 'failed',
          kind: 'foreground',
          id,
          description,
          shell: shellInfo.id,
          cwd,
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: true,
          cancelled: false,
          durationMs,
          stdout: out.inlineStdout,
          stderr: out.inlineStderr,
          stdoutTruncated: out.stdoutTruncated,
          stderrTruncated: out.stderrTruncated,
          refId: out.refId,
          spillPath: out.spillPath,
          guidance,
          failure,
        })
      }, timeoutMs)
      timer.unref()

      child.on('spawn', onSpawn)
      child.stdout?.on('data', onStdout)
      child.stderr?.on('data', onStderr)
      child.on('error', onError)
      child.on('exit', onExit)
      child.on('close', onClose)
    })
  }
}
