import type {
  ActivityItem,
  SessionSummary,
  SidecarStateSnapshot,
  TokenSavingsSummary,
  WsClientMessage,
  WsServerMessage,
} from '../../shared/types.ts'
import { getConversationId, getSearchToken, type SessionScope } from './api.ts'

export type WsConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'suspended'
  | 'failed'
  | 'closed'

export interface ActivityBroadcastEvent {
  item: ActivityItem
  unreadAnomalies: number
}

export interface TelemetryBroadcastEvent {
  telemetry: TokenSavingsSummary
  dedupEntryCount: number
  sessionId?: string
  sessions?: SessionSummary[]
}

export interface OpsWsClientOptions {
  conversationId?: string
  scope?: SessionScope
}

const WS_PING_INTERVAL_MS = 25_000
const WS_RECONNECT_MAX_MS = 10_000
const WS_INITIAL_FAILURES_BEFORE_FALLBACK = 2

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

export class OpsWsClient {
  private ws: WebSocket | null = null
  private disposed = false
  private status: WsConnectionStatus = 'connecting'
  private hasConnectedOnce = false
  private initialFailureCount = 0
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private conversationId: string
  private scope: SessionScope

  private readonly statusListeners = new Set<(status: WsConnectionStatus) => void>()
  private readonly stateListeners = new Set<(state: Partial<SidecarStateSnapshot>) => void>()
  private readonly activityListeners = new Set<(ev: ActivityBroadcastEvent) => void>()
  private readonly telemetryListeners = new Set<(ev: TelemetryBroadcastEvent) => void>()

  private readonly onVisibilityChange = (): void => {
    if (this.disposed) return
    if (isDocumentHidden()) {
      this.suspend()
      return
    }
    this.resume()
  }

  constructor(opts: OpsWsClientOptions = {}) {
    this.conversationId = opts.conversationId ?? getConversationId()
    this.scope = opts.scope ?? 'conversation'
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange)
    }
    if (isDocumentHidden()) {
      this.status = 'suspended'
    } else {
      this.connect()
    }
  }

  public getStatus(): WsConnectionStatus {
    return this.status
  }

  public suspend(): void {
    if (this.disposed) return
    this.clearTimers()
    this.detachAndCloseSocket('suspend')
    this.setStatus('suspended')
  }

  public resume(): void {
    if (this.disposed || isDocumentHidden()) return
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)
    ) {
      return
    }
    this.reconnectAttempt = 0
    if (this.status === 'failed') {
      this.initialFailureCount = 0
    }
    this.setStatus(this.hasConnectedOnce ? 'reconnecting' : 'connecting')
    this.connect()
  }

  private setStatus(next: WsConnectionStatus): void {
    if (this.status === next) return
    this.status = next
    for (const listener of this.statusListeners) {
      try {
        listener(next)
      } catch {
      }
    }
  }

  private buildWsUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const token = getSearchToken()
    const qs = new URLSearchParams()
    if (token) qs.set('token', token)
    if (this.conversationId) qs.set('conversationId', this.conversationId)
    if (this.scope) qs.set('scope', this.scope)
    const query = qs.toString()
    return `${protocol}//${window.location.host}/ws${query ? `?${query}` : ''}`
  }

  private detachAndCloseSocket(reason: string): void {
    const current = this.ws
    this.ws = null
    if (!current) return
    try {
      if (current.readyState === WebSocket.CONNECTING || current.readyState === WebSocket.OPEN) {
        current.close(1000, reason)
      }
    } catch {
    }
  }

  private connect(): void {
    if (this.disposed || isDocumentHidden()) return
    if (typeof WebSocket === 'undefined') {
      this.setStatus('failed')
      return
    }
    this.clearTimers()
    this.detachAndCloseSocket('reconnect')

    const url = this.buildWsUrl()
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      this.handleFailure()
      return
    }
    this.ws = socket

    socket.addEventListener('open', () => {
      if (this.disposed || this.ws !== socket || isDocumentHidden()) {
        try {
          socket.close(1000, 'stale')
        } catch {
        }
        return
      }
      this.hasConnectedOnce = true
      this.initialFailureCount = 0
      this.reconnectAttempt = 0
      this.setStatus('connected')

      this.pingTimer = setInterval(() => {
        if (this.ws === socket && socket.readyState === WebSocket.OPEN) {
          this.send({ type: 'ping', ts: Date.now() })
        }
      }, WS_PING_INTERVAL_MS)
    })

    socket.addEventListener('message', (event) => {
      if (this.disposed || this.ws !== socket) return
      if (typeof event.data !== 'string') return
      let msg: WsServerMessage
      try {
        msg = JSON.parse(event.data) as WsServerMessage
      } catch {
        return
      }
      this.dispatchMessage(msg)
    })

    socket.addEventListener('close', () => {
      if (this.ws !== socket) return
      this.ws = null
      this.clearPingTimer()
      if (this.disposed) return
      if (isDocumentHidden()) {
        this.setStatus('suspended')
        return
      }
      this.handleFailure()
    })

    socket.addEventListener('error', () => {
      // Close event handles reconnection/fallback
    })
  }

  private handleFailure(): void {
    if (this.disposed || isDocumentHidden()) return
    if (!this.hasConnectedOnce) {
      this.initialFailureCount += 1
      if (this.initialFailureCount >= WS_INITIAL_FAILURES_BEFORE_FALLBACK) {
        this.setStatus('failed')
        return
      }
    }
    this.setStatus('reconnecting')
    this.scheduleReconnect()
  }

  private dispatchMessage(msg: WsServerMessage): void {
    switch (msg.type) {
      case 'state-update': {
        for (const fn of this.stateListeners) fn(msg.state)
        break
      }
      case 'activity-event': {
        const ev: ActivityBroadcastEvent = {
          item: msg.item,
          unreadAnomalies: msg.unreadAnomalies,
        }
        for (const fn of this.activityListeners) fn(ev)
        break
      }
      case 'telemetry-update': {
        const ev: TelemetryBroadcastEvent = {
          telemetry: msg.telemetry,
          dedupEntryCount: msg.dedupEntryCount,
          sessionId: msg.sessionId,
          sessions: msg.sessions,
        }
        for (const fn of this.telemetryListeners) fn(ev)
        break
      }
      case 'pong':
        break
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer || isDocumentHidden()) return
    const delayMs = Math.min(WS_RECONNECT_MAX_MS, 500 * Math.pow(1.7, this.reconnectAttempt))
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delayMs)
  }

  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private clearTimers(): void {
    this.clearPingTimer()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  public send(msg: WsClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return false
    }
    try {
      this.ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }

  public onStatusChange(fn: (status: WsConnectionStatus) => void): () => void {
    this.statusListeners.add(fn)
    return () => this.statusListeners.delete(fn)
  }

  public onStateUpdate(fn: (state: Partial<SidecarStateSnapshot>) => void): () => void {
    this.stateListeners.add(fn)
    return () => this.stateListeners.delete(fn)
  }

  public onActivityEvent(fn: (ev: ActivityBroadcastEvent) => void): () => void {
    this.activityListeners.add(fn)
    return () => this.activityListeners.delete(fn)
  }

  public onTelemetryUpdate(fn: (ev: TelemetryBroadcastEvent) => void): () => void {
    this.telemetryListeners.add(fn)
    return () => this.telemetryListeners.delete(fn)
  }

  public dispose(): void {
    this.disposed = true
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange)
    }
    this.clearTimers()
    this.setStatus('closed')
    this.detachAndCloseSocket('dispose')
    this.statusListeners.clear()
    this.stateListeners.clear()
    this.activityListeners.clear()
    this.telemetryListeners.clear()
  }
}
