import { estimateTokenCount } from './helpers.ts'

import type { ChatWithToolsClient } from '../llm/chat-with-tools.ts'
import type { LLMClient } from '../llm/client.ts'
import type { ChatMessage } from '../llm/types.ts'
import type { MemoryService } from './service.ts'
import type { MemoryType } from './types.ts'

const MIN_EVICT_MESSAGES = 3
const MIN_EVICT_TOKENS = 200

interface EvictionFinding {
  type: MemoryType
  content: string
  tags: string[]
}

export interface EvictionRunMeta {
  batchId?: number
  startSeq?: number
  endSeq?: number
}

type EvaluatorLogger = {
  info?: (meta: unknown, message?: string) => void
  warn?: (meta: unknown, message?: string) => void
}

export interface EvictionEvaluatorConfig {
  client: ChatWithToolsClient & Partial<Pick<LLMClient, 'toUserVisibleContent'>>
  model: string
  memoryService: MemoryService
  logger?: EvaluatorLogger
  onComplete?: (result: { sessionId: string, status: 'processed' | 'failed', meta?: EvictionRunMeta }) => void
}

/**
 * Extract JSON from LLM response that may contain thinking tags,
 * markdown code fences, or other wrapper text.
 */
function extractJson(raw: string): string {
  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (fenceMatch) {
    return fenceMatch[1].trim()
  }

  // Try to find a JSON array directly
  const bracketStart = raw.indexOf('[')
  const bracketEnd = raw.lastIndexOf(']')
  if (bracketStart !== -1 && bracketEnd > bracketStart) {
    return raw.slice(bracketStart, bracketEnd + 1)
  }

  return raw
}

const EVALUATOR_SYSTEM_PROMPT = `You are a conversation memory evaluator. You receive messages that are being evicted from an assistant's conversation context window.

Your job is to extract any findings worth persisting to long-term memory. Return a JSON array of findings, where each finding has:
- "type": one of "preference" (user preferences, style choices, workflow habits), "fact" (important facts, decisions, project context), or "conversation_summary" (brief summary if the conversation had meaningful substance)
- "content": the finding as a concise sentence
- "tags": array of 1-3 relevant keywords

Return an empty array [] if nothing is worth saving. Be selective — only extract genuinely useful information.

Respond ONLY with a valid JSON array, no other text.`

export function createEvictionEvaluator(
  config: EvictionEvaluatorConfig
): (sessionId: string, evicted: ChatMessage[], meta?: EvictionRunMeta) => void {
  const { client, model, memoryService, logger, onComplete } = config

  return (sessionId: string, evicted: ChatMessage[], meta?: EvictionRunMeta) => {
    // Apply batch threshold: skip trivial evictions
    const nonSystemMessages = evicted.filter(m => m.role !== 'system')
      if (nonSystemMessages.length < MIN_EVICT_MESSAGES) {
        const totalTokens = nonSystemMessages.reduce((sum, m) => sum + estimateTokenCount(m.content), 0)
        if (totalTokens < MIN_EVICT_TOKENS) {
          onComplete?.({ sessionId, status: 'processed', meta })
          return
        }
      }

    // Fire-and-forget LLM evaluation
    const evaluate = (async () => {
      const transcript = evicted
        .map(m => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n')
        .slice(0, 8_000)

      logger?.info?.(
        { sessionId, evictedCount: evicted.length, transcriptLength: transcript.length },
        'Eviction evaluator running'
      )

      try {
        const response = await client.chat(
          [
            { role: 'system', content: EVALUATOR_SYSTEM_PROMPT },
            { role: 'user', content: transcript },
          ],
          { model, temperature: 0.2, max_tokens: 500 }
        )

        let raw = response.choices[0]?.message?.content?.trim()
        if (!raw) {
          logger?.info?.({ sessionId }, 'Eviction evaluator: empty response')
          onComplete?.({ sessionId, status: 'processed', meta })
          return
        }

        // Strip provider-specific wrappers (e.g. MiniMax <think> tags)
        if (typeof client.toUserVisibleContent === 'function') {
          raw = client.toUserVisibleContent(raw)
        }

        let findings: EvictionFinding[]
        try {
          findings = JSON.parse(extractJson(raw))
        } catch {
          logger?.warn?.({ sessionId, raw: raw.slice(0, 200) }, 'Eviction evaluator: invalid JSON')
          onComplete?.({ sessionId, status: 'failed', meta })
          return
        }

        if (!Array.isArray(findings) || findings.length === 0) {
          logger?.info?.({ sessionId }, 'Eviction evaluator: no findings')
          onComplete?.({ sessionId, status: 'processed', meta })
          return
        }

        let stored = 0
        for (const finding of findings) {
          if (!finding.content || !finding.type) continue
          try {
            await memoryService.store({
              content: finding.content,
              type: finding.type,
              tags: Array.isArray(finding.tags) ? finding.tags : [],
              source: `eviction:${sessionId}`,
            })
            stored++
          } catch (err) {
            logger?.warn?.(
              { sessionId, error: err instanceof Error ? err.message : String(err) },
              'Eviction evaluator: failed to store finding'
            )
          }
        }

        logger?.info?.(
          { sessionId, findingsCount: findings.length, storedCount: stored },
          'Eviction evaluator completed'
        )
        onComplete?.({ sessionId, status: 'processed', meta })
      } catch (err) {
        logger?.warn?.(
          { sessionId, error: err instanceof Error ? err.message : String(err) },
          'Eviction evaluator: LLM call failed'
        )
        onComplete?.({ sessionId, status: 'failed', meta })
      }
    })()

    // Swallow the promise to prevent unhandled rejection
    void evaluate
  }
}
