import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { FailureInfo } from './types.ts'

export type PathResolutionResult =
  | { ok: true; path: string }
  | { ok: false; failure: FailureInfo }

/**
 * Resolves the plugin data directory shared between the Sidecar daemon and the Stdio MCP server.
 */
export function resolveDataDir(): string {
  const fromEnv =
    process.env.AGY_PULSE_DATA_DIR?.trim() || process.env.PLUGIN_DATA?.trim()
  if (fromEnv) {
    return path.resolve(fromEnv)
  }
  const appDataDir =
    process.env.ANTIGRAVITY_APP_DATA_DIR?.trim() ||
    path.join(homedir(), '.gemini', 'antigravity')
  return path.join(path.resolve(appDataDir), 'plugin_data', 'agy-pulse')
}

function getPathModule(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}

function realpathOrNearestAncestor(
  targetPath: string,
  platform: NodeJS.Platform,
): string {
  const pathMod = getPathModule(platform)
  const normalized = pathMod.resolve(targetPath)

  // Only invoke host fs.realpathSync when evaluating paths for the current host OS.
  if (platform !== process.platform) {
    return normalized
  }

  const realpathFn =
    typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync

  try {
    return realpathFn(normalized)
  } catch {
    // Walk up until we find an existing ancestor so symlinks above a not-yet-created path are still resolved.
    const trailing: string[] = []
    let current = normalized
    while (true) {
      const parent = pathMod.dirname(current)
      if (parent === current) {
        return normalized
      }
      trailing.unshift(pathMod.basename(current))
      current = parent
      if (existsSync(current)) {
        try {
          const resolvedAncestor = realpathFn(current)
          return pathMod.join(resolvedAncestor, ...trailing)
        } catch {
          return normalized
        }
      }
    }
  }
}

function isWithinRoot(
  candidate: string,
  root: string,
  platform: NodeJS.Platform,
): boolean {
  const pathMod = getPathModule(platform)
  const normCandidate = pathMod.resolve(candidate)
  const normRoot = pathMod.resolve(root)

  if (platform === 'win32') {
    const cLower = normCandidate.toLowerCase()
    const rLower = normRoot.toLowerCase()
    if (cLower === rLower) return true
    const rel = pathMod.relative(rLower, cLower)
    return rel === '' || (!rel.startsWith('..') && !pathMod.isAbsolute(rel))
  }

  if (normCandidate === normRoot) return true
  const rel = pathMod.relative(normRoot, normCandidate)
  return rel === '' || (!rel.startsWith('..') && !pathMod.isAbsolute(rel))
}

function normalizeWindowsInput(
  rawInput: string,
  primaryRoot: string,
  kind: 'workdir' | 'file',
): PathResolutionResult {
  const trimmed = rawInput.trim()

  // Map MSYS / Git Bash drive paths such as `/d/repo` or `/c` to `D:\repo` or `C:\`.
  const msysMatch = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(trimmed)
  if (msysMatch) {
    const drive = msysMatch[1].toUpperCase()
    const rest = (msysMatch[2] ?? '').replace(/\//g, '\\')
    return {
      ok: true,
      path: path.win32.resolve(`${drive}:\\${rest}`),
    }
  }

  // Reject drive-less POSIX absolute paths (e.g. `/tmp/out`, `/etc`, `/`) on Windows.
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return {
      ok: false,
      failure: {
        code: kind === 'workdir' ? 'INVALID_WORKDIR_POSIX_ON_WINDOWS' : 'INVALID_PATH_POSIX_ON_WINDOWS',
        message: `Path "${trimmed}" is a drive-less POSIX absolute path, which is not valid on Windows.`,
        effectState: 'none',
        retry: 'after-input-change',
        nextAction:
          'Provide a Windows drive path (for example, C:\\workspace\\subdir), an MSYS drive path (/c/workspace), or a path relative to the workspace root.',
      },
    }
  }

  // Reject Windows drive-relative paths like `C:foo` (missing leading slash after colon).
  const driveRelativeMatch = /^([a-zA-Z]):(?![\\/])(.*)$/.exec(trimmed)
  if (driveRelativeMatch) {
    const targetDrive = driveRelativeMatch[1].toUpperCase()
    const rootDriveMatch = /^([a-zA-Z]):/.exec(primaryRoot)
    const rootDrive = rootDriveMatch ? rootDriveMatch[1].toUpperCase() : null
    const detail =
      rootDrive && rootDrive !== targetDrive
        ? `Drive-relative path "${trimmed}" targets drive ${targetDrive}: while the active workspace is on drive ${rootDrive}:.`
        : `Drive-relative path "${trimmed}" is ambiguous without a root separator after "${targetDrive}:".`
    return {
      ok: false,
      failure: {
        code: 'CROSS_DRIVE_RELATIVE_PATH',
        message: detail,
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: `Use an explicit absolute path (for example, ${targetDrive}:\\${driveRelativeMatch[2]}) or a workspace-relative path.`,
      },
    }
  }

  const slashFixed = trimmed.replace(/\//g, '\\')
  const resolved = path.win32.isAbsolute(slashFixed)
    ? path.win32.resolve(slashFixed)
    : path.win32.resolve(primaryRoot, slashFixed)

  return { ok: true, path: resolved }
}

/**
 * Normalizes a user-supplied file or directory path for the native Rust worker,
 * applying Windows MSYS `/c/...` translation and rejecting drive-less POSIX or
 * cross-drive relative paths (`C:foo`) with structured `FailureInfo` diagnostics.
 */
export function normalizeWorkerPath(
  rawPath: string,
  primaryRoot: string,
  platform: NodeJS.Platform = process.platform,
): PathResolutionResult {
  const trimmed = rawPath.trim()
  if (!trimmed) {
    return {
      ok: false,
      failure: {
        code: 'INVALID_FILE_PATH',
        message: 'Path cannot be empty.',
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: 'Provide a valid path inside the authorized workspace.',
      },
    }
  }
  if (trimmed.includes('\0')) {
    return {
      ok: false,
      failure: {
        code: 'INVALID_FILE_PATH',
        message: 'Path contains an invalid null byte.',
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: 'Provide a valid path without control characters.',
      },
    }
  }
  if (platform === 'win32') {
    return normalizeWindowsInput(trimmed, primaryRoot, 'file')
  }
  return { ok: true, path: trimmed }
}

function enforceWorkspaceJail(
  resolvedPath: string,
  workspaceRoots: string[],
  platform: NodeJS.Platform,
  kind: 'workdir' | 'file',
): PathResolutionResult {
  const canonicalCandidate = realpathOrNearestAncestor(resolvedPath, platform)

  const canonicalRoots = workspaceRoots
    .filter((r) => typeof r === 'string' && r.trim().length > 0)
    .map((r) => realpathOrNearestAncestor(r, platform))

  if (canonicalRoots.length === 0) {
    return {
      ok: false,
      failure: {
        code: 'WORKSPACE_ROOT_UNRESOLVED',
        message:
          'No authorized workspace root could be resolved for this session; refusing to operate without a workspace boundary.',
        effectState: 'none',
        retry: 'after-input-change',
        nextAction:
          'Open a workspace folder in Antigravity, set ANTIGRAVITY_WORKSPACE_DIR, or pass workspace roots via MCP roots/list.',
      },
    }
  }

  const authorized = canonicalRoots.some((root) =>
    isWithinRoot(canonicalCandidate, root, platform),
  )

  if (!authorized) {
    const label = kind === 'workdir' ? 'Working directory' : 'File path'
    return {
      ok: false,
      failure: {
        code: kind === 'workdir' ? 'WORKDIR_OUTSIDE_WORKSPACE' : 'FILE_OUTSIDE_WORKSPACE',
        message: `${label} "${resolvedPath}" resolves outside the authorized workspace roots (${canonicalRoots.join(', ')}).`,
        effectState: 'none',
        retry: 'after-input-change',
        nextAction:
          'Choose a path inside an authorized workspace root or omit workdir to use the primary workspace root.',
      },
    }
  }

  return { ok: true, path: canonicalCandidate }
}

/**
 * Normalizes and workspace-jails a command working directory.
 * Anchors relative paths to the primary workspace root and handles Windows/MSYS path edge cases.
 */
export function normalizeWorkdir(
  input: string | undefined,
  workspaceRoots: string[],
  platform: NodeJS.Platform = process.platform,
): PathResolutionResult {
  const pathMod = getPathModule(platform)
  const cleanRoots = workspaceRoots.filter((r) => typeof r === 'string' && r.trim().length > 0)
  const primaryRoot = cleanRoots[0] ? pathMod.resolve(cleanRoots[0]) : pathMod.resolve(process.cwd())

  if (!input || input.trim().length === 0) {
    return enforceWorkspaceJail(primaryRoot, cleanRoots, platform, 'workdir')
  }

  if (input.includes('\0')) {
    return {
      ok: false,
      failure: {
        code: 'INVALID_WORKDIR',
        message: 'Working directory contains an invalid null byte.',
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: 'Provide a valid directory path without control characters.',
      },
    }
  }

  let resolved: string
  if (platform === 'win32') {
    const winRes = normalizeWindowsInput(input, primaryRoot, 'workdir')
    if (!winRes.ok) return winRes
    resolved = winRes.path
  } else {
    const trimmed = input.trim()
    resolved = path.posix.isAbsolute(trimmed)
      ? path.posix.resolve(trimmed)
      : path.posix.resolve(primaryRoot, trimmed)
  }

  return enforceWorkspaceJail(resolved, cleanRoots, platform, 'workdir')
}

/**
 * Normalizes and workspace-jails a file path (such as `scriptPath` for `pulse_exec`).
 */
export function resolveAuthorizedFile(
  filePath: string,
  workspaceRoots: string[],
  platform: NodeJS.Platform = process.platform,
): PathResolutionResult {
  if (!filePath || filePath.trim().length === 0) {
    return {
      ok: false,
      failure: {
        code: 'INVALID_FILE_PATH',
        message: 'File path cannot be empty.',
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: 'Provide a valid script or file path inside the workspace.',
      },
    }
  }

  if (filePath.includes('\0')) {
    return {
      ok: false,
      failure: {
        code: 'INVALID_FILE_PATH',
        message: 'File path contains an invalid null byte.',
        effectState: 'none',
        retry: 'after-input-change',
        nextAction: 'Provide a valid file path without control characters.',
      },
    }
  }

  const pathMod = getPathModule(platform)
  const cleanRoots = workspaceRoots.filter((r) => typeof r === 'string' && r.trim().length > 0)
  const primaryRoot = cleanRoots[0] ? pathMod.resolve(cleanRoots[0]) : pathMod.resolve(process.cwd())

  let resolved: string
  if (platform === 'win32') {
    const winRes = normalizeWindowsInput(filePath, primaryRoot, 'file')
    if (!winRes.ok) return winRes
    resolved = winRes.path
  } else {
    const trimmed = filePath.trim()
    resolved = path.posix.isAbsolute(trimmed)
      ? path.posix.resolve(trimmed)
      : path.posix.resolve(primaryRoot, trimmed)
  }

  return enforceWorkspaceJail(resolved, cleanRoots, platform, 'file')
}
