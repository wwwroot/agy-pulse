import type { CostPricingOverrides, GoogleAiPlanId, ModelPricingOverride } from './types.ts'

export interface ModelPricingPreset {
  key: string
  label: string
  probeModel: string
}

/**
 * Editable model families shown in Settings -> Advanced cost rates.
 * Defaults are always derived from `resolveModelPricing(preset.probeModel)` unless overridden.
 */
export const MODEL_PRICING_PRESETS: readonly ModelPricingPreset[] = [
  { key: 'gemini-4-neon', label: 'Gemini 4 Neon', probeModel: 'gemini-4-neon' },
  { key: 'gemini-4-argon', label: 'Gemini 4 Argon', probeModel: 'gemini-4-argon' },
  { key: 'gemini-4-carbon', label: 'Gemini 4 Carbon', probeModel: 'gemini-4-carbon' },
  { key: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', probeModel: 'gemini-4-hydrogen' },
  { key: 'gemini-3.8-flash', label: 'Gemini Flash', probeModel: 'gemini-3.8-flash' },
  { key: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', probeModel: 'gemini-3.1-pro' },
  { key: 'claude-sonnet', label: 'Claude Sonnet', probeModel: 'claude-sonnet-5' },
  { key: 'claude-opus', label: 'Claude Opus', probeModel: 'claude-opus-5' },
  { key: 'gpt-5', label: 'GPT-5 / Sol', probeModel: 'gpt-5' },
  { key: 'default', label: 'Default fallback', probeModel: '' },
] as const

/**
 * Maps a raw model identifier to its canonical pricing override key.
 */
export function resolvePricingKey(model?: string | null): string {
  const raw = (model ?? '').trim().toLowerCase()
  if (!raw) return 'default'
  const m = raw
    .replace(/^models\//, '')
    .replace(/\s*\([^)]*\)\s*/g, '')
    .trim()
  if (m.includes('gemini-4-neon') || m.includes('gemini 4 neon')) return 'gemini-4-neon'
  if (m.includes('gemini-4-argon') || m.includes('gemini 4 argon')) return 'gemini-4-argon'
  if (m.includes('gemini-4-carbon') || m.includes('gemini 4 carbon')) return 'gemini-4-carbon'
  if (m.includes('gemini-4-hydrogen') || m.includes('gemini 4 hydrogen')) return 'gemini-4-hydrogen'
  if (
    m.includes('gemini-3.8-flash') ||
    m.includes('gemini-3.7-flash') ||
    m.includes('gemini 3.8 flash') ||
    m.includes('gemini 3.7 flash') ||
    m.includes('gemini-2.5-flash') ||
    m.includes('flash-lite')
  ) {
    return 'gemini-3.8-flash'
  }
  if (
    m.includes('gemini-3.1-pro') ||
    m.includes('gemini-3-pro') ||
    m.includes('gemini-2.5-pro') ||
    m.includes('gemini 3.1 pro')
  ) {
    return 'gemini-3.1-pro'
  }
  if (m.includes('sonnet')) return 'claude-sonnet'
  if (m.includes('opus') || m.includes('fable') || m.includes('mythos')) return 'claude-opus'
  if (m.includes('gpt-5') || m.includes('gpt-6') || m.includes('gpt-4')) return 'gpt-5'
  return 'default'
}

function applyPricingOverride(
  base: ModelPricingRate,
  override: ModelPricingOverride | undefined,
): ModelPricingRate {
  if (!override) return base
  const input =
    Number.isFinite(override.inputPerMillion) && override.inputPerMillion >= 0
      ? override.inputPerMillion
      : base.inputPerMillion
  const cacheRead =
    Number.isFinite(override.cacheReadPerMillion) && override.cacheReadPerMillion >= 0
      ? override.cacheReadPerMillion
      : base.cacheReadPerMillion
  const output =
    Number.isFinite(override.outputPerMillion) && override.outputPerMillion >= 0
      ? override.outputPerMillion
      : base.outputPerMillion
  const isClaude = base.label.toLowerCase().includes('claude')
  return {
    ...base,
    inputPerMillion: input,
    cacheReadPerMillion: cacheRead,
    cacheWritePerMillion: isClaude ? input * 1.25 : input,
    outputPerMillion: output,
    estimated: false,
  }
}

export interface ModelPricingRate {
  /** Human-readable rate family label */
  label: string
  /** USD per 1,000,000 uncached input tokens */
  inputPerMillion: number
  /** USD per 1,000,000 cached input read tokens */
  cacheReadPerMillion: number
  /** USD per 1,000,000 cache write / creation tokens (defaults to 1.25x input for Claude, 1x otherwise) */
  cacheWritePerMillion: number
  /** USD per 1,000,000 output tokens (including thinking/reasoning tokens) */
  outputPerMillion: number
  /** Whether the rate is a blended fallback rather than an exact model match */
  estimated?: boolean
}

export interface GoogleAiPlanInfo {
  id: Exclude<GoogleAiPlanId, 'none'>
  label: string
  shortLabel: string
  monthlyUsd: number
}

/**
 * Official Google AI consumer subscription tiers (USD/month).
 */
export const GOOGLE_AI_PLANS: readonly GoogleAiPlanInfo[] = [
  { id: 'plus', label: 'Google AI Plus ($4.99/mo)', shortLabel: 'AI Plus', monthlyUsd: 4.99 },
  { id: 'pro', label: 'Google AI Pro ($19.99/mo)', shortLabel: 'AI Pro', monthlyUsd: 19.99 },
  {
    id: 'ultra-5x',
    label: 'Google AI Ultra 5× ($99.99/mo)',
    shortLabel: 'AI Ultra 5×',
    monthlyUsd: 99.99,
  },
  {
    id: 'ultra-20x',
    label: 'Google AI Ultra 20× ($199.99/mo)',
    shortLabel: 'AI Ultra 20×',
    monthlyUsd: 199.99,
  },
] as const

export function getGoogleAiPlan(planId: GoogleAiPlanId | undefined | null): GoogleAiPlanInfo | null {
  if (!planId || planId === 'none') return null
  return GOOGLE_AI_PLANS.find((p) => p.id === planId) ?? null
}

// Promotional introductory cutoffs published by Google AI Studio (UTC).
const DEC_1_2026_UTC = Date.UTC(2026, 11, 1, 0, 0, 0)
const JAN_1_2027_UTC = Date.UTC(2027, 0, 1, 0, 0, 0)

/**
 * Default fallback rate when model metadata is missing or in cross-chat project summaries
 * (Gemini 4 Hydrogen baseline: $1.50/1M input, $0.075/1M cached read, $7.50/1M output).
 */
export const DEFAULT_MODEL_PRICING: ModelPricingRate = {
  label: 'Gemini baseline (est.)',
  inputPerMillion: 1.5,
  cacheReadPerMillion: 0.075,
  cacheWritePerMillion: 1.5,
  outputPerMillion: 7.5,
  estimated: true,
}

/**
 * Resolves official list-price API token rates (USD per 1M tokens) for models
 * commonly used in Antigravity (Google Gemini, Anthropic Claude, OpenAI GPT/o-series).
 */
export function resolveModelPricing(
  model?: string | null,
  now = Date.now(),
  promptTokens = 0,
  overrides?: CostPricingOverrides | null,
): ModelPricingRate {
  const base = resolveBuiltinModelPricing(model, now, promptTokens)
  if (!overrides || typeof overrides !== 'object') return base
  const key = resolvePricingKey(model)
  const exact = overrides[key]
  if (exact) return applyPricingOverride(base, exact)
  if (key === 'default' && overrides.default) {
    return applyPricingOverride(base, overrides.default)
  }
  return base
}

function resolveBuiltinModelPricing(
  model?: string | null,
  now = Date.now(),
  promptTokens = 0,
): ModelPricingRate {
  const raw = (model ?? '').trim().toLowerCase()
  if (!raw) return DEFAULT_MODEL_PRICING

  // Strip provider prefixes or effort suffixes like "(High)", "-high", "models/"
  const m = raw
    .replace(/^models\//, '')
    .replace(/\s*\([^)]*\)\s*/g, '')
    .trim()

  // Google Gemini 4 family
  if (m.includes('gemini-4-neon') || m.includes('gemini 4 neon')) {
    return {
      label: 'Gemini 4 Neon',
      inputPerMillion: 3.0,
      cacheReadPerMillion: 0.15,
      cacheWritePerMillion: 3.0,
      outputPerMillion: 15.0,
    }
  }
  if (m.includes('gemini-4-argon') || m.includes('gemini 4 argon')) {
    const standard = now >= DEC_1_2026_UTC
    return {
      label: 'Gemini 4 Argon',
      inputPerMillion: standard ? 4.0 : 2.0,
      cacheReadPerMillion: standard ? 0.2 : 0.1,
      cacheWritePerMillion: standard ? 4.0 : 2.0,
      outputPerMillion: standard ? 20.0 : 10.0,
    }
  }
  if (m.includes('gemini-4-carbon') || m.includes('gemini 4 carbon')) {
    const standard = now >= DEC_1_2026_UTC
    return {
      label: 'Gemini 4 Carbon',
      inputPerMillion: standard ? 4.0 : 2.0,
      cacheReadPerMillion: standard ? 0.2 : 0.1,
      cacheWritePerMillion: standard ? 4.0 : 2.0,
      outputPerMillion: standard ? 20.0 : 10.0,
    }
  }
  if (m.includes('gemini-4-hydrogen') || m.includes('gemini 4 hydrogen')) {
    return {
      label: 'Gemini 4 Hydrogen',
      inputPerMillion: 1.5,
      cacheReadPerMillion: 0.075,
      cacheWritePerMillion: 1.5,
      outputPerMillion: 7.5,
    }
  }

  // Google Gemini 3.x / 2.5 family
  if (
    m.includes('gemini-3.8-flash') ||
    m.includes('gemini-3.7-flash') ||
    m.includes('gemini 3.8 flash') ||
    m.includes('gemini 3.7 flash')
  ) {
    const standard = now >= JAN_1_2027_UTC
    return {
      label: 'Gemini Flash',
      inputPerMillion: standard ? 1.5 : 0.75,
      cacheReadPerMillion: standard ? 0.075 : 0.0375,
      cacheWritePerMillion: standard ? 1.5 : 0.75,
      outputPerMillion: standard ? 7.5 : 3.75,
    }
  }
  if (m.includes('flash-lite') || m.includes('flash_lite')) {
    return {
      label: 'Gemini Flash-Lite',
      inputPerMillion: 0.25,
      cacheReadPerMillion: 0.025,
      cacheWritePerMillion: 0.25,
      outputPerMillion: 1.5,
    }
  }
  if (m.includes('gemini-3.1-pro') || m.includes('gemini-3-pro') || m.includes('gemini 3.1 pro')) {
    const longCtx = promptTokens > 200_000
    return {
      label: 'Gemini 3.1 Pro',
      inputPerMillion: longCtx ? 4.0 : 2.0,
      cacheReadPerMillion: longCtx ? 0.4 : 0.2,
      cacheWritePerMillion: longCtx ? 4.0 : 2.0,
      outputPerMillion: longCtx ? 18.0 : 12.0,
    }
  }
  if (m.includes('gemini-2.5-pro') || m.includes('gemini 2.5 pro')) {
    const longCtx = promptTokens > 200_000
    return {
      label: 'Gemini 2.5 Pro',
      inputPerMillion: longCtx ? 2.5 : 1.25,
      cacheReadPerMillion: longCtx ? 0.625 : 0.31,
      cacheWritePerMillion: longCtx ? 2.5 : 1.25,
      outputPerMillion: longCtx ? 15.0 : 10.0,
    }
  }
  if (m.includes('gemini-2.5-flash') || m.includes('gemini 2.5 flash')) {
    return {
      label: 'Gemini 2.5 Flash',
      inputPerMillion: 0.3,
      cacheReadPerMillion: 0.03,
      cacheWritePerMillion: 0.3,
      outputPerMillion: 2.5,
    }
  }
  if (m.startsWith('gemini')) {
    return {
      label: 'Gemini (est.)',
      inputPerMillion: 1.5,
      cacheReadPerMillion: 0.075,
      cacheWritePerMillion: 1.5,
      outputPerMillion: 7.5,
      estimated: true,
    }
  }

  // Anthropic Claude family
  if (m.includes('fable') || m.includes('mythos')) {
    return {
      label: 'Claude Fable',
      inputPerMillion: 8.0,
      cacheReadPerMillion: 0.2,
      cacheWritePerMillion: 10.0,
      outputPerMillion: 40.0,
    }
  }
  if (m.includes('opus-5') || m.includes('opus 5')) {
    return {
      label: 'Claude Opus 5',
      inputPerMillion: 4.0,
      cacheReadPerMillion: 0.2,
      cacheWritePerMillion: 5.0,
      outputPerMillion: 20.0,
    }
  }
  if (m.includes('opus-4-5') || m.includes('opus-4.5') || m.includes('opus-4-6') || m.includes('opus-4.6')) {
    return {
      label: 'Claude Opus 4.5+',
      inputPerMillion: 5.0,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 6.25,
      outputPerMillion: 25.0,
    }
  }
  if (m.includes('opus')) {
    return {
      label: 'Claude Opus',
      inputPerMillion: 15.0,
      cacheReadPerMillion: 1.5,
      cacheWritePerMillion: 18.75,
      outputPerMillion: 75.0,
    }
  }
  if (m.includes('sonnet-5') || m.includes('sonnet 5')) {
    return {
      label: 'Claude Sonnet 5',
      inputPerMillion: 2.0,
      cacheReadPerMillion: 0.1,
      cacheWritePerMillion: 2.5,
      outputPerMillion: 10.0,
    }
  }
  if (m.includes('sonnet')) {
    return {
      label: 'Claude Sonnet',
      inputPerMillion: 3.0,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
      outputPerMillion: 15.0,
    }
  }
  if (m.includes('haiku-5') || m.includes('haiku 5')) {
    const longCtx = promptTokens > 100_000
    return {
      label: 'Claude Haiku 5',
      inputPerMillion: longCtx ? 0.5 : 0.1,
      cacheReadPerMillion: longCtx ? 0.05 : 0.01,
      cacheWritePerMillion: longCtx ? 0.625 : 0.125,
      outputPerMillion: longCtx ? 2.5 : 0.5,
    }
  }
  if (m.includes('haiku')) {
    return {
      label: 'Claude Haiku',
      inputPerMillion: 1.0,
      cacheReadPerMillion: 0.1,
      cacheWritePerMillion: 1.25,
      outputPerMillion: 5.0,
    }
  }

  // OpenAI GPT / o-series
  if (m.includes('gpt-6') && m.includes('astra')) {
    return {
      label: 'GPT-6 Astra',
      inputPerMillion: 8.0,
      cacheReadPerMillion: 0.4,
      cacheWritePerMillion: 8.0,
      outputPerMillion: 40.0,
    }
  }
  if (m.includes('gpt-6')) {
    return {
      label: 'GPT-6 Sol',
      inputPerMillion: 2.0,
      cacheReadPerMillion: 0.1,
      cacheWritePerMillion: 2.0,
      outputPerMillion: 10.0,
    }
  }
  if (m.includes('gpt-5')) {
    return {
      label: 'GPT-5',
      inputPerMillion: 1.25,
      cacheReadPerMillion: 0.125,
      cacheWritePerMillion: 1.25,
      outputPerMillion: 10.0,
    }
  }
  if (m.includes('gpt-4.1-mini')) {
    return {
      label: 'GPT-4.1 mini',
      inputPerMillion: 0.4,
      cacheReadPerMillion: 0.1,
      cacheWritePerMillion: 0.4,
      outputPerMillion: 1.6,
    }
  }
  if (m.includes('gpt-4.1') || m.startsWith('o3')) {
    return {
      label: m.startsWith('o3') ? 'o3' : 'GPT-4.1',
      inputPerMillion: 2.0,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 2.0,
      outputPerMillion: 8.0,
    }
  }
  if (m.startsWith('o4-mini')) {
    return {
      label: 'o4-mini',
      inputPerMillion: 1.1,
      cacheReadPerMillion: 0.28,
      cacheWritePerMillion: 1.1,
      outputPerMillion: 4.4,
    }
  }
  if (m.includes('gpt-4o')) {
    return {
      label: 'GPT-4o',
      inputPerMillion: 2.5,
      cacheReadPerMillion: 1.25,
      cacheWritePerMillion: 2.5,
      outputPerMillion: 10.0,
    }
  }

  return DEFAULT_MODEL_PRICING
}

export interface TurnCostCalculation {
  inputUsd: number
  cacheWriteUsd: number
  cacheReadUsd: number
  outputUsd: number
  totalUsd: number
  /** Dollar savings gained by serving cacheReadTokens at cached rate vs uncached input rate */
  cacheSavingsUsd: number
  rate: ModelPricingRate
}

/**
 * Computes exact USD API-equivalent cost for a single planner turn.
 */
export function calculateTurnCostUsd(params: {
  model?: string | null
  uncachedInputTokens: number
  cacheCreationInputTokens?: number
  cacheReadTokens: number
  outputTokens: number
  now?: number
  overrides?: CostPricingOverrides | null
}): TurnCostCalculation {
  const uncached = Math.max(0, params.uncachedInputTokens || 0)
  const cacheCreate = Math.max(0, params.cacheCreationInputTokens || 0)
  const cacheRead = Math.max(0, params.cacheReadTokens || 0)
  const output = Math.max(0, params.outputTokens || 0)
  const promptTokens = uncached + cacheCreate + cacheRead

  const rate = resolveModelPricing(params.model, params.now, promptTokens, params.overrides)
  const inputUsd = (uncached / 1_000_000) * rate.inputPerMillion
  const cacheWriteUsd = (cacheCreate / 1_000_000) * rate.cacheWritePerMillion
  const cacheReadUsd = (cacheRead / 1_000_000) * rate.cacheReadPerMillion
  const outputUsd = (output / 1_000_000) * rate.outputPerMillion
  const totalUsd = inputUsd + cacheWriteUsd + cacheReadUsd + outputUsd
  const cacheSavingsUsd =
    (cacheRead / 1_000_000) * Math.max(0, rate.inputPerMillion - rate.cacheReadPerMillion)

  return {
    inputUsd,
    cacheWriteUsd,
    cacheReadUsd,
    outputUsd,
    totalUsd,
    cacheSavingsUsd,
    rate,
  }
}

/**
 * Estimates USD saved by avoiding `tokensSaved` of input context (conservative 1x input rate).
 */
export function calculateInputSavingsUsd(
  tokensSaved: number,
  model?: string | null,
  now?: number,
  overrides?: CostPricingOverrides | null,
): { usd: number; rate: ModelPricingRate } {
  const safeTokens = Math.max(0, tokensSaved || 0)
  const rate = resolveModelPricing(model, now, 0, overrides)
  return {
    usd: (safeTokens / 1_000_000) * rate.inputPerMillion,
    rate,
  }
}

/**
 * Formats a USD amount compactly for narrow sidecar panels:
 * 0 -> "$0.00", <$0.005 -> "<$0.01", <$10 -> "$0.14", >=$10 -> "$12.40", >=$1000 -> "$1,240".
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00'
  if (usd < 0.005) return '<$0.01'
  if (usd < 100) return `$${usd.toFixed(2)}`
  if (usd < 1_000) return `$${usd.toFixed(1)}`
  return `$${Math.round(usd).toLocaleString('en-US')}`
}
