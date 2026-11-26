import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { resolveDataDir } from '../shared/paths.ts'
import type { ActiveSessionBinding } from '../shared/types.ts'

const execFileAsync = promisify(execFile)

const CONV_ID_RE = /^[a-zA-Z0-9._-]+$/
const METADATA_TTL_MS = 15_000
const METADATA_ERROR_TTL_MS = 4_000
const metadataCache = new Map<string, { at: number; ttl: number; roots: string[] }>()
const inFlightMetadata = new Map<string, Promise<string[]>>()

function normalizeComparablePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function uriToFsPath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('file://')) {
    try {
      return normalize(fileURLToPath(trimmed))
    } catch {
      return normalize(trimmed.slice(7))
    }
  }
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    const rest = trimmed.length > 1 ? trimmed.slice(2) : ''
    return normalize(resolve(homedir(), rest))
  }
  return normalize(trimmed)
}

function mergeUniqueDirRoots(...groups: Array<string[] | undefined>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const group of groups) {
    if (!group) continue
    for (const raw of group) {
      if (!raw) continue
      const parsed = uriToFsPath(raw)
      if (!parsed || !isDirectory(parsed)) continue
      const key = normalizeComparablePath(parsed)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(parsed)
    }
  }
  return out
}

export function isPathWithin(targetPath: string, rootPath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(targetPath))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

export function isRealPathWithin(targetPath: string, rootPath: string): boolean {
  const resolvedRoot = tryRealpath(rootPath) ?? resolve(rootPath)
  if (existsSync(targetPath)) {
    const resolvedTarget = tryRealpath(targetPath)
    if (!resolvedTarget) return false
    return isPathWithin(resolvedTarget, resolvedRoot)
  }
  const parent = dirname(targetPath)
  const resolvedParent = tryRealpath(parent)
  if (resolvedParent) {
    return isPathWithin(resolvedParent, resolvedRoot)
  }
  return isPathWithin(targetPath, rootPath)
}

async function fetchConversationRoots(conversationId: string): Promise<string[]> {
  if (!conversationId || !CONV_ID_RE.test(conversationId)) return []
  const cached = metadataCache.get(conversationId)
  const now = Date.now()
  if (cached && now - cached.at < cached.ttl) {
    return cached.roots
  }

  const pending = inFlightMetadata.get(conversationId)
  if (pending) {
    return pending
  }

  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE?.trim()
  if (!exe && !process.env.ANTIGRAVITY_LS_ADDRESS) {
    return []
  }

  const file = exe || 'agentapi'
  const baseName = basename(file).toLowerCase()
  const prefix = exe && !baseName.startsWith('agentapi') ? ['agentapi'] : []

  const task = (async (): Promise<string[]> => {
    try {
      const { stdout } = await execFileAsync(
        file,
        [...prefix, 'get-conversation-metadata', conversationId],
        {
          encoding: 'utf-8',
          timeout: 2500,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
        },
      )
      const parsed = stdout.trim() ? JSON.parse(stdout) : null
      const meta =
        parsed?.response?.conversationMetadata?.metadata ??
        parsed?.response?.conversation_metadata?.metadata ??
        parsed?.conversationMetadata?.metadata ??
        parsed?.metadata
      const rawUris: unknown[] = Array.isArray(meta?.workspaceUris)
        ? meta.workspaceUris
        : Array.isArray(meta?.workspace_uris)
          ? meta.workspace_uris
          : []
      const roots = rawUris
        .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
        .map(uriToFsPath)
        .filter((p) => p && isDirectory(p))

      metadataCache.set(conversationId, { at: Date.now(), ttl: METADATA_TTL_MS, roots })
      return roots
    } catch {
      metadataCache.set(conversationId, { at: Date.now(), ttl: METADATA_ERROR_TTL_MS, roots: [] })
      return []
    } finally {
      inFlightMetadata.delete(conversationId)
    }
  })()

  inFlightMetadata.set(conversationId, task)
  return task
}

const ACTIVE_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days (supports resumed conversations across restarts)
const AUTHORIZED_WORKSPACES_FILENAME = 'authorized-workspaces.json'

interface AuthorizedWorkspacesRegistryFile {
  version?: number
  sessions?: Record<string, { workspacePaths?: unknown; updatedAt?: unknown }>
}

function isBroadOrUnsafeRoot(dirPath: string): boolean {
  const resolved = resolve(dirPath)
  if (resolved === parse(resolved).root) return true
  if (normalizeComparablePath(resolved) === normalizeComparablePath(resolve(homedir()))) {
    return true
  }
  return isPluginRuntimeDir(resolved)
}

function readHookWorkspacePaths(dataDir: string, conversationId?: string): string[] {
  const filePath = join(dataDir, 'active-session.json')
  try {
    if (!existsSync(filePath)) return []
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<ActiveSessionBinding>
    const updatedAt =
      typeof parsed?.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : 0
    if (updatedAt <= 0 || Date.now() - updatedAt > ACTIVE_SESSION_MAX_AGE_MS) {
      return []
    }
    const boundConvId = typeof parsed?.conversationId === 'string' ? parsed.conversationId.trim() : ''
    if (conversationId && boundConvId && boundConvId !== conversationId) {
      return []
    }
    if (!Array.isArray(parsed?.workspacePaths)) {
      return []
    }
    return mergeUniqueDirRoots(parsed.workspacePaths)
  } catch {
    return []
  }
}

/**
 * Reads all workspace roots recorded across active/recent Antigravity conversations
 * in `${dataDir}/authorized-workspaces.json` so parallel conversations in different
 * projects do not lock each other out with WORKDIR_OUTSIDE_WORKSPACE / FILE_OUTSIDE_WORKSPACE.
 *
 * Returns both the exact conversation-matched roots (`preferred`) and the merged list (`all`).
 */
function readAuthorizedRegistrySplit(
  dataDir: string,
  preferredConvId?: string,
): { preferred: string[]; all: string[] } {
  const filePath = join(dataDir, AUTHORIZED_WORKSPACES_FILENAME)
  try {
    if (!existsSync(filePath)) return { preferred: [], all: [] }
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as AuthorizedWorkspacesRegistryFile
    if (!parsed?.sessions || typeof parsed.sessions !== 'object') return { preferred: [], all: [] }

    const now = Date.now()
    const preferredRaw: string[] = []
    const others: Array<{ updatedAt: number; paths: string[] }> = []

    for (const [convKey, entry] of Object.entries(parsed.sessions)) {
      const updatedAt =
        typeof entry?.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
          ? entry.updatedAt
          : 0
      if (updatedAt <= 0 || now - updatedAt > ACTIVE_SESSION_MAX_AGE_MS) continue
      if (!Array.isArray(entry?.workspacePaths)) continue
      const paths = entry.workspacePaths.filter(
        (p): p is string => typeof p === 'string' && p.trim().length > 0,
      )
      if (paths.length === 0) continue
      if (preferredConvId && convKey === preferredConvId) {
        preferredRaw.push(...paths)
      } else {
        others.push({ updatedAt, paths })
      }
    }

    others.sort((a, b) => b.updatedAt - a.updatedAt)
    const preferred = mergeUniqueDirRoots(preferredRaw).filter((p) => !isBroadOrUnsafeRoot(p))
    const all = mergeUniqueDirRoots(preferred, ...others.map((o) => o.paths)).filter(
      (p) => !isBroadOrUnsafeRoot(p),
    )
    return { preferred, all }
  } catch {
    return { preferred: [], all: [] }
  }
}

function isPluginRuntimeDir(dirPath: string): boolean {
  const norm = normalizeComparablePath(dirPath)
  return (
    norm.endsWith('/sidecars/pulse') ||
    norm.endsWith('/sidecars/pulse/dist') ||
    norm.endsWith('/plugins/agy-pulse')
  )
}

export async function resolveWorkspaceRoots(
  conversationId?: string,
  hintRoot?: string,
  hintRoots?: string[],
  dataDir: string = resolveDataDir(),
): Promise<string[]> {
  const convId = conversationId?.trim() || process.env.ANTIGRAVITY_CONVERSATION_ID?.trim() || ''
  const hinted = mergeUniqueDirRoots(hintRoot ? [hintRoot] : undefined, hintRoots).filter(
    (p) => !isBroadOrUnsafeRoot(p),
  )
  const hookRoots = readHookWorkspacePaths(dataDir, convId || undefined).filter(
    (p) => !isBroadOrUnsafeRoot(p),
  )
  const registry = readAuthorizedRegistrySplit(dataDir, convId || undefined)

  // 1. When a conversation has authoritative host hook roots (active-session.json or
  //    authorized-workspaces.json[convId]), place them first (0ms fast-path, no agentapi spawn)
  //    and merge any UI hints + other open workspaces so a stale UI hint can never poison
  //    the conversation's primary root or lock out its real workspace.
  if (convId && (hookRoots.length > 0 || registry.preferred.length > 0)) {
    return mergeUniqueDirRoots(hookRoots, registry.preferred, hinted, registry.all)
  }

  // 2. Explicit workspace hints (standalone mode, CLI --cwd, or UI selection before hook bind)
  //    fast-path in 0ms while keeping any other authorized workspaces accessible.
  if (hinted.length > 0) {
    return mergeUniqueDirRoots(hinted, hookRoots, registry.all)
  }

  // 3. Without a conversation ID, honor active-session.json before spawning agentapi.
  if (hookRoots.length > 0) {
    return mergeUniqueDirRoots(hookRoots, registry.all)
  }

  // 4. Only spawn agentapi get-conversation-metadata when neither hooks nor hints resolved convId.
  const convRoots = await fetchConversationRoots(convId)
  if (convRoots.length > 0) {
    return mergeUniqueDirRoots(convRoots, registry.all)
  }

  // 5. If active-session.json belonged to another conversation, still authorize all open Antigravity workspaces.
  if (registry.all.length > 0) {
    return registry.all
  }

  const envWorkspace = process.env.ANTIGRAVITY_WORKSPACE_DIR?.trim()
  if (envWorkspace) {
    const candidate = uriToFsPath(envWorkspace)
    if (candidate && isDirectory(candidate)) {
      return [candidate]
    }
  }

  const cwd = process.cwd()
  // Never surface the plugin's own runtime directory or silently widen the jail to homedir().
  if (isPluginRuntimeDir(cwd)) {
    return []
  }

  return isDirectory(cwd) ? [cwd] : []
}
