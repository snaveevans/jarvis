import { statSync } from 'node:fs'

import type { ChatWithToolsClient } from '../llm/chat-with-tools.ts'
import type { ChatMessage } from '../llm/types.ts'

import { createMemoryDb } from './db.ts'
import { MEMORY_TYPES } from './types.ts'
import type {
  Memory,
  MemorySearchInput,
  MemorySearchResult,
  MemoryStats,
  MemoryStoreInput,
  MemoryStoreResult,
  MemoryType,
} from './types.ts'

const AUTO_CONTEXT_MAX_RESULTS = 5
const AUTO_CONTEXT_MAX_TOKENS = 500
const SEARCH_MAX_LIMIT = 20
const SEARCH_DEFAULT_LIMIT = 5
const RECENT_DEFAULT_LIMIT = 10
const MIN_SUMMARY_TOKENS = 200

type MemoryLogger = {
  info?: (meta: unknown, message?: string) => void
  warn?: (meta: unknown, message?: string) => void
  error?: (meta: unknown, message?: string) => void
}

interface MemoryRow {
  id: number
  content: string
  type: string
  tags: string
  source: string | null
  created_at: string
  token_count: number
  rank?: number
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
  search(input: MemorySearchInput): MemorySearchResult[]
  getRecent(limit?: number, type?: MemoryType): Memory[]
  store(input: MemoryStoreInput): MemoryStoreResult
  deleteById(id: number): boolean
  clear(type?: MemoryType): number
  exportAll(): Memory[]
  getStats(): MemoryStats
  getAutoContext(query: string): string | undefined
  summarizeAndStore(input: SummarizeAndStoreInput): Promise<SummarizeOutcome>
  close(): void
}

export type SummarizeOutcome =
  | 'skipped_trivial'
  | 'empty_summary'
  | 'stored'
  | 'deduplicated'
  | 'failed'

function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function normalizeContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, ' ')
}

function isMemoryType(value: unknown): value is MemoryType {
  return MEMORY_TYPES.includes(value as MemoryType)
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter((tag): tag is string => typeof tag === 'string')
  } catch {
    return []
  }
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    content: row.content,
    type: row.type as MemoryType,
    tags: parseTags(row.tags),
    source: row.source ?? undefined,
    createdAt: row.created_at,
    tokenCount: row.token_count,
  }
}

function toSearchResult(row: MemoryRow): MemorySearchResult {
  return {
    ...toMemory(row),
    rank: row.rank ?? 0,
  }
}

function clampLimit(limit: number | undefined, defaultValue: number): number {
  if (limit === undefined) {
    return defaultValue
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('limit must be a positive number')
  }
  return Math.min(Math.floor(limit), SEARCH_MAX_LIMIT)
}

function summarizeTypeLabel(type: MemoryType): string {
  if (type === 'conversation_summary') {
    return 'summary'
  }
  return type
}

function buildFtsQuery(query: string): string {
  const terms = query
    .trim()
    .split(/\s+/)
    .map(term => term.trim())
    .filter(Boolean)

  return terms
    .map(term => `"${term.replaceAll('"', '""')}"`)
    .join(' AND ')
}

function shouldSummarize(messages: ChatMessage[], hadToolCalls: boolean): boolean {
  if (hadToolCalls) {
    return true
  }

  const totalTokens = messages
    .filter(message => message.role !== 'system')
    .reduce((sum, message) => sum + estimateTokenCount(message.content), 0)

  return totalTokens >= MIN_SUMMARY_TOKENS
}

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

  function getRecent(limit: number = RECENT_DEFAULT_LIMIT, type?: MemoryType): Memory[] {
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

  function search(input: MemorySearchInput): MemorySearchResult[] {
    const query = input.query.trim()
    const limit = clampLimit(input.limit, SEARCH_DEFAULT_LIMIT)

    if (!query) {
      return getRecent(limit, input.type).map(memory => ({ ...memory, rank: 0 }))
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

  function store(input: MemoryStoreInput): MemoryStoreResult {
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

  function clear(type?: MemoryType): number {
    if (type) {
      const validatedType = validateType(type)
      const result = db.prepare('DELETE FROM memories WHERE type = ?').run(validatedType)
      return result.changes
    }

    const result = db.prepare('DELETE FROM memories').run()
    return result.changes
  }

  function deleteById(id: number): boolean {
    const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    return result.changes > 0
  }

  function exportAll(): Memory[] {
    const rows = db.prepare(`
      SELECT id, content, type, tags, source, created_at, token_count
      FROM memories
      ORDER BY created_at DESC
    `).all() as MemoryRow[]
    return rows.map(toMemory)
  }

  function getStats(): MemoryStats {
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

  function getAutoContext(query: string): string | undefined {
    const results = search({
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

  async function summarizeAndStore(input: SummarizeAndStoreInput): Promise<SummarizeOutcome> {
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

    const storeResult = store({
      content: summary,
      type: 'conversation_summary',
      source: input.source ?? `chat ${new Date().toISOString()}`,
      tags: [],
    })

    return storeResult.deduplicated ? 'deduplicated' : 'stored'
  }

  return {
    dbPath,
    search,
    getRecent,
    store,
    deleteById,
    clear,
    exportAll,
    getStats,
    getAutoContext,
    async summarizeAndStore(input: SummarizeAndStoreInput): Promise<SummarizeOutcome> {
      const startedAt = Date.now()
      try {
        const outcome = await summarizeAndStore(input)
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
