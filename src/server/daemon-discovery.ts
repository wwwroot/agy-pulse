import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveDataDir } from '../shared/paths.ts'
import type { DaemonDiscovery } from '../shared/types.ts'

export function getDaemonDiscoveryPath(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, 'daemon.json')
}

export function readDaemonDiscovery(dataDir: string = resolveDataDir()): DaemonDiscovery | null {
  const filePath = getDaemonDiscoveryPath(dataDir)
  try {
    if (!existsSync(filePath)) return null
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<DaemonDiscovery>
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.port === 'number' &&
      parsed.port > 0 &&
      typeof parsed.token === 'string' &&
      typeof parsed.startedAt === 'number' &&
      typeof parsed.version === 'string'
    ) {
      return parsed as DaemonDiscovery
    }
    return null
  } catch {
    return null
  }
}

export function writeDaemonDiscovery(
  info: DaemonDiscovery,
  dataDir: string = resolveDataDir(),
): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const filePath = getDaemonDiscoveryPath(dataDir)
  const serialized = `${JSON.stringify(info, null, 2)}\n`
  const tempPath = `${filePath}.${process.pid}.tmp`
  writeFileSync(tempPath, serialized, { encoding: 'utf-8', mode: 0o600 })
  try {
    renameSync(tempPath, filePath)
  } catch {
    writeFileSync(filePath, serialized, { encoding: 'utf-8', mode: 0o600 })
  }
  return filePath
}

export function removeDaemonDiscovery(
  expectedPid: number = process.pid,
  dataDir: string = resolveDataDir(),
): void {
  const filePath = getDaemonDiscoveryPath(dataDir)
  try {
    if (!existsSync(filePath)) return
    const existing = readDaemonDiscovery(dataDir)
    // Only remove the file if it still belongs to this daemon process.
    if (existing && existing.pid !== expectedPid) return
    unlinkSync(filePath)
  } catch {
    // Best-effort cleanup during shutdown.
  }
}

export class DaemonDiscoveryManager {
  readonly dataDir: string
  readonly filePath: string
  private active = false
  private readonly onExitBound: () => void

  constructor(dataDir: string = resolveDataDir()) {
    this.dataDir = dataDir
    this.filePath = getDaemonDiscoveryPath(dataDir)
    this.onExitBound = () => {
      this.cleanup()
    }
  }

  publish(info: Omit<DaemonDiscovery, 'pid' | 'startedAt'> & { startedAt?: number }): DaemonDiscovery {
    const record: DaemonDiscovery = {
      pid: process.pid,
      port: info.port,
      token: info.token,
      startedAt: info.startedAt ?? Date.now(),
      version: info.version,
    }
    writeDaemonDiscovery(record, this.dataDir)
    if (!this.active) {
      this.active = true
      process.once('exit', this.onExitBound)
    }
    return record
  }

  cleanup(): void {
    if (!this.active) return
    this.active = false
    process.off('exit', this.onExitBound)
    removeDaemonDiscovery(process.pid, this.dataDir)
  }
}
