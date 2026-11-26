import type { IncomingMessage, ServerResponse } from 'node:http'

export class ServerError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: Record<string, unknown>

  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ServerError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export function writeJson(res: ServerResponse, data: unknown, status = 200): void {
  const payload = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

export function writeOk(res: ServerResponse, data: Record<string, unknown> = {}, status = 200): void {
  writeJson(res, { ok: true, ...data }, status)
}

export function writeError(res: ServerResponse, error: unknown): void {
  if (res.writableEnded || res.headersSent) return
  if (error instanceof ServerError) {
    writeJson(
      res,
      {
        ok: false,
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
      error.status,
    )
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, { ok: false, code: 'INTERNAL_ERROR', message }, 500)
}

export async function readBodyBuffer(
  req: IncomingMessage,
  limitBytes = 10 * 1024 * 1024,
): Promise<Buffer> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > limitBytes) {
      throw new ServerError(
        'PAYLOAD_TOO_LARGE',
        `Request body exceeded the ${limitBytes}-byte limit.`,
        413,
      )
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

export async function readJsonBody<T = Record<string, unknown>>(
  req: IncomingMessage,
  options: { allowEmpty?: boolean; limitBytes?: number } = {},
): Promise<T> {
  const buf = await readBodyBuffer(req, options.limitBytes ?? 10 * 1024 * 1024)
  const text = buf.toString('utf-8')
  if (!text.trim()) {
    if (options.allowEmpty) {
      return {} as T
    }
    throw new ServerError('BAD_REQUEST', 'Request body cannot be empty.', 400)
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ServerError('BAD_REQUEST', 'Request body must be a JSON object.', 400)
    }
    return parsed as T
  } catch (err) {
    if (err instanceof ServerError) throw err
    throw new ServerError('BAD_REQUEST', 'Request body is not valid JSON.', 400)
  }
}
