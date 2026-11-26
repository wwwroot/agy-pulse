import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path, { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  checkCredentialFence,
  checkDownloadGuard,
  detectSleepPolling,
} from '../src/shared/guards.ts'
import {
  normalizeWorkdir,
  resolveAuthorizedFile,
  resolveDataDir,
} from '../src/shared/paths.ts'

describe('resolveDataDir', () => {
  it('aligns default plugin_data directory with Antigravity PLUGIN_DATA and respects env precedence', () => {
    const saved = {
      AGY_PULSE_DATA_DIR: process.env.AGY_PULSE_DATA_DIR,
      PLUGIN_DATA: process.env.PLUGIN_DATA,
      ANTIGRAVITY_APP_DATA_DIR: process.env.ANTIGRAVITY_APP_DATA_DIR,
    }
    try {
      delete process.env.AGY_PULSE_DATA_DIR
      delete process.env.PLUGIN_DATA
      delete process.env.ANTIGRAVITY_APP_DATA_DIR

      assert.equal(
        resolveDataDir(),
        path.join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-pulse'),
      )

      process.env.ANTIGRAVITY_APP_DATA_DIR = path.join(homedir(), 'custom-agy')
      assert.equal(
        resolveDataDir(),
        path.join(path.resolve(homedir(), 'custom-agy'), 'plugin_data', 'agy-pulse'),
      )

      process.env.PLUGIN_DATA = path.join(homedir(), 'explicit-plugin-data')
      assert.equal(resolveDataDir(), path.resolve(homedir(), 'explicit-plugin-data'))

      process.env.AGY_PULSE_DATA_DIR = path.join(homedir(), 'explicit-agy-term-data')
      assert.equal(resolveDataDir(), path.resolve(homedir(), 'explicit-agy-term-data'))
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

describe('normalizeWorkdir & resolveAuthorizedFile', () => {
  it('resolves Windows absolute and workspace-relative paths inside workspace roots', () => {
    const roots = ['D:\\repo', 'C:\\shared-lib']

    const defaultRes = normalizeWorkdir(undefined, roots, 'win32')
    assert.equal(defaultRes.ok, true)
    assert.equal(defaultRes.path.toLowerCase(), 'd:\\repo')

    const relRes = normalizeWorkdir('packages/app', roots, 'win32')
    assert.equal(relRes.ok, true)
    assert.equal(relRes.path.toLowerCase(), 'd:\\repo\\packages\\app')

    const secondRootRes = normalizeWorkdir('C:\\shared-lib\\utils', roots, 'win32')
    assert.equal(secondRootRes.ok, true)
    assert.equal(secondRootRes.path.toLowerCase(), 'c:\\shared-lib\\utils')
  })

  it('normalizes MSYS drive paths (/d/repo -> D:\\repo) on Windows', () => {
    const roots = ['D:\\repo']

    const exact = normalizeWorkdir('/d/repo', roots, 'win32')
    assert.equal(exact.ok, true)
    assert.equal(exact.path, 'D:\\repo')

    const nested = normalizeWorkdir('/d/repo/src/server', roots, 'win32')
    assert.equal(nested.ok, true)
    assert.equal(nested.path, 'D:\\repo\\src\\server')

    const driveRoot = normalizeWorkdir('/c', ['C:\\'], 'win32')
    assert.equal(driveRoot.ok, true)
    assert.equal(driveRoot.path, 'C:\\')
  })

  it('rejects drive-less POSIX paths (/tmp, /etc) on Windows with effectState=none', () => {
    const roots = ['D:\\repo']

    for (const badPath of ['/tmp', '/tmp/output', '/etc/passwd', '/']) {
      const res = normalizeWorkdir(badPath, roots, 'win32')
      assert.equal(res.ok, false, `Expected "${badPath}" to be rejected`)
      assert.equal(res.failure.code, 'INVALID_WORKDIR_POSIX_ON_WINDOWS')
      assert.equal(res.failure.effectState, 'none')
      assert.equal(res.failure.retry, 'after-input-change')
    }
  })

  it('rejects Windows drive-relative paths such as D:sub or C:foo', () => {
    const roots = ['D:\\repo']
    const res = normalizeWorkdir('C:foo', roots, 'win32')
    assert.equal(res.ok, false)
    assert.equal(res.failure.code, 'CROSS_DRIVE_RELATIVE_PATH')
    assert.equal(res.failure.effectState, 'none')
  })

  it('rejects workspace jail escape attempts on Windows and POSIX', () => {
    const winEscapeRel = normalizeWorkdir('..\\outside', ['D:\\repo'], 'win32')
    assert.equal(winEscapeRel.ok, false)
    assert.equal(winEscapeRel.failure.code, 'WORKDIR_OUTSIDE_WORKSPACE')
    assert.equal(winEscapeRel.failure.effectState, 'none')

    const winEscapeAbs = normalizeWorkdir('C:\\Windows\\System32', ['D:\\repo'], 'win32')
    assert.equal(winEscapeAbs.ok, false)
    assert.equal(winEscapeAbs.failure.code, 'WORKDIR_OUTSIDE_WORKSPACE')
    assert.equal(winEscapeAbs.failure.effectState, 'none')

    const winEscapeMsys = normalizeWorkdir('/c/Windows', ['D:\\repo'], 'win32')
    assert.equal(winEscapeMsys.ok, false)
    assert.equal(winEscapeMsys.failure.code, 'WORKDIR_OUTSIDE_WORKSPACE')

    const posixEscape = normalizeWorkdir('/etc', ['/home/dev/repo'], 'linux')
    assert.equal(posixEscape.ok, false)
    assert.equal(posixEscape.failure.code, 'WORKDIR_OUTSIDE_WORKSPACE')
    assert.equal(posixEscape.failure.effectState, 'none')
  })

  it('validates resolveAuthorizedFile within workspace and rejects null bytes or escapes', () => {
    const okFile = resolveAuthorizedFile('scripts/test.ps1', ['D:\\repo'], 'win32')
    assert.equal(okFile.ok, true)
    assert.equal(okFile.path, 'D:\\repo\\scripts\\test.ps1')

    const outsideFile = resolveAuthorizedFile('..\\secret.ps1', ['D:\\repo'], 'win32')
    assert.equal(outsideFile.ok, false)
    assert.equal(outsideFile.failure.code, 'FILE_OUTSIDE_WORKSPACE')
    assert.equal(outsideFile.failure.effectState, 'none')

    const nullByte = normalizeWorkdir('sub\0dir', ['D:\\repo'], 'win32')
    assert.equal(nullByte.ok, false)
    assert.equal(nullByte.failure.code, 'INVALID_WORKDIR')
    assert.equal(nullByte.failure.effectState, 'none')
  })
})

describe('checkCredentialFence', () => {
  it('blocks access to .ssh, .aws, .kube, .azure, gcloud, docker, private keys, and .env files', () => {
    const blockedCommands = [
      'cat ~/.ssh/id_rsa',
      'type C:\\Users\\dev\\.ssh\\config',
      'cat $HOME/.aws/credentials',
      'Get-Content %USERPROFILE%\\.aws\\config',
      'cat .env',
      'cat ./config/.env.production',
      'type .env.local',
      'cat ~/.kube/config',
      'cat ~/.config/gcloud/credentials.db',
      'cat ~/.docker/config.json',
      'cat ./certs/server.pem',
      'cat ./keys/private.key',
      'cat service-account-prod.json',
    ]

    for (const cmd of blockedCommands) {
      const res = checkCredentialFence('', cmd)
      assert.equal(res.blocked, true, `Expected Credential Fence to block: ${cmd}`)
      assert.equal(res.failure?.code, 'CREDENTIAL_FENCE_BLOCKED')
      assert.equal(res.failure?.effectState, 'none')
    }

    const blockedTarget = checkCredentialFence('~/.ssh/id_ed25519')
    assert.equal(blockedTarget.blocked, true)
    assert.equal(blockedTarget.failure?.code, 'CREDENTIAL_FENCE_BLOCKED')
    assert.equal(blockedTarget.failure?.effectState, 'none')
  })

  it('allows .env.example, .env.sample, .env.template, and normal workspace commands', () => {
    const allowedCommands = [
      'cat .env.example',
      'type .env.sample',
      'cat ./config/.env.template',
      'cat .env.dist',
      'cat .env.schema',
      'npm run build && npm test',
      'git status --short',
    ]

    for (const cmd of allowedCommands) {
      const res = checkCredentialFence('', cmd)
      assert.equal(res.blocked, false, `Expected Credential Fence to allow: ${cmd}`)
    }

    const allowedTarget = checkCredentialFence('D:\\repo\\.env.example')
    assert.equal(allowedTarget.blocked, false)
  })
})

describe('checkDownloadGuard', () => {
  const template = 'Use aria2c -o {file} {url} instead.'

  it('blocks disk-writing curl, wget, Invoke-WebRequest, and Start-BitsTransfer commands', () => {
    const blockedCases = [
      {
        cmd: 'curl -L -o archive.tar.gz https://example.com/release.tar.gz',
        tool: 'curl',
        file: 'archive.tar.gz',
      },
      {
        cmd: 'curl -O https://example.com/tool.zip',
        tool: 'curl',
        file: 'tool.zip',
      },
      {
        cmd: 'curl https://example.com/data.json > data.json',
        tool: 'curl',
        file: 'data.json',
      },
      {
        cmd: 'wget https://example.com/installer.exe',
        tool: 'wget',
        file: 'installer.exe',
      },
      {
        cmd: 'wget -O pkg.tar.gz https://example.com/pkg.tar.gz',
        tool: 'wget',
        file: 'pkg.tar.gz',
      },
      {
        cmd: 'Invoke-WebRequest -Uri https://example.com/app.zip -OutFile app.zip',
        tool: 'Invoke-WebRequest',
        file: 'app.zip',
      },
      {
        cmd: 'iwr https://example.com/file.bin -OutFile:file.bin',
        tool: 'iwr',
        file: 'file.bin',
      },
      {
        cmd: 'Start-BitsTransfer -Source https://example.com/a.iso -Destination a.iso',
        tool: 'Start-BitsTransfer',
        file: 'a.iso',
      },
    ]

    for (const tc of blockedCases) {
      const res = checkDownloadGuard(tc.cmd, 'auto', template)
      assert.equal(res.blocked, true, `Expected Download Guard to block: ${tc.cmd}`)
      assert.equal(res.matchedTool, tc.tool)
      assert.equal(res.file, tc.file)
      assert.equal(res.failure?.code, 'DOWNLOAD_GUARD_BLOCKED')
      assert.equal(res.failure?.effectState, 'none')
      assert.ok(res.suggestion?.includes(tc.file))
      assert.ok(res.suggestion?.includes('https://example.com/'))
    }
  })

  it('allows --help flags, stdout streaming (-o -), /dev/null targets, and wget --spider', () => {
    const allowedCommands = [
      'curl --help',
      'curl -h',
      'wget --help',
      'Invoke-WebRequest -?',
      'curl -sS -o - https://example.com/health',
      'curl -sS -o /dev/null https://example.com/ping',
      'curl -sS https://example.com/api/status',
      'wget -qO- https://example.com/api/status',
      'wget -O - https://example.com/api/status',
      'wget --spider https://example.com/file.zip',
      'Invoke-WebRequest -Uri https://example.com/api',
    ]

    for (const cmd of allowedCommands) {
      const res = checkDownloadGuard(cmd, 'auto', template)
      assert.equal(res.blocked, false, `Expected Download Guard to allow: ${cmd}`)
    }
  })
})

describe('detectSleepPolling', () => {
  it('flags standalone sleep >= 20s and PowerShell Start-Sleep >= 20s', () => {
    const flagged = [
      'sleep 25',
      'sleep 20',
      'sleep 1m',
      'Start-Sleep 30',
      'Start-Sleep -Seconds 20',
      'Start-Sleep -Milliseconds 25000',
      'timeout /t 25',
    ]

    for (const cmd of flagged) {
      const nudge = detectSleepPolling(cmd)
      assert.ok(typeof nudge === 'string' && nudge.length > 0, `Expected sleep nudge for: ${cmd}`)
      assert.match(nudge, /pulse_job/)
      assert.match(nudge, /wait:\s*true/)
    }
  })

  it('allows short sleeps (< 20s) and compound commands', () => {
    const allowed = [
      'sleep 5',
      'sleep 19',
      'Start-Sleep 5',
      'Start-Sleep -Seconds 10',
      'Start-Sleep -Milliseconds 5000',
      'timeout /t 5',
      'sleep 25 && echo finished',
      'echo hello',
    ]

    for (const cmd of allowed) {
      const nudge = detectSleepPolling(cmd)
      assert.equal(nudge, null, `Expected no sleep nudge for: ${cmd}`)
    }
  })
})

const __guardsDir = dirname(fileURLToPath(import.meta.url))
const SESSION_HOOK_TS = resolve(__guardsDir, '..', 'src', 'hook', 'session-hook.ts')

function runSessionHookTs(payload, dataDir, extraEnv = {}) {
  return new Promise((resolveHook, rejectHook) => {
    const child = spawn(process.execPath, [SESSION_HOOK_TS], {
      env: {
        ...process.env,
        AGY_PULSE_DATA_DIR: dataDir,
        AGY_PULSE_HOOK_MODE: 'pretool-guard',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c) => {
      stdout += c
    })
    child.stderr.on('data', (c) => {
      stderr += c
    })
    child.once('error', rejectHook)
    child.once('close', (code) => resolveHook({ code, stdout: stdout.trim(), stderr }))
    child.stdin.end(JSON.stringify(payload))
  })
}

describe('Swarm PreToolUse overwrite hook (session-hook.ts)', () => {
  it('injects --cli/--cwd/--session tip on swarm add, skips monitor/narrator, is idempotent, and fails open', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agy-pulse-swarm-hook-'))
    const ws = resolve(__guardsDir, '..')
    try {
      // 1. Worker add -> injects overwrite.brief with --cli, --cwd, --session "swarm-<name>"
      const addWorker = await runSessionHookTs(
        {
          hookEventName: 'PreToolUse',
          conversationId: 'conv-swarm-1',
          workspacePaths: [ws],
          toolCall: {
            id: 'tc-1',
            name: 'swarm',
            args: { action: 'add', name: 'rust-dev', brief: 'Implement summary helper.' },
          },
        },
        dataDir,
      )
      assert.equal(addWorker.code, 0, addWorker.stderr)
      const parsedAdd = JSON.parse(addWorker.stdout)
      assert.equal(parsedAdd.decision, 'allow')
      assert.ok(typeof parsedAdd.overwrite?.brief === 'string')
      assert.match(parsedAdd.overwrite.brief, /^Implement summary helper\./)
      assert.match(parsedAdd.overwrite.brief, /\[agy-pulse swarm\]/)
      assert.match(parsedAdd.overwrite.brief, /--cli <outline\|read\|search\|mutate\|exec\|result>/)
      assert.match(parsedAdd.overwrite.brief, /--session "swarm-rust-dev"/)
      assert.ok(parsedAdd.overwrite.brief.includes(`--cwd "${ws}"`))

      // 2. Skips monitor & narrator (including numbered suffixes)
      for (const skipName of ['monitor', 'monitor-1', 'narrator', 'narrator-2']) {
        const res = await runSessionHookTs(
          {
            hookEventName: 'PreToolUse',
            workspacePaths: [ws],
            toolCall: {
              name: 'swarm',
              args: { action: 'add', name: skipName, brief: 'Watch board.' },
            },
          },
          dataDir,
        )
        assert.equal(res.code, 0)
        assert.deepEqual(JSON.parse(res.stdout), { decision: 'allow' })
      }

      // 3. Idempotent when brief already contains [agy-pulse swarm] or --cli
      for (const existingBrief of [
        'Task\n\n[agy-pulse swarm] already injected',
        'Run node mcp-server.mjs --cli outline src/a.ts',
      ]) {
        const res = await runSessionHookTs(
          {
            hookEventName: 'PreToolUse',
            workspacePaths: [ws],
            toolCall: {
              name: 'swarm',
              args: { action: 'add', name: 'worker-a', brief: existingBrief },
            },
          },
          dataDir,
        )
        assert.equal(res.code, 0)
        assert.deepEqual(JSON.parse(res.stdout), { decision: 'allow' })
      }

      // 4. Ignores non-add actions (status, kill, model, title)
      for (const action of ['status', 'kill', 'model', 'title']) {
        const res = await runSessionHookTs(
          {
            hookEventName: 'PreToolUse',
            workspacePaths: [ws],
            toolCall: {
              name: 'swarm',
              args: { action, name: 'rust-dev', brief: 'unused' },
            },
          },
          dataDir,
        )
        assert.equal(res.code, 0)
        assert.deepEqual(JSON.parse(res.stdout), { decision: 'allow' })
      }

      // 5. Respects AGY_PULSE_DISABLE_TOOL_GUARD=1 and fails open on missing fields
      const disabled = await runSessionHookTs(
        {
          hookEventName: 'PreToolUse',
          workspacePaths: [ws],
          toolCall: {
            name: 'swarm',
            args: { action: 'add', name: 'rust-dev', brief: 'Do work' },
          },
        },
        dataDir,
        { AGY_PULSE_DISABLE_TOOL_GUARD: '1' },
      )
      assert.equal(disabled.code, 0)
      assert.deepEqual(JSON.parse(disabled.stdout), { decision: 'allow' })

      const missingName = await runSessionHookTs(
        {
          hookEventName: 'PreToolUse',
          workspacePaths: [ws],
          toolCall: { name: 'swarm', args: { action: 'add', brief: 'Do work' } },
        },
        dataDir,
      )
      assert.equal(missingName.code, 0)
      assert.deepEqual(JSON.parse(missingName.stdout), { decision: 'allow' })
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('persists transcriptPath in active-session.json and session-transcripts.json across hook events', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agy-pulse-transcript-hook-'))
    const ws = resolve(__guardsDir, '..')
    const txPath = join(ws, 'fake-transcript.jsonl')
    try {
      const startRes = await runSessionHookTs(
        {
          hookEventName: 'SessionStart',
          conversationId: 'conv-tx-1',
          workspacePaths: [ws],
          transcript_path: txPath,
        },
        dataDir,
        { AGY_PULSE_HOOK_MODE: '', AGY_PULSE_DISABLE_SNAPSHOT: '1' },
      )
      assert.equal(startRes.code, 0, startRes.stderr)

      const active = JSON.parse(readFileSync(join(dataDir, 'active-session.json'), 'utf8'))
      assert.equal(active.conversationId, 'conv-tx-1')
      assert.equal(active.transcriptPath, txPath)

      const registry = JSON.parse(readFileSync(join(dataDir, 'session-transcripts.json'), 'utf8'))
      assert.equal(registry.sessions['conv-tx-1'].transcriptPath, txPath)

      // Subsequent PreInvocation without transcriptPath must preserve active-session.json transcriptPath
      const preInvRes = await runSessionHookTs(
        {
          hookEventName: 'PreInvocation',
          conversationId: 'conv-tx-1',
          workspacePaths: [ws],
        },
        dataDir,
        { AGY_PULSE_HOOK_MODE: '' },
      )
      assert.equal(preInvRes.code, 0)
      const activeAfter = JSON.parse(readFileSync(join(dataDir, 'active-session.json'), 'utf8'))
      assert.equal(activeAfter.transcriptPath, txPath)
    } finally {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })
})
