import { EventEmitter } from 'node:events'
import type { ActivityItem, EffectState } from '../shared/types.ts'

export const DEFAULT_MAX_ACTIVITY_ITEMS = 200

export function isActivityAnomaly(
  status: ActivityItem['status'],
  effectState?: EffectState,
): boolean {
  if (status === 'failed' || status === 'rejected' || status === 'killed') {
    return true
  }
  if (effectState === 'unknown' || effectState === 'partial') {
    return true
  }
  return false
}

export interface ActivityEventPayload {
  item: ActivityItem
  unreadAnomalies: number
}

export class ActivityStore extends EventEmitter {
  private readonly maxItems: number
  private readonly defaultSessionId?: string
  private items: ActivityItem[] = []

  constructor(maxItems: number = DEFAULT_MAX_ACTIVITY_ITEMS, defaultSessionId?: string) {
    super()
    this.maxItems = Math.max(10, maxItems)
    this.defaultSessionId = defaultSessionId
  }

  /**
   * Restores persisted activity items on session load without emitting live events.
   */
  hydrate(items: ActivityItem[]): void {
    if (!Array.isArray(items)) return
    const next: ActivityItem[] = []
    for (const raw of items) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') continue
      const anomaly =
        typeof raw.anomaly === 'boolean'
          ? raw.anomaly
          : isActivityAnomaly(raw.status, raw.effectState)
      next.push({
        ...raw,
        sessionId: raw.sessionId ?? this.defaultSessionId,
        anomaly,
        acknowledged: anomaly ? Boolean(raw.acknowledged) : true,
      })
      if (next.length >= this.maxItems) break
    }
    this.items = next
  }

  record(input: ActivityItem): ActivityItem {
    const anomaly =
      typeof input.anomaly === 'boolean'
        ? input.anomaly
        : isActivityAnomaly(input.status, input.effectState)
    const item: ActivityItem = {
      ...input,
      sessionId: input.sessionId ?? this.defaultSessionId,
      anomaly,
      acknowledged: anomaly ? Boolean(input.acknowledged) : true,
    }

    const existingIdx = this.items.findIndex((x) => x.id === item.id)
    if (existingIdx >= 0) {
      this.items[existingIdx] = item
    } else {
      this.items.unshift(item)
      if (this.items.length > this.maxItems) {
        this.items.length = this.maxItems
      }
    }

    const unreadAnomalies = this.getUnreadAnomalies()
    this.emit('activity', { item: { ...item }, unreadAnomalies } satisfies ActivityEventPayload)
    return { ...item }
  }

  update(id: string, patch: Partial<ActivityItem>): ActivityItem | null {
    const idx = this.items.findIndex((x) => x.id === id)
    if (idx < 0) return null

    const prev = this.items[idx]
    const nextStatus = patch.status ?? prev.status
    const nextEffectState = patch.effectState ?? prev.effectState
    const nextAnomaly =
      typeof patch.anomaly === 'boolean'
        ? patch.anomaly
        : isActivityAnomaly(nextStatus, nextEffectState)

    // If an item newly becomes an anomaly, surface it as unread unless explicitly acknowledged.
    let nextAck = patch.acknowledged ?? prev.acknowledged
    if (nextAnomaly && !prev.anomaly && patch.acknowledged === undefined) {
      nextAck = false
    } else if (!nextAnomaly && patch.acknowledged === undefined) {
      nextAck = true
    }

    const updated: ActivityItem = {
      ...prev,
      ...patch,
      id: prev.id,
      sessionId: patch.sessionId ?? prev.sessionId ?? this.defaultSessionId,
      status: nextStatus,
      effectState: nextEffectState,
      anomaly: nextAnomaly,
      acknowledged: nextAck,
    }
    this.items[idx] = updated

    const unreadAnomalies = this.getUnreadAnomalies()
    this.emit('activity', { item: { ...updated }, unreadAnomalies } satisfies ActivityEventPayload)
    return { ...updated }
  }

  list(limit?: number): ActivityItem[] {
    const slice =
      typeof limit === 'number' && limit > 0 ? this.items.slice(0, limit) : this.items
    return slice.map((item) => ({ ...item }))
  }

  getUnreadAnomalies(): number {
    let count = 0
    for (const item of this.items) {
      if (item.anomaly && !item.acknowledged) {
        count++
      }
    }
    return count
  }

  acknowledgeAll(): { unreadAnomalies: number } {
    let changed = false
    for (const item of this.items) {
      if (item.anomaly && !item.acknowledged) {
        item.acknowledged = true
        changed = true
      }
    }
    if (changed) {
      this.emit('ack', { unreadAnomalies: 0 })
    }
    return { unreadAnomalies: 0 }
  }

  clear(): void {
    if (this.items.length === 0) return
    this.items = []
    this.emit('ack', { unreadAnomalies: 0 })
  }
}
