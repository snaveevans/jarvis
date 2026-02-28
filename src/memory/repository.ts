import { statSync } from 'node:fs'

import type { Database as SqliteDatabase } from 'better-sqlite3'

import {
  estimateTokenCount,
  normalizeContent,
  isMemoryType,
  toMemory,
  toSearchResult,
  clampLimit,
  buildFtsQuery,
  buildAutoContextBlock,
  AUTO_CONTEXT_MAX_RESULTS,
  AUTO_CONTEXT_MAX_TOKENS,
  AUTO_CONTEXT_RECENT_LIMIT,
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

export interface MemoryRepository {
  search(input: MemorySearchInput): MemorySearchResult[]
  getRecent(limit?: number, type?: MemoryType, includeArchived?: boolean): Memory[]
  store(input: MemoryStoreInput): MemoryStoreResult
  updateById(id: number, content: string, tags?: string[]): Memory | null
  deleteById(id: number): boolean
  clear(type?: MemoryType): number
  exportAll(): Memory[]
  getStats(): MemoryStats
  getAutoContext(query: string): string | undefined
  purgeArchived(retentionDays: number): number
}

export function createMemoryRepository(db: SqliteDatabase, dbPath: string): MemoryRepository {
  const insertStmt = db.prepare(`
    INSERT INTO memories (content, type, tags, source, token_count)
    VALUES (?, ?, ?, ?, ?)
  `)
  const selectByIdStmt = db.prepare(`
    SELECT id, content, type, tags, source, created_at, token_count, archived_at, archive_reason
    FROM memories
    WHERE id = ?
  `)
  const selectAllStmt = db.prepare(`
    SELECT id, content, type, tags, source, created_at, token_count, archived_at, archive_reason
    FROM memories
    WHERE archived_at IS NULL
    ORDER BY created_at DESC
  `)
  const selectExactStmt = db.prepare(`
    SELECT id, content, type, tags, source, created_at, token_count, archived_at, archive_reason
    FROM memories
    WHERE lower(trim(content)) = lower(trim(?))
      AND archived_at IS NULL
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
    return tags.map(tag => {
      if (typeof tag !== 'string') {
        throw new Error('tags must be an array of strings')
      }
      const trimmed = tag.trim()
      if (!trimmed) {
        throw new Error('tags cannot contain empty strings')
      }
      return trimmed
    })
  }

  function getRecent(
    limit: number = RECENT_DEFAULT_LIMIT,
    type?: MemoryType,
    includeArchived: boolean = false,
  ): Memory[] {
    const boundedLimit = clampLimit(limit, RECENT_DEFAULT_LIMIT)

    if (type) {
      const validatedType = validateType(type)
      const rows = db.prepare(`
        SELECT id, content, type, tags, source, created_at, token_count, archived_at, archive_reason
        FROM memories
        WHERE type = ?
        ${includeArchived ? '' : 'AND archived_at IS NULL'}
        ORDER BY created_at DESC
        LIMIT ?
      `).all(validatedType, boundedLimit) as MemoryRow[]
      return rows.map(toMemory)
    }

    const rows = db.prepare(`
      SELECT id, content, type, tags, source, created_at, token_count, archived_at, archive_reason
      FROM memories
      ${includeArchived ? '' : 'WHERE archived_at IS NULL'}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(boundedLimit) as MemoryRow[]
    return rows.map(toMemory)
  }

  function search(input: MemorySearchInput): MemorySearchResult[] {
    const query = input.query.trim()
    const limit = clampLimit(input.limit, SEARCH_DEFAULT_LIMIT)
    const includeArchived = input.includeArchived === true

    if (!query) {
      return getRecent(limit, input.type, includeArchived).map(memory => ({ ...memory, rank: 0 }))
    }
    const ftsQuery = buildFtsQuery(query)

    const hasTypeFilter = input.type !== undefined
    const validatedType = hasTypeFilter ? validateType(input.type) : undefined

    const sql = `
      SELECT
        m.id, m.content, m.type, m.tags, m.source, m.created_at, m.token_count,
        m.archived_at, m.archive_reason,
        bm25(memories_fts) AS rank
      FROM memories_fts
      JOIN memories m ON m.id = memories_fts.rowid
      WHERE memories_fts MATCH ?
      ${hasTypeFilter ? 'AND m.type = ?' : ''}
      ${includeArchived ? '' : 'AND m.archived_at IS NULL'}
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

  function updateById(id: number, content: string, tags?: string[]): Memory | null {
    const trimmed = content.trim()
    if (!trimmed) {
      throw new Error('content is required and must be non-empty')
    }

    const existing = selectByIdStmt.get(id) as MemoryRow | undefined
    if (!existing || existing.archived_at) {
      return null
    }

    const tokenCount = estimateTokenCount(trimmed)
    const validatedTags = tags !== undefined ? validateTags(tags) : undefined

    const setClauses = [
      'content = ?',
      'token_count = ?',
      "created_at = datetime('now')",
    ]
    const sqlParams: unknown[] = [trimmed, tokenCount]

    if (validatedTags !== undefined) {
      setClauses.push('tags = ?')
      sqlParams.push(JSON.stringify(validatedTags))
    }

    sqlParams.push(id)

    db.prepare(`
      UPDATE memories
      SET ${setClauses.join(', ')}
      WHERE id = ? AND archived_at IS NULL
    `).run(...sqlParams)

    const updated = selectByIdStmt.get(id) as MemoryRow | undefined
    if (!updated) {
      throw new Error('Failed to load updated memory')
    }

    return toMemory(updated)
  }

  function deleteById(id: number): boolean {
    const result = db.prepare(`
      UPDATE memories
      SET archived_at = datetime('now')
      WHERE id = ? AND archived_at IS NULL
    `).run(id)
    return result.changes > 0
  }

  function clear(type?: MemoryType): number {
    if (type) {
      const validatedType = validateType(type)
      return db.prepare('DELETE FROM memories WHERE type = ?').run(validatedType).changes
    }
    return db.prepare('DELETE FROM memories').run().changes
  }

  function exportAll(): Memory[] {
    const rows = db.prepare(`
      SELECT id, content, type, tags, source, created_at, token_count, archived_at, archive_reason
      FROM memories ORDER BY created_at DESC
    `).all() as MemoryRow[]
    return rows.map(toMemory)
  }

  function getStats(): MemoryStats {
    const counts = db.prepare(`
      SELECT type, COUNT(*) AS count, COALESCE(SUM(token_count), 0) AS token_sum
      FROM memories
      WHERE archived_at IS NULL
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

    return { dbPath, dbSizeBytes, totalCount, totalTokenCount, byType }
  }

  function getAutoContext(query: string): string | undefined {
    const ftsResults = search({
      query,
      limit: AUTO_CONTEXT_MAX_RESULTS,
    })

    const recentRows = db.prepare(`
      SELECT id, content, type, tags, source, created_at, token_count, archived_at, archive_reason
      FROM memories
      WHERE type IN ('preference', 'fact')
        AND archived_at IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(AUTO_CONTEXT_RECENT_LIMIT) as MemoryRow[]
    const recentMemories = recentRows.map(toMemory)

    return buildAutoContextBlock(ftsResults, recentMemories, AUTO_CONTEXT_MAX_TOKENS)
  }

  function purgeArchived(retentionDays: number): number {
    const cutoffIso = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ')
    return db.prepare(`
      DELETE FROM memories
      WHERE archived_at IS NOT NULL AND archived_at <= ?
    `).run(cutoffIso).changes
  }

  return {
    search,
    getRecent,
    store,
    updateById,
    deleteById,
    clear,
    exportAll,
    getStats,
    getAutoContext,
    purgeArchived,
  }
}
