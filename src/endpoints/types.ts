export interface EndpointProfile {
  readonly kind: string
  readonly displayName: string
  readonly maxMessageLength?: number
  readonly responseStyle: string
  readonly formatting: 'plain' | 'markdown' | 'html'
}

export interface InboundMessage {
  readonly text: string
  readonly sessionId: string
  readonly endpointKind: string
  readonly timestamp: Date
  readonly metadata?: Record<string, unknown>
}

export interface OutboundMessage {
  readonly text: string
  readonly sessionId: string
  readonly endpointKind: string
}

export interface Endpoint {
  readonly profile: EndpointProfile
  send(message: OutboundMessage): Promise<void>
  listen?(handler: (message: InboundMessage) => Promise<void>): Promise<() => void>
}
