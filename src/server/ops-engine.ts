import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { checkCredentialFence } from '../shared/guards.ts'
import { normalizeWorkdir, normalizeWorkerPath } from '../shared/paths.ts'
import type {
  FailureInfo,
  MutateBatchResultItem,
  MutateOutcome,
  MutateRequest,
  ReadDocOutcome,
  ReadDocRequest,
  ReadFileItemResult,
  ReadFilesOutcome,
  ReadFilesRequest,
  SavingsCategory,
  SearchEntry,
  SearchOutcome,
  SearchRequest,
} from '../shared/types.ts'
import type { ActivityStore } from './activity-store.ts'
import type { ConfigStore } from './config.ts'
import { runGitDiff, runGitStatus } from './git-ops.ts'
import { truncateMiddle, waterFill } from './output-compactor.ts'
import {
  extractDeliveredLineIntervals,
  normalizeDedupPath,
  type ReadDedupStore,
} from './read-dedup.ts'
import type { RustWorker } from './rust-worker.ts'
import type { SessionManager } from './session-manager.ts'
import type { SpillStore } from './spill-store.ts'
import {
  estimateTokensFromBytes,
  type TelemetryCategoryDelta,
  type TelemetryStore,
} from './telemetry-store.ts'

export interface OpsEngineDeps {
  rustWorker: RustWorker
  configStore: ConfigStore
  spillStore: SpillStore
  sessionManager?: SessionManager
  readDedupStore?: ReadDedupStore
  telemetryStore?: TelemetryStore
  activityStore?: ActivityStore
  getWorkspaceRoots: (sessionId?: string) => Promise<string[]>
}

const WORKSPACE_UNRESOLVED_FAILURE: FailureInfo = {
  code: 'WORKSPACE_ROOT_UNRESOLVED',
  message:
    'No authorized workspace root could be resolved for this session; refusing to operate without a workspace boundary.',
  effectState: 'none',
  retry: 'after-input-change',
  nextAction:
    'Open a workspace folder in Antigravity, set ANTIGRAVITY_WORKSPACE_DIR, or pass workspace roots via MCP roots/list.',
}

interface WorkerReadFilesResult {
  items: Array<{
    path: string
    exists: boolean
    isDir?: boolean
    bytes: number
    lineCount: number | null
    revision: string
    mtimeMs?: number
    view: string
    symbol?: string
    fullFileBytes?: number
    offset: number
    returnedLines: number
    nextOffset: number | null
    eof: boolean
    escaped?: boolean
    content: string
    error?: FailureInfo
  }>
  rawBytes?: number
}

interface WorkerGlobResult {
  root: string
  totalMatched: number
  filesScanned: number
  scanComplete: boolean
  truncated: boolean
  nextOffset: number | null
  entries: Array<{
    path: string
    kind: string
    bytes: number
    modifiedMs: number
  }>
}

interface WorkerGrepResult {
  root: string
  outputMode: string
  totalMatched: number
  totalFilesMatched: number
  filesScanned: number
  definitionMatches?: number
  impliedReferences?: number
  scanComplete: boolean
  truncated: boolean
  nextOffset: number | null
  rawBytes?: number
  entries: SearchEntry[]
}

interface WorkerDiffResult {
  path: string
  beforeRevision: string
  afterRevision: string
  addedLines: number
  removedLines: number
  diff: string
}

interface WorkerWriteEditResult {
  path: string
  dryRun: boolean
  beforeRevision: string
  afterRevision: string
  addedLines: number
  removedLines: number
  diff: string
}

interface WorkerReplaceResult {
  root: string
  dryRun: boolean
  filesChanged: number
  totalReplacements: number
  changedPaths?: string[]
  skippedFiles?: string[]
  diff: string
}

interface WorkerBatchResult {
  dryRun: boolean
  batchResults: Array<{
    op: string
    path: string
    to?: string
    status: string
    error?: string
  }>
}

interface WorkerReadDocResult {
  path: string
  format: string
  bytes: number
  columns?: string[]
  totalUnits: number
  offset: number
  returnedUnits: number
  nextOffset: number | null
  complete: boolean
  content: string
}

function generateOpId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
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

function computeSharedBaseDir(filePaths: string[]): string | undefined {
  if (filePaths.length < 2) return undefined
  const dirs = filePaths
    .filter((p) => typeof p === 'string' && p.trim().length > 0)
    .map((p) => path.dirname(p).replace(/\\/g, '/').replace(/\/+$/, ''))
  if (dirs.length < 2) return undefined

  const splitDirs = dirs.map((d) => d.split('/').filter((seg) => seg.length > 0))
  const first = splitDirs[0]
  if (!first || first.length === 0) return undefined

  const isWin = process.platform === 'win32'
  let commonLen = first.length
  for (let i = 1; i < splitDirs.length; i++) {
    const segs = splitDirs[i]
    commonLen = Math.min(commonLen, segs.length)
    for (let j = 0; j < commonLen; j++) {
      const a = isWin ? first[j].toLowerCase() : first[j]
      const b = isWin ? segs[j].toLowerCase() : segs[j]
      if (a !== b) {
        commonLen = j
        break
      }
    }
    if (commonLen === 0) return undefined
  }

  // Avoid emitting a bare Windows drive letter like `C:` as baseDir.
  if (isWin && commonLen === 1 && /^[a-zA-Z]:$/.test(first[0])) {
    return undefined
  }

  const leadingSlash = dirs[0].startsWith('/') ? '/' : ''
  const joined = `${leadingSlash}${first.slice(0, commonLen).join('/')}`
  return joined.length > 0 ? joined : undefined
}

function formatReadItemsForSpill(items: ReadFileItemResult[]): string {
  return items
    .map((item) => {
      const header = `=== ${item.path} [rev=${item.revision || 'none'} offset=${item.offset} lines=${item.returnedLines} eof=${item.eof}] ===`
      if (item.error) {
        return `${header}\n[ERROR ${item.error.code}] ${item.error.message}`
      }
      return `${header}\n${item.content}`
    })
    .join('\n\n')
}

function formatSearchEntriesText(action: 'glob' | 'grep', entries: SearchEntry[]): string {
  if (action === 'glob') {
    return entries
      .map((e) => {
        const sizePart = typeof e.bytes === 'number' ? ` (${e.bytes} B)` : ''
        return `${e.kind === 'directory' ? '[dir] ' : ''}${e.path}${sizePart}`
      })
      .join('\n')
  }

  return entries
    .map((e) => {
      if (typeof e.count === 'number') {
        return `${e.path}: ${e.count}`
      }
      if (typeof e.line === 'number') {
        const decl = e.declKind ? `[${e.declKind}] ` : ''
        const lines: string[] = []
        if (e.before && e.before.length > 0) {
          for (const b of e.before) lines.push(`  - ${b}`)
        }
        lines.push(`${decl}${e.path}:${e.line}|${e.text ?? ''}`)
        if (e.after && e.after.length > 0) {
          for (const a of e.after) lines.push(`  + ${a}`)
        }
        return lines.join('\n')
      }
      return e.path
    })
    .join('\n')
}

function normalizeReadView(raw: string): ReadFileItemResult['view'] {
  if (raw === 'hex' || raw === 'stat' || raw === 'outline' || raw === 'symbol') return raw
  return 'text'
}

function normalizeDocFormat(raw: string): ReadDocOutcome['format'] {
  if (raw === 'docx' || raw === 'pdf') return raw
  return 'table'
}

function docUnitNameForFormat(format: ReadDocOutcome['format']): ReadDocOutcome['unitName'] {
  if (format === 'docx') return 'paragraphs'
  if (format === 'pdf') return 'pages'
  return 'rows'
}

interface ResolvedSessionStores {
  sessionId?: string
  readDedupStore?: ReadDedupStore
  telemetryStore?: TelemetryStore
  activityStore?: ActivityStore
}

export class OpsEngine {
  private readonly rustWorker: RustWorker
  private readonly configStore: ConfigStore
  private readonly spillStore: SpillStore
  private readonly sessionManager?: SessionManager
  private readonly fallbackReadDedupStore?: ReadDedupStore
  private readonly fallbackTelemetryStore?: TelemetryStore
  private readonly fallbackActivityStore?: ActivityStore
  private readonly getWorkspaceRoots: (sessionId?: string) => Promise<string[]>
  private readonly creditedBaselinesByTelemetry = new WeakMap<TelemetryStore, Set<string>>()
  private readonly fallbackCreditedBaselines = new Set<string>()

  constructor(deps: OpsEngineDeps) {
    this.rustWorker = deps.rustWorker
    this.configStore = deps.configStore
    this.spillStore = deps.spillStore
    this.sessionManager = deps.sessionManager
    this.fallbackReadDedupStore = deps.readDedupStore
    this.fallbackTelemetryStore = deps.telemetryStore
    this.fallbackActivityStore = deps.activityStore
    this.getWorkspaceRoots = deps.getWorkspaceRoots
  }

  private resolveStores(sessionId?: string, workspaceRoot?: string): ResolvedSessionStores {
    if (this.sessionManager) {
      const ctx = this.sessionManager.getSession(sessionId, workspaceRoot)
      return {
        sessionId: ctx.sessionId,
        readDedupStore: ctx.readDedupStore,
        telemetryStore: ctx.telemetryStore,
        activityStore: ctx.activityStore,
      }
    }
    return {
      sessionId,
      readDedupStore: this.fallbackReadDedupStore,
      telemetryStore: this.fallbackTelemetryStore,
      activityStore: this.fallbackActivityStore,
    }
  }

  private getCreditedBaselineSet(stores: ResolvedSessionStores): Set<string> {
    if (!stores.telemetryStore) {
      return this.fallbackCreditedBaselines
    }
    let set = this.creditedBaselinesByTelemetry.get(stores.telemetryStore)
    if (!set) {
      set = new Set<string>()
      this.creditedBaselinesByTelemetry.set(stores.telemetryStore, set)
    } else if (stores.telemetryStore.getSummary().totalCalls === 0) {
      // Telemetry was reset; clear baseline tracking so subsequent reads credit accurately.
      set.clear()
    }
    return set
  }

  private claimFullFileBaseline(stores: ResolvedSessionStores, item: ReadFileItemResult): boolean {
    if (!item.revision || item.revision.trim().length === 0) {
      return true
    }
    const set = this.getCreditedBaselineSet(stores)
    const key = `${normalizeDedupPath(item.path)}|${item.revision}`
    if (set.has(key)) {
      return false
    }
    set.add(key)
    return true
  }

  async readFiles(
    req: ReadFilesRequest,
    source: 'agent' | 'user' = 'agent',
    sessionId?: string,
  ): Promise<ReadFilesOutcome> {
    const id = generateOpId('read')
    const startedAt = Date.now()
    const config = this.configStore.get()
    const roots = await this.getWorkspaceRoots(sessionId)
    const primaryRoot = roots[0] || ''
    const stores = this.resolveStores(sessionId, primaryRoot)

    const reject = (failure: FailureInfo): ReadFilesOutcome => {
      const durationMs = Math.max(0, Date.now() - startedAt)
      stores.activityStore?.record({
        id,
        kind: 'read',
        source,
        description: 'Read workspace files',
        commandPreview: 'pulse_read_files (rejected)',
        shell: 'rust-worker',
        cwd: primaryRoot,
        status: 'rejected',
        exitCode: null,
        effectState: failure.effectState,
        errorCode: failure.code,
        durationMs,
        startedAt,
        endedAt: Date.now(),
        outputPreview: failure.message,
        sessionId: stores.sessionId,
        anomaly: true,
        acknowledged: false,
      })
      return {
        status: 'rejected',
        items: [],
        durationMs,
        rawBytes: 0,
        deliveredBytes: 0,
        savedBytes: 0,
        dedupHits: 0,
        failure,
      }
    }

    if (roots.length === 0) {
      return reject(WORKSPACE_UNRESOLVED_FAILURE)
    }

    if (!Array.isArray(req.files) || req.files.length === 0) {
      return reject({
        code: 'INVALID_ARGUMENT',
        message: 'Parameter "files" must be a non-empty array of 1 to 32 file range objects.',
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: 'Provide at least one { path, offset?, limit?, view?, symbol? } entry in "files".',
      })
    }

    if (req.files.length > 32) {
      return reject({
        code: 'INVALID_ARGUMENT',
        message: `Batch size ${req.files.length} exceeds the maximum of 32 files per call.`,
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: 'Split the batch into chunks of at most 32 file ranges.',
      })
    }

    const normalizedFiles: Array<{
      path: string
      offset?: number
      limit?: number
      view?: ReadFilesRequest['files'][number]['view']
      symbol?: string
    }> = []
    for (let i = 0; i < req.files.length; i++) {
      const spec = req.files[i]
      if (!spec || typeof spec.path !== 'string' || spec.path.trim().length === 0) {
        return reject({
          code: 'INVALID_ARGUMENT',
          message: `files[${i}].path must be a non-empty string.`,
          effectState: 'none',
          retry: 'after-input-change',
          nextAction: 'Provide a valid workspace file path for every entry in "files".',
        })
      }
      const normRes = normalizeWorkerPath(spec.path, primaryRoot)
      if (!normRes.ok) {
        return reject(normRes.failure)
      }
      normalizedFiles.push({
        path: normRes.path,
        ...(spec.offset !== undefined ? { offset: spec.offset } : {}),
        ...(spec.limit !== undefined ? { limit: spec.limit } : {}),
        ...(spec.view !== undefined ? { view: spec.view } : {}),
        ...(typeof spec.symbol === 'string' && spec.symbol.trim().length > 0
          ? { symbol: spec.symbol.trim() }
          : {}),
      })
    }

    const filePreview =
      req.files.length === 1
        ? req.files[0].path
        : `${req.files.length} files (${req.files[0].path}, ...)`
    const hasSymbol = req.files.some((f) => typeof f.symbol === 'string' && f.symbol.trim().length > 0)
    const hasOutline = req.files.some((f) => f.view === 'outline')
    const description = req.statOnly
      ? `Stat ${filePreview}`
      : hasSymbol
        ? `Read symbol ${filePreview}`
        : hasOutline
          ? `Outline ${filePreview}`
          : `Read ${filePreview}`

    const workerRes = await this.rustWorker.invoke<WorkerReadFilesResult>(
      'read_files',
      {
        files: normalizedFiles,
        statOnly: Boolean(req.statOnly),
      },
      {
        roots,
        credentialFence: config.enableCredentialFence,
        maxInlineBytes: config.maxInlineBytes,
      },
    )

    const durationMs = Math.max(0, Date.now() - startedAt)

    if (!workerRes.ok) {
      stores.activityStore?.record({
        id,
        kind: 'read',
        source,
        description,
        commandPreview: `pulse_read_files ${filePreview}`,
        shell: 'rust-worker',
        cwd: primaryRoot,
        status: 'failed',
        exitCode: null,
        effectState: workerRes.failure.effectState,
        errorCode: workerRes.failure.code,
        durationMs,
        startedAt,
        endedAt: Date.now(),
        outputPreview: workerRes.failure.message,
        sessionId: stores.sessionId,
        anomaly: true,
        acknowledged: false,
      })
      return {
        status: 'failed',
        items: [],
        durationMs,
        rawBytes: 0,
        deliveredBytes: 0,
        savedBytes: 0,
        dedupHits: 0,
        failure: workerRes.failure,
      }
    }

    const rawItems = Array.isArray(workerRes.result?.items) ? workerRes.result.items : []
    const items: ReadFileItemResult[] = []
    let dedupHits = 0
    let dedupSavedBytes = 0
    let outlineCount = 0
    let outlineSavedBytes = 0
    let symbolCount = 0
    let symbolSavedBytes = 0

    for (let i = 0; i < rawItems.length; i++) {
      const raw = rawItems[i]
      const spec = req.files[i]
      const view = normalizeReadView(raw.view)
      const symbolName =
        typeof raw.symbol === 'string' && raw.symbol.trim().length > 0
          ? raw.symbol.trim()
          : view === 'symbol' && typeof spec?.symbol === 'string' && spec.symbol.trim().length > 0
            ? spec.symbol.trim()
            : undefined
      const fullFileBytes =
        typeof raw.fullFileBytes === 'number' && Number.isFinite(raw.fullFileBytes)
          ? Math.max(0, Math.round(raw.fullFileBytes))
          : undefined

      const item: ReadFileItemResult = {
        path: raw.path,
        exists: Boolean(raw.exists),
        isDir: raw.isDir,
        bytes: typeof raw.bytes === 'number' ? raw.bytes : 0,
        lineCount: typeof raw.lineCount === 'number' ? raw.lineCount : null,
        revision: typeof raw.revision === 'string' ? raw.revision : '',
        mtimeMs: typeof raw.mtimeMs === 'number' ? raw.mtimeMs : undefined,
        view,
        ...(symbolName ? { symbol: symbolName } : {}),
        ...(fullFileBytes !== undefined ? { fullFileBytes } : {}),
        offset: typeof raw.offset === 'number' ? raw.offset : (spec?.offset ?? 1),
        returnedLines: typeof raw.returnedLines === 'number' ? raw.returnedLines : 0,
        nextOffset: typeof raw.nextOffset === 'number' ? raw.nextOffset : null,
        eof: Boolean(raw.eof),
        escaped: raw.escaped,
        content: typeof raw.content === 'string' ? raw.content : '',
        error: raw.error,
      }

      const preDedupContentBytes = Buffer.byteLength(item.content, 'utf-8')

      // Record exact verified outline/symbol structural compression savings against fullFileBytes,
      // crediting each (path, revision) full-file baseline at most once per session.
      if (!req.statOnly && !item.error && fullFileBytes !== undefined && fullFileBytes > 0) {
        const creditBaseline = this.claimFullFileBaseline(stores, item)
        if (item.view === 'outline') {
          outlineCount++
          if (creditBaseline) {
            outlineSavedBytes += Math.max(0, fullFileBytes - preDedupContentBytes)
          }
        } else if (item.view === 'symbol') {
          symbolCount++
          if (creditBaseline) {
            symbolSavedBytes += Math.max(0, fullFileBytes - preDedupContentBytes)
          }
        }
      }

      const itemLimitKey =
        spec?.limit ?? (item.view === 'hex' ? 64 : item.view === 'symbol' ? 250 : 200)
      if (!req.statOnly && stores.readDedupStore) {
        const dedup = stores.readDedupStore.check(item, Boolean(req.force), itemLimitKey)
        if (dedup.deduplicated) {
          dedupHits++
          dedupSavedBytes += dedup.savedBytes
          item.deduplicated = true
          item.content = dedup.notice
        }
      }

      items.push(item)
    }

    const baseDir = computeSharedBaseDir(items.map((it) => it.path))

    const preSpillDeliveredBytes = items.reduce(
      (acc, it) => acc + Buffer.byteLength(it.content, 'utf-8'),
      0,
    )
    let refId: string | undefined
    let spillPath: string | undefined
    let spillSavedBytes = 0
    const truncatedIndices = new Set<number>()

    if (preSpillDeliveredBytes > config.maxInlineBytes) {
      const fullDump = formatReadItemsForSpill(items)
      try {
        const saved = this.spillStore.save({
          stdout: fullDump,
          stderr: '',
          sessionId: stores.sessionId,
          meta: {
            tool: 'pulse_read_files',
            description,
            fileCount: items.length,
            baseDir,
            ...(stores.sessionId ? { sessionId: stores.sessionId } : {}),
          },
        })
        refId = saved.refId
        spillPath = saved.spillPath
      } catch {
        // Non-fatal spill error; still enforce inline byte ceiling below.
      }

      const truncFooter = '\n...[truncated inline; page full output via pulse_result]'
      const truncFooterBytes = Buffer.byteLength(truncFooter, 'utf-8')
      let fixedBytes = 0
      const activeIndices: number[] = []
      const activeLengths: number[] = []

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const len = Buffer.byteLength(item.content, 'utf-8')
        if (item.deduplicated || item.error || item.content.length === 0) {
          fixedBytes += len
        } else {
          activeIndices.push(i)
          activeLengths.push(len)
        }
      }

      const availableBudget = Math.max(activeIndices.length * 128, config.maxInlineBytes - fixedBytes)

      // Prefer keeping complete files intact in request order when batching multiple files
      // (reserving a preview floor for trailing files) so we don't chop the middle out of
      // every file in a 2-4 file batch; fall back to water-fill for the remaining items.
      const PREVIEW_FLOOR_BYTES = 320
      const allocations = new Array<number>(activeIndices.length).fill(0)
      const overflowPositions: number[] = []
      let remainingBudget = availableBudget

      if (activeIndices.length > 1) {
        for (let k = 0; k < activeIndices.length; k++) {
          const len = activeLengths[k]
          const remainingAfter = activeIndices.length - 1 - k
          const reserveForRest = remainingAfter * PREVIEW_FLOOR_BYTES
          if (len <= remainingBudget - reserveForRest) {
            allocations[k] = len
            remainingBudget -= len
          } else {
            overflowPositions.push(k)
          }
        }
      } else {
        for (let k = 0; k < activeIndices.length; k++) {
          overflowPositions.push(k)
        }
      }

      if (overflowPositions.length > 0) {
        const overflowLengths = overflowPositions.map((pos) => activeLengths[pos])
        const overflowAllocs = waterFill(
          overflowLengths,
          Math.max(overflowPositions.length * 128, remainingBudget),
        )
        for (let j = 0; j < overflowPositions.length; j++) {
          allocations[overflowPositions[j]] = overflowAllocs[j] ?? 128
        }
      }

      for (let k = 0; k < activeIndices.length; k++) {
        const idx = activeIndices[k]
        const item = items[idx]
        const targetBytes = Math.max(128, allocations[k] ?? 128)
        if (Buffer.byteLength(item.content, 'utf-8') <= targetBytes) {
          continue
        }
        const bodyBudget = Math.max(64, targetBytes - truncFooterBytes)
        const clipped = truncateMiddle(item.content, bodyBudget)
        if (clipped.truncated) {
          truncatedIndices.add(idx)
          item.content = `${clipped.text}${truncFooter}`
        }
      }

      const postSpillDeliveredBytes = items.reduce(
        (acc, it) => acc + Buffer.byteLength(it.content, 'utf-8'),
        0,
      )
      spillSavedBytes = Math.max(0, preSpillDeliveredBytes - postSpillDeliveredBytes)
    }

    // Record fully delivered items normally, and for middle-truncated text items record ONLY
    // the exact delivered head/tail line intervals so omitted lines are never marked as seen.
    if (!req.statOnly && stores.readDedupStore) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.deduplicated) continue
        if (truncatedIndices.has(i)) {
          if (item.view === 'text' && item.revision && !item.error) {
            const deliveredIntervals = extractDeliveredLineIntervals(item.content)
            if (deliveredIntervals.length > 0) {
              stores.readDedupStore.recordLineRanges(item.path, item.revision, deliveredIntervals)
            }
          }
          continue
        }
        const spec = req.files[i]
        const limitKey =
          spec?.limit ?? (item.view === 'hex' ? 64 : item.view === 'symbol' ? 250 : 200)
        stores.readDedupStore.record(item, limitKey)
      }
    }

    const deliveredBytes = items.reduce(
      (acc, it) => acc + Buffer.byteLength(it.content, 'utf-8'),
      0,
    )
    const roundTripsSaved = items.length > 1 ? items.length - 1 : 0
    // Count only verified savings: shared [Base:] prefix elision, outline/symbol structural savings,
    // session read-dedup, and spillover trimming. Keep strict invariant totalSavedBytes === sum(byCategory).
    const baseDirSavedBytes =
      baseDir && items.length > 1
        ? (items.length - 1) * (Buffer.byteLength(baseDir, 'utf-8') + 1)
        : 0
    const savedBytes =
      dedupSavedBytes + outlineSavedBytes + symbolSavedBytes + spillSavedBytes + baseDirSavedBytes
    const rawBytes = deliveredBytes + savedBytes

    const errorItems = items.filter((it) => Boolean(it.error))
    let status: ReadFilesOutcome['status'] = 'completed'
    let failure: FailureInfo | undefined
    if (items.length > 0 && errorItems.length === items.length) {
      status = 'failed'
      failure = errorItems[0].error
    } else if (errorItems.length > 0) {
      status = 'partial'
    }

    const categories: Partial<Record<SavingsCategory, TelemetryCategoryDelta>> = {}
    if (dedupHits > 0) {
      categories['read-dedup'] = { calls: dedupHits, savedBytes: dedupSavedBytes }
    }
    if (outlineCount > 0) {
      categories['outline-read'] = { calls: outlineCount, savedBytes: outlineSavedBytes }
    }
    if (symbolCount > 0) {
      categories['symbol-read'] = { calls: symbolCount, savedBytes: symbolSavedBytes }
    }
    if (roundTripsSaved > 0) {
      categories['batch-read'] = { calls: 1, savedBytes: baseDirSavedBytes, roundTripsSaved }
    }
    if (spillSavedBytes > 0) {
      categories.spillover = { calls: 1, savedBytes: spillSavedBytes }
    }

    stores.telemetryStore?.record({
      rawBytes,
      deliveredBytes,
      savedBytes,
      durationMs,
      roundTripsSaved,
      dedupHits,
      categories: Object.keys(categories).length > 0 ? categories : undefined,
    })

    const previewParts: string[] = []
    previewParts.push(`${items.length} file(s)`)
    if (outlineCount > 0) previewParts.push(`${outlineCount} outline`)
    if (symbolCount > 0) previewParts.push(`${symbolCount} symbol`)
    if (dedupHits > 0) previewParts.push(`${dedupHits} dedup hit(s)`)
    if (savedBytes > 0) previewParts.push(`saved ${savedBytes} B`)
    if (errorItems.length > 0) previewParts.push(`${errorItems.length} error(s)`)

    stores.activityStore?.record({
      id,
      kind: 'read',
      source,
      description,
      commandPreview: `pulse_read_files ${filePreview}`,
      shell: 'rust-worker',
      cwd: baseDir || primaryRoot,
      status,
      exitCode: status === 'failed' ? 1 : 0,
      effectState: status === 'failed' ? (failure?.effectState ?? 'none') : 'none',
      errorCode: failure?.code,
      durationMs,
      startedAt,
      endedAt: Date.now(),
      refId,
      outputPreview: previewParts.join(' · '),
      savedBytes: savedBytes > 0 ? savedBytes : undefined,
      estimatedTokensSaved: savedBytes > 0 ? estimateTokensFromBytes(savedBytes) : undefined,
      roundTripsSaved: roundTripsSaved > 0 ? roundTripsSaved : undefined,
      sessionId: stores.sessionId,
      anomaly: status === 'failed',
      acknowledged: status !== 'failed',
    })

    return {
      status,
      baseDir,
      items,
      durationMs,
      rawBytes,
      deliveredBytes,
      savedBytes,
      dedupHits,
      refId,
      spillPath,
      failure,
    }
  }

  async search(
    req: SearchRequest,
    source: 'agent' | 'user' = 'agent',
    sessionId?: string,
  ): Promise<SearchOutcome> {
    const id = generateOpId('search')
    const startedAt = Date.now()
    const config = this.configStore.get()
    const roots = await this.getWorkspaceRoots(sessionId)
    const primaryRoot = roots[0] || ''
    const stores = this.resolveStores(sessionId, primaryRoot)
    const action = req.action

    const normalizedAction: SearchOutcome['action'] =
      action === 'glob' ||
      action === 'fuzzy' ||
      action === 'grep' ||
      action === 'git_status' ||
      action === 'git_diff'
        ? action
        : 'grep'

    const reject = (failure: FailureInfo): SearchOutcome => {
      const durationMs = Math.max(0, Date.now() - startedAt)
      stores.activityStore?.record({
        id,
        kind: 'search',
        source,
        description: `Search (${String(action || 'unknown')})`,
        commandPreview: `pulse_search ${String(action || '')}`,
        shell: action === 'git_status' || action === 'git_diff' ? 'git' : 'rust-worker',
        cwd: req.path || primaryRoot,
        status: 'rejected',
        exitCode: null,
        effectState: failure.effectState,
        errorCode: failure.code,
        durationMs,
        startedAt,
        endedAt: Date.now(),
        outputPreview: failure.message,
        sessionId: stores.sessionId,
        anomaly: true,
        acknowledged: false,
      })
      return {
        status: 'rejected',
        action: normalizedAction,
        outputMode: req.outputMode,
        root: req.path || primaryRoot,
        totalMatched: 0,
        totalFilesMatched: 0,
        filesScanned: 0,
        scanComplete: false,
        truncated: false,
        nextOffset: null,
        durationMs,
        rawBytes: 0,
        deliveredBytes: 0,
        savedBytes: 0,
        failure,
      }
    }

    if (roots.length === 0) {
      return reject(WORKSPACE_UNRESOLVED_FAILURE)
    }

    if (
      action !== 'glob' &&
      action !== 'fuzzy' &&
      action !== 'grep' &&
      action !== 'git_status' &&
      action !== 'git_diff'
    ) {
      return reject({
        code: 'INVALID_ARGUMENT',
        message: `Invalid search action "${String(action)}". Must be one of: glob, fuzzy, grep, git_status, git_diff.`,
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: 'Set action to "glob", "fuzzy", "grep", "git_status", or "git_diff".',
      })
    }

    if (action === 'git_status' || action === 'git_diff') {
      const targetRes = normalizeWorkdir(req.path, roots)
      if (!targetRes.ok) {
        return reject(targetRes.failure)
      }
      const targetPath = targetRes.path
      if (config.enableCredentialFence) {
        const fence = checkCredentialFence(targetPath)
        if (fence.blocked && fence.failure) {
          return reject(fence.failure)
        }
      }

      const description =
        action === 'git_status'
          ? `Git status${req.path ? ` (${req.path})` : ''}`
          : `Git diff${req.staged ? ' --staged' : ''}${req.baseRef ? ` ${req.baseRef}` : ''}${req.path ? ` (${req.path})` : ''}`

      const gitRes =
        action === 'git_status'
          ? await runGitStatus(targetPath, {
              glob: req.glob,
              includeLockfiles: req.includeLockfiles,
              maxInlineBytes: config.maxInlineBytes,
              credentialFence: config.enableCredentialFence,
              spillStore: this.spillStore,
              sessionId: stores.sessionId,
            })
          : await runGitDiff(targetPath, {
              glob: req.glob,
              staged: req.staged,
              baseRef: req.baseRef,
              includeLockfiles: req.includeLockfiles,
              maxHunkLines: req.maxHunkLines,
              maxInlineBytes: config.maxInlineBytes,
              credentialFence: config.enableCredentialFence,
              spillStore: this.spillStore,
              sessionId: stores.sessionId,
            })

      const durationMs = Math.max(0, Date.now() - startedAt)

      if (!gitRes.ok) {
        stores.activityStore?.record({
          id,
          kind: 'search',
          source,
          description,
          commandPreview: `pulse_search ${action}${req.path ? ` ${req.path}` : ''}`,
          shell: 'git',
          cwd: targetPath,
          status: 'failed',
          exitCode: 1,
          effectState: gitRes.failure.effectState,
          errorCode: gitRes.failure.code,
          durationMs,
          startedAt,
          endedAt: Date.now(),
          outputPreview: gitRes.failure.message,
          sessionId: stores.sessionId,
          anomaly: true,
          acknowledged: false,
        })
        return {
          status: 'failed',
          action,
          root: targetPath,
          totalMatched: 0,
          totalFilesMatched: 0,
          filesScanned: 0,
          scanComplete: false,
          truncated: false,
          nextOffset: null,
          durationMs,
          rawBytes: 0,
          deliveredBytes: 0,
          savedBytes: 0,
          failure: gitRes.failure,
        }
      }

      const categories: Partial<Record<SavingsCategory, TelemetryCategoryDelta>> = {
        'git-compact': { calls: 1, savedBytes: gitRes.gitCompactSavedBytes },
      }
      if (gitRes.spillSavedBytes > 0) {
        categories.spillover = { calls: 1, savedBytes: gitRes.spillSavedBytes }
      }

      stores.telemetryStore?.record({
        rawBytes: gitRes.rawBytes,
        deliveredBytes: gitRes.deliveredBytes,
        savedBytes: gitRes.savedBytes,
        durationMs,
        categories,
      })

      const previewParts = [`branch ${gitRes.gitBranch}`, `${gitRes.gitDirtyFiles} dirty file(s)`]
      if (gitRes.gitSkippedLockfiles.length > 0) {
        previewParts.push(`${gitRes.gitSkippedLockfiles.length} lockfile(s) skipped`)
      }
      if (gitRes.savedBytes > 0) {
        previewParts.push(`saved ${gitRes.savedBytes} B`)
      }

      stores.activityStore?.record({
        id,
        kind: 'search',
        source,
        description,
        commandPreview: `pulse_search ${action}${req.staged ? ' --staged' : ''}${req.baseRef ? ` ${req.baseRef}` : ''}`,
        shell: 'git',
        cwd: gitRes.root,
        status: 'completed',
        exitCode: 0,
        effectState: 'none',
        durationMs,
        startedAt,
        endedAt: Date.now(),
        refId: gitRes.refId,
        outputPreview: previewParts.join(' · '),
        savedBytes: gitRes.savedBytes > 0 ? gitRes.savedBytes : undefined,
        estimatedTokensSaved:
          gitRes.savedBytes > 0 ? estimateTokensFromBytes(gitRes.savedBytes) : undefined,
        sessionId: stores.sessionId,
        anomaly: false,
        acknowledged: true,
      })

      return {
        status: 'completed',
        action,
        root: gitRes.root,
        totalMatched: gitRes.gitDirtyFiles,
        totalFilesMatched: gitRes.gitDirtyFiles,
        filesScanned: gitRes.gitDirtyFiles,
        scanComplete: true,
        truncated: gitRes.truncated,
        nextOffset: null,
        durationMs,
        rawBytes: gitRes.rawBytes,
        deliveredBytes: gitRes.deliveredBytes,
        savedBytes: gitRes.savedBytes,
        gitBranch: gitRes.gitBranch,
        gitDirtyFiles: gitRes.gitDirtyFiles,
        gitSkippedLockfiles: gitRes.gitSkippedLockfiles,
        gitText: gitRes.gitText,
        refId: gitRes.refId,
        spillPath: gitRes.spillPath,
      }
    }

    const patternLabel = Array.isArray(req.pattern) ? req.pattern.join(', ') : String(req.pattern ?? '')
    if (!patternLabel.trim()) {
      return reject({
        code: 'INVALID_ARGUMENT',
        message: 'Parameter "pattern" must be a non-empty string (or string array for glob).',
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: 'Provide a non-empty glob or regex pattern.',
      })
    }

    if ((action === 'grep' || action === 'fuzzy') && Array.isArray(req.pattern)) {
      return reject({
        code: 'INVALID_ARGUMENT',
        message: `Parameter "pattern" must be a single string when action is "${action}".`,
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: 'Pass a single string pattern.',
      })
    }

    let normalizedSearchPath: string | undefined
    if (req.path && req.path.trim().length > 0) {
      const normRes = normalizeWorkerPath(req.path, primaryRoot)
      if (!normRes.ok) {
        return reject(normRes.failure)
      }
      normalizedSearchPath = normRes.path
    }

    const outputMode = action === 'grep' ? (req.outputMode ?? 'content') : undefined
    const description =
      action === 'glob'
        ? `Glob ${patternLabel.slice(0, 120)}`
        : action === 'fuzzy'
          ? `Fuzzy ${patternLabel.slice(0, 120)}`
          : `Grep (${outputMode}) /${patternLabel.slice(0, 100)}/`

    if (action === 'glob' || action === 'fuzzy') {
      const workerOp = action === 'fuzzy' ? 'fuzzy' : 'glob'
      const workerArgs =
        action === 'fuzzy'
          ? {
              ...(normalizedSearchPath ? { path: normalizedSearchPath } : {}),
              pattern: req.pattern as string,
              ...(req.offset !== undefined ? { offset: req.offset } : {}),
              ...(req.limit !== undefined ? { limit: req.limit } : {}),
              includeHidden: Boolean(req.includeHidden),
            }
          : {
              ...(normalizedSearchPath ? { path: normalizedSearchPath } : {}),
              pattern: Array.isArray(req.pattern) ? req.pattern : [req.pattern as string],
              ...(req.kind ? { kind: req.kind } : {}),
              ...(req.sort ? { sort: req.sort } : {}),
              ...(req.offset !== undefined ? { offset: req.offset } : {}),
              ...(req.limit !== undefined ? { limit: req.limit } : {}),
              includeHidden: Boolean(req.includeHidden),
            }
      const workerRes = await this.rustWorker.invoke<WorkerGlobResult>(
        workerOp,
        workerArgs,
        {
          roots,
          credentialFence: config.enableCredentialFence,
          maxInlineBytes: config.maxInlineBytes,
        },
      )

      const durationMs = Math.max(0, Date.now() - startedAt)
      if (!workerRes.ok) {
        stores.activityStore?.record({
          id,
          kind: 'search',
          source,
          description,
          commandPreview: `pulse_search ${action} ${patternLabel.slice(0, 140)}`,
          shell: 'rust-worker',
          cwd: req.path || primaryRoot,
          status: 'failed',
          exitCode: null,
          effectState: workerRes.failure.effectState,
          errorCode: workerRes.failure.code,
          durationMs,
          startedAt,
          endedAt: Date.now(),
          outputPreview: workerRes.failure.message,
          sessionId: stores.sessionId,
          anomaly: true,
          acknowledged: false,
        })
        return {
          status: 'failed',
          action,
          root: req.path || primaryRoot,
          totalMatched: 0,
          totalFilesMatched: 0,
          filesScanned: 0,
          scanComplete: false,
          truncated: false,
          nextOffset: null,
          durationMs,
          rawBytes: 0,
          deliveredBytes: 0,
          savedBytes: 0,
          failure: workerRes.failure,
        }
      }

      const data = workerRes.result
      let entries: SearchEntry[] = Array.isArray(data.entries) ? data.entries : []
      const fullText = formatSearchEntriesText('glob', entries)
      const preSpillBytes = Buffer.byteLength(fullText, 'utf-8')
      let deliveredBytes = preSpillBytes
      let truncated = Boolean(data.truncated)
      let refId: string | undefined
      let spillPath: string | undefined

      if (preSpillBytes > config.maxInlineBytes) {
        try {
          const saved = this.spillStore.save({
            stdout: fullText,
            stderr: '',
            sessionId: stores.sessionId,
            meta: {
              tool: 'pulse_search',
              action,
              description,
              root: data.root,
              ...(stores.sessionId ? { sessionId: stores.sessionId } : {}),
            },
          })
          refId = saved.refId
          spillPath = saved.spillPath
        } catch {
          // Non-fatal spill error.
        }

        const kept: SearchEntry[] = []
        let used = 0
        for (const entry of entries) {
          const lineBytes = Buffer.byteLength(formatSearchEntriesText('glob', [entry]), 'utf-8') + 1
          if (used + lineBytes > config.maxInlineBytes && kept.length > 0) break
          kept.push(entry)
          used += lineBytes
        }
        entries = kept
        deliveredBytes = Buffer.byteLength(formatSearchEntriesText('glob', entries), 'utf-8')
        truncated = true
      }

      const savedBytes = Math.max(0, preSpillBytes - deliveredBytes)
      stores.telemetryStore?.record({
        rawBytes: preSpillBytes,
        deliveredBytes,
        savedBytes,
        durationMs,
        categories: savedBytes > 0 ? { spillover: { calls: 1, savedBytes } } : undefined,
      })

      stores.activityStore?.record({
        id,
        kind: 'search',
        source,
        description,
        commandPreview: `pulse_search ${action} ${patternLabel.slice(0, 140)}`,
        shell: 'rust-worker',
        cwd: data.root || primaryRoot,
        status: 'completed',
        exitCode: 0,
        effectState: 'none',
        durationMs,
        startedAt,
        endedAt: Date.now(),
        refId,
        outputPreview: `${data.totalMatched} match(es) across ${data.filesScanned} scanned`,
        savedBytes: savedBytes > 0 ? savedBytes : undefined,
        estimatedTokensSaved: savedBytes > 0 ? estimateTokensFromBytes(savedBytes) : undefined,
        sessionId: stores.sessionId,
        anomaly: false,
        acknowledged: true,
      })

      return {
        status: 'completed',
        action,
        root: data.root,
        totalMatched: data.totalMatched,
        totalFilesMatched: data.totalMatched,
        filesScanned: data.filesScanned,
        scanComplete: Boolean(data.scanComplete),
        truncated,
        nextOffset: data.nextOffset ?? null,
        durationMs,
        rawBytes: preSpillBytes,
        deliveredBytes,
        savedBytes,
        entries,
        refId,
        spillPath,
      }
    }

    const workerRes = await this.rustWorker.invoke<WorkerGrepResult>(
      'grep',
      {
        ...(normalizedSearchPath ? { path: normalizedSearchPath } : {}),
        pattern: req.pattern as string,
        ...(req.glob ? { glob: req.glob } : {}),
        outputMode,
        caseInsensitive: Boolean(req.caseInsensitive),
        ...(req.beforeContext !== undefined ? { beforeContext: req.beforeContext } : {}),
        ...(req.afterContext !== undefined ? { afterContext: req.afterContext } : {}),
        ...(req.offset !== undefined ? { offset: req.offset } : {}),
        ...(req.limit !== undefined ? { limit: req.limit } : {}),
        includeHidden: Boolean(req.includeHidden),
      },
      {
        roots,
        credentialFence: config.enableCredentialFence,
        maxInlineBytes: config.maxInlineBytes,
      },
    )

    const durationMs = Math.max(0, Date.now() - startedAt)
    if (!workerRes.ok) {
      stores.activityStore?.record({
        id,
        kind: 'search',
        source,
        description,
        commandPreview: `pulse_search grep (${outputMode}) ${patternLabel.slice(0, 120)}`,
        shell: 'rust-worker',
        cwd: req.path || primaryRoot,
        status: 'failed',
        exitCode: null,
        effectState: workerRes.failure.effectState,
        errorCode: workerRes.failure.code,
        durationMs,
        startedAt,
        endedAt: Date.now(),
        outputPreview: workerRes.failure.message,
        sessionId: stores.sessionId,
        anomaly: true,
        acknowledged: false,
      })
      return {
        status: 'failed',
        action: 'grep',
        outputMode,
        root: req.path || primaryRoot,
        totalMatched: 0,
        totalFilesMatched: 0,
        filesScanned: 0,
        scanComplete: false,
        truncated: false,
        nextOffset: null,
        durationMs,
        rawBytes: 0,
        deliveredBytes: 0,
        savedBytes: 0,
        failure: workerRes.failure,
      }
    }

    const data = workerRes.result
    let entries: SearchEntry[] = Array.isArray(data.entries) ? data.entries : []
    const fullText = formatSearchEntriesText('grep', entries)
    const preSpillBytes = Buffer.byteLength(fullText, 'utf-8')
    let deliveredBytes = preSpillBytes
    let truncated = Boolean(data.truncated)
    let refId: string | undefined
    let spillPath: string | undefined
    let spillSavedBytes = 0

    if (preSpillBytes > config.maxInlineBytes) {
      try {
        const saved = this.spillStore.save({
          stdout: fullText,
          stderr: '',
          sessionId: stores.sessionId,
          meta: {
            tool: 'pulse_search',
            action: 'grep',
            outputMode: data.outputMode || outputMode,
            description,
            root: data.root,
            ...(stores.sessionId ? { sessionId: stores.sessionId } : {}),
          },
        })
        refId = saved.refId
        spillPath = saved.spillPath
      } catch {
        // Non-fatal spill error.
      }

      // Apply water-fill budgeting to match text payloads so paths & line numbers stay intact
      // while long matched lines (e.g. minified bundles) middle-truncate fairly before dropping rows.
      let candidateEntries = entries
      const textIndices: number[] = []
      const textLengths: number[] = []
      let headerOverheadBytes = 0
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        if (typeof e.text === 'string' && e.text.length > 0) {
          const fullLineBytes = Buffer.byteLength(formatSearchEntriesText('grep', [e]), 'utf-8') + 1
          const textBytes = Buffer.byteLength(e.text, 'utf-8')
          headerOverheadBytes += Math.max(0, fullLineBytes - textBytes)
          textIndices.push(i)
          textLengths.push(textBytes)
        } else {
          headerOverheadBytes += Buffer.byteLength(formatSearchEntriesText('grep', [e]), 'utf-8') + 1
        }
      }

      if (textIndices.length > 0 && headerOverheadBytes + textIndices.length * 48 <= config.maxInlineBytes) {
        const textBudget = config.maxInlineBytes - headerOverheadBytes
        const allocations = waterFill(textLengths, textBudget)
        candidateEntries = entries.map((e) => ({ ...e }))
        for (let k = 0; k < textIndices.length; k++) {
          const idx = textIndices[k]
          const entry = candidateEntries[idx]
          const limitBytes = allocations[k] ?? 0
          if (typeof entry.text === 'string' && Buffer.byteLength(entry.text, 'utf-8') > limitBytes) {
            entry.text = truncateMiddle(entry.text, Math.max(48, limitBytes)).text
          }
        }
      }

      const kept: SearchEntry[] = []
      let used = 0
      for (const entry of candidateEntries) {
        const lineBytes = Buffer.byteLength(formatSearchEntriesText('grep', [entry]), 'utf-8') + 1
        if (used + lineBytes > config.maxInlineBytes && kept.length > 0) break
        kept.push(entry)
        used += lineBytes
      }
      entries = kept
      deliveredBytes = Buffer.byteLength(formatSearchEntriesText('grep', entries), 'utf-8')
      spillSavedBytes = Math.max(0, preSpillBytes - deliveredBytes)
      truncated = true
    }

    const effectiveMode = data.outputMode || outputMode || 'content'
    const workerRawBytes = typeof data.rawBytes === 'number' ? data.rawBytes : 0
    // Estimate baseline bytes for summary header when entries array is empty (e.g. summary mode).
    const effectiveDeliveredBytes =
      deliveredBytes > 0 ? deliveredBytes : Buffer.byteLength(`${data.totalMatched} matches in ${data.totalFilesMatched} files`, 'utf-8')
    const progressiveSavedBytes =
      effectiveMode !== 'content'
        ? Math.max(0, workerRawBytes - Math.max(preSpillBytes, effectiveDeliveredBytes))
        : 0
    const savedBytes = progressiveSavedBytes + spillSavedBytes
    const rawBytes = effectiveDeliveredBytes + savedBytes

    const categories: Partial<Record<SavingsCategory, TelemetryCategoryDelta>> = {}
    if (effectiveMode !== 'content') {
      categories['grep-progressive'] = { calls: 1, savedBytes: progressiveSavedBytes }
    }
    if (spillSavedBytes > 0) {
      categories.spillover = { calls: 1, savedBytes: spillSavedBytes }
    }

    stores.telemetryStore?.record({
      rawBytes,
      deliveredBytes: effectiveDeliveredBytes,
      savedBytes,
      durationMs,
      categories: Object.keys(categories).length > 0 ? categories : undefined,
    })

    const preview =
      effectiveMode === 'definitions' && typeof data.definitionMatches === 'number'
        ? `${data.definitionMatches} definition(s), ${data.impliedReferences ?? 0} implied ref(s) in ${data.totalFilesMatched} file(s)`
        : `${data.totalMatched} match(es) in ${data.totalFilesMatched} file(s) (${data.filesScanned} scanned)`

    stores.activityStore?.record({
      id,
      kind: 'search',
      source,
      description,
      commandPreview: `pulse_search grep (${effectiveMode}) ${patternLabel.slice(0, 120)}`,
      shell: 'rust-worker',
      cwd: data.root || primaryRoot,
      status: 'completed',
      exitCode: 0,
      effectState: 'none',
      durationMs,
      startedAt,
      endedAt: Date.now(),
      refId,
      outputPreview: preview,
      savedBytes: savedBytes > 0 ? savedBytes : undefined,
      estimatedTokensSaved: savedBytes > 0 ? estimateTokensFromBytes(savedBytes) : undefined,
      sessionId: stores.sessionId,
      anomaly: false,
      acknowledged: true,
    })

    return {
      status: 'completed',
      action: 'grep',
      outputMode: effectiveMode,
      root: data.root,
      totalMatched: data.totalMatched,
      totalFilesMatched: data.totalFilesMatched,
      filesScanned: data.filesScanned,
      definitionMatches: data.definitionMatches,
      impliedReferences: data.impliedReferences,
      scanComplete: Boolean(data.scanComplete),
      truncated,
      nextOffset: data.nextOffset ?? null,
      durationMs,
      rawBytes,
      deliveredBytes: effectiveDeliveredBytes,
      savedBytes,
      entries,
      refId,
      spillPath,
    }
  }

  async mutate(
    req: MutateRequest,
    source: 'agent' | 'user' = 'agent',
    sessionId?: string,
  ): Promise<MutateOutcome> {
    const id = generateOpId('mutate')
    const startedAt = Date.now()
    const config = this.configStore.get()
    const roots = await this.getWorkspaceRoots(sessionId)
    const primaryRoot = roots[0] || ''
    const stores = this.resolveStores(sessionId, primaryRoot)
    const action = req.action
    const dryRun = action === 'diff' ? true : Boolean(req.dryRun)

    const reject = (failure: FailureInfo): MutateOutcome => {
      const durationMs = Math.max(0, Date.now() - startedAt)
      stores.activityStore?.record({
        id,
        kind: 'mutate',
        source,
        description: `Mutate (${String(action || 'unknown')})`,
        commandPreview: `pulse_mutate ${String(action || '')} ${req.path || ''}`.trim(),
        shell: 'rust-worker',
        cwd: primaryRoot,
        status: 'rejected',
        exitCode: null,
        effectState: failure.effectState,
        errorCode: failure.code,
        durationMs,
        startedAt,
        endedAt: Date.now(),
        outputPreview: failure.message,
        sessionId: stores.sessionId,
        anomaly: true,
        acknowledged: false,
      })
      return {
        status: 'rejected',
        action:
          action === 'edit' ||
          action === 'write' ||
          action === 'diff' ||
          action === 'replace' ||
          action === 'batch'
            ? action
            : 'edit',
        dryRun,
        durationMs,
        path: req.path,
        failure,
      }
    }

    if (roots.length === 0) {
      return reject(WORKSPACE_UNRESOLVED_FAILURE)
    }

    if (
      action !== 'edit' &&
      action !== 'write' &&
      action !== 'diff' &&
      action !== 'replace' &&
      action !== 'batch'
    ) {
      return reject({
        code: 'INVALID_ARGUMENT',
        message: `Invalid mutate action "${String(action)}". Must be one of: edit, write, diff, replace, batch.`,
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: 'Provide a valid mutate action.',
      })
    }

    const normalizeRequiredPath = (raw: string | undefined): string | null => {
      if (!raw || typeof raw !== 'string' || raw.trim().length === 0) return null
      const res = normalizeWorkerPath(raw, primaryRoot)
      if (!res.ok) {
        normalizedPathFailure = res.failure
        return null
      }
      return res.path
    }
    let normalizedPathFailure: FailureInfo | null = null

    let workerArgs: Record<string, unknown>
    let description: string
    switch (action) {
      case 'diff': {
        const hasContent = typeof req.content === 'string'
        const hasEdits = Array.isArray(req.edits) && req.edits.length > 0
        if (!req.path || hasContent === hasEdits) {
          return reject({
            code: 'INVALID_ARGUMENT',
            message:
              'Action "diff" requires "path" and exactly one of string "content" or a non-empty "edits" array.',
            effectState: 'none',
            retry: 'after-input-change',
            nextAction: 'Provide "path" with either "content" or "edits" for diff preview.',
          })
        }
        const normPath = normalizeRequiredPath(req.path)
        if (!normPath) return reject(normalizedPathFailure!)
        workerArgs = hasContent
          ? { path: normPath, content: req.content }
          : { path: normPath, edits: req.edits }
        description = `Diff ${req.path}`
        break
      }
      case 'write': {
        if (!req.path || typeof req.content !== 'string') {
          return reject({
            code: 'INVALID_ARGUMENT',
            message: 'Action "write" requires "path" and string "content".',
            effectState: 'none',
            retry: 'after-input-change',
            nextAction: 'Provide "path" and "content" (plus optional "expected_revision" for CAS).',
          })
        }
        const normPath = normalizeRequiredPath(req.path)
        if (!normPath) return reject(normalizedPathFailure!)
        workerArgs = {
          path: normPath,
          content: req.content,
          ...(req.expectedRevision ? { expectedRevision: req.expectedRevision } : {}),
          dryRun,
        }
        description = `${dryRun ? 'Plan write' : 'Write'} ${req.path}`
        break
      }
      case 'edit': {
        if (
          !req.path ||
          !Array.isArray(req.edits) ||
          req.edits.length === 0
        ) {
          return reject({
            code: 'INVALID_ARGUMENT',
            message: 'Action "edit" requires "path" and a non-empty "edits" array.',
            effectState: 'none',
            retry: 'after-input-change',
            nextAction: 'Provide "path" and non-overlapping { old_text, new_text } edits (expected_revision is optional).',
          })
        }
        const normPath = normalizeRequiredPath(req.path)
        if (!normPath) return reject(normalizedPathFailure!)
        workerArgs = {
          path: normPath,
          ...(req.expectedRevision ? { expectedRevision: req.expectedRevision } : {}),
          edits: req.edits,
          dryRun,
        }
        description = `${dryRun ? 'Plan edit' : 'Edit'} ${req.path} (${req.edits.length} edit${req.edits.length === 1 ? '' : 's'})`
        break
      }
      case 'replace': {
        if (typeof req.pattern !== 'string' || req.pattern.length === 0 || typeof req.replacement !== 'string') {
          return reject({
            code: 'INVALID_ARGUMENT',
            message: 'Action "replace" requires non-empty "pattern" and string "replacement".',
            effectState: 'none',
            retry: 'after-input-change',
            nextAction: 'Provide "pattern" and "replacement" strings.',
          })
        }
        let normPath: string | undefined
        if (req.path && req.path.trim().length > 0) {
          const p = normalizeRequiredPath(req.path)
          if (!p) return reject(normalizedPathFailure!)
          normPath = p
        }
        workerArgs = {
          ...(normPath ? { path: normPath } : {}),
          pattern: req.pattern,
          replacement: req.replacement,
          regex: Boolean(req.regex),
          ...(req.glob ? { glob: req.glob } : {}),
          ...(req.maxReplacements !== undefined ? { maxReplacements: req.maxReplacements } : {}),
          dryRun,
        }
        description = `${dryRun ? 'Plan replace' : 'Replace'} "${req.pattern.slice(0, 60)}"`
        break
      }
      case 'batch': {
        if (!Array.isArray(req.operations) || req.operations.length === 0) {
          return reject({
            code: 'INVALID_ARGUMENT',
            message: 'Action "batch" requires a non-empty "operations" array.',
            effectState: 'none',
            retry: 'after-input-change',
            nextAction: 'Provide 1 to 512 { op: "copy"|"move"|"remove", path, to? } operations.',
          })
        }
        const normalizedOps: MutateRequest['operations'] = []
        for (const op of req.operations) {
          const normSrc = normalizeRequiredPath(op.path)
          if (!normSrc) {
            return reject(
              normalizedPathFailure ?? {
                code: 'INVALID_ARGUMENT',
                message: 'Each batch operation requires a non-empty "path".',
                effectState: 'none',
                retry: 'after-input-change',
                nextAction: 'Provide valid workspace paths for every batch operation.',
              },
            )
          }
          let normTo: string | undefined
          if (op.to !== undefined) {
            const dst = normalizeRequiredPath(op.to)
            if (!dst) {
              return reject(
                normalizedPathFailure ?? {
                  code: 'INVALID_ARGUMENT',
                  message: 'Batch operation "to" must be a non-empty path.',
                  effectState: 'none',
                  retry: 'after-input-change',
                  nextAction: 'Provide a valid destination path for copy/move operations.',
                },
              )
            }
            normTo = dst
          }
          normalizedOps.push({
            op: op.op,
            path: normSrc,
            ...(normTo !== undefined ? { to: normTo } : {}),
          })
        }
        workerArgs = {
          operations: normalizedOps,
          dryRun,
        }
        description = `${dryRun ? 'Plan batch' : 'Batch'} (${req.operations.length} ops)`
        break
      }
    }

    const workerRes = await this.rustWorker.invoke<unknown>(action, workerArgs, {
      roots,
      credentialFence: config.enableCredentialFence,
      maxInlineBytes: config.maxInlineBytes,
    })

    const durationMs = Math.max(0, Date.now() - startedAt)

    if (!workerRes.ok) {
      stores.activityStore?.record({
        id,
        kind: 'mutate',
        source,
        description,
        commandPreview: `pulse_mutate ${action} ${req.path || ''}`.trim(),
        shell: 'rust-worker',
        cwd: primaryRoot,
        status: 'failed',
        exitCode: 1,
        effectState: workerRes.failure.effectState,
        errorCode: workerRes.failure.code,
        durationMs,
        startedAt,
        endedAt: Date.now(),
        outputPreview: workerRes.failure.message,
        sessionId: stores.sessionId,
        anomaly: true,
        acknowledged: false,
      })
      return {
        status: 'failed',
        action,
        dryRun,
        durationMs,
        path: req.path,
        failure: workerRes.failure,
      }
    }

    const outcome: MutateOutcome = {
      status: dryRun ? 'planned' : 'completed',
      action,
      dryRun,
      durationMs,
      path: req.path,
    }

    let roundTripsSaved = 0
    let preview = ''

    if (action === 'diff') {
      const r = workerRes.result as WorkerDiffResult
      outcome.path = r.path
      outcome.beforeRevision = r.beforeRevision
      outcome.afterRevision = r.afterRevision
      outcome.diff = r.diff
      outcome.addedLines = r.addedLines
      outcome.removedLines = r.removedLines
      preview = `+${r.addedLines}/-${r.removedLines} lines`
    } else if (action === 'write' || action === 'edit') {
      const r = workerRes.result as WorkerWriteEditResult
      outcome.path = r.path
      outcome.beforeRevision = r.beforeRevision
      outcome.afterRevision = r.afterRevision
      outcome.diff = r.diff
      outcome.addedLines = r.addedLines
      outcome.removedLines = r.removedLines
      if (action === 'edit' && req.edits && req.edits.length > 1) {
        roundTripsSaved = req.edits.length - 1
      }
      if (!dryRun && stores.readDedupStore) {
        if (req.path) stores.readDedupStore.invalidatePath(req.path)
        if (r.path) stores.readDedupStore.invalidatePath(r.path)
      }
      preview = `${dryRun ? '[dry-run] ' : ''}+${r.addedLines}/-${r.removedLines} lines`
    } else if (action === 'replace') {
      const r = workerRes.result as WorkerReplaceResult
      outcome.path = r.root
      outcome.filesChanged = r.filesChanged
      outcome.totalReplacements = r.totalReplacements
      outcome.skippedFiles = r.skippedFiles
      outcome.diff = r.diff
      if (r.filesChanged > 1) {
        roundTripsSaved = r.filesChanged - 1
      }
      if (!dryRun && r.filesChanged > 0 && stores.readDedupStore) {
        if (Array.isArray(r.changedPaths) && r.changedPaths.length > 0) {
          for (const changed of r.changedPaths) {
            stores.readDedupStore.invalidatePath(changed)
          }
        } else if (req.path) {
          stores.readDedupStore.invalidatePath(req.path)
        } else {
          stores.readDedupStore.invalidateAll()
        }
      }
      preview = `${dryRun ? '[dry-run] ' : ''}${r.totalReplacements} replacement(s) across ${r.filesChanged} file(s)`
    } else if (action === 'batch') {
      const r = workerRes.result as WorkerBatchResult
      const rawResults = Array.isArray(r.batchResults) ? r.batchResults : []
      const mapped: MutateBatchResultItem[] = rawResults.map((item, idx) => ({
        index: idx,
        op: item.op,
        path: item.path,
        to: item.to,
        status:
          item.status === 'planned'
            ? 'planned'
            : item.status === 'failed'
              ? 'failed'
              : 'ok',
        error: item.error,
      }))
      outcome.batchResults = mapped
      outcome.filesChanged = mapped.length
      if (mapped.length > 1) {
        roundTripsSaved = mapped.length - 1
      }
      if (!dryRun && stores.readDedupStore) {
        for (const op of req.operations ?? []) {
          if (op.path) stores.readDedupStore.invalidatePath(op.path)
          if (op.to) stores.readDedupStore.invalidatePath(op.to)
        }
        for (const item of mapped) {
          if (item.path) stores.readDedupStore.invalidatePath(item.path)
          if (item.to) stores.readDedupStore.invalidatePath(item.to)
        }
      }
      preview = `${dryRun ? '[dry-run] ' : ''}${mapped.length} filesystem op(s)`
    }

    if (roundTripsSaved > 0) {
      outcome.roundTripsSaved = roundTripsSaved
    }

    const rawDiffBytes = outcome.diff ? Buffer.byteLength(outcome.diff, 'utf-8') : 0
    let diffSpillSavedBytes = 0
    if (outcome.diff && rawDiffBytes > config.maxInlineBytes) {
      try {
        const saved = this.spillStore.save({
          stdout: outcome.diff,
          stderr: '',
          sessionId: stores.sessionId,
          meta: {
            tool: 'pulse_mutate',
            action,
            description,
            path: outcome.path,
            ...(stores.sessionId ? { sessionId: stores.sessionId } : {}),
          },
        })
        outcome.refId = saved.refId
        outcome.spillPath = saved.spillPath
      } catch {
        // Non-fatal spill error; still enforce inline diff cap below.
      }
      const clipped = truncateUtf8(outcome.diff, config.maxInlineBytes)
      if (clipped.truncated) {
        outcome.diff = `${clipped.text}\n...[diff truncated inline; page full diff via pulse_result]`
      }
      const inlineDiffBytes = Buffer.byteLength(outcome.diff, 'utf-8')
      diffSpillSavedBytes = Math.max(0, rawDiffBytes - inlineDiffBytes)
    }
    const deliveredDiffBytes = outcome.diff ? Buffer.byteLength(outcome.diff, 'utf-8') : 0

    const mutateCategories: Partial<Record<SavingsCategory, TelemetryCategoryDelta>> = {}
    if (roundTripsSaved > 0) {
      mutateCategories['batch-mutate'] = { calls: 1, savedBytes: 0, roundTripsSaved }
    }
    if (diffSpillSavedBytes > 0) {
      mutateCategories.spillover = { calls: 1, savedBytes: diffSpillSavedBytes }
    }

    stores.telemetryStore?.record({
      rawBytes: rawDiffBytes,
      deliveredBytes: deliveredDiffBytes,
      savedBytes: diffSpillSavedBytes,
      durationMs,
      roundTripsSaved,
      categories: Object.keys(mutateCategories).length > 0 ? mutateCategories : undefined,
    })

    stores.activityStore?.record({
      id,
      kind: 'mutate',
      source,
      description,
      commandPreview: `pulse_mutate ${action} ${outcome.path || ''}`.trim(),
      shell: 'rust-worker',
      cwd: primaryRoot,
      status: outcome.status,
      exitCode: 0,
      effectState: dryRun ? 'none' : 'applied',
      durationMs,
      startedAt,
      endedAt: Date.now(),
      refId: outcome.refId,
      outputPreview: preview,
      savedBytes: diffSpillSavedBytes > 0 ? diffSpillSavedBytes : undefined,
      estimatedTokensSaved:
        diffSpillSavedBytes > 0 ? estimateTokensFromBytes(diffSpillSavedBytes) : undefined,
      roundTripsSaved: roundTripsSaved > 0 ? roundTripsSaved : undefined,
      sessionId: stores.sessionId,
      anomaly: false,
      acknowledged: true,
    })

    return outcome
  }

  async readDoc(
    req: ReadDocRequest,
    source: 'agent' | 'user' = 'agent',
    sessionId?: string,
  ): Promise<ReadDocOutcome> {
    const id = generateOpId('doc')
    const startedAt = Date.now()
    const config = this.configStore.get()
    const roots = await this.getWorkspaceRoots(sessionId)
    const primaryRoot = roots[0] || ''
    const stores = this.resolveStores(sessionId, primaryRoot)

    const reject = (failure: FailureInfo): ReadDocOutcome => {
      const durationMs = Math.max(0, Date.now() - startedAt)
      stores.activityStore?.record({
        id,
        kind: 'doc',
        source,
        description: `Read doc ${req.path || '(missing)'}`,
        commandPreview: `pulse_read_doc ${req.path || ''}`.trim(),
        shell: 'rust-worker',
        cwd: primaryRoot,
        status: 'rejected',
        exitCode: null,
        effectState: failure.effectState,
        errorCode: failure.code,
        durationMs,
        startedAt,
        endedAt: Date.now(),
        outputPreview: failure.message,
        sessionId: stores.sessionId,
        anomaly: true,
        acknowledged: false,
      })
      return {
        status: 'rejected',
        path: req.path || '',
        format: 'table',
        bytes: 0,
        totalUnits: 0,
        unitName: 'rows',
        offset: req.offset ?? 1,
        returnedUnits: 0,
        nextOffset: null,
        complete: false,
        content: '',
        durationMs,
        rawBytes: 0,
        deliveredBytes: 0,
        savedBytes: 0,
        failure,
      }
    }

    if (roots.length === 0) {
      return reject(WORKSPACE_UNRESOLVED_FAILURE)
    }

    if (!req.path || typeof req.path !== 'string' || req.path.trim().length === 0) {
      return reject({
        code: 'INVALID_ARGUMENT',
        message: 'Parameter "path" must be a non-empty file path.',
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: 'Provide a CSV, TSV, DOCX, or PDF path inside the workspace.',
      })
    }

    const normDocPath = normalizeWorkerPath(req.path, primaryRoot)
    if (!normDocPath.ok) {
      return reject(normDocPath.failure)
    }

    const description = `Read doc ${req.path}`

    const workerRes = await this.rustWorker.invoke<WorkerReadDocResult>(
      'read_doc',
      {
        path: normDocPath.path,
        format: req.format ?? 'auto',
        ...(req.encoding ? { encoding: req.encoding } : {}),
        ...(req.header !== undefined ? { header: req.header } : {}),
        ...(req.offset !== undefined ? { offset: req.offset } : {}),
        ...(req.limit !== undefined ? { limit: req.limit } : {}),
      },
      {
        roots,
        credentialFence: config.enableCredentialFence,
        maxInlineBytes: config.maxInlineBytes,
      },
    )

    const durationMs = Math.max(0, Date.now() - startedAt)

    if (!workerRes.ok) {
      stores.activityStore?.record({
        id,
        kind: 'doc',
        source,
        description,
        commandPreview: `pulse_read_doc ${req.path}`,
        shell: 'rust-worker',
        cwd: primaryRoot,
        status: 'failed',
        exitCode: 1,
        effectState: workerRes.failure.effectState,
        errorCode: workerRes.failure.code,
        durationMs,
        startedAt,
        endedAt: Date.now(),
        outputPreview: workerRes.failure.message,
        sessionId: stores.sessionId,
        anomaly: true,
        acknowledged: false,
      })
      return {
        status: 'failed',
        path: req.path,
        format: req.format === 'docx' || req.format === 'pdf' ? req.format : 'table',
        bytes: 0,
        totalUnits: 0,
        unitName:
          req.format === 'docx' ? 'paragraphs' : req.format === 'pdf' ? 'pages' : 'rows',
        offset: req.offset ?? 1,
        returnedUnits: 0,
        nextOffset: null,
        complete: false,
        content: '',
        durationMs,
        rawBytes: 0,
        deliveredBytes: 0,
        savedBytes: 0,
        failure: workerRes.failure,
      }
    }

    const data = workerRes.result
    const format = normalizeDocFormat(data.format)
    const unitName = docUnitNameForFormat(format)
    const fullContent = typeof data.content === 'string' ? data.content : ''
    const fullContentBytes = Buffer.byteLength(fullContent, 'utf-8')
    let inlineContent = fullContent
    let refId: string | undefined
    let spillPath: string | undefined
    let spillSavedBytes = 0

    if (fullContentBytes > config.maxInlineBytes) {
      try {
        const saved = this.spillStore.save({
          stdout: fullContent,
          stderr: '',
          sessionId: stores.sessionId,
          meta: {
            tool: 'pulse_read_doc',
            format,
            description,
            path: data.path,
            totalUnits: data.totalUnits,
            ...(stores.sessionId ? { sessionId: stores.sessionId } : {}),
          },
        })
        refId = saved.refId
        spillPath = saved.spillPath
      } catch {
        // Non-fatal spill error.
      }
      const clipped = truncateUtf8(fullContent, config.maxInlineBytes)
      inlineContent = clipped.truncated
        ? `${clipped.text}\n...[truncated inline; page full output via pulse_result]`
        : clipped.text
      const inlineBytes = Buffer.byteLength(inlineContent, 'utf-8')
      spillSavedBytes = Math.max(0, fullContentBytes - inlineBytes)
    }

    const deliveredBytes = Buffer.byteLength(inlineContent, 'utf-8')
    // Count only verified text spillover savings; never treat binary ZIP/PDF container size as saved LLM tokens.
    const rawBytes = Math.max(fullContentBytes, deliveredBytes)
    const savedBytes = spillSavedBytes

    const categories: Partial<Record<SavingsCategory, TelemetryCategoryDelta>> = {
      'native-doc': { calls: 1, savedBytes: 0 },
    }
    if (spillSavedBytes > 0) {
      categories.spillover = { calls: 1, savedBytes: spillSavedBytes }
    }

    stores.telemetryStore?.record({
      rawBytes,
      deliveredBytes,
      savedBytes,
      durationMs,
      categories,
    })

    stores.activityStore?.record({
      id,
      kind: 'doc',
      source,
      description,
      commandPreview: `pulse_read_doc (${format}) ${data.path}`,
      shell: 'rust-worker',
      cwd: path.dirname(data.path) || primaryRoot,
      status: 'completed',
      exitCode: 0,
      effectState: 'none',
      durationMs,
      startedAt,
      endedAt: Date.now(),
      refId,
      outputPreview: `${format.toUpperCase()}: ${data.returnedUnits}/${data.totalUnits} ${unitName} (${data.bytes} B)`,
      savedBytes: savedBytes > 0 ? savedBytes : undefined,
      estimatedTokensSaved: savedBytes > 0 ? estimateTokensFromBytes(savedBytes) : undefined,
      sessionId: stores.sessionId,
      anomaly: false,
      acknowledged: true,
    })

    return {
      status: 'completed',
      path: data.path,
      format,
      bytes: data.bytes,
      totalUnits: data.totalUnits,
      unitName,
      offset: data.offset,
      returnedUnits: data.returnedUnits,
      nextOffset: data.nextOffset ?? null,
      complete: Boolean(data.complete),
      columns: data.columns,
      content: inlineContent,
      durationMs,
      rawBytes,
      deliveredBytes,
      savedBytes,
      refId,
      spillPath,
    }
  }
}
