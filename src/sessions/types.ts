import type { ChatMessage } from '../llm/types.ts'

export interface Session {
  readonly id: string
  readonly endpointKind: string
  readonly createdAt: Date
  messages: ChatMessage[]
}
