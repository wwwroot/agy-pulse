import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { run } from 'node:test'
import { spec } from 'node:test/reporters'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PREFERRED_ORDER = [
  'guards.test.mjs',
  'client-format.test.mjs',
  'v050-upgrades.test.mjs',
  'rust-worker.test.mjs',
  'server-e2e.test.mjs',
  'mcp-e2e.test.mjs',
]

function discoverTestFiles() {
  const discovered = readdirSync(__dirname)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort((a, b) => {
      const ia = PREFERRED_ORDER.indexOf(a)
      const ib = PREFERRED_ORDER.indexOf(b)
      if (ia !== -1 && ib !== -1) return ia - ib
      if (ia !== -1) return -1
      if (ib !== -1) return 1
      return a.localeCompare(b)
    })

  const filters = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
  const selected =
    filters.length > 0
      ? discovered.filter((name) =>
          filters.some((f) => name.toLowerCase().includes(f.toLowerCase())),
        )
      : discovered

  return selected.map((name) => join(__dirname, name))
}

const files = discoverTestFiles()
if (files.length === 0) {
  console.error('[test] No matching *.test.mjs files found under test/.')
  process.exit(1)
}

console.log(`[test] Running ${files.length} test file(s):`)
for (const f of files) {
  console.log(`  - ${f}`)
}

let failedCount = 0
let passedCount = 0
let skippedCount = 0

const stream = run({
  files,
  concurrency: false,
})

stream.on('test:pass', (ev) => {
  if (ev.details?.type !== 'suite') passedCount += 1
})

stream.on('test:fail', (ev) => {
  if (ev.details?.type !== 'suite') failedCount += 1
})

stream.on('test:skip', () => {
  skippedCount += 1
})

stream.on('error', (err) => {
  console.error('[test] Runner stream error:', err)
  failedCount += 1
})

stream.compose(spec).pipe(process.stdout)

await new Promise((resolve) => {
  stream.once('end', resolve)
  stream.once('close', resolve)
})

if (failedCount > 0) {
  console.error(
    `\n[test] FAILED: ${failedCount} failed, ${passedCount} passed, ${skippedCount} skipped.`,
  )
  process.exit(1)
}

console.log(
  `\n[test] PASSED: ${passedCount} passed, ${failedCount} failed, ${skippedCount} skipped.`,
)
