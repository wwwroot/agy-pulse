import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FailureInfo } from '../shared/types.ts'

export type WorkerOp =
  | 'read_files'
  | 'stat'
  | 'glob'
  | 'fuzzy'
  | 'grep'
  | 'diff'
  | 'write'
  | 'edit'
  | 'replace'
  | 'batch'
  | 'read_doc'

export interface WorkerInvokeOptions {
  roots: string[]
  credentialFence: boolean
  maxInlineBytes: number
  timeoutMs?: number
}

export type WorkerInvokeResult<T> =
  | {
      ok: true
      result: T
      durationMs: number
    }
  | {
      ok: false
      failure: FailureInfo
      durationMs: number
    }

const MAX_STDOUT_BYTES = 4 * 1024 * 1024 // 4 MiB cap so Node can spill large outputs.
const MAX_STDERR_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 120_000
const MAX_CONCURRENT_REQUESTS = 8

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

function isExecutableBinary(filePath: string): boolean {
  if (!filePath) return false
  try {
    if (!existsSync(filePath)) return false
    if (process.platform === 'win32') {
      accessSync(filePath, constants.F_OK)
      return true
    }
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function getWorkerBinaryName(): string {
  return process.platform === 'win32' ? 'agy-pulse-worker.exe' : 'agy-pulse-worker'
}

function buildCandidatePaths(explicitPath?: string): string[] {
  const binName = getWorkerBinaryName()
  const candidates: string[] = []

  const add = (p?: string) => {
    if (p && p.trim().length > 0) {
      candidates.push(resolve(p.trim()))
    }
  }

  add(explicitPath)
  add(process.env.AGY_PULSE_WORKER_BIN)

  // 1. Beside bundled server.mjs / mcp-server.mjs in dist/
  add(join(MODULE_DIR, binName))

  // 2. Installed plugin sidecar dist/ or repo root / bin/
  const parent1 = dirname(MODULE_DIR)
  const parent2 = dirname(parent1)
  const parent3 = dirname(parent2)
  add(join(parent1, 'dist', binName))
  add(join(parent1, 'bin', binName))
  add(join(parent2, 'bin', binName))
  add(join(parent2, 'sidecars', 'pulse', 'dist', binName))
  add(join(parent3, 'bin', binName))
  add(join(parent3, 'sidecars', 'pulse', 'dist', binName))

  // 3. Windows NTFS Low-ACL Cargo fallback target directory
  const tempRoot = process.env.TEMP || process.env.TMP || tmpdir()
  if (tempRoot) {
    add(join(tempRoot, 'agy-pulse-cargo-target', 'release', binName))
  }

  // 4. Local native/target/release/ inside the repository
  add(join(parent2, 'native', 'target', 'release', binName))
  add(join(parent3, 'native', 'target', 'release', binName))

  return [...new Set(candidates)]
}

function normalizeFailure(raw: unknown, fallbackMessage: string): FailureInfo {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>
    const effectRaw = obj.effectState
    const effectState: FailureInfo['effectState'] =
      effectRaw === 'none' ||
      effectRaw === 'applied' ||
      effectRaw === 'partial' ||
      effectRaw === 'unknown'
        ? effectRaw
        : 'unknown'
    const retryRaw = obj.retry
    const retry: FailureInfo['retry'] =
      retryRaw === 'never' || retryRaw === 'after-input-change' || retryRaw === 'safe'
        ? retryRaw
        : 'after-input-change'
    return {
      code: typeof obj.code === 'string' && obj.code.trim() ? obj.code : 'WORKER_ERROR',
      message:
        typeof obj.message === 'string' && obj.message.trim() ? obj.message : fallbackMessage,
      effectState,
      retry,
      nextAction:
        typeof obj.nextAction === 'string' && obj.nextAction.trim()
          ? obj.nextAction
          : 'Inspect the request arguments and retry.',
    }
  }

  return {
    code: 'WORKER_ERROR',
    message: fallbackMessage,
    effectState: 'unknown',
    retry: 'after-input-change',
    nextAction: 'Verify the native agy-pulse-worker binary and retry.',
  }
}

interface PendingWorkerJob {
  reqId: string
  op: WorkerOp
  envelope: string
  binaryPath: string
  timeoutMs: number
  startedAt: number
  resolve: (outcome: WorkerInvokeResult<unknown>) => void
  timer?: ReturnType<typeof setTimeout>
}

function isMutatingOp(op: WorkerOp): boolean {
  return op === 'write' || op === 'edit' || op === 'replace' || op === 'batch'
}

export class RustWorker {
  private readonly explicitPath?: string
  private cachedPath?: string
  private daemonChild: ChildProcess | null = null
  private daemonBinaryPath?: string
  private daemonTainted = false
  private stdoutBuf: Buffer = Buffer.alloc(0)
  private stderrChunks: Buffer[] = []
  private stderrBytes = 0
  private nextReqId = 1
  private readonly queue: PendingWorkerJob[] = []
  private readonly inFlight = new Map<string, PendingWorkerJob>()
  private disposed = false

  constructor(explicitBinaryPath?: string) {
    this.explicitPath = explicitBinaryPath
    this.cachedPath = this.resolveBinaryPath()
  }

  private resolveBinaryPath(): string | undefined {
    for (const candidate of buildCandidatePaths(this.explicitPath)) {
      if (isExecutableBinary(candidate)) {
        return candidate
      }
    }
    return undefined
  }

  getBinaryPath(): string | undefined {
    if (this.cachedPath && isExecutableBinary(this.cachedPath)) {
      return this.cachedPath
    }
    this.cachedPath = this.resolveBinaryPath()
    return this.cachedPath
  }

  isAvailable(): boolean {
    return Boolean(this.getBinaryPath())
  }

  dispose(): void {
    this.disposed = true
    this.killDaemon()
    this.failAllInFlight((job) => ({
      code: 'WORKER_DISPOSED',
      message: `Native worker was shut down while "${job.op}" was in flight.`,
      effectState: isMutatingOp(job.op) ? 'unknown' : 'none',
      retry: 'safe',
      nextAction: 'Retry once the sidecar daemon restarts.',
    }))
    while (this.queue.length > 0) {
      const job = this.queue.shift()!
      this.settleJob(job, {
        ok: false,
        durationMs: Math.max(0, Date.now() - job.startedAt),
        failure: {
          code: 'WORKER_DISPOSED',
          message: `Native worker was shut down before "${job.op}" could run.`,
          effectState: 'none',
          retry: 'safe',
          nextAction: 'Retry once the sidecar daemon restarts.',
        },
      })
    }
  }

  private killDaemon(): void {
    const child = this.daemonChild
    this.daemonChild = null
    this.daemonBinaryPath = undefined
    this.daemonTainted = false
    this.stdoutBuf = Buffer.alloc(0)
    this.stderrChunks = []
    this.stderrBytes = 0
    if (child) {
      const swallow = () => {}
      child.removeAllListeners()
      child.stdout?.removeAllListeners()
      child.stderr?.removeAllListeners()
      child.stdin?.removeAllListeners()
      // Keep no-op error handlers attached so async EPIPE/EOF events emitted while
      // tearing down a killed child pipe never surface as unhandled exceptions.
      child.on('error', swallow)
      child.stdin?.on('error', swallow)
      child.stdout?.on('error', swallow)
      child.stderr?.on('error', swallow)
      try {
        child.stdin?.destroy()
      } catch {
        // Ignore already-closed stdin.
      }
      try {
        child.kill('SIGKILL')
      } catch {
        // Ignore already-exited child.
      }
    }
  }

  private settleJob(job: PendingWorkerJob, outcome: WorkerInvokeResult<unknown>): void {
    if (job.timer) {
      clearTimeout(job.timer)
      job.timer = undefined
    }
    this.inFlight.delete(job.reqId)
    job.resolve(outcome)
  }

  private failAllInFlight(buildFailure: (job: PendingWorkerJob) => FailureInfo): void {
    if (this.inFlight.size === 0) return
    const activeJobs = Array.from(this.inFlight.values())
    this.inFlight.clear()
    const now = Date.now()
    for (const job of activeJobs) {
      if (job.timer) {
        clearTimeout(job.timer)
        job.timer = undefined
      }
      job.resolve({
        ok: false,
        durationMs: Math.max(0, now - job.startedAt),
        failure: buildFailure(job),
      })
    }
  }

  private ensureDaemon(binaryPath: string): ChildProcess | Error {
    if (
      this.daemonChild &&
      this.daemonChild.exitCode === null &&
      !this.daemonChild.killed &&
      !this.daemonTainted &&
      this.daemonBinaryPath === binaryPath
    ) {
      return this.daemonChild
    }

    this.killDaemon()

    try {
      const child = spawn(binaryPath, ['--daemon'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })

      this.daemonChild = child
      this.daemonBinaryPath = binaryPath
      this.daemonTainted = false
      this.stdoutBuf = Buffer.alloc(0)
      this.stderrChunks = []
      this.stderrBytes = 0

      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (this.daemonChild !== child) return
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)

        // Check per-line ceiling before appending so a burst of concurrent responses does
        // not falsely trip MAX_STDOUT_BYTES while any single oversized line still fails safely.
        const firstNl = buf.indexOf(0x0a)
        const pendingLineBytes =
          firstNl === -1 ? this.stdoutBuf.length + buf.length : this.stdoutBuf.length + firstNl
        if (pendingLineBytes > MAX_STDOUT_BYTES) {
          this.killDaemon()
          this.failAllInFlight((job) => ({
            code: 'WORKER_OUTPUT_TOO_LARGE',
            message: `Native worker response for "${job.op}" exceeded the ${MAX_STDOUT_BYTES}-byte IPC buffer limit.`,
            effectState: isMutatingOp(job.op) ? 'unknown' : 'none',
            retry: 'after-input-change',
            nextAction:
              'Request smaller line ranges, a tighter glob filter, or a more compact search output_mode (summary, count, files_with_matches, or definitions).',
          }))
          this.pumpQueue()
          return
        }

        this.stdoutBuf =
          this.stdoutBuf.length === 0 ? buf : Buffer.concat([this.stdoutBuf, buf])
        this.processStdoutLines(child)
      })

      child.stderr?.on('data', (chunk: Buffer | string) => {
        if (this.daemonChild !== child) return
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (this.stderrBytes + buf.length <= MAX_STDERR_BYTES) {
          this.stderrChunks.push(buf)
          this.stderrBytes += buf.length
        }
      })

      child.stdin?.on('error', () => {
        // Handled by close/error listeners on the child process.
      })

      child.on('error', (err: Error) => {
        if (this.daemonChild !== child) return
        this.killDaemon()
        this.failAllInFlight(() => ({
          code: 'WORKER_SPAWN_FAILED',
          message: `Failed to spawn native worker "${binaryPath}": ${err.message}`,
          effectState: 'none',
          retry: 'after-input-change',
          nextAction: 'Verify the agy-pulse-worker binary permissions and integrity.',
        }))
        this.pumpQueue()
      })

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.daemonChild !== child) return
        const rawStderr = Buffer.concat(this.stderrChunks).toString('utf-8').trim()
        this.killDaemon()
        this.failAllInFlight((job) => ({
          code: 'WORKER_EMPTY_RESPONSE',
          message:
            rawStderr ||
            `Native worker exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`,
          effectState: isMutatingOp(job.op) ? 'unknown' : 'none',
          retry: 'after-input-change',
          nextAction: 'Check the worker binary and input payload before retrying.',
        }))
        this.pumpQueue()
      })

      return child
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err))
    }
  }

  private resolveTargetJob(reqId?: string): PendingWorkerJob | undefined {
    if (reqId !== undefined) {
      return this.inFlight.get(reqId)
    }
    // Backward compatibility fallback when a worker line omits reqId: match oldest in-flight job.
    const first = this.inFlight.values().next()
    return first.done ? undefined : first.value
  }

  private processStdoutLines(ownerChild: ChildProcess): void {
    while (this.daemonChild === ownerChild) {
      const nlIdx = this.stdoutBuf.indexOf(0x0a)
      if (nlIdx === -1) {
        if (this.stdoutBuf.length > MAX_STDOUT_BYTES) {
          this.killDaemon()
          this.failAllInFlight((job) => ({
            code: 'WORKER_OUTPUT_TOO_LARGE',
            message: `Native worker response for "${job.op}" exceeded the ${MAX_STDOUT_BYTES}-byte IPC buffer limit.`,
            effectState: isMutatingOp(job.op) ? 'unknown' : 'none',
            retry: 'after-input-change',
            nextAction:
              'Request smaller line ranges, a tighter glob filter, or a more compact search output_mode (summary, count, files_with_matches, or definitions).',
          }))
          this.pumpQueue()
        }
        return
      }

      if (nlIdx > MAX_STDOUT_BYTES) {
        this.killDaemon()
        this.failAllInFlight((job) => ({
          code: 'WORKER_OUTPUT_TOO_LARGE',
          message: `Native worker response for "${job.op}" exceeded the ${MAX_STDOUT_BYTES}-byte IPC buffer limit.`,
          effectState: isMutatingOp(job.op) ? 'unknown' : 'none',
          retry: 'after-input-change',
          nextAction:
            'Request smaller line ranges, a tighter glob filter, or a more compact search output_mode (summary, count, files_with_matches, or definitions).',
        }))
        this.pumpQueue()
        return
      }

      const line = this.stdoutBuf.subarray(0, nlIdx).toString('utf-8').trim()
      this.stdoutBuf = this.stdoutBuf.subarray(nlIdx + 1)

      if (!line) continue

      const rawStderr =
        this.stderrBytes > 0 ? Buffer.concat(this.stderrChunks).toString('utf-8').trim() : ''

      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (err) {
        const target = this.resolveTargetJob(undefined)
        if (target) {
          this.settleJob(target, {
            ok: false,
            durationMs: Math.max(0, Date.now() - target.startedAt),
            failure: {
              code: 'WORKER_INVALID_JSON',
              message: `Native worker returned malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
              effectState: 'unknown',
              retry: 'after-input-change',
              nextAction: 'Verify the agy-pulse-worker binary version matches the daemon.',
            },
          })
        }
        this.afterJobSettled()
        continue
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const target = this.resolveTargetJob(undefined)
        if (target) {
          this.settleJob(target, {
            ok: false,
            durationMs: Math.max(0, Date.now() - target.startedAt),
            failure: {
              code: 'WORKER_INVALID_RESPONSE',
              message: 'Native worker returned a non-object JSON payload.',
              effectState: 'unknown',
              retry: 'after-input-change',
              nextAction: 'Verify the agy-pulse-worker binary version matches the daemon.',
            },
          })
        }
        this.afterJobSettled()
        continue
      }

      const record = parsed as Record<string, unknown>
      const responseReqId = typeof record.reqId === 'string' ? record.reqId : undefined
      const target = this.resolveTargetJob(responseReqId)
      if (!target) {
        // Stale response for a timed-out or cancelled request.
        continue
      }

      const durationMs = Math.max(0, Date.now() - target.startedAt)
      if (record.ok === true) {
        this.settleJob(target, {
          ok: true,
          result: record.result,
          durationMs,
        })
      } else {
        this.settleJob(target, {
          ok: false,
          durationMs,
          failure: normalizeFailure(
            record.error,
            rawStderr || `Native worker operation "${target.op}" failed.`,
          ),
        })
      }

      this.afterJobSettled()
    }
  }

  private afterJobSettled(): void {
    if (this.inFlight.size === 0) {
      this.stderrChunks = []
      this.stderrBytes = 0
      if (this.daemonTainted) {
        this.killDaemon()
      }
    }
    this.pumpQueue()
  }

  private pumpQueue(): void {
    while (
      !this.disposed &&
      this.inFlight.size < MAX_CONCURRENT_REQUESTS &&
      this.queue.length > 0
    ) {
      const next = this.queue[0]
      if (
        this.inFlight.size > 0 &&
        (this.daemonTainted ||
          (this.daemonBinaryPath && this.daemonBinaryPath !== next.binaryPath))
      ) {
        // Wait for current daemon's in-flight requests to finish before respawning.
        return
      }

      const job = this.queue.shift()!
      const childOrErr = this.ensureDaemon(job.binaryPath)
      if (childOrErr instanceof Error) {
        this.settleJob(job, {
          ok: false,
          durationMs: Math.max(0, Date.now() - job.startedAt),
          failure: {
            code: 'WORKER_SPAWN_FAILED',
            message: `Failed to spawn native worker "${job.binaryPath}": ${childOrErr.message}`,
            effectState: 'none',
            retry: 'after-input-change',
            nextAction: 'Verify the agy-pulse-worker binary permissions and integrity.',
          },
        })
        continue
      }

      this.inFlight.set(job.reqId, job)

      const isMutating = isMutatingOp(job.op)
      job.timer = setTimeout(() => {
        if (!this.inFlight.has(job.reqId)) return
        this.settleJob(job, {
          ok: false,
          durationMs: Math.max(0, Date.now() - job.startedAt),
          failure: {
            code: 'WORKER_TIMEOUT',
            message: `Native worker operation "${job.op}" exceeded timeout of ${job.timeoutMs} ms.`,
            effectState: isMutating ? 'unknown' : 'none',
            retry: 'after-input-change',
            nextAction:
              'Narrow the target path, pattern, or range limit before retrying the operation.',
          },
        })
        if (this.inFlight.size === 0) {
          this.killDaemon()
        } else {
          // Avoid killing healthy concurrent requests; recycle daemon once in-flight work drains.
          this.daemonTainted = true
        }
        this.pumpQueue()
      }, job.timeoutMs)
      job.timer.unref()

      try {
        childOrErr.stdin?.write(`${job.envelope}\n`, 'utf-8')
      } catch (err) {
        this.settleJob(job, {
          ok: false,
          durationMs: Math.max(0, Date.now() - job.startedAt),
          failure: {
            code: 'WORKER_WRITE_FAILED',
            message: `Failed writing request to native worker: ${err instanceof Error ? err.message : String(err)}`,
            effectState: 'none',
            retry: 'safe',
            nextAction: 'Retry the operation; the persistent worker will respawn automatically.',
          },
        })
        this.killDaemon()
        this.failAllInFlight((peer) => ({
          code: 'WORKER_WRITE_FAILED',
          message: `Native worker IPC pipe broke while "${peer.op}" was in flight.`,
          effectState: isMutatingOp(peer.op) ? 'unknown' : 'none',
          retry: 'safe',
          nextAction: 'Retry the operation; the persistent worker will respawn automatically.',
        }))
        return
      }
    }
  }

  async invoke<T>(
    op: WorkerOp,
    args: Record<string, unknown>,
    options: WorkerInvokeOptions,
  ): Promise<WorkerInvokeResult<T>> {
    const startedAt = Date.now()
    const binaryPath = this.getBinaryPath()

    if (!binaryPath) {
      return {
        ok: false,
        durationMs: Math.max(0, Date.now() - startedAt),
        failure: {
          code: 'WORKER_UNAVAILABLE',
          message: `Native worker binary "${getWorkerBinaryName()}" was not found.`,
          effectState: 'none',
          retry: 'never',
          nextAction:
            'Build the native Rust worker (npm run build:rust) and rebuild/reinstall the plugin so agy-pulse-worker is available alongside server.mjs.',
        },
      }
    }

    if (this.disposed) {
      return {
        ok: false,
        durationMs: Math.max(0, Date.now() - startedAt),
        failure: {
          code: 'WORKER_DISPOSED',
          message: `Native worker was already shut down before "${op}" could run.`,
          effectState: 'none',
          retry: 'safe',
          nextAction: 'Retry once the sidecar daemon restarts.',
        },
      }
    }

    const timeoutMs = Math.max(
      MIN_TIMEOUT_MS,
      Math.min(
        MAX_TIMEOUT_MS,
        Math.round(
          typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
            ? options.timeoutMs
            : DEFAULT_TIMEOUT_MS,
        ),
      ),
    )

    const reqId = `req-${this.nextReqId++}`
    const envelope = JSON.stringify({
      reqId,
      op,
      roots: options.roots,
      credentialFence: options.credentialFence,
      maxInlineBytes: options.maxInlineBytes,
      args,
    })

    return new Promise<WorkerInvokeResult<T>>((resolvePromise) => {
      this.queue.push({
        reqId,
        op,
        envelope,
        binaryPath,
        timeoutMs,
        startedAt,
        resolve: resolvePromise as (outcome: WorkerInvokeResult<unknown>) => void,
      })
      this.pumpQueue()
    })
  }
}
