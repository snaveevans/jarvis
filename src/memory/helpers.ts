import { MEMORY_TYPES } from './types.ts'
import type {
  Memory,
  MemorySearchResult,
  MemoryType,
} from './types.ts'

export const AUTO_CONTEXT_MAX_RESULTS = 5
export const AUTO_CONTEXT_MAX_TOKENS = 500
export const SEARCH_MAX_LIMIT = 20
export const SEARCH_DEFAULT_LIMIT = 5
export const RECENT_DEFAULT_LIMIT = 10
export const MIN_SUMMARY_TOKENS = 200

export interface MemoryRow {
  id: number
  content: string
  type: string
  tags: string
  source: string | null
  created_at: string
  token_count: number
  rank?: number
}

export function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

export function normalizeContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function isMemoryType(value: unknown): value is MemoryType {
  return MEMORY_TYPES.includes(value as MemoryType)
}

export function parseTags(raw: string): string[] {
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

export function toMemory(row: MemoryRow): Memory {
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

export function toSearchResult(row: MemoryRow): MemorySearchResult {
  return {
    ...toMemory(row),
    rank: row.rank ?? 0,
  }
}

export function clampLimit(limit: number | undefined, defaultValue: number): number {
  if (limit === undefined) {
    return defaultValue
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('limit must be a positive number')
  }
  return Math.min(Math.floor(limit), SEARCH_MAX_LIMIT)
}

export function summarizeTypeLabel(type: MemoryType): string {
  if (type === 'conversation_summary') {
    return 'summary'
  }
  return type
}

export function buildFtsQuery(query: string): string {
  const terms = query
    .trim()
    .split(/\s+/)
    .map(term => term.trim())
    .filter(Boolean)

  return terms
    .map(term => `"${term.replaceAll('"', '""')}"`)
    .join(' AND ')
}

export function shouldSummarize(messages: Array<{ role: string, content: string }>, hadToolCalls: boolean): boolean {
  if (hadToolCalls) {
    return true
  }

  const totalTokens = messages
    .filter(message => message.role !== 'system')
    .reduce((sum, message) => sum + estimateTokenCount(message.content), 0)

  return totalTokens >= MIN_SUMMARY_TOKENS
}
