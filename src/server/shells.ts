import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ConcreteShellId, ShellId, ShellInfo } from '../shared/types.ts'

const execFileAsync = promisify(execFile)
const PROBE_TIMEOUT_MS = 3000

export type ShellExecutionMode = 'exec' | 'script' | 'interactive'

export interface ResolvedShellCommand {
  executable: string
  args: string[]
  shell: ShellInfo
  windowsVerbatimArguments?: boolean
}

function isExecutableFile(filePath: string): boolean {
  if (!filePath) return false
  try {
    if (process.platform === 'win32') {
      // Microsoft Store App Execution Aliases (e.g. %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe)
      // are NTFS IO_REPARSE_TAG_APPEXECLINK reparse points where existsSync()/statSync() can
      // return false/ENOENT even though accessSync(F_OK) and execFile() succeed.
      accessSync(filePath, constants.F_OK)
      try {
        if (statSync(filePath).isDirectory()) return false
      } catch {
        // Reparse point (e.g. AppExecutionAlias), still executable via execFile.
      }
      return true
    }
    if (!existsSync(filePath)) return false
    if (statSync(filePath).isDirectory()) return false
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findInPath(binaryNames: string[], reject?: (candidate: string) => boolean): string | null {
  const pathEnv = process.env.PATH || process.env.Path || ''
  const dirs = pathEnv.split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const name of binaryNames) {
      const candidate = path.join(dir, name)
      if (reject && reject(candidate)) continue
      if (isExecutableFile(candidate)) {
        return candidate
      }
    }
  }
  return null
}

function isWslBashStub(candidate: string): boolean {
  const lower = candidate.replace(/\\/g, '/').toLowerCase()
  return (
    lower.endsWith('/windows/system32/bash.exe') ||
    lower.endsWith('/windows/sysnative/bash.exe') ||
    lower.endsWith('/windows/syswow64/bash.exe') ||
    lower.includes('/microsoft/windowsapps/bash.exe')
  )
}

async function probeVersion(
  executable: string,
  args: string[],
  parseLine?: (stdout: string) => string | undefined,
): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    })
    const combined = `${stdout || ''}\n${stderr || ''}`.replace(/\0/g, '').trim()
    if (!combined) return undefined
    if (parseLine) return parseLine(combined)
    const firstLine = combined.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim()
    return firstLine ? firstLine.slice(0, 120) : undefined
  } catch {
    return undefined
  }
}

function firstMatch(text: string, re: RegExp): string | undefined {
  const m = re.exec(text)
  return m?.[1]?.trim() || m?.[0]?.trim()
}

async function detectWindowsShells(): Promise<ShellInfo[]> {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA || ''
  const userProfile = process.env.USERPROFILE || ''
  const programData = process.env.ProgramData || 'C:\\ProgramData'

  // 1. PowerShell 7 (pwsh.exe): PATH, MSI/winget, Microsoft Store alias, Scoop, .NET tool, Chocolatey
  const pwshCandidates = [
    findInPath(['pwsh.exe', 'pwsh']),
    path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    path.join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'),
    path.join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'),
    localAppData ? path.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe') : '',
    localAppData ? path.join(localAppData, 'Programs', 'PowerShell', '7', 'pwsh.exe') : '',
    userProfile ? path.join(userProfile, 'scoop', 'shims', 'pwsh.exe') : '',
    userProfile ? path.join(userProfile, '.dotnet', 'tools', 'pwsh.exe') : '',
    path.join(programData, 'chocolatey', 'bin', 'pwsh.exe'),
  ].filter((c): c is string => Boolean(c))
  const pwshExe = pwshCandidates.find(isExecutableFile) || ''

  // 2. Windows PowerShell (powershell.exe)
  const winPsCandidates = [
    path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    findInPath(['powershell.exe']),
  ].filter((c): c is string => Boolean(c))
  const winPsExe = winPsCandidates.find(isExecutableFile) || ''

  // 3. Git Bash (explicitly rejecting WSL System32\bash.exe stub)
  const gitBashCandidates = [
    path.join(programFiles, 'Git', 'bin', 'bash.exe'),
    path.join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    localAppData ? path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe') : '',
    localAppData ? path.join(localAppData, 'Programs', 'Git', 'usr', 'bin', 'bash.exe') : '',
    path.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    path.join(programFilesX86, 'Git', 'usr', 'bin', 'bash.exe'),
    findInPath(['bash.exe'], isWslBashStub),
  ].filter((c): c is string => Boolean(c))
  const gitBashExe = gitBashCandidates.find((c) => !isWslBashStub(c) && isExecutableFile(c)) || ''

  // 4. WSL (wsl.exe)
  const wslCandidates = [
    path.join(sysRoot, 'System32', 'wsl.exe'),
    findInPath(['wsl.exe']),
  ].filter((c): c is string => Boolean(c))
  const wslExe = wslCandidates.find(isExecutableFile) || ''

  // 5. Command Prompt (cmd.exe)
  const cmdCandidates = [
    process.env.ComSpec || '',
    path.join(sysRoot, 'System32', 'cmd.exe'),
    findInPath(['cmd.exe']),
  ].filter((c): c is string => Boolean(c))
  const cmdExe = cmdCandidates.find(isExecutableFile) || 'cmd.exe'

  const [pwshVersion, winPsVersion, gitBashVersion, wslProbe, cmdVersion] = await Promise.all([
    pwshExe
      ? probeVersion(pwshExe, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'])
      : Promise.resolve(undefined),
    winPsExe
      ? probeVersion(winPsExe, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'])
      : Promise.resolve(undefined),
    gitBashExe
      ? probeVersion(gitBashExe, ['--version'], (out) =>
          firstMatch(out, /version\s+([0-9][^\s(]*)/i) ?? out.split(/\r?\n/)[0]?.trim(),
        )
      : Promise.resolve(undefined),
    wslExe
      ? (async () => {
          try {
            const { stdout } = await execFileAsync(wslExe, ['--list', '--quiet'], {
              encoding: 'utf-8',
              timeout: PROBE_TIMEOUT_MS,
              maxBuffer: 128 * 1024,
              windowsHide: true,
            })
            const distros = stdout
              .replace(/\0/g, '')
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean)
            return { hasDistro: distros.length > 0, version: distros[0] || undefined }
          } catch {
            return { hasDistro: false, version: undefined }
          }
        })()
      : Promise.resolve({ hasDistro: false, version: undefined }),
    cmdExe
      ? probeVersion(cmdExe, ['/c', 'ver'], (out) =>
          firstMatch(out, /Version\s+([0-9.]+)/i) ?? out.split(/\r?\n/)[0]?.trim(),
        )
      : Promise.resolve(undefined),
  ])

  const shells: ShellInfo[] = [
    {
      id: 'pwsh',
      label: 'PowerShell 7',
      executable: pwshExe,
      version: pwshVersion,
      available: Boolean(pwshExe),
      notes: pwshExe ? undefined : 'Install PowerShell 7 (pwsh) for modern cross-platform PowerShell support.',
    },
    {
      id: 'powershell',
      label: 'Windows PowerShell',
      executable: winPsExe,
      version: winPsVersion,
      available: Boolean(winPsExe),
    },
    {
      id: 'git-bash',
      label: 'Git Bash',
      executable: gitBashExe,
      version: gitBashVersion,
      available: Boolean(gitBashExe),
      notes: gitBashExe ? undefined : 'Git for Windows Bash not found (WSL System32\\bash.exe stub is excluded).',
    },
    {
      id: 'wsl',
      label: 'WSL',
      executable: wslExe,
      version: wslProbe.version,
      available: Boolean(wslExe) && wslProbe.hasDistro,
      notes:
        wslExe && !wslProbe.hasDistro
          ? 'wsl.exe is installed, but no Linux distribution is registered.'
          : undefined,
    },
    {
      id: 'cmd',
      label: 'Command Prompt',
      executable: cmdExe,
      version: cmdVersion,
      available: isExecutableFile(cmdExe),
    },
  ]

  // Mark preferred default shell for Windows: pwsh -> powershell -> git-bash -> cmd.
  const preferredOrder: ConcreteShellId[] = ['pwsh', 'powershell', 'git-bash', 'cmd']
  for (const id of preferredOrder) {
    const found = shells.find((s) => s.id === id && s.available)
    if (found) {
      found.isDefault = true
      break
    }
  }

  return shells
}

async function detectPosixShells(): Promise<ShellInfo[]> {
  const bashExe =
    ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'].find(
      isExecutableFile,
    ) ||
    findInPath(['bash']) ||
    ''

  const zshExe =
    ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh'].find(
      isExecutableFile,
    ) ||
    findInPath(['zsh']) ||
    ''

  const shExe =
    ['/bin/sh', '/usr/bin/sh'].find(isExecutableFile) ||
    findInPath(['sh']) ||
    ''

  const pwshExe =
    ['/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh', '/usr/bin/pwsh'].find(isExecutableFile) ||
    findInPath(['pwsh']) ||
    ''

  const [bashVer, zshVer, pwshVer] = await Promise.all([
    bashExe
      ? probeVersion(bashExe, ['--version'], (out) =>
          firstMatch(out, /version\s+([0-9][^\s(]*)/i) ?? out.split(/\r?\n/)[0]?.trim(),
        )
      : Promise.resolve(undefined),
    zshExe
      ? probeVersion(zshExe, ['--version'], (out) =>
          firstMatch(out, /zsh\s+([0-9][^\s]*)/i) ?? out.split(/\r?\n/)[0]?.trim(),
        )
      : Promise.resolve(undefined),
    pwshExe
      ? probeVersion(pwshExe, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'])
      : Promise.resolve(undefined),
  ])

  const shells: ShellInfo[] = [
    {
      id: 'bash',
      label: 'Bash',
      executable: bashExe,
      version: bashVer,
      available: Boolean(bashExe),
    },
    {
      id: 'zsh',
      label: 'Zsh',
      executable: zshExe,
      version: zshVer,
      available: Boolean(zshExe),
    },
    {
      id: 'sh',
      label: 'POSIX sh',
      executable: shExe,
      available: Boolean(shExe),
    },
    {
      id: 'pwsh',
      label: 'PowerShell',
      executable: pwshExe,
      version: pwshVer,
      available: Boolean(pwshExe),
    },
  ]

  const envShellBase = path.basename(process.env.SHELL || '').toLowerCase()
  const envPreferred: ConcreteShellId[] =
    envShellBase === 'zsh'
      ? ['zsh', 'bash', 'sh']
      : envShellBase === 'bash'
        ? ['bash', 'zsh', 'sh']
        : process.platform === 'darwin'
          ? ['zsh', 'bash', 'sh']
          : ['bash', 'zsh', 'sh']

  for (const id of envPreferred) {
    const found = shells.find((s) => s.id === id && s.available)
    if (found) {
      found.isDefault = true
      break
    }
  }

  return shells
}

function windowsPathToWslPath(winPath: string): string {
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(winPath)
  if (!m) return winPath.replace(/\\/g, '/')
  const drive = m[1].toLowerCase()
  const rest = m[2].replace(/\\/g, '/')
  return `/mnt/${drive}/${rest}`
}

/**
 * Builds the exact `[executable, args]` invocation for a concrete shell and mode.
 */
export function resolveShellCommand(
  shell: ShellInfo,
  mode: ShellExecutionMode,
  payload = '',
): ResolvedShellCommand {
  const exe = shell.executable

  switch (shell.id) {
    case 'pwsh':
    case 'powershell': {
      if (mode === 'interactive') {
        return { executable: exe, args: ['-NoLogo'], shell }
      }
      if (mode === 'script') {
        return {
          executable: exe,
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', payload],
          shell,
        }
      }
      return {
        executable: exe,
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', payload],
        shell,
      }
    }

    case 'git-bash':
    case 'bash': {
      if (mode === 'interactive') {
        return { executable: exe, args: ['--login'], shell }
      }
      if (mode === 'script') {
        const scriptArg = shell.id === 'git-bash' ? payload.replace(/\\/g, '/') : payload
        return { executable: exe, args: ['--noprofile', '--norc', scriptArg], shell }
      }
      return { executable: exe, args: ['--noprofile', '--norc', '-c', payload], shell }
    }

    case 'zsh': {
      if (mode === 'interactive') {
        return { executable: exe, args: ['-l'], shell }
      }
      if (mode === 'script') {
        return { executable: exe, args: ['--no-rcs', payload], shell }
      }
      return { executable: exe, args: ['--no-rcs', '-c', payload], shell }
    }

    case 'sh': {
      if (mode === 'interactive') {
        return { executable: exe, args: [], shell }
      }
      if (mode === 'script') {
        return { executable: exe, args: [payload], shell }
      }
      return { executable: exe, args: ['-c', payload], shell }
    }

    case 'wsl': {
      if (mode === 'interactive') {
        return { executable: exe, args: [], shell }
      }
      if (mode === 'script') {
        const wslScript = windowsPathToWslPath(payload)
        return { executable: exe, args: ['--', 'bash', '--noprofile', '--norc', wslScript], shell }
      }
      return { executable: exe, args: ['--', 'bash', '--noprofile', '--norc', '-c', payload], shell }
    }

    case 'cmd': {
      if (mode === 'interactive') {
        return { executable: exe, args: ['/k'], shell }
      }
      if (mode === 'script') {
        return { executable: exe, args: ['/d', '/c', payload], shell }
      }
      return {
        executable: exe,
        args: ['/d', '/s', '/c', `"${payload}"`],
        shell,
        windowsVerbatimArguments: true,
      }
    }
  }
}

export async function discoverShells(): Promise<ShellInfo[]> {
  return process.platform === 'win32' ? detectWindowsShells() : detectPosixShells()
}

export class ShellDiscovery {
  private cached: ShellInfo[] | null = null
  private inFlight: Promise<ShellInfo[]> | null = null

  async detect(forceRefresh = false): Promise<ShellInfo[]> {
    if (!forceRefresh && this.cached) {
      return this.cached.map((s) => ({ ...s }))
    }
    if (!forceRefresh && this.inFlight) {
      const res = await this.inFlight
      return res.map((s) => ({ ...s }))
    }

    const task = discoverShells()
      .then((shells) => {
        this.cached = shells
        return shells
      })
      .finally(() => {
        if (this.inFlight === task) {
          this.inFlight = null
        }
      })

    this.inFlight = task
    const res = await task
    return res.map((s) => ({ ...s }))
  }

  getCached(): ShellInfo[] {
    return this.cached ? this.cached.map((s) => ({ ...s })) : []
  }

  async resolveShell(requested?: ShellId, configDefault: ShellId = 'auto'): Promise<ShellInfo | null> {
    const shells = await this.detect()
    const available = shells.filter((s) => s.available)
    if (available.length === 0) return null

    const effective: ShellId = requested && requested !== 'auto' ? requested : configDefault

    if (effective !== 'auto') {
      const exact = available.find((s) => s.id === effective)
      if (exact) return exact
      // On Windows, if user asks for generic 'bash', route to 'git-bash' when available.
      if (effective === 'bash' && process.platform === 'win32') {
        const gitBash = available.find((s) => s.id === 'git-bash')
        if (gitBash) return gitBash
      }
      // Return null when an explicitly requested shell is unavailable so the caller reports an error.
      if (requested && requested !== 'auto') {
        return null
      }
    }

    return available.find((s) => s.isDefault) || available[0]
  }

  resolveCommand(
    shell: ShellInfo,
    mode: ShellExecutionMode,
    payload = '',
  ): ResolvedShellCommand {
    return resolveShellCommand(shell, mode, payload)
  }
}
