const ANSI_OSC_RE = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g
const ANSI_CSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g
const ANSI_ESC_SINGLE_RE = /\x1B[@-Z\\-_]/g

const PROTECT_TAIL_LINES = 15
const MIN_GREEN_RUN = 4

const BENIGN_ZERO_RE =
  /\b0\s+(?:errors?|failed|failures?|warnings?|warns?|problems?|issues?|failing|broken)\b/gi

const DANGER_TOKEN_RE =
  /(?:\b(?:error|errors|err!|fail|failed|failing|failure|fatal|panic|panicked|exception|traceback|assertion|rejected|timed\s+out|timeout|warn|warning|warnings|enoent|eacces|eperm|segfault|sigkill|sigsegv)\b|[a-z](?:Error|Exception)\b|[✖✗✘]|\bFAIL\b)/i

const GREEN_BUILD_LINE_RE =
  /^(?:\s*(?:Compiling|Downloading|Downloaded|Fresh|Checking|Updating|Locking|Adding|Packaging|Documenting|Running|Building|Transforming|Rendering|Bundling|Computing|Optimizing)\s+\S|\s*(?:✓|✔|PASS|ok\s+\S|test\s+\S.*\.\.\.\s+ok\s*$|ok\s+\d+\s+-|\+\s+\S|\d+\s+passing)|\s*(?:dist\/|build\/|out\/|\.?\/?sidecars\/)\S+\s+\d+(?:\.\d+)?\s*(?:b|kb|mb|kib|mib)\b|\s*vite\s+v\d|\s*\[info\]|\s*>\s+\S+@\S+)/i

function sliceUtf8Head(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { text, truncated: false }
  }
  const buf = Buffer.from(text, 'utf8')
  let end = Math.max(0, maxBytes)
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1
  }
  let sliced = buf.subarray(0, end).toString('utf8')
  if (sliced.endsWith('\uFFFD') && !text.startsWith(sliced)) {
    sliced = sliced.slice(0, -1)
  }
  return { text: sliced, truncated: true }
}

function sliceUtf8Tail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let start = Math.max(0, buf.length - maxBytes)
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start += 1
  }
  let sliced = buf.subarray(start).toString('utf8')
  if (sliced.startsWith('\uFFFD')) {
    sliced = sliced.slice(1)
  }
  return sliced
}

/**
 * Strips ANSI CSI/OSC control sequences and collapses carriage-return (`\r`)
 * progress spinner overwrites so only the final visible state of each line remains.
 */
export function normalizeTerminalOutput(raw: string): string {
  if (!raw) return ''
  const noAnsi = raw
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(ANSI_ESC_SINGLE_RE, '')

  if (!noAnsi.includes('\r')) {
    return noAnsi
  }

  const normalizedNewlines = noAnsi.replace(/\r\n/g, '\n')
  if (!normalizedNewlines.includes('\r')) {
    return normalizedNewlines
  }

  const lines = normalizedNewlines.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.includes('\r')) continue
    const parts = line.split('\r')
    let chosen = ''
    for (let j = parts.length - 1; j >= 0; j--) {
      if (parts[j].length > 0) {
        chosen = parts[j]
        break
      }
    }
    lines[i] = chosen
  }
  return lines.join('\n')
}

function containsDangerToken(line: string): boolean {
  const sanitized = line.replace(BENIGN_ZERO_RE, '')
  return DANGER_TOKEN_RE.test(sanitized)
}

function isFoldableGreenLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return false
  if (containsDangerToken(trimmed)) return false
  return GREEN_BUILD_LINE_RE.test(trimmed)
}

/**
 * Folds runs of >= 4 repetitive green build/test lines into a single summary line
 * while protecting the final 15 lines and any warning or error lines.
 */
export function foldGreenPhaseNoise(text: string): { text: string; foldedLines: number } {
  if (!text) return { text: '', foldedLines: 0 }
  const lines = text.split('\n')
  if (lines.length <= PROTECT_TAIL_LINES + MIN_GREEN_RUN) {
    return { text, foldedLines: 0 }
  }

  const foldableEnd = lines.length - PROTECT_TAIL_LINES
  const out: string[] = []
  let foldedTotal = 0
  let i = 0

  while (i < foldableEnd) {
    if (!isFoldableGreenLine(lines[i])) {
      out.push(lines[i])
      i += 1
      continue
    }

    let runEnd = i + 1
    while (runEnd < foldableEnd && isFoldableGreenLine(lines[runEnd])) {
      runEnd += 1
    }

    const runLen = runEnd - i
    if (runLen >= MIN_GREEN_RUN) {
      out.push(`[... folded ${runLen} green build/test lines ...]`)
      foldedTotal += runLen
    } else {
      for (let k = i; k < runEnd; k++) {
        out.push(lines[k])
      }
    }
    i = runEnd
  }

  for (let k = foldableEnd; k < lines.length; k++) {
    out.push(lines[k])
  }

  return { text: out.join('\n'), foldedLines: foldedTotal }
}

/**
 * Normalizes terminal control sequences and folds green build/test progress lines.
 * Leaves raw JSON payloads untouched for JSON Digest.
 */
export function compactTerminalStream(
  raw: string,
  preserveJson = false,
): { text: string; foldedLines: number } {
  if (!raw) return { text: '', foldedLines: 0 }
  if (preserveJson) {
    const firstNonWs = raw.trimStart()[0]
    if (firstNonWs === '{' || firstNonWs === '[') {
      return { text: raw, foldedLines: 0 }
    }
  }
  const clean = normalizeTerminalOutput(raw)
  return foldGreenPhaseNoise(clean)
}

/**
 * Failure-focused head-tail packer: allocates ~28% of budget to the first
 * root-cause error cluster and ~72% to the final stack trace / summary tail.
 */
export function packFailureHeadTail(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { text, truncated: false }
  }

  const dividerBase = '\n... [middle lines omitted; use pulse_result to page full output] ...\n'
  const dividerBytes = Buffer.byteLength(dividerBase, 'utf8')
  if (maxBytes <= dividerBytes + 128) {
    return sliceUtf8Head(text, maxBytes)
  }

  const usable = maxBytes - dividerBytes
  const headBudget = Math.max(128, Math.floor(usable * 0.28))
  const tailBudget = Math.max(256, usable - headBudget)

  const lines = text.split('\n')
  let firstErrorIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (containsDangerToken(lines[i])) {
      firstErrorIdx = i
      break
    }
  }

  let headCandidate: string
  if (firstErrorIdx > 2) {
    const clusterStart = Math.max(0, firstErrorIdx - 2)
    headCandidate = `[... skipped ${clusterStart} leading lines ...]\n${lines.slice(clusterStart).join('\n')}`
  } else {
    headCandidate = text
  }

  const headPart = sliceUtf8Head(headCandidate, headBudget).text.trimEnd()
  let tailPart = sliceUtf8Tail(text, tailBudget)
  // Align tail to the next newline boundary when possible.
  const firstNl = tailPart.indexOf('\n')
  if (firstNl > 0 && firstNl < tailPart.length - 1) {
    tailPart = tailPart.slice(firstNl + 1)
  }

  const combined = `${headPart}${dividerBase}${tailPart}`
  return {
    text: sliceUtf8Head(combined, maxBytes).text,
    truncated: true,
  }
}

/**
 * Fair water-filling budget allocator: items shorter than their equal share keep
 * their full length, and remaining budget is redistributed evenly across larger items.
 */
export function waterFill(lengths: readonly number[], totalBudget: number): number[] {
  const limits: number[] = new Array<number>(lengths.length).fill(0)
  let left = Math.max(0, Math.floor(totalBudget))
  const order = lengths
    .map((len, idx) => ({ idx, len: Math.max(0, Math.floor(Number.isFinite(len) ? len : 0)) }))
    .sort((a, b) => a.len - b.len || a.idx - b.idx)

  for (let k = 0; k < order.length; k++) {
    const remainingSlots = order.length - k
    const share = Math.floor(left / remainingSlots)
    const alloc = Math.min(order[k].len, share)
    limits[order[k].idx] = alloc
    left -= alloc
  }

  return limits
}

/**
 * UTF-8 byte-safe middle truncation that preserves head and tail context while
 * marking the exact omitted character count (`[… N chars omitted …]`).
 */
export function truncateMiddle(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const safeMax = Math.max(0, Math.floor(maxBytes))
  if (Buffer.byteLength(text, 'utf8') <= safeMax) {
    return { text, truncated: false }
  }
  if (safeMax === 0) {
    return { text: '', truncated: true }
  }

  const marker = (omittedChars: number): string => `[… ${omittedChars} chars omitted …]`
  const worstMarkerBytes = Buffer.byteLength(marker(text.length), 'utf8')
  const nlPadBytes = text.includes('\n') ? 2 : 0

  if (safeMax <= worstMarkerBytes + nlPadBytes + 16) {
    return sliceUtf8Head(text, safeMax)
  }

  const keepBytes = safeMax - worstMarkerBytes - nlPadBytes
  const headBudget = Math.ceil(keepBytes / 2)
  const tailBudget = Math.max(0, keepBytes - headBudget)

  const head = sliceUtf8Head(text, headBudget).text
  const tail = tailBudget > 0 ? sliceUtf8Tail(text, tailBudget) : ''
  const omittedChars = Math.max(1, text.length - head.length - tail.length)
  const sep = text.includes('\n') ? `\n${marker(omittedChars)}\n` : marker(omittedChars)
  const combined = `${head}${sep}${tail}`

  if (Buffer.byteLength(combined, 'utf8') <= safeMax) {
    return { text: combined, truncated: true }
  }
  return sliceUtf8Head(combined, safeMax)
}
