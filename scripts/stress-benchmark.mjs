import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import {
  compactTerminalStream,
  packFailureHeadTail,
} from '../src/server/output-compactor.ts'
import { RustWorker } from '../src/server/rust-worker.ts'
import { SpillStore } from '../src/server/spill-store.ts'
import { normalizeWorkdir, normalizeWorkerPath } from '../src/shared/paths.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const IS_WIN = process.platform === 'win32'
const WORKER_BIN_NAME = IS_WIN ? 'agy-pulse-worker.exe' : 'agy-pulse-worker'
const DIST_WORKER_BIN = join(ROOT, 'sidecars', 'pulse', 'dist', WORKER_BIN_NAME)
const QUICK = process.argv.includes('--quick')

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

async function main() {
  if (!existsSync(DIST_WORKER_BIN)) {
    console.error(`[stress] Missing compiled Rust worker at ${DIST_WORKER_BIN}. Run \`npm run build\` first.`)
    process.exit(1)
  }

  const wsDir = mkdtempSync(join(tmpdir(), 'agy-pulse-stress-ws-'))
  const spillDir = mkdtempSync(join(tmpdir(), 'agy-pulse-stress-spill-'))
  let binDir = null
  let workerBin = DIST_WORKER_BIN
  if (IS_WIN) {
    binDir = mkdtempSync(join(tmpdir(), 'agy-pulse-stress-bin-'))
    workerBin = join(binDir, WORKER_BIN_NAME)
    copyFileSync(DIST_WORKER_BIN, workerBin)
  }

  const worker = new RustWorker(workerBin)
  const opts = { roots: [wsDir], credentialFence: true, maxInlineBytes: 7800 }
  const results = []

  const record = (name, detail) => {
    results.push({ name, detail })
    console.log(`  PASS  ${name.padEnd(36)} ${detail}`)
  }

  try {
    console.log(`\n[agy-pulse stress] Running 6 scenarios (${QUICK ? 'quick' : 'full'} mode)...\n`)

    // 1. Large Monorepo Walk + .gitignore + Glob/Fuzzy/Grep
    const activeFilesCount = QUICK ? 800 : 2_500
    const ignoredFilesCount = QUICK ? 200 : 500
    const pkgCount = 20

    writeFileSync(join(wsDir, '.gitignore'), 'ignored_logs/\n*.generated.log\n', 'utf8')
    mkdirSync(join(wsDir, 'ignored_logs'), { recursive: true })
    for (let i = 0; i < pkgCount; i++) {
      mkdirSync(join(wsDir, 'packages', `pkg-${i}`, 'src'), { recursive: true })
    }

    for (let i = 0; i < activeFilesCount; i++) {
      const pkg = `pkg-${i % pkgCount}`
      const needle = i === 137 ? '\nexport function targetNeedleEngine(x: number) { return x * 42 }\n' : ''
      writeFileSync(
        join(wsDir, 'packages', pkg, 'src', `module_${i}.ts`),
        `export const id_${i} = ${i}\nexport function compute_${i}(v: number) { return v + ${i} }${needle}\n`,
        'utf8',
      )
    }
    for (let i = 0; i < ignoredFilesCount; i++) {
      writeFileSync(
        join(wsDir, 'ignored_logs', `noise_${i}.ts`),
        'export function targetNeedleEngine() { return -1 }\n',
        'utf8',
      )
    }

    const tGlob0 = performance.now()
    const globRes = await worker.invoke('glob', { pattern: ['**/*.ts'], limit: 2000 }, opts)
    const globMs = performance.now() - tGlob0
    assert.equal(globRes.ok, true)
    assert.equal(globRes.result.totalMatched, activeFilesCount)

    const tFuzzy0 = performance.now()
    const fuzzyRes = await worker.invoke('fuzzy', { pattern: 'module_137' }, opts)
    const fuzzyMs = performance.now() - tFuzzy0
    assert.equal(fuzzyRes.ok, true)
    assert.match(fuzzyRes.result.entries[0].path, /module_137\.ts$/)

    const tGrep0 = performance.now()
    const grepRes = await worker.invoke(
      'grep',
      { pattern: 'targetNeedleEngine', outputMode: 'definitions' },
      opts,
    )
    const grepMs = performance.now() - tGrep0
    assert.equal(grepRes.ok, true)
    assert.equal(grepRes.result.definitionMatches, 1)

    record(
      '1. Monorepo .gitignore/glob/fuzzy',
      `${activeFilesCount} files (+${ignoredFilesCount} ignored): glob=${globMs.toFixed(1)}ms fuzzy=${fuzzyMs.toFixed(1)}ms grep=${grepMs.toFixed(1)}ms`,
    )

    // 2. Persistent Rust Worker Soak (80 / 200 requests)
    const soakCount = QUICK ? 80 : 200
    const latencies = []
    for (let i = 0; i < soakCount; i++) {
      const target = `packages/pkg-${i % pkgCount}/src/module_${i}.ts`
      const t0 = performance.now()
      let res
      if (i % 4 === 0) {
        res = await worker.invoke('stat', { path: target }, opts)
      } else if (i % 4 === 1) {
        res = await worker.invoke('read_files', { files: [{ path: target, view: 'outline' }] }, opts)
      } else if (i % 4 === 2) {
        res = await worker.invoke(
          'diff',
          { path: target, edits: [{ oldText: `id_${i} = ${i}`, newText: `id_${i} = ${i + 1}` }] },
          opts,
        )
      } else {
        res = await worker.invoke('read_files', { files: [{ path: target, offset: 1, limit: 20 }] }, opts)
      }
      assert.equal(res.ok, true, `Soak iteration ${i} failed: ${JSON.stringify(res)}`)
      latencies.push(performance.now() - t0)
    }
    latencies.sort((a, b) => a - b)
    record(
      `2. Persistent daemon soak (${soakCount} reqs)`,
      `p50=${percentile(latencies, 50).toFixed(2)}ms p95=${percentile(latencies, 95).toFixed(2)}ms p99=${percentile(latencies, 99).toFixed(2)}ms`,
    )

    // 3. 5 MiB Terminal Log Flood + Green Folding + Failure Head-Tail Packing
    const floodLines = [
      ...Array.from({ length: 1200 }, (_, i) => `\x1b[32m   Compiling dep_${i} v0.${i % 10}.0\x1b[0m`),
      'TypeError: Cannot read properties of undefined (reading "criticalRootCause")',
      ...Array.from(
        { length: QUICK ? 15_000 : 60_000 },
        (_, i) => `   Compiling extra_crate_${i} v1.0.0 (${'x'.repeat(42)})`,
      ),
      '  at runPipeline (src/pipeline.ts:88:12)',
      'FINAL_SUMMARY: 1 suite failed, 0 passed',
    ]
    const rawFlood = floodLines.join('\n')
    const rawFloodBytes = Buffer.byteLength(rawFlood, 'utf8')

    const tCompact0 = performance.now()
    const compacted = compactTerminalStream(rawFlood, false)
    const packed = packFailureHeadTail(compacted.text, 7_800)
    const compactMs = performance.now() - tCompact0

    const packedBytes = Buffer.byteLength(packed.text, 'utf8')
    const reductionPct = ((1 - packedBytes / rawFloodBytes) * 100).toFixed(2)
    assert.ok(packedBytes <= 7_800)
    assert.match(packed.text, /criticalRootCause/)
    assert.match(packed.text, /FINAL_SUMMARY/)

    record(
      '3. Multi-MiB log flood compaction',
      `${(rawFloodBytes / (1024 * 1024)).toFixed(2)} MiB -> ${packedBytes} B (${reductionPct}% trimmed) in ${compactMs.toFixed(1)}ms`,
    )

    // 4. Red-Team Security Suite
    mkdirSync(join(wsDir, 'sec-dir'), { recursive: true })
    mkdirSync(join(wsDir, '.gnupg'), { recursive: true })
    writeFileSync(join(wsDir, 'sec-dir', 'clean.txt'), 'ok', 'utf8')
    writeFileSync(join(wsDir, 'sec-dir', '.env'), 'SECRET=1', 'utf8')
    writeFileSync(join(wsDir, '.gnupg', 'secring.gpg'), 'SECRET', 'utf8')
    writeFileSync(join(wsDir, 'service_account_key.json'), '{}', 'utf8')
    writeFileSync(join(wsDir, 'tls.p12'), 'SECRET', 'utf8')

    const redTeamAttacks = [
      await worker.invoke('stat', { path: '../outside-escape.txt' }, opts),
      await worker.invoke('read_files', { files: [{ path: '.gnupg/secring.gpg' }] }, opts),
      await worker.invoke('read_files', { files: [{ path: 'service_account_key.json' }] }, opts),
      await worker.invoke('read_files', { files: [{ path: 'tls.p12' }] }, opts),
      await worker.invoke('batch', { operations: [{ op: 'copy', path: 'sec-dir', to: 'sec-dst' }] }, opts),
    ]
    for (const r of redTeamAttacks) {
      assert.equal(r.ok, false)
      assert.equal(r.failure.effectState, 'none')
    }
    assert.equal(normalizeWorkdir(undefined, []).ok, false)
    assert.equal(normalizeWorkerPath('C:foo', 'D:\\repo', 'win32').ok, false)
    assert.equal(normalizeWorkerPath('/etc/passwd', 'D:\\repo', 'win32').ok, false)

    record('4. Red-team security suite', `8/8 escape & credential attacks blocked (effectState=none)`)

    // 5. SpillStore High-Volume In-Memory Index & Pruning
    const spillStore = new SpillStore(spillDir)
    const spillCount = QUICK ? 60 : 120
    for (let i = 0; i < spillCount; i++) {
      spillStore.save({
        stdout: `spill payload ${i}\n`.repeat(10),
        stderr: '',
        sessionId: `sess-${i % 4}`,
        meta: { tool: 'pulse_exec', description: `job-${i}` },
      })
    }
    const tList0 = performance.now()
    for (let i = 0; i < 500; i++) {
      const list = spillStore.listSpills(100, `sess-${i % 4}`)
      assert.equal(list.length, spillCount / 4)
    }
    const listMs = performance.now() - tList0
    const pruned = spillStore.releaseBySession('sess-0')
    assert.equal(pruned, spillCount / 4)
    assert.equal(spillStore.listSpills(200).length, (spillCount * 3) / 4)

    record(
      '5. SpillStore RAM index stress',
      `${spillCount} spills, 500x listSpills() in ${listMs.toFixed(1)}ms (pruned ${pruned} cleanly)`,
    )

    // 6. 14-Format Parallel Batch Outline Coverage
    mkdirSync(join(wsDir, 'formats'), { recursive: true })
    const formatFixtures = [
      ['sample.ts', 'export function tsFn() { return 1 }\n'],
      ['sample.rs', 'pub fn rs_fn() -> usize { 1 }\n'],
      ['sample.py', 'def py_fn():\n    return 1\n'],
      ['sample.go', 'package main\nfunc goFn() int { return 1 }\n'],
      ['sample.java', 'public class Demo { public void run() {} }\n'],
      ['sample.cpp', 'int cpp_fn() { return 1; }\n'],
      ['sample.rb', 'def rb_fn\n  1\nend\n'],
      ['sample.php', '<?php\nfunction phpFn() { return 1; }\n'],
      ['sample.md', '# Heading One\nBody\n## Heading Two\n'],
      ['sample.json', '{\n  "version": 1,\n  "scripts": {\n    "test": "ok"\n  }\n}\n'],
      ['sample.yaml', 'app:\n  name: pulse\n  port: 8080\n'],
      ['sample.css', '.card {\n  color: red;\n}\n'],
      ['sample.html', '<main id="root">Hi</main>\n'],
      ['sample.vue', '<template><div id="v"></div></template>\n<script setup>\nexport function vueFn() {}\n</script>\n'],
    ]
    for (const [name, body] of formatFixtures) {
      writeFileSync(join(wsDir, 'formats', name), body, 'utf8')
    }

    const tOut0 = performance.now()
    const batchOut = await worker.invoke(
      'read_files',
      { files: formatFixtures.map(([name]) => ({ path: `formats/${name}`, view: 'outline' })) },
      opts,
    )
    const outMs = performance.now() - tOut0
    assert.equal(batchOut.ok, true)
    assert.equal(batchOut.result.items.length, formatFixtures.length)
    for (const item of batchOut.result.items) {
      assert.equal(
        item.content.includes('[no structural declarations detected'),
        false,
        `Expected outline symbols for ${item.path}, got: ${item.content}`,
      )
    }

    record(
      '6. 14-format parallel outline batch',
      `${formatFixtures.length}/${formatFixtures.length} formats outlined in ${outMs.toFixed(2)}ms`,
    )

    console.log(`\n[agy-pulse stress] ALL ${results.length} scenarios passed.\n`)
  } finally {
    worker.dispose()
    if (IS_WIN) {
      await new Promise((r) => setTimeout(r, 80))
    }
    rmSync(wsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(spillDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    if (binDir) {
      rmSync(binDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  }
}

void main().catch((err) => {
  console.error('[agy-pulse stress] FAILED:', err)
  process.exit(1)
})
