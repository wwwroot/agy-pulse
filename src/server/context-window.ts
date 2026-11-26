import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { calculateTurnCostUsd, resolveModelPricing } from '../shared/pricing.ts'
import type {
  ActiveSessionBinding,
  ConversationContextPoint,
  ConversationContextUsage,
  CostPricingOverrides,
} from '../shared/types.ts'

const MAX_CACHE_ENTRIES = 32
const MAX_TIMELINE_POINTS = 120
const READ_CHUNK_BYTES = 64 * 1024
const SAFE_CONV_ID_RE = /^[a-zA-Z0-9._-]+$/
const SESSION_TRANSCRIPTS_FILENAME = 'session-transcripts.json'
const ACTIVE_SESSION_FILENAME = 'active-session.json'

interface TranscriptAccumulator {
  turnCount: number
  peakContextTokens: number
  totalOutputTokens: number
  totalUncachedInputTokens: number
  totalCacheCreationInputTokens: number
  totalCacheReadTokens: number
  inputUsd: number
  cacheWriteUsd: number
  cacheReadUsd: number
  outputUsd: number
  cacheSavingsUsd: number
  lastTurnUsd: number
  uncachedInputTokens: number
  cacheCreationInputTokens: number
  cacheReadTokens: number
  lastOutputTokens: number
  latestModel: string
  latestUpdatedAt: number
  rawPoints: ConversationContextPoint[]
}

interface CachedContextEntry {
  filePath: string
  mtimeMs: number
  size: number
  ino: number
  dev: number
  committedOffset: number
  state: TranscriptAccumulator
  usage: ConversationContextUsage
}

interface SessionTranscriptRegistry {
  version?: number
  sessions?: Record<string, { transcriptPath?: unknown; updatedAt?: unknown }>
}

const transcriptCache = new Map<string, CachedContextEntry>()

function isSafeConversationId(conversationId: string): boolean {
  const trimmed = conversationId.trim()
  if (!trimmed || trimmed === 'default' || trimmed === 'all') return false
  if (trimmed.includes('..')) return false
  return SAFE_CONV_ID_RE.test(trimmed)
}

function readStoredTranscriptPath(conversationId: string, dataDir: string): string | null {
  if (!dataDir) return null
  const activePath = path.join(dataDir, ACTIVE_SESSION_FILENAME)
  try {
    if (existsSync(activePath)) {
      const parsed = JSON.parse(readFileSync(activePath, 'utf8')) as Partial<ActiveSessionBinding>
      if (
        parsed?.conversationId?.trim() === conversationId &&
        typeof parsed.transcriptPath === 'string' &&
        parsed.transcriptPath.trim().length > 0 &&
        existsSync(parsed.transcriptPath.trim())
      ) {
        return parsed.transcriptPath.trim()
      }
    }
  } catch {
    // Ignore malformed active-session.json.
  }

  const registryPath = path.join(dataDir, SESSION_TRANSCRIPTS_FILENAME)
  try {
    if (existsSync(registryPath)) {
      const parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as SessionTranscriptRegistry
      const entry = parsed?.sessions?.[conversationId]
      if (
        entry &&
        typeof entry.transcriptPath === 'string' &&
        entry.transcriptPath.trim().length > 0 &&
        existsSync(entry.transcriptPath.trim())
      ) {
        return entry.transcriptPath.trim()
      }
    }
  } catch {
    // Ignore malformed session-transcripts.json.
  }

  return null
}

function candidateAppDataDirs(): string[] {
  const raw = [
    process.env.ANTIGRAVITY_APP_DATA_DIR?.trim(),
    path.join(homedir(), '.gemini', 'antigravity'),
    path.join(homedir(), '.gemini', 'antigravity-ide'),
    path.join(homedir(), '.gemini', 'antigravity-cli'),
  ].filter((d): d is string => Boolean(d && d.length > 0))

  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of raw) {
    const resolved = path.resolve(dir)
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) continue
    seen.add(key)
    out.push(resolved)
  }
  return out
}

/**
 * Resolves the on-disk `transcript.jsonl` path for a conversation using explicit
 * overrides, hook-persisted session bindings, or standard Antigravity appData roots.
 */
export function resolveTranscriptFilePath(
  conversationId: string,
  dataDir: string,
  explicitTranscriptPath?: string,
): string | null {
  const explicit = typeof explicitTranscriptPath === 'string' ? explicitTranscriptPath.trim() : ''
  if (explicit && existsSync(explicit)) {
    return explicit
  }

  const convId = typeof conversationId === 'string' ? conversationId.trim() : ''
  if (!convId || convId === 'default' || convId === 'all') {
    return null
  }

  const stored = readStoredTranscriptPath(convId, dataDir)
  if (stored) {
    return stored
  }

  if (!isSafeConversationId(convId)) {
    return null
  }

  for (const appDir of candidateAppDataDirs()) {
    const candidate = path.join(appDir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl')
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

/**
 * Estimates the context window token limit for known model families.
 */
export function resolveModelContextLimit(model: string): {
  limit: number | null
  estimated: boolean
} {
  const m = model.trim().toLowerCase()
  if (!m) {
    return { limit: null, estimated: false }
  }
  if (m.startsWith('gemini-1.5-pro')) {
    return { limit: 2_000_000, estimated: true }
  }
  if (m.startsWith('gemini-')) {
    return { limit: 1_000_000, estimated: true }
  }
  if (m.startsWith('claude-')) {
    return { limit: m.includes('1m') ? 1_000_000 : 200_000, estimated: true }
  }
  if (m.startsWith('gpt-4.1')) {
    return { limit: 1_000_000, estimated: true }
  }
  if (m.startsWith('gpt-5.4') || (m.startsWith('gpt-5') && m.includes('1m'))) {
    return { limit: 1_000_000, estimated: true }
  }
  if (m.startsWith('gpt-5')) {
    return { limit: 400_000, estimated: true }
  }
  if (m.startsWith('gpt-4o') || m.startsWith('gpt-4-turbo')) {
    return { limit: 128_000, estimated: true }
  }
  if (/^(?:o1|o3|o4)(?:$|[-_.])/.test(m)) {
    return { limit: 200_000, estimated: true }
  }
  if (m.startsWith('grok-4')) {
    return { limit: 256_000, estimated: true }
  }
  if (m.startsWith('grok-3')) {
    return { limit: 131_072, estimated: true }
  }
  if (m.startsWith('deepseek-') || m.startsWith('qwen')) {
    return { limit: 128_000, estimated: true }
  }
  if (m.startsWith('llama-4')) {
    return { limit: 1_000_000, estimated: true }
  }
  if (m.startsWith('llama-3')) {
    return { limit: 128_000, estimated: true }
  }
  return { limit: null, estimated: false }
}

const EFFORT_LABELS: Record<string, string> = {
  xhigh: 'XHigh',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  minimal: 'Minimal',
  thinking: 'Thinking',
}

export function formatModelLabel(model: string): string {
  const trimmed = model.trim()
  if (!trimmed) return ''

  const parts = trimmed.split(/[-_]+/).filter(Boolean)
  if (parts.length === 0) return trimmed

  let effortLabel: string | null = null
  const lastLower = parts[parts.length - 1].toLowerCase()
  if (parts.length > 1 && EFFORT_LABELS[lastLower]) {
    effortLabel = EFFORT_LABELS[lastLower]
    parts.pop()
  }

  const merged: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const cur = parts[i]
    const next = parts[i + 1]
    // Join trailing numeric minor versions like `claude-sonnet-4-5` -> `4.5`.
    if (
      /^\d+$/.test(cur) &&
      next &&
      /^\d+$/.test(next) &&
      i + 1 === parts.length - 1
    ) {
      merged.push(`${cur}.${next}`)
      i += 1
      continue
    }
    merged.push(cur)
  }

  const formatted = merged.map((tok) => {
    const lower = tok.toLowerCase()
    if (lower === 'gpt') return 'GPT'
    if (/^\d+o$/i.test(tok)) return tok.toLowerCase()
    if (/^\d+(?:\.\d+)?$/.test(tok)) return tok
    return tok.charAt(0).toUpperCase() + tok.slice(1)
  })

  if (formatted[0] === 'GPT' && formatted.length > 1) {
    const head = `GPT-${formatted[1]}`
    const rest = formatted.slice(2)
    const base = [head, ...rest].join(' ')
    return effortLabel ? `${base} (${effortLabel})` : base
  }

  const base = formatted.join(' ')
  return effortLabel ? `${base} (${effortLabel})` : base
}

function asNonNegativeInt(val: unknown): number | null {
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) return null
  return Math.round(val)
}

function downsampleTimeline(
  points: ConversationContextPoint[],
  maxPoints = MAX_TIMELINE_POINTS,
): ConversationContextPoint[] {
  if (points.length <= maxPoints) {
    return points
  }

  const lastIdx = points.length - 1
  let peakIdx = 0
  for (let i = 1; i < points.length; i++) {
    if (points[i].contextTokens > points[peakIdx].contextTokens) {
      peakIdx = i
    }
  }

  const compactionDrops: Array<{ idx: number; dropRatio: number }> = []
  for (let i = 1; i < points.length; i++) {
    const prevTokens = points[i - 1].contextTokens
    const currTokens = points[i].contextTokens
    if (prevTokens > 0 && currTokens < prevTokens * 0.85) {
      compactionDrops.push({ idx: i, dropRatio: (prevTokens - currTokens) / prevTokens })
    }
  }

  const kept = new Set<number>([0, lastIdx, peakIdx])
  if (kept.size + compactionDrops.length <= maxPoints) {
    for (const drop of compactionDrops) {
      kept.add(drop.idx)
    }
  } else {
    compactionDrops.sort((a, b) => b.dropRatio - a.dropRatio)
    for (const drop of compactionDrops) {
      if (kept.size >= maxPoints) break
      kept.add(drop.idx)
    }
  }

  const remainingSlots = maxPoints - kept.size
  if (remainingSlots > 0) {
    for (let slot = 1; slot <= remainingSlots; slot++) {
      const target = Math.round((slot * lastIdx) / (remainingSlots + 1))
      if (!kept.has(target)) {
        kept.add(target)
        continue
      }
      // Nudge outward to nearest unpicked index when grid point collides with a landmark.
      for (let delta = 1; delta < points.length; delta++) {
        const right = target + delta
        if (right < lastIdx && !kept.has(right)) {
          kept.add(right)
          break
        }
        const left = target - delta
        if (left > 0 && !kept.has(left)) {
          kept.add(left)
          break
        }
      }
    }
  }

  return [...kept].sort((a, b) => a - b).map((idx) => points[idx])
}

function createEmptyAccumulator(): TranscriptAccumulator {
  return {
    turnCount: 0,
    peakContextTokens: 0,
    totalOutputTokens: 0,
    totalUncachedInputTokens: 0,
    totalCacheCreationInputTokens: 0,
    totalCacheReadTokens: 0,
    inputUsd: 0,
    cacheWriteUsd: 0,
    cacheReadUsd: 0,
    outputUsd: 0,
    cacheSavingsUsd: 0,
    lastTurnUsd: 0,
    uncachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadTokens: 0,
    lastOutputTokens: 0,
    latestModel: '',
    latestUpdatedAt: 0,
    rawPoints: [],
  }
}

function cloneAccumulator(src: TranscriptAccumulator): TranscriptAccumulator {
  return {
    ...src,
    rawPoints: src.rawPoints.slice(),
  }
}

function ingestTranscriptLine(
  line: string,
  acc: TranscriptAccumulator,
  costPricingOverrides?: CostPricingOverrides | null,
): void {
  if (!line || !line.includes('"PLANNER_RESPONSE"')) return
  let entry: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object') return
    entry = parsed as Record<string, unknown>
  } catch {
    return
  }

  if (entry.type !== 'PLANNER_RESPONSE') return

  const inp = asNonNegativeInt(entry.input_tokens)
  const cacheCreate = asNonNegativeInt(entry.cache_creation_input_tokens)
  const cache = asNonNegativeInt(entry.cache_read_tokens)
  const out = asNonNegativeInt(entry.output_tokens)
  if (inp === null && cacheCreate === null && cache === null && out === null) {
    return
  }

  const turnBaseInput = inp ?? 0
  const turnCacheCreate = cacheCreate ?? 0
  const turnUncached = turnBaseInput + turnCacheCreate
  const turnCache = cache ?? 0
  const turnOutput = out ?? 0
  const turnContext = turnUncached + turnCache + turnOutput

  acc.turnCount++
  acc.uncachedInputTokens = turnUncached
  acc.cacheCreationInputTokens = turnCacheCreate
  acc.cacheReadTokens = turnCache
  acc.lastOutputTokens = turnOutput
  acc.totalUncachedInputTokens += turnBaseInput
  acc.totalCacheCreationInputTokens += turnCacheCreate
  acc.totalCacheReadTokens += turnCache
  acc.totalOutputTokens += turnOutput
  if (turnContext > acc.peakContextTokens) {
    acc.peakContextTokens = turnContext
  }

  if (typeof entry.model === 'string' && entry.model.trim().length > 0) {
    acc.latestModel = entry.model.trim()
  }
  let pointTs = 0
  if (typeof entry.created_at === 'string') {
    const ts = Date.parse(entry.created_at)
    if (Number.isFinite(ts) && ts > 0) {
      pointTs = ts
      acc.latestUpdatedAt = ts
    }
  }

  const turnCost = calculateTurnCostUsd({
    model: acc.latestModel,
    uncachedInputTokens: turnBaseInput,
    cacheCreationInputTokens: turnCacheCreate,
    cacheReadTokens: turnCache,
    outputTokens: turnOutput,
    now: pointTs > 0 ? pointTs : Date.now(),
    overrides: costPricingOverrides,
  })
  acc.inputUsd += turnCost.inputUsd
  acc.cacheWriteUsd += turnCost.cacheWriteUsd
  acc.cacheReadUsd += turnCost.cacheReadUsd
  acc.outputUsd += turnCost.outputUsd
  acc.cacheSavingsUsd += turnCost.cacheSavingsUsd
  acc.lastTurnUsd = turnCost.totalUsd

  acc.rawPoints.push({
    turn: acc.turnCount,
    contextTokens: turnContext,
    cacheReadTokens: turnCache,
    outputTokens: turnOutput,
    ts: pointTs,
  })
}

function buildUsageFromAccumulator(
  conversationId: string,
  acc: TranscriptAccumulator,
  mtimeMs: number,
  costPricingOverrides?: CostPricingOverrides | null,
): ConversationContextUsage {
  const updatedAt = acc.latestUpdatedAt > 0 ? acc.latestUpdatedAt : Math.round(mtimeMs)
  if (acc.turnCount === 0) {
    return {
      available: false,
      conversationId,
      contextTokens: 0,
      promptTokens: 0,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      lastOutputTokens: 0,
      cacheHitPct: 0,
      contextLimit: null,
      limitEstimated: false,
      usagePct: null,
      remainingTokens: null,
      peakContextTokens: 0,
      totalOutputTokens: 0,
      turnCount: 0,
      lastTurnDeltaTokens: 0,
      timeline: [],
      updatedAt,
    }
  }

  const promptTokens = acc.uncachedInputTokens + acc.cacheReadTokens
  const contextTokens = promptTokens + acc.lastOutputTokens
  const lastTurnDeltaTokens =
    acc.rawPoints.length >= 2
      ? acc.rawPoints[acc.rawPoints.length - 1].contextTokens -
        acc.rawPoints[acc.rawPoints.length - 2].contextTokens
      : 0
  const timeline = downsampleTimeline(acc.rawPoints, MAX_TIMELINE_POINTS)
  const cacheHitPct =
    promptTokens > 0 ? Math.min(100, Math.round((acc.cacheReadTokens / promptTokens) * 100)) : 0
  const { limit: contextLimit, estimated: limitEstimated } = acc.latestModel
    ? resolveModelContextLimit(acc.latestModel)
    : { limit: null, estimated: false }
  const usagePct =
    contextLimit !== null && contextLimit > 0
      ? Math.min(100, Math.round((contextTokens / contextLimit) * 1000) / 10)
      : null
  const remainingTokens =
    contextLimit !== null ? Math.max(0, contextLimit - contextTokens) : null

  const latestRate = resolveModelPricing(
    acc.latestModel,
    updatedAt || Date.now(),
    promptTokens,
    costPricingOverrides,
  )
  const totalUsd = acc.inputUsd + acc.cacheWriteUsd + acc.cacheReadUsd + acc.outputUsd

  return {
    available: true,
    conversationId,
    ...(acc.latestModel
      ? { model: acc.latestModel, modelLabel: formatModelLabel(acc.latestModel) }
      : {}),
    contextTokens,
    promptTokens,
    uncachedInputTokens: acc.uncachedInputTokens,
    ...(acc.cacheCreationInputTokens > 0
      ? { cacheCreationInputTokens: acc.cacheCreationInputTokens }
      : {}),
    cacheReadTokens: acc.cacheReadTokens,
    lastOutputTokens: acc.lastOutputTokens,
    cacheHitPct,
    contextLimit,
    limitEstimated,
    usagePct,
    remainingTokens,
    peakContextTokens: acc.peakContextTokens,
    totalOutputTokens: acc.totalOutputTokens,
    turnCount: acc.turnCount,
    lastTurnDeltaTokens,
    timeline,
    cost: {
      totalUsd,
      inputUsd: acc.inputUsd,
      cacheReadUsd: acc.cacheReadUsd,
      cacheWriteUsd: acc.cacheWriteUsd,
      outputUsd: acc.outputUsd,
      cacheSavingsUsd: acc.cacheSavingsUsd,
      lastTurnUsd: acc.lastTurnUsd,
      totalUncachedInputTokens: acc.totalUncachedInputTokens,
      totalCacheReadTokens: acc.totalCacheReadTokens,
      totalCacheCreationInputTokens: acc.totalCacheCreationInputTokens,
      modelRateLabel: latestRate.label,
      inputPerMillion: latestRate.inputPerMillion,
      cacheReadPerMillion: latestRate.cacheReadPerMillion,
      outputPerMillion: latestRate.outputPerMillion,
      estimated: Boolean(latestRate.estimated),
    },
    updatedAt,
  }
}

/**
 * Incrementally reads bytes from `startOffset` up to `fileSize`, ingesting all
 * `\n`-terminated lines into `acc` and advancing `committedOffset`. Any trailing
 * non-newline line is evaluated ephemerally without mutating `acc` so partial
 * writes never corrupt cached state and files without a trailing newline still parse.
 */
function ingestTranscriptDelta(
  filePath: string,
  startOffset: number,
  fileSize: number,
  acc: TranscriptAccumulator,
  costPricingOverrides?: CostPricingOverrides | null,
): { committedOffset: number; effectiveAcc: TranscriptAccumulator } {
  const bytesToRead = Math.max(0, fileSize - startOffset)
  if (bytesToRead === 0) {
    return { committedOffset: startOffset, effectiveAcc: acc }
  }

  const fd = openSync(filePath, 'r')
  let committedOffset = startOffset
  let carryover: Buffer = Buffer.alloc(0)
  try {
    const chunkBuf = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, bytesToRead))
    let position = startOffset
    while (position < fileSize) {
      const toRead = Math.min(chunkBuf.length, fileSize - position)
      const n = readSync(fd, chunkBuf, 0, toRead, position)
      if (n <= 0) break
      position += n

      const slice = chunkBuf.subarray(0, n)
      const combined = carryover.length > 0 ? Buffer.concat([carryover, slice]) : slice
      const lastNl = combined.lastIndexOf(0x0a)
      if (lastNl !== -1) {
        const completeText = combined.subarray(0, lastNl).toString('utf8')
        for (const line of completeText.split(/\r?\n/)) {
          ingestTranscriptLine(line, acc, costPricingOverrides)
        }
        committedOffset += lastNl + 1
        carryover =
          lastNl + 1 < combined.length
            ? Buffer.from(combined.subarray(lastNl + 1))
            : Buffer.alloc(0)
      } else {
        carryover = Buffer.from(combined)
      }
    }
  } finally {
    closeSync(fd)
  }

  if (carryover.length > 0) {
    const trailingLine = carryover.toString('utf8').replace(/\r$/, '')
    if (trailingLine.includes('"PLANNER_RESPONSE"')) {
      const ephemeral = cloneAccumulator(acc)
      const prevTurns = ephemeral.turnCount
      ingestTranscriptLine(trailingLine, ephemeral, costPricingOverrides)
      if (ephemeral.turnCount > prevTurns) {
        return { committedOffset, effectiveAcc: ephemeral }
      }
    }
  }

  return { committedOffset, effectiveAcc: acc }
}

/**
 * Reads and caches token and model usage from a conversation's `transcript.jsonl`
 * via incremental byte-offset tailing, returning `null` if no transcript is found.
 */
export function readConversationContextUsage(
  conversationId: string,
  dataDir: string,
  explicitTranscriptPath?: string,
  costPricingOverrides?: CostPricingOverrides | null,
): ConversationContextUsage | null {
  const filePath = resolveTranscriptFilePath(conversationId, dataDir, explicitTranscriptPath)
  if (!filePath) return null

  let st: { mtimeMs: number; size: number; ino: number; dev: number }
  try {
    const rawStat = statSync(filePath)
    if (!rawStat.isFile()) return null
    st = {
      mtimeMs: rawStat.mtimeMs,
      size: rawStat.size,
      ino: rawStat.ino,
      dev: rawStat.dev,
    }
  } catch {
    return null
  }

  const overridesSig =
    costPricingOverrides && Object.keys(costPricingOverrides).length > 0
      ? JSON.stringify(costPricingOverrides)
      : ''
  const cacheKey = `${conversationId}|${filePath}|${overridesSig}`
  const cached = transcriptCache.get(cacheKey)
  if (
    cached &&
    cached.mtimeMs === st.mtimeMs &&
    cached.size === st.size &&
    cached.ino === st.ino &&
    cached.dev === st.dev
  ) {
    transcriptCache.delete(cacheKey)
    transcriptCache.set(cacheKey, cached)
    return cached.usage
  }

  try {
    const canTail =
      cached !== undefined &&
      cached.ino === st.ino &&
      cached.dev === st.dev &&
      st.size >= cached.committedOffset

    const acc = canTail ? cached.state : createEmptyAccumulator()
    const startOffset = canTail ? cached.committedOffset : 0

    const { committedOffset, effectiveAcc } = ingestTranscriptDelta(
      filePath,
      startOffset,
      st.size,
      acc,
      costPricingOverrides,
    )
    const usage = buildUsageFromAccumulator(
      conversationId,
      effectiveAcc,
      st.mtimeMs,
      costPricingOverrides,
    )

    transcriptCache.delete(cacheKey)
    transcriptCache.set(cacheKey, {
      filePath,
      mtimeMs: st.mtimeMs,
      size: st.size,
      ino: st.ino,
      dev: st.dev,
      committedOffset,
      state: acc,
      usage,
    })
    if (transcriptCache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = transcriptCache.keys().next().value
      if (oldestKey !== undefined) {
        transcriptCache.delete(oldestKey)
      }
    }
    return usage
  } catch {
    return null
  }
}
