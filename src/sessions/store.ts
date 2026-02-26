import type { ChatMessage } from '../llm/types.ts'
import type { Session } from './types.ts'

export interface SessionStore {
  get(id: string): Session | undefined
  getOrCreate(id: string, endpointKind: string): Session
  clear(id: string): void
  addMessage(id: string, message: ChatMessage): void
}

export function createInMemorySessionStore(): SessionStore {
  const sessions = new Map<string, Session>()

  return {
    get(id: string): Session | undefined {
      return sessions.get(id)
    },

    getOrCreate(id: string, endpointKind: string): Session {
      const existing = sessions.get(id)
      if (existing) {
        return existing
      }

      const session: Session = {
        id,
        endpointKind,
        createdAt: new Date(),
        messages: [],
      }
      sessions.set(id, session)
      return session
    },

    clear(id: string): void {
      sessions.delete(id)
    },

    addMessage(id: string, message: ChatMessage): void {
      const session = sessions.get(id)
      if (session) {
        session.messages.push(message)
      }
    },
  }
}
