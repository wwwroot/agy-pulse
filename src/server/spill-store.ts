import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { resolveDataDir } from '../shared/paths.ts'
import {
  DEFAULT_TERMINAL_CONFIG,
  type ResultPageRequest,
  type ResultPageResponse,
  type SpillEntrySummary,
  type TerminalConfig,
} from '../shared/types.ts'

const REF_PREFIX = 'ref://spill/'
const VALID_SPILL_ID_RE = /^[a-zA-Z0-9_-]{4,96}$/
const MAX_LEDGER_ENTRIES = 4096
const DEFAULT_PAGE_LIMIT = 200
const MAX_PAGE_LIMIT = 2000
const DEFAULT_PAGE_MAX_BYTES = 7_200
const MAX_PAGE_MAX_BYTES = 262_144

export interface SaveSpillInput {
  stdout: string
  stderr: string
  meta?: Record<string, unknown>
  sessionId?: string
}

export interface SaveSpillOutput {
  id: string
  refId: string
  spillPath: string
  stdoutPath: string
  stderrPath: string
  totalBytes: number
}

interface SpillLedgerEntry {
  id: string
  refId: string
  createdAt: number
  stdoutBytes: number
  stderrBytes: number
  totalBytes: number
  tool?: string
  description?: string
  shell?: string
  sessionId?: string
}

function parseSpillId(refId: string): string {
  const trimmed = (refId || '').trim()
  const id = trimmed.startsWith(REF_PREFIX) ? trimmed.slice(REF_PREFIX.length) : trimmed
  if (!VALID_SPILL_ID_RE.test(id)) {
    throw new Error(`Invalid spill reference "${refId}". Expected format: ref://spill/<id>.`)
  }
  return id
}

function sliceUtf8Safe(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) {
    return { text, truncated: false }
  }
  const buf = Buffer.from(text, 'utf-8')
  let end = Math.max(0, maxBytes)
  // Step back across UTF-8 continuation bytes (10xxxxxx) to avoid splitting a multi-byte character.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--
  }
  let sliced = buf.subarray(0, end).toString('utf-8')
  // Guard against trailing replacement char if cut right before a multi-byte lead byte.
  if (sliced.endsWith('\uFFFD') && !text.startsWith(sliced)) {
    sliced = sliced.slice(0, -1)
  }
  return { text: sliced, truncated: true }
}

function buildLineMatcher(search: string, caseInsensitive: boolean): (line: string) => boolean {
  const flags = caseInsensitive ? 'i' : ''
  try {
    const regex = new RegExp(search, flags)
    return (line) => regex.test(line)
  } catch {
    // Fall back to literal substring matching when the search string is not valid regex.
    const needle = caseInsensitive ? search.toLowerCase() : search
    return (line) => (caseInsensitive ? line.toLowerCase() : line).includes(needle)
  }
}

export class SpillStore extends EventEmitter {
  readonly dataDir: string
  readonly spillsDir: string
  readonly ledgerPath: string
  private readonly getConfig: () => TerminalConfig
  private writesSinceGc = 0
  private index: Map<string, SpillEntrySummary> | null = null

  constructor(
    dataDir: string = resolveDataDir(),
    getConfig: () => TerminalConfig = () => DEFAULT_TERMINAL_CONFIG,
  ) {
    super()
    this.dataDir = dataDir
    this.spillsDir = path.join(dataDir, 'spills')
    this.ledgerPath = path.join(dataDir, 'spill-ledger.jsonl')
    this.getConfig = getConfig
  }

  private ensureDirs(): void {
    mkdirSync(this.spillsDir, { recursive: true, mode: 0o700 })
  }

  private ensureIndex(): Map<string, SpillEntrySummary> {
    if (this.index !== null) {
      return this.index
    }
    const map = new Map<string, SpillEntrySummary>()
    if (!existsSync(this.spillsDir)) {
      this.index = map
      return map
    }

    const entries = readdirSync(this.spillsDir)
    for (const fileName of entries) {
      if (!fileName.endsWith('.meta.json')) continue
      const metaPath = path.join(this.spillsDir, fileName)
      try {
        const parsed = JSON.parse(readFileSync(metaPath, 'utf-8')) as Record<string, unknown>
        const id =
          typeof parsed.id === 'string' && parsed.id.length > 0
            ? parsed.id
            : fileName.slice(0, -'.meta.json'.length)
        const refId =
          typeof parsed.refId === 'string' && parsed.refId.length > 0
            ? parsed.refId
            : `${REF_PREFIX}${id}`
        const stdoutBytes = typeof parsed.stdoutBytes === 'number' ? parsed.stdoutBytes : 0
        const stderrBytes = typeof parsed.stderrBytes === 'number' ? parsed.stderrBytes : 0
        const totalBytes =
          typeof parsed.totalBytes === 'number' ? parsed.totalBytes : stdoutBytes + stderrBytes
        const createdAt =
          typeof parsed.createdAt === 'number' ? parsed.createdAt : statSync(metaPath).mtimeMs
        const entrySessionId =
          typeof parsed.sessionId === 'string' && parsed.sessionId.trim().length > 0
            ? parsed.sessionId.trim()
            : undefined
        const tool =
          typeof parsed.tool === 'string' && parsed.tool.trim().length > 0
            ? parsed.tool.trim()
            : typeof parsed.jobId === 'string'
              ? 'pulse_job'
              : typeof parsed.execId === 'string' || typeof parsed.shell === 'string'
                ? 'pulse_exec'
                : 'pulse_result'
        const description =
          typeof parsed.description === 'string' && parsed.description.trim().length > 0
            ? parsed.description.trim()
            : refId

        map.set(id, {
          refId,
          tool,
          description,
          totalBytes,
          stdoutBytes,
          stderrBytes,
          createdAt,
          ...(entrySessionId ? { sessionId: entrySessionId } : {}),
        })
      } catch {
        // Ignore malformed or concurrently deleted meta files.
      }
    }
    this.index = map
    return map
  }

  save(input: SaveSpillInput): SaveSpillOutput {
    this.ensureDirs()

    const ts = Date.now().toString(36)
    const rand = randomBytes(5).toString('hex')
    const id = `sp_${ts}_${rand}`
    const refId = `${REF_PREFIX}${id}`

    const stdoutText = input.stdout ?? ''
    const stderrText = input.stderr ?? ''
    const combinedText =
      stderrText.length === 0
        ? stdoutText
        : stdoutText.length === 0
          ? stderrText
          : `${stdoutText}${stdoutText.endsWith('\n') ? '' : '\n'}--- STDERR ---\n${stderrText}`

    const stdoutPath = path.join(this.spillsDir, `${id}.stdout.txt`)
    const stderrPath = path.join(this.spillsDir, `${id}.stderr.txt`)
    const combinedPath = path.join(this.spillsDir, `${id}.combined.txt`)
    const metaPath = path.join(this.spillsDir, `${id}.meta.json`)

    const stdoutBytes = Buffer.byteLength(stdoutText, 'utf-8')
    const stderrBytes = Buffer.byteLength(stderrText, 'utf-8')
    const totalBytes = stdoutBytes + stderrBytes
    const createdAt = Date.now()

    const rawSessionId =
      typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
        ? input.sessionId.trim()
        : typeof input.meta?.sessionId === 'string' && input.meta.sessionId.trim().length > 0
          ? input.meta.sessionId.trim()
          : undefined

    const meta: Record<string, unknown> = {
      ...(input.meta || {}),
      ...(rawSessionId ? { sessionId: rawSessionId } : {}),
      id,
      refId,
      createdAt,
      stdoutBytes,
      stderrBytes,
      totalBytes,
    }

    writeFileSync(stdoutPath, stdoutText, { encoding: 'utf-8', mode: 0o600 })
    if (stderrBytes > 0) {
      writeFileSync(stderrPath, stderrText, { encoding: 'utf-8', mode: 0o600 })
      if (stdoutBytes > 0) {
        writeFileSync(combinedPath, combinedText, { encoding: 'utf-8', mode: 0o600 })
      }
    }
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    })

    if (this.index !== null) {
      const tool =
        typeof meta.tool === 'string' && meta.tool.trim().length > 0
          ? meta.tool.trim()
          : typeof meta.jobId === 'string'
            ? 'pulse_job'
            : typeof meta.execId === 'string' || typeof meta.shell === 'string'
              ? 'pulse_exec'
              : 'pulse_result'
      const description =
        typeof meta.description === 'string' && meta.description.trim().length > 0
          ? meta.description.trim()
          : refId
      this.index.set(id, {
        refId,
        tool,
        description,
        totalBytes,
        stdoutBytes,
        stderrBytes,
        createdAt,
        ...(rawSessionId ? { sessionId: rawSessionId } : {}),
      })
    }

    const ledgerEntry: SpillLedgerEntry = {
      id,
      refId,
      createdAt,
      stdoutBytes,
      stderrBytes,
      totalBytes,
      tool: typeof meta.tool === 'string' ? meta.tool : undefined,
      description: typeof meta.description === 'string' ? meta.description : undefined,
      shell: typeof meta.shell === 'string' ? meta.shell : undefined,
      sessionId: rawSessionId,
    }
    this.appendLedger(ledgerEntry)

    this.writesSinceGc++
    if (this.writesSinceGc >= 16) {
      this.writesSinceGc = 0
      try {
        this.gc()
      } catch {
        // Non-fatal background maintenance.
      }
    }

    const spillPath =
      stderrBytes === 0 ? stdoutPath : stdoutBytes === 0 ? stderrPath : combinedPath
    this.emit('change')
    return { id, refId, spillPath, stdoutPath, stderrPath, totalBytes }
  }

  pageResult(req: ResultPageRequest): ResultPageResponse {
    const id = parseSpillId(req.refId)
    const refId = `${REF_PREFIX}${id}`
    const stream = req.stream ?? 'combined'
    const stdoutPath = path.join(this.spillsDir, `${id}.stdout.txt`)
    const stderrPath = path.join(this.spillsDir, `${id}.stderr.txt`)
    const combinedPath = path.join(this.spillsDir, `${id}.combined.txt`)
    const metaPath = path.join(this.spillsDir, `${id}.meta.json`)

    let targetPath: string | null = null
    if (stream === 'stdout') {
      targetPath = existsSync(stdoutPath) ? stdoutPath : null
    } else if (stream === 'stderr') {
      targetPath = existsSync(stderrPath) ? stderrPath : null
    } else {
      targetPath = existsSync(combinedPath)
        ? combinedPath
        : existsSync(stdoutPath)
          ? stdoutPath
          : existsSync(stderrPath)
            ? stderrPath
            : null
    }

    const spillExists =
      targetPath !== null || existsSync(metaPath) || existsSync(stdoutPath) || existsSync(stderrPath)
    if (!spillExists) {
      throw new Error(`Spill reference "${refId}" was not found or has already been released.`)
    }

    const rawText = targetPath ? readFileSync(targetPath, 'utf-8') : ''
    const totalBytes = Buffer.byteLength(rawText, 'utf-8')
    let meta: Record<string, unknown> = { stream }
    if (existsSync(metaPath)) {
      try {
        meta = { ...(JSON.parse(readFileSync(metaPath, 'utf-8')) as Record<string, unknown>), stream }
      } catch {
        // Ignore malformed metadata file.
      }
    }

    const rawLines = rawText.length === 0 ? [] : rawText.split(/\r?\n/)
    // Drop trailing empty element from a final newline so line counts match editor lines.
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
      rawLines.pop()
    }

    const indexedLines: Array<{ lineNumber: number; text: string }> = rawLines.map((text, idx) => ({
      lineNumber: idx + 1,
      text,
    }))

    const search = typeof req.search === 'string' && req.search.length > 0 ? req.search : undefined
    const lineMatcher = search ? buildLineMatcher(search, Boolean(req.caseInsensitive)) : null
    const filtered = lineMatcher
      ? indexedLines.filter((item) => lineMatcher(item.text))
      : indexedLines

    if (search) {
      meta.search = search
      meta.caseInsensitive = Boolean(req.caseInsensitive)
      meta.matchedLines = filtered.length
    }

    const totalLines = filtered.length
    const offset = Math.max(1, Math.floor(req.offset ?? 1))
    const limit = Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(req.limit ?? DEFAULT_PAGE_LIMIT)))
    const maxBytes = Math.max(
      256,
      Math.min(MAX_PAGE_MAX_BYTES, Math.floor(req.maxBytes ?? DEFAULT_PAGE_MAX_BYTES)),
    )

    const startIdx = offset - 1
    const outputLines: string[] = []
    let bytesUsed = 0
    let cursor = startIdx

    while (cursor < totalLines && outputLines.length < limit) {
      const entry = filtered[cursor]
      const formatted = `${entry.lineNumber}: ${entry.text}`
      const lineBytes = Buffer.byteLength(formatted, 'utf-8') + (outputLines.length > 0 ? 1 : 0)

      if (bytesUsed + lineBytes > maxBytes) {
        if (outputLines.length === 0) {
          // Ensure at least one partial line is returned even if a single line exceeds maxBytes.
          const clipNotice = '...[line clipped]'
          const clipBudget = Math.max(64, maxBytes - Buffer.byteLength(clipNotice, 'utf-8'))
          const clipped = sliceUtf8Safe(formatted, clipBudget)
          outputLines.push(`${clipped.text}${clipNotice}`)
          cursor++
        }
        break
      }

      outputLines.push(formatted)
      bytesUsed += lineBytes
      cursor++
    }

    const returnedLines = outputLines.length
    const complete = cursor >= totalLines
    const nextOffset = complete ? null : cursor + 1

    return {
      refId,
      totalLines,
      totalBytes,
      offset,
      returnedLines,
      nextOffset,
      complete,
      content: outputLines.join('\n'),
      meta,
    }
  }

  releaseResult(refId: string): { released: boolean; refId: string } {
    const id = parseSpillId(refId)
    const canonicalRef = `${REF_PREFIX}${id}`
    const suffixes = ['stdout.txt', 'stderr.txt', 'combined.txt', 'meta.json']
    let removedAny = false

    for (const suffix of suffixes) {
      const filePath = path.join(this.spillsDir, `${id}.${suffix}`)
      try {
        if (existsSync(filePath)) {
          unlinkSync(filePath)
          removedAny = true
        }
      } catch {
        // Best-effort delete.
      }
    }

    if (removedAny) {
      this.index?.delete(id)
      this.emit('change')
    }
    return { released: removedAny, refId: canonicalRef }
  }

  listSpills(limit = 100, sessionId?: string): SpillEntrySummary[] {
    const index = this.ensureIndex()
    if (index.size === 0) {
      return []
    }

    const filterSession =
      typeof sessionId === 'string' && sessionId.trim().length > 0 && sessionId.trim() !== 'all'
        ? sessionId.trim()
        : undefined

    const results: SpillEntrySummary[] = []
    for (const entry of index.values()) {
      if (filterSession && entry.sessionId !== filterSession) {
        continue
      }
      results.push({ ...entry })
    }

    results.sort((a, b) => b.createdAt - a.createdAt)
    return limit > 0 ? results.slice(0, limit) : results
  }

  /**
   * Releases all spill artifacts tagged with the specified sessionId so deleting
   * or GC-pruning an old conversation session leaves zero orphaned spill files on disk.
   */
  releaseBySession(sessionId: string): number {
    const target = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!target) {
      return 0
    }

    const index = this.ensureIndex()
    const idsToDelete: string[] = []
    for (const [id, entry] of index.entries()) {
      if (entry.sessionId === target && VALID_SPILL_ID_RE.test(id)) {
        idsToDelete.push(id)
      }
    }

    let released = 0
    const suffixes = ['stdout.txt', 'stderr.txt', 'combined.txt', 'meta.json']
    for (const id of idsToDelete) {
      let removedAny = false
      for (const suffix of suffixes) {
        const filePath = path.join(this.spillsDir, `${id}.${suffix}`)
        try {
          if (existsSync(filePath)) {
            unlinkSync(filePath)
            removedAny = true
          }
        } catch {
          // Best-effort delete.
        }
      }
      index.delete(id)
      if (removedAny) released++
    }

    if (released > 0) {
      this.emit('change')
    }
    return released
  }

  gc(): { removed: number; freedBytes: number } {
    if (!existsSync(this.spillsDir)) {
      return { removed: 0, freedBytes: 0 }
    }

    const cfg = this.getConfig()
    const retentionMs = Math.max(1, cfg.spillRetentionDays) * 24 * 60 * 60 * 1000
    const maxTotalBytes = Math.max(16, cfg.spillMaxTotalMb) * 1024 * 1024
    const cutoff = Date.now() - retentionMs

    const entries = readdirSync(this.spillsDir)
    const groups = new Map<string, { id: string; files: string[]; totalBytes: number; mtimeMs: number }>()

    for (const fileName of entries) {
      const dotIdx = fileName.indexOf('.')
      if (dotIdx <= 0) continue
      const id = fileName.slice(0, dotIdx)
      const fullPath = path.join(this.spillsDir, fileName)
      try {
        const st = statSync(fullPath)
        if (!st.isFile()) continue
        let grp = groups.get(id)
        if (!grp) {
          grp = { id, files: [], totalBytes: 0, mtimeMs: st.mtimeMs }
          groups.set(id, grp)
        }
        grp.files.push(fullPath)
        grp.totalBytes += st.size
        if (st.mtimeMs < grp.mtimeMs) grp.mtimeMs = st.mtimeMs
      } catch {
        // Skip disappearing files.
      }
    }

    const sorted = [...groups.values()].sort((a, b) => a.mtimeMs - b.mtimeMs)
    let totalBytes = sorted.reduce((acc, g) => acc + g.totalBytes, 0)
    let removed = 0
    let freedBytes = 0

    for (const grp of sorted) {
      const expired = grp.mtimeMs < cutoff
      const overQuota = totalBytes > maxTotalBytes
      if (!expired && !overQuota) continue

      for (const f of grp.files) {
        try {
          unlinkSync(f)
        } catch {
          // Ignore individual unlink failures.
        }
      }
      totalBytes -= grp.totalBytes
      freedBytes += grp.totalBytes
      this.index?.delete(grp.id)
      removed++
    }

    return { removed, freedBytes }
  }

  private appendLedger(entry: SpillLedgerEntry): void {
    try {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
      appendFileSync(this.ledgerPath, `${JSON.stringify(entry)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
      })

      const st = statSync(this.ledgerPath)
      if (st.size > MAX_LEDGER_ENTRIES * 220) {
        const lines = readFileSync(this.ledgerPath, 'utf-8')
          .split(/\r?\n/)
          .filter(Boolean)
        if (lines.length > MAX_LEDGER_ENTRIES) {
          const trimmed = `${lines.slice(-MAX_LEDGER_ENTRIES).join('\n')}\n`
          writeFileSync(this.ledgerPath, trimmed, { encoding: 'utf-8', mode: 0o600 })
        }
      }
    } catch {
      // Ledger maintenance is best-effort.
    }
  }
}
