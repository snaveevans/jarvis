export type EventType = 'tool_call' | 'llm_call' | 'error' | 'session'

export interface BaseEvent {
  readonly type: EventType
  readonly timestampMs: number
  readonly sessionId?: string
}

export interface ToolCallEvent extends BaseEvent {
  readonly type: 'tool_call'
  readonly toolName: string
  readonly argsSummary: string
  readonly success: boolean
  readonly errorMessage?: string
  readonly durationMs: number
  readonly iteration: number
}

export interface LLMCallEvent extends BaseEvent {
  readonly type: 'llm_call'
  readonly model: string
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
  readonly durationMs: number
  readonly iteration: number
}

export interface ErrorEvent extends BaseEvent {
  readonly type: 'error'
  readonly category: 'tool' | 'llm' | 'dispatch' | 'system'
  readonly message: string
  readonly code?: string
  readonly statusCode?: number
}

export interface SessionEvent extends BaseEvent {
  readonly type: 'session'
  readonly action: 'created' | 'cleared' | 'evicted'
  readonly evictedCount?: number
}

export type TelemetryEvent = ToolCallEvent | LLMCallEvent | ErrorEvent | SessionEvent

// Omit doesn't distribute over unions, so we do it manually
export type TelemetryEventInput =
  | Omit<ToolCallEvent, 'timestampMs'>
  | Omit<LLMCallEvent, 'timestampMs'>
  | Omit<ErrorEvent, 'timestampMs'>
  | Omit<SessionEvent, 'timestampMs'>

export interface EventStoreQuery {
  type?: EventType
  sessionId?: string
  since?: number
  limit?: number
}

export interface EventStore {
  record(event: TelemetryEventInput): void
  query(filter?: EventStoreQuery): TelemetryEvent[]
  recent(n?: number): TelemetryEvent[]
  stats(): EventStoreStats
}

export interface EventStoreStats {
  totalRecorded: number
  bufferedCount: number
  maxBufferSize: number
}

export function createEventStore(maxEvents = 500): EventStore {
  const buffer: TelemetryEvent[] = []
  let totalRecorded = 0

  return {
    record(event: TelemetryEventInput): void {
      const full = { ...event, timestampMs: Date.now() } as TelemetryEvent
      totalRecorded++
      if (buffer.length >= maxEvents) {
        buffer.shift()
      }
      buffer.push(full)
    },

    query(filter: EventStoreQuery = {}): TelemetryEvent[] {
      let results = buffer as TelemetryEvent[]

      if (filter.type) {
        results = results.filter(e => e.type === filter.type)
      }
      if (filter.sessionId) {
        results = results.filter(e => e.sessionId === filter.sessionId)
      }
      if (filter.since !== undefined) {
        results = results.filter(e => e.timestampMs >= filter.since!)
      }
      if (filter.limit !== undefined) {
        results = results.slice(-filter.limit)
      }

      return results
    },

    recent(n = 20): TelemetryEvent[] {
      return buffer.slice(-n)
    },

    stats(): EventStoreStats {
      return {
        totalRecorded,
        bufferedCount: buffer.length,
        maxBufferSize: maxEvents,
      }
    },
  }
}
