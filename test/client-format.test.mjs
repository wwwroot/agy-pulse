import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatCoarseDuration,
  formatCompactQuotaWindow,
  formatDuration,
  formatElapsed,
  formatQuotaWindowLine,
  formatRelativeAge,
  formatUsd,
  formatWindowSpan,
  middleTruncate,
} from '../src/client/utils/format.ts'
import {
  calculateInputSavingsUsd,
  calculateTurnCostUsd,
  getGoogleAiPlan,
  resolveModelPricing,
} from '../src/shared/pricing.ts'

const NOW = 1_700_000_000_000

describe('client formatters (frozen-clock)', () => {
  it('formatCoarseDuration formats <1m, minutes, hours, and days without zero tails', () => {
    assert.equal(formatCoarseDuration(0), '<1m')
    assert.equal(formatCoarseDuration(59_000), '<1m')
    assert.equal(formatCoarseDuration(60_000), '1m')
    assert.equal(formatCoarseDuration(4 * 60_000), '4m')
    assert.equal(formatCoarseDuration(4 * 3_600_000), '4h')
    assert.equal(formatCoarseDuration((4 * 60 + 15) * 60_000), '4h 15m')
    assert.equal(formatCoarseDuration(48 * 3_600_000), '2d')
    assert.equal(formatCoarseDuration(51 * 3_600_000), '2d 3h')
  })

  it('formatDuration formats sub-second, seconds, minutes, hours, and days compactly', () => {
    assert.equal(formatDuration(-5), '0ms')
    assert.equal(formatDuration(Number.NaN), '0ms')
    assert.equal(formatDuration(42), '42ms')
    assert.equal(formatDuration(1_250), '1.3s')
    assert.equal(formatDuration(30_000), '30s')
    assert.equal(formatDuration(120_000), '2m')
    assert.equal(formatDuration(165_000), '2m 45s')
    assert.equal(formatDuration(4 * 3_600_000), '4h')
    assert.equal(formatDuration((4 * 60 + 15) * 60_000), '4h 15m')
    assert.equal(formatDuration(48 * 3_600_000), '2d')
    assert.equal(formatDuration(51 * 3_600_000), '2d 3h')
  })

  it('formatRelativeAge handles past and future timestamps deterministically', () => {
    assert.equal(formatRelativeAge(NOW, NOW), 'just now')
    assert.equal(formatRelativeAge(NOW - 5_000, NOW), 'just now')
    assert.equal(formatRelativeAge(NOW - 42_000, NOW), '42s ago')
    assert.equal(formatRelativeAge(NOW - 3 * 60_000, NOW), '3m ago')
    assert.equal(formatRelativeAge(NOW - (2 * 60 + 15) * 60_000, NOW), '2h 15m ago')
    assert.equal(formatRelativeAge(NOW - 51 * 3_600_000, NOW), '2d 3h ago')

    assert.equal(formatRelativeAge(NOW + 30_000, NOW), 'now')
    assert.equal(formatRelativeAge(NOW + 12 * 60_000, NOW), 'in 12m')
    assert.equal(formatRelativeAge(NOW + (2 * 60 + 14) * 60_000, NOW), 'in 2h 14m')
    assert.equal(formatRelativeAge(NOW + 51 * 3_600_000, NOW), 'in 2d 3h')
  })

  it('formatElapsed uses endedAt for completed tasks and injected now for running tasks', () => {
    assert.equal(formatElapsed(NOW - 45_000, null, NOW), '45s')
    assert.equal(formatElapsed(NOW - 165_000, undefined, NOW), '2m 45s')
    assert.equal(formatElapsed(NOW - 10_000, NOW - 8_750, NOW), '1.3s')
    assert.equal(formatElapsed(0, null, NOW), '0ms')
  })

  it('middleTruncate preserves prefix and file basename when truncating long paths', () => {
    assert.equal(middleTruncate('short.ts', 20), 'short.ts')
    const p = 'C:/projects/desktop/antigravity-plugins/agy-pulse/src/client/components/ContextWindowCard.tsx'
    const truncated = middleTruncate(p, 44)
    assert.equal(truncated.length, 44)
    assert.ok(truncated.startsWith('C:/projects/'), `expected prefix preserved, got: ${truncated}`)
    assert.ok(
      truncated.endsWith('/ContextWindowCard.tsx'),
      `expected basename preserved, got: ${truncated}`,
    )
    assert.ok(truncated.includes('…'))

    const plain = middleTruncate('abcdefghijklmnopqrstuvwxyz0123456789', 15)
    assert.equal(plain.length, 15)
    assert.ok(plain.includes('…'))
  })

  it('formatWindowSpan and formatQuotaWindowLine match schmear window summary formatting', () => {
    assert.equal(formatWindowSpan(5), '5h')
    assert.equal(formatWindowSpan(24), '1d')
    assert.equal(formatWindowSpan(168), '7d')
    assert.equal(formatWindowSpan(720), '30d')

    const line = formatQuotaWindowLine(
      {
        periodHours: 168,
        remaining: 0.37,
        resetsAt: NOW + 51 * 3_600_000,
        projectedUnused: 0.12,
      },
      NOW,
    )
    assert.equal(line, '7d · 37% left · resets in 2d 3h · ~12% unused')

    const noUnusedNoReset = formatQuotaWindowLine(
      {
        periodHours: 5,
        remaining: 0.68,
        resetsAt: null,
        projectedUnused: 0.004,
      },
      NOW,
    )
    assert.equal(noUnusedNoReset, '5h · 68% left · resets —')

    const epochZeroReset = formatQuotaWindowLine(
      {
        periodHours: 168,
        remaining: 1,
        resetsAt: 0,
        projectedUnused: null,
      },
      NOW,
    )
    assert.equal(epochZeroReset, '7d · 100% left · resets —')
  })

  it('formatCompactQuotaWindow and formatUsd format 2-col quota & dollar values cleanly', () => {
    const compact = formatCompactQuotaWindow(
      {
        periodHours: 5,
        remaining: 0.68,
        resetsAt: NOW + (2 * 60 + 14) * 60_000,
        projectedUnused: null,
      },
      NOW,
    )
    assert.deepEqual(compact, { span: '5h', pct: 68, meta: 'in 2h 14m' })

    const unusedPool = formatCompactQuotaWindow(
      { periodHours: 168, remaining: 1, resetsAt: 0, projectedUnused: null },
      NOW,
    )
    assert.deepEqual(unusedPool, { span: '7d', pct: 100, meta: '' })

    assert.equal(formatUsd(0), '$0.00')
    assert.equal(formatUsd(0.002), '<$0.01')
    assert.equal(formatUsd(0.144), '$0.14')
    assert.equal(formatUsd(19.99), '$19.99')
    assert.equal(formatUsd(1240.4), '$1,240')
  })

  it('pricing engine resolves Gemini 4, Claude, GPT rates, Dec 1 cutoff, and turn/savings USD', () => {
    const nov26 = Date.UTC(2026, 10, 26)
    const dec02 = Date.UTC(2026, 11, 2)

    assert.equal(resolveModelPricing('gemini-4-neon-high', nov26).inputPerMillion, 3.0)
    assert.equal(resolveModelPricing('gemini-4-hydrogen-medium', nov26).inputPerMillion, 1.5)
    assert.equal(resolveModelPricing('gemini-4-argon', nov26).inputPerMillion, 2.0)
    assert.equal(resolveModelPricing('gemini-4-argon', dec02).inputPerMillion, 4.0)
    assert.equal(resolveModelPricing('gemini-4-carbon', dec02).outputPerMillion, 20.0)
    assert.equal(resolveModelPricing('claude-sonnet-5', nov26).inputPerMillion, 2.0)
    assert.equal(resolveModelPricing('gpt-5', nov26).inputPerMillion, 1.25)

    const turn = calculateTurnCostUsd({
      model: 'gemini-4-neon-high',
      uncachedInputTokens: 100_000,
      cacheReadTokens: 400_000,
      outputTokens: 10_000,
      now: nov26,
    })
    // 0.1M * $3 + 0.4M * $0.15 + 0.01M * $15 = 0.30 + 0.06 + 0.15 = $0.51
    assert.ok(Math.abs(turn.totalUsd - 0.51) < 1e-6)
    // Cache saved: 0.4M * ($3.00 - $0.15) = $1.14
    assert.ok(Math.abs(turn.cacheSavingsUsd - 1.14) < 1e-6)

    const saved = calculateInputSavingsUsd(500_000, 'gemini-4-hydrogen', nov26)
    assert.ok(Math.abs(saved.usd - 0.75) < 1e-6)

    // Custom pricing override takes precedence over built-in defaults
    const customOverrides = {
      'gemini-4-hydrogen': {
        inputPerMillion: 2.5,
        cacheReadPerMillion: 0.25,
        outputPerMillion: 12.0,
      },
    }
    const overridden = resolveModelPricing('gemini-4-hydrogen-medium', nov26, 0, customOverrides)
    assert.equal(overridden.inputPerMillion, 2.5)
    assert.equal(overridden.outputPerMillion, 12.0)
    const savedCustom = calculateInputSavingsUsd(1_000_000, 'gemini-4-hydrogen', nov26, customOverrides)
    assert.ok(Math.abs(savedCustom.usd - 2.5) < 1e-6)

    assert.equal(getGoogleAiPlan('pro')?.monthlyUsd, 19.99)
    assert.equal(getGoogleAiPlan('ultra-20x')?.monthlyUsd, 199.99)
    assert.equal(getGoogleAiPlan('none'), null)
  })
})
