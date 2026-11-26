import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DIST_DIR = join(ROOT, 'sidecars', 'pulse', 'dist')
const NATIVE_DIR = join(ROOT, 'native')
const NATIVE_CARGO_TOML = join(NATIVE_DIR, 'Cargo.toml')
const WORKER_BIN_NAME = process.platform === 'win32' ? 'agy-pulse-worker.exe' : 'agy-pulse-worker'
const LEGACY_PTY_BIN_PREFIX = 'agy-pulse-pty'
const CARGO_TARGET_DIR =
  process.env.CARGO_TARGET_DIR ||
  (process.platform === 'win32'
    ? join(tmpdir(), 'agy-pulse-cargo-target')
    : join(NATIVE_DIR, 'target'))
const TARGET_RELEASE_BIN = join(CARGO_TARGET_DIR, 'release', WORKER_BIN_NAME)
const FALLBACK_NATIVE_BIN = join(NATIVE_DIR, 'target', 'release', WORKER_BIN_NAME)
const DIST_WORKER_BIN = join(DIST_DIR, WORKER_BIN_NAME)

const skipRust = process.argv.includes('--skip-rust')

const ESM_REQUIRE_BANNER =
  "import { createRequire as __agyCreateRequire } from 'node:module'; const require = __agyCreateRequire(import.meta.url);"

function isLockError(err) {
  if (!err || typeof err !== 'object') return false
  const code = 'code' in err ? err.code : undefined
  const errno = 'errno' in err ? err.errno : undefined
  return (
    code === 'EBUSY' ||
    code === 'EPERM' ||
    code === 'EACCES' ||
    code === 'EPIPE' ||
    errno === 32
  )
}

function cleanDistDir() {
  mkdirSync(DIST_DIR, { recursive: true })
  for (const name of readdirSync(DIST_DIR)) {
    if (skipRust && name === WORKER_BIN_NAME) continue
    const fullPath = join(DIST_DIR, name)
    try {
      rmSync(fullPath, { recursive: true, force: true })
    } catch (err) {
      if (
        (name === WORKER_BIN_NAME || name.startsWith(LEGACY_PTY_BIN_PREFIX)) &&
        isLockError(err)
      ) {
        // Windows locks running .exe files against deletion, yet permits renaming in the same directory.
        renameSync(fullPath, `${fullPath}.old.${Date.now()}`)
      } else if (
        name.startsWith(`${WORKER_BIN_NAME}.old.`) ||
        name.startsWith(`${LEGACY_PTY_BIN_PREFIX}`)
      ) {
        // Best-effort cleanup of stale renamed or legacy binaries from prior builds.
      } else {
        throw err
      }
    }
  }
}

function copyWorkerBinary(src, dest) {
  try {
    copyFileSync(src, dest)
  } catch (err) {
    if (process.platform === 'win32' && existsSync(dest) && isLockError(err)) {
      renameSync(dest, `${dest}.old.${Date.now()}`)
      copyFileSync(src, dest)
    } else {
      throw err
    }
  }
}

function resolveBuiltWorkerBinary() {
  if (existsSync(TARGET_RELEASE_BIN)) return TARGET_RELEASE_BIN
  if (existsSync(FALLBACK_NATIVE_BIN)) return FALLBACK_NATIVE_BIN
  return null
}

function ensureExecutable(filePath) {
  if (process.platform !== 'win32' && existsSync(filePath)) {
    chmodSync(filePath, 0o755)
  }
}

function getWorkerReleaseUrl(version) {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const assetName = `agy-pulse-worker-${process.platform}-${process.arch}${ext}`
  return `https://github.com/wwwroot/agy-pulse/releases/download/v${version}/${assetName}`
}

async function downloadWorkerBinary(version, dest) {
  const url = getWorkerReleaseUrl(version)
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  })
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status} from ${url}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) {
    throw new Error(`Empty binary response from ${url}`)
  }

  mkdirSync(dirname(dest), { recursive: true })
  const tmpPath = `${dest}.download.${process.pid}`
  writeFileSync(tmpPath, buf)
  try {
    renameSync(tmpPath, dest)
  } catch (err) {
    if (process.platform === 'win32' && existsSync(dest) && isLockError(err)) {
      renameSync(dest, `${dest}.old.${Date.now()}`)
      renameSync(tmpPath, dest)
    } else {
      rmSync(tmpPath, { force: true })
      throw err
    }
  }
  ensureExecutable(dest)
  return url
}

async function buildRustOpsWorker(version) {
  if (!existsSync(NATIVE_CARGO_TOML)) {
    console.warn('[build] native/Cargo.toml not found; skipping agy-pulse-worker build')
    return
  }

  if (skipRust) {
    const prebuilt = resolveBuiltWorkerBinary()
    if (prebuilt) {
      copyWorkerBinary(prebuilt, DIST_WORKER_BIN)
      ensureExecutable(DIST_WORKER_BIN)
      console.log('[build] Copied prebuilt Rust ops worker (--skip-rust):', prebuilt)
    } else {
      console.log('[build] Skipping Rust ops worker build (--skip-rust)')
    }
    return
  }

  const cargoArgs = ['build', '--release', '--manifest-path', NATIVE_CARGO_TOML]
  if (process.platform === 'win32' || process.env.CARGO_TARGET_DIR) {
    // On Windows, compiling into a Medium-integrity temp target directory avoids Low Mandatory Level ACL issues on workspaces.
    cargoArgs.push('--target-dir', CARGO_TARGET_DIR)
  }

  console.log(
    '[build] Compiling Rust ops worker:',
    NATIVE_CARGO_TOML,
    `(target: ${CARGO_TARGET_DIR})`,
  )
  try {
    execFileSync('cargo', cargoArgs, { stdio: 'inherit', cwd: ROOT })
  } catch (cargoErr) {
    const fallback = resolveBuiltWorkerBinary()
    if (fallback) {
      console.warn(
        `[build] cargo build failed (${cargoErr instanceof Error ? cargoErr.message : String(cargoErr)}); falling back to existing binary at ${fallback}`,
      )
      copyWorkerBinary(fallback, DIST_WORKER_BIN)
      ensureExecutable(DIST_WORKER_BIN)
      console.log('[build] Copied fallback Rust ops worker to:', DIST_WORKER_BIN)
      return
    }

    const releaseUrl = getWorkerReleaseUrl(version)
    console.warn(
      `[build] cargo build failed and no local binary exists; downloading prebuilt worker from ${releaseUrl}`,
    )
    try {
      await downloadWorkerBinary(version, DIST_WORKER_BIN)
      console.log('[build] Downloaded Rust ops worker to:', DIST_WORKER_BIN)
      return
    } catch (downloadErr) {
      const cargoMsg = cargoErr instanceof Error ? cargoErr.message : String(cargoErr)
      const downloadMsg = downloadErr instanceof Error ? downloadErr.message : String(downloadErr)
      throw new Error(
        `Failed to build or download Rust ops worker. Local cargo build failed (${cargoMsg}), and release download from ${releaseUrl} failed (${downloadMsg}).`,
      )
    }
  }

  const builtBin = resolveBuiltWorkerBinary()
  if (!builtBin) {
    throw new Error(
      `Expected compiled Rust ops worker binary at ${TARGET_RELEASE_BIN} or ${FALLBACK_NATIVE_BIN}, but neither was found.`,
    )
  }

  copyWorkerBinary(builtBin, DIST_WORKER_BIN)
  ensureExecutable(DIST_WORKER_BIN)
  console.log('[build] Copied Rust ops worker to:', DIST_WORKER_BIN)
}

cleanDistDir()

await esbuild.build({
  entryPoints: [join(ROOT, 'src', 'server', 'main.ts')],
  outfile: join(DIST_DIR, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: ESM_REQUIRE_BANNER },
  sourcemap: false,
  logLevel: 'info',
})

await esbuild.build({
  entryPoints: [join(ROOT, 'src', 'mcp', 'main.ts')],
  outfile: join(DIST_DIR, 'mcp-server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: ESM_REQUIRE_BANNER },
  sourcemap: false,
  logLevel: 'info',
})

await esbuild.build({
  entryPoints: [join(ROOT, 'src', 'hook', 'session-hook.ts')],
  outfile: join(DIST_DIR, 'hook-session.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
})

await esbuild.build({
  entryPoints: [join(ROOT, 'src', 'client', 'index.tsx')],
  outfile: join(DIST_DIR, 'main.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['es2022', 'chrome115'],
  jsx: 'automatic',
  loader: {
    '.module.css': 'local-css',
    '.css': 'css',
  },
  minify: true,
  sourcemap: false,
  logLevel: 'info',
})

const emittedCss = join(DIST_DIR, 'main.css')
const targetCss = join(DIST_DIR, 'styles.css')
if (existsSync(emittedCss)) {
  renameSync(emittedCss, targetCss)
}

const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
await buildRustOpsWorker(pkgVersion)

console.log(`[build] Built agy-pulse v${pkgVersion} sidecar, MCP server, session hook, and Rust ops worker in`, DIST_DIR)
