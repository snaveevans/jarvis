import { parentPort, workerData } from 'node:worker_threads'
import { statSync } from 'node:fs'

import { createMemoryDb } from '../memory/db.ts'
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
} from '../memory/helpers.ts'
import type { MemoryRow } from '../memory/helpers.ts'
import type {
  MemorySearchInput,
  MemoryStoreInput,
  MemoryType,
} from '../memory/types.ts'
import type { WorkerRequest, WorkerResponse } from './types.ts'

if (!parentPort) {
  throw new Error('memory-worker must be run as a worker thread')
}

const { memoryDir, archiveRetentionDays } = workerData as {
  memoryDir?: string
  archiveRetentionDays?: number
}
const retentionDays = Number.isFinite(archiveRetentionDays) && (archiveRetentionDays as number) > 0
  ? Math.floor(archiveRetentionDays as number)
  : 14
const handle = createMemoryDb(memoryDir)
const { db, dbPath } = handle

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

function handleSearch(params: Record<string, unknown>): unknown {
  const input = params as unknown as MemorySearchInput
  const query = input.query.trim()
  const limit = clampLimit(input.limit, SEARCH_DEFAULT_LIMIT)
  const includeArchived = input.includeArchived === true

  if (!query) {
    return (handleGetRecent({
      limit,
      type: input.type,
      includeArchived,
    }) as Array<Record<string, unknown>>).map(
      (memory) => ({ ...memory, rank: 0 })
    )
  }

  const ftsQuery = buildFtsQuery(query)
  const hasTypeFilter = input.type !== undefined
  const validatedType = hasTypeFilter ? validateType(input.type) : undefined

  const sql = `
    SELECT
      m.id, m.content, m.type, m.tags, m.source, m.created_at, m.token_count, m.archived_at, m.archive_reason,
      bm25(memories_fts) AS rank
    FROM memories_fts
    JOIN memories m ON m.id = memories_fts.rowid
    WHERE memories_fts MATCH ?
    ${hasTypeFilter ? 'AND m.type = ?' : ''}
    ${includeArchived ? '' : 'AND m.archived_at IS NULL'}
    ORDER BY rank ASC, m.created_at DESC
    LIMIT ?
  `
  const sqlParams = hasTypeFilter
    ? [ftsQuery, validatedType, limit]
    : [ftsQuery, limit]

  const rows = db.prepare(sql).all(...sqlParams) as MemoryRow[]
  return rows.map(toSearchResult)
}

function handleGetRecent(params: Record<string, unknown>): unknown[] {
  const limit = params.limit as number | undefined
  const type = params.type as MemoryType | undefined
  const includeArchived = params.includeArchived === true
  const boundedLimit = clampLimit(limit, RECENT_DEFAULT_LIMIT)

  if (type) {
    const validatedType = validateType(type)
    const rows = db.prepare(`
      SELECT id, content, type, tags, source, created_at, token_count, archived_at, archive_reason
      FROM memories WHERE type = ?
      ${includeArchived ? '' : 'AND archived_at IS NULL'}
      ORDER BY created_at DESC LIMIT ?
    `).all(validatedType, boundedLimit) as MemoryRow[]
    return rows.map(toMemory)
  }

  const rows = db.prepare(`
    SELECT id, content, type, tags, source, created_at, token_count, archived_at, archive_reason
    FROM memories
    ${includeArchived ? '' : 'WHERE archived_at IS NULL'}
    ORDER BY created_at DESC LIMIT ?
  `).all(boundedLimit) as MemoryRow[]
  return rows.map(toMemory)
}

function handleStore(params: Record<string, unknown>): unknown {
  const input = params as unknown as MemoryStoreInput
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

function handleDeleteById(params: Record<string, unknown>): boolean {
  const id = params.id as number
  const result = db.prepare(`
    UPDATE memories
    SET archived_at = datetime('now')
    WHERE id = ? AND archived_at IS NULL
  `).run(id)
  return result.changes > 0
}

function handleClear(params: Record<string, unknown>): number {
  const type = params.type as MemoryType | undefined
  if (type) {
    const validatedType = validateType(type)
    return db.prepare('DELETE FROM memories WHERE type = ?').run(validatedType).changes
  }
  return db.prepare('DELETE FROM memories').run().changes
}

function handleExportAll(): unknown[] {
  const rows = db.prepare(`
    SELECT id, content, type, tags, source, created_at, token_count, archived_at, archive_reason
    FROM memories ORDER BY created_at DESC
  `).all() as MemoryRow[]
  return rows.map(toMemory)
}

function handleGetStats(): unknown {
  const counts = db.prepare(`
    SELECT type, COUNT(*) AS count, COALESCE(SUM(token_count), 0) AS token_sum
    FROM memories
    WHERE archived_at IS NULL
    GROUP BY type
  `).all() as Array<{ type: string, count: number, token_sum: number }>

  const byType: Record<string, number> = {
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

function handleGetAutoContext(params: Record<string, unknown>): string | undefined {
  const query = params.query as string
  const ftsResults = handleSearch({
    query,
    limit: AUTO_CONTEXT_MAX_RESULTS,
  }) as Array<{ id: number, tokenCount: number, createdAt: string, type: MemoryType, content: string }>

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

const handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
  search: handleSearch,
  getRecent: handleGetRecent,
  store: handleStore,
  deleteById: handleDeleteById,
  clear: handleClear,
  exportAll: handleExportAll,
  getStats: handleGetStats,
  getAutoContext: handleGetAutoContext,
  getDbPath: () => dbPath,
  close: () => {
    handle.close()
    // Schedule worker exit after response is sent
    setTimeout(() => process.exit(0), 50)
    return true
  },
}

function purgeArchived(): void {
  const cutoffIso = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ')
  db.prepare(`
    DELETE FROM memories
    WHERE archived_at IS NOT NULL AND archived_at <= ?
  `).run(cutoffIso)
}

purgeArchived()

parentPort.on('message', (request: WorkerRequest) => {
  const response: WorkerResponse = { requestId: request.requestId }

  try {
    const handler = handlers[request.method]
    if (!handler) {
      response.error = `Unknown method: ${request.method}`
    } else {
      response.result = handler(request.params)
    }
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error)
  }

  parentPort!.postMessage(response)
})
