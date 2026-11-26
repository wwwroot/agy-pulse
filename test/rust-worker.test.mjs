import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { RustWorker } from '../src/server/rust-worker.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const IS_WIN = process.platform === 'win32'
const DIST_WORKER_BIN = join(
  ROOT,
  'sidecars',
  'pulse',
  'dist',
  IS_WIN ? 'agy-pulse-worker.exe' : 'agy-pulse-worker',
)

let activeWorkerBin = DIST_WORKER_BIN

function invokeWorker(payload, timeoutMs = 15_000) {
  return new Promise((resolveInvoke, rejectInvoke) => {
    const child = spawn(activeWorkerBin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Ignore kill failure.
      }
      rejectInvoke(new Error(`Worker timed out after ${timeoutMs}ms for op=${payload.op}`))
    }, timeoutMs)

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
      rejectInvoke(err)
    })

    child.once('close', (code) => {
      clearTimeout(timer)
      const trimmed = stdout.trim()
      if (!trimmed) {
        rejectInvoke(new Error(`Worker returned empty stdout (exit=${code}): ${stderr}`))
        return
      }
      try {
        resolveInvoke({ code, stderr, response: JSON.parse(trimmed) })
      } catch (err) {
        rejectInvoke(new Error(`Invalid worker JSON (${err.message}): ${trimmed.slice(0, 300)}`))
      }
    })

    child.stdin.end(JSON.stringify(payload))
  })
}

// Minimal CRC-32 + uncompressed ZIP builder (store method 0) for DOCX tests.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function buildMinimalZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    const crc = crc32(dataBuf)

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4) // version needed
    localHeader.writeUInt16LE(0, 6) // flags
    localHeader.writeUInt16LE(0, 8) // method: store
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(dataBuf.length, 18)
    localHeader.writeUInt32LE(dataBuf.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28)

    localParts.push(localHeader, nameBuf, dataBuf)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(dataBuf.length, 20)
    centralHeader.writeUInt32LE(dataBuf.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)

    centralParts.push(centralHeader, nameBuf)
    offset += localHeader.length + nameBuf.length + dataBuf.length
  }

  const centralDir = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDir, eocd])
}

// Minimal valid 2-page PDF 1.4 generator for lopdf tests.
function buildMinimalPdf(pageTexts) {
  const objects = []
  const pageIds = []

  // Object 1: Catalog, Object 2: Pages, Object 3: Font
  objects.push(null) // placeholder for 1
  objects.push(null) // placeholder for 2
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  for (const text of pageTexts) {
    const escaped = text.replace(/([()\\])/g, '\\$1')
    const streamBody = `BT\n/F1 12 Tf\n50 720 Td\n(${escaped}) Tj\nET\n`
    const contentId = objects.length + 1
    objects.push(
      `<< /Length ${Buffer.byteLength(streamBody, 'ascii')} >>\nstream\n${streamBody}endstream`,
    )
    const pageId = objects.length + 1
    pageIds.push(pageId)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    )
  }

  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`

  const chunks = ['%PDF-1.4\n']
  const offsets = [0]
  let bytePos = Buffer.byteLength(chunks[0], 'ascii')

  for (let i = 0; i < objects.length; i++) {
    offsets.push(bytePos)
    const objStr = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
    chunks.push(objStr)
    bytePos += Buffer.byteLength(objStr, 'ascii')
  }

  const xrefOffset = bytePos
  chunks.push(`xref\n0 ${objects.length + 1}\n`)
  chunks.push('0000000000 65535 f \n')
  for (let i = 1; i <= objects.length; i++) {
    chunks.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
  }
  chunks.push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  )
  return Buffer.from(chunks.join(''), 'ascii')
}

describe('Native Rust Ops Worker (sidecars/pulse/dist/agy-pulse-worker)', () => {
  let wsDir
  let outsideDir
  let binCopyDir

  before(() => {
    assert.equal(
      existsSync(DIST_WORKER_BIN),
      true,
      `Missing compiled Rust worker binary at ${DIST_WORKER_BIN}`,
    )
    wsDir = mkdtempSync(join(tmpdir(), 'agy-pulse-worker-ws-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'agy-pulse-worker-out-'))
    if (IS_WIN) {
      // Copy dist binary into Medium-integrity %TEMP% so tests work even when the repo sits under a Low-ACL folder.
      binCopyDir = mkdtempSync(join(tmpdir(), 'agy-pulse-worker-bin-'))
      activeWorkerBin = join(binCopyDir, 'agy-pulse-worker.exe')
      copyFileSync(DIST_WORKER_BIN, activeWorkerBin)
    } else {
      activeWorkerBin = DIST_WORKER_BIN
    }

    mkdirSync(join(wsDir, 'src'), { recursive: true })
    mkdirSync(join(wsDir, 'docs'), { recursive: true })
    mkdirSync(join(wsDir, 'batch'), { recursive: true })
    mkdirSync(join(wsDir, 'outline-fixtures'), { recursive: true })

    writeFileSync(
      join(wsDir, 'src', 'engine.ts'),
      [
        'export interface EngineConfig {',
        '  timeoutMs: number',
        '}',
        '',
        'export class TokenEngine {',
        '  run(cfg: EngineConfig): number {',
        '    return computeSavings(cfg.timeoutMs)',
        '  }',
        '}',
        '',
        'export function computeSavings(raw: number): number {',
        '  return raw * 2',
        '}',
        '',
        'const sample = computeSavings(42)',
        'const again = computeSavings(sample)',
        'console.log(again)',
        '',
      ].join('\n'),
      'utf8',
    )

    writeFileSync(
      join(wsDir, 'src', 'consumer.ts'),
      [
        'import { computeSavings, TokenEngine } from "./engine"',
        'const eng = new TokenEngine()',
        'const a = computeSavings(10)',
        'const b = computeSavings(20)',
        'export const total = a + b + eng.run({ timeoutMs: 5 })',
        '',
      ].join('\n'),
      'utf8',
    )

    // Rich TypeScript fixture for v0.3.0 outline & symbol extraction tests
    const tsLongBody = Array.from(
      { length: 28 },
      (_, idx) => `    const step_${idx} = input.length + ${idx} * 3 // detailed business logic line ${idx}`,
    ).join('\n')
    writeFileSync(
      join(wsDir, 'outline-fixtures', 'rich-service.ts'),
      [
        'import { readFileSync } from "node:fs"',
        'import path from "node:path"',
        'import type { EngineConfig } from "./engine"',
        '',
        'export interface MetricRecord {',
        '  key: string',
        '  bytes: number',
        '}',
        '',
        '/** Manages token savings metrics and report formatting. */',
        'export class MetricsService {',
        '  private readonly records: MetricRecord[] = []',
        '',
        '  /** Adds a new measurement entry and returns total accumulated bytes. */',
        '  recordSample(input: string, cfg: EngineConfig): number {',
        tsLongBody,
        '    const total = step_0 + step_27 + cfg.timeoutMs',
        '    this.records.push({ key: path.basename(input), bytes: total })',
        '    return total',
        '  }',
        '',
        '  /** Computes the final summary count. */',
        '  summarize(): number {',
        '    return this.records.reduce((acc, item) => acc + item.bytes, 0)',
        '  }',
        '}',
        '',
        '/** Standalone helper that loads and validates a UTF-8 file header. */',
        'export function loadHeaderPreview(filePath: string): string {',
        '  const raw = readFileSync(filePath, "utf8")',
        '  return raw.slice(0, 128)',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )

    // Rich Rust fixture for v0.3.0 outline & symbol extraction tests
    const rustLongBody = Array.from(
      { length: 24 },
      (_, idx) => `        let acc_${idx} = seed.wrapping_add(${idx}usize) * 2; // computation step ${idx}`,
    ).join('\n')
    writeFileSync(
      join(wsDir, 'outline-fixtures', 'rich_worker.rs'),
      [
        'use std::collections::HashMap;',
        'use std::path::PathBuf;',
        '',
        '/// Core worker configuration struct.',
        'pub struct WorkerRunner {',
        '    pub root: PathBuf,',
        '    pub cache: HashMap<String, usize>,',
        '}',
        '',
        'impl WorkerRunner {',
        '    /// Executes a deterministic hashing pipeline for the requested seed.',
        '    pub fn execute_batch(&mut self, key: &str, seed: usize) -> usize {',
        rustLongBody,
        '        let total = acc_0 + acc_23;',
        '        self.cache.insert(key.to_string(), total);',
        '        total',
        '    }',
        '',
        '    /// Returns the number of cached entries.',
        '    pub fn cached_len(&self) -> usize {',
        '        self.cache.len()',
        '    }',
        '}',
        '',
        '/// Free helper function for clamping limits.',
        'pub fn clamp_limit(value: usize, max_val: usize) -> usize {',
        '    value.min(max_val).max(1)',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )

    writeFileSync(
      join(wsDir, 'src', 'escape.txt'),
      'line1\twith\ttab\nline2\\backslash\n',
      'utf8',
    )

    // Invalid UTF-8 binary file
    writeFileSync(join(wsDir, 'src', 'binary.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]))

    // Credential fence fixtures
    writeFileSync(join(wsDir, '.env'), 'SECRET_TOKEN=super_secret_123\n', 'utf8')
    writeFileSync(join(wsDir, '.env.example'), 'SECRET_TOKEN=replace_me\n', 'utf8')
    writeFileSync(join(outsideDir, 'outside.txt'), 'OUTSIDE_WORKSPACE_SECRET\n', 'utf8')
  })

  after(() => {
    rmSync(wsDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
    if (binCopyDir) rmSync(binCopyDir, { recursive: true, force: true })
  })

  it('supports read_files batch, hex view, binary ERR_INVALID_ENCODING, statOnly, and stat', async () => {
    const { response } = await invokeWorker({
      op: 'read_files',
      roots: [wsDir],
      args: {
        files: [
          { path: 'src/engine.ts', offset: 1, limit: 10 },
          { path: 'src/escape.txt', offset: 1, limit: 5 },
          { path: 'src/binary.bin', offset: 0, limit: 16, view: 'hex' },
          { path: 'src/binary.bin', offset: 1, limit: 10, view: 'text' },
          { path: '.env.example', offset: 1, limit: 5 },
        ],
      },
    })

    assert.equal(response.ok, true)
    assert.equal(response.result.items.length, 5)
    assert.ok(response.result.rawBytes > 0)

    const [engineItem, escapeItem, hexItem, binErrItem, envExampleItem] = response.result.items
    assert.equal(engineItem.exists, true)
    assert.match(engineItem.revision, /^[0-9a-f]{64}$/)
    assert.equal(engineItem.returnedLines, 10)
    assert.equal(engineItem.eof, false)
    assert.equal(engineItem.nextOffset, 11)
    assert.match(engineItem.content, /export interface EngineConfig/)

    assert.equal(escapeItem.escaped, true)
    assert.match(escapeItem.content, /\\t/)

    assert.equal(hexItem.view, 'hex')
    assert.match(hexItem.content, /89 50 4e 47/i)

    assert.ok(binErrItem.error)
    assert.equal(binErrItem.error.code, 'ERR_INVALID_ENCODING')
    assert.equal(binErrItem.error.effectState, 'none')

    assert.equal(envExampleItem.exists, true)
    assert.match(envExampleItem.content, /SECRET_TOKEN=replace_me/)

    // statOnly mode
    const statOnlyRes = await invokeWorker({
      op: 'read_files',
      roots: [wsDir],
      args: {
        files: [{ path: 'src/engine.ts' }],
        statOnly: true,
      },
    })
    assert.equal(statOnlyRes.response.ok, true)
    assert.equal(statOnlyRes.response.result.items[0].view, 'stat')
    assert.equal(statOnlyRes.response.result.items[0].content, '')
    assert.equal(statOnlyRes.response.result.items[0].revision, engineItem.revision)

    // Direct stat op (existing + absent)
    const statExisting = await invokeWorker({
      op: 'stat',
      roots: [wsDir],
      args: { path: 'src/engine.ts' },
    })
    assert.equal(statExisting.response.ok, true)
    assert.equal(statExisting.response.result.exists, true)
    assert.equal(statExisting.response.result.isDir, false)
    assert.equal(statExisting.response.result.revision, engineItem.revision)

    const statAbsent = await invokeWorker({
      op: 'stat',
      roots: [wsDir],
      args: { path: 'src/does-not-exist.ts' },
    })
    assert.equal(statAbsent.response.ok, true)
    assert.equal(statAbsent.response.result.exists, false)
  })

  it('supports glob with !exclude negation and grep across all 5 modes including definitions', async () => {
    const globRes = await invokeWorker({
      op: 'glob',
      roots: [wsDir],
      args: {
        pattern: ['src/**/*', '!src/*.bin', '!src/*.txt'],
        kind: 'file',
        sort: 'path',
      },
    })
    assert.equal(globRes.response.ok, true)
    const paths = globRes.response.result.entries.map((e) => e.path)
    assert.equal(paths.length, 2)
    assert.ok(paths.some((p) => p.endsWith('engine.ts')))
    assert.ok(paths.some((p) => p.endsWith('consumer.ts')))
    assert.ok(!paths.some((p) => p.endsWith('binary.bin')))

    // 1. summary
    const summary = await invokeWorker({
      op: 'grep',
      roots: [wsDir],
      args: { pattern: 'computeSavings', glob: ['src/**/*.ts'], outputMode: 'summary' },
    })
    assert.equal(summary.response.ok, true)
    assert.equal(summary.response.result.outputMode, 'summary')
    assert.ok(summary.response.result.totalMatched >= 6)
    assert.equal(summary.response.result.totalFilesMatched, 2)
    assert.equal(summary.response.result.entries.length, 0)

    // 2. count
    const count = await invokeWorker({
      op: 'grep',
      roots: [wsDir],
      args: { pattern: 'computeSavings', glob: ['src/**/*.ts'], outputMode: 'count' },
    })
    assert.equal(count.response.ok, true)
    assert.equal(count.response.result.entries.length, 2)
    assert.ok(count.response.result.entries.every((e) => typeof e.count === 'number' && e.count > 0))

    // 3. files_with_matches
    const filesMode = await invokeWorker({
      op: 'grep',
      roots: [wsDir],
      args: { pattern: 'computeSavings', glob: ['src/**/*.ts'], outputMode: 'files_with_matches' },
    })
    assert.equal(filesMode.response.ok, true)
    assert.equal(filesMode.response.result.entries.length, 2)

    // 4. definitions (declaration headers only + impliedReferences)
    const defs = await invokeWorker({
      op: 'grep',
      roots: [wsDir],
      args: { pattern: 'computeSavings', glob: ['src/**/*.ts'], outputMode: 'definitions' },
    })
    assert.equal(defs.response.ok, true)
    assert.equal(defs.response.result.definitionMatches, 1)
    assert.ok(defs.response.result.impliedReferences >= 5)
    assert.equal(defs.response.result.entries.length, 1)
    assert.equal(defs.response.result.entries[0].declKind, 'function')
    assert.match(defs.response.result.entries[0].text, /export function computeSavings/)

    // 5. content with context
    const content = await invokeWorker({
      op: 'grep',
      roots: [wsDir],
      args: {
        pattern: 'export class TokenEngine',
        glob: ['src/**/*.ts'],
        outputMode: 'content',
        beforeContext: 1,
        afterContext: 1,
      },
    })
    assert.equal(content.response.ok, true)
    assert.equal(content.response.result.entries.length, 1)
    assert.equal(content.response.result.entries[0].line, 5)
    assert.ok(Array.isArray(content.response.result.entries[0].after))
  })

  it('supports diff, CAS write/edit with REVISION_MISMATCH, multi-file replace, and preflighted batch', async () => {
    // CAS write create (expectedRevision: "absent")
    const createRes = await invokeWorker({
      op: 'write',
      roots: [wsDir],
      args: {
        path: 'src/mutate-target.ts',
        expectedRevision: 'absent',
        content: 'export const alpha = 1\nexport const beta = 2\n',
      },
    })
    assert.equal(createRes.response.ok, true)
    const rev1 = createRes.response.result.afterRevision
    assert.match(rev1, /^[0-9a-f]{64}$/)

    // Diff without modifying disk
    const diffRes = await invokeWorker({
      op: 'diff',
      roots: [wsDir],
      args: {
        path: 'src/mutate-target.ts',
        content: 'export const alpha = 10\nexport const beta = 2\n',
      },
    })
    assert.equal(diffRes.response.ok, true)
    assert.equal(diffRes.response.result.addedLines, 1)
    assert.equal(diffRes.response.result.removedLines, 1)
    assert.match(diffRes.response.result.diff, /\+export const alpha = 10/)

    // CAS edit with valid revision
    const editRes = await invokeWorker({
      op: 'edit',
      roots: [wsDir],
      args: {
        path: 'src/mutate-target.ts',
        expectedRevision: rev1,
        edits: [
          { oldText: 'alpha = 1', newText: 'alpha = 100' },
          { oldText: 'beta = 2', newText: 'beta = 200' },
        ],
      },
    })
    assert.equal(editRes.response.ok, true)
    const rev2 = editRes.response.result.afterRevision
    assert.notEqual(rev2, rev1)

    // Stale revision must fail with REVISION_MISMATCH and effectState: "none"
    const staleEdit = await invokeWorker({
      op: 'edit',
      roots: [wsDir],
      args: {
        path: 'src/mutate-target.ts',
        expectedRevision: rev1,
        edits: [{ oldText: 'alpha = 100', newText: 'alpha = 999' }],
      },
    })
    assert.equal(staleEdit.response.ok, false)
    assert.equal(staleEdit.response.error.code, 'REVISION_MISMATCH')
    assert.equal(staleEdit.response.error.effectState, 'none')
    assert.match(readFileSync(join(wsDir, 'src', 'mutate-target.ts'), 'utf8'), /alpha = 100/)

    // Multi-file replace
    writeFileSync(join(wsDir, 'batch', 'r1.txt'), 'OLD_TOKEN_A and OLD_TOKEN_A\n', 'utf8')
    writeFileSync(join(wsDir, 'batch', 'r2.txt'), 'prefix OLD_TOKEN_A suffix\n', 'utf8')
    const replaceRes = await invokeWorker({
      op: 'replace',
      roots: [wsDir],
      args: {
        path: 'batch',
        pattern: 'OLD_TOKEN_A',
        replacement: 'NEW_TOKEN_B',
        glob: ['*.txt'],
      },
    })
    assert.equal(replaceRes.response.ok, true)
    assert.equal(replaceRes.response.result.filesChanged, 2)
    assert.equal(replaceRes.response.result.totalReplacements, 3)
    assert.match(readFileSync(join(wsDir, 'batch', 'r1.txt'), 'utf8'), /NEW_TOKEN_B and NEW_TOKEN_B/)

    // Preflighted batch: reject no-clobber & directory cycle with zero side effects
    mkdirSync(join(wsDir, 'batch', 'dirA'), { recursive: true })
    writeFileSync(join(wsDir, 'batch', 'src.txt'), 'SOURCE_DATA\n', 'utf8')
    writeFileSync(join(wsDir, 'batch', 'existing.txt'), 'EXISTING_DATA\n', 'utf8')

    const noClobber = await invokeWorker({
      op: 'batch',
      roots: [wsDir],
      args: {
        operations: [
          { op: 'copy', path: 'batch/src.txt', to: 'batch/copied-should-not-exist.txt' },
          { op: 'move', path: 'batch/src.txt', to: 'batch/existing.txt' },
        ],
      },
    })
    assert.equal(noClobber.response.ok, false)
    assert.equal(noClobber.response.error.effectState, 'none')
    assert.equal(existsSync(join(wsDir, 'batch', 'copied-should-not-exist.txt')), false)

    const cycleReject = await invokeWorker({
      op: 'batch',
      roots: [wsDir],
      args: {
        operations: [{ op: 'move', path: 'batch/dirA', to: 'batch/dirA/nested' }],
      },
    })
    assert.equal(cycleReject.response.ok, false)
    assert.equal(cycleReject.response.error.effectState, 'none')

    // Valid batch copy + move + remove
    const validBatch = await invokeWorker({
      op: 'batch',
      roots: [wsDir],
      args: {
        operations: [
          { op: 'copy', path: 'batch/src.txt', to: 'batch/src-copy.txt' },
          { op: 'move', path: 'batch/existing.txt', to: 'batch/existing-moved.txt' },
          { op: 'remove', path: 'batch/r2.txt' },
        ],
      },
    })
    assert.equal(validBatch.response.ok, true)
    assert.equal(validBatch.response.result.batchResults.length, 3)
    assert.equal(existsSync(join(wsDir, 'batch', 'src-copy.txt')), true)
    assert.equal(existsSync(join(wsDir, 'batch', 'existing-moved.txt')), true)
    assert.equal(existsSync(join(wsDir, 'batch', 'r2.txt')), false)
  })

  it('supports read_doc for CSV, DOCX, macro DOCX rejection, and PDF paging', async () => {
    // 1. CSV
    writeFileSync(
      join(wsDir, 'docs', 'metrics.csv'),
      'metric,before,after\ntokens,12000,1400\nlatency_ms,420,18\nround_trips,6,1\n',
      'utf8',
    )
    const csvRes = await invokeWorker({
      op: 'read_doc',
      roots: [wsDir],
      args: { path: 'docs/metrics.csv', format: 'auto', header: true, offset: 1, limit: 2 },
    })
    assert.equal(csvRes.response.ok, true)
    assert.equal(csvRes.response.result.format, 'table')
    assert.deepEqual(csvRes.response.result.columns, ['metric', 'before', 'after'])
    assert.equal(csvRes.response.result.totalUnits, 3)
    assert.equal(csvRes.response.result.returnedUnits, 2)
    assert.equal(csvRes.response.result.nextOffset, 3)
    assert.match(csvRes.response.result.content, /tokens/)

    // 2. Valid DOCX
    const docxXml = [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
      '<w:body>',
      '<w:p><w:r><w:t>Antigravity Native Ops Report</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Second paragraph with token benchmarks.</w:t></w:r></w:p>',
      '</w:body></w:document>',
    ].join('')
    writeFileSync(
      join(wsDir, 'docs', 'spec.docx'),
      buildMinimalZip([{ name: 'word/document.xml', data: docxXml }]),
    )
    const docxRes = await invokeWorker({
      op: 'read_doc',
      roots: [wsDir],
      args: { path: 'docs/spec.docx', format: 'docx' },
    })
    assert.equal(docxRes.response.ok, true)
    assert.equal(docxRes.response.result.format, 'docx')
    assert.equal(docxRes.response.result.totalUnits, 2)
    assert.match(docxRes.response.result.content, /Antigravity Native Ops Report/)
    assert.match(docxRes.response.result.content, /Second paragraph with token benchmarks/)

    // 3. Macro-enabled DOCX rejection
    writeFileSync(
      join(wsDir, 'docs', 'macro.docx'),
      buildMinimalZip([
        { name: 'word/document.xml', data: docxXml },
        { name: 'word/vbaProject.bin', data: Buffer.from('FAKE_VBA_MACRO') },
      ]),
    )
    const macroRes = await invokeWorker({
      op: 'read_doc',
      roots: [wsDir],
      args: { path: 'docs/macro.docx', format: 'docx' },
    })
    assert.equal(macroRes.response.ok, false)
    assert.equal(macroRes.response.error.code, 'MACRO_DOCUMENT_BLOCKED')
    assert.equal(macroRes.response.error.effectState, 'none')

    // 4. PDF 2-page extraction & paging
    writeFileSync(
      join(wsDir, 'docs', 'guide.pdf'),
      buildMinimalPdf(['Hello PDF Page One', 'Second PDF Page Two']),
    )
    const pdfPage1 = await invokeWorker({
      op: 'read_doc',
      roots: [wsDir],
      args: { path: 'docs/guide.pdf', format: 'pdf', offset: 1, limit: 1 },
    })
    assert.equal(pdfPage1.response.ok, true)
    assert.equal(pdfPage1.response.result.format, 'pdf')
    assert.equal(pdfPage1.response.result.totalUnits, 2)
    assert.equal(pdfPage1.response.result.returnedUnits, 1)
    assert.equal(pdfPage1.response.result.nextOffset, 2)
    assert.match(pdfPage1.response.result.content, /--- Page 1 ---/)
    assert.match(pdfPage1.response.result.content, /Hello PDF Page One/)

    const pdfPage2 = await invokeWorker({
      op: 'read_doc',
      roots: [wsDir],
      args: { path: 'docs/guide.pdf', format: 'pdf', offset: 2, limit: 1 },
    })
    assert.equal(pdfPage2.response.ok, true)
    assert.equal(pdfPage2.response.result.complete, true)
    assert.match(pdfPage2.response.result.content, /--- Page 2 ---/)
    assert.match(pdfPage2.response.result.content, /Second PDF Page Two/)
  })

  it('enforces workspace jail and credential fence defense-in-depth', async () => {
    const jailRes = await invokeWorker({
      op: 'stat',
      roots: [wsDir],
      args: { path: join(outsideDir, 'outside.txt') },
    })
    assert.equal(jailRes.response.ok, false)
    assert.equal(jailRes.response.error.code, 'WORKDIR_OUTSIDE_WORKSPACE')
    assert.equal(jailRes.response.error.effectState, 'none')

    const fenceRead = await invokeWorker({
      op: 'read_files',
      roots: [wsDir],
      credentialFence: true,
      args: { files: [{ path: '.env' }] },
    })
    assert.equal(fenceRead.response.ok, false)
    assert.equal(fenceRead.response.error.code, 'CREDENTIAL_FENCE_BLOCKED')
    assert.equal(fenceRead.response.error.effectState, 'none')

    const fenceStat = await invokeWorker({
      op: 'stat',
      roots: [wsDir],
      credentialFence: true,
      args: { path: '.env' },
    })
    assert.equal(fenceStat.response.ok, false)
    assert.equal(fenceStat.response.error.code, 'CREDENTIAL_FENCE_BLOCKED')
    assert.equal(fenceStat.response.error.effectState, 'none')
  })

  it('supports v0.3.0 view: "outline" for TypeScript and Rust with fullFileBytes, [imports: ...], accurate Lstart-Lend ranges, and massive byte reduction', async () => {
    const tsRawBytes = Buffer.byteLength(
      readFileSync(join(wsDir, 'outline-fixtures', 'rich-service.ts'), 'utf8'),
      'utf8',
    )
    const rsRawBytes = Buffer.byteLength(
      readFileSync(join(wsDir, 'outline-fixtures', 'rich_worker.rs'), 'utf8'),
      'utf8',
    )

    const { response } = await invokeWorker({
      op: 'read_files',
      roots: [wsDir],
      args: {
        files: [
          { path: 'outline-fixtures/rich-service.ts', view: 'outline' },
          { path: 'outline-fixtures/rich_worker.rs', view: 'outline' },
        ],
      },
    })

    assert.equal(response.ok, true)
    assert.equal(response.result.items.length, 2)

    const [tsOutline, rsOutline] = response.result.items

    // TypeScript outline checks
    assert.equal(tsOutline.view, 'outline')
    assert.equal(tsOutline.exists, true)
    assert.equal(tsOutline.error, undefined)
    assert.equal(tsOutline.fullFileBytes, tsRawBytes)
    assert.match(tsOutline.content, /\[imports: L1-L3 \(3 lines\)\]/)
    assert.match(tsOutline.content, /L5-L8 \| export interface MetricRecord/)
    assert.match(tsOutline.content, /L11-L53 \| export class MetricsService/)
    assert.match(tsOutline.content, /  L15-L47 \| recordSample\(/)
    assert.match(tsOutline.content, /  L50-L52 \| summarize\(/)
    assert.match(tsOutline.content, /L56-L59 \| export function loadHeaderPreview/)

    const tsOutlineBytes = Buffer.byteLength(tsOutline.content, 'utf8')
    assert.ok(
      tsOutlineBytes < tsRawBytes * 0.35,
      `Expected massive TS outline byte reduction: outline=${tsOutlineBytes}B vs full=${tsRawBytes}B`,
    )

    // Rust outline checks
    assert.equal(rsOutline.view, 'outline')
    assert.equal(rsOutline.exists, true)
    assert.equal(rsOutline.error, undefined)
    assert.equal(rsOutline.fullFileBytes, rsRawBytes)
    assert.match(rsOutline.content, /\[imports: L1-L2 \(2 lines\)\]/)
    assert.match(rsOutline.content, /L5-L8 \| pub struct WorkerRunner/)
    assert.match(rsOutline.content, /L10-L46 \| impl WorkerRunner/)
    assert.match(rsOutline.content, /  L12-L40 \| pub fn execute_batch/)
    assert.match(rsOutline.content, /  L43-L45 \| pub fn cached_len/)
    assert.match(rsOutline.content, /L49-L51 \| pub fn clamp_limit/)

    const rsOutlineBytes = Buffer.byteLength(rsOutline.content, 'utf8')
    assert.ok(
      rsOutlineBytes < rsRawBytes * 0.35,
      `Expected massive Rust outline byte reduction: outline=${rsOutlineBytes}B vs full=${rsRawBytes}B`,
    )
  })

  it('supports v0.3.0 symbol targeted reads (qualified, bare, doc comments) and SYMBOL_NOT_FOUND with suggestions', async () => {
    const tsRawBytes = Buffer.byteLength(
      readFileSync(join(wsDir, 'outline-fixtures', 'rich-service.ts'), 'utf8'),
      'utf8',
    )
    const rsRawBytes = Buffer.byteLength(
      readFileSync(join(wsDir, 'outline-fixtures', 'rich_worker.rs'), 'utf8'),
      'utf8',
    )

    const { response } = await invokeWorker({
      op: 'read_files',
      roots: [wsDir],
      args: {
        files: [
          { path: 'outline-fixtures/rich-service.ts', symbol: 'MetricsService.summarize' },
          { path: 'outline-fixtures/rich-service.ts', symbol: 'loadHeaderPreview' },
          { path: 'outline-fixtures/rich_worker.rs', symbol: 'WorkerRunner::cached_len' },
          { path: 'outline-fixtures/rich_worker.rs', symbol: 'clamp_limit' },
          { path: 'outline-fixtures/rich-service.ts', symbol: 'NonExistentSymbolName' },
        ],
      },
    })

    assert.equal(response.ok, true)
    assert.equal(response.result.items.length, 5)

    const [tsQualified, tsBare, rsQualified, rsBare, missing] = response.result.items

    // 1. Qualified TS Class.method including JSDoc comment
    assert.equal(tsQualified.view, 'symbol')
    assert.equal(tsQualified.symbol, 'MetricsService.summarize')
    assert.equal(tsQualified.fullFileBytes, tsRawBytes)
    assert.equal(tsQualified.error, undefined)
    assert.match(tsQualified.content, /Computes the final summary count/)
    assert.match(tsQualified.content, /summarize\(\): number/)
    assert.ok(Buffer.byteLength(tsQualified.content, 'utf8') < tsRawBytes * 0.25)

    // 2. Bare TS function including JSDoc comment
    assert.equal(tsBare.view, 'symbol')
    assert.equal(tsBare.symbol, 'loadHeaderPreview')
    assert.equal(tsBare.fullFileBytes, tsRawBytes)
    assert.match(tsBare.content, /Standalone helper that loads and validates/)
    assert.match(tsBare.content, /export function loadHeaderPreview/)

    // 3. Qualified Rust Container::method including /// doc comment
    assert.equal(rsQualified.view, 'symbol')
    assert.equal(rsQualified.symbol, 'WorkerRunner::cached_len')
    assert.equal(rsQualified.fullFileBytes, rsRawBytes)
    assert.equal(rsQualified.error, undefined)
    assert.match(rsQualified.content, /Returns the number of cached entries/)
    assert.match(rsQualified.content, /pub fn cached_len/)
    assert.ok(Buffer.byteLength(rsQualified.content, 'utf8') < rsRawBytes * 0.25)

    // 4. Bare Rust function including /// doc comment
    assert.equal(rsBare.view, 'symbol')
    assert.equal(rsBare.symbol, 'clamp_limit')
    assert.equal(rsBare.fullFileBytes, rsRawBytes)
    assert.match(rsBare.content, /Free helper function for clamping limits/)
    assert.match(rsBare.content, /pub fn clamp_limit/)

    // 5. Missing symbol returns SYMBOL_NOT_FOUND with effectState="none" and suggested symbols
    assert.equal(missing.view, 'symbol')
    assert.equal(missing.symbol, 'NonExistentSymbolName')
    assert.ok(missing.error)
    assert.equal(missing.error.code, 'SYMBOL_NOT_FOUND')
    assert.equal(missing.error.effectState, 'none')
    assert.match(missing.error.message, /Available symbols/)
    assert.match(missing.error.message, /MetricsService\.summarize/)
    assert.match(missing.error.message, /loadHeaderPreview/)
  })

  it('v0.4.0: grep definitions matches keyword-prefixed Rust patterns (fn ) and classifies pub const fn as function', async () => {
    writeFileSync(
      join(wsDir, 'outline-fixtures', 'rust_defs.rs'),
      [
        'pub const MAX_LIMIT: usize = 64;',
        'fn internal_helper() -> u32 { 1 }',
        'pub fn public_entry() -> u32 { internal_helper() }',
        'pub(crate) fn crate_entry() -> u32 { public_entry() }',
        'pub const fn const_calc(v: u32) -> u32 { v + 1 }',
        'const USE_IT: u32 = const_calc(2);',
        '',
      ].join('\n'),
      'utf8',
    )

    const { response } = await invokeWorker({
      op: 'grep',
      roots: [wsDir],
      args: {
        pattern: 'fn ',
        path: 'outline-fixtures/rust_defs.rs',
        outputMode: 'definitions',
      },
    })

    assert.equal(response.ok, true)
    const result = response.result
    assert.equal(result.definitionMatches, 4, `Expected all 4 Rust fn declarations, got ${result.definitionMatches}`)
    assert.equal(result.entries.length, 4)
    const constFnMatch = result.entries.find((m) => m.text.includes('pub const fn const_calc'))
    assert.ok(constFnMatch, 'Expected pub const fn const_calc to be matched')
    assert.equal(constFnMatch.declKind, 'function')
    assert.equal(
      result.entries.some((m) => m.text.includes('MAX_LIMIT')),
      false,
      'Regular pub const value must not match pattern "fn "',
    )
  })

  it('v0.5.0: honors parent anchored .gitignore and stacks nested subdirectory .gitignore rules', async () => {
    const giRoot = join(wsDir, 'gi-suite')
    mkdirSync(join(giRoot, 'apps', 'web', 'sub', 'build'), { recursive: true })
    mkdirSync(join(giRoot, 'pkg_a', 'deep'), { recursive: true })
    mkdirSync(join(giRoot, 'pkg_b'), { recursive: true })

    writeFileSync(
      join(giRoot, '.gitignore'),
      '/root_only.txt\n/apps/web/exact_sub.txt\n*.log\nbuild/\n',
      'utf8',
    )
    writeFileSync(
      join(giRoot, 'pkg_a', '.gitignore'),
      '/local_only.txt\n*.tmp\n!keep.log\n',
      'utf8',
    )

    writeFileSync(join(giRoot, 'root_only.txt'), 'GI_TOKEN root\n', 'utf8')
    writeFileSync(join(giRoot, 'root.log'), 'GI_TOKEN rootlog\n', 'utf8')
    writeFileSync(join(giRoot, 'apps', 'web', 'root_only.txt'), 'GI_TOKEN keep_sub_root_only\n', 'utf8')
    writeFileSync(join(giRoot, 'apps', 'web', 'exact_sub.txt'), 'GI_TOKEN ignore_exact_sub\n', 'utf8')
    writeFileSync(join(giRoot, 'apps', 'web', 'build'), 'GI_TOKEN regular_file_build\n', 'utf8')
    writeFileSync(join(giRoot, 'apps', 'web', 'sub', 'build', 'out.txt'), 'GI_TOKEN ignored_dir_build\n', 'utf8')
    writeFileSync(join(giRoot, 'pkg_a', 'drop.log'), 'GI_TOKEN drop_log\n', 'utf8')
    writeFileSync(join(giRoot, 'pkg_a', 'keep.log'), 'GI_TOKEN keep_log\n', 'utf8')
    writeFileSync(join(giRoot, 'pkg_a', 'local_only.txt'), 'GI_TOKEN ignore_local\n', 'utf8')
    writeFileSync(join(giRoot, 'pkg_a', 'deep', 'local_only.txt'), 'GI_TOKEN keep_deep_local\n', 'utf8')
    writeFileSync(join(giRoot, 'pkg_a', 'deep', 'scratch.tmp'), 'GI_TOKEN ignore_tmp\n', 'utf8')
    writeFileSync(join(giRoot, 'pkg_b', 'scratch.tmp'), 'GI_TOKEN keep_sibling_tmp\n', 'utf8')

    // 1. Subdirectory search under apps/web resolves parent anchored rules relative to gi-suite.
    const subGlob = await invokeWorker({
      op: 'glob',
      roots: [giRoot],
      args: { path: 'apps/web', pattern: ['**/*'], kind: 'file', sort: 'path' },
    })
    assert.equal(subGlob.response.ok, true)
    const subPaths = subGlob.response.result.entries.map((e) => e.path.replace(/\\/g, '/'))
    assert.ok(subPaths.some((p) => p.endsWith('/apps/web/root_only.txt')))
    assert.ok(!subPaths.some((p) => p.endsWith('/apps/web/exact_sub.txt')))
    assert.ok(subPaths.some((p) => p.endsWith('/apps/web/build')))
    assert.ok(!subPaths.some((p) => p.endsWith('/sub/build/out.txt')))

    // 2. Full search from giRoot stacks nested pkg_a/.gitignore cleanly with negation & sibling isolation.
    const fullGrep = await invokeWorker({
      op: 'grep',
      roots: [giRoot],
      args: { pattern: 'GI_TOKEN', outputMode: 'files_with_matches' },
    })
    assert.equal(fullGrep.response.ok, true)
    const matchedFiles = fullGrep.response.result.entries.map((e) => e.path.replace(/\\/g, '/'))
    assert.ok(!matchedFiles.some((p) => p.endsWith('/gi-suite/root_only.txt')))
    assert.ok(!matchedFiles.some((p) => p.endsWith('/gi-suite/root.log')))
    assert.ok(matchedFiles.some((p) => p.endsWith('/apps/web/root_only.txt')))
    assert.ok(!matchedFiles.some((p) => p.endsWith('/apps/web/exact_sub.txt')))
    assert.ok(!matchedFiles.some((p) => p.endsWith('/pkg_a/drop.log')))
    assert.ok(matchedFiles.some((p) => p.endsWith('/pkg_a/keep.log')))
    assert.ok(!matchedFiles.some((p) => p.endsWith('/pkg_a/local_only.txt')))
    assert.ok(matchedFiles.some((p) => p.endsWith('/pkg_a/deep/local_only.txt')))
    assert.ok(!matchedFiles.some((p) => p.endsWith('/pkg_a/deep/scratch.tmp')))
    assert.ok(matchedFiles.some((p) => p.endsWith('/pkg_b/scratch.tmp')))
  })

  it('v0.5.0: multiplexes concurrent reqId requests in daemon mode and cleanly fails in-flight work on dispose', async () => {
    // 1. Raw daemon protocol test: interleaved reqId + legacy no-reqId backward compatibility.
    const daemonLines = await new Promise((resolveLines, rejectLines) => {
      const child = spawn(activeWorkerBin, ['--daemon'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let out = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        out += chunk
      })
      child.once('error', rejectLines)
      child.once('close', () => {
        const parsed = out
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => JSON.parse(l))
        resolveLines(parsed)
      })

      const reqs = [
        { reqId: 'mux-1', op: 'grep', roots: [wsDir], args: { pattern: 'computeSavings', outputMode: 'content' } },
        { reqId: 'mux-2', op: 'stat', roots: [wsDir], args: { path: 'src/engine.ts' } },
        { reqId: 'mux-3', op: 'read_files', roots: [wsDir], args: { files: [{ path: 'src/consumer.ts', offset: 1, limit: 5 }] } },
        { op: 'stat', roots: [wsDir], args: { path: 'src/escape.txt' } }, // legacy without reqId
      ]
      child.stdin.end(reqs.map((r) => JSON.stringify(r)).join('\n') + '\n')
    })

    assert.equal(daemonLines.length, 4)
    const byId = new Map(daemonLines.filter((r) => r.reqId).map((r) => [r.reqId, r]))
    assert.equal(byId.get('mux-1')?.ok, true)
    assert.equal(byId.get('mux-2')?.ok, true)
    assert.equal(byId.get('mux-3')?.ok, true)
    const legacy = daemonLines.find((r) => !('reqId' in r))
    assert.ok(legacy, 'Legacy request without reqId must omit reqId in response')
    assert.equal(legacy.ok, true)
    assert.match(legacy.result.path, /escape\.txt$/)

    // 2. RustWorker concurrent fan-out (> MAX_CONCURRENT_REQUESTS = 8) all correlate accurately.
    const worker = new RustWorker(activeWorkerBin)
    try {
      const calls = [
        worker.invoke('grep', { pattern: 'step_', outputMode: 'content' }, { roots: [wsDir], credentialFence: true, maxInlineBytes: 65_536 }),
        worker.invoke('stat', { path: 'src/engine.ts' }, { roots: [wsDir], credentialFence: true, maxInlineBytes: 65_536 }),
        worker.invoke('stat', { path: 'src/consumer.ts' }, { roots: [wsDir], credentialFence: true, maxInlineBytes: 65_536 }),
        worker.invoke('read_files', { files: [{ path: 'src/engine.ts', offset: 1, limit: 5 }] }, { roots: [wsDir], credentialFence: true, maxInlineBytes: 65_536 }),
        worker.invoke('read_files', { files: [{ path: 'src/consumer.ts', offset: 1, limit: 5 }] }, { roots: [wsDir], credentialFence: true, maxInlineBytes: 65_536 }),
        worker.invoke('glob', { pattern: ['**/*.ts'], kind: 'file' }, { roots: [wsDir], credentialFence: true, maxInlineBytes: 65_536 }),
        worker.invoke('stat', { path: 'src/escape.txt' }, { roots: [wsDir], credentialFence: true, maxInlineBytes: 65_536 }),
        worker.invoke('stat', { path: 'outline-fixtures/rich_worker.rs' }, { roots: [wsDir], credentialFence: true, maxInlineBytes: 65_536 }),
        worker.invoke('read_files', { files: [{ path: 'outline-fixtures/rich-service.ts', view: 'outline' }] }, { roots: [wsDir], credentialFence: true, maxInlineBytes: 65_536 }),
        worker.invoke('stat', { path: 'src/missing-file.ts' }, { roots: [wsDir], credentialFence: true, maxInlineBytes: 65_536 }),
        worker.invoke('grep', { pattern: 'clamp_limit', outputMode: 'definitions' }, { roots: [wsDir], credentialFence: true, maxInlineBytes: 65_536 }),
        worker.invoke('stat', { path: '.env' }, { roots: [wsDir], credentialFence: true, maxInlineBytes: 65_536 }),
      ]

      const results = await Promise.all(calls)
      assert.equal(results[0].ok, true)
      assert.equal(results[1].ok, true)
      assert.match(results[1].result.path, /engine\.ts$/)
      assert.equal(results[2].ok, true)
      assert.match(results[2].result.path, /consumer\.ts$/)
      assert.equal(results[3].ok, true)
      assert.match(results[3].result.items[0].content, /EngineConfig/)
      assert.equal(results[4].ok, true)
      assert.match(results[4].result.items[0].content, /computeSavings/)
      assert.equal(results[5].ok, true)
      assert.equal(results[6].ok, true)
      assert.match(results[6].result.path, /escape\.txt$/)
      assert.equal(results[7].ok, true)
      assert.match(results[7].result.path, /rich_worker\.rs$/)
      assert.equal(results[8].ok, true)
      assert.equal(results[8].result.items[0].view, 'outline')
      assert.equal(results[9].ok, true)
      assert.equal(results[9].result.exists, false)
      assert.equal(results[10].ok, true)
      assert.equal(results[10].result.definitionMatches, 1)
      assert.equal(results[11].ok, false)
      assert.equal(results[11].failure.code, 'CREDENTIAL_FENCE_BLOCKED')
    } finally {
      worker.dispose()
    }

    // 3. Disposing while requests are in flight rejects/fails every pending promise cleanly.
    const dyingWorker = new RustWorker(activeWorkerBin)
    const inflight = [
      dyingWorker.invoke('grep', { pattern: 'step_', outputMode: 'content' }, { roots: [wsDir], credentialFence: true, maxInlineBytes: 65_536 }),
      dyingWorker.invoke('stat', { path: 'src/engine.ts' }, { roots: [wsDir], credentialFence: true, maxInlineBytes: 65_536 }),
    ]
    dyingWorker.dispose()
    const disposedResults = await Promise.all(inflight)
    for (const r of disposedResults) {
      assert.equal(r.ok, false)
      assert.equal(r.failure.code, 'WORKER_DISPOSED')
    }
  })

  it('v0.5.0: enforces IPC response payload ceiling across read_files, grep, and read_doc without killing worker', async () => {
    const bigDir = join(wsDir, 'oversized')
    mkdirSync(bigDir, { recursive: true })

    // Create a ~5 MiB text file (would previously exceed Node's 4 MiB MAX_STDOUT_BYTES and kill the worker).
    const bigLine = `OVERSIZED_MATCH_LINE ${'A'.repeat(1000)}\n`
    writeFileSync(join(bigDir, 'huge.txt'), bigLine.repeat(5000), 'utf8')

    // Create a ~5 MiB CSV file.
    const csvRows = ['id,data']
    const csvCell = 'B'.repeat(1000)
    for (let i = 1; i <= 5000; i++) {
      csvRows.push(`${i},${csvCell}`)
    }
    writeFileSync(join(bigDir, 'huge.csv'), csvRows.join('\n') + '\n', 'utf8')

    // Create a medium 12 KB file to confirm spillover headroom (> maxInlineBytes=4096, < 8x budget=32768).
    writeFileSync(join(bigDir, 'spill-medium.txt'), `SPILL_LINE ${'M'.repeat(100)}\n`.repeat(100), 'utf8')

    const worker = new RustWorker(activeWorkerBin)
    try {
      // 1. Oversized read_files stays well under 4 MiB and marks truncated=true instead of WORKER_OUTPUT_TOO_LARGE.
      const readRes = await worker.invoke(
        'read_files',
        { files: [{ path: 'oversized/huge.txt', offset: 1, limit: 5000 }] },
        { roots: [wsDir], credentialFence: true, maxInlineBytes: 65_536 },
      )
      assert.equal(readRes.ok, true, `Expected read_files to succeed cleanly, got: ${JSON.stringify(readRes)}`)
      assert.equal(readRes.result.truncated, true)
      assert.equal(readRes.result.items[0].truncated, true)
      assert.equal(readRes.result.items[0].eof, false)
      assert.ok(typeof readRes.result.items[0].nextOffset === 'number')
      assert.ok(Buffer.byteLength(JSON.stringify(readRes.result), 'utf8') < 3_500_000)

      // 2. Oversized grep stays well under 4 MiB and marks truncated=true.
      const grepRes = await worker.invoke(
        'grep',
        { path: 'oversized/huge.txt', pattern: 'OVERSIZED_MATCH_LINE', outputMode: 'content', limit: 2000 },
        { roots: [wsDir], credentialFence: true, maxInlineBytes: 65_536 },
      )
      assert.equal(grepRes.ok, true, `Expected grep to succeed cleanly, got: ${JSON.stringify(grepRes)}`)
      assert.equal(grepRes.result.truncated, true)
      assert.ok(typeof grepRes.result.nextOffset === 'number')
      assert.ok(grepRes.result.entries.length < 2000)
      assert.ok(Buffer.byteLength(JSON.stringify(grepRes.result), 'utf8') < 3_500_000)

      // 3. Oversized read_doc stays well under 4 MiB and marks truncated=true.
      const docRes = await worker.invoke(
        'read_doc',
        { path: 'oversized/huge.csv', format: 'table', offset: 1, limit: 2000 },
        { roots: [wsDir], credentialFence: true, maxInlineBytes: 65_536 },
      )
      assert.equal(docRes.ok, true, `Expected read_doc to succeed cleanly, got: ${JSON.stringify(docRes)}`)
      assert.equal(docRes.result.truncated, true)
      assert.equal(docRes.result.complete, false)
      assert.ok(typeof docRes.result.nextOffset === 'number')
      assert.ok(docRes.result.returnedUnits < 2000)
      assert.ok(Buffer.byteLength(JSON.stringify(docRes.result), 'utf8') < 3_500_000)

      // 4. Medium file (~11 KB > maxInlineBytes=4096) is NOT prematurely truncated so Node SpillStore gets full text.
      const medRes = await worker.invoke(
        'read_files',
        { files: [{ path: 'oversized/spill-medium.txt', offset: 1, limit: 200 }] },
        { roots: [wsDir], credentialFence: true, maxInlineBytes: 4_096 },
      )
      assert.equal(medRes.ok, true)
      assert.equal(medRes.result.truncated, false)
      assert.equal(medRes.result.items[0].eof, true)
      assert.equal(medRes.result.items[0].returnedLines, 100)
      assert.ok(Buffer.byteLength(medRes.result.items[0].content, 'utf8') > 4_096)
    } finally {
      worker.dispose()
    }
  })
})
