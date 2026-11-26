import path from 'node:path'
import type {
  ConversationContextUsage,
  ExecOutcome,
  FailureInfo,
  HostHealthSnapshot,
  JobOutputResponse,
  JobSummary,
  MutateOutcome,
  QuotaSnapshot,
  ReadDocOutcome,
  ReadFilesOutcome,
  ResultPageResponse,
  SavingsCategory,
  SearchOutcome,
  SessionSummary,
  ShellInfo,
  SidecarNotice,
  SpillEntrySummary,
  TerminalConfig,
  TokenSavingsSummary,
} from '../shared/types.ts'

export const MAX_RENDERED_BYTES = 9_400

export interface McpToolResult {
  [key: string]: unknown
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export interface DaemonSyncStatus {
  connected: boolean
  mode: 'sidecar-daemon' | 'local-fallback'
  pid?: number
  port?: number
  version?: string
  mcpVersion?: string
  clientInfo?: { name: string; version?: string }
  dataDir: string
  workspaceRoots: string[]
  primaryWorkspaceRoot: string
  workerAvailable: boolean
  workerPath?: string
  dedupEntryCount?: number
  sessionId?: string
}

const CODE_FENCE_LANG_BY_EXT: Record<string, string> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
  '.rs': 'rust',
  '.py': 'python',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.rb': 'ruby',
  '.php': 'php',
  '.json': 'json',
  '.jsonc': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.vue': 'html',
  '.svelte': 'html',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.sql': 'sql',
  '.xml': 'xml',
  '.svg': 'xml',
  '.diff': 'diff',
  '.patch': 'diff',
}

/**
 * Wraps literal content in a Markdown backtick code fence whose delimiter length
 * adapts automatically so backticks inside `body` can never break the fence.
 */
export function renderCodeFence(body: string, lang = 'text'): string {
  const trimmed = body.replace(/\r?\n$/, '')
  let maxTicks = 0
  const matches = trimmed.match(/`+/g)
  if (matches) {
    for (const run of matches) {
      if (run.length > maxTicks) maxTicks = run.length
    }
  }
  const fence = '`'.repeat(Math.max(3, maxTicks + 1))
  return `${fence}${lang}\n${trimmed}\n${fence}`
}

function inlineCode(value: string): string {
  let maxTicks = 0
  const matches = value.match(/`+/g)
  if (matches) {
    for (const run of matches) {
      if (run.length > maxTicks) maxTicks = run.length
    }
  }
  const delim = '`'.repeat(maxTicks + 1)
  const needsPad =
    value.startsWith('`') ||
    value.endsWith('`') ||
    (value.startsWith(' ') && value.endsWith(' ') && value.trim().length > 0)
  return needsPad ? `${delim} ${value} ${delim}` : `${delim}${value}${delim}`
}

function inferCodeFenceLang(filePath: string, view?: string): string {
  if (view === 'hex') return 'text'
  const ext = path.extname(filePath).toLowerCase()
  return CODE_FENCE_LANG_BY_EXT[ext] ?? 'text'
}

function shortRev(rev: string): string {
  return rev.length > 12 ? rev.slice(0, 12) : rev
}

function findUnclosedBacktickFence(text: string): string | null {
  let openFence: string | null = null
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (openFence === null) {
      const openMatch = /^(`{3,})[^`]*$/.exec(line)
      if (openMatch) {
        openFence = openMatch[1]
      }
    } else {
      const closeMatch = /^(`{3,})[ \t]*$/.exec(line)
      if (closeMatch && closeMatch[1].length >= openFence.length) {
        openFence = null
      }
    }
  }
  return openFence
}

/**
 * Truncates text so its UTF-8 byte length stays within `maxBytes` without
 * splitting a UTF-16 surrogate pair or leaving an unclosed Markdown code fence.
 */
export function capUtf8Text(
  text: string,
  maxBytes: number = MAX_RENDERED_BYTES,
  hasSpillRef = false,
): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text
  }

  const notice = hasSpillRef
    ? '\n... [output capped for inline budget; use pulse_result to page full output]'
    : '\n... [output capped at 9,400-byte MCP inline budget; narrow range or limit to inspect more]'
  const noticeBytes = Buffer.byteLength(notice, 'utf8')
  const budget = Math.max(0, maxBytes - noticeBytes)
  if (budget === 0) {
    return sliceUtf8Safe(text, maxBytes)
  }

  const candidate = sliceUtf8Safe(text, budget)
  const unclosedFence = findUnclosedBacktickFence(candidate)
  if (!unclosedFence) {
    return `${candidate}${notice}`
  }

  const closer = `\n${unclosedFence}\n`
  const closerBytes = Buffer.byteLength(closer, 'utf8')
  if (budget <= closerBytes) {
    return `${candidate}${notice}`
  }

  const trimmedPrefix = sliceUtf8Safe(text, budget - closerBytes)
  const stillUnclosed = findUnclosedBacktickFence(trimmedPrefix)
  if (stillUnclosed) {
    const finalCloser = `\n${stillUnclosed}\n`
    const finalCloserBytes = Buffer.byteLength(finalCloser, 'utf8')
    const finalPrefix =
      finalCloserBytes <= closerBytes
        ? trimmedPrefix
        : sliceUtf8Safe(text, Math.max(0, budget - finalCloserBytes))
    return `${finalPrefix}${finalCloser}${notice}`
  }
  return `${trimmedPrefix}${notice}`
}

function sliceUtf8Safe(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) return ''

  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    let end = mid
    if (end > 0) {
      const code = text.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff) {
        end -= 1
      }
    }
    const bytes = Buffer.byteLength(text.slice(0, end), 'utf8')
    if (bytes <= maxBytes) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }

  let safeEnd = lo
  if (safeEnd > 0) {
    const code = text.charCodeAt(safeEnd - 1)
    if (code >= 0xd800 && code <= 0xdbff) {
      safeEnd -= 1
    }
  }

  let candidate = text.slice(0, safeEnd)
  while (safeEnd > 0 && Buffer.byteLength(candidate, 'utf8') > maxBytes) {
    safeEnd -= 1
    if (safeEnd > 0) {
      const code = text.charCodeAt(safeEnd - 1)
      if (code >= 0xd800 && code <= 0xdbff) {
        safeEnd -= 1
      }
    }
    candidate = text.slice(0, safeEnd)
  }

  return candidate
}

function buildResult(
  text: string,
  structuredContent?: Record<string, unknown>,
  isError?: boolean,
): McpToolResult {
  const hasSpillRef =
    typeof structuredContent?.refId === 'string' && structuredContent.refId.length > 0
  const capped = capUtf8Text(text, MAX_RENDERED_BYTES, hasSpillRef)
  const result: McpToolResult = {
    content: [{ type: 'text', text: capped }],
  }
  if (structuredContent !== undefined) {
    result.structuredContent = structuredContent
  }
  if (isError) {
    result.isError = true
  }
  return result
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

function relativizePath(targetPath: string, baseDir?: string): string {
  if (!baseDir) return targetPath
  const rel = path.relative(baseDir, targetPath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return targetPath
  }
  return rel.replace(/\\/g, '/')
}

function renderNumberedLines(content: string, startOffset: number): string {
  if (content.length === 0) return ''
  const rawLines = content.split(/\r?\n/)
  // Drop trailing empty split caused by terminal newline.
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop()
  }
  const firstPrefix = `${startOffset}|`
  if (rawLines[0]?.startsWith(firstPrefix)) {
    return rawLines.join('\n')
  }
  return rawLines.map((line, i) => `${startOffset + i}|${line}`).join('\n')
}

function formatSpillBlock(refId: string, spillPath: string | undefined, targetLabel: string): string {
  const pathNote = spillPath ? ` spillPath=${inlineCode(spillPath)}` : ''
  return [
    `- [Stored reference: refId=${refId}]${pathNote}`,
    `- Page/search: ${inlineCode(`pulse_result({ action: "page", ref_id: "${refId}", offset: 1, limit: 200 })`)} (${targetLabel})`,
  ].join('\n')
}

function formatFailureBlock(failure: FailureInfo, heading?: string): string {
  const header =
    heading ??
    `**[Failure]** \`code=${failure.code}\` · \`effectState=${failure.effectState}\` · \`retry=${failure.retry}\``
  return [
    header,
    `- **Message:** ${failure.message}`,
    `- **Next:** ${failure.nextAction}`,
  ].join('\n')
}

export function formatFailure(
  toolName: string,
  failure: FailureInfo,
  extra?: Record<string, unknown>,
): McpToolResult {
  const header = `**\`[${toolName}]\`** \`status=error\` · \`code=${failure.code}\` · \`effectState=${failure.effectState}\` · \`retry=${failure.retry}\``
  return buildResult(
    formatFailureBlock(failure, header),
    {
      ok: false,
      tool: toolName,
      failure,
      ...(extra ?? {}),
    },
    true,
  )
}

export function formatReadFiles(outcome: ReadFilesOutcome): McpToolResult {
  const sections: string[] = []
  const metaLines: string[] = []

  if (outcome.refId) {
    metaLines.push(formatSpillBlock(outcome.refId, outcome.spillPath, 'full output'))
  }

  if (outcome.baseDir) {
    metaLines.push(`- [Base: "${outcome.baseDir}"]`)
  }

  if (metaLines.length > 0) {
    sections.push(metaLines.join('\n'))
  }

  if (outcome.failure) {
    sections.push(formatFailureBlock(outcome.failure))
  }

  const statLines: string[] = []
  const flushStatLines = () => {
    if (statLines.length > 0) {
      sections.push(renderCodeFence(statLines.join('\n'), 'text'))
      statLines.length = 0
    }
  }

  for (const item of outcome.items) {
    const displayPath = relativizePath(item.path, outcome.baseDir)

    if (item.view === 'stat' && !item.error && item.exists) {
      const kind = item.isDir ? 'dir' : 'file'
      const linePart = item.lineCount !== null ? ` lines=${item.lineCount}` : ''
      const mtimePart = item.mtimeMs !== undefined ? ` mtime=${Math.round(item.mtimeMs)}` : ''
      const revPart = item.revision ? ` rev=${item.revision}` : ''
      statLines.push(
        `${displayPath} [${kind} bytes=${item.bytes}${linePart}${mtimePart}${revPart}]`,
      )
      continue
    }

    flushStatLines()

    if (item.error) {
      sections.push(
        [
          `#### ${inlineCode(displayPath)}`,
          `- **[Error: ${item.error.code}]** \`effectState=${item.error.effectState}\` — ${item.error.message}`,
        ].join('\n'),
      )
      continue
    }

    if (!item.exists) {
      sections.push([`#### ${inlineCode(displayPath)}`, '- [Missing: path does not exist]'].join('\n'))
      continue
    }

    const viewTag =
      item.view === 'hex'
        ? ' `(hex)`'
        : item.view === 'outline'
          ? ' `[outline]`'
          : item.view === 'symbol'
            ? ` ${inlineCode(`[symbol=${item.symbol ?? ''}]`)}`
            : ''
    const escapedTag = item.escaped ? ' `(escaped)`' : ''

    if (item.deduplicated) {
      sections.push(
        [
          `#### ${inlineCode(displayPath)}${viewTag}${escapedTag}`,
          `[Unchanged: already read in this session; rev=${item.revision}]`,
        ].join('\n'),
      )
      continue
    }

    const tailState = item.eof
      ? 'eof'
      : `next=${item.nextOffset ?? item.offset + item.returnedLines}`
    let savedTag = ''
    if (item.view === 'outline' || item.view === 'symbol') {
      const fullBytes = item.fullFileBytes ?? item.bytes
      const deliveredItemBytes = Buffer.byteLength(item.content, 'utf8')
      const savedItemBytes = Math.max(0, fullBytes - deliveredItemBytes)
      savedTag = ` saved=${formatBytes(savedItemBytes)} (${savedItemBytes}/${fullBytes} B)`
    }

    const header = `#### ${inlineCode(displayPath)}${viewTag}${escapedTag}`
    const footer = `\`[rev=${item.revision}${savedTag} ${tailState}]\``

    if (item.content.length > 0) {
      const body =
        item.view === 'text'
          ? renderNumberedLines(item.content, item.offset)
          : item.content
      const lang = inferCodeFenceLang(item.path, item.view)
      sections.push(`${header}\n${renderCodeFence(body, lang)}\n${footer}`)
    } else {
      sections.push(`${header}\n_(empty)_\n${footer}`)
    }
  }

  flushStatLines()

  if (outcome.items.some((it) => it.view === 'outline' && !it.error && !it.deduplicated)) {
    sections.push(
      '[Tip: fetch a specific symbol directly via `pulse_read_files({ files: [{ path, symbol: "Type::fn" }] })`]',
    )
  }

  if (sections.length === 0) {
    sections.push('**`[pulse_read_files]`** No files returned.')
  }

  const isError = outcome.status === 'failed' || outcome.status === 'rejected'
  const structured: Record<string, unknown> = {
    status: outcome.status,
    ...(outcome.baseDir ? { baseDir: outcome.baseDir } : {}),
    durationMs: outcome.durationMs,
    rawBytes: outcome.rawBytes,
    deliveredBytes: outcome.deliveredBytes,
    savedBytes: outcome.savedBytes,
    dedupHits: outcome.dedupHits,
    items: outcome.items.map((it) => ({
      path: it.path,
      exists: it.exists,
      ...(it.isDir !== undefined ? { isDir: it.isDir } : {}),
      bytes: it.bytes,
      lineCount: it.lineCount,
      revision: it.revision,
      view: it.view,
      ...(it.symbol ? { symbol: it.symbol } : {}),
      ...(it.fullFileBytes !== undefined ? { fullFileBytes: it.fullFileBytes } : {}),
      offset: it.offset,
      returnedLines: it.returnedLines,
      nextOffset: it.nextOffset,
      eof: it.eof,
      ...(it.deduplicated ? { deduplicated: true } : {}),
      ...(it.error ? { error: it.error } : {}),
    })),
  }
  if (outcome.refId) structured.refId = outcome.refId
  if (outcome.spillPath) structured.spillPath = outcome.spillPath
  if (outcome.failure) structured.failure = outcome.failure

  return buildResult(sections.join('\n\n'), structured, isError)
}

export function formatSearch(outcome: SearchOutcome): McpToolResult {
  const sections: string[] = []

  if (outcome.refId) {
    sections.push(formatSpillBlock(outcome.refId, outcome.spillPath, 'full results'))
  }

  if (outcome.failure) {
    const header = `**\`[pulse_search:${outcome.action}]\`** \`status=${outcome.status}\` · \`code=${outcome.failure.code}\` · \`effectState=${outcome.failure.effectState}\``
    sections.push(formatFailureBlock(outcome.failure, header))
    return buildResult(sections.join('\n\n'), { ...outcome }, true)
  }

  const isGitAction = outcome.action === 'git_status' || outcome.action === 'git_diff'
  const mode =
    outcome.outputMode ??
    (outcome.action === 'glob' || outcome.action === 'fuzzy'
      ? outcome.action
      : isGitAction
        ? outcome.action
        : 'content')
  const entries = outcome.entries ?? []
  const nextPart = outcome.nextOffset !== null ? ` next=${outcome.nextOffset}` : ''
  const truncPart = outcome.truncated ? ' truncated=true' : ''
  const incompletePart = !outcome.scanComplete ? ' scanComplete=false' : ''

  if (isGitAction) {
    const branchPart = outcome.gitBranch ? ` branch=${outcome.gitBranch}` : ''
    const dirtyPart =
      outcome.gitDirtyFiles !== undefined ? ` dirty=${outcome.gitDirtyFiles}` : ''
    const savedPart =
      outcome.savedBytes > 0 ? ` saved=${formatBytes(outcome.savedBytes)}` : ''
    sections.push(
      `**\`[${outcome.action}]\`** root=${inlineCode(outcome.root)} \`${`${branchPart}${dirtyPart} duration=${formatDuration(outcome.durationMs)}${savedPart}${truncPart}`.trim()}\``,
    )

    const gitBody = outcome.gitText?.trimEnd() ?? ''
    if (
      outcome.gitSkippedLockfiles &&
      outcome.gitSkippedLockfiles.length > 0 &&
      !gitBody.includes('skipped ')
    ) {
      const shown = outcome.gitSkippedLockfiles.slice(0, 8).join(', ')
      const more =
        outcome.gitSkippedLockfiles.length > 8
          ? ` +${outcome.gitSkippedLockfiles.length - 8} more`
          : ''
      sections.push(
        `[skipped ${outcome.gitSkippedLockfiles.length} lockfile/artifact(s): ${shown}${more}]`,
      )
    }

    if (gitBody.length > 0) {
      sections.push(renderCodeFence(gitBody, outcome.action === 'git_diff' ? 'diff' : 'text'))
    } else {
      sections.push(outcome.action === 'git_status' ? '_(clean working tree)_' : '_(no diff)_')
    }
  } else {
    const bodyLines: string[] = []
    if (outcome.action === 'glob' || outcome.action === 'fuzzy') {
      sections.push(
        `**\`[${outcome.action}]\`** root=${inlineCode(outcome.root)} \`matched=${outcome.totalMatched} scanned=${outcome.filesScanned} duration=${formatDuration(outcome.durationMs)}${truncPart}${incompletePart}${nextPart}\``,
      )
      for (const e of entries) {
        const rel = relativizePath(e.path, outcome.root)
        const suffix = e.kind === 'directory' ? '/' : ''
        bodyLines.push(`${rel}${suffix}`)
      }
    } else if (mode === 'definitions') {
      const defCount = outcome.definitionMatches ?? entries.length
      const impliedRefs =
        outcome.impliedReferences ?? Math.max(0, outcome.totalMatched - defCount)
      sections.push(
        `**\`[grep:definitions]\`** root=${inlineCode(outcome.root)} \`definitions=${defCount} (implied refs=${impliedRefs}) files=${outcome.totalFilesMatched} scanned=${outcome.filesScanned}${truncPart}${incompletePart}${nextPart}\``,
      )
      for (const e of entries) {
        const rel = relativizePath(e.path, outcome.root)
        const kind = e.declKind ?? e.kind ?? 'def'
        const lineNo = e.line ?? 0
        bodyLines.push(`[${kind}] ${rel}:${lineNo}|${e.text ?? ''}`)
      }
    } else if (mode === 'summary') {
      sections.push(
        `**\`[grep:summary]\`** root=${inlineCode(outcome.root)} \`matches=${outcome.totalMatched} files=${outcome.totalFilesMatched} scanned=${outcome.filesScanned} duration=${formatDuration(outcome.durationMs)}${truncPart}${incompletePart}${nextPart}\``,
      )
      for (const e of entries) {
        const rel = relativizePath(e.path, outcome.root)
        bodyLines.push(`${rel}:${e.count ?? 0}`)
      }
    } else if (mode === 'count') {
      sections.push(
        `**\`[grep:count]\`** root=${inlineCode(outcome.root)} \`matches=${outcome.totalMatched} files=${outcome.totalFilesMatched} scanned=${outcome.filesScanned}${truncPart}${incompletePart}${nextPart}\``,
      )
      for (const e of entries) {
        const rel = relativizePath(e.path, outcome.root)
        bodyLines.push(`${rel}:${e.count ?? 0}`)
      }
    } else if (mode === 'files_with_matches') {
      sections.push(
        `**\`[grep:files]\`** root=${inlineCode(outcome.root)} \`files=${outcome.totalFilesMatched} matches=${outcome.totalMatched} scanned=${outcome.filesScanned}${truncPart}${incompletePart}${nextPart}\``,
      )
      for (const e of entries) {
        bodyLines.push(relativizePath(e.path, outcome.root))
      }
    } else {
      sections.push(
        `**\`[grep:content]\`** root=${inlineCode(outcome.root)} \`matches=${outcome.totalMatched} files=${outcome.totalFilesMatched} scanned=${outcome.filesScanned}${truncPart}${incompletePart}${nextPart}\``,
      )
      for (const e of entries) {
        const rel = relativizePath(e.path, outcome.root)
        const lineNo = e.line ?? 0
        if (e.before && e.before.length > 0) {
          const startBefore = Math.max(1, lineNo - e.before.length)
          e.before.forEach((b, idx) => {
            bodyLines.push(`${rel}:${startBefore + idx}-${b}`)
          })
        }
        bodyLines.push(`${rel}:${lineNo}|${e.text ?? ''}`)
        if (e.after && e.after.length > 0) {
          e.after.forEach((a, idx) => {
            bodyLines.push(`${rel}:${lineNo + 1 + idx}-${a}`)
          })
        }
      }
    }

    if (bodyLines.length > 0) {
      sections.push(renderCodeFence(bodyLines.join('\n'), 'text'))
    } else if (outcome.totalMatched === 0) {
      sections.push('_(no matches)_')
    }
  }

  const isError = outcome.status === 'failed' || outcome.status === 'rejected'
  const structured: Record<string, unknown> = {
    status: outcome.status,
    action: outcome.action,
    outputMode: mode,
    root: outcome.root,
    totalMatched: outcome.totalMatched,
    totalFilesMatched: outcome.totalFilesMatched,
    filesScanned: outcome.filesScanned,
    ...(outcome.definitionMatches !== undefined
      ? { definitionMatches: outcome.definitionMatches }
      : {}),
    ...(outcome.impliedReferences !== undefined
      ? { impliedReferences: outcome.impliedReferences }
      : {}),
    ...(outcome.gitBranch !== undefined ? { gitBranch: outcome.gitBranch } : {}),
    ...(outcome.gitDirtyFiles !== undefined ? { gitDirtyFiles: outcome.gitDirtyFiles } : {}),
    ...(outcome.gitSkippedLockfiles !== undefined
      ? { gitSkippedLockfiles: outcome.gitSkippedLockfiles }
      : {}),
    scanComplete: outcome.scanComplete,
    truncated: outcome.truncated,
    nextOffset: outcome.nextOffset,
    durationMs: outcome.durationMs,
    rawBytes: outcome.rawBytes,
    deliveredBytes: outcome.deliveredBytes,
    savedBytes: outcome.savedBytes,
    returnedEntries: entries.length,
    ...(outcome.refId ? { refId: outcome.refId } : {}),
    ...(outcome.spillPath ? { spillPath: outcome.spillPath } : {}),
  }

  return buildResult(sections.join('\n\n'), structured, isError)
}

export function formatMutate(outcome: MutateOutcome): McpToolResult {
  const headerParts = [
    `status=${outcome.status}`,
    `duration=${formatDuration(outcome.durationMs)}`,
  ]
  if (outcome.dryRun) headerParts.push('dryRun=true')
  if (outcome.filesChanged !== undefined) headerParts.push(`files=${outcome.filesChanged}`)
  if (outcome.totalReplacements !== undefined) {
    headerParts.push(`replacements=${outcome.totalReplacements}`)
  }
  if (outcome.addedLines !== undefined || outcome.removedLines !== undefined) {
    headerParts.push(`+${outcome.addedLines ?? 0}/-${outcome.removedLines ?? 0}`)
  }
  if (outcome.roundTripsSaved !== undefined && outcome.roundTripsSaved > 0) {
    headerParts.push(`roundTripsSaved=${outcome.roundTripsSaved}`)
  }

  const sections: string[] = [
    `**\`[pulse_mutate:${outcome.action}]\`** \`${headerParts.join(' ')}\``,
  ]

  const metaLines: string[] = []
  if (outcome.refId) {
    metaLines.push(formatSpillBlock(outcome.refId, outcome.spillPath, 'full diff'))
  }
  if (outcome.path) {
    metaLines.push(`- **Path:** ${inlineCode(outcome.path)}`)
  }
  if (outcome.beforeRevision || outcome.afterRevision) {
    if (outcome.beforeRevision && outcome.afterRevision) {
      metaLines.push(
        `- **Rev:** ${inlineCode(shortRev(outcome.beforeRevision))} -> ${inlineCode(outcome.afterRevision)}`,
      )
    } else if (outcome.afterRevision) {
      metaLines.push(`- **Rev:** ${inlineCode(outcome.afterRevision)}`)
    } else if (outcome.beforeRevision) {
      metaLines.push(`- **Before rev:** ${inlineCode(outcome.beforeRevision)}`)
    }
  }
  if (outcome.skippedFiles && outcome.skippedFiles.length > 0) {
    metaLines.push(
      `- **Skipped (${outcome.skippedFiles.length}):** ${outcome.skippedFiles.map(inlineCode).join(', ')}`,
    )
  }
  if (metaLines.length > 0) {
    sections.push(metaLines.join('\n'))
  }

  if (outcome.failure) {
    sections.push(formatFailureBlock(outcome.failure))
  }

  if (outcome.batchResults && outcome.batchResults.length > 0) {
    const batchLines = outcome.batchResults.map((r) => {
      const dest = r.to ? ` -> ${r.to}` : ''
      const err = r.error ? ` (${r.error})` : ''
      return `#${r.index} ${r.op} ${r.path}${dest} [${r.status}]${err}`
    })
    sections.push(renderCodeFence(batchLines.join('\n'), 'text'))
  }

  if (outcome.diff && outcome.diff.length > 0) {
    sections.push(renderCodeFence(outcome.diff, 'diff'))
  }

  const isError = outcome.status === 'failed' || outcome.status === 'rejected'
  const structured: Record<string, unknown> = {
    status: outcome.status,
    action: outcome.action,
    dryRun: outcome.dryRun,
    durationMs: outcome.durationMs,
    ...(outcome.path ? { path: outcome.path } : {}),
    ...(outcome.beforeRevision ? { beforeRevision: outcome.beforeRevision } : {}),
    ...(outcome.afterRevision ? { afterRevision: outcome.afterRevision } : {}),
    ...(outcome.addedLines !== undefined ? { addedLines: outcome.addedLines } : {}),
    ...(outcome.removedLines !== undefined ? { removedLines: outcome.removedLines } : {}),
    ...(outcome.filesChanged !== undefined ? { filesChanged: outcome.filesChanged } : {}),
    ...(outcome.totalReplacements !== undefined
      ? { totalReplacements: outcome.totalReplacements }
      : {}),
    ...(outcome.roundTripsSaved !== undefined
      ? { roundTripsSaved: outcome.roundTripsSaved }
      : {}),
    ...(outcome.skippedFiles ? { skippedFiles: outcome.skippedFiles } : {}),
    ...(outcome.batchResults ? { batchResults: outcome.batchResults } : {}),
    ...(outcome.refId ? { refId: outcome.refId } : {}),
    ...(outcome.spillPath ? { spillPath: outcome.spillPath } : {}),
    ...(outcome.failure ? { failure: outcome.failure } : {}),
  }

  return buildResult(sections.join('\n\n'), structured, isError)
}

export function formatReadDoc(outcome: ReadDocOutcome): McpToolResult {
  const sections: string[] = []

  if (outcome.refId) {
    sections.push(formatSpillBlock(outcome.refId, outcome.spillPath, 'full document'))
  }

  if (outcome.failure) {
    const header = `**\`[pulse_read_doc:${outcome.format}]\`** \`status=${outcome.status}\` · \`code=${outcome.failure.code}\` · \`effectState=${outcome.failure.effectState}\``
    sections.push([`- **Path:** ${inlineCode(outcome.path)}`, formatFailureBlock(outcome.failure, header)].join('\n\n'))
    return buildResult(sections.join('\n\n'), { ...outcome }, true)
  }

  const endUnit =
    outcome.returnedUnits > 0 ? outcome.offset + outcome.returnedUnits - 1 : outcome.offset
  const rangeStr =
    outcome.returnedUnits > 0
      ? `${outcome.offset}-${endUnit}/${outcome.totalUnits}`
      : `0/${outcome.totalUnits}`
  const nextPart = outcome.nextOffset !== null ? ` next=${outcome.nextOffset}` : ' eof'

  const metaLines: string[] = [
    `**\`[pulse_read_doc:${outcome.format}]\`** ${inlineCode(outcome.path)} \`bytes=${formatBytes(outcome.bytes)} ${outcome.unitName}=${rangeStr}${nextPart} duration=${formatDuration(outcome.durationMs)}\``,
  ]
  if (outcome.columns && outcome.columns.length > 0) {
    metaLines.push(`- **Columns:** ${outcome.columns.map(inlineCode).join(' · ')}`)
  }
  sections.push(metaLines.join('\n'))

  if (outcome.content.length > 0) {
    sections.push(renderCodeFence(outcome.content, 'text'))
  } else {
    sections.push('_(no content in requested range)_')
  }

  const isError = outcome.status === 'failed' || outcome.status === 'rejected'
  const structured: Record<string, unknown> = {
    status: outcome.status,
    path: outcome.path,
    format: outcome.format,
    bytes: outcome.bytes,
    totalUnits: outcome.totalUnits,
    unitName: outcome.unitName,
    offset: outcome.offset,
    returnedUnits: outcome.returnedUnits,
    nextOffset: outcome.nextOffset,
    complete: outcome.complete,
    ...(outcome.columns ? { columns: outcome.columns } : {}),
    durationMs: outcome.durationMs,
    rawBytes: outcome.rawBytes,
    deliveredBytes: outcome.deliveredBytes,
    savedBytes: outcome.savedBytes,
    ...(outcome.refId ? { refId: outcome.refId } : {}),
    ...(outcome.spillPath ? { spillPath: outcome.spillPath } : {}),
  }

  return buildResult(sections.join('\n\n'), structured, isError)
}

export function formatExecOutcome(outcome: ExecOutcome): McpToolResult {
  const headerParts = [
    `status=${outcome.status}`,
    `kind=${outcome.kind}`,
    `shell=${outcome.shell}`,
    `exit=${outcome.exitCode === null ? 'null' : String(outcome.exitCode)}`,
    `duration=${formatDuration(outcome.durationMs)}`,
  ]
  if (outcome.signal) headerParts.push(`signal=${outcome.signal}`)
  if (outcome.timedOut) headerParts.push('timedOut=true')
  if (outcome.cancelled) headerParts.push('cancelled=true')
  if (outcome.failure) headerParts.push(`effectState=${outcome.failure.effectState}`)

  const sections: string[] = [
    `**\`[pulse_exec]\`** \`${headerParts.join(' ')}\``,
  ]

  // Surface cwd, job, and spill handles ABOVE inline output so they are never clipped.
  const metaLines: string[] = [`- **Cwd:** ${inlineCode(outcome.cwd)}`]
  if (outcome.jobId) {
    metaLines.push(
      `- **[Job: ${outcome.jobId}]** Wait/read via ${inlineCode(`pulse_job({ action: "output", job_id: "${outcome.jobId}", wait: true })`)}`,
    )
  }

  const primaryRefId = outcome.refId ?? outcome.jsonDigest?.fullRefId
  if (primaryRefId) {
    metaLines.push(formatSpillBlock(primaryRefId, outcome.spillPath, 'full output'))
  }

  if (outcome.guidance) {
    metaLines.push(`- **[Guidance]** ${outcome.guidance}`)
  }

  sections.push(metaLines.join('\n'))

  if (outcome.failure) {
    sections.push(formatFailureBlock(outcome.failure))
  }

  if (outcome.jsonDigest) {
    const digest = outcome.jsonDigest
    const digestHeader = `**[JSON Digest]** \`kind=${digest.kind} total=${formatBytes(digest.totalBytes)}\` — ${digest.summary}`
    if (digest.preview.trim().length > 0) {
      sections.push(`${digestHeader}\n${renderCodeFence(digest.preview, 'json')}`)
    } else {
      sections.push(digestHeader)
    }
  }

  const suppressRawStdout = Boolean(outcome.jsonDigest && primaryRefId)
  if (!suppressRawStdout && outcome.stdout.length > 0) {
    const label = outcome.stdoutTruncated ? '**stdout (truncated)**' : '**stdout**'
    sections.push(`${label}\n${renderCodeFence(outcome.stdout, 'text')}`)
  }

  if (outcome.stderr.length > 0) {
    const label = outcome.stderrTruncated ? '**stderr (truncated)**' : '**stderr**'
    sections.push(`${label}\n${renderCodeFence(outcome.stderr, 'text')}`)
  }

  if (
    !outcome.failure &&
    !outcome.jsonDigest &&
    outcome.stdout.length === 0 &&
    outcome.stderr.length === 0
  ) {
    if (outcome.status === 'running') {
      sections.push('_(Job started in background; no output yet.)_')
    } else if (outcome.status === 'promoted') {
      sections.push('_(Exceeded foreground timeout; promoted to background job.)_')
    } else {
      sections.push('_(no output)_')
    }
  }

  const isError =
    outcome.status === 'failed' ||
    outcome.status === 'rejected' ||
    outcome.status === 'cancelled'

  const structured: Record<string, unknown> = {
    id: outcome.id,
    status: outcome.status,
    kind: outcome.kind,
    description: outcome.description,
    shell: outcome.shell,
    cwd: outcome.cwd,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    cancelled: outcome.cancelled,
    durationMs: outcome.durationMs,
    stdoutTruncated: outcome.stdoutTruncated,
    stderrTruncated: outcome.stderrTruncated,
  }
  if (outcome.jobId) structured.jobId = outcome.jobId
  if (primaryRefId) structured.refId = primaryRefId
  if (outcome.spillPath) structured.spillPath = outcome.spillPath
  if (outcome.jsonDigest) {
    structured.jsonDigest = {
      kind: outcome.jsonDigest.kind,
      totalBytes: outcome.jsonDigest.totalBytes,
      summary: outcome.jsonDigest.summary,
      fullRefId: outcome.jsonDigest.fullRefId,
    }
  }
  if (outcome.guidance) structured.guidance = outcome.guidance
  if (outcome.failure) structured.failure = outcome.failure

  return buildResult(sections.join('\n\n'), structured, isError)
}

export function formatJobList(jobs: JobSummary[]): McpToolResult {
  if (jobs.length === 0) {
    return buildResult('**`[pulse_job]`** No background or promoted jobs.', {
      jobs: [],
      runningCount: 0,
    })
  }

  const runningCount = jobs.filter((j) => j.status === 'running').length
  const sections: string[] = [
    `**\`[pulse_job]\`** \`total=${jobs.length} running=${runningCount}\``,
  ]

  const rows: string[] = []
  for (const job of jobs) {
    const refPart = job.refId ? ` refId=${job.refId}` : ''
    const promotedPart = job.promotedFromForeground ? ' promoted=true' : ''
    const exitPart = job.exitCode === null ? '' : ` exit=${job.exitCode}`
    rows.push(
      `- ${inlineCode(job.id)} \`[${job.status}]${exitPart} shell=${job.shell} duration=${formatDuration(job.durationMs)} out=${formatBytes(job.stdoutBytes)} err=${formatBytes(job.stderrBytes)}${promotedPart}${refPart}\` — ${job.description} (${inlineCode(job.cwd)} · ${inlineCode(job.commandPreview)})`,
    )
  }
  sections.push(rows.join('\n'))

  return buildResult(sections.join('\n\n'), {
    jobs,
    runningCount,
  })
}

export function formatJobOutput(res: JobOutputResponse): McpToolResult {
  const { job } = res
  const headerParts = [
    `jobId=${job.id}`,
    `status=${job.status}`,
    `shell=${job.shell}`,
    `exit=${job.exitCode === null ? 'null' : String(job.exitCode)}`,
    `duration=${formatDuration(job.durationMs)}`,
    `eof=${res.eof}`,
    `nextStdout=${res.nextStdoutOffset}`,
    `nextStderr=${res.nextStderrOffset}`,
  ]
  if (res.truncated) headerParts.push('truncated=true')

  const sections: string[] = [
    `**\`[pulse_job:output]\`** \`${headerParts.join(' ')}\``,
  ]

  const metaLines: string[] = [`- **Cwd:** ${inlineCode(job.cwd)}`]
  if (job.refId) {
    metaLines.push(formatSpillBlock(job.refId, undefined, 'full spilled output'))
  }
  sections.push(metaLines.join('\n'))

  if (res.stdout.length > 0) {
    sections.push(`**stdout**\n${renderCodeFence(res.stdout, 'text')}`)
  }

  if (res.stderr.length > 0) {
    sections.push(`**stderr**\n${renderCodeFence(res.stderr, 'text')}`)
  }

  if (res.stdout.length === 0 && res.stderr.length === 0) {
    sections.push(
      !res.eof && job.status === 'running'
        ? '_(No new output yet. Use `wait=true` to block until output or exit.)_'
        : '_(No new output at requested offsets.)_',
    )
  }

  return buildResult(sections.join('\n\n'), {
    job,
    nextStdoutOffset: res.nextStdoutOffset,
    nextStderrOffset: res.nextStderrOffset,
    eof: res.eof,
    truncated: res.truncated,
  })
}

export function formatJobInput(
  jobId: string,
  bytesWritten: number,
  job?: JobSummary,
): McpToolResult {
  const statusPart = job ? ` status=${job.status}` : ''
  const text = `**\`[pulse_job:input]\`** \`jobId=${jobId}${statusPart} bytesWritten=${bytesWritten}\``
  return buildResult(text, {
    jobId,
    bytesWritten,
    ...(job ? { job } : {}),
  })
}

export function formatJobKill(
  jobId: string,
  killed: boolean,
  job?: JobSummary,
  note?: string,
): McpToolResult {
  const statusPart = job ? ` status=${job.status}` : ''
  const sections = [`**\`[pulse_job:kill]\`** \`jobId=${jobId} killed=${killed}${statusPart}\``]
  if (note) sections.push(note)
  return buildResult(sections.join('\n\n'), {
    jobId,
    killed,
    ...(job ? { job } : {}),
    ...(note ? { note } : {}),
  })
}

export function formatResultPage(page: ResultPageResponse): McpToolResult {
  const rawContent = page.content ?? ''
  let displayedContent = rawContent
  let displayedReturnedLines = page.returnedLines
  let displayedNextOffset = page.nextOffset
  let displayedComplete = page.complete

  const renderPageText = (
    content: string,
    returnedLines: number,
    nextOffset: number | null,
    complete: boolean,
  ): string => {
    const endLine = returnedLines > 0 ? page.offset + returnedLines - 1 : page.offset
    const nextPart = nextOffset === null ? 'eof' : `next=${nextOffset}`
    const header = [
      `- [Stored reference: refId=${page.refId}]`,
      `- **\`[pulse_result:page]\`** \`lines=${returnedLines > 0 ? `${page.offset}-${endLine}` : '0'}/${page.totalLines} bytes=${formatBytes(page.totalBytes)} complete=${complete} ${nextPart}\``,
    ].join('\n')
    const body =
      content.length > 0
        ? renderCodeFence(content, 'text')
        : '_(No lines matched range or search filter.)_'
    return `${header}\n\n${body}`
  }

  // Fit complete lines inside MAX_RENDERED_BYTES when a caller requests a larger max_bytes
  // so formatResultPage never suffers mid-line re-truncation inside buildResult.
  if (
    rawContent.length > 0 &&
    Buffer.byteLength(
      renderPageText(rawContent, displayedReturnedLines, displayedNextOffset, displayedComplete),
      'utf8',
    ) > MAX_RENDERED_BYTES
  ) {
    const lines = rawContent.split('\n')
    const kept: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const candidateLines = [...kept, lines[i]]
      const candidateContent = candidateLines.join('\n')
      const candidateReturned = candidateLines.length
      const candidateNext = page.offset + candidateReturned
      const candidateText = renderPageText(candidateContent, candidateReturned, candidateNext, false)
      if (Buffer.byteLength(candidateText, 'utf8') > MAX_RENDERED_BYTES) {
        break
      }
      kept.push(lines[i])
    }
    if (kept.length > 0 && kept.length < lines.length) {
      displayedContent = kept.join('\n')
      displayedReturnedLines = kept.length
      displayedComplete = false
      displayedNextOffset = page.offset + kept.length
    }
  }

  return buildResult(
    renderPageText(
      displayedContent,
      displayedReturnedLines,
      displayedNextOffset,
      displayedComplete,
    ),
    {
      refId: page.refId,
      totalLines: page.totalLines,
      totalBytes: page.totalBytes,
      offset: page.offset,
      returnedLines: displayedReturnedLines,
      nextOffset: displayedNextOffset,
      complete: displayedComplete,
      meta: page.meta,
    },
  )
}

export function formatResultRelease(refId: string, released: boolean): McpToolResult {
  const text = released
    ? `**\`[pulse_result:release]\`** Released ${inlineCode(refId)}.`
    : `**\`[pulse_result:release]\`** Reference ${inlineCode(refId)} not found or already released.`
  return buildResult(text, {
    refId,
    released,
  })
}

const CATEGORY_ORDER: readonly SavingsCategory[] = [
  'read-dedup',
  'outline-read',
  'symbol-read',
  'batch-read',
  'grep-progressive',
  'git-compact',
  'json-digest',
  'spillover',
  'batch-mutate',
  'native-doc',
]

function formatQuotaResetBrief(resetsAt: number | null): string {
  if (resetsAt === null || !Number.isFinite(resetsAt) || resetsAt <= 0) return 'reset unknown'
  const diffMs = resetsAt - Date.now()
  if (diffMs <= 0) return 'resets now'
  const totalMin = Math.ceil(diffMs / 60_000)
  if (totalMin < 60) return `resets in ${totalMin}m`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h < 24) return m > 0 ? `resets in ${h}h ${m}m` : `resets in ${h}h`
  const d = Math.floor(h / 24)
  const remH = h % 24
  return remH > 0 ? `resets in ${d}d ${remH}h` : `resets in ${d}d`
}

export function formatStats(params: {
  telemetry: TokenSavingsSummary
  shells: ShellInfo[]
  config: TerminalConfig
  sync: DaemonSyncStatus
  spills: SpillEntrySummary[]
  sessionId?: string
  sessionScope?: 'conversation' | 'all'
  sessions?: SessionSummary[]
  contextWindow?: ConversationContextUsage | null
  quotas?: QuotaSnapshot | null
  hostHealth?: HostHealthSnapshot | null
  notices?: SidecarNotice[]
  daemonVersion?: string
  mcpVersion?: string
}): McpToolResult {
  const { telemetry, shells, config, sync, spills } = params
  const sessionId = params.sessionId ?? sync.sessionId ?? 'default'
  const sessionScope = params.sessionScope ?? 'conversation'
  const sessions = params.sessions ?? []
  const daemonVersion = params.daemonVersion ?? sync.version
  const mcpVersion = params.mcpVersion ?? sync.mcpVersion ?? '1.0.0'
  const versionSkewWarning =
    sync.connected && daemonVersion && mcpVersion && daemonVersion !== mcpVersion
      ? `Version skew detected: daemon v${daemonVersion} vs MCP server v${mcpVersion}. Restart Antigravity or reload the plugin.`
      : undefined

  const reductionPct =
    telemetry.totalRawBytes > 0
      ? ((telemetry.totalSavedBytes / telemetry.totalRawBytes) * 100).toFixed(1)
      : '0.0'

  const sections: string[] = [
    `**\`[pulse_result:stats]\`** \`session=${sessionId} scope=${sessionScope} mode=${sync.mode} synced=${sync.connected} worker=${sync.workerAvailable ? 'ready' : 'unavailable'}\``,
  ]

  const summaryLines: string[] = [
    `- **Savings:** ~${telemetry.estimatedTokensSaved.toLocaleString('en-US')} tokens saved (${reductionPct}% reduction) · avoided=${formatBytes(telemetry.totalSavedBytes)} / raw=${formatBytes(telemetry.totalRawBytes)} · dedupHits=${telemetry.dedupHits} · roundTripsSaved=${telemetry.roundTripsSaved} · calls=${telemetry.totalCalls} · avg=${formatDuration(telemetry.avgDurationMs)}`,
    `- **Runtime:** workspace=${inlineCode(sync.primaryWorkspaceRoot)} · worker=${inlineCode(sync.workerPath ?? (sync.workerAvailable ? 'detected' : 'missing'))} · dedupEntries=${sync.dedupEntryCount ?? 0} · activeSpills=${spills.length} · recentSessions=${sessions.length}`,
    sync.connected && sync.port !== undefined
      ? `- **Sidecar:** \`127.0.0.1:${sync.port}\` \`pid=${sync.pid ?? 'unknown'} v=${daemonVersion ?? 'unknown'}\` · [Pulse](sidecar://agy-pulse/pulse/)`
      : `- **Sidecar:** offline (local fallback \`v${mcpVersion}\`) · [Pulse](sidecar://agy-pulse/pulse/)`,
    `- **Config:** \`shell=${config.defaultShell} readDedup=${config.enableReadDedup} maxInline=${formatBytes(config.maxInlineBytes)} timeout=${formatDuration(config.defaultTimeoutMs)} autoPromote=${config.autoPromoteOnTimeout} jsonDigest=${config.enableJsonDigest} credFence=${config.enableCredentialFence} retention=${config.sessionRetentionDays}d/${config.sessionMaxCount}\``,
  ]

  if (versionSkewWarning) {
    summaryLines.push(`- **Version skew:** ${versionSkewWarning}`)
  }

  if (params.contextWindow?.available) {
    const cw = params.contextWindow
    const modelPart = cw.modelLabel ?? cw.model ?? 'unknown'
    const pctPart =
      typeof cw.usagePct === 'number' ? `${cw.usagePct.toFixed(1)}%` : 'n/a'
    const capPart = cw.contextLimit
      ? `${cw.contextTokens.toLocaleString('en-US')}/${cw.contextLimit.toLocaleString('en-US')} tok`
      : `${cw.contextTokens.toLocaleString('en-US')} tok`
    summaryLines.push(
      `- **Context Window:** \`${modelPart}\` ${pctPart} (${capPart}) · cacheHit=${cw.cacheHitPct.toFixed(0)}% · turns=${cw.turnCount}`,
    )
  }

  sections.push(summaryLines.join('\n'))

  if (params.quotas) {
    const q = params.quotas
    const qLines = [`**Antigravity quotas** \`source=${q.source}\``]
    if (q.error) {
      qLines.push(`- unavailable: ${q.error}`)
    }
    for (const pool of q.pools) {
      if (pool.disabled || pool.windows.length === 0) {
        qLines.push(`- \`${pool.name}\`: disabled`)
        continue
      }
      const winParts = pool.windows.map((w) => {
        const pct = `${Math.round(w.remaining * 100)}% left`
        const reset = formatQuotaResetBrief(w.resetsAt)
        const unused =
          typeof w.projectedUnused === 'number' && w.projectedUnused >= 0.01
            ? ` · ~${Math.round(w.projectedUnused * 100)}% unused`
            : ''
        return `${w.label} ${pct} (${reset}${unused})`
      })
      qLines.push(`- \`${pool.name}\`: ${winParts.join(' · ')}`)
    }
    for (const warn of q.warnings) {
      qLines.push(`- warning: ${warn}`)
    }
    sections.push(qLines.join('\n'))
  }

  if (params.hostHealth && params.hostHealth.entries.length > 0) {
    const hLines = ['**Host MCP health**']
    for (const e of params.hostHealth.entries) {
      hLines.push(`- \`${e.host}\` \`[${e.status}]\` ${e.detail}`)
    }
    for (const warn of params.hostHealth.warnings.slice(0, 3)) {
      hLines.push(`- warning: ${warn}`)
    }
    sections.push(hLines.join('\n'))
  }

  const activeCategories = CATEGORY_ORDER.filter(
    (cat) => telemetry.byCategory[cat]?.calls > 0 || telemetry.byCategory[cat]?.savedBytes > 0,
  )
  if (activeCategories.length > 0) {
    const catLines = ['**By mechanism**']
    for (const cat of activeCategories) {
      const entry = telemetry.byCategory[cat]
      catLines.push(
        `- \`${cat}\`: calls=${entry.calls} · saved=${formatBytes(entry.savedBytes)} (~${entry.estimatedTokensSaved} tok)`,
      )
    }
    sections.push(catLines.join('\n'))
  }

  if (spills.length > 0) {
    const spillLines = ['**Active spills**']
    for (const s of spills.slice(0, 10)) {
      spillLines.push(
        `- ${inlineCode(s.refId)} \`[${s.tool}]\` ${formatBytes(s.totalBytes)} — ${s.description}`,
      )
    }
    if (spills.length > 10) {
      spillLines.push(`- ... +${spills.length - 10} more`)
    }
    sections.push(spillLines.join('\n'))
  }

  const shellLines = ['**Shells**']
  for (const sh of shells) {
    const def = sh.isDefault ? ' [default]' : ''
    const status = sh.available ? 'ok' : 'unavailable'
    const ver = sh.version ? ` (${sh.version})` : ''
    shellLines.push(`- \`${sh.id}${def}\` \`[${status}]\` ${inlineCode(sh.executable)}${ver}`)
  }
  sections.push(shellLines.join('\n'))

  return buildResult(sections.join('\n\n'), {
    sessionId,
    sessionScope,
    sessionsCount: sessions.length,
    sessions,
    telemetry,
    sync,
    spills,
    shells,
    config,
    ...(daemonVersion ? { daemonVersion } : {}),
    mcpVersion,
    ...(versionSkewWarning ? { versionSkewWarning } : {}),
    ...(params.contextWindow !== undefined ? { contextWindow: params.contextWindow } : {}),
    ...(params.quotas !== undefined ? { quotas: params.quotas } : {}),
    ...(params.hostHealth !== undefined ? { hostHealth: params.hostHealth } : {}),
    ...(params.notices !== undefined ? { notices: params.notices } : {}),
  })
}
