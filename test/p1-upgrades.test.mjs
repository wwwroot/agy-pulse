import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildWorkspaceSnapshot } from '../src/hook/snapshot.ts'
import { ConfigStore, validateConfigPatch } from '../src/server/config.ts'
import {
  readConversationContextUsage,
  resolveModelContextLimit,
} from '../src/server/context-window.ts'
import { buildNonInteractiveEnv, ExecEngine } from '../src/server/exec-engine.ts'
import { runGitStatus } from '../src/server/git-ops.ts'
import { JobManager } from '../src/server/job-manager.ts'
import {
  compactTerminalStream,
  foldGreenPhaseNoise,
  normalizeTerminalOutput,
  packFailureHeadTail,
  truncateMiddle,
  waterFill,
} from '../src/server/output-compactor.ts'
import { extractDeliveredLineIntervals, ReadDedupStore } from '../src/server/read-dedup.ts'
import { RustWorker } from '../src/server/rust-worker.ts'
import { SessionManager } from '../src/server/session-manager.ts'
import { ShellDiscovery } from '../src/server/shells.ts'
import { SpillStore } from '../src/server/spill-store.ts'
import { TelemetryStore } from '../src/server/telemetry-store.ts'

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

describe('P1 Upgrades Regression Suite', () => {
  let wsDir
  let binDir
  let workerBin
  let worker

  before(() => {
    assert.equal(existsSync(DIST_WORKER_BIN), true, `Missing worker at ${DIST_WORKER_BIN}`)
    wsDir = mkdtempSync(join(tmpdir(), 'agy-pulse-p1-ws-'))
    if (IS_WIN) {
      binDir = mkdtempSync(join(tmpdir(), 'agy-pulse-p1-bin-'))
      workerBin = join(binDir, 'agy-pulse-worker.exe')
      copyFileSync(DIST_WORKER_BIN, workerBin)
    } else {
      workerBin = DIST_WORKER_BIN
    }
    worker = new RustWorker(workerBin)

    mkdirSync(join(wsDir, 'src', 'components'), { recursive: true })
    mkdirSync(join(wsDir, 'ignored-dir'), { recursive: true })
    mkdirSync(join(wsDir, 'docs'), { recursive: true })

    writeFileSync(
      join(wsDir, '.gitignore'),
      '# Ignore logs and generated artifacts\n*.log\nignored-dir/\n!important.log\n',
      'utf8',
    )
    writeFileSync(
      join(wsDir, 'package.json'),
      JSON.stringify({ name: 'p1-demo', scripts: { build: 'tsc', test: 'node --test' } }, null, 2),
      'utf8',
    )
    writeFileSync(join(wsDir, 'debug.log'), 'noise log\n', 'utf8')
    writeFileSync(join(wsDir, 'important.log'), 'kept log\n', 'utf8')
    writeFileSync(join(wsDir, 'ignored-dir', 'skip.ts'), 'export const skipped = true\n', 'utf8')
    writeFileSync(
      join(wsDir, 'src', 'components', 'UserProfileCard.vue'),
      [
        '<template>',
        '  <section id="profile-card">Profile</section>',
        '</template>',
        '<script setup lang="ts">',
        'export function formatUserName(first: string, last: string): string {',
        '  return `${first} ${last}`',
        '}',
        '</script>',
        '<style scoped>',
        '.profile-card { padding: 12px; }',
        '</style>',
        '',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(
      join(wsDir, 'src', 'token-counter.ts'),
      'export function calculateTokenSavings(rawBytes: number, deliveredBytes: number): number {\n  return Math.max(0, rawBytes - deliveredBytes)\n}\n',
      'utf8',
    )
    writeFileSync(
      join(wsDir, 'docs', 'GUIDE.md'),
      '# Pulse Guide\nIntro paragraph.\n```bash\n# Not a heading\n```\n## Architecture\nDetails here.\n',
      'utf8',
    )
    writeFileSync(
      join(wsDir, 'config.yaml'),
      'daemon:\n  port: 4000\n  host: 127.0.0.1\nsecurity:\n  fence: true\n',
      'utf8',
    )
    writeFileSync(
      join(wsDir, 'theme.css'),
      '.panel {\n  display: flex;\n}\n@media (max-width: 800px) {\n  .panel { display: block; }\n}\n',
      'utf8',
    )
  })

  after(async () => {
    worker?.dispose()
    if (IS_WIN) {
      await new Promise((r) => setTimeout(r, 80))
    }
    rmSync(wsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    if (binDir) {
      rmSync(binDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('declares eviction-safe lazy loading for all 7 pulse_* tools and inlines Quick Schemas + strict routing rules in AGENTS.md', () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'mcp_config.json'), 'utf8'))
    const tools = cfg?.mcpServers?.pulse?.tools
    assert.ok(tools && typeof tools === 'object')
    const rules = readFileSync(join(ROOT, 'rules', 'AGENTS.md'), 'utf8')
    assert.match(rules, /ServerName:\s*"agy-pulse_pulse"/)
    assert.match(rules, /NEVER.*run_command/)
    for (const name of [
      'pulse_read_files',
      'pulse_search',
      'pulse_mutate',
      'pulse_read_doc',
      'pulse_exec',
      'pulse_job',
      'pulse_result',
    ]) {
      assert.equal(
        tools[name]?.eager,
        false,
        `Expected ${name} to declare eviction-safe eager: false`,
      )
      assert.ok(rules.includes(name), `rules/AGENTS.md should inline Quick Schema for ${name}`)
    }
  })

  it('builds compact <=1.5KB SessionStart workspace snapshot and refuses home root', async () => {
    const snap = await buildWorkspaceSnapshot(wsDir)
    assert.ok(typeof snap === 'string' && snap.length > 0)
    assert.ok(Buffer.byteLength(snap, 'utf8') <= 1500)
    assert.match(snap, /\[agy-pulse snapshot\]/)
    assert.match(snap, /node\(p1-demo\)/)
    assert.match(snap, /scripts=\[build, test\]/)
    assert.match(snap, /src\//)

    const homeSnap = await buildWorkspaceSnapshot(homedir())
    assert.equal(homeSnap, null)
  })

  it('honors .gitignore rules and !negations in glob, grep, and fuzzy search', async () => {
    const opts = { roots: [wsDir], credentialFence: true, maxInlineBytes: 7800 }

    const globRes = await worker.invoke('glob', { pattern: ['**/*'] }, opts)
    assert.equal(globRes.ok, true)
    const globPaths = globRes.result.entries.map((e) => e.path.replace(/\\/g, '/'))
    assert.equal(globPaths.some((p) => p.endsWith('/debug.log')), false, 'debug.log should be gitignored')
    assert.equal(globPaths.some((p) => p.includes('/ignored-dir/')), false, 'ignored-dir/ should be gitignored')
    assert.equal(globPaths.some((p) => p.endsWith('/important.log')), true, '!important.log should be re-included')

    const grepRes = await worker.invoke('grep', { pattern: 'skipped', outputMode: 'files_with_matches' }, opts)
    assert.equal(grepRes.ok, true)
    assert.equal(grepRes.result.totalMatched, 0)

    const fuzzyRes = await worker.invoke('fuzzy', { pattern: 'upc' }, opts)
    assert.equal(fuzzyRes.ok, true)
    assert.ok(fuzzyRes.result.entries.length >= 1)
    assert.match(fuzzyRes.result.entries[0].path, /UserProfileCard\.vue$/)
  })

  it('extracts outlines for Markdown, JSON, YAML, CSS, and Vue SFC files', async () => {
    const opts = { roots: [wsDir], credentialFence: true, maxInlineBytes: 7800 }
    const res = await worker.invoke(
      'read_files',
      {
        files: [
          { path: 'docs/GUIDE.md', view: 'outline' },
          { path: 'package.json', view: 'outline' },
          { path: 'config.yaml', view: 'outline' },
          { path: 'theme.css', view: 'outline' },
          { path: 'src/components/UserProfileCard.vue', view: 'outline' },
        ],
      },
      opts,
    )
    assert.equal(res.ok, true)
    const [md, pkg, yaml, css, vue] = res.result.items
    assert.match(md.content, /# Pulse Guide/)
    assert.match(md.content, /## Architecture/)
    assert.equal(md.content.includes('Not a heading'), false)
    assert.match(pkg.content, /"scripts"/)
    assert.match(yaml.content, /daemon:/)
    assert.match(css.content, /\.panel/)
    assert.match(css.content, /@media/)
    assert.match(vue.content, /<script/)
    assert.match(vue.content, /formatUserName/)
  })

  it('includes a closest-region snippet hint when pulse_mutate edit fails with EDIT_NOT_FOUND', async () => {
    const opts = { roots: [wsDir], credentialFence: true, maxInlineBytes: 7800 }
    const stat = await worker.invoke('stat', { path: 'src/token-counter.ts' }, opts)
    const editRes = await worker.invoke(
      'edit',
      {
        path: 'src/token-counter.ts',
        expectedRevision: stat.result.revision,
        edits: [
          {
            oldText: 'export function calculateTokenSavings(rawBytes: number, delivered: number)',
            newText: 'export function calculateTokenSavings(raw: number, delivered: number)',
          },
        ],
      },
      opts,
    )
    assert.equal(editRes.ok, false)
    assert.equal(editRes.failure.code, 'EDIT_NOT_FOUND')
    assert.match(editRes.failure.message, /Closest match near L1-/)
    assert.match(editRes.failure.message, /calculateTokenSavings/)

    // Optional expectedRevision: direct write & edit succeed cleanly without requiring a SHA-256 hash
    const directWrite = await worker.invoke(
      'write',
      { path: 'src/direct-note.txt', content: 'alpha\nbeta\n' },
      opts,
    )
    assert.equal(directWrite.ok, true)
    const directEdit = await worker.invoke(
      'edit',
      { path: 'src/direct-note.txt', edits: [{ oldText: 'beta', newText: 'gamma' }] },
      opts,
    )
    assert.equal(directEdit.ok, true)
    assert.equal(directEdit.result.addedLines, 1)
  })

  it('normalizes ANSI/CR spinners, folds green build lines safely, and packs failure head-tail clusters', () => {
    const rawSpinner = '\x1b[32mLoading 10%\rLoading 50%\rDone!\x1b[0m\n'
    assert.equal(normalizeTerminalOutput(rawSpinner), 'Done!\n')

    const greenLines = [
      ...Array.from({ length: 12 }, (_, i) => `   Compiling crate-${i} v0.1.0`),
      'Worker 0 failed with exit code 1',
      ...Array.from({ length: 8 }, (_, i) => `  ✔ test case ${i} (0 errors)`),
      ...Array.from({ length: 15 }, (_, i) => `tail summary line ${i}`),
    ].join('\n')

    const folded = foldGreenPhaseNoise(greenLines)
    assert.ok(folded.foldedLines >= 12)
    assert.match(folded.text, /folded 12 green build\/test lines/)
    assert.match(folded.text, /Worker 0 failed with exit code 1/)
    assert.match(folded.text, /tail summary line 14/)

    // JSON preservation
    const jsonOut = JSON.stringify({ items: [1, 2, 3] })
    assert.equal(compactTerminalStream(jsonOut, true).text, jsonOut)

    // Failure head-tail packing keeps root cause AND final summary within budget
    const bigFail = [
      ...Array.from({ length: 10 }, (_, i) => `setup step ${i}`),
      'TypeError: Cannot read properties of undefined (reading "rootCause")',
      ...Array.from({ length: 200 }, (_, i) => `  at stackFrame_${i} (file_${i}.ts:${i}:1)`),
      'FINAL_FAILURE_SUMMARY: 1 test failed',
    ].join('\n')
    const packed = packFailureHeadTail(bigFail, 1200)
    assert.equal(packed.truncated, true)
    assert.ok(Buffer.byteLength(packed.text, 'utf8') <= 1200)
    assert.match(packed.text, /rootCause/)
    assert.match(packed.text, /FINAL_FAILURE_SUMMARY/)
  })

  it('SpillStore.pageResult defaults to 7,200 B on clean line boundaries with exact nextOffset and clips oversized single lines', () => {
    const spillDataDir = mkdtempSync(join(tmpdir(), 'agy-pulse-p1-spill-'))
    try {
      const store = new SpillStore(spillDataDir)
      const lines = Array.from(
        { length: 220 },
        (_, i) => `ROW_${String(i + 1).padStart(3, '0')} payload_${'z'.repeat(72)}`,
      ).join('\n')
      const saved = store.save({ stdout: `${lines}\n`, stderr: '' })

      const page1 = store.pageResult({ refId: saved.refId, offset: 1, limit: 200 })
      assert.ok(Buffer.byteLength(page1.content, 'utf8') <= 7_200)
      assert.equal(page1.complete, false)
      assert.equal(page1.nextOffset, page1.offset + page1.returnedLines)
      const p1Lines = page1.content.split('\n')
      assert.equal(p1Lines.length, page1.returnedLines)
      assert.match(p1Lines[p1Lines.length - 1], /^(\d+): ROW_\d{3} payload_z{72}$/)

      const page2 = store.pageResult({ refId: saved.refId, offset: page1.nextOffset, limit: 200 })
      assert.equal(page2.offset, page1.nextOffset)
      assert.ok(page2.returnedLines > 0)
      assert.ok(Buffer.byteLength(page2.content, 'utf8') <= 7_200)

      // Single line exceeding 7,200 B is safely UTF-8 clipped with notice
      const singleHuge = store.save({ stdout: `HUGE_${'é'.repeat(4200)}\n`, stderr: '' })
      const hugePage = store.pageResult({ refId: singleHuge.refId, offset: 1, limit: 200 })
      assert.equal(hugePage.returnedLines, 1)
      assert.equal(hugePage.complete, true)
      assert.equal(hugePage.nextOffset, null)
      assert.ok(Buffer.byteLength(hugePage.content, 'utf8') <= 7_200)
      assert.match(hugePage.content, /\.\.\.\[line clipped\]$/)
    } finally {
      rmSync(spillDataDir, { recursive: true, force: true })
    }
  })

  it('v0.5.0: waterFill + truncateMiddle distribute budgets fairly and preserve head/tail markers', () => {
    // Short items keep full length; large items split remaining budget evenly.
    assert.deepEqual(waterFill([100, 1000, 1000], 900), [100, 400, 400])
    assert.deepEqual(waterFill([50, 80, 90], 500), [50, 80, 90])

    const longText = `HEAD_MARKER_${'a'.repeat(400)}_TAIL_MARKER`
    const mid = truncateMiddle(longText, 120)
    assert.equal(mid.truncated, true)
    assert.ok(Buffer.byteLength(mid.text, 'utf8') <= 120)
    assert.ok(mid.text.includes('HEAD_MARKER_'))
    assert.ok(mid.text.includes('_TAIL_MARKER'))
    assert.match(mid.text, /\[\u2026 \d+ chars omitted \u2026\]/)
  })

  it('v0.5.0: strict config validation, exec env hijack stripping, and git_status credential redaction', async () => {
    const unknownErrs = validateConfigPatch({ defaultShell: 'auto', typoOption: true })
    assert.ok(unknownErrs.some((e) => e.field === 'typoOption' && /Unknown configuration key/.test(e.message)))
    assert.deepEqual(validateConfigPatch({ maxInlineBytes: 7_200 }), [])

    const env = buildNonInteractiveEnv({
      SAFE_USER_FLAG: 'yes',
      LD_PRELOAD: '/tmp/evil.so',
      node_options: '--require=/tmp/evil.js',
      GIT_SSH_COMMAND: 'evil',
      BASH_ENV: '/tmp/evil.sh',
      PYTHONSTARTUP: '/tmp/evil.py',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
    })
    assert.equal(env.SAFE_USER_FLAG, 'yes')
    assert.notEqual(env.LD_PRELOAD, '/tmp/evil.so')
    assert.notEqual(env.node_options, '--require=/tmp/evil.js')
    assert.notEqual(env.GIT_SSH_COMMAND, 'evil')
    assert.notEqual(env.BASH_ENV, '/tmp/evil.sh')
    assert.notEqual(env.PYTHONSTARTUP, '/tmp/evil.py')
    assert.notEqual(env.DYLD_INSERT_LIBRARIES, '/tmp/evil.dylib')

    // git_status redacts credential-fenced files (.env, private.pem) while preserving normal files
    const gitDir = mkdtempSync(join(tmpdir(), 'agy-pulse-git-fence-'))
    try {
      execFileSync('git', ['init'], { cwd: gitDir, stdio: 'ignore' })
      writeFileSync(join(gitDir, 'index.ts'), 'export const ok = 1\n', 'utf8')
      writeFileSync(join(gitDir, '.env'), 'SECRET=123\n', 'utf8')
      writeFileSync(join(gitDir, 'private.pem'), 'KEY\n', 'utf8')
      const res = await runGitStatus(gitDir, { maxInlineBytes: 7_800, credentialFence: true })
      assert.equal(res.ok, true)
      assert.ok(res.gitText.includes('index.ts'))
      assert.ok(!res.gitText.includes('.env'))
      assert.ok(!res.gitText.includes('private.pem'))
      assert.match(res.gitText, /\[redacted 2 credential-fenced file\(s\)\]/)
    } finally {
      rmSync(gitDir, { recursive: true, force: true })
    }
  })

  it('v0.5.0: incremental transcript tailing, cache_creation_input_tokens, symbol dedup spans, and session persistence', () => {
    assert.deepEqual(resolveModelContextLimit('gpt-5.4'), { limit: 1_000_000, estimated: true })
    assert.deepEqual(resolveModelContextLimit('grok-4'), { limit: 256_000, estimated: true })
    assert.deepEqual(resolveModelContextLimit('deepseek-r1'), { limit: 128_000, estimated: true })

    const tmpData = mkdtempSync(join(tmpdir(), 'agy-pulse-v05-unit-'))
    try {
      const txFile = join(tmpData, 'tail-transcript.jsonl')
      const turn1 = JSON.stringify({
        type: 'PLANNER_RESPONSE',
        model: 'claude-sonnet-4-5',
        input_tokens: 1_000,
        cache_creation_input_tokens: 4_000,
        cache_read_tokens: 15_000,
        output_tokens: 500,
        created_at: '2026-11-26T10:00:00Z',
      })
      writeFileSync(txFile, `${turn1}\n`, 'utf8')

      const u1 = readConversationContextUsage('conv-tail-test', tmpData, txFile)
      assert.ok(u1)
      assert.equal(u1.turnCount, 1)
      assert.equal(u1.cacheCreationInputTokens, 4_000)
      assert.equal(u1.uncachedInputTokens, 5_000)
      assert.equal(u1.promptTokens, 20_000)
      assert.equal(u1.contextTokens, 20_500)

      // Append a second turn -> incremental byte-offset tailing picks it up cleanly
      const turn2 = JSON.stringify({
        type: 'PLANNER_RESPONSE',
        model: 'claude-sonnet-4-5',
        input_tokens: 2_000,
        cache_read_tokens: 20_000,
        output_tokens: 1_000,
        created_at: '2026-11-26T10:01:00Z',
      })
      appendFileSync(txFile, `${turn2}\n`, 'utf8')
      const u2 = readConversationContextUsage('conv-tail-test', tmpData, txFile)
      assert.ok(u2)
      assert.equal(u2.turnCount, 2)
      assert.equal(u2.contextTokens, 23_000)
      assert.equal(u2.totalOutputTokens, 1_500)

      // Truncate/rewrite file smaller -> falls back to full re-parse cleanly
      writeFileSync(txFile, `${turn1}\n`, 'utf8')
      const u3 = readConversationContextUsage('conv-tail-test', tmpData, txFile)
      assert.ok(u3)
      assert.equal(u3.turnCount, 1)
      assert.equal(u3.contextTokens, 20_500)

      // Symbol read indexes textRanges AND persists across SessionManager reload
      const spillStore = new SpillStore(tmpData)
      const sm1 = new SessionManager({ dataDir: tmpData, spillStore })
      const ctx1 = sm1.getSession('sess-persist-dedup')
      const body = Array.from({ length: 20 }, (_, i) => `${i + 10}|export function fn_${i}() { return ${i}; }`).join('\n')
      ctx1.readDedupStore.record({
        path: join(tmpData, 'mod.ts'),
        exists: true,
        bytes: Buffer.byteLength(body, 'utf8'),
        lineCount: 100,
        revision: 'a'.repeat(64),
        view: 'symbol',
        symbol: 'fn_0',
        offset: 10,
        returnedLines: 20,
        nextOffset: null,
        eof: true,
        content: body,
      })
      ctx1.telemetryStore.record({ rawBytes: 1000, deliveredBytes: 200, durationMs: 5 })
      sm1.flushAll()

      const sm2 = new SessionManager({ dataDir: tmpData, spillStore })
      const ctx2 = sm2.getSession('sess-persist-dedup')
      assert.equal(ctx2.readDedupStore.size(), 1)
      // Subset text read inside L10-L29 hits deduplication after reload!
      const subsetHit = ctx2.readDedupStore.check({
        path: join(tmpData, 'mod.ts'),
        exists: true,
        bytes: Buffer.byteLength(body, 'utf8'),
        lineCount: 100,
        revision: 'a'.repeat(64),
        view: 'text',
        offset: 12,
        returnedLines: 10,
        nextOffset: null,
        eof: true,
        content: body,
      })
      assert.equal(subsetHit.deduplicated, true)
    } finally {
      rmSync(tmpData, { recursive: true, force: true })
    }
  })

  it('v0.5.1: partial delivered-range read dedup caches head/tail without marking omitted lines, and telemetry tracks median/ops latency + batch-mutate trips', () => {
    const truncatedBody = [
      '1|const a = 1',
      '2|const b = 2',
      '3|const c = 3',
      '4|const d = 4',
      '5|const e = 5',
      '',
      '[… 2400 chars omitted …]',
      '',
      '80|const tailCut = 80',
      '81|const t1 = 81',
      '82|const t2 = 82',
      '83|const t3 = 83',
      '84|const t4 = 84',
      '...[truncated inline; page full output via pulse_result]',
    ].join('\n')

    const intervals = extractDeliveredLineIntervals(truncatedBody)
    assert.deepEqual(intervals, [
      { start: 1, end: 4 },
      { start: 81, end: 83 },
    ])

    const store = new ReadDedupStore(() => true)
    const fakePath = join(wsDir, 'partial-dedup.ts')
    const rev = 'b'.repeat(64)
    store.recordLineRanges(fakePath, rev, intervals)
    assert.equal(store.size(), 1)

    const padContent = 'x'.repeat(240)
    const headHit = store.check({
      path: fakePath,
      exists: true,
      bytes: 4000,
      lineCount: 100,
      revision: rev,
      view: 'text',
      offset: 1,
      returnedLines: 4,
      nextOffset: 5,
      eof: false,
      content: padContent,
    })
    assert.equal(headHit.deduplicated, true)

    const omittedMiss = store.check({
      path: fakePath,
      exists: true,
      bytes: 4000,
      lineCount: 100,
      revision: rev,
      view: 'text',
      offset: 30,
      returnedLines: 20,
      nextOffset: 50,
      eof: false,
      content: padContent,
    })
    assert.equal(omittedMiss.deduplicated, false)

    // TelemetryStore separates median + workspace ops latency from slow shell exec calls
    // and records roundTripsSaved on batch-mutate.
    const tel = new TelemetryStore()
    tel.record({ rawBytes: 2000, deliveredBytes: 400, durationMs: 18 })
    tel.record({ rawBytes: 2000, deliveredBytes: 400, durationMs: 26 })
    tel.record({
      rawBytes: 500,
      deliveredBytes: 500,
      savedBytes: 0,
      durationMs: 30,
      roundTripsSaved: 4,
      categories: { 'batch-mutate': { calls: 1, savedBytes: 0, roundTripsSaved: 4 } },
    })
    tel.record({ rawBytes: 10000, deliveredBytes: 1000, durationMs: 40_000, isShellExec: true })

    const sum = tel.getSummary()
    assert.equal(sum.medianDurationMs, 28)
    assert.equal(sum.opsAvgDurationMs, 25)
    assert.ok(sum.avgDurationMs > 9_000)
    assert.equal(sum.byCategory['batch-mutate'].roundTripsSaved, 4)
  })

  it('v0.5.0: ExecEngine settles promptly via exit grace window even when a grandchild inherits stdio pipes', async () => {
    const tmpData = mkdtempSync(join(tmpdir(), 'agy-pulse-exec-grace-'))
    const configStore = new ConfigStore(tmpData)
    const spillStore = new SpillStore(tmpData, () => configStore.get())
    const jobManager = new JobManager({ spillStore })
    const engine = new ExecEngine({
      configStore,
      shellDiscovery: new ShellDiscovery(),
      spillStore,
      jobManager,
      getWorkspaceRoots: async () => [wsDir],
    })
    const scriptFile = join(wsDir, 'spawn-grandchild.mjs')
    writeFileSync(
      scriptFile,
      [
        "import { spawn } from 'node:child_process'",
        "import { tmpdir } from 'node:os'",
        "console.log('PARENT_DONE')",
        // Spawn a grandchild that inherits stdout/stderr and sleeps 4s before exiting
        "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { cwd: tmpdir(), stdio: 'inherit', detached: true, windowsHide: true })",
        "console.log('GRANDCHILD_PID=' + child.pid)",
        'child.unref()',
        'process.exit(0)',
      ].join('\n'),
      'utf8',
    )
    let grandchildPid = 0
    try {
      const started = Date.now()
      const res = await engine.execute({
        description: 'Test grandchild pipe grace',
        command: `node "${scriptFile}"`,
        timeoutMs: 8_000,
      })
      const elapsed = Date.now() - started
      assert.equal(res.status, 'completed')
      assert.equal(res.exitCode, 0)
      assert.match(res.stdout, /PARENT_DONE/)
      const pidMatch = /GRANDCHILD_PID=(\d+)/.exec(res.stdout)
      if (pidMatch) grandchildPid = Number.parseInt(pidMatch[1], 10)
      // Should finish promptly via exit grace window rather than hanging for 4000ms grandchild exit or 8000ms timeout
      assert.ok(elapsed < 2_500, `Expected prompt settlement via exit grace window, took ${elapsed}ms`)
    } finally {
      if (grandchildPid > 0) {
        try {
          process.kill(grandchildPid, 'SIGKILL')
        } catch {
          // Already exited.
        }
      }
      await jobManager.disposeAll()
      rmSync(scriptFile, { force: true })
      rmSync(tmpData, { recursive: true, force: true })
    }
  })
})
