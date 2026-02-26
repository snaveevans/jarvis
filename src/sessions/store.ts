import { estimateTokenCount } from '../memory/helpers.ts'
import { stripThinkingContent } from '../llm/provider.ts'

import type { ChatMessage } from '../llm/types.ts'
import type { SessionHistoryStore } from './history-store.ts'
import type { Session } from './types.ts'

const DEFAULT_MAX_SESSION_TOKENS = 12_000
const MIN_RECENT_MESSAGES = 4

export interface SessionStoreConfig {
  maxSessionTokens?: number
  onEvict?: (sessionId: string, evicted: ChatMessage[], info?: { startSeq: number, endSeq: number }) => void
  historyStore?: SessionHistoryStore
  historyReplayMaxMessages?: number
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
  const historyStore = config.historyStore
  const historyReplayMaxMessages = config.historyReplayMaxMessages ?? 200
  const nextSequenceBySession = new Map<string, number>()
  const sequenceByMessage = new WeakMap<ChatMessage, number>()

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
    const evictedSequences = evicted
      .map(msg => sequenceByMessage.get(msg))
      .filter((value): value is number => typeof value === 'number')
    const startSeq = evictedSequences.length > 0 ? Math.min(...evictedSequences) : 0
    const endSeq = evictedSequences.length > 0 ? Math.max(...evictedSequences) : 0

    // Inject a continuity marker after the system prompt
    const summaryMsg: ChatMessage = {
      role: 'system',
      content: `[Prior context: ${evicted.length} earlier messages were summarized and stored to memory. Continue the conversation naturally.]`,
    }
    const summarySeq = nextSequenceBySession.get(session.id) ?? 1
    sequenceByMessage.set(summaryMsg, summarySeq)
    nextSequenceBySession.set(session.id, summarySeq + 1)
    session.messages.splice(protectedStart, 0, summaryMsg)

    if (onEvict && evicted.length > 0) {
      onEvict(session.id, evicted, { startSeq, endSeq })
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

      const restoredMessages: ChatMessage[] = []
      let nextSeq = 1
      if (historyStore) {
        const historyRows = historyStore.loadRecentMessages(id, historyReplayMaxMessages)
        for (const row of historyRows) {
          const content = row.role === 'assistant'
            ? stripThinkingContent(row.content) || row.content
            : row.content
          const restored: ChatMessage = {
            role: row.role,
            content,
          }
          restoredMessages.push(restored)
          sequenceByMessage.set(restored, row.seq)
          nextSeq = Math.max(nextSeq, row.seq + 1)
        }
      }

      const session: Session = {
        id,
        endpointKind,
        createdAt: new Date(),
        messages: restoredMessages,
      }
      sessions.set(id, session)
      nextSequenceBySession.set(id, nextSeq)
      return session
    },

    clear(id: string): void {
      sessions.delete(id)
      nextSequenceBySession.delete(id)
      historyStore?.clearSession(id)
    },

    addMessage(id: string, message: ChatMessage): void {
      const session = sessions.get(id)
      if (session) {
        const nextSeq = nextSequenceBySession.get(id) ?? 1
        sequenceByMessage.set(message, nextSeq)
        nextSequenceBySession.set(id, nextSeq + 1)
        session.messages.push(message)
        if (historyStore && (message.role === 'user' || message.role === 'assistant')) {
          historyStore.appendMessage(id, session.endpointKind, nextSeq, message.role, message.content)
        }
        evictIfNeeded(session)
      }
    },
  }
}
