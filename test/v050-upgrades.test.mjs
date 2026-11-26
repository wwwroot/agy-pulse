import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  renderCliHelpTty,
  renderDoctorPlain,
  renderDoctorTty,
  renderQuotasPlain,
  renderQuotasTty,
  renderStatsTty,
  visibleWidth,
  wrapKeep,
} from '../src/mcp/cli-ui.ts'
import { extractMetaClientInfo } from '../src/mcp/tools.ts'
import {
  inspectAntigravityHostHealth,
  repairAntigravityHostConfig,
} from '../src/server/host-health.ts'
import {
  AntigravityQuotaReader,
  findAgyAppServers,
  parseAgyGroups,
  parseAgyUsage,
  parseListeningPorts,
  parseWindowsListeningPorts,
  projectedUnused,
  safeRemainingFromUsedPct,
  scrubTokens,
} from '../src/server/quota-reader.ts'

const FROZEN_NOW = Date.UTC(2026, 10, 26, 12, 0, 0)

describe('v0.5.0 Antigravity quota reader (unit)', () => {
  it('computes IEEE-754-safe remaining fractions and projectedUnused waste forecasts', () => {
    assert.equal(safeRemainingFromUsedPct(98), 0.02)
    assert.equal(safeRemainingFromUsedPct(0), 1)
    assert.equal(safeRemainingFromUsedPct(100), 0)
    assert.equal(safeRemainingFromUsedPct(Number.NaN), 0)
    assert.equal(safeRemainingFromUsedPct(Infinity), 0)

    const resetsAt = FROZEN_NOW + 84 * 3_600_000
    const pu = projectedUnused(0.8, resetsAt, 168, FROZEN_NOW)
    assert.ok(pu !== null && Math.abs(pu - 0.6) < 1e-6)
    assert.equal(projectedUnused(0.5, null, 168, FROZEN_NOW), null)
    assert.equal(projectedUnused(0.5, FROZEN_NOW - 1000, 168, FROZEN_NOW), null)
    assert.equal(projectedUnused(0.5, FROZEN_NOW + 200 * 3_600_000, 168, FROZEN_NOW), null)
  })

  it('parses CLI snake_case and app-server camelCase quota payloads and fails closed on num_turns > 0', () => {
    const resetsAt = FROZEN_NOW + 48 * 3_600_000
    const cliSnap = parseAgyUsage(
      {
        status: 'SUCCESS',
        num_turns: 0,
        command: {
          data: {
            groups: [
              {
                name: 'Gemini Models',
                buckets: [
                  {
                    window: 'weekly',
                    remaining_fraction: 0.74,
                    reset_time: new Date(resetsAt).toISOString(),
                  },
                  {
                    window: '5h',
                    remaining_fraction: 0.98,
                    reset_time: new Date(FROZEN_NOW + 2 * 3_600_000).toISOString(),
                  },
                ],
              },
              {
                name: 'Claude and GPT models',
                buckets: [
                  { window: '5h', disabled: true },
                  {
                    window: 'weekly',
                    remaining_fraction: 0.5,
                    reset_time: new Date(resetsAt).toISOString(),
                  },
                ],
              },
              {
                name: 'Future Model Family',
                buckets: [{ window: 'weekly', remaining_fraction: 1 }],
              },
            ],
          },
        },
      },
      FROZEN_NOW,
    )

    assert.equal(cliSnap.source, 'cli')
    assert.equal(cliSnap.error, undefined)
    assert.equal(cliSnap.pools.length, 2)
    assert.equal(cliSnap.pools[0].id, 'agy-gemini')
    assert.equal(cliSnap.pools[0].windows.length, 2)
    assert.equal(cliSnap.pools[1].id, 'agy-3p')
    assert.equal(cliSnap.pools[1].windows.length, 1)
    assert.equal(cliSnap.warnings.length, 1)
    assert.match(cliSnap.warnings[0], /Future Model Family/)

    const badTurns = parseAgyUsage({ status: 'SUCCESS', num_turns: 1, command: { data: { groups: [] } } }, FROZEN_NOW)
    assert.equal(badTurns.source, 'none')
    assert.match(badTurns.error ?? '', /num_turns/)

    const warnings = []
    const camelPools = parseAgyGroups(
      [
        {
          displayName: 'Gemini 4 Argon',
          buckets: [
            {
              window: 'weekly',
              remaining: { case: 'remainingFraction', value: 0.91 },
              resetTime: Math.floor(resetsAt / 1000),
            },
          ],
        },
      ],
      warnings,
      FROZEN_NOW,
    )
    assert.ok(Array.isArray(camelPools))
    assert.equal(camelPools.length, 1)
    assert.equal(camelPools[0].id, 'agy-argon')
    assert.equal(camelPools[0].windows[0].resetsAt, Math.floor(resetsAt / 1000) * 1000)

    // Protobuf epoch-0 timestamps (unused 100% pools) normalize to resetsAt: null, never epoch 0.
    const epochZeroPools = parseAgyGroups(
      [
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { window: 'weekly', remainingFraction: 1, resetTime: 0 },
            { window: '5h', remainingFraction: 1, resetTime: '1970-01-01T00:00:00Z' },
          ],
        },
      ],
      [],
      FROZEN_NOW,
    )
    assert.ok(Array.isArray(epochZeroPools))
    assert.equal(epochZeroPools[0].windows[0].resetsAt, null)
    assert.equal(epochZeroPools[0].windows[0].projectedUnused, null)
    assert.equal(epochZeroPools[0].windows[1].resetsAt, null)
    assert.equal(epochZeroPools[0].windows[1].projectedUnused, null)
  })

  it('discovers Windows & POSIX language_server processes while excluding IDE markers and scrubbing CSRF tokens', () => {
    const mixedPs = [
      '1234 "C:\\Program Files\\Antigravity\\language_server_windows_x64.exe" --app_data_dir antigravity --csrf_token=tok_win_secret',
      '2345 /Applications/Antigravity.app/Contents/MacOS/language_server_macos_arm64 --csrf_token tok_mac_secret',
      '5678 C:\\Users\\dev\\.vscode\\extensions\\antigravity\\bin\\language_server.exe --csrf_token=ignore_ide',
      '6789 /Applications/Antigravity IDE.app/Contents/MacOS/language_server --csrf_token=ignore_ide2',
    ].join('\n')

    const servers = findAgyAppServers(mixedPs)
    assert.equal(servers.length, 2)
    assert.deepEqual(servers[0], { pid: 1234, csrf: 'tok_win_secret' })
    assert.deepEqual(servers[1], { pid: 2345, csrf: 'tok_mac_secret' })

    assert.equal(
      scrubTokens('failed with tok_win_secret and tok_mac_secret', [
        'tok_win_secret',
        'tok_mac_secret',
      ]),
      'failed with [redacted] and [redacted]',
    )

    const winNetstat = [
      '  TCP    127.0.0.1:43210        0.0.0.0:0              LISTENING       1234',
      '  TCP    [::1]:43211            [::]:0                 LISTENING       1234',
      '  TCP    192.168.1.5:43212      0.0.0.0:0              LISTENING       1234',
      '  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       9999',
    ].join('\r\n')
    assert.deepEqual(parseWindowsListeningPorts(winNetstat, 1234), [43210, 43211])

    const lsofOut = 'lang_srv 2345 user 12u IPv4 0x1 0t0 TCP 127.0.0.1:51234 (LISTEN)\n'
    assert.deepEqual(parseListeningPorts(lsofOut), [51234])
  })

  it('coalesces concurrent getSnapshot calls, falls back to app server, and never throws', async () => {
    let cliCalls = 0
    let appPosts = 0
    const resetsAt = FROZEN_NOW + 72 * 3_600_000

    const reader = new AntigravityQuotaReader({
      ttlMs: 60_000,
      deps: {
        cli: async () => {
          cliCalls += 1
          return {
            provider: 'antigravity',
            fetchedAt: FROZEN_NOW,
            source: 'none',
            pools: [],
            error: 'agy not on PATH',
            warnings: [],
          }
        },
        listProcesses: async () =>
          '4242 /opt/antigravity/language_server --app_data_dir antigravity --csrf_token=sec_xyz',
        listeningPorts: async () => [54321],
        postLocalHttps: async (_port, _path, headers) => {
          appPosts += 1
          assert.equal(headers['X-Codeium-Csrf-Token'], 'sec_xyz')
          return {
            status: 200,
            body: JSON.stringify({
              summary: {
                groups: [
                  {
                    displayName: 'Gemini Models',
                    buckets: [
                      {
                        window: 'weekly',
                        remainingFraction: 0.82,
                        resetTime: new Date(resetsAt).toISOString(),
                      },
                    ],
                  },
                ],
              },
            }),
          }
        },
      },
    })

    const [a, b] = await Promise.all([reader.getSnapshot(), reader.getSnapshot()])
    assert.equal(cliCalls, 1)
    assert.equal(appPosts, 1)
    assert.equal(a.source, 'app')
    assert.equal(b.source, 'app')
    assert.equal(a.pools[0].id, 'agy-gemini')
    assert.ok(reader.getCached()?.source === 'app')

    // Total failure still returns a valid QuotaSnapshot without throwing.
    const failing = new AntigravityQuotaReader({
      deps: {
        cli: async () => {
          throw new Error('boom')
        },
        listProcesses: async () => {
          throw new Error('no ps')
        },
        listeningPorts: async () => [],
        postLocalHttps: async () => ({ status: 500, body: '' }),
      },
    })
    const errSnap = await failing.getSnapshot()
    assert.equal(errSnap.source, 'none')
    assert.equal(errSnap.pools.length, 0)
    assert.match(errSnap.error ?? '', /boom/)
  })
})

describe('v0.5.0 zero-spawn host MCP health & atomic repair (unit)', () => {
  it('detects missing/stale entries and repairs atomically while preserving unrelated servers', () => {
    const fakeGemini = mkdtempSync(join(tmpdir(), 'agy-pulse-host-health-'))
    const fakeServerDir = mkdtempSync(join(tmpdir(), 'agy-pulse-server-bin-'))
    const prevGeminiHome = process.env.GEMINI_HOME
    try {
      const serverScript = join(fakeServerDir, 'mcp-server.mjs')
      writeFileSync(serverScript, '// stub\n', 'utf8')
      process.env.GEMINI_HOME = fakeGemini

      // 1. Initially missing
      const before = inspectAntigravityHostHealth(serverScript)
      assert.ok(before.entries.some((e) => e.status === 'missing'))

      // 2. Seed a user mcp_config.json with another server + a stale pulse entry with low timeout
      const cfgDir = join(fakeGemini, 'config')
      mkdirSync(cfgDir, { recursive: true })
      const userCfgPath = join(cfgDir, 'mcp_config.json')
      writeFileSync(
        userCfgPath,
        JSON.stringify(
          {
            mcpServers: {
              otherTool: { command: 'python3', args: ['other.py'] },
              pulse: { command: 'node', args: ['/nonexistent/old/mcp-server.mjs'], timeoutSeconds: 60 },
            },
          },
          null,
          2,
        ),
        'utf8',
      )

      const stale = inspectAntigravityHostHealth(serverScript)
      const userEntry = stale.entries.find((e) => e.host === 'antigravity-user')
      assert.equal(userEntry?.status, 'stale')
      assert.equal(userEntry?.repairable, true)

      // 3. Repair atomically
      const repaired = repairAntigravityHostConfig(serverScript)
      assert.equal(repaired.repaired, true)
      const afterEntry = repaired.snapshot.entries.find((e) => e.host === 'antigravity-user')
      assert.equal(afterEntry?.status, 'ok')
      assert.equal(afterEntry?.timeoutSeconds, 86_400)

      const disk = JSON.parse(readFileSync(userCfgPath, 'utf8'))
      assert.deepEqual(disk.mcpServers.otherTool, { command: 'python3', args: ['other.py'] })
      assert.equal(disk.mcpServers.pulse.args[0], serverScript)
      assert.equal(disk.mcpServers.pulse.timeoutSeconds, 86_400)
    } finally {
      if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME
      else process.env.GEMINI_HOME = prevGeminiHome
      rmSync(fakeGemini, { recursive: true, force: true })
      rmSync(fakeServerDir, { recursive: true, force: true })
    }
  })
})

describe('v0.5.0 TTY CLI UI & MCP 2026-07-28 clientInfo (unit)', () => {
  it('renders schmear-style gutters, hides bars below 60 cols, strips ANSI when color=false, and keeps commands intact', () => {
    const snap = {
      provider: 'antigravity',
      fetchedAt: FROZEN_NOW,
      source: 'cli',
      pools: [
        {
          id: 'agy-gemini',
          name: 'Gemini Models',
          windows: [
            {
              kind: 'period',
              label: '7d',
              remaining: 0.72,
              resetsAt: FROZEN_NOW + 36 * 3_600_000,
              periodHours: 168,
              projectedUnused: 0.41,
            },
          ],
        },
      ],
      warnings: [],
    }

    const wide = renderQuotasTty(snap, { color: false, width: 90, now: FROZEN_NOW })
    assert.ok(wide.includes('┌') && wide.includes('◇') && wide.includes('└'))
    assert.ok(wide.includes('█'))
    assert.ok(!wide.includes('\x1b'))

    const narrow = renderQuotasTty(snap, { color: false, width: 52, now: FROZEN_NOW })
    assert.ok(!narrow.includes('█'))

    const plain = renderQuotasPlain(snap, FROZEN_NOW)
    assert.ok(plain.includes('Gemini Models') && !plain.includes('┌'))

    const health = {
      checkedAt: FROZEN_NOW,
      entries: [
        {
          host: 'antigravity-plugin',
          configPath: '/tmp/mcp_config.json',
          status: 'ok',
          detail: 'mcpServers.pulse ok',
          timeoutSeconds: 86400,
          repairable: false,
        },
      ],
      warnings: [],
    }
    assert.ok(renderDoctorTty(health, { color: false, width: 80 }).includes('antigravity-plugin'))
    assert.ok(renderDoctorPlain(health).includes('status=ok'))

    const stats = renderStatsTty(
      {
        sessionId: 'conv_1',
        daemonVersion: '1.0.0',
        versionSkewWarning: 'Version skew detected',
        sync: { mode: 'sidecar-daemon', connected: true, port: 9999, pid: 111, workerAvailable: true, primaryWorkspaceRoot: '/repo' },
        contextWindow: {
          available: true,
          conversationId: 'conv_1',
          model: 'claude-sonnet-4-6',
          contextTokens: 50_000,
          promptTokens: 48_000,
          uncachedInputTokens: 8_000,
          cacheReadTokens: 40_000,
          lastOutputTokens: 2_000,
          cacheHitPct: 83,
          contextLimit: 200_000,
          limitEstimated: false,
          usagePct: 25,
          remainingTokens: 150_000,
          peakContextTokens: 50_000,
          totalOutputTokens: 2_000,
          turnCount: 3,
          lastTurnDeltaTokens: 5_000,
          timeline: [],
          updatedAt: FROZEN_NOW,
        },
        quotas: snap,
        hostHealth: health,
      },
      { color: false, width: 90, now: FROZEN_NOW },
    )
    assert.ok(stats.includes('Version skew detected'))
    assert.ok(stats.includes('Context Window'))
    assert.ok(stats.includes('Antigravity Quotas'))
    assert.ok(stats.includes('Host MCP Health'))

    assert.ok(renderCliHelpTty({ color: false, width: 80 }).includes('quotas'))
    assert.ok(wrapKeep('Please run npm run doctor --repair now', 24).includes('npm run doctor --repair'))
    assert.equal(visibleWidth('\x1b[1;36mpulse\x1b[0m'), 5)
  })

  it('extracts MCP 2026-07-28 _meta["io.modelcontextprotocol/clientInfo"] cleanly', () => {
    assert.deepEqual(
      extractMetaClientInfo({
        name: 'pulse_result',
        _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'antigravity-client', version: '2.1.0' } },
      }),
      { name: 'antigravity-client', version: '2.1.0' },
    )
    assert.deepEqual(
      extractMetaClientInfo({
        _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'claude-code' } },
      }),
      { name: 'claude-code' },
    )
    assert.equal(extractMetaClientInfo({}), undefined)
    assert.equal(extractMetaClientInfo({ _meta: { 'io.modelcontextprotocol/clientInfo': { name: '' } } }), undefined)
  })
})
