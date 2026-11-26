import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveDataDir } from '../shared/paths.ts'
import {
  DEFAULT_TERMINAL_CONFIG,
  type CostPricingOverrides,
  type GoogleAiPlanId,
  type ModelPricingOverride,
  type ShellId,
  type TerminalConfig,
} from '../shared/types.ts'

const VALID_GOOGLE_AI_PLANS = new Set<GoogleAiPlanId>([
  'none',
  'plus',
  'pro',
  'ultra-5x',
  'ultra-20x',
])

const VALID_SHELL_IDS = new Set<ShellId>([
  'auto',
  'pwsh',
  'powershell',
  'git-bash',
  'wsl',
  'cmd',
  'bash',
  'zsh',
  'sh',
])

const BOUNDS = {
  // Foreground timeouts stay below Antigravity's 180 s hard MCP tool timeout so
  // autoPromoteOnTimeout can hand off long commands to unbounded background jobs.
  defaultTimeoutMs: { min: 1_000, max: 165_000, integer: true },
  maxTimeoutMs: { min: 5_000, max: 165_000, integer: true },
  // Capped at 8,800 B so oversized outputs always create a spill reference before
  // hitting the 9,400-byte MCP inline response ceiling (MAX_RENDERED_BYTES).
  maxInlineBytes: { min: 1_024, max: 8_800, integer: true },
  maxSpillBytes: { min: 65_536, max: 104_857_600, integer: true },
  spillRetentionDays: { min: 1, max: 90, integer: true },
  spillMaxTotalMb: { min: 16, max: 4_096, integer: true },
  sessionRetentionDays: { min: 1, max: 90, integer: true },
  sessionMaxCount: { min: 5, max: 200, integer: true },
} as const

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  return Math.max(min, Math.min(max, rounded))
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

const SAFE_PRICING_KEY_RE = /^[a-z0-9._-]{1,48}$/i

function asCostPricingOverrides(
  value: unknown,
  fallback: CostPricingOverrides,
): CostPricingOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...fallback }
  }
  const out: CostPricingOverrides = {}
  let count = 0
  for (const [rawKey, rawRate] of Object.entries(value as Record<string, unknown>)) {
    if (count >= 32) break
    const key = rawKey.trim().toLowerCase()
    if (!SAFE_PRICING_KEY_RE.test(key)) continue
    if (!rawRate || typeof rawRate !== 'object' || Array.isArray(rawRate)) continue
    const r = rawRate as Record<string, unknown>
    const inp = typeof r.inputPerMillion === 'number' && Number.isFinite(r.inputPerMillion) ? r.inputPerMillion : null
    const cache =
      typeof r.cacheReadPerMillion === 'number' && Number.isFinite(r.cacheReadPerMillion)
        ? r.cacheReadPerMillion
        : null
    const outRate =
      typeof r.outputPerMillion === 'number' && Number.isFinite(r.outputPerMillion)
        ? r.outputPerMillion
        : null
    if (inp === null || cache === null || outRate === null) continue
    const clean: ModelPricingOverride = {
      inputPerMillion: Math.max(0, Math.min(1_000, Math.round(inp * 10_000) / 10_000)),
      cacheReadPerMillion: Math.max(0, Math.min(1_000, Math.round(cache * 10_000) / 10_000)),
      outputPerMillion: Math.max(0, Math.min(1_000, Math.round(outRate * 10_000) / 10_000)),
    }
    out[key] = clean
    count++
  }
  return out
}

function asGoogleAiPlan(value: unknown, fallback: GoogleAiPlanId): GoogleAiPlanId {
  if (typeof value === 'string' && VALID_GOOGLE_AI_PLANS.has(value as GoogleAiPlanId)) {
    return value as GoogleAiPlanId
  }
  return fallback
}

function asShellId(value: unknown, fallback: ShellId): ShellId {
  if (typeof value === 'string' && VALID_SHELL_IDS.has(value as ShellId)) {
    return value as ShellId
  }
  return fallback
}

function asTemplate(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  return value.slice(0, 1024)
}

/**
 * Merges a partial config object onto a base config, clamping numeric bounds
 * and validating enum values.
 */
export function normalizeTerminalConfig(
  raw: unknown,
  base: TerminalConfig = DEFAULT_TERMINAL_CONFIG,
): TerminalConfig {
  const input =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}

  const maxTimeoutMs = clampInt(
    input.maxTimeoutMs,
    base.maxTimeoutMs,
    BOUNDS.maxTimeoutMs.min,
    BOUNDS.maxTimeoutMs.max,
  )
  const rawDefaultTimeout = clampInt(
    input.defaultTimeoutMs,
    base.defaultTimeoutMs,
    BOUNDS.defaultTimeoutMs.min,
    BOUNDS.defaultTimeoutMs.max,
  )
  const defaultTimeoutMs = Math.min(rawDefaultTimeout, maxTimeoutMs)

  const maxSpillBytes = clampInt(
    input.maxSpillBytes,
    base.maxSpillBytes,
    BOUNDS.maxSpillBytes.min,
    BOUNDS.maxSpillBytes.max,
  )
  const maxInlineBytes = Math.min(
    clampInt(
      input.maxInlineBytes,
      base.maxInlineBytes,
      BOUNDS.maxInlineBytes.min,
      BOUNDS.maxInlineBytes.max,
    ),
    maxSpillBytes,
  )

  return {
    defaultShell: asShellId(input.defaultShell, base.defaultShell),
    defaultTimeoutMs,
    maxTimeoutMs,
    maxInlineBytes,
    maxSpillBytes,
    autoPromoteOnTimeout: asBool(input.autoPromoteOnTimeout, base.autoPromoteOnTimeout),
    enableReadDedup: asBool(input.enableReadDedup, base.enableReadDedup),
    enableJsonDigest: asBool(input.enableJsonDigest, base.enableJsonDigest),
    enableCredentialFence: asBool(input.enableCredentialFence, base.enableCredentialFence),
    enableDownloadGuard: asBool(input.enableDownloadGuard, base.enableDownloadGuard),
    downloadGuardTemplate: asTemplate(input.downloadGuardTemplate, base.downloadGuardTemplate),
    spillRetentionDays: clampInt(
      input.spillRetentionDays,
      base.spillRetentionDays,
      BOUNDS.spillRetentionDays.min,
      BOUNDS.spillRetentionDays.max,
    ),
    spillMaxTotalMb: clampInt(
      input.spillMaxTotalMb,
      base.spillMaxTotalMb,
      BOUNDS.spillMaxTotalMb.min,
      BOUNDS.spillMaxTotalMb.max,
    ),
    sessionRetentionDays: clampInt(
      input.sessionRetentionDays,
      base.sessionRetentionDays,
      BOUNDS.sessionRetentionDays.min,
      BOUNDS.sessionRetentionDays.max,
    ),
    sessionMaxCount: clampInt(
      input.sessionMaxCount,
      base.sessionMaxCount,
      BOUNDS.sessionMaxCount.min,
      BOUNDS.sessionMaxCount.max,
    ),
    googleAiPlan: asGoogleAiPlan(input.googleAiPlan, base.googleAiPlan),
    costPricingOverrides:
      input.costPricingOverrides !== undefined
        ? asCostPricingOverrides(input.costPricingOverrides, base.costPricingOverrides)
        : { ...base.costPricingOverrides },
  }
}

export interface ConfigValidationError {
  field: string
  message: string
}

const KNOWN_CONFIG_KEYS = new Set<string>(Object.keys(DEFAULT_TERMINAL_CONFIG))

/**
 * Validates a configuration patch before saving.
 */
export function validateConfigPatch(patch: unknown): ConfigValidationError[] {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return [{ field: 'config', message: 'Configuration patch must be an object.' }]
  }

  const obj = patch as Record<string, unknown>
  const errors: ConfigValidationError[] = []

  const unknownKeys = Object.keys(obj).filter((k) => !KNOWN_CONFIG_KEYS.has(k))
  if (unknownKeys.length > 0) {
    for (const key of unknownKeys) {
      errors.push({
        field: key,
        message: `Unknown configuration key "${key}". Allowed keys: ${[...KNOWN_CONFIG_KEYS].join(', ')}.`,
      })
    }
  }

  if ('defaultShell' in obj && !VALID_SHELL_IDS.has(obj.defaultShell as ShellId)) {
    errors.push({
      field: 'defaultShell',
      message: `Invalid shell "${String(obj.defaultShell)}". Must be one of: ${[...VALID_SHELL_IDS].join(', ')}.`,
    })
  }

  if ('googleAiPlan' in obj && !VALID_GOOGLE_AI_PLANS.has(obj.googleAiPlan as GoogleAiPlanId)) {
    errors.push({
      field: 'googleAiPlan',
      message: `Invalid googleAiPlan "${String(obj.googleAiPlan)}". Must be one of: ${[...VALID_GOOGLE_AI_PLANS].join(', ')}.`,
    })
  }

  if ('costPricingOverrides' in obj) {
    const raw = obj.costPricingOverrides
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({
        field: 'costPricingOverrides',
        message: 'costPricingOverrides must be an object mapping model keys to rate objects.',
      })
    } else {
      const entries = Object.entries(raw as Record<string, unknown>)
      if (entries.length > 32) {
        errors.push({
          field: 'costPricingOverrides',
          message: 'costPricingOverrides supports at most 32 model entries.',
        })
      }
      for (const [k, v] of entries) {
        if (!SAFE_PRICING_KEY_RE.test(k)) {
          errors.push({
            field: `costPricingOverrides.${k}`,
            message: `Invalid pricing override key "${k}".`,
          })
          continue
        }
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          errors.push({
            field: `costPricingOverrides.${k}`,
            message: `Pricing override for "${k}" must be an object.`,
          })
          continue
        }
        const rec = v as Record<string, unknown>
        for (const rateField of ['inputPerMillion', 'cacheReadPerMillion', 'outputPerMillion'] as const) {
          const val = rec[rateField]
          if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 1_000) {
            errors.push({
              field: `costPricingOverrides.${k}.${rateField}`,
              message: `${rateField} must be a finite number between 0 and 1000.`,
            })
          }
        }
      }
    }
  }

  for (const [key, { min, max }] of Object.entries(BOUNDS)) {
    if (!(key in obj)) continue
    const val = obj[key]
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      errors.push({ field: key, message: `${key} must be a finite number.` })
    } else if (val < min || val > max) {
      errors.push({ field: key, message: `${key} must be between ${min} and ${max}.` })
    }
  }

  const boolFields = [
    'autoPromoteOnTimeout',
    'enableReadDedup',
    'enableJsonDigest',
    'enableCredentialFence',
    'enableDownloadGuard',
  ] as const
  for (const key of boolFields) {
    if (key in obj && typeof obj[key] !== 'boolean') {
      errors.push({ field: key, message: `${key} must be a boolean.` })
    }
  }

  if ('downloadGuardTemplate' in obj && typeof obj.downloadGuardTemplate !== 'string') {
    errors.push({ field: 'downloadGuardTemplate', message: 'downloadGuardTemplate must be a string.' })
  }

  return errors
}

export class ConfigStore {
  readonly dataDir: string
  readonly configPath: string
  private cached: TerminalConfig | null = null
  private cachedMtimeMs = -1

  constructor(dataDir: string = resolveDataDir()) {
    this.dataDir = dataDir
    this.configPath = path.join(dataDir, 'config.json')
  }

  get(): TerminalConfig {
    try {
      if (existsSync(this.configPath)) {
        const st = statSync(this.configPath)
        if (this.cached && st.mtimeMs === this.cachedMtimeMs) {
          return { ...this.cached }
        }
        const rawText = readFileSync(this.configPath, 'utf-8')
        const parsed = JSON.parse(rawText)
        const normalized = normalizeTerminalConfig(parsed, DEFAULT_TERMINAL_CONFIG)
        this.cached = normalized
        this.cachedMtimeMs = st.mtimeMs
        return { ...normalized }
      }
    } catch {
      // Fall back to defaults if config file is missing or corrupted.
    }

    this.cached = { ...DEFAULT_TERMINAL_CONFIG }
    this.cachedMtimeMs = -1
    return { ...this.cached }
  }

  update(patch: Partial<TerminalConfig>): TerminalConfig {
    const errors = validateConfigPatch(patch)
    if (errors.length > 0) {
      throw new Error(errors.map((e) => e.message).join(' '))
    }

    const current = this.get()
    const merged = normalizeTerminalConfig(patch, current)
    this.persist(merged)
    return { ...merged }
  }

  reset(): TerminalConfig {
    const next = { ...DEFAULT_TERMINAL_CONFIG }
    this.persist(next)
    return { ...next }
  }

  private persist(config: TerminalConfig): void {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    const serialized = `${JSON.stringify(config, null, 2)}\n`
    const tempPath = `${this.configPath}.${process.pid}.tmp`
    writeFileSync(tempPath, serialized, { encoding: 'utf-8', mode: 0o600 })
    try {
      renameSync(tempPath, this.configPath)
    } catch {
      // On Windows, rename over an open file can occasionally fail; fall back to direct write.
      writeFileSync(this.configPath, serialized, { encoding: 'utf-8', mode: 0o600 })
    }
    try {
      this.cachedMtimeMs = statSync(this.configPath).mtimeMs
    } catch {
      this.cachedMtimeMs = Date.now()
    }
    this.cached = { ...config }
  }
}
