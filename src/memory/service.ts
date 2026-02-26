import { statSync } from 'node:fs'

import type { ChatWithToolsClient } from '../llm/chat-with-tools.ts'
import type { ChatMessage } from '../llm/types.ts'

import { createMemoryDb } from './db.ts'
import { MEMORY_TYPES } from './types.ts'
import {
  estimateTokenCount,
  normalizeContent,
  isMemoryType,
  toMemory,
  toSearchResult,
  clampLimit,
  summarizeTypeLabel,
  buildFtsQuery,
  shouldSummarize,
  AUTO_CONTEXT_MAX_RESULTS,
  AUTO_CONTEXT_MAX_TOKENS,
  SEARCH_DEFAULT_LIMIT,
  RECENT_DEFAULT_LIMIT,
} from './helpers.ts'
import type { MemoryRow } from './helpers.ts'
import type {
  Memory,
  MemorySearchInput,
  MemorySearchResult,
  MemoryStats,
  MemoryStoreInput,
  MemoryStoreResult,
  MemoryType,
} from './types.ts'

type MemoryLogger = {
  info?: (meta: unknown, message?: string) => void
  warn?: (meta: unknown, message?: string) => void
  error?: (meta: unknown, message?: string) => void
}

export interface SummarizeAndStoreInput {
  client: ChatWithToolsClient
  model: string
  messages: ChatMessage[]
  hadToolCalls?: boolean
  source?: string
  force?: boolean
}

export interface MemoryServiceConfig {
  memoryDir?: string
  logger?: MemoryLogger
}

export interface MemoryService {
  readonly dbPath: string
  search(input: MemorySearchInput): Promise<MemorySearchResult[]>
  getRecent(limit?: number, type?: MemoryType): Promise<Memory[]>
  store(input: MemoryStoreInput): Promise<MemoryStoreResult>
  deleteById(id: number): Promise<boolean>
  clear(type?: MemoryType): Promise<number>
  exportAll(): Promise<Memory[]>
  getStats(): Promise<MemoryStats>
  getAutoContext(query: string): Promise<string | undefined>
  summarizeAndStore(input: SummarizeAndStoreInput): Promise<SummarizeOutcome>
  close(): void | Promise<void>
}

export type SummarizeOutcome =
  | 'skipped_trivial'
  | 'empty_summary'
  | 'stored'
  | 'deduplicated'
  | 'failed'

export function createMemoryService(config: MemoryServiceConfig = {}): MemoryService {
  const logger = config.logger
  const handle = createMemoryDb(config.memoryDir)
  const { db, dbPath } = handle

  const insertStmt = db.prepare(`
    INSERT INTO memories (content, type, tags, source, token_count)
    VALUES (?, ?, ?, ?, ?)
  `)
  const selectByIdStmt = db.prepare(`
    SELECT id, content, type, tags, source, created_at, token_count
    FROM memories
    WHERE id = ?
  `)
  const selectAllStmt = db.prepare(`
    SELECT id, content, type, tags, source, created_at, token_count
    FROM memories
    ORDER BY created_at DESC
  `)
  const selectExactStmt = db.prepare(`
    SELECT id, content, type, tags, source, created_at, token_count
    FROM memories
    WHERE lower(trim(content)) = lower(trim(?))
    LIMIT 1
  `)

  function validateType(type: unknown): MemoryType {
    if (!isMemoryType(type)) {
      throw new Error(`Invalid memory type: ${String(type)}`)
    }
    return type
  }

  function validateTags(tags: unknown): string[] {
    if (tags === undefined) {
      return []
    }
    if (!Array.isArray(tags)) {
      throw new Error('tags must be an array of strings')
    }

    const validated = tags.map(tag => {
      if (typeof tag !== 'string') {
        throw new Error('tags must be an array of strings')
      }
      const trimmed = tag.trim()
      if (!trimmed) {
        throw new Error('tags cannot contain empty strings')
      }
      return trimmed
    })

    return validated
  }

  function getRecentSync(limit: number = RECENT_DEFAULT_LIMIT, type?: MemoryType): Memory[] {
    const boundedLimit = clampLimit(limit, RECENT_DEFAULT_LIMIT)

    if (type) {
      const validatedType = validateType(type)
      const rows = db.prepare(`
        SELECT id, content, type, tags, source, created_at, token_count
        FROM memories
        WHERE type = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(validatedType, boundedLimit) as MemoryRow[]
      return rows.map(toMemory)
    }

    const rows = db.prepare(`
      SELECT id, content, type, tags, source, created_at, token_count
      FROM memories
      ORDER BY created_at DESC
      LIMIT ?
    `).all(boundedLimit) as MemoryRow[]
    return rows.map(toMemory)
  }

  function searchSync(input: MemorySearchInput): MemorySearchResult[] {
    const query = input.query.trim()
    const limit = clampLimit(input.limit, SEARCH_DEFAULT_LIMIT)

    if (!query) {
      return getRecentSync(limit, input.type).map(memory => ({ ...memory, rank: 0 }))
    }
    const ftsQuery = buildFtsQuery(query)

    const hasTypeFilter = input.type !== undefined
    const validatedType = hasTypeFilter ? validateType(input.type) : undefined

    const sql = `
      SELECT
        m.id,
        m.content,
        m.type,
        m.tags,
        m.source,
        m.created_at,
        m.token_count,
        bm25(memories_fts) AS rank
      FROM memories_fts
      JOIN memories m ON m.id = memories_fts.rowid
      WHERE memories_fts MATCH ?
      ${hasTypeFilter ? 'AND m.type = ?' : ''}
      ORDER BY rank ASC, m.created_at DESC
      LIMIT ?
    `

    const params = hasTypeFilter
      ? [ftsQuery, validatedType, limit]
      : [ftsQuery, limit]

    const rows = db.prepare(sql).all(...params) as MemoryRow[]
    return rows.map(toSearchResult)
  }

  function storeSync(input: MemoryStoreInput): MemoryStoreResult {
    const content = input.content.trim()
    if (!content) {
      throw new Error('content is required and must be non-empty')
    }

    const type = validateType(input.type)
    const tags = validateTags(input.tags)
    const source = input.source?.trim() || null
    const tokenCount = estimateTokenCount(content)
    const normalizedIncoming = normalizeContent(content)

    const exact = selectExactStmt.get(content) as MemoryRow | undefined
    if (exact) {
      return { memory: toMemory(exact), deduplicated: true }
    }

    const allRows = selectAllStmt.all() as MemoryRow[]
    const nearExact = allRows.find(row => normalizeContent(row.content) === normalizedIncoming)
    if (nearExact) {
      return { memory: toMemory(nearExact), deduplicated: true }
    }

    const insertResult = insertStmt.run(content, type, JSON.stringify(tags), source, tokenCount)
    const inserted = selectByIdStmt.get(insertResult.lastInsertRowid) as MemoryRow | undefined
    if (!inserted) {
      throw new Error('Failed to load inserted memory')
    }

    return { memory: toMemory(inserted), deduplicated: false }
  }

  function clearSync(type?: MemoryType): number {
    if (type) {
      const validatedType = validateType(type)
      const result = db.prepare('DELETE FROM memories WHERE type = ?').run(validatedType)
      return result.changes
    }

    const result = db.prepare('DELETE FROM memories').run()
    return result.changes
  }

  function deleteByIdSync(id: number): boolean {
    const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    return result.changes > 0
  }

  function exportAllSync(): Memory[] {
    const rows = db.prepare(`
      SELECT id, content, type, tags, source, created_at, token_count
      FROM memories
      ORDER BY created_at DESC
    `).all() as MemoryRow[]
    return rows.map(toMemory)
  }

  function getStatsSync(): MemoryStats {
    const counts = db.prepare(`
      SELECT type, COUNT(*) AS count, COALESCE(SUM(token_count), 0) AS token_sum
      FROM memories
      GROUP BY type
    `).all() as Array<{ type: string, count: number, token_sum: number }>

    const byType: Record<MemoryType, number> = {
      preference: 0,
      fact: 0,
      conversation_summary: 0,
    }

    let totalCount = 0
    let totalTokenCount = 0
    for (const row of counts) {
      if (isMemoryType(row.type)) {
        byType[row.type] = row.count
      }
      totalCount += row.count
      totalTokenCount += row.token_sum
    }

    let dbSizeBytes = 0
    try {
      dbSizeBytes = statSync(dbPath).size
    } catch {
      dbSizeBytes = 0
    }

    return {
      dbPath,
      dbSizeBytes,
      totalCount,
      totalTokenCount,
      byType,
    }
  }

  function getAutoContextSync(query: string): string | undefined {
    const results = searchSync({
      query,
      limit: AUTO_CONTEXT_MAX_RESULTS,
    })

    if (results.length === 0) {
      return undefined
    }

    const lines: string[] = []
    let tokenBudget = 0

    for (const result of results) {
      if (tokenBudget + result.tokenCount > AUTO_CONTEXT_MAX_TOKENS) {
        break
      }
      tokenBudget += result.tokenCount
      const date = result.createdAt.slice(0, 10)
      lines.push(`- [${summarizeTypeLabel(result.type)}, ${date}] ${result.content}`)
    }

    if (lines.length === 0) {
      return undefined
    }

    return `Relevant context from memory:\n${lines.join('\n')}`
  }

  async function summarizeAndStoreImpl(input: SummarizeAndStoreInput): Promise<SummarizeOutcome> {
    const hadToolCalls = input.hadToolCalls ?? false
    if (!input.force && !shouldSummarize(input.messages, hadToolCalls)) {
      return 'skipped_trivial'
    }

    const nonSystemMessages = input.messages.filter(m => m.role !== 'system')
    if (nonSystemMessages.length === 0) {
      return 'skipped_trivial'
    }

    const transcript = input.messages
      .map(message => `${message.role.toUpperCase()}: ${message.content}`)
      .join('\n')
      .slice(0, 12_000)

    logger?.info?.(
      { transcriptLength: transcript.length, messageCount: input.messages.length },
      'Auto-memory summarize sending transcript to LLM'
    )

    let summary: string | undefined

    try {
      const summaryResponse = await input.client.chat(
        [
          {
            role: 'system',
            content: [
              'You are a conversation summarizer.',
              'Summarize the following conversation transcript in 2-4 sentences.',
              'Focus on: decisions made, preferences expressed, facts learned, and key topics discussed.',
              'Always produce a summary even if the conversation is short or casual.',
              'Never return an empty response.',
            ].join(' '),
          },
          {
            role: 'user',
            content: transcript,
          },
        ],
        {
          model: input.model,
          temperature: 0.3,
          max_tokens: 220,
        }
      )

      const choice = summaryResponse.choices[0]
      const rawContent = choice?.message?.content
      summary = rawContent?.trim()

      logger?.info?.(
        {
          hasChoices: summaryResponse.choices.length > 0,
          finishReason: choice?.finish_reason,
          rawContentType: typeof rawContent,
          rawContentLength: rawContent?.length ?? 0,
          hasToolCalls: !!(choice?.message as Record<string, unknown>)?.tool_calls,
          summaryEmpty: !summary,
        },
        'Auto-memory LLM summary response details'
      )
    } catch (error) {
      logger?.warn?.(
        { error: error instanceof Error ? error.message : String(error) },
        'LLM summary call failed, falling back to local extract'
      )
    }

    // Local fallback: extract key user/assistant content if LLM returned nothing
    if (!summary) {
      const excerpts = nonSystemMessages
        .map(m => `${m.role}: ${m.content.slice(0, 200)}`)
        .join(' | ')
        .slice(0, 500)
      summary = `Conversation excerpt: ${excerpts}`
      logger?.info?.({}, 'Using local fallback summary (LLM returned empty)')
    }

    const storeResult = storeSync({
      content: summary,
      type: 'conversation_summary',
      source: input.source ?? `chat ${new Date().toISOString()}`,
      tags: [],
    })

    return storeResult.deduplicated ? 'deduplicated' : 'stored'
  }

  return {
    dbPath,
    search: (input) => Promise.resolve(searchSync(input)),
    getRecent: (limit, type) => Promise.resolve(getRecentSync(limit, type)),
    store: (input) => Promise.resolve(storeSync(input)),
    deleteById: (id) => Promise.resolve(deleteByIdSync(id)),
    clear: (type) => Promise.resolve(clearSync(type)),
    exportAll: () => Promise.resolve(exportAllSync()),
    getStats: () => Promise.resolve(getStatsSync()),
    getAutoContext: (query) => Promise.resolve(getAutoContextSync(query)),
    async summarizeAndStore(input: SummarizeAndStoreInput): Promise<SummarizeOutcome> {
      const startedAt = Date.now()
      try {
        const outcome = await summarizeAndStoreImpl(input)
        logger?.info?.(
          {
            source: input.source,
            hadToolCalls: input.hadToolCalls ?? false,
            outcome,
            durationMs: Date.now() - startedAt,
          },
          'Auto-memory summarize completed'
        )
        return outcome
      } catch (error) {
        logger?.warn?.(
          {
            source: input.source,
            hadToolCalls: input.hadToolCalls ?? false,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
          },
          'Failed to summarize and store memory'
        )
        return 'failed'
      }
    },
    close: () => handle.close(),
  }
}
