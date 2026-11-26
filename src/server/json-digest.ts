import type { JsonDigest } from '../shared/types.ts'

const MIN_DIGEST_BYTES = 8 * 1024
const MAX_DIGEST_BYTES = 2 * 1024 * 1024
const MAX_PREVIEW_BYTES = 4 * 1024

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function buildStructuralSample(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > 160
      ? { type: 'string', length: value.length, prefix: value.slice(0, 160) }
      : value
  }
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
  ) {
    return { type: 'number', note: 'see full output for exact value' }
  }
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      ...(depth < 3
        ? {
            sample: value.slice(0, 3).map((item) => buildStructuralSample(item, depth + 1)),
            omitted: Math.max(0, value.length - 3),
          }
        : {}),
    }
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    return {
      type: 'object',
      keyCount: keys.length,
      keys: keys.slice(0, 12),
      ...(depth < 3
        ? {
            fields: Object.fromEntries(
              keys.slice(0, 8).map((k) => [k, buildStructuralSample(value[k], depth + 1)]),
            ),
            omitted: Math.max(0, keys.length - 8),
          }
        : {}),
    }
  }
  return value
}

/**
 * Scans up to 10,000 nodes for application-level error records and returns up to
 * 3 sampled matches.
 */
function collectErrorSamples(root: unknown): unknown[] {
  const stack: unknown[] = [root]
  const samples: unknown[] = []
  let visited = 0

  while (stack.length > 0 && visited++ < 10_000 && samples.length < 3) {
    const current = stack.pop()
    if (isPlainObject(current)) {
      const looksLikeError =
        Boolean(current.error) ||
        (Array.isArray(current.errors) && current.errors.length > 0) ||
        current.status === 'error' ||
        current.status === 'failed' ||
        current.success === false
      if (looksLikeError) {
        samples.push(buildStructuralSample(current, 1))
      }
      for (const child of Object.values(current)) {
        if (child !== null && typeof child === 'object') {
          stack.push(child)
        }
      }
    } else if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i--) {
        const child = current[i]
        if (child !== null && typeof child === 'object') {
          stack.push(child)
        }
      }
    }
  }

  return samples
}

/**
 * Builds a structural JSON digest for stdout payloads between 8 KiB and 2 MiB.
 * Returns undefined if the payload is ineligible or if the preview exceeds 4 KiB.
 */
export function buildJsonDigest(
  text: string,
  pointers: { fullRefId?: string; fullPath?: string } = {},
): JsonDigest | undefined {
  const trimmed = text.trim()
  const totalBytes = Buffer.byteLength(trimmed, 'utf-8')
  if (totalBytes < MIN_DIGEST_BYTES || totalBytes > MAX_DIGEST_BYTES) {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }

  const isArr = Array.isArray(parsed)
  const isObj = isPlainObject(parsed)
  if (!isArr && !isObj) {
    return undefined
  }

  const errorSamples = collectErrorSamples(parsed)
  const facts = {
    preview: buildStructuralSample(parsed, 0),
    ...(errorSamples.length > 0 ? { errorSamples } : {}),
  }
  const previewJson = JSON.stringify(facts)
  if (Buffer.byteLength(previewJson, 'utf-8') > MAX_PREVIEW_BYTES) {
    return undefined
  }

  let summary: string
  if (Array.isArray(parsed)) {
    summary = `JSON array with ${parsed.length} items (${totalBytes} bytes)`
  } else if (isPlainObject(parsed)) {
    const keys = Object.keys(parsed)
    const shownKeys = keys.slice(0, 6).join(', ')
    const suffix = keys.length > 6 ? `, +${keys.length - 6} more` : ''
    summary = `JSON object with ${keys.length} top-level keys [${shownKeys}${suffix}] (${totalBytes} bytes)`
  } else {
    return undefined
  }
  if (errorSamples.length > 0) {
    summary += `; sampled ${errorSamples.length} potential error record(s)`
  }

  return {
    kind: isArr ? 'array' : 'object',
    totalBytes,
    summary,
    preview: previewJson,
    fullRefId: pointers.fullRefId,
    fullPath: pointers.fullPath,
  }
}
