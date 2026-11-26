import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { promisify } from 'node:util'
import type { JobOutputResponse, JobSummary } from '../shared/types.ts'
import type { ActivityStore } from './activity-store.ts'
import type { SpillStore } from './spill-store.ts'

const execFileAsync = promisify(execFile)

const DEFAULT_MEMORY_CAP_BYTES = 2 * 1024 * 1024
const MAX_RETAINED_JOBS = 100

/**
 * Terminates a child process and its descendant tree across Windows and POSIX.
 */
export async function killProcessTree(
  pid: number | undefined,
  child?: ChildProcess,
): Promise<void> {
  if (typeof pid === 'number' && pid > 0) {
    if (process.platform === 'win32') {
      try {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          timeout: 5000,
          windowsHide: true,
        })
        return
      } catch {
        // Process may already have exited; fall through to direct kill fallback.
      }
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          return
        }
      }

      // Wait briefly for graceful shutdown before escalating to SIGKILL.
      const exited = await new Promise<boolean>((resolve) => {
        if (!child || child.exitCode !== null || child.signalCode !== null) {
          resolve(true)
          return
        }
        const timer = setTimeout(() => {
          child.off('exit', onExit)
          resolve(false)
        }, 2000)
        timer.unref()
        const onExit = () => {
          clearTimeout(timer)
          resolve(true)
        }
        child.once('exit', onExit)
      })

      if (!exited) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // Already gone.
          }
        }
      }
      return
    }
  }

  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL')
    } catch {
      // Ignore already-closed child handle.
    }
  }
}

/**
 * Non-consuming byte-offset ring buffer that retains up to `maxMemoryBytes`
 * of recent stream bytes while tracking cumulative stream offsets.
 */
class StreamRingBuffer {
  private readonly maxMemoryBytes: number
  private chunks: Buffer[] = []
  private memoryBytes = 0
  startOffset = 0
  totalBytes = 0

  constructor(maxMemoryBytes = DEFAULT_MEMORY_CAP_BYTES) {
    this.maxMemoryBytes = Math.max(16_384, maxMemoryBytes)
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.memoryBytes += chunk.length
    this.totalBytes += chunk.length

    while (this.memoryBytes > this.maxMemoryBytes && this.chunks.length > 0) {
      const overflow = this.memoryBytes - this.maxMemoryBytes
      const head = this.chunks[0]
      if (head.length <= overflow) {
        this.chunks.shift()
        this.memoryBytes -= head.length
        this.startOffset += head.length
      } else {
        this.chunks[0] = head.subarray(overflow)
        this.memoryBytes -= overflow
        this.startOffset += overflow
        break
      }
    }
  }

  readFrom(
    requestedOffset: number,
    maxBytes: number,
  ): { text: string; nextOffset: number; truncated: boolean } {
    const safeOffset = Math.max(0, Math.floor(requestedOffset))
    if (safeOffset >= this.totalBytes) {
      return { text: '', nextOffset: this.totalBytes, truncated: false }
    }

    const evicted = safeOffset < this.startOffset
    const effectiveOffset = Math.max(safeOffset, this.startOffset)
    const available = this.totalBytes - effectiveOffset
    const budget = Math.max(0, Math.min(available, maxBytes))
    const clippedByBudget = available > budget

    if (budget === 0) {
      return { text: '', nextOffset: effectiveOffset, truncated: evicted || clippedByBudget }
    }

    const combined = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks)
    if (this.chunks.length > 1) {
      this.chunks = [combined]
    }

    const relStart = effectiveOffset - this.startOffset
    let relEnd = Math.min(combined.length, relStart + budget)

    // Avoid splitting a multi-byte UTF-8 sequence at the end boundary when more data follows.
    if (clippedByBudget && relEnd > relStart) {
      let back = relEnd
      while (back > relStart && (combined[back] & 0xc0) === 0x80) {
        back--
      }
      if (back > relStart && back < relEnd) {
        relEnd = back
      }
    }

    const slice = combined.subarray(relStart, relEnd)
    return {
      text: slice.toString('utf-8'),
      nextOffset: this.startOffset + relEnd,
      truncated: evicted || clippedByBudget,
    }
  }

  toUtf8String(): string {
    if (this.chunks.length === 0) return ''
    if (this.chunks.length === 1) return this.chunks[0].toString('utf-8')
    const combined = Buffer.concat(this.chunks)
    this.chunks = [combined]
    return combined.toString('utf-8')
  }
}

interface ManagedJob {
  id: string
  activityId?: string
  sessionId?: string
  activityStore?: ActivityStore
  description: string
  shell: string
  cwd: string
  commandPreview: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  exitCode: number | null
  signal: string | null
  startedAt: number
  endedAt?: number
  promotedFromForeground: boolean
  maxInlineBytes: number
  child: ChildProcess
  stdout: StreamRingBuffer
  stderr: StreamRingBuffer
  lastReadStdoutOffset: number
  lastReadStderrOffset: number
  refId?: string
  waiters: Set<() => void>
  exitWaiters: Set<() => void>
  killRequested: boolean
}

export interface StartJobParams {
  id?: string
  activityId?: string
  sessionId?: string
  activityStore?: ActivityStore
  description: string
  shell: string
  executable: string
  args: string[]
  cwd: string
  commandPreview: string
  env: NodeJS.ProcessEnv
  maxInlineBytes: number
  maxSpillBytes: number
  windowsVerbatimArguments?: boolean
}

export interface AdoptProcessParams {
  id?: string
  activityId?: string
  sessionId?: string
  activityStore?: ActivityStore
  description: string
  shell: string
  cwd: string
  commandPreview: string
  child: ChildProcess
  stdoutChunks: Buffer[]
  stderrChunks: Buffer[]
  startedAt: number
  maxInlineBytes: number
  maxSpillBytes: number
}

export interface GetJobOutputOptions {
  stdoutOffset?: number
  stderrOffset?: number
  wait?: boolean
  waitTimeoutMs?: number
  maxBytes?: number
}

export class JobManager extends EventEmitter {
  private readonly jobs = new Map<string, ManagedJob>()
  private readonly spillStore?: SpillStore
  private readonly activityStore?: ActivityStore

  constructor(deps: { spillStore?: SpillStore; activityStore?: ActivityStore } = {}) {
    super()
    this.spillStore = deps.spillStore
    this.activityStore = deps.activityStore
  }

  private generateJobId(): string {
    return `job_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
  }

  private toSummary(job: ManagedJob): JobSummary {
    const now = job.endedAt ?? Date.now()
    return {
      id: job.id,
      ...(job.sessionId ? { sessionId: job.sessionId } : {}),
      description: job.description,
      shell: job.shell,
      cwd: job.cwd,
      commandPreview: job.commandPreview,
      status: job.status,
      exitCode: job.exitCode,
      signal: job.signal,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      durationMs: Math.max(0, now - job.startedAt),
      promotedFromForeground: job.promotedFromForeground,
      stdoutBytes: job.stdout.totalBytes,
      stderrBytes: job.stderr.totalBytes,
      refId: job.refId,
    }
  }

  startJob(params: StartJobParams): JobSummary {
    const id = params.id || this.generateJobId()
    const child = spawn(params.executable, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      windowsVerbatimArguments: params.windowsVerbatimArguments,
    })

    const memoryCap = Math.min(DEFAULT_MEMORY_CAP_BYTES, Math.max(65_536, params.maxSpillBytes))
    const job: ManagedJob = {
      id,
      activityId: params.activityId,
      sessionId: params.sessionId,
      activityStore: params.activityStore,
      description: params.description,
      shell: params.shell,
      cwd: params.cwd,
      commandPreview: params.commandPreview,
      status: 'running',
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      promotedFromForeground: false,
      maxInlineBytes: params.maxInlineBytes,
      child,
      stdout: new StreamRingBuffer(memoryCap),
      stderr: new StreamRingBuffer(memoryCap),
      lastReadStdoutOffset: 0,
      lastReadStderrOffset: 0,
      waiters: new Set(),
      exitWaiters: new Set(),
      killRequested: false,
    }

    this.registerJob(job)
    return this.toSummary(job)
  }

  /**
   * Adopts a live foreground process that exceeded its timeout, preserving all
   * previously captured stdout/stderr bytes without interrupting the child.
   */
  adoptProcess(params: AdoptProcessParams): JobSummary {
    const id = params.id || this.generateJobId()
    const memoryCap = Math.min(DEFAULT_MEMORY_CAP_BYTES, Math.max(65_536, params.maxSpillBytes))
    const stdoutBuf = new StreamRingBuffer(memoryCap)
    const stderrBuf = new StreamRingBuffer(memoryCap)

    for (const chunk of params.stdoutChunks) stdoutBuf.append(chunk)
    for (const chunk of params.stderrChunks) stderrBuf.append(chunk)

    const job: ManagedJob = {
      id,
      activityId: params.activityId,
      sessionId: params.sessionId,
      activityStore: params.activityStore,
      description: params.description,
      shell: params.shell,
      cwd: params.cwd,
      commandPreview: params.commandPreview,
      status: 'running',
      exitCode: null,
      signal: null,
      startedAt: params.startedAt,
      promotedFromForeground: true,
      maxInlineBytes: params.maxInlineBytes,
      child: params.child,
      stdout: stdoutBuf,
      stderr: stderrBuf,
      // Auto-promoted jobs already returned their initial captured bytes inline via pulse_exec.
      lastReadStdoutOffset: stdoutBuf.totalBytes,
      lastReadStderrOffset: stderrBuf.totalBytes,
      waiters: new Set(),
      exitWaiters: new Set(),
      killRequested: false,
    }

    this.registerJob(job)

    // Handle edge case where the process finished right at the promotion boundary.
    if (params.child.exitCode !== null || params.child.signalCode !== null) {
      this.finalizeJob(job, params.child.exitCode, params.child.signalCode)
    }

    return this.toSummary(job)
  }

  private registerJob(job: ManagedJob): void {
    this.jobs.set(job.id, job)
    this.pruneOldJobs()

    job.child.stdout?.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      job.stdout.append(buf)
      this.notifyWaiters(job)
    })

    job.child.stderr?.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      job.stderr.append(buf)
      this.notifyWaiters(job)
    })

    job.child.on('error', (err: Error) => {
      job.stderr.append(Buffer.from(`\n[process error] ${err.message}\n`, 'utf-8'))
      this.finalizeJob(job, -1, null)
    })

    job.child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      this.finalizeJob(job, code, signal)
    })

    this.emit('job-update', this.toSummary(job))
  }

  private finalizeJob(
    job: ManagedJob,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (job.status !== 'running') return

    job.endedAt = Date.now()
    job.exitCode = exitCode
    job.signal = signal

    if (job.killRequested) {
      job.status = 'killed'
    } else if (exitCode === 0 && signal === null) {
      job.status = 'completed'
    } else {
      job.status = 'failed'
    }

    // Spill large background job output so it can be paged via pulse_result.
    const totalBytes = job.stdout.totalBytes + job.stderr.totalBytes
    if (this.spillStore && totalBytes > job.maxInlineBytes) {
      try {
        const saved = this.spillStore.save({
          stdout: job.stdout.toUtf8String(),
          stderr: job.stderr.toUtf8String(),
          sessionId: job.sessionId,
          meta: {
            tool: 'pulse_job',
            jobId: job.id,
            description: job.description,
            shell: job.shell,
            cwd: job.cwd,
            exitCode: job.exitCode,
            signal: job.signal,
            status: job.status,
            ...(job.sessionId ? { sessionId: job.sessionId } : {}),
          },
        })
        job.refId = saved.refId
      } catch {
        // Non-fatal spill error.
      }
    }

    const summary = this.toSummary(job)

    const targetActivityStore = job.activityStore ?? this.activityStore
    if (targetActivityStore && job.activityId) {
      const previewSource = job.stdout.toUtf8String() || job.stderr.toUtf8String()
      targetActivityStore.update(job.activityId, {
        status: job.status,
        exitCode: job.exitCode,
        endedAt: job.endedAt,
        durationMs: summary.durationMs,
        refId: job.refId,
        outputPreview: previewSource.slice(0, 1024),
        effectState: job.status === 'completed' ? 'applied' : 'unknown',
      })
    }

    this.notifyWaiters(job)
    this.notifyExitWaiters(job)
    this.emit('job-update', summary)
  }

  private notifyWaiters(job: ManagedJob): void {
    if (job.waiters.size === 0) return
    const pending = [...job.waiters]
    job.waiters.clear()
    for (const wake of pending) {
      wake()
    }
  }

  private notifyExitWaiters(job: ManagedJob): void {
    if (job.exitWaiters.size === 0) return
    const pending = [...job.exitWaiters]
    job.exitWaiters.clear()
    for (const wake of pending) {
      wake()
    }
  }

  private pruneOldJobs(): void {
    if (this.jobs.size <= MAX_RETAINED_JOBS) return
    const finished = [...this.jobs.values()]
      .filter((j) => j.status !== 'running')
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))

    while (this.jobs.size > MAX_RETAINED_JOBS && finished.length > 0) {
      const oldest = finished.shift()
      if (oldest) this.jobs.delete(oldest.id)
    }
  }

  listJobs(sessionId?: string): JobSummary[] {
    const filterSession =
      typeof sessionId === 'string' && sessionId.trim().length > 0 && sessionId.trim().toLowerCase() !== 'all'
        ? sessionId.trim()
        : undefined
    const jobs = [...this.jobs.values()].filter((j) =>
      filterSession ? j.sessionId === filterSession : true,
    )
    return jobs
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((j) => this.toSummary(j))
  }

  getJob(id: string): JobSummary | undefined {
    const job = this.jobs.get(id)
    return job ? this.toSummary(job) : undefined
  }

  hasRunningJobs(): boolean {
    for (const job of this.jobs.values()) {
      if (job.status === 'running') return true
    }
    return false
  }

  async getOutput(
    jobId: string,
    opts: GetJobOutputOptions = {},
  ): Promise<JobOutputResponse> {
    const job = this.jobs.get(jobId)
    if (!job) {
      throw new Error(`Background job "${jobId}" was not found.`)
    }

    // When wait=true and the caller omitted explicit offsets, resume from the job's last read
    // cursor so repeated pulse_job({ action: "output", wait: true }) calls block until new
    // output arrives or the job exits instead of re-emitting offset 0.
    const autoCursor =
      Boolean(opts.wait) && opts.stdoutOffset === undefined && opts.stderrOffset === undefined
    const stdoutOffset = Math.max(
      0,
      Math.floor(opts.stdoutOffset ?? (autoCursor ? job.lastReadStdoutOffset : 0)),
    )
    const stderrOffset = Math.max(
      0,
      Math.floor(opts.stderrOffset ?? (autoCursor ? job.lastReadStderrOffset : 0)),
    )
    const defaultCap = Math.max(512, Math.min(7_800, job.maxInlineBytes || 7_800))
    const maxBytes = Math.max(512, Math.min(262_144, Math.floor(opts.maxBytes ?? defaultCap)))

    const hasUnread = () =>
      job.stdout.totalBytes > stdoutOffset || job.stderr.totalBytes > stderrOffset

    let timedOut = false
    if (opts.wait && job.status === 'running' && !hasUnread()) {
      const waitMs = Math.max(100, Math.min(60_000, Math.floor(opts.waitTimeoutMs ?? 15_000)))
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer)
          job.waiters.delete(wake)
          resolve()
        }
        const timer = setTimeout(() => {
          timedOut = true
          wake()
        }, waitMs)
        timer.unref()
        job.waiters.add(wake)
      })
    }

    // Coalesce trailing close events when a child finishes right after emitting its final chunk,
    // avoiding an extra empty poll just to observe status !== 'running' and eof=true.
    if (opts.wait && !timedOut && job.status === 'running') {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          job.exitWaiters.delete(done)
          resolve()
        }
        const timer = setTimeout(done, 200)
        timer.unref()
        job.exitWaiters.add(done)
      })
    }

    const unreadStdout = Math.max(0, job.stdout.totalBytes - stdoutOffset)
    const unreadStderr = Math.max(0, job.stderr.totalBytes - stderrOffset)
    let stdoutBudget = maxBytes
    let stderrBudget = maxBytes

    if (unreadStdout + unreadStderr > maxBytes) {
      if (unreadStderr === 0) {
        stdoutBudget = maxBytes
        stderrBudget = 0
      } else if (unreadStdout === 0) {
        stdoutBudget = 0
        stderrBudget = maxBytes
      } else {
        stderrBudget = Math.min(unreadStderr, Math.floor(maxBytes * 0.35))
        stdoutBudget = maxBytes - stderrBudget
      }
    }

    const outSlice = job.stdout.readFrom(stdoutOffset, stdoutBudget)
    const errSlice = job.stderr.readFrom(stderrOffset, stderrBudget)
    job.lastReadStdoutOffset = Math.max(job.lastReadStdoutOffset, outSlice.nextOffset)
    job.lastReadStderrOffset = Math.max(job.lastReadStderrOffset, errSlice.nextOffset)
    const eof =
      job.status !== 'running' &&
      outSlice.nextOffset >= job.stdout.totalBytes &&
      errSlice.nextOffset >= job.stderr.totalBytes

    return {
      job: this.toSummary(job),
      stdout: outSlice.text,
      stderr: errSlice.text,
      nextStdoutOffset: outSlice.nextOffset,
      nextStderrOffset: errSlice.nextOffset,
      eof,
      truncated: outSlice.truncated || errSlice.truncated,
    }
  }

  sendInput(jobId: string, data: string): { ok: boolean; job: JobSummary } {
    const job = this.jobs.get(jobId)
    if (!job) {
      throw new Error(`Background job "${jobId}" was not found.`)
    }
    if (job.status !== 'running') {
      throw new Error(`Cannot send input to job "${jobId}" because it is already ${job.status}.`)
    }
    if (!job.child.stdin || job.child.stdin.destroyed || !job.child.stdin.writable) {
      throw new Error(`Standard input for job "${jobId}" is closed.`)
    }

    job.child.stdin.write(data, 'utf-8')
    return { ok: true, job: this.toSummary(job) }
  }

  async killJob(jobId: string): Promise<JobSummary> {
    const job = this.jobs.get(jobId)
    if (!job) {
      throw new Error(`Background job "${jobId}" was not found.`)
    }

    if (job.status === 'running') {
      job.killRequested = true
      await killProcessTree(job.child.pid, job.child)
      // Ensure finalization even if the close event is delayed.
      if (job.status === 'running') {
        this.finalizeJob(job, job.child.exitCode, job.child.signalCode ?? 'SIGTERM')
      }
    }

    return this.toSummary(job)
  }

  async disposeAll(): Promise<void> {
    const running = [...this.jobs.values()].filter((j) => j.status === 'running')
    await Promise.allSettled(running.map((j) => this.killJob(j.id)))
  }
}
