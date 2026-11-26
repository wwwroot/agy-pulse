// Renders deterministic 2x PNG snapshots of the agy-pulse sidecar UI from frozen-clock fixtures.
// Usage: node scripts/render-ui-snapshots.mjs [--out <dir>] [--fixtures healthy,near-full,degraded,empty]
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SIDECAR_DIR = join(ROOT, 'sidecars', 'pulse')
const DIST_DIR = join(SIDECAR_DIR, 'dist')
const FIXTURES_DIR = join(ROOT, 'test', 'fixtures')

const DEFAULT_FIXTURES = ['healthy', 'near-full', 'degraded', 'empty']
const VIEWPORTS = [
  { name: '360', width: 360, height: 760 },
  { name: '640', width: 640, height: 820 },
]
const THEMES = [
  { name: 'dark', bg: '#181818', fg: '#e4e4e7' },
  { name: 'light', bg: '#f8f9fb', fg: '#0f172a' },
]

function parseArgs(argv) {
  let outDir = join(ROOT, 'tmp', 'ui-snapshots')
  let fixtures = DEFAULT_FIXTURES
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out' && argv[i + 1]) {
      outDir = resolve(argv[++i])
    } else if (arg === '--fixtures' && argv[i + 1]) {
      fixtures = argv[++i]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }
  }
  return { outDir, fixtures }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function startStaticServer() {
  return new Promise((resolveServer, reject) => {
    const server = createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0]
      let filePath = null

      if (urlPath === '/' || urlPath === '/index.html') {
        filePath = join(SIDECAR_DIR, 'index.html')
      } else if (urlPath === '/main.js') {
        filePath = join(DIST_DIR, 'main.js')
      } else if (urlPath === '/styles.css') {
        filePath = join(DIST_DIR, 'styles.css')
      } else if (urlPath === '/preload.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
        res.end('// snapshot harness stub preload\n')
        return
      } else if (urlPath.startsWith('/fixtures/')) {
        const name = urlPath.slice('/fixtures/'.length).replace(/[^a-zA-Z0-9._-]/g, '')
        filePath = join(FIXTURES_DIR, name)
      }

      if (!filePath || !existsSync(filePath)) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      const ext = extname(filePath)
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
      res.end(readFileSync(filePath))
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolveServer({ server, port: addr.port })
    })
  })
}

async function main() {
  const { outDir, fixtures } = parseArgs(process.argv.slice(2))

  if (!existsSync(join(DIST_DIR, 'main.js')) || !existsSync(join(DIST_DIR, 'styles.css'))) {
    console.error('[render-ui-snapshots] Built client bundle not found. Run `npm run build` first.')
    process.exit(1)
  }

  let playwright
  try {
    playwright = await import('playwright')
  } catch {
    console.log(
      '[render-ui-snapshots] Playwright is not installed in this environment.\n' +
        'Install it temporarily (e.g. `npm i --no-save playwright && npx playwright install chromium`) ' +
        'and re-run `node scripts/render-ui-snapshots.mjs` to capture 2x PNG snapshots.',
    )
    process.exit(0)
  }

  mkdirSync(outDir, { recursive: true })
  const { server, port } = await startStaticServer()
  const browser = await playwright.chromium.launch()

  try {
    for (const fixtureName of fixtures) {
      const fixtureFile = join(FIXTURES_DIR, `sidecar-${fixtureName}.json`)
      if (!existsSync(fixtureFile)) {
        console.warn(`[render-ui-snapshots] Skipping missing fixture: ${fixtureFile}`)
        continue
      }
      const fixtureData = JSON.parse(readFileSync(fixtureFile, 'utf8'))

      for (const theme of THEMES) {
        for (const vp of VIEWPORTS) {
          const context = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
            deviceScaleFactor: 2,
            colorScheme: theme.name,
            reducedMotion: 'reduce',
          })
          const page = await context.newPage()
          await page.addInitScript(
            ({ data, t }) => {
              window.__AGY_PULSE_FIXTURE__ = data
              document.documentElement.style.setProperty('--background', t.bg)
              document.documentElement.style.setProperty('--foreground', t.fg)
              document.documentElement.setAttribute('data-theme', t.name)
            },
            { data: fixtureData, t: theme },
          )

          await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' })
          await page.waitForSelector('header', { timeout: 5000 })

          const outPath = join(outDir, `${fixtureName}-${vp.name}px-${theme.name}.png`)
          await page.screenshot({ path: outPath })
          console.log('[render-ui-snapshots] Wrote', outPath)
          await context.close()
        }
      }
    }
  } finally {
    await browser.close()
    server.close()
  }
}

await main()
