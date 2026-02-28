import { MEMORY_TYPES } from './types.ts'
import type {
  Memory,
  MemorySearchResult,
  MemoryType,
} from './types.ts'

function parsePositiveEnvInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (!v) return fallback
  const n = parseInt(v, 10)
  return n > 0 ? n : fallback
}

export const AUTO_CONTEXT_MAX_RESULTS = parsePositiveEnvInt('JARVIS_MEMORY_AUTO_CONTEXT_MAX_RESULTS', 10)
export const AUTO_CONTEXT_MAX_TOKENS = parsePositiveEnvInt('JARVIS_MEMORY_AUTO_CONTEXT_MAX_TOKENS', 1500)
export const AUTO_CONTEXT_RECENT_LIMIT = parsePositiveEnvInt('JARVIS_MEMORY_AUTO_CONTEXT_RECENT_LIMIT', 5)
export const SEARCH_MAX_LIMIT = parsePositiveEnvInt('JARVIS_MEMORY_SEARCH_MAX_LIMIT', 20)
export const SEARCH_DEFAULT_LIMIT = parsePositiveEnvInt('JARVIS_MEMORY_SEARCH_DEFAULT_LIMIT', 5)
export const RECENT_DEFAULT_LIMIT = parsePositiveEnvInt('JARVIS_MEMORY_RECENT_DEFAULT_LIMIT', 10)

const TOKEN_ESTIMATION_CHARS_PER_TOKEN = parsePositiveEnvInt('JARVIS_TOKEN_ESTIMATION_CHARS_PER_TOKEN', 4)

export interface MemoryRow {
  id: number
  content: string
  type: string
  tags: string
  source: string | null
  created_at: string
  token_count: number
  archived_at?: string | null
  archive_reason?: string | null
  rank?: number
}

export function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / TOKEN_ESTIMATION_CHARS_PER_TOKEN))
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
    archivedAt: row.archived_at ?? undefined,
    archiveReason: row.archive_reason ?? undefined,
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

export interface AutoContextItem {
  id: number
  content: string
  type: MemoryType
  tokenCount: number
  createdAt: string
}

export function buildAutoContextBlock(
  ftsResults: AutoContextItem[],
  recentMemories: AutoContextItem[],
  maxTokens: number = AUTO_CONTEXT_MAX_TOKENS,
): string | undefined {
  // Deduplicate: remove from recent any that FTS already returned
  const ftsIds = new Set(ftsResults.map(r => r.id))
  const dedupedRecent = recentMemories.filter(r => !ftsIds.has(r.id))

  // FTS results first (query-relevant), then remaining recent memories
  const combined = [...ftsResults, ...dedupedRecent]

  if (combined.length === 0) {
    return undefined
  }

  const lines: string[] = []
  let tokenBudget = 0

  for (const item of combined) {
    if (tokenBudget + item.tokenCount > maxTokens) {
      break
    }
    tokenBudget += item.tokenCount
    const date = item.createdAt.slice(0, 10)
    lines.push(`- [${summarizeTypeLabel(item.type)}, ${date}] ${item.content}`)
  }

  if (lines.length === 0) {
    return undefined
  }

  return `Relevant context from memory:\n${lines.join('\n')}`
}

