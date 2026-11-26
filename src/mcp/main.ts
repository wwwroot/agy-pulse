import { existsSync, statSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolveDataDir } from '../shared/paths.ts'
import { resolveWorkspaceRoots, uriToFsPath } from '../server/workspace.ts'
import { runCliMode } from './cli-runner.ts'
import { createDaemonClient } from './daemon-client.ts'
import { registerTools } from './tools.ts'

const SERVER_NAME = 'agy-pulse'
const SERVER_VERSION = '1.0.0'
const ROOTS_REQUEST_TIMEOUT_MS = 1_000

function logError(message: string, err?: unknown): void {
  const detail =
    err instanceof Error
      ? `\n${err.stack ?? err.message}`
      : err !== undefined
        ? `: ${String(err)}`
        : ''
  process.stderr.write(`[${SERVER_NAME}-mcp] ${message}${detail}\n`)
}

async function main(): Promise<void> {
  const cliFlagIdx = process.argv.indexOf('--cli')
  if (cliFlagIdx !== -1) {
    const exitCode = await runCliMode(process.argv.slice(cliFlagIdx + 1))
    process.exit(exitCode)
  }

  const dataDir = resolveDataDir()
  let cachedMcpRoots: string[] | null = null
  let mcpRootsAttempted = false

  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        'Native Rust workspace engine (7 tools, per-conversation isolated telemetry): pulse_read_files (batch 1–32 reads + interval dedup + outline/symbol), pulse_search (Rust glob, 5-mode progressive grep, compact git_status/git_diff), pulse_mutate (CAS edit/write/diff/replace/batch), pulse_read_doc (native CSV/TSV/DOCX/PDF), pulse_exec (structured shell), pulse_job (blocking wait: true with auto-cursor, never sleep-poll), pulse_result (spillover paging + per-session stats). Surface [Pulse](sidecar://agy-pulse/pulse/) for live telemetry.',
    },
  )

  /**
   * Deferred lazy `roots/list` fallback: never issued during `initialize` (avoiding
   * host deadlocks); only queried lazily on first tool call if local/hook/env resolution
   * returns no roots and the MCP client advertised `roots` capability.
   */
  const resolveRootsWithMcpFallback = async (sessionId?: string): Promise<string[]> => {
    const resolved = await resolveWorkspaceRoots(sessionId, undefined, undefined, dataDir)
    if (resolved.length > 0) {
      return resolved
    }
    if (cachedMcpRoots && cachedMcpRoots.length > 0) {
      return cachedMcpRoots
    }
    if (mcpRootsAttempted || !server.getClientCapabilities()?.roots) {
      return []
    }
    mcpRootsAttempted = true
    try {
      const response = await Promise.race([
        server.listRoots(),
        new Promise<null>((resolve) => {
          const t = setTimeout(() => resolve(null), ROOTS_REQUEST_TIMEOUT_MS)
          t.unref()
        }),
      ])
      if (response && Array.isArray(response.roots)) {
        const dirs = response.roots
          .map((r) => (typeof r?.uri === 'string' ? uriToFsPath(r.uri) : ''))
          .filter((p) => {
            if (!p) return false
            try {
              return existsSync(p) && statSync(p).isDirectory()
            } catch {
              return false
            }
          })
        if (dirs.length > 0) {
          cachedMcpRoots = [...new Set(dirs)]
          return cachedMcpRoots
        }
      }
    } catch {
      // Fail closed; caller will report WORKSPACE_ROOT_UNRESOLVED.
    }
    return []
  }

  const client = createDaemonClient({
    dataDir,
    getWorkspaceRoots: resolveRootsWithMcpFallback,
  })

  registerTools(server, client)

  const transport = new StdioServerTransport()
  let shuttingDown = false

  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      await client.dispose()
    } catch (err) {
      logError(`Error disposing resources during ${reason}`, err)
    }
    try {
      await server.close()
    } catch {
      // Transport may already be closed when stdin ends.
    }
    process.exit(exitCode)
  }

  server.onerror = (err) => {
    logError('MCP server error', err)
  }

  transport.onclose = () => {
    void shutdown('transport-close', 0)
  }

  process.stdin.on('end', () => {
    void shutdown('stdin-end', 0)
  })
  process.stdin.on('close', () => {
    void shutdown('stdin-close', 0)
  })

  process.once('SIGINT', () => {
    void shutdown('SIGINT', 0)
  })
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM', 0)
  })

  process.on('uncaughtException', (err) => {
    logError('Uncaught exception', err)
    void shutdown('uncaughtException', 1)
  })

  process.on('unhandledRejection', (reason) => {
    logError('Unhandled promise rejection', reason)
  })

  await server.connect(transport)
}

void main().catch((err) => {
  logError('Fatal startup failure', err)
  process.exit(1)
})
