import { estimateTokenCount } from '../memory/helpers.ts'

import type { ChatMessage } from '../llm/types.ts'
import type { Session } from './types.ts'

const DEFAULT_MAX_SESSION_TOKENS = 12_000
const MIN_RECENT_MESSAGES = 4

export interface SessionStoreConfig {
  maxSessionTokens?: number
  onEvict?: (sessionId: string, evicted: ChatMessage[]) => void
}

export interface SessionStore {
  get(id: string): Session | undefined
  getOrCreate(id: string, endpointKind: string): Session
  clear(id: string): void
  addMessage(id: string, message: ChatMessage): void
}

function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const msg of messages) {
    total += estimateTokenCount(msg.content)
  }
  return total
}

export function createInMemorySessionStore(config: SessionStoreConfig = {}): SessionStore {
  const sessions = new Map<string, Session>()
  const maxTokens = config.maxSessionTokens ?? DEFAULT_MAX_SESSION_TOKENS
  const onEvict = config.onEvict

  function evictIfNeeded(session: Session): void {
    const totalTokens = estimateMessagesTokens(session.messages)
    if (totalTokens <= maxTokens) {
      return
    }

    // Preserve: system prompt (index 0) + last MIN_RECENT_MESSAGES
    // Evict from index 1 up to (length - MIN_RECENT_MESSAGES)
    const hasSystemPrompt = session.messages.length > 0 && session.messages[0].role === 'system'
    const protectedStart = hasSystemPrompt ? 1 : 0
    const protectedEnd = Math.max(protectedStart, session.messages.length - MIN_RECENT_MESSAGES)

    if (protectedEnd <= protectedStart) {
      return // nothing to evict
    }

    // Evict oldest messages until under budget
    let currentTokens = totalTokens
    let evictUpTo = protectedStart

    while (evictUpTo < protectedEnd && currentTokens > maxTokens) {
      currentTokens -= estimateTokenCount(session.messages[evictUpTo].content)
      evictUpTo++
    }

    if (evictUpTo <= protectedStart) {
      return
    }

    const evicted = session.messages.splice(protectedStart, evictUpTo - protectedStart)

    // Inject a continuity marker after the system prompt
    const summaryMsg: ChatMessage = {
      role: 'system',
      content: `[Prior context: ${evicted.length} earlier messages were summarized and stored to memory. Continue the conversation naturally.]`,
    }
    session.messages.splice(protectedStart, 0, summaryMsg)

    if (onEvict && evicted.length > 0) {
      onEvict(session.id, evicted)
    }
  }

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
        evictIfNeeded(session)
      }
    },
  }
}
